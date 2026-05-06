import type {
  BlockExpr,
  Expr,
  FnDecl,
  Param,
  Program,
  ShapeTypeSlot,
  Statement,
  TypeDecl,
} from "./core_ast.ts";
import { optimizeProgram } from "./optimize.ts";

interface BackendModule {
  imports: BackendImport[];
  functions: BackendFunction[];
}

interface BackendImport {
  name: string;
  params: ValueType[];
  results: ValueType[];
}

interface BackendFunction {
  name: string;
  exportName?: string;
  params: BackendLocal[];
  results: ValueType[];
  locals: BackendLocal[];
  body: Instr[];
}

interface BackendLocal {
  name: string;
  type: ValueType;
}

type ValueType = "i32" | "i64" | "f32" | "f64" | "v128";

type Instr =
  | { op: "const"; type: ValueType; value: number }
  | { op: "local.get"; name: string }
  | { op: "local.set"; name: string }
  | { op: "call"; name: string }
  | { op: "binary"; wasm: string }
  | { op: "simd"; wasm: SimdOp; lane?: number }
  | { op: "drop" }
  | { op: "if"; results: ValueType[]; thenBody: Instr[]; elseBody: Instr[] };

type SimdOp =
  | "i32x4.splat"
  | "i32x4.extract_lane"
  | "i32x4.replace_lane"
  | "i32x4.add"
  | "i32x4.sub"
  | "i32x4.mul"
  | "i32x4.eq"
  | "i32x4.ne"
  | "i32x4.lt_s"
  | "i32x4.le_s"
  | "i32x4.gt_s"
  | "i32x4.ge_s";

interface LowerContext {
  layouts: LayoutEnv;
  functions: Map<string, FnDecl>;
  signatures: Map<string, FnDecl>;
  tempIndex: number;
  tempLocals: BackendLocal[];
}

export function emitWat(program: Program): string {
  return backendModuleToWat(lowerBackendModule(program));
}

export function emitWasm(program: Program): Uint8Array<ArrayBuffer> {
  return backendModuleToWasm(lowerBackendModule(program));
}

function lowerBackendModule(program: Program): BackendModule {
  const optimized = optimizeProgram(program);
  const layouts = createLayoutEnv(optimized);
  const imports = optimized.imports.map((item) => importAsFn(item));
  const runtimeFns = optimized.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && !decl.params.some((param) => param.const) && Boolean(decl.returnType)
  );
  const functions = removeUnreachablePrivateFunctions(runtimeFns);
  const signatures = new Map([...imports, ...functions].map((fn) => [fn.name, fn]));
  const ctx: LowerContext = {
    layouts,
    functions: signatures,
    signatures,
    tempIndex: 0,
    tempLocals: [],
  };

  return {
    imports: imports.map((fn) => ({
      name: fn.name,
      params: fn.params.flatMap((param) =>
        flattenType(param.type, layouts).map((slot) => slot.wat)
      ),
      results: flattenType(fn.returnType, layouts).map((slot) => slot.wat),
    })),
    functions: functions.map((fn) => lowerFunction(fn, ctx)),
  };
}

function lowerFunction(fn: FnDecl, ctx: LowerContext): BackendFunction {
  const params = fn.params.flatMap((param) =>
    flattenBinding(param.name, param.type, ctx.layouts).map((slot) => ({
      name: slot.name,
      type: slot.wat,
    }))
  );
  const localNames = new Set(params.map((param) => param.name));
  const fnCtx: LowerContext = { ...ctx, tempIndex: 0, tempLocals: [] };
  const body = lowerBlock(fn.body, fnCtx, localNames, fn.returnType);
  const locals = [...collectIrLocals(fn.body, fnCtx), ...fnCtx.tempLocals].filter((local) =>
    (!localNames.has(local.name) &&
      usedNames(fn.body).has(local.name.split("$")[0] ?? local.name)) ||
    local.name.startsWith("__simd_tmp")
  );
  return {
    name: fn.name,
    exportName: fn.public ? fn.name : undefined,
    params,
    results: flattenType(fn.returnType, ctx.layouts).map((slot) => slot.wat),
    locals,
    body,
  };
}

function collectIrLocals(block: BlockExpr, ctx: LowerContext): BackendLocal[] {
  const locals: BackendLocal[] = [];
  collectBlockLocals(block, locals, ctx);
  const seen = new Set<string>();
  return locals.filter((local) => {
    if (seen.has(local.name)) return false;
    seen.add(local.name);
    return true;
  });
}

