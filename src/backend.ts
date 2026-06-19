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
  TypeExpr,
} from "./core_ast.ts";
import { runtimeProgramFromProgram } from "./check.ts";
import { CompileError } from "./diagnostics.ts";
import {
  type OptimizationDecision,
  type OptimizeProfile,
  type OptimizeProfileName,
  optimizeProgram,
  type OptMode,
  type RewriteRuleId,
} from "./optimize.ts";
import { isCatchAllPattern, patternBindingNames } from "./patterns.ts";
import {
  intrinsicCallId,
  intrinsicIdsByFunctionName,
  intrinsicWrapperId,
  isIntrinsicWrapper,
} from "./primitives.ts";
import {
  type CompilerPluginOptions,
  type CompilerPluginRegistry,
  createCompilerPluginRegistry,
} from "./plugins.ts";
import { type CompileTraceSink, traceInstant, traceSync } from "./trace.ts";
import {
  type I32Range,
  parseRefinedI32Type,
  refinedI32DomainDifference,
  type ScalarFacts,
  scalarFactsAnyI32,
  scalarFactsAreNonNegative,
  scalarFactsContainsFacts,
  scalarFactsContainsLiteral,
  scalarFactsFromDomain,
  scalarFactsFromI32Range,
  scalarFactsFromRefinedI32Type,
  scalarFactsIntersect,
  scalarFactsNumericRange,
  scalarFactsUnsignedBitWidth,
} from "./refined_scalar.ts";
import { wgslShaderId } from "./wgsl.ts";

export interface BackendModule {
  imports: BackendImport[];
  functions: BackendFunction[];
  memories: BackendMemory[];
  data: BackendData[];
  customSections?: BackendCustomSection[];
  abi?: FigAbiManifest;
  debugTraces: FigDebugTraceSite[];
  profileSites: FigProfileSite[];
  branchHints: boolean;
}

export interface FigDebugTraceSite {
  id: number;
  message: string;
}

export interface FigProfileSite {
  id: number;
  label: string;
}

export interface BackendPhaseTimings {
  optimizeMs: number;
  layoutMs: number;
  lowerMs: number;
  cleanupMs: number;
}

export interface LoweredBackendArtifact {
  module: BackendModule;
  timings: BackendPhaseTimings;
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

interface BackendCustomSection {
  name: string;
  bytes: number[];
}

interface BackendImport {
  name: string;
  importName?: string;
  params: ValueType[];
  results: ValueType[];
}

export interface BackendFunction {
  name: string;
  exportName?: string;
  params: BackendLocal[];
  results: ValueType[];
  locals: BackendLocal[];
  body: Instr[];
}

export interface BackendFunctionCacheEntry {
  fn: BackendFunction;
}

export interface WasmFunctionCacheEntry {
  environmentKey: string;
  bytes: number[];
  hints: BranchHintEntry[];
}

export interface BackendLayoutCacheEntry {
  layouts: LayoutEnv;
}

export interface BackendPlanningCacheEntry {
  returnProjectionPlans: Map<string, ReturnProjectionPlan>;
  closureDescriptors: ClosureDescriptor[];
  fixedArrayPlans?: ReturnType<typeof analyzeFixedArrayPlans>;
}

export interface BackendCache {
  backendLayouts?: Map<string, BackendLayoutCacheEntry>;
  backendLayoutPlans?: Map<string, BackendPlanningCacheEntry>;
  backendBodyCalls?: WeakMap<object, Set<string>>;
  backendDirectCalls?: WeakMap<object, Extract<Expr, { kind: "call" }>[]>;
  backendTailCalls?: WeakMap<object, TailCallAnalysis>;
  backendCallCounts?: WeakMap<object, Map<string, number>>;
  backendNameUses?: WeakMap<object, Map<string, number>>;
  backendInlineCosts?: WeakMap<object, number>;
  backendFunctionHashes?: WeakMap<object, string>;
  backendPlanningHashes?: WeakMap<object, string>;
  backendFunctions?: Map<string, BackendFunctionCacheEntry>;
  wasmFunctions?: WeakMap<BackendFunction, WasmFunctionCacheEntry>;
  wasmNameSections?: Map<string, number[]>;
}

interface BackendLocal {
  name: string;
  type: ValueType;
}

type ValueType = "i32" | "i64" | "f32" | "f64" | "v128";

export interface FigAbiManifest {
  name: "fig.memory";
  version: 1;
  target: "wasm32-core-3-browser";
  pointer: "i32";
  endian: "little";
  objectHeader: {
    byteSize: 16;
    fields: {
      name: "layout_id" | "payload_bytes" | "flags" | "ref_count";
      offset: number;
      type: "i32";
    }[];
  };
  memories: { name: string; exportName: string; minPages: number }[];
  helpers: {
    version: "fig_abi_version";
    allocObject: "fig_alloc_object";
    allocBuffer: "fig_alloc_buffer";
    retain: "fig_retain";
    release: "fig_release";
  };
  exports: FigAbiFunction[];
  imports: FigAbiFunction[];
  layouts: FigAbiLayout[];
}

export interface FigAbiFunction {
  name: string;
  params: FigAbiValue[];
  results: FigAbiValue[];
}

export interface FigAbiValue {
  name?: string;
  type: string;
  passing: "direct" | "handle";
  wat: ValueType[];
  layoutId?: number;
}

export interface FigAbiLayout {
  id: number;
  type: string;
  kind: "scalar" | "record" | "sum" | "heap_array";
  category?:
    | "primitive"
    | "product"
    | "inline_array"
    | "string"
    | "sum"
    | "heap_array"
    | "io"
    | "opaque";
  passing?: "direct" | "handle";
  size: number;
  align: number;
  fields: FigAbiLayoutField[];
  variants?: FigAbiVariant[];
  item?: { type: string; stride: number; fields: FigAbiLayoutField[] };
}

export interface FigAbiLayoutField {
  name: string;
  type: string;
  wat: ValueType;
  offset: number;
  size: number;
}

export interface FigAbiVariant {
  name: string;
  tag: number;
  fields: FigAbiLayoutField[];
}

const I32_MIN = -0x8000_0000;
const I32_MAX = 0x7fff_ffff;

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
  | { op: "memory.size"; memory?: string }
  | { op: "memory.grow"; memory?: string }
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
  pluginRegistry: CompilerPluginRegistry;
  scratchPlansByFunction?: Map<string, Map<string, ScratchArrayPlan>>;
  packedPlansByFunction?: Map<string, Map<string, PackedArrayPlan>>;
  localSlotPlansByFunction?: Map<string, Map<string, LocalSlotArrayPlan>>;
  returnProjectionPlans?: Map<string, ReturnProjectionPlan>;
  scratchArrays?: Map<string, ScratchArrayPlan>;
  packedArrays?: Map<string, PackedArrayPlan>;
  cleanupPackedArrays?: Map<string, PackedArrayPlan>;
  localSlotArrays?: Map<string, LocalSlotArrayPlan>;
  packedArrayReadCache?: Map<string, string>;
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
  simdDotHelperName?: string;
  scalarParamFactsByFunction?: Map<string, Map<string, ScalarFacts>>;
  localScalarFacts?: Map<string, ScalarFacts>;
  closureDescriptors?: ClosureDescriptor[];
  closureIds?: Map<string, number>;
  closureDispatcherSignatures?: Map<string, ClosureSignature>;
  debugTraceSites?: FigDebugTraceSite[];
  runtimeProfile?: boolean;
  profileSites?: FigProfileSite[];
  backendCache?: BackendCache;
  trace?: CompileTraceSink;
}

interface ClosureDescriptor {
  id: number;
  target: string;
  params: Param[];
  captures: Param[];
  returnType: string;
}

interface ClosureSignature {
  params: { name?: string; type: string }[];
  returnType: string;
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

export interface LayoutEnv {
  types: Map<string, TypeDecl>;
  constShapes: Map<string, Extract<Expr, { kind: "shape" }>>;
  constRuntimeValues: Map<string, Expr>;
  constRuntimeTypes: Map<string, string | undefined>;
  constFunctionFields: Map<string, string>;
  topLevelValues: Set<string>;
  constNumbers: Map<string, number>;
}

export type TailCallMode = "opcode";
export type MemoryModel = "branch-debug" | "branch";

export interface BackendOptions extends CompilerPluginOptions {
  tailCallMode?: TailCallMode;
  memoryModel?: MemoryModel;
  optMode?: OptMode;
  profile?: OptimizeProfileName | OptimizeProfile;
  runtimeProfile?: boolean;
  branchHints?: boolean;
  assumeRewrites?: boolean;
  compileTrace?: CompileTraceSink;
  backendCache?: BackendCache;
}

const BRANCH_MEMORIES: BackendMemory[] = [
  { name: "fig_objects", exportName: "fig_objects", minPages: 1 },
  { name: "fig_buffers", exportName: "fig_buffers", minPages: 1 },
];

const HEAP_MIN_PAGES = 16;

const SIMD_DOT4_I32_HELPER = "__fig_dot4_i32";

function isCurrentModulePublic(fn: FnDecl): boolean {
  return fn.rootPublic ?? (fn.public && !fn.imported);
}

export function emitWat(program: Program, options: BackendOptions = {}): string {
  return watFromBackendModule(lowerProgramToBackendModule(program, options));
}

export function emitWasm(
  program: Program,
  options: BackendOptions = {},
): Uint8Array<ArrayBuffer> {
  return wasmFromBackendModule(lowerProgramToBackendModule(program, options), {
    debugNames: (options.optMode ?? "debug") === "debug",
    cache: options.backendCache,
    trace: options.compileTrace,
  });
}

export function summarizeBackendLayoutDecisions(
  program: Program,
  options: BackendOptions = {},
): OptimizationDecision[] {
  const plan = backendFixedArrayPlanning(program, options);
  const decisions: OptimizationDecision[] = [];
  for (const [fnName, plans] of plan.packed) {
    for (const item of plans.values()) {
      decisions.push(layoutDecision(fnName, item.name, "array.layout_packed", {
        layout: "packed",
        reason:
          `InlineArray(${item.capacity}, ${item.itemType}) fits packed ${item.packedType}; total width ${
            item.capacity * item.bitWidth
          } bits`,
        evidence: {
          function: fnName,
          target: item.name,
          capacity: item.capacity,
          itemType: item.itemType,
          bitWidth: item.bitWidth,
          packedType: item.packedType,
        },
      }));
    }
  }
  for (const [fnName, plans] of plan.localSlots) {
    for (const item of plans.values()) {
      decisions.push(layoutDecision(fnName, item.name, "array.layout_local_slots", {
        layout: "local_slots",
        reason: `InlineArray(${item.capacity}, ${item.itemType}) stays in local slots`,
        evidence: {
          function: fnName,
          target: item.name,
          capacity: item.capacity,
          itemType: item.itemType,
        },
      }));
    }
  }
  for (const [fnName, plans] of plan.scratch) {
    for (const item of plans.values()) {
      decisions.push(layoutDecision(fnName, item.name, "array.layout_scratch", {
        layout: "scratch",
        reason:
          `InlineArray(${item.capacity}, ${item.itemType}) uses scratch storage for dynamic access`,
        evidence: {
          function: fnName,
          target: item.name,
          capacity: item.capacity,
          itemType: item.itemType,
          valueType: item.valueType,
          byteSize: item.byteSize,
        },
      }));
    }
  }
  return decisions;
}

function backendFixedArrayPlanning(
  program: Program,
  options: BackendOptions,
): ReturnType<typeof analyzeFixedArrayPlans> {
  const memoryModel = options.memoryModel ?? "branch";
  if (!isMemoryModel(memoryModel)) {
    throw new CompileError([{
      code: "backend.memory_model",
      message: `unknown memory model ${memoryModel}`,
    }]);
  }
  const optMode = options.optMode ?? "debug";
  const pluginRegistry = createCompilerPluginRegistry(options.plugins);
  if (pluginRegistry.diagnostics.length) throw new CompileError([...pluginRegistry.diagnostics]);
  const optimized = optimizeProgram(program, {
    optMode,
    profile: options.profile,
    runtimeProfile: options.runtimeProfile,
    assumeRewrites: options.assumeRewrites,
    plugins: options.plugins,
    trace: options.compileTrace,
  });
  const runtimeProgram = runtimeProgramFromProgram(optimized);
  const layouts = createLayoutEnv(runtimeProgram);
  const imports = runtimeProgram.imports.map((item) => importAsFn(item));
  const runtimeFns = runtimeProgram.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && !decl.primitiveId && !isIntrinsicWrapper(decl, pluginRegistry) &&
    !decl.params.some((param) => param.const) &&
    Boolean(decl.returnType)
  );
  const sourceFns = runtimeProgram.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && Boolean(decl.returnType)
  );
  const returnProjectionPlans = privateReturnProjectionPlans(runtimeFns, layouts);
  const projectedRuntimeFns = runtimeFns.map((fn) => {
    const plan = returnProjectionPlans.get(fn.name);
    return plan ? { ...fn, returnType: plan.type } : fn;
  });
  const closureDescriptors = collectClosureDescriptors(sourceFns, projectedRuntimeFns);
  const closureIds = new Map(closureDescriptors.map((item) => [item.target, item.id]));
  const baseCtx: LowerContext = {
    layouts,
    functions: new Map([...imports, ...sourceFns, ...projectedRuntimeFns].map((fn) => [
      fn.name,
      fn,
    ])),
    signatures: new Map([...imports, ...projectedRuntimeFns].map((fn) => [fn.name, fn])),
    intrinsicIdsByName: intrinsicIdsByFunctionName(runtimeProgram.declarations, pluginRegistry),
    pluginRegistry,
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
  const reachableProjectedFns = removeUnreachablePrivateFunctions(
    projectedRuntimeFns,
    new Set(layouts.constFunctionFields.values()),
  );
  const functions = addOptimizedExportClones(
    reachableProjectedFns,
    (fn) => scratchWorthyFixedArrayTargets(fn.body, baseCtx).size > 0,
  );
  const signatures = new Map([...imports, ...functions].map((fn) => [fn.name, fn]));
  const ctx: LowerContext = {
    ...baseCtx,
    functions: new Map([...imports, ...sourceFns, ...functions].map((fn) => [fn.name, fn])),
    signatures,
    scalarParamFactsByFunction: inferTailParamScalarFacts(functions, options.backendCache),
    closureDescriptors,
    closureIds,
    closureDispatcherSignatures: new Map(),
  };
  return analyzeFixedArrayPlans(functions, ctx);
}

function layoutDecision(
  fnName: string,
  targetName: string,
  action: RewriteRuleId,
  input: {
    layout: "packed" | "scratch" | "local_slots";
    reason: string;
    evidence: Record<string, unknown>;
  },
): OptimizationDecision {
  return {
    pass: "lower.layout",
    target: `${fnName}.${targetName}`,
    action,
    reason: input.reason,
    evidence: { ...input.evidence, layout: input.layout },
  };
}

export function compileBackendModule(
  program: Program,
  options: BackendOptions = {},
): BackendModule {
  return lowerProgramToBackendArtifact(program, options).module;
}

export function lowerProgramToBackendArtifact(
  program: Program,
  options: BackendOptions & { reuseCachedBackendFunctions?: boolean } = {},
): LoweredBackendArtifact {
  const memoryModel = options.memoryModel ?? "branch";
  if (!isMemoryModel(memoryModel)) {
    throw new CompileError([{
      code: "backend.memory_model",
      message: `unknown memory model ${memoryModel}`,
    }]);
  }
  const optMode = options.optMode ?? "debug";
  const pluginRegistry = createCompilerPluginRegistry(options.plugins);
  if (pluginRegistry.diagnostics.length) throw new CompileError([...pluginRegistry.diagnostics]);

  const optimizeStart = performance.now();
  const optimized = optimizeProgram(program, {
    optMode,
    profile: options.profile,
    runtimeProfile: options.runtimeProfile,
    assumeRewrites: options.assumeRewrites,
    plugins: options.plugins,
    trace: options.compileTrace,
  });
  const optimizeMs = performance.now() - optimizeStart;

  const layoutStart = performance.now();
  const runtimeProgram = traceSync(
    options.compileTrace,
    "backend.layout.runtime_program",
    () => runtimeProgramFromProgram(optimized),
  );
  const layouts = traceSync(
    options.compileTrace,
    "backend.layout.layouts",
    () => cachedLayoutEnv(runtimeProgram, options.backendCache),
  );
  const imports = traceSync(
    options.compileTrace,
    "backend.layout.imports",
    () => runtimeProgram.imports.map((item) => importAsFn(item)),
  );
  const runtimeFns = traceSync(
    options.compileTrace,
    "backend.layout.runtime_functions",
    () =>
      runtimeProgram.declarations.filter((decl): decl is FnDecl =>
        decl.kind === "fn" && !decl.primitiveId && !isIntrinsicWrapper(decl, pluginRegistry) &&
        !decl.params.some((param) => param.const) &&
        Boolean(decl.returnType)
      ),
  );
  const sourceFns = traceSync(
    options.compileTrace,
    "backend.layout.source_functions",
    () =>
      runtimeProgram.declarations.filter((decl): decl is FnDecl =>
        decl.kind === "fn" && Boolean(decl.returnType)
      ),
  );
  const backendPlanningKey = traceSync(
    options.compileTrace,
    "backend.layout.plan_key",
    () =>
      options.backendCache?.backendLayoutPlans
        ? backendLayoutPlanningCacheKey(
          sourceFns,
          runtimeFns,
          layouts,
          memoryModel,
          optMode,
          options.tailCallMode,
          options.backendCache?.backendPlanningHashes,
        )
        : undefined,
  );
  const cachedBackendPlanning = backendPlanningKey
    ? options.backendCache?.backendLayoutPlans?.get(backendPlanningKey)
    : undefined;
  const returnProjectionPlans = traceSync(
    options.compileTrace,
    "backend.layout.return_projection_plans",
    () =>
      cachedBackendPlanning?.returnProjectionPlans ?? privateReturnProjectionPlans(
        runtimeFns,
        layouts,
      ),
  );
  const projectedRuntimeFns = traceSync(
    options.compileTrace,
    "backend.layout.project_returns",
    () => {
      return runtimeFns.map((fn) => {
        const plan = returnProjectionPlans.get(fn.name);
        if (!plan) return fn;
        return { ...fn, returnType: plan.type };
      });
    },
  );
  const closureDescriptors = traceSync(
    options.compileTrace,
    "backend.layout.closure_descriptors",
    () =>
      cachedBackendPlanning?.closureDescriptors ??
        collectClosureDescriptors(sourceFns, projectedRuntimeFns),
  );
  traceInstant(options.compileTrace, "backend.layout.plan_cache", {
    cacheHit: Boolean(cachedBackendPlanning),
  });
  const closureIds = new Map(closureDescriptors.map((item) => [item.target, item.id]));
  const baseCtx: LowerContext = {
    layouts,
    functions: new Map([...imports, ...sourceFns, ...projectedRuntimeFns].map((fn) => [
      fn.name,
      fn,
    ])),
    signatures: new Map([...imports, ...projectedRuntimeFns].map((fn) => [fn.name, fn])),
    intrinsicIdsByName: intrinsicIdsByFunctionName(runtimeProgram.declarations, pluginRegistry),
    pluginRegistry,
    returnProjectionPlans,
    tempIndex: 0,
    tempLocals: [],
    tailCallMode: options.tailCallMode,
    memoryModel,
    optMode,
    inlineStack: new Set(),
    fixedArrayTransformerAliases: new Map(),
    nextDataOffset: 1024,
    closureDescriptors,
    closureIds,
    closureDispatcherSignatures: new Map(),
    debugTraceSites: [],
    runtimeProfile: options.runtimeProfile ?? false,
    profileSites: [],
    backendCache: options.backendCache,
    trace: options.compileTrace,
  };
  const reachableProjectedFns = traceSync(
    options.compileTrace,
    "backend.layout.reachable_functions",
    () =>
      removeUnreachablePrivateFunctions(
        projectedRuntimeFns,
        new Set([
          ...layouts.constFunctionFields.values(),
          ...closureDescriptors.map((item) => item.target),
        ]),
        options.backendCache,
      ),
  );
  const functions = traceSync(
    options.compileTrace,
    "backend.layout.optimized_export_clones",
    () =>
      addOptimizedExportClones(
        reachableProjectedFns,
        (fn) => {
          return scratchWorthyFixedArrayTargets(fn.body, baseCtx).size > 0;
        },
      ),
  );
  const signatures = new Map([...imports, ...functions].map((fn) => [fn.name, fn]));
  const ctx: LowerContext = {
    ...baseCtx,
    functions: new Map([...imports, ...sourceFns, ...functions].map((fn) => [fn.name, fn])),
    signatures,
    scalarParamFactsByFunction: inferTailParamScalarFacts(functions, options.backendCache),
    closureDescriptors,
    closureIds,
    closureDispatcherSignatures: new Map(),
    backendCache: options.backendCache,
    trace: options.compileTrace,
  };
  const fixedArrayPlans = traceSync(
    options.compileTrace,
    "backend.layout.fixed_array_plans",
    () => cachedBackendPlanning?.fixedArrayPlans ?? analyzeFixedArrayPlans(functions, ctx),
  );
  if (backendPlanningKey && !cachedBackendPlanning) {
    options.backendCache?.backendLayoutPlans?.set(backendPlanningKey, {
      returnProjectionPlans,
      closureDescriptors,
      fixedArrayPlans,
    });
  } else if (cachedBackendPlanning && !cachedBackendPlanning.fixedArrayPlans) {
    cachedBackendPlanning.fixedArrayPlans = fixedArrayPlans;
  }
  ctx.scratchPlansByFunction = fixedArrayPlans.scratch;
  ctx.packedPlansByFunction = fixedArrayPlans.packed;
  ctx.localSlotPlansByFunction = fixedArrayPlans.localSlots;
  const layoutMs = performance.now() - layoutStart;

  const lowerStart = performance.now();
  const backendCacheEnvKey = traceSync(
    options.compileTrace,
    "backend.lower.environment_key",
    () => {
      if (!options.backendCache?.backendFunctions) return undefined;
      return backendFunctionEnvironmentKey(ctx);
    },
  );
  const loweredFunctions = lowerFunctions(
    functions,
    ctx,
    options.backendCache,
    options.compileTrace,
    backendCacheEnvKey,
    options.reuseCachedBackendFunctions === true,
  );
  const closureDispatchers = lowerClosureDispatchers(ctx);
  const debugTraceSites = (optMode === "debug" ? ctx.debugTraceSites ?? [] : [])
    .toSorted((left, right) => left.id - right.id);
  const debugTraceImports: BackendImport[] = debugTraceSites.length
    ? [{ name: "__fig_trace", importName: "fig_trace", params: ["i32"], results: [] }]
    : [];
  const profileSites = options.runtimeProfile
    ? (ctx.profileSites ?? []).toSorted((left, right) => left.id - right.id)
    : [];
  const profileImports: BackendImport[] = profileSites.length
    ? [
      {
        name: "__fig_profile_enter",
        importName: "fig_profile_enter",
        params: ["i32"],
        results: [],
      },
      { name: "__fig_profile_exit", importName: "fig_profile_exit", params: ["i32"], results: [] },
    ]
    : [];
  let backendFunctions =
    [...loweredFunctions, ...closureDispatchers].some((fn) =>
        instrsCallFunction(fn.body, SIMD_DOT4_I32_HELPER)
      )
      ? [...loweredFunctions, ...closureDispatchers, simdDot4I32HelperFunction()]
      : [...loweredFunctions, ...closureDispatchers];
  const lowerMs = performance.now() - lowerStart;

  const cleanupStart = performance.now();
  if (optMode === "release") {
    backendFunctions = inlineTrivialConstBackendFunctions(backendFunctions);
  }
  const needsScratchMemory = traceSync(
    options.compileTrace,
    "backend.cleanup.needs_scratch_memory",
    () => {
      const scratchPlans = ctx.scratchPlansByFunction;
      if (!scratchPlans) return false;
      return [...scratchPlans.values()].some((plans) => plans.size > 0);
    },
  );
  const needsBranchMemory = traceSync(
    options.compileTrace,
    "backend.cleanup.needs_branch_memory",
    () =>
      functions.some((fn) => functionCallsBranchIntrinsic(fn, ctx.functions, options.backendCache)),
  );
  const needsHeapMemory = traceSync(
    options.compileTrace,
    "backend.cleanup.needs_heap_memory",
    () =>
      closureDescriptors.length > 0 ||
      functions.some((fn) =>
        functionCallsHeapArrayIntrinsic(fn, ctx.functions, options.backendCache)
      ),
  );
  const needsAbiMemory = traceSync(
    options.compileTrace,
    "backend.cleanup.needs_abi_memory",
    () =>
      functions.some((fn) =>
        isCurrentModulePublic(fn) && functionNeedsMemoryAbi(fn, ctx.layouts)
      ) ||
      imports.some((fn) => functionNeedsMemoryAbi(fn, ctx.layouts)),
  );
  const rawMemories = traceSync(
    options.compileTrace,
    "backend.cleanup.memories",
    () =>
      needsAbiMemory
        ? ensureAbiMemories(backendMemories(
          needsBranchMemory,
          needsScratchMemory,
          true,
        ))
        : backendMemories(
          needsBranchMemory,
          needsScratchMemory,
          needsHeapMemory,
        ),
  );
  const abiManifest = traceSync(
    options.compileTrace,
    "backend.cleanup.abi_manifest",
    () =>
      createFigAbiManifest(
        rawMemories,
        functions,
        imports,
        ctx.layouts,
      ),
  );
  const abiFunctions = traceSync(
    options.compileTrace,
    "backend.cleanup.abi_runtime_functions",
    () => memoryAbiRuntimeFunctions(ctx.layouts, functions, imports),
  );
  const backendImports = traceSync(
    options.compileTrace,
    "backend.cleanup.imports",
    () => [
      ...debugTraceImports,
      ...profileImports,
      ...imports.map((fn) => {
        const wrappedImport = functionNeedsMemoryAbi(fn, layouts);
        return {
          name: wrappedImport ? abiImportRawName(fn.name) : fn.name,
          importName: fn.externalName,
          params: wrappedImport
            ? fn.params.flatMap((param) => abiParamWat(param.type, layouts))
            : fn.params.flatMap((param) =>
              flattenType(param.type, layouts).map((slot) => slot.wat)
            ),
          results: wrappedImport
            ? abiResultWat(fn.returnType, layouts)
            : flattenType(fn.returnType, layouts).map((slot) => slot.wat),
        };
      }),
    ],
  );
  const reachableBackendFunctions = traceSync(
    options.compileTrace,
    "backend.cleanup.remove_unreachable",
    () => removeUnreachableBackendFunctions(backendFunctions),
  );
  const wrappedBackendFunctions = traceSync(
    options.compileTrace,
    "backend.cleanup.memory_abi_wrappers",
    () =>
      memoryAbiWrappedFunctions(
        reachableBackendFunctions,
        functions,
        imports,
        ctx,
      ),
  );
  const module = {
    imports: backendImports,
    functions: wrappedBackendFunctions,
    memories: rawMemories,
    data: [],
    customSections: [
      figAbiCustomSection(abiManifest),
      ...(debugTraceSites.length ? [figTraceCustomSection(debugTraceSites)] : []),
      ...(profileSites.length ? [figProfileCustomSection(profileSites)] : []),
    ],
    abi: abiManifest,
    debugTraces: debugTraceSites,
    profileSites,
    branchHints: options.branchHints ?? optMode === "release",
  };
  if (abiFunctions.length) {
    module.functions = [...module.functions, ...abiFunctions];
  }
  const cleanupMs = performance.now() - cleanupStart;
  return {
    module,
    timings: {
      optimizeMs,
      layoutMs,
      lowerMs,
      cleanupMs,
    },
  };
}

export function lowerProgramToBackendModule(
  program: Program,
  options: BackendOptions = {},
): BackendModule {
  return lowerProgramToBackendArtifact(program, options).module;
}

function backendMemories(
  needsBranchMemory: boolean,
  needsScratchMemory: boolean,
  needsHeapMemory: boolean,
): BackendMemory[] {
  const withHeapCapacity = (memories: BackendMemory[]) =>
    memories.map((memory) =>
      memory.name === "fig_objects"
        ? { ...memory, minPages: Math.max(memory.minPages, HEAP_MIN_PAGES) }
        : memory
    );
  const heapObjects = { ...BRANCH_MEMORIES[0]!, minPages: HEAP_MIN_PAGES };
  if (needsBranchMemory) {
    return needsHeapMemory ? withHeapCapacity(BRANCH_MEMORIES) : BRANCH_MEMORIES;
  }
  if (needsHeapMemory && needsScratchMemory) return [heapObjects, BRANCH_MEMORIES[1]!];
  if (needsHeapMemory) return [heapObjects];
  return needsScratchMemory ? [BRANCH_MEMORIES[1]!] : [];
}

function isMemoryModel(value: string): value is MemoryModel {
  return value === "branch-debug" || value === "branch";
}

function ensureAbiMemories(memories: BackendMemory[]): BackendMemory[] {
  const byName = new Map(memories.map((memory) => [memory.name, memory]));
  const objects = byName.get("fig_objects") ?? { ...BRANCH_MEMORIES[0]!, minPages: HEAP_MIN_PAGES };
  const buffers = byName.get("fig_buffers") ?? BRANCH_MEMORIES[1]!;
  const ordered = [
    { ...objects, minPages: Math.max(objects.minPages, HEAP_MIN_PAGES) },
    buffers,
  ];
  for (const memory of memories) {
    if (memory.name !== "fig_objects" && memory.name !== "fig_buffers") ordered.push(memory);
  }
  return ordered;
}

function abiImportRawName(name: string): string {
  return `__fig_import_${name}`;
}

function functionNeedsMemoryAbi(fn: FnDecl, layouts: LayoutEnv): boolean {
  return fn.params.some((param) => abiPassing(param.type, layouts) === "handle") ||
    abiPassing(fn.returnType, layouts) === "handle";
}

function abiParamWat(type: string | undefined, layouts: LayoutEnv): ValueType[] {
  return abiPassing(type, layouts) === "handle"
    ? ["i32"]
    : flattenType(type, layouts).map((slot) => slot.wat);
}

function abiResultWat(type: string | undefined, layouts: LayoutEnv): ValueType[] {
  return abiPassing(type, layouts) === "handle"
    ? ["i32"]
    : flattenType(type, layouts).map((slot) => slot.wat);
}

function abiPassing(type: string | undefined, layouts: LayoutEnv): "direct" | "handle" {
  if (typeNeedsMemoryAbiValue(type, layouts)) return "handle";
  const stripped = stripBorrowType(type)?.trim();
  if (!stripped) return "direct";
  const resolved = resolveAlias(stripped, layouts) ?? stripped;
  if (parseBackendFnSignature(resolved)) return "direct";
  if (isPrimitiveType(resolved) || parseRefinedI32Type(resolved)) return "direct";
  return flattenType(stripped, layouts).length > 1 ? "handle" : "direct";
}

function typeNeedsMemoryAbiValue(
  type: string | undefined,
  layouts: LayoutEnv,
  seen = new Set<string>(),
): boolean {
  const stripped = stripBorrowType(type)?.trim();
  if (!stripped || seen.has(stripped)) return false;
  seen.add(stripped);
  const resolved = resolveAlias(stripped, layouts) ?? stripped;
  if (resolved !== stripped && typeNeedsMemoryAbiValue(resolved, layouts, seen)) return true;
  if (resolved === "string") return true;
  if (parseBackendFnSignature(resolved)) return false;
  if (typeCallArgs(resolved, "HeapArray") !== undefined) return true;
  const decl = layouts.types.get(typeName(resolved));
  if (decl?.normalized?.kind === "product" || decl?.normalized?.kind === "sum") return true;
  const open = resolved.indexOf("(");
  if (open > 0 && resolved.endsWith(")")) {
    const args = splitTypeArgs(resolved.slice(open + 1, -1));
    if (args.some((arg) => typeNeedsMemoryAbiValue(arg, layouts, seen))) return true;
  }
  return false;
}

function memoryAbiWrappedFunctions(
  backendFunctions: BackendFunction[],
  sourceFns: FnDecl[],
  imports: FnDecl[],
  ctx: LowerContext,
): BackendFunction[] {
  const publicByName = new Map(sourceFns.filter(isCurrentModulePublic).map((fn) => [fn.name, fn]));
  const rewritten = backendFunctions.map((fn) => {
    const source = publicByName.get(fn.name);
    return source && functionNeedsMemoryAbi(source, ctx.layouts)
      ? { ...fn, exportName: undefined }
      : fn;
  });
  const publicWrappers = sourceFns
    .filter((fn) => isCurrentModulePublic(fn) && functionNeedsMemoryAbi(fn, ctx.layouts))
    .map((fn) => memoryAbiExportWrapper(fn, ctx));
  const importWrappers = imports
    .filter((fn) => functionNeedsMemoryAbi(fn, ctx.layouts))
    .map((fn) => memoryAbiImportWrapper(fn, ctx));
  return [...rewritten, ...importWrappers, ...publicWrappers];
}

function memoryAbiExportWrapper(fn: FnDecl, ctx: LowerContext): BackendFunction {
  const params = fn.params.flatMap((param) =>
    abiPassing(param.type, ctx.layouts) === "handle"
      ? [{ name: param.name, type: "i32" as const }]
      : flattenBinding(param.name, param.type, ctx.layouts).map((slot) => ({
        name: slot.name,
        type: slot.wat,
      }))
  );
  const locals: BackendLocal[] = [];
  const body: Instr[] = [];
  for (const param of fn.params) {
    if (abiPassing(param.type, ctx.layouts) === "handle") {
      body.push(...abiDecodeHandle(param.name, param.type, ctx.layouts));
    } else {
      for (const slot of flattenBinding(param.name, param.type, ctx.layouts)) {
        body.push({ op: "local.get", name: slot.name });
      }
    }
  }
  body.push({ op: "call", name: fn.name });
  const resultType = fn.returnType;
  if (abiPassing(resultType, ctx.layouts) === "handle") {
    body.push(...abiEncodeStackResult(resultType, ctx.layouts, locals, `__abi_ret`));
  }
  return {
    name: `__fig_abi_export_${fn.name}`,
    exportName: fn.name,
    params,
    results: abiResultWat(fn.returnType, ctx.layouts),
    locals,
    body,
  };
}

function memoryAbiImportWrapper(fn: FnDecl, ctx: LowerContext): BackendFunction {
  const params = fn.params.flatMap((param) =>
    flattenBinding(param.name, param.type, ctx.layouts).map((slot) => ({
      name: slot.name,
      type: slot.wat,
    }))
  );
  const locals: BackendLocal[] = [];
  const body: Instr[] = [];
  for (const param of fn.params) {
    if (abiPassing(param.type, ctx.layouts) === "handle") {
      const slots = flattenBinding(param.name, param.type, ctx.layouts);
      for (const slot of slots) body.push({ op: "local.get", name: slot.name });
      body.push(
        ...abiEncodeStackResult(param.type, ctx.layouts, locals, `__abi_arg_${param.name}`),
      );
    } else {
      for (const slot of flattenBinding(param.name, param.type, ctx.layouts)) {
        body.push({ op: "local.get", name: slot.name });
      }
    }
  }
  body.push({ op: "call", name: abiImportRawName(fn.name) });
  if (abiPassing(fn.returnType, ctx.layouts) === "handle") {
    const handle = `__abi_import_result${locals.length}`;
    locals.push({ name: handle, type: "i32" });
    body.push({ op: "local.set", name: handle });
    body.push(...abiDecodeHandle(handle, fn.returnType, ctx.layouts));
  }
  return {
    name: fn.name,
    params,
    results: flattenType(fn.returnType, ctx.layouts).map((slot) => slot.wat),
    locals,
    body,
  };
}

function abiDecodeHandle(
  handleName: string,
  type: string | undefined,
  layouts: LayoutEnv,
): Instr[] {
  const layout = abiLayoutForType(type, layouts);
  return layout.fields.map((field): Instr[] => [
    { op: "local.get", name: handleName },
    {
      op: "load",
      type: field.wat,
      align: Math.min(field.size, 8),
      offset: ABI_OBJECT_HEADER_SIZE + field.offset,
      memory: "fig_objects",
    },
  ]).flat();
}

function abiEncodeStackResult(
  type: string | undefined,
  layouts: LayoutEnv,
  locals: BackendLocal[],
  prefix: string,
): Instr[] {
  const layout = abiLayoutForType(type, layouts);
  const valueLocals = layout.fields.map((field, index) => ({
    name: `${prefix}_${index}`,
    type: field.wat,
    field,
  }));
  const ptr = `${prefix}_ptr`;
  locals.push(...valueLocals.map((item) => ({ name: item.name, type: item.type })));
  locals.push({ name: ptr, type: "i32" });
  return [
    ...valueLocals.toReversed().map((item): Instr => ({ op: "local.set", name: item.name })),
    { op: "const", type: "i32", value: signedI32Const(layout.id) },
    { op: "const", type: "i32", value: layout.size },
    { op: "call", name: "fig_alloc_object" },
    { op: "local.tee", name: ptr },
    ...valueLocals.flatMap((item): Instr[] => [
      { op: "local.get", name: ptr },
      { op: "local.get", name: item.name },
      {
        op: "store",
        type: item.type,
        align: Math.min(item.field.size, 8),
        offset: ABI_OBJECT_HEADER_SIZE + item.field.offset,
        memory: "fig_objects",
      },
    ]),
  ];
}

const ABI_OBJECT_HEADER_SIZE = 16;

function memoryAbiRuntimeFunctions(
  _layouts: LayoutEnv,
  functions: FnDecl[],
  imports: FnDecl[],
): BackendFunction[] {
  const needsAbi =
    functions.some((fn) => isCurrentModulePublic(fn) && functionNeedsMemoryAbi(fn, _layouts)) ||
    imports.some((fn) => functionNeedsMemoryAbi(fn, _layouts));
  if (!needsAbi) return [];
  return [
    figAbiVersionFunction(),
    figAllocObjectFunction(),
    figAllocBufferFunction(),
    figRetainFunction("fig_retain", 1),
    figRetainFunction("fig_release", -1),
  ];
}

function figAbiVersionFunction(): BackendFunction {
  return {
    name: "fig_abi_version",
    exportName: "fig_abi_version",
    params: [],
    results: ["i32"],
    locals: [],
    body: [{ op: "const", type: "i32", value: 1 }],
  };
}

function figAllocObjectFunction(): BackendFunction {
  return figAllocInMemoryFunction("fig_alloc_object", "fig_objects", true);
}

function figAllocBufferFunction(): BackendFunction {
  return figAllocInMemoryFunction("fig_alloc_buffer", "fig_buffers", false);
}

function figAllocInMemoryFunction(
  name: string,
  memory: string,
  hasLayoutId: boolean,
): BackendFunction {
  const sizeValue = hasLayoutId ? "payload_bytes" : "byte_len";
  return {
    name,
    exportName: name,
    params: [
      ...(hasLayoutId ? [{ name: "layout_id", type: "i32" as const }] : []),
      { name: sizeValue, type: "i32" },
    ],
    results: ["i32"],
    locals: [
      { name: "size", type: "i32" },
      { name: "current", type: "i32" },
      { name: "next", type: "i32" },
      { name: "pages", type: "i32" },
    ],
    body: [
      { op: "local.get", name: sizeValue },
      { op: "const", type: "i32", value: ABI_OBJECT_HEADER_SIZE + 15 },
      { op: "binary", wasm: "i32.add" },
      { op: "const", type: "i32", value: -16 },
      { op: "binary", wasm: "i32.and" },
      { op: "local.set", name: "size" },
      { op: "const", type: "i32", value: 0 },
      { op: "load", type: "i32", align: 4, offset: 0, memory },
      { op: "local.tee", name: "current" },
      { op: "const", type: "i32", value: 0 },
      { op: "binary", wasm: "i32.eq" },
      {
        op: "if",
        results: ["i32"],
        thenBody: [{ op: "const", type: "i32", value: 16 }],
        elseBody: [{ op: "local.get", name: "current" }],
      },
      { op: "local.set", name: "current" },
      { op: "local.get", name: "current" },
      { op: "local.get", name: "size" },
      { op: "binary", wasm: "i32.add" },
      { op: "local.set", name: "next" },
      { op: "memory.size", memory },
      { op: "local.tee", name: "pages" },
      { op: "const", type: "i32", value: 16 },
      { op: "binary", wasm: "i32.shl" },
      { op: "local.get", name: "next" },
      { op: "binary", wasm: "i32.lt_u" },
      {
        op: "if",
        results: [],
        thenBody: [
          { op: "local.get", name: "next" },
          { op: "const", type: "i32", value: 0xffff },
          { op: "binary", wasm: "i32.add" },
          { op: "const", type: "i32", value: 16 },
          { op: "binary", wasm: "i32.shr_u" },
          { op: "local.get", name: "pages" },
          { op: "binary", wasm: "i32.sub" },
          { op: "memory.grow", memory },
          { op: "const", type: "i32", value: -1 },
          { op: "binary", wasm: "i32.eq" },
          {
            op: "if",
            results: [],
            thenBody: [{ op: "unreachable" }],
            elseBody: [],
          },
        ],
        elseBody: [],
      },
      { op: "const", type: "i32", value: 0 },
      { op: "local.get", name: "next" },
      { op: "store", type: "i32", align: 4, offset: 0, memory },
      ...(hasLayoutId
        ? [
          { op: "local.get", name: "current" } as Instr,
          { op: "local.get", name: "layout_id" } as Instr,
          { op: "store", type: "i32", align: 4, offset: 0, memory } as Instr,
        ]
        : [
          { op: "local.get", name: "current" } as Instr,
          { op: "const", type: "i32", value: 0 } as Instr,
          { op: "store", type: "i32", align: 4, offset: 0, memory } as Instr,
        ]),
      { op: "local.get", name: "current" },
      { op: "local.get", name: sizeValue },
      { op: "store", type: "i32", align: 4, offset: 4, memory },
      { op: "local.get", name: "current" },
      { op: "const", type: "i32", value: 0 },
      { op: "store", type: "i32", align: 4, offset: 8, memory },
      { op: "local.get", name: "current" },
      { op: "const", type: "i32", value: 1 },
      { op: "store", type: "i32", align: 4, offset: 12, memory },
      { op: "local.get", name: "current" },
    ],
  };
}

function figRetainFunction(name: string, delta: number): BackendFunction {
  return {
    name,
    exportName: name,
    params: [{ name: "ptr", type: "i32" }],
    results: ["i32"],
    locals: [{ name: "count", type: "i32" }],
    body: [
      { op: "local.get", name: "ptr" },
      { op: "const", type: "i32", value: 0 },
      { op: "binary", wasm: "i32.eq" },
      {
        op: "if",
        results: ["i32"],
        thenBody: [{ op: "const", type: "i32", value: 0 }],
        elseBody: [
          { op: "local.get", name: "ptr" },
          { op: "load", type: "i32", align: 4, offset: 12, memory: "fig_objects" },
          { op: "const", type: "i32", value: delta },
          { op: "binary", wasm: "i32.add" },
          { op: "local.set", name: "count" },
          { op: "local.get", name: "ptr" },
          { op: "local.get", name: "count" },
          { op: "store", type: "i32", align: 4, offset: 12, memory: "fig_objects" },
          { op: "local.get", name: "ptr" },
        ],
      },
    ],
  };
}

function createFigAbiManifest(
  memories: BackendMemory[],
  functions: FnDecl[],
  imports: FnDecl[],
  layouts: LayoutEnv,
): FigAbiManifest {
  const layoutById = new Map<number, FigAbiLayout>();
  const value = (type: string | undefined, name?: string): FigAbiValue => {
    const passing = abiPassing(type, layouts);
    const layout = abiLayoutForType(type, layouts);
    layoutById.set(layout.id, layout);
    return {
      ...(name ? { name } : {}),
      type: type ?? "i32",
      passing,
      wat: passing === "handle" ? ["i32"] : flattenType(type, layouts).map((slot) => slot.wat),
      ...(passing === "handle" ? { layoutId: layout.id } : {}),
    };
  };
  return {
    name: "fig.memory",
    version: 1,
    target: "wasm32-core-3-browser",
    pointer: "i32",
    endian: "little",
    objectHeader: {
      byteSize: ABI_OBJECT_HEADER_SIZE,
      fields: [
        { name: "layout_id" as const, offset: 0, type: "i32" as const },
        { name: "payload_bytes" as const, offset: 4, type: "i32" as const },
        { name: "flags" as const, offset: 8, type: "i32" as const },
        { name: "ref_count" as const, offset: 12, type: "i32" as const },
      ],
    },
    memories: memories.map((memory) => ({
      name: memory.name,
      exportName: memory.exportName,
      minPages: memory.minPages,
    })),
    helpers: {
      version: "fig_abi_version",
      allocObject: "fig_alloc_object",
      allocBuffer: "fig_alloc_buffer",
      retain: "fig_retain",
      release: "fig_release",
    },
    exports: functions.filter(isCurrentModulePublic).map((fn) => ({
      name: fn.name,
      params: fn.params.map((param) => value(param.type, param.name)),
      results: fn.returnType ? [value(fn.returnType)] : [],
    })),
    imports: imports.map((fn) => ({
      name: fn.externalName ?? fn.name,
      params: fn.params.map((param) => value(param.type, param.name)),
      results: fn.returnType ? [value(fn.returnType)] : [],
    })),
    layouts: [...layoutById.values()].toSorted((left, right) => left.id - right.id),
  };
}

function abiLayoutForType(type: string | undefined, layouts: LayoutEnv): FigAbiLayout {
  const fields: FigAbiLayoutField[] = [];
  let offset = 0;
  let align = 4;
  for (const slot of flattenType(type, layouts)) {
    const size = valueTypeByteSize(slot.wat);
    const slotAlign = Math.min(size, 8);
    offset = alignTo(offset, slotAlign);
    align = Math.max(align, slotAlign);
    fields.push({
      name: slot.suffix || "value",
      type: slot.type,
      wat: slot.wat,
      offset,
      size,
    });
    offset += size;
  }
  const size = alignTo(offset, align);
  const rendered = type ?? "i32";
  const passing = abiPassing(type, layouts);
  const kind = abiLayoutKind(rendered, fields, layouts);
  const extra = abiLayoutMetadata(rendered, layouts);
  return {
    id: stableAbiLayoutId(rendered, fields),
    type: rendered,
    kind,
    passing,
    size,
    align,
    fields,
    ...extra,
  };
}

function abiLayoutKind(
  type: string,
  fields: FigAbiLayoutField[],
  layouts: LayoutEnv,
): FigAbiLayout["kind"] {
  if (typeCallArgs(type, "HeapArray") !== undefined) return "heap_array";
  const decl = layouts.types.get(typeName(resolveAlias(type, layouts) ?? type));
  if (decl?.normalized?.kind === "sum") return "sum";
  return fields.length === 1 && fields[0]?.name === "value" ? "scalar" : "record";
}

function abiLayoutMetadata(
  type: string,
  layouts: LayoutEnv,
): Pick<FigAbiLayout, "category" | "variants" | "item"> {
  if (type === "string") return { category: "string" };
  if (ioActionItemType(type)) return { category: "io" };
  if (isPrimitiveType(type) || parseRefinedI32Type(type)) return { category: "primitive" };
  const heapArrayArgs = typeCallArgs(type, "HeapArray");
  if (heapArrayArgs !== undefined) {
    const itemType = splitTypeArgs(heapArrayArgs)[0]?.trim() ?? "i32";
    const itemFields = abiLayoutForType(itemType, layouts).fields;
    return {
      category: "heap_array",
      item: {
        type: itemType,
        stride: alignTo(
          itemFields.reduce((end, field) => Math.max(end, field.offset + field.size), 0),
          4,
        ),
        fields: itemFields,
      },
    };
  }
  if (inlineArrayLikeTypeArgs(type, layouts)) return { category: "inline_array" };
  const resolved = resolveAlias(type, layouts) ?? type;
  const decl = layouts.types.get(typeName(resolved));
  if (decl?.normalized?.kind === "sum") {
    const callArgs = typeCallArgs(resolved, typeName(resolved));
    const args = callArgs === undefined ? [] : splitTypeArgs(callArgs);
    return {
      category: "sum",
      variants: decl.normalized.variants.map((variant, tag) => ({
        name: variant.name,
        tag,
        fields: variant.shape
          ? abiFieldsForShape(
            substituteProductShapeTypeParams(variant.shape.slots, decl, args),
            layouts,
          )
          : [],
      })),
    };
  }
  if (
    productSlotsForType(type, layouts) || productSlotsForType(resolved, layouts) ||
    decl?.normalized?.kind === "product"
  ) {
    return { category: "product" };
  }
  return { category: "opaque" };
}

function abiFieldsForShape(slots: ShapeTypeSlot[], layouts: LayoutEnv): FigAbiLayoutField[] {
  const fields: FigAbiLayoutField[] = [];
  let offset = 0;
  for (const field of flattenShape(slots, layouts)) {
    const size = valueTypeByteSize(field.wat);
    const slotAlign = Math.min(size, 8);
    offset = alignTo(offset, slotAlign);
    fields.push({
      name: field.suffix || "value",
      type: field.type,
      wat: field.wat,
      offset,
      size,
    });
    offset += size;
  }
  return fields;
}

function stableAbiLayoutId(type: string, fields: FigAbiLayoutField[]): number {
  const layoutFields = fields.map(({ name, type, wat, offset, size }) => ({
    name,
    type,
    wat,
    offset,
    size,
  }));
  const source = JSON.stringify({ type, fields: layoutFields });
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function figAbiCustomSection(manifest: FigAbiManifest): BackendCustomSection {
  return {
    name: "fig.abi",
    bytes: Array.from(new TextEncoder().encode(JSON.stringify(manifest))),
  };
}

function figTraceCustomSection(sites: FigDebugTraceSite[]): BackendCustomSection {
  return {
    name: "fig.trace",
    bytes: Array.from(new TextEncoder().encode(JSON.stringify({ sites }))),
  };
}

function figProfileCustomSection(sites: FigProfileSite[]): BackendCustomSection {
  return {
    name: "fig.profile",
    bytes: Array.from(new TextEncoder().encode(JSON.stringify({ sites }))),
  };
}

function inferTailParamScalarFacts(
  functions: FnDecl[],
  cache?: BackendCache,
): Map<string, Map<string, ScalarFacts>> {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  const callsByTarget = new Map<
    string,
    { caller: string; call: Extract<Expr, { kind: "call" }> }[]
  >();
  for (const fn of functions) {
    for (const call of cachedDirectCallExprs(fn.body, cache)) {
      if (call.callee.kind !== "var") continue;
      const calls = callsByTarget.get(call.callee.name) ?? [];
      calls.push({ caller: fn.name, call });
      callsByTarget.set(call.callee.name, calls);
    }
  }

  const inferred = new Map<string, Map<string, ScalarFacts>>();
  for (const fn of functions) {
    if (!cachedAnalyzeTailCalls(fn, cache).hasOnlyTailDirectSelfCalls) continue;
    const externalCalls = (callsByTarget.get(fn.name) ?? []).filter((item) =>
      item.caller !== fn.name
    );
    if (!externalCalls.length) continue;
    const selfCalls = (callsByTarget.get(fn.name) ?? []).filter((item) => item.caller === fn.name);
    const facts = new Map<string, ScalarFacts>();
    for (const [index, param] of fn.params.entries()) {
      if (param.type !== "i32") continue;
      if (
        externalCalls.every(({ call }) =>
          exprIsObviouslyNonNegative(runtimeCallArgs(call, fn)[index])
        ) &&
        selfCalls.every(({ call }) =>
          selfTailArgPreservesNonNegative(
            runtimeCallArgs(call, fn)[index],
            param.name,
            tailParamGuardUpperBound(fn, param.name),
          )
        )
      ) {
        facts.set(param.name, nonNegativeI32Fact());
      }
    }
    if (facts.size) inferred.set(fn.name, facts);
  }
  return inferred;
}

function directCallExprs(expr: Expr | BlockExpr): Extract<Expr, { kind: "call" }>[] {
  const calls: Extract<Expr, { kind: "call" }>[] = [];
  const visit = (item: Expr | BlockExpr | Statement | undefined) => {
    if (!item) return;
    if (item.kind === "call") calls.push(item);
    if (item.kind === "type_assert") return;
    if (item.kind === "debug_trace") {
      item.args.forEach(visit);
      return;
    }
    if (item.kind === "let" || item.kind === "destructure_let") {
      visit(item.value);
      return;
    }
    if (item.kind === "block") {
      item.statements.forEach(visit);
      visit(item.expr);
      return;
    }
    for (const child of exprChildren(item as Expr)) visit(child);
  };
  visit(expr);
  return calls;
}

function cachedDirectCallExprs(
  expr: Expr | BlockExpr,
  cache?: BackendCache,
): Extract<Expr, { kind: "call" }>[] {
  const directCalls = cache?.backendDirectCalls;
  if (!directCalls) return directCallExprs(expr);
  const cached = directCalls.get(expr);
  if (cached) return cached;
  const calls = directCallExprs(expr);
  directCalls.set(expr, calls);
  return calls;
}

function runtimeCallArgs(call: Extract<Expr, { kind: "call" }>, callee: FnDecl): Expr[] {
  return call.args.slice(Math.max(0, call.args.length - callee.params.length));
}

function tailLoopCallArgs(call: Extract<Expr, { kind: "call" }>, callee: FnDecl): Expr[] {
  if (call.tailRec) return call.args;
  return runtimeCallArgs(call, callee);
}

function isTailLoopStepCall(call: Extract<Expr, { kind: "call" }>, name: string): boolean {
  if (call.tailRec) return true;
  return call.callee.kind === "var" && call.callee.name === name;
}

function directTailLoopStepCallExprs(
  expr: Expr | BlockExpr,
  name: string,
): Extract<Expr, { kind: "call" }>[] {
  return directCallExprs(expr).filter((call) => isTailLoopStepCall(call, name));
}

function exprIsObviouslyNonNegative(expr: Expr | undefined): boolean {
  const range = expr ? exprI32Range(expr) : undefined;
  return range !== undefined && range.min >= 0;
}

function selfTailArgPreservesNonNegative(
  expr: Expr | undefined,
  param: string,
  guardUpperBound: number | undefined,
): boolean {
  if (!expr) return false;
  if (expr.kind === "var" && expr.name === param) return true;
  if (exprIsObviouslyNonNegative(expr)) return true;
  const increment = tailParamLiteralIncrement(expr, param);
  if (increment !== undefined && guardUpperBound !== undefined) {
    return guardUpperBound > 0 && guardUpperBound - 1 + increment <= I32_MAX;
  }
  return false;
}

function tailParamLiteralIncrement(expr: Expr, param: string): number | undefined {
  if (expr.kind !== "binary" || expr.op !== "+") return undefined;
  if (expr.left.kind === "var" && expr.left.name === param) {
    const increment = staticIntegerLiteral(expr.right);
    return increment !== undefined && increment >= 0 ? increment : undefined;
  }
  if (expr.right.kind === "var" && expr.right.name === param) {
    const increment = staticIntegerLiteral(expr.left);
    return increment !== undefined && increment >= 0 ? increment : undefined;
  }
  return undefined;
}

function tailParamGuardUpperBound(fn: FnDecl, param: string): number | undefined {
  return exprParamGuardUpperBound(fn.body.expr, param);
}

function exprParamGuardUpperBound(expr: Expr | undefined, param: string): number | undefined {
  if (!expr) return undefined;
  if (expr.kind === "block") return exprParamGuardUpperBound(expr.expr, param);
  if (expr.kind !== "match") return undefined;
  const value = expr.value;
  if (value.kind !== "binary" || value.left.kind !== "var" || value.left.name !== param) {
    return undefined;
  }
  const right = staticIntegerLiteral(value.right);
  if (right === undefined) {
    if (value.op === "<" && value.right.kind === "var") return I32_MAX;
    return undefined;
  }
  if (value.op === "<" && right > 0) return right;
  if (value.op === "<=" && right >= 0 && right < I32_MAX) return right + 1;
  return undefined;
}

function lowerFunctions(
  functions: FnDecl[],
  ctx: LowerContext,
  cache: BackendCache | undefined,
  trace: CompileTraceSink | undefined,
  environmentKey: string | undefined,
  reuseCachedFunctions: boolean,
): BackendFunction[] {
  const backendFunctions = cache?.backendFunctions;
  if (!backendFunctions || !environmentKey) {
    return functions.map((fn) => lowerFunction(fn, ctx, trace));
  }
  let cacheHits = 0;
  let cacheMisses = 0;
  let stored = 0;
  let skippedSideEffects = 0;
  const lowered = functions.map((fn) => {
    const key = backendFunctionCacheKey(fn, ctx, environmentKey, cache?.backendFunctionHashes);
    const cached = backendFunctions.get(key);
    if (cached) {
      cacheHits += 1;
      return reuseCachedFunctions ? cached.fn : cloneBackendFunction(cached.fn);
    }
    cacheMisses += 1;
    const debugTraceCount = ctx.debugTraceSites?.length ?? 0;
    const profileSiteCount = ctx.profileSites?.length ?? 0;
    const closureDispatcherCount = ctx.closureDispatcherSignatures?.size ?? 0;
    const lowerStart = performance.now();
    const lowered = lowerFunction(fn, ctx, trace);
    const lowerMs = performance.now() - lowerStart;
    if (lowerMs > 100) {
      traceInstant(trace, "backend.lower.slow_function", {
        function: fn.name.slice(0, 120),
        nameLength: fn.name.length,
        durationMs: lowerMs,
      });
    }
    const hasSideEffects = (ctx.debugTraceSites?.length ?? 0) !== debugTraceCount ||
      (ctx.profileSites?.length ?? 0) !== profileSiteCount ||
      (ctx.closureDispatcherSignatures?.size ?? 0) !== closureDispatcherCount;
    if (hasSideEffects) {
      skippedSideEffects += 1;
    } else {
      backendFunctions.set(key, { fn: cloneBackendFunction(lowered) });
      stored += 1;
    }
    return lowered;
  });
  traceInstant(trace, "backend.lower.function_cache", {
    cacheHits,
    cacheMisses,
    stored,
    skippedSideEffects,
  });
  return lowered;
}

function backendFunctionEnvironmentKey(ctx: LowerContext): string {
  return stableBackendHash({
    memoryModel: ctx.memoryModel,
    optMode: ctx.optMode,
    tailCallMode: ctx.tailCallMode,
    returnProjectionPlans: ctx.returnProjectionPlans,
    signatures: [...ctx.signatures.values()].map((decl) => ({
      name: decl.name,
      params: decl.params.map((param) => ({
        name: param.name,
        type: param.type,
        const: param.const,
      })),
      returnType: decl.returnType,
      effects: decl.effects,
      public: decl.public,
      imported: decl.imported,
      generated: decl.generated,
    })),
    layouts: ctx.layouts,
  });
}

function backendFunctionCacheKey(
  fn: FnDecl,
  ctx: LowerContext,
  environmentKey: string,
  functionHashes?: WeakMap<object, string>,
): string {
  const sourceId = fn.span?.sourceId ?? fn.nameSpan?.sourceId ?? "<unknown>";
  const fnHash = cachedBackendHash(fn, functionHashes);
  return `backend_fn\0${sourceId}\0${fn.name}\0${
    stableBackendHash({
      fnHash,
      environmentKey,
      scratchPlans: ctx.scratchPlansByFunction?.get(fn.name),
      packedPlans: ctx.packedPlansByFunction?.get(fn.name),
      localSlotPlans: ctx.localSlotPlansByFunction?.get(fn.name),
      scalarFacts: ctx.scalarParamFactsByFunction?.get(fn.name),
    })
  }`;
}

function cachedBackendHash(value: object, cache: WeakMap<object, string> | undefined): string {
  const cached = cache?.get(value);
  if (cached) return cached;
  const hash = stableBackendHash(value);
  cache?.set(value, hash);
  return hash;
}

function backendLayoutPlanningCacheKey(
  sourceFns: FnDecl[],
  runtimeFns: FnDecl[],
  layouts: LayoutEnv,
  memoryModel: MemoryModel,
  optMode: BackendOptions["optMode"] | undefined,
  tailCallMode: TailCallMode | undefined,
  planningHashes?: WeakMap<object, string>,
): string {
  let hash = 0x811c9dc5;
  hash = hashUpdateString(hash, "backend_layout_plans");
  hash = hashUpdateString(hash, memoryModel);
  hash = hashUpdateString(hash, optMode ?? "debug");
  hash = hashUpdateString(hash, tailCallMode ?? "");
  hash = hashUpdateString(hash, stableBackendHash(layouts));
  hash = hashUpdateString(hash, "runtime");
  for (const fn of runtimeFns) {
    hash = hashUpdateString(hash, cachedBackendPlanningFunctionHash(fn, planningHashes));
  }
  hash = hashUpdateString(hash, "source");
  for (const fn of sourceFns) {
    hash = hashUpdateString(hash, cachedBackendPlanningFunctionHash(fn, planningHashes));
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cachedBackendPlanningFunctionHash(
  fn: FnDecl,
  cache: WeakMap<object, string> | undefined,
): string {
  const cached = cache?.get(fn);
  if (cached) return cached;
  let hash = 0x811c9dc5;
  hash = hashUpdateString(hash, fn.name);
  hash = hashUpdateString(hash, fn.public ? "pub" : "priv");
  hash = hashUpdateString(hash, fn.imported ? "imported" : "local");
  hash = hashUpdateString(hash, fn.generated ? "generated" : "source");
  hash = hashUpdateString(hash, fn.primitiveId ?? "");
  hash = hashUpdateString(hash, fn.returnType ?? "");
  for (const param of fn.params) {
    hash = hashUpdateString(hash, param.name);
    hash = hashUpdateString(hash, param.type);
    hash = hashUpdateString(hash, param.const ? "const" : "runtime");
  }
  hash = hashBackendPlanningValue(hash, fn.body);
  const result = (hash >>> 0).toString(16).padStart(8, "0");
  cache?.set(fn, result);
  return result;
}

function hashBackendPlanningValue(hash: number, value: unknown): number {
  if (value === undefined) return hashUpdateString(hash, "u");
  if (value === null) return hashUpdateString(hash, "n");
  switch (typeof value) {
    case "string":
      return hashUpdateString(hashUpdateString(hash, "s"), value);
    case "number":
      return hashUpdateString(hash, "d");
    case "boolean":
      return hashUpdateString(hash, value ? "t" : "f");
    case "bigint":
      return hashUpdateString(hash, "b");
    case "object":
      break;
    default:
      return hashUpdateString(hashUpdateString(hash, typeof value), `${value}`);
  }
  if (Array.isArray(value)) {
    hash = hashUpdateString(hash, "[");
    for (const item of value) {
      hash = hashBackendPlanningValue(hashUpdateString(hash, ","), item);
    }
    return hashUpdateString(hash, "]");
  }
  hash = hashUpdateString(hash, "{");
  const object = value as Record<string, unknown>;
  const isLiteral = object.kind === "literal";
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    if (isBackendMetadataKey(key)) continue;
    if (isLiteral && key === "value") continue;
    const child = object[key];
    if (child === undefined) continue;
    hash = hashUpdateString(hashUpdateString(hash, key), ":");
    hash = hashBackendPlanningValue(hash, child);
    hash = hashUpdateString(hash, ";");
  }
  return hashUpdateString(hash, "}");
}

function cloneBackendFunction(fn: BackendFunction): BackendFunction {
  return {
    name: fn.name,
    ...(fn.exportName ? { exportName: fn.exportName } : {}),
    params: fn.params.map((local) => ({ ...local })),
    results: [...fn.results],
    locals: fn.locals.map((local) => ({ ...local })),
    body: cloneInstrs(fn.body),
  };
}

function cloneInstrs(instrs: Instr[]): Instr[] {
  return instrs.map(cloneInstr);
}

function cloneInstr(instr: Instr): Instr {
  switch (instr.op) {
    case "if":
      return {
        op: "if",
        results: [...instr.results],
        thenBody: cloneInstrs(instr.thenBody),
        elseBody: cloneInstrs(instr.elseBody),
        ...(instr.branchHint ? { branchHint: instr.branchHint } : {}),
      };
    case "block":
      return {
        op: "block",
        body: cloneInstrs(instr.body),
        ...(instr.results ? { results: [...instr.results] } : {}),
      };
    case "loop":
      return {
        op: "loop",
        body: cloneInstrs(instr.body),
        ...(instr.results ? { results: [...instr.results] } : {}),
      };
    case "simd":
      return {
        ...instr,
        ...(instr.lanes ? { lanes: [...instr.lanes] } : {}),
      };
    default:
      return { ...instr };
  }
}

function stableBackendHash(value: unknown): string {
  return (hashBackendValue(0x811c9dc5, value) >>> 0).toString(16).padStart(8, "0");
}

function hashBackendValue(hash: number, value: unknown): number {
  if (value === undefined) return hashUpdateString(hash, "u");
  if (value === null) return hashUpdateString(hash, "n");
  switch (typeof value) {
    case "string":
      return hashUpdateString(hashUpdateString(hash, "s"), value);
    case "number":
      return hashUpdateString(hashUpdateString(hash, "d"), `${value}`);
    case "boolean":
      return hashUpdateString(hash, value ? "t" : "f");
    case "bigint":
      return hashUpdateString(hashUpdateString(hash, "b"), value.toString());
    case "object":
      break;
    default:
      return hashUpdateString(hashUpdateString(hash, typeof value), `${value}`);
  }
  if (Array.isArray(value)) {
    hash = hashUpdateString(hash, "[");
    for (const item of value) {
      hash = hashBackendValue(hashUpdateString(hash, ","), item);
    }
    return hashUpdateString(hash, "]");
  }
  if (value instanceof Map) {
    hash = hashUpdateString(hash, "m{");
    for (
      const [key, child] of [...value.entries()].sort(([left], [right]) =>
        `${left}`.localeCompare(`${right}`)
      )
    ) {
      hash = hashBackendValue(hashUpdateString(hash, "k"), key);
      hash = hashBackendValue(hashUpdateString(hash, ":"), child);
      hash = hashUpdateString(hash, ";");
    }
    return hashUpdateString(hash, "}");
  }
  if (value instanceof Set) {
    hash = hashUpdateString(hash, "s[");
    for (const item of [...value.values()].sort()) {
      hash = hashBackendValue(hashUpdateString(hash, ","), item);
    }
    return hashUpdateString(hash, "]");
  }
  hash = hashUpdateString(hash, "{");
  const object = value as Record<string, unknown>;
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    const child = object[key];
    if (isBackendMetadataKey(key) || child === undefined) continue;
    hash = hashUpdateString(hashUpdateString(hash, key), ":");
    hash = hashBackendValue(hash, child);
    hash = hashUpdateString(hash, ";");
  }
  return hashUpdateString(hash, "}");
}

function isBackendMetadataKey(key: string): boolean {
  return key === "span" || key === "nameSpan" || key === "typeSpan" || key === "returnTypeSpan";
}

function hashUpdateString(hash: number, text: string): number {
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

function lowerFunction(
  fn: FnDecl,
  ctx: LowerContext,
  trace?: CompileTraceSink,
): BackendFunction {
  const functionStart = performance.now();
  const phaseTimings: Record<string, number> = {};
  const phase = <T>(name: string, run: () => T): T => {
    const start = performance.now();
    const result = run();
    phaseTimings[name] = performance.now() - start;
    return result;
  };
  const params = fn.params.flatMap((param) =>
    flattenBinding(param.name, param.type, ctx.layouts).map((slot) => ({
      name: slot.name,
      type: slot.wat,
    }))
  );
  const paramNames = new Set(params.map((param) => param.name));
  const localNames = new Set(paramNames);
  const localScalarFacts = scalarFactsForFunctionParams(fn, ctx);
  const fnCtx: LowerContext = {
    ...ctx,
    tempIndex: 0,
    tempLocals: [],
    currentFn: fn,
    localTypes: new Map(fn.params.map((param) => [param.name, param.type])),
    localScalarFacts,
    scratchArrays: ctx.scratchPlansByFunction?.get(fn.name),
    packedArrays: ctx.packedPlansByFunction?.get(fn.name),
    localSlotArrays: ctx.localSlotPlansByFunction?.get(fn.name),
    packedArrayReadCache: new Map(),
    fixedArrayTransformerAliases: new Map(),
    simdDotHelperName: ctx.optMode === "release" && countDot4I32Exprs(fn.body) > 1
      ? SIMD_DOT4_I32_HELPER
      : undefined,
  };
  for (const plan of fnCtx.packedArrays?.values() ?? []) {
    fnCtx.tempLocals.push({ name: packedArrayLocalName(plan.name), type: plan.packedType });
    localNames.add(packedArrayLocalName(plan.name));
  }
  fnCtx.cleanupPackedArrays = new Map(fnCtx.packedArrays);
  const laneParamVectors = materializedLane4I32Params(fn, fnCtx);
  for (const name of laneParamVectors) {
    fnCtx.tempLocals.push({ name, type: "v128" });
    localNames.add(name);
  }
  const tailCalls = phase("tail_calls", () => cachedAnalyzeTailCalls(fn, ctx.backendCache));
  if (
    ctx.tailCallMode === "opcode" && tailCalls.hasDirectSelfCall &&
    !tailCalls.hasOnlyTailDirectSelfCalls
  ) {
    throw new CompileError([{
      code: "backend.tail_call_ineligible",
      message: `function ${fn.name} is not eligible for tail-call opcode lowering`,
    }]);
  }
  const inlineArrayLoopBody = phase(
    "inline_array_loop",
    () => lowerInlineArrayLoopFunction(fn, fnCtx, localNames),
  );
  const loweredBody = phase("body", () =>
    inlineArrayLoopBody ??
      (ctx.tailCallMode === "opcode" && tailCalls.hasOnlyTailDirectSelfCalls
        ? lowerTailOpcodeBlock(fn.body, fn, fnCtx, localNames)
        : tailCalls.hasOnlyTailDirectSelfCalls
        ? lowerTailLoopBlock(fn.body, fn, fnCtx, localNames)
        : lowerBlock(fn.body, fnCtx, localNames, fn.returnType)));
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
  const functionResultSlots = flattenType(fn.returnType, fnCtx.layouts);
  const rawBody = [...prologue, ...scratchPrologue, ...packedPrologue, ...loweredBody];
  const body = phase("cleanup", () => safeCleanupInstrs(rawBody, fnCtx));
  const bodyLocals = phase("local_names", () => instrLocalNames(body));
  const useCounts = phase("local_uses", () => instrLocalUseCounts(body));
  const declaredLocals = phase("declared_locals", () => [
    ...collectIrLocals(fn.body, fnCtx),
    ...fnCtx.tempLocals,
  ]);
  const declaredLocalNames = new Set(declaredLocals.map((local) => local.name));
  const loweredOnlyLocals = [...bodyLocals]
    .filter((name) => !paramNames.has(name) && !declaredLocalNames.has(name))
    .map((name): BackendLocal => ({ name, type: "i32" }));
  const locals = uniqueBackendLocals(
    [...declaredLocals, ...loweredOnlyLocals].filter((local) =>
      (!paramNames.has(local.name) && bodyLocals.has(local.name)) ||
      local.name.startsWith("__simd_tmp") ||
      local.name.startsWith("__tail_tmp") ||
      local.name.startsWith("__slot_tmp") ||
      local.name.startsWith("__profile_tmp")
    ),
  ).map((local, index) => ({ local, index })).toSorted((a, b) =>
    (useCounts.get(b.local.name) ?? 0) - (useCounts.get(a.local.name) ?? 0) ||
    a.index - b.index
  ).map((item) => item.local);
  const totalMs = performance.now() - functionStart;
  if (totalMs > 1000) {
    traceInstant(trace, "backend.lower.function_phases", {
      function: fn.name.slice(0, 120),
      nameLength: fn.name.length,
      durationMs: totalMs,
      tailCallsMs: phaseTimings.tail_calls,
      inlineArrayLoopMs: phaseTimings.inline_array_loop,
      bodyMs: phaseTimings.body,
      cleanupMs: phaseTimings.cleanup,
      localNamesMs: phaseTimings.local_names,
      localUsesMs: phaseTimings.local_uses,
      declaredLocalsMs: phaseTimings.declared_locals,
      bodyInstrs: countInstrs(body),
      locals: locals.length,
    });
  }
  return {
    name: fn.name,
    exportName: isCurrentModulePublic(fn) ? fn.name : undefined,
    params,
    results: functionResultSlots.map((slot) => slot.wat),
    locals,
    body,
  };
}

function lowerClosureDispatchers(ctx: LowerContext): BackendFunction[] {
  const signatures = ctx.closureDispatcherSignatures ?? new Map();
  return [...signatures.entries()].map(([key, signature]) =>
    lowerClosureDispatcher(closureDispatcherName(key), signature, ctx)
  );
}

function lowerClosureDispatcher(
  name: string,
  signature: ClosureSignature,
  ctx: LowerContext,
): BackendFunction {
  const closureParam = { name: "__closure", type: "i32" as const };
  const params = [
    closureParam,
    ...signature.params.flatMap((param, index) =>
      flattenBinding(param.name ?? `arg${index}`, param.type, ctx.layouts)
    ).map((slot) => ({ name: slot.name, type: slot.wat })),
  ];
  const resultSlots = flattenType(signature.returnType, ctx.layouts);
  const matching = (ctx.closureDescriptors ?? []).filter((descriptor) =>
    closureDescriptorMatchesSignature(descriptor, signature, ctx)
  );
  const fallback: Instr[] = [
    { op: "unreachable" },
    ...resultSlots.map((slot): Instr => ({ op: "const", type: slot.wat, value: 0 })),
  ];
  const body = matching.toReversed().reduce((elseBody, descriptor): Instr[] => [
    { op: "local.get", name: "__closure" },
    { op: "load", type: "i32", align: 4, offset: 0 },
    { op: "const", type: "i32", value: descriptor.id },
    { op: "binary", wasm: "i32.eq" },
    {
      op: "if",
      results: resultSlots.map((slot) => slot.wat),
      thenBody: [
        ...signature.params.flatMap((param, index) =>
          flattenBinding(param.name ?? `arg${index}`, param.type, ctx.layouts).map((
            slot,
          ) => ({ op: "local.get", name: slot.name } as Instr))
        ),
        ...lowerClosureCaptureLoads(descriptor, ctx),
        { op: "call", name: descriptor.target },
      ],
      elseBody,
    },
  ], fallback);
  return {
    name,
    params,
    results: resultSlots.map((slot) => slot.wat),
    locals: [],
    body,
  };
}

function closureDescriptorMatchesSignature(
  descriptor: ClosureDescriptor,
  signature: ClosureSignature,
  ctx: LowerContext,
): boolean {
  const descriptorParams = descriptor.params.flatMap((param) =>
    flattenType(param.type, ctx.layouts).map((slot) => slot.wat)
  );
  const signatureParams = signature.params.flatMap((param) =>
    flattenType(param.type, ctx.layouts).map((slot) => slot.wat)
  );
  const descriptorResults = flattenType(descriptor.returnType, ctx.layouts).map((slot) => slot.wat);
  const signatureResults = flattenType(signature.returnType, ctx.layouts).map((slot) => slot.wat);
  return wasmSlotTypesEqual(descriptorParams, signatureParams) &&
    wasmSlotTypesEqual(descriptorResults, signatureResults);
}

function wasmSlotTypesEqual(left: ValueType[], right: ValueType[]): boolean {
  return left.length === right.length && left.every((type, index) => type === right[index]);
}

function lowerClosureCaptureLoads(descriptor: ClosureDescriptor, ctx: LowerContext): Instr[] {
  let offset = 4;
  const loads: Instr[] = [];
  for (const capture of descriptor.captures) {
    for (const slot of flattenType(capture.type, ctx.layouts)) {
      const align = valueTypeByteSize(slot.wat);
      loads.push(
        { op: "local.get", name: "__closure" },
        { op: "load", type: slot.wat, align, offset },
      );
      offset += align;
    }
  }
  return loads;
}

function materializedLane4I32Params(fn: FnDecl, ctx: LowerContext): string[] {
  const counts = dot4LaneUseCounts(fn.body);
  return fn.params
    .filter((param) => isLane4I32(param.type, ctx.layouts) && (counts.get(param.name) ?? 0) > 1)
    .map((param) => param.name);
}

function simdDot4I32HelperFunction(): BackendFunction {
  const product = "__dot";
  return {
    name: SIMD_DOT4_I32_HELPER,
    params: [
      { name: "left", type: "v128" },
      { name: "right", type: "v128" },
    ],
    results: ["i32"],
    locals: [{ name: product, type: "v128" }],
    body: [
      { op: "local.get", name: "left" },
      { op: "local.get", name: "right" },
      { op: "simd", wasm: "i32x4.mul" },
      { op: "local.tee", name: product },
      { op: "local.get", name: product },
      { op: "local.get", name: product },
      { op: "simd", wasm: "i8x16.shuffle", lanes: shuffleI32Lanes([2, 3, 0, 1]) },
      { op: "simd", wasm: "i32x4.add" },
      { op: "local.tee", name: product },
      { op: "local.get", name: product },
      { op: "local.get", name: product },
      { op: "simd", wasm: "i8x16.shuffle", lanes: shuffleI32Lanes([1, 0, 3, 2]) },
      { op: "simd", wasm: "i32x4.add" },
      { op: "simd", wasm: "i32x4.extract_lane", lane: 0 },
    ],
  };
}

function addOptimizedExportClones(
  functions: FnDecl[],
  shouldClone: (fn: FnDecl) => boolean,
): FnDecl[] {
  const used = new Set(functions.map((fn) => fn.name));
  return functions.flatMap((fn) => {
    if (!isCurrentModulePublic(fn) || !shouldClone(fn)) return [fn];
    const cloneName = uniqueGeneratedFnName(`${fn.name}__optimized`, used);
    const clone: FnDecl = {
      ...fn,
      public: false,
      rootPublic: false,
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
    if (isCurrentModulePublic(fn)) {
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
    const firstParam = fn.params[0];
    if (fixedArrayTransformerForwardingExpr(fn.body, firstParam, ctx)) {
      addPlan(fn, scratchPlans, packedPlans, localSlotPlans, firstParam.name, firstParam.type);
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
      if (isCurrentModulePublic(fn)) continue;
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
        if (!callee || isCurrentModulePublic(callee)) continue;
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
  if (!cachedAnalyzeTailCalls(fn, ctx.backendCache).hasOnlyTailDirectSelfCalls) return [];
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
    if (stmt.kind === "let" || stmt.kind === "destructure_let") visit(stmt.value);
    else if (stmt.kind === "debug_trace") stmt.args.forEach(visit);
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
  if (
    !callee || isCurrentModulePublic(callee) || !callee.returnType || callee.params.length === 0
  ) {
    return undefined;
  }
  if (callee.params.some((param) => param.const)) return undefined;
  if (hasRuntimeEffect(callee.body, ctx.functions)) return undefined;
  if (
    !cachedAnalyzeTailCalls(callee, ctx.backendCache).hasOnlyTailDirectSelfCalls &&
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
): { source: Extract<Expr, { kind: "var" }>; index: Expr; value: Expr } | undefined {
  if (expr.kind !== "shape" && expr.kind !== "product_constructor") return undefined;
  const source = expr.slots.find((slot) => slot.spread)?.value;
  if (source?.kind !== "var") return undefined;
  const override = expr.slots.find((slot) => slot.index);
  if (!override?.index) return undefined;
  return { source, index: override.index, value: override.value };
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
      if (fn && !isCurrentModulePublic(fn)) calls.push(expr);
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
      case "type_assert":
      case "literal":
      case "var":
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
        {
          visit(item.value);
          const foldedValue = constFold(item.value);
          if (foldedValue.kind === "literal" && !item.arms.some((arm) => arm.guard)) {
            const selected = item.arms.find((arm) =>
              literalPatternMatches(arm.pattern, foldedValue)
            ) ?? item.arms.find((arm) => isCatchAllPattern(arm.pattern));
            visit(selected?.value);
            return;
          }
          for (const arm of item.arms) {
            visit(arm.guard);
            visit(arm.value);
          }
        }
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

function countDot4I32Exprs(block: BlockExpr): number {
  let count = 0;
  const visit = (item: Expr | Statement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "let":
      case "destructure_let":
        visit(item.value);
        return;
      case "type_assert":
      case "literal":
      case "var":
        return;
      case "binary":
        if (dot4I32Pattern(item)) count++;
        visit(item.left);
        visit(item.right);
        return;
      case "call":
        visit(item.callee);
        item.args.forEach(visit);
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
        item.arms.forEach((arm) => visit(arm.value));
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
        item.statements.forEach(visit);
        visit(item.expr);
        return;
    }
  };
  visit(block);
  return count;
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
  expectedType?: string,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const fn = ctx.functions.get(expr.callee.name);
  if (!fn) return undefined;
  const fixedUpdate = fixedArrayUpdateCall(expr, ctx);
  const localSlotUpdate = fixedUpdate
    ? localSlotPlanForName(fixedUpdate.source.name, ctx.localSlotArrays)
    : undefined;
  if (fixedUpdate && localSlotUpdate && !expectedType) {
    return [
      ...lowerLocalSlotArrayUpdateStore(localSlotUpdate, fixedUpdate, ctx, locals),
      ...lowerLocalSlotArrayMaterialize(localSlotUpdate, ctx, locals),
    ];
  }
  const packedUpdate = fixedUpdate
    ? packedPlanForName(fixedUpdate.source.name, ctx.packedArrays)
    : undefined;
  if (fixedUpdate && packedUpdate && !expectedType) {
    return [
      ...lowerPackedArrayUpdateStore(packedUpdate, fixedUpdate, ctx, locals),
      ...lowerPackedArrayMaterialize(packedUpdate, ctx, locals),
    ];
  }
  const scratchUpdate = fixedUpdate
    ? scratchPlanForName(fixedUpdate.source.name, ctx.scratchArrays)
    : undefined;
  if (fixedUpdate && scratchUpdate && !expectedType) {
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
    (_, item) => {
      const itemSubstitutions = new Map(substitutions);
      itemSubstitutions.set(plan.indexName, staticIndexExpr(item));
      const value = substituteExpr(plan.value, itemSubstitutions);
      ensureLoweringLocals(value, ctx, locals);
      const full = lowerExpr(value, ctx, locals, plan.itemType);
      if (itemSlots.length === 1) return full;
      return lowerFlattenedSlotsViaTemps(
        full,
        itemSlots,
        itemSlots.map((_, slotIndex) => slotIndex),
        ctx,
        locals,
      );
    },
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
  return expr;
}

function inlineArrayLoopPlan(fn: FnDecl, ctx: LowerContext): InlineArrayLoopPlan | undefined {
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
    isInlineArrayBuilderPushCall(arg, capacity, itemType, ctx)
  );
  if (!push || push.args.length < 3) return undefined;
  const index = push.args.at(-2);
  const value = push.args.at(-1);
  if (!index || index.kind !== "var" || !value) return undefined;
  return { capacity, itemType, indexName: index.name, value, aliases };
}

function isInlineArrayBuilderPushCall(
  expr: Extract<Expr, { kind: "call" }>,
  capacity: number,
  itemType: string,
  ctx: LowerContext,
): boolean {
  if (expr.callee.kind !== "var") return false;
  const callee = ctx.functions.get(expr.callee.name);
  const result = inlineArrayLikeTypeArgs(callee?.returnType, ctx.layouts);
  return Boolean(
    callee &&
      result &&
      result[0] === capacity &&
      result[1] === itemType &&
      expr.args.length >= 3,
  );
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
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => substituteExpr(arg, substitutions)),
        body: substituteExpr(expr.body, substitutions),
      };
    case "var":
      return substitutions.get(expr.name) ?? expr;
    case "call":
      if (expr.tailRec) {
        return {
          ...expr,
          args: expr.args.map((arg) => substituteExpr(arg, substitutions)),
        };
      }
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
    case "operator_chain":
      return {
        ...expr,
        first: substituteExpr(expr.first, substitutions),
        rest: expr.rest.map((item) => ({
          ...item,
          value: substituteExpr(item.value, substitutions),
        })),
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
        arms: expr.arms.map((arm) => {
          const scoped = new Map(substitutions);
          for (const binding of patternBindingNames(arm.pattern)) scoped.delete(binding);
          return {
            ...arm,
            guard: arm.guard ? substituteExpr(arm.guard, scoped) : undefined,
            value: substituteExpr(arm.value, scoped),
          };
        }),
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
      {
        const direct = fieldAccessName(expr);
        const replacement = direct ? substitutions.get(direct) : undefined;
        if (replacement) return replacement;
      }
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
      return expr;
  }
}

function substituteStatement(stmt: Statement, substitutions: Map<string, Expr>): Statement {
  if (stmt.kind === "let" || stmt.kind === "destructure_let") {
    return { ...stmt, value: substituteExpr(stmt.value, substitutions) } as Statement;
  }
  return stmt;
}

function cleanupInstrs(
  instrs: Instr[],
  ctx?: LowerContext,
  allowDeadLocalRoundtrip = true,
): Instr[] {
  const cleaned: Instr[] = [];
  const constLocals = new Map<string, Extract<Instr, { op: "const" }>>();
  const localAliases = new Map<string, string>();
  const flushConstLocals = () => {
    for (const [name, value] of constLocals) {
      cleaned.push(value, { op: "local.set", name });
    }
    constLocals.clear();
  };
  const resolveAlias = (name: string): string => {
    const seen = new Set<string>();
    let current = name;
    while (localAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = localAliases.get(current)!;
    }
    return current;
  };
  const clearAliasesForWrite = (name: string) => {
    localAliases.delete(name);
    for (const [alias, source] of [...localAliases]) {
      if (source === name) localAliases.delete(alias);
    }
  };
  for (let index = 0; index < instrs.length; index++) {
    let instr = cleanupInstr(instrs[index]!, ctx);
    if (instr.op === "local.get") {
      const aliased = resolveAlias(instr.name);
      if (aliased !== instr.name) instr = { op: "local.get", name: aliased };
      const folded = constLocals.get(instr.name);
      if (folded) instr = folded;
    } else if (instr.op === "local.set" || instr.op === "local.tee") {
      constLocals.delete(instr.name);
      clearAliasesForWrite(instr.name);
    } else if (
      instr.op === "if" || instr.op === "block" || instr.op === "loop" ||
      (instr.op === "call" && isObservationCall(instr.name))
    ) {
      flushConstLocals();
      localAliases.clear();
    }
    const branchPair = branchOnlyIf(instr);
    if (branchPair) {
      cleaned.push(...branchPair);
      continue;
    }
    if (instr.op === "if") {
      const folded = foldForwardedTempBranch(cleaned, instr, ctx) ??
        foldPrefixForwardedTempBranch(cleaned, instr, ctx);
      if (folded) {
        cleaned.push(folded);
        if (isTerminator(folded)) break;
        continue;
      }
      const flattened = flattenStraightLineLoopGuard(cleaned, instr);
      if (flattened) {
        cleaned.push(...flattened);
        continue;
      }
    }
    if (instr.op === "block" && !instr.results?.length && instr.body.length === 0) {
      continue;
    }
    if (instr.op === "loop" && !instr.results?.length && instr.body.length === 0) {
      continue;
    }
    const blockStoreFold = instr.op === "block"
      ? foldBlockResultStores(instr, instrs.slice(index + 1))
      : undefined;
    if (blockStoreFold) {
      cleaned.push(blockStoreFold.block);
      index += blockStoreFold.consumed;
      continue;
    }
    const previous = cleaned[cleaned.length - 1];
    if (
      allowDeadLocalRoundtrip &&
      previous?.op === "local.get" && instr.op === "local.set" && previous.name !== instr.name
    ) {
      const source = resolveAlias(previous.name);
      if (canAliasLocalCopyInStraightLine(instrs.slice(index + 1), source, instr.name)) {
        cleaned.pop();
        constLocals.delete(instr.name);
        clearAliasesForWrite(instr.name);
        localAliases.set(instr.name, source);
        continue;
      }
    }
    if (previous?.op === "local.set" && instr.op === "local.get" && previous.name === instr.name) {
      if (
        allowDeadLocalRoundtrip &&
        !instrs.slice(index + 1).some((item) => instrReadsLocal(item, instr.name))
      ) {
        cleaned.pop();
        continue;
      }
      cleaned[cleaned.length - 1] = { op: "local.tee", name: instr.name };
      continue;
    }
    if (
      allowDeadLocalRoundtrip &&
      instr.op === "local.tee" &&
      !instrs.slice(index + 1).some((item) => instrReadsLocal(item, instr.name))
    ) {
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
    if (
      beforeCurrent?.op === "local.tee" && current?.op === "local.set" &&
      beforeCurrent.name === current.name
    ) {
      cleaned.splice(cleaned.length - 2, 2, { op: "local.set", name: current.name });
      continue;
    }
    if (beforeCurrent?.op === "const" && current?.op === "local.set") {
      cleaned.splice(cleaned.length - 2, 2);
      if (
        !allowDeadLocalRoundtrip ||
        instrs.slice(index + 1).some((item) => instrReadsLocal(item, current.name))
      ) {
        constLocals.set(current.name, beforeCurrent);
      }
      continue;
    }
    const beforeBeforeCurrent = cleaned[cleaned.length - 3];
    if (
      beforeBeforeCurrent?.op === "local.get" &&
      beforeCurrent?.op === "local.set" &&
      current?.op === "local.get" &&
      beforeCurrent.name === current.name &&
      beforeBeforeCurrent.name !== current.name &&
      !instrs.slice(index + 1).some((item) => instrReadsLocal(item, current.name))
    ) {
      cleaned.splice(cleaned.length - 3, 3, { op: "local.get", name: beforeBeforeCurrent.name });
      continue;
    }
    if (
      beforeCurrent?.op === "local.set" && current?.op === "local.get" &&
      beforeCurrent.name === current.name
    ) {
      cleaned.splice(cleaned.length - 2, 2, { op: "local.tee", name: current.name });
      continue;
    }
    if (foldSetGetTeeSuffix(cleaned)) continue;
    if (
      current?.op === "br_if" &&
      beforeCurrent?.op === "binary" && beforeCurrent.wasm === "i32.eqz" &&
      beforeBeforeCurrent?.op === "binary"
    ) {
      const inverted = invertI32Comparison(beforeBeforeCurrent.wasm);
      if (inverted) {
        cleaned.splice(cleaned.length - 3, 2, { op: "binary", wasm: inverted });
        continue;
      }
    }
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
    if (foldConstSelectSuffix(cleaned)) continue;
    if (foldNestedIntegerMaskSuffix(cleaned)) continue;
    if (foldRepeatedLocalComputationSuffix(cleaned)) continue;
    if (foldRepeatedLocalComputationSetSuffix(cleaned)) continue;
    if (foldRepeatedLocalComputationUseSuffix(cleaned)) continue;
    if (foldConstSimdDotSuffix(cleaned)) continue;
    if (isTerminator(instr)) break;
  }
  if (!allowDeadLocalRoundtrip) flushConstLocals();
  return cleaned;
}

function safeCleanupInstrs(
  instrs: Instr[],
  ctx?: LowerContext,
  allowDeadLocalRoundtrip = true,
): Instr[] {
  const cleaned = cleanupInstrs(instrs, ctx, allowDeadLocalRoundtrip);
  return hasObviousStackUnderflow(cleaned) ? instrs : cleaned;
}

function canAliasLocalCopyInStraightLine(
  future: Instr[],
  source: string,
  dest: string,
): boolean {
  let readBeforeBarrier = false;
  for (let index = 0; index < future.length; index++) {
    const instr = future[index]!;
    const barrier = instr.op === "if" || instr.op === "block" || instr.op === "loop" ||
      instrWritesLocal(instr, source) || instrWritesLocal(instr, dest);
    if (barrier) {
      return readBeforeBarrier && !future.slice(index).some((item) => instrReadsLocal(item, dest));
    }
    if (instrReadsLocal(instr, dest)) readBeforeBarrier = true;
  }
  return readBeforeBarrier;
}

function foldNestedIntegerMaskSuffix(instrs: Instr[]): boolean {
  if (instrs.length < 4) return false;
  const current = instrs[instrs.length - 1];
  const maskRight = instrs[instrs.length - 2];
  const previousAnd = instrs[instrs.length - 3];
  const maskLeft = instrs[instrs.length - 4];
  if (
    current?.op !== "binary" ||
    (current.wasm !== "i32.and" && current.wasm !== "i64.and") ||
    maskRight?.op !== "const" ||
    previousAnd?.op !== "binary" ||
    previousAnd.wasm !== current.wasm ||
    maskLeft?.op !== "const"
  ) return false;
  const foldedMask = foldConstInstrBinary(maskLeft, maskRight, current.wasm);
  if (!foldedMask) return false;
  instrs.splice(instrs.length - 4, 4, foldedMask, current);
  return true;
}

function foldConstSelectSuffix(instrs: Instr[]): boolean {
  if (instrs.length < 4) return false;
  const current = instrs[instrs.length - 1];
  const condition = instrs[instrs.length - 2];
  const elseValue = instrs[instrs.length - 3];
  const thenValue = instrs[instrs.length - 4];
  if (
    current?.op !== "select" ||
    condition?.op !== "const" ||
    elseValue?.op !== "const" ||
    thenValue?.op !== "const"
  ) return false;
  instrs.splice(instrs.length - 4, 4, condition.value === 0 ? elseValue : thenValue);
  return true;
}

function foldRepeatedLocalComputationSuffix(instrs: Instr[]): boolean {
  if (instrs.length < 8) return false;
  const currentSet = instrs[instrs.length - 1];
  const currentBinary = instrs[instrs.length - 2];
  const currentConst = instrs[instrs.length - 3];
  const currentGet = instrs[instrs.length - 4];
  if (
    currentSet?.op !== "local.set" ||
    currentBinary?.op !== "binary" ||
    currentConst?.op !== "const" ||
    currentGet?.op !== "local.get"
  ) return false;
  const currentStart = instrs.length - 4;
  for (let index = currentStart - 4; index >= 0; index--) {
    const previousGet = instrs[index];
    const previousConst = instrs[index + 1];
    const previousBinary = instrs[index + 2];
    const previousSet = instrs[index + 3];
    if (
      previousGet?.op !== "local.get" ||
      previousConst?.op !== "const" ||
      previousBinary?.op !== "binary" ||
      (previousSet?.op !== "local.set" && previousSet?.op !== "local.tee")
    ) continue;
    if (
      previousGet.name !== currentGet.name ||
      previousConst.type !== currentConst.type ||
      previousConst.value !== currentConst.value ||
      previousBinary.wasm !== currentBinary.wasm
    ) continue;
    if (previousSet.name === currentSet.name) return false;
    const between = instrs.slice(index + 4, currentStart);
    if (
      between.some((item) =>
        instrWritesLocal(item, currentGet.name) || instrWritesLocal(item, previousSet.name)
      )
    ) return false;
    instrs.splice(
      currentStart,
      4,
      { op: "local.get", name: previousSet.name },
      { op: "local.set", name: currentSet.name },
    );
    return true;
  }
  return false;
}

function foldRepeatedLocalComputationSetSuffix(instrs: Instr[]): boolean {
  if (instrs.length < 7) return false;
  const currentSet = instrs[instrs.length - 1];
  const currentBinary = instrs[instrs.length - 2];
  const currentConst = instrs[instrs.length - 3];
  const currentGet = instrs[instrs.length - 4];
  if (
    currentSet?.op !== "local.set" ||
    currentBinary?.op !== "binary" ||
    currentConst?.op !== "const" ||
    currentGet?.op !== "local.get"
  ) return false;
  const currentStart = instrs.length - 4;
  for (let index = currentStart - 3; index >= 0; index--) {
    const previousGet = instrs[index];
    const previousConst = instrs[index + 1];
    const previousBinary = instrs[index + 2];
    if (
      previousGet?.op !== "local.get" ||
      previousConst?.op !== "const" ||
      previousBinary?.op !== "binary"
    ) continue;
    if (
      previousGet.name !== currentGet.name ||
      previousConst.type !== currentConst.type ||
      previousConst.value !== currentConst.value ||
      previousBinary.wasm !== currentBinary.wasm
    ) continue;
    const between = instrs.slice(index + 3, currentStart);
    if (
      between.some((item) =>
        instrWritesLocal(item, currentGet.name) || instrWritesLocal(item, currentSet.name)
      )
    ) return false;
    instrs.splice(index, 3, previousGet, previousConst, previousBinary, {
      op: "local.tee",
      name: currentSet.name,
    });
    instrs.splice(currentStart + 1, 4);
    return true;
  }
  return false;
}

function foldRepeatedLocalComputationUseSuffix(instrs: Instr[]): boolean {
  if (instrs.length < 7) return false;
  const currentBinary = instrs[instrs.length - 1];
  const currentConst = instrs[instrs.length - 2];
  const currentGet = instrs[instrs.length - 3];
  if (
    currentBinary?.op !== "binary" ||
    currentConst?.op !== "const" ||
    currentGet?.op !== "local.get"
  ) return false;
  const currentStart = instrs.length - 3;
  for (let index = currentStart - 4; index >= 0; index--) {
    const previousGet = instrs[index];
    const previousConst = instrs[index + 1];
    const previousBinary = instrs[index + 2];
    const previousSet = instrs[index + 3];
    if (
      previousGet?.op !== "local.get" ||
      previousConst?.op !== "const" ||
      previousBinary?.op !== "binary" ||
      (previousSet?.op !== "local.set" && previousSet?.op !== "local.tee")
    ) continue;
    if (
      previousGet.name !== currentGet.name ||
      previousConst.type !== currentConst.type ||
      previousConst.value !== currentConst.value ||
      previousBinary.wasm !== currentBinary.wasm
    ) continue;
    const between = instrs.slice(index + 4, currentStart);
    if (
      between.some((item) =>
        instrWritesLocal(item, currentGet.name) || instrWritesLocal(item, previousSet.name)
      )
    ) return false;
    instrs.splice(currentStart, 3, { op: "local.get", name: previousSet.name });
    return true;
  }
  return false;
}

function foldSetGetTeeSuffix(instrs: Instr[]): boolean {
  if (instrs.length < 3) return false;
  const tee = instrs[instrs.length - 1];
  const get = instrs[instrs.length - 2];
  const set = instrs[instrs.length - 3];
  if (
    tee?.op !== "local.tee" ||
    get?.op !== "local.get" ||
    set?.op !== "local.set" ||
    set.name !== get.name
  ) return false;
  instrs.splice(instrs.length - 3, 3, { op: "local.tee", name: set.name }, tee);
  return true;
}

function foldConstSimdDotSuffix(instrs: Instr[]): boolean {
  const suffixLength = 28;
  const start = instrs.length - suffixLength;
  if (start < 0) return false;
  const left = constLanePackAt(instrs, start);
  const right = constLanePackAt(instrs, start + 8);
  if (!left || !right) return false;
  const mul = instrs[start + 16];
  const firstTee = instrs[start + 17];
  const firstGetA = instrs[start + 18];
  const firstGetB = instrs[start + 19];
  const firstShuffle = instrs[start + 20];
  const firstAdd = instrs[start + 21];
  const secondTee = instrs[start + 22];
  const secondGetA = instrs[start + 23];
  const secondGetB = instrs[start + 24];
  const secondShuffle = instrs[start + 25];
  const secondAdd = instrs[start + 26];
  const extract = instrs[start + 27];
  if (
    mul?.op !== "simd" || mul.wasm !== "i32x4.mul" ||
    firstTee?.op !== "local.tee" ||
    firstGetA?.op !== "local.get" || firstGetA.name !== firstTee.name ||
    firstGetB?.op !== "local.get" || firstGetB.name !== firstTee.name ||
    firstShuffle?.op !== "simd" || firstShuffle.wasm !== "i8x16.shuffle" ||
    firstAdd?.op !== "simd" || firstAdd.wasm !== "i32x4.add" ||
    secondTee?.op !== "local.tee" || secondTee.name !== firstTee.name ||
    secondGetA?.op !== "local.get" || secondGetA.name !== firstTee.name ||
    secondGetB?.op !== "local.get" || secondGetB.name !== firstTee.name ||
    secondShuffle?.op !== "simd" || secondShuffle.wasm !== "i8x16.shuffle" ||
    secondAdd?.op !== "simd" || secondAdd.wasm !== "i32x4.add" ||
    extract?.op !== "simd" || extract.wasm !== "i32x4.extract_lane" || extract.lane !== 0
  ) return false;
  let total = 0;
  for (let lane = 0; lane < 4; lane++) {
    total = (total + Math.imul(left[lane]!, right[lane]!)) | 0;
  }
  instrs.splice(start, suffixLength, { op: "const", type: "i32", value: total });
  return true;
}

function flattenStraightLineLoopGuard(
  cleaned: Instr[],
  instr: Extract<Instr, { op: "if" }>,
): Instr[] | undefined {
  if (instr.results.length !== 0 || instr.elseBody.length !== 1) return undefined;
  const elseBranch = instr.elseBody[0];
  const thenBranch = instr.thenBody.at(-1);
  if (elseBranch?.op !== "br" || thenBranch?.op !== "br") return undefined;
  if (elseBranch.depth < 1 || thenBranch.depth < 1) return undefined;
  const thenPrefix = instr.thenBody.slice(0, -1);
  if (
    thenPrefix.some((item) =>
      instrHasBranch(item) || item.op === "if" || item.op === "block" || item.op === "loop"
    )
  ) {
    return undefined;
  }
  const condition = splitStackProducerSuffix(cleaned, 1);
  if (!condition) return undefined;
  cleaned.splice(0, cleaned.length, ...condition.prefix);
  const invertedCondition = invertConditionInstrs(condition.suffix);
  return [
    ...invertedCondition,
    {
      op: "br_if",
      depth: elseBranch.depth - 1,
      ...(instr.branchHint ? { branchHint: invertBranchHint(instr.branchHint) } : {}),
    },
    ...thenPrefix,
    { op: "br", depth: thenBranch.depth - 1 },
  ];
}

function invertConditionInstrs(instrs: Instr[]): Instr[] {
  const last = instrs.at(-1);
  if (last?.op === "binary") {
    const inverted = invertI32Comparison(last.wasm);
    if (inverted) return [...instrs.slice(0, -1), { op: "binary", wasm: inverted }];
  }
  return [...instrs, { op: "binary", wasm: "i32.eqz" }];
}

function constLanePackAt(
  instrs: Instr[],
  start: number,
): [number, number, number, number] | undefined {
  const first = instrs[start];
  const splat = instrs[start + 1];
  if (first?.op !== "const" || splat?.op !== "simd" || splat.wasm !== "i32x4.splat") {
    return undefined;
  }
  const lanes = [first.value, first.value, first.value, first.value] as [
    number,
    number,
    number,
    number,
  ];
  for (let lane = 1; lane < 4; lane++) {
    const value = instrs[start + lane * 2];
    const replace = instrs[start + lane * 2 + 1];
    if (
      value?.op !== "const" || replace?.op !== "simd" ||
      replace.wasm !== "i32x4.replace_lane" || replace.lane !== lane
    ) return undefined;
    lanes[lane] = value.value;
  }
  return lanes;
}

function foldBlockResultStores(
  instr: Extract<Instr, { op: "block" }>,
  following: Instr[],
): { block: Instr; consumed: number } | undefined {
  const resultCount = instr.results?.length ?? 0;
  if (resultCount === 0) return undefined;
  const stores = following.slice(0, resultCount);
  if (stores.length !== resultCount || !stores.every((item) => item.op === "local.set")) {
    return undefined;
  }
  const rewritten = rewriteBranchResultStores(instr.body, 0, resultCount, stores);
  if (!rewritten.changed) return undefined;
  return {
    block: { ...instr, results: [], body: rewritten.body },
    consumed: resultCount,
  };
}

function rewriteBranchResultStores(
  instrs: Instr[],
  targetDepth: number,
  resultCount: number,
  stores: Instr[],
): { body: Instr[]; changed: boolean } {
  const body: Instr[] = [];
  let changed = false;
  for (const instr of instrs) {
    if (instr.op === "br" && instr.depth === targetDepth) {
      const split = splitStackProducerSuffix(body, resultCount);
      if (!split) return { body: instrs, changed: false };
      body.splice(0, body.length, ...split.prefix, ...split.suffix, ...stores, instr);
      changed = true;
      continue;
    }
    if (instr.op === "if") {
      const thenBody = rewriteBranchResultStores(
        instr.thenBody,
        targetDepth + 1,
        resultCount,
        stores,
      );
      const elseBody = rewriteBranchResultStores(
        instr.elseBody,
        targetDepth + 1,
        resultCount,
        stores,
      );
      body.push({
        ...instr,
        thenBody: thenBody.body,
        elseBody: elseBody.body,
      });
      changed = changed || thenBody.changed || elseBody.changed;
      continue;
    }
    if (instr.op === "block" || instr.op === "loop") {
      const nested = rewriteBranchResultStores(
        instr.body,
        targetDepth + 1,
        resultCount,
        stores,
      );
      body.push({ ...instr, body: nested.body });
      changed = changed || nested.changed;
      continue;
    }
    body.push(instr);
  }
  return { body, changed };
}

function splitStackProducerSuffix(
  instrs: Instr[],
  resultCount: number,
): { prefix: Instr[]; suffix: Instr[] } | undefined {
  for (let start = instrs.length; start >= 0; start--) {
    const suffix = instrs.slice(start);
    const effect = straightLineStackEffect(suffix);
    if (effect && effect.net === resultCount && effect.min >= 0) {
      return { prefix: instrs.slice(0, start), suffix };
    }
  }
  return undefined;
}

function straightLineStackEffect(instrs: Instr[]): { net: number; min: number } | undefined {
  let height = 0;
  let min = 0;
  for (const instr of instrs) {
    const effect = instrStackEffect(instr);
    if (!effect) return undefined;
    height -= effect.pops;
    min = Math.min(min, height);
    height += effect.pushes;
  }
  return { net: height, min };
}

function instrStackEffect(instr: Instr): { pops: number; pushes: number } | undefined {
  switch (instr.op) {
    case "const":
    case "local.get":
      return { pops: 0, pushes: 1 };
    case "local.set":
    case "drop":
      return { pops: 1, pushes: 0 };
    case "local.tee":
    case "unary":
    case "load":
      return { pops: 1, pushes: 1 };
    case "binary":
      return { pops: 2, pushes: 1 };
    case "select":
      return { pops: 3, pushes: 1 };
    case "store":
      return { pops: 2, pushes: 0 };
    default:
      return undefined;
  }
}

function hasObviousStackUnderflow(instrs: Instr[]): boolean {
  let height = 0;
  for (const instr of instrs) {
    if (instr.op === "if") {
      height -= 1;
      if (height < 0) return true;
      if (
        hasObviousStackUnderflow(instr.thenBody) ||
        hasObviousStackUnderflow(instr.elseBody)
      ) {
        return true;
      }
      height = 0;
      continue;
    }
    if (instr.op === "block" || instr.op === "loop") {
      if (hasObviousStackUnderflow(instr.body)) return true;
      height = 0;
      continue;
    }
    const effect = instrStackEffect(instr);
    if (!effect) {
      height = 0;
      continue;
    }
    height -= effect.pops;
    if (height < 0) return true;
    height += effect.pushes;
  }
  return false;
}

function foldForwardedTempBranch(
  cleaned: Instr[],
  instr: Extract<Instr, { op: "if" }>,
  ctx?: LowerContext,
): Instr | undefined {
  const forwarding = forwardedElseCopy(instr.elseBody);
  if (!forwarding) return undefined;
  const setStart = forwardedSetStart(cleaned, forwarding.temps);
  if (setStart === undefined) return undefined;
  const condition = cleaned.slice(setStart + forwarding.temps.length);
  if (!condition.length || !isPureForwardedCondition(condition, forwarding)) return undefined;
  if (!isPureForwardedBranchResult(instr.thenBody, forwarding.temps)) return undefined;
  const renames = new Map(
    forwarding.temps.map((temp, index) => [temp, forwarding.targets[index]!]),
  );
  const targetSets = forwarding.targets.toReversed().map((name): Instr => ({
    op: "local.set",
    name,
  }));
  if (
    hasForwardedPackedArrayTarget(ctx, forwarding.targets) &&
    !isCurrentFunctionParamFrame(ctx, forwarding.targets) &&
    !forwardedPackedTargetsUpdatedBeforeBranch(ctx, forwarding.targets, cleaned.slice(setStart))
  ) return undefined;
  cleaned.splice(
    setStart,
    cleaned.length - setStart,
    ...targetSets,
    ...condition.map((item) => renameInstrLocals(item, renames)),
  );
  return {
    ...instr,
    thenBody: instr.thenBody.map((item) => renameInstrLocals(item, renames)),
    elseBody: [{ op: "br", depth: forwarding.depth }],
  };
}

function foldPrefixForwardedTempBranch(
  cleaned: Instr[],
  instr: Extract<Instr, { op: "if" }>,
  ctx?: LowerContext,
): Instr | undefined {
  const forwarding = forwardedElsePrefixAssignment(instr.elseBody);
  if (!forwarding) return undefined;
  const setStart = forwardedSetStart(cleaned, forwarding.temps);
  const renames = new Map(
    forwarding.temps.map((temp, index) => [temp, forwarding.targets[index]!]),
  );
  const renamedElse = [
    ...forwarding.elseBody.slice(forwarding.removePrefix, forwarding.removeStart),
    ...forwarding.elseBody.slice(
      forwarding.removeStart + forwarding.removeCount,
    ),
  ];
  const elseMentionsTemp = renamedElse.some((item) =>
    forwarding.temps.some((temp) => instrMentionsLocal(item, temp))
  );
  if (elseMentionsTemp) {
    return undefined;
  }
  if (setStart !== undefined) {
    const condition = cleaned.slice(setStart + forwarding.temps.length);
    if (!condition.length || !isPureForwardedCondition(condition, forwarding)) return undefined;
    if (!branchOnlyReadsForwardedTemps(instr.thenBody, forwarding.temps)) return undefined;
    const targetSets = forwarding.targets.toReversed().map((name): Instr => ({
      op: "local.set",
      name,
    }));
    if (
      hasForwardedPackedArrayTarget(ctx, forwarding.targets) &&
      !isCurrentFunctionParamFrame(ctx, forwarding.targets) &&
      !forwardedPackedTargetsUpdatedBeforeBranch(ctx, forwarding.targets, cleaned.slice(setStart))
    ) return undefined;
    cleaned.splice(
      setStart,
      cleaned.length - setStart,
      ...targetSets,
      ...condition.map((item) => renameInstrLocals(item, renames)),
    );
  } else {
    const rewrites = forwardedSetRewrites(cleaned, forwarding);
    if (!rewrites) return undefined;
    const condition = cleaned.slice(Math.max(...rewrites.keys()) + 1);
    if (!condition.length || !isPureForwardedCondition(condition, forwarding)) return undefined;
    if (!branchOnlyReadsForwardedTemps(instr.thenBody, forwarding.temps)) return undefined;
    if (
      hasForwardedPackedArrayTarget(ctx, forwarding.targets) &&
      !isCurrentFunctionParamFrame(ctx, forwarding.targets) &&
      !forwardedPackedTargetsUpdatedBeforeBranch(ctx, forwarding.targets, cleaned)
    ) return undefined;
    cleaned.splice(
      0,
      cleaned.length,
      ...cleaned.map((item, index) =>
        rewrites.has(index) && item.op === "local.set"
          ? { ...item, name: rewrites.get(index)! }
          : item
      ),
    );
  }
  return {
    ...instr,
    thenBody: instr.thenBody.map((item) => renameInstrLocals(item, renames)),
    elseBody: renamedElse,
  };
}

function forwardedSetRewrites(
  cleaned: Instr[],
  forwarding: { temps: string[]; targets: string[] },
): Map<number, string> | undefined {
  const rewrites = new Map<number, string>();
  for (const [index, temp] of forwarding.temps.entries()) {
    let setIndex = -1;
    for (let search = cleaned.length - 1; search >= 0; search--) {
      const instr = cleaned[search];
      if (instr.op === "local.set" && instr.name === temp) {
        setIndex = search;
        break;
      }
    }
    if (setIndex < 0 || rewrites.has(setIndex)) return undefined;
    const target = forwarding.targets[index]!;
    for (let search = setIndex + 1; search < cleaned.length; search++) {
      const instr = cleaned[search];
      if (instrReadsLocal(instr, temp) || instrReadsLocal(instr, target)) return undefined;
    }
    rewrites.set(setIndex, target);
  }
  const temps = new Set(forwarding.temps);
  for (const [index, instr] of cleaned.entries()) {
    if (rewrites.has(index)) continue;
    for (const temp of temps) {
      if (instrMentionsLocal(instr, temp)) return undefined;
    }
  }
  return rewrites;
}

function forwardedElsePrefixAssignment(
  body: Instr[],
): {
  temps: string[];
  targets: string[];
  elseBody: Instr[];
  removePrefix: number;
  removeStart: number;
  removeCount: number;
} | undefined {
  const gets: string[] = [];
  for (const instr of body) {
    if (instr.op !== "local.get") break;
    gets.push(instr.name);
  }
  if (gets.length < 2 || new Set(gets).size !== gets.length) return undefined;
  for (let index = gets.length; index < body.length; index++) {
    if (body[index]?.op !== "local.set") continue;
    let end = index;
    while (body[end]?.op === "local.set") end++;
    const run = body.slice(index, end) as Extract<Instr, { op: "local.set" }>[];
    const maxForwarded = Math.min(gets.length, run.length);
    for (let forwardedCount = maxForwarded; forwardedCount >= 2; forwardedCount--) {
      const selected = run.slice(run.length - forwardedCount);
      const middle = body.slice(forwardedCount, index + run.length - forwardedCount);
      const effect = straightLineStackEffect(middle);
      if (!effect || effect.net !== 0 || effect.min < 0) {
        continue;
      }
      const forwardedGets = gets.slice(0, forwardedCount);
      const targets = selected.map((item) => item.name).toReversed();
      if (
        new Set(targets).size === targets.length &&
        targets.every((target, targetIndex) => target !== forwardedGets[targetIndex])
      ) {
        return {
          temps: forwardedGets,
          targets,
          elseBody: body,
          removePrefix: forwardedCount,
          removeStart: index + run.length - forwardedCount,
          removeCount: forwardedCount,
        };
      }
    }
    index = end - 1;
  }
  return undefined;
}

function branchOnlyReadsForwardedTemps(instrs: Instr[], temps: string[]): boolean {
  return instrs.every((instr) => temps.every((temp) => !instrWritesLocal(instr, temp)));
}

function isCurrentFunctionParamFrame(ctx: LowerContext | undefined, targets: string[]): boolean {
  const fn = ctx?.currentFn;
  if (!fn) return false;
  const params = fn.params.flatMap((param) =>
    flattenBinding(param.name, param.type, ctx.layouts).map((slot) => slot.name)
  );
  return params.length === targets.length &&
    params.every((param, index) => param === targets[index]);
}

function hasForwardedPackedArrayTarget(ctx: LowerContext | undefined, targets: string[]): boolean {
  const packedArrays = ctx?.cleanupPackedArrays ?? ctx?.packedArrays;
  if (!packedArrays?.size) return false;
  const targetSet = new Set(targets);
  for (const plan of packedArrays.values()) {
    const slots = Array.from(
      { length: plan.capacity },
      (_, index) => scratchArrayLocalSlotName(plan.name, index),
    );
    if (slots.every((slot) => targetSet.has(slot))) return true;
  }
  return false;
}

function forwardedPackedTargetsUpdatedBeforeBranch(
  ctx: LowerContext | undefined,
  targets: string[],
  prefix: Instr[],
): boolean {
  const packedArrays = ctx?.cleanupPackedArrays ?? ctx?.packedArrays;
  if (!packedArrays?.size) return true;
  const targetSet = new Set(targets);
  for (const plan of packedArrays.values()) {
    const slots = Array.from(
      { length: plan.capacity },
      (_, index) => scratchArrayLocalSlotName(plan.name, index),
    );
    if (!slots.every((slot) => targetSet.has(slot))) continue;
    const packedLocal = packedArrayLocalName(plan.name);
    if (
      !prefix.some((item) =>
        (item.op === "local.set" || item.op === "local.tee") && item.name === packedLocal
      )
    ) return false;
  }
  return true;
}

function forwardedElseCopy(
  body: Instr[],
): { temps: string[]; targets: string[]; depth: number } | undefined {
  const branch = body.at(-1);
  if (branch?.op !== "br") return undefined;
  const prefix = body.slice(0, -1);
  if (prefix.length % 2 !== 0 || prefix.length === 0) return undefined;
  const slotCount = prefix.length / 2;
  const gets = prefix.slice(0, slotCount);
  const sets = prefix.slice(slotCount);
  if (!gets.every((item) => item.op === "local.get")) return undefined;
  if (!sets.every((item) => item.op === "local.set")) return undefined;
  const temps = gets.map((item) => (item as Extract<Instr, { op: "local.get" }>).name);
  const targets = sets.map((item) => (item as Extract<Instr, { op: "local.set" }>).name)
    .toReversed();
  if (new Set(temps).size !== temps.length || new Set(targets).size !== targets.length) {
    return undefined;
  }
  if (temps.some((temp, index) => temp === targets[index])) return undefined;
  return { temps, targets, depth: branch.depth };
}

function forwardedSetStart(cleaned: Instr[], temps: string[]): number | undefined {
  const reversedTemps = temps.toReversed();
  for (let start = cleaned.length - reversedTemps.length; start >= 0; start--) {
    let matched = true;
    for (const [index, temp] of reversedTemps.entries()) {
      const instr = cleaned[start + index];
      if (instr?.op !== "local.set" || instr.name !== temp) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return undefined;
}

function isPureForwardedCondition(
  instrs: Instr[],
  forwarding: { temps: string[]; targets: string[] },
): boolean {
  const temps = new Set(forwarding.temps);
  const targets = new Set(forwarding.targets);
  for (const instr of instrs) {
    switch (instr.op) {
      case "local.get":
        if (targets.has(instr.name)) return false;
        break;
      case "const":
      case "unary":
      case "binary":
      case "select":
      case "simd":
        break;
      default:
        return false;
    }
    if (instr.op === "local.get" && !temps.has(instr.name)) continue;
  }
  return true;
}

function isPureForwardedBranchResult(instrs: Instr[], temps: string[]): boolean {
  const branch = instrs.at(-1);
  if (branch?.op !== "br") return false;
  const tempSet = new Set(temps);
  return instrs.slice(0, -1).every((instr) => instr.op === "local.get" && tempSet.has(instr.name));
}

function renameInstrLocals(instr: Instr, renames: Map<string, string>): Instr {
  switch (instr.op) {
    case "local.get":
    case "local.set":
    case "local.tee":
      return { ...instr, name: renames.get(instr.name) ?? instr.name };
    case "if":
      return {
        ...instr,
        thenBody: instr.thenBody.map((item) => renameInstrLocals(item, renames)),
        elseBody: instr.elseBody.map((item) => renameInstrLocals(item, renames)),
      };
    case "block":
    case "loop":
      return { ...instr, body: instr.body.map((item) => renameInstrLocals(item, renames)) };
    default:
      return instr;
  }
}

function instrReadsLocal(instr: Instr, name: string): boolean {
  switch (instr.op) {
    case "local.get":
    case "local.tee":
      return instr.name === name;
    case "if":
      return instr.thenBody.some((item) => instrReadsLocal(item, name)) ||
        instr.elseBody.some((item) => instrReadsLocal(item, name));
    case "block":
    case "loop":
      return instr.body.some((item) => instrReadsLocal(item, name));
    default:
      return false;
  }
}

function isObservationCall(name: string): boolean {
  return name === "__fig_profile_enter" || name === "__fig_profile_exit" ||
    name === "__fig_trace";
}

function instrMentionsLocal(instr: Instr, name: string): boolean {
  switch (instr.op) {
    case "local.get":
    case "local.set":
    case "local.tee":
      return instr.name === name;
    case "if":
      return instr.thenBody.some((item) => instrMentionsLocal(item, name)) ||
        instr.elseBody.some((item) => instrMentionsLocal(item, name));
    case "block":
    case "loop":
      return instr.body.some((item) => instrMentionsLocal(item, name));
    default:
      return false;
  }
}

function instrWritesLocal(instr: Instr, name: string): boolean {
  switch (instr.op) {
    case "local.set":
    case "local.tee":
      return instr.name === name;
    case "if":
      return instr.thenBody.some((item) => instrWritesLocal(item, name)) ||
        instr.elseBody.some((item) => instrWritesLocal(item, name));
    case "block":
    case "loop":
      return instr.body.some((item) => instrWritesLocal(item, name));
    default:
      return false;
  }
}

function invertI32Comparison(wasm: string): string | undefined {
  switch (wasm) {
    case "i32.eq":
      return "i32.ne";
    case "i32.ne":
      return "i32.eq";
    case "i32.lt_s":
      return "i32.ge_s";
    case "i32.le_s":
      return "i32.gt_s";
    case "i32.gt_s":
      return "i32.le_s";
    case "i32.ge_s":
      return "i32.lt_s";
    case "i32.lt_u":
      return "i32.ge_u";
    case "i32.le_u":
      return "i32.gt_u";
    case "i32.gt_u":
      return "i32.le_u";
    case "i32.ge_u":
      return "i32.lt_u";
    default:
      return undefined;
  }
}

function branchOnlyIf(instr: Instr): Instr[] | undefined {
  if (instr.op !== "if" || instr.results.length > 0) return undefined;
  const [thenBranch] = instr.thenBody;
  const [elseBranch] = instr.elseBody;
  if (
    instr.thenBody.length !== 1 || instr.elseBody.length !== 1 ||
    thenBranch?.op !== "br" || elseBranch?.op !== "br" ||
    thenBranch.depth === 0 || elseBranch.depth === 0
  ) return undefined;
  return [
    { op: "br_if", depth: thenBranch.depth - 1, branchHint: instr.branchHint },
    { op: "br", depth: elseBranch.depth - 1 },
  ];
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
    case "shr_s":
      value = signed(l) >> (r & BigInt(Number(bits) - 1));
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

function cleanupInstr(instr: Instr, ctx?: LowerContext): Instr {
  if (instr.op === "if") {
    return {
      ...instr,
      thenBody: cleanupInstrs(instr.thenBody, ctx, false),
      elseBody: cleanupInstrs(instr.elseBody, ctx, false),
    };
  }
  if (instr.op === "block") {
    return {
      ...instr,
      body: cleanupInstrs(instr.body, ctx, !instr.body.some(instrHasBranch)),
    };
  }
  if (instr.op === "loop") {
    return { ...instr, body: cleanupInstrs(instr.body, ctx, false) };
  }
  return instr;
}

function instrHasBranch(instr: Instr): boolean {
  switch (instr.op) {
    case "br":
    case "br_if":
    case "return_call":
    case "unreachable":
      return true;
    case "if":
      return instr.thenBody.some(instrHasBranch) || instr.elseBody.some(instrHasBranch);
    case "block":
    case "loop":
      return instr.body.some(instrHasBranch);
    default:
      return false;
  }
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

function instrsCallFunction(instrs: Instr[], name: string): boolean {
  const visit = (instr: Instr): boolean => {
    switch (instr.op) {
      case "call":
      case "return_call":
        return instr.name === name;
      case "if":
        return instr.thenBody.some(visit) || instr.elseBody.some(visit);
      case "block":
      case "loop":
        return instr.body.some(visit);
      default:
        return false;
    }
  };
  return instrs.some(visit);
}

function inlineTrivialConstBackendFunctions(functions: BackendFunction[]): BackendFunction[] {
  const constants = new Map<string, Extract<Instr, { op: "const" }>>();
  for (const fn of functions) {
    const [only] = fn.body;
    if (
      !fn.exportName && fn.params.length === 0 && fn.results.length === 1 &&
      fn.body.length === 1 && only?.op === "const" && only.type === fn.results[0]
    ) {
      constants.set(fn.name, only);
    }
  }
  if (!constants.size) return functions;
  return functions.map((fn) => {
    const replaced = replaceTrivialConstBackendCalls(fn.body, constants);
    const body = safeCleanupInstrs(replaced);
    const used = instrLocalNames(body);
    return {
      ...fn,
      body,
      locals: fn.locals.filter((local) => used.has(local.name)),
    };
  });
}

function replaceTrivialConstBackendCalls(
  instrs: Instr[],
  constants: Map<string, Extract<Instr, { op: "const" }>>,
): Instr[] {
  return instrs.flatMap((instr): Instr[] => {
    if (instr.op === "call") {
      const constant = constants.get(instr.name);
      return constant ? [constant] : [instr];
    }
    if (instr.op === "if") {
      return [{
        ...instr,
        thenBody: replaceTrivialConstBackendCalls(instr.thenBody, constants),
        elseBody: replaceTrivialConstBackendCalls(instr.elseBody, constants),
      }];
    }
    if (instr.op === "block" || instr.op === "loop") {
      return [{ ...instr, body: replaceTrivialConstBackendCalls(instr.body, constants) }];
    }
    return [instr];
  });
}

function countInstrs(instrs: Instr[]): number {
  let count = 0;
  const stack = [...instrs];
  while (stack.length > 0) {
    const instr = stack.pop();
    if (!instr) continue;
    count += 1;
    if (instr.op === "if") {
      for (const item of instr.thenBody) stack.push(item);
      for (const item of instr.elseBody) stack.push(item);
      continue;
    }
    if (instr.op === "block" || instr.op === "loop") {
      for (const item of instr.body) stack.push(item);
    }
  }
  return count;
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
    case "profile":
      for (const arg of expr.args) collectExprLocals(arg, locals, ctx);
      collectExprLocals(expr.body, locals, ctx);
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
      {
        let valueType = exprTypeWithLocals(expr.value, ctx);
        valueType ??= exprType(expr.value, ctx.functions);
        for (const slot of flattenBinding(expr.name, valueType, ctx.layouts)) {
          locals.push({ name: slot.name, type: slot.wat });
        }
        collectExprLocals(expr.value, locals, ctx);
        collectExprLocals(expr.body, locals, ctxWithLocalType(ctx, expr.name, valueType));
      }
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
  finalUsageExpr?: Expr,
): Instr[] {
  const body: Instr[] = [];
  for (let index = 0; index < block.statements.length; index++) {
    const stmt = block.statements[index];
    const usedLater = usedNames({
      kind: "block",
      statements: block.statements.slice(index + 1),
      ...(block.expr ?? finalUsageExpr ? { expr: block.expr ?? finalUsageExpr } : {}),
    });
    const remaining: BlockExpr = {
      kind: "block",
      statements: block.statements.slice(index + 1),
      ...(block.expr ?? finalUsageExpr ? { expr: block.expr ?? finalUsageExpr } : {}),
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
  if (stmt.kind === "type_assert") return [];
  if (stmt.kind === "debug_trace") return lowerDebugTraceStatement(stmt, ctx);
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
  const projectedFixedArray = projectedFixedArrayBinding(stmt, ctx, locals, usedLaterExpr);
  if (projectedFixedArray) return projectedFixedArray;
  const projectedReturn = projectedReturnBinding(stmt, ctx, usedLaterExpr);
  if (projectedReturn) {
    const targets = projectedReturn.suffixes.map((suffix) => `${stmt.name}$${suffix}`);
    for (const target of targets) locals.add(target);
    return [
      ...lowerExpr(stmt.value, ctx, locals, projectedReturn.type),
      ...targets.toReversed().map((target): Instr => ({ op: "local.set", name: target })),
    ];
  }
  const targets = bindings.map((slot) => slot.name);
  for (const target of targets) locals.add(target);
  const statementFact = i32FactFromType(stmt.type, ctx.layouts) ?? exprI32Facts(stmt.value, ctx);
  if (statementFact && bindings.length === 1 && bindings[0]?.type === "i32") {
    rememberLocalScalarFact(ctx, bindings[0].name, statementFact);
  }
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
  rememberPackedArrayRead(stmt.value, targets, ctx);
  return [
    ...value,
    ...targets.toReversed().map((target): Instr => ({ op: "local.set", name: target })),
  ];
}

function lowerDebugTraceStatement(
  stmt: Extract<Statement, { kind: "debug_trace" }>,
  ctx: LowerContext,
): Instr[] {
  if (ctx.optMode !== "debug") return [];
  const sites = ctx.debugTraceSites ?? (ctx.debugTraceSites = []);
  const id = sites.length;
  sites.push({ id, message: stmt.message ?? "" });
  return [
    { op: "const", type: "i32", value: id },
    { op: "call", name: "__fig_trace" },
  ];
}

function lowerProfileExpr(
  expr: Extract<Expr, { kind: "profile" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  if (!ctx.runtimeProfile) return lowerExpr(expr.body, ctx, locals, expectedType);
  const sites = ctx.profileSites ?? (ctx.profileSites = []);
  const id = sites.length;
  sites.push({ id, label: expr.label ?? "" });
  const resultType = expectedType ?? exprTypeWithLocals(expr.body, ctx);
  const slots = flattenType(resultType, ctx.layouts);
  const enter: Instr[] = [
    { op: "const", type: "i32", value: id },
    { op: "call", name: "__fig_profile_enter" },
  ];
  const exit: Instr[] = [
    { op: "const", type: "i32", value: id },
    { op: "call", name: "__fig_profile_exit" },
  ];
  const body = lowerExpr(expr.body, ctx, locals, resultType);
  if (!slots.length) return [...enter, ...body, ...exit];
  const temps = slots.map((slot) => {
    const name = `__profile_tmp${ctx.tempIndex++}`;
    locals.add(name);
    ctx.tempLocals.push({ name, type: slot.wat });
    return name;
  });
  return [
    ...enter,
    ...body,
    ...temps.toReversed().map((name): Instr => ({ op: "local.set", name })),
    ...exit,
    ...temps.map((name): Instr => ({ op: "local.get", name })),
  ];
}

function projectedFixedArrayBinding(
  stmt: Statement,
  ctx: LowerContext,
  locals: Set<string>,
  usedLaterExpr: Expr | undefined,
): Instr[] | undefined {
  if (stmt.kind !== "let" || !usedLaterExpr) return undefined;
  const args = inlineArrayTypeArgs(stmt.type ?? exprTypeWithLocals(stmt.value, ctx), ctx.layouts);
  if (!args) return undefined;
  const [capacity, itemType] = args;
  const itemSlots = flattenType(itemType, ctx.layouts);
  if (itemSlots.length !== 1) return undefined;
  const uses = fixedArrayProjectionUses(usedLaterExpr, stmt.name, ctx);
  if (uses.whole || uses.indexes.size === 0) return undefined;

  const projectedSlots = [...uses.indexes].toSorted((a, b) => a - b).map((index) => ({
    index,
    value: fixedArrayTabulateSlotValue(stmt.value, capacity, itemType, index, ctx) ??
      fixedArrayLiteralSlotValue(stmt.value, index),
  }));
  if (projectedSlots.every((slot) => slot.value)) {
    return projectedSlots.flatMap(({ index, value }): Instr[] => {
      if (index < 0 || index >= capacity || !value) return [];
      const target = `${stmt.name}$${index}`;
      locals.add(target);
      return [
        ...lowerFlattenedValueSlot(value, itemType, 0, ctx, locals),
        { op: "local.set", name: target },
      ];
    });
  }

  const update = fixedArrayUpdateExpr(stmt.value, stmt.type, ctx) ??
    fixedArrayUpdateCall(stmt.value, ctx);
  if (!update || update.capacity !== capacity || update.itemType !== itemType) return undefined;
  const updateIndex = staticIntegerLiteral(update.index);
  if (updateIndex === undefined) return undefined;
  if (
    !uses.indexes.has(updateIndex) &&
    hasRuntimeEffect(update.value, ctx.functions)
  ) return undefined;

  return [...uses.indexes].toSorted((a, b) => a - b).flatMap((index): Instr[] => {
    if (index < 0 || index >= capacity) return [];
    const target = `${stmt.name}$${index}`;
    locals.add(target);
    const value = index === updateIndex ? update.value : {
      kind: "index" as const,
      target: update.source,
      index: staticIndexExpr(index),
    };
    return [
      ...lowerFlattenedValueSlot(value, itemType, 0, ctx, locals),
      { op: "local.set", name: target },
    ];
  });
}

function fixedArrayTabulateSlotValue(
  expr: Expr,
  capacity: number,
  itemType: string,
  index: number,
  ctx: LowerContext,
): Expr | undefined {
  if (index < 0 || index >= capacity) return undefined;
  if (expr.kind !== "call" || expr.callee.kind !== "var" || expr.args.length !== 0) {
    return undefined;
  }
  const typeName = backendSpecializationName(itemType);
  const match = expr.callee.name.match(
    new RegExp(`(?:^|_)InlineArray_tabulate__${capacity}__${typeName}__(.+)$`),
  );
  if (!match?.[1]) return undefined;
  const generator = ctx.functions.get(match[1]);
  if (
    !generator || generator.params.length !== 1 || hasRuntimeEffect(generator.body, ctx.functions)
  ) {
    return undefined;
  }
  return {
    kind: "call",
    callee: { kind: "var", name: generator.name },
    args: [staticIndexExpr(index)],
  };
}

function fixedArrayLiteralSlotValue(expr: Expr, index: number): Expr | undefined {
  if (index < 0 || (expr.kind !== "shape" && expr.kind !== "product_constructor")) {
    return undefined;
  }
  if (expr.slots.some((slot) => slot.spread)) return undefined;
  const indexed = expr.slots.find((slot) =>
    slot.index ? staticIntegerLiteral(slot.index) === index : false
  );
  if (indexed) return indexed.value;
  if (expr.slots.some((slot) => slot.index || slot.label)) return undefined;
  return expr.slots[index]?.value;
}

function fixedArrayProjectionUses(
  expr: Expr,
  name: string,
  ctx?: LowerContext,
): { whole: boolean; indexes: Set<number> } {
  const indexes = new Set<number>();
  let whole = false;
  const visit = (item: Expr | undefined) => {
    if (!item || whole) return;
    if (
      item.kind === "index" && item.target.kind === "var" && baseName(item.target.name) === name
    ) {
      const index = staticIntegerLiteral(item.index);
      if (index === undefined) whole = true;
      else indexes.add(index);
      return;
    }
    if (item.kind === "var" && baseName(item.name) === name) {
      const suffix = projectionSuffix(item.name);
      if (suffix !== undefined && /^-?[0-9]+$/.test(suffix)) {
        indexes.add(Number.parseInt(suffix, 10));
      } else {
        whole = true;
      }
      return;
    }
    if (ctx && item.kind === "block") {
      for (const [index, stmt] of item.statements.entries()) {
        if (stmt.kind === "type_assert") continue;
        if (stmt.kind === "let" && stmt.name === name) return;
        if (stmt.kind === "destructure_let" && stmt.names.includes(name)) return;
        if (stmt.kind === "let") {
          const update = fixedArrayUpdateExpr(
            stmt.value,
            stmt.type ?? exprTypeWithLocals(stmt.value, ctx),
            ctx,
          ) ?? fixedArrayUpdateCall(stmt.value, ctx);
          if (update && baseName(update.source.name) === name) {
            const updateIndex = staticIntegerLiteral(update.index);
            if (updateIndex === undefined) {
              whole = true;
              return;
            }
            visit(update.index);
            const later: BlockExpr = {
              kind: "block",
              statements: item.statements.slice(index + 1),
              ...(item.expr ? { expr: item.expr } : {}),
            };
            const projected = fixedArrayProjectionUses(later, stmt.name, ctx);
            if (projected.whole) {
              whole = true;
              return;
            }
            for (const projectedIndex of projected.indexes) {
              if (projectedIndex === updateIndex) visit(update.value);
              else indexes.add(projectedIndex);
            }
            continue;
          }
          const spreadUpdate = fixedArraySpreadUpdateExpr(stmt.value);
          if (spreadUpdate && baseName(spreadUpdate.source.name) === name) {
            const updateIndex = staticIntegerLiteral(spreadUpdate.index);
            if (updateIndex === undefined) {
              whole = true;
              return;
            }
            visit(spreadUpdate.index);
            const later: BlockExpr = {
              kind: "block",
              statements: item.statements.slice(index + 1),
              ...(item.expr ? { expr: item.expr } : {}),
            };
            const projected = fixedArrayProjectionUses(later, stmt.name, ctx);
            if (projected.whole) {
              whole = true;
              return;
            }
            for (const projectedIndex of projected.indexes) {
              if (projectedIndex === updateIndex) visit(spreadUpdate.value);
              else indexes.add(projectedIndex);
            }
            continue;
          }
        }
        if (stmt.kind === "let" || stmt.kind === "destructure_let") visit(stmt.value);
        else if (stmt.kind === "debug_trace") stmt.args.forEach(visit);
      }
      visit(item.expr);
      return;
    }
    for (const child of exprChildren(item)) visit(child);
  };
  visit(expr);
  return { whole, indexes };
}

function backendSpecializationName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_]/g, "_");
}

function rememberPackedArrayRead(
  value: Expr,
  targets: string[],
  ctx: LowerContext,
) {
  if (targets.length !== 1) return;
  const key = packedArrayReadKey(value, ctx);
  if (key) ctx.packedArrayReadCache?.set(key, targets[0]!);
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
  if (
    !callee || isCurrentModulePublic(callee) || !callee.returnType || callee.params.length === 0
  ) return false;
  if (callee.params.some((param) => param.const)) return false;
  if (hasRuntimeEffect(callee.body, ctx.functions)) return false;
  if (
    !cachedAnalyzeTailCalls(callee, ctx.backendCache).hasOnlyTailDirectSelfCalls &&
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
          if (stmt.kind === "type_assert") continue;
          if (stmt.kind === "debug_trace") {
            stmt.args.forEach((arg) => visit(arg, false));
            continue;
          }
          if (stmt.kind === "let" && stmt.name === name) return;
          if (stmt.kind === "destructure_let" && stmt.names.includes(name)) return;
          visit(stmt.value, false);
        }
        visit(item.expr, false);
        return;
      case "do":
        for (const stmt of item.statements) {
          if (stmt.kind === "debug_trace") stmt.args.forEach((arg) => visit(arg, false));
          else if (stmt.kind !== "type_assert") visit(stmt.value, false);
        }
        visit(item.expr, false);
        return;
      case "const_fn":
        visit(item.body, false);
        return;
      case "literal":
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
    ...lowerBlock(
      { kind: "block", statements: block.statements },
      ctx,
      locals,
      fn.returnType,
      block.expr,
    ),
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
  if (
    expr.kind === "call" &&
    (expr.tailRec || (expr.callee.kind === "var" && expr.callee.name === fn.name))
  ) {
    let callee: FnDecl | undefined;
    let runtimeArgs: Expr[];
    if (expr.tailRec) {
      callee = fn;
      runtimeArgs = expr.args;
    } else {
      callee = expr.callee.kind === "var" ? ctx.signatures.get(expr.callee.name) : undefined;
      runtimeArgs = expr.args.slice(
        Math.max(0, expr.args.length - (callee?.params.length ?? expr.args.length)),
      );
    }
    return [
      ...runtimeArgs.flatMap((arg, index) =>
        lowerExpr(arg, ctx, locals, callee?.params[index]?.type)
      ),
      { op: "return_call", name: fn.name },
    ];
  }
  if (expr.kind === "match") {
    return lowerTailOpcodeMatch(expr, fn, ctx, locals);
  }
  if (expr.kind === "pipe_bind") {
    let valueType = exprTypeWithLocals(expr.value, ctx);
    valueType ??= exprType(expr.value, ctx.functions);
    const bindings = flattenBinding(expr.name, valueType, ctx.layouts);
    const value = lowerExpr(expr.value, ctx, locals, valueType);
    for (const binding of bindings) locals.add(binding.name);
    const bodyCtx = ctxWithLocalType(ctx, expr.name, valueType);
    return [
      ...value,
      ...bindings.map((binding) => binding.name).toReversed().map((name): Instr => ({
        op: "local.set",
        name,
      })),
      ...lowerTailOpcodeExpr(expr.body, fn, bodyCtx, locals),
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
  if (expr.arms.some((arm) => arm.guard)) return lowerExpr(expr, ctx, locals, fn.returnType);
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
  const valueType = matchValueType(expr.value, ctx);
  return [
    ...lowerExpr(expr.value, ctx, locals),
    ...lowerPatternTest(arm.pattern, ctx, locals, valueType),
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
  block = foldScalarVarAliasesInTailBlock(block, ctx);
  const simple = simpleScalarTailLoop(block, fn, ctx);
  if (simple) {
    const hoisted = hoistSimpleTailLoopInvariants(simple, fn, ctx, locals);
    const continueArm = hoisted?.continueArm ?? simple.continueArm;
    const exitHint = branchHintForTestedArm(simple.exitArm, [continueArm]);
    const loopBody = [
      ...lowerExpr(hoisted?.condition ?? simple.condition, ctx, locals, "bool"),
      ...lowerPatternTest(continueArm.pattern, ctx, locals),
      { op: "binary", wasm: "i32.eqz" } as Instr,
      {
        op: "br_if",
        depth: 1,
        ...(exitHint ? { branchHint: exitHint } : {}),
      } as Instr,
      ...lowerTailLoopExpr(
        continueArm.value,
        fn,
        narrowedCtxForPattern(hoisted?.condition ?? simple.condition, continueArm.pattern, ctx),
        locals,
        0,
        1,
      ),
    ];
    const instrHoist = hoistInvariantLocalAdds(
      loopBody,
      invariantLocalNamesForSimpleTailLoop(simple, fn, ctx),
      ctx,
      locals,
    );
    return [
      ...(hoisted?.prefix ?? []),
      ...instrHoist.prefix,
      {
        op: "block",
        body: [{
          op: "loop",
          body: instrHoist.body,
        }],
      },
      { op: "local.get", name: simple.exitParam },
    ];
  }
  const statements: Instr[] = [];
  const paramUpdate = tailLoopParamUpdateSuffix(block, fn, ctx);
  const statementCount = paramUpdate?.prefixCount ?? block.statements.length;
  for (let index = 0; index < statementCount; index++) {
    const stmt = block.statements[index];
    const usedLater = usedNames({
      kind: "block",
      statements: block.statements.slice(index + 1, statementCount),
      ...(paramUpdate
        ? { expr: paramUpdate.usedLaterExpr }
        : block.expr
        ? { expr: block.expr }
        : {}),
    });
    const remaining: BlockExpr = {
      kind: "block",
      statements: block.statements.slice(index + 1, statementCount),
      ...(paramUpdate
        ? { expr: paramUpdate.usedLaterExpr }
        : block.expr
        ? { expr: block.expr }
        : {}),
    };
    statements.push(...lowerStatement(stmt, ctx, locals, usedLater, remaining));
  }
  const tail = paramUpdate
    ? lowerTailLoopParamUpdate(paramUpdate, fn, ctx, locals, 0, 1)
    : block.expr
    ? lowerTailLoopExpr(block.expr, fn, ctx, locals, 0, 1)
    : [];
  return [{
    op: "block",
    results: flattenType(fn.returnType, ctx.layouts).map((slot) => slot.wat),
    body: [{
      op: "loop",
      body: [
        ...statements,
        ...tail,
      ],
    }, { op: "unreachable" }],
  }];
}

function simpleScalarTailLoop(
  block: BlockExpr,
  fn: FnDecl,
  ctx: LowerContext,
): {
  condition: Expr;
  continueArm: MatchArm;
  exitArm: MatchArm;
  exitParam: string;
} | undefined {
  if (block.statements.length || !block.expr || block.expr.kind !== "match") return undefined;
  if (block.expr.arms.some((arm) => arm.guard)) return undefined;
  if (flattenType(fn.returnType, ctx.layouts).length !== 1) return undefined;
  const continueArm = block.expr.arms.find((arm) => isTrueLikePattern(arm.pattern));
  const exitArm = block.expr.arms.find((arm) => arm !== continueArm);
  if (!continueArm || !exitArm || block.expr.arms.length !== 2) return undefined;
  if (branchHintForTestedArm(continueArm, [exitArm])) return undefined;
  if (exitArm.value.kind !== "var") return undefined;
  const exitParam = exitArm.value.name;
  if (!fn.params.some((param) => param.name === exitParam)) return undefined;
  if (!exprHasDirectSelfCall(continueArm.value, fn.name)) return undefined;
  return {
    condition: block.expr.value,
    continueArm,
    exitArm,
    exitParam,
  };
}

function exprHasDirectSelfCall(expr: Expr, name: string): boolean {
  if (expr.kind === "call" && expr.tailRec) return true;
  if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === name) return true;
  return exprChildren(expr).some((child) => exprHasDirectSelfCall(child, name));
}

function invariantLocalNamesForSimpleTailLoop(
  simple: ReturnType<typeof simpleScalarTailLoop> & {},
  fn: FnDecl,
  ctx: LowerContext,
): Set<string> {
  const names = new Set<string>();
  if (!simple) return names;
  const selfCalls = directTailLoopStepCallExprs(simple.continueArm.value, fn.name);
  for (const [index, param] of fn.params.entries()) {
    if (
      selfCalls.length &&
      selfCalls.every((call) =>
        tailLoopArgIsIdentity(tailLoopCallArgs(call, fn)[index], param, ctx)
      )
    ) {
      names.add(param.name);
      for (const binding of flattenBinding(param.name, param.type, ctx.layouts)) {
        names.add(binding.name);
      }
    }
  }
  return names;
}

function hoistInvariantLocalAdds(
  body: Instr[],
  invariantNames: Set<string>,
  ctx: LowerContext,
  locals: Set<string>,
): { prefix: Instr[]; body: Instr[] } {
  if (!invariantNames.size) return { prefix: [], body };
  const hoists = new Map<string, string>();
  const prefix: Instr[] = [];
  const tempFor = (left: string, right: string): string => {
    const key = `${left}+${right}`;
    const existing = hoists.get(key);
    if (existing) return existing;
    const name = `__loop_inv${ctx.tempIndex++}`;
    hoists.set(key, name);
    locals.add(name);
    ctx.tempLocals.push({ name, type: "i32" });
    prefix.push(
      { op: "local.get", name: left },
      { op: "local.get", name: right },
      { op: "binary", wasm: "i32.add" },
      { op: "local.set", name },
    );
    return name;
  };
  const rewrite = (instrs: Instr[]): Instr[] => {
    const out: Instr[] = [];
    for (let index = 0; index < instrs.length; index++) {
      const a = instrs[index];
      const b = instrs[index + 1];
      const c = instrs[index + 2];
      if (
        a?.op === "local.get" &&
        b?.op === "local.get" &&
        c?.op === "binary" &&
        c.wasm === "i32.add" &&
        invariantNames.has(a.name) &&
        invariantNames.has(b.name)
      ) {
        out.push({ op: "local.get", name: tempFor(a.name, b.name) });
        index += 2;
        continue;
      }
      if (a?.op === "if") {
        out.push({
          ...a,
          thenBody: rewrite(a.thenBody),
          elseBody: rewrite(a.elseBody),
        });
        continue;
      }
      if (a?.op === "block" || a?.op === "loop") {
        out.push({ ...a, body: rewrite(a.body) });
        continue;
      }
      if (a) out.push(a);
    }
    return out;
  };
  return { prefix, body: rewrite(body) };
}

function hoistSimpleTailLoopInvariants(
  simple: ReturnType<typeof simpleScalarTailLoop> & {},
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
): { prefix: Instr[]; condition: Expr; continueArm: MatchArm } | undefined {
  if (!simple) return undefined;
  const selfCalls = directTailLoopStepCallExprs(simple.continueArm.value, fn.name);
  if (!selfCalls.length) return undefined;
  const invariantNames = new Set<string>();
  for (const [index, param] of fn.params.entries()) {
    if (
      selfCalls.every((call) =>
        tailLoopArgIsIdentity(tailLoopCallArgs(call, fn)[index], param, ctx)
      )
    ) {
      invariantNames.add(param.name);
      for (const binding of flattenBinding(param.name, param.type, ctx.layouts)) {
        invariantNames.add(binding.name);
      }
    }
  }
  if (!invariantNames.size) return undefined;

  const candidates = new Map<string, Expr>();
  const collect = (expr: Expr) => {
    for (const child of exprChildren(expr)) collect(child);
    const key = invariantScalarHoistKey(expr, invariantNames, ctx);
    if (key && !candidates.has(key)) candidates.set(key, expr);
  };
  collect(simple.condition);
  collect(simple.continueArm.value);
  const hoists = [...candidates.entries()].slice(0, 4).map(([key, expr]) => ({
    key,
    expr,
    name: `__loop_inv${ctx.tempIndex++}`,
  }));
  if (!hoists.length) return undefined;

  const replacements = new Map(hoists.map(({ key, name }) => [
    key,
    { kind: "var", name } as Expr,
  ]));
  for (const hoist of hoists) {
    locals.add(hoist.name);
    ctx.tempLocals.push({ name: hoist.name, type: "i32" });
  }
  return {
    prefix: hoists.flatMap(({ expr, name }) => [
      ...lowerExpr(expr, ctx, locals, "i32"),
      { op: "local.set", name } as Instr,
    ]),
    condition: replaceExprByHoistKey(simple.condition, replacements, invariantNames, ctx),
    continueArm: {
      ...simple.continueArm,
      value: replaceExprByHoistKey(simple.continueArm.value, replacements, invariantNames, ctx),
    },
  };
}

function invariantScalarHoistKey(
  expr: Expr,
  invariantNames: Set<string>,
  ctx: LowerContext,
): string | undefined {
  if (expr.kind !== "binary") return undefined;
  if (!["+", "-", "*", "&", "|", "^", "<<", ">>"].includes(expr.op)) return undefined;
  if (!isSpeculableNonTrappingExpr(expr, ctx.functions)) return undefined;
  const names = usedNames(expr);
  if (!names.size || [...names].some((name) => !invariantNames.has(name))) return undefined;
  return exprReuseKey(expr);
}

function replaceExprByHoistKey(
  expr: Expr,
  replacements: Map<string, Expr>,
  invariantNames: Set<string>,
  ctx: LowerContext,
): Expr {
  const key = invariantScalarHoistKey(expr, invariantNames, ctx);
  const replacement = key ? replacements.get(key) : undefined;
  if (replacement) return replacement;
  switch (expr.kind) {
    case "do":
      return expr.expr
        ? { ...expr, expr: replaceExprByHoistKey(expr.expr, replacements, invariantNames, ctx) }
        : expr;
    case "const_fn":
      return { ...expr, body: replaceExprByHoistKey(expr.body, replacements, invariantNames, ctx) };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => replaceExprByHoistKey(arg, replacements, invariantNames, ctx)),
        body: replaceExprByHoistKey(expr.body, replacements, invariantNames, ctx),
      };
    case "call":
      if (expr.tailRec) {
        return {
          ...expr,
          args: expr.args.map((arg) =>
            replaceExprByHoistKey(arg, replacements, invariantNames, ctx)
          ),
        };
      }
      return {
        ...expr,
        callee: replaceExprByHoistKey(expr.callee, replacements, invariantNames, ctx),
        args: expr.args.map((arg) => replaceExprByHoistKey(arg, replacements, invariantNames, ctx)),
      };
    case "index":
      return {
        ...expr,
        target: replaceExprByHoistKey(expr.target, replacements, invariantNames, ctx),
        index: replaceExprByHoistKey(expr.index, replacements, invariantNames, ctx),
      };
    case "binary":
      return {
        ...expr,
        left: replaceExprByHoistKey(expr.left, replacements, invariantNames, ctx),
        right: replaceExprByHoistKey(expr.right, replacements, invariantNames, ctx),
      };
    case "operator_chain":
      return {
        ...expr,
        first: replaceExprByHoistKey(expr.first, replacements, invariantNames, ctx),
        rest: expr.rest.map((item) => ({
          ...item,
          value: replaceExprByHoistKey(item.value, replacements, invariantNames, ctx),
        })),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: replaceExprByHoistKey(expr.value, replacements, invariantNames, ctx),
        body: replaceExprByHoistKey(expr.body, replacements, invariantNames, ctx),
      };
    case "match":
      return {
        ...expr,
        value: replaceExprByHoistKey(expr.value, replacements, invariantNames, ctx),
        arms: expr.arms.map((arm) => ({
          ...arm,
          guard: arm.guard
            ? replaceExprByHoistKey(arm.guard, replacements, invariantNames, ctx)
            : undefined,
          value: replaceExprByHoistKey(arm.value, replacements, invariantNames, ctx),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: replaceExprByHoistKey(slot.value, replacements, invariantNames, ctx),
        })),
      };
    case "range":
      return {
        ...expr,
        start: replaceExprByHoistKey(expr.start, replacements, invariantNames, ctx),
        end: replaceExprByHoistKey(expr.end, replacements, invariantNames, ctx),
      };
    case "static_for_slots":
      return {
        ...expr,
        value: replaceExprByHoistKey(expr.value, replacements, invariantNames, ctx),
      };
    case "field":
      return {
        ...expr,
        value: replaceExprByHoistKey(expr.value, replacements, invariantNames, ctx),
        key: replaceExprByHoistKey(expr.key, replacements, invariantNames, ctx),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) => {
          if (stmt.kind === "let" || stmt.kind === "destructure_let") {
            return {
              ...stmt,
              value: replaceExprByHoistKey(stmt.value, replacements, invariantNames, ctx),
            } as Statement;
          }
          return stmt;
        }),
        ...(expr.expr
          ? { expr: replaceExprByHoistKey(expr.expr, replacements, invariantNames, ctx) }
          : {}),
      };
    case "literal":
    case "var":
      return expr;
  }
}

function foldScalarVarAliasesInTailBlock(block: BlockExpr, ctx: LowerContext): BlockExpr {
  if (!block.statements.length) return block;
  const active = new Map<string, Expr>();
  const statements: Statement[] = [];
  for (const stmt of block.statements) {
    if (stmt.kind === "type_assert") {
      statements.push(stmt);
      continue;
    }
    if (stmt.kind === "debug_trace") {
      statements.push(stmt);
      continue;
    }
    const value = substituteExpr(stmt.value, active);
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    for (const name of bindings) active.delete(name);
    if (
      stmt.kind === "let" && value.kind === "var" &&
      flattenType(stmt.type ?? exprTypeWithLocals(value, ctx), ctx.layouts).length === 1
    ) {
      active.set(stmt.name, value);
      continue;
    }
    statements.push({ ...stmt, value });
  }
  return {
    ...block,
    statements,
    expr: block.expr ? substituteExpr(block.expr, active) : undefined,
  };
}

interface TailLoopParamUpdate {
  prefixCount: number;
  statements: Extract<Statement, { kind: "let" }>[];
  rewrittenExpr: Expr;
  usedLaterExpr: Expr;
}

function tailLoopParamUpdateSuffix(
  block: BlockExpr,
  fn: FnDecl,
  ctx: LowerContext,
): TailLoopParamUpdate | undefined {
  if (!block.expr || !fn.params.length || block.statements.length < fn.params.length) {
    return undefined;
  }
  const suffix = block.statements.slice(-fn.params.length);
  if (!suffix.every((stmt): stmt is Extract<Statement, { kind: "let" }> => stmt.kind === "let")) {
    return undefined;
  }
  const renames = new Map<string, string>();
  const suffixNames = new Set(suffix.map((stmt) => stmt.name));
  for (const [index, stmt] of suffix.entries()) {
    const param = fn.params[index];
    if (!param) return undefined;
    if (stmt.value.kind === "call") return undefined;
    if ([...usedNames(stmt.value)].some((name) => suffixNames.has(name))) return undefined;
    if (
      flattenType(stmt.type ?? exprTypeWithLocals(stmt.value, ctx), ctx.layouts).length !==
        flattenType(param.type, ctx.layouts).length
    ) return undefined;
    renames.set(stmt.name, param.name);
  }
  const exprNames = usedNames(block.expr);
  if ([...exprNames].some((name) => !suffixNames.has(name) && name !== fn.name)) {
    return undefined;
  }
  const rewrittenExpr = renameExpr(block.expr, renames);
  const usedLaterExpr: Expr = {
    kind: "block",
    statements: suffix,
    expr: block.expr,
  };
  return {
    prefixCount: block.statements.length - suffix.length,
    statements: suffix,
    rewrittenExpr,
    usedLaterExpr,
  };
}

function lowerTailLoopParamUpdate(
  update: TailLoopParamUpdate,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] {
  const fieldReuse = lowerTailLoopParamUpdateWithFieldReuse(update, fn, ctx, locals);
  if (fieldReuse) {
    return [
      ...fieldReuse,
      ...lowerTailLoopExpr(update.rewrittenExpr, fn, ctx, locals, continueDepth, exitDepth),
    ];
  }
  const activeUpdates = update.statements.flatMap((stmt, index) => {
    const param = fn.params[index];
    if (param && tailLoopParamUpdateIsIdentity(stmt, param, ctx)) return [];
    return [{ stmt, index }];
  });
  const immediateStores = lowerOrderedTailParamUpdateStores(activeUpdates, fn, ctx, locals);
  if (immediateStores) {
    return [
      ...immediateStores,
      ...lowerTailLoopExpr(update.rewrittenExpr, fn, ctx, locals, continueDepth, exitDepth),
    ];
  }
  const values = activeUpdates.flatMap(({ stmt, index }) => {
    const inlined = stmt.value.kind === "call"
      ? lowerPrivateProductCallInline(stmt.value, ctx, locals, {
        deadProductArgs: deadProductArgIndexes(stmt.value, ctx, update.usedLaterExpr),
      })
      : undefined;
    return inlined ?? lowerExpr(stmt.value, ctx, locals, fn.params[index]?.type);
  });
  const targets = activeUpdates.flatMap(({ index }) => {
    const param = fn.params[index];
    return param ? flattenBinding(param.name, param.type, ctx.layouts) : [];
  });
  return [
    ...values,
    ...targets.toReversed().map((target): Instr => ({ op: "local.set", name: target.name })),
    ...lowerTailLoopExpr(update.rewrittenExpr, fn, ctx, locals, continueDepth, exitDepth),
  ];
}

function lowerOrderedTailParamUpdateStores(
  activeUpdates: { stmt: Extract<Statement, { kind: "let" }>; index: number }[],
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (activeUpdates.length < 2) return undefined;
  if (activeUpdates.some(({ stmt }) => stmt.value.kind === "call")) return undefined;
  if (activeUpdates.some(({ stmt }) => hasRuntimeEffect(stmt.value, ctx.functions))) {
    return undefined;
  }
  const ordered = dependencyOrderedTailUpdates(
    activeUpdates.map(({ stmt, index }) => ({ expr: stmt.value, stmt, index })),
    fn,
    ctx,
  );
  if (!ordered) return undefined;
  return ordered.flatMap(({ stmt, index }) => {
    const param = fn.params[index];
    const targets = param ? flattenBinding(param.name, param.type, ctx.layouts) : [];
    if (!targets.length) return [];
    return [
      ...lowerExpr(stmt.value, ctx, locals, param?.type),
      ...targets.toReversed().map((target): Instr => ({ op: "local.set", name: target.name })),
    ];
  });
}

function tailLoopParamUpdateIsIdentity(
  stmt: Extract<Statement, { kind: "let" }>,
  param: Param,
  ctx: LowerContext,
): boolean {
  if (!tailLoopArgIsIdentity(stmt.value, param, ctx)) return false;
  const stmtSlots = flattenType(
    stmt.type ?? exprTypeWithLocals(stmt.value, ctx) ?? param.type,
    ctx.layouts,
  );
  const paramSlots = flattenType(param.type, ctx.layouts);
  return stmtSlots.length === paramSlots.length &&
    stmtSlots.every((slot, index) => slot.wat === paramSlots[index]?.wat);
}

function tailLoopArgIsIdentity(expr: Expr, param: Param, ctx: LowerContext): boolean {
  if (expr.kind !== "var" || !sameStorageName(expr.name, param.name)) return false;
  const exprSlots = flattenType(exprTypeWithLocals(expr, ctx) ?? param.type, ctx.layouts);
  const paramSlots = flattenType(param.type, ctx.layouts);
  return exprSlots.length === paramSlots.length &&
    exprSlots.every((slot, index) => slot.wat === paramSlots[index]?.wat);
}

function dropLoopVaryingParamFacts(
  facts: Map<string, ScalarFacts>,
  sourceFn: FnDecl,
  renamedFn: FnDecl,
  selfCalls: Extract<Expr, { kind: "call" }>[],
  ctx: LowerContext,
): void {
  if (!selfCalls.length) return;
  for (const [index, sourceParam] of sourceFn.params.entries()) {
    if (
      selfCalls.every((call) =>
        tailLoopArgIsIdentity(tailLoopCallArgs(call, sourceFn)[index], sourceParam, ctx)
      )
    ) {
      continue;
    }
    const renamedParam = renamedFn.params[index];
    if (!renamedParam) continue;
    facts.delete(renamedParam.name);
    for (const binding of flattenBinding(renamedParam.name, renamedParam.type, ctx.layouts)) {
      facts.delete(binding.name);
    }
  }
}

function lowerTailLoopParamUpdateWithFieldReuse(
  update: TailLoopParamUpdate,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const firstParam = fn.params[0];
  const firstStmt = update.statements[0];
  if (!firstParam || !firstStmt) return undefined;
  const product = firstStmt.value.kind === "shape" || firstStmt.value.kind === "product_constructor"
    ? firstStmt.value
    : undefined;
  if (!product || product.slots.some((slot) => slot.spread || slot.index || !slot.label)) {
    return undefined;
  }
  const fieldExprs = new Map(product.slots.map((slot) => [slot.label!, slot.value]));
  const reusable = update.statements.slice(1).some((stmt, index) => {
    const param = fn.params[index + 1];
    const field = param ? productFieldExprForParam(fieldExprs, param.name) : undefined;
    return Boolean(field && exprReuseKey(field) === exprReuseKey(stmt.value));
  });
  if (!reusable) return undefined;
  const firstTargets = flattenBinding(firstParam.name, firstParam.type, ctx.layouts);
  const body: Instr[] = [
    ...lowerExpr(firstStmt.value, ctx, locals, firstParam.type),
    ...firstTargets.toReversed().map((target): Instr => ({ op: "local.set", name: target.name })),
  ];
  for (const [index, stmt] of update.statements.slice(1).entries()) {
    const param = fn.params[index + 1];
    if (!param) return undefined;
    const fieldLabel = productFieldLabelForParam(fieldExprs, param.name);
    const field = fieldLabel ? fieldExprs.get(fieldLabel) : undefined;
    const targets = flattenBinding(param.name, param.type, ctx.layouts);
    const fieldTargets = flattenBinding(
      `${firstParam.name}$${fieldLabel ?? param.name}`,
      param.type,
      ctx.layouts,
    );
    if (field && exprReuseKey(field) === exprReuseKey(stmt.value) && targets.length === 1) {
      body.push({
        op: "local.get",
        name: fieldTargets[0]?.name ?? `${firstParam.name}$${param.name}`,
      });
    } else {
      body.push(...lowerExpr(stmt.value, ctx, locals, param.type));
    }
    body.push(
      ...targets.toReversed().map((target): Instr => ({ op: "local.set", name: target.name })),
    );
  }
  return body;
}

function productFieldExprForParam(
  fields: Map<string, Expr>,
  paramName: string,
): Expr | undefined {
  const label = productFieldLabelForParam(fields, paramName);
  return label ? fields.get(label) : undefined;
}

function productFieldLabelForParam(
  fields: Map<string, Expr>,
  paramName: string,
): string | undefined {
  if (fields.has(paramName)) return paramName;
  return [...fields.keys()].find((label) => paramName.endsWith(`_${label}`));
}

function exprReuseKey(expr: Expr): string | undefined {
  switch (expr.kind) {
    case "literal":
      return `lit:${expr.literalKind}:${expr.value}`;
    case "var":
      return `var:${expr.name}`;
    case "binary": {
      const left = exprReuseKey(expr.left);
      const right = exprReuseKey(expr.right);
      return left && right ? `bin:${expr.op}(${left},${right})` : undefined;
    }
    case "field": {
      const name = fieldAccessName(expr);
      return name ? `field:${name}` : undefined;
    }
    default:
      return undefined;
  }
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
  if (
    expr.kind === "call" &&
    (expr.tailRec || (expr.callee.kind === "var" && expr.callee.name === fn.name))
  ) {
    const transient = lowerTransientFixedArrayTailCall(expr, fn, ctx, locals, continueDepth);
    if (transient) return transient;
    let callee: FnDecl | undefined;
    let runtimeArgs: Expr[];
    if (expr.tailRec) {
      callee = fn;
      runtimeArgs = expr.args;
    } else {
      callee = expr.callee.kind === "var" ? ctx.signatures.get(expr.callee.name) : undefined;
      runtimeArgs = expr.args.slice(
        Math.max(0, expr.args.length - (callee?.params.length ?? expr.args.length)),
      );
    }
    if (
      runtimeArgs.length === fn.params.length &&
      runtimeArgs.every((arg, index) =>
        arg.kind === "var" && sameStorageName(arg.name, fn.params[index]?.name ?? "")
      )
    ) return [{ op: "br", depth: continueDepth }];
    const activeArgs = runtimeArgs.flatMap((arg, index) => {
      const param = fn.params[index];
      return param && tailLoopArgIsIdentity(arg, param, ctx) ? [] : [{ arg, index }];
    });
    const cse = tailCallArgCommonSubexprs(activeArgs.map(({ arg }) => arg), ctx, locals);
    const loweredArgs = cse
      ? activeArgs.map(({ arg, index }) => ({
        arg: replaceExprByReuseKey(arg, cse.replacements),
        index,
      }))
      : activeArgs;
    const flatParams = activeArgs.flatMap(({ index }) => {
      const param = fn.params[index];
      return param ? flattenBinding(param.name, param.type, ctx.layouts) : [];
    });
    const immediateStores = lowerOrderedTailCallParamStores(loweredArgs, fn, callee, ctx, locals);
    if (immediateStores) {
      return [
        ...(cse?.prefix ?? []),
        ...immediateStores,
        { op: "br", depth: continueDepth },
      ];
    }
    return [
      ...(cse?.prefix ?? []),
      ...loweredArgs.flatMap(({ arg, index }) =>
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
    let valueType = exprTypeWithLocals(expr.value, ctx);
    valueType ??= exprType(expr.value, ctx.functions);
    const bindings = flattenBinding(expr.name, valueType, ctx.layouts);
    const value = lowerExpr(expr.value, ctx, locals, valueType);
    for (const binding of bindings) locals.add(binding.name);
    let bodyCtx = ctxWithLocalType(ctx, expr.name, valueType);
    const fact = exprI32Facts(expr.value, ctx);
    if (fact && bindings.length === 1 && bindings[0]?.wat === "i32") {
      bodyCtx = ctxWithLocalScalarFact(bodyCtx, bindings[0].name, fact);
    }
    return [
      ...value,
      ...bindings.map((binding) => binding.name).toReversed().map((name): Instr => ({
        op: "local.set",
        name,
      })),
      ...lowerTailLoopExpr(expr.body, fn, bodyCtx, locals, continueDepth, exitDepth),
    ];
  }
  if (expr.kind === "block") {
    const statements: Instr[] = [];
    const paramUpdate = tailLoopParamUpdateSuffix(expr, fn, ctx);
    const statementCount = paramUpdate?.prefixCount ?? expr.statements.length;
    for (let index = 0; index < statementCount; index++) {
      const stmt = expr.statements[index];
      const usedLater = usedNames({
        kind: "block",
        statements: expr.statements.slice(index + 1, statementCount),
        ...(paramUpdate
          ? { expr: paramUpdate.usedLaterExpr }
          : expr.expr
          ? { expr: expr.expr }
          : {}),
      });
      const remaining: BlockExpr = {
        kind: "block",
        statements: expr.statements.slice(index + 1, statementCount),
        ...(paramUpdate
          ? { expr: paramUpdate.usedLaterExpr }
          : expr.expr
          ? { expr: expr.expr }
          : {}),
      };
      statements.push(...lowerStatement(stmt, ctx, locals, usedLater, remaining));
    }
    const tail = paramUpdate
      ? lowerTailLoopParamUpdate(paramUpdate, fn, ctx, locals, continueDepth, exitDepth)
      : expr.expr
      ? lowerTailLoopExpr(expr.expr, fn, ctx, locals, continueDepth, exitDepth)
      : [{ op: "br", depth: exitDepth } as Instr];
    return [...statements, ...tail];
  }
  return [
    ...(lowerBackedProductTailExit(expr, fn.returnType, ctx, locals) ??
      lowerExpr(expr, ctx, locals, fn.returnType)),
    { op: "br", depth: exitDepth },
  ];
}

function lowerOrderedTailCallParamStores(
  activeArgs: { arg: Expr; index: number }[],
  fn: FnDecl,
  callee: FnDecl | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (activeArgs.length < 2) return undefined;
  if (activeArgs.some(({ arg }) => hasRuntimeEffect(arg, ctx.functions))) return undefined;
  const ordered = dependencyOrderedTailUpdates(
    activeArgs.map(({ arg, index }) => ({ expr: arg, index })),
    fn,
    ctx,
  );
  if (!ordered) return undefined;
  return ordered.flatMap(({ expr, index }) => {
    const param = fn.params[index];
    const targets = param ? flattenBinding(param.name, param.type, ctx.layouts) : [];
    if (!targets.length) return [];
    return [
      ...lowerExpr(expr, ctx, locals, callee?.params[index]?.type),
      ...targets.toReversed().map((target): Instr => ({ op: "local.set", name: target.name })),
    ];
  });
}

function dependencyOrderedTailUpdates<T extends { expr: Expr; index: number }>(
  updates: T[],
  fn: FnDecl,
  ctx: LowerContext,
): T[] | undefined {
  const targetNamesByIndex = new Map<number, Set<string>>();
  for (const { index } of updates) {
    const param = fn.params[index];
    if (!param) return undefined;
    targetNamesByIndex.set(index, tailUpdateTargetNames(param, ctx));
  }
  const remaining = new Set(updates.map((_, index) => index));
  const ordered: T[] = [];
  while (remaining.size) {
    let selected: number | undefined;
    for (const itemIndex of remaining) {
      const item = updates[itemIndex];
      if (!item) continue;
      const itemTargets = targetNamesByIndex.get(item.index);
      if (!itemTargets) continue;
      let remainingUpdateNeedsOldTarget = false;
      for (const otherIndex of remaining) {
        if (otherIndex === itemIndex) continue;
        const other = updates[otherIndex];
        if (!other) continue;
        const otherNames = usedNames(other.expr);
        if ([...otherNames].some((name) => itemTargets.has(name))) {
          remainingUpdateNeedsOldTarget = true;
          break;
        }
      }
      if (!remainingUpdateNeedsOldTarget) {
        selected = itemIndex;
        break;
      }
    }
    if (selected === undefined) return undefined;
    remaining.delete(selected);
    const item = updates[selected];
    if (item) ordered.push(item);
  }
  return ordered;
}

function tailUpdateTargetNames(param: Param, ctx: LowerContext): Set<string> {
  const names = new Set<string>([param.name]);
  for (const binding of flattenBinding(param.name, param.type, ctx.layouts)) {
    names.add(binding.name);
    names.add(binding.name.replaceAll("$", "."));
  }
  return names;
}

function tailCallArgCommonSubexprs(
  args: Expr[],
  ctx: LowerContext,
  locals: Set<string>,
): { prefix: Instr[]; replacements: Map<string, Expr> } | undefined {
  const counts = new Map<string, { expr: Expr; count: number }>();
  const visit = (expr: Expr) => {
    for (const child of exprChildren(expr)) visit(child);
    if (expr.kind !== "binary" || expr.op !== "+") return;
    const key = exprReuseKey(expr);
    if (!key || !isSpeculableNonTrappingExpr(expr, ctx.functions)) return;
    if (flattenType(exprTypeWithLocals(expr, ctx) ?? "i32", ctx.layouts).length !== 1) return;
    const current = counts.get(key);
    counts.set(key, { expr, count: (current?.count ?? 0) + 1 });
  };
  for (const arg of args) visit(arg);
  const hoists = [...counts.entries()]
    .filter(([, item]) => item.count > 1 && backendInlineExprCost(item.expr) > 1)
    .slice(0, 2);
  if (!hoists.length) return undefined;
  const replacements = new Map<string, Expr>();
  const prefix: Instr[] = [];
  for (const [key, { expr }] of hoists) {
    const name = `__tail_cse${ctx.tempIndex++}`;
    locals.add(name);
    ctx.tempLocals.push({ name, type: "i32" });
    prefix.push(...lowerExpr(expr, ctx, locals, "i32"), { op: "local.set", name });
    replacements.set(key, { kind: "var", name });
  }
  return { prefix, replacements };
}

function replaceExprByReuseKey(expr: Expr, replacements: Map<string, Expr>): Expr {
  const key = exprReuseKey(expr);
  const replacement = key ? replacements.get(key) : undefined;
  if (replacement) return replacement;
  switch (expr.kind) {
    case "do":
      return expr.expr ? { ...expr, expr: replaceExprByReuseKey(expr.expr, replacements) } : expr;
    case "const_fn":
      return { ...expr, body: replaceExprByReuseKey(expr.body, replacements) };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => replaceExprByReuseKey(arg, replacements)),
        body: replaceExprByReuseKey(expr.body, replacements),
      };
    case "call":
      return {
        ...expr,
        callee: replaceExprByReuseKey(expr.callee, replacements),
        args: expr.args.map((arg) => replaceExprByReuseKey(arg, replacements)),
      };
    case "index":
      return {
        ...expr,
        target: replaceExprByReuseKey(expr.target, replacements),
        index: replaceExprByReuseKey(expr.index, replacements),
      };
    case "binary":
      return {
        ...expr,
        left: replaceExprByReuseKey(expr.left, replacements),
        right: replaceExprByReuseKey(expr.right, replacements),
      };
    case "operator_chain":
      return {
        ...expr,
        first: replaceExprByReuseKey(expr.first, replacements),
        rest: expr.rest.map((item) => ({
          ...item,
          value: replaceExprByReuseKey(item.value, replacements),
        })),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: replaceExprByReuseKey(expr.value, replacements),
        body: replaceExprByReuseKey(expr.body, replacements),
      };
    case "match":
      return {
        ...expr,
        value: replaceExprByReuseKey(expr.value, replacements),
        arms: expr.arms.map((arm) => ({
          ...arm,
          guard: arm.guard ? replaceExprByReuseKey(arm.guard, replacements) : undefined,
          value: replaceExprByReuseKey(arm.value, replacements),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: replaceExprByReuseKey(slot.value, replacements),
        })),
      };
    case "range":
      return {
        ...expr,
        start: replaceExprByReuseKey(expr.start, replacements),
        end: replaceExprByReuseKey(expr.end, replacements),
      };
    case "static_for_slots":
      return { ...expr, value: replaceExprByReuseKey(expr.value, replacements) };
    case "field":
      return {
        ...expr,
        value: replaceExprByReuseKey(expr.value, replacements),
        key: replaceExprByReuseKey(expr.key, replacements),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) => {
          if (stmt.kind === "let" || stmt.kind === "destructure_let") {
            return { ...stmt, value: replaceExprByReuseKey(stmt.value, replacements) } as Statement;
          }
          return stmt;
        }),
        ...(expr.expr ? { expr: replaceExprByReuseKey(expr.expr, replacements) } : {}),
      };
    case "literal":
    case "var":
      return expr;
  }
}

function lowerTransientFixedArrayTailCall(
  expr: Extract<Expr, { kind: "call" }>,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
): Instr[] | undefined {
  let callee: FnDecl | undefined;
  if (expr.tailRec) {
    callee = fn;
  } else {
    callee = ctx.signatures.get(expr.callee.kind === "var" ? expr.callee.name : "");
  }
  const runtimeArgs = tailLoopCallArgs(expr, callee ?? fn);
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
  if (firstArg.kind === "var" && sameStorageName(firstArg.name, firstParam.name)) {
    const remainingParams = fn.params.slice(1).flatMap((param) =>
      flattenBinding(param.name, param.type, ctx.layouts)
    );
    return [
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
  const packedTarget = packedPlanForName(targetParam.name, ctx.packedArrays);
  const packedPrefixShift = packedTarget
    ? lowerPackedPrefixShiftIntoPlan(expr, packedTarget, ctx, locals)
    : undefined;
  if (packedPrefixShift) return packedPrefixShift;
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
  const localScalarFacts = scalarFactsForFunctionParams(renamed, ctx, callee.name, renames);
  const selfCalls = directTailLoopStepCallExprs(callee.body, callee.name);
  callee.params.forEach((param, index) => {
    if (
      param.type === "i32" &&
      exprIsObviouslyNonNegative(runtimeArgs[index]) &&
      selfCalls.every((call) =>
        selfTailArgPreservesNonNegative(
          tailLoopCallArgs(call, callee)[index],
          param.name,
          tailParamGuardUpperBound(callee, param.name),
        )
      )
    ) {
      mergeLocalScalarFact(
        localScalarFacts,
        renames.get(param.name) ?? param.name,
        nonNegativeI32Fact(),
      );
    }
  });
  const inlineCtx: LowerContext = {
    ...ctx,
    currentFn: renamed,
    localTypes: new Map(renamed.params.map((param) => [param.name, param.type])),
    localScalarFacts,
    inlineStack: new Set([...(ctx.inlineStack ?? []), callee.name]),
    scratchArrays,
    packedArrays,
    localSlotArrays,
    fixedArrayTransformerAliases: new Map(),
    simdDotHelperName: ctx.simdDotHelperName ??
      (ctx.optMode === "release" && countDot4I32Exprs(renamed.body) > 1
        ? SIMD_DOT4_I32_HELPER
        : undefined),
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
    registerInlinedPackedArrayPlan(ctx, plan);
    const name = packedArrayLocalName(plan.name);
    if (!locals.has(name) && !ctx.tempLocals.some((item) => item.name === name)) {
      locals.add(name);
      ctx.tempLocals.push({ name, type: plan.packedType });
    }
  }

  let body = packedTarget
    ? lowerPackedPrefixShiftBlockIntoPlan(renamed.body, packedTarget, inlineCtx, locals)
    : undefined;
  if (!body) {
    for (const local of collectIrLocals(renamed.body, inlineCtx)) {
      if (locals.has(local.name) || ctx.tempLocals.some((item) => item.name === local.name)) {
        continue;
      }
      locals.add(local.name);
      ctx.tempLocals.push(local);
    }
    body = lowerBackedFixedArrayTailLoopBlock(
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
  }
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
  block = retargetBackedProductAliases(block, backedParam, ctx);
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

function retargetBackedProductAliases(
  block: BlockExpr,
  backedParam: Param,
  ctx: LowerContext,
): BlockExpr {
  if (flattenType(backedParam.type, ctx.layouts).length <= 1) return block;
  const aliases = new Map<string, Expr>();
  const statements: Statement[] = [];
  const substitute = (expr: Expr) => aliases.size ? substituteExpr(expr, aliases) : expr;
  for (let index = 0; index < block.statements.length; index++) {
    const stmt = block.statements[index]!;
    if (stmt.kind === "type_assert") {
      statements.push(stmt);
      continue;
    }
    if (stmt.kind === "debug_trace") {
      statements.push(stmt);
      continue;
    }
    const value = substitute(stmt.value);
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    for (const name of bindings) aliases.delete(name);
    if (stmt.kind === "let") {
      const statementType = stmt.type ?? exprTypeWithLocals(value, ctx);
      const remaining = substituteBlockExpr({
        kind: "block",
        statements: block.statements.slice(index + 1),
        ...(block.expr ? { expr: block.expr } : {}),
      }, aliases);
      const remainingUses = usedNames(remaining);
      if (
        statementType === backedParam.type &&
        value.kind === "call" &&
        !remainingUses.has(backedParam.name) &&
        remainingUses.has(stmt.name)
      ) {
        statements.push({ ...stmt, name: backedParam.name, type: backedParam.type, value });
        aliases.set(stmt.name, { kind: "var", name: backedParam.name });
        continue;
      }
    }
    statements.push({ ...stmt, value } as Statement);
  }
  return {
    ...block,
    statements,
    ...(block.expr ? { expr: substitute(block.expr) } : {}),
  };
}

function substituteBlockExpr(block: BlockExpr, substitutions: Map<string, Expr>): BlockExpr {
  return substituteExpr(block as Expr, substitutions) as BlockExpr;
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
    let valueType = exprTypeWithLocals(expr.value, ctx);
    valueType ??= exprType(expr.value, ctx.functions);
    const bindings = flattenBinding(expr.name, valueType, ctx.layouts);
    const value = lowerExpr(expr.value, ctx, locals, valueType);
    for (const binding of bindings) locals.add(binding.name);
    const bodyCtx = ctxWithLocalType(ctx, expr.name, valueType);
    const body = lowerBackedFixedArrayTailLoopExpr(
      expr.body,
      fn,
      backedParam,
      bodyCtx,
      locals,
      continueDepth,
      exitDepth,
    );
    if (!body) return undefined;
    return [
      ...value,
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
  if (expr.arms.some((arm) => arm.guard)) return undefined;
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
  const valueType = matchValueType(expr.value, ctx);
  return [
    ...lowerExpr(expr.value, ctx, locals),
    ...lowerPatternTest(arm.pattern, ctx, locals, valueType),
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
  const guard = lowerTailBooleanContinueGuard(expr, fn, ctx, locals, continueDepth, exitDepth);
  if (guard) return guard;
  const sum = lowerTailSumMatch(expr, fn, ctx, locals, continueDepth, exitDepth);
  if (sum) return sum;
  const [arm, ...rest] = expr.arms;
  if (!arm) return [{ op: "br", depth: exitDepth }];
  const guarded = lowerTailGuardedMatchArm(
    expr,
    arm,
    rest,
    fn,
    ctx,
    locals,
    continueDepth,
    exitDepth,
  );
  if (guarded) return guarded;
  if (isCatchAllPattern(arm.pattern) || rest.length === 0) {
    const ignored = hasRuntimeEffect(expr.value, ctx.functions)
      ? lowerIgnoredExpr(expr.value, ctx, locals)
      : [];
    return [
      ...ignored,
      ...lowerTailLoopExpr(arm.value, fn, ctx, locals, continueDepth, exitDepth),
    ];
  }
  const valueType = matchValueType(expr.value, ctx);
  return [
    ...lowerExpr(expr.value, ctx, locals),
    ...lowerPatternTest(arm.pattern, ctx, locals, valueType),
    {
      op: "if",
      results: [],
      thenBody: lowerTailLoopExpr(
        arm.value,
        fn,
        narrowedCtxForPattern(expr.value, arm.pattern, ctx),
        locals,
        continueDepth + 1,
        exitDepth + 1,
      ),
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

function lowerTailGuardedMatchArm(
  expr: Extract<Expr, { kind: "match" }>,
  arm: MatchArm,
  rest: MatchArm[],
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] | undefined {
  if (!arm.guard) return undefined;
  const scoped = new Set(locals);
  addPatternBindingLocals(arm.pattern, ctx, scoped);
  const bindingNames = patternBindingNames(arm.pattern);
  const valueType = matchValueType(expr.value, ctx);
  const bindings = bindingNames.length
    ? [
      ...lowerExpr(expr.value, ctx, locals),
      ...lowerPatternBindings(arm.pattern, ctx, scoped, valueType),
    ]
    : [];
  const ignored = bindings.length === 0 && hasRuntimeEffect(expr.value, ctx.functions)
    ? lowerIgnoredExpr(expr.value, ctx, locals)
    : [];
  const guardBranch = (depthOffset: number): Instr[] => [
    ...bindings,
    ...ignored,
    ...lowerExpr(
      arm.guard!,
      narrowedCtxForPattern(expr.value, arm.pattern, ctx),
      scoped,
      "bool",
    ),
    {
      op: "if",
      results: [],
      thenBody: lowerTailLoopExpr(
        arm.value,
        fn,
        narrowedCtxForPattern(expr.value, arm.pattern, ctx),
        scoped,
        continueDepth + depthOffset + 1,
        exitDepth + depthOffset + 1,
      ),
      elseBody: lowerTailLoopMatch(
        { ...expr, arms: rest },
        fn,
        ctx,
        locals,
        continueDepth + depthOffset + 1,
        exitDepth + depthOffset + 1,
      ),
      branchHint: branchHintForTestedArm(arm, rest),
    },
  ];
  if (isCatchAllPattern(arm.pattern)) return guardBranch(0);
  return [
    ...lowerExpr(expr.value, ctx, locals),
    ...lowerPatternTest(arm.pattern, ctx, locals, valueType),
    {
      op: "if",
      results: [],
      thenBody: guardBranch(1),
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

function lowerTailSumMatch(
  expr: Extract<Expr, { kind: "match" }>,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] | undefined {
  if (expr.arms.some((arm) => arm.guard)) return undefined;
  const valueType = exprTypeWithLocals(expr.value, ctx);
  const sum = sumLayoutForType(valueType, ctx.layouts);
  if (!sum) return undefined;
  const slots = flattenType(valueType, ctx.layouts);
  const temps = slots.map((slot) => {
    const name = `__tail_sum_tmp${ctx.tempIndex++}`;
    ctx.tempLocals.push({ name, type: slot.wat });
    locals.add(name);
    return name;
  });
  return [
    ...lowerExpr(expr.value, ctx, locals, valueType),
    ...temps.toReversed().map((name): Instr => ({ op: "local.set", name })),
    ...lowerTailSumMatchArms(
      sum,
      temps,
      expr.arms,
      fn,
      ctx,
      locals,
      continueDepth,
      exitDepth,
    ),
  ];
}

function lowerTailSumMatchArms(
  sum: SumLayout,
  temps: string[],
  arms: MatchArm[],
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] {
  const [arm, ...rest] = arms;
  if (!arm) return [{ op: "br", depth: exitDepth }];
  const variant = sumVariantForPattern(sum, arm.pattern);
  const scoped = new Set(locals);
  let bindings: Instr[];
  if (variant === undefined) {
    bindings = lowerWholeSumPatternBindings(sum, temps, arm.pattern, ctx, scoped);
  } else {
    bindings = lowerSumPatternBindings(sum, variant, temps, arm.pattern, ctx, scoped);
  }
  const armCtx = ctxWithPatternBindingTypes(ctx, arm.pattern, sum.type);
  const isCatchAllArm = variant === undefined;
  const isLastArm = rest.length === 0;
  if (isCatchAllArm || isLastArm) {
    return [
      ...bindings,
      ...lowerTailLoopExpr(arm.value, fn, armCtx, scoped, continueDepth, exitDepth),
    ];
  }
  return [
    { op: "local.get", name: temps[0] ?? "__tail_sum_tag_missing" },
    { op: "const", type: "i32", value: variant.tag },
    { op: "binary", wasm: "i32.eq" },
    {
      op: "if",
      results: [],
      thenBody: [
        ...bindings,
        ...lowerTailLoopExpr(
          arm.value,
          fn,
          armCtx,
          scoped,
          continueDepth + 1,
          exitDepth + 1,
        ),
      ],
      elseBody: lowerTailSumMatchArms(
        sum,
        temps,
        rest,
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

function lowerTailBooleanContinueGuard(
  expr: Extract<Expr, { kind: "match" }>,
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] | undefined {
  if (expr.arms.some((arm) => arm.guard)) return undefined;
  if (expr.arms.length !== 2) return undefined;
  const [first, second] = expr.arms;
  if (!first || !second) return undefined;
  if (!isTrueLikePattern(first.pattern) && !isFalseLikePattern(first.pattern)) return undefined;
  if (
    !isCatchAllPattern(second.pattern) &&
    !isTrueLikePattern(second.pattern) &&
    !isFalseLikePattern(second.pattern)
  ) return undefined;
  const firstContinues = identitySelfTailCall(first.value, fn, ctx);
  const secondContinues = identitySelfTailCall(second.value, fn, ctx);
  if (firstContinues === secondContinues) return undefined;
  const continueOnFirst = firstContinues;
  const continueArm = continueOnFirst ? first : second;
  const exitArm = continueOnFirst ? second : first;
  if (!isTrueLikePattern(continueArm.pattern) && !isFalseLikePattern(continueArm.pattern)) {
    return undefined;
  }
  return [
    ...lowerExpr(expr.value, ctx, locals, "bool"),
    ...lowerPatternTest(continueArm.pattern, ctx, locals),
    { op: "br_if", depth: continueDepth },
    ...lowerTailLoopExpr(
      exitArm.value,
      fn,
      narrowedCtxForPattern(expr.value, exitArm.pattern, ctx),
      locals,
      continueDepth,
      exitDepth,
    ),
  ];
}

function identitySelfTailCall(expr: Expr, fn: FnDecl, ctx: LowerContext): boolean {
  if (expr.kind !== "call" || expr.callee.kind !== "var" || expr.callee.name !== fn.name) {
    return false;
  }
  const argOffset = Math.max(0, expr.args.length - fn.params.length);
  const runtimeArgs = expr.args.slice(argOffset);
  return runtimeArgs.length === fn.params.length &&
    runtimeArgs.every((arg, index) => tailLoopArgIsIdentity(arg, fn.params[index]!, ctx));
}

function lowerTailStepMatch(
  value: Expr,
  arms: MatchArm[],
  fn: FnDecl,
  ctx: LowerContext,
  locals: Set<string>,
  continueDepth: number,
  exitDepth: number,
): Instr[] | undefined {
  if (arms.some((arm) => arm.guard)) return undefined;
  if (value.kind !== "call" || value.callee.kind !== "var") return undefined;
  const id = compilerCallId(value.callee.name, ctx.intrinsicIdsByName);
  if (id !== "index_cursor_next" && !isIndexCursorNextCallee(value.callee.name)) return undefined;
  const n = value.args.length >= 2
    ? value.args[value.args.length - 2]
    : constSpecializedCursorBound(value.callee.name, ctx.layouts);
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
  let yieldCtx = ctx;
  if (itemName) {
    scoped.add(itemName);
    ctx.tempLocals.push({ name: itemName, type: "i32" });
    const fact = indexFactForBoundExpr(n);
    if (fact) yieldCtx = ctxWithLocalScalarFact(yieldCtx, itemName, fact);
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
        ...lowerTailLoopExpr(
          yieldArm.value,
          fn,
          yieldCtx,
          scoped,
          continueDepth + 1,
          exitDepth + 1,
        ),
      ],
      elseBody: lowerTailLoopExpr(doneArm.value, fn, ctx, locals, continueDepth + 1, exitDepth + 1),
      branchHint: branchHintForStepArms(yieldArm, doneArm),
    },
  ];
}

function isIndexCursorNextCallee(name: string): boolean {
  return name.endsWith("IndexCursor.next") || name.endsWith("IndexCursor::next") ||
    name.includes("index_cursor_next__") || name.includes("IndexCursor_next__") ||
    name.includes("IndexCursor__next__");
}

function constSpecializedCursorBound(name: string, layouts: LayoutEnv): Expr | undefined {
  const match = name.match(
    /(?:index_cursor_next|IndexCursor_next|IndexCursor__next)__([A-Za-z0-9_]+)/,
  );
  const value = match?.[1];
  if (!value) return undefined;
  if (/^[0-9]+$/.test(value)) return { kind: "literal", literalKind: "number", value };
  const constNumber = layouts.constNumbers.get(value);
  return constNumber === undefined
    ? undefined
    : { kind: "literal", literalKind: "number", value: String(constNumber) };
}

function indexFactForBoundExpr(bound: Expr): ScalarFacts | undefined {
  const capacity = staticIntegerLiteral(bound);
  return capacity !== undefined && capacity > 0
    ? scalarFactsFromI32Range({ min: 0, max: capacity - 1 })
    : undefined;
}

function lowerExpr(
  expr: Expr,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  const folded = constFold(expr, ctx);
  if (folded !== expr) return lowerExpr(folded, ctx, locals, expectedType);
  const implicitSumPayload = lowerImplicitSumPayload(expr, expectedType, ctx, locals);
  if (implicitSumPayload) return implicitSumPayload;
  switch (expr.kind) {
    case "operator_chain":
      throw new Error("backend cannot lower unresolved operator chain");
    case "do":
      throw new Error("backend cannot lower do expression before desugaring");
    case "literal":
      return lowerLiteral(expr, ctx, expectedType);
    case "var": {
      const deferred = ctx.fixedArrayTransformerAliases?.get(expr.name);
      if (deferred) return lowerExpr(deferred, ctx, locals, expectedType);
      const constNumber = ctx.layouts.constNumbers.get(expr.name);
      if (constNumber !== undefined) {
        return [{ op: "const", type: "i32", value: constNumber }];
      }
      const sumVariant = lowerSumVariantValue(expr.name, [], expectedType, ctx, locals);
      if (sumVariant) return sumVariant;
      return lowerVar(expr.name, ctx, locals, expectedType);
    }
    case "const_fn":
      return flattenType(expectedType, ctx.layouts).map((slot): Instr => ({
        op: "const",
        type: slot.wat,
        value: 0,
      }));
    case "profile":
      return lowerProfileExpr(expr, ctx, locals, expectedType);
    case "call": {
      if (expr.tailRec) {
        throw new Error("backend cannot lower rec(...) outside a tail-recursive function body");
      }
      const closureMake = lowerClosureMake(expr, ctx, locals);
      if (closureMake) return closureMake;
      const closureCall = lowerClosureCall(expr, ctx, locals);
      if (closureCall) return closureCall;
      if (expr.callee.kind !== "var") {
        if (expr.args.length === 0) return lowerExpr(expr.callee, ctx, locals, expectedType);
        throw new Error("backend only supports direct calls");
      }
      if (expr.callee.name === "@empty") {
        const emptyType = expectedType ??
          (expr.args[0] ? renderBackendTypeProofArg(expr.args[0]) : undefined);
        const explicitEmpty = emptyType ? ctx.functions.get(`${emptyType}::empty`) : undefined;
        if (explicitEmpty && explicitEmpty.name !== ctx.currentFn?.name) {
          return lowerExpr(
            {
              kind: "call",
              callee: { kind: "var", name: explicitEmpty.name },
              args: [],
            },
            ctx,
            locals,
            expectedType,
          );
        }
        return flattenType(emptyType, ctx.layouts).map((slot): Instr => ({
          op: "const",
          type: slot.wat,
          value: 0,
        }));
      }
      if (expr.callee.name === "return" && expr.args.length === 1) {
        return lowerExpr(expr.args[0]!, ctx, locals, ioActionItemType(expectedType));
      }
      const sumVariant = lowerSumVariantValue(
        expr.callee.name,
        expr.args,
        expectedType,
        ctx,
        locals,
      );
      if (sumVariant) return sumVariant;
      if (expr.callee.name === "@replace_field") {
        const replaced = lowerReplaceFieldCall(expr, ctx, locals, expectedType);
        if (replaced) return replaced;
      }
      const heapArray = lowerHeapArrayIntrinsic(expr, ctx, locals, expectedType);
      if (heapArray) return heapArray;
      const branch = lowerBranchIntrinsic(expr, ctx, locals);
      if (branch) return branch;
      const primitiveScalar = lowerPrimitiveScalarIntrinsic(expr, ctx, locals);
      if (primitiveScalar) return primitiveScalar;
      const packedPrefixShift = lowerPackedPrefixShiftCall(expr, ctx, locals, expectedType);
      if (packedPrefixShift) return packedPrefixShift;
      const inlineArrayHelper = lowerInlineArrayHelperCall(expr, ctx, locals, expectedType);
      if (inlineArrayHelper) return inlineArrayHelper;
      const builder = lowerInlineArrayBuilderPrimitive(expr, ctx, locals, expectedType);
      if (builder) return builder;
      const inlined = lowerPrivateProductCallInline(expr, ctx, locals, {
        deadProductArgs: contextDeadProductArgIndexes(expr, ctx),
        expectedType,
      });
      if (inlined) return inlined;
      const scalarTailLoopInlined = lowerPrivateScalarTailLoopCallInline(
        expr,
        ctx,
        locals,
        expectedType,
      );
      if (scalarTailLoopInlined) return scalarTailLoopInlined;
      const scalarInlined = lowerPrivateScalarCallInline(expr, ctx, locals, expectedType);
      if (scalarInlined) return scalarInlined;
      const calleeName = ctx.layouts.constFunctionFields.get(expr.callee.name) ?? expr.callee.name;
      const callee = ctx.signatures.get(calleeName);
      if (!callee) {
        if (!hasRuntimeEffect(expr, ctx.functions)) {
          const fallbackSlots = flattenType(expectedType, ctx.layouts);
          return (fallbackSlots.length ? fallbackSlots : [{ wat: "i32" as const }]).map((
            slot,
          ): Instr => ({
            op: "const",
            type: slot.wat,
            value: 0,
          }));
        }
        throw new Error(`backend missing runtime callable value: ${expr.callee.name}`);
      }
      const trailingConstArgs = Math.max(0, expr.args.length - callee.params.length);
      const generatedConstFnCall = callee.generated && callee.name.startsWith("__const_fn");
      const skipTrailingConstArgs = trailingConstArgs > 0 &&
        (generatedConstFnCall ||
          expr.args.slice(callee.params.length).every((arg) =>
            arg.kind === "var" && ctx.functions.has(arg.name)
          ));
      const argOffset = skipTrailingConstArgs ? 0 : trailingConstArgs;
      const callArgs = skipTrailingConstArgs ? expr.args.slice(0, callee.params.length) : expr.args;
      const loweredCall: Instr[] = [
        ...callArgs.flatMap((arg, index) =>
          index < argOffset
            ? []
            : lowerExpr(arg, ctx, locals, callee.params[index - argOffset]?.type)
        ),
        { op: "call", name: calleeName },
      ];
      const projected = lowerProjectedCallResult(
        loweredCall,
        callee.returnType,
        expectedType,
        ctx,
        locals,
      );
      return projected ?? loweredCall;
    }
    case "index":
      return lowerIndex(expr, ctx, locals, expectedType);
    case "binary":
      {
        const factComparison = lowerI32FactComparison(expr, ctx);
        if (factComparison) return factComparison;
        const dot = lowerDot4I32(expr, ctx, locals);
        if (dot) return dot;
        const parity = lowerParityRemainderComparison(expr, ctx, locals);
        if (parity) return parity;
        const smallRangeDivisibility = lowerSmallRangeDivisibilityComparison(expr, ctx, locals);
        if (smallRangeDivisibility) return smallRangeDivisibility;
        const divisibility = lowerOddDivisibilityComparison(expr, ctx, locals);
        if (divisibility) return divisibility;
        const zeroComparison = lowerZeroComparison(expr, ctx, locals);
        if (zeroComparison) return zeroComparison;
        const powerOfTwoMul = lowerPowerOfTwoMultiply(expr, ctx, locals);
        if (powerOfTwoMul) return powerOfTwoMul;
        const constDivRem = lowerNonNegativeConstDivRem(expr, ctx, locals);
        if (constDivRem) return constDivRem;
        const powerOfTwoDivRem = lowerPowerOfTwoDivRem(expr, ctx, locals);
        if (powerOfTwoDivRem) return powerOfTwoDivRem;
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
        const foldedValue = constFold(expr.value, ctx);
        if (foldedValue.kind === "literal" && !expr.arms.some((arm) => arm.guard)) {
          const selected = expr.arms.find((arm) => patternMatchesLiteral(arm.pattern, foldedValue));
          if (selected) {
            const scoped = new Set(locals);
            addPatternBindingLocals(selected.pattern, ctx, scoped);
            const selectedCtx = ctxWithPatternBindingTypes(
              ctx,
              selected.pattern,
              matchValueType(foldedValue, ctx),
            );
            const bindings = patternBindingNames(selected.pattern).length
              ? [
                ...lowerExpr(foldedValue, ctx, locals),
                ...lowerPatternBindings(
                  selected.pattern,
                  ctx,
                  scoped,
                  matchValueType(foldedValue, ctx),
                ),
              ]
              : [];
            return [
              ...bindings,
              ...lowerExpr(selected.value, selectedCtx, scoped, expectedType),
            ];
          }
        }
        const refinedTry = lowerRefinedDomainTryMatch(
          expr.value,
          expr.arms,
          ctx,
          locals,
          expectedType,
        );
        if (refinedTry) return refinedTry;
        const step = lowerStepMatch(expr.value, expr.arms, ctx, locals, expectedType);
        if (step) return step;
        const shared = lowerMatchSharedScalarSubexprs(expr, ctx, locals, expectedType);
        if (shared) return shared;
        const materialized = lowerMaterializedMatch(expr, ctx, locals, expectedType);
        if (materialized) return materialized;
        const sum = lowerSumMatch(expr.value, expr.arms, ctx, locals, expectedType);
        if (sum) return sum;
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
      {
        const sum = lowerSumConstructor(expr, expectedType, ctx, locals);
        if (sum) return sum;
      }
      if (expr.slots.length === 0) return [{ op: "const", type: "i32", value: 0 }];
      return lowerShapeStorage(
        expr.slots,
        expectedType ?? constructorResultType(expr.constructor, expectedType, ctx.layouts),
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
      {
        const keyExpr = constFold(expr.key, ctx);
        if (expr.value.kind === "var" && keyExpr.kind === "literal") {
          const key = keyExpr.value.replace(/^#/, "").replace(/^"|"$/g, "");
          return lowerVar(`${expr.value.name}.${key}`, ctx, locals, expectedType);
        }
        if (keyExpr.kind === "literal") {
          const key = keyExpr.value.replace(/^#/, "").replace(/^"|"$/g, "");
          const actualType = exprTypeWithLocals(expr.value, ctx) ??
            (expr.value.kind === "index" ? indexedItemType(expr.value, ctx) : undefined);
          const actualSlots = flattenType(actualType, ctx.layouts);
          const indexes = actualSlots
            .map((slot, index) => ({ slot, index }))
            .filter(({ slot }) => slot.suffix === key || slot.suffix.startsWith(`${key}$`))
            .map(({ index }) => index);
          if (!indexes.length && actualType?.trim().startsWith(`{${key}:`)) {
            return lowerFlattenedSlotsViaTemps(
              lowerExpr(expr.value, ctx, locals, actualType),
              actualSlots,
              actualSlots.map((_, index) => index),
              ctx,
              locals,
            );
          }
          if (indexes.length > 0) {
            return lowerFlattenedSlotsViaTemps(
              lowerExpr(expr.value, ctx, locals, actualType),
              actualSlots,
              indexes,
              ctx,
              locals,
            );
          }
        }
      }
      if (expr.value.kind === "var" && expr.key.kind === "literal") {
        const key = expr.key.value.replace(/^#/, "").replace(/^"|"$/g, "");
        return lowerVar(`${expr.value.name}.${key}`, ctx, locals, expectedType);
      }
      if (expr.key.kind === "literal") {
        const key = expr.key.value.replace(/^#/, "").replace(/^"|"$/g, "");
        const actualType = exprTypeWithLocals(expr.value, ctx) ??
          (expr.value.kind === "index" ? indexedItemType(expr.value, ctx) : undefined);
        const actualSlots = flattenType(actualType, ctx.layouts);
        const indexes = actualSlots
          .map((slot, index) => ({ slot, index }))
          .filter(({ slot }) => slot.suffix === key || slot.suffix.startsWith(`${key}$`))
          .map(({ index }) => index);
        if (!indexes.length && actualType?.trim().startsWith(`{${key}:`)) {
          return lowerFlattenedSlotsViaTemps(
            lowerExpr(expr.value, ctx, locals, actualType),
            actualSlots,
            actualSlots.map((_, index) => index),
            ctx,
            locals,
          );
        }
        if (indexes.length > 0) {
          return lowerFlattenedSlotsViaTemps(
            lowerExpr(expr.value, ctx, locals, actualType),
            actualSlots,
            indexes,
            ctx,
            locals,
          );
        }
      }
      if (expectedType) {
        const actualType = exprTypeWithLocals(expr.value, ctx) ??
          (expr.value.kind === "index" ? indexedItemType(expr.value, ctx) : undefined);
        const indexes = uniqueProductFieldIndexesByType(actualType, expectedType, ctx.layouts);
        if (indexes) {
          if (actualType?.includes(")(")) return lowerExpr(expr.value, ctx, locals, expectedType);
          return lowerFlattenedSlotsViaTemps(
            lowerExpr(expr.value, ctx, locals, actualType),
            flattenType(actualType, ctx.layouts),
            indexes,
            ctx,
            locals,
          );
        }
      }
      if (expr.value.kind === "var" && expectedType) {
        const actualType = exprTypeWithLocals(expr.value, ctx);
        const candidateSlots = (productSlotsForType(actualType, ctx.layouts) ?? [])
          .filter((slot) => slot.label);
        const exactSlots = candidateSlots.filter((slot) =>
          compactTypeSource(slot.type) === compactTypeSource(expectedType)
        );
        const matchingSlots = exactSlots.length > 0
          ? exactSlots
          : candidateSlots.filter((slot) =>
            flattenedTypesMatch(slot.type, expectedType, ctx.layouts)
          );
        if (matchingSlots.length === 1 && matchingSlots[0]?.label) {
          return lowerVar(
            `${expr.value.name}.${matchingSlots[0].label}`,
            ctx,
            locals,
            expectedType,
          );
        }
        const prefix = `${expr.value.name}$`;
        const labels = new Set(
          [...locals].flatMap((local) => {
            if (!local.startsWith(prefix)) return [];
            const rest = local.slice(prefix.length);
            const label = rest.split("$")[0];
            return label ? [label] : [];
          }),
        );
        if (labels.size === 1) {
          const [label] = [...labels];
          return lowerVar(`${expr.value.name}.${label}`, ctx, locals, expectedType);
        }
      }
      throw new Error(
        `backend cannot lower unresolved @field in ${ctx.currentFn?.name ?? "<unknown>"}${
          expectedType ? ` expected ${expectedType}` : ""
        }`,
      );
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
  const test: Instr[] = [
    ...lowerExpr(pattern.dividend, ctx, locals, "i32"),
    { op: "const", type: "i32", value: 1 },
    { op: "binary", wasm: "i32.and" },
  ];
  return expr.op === "!=" ? test : [...test, { op: "binary", wasm: "i32.eqz" }];
}

function uniqueProductFieldIndexesByType(
  actualType: string | undefined,
  expectedType: string,
  layouts: LayoutEnv,
): number[] | undefined {
  const slots = productSlotsForType(actualType, layouts);
  if (!slots) return undefined;
  let offset = 0;
  const matches: number[][] = [];
  for (const slot of slots) {
    const flat = flattenType(slot.type, layouts);
    const count = flat.length * (slot.repeat ? Number.parseInt(slot.repeat, 10) : 1);
    if (
      compactTypeSource(slot.type) === compactTypeSource(expectedType) ||
      flattenedTypesMatch(slot.type, expectedType, layouts)
    ) {
      matches.push(Array.from({ length: count }, (_, index) => offset + index));
    }
    offset += count;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function lowerReplaceFieldCall(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType: string | undefined,
): Instr[] | undefined {
  if (expr.args.length !== 3) return undefined;
  const [source, key, value] = expr.args;
  if (!source || !key || !value) return undefined;
  const foldedKey = constFold(key, ctx);
  const label = foldedKey.kind === "literal" && foldedKey.literalKind === "literalType"
    ? foldedKey.value.replace(/^#/, "")
    : foldedKey.kind === "literal" && foldedKey.literalKind === "string"
    ? foldedKey.value.replace(/^"|"$/g, "")
    : undefined;
  if (!label) return undefined;
  const sourceType = exprTypeWithLocals(source, ctx);
  const productType = expectedType ?? sourceType;
  const slots = productSlotsForType(productType, ctx.layouts);
  if (!slots?.some((slot) => slot.label === label)) return undefined;
  return slots.flatMap((slot) => {
    if (!slot.label) return [];
    const slotType = slot.label === label
      ? exprTypeWithLocals(
        {
          kind: "field",
          value: source,
          key: { kind: "literal", literalKind: "literalType", value: `#${slot.label}` },
        },
        ctx,
      ) ?? slot.type
      : slot.type;
    if (slot.label === label) return lowerExpr(value, ctx, locals, slotType);
    return lowerExpr(
      {
        kind: "field",
        value: source,
        key: { kind: "literal", literalKind: "literalType", value: `#${slot.label}` },
      },
      ctx,
      locals,
      slotType,
    );
  });
}

function lowerEcsSpawnComponentsCall(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType: string | undefined,
): Instr[] | undefined {
  if (expr.args.length !== 5) return undefined;
  const [fieldsArg, capacityArg, world, entity, entityValues] = expr.args;
  if (!fieldsArg || !capacityArg || !world || !entity || !entityValues) return undefined;
  const rowType = fieldsArg.kind === "call" && fieldsArg.callee.kind === "var" &&
      fieldsArg.callee.name === "@type_slots"
    ? renderBackendTypeProofArg(fieldsArg.args[0]!)
    : undefined;
  const rowSlots = productSlotsForType(rowType, ctx.layouts);
  const productType = resolveAlias(expectedType, ctx.layouts) ?? exprTypeWithLocals(world, ctx);
  const worldSlots = productSlotsForType(productType, ctx.layouts);
  if (!rowSlots || !worldSlots) return undefined;
  const rowByLabel = new Map(rowSlots.flatMap((slot) => slot.label ? [[slot.label, slot]] : []));
  const replacedWorld = world.kind === "call" && world.callee.kind === "var" &&
      world.callee.name === "@replace_field"
    ? {
      source: world.args[0],
      label: world.args[1]?.kind === "literal" && world.args[1].literalKind === "literalType"
        ? world.args[1].value.replace(/^#/, "")
        : undefined,
      value: world.args[2],
    }
    : undefined;
  return worldSlots.flatMap((slot) => {
    if (!slot.label) return [];
    const rowSlot = rowByLabel.get(slot.label);
    if (!rowSlot) {
      if (replacedWorld?.label === slot.label && replacedWorld.value) {
        return lowerExpr(replacedWorld.value, ctx, locals, slot.type);
      }
      const fieldSource = replacedWorld?.source ?? world;
      if (!fieldSource) return [];
      return lowerExpr(
        {
          kind: "field",
          value: fieldSource,
          key: { kind: "literal", literalKind: "literalType", value: `#${slot.label}` },
        },
        ctx,
        locals,
        slot.type,
      );
    }
    const arrayArgs = inlineArrayLikeTypeArgs(slot.type, ctx.layouts);
    if (!arrayArgs) return [];
    const [capacity, itemType] = arrayArgs;
    const itemSlots = flattenType(itemType, ctx.layouts);
    return Array.from(
      { length: capacity },
      (_, item) =>
        itemSlots.map((itemSlot, slotIndex): Instr[] => [
          ...lowerExpr(entity, ctx, locals, "i32"),
          { op: "const", type: "i32", value: item },
          { op: "binary", wasm: "i32.eq" },
          {
            op: "if",
            results: [itemSlot.wat],
            thenBody: lowerFlattenedValueSlot(
              {
                kind: "field",
                value: entityValues,
                key: { kind: "literal", literalKind: "literalType", value: `#${slot.label}` },
              },
              itemType,
              slotIndex,
              ctx,
              locals,
            ),
            elseBody: lowerFlattenedValueSlot(
              {
                kind: "var",
                name: `${
                  (replacedWorld?.source ?? world).kind === "var"
                    ? ((replacedWorld?.source ?? world) as Extract<Expr, { kind: "var" }>).name
                    : "world"
                }.${slot.label}[${item}]`,
              },
              itemType,
              slotIndex,
              ctx,
              locals,
            ),
          },
        ]).flat(),
    ).flat();
  });
}

function lowerOddDivisibilityComparison(
  expr: Extract<Expr, { kind: "binary" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.op !== "==" && expr.op !== "!=") return undefined;
  const pattern = oddDivisibilityPattern(expr.left, expr.right, ctx) ??
    oddDivisibilityPattern(expr.right, expr.left, ctx);
  if (!pattern) return undefined;
  return [
    ...lowerExpr(pattern.dividend, ctx, locals, "i32"),
    { op: "const", type: "i32", value: signedI32Const(pattern.inverse) },
    { op: "binary", wasm: "i32.mul" },
    { op: "const", type: "i32", value: pattern.threshold },
    { op: "binary", wasm: "i32.le_u" },
    ...(expr.op === "!=" ? [{ op: "binary", wasm: "i32.eqz" } as Instr] : []),
  ];
}

function lowerSmallRangeDivisibilityComparison(
  expr: Extract<Expr, { kind: "binary" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.op !== "==" && expr.op !== "!=") return undefined;
  const pattern = smallRangeDivisibilityPattern(expr.left, expr.right, ctx) ??
    smallRangeDivisibilityPattern(expr.right, expr.left, ctx);
  if (!pattern) return undefined;
  const mask = expr.op === "!=" ? ~pattern.mask : pattern.mask;
  return [
    { op: "const", type: "i32", value: signedI32Const(mask) },
    ...lowerExpr(pattern.dividend, ctx, locals, "i32"),
    { op: "binary", wasm: "i32.shr_u" },
    { op: "const", type: "i32", value: 1 },
    { op: "binary", wasm: "i32.and" },
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

function smallRangeDivisibilityPattern(
  remainder: Expr,
  zero: Expr,
  ctx: LowerContext,
): { dividend: Expr; mask: number } | undefined {
  if (staticIntegerLiteral(zero) !== 0) return undefined;
  if (remainder.kind !== "binary" || remainder.op !== "%") return undefined;
  const divisor = staticIntegerLiteral(remainder.right);
  if (divisor === undefined || divisor <= 1) return undefined;
  if (watType(exprTypeWithLocals(remainder.left, ctx)) !== "i32") return undefined;
  const range = exprI32Range(remainder.left, ctx);
  if (!range || range.min < 0 || range.max >= 32) return undefined;
  let mask = 0;
  for (let value = 0; value <= range.max; value += divisor) {
    if (value >= range.min) mask += 2 ** value;
  }
  return mask === 0 ? undefined : { dividend: remainder.left, mask };
}

function oddDivisibilityPattern(
  remainder: Expr,
  zero: Expr,
  ctx: LowerContext,
): { dividend: Expr; inverse: number; threshold: number } | undefined {
  if (staticIntegerLiteral(zero) !== 0) return undefined;
  if (remainder.kind !== "binary" || remainder.op !== "%") return undefined;
  const divisor = staticIntegerLiteral(remainder.right);
  if (
    divisor === undefined ||
    divisor <= 1 ||
    divisor > I32_MAX ||
    (divisor & 1) === 0
  ) {
    return undefined;
  }
  if (watType(exprTypeWithLocals(remainder.left, ctx)) !== "i32") return undefined;
  if (!exprIsKnownNonNegative(remainder.left, ctx)) return undefined;
  const inverse = oddModInverse32(divisor);
  if (inverse === undefined) return undefined;
  return {
    dividend: remainder.left,
    inverse,
    threshold: Math.floor(0xffff_ffff / divisor),
  };
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
  return lowerFlattenedSlotsViaTemps(body, slots, [slotIndex], ctx, locals);
}

function lowerFlattenedSlotsViaTemps(
  body: Instr[],
  slots: LayoutSlot[],
  slotIndexes: number[],
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
    ...slotIndexes.map((slotIndex): Instr => ({
      op: "local.get",
      name: temps[slotIndex] ?? temps[0] ?? "__slot_tmp_missing",
    })),
  ];
}

function lowerProjectedCallResult(
  body: Instr[],
  actualType: string | undefined,
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (!actualType || !expectedType || actualType === expectedType) return undefined;
  const actualSlots = flattenType(actualType, ctx.layouts);
  const expectedSlots = flattenType(expectedType, ctx.layouts);
  if (!expectedSlots.length || actualSlots.length <= expectedSlots.length) return undefined;
  const indexes = expectedSlots.map((expected) => {
    if (!expected.suffix) return undefined;
    return actualSlots.findIndex((actual) => actual.suffix === expected.suffix);
  });
  if (indexes.some((index) => index === undefined || index < 0)) {
    const nestedIndexes = nestedProjectedSlotIndexes(
      actualType,
      expectedType,
      actualSlots,
      expectedSlots,
      ctx,
    );
    if (!nestedIndexes) return undefined;
    return lowerFlattenedSlotsViaTemps(body, actualSlots, nestedIndexes, ctx, locals);
  }
  return lowerFlattenedSlotsViaTemps(body, actualSlots, indexes as number[], ctx, locals);
}

function nestedProjectedSlotIndexes(
  actualType: string,
  expectedType: string,
  actualSlots: LayoutSlot[],
  expectedSlots: LayoutSlot[],
  ctx: LowerContext,
): number[] | undefined {
  const fields = productFieldTypes(actualType, ctx.layouts);
  if (!fields) return undefined;
  for (const field of fields) {
    if (compactTypeSource(field.type) !== compactTypeSource(expectedType)) continue;
    const indexes = expectedSlots.map((expected) => {
      const suffix = expected.suffix ? `${field.label}$${expected.suffix}` : field.label;
      return actualSlots.findIndex((actual) => actual.suffix === suffix);
    });
    if (indexes.every((index) => index >= 0)) return indexes;
  }
  return undefined;
}

function lowerPipeBind(
  expr: Extract<Expr, { kind: "pipe_bind" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  let valueType = exprTypeWithLocals(expr.value, ctx);
  valueType ??= exprType(expr.value, ctx.functions);
  const bindings = flattenBinding(expr.name, valueType, ctx.layouts);
  const value = lowerExpr(expr.value, ctx, locals, valueType);
  for (const binding of bindings) locals.add(binding.name);
  let bodyCtx = ctxWithLocalType(ctx, expr.name, valueType);
  const fact = exprI32Facts(expr.value, ctx);
  if (fact && bindings.length === 1 && bindings[0]?.wat === "i32") {
    bodyCtx = ctxWithLocalScalarFact(bodyCtx, bindings[0].name, fact);
  }
  return [
    ...value,
    ...bindings.map((binding) => binding.name).toReversed().map((name): Instr => ({
      op: "local.set",
      name,
    })),
    ...lowerExpr(expr.body, bodyCtx, locals, expectedType),
  ];
}

function lowerPrivateProductCallInline(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  options: { deadProductArgs?: Set<number>; expectedType?: string } = {},
): Instr[] | undefined {
  if (ctx.optMode !== "release" || expr.callee.kind !== "var") return undefined;
  if (!ctx.currentFn) return undefined;
  const callee = ctx.functions.get(expr.callee.name);
  if (!callee || isCurrentModulePublic(callee) || callee.name === ctx.currentFn?.name) {
    return undefined;
  }
  if (callee.primitiveId) return undefined;
  if (isFixedArrayProtocolHelper(callee, ctx)) return undefined;
  if (ctx.inlineStack?.has(callee.name)) return undefined;
  if (callee.params.some((param) => param.name.startsWith("__state"))) return undefined;
  if (callee.params.some((param) => param.const) || !callee.returnType) return undefined;
  const returnSlots = flattenType(callee.returnType, ctx.layouts);
  if (returnSlots.length <= 1) return undefined;
  if (hasRuntimeEffect(callee.body, ctx.functions)) return undefined;
  const argOffset = Math.max(0, expr.args.length - callee.params.length);
  const runtimeArgs = expr.args.slice(argOffset);
  if (runtimeArgs.length !== callee.params.length) return undefined;
  const calleeTailCalls = cachedAnalyzeTailCalls(callee, ctx.backendCache);
  // Array-free product loops are cheaper as calls from private wrappers; inlining them creates
  // nested loop bodies without unlocking a backed fixed-array representation.
  if (
    !isCurrentModulePublic(ctx.currentFn) && calleeTailCalls.hasDirectSelfCall &&
    !functionHasAnyFixedArrayPlan(callee.name, ctx)
  ) {
    return undefined;
  }
  if (
    isCurrentModulePublic(ctx.currentFn) && calleeTailCalls.hasDirectSelfCall &&
    (nonSelfCallSiteCount(callee.name, ctx) !== 1 ||
      hasNonSelfCalls(callee, ctx.backendCache) ||
      functionHasAnyFixedArrayPlan(callee.name, ctx))
  ) {
    return undefined;
  }
  if (isCurrentModulePublic(ctx.currentFn) && typeContainsInlineArray(callee.returnType, ctx)) {
    return undefined;
  }
  let expectedSlots = returnSlots;
  if (options.expectedType) {
    expectedSlots = flattenType(options.expectedType, ctx.layouts);
  }
  const canProjectReturn = expectedSlots.length > 0 && expectedSlots.length < returnSlots.length;
  const hasDeadProductArgs = (options.deadProductArgs?.size ?? 0) > 0;
  const currentTailCalls = cachedAnalyzeTailCalls(ctx.currentFn, ctx.backendCache);
  const inlineArrayTailProduct = typeContainsInlineArray(callee.returnType, ctx) &&
    currentTailCalls.hasOnlyTailDirectSelfCalls;
  const canUseTailProductBudget = calleeTailCalls.hasOnlyTailDirectSelfCalls ||
    inlineArrayTailProduct;
  const inlineCost = cachedBackendInlineBlockCost(callee.body, ctx.backendCache) +
    returnSlots.length;
  let inlineBudget = PRODUCT_BACKEND_INLINE_COST_BUDGET;
  if (canUseTailProductBudget) {
    inlineBudget = PRODUCT_TAIL_LOOP_BACKEND_INLINE_COST_BUDGET;
  } else if (canProjectReturn || hasDeadProductArgs) {
    inlineBudget = PROJECTED_PRODUCT_BACKEND_INLINE_COST_BUDGET;
  }
  if (inlineCost > inlineBudget) return undefined;
  const scalarArgSubstitutions = new Map<string, Expr>();
  if (!calleeTailCalls.hasDirectSelfCall) {
    for (const [index, param] of callee.params.entries()) {
      const arg = runtimeArgs[index];
      if (!arg || arg.kind === "var") continue;
      if (!isInlineScalarParamType(param.type, ctx.layouts)) continue;
      if (hasRuntimeEffect(arg, ctx.functions)) continue;
      if (cachedCountNameUses(callee.body, param.name, ctx.backendCache) > 1) continue;
      scalarArgSubstitutions.set(param.name, arg);
    }
  }
  const prefix = `__inl_${callee.name.replaceAll(/[^A-Za-z0-9_]/g, "_")}_${ctx.tempIndex++}`;
  const renames = new Map<string, string>();
  const aliasedScalarParams = new Set<string>();
  const aliasedProductParams = new Set<string>();
  const deadAliasedProductParams = new Set<string>();
  const selfCalls = calleeTailCalls.hasDirectSelfCall
    ? directTailLoopStepCallExprs(callee.body, callee.name)
    : [];
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
      isInlineScalarParamType(param.type, ctx.layouts) &&
      !deadProductBases.has(baseName(arg.name))
    ) {
      renames.set(param.name, arg.name);
      aliasedScalarParams.add(param.name);
    } else if (scalarArgSubstitutions.has(param.name)) {
      renames.set(param.name, param.name);
      aliasedScalarParams.add(param.name);
    } else if (
      (options.deadProductArgs?.has(index) ||
        productParamIsInvariantSelfArg(selfCalls, callee, index, param, ctx)) &&
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
  const renamed = renameFunctionLocalsThenSubstitute(callee, renames, scalarArgSubstitutions);
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
    localTypes: inlinedLocalTypes(ctx, renamed),
    inlineStack: new Set([...(ctx.inlineStack ?? []), callee.name]),
    deadProductBases: new Set([
      ...(ctx.deadProductBases ?? []),
      ...[...deadAliasedProductParams].map((param) => renames.get(param) ?? param).map(baseName),
    ]),
    scratchArrays,
    packedArrays,
    localSlotArrays,
    fixedArrayTransformerAliases: new Map(),
    simdDotHelperName: ctx.simdDotHelperName ??
      (ctx.optMode === "release" && countDot4I32Exprs(renamed.body) > 1
        ? SIMD_DOT4_I32_HELPER
        : undefined),
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
    registerInlinedPackedArrayPlan(ctx, plan);
    const name = packedArrayLocalName(plan.name);
    if (!locals.has(name) && !ctx.tempLocals.some((item) => item.name === name)) {
      locals.add(name);
      ctx.tempLocals.push({ name, type: plan.packedType });
    }
  }
  const directPackedParamInits = new Map<number, Instr[]>();
  renamed.params.forEach((param, index) => {
    const originalParam = callee.params[index];
    if (!originalParam || aliasedScalarParams.has(originalParam.name)) return;
    const plan = packedArrays?.get(param.name);
    const arg = runtimeArgs[index];
    if (!plan || arg?.kind !== "var") return;
    directPackedParamInits.set(index, lowerPackedArrayInitFromExpr(plan, arg, ctx, locals));
  });
  for (const local of collectIrLocals(renamed.body, inlineCtx)) {
    if (locals.has(local.name) || ctx.tempLocals.some((item) => item.name === local.name)) {
      continue;
    }
    locals.add(local.name);
    ctx.tempLocals.push(local);
  }
  const tailCalls = cachedAnalyzeTailCalls(renamed, ctx.backendCache);
  const body = tailCalls.hasOnlyTailDirectSelfCalls
    ? lowerTailLoopBlock(renamed.body, renamed, inlineCtx, locals)
    : lowerBlock(renamed.body, inlineCtx, locals, renamed.returnType);
  const projectedBody = options.expectedType
    ? lowerProjectedCallResult(body, renamed.returnType, options.expectedType, ctx, locals)
    : undefined;
  const scratchPrologue = [...(scratchArrays?.values() ?? [])].flatMap((plan) =>
    lowerScratchArrayInit(plan)
  );
  const directPackedPlanNames = new Set(
    [...directPackedParamInits.keys()].map((index) => renamed.params[index]?.name).filter((
      name,
    ): name is string => Boolean(name)),
  );
  const directPackedPrologue = [...directPackedParamInits.entries()].flatMap(([, init]) => init);
  const packedPrologue = [...(packedArrays?.values() ?? [])].filter((plan) =>
    !directPackedPlanNames.has(plan.name)
  ).flatMap((plan) => lowerPackedArrayInit(plan));
  const forwarded = forwardedDeadProductCallInline(
    renamed.body,
    inlineCtx,
    locals,
    new Set(
      [...aliasedProductParams].map((param) => renames.get(param) ?? param).map(baseName),
    ),
  );
  traceInstant(ctx.trace, "backend.inline.product_call", {
    caller: ctx.currentFn.name.slice(0, 120),
    callee: callee.name.slice(0, 120),
    calleeNameLength: callee.name.length,
    inlineCost,
    returnSlots: returnSlots.length,
    expectedSlots: expectedSlots.length,
    projected: canProjectReturn,
    tailProductBudget: canUseTailProductBudget,
    deadProductArgs: options.deadProductArgs?.size ?? 0,
    aliasedScalarParams: aliasedScalarParams.size,
    aliasedProductParams: aliasedProductParams.size,
    forwarded: forwarded !== undefined,
  });
  return [
    ...runtimeArgs.flatMap((arg, index) =>
      aliasedScalarParams.has(callee.params[index]?.name ?? "") ||
        aliasedProductParams.has(callee.params[index]?.name ?? "") ||
        directPackedParamInits.has(index)
        ? []
        : lowerExpr(arg, ctx, locals, renamed.params[index]?.type ?? callee.params[index]?.type)
    ),
    ...paramBindings.filter((binding) =>
      ![...directPackedPlanNames].some((name) =>
        binding.name === name || binding.name.startsWith(`${name}$`)
      )
    ).toReversed().map((binding): Instr => ({
      op: "local.set",
      name: binding.name,
    })),
    ...scratchPrologue,
    ...directPackedPrologue,
    ...packedPrologue,
    ...(forwarded ?? projectedBody ?? body),
  ];
}

function isFixedArrayProtocolHelper(
  fn: FnDecl,
  ctx: LowerContext,
  seen = new Set<string>(),
): boolean {
  if (seen.has(fn.name)) return false;
  seen.add(fn.name);
  if (inlineArrayLoopPlan(fn, ctx)) return true;
  if (
    fn.body.expr &&
    (fixedArrayUpdateCall(fn.body.expr, ctx) || fixedArraySwapCall(fn.body.expr, ctx))
  ) {
    return true;
  }
  const wrapperCall = inlineArrayLoopWrapperCall(fn);
  if (!wrapperCall || wrapperCall.callee.kind !== "var") return false;
  const callee = ctx.functions.get(wrapperCall.callee.name);
  return callee ? isFixedArrayProtocolHelper(callee, ctx, seen) : false;
}

function registerInlinedPackedArrayPlan(ctx: LowerContext, plan: PackedArrayPlan) {
  if (!ctx.cleanupPackedArrays) ctx.cleanupPackedArrays = new Map(ctx.packedArrays);
  if (!ctx.cleanupPackedArrays.has(plan.name)) ctx.cleanupPackedArrays.set(plan.name, plan);
}

function typeContainsInlineArray(
  type: string | undefined,
  ctx: LowerContext,
  seen = new Set<string>(),
): boolean {
  if (!type) return false;
  const resolved = resolveAlias(type, ctx.layouts) ?? type;
  if (inlineArrayLikeTypeArgs(resolved, ctx.layouts)) return true;
  if (seen.has(resolved)) return false;
  seen.add(resolved);
  return productFieldTypes(resolved, ctx.layouts)?.some((field) =>
    typeContainsInlineArray(field.type, ctx, seen)
  ) ?? false;
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

const SCALAR_BACKEND_INLINE_COST_BUDGET = 18;
const SCALAR_TAIL_LOOP_BACKEND_INLINE_COST_BUDGET = 160;
const PRODUCT_BACKEND_INLINE_COST_BUDGET = 16;
const PRODUCT_TAIL_LOOP_BACKEND_INLINE_COST_BUDGET = 160;
const PROJECTED_PRODUCT_BACKEND_INLINE_COST_BUDGET = 0;

function lowerPrivateScalarTailLoopCallInline(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (ctx.optMode !== "release" || expr.callee.kind !== "var") return undefined;
  if (!ctx.currentFn) return undefined;
  const callee = ctx.functions.get(expr.callee.name);
  if (!callee || isCurrentModulePublic(callee) || callee.name === ctx.currentFn.name) {
    return undefined;
  }
  if (callee.primitiveId) return undefined;
  if (callee.effects.length || (callee.generated && !callee.generatedInlineable)) return undefined;
  if (ctx.inlineStack?.has(callee.name)) return undefined;
  if (callee.params.some((param) => param.const) || !callee.returnType) return undefined;
  if (
    callee.params.some((param) =>
      parseBackendFnSignature(resolveAlias(param.type, ctx.layouts) ?? param.type)
    )
  ) {
    return undefined;
  }
  if (flattenType(callee.returnType, ctx.layouts).length !== 1) return undefined;
  if (hasRuntimeEffect(callee.body, ctx.functions)) return undefined;
  const tailCalls = cachedAnalyzeTailCalls(callee, ctx.backendCache);
  if (!tailCalls.hasOnlyTailDirectSelfCalls) return undefined;
  if (
    cachedBackendInlineBlockCost(callee.body, ctx.backendCache) >
      SCALAR_TAIL_LOOP_BACKEND_INLINE_COST_BUDGET
  ) {
    return undefined;
  }
  if (isCurrentModulePublic(ctx.currentFn)) {
    if (nonSelfCallSiteCount(callee.name, ctx) !== 1 || hasNonSelfCalls(callee, ctx.backendCache)) {
      return undefined;
    }
    if (callee.params.some((param) => typeContainsInlineArray(param.type, ctx))) return undefined;
  } else if (privateNonSelfCallSiteCount(callee.name, ctx) !== 1) return undefined;
  const argOffset = Math.max(0, expr.args.length - callee.params.length);
  const runtimeArgs = expr.args.slice(argOffset);
  if (runtimeArgs.length !== callee.params.length) return undefined;
  if (runtimeArgs.some((arg) => hasRuntimeEffect(arg, ctx.functions))) return undefined;

  const prefix = `__inl_${callee.name.replaceAll(/[^A-Za-z0-9_]/g, "_")}_${ctx.tempIndex++}`;
  const selfCalls = directTailLoopStepCallExprs(callee.body, callee.name);
  const scalarArgSubstitutions = new Map<string, Expr>();
  const productFieldSubstitutions = new Map<string, Expr>();
  for (const [index, param] of callee.params.entries()) {
    const arg = runtimeArgs[index];
    if (!arg) continue;
    if (isInlineScalarParamType(param.type, ctx.layouts)) {
      if (arg.kind === "var") continue;
      if (
        selfCalls.length &&
        !selfCalls.every((call) =>
          tailLoopArgIsIdentity(tailLoopCallArgs(call, callee)[index], param, ctx)
        )
      ) {
        continue;
      }
      if (cachedCountNameUses(callee.body, param.name, ctx.backendCache) > 1) continue;
      scalarArgSubstitutions.set(param.name, arg);
      continue;
    }
    const fields = productFieldTypes(param.type, ctx.layouts);
    if (!fields?.length) continue;
    const productArgIsLoopInvariant = selfCalls.length > 0 &&
      selfCalls.every((call) =>
        tailLoopArgIsIdentity(tailLoopCallArgs(call, callee)[index], param, ctx)
      );
    if (!productArgIsLoopInvariant) continue;
    const fieldValues = productArgFieldValues(arg, fields);
    if (!fieldValues) continue;
    for (const [field, value] of fieldValues) {
      if (
        hasRuntimeEffect(value, ctx.functions) ||
        countFieldAccessUses(callee.body, param.name, field) > 1
      ) {
        continue;
      }
      productFieldSubstitutions.set(`${param.name}.${field}`, value);
    }
  }
  const substitutions = new Map([...scalarArgSubstitutions, ...productFieldSubstitutions]);
  if (productFieldSubstitutions.size) return undefined;
  const renames = new Map<string, string>();
  const aliasedScalarParams = new Set<string>();
  const aliasedProductParams = new Set<string>();
  for (const [index, param] of callee.params.entries()) {
    const originalParam = callee.params[index];
    const arg = runtimeArgs[index];
    if (
      originalParam &&
      arg?.kind === "var" &&
      isInlineScalarParamType(param.type, ctx.layouts) &&
      selfCalls.every((call) =>
        tailLoopArgIsIdentity(tailLoopCallArgs(call, callee)[index], originalParam, ctx)
      )
    ) {
      renames.set(param.name, arg.name);
      aliasedScalarParams.add(originalParam.name);
      continue;
    }
    if (
      originalParam &&
      arg?.kind === "var" &&
      productParamIsInvariantSelfArg(selfCalls, callee, index, originalParam, ctx) &&
      !paramHasAnyFixedArrayPlan(callee.name, originalParam.name, ctx)
    ) {
      renames.set(param.name, arg.name);
      aliasedProductParams.add(originalParam.name);
      continue;
    }
    renames.set(
      param.name,
      scalarArgSubstitutions.has(param.name) ? param.name : `${prefix}_${param.name}`,
    );
  }
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
  const renamed = renameFunctionLocalsThenSubstitute(callee, renames, substitutions);
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
  const localScalarFacts = scalarFactsForFunctionParams(renamed, ctx, callee.name, renames);
  dropLoopVaryingParamFacts(localScalarFacts, callee, renamed, selfCalls, ctx);
  callee.params.forEach((param, index) => {
    if (
      param.type === "i32" &&
      exprIsObviouslyNonNegative(runtimeArgs[index]) &&
      selfCalls.every((call) =>
        selfTailArgPreservesNonNegative(
          tailLoopCallArgs(call, callee)[index],
          param.name,
          tailParamGuardUpperBound(callee, param.name),
        )
      )
    ) {
      mergeLocalScalarFact(
        localScalarFacts,
        renames.get(param.name) ?? param.name,
        nonNegativeI32Fact(),
      );
    }
  });
  const inlineCtx: LowerContext = {
    ...ctx,
    currentFn: renamed,
    localTypes: inlinedLocalTypes(ctx, renamed),
    localScalarFacts,
    inlineStack: new Set([...(ctx.inlineStack ?? []), callee.name]),
    scratchArrays,
    packedArrays,
    localSlotArrays,
    fixedArrayTransformerAliases: new Map(),
  };
  const paramBindings = renamed.params.flatMap((param, index) =>
    scalarArgSubstitutions.has(callee.params[index]?.name ?? "") ||
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
    registerInlinedPackedArrayPlan(ctx, plan);
    const name = packedArrayLocalName(plan.name);
    if (!locals.has(name) && !ctx.tempLocals.some((item) => item.name === name)) {
      locals.add(name);
      ctx.tempLocals.push({ name, type: plan.packedType });
    }
  }
  const directPackedParamInits = new Map<number, Instr[]>();
  renamed.params.forEach((param, index) => {
    const plan = packedArrays?.get(param.name);
    const arg = runtimeArgs[index];
    if (!plan || arg?.kind !== "var") return;
    directPackedParamInits.set(index, lowerPackedArrayInitFromExpr(plan, arg, ctx, locals));
  });
  for (const local of collectIrLocals(renamed.body, inlineCtx)) {
    if (locals.has(local.name) || ctx.tempLocals.some((item) => item.name === local.name)) continue;
    locals.add(local.name);
    ctx.tempLocals.push(local);
  }
  const scratchPrologue = [...(scratchArrays?.values() ?? [])].flatMap((plan) =>
    lowerScratchArrayInit(plan)
  );
  const directPackedPlanNames = new Set(
    [...directPackedParamInits.keys()].map((index) => renamed.params[index]?.name).filter((
      name,
    ): name is string => Boolean(name)),
  );
  const directPackedPrologue = [...directPackedParamInits.entries()].flatMap(([, init]) => init);
  const filteredPackedPrologue = [...(packedArrays?.values() ?? [])].filter((plan) =>
    !directPackedPlanNames.has(plan.name)
  ).flatMap((plan) => lowerPackedArrayInit(plan));

  traceInstant(ctx.trace, "backend.inline.scalar_tail_loop_call", {
    caller: ctx.currentFn.name.slice(0, 120),
    callee: callee.name.slice(0, 120),
    calleeNameLength: callee.name.length,
    scalarArgSubstitutions: scalarArgSubstitutions.size,
    productFieldSubstitutions: productFieldSubstitutions.size,
    aliasedScalarParams: aliasedScalarParams.size,
    aliasedProductParams: aliasedProductParams.size,
    scratchArrays: scratchArrays?.size ?? 0,
    packedArrays: packedArrays?.size ?? 0,
    localSlotArrays: localSlotArrays?.size ?? 0,
  });
  return [
    ...runtimeArgs.flatMap((arg, index) =>
      scalarArgSubstitutions.has(callee.params[index]?.name ?? "") ||
        aliasedScalarParams.has(callee.params[index]?.name ?? "") ||
        aliasedProductParams.has(callee.params[index]?.name ?? "") ||
        directPackedParamInits.has(index)
        ? []
        : lowerExpr(arg, ctx, locals, callee.params[index]?.type)
    ),
    ...paramBindings.filter((binding) =>
      ![...directPackedPlanNames].some((name) =>
        binding.name === name || binding.name.startsWith(`${name}$`)
      )
    ).toReversed().map((binding): Instr => ({
      op: "local.set",
      name: binding.name,
    })),
    ...scratchPrologue,
    ...directPackedPrologue,
    ...filteredPackedPrologue,
    ...lowerTailLoopBlock(renamed.body, renamed, inlineCtx, locals),
  ];
}

function privateNonSelfCallSiteCount(name: string, ctx: LowerContext): number {
  let count = 0;
  for (const fn of ctx.signatures.values()) {
    if (isCurrentModulePublic(fn) || fn.name === name) continue;
    count += cachedCallCountInExpr(fn.body, name, ctx.backendCache);
  }
  return count;
}

function nonSelfCallSiteCount(name: string, ctx: LowerContext): number {
  let count = 0;
  for (const fn of ctx.signatures.values()) {
    if (fn.name === name) continue;
    count += cachedCallCountInExpr(fn.body, name, ctx.backendCache);
  }
  return count;
}

function hasNonSelfCalls(fn: FnDecl, cache?: BackendCache): boolean {
  for (const name of cachedCalledFunctions(fn.body, cache)) {
    if (name !== fn.name) return true;
  }
  return false;
}

function functionHasAnyFixedArrayPlan(name: string, ctx: LowerContext): boolean {
  return Boolean(
    ctx.scratchPlansByFunction?.get(name)?.size ||
      ctx.packedPlansByFunction?.get(name)?.size ||
      ctx.localSlotPlansByFunction?.get(name)?.size,
  );
}

function paramHasAnyFixedArrayPlan(functionName: string, paramName: string, ctx: LowerContext) {
  return Boolean(
    ctx.scratchPlansByFunction?.get(functionName)?.has(paramName) ||
      ctx.packedPlansByFunction?.get(functionName)?.has(paramName) ||
      ctx.localSlotPlansByFunction?.get(functionName)?.has(paramName),
  );
}

function productParamIsInvariantSelfArg(
  selfCalls: Extract<Expr, { kind: "call" }>[],
  sourceFn: FnDecl,
  index: number,
  param: Param,
  ctx: LowerContext,
): boolean {
  if (!selfCalls.length) return false;
  if (flattenType(param.type, ctx.layouts).length <= 1) return false;
  return selfCalls.every((call) =>
    tailLoopArgIsIdentity(tailLoopCallArgs(call, sourceFn)[index], param, ctx)
  );
}

function scalarFunctionMatchesUnionParam(fn: FnDecl, layouts: LayoutEnv): boolean {
  const unionParams = new Set<string>();
  for (const param of fn.params) {
    if (param.const) continue;
    if (typeAnnotationIsUnion(param.type, layouts)) unionParams.add(param.name);
  }
  if (!unionParams.size) return false;
  let found = false;
  const visit = (expr: Expr | undefined) => {
    if (!expr || found) return;
    if (expr.kind === "match" && expr.value.kind === "var") {
      const matchedBase = baseName(expr.value.name);
      if (unionParams.has(matchedBase)) {
        found = true;
        return;
      }
    }
    for (const child of exprChildren(expr)) visit(child);
  };
  for (const stmt of fn.body.statements) {
    if (stmt.kind === "type_assert") continue;
    if (stmt.kind === "debug_trace") {
      for (const arg of stmt.args) visit(arg);
      continue;
    }
    visit(stmt.value);
  }
  visit(fn.body.expr);
  return found;
}

function typeAnnotationIsUnion(type: string | undefined, layouts: LayoutEnv): boolean {
  const resolved = resolveAlias(type, layouts) ?? stripBorrowType(type)?.trim();
  if (!resolved) return false;
  const decl = layouts.types.get(typeName(resolved));
  if (!decl) return false;
  if (decl.resultKind === "union") return true;
  return decl.normalized?.kind === "sum";
}

function lowerPrivateScalarCallInline(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (ctx.optMode !== "release" || expr.callee.kind !== "var") return undefined;
  if (!ctx.currentFn) return undefined;
  const callee = ctx.functions.get(expr.callee.name);
  if (!callee || isCurrentModulePublic(callee) || callee.name === ctx.currentFn.name) {
    return undefined;
  }
  if (callee.primitiveId) return undefined;
  if (callee.effects.length || (callee.generated && !callee.generatedInlineable)) return undefined;
  if (ctx.inlineStack?.has(callee.name)) return undefined;
  if (callee.params.some((param) => param.const) || !callee.returnType) return undefined;
  if (
    callee.params.some((param) =>
      parseBackendFnSignature(resolveAlias(param.type, ctx.layouts) ?? param.type)
    )
  ) {
    return undefined;
  }
  if (flattenType(callee.returnType, ctx.layouts).length !== 1) return undefined;
  if (hasRuntimeEffect(callee.body, ctx.functions)) return undefined;
  if (hasNonSelfCalls(callee, ctx.backendCache)) return undefined;
  if (scalarFunctionMatchesUnionParam(callee, ctx.layouts)) return undefined;
  if (cachedAnalyzeTailCalls(callee, ctx.backendCache).hasDirectSelfCall) return undefined;
  const cost = cachedBackendInlineBlockCost(callee.body, ctx.backendCache);
  const canInlineTailLoopPredicate = callee.returnType === "bool" &&
    !callee.generated &&
    cachedAnalyzeTailCalls(ctx.currentFn, ctx.backendCache).hasOnlyTailDirectSelfCalls &&
    cost <= 32;
  if (cost > SCALAR_BACKEND_INLINE_COST_BUDGET && !canInlineTailLoopPredicate) return undefined;
  const argOffset = Math.max(0, expr.args.length - callee.params.length);
  const runtimeArgs = expr.args.slice(argOffset);
  if (runtimeArgs.length !== callee.params.length) return undefined;
  if (runtimeArgs.some((arg) => hasRuntimeEffect(arg, ctx.functions))) return undefined;

  const prefix = `__inl_${callee.name.replaceAll(/[^A-Za-z0-9_]/g, "_")}_${ctx.tempIndex++}`;
  const scalarArgSubstitutions = new Map<string, Expr>();
  const productFieldSubstitutions = new Map<string, Expr>();
  const productFieldTempInits: Instr[] = [];
  for (const [index, param] of callee.params.entries()) {
    const arg = runtimeArgs[index];
    if (!arg) continue;
    if (isInlineScalarParamType(param.type, ctx.layouts)) {
      if (arg.kind === "var") continue;
      if (cachedCountNameUses(callee.body, param.name, ctx.backendCache) > 1) continue;
      scalarArgSubstitutions.set(param.name, arg);
      continue;
    }
    const fields = productFieldTypes(param.type, ctx.layouts);
    if (!fields?.length) continue;
    const fieldValues = productArgFieldValues(arg, fields);
    if (!fieldValues) continue;
    for (const [field, value] of fieldValues) {
      if (hasRuntimeEffect(value, ctx.functions)) continue;
      const uses = countFieldAccessUses(callee.body, param.name, field);
      if (value.kind !== "var" && value.kind !== "field" && uses > 1) {
        const slots = flattenType(fields.find((item) => item.label === field)?.type, ctx.layouts);
        const slot = slots[0];
        if (!slot || slots.length !== 1 || !isSpeculableNonTrappingExpr(value, ctx.functions)) {
          continue;
        }
        const name = `${prefix}_${param.name}_${field}`;
        locals.add(name);
        ctx.tempLocals.push({ name, type: slot.wat });
        productFieldTempInits.push(
          ...lowerExpr(value, ctx, locals, fields.find((item) => item.label === field)?.type),
          { op: "local.set", name },
        );
        productFieldSubstitutions.set(`${param.name}.${field}`, { kind: "var", name });
        continue;
      }
      if (value.kind !== "var" && value.kind !== "field" && uses > 1) continue;
      productFieldSubstitutions.set(`${param.name}.${field}`, value);
    }
  }
  const substitutions = new Map([...scalarArgSubstitutions, ...productFieldSubstitutions]);

  const renames = new Map<string, string>();
  const aliasedScalarParams = new Set<string>();
  const elidedProductParams = new Set<string>();
  for (const [index, param] of callee.params.entries()) {
    const arg = runtimeArgs[index];
    if (
      arg?.kind === "var" &&
      isInlineScalarParamType(param.type, ctx.layouts)
    ) {
      renames.set(param.name, arg.name);
      aliasedScalarParams.add(param.name);
      continue;
    }
    if (
      arg?.kind === "var" &&
      flattenType(param.type, ctx.layouts).length > 1 &&
      !exprMentionsName(callee.body, param.name)
    ) {
      renames.set(param.name, param.name);
      elidedProductParams.add(param.name);
      continue;
    }
    renames.set(
      param.name,
      substitutions.has(param.name) ? param.name : `${prefix}_${param.name}`,
    );
  }
  const renamed = renameFunctionLocalsThenSubstitute(callee, renames, substitutions);
  const localSlotArrays = renamedLocalSlotPlans(
    ctx.localSlotPlansByFunction?.get(callee.name),
    renames,
  );
  const inlineCtx: LowerContext = {
    ...ctx,
    currentFn: renamed,
    localTypes: inlinedLocalTypes(ctx, renamed),
    inlineStack: new Set([...(ctx.inlineStack ?? []), callee.name]),
    localSlotArrays,
  };
  const paramBindings = renamed.params.flatMap((param, index) =>
    substitutions.has(callee.params[index]?.name ?? "") ||
      elidedProductParams.has(callee.params[index]?.name ?? "") ||
      aliasedScalarParams.has(callee.params[index]?.name ?? "")
      ? []
      : flattenBinding(param.name, param.type, ctx.layouts)
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

  traceInstant(ctx.trace, "backend.inline.scalar_call", {
    caller: ctx.currentFn.name.slice(0, 120),
    callee: callee.name.slice(0, 120),
    calleeNameLength: callee.name.length,
    cost,
    scalarArgSubstitutions: scalarArgSubstitutions.size,
    productFieldSubstitutions: productFieldSubstitutions.size,
    aliasedScalarParams: aliasedScalarParams.size,
    elidedProductParams: elidedProductParams.size,
  });
  let inlineExpectedType = renamed.returnType;
  if (expectedType && flattenedTypesMatch(renamed.returnType, expectedType, ctx.layouts)) {
    inlineExpectedType = expectedType;
  }
  return [
    ...productFieldTempInits,
    ...runtimeArgs.flatMap((arg, index) =>
      substitutions.has(callee.params[index]?.name ?? "") ||
        elidedProductParams.has(callee.params[index]?.name ?? "") ||
        aliasedScalarParams.has(callee.params[index]?.name ?? "")
        ? []
        : lowerExpr(arg, ctx, locals, callee.params[index]?.type)
    ),
    ...paramBindings.toReversed().map((binding): Instr => ({
      op: "local.set",
      name: binding.name,
    })),
    ...lowerBlock(renamed.body, inlineCtx, locals, inlineExpectedType),
  ];
}

function inlinedLocalTypes(ctx: LowerContext, renamed: FnDecl): Map<string, string> {
  const localTypes = new Map(ctx.localTypes);
  for (const param of renamed.params) {
    localTypes.set(param.name, param.type);
  }
  return localTypes;
}

function productArgFieldValues(
  arg: Expr,
  fields: { label: string; type: string }[],
): Map<string, Expr> | undefined {
  if (arg.kind === "var") {
    return new Map(fields.map((field) => [
      field.label,
      {
        kind: "field",
        value: arg,
        key: { kind: "literal", literalKind: "literalType", value: `#${field.label}` },
      } as Expr,
    ]));
  }
  if (arg.kind !== "product_constructor" && arg.kind !== "shape") return undefined;
  if (arg.slots.some((slot) => slot.spread || slot.index || !slot.label)) return undefined;
  const slots = new Map(arg.slots.map((slot) => [slot.label!, slot.value]));
  if (fields.some((field) => !slots.has(field.label))) return undefined;
  return new Map(fields.map((field) => [field.label, slots.get(field.label)!]));
}

function countFieldAccessUses(expr: Expr | BlockExpr, base: string, field: string): number {
  let count = 0;
  const visit = (item: Expr | BlockExpr | Statement | undefined) => {
    if (!item) return;
    if ("kind" in item && item.kind === "var" && item.name === `${base}.${field}`) {
      count++;
      return;
    }
    if ("kind" in item && item.kind === "field" && fieldAccessName(item) === `${base}.${field}`) {
      count++;
      return;
    }
    if ("kind" in item && (item.kind === "let" || item.kind === "destructure_let")) {
      visit(item.value);
      return;
    }
    for (const child of exprChildren(item as Expr | BlockExpr)) visit(child);
  };
  visit(expr);
  return count;
}

function backendInlineBlockCost(block: BlockExpr): number {
  return block.statements.reduce((sum, stmt) => sum + backendInlineStatementCost(stmt), 0) +
    (block.expr ? backendInlineExprCost(block.expr) : 0);
}

function cachedBackendInlineBlockCost(block: BlockExpr, cache?: BackendCache): number {
  const inlineCosts = cache?.backendInlineCosts;
  if (!inlineCosts) return backendInlineBlockCost(block);
  const cached = inlineCosts.get(block);
  if (cached !== undefined) return cached;
  const cost = backendInlineBlockCost(block);
  inlineCosts.set(block, cost);
  return cost;
}

function backendInlineStatementCost(stmt: Statement): number {
  if (stmt.kind === "type_assert") return 0;
  if (stmt.kind === "debug_trace") return 1;
  return 1 + backendInlineExprCost(stmt.value);
}

function backendInlineExprCost(expr: Expr): number {
  switch (expr.kind) {
    case "do":
      return 100;
    case "const_fn":
      return 1 + backendInlineExprCost(expr.body);
    case "profile":
      return 2 + expr.args.reduce((sum, arg) => sum + backendInlineExprCost(arg), 0) +
        backendInlineExprCost(expr.body);
    case "call":
      return 2 + backendInlineExprCost(expr.callee) +
        expr.args.reduce((sum, arg) => sum + backendInlineExprCost(arg), 0);
    case "index":
      return 2 + backendInlineExprCost(expr.target) + backendInlineExprCost(expr.index);
    case "binary":
      return 1 + backendInlineExprCost(expr.left) + backendInlineExprCost(expr.right);
    case "operator_chain":
      return 1 + backendInlineExprCost(expr.first) +
        expr.rest.reduce((sum, item) => sum + backendInlineExprCost(item.value), 0);
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

function renameSubstitutionKeys(
  substitutions: Map<string, Expr>,
  renames: Map<string, string>,
): Map<string, Expr> {
  if (!substitutions.size) return substitutions;
  const renamed = new Map<string, Expr>();
  for (const [name, value] of substitutions) {
    renamed.set(renameDottedName(name, renames), value);
  }
  return renamed;
}

function renameFunctionLocalsThenSubstitute(
  fn: FnDecl,
  renames: Map<string, string>,
  substitutions: Map<string, Expr>,
): FnDecl {
  const renamed = renameFunctionLocals(fn, renames);
  if (!substitutions.size) return renamed;
  return {
    ...renamed,
    body: substituteExpr(
      renamed.body as Expr,
      renameSubstitutionKeys(substitutions, renames),
    ) as BlockExpr,
  };
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
    const name = renames.get(stmt.name) ?? `${inlineLocalPrefix(renames)}_${stmt.name}`;
    renames.set(stmt.name, name);
    return { ...stmt, name, value };
  }
  if (stmt.kind === "destructure_let") {
    const value = renameExpr(stmt.value, renames);
    const names = stmt.names.map((item) => {
      const name = renames.get(item) ?? `${inlineLocalPrefix(renames)}_${item}`;
      renames.set(item, name);
      return name;
    });
    return { ...stmt, names, value };
  }
  return stmt;
}

function inlineLocalPrefix(renames: Map<string, string>): string {
  const raw = [...renames.values()][0] ?? "__inl";
  return raw.replaceAll(/[^A-Za-z0-9_]/g, "_");
}

function renameExpr(expr: Expr, renames: Map<string, string>): Expr {
  switch (expr.kind) {
    case "do":
      return { ...expr, expr: expr.expr ? renameExpr(expr.expr, renames) : undefined };
    case "const_fn":
      return { ...expr, body: renameExpr(expr.body, renames) };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => renameExpr(arg, renames)),
        body: renameExpr(expr.body, renames),
      };
    case "var":
      return renameVarExpr(expr, renames);
    case "call":
      if (expr.tailRec) {
        return {
          ...expr,
          args: expr.args.map((arg) => renameExpr(arg, renames)),
        };
      }
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
    case "operator_chain":
      return {
        ...expr,
        first: renameExpr(expr.first, renames),
        rest: expr.rest.map((item) => ({ ...item, value: renameExpr(item.value, renames) })),
      };
    case "pipe_bind": {
      const value = renameExpr(expr.value, renames);
      const scoped = new Map(renames);
      const name = scoped.get(expr.name) ?? `${inlineLocalPrefix(renames)}_${expr.name}`;
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
            guard: arm.guard ? renameExpr(arm.guard, scoped) : undefined,
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
        `${inlineLocalPrefix(renames)}_${expr.iterator}`;
      scoped.set(expr.iterator, iterator);
      const valueIterator = expr.valueIterator
        ? scoped.get(expr.valueIterator) ??
          `${inlineLocalPrefix(renames)}_${expr.valueIterator}`
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
        `${inlineLocalPrefix(renames)}_${pattern.name}`;
      renames.set(pattern.name, name);
      return { ...pattern, name };
    }
    case "tuple":
      return { ...pattern, items: pattern.items.map((item) => renamePattern(item, renames)) };
    case "constructor":
      return { ...pattern, args: pattern.args.map((item) => renamePattern(item, renames)) };
    case "or":
      return {
        ...pattern,
        alternatives: pattern.alternatives.map((item) => renamePattern(item, new Map(renames))),
      };
    case "as": {
      const name = renames.get(pattern.name) ??
        `${[...renames.values()][0] ?? "__inl"}_${pattern.name}`;
      renames.set(pattern.name, name);
      return { ...pattern, name, pattern: renamePattern(pattern.pattern, renames) };
    }
    case "product":
      return {
        ...pattern,
        fields: pattern.fields.map((field) => ({
          ...field,
          pattern: renamePattern(field.pattern, renames),
        })),
      };
    case "typed":
      return { ...pattern, pattern: renamePattern(pattern.pattern, renames) };
    case "literal":
    case "enum_member":
    case "wildcard":
    case "type":
      return pattern;
  }
}

function constFold(expr: Expr, ctx?: LowerContext, seen = new Set<string>()): Expr {
  if (expr.kind === "var" && ctx && expr.name.endsWith("()")) {
    const fnName = expr.name.slice(0, -2);
    if (seen.has(fnName)) return expr;
    const fn = ctx.functions.get(fnName);
    if (fn?.returnType === "const" && fn.params.length === 0 && fn.body.expr) {
      return constFold(fn.body.expr, ctx, new Set([...seen, fnName]));
    }
  }
  if (expr.kind === "call" && expr.callee.kind === "var") {
    const args = expr.args.map((arg) => constFold(arg, ctx, seen));
    const foldedCall = args.some((arg, index) => arg !== expr.args[index])
      ? { ...expr, args }
      : expr;
    const shapeArg = args[0]?.kind === "shape" ? args[0] : undefined;
    if (ctx && expr.callee.name === "@type_slots" && args[0]) {
      const type = renderBackendTypeProofArg(args[0]);
      const slots = type ? productSlotsForType(type, ctx.layouts) : undefined;
      if (slots) return shapeExprFromLayoutSlots(slots);
    }
    if (expr.callee.name === "@shape_omit" && shapeArg && args[1]?.kind === "shape") {
      const omitted = new Set(args[1].slots.flatMap((slot) => slot.label ? [slot.label] : []));
      return {
        ...shapeArg,
        slots: shapeArg.slots.filter((slot) => !slot.label || !omitted.has(slot.label))
          .map((slot, position) => ({ ...slot, position })),
      };
    }
    if (expr.callee.name === "@shape_count") {
      if (!shapeArg) return foldedCall;
      return {
        kind: "literal",
        literalKind: "number",
        value: String(shapeArg.slots.length),
        inferredType: "i32",
      };
    }
    if (expr.callee.name === "@shape_first_key") {
      if (!shapeArg) return foldedCall;
      const label = shapeArg.slots[0]?.label;
      if (label) {
        return {
          kind: "literal",
          literalKind: "literalType",
          value: `#${label}`,
        };
      }
    }
    if (expr.callee.name === "@shape_tail") {
      if (!shapeArg) return foldedCall;
      return {
        ...shapeArg,
        slots: shapeArg.slots.slice(1).map((slot, position) => ({ ...slot, position })),
      };
    }
    if (expr.callee.name === "@shape_slot") {
      if (!shapeArg) return foldedCall;
      const key = args[1];
      if (key?.kind === "literal") {
        const label = key.value.replace(/^#/, "").replace(/^"|"$/g, "");
        const slot = shapeArg.slots.find((item) => item.label === label);
        if (slot) return slot.value;
      }
    }
    return foldedCall;
  }
  if (expr.kind !== "binary") return expr;
  const left = constFold(expr.left, ctx, seen);
  const right = constFold(expr.right, ctx, seen);
  const foldedBinary = left !== expr.left || right !== expr.right ? { ...expr, left, right } : expr;
  if (left.kind !== "literal" || right.kind !== "literal") return foldedBinary;
  if (left.literalKind !== "number" || right.literalKind !== "number") {
    return foldedBinary;
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

function shapeExprFromLayoutSlots(slots: ShapeTypeSlot[]): Extract<Expr, { kind: "shape" }> {
  return {
    kind: "shape",
    slots: slots.flatMap((slot, position) =>
      slot.label
        ? [{
          label: slot.label,
          position,
          value: { kind: "var", name: slot.type } as Expr,
        }]
        : []
    ),
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

function patternMatchesLiteral(
  pattern: MatchArm["pattern"],
  literal: Extract<Expr, { kind: "literal" }>,
): boolean {
  if (pattern.kind === "wildcard") return true;
  if (pattern.kind === "binding") return true;
  if (pattern.kind === "typed") return literalPatternMatches(pattern, literal);
  if (pattern.kind !== "literal") return false;
  return pattern.literalKind === literal.literalKind && pattern.value === literal.value;
}

function lowerLiteral(
  expr: Extract<Expr, { kind: "literal" }>,
  ctx: LowerContext,
  expectedType?: string,
): Instr[] {
  if (expectedType && (expr.literalKind === "number" || expr.literalKind === "bool")) {
    const flattened = flattenType(expectedType, ctx.layouts);
    if (flattened.length > 1) {
      const value = expr.literalKind === "bool"
        ? expr.value === "true" ? 1 : 0
        : Number.parseInt(expr.value, 10);
      return flattened.map((slot) => ({ op: "const", type: slot.wat, value }));
    }
  }
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
  if (expr.literalKind === "literalType") {
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
    const storageTarget = resolveInlineArrayStorageTarget(fieldTarget, locals) ?? fieldTarget;
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
  throw new Error(
    `backend only supports inline-array indexing in ${ctx.currentFn?.name ?? "<unknown>"}`,
  );
}

function indexedItemType(
  expr: Extract<Expr, { kind: "index" }>,
  ctx: LowerContext,
): string | undefined {
  const targetType = expr.target.kind === "var"
    ? varType(expr.target.name, ctx)
    : exprTypeWithLocals(expr.target, ctx);
  const arrayArgs = inlineArrayLikeTypeArgs(targetType, ctx.layouts);
  if (arrayArgs) return arrayArgs[1];
  const fieldTarget = fieldAccessName(expr.target);
  if (!fieldTarget) return undefined;
  const fieldType = exprTypeWithLocals(expr.target, ctx);
  const fieldArgs = inlineArrayLikeTypeArgs(fieldType, ctx.layouts);
  if (fieldArgs) return fieldArgs[1];
  return undefined;
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
  const localBases = [target.replaceAll(".", "$"), target];
  let capacity = 0;
  while (
    localBases.some((localBase) =>
      locals.has(`${localBase}$${capacity}`) ||
      [...locals].some((slot) => slot.startsWith(`${localBase}$${capacity}$`))
    )
  ) {
    capacity++;
  }
  return capacity;
}

function resolveInlineArrayStorageTarget(target: string, locals: Set<string>): string | undefined {
  if (inlineArrayCapacityFromLocals(target, locals) > 0) return target;
  const field = target.split(".").at(-1);
  if (!field) return undefined;
  const fieldSuffix = `$${field}`;
  for (const local of locals) {
    const match = local.match(/^(.*)\$0(?:\$|$)/);
    const base = match?.[1];
    if (base?.endsWith(fieldSuffix)) return base.replaceAll("$", ".");
  }
  return undefined;
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
  if (packed) {
    const cached = ctx.packedArrayReadCache?.get(packedArrayReadKeyForPlan(packed, index));
    if (cached) return [{ op: "local.get", name: cached }];
    return lowerPackedArrayLoad(packed, index, ctx, locals);
  }
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
      true,
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

function lowerPackedArrayInitFromExpr(
  plan: PackedArrayPlan,
  source: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const packed = Array.from({ length: plan.capacity }, (_, index) =>
    lowerPackedArraySlotValue(
      plan,
      lowerExpr(
        {
          kind: "index",
          target: source,
          index: staticIndexExpr(index),
        },
        ctx,
        locals,
        plan.itemType,
      ),
      index * plan.bitWidth,
      true,
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
  const isLastStaticLane = literal === plan.capacity - 1;
  return lowerPackedArrayValueToItem(
    plan,
    isLastStaticLane ? shifted : maskValue(shifted, plan.packedType, plan.bitWidth),
  );
}

function lowerPackedArrayStore(
  plan: PackedArrayPlan,
  index: Expr,
  value: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const adjacentCopy = lowerPackedArrayAdjacentCopyStore(plan, index, value, ctx, locals);
  if (adjacentCopy) {
    invalidatePackedArrayReadCache(plan, ctx);
    return adjacentCopy;
  }
  const cachedOldStore = lowerPackedArrayCachedOldStore(plan, index, value, ctx, locals);
  if (cachedOldStore) {
    invalidatePackedArrayReadCache(plan, ctx);
    return cachedOldStore;
  }
  ensureLoweringLocals(value, ctx, locals);
  const cachedIndex = cacheRepeatedIndex(index, ctx, locals);
  const shiftName = `__fixed_array_packed_shift${ctx.tempIndex++}`;
  const valueName = `__fixed_array_packed_value${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: shiftName, type: "i32" });
  ctx.tempLocals.push({ name: valueName, type: plan.packedType });
  locals.add(shiftName);
  locals.add(valueName);
  const mask = packedMaskInstr(plan.packedType, plan.bitWidth);
  invalidatePackedArrayReadCache(plan, ctx);
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

function lowerPackedArrayCachedOldStore(
  plan: PackedArrayPlan,
  index: Expr,
  value: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const cachedOld = ctx.packedArrayReadCache?.get(packedArrayReadKeyForPlan(plan, index));
  if (!cachedOld || !exprMentionsName(value, cachedOld)) return undefined;
  if (hasRuntimeEffect(value, ctx.functions)) return undefined;
  ensureLoweringLocals(value, ctx, locals);
  const cachedIndex = cacheRepeatedIndex(index, ctx, locals);
  return [
    ...cachedIndex.prefix,
    { op: "local.get", name: packedArrayLocalName(plan.name) },
    ...lowerPackedArrayValueToPacked(
      plan,
      [{ op: "local.get", name: cachedOld }],
      true,
    ),
    ...lowerPackedArrayValueToPacked(
      plan,
      lowerExpr(value, ctx, locals, plan.itemType),
      packedArrayValueAlreadyMasked(value, plan, ctx),
    ),
    { op: "binary", wasm: `${plan.packedType}.xor` },
    ...lowerExpr(cachedIndex.index, ctx, locals, "i32"),
    { op: "const", type: "i32", value: plan.bitWidth },
    { op: "binary", wasm: "i32.mul" },
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "binary", wasm: `${plan.packedType}.xor` },
    { op: "local.set", name: packedArrayLocalName(plan.name) },
  ];
}

function lowerPackedArrayAdjacentCopyStore(
  plan: PackedArrayPlan,
  index: Expr,
  value: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (value.kind !== "index" || value.target.kind !== "var") return undefined;
  if (!sameStorageName(value.target.name, plan.name)) return undefined;
  const indexOffset = indexOffsetFrom(value.index, index);
  if (!indexOffset) return undefined;
  const bitOffset = indexOffset * plan.bitWidth;
  const cachedIndex = cacheRepeatedIndex(index, ctx, locals);
  const shiftName = `__fixed_array_packed_shift${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: shiftName, type: "i32" });
  locals.add(shiftName);
  const shiftedSource: Instr[] = [
    { op: "local.get", name: packedArrayLocalName(plan.name) },
    { op: "const", type: "i32", value: Math.abs(bitOffset) },
    { op: "binary", wasm: `${plan.packedType}.${bitOffset > 0 ? "shr_u" : "shl"}` },
  ];
  return [
    ...cachedIndex.prefix,
    ...lowerExpr(cachedIndex.index, ctx, locals, "i32"),
    { op: "const", type: "i32", value: plan.bitWidth },
    { op: "binary", wasm: "i32.mul" },
    { op: "local.set", name: shiftName },
    { op: "local.get", name: packedArrayLocalName(plan.name) },
    { op: "const", type: plan.packedType, value: -1 },
    packedMaskInstr(plan.packedType, plan.bitWidth),
    { op: "local.get", name: shiftName },
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "binary", wasm: `${plan.packedType}.xor` },
    { op: "binary", wasm: `${plan.packedType}.and` },
    ...shiftedSource,
    packedMaskInstr(plan.packedType, plan.bitWidth),
    { op: "local.get", name: shiftName },
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "binary", wasm: `${plan.packedType}.and` },
    { op: "binary", wasm: `${plan.packedType}.or` },
    { op: "local.set", name: packedArrayLocalName(plan.name) },
  ];
}

function indexOffsetFrom(index: Expr, base: Expr): number | undefined {
  if (JSON.stringify(index) === JSON.stringify(base)) return 0;
  if (index.kind !== "binary") return undefined;
  const right = staticIntegerLiteral(index.right);
  if (right !== undefined && JSON.stringify(index.left) === JSON.stringify(base)) {
    return index.op === "+" ? right : index.op === "-" ? -right : undefined;
  }
  const left = staticIntegerLiteral(index.left);
  if (
    left !== undefined && index.op === "+" && JSON.stringify(index.right) === JSON.stringify(base)
  ) {
    return left;
  }
  return undefined;
}

function packedArrayReadKey(value: Expr, ctx: LowerContext): string | undefined {
  if (value.kind !== "index" || value.target.kind !== "var") return undefined;
  const plan = packedPlanForName(value.target.name, ctx.packedArrays);
  return plan ? packedArrayReadKeyForPlan(plan, value.index) : undefined;
}

function packedArrayReadKeyForPlan(plan: PackedArrayPlan, index: Expr): string {
  return `${plan.name}:${JSON.stringify(index)}`;
}

function invalidatePackedArrayReadCache(plan: PackedArrayPlan, ctx: LowerContext) {
  for (const key of ctx.packedArrayReadCache?.keys() ?? []) {
    if (key.startsWith(`${plan.name}:`)) ctx.packedArrayReadCache?.delete(key);
  }
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
  const cachedOld = ctx.packedArrayReadCache?.get(
    packedArrayReadKeyForPlan(plan, update.index),
  );
  const oldName = cachedOld ?? `__fixed_array_packed_old${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: shiftName, type: "i32" });
  if (!cachedOld) ctx.tempLocals.push({ name: oldName, type: plan.valueType });
  locals.add(shiftName);
  locals.add(oldName);
  const mask = packedMaskInstr(plan.packedType, plan.bitWidth);
  const updated = substituteExpr(
    rmw.value,
    new Map([[rmw.oldName, { kind: "var", name: oldName }]]),
  );
  const body: Instr[] = [
    ...cachedIndex.prefix,
    ...lowerExpr(cachedIndex.index, ctx, locals, "i32"),
    { op: "const", type: "i32", value: plan.bitWidth },
    { op: "binary", wasm: "i32.mul" },
    { op: "local.set", name: shiftName },
    ...(cachedOld ? [] : [
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
      { op: "local.set", name: oldName } as Instr,
    ]),
    { op: "local.get", name: packedArrayLocalName(plan.name) },
    ...lowerPackedArrayValueToPacked(
      plan,
      [{ op: "local.get", name: oldName }],
      true,
    ),
    ...lowerPackedArrayValueToPacked(
      plan,
      lowerExpr(updated, ctx, locals, plan.itemType),
      packedArrayValueAlreadyMasked(updated, plan, ctx),
    ),
    { op: "binary", wasm: `${plan.packedType}.xor` },
    { op: "local.get", name: shiftName },
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "binary", wasm: `${plan.packedType}.xor` },
    { op: "local.set", name: packedArrayLocalName(plan.name) },
  ];
  invalidatePackedArrayReadCache(plan, ctx);
  return body;
}

function lowerPackedArraySwapStore(
  plan: PackedArrayPlan,
  left: Expr,
  right: Expr,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  invalidatePackedArrayReadCache(plan, ctx);
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

interface PackedPrefixShiftLoopPlan {
  capacity: number;
  itemType: string;
  arrayParam: string;
  indexParam: string;
  limitParam: string;
  firstParam: string;
}

interface PackedPrefixShiftCallParts {
  capacity: number;
  itemType: string;
  source: Expr;
  limit: Expr;
  first: Expr;
}

function lowerPackedPrefixShiftCall(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (ctx.optMode !== "release") return undefined;
  const parts = packedPrefixShiftCallParts(expr, ctx);
  if (!parts) return undefined;
  const expectedArgs = inlineArrayLikeTypeArgs(expectedType, ctx.layouts);
  if (
    expectedArgs &&
    (expectedArgs[0] !== parts.capacity || expectedArgs[1] !== parts.itemType)
  ) {
    return undefined;
  }
  const resultPlan = packedArrayPlan(
    `__fixed_array_packed_prefix_shift${ctx.tempIndex++}`,
    parts.capacity,
    parts.itemType,
    ctx.layouts,
  );
  if (!resultPlan) return undefined;
  ctx.tempLocals.push({ name: packedArrayLocalName(resultPlan.name), type: resultPlan.packedType });
  locals.add(packedArrayLocalName(resultPlan.name));
  const lowered = lowerPackedPrefixShiftIntoPlan(expr, resultPlan, ctx, locals, parts);
  if (!lowered) return undefined;
  return [
    ...lowered,
    ...lowerPackedArrayMaterialize(resultPlan, ctx, locals),
  ];
}

function lowerPackedPrefixShiftIntoPlan(
  expr: Expr,
  target: PackedArrayPlan,
  ctx: LowerContext,
  locals: Set<string>,
  knownParts?: PackedPrefixShiftCallParts,
): Instr[] | undefined {
  const parts = knownParts ??
    (expr.kind === "call" ? packedPrefixShiftCallParts(expr, ctx) : undefined);
  if (!parts || parts.capacity !== target.capacity || parts.itemType !== target.itemType) {
    return undefined;
  }
  let sourcePlan = parts.source.kind === "var"
    ? packedPlanForName(parts.source.name, ctx.packedArrays)
    : undefined;
  if (
    sourcePlan &&
    (sourcePlan.capacity !== target.capacity ||
      sourcePlan.itemType !== target.itemType ||
      sourcePlan.packedType !== target.packedType ||
      sourcePlan.bitWidth !== target.bitWidth)
  ) {
    return undefined;
  }
  const sourceInit: Instr[] = [];
  if (!sourcePlan) {
    if (!packedPrefixShiftIndexableSource(parts.source)) return undefined;
    sourcePlan = packedArrayPlan(
      `__fixed_array_packed_prefix_source${ctx.tempIndex++}`,
      parts.capacity,
      parts.itemType,
      ctx.layouts,
    );
    if (!sourcePlan) return undefined;
    ctx.tempLocals.push({
      name: packedArrayLocalName(sourcePlan.name),
      type: sourcePlan.packedType,
    });
    locals.add(packedArrayLocalName(sourcePlan.name));
    sourceInit.push(...lowerPackedArrayInitFromExpr(sourcePlan, parts.source, ctx, locals));
  }

  if (hasRuntimeEffect(parts.first, ctx.functions)) return undefined;
  const shiftName = `__fixed_array_packed_shift${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: shiftName, type: "i32" });
  locals.add(shiftName);
  invalidatePackedArrayReadCache(target, ctx);
  const storageBits = target.packedType === "i64" ? 64 : 32;
  const sourcePackedName = packedArrayLocalName(sourcePlan.name);
  return [
    ...sourceInit,
    ...lowerExpr(parts.limit, ctx, locals, "i32"),
    { op: "const", type: "i32", value: target.bitWidth },
    { op: "binary", wasm: "i32.mul" },
    { op: "local.set", name: shiftName },
    ...lowerPackedPrefixShiftValue(
      target,
      sourcePackedName,
      shiftName,
      lowerPackedArrayValueToPacked(
        target,
        lowerExpr(parts.first, ctx, locals, target.itemType),
        packedArrayValueAlreadyMasked(parts.first, target, ctx),
      ),
      storageBits,
    ),
    { op: "local.set", name: packedArrayLocalName(target.name) },
  ];
}

function packedPrefixShiftIndexableSource(expr: Expr): boolean {
  return expr.kind === "var" || Boolean(fieldAccessName(expr));
}

function lowerPackedPrefixShiftBlockIntoPlan(
  block: BlockExpr,
  target: PackedArrayPlan,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (!block.expr || block.expr.kind !== "call") return undefined;
  const substitutions = new Map<string, Expr>();
  for (const stmt of block.statements) {
    if (stmt.kind !== "let" || hasRuntimeEffect(stmt.value, ctx.functions)) return undefined;
    substitutions.set(stmt.name, substitutePrefixShiftExpr(stmt.value, substitutions));
  }
  const expr = substitutePrefixShiftExpr(block.expr, substitutions);
  return expr.kind === "call"
    ? lowerPackedPrefixShiftIntoPlan(expr, target, ctx, locals)
    : undefined;
}

function lowerPackedPrefixShiftValue(
  plan: PackedArrayPlan,
  sourceName: string,
  shiftName: string,
  firstValue: Instr[],
  storageBits: number,
): Instr[] {
  const lowPart: Instr[] = [
    { op: "local.get", name: sourceName },
    { op: "const", type: "i32", value: plan.bitWidth },
    { op: "binary", wasm: `${plan.packedType}.shr_u` },
    { op: "const", type: plan.packedType, value: 1 },
    { op: "local.get", name: shiftName },
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "const", type: plan.packedType, value: 1 },
    { op: "binary", wasm: `${plan.packedType}.sub` },
    { op: "binary", wasm: `${plan.packedType}.and` },
  ];
  const firstPart: Instr[] = [
    ...firstValue,
    { op: "local.get", name: shiftName },
    { op: "binary", wasm: `${plan.packedType}.shl` },
  ];
  const endShiftValue: Instr[] = [
    { op: "local.get", name: shiftName },
    { op: "const", type: "i32", value: plan.bitWidth },
    { op: "binary", wasm: "i32.add" },
  ];
  const computedHighPart: Instr[] = [
    { op: "local.get", name: sourceName },
    { op: "const", type: plan.packedType, value: -1 },
    ...endShiftValue,
    { op: "binary", wasm: `${plan.packedType}.shl` },
    { op: "binary", wasm: `${plan.packedType}.and` },
  ];
  const totalBits = plan.capacity * plan.bitWidth;
  const highPart: Instr[] = totalBits < storageBits ? computedHighPart : [
    { op: "const", type: plan.packedType, value: 0 },
    ...computedHighPart,
    ...endShiftValue,
    { op: "const", type: "i32", value: storageBits },
    { op: "binary", wasm: "i32.eq" },
    { op: "select", type: plan.packedType },
  ];
  return [
    ...lowPart,
    ...firstPart,
    { op: "binary", wasm: `${plan.packedType}.or` },
    ...highPart,
    { op: "binary", wasm: `${plan.packedType}.or` },
  ];
}

function packedPrefixShiftCallParts(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  depth = 0,
): PackedPrefixShiftCallParts | undefined {
  if (depth > 2 || expr.callee.kind !== "var") return undefined;
  const callee = ctx.functions.get(expr.callee.name);
  if (!callee || isCurrentModulePublic(callee) || callee.params.some((param) => param.const)) {
    return undefined;
  }
  if (!callee.returnType) return undefined;
  const direct = packedPrefixShiftLoopPlan(callee, ctx);
  const argOffset = Math.max(0, expr.args.length - callee.params.length);
  const runtimeArgs = expr.args.slice(argOffset);
  if (runtimeArgs.length !== callee.params.length) return undefined;
  if (direct) return packedPrefixShiftPartsFromLoopCall(direct, callee, runtimeArgs);
  if (!callee.body.expr || callee.body.expr.kind !== "call") return undefined;
  const substitutions = new Map<string, Expr>();
  callee.params.forEach((param, index) => {
    const arg = runtimeArgs[index];
    if (arg) substitutions.set(param.name, arg);
  });
  for (const stmt of callee.body.statements) {
    if (stmt.kind !== "let") return undefined;
    if (hasRuntimeEffect(stmt.value, ctx.functions)) return undefined;
    substitutions.set(stmt.name, substitutePrefixShiftExpr(stmt.value, substitutions));
  }
  const lowered = substitutePrefixShiftExpr(callee.body.expr, substitutions);
  return lowered.kind === "call" ? packedPrefixShiftCallParts(lowered, ctx, depth + 1) : undefined;
}

function substitutePrefixShiftExpr(expr: Expr, substitutions: Map<string, Expr>): Expr {
  if (expr.kind === "var") {
    const exact = substitutions.get(expr.name);
    if (exact) return exact;
    const indexed = expr.name.match(/^(.+)\[([0-9]+)\]$/);
    const target = indexed ? substitutions.get(indexed[1] ?? "") : undefined;
    if (indexed && target) {
      return {
        kind: "index",
        target,
        index: staticIndexExpr(Number.parseInt(indexed[2] ?? "0", 10)),
      };
    }
  }
  return substituteExpr(expr, substitutions);
}

function packedPrefixShiftPartsFromLoopCall(
  plan: PackedPrefixShiftLoopPlan,
  fn: FnDecl,
  runtimeArgs: Expr[],
): PackedPrefixShiftCallParts | undefined {
  const paramIndex = new Map(fn.params.map((param, index) => [param.name, index]));
  const initial = runtimeArgs[paramIndex.get(plan.indexParam) ?? -1];
  if (staticIntegerLiteral(initial) !== 0) return undefined;
  const source = runtimeArgs[paramIndex.get(plan.arrayParam) ?? -1];
  const limit = runtimeArgs[paramIndex.get(plan.limitParam) ?? -1];
  const first = runtimeArgs[paramIndex.get(plan.firstParam) ?? -1];
  if (!source || !limit || !first) return undefined;
  return { capacity: plan.capacity, itemType: plan.itemType, source, limit, first };
}

function packedPrefixShiftLoopPlan(
  fn: FnDecl,
  ctx: LowerContext,
): PackedPrefixShiftLoopPlan | undefined {
  const [capacity, itemType] = inlineArrayLikeTypeArgs(fn.returnType, ctx.layouts) ?? [];
  if (
    !capacity || !itemType ||
    !packedArrayPlan(fn.params[0]?.name ?? "", capacity, itemType, ctx.layouts)
  ) {
    return undefined;
  }
  if (fn.body.statements.length !== 0 || !fn.body.expr || fn.body.expr.kind !== "match") {
    return undefined;
  }
  if (fn.body.expr.arms.some((arm) => arm.guard)) return undefined;
  const condition = fn.body.expr.value;
  if (condition.kind !== "binary" || condition.op !== "<") return undefined;
  if (condition.left.kind !== "var" || condition.right.kind !== "var") return undefined;
  const indexParam = condition.left.name;
  const limitParam = condition.right.name;
  const recursiveArm = fn.body.expr.arms.find((arm) =>
    isTrueLikePattern(arm.pattern) && arm.value.kind === "call" &&
    arm.value.callee.kind === "var" && arm.value.callee.name === fn.name
  );
  const doneArm = fn.body.expr.arms.find((arm) => arm !== recursiveArm);
  if (!recursiveArm || !doneArm || recursiveArm.value.kind !== "call") return undefined;
  const recursiveCall = recursiveArm.value;
  const argOffset = Math.max(0, recursiveCall.args.length - fn.params.length);
  const recursiveArgs = recursiveCall.args.slice(argOffset);
  if (recursiveArgs.length !== fn.params.length) return undefined;
  const paramIndex = new Map(fn.params.map((param, index) => [param.name, index]));
  const arrayParam = fn.params.find((param) =>
    sameInlineArrayType(param.type, fn.returnType, ctx.layouts)
  )?.name;
  if (!arrayParam) return undefined;
  const arrayIndex = paramIndex.get(arrayParam);
  const indexIndex = paramIndex.get(indexParam);
  const limitIndex = paramIndex.get(limitParam);
  if (arrayIndex === undefined || indexIndex === undefined || limitIndex === undefined) {
    return undefined;
  }
  const update = fixedArrayUpdateCall(recursiveArgs[arrayIndex]!, ctx);
  if (!update || update.source.name !== arrayParam) return undefined;
  if (!isVarNamed(update.index, indexParam)) return undefined;
  if (!isAdjacentIndexRead(update.value, arrayParam, indexParam, 1)) return undefined;
  if (!isIncrementByOne(recursiveArgs[indexIndex]!, indexParam)) return undefined;
  if (!isVarNamed(recursiveArgs[limitIndex]!, limitParam)) return undefined;
  const done = fixedArrayUpdateCall(doneArm.value, ctx);
  if (!done || done.source.name !== arrayParam || !isVarNamed(done.index, limitParam)) {
    return undefined;
  }
  if (done.capacity !== capacity || done.itemType !== itemType) return undefined;
  if (update.capacity !== capacity || update.itemType !== itemType) return undefined;
  const firstParam = fn.params.find((param, index) =>
    index !== arrayIndex && index !== indexIndex && index !== limitIndex &&
    isVarNamed(recursiveArgs[index]!, param.name) && isVarNamed(done.value, param.name)
  )?.name;
  if (!firstParam) return undefined;
  return { capacity, itemType, arrayParam, indexParam, limitParam, firstParam };
}

function isTrueLikePattern(pattern: ParamPattern): boolean {
  if (pattern.kind === "typed") return isTrueLikePattern(pattern.pattern);
  return (pattern.kind === "literal" && pattern.value === "true") ||
    (pattern.kind === "type" && pattern.name === "true");
}

function isFalseLikePattern(pattern: ParamPattern): boolean {
  if (pattern.kind === "typed") return isFalseLikePattern(pattern.pattern);
  return (pattern.kind === "literal" && pattern.value === "false") ||
    (pattern.kind === "type" && pattern.name === "false");
}

function isVarNamed(expr: Expr | undefined, name: string): boolean {
  return expr?.kind === "var" && expr.name === name;
}

function isIncrementByOne(expr: Expr, name: string): boolean {
  return expr.kind === "binary" && expr.op === "+" &&
    ((isVarNamed(expr.left, name) && staticIntegerLiteral(expr.right) === 1) ||
      (isVarNamed(expr.right, name) && staticIntegerLiteral(expr.left) === 1));
}

function isAdjacentIndexRead(
  expr: Expr,
  source: string,
  indexName: string,
  offset: number,
): boolean {
  return expr.kind === "index" && isVarNamed(expr.target, source) &&
    indexOffsetFrom(expr.index, { kind: "var", name: indexName }) === offset;
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
  alreadyMasked = false,
): Instr[] {
  const packed = lowerPackedArrayValueToPacked(plan, value, alreadyMasked);
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
  const literal = staticIntegerLiteral(value);
  if (literal !== undefined && literal >= 0 && literal < 2 ** plan.bitWidth) return true;
  if (value.kind === "var") {
    return narrowUnsignedTypeFits(exprTypeWithLocals(value, ctx), plan.bitWidth, ctx.layouts);
  }
  if (value.kind === "index" && value.target.kind === "var") {
    const source = packedPlanForName(value.target.name, ctx.packedArrays);
    return Boolean(
      source &&
        source.bitWidth === plan.bitWidth &&
        source.valueType === plan.valueType &&
        source.packedType === plan.packedType,
    );
  }
  return false;
}

function narrowUnsignedTypeFits(
  type: string | undefined,
  bitWidth: number,
  layouts: LayoutEnv,
): boolean {
  const resolved = resolveAlias(type, layouts);
  if (resolved === "bool") return bitWidth >= 1;
  const width = resolved ? unsignedBitWidth(resolved) : undefined;
  return width !== undefined && width <= bitWidth;
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
  const updateExpr = expr.kind === "block" && expr.expr ? expr.expr : expr;
  const update = fixedArraySpreadUpdateShape(updateExpr);
  if (!update) return undefined;
  const args = inlineArrayTypeArgs(expectedType, ctx.layouts);
  if (!args) return undefined;
  const [capacity, itemType] = args;
  const itemSlots = flattenType(itemType, ctx.layouts);
  if (itemSlots.length !== 1 || !isSelectableValueType(itemSlots[0]?.wat)) return undefined;
  const value = expr.kind === "block" ? { ...expr, expr: update.value } : update.value;
  return {
    source: update.source,
    index: update.index,
    value,
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
  const direct = ctx.localTypes?.get(name);
  if (direct) return direct;
  const projection = projectionSuffix(name);
  if (projection) {
    const projected = projectedLocalType(baseName(name), projection, ctx);
    if (projected) return projected;
  }
  const [base, ...fields] = name.split(".");
  let current = ctx.localTypes?.get(baseName(base));
  for (const field of fields) {
    const slot = productSlotsForType(current, ctx.layouts)?.find((slot) => slot.label === field);
    current = slot?.type;
  }
  return current;
}

function projectedLocalType(
  base: string,
  projection: string,
  ctx: LowerContext,
): string | undefined {
  let current = ctx.localTypes?.get(base);
  if (!current) return undefined;
  for (const part of projection.split("$")) {
    const slots = productSlotsForType(current, ctx.layouts);
    if (!slots) return undefined;
    let matched = slots.find((slot, index) => {
      if (slot.label === part) return true;
      if (String(slot.position ?? index) === part) return true;
      return false;
    });
    if (!matched && /^[0-9]+$/.test(part)) {
      const position = Number.parseInt(part, 10);
      let offset = 0;
      for (const slot of slots) {
        const repeat = slot.repeat ? Number.parseInt(slot.repeat, 10) : 1;
        if (position >= offset && position < offset + repeat) {
          matched = slot;
          break;
        }
        offset += repeat;
      }
    }
    if (!matched) return undefined;
    current = matched.type;
  }
  return current;
}

function productFieldTypes(
  type: string | undefined,
  layouts: LayoutEnv,
): { label: string; type: string }[] | undefined {
  const slots = productSlotsForType(type, layouts);
  if (!slots) return undefined;
  const fields: { label: string; type: string }[] = [];
  for (const [index, slot] of slots.entries()) {
    if (slot.repeat) return undefined;
    fields.push({
      label: slot.label ?? String(index),
      type: slot.type,
    });
  }
  return fields;
}

function productSlotsForType(
  type: string | undefined,
  layouts: LayoutEnv,
): ShapeTypeSlot[] | undefined {
  const original = stripReferenceType(type);
  const resolved = resolveAlias(original, layouts) ?? original;
  const declSource = original ?? resolved;
  if (!declSource) return undefined;
  const heapArraySlots = heapArrayProductSlotsForType(declSource);
  if (heapArraySlots) return heapArraySlots;
  const directShape = constShapeFromTypeArg(declSource, layouts);
  if (directShape) {
    return directShape.slots.map((slot) => ({
      label: slot.label,
      position: slot.position,
      type: staticShapeSlotType(slot.value) ?? "i32",
    }));
  }
  const directStructArgs = typeCallArgs(declSource, "struct");
  if (directStructArgs) {
    const shape = constShapeFromTypeArg(directStructArgs, layouts);
    if (shape) {
      return shape.slots.map((slot) => ({
        label: slot.label,
        position: slot.position,
        type: staticShapeSlotType(slot.value) ?? "i32",
      }));
    }
    const inner = directStructArgs.trim();
    if (compactTypeSource(inner) !== compactTypeSource(declSource)) {
      const nested = productSlotsForType(inner, layouts);
      if (nested) return nested;
    }
  }
  const trailingArg = trailingTypeCallArg(declSource);
  if (
    trailingArg &&
    !layouts.types.has(typeName(declSource)) &&
    splitTypeArgs(trailingArg).length === 1 &&
    compactTypeSource(trailingArg) !== compactTypeSource(declSource)
  ) {
    const trailingSlots = productSlotsForType(trailingArg, layouts);
    if (trailingSlots) return trailingSlots;
  }
  const decl = layouts.types.get(typeName(declSource));
  if (decl) {
    const args = typeCallArgs(declSource, typeName(declSource)) ??
      (resolved ? typeCallArgs(resolved, typeName(resolved)) : undefined);
    const argValues = args ? splitTypeArgs(args) : [];
    if (decl.normalized?.kind === "product") {
      return decl.normalized.shape.slots.map((slot) => ({
        ...slot,
        type: substituteAliasTypeParams(slot.type, decl, argValues),
        repeat: slot.repeat ? substituteAliasTypeParams(slot.repeat, decl, argValues) : undefined,
      }));
    }
    if (decl.body.kind === "type_block") {
      const slots = productSlotsFromTypeBlock(decl, declSource, argValues, layouts);
      if (slots) return slots;
    }
  }
  const resolvedStructArgs =
    resolved && compactTypeSource(resolved) !== compactTypeSource(declSource)
      ? typeCallArgs(resolved, "struct")
      : undefined;
  if (!resolvedStructArgs) return undefined;
  const shape = constShapeFromTypeArg(resolvedStructArgs, layouts);
  if (shape) {
    return shape.slots.map((slot) => ({
      label: slot.label,
      position: slot.position,
      type: staticShapeSlotType(slot.value) ?? "i32",
    }));
  }
  return productSlotsForType(resolvedStructArgs.trim(), layouts);
}

function heapArrayProductSlotsForType(type: string): ShapeTypeSlot[] | undefined {
  const args = typeCallArgs(type, "HeapArray");
  if (args === undefined) return undefined;
  return [
    { label: "ptr", position: 0, type: "i32" },
    { label: "len", position: 1, type: "i32" },
    { label: "cap", position: 2, type: "i32" },
  ];
}

function productSlotsFromTypeBlock(
  decl: TypeDecl,
  source: string,
  argValues: string[],
  layouts: LayoutEnv,
): ShapeTypeSlot[] | undefined {
  if (decl.body.kind !== "type_block") return undefined;
  const bindings = typeParamBindings(decl, argValues);
  const shapes = new Map<string, ShapeTypeSlot[]>();
  for (const stmt of decl.body.statements) {
    if (stmt.kind !== "type_let") continue;
    const shape = evalTypeShapeExpr(stmt.value, layouts, shapes, bindings);
    if (shape) shapes.set(stmt.name, shape);
  }
  const expr = decl.body.expr;
  if (!expr) return undefined;
  if (expr.kind === "type_call") {
    if (
      expr.callee.kind === "type_ref" && expr.callee.name === "struct" &&
      expr.args.length === 1
    ) {
      const key = typeShapeRefName(expr.args[0]!, bindings);
      if (key) return shapes.get(key);
    }
    const rendered = renderBackendTypeExprWithBindings(expr, bindings);
    if (rendered && rendered !== source) return productSlotsForType(rendered, layouts);
  }
  if (expr.kind === "type_shape" && expr.shape.slots.length === 0) {
    const namedShape = shapes.get(decl.name);
    if (namedShape) return namedShape;
  }
  if (expr.kind === "type_shape") {
    const slots = typeShapeSlots(expr.shape.slots, bindings);
    return slots.length ? slots : undefined;
  }
  if (expr.kind === "type_match") {
    const value = evalBackendTypeBool(expr.value, layouts, shapes, bindings);
    const arm = expr.arms.find((candidate) =>
      candidate.pattern.kind === "bool" && candidate.pattern.value === value
    );
    if (!arm) return undefined;
    if (
      arm.value.kind === "type_call" &&
      arm.value.callee.kind === "type_ref" &&
      arm.value.callee.name === "struct" &&
      arm.value.args.length === 1
    ) {
      const key = typeShapeRefName(arm.value.args[0]!, bindings);
      if (key) return shapes.get(key);
    }
    const rendered = renderBackendTypeExprWithBindings(arm.value, bindings);
    if (rendered && rendered !== source) return productSlotsForType(rendered, layouts);
  }
  return undefined;
}

function evalBackendTypeBool(
  expr: TypeExpr,
  layouts: LayoutEnv,
  shapes: Map<string, ShapeTypeSlot[]>,
  bindings: Map<string, string>,
): boolean | undefined {
  if (expr.kind === "type_bool") return expr.value;
  if (expr.kind !== "type_call" || expr.callee.kind !== "type_static_ref") return undefined;
  if (expr.callee.name === "type_has_slot" && expr.args.length === 2) {
    const type = renderBackendTypeExprWithBindings(expr.args[0]!, bindings);
    const label = expr.args[1]?.kind === "type_literal" ? expr.args[1].value : undefined;
    return Boolean(
      type && label && productSlotsForType(type, layouts)?.some((slot) => slot.label === label),
    );
  }
  if (expr.callee.name === "type_is_product" && expr.args.length === 1) {
    const type = renderBackendTypeExprWithBindings(expr.args[0]!, bindings);
    return Boolean(type && productSlotsForType(type, layouts));
  }
  if (expr.callee.name === "require" && expr.args.length >= 1) {
    return evalBackendTypeBool(expr.args[0]!, layouts, shapes, bindings);
  }
  if (expr.callee.name === "shape_count" && expr.args.length === 1) {
    return Boolean(evalTypeShapeExpr(expr.args[0]!, layouts, shapes, bindings)?.length);
  }
  return undefined;
}

function evalTypeShapeExpr(
  expr: TypeExpr,
  layouts: LayoutEnv,
  shapes: Map<string, ShapeTypeSlot[]>,
  bindings: Map<string, string>,
): ShapeTypeSlot[] | undefined {
  if (expr.kind === "type_shape") return typeShapeSlots(expr.shape.slots, bindings);
  if (expr.kind === "type_ref") {
    const bound = bindings.get(expr.name);
    if (bound) return constShapeSlots(bound, layouts);
    return shapes.get(expr.name) ?? constShapeSlots(expr.name, layouts);
  }
  if (expr.kind !== "type_call" || expr.callee.kind !== "type_static_ref") return undefined;
  if (expr.callee.name === "type_slots" && expr.args.length === 1) {
    const type = renderBackendTypeExprWithBindings(expr.args[0], bindings);
    return productSlotsForType(type, layouts);
  }
  if (expr.callee.name === "shape_concat") {
    const slots = expr.args.flatMap((arg) =>
      evalTypeShapeExpr(arg, layouts, shapes, bindings) ?? []
    );
    return slots.length ? slots : undefined;
  }
  if (expr.callee.name === "shape_map" && expr.args.length === 2) {
    const source = evalTypeShapeExpr(expr.args[0]!, layouts, shapes, bindings);
    if (!source) return undefined;
    return source.map((slot) => ({
      label: slot.label,
      position: slot.position,
      type: applyTypeMapper(expr.args[1]!, slot.type, bindings),
      repeat: slot.repeat,
    }));
  }
  return undefined;
}

function constShapeSlots(source: string, layouts: LayoutEnv): ShapeTypeSlot[] | undefined {
  const shape = constShapeFromTypeArg(source, layouts);
  return shape?.slots.map((slot) => ({
    label: slot.label,
    position: slot.position,
    type: staticShapeSlotType(slot.value) ?? "i32",
  }));
}

function typeShapeSlots(
  slots: import("./core_ast.ts").TypeShapeSlot[],
  bindings: Map<string, string>,
): ShapeTypeSlot[] {
  return slots.map((slot) => ({
    label: slot.label,
    position: slot.position,
    type: renderBackendTypeExprWithBindings(slot.type, bindings) ?? "i32",
    repeat: slot.repeat
      ? substituteTypeBindings(renderBackendCountExpr(slot.repeat), bindings)
      : undefined,
  }));
}

function applyTypeMapper(
  mapper: TypeExpr,
  itemType: string,
  bindings: Map<string, string>,
): string {
  if (mapper.kind === "type_ref") return `${mapper.name}(${itemType})`;
  if (mapper.kind === "type_call") {
    const callee = renderBackendTypeExprWithBindings(mapper.callee, bindings);
    const args = mapper.args
      .map((arg) => renderBackendTypeExprWithBindings(arg, bindings))
      .filter((arg): arg is string => Boolean(arg));
    return `${callee}(${[...args, itemType].join(", ")})`;
  }
  return itemType;
}

function typeParamBindings(decl: TypeDecl, argValues: string[]): Map<string, string> {
  const bindings = new Map<string, string>();
  const prefix = decl.name.includes(".") ? decl.name.slice(0, decl.name.lastIndexOf(".")) : "";
  for (const [index, param] of decl.params.entries()) {
    const value = argValues[index];
    if (!value) continue;
    bindings.set(param.name, value);
    if (prefix) bindings.set(`${prefix}.${param.name}`, value);
  }
  return bindings;
}

function typeShapeRefName(expr: TypeExpr, bindings: Map<string, string>): string | undefined {
  return expr.kind === "type_ref" ? bindings.get(expr.name) ?? expr.name : undefined;
}

function renderBackendTypeExprWithBindings(
  expr: TypeExpr,
  bindings: Map<string, string>,
): string | undefined {
  if (expr.kind === "type_ref") return bindings.get(expr.name) ?? expr.name;
  if (expr.kind === "type_static_ref") return `@${expr.name}`;
  if (expr.kind === "type_number") return expr.value;
  if (expr.kind === "type_literal") return `#${expr.value}`;
  if (expr.kind === "type_string") return JSON.stringify(expr.value);
  if (expr.kind === "type_char") {
    return `'${expr.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (expr.kind === "type_bool") return expr.value ? "true" : "false";
  if (expr.kind === "type_call") {
    const callee = renderBackendTypeExprWithBindings(expr.callee, bindings);
    const args = expr.args.map((arg) => renderBackendTypeExprWithBindings(arg, bindings));
    if (!callee || args.some((arg) => arg === undefined)) return undefined;
    return `${callee}(${args.join(", ")})`;
  }
  return renderBackendTypeExpr(expr);
}

function substituteTypeBindings(source: string, bindings: Map<string, string>): string {
  let result = source;
  for (const [name, value] of bindings) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"), value);
  }
  return result;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flattenedTypesMatch(
  actual: string | undefined,
  expected: string | undefined,
  layouts: LayoutEnv,
): boolean {
  if (!actual || !expected) return false;
  if (compactTypeSource(actual) === compactTypeSource(expected)) return true;
  const actualSlots = flattenType(actual, layouts);
  const expectedSlots = flattenType(expected, layouts);
  if (actualSlots.length !== expectedSlots.length) return false;
  return actualSlots.every((slot, index) => {
    const expectedSlot = expectedSlots[index];
    return expectedSlot &&
      slot.wat === expectedSlot.wat &&
      (resolveAlias(slot.type, layouts) ?? slot.type) ===
        (resolveAlias(expectedSlot.type, layouts) ?? expectedSlot.type);
  });
}

function compactTypeSource(type: string): string {
  return type.replace(/\s+/g, "");
}

function renderBackendTypeExpr(expr: import("./core_ast.ts").TypeExpr): string {
  switch (expr.kind) {
    case "type_ref":
      return expr.name;
    case "type_hole":
      return "_";
    case "type_static_ref":
      return `@${expr.name}`;
    case "type_fn":
      return expr.source;
    case "type_call":
      return `${renderBackendTypeExpr(expr.callee)}(${
        expr.args.map(renderBackendTypeExpr).join(", ")
      })`;
    case "type_shape":
      return `{${
        expr.shape.slots.map((slot) =>
          `${slot.label ? `${slot.label}: ` : ""}${renderBackendTypeExpr(slot.type)}`
        ).join(", ")
      }}`;
    case "type_members":
      return renderBackendTypeExpr(expr.target);
    case "type_match":
      return "i32";
    case "type_binary":
      return `${renderBackendTypeExpr(expr.left)} ${expr.op} ${renderBackendTypeExpr(expr.right)}`;
    case "type_scalar_domain":
      return `${expr.carrier}(${
        expr.members.map((member) => {
          const start = member.start.source;
          const end = member.end?.source;
          return end ? `${start}..${end}` : start;
        }).join(" | ")
      })`;
    case "type_bool":
      return String(expr.value);
    case "type_number":
      return expr.value;
    case "type_char":
      return `'${expr.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "type_string":
      return JSON.stringify(expr.value);
    case "type_literal":
      return `#${expr.value}`;
  }
}

function renderBackendCountExpr(expr: import("./core_ast.ts").TypeCountExpr): string {
  switch (expr.kind) {
    case "count_literal":
      return expr.source;
    case "count_ref":
      return expr.name;
    case "count_mul":
      return `${renderBackendCountExpr(expr.left)}*${renderBackendCountExpr(expr.right)}`;
  }
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
          if (stmt.kind === "let" || stmt.kind === "destructure_let") visit(stmt.value);
          else if (stmt.kind === "debug_trace") stmt.args.forEach(visit);
        }
        visit(item.expr);
        return;
      case "literal":
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

function productConstructorResultType(
  expr: Extract<Expr, { kind: "product_constructor" }>,
  ctx: LowerContext,
): string | undefined {
  const constructor = terminalName(expr.constructor);
  for (const decl of ctx.layouts.types.values()) {
    if (decl.normalized?.kind !== "product") continue;
    if (terminalName(decl.normalized.constructor) !== constructor) continue;
    if (decl.params.length === 0) return decl.name;
    const bindings = new Map<string, string>();
    for (let index = 0; index < expr.slots.length; index++) {
      const source = expr.slots[index]!;
      const expected = findLastSlot(
        decl.normalized.shape.slots,
        (slot, slotIndex) => (slot.label ?? String(slotIndex)) === (source.label ?? String(index)),
      )?.type;
      const actual = exprRuntimeTypeWithLiteralDefault(source.value, ctx);
      bindRuntimeTypePattern(expected, actual, bindings);
    }
    const args: string[] = [];
    let complete = true;
    for (const param of decl.params) {
      const value = bindings.get(param.name);
      if (!value) {
        complete = false;
        break;
      }
      args.push(value);
    }
    return complete ? `${decl.name}(${args.join(", ")})` : decl.name;
  }
  return undefined;
}

function constructorResultType(
  constructor: string,
  expectedType: string | undefined,
  layouts: LayoutEnv,
): string | undefined {
  if (
    expectedType &&
    sumLayoutForType(expectedType, layouts)?.variants.some((variant) =>
      terminalName(variant.name) === terminalName(constructor)
    )
  ) {
    return expectedType;
  }
  if (expectedType) {
    const resolved = resolveAlias(expectedType, layouts) ?? expectedType;
    const decl = layouts.types.get(typeName(resolved));
    if (
      decl?.normalized?.kind === "product" &&
      terminalName(decl.normalized.constructor) === terminalName(constructor)
    ) {
      return expectedType;
    }
  }
  const product = productConstructorType(constructor, layouts);
  if (product) return product;
  const found = [...layouts.types.values()].find((decl) =>
    decl.normalized?.kind === "sum" &&
    decl.normalized.variants.some((variant) =>
      terminalName(variant.name) === terminalName(constructor)
    )
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
        return [staticCountValue(count, layouts), itemType];
      }
    }
    return undefined;
  }
  const [count, itemType] = splitTypeArgs(args);
  return [staticCountValue(count ?? "0", layouts), itemType?.trim() ?? "i32"];
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
      typeCallArgs(unqualified, "InlineArrayBuilder");
    if (args) break;
  }
  if (!args) return undefined;
  const [count, itemType] = splitTypeArgs(args);
  return [staticCountValue(count ?? "0", layouts), itemType?.trim() ?? "i32"];
}

function staticCountValue(source: string, layouts: LayoutEnv): number {
  const trimmed = source.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return layouts.constNumbers.get(trimmed) ?? Number.NaN;
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
  if (name.includes("$") && locals.has(name)) return [{ op: "local.get", name }];
  const base = baseName(name);
  const projection = projectionSuffix(name);
  const exactConst = ctx.layouts.constRuntimeValues.get(name);
  if (exactConst) {
    return lowerExpr(
      exactConst,
      ctx,
      locals,
      expectedType ?? ctx.layouts.constRuntimeTypes.get(name),
    );
  }
  if (projection) {
    const baseConst = ctx.layouts.constRuntimeValues.get(base);
    const projectedConst = baseConst ? projectConstRuntimeValue(baseConst, projection) : undefined;
    if (projectedConst) return lowerExpr(projectedConst, ctx, locals, expectedType);
  }
  if (ctx.layouts.topLevelValues.has(name)) {
    return flattenType(expectedType, ctx.layouts).map((slot): Instr => ({
      op: "const",
      type: slot.wat,
      value: 0,
    }));
  }
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
    const unwrappedProjected = flattenType(expectedType, layouts).map((slot) =>
      slot.suffix ? `${base}$${slot.suffix}` : base
    ).filter((slot) => locals.has(slot));
    const fallback = projected.length
      ? projected
      : unwrappedProjected.length
      ? unwrappedProjected
      : prefixed;
    return (fallback.length ? fallback : [direct]).map((slot) => ({
      op: "local.get",
      name: slot,
    }));
  }
  const slots = flattenType(expectedType ?? varType(name, ctx), layouts).map((slot) =>
    slot.suffix ? `${base}$${slot.suffix}` : base
  );
  let present = slots.filter((slot) => locals.has(slot));
  if (!present.length) {
    const localType = varType(name, ctx);
    if (localType && localType !== expectedType) {
      present = flattenType(localType, layouts).map((slot) =>
        slot.suffix ? `${base}$${slot.suffix}` : base
      ).filter((slot) => locals.has(slot));
    }
  }
  return (present.length ? present : [base]).map((slot) => ({ op: "local.get", name: slot }));
}

function projectConstRuntimeValue(expr: Expr, projection: string): Expr | undefined {
  const [head, ...tail] = projection.split("$");
  if (!head) return expr;
  if (expr.kind !== "shape" && expr.kind !== "product_constructor") return undefined;
  const slot = expr.slots.findLast((item) => item.label === head);
  if (!slot) return undefined;
  return tail.length ? projectConstRuntimeValue(slot.value, tail.join("$")) : slot.value;
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
        const slot = findLastSlot(
          slots,
          (item, index) => (item.label ?? String(index)) === lane.suffix,
        );
        return slot ? lowerExpr(slot.value, ctx, locals, lane.type) : [];
      });
    }
    const slotTypes = shapeSlotTypes(expectedType, ctx.layouts);
    const useFlattenedSlotTypes = layout.length === slots.length;
    return slots.flatMap((slot, index) => {
      let slotType = slotTypes[index];
      if (useFlattenedSlotTypes) {
        slotType = layout[index]?.type ?? slotType;
      }
      return lowerExpr(slot.value, ctx, locals, slotType);
    });
  }
  return layout.flatMap((lane) => {
    if (!lane.fields?.length) return [];
    if (lane.fields.length === 1) {
      const field = lane.fields[0];
      const slot = findLastSlot(
        slots,
        (item, index) => (item.label ?? String(index)) === field.name,
      );
      return slot ? lowerExpr(slot.value, ctx, locals, field.type) : [];
    }
    const wat = lane.wat;
    return lane.fields.flatMap((field, index) => {
      const slot = findLastSlot(
        slots,
        (item, itemIndex) => (item.label ?? String(itemIndex)) === field.name,
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

function lowerSumConstructor(
  expr: Extract<Expr, { kind: "product_constructor" }>,
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const sum = sumLayoutForType(expectedType, ctx.layouts);
  if (!sum) return undefined;
  const variant = sum.variants.find((item) =>
    terminalName(item.name) === terminalName(expr.constructor)
  );
  if (!variant) return undefined;
  const payload: Instr[] = [];
  for (let index = 0; index < variant.slots.length; index++) {
    const variantSlot = variant.slots[index]!;
    const source = findLastSlot(
      expr.slots,
      (slot, slotIndex) =>
        (slot.label ?? String(slotIndex)) === (variantSlot.label ?? String(index)),
    );
    if (source) {
      payload.push(...lowerExpr(source.value, ctx, locals, variantSlot.type));
      continue;
    }
    for (const flat of flattenType(variantSlot.type, ctx.layouts)) {
      payload.push({ op: "const", type: flat.wat, value: 0 });
    }
  }
  const missing = sum.payloadSlots.length - variant.flatSlots.length;
  for (let index = 0; index < missing; index++) {
    const slot = sum.payloadSlots[variant.flatSlots.length + index];
    payload.push({ op: "const", type: slot?.wat ?? "i32", value: 0 });
  }
  return [
    { op: "const", type: "i32", value: variant.tag },
    ...payload,
  ];
}

function lowerSumVariantValue(
  constructor: string,
  args: Expr[],
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const sum = sumLayoutForType(expectedType, ctx.layouts);
  if (!sum) return undefined;
  const variant = sum.variants.find((item) =>
    terminalName(item.name) === terminalName(constructor)
  );
  if (!variant) return undefined;
  const payload: Instr[] = [];
  for (let index = 0; index < variant.slots.length; index++) {
    const variantSlot = variant.slots[index]!;
    const value = args[index];
    if (value) {
      payload.push(...lowerExpr(value, ctx, locals, variantSlot.type));
      continue;
    }
    for (const flat of flattenType(variantSlot.type, ctx.layouts)) {
      payload.push({ op: "const", type: flat.wat, value: 0 });
    }
  }
  const missing = sum.payloadSlots.length - variant.flatSlots.length;
  for (let index = 0; index < missing; index++) {
    const slot = sum.payloadSlots[variant.flatSlots.length + index];
    payload.push({ op: "const", type: slot?.wat ?? "i32", value: 0 });
  }
  return [
    { op: "const", type: "i32", value: variant.tag },
    ...payload,
  ];
}

function lowerImplicitSumPayload(
  expr: Expr,
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const sum = sumLayoutForType(expectedType, ctx.layouts);
  if (!sum) return undefined;
  if (
    expr.kind === "var" &&
    sum.variants.some((variant) => terminalName(variant.name) === terminalName(expr.name))
  ) {
    return undefined;
  }
  if (expr.kind === "call" && expr.callee.kind === "var") {
    const calleeName = expr.callee.name;
    const isVariantCall = sum.variants.some((variant) =>
      terminalName(variant.name) === terminalName(calleeName)
    );
    if (isVariantCall) return undefined;
  }
  const payloadVariants = sum.variants.filter((variant) => variant.slots.length > 0);
  if (payloadVariants.length !== 1) return undefined;
  const variant = payloadVariants[0]!;
  if (variant.slots.length !== 1) return undefined;
  const actualType = exprRuntimeTypeWithLiteralDefault(expr, ctx);
  if (actualType) {
    const actualSlots = flattenType(actualType, ctx.layouts);
    if (actualSlots.length !== variant.flatSlots.length) return undefined;
  } else if (expr.kind !== "literal" && expr.kind !== "var") {
    return undefined;
  }
  const slot = variant.slots[0]!;
  const payload = lowerExpr(expr, ctx, locals, slot.type);
  const missing = sum.payloadSlots.length - variant.flatSlots.length;
  for (let index = 0; index < missing; index++) {
    const payloadSlot = sum.payloadSlots[variant.flatSlots.length + index];
    payload.push({ op: "const", type: payloadSlot?.wat ?? "i32", value: 0 });
  }
  return [
    { op: "const", type: "i32", value: variant.tag },
    ...payload,
  ];
}

function findLastSlot<t>(
  slots: t[],
  predicate: (slot: t, index: number) => boolean,
): t | undefined {
  for (let index = slots.length - 1; index >= 0; index--) {
    const slot = slots[index]!;
    if (predicate(slot, index)) return slot;
  }
  return undefined;
}

function expandSpreadSlots(
  slots: { label?: string; value: Expr; spread?: boolean; index?: Expr }[],
  expectedType: string | undefined,
  ctx: LowerContext,
  locals: Set<string>,
): { label?: string; value: Expr }[] | undefined {
  if (!slots.some((slot) => slot.spread)) return undefined;
  if (slots.some((slot) => slot.index)) return undefined;
  const productExpanded = expandProductSpreadSlots(slots, expectedType, ctx);
  if (productExpanded) return productExpanded;
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

function expandProductSpreadSlots(
  slots: { label?: string; value: Expr; spread?: boolean; index?: Expr }[],
  expectedType: string | undefined,
  ctx: LowerContext,
): { label?: string; value: Expr }[] | undefined {
  const fixedTargetSlots = productSlotsForType(expectedType, ctx.layouts)?.filter((slot) =>
    slot.label
  );
  let outputOrder = fixedTargetSlots?.map((slot) => slot.label!).filter(Boolean) ?? [];
  const values = new Map<string, Expr>();
  const targetLabels = new Set(outputOrder);
  const hasProductCue = !!fixedTargetSlots?.length || slots.some((slot) => slot.label);
  let sawProductSource = false;

  for (const slot of slots) {
    if (slot.spread) {
      const sourceType = exprTypeWithLocals(slot.value, ctx);
      const sourceSlots = productSlotsForType(sourceType, ctx.layouts)?.filter((item) =>
        item.label
      );
      if (!sourceSlots) return hasProductCue ? [] : undefined;
      sawProductSource = true;
      for (const sourceSlot of sourceSlots) {
        const label = sourceSlot.label!;
        if (fixedTargetSlots?.length && !targetLabels.has(label)) continue;
        if (!fixedTargetSlots?.length && !targetLabels.has(label)) {
          targetLabels.add(label);
          outputOrder.push(label);
        }
        values.set(label, {
          kind: "field",
          value: slot.value,
          key: { kind: "literal", literalKind: "literalType", value: `#${label}` },
        });
      }
      continue;
    }
    if (!slot.label) return hasProductCue ? [] : undefined;
    if (!targetLabels.has(slot.label)) {
      targetLabels.add(slot.label);
      outputOrder.push(slot.label);
    }
    values.set(slot.label, slot.value);
  }

  if (!hasProductCue && !sawProductSource) return undefined;
  if (!outputOrder.length) return undefined;
  return outputOrder
    .map((label) => ({ label, value: values.get(label) }))
    .filter((slot): slot is { label: string; value: Expr } => !!slot.value);
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
      return true;
    case "binary":
      return binaryOpIsNonTrapping(expr) &&
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

function binaryOpIsNonTrapping(expr: Extract<Expr, { kind: "binary" }>): boolean {
  if (expr.op !== "/" && expr.op !== "%") return true;
  const divisor = staticIntegerLiteral(expr.right);
  if (divisor === undefined || divisor === 0) return false;
  const dividend = staticIntegerLiteral(expr.left);
  return !(dividend === I32_MIN && divisor === -1);
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

function lowerRefinedDomainTryMatch(
  value: Expr,
  arms: MatchArm[],
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (arms.some((arm) => arm.guard)) return undefined;
  if (value.kind !== "call" || value.callee.kind !== "var") return undefined;
  const tryInfo = refinedDomainTryInfo(value.callee.name, ctx.functions);
  if (!tryInfo) return undefined;
  let checkedArgIndex = tryInfo.checkedArgIndex;
  if (checkedArgIndex < 0) checkedArgIndex = value.args.length - 1;
  const checked = value.args[checkedArgIndex];
  if (!checked) return undefined;
  const callee = ctx.functions.get(tryInfo.calleeName);
  const payloadType = optionPayloadType(callee?.returnType);
  const resolvedPayload = resolveAlias(payloadType, ctx.layouts) ?? payloadType;
  let payloadFact = scalarFactsFromRefinedI32Type(resolvedPayload);
  if (!payloadFact && tryInfo.domainType) {
    const resolvedDomain = resolveAlias(tryInfo.domainType, ctx.layouts) ?? tryInfo.domainType;
    payloadFact = scalarFactsFromRefinedI32Type(resolvedDomain);
  }
  if (!payloadFact) {
    payloadFact = scalarFactsFromRefinedI32Type(
      refinedDomainTypeArg(value.args.at(0), ctx.layouts),
    );
  }
  if (!payloadFact) return undefined;
  const someArm = arms.find((arm) =>
    arm.pattern.kind === "constructor" && arm.pattern.name === "Some"
  );
  const noneArm =
    arms.find((arm) =>
      (arm.pattern.kind === "constructor" || arm.pattern.kind === "binding") &&
      arm.pattern.name === "None"
    ) ?? arms.find((arm) => isCatchAllPattern(arm.pattern));
  if (!someArm || !noneArm) return undefined;

  const checkedName = `__domain_tmp${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name: checkedName, type: "i32" });
  const checkedVar: Expr = { kind: "var", name: checkedName };
  const scoped = new Set(locals);
  const bindingName = someArm.pattern.kind === "constructor" &&
      someArm.pattern.args[0]?.kind === "binding"
    ? someArm.pattern.args[0].name
    : undefined;
  let someCtx = ctx;
  if (bindingName) {
    scoped.add(bindingName);
    ctx.tempLocals.push({ name: bindingName, type: "i32" });
    if (payloadFact.range) someCtx = ctxWithLocalScalarFact(ctx, bindingName, payloadFact);
  }
  const membershipTest = refinedI32MembershipTest(
    checkedVar,
    payloadFact.domain,
    ctx,
    new Set([...locals, checkedName]),
  );
  if (!membershipTest) return undefined;

  return [
    ...lowerExpr(checked, ctx, locals, "i32"),
    { op: "local.set", name: checkedName },
    ...membershipTest,
    {
      op: "if",
      results: flattenType(expectedType, ctx.layouts).map((slot) => slot.wat),
      thenBody: [
        ...(bindingName
          ? [
            { op: "local.get", name: checkedName } as Instr,
            { op: "local.set", name: bindingName } as Instr,
          ]
          : []),
        ...lowerExpr(someArm.value, someCtx, scoped, expectedType),
      ],
      elseBody: lowerExpr(noneArm.value, ctx, locals, expectedType),
      branchHint: branchHintForTestedArm(someArm, arms.filter((arm) => arm !== someArm)),
    },
  ];
}

function isRefinedDomainTryCallee(name: string): boolean {
  return name.endsWith("Index::try") || name.includes("Index__try__") ||
    name.endsWith("i32::try_domain") || name.includes("i32__try_domain__");
}

type RefinedDomainTryInfo = {
  calleeName: string;
  checkedArgIndex: number;
  domainType?: string;
};

function refinedDomainTryInfo(
  name: string,
  functions: ReadonlyMap<string, FnDecl>,
): RefinedDomainTryInfo | undefined {
  if (isRefinedDomainTryCallee(name)) {
    return { calleeName: name, checkedArgIndex: -1 };
  }
  const split = name.lastIndexOf(".");
  if (split > 0) {
    const attachedName = `${name.slice(0, split)}::${name.slice(split + 1)}`;
    if (isRefinedDomainTryCallee(attachedName) && functions.has(attachedName)) {
      return { calleeName: attachedName, checkedArgIndex: -1 };
    }
  }
  const fn = functions.get(name);
  const wrapper = refinedDomainTryWrapperInfo(fn);
  if (wrapper) return { ...wrapper, calleeName: name };
  if (split <= 0) return undefined;
  const attachedName = `${name.slice(0, split)}::${name.slice(split + 1)}`;
  const attached = functions.get(attachedName);
  const attachedWrapper = refinedDomainTryWrapperInfo(attached);
  return attachedWrapper ? { ...attachedWrapper, calleeName: attachedName } : undefined;
}

function refinedDomainTryWrapperInfo(
  fn: FnDecl | undefined,
): Omit<RefinedDomainTryInfo, "calleeName"> | undefined {
  if (!fn) return undefined;
  const payloadType = optionPayloadType(fn.returnType);
  if (!payloadType) return undefined;
  const expr = fn.body.expr;
  if (fn.body.statements.length > 0 || expr?.kind !== "call" || expr.callee.kind !== "var") {
    return undefined;
  }
  if (!isRefinedDomainTryCallee(expr.callee.name)) return undefined;
  const checkedArg = expr.args.at(-1);
  if (checkedArg?.kind !== "var") return undefined;
  const checkedArgIndex = fn.params.findIndex((param) => param.name === checkedArg.name);
  if (checkedArgIndex < 0) return undefined;
  return { checkedArgIndex, domainType: payloadType };
}

function optionPayloadType(type: string | undefined): string | undefined {
  const args = type ? typeCallArgs(type, "Option") : undefined;
  return args === undefined ? undefined : splitTypeArgs(args)[0]?.trim();
}

function refinedDomainTypeArg(expr: Expr | undefined, layouts: LayoutEnv): string | undefined {
  if (expr?.kind !== "var") return undefined;
  return resolveAlias(expr.name, layouts) ?? expr.name;
}

function refinedI32MembershipTest(
  expr: Expr,
  domain: NonNullable<ReturnType<typeof parseRefinedI32Type>>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (
    !domain.intervals.length ||
    domain.intervals.some((interval) =>
      interval.start.kind !== "literal" || interval.end.kind !== "literal"
    )
  ) return undefined;
  const intervals = domain.intervals;
  return intervals
    .map((interval) => {
      const start = interval.start.kind === "literal" ? interval.start.value : I32_MIN;
      const endExclusive = interval.end.kind === "literal" ? interval.end.value : I32_MAX + 1;
      return refinedI32IntervalMembershipTest(expr, start, endExclusive - 1, ctx, locals);
    })
    .reduce(
      (body, test) =>
        body.length ? [...body, ...test, { op: "binary", wasm: "i32.or" } as Instr] : test,
      [] as Instr[],
    );
}

function refinedI32IntervalMembershipTest(
  expr: Expr,
  min: number,
  max: number,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const lower = min <= I32_MIN ? [{ op: "const", type: "i32", value: 1 } as Instr] : [
    ...lowerExpr(expr, ctx, locals, "i32"),
    { op: "const", type: "i32", value: min } as Instr,
    { op: "binary", wasm: "i32.ge_s" } as Instr,
  ];
  const upper = max >= I32_MAX ? [{ op: "const", type: "i32", value: 1 } as Instr] : [
    ...lowerExpr(expr, ctx, locals, "i32"),
    { op: "const", type: "i32", value: max } as Instr,
    { op: "binary", wasm: "i32.le_s" } as Instr,
  ];
  return [...lower, ...upper, { op: "binary", wasm: "i32.and" }];
}

function lowerMatchArms(
  value: Expr,
  arms: MatchArm[],
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  const foldedValue = constFold(value, ctx);
  if (foldedValue.kind === "literal" && !arms.some((arm) => arm.guard)) {
    const selected = arms.find((candidate) =>
      literalPatternMatches(candidate.pattern, foldedValue)
    ) ?? arms.find((candidate) => isCatchAllPattern(candidate.pattern));
    if (selected) {
      const scoped = new Set(locals);
      addPatternBindingLocals(selected.pattern, ctx, scoped);
      const selectedCtx = ctxWithPatternBindingTypes(
        ctx,
        selected.pattern,
        matchValueType(foldedValue, ctx),
      );
      const bindings = patternBindingNames(selected.pattern).length
        ? [
          ...lowerExpr(foldedValue, ctx, locals),
          ...lowerPatternBindings(selected.pattern, ctx, scoped, matchValueType(foldedValue, ctx)),
        ]
        : [];
      return [
        ...bindings,
        ...lowerExpr(selected.value, selectedCtx, scoped, expectedType),
      ];
    }
  }
  const [arm, ...rest] = arms;
  if (!arm) return [{ op: "const", type: "i32", value: 0 }];
  const valueType = matchValueType(value, ctx);
  const guarded = lowerGuardedMatchArm(value, arm, rest, ctx, locals, expectedType);
  if (guarded) return guarded;
  if (isCatchAllPattern(arm.pattern) || rest.length === 0) {
    const scoped = new Set(locals);
    addPatternBindingLocals(arm.pattern, ctx, scoped);
    const bindings = patternBindingNames(arm.pattern).length
      ? [
        ...lowerExpr(value, ctx, locals),
        ...lowerPatternBindings(arm.pattern, ctx, scoped, valueType),
      ]
      : [];
    const ignored = bindings.length === 0 && hasRuntimeEffect(value, ctx.functions)
      ? lowerIgnoredExpr(value, ctx, locals)
      : [];
    const armCtx = isCatchAllPattern(arm.pattern)
      ? ctx
      : narrowedCtxForPattern(value, arm.pattern, ctx);
    const bindingCtx = ctxWithPatternBindingTypes(armCtx, arm.pattern, valueType);
    return [
      ...bindings,
      ...ignored,
      ...lowerExpr(arm.value, bindingCtx, scoped, expectedType),
    ];
  }
  const accumulator = lowerBooleanScalarAccumulator(value, arm, rest, ctx, locals, expectedType);
  if (accumulator) return accumulator;
  const selected = lowerScalarBooleanMatchSelect(value, arm, rest, ctx, locals, expectedType);
  if (selected) return selected;
  const scoped = new Set(locals);
  addPatternBindingLocals(arm.pattern, ctx, scoped);
  const bindings = patternBindingNames(arm.pattern).length
    ? [
      ...lowerExpr(value, ctx, locals),
      ...lowerPatternBindings(arm.pattern, ctx, scoped, valueType),
    ]
    : [];
  return [
    ...lowerExpr(value, ctx, locals),
    ...lowerPatternTest(arm.pattern, ctx, locals, valueType),
    {
      op: "if",
      results: flattenType(expectedType, ctx.layouts).map((slot) => slot.wat),
      thenBody: [
        ...bindings,
        ...lowerExpr(
          arm.value,
          ctxWithPatternBindingTypes(
            narrowedCtxForPattern(value, arm.pattern, ctx),
            arm.pattern,
            valueType,
          ),
          scoped,
          expectedType,
        ),
      ],
      elseBody: lowerMatchArms(value, rest, ctx, locals, expectedType),
      branchHint: branchHintForTestedArm(arm, rest),
    },
  ];
}

function lowerGuardedMatchArm(
  value: Expr,
  arm: MatchArm,
  rest: MatchArm[],
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (!arm.guard) return undefined;
  const results = flattenType(expectedType, ctx.layouts).map((slot) => slot.wat);
  const elseBody = lowerMatchArms(value, rest, ctx, locals, expectedType);
  const scoped = new Set(locals);
  addPatternBindingLocals(arm.pattern, ctx, scoped);
  const bindingNames = patternBindingNames(arm.pattern);
  const valueType = matchValueType(value, ctx);
  const bindings = bindingNames.length
    ? [
      ...lowerExpr(value, ctx, locals),
      ...lowerPatternBindings(arm.pattern, ctx, scoped, valueType),
    ]
    : [];
  const ignored = bindings.length === 0 && hasRuntimeEffect(value, ctx.functions)
    ? lowerIgnoredExpr(value, ctx, locals)
    : [];
  const guardedBody = [
    ...bindings,
    ...ignored,
    ...lowerExpr(
      arm.guard,
      ctxWithPatternBindingTypes(
        narrowedCtxForPattern(value, arm.pattern, ctx),
        arm.pattern,
        valueType,
      ),
      scoped,
      "bool",
    ),
    {
      op: "if",
      results,
      thenBody: lowerExpr(
        arm.value,
        ctxWithPatternBindingTypes(
          narrowedCtxForPattern(value, arm.pattern, ctx),
          arm.pattern,
          valueType,
        ),
        scoped,
        expectedType,
      ),
      elseBody,
      branchHint: branchHintForTestedArm(arm, rest),
    } as Instr,
  ];
  if (isCatchAllPattern(arm.pattern)) return guardedBody;
  return [
    ...lowerExpr(value, ctx, locals),
    ...lowerPatternTest(arm.pattern, ctx, locals, valueType),
    {
      op: "if",
      results,
      thenBody: guardedBody,
      elseBody,
      branchHint: branchHintForTestedArm(arm, rest),
    },
  ];
}

function lowerSumMatch(
  value: Expr,
  arms: MatchArm[],
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  const valueType = exprTypeWithLocals(value, ctx);
  const sum = sumLayoutForType(valueType, ctx.layouts);
  if (!sum) return undefined;
  if (arms.some((arm) => !sumMatchPatternSupported(arm.pattern))) return undefined;
  const slots = flattenType(valueType, ctx.layouts);
  const temps = slots.map((slot) => {
    const name = `__sum_tmp${ctx.tempIndex++}`;
    ctx.tempLocals.push({ name, type: slot.wat });
    locals.add(name);
    return name;
  });
  return [
    ...lowerExpr(value, ctx, locals, valueType),
    ...temps.toReversed().map((name): Instr => ({ op: "local.set", name })),
    ...lowerSumMatchArms(sum, temps, arms, ctx, locals, expectedType),
  ];
}

function sumMatchPatternSupported(pattern: ParamPattern): boolean {
  if (pattern.kind === "typed") return sumMatchPatternSupported(pattern.pattern);
  return pattern.kind === "constructor" || pattern.kind === "type" ||
    pattern.kind === "binding" || pattern.kind === "wildcard";
}

function lowerSumMatchArms(
  sum: SumLayout,
  temps: string[],
  arms: MatchArm[],
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] {
  const [arm, ...rest] = arms;
  if (!arm) {
    return flattenType(expectedType, ctx.layouts).map((slot): Instr => ({
      op: "const",
      type: slot.wat,
      value: 0,
    }));
  }
  const variant = sumVariantForPattern(sum, arm.pattern);
  const scoped = new Set(locals);
  const bindings = variant
    ? lowerSumPatternBindings(sum, variant, temps, arm.pattern, ctx, scoped)
    : lowerWholeSumPatternBindings(sum, temps, arm.pattern, ctx, scoped);
  const armCtx = ctxWithPatternBindingTypes(ctx, arm.pattern, sum.type);
  const body = arm.guard
    ? [
      ...bindings,
      ...lowerExpr(arm.guard, armCtx, scoped, "bool"),
      {
        op: "if",
        results: flattenType(expectedType, ctx.layouts).map((slot) => slot.wat),
        thenBody: lowerExpr(arm.value, armCtx, scoped, expectedType),
        elseBody: lowerSumMatchArms(sum, temps, rest, ctx, locals, expectedType),
        branchHint: branchHintForTestedArm(arm, rest),
      } as Instr,
    ]
    : [
      ...bindings,
      ...lowerExpr(arm.value, armCtx, scoped, expectedType),
    ];
  if ((!variant || rest.length === 0) && !arm.guard) return body;
  if (!variant) return body;
  return [
    { op: "local.get", name: temps[0] ?? "__sum_tag_missing" },
    { op: "const", type: "i32", value: variant.tag },
    { op: "binary", wasm: "i32.eq" },
    {
      op: "if",
      results: flattenType(expectedType, ctx.layouts).map((slot) => slot.wat),
      thenBody: body,
      elseBody: lowerSumMatchArms(sum, temps, rest, ctx, locals, expectedType),
      branchHint: branchHintForTestedArm(arm, rest),
    },
  ];
}

function sumVariantForPattern(sum: SumLayout, pattern: ParamPattern): SumVariantLayout | undefined {
  if (pattern.kind === "typed") return sumVariantForPattern(sum, pattern.pattern);
  if (pattern.kind !== "constructor" && pattern.kind !== "type" && pattern.kind !== "binding") {
    return undefined;
  }
  return sum.variants.find((variant) => terminalName(variant.name) === terminalName(pattern.name));
}

function uniqueSumVariantByName(
  name: string,
  layouts: LayoutEnv,
): SumVariantLayout | undefined {
  let found: SumVariantLayout | undefined;
  for (const decl of layouts.types.values()) {
    if (decl.normalized?.kind !== "sum") continue;
    const sum = sumLayoutForType(decl.name, layouts);
    const variant = sum?.variants.find((item) => terminalName(item.name) === terminalName(name));
    if (!variant) continue;
    if (found) return undefined;
    found = variant;
  }
  return found;
}

function sumVariantByNameForType(
  name: string,
  type: string | undefined,
  layouts: LayoutEnv,
): SumVariantLayout | undefined {
  const sum = sumLayoutForType(type, layouts);
  return sum?.variants.find((variant) => terminalName(variant.name) === terminalName(name));
}

function scalarNicheVariantByNameForType(
  name: string,
  type: string | undefined,
  layouts: LayoutEnv,
): SumVariantLayout | undefined {
  const sum = scalarNicheSumLayoutForType(type, layouts);
  return sum?.variants.find((variant) => terminalName(variant.name) === terminalName(name));
}

function tuplePatternItemTypes(
  pattern: Extract<ParamPattern, { kind: "tuple" }>,
  valueType: string | undefined,
  layouts: LayoutEnv,
): Array<string | undefined> {
  const fallback = pattern.items.map(() => undefined);
  const slots = productSlotsForType(valueType, layouts);
  if (!slots) return fallback;
  const itemTypes: string[] = [];
  for (const slot of slots) {
    const count = slot.repeat ? Number.parseInt(slot.repeat, 10) : 1;
    const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
    for (let index = 0; index < safeCount; index++) itemTypes.push(slot.type);
  }
  if (itemTypes.length !== pattern.items.length) return fallback;
  return itemTypes;
}

function matchValueType(value: Expr, ctx: LowerContext): string | undefined {
  return exprTypeWithLocals(value, ctx) ?? exprType(value, ctx.functions);
}

function lowerWholeSumPatternBindings(
  sum: SumLayout,
  temps: string[],
  pattern: ParamPattern,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  if (pattern.kind === "typed") {
    return lowerWholeSumPatternBindings(sum, temps, pattern.pattern, ctx, locals);
  }
  if (pattern.kind !== "binding") return [];
  const bindings = flattenBinding(pattern.name, sum.type, ctx.layouts);
  for (const binding of bindings) {
    locals.add(binding.name);
    ctx.tempLocals.push({ name: binding.name, type: binding.wat });
  }
  return bindings.map((binding, index): Instr[] => [
    { op: "local.get", name: temps[index] ?? temps[0] ?? "__sum_missing" },
    { op: "local.set", name: binding.name },
  ]).flat();
}

function lowerSumPatternBindings(
  sum: SumLayout,
  variant: SumVariantLayout,
  temps: string[],
  pattern: ParamPattern,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  if (pattern.kind === "typed") {
    return lowerSumPatternBindings(sum, variant, temps, pattern.pattern, ctx, locals);
  }
  if (pattern.kind !== "constructor") {
    return lowerWholeSumPatternBindings(sum, temps, pattern, ctx, locals);
  }
  const body: Instr[] = [];
  let offset = 1;
  for (let index = 0; index < pattern.args.length; index++) {
    const arg = pattern.args[index]!;
    const slot = variant.slots[index];
    const flat = slot ? flattenType(slot.type, ctx.layouts) : [];
    if (arg.kind === "binding" && slot) {
      const bindings = flattenBinding(arg.name, slot.type, ctx.layouts);
      for (const binding of bindings) {
        locals.add(binding.name);
        ctx.tempLocals.push({ name: binding.name, type: binding.wat });
      }
      for (let bindingIndex = 0; bindingIndex < bindings.length; bindingIndex++) {
        body.push(
          { op: "local.get", name: temps[offset + bindingIndex] ?? "__sum_payload_missing" },
          { op: "local.set", name: bindings[bindingIndex]!.name },
        );
      }
    }
    offset += flat.length;
  }
  return body;
}

function literalPatternMatches(
  pattern: ParamPattern,
  literal: Extract<Expr, { kind: "literal" }>,
): boolean {
  if (pattern.kind === "typed") {
    if (!literalPatternMatches(pattern.pattern, literal)) return false;
    const domain = parseRefinedI32Type(pattern.type);
    if (!domain || literal.literalKind !== "number") return true;
    const value = Number.parseInt(literal.value, 10);
    if (!Number.isFinite(value)) return false;
    return scalarFactsContainsLiteral(scalarFactsFromDomain(domain), value);
  }
  if (pattern.kind === "as") return literalPatternMatches(pattern.pattern, literal);
  if (pattern.kind === "or") {
    return pattern.alternatives.some((alternative) => literalPatternMatches(alternative, literal));
  }
  if (pattern.kind !== "literal") return false;
  return pattern.literalKind === literal.literalKind && pattern.value === literal.value;
}

function addPatternBindingLocals(
  pattern: ParamPattern,
  ctx: LowerContext,
  locals: Set<string>,
) {
  for (const name of patternBindingNames(pattern)) {
    if (!locals.has(name)) {
      locals.add(name);
      ctx.tempLocals.push({ name, type: "i32" });
    }
  }
}

function ctxWithPatternBindingTypes(
  ctx: LowerContext,
  pattern: ParamPattern,
  valueType: string | undefined,
): LowerContext {
  const localTypes = new Map(ctx.localTypes);
  addPatternBindingTypes(pattern, valueType, localTypes, ctx.layouts);
  return { ...ctx, localTypes };
}

function ctxWithLocalType(
  ctx: LowerContext,
  name: string,
  type: string | undefined,
): LowerContext {
  if (!type) return ctx;
  const localTypes = new Map(ctx.localTypes);
  localTypes.set(name, type);
  return { ...ctx, localTypes };
}

function addPatternBindingTypes(
  pattern: ParamPattern,
  valueType: string | undefined,
  localTypes: Map<string, string>,
  layouts: LayoutEnv,
) {
  switch (pattern.kind) {
    case "binding":
      if (valueType) localTypes.set(pattern.name, valueType);
      return;
    case "typed":
      addPatternBindingTypes(pattern.pattern, pattern.type, localTypes, layouts);
      return;
    case "as":
      if (valueType) localTypes.set(pattern.name, valueType);
      addPatternBindingTypes(pattern.pattern, valueType, localTypes, layouts);
      return;
    case "or":
      if (pattern.alternatives[0]) {
        addPatternBindingTypes(pattern.alternatives[0], valueType, localTypes, layouts);
      }
      return;
    case "tuple": {
      const itemTypes = tuplePatternItemTypes(pattern, valueType, layouts);
      for (let index = 0; index < pattern.items.length; index++) {
        addPatternBindingTypes(pattern.items[index]!, itemTypes[index], localTypes, layouts);
      }
      return;
    }
    case "constructor": {
      const sum = sumLayoutForType(valueType, layouts);
      const variant = sum?.variants.find((item) =>
        terminalName(item.name) === terminalName(pattern.name)
      );
      for (let index = 0; index < pattern.args.length; index++) {
        addPatternBindingTypes(
          pattern.args[index]!,
          variant?.slots[index]?.type,
          localTypes,
          layouts,
        );
      }
      return;
    }
    case "product": {
      const slots = productSlotsForType(valueType, layouts) ?? [];
      for (const field of pattern.fields) {
        const slot = slots.find((item, index) => (item.label ?? String(index)) === field.label);
        addPatternBindingTypes(field.pattern, slot?.type, localTypes, layouts);
      }
      return;
    }
    case "wildcard":
    case "literal":
    case "enum_member":
    case "type":
      return;
  }
}

function lowerPatternBindings(
  pattern: ParamPattern,
  ctx?: LowerContext,
  locals?: Set<string>,
  valueType?: string,
): Instr[] {
  switch (pattern.kind) {
    case "binding": {
      if (ctx && locals) {
        const bindings = flattenBinding(pattern.name, valueType, ctx.layouts);
        for (const binding of bindings) {
          if (locals.has(binding.name)) continue;
          locals.add(binding.name);
          ctx.tempLocals.push({ name: binding.name, type: binding.wat });
        }
        return bindings.toReversed().map((binding): Instr => ({
          op: "local.set",
          name: binding.name,
        }));
      }
      return [{ op: "local.set", name: pattern.name }];
    }
    case "typed":
      return lowerPatternBindings(pattern.pattern, ctx, locals, pattern.type);
    case "as": {
      if (!ctx || !locals) return lowerPatternBindings(pattern.pattern, ctx, locals, valueType);
      const slots = flattenType(valueType, ctx.layouts);
      const temps = slots.map((slot, index) => {
        const name = `__match_as${ctx.tempIndex++}_${index}`;
        locals.add(name);
        ctx.tempLocals.push({ name, type: slot.wat });
        return name;
      });
      const stores = temps.toReversed().map((name): Instr => ({ op: "local.set", name }));
      return [
        ...stores,
        ...temps.flatMap((name) => [{ op: "local.get", name } as Instr]),
        ...lowerPatternBindings({ kind: "binding", name: pattern.name }, ctx, locals, valueType),
        ...temps.flatMap((name) => [{ op: "local.get", name } as Instr]),
        ...lowerPatternBindings(pattern.pattern, ctx, locals, valueType),
      ];
    }
    case "or": {
      if (!ctx || !locals) {
        const alternative = pattern.alternatives[0];
        if (!alternative) return [];
        return lowerPatternBindings(alternative, ctx, locals, valueType);
      }
      const slots = flattenType(valueType, ctx.layouts);
      const temps = slots.map((slot, index) => {
        const name = `__match_or_bind${ctx.tempIndex++}_${index}`;
        locals.add(name);
        ctx.tempLocals.push({ name, type: slot.wat });
        return name;
      });
      return [
        ...temps.toReversed().map((name): Instr => ({ op: "local.set", name })),
        ...lowerOrPatternBindingsFromTemps(pattern.alternatives, valueType, temps, ctx, locals),
      ];
    }
    case "tuple": {
      if (ctx && locals) {
        const itemTypes = tuplePatternItemTypes(pattern, valueType, ctx.layouts);
        return pattern.items.toReversed().flatMap((item, reverseIndex) => {
          const index = pattern.items.length - reverseIndex - 1;
          return lowerPatternBindings(item, ctx, locals, itemTypes[index]);
        });
      }
      return pattern.items.toReversed().flatMap((item) => lowerPatternBindings(item));
    }
    case "constructor": {
      if (ctx && locals) {
        const variant = sumVariantByNameForType(pattern.name, valueType, ctx.layouts);
        const sum = sumLayoutForType(valueType, ctx.layouts);
        if (variant && sum) {
          const body: Instr[] = [];
          const missing = sum.payloadSlots.length - variant.flatSlots.length;
          for (let index = 0; index < missing; index++) body.push({ op: "drop" });
          for (let index = pattern.args.length - 1; index >= 0; index--) {
            const arg = pattern.args[index]!;
            const slot = variant.slots[index];
            body.push(...lowerPatternBindings(arg, ctx, locals, slot?.type));
          }
          body.push({ op: "drop" });
          return body;
        }
        const scalarNicheVariant = scalarNicheVariantByNameForType(
          pattern.name,
          valueType,
          ctx.layouts,
        );
        if (scalarNicheVariant) {
          const body: Instr[] = [];
          for (let index = pattern.args.length - 1; index >= 0; index--) {
            const arg = pattern.args[index]!;
            const slot = scalarNicheVariant.slots[index];
            body.push(...lowerPatternBindings(arg, ctx, locals, slot?.type));
          }
          return body;
        }
      }
      return [
        ...pattern.args.toReversed().flatMap((item) => lowerPatternBindings(item)),
        { op: "drop" },
      ];
    }
    case "product": {
      if (!ctx || !locals) {
        const count = pattern.fields.length;
        const body: Instr[] = [];
        for (let index = 0; index < count; index++) body.push({ op: "drop" });
        return body;
      }
      const slots = productSlotsForType(valueType, ctx.layouts) ?? [];
      const allFlatSlots = slots.map((slot) => flattenType(slot.type, ctx.layouts));
      const fieldByLabel = new Map(pattern.fields.map((field) => [field.label, field]));
      const body: Instr[] = [];
      for (let index = slots.length - 1; index >= 0; index--) {
        const slot = slots[index]!;
        const label = slot.label ?? String(index);
        const field = fieldByLabel.get(label);
        if (field) {
          body.push(...lowerPatternBindings(field.pattern, ctx, locals, slot.type));
        } else {
          for (let flat = 0; flat < allFlatSlots[index]!.length; flat++) {
            body.push({ op: "drop" });
          }
        }
      }
      return body;
    }
    case "wildcard":
    case "literal":
    case "enum_member":
    case "type": {
      const count = ctx ? flattenType(valueType, ctx.layouts).length : 1;
      const body: Instr[] = [];
      for (let index = 0; index < count; index++) body.push({ op: "drop" });
      return body;
    }
  }
}

function lowerBooleanScalarAccumulator(
  value: Expr,
  arm: MatchArm,
  rest: MatchArm[],
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (arm.guard || rest.some((item) => item.guard)) return undefined;
  if (ctx.optMode !== "release" || rest.length !== 1) return undefined;
  if (branchHintForTestedArm(arm, rest)) return undefined;
  if (!isTrueLikePattern(arm.pattern) && !isFalseLikePattern(arm.pattern)) return undefined;
  const fallback = rest[0]!;
  if (
    !isCatchAllPattern(fallback.pattern) &&
    !isTrueLikePattern(fallback.pattern) &&
    !isFalseLikePattern(fallback.pattern)
  ) return undefined;
  const resultType = expectedType ?? exprTypeWithLocals(arm.value, ctx);
  const slot = flattenType(resultType, ctx.layouts)[0];
  if (!slot || slot.wat !== "i32" || flattenType(resultType, ctx.layouts).length !== 1) {
    return undefined;
  }

  const armDelta = scalarAccumulatorDelta(fallback.value, arm.value);
  const fallbackDelta = scalarAccumulatorDelta(arm.value, fallback.value);
  const active = armDelta
    ? { base: fallback.value, delta: armDelta, onTestedArm: true }
    : fallbackDelta
    ? { base: arm.value, delta: fallbackDelta, onTestedArm: false }
    : undefined;
  if (!active) {
    const signed = scalarAccumulatorSignedDelta(arm.value, fallback.value);
    if (!signed || !isSpeculableNonTrappingExpr(signed.delta, ctx.functions)) return undefined;
    return [
      ...lowerExpr(signed.base, ctx, locals, resultType),
      ...lowerExpr(signed.delta, ctx, locals, "i32"),
      { op: "const", type: "i32", value: 0 },
      ...lowerExpr(signed.delta, ctx, locals, "i32"),
      { op: "binary", wasm: "i32.sub" },
      ...lowerExpr(value, ctx, locals, "bool"),
      ...lowerPatternTest(arm.pattern, ctx, locals),
      { op: "select", type: "i32" },
      { op: "binary", wasm: "i32.add" },
    ];
  }
  if (active.base.kind !== "var") return undefined;
  if (!isSpeculableNonTrappingExpr(active.delta, ctx.functions)) return undefined;

  const literalDelta = staticIntegerLiteral(active.delta);
  return [
    ...lowerExpr(active.base, ctx, locals, resultType),
    ...(literalDelta === 1
      ? [
        ...lowerExpr(value, ctx, locals, "bool"),
        ...lowerPatternTest(arm.pattern, ctx, locals),
        ...(active.onTestedArm ? [] : [{ op: "binary", wasm: "i32.eqz" } as Instr]),
      ]
      : [
        ...(active.onTestedArm
          ? lowerExpr(active.delta, ctx, locals, "i32")
          : [{ op: "const", type: "i32", value: 0 } as Instr]),
        ...(active.onTestedArm
          ? [{ op: "const", type: "i32", value: 0 } as Instr]
          : lowerExpr(active.delta, ctx, locals, "i32")),
        ...lowerExpr(value, ctx, locals, "bool"),
        ...lowerPatternTest(arm.pattern, ctx, locals),
        { op: "select", type: "i32" } as Instr,
      ]),
    { op: "binary", wasm: "i32.add" },
  ];
}

function scalarAccumulatorDelta(base: Expr, updated: Expr): Expr | undefined {
  if (base.kind !== "var" || updated.kind !== "binary" || updated.op !== "+") return undefined;
  if (updated.left.kind === "var" && updated.left.name === base.name) {
    return exprMentionsName(updated.right, base.name) ? undefined : updated.right;
  }
  if (updated.right.kind === "var" && updated.right.name === base.name) {
    return exprMentionsName(updated.left, base.name) ? undefined : updated.left;
  }
  return undefined;
}

function scalarAccumulatorSignedDelta(
  positive: Expr,
  negative: Expr,
): { base: Expr; delta: Expr } | undefined {
  if (
    positive.kind === "binary" && positive.op === "+" &&
    negative.kind === "binary" && negative.op === "-"
  ) {
    const leftBase = positive.left.kind === "var" && negative.left.kind === "var" &&
      positive.left.name === negative.left.name;
    if (leftBase && exprReuseKey(positive.right) === exprReuseKey(negative.right)) {
      return { base: positive.left, delta: positive.right };
    }
    const rightBase = positive.right.kind === "var" && negative.left.kind === "var" &&
      positive.right.name === negative.left.name;
    if (rightBase && exprReuseKey(positive.left) === exprReuseKey(negative.right)) {
      return { base: positive.right, delta: positive.left };
    }
  }
  return undefined;
}

function narrowedCtxForPattern(
  value: Expr,
  pattern: ParamPattern,
  ctx: LowerContext,
): LowerContext {
  const truth = boolPatternValue(pattern);
  if (truth === undefined) return ctx;
  const narrowed = conditionI32Fact(value, ctx, truth);
  return narrowed ? ctxWithLocalScalarFact(ctx, narrowed.name, narrowed.fact) : ctx;
}

function conditionI32Fact(
  value: Expr,
  ctx: LowerContext,
  truth: boolean,
): { name: string; fact: ScalarFacts } | undefined {
  if (value.kind !== "binary") return undefined;
  if (value.left.kind === "var") {
    const right = staticIntegerLiteral(value.right);
    if (right === undefined) return undefined;
    const current = exprI32Facts(value.left, ctx) ?? scalarFactsAnyI32();
    const fact = leftVarConditionFact(current, value.op, right, truth);
    if (fact) return { name: value.left.name, fact };
  }
  if (value.right.kind === "var") {
    const left = staticIntegerLiteral(value.left);
    if (left === undefined) return undefined;
    const current = exprI32Facts(value.right, ctx) ?? scalarFactsAnyI32();
    const fact = rightVarConditionFact(current, value.op, left, truth);
    if (fact) return { name: value.right.name, fact };
  }
  return undefined;
}

function leftVarConditionFact(
  current: ScalarFacts,
  op: string,
  right: number,
  truth: boolean,
): ScalarFacts | undefined {
  if (op === "==") return equalityConditionFact(current, right, truth);
  if (op === "<") return comparisonConditionFact(current, { min: I32_MIN, max: right - 1 }, truth);
  if (op === "<=") return comparisonConditionFact(current, { min: I32_MIN, max: right }, truth);
  if (op === ">") return comparisonConditionFact(current, { min: right + 1, max: I32_MAX }, truth);
  if (op === ">=") return comparisonConditionFact(current, { min: right, max: I32_MAX }, truth);
  return undefined;
}

function rightVarConditionFact(
  current: ScalarFacts,
  op: string,
  left: number,
  truth: boolean,
): ScalarFacts | undefined {
  if (op === "==") return equalityConditionFact(current, left, truth);
  if (op === "<") return comparisonConditionFact(current, { min: left + 1, max: I32_MAX }, truth);
  if (op === "<=") return comparisonConditionFact(current, { min: left, max: I32_MAX }, truth);
  if (op === ">") return comparisonConditionFact(current, { min: I32_MIN, max: left - 1 }, truth);
  if (op === ">=") return comparisonConditionFact(current, { min: I32_MIN, max: left }, truth);
  return undefined;
}

function equalityConditionFact(
  current: ScalarFacts,
  value: number,
  truth: boolean,
): ScalarFacts | undefined {
  const singleton = scalarFactsFromI32Range({ min: value, max: value });
  if (truth) return scalarFactsIntersect(current, singleton);
  const domain = refinedI32DomainDifference(current.domain, singleton.domain);
  return domain?.intervals.length ? scalarFactsFromDomain(domain) : undefined;
}

function comparisonConditionFact(
  current: ScalarFacts,
  trueRange: I32Range,
  truth: boolean,
): ScalarFacts | undefined {
  const range = truth ? trueRange : complementEdgeRange(trueRange);
  return range ? intersectI32FactWithRange(current, range) : undefined;
}

function complementEdgeRange(range: I32Range): I32Range | undefined {
  if (range.min <= I32_MIN) {
    return range.max < I32_MAX ? { min: range.max + 1, max: I32_MAX } : undefined;
  }
  if (range.max >= I32_MAX) {
    return range.min > I32_MIN ? { min: I32_MIN, max: range.min - 1 } : undefined;
  }
  return undefined;
}

function boolPatternValue(pattern: ParamPattern): boolean | undefined {
  if (isTrueLikePattern(pattern)) return true;
  if (isFalseLikePattern(pattern)) return false;
  return undefined;
}

function ctxWithLocalScalarFact(
  ctx: LowerContext,
  name: string,
  fact: ScalarFacts,
): LowerContext {
  const localScalarFacts = new Map(ctx.localScalarFacts);
  mergeLocalScalarFact(localScalarFacts, name, fact);
  return { ...ctx, localScalarFacts };
}

function rememberLocalScalarFact(ctx: LowerContext, name: string, fact: ScalarFacts) {
  ctx.localScalarFacts ??= new Map();
  mergeLocalScalarFact(ctx.localScalarFacts, name, fact);
}

function intersectI32FactWithRange(
  fact: ScalarFacts,
  range: I32Range,
): ScalarFacts | undefined {
  return scalarFactsIntersect(fact, scalarFactsFromI32Range(range));
}

function lowerScalarBooleanMatchSelect(
  value: Expr,
  arm: MatchArm,
  rest: MatchArm[],
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (arm.guard || rest.some((item) => item.guard)) return undefined;
  if (ctx.optMode !== "release" || rest.length !== 1) return undefined;
  if (branchHintForTestedArm(arm, rest)) return undefined;
  if (value.kind === "call") return undefined;
  const fallback = rest[0]!;
  if (!isTrueLikePattern(arm.pattern) && !isFalseLikePattern(arm.pattern)) return undefined;
  if (
    !isCatchAllPattern(fallback.pattern) &&
    !isTrueLikePattern(fallback.pattern) &&
    !isFalseLikePattern(fallback.pattern)
  ) return undefined;
  if (
    !conditionalScalarUpdateBase(arm.value, fallback.value) &&
    (!cheapScalarSelectValue(arm.value) || !cheapScalarSelectValue(fallback.value))
  ) return undefined;
  if (!isSpeculableNonTrappingExpr(arm.value, ctx.functions)) return undefined;
  if (!isSpeculableNonTrappingExpr(fallback.value, ctx.functions)) return undefined;
  const resultType = expectedType ?? exprTypeWithLocals(arm.value, ctx);
  const slots = flattenType(resultType, ctx.layouts);
  const slot = slots[0];
  if (!slot || slots.length !== 1) return undefined;
  return [
    ...lowerExpr(arm.value, ctx, locals, resultType),
    ...lowerExpr(fallback.value, ctx, locals, resultType),
    ...lowerExpr(value, ctx, locals, "bool"),
    ...lowerPatternTest(arm.pattern, ctx, locals),
    { op: "select", type: slot.wat },
  ];
}

function cheapScalarSelectValue(expr: Expr): boolean {
  return expr.kind === "var" || expr.kind === "literal";
}

function conditionalScalarUpdateBase(thenValue: Expr, elseValue: Expr): string | undefined {
  if (thenValue.kind === "var" && exprMentionsName(elseValue, thenValue.name)) {
    return thenValue.name;
  }
  if (elseValue.kind === "var" && exprMentionsName(thenValue, elseValue.name)) {
    return elseValue.name;
  }
  return undefined;
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

function lowerMatchSharedScalarSubexprs(
  expr: Extract<Expr, { kind: "match" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  const candidates = sharedScalarMatchCandidates(expr, ctx);
  if (!candidates.length) return undefined;
  const replacements = new Map<string, Expr>();
  const prologue = candidates.flatMap((candidate): Instr[] => {
    const name = `__match_shared${ctx.tempIndex++}`;
    const slots = flattenType(exprTypeWithLocals(candidate, ctx), ctx.layouts);
    const slot = slots[0];
    if (!slot || slots.length !== 1) return [];
    locals.add(name);
    ctx.tempLocals.push({ name, type: slot.wat });
    const fact = slot.wat === "i32" ? exprI32Facts(candidate, ctx) : undefined;
    if (fact) rememberLocalScalarFact(ctx, name, fact);
    replacements.set(exprReuseKey(candidate)!, { kind: "var", name });
    return [
      ...lowerExpr(candidate, ctx, locals, slot.type),
      { op: "local.set", name },
    ];
  });
  if (!replacements.size) return undefined;
  return [
    ...prologue,
    ...lowerMatchArms(
      replaceSharedSubexprs(expr.value, replacements),
      expr.arms.map((arm) => ({
        ...arm,
        ...(arm.guard ? { guard: replaceSharedSubexprs(arm.guard, replacements) } : {}),
        value: replaceSharedSubexprs(arm.value, replacements),
      })),
      ctx,
      locals,
      expectedType,
    ),
  ];
}

function sharedScalarMatchCandidates(
  expr: Extract<Expr, { kind: "match" }>,
  ctx: LowerContext,
): Expr[] {
  const inValue = countedSharedSubexprs(expr.value, ctx);
  if (!inValue.size) return [];
  const inArms = new Map<string, number>();
  for (const arm of expr.arms) {
    for (const [key, item] of countedSharedSubexprs(arm.value, ctx)) {
      inArms.set(key, (inArms.get(key) ?? 0) + item.count);
    }
  }
  const selected: Expr[] = [];
  const coveredKeys = new Set<string>();
  for (const item of inValue.values()) {
    const key = exprReuseKey(item.expr);
    if (!key || !inArms.has(key)) continue;
    if (coveredKeys.has(key)) continue;
    selected.push(item.expr);
    for (const covered of exprReuseKeys(item.expr)) coveredKeys.add(covered);
    if (selected.length >= 3) break;
  }
  return selected;
}

function countedSharedSubexprs(
  expr: Expr,
  ctx: LowerContext,
): Map<string, { expr: Expr; count: number }> {
  const found = new Map<string, { expr: Expr; count: number }>();
  const visit = (item: Expr) => {
    const key = exprReuseKey(item);
    if (key && matchSharedScalarCandidate(item, ctx)) {
      const existing = found.get(key);
      if (existing) existing.count++;
      else found.set(key, { expr: item, count: 1 });
    }
    for (const child of exprChildren(item)) visit(child);
  };
  visit(expr);
  return found;
}

function matchSharedScalarCandidate(expr: Expr, ctx: LowerContext): boolean {
  if (hasRuntimeEffect(expr, ctx.functions)) return false;
  if (expr.kind !== "binary") return false;
  if (expr.op === "/" || expr.op === "%") {
    if (!binaryDivRemBySafeConstant(expr)) return false;
  } else if (expr.op !== "+") {
    return false;
  }
  if (!isSpeculableNonTrappingExpr(expr, ctx.functions)) return false;
  return flattenType(exprTypeWithLocals(expr, ctx), ctx.layouts).length === 1;
}

function lowerClosureMake(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.callee.kind !== "var" || !expr.callee.name.startsWith("@closure_make/")) {
    return undefined;
  }
  const target = expr.callee.name.slice("@closure_make/".length);
  const descriptor = ctx.closureDescriptors?.find((item) => item.target === target);
  const id = descriptor?.id ?? ctx.closureIds?.get(target);
  if (!descriptor || id === undefined) {
    return [{ op: "const", type: "i32", value: 0 }];
  }
  const ptr = heapTemp(ctx, locals, "closure_ptr");
  let offset = 4;
  const stores: Instr[] = [
    { op: "local.tee", name: ptr },
    { op: "const", type: "i32", value: id },
    { op: "store", type: "i32", align: 4, offset: 0 },
  ];
  for (const [captureIndex, capture] of descriptor.captures.entries()) {
    const value = expr.args[captureIndex] ??
      ({ kind: "literal", literalKind: "number", value: "0" } as Expr);
    const flat = flattenType(capture.type, ctx.layouts);
    const names = flat.map((slot, slotIndex) => {
      const name = `__closure_capture${ctx.tempIndex++}_${captureIndex}_${slotIndex}`;
      ctx.tempLocals.push({ name, type: slot.wat });
      locals.add(name);
      return name;
    });
    stores.push(
      ...lowerExpr(value, ctx, locals, capture.type),
      ...names.toReversed().map((name): Instr => ({ op: "local.set", name })),
    );
    for (const [slotIndex, slot] of flat.entries()) {
      const align = valueTypeByteSize(slot.wat);
      stores.push(
        { op: "local.get", name: ptr },
        { op: "local.get", name: names[slotIndex] ?? names[0] ?? "__closure_missing" },
        { op: "store", type: slot.wat, align, offset },
      );
      offset += align;
    }
  }
  return [
    ...lowerHeapAlloc([{ op: "const", type: "i32", value: Math.max(offset, 4) }], ctx, locals),
    ...stores,
    { op: "local.get", name: ptr },
  ];
}

function lowerClosureCall(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  const calleeType = exprTypeWithLocals(expr.callee, ctx);
  const resolvedCalleeType = resolveAlias(calleeType, ctx.layouts) ?? calleeType;
  const signature = parseBackendFnSignature(resolvedCalleeType);
  if (!signature) return undefined;
  const localCalleeType = expr.callee.kind === "var" ? varType(expr.callee.name, ctx) : undefined;
  if (
    expr.callee.kind === "var" && !localCalleeType && backendFunctionByName(expr.callee.name, ctx)
  ) {
    return undefined;
  }
  const key = closureSignatureKey(signature);
  ctx.closureDispatcherSignatures?.set(key, signature);
  return [
    ...lowerExpr(expr.callee, ctx, locals, calleeType),
    ...expr.args.flatMap((arg, index) =>
      lowerExpr(arg, ctx, locals, signature.params[index]?.type)
    ),
    { op: "call", name: closureDispatcherName(key) },
  ];
}

function closureSignatureKey(signature: ClosureSignature): string {
  return `${signature.params.map((param) => param.type).join(",")}->${signature.returnType}`;
}

function closureDispatcherName(key: string): string {
  return `__closure_dispatch_${wgslShaderId(key)}`;
}

function binaryDivRemBySafeConstant(expr: Extract<Expr, { kind: "binary" }>): boolean {
  const divisor = staticIntegerLiteral(expr.right);
  if (divisor === undefined || divisor === 0) return false;
  return expr.op !== "/" || divisor !== -1;
}

function exprReuseKeys(expr: Expr): Set<string> {
  const keys = new Set<string>();
  const visit = (item: Expr) => {
    const key = exprReuseKey(item);
    if (key) keys.add(key);
    for (const child of exprChildren(item)) visit(child);
  };
  visit(expr);
  return keys;
}

function replaceSharedSubexprs(expr: Expr, replacements: Map<string, Expr>): Expr {
  const key = exprReuseKey(expr);
  const replacement = key ? replacements.get(key) : undefined;
  if (replacement) return replacement;
  switch (expr.kind) {
    case "call":
      return {
        ...expr,
        callee: replaceSharedSubexprs(expr.callee, replacements),
        args: expr.args.map((arg) => replaceSharedSubexprs(arg, replacements)),
      };
    case "index":
      return {
        ...expr,
        target: replaceSharedSubexprs(expr.target, replacements),
        index: replaceSharedSubexprs(expr.index, replacements),
      };
    case "binary":
      return {
        ...expr,
        left: replaceSharedSubexprs(expr.left, replacements),
        right: replaceSharedSubexprs(expr.right, replacements),
      };
    case "operator_chain":
      return {
        ...expr,
        first: replaceSharedSubexprs(expr.first, replacements),
        rest: expr.rest.map((item) => ({
          ...item,
          value: replaceSharedSubexprs(item.value, replacements),
        })),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: replaceSharedSubexprs(expr.value, replacements),
        body: replaceSharedSubexprs(expr.body, replacements),
      };
    case "match":
      return {
        ...expr,
        value: replaceSharedSubexprs(expr.value, replacements),
        arms: expr.arms.map((arm) => ({
          ...arm,
          ...(arm.guard ? { guard: replaceSharedSubexprs(arm.guard, replacements) } : {}),
          value: replaceSharedSubexprs(arm.value, replacements),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: replaceSharedSubexprs(slot.value, replacements),
        })),
      };
    case "range":
      return {
        ...expr,
        start: replaceSharedSubexprs(expr.start, replacements),
        end: replaceSharedSubexprs(expr.end, replacements),
      };
    case "static_for_slots":
      return { ...expr, value: replaceSharedSubexprs(expr.value, replacements) };
    case "field":
      return {
        ...expr,
        value: replaceSharedSubexprs(expr.value, replacements),
        key: replaceSharedSubexprs(expr.key, replacements),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "let" || stmt.kind === "destructure_let"
            ? {
              ...stmt,
              value: replaceSharedSubexprs(stmt.value, replacements),
            } as Statement
            : stmt
        ),
        ...(expr.expr ? { expr: replaceSharedSubexprs(expr.expr, replacements) } : {}),
      };
    case "do":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
            ? {
              ...stmt,
              value: replaceSharedSubexprs(stmt.value, replacements),
            } as typeof stmt
            : stmt
        ),
        ...(expr.expr ? { expr: replaceSharedSubexprs(expr.expr, replacements) } : {}),
      };
    case "const_fn":
      return {
        ...expr,
        body: replaceSharedSubexprs(expr.body, replacements),
      };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => replaceSharedSubexprs(arg, replacements)),
        body: replaceSharedSubexprs(expr.body, replacements),
      };
    case "literal":
    case "var":
      return expr;
  }
}

function shouldMaterializeMatchValue(
  expr: Extract<Expr, { kind: "match" }>,
  ctx: LowerContext,
): boolean {
  if (expr.arms.some((arm) => arm.guard) && hasRuntimeEffect(expr.value, ctx.functions)) {
    return true;
  }
  const testedArms = expr.arms.filter((arm) => !isCatchAllPattern(arm.pattern));
  return testedArms.length > 1 && hasRuntimeEffect(expr.value, ctx.functions);
}

function lowerStepMatch(
  value: Expr,
  arms: MatchArm[],
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (arms.some((arm) => arm.guard)) return undefined;
  if (value.kind !== "call" || value.callee.kind !== "var") return undefined;
  const id = compilerCallId(value.callee.name, ctx.intrinsicIdsByName);
  if (id !== "index_cursor_next" && !isIndexCursorNextCallee(value.callee.name)) return undefined;
  const n = value.args.length >= 2
    ? value.args[value.args.length - 2]
    : constSpecializedCursorBound(value.callee.name, ctx.layouts);
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
  let yieldCtx = ctx;
  if (itemName) {
    scoped.add(itemName);
    ctx.tempLocals.push({ name: itemName, type: "i32" });
    const fact = indexFactForBoundExpr(n);
    if (fact) yieldCtx = ctxWithLocalScalarFact(yieldCtx, itemName, fact);
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
        ...lowerExpr(yieldArm.value, yieldCtx, scoped, expectedType),
      ],
      elseBody: lowerExpr(doneArm.value, ctx, locals, expectedType),
      branchHint: branchHintForStepArms(yieldArm, doneArm),
    },
  ];
}

function lowerPatternTest(
  pattern: ParamPattern,
  ctx?: LowerContext,
  locals?: Set<string>,
  valueType?: string,
): Instr[] {
  if (pattern.kind === "typed") return lowerTypedPatternTest(pattern, ctx, locals);
  if (pattern.kind === "as") return lowerPatternTest(pattern.pattern, ctx, locals, valueType);
  if (pattern.kind === "or") return lowerOrPatternTest(pattern, ctx, locals, valueType);
  if (pattern.kind === "product") return lowerProductPatternTest(pattern, ctx, locals, valueType);
  if (pattern.kind === "tuple") {
    if (!ctx || !locals) {
      return [
        ...pattern.items.map(() => ({ op: "drop" } as Instr)),
        { op: "const", type: "i32", value: 0 },
      ];
    }
    const itemTypes = tuplePatternItemTypes(pattern, valueType, ctx.layouts);
    const tempGroups = pattern.items.map((_item, itemIndex) => {
      const itemType = itemTypes[itemIndex];
      const slots = flattenType(itemType, ctx.layouts);
      return slots.map((slot, slotIndex) => {
        const name = `__match_tuple${ctx.tempIndex++}_${itemIndex}_${slotIndex}`;
        locals.add(name);
        ctx.tempLocals.push({ name, type: slot.wat });
        return name;
      });
    });
    const stores = tempGroups.flat().toReversed().map((name): Instr => ({
      op: "local.set",
      name,
    }));
    if (pattern.items.every((item) => isCatchAllPattern(item))) {
      return [...stores, { op: "const", type: "i32", value: 1 }];
    }
    const combined = pattern.items.reduce((body, item, index): Instr[] => {
      if (isCatchAllPattern(item)) return body;
      const test = lowerPatternTestFromTemps(
        item,
        itemTypes[index],
        tempGroups[index]!,
        ctx,
        locals,
      );
      return body.length ? [...body, ...test, { op: "binary", wasm: "i32.and" }] : test;
    }, [] as Instr[]);
    return [...stores, ...combined];
  }
  if (pattern.kind === "constructor" || pattern.kind === "type") {
    const variant = ctx
      ? sumVariantByNameForType(pattern.name, valueType, ctx.layouts) ??
        uniqueSumVariantByName(pattern.name, ctx.layouts)
      : undefined;
    if (variant) {
      return [
        { op: "const", type: "i32", value: variant.tag },
        { op: "binary", wasm: "i32.eq" },
      ];
    }
  }
  if (pattern.kind !== "literal" && pattern.kind !== "type") {
    return [{ op: "drop" }, {
      op: "const",
      type: "i32",
      value: pattern.kind === "wildcard" || pattern.kind === "binding" ? 1 : 0,
    }];
  }
  const text = pattern.kind === "literal" ? pattern.value : pattern.name;
  if (text === "true") {
    return [];
  }
  if (text === "false") return [{ op: "binary", wasm: "i32.eqz" }];
  if (pattern.kind === "literal") {
    const member = pattern.literalKind === "string"
      ? { kind: "string" as const, value: decodeStringLiteralValue(pattern.value) }
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

function lowerPatternTestFromTemps(
  pattern: ParamPattern,
  valueType: string | undefined,
  temps: string[],
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  if (isCatchAllPattern(pattern)) return [{ op: "const", type: "i32", value: 1 }];
  if (pattern.kind === "typed") {
    return lowerPatternTestFromTemps(pattern.pattern, pattern.type, temps, ctx, locals);
  }
  if (pattern.kind === "as") {
    return lowerPatternTestFromTemps(pattern.pattern, valueType, temps, ctx, locals);
  }
  if (pattern.kind === "or") {
    const tests = pattern.alternatives.map((alternative) =>
      lowerPatternTestFromTemps(alternative, valueType, temps, ctx, locals)
    );
    return combinePatternTests(tests, "i32.or");
  }
  if (pattern.kind === "product") {
    return [
      ...temps.map((name): Instr => ({ op: "local.get", name })),
      ...lowerProductPatternTest(pattern, ctx, locals, valueType),
    ];
  }
  if (pattern.kind === "constructor" || pattern.kind === "type") {
    const variant = sumVariantByNameForType(pattern.name, valueType, ctx.layouts) ??
      uniqueSumVariantByName(pattern.name, ctx.layouts);
    if (variant && temps[0]) {
      return [
        { op: "local.get", name: temps[0] },
        { op: "const", type: "i32", value: variant.tag },
        { op: "binary", wasm: "i32.eq" },
      ];
    }
  }
  if (pattern.kind === "tuple") {
    return [
      ...temps.map((name): Instr => ({ op: "local.get", name })),
      ...lowerPatternTest(pattern, ctx, locals, valueType),
    ];
  }
  if (temps.length !== 1) return [{ op: "const", type: "i32", value: 0 }];
  return [
    { op: "local.get", name: temps[0]! },
    ...lowerPatternTest(pattern, ctx, locals, valueType),
  ];
}

function lowerOrPatternBindingsFromTemps(
  alternatives: ParamPattern[],
  valueType: string | undefined,
  temps: string[],
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const [alternative, ...rest] = alternatives;
  if (!alternative) return [];
  const bindings = [
    ...temps.map((name): Instr => ({ op: "local.get", name })),
    ...lowerPatternBindings(alternative, ctx, locals, valueType),
  ];
  if (!rest.length) return bindings;
  return [
    ...temps.map((name): Instr => ({ op: "local.get", name })),
    ...lowerPatternTest(alternative, ctx, locals, valueType),
    {
      op: "if",
      results: [],
      thenBody: bindings,
      elseBody: lowerOrPatternBindingsFromTemps(rest, valueType, temps, ctx, locals),
    },
  ];
}

function lowerOrPatternTest(
  pattern: Extract<ParamPattern, { kind: "or" }>,
  ctx: LowerContext | undefined,
  locals: Set<string> | undefined,
  valueType: string | undefined,
): Instr[] {
  if (!ctx || !locals) return [{ op: "drop" }, { op: "const", type: "i32", value: 0 }];
  const slots = flattenType(valueType, ctx.layouts);
  const temps = slots.map((slot, index) => {
    const name = `__match_or${ctx.tempIndex++}_${index}`;
    locals.add(name);
    ctx.tempLocals.push({ name, type: slot.wat });
    return name;
  });
  const stores = temps.toReversed().map((name): Instr => ({ op: "local.set", name }));
  const tests = pattern.alternatives.map((alternative) => {
    return [
      ...temps.map((name): Instr => ({ op: "local.get", name })),
      ...lowerPatternTest(alternative, ctx, locals, valueType),
    ];
  });
  return [...stores, ...combinePatternTests(tests, "i32.or")];
}

function lowerProductPatternTest(
  pattern: Extract<ParamPattern, { kind: "product" }>,
  ctx: LowerContext | undefined,
  locals: Set<string> | undefined,
  valueType: string | undefined,
): Instr[] {
  if (!ctx || !locals) return [{ op: "drop" }, { op: "const", type: "i32", value: 0 }];
  const slots = productSlotsForType(valueType, ctx.layouts);
  if (!slots) {
    return [
      ...flattenType(valueType, ctx.layouts).map(() => ({ op: "drop" } as Instr)),
      { op: "const", type: "i32", value: 0 },
    ];
  }
  const fieldByLabel = new Map(pattern.fields.map((field) => [field.label, field]));
  const tempGroups = slots.map((slot, slotIndex) => {
    const flatSlots = flattenType(slot.type, ctx.layouts);
    return flatSlots.map((flatSlot, flatIndex) => {
      const name = `__match_product${ctx.tempIndex++}_${slotIndex}_${flatIndex}`;
      locals.add(name);
      ctx.tempLocals.push({ name, type: flatSlot.wat });
      return name;
    });
  });
  const stores = tempGroups.flat().toReversed().map((name): Instr => ({ op: "local.set", name }));
  const tests: Instr[][] = [];
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index]!;
    const label = slot.label ?? String(index);
    const field = fieldByLabel.get(label);
    if (!field || isCatchAllPattern(field.pattern)) continue;
    tests.push(
      lowerPatternTestFromTemps(field.pattern, slot.type, tempGroups[index]!, ctx, locals),
    );
  }
  return [...stores, ...combinePatternTests(tests, "i32.and")];
}

function combinePatternTests(tests: Instr[][], wasm: "i32.and" | "i32.or"): Instr[] {
  if (!tests.length) {
    const value = wasm === "i32.and" ? 1 : 0;
    return [{ op: "const", type: "i32", value }];
  }
  return tests.reduce((body, test): Instr[] => {
    if (!body.length) return test;
    return [...body, ...test, { op: "binary", wasm }];
  }, [] as Instr[]);
}

function lowerTypedPatternTest(
  pattern: Extract<ParamPattern, { kind: "typed" }>,
  ctx?: LowerContext,
  locals?: Set<string>,
): Instr[] {
  if (!ctx || !locals) {
    return [{ op: "drop" }, { op: "const", type: "i32", value: 0 }];
  }
  const name = `__match_typed${ctx.tempIndex++}`;
  locals.add(name);
  ctx.tempLocals.push({ name, type: "i32" });
  const value: Expr = { kind: "var", name };
  const tests: Instr[][] = [];
  const domain = parseRefinedI32Type(resolveAlias(pattern.type, ctx.layouts) ?? pattern.type);
  const domainTest = domain ? refinedI32MembershipTest(value, domain, ctx, locals) : undefined;
  if (domainTest) tests.push(domainTest);
  if (!isCatchAllPattern(pattern.pattern)) {
    tests.push([
      { op: "local.get", name },
      ...lowerPatternTest(pattern.pattern, ctx, locals, pattern.type),
    ]);
  }
  const combined = tests.reduce((body, test): Instr[] => {
    if (!body.length) return test;
    return [...body, ...test, { op: "binary", wasm: "i32.and" }];
  }, [] as Instr[]);
  return [
    { op: "local.set", name },
    ...(combined.length ? combined : [{ op: "const", type: "i32", value: 1 } as Instr]),
  ];
}

function removeUnreachablePrivateFunctions(
  functions: FnDecl[],
  extraRoots = new Set<string>(),
  cache?: BackendCache,
): FnDecl[] {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  const reachable = new Set<string>();
  const visit = (name: string) => {
    if (reachable.has(name)) return;
    const fn = byName.get(name);
    if (!fn) return;
    reachable.add(name);
    for (const called of cachedCalledFunctions(fn.body, cache)) visit(called);
  };
  for (const fn of functions) if (isCurrentModulePublic(fn)) visit(fn.name);
  for (const name of extraRoots) visit(name);
  return functions.filter((fn) => isCurrentModulePublic(fn) || reachable.has(fn.name));
}

function collectClosureDescriptors(sourceFns: FnDecl[], runtimeFns: FnDecl[]): ClosureDescriptor[] {
  const byName = new Map(runtimeFns.map((fn) => [fn.name, fn]));
  const seen = new Map<string, number>();
  const found: ClosureDescriptor[] = [];
  const visit = (expr: Expr | undefined) => {
    if (!expr) return;
    if (
      expr.kind === "call" && expr.callee.kind === "var" &&
      expr.callee.name.startsWith("@closure_make/")
    ) {
      const target = expr.callee.name.slice("@closure_make/".length);
      if (!seen.has(target)) {
        const fn = byName.get(target);
        if (fn?.returnType) {
          const captureCount = expr.args.length;
          const params = captureCount > 0 ? fn.params.slice(0, -captureCount) : fn.params;
          const captures = captureCount > 0 ? fn.params.slice(-captureCount) : [];
          const id = found.length + 1;
          seen.set(target, id);
          found.push({ id, target, params, captures, returnType: fn.returnType });
        }
      }
    }
    for (const child of exprChildren(expr)) visit(child);
  };
  for (const fn of sourceFns) visit(fn.body);
  return found;
}

function privateReturnProjectionPlans(
  functions: FnDecl[],
  layouts: LayoutEnv,
): Map<string, ReturnProjectionPlan> {
  const privateProductFns = new Map(
    functions.filter((fn) =>
      !isCurrentModulePublic(fn) && fn.returnType &&
      !isHeapArrayValueType(fn.returnType, layouts) &&
      !fn.params.some((param) => isRuntimeFunctionValueType(param.type, layouts)) &&
      !isRuntimeFunctionValueType(fn.returnType, layouts) &&
      flattenType(fn.returnType, layouts).length > 1
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
      if (stmt.kind === "type_assert") continue;
      if (stmt.kind === "debug_trace") {
        stmt.args.forEach((arg) => visitExpr(arg, currentFn));
        continue;
      }
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
    if (projected.length !== candidate.suffixes.size) continue;
    if (!projected.length || projected.length === slots.length) continue;
    plans.set(name, {
      suffixes: projected.map((slot) => slot.suffix),
      type: `struct({${projected.map((slot) => `${slot.suffix}: ${slot.type}`).join(", ")}})`,
    });
  }
  return plans;
}

function isHeapArrayValueType(type: string | undefined, layouts: LayoutEnv): boolean {
  const stripped = stripBorrowType(type);
  if (stripped && heapArrayItemType(stripped) !== undefined) return true;
  const resolved = resolveAlias(stripped, layouts);
  if (!resolved) return false;
  return heapArrayItemType(resolved) !== undefined;
}

function isRuntimeFunctionValueType(type: string | undefined, layouts: LayoutEnv): boolean {
  const trimmed = stripBorrowType(type)?.trim();
  if (!trimmed) return false;
  if (parseBackendFnSignature(trimmed)) return true;
  const resolved = resolveAlias(trimmed, layouts);
  return !!resolved && resolved !== trimmed && !!parseBackendFnSignature(resolved);
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
        ...expr.statements.flatMap((stmt) =>
          stmt.kind === "type_assert" ? [] : stmt.kind === "debug_trace" ? stmt.args : [stmt.value]
        ),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "const_fn":
      return [expr.body];
    case "profile":
      return [...expr.args, expr.body];
    case "call":
      if (expr.tailRec) return expr.args;
      return [expr.callee, ...expr.args];
    case "index":
      return [expr.target, expr.index];
    case "binary":
      return [expr.left, expr.right];
    case "operator_chain":
      return [expr.first, ...expr.rest.map((item) => item.value)];
    case "pipe_bind":
      return [expr.value, expr.body];
    case "match":
      return [
        expr.value,
        ...expr.arms.flatMap((arm) => arm.guard ? [arm.guard, arm.value] : [arm.value]),
      ];
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
        ...expr.statements.flatMap((stmt) =>
          stmt.kind === "type_assert" ? [] : stmt.kind === "debug_trace" ? stmt.args : [stmt.value]
        ),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "literal":
    case "var":
      return [];
  }
}

function callCountInExpr(expr: Expr | BlockExpr, name: string): number {
  let count = 0;
  const visit = (item: Expr | undefined) => {
    if (!item) return;
    if (item.kind === "call" && item.callee.kind === "var" && item.callee.name === name) count++;
    for (const child of exprChildren(item)) visit(child);
  };
  if (expr.kind === "block") {
    for (const stmt of expr.statements) {
      if (stmt.kind === "let" || stmt.kind === "destructure_let") visit(stmt.value);
      else if (stmt.kind === "debug_trace") stmt.args.forEach(visit);
    }
    visit(expr.expr);
  } else {
    visit(expr);
  }
  return count;
}

function cachedCallCountInExpr(
  expr: Expr | BlockExpr,
  name: string,
  cache?: BackendCache,
): number {
  const callCounts = cache?.backendCallCounts;
  if (!callCounts) return callCountInExpr(expr, name);
  let counts = callCounts.get(expr);
  if (!counts) {
    counts = new Map();
    callCounts.set(expr, counts);
  }
  const cached = counts.get(name);
  if (cached !== undefined) return cached;
  const count = callCountInExpr(expr, name);
  counts.set(name, count);
  return count;
}

function removeUnreachableBackendFunctions(functions: BackendFunction[]): BackendFunction[] {
  const byName = new Map(functions.map((fn) => [fn.name, fn]));
  const reachable = new Set<string>();
  const visit = (name: string) => {
    if (reachable.has(name)) return;
    const fn = byName.get(name);
    if (!fn) return;
    reachable.add(name);
    visitCalledBackendFunctions(fn.body, visit);
  };
  for (const fn of functions) {
    if (fn.exportName) visit(fn.name);
  }
  return functions.filter((fn) => reachable.has(fn.name));
}

function visitCalledBackendFunctions(instrs: Instr[], visitName: (name: string) => void) {
  const visit = (instr: Instr) => {
    if (instr.op === "call" || instr.op === "return_call") {
      visitName(instr.name);
      return;
    }
    if (instr.op === "if") {
      for (const child of instr.thenBody) visit(child);
      for (const child of instr.elseBody) visit(child);
      return;
    }
    if (instr.op === "block" || instr.op === "loop") {
      for (const child of instr.body) visit(child);
    }
  };
  for (const instr of instrs) visit(instr);
}

interface TailCallAnalysis {
  hasDirectSelfCall: boolean;
  hasExplicitRec: boolean;
  hasOnlyTailDirectSelfCalls: boolean;
}

function analyzeTailCalls(fn: FnDecl): TailCallAnalysis {
  const hasDirectSelfCall = hasSelfCall(fn.body, fn.name);
  const hasExplicitRec = hasExplicitRecCall(fn.body);
  return {
    hasDirectSelfCall,
    hasExplicitRec,
    hasOnlyTailDirectSelfCalls: (hasDirectSelfCall || hasExplicitRec) &&
      blockHasOnlyTailSelfCalls(fn.body, fn.name),
  };
}

function cachedAnalyzeTailCalls(fn: FnDecl, cache?: BackendCache): TailCallAnalysis {
  const tailCalls = cache?.backendTailCalls;
  if (!tailCalls) return analyzeTailCalls(fn);
  const cached = tailCalls.get(fn);
  if (cached) return cached;
  const analysis = analyzeTailCalls(fn);
  tailCalls.set(fn, analysis);
  return analysis;
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
  if (
    expr.kind === "call" &&
    (expr.tailRec || (expr.callee.kind === "var" && expr.callee.name === name))
  ) {
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
    case "type_assert":
    case "debug_trace":
      return false;
  }
}

function exprHasSelfCall(expr: Expr, name: string): boolean {
  switch (expr.kind) {
    case "do":
      return expr.expr ? exprHasSelfCall(expr.expr, name) : false;
    case "const_fn":
      return exprHasSelfCall(expr.body, name);
    case "profile":
      return expr.args.some((arg) => exprHasSelfCall(arg, name)) ||
        exprHasSelfCall(expr.body, name);
    case "call":
      return expr.tailRec ||
        (expr.callee.kind === "var" && expr.callee.name === name) ||
        exprHasSelfCall(expr.callee, name) ||
        expr.args.some((arg) => exprHasSelfCall(arg, name));
    case "index":
      return exprHasSelfCall(expr.target, name) || exprHasSelfCall(expr.index, name);
    case "binary":
      return exprHasSelfCall(expr.left, name) || exprHasSelfCall(expr.right, name);
    case "operator_chain":
      return exprHasSelfCall(expr.first, name) ||
        expr.rest.some((item) => exprHasSelfCall(item.value, name));
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
      return false;
  }
}

function hasExplicitRecCall(block: BlockExpr): boolean {
  for (const stmt of block.statements) {
    if (stmt.kind === "let" || stmt.kind === "destructure_let") {
      if (exprHasExplicitRecCall(stmt.value)) return true;
    } else if (stmt.kind === "debug_trace") {
      for (const arg of stmt.args) {
        if (exprHasExplicitRecCall(arg)) return true;
      }
    }
  }
  if (block.expr && exprHasExplicitRecCall(block.expr)) return true;
  return false;
}

function exprHasExplicitRecCall(expr: Expr): boolean {
  if (expr.kind === "call" && expr.tailRec) return true;
  return exprChildren(expr).some((child) => exprHasExplicitRecCall(child));
}

function calledFunctions(expr: Expr | BlockExpr): Set<string> {
  const calls = new Set<string>();
  const visit = (item: Expr | Statement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "do":
        for (const stmt of item.statements) {
          if (stmt.kind === "debug_trace") stmt.args.forEach(visit);
          else if (stmt.kind !== "type_assert") visit(stmt.value);
        }
        visit(item.expr);
        return;
      case "let":
        visit(item.value);
        return;
      case "destructure_let":
        visit(item.value);
        return;
      case "type_assert":
      case "literal":
      case "var":
        return;
      case "const_fn":
        visit(item.body);
        return;
      case "profile":
        for (const arg of item.args) visit(arg);
        visit(item.body);
        return;
      case "call":
        if (item.tailRec) {
          for (const arg of item.args) visit(arg);
          return;
        }
        if (item.callee.kind === "var") {
          calls.add(item.callee.name);
          if (item.callee.name === "@empty") {
            const emptyType = item.args[0] ? renderBackendTypeProofArg(item.args[0]) : undefined;
            if (emptyType) calls.add(`${emptyType}::empty`);
          }
        }
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
      case "operator_chain":
        visit(item.first);
        for (const part of item.rest) visit(part.value);
        return;
      case "pipe_bind":
        visit(item.value);
        visit(item.body);
        return;
      case "match":
        visit(item.value);
        for (const arm of item.arms) {
          visit(arm.guard);
          visit(arm.value);
        }
        return;
      case "shape":
      case "product_constructor":
        for (const slot of item.slots) {
          visit(slot.index);
          visit(slot.value);
        }
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
        if (item.source.kind === "range") {
          visit(item.source.start);
          visit(item.source.end);
        } else {
          visit(item.source.shape);
        }
        visit(item.value);
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

function cachedCalledFunctions(expr: Expr | BlockExpr, cache?: BackendCache): Set<string> {
  const bodyCalls = cache?.backendBodyCalls;
  if (!bodyCalls) return calledFunctions(expr);
  const cached = bodyCalls.get(expr);
  if (cached) return cached;
  const calls = calledFunctions(expr);
  bodyCalls.set(expr, calls);
  return calls;
}

export function backendModuleToWat(module: BackendModule): string {
  const functionAliases = watFunctionAliases(module.functions);
  const imports = module.imports.map((item) => emitImportWat(item));
  const memory = module.memories.map((item) => emitMemoryWat(item));
  const data = module.data.map((item) => emitDataWat(item));
  const functions = module.functions.map((fn) => emitFunctionWat(fn, functionAliases));
  return `(module\n${[...imports, ...memory, ...data, ...functions].join("\n")}\n)`;
}

export function watFromBackendModule(module: BackendModule): string {
  return backendModuleToWat(module);
}

function watFunctionAliases(functions: BackendFunction[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const fn of functions) {
    if (!isGeneratedWatHelper(fn)) continue;
    aliases.set(fn.name, `f${aliases.size}`);
  }
  return aliases;
}

function isGeneratedWatHelper(fn: BackendFunction): boolean {
  if (fn.exportName) return false;
  return fn.name.startsWith("__inl_array_") ||
    fn.name.startsWith("array.") ||
    fn.name.startsWith("array_") ||
    fn.name.startsWith("layout.") ||
    fn.name.startsWith("layout_");
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
    `(func $${watName(item.name)} (import "env" "${watName(item.importName ?? item.name)}")`,
    ...item.params.map((param) => `(param ${param})`),
    ...item.results.map((result) => `(result ${result})`),
  ].join(" ");
  return `  ${signature})`;
}

function emitFunctionWat(
  fn: BackendFunction,
  functionAliases: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  const localAliases = watLocalAliases(fn);
  const exportPart = fn.exportName ? ` (export "${fn.exportName}")` : "";
  const signature = [
    `(func $${watFunctionName(fn.name, functionAliases)}${exportPart}`,
    ...fn.params.map((param) => `(param $${watLocalName(param.name, localAliases)} ${param.type})`),
    ...fn.results.map((result) => `(result ${result})`),
  ].join(" ");
  lines.push(`  ${signature}`);
  lines.push(...emitLocalDeclsWat(fn.locals, localAliases));
  lines.push(...emitInstrsWat(fn.body, 4, localAliases, functionAliases));
  lines.push("  )");
  return lines.join("\n");
}

function watFunctionName(name: string, aliases: ReadonlyMap<string, string>): string {
  return aliases.get(name) ?? watName(name);
}

function watLocalAliases(fn: BackendFunction): Map<string, string> {
  const aliases = new Map<string, string>();
  const generated = isGeneratedWatHelper(fn);
  const locals = generated ? [...fn.params, ...fn.locals] : fn.locals;
  for (const local of locals) {
    if (!generated && !/^(__inl_array_Iter|__slot_tmp)/.test(local.name)) {
      continue;
    }
    if (aliases.has(local.name)) continue;
    aliases.set(local.name, `l${aliases.size}`);
  }
  return aliases;
}

function emitLocalDeclsWat(
  locals: BackendFunction["locals"],
  aliases: ReadonlyMap<string, string>,
): string[] {
  const groups: { type: ValueType; names: string[] }[] = [];
  for (const local of locals) {
    const group = groups.at(-1);
    if (group?.type === local.type) {
      group.names.push(local.name);
    } else {
      groups.push({ type: local.type, names: [local.name] });
    }
  }
  return groups.map((group) =>
    `    (local ${
      group.names.map((name) => `$${watLocalName(name, aliases)}`).join(" ")
    } ${group.type})`
  );
}

function emitInstrsWat(
  instrs: Instr[],
  indent: number,
  localAliases: ReadonlyMap<string, string> = new Map(),
  functionAliases: ReadonlyMap<string, string> = new Map(),
): string[] {
  return instrs.flatMap((instr) => emitInstrWat(instr, indent, localAliases, functionAliases));
}

function emitInstrWat(
  instr: Instr,
  indent: number,
  localAliases: ReadonlyMap<string, string>,
  functionAliases: ReadonlyMap<string, string>,
): string[] {
  const prefix = spaces(indent);
  switch (instr.op) {
    case "const":
      return [`${prefix}${instr.type}.const ${instr.value}`];
    case "local.get":
      return [`${prefix}local.get $${watLocalName(instr.name, localAliases)}`];
    case "local.set":
      return [`${prefix}local.set $${watLocalName(instr.name, localAliases)}`];
    case "local.tee":
      return [`${prefix}local.tee $${watLocalName(instr.name, localAliases)}`];
    case "call":
      return [`${prefix}call $${watFunctionName(instr.name, functionAliases)}`];
    case "return_call":
      return [`${prefix}return_call $${watFunctionName(instr.name, functionAliases)}`];
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
    case "memory.size":
      return [`${prefix}memory.size${watMemidx(instr.memory)}`];
    case "memory.grow":
      return [`${prefix}memory.grow${watMemidx(instr.memory)}`];
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
        ...emitInstrsWat(instr.thenBody, indent + 2, localAliases, functionAliases),
        `${prefix}else`,
        ...emitInstrsWat(instr.elseBody, indent + 2, localAliases, functionAliases),
        `${prefix}end`,
      ];
    case "block":
      return [
        `${prefix}block${(instr.results ?? []).map((result) => ` (result ${result})`).join("")}`,
        ...emitInstrsWat(instr.body, indent + 2, localAliases, functionAliases),
        `${prefix}end`,
      ];
    case "loop":
      return [
        `${prefix}loop${(instr.results ?? []).map((result) => ` (result ${result})`).join("")}`,
        ...emitInstrsWat(instr.body, indent + 2, localAliases, functionAliases),
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

export function backendModuleToWasm(
  module: BackendModule,
  options: { debugNames?: boolean; cache?: BackendCache; trace?: CompileTraceSink } = {},
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
        ...nameBytes(fn.importName ?? fn.name),
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
  for (const custom of module.customSections ?? []) {
    section(bytes, 0, [...nameBytes(custom.name), ...custom.bytes]);
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
    const memoryIndex = new Map(module.memories.map((memory, index) => [memory.name, index]));
    const encodeEnvironmentKey = wasmFunctionEncodeEnvironmentKey(
      module,
      typeKeys,
      memoryIndex,
    );
    let wasmFunctionCacheHits = 0;
    let wasmFunctionCacheMisses = 0;
    const encodedFunctions = module.functions.map((fn, index) => {
      const encoded = cachedEncodeFunction(
        fn,
        module.imports.length + index,
        funcIndex,
        typeKeys,
        memoryIndex,
        encodeEnvironmentKey,
        options.cache,
      );
      if (encoded.cacheHit) wasmFunctionCacheHits++;
      else wasmFunctionCacheMisses++;
      return encoded;
    });
    traceInstant(options.trace, "wasm.encode.function_cache", {
      cacheHits: wasmFunctionCacheHits,
      cacheMisses: wasmFunctionCacheMisses,
    });
    if (module.branchHints) {
      const branchHintSection = wasmBranchHintSection(encodedFunctions);
      if (branchHintSection) section(bytes, 0, branchHintSection);
    }
    sectionVecItems(bytes, 10, encodedFunctions.map((fn) => fn.bytes));
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
    const cachedNameSection = cachedWasmNameSection(module, allFns, options.cache);
    let nameSectionCacheHits = 0;
    let nameSectionCacheMisses = 1;
    if (cachedNameSection.cacheHit) {
      nameSectionCacheHits = 1;
      nameSectionCacheMisses = 0;
    }
    traceInstant(options.trace, "wasm.encode.name_section_cache", {
      cacheHits: nameSectionCacheHits,
      cacheMisses: nameSectionCacheMisses,
    });
    section(bytes, 0, cachedNameSection.bytes);
  }
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

export function wasmFromBackendModule(
  module: BackendModule,
  options: { debugNames?: boolean; cache?: BackendCache; trace?: CompileTraceSink } = {},
): Uint8Array<ArrayBuffer> {
  return backendModuleToWasm(module, options);
}

function wasmNameSection(
  module: BackendModule,
  allFns: (BackendImport | BackendFunction)[],
): number[] {
  const subsections: number[] = [];
  const functionNames: number[] = [];
  functionNames.push(...uleb(allFns.length));
  for (let index = 0; index < allFns.length; index++) {
    const fn = allFns[index]!;
    functionNames.push(...uleb(index));
    appendNameBytes(functionNames, fn.name);
  }
  nameSubsection(subsections, 1, functionNames);

  const localNameEntries: number[] = [];
  let localNameEntryCount = 0;
  for (let functionIndex = 0; functionIndex < module.functions.length; functionIndex++) {
    const fn = module.functions[functionIndex]!;
    const localCount = fn.params.length + fn.locals.length;
    if (!localCount) continue;
    localNameEntryCount++;
    localNameEntries.push(...uleb(module.imports.length + functionIndex));
    localNameEntries.push(...uleb(localCount));
    let localIndex = 0;
    for (const local of fn.params) {
      localNameEntries.push(...uleb(localIndex));
      appendNameBytes(localNameEntries, local.name);
      localIndex++;
    }
    for (const local of fn.locals) {
      localNameEntries.push(...uleb(localIndex));
      appendNameBytes(localNameEntries, local.name);
      localIndex++;
    }
  }
  if (localNameEntryCount) {
    nameSubsection(subsections, 2, [...uleb(localNameEntryCount), ...localNameEntries]);
  }

  const bytes: number[] = [];
  appendNameBytes(bytes, "name");
  for (const byte of subsections) bytes.push(byte);
  return bytes;
}

function cachedWasmNameSection(
  module: BackendModule,
  allFns: (BackendImport | BackendFunction)[],
  cache: BackendCache | undefined,
): { bytes: number[]; cacheHit: boolean } {
  const sections = cache?.wasmNameSections;
  if (!sections) return { bytes: wasmNameSection(module, allFns), cacheHit: false };
  const key = wasmNameSectionCacheKey(module, allFns);
  const cached = sections.get(key);
  if (cached) return { bytes: cached, cacheHit: true };
  const bytes = wasmNameSection(module, allFns);
  sections.set(key, bytes);
  return { bytes, cacheHit: false };
}

function wasmNameSectionCacheKey(
  module: BackendModule,
  allFns: (BackendImport | BackendFunction)[],
): string {
  const parts: string[] = [];
  for (const fn of allFns) {
    parts.push("fn", fn.name);
    for (const param of fn.params) {
      if (typeof param === "string") {
        parts.push(param);
      } else {
        parts.push(param.name, param.type);
      }
    }
    for (const result of fn.results) parts.push(result);
  }
  for (const fn of module.functions) {
    parts.push("locals", fn.name);
    for (const local of fn.locals) parts.push(local.name, local.type);
  }
  return wasmCacheHashString(parts.join("\0"));
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
  memoryIndex: Map<string, number>,
): { bytes: number[]; branchHints: FunctionBranchHints } {
  const localIndex = new Map<string, number>();
  let localSlotIndex = 0;
  for (const slot of fn.params) {
    localIndex.set(slot.name, localSlotIndex);
    localSlotIndex++;
  }
  for (const slot of fn.locals) {
    localIndex.set(slot.name, localSlotIndex);
    localSlotIndex++;
  }
  const locals = localDecls(fn.locals);
  let encoded: { bytes: number[]; hints: BranchHintEntry[] };
  try {
    encoded = encodeInstrsWithBranchHints(
      fn.body,
      localIndex,
      funcIndex,
      typeKeys,
      memoryIndex,
      locals.length,
    );
  } catch (error) {
    if (!(error instanceof RangeError && /call stack/i.test(error.message))) throw error;
    encoded = {
      bytes: encodeInstrs(fn.body, localIndex, funcIndex, typeKeys, memoryIndex),
      hints: [],
    };
  }
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

function cachedEncodeFunction(
  fn: BackendFunction,
  functionIndex: number,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
  memoryIndex: Map<string, number>,
  environmentKey: string,
  cache: BackendCache | undefined,
): { bytes: number[]; branchHints: FunctionBranchHints; cacheHit: boolean } {
  const wasmFunctions = cache?.wasmFunctions;
  const cached = wasmFunctions?.get(fn);
  if (cached?.environmentKey === environmentKey) {
    return {
      bytes: cached.bytes,
      branchHints: { functionIndex, hints: cached.hints },
      cacheHit: true,
    };
  }
  const encoded = encodeFunction(fn, functionIndex, funcIndex, typeKeys, memoryIndex);
  wasmFunctions?.set(fn, {
    environmentKey,
    bytes: encoded.bytes,
    hints: encoded.branchHints.hints,
  });
  return { ...encoded, cacheHit: false };
}

function wasmFunctionEncodeEnvironmentKey(
  module: BackendModule,
  typeKeys: Map<string, number>,
  memoryIndex: Map<string, number>,
): string {
  const parts: string[] = [];
  parts.push("imports");
  for (const item of module.imports) {
    parts.push(item.name, item.importName ?? "", item.params.join(","), item.results.join(","));
  }
  parts.push("functions");
  for (const item of module.functions) {
    parts.push(item.name, item.params.map((param) => param.type).join(","), item.results.join(","));
  }
  parts.push("types");
  for (const [key, index] of typeKeys) {
    parts.push(`${index}:${key}`);
  }
  parts.push("memories");
  for (const [name, index] of memoryIndex) {
    parts.push(`${index}:${name}`);
  }
  return wasmCacheHashString(parts.join("\0"));
}

function wasmCacheHashString(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

interface FunctionBranchHints {
  functionIndex: number;
  hints: BranchHintEntry[];
}

export interface BranchHintEntry {
  offset: number;
  hint: BranchHint;
}

function encodeInstrsWithBranchHints(
  instrs: Instr[],
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
  memoryIndex: Map<string, number>,
  startOffset: number,
): { bytes: number[]; hints: BranchHintEntry[] } {
  const bytes: number[] = [];
  const hints: BranchHintEntry[] = [];
  for (const instr of instrs) {
    const offset = startOffset + bytes.length;
    if ((instr.op === "if" || instr.op === "br_if") && instr.branchHint) {
      hints.push({ offset, hint: instr.branchHint });
    }
    const encoded = encodeInstrWithBranchHints(
      instr,
      locals,
      funcIndex,
      typeKeys,
      memoryIndex,
      offset,
    );
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
  memoryIndex: Map<string, number>,
  offset: number,
): { bytes: number[]; hints: BranchHintEntry[] } {
  if (instr.op === "if") {
    const prefix = [0x04, ...blockType(instr.results, typeKeys)];
    const thenEncoded = encodeInstrsWithBranchHints(
      instr.thenBody,
      locals,
      funcIndex,
      typeKeys,
      memoryIndex,
      offset + prefix.length,
    );
    const elseOffset = offset + prefix.length + thenEncoded.bytes.length + 1;
    const elseEncoded = encodeInstrsWithBranchHints(
      instr.elseBody,
      locals,
      funcIndex,
      typeKeys,
      memoryIndex,
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
      memoryIndex,
      offset + prefix.length,
    );
    return { bytes: [...prefix, ...body.bytes, 0x0b], hints: body.hints };
  }
  return { bytes: encodeInstr(instr, locals, funcIndex, typeKeys, memoryIndex), hints: [] };
}

function encodeInstrs(
  instrs: Instr[],
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
  memoryIndex: Map<string, number>,
): number[] {
  const bytes: number[] = [];
  appendEncodedInstrs(bytes, instrs, locals, funcIndex, typeKeys, memoryIndex);
  return bytes;
}

function encodeInstr(
  instr: Instr,
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
  memoryIndex: Map<string, number>,
): number[] {
  const bytes: number[] = [];
  appendEncodedInstr(bytes, instr, locals, funcIndex, typeKeys, memoryIndex);
  return bytes;
}

function appendEncodedInstrs(
  bytes: number[],
  instrs: Instr[],
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
  memoryIndex: Map<string, number>,
) {
  for (const instr of instrs) {
    appendEncodedInstr(bytes, instr, locals, funcIndex, typeKeys, memoryIndex);
  }
}

function appendEncodedInstr(
  bytes: number[],
  instr: Instr,
  locals: Map<string, number>,
  funcIndex: Map<string, number>,
  typeKeys: Map<string, number>,
  memoryIndex: Map<string, number>,
) {
  switch (instr.op) {
    case "const":
      if (instr.type === "i64") bytes.push(0x42);
      else bytes.push(0x41);
      bytes.push(...sleb(instr.value));
      return;
    case "local.get": {
      const index = locals.get(instr.name);
      if (index === undefined) {
        bytes.push(0x41, 0);
        return;
      }
      bytes.push(0x20, ...uleb(index));
      return;
    }
    case "local.set": {
      const index = locals.get(instr.name);
      if (index === undefined) {
        bytes.push(0x1a);
        return;
      }
      bytes.push(0x21, ...uleb(index));
      return;
    }
    case "local.tee": {
      const index = locals.get(instr.name);
      if (index === undefined) {
        bytes.push(0x1a);
        return;
      }
      bytes.push(0x22, ...uleb(index));
      return;
    }
    case "call": {
      const index = funcIndex.get(instr.name);
      if (index === undefined) throw new Error(`backend missing lowered callable: ${instr.name}`);
      bytes.push(0x10, ...uleb(index));
      return;
    }
    case "return_call": {
      const index = funcIndex.get(instr.name);
      if (index === undefined) throw new Error(`backend missing lowered callable: ${instr.name}`);
      bytes.push(0x12, ...uleb(index));
      return;
    }
    case "select":
      bytes.push(0x1b);
      return;
    case "binary":
      bytes.push(wasmBinaryOp(instr.wasm));
      return;
    case "unary":
      bytes.push(wasmUnaryOp(instr.wasm));
      return;
    case "simd":
      bytes.push(...simdImmediate(instr.wasm, instr.lane, instr.lanes));
      return;
    case "load":
      bytes.push(...wasmLoadOp(instr.type));
      bytes.push(...memarg(instr.align, instr.offset, memoryIndexFor(instr.memory, memoryIndex)));
      return;
    case "store":
      bytes.push(...wasmStoreOp(instr.type));
      bytes.push(...memarg(instr.align, instr.offset, memoryIndexFor(instr.memory, memoryIndex)));
      return;
    case "memory.size":
      bytes.push(0x3f, ...uleb(memoryIndexFor(instr.memory, memoryIndex)));
      return;
    case "memory.grow":
      bytes.push(0x40, ...uleb(memoryIndexFor(instr.memory, memoryIndex)));
      return;
    case "memory.copy":
      bytes.push(0xfc);
      bytes.push(...uleb(0x0a));
      bytes.push(...uleb(memoryIndexFor(instr.memory, memoryIndex)));
      bytes.push(...uleb(memoryIndexFor(instr.memory, memoryIndex)));
      return;
    case "drop":
      bytes.push(0x1a);
      return;
    case "unreachable":
      bytes.push(0x00);
      return;
    case "if":
      bytes.push(0x04, ...blockType(instr.results, typeKeys));
      appendEncodedInstrs(bytes, instr.thenBody, locals, funcIndex, typeKeys, memoryIndex);
      bytes.push(0x05);
      appendEncodedInstrs(bytes, instr.elseBody, locals, funcIndex, typeKeys, memoryIndex);
      bytes.push(0x0b);
      return;
    case "block":
      bytes.push(0x02, ...blockType(instr.results, typeKeys));
      appendEncodedInstrs(bytes, instr.body, locals, funcIndex, typeKeys, memoryIndex);
      bytes.push(0x0b);
      return;
    case "loop":
      bytes.push(0x03, ...blockType(instr.results, typeKeys));
      appendEncodedInstrs(bytes, instr.body, locals, funcIndex, typeKeys, memoryIndex);
      bytes.push(0x0b);
      return;
    case "br":
      bytes.push(0x0c, ...uleb(instr.depth));
      return;
    case "br_if":
      bytes.push(0x0d, ...uleb(instr.depth));
      return;
  }
}

function lowerPowerOfTwoMultiply(
  expr: Extract<Expr, { kind: "binary" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.op !== "*") return undefined;
  const rightShift = powerOfTwoShift(expr.right);
  if (rightShift !== undefined) {
    return [
      ...lowerExpr(expr.left, ctx, locals),
      { op: "const", type: "i32", value: rightShift },
      { op: "binary", wasm: "i32.shl" },
    ];
  }
  const leftShift = powerOfTwoShift(expr.left);
  if (leftShift !== undefined) {
    return [
      ...lowerExpr(expr.right, ctx, locals),
      { op: "const", type: "i32", value: leftShift },
      { op: "binary", wasm: "i32.shl" },
    ];
  }
  return undefined;
}

function lowerI32FactComparison(
  expr: Extract<Expr, { kind: "binary" }>,
  ctx: LowerContext,
): Instr[] | undefined {
  const leftFacts = exprI32Facts(expr.left, ctx);
  const rightLiteral = staticIntegerLiteral(expr.right);
  if (leftFacts && rightLiteral !== undefined) {
    const folded = compareFactsWithLiteral(leftFacts, expr.op, rightLiteral);
    if (folded !== undefined) return [{ op: "const", type: "i32", value: folded ? 1 : 0 }];
  }
  const rightFacts = exprI32Facts(expr.right, ctx);
  const leftLiteral = staticIntegerLiteral(expr.left);
  if (rightFacts && leftLiteral !== undefined) {
    const folded = compareLiteralWithFacts(leftLiteral, expr.op, rightFacts);
    if (folded !== undefined) return [{ op: "const", type: "i32", value: folded ? 1 : 0 }];
  }
  return undefined;
}

function compareFactsWithLiteral(
  facts: ScalarFacts,
  op: string,
  literal: number,
): boolean | undefined {
  const range = scalarFactsNumericRange(facts);
  if (op === "==") {
    if (scalarFactsContainsFacts(scalarFactsFromI32Range({ min: literal, max: literal }), facts)) {
      return true;
    }
    return scalarFactsContainsLiteral(facts, literal) ? undefined : false;
  }
  if (op === "!=") {
    const equal = compareFactsWithLiteral(facts, "==", literal);
    return equal === undefined ? undefined : !equal;
  }
  if (!range) return undefined;
  if (op === "<") {
    if (range.max < literal) return true;
    if (range.min >= literal) return false;
  }
  if (op === "<=") {
    if (range.max <= literal) return true;
    if (range.min > literal) return false;
  }
  if (op === ">") {
    if (range.min > literal) return true;
    if (range.max <= literal) return false;
  }
  if (op === ">=") {
    if (range.min >= literal) return true;
    if (range.max < literal) return false;
  }
  return undefined;
}

function compareLiteralWithFacts(
  literal: number,
  op: string,
  facts: ScalarFacts,
): boolean | undefined {
  const swapped = swapComparisonOp(op);
  return swapped ? compareFactsWithLiteral(facts, swapped, literal) : undefined;
}

function swapComparisonOp(op: string): string | undefined {
  if (op === "<") return ">";
  if (op === "<=") return ">=";
  if (op === ">") return "<";
  if (op === ">=") return "<=";
  if (op === "==" || op === "!=") return op;
  return undefined;
}

function lowerPowerOfTwoDivRem(
  expr: Extract<Expr, { kind: "binary" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.op !== "/" && expr.op !== "%") return undefined;
  const shift = powerOfTwoShift(expr.right);
  if (shift === undefined) return undefined;
  const divisor = 2 ** shift;
  if (divisor <= 1) return undefined;
  if (exprIsKnownNonNegative(expr.left, ctx)) {
    const reduced = lowerNonNegativePowerOfTwoDivRem(expr, shift, divisor, ctx, locals);
    if (reduced) return reduced;
  }
  const quotient = lowerSignedPowerOfTwoQuotient(expr.left, shift, divisor - 1, ctx, locals);
  if (expr.op === "/") return quotient;
  return [
    ...lowerExpr(expr.left, ctx, locals),
    ...quotient,
    { op: "const", type: "i32", value: shift },
    { op: "binary", wasm: "i32.shl" },
    { op: "binary", wasm: "i32.sub" },
  ];
}

function lowerNonNegativePowerOfTwoDivRem(
  expr: Extract<Expr, { kind: "binary" }>,
  shift: number,
  divisor: number,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  return [
    ...lowerExpr(expr.left, ctx, locals),
    { op: "const", type: "i32", value: expr.op === "/" ? shift : divisor - 1 },
    { op: "binary", wasm: expr.op === "/" ? "i32.shr_u" : "i32.and" },
  ];
}

function lowerNonNegativeConstDivRem(
  expr: Extract<Expr, { kind: "binary" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.op !== "/" && expr.op !== "%") return undefined;
  if (!exprIsKnownNonNegative(expr.left, ctx)) return undefined;
  const divisor = staticIntegerLiteral(expr.right);
  if (divisor === undefined || divisor <= 1 || divisor > 0xffff) return undefined;
  if ((divisor & (divisor - 1)) === 0) return undefined;
  const magic = unsignedDivisionMagic(divisor);
  if (!magic) return undefined;
  const quotient: Instr[] = [
    ...lowerExpr(expr.left, ctx, locals),
    { op: "unary", wasm: "i64.extend_i32_u" },
    { op: "const", type: "i64", value: magic.multiplier },
    { op: "binary", wasm: "i64.mul" },
    { op: "const", type: "i64", value: magic.shift },
    { op: "binary", wasm: "i64.shr_u" },
    { op: "unary", wasm: "i32.wrap_i64" },
  ];
  if (expr.op === "/") return quotient;
  return [
    ...lowerExpr(expr.left, ctx, locals),
    ...quotient,
    { op: "const", type: "i32", value: divisor },
    { op: "binary", wasm: "i32.mul" },
    { op: "binary", wasm: "i32.sub" },
  ];
}

function unsignedDivisionMagic(divisor: number): { multiplier: number; shift: number } | undefined {
  const shift = 32 + Math.floor(Math.log2(divisor));
  const numerator = 1n << BigInt(shift);
  const multiplier = (numerator + BigInt(divisor) - 1n) / BigInt(divisor);
  if (multiplier > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { multiplier: Number(multiplier), shift };
}

function oddModInverse32(divisor: number): number | undefined {
  if (divisor <= 1 || (divisor & 1) === 0) return undefined;
  const modulus = 1n << 32n;
  let t = 0n;
  let nextT = 1n;
  let r = modulus;
  let nextR = BigInt(divisor >>> 0);
  while (nextR !== 0n) {
    const quotient = r / nextR;
    const previousT = t;
    t = nextT;
    nextT = previousT - quotient * nextT;
    const previousR = r;
    r = nextR;
    nextR = previousR - quotient * nextR;
  }
  if (r !== 1n) return undefined;
  if (t < 0n) t += modulus;
  return Number(t);
}

function signedI32Const(value: number): number {
  const unsigned = value >>> 0;
  return unsigned > I32_MAX ? unsigned - 0x1_0000_0000 : unsigned;
}

function exprIsKnownNonNegative(expr: Expr, ctx: LowerContext): boolean {
  return scalarFactsAreNonNegative(exprI32Facts(expr, ctx));
}

function nonNegativeI32Fact(): ScalarFacts {
  return scalarFactsFromI32Range({ min: 0, max: I32_MAX });
}

function scalarFactsForFunctionParams(
  fn: FnDecl,
  ctx: Pick<LowerContext, "layouts" | "scalarParamFactsByFunction" | "localScalarFacts">,
  sourceName = fn.name,
  renames = new Map<string, string>(),
): Map<string, ScalarFacts> {
  const facts = new Map(ctx.localScalarFacts);
  for (const [name, fact] of ctx.scalarParamFactsByFunction?.get(sourceName) ?? []) {
    mergeLocalScalarFact(facts, renames.get(name) ?? name, fact);
  }
  for (const param of fn.params) {
    const binding = flattenBinding(param.name, param.type, ctx.layouts);
    if (binding.length !== 1 || binding[0]?.wat !== "i32") continue;
    const fact = i32FactFromType(param.type, ctx.layouts);
    if (fact) mergeLocalScalarFact(facts, binding[0].name, fact);
  }
  return facts;
}

function i32FactFromType(type: string | undefined, layouts: LayoutEnv): ScalarFacts | undefined {
  const resolved = resolveAlias(type, layouts) ?? type;
  return scalarFactsFromRefinedI32Type(resolved);
}

function mergeLocalScalarFact(
  facts: Map<string, ScalarFacts>,
  name: string,
  fact: ScalarFacts,
) {
  const existing = facts.get(name);
  const merged = existing ? scalarFactsIntersect(existing, fact) : fact;
  if (merged) facts.set(name, merged);
}

function exprI32Range(
  expr: Expr,
  ctx?: Pick<LowerContext, "localScalarFacts">,
): I32Range | undefined {
  return scalarFactsNumericRange(exprI32Facts(expr, ctx));
}

function exprI32Facts(
  expr: Expr,
  ctx?: Pick<LowerContext, "localScalarFacts">,
): ScalarFacts | undefined {
  const literal = staticIntegerLiteral(expr);
  if (literal !== undefined) {
    return literal >= I32_MIN && literal <= I32_MAX
      ? scalarFactsFromI32Range({ min: literal, max: literal })
      : undefined;
  }
  if (expr.kind === "var") {
    return ctx?.localScalarFacts?.get(expr.name);
  }
  if (expr.kind === "binary" && expr.op === "+") {
    const left = exprI32Range(expr.left, ctx);
    const right = exprI32Range(expr.right, ctx);
    if (!left || !right) return undefined;
    const min = left.min + right.min;
    const max = left.max + right.max;
    return min >= I32_MIN && max <= I32_MAX ? scalarFactsFromI32Range({ min, max }) : undefined;
  }
  if (expr.kind === "binary" && expr.op === "-") {
    const left = exprI32Range(expr.left, ctx);
    const right = exprI32Range(expr.right, ctx);
    if (!left || !right) return undefined;
    const min = left.min - right.max;
    const max = left.max - right.min;
    return min >= I32_MIN && max <= I32_MAX ? scalarFactsFromI32Range({ min, max }) : undefined;
  }
  if (expr.kind === "binary" && expr.op === "*") {
    const left = exprI32Range(expr.left, ctx);
    const right = exprI32Range(expr.right, ctx);
    if (!left || !right) return undefined;
    const products = [
      left.min * right.min,
      left.min * right.max,
      left.max * right.min,
      left.max * right.max,
    ];
    const min = Math.min(...products);
    const max = Math.max(...products);
    return min >= I32_MIN && max <= I32_MAX ? scalarFactsFromI32Range({ min, max }) : undefined;
  }
  if (expr.kind === "binary" && (expr.op === "/" || expr.op === "%")) {
    const left = exprI32Range(expr.left, ctx);
    const divisor = staticIntegerLiteral(expr.right);
    if (!left || divisor === undefined || divisor <= 0 || left.min < 0) return undefined;
    if (expr.op === "/") {
      return scalarFactsFromI32Range({ min: 0, max: Math.floor(left.max / divisor) });
    }
    return scalarFactsFromI32Range({ min: 0, max: divisor - 1 });
  }
  return undefined;
}

function lowerSignedPowerOfTwoQuotient(
  value: Expr,
  shift: number,
  biasMask: number,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  return [
    ...lowerExpr(value, ctx, locals),
    ...lowerExpr(value, ctx, locals),
    { op: "const", type: "i32", value: 31 },
    { op: "binary", wasm: "i32.shr_s" },
    { op: "const", type: "i32", value: biasMask },
    { op: "binary", wasm: "i32.and" },
    { op: "binary", wasm: "i32.add" },
    { op: "const", type: "i32", value: shift },
    { op: "binary", wasm: "i32.shr_s" },
  ];
}

function powerOfTwoShift(expr: Expr): number | undefined {
  if (expr.kind !== "literal" || expr.literalKind !== "number") return undefined;
  const value = Number(expr.value);
  if (!Number.isInteger(value) || value <= 0 || value > 0x4000_0000) return undefined;
  if ((value & (value - 1)) !== 0) return undefined;
  return Math.log2(value);
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
    case "&&":
      return "i32.and";
    case "||":
      return "i32.or";
    case "^^":
      return "i32.xor";
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
  if (ctx.simdDotHelperName) {
    return [
      ...packProjectedLane4I32(pattern.left, locals),
      ...packProjectedLane4I32(pattern.right, locals),
      { op: "call", name: ctx.simdDotHelperName },
    ];
  }
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

interface HeapItemSlot {
  slot: LayoutSlot;
  offset: number;
  align: number;
}

interface HeapItemLayout {
  itemType: string;
  slots: HeapItemSlot[];
  stride: number;
}

function lowerHeapArrayIntrinsic(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
  expectedType?: string,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const id = compilerCallId(expr.callee.name, ctx.intrinsicIdsByName);
  if (!id?.startsWith("heap_array_")) return undefined;
  const itemType = heapArrayItemTypeFromCall(expr, id, ctx, expectedType);
  if (!itemType) {
    throw new Error(
      `backend cannot infer heap array item type in ${ctx.currentFn?.name ?? "<unknown>"}`,
    );
  }
  const layout = heapItemLayout(itemType, ctx.layouts);
  const args = heapArrayRuntimeArgs(expr, ctx);
  switch (id) {
    case "heap_array_new":
      return lowerHeapArrayNew(args[0], layout, ctx, locals);
    case "heap_array_ensure_capacity":
      return lowerHeapArrayEnsureCapacity(args[0], args[1], layout, ctx, locals);
    case "heap_array_get":
      return lowerHeapArrayGet(args[0], args[1], layout, ctx, locals);
    case "heap_array_set":
      return lowerHeapArraySet(args[0], args[1], args[2], layout, ctx, locals);
    case "heap_array_push":
      return lowerHeapArrayPush(args[0], args[1], layout, ctx, locals);
    default:
      return undefined;
  }
}

function heapArrayRuntimeArgs(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
): Expr[] {
  const calleeName = expr.callee.kind === "var" ? expr.callee.name : undefined;
  const callee = calleeName ? ctx.functions.get(calleeName) : undefined;
  if (callee && calleeName && !calleeName.startsWith("@")) return runtimeCallArgs(expr, callee);
  return expr.args.slice(1);
}

function heapArrayItemTypeFromCall(
  expr: Extract<Expr, { kind: "call" }>,
  id: string,
  ctx: LowerContext,
  expectedType?: string,
): string | undefined {
  const directIntrinsic = expr.callee.kind === "var" && expr.callee.name.startsWith("@");
  const explicit = directIntrinsic && expr.args[0]
    ? renderBackendTypeProofArg(expr.args[0])
    : undefined;
  if (explicit) return explicit;
  const callee = expr.callee.kind === "var"
    ? backendFunctionByName(expr.callee.name, ctx)
    : undefined;
  const returnType = callee?.returnType
    ? specializeCallReturnType(expr, callee.returnType, ctx) ?? callee.returnType
    : undefined;
  if (id === "heap_array_get") return expectedType ?? returnType;
  return heapArrayItemType(returnType) ?? heapArrayItemType(expectedType);
}

function heapArrayItemType(type: string | undefined): string | undefined {
  if (!type) return undefined;
  const args = typeCallArgs(type, "HeapArray");
  return args ? splitTypeArgs(args)[0]?.trim() : undefined;
}

function heapItemLayout(itemType: string, layouts: LayoutEnv): HeapItemLayout {
  itemType = canonicalHeapItemType(itemType, layouts);
  const slots = flattenType(itemType, layouts);
  let offset = 0;
  let maxAlign = 4;
  const heapSlots = slots.map((slot): HeapItemSlot => {
    const align = valueTypeByteSize(slot.wat);
    maxAlign = Math.max(maxAlign, align);
    offset = alignTo(offset, align);
    const item = { slot, offset, align };
    offset += valueTypeByteSize(slot.wat);
    return item;
  });
  return {
    itemType,
    slots: heapSlots,
    stride: Math.max(1, alignTo(offset, maxAlign)),
  };
}

function canonicalHeapItemType(itemType: string, layouts: LayoutEnv): string {
  const trimmed = itemType.trim();
  if (trimmed.includes("(")) return trimmed;
  const decl = layouts.types.get(typeName(trimmed));
  return decl && decl.params.length === 0 ? `${trimmed}()` : trimmed;
}

function lowerHeapArrayNew(
  capacity: Expr | undefined,
  layout: HeapItemLayout,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const cap = heapTemp(ctx, locals, "cap");
  const capExpr = capacity ?? staticIndexExpr(0);
  return [
    ...lowerExpr(capExpr, ctx, locals, "i32"),
    { op: "local.set", name: cap },
    ...lowerHeapAlloc(
      [
        { op: "local.get", name: cap },
        { op: "const", type: "i32", value: layout.stride },
        { op: "binary", wasm: "i32.mul" },
      ],
      ctx,
      locals,
    ),
    { op: "const", type: "i32", value: 0 },
    { op: "local.get", name: cap },
  ];
}

function lowerHeapArrayEnsureCapacity(
  array: Expr | undefined,
  neededCapacity: Expr | undefined,
  layout: HeapItemLayout,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const arr = cacheHeapArray(array, layout.itemType, ctx, locals, "ensure_arr");
  const needed = heapTemp(ctx, locals, "needed");
  const newCap = heapTemp(ctx, locals, "new_cap");
  const newPtr = heapTemp(ctx, locals, "new_ptr");
  return [
    ...arr.prefix,
    ...lowerExpr(neededCapacity ?? staticIndexExpr(0), ctx, locals, "i32"),
    { op: "local.set", name: needed },
    { op: "local.get", name: needed },
    { op: "local.get", name: arr.cap },
    { op: "binary", wasm: "i32.le_s" },
    {
      op: "if",
      results: ["i32", "i32", "i32"],
      thenBody: [
        { op: "local.get", name: arr.ptr },
        { op: "local.get", name: arr.len },
        { op: "local.get", name: arr.cap },
      ],
      elseBody: [
        ...lowerHeapArrayGrowthCapacity(arr.cap, needed, newCap),
        ...lowerHeapAlloc(
          [
            { op: "local.get", name: newCap },
            { op: "const", type: "i32", value: layout.stride },
            { op: "binary", wasm: "i32.mul" },
          ],
          ctx,
          locals,
        ),
        { op: "local.set", name: newPtr },
        ...lowerHeapArrayCopy(newPtr, arr.ptr, arr.len, layout),
        { op: "local.get", name: newPtr },
        { op: "local.get", name: arr.len },
        { op: "local.get", name: newCap },
      ],
    },
  ];
}

function lowerHeapArrayGet(
  array: Expr | undefined,
  index: Expr | undefined,
  layout: HeapItemLayout,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const arr = cacheHeapArray(array, layout.itemType, ctx, locals, "get_arr");
  const item = heapTemp(ctx, locals, "get_index");
  return [
    ...arr.prefix,
    ...lowerExpr(index ?? staticIndexExpr(0), ctx, locals, "i32"),
    { op: "local.set", name: item },
    ...layout.slots.flatMap(({ slot, offset, align }) =>
      [
        ...lowerHeapItemAddress(arr.ptr, item, layout.stride, offset),
        { op: "load", type: slot.wat, align, offset: 0 },
      ] as Instr[]
    ),
  ];
}

function lowerHeapArraySet(
  array: Expr | undefined,
  index: Expr | undefined,
  value: Expr | undefined,
  layout: HeapItemLayout,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const arr = cacheHeapArray(array, layout.itemType, ctx, locals, "set_arr");
  const item = heapTemp(ctx, locals, "set_index");
  const values = cacheHeapValue(value, layout, ctx, locals, "set_value");
  return [
    ...arr.prefix,
    ...lowerExpr(index ?? staticIndexExpr(0), ctx, locals, "i32"),
    { op: "local.set", name: item },
    ...values.prefix,
    ...lowerHeapArrayStores(arr.ptr, item, values.names, layout),
    { op: "local.get", name: arr.ptr },
    { op: "local.get", name: arr.len },
    { op: "local.get", name: arr.cap },
  ];
}

function lowerHeapArrayPush(
  array: Expr | undefined,
  value: Expr | undefined,
  layout: HeapItemLayout,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] {
  const arr = cacheHeapArray(array, layout.itemType, ctx, locals, "push_arr");
  const values = cacheHeapValue(value, layout, ctx, locals, "push_value");
  const newCap = heapTemp(ctx, locals, "push_cap");
  const newPtr = heapTemp(ctx, locals, "push_ptr");
  return [
    ...arr.prefix,
    ...values.prefix,
    { op: "local.get", name: arr.len },
    { op: "local.get", name: arr.cap },
    { op: "binary", wasm: "i32.lt_s" },
    {
      op: "if",
      results: ["i32", "i32", "i32"],
      thenBody: [
        ...lowerHeapArrayStores(arr.ptr, arr.len, values.names, layout),
        { op: "local.get", name: arr.ptr },
        { op: "local.get", name: arr.len },
        { op: "const", type: "i32", value: 1 },
        { op: "binary", wasm: "i32.add" },
        { op: "local.get", name: arr.cap },
      ],
      elseBody: [
        ...lowerHeapArrayGrowthCapacity(arr.cap, undefined, newCap),
        ...lowerHeapAlloc(
          [
            { op: "local.get", name: newCap },
            { op: "const", type: "i32", value: layout.stride },
            { op: "binary", wasm: "i32.mul" },
          ],
          ctx,
          locals,
        ),
        { op: "local.set", name: newPtr },
        ...lowerHeapArrayCopy(newPtr, arr.ptr, arr.len, layout),
        ...lowerHeapArrayStores(newPtr, arr.len, values.names, layout),
        { op: "local.get", name: newPtr },
        { op: "local.get", name: arr.len },
        { op: "const", type: "i32", value: 1 },
        { op: "binary", wasm: "i32.add" },
        { op: "local.get", name: newCap },
      ],
    },
  ];
}

function cacheHeapArray(
  array: Expr | undefined,
  itemType: string,
  ctx: LowerContext,
  locals: Set<string>,
  label: string,
): { prefix: Instr[]; ptr: string; len: string; cap: string } {
  const names = ["ptr", "len", "cap"].map((field) => heapTemp(ctx, locals, `${label}_${field}`));
  return {
    prefix: [
      ...lowerExpr(
        array ?? { kind: "literal", literalKind: "number", value: "0" },
        ctx,
        locals,
        `HeapArray(${itemType})`,
      ),
      ...names.toReversed().map((name): Instr => ({ op: "local.set", name })),
    ],
    ptr: names[0]!,
    len: names[1]!,
    cap: names[2]!,
  };
}

function cacheHeapValue(
  value: Expr | undefined,
  layout: HeapItemLayout,
  ctx: LowerContext,
  locals: Set<string>,
  label: string,
): { prefix: Instr[]; names: string[] } {
  const names = layout.slots.map(({ slot }, index) => {
    const suffix = slot.suffix ? slot.suffix.replace(/[^A-Za-z0-9_]/g, "_") : String(index);
    const name = heapTemp(ctx, locals, `${label}_${suffix}`);
    return name;
  });
  return {
    prefix: [
      ...lowerExpr(value ?? staticIndexExpr(0), ctx, locals, layout.itemType),
      ...names.toReversed().map((name): Instr => ({ op: "local.set", name })),
    ],
    names,
  };
}

function lowerHeapArrayStores(
  ptr: string,
  index: string,
  valueNames: string[],
  layout: HeapItemLayout,
): Instr[] {
  return layout.slots.flatMap(({ slot, offset, align }, slotIndex) =>
    [
      ...lowerHeapItemAddress(ptr, index, layout.stride, offset),
      { op: "local.get", name: valueNames[slotIndex] ?? valueNames[0] ?? "__heap_missing" },
      { op: "store", type: slot.wat, align, offset: 0 },
    ] as Instr[]
  );
}

function lowerHeapArrayCopy(
  destPtr: string,
  srcPtr: string,
  len: string,
  layout: HeapItemLayout,
): Instr[] {
  return [
    { op: "local.get", name: destPtr },
    { op: "local.get", name: srcPtr },
    { op: "local.get", name: len },
    { op: "const", type: "i32", value: layout.stride },
    { op: "binary", wasm: "i32.mul" },
    { op: "memory.copy" },
  ];
}

function lowerHeapItemAddress(
  ptr: string,
  index: string,
  stride: number,
  offset: number,
): Instr[] {
  const instrs: Instr[] = [
    { op: "local.get", name: ptr },
    { op: "local.get", name: index },
    { op: "const", type: "i32", value: stride },
    { op: "binary", wasm: "i32.mul" },
    { op: "binary", wasm: "i32.add" },
  ];
  if (offset !== 0) {
    instrs.push(
      { op: "const", type: "i32", value: offset },
      { op: "binary", wasm: "i32.add" },
    );
  }
  return instrs;
}

function lowerHeapArrayGrowthCapacity(
  currentCap: string,
  neededCap: string | undefined,
  target: string,
): Instr[] {
  const doubled: Instr[] = [
    { op: "local.get", name: currentCap },
    { op: "const", type: "i32", value: 2 },
    { op: "binary", wasm: "i32.mul" },
    { op: "local.tee", name: target },
    { op: "const", type: "i32", value: 1 },
    { op: "binary", wasm: "i32.lt_s" },
    {
      op: "if",
      results: ["i32"],
      thenBody: [{ op: "const", type: "i32", value: 1 }],
      elseBody: [{ op: "local.get", name: target }],
    },
    { op: "local.set", name: target },
  ];
  if (!neededCap) return doubled;
  return [
    ...doubled,
    { op: "local.get", name: target },
    { op: "local.get", name: neededCap },
    { op: "binary", wasm: "i32.lt_s" },
    {
      op: "if",
      results: ["i32"],
      thenBody: [{ op: "local.get", name: neededCap }],
      elseBody: [{ op: "local.get", name: target }],
    },
    { op: "local.set", name: target },
  ];
}

function lowerHeapAlloc(bytes: Instr[], ctx: LowerContext, locals: Set<string>): Instr[] {
  const size = heapTemp(ctx, locals, "alloc_size");
  const current = heapTemp(ctx, locals, "alloc_current");
  const next = heapTemp(ctx, locals, "alloc_next");
  const pages = heapTemp(ctx, locals, "alloc_pages");
  return [
    ...bytes,
    { op: "const", type: "i32", value: 15 },
    { op: "binary", wasm: "i32.add" },
    { op: "const", type: "i32", value: -16 },
    { op: "binary", wasm: "i32.and" },
    { op: "local.set", name: size },
    { op: "const", type: "i32", value: 0 },
    { op: "load", type: "i32", align: 4, offset: 0 },
    { op: "local.tee", name: current },
    { op: "const", type: "i32", value: 0 },
    { op: "binary", wasm: "i32.eq" },
    {
      op: "if",
      results: ["i32"],
      thenBody: [{ op: "const", type: "i32", value: 16 }],
      elseBody: [{ op: "local.get", name: current }],
    },
    { op: "local.set", name: current },
    { op: "local.get", name: current },
    { op: "local.get", name: size },
    { op: "binary", wasm: "i32.add" },
    { op: "local.set", name: next },
    { op: "memory.size" },
    { op: "local.tee", name: pages },
    { op: "const", type: "i32", value: 16 },
    { op: "binary", wasm: "i32.shl" },
    { op: "local.get", name: next },
    { op: "binary", wasm: "i32.lt_u" },
    {
      op: "if",
      results: [],
      thenBody: [
        { op: "local.get", name: next },
        { op: "const", type: "i32", value: 0xffff },
        { op: "binary", wasm: "i32.add" },
        { op: "const", type: "i32", value: 16 },
        { op: "binary", wasm: "i32.shr_u" },
        { op: "local.get", name: pages },
        { op: "binary", wasm: "i32.sub" },
        { op: "memory.grow" },
        { op: "const", type: "i32", value: -1 },
        { op: "binary", wasm: "i32.eq" },
        {
          op: "if",
          results: [],
          thenBody: [{ op: "unreachable" }],
          elseBody: [],
        },
      ],
      elseBody: [],
    },
    { op: "const", type: "i32", value: 0 },
    { op: "local.get", name: next },
    { op: "store", type: "i32", align: 4, offset: 0 },
    { op: "local.get", name: current },
  ];
}

function heapTemp(ctx: LowerContext, locals: Set<string>, label: string): string {
  const name = `__heap_${label}${ctx.tempIndex++}`;
  ctx.tempLocals.push({ name, type: "i32" });
  locals.add(name);
  return name;
}

function alignTo(value: number, align: number): number {
  return Math.ceil(value / align) * align;
}

function lowerBranchIntrinsic(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const id = compilerCallId(expr.callee.name, ctx.intrinsicIdsByName);
  if (!id?.startsWith("branch_")) return undefined;
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

function lowerPrimitiveScalarIntrinsic(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
  locals: Set<string>,
): Instr[] | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const id = compilerCallId(expr.callee.name, ctx.intrinsicIdsByName);
  const intrinsic = primitiveScalarIntrinsic(id);
  if (!intrinsic) return undefined;
  const callee = expr.callee.name.startsWith("@") ? undefined : ctx.functions.get(expr.callee.name);
  const args = callee ? runtimeCallArgs(expr, callee) : expr.args;
  const left = args[0] ?? { kind: "literal", literalKind: "number", value: "0" };
  const right = args[1] ?? { kind: "literal", literalKind: "number", value: "0" };
  return [
    ...lowerExpr(left, ctx, locals, intrinsic.type),
    ...lowerExpr(right, ctx, locals, intrinsic.type),
    { op: "binary", wasm: intrinsic.wasm },
  ];
}

function primitiveScalarIntrinsic(
  id: string | undefined,
): { type: string; wasm: string } | undefined {
  const match = id?.match(/^(i32|u32|i64|u64|f32|f64|bool)_(.+)$/);
  if (!match) return undefined;
  const carrier = match[1]!;
  const op = match[2]!;
  if (carrier === "bool") {
    const wasm = ({
      and: "i32.and",
      or: "i32.or",
      xor: "i32.xor",
      eql: "i32.eq",
      neq: "i32.ne",
    } as Record<string, string>)[op];
    return wasm ? { type: "bool", wasm } : undefined;
  }
  const lane = carrier === "u32" ? "i32" : carrier === "u64" ? "i64" : carrier;
  const unsigned = carrier === "u32" || carrier === "u64";
  const wasmOp = primitiveScalarWasmOp(lane, op, unsigned);
  return wasmOp ? { type: carrier, wasm: wasmOp } : undefined;
}

function primitiveScalarWasmOp(lane: string, op: string, unsigned: boolean): string | undefined {
  if (lane === "f32" || lane === "f64") {
    return ({
      add: `${lane}.add`,
      sub: `${lane}.sub`,
      mul: `${lane}.mul`,
      div: `${lane}.div`,
      eql: `${lane}.eq`,
      neq: `${lane}.ne`,
      lt: `${lane}.lt`,
      lte: `${lane}.le`,
      gt: `${lane}.gt`,
      gte: `${lane}.ge`,
    } as Record<string, string>)[op];
  }
  const signedSuffix = unsigned ? "_u" : "_s";
  return ({
    add: `${lane}.add`,
    sub: `${lane}.sub`,
    mul: `${lane}.mul`,
    div: `${lane}.div${signedSuffix}`,
    rem: `${lane}.rem${signedSuffix}`,
    eql: `${lane}.eq`,
    neq: `${lane}.ne`,
    lt: `${lane}.lt${signedSuffix}`,
    lte: `${lane}.le${signedSuffix}`,
    gt: `${lane}.gt${signedSuffix}`,
    gte: `${lane}.ge${signedSuffix}`,
  } as Record<string, string>)[op];
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
  if (parseRefinedI32Type(source)) return "i32";
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
  if (/^-?[0-9]+(?:\.[0-9]+)?(?:i32|u32|i64|u64|f32|f64)?$/.test(source)) {
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

function decodeStringLiteralValue(source: string): string {
  return JSON.parse(source);
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
    ? { kind: "string" as const, value: decodeStringLiteralValue(expr.value) }
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

interface SumVariantLayout {
  name: string;
  tag: number;
  slots: ShapeTypeSlot[];
  flatSlots: LayoutSlot[];
}

interface SumLayout {
  type: string;
  variants: SumVariantLayout[];
  payloadSlots: LayoutSlot[];
}

interface PackedField {
  name: string;
  type: string;
  width: number;
  offset: number;
}

function createLayoutEnv(program: Program): LayoutEnv {
  const functionNames = new Set<string>();
  const constShapes = new Map<string, Extract<Expr, { kind: "shape" }>>();
  const constRuntimeValues = new Map<string, Expr>();
  const constRuntimeTypes = new Map<string, string | undefined>();
  const topLevelValues = new Set<string>();
  const constNumbers = new Map<string, number>();
  const types = new Map<string, TypeDecl>();
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      functionNames.add(decl.name);
      continue;
    }
    if (decl.kind === "type") {
      types.set(decl.name, decl);
      continue;
    }
    if (decl.kind === "let") {
      topLevelValues.add(decl.name);
      continue;
    }
    if (decl.kind !== "const") continue;
    topLevelValues.add(decl.name);
    const value = decl.value;
    if (value.kind === "shape" && !value.inferredType) {
      constShapes.set(decl.name, value);
    }
    const isRuntimeConst = value.kind === "literal" ||
      value.kind === "product_constructor" ||
      (value.kind === "shape" && !!value.inferredType);
    if (isRuntimeConst) {
      constRuntimeValues.set(decl.name, value);
      constRuntimeTypes.set(
        decl.name,
        decl.type ?? (value.kind === "shape" ? value.inferredType : undefined),
      );
    }
    if (value.kind === "literal" && value.literalKind === "number") {
      constNumbers.set(decl.name, Number.parseInt(value.value, 10));
    }
  }
  const constFunctionFields = new Map<string, string>();
  for (const [name, shape] of constShapes) {
    for (const slot of shape.slots) {
      if (!slot.label || slot.value.kind !== "var") continue;
      if (!functionNames.has(slot.value.name)) continue;
      constFunctionFields.set(`${name}.${slot.label}`, slot.value.name);
    }
  }
  return {
    types,
    constShapes,
    constRuntimeValues,
    constRuntimeTypes,
    constFunctionFields,
    topLevelValues,
    constNumbers,
  };
}

function cachedLayoutEnv(program: Program, cache: BackendCache | undefined): LayoutEnv {
  const backendLayouts = cache?.backendLayouts;
  if (!backendLayouts) return createLayoutEnv(program);
  const key = backendLayoutEnvCacheKey(program);
  const cached = backendLayouts.get(key);
  if (cached) return cached.layouts;
  const layouts = createLayoutEnv(program);
  backendLayouts.set(key, { layouts });
  return layouts;
}

function backendLayoutEnvCacheKey(program: Program): string {
  let hash = 0x811c9dc5;
  hash = hashUpdateString(hash, "layout_env");
  for (const item of program.imports) {
    hash = hashUpdateString(hash, "import");
    hash = hashUpdateString(hash, item.name);
    hash = hashUpdateString(hash, item.type);
    hash = hashUpdateString(hash, item.effects.join(","));
  }
  for (const decl of program.declarations) {
    hash = hashUpdateString(hash, decl.kind);
    if (decl.kind === "fn") {
      hash = hashUpdateString(hash, decl.name);
      continue;
    }
    if (decl.kind === "let") {
      hash = hashUpdateString(hash, decl.name);
      hash = hashUpdateString(hash, decl.type ?? "");
      continue;
    }
    hash = hashUpdateString(hash, stableBackendHash(decl));
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
  const heapArraySlots = flattenHeapArrayType(type);
  if (heapArraySlots) return heapArraySlots;
  const ioItemType = ioActionItemType(type);
  if (ioItemType) return flattenType(ioItemType, layouts);
  const effectResultSlots = effectResultFlattenSlots(type, layouts);
  if (effectResultSlots) return effectResultSlots;
  if (parseBackendFnSignature(type)) return [{ suffix: "", type: type ?? "i32", wat: "i32" }];
  const staticShape = flattenStaticShapeType(type, layouts);
  if (staticShape) return staticShape;
  const resolved = resolveAlias(type, layouts);
  if (!resolved) return [{ suffix: "", type: "i32", wat: "i32" }];
  const resolvedEffectResultSlots = effectResultFlattenSlots(resolved, layouts);
  if (resolvedEffectResultSlots) return resolvedEffectResultSlots;
  if (parseBackendFnSignature(resolved)) return [{ suffix: "", type: resolved, wat: "i32" }];
  if (parseRefinedI32Type(resolved)) return [{ suffix: "", type: resolved, wat: "i32" }];
  if (isPrimitiveType(resolved)) return [{ suffix: "", type: resolved, wat: watType(resolved) }];
  const inlineArrayArgs = inlineArrayLikeTypeArgs(type, layouts) ??
    inlineArrayLikeTypeArgs(resolved, layouts);
  if (inlineArrayArgs) {
    const [count, itemType] = inlineArrayArgs;
    if (Number.isFinite(count) && count > 0) return repeatSlots(count, itemType, layouts);
  }
  const productSlots = productSlotsForType(type, layouts) ?? productSlotsForType(resolved, layouts);
  if (productSlots) return flattenShape(productSlots, layouts);
  const sum = sumLayoutForType(type, layouts) ?? sumLayoutForType(resolved, layouts);
  if (sum) {
    return [
      { suffix: "tag", type: "i32", wat: "i32" },
      ...sum.payloadSlots,
    ];
  }
  const inlineArrayBuilderArgs = typeCallArgs(resolved, "InlineArrayBuilder");
  if (inlineArrayBuilderArgs) {
    const args = splitTypeArgs(inlineArrayBuilderArgs);
    const count = staticCountValue(args[0] ?? "1", layouts);
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
          type: staticShapeSlotType(slot.value) ?? "i32",
        })),
        layouts,
      );
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
  if (decl?.normalized?.kind === "sum") {
    const sum = sumLayoutForType(resolved, layouts);
    if (sum) {
      return [
        { suffix: "tag", type: "i32", wat: "i32" },
        ...sum.payloadSlots,
      ];
    }
  }
  return [{ suffix: "", type: resolved, wat: watType(resolved) }];
}

function flattenHeapArrayType(type: string | undefined): LayoutSlot[] | undefined {
  if (!type) return undefined;
  const args = typeCallArgs(type, "HeapArray");
  if (args === undefined) return undefined;
  return [
    { suffix: "ptr", type: "i32", wat: "i32" },
    { suffix: "len", type: "i32", wat: "i32" },
    { suffix: "cap", type: "i32", wat: "i32" },
  ];
}

function rawSumLayoutForType(type: string | undefined, layouts: LayoutEnv): SumLayout | undefined {
  const original = stripReferenceType(type);
  const resolved = resolveAlias(original, layouts) ?? original;
  if (!resolved) return undefined;
  const decl = layouts.types.get(typeName(resolved));
  if (decl?.normalized?.kind !== "sum") return undefined;
  const args = typeCallArgs(resolved, typeName(resolved));
  const argValues = args ? splitTypeArgs(args) : [];
  const variants: SumVariantLayout[] = [];
  for (let tag = 0; tag < decl.normalized.variants.length; tag++) {
    const variant = decl.normalized.variants[tag]!;
    const slots = variant.shape
      ? substituteProductShapeTypeParams(variant.shape.slots, decl, argValues)
      : [];
    const flatSlots = slots.length > 0 ? flattenShape(slots, layouts) : [];
    variants.push({
      name: variant.name,
      tag,
      slots,
      flatSlots,
    });
  }
  let payloadWidth = 0;
  for (const variant of variants) {
    if (variant.flatSlots.length > payloadWidth) payloadWidth = variant.flatSlots.length;
  }
  const payloadSlots: LayoutSlot[] = [];
  for (let index = 0; index < payloadWidth; index++) {
    let slot: LayoutSlot | undefined;
    for (const variant of variants) {
      if (variant.flatSlots[index]) {
        slot = variant.flatSlots[index];
        break;
      }
    }
    payloadSlots.push({
      suffix: `payload${index}`,
      type: slot?.type ?? "i32",
      wat: slot?.wat ?? "i32",
    });
  }
  return { type: resolved, variants, payloadSlots };
}

function sumLayoutForType(type: string | undefined, layouts: LayoutEnv): SumLayout | undefined {
  const sum = rawSumLayoutForType(type, layouts);
  if (!sum || isScalarNicheSumLayout(sum.variants)) return undefined;
  return sum;
}

function scalarNicheSumLayoutForType(
  type: string | undefined,
  layouts: LayoutEnv,
): SumLayout | undefined {
  const sum = rawSumLayoutForType(type, layouts);
  if (!sum || !isScalarNicheSumLayout(sum.variants)) return undefined;
  return sum;
}

function isScalarNicheSumLayout(variants: SumVariantLayout[]): boolean {
  if (variants.length !== 2) return false;
  return false;
}

function ioActionItemType(type: string | undefined): string | undefined {
  const args = typeCallArgs(type?.trim() ?? "", "io");
  if (args === undefined) return undefined;
  return splitTypeArgs(args)[0]?.trim() || "i32";
}

function effectCarrierSlots(
  type: string | undefined,
  layouts: LayoutEnv,
): LayoutSlot[] | undefined {
  const trimmed = stripBorrowType(type);
  if (!trimmed) return undefined;
  const direct = trimmed.match(/(?:^|[.])Eff\((\{.*\}),\s*([^)]+)\)$/);
  if (direct?.[1] && direct[2] && /(?:^|[{,])\s*state\s*:/.test(direct[1])) {
    return flattenShape([
      { label: "value", type: direct[2].trim() },
      { label: "state", type: effectRowStateType(direct[1]) ?? "i32" },
    ], layouts);
  }
  const open = trimmed.indexOf("(");
  if (open < 0 || !trimmed.endsWith(")")) return undefined;
  if (terminalName(trimmed.slice(0, open).trim()) !== "Eff") return undefined;
  const args = trimmed.slice(open + 1, -1);
  const [row, valueType] = splitTypeArgs(args);
  if (!row || !valueType) return undefined;
  const shape = constShapeFromTypeArg(row, layouts);
  const stateSlot = shape?.slots.find((slot) => slot.label === "state");
  const stateType = stateSlot ? staticShapeSlotType(stateSlot.value) : effectRowStateType(row);
  if (!stateType) return flattenType(valueType, layouts);
  return flattenShape([
    { label: "value", type: valueType },
    { label: "state", type: stateType },
  ], layouts);
}

function effectResultFlattenSlots(
  type: string | undefined,
  layouts: LayoutEnv,
): LayoutSlot[] | undefined {
  const trimmed = stripBorrowType(type);
  if (!trimmed) return undefined;
  const open = trimmed.indexOf("(");
  if (open < 0 || !trimmed.endsWith(")")) return undefined;
  if (terminalName(trimmed.slice(0, open).trim()) !== "EffResult") return undefined;
  const [row, valueType] = splitTypeArgs(trimmed.slice(open + 1, -1));
  if (!row || !valueType) return undefined;
  const stateType = effectRowStateType(row);
  if (!stateType) return flattenType(valueType, layouts);
  return flattenShape([
    { label: "value", type: valueType },
    { label: "state", type: stateType },
  ], layouts);
}

function effectRowStateType(row: string): string | undefined {
  const parsed = parseInlineConstShape(row);
  const parsedState = parsed?.slots.find((slot) => slot.label === "state");
  if (parsedState) return staticShapeSlotType(parsedState.value);
  if (parsed && !parsedState) return undefined;
  const match = row.match(/(?:^|[{,])\s*state\s*:\s*([^,}]+)/);
  return match?.[1]?.trim();
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
  return undefined;
}

function staticShapeSlotType(expr: Expr): string | undefined {
  if (expr.kind === "var") return expr.name;
  if (expr.kind === "literal" && expr.literalKind === "literalType") {
    return expr.value.replace(/^#/, "");
  }
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
  const structArgs = typeCallArgs(trimmed, "struct");
  if (structArgs !== undefined) return parseInlineConstShape(structArgs);
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
  const signature = parseBackendFnSignature(type);
  if (signature) {
    const bindings = new Map<string, string>();
    decl.params.forEach((param, index) => {
      const arg = args[index]?.trim();
      if (arg) bindings.set(param.name, arg);
    });
    const params = signature.params.map((param) =>
      param.name
        ? `${param.name}: ${substituteRuntimeTypeBindings(param.type, bindings)}`
        : substituteRuntimeTypeBindings(param.type, bindings)
    ).join(", ");
    return `fn(${params}) -> ${substituteRuntimeTypeBindings(signature.returnType, bindings)}`;
  }
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
  const productSlots = productSlotsForType(type, layouts) ?? productSlotsForType(resolved, layouts);
  if (productSlots) {
    return productSlots.flatMap((slot) =>
      Array.from(
        { length: slot.repeat ? Number.parseInt(slot.repeat, 10) : 1 },
        () => slot.type,
      )
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

function renderBackendTypeProofArg(expr: Expr): string | undefined {
  if (expr.kind === "var") return expr.name;
  if (expr.kind === "literal" && expr.literalKind === "number") return expr.value;
  if (expr.kind === "call" && expr.callee.kind === "var") {
    const args = expr.args.map(renderBackendTypeProofArg);
    if (args.some((arg) => arg === undefined)) return undefined;
    return `${expr.callee.name}(${args.join(", ")})`;
  }
  if (expr.kind === "shape") {
    const slots = expr.slots.map((slot) => {
      const type = renderBackendTypeProofArg(slot.value);
      if (!type) return undefined;
      return `${slot.label ? `${slot.label}: ` : ""}${type}`;
    });
    if (slots.some((slot) => slot === undefined)) return undefined;
    return `{${slots.join(", ")}}`;
  }
  return undefined;
}

function exprTypeWithLocals(expr: Expr, ctx: LowerContext): string | undefined {
  if (expr.kind === "var") return varType(expr.name, ctx);
  if (expr.kind === "profile") return exprTypeWithLocals(expr.body, ctx);
  if (expr.kind === "index") return indexedItemType(expr, ctx);
  if (expr.kind === "field") return fieldExprTypeWithLocals(expr, ctx);
  if (expr.kind === "call") {
    if (expr.callee.kind === "var") {
      const known = backendFunctionByName(expr.callee.name, ctx)?.returnType;
      if (known) return specializeCallReturnType(expr, known, ctx) ?? known;
      const calleeType = varType(expr.callee.name, ctx);
      const parsed = parseBackendFnSignature(calleeType);
      if (parsed) return parsed.returnType;
      const sumType = sumConstructorCallType(expr, ctx);
      if (sumType) return sumType;
    } else {
      const calleeType = exprTypeWithLocals(expr.callee, ctx);
      const parsed = parseBackendFnSignature(calleeType);
      if (parsed) return parsed.returnType;
    }
  }
  if (expr.kind === "match") {
    const types = expr.arms.map((arm) => exprTypeWithLocals(arm.value, ctx));
    const first = types[0];
    if (first && types.every((type) => type === first)) return first;
  }
  if (expr.kind === "product_constructor") {
    return productConstructorResultType(expr, ctx);
  }
  if (expr.kind === "shape") {
    if (expr.inferredType) return expr.inferredType;
    const spreadType = inferBackendProductSpreadShapeType(expr, ctx);
    if (spreadType) return spreadType;
    const structural = inferBackendStructuralShapeType(expr, ctx);
    if (structural) return structural;
  }
  return exprType(expr, ctx.functions);
}

function fieldExprTypeWithLocals(
  expr: Extract<Expr, { kind: "field" }>,
  ctx: LowerContext,
): string | undefined {
  const label = backendExprLiteralLabel(expr.key, ctx);
  if (!label) return undefined;
  const valueType = exprTypeWithLocals(expr.value, ctx);
  const slots = productSlotsForType(valueType, ctx.layouts);
  if (!slots) return undefined;
  for (const slot of slots) {
    if (slot.label === label) return slot.type;
  }
  return undefined;
}

function backendExprLiteralLabel(expr: Expr | undefined, ctx: LowerContext): string | undefined {
  if (!expr) return undefined;
  const folded = constFold(expr, ctx);
  if (
    folded.kind === "call" &&
    folded.callee.kind === "var" &&
    folded.callee.name === "@shape_first_key" &&
    folded.args[0]?.kind === "shape"
  ) {
    return folded.args[0].slots[0]?.label;
  }
  if (folded.kind !== "literal") return undefined;
  if (folded.literalKind === "literalType") return folded.value.replace(/^#/, "");
  if (folded.literalKind === "string") return folded.value.replace(/^"|"$/g, "");
  return undefined;
}

function inferBackendStructuralShapeType(
  expr: Extract<Expr, { kind: "shape" }>,
  ctx: LowerContext,
): string | undefined {
  if (expr.slots.some((slot) => slot.spread || slot.index)) return undefined;
  const slots: string[] = [];
  for (const slot of expr.slots) {
    const type = exprTypeWithLocals(slot.value, ctx) ?? "i32";
    if (slot.label) {
      slots.push(`${slot.label}: ${type}`);
      continue;
    }
    slots.push(type);
  }
  return `struct({${slots.join(", ")}})`;
}

function sumConstructorCallType(
  expr: Extract<Expr, { kind: "call" }>,
  ctx: LowerContext,
): string | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const constructor = terminalName(expr.callee.name);
  for (const decl of ctx.layouts.types.values()) {
    if (decl.normalized?.kind !== "sum") continue;
    const variant = decl.normalized.variants.find((item) =>
      terminalName(item.name) === constructor
    );
    if (!variant) continue;
    const slots = variant.shape?.slots ?? [];
    if (slots.length !== expr.args.length) continue;
    if (decl.params.length === 0) return decl.name;
    const bindings = new Map<string, string>();
    let complete = true;
    for (let index = 0; index < slots.length; index++) {
      const arg = expr.args[index];
      const actual = arg ? exprRuntimeTypeWithLiteralDefault(arg, ctx) : undefined;
      if (!actual) {
        complete = false;
        break;
      }
      bindRuntimeTypePattern(slots[index]!.type, actual, bindings);
    }
    if (!complete) continue;
    const args: string[] = [];
    for (const param of decl.params) {
      const value = bindings.get(param.name);
      if (!value) {
        complete = false;
        break;
      }
      args.push(value);
    }
    if (!complete) continue;
    return `${decl.name}(${args.join(", ")})`;
  }
  return undefined;
}

function exprRuntimeTypeWithLiteralDefault(expr: Expr, ctx: LowerContext): string | undefined {
  const known = exprTypeWithLocals(expr, ctx);
  if (known) return known;
  if (expr.kind === "literal") {
    if (expr.inferredType) return expr.inferredType;
    if (expr.literalKind === "number") return "i32";
    if (expr.literalKind === "bool") return "bool";
    if (expr.literalKind === "char") return "char";
    if (expr.literalKind === "string" || expr.literalKind === "multiline") return "string";
    if (expr.literalKind === "literalType") return "literal";
  }
  return exprArgumentType(expr, ctx);
}

function inferBackendProductSpreadShapeType(
  expr: Extract<Expr, { kind: "shape" }>,
  ctx: LowerContext,
): string | undefined {
  if (!expr.slots.some((slot) => slot.spread) || expr.slots.some((slot) => slot.index)) {
    return undefined;
  }
  const merged = new Map<string, string>();
  for (const slot of expr.slots) {
    if (slot.spread) {
      const sourceType = exprTypeWithLocals(slot.value, ctx);
      const sourceSlots = productSlotsForType(sourceType, ctx.layouts);
      if (!sourceSlots) return undefined;
      for (const sourceSlot of sourceSlots) {
        if (sourceSlot.label) merged.set(sourceSlot.label, sourceSlot.type);
      }
      continue;
    }
    if (!slot.label) return undefined;
    merged.set(slot.label, exprTypeWithLocals(slot.value, ctx) ?? "i32");
  }
  if (!merged.size) return undefined;
  return `struct({${[...merged].map(([label, type]) => `${label}: ${type}`).join(", ")}})`;
}

function backendFunctionByName(name: string, ctx: LowerContext): FnDecl | undefined {
  const exact = ctx.functions.get(name);
  if (exact) return exact;
  const importedMatches = [...ctx.functions.values()].filter((fn) =>
    terminalName(fn.name) === name
  );
  if (importedMatches.length === 1) return importedMatches[0];
  const matches = [...ctx.functions.values()].filter((fn) => fn.name.endsWith(`::${name}`));
  return matches.length === 1 ? matches[0] : undefined;
}

function functionValueType(name: string, ctx: LowerContext): string | undefined {
  const fn = backendFunctionByName(name, ctx);
  if (!fn) return undefined;
  return `fn(${
    fn.params.map((param) => `${param.name}: ${param.type}`).join(", ")
  }) -> ${fn.returnType}`;
}

function specializeCallReturnType(
  expr: Extract<Expr, { kind: "call" }>,
  returnType: string,
  ctx: LowerContext,
): string | undefined {
  if (expr.callee.kind !== "var") return undefined;
  const fn = backendFunctionByName(expr.callee.name, ctx);
  if (!fn) return undefined;
  const bindings = new Map<string, string>();
  for (let index = 0; index < Math.min(fn.params.length, expr.args.length); index++) {
    const actual = exprArgumentType(expr.args[index]!, ctx);
    if (!actual) continue;
    bindRuntimeTypePattern(fn.params[index]!.type, actual, bindings);
  }
  return substituteRuntimeTypeBindings(returnType, bindings);
}

function exprArgumentType(expr: Expr, ctx: LowerContext): string | undefined {
  if (expr.kind === "var") return varType(expr.name, ctx) ?? functionValueType(expr.name, ctx);
  if (
    expr.kind === "call" && expr.callee.kind === "var" &&
    expr.args.length === 1 && expr.args[0]?.kind === "var"
  ) {
    return `${expr.callee.name}(${expr.args[0].name})`;
  }
  return exprTypeWithLocals(expr, ctx);
}

function bindRuntimeTypePattern(
  pattern: string | undefined,
  actual: string | undefined,
  bindings: Map<string, string>,
) {
  const pat = pattern?.trim();
  const act = actual?.trim();
  if (!pat || !act) return;
  if (isRuntimeTypePatternVariable(pat)) {
    bindings.set(pat, act);
    return;
  }
  const patFn = parseBackendFnSignature(pat);
  const actFn = parseBackendFnSignature(act);
  if (patFn && actFn) {
    for (let index = 0; index < Math.min(patFn.params.length, actFn.params.length); index++) {
      bindRuntimeTypePattern(patFn.params[index]!.type, actFn.params[index]!.type, bindings);
    }
    bindRuntimeTypePattern(patFn.returnType, actFn.returnType, bindings);
    return;
  }
  const patCall = parseRuntimeTypeCall(pat);
  const actCall = parseRuntimeTypeCall(act);
  if (patCall && actCall) {
    if (isRuntimeTypePatternVariable(patCall.name)) {
      bindings.set(patCall.name, actCall.name);
    } else if (typeName(patCall.name) !== typeName(actCall.name)) return;
    for (let index = 0; index < Math.min(patCall.args.length, actCall.args.length); index++) {
      bindRuntimeTypePattern(patCall.args[index], actCall.args[index], bindings);
    }
    return;
  }
  if (patCall && !actCall && isRuntimeTypePatternVariable(patCall.name)) {
    bindings.set(patCall.name, typeName(act));
  }
}

function isRuntimeTypePatternVariable(name: string): boolean {
  if (!/^[a-z][A-Za-z0-9_]*$/.test(name)) return false;
  if (isPrimitiveType(name)) return false;
  if (name === "string" || name === "const" || name === "range_i32") return false;
  return true;
}

function substituteRuntimeTypeBindings(
  type: string,
  bindings: ReadonlyMap<string, string>,
): string {
  let result = type;
  for (const [name, value] of bindings) {
    result = result.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }
  return result;
}

function parseRuntimeTypeCall(source: string): { name: string; args: string[] } | undefined {
  const trimmed = source.trim();
  const name = typeName(trimmed);
  const args = typeCallArgs(trimmed, name);
  return args === undefined ? undefined : { name, args: splitTypeArgs(args) };
}

function parseBackendFnSignature(
  source: string | undefined,
): { params: { name?: string; type: string }[]; returnType: string } | undefined {
  const trimmed = source?.trim();
  if (!trimmed?.startsWith("fn(")) return undefined;
  const open = trimmed.indexOf("(");
  let depth = 0;
  let close = -1;
  for (let index = open; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) {
        close = index;
        break;
      }
    } else if (char === "{") depth++;
    else if (char === "}") depth--;
  }
  if (close < 0) return undefined;
  const rest = trimmed.slice(close + 1).trim();
  if (!rest.startsWith("->")) return undefined;
  const paramsSource = trimmed.slice(open + 1, close).trim();
  const returnSource = rest.slice(2).trim();
  const effectStart = topLevelEffectIndex(returnSource);
  const returnType = (effectStart >= 0 ? returnSource.slice(0, effectStart) : returnSource)
    .trim();
  if (!returnType) return undefined;
  const params = paramsSource
    ? splitTypeArgs(paramsSource).map((part) => {
      const colon = part.indexOf(":");
      return colon >= 0
        ? { name: part.slice(0, colon).trim(), type: part.slice(colon + 1).trim() }
        : { type: part.trim() };
    })
    : [];
  return { params, returnType };
}

function topLevelEffectIndex(source: string): number {
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(" || char === "{") depth++;
    else if (char === ")" || char === "}") depth--;
    else if (char === "!" && depth === 0) return index;
  }
  return -1;
}

function isPrimitiveType(type: string): boolean {
  if (parseRefinedI32Type(type)) return true;
  return ["i32", "u32", "i64", "u64", "f32", "f64", "bool", "io", "string"].includes(type) ||
    unsignedBitWidth(type) !== undefined;
}

function isInlineScalarParamType(type: string | undefined, layouts: LayoutEnv): boolean {
  const resolved = resolveAlias(type, layouts) ?? type;
  if (!resolved) return false;
  if (parseBackendFnSignature(resolved)) return true;
  if (parseRefinedI32Type(resolved)) return true;
  if (literalTypeMembers(resolved)) return true;
  return isPrimitiveType(resolved);
}

function unsignedBitWidth(type: string): number | undefined {
  const refined = scalarFactsUnsignedBitWidth(scalarFactsFromRefinedI32Type(type));
  if (refined !== undefined) return refined;
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

function trailingTypeCallArg(type: string): string | undefined {
  const source = type.trim();
  if (!source.endsWith(")")) return undefined;
  let depth = 0;
  for (let index = source.length - 1; index >= 0; index--) {
    const char = source[index];
    if (char === ")") depth++;
    else if (char === "(") {
      depth--;
      if (depth === 0) {
        const prefix = source.slice(0, index).trim();
        if (!prefix) return undefined;
        return source.slice(index + 1, -1).trim();
      }
    }
  }
  return undefined;
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
  const slot = name.indexOf("$");
  const end = Math.min(
    dot >= 0 ? dot : name.length,
    bracket >= 0 ? bracket : name.length,
    slot >= 0 ? slot : name.length,
  );
  return name.slice(0, end);
}

function watName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_.$]/g, "_");
}

function watLocalName(name: string, aliases: ReadonlyMap<string, string>): string {
  return aliases.get(name) ?? watName(name);
}

function spaces(count: number): string {
  return " ".repeat(count);
}

function importAsFn(item: Program["imports"][number]): FnDecl {
  const match = item.type.match(/^fn\s*\(([\s\S]*?)\)\s*->\s*([^!]+)(?:![\s\S]*)?$/);
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
    imported: true,
    name: item.name,
    externalName: item.externalName,
    params,
    returnType: match?.[2].trim() ?? "i32",
    effects: item.effects,
    body: { kind: "block", statements: [] },
    primitiveId: "host_effect",
  };
}

function splitParams(source: string): string[] {
  if (!source.trim()) return [];
  return splitTypeArgs(source);
}

function usedNames(expr: Expr | BlockExpr): Set<string> {
  const names = new Set<string>();
  const addName = (name: string) => {
    const base = baseName(name);
    names.add(base);
    let end = base.lastIndexOf("$");
    while (end > 0) {
      names.add(base.slice(0, end));
      end = base.lastIndexOf("$", end - 1);
    }
  };
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
      case "type_assert":
        return;
      case "var":
        addName(item.name);
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
        return;
    }
  };
  visit(expr);
  return names;
}

function countNameUses(expr: Expr | BlockExpr, name: string): number {
  const target = baseName(name);
  let count = 0;
  const visit = (item: Expr | Statement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "do":
        visit(item.expr);
        return;
      case "let":
      case "destructure_let":
        visit(item.value);
        return;
      case "type_assert":
        return;
      case "var":
        if (baseName(item.name) === target) count++;
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
        for (const stmt of item.statements) visit(stmt);
        visit(item.expr);
        return;
      case "literal":
        return;
    }
  };
  visit(expr);
  return count;
}

function cachedCountNameUses(
  expr: Expr | BlockExpr,
  name: string,
  cache?: BackendCache,
): number {
  const nameUses = cache?.backendNameUses;
  if (!nameUses) return countNameUses(expr, name);
  const target = baseName(name);
  let uses = nameUses.get(expr);
  if (!uses) {
    uses = new Map();
    nameUses.set(expr, uses);
  }
  const cached = uses.get(target);
  if (cached !== undefined) return cached;
  const count = countNameUses(expr, target);
  uses.set(target, count);
  return count;
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
          if (stmt.kind === "let" || stmt.kind === "destructure_let") visit(stmt.value);
          else if (stmt.kind === "debug_trace") stmt.args.forEach(visit);
        }
        visit(item.expr);
        return;
      case "literal":
        return;
    }
  };
  visit(expr);
  return found;
}

function hasRuntimeEffect(
  expr: Expr,
  functions: Map<string, FnDecl>,
  seen: Set<string> = new Set(),
): boolean {
  switch (expr.kind) {
    case "call": {
      const callee = expr.callee.kind === "var" ? functions.get(expr.callee.name) : undefined;
      return (expr.callee.kind === "var" &&
        Boolean(callee && functionHasRuntimeEffect(callee, functions, seen))) ||
        hasRuntimeEffect(expr.callee, functions, seen) ||
        expr.args.some((arg) => hasRuntimeEffect(arg, functions, seen));
    }
    case "profile":
      return true;
    case "index":
      return hasRuntimeEffect(expr.target, functions, seen) ||
        hasRuntimeEffect(expr.index, functions, seen);
    case "binary":
      return hasRuntimeEffect(expr.left, functions, seen) ||
        hasRuntimeEffect(expr.right, functions, seen);
    case "pipe_bind":
      return hasRuntimeEffect(expr.value, functions, seen) ||
        hasRuntimeEffect(expr.body, functions, seen);
    case "match":
      return hasRuntimeEffect(expr.value, functions, seen) ||
        expr.arms.some((arm) => hasRuntimeEffect(arm.value, functions, seen));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) => hasRuntimeEffect(slot.value, functions, seen));
    case "range":
      return hasRuntimeEffect(expr.start, functions, seen) ||
        hasRuntimeEffect(expr.end, functions, seen);
    case "static_for_slots":
      return hasRuntimeEffect(expr.value, functions, seen) ||
        (expr.source.kind === "range"
          ? hasRuntimeEffect(expr.source.start, functions, seen) ||
            hasRuntimeEffect(expr.source.end, functions, seen)
          : hasRuntimeEffect(expr.source.shape, functions, seen));
    case "field":
      return hasRuntimeEffect(expr.value, functions, seen) ||
        hasRuntimeEffect(expr.key, functions, seen);
    case "block":
      return expr.statements.some((stmt) =>
        stmt.kind === "debug_trace" ||
        ((stmt.kind === "let" || stmt.kind === "destructure_let") &&
          hasRuntimeEffect(stmt.value, functions, seen))
      ) ||
        (expr.expr ? hasRuntimeEffect(expr.expr, functions, seen) : false);
    case "do":
      return true;
    case "const_fn":
      return hasRuntimeEffect(expr.body, functions, seen);
      return false;
    default:
      return false;
  }
}

function functionHasRuntimeEffect(
  fn: FnDecl,
  functions: Map<string, FnDecl>,
  seen: Set<string>,
): boolean {
  if (fn.effects.length > 0 || fn.primitiveId === "host_effect") return true;
  if (seen.has(fn.name)) return false;
  seen.add(fn.name);
  return hasRuntimeEffect(fn.body, functions, seen);
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
      case "type_assert":
      case "debug_trace":
      case "literal":
      case "var":
        return false;
      case "const_fn":
        return visit(item.body);
      case "profile":
        return item.args.some(visit) || visit(item.body);
      case "call":
        return (item.callee.kind === "var" &&
          isBranchIntrinsic(item.callee.name, functions)) ||
          visit(item.callee) || item.args.some(visit);
      case "index":
        return visit(item.target) || visit(item.index);
      case "binary":
        return visit(item.left) || visit(item.right);
      case "operator_chain":
        return visit(item.first) || item.rest.some((part) => visit(part.value));
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

function functionCallsBranchIntrinsic(
  fn: FnDecl,
  functions: Map<string, FnDecl>,
  cache?: BackendCache,
): boolean {
  for (const callee of cachedCalledFunctions(fn.body, cache)) {
    if (isBranchIntrinsic(callee, functions)) return true;
  }
  return false;
}

function usesHeapArrayIntrinsic(expr: Expr | BlockExpr, functions: Map<string, FnDecl>): boolean {
  const visit = (item: Expr | Statement | undefined): boolean => {
    if (!item) return false;
    switch (item.kind) {
      case "do":
        return visit(item.expr);
      case "let":
        return visit(item.value);
      case "destructure_let":
        return visit(item.value);
      case "type_assert":
      case "debug_trace":
      case "literal":
      case "var":
        return false;
      case "const_fn":
        return visit(item.body);
      case "profile":
        return item.args.some(visit) || visit(item.body);
      case "call":
        return (item.callee.kind === "var" &&
          isHeapArrayIntrinsic(item.callee.name, functions)) ||
          visit(item.callee) || item.args.some(visit);
      case "index":
        return visit(item.target) || visit(item.index);
      case "binary":
        return visit(item.left) || visit(item.right);
      case "operator_chain":
        return visit(item.first) || item.rest.some((part) => visit(part.value));
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

function functionCallsHeapArrayIntrinsic(
  fn: FnDecl,
  functions: Map<string, FnDecl>,
  cache?: BackendCache,
): boolean {
  for (const callee of cachedCalledFunctions(fn.body, cache)) {
    if (isHeapArrayIntrinsic(callee, functions)) return true;
  }
  return false;
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

function isHeapArrayIntrinsic(name: string, functions: Map<string, FnDecl>): boolean {
  if (
    name === "@heap_array_new" || name === "@heap_array_ensure_capacity" ||
    name === "@heap_array_get" || name === "@heap_array_set" ||
    name === "@heap_array_push"
  ) return true;
  const fn = functions.get(name);
  const id = fn ? intrinsicWrapperId(fn) : undefined;
  return id === "heap_array_new" || id === "heap_array_ensure_capacity" ||
    id === "heap_array_get" || id === "heap_array_set" ||
    id === "heap_array_push";
}

function localDecls(locals: BackendLocal[]): number[] {
  const groups: { type: ValueType; count: number }[] = [];
  for (const local of locals) {
    const previous = groups[groups.length - 1];
    if (previous?.type === local.type) previous.count++;
    else groups.push({ type: local.type, count: 1 });
  }
  const bytes: number[] = [];
  bytes.push(...uleb(groups.length));
  for (const group of groups) {
    bytes.push(...uleb(group.count));
    bytes.push(wasmType(group.type));
  }
  return bytes;
}

function wasmBinaryOp(op: string): number {
  return ({
    "i32.add": 0x6a,
    "i32.sub": 0x6b,
    "i32.mul": 0x6c,
    "i32.div_s": 0x6d,
    "i32.div_u": 0x6e,
    "i32.rem_s": 0x6f,
    "i32.rem_u": 0x70,
    "i32.and": 0x71,
    "i32.or": 0x72,
    "i32.xor": 0x73,
    "i32.shl": 0x74,
    "i32.shr_s": 0x75,
    "i32.shr_u": 0x76,
    "i64.and": 0x83,
    "i64.or": 0x84,
    "i64.xor": 0x85,
    "i64.add": 0x7c,
    "i64.sub": 0x7d,
    "i64.mul": 0x7e,
    "i64.div_s": 0x7f,
    "i64.div_u": 0x80,
    "i64.rem_s": 0x81,
    "i64.rem_u": 0x82,
    "i64.shl": 0x86,
    "i64.shr_u": 0x88,
    "i32.eq": 0x46,
    "i32.ne": 0x47,
    "i32.lt_s": 0x48,
    "i32.lt_u": 0x49,
    "i32.gt_u": 0x4b,
    "i32.le_u": 0x4d,
    "i32.le_s": 0x4c,
    "i32.gt_s": 0x4a,
    "i32.ge_s": 0x4e,
    "i32.ge_u": 0x4f,
    "i32.eqz": 0x45,
    "i64.eqz": 0x50,
    "i64.eq": 0x51,
    "i64.ne": 0x52,
    "i64.lt_s": 0x53,
    "i64.lt_u": 0x54,
    "i64.gt_s": 0x55,
    "i64.gt_u": 0x56,
    "i64.le_s": 0x57,
    "i64.le_u": 0x58,
    "i64.ge_s": 0x59,
    "i64.ge_u": 0x5a,
    "f32.eq": 0x5b,
    "f32.ne": 0x5c,
    "f32.lt": 0x5d,
    "f32.gt": 0x5e,
    "f32.le": 0x5f,
    "f32.ge": 0x60,
    "f64.eq": 0x61,
    "f64.ne": 0x62,
    "f64.lt": 0x63,
    "f64.gt": 0x64,
    "f64.le": 0x65,
    "f64.ge": 0x66,
    "f32.add": 0x92,
    "f32.sub": 0x93,
    "f32.mul": 0x94,
    "f32.div": 0x95,
    "f64.add": 0xa0,
    "f64.sub": 0xa1,
    "f64.mul": 0xa2,
    "f64.div": 0xa3,
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

function memoryIndexFor(
  memory: string | undefined,
  memoryIndex: ReadonlyMap<string, number>,
): number {
  if (!memory || memory === "memory") return 0;
  return memoryIndex.get(memory) ?? 0;
}

function memarg(align: number, offset: number, memory = 0): number[] {
  const alignLog = Math.log2(align);
  if (memory === 0) return [...uleb(alignLog), ...uleb(offset)];
  return [...uleb(alignLog + 0x40), ...uleb(memory), ...uleb(offset)];
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

function sectionVecItems(bytes: number[], id: number, items: number[][]) {
  let payloadLength = uleb(items.length).length;
  for (const item of items) {
    payloadLength += item.length;
  }
  bytes.push(id);
  bytes.push(...uleb(payloadLength));
  bytes.push(...uleb(items.length));
  for (const item of items) {
    for (const byte of item) bytes.push(byte);
  }
}

function vecItems(items: number[][]): number[] {
  return [...uleb(items.length), ...items.flat()];
}

function vecRaw(items: number[]): number[] {
  return [...uleb(items.length), ...items];
}

function nameBytes(name: string): number[] {
  const bytes: number[] = [];
  appendNameBytes(bytes, name);
  return bytes;
}

const wasmTextEncoder = new TextEncoder();

function appendNameBytes(target: number[], name: string) {
  const bytes = wasmTextEncoder.encode(name);
  target.push(...uleb(bytes.length));
  for (const byte of bytes) target.push(byte);
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
  let current = BigInt(value);
  let more = true;
  while (more) {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    const signBit = byte & 0x40;
    more = !((current === 0n && signBit === 0) || (current === -1n && signBit !== 0));
    if (more) byte |= 0x80;
    out.push(byte);
  }
  return out;
}
