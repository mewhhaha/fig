import type {
  BlockExpr,
  ConstDecl,
  Expr,
  FnDecl,
  Param,
  ParamPattern,
  Program,
  ShapeTypeSlot,
  Statement,
  TypeDecl,
} from "./core_ast.ts";
import { CompileError } from "./diagnostics.ts";
import { optimizeProgram } from "./optimize.ts";
import {
  intrinsicCallId,
  intrinsicIdsByFunctionName,
  intrinsicWrapperId,
  isIntrinsicWrapper,
} from "./primitives.ts";
import { wgslShaderId } from "./wgsl.ts";

interface BackendModule {
  imports: BackendImport[];
  functions: BackendFunction[];
  memory: boolean;
  data: BackendData[];
}

interface BackendData {
  offset: number;
  bytes: number[];
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
  | { op: "return_call"; name: string }
  | { op: "binary"; wasm: string }
  | { op: "simd"; wasm: SimdOp; lane?: number; lanes?: number[] }
  | { op: "load"; type: ValueType; align: number; offset: number }
  | { op: "store"; type: ValueType; align: number; offset: number }
  | { op: "drop" }
  | { op: "unreachable" }
  | { op: "if"; results: ValueType[]; thenBody: Instr[]; elseBody: Instr[] }
  | { op: "block"; body: Instr[]; results?: ValueType[] }
  | { op: "loop"; body: Instr[]; results?: ValueType[] }
  | { op: "br"; depth: number }
  | { op: "br_if"; depth: number };

type SimdOp =
  | "i8x16.shuffle"
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
  intrinsicIdsByName: Map<string, string>;
  tempIndex: number;
  tempLocals: BackendLocal[];
  currentFn?: FnDecl;
  localTypes?: Map<string, string>;
  tailCallMode?: TailCallMode;
  frozenData?: BackendData[];
  nextDataOffset?: number;
  ownership?: OwnershipIr;
}

interface OwnershipIr {
  forkAliases: Map<string, { source: string; type?: string }>;
}

interface LayoutEnv {
  types: Map<string, TypeDecl>;
  constShapes: Map<string, Extract<Expr, { kind: "shape" }>>;
}

export type TailCallMode = "opcode";

export interface BackendOptions {
  tailCallMode?: TailCallMode;
}

export function emitWat(program: Program, options: BackendOptions = {}): string {
  return backendModuleToWat(lowerBackendModule(program, options));
}

export function emitWasm(
  program: Program,
  options: BackendOptions = {},
): Uint8Array<ArrayBuffer> {
  return backendModuleToWasm(lowerBackendModule(program, options));
}

function lowerBackendModule(program: Program, options: BackendOptions = {}): BackendModule {
  const optimized = optimizeProgram(program);
  const layouts = createLayoutEnv(optimized);
  const imports = optimized.imports.map((item) => importAsFn(item));
  const runtimeFns = optimized.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && !decl.primitiveId && !isIntrinsicWrapper(decl) &&
    !decl.params.some((param) => param.const) &&
    Boolean(decl.returnType)
  );
  const functions = removeUnreachablePrivateFunctions(runtimeFns);
  const allFns = optimized.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && Boolean(decl.returnType)
  );
  const signatures = new Map([...imports, ...functions].map((fn) => [fn.name, fn]));
  const ctx: LowerContext = {
    layouts,
    functions: new Map([...imports, ...allFns].map((fn) => [fn.name, fn])),
    signatures,
    intrinsicIdsByName: intrinsicIdsByFunctionName(optimized.declarations),
    tempIndex: 0,
    tempLocals: [],
    tailCallMode: options.tailCallMode,
    frozenData: [],
    nextDataOffset: 1024,
  };

  const loweredFunctions = functions.map((fn) => lowerFunction(fn, ctx));
  return {
    imports: imports.map((fn) => ({
      name: fn.name,
      params: fn.params.flatMap((param) =>
        flattenType(param.type, layouts).map((slot) => slot.wat)
      ),
      results: flattenType(fn.returnType, layouts).map((slot) => slot.wat),
    })),
    functions: loweredFunctions,
    memory: functions.some((fn) => usesMemoryIntrinsic(fn.body, ctx.functions)) ||
      (ctx.frozenData?.length ?? 0) > 0,
    data: ctx.frozenData ?? [],
  };
}

function lowerFunction(fn: FnDecl, ctx: LowerContext): BackendFunction {
  const params = fn.params.flatMap((param) =>
    flattenBinding(param.name, param.type, ctx.layouts).map((slot) => ({
      name: slot.name,
      type: slot.wat,
    }))
  );
  const paramNames = new Set(params.map((param) => param.name));
  const localNames = new Set(paramNames);
  const fnCtx: LowerContext = {
    ...ctx,
    tempIndex: 0,
    tempLocals: [],
    currentFn: fn,
    localTypes: new Map(fn.params.map((param) => [param.name, param.type])),
    ownership: { forkAliases: new Map() },
  };
  const tailCalls = analyzeTailCalls(fn);
  if (
    ctx.tailCallMode === "opcode" && tailCalls.hasDirectSelfCall &&
    !tailCalls.hasOnlyTailDirectSelfCalls
  ) {
    throw new CompileError([{
      code: "backend.tail_call_ineligible",
      message: `function ${fn.name} is not eligible for tail-call opcode lowering`,
    }]);
  }
  const body = ctx.tailCallMode === "opcode" && tailCalls.hasOnlyTailDirectSelfCalls
    ? lowerTailOpcodeBlock(fn.body, fn, fnCtx, localNames)
    : tailCalls.hasOnlyTailDirectSelfCalls
    ? lowerTailLoopBlock(fn.body, fn, fnCtx, localNames)
    : lowerBlock(fn.body, fnCtx, localNames, fn.returnType);
  const locals = [...collectIrLocals(fn.body, fnCtx), ...fnCtx.tempLocals].filter((local) =>
    (!paramNames.has(local.name) &&
      usedNames(fn.body).has(local.name.split("$")[0] ?? local.name)) ||
    local.name.startsWith("__simd_tmp") ||
    local.name.startsWith("__tail_tmp") ||
    local.name.startsWith("__slot_tmp") ||
    local.name.startsWith("__freeze_tmp")
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
        locals.push(...statementLocalBindings(stmt, ctx));
      }
      collectExprLocals(stmt.value, locals, ctx);
    } else if (stmt.kind === "destructure_let") {
      for (const binding of statementLocalBindings(stmt, ctx)) locals.push(binding);
      collectExprLocals(stmt.value, locals, ctx);
    }
  }
  if (block.expr) collectExprLocals(block.expr, locals, ctx);
}

function collectExprLocals(expr: Expr, locals: BackendLocal[], ctx: LowerContext) {
  switch (expr.kind) {
    case "borrow":
      collectExprLocals(expr.value, locals, ctx);
      return;
    case "block":
      collectBlockLocals(expr, locals, ctx);
      return;
    case "call":
      collectExprLocals(expr.callee, locals, ctx);
      for (const arg of expr.args) collectExprLocals(arg, locals, ctx);
      return;
    case "index":
      collectExprLocals(expr.target, locals, ctx);
      collectExprLocals(expr.index, locals, ctx);
      return;
    case "binary":
      collectExprLocals(expr.left, locals, ctx);
      collectExprLocals(expr.right, locals, ctx);
      return;
    case "pipe_bind":
      for (
        const slot of flattenBinding(expr.name, exprType(expr.value, ctx.functions), ctx.layouts)
      ) {
        locals.push({ name: slot.name, type: slot.wat });
      }
      collectExprLocals(expr.value, locals, ctx);
      collectExprLocals(expr.body, locals, ctx);
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
    case "placeholder":
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
    stmt.sourceType ??= varType(stmt.source, ctx);
    for (const name of stmt.names) {
      if (stmt.sourceType) ctx.localTypes?.set(name, stmt.sourceType);
      ctx.ownership?.forkAliases.set(name, {
        source: resolveForkAliasName(stmt.source, ctx),
        type: stmt.sourceType,
      });
    }
    return [];
  }
  if (stmt.kind === "destructure_let") {
    const bindings = statementLocalBindings(stmt, ctx);
    for (const target of bindings.map((slot) => slot.name)) locals.add(target);
    stmt.names.forEach((name, index) => {
      const type = stmt.slotTypes?.[index];
      if (type) ctx.localTypes?.set(name, type);
    });
    return [
      ...lowerExpr(stmt.value, ctx, locals),
      ...bindings.map((binding) => binding.name).toReversed().map((name): Instr => ({
        op: "local.set",
        name,
      })),
    ];
  }
  stmt.type ??= exprTypeWithLocals(stmt.value, ctx);
  if (!usedLater.has(stmt.name) && !hasRuntimeEffect(stmt.value, ctx.functions)) return [];
  const bindings = statementLocalBindings(stmt, ctx);
  const targets = bindings.map((slot) => slot.name);
  for (const target of targets) locals.add(target);
  if (stmt.type) ctx.localTypes?.set(stmt.name, stmt.type);
  const value = lowerExpr(stmt.value, ctx, locals, stmt.type);
  if (!usedLater.has(stmt.name)) {
    return [
      ...value,
      ...flattenType(exprTypeWithLocals(stmt.value, ctx), ctx.layouts).map((): Instr => ({
        op: "drop",
      })),
    ];
  }
  return [
    ...value,
    ...targets.toReversed().map((target): Instr => ({ op: "local.set", name: target })),
  ];
}

function lowerTailOpcodeBlock(
  block: BlockExpr,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  return [
    ...lowerBlock({ kind: "block", statements: block.statements }, ctx, locals, fn.returnType),
    ...(block.expr ? lowerTailOpcodeExpr(block.expr, fn, ctx, locals) : []),
  ];
}

function lowerTailOpcodeExpr(
  expr: Expr,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === fn.name) {
    const callee = ctx.signatures.get(expr.callee.name);
    const argOffset = Math.max(0, expr.args.length - (callee?.params.length ?? expr.args.length));
    return [
      ...expr.args.flatMap((arg, index) =>
        index < argOffset
          ? []
          : lowerExpr(arg, ctx, locals, callee?.params[index - argOffset]?.type)
      ),
      { op: "return_call", name: expr.callee.name },
    ];
  }
  if (expr.kind === "match") {
    return lowerTailOpcodeMatch(expr, fn, ctx, locals);
  }
  return lowerExpr(expr, ctx, locals, fn.returnType);
}

function lowerTailOpcodeMatch(
  expr: Extract<Expr, { kind: "match" }>,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const [arm, ...rest] = expr.arms;
  if (!arm) return [{ op: "const", type: "i32", value: 0 }];
  if (arm.pattern.kind === "wildcard" || rest.length === 0) {
    return lowerTailOpcodeExpr(arm.value, fn, ctx, locals);
  }
  return [
    ...lowerExpr(expr.value, ctx, locals),
    ...lowerPatternTest(arm.pattern),
    {
      op: "if",
      results: flattenType(fn.returnType, ctx.layouts).map((slot) => slot.wat),
      thenBody: lowerTailOpcodeExpr(arm.value, fn, ctx, locals),
      elseBody: lowerTailOpcodeMatch({ ...expr, arms: rest }, fn, ctx, locals),
    },
  ];
}

function lowerTailLoopBlock(
  block: BlockExpr,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  return [{
    op: "block",
    results: flattenType(fn.returnType, ctx.layouts).map((slot) => slot.wat),
    body: [{
      op: "loop",
      body: [
        ...lowerBlock({ kind: "block", statements: block.statements }, ctx, locals, fn.returnType),
        ...(block.expr ? lowerTailLoopExpr(block.expr, fn, ctx, locals, 0, 1) : []),
      ],
    }, { op: "unreachable" }],
  }];
}