function collectBlockLocals(block: BlockExpr, locals: BackendLocal[], ctx: LowerContext) {
  for (const stmt of block.statements) {
    if (stmt.kind === "let") {
      if (usedNames(block).has(stmt.name) || hasRuntimeEffect(stmt.value, ctx.functions)) {
        locals.push(
          ...flattenBinding(
            stmt.name,
            stmt.type ?? exprType(stmt.value, ctx.functions),
            ctx.layouts,
          )
            .map((slot) => ({ name: slot.name, type: slot.wat })),
        );
      }
      collectExprLocals(stmt.value, locals, ctx);
    } else if (stmt.kind === "fork_let") {
      locals.push({ name: stmt.left, type: "i32" }, { name: stmt.right, type: "i32" });
    }
  }
  if (block.expr) collectExprLocals(block.expr, locals, ctx);
}

function collectExprLocals(expr: Expr, locals: BackendLocal[], ctx: LowerContext) {
  switch (expr.kind) {
    case "block":
      collectBlockLocals(expr, locals, ctx);
      return;
    case "call":
      collectExprLocals(expr.callee, locals, ctx);
      for (const arg of expr.args) collectExprLocals(arg, locals, ctx);
      return;
    case "binary":
      collectExprLocals(expr.left, locals, ctx);
      collectExprLocals(expr.right, locals, ctx);
      return;
    case "match":
      collectExprLocals(expr.value, locals, ctx);
      for (const arm of expr.arms) collectExprLocals(arm.value, locals, ctx);
      return;
    case "shape":
    case "product_constructor":
      for (const slot of expr.slots) collectExprLocals(slot.value, locals, ctx);
      return;
    case "range":
      collectExprLocals(expr.start, locals, ctx);
      collectExprLocals(expr.end, locals, ctx);
      return;
    case "literal":
    case "var":
      return;
  }
}

function lowerBlock(
  block: BlockExpr,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  const body: Instr[] = [];
  for (let index = 0; index < block.statements.length; index++) {
    const stmt = block.statements[index];
    const usedLater = usedNames({
      kind: "block",
      statements: block.statements.slice(index + 1),
      ...(block.expr ? { expr: block.expr } : {}),
    });
    body.push(...lowerStatement(stmt, ctx, locals, usedLater));
  }
  if (block.expr) body.push(...lowerExpr(block.expr, ctx, locals, expectedType));
  return body;
}

function lowerStatement(
  stmt: Statement,
  ctx: LowerContext,
  locals: Set<string>,
  usedLater: Set<string>,
): Instr[] {
  if (stmt.kind === "proof_const") return [];
  if (stmt.kind === "fork_let") {
    return [
      { op: "local.get", name: baseName(stmt.source) },
      { op: "local.set", name: stmt.left },
      { op: "local.get", name: baseName(stmt.source) },
      { op: "local.set", name: stmt.right },
    ];
  }
  if (!usedLater.has(stmt.name) && !hasRuntimeEffect(stmt.value, ctx.functions)) return [];
  const targets = flattenBinding(
    stmt.name,
    stmt.type ?? exprType(stmt.value, ctx.functions),
    ctx.layouts,
  ).map((slot) => slot.name);
  for (const target of targets) locals.add(target);
  const value = lowerExpr(stmt.value, ctx, locals, stmt.type);
  if (!usedLater.has(stmt.name)) {
    return [
      ...value,
      ...flattenType(exprType(stmt.value, ctx.functions), ctx.layouts).map((): Instr => ({
        op: "drop",
      })),
    ];
  }
  return [
    ...value,
    ...targets.toReversed().map((target): Instr => ({ op: "local.set", name: target })),
  ];
}

function lowerExpr(
  expr: Expr,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  const folded = constFold(expr);
  if (folded !== expr) return lowerExpr(folded, ctx, locals, expectedType);
  switch (expr.kind) {
    case "literal":
      return lowerLiteral(expr);
    case "var":
      return lowerVar(expr.name, ctx.layouts, locals, expectedType);
    case "call": {
      if (expr.callee.kind !== "var") throw new Error("backend only supports direct calls");
      const callee = ctx.signatures.get(expr.callee.name);
      if (!callee) {
        if (!hasRuntimeEffect(expr, ctx.functions)) return [{ op: "const", type: "i32", value: 0 }];
        throw new Error(`backend missing runtime callable value: ${expr.callee.name}`);
      }
      const argOffset = Math.max(0, expr.args.length - callee.params.length);
      return [
        ...expr.args.flatMap((arg, index) =>
          index < argOffset
            ? []
            : lowerExpr(arg, ctx, locals, callee.params[index - argOffset]?.type)
        ),
        { op: "call", name: expr.callee.name },
      ];
    }
    case "binary":
      return [
        ...lowerExpr(expr.left, ctx, locals),
        ...lowerExpr(expr.right, ctx, locals),
        { op: "binary", wasm: binaryOp(expr.op) },
      ];
    case "match":
      return lowerMatchArms(expr.value, expr.arms, ctx, locals);
    case "shape":
      if (isLane4I32(expectedType, ctx.layouts)) {
        const vector = lowerLane4I32Shape(expr, ctx, locals);
        if (vector) return extractLane4I32(vector, ctx);
      }
      if (expr.slots.length === 0) return [{ op: "const", type: "i32", value: 0 }];
      return expr.slots.flatMap((slot, index) =>
        lowerExpr(slot.value, ctx, locals, shapeSlotTypes(expectedType, ctx.layouts)[index])
      );
    case "product_constructor":
      if (expr.slots.length === 0) return [{ op: "const", type: "i32", value: 0 }];
      return expr.slots.flatMap((slot) => lowerExpr(slot.value, ctx, locals));
    case "range":
      return [];
    case "block":
      return lowerBlock(expr, ctx, locals, expectedType);
  }
}

