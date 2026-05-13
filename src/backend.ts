import type {
  BlockExpr,
  BranchHint,
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
import { optimizeProgram, type OptMode } from "./optimize.ts";
import { isCatchAllPattern, patternBindingNames } from "./patterns.ts";
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
  memories: BackendMemory[];
  data: BackendData[];
  branchHints: boolean;
}

interface BackendMemory {
  name: string;
  exportName: string;
  minPages: number;
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
  | { op: "local.tee"; name: string }
  | { op: "call"; name: string }
  | { op: "return_call"; name: string }
  | { op: "select"; type: ValueType }
  | { op: "unary"; wasm: string }
  | { op: "binary"; wasm: string }
  | { op: "simd"; wasm: SimdOp; lane?: number; lanes?: number[] }
  | { op: "load"; type: ValueType; align: number; offset: number; memory?: string }
  | { op: "store"; type: ValueType; align: number; offset: number; memory?: string }
  | { op: "memory.copy"; memory?: string }
  | { op: "drop" }
  | { op: "unreachable" }
  | {
    op: "if";
    results: ValueType[];
    thenBody: Instr[];
    elseBody: Instr[];
    branchHint?: BranchHint;
  }
  | { op: "block"; body: Instr[]; results?: ValueType[] }
  | { op: "loop"; body: Instr[]; results?: ValueType[] }
  | { op: "br"; depth: number }
  | { op: "br_if"; depth: number; branchHint?: BranchHint };

type MatchArm = Extract<Expr, { kind: "match" }>["arms"][number];

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
  scratchPlansByFunction?: Map<string, Map<string, ScratchArrayPlan>>;
  packedPlansByFunction?: Map<string, Map<string, PackedArrayPlan>>;
  localSlotPlansByFunction?: Map<string, Map<string, LocalSlotArrayPlan>>;
  returnProjectionPlans?: Map<string, ReturnProjectionPlan>;
  scratchArrays?: Map<string, ScratchArrayPlan>;
  packedArrays?: Map<string, PackedArrayPlan>;
  localSlotArrays?: Map<string, LocalSlotArrayPlan>;
  tempIndex: number;
  tempLocals: BackendLocal[];
  currentFn?: FnDecl;
  localTypes?: Map<string, string>;
  tailCallMode?: TailCallMode;
  memoryModel: MemoryModel;
  optMode?: OptMode;
  inlineStack?: Set<string>;
  deadProductBases?: Set<string>;
  fixedArrayTransformerAliases?: Map<string, Expr>;
  nextDataOffset?: number;
}

interface ScratchArrayPlan {
  name: string;
  capacity: number;
  itemType: string;
  valueType: ValueType;
  byteSize: number;
  align: number;
  offset: number;
}

interface PackedArrayPlan {
  name: string;
  capacity: number;
  itemType: string;
  valueType: ValueType;
  packedType: ValueType;
  bitWidth: number;
}

interface LocalSlotArrayPlan {
  name: string;
  capacity: number;
  itemType: string;
  valueType: ValueType;
}

interface ReturnProjectionPlan {
  type: string;
  suffixes: string[];
}

interface LayoutEnv {
  types: Map<string, TypeDecl>;
  constShapes: Map<string, Extract<Expr, { kind: "shape" }>>;
}

export type TailCallMode = "opcode";
export type MemoryModel = "temporal" | "branch-debug" | "branch";

export interface BackendOptions {
  tailCallMode?: TailCallMode;
  memoryModel?: MemoryModel;
  optMode?: OptMode;
  branchHints?: boolean;
}

const EXPLICIT_MEMORY: BackendMemory = {
  name: "memory",
  exportName: "memory",
  minPages: 1,
};

const TEMPORAL_MEMORIES: BackendMemory[] = [
  { name: "fig_objects", exportName: "fig_objects", minPages: 1 },
  { name: "fig_logs", exportName: "fig_logs", minPages: 1 },
  { name: "fig_buffers", exportName: "fig_buffers", minPages: 1 },
];

const BRANCH_MEMORIES: BackendMemory[] = [
  { name: "fig_objects", exportName: "fig_objects", minPages: 1 },
  { name: "fig_buffers", exportName: "fig_buffers", minPages: 1 },
];

export function emitWat(program: Program, options: BackendOptions = {}): string {
  return backendModuleToWat(lowerBackendModule(program, options));
}

export function emitWasm(
  program: Program,
  options: BackendOptions = {},
): Uint8Array<ArrayBuffer> {
  return backendModuleToWasm(lowerBackendModule(program, options), {
    debugNames: (options.optMode ?? "debug") === "debug",
  });
}

function lowerBackendModule(program: Program, options: BackendOptions = {}): BackendModule {
  const memoryModel = options.memoryModel ?? "branch";
  if (!isMemoryModel(memoryModel)) {
    throw new CompileError([{
      code: "backend.memory_model",
      message: `unknown memory model ${memoryModel}`,
    }]);
  }
  const optMode = options.optMode ?? "debug";
  const optimized = optimizeProgram(program, { optMode });
  const layouts = createLayoutEnv(optimized);
  const imports = optimized.imports.map((item) => importAsFn(item));
  const runtimeFns = optimized.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && !decl.primitiveId && !isIntrinsicWrapper(decl) &&
    !decl.params.some((param) => param.const) &&
    Boolean(decl.returnType)
  );
  const sourceFns = optimized.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && Boolean(decl.returnType)
  );
  const returnProjectionPlans = privateReturnProjectionPlans(runtimeFns, layouts);
  const projectedRuntimeFns = runtimeFns.map((fn) => {
    const plan = returnProjectionPlans.get(fn.name);
    return plan ? { ...fn, returnType: plan.type } : fn;
  });
  const baseCtx: LowerContext = {
    layouts,
    functions: new Map([...imports, ...sourceFns, ...projectedRuntimeFns].map((fn) => [
      fn.name,
      fn,
    ])),
    signatures: new Map([...imports, ...projectedRuntimeFns].map((fn) => [fn.name, fn])),
    intrinsicIdsByName: intrinsicIdsByFunctionName(optimized.declarations),
    returnProjectionPlans,
    tempIndex: 0,
    tempLocals: [],
    tailCallMode: options.tailCallMode,
    memoryModel,
    optMode,
    inlineStack: new Set(),
    fixedArrayTransformerAliases: new Map(),
    nextDataOffset: 1024,
  };
  const reachableProjectedFns = removeUnreachablePrivateFunctions(projectedRuntimeFns);
  const functions = addOptimizedExportClones(
    reachableProjectedFns,
    (fn) => scratchWorthyFixedArrayTargets(fn.body, baseCtx).size > 0,
  );
  const signatures = new Map([...imports, ...functions].map((fn) => [fn.name, fn]));
  const ctx: LowerContext = {
    ...baseCtx,
    functions: new Map([...imports, ...sourceFns, ...functions].map((fn) => [fn.name, fn])),
    signatures,
  };
  const fixedArrayPlans = analyzeFixedArrayPlans(functions, ctx);
  ctx.scratchPlansByFunction = fixedArrayPlans.scratch;
  ctx.packedPlansByFunction = fixedArrayPlans.packed;
  ctx.localSlotPlansByFunction = fixedArrayPlans.localSlots;

  const loweredFunctions = functions.map((fn) => lowerFunction(fn, ctx));
  const needsScratchMemory = [...ctx.scratchPlansByFunction.values()].some((plans) =>
    plans.size > 0
  );
  const needsTemporalMemory = functions.some((fn) => usesTemporalIntrinsic(fn.body, ctx.functions));
  const needsBranchMemory = memoryModel !== "temporal" &&
    functions.some((fn) => usesBranchIntrinsic(fn.body, ctx.functions));
  if (memoryModel !== "temporal" && needsTemporalMemory) {
    throw new CompileError([{
      code: "backend.temporal_in_branch_mode",
      message: `temporal intrinsics are only available with --memory temporal`,
    }]);
  }
  return {
    imports: imports.map((fn) => ({
      name: fn.name,
      params: fn.params.flatMap((param) =>
        flattenType(param.type, layouts).map((slot) => slot.wat)
      ),
      results: flattenType(fn.returnType, layouts).map((slot) => slot.wat),
    })),
    functions: removeUnreachableBackendFunctions(loweredFunctions),
    memories: backendMemories(
      memoryModel,
      needsTemporalMemory,
      needsBranchMemory,
      needsScratchMemory,
    ),
    data: [],
    branchHints: options.branchHints ?? optMode === "release",
  };
}

function backendMemories(
  memoryModel: MemoryModel,
  needsTemporalMemory: boolean,
  needsBranchMemory: boolean,
  needsScratchMemory: boolean,
): BackendMemory[] {
  if (memoryModel === "temporal") {
    if (needsTemporalMemory) return TEMPORAL_MEMORIES;
    return needsScratchMemory ? [TEMPORAL_MEMORIES[2]!] : [];
  }
  if (needsBranchMemory) return BRANCH_MEMORIES;
  return needsScratchMemory ? [BRANCH_MEMORIES[1]!] : [];
}

function isMemoryModel(value: string): value is MemoryModel {
  return value === "temporal" || value === "branch-debug" || value === "branch";
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
    scratchArrays: ctx.scratchPlansByFunction?.get(fn.name),
    packedArrays: ctx.packedPlansByFunction?.get(fn.name),
    localSlotArrays: ctx.localSlotPlansByFunction?.get(fn.name),
    fixedArrayTransformerAliases: new Map(),
  };
  for (const plan of fnCtx.packedArrays?.values() ?? []) {
    fnCtx.tempLocals.push({ name: packedArrayLocalName(plan.name), type: plan.packedType });
    localNames.add(packedArrayLocalName(plan.name));
  }
  const laneParamVectors = materializedLane4I32Params(fn, fnCtx);
  for (const name of laneParamVectors) {
    fnCtx.tempLocals.push({ name, type: "v128" });
    localNames.add(name);
  }
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
  const inlineArrayLoopBody = lowerInlineArrayLoopFunction(fn, fnCtx, localNames);
  const loweredBody = inlineArrayLoopBody ??
    (ctx.tailCallMode === "opcode" && tailCalls.hasOnlyTailDirectSelfCalls
      ? lowerTailOpcodeBlock(fn.body, fn, fnCtx, localNames)
      : tailCalls.hasOnlyTailDirectSelfCalls
      ? lowerTailLoopBlock(fn.body, fn, fnCtx, localNames)
      : lowerBlock(fn.body, fnCtx, localNames, fn.returnType));
  const prologue = laneParamVectors.flatMap((name): Instr[] => [
    ...packProjectedLane4I32FromScalars(name),
    { op: "local.set", name },
  ]);
  const scratchPrologue = [...(fnCtx.scratchArrays?.values() ?? [])].flatMap((plan) =>
    lowerScratchArrayInit(plan)
  );
  const packedPrologue = [...(fnCtx.packedArrays?.values() ?? [])].flatMap((plan) =>
    lowerPackedArrayInit(plan)
  );
  const body = cleanupInstrs([...prologue, ...scratchPrologue, ...packedPrologue, ...loweredBody]);
  const bodyLocals = instrLocalNames(body);
  const useCounts = instrLocalUseCounts(body);
  const locals = uniqueBackendLocals(
    [...collectIrLocals(fn.body, fnCtx), ...fnCtx.tempLocals].filter((local) =>
      (!paramNames.has(local.name) && bodyLocals.has(local.name)) ||
      local.name.startsWith("__simd_tmp") ||
      local.name.startsWith("__tail_tmp") ||
      local.name.startsWith("__slot_tmp")
    ),
  ).map((local, index) => ({ local, index })).toSorted((a, b) =>
    (useCounts.get(b.local.name) ?? 0) - (useCounts.get(a.local.name) ?? 0) ||
    a.index - b.index
  ).map((item) => item.local);
  return {
    name: fn.name,
    exportName: fn.public ? fn.name : undefined,
    params,
    results: flattenType(fn.returnType, ctx.layouts).map((slot) => slot.wat),
    locals,
    body,
  };
}

function materializedLane4I32Params(fn: FnDecl, ctx: LowerContext): string[] {
  const counts = dot4LaneUseCounts(fn.body);
  return fn.params
    .filter((param) => isLane4I32(param.type, ctx.layouts) && (counts.get(param.name) ?? 0) > 1)
    .map((param) => param.name);
}

function addOptimizedExportClones(
  functions: FnDecl[],
  shouldClone: (fn: FnDecl) => boolean,
): FnDecl[] {
  const used = new Set(functions.map((fn) => fn.name));
  return functions.flatMap((fn) => {
    if (!fn.public || !shouldClone(fn)) return [fn];
    const cloneName = uniqueGeneratedFnName(`${fn.name}__optimized`, used);
    const clone: FnDecl = {
      ...fn,
      public: false,
      name: cloneName,
      generated: true,
    };
    const wrapper: FnDecl = {
      ...fn,
      body: {
        kind: "block",
        statements: [],
        expr: {
          kind: "call",
          callee: { kind: "var", name: cloneName },
          args: fn.params.map((param) => ({ kind: "var", name: param.name } as Expr)),
        },
      },
    };
    return [wrapper, clone];
  });
}

function uniqueGeneratedFnName(base: string, used: Set<string>): string {
  let name = base;
  let index = 0;
  while (used.has(name)) name = `${base}_${++index}`;
  used.add(name);
  return name;
}

function analyzeFixedArrayPlans(
  functions: FnDecl[],
  ctx: LowerContext,
): {
  scratch: Map<string, Map<string, ScratchArrayPlan>>;
  packed: Map<string, Map<string, PackedArrayPlan>>;
  localSlots: Map<string, Map<string, LocalSlotArrayPlan>>;
} {
  const scratchByFunction = new Map<string, Map<string, ScratchArrayPlan>>();
  const packedByFunction = new Map<string, Map<string, PackedArrayPlan>>();
  const localSlotByFunction = new Map<string, Map<string, LocalSlotArrayPlan>>();
  let nextOffset = 4096;
  const addPlan = (
    fn: FnDecl,
    scratchPlans: Map<string, ScratchArrayPlan>,
    packedPlans: Map<string, PackedArrayPlan>,
    localSlotPlans: Map<string, LocalSlotArrayPlan>,
    target: string,
    type: string | undefined,
  ): boolean => {
    if (scratchPlans.has(target) || packedPlans.has(target) || localSlotPlans.has(target)) {
      return false;
    }
    const args = inlineArrayLikeTypeArgs(type, ctx.layouts);
    if (!args) return false;
    const [capacity, itemType] = args;
    const localSlot = localSlotArrayPlan(target, capacity, itemType, ctx.layouts);
    if (localSlot && shouldPreferLocalSlotArray(fn, target, ctx)) {
      localSlotPlans.set(target, localSlot);
      localSlotByFunction.set(fn.name, localSlotPlans);
      return true;
    }
    const packed = packedArrayPlan(target, capacity, itemType, ctx.layouts);
    if (packed) {
      packedPlans.set(target, packed);
      packedByFunction.set(fn.name, packedPlans);
      return true;
    }
    const itemSlots = flattenType(itemType, ctx.layouts);
    const valueType = itemSlots[0]?.wat;
    if (
      !Number.isFinite(capacity) || capacity <= 0 || itemSlots.length !== 1 ||
      !isSelectableValueType(valueType)
    ) return false;
    const byteSize = valueTypeByteSize(valueType);
    const plan: ScratchArrayPlan = {
      name: target,
      capacity,
      itemType,
      valueType,
      byteSize,
      align: byteSize,
      offset: nextOffset,
    };
    nextOffset += capacity * byteSize;
    scratchPlans.set(target, plan);
    scratchByFunction.set(fn.name, scratchPlans);
    return true;
  };
  for (const fn of functions) {
    const scratchPlans = new Map<string, ScratchArrayPlan>();
    const packedPlans = new Map<string, PackedArrayPlan>();
    const localSlotPlans = new Map<string, LocalSlotArrayPlan>();
    if (fn.public) {
      scratchByFunction.set(fn.name, scratchPlans);
      packedByFunction.set(fn.name, packedPlans);
      localSlotByFunction.set(fn.name, localSlotPlans);
      continue;
    }
    const scratchTargets = scratchWorthyFixedArrayTargets(fn.body, ctx);
    for (const param of fn.params) {
      if (scratchTargets.has(param.name)) {
        addPlan(fn, scratchPlans, packedPlans, localSlotPlans, param.name, param.type);
      }
    }
    for (const target of scratchTargets) {
      if (
        !fn.params.some((param) => target === param.name || target.startsWith(`${param.name}.`))
      ) {
        continue;
      }
      addPlan(
        fn,
        scratchPlans,
        packedPlans,
        localSlotPlans,
        target,
        varTypeWithParamTypes(target, fn, ctx),
      );
    }
    scratchByFunction.set(fn.name, scratchPlans);
    packedByFunction.set(fn.name, packedPlans);
    localSlotByFunction.set(fn.name, localSlotPlans);
  }
  let transformedChanged = true;
  while (transformedChanged) {
    transformedChanged = false;
    for (const fn of functions) {
      if (fn.public) continue;
      const scratchPlans = scratchByFunction.get(fn.name) ?? new Map<string, ScratchArrayPlan>();
      const packedPlans = packedByFunction.get(fn.name) ?? new Map<string, PackedArrayPlan>();
      const localSlotPlans = localSlotByFunction.get(fn.name) ??
        new Map<string, LocalSlotArrayPlan>();
      for (
        const target of tailTransformedFixedArrayTargets(
          fn,
          ctx,
          scratchByFunction,
          packedByFunction,
          localSlotByFunction,
        )
      ) {
        if (
          addPlan(
            fn,
            scratchPlans,
            packedPlans,
            localSlotPlans,
            target.name,
            target.type,
          )
        ) transformedChanged = true;
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const caller of functions) {
      const callerScratchPlans = scratchByFunction.get(caller.name);
      const callerPackedPlans = packedByFunction.get(caller.name);
      const callerLocalSlotPlans = localSlotByFunction.get(caller.name);
      if (!callerScratchPlans?.size && !callerPackedPlans?.size && !callerLocalSlotPlans?.size) {
        continue;
      }
      for (const call of privateCallsInBlock(caller.body, ctx)) {
        if (call.callee.kind !== "var") continue;
        const callee = ctx.functions.get(call.callee.name);
        if (!callee || callee.public) continue;
        const dynamicReads = dynamicFixedArrayReadTargets(callee.body);
        if (!dynamicReads.size) continue;
        const calleeScratchPlans = scratchByFunction.get(callee.name) ??
          new Map<string, ScratchArrayPlan>();
        const calleePackedPlans = packedByFunction.get(callee.name) ??
          new Map<string, PackedArrayPlan>();
        const calleeLocalSlotPlans = localSlotByFunction.get(callee.name) ??
          new Map<string, LocalSlotArrayPlan>();
        const argOffset = Math.max(0, call.args.length - callee.params.length);
        for (const [index, param] of callee.params.entries()) {
          const arg = call.args[index + argOffset];
          if (
            !dynamicReads.has(param.name) ||
            calleeScratchPlans.has(param.name) ||
            calleePackedPlans.has(param.name) ||
            calleeLocalSlotPlans.has(param.name)
          ) continue;
          if (
            !arg ||
            !backedFixedArrayExpr(
              arg,
              callerScratchPlans,
              callerPackedPlans,
              callerLocalSlotPlans,
              ctx,
            )
          ) continue;
          if (
            addPlan(
              callee,
              calleeScratchPlans,
              calleePackedPlans,
              calleeLocalSlotPlans,
              param.name,
              param.type,
            )
          ) changed = true;
        }
      }
    }
  }
  return { scratch: scratchByFunction, packed: packedByFunction, localSlots: localSlotByFunction };
}

function tailTransformedFixedArrayTargets(
  fn: FnDecl,
  ctx: LowerContext,
  scratchByFunction: Map<string, Map<string, ScratchArrayPlan>>,
  packedByFunction: Map<string, Map<string, PackedArrayPlan>>,
  localSlotByFunction: Map<string, Map<string, LocalSlotArrayPlan>>,
): Param[] {
  if (!analyzeTailCalls(fn).hasOnlyTailDirectSelfCalls) return [];
  const found: Param[] = [];
  const visit = (expr: Expr | undefined) => {
    if (!expr) return;
    if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === fn.name) {
      const argOffset = Math.max(0, expr.args.length - fn.params.length);
      const runtimeArgs = expr.args.slice(argOffset);
      for (const [index, param] of fn.params.entries()) {
        const arg = runtimeArgs[index];
        const transformed = fixedArrayTransformerCall(arg, param, ctx);
        if (
          transformed &&
          transformerHasFixedArrayPlan(
            transformed.callee,
            ctx,
            scratchByFunction,
            packedByFunction,
            localSlotByFunction,
          )
        ) {
          found.push(param);
          continue;
        }
        if (arg?.kind !== "product_constructor" && arg?.kind !== "shape") continue;
        const fields = productFieldTypes(param.type, ctx.layouts);
        if (!fields) continue;
        const fieldTypes = new Map(fields.map((field) => [field.label, field.type]));
        for (const slot of arg.slots) {
          if (!slot.label) continue;
          const fieldType = fieldTypes.get(slot.label);
          if (!fieldType) continue;
          const target = `${param.name}.${slot.label}`;
          const fieldParam = { ...param, name: target, type: fieldType };
          const fieldTransformed = fixedArrayTransformerCall(slot.value, fieldParam, ctx);
          if (
            fieldTransformed &&
            transformerHasFixedArrayPlan(
              fieldTransformed.callee,
              ctx,
              scratchByFunction,
              packedByFunction,
              localSlotByFunction,
            )
          ) {
            found.push(fieldParam);
          }
        }
      }
      return;
    }
    for (const child of exprChildren(expr)) visit(child);
  };
  visit(fn.body.expr);
  for (const stmt of fn.body.statements) {
    if (stmt.kind !== "proof_const") visit(stmt.value);
  }
  return found;
}

function fixedArrayTransformerCall(
  expr: Expr | undefined,
  targetParam: Param,
  ctx: LowerContext,
): { call: Extract<Expr, { kind: "call" }>; callee: FnDecl } | undefined {
  if (expr?.kind !== "call" || expr.callee.kind !== "var") return undefined;
  const callee = ctx.functions.get(expr.callee.name);
  if (!callee || callee.public || !callee.returnType || callee.params.length === 0) {
    return undefined;
  }
  if (callee.params.some((param) => param.const)) return undefined;
  if (hasRuntimeEffect(callee.body, ctx.functions)) return undefined;
  if (
    !analyzeTailCalls(callee).hasOnlyTailDirectSelfCalls &&
    !fixedArrayTransformerForwardingExpr(callee.body, callee.params[0], ctx)
  ) {
    return undefined;
  }
  if (!sameInlineArrayType(targetParam.type, callee.returnType, ctx.layouts)) return undefined;
  if (!sameInlineArrayType(targetParam.type, callee.params[0]?.type, ctx.layouts)) {
    return undefined;
  }
  const argOffset = Math.max(0, expr.args.length - callee.params.length);
  const runtimeArgs = expr.args.slice(argOffset);
  const source = runtimeArgs[0];
  if (source?.kind !== "var" || !sameStorageName(source.name, targetParam.name)) {
    return undefined;
  }
  return { call: expr, callee };
}

function fixedArrayTransformerForwardingExpr(
  body: BlockExpr,
  backedParam: Param | undefined,
  ctx: LowerContext,
): Extract<Expr, { kind: "call" }> | undefined {
  if (!backedParam || body.expr?.kind !== "call" || body.expr.callee.kind !== "var") {
    return undefined;
  }
  const callee = ctx.functions.get(body.expr.callee.name);
  if (!callee?.returnType) return undefined;
  const argOffset = Math.max(0, body.expr.args.length - callee.params.length);
  const runtimeArgs = body.expr.args.slice(argOffset);
  const source = runtimeArgs[0];
  if (source?.kind !== "var" || !sameStorageName(source.name, backedParam.name)) {
    return undefined;
  }
  if (!sameInlineArrayType(backedParam.type, callee.returnType, ctx.layouts)) return undefined;
  if (!sameInlineArrayType(backedParam.type, callee.params[0]?.type, ctx.layouts)) {
    return undefined;
  }
  return fixedArrayTransformerCall(body.expr, backedParam, ctx) ? body.expr : undefined;
}

function hasFixedArrayPlan(
  fnName: string,
  target: string,
  scratchByFunction: Map<string, Map<string, ScratchArrayPlan>>,
  packedByFunction: Map<string, Map<string, PackedArrayPlan>>,
  localSlotByFunction: Map<string, Map<string, LocalSlotArrayPlan>>,
): boolean {
  return Boolean(
    scratchByFunction.get(fnName)?.has(target) ||
      packedByFunction.get(fnName)?.has(target) ||
      localSlotByFunction.get(fnName)?.has(target),
  );
}