function lowerTailLoopExpr(
  expr: Expr,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] {
  if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === fn.name) {
    const callee = ctx.signatures.get(expr.callee.name);
    const argOffset = Math.max(0, expr.args.length - (callee?.params.length ?? expr.args.length));
    const runtimeArgs = expr.args.slice(argOffset);
    const flatParams = fn.params.flatMap((param) =>
      flattenBinding(param.name, param.type, ctx.layouts)
    );
    const temps = flatParams.map((param) => {
      const name = `__tail_tmp${ctx.tempIndex++}`;
      ctx.tempLocals.push({ name, type: param.wat });
      locals.add(name);
      return name;
    });
    return [
      ...runtimeArgs.flatMap((arg, index) =>
        lowerExpr(arg, ctx, locals, callee?.params[index]?.type)
      ),
      ...temps.toReversed().map((name): Instr => ({ op: "local.set", name })),
      ...flatParams.map((param, index): Instr[] => [
        { op: "local.get", name: temps[index] },
        { op: "local.set", name: param.name },
      ]).flat(),
      { op: "br", depth: continueDepth },
    ];
  }
  if (expr.kind === "match") {
    return lowerTailLoopMatch(expr, fn, ctx, locals, continueDepth, exitDepth);
  }
  return [...lowerExpr(expr, ctx, locals, fn.returnType), { op: "br", depth: exitDepth }];
}

function lowerTailLoopMatch(
  expr: Extract<Expr, { kind: "match" }>,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] {
  const step = lowerTailStepMatch(expr.value, expr.arms, fn, ctx, locals, continueDepth, exitDepth);
  if (step) return step;
  const [arm, ...rest] = expr.arms;
  if (!arm) return [{ op: "br", depth: exitDepth }];
  if (arm.pattern.kind === "wildcard" || rest.length === 0) {
    return lowerTailLoopExpr(arm.value, fn, ctx, locals, continueDepth, exitDepth);
  }
  return [
    ...lowerExpr(expr.value, ctx, locals),
    ...lowerPatternTest(arm.pattern),
    {
      op: "if",
      results: [],
      thenBody: lowerTailLoopExpr(arm.value, fn, ctx, locals, continueDepth + 1, exitDepth + 1),
      elseBody: lowerTailLoopMatch(
        { ...expr, arms: rest },
        fn,
        ctx,
        locals,
        continueDepth + 1,
        exitDepth + 1,
      ),
    },
  ];
}

function lowerTailStepMatch(
  value: Expr,
  arms: { pattern: ParamPattern; value: Expr }[],
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] | undefined {
  if (value.kind !== "call" || value.callee.kind !== "var") return undefined;
  const id = compilerCallId(value.callee.name, ctx.intrinsicIdsByName);
  if (id !== "index_cursor_next" && !isIndexCursorNextCallee(value.callee.name)) return undefined;
  const n = value.args.length >= 2
    ? value.args[value.args.length - 2]
    : constSpecializedCursorBound(value.callee.name);
  const cursor = value.args[value.args.length - 1];
  if (!n || !cursor) return undefined;
  const yieldArm = arms.find((arm) =>
    arm.pattern.kind === "constructor" && arm.pattern.name === "Yield"
  );
  const doneArm = arms.find((arm) =>
    (arm.pattern.kind === "constructor" || arm.pattern.kind === "binding") &&
    arm.pattern.name === "Done"
  );
  if (!yieldArm || !doneArm || yieldArm.pattern.kind !== "constructor") return undefined;
  const itemName = yieldArm.pattern.args[0]?.kind === "binding"
    ? yieldArm.pattern.args[0].name
    : "__iter_item";
  const nextName = yieldArm.pattern.args[1]?.kind === "binding"
    ? yieldArm.pattern.args[1].name
    : "__iter_next";
  const scoped = new Set(locals);
  scoped.add(itemName);
  scoped.add(nextName);
  ctx.tempLocals.push({ name: itemName, type: "i32" }, { name: nextName, type: "i32" });
  return [
    ...lowerExpr(cursor, ctx, locals, "i32"),
    ...lowerExpr(n, ctx, locals, "i32"),
    { op: "binary", wasm: "i32.lt_s" },
    {
      op: "if",
      results: [],
      thenBody: [
        ...lowerExpr(cursor, ctx, locals, "i32"),
        { op: "local.set", name: itemName },
        ...lowerExpr(cursor, ctx, locals, "i32"),
        { op: "const", type: "i32", value: 1 },
        { op: "binary", wasm: "i32.add" },
        { op: "local.set", name: nextName },
        ...lowerTailLoopExpr(yieldArm.value, fn, ctx, scoped, continueDepth + 1, exitDepth + 1),
      ],
      elseBody: lowerTailLoopExpr(doneArm.value, fn, ctx, locals, continueDepth + 1, exitDepth + 1),
    },
  ];
}

function isIndexCursorNextCallee(name: string): boolean {
  return name.endsWith("IndexCursor.next") || name.includes("index_cursor_next__") ||
    name.includes("IndexCursor_next__");
}

function constSpecializedCursorBound(name: string): Expr | undefined {
  const match = name.match(/(?:index_cursor_next|IndexCursor_next)__([0-9]+)/);
  return match ? { kind: "literal", literalKind: "number", value: match[1] } : undefined;
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
      return lowerLiteral(expr, expectedType);
    case "var":
      {
        const frozenProjection = lowerFrozenVarIndex(expr.name, ctx, locals);
        if (frozenProjection) return frozenProjection;
      }
      return lowerVar(expr.name, ctx, locals, expectedType);
    case "borrow":
      return lowerExpr(expr.value, ctx, locals, stripBorrowType(expectedType));
    case "placeholder":
      throw new Error("backend cannot lower unresolved $ placeholder");
    case "call": {
      if (expr.callee.kind !== "var") {
        if (expr.args.length === 0) return lowerExpr(expr.callee, ctx, locals, expectedType);
        throw new Error("backend only supports direct calls");
      }
      const freeze = lowerFreezePrimitive(expr, ctx, locals);
      if (freeze) return freeze;
      const memory = lowerMemoryIntrinsic(expr, ctx, locals);
      if (memory) return memory;
      const pointer = lowerPointerPrimitive(expr, ctx, locals);
      if (pointer) return pointer;
      const builder = lowerInlineArrayBuilderPrimitive(expr, ctx, locals, expectedType);
      if (builder) return builder;
      const componentSlotPut = lowerComponentSlotPut(expr, ctx, locals);
      if (componentSlotPut) return componentSlotPut;
      const componentStoreGet = lowerComponentStoreGet(expr, ctx, locals, expectedType);
      if (componentStoreGet) return componentStoreGet;
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
    case "index":
      return lowerIndex(expr, ctx, locals, expectedType);
    case "binary":
      {
        const dot = lowerDot4I32(expr, ctx, locals);
        if (dot) return dot;
      }
      return [
        ...lowerExpr(expr.left, ctx, locals),
        ...lowerExpr(expr.right, ctx, locals),
        { op: "binary", wasm: binaryOp(expr.op) },
      ];
    case "pipe_bind":
      return lowerPipeBind(expr, ctx, locals, expectedType);
    case "match":
      {
        const step = lowerStepMatch(expr.value, expr.arms, ctx, locals, expectedType);
        if (step) return step;
      }
      return lowerMatchArms(expr.value, expr.arms, ctx, locals, expectedType);
    case "shape":
      if (expr.syntax === "frozen_collection") {
        return lowerFrozenCollectionLiteral(expr, expectedType, ctx, locals);
      }
      if (isLane4I32(expectedType, ctx.layouts)) {
        const vector = lowerLane4I32Shape(expr, ctx, locals);
        if (vector) return extractLane4I32(vector, ctx);
      }
      if (expr.slots.length === 0) return [{ op: "const", type: "i32", value: 0 }];
      return lowerShapeStorage(expr.slots, expectedType, ctx, locals);
    case "product_constructor":
      if (expr.slots.length === 0) return [{ op: "const", type: "i32", value: 0 }];
      return lowerShapeStorage(
        expr.slots,
        expectedType ?? productConstructorType(expr.constructor, ctx.layouts),
        ctx,
        locals,
      );
    case "range":
      return [
        ...lowerExpr(expr.start, ctx, locals),
        ...lowerExpr(expr.end, ctx, locals),
      ];
    case "static_for_slots":
      return [];
    case "field":
      if (expr.value.kind === "var" && expr.key.kind === "literal") {
        const key = expr.key.value.replace(/^#/, "").replace(/^"|"$/g, "");
        return lowerVar(`${expr.value.name}.${key}`, ctx, locals, expectedType);
      }
      throw new Error("backend cannot lower unresolved @field");
    case "block":
      return lowerBlock(expr, ctx, locals, expectedType);
  }
}

function lowerComponentSlotPut(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.callee.kind !== "var" || !expr.callee.name.includes("component_slot_put_typed")) {
    return undefined;
  }
  const [slot, index, present, value] = expr.args;
  if (expr.args.length !== 4 || slot?.kind !== "var" || !index || !present || !value) {
    return undefined;
  }
  const localBase = resolveForkAliasName(slot.name, ctx).replaceAll(".", "$");
  const valueSlots = (item: number) => {
    const direct = `${localBase}$values$${item}`;
    if (locals.has(direct)) return [direct];
    return [...locals].filter((name) => name.startsWith(`${direct}$`));
  };
  const itemWidth = valueSlots(0).length;
  if (!itemWidth) return undefined;
  const fullValue = lowerExpr(value, ctx, locals);
  if (fullValue.length !== itemWidth) return undefined;
  const select = (item: number, thenBody: Instr[], elseBody: Instr[]): Instr[] => [
    ...lowerExpr(index, ctx, locals, "i32"),
    { op: "const", type: "i32", value: item },
    { op: "binary", wasm: "i32.eq" },
    { op: "if", results: ["i32"], thenBody, elseBody },
  ];
  return [
    ...[0, 1, 2].flatMap((item) =>
      select(item, lowerExpr(present, ctx, locals, "bool"), [
        { op: "local.get", name: `${localBase}$present$${item}` },
      ])
    ),
    ...[0, 1, 2].flatMap((item) =>
      valueSlots(item).flatMap((oldSlot, slotIndex) =>
        select(item, [fullValue[slotIndex]!], [{ op: "local.get", name: oldSlot }])
      )
    ),
  ];
}

function lowerComponentStoreGet(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (expr.callee.kind !== "var" || !expr.callee.name.includes("component_store_get_typed")) {
    return undefined;
  }
  if (expr.args.length !== 2 || expr.args[0]?.kind !== "var") return undefined;
  const storeType = varType(expr.args[0].name, ctx);
  const itemType = expectedType && !unresolvedTypeParam(expectedType)
    ? expectedType
    : inlineArrayLikeTypeArgs(storeType, ctx.layouts)?.[1] ??
      sparseWorldComponentStoreItemType(expr.args[0].name, ctx);
  if (!itemType || unresolvedTypeParam(itemType)) {
    return lowerRuntimeInlineArrayIndexFromLocalSlots(
      expr.args[0].name,
      expr.args[1]!,
      3,
      ctx,
      locals,
    );
  }
  return lowerRuntimeInlineArrayIndex(
    expr.args[0].name,
    expr.args[1]!,
    3,
    itemType,
    ctx,
    locals,
  );
}

function lowerRuntimeInlineArrayIndexFromLocalSlots(
  target: string,
  index: Expr,
  capacity: number,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const localBase = resolveForkAliasName(target, ctx).replaceAll(".", "$");
  const itemSlots = (item: number) => {
    const direct = `${localBase}$${item}`;
    if (locals.has(direct)) return [direct];
    return [...locals].filter((slot) => slot.startsWith(`${direct}$`));
  };
  const fallbackSlots = itemSlots(Math.max(0, capacity - 1));
  if (!fallbackSlots.length) return undefined;
  const results = fallbackSlots.map(() => "i32" as const);
  let body: Instr[] = fallbackSlots.map((name) => ({ op: "local.get", name }));
  for (let item = capacity - 2; item >= 0; item--) {
    const slots = itemSlots(item);
    if (slots.length !== fallbackSlots.length) return undefined;
    body = [
      ...lowerExpr(index, ctx, locals, "i32"),
      { op: "const", type: "i32", value: item },
      { op: "binary", wasm: "i32.eq" },
      {
        op: "if",
        results,
        thenBody: slots.map((name) => ({ op: "local.get", name })),
        elseBody: body,
      },
    ];
  }
  return body;
}