function constFold(expr: Expr): Expr {
  if (expr.kind !== "binary") return expr;
  const left = expr.left;
  const right = expr.right;
  if (left.kind !== "literal" || right.kind !== "literal") return expr;
  if (left.literalKind !== "number" || right.literalKind !== "number") {
    return expr;
  }
  const a = Number.parseInt(left.value, 10);
  const b = Number.parseInt(right.value, 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return expr;
  const value = foldBinary(expr.op, a, b);
  if (value === undefined) return expr;
  return {
    kind: "literal",
    literalKind: ["==", "!=", "<", "<=", ">", ">="].includes(expr.op) ? "bool" : "number",
    value: typeof value === "boolean" ? String(value) : String(value),
    inferredType: typeof value === "boolean" ? "bool" : left.inferredType ?? "i32",
  };
}

function foldBinary(op: string, a: number, b: number): number | boolean | undefined {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? undefined : Math.trunc(a / b);
    case "%":
      return b === 0 ? undefined : a % b;
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

function lowerLiteral(expr: Extract<Expr, { kind: "literal" }>): Instr[] {
  if (expr.literalKind === "bool") {
    return [{ op: "const", type: "i32", value: expr.value === "true" ? 1 : 0 }];
  }
  if (expr.literalKind === "number") {
    return [{
      op: "const",
      type: watType(expr.inferredType),
      value: Number.parseInt(expr.value, 10),
    }];
  }
  throw new Error(`backend does not support ${expr.literalKind} literals yet`);
}

function lowerVar(
  name: string,
  layouts: LayoutEnv,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  const base = baseName(name);
  const projection = projectionSuffix(name);
  if (projection) {
    const direct = `${base}$${projection}`;
    if (locals.has(direct)) return [{ op: "local.get", name: direct }];
    const projected = flattenType(expectedType, layouts).map((slot) =>
      slot.suffix ? `${direct}$${slot.suffix}` : direct
    ).filter((slot) => locals.has(slot));
    return (projected.length ? projected : [direct]).map((slot) => ({
      op: "local.get",
      name: slot,
    }));
  }
  const slots = flattenType(expectedType, layouts).map((slot) =>
    slot.suffix ? `${base}$${slot.suffix}` : base
  );
  const present = slots.filter((slot) => locals.has(slot));
  return (present.length ? present : [base]).map((slot) => ({ op: "local.get", name: slot }));
}

function lowerMatchArms(
  value: Expr,
  arms: { pattern: string; value: Expr }[],
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const [arm, ...rest] = arms;
  if (!arm) return [{ op: "const", type: "i32", value: 0 }];
  if (arm.pattern === "_" || rest.length === 0) return lowerExpr(arm.value, ctx, locals);
  return [
    ...lowerExpr(value, ctx, locals),
    ...lowerPatternTest(arm.pattern),
    {
      op: "if",
      results: ["i32"],
      thenBody: lowerExpr(arm.value, ctx, locals),
      elseBody: lowerMatchArms(value, rest, ctx, locals),
    },
  ];
}

function lowerPatternTest(pattern: string): Instr[] {
  if (pattern === "true") {
    return [{ op: "const", type: "i32", value: 1 }, { op: "binary", wasm: "i32.eq" }];
  }
  if (pattern === "false") return [{ op: "binary", wasm: "i32.eqz" }];
  const value = Number.parseInt(pattern, 10);
  if (Number.isFinite(value)) {
    return [{ op: "const", type: "i32", value }, { op: "binary", wasm: "i32.eq" }];
  }
  return [{ op: "drop" }, { op: "const", type: "i32", value: 0 }];
}

function removeUnreachablePrivateFunctions(functions: FnDecl[]): FnDecl[] {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  const reachable = new Set<string>();
  const visit = (name: string) => {
    if (reachable.has(name)) return;
    const fn = byName.get(name);
    if (!fn) return;
    reachable.add(name);
    for (const called of calledFunctions(fn.body)) visit(called);
  };
  for (const fn of functions) if (fn.public) visit(fn.name);
  return functions.filter((fn) => fn.public || reachable.has(fn.name));
}

function calledFunctions(expr: Expr | BlockExpr): Set<string> {
  const calls = new Set<string>();
  const visit = (item: Expr | Statement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "let":
        visit(item.value);
        return;
      case "fork_let":
      case "proof_const":
      case "literal":
      case "var":
        return;
      case "call":
        if (item.callee.kind === "var") calls.add(item.callee.name);
        visit(item.callee);
        for (const arg of item.args) visit(arg);
        return;
      case "binary":
        visit(item.left);
        visit(item.right);
        return;
      case "match":
        visit(item.value);
        for (const arm of item.arms) visit(arm.value);
        return;
      case "shape":
      case "product_constructor":
        for (const slot of item.slots) visit(slot.value);
        return;
      case "range":
        visit(item.start);
        visit(item.end);
        return;
      case "block":
        for (const stmt of item.statements) visit(stmt);
        visit(item.expr);
        return;
    }
  };
  visit(expr);
  return calls;
}

function backendModuleToWat(module: BackendModule): string {
  const imports = module.imports.map((item) => emitImportWat(item));
  const functions = module.functions.map((fn) => emitFunctionWat(fn));
  return `(module\n${[...imports, ...functions].join("\n")}\n)`;
}

function emitImportWat(item: BackendImport): string {
  const signature = [
    `(func $${watName(item.name)} (import "env" "${watName(item.name)}")`,
    ...item.params.map((param) => `(param ${param})`),
    ...item.results.map((result) => `(result ${result})`),
  ].join(" ");
  return `  ${signature})`;
}

function emitFunctionWat(fn: BackendFunction): string {
  const lines: string[] = [];
  const exportPart = fn.exportName ? ` (export "${fn.exportName}")` : "";
  const signature = [
    `(func $${watName(fn.name)}${exportPart}`,
    ...fn.params.map((param) => `(param $${watName(param.name)} ${param.type})`),
    ...fn.results.map((result) => `(result ${result})`),
  ].join(" ");
  lines.push(`  ${signature}`);
  for (const local of fn.locals) {
    lines.push(`    (local $${watName(local.name)} ${local.type})`);
  }
  lines.push(...emitInstrsWat(fn.body, 4));
  lines.push("  )");
  return lines.join("\n");
}

function emitInstrsWat(instrs: Instr[], indent: number): string[] {
  return instrs.flatMap((instr) => emitInstrWat(instr, indent));
}

function emitInstrWat(instr: Instr, indent: number): string[] {
  const prefix = spaces(indent);
  switch (instr.op) {
    case "const":
      return [`${prefix}${instr.type}.const ${instr.value}`];
    case "local.get":
      return [`${prefix}local.get $${watName(instr.name)}`];
    case "local.set":
      return [`${prefix}local.set $${watName(instr.name)}`];
    case "call":
      return [`${prefix}call $${watName(instr.name)}`];
    case "binary":
      return [`${prefix}${instr.wasm}`];
    case "simd":
      return [`${prefix}${instr.wasm}${instr.lane === undefined ? "" : ` ${instr.lane}`}`];
    case "drop":
      return [`${prefix}drop`];
    case "if":
      return [
        `${prefix}if${instr.results.map((result) => ` (result ${result})`).join("")}`,
        ...emitInstrsWat(instr.thenBody, indent + 2),
        `${prefix}else`,
        ...emitInstrsWat(instr.elseBody, indent + 2),
        `${prefix}end`,
      ];
  }
}

function backendModuleToWasm(module: BackendModule): Uint8Array<ArrayBuffer> {
  const allFns = [...module.imports, ...module.functions];
  const types = allFns.map((fn) => ({
    params: fn.params.map((param) =>
      typeof param === "string" ? wasmType(param) : wasmType(param.type)
    ),
    results: fn.results.map(wasmType),
  }));
  const typeKeys = new Map<string, number>();
  const typeList: typeof types = [];
  const typeIndex = types.map((type) => {
    const key = JSON.stringify(type);
    const found = typeKeys.get(key);
    if (found !== undefined) return found;
    typeKeys.set(key, typeList.length);
    typeList.push(type);
    return typeList.length - 1;
  });
  const funcIndex = new Map(allFns.map((fn, index) => [fn.name, index]));
  const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  section(
    bytes,
    1,
    vecItems(typeList.map((type) => [0x60, ...vecRaw(type.params), ...vecRaw(type.results)])),
  );
  if (module.imports.length) {
    section(
      bytes,
      2,
      vecItems(module.imports.map((fn, index) => [
        ...nameBytes("env"),
        ...nameBytes(fn.name),
        0x00,
        ...uleb(typeIndex[index]),
      ])),
    );
  }
  if (module.functions.length) {
    section(
      bytes,
      3,
      vecItems(module.functions.map((_, index) => uleb(typeIndex[index + module.imports.length]))),
    );
  }
  const exports = module.functions.filter((fn) => fn.exportName).map((fn) => [
    ...nameBytes(fn.exportName ?? fn.name),
    0x00,
    ...uleb(funcIndex.get(fn.name) ?? 0),
  ]);
  if (exports.length) section(bytes, 7, vecItems(exports));
  if (module.functions.length) {
    section(
      bytes,
      10,
      vecItems(module.functions.map((fn) => encodeFunction(fn, funcIndex))),
    );
  }
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

function encodeFunction(fn: BackendFunction, funcIndex: Map<string, number>): number[] {
  const localIndex = new Map<string, number>();
  [...fn.params, ...fn.locals].forEach((slot, index) => localIndex.set(slot.name, index));
  const body = [
    ...localDecls(fn.locals),
    ...encodeInstrs(fn.body, localIndex, funcIndex),
    0x0b,
  ];
  return [...uleb(body.length), ...body];
}

function encodeInstrs(
  instrs: Instr[],
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
): number[] {
  return instrs.flatMap((instr) => encodeInstr(instr, locals, funcIndex));
}

function encodeInstr(
  instr: Instr,
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
): number[] {
  switch (instr.op) {
    case "const":
      return instr.type === "i64" ? [0x42, ...sleb(instr.value)] : [0x41, ...sleb(instr.value)];
    case "local.get": {
      const index = locals.get(instr.name);
      return index === undefined ? [0x41, 0] : [0x20, ...uleb(index)];
    }
    case "local.set": {
      const index = locals.get(instr.name);
      return index === undefined ? [0x1a] : [0x21, ...uleb(index)];
    }
    case "call": {
      const index = funcIndex.get(instr.name);
      if (index === undefined) throw new Error(`backend missing lowered callable: ${instr.name}`);
      return [0x10, ...uleb(index)];
    }
    case "binary":
      return [wasmBinaryOp(instr.wasm)];
    case "simd":
      return simdImmediate(instr.wasm, instr.lane);
    case "drop":
      return [0x1a];
    case "if":
      return [
        0x04,
        instr.results.length === 1 ? wasmType(instr.results[0]) : 0x40,
        ...encodeInstrs(instr.thenBody, locals, funcIndex),
        0x05,
        ...encodeInstrs(instr.elseBody, locals, funcIndex),
        0x0b,
      ];
  }
}

function binaryOp(op: string): string {
  switch (op) {
    case "+":
      return "i32.add";
    case "-":
      return "i32.sub";
    case "*":
      return "i32.mul";
    case "/":
      return "i32.div_s";
    case "%":
      return "i32.rem_s";
    case "==":
      return "i32.eq";
    case "!=":
      return "i32.ne";
    case "<":
      return "i32.lt_s";
    case "<=":
      return "i32.le_s";
    case ">":
      return "i32.gt_s";
    case ">=":
      return "i32.ge_s";
    default:
      throw new Error(`backend does not support operator ${op}`);
  }
}

function lowerLane4I32Shape(
  expr: Extract<Expr, { kind: "shape" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.slots.length !== 4) return undefined;
  const slots = expr.slots.map((slot) => slot.value);
  const literal = slots.every((slot) => slot.kind === "literal" && slot.literalKind === "number");
  if (literal) return packLane4I32(slots as Extract<Expr, { kind: "literal" }>[], ctx, locals);

  const pattern = laneMapPattern(slots);
  if (!pattern) return undefined;
  const op = laneBinaryOp(pattern.op);
  if (!op) return undefined;
  return [
    ...packProjectedLane4I32(pattern.base),
    ...lowerExpr(pattern.rhs, ctx, locals, "i32"),
    { op: "simd", wasm: "i32x4.splat" },
    { op: "simd", wasm: op },
  ];
}

function packLane4I32(exprs: Expr[], ctx: LowerContext, locals: Set<string>): Instr[] {
  return [
    ...lowerExpr(exprs[0], ctx, locals, "i32"),
    { op: "simd", wasm: "i32x4.splat" },
    ...[1, 2, 3].flatMap((lane) => [
      ...lowerExpr(exprs[lane], ctx, locals, "i32"),
      { op: "simd", wasm: "i32x4.replace_lane", lane } as Instr,
    ]),
  ];
}

function packProjectedLane4I32(base: string): Instr[] {
  return [
    { op: "local.get", name: `${base}$0` },
    { op: "simd", wasm: "i32x4.splat" },
    ...[1, 2, 3].flatMap((lane) => [
      { op: "local.get", name: `${base}$${lane}` } as Instr,
      { op: "simd", wasm: "i32x4.replace_lane", lane } as Instr,
    ]),
  ];
}

function extractLane4I32(vector: Instr[], ctx: LowerContext): Instr[] {
  const name = `__simd_tmp${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name, type: "v128" });
  return [
    ...vector,
    { op: "local.set", name } as Instr,
    ...[0, 1, 2, 3].flatMap((lane) => [
      { op: "local.get", name } as Instr,
      { op: "simd", wasm: "i32x4.extract_lane", lane } as Instr,
    ]),
  ];
}

function laneMapPattern(exprs: Expr[]): { base: string; op: string; rhs: Expr } | undefined {
  let base: string | undefined;
  let op: string | undefined;
  let rhsKey: string | undefined;
  let rhs: Expr | undefined;
  for (let lane = 0; lane < exprs.length; lane++) {
    const expr = exprs[lane];
    if (expr.kind !== "binary") return undefined;
    if (expr.left.kind !== "var") return undefined;
    const projection = projectionSuffix(expr.left.name);
    if (projection !== String(lane)) return undefined;
    const itemBase = baseName(expr.left.name);
    const itemRhsKey = stableExprKey(expr.right);
    if (base === undefined) base = itemBase;
    if (op === undefined) op = expr.op;
    if (rhsKey === undefined) {
      rhsKey = itemRhsKey;
      rhs = expr.right;
    }
    if (base !== itemBase || op !== expr.op || rhsKey !== itemRhsKey) return undefined;
  }
  return base && op && rhs ? { base, op, rhs } : undefined;
}

function stableExprKey(expr: Expr): string {
  switch (expr.kind) {
    case "literal":
      return `literal:${expr.literalKind}:${expr.value}`;
    case "var":
      return `var:${expr.name}`;
    default:
      return JSON.stringify(expr);
  }
}

function laneBinaryOp(op: string): SimdOp | undefined {
  return ({
    "+": "i32x4.add",
    "-": "i32x4.sub",
    "*": "i32x4.mul",
    "==": "i32x4.eq",
    "!=": "i32x4.ne",
    "<": "i32x4.lt_s",
    "<=": "i32x4.le_s",
    ">": "i32x4.gt_s",
    ">=": "i32x4.ge_s",
  } as Record<string, SimdOp>)[op];
}

function isLane4I32(type: string | undefined, layouts: LayoutEnv): boolean {
  const resolved = resolveAlias(type, layouts);
  if (!resolved?.startsWith("inline_array(")) return false;
  const args = splitTypeArgs(resolved.slice("inline_array(".length, -1));
  return Number.parseInt(args[0] ?? "0", 10) === 4 && (args[1]?.trim() ?? "i32") === "i32";
}

function watType(type: string | Param | undefined): ValueType {
  const source = typeof type === "string" || type === undefined ? type : type.type;
  if (source === "i64") return "i64";
  if (source === "f32") return "f32";
  if (source === "f64") return "f64";
  return "i32";
}

interface FlatSlot {
  name: string;
  wat: ValueType;
}

interface LayoutSlot {
  suffix: string;
  type: string;
  wat: ValueType;
}

interface LayoutEnv {
  types: Map<string, TypeDecl>;
}

function createLayoutEnv(program: Program): LayoutEnv {
  return {
    types: new Map(
      program.declarations.filter((decl): decl is TypeDecl => decl.kind === "type").map((decl) => [
        decl.name,
        decl,
      ]),
    ),
  };
}

function flattenBinding(name: string, type: string | undefined, layouts: LayoutEnv): FlatSlot[] {
  return flattenType(type, layouts).map((slot) => ({
    name: slot.suffix ? `${name}$${slot.suffix}` : name,
    wat: slot.wat,
  }));
}

function flattenType(type: string | undefined, layouts: LayoutEnv): LayoutSlot[] {
  const resolved = resolveAlias(type, layouts);
  if (!resolved) return [{ suffix: "", type: "i32", wat: "i32" }];
  if (isPrimitiveType(resolved)) return [{ suffix: "", type: resolved, wat: watType(resolved) }];
  if (resolved.startsWith("inline_array(")) {
    const args = splitTypeArgs(resolved.slice("inline_array(".length, -1));
    const count = Number.parseInt(args[0] ?? "1", 10);
    const itemType = args[1]?.trim() ?? "i32";
    return repeatSlots(count, itemType, layouts);
  }
  const decl = layouts.types.get(typeName(resolved));
  if (decl?.normalized?.kind === "product") {
    return flattenShape(decl.normalized.shape.slots, layouts);
  }
  return [{ suffix: "", type: resolved, wat: watType(resolved) }];
}

function flattenShape(slots: ShapeTypeSlot[], layouts: LayoutEnv): LayoutSlot[] {
  const flattened: LayoutSlot[] = [];
  slots.forEach((slot, index) => {
    const repeat = slot.repeat ? Number.parseInt(slot.repeat, 10) : 1;
    const prefix = slot.label ?? String(index);
    for (let item = 0; item < repeat; item++) {
      const itemPrefix = repeat === 1 ? prefix : String(flattened.length);
      for (const child of flattenType(slot.type, layouts)) {
        flattened.push({
          ...child,
          suffix: child.suffix ? `${itemPrefix}$${child.suffix}` : itemPrefix,
        });
      }
    }
  });
  return flattened.length ? flattened : [{ suffix: "", type: "i32", wat: "i32" }];
}

function repeatSlots(count: number, itemType: string, layouts: LayoutEnv): LayoutSlot[] {
  const slots: LayoutSlot[] = [];
  for (let index = 0; index < count; index++) {
    for (const child of flattenType(itemType, layouts)) {
      slots.push({
        ...child,
        suffix: child.suffix ? `${index}$${child.suffix}` : String(index),
      });
    }
  }
  return slots;
}

function resolveAlias(type: string | undefined, layouts: LayoutEnv): string | undefined {
  let current = type?.trim();
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const decl = layouts.types.get(current);
    if (decl?.normalized?.kind !== "alias") return current;
    current = decl.normalized.type;
  }
  return current;
}

function projectionSuffix(name: string): string | undefined {
  const suffix = name.slice(baseName(name).length);
  if (!suffix) return undefined;
  return [...suffix.matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[([0-9]+)\]/g)]
    .map((match) => match[1] ?? match[2])
    .join("$");
}

function shapeSlotTypes(type: string | undefined, layouts: LayoutEnv): string[] {
  const resolved = resolveAlias(type, layouts);
  if (!resolved) return [];
  if (resolved.startsWith("inline_array(")) {
    const args = splitTypeArgs(resolved.slice("inline_array(".length, -1));
    return Array.from(
      { length: Number.parseInt(args[0] ?? "0", 10) },
      () => args[1]?.trim() ?? "i32",
    );
  }
  const decl = layouts.types.get(typeName(resolved));
  if (decl?.normalized?.kind !== "product") return [];
  return decl.normalized.shape.slots.flatMap((slot) =>
    Array.from({ length: slot.repeat ? Number.parseInt(slot.repeat, 10) : 1 }, () => slot.type)
  );
}

function exprType(expr: Expr, functions: Map<string, FnDecl>): string | undefined {
  if (expr.kind === "call" && expr.callee.kind === "var") {
    return functions.get(expr.callee.name)?.returnType;
  }
  if (expr.kind === "literal") return expr.inferredType;
  return undefined;
}

function isPrimitiveType(type: string): boolean {
  return ["i32", "u32", "i64", "u64", "f32", "f64", "bool"].includes(type);
}

function typeName(type: string): string {
  return type.match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? type;
}

function splitTypeArgs(source: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(source.slice(start).trim());
  return args;
}

function baseName(name: string): string {
  const dot = name.indexOf(".");
  const bracket = name.indexOf("[");
  const end = Math.min(
    dot >= 0 ? dot : name.length,
    bracket >= 0 ? bracket : name.length,
  );
  return name.slice(0, end);
}

function watName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_.$]/g, "_");
}

function spaces(count: number): string {
  return " ".repeat(count);
}

function importAsFn(item: Program["imports"][number]): FnDecl {
  const match = item.type.match(/^fn\s*\((.*)\)\s*->\s*([^!]+)(?:!.*)?$/);
  const params = splitParams(match?.[1] ?? "").map((part, index) => {
    const pieces = part.split(":");
    return {
      name: pieces.length > 1 ? pieces[0].trim() : `arg${index}`,
      type: (pieces.at(-1) ?? "i32").trim(),
    };
  });
  return {
    kind: "fn",
    public: false,
    name: item.name,
    params,
    returnType: match?.[2].trim() ?? "i32",
    effects: item.effects,
    body: { kind: "block", statements: [] },
  };
}

function splitParams(source: string): string[] {
  if (!source.trim()) return [];
  return splitTypeArgs(source);
}

function usedNames(expr: Expr | BlockExpr): Set<string> {
  const names = new Set<string>();
  const visit = (item: Expr | Statement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "let":
        visit(item.value);
        return;
      case "fork_let":
        names.add(baseName(item.source));
        names.add(item.left);
        names.add(item.right);
        return;
      case "proof_const":
        return;
      case "var":
        names.add(baseName(item.name));
        return;
      case "call":
        visit(item.callee);
        for (const arg of item.args) visit(arg);
        return;
      case "binary":
        visit(item.left);
        visit(item.right);
        return;
      case "match":
        visit(item.value);
        for (const arm of item.arms) visit(arm.value);
        return;
      case "shape":
      case "product_constructor":
        for (const slot of item.slots) visit(slot.value);
        return;
      case "range":
        visit(item.start);
        visit(item.end);
        return;
      case "block":
        for (const stmt of item.statements) visit(stmt);
        visit(item.expr);
        return;
      case "literal":
        return;
    }
  };
  visit(expr);
  return names;
}

function hasRuntimeEffect(expr: Expr, functions: Map<string, FnDecl>): boolean {
  switch (expr.kind) {
    case "call":
      return (expr.callee.kind === "var" &&
        (functions.get(expr.callee.name)?.effects.length ?? 0) > 0) ||
        expr.args.some((arg) => hasRuntimeEffect(arg, functions));
    case "binary":
      return hasRuntimeEffect(expr.left, functions) || hasRuntimeEffect(expr.right, functions);
    case "match":
      return hasRuntimeEffect(expr.value, functions) ||
        expr.arms.some((arm) => hasRuntimeEffect(arm.value, functions));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) => hasRuntimeEffect(slot.value, functions));
    case "range":
      return hasRuntimeEffect(expr.start, functions) || hasRuntimeEffect(expr.end, functions);
    case "block":
      return expr.statements.some((stmt) =>
        stmt.kind === "let" && hasRuntimeEffect(stmt.value, functions)
      ) ||
        (expr.expr ? hasRuntimeEffect(expr.expr, functions) : false);
    default:
      return false;
  }
}

function localDecls(locals: BackendLocal[]): number[] {
  return vecItems(locals.map((local) => [0x01, wasmType(local.type)]));
}

function wasmBinaryOp(op: string): number {
  return ({
    "i32.add": 0x6a,
    "i32.sub": 0x6b,
    "i32.mul": 0x6c,
    "i32.div_s": 0x6d,
    "i32.rem_s": 0x6f,
    "i32.eq": 0x46,
    "i32.ne": 0x47,
    "i32.lt_s": 0x48,
    "i32.le_s": 0x4c,
    "i32.gt_s": 0x4a,
    "i32.ge_s": 0x4e,
    "i32.eqz": 0x45,
  } as Record<string, number>)[op] ?? 0x6a;
}

function simdImmediate(op: SimdOp, lane: number | undefined): number[] {
  const opcode = ({
    "i32x4.splat": 0x11,
    "i32x4.extract_lane": 0x1b,
    "i32x4.replace_lane": 0x1c,
    "i32x4.eq": 0x95,
    "i32x4.ne": 0x96,
    "i32x4.lt_s": 0x97,
    "i32x4.gt_s": 0x99,
    "i32x4.le_s": 0x9b,
    "i32x4.ge_s": 0x9d,
    "i32x4.add": 0xae,
    "i32x4.sub": 0xb1,
    "i32x4.mul": 0xb5,
  } as Record<SimdOp, number>)[op];
  const immediates = op === "i32x4.extract_lane" || op === "i32x4.replace_lane" ? [lane ?? 0] : [];
  return [0xfd, ...uleb(opcode), ...immediates];
}

function wasmType(wat: ValueType): number {
  if (wat === "v128") return 0x7b;
  if (wat === "i64") return 0x7e;
  if (wat === "f32") return 0x7d;
  if (wat === "f64") return 0x7c;
  return 0x7f;
}

function section(bytes: number[], id: number, payload: number[]) {
  bytes.push(id, ...uleb(payload.length), ...payload);
}

function vecItems(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function vecRaw(items: number[]): number[] {
  return [...uleb(items.length), ...items];
}

function nameBytes(name: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(name));
  return [...uleb(bytes.length), ...bytes];
}

function uleb(value: number): number[] {
  const out = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}

function sleb(value: number): number[] {
  const out = [];
  let more = true;
  while (more) {
    let byte = value & 0x7f;
    value >>= 7;
    const signBit = byte & 0x40;
    more = !((value === 0 && signBit === 0) || (value === -1 && signBit !== 0));
    if (more) byte |= 0x80;
    out.push(byte);
  }
  return out;
}
