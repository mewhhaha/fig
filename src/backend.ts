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

export function emitWat(program: Program): string {
  const optimized = optimizeProgram(program);
  const layouts = createLayoutEnv(optimized);
  const functions = optimized.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && !decl.params.some((param) => param.const) && Boolean(decl.returnType)
  );
  const functionTypes = new Map(functions.map((fn) => [fn.name, fn]));
  const bodies = functions.map((fn) => emitFunction(fn, layouts, functionTypes));
  return `(module
${bodies.join("\n")}
)`;
}

function emitFunction(
  fn: FnDecl,
  layouts: LayoutEnv,
  functions: Map<string, FnDecl>,
): string {
  const lines: string[] = [];
  const exportPart = fn.public ? ` (export "${fn.name}")` : "";
  const params = fn.params.flatMap((param) => flattenBinding(param.name, param.type, layouts));
  const results = flattenType(fn.returnType, layouts).map((slot) => `(result ${slot.wat})`);
  const signature = [
    `(func $${watName(fn.name)}${exportPart}`,
    ...params.map((param) => `(param $${watName(param.name)} ${param.wat})`),
    ...results,
  ].join(" ");
  lines.push(`  ${signature}`);

  const locals = collectLocals(fn.body, layouts, functions);
  const localNames = new Set([
    ...params.map((param) => param.name),
    ...locals.map((local) => local.name),
  ]);
  for (const local of locals) {
    lines.push(`    (local $${watName(local.name)} ${local.wat})`);
  }
  lines.push(...emitBlock(fn.body, 4, layouts, functions, localNames, fn.returnType));
  lines.push("  )");
  return lines.join("\n");
}

function collectLocals(
  block: BlockExpr,
  layouts: LayoutEnv,
  functions: Map<string, FnDecl>,
): FlatSlot[] {
  const locals: FlatSlot[] = [];
  collectBlockLocals(block, locals, layouts, functions);
  return locals;
}

function collectBlockLocals(
  block: BlockExpr,
  locals: FlatSlot[],
  layouts: LayoutEnv,
  functions: Map<string, FnDecl>,
) {
  for (const stmt of block.statements) {
    if (stmt.kind === "let") {
      locals.push(
        ...flattenBinding(stmt.name, stmt.type ?? exprType(stmt.value, functions), layouts),
      );
      collectExprLocals(stmt.value, locals, layouts, functions);
    }
  }
  if (block.expr) collectExprLocals(block.expr, locals, layouts, functions);
}

function collectExprLocals(
  expr: Expr,
  locals: FlatSlot[],
  layouts: LayoutEnv,
  functions: Map<string, FnDecl>,
) {
  switch (expr.kind) {
    case "block":
      collectBlockLocals(expr, locals, layouts, functions);
      return;
    case "call":
      collectExprLocals(expr.callee, locals, layouts, functions);
      for (const arg of expr.args) collectExprLocals(arg, locals, layouts, functions);
      return;
    case "binary":
      collectExprLocals(expr.left, locals, layouts, functions);
      collectExprLocals(expr.right, locals, layouts, functions);
      return;
    case "match":
      collectExprLocals(expr.value, locals, layouts, functions);
      for (const arm of expr.arms) collectExprLocals(arm.value, locals, layouts, functions);
      return;
    case "shape":
      for (const slot of expr.slots) collectExprLocals(slot.value, locals, layouts, functions);
      return;
    case "product_constructor":
      for (const slot of expr.slots) collectExprLocals(slot.value, locals, layouts, functions);
      return;
    case "range":
      collectExprLocals(expr.start, locals, layouts, functions);
      collectExprLocals(expr.end, locals, layouts, functions);
      return;
    case "literal":
    case "var":
      return;
  }
}

function emitBlock(
  block: BlockExpr,
  indent: number,
  layouts: LayoutEnv,
  functions: Map<string, FnDecl>,
  locals: Set<string>,
  expectedType?: string,
): string[] {
  const lines: string[] = [];
  for (const stmt of block.statements) {
    lines.push(...emitStatement(stmt, indent, layouts, functions, locals));
  }
  if (block.expr) {
    lines.push(...emitExpr(block.expr, indent, layouts, functions, locals, expectedType));
  }
  return lines;
}