function sparseWorldComponentStoreItemType(target: string, ctx: LowerContext): string | undefined {
  target = resolveForkAliasName(target, ctx);
  const parts = target.split(".");
  if (parts.length < 3 || parts[2] !== "values") return undefined;
  const worldType = resolveAlias(ctx.localTypes?.get(baseName(parts[0] ?? "")), ctx.layouts);
  const unqualified = worldType?.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
  const sparseArgs = unqualified ? typeCallArgs(unqualified, "SparseWorld") : undefined;
  if (!sparseArgs) return undefined;
  const [, componentsName] = splitTypeArgs(sparseArgs);
  const components = componentsName ? ctx.layouts.constShapes.get(componentsName.trim()) : undefined;
  const component = components?.slots.find((slot) => slot.label === parts[1])?.value;
  return component?.kind === "var" ? component.name : undefined;
}

function lowerInlineArrayBuilderPrimitive(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const id = compilerCallId(expr.callee.name, ctx.intrinsicIdsByName);
  if (
    id !== "inline_array_builder_start" &&
    id !== "inline_array_builder_push" &&
    id !== "inline_array_builder_finish"
  ) return undefined;

  const arrayArgs = inlineArrayLikeTypeArgs(expectedType, ctx.layouts);
  if (!arrayArgs) return undefined;
  const [capacity, itemType] = arrayArgs;

  if (id === "inline_array_builder_start") {
    return flattenType(expectedType, ctx.layouts).map((slot) => ({
      op: "const",
      type: slot.wat,
      value: 0,
    }));
  }

  if (id === "inline_array_builder_finish") {
    const builder = expr.args.at(-1);
    return builder ? lowerExpr(builder, ctx, locals, expectedType) : [];
  }

  const runtimeArgs = expr.args.slice(-3);
  const builder = runtimeArgs[0];
  const index = runtimeArgs[1];
  const value = runtimeArgs[2];
  if (!builder || !index || !value) return undefined;

  const itemSlots = flattenType(itemType, ctx.layouts);
  return Array.from({ length: capacity }, (_, item) =>
    itemSlots.map((slot, slotIndex): Instr[] => {
      const valueBody = lowerFlattenedValueSlot(value, itemType, slotIndex, ctx, locals);
      const builderBody = lowerBuilderItemSlot(builder, expectedType, item, slotIndex, ctx, locals);
      return [
        ...lowerExpr(index, ctx, locals, "i32"),
        { op: "const", type: "i32", value: item },
        { op: "binary", wasm: "i32.eq" },
        {
          op: "if",
          results: [slot.wat],
          thenBody: valueBody,
          elseBody: builderBody,
        },
      ];
    }).flat()).flat();
}

function lowerFlattenedValueSlot(
  expr: Expr,
  type: string | undefined,
  slotIndex: number,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const flattened = flattenType(type, ctx.layouts);
  const full = lowerExpr(expr, ctx, locals, type);
  if (flattened.length === 1) return full;
  return lowerFlattenedSlotViaTemps(full, flattened, slotIndex, ctx, locals);
}

function lowerBuilderItemSlot(
  builder: Expr,
  builderType: string | undefined,
  item: number,
  slotIndex: number,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const full = lowerExpr(builder, ctx, locals, builderType);
  const itemType = inlineArrayLikeTypeArgs(builderType, ctx.layouts)?.[1];
  const itemSlots = flattenType(itemType, ctx.layouts);
  if (full.length === itemSlots.length) return full.slice(slotIndex, slotIndex + 1);
  const flattened = flattenType(builderType, ctx.layouts);
  return lowerFlattenedSlotViaTemps(
    full,
    flattened,
    item * itemSlots.length + slotIndex,
    ctx,
    locals,
  );
}

function lowerFlattenedSlotViaTemps(
  body: Instr[],
  slots: LayoutSlot[],
  slotIndex: number,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const temps = slots.map((slot) => {
    const name = `__slot_tmp${ctx.tempIndex++}`;
    ctx.tempLocals.push({ name, type: slot.wat });
    locals.add(name);
    return name;
  });
  return [
    ...body,
    ...temps.toReversed().map((name): Instr => ({ op: "local.set", name })),
    { op: "local.get", name: temps[slotIndex] ?? temps[0] ?? "__slot_tmp_missing" },
  ];
}

function lowerPointerPrimitive(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const id = compilerCallId(expr.callee.name, ctx.intrinsicIdsByName);
  if (id === "ptr_from_i32") {
    return lowerExpr(
      expr.args[0] ?? { kind: "literal", literalKind: "number", value: "0" },
      ctx,
      locals,
      "i32",
    );
  }
  if (id === "ptr_add") {
    return [
      ...lowerExpr(
        expr.args[0] ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
        "i32",
      ),
      ...lowerExpr(
        expr.args[1] ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
        "i32",
      ),
      { op: "binary", wasm: "i32.add" },
    ];
  }
  return undefined;
}