function transformerHasFixedArrayPlan(
  fn: FnDecl,
  ctx: LowerContext,
  scratchByFunction: Map<string, Map<string, ScratchArrayPlan>>,
  packedByFunction: Map<string, Map<string, PackedArrayPlan>>,
  localSlotByFunction: Map<string, Map<string, LocalSlotArrayPlan>>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(fn.name)) return false;
  seen.add(fn.name);
  const firstParam = fn.params[0];
  if (
    firstParam &&
    hasFixedArrayPlan(
      fn.name,
      firstParam.name,
      scratchByFunction,
      packedByFunction,
      localSlotByFunction,
    )
  ) return true;
  const forwarded = fixedArrayTransformerForwardingExpr(fn.body, firstParam, ctx);
  if (!forwarded || forwarded.callee.kind !== "var") return false;
  const callee = ctx.functions.get(forwarded.callee.name);
  return callee
    ? transformerHasFixedArrayPlan(
      callee,
      ctx,
      scratchByFunction,
      packedByFunction,
      localSlotByFunction,
      seen,
    )
    : false;
}

function scratchWorthyFixedArrayTargets(block: BlockExpr, ctx: LowerContext): Set<string> {
  const targets = new Set<string>();
  const visit = (expr: Expr) => {
    const update = fixedArrayUpdateCall(expr, ctx);
    if (update && staticIntegerLiteral(update.index) === undefined) targets.add(update.source.name);
    const swap = fixedArraySwapCall(expr, ctx);
    if (swap) targets.add(swap.source.name);
    const spreadUpdate = fixedArraySpreadUpdateExpr(expr);
    if (spreadUpdate && staticIntegerLiteral(spreadUpdate.index) === undefined) {
      targets.add(spreadUpdate.source.name);
    }
    switch (expr.kind) {
      case "block":
        for (const stmt of expr.statements) visitStatement(stmt);
        if (expr.expr) visit(expr.expr);
        return;
      case "call":
        visit(expr.callee);
        for (const arg of expr.args) visit(arg);
        return;
      case "index":
        visit(expr.target);
        visit(expr.index);
        return;
      case "binary":
        visit(expr.left);
        visit(expr.right);
        return;
      case "pipe_bind":
        visit(expr.value);
        visit(expr.body);
        return;
      case "match":
        visit(expr.value);
        for (const arm of expr.arms) visit(arm.value);
        return;
      case "shape":
      case "product_constructor":
        for (const slot of expr.slots) {
          if (slot.index) visit(slot.index);
          visit(slot.value);
        }
        return;
      case "field":
        visit(expr.value);
        visit(expr.key);
        return;
      case "range":
        visit(expr.start);
        visit(expr.end);
        return;
      case "static_for_slots":
        visit(expr.value);
        return;
      case "literal":
      case "placeholder":
      case "var":
        return;
    }
  };
  const visitStatement = (stmt: Statement) => {
    if (stmt.kind === "let" || stmt.kind === "destructure_let") visit(stmt.value);
  };
  for (const stmt of block.statements) visitStatement(stmt);
  if (block.expr) visit(block.expr);
  return targets;
}

function shouldPreferLocalSlotArray(fn: FnDecl, target: string, ctx: LowerContext): boolean {
  if (ctx.optMode !== "release") return false;
  if (!hasSelfCall(fn.body, fn.name)) return false;
  const type = varTypeWithParamTypes(target, fn, ctx) ??
    fn.params.find((param) => param.name === target)?.type;
  const args = inlineArrayLikeTypeArgs(type, ctx.layouts);
  if (!args) return false;
  const [capacity, itemType] = args;
  const plan = localSlotArrayPlan(target, capacity, itemType, ctx.layouts);
  if (!plan || capacity > 16) return false;
  return !packedArrayPlan(target, capacity, itemType, ctx.layouts);
}

function fixedArraySpreadUpdateExpr(
  expr: Expr,
): { source: Extract<Expr, { kind: "var" }>; index: Expr } | undefined {
  if (expr.kind !== "shape" && expr.kind !== "product_constructor") return undefined;
  const source = expr.slots.find((slot) => slot.spread)?.value;
  if (source?.kind !== "var") return undefined;
  const override = expr.slots.find((slot) => slot.index);
  if (!override?.index) return undefined;
  return { source, index: override.index };
}

function dynamicFixedArrayReadTargets(block: BlockExpr): Set<string> {
  const targets = new Set<string>();
  const visit = (expr: Expr) => {
    if (
      expr.kind === "index" && expr.target.kind === "var" &&
      staticIntegerLiteral(expr.index) === undefined
    ) {
      targets.add(expr.target.name);
    }
    switch (expr.kind) {
      case "block":
        for (const stmt of expr.statements) visitStatement(stmt);
        if (expr.expr) visit(expr.expr);
        return;
      case "call":
        visit(expr.callee);
        for (const arg of expr.args) visit(arg);
        return;
      case "index":
        visit(expr.target);
        visit(expr.index);
        return;
      case "binary":
        visit(expr.left);
        visit(expr.right);
        return;
      case "pipe_bind":
        visit(expr.value);
        visit(expr.body);
        return;
      case "match":
        visit(expr.value);
        for (const arm of expr.arms) visit(arm.value);
        return;
      case "shape":
      case "product_constructor":
        for (const slot of expr.slots) {
          if (slot.index) visit(slot.index);
          visit(slot.value);
        }
        return;
      case "field":
        visit(expr.value);
        visit(expr.key);
        return;
      case "range":
        visit(expr.start);
        visit(expr.end);
        return;
      case "static_for_slots":
        visit(expr.value);
        return;
      case "literal":
      case "placeholder":
      case "var":
        return;
    }
  };
  const visitStatement = (stmt: Statement) => {
    if (stmt.kind === "let" || stmt.kind === "destructure_let") visit(stmt.value);
  };
  for (const stmt of block.statements) visitStatement(stmt);
  if (block.expr) visit(block.expr);
  return targets;
}

function privateCallsInBlock(
  block: BlockExpr,
  ctx: LowerContext,
): Extract<Expr, { kind: "call" }>[] {
  const calls: Extract<Expr, { kind: "call" }>[] = [];
  const visit = (expr: Expr) => {
    if (expr.kind === "call" && expr.callee.kind === "var") {
      const fn = ctx.functions.get(expr.callee.name);
      if (fn && !fn.public) calls.push(expr);
    }
    switch (expr.kind) {
      case "block":
        for (const stmt of expr.statements) visitStatement(stmt);
        if (expr.expr) visit(expr.expr);
        return;
      case "call":
        visit(expr.callee);
        for (const arg of expr.args) visit(arg);
        return;
      case "index":
        visit(expr.target);
        visit(expr.index);
        return;
      case "binary":
        visit(expr.left);
        visit(expr.right);
        return;
      case "pipe_bind":
        visit(expr.value);
        visit(expr.body);
        return;
      case "match":
        visit(expr.value);
        for (const arm of expr.arms) visit(arm.value);
        return;
      case "shape":
      case "product_constructor":
        for (const slot of expr.slots) {
          if (slot.index) visit(slot.index);
          visit(slot.value);
        }
        return;
      case "field":
        visit(expr.value);
        visit(expr.key);
        return;
      case "range":
        visit(expr.start);
        visit(expr.end);
        return;
      case "static_for_slots":
        visit(expr.value);
        return;
      case "literal":
      case "placeholder":
      case "var":
        return;
    }
  };
  const visitStatement = (stmt: Statement) => {
    if (stmt.kind === "let" || stmt.kind === "destructure_let") visit(stmt.value);
  };
  for (const stmt of block.statements) visitStatement(stmt);
  if (block.expr) visit(block.expr);
  return calls;
}

function backedFixedArrayExpr(
  expr: Expr,
  scratchPlans: Map<string, ScratchArrayPlan> | undefined,
  packedPlans: Map<string, PackedArrayPlan> | undefined,
  localSlotPlans: Map<string, LocalSlotArrayPlan> | undefined,
  ctx: LowerContext,
): boolean {
  if (expr.kind === "var") {
    return Boolean(
      scratchPlanForName(expr.name, scratchPlans) ??
        packedPlanForName(expr.name, packedPlans) ??
        localSlotPlanForName(expr.name, localSlotPlans),
    );
  }
  const update = fixedArrayUpdateCall(expr, ctx);
  if (update) {
    return Boolean(
      scratchPlanForName(update.source.name, scratchPlans) ??
        packedPlanForName(update.source.name, packedPlans) ??
        localSlotPlanForName(update.source.name, localSlotPlans),
    );
  }
  return false;
}

function varTypeWithParamTypes(name: string, fn: FnDecl, ctx: LowerContext): string | undefined {
  const previous = ctx.localTypes;
  ctx.localTypes = new Map(fn.params.map((param) => [param.name, param.type]));
  const type = varType(name, ctx);
  ctx.localTypes = previous;
  return type;
}

function dot4LaneUseCounts(block: BlockExpr): Map<string, number> {
  const counts = new Map<string, number>();
  const countBase = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  const visit = (item: Expr | Statement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "let":
      case "destructure_let":
        visit(item.value);
        return;
      case "proof_const":
      case "literal":
      case "var":
      case "placeholder":
        return;
      case "binary": {
        const dot = dot4I32Pattern(item);
        if (dot) {
          countBase(dot.left);
          countBase(dot.right);
        }
        visit(item.left);
        visit(item.right);
        return;
      }
      case "call":
        visit(item.callee);
        for (const arg of item.args) visit(arg);
        return;
      case "index":
        visit(item.target);
        visit(item.index);
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
    }
  };
  visit(block);
  return counts;
}

interface InlineArrayLoopPlan {
  capacity: number;
  itemType: string;
  indexName: string;
  value: Expr;
  aliases: Map<string, Expr>;
}

function lowerInlineArrayLoopFunction(
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const plan = inlineArrayLoopPlan(fn, ctx);
  if (!plan) return undefined;
  const substitutions = new Map<string, Expr>();
  for (const param of fn.params) {
    substitutions.set(param.name, { kind: "var", name: param.name });
  }
  return lowerInlineArrayLoopPlan(plan, substitutions, ctx, locals);
}

function lowerInlineArrayHelperCall(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  _expectedType?: string,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const fn = ctx.functions.get(expr.callee.name);
  if (!fn) return undefined;
  const fixedUpdate = fixedArrayUpdateCall(expr, ctx);
  const localSlotUpdate = fixedUpdate
    ? localSlotPlanForName(fixedUpdate.source.name, ctx.localSlotArrays)
    : undefined;
  if (fixedUpdate && localSlotUpdate) {
    return [
      ...lowerLocalSlotArrayUpdateStore(localSlotUpdate, fixedUpdate, ctx, locals),
      ...lowerLocalSlotArrayMaterialize(localSlotUpdate, ctx, locals),
    ];
  }
  const packedUpdate = fixedUpdate
    ? packedPlanForName(fixedUpdate.source.name, ctx.packedArrays)
    : undefined;
  if (fixedUpdate && packedUpdate) {
    return [
      ...lowerPackedArrayUpdateStore(packedUpdate, fixedUpdate, ctx, locals),
      ...lowerPackedArrayMaterialize(packedUpdate, ctx, locals),
    ];
  }
  const scratchUpdate = fixedUpdate
    ? scratchPlanForName(fixedUpdate.source.name, ctx.scratchArrays)
    : undefined;
  if (fixedUpdate && scratchUpdate) {
    return [
      ...lowerScratchArrayUpdate(scratchUpdate, fixedUpdate, ctx, locals),
      ...lowerScratchArrayMaterialize(scratchUpdate, ctx, locals),
    ];
  }
  if (fixedUpdate && isSpeculableNonTrappingExpr(fixedUpdate.value, ctx.functions)) {
    return lowerScalarFixedCollectionUpdate(
      { value: fixedUpdate.source, spread: true },
      [{ value: fixedUpdate.value, index: fixedUpdate.index }],
      fixedUpdate.capacity,
      fixedUpdate.itemType,
      flattenType(fixedUpdate.itemType, ctx.layouts),
      ctx,
      locals,
    );
  }
  const loopPlan = inlineArrayLoopPlan(fn, ctx);
  if (loopPlan) {
    return lowerInlineArrayLoopCall(fn, expr.args, loopPlan, ctx, locals);
  }
  const wrapperCall = inlineArrayLoopWrapperCall(fn);
  if (!wrapperCall || wrapperCall.callee.kind !== "var") return undefined;
  const wrapperSubstitutions = new Map<string, Expr>();
  const argOffset = Math.max(0, expr.args.length - fn.params.length);
  fn.params.forEach((param, index) => {
    const arg = expr.args[index + argOffset];
    if (arg) wrapperSubstitutions.set(param.name, arg);
  });
  const loweredCall = substituteExpr(wrapperCall, wrapperSubstitutions);
  if (loweredCall.kind !== "call" || loweredCall.callee.kind !== "var") return undefined;
  const loopFn = ctx.functions.get(loweredCall.callee.name);
  const nestedPlan = loopFn ? inlineArrayLoopPlan(loopFn, ctx) : undefined;
  return loopFn && nestedPlan
    ? lowerInlineArrayLoopCall(loopFn, loweredCall.args, nestedPlan, ctx, locals)
    : undefined;
}

function lowerInlineArrayLoopCall(
  fn: FnDecl,
  args: Expr[],
  plan: InlineArrayLoopPlan,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const substitutions = new Map<string, Expr>();
  const argOffset = Math.max(0, args.length - fn.params.length);
  fn.params.forEach((param, index) => {
    const arg = args[index + argOffset];
    if (arg) substitutions.set(param.name, arg);
  });
  return lowerInlineArrayLoopPlan(plan, substitutions, ctx, locals);
}

function lowerInlineArrayLoopPlan(
  plan: InlineArrayLoopPlan,
  baseSubstitutions: Map<string, Expr>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const substitutions = resolvedInlineArrayLoopSubstitutions(plan, baseSubstitutions);
  const itemSlots = flattenType(plan.itemType, ctx.layouts);
  return Array.from(
    { length: plan.capacity },
    (_, item) =>
      itemSlots.flatMap((_slot, slotIndex) => {
        const itemSubstitutions = new Map(substitutions);
        itemSubstitutions.set(plan.indexName, staticIndexExpr(item));
        const value = substituteExpr(plan.value, itemSubstitutions);
        ensureLoweringLocals(value, ctx, locals);
        return lowerFlattenedValueSlot(value, plan.itemType, slotIndex, ctx, locals);
      }),
  ).flat();
}

function resolvedInlineArrayLoopSubstitutions(
  plan: InlineArrayLoopPlan,
  baseSubstitutions: Map<string, Expr>,
): Map<string, Expr> {
  const substitutions = new Map(baseSubstitutions);
  for (const [name, value] of plan.aliases) {
    substitutions.set(name, substituteExpr(value, substitutions));
  }
  return substitutions;
}

function inlineArrayLoopWrapperCall(fn: FnDecl): Extract<Expr, { kind: "call" }> | undefined {
  if (fn.body.statements.length !== 0) return undefined;
  const expr = fn.body.expr;
  if (!expr || expr.kind !== "call" || expr.callee.kind !== "var") return undefined;
  return isInlineArrayLoopName(expr.callee.name) ? expr : undefined;
}

function inlineArrayLoopPlan(fn: FnDecl, ctx: LowerContext): InlineArrayLoopPlan | undefined {
  if (!isInlineArrayLoopName(fn.name)) return undefined;
  const [capacity, itemType] = inlineArrayLikeTypeArgs(fn.returnType, ctx.layouts) ?? [];
  if (!capacity || !Number.isFinite(capacity) || !itemType) return undefined;
  const expr = fn.body.expr;
  if (!expr || expr.kind !== "match") return undefined;
  const aliases = new Map<string, Expr>();
  for (const stmt of fn.body.statements) {
    if (stmt.kind !== "let") return undefined;
    aliases.set(stmt.name, stmt.value);
  }
  const yieldArm = expr.arms.find((arm) =>
    arm.pattern.kind === "constructor" && arm.pattern.name === "Yield"
  );
  if (!yieldArm || yieldArm.pattern.kind !== "constructor") return undefined;
  const recursive = yieldArm.value;
  if (
    recursive.kind !== "call" || recursive.callee.kind !== "var" ||
    recursive.callee.name !== fn.name
  ) {
    return undefined;
  }
  const push = recursive.args.find((arg): arg is Extract<Expr, { kind: "call" }> =>
    arg.kind === "call" && arg.callee.kind === "var" &&
    isInlineArrayBuilderPushName(arg.callee.name)
  );
  if (!push || push.args.length < 3) return undefined;
  const index = push.args.at(-2);
  const value = push.args.at(-1);
  if (!index || index.kind !== "var" || !value) return undefined;
  return { capacity, itemType, indexName: index.name, value, aliases };
}

function isInlineArrayLoopName(name: string): boolean {
  return /(?:^|_)InlineArray_(?:tabulate|tabulate_with|fill|map|imap|imap_with_state|set|update)_loop(?:__|$)/
    .test(name);
}

function isInlineArrayBuilderPushName(name: string): boolean {
  return name.includes("InlineArrayBuilder_push") || name.includes("InlineArrayBuilder.push");
}

function staticIndexExpr(value: number): Expr {
  return { kind: "literal", literalKind: "number", value: String(value), inferredType: "i32" };
}

function ensureLoweringLocals(expr: Expr, ctx: LowerContext, locals: Set<string>) {
  const found: BackendLocal[] = [];
  collectExprLocals(expr, found, ctx);
  for (const local of found) {
    if (locals.has(local.name) || ctx.tempLocals.some((item) => item.name === local.name)) continue;
    locals.add(local.name);
    ctx.tempLocals.push(local);
  }
}

function substituteExpr(expr: Expr, substitutions: Map<string, Expr>): Expr {
  switch (expr.kind) {
    case "do":
      return expr.expr ? substituteExpr(expr.expr, substitutions) : expr;
    case "const_fn":
      return { ...expr, body: substituteExpr(expr.body, substitutions) };
    case "var":
      return substitutions.get(expr.name) ?? expr;
    case "call":
      return {
        ...expr,
        callee: substituteExpr(expr.callee, substitutions),
        args: expr.args.map((arg) => substituteExpr(arg, substitutions)),
      };
    case "index":
      return {
        ...expr,
        target: substituteExpr(expr.target, substitutions),
        index: substituteExpr(expr.index, substitutions),
      };
    case "binary":
      return {
        ...expr,
        left: substituteExpr(expr.left, substitutions),
        right: substituteExpr(expr.right, substitutions),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: substituteExpr(expr.value, substitutions),
        body: substituteExpr(expr.body, substitutions),
      };
    case "match":
      return {
        ...expr,
        value: substituteExpr(expr.value, substitutions),
        arms: expr.arms.map((arm) => ({ ...arm, value: substituteExpr(arm.value, substitutions) })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: substituteExpr(slot.value, substitutions),
        })),
      };
    case "range":
      return {
        ...expr,
        start: substituteExpr(expr.start, substitutions),
        end: substituteExpr(expr.end, substitutions),
      };
    case "static_for_slots":
      return { ...expr, value: substituteExpr(expr.value, substitutions) };
    case "field":
      return {
        ...expr,
        value: substituteExpr(expr.value, substitutions),
        key: substituteExpr(expr.key, substitutions),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) => substituteStatement(stmt, substitutions)),
        ...(expr.expr ? { expr: substituteExpr(expr.expr, substitutions) } : {}),
      };
    case "literal":
    case "placeholder":
      return expr;
  }
}

function substituteStatement(stmt: Statement, substitutions: Map<string, Expr>): Statement {
  if (stmt.kind === "let" || stmt.kind === "destructure_let") {
    return { ...stmt, value: substituteExpr(stmt.value, substitutions) } as Statement;
  }
  return stmt;
}

function cleanupInstrs(instrs: Instr[]): Instr[] {
  const cleaned: Instr[] = [];
  for (let index = 0; index < instrs.length; index++) {
    const instr = cleanupInstr(instrs[index]!);
    if (instr.op === "block" && !instr.results?.length && instr.body.length === 0) continue;
    if (instr.op === "loop" && !instr.results?.length && instr.body.length === 0) continue;
    const previous = cleaned[cleaned.length - 1];
    if (previous?.op === "local.set" && instr.op === "local.get" && previous.name === instr.name) {
      cleaned[cleaned.length - 1] = { op: "local.tee", name: instr.name };
      continue;
    }
    cleaned.push(instr);
    const current = cleaned[cleaned.length - 1];
    const beforeCurrent = cleaned[cleaned.length - 2];
    if (
      beforeCurrent?.op === "local.get" && current?.op === "local.set" &&
      beforeCurrent.name === current.name
    ) {
      cleaned.splice(cleaned.length - 2, 2);
      continue;
    }
    if (beforeCurrent?.op === "local.tee" && current?.op === "drop") {
      cleaned.splice(cleaned.length - 2, 2, { op: "local.set", name: beforeCurrent.name });
      continue;
    }
    const beforeBeforeCurrent = cleaned[cleaned.length - 3];
    if (
      (current?.op === "if" || current?.op === "br_if") &&
      beforeCurrent?.op === "binary" && beforeCurrent.wasm === "i32.eqz" &&
      beforeBeforeCurrent?.op === "binary" && beforeBeforeCurrent.wasm === "i32.eqz"
    ) {
      cleaned.splice(cleaned.length - 3, 2);
      continue;
    }
    if (beforeCurrent?.op === "const" && current?.op === "drop") {
      cleaned.splice(cleaned.length - 2, 2);
      continue;
    }
    if (
      beforeCurrent?.op === "const" && current?.op === "binary" &&
      isRightIdentityConst(beforeCurrent, current.wasm)
    ) {
      cleaned.splice(cleaned.length - 2, 2);
      continue;
    }
    if (
      beforeBeforeCurrent?.op === "const" && beforeCurrent?.op === "const" &&
      current?.op === "binary"
    ) {
      const folded = foldConstInstrBinary(beforeBeforeCurrent, beforeCurrent, current.wasm);
      if (folded) {
        cleaned.splice(cleaned.length - 3, 3, folded);
        continue;
      }
    }
    if (isTerminator(instr)) break;
  }
  return cleaned;
}

function foldConstInstrBinary(
  left: Extract<Instr, { op: "const" }>,
  right: Extract<Instr, { op: "const" }>,
  wasm: string,
): Instr | undefined {
  if (left.type !== right.type) return undefined;
  if (left.type !== "i32" && left.type !== "i64") return undefined;
  const op = wasm.slice(`${left.type}.`.length);
  if (!wasm.startsWith(`${left.type}.`)) return undefined;
  const bits = left.type === "i32" ? 32n : 64n;
  const mask = (1n << bits) - 1n;
  const signed = (value: bigint) => {
    const wrapped = value & mask;
    const sign = 1n << (bits - 1n);
    return wrapped >= sign ? wrapped - (1n << bits) : wrapped;
  };
  const l = BigInt(left.value);
  const r = BigInt(right.value);
  let value: bigint | undefined;
  switch (op) {
    case "add":
      value = l + r;
      break;
    case "sub":
      value = l - r;
      break;
    case "mul":
      value = l * r;
      break;
    case "and":
      value = l & r;
      break;
    case "or":
      value = l | r;
      break;
    case "xor":
      value = l ^ r;
      break;
    case "shl":
      value = l << (r & BigInt(Number(bits) - 1));
      break;
    case "shr_u":
      value = (l & mask) >> (r & BigInt(Number(bits) - 1));
      break;
    default:
      return undefined;
  }
  return { op: "const", type: left.type, value: Number(signed(value)) };
}

function isRightIdentityConst(instr: Extract<Instr, { op: "const" }>, wasm: string): boolean {
  return (
    instr.value === 0 &&
    (wasm === `${instr.type}.add` || wasm === `${instr.type}.sub` || wasm === `${instr.type}.or` ||
      wasm === `${instr.type}.xor`)
  ) ||
    (instr.value === 1 && (wasm === `${instr.type}.mul` || wasm.startsWith(`${instr.type}.div_`)));
}

function cleanupInstr(instr: Instr): Instr {
  if (instr.op === "if") {
    return {
      ...instr,
      thenBody: cleanupInstrs(instr.thenBody),
      elseBody: cleanupInstrs(instr.elseBody),
    };
  }
  if (instr.op === "block" || instr.op === "loop") {
    return { ...instr, body: cleanupInstrs(instr.body) };
  }
  return instr;
}

function isTerminator(instr: Instr): boolean {
  return instr.op === "br" || instr.op === "return_call" || instr.op === "unreachable";
}

function instrLocalNames(instrs: Instr[]): Set<string> {
  const names = new Set<string>();
  const visit = (instr: Instr) => {
    switch (instr.op) {
      case "local.get":
      case "local.set":
      case "local.tee":
        names.add(instr.name);
        return;
      case "if":
        instr.thenBody.forEach(visit);
        instr.elseBody.forEach(visit);
        return;
      case "block":
      case "loop":
        instr.body.forEach(visit);
        return;
      default:
        return;
    }
  };
  instrs.forEach(visit);
  return names;
}

function instrLocalUseCounts(instrs: Instr[]): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (instr: Instr) => {
    switch (instr.op) {
      case "local.get":
      case "local.set":
      case "local.tee":
        counts.set(instr.name, (counts.get(instr.name) ?? 0) + 1);
        return;
      case "if":
        instr.thenBody.forEach(visit);
        instr.elseBody.forEach(visit);
        return;
      case "block":
      case "loop":
        instr.body.forEach(visit);
        return;
      default:
        return;
    }
  };
  instrs.forEach(visit);
  return counts;
}