function emitStatement(
  stmt: Statement,
  indent: number,
  layouts: LayoutEnv,
  functions: Map<string, FnDecl>,
  locals: Set<string>,
): string[] {
  if (stmt.kind === "fork_let") {
    return [
      `${spaces(indent)}local.get $${watName(baseName(stmt.source))}`,
      `${spaces(indent)}local.set $${watName(stmt.left)}`,
      `${spaces(indent)}local.get $${watName(baseName(stmt.source))}`,
      `${spaces(indent)}local.set $${watName(stmt.right)}`,
    ];
  }
  if (stmt.kind === "proof_const") return [];
  const targets = flattenBinding(
    stmt.name,
    stmt.type ?? exprType(stmt.value, functions),
    layouts,
  ).map((slot) => slot.name);
  for (const target of targets) locals.add(target);
  return [
    ...emitExpr(stmt.value, indent, layouts, functions, locals, stmt.type),
    ...targets.toReversed().map((target) => `${spaces(indent)}local.set $${watName(target)}`),
  ];
}

function emitExpr(
  expr: Expr,
  indent: number,
  layouts: LayoutEnv,
  functions: Map<string, FnDecl>,
  locals: Set<string>,
  expectedType?: string,
): string[] {
  switch (expr.kind) {
    case "literal":
      return emitLiteral(expr, indent);
    case "var":
      return emitVar(expr.name, indent, layouts, locals, expectedType);
    case "call":
      if (expr.callee.kind !== "var") throw new Error("WAT backend only supports direct calls");
      const callee = functions.get(expr.callee.name);
      return [
        ...expr.args.flatMap((arg, index) =>
          emitExpr(arg, indent, layouts, functions, locals, callee?.params[index]?.type)
        ),
        `${spaces(indent)}call $${watName(expr.callee.name)}`,
      ];
    case "binary":
      return [
        ...emitExpr(expr.left, indent, layouts, functions, locals),
        ...emitExpr(expr.right, indent, layouts, functions, locals),
        `${spaces(indent)}${binaryOp(expr.op)}`,
      ];
    case "match":
      return emitMatch(expr, indent, layouts, functions, locals);
    case "shape":
      if (expr.slots.length === 0) return [`${spaces(indent)}i32.const 0`];
      return expr.slots.flatMap((slot, index) =>
        emitExpr(
          slot.value,
          indent,
          layouts,
          functions,
          locals,
          shapeSlotTypes(expectedType, layouts)[index],
        )
      );
    case "product_constructor":
      if (expr.slots.length === 0) return [`${spaces(indent)}i32.const 0`];
      return expr.slots.flatMap((slot) => emitExpr(slot.value, indent, layouts, functions, locals));
    case "range":
      throw new Error("WAT backend does not support ranges yet");
    case "block":
      return emitBlock(expr, indent, layouts, functions, locals, expectedType);
  }
}

function emitLiteral(
  expr: Extract<Expr, { kind: "literal" }>,
  indent: number,
): string[] {
  if (expr.literalKind === "bool") {
    return [`${spaces(indent)}i32.const ${expr.value === "true" ? 1 : 0}`];
  }
  if (expr.literalKind === "number") {
    return [`${spaces(indent)}i32.const ${Number.parseInt(expr.value, 10)}`];
  }
  throw new Error(`WAT backend does not support ${expr.literalKind} literals yet`);
}

function emitMatch(
  expr: Extract<Expr, { kind: "match" }>,
  indent: number,
  layouts: LayoutEnv,
  functions: Map<string, FnDecl>,
  locals: Set<string>,
): string[] {
  if (expr.arms.length === 0) return [`${spaces(indent)}i32.const 0`];
  return emitMatchArms(expr.value, expr.arms, indent, layouts, functions, locals);
}