function lowerFreezePrimitive(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const id = compilerCallId(expr.callee.name, ctx.intrinsicIdsByName);
  if (id !== "freeze") return undefined;
  const runtimeArgs = expr.args.slice(-2);
  const arena = runtimeArgs[0] ?? { kind: "literal", literalKind: "number", value: "0" } as Expr;
  const value = runtimeArgs[1];
  const valueType = value ? exprTypeWithLocals(value, ctx) : "i32";
  const slots = flattenType(valueType, ctx.layouts);
  const arenaTmp = `__freeze_tmp${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: arenaTmp, type: "i32" });
  locals.add(arenaTmp);

  let offset = 0;
  const stores = value
    ? slots.flatMap((slot, slotIndex): Instr[] => {
      const size = slotByteSize(slot);
      const body: Instr[] = [
        { op: "local.get", name: arenaTmp },
        ...(offset === 0 ? [] : [
          { op: "const", type: "i32", value: offset } as Instr,
          { op: "binary", wasm: "i32.add" } as Instr,
        ]),
        ...lowerFlattenedValueSlot(value, valueType, slotIndex, ctx, locals),
        { op: "store", type: slot.wat, align: size, offset: 0 },
      ];
      offset += size;
      return body;
    })
    : [];
  return [
    ...lowerExpr(arena, ctx, locals, "frozen_arena"),
    { op: "local.set", name: arenaTmp },
    ...stores,
    { op: "local.get", name: arenaTmp },
    { op: "const", type: "i32", value: Math.max(offset, 4) },
    { op: "binary", wasm: "i32.add" },
    { op: "local.get", name: arenaTmp },
  ];
}

function lowerPipeBind(
  expr: Extract<Expr, { kind: "pipe_bind" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  const bindings = flattenBinding(expr.name, exprType(expr.value, ctx.functions), ctx.layouts);
  for (const binding of bindings) locals.add(binding.name);
  return [
    ...lowerExpr(expr.value, ctx, locals),
    ...bindings.map((binding) => binding.name).toReversed().map((name): Instr => ({
      op: "local.set",
      name,
    })),
    ...lowerExpr(expr.body, ctx, locals, expectedType),
  ];
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

function lowerLiteral(expr: Extract<Expr, { kind: "literal" }>, expectedType?: string): Instr[] {
  if (literalTypeMembers(expr.inferredType) || literalTypeMembers(expectedType)) {
    return [{ op: "const", type: "i32", value: literalExprRuntimeValue(expr) ?? 0 }];
  }
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
  if (expr.literalKind === "char") {
    return [{ op: "const", type: "i32", value: literalExprRuntimeValue(expr) ?? 0 }];
  }
  throw new Error(`backend does not support ${expr.literalKind} literals yet`);
}

function lowerIndex(
  expr: Extract<Expr, { kind: "index" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  const targetType = expr.target.kind === "var"
    ? varType(expr.target.name, ctx)
    : exprTypeWithLocals(expr.target, ctx);
  if (isFrozenType(targetType)) {
    return lowerFrozenIndex(expr, stripFrozenType(targetType), ctx, locals);
  }
  if (expr.target.kind === "var" && expr.index.kind === "literal") {
    return lowerVar(`${expr.target.name}[${expr.index.value}]`, ctx, locals, expectedType);
  }
  if (expr.target.kind === "var") {
    const targetType = varType(expr.target.name, ctx);
    const arrayArgs = inlineArrayLikeTypeArgs(targetType, ctx.layouts);
    if (arrayArgs) {
      const [rawCapacity, itemType] = arrayArgs;
      const capacity = Number.isFinite(rawCapacity)
        ? rawCapacity
        : inlineArrayCapacityFromLocals(expr.target.name, locals);
      if (capacity > 0) {
        const elementType = unresolvedTypeParam(itemType) ? expectedType ?? itemType : itemType;
        return lowerRuntimeInlineArrayIndex(
          expr.target.name,
          expr.index,
          capacity,
          elementType,
          ctx,
          locals,
        );
      }
    }
  }
  const fieldTarget = fieldAccessName(expr.target);
  if (fieldTarget) {
    const storageTarget = resolveForkAliasName(fieldTarget, ctx);
    const targetType = exprTypeWithLocals(expr.target, ctx);
    const arrayArgs = inlineArrayLikeTypeArgs(targetType, ctx.layouts);
    const [rawCapacity, itemType] = arrayArgs ?? [Number.NaN, expectedType ?? "i32"];
    const capacity = Number.isFinite(rawCapacity)
      ? rawCapacity
      : inlineArrayCapacityFromLocals(storageTarget, locals);
    if (capacity > 0) {
      const elementType = unresolvedTypeParam(itemType) ? expectedType ?? itemType : itemType;
      return lowerRuntimeInlineArrayIndex(
        storageTarget,
        expr.index,
        capacity,
        elementType,
        ctx,
        locals,
      );
    }
  }
  throw new Error("backend only supports inline-array indexing");
}

function fieldAccessName(expr: Expr): string | undefined {
  if (expr.kind === "var") return expr.name;
  if (expr.kind !== "field") return undefined;
  if (expr.key.kind !== "literal") return undefined;
  const base = fieldAccessName(expr.value);
  if (!base) return undefined;
  return `${base}.${expr.key.value.replace(/^#/, "").replace(/^"|"$/g, "")}`;
}

function inlineArrayCapacityFromLocals(target: string, locals: Set<string>): number {
  const localBase = target.replaceAll(".", "$");
  let capacity = 0;
  while (
    locals.has(`${localBase}$${capacity}`) ||
    [...locals].some((slot) => slot.startsWith(`${localBase}$${capacity}$`))
  ) {
    capacity++;
  }
  return capacity;
}

function unresolvedTypeParam(type: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(type.trim());
}

function lowerFrozenIndex(
  expr: Extract<Expr, { kind: "index" }>,
  targetType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const arrayArgs = inlineArrayLikeTypeArgs(targetType, ctx.layouts);
  const itemType = arrayArgs?.[1] ?? "i32";
  const itemSize = Math.max(4, byteSizeOf(itemType, ctx.layouts));
  return [
    ...lowerExpr(expr.target, ctx, locals, `#(${targetType ?? "i32"})`),
    ...lowerExpr(expr.index, ctx, locals, "i32"),
    { op: "const", type: "i32", value: itemSize },
    { op: "binary", wasm: "i32.mul" },
    { op: "binary", wasm: "i32.add" },
    { op: "load", type: watType(itemType), align: Math.min(itemSize, 4), offset: 0 },
  ];
}

function lowerFrozenVarIndex(
  name: string,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const match = name.match(/^(.*)\[([0-9]+)\]$/);
  if (!match) return undefined;
  const targetName = match[1] ?? "";
  const targetType = varType(targetName, ctx);
  if (!isFrozenType(targetType)) return undefined;
  const arrayArgs = inlineArrayLikeTypeArgs(stripFrozenType(targetType), ctx.layouts);
  const itemType = arrayArgs?.[1] ?? "i32";
  const itemSize = Math.max(4, byteSizeOf(itemType, ctx.layouts));
  return [
    ...lowerVar(targetName, ctx, locals, targetType),
    { op: "const", type: "i32", value: Number.parseInt(match[2] ?? "0", 10) * itemSize },
    { op: "binary", wasm: "i32.add" },
    { op: "load", type: watType(itemType), align: Math.min(itemSize, 4), offset: 0 },
  ];
}

function lowerFrozenCollectionLiteral(
  expr: Extract<Expr, { kind: "shape" }>,
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const targetType = stripFrozenType(expectedType);
  const itemType = inlineArrayLikeTypeArgs(targetType, ctx.layouts)?.[1] ?? "i32";
  const bytes: number[] = [];
  for (const slot of expr.slots) {
    if (slot.value.kind === "literal" && slot.value.literalKind === "number") {
      bytes.push(...i32Bytes(Number.parseInt(slot.value.value, 10)));
    } else {
      bytes.push(0, 0, 0, 0);
    }
    const size = Math.max(4, byteSizeOf(itemType, ctx.layouts));
    while (bytes.length % size !== 0) bytes.push(0);
  }
  const offset = allocateFrozenData(ctx, bytes);
  return [{ op: "const", type: "i32", value: offset }];
}

function allocateFrozenData(ctx: LowerContext, bytes: number[]): number {
  const align = 16;
  const start = Math.ceil((ctx.nextDataOffset ?? 1024) / align) * align;
  ctx.frozenData?.push({ offset: start, bytes });
  ctx.nextDataOffset = start + Math.max(bytes.length, 1);
  return start;
}

function i32Bytes(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function byteSizeOf(type: string | undefined, layouts: LayoutEnv): number {
  return Math.max(4, flattenType(type, layouts).length * 4);
}

function slotByteSize(slot: LayoutSlot): number {
  return slot.wat === "v128" ? 16 : 4;
}

function lowerRuntimeInlineArrayIndex(
  target: string,
  index: Expr,
  capacity: number,
  itemType: string,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const fallback = lowerVar(`${target}[${Math.max(0, capacity - 1)}]`, ctx, locals, itemType);
  const flattened = flattenType(itemType, ctx.layouts).map((slot) => slot.wat);
  const results = fallback.length > flattened.length
    ? fallback.map(() => "i32" as const)
    : flattened;
  let body = fallback;
  for (let item = capacity - 2; item >= 0; item--) {
    body = [
      ...lowerExpr(index, ctx, locals, "i32"),
      { op: "const", type: "i32", value: item },
      { op: "binary", wasm: "i32.eq" },
      {
        op: "if",
        results,
        thenBody: lowerVar(`${target}[${item}]`, ctx, locals, itemType),
        elseBody: body,
      },
    ];
  }
  return body;
}

function varType(name: string, ctx: LowerContext): string | undefined {
  name = resolveForkAliasName(name, ctx);
  const [base, ...fields] = name.split(".");
  let current = ctx.localTypes?.get(baseName(base));
  for (const field of fields) {
    const resolved = resolveAlias(stripReferenceType(current), ctx.layouts);
    const decl = resolved ? ctx.layouts.types.get(typeName(resolved)) : undefined;
    if (decl?.normalized?.kind !== "product") return undefined;
    current = decl.normalized.shape.slots.find((slot) => slot.label === field)?.type;
  }
  return current;
}

function productConstructorType(constructor: string, layouts: LayoutEnv): string | undefined {
  const found = [...layouts.types.values()].find((decl) =>
    decl.normalized?.kind === "product" &&
    terminalName(decl.normalized.constructor) === terminalName(constructor)
  );
  return found?.name;
}

function terminalName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function inlineArrayTypeArgs(
  type: string | undefined,
  layouts: LayoutEnv,
): [number, string] | undefined {
  const resolved = resolveAlias(stripFrozenType(type), layouts);
  const unqualified = resolved?.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
  const args = unqualified ? typeCallArgs(unqualified, "InlineArray") : undefined;
  if (!args) return undefined;
  const [count, itemType] = splitTypeArgs(args);
  return [Number.parseInt(count ?? "0", 10), itemType?.trim() ?? "i32"];
}

function inlineArrayLikeTypeArgs(
  type: string | undefined,
  layouts: LayoutEnv,
): [number, string] | undefined {
  const candidates = [stripFrozenType(type), resolveAlias(stripFrozenType(type), layouts)].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  let args: string | undefined;
  for (const candidate of candidates) {
    const unqualified = candidate.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
    args = typeCallArgs(unqualified, "InlineArray") ??
      typeCallArgs(unqualified, "InlineArrayList") ??
      typeCallArgs(unqualified, "InlineArrayBuilder") ??
      typeCallArgs(unqualified, "ComponentStore");
    if (args) break;
  }
  if (!args) return undefined;
  const [count, itemType] = splitTypeArgs(args);
  return [Number.parseInt(count ?? "0", 10), itemType?.trim() ?? "i32"];
}

function resolveForkAliasName(name: string, ctx: LowerContext): string {
  const originalBase = baseName(name);
  const suffix = name.slice(originalBase.length);
  let base = originalBase;
  const seen = new Set<string>();
  while (!seen.has(base)) {
    seen.add(base);
    const alias = ctx.ownership?.forkAliases.get(base);
    if (!alias) break;
    base = alias.source;
  }
  return `${base}${suffix}`;
}

function lowerVar(
  name: string,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  name = resolveForkAliasName(name, ctx);
  const layouts = ctx.layouts;
  const base = baseName(name);
  const projection = projectionSuffix(name);
  if (projection) {
    const direct = `${base}$${projection}`;
    const prefixed = [...locals].filter((slot) => slot.startsWith(`${direct}$`));
    if (prefixed.length && !isPrimitiveType(resolveAlias(expectedType, layouts) ?? "")) {
      return prefixed.map((slot) => ({ op: "local.get", name: slot }));
    }
    if (locals.has(direct)) return [{ op: "local.get", name: direct }];
    const packed = packedProjection(base, projection, layouts, locals);
    if (packed) return packed;
    const projected = flattenType(expectedType, layouts).map((slot) =>
      slot.suffix ? `${direct}$${slot.suffix}` : direct
    ).filter((slot) => locals.has(slot));
    const fallback = projected.length ? projected : prefixed;
    return (fallback.length ? fallback : [direct]).map((slot) => ({
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

function lowerShapeStorage(
  slots: { label?: string; value: Expr; spread?: boolean }[],
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const expanded = expandSpreadSlots(slots, expectedType, ctx, locals);
  if (expanded) slots = expanded;
  const layout = flattenType(expectedType, ctx.layouts);
  if (!layout.some((slot) => slot.fields && slot.fields.length > 1)) {
    return slots.flatMap((slot, index) =>
      lowerExpr(slot.value, ctx, locals, shapeSlotTypes(expectedType, ctx.layouts)[index])
    );
  }
  return layout.flatMap((lane) => {
    if (!lane.fields?.length) return [];
    if (lane.fields.length === 1) {
      const field = lane.fields[0];
      const slot = slots.find((item, index) => (item.label ?? String(index)) === field.name);
      return slot ? lowerExpr(slot.value, ctx, locals, field.type) : [];
    }
    const wat = lane.wat;
    return lane.fields.flatMap((field, index) => {
      const slot = slots.find((item, itemIndex) =>
        (item.label ?? String(itemIndex)) === field.name
      );
      if (!slot) return [];
      const value = lowerExpr(slot.value, ctx, locals, field.type);
      const shifted = field.offset === 0 ? maskValue(value, wat, field.width) : [
        ...maskValue(value, wat, field.width),
        { op: "const", type: wat, value: field.offset } as Instr,
        { op: "binary", wasm: `${wat}.shl` } as Instr,
      ];
      return index === 0 ? shifted : [...shifted, { op: "binary", wasm: `${wat}.or` } as Instr];
    });
  });
}

function expandSpreadSlots(
  slots: { label?: string; value: Expr; spread?: boolean }[],
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): { label?: string; value: Expr }[] | undefined {
  if (!slots.some((slot) => slot.spread)) return undefined;
  const itemTypes = shapeSlotTypes(expectedType, ctx.layouts);
  const expanded: { label?: string; value: Expr }[] = [];
  for (const slot of slots) {
    if (!slot.spread) {
      expanded.push(slot);
      continue;
    }
    const tailType = exprTypeWithLocals(slot.value, ctx);
    const args = inlineArrayLikeTypeArgs(tailType, ctx.layouts);
    const count = args?.[0] ?? 0;
    for (let index = 0; index < count; index++) {
      expanded.push({
        value: {
          kind: "index",
          target: slot.value,
          index: {
            kind: "literal",
            literalKind: "number",
            value: String(index),
            inferredType: "i32",
          },
        },
      });
    }
  }
  return expanded.map((slot, index) => ({
    ...slot,
    value: slot.value.kind === "literal" && itemTypes[index] === "i32" &&
        slot.value.literalKind === "number"
      ? { ...slot.value, inferredType: "i32" }
      : slot.value,
  }));
}

function maskValue(value: Instr[], wat: ValueType, width: number): Instr[] {
  if ((wat === "i32" && width >= 32) || (wat === "i64" && width >= 64)) return value;
  return [
    ...value,
    { op: "const", type: wat, value: 2 ** width - 1 },
    { op: "binary", wasm: `${wat}.and` } as Instr,
  ];
}

function packedProjection(
  base: string,
  projection: string,
  layouts: LayoutEnv,
  locals: Set<string>,
): Instr[] | undefined {
  for (const decl of layouts.types.values()) {
    if (decl.normalized?.kind !== "product") continue;
    for (const lane of flattenType(decl.name, layouts)) {
      const field = lane.fields?.find((item) => item.name === projection);
      if (!field) continue;
      const local = `${base}$${lane.suffix}`;
      if (!locals.has(local)) continue;
      const value: Instr[] = [{ op: "local.get", name: local }];
      const shifted = field.offset === 0 ? value : [
        ...value,
        { op: "const", type: lane.wat, value: field.offset } as Instr,
        { op: "binary", wasm: `${lane.wat}.shr_u` } as Instr,
      ];
      return maskValue(shifted, lane.wat, field.width);
    }
  }
  return undefined;
}

function lowerMatchArms(
  value: Expr,
  arms: { pattern: ParamPattern; value: Expr }[],
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  const [arm, ...rest] = arms;
  if (!arm) return [{ op: "const", type: "i32", value: 0 }];
  if (arm.pattern.kind === "wildcard" || rest.length === 0) {
    return lowerExpr(arm.value, ctx, locals, expectedType);
  }
  return [
    ...lowerExpr(value, ctx, locals),
    ...lowerPatternTest(arm.pattern),
    {
      op: "if",
      results: flattenType(expectedType, ctx.layouts).map((slot) => slot.wat),
      thenBody: lowerExpr(arm.value, ctx, locals, expectedType),
      elseBody: lowerMatchArms(value, rest, ctx, locals, expectedType),
    },
  ];
}

function lowerStepMatch(
  value: Expr,
  arms: { pattern: ParamPattern; value: Expr }[],
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (value.kind !== "call" || value.callee.kind !== "var") return undefined;
  const id = compilerCallId(value.callee.name, ctx.intrinsicIdsByName);
  if (id !== "index_cursor_next" && !isIndexCursorNextCallee(value.callee.name)) return undefined;
  const n = value.args.length >= 2
    ? value.args[value.args.length - 2]
    : constSpecializedCursorBound(value.callee.name);
  const cursor = value.args[value.args.length - 1];
  if (!n || !cursor) return undefined;
  const yieldArm = arms.find((arm) =>
    arm.pattern.kind === "constructor" && arm.pattern.name === "Yield"
  );
  const doneArm = arms.find((arm) =>
    (arm.pattern.kind === "constructor" || arm.pattern.kind === "binding") &&
    arm.pattern.name === "Done"
  );
  if (!yieldArm || !doneArm || yieldArm.pattern.kind !== "constructor") return undefined;
  const item = yieldArm.pattern.args[0];
  const next = yieldArm.pattern.args[1];
  const scoped = new Set(locals);
  const itemName = item?.kind === "binding" ? item.name : "__iter_item";
  const nextName = next?.kind === "binding" ? next.name : "__iter_next";
  scoped.add(itemName);
  scoped.add(nextName);
  ctx.tempLocals.push({ name: itemName, type: "i32" }, { name: nextName, type: "i32" });
  return [
    ...lowerExpr(cursor, ctx, locals, "i32"),
    ...lowerExpr(n, ctx, locals, "i32"),
    { op: "binary", wasm: "i32.lt_s" },
    {
      op: "if",
      results: flattenType(expectedType, ctx.layouts).map((slot) => slot.wat),
      thenBody: [
        ...lowerExpr(cursor, ctx, locals, "i32"),
        { op: "local.set", name: itemName },
        ...lowerExpr(cursor, ctx, locals, "i32"),
        { op: "const", type: "i32", value: 1 },
        { op: "binary", wasm: "i32.add" },
        { op: "local.set", name: nextName },
        ...lowerExpr(yieldArm.value, ctx, scoped, expectedType),
      ],
      elseBody: lowerExpr(doneArm.value, ctx, locals, expectedType),
    },
  ];
}

function lowerPatternTest(pattern: ParamPattern): Instr[] {
  if (pattern.kind !== "literal" && pattern.kind !== "type") {
    return [{ op: "drop" }, {
      op: "const",
      type: "i32",
      value: pattern.kind === "wildcard" ? 1 : 0,
    }];
  }
  const text = pattern.kind === "literal" ? pattern.value : pattern.name;
  if (text === "true") {
    return [{ op: "const", type: "i32", value: 1 }, { op: "binary", wasm: "i32.eq" }];
  }
  if (text === "false") return [{ op: "binary", wasm: "i32.eqz" }];
  if (pattern.kind === "literal") {
    const member = pattern.literalKind === "string"
      ? { kind: "string" as const, value: pattern.value.slice(1, -1) }
      : pattern.literalKind === "char"
      ? { kind: "char" as const, value: JSON.parse(`"${pattern.value.slice(1, -1)}"`) }
      : pattern.literalKind === "literalType"
      ? { kind: "literal" as const, value: pattern.value.slice(1) }
      : undefined;
    if (member) {
      return [{ op: "const", type: "i32", value: literalRuntimeValue(member) }, {
        op: "binary",
        wasm: "i32.eq",
      }];
    }
  }
  const value = Number.parseInt(text, 10);
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

interface TailCallAnalysis {
  hasDirectSelfCall: boolean;
  hasOnlyTailDirectSelfCalls: boolean;
}

function analyzeTailCalls(fn: FnDecl): TailCallAnalysis {
  const hasDirectSelfCall = hasSelfCall(fn.body, fn.name);
  return {
    hasDirectSelfCall,
    hasOnlyTailDirectSelfCalls: hasDirectSelfCall &&
      blockHasOnlyTailSelfCalls(fn.body, fn.name),
  };
}

function blockHasOnlyTailSelfCalls(block: BlockExpr, name: string): boolean {
  for (const stmt of block.statements) {
    if (statementHasSelfCall(stmt, name)) return false;
  }
  return block.expr ? exprHasOnlyTailSelfCalls(block.expr, name) : true;
}

function exprHasOnlyTailSelfCalls(expr: Expr, name: string): boolean {
  if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === name) {
    return !expr.args.some((arg) => exprHasSelfCall(arg, name));
  }
  if (expr.kind === "match") {
    return !exprHasSelfCall(expr.value, name) &&
      expr.arms.every((arm) => exprHasOnlyTailSelfCalls(arm.value, name));
  }
  return !exprHasSelfCall(expr, name);
}

function hasSelfCall(block: BlockExpr, name: string): boolean {
  return block.statements.some((stmt) => statementHasSelfCall(stmt, name)) ||
    (block.expr ? exprHasSelfCall(block.expr, name) : false);
}

function statementHasSelfCall(stmt: Statement, name: string): boolean {
  switch (stmt.kind) {
    case "let":
    case "destructure_let":
      return exprHasSelfCall(stmt.value, name);
    case "proof_const":
    case "fork_let":
      return false;
  }
}

function exprHasSelfCall(expr: Expr, name: string): boolean {
  switch (expr.kind) {
    case "borrow":
      return exprHasSelfCall(expr.value, name);
    case "call":
      return (expr.callee.kind === "var" && expr.callee.name === name) ||
        exprHasSelfCall(expr.callee, name) ||
        expr.args.some((arg) => exprHasSelfCall(arg, name));
    case "index":
      return exprHasSelfCall(expr.target, name) || exprHasSelfCall(expr.index, name);
    case "binary":
      return exprHasSelfCall(expr.left, name) || exprHasSelfCall(expr.right, name);
    case "pipe_bind":
      return exprHasSelfCall(expr.value, name) || exprHasSelfCall(expr.body, name);
    case "match":
      return exprHasSelfCall(expr.value, name) ||
        expr.arms.some((arm) => exprHasSelfCall(arm.value, name));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) => exprHasSelfCall(slot.value, name));
    case "range":
      return exprHasSelfCall(expr.start, name) || exprHasSelfCall(expr.end, name);
    case "static_for_slots":
      return exprHasSelfCall(expr.value, name);
    case "field":
      return exprHasSelfCall(expr.value, name) || exprHasSelfCall(expr.key, name);
    case "block":
      return hasSelfCall(expr, name);
    case "literal":
    case "var":
    case "placeholder":
      return false;
  }
}

function calledFunctions(expr: Expr | BlockExpr): Set<string> {
  const calls = new Set<string>();
  const visit = (item: Expr | Statement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "let":
        visit(item.value);
        return;
      case "destructure_let":
        visit(item.value);
        return;
      case "fork_let":
      case "proof_const":
      case "literal":
      case "var":
      case "placeholder":
        return;
      case "call":
        if (item.callee.kind === "var") calls.add(item.callee.name);
        visit(item.callee);
        for (const arg of item.args) visit(arg);
        return;
      case "index":
        visit(item.target);
        visit(item.index);
        return;
      case "binary":
        visit(item.left);
        visit(item.right);
        return;
      case "pipe_bind":
        visit(item.value);
        visit(item.body);
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
  const memory = module.memory ? [`  (memory (export "memory") 1)`] : [];
  const data = module.data.map((item) => emitDataWat(item));
  const functions = module.functions.map((fn) => emitFunctionWat(fn));
  return `(module\n${[...imports, ...memory, ...data, ...functions].join("\n")}\n)`;
}

function emitDataWat(item: BackendData): string {
  const bytes = item.bytes.map((byte) => `\\${byte.toString(16).padStart(2, "0")}`).join("");
  return `  (data (i32.const ${item.offset}) "${bytes}")`;
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
    case "return_call":
      return [`${prefix}return_call $${watName(instr.name)}`];
    case "binary":
      return [`${prefix}${instr.wasm}`];
    case "simd":
      return [
        `${prefix}${instr.wasm}${
          instr.lanes
            ? ` ${instr.lanes.join(" ")}`
            : instr.lane === undefined
            ? ""
            : ` ${instr.lane}`
        }`,
      ];
    case "load":
      return [`${prefix}${instr.type}.load align=${instr.align} offset=${instr.offset}`];
    case "store":
      return [`${prefix}${instr.type}.store align=${instr.align} offset=${instr.offset}`];
    case "drop":
      return [`${prefix}drop`];
    case "unreachable":
      return [`${prefix}unreachable`];
    case "if":
      return [
        `${prefix}if${instr.results.map((result) => ` (result ${result})`).join("")}`,
        ...emitInstrsWat(instr.thenBody, indent + 2),
        `${prefix}else`,
        ...emitInstrsWat(instr.elseBody, indent + 2),
        `${prefix}end`,
      ];
    case "block":
      return [
        `${prefix}block${(instr.results ?? []).map((result) => ` (result ${result})`).join("")}`,
        ...emitInstrsWat(instr.body, indent + 2),
        `${prefix}end`,
      ];
    case "loop":
      return [
        `${prefix}loop${(instr.results ?? []).map((result) => ` (result ${result})`).join("")}`,
        ...emitInstrsWat(instr.body, indent + 2),
        `${prefix}end`,
      ];
    case "br":
      return [`${prefix}br ${instr.depth}`];
    case "br_if":
      return [`${prefix}br_if ${instr.depth}`];
  }
}

function backendModuleToWasm(module: BackendModule): Uint8Array<ArrayBuffer> {
  const allFns = [...module.imports, ...module.functions];
  const functionTypes = allFns.map((fn) => ({
    params: fn.params.map((param) =>
      typeof param === "string" ? wasmType(param) : wasmType(param.type)
    ),
    results: fn.results.map(wasmType),
  }));
  const blockTypes = collectBlockTypes(module.functions).map((results) => ({
    params: [],
    results: results.map(wasmType),
  }));
  const types = [...functionTypes, ...blockTypes];
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
  if (module.memory) {
    section(bytes, 5, vecItems([[0x00, ...uleb(1)]]));
  }
  const exports = module.functions.filter((fn) => fn.exportName).map((fn) => [
    ...nameBytes(fn.exportName ?? fn.name),
    0x00,
    ...uleb(funcIndex.get(fn.name) ?? 0),
  ]);
  if (module.memory) exports.unshift([...nameBytes("memory"), 0x02, ...uleb(0)]);
  if (exports.length) section(bytes, 7, vecItems(exports));
  if (module.functions.length) {
    section(
      bytes,
      10,
      vecItems(module.functions.map((fn) => encodeFunction(fn, funcIndex, typeKeys))),
    );
  }
  if (module.data.length) {
    section(
      bytes,
      11,
      vecItems(module.data.map((item) => [
        0x00,
        0x41,
        ...sleb(item.offset),
        0x0b,
        ...vecRaw(item.bytes),
      ])),
    );
  }
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

function collectBlockTypes(functions: BackendFunction[]): ValueType[][] {
  const types: ValueType[][] = [];
  const visit = (instr: Instr) => {
    if (
      (instr.op === "if" || instr.op === "block" || instr.op === "loop") &&
      (instr.results?.length ?? 0) > 1
    ) {
      types.push(instr.results ?? []);
    }
    if (instr.op === "if") {
      instr.thenBody.forEach(visit);
      instr.elseBody.forEach(visit);
    }
    if (instr.op === "block" || instr.op === "loop") instr.body.forEach(visit);
  };
  functions.forEach((fn) => fn.body.forEach(visit));
  return types;
}

function encodeFunction(
  fn: BackendFunction,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
): number[] {
  const localIndex = new Map<string, number>();
  [...fn.params, ...fn.locals].forEach((slot, index) => localIndex.set(slot.name, index));
  const body = [
    ...localDecls(fn.locals),
    ...encodeInstrs(fn.body, localIndex, funcIndex, typeKeys),
    0x0b,
  ];
  return [...uleb(body.length), ...body];
}

function encodeInstrs(
  instrs: Instr[],
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
): number[] {
  return instrs.flatMap((instr) => encodeInstr(instr, locals, funcIndex, typeKeys));
}

function encodeInstr(
  instr: Instr,
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
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
    case "return_call": {
      const index = funcIndex.get(instr.name);
      if (index === undefined) throw new Error(`backend missing lowered callable: ${instr.name}`);
      return [0x12, ...uleb(index)];
    }
    case "binary":
      return [wasmBinaryOp(instr.wasm)];
    case "simd":
      return simdImmediate(instr.wasm, instr.lane, instr.lanes);
    case "load":
      return [...wasmLoadOp(instr.type), ...memarg(instr.align, instr.offset)];
    case "store":
      return [...wasmStoreOp(instr.type), ...memarg(instr.align, instr.offset)];
    case "drop":
      return [0x1a];
    case "unreachable":
      return [0x00];
    case "if":
      return [
        0x04,
        ...blockType(instr.results, typeKeys),
        ...encodeInstrs(instr.thenBody, locals, funcIndex, typeKeys),
        0x05,
        ...encodeInstrs(instr.elseBody, locals, funcIndex, typeKeys),
        0x0b,
      ];
    case "block":
      return [
        0x02,
        ...blockType(instr.results, typeKeys),
        ...encodeInstrs(instr.body, locals, funcIndex, typeKeys),
        0x0b,
      ];
    case "loop":
      return [
        0x03,
        ...blockType(instr.results, typeKeys),
        ...encodeInstrs(instr.body, locals, funcIndex, typeKeys),
        0x0b,
      ];
    case "br":
      return [0x0c, ...uleb(instr.depth)];
    case "br_if":
      return [0x0d, ...uleb(instr.depth)];
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
    ...packProjectedLane4I32(pattern.base, locals),
    ...lowerExpr(pattern.rhs, ctx, locals, "i32"),
    { op: "simd", wasm: "i32x4.splat" },
    { op: "simd", wasm: op },
  ];
}

function lowerLane4I32Value(expr: Expr, ctx: LowerContext, locals: Set<string>): Instr[] {
  if (expr.kind === "var" && locals.has(expr.name)) return [{ op: "local.get", name: expr.name }];
  if (expr.kind === "var" && locals.has(`${expr.name}$0`)) {
    return packProjectedLane4I32(expr.name, locals);
  }
  if (expr.kind === "shape" && expr.slots.length === 4) {
    return packLane4I32(expr.slots.map((slot) => slot.value), ctx, locals);
  }
  return lowerExpr(expr, ctx, locals);
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

function packProjectedLane4I32(base: string, locals: Set<string>): Instr[] {
  if (locals.has(base)) return [{ op: "local.get", name: base }];
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

function lowerDot4I32(
  expr: Extract<Expr, { kind: "binary" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const pattern = dot4I32Pattern(expr);
  if (!pattern) return undefined;
  const name = `__simd_tmp${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name, type: "v128" });
  return [
    ...packProjectedLane4I32(pattern.left, locals),
    ...packProjectedLane4I32(pattern.right, locals),
    { op: "simd", wasm: "i32x4.mul" },
    { op: "local.set", name },
    { op: "local.get", name },
    { op: "local.get", name },
    { op: "local.get", name },
    { op: "simd", wasm: "i8x16.shuffle", lanes: shuffleI32Lanes([2, 3, 0, 1]) },
    { op: "simd", wasm: "i32x4.add" },
    { op: "local.set", name },
    { op: "local.get", name },
    { op: "local.get", name },
    { op: "local.get", name },
    { op: "simd", wasm: "i8x16.shuffle", lanes: shuffleI32Lanes([1, 0, 3, 2]) },
    { op: "simd", wasm: "i32x4.add" },
    { op: "simd", wasm: "i32x4.extract_lane", lane: 0 },
  ];
}

function shuffleI32Lanes(lanes: number[]): number[] {
  return lanes.flatMap((lane) => [0, 1, 2, 3].map((byte) => lane * 4 + byte));
}

function lowerMemoryIntrinsic(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const id = compilerCallId(expr.callee.name, ctx.intrinsicIdsByName);
  if (id === "memory_load_lane4_i32") {
    const ptr = expr.args.length === 1 ? expr.args[0] : expr.args[1];
    return [
      ...lowerExpr(
        ptr ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
        "i32",
      ),
      { op: "load", type: "v128", align: 16, offset: 0 },
    ];
  }
  if (id === "memory_load_i32") {
    const ptr = expr.args.length === 1 ? expr.args[0] : expr.args[1];
    return [
      ...lowerExpr(
        ptr ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
        "i32",
      ),
      { op: "load", type: "i32", align: 4, offset: 0 },
    ];
  }
  if (id === "memory_store_i32") {
    const ptr = expr.args.length === 2 ? expr.args[0] : expr.args[1];
    const value = expr.args.length === 2 ? expr.args[1] : expr.args[2];
    return [
      ...lowerExpr(
        ptr ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
        "i32",
      ),
      ...lowerExpr(
        value ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
        "i32",
      ),
      { op: "store", type: "i32", align: 4, offset: 0 },
    ];
  }
  if (id === "memory_store_lane4_i32") {
    const ptr = expr.args.length === 3 ? expr.args[1] : expr.args[0];
    const value = expr.args.length === 3 ? expr.args[2] : expr.args[1];
    return [
      ...lowerExpr(
        ptr ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
        "i32",
      ),
      ...lowerLane4I32Value(
        value ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
      ),
      { op: "store", type: "v128", align: 16, offset: 0 },
    ];
  }
  return undefined;
}

function compilerCallId(name: string, intrinsicIdsByName: Map<string, string>): string | undefined {
  return name.startsWith("@") ? name.slice(1) : intrinsicCallId(name, intrinsicIdsByName);
}

function dot4I32Pattern(expr: Expr): { left: string; right: string } | undefined {
  const terms = collectDotTerms(expr);
  if (terms.length !== 4) return undefined;
  const seen = new Set<number>();
  let leftBase: string | undefined;
  let rightBase: string | undefined;
  for (const product of terms) {
    if (seen.has(product.lane)) return undefined;
    seen.add(product.lane);
    leftBase ??= product.left;
    rightBase ??= product.right;
    if (leftBase !== product.left || rightBase !== product.right) return undefined;
  }
  return seen.size === 4 && leftBase && rightBase
    ? { left: leftBase, right: rightBase }
    : undefined;
}

function collectDotTerms(expr: Expr): { left: string; right: string; lane: number }[] {
  const explicit = collectAddTerms(expr).map(laneProduct);
  if (explicit.every((term) => term !== undefined)) {
    return explicit as { left: string; right: string; lane: number }[];
  }
  return mixedPrecedenceDotTerms(expr) ?? [];
}

function collectAddTerms(expr: Expr): Expr[] {
  if (expr.kind === "binary" && expr.op === "+") {
    return [...collectAddTerms(expr.left), ...collectAddTerms(expr.right)];
  }
  return [expr];
}

function laneProduct(expr: Expr): { left: string; right: string; lane: number } | undefined {
  if (expr.kind !== "binary" || expr.op !== "*") return undefined;
  if (expr.left.kind !== "var" || expr.right.kind !== "var") return undefined;
  const leftLane = laneProjection(expr.left.name);
  const rightLane = laneProjection(expr.right.name);
  if (!leftLane || !rightLane || leftLane.lane !== rightLane.lane) return undefined;
  return { left: leftLane.base, right: rightLane.base, lane: leftLane.lane };
}

function mixedPrecedenceDotTerms(
  expr: Expr,
): { left: string; right: string; lane: number }[] | undefined {
  if (expr.kind !== "binary" || expr.op !== "*") return undefined;
  if (expr.left.kind === "var") {
    const left = laneProjection(expr.left.name);
    const right = expr.right.kind === "var" ? laneProjection(expr.right.name) : undefined;
    return left && right && left.lane === right.lane
      ? [{ left: left.base, right: right.base, lane: left.lane }]
      : undefined;
  }
  if (expr.left.kind !== "binary" || expr.left.op !== "+") return undefined;
  if (expr.left.right.kind !== "var" || expr.right.kind !== "var") return undefined;
  const previous = mixedPrecedenceDotTerms(expr.left.left);
  const left = laneProjection(expr.left.right.name);
  const right = laneProjection(expr.right.name);
  if (!previous || !left || !right || left.lane !== right.lane) return undefined;
  return [...previous, { left: left.base, right: right.base, lane: left.lane }];
}

function laneProjection(name: string): { base: string; lane: number } | undefined {
  const projection = projectionSuffix(name);
  if (!projection || !/^[0-3]$/.test(projection)) return undefined;
  return { base: baseName(name), lane: Number.parseInt(projection, 10) };
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
  if (!resolved?.startsWith("InlineArray(")) return false;
  const args = splitTypeArgs(resolved.slice("InlineArray(".length, -1));
  return Number.parseInt(args[0] ?? "0", 10) === 4 && (args[1]?.trim() ?? "i32") === "i32";
}

function watType(type: string | Param | undefined): ValueType {
  const source = typeof type === "string" || type === undefined ? type : type.type;
  if (literalTypeMembers(source)) return "i32";
  if (source === "i64" || source === "u64" || (unsignedBitWidth(source ?? "") ?? 0) > 32) {
    return "i64";
  }
  if (source === "f32") return "f32";
  if (source === "f64") return "f64";
  return "i32";
}

type LiteralTypeMember = {
  kind: "number" | "bool" | "string" | "char" | "literal";
  value: string;
};

function literalTypeMembers(type: string | undefined): LiteralTypeMember[] | undefined {
  if (!type) return undefined;
  const parts = splitLiteralUnion(type);
  if (!parts.length) return undefined;
  const members = parts.map(parseLiteralTypeMember);
  return members.every((member): member is LiteralTypeMember => member !== undefined)
    ? members
    : undefined;
}

function splitLiteralUnion(type: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < type.length; index++) {
    const char = type[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(" || char === "{" || char === "[") {
      depth++;
    } else if (char === ")" || char === "}" || char === "]") {
      depth--;
    } else if (char === "|" && depth === 0) {
      parts.push(type.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(type.slice(start).trim());
  return parts.filter(Boolean);
}

function parseLiteralTypeMember(source: string): LiteralTypeMember | undefined {
  if (/^[0-9]+(?:\.[0-9]+)?(?:i32|u32|i64|u64|f32|f64)?$/.test(source)) {
    return { kind: "number", value: source };
  }
  if (source === "true" || source === "false") return { kind: "bool", value: source };
  if (/^#([a-z_][a-z0-9_]*|[A-Z][A-Za-z0-9]*)$/.test(source)) {
    return { kind: "literal", value: source.slice(1) };
  }
  if (source.startsWith('"') && source.endsWith('"')) {
    return { kind: "string", value: JSON.parse(source) };
  }
  if (source.startsWith("'") && source.endsWith("'")) {
    return { kind: "char", value: JSON.parse(`"${source.slice(1, -1)}"`) };
  }
  return undefined;
}

function literalRuntimeValue(member: LiteralTypeMember): number {
  if (member.kind === "bool") return member.value === "true" ? 1 : 0;
  if (member.kind === "number") return Number.parseInt(member.value, 10);
  if (member.kind === "char") return member.value.codePointAt(0) ?? 0;
  return wgslShaderId(`${member.kind}:${member.value}`);
}

function literalExprRuntimeValue(expr: Extract<Expr, { kind: "literal" }>): number | undefined {
  const member = expr.literalKind === "number"
    ? { kind: "number" as const, value: expr.value }
    : expr.literalKind === "bool"
    ? { kind: "bool" as const, value: expr.value }
    : expr.literalKind === "string"
    ? { kind: "string" as const, value: expr.value.slice(1, -1) }
    : expr.literalKind === "char"
    ? { kind: "char" as const, value: JSON.parse(`"${expr.value.slice(1, -1)}"`) }
    : expr.literalKind === "literalType"
    ? { kind: "literal" as const, value: expr.value.slice(1) }
    : undefined;
  return member ? literalRuntimeValue(member) : undefined;
}

interface FlatSlot {
  name: string;
  wat: ValueType;
}

interface LayoutSlot {
  suffix: string;
  type: string;
  wat: ValueType;
  fields?: PackedField[];
}

interface PackedField {
  name: string;
  type: string;
  width: number;
  offset: number;
}

function createLayoutEnv(program: Program): LayoutEnv {
  return {
    types: new Map(
      program.declarations.filter((decl): decl is TypeDecl => decl.kind === "type").map((decl) => [
        decl.name,
        decl,
      ]),
    ),
    constShapes: new Map(
      program.declarations.filter((
        decl,
      ): decl is ConstDecl & { value: Extract<Expr, { kind: "shape" }> } =>
        decl.kind === "const" && decl.value.kind === "shape"
      )
        .map((decl) => [decl.name, decl.value as Extract<Expr, { kind: "shape" }>]),
    ),
  };
}

function flattenBinding(name: string, type: string | undefined, layouts: LayoutEnv): FlatSlot[] {
  return flattenType(type, layouts).map((slot) => ({
    name: slot.suffix ? `${name}$${slot.suffix}` : name,
    wat: slot.wat,
  }));
}

function statementLocalBindings(stmt: Statement, ctx: LowerContext): BackendLocal[] {
  if (stmt.kind === "destructure_let") {
    return stmt.names.flatMap((name, index) =>
      flattenBinding(name, stmt.slotTypes?.[index], ctx.layouts).map((slot) => ({
        name: slot.name,
        type: slot.wat,
      }))
    );
  }
  if (stmt.kind !== "let") return [];
  const type = stmt.type ?? exprTypeWithLocals(stmt.value, ctx);
  if (isLane4I32(type, ctx.layouts) && isMemoryLane4Load(stmt.value, ctx.functions)) {
    return [{ name: stmt.name, type: "v128" }];
  }
  return flattenBinding(stmt.name, type, ctx.layouts).map((slot) => ({
    name: slot.name,
    type: slot.wat,
  }));
}

function isMemoryLane4Load(expr: Expr, functions: Map<string, FnDecl>): boolean {
  const fn = expr.kind === "call" && expr.callee.kind === "var"
    ? functions.get(expr.callee.name)
    : undefined;
  return expr.kind === "call" && expr.callee.kind === "var" &&
    fn !== undefined && intrinsicWrapperId(fn) === "memory_load_lane4_i32";
}

function flattenType(type: string | undefined, layouts: LayoutEnv): LayoutSlot[] {
  type = stripBorrowType(type);
  if (isFrozenType(type)) return [{ suffix: "", type: type ?? "#(i32)", wat: "i32" }];
  const staticShape = flattenStaticShapeType(type, layouts);
  if (staticShape) return staticShape;
  const resolved = resolveAlias(type, layouts);
  if (!resolved) return [{ suffix: "", type: "i32", wat: "i32" }];
  if (resolved === "memory") return [];
  if (isPtrType(resolved)) return [{ suffix: "", type: resolved, wat: "i32" }];
  if (isPrimitiveType(resolved)) return [{ suffix: "", type: resolved, wat: watType(resolved) }];
  const inlineArrayArgs = typeCallArgs(resolved, "InlineArray");
  if (inlineArrayArgs) {
    const args = splitTypeArgs(inlineArrayArgs);
    const count = Number.parseInt(args[0] ?? "1", 10);
    const itemType = args[1]?.trim() ?? "i32";
    return repeatSlots(count, itemType, layouts);
  }
  const inlineArrayBuilderArgs = typeCallArgs(resolved, "InlineArrayBuilder");
  if (inlineArrayBuilderArgs) {
    const args = splitTypeArgs(inlineArrayBuilderArgs);
    const count = Number.parseInt(args[0] ?? "1", 10);
    const itemType = args[1]?.trim() ?? "i32";
    return repeatSlots(count, itemType, layouts);
  }
  const staticResolvedShape = flattenStaticShapeType(resolved, layouts);
  if (staticResolvedShape) return staticResolvedShape;
  const structArgs = typeCallArgs(resolved, "struct");
  if (structArgs) {
    const shape = constShapeFromTypeArg(structArgs, layouts);
    if (shape) {
      return flattenShape(
        shape.slots.map((slot) => ({
          label: slot.label,
          type: componentSpecType(slot.value) ?? "i32",
        })),
        layouts,
      );
    }
  }
  const refsArgs = typeCallArgs(resolved, "component_refs");
  const queryRowArgs = typeCallArgs(resolved, "query_row");
  const ergonomicRowArgs = typeCallArgs(resolved, "row");
  const rowArgs = queryRowArgs ?? ergonomicRowArgs;
  const valuesArgs = typeCallArgs(resolved, "values");
  const componentValuesArgs = typeCallArgs(resolved, "component_values") ?? valuesArgs ??
    refsArgs ?? rowArgs;
  if (componentValuesArgs) {
    const args = splitTypeArgs(componentValuesArgs);
    const shapeName = ergonomicRowArgs ? args[0]?.trim() : args.at(-1)?.trim();
    const shape = shapeName ? constShapeFromTypeArg(shapeName, layouts) : undefined;
    if (shape) {
      const slots = shape.slots.map((slot) => ({
        label: slot.label,
        type: refsArgs ? "i32" : componentSpecType(slot.value) ?? "i32",
      }));
      if (rowArgs) {
        slots.unshift({
          label: "entity",
          type: ergonomicRowArgs ? "i32" : args[0]?.trim() ?? "i32",
        });
      }
      return flattenShape(slots, layouts);
    }
  }
  const decl = layouts.types.get(typeName(resolved));
  if (decl?.normalized?.kind === "product") {
    const callArgs = typeCallArgs(resolved, typeName(resolved));
    const slots = callArgs === undefined
      ? decl.normalized.shape.slots
      : substituteProductShapeTypeParams(
        decl.normalized.shape.slots,
        decl,
        splitTypeArgs(callArgs),
      );
    return flattenShape(slots, layouts);
  }
  return [{ suffix: "", type: resolved, wat: watType(resolved) }];
}

function flattenStaticShapeType(
  type: string | undefined,
  layouts: LayoutEnv,
): LayoutSlot[] | undefined {
  type = stripReferenceType(type);
  if (!type) return undefined;
  const alias = layouts.types.get(type);
  if (alias?.normalized?.kind === "alias") {
    const expanded = flattenStaticShapeType(alias.normalized.type, layouts);
    if (expanded) return expanded;
  }
  const refsArgs = typeCallArgs(type, "component_refs");
  const slotArgs = typeCallArgs(type, "component_slot");
  if (slotArgs) {
    const args = splitTypeArgs(slotArgs);
    const count = args[0]?.trim() ?? "1";
    const component = args[1]?.trim() ?? "i32";
    return flattenShape([
      { label: "present", type: `InlineArray(${count}, bool)` },
      { label: "values", type: `InlineArray(${count}, ${component})` },
    ], layouts);
  }
  const sparseWorldArgs = typeCallArgs(type, "SparseWorld");
  if (sparseWorldArgs) {
    const args = splitTypeArgs(sparseWorldArgs);
    const count = args[0]?.trim() ?? "1";
    const shapeArg = args[1]?.trim() ?? "";
    const shape = constShapeFromTypeArg(shapeArg, layouts);
    if (!shape) return undefined;
    const slots = [
      { label: "next_entity_id", type: "i32" },
      { label: "defaults", type: `ComponentValues(${shapeArg})` },
      ...shape.slots.map((slot) => ({
        label: slot.label,
        type: `ComponentSlot(${componentSpecCount(slot.value) ?? count}, ${
          componentSpecType(slot.value) ?? "i32"
        })`,
      })),
    ];
    return flattenShape(slots, layouts);
  }
  const worldArgs = typeCallArgs(type, "world2d");
  if (worldArgs) {
    const args = splitTypeArgs(worldArgs);
    const shape = layouts.constShapes.get(args[1]?.trim() ?? "");
    if (!shape) return undefined;
    const slots = [
      { label: "next_entity_id", type: "i32" },
      { label: "component_next", type: "i32" },
      {
        label: "entities",
        type: `InlineArray(${args[0]?.trim() ?? "1"}, ${args[2]?.trim() ?? "i32"})`,
      },
      ...shape.slots.map((slot) => ({
        label: slot.label,
        type: `InlineArray(${componentSpecCount(slot.value) ?? "1"}, ${
          componentSpecType(slot.value) ?? "i32"
        })`,
      })),
    ];
    return flattenShape(slots, layouts);
  }
  const queryRowArgs = typeCallArgs(type, "query_row");
  const ergonomicRowArgs = typeCallArgs(type, "row");
  const rowArgs = queryRowArgs ?? ergonomicRowArgs;
  const valuesArgs = typeCallArgs(type, "values");
  const argsText = typeCallArgs(type, "component_values") ?? valuesArgs ?? refsArgs ?? rowArgs;
  if (!argsText) return undefined;
  const args = splitTypeArgs(argsText);
  const shapeName = ergonomicRowArgs ? args[0]?.trim() : args.at(-1)?.trim();
  const shape = shapeName ? constShapeFromTypeArg(shapeName, layouts) : undefined;
  if (!shape) return undefined;
  const slots = shape.slots.map((slot) => ({
    label: slot.label,
    type: refsArgs ? "i32" : componentSpecType(slot.value) ?? "i32",
  }));
  if (rowArgs) {
    slots.unshift({ label: "entity", type: ergonomicRowArgs ? "i32" : args[0]?.trim() ?? "i32" });
  }
  return flattenShape(slots, layouts);
}

function componentSpecCount(expr: Expr): string | undefined {
  if (expr.kind === "var") return "3";
  if (expr.kind !== "shape") return undefined;
  const count = expr.slots.find((slot) => slot.label === "count")?.value;
  return count?.kind === "literal" ? count.value : undefined;
}

function componentSpecType(expr: Expr): string | undefined {
  if (expr.kind === "var") return expr.name;
  if (expr.kind !== "shape") return undefined;
  const component = expr.slots.find((slot) => slot.label === "component")?.value;
  if (component?.kind === "var") return component.name;
  return undefined;
}

function constShapeFromTypeArg(
  source: string,
  layouts: LayoutEnv,
): Extract<Expr, { kind: "shape" }> | undefined {
  return layouts.constShapes.get(source) ?? parseInlineConstShape(source);
}

function parseInlineConstShape(source: string): Extract<Expr, { kind: "shape" }> | undefined {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return { kind: "shape", slots: [] };
  const slots = splitTypeArgs(inner).map((part, position) => {
    const colon = topLevelColon(part);
    if (colon < 0) {
      return {
        position,
        value: parseInlineConstShape(part) ?? ({ kind: "var", name: part.trim() } as Expr),
      };
    }
    const label = part.slice(0, colon).trim();
    const valueText = part.slice(colon + 1).trim();
    return {
      label,
      value: parseInlineConstShape(valueText) ?? ({ kind: "var", name: valueText } as Expr),
    };
  });
  return { kind: "shape", slots };
}

function topLevelColon(source: string): number {
  let parenDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth--;
    else if (char === ":" && parenDepth === 0 && braceDepth === 0) return index;
  }
  return -1;
}

function substituteProductShapeTypeParams(
  slots: ShapeTypeSlot[],
  decl: TypeDecl,
  args: string[],
): ShapeTypeSlot[] {
  return slots.map((slot) => ({
    ...slot,
    type: substituteAliasTypeParams(slot.type, decl, args),
  }));
}

function flattenShape(slots: ShapeTypeSlot[], layouts: LayoutEnv): LayoutSlot[] {
  const flattened: LayoutSlot[] = [];
  const flushPacked = (group: PackedField[], laneWidth: number) => {
    if (!group.length) return;
    const suffix = group.map((field) => field.name).join("$");
    flattened.push({
      suffix,
      type: `u${laneWidth}`,
      wat: laneWidth > 32 ? "i64" : "i32",
      fields: group,
    });
  };
  let group: PackedField[] = [];
  let groupWidth = 0;
  let laneWidth = 0;
  slots.forEach((slot, index) => {
    const repeat = slot.repeat ? Number.parseInt(slot.repeat, 10) : 1;
    const prefix = slot.label ?? String(index);
    for (let item = 0; item < repeat; item++) {
      const itemPrefix = repeat === 1 ? prefix : String(flattened.length);
      const bitWidth = unsignedBitWidth(slot.type);
      const storageWidth = bitWidth ? storageLaneWidth(bitWidth) : undefined;
      if (repeat === 1 && bitWidth && storageWidth && bitWidth <= 32) {
        if (!group.length) laneWidth = storageWidth;
        if (group.length && (storageWidth !== laneWidth || groupWidth + bitWidth > laneWidth)) {
          flushPacked(group, laneWidth);
          group = [];
          groupWidth = 0;
          laneWidth = storageWidth;
        }
        group.push({ name: itemPrefix, type: slot.type, width: bitWidth, offset: groupWidth });
        groupWidth += bitWidth;
        continue;
      }
      flushPacked(group, laneWidth);
      group = [];
      groupWidth = 0;
      laneWidth = 0;
      for (const child of flattenType(slot.type, layouts)) {
        flattened.push({
          ...child,
          suffix: child.suffix ? `${itemPrefix}$${child.suffix}` : itemPrefix,
        });
      }
    }
  });
  flushPacked(group, laneWidth);
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

function isPtrType(type: string): boolean {
  return typeName(type) === "ptr" && type.includes("(");
}

function resolveAlias(type: string | undefined, layouts: LayoutEnv): string | undefined {
  let current = stripBorrowType(type);
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const decl = layouts.types.get(current);
    if (decl) {
      if (decl.normalized?.kind !== "alias") return current;
      current = decl.normalized.type;
      continue;
    }
    const callName = typeName(current);
    const callDecl = layouts.types.get(callName);
    const callArgs = typeCallArgs(current, callName);
    if (callDecl?.normalized?.kind === "alias" && callArgs !== undefined) {
      current = substituteAliasTypeParams(
        callDecl.normalized.type,
        callDecl,
        splitTypeArgs(callArgs),
      );
      continue;
    }
    return current;
  }
  return current;
}

function stripBorrowType(type: string | undefined): string | undefined {
  let current = type?.trim();
  while (current?.startsWith("&")) current = unwrapPrefixedType(current, "&");
  return current;
}

function isFrozenType(type: string | undefined): boolean {
  return type?.trim().startsWith("#(") === true;
}

function stripFrozenType(type: string | undefined): string | undefined {
  let current = type?.trim();
  while (current?.startsWith("#(")) current = unwrapPrefixedType(current, "#");
  return current;
}

function stripReferenceType(type: string | undefined): string | undefined {
  let current = type?.trim();
  let changed = true;
  while (current && changed) {
    changed = false;
    if (current.startsWith("&")) {
      current = stripBorrowType(current);
      changed = true;
    }
    if (current?.startsWith("#(")) {
      current = stripFrozenType(current);
      changed = true;
    }
  }
  return current;
}

function unwrapPrefixedType(type: string, prefix: "&" | "#"): string {
  let current = type.trim();
  if (!current.startsWith(prefix)) return current;
  current = current.slice(prefix.length).trim();
  if (current.startsWith("(") && current.endsWith(")") && enclosesWholeType(current)) {
    return current.slice(1, -1).trim();
  }
  return current;
}

function enclosesWholeType(source: string): boolean {
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "(") depth++;
    else if (source[index] === ")") {
      depth--;
      if (depth === 0 && index !== source.length - 1) return false;
    }
  }
  return depth === 0;
}

function substituteAliasTypeParams(type: string, decl: TypeDecl, args: string[]): string {
  let result = type;
  decl.params.forEach((param, index) => {
    const arg = args[index]?.trim();
    if (!arg) return;
    result = result.replace(new RegExp(`\\b${param.name}\\b`, "g"), arg);
  });
  return result;
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
  const unqualified = resolved.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
  const inlineArrayArgs = typeCallArgs(unqualified, "InlineArray");
  if (inlineArrayArgs) {
    const args = splitTypeArgs(inlineArrayArgs);
    return Array.from(
      { length: Number.parseInt(args[0] ?? "0", 10) },
      () => args[1]?.trim() ?? "i32",
    );
  }
  const inlineArrayListArgs = typeCallArgs(unqualified, "InlineArrayList");
  if (inlineArrayListArgs) {
    const args = splitTypeArgs(inlineArrayListArgs);
    return Array.from(
      { length: Number.parseInt(args[0] ?? "0", 10) },
      () => args[1]?.trim() ?? "i32",
    );
  }
  const decl = layouts.types.get(typeName(resolved));
  if (decl?.normalized?.kind !== "product") return [];
  const args = typeCallArgs(resolved, typeName(resolved));
  const argValues = args ? splitTypeArgs(args) : [];
  return decl.normalized.shape.slots.flatMap((slot) => {
    const repeat = slot.repeat
      ? substituteAliasTypeParams(slot.repeat, decl, argValues)
      : undefined;
    const slotType = substituteAliasTypeParams(slot.type, decl, argValues);
    return Array.from({ length: repeat ? Number.parseInt(repeat, 10) : 1 }, () => slotType);
  });
}

function exprType(expr: Expr, functions: Map<string, FnDecl>): string | undefined {
  if (expr.kind === "borrow") {
    const type = exprType(expr.value, functions);
    return type ? `&(${stripBorrowType(type)})` : undefined;
  }
  if (expr.kind === "call" && expr.callee.kind === "var") {
    return functions.get(expr.callee.name)?.returnType;
  }
  if (expr.kind === "pipe_bind") return exprType(expr.body, functions);
  if (expr.kind === "range") return "range_i32";
  if (expr.kind === "literal") return expr.inferredType;
  return undefined;
}

function exprTypeWithLocals(expr: Expr, ctx: LowerContext): string | undefined {
  if (expr.kind === "var") return varType(expr.name, ctx);
  if (expr.kind === "borrow") {
    const type = exprTypeWithLocals(expr.value, ctx);
    return type ? `&(${stripBorrowType(type)})` : undefined;
  }
  if (expr.kind === "shape" && expr.syntax === "frozen_collection") {
    const first = expr.slots[0] ? exprTypeWithLocals(expr.slots[0].value, ctx) ?? "i32" : "i32";
    return `#(InlineArray(${expr.slots.length}, ${first}))`;
  }
  if (expr.kind === "match") {
    const types = expr.arms.map((arm) => exprTypeWithLocals(arm.value, ctx));
    const first = types[0];
    if (first && types.every((type) => type === first)) return first;
  }
  if (expr.kind === "product_constructor") {
    for (const type of ctx.layouts.types.values()) {
      if (type.normalized?.kind === "product" && type.normalized.constructor === expr.constructor) {
        return type.name;
      }
    }
  }
  return exprType(expr, ctx.functions);
}

function isPrimitiveType(type: string): boolean {
  return ["i32", "u32", "i64", "u64", "f32", "f64", "bool"].includes(type) ||
    unsignedBitWidth(type) !== undefined;
}

function unsignedBitWidth(type: string): number | undefined {
  const match = type.match(/^u([1-9][0-9]*)$/);
  if (!match) return undefined;
  const width = Number.parseInt(match[1], 10);
  return width >= 1 && width <= 64 ? width : undefined;
}

function storageLaneWidth(width: number): number {
  if (width <= 8) return 8;
  if (width <= 16) return 16;
  if (width <= 32) return 32;
  return 64;
}

function typeName(type: string): string {
  return type.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/)?.[1] ?? type;
}

function typeCallArgs(type: string, baseName: string): string | undefined {
  const prefix = `${typeName(type)}(`;
  if (!type.startsWith(prefix) || !typeName(type).endsWith(baseName) || !type.endsWith(")")) {
    return undefined;
  }
  return type.slice(prefix.length, -1);
}

function splitTypeArgs(source: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
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
      case "destructure_let":
        visit(item.value);
        for (const name of item.names) names.add(name);
        return;
      case "fork_let":
        names.add(baseName(item.source));
        for (const name of item.names) names.add(name);
        return;
      case "proof_const":
        return;
      case "var":
        names.add(baseName(item.name));
        return;
      case "borrow":
        visit(item.value);
        return;
      case "call":
        visit(item.callee);
        for (const arg of item.args) visit(arg);
        return;
      case "index":
        visit(item.target);
        visit(item.index);
        return;
      case "binary":
        visit(item.left);
        visit(item.right);
        return;
      case "pipe_bind":
        visit(item.value);
        visit(item.body);
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
      case "static_for_slots":
        visit(item.value);
        return;
      case "field":
        visit(item.value);
        visit(item.key);
        return;
      case "block":
        for (const stmt of item.statements) visit(stmt);
        visit(item.expr);
        return;
      case "literal":
      case "placeholder":
        return;
    }
  };
  visit(expr);
  return names;
}

function hasRuntimeEffect(expr: Expr, functions: Map<string, FnDecl>): boolean {
  switch (expr.kind) {
    case "borrow":
      return hasRuntimeEffect(expr.value, functions);
    case "call":
      if (
        expr.callee.kind === "var" &&
        isMemoryStoreIntrinsic(expr.callee.name, functions)
      ) return true;
      return (expr.callee.kind === "var" &&
        (functions.get(expr.callee.name)?.effects.length ?? 0) > 0) ||
        hasRuntimeEffect(expr.callee, functions) ||
        expr.args.some((arg) => hasRuntimeEffect(arg, functions));
    case "index":
      return hasRuntimeEffect(expr.target, functions) || hasRuntimeEffect(expr.index, functions);
    case "binary":
      return hasRuntimeEffect(expr.left, functions) || hasRuntimeEffect(expr.right, functions);
    case "pipe_bind":
      return hasRuntimeEffect(expr.value, functions) || hasRuntimeEffect(expr.body, functions);
    case "match":
      return hasRuntimeEffect(expr.value, functions) ||
        expr.arms.some((arm) => hasRuntimeEffect(arm.value, functions));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) => hasRuntimeEffect(slot.value, functions));
    case "range":
      return hasRuntimeEffect(expr.start, functions) || hasRuntimeEffect(expr.end, functions);
    case "static_for_slots":
      return hasRuntimeEffect(expr.value, functions);
    case "field":
      return hasRuntimeEffect(expr.value, functions) || hasRuntimeEffect(expr.key, functions);
    case "block":
      return expr.statements.some((stmt) =>
        (stmt.kind === "let" || stmt.kind === "destructure_let") &&
        hasRuntimeEffect(stmt.value, functions)
      ) ||
        (expr.expr ? hasRuntimeEffect(expr.expr, functions) : false);
    case "placeholder":
      return false;
    default:
      return false;
  }
}

function usesMemoryIntrinsic(expr: Expr | BlockExpr, functions: Map<string, FnDecl>): boolean {
  const visit = (item: Expr | Statement | undefined): boolean => {
    if (!item) return false;
    switch (item.kind) {
      case "let":
        return visit(item.value);
      case "destructure_let":
        return visit(item.value);
      case "fork_let":
      case "proof_const":
      case "literal":
      case "var":
      case "placeholder":
        return false;
      case "borrow":
        return visit(item.value);
      case "call":
        return (item.callee.kind === "var" &&
          isMemoryIntrinsic(item.callee.name, functions)) ||
          visit(item.callee) || item.args.some(visit);
      case "index":
        return visit(item.target) || visit(item.index);
      case "binary":
        return visit(item.left) || visit(item.right);
      case "pipe_bind":
        return visit(item.value) || visit(item.body);
      case "match":
        return visit(item.value) || item.arms.some((arm) => visit(arm.value));
      case "shape":
      case "product_constructor":
        return item.slots.some((slot) => visit(slot.value));
      case "range":
        return visit(item.start) || visit(item.end);
      case "static_for_slots":
        return visit(item.value);
      case "field":
        return visit(item.value) || visit(item.key);
      case "block":
        return item.statements.some(visit) || visit(item.expr);
    }
  };
  return visit(expr);
}

function isMemoryStoreIntrinsic(name: string, functions: Map<string, FnDecl>): boolean {
  const fn = functions.get(name);
  const id = fn ? intrinsicWrapperId(fn) : undefined;
  return id === "memory_store_i32" || id === "memory_store_lane4_i32";
}

function isMemoryIntrinsic(name: string, functions: Map<string, FnDecl>): boolean {
  const fn = functions.get(name);
  const id = fn ? intrinsicWrapperId(fn) : undefined;
  return id === "memory_load_i32" || id === "memory_store_i32" ||
    id === "memory_load_lane4_i32" || id === "memory_store_lane4_i32" ||
    id === "freeze";
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
    "i32.and": 0x71,
    "i32.or": 0x72,
    "i32.shl": 0x74,
    "i32.shr_u": 0x76,
    "i64.and": 0x83,
    "i64.or": 0x84,
    "i64.shl": 0x86,
    "i64.shr_u": 0x88,
    "i32.eq": 0x46,
    "i32.ne": 0x47,
    "i32.lt_s": 0x48,
    "i32.le_s": 0x4c,
    "i32.gt_s": 0x4a,
    "i32.ge_s": 0x4e,
    "i32.eqz": 0x45,
  } as Record<string, number>)[op] ?? 0x6a;
}

function simdImmediate(op: SimdOp, lane: number | undefined, lanes?: number[]): number[] {
  const opcode = ({
    "i8x16.shuffle": 0x0d,
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
  const immediates = op === "i8x16.shuffle"
    ? lanes ?? Array.from({ length: 16 }, (_, index) => index)
    : op === "i32x4.extract_lane" || op === "i32x4.replace_lane"
    ? [lane ?? 0]
    : [];
  return [0xfd, ...uleb(opcode), ...immediates];
}

function wasmLoadOp(type: ValueType): number[] {
  if (type === "v128") return [0xfd, ...uleb(0x00)];
  if (type !== "i32") throw new Error(`unsupported load type ${type}`);
  return [0x28];
}

function wasmStoreOp(type: ValueType): number[] {
  if (type === "v128") return [0xfd, ...uleb(0x0b)];
  if (type !== "i32") throw new Error(`unsupported store type ${type}`);
  return [0x36];
}

function memarg(align: number, offset: number): number[] {
  return [...uleb(Math.log2(align)), ...uleb(offset)];
}

function wasmType(wat: ValueType): number {
  if (wat === "v128") return 0x7b;
  if (wat === "i64") return 0x7e;
  if (wat === "f32") return 0x7d;
  if (wat === "f64") return 0x7c;
  return 0x7f;
}

function blockType(results: ValueType[] | undefined, typeKeys: Map<string, number>): number[] {
  if (!results?.length) return [0x40];
  if (results.length === 1) return [wasmType(results[0])];
  const key = JSON.stringify({ params: [], results: results.map(wasmType) });
  const index = typeKeys.get(key);
  if (index === undefined) throw new Error(`backend missing block signature: ${key}`);
  return sleb(index);
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