function uniqueBackendLocals(locals: BackendLocal[]): BackendLocal[] {
  const seen = new Set<string>();
  return locals.filter((local) => {
    if (seen.has(local.name)) return false;
    seen.add(local.name);
    return true;
  });
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
    const remaining: BlockExpr = {
      kind: "block",
      statements: block.statements.slice(index + 1),
      ...(block.expr ? { expr: block.expr } : {}),
    };
    body.push(...lowerStatement(stmt, ctx, locals, usedLater, remaining));
  }
  if (block.expr) body.push(...lowerExpr(block.expr, ctx, locals, expectedType));
  return body;
}

function lowerStatement(
  stmt: Statement,
  ctx: LowerContext,
  locals: Set<string>,
  usedLater: Set<string>,
  usedLaterExpr?: Expr,
): Instr[] {
  if (stmt.kind === "proof_const") return [];
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
  if (stmt.type) ctx.localTypes?.set(stmt.name, stmt.type);
  const flattenedStatementType = flattenType(stmt.type, ctx.layouts);
  const isStructuredAlias = inlineArrayLikeTypeArgs(stmt.type, ctx.layouts) !== undefined;
  if (
    isStructuredAlias &&
    fixedArrayAliasForwardOnly(usedLaterExpr, stmt.name) &&
    isDeferrableFixedArrayExpr(stmt.value, stmt.type, ctx)
  ) {
    ctx.fixedArrayTransformerAliases?.set(stmt.name, stmt.value);
    return [];
  }
  if (
    !usedLater.has(stmt.name) && !hasRuntimeEffect(stmt.value, ctx.functions) &&
    flattenedStatementType.length <= 1 && !isStructuredAlias
  ) return [];
  const bindings = statementLocalBindings(stmt, ctx);
  const projectedReturn = projectedReturnBinding(stmt, ctx, usedLaterExpr);
  if (projectedReturn) {
    const targets = projectedReturn.suffixes.map((suffix) => `${stmt.name}$${suffix}`);
    for (const target of targets) locals.add(target);
    const inlined = stmt.value.kind === "call"
      ? lowerPrivateProductCallInline(stmt.value, ctx, locals)
      : undefined;
    return [
      ...(inlined ?? lowerExpr(stmt.value, ctx, locals, projectedReturn.type)),
      ...targets.toReversed().map((target): Instr => ({ op: "local.set", name: target })),
    ];
  }
  const targets = bindings.map((slot) => slot.name);
  for (const target of targets) locals.add(target);
  const inlined = stmt.value.kind === "call"
    ? lowerPrivateProductCallInline(stmt.value, ctx, locals, {
      deadProductArgs: deadProductArgIndexes(stmt.value, ctx, usedLaterExpr),
    })
    : undefined;
  const value = inlined ?? lowerExpr(stmt.value, ctx, locals, stmt.type);
  if (!usedLater.has(stmt.name) && !isStructuredAlias) {
    return [
      ...value,
      ...flattenType(stmt.type, ctx.layouts).map((): Instr => ({
        op: "drop",
      })),
    ];
  }
  return [
    ...value,
    ...targets.toReversed().map((target): Instr => ({ op: "local.set", name: target })),
  ];
}

function projectedReturnBinding(
  stmt: Statement,
  ctx: LowerContext,
  usedLaterExpr: Expr | undefined,
): ReturnProjectionPlan | undefined {
  if (stmt.kind !== "let" || stmt.value.kind !== "call" || stmt.value.callee.kind !== "var") {
    return undefined;
  }
  const plan = ctx.returnProjectionPlans?.get(stmt.value.callee.name);
  if (!plan) return undefined;
  const uses = projectionUses(usedLaterExpr, stmt.name);
  if (uses.whole) return undefined;
  return plan.suffixes.some((suffix) => uses.suffixes.has(suffix)) ? plan : undefined;
}

function isDeferrableFixedArrayExpr(
  expr: Expr,
  type: string | undefined,
  ctx: LowerContext,
): boolean {
  return Boolean(
    fixedArrayUpdateCall(expr, ctx) ||
      fixedArrayUpdateExpr(expr, type, ctx) ||
      fixedArraySwapCall(expr, ctx) ||
      privateFixedArrayTransformerExpr(expr, type, ctx),
  );
}

function privateFixedArrayTransformerExpr(
  expr: Expr,
  expectedType: string | undefined,
  ctx: LowerContext,
): boolean {
  if (expr.kind !== "call" || expr.callee.kind !== "var") return false;
  const callee = ctx.functions.get(expr.callee.name);
  if (!callee || callee.public || !callee.returnType || callee.params.length === 0) return false;
  if (callee.params.some((param) => param.const)) return false;
  if (hasRuntimeEffect(callee.body, ctx.functions)) return false;
  if (
    !analyzeTailCalls(callee).hasOnlyTailDirectSelfCalls &&
    !fixedArrayTransformerForwardingExpr(callee.body, callee.params[0], ctx)
  ) return false;
  return sameInlineArrayType(expectedType, callee.returnType, ctx.layouts) &&
    sameInlineArrayType(expectedType, callee.params[0]?.type, ctx.layouts);
}

function fixedArrayAliasForwardOnly(expr: Expr | undefined, name: string): boolean {
  if (!expr) return false;
  let uses = 0;
  let invalid = false;
  const visit = (item: Expr | undefined, productSlotValue: boolean) => {
    if (!item || invalid) return;
    if (item.kind === "var" && item.name === name) {
      if (productSlotValue) uses++;
      else invalid = true;
      return;
    }
    switch (item.kind) {
      case "shape":
      case "product_constructor":
        item.slots.forEach((slot) => {
          visit(slot.index, false);
          visit(slot.value, true);
        });
        return;
      case "call":
        visit(item.callee, false);
        item.args.forEach((arg) => visit(arg, false));
        return;
      case "index":
        visit(item.target, false);
        visit(item.index, false);
        return;
      case "binary":
        visit(item.left, false);
        visit(item.right, false);
        return;
      case "pipe_bind":
        visit(item.value, false);
        if (item.name !== name) visit(item.body, false);
        return;
      case "match":
        visit(item.value, false);
        for (const arm of item.arms) {
          if (!patternBindingNames(arm.pattern).includes(name)) visit(arm.value, false);
        }
        return;
      case "field":
        visit(item.value, false);
        visit(item.key, false);
        return;
      case "range":
        visit(item.start, false);
        visit(item.end, false);
        return;
      case "static_for_slots":
        if (item.iterator !== name && item.valueIterator !== name) visit(item.value, false);
        return;
      case "block":
        for (const stmt of item.statements) {
          if (stmt.kind === "proof_const") continue;
          if (stmt.kind === "let" && stmt.name === name) return;
          if (stmt.kind === "destructure_let" && stmt.names.includes(name)) return;
          visit(stmt.value, false);
        }
        visit(item.expr, false);
        return;
      case "do":
        for (const stmt of item.statements) {
          if (stmt.kind !== "proof_const") visit(stmt.value, false);
        }
        visit(item.expr, false);
        return;
      case "const_fn":
        visit(item.body, false);
        return;
      case "literal":
      case "placeholder":
      case "var":
        return;
    }
  };
  visit(expr, false);
  return uses === 1 && !invalid;
}