function emitMatchArms(
  value: Expr,
  arms: { pattern: string; value: Expr }[],
  indent: number,
  layouts: LayoutEnv,
  functions: Map<string, FnDecl>,
  locals: Set<string>,
): string[] {
  const [arm, ...rest] = arms;
  if (!arm) return [`${spaces(indent)}i32.const 0`];
  if (arm.pattern === "_" || rest.length === 0) {
    return emitExpr(arm.value, indent, layouts, functions, locals);
  }
  return [
    ...emitExpr(value, indent, layouts, functions, locals),
    ...emitPatternTest(arm.pattern, indent),
    `${spaces(indent)}if (result i32)`,
    ...emitExpr(arm.value, indent + 2, layouts, functions, locals),
    `${spaces(indent)}else`,
    ...emitMatchArms(value, rest, indent + 2, layouts, functions, locals),
    `${spaces(indent)}end`,
  ];
}

function emitPatternTest(pattern: string, indent: number): string[] {
  if (pattern === "true") return [`${spaces(indent)}i32.const 1`, `${spaces(indent)}i32.eq`];
  if (pattern === "false") return [`${spaces(indent)}i32.eqz`];
  const value = Number.parseInt(pattern, 10);
  if (Number.isFinite(value)) {
    return [`${spaces(indent)}i32.const ${value}`, `${spaces(indent)}i32.eq`];
  }
  throw new Error(`WAT backend does not support match pattern ${pattern}`);
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
      throw new Error(`WAT backend does not support operator ${op}`);
  }
}

function watType(type: string | Param | undefined): string {
  const source = typeof type === "string" || type === undefined ? type : type.type;
  if (source === "i64") return "i64";
  if (source === "f32") return "f32";
  if (source === "f64") return "f64";
  return "i32";
}

interface FlatSlot {
  name: string;
  wat: string;
}

interface LayoutSlot {
  suffix: string;
  type: string;
  wat: string;
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

function emitVar(
  name: string,
  indent: number,
  layouts: LayoutEnv,
  locals: Set<string>,
  expectedType?: string,
): string[] {
  const base = baseName(name);
  const projection = projectionSuffix(name);
  if (projection) return [`${spaces(indent)}local.get $${watName(`${base}$${projection}`)}`];
  const slots = flattenType(expectedType, layouts).map((slot) =>
    slot.suffix ? `${base}$${slot.suffix}` : base
  );
  const present = slots.filter((slot) => locals.has(slot));
  if (present.length) return present.map((slot) => `${spaces(indent)}local.get $${watName(slot)}`);
  return [`${spaces(indent)}local.get $${watName(base)}`];
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

export function emitWasm(program: Program): Uint8Array<ArrayBuffer> {
  const optimized = optimizeProgram(program);
  const main = optimized.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  const value = main?.body.expr ? constI32(main.body.expr) : 0;
  const bytes: number[] = [
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01,
    0x05,
    0x01,
    0x60,
    0x00,
    0x01,
    0x7f,
    0x03,
    0x02,
    0x01,
    0x00,
    0x07,
    0x08,
    0x01,
    0x04,
    0x6d,
    0x61,
    0x69,
    0x6e,
    0x00,
    0x00,
    0x0a,
  ];
  const body = [0x00, 0x41, ...sleb(value), 0x0b];
  bytes.push(body.length + 2, 0x01, body.length, ...body);
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

function constI32(expr: Expr): number {
  if (expr.kind === "literal" && expr.literalKind === "number") {
    return Number.parseInt(expr.value, 10);
  }
  if (expr.kind === "binary") {
    const left = constI32(expr.left), right = constI32(expr.right);
    if (expr.op === "+") return left + right;
    if (expr.op === "-") return left - right;
    if (expr.op === "*") return left * right;
    if (expr.op === "/") return Math.trunc(left / right);
  }
  if (expr.kind === "match") {
    const value = constI32(expr.value);
    const arm = expr.arms.find((arm) => arm.pattern === "_" || arm.pattern === String(value));
    return arm ? constI32(arm.value) : 0;
  }
  return 0;
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