function deadProductArgIndexes(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  usedLaterExpr: Expr | undefined,
): Set<number> {
  if (expr.callee.kind !== "var" || !usedLaterExpr) return new Set();
  const callee = ctx.functions.get(expr.callee.name);
  if (!callee) return new Set();
  const argOffset = Math.max(0, expr.args.length - callee.params.length);
  const runtimeArgs = expr.args.slice(argOffset);
  const usedLater = usedNames(usedLaterExpr);
  const baseCounts = new Map<string, number>();
  for (const [index, param] of callee.params.entries()) {
    const arg = runtimeArgs[index];
    if (flattenType(param.type, ctx.layouts).length <= 1) continue;
    if (arg.kind !== "var") continue;
    const base = baseName(arg.name);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const dead = new Set<number>();
  for (const [index, param] of callee.params.entries()) {
    const arg = runtimeArgs[index];
    if (arg?.kind !== "var" || flattenType(param.type, ctx.layouts).length <= 1) continue;
    const base = baseName(arg.name);
    if (!usedLater.has(base) && (baseCounts.get(base) ?? 0) === 1) dead.add(index);
  }
  return dead;
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
  if (expr.kind === "call" && expr.args.length === 0 && expr.callee.kind !== "var") {
    return lowerTailOpcodeExpr(expr.callee, fn, ctx, locals);
  }
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
  if (expr.kind === "pipe_bind") {
    const bindings = flattenBinding(expr.name, exprType(expr.value, ctx.functions), ctx.layouts);
    for (const binding of bindings) locals.add(binding.name);
    return [
      ...lowerExpr(expr.value, ctx, locals),
      ...bindings.map((binding) => binding.name).toReversed().map((name): Instr => ({
        op: "local.set",
        name,
      })),
      ...lowerTailOpcodeExpr(expr.body, fn, ctx, locals),
    ];
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
  if (isCatchAllPattern(arm.pattern) || rest.length === 0) {
    const ignored = hasRuntimeEffect(expr.value, ctx.functions)
      ? lowerIgnoredExpr(expr.value, ctx, locals)
      : [];
    return [
      ...ignored,
      ...lowerTailOpcodeExpr(arm.value, fn, ctx, locals),
    ];
  }
  return [
    ...lowerExpr(expr.value, ctx, locals),
    ...lowerPatternTest(arm.pattern),
    {
      op: "if",
      results: flattenType(fn.returnType, ctx.layouts).map((slot) => slot.wat),
      thenBody: lowerTailOpcodeExpr(arm.value, fn, ctx, locals),
      elseBody: lowerTailOpcodeMatch({ ...expr, arms: rest }, fn, ctx, locals),
      branchHint: branchHintForTestedArm(arm, rest),
    },
  ];
}

function lowerTailLoopBlock(
  block: BlockExpr,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const statements: Instr[] = [];
  for (let index = 0; index < block.statements.length; index++) {
    const stmt = block.statements[index];
    const usedLater = usedNames({
      kind: "block",
      statements: block.statements.slice(index + 1),
      ...(block.expr ? { expr: block.expr } : {}),
    });
    const remaining: BlockExpr = {
      kind: "block",
      statements: block.statements.slice(index + 1),
      ...(block.expr ? { expr: block.expr } : {}),
    };
    statements.push(...lowerStatement(stmt, ctx, locals, usedLater, remaining));
  }
  return [{
    op: "block",
    results: flattenType(fn.returnType, ctx.layouts).map((slot) => slot.wat),
    body: [{
      op: "loop",
      body: [
        ...statements,
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
  if (expr.kind === "call" && expr.args.length === 0 && expr.callee.kind !== "var") {
    return lowerTailLoopExpr(expr.callee, fn, ctx, locals, continueDepth, exitDepth);
  }
  if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === fn.name) {
    const transient = lowerTransientFixedArrayTailCall(expr, fn, ctx, locals, continueDepth);
    if (transient) return transient;
    const callee = ctx.signatures.get(expr.callee.name);
    const argOffset = Math.max(0, expr.args.length - (callee?.params.length ?? expr.args.length));
    const runtimeArgs = expr.args.slice(argOffset);
    const flatParams = fn.params.flatMap((param) =>
      flattenBinding(param.name, param.type, ctx.layouts)
    );
    return [
      ...runtimeArgs.flatMap((arg, index) =>
        lowerExpr(arg, ctx, locals, callee?.params[index]?.type)
      ),
      ...flatParams.toReversed().map((param): Instr => ({ op: "local.set", name: param.name })),
      { op: "br", depth: continueDepth },
    ];
  }
  if (expr.kind === "match") {
    return lowerTailLoopMatch(expr, fn, ctx, locals, continueDepth, exitDepth);
  }
  if (expr.kind === "pipe_bind") {
    const bindings = flattenBinding(expr.name, exprType(expr.value, ctx.functions), ctx.layouts);
    for (const binding of bindings) locals.add(binding.name);
    return [
      ...lowerExpr(expr.value, ctx, locals),
      ...bindings.map((binding) => binding.name).toReversed().map((name): Instr => ({
        op: "local.set",
        name,
      })),
      ...lowerTailLoopExpr(expr.body, fn, ctx, locals, continueDepth, exitDepth),
    ];
  }
  if (expr.kind === "block") {
    const statements: Instr[] = [];
    for (let index = 0; index < expr.statements.length; index++) {
      const stmt = expr.statements[index];
      const usedLater = usedNames({
        kind: "block",
        statements: expr.statements.slice(index + 1),
        ...(expr.expr ? { expr: expr.expr } : {}),
      });
      const remaining: BlockExpr = {
        kind: "block",
        statements: expr.statements.slice(index + 1),
        ...(expr.expr ? { expr: expr.expr } : {}),
      };
      statements.push(...lowerStatement(stmt, ctx, locals, usedLater, remaining));
    }
    return [
      ...statements,
      ...(expr.expr
        ? lowerTailLoopExpr(expr.expr, fn, ctx, locals, continueDepth, exitDepth)
        : [{ op: "br", depth: exitDepth } as Instr]),
    ];
  }
  return [
    ...(lowerBackedProductTailExit(expr, fn.returnType, ctx, locals) ??
      lowerExpr(expr, ctx, locals, fn.returnType)),
    { op: "br", depth: exitDepth },
  ];
}

function lowerTransientFixedArrayTailCall(
  expr: Extract<Expr, { kind: "call" }>,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
): Instr[] | undefined {
  const callee = ctx.signatures.get(expr.callee.kind === "var" ? expr.callee.name : "");
  const argOffset = Math.max(0, expr.args.length - (callee?.params.length ?? expr.args.length));
  const runtimeArgs = expr.args.slice(argOffset);
  const firstParam = fn.params[0];
  const firstArg = runtimeArgs[0];
  if (!firstParam || !firstArg) return undefined;
  if (runtimeArgs.slice(1).some((arg) => exprMentionsName(arg, firstParam.name))) return undefined;
  const product = lowerTransientProductFixedArrayTailCall(
    runtimeArgs,
    firstParam,
    fn,
    callee,
    ctx,
    locals,
    continueDepth,
  );
  if (product) return product;
  const transformed = lowerFixedArrayTransformerIntoBacking(firstArg, firstParam, ctx, locals);
  if (transformed) {
    const remainingParams = fn.params.slice(1).flatMap((param) =>
      flattenBinding(param.name, param.type, ctx.layouts)
    );
    return [
      ...transformed,
      ...runtimeArgs.slice(1).flatMap((arg, index) =>
        lowerExpr(arg, ctx, locals, callee?.params[index + 1]?.type)
      ),
      ...remainingParams.toReversed().map((param): Instr => ({
        op: "local.set",
        name: param.name,
      })),
      { op: "br", depth: continueDepth },
    ];
  }
  const update = fixedArrayUpdateCall(firstArg, ctx) ??
    fixedArrayUpdateExpr(firstArg, firstParam.type, ctx);
  if (update && update.source.name === firstParam.name) {
    if (inlineArrayLikeTypeArgs(firstParam.type, ctx.layouts)?.[0] !== update.capacity) {
      return undefined;
    }
    const firstParamSlots = flattenBinding(firstParam.name, firstParam.type, ctx.layouts);
    if (firstParamSlots.length !== update.capacity) return undefined;

    const remainingParams = fn.params.slice(1).flatMap((param) =>
      flattenBinding(param.name, param.type, ctx.layouts)
    );
    return [
      ...lowerTransientFixedArraySet(update, firstParam, ctx, locals),
      ...runtimeArgs.slice(1).flatMap((arg, index) =>
        lowerExpr(arg, ctx, locals, callee?.params[index + 1]?.type)
      ),
      ...remainingParams.toReversed().map((param): Instr => ({
        op: "local.set",
        name: param.name,
      })),
      { op: "br", depth: continueDepth },
    ];
  }
  const swap = fixedArraySwapCall(firstArg, ctx);
  if (!swap || swap.source.name !== firstParam.name) return undefined;
  if (inlineArrayLikeTypeArgs(firstParam.type, ctx.layouts)?.[0] !== swap.capacity) {
    return undefined;
  }
  const firstParamSlots = flattenBinding(firstParam.name, firstParam.type, ctx.layouts);
  if (firstParamSlots.length !== swap.capacity) return undefined;

  const remainingParams = fn.params.slice(1).flatMap((param) =>
    flattenBinding(param.name, param.type, ctx.layouts)
  );
  return [
    ...lowerTransientFixedArraySwap(swap, firstParam, ctx, locals),
    ...runtimeArgs.slice(1).flatMap((arg, index) =>
      lowerExpr(arg, ctx, locals, callee?.params[index + 1]?.type)
    ),
    ...remainingParams.toReversed().map((param): Instr => ({ op: "local.set", name: param.name })),
    { op: "br", depth: continueDepth },
  ];
}

function lowerFixedArrayTransformerIntoBacking(
  expr: Expr,
  targetParam: Param,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (!fixedArrayBackingForName(targetParam.name, ctx)) return undefined;
  const transformed = fixedArrayTransformerCall(expr, targetParam, ctx);
  if (!transformed) return undefined;
  if (ctx.inlineStack?.has(transformed.callee.name)) return undefined;

  const { call, callee } = transformed;
  const argOffset = Math.max(0, call.args.length - callee.params.length);
  const runtimeArgs = call.args.slice(argOffset);
  if (runtimeArgs.length !== callee.params.length) return undefined;

  const prefix = `__inl_${callee.name.replaceAll(/[^A-Za-z0-9_]/g, "_")}_${ctx.tempIndex++}`;
  const renames = new Map<string, string>();
  callee.params.forEach((param, index) => {
    renames.set(param.name, index === 0 ? targetParam.name : `${prefix}_${param.name}`);
  });
  const renamed = renameFunctionLocals(callee, renames);
  const backedParam = renamed.params[0];
  if (!backedParam) return undefined;

  const scratchArrays = renamedScratchPlans(
    ctx.scratchPlansByFunction?.get(callee.name),
    renames,
  );
  const packedArrays = renamedPackedPlans(
    ctx.packedPlansByFunction?.get(callee.name),
    renames,
  );
  const localSlotArrays = renamedLocalSlotPlans(
    ctx.localSlotPlansByFunction?.get(callee.name),
    renames,
  );
  const inlineCtx: LowerContext = {
    ...ctx,
    currentFn: renamed,
    localTypes: new Map(renamed.params.map((param) => [param.name, param.type])),
    inlineStack: new Set([...(ctx.inlineStack ?? []), callee.name]),
    scratchArrays,
    packedArrays,
    localSlotArrays,
    fixedArrayTransformerAliases: new Map(),
  };

  const paramBindings = renamed.params.slice(1).flatMap((param) =>
    flattenBinding(param.name, param.type, ctx.layouts)
  );
  for (const binding of paramBindings) {
    if (!locals.has(binding.name)) {
      locals.add(binding.name);
      ctx.tempLocals.push({ name: binding.name, type: binding.wat });
    }
  }
  for (const plan of packedArrays?.values() ?? []) {
    const name = packedArrayLocalName(plan.name);
    if (!locals.has(name) && !ctx.tempLocals.some((item) => item.name === name)) {
      locals.add(name);
      ctx.tempLocals.push({ name, type: plan.packedType });
    }
  }
  for (const local of collectIrLocals(renamed.body, inlineCtx)) {
    if (locals.has(local.name) || ctx.tempLocals.some((item) => item.name === local.name)) continue;
    locals.add(local.name);
    ctx.tempLocals.push(local);
  }

  const body = lowerBackedFixedArrayTailLoopBlock(
    renamed.body,
    renamed,
    backedParam,
    inlineCtx,
    locals,
  ) ?? lowerForwardingFixedArrayTransformerBlock(
    renamed.body,
    backedParam,
    inlineCtx,
    locals,
  );
  if (!body) return undefined;
  const scratchPrologue = [...(scratchArrays?.values() ?? [])].filter((plan) =>
    !sameStorageName(plan.name, targetParam.name)
  ).flatMap((plan) => lowerScratchArrayInit(plan));
  const packedPrologue = [...(packedArrays?.values() ?? [])].filter((plan) =>
    !sameStorageName(plan.name, targetParam.name)
  ).flatMap((plan) => lowerPackedArrayInit(plan));
  return [
    ...runtimeArgs.slice(1).flatMap((arg, index) =>
      lowerExpr(arg, ctx, locals, callee.params[index + 1]?.type)
    ),
    ...paramBindings.toReversed().map((binding): Instr => ({
      op: "local.set",
      name: binding.name,
    })),
    ...scratchPrologue,
    ...packedPrologue,
    ...body,
  ];
}

function lowerForwardingFixedArrayTransformerBlock(
  block: BlockExpr,
  backedParam: Param,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const forwarded = fixedArrayTransformerForwardingExpr(block, backedParam, ctx);
  if (!forwarded) return undefined;
  const statements: Instr[] = [];
  for (let index = 0; index < block.statements.length; index++) {
    const stmt = block.statements[index];
    const usedLater = usedNames({
      kind: "block",
      statements: block.statements.slice(index + 1),
      expr: forwarded,
    });
    const remaining: BlockExpr = {
      kind: "block",
      statements: block.statements.slice(index + 1),
      expr: forwarded,
    };
    statements.push(...lowerStatement(stmt, ctx, locals, usedLater, remaining));
  }
  const tail = lowerFixedArrayTransformerIntoBacking(forwarded, backedParam, ctx, locals);
  return tail ? [...statements, ...tail] : undefined;
}

function lowerBackedFixedArrayTailLoopBlock(
  block: BlockExpr,
  fn: FnDecl,
  backedParam: Param,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const statements: Instr[] = [];
  for (let index = 0; index < block.statements.length; index++) {
    const stmt = block.statements[index];
    const usedLater = usedNames({
      kind: "block",
      statements: block.statements.slice(index + 1),
      ...(block.expr ? { expr: block.expr } : {}),
    });
    const remaining: BlockExpr = {
      kind: "block",
      statements: block.statements.slice(index + 1),
      ...(block.expr ? { expr: block.expr } : {}),
    };
    statements.push(...lowerStatement(stmt, ctx, locals, usedLater, remaining));
  }
  const tail = block.expr
    ? lowerBackedFixedArrayTailLoopExpr(block.expr, fn, backedParam, ctx, locals, 0, 1)
    : [{ op: "br", depth: 1 } as Instr];
  if (!tail) return undefined;
  return [{
    op: "block",
    results: [],
    body: [{ op: "loop", body: [...statements, ...tail] }, { op: "unreachable" }],
  }];
}

function lowerBackedFixedArrayTailLoopExpr(
  expr: Expr,
  fn: FnDecl,
  backedParam: Param,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] | undefined {
  if (expr.kind === "call" && expr.args.length === 0 && expr.callee.kind !== "var") {
    return lowerBackedFixedArrayTailLoopExpr(
      expr.callee,
      fn,
      backedParam,
      ctx,
      locals,
      continueDepth,
      exitDepth,
    );
  }
  if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === fn.name) {
    return lowerTransientFixedArrayTailCall(expr, fn, ctx, locals, continueDepth);
  }
  if (expr.kind === "match") {
    return lowerBackedFixedArrayTailLoopMatch(
      expr,
      fn,
      backedParam,
      ctx,
      locals,
      continueDepth,
      exitDepth,
    );
  }
  if (expr.kind === "pipe_bind") {
    const bindings = flattenBinding(expr.name, exprType(expr.value, ctx.functions), ctx.layouts);
    for (const binding of bindings) locals.add(binding.name);
    const body = lowerBackedFixedArrayTailLoopExpr(
      expr.body,
      fn,
      backedParam,
      ctx,
      locals,
      continueDepth,
      exitDepth,
    );
    if (!body) return undefined;
    return [
      ...lowerExpr(expr.value, ctx, locals),
      ...bindings.map((binding) => binding.name).toReversed().map((name): Instr => ({
        op: "local.set",
        name,
      })),
      ...body,
    ];
  }
  if (expr.kind === "block") {
    const statements: Instr[] = [];
    for (let index = 0; index < expr.statements.length; index++) {
      const stmt = expr.statements[index];
      const usedLater = usedNames({
        kind: "block",
        statements: expr.statements.slice(index + 1),
        ...(expr.expr ? { expr: expr.expr } : {}),
      });
      const remaining: BlockExpr = {
        kind: "block",
        statements: expr.statements.slice(index + 1),
        ...(expr.expr ? { expr: expr.expr } : {}),
      };
      statements.push(...lowerStatement(stmt, ctx, locals, usedLater, remaining));
    }
    const body = expr.expr
      ? lowerBackedFixedArrayTailLoopExpr(
        expr.expr,
        fn,
        backedParam,
        ctx,
        locals,
        continueDepth,
        exitDepth,
      )
      : [{ op: "br", depth: exitDepth } as Instr];
    return body ? [...statements, ...body] : undefined;
  }
  if (expr.kind === "var" && sameStorageName(expr.name, backedParam.name)) {
    return [{ op: "br", depth: exitDepth }];
  }
  const update = fixedArrayUpdateCall(expr, ctx) ??
    fixedArrayUpdateExpr(expr, backedParam.type, ctx);
  if (update && sameStorageName(update.source.name, backedParam.name)) {
    return [
      ...lowerTransientFixedArraySet(update, backedParam, ctx, locals),
      { op: "br", depth: exitDepth },
    ];
  }
  const swap = fixedArraySwapCall(expr, ctx);
  if (swap && sameStorageName(swap.source.name, backedParam.name)) {
    return [
      ...lowerTransientFixedArraySwap(swap, backedParam, ctx, locals),
      { op: "br", depth: exitDepth },
    ];
  }
  return undefined;
}

function lowerBackedFixedArrayTailLoopMatch(
  expr: Extract<Expr, { kind: "match" }>,
  fn: FnDecl,
  backedParam: Param,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] | undefined {
  const [arm, ...rest] = expr.arms;
  if (!arm) return [{ op: "br", depth: exitDepth }];
  if (isCatchAllPattern(arm.pattern) || rest.length === 0) {
    const body = lowerBackedFixedArrayTailLoopExpr(
      arm.value,
      fn,
      backedParam,
      ctx,
      locals,
      continueDepth,
      exitDepth,
    );
    if (!body) return undefined;
    const ignored = hasRuntimeEffect(expr.value, ctx.functions)
      ? lowerIgnoredExpr(expr.value, ctx, locals)
      : [];
    return [...ignored, ...body];
  }
  const thenBody = lowerBackedFixedArrayTailLoopExpr(
    arm.value,
    fn,
    backedParam,
    ctx,
    locals,
    continueDepth + 1,
    exitDepth + 1,
  );
  const elseBody = lowerBackedFixedArrayTailLoopMatch(
    { ...expr, arms: rest },
    fn,
    backedParam,
    ctx,
    locals,
    continueDepth + 1,
    exitDepth + 1,
  );
  if (!thenBody || !elseBody) return undefined;
  return [
    ...lowerExpr(expr.value, ctx, locals),
    ...lowerPatternTest(arm.pattern),
    {
      op: "if",
      results: [],
      thenBody,
      elseBody,
      branchHint: branchHintForTestedArm(arm, rest),
    },
  ];
}

function lowerTransientProductFixedArrayTailCall(
  runtimeArgs: Expr[],
  firstParam: Param,
  fn: FnDecl,
  callee: FnDecl | undefined,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
): Instr[] | undefined {
  const firstArg = runtimeArgs[0];
  if (!firstArg || (firstArg.kind !== "product_constructor" && firstArg.kind !== "shape")) {
    return undefined;
  }
  if (firstArg.slots.some((slot) => slot.spread || slot.index || !slot.label)) return undefined;
  const fields = productFieldTypes(firstParam.type, ctx.layouts);
  if (!fields) return undefined;
  const fieldTypes = new Map(fields.map((field) => [field.label, field.type]));
  const seenLabels = new Set(firstArg.slots.map((slot) => slot.label ?? ""));
  if (fields.some((field) => !seenLabels.has(field.label))) return undefined;

  type BackedFieldUpdate = {
    index: number;
    label: string;
    target: string;
    fieldType: string;
    lower: () => Instr[] | undefined;
  };
  const updates: BackedFieldUpdate[] = firstArg.slots.flatMap((slot, index) => {
    const label = slot.label;
    const fieldType = label ? fieldTypes.get(label) : undefined;
    if (!label || !fieldType) return [];
    const target = `${firstParam.name}.${label}`;
    const slotValue = deferredFixedArrayAliasValue(slot.value, ctx);
    if (
      !ctx.localSlotArrays?.get(target) && !ctx.packedArrays?.get(target) &&
      !ctx.scratchArrays?.get(target)
    ) return [];
    const update = fixedArrayUpdateCall(slotValue, ctx) ??
      fixedArrayUpdateExpr(slotValue, fieldType, ctx);
    if (update && sameStorageName(update.source.name, target)) {
      const args = inlineArrayLikeTypeArgs(fieldType, ctx.layouts);
      if (!args || args[0] !== update.capacity) return [];
      return [{
        index,
        label,
        target,
        fieldType,
        lower: () =>
          lowerTransientFixedArraySet(
            update,
            { ...firstParam, name: target, type: fieldType },
            ctx,
            locals,
          ),
      }];
    }
    if (
      fixedArrayTransformerCall(slotValue, { ...firstParam, name: target, type: fieldType }, ctx)
    ) {
      return [{
        index,
        label,
        target,
        fieldType,
        lower: () =>
          lowerFixedArrayTransformerIntoBacking(
            slotValue,
            { ...firstParam, name: target, type: fieldType },
            ctx,
            locals,
          ),
      }];
    }
    return [];
  });
  if (!updates.length) return undefined;
  const updatesByLabel = new Map(updates.map((update) => [update.label, update]));
  for (const update of updates) {
    for (const slot of firstArg.slots.slice(update.index + 1)) {
      if (exprMentionsStorageName(slot.value, update.target)) return undefined;
    }
  }

  const firstTargets: BackendLocal[] = [];
  const firstValues: Instr[] = [];
  for (const slot of firstArg.slots) {
    const label = slot.label!;
    const fieldType = fieldTypes.get(label);
    if (!fieldType) return undefined;
    const target = `${firstParam.name}.${label}`;
    const backedUpdate = updatesByLabel.get(label);
    if (backedUpdate) {
      const lowered = backedUpdate.lower();
      if (!lowered) return undefined;
      firstValues.push(...lowered);
      continue;
    }
    const slotValue = deferredFixedArrayAliasValue(slot.value, ctx);
    if (slotValue.kind === "var" && sameStorageName(slotValue.name, target)) continue;
    const fieldSlots = flattenType(fieldType, ctx.layouts);
    firstValues.push(...lowerExpr(slotValue, ctx, locals, fieldType));
    for (const fieldSlot of fieldSlots) {
      firstTargets.push({
        name: fieldSlot.suffix
          ? `${firstParam.name}$${label}$${fieldSlot.suffix}`
          : `${firstParam.name}$${label}`,
        type: fieldSlot.wat,
      });
    }
  }

  const remainingParams = fn.params.slice(1).flatMap((param) =>
    flattenBinding(param.name, param.type, ctx.layouts)
  );
  return [
    ...firstValues,
    ...runtimeArgs.slice(1).flatMap((arg, index) =>
      lowerExpr(arg, ctx, locals, callee?.params[index + 1]?.type)
    ),
    ...[...firstTargets, ...remainingParams].toReversed().map((param): Instr => ({
      op: "local.set",
      name: param.name,
    })),
    { op: "br", depth: continueDepth },
  ];
}

function lowerBackedProductTailExit(
  expr: Expr,
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.kind !== "var") return undefined;
  const slots = flattenType(expectedType, ctx.layouts);
  if (slots.length <= 1 || !slots.every((slot) => slot.suffix)) return undefined;
  let usedBackedStorage = false;
  const body = slots.flatMap((slot): Instr[] => {
    const [field, ...rest] = slot.suffix.split("$");
    const itemPath = rest.join("$");
    const item = /^[0-9]+$/.test(itemPath) ? Number.parseInt(itemPath, 10) : undefined;
    if (field && item !== undefined) {
      const target = `${expr.name}.${field}`;
      const packed = packedPlanForName(target, ctx.packedArrays);
      if (packed) {
        usedBackedStorage = true;
        return lowerPackedArrayLoad(packed, staticIndexExpr(item), ctx, locals);
      }
      const localSlot = localSlotPlanForName(target, ctx.localSlotArrays);
      if (localSlot) {
        usedBackedStorage = true;
        return lowerLocalSlotArrayLoad(localSlot, staticIndexExpr(item), ctx, locals);
      }
      const scratch = scratchPlanForName(target, ctx.scratchArrays);
      if (scratch) {
        usedBackedStorage = true;
        return lowerScratchArrayLoad(scratch, staticIndexExpr(item), ctx, locals);
      }
    }
    return [{ op: "local.get", name: `${baseName(expr.name)}$${slot.suffix}` }];
  });
  return usedBackedStorage ? body : undefined;
}

function deferredFixedArrayAliasValue(expr: Expr, ctx: LowerContext): Expr {
  return expr.kind === "var" ? ctx.fixedArrayTransformerAliases?.get(expr.name) ?? expr : expr;
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
  if (isCatchAllPattern(arm.pattern) || rest.length === 0) {
    const ignored = hasRuntimeEffect(expr.value, ctx.functions)
      ? lowerIgnoredExpr(expr.value, ctx, locals)
      : [];
    return [
      ...ignored,
      ...lowerTailLoopExpr(arm.value, fn, ctx, locals, continueDepth, exitDepth),
    ];
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
      branchHint: branchHintForTestedArm(arm, rest),
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
  const yieldUsesItem = yieldArm.pattern.args[0]?.kind === "binding" &&
    exprMentionsName(yieldArm.value, yieldArm.pattern.args[0].name);
  const yieldUsesNext = yieldArm.pattern.args[1]?.kind === "binding" &&
    exprMentionsName(yieldArm.value, yieldArm.pattern.args[1].name);
  const itemName = yieldArm.pattern.args[0]?.kind === "binding" &&
      yieldUsesItem
    ? yieldArm.pattern.args[0].name
    : undefined;
  const nextName = yieldArm.pattern.args[1]?.kind === "binding" &&
      yieldUsesNext
    ? yieldArm.pattern.args[1].name
    : undefined;
  const scoped = new Set(locals);
  if (itemName) {
    scoped.add(itemName);
    ctx.tempLocals.push({ name: itemName, type: "i32" });
  }
  if (nextName) {
    scoped.add(nextName);
    ctx.tempLocals.push({ name: nextName, type: "i32" });
  }
  return [
    ...lowerExpr(cursor, ctx, locals, "i32"),
    ...lowerExpr(n, ctx, locals, "i32"),
    { op: "binary", wasm: "i32.lt_s" },
    {
      op: "if",
      results: [],
      thenBody: [
        ...(itemName
          ? [
            ...lowerExpr(cursor, ctx, locals, "i32"),
            { op: "local.set", name: itemName } as Instr,
          ]
          : []),
        ...(nextName
          ? [
            ...lowerExpr(cursor, ctx, locals, "i32"),
            { op: "const", type: "i32", value: 1 } as Instr,
            { op: "binary", wasm: "i32.add" } as Instr,
            { op: "local.set", name: nextName } as Instr,
          ]
          : []),
        ...lowerTailLoopExpr(yieldArm.value, fn, ctx, scoped, continueDepth + 1, exitDepth + 1),
      ],
      elseBody: lowerTailLoopExpr(doneArm.value, fn, ctx, locals, continueDepth + 1, exitDepth + 1),
      branchHint: branchHintForStepArms(yieldArm, doneArm),
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
    case "do":
      throw new Error("backend cannot lower do expression before desugaring");
    case "literal":
      return lowerLiteral(expr, expectedType);
    case "var": {
      const deferred = ctx.fixedArrayTransformerAliases?.get(expr.name);
      if (deferred) return lowerExpr(deferred, ctx, locals, expectedType);
      return lowerVar(expr.name, ctx, locals, expectedType);
    }
    case "const_fn":
      throw new Error("backend cannot lower const fn literal");
    case "placeholder":
      throw new Error("backend cannot lower unresolved $ placeholder");
    case "call": {
      if (expr.callee.kind !== "var") {
        if (expr.args.length === 0) return lowerExpr(expr.callee, ctx, locals, expectedType);
        throw new Error("backend only supports direct calls");
      }
      const branch = lowerBranchIntrinsic(expr, ctx, locals);
      if (branch) return branch;
      const temporal = lowerTemporalIntrinsic(expr, ctx, locals);
      if (temporal) return temporal;
      const inlineArrayHelper = lowerInlineArrayHelperCall(expr, ctx, locals, expectedType);
      if (inlineArrayHelper) return inlineArrayHelper;
      const builder = lowerInlineArrayBuilderPrimitive(expr, ctx, locals, expectedType);
      if (builder) return builder;
      const componentSlotPut = lowerComponentSlotPut(expr, ctx, locals);
      if (componentSlotPut) return componentSlotPut;
      const componentStoreGet = lowerComponentStoreGet(expr, ctx, locals, expectedType);
      if (componentStoreGet) return componentStoreGet;
      const inlined = lowerPrivateProductCallInline(expr, ctx, locals, {
        deadProductArgs: contextDeadProductArgIndexes(expr, ctx),
      });
      if (inlined) return inlined;
      const scalarInlined = lowerPrivateScalarCallInline(expr, ctx, locals, expectedType);
      if (scalarInlined) return scalarInlined;
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
        const parity = lowerParityRemainderComparison(expr, ctx, locals);
        if (parity) return parity;
        const zeroComparison = lowerZeroComparison(expr, ctx, locals);
        if (zeroComparison) return zeroComparison;
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
        const materialized = lowerMaterializedMatch(expr, ctx, locals, expectedType);
        if (materialized) return materialized;
      }
      return lowerMatchArms(expr.value, expr.arms, ctx, locals, expectedType);
    case "shape":
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

function lowerParityRemainderComparison(
  expr: Extract<Expr, { kind: "binary" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.op !== "==" && expr.op !== "!=") return undefined;
  const pattern = parityRemainderZeroPattern(expr.left, expr.right, ctx) ??
    parityRemainderZeroPattern(expr.right, expr.left, ctx);
  if (!pattern) return undefined;
  return [
    ...lowerExpr(pattern.dividend, ctx, locals, "i32"),
    { op: "const", type: "i32", value: 1 },
    { op: "binary", wasm: "i32.and" },
    { op: "binary", wasm: "i32.eqz" },
    ...(expr.op === "!=" ? [{ op: "binary", wasm: "i32.eqz" } as Instr] : []),
  ];
}

function lowerZeroComparison(
  expr: Extract<Expr, { kind: "binary" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.op !== "==" && expr.op !== "!=") return undefined;
  const leftZero = staticIntegerLiteral(expr.left) === 0;
  const rightZero = staticIntegerLiteral(expr.right) === 0;
  if (!leftZero && !rightZero) return undefined;
  const value = leftZero ? expr.right : expr.left;
  const valueType = exprTypeWithLocals(value, ctx);
  const type = watType(valueType);
  if (type !== "i32" && type !== "i64") return undefined;
  return [
    ...lowerExpr(value, ctx, locals, valueType),
    { op: "binary", wasm: `${type}.eqz` },
    ...(expr.op === "!=" ? [{ op: "binary", wasm: `${type}.eqz` } as Instr] : []),
  ];
}

function parityRemainderZeroPattern(
  remainder: Expr,
  zero: Expr,
  ctx: LowerContext,
): { dividend: Expr } | undefined {
  if (staticIntegerLiteral(zero) !== 0) return undefined;
  if (remainder.kind !== "binary" || remainder.op !== "%") return undefined;
  const divisor = staticIntegerLiteral(remainder.right);
  if (Math.abs(divisor ?? 0) !== 2) return undefined;
  if (watType(exprTypeWithLocals(remainder.left, ctx)) !== "i32") return undefined;
  return { dividend: remainder.left };
}

function lowerComponentSlotPut(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (
    expr.callee.kind !== "var" ||
    (!expr.callee.name.includes("component_slot_put_typed") &&
      !expr.callee.name.includes("ComponentSlot_put_typed") &&
      !expr.callee.name.includes("ComponentSlot.put_typed"))
  ) {
    return undefined;
  }
  const [slot, index, present, value] = expr.args;
  if (expr.args.length !== 4 || slot?.kind !== "var" || !index || !present || !value) {
    return undefined;
  }
  const localBase = slot.name.replaceAll(".", "$");
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
  if (
    expr.callee.kind !== "var" ||
    (!expr.callee.name.includes("component_store_get_typed") &&
      !expr.callee.name.includes("ComponentStore_get_typed") &&
      !expr.callee.name.includes("ComponentStore.get_typed"))
  ) {
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
  const localBase = target.replaceAll(".", "$");
  const itemSlots = (item: number) => {
    const direct = `${localBase}$${item}`;
    if (locals.has(direct)) return [direct];
    return [...locals].filter((slot) => slot.startsWith(`${direct}$`));
  };
  const fallbackSlots = itemSlots(Math.max(0, capacity - 1));
  if (!fallbackSlots.length) return undefined;
  const results = fallbackSlots.map(() => "i32" as const);
  const cached = cacheRepeatedIndex(index, ctx, locals);
  if (fallbackSlots.length === 1) {
    let body: Instr[] = [{ op: "local.get", name: fallbackSlots[0] ?? "__missing_slot" }];
    for (let item = capacity - 2; item >= 0; item--) {
      const slots = itemSlots(item);
      if (slots.length !== 1) return undefined;
      body = [
        { op: "local.get", name: slots[0] ?? "__missing_slot" },
        ...body,
        ...lowerExpr(cached.index, ctx, locals, "i32"),
        { op: "const", type: "i32", value: item },
        { op: "binary", wasm: "i32.eq" },
        { op: "select", type: "i32" },
      ];
    }
    return [...cached.prefix, ...body];
  }
  let body: Instr[] = fallbackSlots.map((name) => ({ op: "local.get", name }));
  for (let item = capacity - 2; item >= 0; item--) {
    const slots = itemSlots(item);
    if (slots.length !== fallbackSlots.length) return undefined;
    body = [
      ...lowerExpr(cached.index, ctx, locals, "i32"),
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
  return [...cached.prefix, ...body];
}

function sparseWorldComponentStoreItemType(target: string, ctx: LowerContext): string | undefined {
  const parts = target.split(".");
  if (parts.length < 3 || parts[2] !== "values") return undefined;
  const worldType = resolveAlias(ctx.localTypes?.get(baseName(parts[0] ?? "")), ctx.layouts);
  const unqualified = worldType?.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
  const sparseArgs = unqualified ? typeCallArgs(unqualified, "SparseWorld") : undefined;
  if (!sparseArgs) return undefined;
  const [, componentsName] = splitTypeArgs(sparseArgs);
  const components = componentsName
    ? ctx.layouts.constShapes.get(componentsName.trim())
    : undefined;
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

function lowerPrivateProductCallInline(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  options: { deadProductArgs?: Set<number> } = {},
): Instr[] | undefined {
  if (ctx.optMode !== "release" || expr.callee.kind !== "var") return undefined;
  if (!ctx.currentFn || ctx.currentFn.public) return undefined;
  const callee = ctx.functions.get(expr.callee.name);
  if (!callee || callee.public || callee.name === ctx.currentFn?.name) return undefined;
  if (callee.name.includes("InlineArray")) return undefined;
  if (ctx.inlineStack?.has(callee.name)) return undefined;
  if (callee.params.some((param) => param.const) || !callee.returnType) return undefined;
  if (flattenType(callee.returnType, ctx.layouts).length <= 1) return undefined;
  if (hasRuntimeEffect(callee.body, ctx.functions)) return undefined;
  const argOffset = Math.max(0, expr.args.length - callee.params.length);
  const runtimeArgs = expr.args.slice(argOffset);
  if (runtimeArgs.length !== callee.params.length) return undefined;
  const calleeTailCalls = analyzeTailCalls(callee);

  const prefix = `__inl_${callee.name.replaceAll(/[^A-Za-z0-9_]/g, "_")}_${ctx.tempIndex++}`;
  const renames = new Map<string, string>();
  const aliasedScalarParams = new Set<string>();
  const aliasedProductParams = new Set<string>();
  const deadAliasedProductParams = new Set<string>();
  const canAliasProducts = canAliasReadOnlyProductParams(callee, ctx);
  const deadProductBases = new Set(
    [...(options.deadProductArgs ?? [])].map((index) => {
      const arg = runtimeArgs[index];
      return arg?.kind === "var" ? baseName(arg.name) : "";
    }).filter(Boolean),
  );
  callee.params.forEach((param, index) => {
    const arg = runtimeArgs[index];
    if (
      !calleeTailCalls.hasDirectSelfCall &&
      arg?.kind === "var" &&
      flattenType(param.type, ctx.layouts).length === 1 &&
      !deadProductBases.has(baseName(arg.name))
    ) {
      renames.set(param.name, arg.name);
      aliasedScalarParams.add(param.name);
    } else if (
      (canAliasProducts || options.deadProductArgs?.has(index)) &&
      arg?.kind === "var" &&
      flattenType(param.type, ctx.layouts).length > 1
    ) {
      renames.set(param.name, arg.name);
      aliasedProductParams.add(param.name);
      if (options.deadProductArgs?.has(index)) deadAliasedProductParams.add(param.name);
    } else {
      renames.set(param.name, `${prefix}_${param.name}`);
    }
  });
  const currentParamSlots = new Set(
    (ctx.currentFn?.params ?? []).flatMap((param) =>
      flattenBinding(param.name, param.type, ctx.layouts).map((slot) => slot.name)
    ),
  );
  callee.params.forEach((param, index) => {
    if (!aliasedProductParams.has(param.name)) return;
    const arg = runtimeArgs[index];
    if (arg?.kind !== "var") return;
    for (const binding of flattenBinding(arg.name, param.type, ctx.layouts)) {
      if (currentParamSlots.has(binding.name)) continue;
      locals.add(binding.name);
      if (!ctx.tempLocals.some((local) => local.name === binding.name)) {
        ctx.tempLocals.push({ name: binding.name, type: binding.wat });
      }
    }
  });
  const renamed = renameFunctionLocals(callee, renames);
  const scratchArrays = renamedScratchPlans(
    ctx.scratchPlansByFunction?.get(callee.name),
    renames,
  );
  const packedArrays = renamedPackedPlans(
    ctx.packedPlansByFunction?.get(callee.name),
    renames,
  );
  const localSlotArrays = renamedLocalSlotPlans(
    ctx.localSlotPlansByFunction?.get(callee.name),
    renames,
  );
  const inlineCtx: LowerContext = {
    ...ctx,
    currentFn: renamed,
    localTypes: new Map(renamed.params.map((param) => [param.name, param.type])),
    inlineStack: new Set([...(ctx.inlineStack ?? []), callee.name]),
    deadProductBases: new Set([
      ...(ctx.deadProductBases ?? []),
      ...[...deadAliasedProductParams].map((param) => renames.get(param) ?? param).map(baseName),
    ]),
    scratchArrays,
    packedArrays,
    localSlotArrays,
    fixedArrayTransformerAliases: new Map(),
  };
  const paramBindings = renamed.params.flatMap((param, index) =>
    aliasedScalarParams.has(callee.params[index]?.name ?? "") ||
      aliasedProductParams.has(callee.params[index]?.name ?? "")
      ? []
      : flattenBinding(param.name, param.type, ctx.layouts)
  );
  for (const binding of paramBindings) {
    locals.add(binding.name);
    ctx.tempLocals.push({ name: binding.name, type: binding.wat });
  }
  for (const plan of packedArrays?.values() ?? []) {
    const name = packedArrayLocalName(plan.name);
    if (!locals.has(name) && !ctx.tempLocals.some((item) => item.name === name)) {
      locals.add(name);
      ctx.tempLocals.push({ name, type: plan.packedType });
    }
  }
  for (const local of collectIrLocals(renamed.body, inlineCtx)) {
    if (locals.has(local.name) || ctx.tempLocals.some((item) => item.name === local.name)) continue;
    locals.add(local.name);
    ctx.tempLocals.push(local);
  }

  const tailCalls = analyzeTailCalls(renamed);
  const body = tailCalls.hasOnlyTailDirectSelfCalls
    ? lowerTailLoopBlock(renamed.body, renamed, inlineCtx, locals)
    : lowerBlock(renamed.body, inlineCtx, locals, renamed.returnType);
  const scratchPrologue = [...(scratchArrays?.values() ?? [])].flatMap((plan) =>
    lowerScratchArrayInit(plan)
  );
  const packedPrologue = [...(packedArrays?.values() ?? [])].flatMap((plan) =>
    lowerPackedArrayInit(plan)
  );
  const forwarded = forwardedDeadProductCallInline(
    renamed.body,
    inlineCtx,
    locals,
    new Set(
      [...aliasedProductParams].map((param) => renames.get(param) ?? param).map(baseName),
    ),
  );
  return [
    ...runtimeArgs.flatMap((arg, index) =>
      aliasedScalarParams.has(callee.params[index]?.name ?? "") ||
        aliasedProductParams.has(callee.params[index]?.name ?? "")
        ? []
        : lowerExpr(arg, ctx, locals, callee.params[index]?.type)
    ),
    ...paramBindings.toReversed().map((binding): Instr => ({
      op: "local.set",
      name: binding.name,
    })),
    ...scratchPrologue,
    ...packedPrologue,
    ...(forwarded ?? body),
  ];
}

function forwardedDeadProductCallInline(
  body: BlockExpr,
  ctx: LowerContext,
  locals: Set<string>,
  deadProductBases: Set<string>,
): Instr[] | undefined {
  if (!deadProductBases.size || body.statements.length > 0 || body.expr?.kind !== "call") {
    return undefined;
  }
  const call = body.expr;
  if (call.callee.kind !== "var") return undefined;
  const callee = ctx.functions.get(call.callee.name);
  if (!callee) return undefined;
  const argOffset = Math.max(0, call.args.length - callee.params.length);
  const runtimeArgs = call.args.slice(argOffset);
  const deadProductArgs = new Set<number>();
  for (const [index, param] of callee.params.entries()) {
    const arg = runtimeArgs[index];
    if (
      arg?.kind === "var" &&
      deadProductBases.has(baseName(arg.name)) &&
      flattenType(param.type, ctx.layouts).length > 1
    ) {
      deadProductArgs.add(index);
    }
  }
  return deadProductArgs.size
    ? lowerPrivateProductCallInline(call, ctx, locals, { deadProductArgs })
    : undefined;
}

function contextDeadProductArgIndexes(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
): Set<number> {
  if (expr.callee.kind !== "var" || !ctx.deadProductBases?.size) return new Set();
  const callee = ctx.functions.get(expr.callee.name);
  if (!callee) return new Set();
  const argOffset = Math.max(0, expr.args.length - callee.params.length);
  const runtimeArgs = expr.args.slice(argOffset);
  const baseCounts = new Map<string, number>();
  for (const [index, param] of callee.params.entries()) {
    const arg = runtimeArgs[index];
    if (arg?.kind !== "var" || flattenType(param.type, ctx.layouts).length <= 1) continue;
    const base = baseName(arg.name);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const dead = new Set<number>();
  for (const [index, param] of callee.params.entries()) {
    const arg = runtimeArgs[index];
    if (arg?.kind !== "var" || flattenType(param.type, ctx.layouts).length <= 1) continue;
    const base = baseName(arg.name);
    if (ctx.deadProductBases.has(base) && (baseCounts.get(base) ?? 0) === 1) dead.add(index);
  }
  return dead;
}

function canAliasReadOnlyProductParams(callee: FnDecl, ctx: LowerContext): boolean {
  if (hasSelfCall(callee.body, callee.name)) return false;
  for (const name of calledFunctions(callee.body)) {
    const fn = ctx.functions.get(name);
    if (fn?.returnType && flattenType(fn.returnType, ctx.layouts).length > 1) return false;
  }
  let mutatesFixedArray = false;
  const visit = (expr: Expr | undefined) => {
    if (!expr || mutatesFixedArray) return;
    if (
      fixedArrayUpdateCall(expr, ctx) || fixedArraySwapCall(expr, ctx) ||
      fixedArraySpreadUpdateExpr(expr)
    ) {
      mutatesFixedArray = true;
      return;
    }
    for (const child of exprChildren(expr)) visit(child);
  };
  visit(callee.body);
  return !mutatesFixedArray;
}

const SCALAR_BACKEND_INLINE_COST_BUDGET = 18;

function lowerPrivateScalarCallInline(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (ctx.optMode !== "release" || expr.callee.kind !== "var") return undefined;
  if (!ctx.currentFn) return undefined;
  if (ctx.currentFn.public) return undefined;
  const callee = ctx.functions.get(expr.callee.name);
  if (!callee || callee.public || callee.name === ctx.currentFn.name) return undefined;
  if (ctx.inlineStack?.has(callee.name)) return undefined;
  if (callee.params.some((param) => param.const) || !callee.returnType) return undefined;
  if (flattenType(callee.returnType, ctx.layouts).length !== 1) return undefined;
  if (hasRuntimeEffect(callee.body, ctx.functions)) return undefined;
  if (hasSelfCall(callee.body, callee.name)) return undefined;
  if (backendInlineBlockCost(callee.body) > SCALAR_BACKEND_INLINE_COST_BUDGET) return undefined;
  const argOffset = Math.max(0, expr.args.length - callee.params.length);
  const runtimeArgs = expr.args.slice(argOffset);
  if (runtimeArgs.length !== callee.params.length) return undefined;

  const prefix = `__inl_${callee.name.replaceAll(/[^A-Za-z0-9_]/g, "_")}_${ctx.tempIndex++}`;
  const renames = new Map<string, string>();
  for (const param of callee.params) renames.set(param.name, `${prefix}_${param.name}`);
  const renamed = renameFunctionLocals(callee, renames);
  const localSlotArrays = renamedLocalSlotPlans(
    ctx.localSlotPlansByFunction?.get(callee.name),
    renames,
  );
  const inlineCtx: LowerContext = {
    ...ctx,
    currentFn: renamed,
    localTypes: new Map(renamed.params.map((param) => [param.name, param.type])),
    inlineStack: new Set([...(ctx.inlineStack ?? []), callee.name]),
    localSlotArrays,
  };
  const paramBindings = renamed.params.flatMap((param) =>
    flattenBinding(param.name, param.type, ctx.layouts)
  );
  for (const binding of paramBindings) {
    locals.add(binding.name);
    ctx.tempLocals.push({ name: binding.name, type: binding.wat });
  }
  for (const local of collectIrLocals(renamed.body, inlineCtx)) {
    if (locals.has(local.name) || ctx.tempLocals.some((item) => item.name === local.name)) continue;
    locals.add(local.name);
    ctx.tempLocals.push(local);
  }

  return [
    ...runtimeArgs.flatMap((arg, index) => lowerExpr(arg, ctx, locals, callee.params[index]?.type)),
    ...paramBindings.toReversed().map((binding): Instr => ({
      op: "local.set",
      name: binding.name,
    })),
    ...lowerBlock(renamed.body, inlineCtx, locals, expectedType ?? renamed.returnType),
  ];
}

function backendInlineBlockCost(block: BlockExpr): number {
  return block.statements.reduce((sum, stmt) => sum + backendInlineStatementCost(stmt), 0) +
    (block.expr ? backendInlineExprCost(block.expr) : 0);
}

function backendInlineStatementCost(stmt: Statement): number {
  if (stmt.kind === "proof_const") return 0;
  return 1 + backendInlineExprCost(stmt.value);
}

function backendInlineExprCost(expr: Expr): number {
  switch (expr.kind) {
    case "do":
      return 100;
    case "const_fn":
      return 1 + backendInlineExprCost(expr.body);
    case "call":
      return 2 + backendInlineExprCost(expr.callee) +
        expr.args.reduce((sum, arg) => sum + backendInlineExprCost(arg), 0);
    case "index":
      return 2 + backendInlineExprCost(expr.target) + backendInlineExprCost(expr.index);
    case "binary":
      return 1 + backendInlineExprCost(expr.left) + backendInlineExprCost(expr.right);
    case "pipe_bind":
      return 1 + backendInlineExprCost(expr.value) + backendInlineExprCost(expr.body);
    case "match":
      return 2 + backendInlineExprCost(expr.value) +
        expr.arms.reduce((sum, arm) => sum + backendInlineExprCost(arm.value), 0);
    case "shape":
    case "product_constructor":
      return 1 +
        expr.slots.reduce(
          (sum, slot) =>
            sum + (slot.index ? backendInlineExprCost(slot.index) : 0) +
            backendInlineExprCost(slot.value),
          0,
        );
    case "static_for_slots":
      return 4 + backendInlineExprCost(expr.value);
    case "range":
      return 1 + backendInlineExprCost(expr.start) + backendInlineExprCost(expr.end);
    case "field":
      return 1 + backendInlineExprCost(expr.value) + backendInlineExprCost(expr.key);
    case "block":
      return backendInlineBlockCost(expr);
    case "literal":
    case "var":
    case "placeholder":
      return 1;
  }
}

function renamedScratchPlans(
  plans: Map<string, ScratchArrayPlan> | undefined,
  renames: Map<string, string>,
): Map<string, ScratchArrayPlan> | undefined {
  if (!plans?.size) return plans;
  return new Map(
    [...plans].map(([name, plan]) => {
      const renamed = renameDottedName(name, renames);
      return [renamed, { ...plan, name: renamed }];
    }),
  );
}

function renamedPackedPlans(
  plans: Map<string, PackedArrayPlan> | undefined,
  renames: Map<string, string>,
): Map<string, PackedArrayPlan> | undefined {
  if (!plans?.size) return plans;
  return new Map(
    [...plans].map(([name, plan]) => {
      const renamed = renameDottedName(name, renames);
      return [renamed, { ...plan, name: renamed }];
    }),
  );
}

function renamedLocalSlotPlans(
  plans: Map<string, LocalSlotArrayPlan> | undefined,
  renames: Map<string, string>,
): Map<string, LocalSlotArrayPlan> | undefined {
  if (!plans?.size) return plans;
  return new Map(
    [...plans].map(([name, plan]) => {
      const renamed = renameDottedName(name, renames);
      return [renamed, { ...plan, name: renamed }];
    }),
  );
}

function renameDottedName(name: string, renames: Map<string, string>): string {
  const base = baseName(name);
  const renamed = renames.get(base);
  return renamed ? `${renamed}${name.slice(base.length)}` : name;
}

function renameFunctionLocals(fn: FnDecl, renames: Map<string, string>): FnDecl {
  const params = fn.params.map((param) => ({
    ...param,
    name: renames.get(param.name) ?? param.name,
  }));
  return { ...fn, params, body: renameBlock(fn.body, renames) };
}

function renameBlock(block: BlockExpr, renames: Map<string, string>): BlockExpr {
  const scoped = new Map(renames);
  const statements = block.statements.map((stmt) => renameStatement(stmt, scoped));
  return {
    ...block,
    statements,
    ...(block.expr ? { expr: renameExpr(block.expr, scoped) } : {}),
  };
}

function renameStatement(stmt: Statement, renames: Map<string, string>): Statement {
  if (stmt.kind === "let") {
    const value = renameExpr(stmt.value, renames);
    const name = renames.get(stmt.name) ?? `${[...renames.values()][0] ?? "__inl"}_${stmt.name}`;
    renames.set(stmt.name, name);
    return { ...stmt, name, value };
  }
  if (stmt.kind === "destructure_let") {
    const value = renameExpr(stmt.value, renames);
    const names = stmt.names.map((item) => {
      const name = renames.get(item) ?? `${[...renames.values()][0] ?? "__inl"}_${item}`;
      renames.set(item, name);
      return name;
    });
    return { ...stmt, names, value };
  }
  return stmt;
}

function renameExpr(expr: Expr, renames: Map<string, string>): Expr {
  switch (expr.kind) {
    case "do":
      return { ...expr, expr: expr.expr ? renameExpr(expr.expr, renames) : undefined };
    case "const_fn":
      return { ...expr, body: renameExpr(expr.body, renames) };
    case "var":
      return renameVarExpr(expr, renames);
    case "call":
      return {
        ...expr,
        callee: renameExpr(expr.callee, renames),
        args: expr.args.map((arg) => renameExpr(arg, renames)),
      };
    case "index":
      return {
        ...expr,
        target: renameExpr(expr.target, renames),
        index: renameExpr(expr.index, renames),
      };
    case "binary":
      return {
        ...expr,
        left: renameExpr(expr.left, renames),
        right: renameExpr(expr.right, renames),
      };
    case "pipe_bind": {
      const value = renameExpr(expr.value, renames);
      const scoped = new Map(renames);
      const name = scoped.get(expr.name) ?? `${[...renames.values()][0] ?? "__inl"}_${expr.name}`;
      scoped.set(expr.name, name);
      return { ...expr, value, name, body: renameExpr(expr.body, scoped) };
    }
    case "match":
      return {
        ...expr,
        value: renameExpr(expr.value, renames),
        arms: expr.arms.map((arm) => {
          const scoped = new Map(renames);
          return {
            ...arm,
            pattern: renamePattern(arm.pattern, scoped),
            value: renameExpr(arm.value, scoped),
          };
        }),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          ...(slot.index ? { index: renameExpr(slot.index, renames) } : {}),
          value: renameExpr(slot.value, renames),
        })),
      };
    case "range":
      return {
        ...expr,
        start: renameExpr(expr.start, renames),
        end: renameExpr(expr.end, renames),
      };
    case "static_for_slots": {
      const scoped = new Map(renames);
      const iterator = scoped.get(expr.iterator) ??
        `${[...renames.values()][0] ?? "__inl"}_${expr.iterator}`;
      scoped.set(expr.iterator, iterator);
      const valueIterator = expr.valueIterator
        ? scoped.get(expr.valueIterator) ??
          `${[...renames.values()][0] ?? "__inl"}_${expr.valueIterator}`
        : undefined;
      if (expr.valueIterator && valueIterator) scoped.set(expr.valueIterator, valueIterator);
      return {
        ...expr,
        iterator,
        ...(valueIterator ? { valueIterator } : {}),
        value: renameExpr(expr.value, scoped),
      };
    }
    case "field":
      return {
        ...expr,
        value: renameExpr(expr.value, renames),
        key: renameExpr(expr.key, renames),
      };
    case "block":
      return renameBlock(expr, new Map(renames));
    case "literal":
    case "placeholder":
      return expr;
  }
}

function renameVarExpr(expr: Extract<Expr, { kind: "var" }>, renames: Map<string, string>): Expr {
  const name = renameDottedName(expr.name, renames);
  return name === expr.name ? expr : { ...expr, name };
}

function renamePattern(pattern: ParamPattern, renames: Map<string, string>): ParamPattern {
  switch (pattern.kind) {
    case "binding": {
      const name = renames.get(pattern.name) ??
        `${[...renames.values()][0] ?? "__inl"}_${pattern.name}`;
      renames.set(pattern.name, name);
      return { ...pattern, name };
    }
    case "tuple":
      return { ...pattern, items: pattern.items.map((item) => renamePattern(item, renames)) };
    case "constructor":
      return { ...pattern, args: pattern.args.map((item) => renamePattern(item, renames)) };
    case "literal":
    case "wildcard":
    case "type":
      return pattern;
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
    const storageTarget = fieldTarget;
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

function lowerRuntimeInlineArrayIndex(
  target: string,
  index: Expr,
  capacity: number,
  itemType: string,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const localSlot = localSlotPlanForName(target, ctx.localSlotArrays);
  if (localSlot) return lowerLocalSlotArrayLoad(localSlot, index, ctx, locals);
  const packed = packedPlanForName(target, ctx.packedArrays);
  if (packed) return lowerPackedArrayLoad(packed, index, ctx, locals);
  const scratch = ctx.scratchArrays?.get(target);
  if (scratch) return lowerScratchArrayLoad(scratch, index, ctx, locals);
  const fallback = lowerVar(`${target}[${Math.max(0, capacity - 1)}]`, ctx, locals, itemType);
  const flattened = flattenType(itemType, ctx.layouts).map((slot) => slot.wat);
  if (flattened.length === 1 && isSelectableValueType(flattened[0])) {
    const cached = cacheRepeatedIndex(index, ctx, locals);
    return [
      ...cached.prefix,
      ...lowerScalarInlineArraySelectChain(
        target,
        cached.index,
        capacity,
        itemType,
        flattened[0],
        ctx,
        locals,
      ),
    ];
  }
  const results = fallback.length > flattened.length
    ? fallback.map(() => "i32" as const)
    : flattened;
  const cached = cacheRepeatedIndex(index, ctx, locals);
  let body = fallback;
  for (let item = capacity - 2; item >= 0; item--) {
    body = [
      ...lowerExpr(cached.index, ctx, locals, "i32"),
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
  return [...cached.prefix, ...body];
}

function lowerScalarInlineArraySelectChain(
  target: string,
  index: Expr,
  capacity: number,
  itemType: string,
  type: ValueType,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  let body = lowerVar(`${target}[${Math.max(0, capacity - 1)}]`, ctx, locals, itemType);
  for (let item = capacity - 2; item >= 0; item--) {
    body = [
      ...lowerVar(`${target}[${item}]`, ctx, locals, itemType),
      ...body,
      ...lowerExpr(index, ctx, locals, "i32"),
      { op: "const", type: "i32", value: item },
      { op: "binary", wasm: "i32.eq" },
      { op: "select", type },
    ];
  }
  return body;
}

function cacheRepeatedIndex(
  index: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): { prefix: Instr[]; index: Expr } {
  if (index.kind === "var" || index.kind === "literal") return { prefix: [], index };
  const name = `__index_tmp${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name, type: "i32" });
  locals.add(name);
  return {
    prefix: [
      ...lowerExpr(index, ctx, locals, "i32"),
      { op: "local.set", name },
    ],
    index: { kind: "var", name },
  };
}

function isSelectableValueType(type: ValueType | undefined): type is ValueType {
  return type === "i32" || type === "i64" || type === "f32" || type === "f64";
}

function packedArrayPlan(
  name: string,
  capacity: number,
  itemType: string,
  layouts: LayoutEnv,
): PackedArrayPlan | undefined {
  const bitWidth = packedArrayItemBitWidth(itemType);
  if (!Number.isFinite(capacity) || capacity <= 0 || !bitWidth) return undefined;
  const totalBits = capacity * bitWidth;
  if (totalBits > 64) return undefined;
  const itemSlots = flattenType(itemType, layouts);
  const valueType = itemSlots[0]?.wat;
  if (itemSlots.length !== 1 || (valueType !== "i32" && valueType !== "i64")) return undefined;
  return {
    name,
    capacity,
    itemType,
    valueType,
    packedType: totalBits <= 32 ? "i32" : "i64",
    bitWidth,
  };
}

function localSlotArrayPlan(
  name: string,
  capacity: number,
  itemType: string,
  layouts: LayoutEnv,
): LocalSlotArrayPlan | undefined {
  const itemSlots = flattenType(itemType, layouts);
  const valueType = itemSlots[0]?.wat;
  if (
    !Number.isFinite(capacity) || capacity <= 0 || itemSlots.length !== 1 ||
    !isSelectableValueType(valueType)
  ) return undefined;
  return { name, capacity, itemType, valueType };
}

function packedArrayItemBitWidth(type: string): number | undefined {
  if (type === "bool") return 1;
  return unsignedBitWidth(type);
}

function valueTypeByteSize(type: ValueType): number {
  if (type === "i64" || type === "f64") return 8;
  if (type === "v128") return 16;
  return 4;
}

function lowerScratchArrayInit(plan: ScratchArrayPlan): Instr[] {
  return Array.from({ length: plan.capacity }, (_, index): Instr[] => [
    ...lowerScratchArrayAddress(plan, staticIndexExpr(index), undefined, undefined),
    { op: "local.get", name: scratchArrayLocalSlotName(plan.name, index) },
    { op: "store", type: plan.valueType, align: plan.align, offset: 0, memory: "fig_buffers" },
  ]).flat();
}

function lowerScratchArrayMaterialize(
  plan: ScratchArrayPlan,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  return Array.from(
    { length: plan.capacity },
    (_, index) => lowerScratchArrayLoad(plan, staticIndexExpr(index), ctx, locals),
  ).flat();
}

function lowerScratchArrayLoad(
  plan: ScratchArrayPlan,
  index: Expr,
  ctx: LowerContext | undefined,
  locals: Set<string> | undefined,
): Instr[] {
  return [
    ...lowerScratchArrayAddress(plan, index, ctx, locals),
    { op: "load", type: plan.valueType, align: plan.align, offset: 0, memory: "fig_buffers" },
  ];
}

function lowerScratchArrayStore(
  plan: ScratchArrayPlan,
  index: Expr,
  value: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  ensureLoweringLocals(value, ctx, locals);
  return [
    ...lowerScratchArrayAddress(plan, index, ctx, locals),
    ...lowerExpr(value, ctx, locals, plan.itemType),
    { op: "store", type: plan.valueType, align: plan.align, offset: 0, memory: "fig_buffers" },
  ];
}

function lowerScratchArrayUpdate(
  plan: ScratchArrayPlan,
  update: FixedArrayUpdateCall,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  ensureLoweringLocals(update.value, ctx, locals);
  const cachedIndex = cacheRepeatedIndex(update.index, ctx, locals);
  const valueName = `__scratch_update_value${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: valueName, type: update.valueType });
  locals.add(valueName);
  return [
    ...cachedIndex.prefix,
    ...lowerExpr(update.value, ctx, locals, plan.itemType),
    { op: "local.set", name: valueName },
    ...lowerScratchArrayAddress(plan, cachedIndex.index, ctx, locals),
    { op: "local.get", name: valueName },
    { op: "store", type: plan.valueType, align: plan.align, offset: 0, memory: "fig_buffers" },
  ];
}

function lowerScratchArrayAddress(
  plan: ScratchArrayPlan,
  index: Expr,
  ctx: LowerContext | undefined,
  locals: Set<string> | undefined,
): Instr[] {
  const literal = staticIntegerLiteral(index);
  if (literal !== undefined) {
    return [{ op: "const", type: "i32", value: plan.offset + literal * plan.byteSize }];
  }
  if (!ctx || !locals) return [{ op: "const", type: "i32", value: plan.offset }];
  return [
    { op: "const", type: "i32", value: plan.offset },
    ...lowerExpr(index, ctx, locals, "i32"),
    { op: "const", type: "i32", value: plan.byteSize },
    { op: "binary", wasm: "i32.mul" },
    { op: "binary", wasm: "i32.add" },
  ];
}

function lowerLocalSlotArrayMaterialize(
  plan: LocalSlotArrayPlan,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  return Array.from(
    { length: plan.capacity },
    (_, index) => lowerLocalSlotArrayLoad(plan, staticIndexExpr(index), ctx, locals),
  ).flat();
}

function lowerLocalSlotArrayLoad(
  plan: LocalSlotArrayPlan,
  index: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const literal = staticIntegerLiteral(index);
  if (literal !== undefined) {
    return lowerVar(localSlotArraySlotName(plan.name, literal), ctx, locals, plan.itemType);
  }
  const cached = cacheRepeatedIndex(index, ctx, locals);
  return [
    ...cached.prefix,
    ...lowerScalarInlineArraySelectChain(
      plan.name,
      cached.index,
      plan.capacity,
      plan.itemType,
      plan.valueType,
      ctx,
      locals,
    ),
  ];
}

function lowerLocalSlotArrayStore(
  plan: LocalSlotArrayPlan,
  index: Expr,
  value: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  ensureLoweringLocals(value, ctx, locals);
  const cachedIndex = cacheRepeatedIndex(index, ctx, locals);
  const valueName = `__fixed_local_slot_value${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: valueName, type: plan.valueType });
  locals.add(valueName);
  return [
    ...cachedIndex.prefix,
    ...lowerExpr(value, ctx, locals, plan.itemType),
    { op: "local.set", name: valueName },
    ...Array.from({ length: plan.capacity }, (_, item): Instr[] => [
      { op: "local.get", name: valueName },
      ...lowerVar(localSlotArraySlotName(plan.name, item), ctx, locals, plan.itemType),
      ...lowerExpr(cachedIndex.index, ctx, locals, "i32"),
      { op: "const", type: "i32", value: item },
      { op: "binary", wasm: "i32.eq" },
      { op: "select", type: plan.valueType },
      { op: "local.set", name: localSlotArraySlotName(plan.name, item) },
    ]).flat(),
  ];
}

function lowerLocalSlotArrayUpdateStore(
  plan: LocalSlotArrayPlan,
  update: FixedArrayUpdateCall,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const rmw = fixedArrayReadModifyWrite(update);
  if (!rmw) return lowerLocalSlotArrayStore(plan, update.index, update.value, ctx, locals);
  const cachedIndex = cacheRepeatedIndex(update.index, ctx, locals);
  const oldName = `__fixed_local_slot_old${ctx.tempIndex++}`;
  const valueName = `__fixed_local_slot_value${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: oldName, type: plan.valueType });
  ctx.tempLocals.push({ name: valueName, type: plan.valueType });
  locals.add(oldName);
  locals.add(valueName);
  const updated = substituteExpr(
    rmw.value,
    new Map([[rmw.oldName, { kind: "var", name: oldName }]]),
  );
  return [
    ...cachedIndex.prefix,
    ...lowerLocalSlotArrayLoad(plan, cachedIndex.index, ctx, locals),
    { op: "local.set", name: oldName },
    ...lowerExpr(updated, ctx, locals, plan.itemType),
    { op: "local.set", name: valueName },
    ...Array.from({ length: plan.capacity }, (_, item): Instr[] => [
      { op: "local.get", name: valueName },
      ...lowerVar(localSlotArraySlotName(plan.name, item), ctx, locals, plan.itemType),
      ...lowerExpr(cachedIndex.index, ctx, locals, "i32"),
      { op: "const", type: "i32", value: item },
      { op: "binary", wasm: "i32.eq" },
      { op: "select", type: plan.valueType },
      { op: "local.set", name: localSlotArraySlotName(plan.name, item) },
    ]).flat(),
  ];
}

function lowerPackedArrayInit(plan: PackedArrayPlan): Instr[] {
  const packed = Array.from({ length: plan.capacity }, (_, index) =>
    lowerPackedArraySlotValue(
      plan,
      [{ op: "local.get", name: scratchArrayLocalSlotName(plan.name, index) }],
      index * plan.bitWidth,
    ));
  const value = packed.reduce(
    (body, slot) =>
      body.length
        ? [...body, ...slot, { op: "binary", wasm: `${plan.packedType}.or` } as Instr]
        : slot,
    [] as Instr[],
  );
  return [
    ...(value.length ? value : [{ op: "const", type: plan.packedType, value: 0 } as Instr]),
    { op: "local.set", name: packedArrayLocalName(plan.name) },
  ];
}

function lowerPackedArrayMaterialize(
  plan: PackedArrayPlan,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  return Array.from(
    { length: plan.capacity },
    (_, index) => lowerPackedArrayLoad(plan, staticIndexExpr(index), ctx, locals),
  ).flat();
}

function lowerPackedArrayLoad(
  plan: PackedArrayPlan,
  index: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const literal = staticIntegerLiteral(index);
  const shifted: Instr[] = literal !== undefined
    ? [
      { op: "local.get", name: packedArrayLocalName(plan.name) },
      ...(literal * plan.bitWidth === 0 ? [] : [
        { op: "const", type: "i32", value: literal * plan.bitWidth } as Instr,
        { op: "binary", wasm: `${plan.packedType}.shr_u` } as Instr,
      ]),
    ]
    : [
      { op: "local.get", name: packedArrayLocalName(plan.name) },
      ...lowerExpr(index, ctx, locals, "i32"),
      { op: "const", type: "i32", value: plan.bitWidth },
      { op: "binary", wasm: "i32.mul" },
      { op: "binary", wasm: `${plan.packedType}.shr_u` },
    ];
  return lowerPackedArrayValueToItem(plan, maskValue(shifted, plan.packedType, plan.bitWidth));
}

function lowerPackedArrayStore(
  plan: PackedArrayPlan,
  index: Expr,
  value: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  ensureLoweringLocals(value, ctx, locals);
  const cachedIndex = cacheRepeatedIndex(index, ctx, locals);
  const shiftName = `__fixed_array_packed_shift${ctx.tempIndex++}`;
  const valueName = `__fixed_array_packed_value${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: shiftName, type: "i32" });
  ctx.tempLocals.push({ name: valueName, type: plan.packedType });
  locals.add(shiftName);
  locals.add(valueName);
  const mask = packedMaskInstr(plan.packedType, plan.bitWidth);
  return [
    ...cachedIndex.prefix,
    ...lowerExpr(cachedIndex.index, ctx, locals, "i32"),
    { op: "const", type: "i32", value: plan.bitWidth },
    { op: "binary", wasm: "i32.mul" },
    { op: "local.set", name: shiftName },
    ...lowerPackedArrayValueToPacked(
      plan,
      lowerExpr(value, ctx, locals, plan.itemType),
      packedArrayValueAlreadyMasked(value, plan, ctx),
    ),
    { op: "local.set", name: valueName },
    { op: "local.get", name: packedArrayLocalName(plan.name) },
    { op: "const", type: plan.packedType, value: -1 },
    mask,
    { op: "local.get", name: shiftName },
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "binary", wasm: `${plan.packedType}.xor` },
    { op: "binary", wasm: `${plan.packedType}.and` },
    { op: "local.get", name: valueName },
    { op: "local.get", name: shiftName },
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "binary", wasm: `${plan.packedType}.or` },
    { op: "local.set", name: packedArrayLocalName(plan.name) },
  ];
}

function lowerPackedArrayUpdateStore(
  plan: PackedArrayPlan,
  update: FixedArrayUpdateCall,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const rmw = fixedArrayReadModifyWrite(update);
  if (!rmw) return lowerPackedArrayStore(plan, update.index, update.value, ctx, locals);
  const cachedIndex = cacheRepeatedIndex(update.index, ctx, locals);
  const shiftName = `__fixed_array_packed_shift${ctx.tempIndex++}`;
  const oldName = `__fixed_array_packed_old${ctx.tempIndex++}`;
  const valueName = `__fixed_array_packed_value${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: shiftName, type: "i32" });
  ctx.tempLocals.push({ name: oldName, type: plan.valueType });
  ctx.tempLocals.push({ name: valueName, type: plan.packedType });
  locals.add(shiftName);
  locals.add(oldName);
  locals.add(valueName);
  const mask = packedMaskInstr(plan.packedType, plan.bitWidth);
  const updated = substituteExpr(
    rmw.value,
    new Map([[rmw.oldName, { kind: "var", name: oldName }]]),
  );
  return [
    ...cachedIndex.prefix,
    ...lowerExpr(cachedIndex.index, ctx, locals, "i32"),
    { op: "const", type: "i32", value: plan.bitWidth },
    { op: "binary", wasm: "i32.mul" },
    { op: "local.set", name: shiftName },
    ...lowerPackedArrayValueToItem(
      plan,
      maskValue(
        [
          { op: "local.get", name: packedArrayLocalName(plan.name) },
          { op: "local.get", name: shiftName },
          { op: "binary", wasm: `${plan.packedType}.shr_u` },
        ],
        plan.packedType,
        plan.bitWidth,
      ),
    ),
    { op: "local.set", name: oldName },
    ...lowerPackedArrayValueToPacked(
      plan,
      lowerExpr(updated, ctx, locals, plan.itemType),
      packedArrayValueAlreadyMasked(updated, plan, ctx),
    ),
    { op: "local.set", name: valueName },
    { op: "local.get", name: packedArrayLocalName(plan.name) },
    ...lowerPackedArrayValueToPacked(
      plan,
      [{ op: "local.get", name: oldName }],
      true,
    ),
    { op: "local.get", name: valueName },
    { op: "binary", wasm: `${plan.packedType}.xor` },
    { op: "local.get", name: shiftName },
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "binary", wasm: `${plan.packedType}.xor` },
    { op: "local.set", name: packedArrayLocalName(plan.name) },
  ];
}

function lowerPackedArraySwapStore(
  plan: PackedArrayPlan,
  left: Expr,
  right: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const cachedLeft = cacheRepeatedIndex(left, ctx, locals);
  const cachedRight = cacheRepeatedIndex(right, ctx, locals);
  const leftShift = `__fixed_array_packed_left_shift${ctx.tempIndex++}`;
  const rightShift = `__fixed_array_packed_right_shift${ctx.tempIndex++}`;
  const delta = `__fixed_array_packed_swap_delta${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: leftShift, type: "i32" });
  ctx.tempLocals.push({ name: rightShift, type: "i32" });
  ctx.tempLocals.push({ name: delta, type: plan.packedType });
  locals.add(leftShift);
  locals.add(rightShift);
  locals.add(delta);
  const mask = packedMaskInstr(plan.packedType, plan.bitWidth);
  return [
    ...cachedLeft.prefix,
    ...cachedRight.prefix,
    ...lowerExpr(cachedLeft.index, ctx, locals, "i32"),
    { op: "const", type: "i32", value: plan.bitWidth },
    { op: "binary", wasm: "i32.mul" },
    { op: "local.set", name: leftShift },
    ...lowerExpr(cachedRight.index, ctx, locals, "i32"),
    { op: "const", type: "i32", value: plan.bitWidth },
    { op: "binary", wasm: "i32.mul" },
    { op: "local.set", name: rightShift },
    ...maskValue(
      [
        { op: "local.get", name: packedArrayLocalName(plan.name) },
        { op: "local.get", name: leftShift },
        { op: "binary", wasm: `${plan.packedType}.shr_u` },
      ],
      plan.packedType,
      plan.bitWidth,
    ),
    ...maskValue(
      [
        { op: "local.get", name: packedArrayLocalName(plan.name) },
        { op: "local.get", name: rightShift },
        { op: "binary", wasm: `${plan.packedType}.shr_u` },
      ],
      plan.packedType,
      plan.bitWidth,
    ),
    { op: "binary", wasm: `${plan.packedType}.xor` },
    { op: "local.set", name: delta },
    { op: "local.get", name: packedArrayLocalName(plan.name) },
    { op: "local.get", name: delta },
    { op: "local.get", name: leftShift },
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "local.get", name: delta },
    { op: "local.get", name: rightShift },
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "binary", wasm: `${plan.packedType}.or` },
    { op: "binary", wasm: `${plan.packedType}.xor` },
    { op: "local.set", name: packedArrayLocalName(plan.name) },
  ];
}

function fixedArrayReadModifyWrite(
  update: FixedArrayUpdateCall,
): { oldName: string; value: Expr } | undefined {
  if (update.value.kind !== "block") return undefined;
  const [first, ...rest] = update.value.statements;
  if (!first || first.kind !== "let" || rest.length !== 0 || !update.value.expr) {
    return undefined;
  }
  const oldValue = first.value;
  if (oldValue.kind !== "index" || oldValue.target.kind !== "var") return undefined;
  if (oldValue.target.name !== update.source.name) return undefined;
  if (JSON.stringify(oldValue.index) !== JSON.stringify(update.index)) return undefined;
  return { oldName: first.name, value: update.value.expr };
}

function lowerPackedArraySlotValue(
  plan: PackedArrayPlan,
  value: Instr[],
  offset: number,
): Instr[] {
  const packed = lowerPackedArrayValueToPacked(plan, value);
  if (offset === 0) return packed;
  return [
    ...packed,
    { op: "const", type: "i32", value: offset },
    { op: "binary", wasm: `${plan.packedType}.shl` },
  ];
}

function lowerPackedArrayValueToPacked(
  plan: PackedArrayPlan,
  value: Instr[],
  alreadyMasked = false,
): Instr[] {
  const widened = plan.packedType === "i64" && plan.valueType === "i32"
    ? [...value, { op: "unary", wasm: "i64.extend_i32_u" } as Instr]
    : value;
  if (alreadyMasked) return widened;
  return maskValue(widened, plan.packedType, plan.bitWidth);
}

function packedArrayValueAlreadyMasked(
  value: Expr,
  plan: PackedArrayPlan,
  ctx: LowerContext,
): boolean {
  if (value.kind !== "index" || value.target.kind !== "var") return false;
  const source = packedPlanForName(value.target.name, ctx.packedArrays);
  return Boolean(
    source &&
      source.bitWidth === plan.bitWidth &&
      source.valueType === plan.valueType &&
      source.packedType === plan.packedType,
  );
}

function lowerPackedArrayValueToItem(plan: PackedArrayPlan, value: Instr[]): Instr[] {
  return plan.valueType === "i32" && plan.packedType === "i64"
    ? [...value, { op: "unary", wasm: "i32.wrap_i64" }]
    : value;
}

function packedMaskInstr(type: ValueType, width: number): Instr {
  return { op: "const", type, value: width >= 64 ? -1 : 2 ** width - 1 };
}

interface FixedArrayUpdateCall {
  source: Extract<Expr, { kind: "var" }>;
  index: Expr;
  value: Expr;
  capacity: number;
  itemType: string;
  valueType: ValueType;
}

interface FixedArraySwapCall {
  source: Extract<Expr, { kind: "var" }>;
  left: Expr;
  right: Expr;
  capacity: number;
  itemType: string;
  valueType: ValueType;
}

interface FixedArraySpreadUpdateShape {
  source: Extract<Expr, { kind: "var" }>;
  index: Expr;
  value: Expr;
}

function fixedArrayUpdateCall(expr: Expr, ctx: LowerContext): FixedArrayUpdateCall | undefined {
  if (expr.kind !== "call" || expr.callee.kind !== "var") return undefined;
  const fn = ctx.functions.get(expr.callee.name);
  if (!fn?.body.expr || fn.body.expr.kind !== "shape") return undefined;
  const args = inlineArrayTypeArgs(fn.returnType, ctx.layouts);
  if (!args) return undefined;
  const [capacity, itemType] = args;
  const itemSlots = flattenType(itemType, ctx.layouts);
  if (itemSlots.length !== 1 || !isSelectableValueType(itemSlots[0]?.wat)) return undefined;

  const spread = fn.body.expr.slots.find((slot) => slot.spread);
  const override = fn.body.expr.slots.find((slot) => slot.index);
  if (!spread || spread.value.kind !== "var" || !override?.index) return undefined;

  const substitutions = new Map<string, Expr>();
  const argOffset = Math.max(0, expr.args.length - fn.params.length);
  fn.params.forEach((param, index) => {
    const arg = expr.args[index + argOffset];
    if (arg) substitutions.set(param.name, arg);
  });

  const source = substituteExpr(spread.value, substitutions);
  if (source.kind !== "var") return undefined;
  const index = substituteExpr(override.index, substitutions);
  const valueBlock = substituteExpr(
    {
      kind: "block",
      statements: fn.body.statements,
      ...(override.value ? { expr: override.value } : {}),
    },
    substitutions,
  );
  if (valueBlock.kind !== "block" || !valueBlock.expr) return undefined;
  return {
    source,
    index,
    value: valueBlock.statements.length ? valueBlock : valueBlock.expr,
    capacity,
    itemType,
    valueType: itemSlots[0].wat,
  };
}

function fixedArrayUpdateExpr(
  expr: Expr,
  expectedType: string | undefined,
  ctx: LowerContext,
): FixedArrayUpdateCall | undefined {
  const update = fixedArraySpreadUpdateShape(expr);
  if (!update) return undefined;
  const args = inlineArrayTypeArgs(expectedType, ctx.layouts);
  if (!args) return undefined;
  const [capacity, itemType] = args;
  const itemSlots = flattenType(itemType, ctx.layouts);
  if (itemSlots.length !== 1 || !isSelectableValueType(itemSlots[0]?.wat)) return undefined;
  return {
    source: update.source,
    index: update.index,
    value: update.value,
    capacity,
    itemType,
    valueType: itemSlots[0].wat,
  };
}

function fixedArraySwapCall(expr: Expr, ctx: LowerContext): FixedArraySwapCall | undefined {
  if (expr.kind !== "call" || expr.callee.kind !== "var") return undefined;
  const fn = ctx.functions.get(expr.callee.name);
  if (!fn?.body.expr) return undefined;
  const args = inlineArrayTypeArgs(fn.returnType, ctx.layouts);
  if (!args) return undefined;
  const [capacity, itemType] = args;
  const itemSlots = flattenType(itemType, ctx.layouts);
  if (itemSlots.length !== 1 || !isSelectableValueType(itemSlots[0]?.wat)) return undefined;

  const substitutions = new Map<string, Expr>();
  const argOffset = Math.max(0, expr.args.length - fn.params.length);
  fn.params.forEach((param, index) => {
    const arg = expr.args[index + argOffset];
    if (arg) substitutions.set(param.name, arg);
  });

  const letChain = fixedArrayLetChainSwapCall(
    fn,
    substitutions,
    capacity,
    itemType,
    itemSlots[0].wat,
  );
  if (letChain) return letChain;

  if (fn.body.expr.kind !== "pipe_bind") return undefined;
  const [firstLet, secondLet] = fn.body.statements;
  if (firstLet?.kind !== "let" || secondLet?.kind !== "let") return undefined;
  if (firstLet.value.kind !== "index" || secondLet.value.kind !== "index") return undefined;
  const source = substituteExpr(firstLet.value.target, substitutions);
  if (source.kind !== "var") return undefined;
  const secondSource = substituteExpr(secondLet.value.target, substitutions);
  if (secondSource.kind !== "var" || secondSource.name !== source.name) return undefined;

  const pipe = fn.body.expr;
  const firstSet = fixedArrayUpdateCall(substituteExpr(pipe.value, substitutions), ctx);
  if (!firstSet || firstSet.source.name !== source.name) return undefined;
  if (firstSet.value.kind !== "var" || firstSet.value.name !== secondLet.name) return undefined;
  const pipeSubstitutions = new Map(substitutions);
  pipeSubstitutions.set(pipe.name, source);
  const secondSet = fixedArrayUpdateCall(substituteExpr(pipe.body, pipeSubstitutions), ctx);
  if (!secondSet || secondSet.source.name !== source.name) return undefined;
  if (secondSet.value.kind !== "var" || secondSet.value.name !== firstLet.name) return undefined;

  const left = substituteExpr(firstLet.value.index, substitutions);
  const right = substituteExpr(secondLet.value.index, substitutions);
  if (JSON.stringify(left) !== JSON.stringify(firstSet.index)) return undefined;
  if (JSON.stringify(right) !== JSON.stringify(secondSet.index)) return undefined;
  return {
    source,
    left,
    right,
    capacity,
    itemType,
    valueType: itemSlots[0].wat,
  };
}

function fixedArraySpreadUpdateShape(expr: Expr): FixedArraySpreadUpdateShape | undefined {
  if (expr.kind !== "shape" && expr.kind !== "product_constructor") return undefined;
  if (expr.slots.length !== 2) return undefined;
  const spreads = expr.slots.filter((slot) => slot.spread);
  const overrides = expr.slots.filter((slot) => slot.index);
  if (spreads.length !== 1 || overrides.length !== 1) return undefined;
  const [spread] = spreads;
  const [override] = overrides;
  if (!spread || spread.value.kind !== "var" || !override?.index) return undefined;
  return { source: spread.value, index: override.index, value: override.value };
}

function fixedArrayLetChainSwapCall(
  fn: FnDecl,
  substitutions: Map<string, Expr>,
  capacity: number,
  itemType: string,
  valueType: ValueType,
): FixedArraySwapCall | undefined {
  const [firstLet, secondLet, firstSet, secondSet] = fn.body.statements;
  if (
    firstLet?.kind !== "let" || secondLet?.kind !== "let" ||
    firstSet?.kind !== "let" || secondSet?.kind !== "let"
  ) return undefined;
  if (firstLet.value.kind !== "index" || secondLet.value.kind !== "index") return undefined;
  if (fn.body.expr?.kind !== "var" || fn.body.expr.name !== secondSet.name) return undefined;
  if (firstSet.name !== secondSet.name) return undefined;

  const source = substituteExpr(firstLet.value.target, substitutions);
  if (source.kind !== "var") return undefined;
  const secondSource = substituteExpr(secondLet.value.target, substitutions);
  if (secondSource.kind !== "var" || secondSource.name !== source.name) return undefined;

  const firstUpdate = fixedArraySpreadUpdateShape(firstSet.value);
  const secondUpdate = fixedArraySpreadUpdateShape(secondSet.value);
  if (!firstUpdate || !secondUpdate) return undefined;
  if (firstUpdate.source.name !== source.name || secondUpdate.source.name !== firstSet.name) {
    return undefined;
  }
  if (firstUpdate.value.kind !== "var" || firstUpdate.value.name !== secondLet.name) {
    return undefined;
  }
  if (secondUpdate.value.kind !== "var" || secondUpdate.value.name !== firstLet.name) {
    return undefined;
  }

  const left = substituteExpr(firstLet.value.index, substitutions);
  const right = substituteExpr(secondLet.value.index, substitutions);
  if (JSON.stringify(left) !== JSON.stringify(substituteExpr(firstUpdate.index, substitutions))) {
    return undefined;
  }
  if (JSON.stringify(right) !== JSON.stringify(substituteExpr(secondUpdate.index, substitutions))) {
    return undefined;
  }
  return { source, left, right, capacity, itemType, valueType };
}

function lowerTransientFixedArraySet(
  update: FixedArrayUpdateCall,
  param: Param,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const localSlot = ctx.localSlotArrays?.get(param.name);
  if (localSlot) {
    return lowerLocalSlotArrayStore(localSlot, update.index, update.value, ctx, locals);
  }
  const packed = ctx.packedArrays?.get(param.name);
  if (packed) return lowerPackedArrayStore(packed, update.index, update.value, ctx, locals);
  const scratch = ctx.scratchArrays?.get(param.name);
  if (scratch) return lowerScratchArrayStore(scratch, update.index, update.value, ctx, locals);
  ensureLoweringLocals(update.value, ctx, locals);
  const cachedIndex = cacheRepeatedIndex(update.index, ctx, locals);
  const valueName = `__fixed_update_value${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: valueName, type: update.valueType });
  locals.add(valueName);
  return [
    ...cachedIndex.prefix,
    ...lowerExpr(update.value, ctx, locals, update.itemType),
    { op: "local.set", name: valueName },
    ...Array.from({ length: update.capacity }, (_, item): Instr[] => {
      const target = `${param.name}$${item}`;
      return [
        { op: "local.get", name: valueName },
        { op: "local.get", name: target },
        ...lowerExpr(cachedIndex.index, ctx, locals, "i32"),
        { op: "const", type: "i32", value: item },
        { op: "binary", wasm: "i32.eq" },
        { op: "select", type: update.valueType },
        { op: "local.set", name: target },
      ];
    }).flat(),
  ];
}

function lowerTransientFixedArraySwap(
  swap: FixedArraySwapCall,
  param: Param,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const localSlot = ctx.localSlotArrays?.get(param.name);
  if (localSlot) {
    const leftValue = `__fixed_swap_left${ctx.tempIndex++}`;
    const rightValue = `__fixed_swap_right${ctx.tempIndex++}`;
    ctx.tempLocals.push({ name: leftValue, type: localSlot.valueType });
    ctx.tempLocals.push({ name: rightValue, type: localSlot.valueType });
    locals.add(leftValue);
    locals.add(rightValue);
    return [
      ...lowerLocalSlotArrayLoad(localSlot, swap.left, ctx, locals),
      { op: "local.set", name: leftValue },
      ...lowerLocalSlotArrayLoad(localSlot, swap.right, ctx, locals),
      { op: "local.set", name: rightValue },
      ...lowerLocalSlotArrayStore(
        localSlot,
        swap.left,
        { kind: "var", name: rightValue },
        ctx,
        locals,
      ),
      ...lowerLocalSlotArrayStore(
        localSlot,
        swap.right,
        { kind: "var", name: leftValue },
        ctx,
        locals,
      ),
    ];
  }
  const packed = ctx.packedArrays?.get(param.name);
  if (packed) {
    return lowerPackedArraySwapStore(packed, swap.left, swap.right, ctx, locals);
  }
  const scratch = ctx.scratchArrays?.get(param.name);
  if (scratch) {
    const leftValue = `__fixed_swap_left${ctx.tempIndex++}`;
    const rightValue = `__fixed_swap_right${ctx.tempIndex++}`;
    ctx.tempLocals.push({ name: leftValue, type: scratch.valueType });
    ctx.tempLocals.push({ name: rightValue, type: scratch.valueType });
    locals.add(leftValue);
    locals.add(rightValue);
    return [
      ...lowerScratchArrayLoad(scratch, swap.left, ctx, locals),
      { op: "local.set", name: leftValue },
      ...lowerScratchArrayLoad(scratch, swap.right, ctx, locals),
      { op: "local.set", name: rightValue },
      ...lowerScratchArrayStore(
        scratch,
        swap.left,
        { kind: "var", name: rightValue },
        ctx,
        locals,
      ),
      ...lowerScratchArrayStore(
        scratch,
        swap.right,
        { kind: "var", name: leftValue },
        ctx,
        locals,
      ),
    ];
  }
  const cachedLeft = cacheRepeatedIndex(swap.left, ctx, locals);
  const cachedRight = cacheRepeatedIndex(swap.right, ctx, locals);
  const leftValue = `__fixed_swap_left${ctx.tempIndex++}`;
  const rightValue = `__fixed_swap_right${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: leftValue, type: swap.valueType });
  ctx.tempLocals.push({ name: rightValue, type: swap.valueType });
  locals.add(leftValue);
  locals.add(rightValue);
  return [
    ...cachedLeft.prefix,
    ...cachedRight.prefix,
    ...lowerExpr(
      { kind: "index", target: { kind: "var", name: param.name }, index: cachedLeft.index },
      ctx,
      locals,
      swap.itemType,
    ),
    { op: "local.set", name: leftValue },
    ...lowerExpr(
      { kind: "index", target: { kind: "var", name: param.name }, index: cachedRight.index },
      ctx,
      locals,
      swap.itemType,
    ),
    { op: "local.set", name: rightValue },
    ...lowerTransientFixedArraySet(
      {
        source: { kind: "var", name: param.name },
        index: cachedLeft.index,
        value: { kind: "var", name: rightValue },
        capacity: swap.capacity,
        itemType: swap.itemType,
        valueType: swap.valueType,
      },
      param,
      ctx,
      locals,
    ),
    ...lowerTransientFixedArraySet(
      {
        source: { kind: "var", name: param.name },
        index: cachedRight.index,
        value: { kind: "var", name: leftValue },
        capacity: swap.capacity,
        itemType: swap.itemType,
        valueType: swap.valueType,
      },
      param,
      ctx,
      locals,
    ),
  ];
}

function varType(name: string, ctx: LowerContext): string | undefined {
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

function productFieldTypes(
  type: string | undefined,
  layouts: LayoutEnv,
): { label: string; type: string }[] | undefined {
  const resolved = resolveAlias(type, layouts);
  if (!resolved) return undefined;
  const decl = layouts.types.get(typeName(resolved));
  if (decl?.normalized?.kind !== "product") return undefined;
  const args = typeCallArgs(resolved, typeName(resolved));
  const argValues = args ? splitTypeArgs(args) : [];
  const fields: { label: string; type: string }[] = [];
  for (const [index, slot] of decl.normalized.shape.slots.entries()) {
    if (slot.repeat) return undefined;
    fields.push({
      label: slot.label ?? String(index),
      type: substituteAliasTypeParams(slot.type, decl, argValues),
    });
  }
  return fields;
}

function sameInlineArrayType(
  left: string | undefined,
  right: string | undefined,
  layouts: LayoutEnv,
): boolean {
  const leftArgs = inlineArrayLikeTypeArgs(left, layouts);
  const rightArgs = inlineArrayLikeTypeArgs(right, layouts);
  return Boolean(
    leftArgs && rightArgs && leftArgs[0] === rightArgs[0] &&
      resolveAlias(leftArgs[1], layouts) === resolveAlias(rightArgs[1], layouts),
  );
}

function fixedArrayBackingForName(
  name: string,
  ctx: LowerContext,
): ScratchArrayPlan | PackedArrayPlan | LocalSlotArrayPlan | undefined {
  return scratchPlanForName(name, ctx.scratchArrays) ??
    packedPlanForName(name, ctx.packedArrays) ??
    localSlotPlanForName(name, ctx.localSlotArrays);
}

function sameStorageName(left: string, right: string): boolean {
  return left.replaceAll("$", ".") === right.replaceAll("$", ".");
}

function exprMentionsStorageName(expr: Expr, name: string): boolean {
  const target = name.replaceAll("$", ".");
  let found = false;
  const visit = (item: Expr | undefined) => {
    if (!item || found) return;
    switch (item.kind) {
      case "var": {
        const source = item.name.replaceAll("$", ".");
        found = source === target || source.startsWith(`${target}.`) ||
          source.startsWith(`${target}[`);
        return;
      }
      case "call":
        visit(item.callee);
        item.args.forEach(visit);
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
        if (item.name !== baseName(target)) visit(item.body);
        return;
      case "match":
        visit(item.value);
        for (const arm of item.arms) {
          if (!patternBindingNames(arm.pattern).includes(baseName(target))) visit(arm.value);
        }
        return;
      case "shape":
      case "product_constructor":
        item.slots.forEach((slot) => {
          visit(slot.index);
          visit(slot.value);
        });
        return;
      case "field":
        visit(item.value);
        visit(item.key);
        return;
      case "range":
        visit(item.start);
        visit(item.end);
        return;
      case "static_for_slots":
        visit(item.value);
        return;
      case "block":
        for (const stmt of item.statements) {
          if (stmt.kind !== "proof_const") visit(stmt.value);
        }
        visit(item.expr);
        return;
      case "literal":
      case "placeholder":
        return;
    }
  };
  visit(expr);
  return found;
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
  const resolved = resolveAlias(type, layouts);
  const tupleRepeat = resolved?.match(/^\[\s*(.+?)\s*;\s*([0-9]+)\s*\]$/);
  if (tupleRepeat) {
    return [Number.parseInt(tupleRepeat[2] ?? "0", 10), tupleRepeat[1]?.trim() ?? "i32"];
  }
  const repeat = resolved?.match(/^\{\s*([0-9]+)\s*\*\s*(.+?)\s*\}$/);
  if (repeat) return [Number.parseInt(repeat[1] ?? "0", 10), repeat[2]?.trim() ?? "i32"];
  const unqualified = resolved?.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
  const args = unqualified ? typeCallArgs(unqualified, "InlineArray") : undefined;
  if (!args) {
    const decl = resolved ? layouts.types.get(typeName(resolved)) : undefined;
    if (decl?.normalized?.kind === "product") {
      const slot = decl.normalized.shape.slots[0];
      if (decl.normalized.shape.slots.length === 1 && !slot.label && slot.repeat) {
        const callArgs = typeCallArgs(resolved ?? "", typeName(resolved ?? ""));
        const argValues = callArgs ? splitTypeArgs(callArgs) : [];
        const count = substituteAliasTypeParams(slot.repeat, decl, argValues);
        const itemType = substituteAliasTypeParams(slot.type, decl, argValues);
        return [Number.parseInt(count, 10), itemType];
      }
    }
    return undefined;
  }
  const [count, itemType] = splitTypeArgs(args);
  return [Number.parseInt(count ?? "0", 10), itemType?.trim() ?? "i32"];
}

function inlineArrayLikeTypeArgs(
  type: string | undefined,
  layouts: LayoutEnv,
): [number, string] | undefined {
  const candidates = [type, resolveAlias(type, layouts)].filter(
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

function lowerVar(
  name: string,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  const layouts = ctx.layouts;
  const exactLocalSlot = ctx.localSlotArrays?.get(name);
  if (exactLocalSlot) return lowerLocalSlotArrayMaterialize(exactLocalSlot, ctx, locals);
  const exactPacked = ctx.packedArrays?.get(name);
  if (exactPacked) return lowerPackedArrayMaterialize(exactPacked, ctx, locals);
  const exactScratch = ctx.scratchArrays?.get(name);
  if (exactScratch) return lowerScratchArrayMaterialize(exactScratch, ctx, locals);
  const base = baseName(name);
  const projection = projectionSuffix(name);
  const packed = packedPlanForName(name, ctx.packedArrays);
  if (packed) {
    const packedPath = packed.name === base
      ? projection
      : name.slice(packed.name.length).replace(/^\./, "").replace(/^\[/, "").replace(/\]$/, "");
    const item = packedPath && /^[0-9]+$/.test(packedPath)
      ? Number.parseInt(packedPath, 10)
      : undefined;
    return item === undefined
      ? lowerPackedArrayMaterialize(packed, ctx, locals)
      : lowerPackedArrayLoad(packed, staticIndexExpr(item), ctx, locals);
  }
  const localSlot = localSlotPlanForName(name, ctx.localSlotArrays);
  if (localSlot) {
    const localSlotPath = localSlot.name === base
      ? projection
      : name.slice(localSlot.name.length).replace(/^\./, "").replace(/^\[/, "").replace(/\]$/, "");
    const item = localSlotPath && /^[0-9]+$/.test(localSlotPath)
      ? Number.parseInt(localSlotPath, 10)
      : undefined;
    return item === undefined
      ? lowerLocalSlotArrayMaterialize(localSlot, ctx, locals)
      : lowerLocalSlotArrayLoad(localSlot, staticIndexExpr(item), ctx, locals);
  }
  const scratch = scratchPlanForName(name, ctx.scratchArrays);
  if (scratch) {
    const scratchPath = scratch.name === base
      ? projection
      : name.slice(scratch.name.length).replace(/^\./, "").replace(/^\[/, "").replace(/\]$/, "");
    const item = scratchPath && /^[0-9]+$/.test(scratchPath)
      ? Number.parseInt(scratchPath, 10)
      : undefined;
    return item === undefined
      ? lowerScratchArrayMaterialize(scratch, ctx, locals)
      : lowerScratchArrayLoad(scratch, staticIndexExpr(item), ctx, locals);
  }
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

function scratchPlanForName(
  name: string,
  plans: Map<string, ScratchArrayPlan> | undefined,
): ScratchArrayPlan | undefined {
  if (!plans) return undefined;
  const exact = plans.get(name);
  if (exact) return exact;
  const dotted = name.replaceAll("$", ".");
  const dottedExact = plans.get(dotted);
  if (dottedExact) return dottedExact;
  const base = baseName(name);
  const projection = projectionSuffix(name);
  return plans.get(base) ??
    (projection ? plans.get(`${base}.${projection.replaceAll("$", ".")}`) : undefined);
}

function packedPlanForName(
  name: string,
  plans: Map<string, PackedArrayPlan> | undefined,
): PackedArrayPlan | undefined {
  if (!plans) return undefined;
  const exact = plans.get(name);
  if (exact) return exact;
  const dotted = name.replaceAll("$", ".");
  const dottedExact = plans.get(dotted);
  if (dottedExact) return dottedExact;
  const base = baseName(name);
  const projection = projectionSuffix(name);
  return plans.get(base) ??
    (projection ? plans.get(`${base}.${projection.replaceAll("$", ".")}`) : undefined);
}

function localSlotPlanForName(
  name: string,
  plans: Map<string, LocalSlotArrayPlan> | undefined,
): LocalSlotArrayPlan | undefined {
  if (!plans) return undefined;
  const exact = plans.get(name);
  if (exact) return exact;
  const dotted = name.replaceAll("$", ".");
  const dottedExact = plans.get(dotted);
  if (dottedExact) return dottedExact;
  const base = baseName(name);
  const projection = projectionSuffix(name);
  return plans.get(base) ??
    (projection ? plans.get(`${base}.${projection.replaceAll("$", ".")}`) : undefined);
}

function scratchArrayLocalSlotName(name: string, index: number): string {
  return `${name.replaceAll(".", "$")}$${index}`;
}

function localSlotArraySlotName(name: string, index: number): string {
  return scratchArrayLocalSlotName(name, index);
}

function packedArrayLocalName(name: string): string {
  return `__fixed_array_packed_${name.replaceAll(".", "$")}`;
}

function lowerShapeStorage(
  slots: { label?: string; value: Expr; spread?: boolean; index?: Expr }[],
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const fixedUpdate = lowerFixedCollectionUpdate(slots, expectedType, ctx, locals);
  if (fixedUpdate) return fixedUpdate;
  const expanded = expandSpreadSlots(slots, expectedType, ctx, locals);
  if (expanded) slots = expanded;
  const layout = flattenType(expectedType, ctx.layouts);
  if (!layout.some((slot) => slot.fields && slot.fields.length > 1)) {
    const projectable = layout.length < slots.length &&
      layout.every((lane) =>
        lane.suffix && slots.some((item, index) => (item.label ?? String(index)) === lane.suffix)
      );
    if (projectable) {
      return layout.flatMap((lane) => {
        const slot = slots.find((item, index) => (item.label ?? String(index)) === lane.suffix);
        return slot ? lowerExpr(slot.value, ctx, locals, lane.type) : [];
      });
    }
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
  slots: { label?: string; value: Expr; spread?: boolean; index?: Expr }[],
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): { label?: string; value: Expr }[] | undefined {
  if (!slots.some((slot) => slot.spread)) return undefined;
  if (slots.some((slot) => slot.index)) return undefined;
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

function lowerFixedCollectionUpdate(
  slots: { label?: string; value: Expr; spread?: boolean; index?: Expr }[],
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (!slots.some((slot) => slot.index)) return undefined;
  const source = slots.find((slot) => slot.spread);
  if (!source) return undefined;
  const args = inlineArrayTypeArgs(expectedType, ctx.layouts);
  if (!args) return undefined;
  const [count, itemType] = args;
  const itemSlots = flattenType(itemType, ctx.layouts);
  const overrides = slots.filter((slot): slot is typeof slot & { index: Expr } =>
    Boolean(slot.index)
  );
  if (source.value.kind === "var" && overrides.length === 1) {
    const override = overrides[0]!;
    const update: FixedArrayUpdateCall = {
      source: source.value,
      index: override.index,
      value: override.value,
      capacity: count,
      itemType,
      valueType: itemSlots[0]?.wat ?? "i32",
    };
    const localSlot = localSlotPlanForName(source.value.name, ctx.localSlotArrays);
    if (localSlot) {
      return [
        ...lowerLocalSlotArrayUpdateStore(localSlot, update, ctx, locals),
        ...lowerLocalSlotArrayMaterialize(localSlot, ctx, locals),
      ];
    }
    const packed = packedPlanForName(source.value.name, ctx.packedArrays);
    if (packed) {
      return [
        ...lowerPackedArrayUpdateStore(packed, update, ctx, locals),
        ...lowerPackedArrayMaterialize(packed, ctx, locals),
      ];
    }
    const scratch = scratchPlanForName(source.value.name, ctx.scratchArrays);
    if (scratch) {
      return [
        ...lowerScratchArrayUpdate(scratch, update, ctx, locals),
        ...lowerScratchArrayMaterialize(scratch, ctx, locals),
      ];
    }
  }
  const scalarDynamic = lowerScalarFixedCollectionUpdate(
    source,
    overrides,
    count,
    itemType,
    itemSlots,
    ctx,
    locals,
  );
  if (scalarDynamic) return scalarDynamic;
  return Array.from({ length: count }, (_, item) =>
    itemSlots.map((_slot, slotIndex) => {
      let body = lowerFlattenedValueSlot(
        {
          kind: "index",
          target: source.value,
          index: {
            kind: "literal",
            literalKind: "number",
            value: String(item),
            inferredType: "i32",
          },
        },
        itemType,
        slotIndex,
        ctx,
        locals,
      );
      for (const override of overrides) {
        const literalIndex = staticIntegerLiteral(override.index);
        if (literalIndex !== undefined) {
          if (literalIndex === item) {
            body = lowerFlattenedValueSlot(override.value, itemType, slotIndex, ctx, locals);
          }
          continue;
        }
        body = [
          ...lowerExpr(override.index, ctx, locals, "i32"),
          { op: "const", type: "i32", value: item },
          { op: "binary", wasm: "i32.eq" },
          {
            op: "if",
            results: [itemSlots[slotIndex]?.wat ?? "i32"],
            thenBody: lowerFlattenedValueSlot(override.value, itemType, slotIndex, ctx, locals),
            elseBody: body,
          },
        ];
      }
      return body;
    }).flat()).flat();
}

function lowerScalarFixedCollectionUpdate(
  source: { label?: string; value: Expr; spread?: boolean; index?: Expr },
  overrides: ({ label?: string; value: Expr; spread?: boolean; index?: Expr } & { index: Expr })[],
  count: number,
  itemType: string,
  itemSlots: LayoutSlot[],
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (itemSlots.length !== 1 || !isSelectableValueType(itemSlots[0]?.wat)) return undefined;
  if (overrides.length !== 1) return undefined;
  const override = overrides[0];
  if (!override) return undefined;
  if (staticIntegerLiteral(override.index) !== undefined) return undefined;
  if (!isSpeculableNonTrappingExpr(override.value, ctx.functions)) return undefined;

  const cached = cacheRepeatedIndex(override.index, ctx, locals);
  return [
    ...cached.prefix,
    ...Array.from({ length: count }, (_, item): Instr[] => [
      ...lowerFlattenedValueSlot(override.value, itemType, 0, ctx, locals),
      ...lowerFlattenedValueSlot(
        {
          kind: "index",
          target: source.value,
          index: {
            kind: "literal",
            literalKind: "number",
            value: String(item),
            inferredType: "i32",
          },
        },
        itemType,
        0,
        ctx,
        locals,
      ),
      ...lowerExpr(cached.index, ctx, locals, "i32"),
      { op: "const", type: "i32", value: item },
      { op: "binary", wasm: "i32.eq" },
      { op: "select", type: itemSlots[0]?.wat ?? "i32" },
    ]).flat(),
  ];
}

function isSpeculableNonTrappingExpr(expr: Expr, functions: Map<string, FnDecl>): boolean {
  if (hasRuntimeEffect(expr, functions)) return false;
  switch (expr.kind) {
    case "literal":
    case "var":
    case "placeholder":
      return true;
    case "binary":
      return expr.op !== "/" && expr.op !== "%" &&
        isSpeculableNonTrappingExpr(expr.left, functions) &&
        isSpeculableNonTrappingExpr(expr.right, functions);
    case "field":
      return isSpeculableNonTrappingExpr(expr.value, functions) &&
        isSpeculableNonTrappingExpr(expr.key, functions);
    case "pipe_bind":
      return isSpeculableNonTrappingExpr(expr.value, functions) &&
        isSpeculableNonTrappingExpr(expr.body, functions);
    default:
      return false;
  }
}

function staticIntegerLiteral(expr: Expr): number | undefined {
  if (expr.kind !== "literal" || expr.literalKind !== "number") return undefined;
  if (!/^-?[0-9]+$/.test(expr.value)) return undefined;
  return Number.parseInt(expr.value, 10);
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
  if (isCatchAllPattern(arm.pattern) || rest.length === 0) {
    const ignored = hasRuntimeEffect(value, ctx.functions)
      ? lowerIgnoredExpr(value, ctx, locals)
      : [];
    return [
      ...ignored,
      ...lowerExpr(arm.value, ctx, locals, expectedType),
    ];
  }
  return [
    ...lowerExpr(value, ctx, locals),
    ...lowerPatternTest(arm.pattern),
    {
      op: "if",
      results: flattenType(expectedType, ctx.layouts).map((slot) => slot.wat),
      thenBody: lowerExpr(arm.value, ctx, locals, expectedType),
      elseBody: lowerMatchArms(value, rest, ctx, locals, expectedType),
      branchHint: branchHintForTestedArm(arm, rest),
    },
  ];
}

function branchHintForTestedArm(arm: MatchArm, rest: MatchArm[]): BranchHint | undefined {
  if (arm.branchHint) return arm.branchHint;
  const fallback = rest.length === 1 ? rest[0] : undefined;
  if (fallback?.branchHint) return invertBranchHint(fallback.branchHint);
  return undefined;
}

function branchHintForStepArms(
  thenArm: MatchArm | undefined,
  elseArm: MatchArm | undefined,
): BranchHint | undefined {
  if (thenArm?.branchHint) return thenArm.branchHint;
  return elseArm?.branchHint ? invertBranchHint(elseArm.branchHint) : undefined;
}

function invertBranchHint(hint: BranchHint): BranchHint {
  return hint === "likely" ? "unlikely" : "likely";
}

function lowerIgnoredExpr(value: Expr, ctx: LowerContext, locals: Set<string>): Instr[] {
  return [
    ...lowerExpr(value, ctx, locals),
    ...flattenType(exprTypeWithLocals(value, ctx), ctx.layouts).map((): Instr => ({ op: "drop" })),
  ];
}

function lowerMaterializedMatch(
  expr: Extract<Expr, { kind: "match" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (!shouldMaterializeMatchValue(expr, ctx)) return undefined;
  const valueType = exprTypeWithLocals(expr.value, ctx);
  const slots = flattenType(valueType, ctx.layouts);
  if (slots.length !== 1) return undefined;
  const name = `__match_value${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name, type: slots[0]?.wat ?? "i32" });
  locals.add(name);
  return [
    ...lowerExpr(expr.value, ctx, locals, valueType),
    { op: "local.set", name },
    ...lowerMatchArms({ kind: "var", name }, expr.arms, ctx, locals, expectedType),
  ];
}

function shouldMaterializeMatchValue(
  expr: Extract<Expr, { kind: "match" }>,
  ctx: LowerContext,
): boolean {
  const testedArms = expr.arms.filter((arm) => !isCatchAllPattern(arm.pattern));
  return testedArms.length > 1 && hasRuntimeEffect(expr.value, ctx.functions);
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
  const yieldUsesItem = item?.kind === "binding" && exprMentionsName(yieldArm.value, item.name);
  const yieldUsesNext = next?.kind === "binding" && exprMentionsName(yieldArm.value, next.name);
  const scoped = new Set(locals);
  const itemName = item?.kind === "binding" && yieldUsesItem ? item.name : undefined;
  const nextName = next?.kind === "binding" && yieldUsesNext ? next.name : undefined;
  if (itemName) {
    scoped.add(itemName);
    ctx.tempLocals.push({ name: itemName, type: "i32" });
  }
  if (nextName) {
    scoped.add(nextName);
    ctx.tempLocals.push({ name: nextName, type: "i32" });
  }
  return [
    ...lowerExpr(cursor, ctx, locals, "i32"),
    ...lowerExpr(n, ctx, locals, "i32"),
    { op: "binary", wasm: "i32.lt_s" },
    {
      op: "if",
      results: flattenType(expectedType, ctx.layouts).map((slot) => slot.wat),
      thenBody: [
        ...(itemName
          ? [
            ...lowerExpr(cursor, ctx, locals, "i32"),
            { op: "local.set", name: itemName } as Instr,
          ]
          : []),
        ...(nextName
          ? [
            ...lowerExpr(cursor, ctx, locals, "i32"),
            { op: "const", type: "i32", value: 1 } as Instr,
            { op: "binary", wasm: "i32.add" } as Instr,
            { op: "local.set", name: nextName } as Instr,
          ]
          : []),
        ...lowerExpr(yieldArm.value, ctx, scoped, expectedType),
      ],
      elseBody: lowerExpr(doneArm.value, ctx, locals, expectedType),
      branchHint: branchHintForStepArms(yieldArm, doneArm),
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
    return [];
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

function privateReturnProjectionPlans(
  functions: FnDecl[],
  layouts: LayoutEnv,
): Map<string, ReturnProjectionPlan> {
  const privateProductFns = new Map(
    functions.filter((fn) =>
      !fn.public && fn.returnType && flattenType(fn.returnType, layouts).length > 1
    ).map((fn) => [fn.name, fn]),
  );
  const candidates = new Map<string, { suffixes: Set<string>; full: boolean }>(
    [...privateProductFns.keys()].map((name) => [name, { suffixes: new Set(), full: false }]),
  );

  const markFull = (name: string) => {
    const candidate = candidates.get(name);
    if (candidate) candidate.full = true;
  };
  const markProjected = (name: string, suffixes: Set<string>) => {
    const candidate = candidates.get(name);
    if (!candidate) return;
    if (!suffixes.size) {
      candidate.full = true;
      return;
    }
    for (const suffix of suffixes) candidate.suffixes.add(suffix);
  };
  const directCallName = (expr: Expr | undefined) =>
    expr?.kind === "call" && expr.callee.kind === "var" ? expr.callee.name : undefined;
  const visitExpr = (expr: Expr | undefined, currentFn: string) => {
    if (!expr) return;
    const callee = directCallName(expr);
    if (callee && privateProductFns.has(callee) && callee !== currentFn) markFull(callee);
    for (const child of exprChildren(expr)) visitExpr(child, currentFn);
  };
  const visitBlock = (block: BlockExpr, currentFn: string) => {
    for (let index = 0; index < block.statements.length; index++) {
      const stmt = block.statements[index]!;
      if (stmt.kind === "proof_const") continue;
      const callee = directCallName(stmt.value);
      if (stmt.kind === "let" && callee && privateProductFns.has(callee) && callee !== currentFn) {
        const remaining: BlockExpr = {
          kind: "block",
          statements: block.statements.slice(index + 1),
          ...(block.expr ? { expr: block.expr } : {}),
        };
        const uses = projectionUses(remaining, stmt.name);
        uses.whole ? markFull(callee) : markProjected(callee, uses.suffixes);
        for (const arg of (stmt.value as Extract<Expr, { kind: "call" }>).args) {
          visitExpr(arg, currentFn);
        }
      } else {
        visitExpr(stmt.value, currentFn);
      }
    }
    visitExpr(block.expr, currentFn);
  };

  for (const fn of functions) visitBlock(fn.body, fn.name);

  const plans = new Map<string, ReturnProjectionPlan>();
  for (const [name, candidate] of candidates) {
    const fn = privateProductFns.get(name);
    if (!fn || candidate.full || !candidate.suffixes.size) continue;
    if (
      [...candidate.suffixes].some((suffix) => suffix.includes("$") || /^[0-9]+$/.test(suffix))
    ) continue;
    const slots = flattenType(fn.returnType, layouts);
    const projected = slots.filter((slot) =>
      slot.suffix && !slot.suffix.includes("$") && !/^[0-9]+$/.test(slot.suffix) &&
      candidate.suffixes.has(slot.suffix)
    );
    if (!projected.length || projected.length === slots.length) continue;
    plans.set(name, {
      suffixes: projected.map((slot) => slot.suffix),
      type: `struct({${projected.map((slot) => `${slot.suffix}: ${slot.type}`).join(", ")}})`,
    });
  }
  return plans;
}

function projectionUses(
  expr: Expr | undefined,
  name: string,
): { whole: boolean; suffixes: Set<string> } {
  const suffixes = new Set<string>();
  let whole = false;
  const visit = (item: Expr | undefined) => {
    if (!item || whole) return;
    if (item.kind === "var" && baseName(item.name) === name) {
      const suffix = projectionSuffix(item.name);
      if (suffix) suffixes.add(suffix);
      else whole = true;
      return;
    }
    for (const child of exprChildren(item)) visit(child);
  };
  visit(expr);
  return { whole, suffixes };
}

function exprChildren(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "do":
      return [
        ...expr.statements.flatMap((stmt) => stmt.kind === "proof_const" ? [] : [stmt.value]),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "const_fn":
      return [expr.body];
    case "call":
      return [expr.callee, ...expr.args];
    case "index":
      return [expr.target, expr.index];
    case "binary":
      return [expr.left, expr.right];
    case "pipe_bind":
      return [expr.value, expr.body];
    case "match":
      return [expr.value, ...expr.arms.map((arm) => arm.value)];
    case "shape":
    case "product_constructor":
      return expr.slots.flatMap((slot) => slot.index ? [slot.index, slot.value] : [slot.value]);
    case "static_for_slots":
      return [
        ...(expr.source.kind === "range"
          ? [expr.source.start, expr.source.end]
          : [expr.source.shape]),
        expr.value,
      ];
    case "field":
      return [expr.value, expr.key];
    case "range":
      return [expr.start, expr.end];
    case "block":
      return [
        ...expr.statements.flatMap((stmt) => stmt.kind === "proof_const" ? [] : [stmt.value]),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "literal":
    case "var":
    case "placeholder":
      return [];
  }
}

function removeUnreachableBackendFunctions(functions: BackendFunction[]): BackendFunction[] {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  const reachable = new Set<string>();
  const visit = (name: string) => {
    if (reachable.has(name)) return;
    const fn = byName.get(name);
    if (!fn) return;
    reachable.add(name);
    for (const callee of calledBackendFunctions(fn.body)) visit(callee);
  };
  for (const fn of functions) {
    if (fn.exportName) visit(fn.name);
  }
  return functions.filter((fn) => reachable.has(fn.name));
}

function calledBackendFunctions(instrs: Instr[]): string[] {
  const names: string[] = [];
  const visit = (instr: Instr) => {
    if (instr.op === "call" || instr.op === "return_call") {
      names.push(instr.name);
      return;
    }
    if (instr.op === "if") {
      instr.thenBody.forEach(visit);
      instr.elseBody.forEach(visit);
      return;
    }
    if (instr.op === "block" || instr.op === "loop") instr.body.forEach(visit);
  };
  instrs.forEach(visit);
  return names;
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
  if (expr.kind === "call" && expr.args.length === 0 && expr.callee.kind !== "var") {
    return exprHasOnlyTailSelfCalls(expr.callee, name);
  }
  if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === name) {
    return !expr.args.some((arg) => exprHasSelfCall(arg, name));
  }
  if (expr.kind === "match") {
    return !exprHasSelfCall(expr.value, name) &&
      expr.arms.every((arm) => exprHasOnlyTailSelfCalls(arm.value, name));
  }
  if (expr.kind === "pipe_bind") {
    return !exprHasSelfCall(expr.value, name) && exprHasOnlyTailSelfCalls(expr.body, name);
  }
  if (expr.kind === "block") return blockHasOnlyTailSelfCalls(expr, name);
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
      return false;
  }
}

function exprHasSelfCall(expr: Expr, name: string): boolean {
  switch (expr.kind) {
    case "do":
      return expr.expr ? exprHasSelfCall(expr.expr, name) : false;
    case "const_fn":
      return exprHasSelfCall(expr.body, name);
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
      case "do":
        return visit(item.expr);
      case "let":
        visit(item.value);
        return;
      case "destructure_let":
        visit(item.value);
        return;
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
  const memory = module.memories.map((item) => emitMemoryWat(item));
  const data = module.data.map((item) => emitDataWat(item));
  const functions = module.functions.map((fn) => emitFunctionWat(fn));
  return `(module\n${[...imports, ...memory, ...data, ...functions].join("\n")}\n)`;
}

function emitMemoryWat(item: BackendMemory): string {
  if (item.name === "memory") return `  (memory (export "${item.exportName}") ${item.minPages})`;
  return `  (memory $${watName(item.name)} (export "${item.exportName}") ${item.minPages})`;
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
    case "local.tee":
      return [`${prefix}local.tee $${watName(instr.name)}`];
    case "call":
      return [`${prefix}call $${watName(instr.name)}`];
    case "return_call":
      return [`${prefix}return_call $${watName(instr.name)}`];
    case "select":
      return [`${prefix}select`];
    case "binary":
      return [`${prefix}${instr.wasm}`];
    case "unary":
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
      return [
        `${prefix}${instr.type}.load${
          watMemidx(instr.memory)
        } align=${instr.align} offset=${instr.offset}`,
      ];
    case "store":
      return [
        `${prefix}${instr.type}.store${
          watMemidx(instr.memory)
        } align=${instr.align} offset=${instr.offset}`,
      ];
    case "memory.copy":
      return [`${prefix}memory.copy${watMemidx(instr.memory)}`];
    case "drop":
      return [`${prefix}drop`];
    case "unreachable":
      return [`${prefix}unreachable`];
    case "if":
      return [
        `${prefix}if${branchHintWat(instr.branchHint)}${
          instr.results.map((result) => ` (result ${result})`).join("")
        }`,
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
      return [`${prefix}br_if${branchHintWat(instr.branchHint)} ${instr.depth}`];
  }
}

function branchHintWat(hint: BranchHint | undefined): string {
  if (!hint) return "";
  return ` (@metadata.code.branch_hint "${hint === "likely" ? "\\01" : "\\00"}")`;
}

function watMemidx(memory: string | undefined): string {
  return memory && memory !== "memory" ? ` (memory $${watName(memory)})` : "";
}

function backendModuleToWasm(
  module: BackendModule,
  options: { debugNames?: boolean } = {},
): Uint8Array<ArrayBuffer> {
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
  if (module.memories.length) {
    section(
      bytes,
      5,
      vecItems(module.memories.map((memory) => [0x00, ...uleb(memory.minPages)])),
    );
  }
  const exports = module.functions.filter((fn) => fn.exportName).map((fn) => [
    ...nameBytes(fn.exportName ?? fn.name),
    0x00,
    ...uleb(funcIndex.get(fn.name) ?? 0),
  ]);
  for (let index = module.memories.length - 1; index >= 0; index--) {
    const memory = module.memories[index]!;
    exports.unshift([...nameBytes(memory.exportName), 0x02, ...uleb(index)]);
  }
  if (exports.length) section(bytes, 7, vecItems(exports));
  if (module.functions.length) {
    const encodedFunctions = module.functions.map((fn, index) =>
      encodeFunction(fn, module.imports.length + index, funcIndex, typeKeys)
    );
    if (module.branchHints) {
      const branchHintSection = wasmBranchHintSection(encodedFunctions);
      if (branchHintSection) section(bytes, 0, branchHintSection);
    }
    section(
      bytes,
      10,
      vecItems(encodedFunctions.map((fn) => fn.bytes)),
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
  if (options.debugNames) {
    section(bytes, 0, wasmNameSection(module, allFns));
  }
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

function wasmNameSection(
  module: BackendModule,
  allFns: (BackendImport | BackendFunction)[],
): number[] {
  const subsections: number[] = [];
  const functionNames = allFns.map((fn, index) => [...uleb(index), ...nameBytes(fn.name)]);
  nameSubsection(subsections, 1, vecItems(functionNames));

  const localNameEntries = module.functions
    .map((fn, functionIndex) => {
      const locals = [...fn.params, ...fn.locals].map((local, localIndex) => [
        ...uleb(localIndex),
        ...nameBytes(local.name),
      ]);
      return locals.length
        ? [
          ...uleb(module.imports.length + functionIndex),
          ...vecItems(locals),
        ]
        : undefined;
    })
    .filter((item): item is number[] => Boolean(item));
  if (localNameEntries.length) nameSubsection(subsections, 2, vecItems(localNameEntries));

  return [...nameBytes("name"), ...subsections];
}

function nameSubsection(bytes: number[], id: number, payload: number[]) {
  bytes.push(id);
  bytes.push(...uleb(payload.length));
  for (const byte of payload) bytes.push(byte);
}

function wasmBranchHintSection(
  functions: { branchHints: FunctionBranchHints }[],
): number[] | undefined {
  const entries = functions
    .map((fn) => fn.branchHints)
    .filter((fn) => fn.hints.length > 0)
    .toSorted((left, right) => left.functionIndex - right.functionIndex)
    .map((fn) => [
      ...uleb(fn.functionIndex),
      ...vecItems(
        fn.hints.toSorted((left, right) => left.offset - right.offset).map((hint) => [
          ...uleb(hint.offset),
          ...uleb(1),
          ...uleb(hint.hint === "likely" ? 1 : 0),
        ]),
      ),
    ]);
  if (!entries.length) return undefined;
  return [...nameBytes("metadata.code.branch_hint"), ...vecItems(entries)];
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
  functionIndex: number,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
): { bytes: number[]; branchHints: FunctionBranchHints } {
  const localIndex = new Map<string, number>();
  [...fn.params, ...fn.locals].forEach((slot, index) => localIndex.set(slot.name, index));
  const locals = localDecls(fn.locals);
  const encoded = encodeInstrsWithBranchHints(
    fn.body,
    localIndex,
    funcIndex,
    typeKeys,
    locals.length,
  );
  const body = [
    ...locals,
    ...encoded.bytes,
    0x0b,
  ];
  return {
    bytes: [...uleb(body.length), ...body],
    branchHints: { functionIndex, hints: encoded.hints },
  };
}

interface FunctionBranchHints {
  functionIndex: number;
  hints: BranchHintEntry[];
}

interface BranchHintEntry {
  offset: number;
  hint: BranchHint;
}

function encodeInstrsWithBranchHints(
  instrs: Instr[],
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
  startOffset: number,
): { bytes: number[]; hints: BranchHintEntry[] } {
  const bytes: number[] = [];
  const hints: BranchHintEntry[] = [];
  for (const instr of instrs) {
    const offset = startOffset + bytes.length;
    if ((instr.op === "if" || instr.op === "br_if") && instr.branchHint) {
      hints.push({ offset, hint: instr.branchHint });
    }
    const encoded = encodeInstrWithBranchHints(instr, locals, funcIndex, typeKeys, offset);
    bytes.push(...encoded.bytes);
    hints.push(...encoded.hints);
  }
  return { bytes, hints };
}

function encodeInstrWithBranchHints(
  instr: Instr,
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
  offset: number,
): { bytes: number[]; hints: BranchHintEntry[] } {
  if (instr.op === "if") {
    const prefix = [0x04, ...blockType(instr.results, typeKeys)];
    const thenEncoded = encodeInstrsWithBranchHints(
      instr.thenBody,
      locals,
      funcIndex,
      typeKeys,
      offset + prefix.length,
    );
    const elseOffset = offset + prefix.length + thenEncoded.bytes.length + 1;
    const elseEncoded = encodeInstrsWithBranchHints(
      instr.elseBody,
      locals,
      funcIndex,
      typeKeys,
      elseOffset,
    );
    return {
      bytes: [...prefix, ...thenEncoded.bytes, 0x05, ...elseEncoded.bytes, 0x0b],
      hints: [...thenEncoded.hints, ...elseEncoded.hints],
    };
  }
  if (instr.op === "block" || instr.op === "loop") {
    const prefix = [
      instr.op === "block" ? 0x02 : 0x03,
      ...blockType(instr.results ?? [], typeKeys),
    ];
    const body = encodeInstrsWithBranchHints(
      instr.body,
      locals,
      funcIndex,
      typeKeys,
      offset + prefix.length,
    );
    return { bytes: [...prefix, ...body.bytes, 0x0b], hints: body.hints };
  }
  return { bytes: encodeInstr(instr, locals, funcIndex, typeKeys), hints: [] };
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
    case "local.tee": {
      const index = locals.get(instr.name);
      return index === undefined ? [0x1a] : [0x22, ...uleb(index)];
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
    case "select":
      return [0x1b];
    case "binary":
      return [wasmBinaryOp(instr.wasm)];
    case "unary":
      return [wasmUnaryOp(instr.wasm)];
    case "simd":
      return simdImmediate(instr.wasm, instr.lane, instr.lanes);
    case "load":
      return [...wasmLoadOp(instr.type), ...memarg(instr.align, instr.offset)];
    case "store":
      return [...wasmStoreOp(instr.type), ...memarg(instr.align, instr.offset)];
    case "memory.copy":
      return [0xfc, ...uleb(0x0a), 0x00, 0x00];
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
  return packProjectedLane4I32FromScalars(base);
}

function packProjectedLane4I32FromScalars(base: string): Instr[] {
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

function lowerTemporalIntrinsic(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const id = compilerCallId(expr.callee.name, ctx.intrinsicIdsByName);
  if (id === "temporal_handle") {
    const ptr = expr.args.at(-2);
    const rev = expr.args.at(-1);
    return packTemporalHandle(
      ptr ?? { kind: "literal", literalKind: "number", value: "0" },
      rev ?? { kind: "literal", literalKind: "number", value: "0" },
      ctx,
      locals,
    );
  }
  if (id === "temporal_alloc") {
    const bytes = expr.args.at(-1);
    return packTemporalHandle(
      bytes ?? { kind: "literal", literalKind: "number", value: "0" },
      { kind: "literal", literalKind: "number", value: "0" },
      ctx,
      locals,
    );
  }
  if (id === "temporal_handle_ptr") {
    const handle = expr.args.at(-1);
    return [
      ...lowerExpr(
        handle ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
        "i64",
      ),
      { op: "unary", wasm: "i32.wrap_i64" },
    ];
  }
  if (id === "temporal_handle_rev") {
    const handle = expr.args.at(-1);
    return [
      ...lowerExpr(
        handle ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
        "i64",
      ),
      { op: "const", type: "i64", value: 32 },
      { op: "binary", wasm: "i64.shr_u" },
      { op: "unary", wasm: "i32.wrap_i64" },
    ];
  }
  return undefined;
}

function lowerBranchIntrinsic(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const id = compilerCallId(expr.callee.name, ctx.intrinsicIdsByName);
  if (!id?.startsWith("branch_")) return undefined;
  if (ctx.memoryModel === "temporal") {
    throw new CompileError([{
      code: "backend.branch_in_temporal_mode",
      message: `branch intrinsics require --memory branch or --memory branch-debug`,
    }]);
  }
  const arg = expr.args.at(-1) ?? { kind: "literal", literalKind: "number", value: "0" };
  if (id === "branch_handle") {
    return [
      ...lowerExpr(arg, ctx, locals, "i32"),
      { op: "unary", wasm: "i64.extend_i32_u" },
    ];
  }
  if (id === "branch_handle_ptr") {
    return [
      ...lowerExpr(arg, ctx, locals, "i64"),
      { op: "unary", wasm: "i32.wrap_i64" },
    ];
  }
  if (id === "branch_mark") {
    return lowerBranchMark(arg, ctx, locals);
  }
  if (id === "branch_ensure_editable" || id === "branch_materialize") {
    return lowerBranchEnsureEditable(arg, ctx, locals);
  }
  if (id === "branch_is_branched") {
    const handle = expr.args.at(-1);
    return lowerBranchIsBranched(
      handle ?? { kind: "literal", literalKind: "number", value: "0" },
      ctx,
      locals,
    );
  }
  return undefined;
}

const BRANCH_HEADER_SIZE_OFFSET = 4;
const BRANCH_HEADER_FLAGS_OFFSET = 8;
const BRANCH_HEADER_SIZE = 16;
const BRANCH_FLAG_BRANCHED = 1;
const BRANCH_FLAG_PINNED = 2;
const BRANCH_MUTATION_GUARD_FLAGS = BRANCH_FLAG_BRANCHED | BRANCH_FLAG_PINNED;
const BRANCH_CLEAR_COPIED_FLAGS_MASK = -16;

function lowerBranchMark(arg: Expr, ctx: LowerContext, locals: Set<string>): Instr[] {
  const ptr = branchTemp(ctx, locals, "ptr");
  return [
    ...lowerExpr(arg, ctx, locals, "i64"),
    { op: "unary", wasm: "i32.wrap_i64" },
    { op: "local.tee", name: ptr },
    { op: "const", type: "i32", value: 0 },
    { op: "binary", wasm: "i32.ne" },
    {
      op: "if",
      results: ["i64"],
      thenBody: [
        { op: "local.get", name: ptr },
        { op: "local.get", name: ptr },
        { op: "load", type: "i32", align: 4, offset: BRANCH_HEADER_FLAGS_OFFSET },
        { op: "const", type: "i32", value: BRANCH_FLAG_BRANCHED },
        { op: "binary", wasm: "i32.or" },
        { op: "store", type: "i32", align: 4, offset: BRANCH_HEADER_FLAGS_OFFSET },
        { op: "local.get", name: ptr },
        { op: "unary", wasm: "i64.extend_i32_u" },
      ],
      elseBody: [{ op: "const", type: "i64", value: 0 }],
    },
  ];
}

function lowerBranchEnsureEditable(arg: Expr, ctx: LowerContext, locals: Set<string>): Instr[] {
  const ptr = branchTemp(ctx, locals, "ptr");
  const fresh = branchTemp(ctx, locals, "fresh");
  const bytes = branchTemp(ctx, locals, "bytes");
  return [
    ...lowerExpr(arg, ctx, locals, "i64"),
    { op: "unary", wasm: "i32.wrap_i64" },
    { op: "local.tee", name: ptr },
    { op: "const", type: "i32", value: 0 },
    { op: "binary", wasm: "i32.eq" },
    {
      op: "if",
      results: ["i64"],
      thenBody: [{ op: "const", type: "i64", value: 0 }],
      elseBody: [
        { op: "local.get", name: ptr },
        { op: "load", type: "i32", align: 4, offset: BRANCH_HEADER_FLAGS_OFFSET },
        { op: "const", type: "i32", value: BRANCH_MUTATION_GUARD_FLAGS },
        { op: "binary", wasm: "i32.and" },
        { op: "const", type: "i32", value: 0 },
        { op: "binary", wasm: "i32.eq" },
        {
          op: "if",
          results: ["i64"],
          thenBody: [
            { op: "local.get", name: ptr },
            { op: "unary", wasm: "i64.extend_i32_u" },
          ],
          elseBody: [
            { op: "local.get", name: ptr },
            { op: "load", type: "i32", align: 4, offset: BRANCH_HEADER_SIZE_OFFSET },
            { op: "const", type: "i32", value: BRANCH_HEADER_SIZE },
            { op: "binary", wasm: "i32.add" },
            { op: "local.tee", name: bytes },
            { op: "local.get", name: ptr },
            { op: "binary", wasm: "i32.add" },
            { op: "local.set", name: fresh },
            { op: "local.get", name: fresh },
            { op: "local.get", name: ptr },
            { op: "local.get", name: bytes },
            { op: "memory.copy" },
            { op: "local.get", name: fresh },
            { op: "local.get", name: fresh },
            { op: "load", type: "i32", align: 4, offset: BRANCH_HEADER_FLAGS_OFFSET },
            { op: "const", type: "i32", value: BRANCH_CLEAR_COPIED_FLAGS_MASK },
            { op: "binary", wasm: "i32.and" },
            { op: "store", type: "i32", align: 4, offset: BRANCH_HEADER_FLAGS_OFFSET },
            { op: "local.get", name: fresh },
            { op: "unary", wasm: "i64.extend_i32_u" },
          ],
        },
      ],
    },
  ];
}

function lowerBranchIsBranched(arg: Expr, ctx: LowerContext, locals: Set<string>): Instr[] {
  const ptr = branchTemp(ctx, locals, "ptr");
  return [
    ...lowerExpr(arg, ctx, locals, "i64"),
    { op: "unary", wasm: "i32.wrap_i64" },
    { op: "local.tee", name: ptr },
    { op: "const", type: "i32", value: 0 },
    { op: "binary", wasm: "i32.eq" },
    {
      op: "if",
      results: ["i32"],
      thenBody: [{ op: "const", type: "i32", value: 0 }],
      elseBody: [
        { op: "local.get", name: ptr },
        { op: "load", type: "i32", align: 4, offset: BRANCH_HEADER_FLAGS_OFFSET },
        { op: "const", type: "i32", value: BRANCH_FLAG_BRANCHED },
        { op: "binary", wasm: "i32.and" },
        { op: "const", type: "i32", value: 0 },
        { op: "binary", wasm: "i32.ne" },
      ],
    },
  ];
}

function branchTemp(ctx: LowerContext, locals: Set<string>, suffix: string): string {
  const name = `__branch_${suffix}${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name, type: "i32" });
  locals.add(name);
  return name;
}

function packTemporalHandle(
  ptr: Expr,
  rev: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  return [
    ...lowerExpr(ptr, ctx, locals, "i32"),
    { op: "unary", wasm: "i64.extend_i32_u" },
    ...lowerExpr(rev, ctx, locals, "i32"),
    { op: "unary", wasm: "i64.extend_i32_u" },
    { op: "const", type: "i64", value: 32 },
    { op: "binary", wasm: "i64.shl" },
    { op: "binary", wasm: "i64.or" },
  ];
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
  return flattenBinding(stmt.name, type, ctx.layouts).map((slot) => ({
    name: slot.name,
    type: slot.wat,
  }));
}

function flattenType(type: string | undefined, layouts: LayoutEnv): LayoutSlot[] {
  type = stripBorrowType(type);
  const staticShape = flattenStaticShapeType(type, layouts);
  if (staticShape) return staticShape;
  const resolved = resolveAlias(type, layouts);
  if (!resolved) return [{ suffix: "", type: "i32", wat: "i32" }];
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
  const refsArgs = typeCallArgs(resolved, "ComponentRefs");
  const queryRowArgs = typeCallArgs(resolved, "QueryRow");
  const ergonomicRowArgs = typeCallArgs(resolved, "Row");
  const rowArgs = queryRowArgs ?? ergonomicRowArgs;
  const valuesArgs = typeCallArgs(resolved, "Values");
  const componentValuesArgs = typeCallArgs(resolved, "ComponentValues") ?? valuesArgs ??
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
  const refsArgs = typeCallArgs(type, "ComponentRefs");
  const slotArgs = typeCallArgs(type, "ComponentSlot");
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
  const worldArgs = typeCallArgs(type, "World2d");
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
  const queryRowArgs = typeCallArgs(type, "QueryRow");
  const ergonomicRowArgs = typeCallArgs(type, "Row");
  const rowArgs = queryRowArgs ?? ergonomicRowArgs;
  const valuesArgs = typeCallArgs(type, "Values");
  const argsText = typeCallArgs(type, "ComponentValues") ?? valuesArgs ?? refsArgs ?? rowArgs;
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

function stripReferenceType(type: string | undefined): string | undefined {
  return stripBorrowType(type);
}

function unwrapPrefixedType(type: string, prefix: "&"): string {
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
      case "do":
        return visit(item.expr);
      case "let":
        visit(item.value);
        return;
      case "destructure_let":
        visit(item.value);
        for (const name of item.names) names.add(name);
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

function exprMentionsName(expr: Expr, name: string): boolean {
  const target = baseName(name);
  let found = false;
  const visit = (item: Expr | undefined) => {
    if (!item || found) return;
    switch (item.kind) {
      case "var":
        found = baseName(item.name) === target;
        return;
      case "call":
        visit(item.callee);
        item.args.forEach(visit);
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
        if (item.name !== target) visit(item.body);
        return;
      case "match":
        visit(item.value);
        for (const arm of item.arms) {
          if (!patternBindingNames(arm.pattern).includes(target)) visit(arm.value);
        }
        return;
      case "shape":
      case "product_constructor":
        item.slots.forEach((slot) => visit(slot.value));
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
        for (const stmt of item.statements) {
          if (stmt.kind !== "proof_const") visit(stmt.value);
        }
        visit(item.expr);
        return;
      case "literal":
      case "placeholder":
        return;
    }
  };
  visit(expr);
  return found;
}

function hasRuntimeEffect(expr: Expr, functions: Map<string, FnDecl>): boolean {
  switch (expr.kind) {
    case "call":
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

function usesTemporalIntrinsic(expr: Expr | BlockExpr, functions: Map<string, FnDecl>): boolean {
  const visit = (item: Expr | Statement | undefined): boolean => {
    if (!item) return false;
    switch (item.kind) {
      case "do":
        return visit(item.expr);
      case "let":
        return visit(item.value);
      case "destructure_let":
        return visit(item.value);
      case "proof_const":
      case "literal":
      case "var":
      case "placeholder":
        return false;
      case "const_fn":
        return visit(item.body);
      case "call":
        return (item.callee.kind === "var" &&
          isTemporalIntrinsic(item.callee.name, functions)) ||
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

function usesBranchIntrinsic(expr: Expr | BlockExpr, functions: Map<string, FnDecl>): boolean {
  const visit = (item: Expr | Statement | undefined): boolean => {
    if (!item) return false;
    switch (item.kind) {
      case "do":
        return visit(item.expr);
      case "let":
        return visit(item.value);
      case "destructure_let":
        return visit(item.value);
      case "proof_const":
      case "literal":
      case "var":
      case "placeholder":
        return false;
      case "const_fn":
        return visit(item.body);
      case "call":
        return (item.callee.kind === "var" &&
          isBranchIntrinsic(item.callee.name, functions)) ||
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

function isTemporalIntrinsic(name: string, functions: Map<string, FnDecl>): boolean {
  if (
    name === "@temporal_alloc" || name === "@temporal_handle" ||
    name === "@temporal_handle_ptr" || name === "@temporal_handle_rev"
  ) return true;
  const fn = functions.get(name);
  const id = fn ? intrinsicWrapperId(fn) : undefined;
  return id === "temporal_alloc" || id === "temporal_handle" ||
    id === "temporal_handle_ptr" || id === "temporal_handle_rev";
}

function isBranchIntrinsic(name: string, functions: Map<string, FnDecl>): boolean {
  if (
    name === "@branch_handle" || name === "@branch_handle_ptr" ||
    name === "@branch_mark" || name === "@branch_is_branched" ||
    name === "@branch_ensure_editable" || name === "@branch_materialize"
  ) return true;
  const fn = functions.get(name);
  const id = fn ? intrinsicWrapperId(fn) : undefined;
  return id === "branch_handle" || id === "branch_handle_ptr" ||
    id === "branch_mark" || id === "branch_is_branched" ||
    id === "branch_ensure_editable" || id === "branch_materialize";
}

function localDecls(locals: BackendLocal[]): number[] {
  const groups: { type: ValueType; count: number }[] = [];
  for (const local of locals) {
    const previous = groups[groups.length - 1];
    if (previous?.type === local.type) previous.count++;
    else groups.push({ type: local.type, count: 1 });
  }
  return vecItems(groups.map((group) => [...uleb(group.count), wasmType(group.type)]));
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
    "i32.xor": 0x73,
    "i32.shl": 0x74,
    "i32.shr_u": 0x76,
    "i64.and": 0x83,
    "i64.or": 0x84,
    "i64.xor": 0x85,
    "i64.shl": 0x86,
    "i64.shr_u": 0x88,
    "i32.eq": 0x46,
    "i32.ne": 0x47,
    "i32.lt_s": 0x48,
    "i32.le_s": 0x4c,
    "i32.gt_s": 0x4a,
    "i32.ge_s": 0x4e,
    "i32.eqz": 0x45,
    "i64.eqz": 0x50,
  } as Record<string, number>)[op] ?? 0x6a;
}

function wasmUnaryOp(op: string): number {
  return ({
    "i32.wrap_i64": 0xa7,
    "i64.extend_i32_u": 0xad,
  } as Record<string, number>)[op] ?? 0xa7;
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
  if (type === "i32") return [0x28];
  if (type === "i64") return [0x29];
  if (type === "f32") return [0x2a];
  if (type === "f64") return [0x2b];
  throw new Error(`unsupported load type ${type}`);
}

function wasmStoreOp(type: ValueType): number[] {
  if (type === "v128") return [0xfd, ...uleb(0x0b)];
  if (type === "i32") return [0x36];
  if (type === "i64") return [0x37];
  if (type === "f32") return [0x38];
  if (type === "f64") return [0x39];
  throw new Error(`unsupported store type ${type}`);
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
  bytes.push(id);
  bytes.push(...uleb(payload.length));
  for (const byte of payload) bytes.push(byte);
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
