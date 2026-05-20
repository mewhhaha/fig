import type {
  BlockExpr,
  Declaration,
  DoStatement,
  Expr,
  FnDecl,
  Param,
  ParamPattern,
  Program,
  Statement,
  StaticForSource,
  TypeExpr,
} from "./core_ast.ts";
import { patternBindingNames, patternBindsName } from "./patterns.ts";
import {
  I32_MAX,
  I32_MIN,
  parseRefinedI32Type,
  type RefinedI32Domain,
  renderRefinedI32Domain,
  scalarFactsFromI32Range,
} from "./refined_scalar.ts";
import { type CompileTraceSink, traceInstant, traceSync } from "./trace.ts";

export type OptMode = "debug" | "release";

export type OptimizeProfileName =
  | "debug"
  | "release_fast_compile"
  | "release_size"
  | "release_speed"
  | "release_balanced";

export interface OptimizeProfile {
  name: OptimizeProfileName;
  inline: {
    scalarBudget: number;
    productBudget: number;
    generatedMultiplier: number;
    allowPublicWrapperInlining: boolean;
  };
  recurrence: {
    unfoldMaxCardinality: number;
    unfoldMaxAstGrowth: number;
    loopLowerMinCardinality: number;
    allowNonTailFiniteUnfold: boolean;
  };
  layout: {
    inlineArrayFlatMaxSlots: number;
    packedBitMaxWidth: number;
    scratchMinSlots: number;
    preferPackedWhenDynamic: boolean;
  };
  abstract: {
    maxPasses: number;
    maxLocalEqualityCandidates: number;
  };
}

export interface OptimizeOptions {
  optMode?: OptMode;
  profile?: OptimizeProfileName | OptimizeProfile;
  assumeRewrites?: boolean;
  trace?: CompileTraceSink;
}

interface OptimizerConfig {
  profile: OptimizeProfile;
  scalarInlineBudget: number;
  productInlineBudget: number;
  passes: number;
  rewriteUnusedPrivateParams: boolean;
}

export interface OptimizationScope {
  runtimeRoots: Set<string>;
  reachableFunctions: Set<string>;
  reachableDeclarations: Set<string>;
}

export const OPTIMIZE_PROFILES: Record<OptimizeProfileName, OptimizeProfile> = {
  debug: {
    name: "debug",
    inline: {
      scalarBudget: 0,
      productBudget: 0,
      generatedMultiplier: 1,
      allowPublicWrapperInlining: false,
    },
    recurrence: {
      unfoldMaxCardinality: 0,
      unfoldMaxAstGrowth: 0,
      loopLowerMinCardinality: Number.POSITIVE_INFINITY,
      allowNonTailFiniteUnfold: false,
    },
    layout: {
      inlineArrayFlatMaxSlots: 4,
      packedBitMaxWidth: 0,
      scratchMinSlots: Number.POSITIVE_INFINITY,
      preferPackedWhenDynamic: false,
    },
    abstract: {
      maxPasses: 0,
      maxLocalEqualityCandidates: 0,
    },
  },
  release_fast_compile: {
    name: "release_fast_compile",
    inline: {
      scalarBudget: 18,
      productBudget: 12,
      generatedMultiplier: 2,
      allowPublicWrapperInlining: false,
    },
    recurrence: {
      unfoldMaxCardinality: 8,
      unfoldMaxAstGrowth: 96,
      loopLowerMinCardinality: 9,
      allowNonTailFiniteUnfold: true,
    },
    layout: {
      inlineArrayFlatMaxSlots: 4,
      packedBitMaxWidth: 64,
      scratchMinSlots: 8,
      preferPackedWhenDynamic: true,
    },
    abstract: {
      maxPasses: 2,
      maxLocalEqualityCandidates: 32,
    },
  },
  release_size: {
    name: "release_size",
    inline: {
      scalarBudget: 14,
      productBudget: 8,
      generatedMultiplier: 2,
      allowPublicWrapperInlining: false,
    },
    recurrence: {
      unfoldMaxCardinality: 10,
      unfoldMaxAstGrowth: 120,
      loopLowerMinCardinality: 11,
      allowNonTailFiniteUnfold: true,
    },
    layout: {
      inlineArrayFlatMaxSlots: 4,
      packedBitMaxWidth: 64,
      scratchMinSlots: 8,
      preferPackedWhenDynamic: true,
    },
    abstract: {
      maxPasses: 3,
      maxLocalEqualityCandidates: 48,
    },
  },
  release_speed: {
    name: "release_speed",
    inline: {
      scalarBudget: 28,
      productBudget: 18,
      generatedMultiplier: 2,
      allowPublicWrapperInlining: false,
    },
    recurrence: {
      unfoldMaxCardinality: 28,
      unfoldMaxAstGrowth: 240,
      loopLowerMinCardinality: 29,
      allowNonTailFiniteUnfold: true,
    },
    layout: {
      inlineArrayFlatMaxSlots: 8,
      packedBitMaxWidth: 64,
      scratchMinSlots: 6,
      preferPackedWhenDynamic: true,
    },
    abstract: {
      maxPasses: 5,
      maxLocalEqualityCandidates: 96,
    },
  },
  release_balanced: {
    name: "release_balanced",
    inline: {
      scalarBudget: 18,
      productBudget: 12,
      generatedMultiplier: 2,
      allowPublicWrapperInlining: false,
    },
    recurrence: {
      unfoldMaxCardinality: 18,
      unfoldMaxAstGrowth: 180,
      loopLowerMinCardinality: 19,
      allowNonTailFiniteUnfold: true,
    },
    layout: {
      inlineArrayFlatMaxSlots: 6,
      packedBitMaxWidth: 64,
      scratchMinSlots: 8,
      preferPackedWhenDynamic: true,
    },
    abstract: {
      maxPasses: 4,
      maxLocalEqualityCandidates: 64,
    },
  },
};

export interface FunctionSummary {
  name: string;
  isPublic: boolean;
  isPrimitive: boolean;
  isImported: boolean;
  isPure: boolean;
  effects: string[];
  recursiveKind: "none" | "self_tail" | "self_non_tail" | "mutual";
  astCost: number;
  wasmCostEstimate: number;
  runtimeInstructionEstimate: number;
  maxRecursionUnfoldingCardinality?: number;
  callCount: number;
  effectClass: "pure" | "read_only" | "state" | "volatile" | "host";
  allocationBehavior: "none" | "flat" | "heap" | "buffer" | "closure" | "unknown";
  stackBehavior: "none" | "tail_call" | "recursive_stack" | "mutual_or_unknown";
  returnClass:
    | "scalar"
    | "flat_product"
    | "inline_array"
    | "heap_handle"
    | "buffer_handle"
    | "closure"
    | "multi";
  paramEffects: Map<string, "observe" | "consume" | "retain" | "alias_return">;
  hasMatch: boolean;
  hasLoopShape: boolean;
  hasBranchIntrinsic: boolean;
  hasHostCall: boolean;
  hasConstFunctionParam: boolean;
  slotCountEstimate: number;
  heapWriteCountEstimate: number;
}

export type RecurrenceKind = "finite_static" | "tail_linear" | "structural" | "general_recursive";

export interface DomainMeasure {
  kind: "domain";
  param: string;
  cardinality: number;
  direction?: "increasing" | "decreasing";
  terminates: boolean;
}

export interface RecursiveCall {
  clause: string;
  target: string;
  tail: boolean;
  args: Expr[];
}

export interface RecurrenceClause {
  fn: string;
  paramDomains: (RefinedI32Domain | undefined)[];
  body: BlockExpr;
}

export interface Recurrence {
  fn: string;
  params: string[];
  clauses: RecurrenceClause[];
  recursiveCalls: RecursiveCall[];
  measure?: DomainMeasure;
  kind: RecurrenceKind;
}

export type RewriteRuleId =
  | "const.binary.i32"
  | "domain.compare.always_true"
  | "domain.compare.always_false"
  | "match.constant_scrutinee"
  | "call.inline.private_scalar"
  | "call.inline.private_product"
  | "call.inline.generated_const_fn"
  | "call.inline.tail_exposure"
  | "call.inline.skip_public"
  | "call.inline.skip_effectful"
  | "call.inline.skip_recursive"
  | "call.inline.skip_budget"
  | "recurrence.unfold.finite_static"
  | "recurrence.lower.tail_loop"
  | "recurrence.keep_recursive"
  | "array.project.used_slots"
  | "array.pack.narrow_unsigned"
  | "array.layout_packed"
  | "array.layout_flat"
  | "array.layout_scratch"
  | "array.layout_local_slots"
  | "product.project.known_slot"
  | "effect.preserve.unused_call_drop";

export interface RewriteRule {
  id: RewriteRuleId;
  reason: string;
}

export type OptimizationRuleId = RewriteRuleId;

export interface OptimizationRule {
  id: OptimizationRuleId;
  phase: "facts" | "plan" | "rewrite" | "lower";
  structuralMatcher: string;
}

export const OPTIMIZATION_RULES: readonly OptimizationRule[] = [
  {
    id: "recurrence.lower.tail_loop",
    phase: "plan",
    structuralMatcher: "pure direct self-tail recurrence",
  },
  {
    id: "recurrence.unfold.finite_static",
    phase: "plan",
    structuralMatcher: "finite monotone refined-i32 recurrence within profile budget",
  },
  {
    id: "domain.compare.always_true",
    phase: "plan",
    structuralMatcher: "comparison truth implied by abstract/domain facts",
  },
  {
    id: "domain.compare.always_false",
    phase: "plan",
    structuralMatcher: "comparison falsehood implied by abstract/domain facts",
  },
  {
    id: "product.project.known_slot",
    phase: "rewrite",
    structuralMatcher: "effect-safe known product projected by slot",
  },
  {
    id: "array.project.used_slots",
    phase: "rewrite",
    structuralMatcher: "fixed-size array update/project with known slot use",
  },
  {
    id: "array.layout_packed",
    phase: "plan",
    structuralMatcher: "narrow fixed array fits packed scalar storage under profile",
  },
  {
    id: "call.inline.private_scalar",
    phase: "plan",
    structuralMatcher: "private pure scalar helper within inline budget",
  },
  {
    id: "call.inline.tail_exposure",
    phase: "plan",
    structuralMatcher: "single-use private pure scalar helper exposing caller self-tail recursion",
  },
] as const;

export interface LayoutCandidate {
  target: string;
  layout: "flat" | "packed" | "scratch" | "local_slots";
  reason: string;
}

export interface FunctionFacts {
  typeFacts: Map<string, string>;
  domainFacts: Map<string, RefinedI32Domain>;
  constFacts: Map<string, Expr>;
  effectClass: "pure" | "read_only" | "state" | "volatile" | "host";
  recurrence?: Recurrence;
  callCount: number;
  astCost: number;
  estimatedWasmCost: number;
  layoutCandidates: Map<string, LayoutCandidate[]>;
}

export interface RepresentationPlan {
  candidates: Map<string, LayoutCandidate[]>;
}

export interface OptimizationPlan {
  profile: OptimizeProfileName;
  functions: Map<string, FunctionPlan>;
  decisions: OptimizationDecision[];
}

export interface FunctionPlan {
  name: string;
  summary: FunctionSummary;
  facts: FunctionFacts;
  recurrence?: Recurrence;
  representation?: RepresentationPlan;
  actions: PlannedAction[];
}

export type PlannedAction =
  | { kind: "inline"; target: string; reason: string; rule: RewriteRuleId }
  | { kind: "unfold_recurrence"; recurrence: string; cardinality: number; reason: string }
  | { kind: "lower_tail_loop"; recurrence: string; reason: string }
  | { kind: "keep_recursive"; recurrence: string; reason: string }
  | { kind: "fold_domain_branch"; reason: string; rule: RewriteRuleId }
  | {
    kind: "choose_layout";
    target: string;
    layout: "flat" | "packed" | "scratch" | "local_slots";
    reason: string;
  }
  | { kind: "drop_unreachable"; name: string; reason: string };

export interface OptimizationDecision {
  pass: string;
  target: string;
  action: RewriteRuleId | PlannedAction["kind"];
  reason: string;
  evidence?: Record<string, unknown>;
  beforeCost?: number;
  afterCost?: number;
}

export type AbstractValue =
  | { kind: "unreachable" }
  | { kind: "unknown" }
  | {
    kind: "constant";
    literalKind: "number" | "bool" | "string" | "char" | "literalType";
    value: string;
  }
  | { kind: "i32_domain"; type: string; domain: RefinedI32Domain }
  | { kind: "bool_domain"; values: boolean[] }
  | { kind: "product"; slots: { label?: string; value: AbstractValue }[] };

export interface AbstractFunctionFacts {
  name: string;
  params: Map<string, AbstractValue>;
  locals: Map<string, AbstractValue>;
  returnValue: AbstractValue;
}

export function optimizeProgram(program: Program, options: OptimizeOptions = {}): Program {
  const config = optimizerConfig(options);
  const optimized = traceSync(
    options.trace,
    "opt.clone",
    () => structuredClone(program) as Program,
    (
      result,
    ) => optimizerTraceCounters(result),
  );
  const scope = traceSync(
    options.trace,
    "opt.scope",
    () => buildOptimizationScope(optimized),
    (result) => optimizerTraceCounters(optimized, result),
  );
  if (config.rewriteUnusedPrivateParams) {
    traceSync(
      options.trace,
      "opt.inlinePureForwardingWrappers",
      () => inlinePureForwardingWrappers(optimized, scope),
      (changed) => optimizerTraceCounters(optimized, scope, { changedFunctions: changed ? 1 : 0 }),
    );
    traceSync(
      options.trace,
      "opt.expandFiniteStaticRecurrences.initial",
      () => expandFiniteStaticRecurrences(optimized, config, scope),
      (changed) => optimizerTraceCounters(optimized, scope, { changedFunctions: changed ? 1 : 0 }),
    );
    traceSync(
      options.trace,
      "opt.lowerTailRecurrenceClauseGroups",
      () => lowerTailRecurrenceClauseGroups(optimized, config, scope),
      (changed) => optimizerTraceCounters(optimized, scope, { changedFunctions: changed ? 1 : 0 }),
    );
    traceSync(
      options.trace,
      "opt.expandFiniteStaticRecurrences.second",
      () => false,
      () => optimizerTraceCounters(optimized, scope, { changedFunctions: 0 }),
    );
  }
  runOptimizePasses(optimized, config, scope, options.trace);
  if (options.assumeRewrites) {
    traceSync(
      options.trace,
      "opt.applyAssumeRewrites",
      () => applyAssumeRewrites(optimized, options),
      () => optimizerTraceCounters(optimized, scope),
    );
  }
  if (config.rewriteUnusedPrivateParams) {
    traceSync(
      options.trace,
      "opt.rewriteUnusedPrivateParams",
      () => rewriteUnusedPrivateParams(optimized, scope),
      () => optimizerTraceCounters(optimized, scope),
    );
  }
  return optimized;
}

function inlinePureForwardingWrappers(
  program: Program,
  scope: OptimizationScope,
): boolean {
  const functions = functionMap(program, scope);
  const forwarding = forwardingWrappers(functions);
  for (const [name] of forwarding) {
    if (functions.get(name)?.generated) forwarding.delete(name);
  }
  if (!forwarding.size) return false;
  let changed = false;
  const rewriteBlock = (block: BlockExpr): BlockExpr => ({
    ...block,
    statements: block.statements.map((stmt) =>
      stmt.kind === "proof_const" ? stmt : { ...stmt, value: rewriteExpr(stmt.value) }
    ),
    expr: block.expr ? rewriteExpr(block.expr) : undefined,
  });
  const rewriteExpr = (expr: Expr): Expr => {
    switch (expr.kind) {
      case "call": {
        const callee = rewriteExpr(expr.callee);
        const args = expr.args.map(rewriteExpr);
        if (callee.kind !== "var") return { ...expr, callee, args };
        const target = forwarding.get(callee.name);
        if (!target) return { ...expr, callee, args };
        changed = true;
        return { ...expr, callee: { kind: "var", name: target }, args };
      }
      case "block":
        return rewriteBlock(expr);
      case "const_fn":
        return { ...expr, body: rewriteExpr(expr.body) };
      case "index":
        return { ...expr, target: rewriteExpr(expr.target), index: rewriteExpr(expr.index) };
      case "binary":
        return { ...expr, left: rewriteExpr(expr.left), right: rewriteExpr(expr.right) };
      case "pipe_bind":
        return { ...expr, value: rewriteExpr(expr.value), body: rewriteExpr(expr.body) };
      case "match":
        return {
          ...expr,
          value: rewriteExpr(expr.value),
          arms: expr.arms.map((arm) => ({ ...arm, value: rewriteExpr(arm.value) })),
        };
      case "shape":
      case "product_constructor":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({
            ...slot,
            index: slot.index ? rewriteExpr(slot.index) : undefined,
            value: rewriteExpr(slot.value),
          })),
        };
      case "static_for_slots":
        return {
          ...expr,
          source: expr.source.kind === "range"
            ? {
              ...expr.source,
              start: rewriteExpr(expr.source.start),
              end: rewriteExpr(expr.source.end),
            }
            : { ...expr.source, shape: rewriteExpr(expr.source.shape) },
          value: rewriteExpr(expr.value),
        };
      case "field":
        return { ...expr, value: rewriteExpr(expr.value), key: rewriteExpr(expr.key) };
      case "range":
        return { ...expr, start: rewriteExpr(expr.start), end: rewriteExpr(expr.end) };
      case "do":
      case "literal":
      case "var":
      case "placeholder":
        return expr;
    }
  };
  program.declarations = program.declarations.map((decl) => {
    if (decl.kind === "fn" && scope.reachableFunctions.has(decl.name)) {
      return { ...decl, body: rewriteBlock(decl.body) };
    }
    if (
      (decl.kind === "let" || decl.kind === "const") &&
      scope.reachableDeclarations.has(decl.name)
    ) {
      return { ...decl, value: rewriteExpr(decl.value) };
    }
    return decl;
  });
  return changed;
}

function runOptimizePasses(
  program: Program,
  config: OptimizerConfig,
  scope: OptimizationScope,
  trace?: CompileTraceSink,
): void {
  const maxPasses = Math.min(config.passes, 2);
  let previousInlineableNames: Set<string> | undefined;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (
      pass > 0 && previousInlineableNames?.size &&
      hasReachableGeneratedRecurrence(program, scope)
    ) break;
    const functions = traceSync(
      trace,
      `opt.pass.${pass}.functionMap`,
      () => functionMap(program, scope),
      (result) => optimizerTraceCounters(program, scope, { functions: result.size, pass }),
    );
    const forwarding = traceSync(
      trace,
      `opt.pass.${pass}.forwardingWrappers`,
      () => forwardingWrappers(functions),
      (result) => optimizerTraceCounters(program, scope, { changedFunctions: result.size, pass }),
    );
    const recurrences = summarizeRecurrences(program, scope);
    const summaries = traceSync(
      trace,
      `opt.pass.${pass}.summaries`,
      () => functionSummaries(program, functions, recurrences, scope),
      (result) => optimizerTraceCounters(program, scope, { functions: result.size, pass }),
    );
    const plan = traceSync(
      trace,
      `opt.pass.${pass}.plan`,
      () =>
        buildOptimizationPlan(
          program,
          config.profile,
          { functions, summaries, recurrences },
          scope,
        ),
      (result) =>
        optimizerTraceCounters(program, scope, {
          changedFunctions: result.decisions.length,
          pass,
        }),
    );
    const inlineable = traceSync(
      trace,
      `opt.pass.${pass}.inlineable`,
      () => inlineableFunctions(functions, plan),
      (result) => optimizerTraceCounters(program, scope, { functions: result.size, pass }),
    );
    const inlineableNames = new Set(inlineable.keys());
    previousInlineableNames = inlineableNames;
    traceSync(
      trace,
      `opt.pass.${pass}.optimizeDecls`,
      () => {
        program.declarations = program.declarations.map((decl) =>
          optimizeDecl(decl, forwarding, inlineable, functions, config, scope)
        );
      },
      () => optimizerTraceCounters(program, scope, { pass }),
    );
    traceSync(
      trace,
      `opt.pass.${pass}.foldAbstractFacts`,
      () => foldAbstractFactsInProgram(program, scope),
      () => optimizerTraceCounters(program, scope, { pass }),
    );
  }
}

function optimizerConfig(options: OptimizeOptions): OptimizerConfig {
  const profile = resolveOptimizeProfile(options);
  return {
    profile,
    scalarInlineBudget: profile.inline.scalarBudget,
    productInlineBudget: profile.inline.productBudget,
    passes: profile.abstract.maxPasses,
    rewriteUnusedPrivateParams: profile.name !== "debug",
  };
}

function hasReachableGeneratedRecurrence(program: Program, scope: OptimizationScope): boolean {
  const functions = functionMap(program, scope);
  for (const recurrence of summarizeRecurrences(program, scope).values()) {
    const dispatcher = functions.get(recurrence.fn);
    if (dispatcher?.generated) return true;
    if (recurrence.clauses.some((clause) => functions.get(clause.fn)?.generated)) return true;
  }
  return false;
}

function resolveOptimizeProfile(options: OptimizeOptions = {}): OptimizeProfile {
  if (typeof options.profile === "string") return OPTIMIZE_PROFILES[options.profile];
  if (options.profile) return options.profile;
  return options.optMode === "release"
    ? OPTIMIZE_PROFILES.release_balanced
    : OPTIMIZE_PROFILES.debug;
}

function isCurrentModulePublic(fn: FnDecl): boolean {
  return fn.rootPublic ?? (fn.public && !fn.imported);
}

function optimizerTraceCounters(
  program: Program,
  scope?: OptimizationScope,
  extra: Record<string, number | boolean | string | undefined> = {},
): Record<string, number | boolean | string | undefined> {
  const functions = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  return {
    declarations: program.declarations.length,
    functions: functions.length,
    generatedFunctions: functions.filter((decl) => decl.generated).length,
    contracts: program.declarations.filter((decl) => decl.kind === "contract").length,
    reachableFunctions: scope?.reachableFunctions.size,
    changedFunctions: scope?.reachableFunctions.size,
    ...extra,
  };
}

export function buildOptimizationScope(program: Program): OptimizationScope {
  const declarations = new Map(program.declarations.map((decl) => [decl.name, decl]));
  const functions = new Map(
    program.declarations
      .filter((decl): decl is FnDecl => decl.kind === "fn")
      .map((decl) => [decl.name, decl]),
  );
  for (const item of program.imports) {
    functions.set(item.name, {
      kind: "fn",
      public: false,
      imported: true,
      rootPublic: false,
      name: item.name,
      params: [],
      returnType: item.type,
      effects: item.effects,
      body: { kind: "block", statements: [] },
      primitiveId: "host_effect",
    });
  }
  const runtimeRoots = new Set(
    [...functions.values()]
      .filter((fn) => isCurrentModulePublic(fn) && !fn.primitiveId)
      .map((fn) => fn.name),
  );
  const reachableFunctions = new Set<string>();
  const reachableDeclarations = new Set<string>();
  const queue = [...runtimeRoots];

  const enqueue = (name: string | undefined) => {
    if (!name || reachableDeclarations.has(name)) return;
    queue.push(name);
  };
  const visitDeclReferences = (decl: Declaration | undefined) => {
    if (!decl) return;
    const refs = decl.kind === "fn"
      ? referencedRuntimeNames(decl.body)
      : decl.kind === "let" || decl.kind === "const"
      ? referencedRuntimeNames(decl.value)
      : [];
    for (const ref of refs) {
      if (functions.has(ref) || declarations.has(ref)) enqueue(ref);
    }
    if (decl.kind === "fn") {
      for (const called of calledFunctionList(decl.body)) {
        if (functions.has(called)) enqueue(called);
      }
    } else if (decl.kind === "let" || decl.kind === "const") {
      for (const called of calledFunctionList(decl.value)) {
        if (functions.has(called)) enqueue(called);
      }
    }
  };

  while (queue.length) {
    const name = queue.shift()!;
    if (reachableDeclarations.has(name)) continue;
    reachableDeclarations.add(name);
    if (functions.has(name)) reachableFunctions.add(name);
    visitDeclReferences(declarations.get(name));
  }

  return { runtimeRoots, reachableFunctions, reachableDeclarations };
}

function referencedRuntimeNames(expr: Expr | BlockExpr | undefined): string[] {
  const names: string[] = [];
  const visit = (item: Expr | BlockExpr | Statement | DoStatement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "var":
        names.push(item.name);
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
        visit(item.body);
        return;
      case "match":
        visit(item.value);
        item.arms.forEach((arm) => visit(arm.value));
        return;
      case "shape":
      case "product_constructor":
        if (item.kind === "product_constructor") names.push(item.constructor);
        item.slots.forEach((slot) => {
          visit(slot.index);
          visit(slot.value);
        });
        return;
      case "static_for_slots":
        if (item.source.kind === "range") {
          visit(item.source.start);
          visit(item.source.end);
        } else visit(item.source.shape);
        visit(item.value);
        return;
      case "field":
        visit(item.value);
        visit(item.key);
        return;
      case "range":
        visit(item.start);
        visit(item.end);
        return;
      case "block":
        item.statements.forEach(visit);
        visit(item.expr);
        return;
      case "let":
      case "destructure_let":
      case "do_bind":
        visit(item.value);
        return;
      case "const_fn":
        visit(item.body);
        return;
      case "do":
        item.statements.forEach(visit);
        visit(item.expr);
        return;
      case "proof_const":
      case "literal":
      case "placeholder":
        return;
    }
  };
  visit(expr);
  return names;
}

interface RewriteTemplate {
  params: string[];
  body: Expr;
}

interface RewriteFact {
  source: string;
  owner?: string;
  generic?: {
    contract: string;
    typeParam: string;
  };
  left: RewriteTemplate;
  right: RewriteTemplate;
}

interface RewriteApplyContext {
  trace?: OptimizeOptions["trace"];
  target?: string;
}

function applyAssumeRewrites(program: Program, options: OptimizeOptions): Program {
  const facts = collectRewriteFacts(program);
  if (!facts.length) return program;
  program.declarations = program.declarations.map((decl) => {
    if (decl.kind === "fn") {
      return {
        ...decl,
        body: assumeRewriteBlock(decl.body, facts, decl.params, {
          trace: options.trace,
          target: decl.name,
        }),
      };
    }
    if (decl.kind === "let" || decl.kind === "const") {
      return {
        ...decl,
        value: assumeRewriteExpr(decl.value, facts, {
          trace: options.trace,
          target: decl.name,
        }),
      };
    }
    return decl;
  });
  return program;
}

function collectRewriteFacts(program: Program): RewriteFact[] {
  return program.declarations.flatMap((decl): RewriteFact[] => {
    if (decl.kind !== "contract" || decl.resultKind !== "rewrite") return [];
    const assume = decl.body.expr;
    if (
      assume?.kind !== "call" || assume.callee.kind !== "var" || assume.callee.name !== "@assume"
    ) {
      return [];
    }
    const [left, right] = assume.args;
    if (
      left?.kind !== "const_fn" || right?.kind !== "const_fn" ||
      left.params.length !== right.params.length
    ) return [];
    const generic = genericRewriteBinding(decl);
    return [{
      source: decl.name,
      ...(decl.memberOf ? { owner: decl.memberOf.owner } : {}),
      ...(generic ? { generic } : {}),
      left: { params: left.params, body: left.body },
      right: { params: right.params, body: right.body },
    }];
  });
}

function genericRewriteBinding(
  decl: Extract<Program["declarations"][number], { kind: "contract"; resultKind: "rewrite" }>,
): RewriteFact["generic"] | undefined {
  if (decl.params.length !== 1) return undefined;
  const typeParam = decl.params[0]?.name;
  if (!typeParam) return undefined;
  for (const stmt of decl.body.statements) {
    if (stmt.kind !== "proof_const") continue;
    const proof = typeCallParts(stmt.value);
    if (proof?.args.length === 1 && proof.args[0] === typeParam) {
      return { contract: proof.callee, typeParam };
    }
  }
  return undefined;
}

function typeCallParts(expr: TypeExpr): { callee: string; args: string[] } | undefined {
  if (expr.kind !== "type_call") return undefined;
  if (expr.callee.kind === "type_static_ref" && expr.callee.name === "satisfies") {
    const [effect, contract] = expr.args;
    const effectKey = effect ? typeExprKey(effect)[0] : undefined;
    const contractKey = contract ? typeExprKey(contract)[0] : undefined;
    return effectKey && contractKey ? { callee: contractKey, args: [effectKey] } : undefined;
  }
  if (expr.callee.kind !== "type_ref") return undefined;
  const args = expr.args.flatMap(typeExprKey);
  return args.length === expr.args.length ? { callee: expr.callee.name, args } : undefined;
}

function typeExprKey(expr: TypeExpr): string[] {
  switch (expr.kind) {
    case "type_ref":
      return [expr.name];
    case "type_call": {
      const callee = typeExprKey(expr.callee)[0];
      const args = expr.args.flatMap(typeExprKey);
      return callee && args.length === expr.args.length ? [`${callee}(${args.join(", ")})`] : [];
    }
    default:
      return [];
  }
}

function assumeRewriteBlock(
  block: BlockExpr,
  facts: RewriteFact[],
  params: Param[] = [],
  context: RewriteApplyContext = {},
): BlockExpr {
  const activeFacts = instantiateGenericRewriteFacts(block, facts, params);
  return {
    ...block,
    statements: block.statements.map((stmt) =>
      stmt.kind === "let" || stmt.kind === "destructure_let"
        ? { ...stmt, value: assumeRewriteExpr(stmt.value, activeFacts, context) } as Statement
        : stmt
    ),
    expr: block.expr ? assumeRewriteExpr(block.expr, activeFacts, context) : undefined,
  };
}

function instantiateGenericRewriteFacts(
  block: BlockExpr,
  facts: RewriteFact[],
  params: Param[],
): RewriteFact[] {
  const instantiated: RewriteFact[] = [];
  for (const param of params) {
    if (!param.const || !param.type) continue;
    const proof = proofTypeParts(param.type);
    if (!proof || proof.args.length !== 1) continue;
    instantiateProofRewriteFacts(facts, proof, instantiated);
  }
  for (const stmt of block.statements) {
    if (stmt.kind !== "proof_const") continue;
    const proof = typeCallParts(stmt.value);
    if (!proof || proof.args.length !== 1) continue;
    instantiateProofRewriteFacts(facts, proof, instantiated);
  }
  return rewriteFactsWithInstantiations(facts, instantiated);
}

function proofTypeParts(source: string): { callee: string; args: string[] } | undefined {
  const trimmed = source.trim();
  const open = trimmed.indexOf("(");
  if (open < 0 || !trimmed.endsWith(")")) return undefined;
  const callee = trimmed.slice(0, open).trim();
  const inner = trimmed.slice(open + 1, -1).trim();
  if (!callee || !inner) return undefined;
  return { callee, args: [inner] };
}

function instantiateProofRewriteFacts(
  facts: RewriteFact[],
  proof: { callee: string; args: string[] },
  instantiated: RewriteFact[],
) {
  const contracts = impliedContracts(proof.callee);
  for (const fact of facts) {
    if (!fact.generic || !contracts.has(contractBaseName(fact.generic.contract))) continue;
    instantiated.push(instantiateGenericRewriteFact(fact, proof.args[0]!));
  }
}

function rewriteFactsWithInstantiations(
  facts: RewriteFact[],
  instantiated: RewriteFact[],
): RewriteFact[] {
  return instantiated.length ? [...facts.filter((fact) => !fact.generic), ...instantiated] : facts;
}

function instantiateGenericRewriteFactsFromProof(
  facts: RewriteFact[],
  proof: { callee: string; args: string[] } | undefined,
): RewriteFact[] {
  if (!proof || proof.args.length !== 1) return facts;
  const instantiated: RewriteFact[] = [];
  instantiateProofRewriteFacts(facts, proof, instantiated);
  return rewriteFactsWithInstantiations(facts, instantiated);
}

function impliedContracts(contract: string): Set<string> {
  const base = contractBaseName(contract);
  const result = new Set([base]);
  const visit = (name: string) => {
    for (const implied of LAWFUL_CONTRACT_IMPLICATIONS.get(name) ?? []) {
      if (result.has(implied)) continue;
      result.add(implied);
      visit(implied);
    }
  };
  visit(base);
  return result;
}

function contractBaseName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

const LAWFUL_CONTRACT_IMPLICATIONS = new Map<string, string[]>([
  ["LawfulMonad", ["LawfulApplicative"]],
  ["LawfulApplicative", ["LawfulFunctor"]],
  ["LawfulMonoid", ["LawfulSemigroup"]],
]);

function instantiateGenericRewriteFact(fact: RewriteFact, concrete: string): RewriteFact {
  const typeParam = fact.generic!.typeParam;
  return {
    source: `${fact.source}<${concrete}>`,
    owner: concrete,
    left: {
      params: fact.left.params,
      body: substituteTypeConstructorRefs(fact.left.body, typeParam, concrete),
    },
    right: {
      params: fact.right.params,
      body: substituteTypeConstructorRefs(fact.right.body, typeParam, concrete),
    },
  };
}

function substituteTypeConstructorRefs(expr: Expr, typeParam: string, concrete: string): Expr {
  if (expr.kind === "var") {
    return {
      ...expr,
      name: expr.name === typeParam
        ? concrete
        : expr.name.startsWith(`${typeParam}::`)
        ? `${concrete}${expr.name.slice(typeParam.length)}`
        : expr.name.startsWith(`${typeParam}.`)
        ? `${concrete}${expr.name.slice(typeParam.length)}`
        : expr.name,
    };
  }
  switch (expr.kind) {
    case "const_fn":
      return { ...expr, body: substituteTypeConstructorRefs(expr.body, typeParam, concrete) };
    case "call":
      return {
        ...expr,
        callee: substituteTypeConstructorRefs(expr.callee, typeParam, concrete),
        args: expr.args.map((arg) => substituteTypeConstructorRefs(arg, typeParam, concrete)),
      };
    case "index":
      return {
        ...expr,
        target: substituteTypeConstructorRefs(expr.target, typeParam, concrete),
        index: substituteTypeConstructorRefs(expr.index, typeParam, concrete),
      };
    case "binary":
      return {
        ...expr,
        left: substituteTypeConstructorRefs(expr.left, typeParam, concrete),
        right: substituteTypeConstructorRefs(expr.right, typeParam, concrete),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: substituteTypeConstructorRefs(expr.value, typeParam, concrete),
        body: substituteTypeConstructorRefs(expr.body, typeParam, concrete),
      };
    case "match":
      return {
        ...expr,
        value: substituteTypeConstructorRefs(expr.value, typeParam, concrete),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: substituteTypeConstructorRefs(arm.value, typeParam, concrete),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: substituteTypeConstructorRefs(slot.value, typeParam, concrete),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: expr.source.kind === "range"
          ? {
            ...expr.source,
            start: substituteTypeConstructorRefs(expr.source.start, typeParam, concrete),
            end: substituteTypeConstructorRefs(expr.source.end, typeParam, concrete),
          }
          : {
            ...expr.source,
            shape: substituteTypeConstructorRefs(expr.source.shape, typeParam, concrete),
          },
        value: substituteTypeConstructorRefs(expr.value, typeParam, concrete),
      };
    case "field":
      return {
        ...expr,
        value: substituteTypeConstructorRefs(expr.value, typeParam, concrete),
        key: substituteTypeConstructorRefs(expr.key, typeParam, concrete),
      };
    case "range":
      return {
        ...expr,
        start: substituteTypeConstructorRefs(expr.start, typeParam, concrete),
        end: substituteTypeConstructorRefs(expr.end, typeParam, concrete),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "let" || stmt.kind === "destructure_let"
            ? {
              ...stmt,
              value: substituteTypeConstructorRefs(stmt.value, typeParam, concrete),
            } as Statement
            : stmt
        ),
        expr: expr.expr ? substituteTypeConstructorRefs(expr.expr, typeParam, concrete) : undefined,
      };
    case "do":
    case "literal":
    case "placeholder":
      return expr;
  }
}

function assumeRewriteExpr(
  expr: Expr,
  facts: RewriteFact[],
  context: RewriteApplyContext = {},
): Expr {
  const rewrittenChildren = assumeRewriteExprChildren(expr, facts, context);
  for (const fact of facts) {
    const bindings = new Map<string, Expr>();
    if (
      matchRewriteTemplate(fact.left.body, rewrittenChildren, new Set(fact.left.params), bindings)
    ) {
      traceInstant(context.trace, "rewrite.assume", {
        action: "assume_rewrite",
        target: context.target,
        reason: fact.source,
      });
      return assumeRewriteExpr(
        substituteRewriteTemplate(fact.right.body, bindings),
        facts,
        context,
      );
    }
  }
  return rewrittenChildren;
}

function assumeRewriteExprChildren(
  expr: Expr,
  facts: RewriteFact[],
  context: RewriteApplyContext,
): Expr {
  switch (expr.kind) {
    case "do": {
      const scopedFacts = instantiateGenericRewriteFactsFromProof(
        facts,
        typeCallParts(expr.strategy.effect),
      );
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
            ? { ...stmt, value: assumeRewriteExpr(stmt.value, scopedFacts, context) }
            : stmt
        ),
        expr: expr.expr ? assumeRewriteExpr(expr.expr, scopedFacts, context) : undefined,
      };
    }
    case "const_fn":
      return { ...expr, body: assumeRewriteExpr(expr.body, facts, context) };
    case "call":
      return {
        ...expr,
        callee: assumeRewriteExpr(expr.callee, facts, context),
        args: expr.args.map((arg) => assumeRewriteExpr(arg, facts, context)),
      };
    case "index":
      return {
        ...expr,
        target: assumeRewriteExpr(expr.target, facts, context),
        index: assumeRewriteExpr(expr.index, facts, context),
      };
    case "binary":
      return {
        ...expr,
        left: assumeRewriteExpr(expr.left, facts, context),
        right: assumeRewriteExpr(expr.right, facts, context),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: assumeRewriteExpr(expr.value, facts, context),
        body: assumeRewriteExpr(expr.body, facts, context),
      };
    case "match":
      return {
        ...expr,
        value: assumeRewriteExpr(expr.value, facts, context),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: assumeRewriteExpr(arm.value, facts, context),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: assumeRewriteExpr(slot.value, facts, context),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: expr.source.kind === "range"
          ? {
            ...expr.source,
            start: assumeRewriteExpr(expr.source.start, facts, context),
            end: assumeRewriteExpr(expr.source.end, facts, context),
          }
          : { ...expr.source, shape: assumeRewriteExpr(expr.source.shape, facts, context) },
        value: assumeRewriteExpr(expr.value, facts, context),
      };
    case "field":
      return {
        ...expr,
        value: assumeRewriteExpr(expr.value, facts, context),
        key: assumeRewriteExpr(expr.key, facts, context),
      };
    case "range":
      return {
        ...expr,
        start: assumeRewriteExpr(expr.start, facts, context),
        end: assumeRewriteExpr(expr.end, facts, context),
      };
    case "block":
      return assumeRewriteBlock(expr, facts, [], context);
    case "literal":
    case "placeholder":
    case "var":
      return expr;
  }
}

function matchRewriteTemplate(
  pattern: Expr,
  actual: Expr,
  params: Set<string>,
  bindings: Map<string, Expr>,
): boolean {
  if (pattern.kind === "var" && params.has(pattern.name)) {
    const existing = bindings.get(pattern.name);
    if (!existing) {
      bindings.set(pattern.name, actual);
      return true;
    }
    return stableExprKey(existing) === stableExprKey(actual);
  }
  if (pattern.kind !== actual.kind) return false;
  switch (pattern.kind) {
    case "literal":
      return actual.kind === "literal" && pattern.value === actual.value &&
        pattern.literalKind === actual.literalKind;
    case "var":
      return actual.kind === "var" && pattern.name === actual.name;
    case "placeholder":
      return actual.kind === "placeholder";
    case "call":
      return actual.kind === "call" &&
        matchRewriteTemplate(pattern.callee, actual.callee, params, bindings) &&
        pattern.args.length === actual.args.length &&
        pattern.args.every((arg, index) =>
          matchRewriteTemplate(arg, actual.args[index]!, params, bindings)
        );
    case "index":
      return actual.kind === "index" &&
        matchRewriteTemplate(pattern.target, actual.target, params, bindings) &&
        matchRewriteTemplate(pattern.index, actual.index, params, bindings);
    case "binary":
      return actual.kind === "binary" && pattern.op === actual.op &&
        matchRewriteTemplate(pattern.left, actual.left, params, bindings) &&
        matchRewriteTemplate(pattern.right, actual.right, params, bindings);
    default:
      return stableExprKey(pattern) === stableExprKey(actual);
  }
}

function substituteRewriteTemplate(expr: Expr, bindings: Map<string, Expr>): Expr {
  if (expr.kind === "var") return structuredClone(bindings.get(expr.name) ?? expr) as Expr;
  switch (expr.kind) {
    case "const_fn":
      return { ...expr, body: substituteRewriteTemplate(expr.body, bindings) };
    case "call":
      return {
        ...expr,
        callee: substituteRewriteTemplate(expr.callee, bindings),
        args: expr.args.map((arg) => substituteRewriteTemplate(arg, bindings)),
      };
    case "index":
      return {
        ...expr,
        target: substituteRewriteTemplate(expr.target, bindings),
        index: substituteRewriteTemplate(expr.index, bindings),
      };
    case "binary":
      return {
        ...expr,
        left: substituteRewriteTemplate(expr.left, bindings),
        right: substituteRewriteTemplate(expr.right, bindings),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: substituteRewriteTemplate(expr.value, bindings),
        body: substituteRewriteTemplate(expr.body, bindings),
      };
    case "match":
      return {
        ...expr,
        value: substituteRewriteTemplate(expr.value, bindings),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: substituteRewriteTemplate(arm.value, bindings),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: substituteRewriteTemplate(slot.value, bindings),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: expr.source.kind === "range"
          ? {
            ...expr.source,
            start: substituteRewriteTemplate(expr.source.start, bindings),
            end: substituteRewriteTemplate(expr.source.end, bindings),
          }
          : { ...expr.source, shape: substituteRewriteTemplate(expr.source.shape, bindings) },
        value: substituteRewriteTemplate(expr.value, bindings),
      };
    case "field":
      return {
        ...expr,
        value: substituteRewriteTemplate(expr.value, bindings),
        key: substituteRewriteTemplate(expr.key, bindings),
      };
    case "range":
      return {
        ...expr,
        start: substituteRewriteTemplate(expr.start, bindings),
        end: substituteRewriteTemplate(expr.end, bindings),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "let" || stmt.kind === "destructure_let"
            ? { ...stmt, value: substituteRewriteTemplate(stmt.value, bindings) } as Statement
            : stmt
        ),
        expr: expr.expr ? substituteRewriteTemplate(expr.expr, bindings) : undefined,
      };
    case "literal":
    case "placeholder":
    case "do":
      return expr;
  }
}

function functionMap(program: Program, scope?: OptimizationScope): Map<string, FnDecl> {
  const functions = new Map(
    program.declarations
      .filter((decl): decl is FnDecl =>
        decl.kind === "fn" && (!scope || scope.reachableFunctions.has(decl.name))
      )
      .map((decl) => [decl.name, decl]),
  );
  for (const item of program.imports) {
    if (scope && !scope.reachableFunctions.has(item.name)) continue;
    functions.set(item.name, {
      kind: "fn",
      public: false,
      imported: true,
      rootPublic: false,
      name: item.name,
      params: [],
      returnType: item.type,
      effects: item.effects,
      body: { kind: "block", statements: [] },
      primitiveId: "host_effect",
    });
  }
  return functions;
}

export function summarizeProgram(
  program: Program,
  options: OptimizeOptions = {},
): Map<string, FunctionSummary> {
  const functions = functionMap(program);
  return functionSummaries(program, functions, summarizeRecurrences(program));
}

export function summarizeOptimizationPlan(
  program: Program,
  options: OptimizeOptions = {},
): OptimizationPlan {
  const profile = resolveOptimizeProfile(options);
  return buildOptimizationPlan(program, profile);
}

export function summarizeRecurrences(
  program: Program,
  scope?: OptimizationScope,
): Map<string, Recurrence> {
  const declarations = program.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && (!scope || scope.reachableFunctions.has(decl.name))
  );
  const byBase = new Map<string, FnDecl[]>();
  for (const fn of declarations) {
    if (fn.primitiveId) continue;
    const base = recurrenceBaseName(fn.name);
    const callsBase = exprCallsFunction(fn.body, base);
    if (base === fn.name && !callsBase) continue;
    const group = byBase.get(base) ?? [];
    group.push(fn);
    byBase.set(base, group);
  }
  const recurrences = new Map<string, Recurrence>();
  for (const [base, clauses] of byBase) {
    const targets = new Set([base, ...clauses.map((fn) => fn.name)]);
    const recursiveCalls = clauses.flatMap((clause) =>
      recursiveCallDetails(clause.body, targets, clause.name, true)
    );
    if (!recursiveCalls.length) continue;
    const signature = clauses.find((fn) => fn.name === base) ?? clauses[0]!;
    const hasGeneratedClauses = clauses.some((fn) => fn.name !== base);
    const recurrenceClauses = clauses
      .filter((fn) => !(hasGeneratedClauses && fn.name === base))
      .map((fn): RecurrenceClause => ({
        fn: fn.name,
        paramDomains: fn.params.map((param) => parseRefinedI32Type(param.type)),
        body: fn.body,
      }));
    const measure = recurrenceDomainMeasure(
      signature.params,
      recurrenceClauses,
      recursiveCalls,
    );
    recurrences.set(base, {
      fn: base,
      params: signature.params.map((param) => param.name),
      clauses: recurrenceClauses,
      recursiveCalls,
      ...(measure ? { measure } : {}),
      kind: classifyRecurrence(recursiveCalls, recurrenceClauses, measure),
    });
  }
  return recurrences;
}

export function summarizeAbstractValues(program: Program): Map<string, AbstractFunctionFacts> {
  const result = new Map<string, AbstractFunctionFacts>();
  for (const fn of program.declarations) {
    if (fn.kind !== "fn") continue;
    const params = new Map(
      fn.params.map((param) => [param.name, abstractValueFromType(param.type)]),
    );
    const block = abstractBlock(fn.body, params);
    result.set(fn.name, {
      name: fn.name,
      params,
      locals: block.locals,
      returnValue: block.value,
    });
  }
  return result;
}

function buildOptimizationPlan(
  program: Program,
  profile: OptimizeProfile,
  precomputed: {
    functions?: Map<string, FnDecl>;
    summaries?: Map<string, FunctionSummary>;
    recurrences?: Map<string, Recurrence>;
  } = {},
  scope?: OptimizationScope,
): OptimizationPlan {
  const functions = precomputed.functions ?? functionMap(program, scope);
  const recurrences = precomputed.recurrences ?? summarizeRecurrences(program, scope);
  const summaries = precomputed.summaries ??
    functionSummaries(program, functions, recurrences, scope);
  const recurrenceIndex = recurrenceSummariesByFunction(recurrences);
  const plans = new Map<string, FunctionPlan>();
  const decisions: OptimizationDecision[] = [];

  for (const [name, summary] of summaries) {
    const fn = functions.get(name);
    const recurrence = recurrenceIndex.get(name);
    const facts = collectFunctionFacts(fn, summary, recurrence, profile);
    plans.set(name, {
      name,
      summary,
      facts,
      ...(recurrence ? { recurrence } : {}),
      representation: { candidates: facts.layoutCandidates },
      actions: [],
    });
  }

  const addAction = (
    target: string,
    action: PlannedAction,
    decision: Omit<OptimizationDecision, "target">,
  ) => {
    const plan = plans.get(target);
    if (plan) plan.actions.push(action);
    decisions.push({ target, ...decision });
  };

  for (const [name, summary] of summaries) {
    const fn = functions.get(name);
    if (!fn) continue;
    const inline = chooseInlineAction(fn, summary, profile);
    if (inline.action.kind === "inline") {
      addAction(name, inline.action, {
        pass: "plan.inline",
        action: inline.action.rule,
        reason: inline.action.reason,
        evidence: inline.evidence,
        beforeCost: summary.astCost,
      });
    } else {
      decisions.push({
        pass: "plan.inline",
        target: name,
        action: inline.rule,
        reason: inline.reason,
        evidence: inline.evidence,
        beforeCost: summary.astCost,
      });
    }
  }

  for (const candidate of tailExposureInlineCandidates(program, functions, summaries, scope)) {
    const plan = plans.get(candidate.helper.name);
    if (plan?.actions.some((action) => action.kind === "inline")) continue;
    const action: PlannedAction = {
      kind: "inline",
      target: candidate.helper.name,
      reason: candidate.reason,
      rule: "call.inline.tail_exposure",
    };
    addAction(candidate.helper.name, action, {
      pass: "plan.inline.tail_exposure",
      action: "call.inline.tail_exposure",
      reason: candidate.reason,
      evidence: {
        caller: candidate.caller.name,
        helperCallCount: candidate.summary.callCount,
        astCost: candidate.summary.astCost,
        returnClass: candidate.summary.returnClass,
      },
      beforeCost: candidate.summary.astCost,
    });
  }

  for (const recurrence of recurrences.values()) {
    const action = chooseRecurrenceAction(recurrence, functions, profile);
    const rule: RewriteRuleId = action.kind === "unfold_recurrence"
      ? "recurrence.unfold.finite_static"
      : action.kind === "lower_tail_loop"
      ? "recurrence.lower.tail_loop"
      : "recurrence.keep_recursive";
    addAction(recurrence.fn, action, {
      pass: "plan.recurrence",
      action: rule,
      reason: action.reason,
      evidence: {
        kind: recurrence.kind,
        cardinality: recurrence.measure?.cardinality,
        allTailCalls: recurrence.recursiveCalls.every((call) => call.tail),
        unfoldMaxCardinality: profile.recurrence.unfoldMaxCardinality,
        loopLowerMinCardinality: profile.recurrence.loopLowerMinCardinality,
      },
    });
  }

  addDomainFoldDecisions(program, plans, decisions, scope);

  return {
    profile: profile.name,
    functions: plans,
    decisions,
  };
}

function collectFunctionFacts(
  fn: FnDecl | undefined,
  summary: FunctionSummary,
  recurrence: Recurrence | undefined,
  profile: OptimizeProfile,
): FunctionFacts {
  const typeFacts = new Map<string, string>();
  const domainFacts = new Map<string, RefinedI32Domain>();
  const layoutCandidates = new Map<string, LayoutCandidate[]>();
  for (const param of fn?.params ?? []) {
    typeFacts.set(param.name, param.type);
    const domain = parseRefinedI32Type(param.type);
    if (domain) domainFacts.set(param.name, domain);
    const candidates = layoutCandidatesForType(param.name, param.type, profile);
    if (candidates.length) layoutCandidates.set(param.name, candidates);
  }
  return {
    typeFacts,
    domainFacts,
    constFacts: new Map(),
    effectClass: summary.effectClass,
    ...(recurrence ? { recurrence } : {}),
    callCount: summary.callCount,
    astCost: summary.astCost,
    estimatedWasmCost: summary.wasmCostEstimate,
    layoutCandidates,
  };
}

function layoutCandidatesForType(
  target: string,
  type: string | undefined,
  profile: OptimizeProfile,
): LayoutCandidate[] {
  const inline = type?.match(/InlineArray(?:List|Builder)?\((\d+),\s*([^)]+)\)/);
  if (!inline) return [];
  const slots = Number.parseInt(inline[1] ?? "0", 10);
  const itemType = inline[2]?.trim();
  const bitWidth = unsignedBitWidth(itemType);
  const candidates: LayoutCandidate[] = [];
  if (
    Number.isFinite(slots) && slots > 0 &&
    slots <= profile.layout.inlineArrayFlatMaxSlots
  ) {
    candidates.push({
      target,
      layout: "flat",
      reason: `inline array has ${slots} slots within flat local budget`,
    });
  }
  if (bitWidth !== undefined && slots * bitWidth <= profile.layout.packedBitMaxWidth) {
    candidates.push({
      target,
      layout: "packed",
      reason: `narrow unsigned ${itemType} array fits in ${slots * bitWidth} bits`,
    });
  }
  if (
    Number.isFinite(slots) && slots >= profile.layout.scratchMinSlots
  ) {
    candidates.push({
      target,
      layout: "scratch",
      reason: `array has ${slots} slots and may need dynamic indexed storage`,
    });
  }
  return candidates;
}

function chooseInlineAction(
  fn: FnDecl,
  summary: FunctionSummary,
  profile: OptimizeProfile,
): {
  action: PlannedAction | { kind: "skip"; reason: string };
  rule: RewriteRuleId;
  reason: string;
  evidence: Record<string, unknown>;
} {
  const budget = inlineBudgetForProfile(fn, summary, profile);
  const evidence = {
    astCost: summary.astCost,
    budget,
    returnClass: summary.returnClass,
    effectClass: summary.effectClass,
    recursiveKind: summary.recursiveKind,
    generatedInlineable: fn.generatedInlineable === true,
  };
  if (summary.isPrimitive) {
    return {
      action: { kind: "skip", reason: "primitive functions are lowered directly" },
      rule: "call.inline.skip_public",
      reason: "primitive functions are lowered directly",
      evidence,
    };
  }
  if (summary.isPublic && !profile.inline.allowPublicWrapperInlining) {
    return {
      action: { kind: "skip", reason: "public function inlining is disabled by profile" },
      rule: "call.inline.skip_public",
      reason: "public function inlining is disabled by profile",
      evidence,
    };
  }
  if (!summary.isPure) {
    return {
      action: { kind: "skip", reason: `effect class is ${summary.effectClass}` },
      rule: "call.inline.skip_effectful",
      reason: `effect class is ${summary.effectClass}`,
      evidence,
    };
  }
  if (summary.recursiveKind !== "none") {
    return {
      action: { kind: "skip", reason: `recursive kind is ${summary.recursiveKind}` },
      rule: "call.inline.skip_recursive",
      reason: `recursive kind is ${summary.recursiveKind}`,
      evidence,
    };
  }
  if (summary.astCost > budget) {
    return {
      action: { kind: "skip", reason: `astCost ${summary.astCost} exceeds budget ${budget}` },
      rule: "call.inline.skip_budget",
      reason: `astCost ${summary.astCost} exceeds budget ${budget}`,
      evidence,
    };
  }
  const rule: RewriteRuleId = fn.generatedInlineable
    ? "call.inline.generated_const_fn"
    : summary.returnClass === "scalar"
    ? "call.inline.private_scalar"
    : "call.inline.private_product";
  const reason = summary.returnClass === "scalar"
    ? `private pure scalar helper; astCost=${summary.astCost} <= scalarBudget=${budget}`
    : `private pure product helper; astCost=${summary.astCost} <= productBudget=${budget}`;
  return {
    action: { kind: "inline", target: fn.name, reason, rule },
    rule,
    reason,
    evidence,
  };
}

function tailExposureInlineCandidates(
  program: Program,
  functions: Map<string, FnDecl>,
  summaries: Map<string, FunctionSummary>,
  scope?: OptimizationScope,
): {
  helper: FnDecl;
  caller: FnDecl;
  summary: FunctionSummary;
  reason: string;
}[] {
  const valueUses = functionValueUses(program, functions);
  const candidates: {
    helper: FnDecl;
    caller: FnDecl;
    summary: FunctionSummary;
    reason: string;
  }[] = [];
  const visibleFunctions = [...functions.values()].filter((fn) =>
    !scope || scope.reachableFunctions.has(fn.name)
  );
  for (const helper of visibleFunctions) {
    const summary = summaries.get(helper.name);
    if (!summary || !tailExposureHelperEligible(helper, summary, valueUses, functions)) {
      continue;
    }
    for (const caller of visibleFunctions) {
      if (caller.name === helper.name || caller.primitiveId || caller.effects.length) continue;
      if (directSelfCalls(caller.body, caller.name, true).nonTail) continue;
      if (!tailCallsFunction(caller.body, helper.name)) continue;
      if (!tailCallsFunction(helper.body, caller.name)) continue;
      candidates.push({
        helper,
        caller,
        summary,
        reason:
          `single-use private pure scalar helper exposes tail call back to ${caller.name}`,
      });
    }
  }
  return candidates;
}

function tailExposureHelperEligible(
  fn: FnDecl,
  summary: FunctionSummary,
  valueUses: Set<string>,
  functions: Map<string, FnDecl>,
): boolean {
  return !summary.isPublic &&
    !summary.isPrimitive &&
    summary.isPure &&
    summary.effectClass === "pure" &&
    isScalarLikeRuntimeReturn(fn, summary) &&
    summary.recursiveKind === "none" &&
    summary.callCount === 1 &&
    !valueUses.has(fn.name) &&
    !hasRuntimeEffect(fn.body, functions);
}

function isScalarLikeRuntimeReturn(fn: FnDecl, summary: FunctionSummary): boolean {
  if (summary.returnClass === "scalar") return true;
  if (summary.returnClass !== "flat_product" || summary.slotCountEstimate !== 1) return false;
  const type = fn.returnType;
  if (!type) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_.]*\([^,{}]*\)$/.test(type.trim())) return false;
  return !/\bstruct\s*\(|[,{}]|\bInlineArray(?:List|Builder)?\b|\bBuffer\b|\bString\b|\bBytes\b|fn\s*\(/.test(
    type,
  );
}

function tailCallsFunction(block: BlockExpr, target: string): boolean {
  const calls = recursiveCallDetails(block, new Set([target]), target, true)
    .filter((call) => call.target === target);
  return calls.length > 0 && calls.every((call) => call.tail);
}

function chooseRecurrenceAction(
  recurrence: Recurrence,
  functions: Map<string, FnDecl>,
  profile: OptimizeProfile,
): PlannedAction {
  const cardinality = recurrence.measure?.cardinality;
  const allTail = recurrence.recursiveCalls.every((call) => call.tail);
  const clausesArePure = recurrence.clauses.every((clause) =>
    functions.get(clause.fn)?.effects.length === 0
  );
  if (!clausesArePure) {
    return {
      kind: "keep_recursive",
      recurrence: recurrence.fn,
      reason: "recurrence has effectful clauses",
    };
  }
  if (allTail && preferBackendInlineArrayLoopLowering(recurrence, functions)) {
    return {
      kind: "keep_recursive",
      recurrence: recurrence.fn,
      reason: "generated inline-array builder loop is handled by backend structural lowering",
    };
  }
  if (
    recurrence.kind === "finite_static" &&
    allTail &&
    preferLoopLoweringForGeneratedPipeline(recurrence, functions)
  ) {
    return {
      kind: "lower_tail_loop",
      recurrence: recurrence.fn,
      reason: "generated iterator pipeline recurrence is smaller as a loop",
    };
  }
  if (
    recurrence.kind === "finite_static" &&
    cardinality !== undefined &&
    cardinality <= profile.recurrence.unfoldMaxCardinality &&
    (allTail || profile.recurrence.allowNonTailFiniteUnfold)
  ) {
    return {
      kind: "unfold_recurrence",
      recurrence: recurrence.fn,
      cardinality,
      reason:
        `finite_static cardinality ${cardinality} <= unfoldMaxCardinality ${profile.recurrence.unfoldMaxCardinality}`,
    };
  }
  if (
    (recurrence.kind === "finite_static" || recurrence.kind === "tail_linear") &&
    allTail &&
    (cardinality === undefined || cardinality >= profile.recurrence.loopLowerMinCardinality)
  ) {
    return {
      kind: "lower_tail_loop",
      recurrence: recurrence.fn,
      reason: recurrence.kind === "finite_static"
        ? `finite_static cardinality ${cardinality} >= loopLowerMinCardinality ${profile.recurrence.loopLowerMinCardinality}`
        : "direct self-tail recursion",
    };
  }
  return {
    kind: "keep_recursive",
    recurrence: recurrence.fn,
    reason: "not finite-small and not tail-linear",
  };
}

function preferBackendInlineArrayLoopLowering(
  recurrence: Recurrence,
  functions: Map<string, FnDecl>,
): boolean {
  const dispatcher = functions.get(recurrence.fn);
  if (!dispatcher?.generated) return false;
  const names = [recurrence.fn, ...recurrence.clauses.map((clause) => clause.fn)];
  return names.some((name) => /(?:^|[._])InlineArray[._]/.test(name));
}

function preferLoopLoweringForGeneratedPipeline(
  recurrence: Recurrence,
  functions: Map<string, FnDecl>,
): boolean {
  const dispatcher = functions.get(recurrence.fn);
  if (!dispatcher?.generated) return false;
  const names = [recurrence.fn, ...recurrence.clauses.map((clause) => clause.fn)];
  return names.some((name) => /(?:^|[._])(?:Iter|CompactIter)[._]/.test(name));
}

function addDomainFoldDecisions(
  program: Program,
  plans: Map<string, FunctionPlan>,
  decisions: OptimizationDecision[],
  scope?: OptimizationScope,
): void {
  for (const fn of program.declarations) {
    if (fn.kind !== "fn") continue;
    if (scope && !scope.reachableFunctions.has(fn.name)) continue;
    const folds = foldableDomainBranchReasons(
      fn.body,
      new Map(
        fn.params.map((param) => [param.name, abstractValueFromType(param.type)]),
      ),
    );
    if (!folds.length) continue;
    const plan = plans.get(fn.name);
    for (const fold of folds) {
      const rule: RewriteRuleId = fold.value === "true"
        ? "domain.compare.always_true"
        : "domain.compare.always_false";
      const action: PlannedAction = {
        kind: "fold_domain_branch",
        reason: fold.reason,
        rule,
      };
      plan?.actions.push(action);
      decisions.push({
        pass: "plan.abstract",
        target: fn.name,
        action: rule,
        reason: fold.reason,
      });
    }
  }
}

function foldableDomainBranchReasons(
  block: BlockExpr,
  env: Map<string, AbstractValue>,
): { value: "true" | "false"; reason: string }[] {
  const reasons: { value: "true" | "false"; reason: string }[] = [];
  const visitExpr = (expr: Expr, scoped: Map<string, AbstractValue>) => {
    if (expr.kind === "match") {
      const value = abstractExpr(expr.value, scoped);
      if (
        value.kind === "constant" && value.literalKind === "bool" &&
        (value.value === "true" || value.value === "false")
      ) {
        reasons.push({
          value: value.value,
          reason: `match scrutinee is always ${value.value}`,
        });
      }
      visitExpr(expr.value, scoped);
      for (const arm of expr.arms) visitExpr(arm.value, scoped);
      return;
    }
    if (expr.kind === "block") {
      reasons.push(...foldableDomainBranchReasons(expr, new Map(scoped)));
      return;
    }
    for (const child of exprChildrenForPlanning(expr)) visitExpr(child, scoped);
  };
  for (const stmt of block.statements) {
    if (stmt.kind === "proof_const") continue;
    const value = abstractExpr(stmt.value, env);
    visitExpr(stmt.value, env);
    if (stmt.kind === "let") env.set(stmt.name, value);
    else for (const name of stmt.names) env.set(name, { kind: "unknown" });
  }
  if (block.expr) visitExpr(block.expr, env);
  return reasons;
}

function exprChildrenForPlanning(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "call":
      return [expr.callee, ...expr.args];
    case "const_fn":
      return [expr.body];
    case "index":
      return [expr.target, expr.index];
    case "binary":
      return [expr.left, expr.right];
    case "pipe_bind":
      return [expr.value, expr.body];
    case "shape":
    case "product_constructor":
      return expr.slots.flatMap((slot) => slot.index ? [slot.index, slot.value] : [slot.value]);
    case "static_for_slots":
      return [
        ...(expr.source.kind === "range" ? [expr.source.start, expr.source.end] : [
          expr.source.shape,
        ]),
        expr.value,
      ];
    case "field":
      return [expr.value, expr.key];
    case "range":
      return [expr.start, expr.end];
    case "match":
      return [expr.value, ...expr.arms.map((arm) => arm.value)];
    case "block":
    case "do":
    case "literal":
    case "var":
    case "placeholder":
      return [];
  }
}

function expandFiniteStaticRecurrences(
  program: Program,
  config: OptimizerConfig,
  scope?: OptimizationScope,
): boolean {
  const functions = functionMap(program, scope);
  const recurrenceSummaries = summarizeRecurrences(program, scope);
  const summaries = functionSummaries(program, functions, recurrenceSummaries, scope);
  const plan = buildOptimizationPlan(
    program,
    config.profile,
    { functions, summaries, recurrences: recurrenceSummaries },
    scope,
  );
  const recurrences = [...plan.functions.values()]
    .flatMap((item) =>
      item.actions.filter((
        action,
      ): action is Extract<PlannedAction, { kind: "unfold_recurrence" }> =>
        action.kind === "unfold_recurrence"
      )
    )
    .map((action) => plan.functions.get(action.recurrence)?.recurrence)
    .filter((recurrence): recurrence is Recurrence => Boolean(recurrence));
  if (!recurrences.length) return false;

  const byTarget = new Map<string, Recurrence>();
  for (const recurrence of recurrences) {
    byTarget.set(recurrence.fn, recurrence);
    for (const clause of recurrence.clauses) byTarget.set(clause.fn, recurrence);
  }

  let changed = false;
  const rewriteBlock = (block: BlockExpr, depths: Map<string, number>): BlockExpr => ({
    ...block,
    statements: block.statements.map((stmt) =>
      stmt.kind === "proof_const" ? stmt : { ...stmt, value: rewriteExpr(stmt.value, depths) }
    ),
    expr: block.expr ? rewriteExpr(block.expr, depths) : undefined,
  });
  const rewriteExpr = (expr: Expr, depths: Map<string, number>): Expr => {
    switch (expr.kind) {
      case "do":
        return {
          ...expr,
          statements: expr.statements.map((stmt) =>
            stmt.kind === "proof_const" ? stmt : { ...stmt, value: rewriteExpr(stmt.value, depths) }
          ),
          expr: expr.expr ? rewriteExpr(expr.expr, depths) : undefined,
        };
      case "const_fn":
        return { ...expr, body: rewriteExpr(expr.body, depths) };
      case "call": {
        const callee = rewriteExpr(expr.callee, depths);
        const args = expr.args.map((arg) => rewriteExpr(arg, depths));
        if (callee.kind !== "var") return { ...expr, callee, args };
        const recurrence = byTarget.get(callee.name);
        if (!recurrence?.measure) return { ...expr, callee, args };
        const depth = depths.get(recurrence.fn) ?? 0;
        if (depth > recurrence.measure.cardinality + 1) return { ...expr, callee, args };
        const expanded = expandFiniteStaticRecurrenceCall(
          recurrence,
          functions,
          args,
          depth,
        );
        if (!expanded) return { ...expr, callee, args };
        changed = true;
        return rewriteExpr(expanded, new Map(depths).set(recurrence.fn, depth + 1));
      }
      case "index":
        return {
          ...expr,
          target: rewriteExpr(expr.target, depths),
          index: rewriteExpr(expr.index, depths),
        };
      case "binary":
        return {
          ...expr,
          left: rewriteExpr(expr.left, depths),
          right: rewriteExpr(expr.right, depths),
        };
      case "pipe_bind":
        return {
          ...expr,
          value: rewriteExpr(expr.value, depths),
          body: rewriteExpr(expr.body, depths),
        };
      case "match":
        return {
          ...expr,
          value: rewriteExpr(expr.value, depths),
          arms: expr.arms.map((arm) => ({ ...arm, value: rewriteExpr(arm.value, depths) })),
        };
      case "shape":
      case "product_constructor":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({
            ...slot,
            index: slot.index ? rewriteExpr(slot.index, depths) : undefined,
            value: rewriteExpr(slot.value, depths),
          })),
        };
      case "static_for_slots":
        return {
          ...expr,
          source: rewriteFiniteStaticRecurrenceSource(expr.source, depths, rewriteExpr),
          value: rewriteExpr(expr.value, depths),
        };
      case "field":
        return {
          ...expr,
          value: rewriteExpr(expr.value, depths),
          key: rewriteExpr(expr.key, depths),
        };
      case "range":
        return {
          ...expr,
          start: rewriteExpr(expr.start, depths),
          end: rewriteExpr(expr.end, depths),
        };
      case "block":
        return rewriteBlock(expr, depths);
      case "literal":
      case "var":
      case "placeholder":
        return expr;
    }
  };

  program.declarations = program.declarations.map((decl) => {
    if (decl.kind === "fn") {
      if (scope && !scope.reachableFunctions.has(decl.name)) return decl;
      return { ...decl, body: rewriteBlock(decl.body, new Map()) };
    }
    if (decl.kind === "let" || decl.kind === "const") {
      if (scope && !scope.reachableDeclarations.has(decl.name)) return decl;
      return { ...decl, value: rewriteExpr(decl.value, new Map()) };
    }
    return decl;
  });
  return changed;
}

function lowerTailRecurrenceClauseGroups(
  program: Program,
  config: OptimizerConfig,
  scope?: OptimizationScope,
): boolean {
  const functions = functionMap(program, scope);
  const recurrences = summarizeRecurrences(program, scope);
  const summaries = functionSummaries(program, functions, recurrences, scope);
  const plan = buildOptimizationPlan(
    program,
    config.profile,
    { functions, summaries, recurrences },
    scope,
  );
  const replacements = new Map<string, FnDecl>();
  const remove = new Set<string>();
  for (const fnPlan of plan.functions.values()) {
    if (!fnPlan.actions.some((action) => action.kind === "lower_tail_loop")) continue;
    const recurrence = fnPlan.recurrence;
    if (!recurrence) continue;
    const dispatcher = functions.get(recurrence.fn);
    if (!dispatcher?.generated || dispatcher.primitiveId || dispatcher.effects.length) continue;
    const clauses = recurrence.clauses.map((clause) => functions.get(clause.fn));
    if (
      clauses.some((clause) =>
        !clause?.generated || recurrenceBaseName(clause.name) !== recurrence.fn ||
        clause.effects.length
      )
    ) continue;

    const clauseMap = new Map(clauses.map((clause) => [clause!.name, clause!]));
    const body = inlineGeneratedClauseCalls(dispatcher.body, clauseMap);
    if (!exprCallsFunction(body, recurrence.fn)) continue;
    replacements.set(recurrence.fn, {
      ...dispatcher,
      body,
      generatedInlineable: true,
    });
    for (const clause of clauses) remove.add(clause!.name);
  }
  if (!replacements.size) return false;
  program.declarations = program.declarations.flatMap((decl): Declaration[] => {
    if (decl.kind !== "fn") return [decl];
    const replacement = replacements.get(decl.name);
    if (replacement) return [replacement];
    return remove.has(decl.name) ? [] : [decl];
  });
  return true;
}

function inlineGeneratedClauseCalls(
  block: BlockExpr,
  clauses: Map<string, FnDecl>,
): BlockExpr {
  return {
    ...block,
    statements: block.statements.map((stmt): Statement =>
      stmt.kind === "proof_const"
        ? stmt
        : { ...stmt, value: inlineGeneratedClauseExpr(stmt.value, clauses) }
    ),
    expr: block.expr ? inlineGeneratedClauseExpr(block.expr, clauses) : undefined,
  };
}

function inlineGeneratedClauseExpr(expr: Expr, clauses: Map<string, FnDecl>): Expr {
  switch (expr.kind) {
    case "call": {
      const callee = inlineGeneratedClauseExpr(expr.callee, clauses);
      const args = expr.args.map((arg) => inlineGeneratedClauseExpr(arg, clauses));
      const clause = callee.kind === "var" ? clauses.get(callee.name) : undefined;
      return clause ? inlineGeneratedClauseBody(clause, args) : { ...expr, callee, args };
    }
    case "do":
      return expr;
    case "const_fn":
      return { ...expr, body: inlineGeneratedClauseExpr(expr.body, clauses) };
    case "index":
      return {
        ...expr,
        target: inlineGeneratedClauseExpr(expr.target, clauses),
        index: inlineGeneratedClauseExpr(expr.index, clauses),
      };
    case "binary":
      return {
        ...expr,
        left: inlineGeneratedClauseExpr(expr.left, clauses),
        right: inlineGeneratedClauseExpr(expr.right, clauses),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: inlineGeneratedClauseExpr(expr.value, clauses),
        body: inlineGeneratedClauseExpr(expr.body, clauses),
      };
    case "match":
      return {
        ...expr,
        value: inlineGeneratedClauseExpr(expr.value, clauses),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: inlineGeneratedClauseExpr(arm.value, clauses),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index ? inlineGeneratedClauseExpr(slot.index, clauses) : undefined,
          value: inlineGeneratedClauseExpr(slot.value, clauses),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: inlineGeneratedClauseStaticForSource(expr.source, clauses),
        value: inlineGeneratedClauseExpr(expr.value, clauses),
      };
    case "field":
      return {
        ...expr,
        value: inlineGeneratedClauseExpr(expr.value, clauses),
        key: inlineGeneratedClauseExpr(expr.key, clauses),
      };
    case "range":
      return {
        ...expr,
        start: inlineGeneratedClauseExpr(expr.start, clauses),
        end: inlineGeneratedClauseExpr(expr.end, clauses),
      };
    case "block":
      return inlineGeneratedClauseCalls(expr, clauses);
    case "literal":
    case "var":
    case "placeholder":
      return expr;
  }
}

function inlineGeneratedClauseStaticForSource(
  source: StaticForSource,
  clauses: Map<string, FnDecl>,
): StaticForSource {
  return source.kind === "range"
    ? {
      ...source,
      start: inlineGeneratedClauseExpr(source.start, clauses),
      end: inlineGeneratedClauseExpr(source.end, clauses),
    }
    : { ...source, shape: inlineGeneratedClauseExpr(source.shape, clauses) };
}

function inlineGeneratedClauseBody(fn: FnDecl, args: Expr[]): Expr {
  const statements: Statement[] = [];
  let body = alphaRenameInlineBlock(structuredClone(fn.body) as FnDecl["body"], fn.name);
  fn.params.forEach((param, index) => {
    const arg = args[index];
    if (!arg) return;
    const domain = parseRefinedI32Type(param.type);
    if (domain) {
      const alias = inlineBindingName(fn.name, `${param.name}_domain`);
      statements.push({
        kind: "let",
        name: alias,
        type: param.type,
        value: arg,
      });
      body = substituteVar(body, param.name, { kind: "var", name: alias }) as FnDecl["body"];
      return;
    }
    if (arg.kind === "var" || arg.kind === "literal") {
      body = substituteVar(body, param.name, arg) as FnDecl["body"];
      return;
    }
    const name = inlineBindingName(fn.name, param.name);
    statements.push({
      kind: "let",
      name,
      type: param.type,
      value: arg,
    });
    body = substituteVar(body, param.name, { kind: "var", name }) as FnDecl["body"];
  });
  return {
    kind: "block",
    statements: [...statements, ...body.statements],
    expr: body.expr,
  };
}

function expandFiniteStaticRecurrenceCall(
  recurrence: Recurrence,
  functions: Map<string, FnDecl>,
  args: Expr[],
  depth: number,
): Expr | undefined {
  const measure = recurrence.measure;
  if (!measure || depth > measure.cardinality + 1) return undefined;
  const measureIndex = recurrence.params.indexOf(measure.param);
  if (measureIndex < 0) return undefined;
  const value = evaluateIntegerExpr(args[measureIndex]);
  if (value === undefined) return undefined;
  const clause = recurrence.clauses.find((item) =>
    domainContainsInteger(item.paramDomains[measureIndex], value)
  );
  const fn = clause ? functions.get(clause.fn) : undefined;
  if (!fn || fn.params.length !== args.length) return undefined;
  return inlineRecurrenceClause(fn, args, measureIndex, value);
}

function inlineRecurrenceClause(
  fn: FnDecl,
  args: Expr[],
  measureIndex: number,
  measureValue: number,
): Expr {
  const statements: Statement[] = [];
  let body = alphaRenameInlineBlock(structuredClone(fn.body) as FnDecl["body"], fn.name);
  fn.params.forEach((param, index) => {
    const arg = args[index];
    if (index === measureIndex) {
      body = substituteVar(body, param.name, integerLiteral(measureValue)) as FnDecl["body"];
      return;
    }
    if (!arg || arg.kind === "var") {
      if (arg) body = substituteVar(body, param.name, arg) as FnDecl["body"];
      return;
    }
    if (arg.kind === "literal") {
      body = substituteVar(body, param.name, arg) as FnDecl["body"];
      return;
    }
    const paramName = inlineBindingName(fn.name, param.name);
    statements.push({
      kind: "let",
      name: paramName,
      type: param.type,
      value: arg,
    });
    body = substituteVar(body, param.name, { kind: "var", name: paramName }) as FnDecl["body"];
  });
  return {
    kind: "block",
    statements: [...statements, ...body.statements],
    expr: body.expr,
  };
}

function rewriteFiniteStaticRecurrenceSource(
  source: StaticForSource,
  depths: Map<string, number>,
  rewrite: (expr: Expr, depths: Map<string, number>) => Expr,
): StaticForSource {
  return source.kind === "range"
    ? {
      ...source,
      start: rewrite(source.start, depths),
      end: rewrite(source.end, depths),
    }
    : { ...source, shape: rewrite(source.shape, depths) };
}

function domainContainsInteger(domain: RefinedI32Domain | undefined, value: number): boolean {
  return literalIntervals(domain).some((interval) =>
    interval.start <= value && value < interval.end
  );
}

function evaluateIntegerExpr(expr: Expr | undefined): number | undefined {
  if (!expr) return undefined;
  if (expr.kind === "literal" && expr.literalKind === "number") {
    const value = Number(expr.value);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (expr.kind !== "binary") return undefined;
  const left = evaluateIntegerExpr(expr.left);
  const right = evaluateIntegerExpr(expr.right);
  if (left === undefined || right === undefined) return undefined;
  switch (expr.op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    default:
      return undefined;
  }
}

function integerLiteral(value: number): Expr {
  return { kind: "literal", literalKind: "number", value: String(value) };
}

function abstractBlock(
  block: BlockExpr,
  initialEnv: Map<string, AbstractValue>,
): { locals: Map<string, AbstractValue>; value: AbstractValue } {
  const env = new Map(initialEnv);
  const locals = new Map<string, AbstractValue>();
  for (const stmt of block.statements) {
    if (stmt.kind === "proof_const") continue;
    const value = abstractExpr(stmt.value, env);
    if (stmt.kind === "let") {
      env.set(stmt.name, value);
      locals.set(stmt.name, value);
    } else {
      for (const name of stmt.names) {
        env.set(name, { kind: "unknown" });
        locals.set(name, { kind: "unknown" });
      }
    }
  }
  return { locals, value: block.expr ? abstractExpr(block.expr, env) : { kind: "unknown" } };
}

function abstractExpr(expr: Expr, env: Map<string, AbstractValue>): AbstractValue {
  switch (expr.kind) {
    case "literal":
      if (
        expr.literalKind === "number" || expr.literalKind === "bool" ||
        expr.literalKind === "string" || expr.literalKind === "char" ||
        expr.literalKind === "literalType"
      ) {
        return { kind: "constant", literalKind: expr.literalKind, value: expr.value };
      }
      return { kind: "unknown" };
    case "var":
      return abstractVar(expr.name, env);
    case "binary":
      return abstractBinary(expr, env);
    case "match":
      return abstractMatch(expr, env);
    case "shape":
      return {
        kind: "product",
        slots: expr.slots.map((slot) => ({
          label: slot.label,
          value: abstractExpr(slot.value, env),
        })),
      };
    case "product_constructor":
      return {
        kind: "product",
        slots: expr.slots.map((slot) => ({
          label: slot.label,
          value: abstractExpr(slot.value, env),
        })),
      };
    case "field": {
      const value = abstractExpr(expr.value, env);
      const label = literalFieldLabel(expr.key);
      if (value.kind === "product" && label) {
        return value.slots.find((slot) => slot.label === label)?.value ?? { kind: "unknown" };
      }
      return { kind: "unknown" };
    }
    case "block":
      return abstractBlock(expr, new Map(env)).value;
    case "pipe_bind": {
      const scoped = new Map(env);
      scoped.set(expr.name, abstractExpr(expr.value, env));
      return abstractExpr(expr.body, scoped);
    }
    case "index":
    case "call":
    case "do":
    case "const_fn":
    case "static_for_slots":
    case "range":
    case "placeholder":
      return { kind: "unknown" };
  }
}

function abstractVar(name: string, env: Map<string, AbstractValue>): AbstractValue {
  const [base, ...fields] = name.split(".");
  let value = env.get(base ?? name) ?? { kind: "unknown" };
  for (const field of fields) {
    value = value.kind === "product"
      ? value.slots.find((slot) => slot.label === field)?.value ?? { kind: "unknown" }
      : { kind: "unknown" };
  }
  return value;
}

function abstractBinary(
  expr: Extract<Expr, { kind: "binary" }>,
  env: Map<string, AbstractValue>,
): AbstractValue {
  const left = abstractExpr(expr.left, env);
  const right = abstractExpr(expr.right, env);
  const folded = abstractFoldConstants(expr.op, left, right);
  if (folded) return folded;
  if (["==", "!=", "<", "<=", ">", ">="].includes(expr.op)) {
    const bool = abstractCompareDomains(expr.op, left, right);
    return bool ?? { kind: "bool_domain", values: [false, true] };
  }
  const range = abstractI32RangeForBinary(expr.op, left, right);
  return range ? abstractI32Range(range.min, range.max) : { kind: "unknown" };
}

function abstractFoldConstants(
  op: string,
  left: AbstractValue,
  right: AbstractValue,
): AbstractValue | undefined {
  if (left.kind !== "constant" || right.kind !== "constant") return undefined;
  if (left.literalKind === "number" && right.literalKind === "number") {
    const folded = foldIntegerLiteralBinary({
      kind: "binary",
      op,
      left: { kind: "literal", literalKind: "number", value: left.value },
      right: { kind: "literal", literalKind: "number", value: right.value },
    });
    return folded?.kind === "literal" &&
        (folded.literalKind === "number" || folded.literalKind === "bool")
      ? { kind: "constant", literalKind: folded.literalKind, value: folded.value }
      : undefined;
  }
  if (left.literalKind === "bool" && right.literalKind === "bool") {
    if (op === "==") {
      return { kind: "constant", literalKind: "bool", value: String(left.value === right.value) };
    }
    if (op === "!=") {
      return { kind: "constant", literalKind: "bool", value: String(left.value !== right.value) };
    }
  }
  return undefined;
}

function abstractCompareDomains(
  op: string,
  left: AbstractValue,
  right: AbstractValue,
): AbstractValue | undefined {
  const leftRange = abstractI32Range(left);
  const rightRange = abstractI32Range(right);
  if (!leftRange || !rightRange) return undefined;
  const value = rangeComparisonTruth(op, leftRange, rightRange);
  return value === undefined
    ? { kind: "bool_domain", values: [false, true] }
    : { kind: "constant", literalKind: "bool", value: String(value) };
}

function rangeComparisonTruth(
  op: string,
  left: { min: number; max: number },
  right: { min: number; max: number },
): boolean | undefined {
  if (op === "<") {
    if (left.max < right.min) return true;
    if (left.min >= right.max) return false;
  }
  if (op === "<=") {
    if (left.max <= right.min) return true;
    if (left.min > right.max) return false;
  }
  if (op === ">") return rangeComparisonTruth("<", right, left);
  if (op === ">=") return rangeComparisonTruth("<=", right, left);
  if (op === "==") {
    if (left.min === left.max && right.min === right.max && left.min === right.min) return true;
    if (left.max < right.min || right.max < left.min) return false;
  }
  if (op === "!=") {
    const equal = rangeComparisonTruth("==", left, right);
    return equal === undefined ? undefined : !equal;
  }
  return undefined;
}

function abstractI32RangeForBinary(
  op: string,
  left: AbstractValue,
  right: AbstractValue,
): { min: number; max: number } | undefined {
  const leftRange = abstractI32Range(left);
  const rightRange = abstractI32Range(right);
  if (!leftRange || !rightRange) return undefined;
  if (op === "+") {
    return checkedI32Range(leftRange.min + rightRange.min, leftRange.max + rightRange.max);
  }
  if (op === "-") {
    return checkedI32Range(leftRange.min - rightRange.max, leftRange.max - rightRange.min);
  }
  if (op === "*") {
    const values = [
      leftRange.min * rightRange.min,
      leftRange.min * rightRange.max,
      leftRange.max * rightRange.min,
      leftRange.max * rightRange.max,
    ];
    return checkedI32Range(Math.min(...values), Math.max(...values));
  }
  const rightConst = abstractNumberConstant(right);
  if (rightConst === undefined || rightConst <= 0 || leftRange.min < 0) return undefined;
  if (op === "/") return checkedI32Range(0, Math.floor(leftRange.max / rightConst));
  if (op === "%") return checkedI32Range(0, rightConst - 1);
  return undefined;
}

function abstractMatch(
  expr: Extract<Expr, { kind: "match" }>,
  env: Map<string, AbstractValue>,
): AbstractValue {
  const value = abstractExpr(expr.value, env);
  if (value.kind === "constant") {
    const selected = expr.arms.find((arm) => abstractPatternMatches(arm.pattern, value));
    return selected ? abstractExpr(selected.value, env) : { kind: "unreachable" };
  }
  if (value.kind === "bool_domain" && value.values.length === 1) {
    const constant: AbstractValue = {
      kind: "constant",
      literalKind: "bool",
      value: String(value.values[0]),
    };
    const selected = expr.arms.find((arm) => abstractPatternMatches(arm.pattern, constant));
    return selected ? abstractExpr(selected.value, env) : { kind: "unreachable" };
  }
  return { kind: "unknown" };
}

function abstractPatternMatches(
  pattern: ParamPattern,
  value: Extract<AbstractValue, { kind: "constant" }>,
): boolean {
  if (pattern.kind === "binding" || pattern.kind === "wildcard") return true;
  if (pattern.kind === "literal") return pattern.value === value.value;
  if (pattern.kind === "type") return pattern.name === value.value;
  return false;
}

function abstractValueFromType(type: string): AbstractValue {
  const domain = parseRefinedI32Type(type);
  if (domain) return { kind: "i32_domain", type: renderRefinedI32Domain(domain), domain };
  if (type === "i32") {
    return abstractI32Range(I32_MIN, I32_MAX);
  }
  if (type === "bool") return { kind: "bool_domain", values: [false, true] };
  return { kind: "unknown" };
}

function abstractI32Range(value: AbstractValue): { min: number; max: number } | undefined;
function abstractI32Range(min: number, max: number): AbstractValue;
function abstractI32Range(
  valueOrMin: AbstractValue | number,
  max?: number,
): { min: number; max: number } | AbstractValue | undefined {
  if (typeof valueOrMin === "number") {
    const facts = scalarFactsFromI32Range({ min: valueOrMin, max: max ?? valueOrMin });
    return { kind: "i32_domain", type: renderRefinedI32Domain(facts.domain), domain: facts.domain };
  }
  const value = valueOrMin;
  if (value.kind === "constant" && value.literalKind === "number") {
    const literal = Number.parseInt(value.value, 10);
    return Number.isSafeInteger(literal) ? { min: literal, max: literal } : undefined;
  }
  if (value.kind !== "i32_domain") return undefined;
  let min = Number.POSITIVE_INFINITY;
  let rangeMax = Number.NEGATIVE_INFINITY;
  for (const interval of value.domain.intervals) {
    if (interval.start.kind !== "literal" || interval.end.kind !== "literal") return undefined;
    min = Math.min(min, interval.start.value);
    rangeMax = Math.max(rangeMax, interval.end.value - 1);
  }
  return Number.isFinite(min) && Number.isFinite(rangeMax) ? { min, max: rangeMax } : undefined;
}

function checkedI32Range(min: number, max: number): { min: number; max: number } | undefined {
  return Number.isInteger(min) && Number.isInteger(max) && min >= I32_MIN && max <= I32_MAX
    ? { min, max }
    : undefined;
}

function abstractNumberConstant(value: AbstractValue): number | undefined {
  if (value.kind !== "constant" || value.literalKind !== "number") return undefined;
  const parsed = Number.parseInt(value.value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function foldAbstractFactsInProgram(program: Program, scope?: OptimizationScope): void {
  program.declarations = program.declarations.map((decl): Declaration => {
    if (decl.kind === "fn") {
      if (scope && !scope.reachableFunctions.has(decl.name)) return decl;
      const env = new Map(
        decl.params.map((param) => [param.name, abstractValueFromType(param.type)]),
      );
      return { ...decl, body: foldAbstractFactsInBlock(decl.body, env) };
    }
    if (decl.kind === "let" || decl.kind === "const") {
      if (scope && !scope.reachableDeclarations.has(decl.name)) return decl;
      return { ...decl, value: foldAbstractFactsInExpr(decl.value, new Map()) };
    }
    return decl;
  });
}

function foldAbstractFactsInBlock(
  block: BlockExpr,
  env: Map<string, AbstractValue>,
): BlockExpr {
  const scoped = new Map(env);
  const statements = block.statements.map((stmt): Statement => {
    if (stmt.kind === "proof_const") return stmt;
    const value = foldAbstractFactsInExpr(stmt.value, scoped);
    if (stmt.kind === "let") {
      scoped.set(stmt.name, abstractExpr(value, scoped));
      return { ...stmt, value };
    }
    for (const name of stmt.names) scoped.set(name, { kind: "unknown" });
    return { ...stmt, value };
  });
  return {
    ...block,
    statements,
    expr: block.expr ? foldAbstractFactsInExpr(block.expr, scoped) : undefined,
  };
}

function foldAbstractFactsInExpr(expr: Expr, env: Map<string, AbstractValue>): Expr {
  switch (expr.kind) {
    case "binary": {
      const folded = {
        ...expr,
        left: foldAbstractFactsInExpr(expr.left, env),
        right: foldAbstractFactsInExpr(expr.right, env),
      };
      return abstractConstantExpr(abstractExpr(folded, env)) ?? folded;
    }
    case "match": {
      const value = foldAbstractFactsInExpr(expr.value, env);
      const valueFact = abstractExpr(value, env);
      const constant = valueFact.kind === "constant"
        ? valueFact
        : valueFact.kind === "bool_domain" && valueFact.values.length === 1
        ? {
          kind: "constant" as const,
          literalKind: "bool" as const,
          value: String(valueFact.values[0]),
        }
        : undefined;
      if (constant) {
        const selected = expr.arms.find((arm) => abstractPatternMatches(arm.pattern, constant));
        if (selected) return foldAbstractFactsInExpr(selected.value, env);
      }
      return {
        ...expr,
        value,
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: foldAbstractFactsInExpr(arm.value, env),
        })),
      };
    }
    case "block":
      return foldAbstractFactsInBlock(expr, new Map(env));
    case "pipe_bind": {
      const value = foldAbstractFactsInExpr(expr.value, env);
      const scoped = new Map(env);
      scoped.set(expr.name, abstractExpr(value, env));
      return { ...expr, value, body: foldAbstractFactsInExpr(expr.body, scoped) };
    }
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index ? foldAbstractFactsInExpr(slot.index, env) : undefined,
          value: foldAbstractFactsInExpr(slot.value, env),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: foldAbstractFactsInExpr(slot.value, env),
        })),
      };
    case "field":
      return {
        ...expr,
        value: foldAbstractFactsInExpr(expr.value, env),
        key: foldAbstractFactsInExpr(expr.key, env),
      };
    case "index":
      return {
        ...expr,
        target: foldAbstractFactsInExpr(expr.target, env),
        index: foldAbstractFactsInExpr(expr.index, env),
      };
    case "call":
      return {
        ...expr,
        callee: foldAbstractFactsInExpr(expr.callee, env),
        args: expr.args.map((arg) => foldAbstractFactsInExpr(arg, env)),
      };
    case "const_fn":
      return { ...expr, body: foldAbstractFactsInExpr(expr.body, new Map()) };
    case "static_for_slots":
      return {
        ...expr,
        source: foldAbstractFactsInStaticForSource(expr.source, env),
        value: foldAbstractFactsInExpr(expr.value, env),
      };
    case "range":
      return {
        ...expr,
        start: foldAbstractFactsInExpr(expr.start, env),
        end: foldAbstractFactsInExpr(expr.end, env),
      };
    case "do":
      return expr;
    case "literal":
    case "var":
    case "placeholder":
      return abstractConstantExpr(abstractExpr(expr, env)) ?? expr;
  }
}

function foldAbstractFactsInStaticForSource(
  source: StaticForSource,
  env: Map<string, AbstractValue>,
): StaticForSource {
  return source.kind === "range"
    ? {
      ...source,
      start: foldAbstractFactsInExpr(source.start, env),
      end: foldAbstractFactsInExpr(source.end, env),
    }
    : { ...source, shape: foldAbstractFactsInExpr(source.shape, env) };
}

function abstractConstantExpr(value: AbstractValue): Expr | undefined {
  return value.kind === "constant"
    ? { kind: "literal", literalKind: value.literalKind, value: value.value }
    : undefined;
}

function functionSummaries(
  program: Program,
  functions: Map<string, FnDecl>,
  recurrences?: Map<string, Recurrence>,
  scope?: OptimizationScope,
): Map<string, FunctionSummary> {
  const callCounts = programCallCounts(program, scope);
  const recurrenceIndex = recurrences ? recurrenceSummariesByFunction(recurrences) : new Map();
  const summaries = new Map<string, FunctionSummary>();
  for (const fn of functions.values()) {
    const imported = fn.primitiveId === "host_effect" && fn.body.statements.length === 0 &&
      !program.declarations.includes(fn);
    const astCost = functionCost(fn);
    const recursiveKind = directSelfRecursiveKind(fn);
    const returnKind = returnClass(fn.returnType);
    const hostCall = exprHasHostCall(fn.body, functions);
    const recurrence = recurrenceIndex.get(fn.name);
    summaries.set(fn.name, {
      name: fn.name,
      isPublic: isCurrentModulePublic(fn),
      isPrimitive: Boolean(fn.primitiveId),
      isImported: imported,
      isPure: fn.effects.length === 0,
      effects: [...fn.effects],
      recursiveKind,
      astCost,
      wasmCostEstimate: astCost,
      runtimeInstructionEstimate: astCost,
      ...(recurrence?.measure
        ? { maxRecursionUnfoldingCardinality: recurrence.measure.cardinality }
        : {}),
      callCount: callCounts.get(fn.name) ?? 0,
      effectClass: effectClass(fn, imported, hostCall),
      allocationBehavior: allocationBehavior(returnKind),
      stackBehavior: stackBehavior(recursiveKind),
      returnClass: returnKind,
      paramEffects: inferParamEffects(fn, functions),
      hasMatch: exprHasKind(fn.body, "match"),
      hasLoopShape: exprCallsFunction(fn.body, fn.name),
      hasBranchIntrinsic: exprHasBranchIntrinsic(fn.body),
      hasHostCall: hostCall,
      hasConstFunctionParam: fn.params.some((param) => param.const && param.type.startsWith("fn")),
      slotCountEstimate: slotCountEstimate(fn.returnType),
      heapWriteCountEstimate: 0,
    });
  }
  return summaries;
}

function recurrenceSummariesByFunction(
  recurrences: Map<string, Recurrence>,
): Map<string, Recurrence> {
  const byFunction = new Map<string, Recurrence>();
  for (const recurrence of recurrences.values()) {
    byFunction.set(recurrence.fn, recurrence);
    for (const clause of recurrence.clauses) byFunction.set(clause.fn, recurrence);
  }
  return byFunction;
}

function effectClass(
  fn: FnDecl,
  imported: boolean,
  hostCall: boolean,
): FunctionSummary["effectClass"] {
  if (fn.effects.length === 0) return "pure";
  if (imported || fn.primitiveId === "host_effect" || hostCall) return "host";
  if (fn.effects.every((effect) => READ_ONLY_EFFECTS.has(effect))) return "read_only";
  if (fn.effects.some((effect) => VOLATILE_EFFECTS.has(effect))) return "volatile";
  return "state";
}

const READ_ONLY_EFFECTS = new Set(["read", "readonly", "read_only", "read-only"]);
const VOLATILE_EFFECTS = new Set(["time", "entropy", "random", "io"]);

function allocationBehavior(
  returnKind: FunctionSummary["returnClass"],
): FunctionSummary["allocationBehavior"] {
  switch (returnKind) {
    case "scalar":
      return "none";
    case "flat_product":
    case "inline_array":
      return "flat";
    case "heap_handle":
      return "heap";
    case "buffer_handle":
      return "buffer";
    case "closure":
      return "closure";
    case "multi":
      return "unknown";
  }
}

function stackBehavior(
  recursiveKind: FunctionSummary["recursiveKind"],
): FunctionSummary["stackBehavior"] {
  switch (recursiveKind) {
    case "none":
      return "none";
    case "self_tail":
      return "tail_call";
    case "self_non_tail":
      return "recursive_stack";
    case "mutual":
      return "mutual_or_unknown";
  }
}

function programCallCounts(program: Program, scope?: OptimizationScope): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const decl of program.declarations) {
    if (scope && !scope.reachableDeclarations.has(decl.name)) continue;
    if (decl.kind === "fn") { for (const name of calledFunctionList(decl.body)) add(name); }
    if ((decl.kind === "let" || decl.kind === "const")) {
      for (const name of calledFunctionList(decl.value)) add(name);
    }
  }
  return counts;
}

function returnClass(type: string | undefined): FunctionSummary["returnClass"] {
  if (!type) return "multi";
  if (isScalarRuntimeReturn(type)) return "scalar";
  if (/InlineArray|InlineArrayList|InlineArrayBuilder/.test(type)) return "inline_array";
  if (/Buffer|String|Bytes/.test(type)) return "buffer_handle";
  if (/fn\s*\(/.test(type)) return "closure";
  if (/[,{}]|\bstruct\(/.test(type)) return "flat_product";
  return "flat_product";
}

function slotCountEstimate(type: string | undefined): number {
  if (!type || isScalarRuntimeReturn(type)) return 1;
  const inline = type.match(/InlineArray\((\d+)/);
  if (inline) return Number.parseInt(inline[1] ?? "1", 10);
  return Math.max(1, splitTopLevel(type.replace(/^struct\((.*)\)$/, "$1")).length);
}

function inferParamEffects(
  fn: FnDecl,
  functions: Map<string, FnDecl>,
): FunctionSummary["paramEffects"] {
  const effects = new Map<string, "observe" | "consume" | "retain" | "alias_return">();
  for (const param of fn.params) {
    if (fn.body.expr && exprReturnsAlias(fn.body.expr, param.name)) {
      effects.set(param.name, "alias_return");
    } else if (paramUsedInEffectfulCall(fn.body, param.name, functions)) {
      effects.set(param.name, "retain");
    } else if (paramUsedAsWholeValue(fn.body, param.name)) {
      effects.set(param.name, "consume");
    } else {
      effects.set(param.name, "observe");
    }
  }
  return effects;
}

function forwardingWrappers(functions: Map<string, FnDecl>): Map<string, string> {
  const direct = new Map<string, string>();
  for (const fn of functions.values()) {
    const target = directForwardingTarget(fn);
    if (target && functions.has(target)) direct.set(fn.name, target);
  }

  const resolved = new Map<string, string>();
  for (const name of direct.keys()) {
    const target = resolveForwardingTarget(name, direct, functions);
    if (target) resolved.set(name, target);
  }
  return resolved;
}

function directForwardingTarget(fn: FnDecl): string | undefined {
  if (
    isCurrentModulePublic(fn) || fn.effects.length || fn.primitiveId ||
    fn.body.statements.length !== 0
  ) {
    return undefined;
  }
  const expr = fn.body.expr;
  if (!expr || expr.kind !== "call" || expr.callee.kind !== "var") return undefined;
  if (expr.args.length !== fn.params.length) return undefined;
  for (let index = 0; index < fn.params.length; index++) {
    const arg = expr.args[index];
    if (arg.kind !== "var" || arg.name !== fn.params[index].name) return undefined;
  }
  return expr.callee.name;
}

function resolveForwardingTarget(
  name: string,
  direct: Map<string, string>,
  functions: Map<string, FnDecl>,
): string | undefined {
  const seen = new Set<string>([name]);
  let target = direct.get(name);
  while (target) {
    if (seen.has(target)) return undefined;
    seen.add(target);
    const fn = functions.get(target);
    if (!fn) return undefined;
    if (!direct.has(target)) return target;
    target = direct.get(target);
  }
  return undefined;
}

function optimizeDecl(
  decl: Declaration,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
  scope?: OptimizationScope,
): Declaration {
  if (decl.kind === "fn") {
    if (scope && !scope.reachableFunctions.has(decl.name)) return decl;
    return {
      ...decl,
      body: optimizeBlock(decl.body, forwarding, inlineable, functions, {
        allowMultiValueResult: true,
        config,
      }),
    };
  }
  if (decl.kind === "let" || decl.kind === "const") {
    if (scope && !scope.reachableDeclarations.has(decl.name)) return decl;
    return { ...decl, value: optimizeExpr(decl.value, forwarding, inlineable, functions, config) };
  }
  return decl;
}

function optimizeBlock(
  block: BlockExpr,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  options: { allowMultiValueResult?: boolean; config: OptimizerConfig },
): BlockExpr {
  const { config } = options;
  const expr = block.expr
    ? optimizeExpr(block.expr, forwarding, inlineable, functions, config, {
      allowMultiValueResult: options.allowMultiValueResult,
    })
    : undefined;
  const optimized: BlockExpr = {
    ...block,
    statements: block.statements.map((stmt) =>
      optimizeStatement(stmt, forwarding, inlineable, functions, config)
    ),
    expr: options.allowMultiValueResult && expr
      ? inlineCallExpr(expr, inlineable, { allowMultiValue: true }) ?? expr
      : expr,
  };
  const singleUseInlined = inlineSingleUsePureLets(optimized, functions);
  const fixedUpdateFolded = foldFixedUpdateIndexLets(
    singleUseInlined,
    forwarding,
    inlineable,
    functions,
    config,
  );
  const staticProjectionFolded = foldStaticProjectionLets(
    fixedUpdateFolded,
    forwarding,
    inlineable,
    functions,
    config,
  );
  return removeUnusedPureLets(
    inlineSingleUsePureLets(staticProjectionFolded, functions),
    functions,
  );
}

function foldFixedUpdateIndexLets(
  block: BlockExpr,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
): BlockExpr {
  if (!block.expr || block.expr.kind !== "shape") return block;
  if (
    !block.expr.slots.some((slot) => slot.spread) || !block.expr.slots.some((slot) => slot.index)
  ) {
    return block;
  }

  const pureLets = pureLetValues(block, forwarding, inlineable, functions, config);
  if (!pureLets.size) return block;

  const replacements = new Map<string, Expr>();
  for (const slot of block.expr.slots) {
    if (!slot.index) continue;
    let candidate = slot.index;
    const contributors = new Set<string>();
    for (const [name, value] of pureLets) {
      if (!usedNames(candidate).has(name)) continue;
      candidate = substituteVar(candidate, name, value);
      contributors.add(name);
    }
    const optimized = optimizeExpr(candidate, forwarding, inlineable, functions, config);
    if (!isIntegerLiteral(optimized)) continue;
    for (const name of contributors) replacements.set(name, optimized);
  }
  if (!replacements.size) return block;
  return substituteLocalLetUses(block, replacements);
}

function pureLetValues(
  block: BlockExpr,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
): Map<string, Expr> {
  const values = new Map<string, Expr>();
  for (const stmt of block.statements) {
    if (stmt.kind === "proof_const") continue;
    let value = stmt.value;
    for (const [name, replacement] of values) {
      if (usedNames(value).has(name)) value = substituteVar(value, name, replacement);
    }
    value = optimizeExpr(value, forwarding, inlineable, functions, config);
    if (stmt.kind === "let" && !hasRuntimeEffect(value, functions)) {
      values.set(stmt.name, value);
      continue;
    }
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    for (const name of bindings) values.delete(name);
  }
  return values;
}

function substituteLocalLetUses(block: BlockExpr, replacements: Map<string, Expr>): BlockExpr {
  let active = new Map<string, Expr>();
  const statements = block.statements.map((stmt) => {
    if (stmt.kind === "proof_const") return stmt;
    const value = substituteMany(stmt.value, active);
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    active = new Map([...active].filter(([name]) => !bindings.includes(name)));
    if (stmt.kind === "let") {
      const replacement = replacements.get(stmt.name);
      if (replacement) active.set(stmt.name, replacement);
    }
    return { ...stmt, value };
  });
  return {
    ...block,
    statements,
    expr: block.expr ? substituteMany(block.expr, active) : undefined,
  };
}

function substituteMany(expr: Expr, replacements: Map<string, Expr>): Expr {
  let result = expr;
  for (const [name, value] of replacements) {
    if (usedNames(result).has(name)) result = substituteVar(result, name, value);
  }
  return result;
}

function inlineSingleUsePureLets(block: BlockExpr, functions: Map<string, FnDecl>): BlockExpr {
  const uses = usedNameCounts(block);
  const active = new Map<string, Expr>();
  const statements: Statement[] = [];
  for (const stmt of block.statements) {
    if (stmt.kind === "proof_const") {
      statements.push(stmt);
      continue;
    }
    const value = substituteMany(stmt.value, active);
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    for (const name of bindings) active.delete(name);
    if (
      stmt.kind === "let" &&
      (uses.get(stmt.name) ?? 0) === 1 &&
      !usedNames(value).has(stmt.name) &&
      isSpeculablePureInlineValue(value, functions)
    ) {
      active.set(stmt.name, value);
      continue;
    }
    statements.push({ ...stmt, value });
  }
  return {
    ...block,
    statements,
    expr: block.expr ? substituteMany(block.expr, active) : undefined,
  };
}

function isSpeculablePureInlineValue(expr: Expr, functions: Map<string, FnDecl>): boolean {
  if (hasRuntimeEffect(expr, functions)) return false;
  switch (expr.kind) {
    case "literal":
    case "var":
    case "placeholder":
      return true;
    case "binary":
      return expr.op !== "/" && expr.op !== "%" &&
        isSpeculablePureInlineValue(expr.left, functions) &&
        isSpeculablePureInlineValue(expr.right, functions);
    case "field":
      return isSpeculablePureInlineValue(expr.value, functions) &&
        isSpeculablePureInlineValue(expr.key, functions);
    case "shape":
      if (
        expr.syntax === "collection" ||
        expr.slots.some((slot) => !slot.label || slot.spread || slot.index || slot.repeat)
      ) {
        return false;
      }
      return expr.slots.every((slot) => isSpeculablePureInlineValue(slot.value, functions));
    case "product_constructor":
      return expr.slots.every((slot) => isSpeculablePureInlineValue(slot.value, functions));
    case "block":
      return expr.statements.length === 0 && Boolean(expr.expr) &&
        isSpeculablePureInlineValue(expr.expr!, functions);
    default:
      return false;
  }
}

function foldStaticProjectionLets(
  block: BlockExpr,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
  initialActive: Map<string, Expr> = new Map(),
): BlockExpr {
  const active = new Map(initialActive);
  const statements = block.statements.map((stmt) => {
    if (stmt.kind === "proof_const") return stmt;
    const value = optimizeExpr(
      rewriteStaticProjections(stmt.value, active, forwarding, inlineable, functions, config),
      forwarding,
      inlineable,
      functions,
      config,
    );
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    for (const name of bindings) active.delete(name);
    if (stmt.kind === "let") {
      const projected = staticProjectionSource(value, functions);
      if (projected) active.set(stmt.name, projected);
    }
    return { ...stmt, value };
  });
  return {
    ...block,
    statements,
    expr: block.expr
      ? optimizeExpr(
        rewriteStaticProjections(block.expr, active, forwarding, inlineable, functions, config),
        forwarding,
        inlineable,
        functions,
        config,
      )
      : undefined,
  };
}

function staticProjectionSource(expr: Expr, functions: Map<string, FnDecl>): Expr | undefined {
  if (expr.kind === "block" && expr.statements.length === 0 && expr.expr) {
    return staticProjectionSource(expr.expr, functions);
  }
  if (expr.kind !== "shape" && expr.kind !== "product_constructor") return undefined;
  if (hasRuntimeEffect(expr, functions)) return undefined;
  if (expr.slots.some((slot) => slot.spread || slot.index)) return undefined;
  return expr;
}

function rewriteStaticProjections(
  expr: Expr,
  active: Map<string, Expr>,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
): Expr {
  switch (expr.kind) {
    case "index": {
      const target = rewriteStaticProjections(
        expr.target,
        active,
        forwarding,
        inlineable,
        functions,
        config,
      );
      const index = rewriteStaticProjections(
        expr.index,
        active,
        forwarding,
        inlineable,
        functions,
        config,
      );
      const literalIndex = staticIntegerLiteral(index);
      if (target.kind === "var" && literalIndex !== undefined) {
        const source = active.get(target.name);
        const replacement = source?.kind === "shape" || source?.kind === "product_constructor"
          ? source.slots[literalIndex]?.value
          : undefined;
        if (replacement) {
          return rewriteProjectionReplacement(
            replacement,
            target.name,
            active,
            forwarding,
            inlineable,
            functions,
            config,
          );
        }
      }
      return { ...expr, target, index };
    }
    case "field": {
      const value = rewriteStaticProjections(
        expr.value,
        active,
        forwarding,
        inlineable,
        functions,
        config,
      );
      const key = rewriteStaticProjections(
        expr.key,
        active,
        forwarding,
        inlineable,
        functions,
        config,
      );
      const label = literalFieldLabel(key);
      if (value.kind === "var" && label) {
        const source = active.get(value.name);
        const replacement = source?.kind === "shape" || source?.kind === "product_constructor"
          ? source.slots.find((slot) => slot.label === label)?.value
          : undefined;
        if (replacement) {
          return rewriteProjectionReplacement(
            replacement,
            value.name,
            active,
            forwarding,
            inlineable,
            functions,
            config,
          );
        }
      }
      return { ...expr, value, key };
    }
    case "binary":
      return {
        ...expr,
        left: rewriteStaticProjections(
          expr.left,
          active,
          forwarding,
          inlineable,
          functions,
          config,
        ),
        right: rewriteStaticProjections(
          expr.right,
          active,
          forwarding,
          inlineable,
          functions,
          config,
        ),
      };
    case "call":
      return {
        ...expr,
        callee: rewriteStaticProjections(
          expr.callee,
          active,
          forwarding,
          inlineable,
          functions,
          config,
        ),
        args: expr.args.map((arg) =>
          rewriteStaticProjections(arg, active, forwarding, inlineable, functions, config)
        ),
      };
    case "pipe_bind": {
      const value = rewriteStaticProjections(
        expr.value,
        active,
        forwarding,
        inlineable,
        functions,
        config,
      );
      const scoped = new Map(active);
      scoped.delete(expr.name);
      return {
        ...expr,
        value,
        body: rewriteStaticProjections(
          expr.body,
          scoped,
          forwarding,
          inlineable,
          functions,
          config,
        ),
      };
    }
    case "match":
      return {
        ...expr,
        value: rewriteStaticProjections(
          expr.value,
          active,
          forwarding,
          inlineable,
          functions,
          config,
        ),
        arms: expr.arms.map((arm) => {
          const scoped = new Map(active);
          for (const name of patternBindingNames(arm.pattern)) scoped.delete(name);
          return {
            ...arm,
            value: rewriteStaticProjections(
              arm.value,
              scoped,
              forwarding,
              inlineable,
              functions,
              config,
            ),
          };
        }),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index
            ? rewriteStaticProjections(
              slot.index,
              active,
              forwarding,
              inlineable,
              functions,
              config,
            )
            : undefined,
          value: rewriteStaticProjections(
            slot.value,
            active,
            forwarding,
            inlineable,
            functions,
            config,
          ),
        })),
      };
    case "static_for_slots": {
      const scoped = new Map(active);
      scoped.delete(expr.iterator);
      if (expr.valueIterator) scoped.delete(expr.valueIterator);
      return {
        ...expr,
        source: rewriteStaticForProjectionSource(
          expr.source,
          active,
          forwarding,
          inlineable,
          functions,
          config,
        ),
        value: rewriteStaticProjections(
          expr.value,
          scoped,
          forwarding,
          inlineable,
          functions,
          config,
        ),
      };
    }
    case "range":
      return {
        ...expr,
        start: rewriteStaticProjections(
          expr.start,
          active,
          forwarding,
          inlineable,
          functions,
          config,
        ),
        end: rewriteStaticProjections(expr.end, active, forwarding, inlineable, functions, config),
      };
    case "block":
      return foldStaticProjectionLets(
        expr,
        forwarding,
        inlineable,
        functions,
        config,
        active,
      );
    case "const_fn":
      return {
        ...expr,
        body: rewriteStaticProjections(
          expr.body,
          active,
          forwarding,
          inlineable,
          functions,
          config,
        ),
      };
    case "var": {
      const [base, field] = expr.name.split(".", 2);
      if (base && field) {
        const source = active.get(base);
        const replacement = source?.kind === "shape" || source?.kind === "product_constructor"
          ? source.slots.find((slot) => slot.label === field)?.value
          : undefined;
        if (replacement) {
          return rewriteProjectionReplacement(
            replacement,
            base,
            active,
            forwarding,
            inlineable,
            functions,
            config,
          );
        }
      }
      return expr;
    }
    case "do":
    case "literal":
    case "placeholder":
      return expr;
  }
}

function rewriteProjectionReplacement(
  replacement: Expr,
  sourceName: string,
  active: Map<string, Expr>,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
): Expr {
  const scoped = new Map(active);
  scoped.delete(sourceName);
  return rewriteStaticProjections(replacement, scoped, forwarding, inlineable, functions, config);
}

function rewriteStaticForProjectionSource(
  source: StaticForSource,
  active: Map<string, Expr>,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
): StaticForSource {
  if (source.kind === "range") {
    return {
      ...source,
      start: rewriteStaticProjections(
        source.start,
        active,
        forwarding,
        inlineable,
        functions,
        config,
      ),
      end: rewriteStaticProjections(source.end, active, forwarding, inlineable, functions, config),
    };
  }
  return {
    ...source,
    shape: rewriteStaticProjections(
      source.shape,
      active,
      forwarding,
      inlineable,
      functions,
      config,
    ),
  };
}

function optimizeStatement(
  stmt: Statement,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
): Statement {
  if (stmt.kind === "let" || stmt.kind === "destructure_let") {
    const value = optimizeExpr(stmt.value, forwarding, inlineable, functions, config);
    const inlined = stmt.kind === "destructure_let" ||
        isFixedUpdateInlineCall(value, inlineable) ||
        isMultiValueInlineLetCall(value, inlineable, functions)
      ? inlineCallExpr(value, inlineable, { allowMultiValue: true })
      : undefined;
    return {
      ...stmt,
      value: inlined ? optimizeExpr(inlined, forwarding, inlineable, functions, config) : value,
    };
  }
  return stmt;
}

function isMultiValueInlineLetCall(
  expr: Expr,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
): boolean {
  if (expr.kind !== "call" || expr.callee.kind !== "var") return false;
  const fn = inlineable.get(expr.callee.name);
  return Boolean(
    fn &&
      !isScalarRuntimeReturn(fn.returnType) &&
      fn.body.statements.length === 0 &&
      fn.body.expr &&
      isSpeculablePureInlineValue(fn.body.expr, functions),
  );
}

function isFixedUpdateInlineCall(expr: Expr, inlineable: Map<string, FnDecl>): boolean {
  if (expr.kind !== "call" || expr.callee.kind !== "var") return false;
  const fn = inlineable.get(expr.callee.name);
  if (!fn?.body.expr) return false;
  return fn.body.expr.kind === "shape" &&
    fn.body.expr.slots.some((slot) => slot.spread) &&
    fn.body.expr.slots.some((slot) => slot.index);
}

function optimizeExpr(
  expr: Expr,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
  options: { allowMultiValueResult?: boolean } = {},
): Expr {
  switch (expr.kind) {
    case "do":
      return expr;
    case "const_fn":
      return { ...expr, body: optimizeExpr(expr.body, forwarding, inlineable, functions, config) };
    case "call": {
      const callee = optimizeExpr(expr.callee, forwarding, inlineable, functions, config);
      const args = expr.args.map((arg) =>
        optimizeExpr(arg, forwarding, inlineable, functions, config)
      );
      if (args.length === 0 && callee.kind !== "var") {
        return optimizeExpr(callee, forwarding, inlineable, functions, config, options);
      }
      const staticValue = optimizeStaticShapeCall(callee, args);
      if (staticValue) return staticValue;
      if (callee.kind === "var") {
        const target = forwarding.get(callee.name);
        if (target) return { ...expr, callee: { kind: "var", name: target }, args };
        const fixedUpdateShape = isFixedUpdateInlineCall({ ...expr, callee, args }, inlineable);
        const inlined = inlineCall(callee.name, args, inlineable, {
          allowMultiValue: (options.allowMultiValueResult ?? false) && !fixedUpdateShape,
        });
        if (inlined) {
          return optimizeExpr(inlined, forwarding, inlineable, functions, config, options);
        }
      }
      return { ...expr, callee, args };
    }
    case "index":
      return {
        ...expr,
        target: optimizeExpr(expr.target, forwarding, inlineable, functions, config),
        index: optimizeExpr(expr.index, forwarding, inlineable, functions, config),
      };
    case "binary":
      return optimizeBinary(
        {
          ...expr,
          left: optimizeExpr(expr.left, forwarding, inlineable, functions, config),
          right: optimizeExpr(expr.right, forwarding, inlineable, functions, config),
        },
        functions,
        config,
      );
    case "pipe_bind": {
      const value = optimizeExpr(expr.value, forwarding, inlineable, functions, config);
      if (expr.name === "$") {
        return optimizeExpr(
          substituteVar(expr.body, expr.name, value),
          forwarding,
          inlineable,
          functions,
          config,
        );
      }
      return {
        ...expr,
        value,
        body: optimizeExpr(expr.body, forwarding, inlineable, functions, config, {
          allowMultiValueResult: options.allowMultiValueResult,
        }),
      };
    }
    case "match": {
      const value = optimizeExpr(expr.value, forwarding, inlineable, functions, config);
      if (value.kind === "literal" && value.literalKind === "bool") {
        const selected = expr.arms.find((arm) =>
          arm.pattern.kind === "literal" && arm.pattern.value === value.value
        );
        if (selected) {
          return optimizeExpr(selected.value, forwarding, inlineable, functions, config);
        }
      }
      return {
        ...expr,
        value,
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: optimizeExpr(arm.value, forwarding, inlineable, functions, config, {
            allowMultiValueResult: options.allowMultiValueResult,
          }),
        })),
      };
    }
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index
            ? optimizeExpr(slot.index, forwarding, inlineable, functions, config)
            : undefined,
          value: optimizeExpr(slot.value, forwarding, inlineable, functions, config),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: optimizeExpr(slot.value, forwarding, inlineable, functions, config),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: optimizeStaticForSource(expr.source, forwarding, inlineable, functions, config),
        value: optimizeExpr(expr.value, forwarding, inlineable, functions, config),
      };
    case "range":
      return {
        ...expr,
        start: optimizeExpr(expr.start, forwarding, inlineable, functions, config),
        end: optimizeExpr(expr.end, forwarding, inlineable, functions, config),
      };
    case "field":
      return {
        ...expr,
        value: optimizeExpr(expr.value, forwarding, inlineable, functions, config),
        key: optimizeExpr(expr.key, forwarding, inlineable, functions, config),
      };
    case "block": {
      const block = optimizeBlock(expr, forwarding, inlineable, functions, {
        allowMultiValueResult: options.allowMultiValueResult,
        config,
      });
      return block.statements.length === 0 && block.expr ? block.expr : block;
    }
    case "literal":
    case "var":
    case "placeholder":
      return expr;
  }
}

function rewriteUnusedPrivateParams(program: Program, scope?: OptimizationScope) {
  const functions = functionMap(program, scope);
  const valueUses = functionValueUses(program, functions);
  const drops = new Map<string, Set<number>>();
  for (const fn of functions.values()) {
    if (
      isCurrentModulePublic(fn) || fn.generated || fn.primitiveId ||
      fn.params.some((param) => param.const) || valueUses.has(fn.name) ||
      exprCallsFunction(fn.body, fn.name)
    ) {
      continue;
    }
    const calls = directCallsTo(program, fn.name);
    if (!calls.length) continue;
    const used = blockUsedNames(fn.body);
    const indexes = new Set<number>();
    fn.params.forEach((param, index) => {
      if (used.has(param.name)) return;
      const allCallsCanDrop = calls.every((call) =>
        call.args.length === fn.params.length && call.args[index] &&
        !hasRuntimeEffect(call.args[index], functions)
      );
      if (allCallsCanDrop) indexes.add(index);
    });
    if (indexes.size) drops.set(fn.name, indexes);
  }
  if (!drops.size) return;
  program.declarations = program.declarations.map((decl) => {
    if (decl.kind !== "fn") return decl;
    const indexes = drops.get(decl.name);
    const params = indexes
      ? decl.params.filter((_param, index) => !indexes.has(index))
      : decl.params;
    return {
      ...decl,
      params,
      body: rewriteDroppedCallArgs(decl.body, drops),
    };
  });
}

function directCallsTo(program: Program, target: string): Extract<Expr, { kind: "call" }>[] {
  const calls: Extract<Expr, { kind: "call" }>[] = [];
  const visit = (item: Expr | BlockExpr | Statement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "call":
        if (item.callee.kind === "var" && item.callee.name === target) calls.push(item);
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
        visit(item.body);
        return;
      case "match":
        visit(item.value);
        item.arms.forEach((arm) => visit(arm.value));
        return;
      case "shape":
      case "product_constructor":
        item.slots.forEach((slot) => {
          visit(slot.index);
          visit(slot.value);
        });
        return;
      case "static_for_slots":
        visitStaticForSource(item.source);
        visit(item.value);
        return;
      case "field":
        visit(item.value);
        visit(item.key);
        return;
      case "range":
        visit(item.start);
        visit(item.end);
        return;
      case "block":
        item.statements.forEach(visit);
        visit(item.expr);
        return;
      case "let":
      case "destructure_let":
        visit(item.value);
        return;
      case "proof_const":
      case "literal":
      case "var":
      case "placeholder":
        return;
    }
  };
  const visitStaticForSource = (source: StaticForSource) => {
    if (source.kind === "range") {
      visit(source.start);
      visit(source.end);
    } else {
      visit(source.shape);
    }
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") visit(decl.body);
    if (decl.kind === "let" || decl.kind === "const") visit(decl.value);
  }
  return calls;
}

function functionValueUses(program: Program, functions: Map<string, FnDecl>): Set<string> {
  const used = new Set<string>();
  const visit = (item: Expr | BlockExpr | Statement | undefined, calleePosition = false) => {
    if (!item) return;
    switch (item.kind) {
      case "var":
        if (!calleePosition && functions.has(item.name)) used.add(item.name);
        return;
      case "call":
        visit(item.callee, true);
        item.args.forEach((arg) => visit(arg));
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
        item.arms.forEach((arm) => visit(arm.value));
        return;
      case "shape":
      case "product_constructor":
        item.slots.forEach((slot) => {
          visit(slot.index);
          visit(slot.value);
        });
        return;
      case "static_for_slots":
        visitStaticForSource(item.source);
        visit(item.value);
        return;
      case "field":
        visit(item.value);
        visit(item.key);
        return;
      case "range":
        visit(item.start);
        visit(item.end);
        return;
      case "block":
        item.statements.forEach((stmt) => visit(stmt));
        visit(item.expr);
        return;
      case "let":
      case "destructure_let":
        visit(item.value);
        return;
      case "proof_const":
      case "literal":
      case "placeholder":
        return;
    }
  };
  const visitStaticForSource = (source: StaticForSource) => {
    if (source.kind === "range") {
      visit(source.start);
      visit(source.end);
    } else {
      visit(source.shape);
    }
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") visit(decl.body);
    if (decl.kind === "let" || decl.kind === "const") visit(decl.value);
  }
  return used;
}

function rewriteDroppedCallArgs<T extends Expr | BlockExpr>(
  expr: T,
  drops: Map<string, Set<number>>,
): T {
  return rewriteExpr(expr, drops) as T;
}

function rewriteExpr(expr: Expr, drops: Map<string, Set<number>>): Expr {
  switch (expr.kind) {
    case "do":
      return expr;
    case "const_fn":
      return { ...expr, body: rewriteExpr(expr.body, drops) };
    case "call": {
      const callee = rewriteExpr(expr.callee, drops);
      const indexes = callee.kind === "var" ? drops.get(callee.name) : undefined;
      const args = expr.args
        .map((arg) => rewriteExpr(arg, drops))
        .filter((_arg, index) => !indexes?.has(index));
      return { ...expr, callee, args };
    }
    case "index":
      return {
        ...expr,
        target: rewriteExpr(expr.target, drops),
        index: rewriteExpr(expr.index, drops),
      };
    case "binary":
      return {
        ...expr,
        left: rewriteExpr(expr.left, drops),
        right: rewriteExpr(expr.right, drops),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: rewriteExpr(expr.value, drops),
        body: rewriteExpr(expr.body, drops),
      };
    case "match":
      return {
        ...expr,
        value: rewriteExpr(expr.value, drops),
        arms: expr.arms.map((arm) => ({ ...arm, value: rewriteExpr(arm.value, drops) })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index ? rewriteExpr(slot.index, drops) : undefined,
          value: rewriteExpr(slot.value, drops),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: rewriteStaticForSource(expr.source, drops),
        value: rewriteExpr(expr.value, drops),
      };
    case "range":
      return { ...expr, start: rewriteExpr(expr.start, drops), end: rewriteExpr(expr.end, drops) };
    case "field":
      return { ...expr, value: rewriteExpr(expr.value, drops), key: rewriteExpr(expr.key, drops) };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "proof_const" ? stmt : { ...stmt, value: rewriteExpr(stmt.value, drops) }
        ),
        expr: expr.expr ? rewriteExpr(expr.expr, drops) : undefined,
      };
    case "literal":
    case "var":
    case "placeholder":
      return expr;
  }
}

function rewriteStaticForSource(
  source: StaticForSource,
  drops: Map<string, Set<number>>,
): StaticForSource {
  return source.kind === "range"
    ? { ...source, start: rewriteExpr(source.start, drops), end: rewriteExpr(source.end, drops) }
    : { ...source, shape: rewriteExpr(source.shape, drops) };
}

function optimizeStaticShapeCall(callee: Expr, args: Expr[]): Expr | undefined {
  if (callee.kind !== "var" || callee.name !== "@shape_has_slot") return undefined;
  const slotsArg = args[0];
  const keyArg = args[1];
  if (
    slotsArg?.kind !== "call" || slotsArg.callee.kind !== "var" ||
    slotsArg.callee.name !== "@type_slots" || keyArg?.kind !== "literal" ||
    keyArg.literalKind !== "literalType"
  ) return undefined;
  const typeArg = slotsArg.args[0];
  if (typeArg?.kind !== "var") return undefined;
  const labels = inlineStructLabels(typeArg.name);
  if (!labels) return undefined;
  return { kind: "literal", literalKind: "bool", value: String(labels.has(keyArg.value.slice(1))) };
}

function optimizeBinary(
  expr: Extract<Expr, { kind: "binary" }>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
): Expr {
  const literal = foldIntegerLiteralBinary(expr);
  if (literal) return literal;
  if (isNumberLiteral(expr.right, 0) && (expr.op === "+" || expr.op === "-")) return expr.left;
  if (isNumberLiteral(expr.left, 0) && expr.op === "+") return expr.right;
  const combinedAdd = combineRepeatedAdd(expr, functions);
  if (combinedAdd) return combinedAdd;
  if (
    expr.op === "-" && samePureExpr(expr.left, expr.right, functions)
  ) {
    return { kind: "literal", literalKind: "number", value: "0" };
  }
  if (expr.op === "-" && expr.left.kind === "binary" && expr.left.op === "+") {
    if (samePureExpr(expr.left.left, expr.right, functions)) return expr.left.right;
    if (samePureExpr(expr.left.right, expr.right, functions)) return expr.left.left;
  }
  if (isNumberLiteral(expr.right, 1) && expr.op === "*") return expr.left;
  if (isNumberLiteral(expr.left, 1) && expr.op === "*") return expr.right;
  if (isNumberLiteral(expr.right, 1) && expr.op === "/") return expr.left;
  if (
    expr.op === "*" && isNumberLiteral(expr.right, 0) && !hasRuntimeEffect(expr.left, functions)
  ) {
    return expr.right;
  }
  if (
    expr.op === "*" && isNumberLiteral(expr.left, 0) && !hasRuntimeEffect(expr.right, functions)
  ) {
    return expr.left;
  }
  if (expr.op === "==" && isBoolLiteral(expr.right, true)) return expr.left;
  if (expr.op === "==" && isBoolLiteral(expr.left, true)) return expr.right;
  return extractLocalEqualityExpr(expr, functions, config);
}

function extractLocalEqualityExpr(
  expr: Expr,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
): Expr {
  if (!localEqualityEligible(expr, functions)) return expr;
  const seen = new Map<string, Expr>();
  const queue: Expr[] = [expr];
  while (queue.length && seen.size < config.profile.abstract.maxLocalEqualityCandidates) {
    const current = queue.shift()!;
    const key = stableExprKey(current);
    if (seen.has(key)) continue;
    seen.set(key, current);
    for (const next of localEqualityRewrites(current, functions)) {
      if (!seen.has(stableExprKey(next))) queue.push(next);
      if (seen.size + queue.length >= config.profile.abstract.maxLocalEqualityCandidates) break;
    }
  }
  return [...seen.values()].toSorted(compareLocalEqualityCandidates)[0] ?? expr;
}

function localEqualityEligible(expr: Expr, functions: Map<string, FnDecl>): boolean {
  return !hasRuntimeEffect(expr, functions) && localEqualityNodeCount(expr) <= 12;
}

function localEqualityNodeCount(expr: Expr): number {
  switch (expr.kind) {
    case "binary":
      return 1 + localEqualityNodeCount(expr.left) + localEqualityNodeCount(expr.right);
    case "literal":
    case "var":
      return 1;
    default:
      return 100;
  }
}

function compareLocalEqualityCandidates(left: Expr, right: Expr): number {
  return exprCost(left) - exprCost(right) ||
    stableExprKey(left).localeCompare(stableExprKey(right));
}

function localEqualityRewrites(expr: Expr, functions: Map<string, FnDecl>): Expr[] {
  if (expr.kind !== "binary") return [];
  const rewrites: Expr[] = [];
  const affine = affinePureTerm(expr, functions);
  if (affine) {
    const candidate = buildAffineTerm(affine.term, affine.scale, affine.offset);
    if (candidate) rewrites.push(candidate);
  }
  if (samePureExpr(expr.left, expr.right, functions)) {
    if (expr.op === "==") rewrites.push(boolLiteral(true));
    if (expr.op === "!=" || expr.op === "<" || expr.op === ">") rewrites.push(boolLiteral(false));
    if (expr.op === "<=" || expr.op === ">=") rewrites.push(boolLiteral(true));
    if (expr.op === "+") {
      rewrites.push({
        kind: "binary",
        op: "*",
        left: expr.left,
        right: { kind: "literal", literalKind: "number", value: "2" },
      });
    }
  }
  if (isCommutativeOp(expr.op) && stableExprKey(expr.right) < stableExprKey(expr.left)) {
    rewrites.push({ ...expr, left: expr.right, right: expr.left });
  }
  if (
    (expr.op === "+" || expr.op === "*") && expr.left.kind === "binary" && expr.left.op === expr.op
  ) {
    rewrites.push({
      ...expr,
      left: expr.left.left,
      right: { kind: "binary", op: expr.op, left: expr.left.right, right: expr.right },
    });
  }
  if (
    (expr.op === "+" || expr.op === "*") && expr.right.kind === "binary" &&
    expr.right.op === expr.op
  ) {
    rewrites.push({
      ...expr,
      left: { kind: "binary", op: expr.op, left: expr.left, right: expr.right.left },
      right: expr.right.right,
    });
  }
  const factored = factorCommonProduct(expr, functions);
  if (factored) rewrites.push(factored);
  return rewrites.filter((candidate) => localEqualityEligible(candidate, functions));
}

function isCommutativeOp(op: string): boolean {
  return op === "+" || op === "*" || op === "==" || op === "!=";
}

function factorCommonProduct(
  expr: Extract<Expr, { kind: "binary" }>,
  functions: Map<string, FnDecl>,
): Expr | undefined {
  if (expr.op !== "+") return undefined;
  const left = productFactors(expr.left);
  const right = productFactors(expr.right);
  if (!left || !right) return undefined;
  const candidates: [Expr, Expr, Expr][] = [
    [left.left, left.right, right.left],
    [left.left, left.right, right.right],
    [left.right, left.left, right.left],
    [left.right, left.left, right.right],
  ];
  for (const [common, leftRest, rightFactor] of candidates) {
    if (!samePureExpr(common, rightFactor, functions)) continue;
    const rightRest = samePureExpr(rightFactor, right.left, functions) ? right.right : right.left;
    if (
      hasRuntimeEffect(common, functions) || hasRuntimeEffect(leftRest, functions) ||
      hasRuntimeEffect(rightRest, functions)
    ) return undefined;
    return {
      kind: "binary",
      op: "*",
      left: common,
      right: { kind: "binary", op: "+", left: leftRest, right: rightRest },
    };
  }
  return undefined;
}

function productFactors(expr: Expr): { left: Expr; right: Expr } | undefined {
  return expr.kind === "binary" && expr.op === "*"
    ? { left: expr.left, right: expr.right }
    : undefined;
}

function combineRepeatedAdd(
  expr: Extract<Expr, { kind: "binary" }>,
  functions: Map<string, FnDecl>,
): Expr | undefined {
  if (expr.op !== "+") return undefined;
  const leftLiteral = staticIntegerLiteral(expr.left);
  const rightLiteral = staticIntegerLiteral(expr.right);
  const left = affinePureTerm(expr.left, functions);
  const right = affinePureTerm(expr.right, functions);
  if (left && rightLiteral !== undefined) {
    return buildAffineTerm(left.term, left.scale, left.offset + rightLiteral);
  }
  if (right && leftLiteral !== undefined) {
    return buildAffineTerm(right.term, right.scale, right.offset + leftLiteral);
  }
  if (!left || !right || left.key !== right.key) return undefined;
  return buildAffineTerm(left.term, left.scale + right.scale, left.offset + right.offset);
}

function affinePureTerm(
  expr: Expr,
  functions: Map<string, FnDecl>,
): { key: string; term: Expr; scale: number; offset: number } | undefined {
  if (!hasRuntimeEffect(expr, functions) && expr.kind === "binary" && expr.op === "+") {
    const right = staticIntegerLiteral(expr.right);
    const left = affinePureTerm(expr.left, functions);
    if (left && right !== undefined) return { ...left, offset: left.offset + right };
    const leftLiteral = staticIntegerLiteral(expr.left);
    const rightTerm = affinePureTerm(expr.right, functions);
    if (rightTerm && leftLiteral !== undefined) {
      return { ...rightTerm, offset: rightTerm.offset + leftLiteral };
    }
  }
  if (!hasRuntimeEffect(expr, functions) && expr.kind === "binary" && expr.op === "-") {
    const right = staticIntegerLiteral(expr.right);
    const left = affinePureTerm(expr.left, functions);
    if (left && right !== undefined) return { ...left, offset: left.offset - right };
    const leftLiteral = staticIntegerLiteral(expr.left);
    const rightTerm = affinePureTerm(expr.right, functions);
    if (rightTerm && leftLiteral !== undefined) {
      return {
        key: rightTerm.key,
        term: rightTerm.term,
        scale: -rightTerm.scale,
        offset: leftLiteral - rightTerm.offset,
      };
    }
  }
  const scaled = scaledPureTerm(expr, functions);
  return scaled ? { ...scaled, offset: 0 } : undefined;
}

function buildAffineTerm(term: Expr, scale: number, offset: number): Expr | undefined {
  if (
    scale < -0x8000_0000 || scale > 0x7fff_ffff ||
    offset < -0x8000_0000 || offset > 0x7fff_ffff
  ) {
    return undefined;
  }
  const scaled: Expr = scale === 0
    ? { kind: "literal", literalKind: "number", value: "0" }
    : scale === 1
    ? term
    : {
      kind: "binary",
      op: "*",
      left: term,
      right: { kind: "literal", literalKind: "number", value: String(scale) },
    };
  if (offset === 0) return scaled;
  return {
    kind: "binary",
    op: "+",
    left: scaled,
    right: { kind: "literal", literalKind: "number", value: String(offset) },
  };
}

function scaledPureTerm(
  expr: Expr,
  functions: Map<string, FnDecl>,
): { key: string; term: Expr; scale: number } | undefined {
  if (!hasRuntimeEffect(expr, functions) && expr.kind === "binary" && expr.op === "*") {
    const right = staticIntegerLiteral(expr.right);
    if (right !== undefined && !hasRuntimeEffect(expr.left, functions)) {
      return { key: stableExprKey(expr.left), term: expr.left, scale: right };
    }
    const left = staticIntegerLiteral(expr.left);
    if (left !== undefined && !hasRuntimeEffect(expr.right, functions)) {
      return { key: stableExprKey(expr.right), term: expr.right, scale: left };
    }
  }
  if (hasRuntimeEffect(expr, functions)) return undefined;
  return { key: stableExprKey(expr), term: expr, scale: 1 };
}

function foldIntegerLiteralBinary(expr: Extract<Expr, { kind: "binary" }>): Expr | undefined {
  const left = staticIntegerLiteral(expr.left);
  const right = staticIntegerLiteral(expr.right);
  if (left === undefined || right === undefined) return undefined;
  switch (expr.op) {
    case "+":
      return numberLiteralIfI32(left + right);
    case "-":
      return numberLiteralIfI32(left - right);
    case "*":
      return numberLiteralIfI32(left * right);
    case "/":
      if (right === 0 || (left === -0x8000_0000 && right === -1)) return undefined;
      return numberLiteralIfI32(Math.trunc(left / right));
    case "%":
      if (right === 0 || (left === -0x8000_0000 && right === -1)) return undefined;
      return numberLiteralIfI32(left % right);
    case "==":
      return boolLiteral(left === right);
    case "!=":
      return boolLiteral(left !== right);
    case "<":
      return boolLiteral(left < right);
    case "<=":
      return boolLiteral(left <= right);
    case ">":
      return boolLiteral(left > right);
    case ">=":
      return boolLiteral(left >= right);
    default:
      return undefined;
  }
}

function numberLiteralIfI32(value: number): Expr | undefined {
  return Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff
    ? { kind: "literal", literalKind: "number", value: String(value) }
    : undefined;
}

function boolLiteral(value: boolean): Expr {
  return { kind: "literal", literalKind: "bool", value: String(value) };
}

function isNumberLiteral(expr: Expr, value: number): boolean {
  return expr.kind === "literal" && expr.literalKind === "number" &&
    Number.parseInt(expr.value, 10) === value;
}

function isIntegerLiteral(expr: Expr): expr is Extract<Expr, { kind: "literal" }> {
  return expr.kind === "literal" && expr.literalKind === "number" && /^-?[0-9]+$/.test(expr.value);
}

function staticIntegerLiteral(expr: Expr): number | undefined {
  if (!isIntegerLiteral(expr)) return undefined;
  return Number.parseInt(expr.value, 10);
}

function literalFieldLabel(expr: Expr): string | undefined {
  if (expr.kind !== "literal") return undefined;
  if (expr.literalKind !== "literalType" && expr.literalKind !== "string") return undefined;
  return expr.value.replace(/^#/, "").replace(/^"|"$/g, "");
}

function isBoolLiteral(expr: Expr, value: boolean): boolean {
  return expr.kind === "literal" && expr.literalKind === "bool" && expr.value === String(value);
}

function samePureExpr(left: Expr, right: Expr, functions: Map<string, FnDecl>): boolean {
  return !hasRuntimeEffect(left, functions) && !hasRuntimeEffect(right, functions) &&
    stableExprKey(left) === stableExprKey(right);
}

function stableExprKey(expr: Expr): string {
  switch (expr.kind) {
    case "do":
      return `do:${expr.strategy.name}`;
    case "const_fn":
      return `const_fn:${expr.params.join(",")}=>${stableExprKey(expr.body)}`;
    case "literal":
      return `literal:${expr.literalKind}:${expr.value}`;
    case "var":
      return `var:${expr.name}`;
    case "placeholder":
      return "placeholder";
    case "binary":
      return `binary:${expr.op}:${stableExprKey(expr.left)}:${stableExprKey(expr.right)}`;
    case "index":
      return `index:${stableExprKey(expr.target)}:${stableExprKey(expr.index)}`;
    case "field":
      return `field:${stableExprKey(expr.value)}:${stableExprKey(expr.key)}`;
    case "range":
      return `range:${stableExprKey(expr.start)}:${stableExprKey(expr.end)}`;
    case "call":
      return `call:${stableExprKey(expr.callee)}(${expr.args.map(stableExprKey).join(",")})`;
    case "pipe_bind":
      return `pipe:${stableExprKey(expr.value)}:${expr.name}:${stableExprKey(expr.body)}`;
    case "shape":
    case "product_constructor":
      return `${expr.kind}:${
        expr.slots.map((slot) =>
          `${slot.label ?? ""}[${slot.index ? stableExprKey(slot.index) : ""}]=${
            stableExprKey(slot.value)
          }`
        ).join(",")
      }`;
    case "match":
      return `match:${stableExprKey(expr.value)}:${
        expr.arms.map((arm) => `${JSON.stringify(arm.pattern)}=>${stableExprKey(arm.value)}`).join(
          ",",
        )
      }`;
    case "static_for_slots":
      return `static_for:${JSON.stringify(expr.source)}:${stableExprKey(expr.value)}`;
    case "block":
      return `block:${
        expr.statements.map((stmt) =>
          stmt.kind === "proof_const" ? "proof" : `${stmt.kind}:${stableExprKey(stmt.value)}`
        ).join(";")
      }:${expr.expr ? stableExprKey(expr.expr) : ""}`;
  }
}

function inlineStructLabels(type: string): Set<string> | undefined {
  const trimmed = type.trim();
  if (!trimmed.startsWith("struct({") || !trimmed.endsWith("})")) return undefined;
  const inner = trimmed.slice("struct({".length, -2).trim();
  if (!inner) return new Set();
  const labels = new Set<string>();
  for (const part of splitTopLevel(inner)) {
    const colon = part.indexOf(":");
    if (colon > 0) labels.add(part.slice(0, colon).trim());
  }
  return labels;
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const ch = source[index];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function inlineableFunctions(
  functions: Map<string, FnDecl>,
  plan: OptimizationPlan,
): Map<string, FnDecl> {
  const result = new Map<string, FnDecl>();
  for (const fnPlan of plan.functions.values()) {
    if (!fnPlan.actions.some((action) => action.kind === "inline")) continue;
    const fn = functions.get(fnPlan.name);
    if (fn) result.set(fn.name, fn);
  }
  return result;
}

function isScalarRuntimeReturn(type: string | undefined): boolean {
  return type === "i32" || type === "bool" || type === "char" || type === "count" ||
    type === "i64" || type === "f32" || type === "f64" ||
    unsignedBitWidth(type) !== undefined;
}

function unsignedBitWidth(type: string | undefined): number | undefined {
  const match = type?.match(/^u([1-9][0-9]*)$/);
  if (!match) return undefined;
  const width = Number.parseInt(match[1] ?? "", 10);
  return width >= 1 && width <= 64 ? width : undefined;
}

function inlineBudgetForProfile(
  fn: FnDecl,
  summary: FunctionSummary,
  profile: OptimizeProfile,
): number {
  if (summary.returnClass !== "scalar") return profile.inline.productBudget;
  return fn.generatedInlineable
    ? profile.inline.scalarBudget * profile.inline.generatedMultiplier
    : profile.inline.scalarBudget;
}

function functionCost(fn: FnDecl): number {
  return fn.body.statements.reduce((sum, stmt) => sum + statementCost(stmt), 0) +
    (fn.body.expr ? exprCost(fn.body.expr) : 0);
}

function statementCost(stmt: Statement): number {
  switch (stmt.kind) {
    case "let":
    case "destructure_let":
      return 1 + exprCost(stmt.value);
    case "proof_const":
      return 0;
  }
}

function exprCost(expr: Expr): number {
  switch (expr.kind) {
    case "do":
      return 100;
    case "const_fn":
      return 1 + exprCost(expr.body);
    case "call":
      return 2 + exprCost(expr.callee) + expr.args.reduce((sum, arg) => sum + exprCost(arg), 0);
    case "index":
      return 2 + exprCost(expr.target) + exprCost(expr.index);
    case "binary":
      return 1 + exprCost(expr.left) + exprCost(expr.right);
    case "pipe_bind":
      return 1 + exprCost(expr.value) + exprCost(expr.body);
    case "match":
      return 2 + exprCost(expr.value) +
        expr.arms.reduce((sum, arm) => sum + exprCost(arm.value), 0);
    case "shape":
    case "product_constructor":
      return 1 +
        expr.slots.reduce(
          (sum, slot) => sum + (slot.index ? exprCost(slot.index) : 0) + exprCost(slot.value),
          0,
        );
    case "static_for_slots":
      return 4 + exprCost(expr.value) + staticForSourceCost(expr.source);
    case "range":
      return 1 + exprCost(expr.start) + exprCost(expr.end);
    case "field":
      return 1 + exprCost(expr.value) + exprCost(expr.key);
    case "block":
      return expr.statements.reduce((sum, stmt) => sum + statementCost(stmt), 0) +
        (expr.expr ? exprCost(expr.expr) : 0);
    case "literal":
    case "var":
    case "placeholder":
      return 1;
  }
}

function staticForSourceCost(source: StaticForSource): number {
  return source.kind === "range"
    ? exprCost(source.start) + exprCost(source.end)
    : exprCost(source.shape);
}

function exprCallsFunction(expr: Expr | BlockExpr | undefined, name: string): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "do":
      return expr.expr ? exprCallsFunction(expr.expr, name) : false;
    case "const_fn":
      return exprCallsFunction(expr.body, name);
    case "call":
      return (expr.callee.kind === "var" && expr.callee.name === name) ||
        exprCallsFunction(expr.callee, name) ||
        expr.args.some((arg) => exprCallsFunction(arg, name));
    case "index":
      return exprCallsFunction(expr.target, name) || exprCallsFunction(expr.index, name);
    case "binary":
      return exprCallsFunction(expr.left, name) || exprCallsFunction(expr.right, name);
    case "pipe_bind":
      return exprCallsFunction(expr.value, name) || exprCallsFunction(expr.body, name);
    case "match":
      return exprCallsFunction(expr.value, name) ||
        expr.arms.some((arm) => exprCallsFunction(arm.value, name));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) =>
        (slot.index ? exprCallsFunction(slot.index, name) : false) ||
        exprCallsFunction(slot.value, name)
      );
    case "static_for_slots":
      return exprCallsFunction(expr.value, name) ||
        (expr.source.kind === "range"
          ? exprCallsFunction(expr.source.start, name) || exprCallsFunction(expr.source.end, name)
          : exprCallsFunction(expr.source.shape, name));
    case "field":
      return exprCallsFunction(expr.value, name) || exprCallsFunction(expr.key, name);
    case "range":
      return exprCallsFunction(expr.start, name) || exprCallsFunction(expr.end, name);
    case "block":
      return expr.statements.some((stmt) =>
        (stmt.kind === "let" || stmt.kind === "destructure_let") &&
        exprCallsFunction(stmt.value, name)
      ) || exprCallsFunction(expr.expr, name);
    case "literal":
    case "var":
    case "placeholder":
      return false;
  }
}

function recurrenceBaseName(name: string): string {
  if (/(?:^|[._])(?:Iter|CompactIter)[._]/.test(name)) {
    return name.replace(/__clause_[0-9]+(?=__|$)/, "");
  }
  return name.replace(/__clause_[0-9]+$/, "");
}

function recurrenceDomainMeasure(
  params: FnDecl["params"],
  clauses: RecurrenceClause[],
  calls: RecursiveCall[],
): DomainMeasure | undefined {
  for (const [index, param] of params.entries()) {
    const cardinalities = clauses
      .map((clause) => clause.paramDomains[index])
      .filter((domain): domain is RefinedI32Domain => Boolean(domain))
      .map(domainCardinality)
      .filter((cardinality): cardinality is number => cardinality !== undefined);
    if (!cardinalities.length) continue;
    const proof = proveDomainMeasure(param.name, index, clauses, calls);
    return {
      kind: "domain",
      param: param.name,
      cardinality: cardinalities.reduce((sum, value) => sum + value, 0),
      ...proof,
    };
  }
  return undefined;
}

function domainCardinality(domain: RefinedI32Domain): number | undefined {
  let total = 0;
  for (const interval of domain.intervals) {
    if (interval.start.kind !== "literal" || interval.end.kind !== "literal") {
      return undefined;
    }
    total += Math.max(0, interval.end.value - interval.start.value);
  }
  return total;
}

function proveDomainMeasure(
  param: string,
  paramIndex: number,
  clauses: RecurrenceClause[],
  calls: RecursiveCall[],
): Pick<DomainMeasure, "direction" | "terminates"> {
  const allIntervals = normalizeLiteralIntervals(
    clauses.flatMap((clause) => literalIntervals(clause.paramDomains[paramIndex])),
  );
  if (!allIntervals.length) return { terminates: false };

  const recursiveClauseNames = new Set(calls.map((call) => call.clause));
  const recursiveIntervals = normalizeLiteralIntervals(
    clauses
      .filter((clause) => recursiveClauseNames.has(clause.fn))
      .flatMap((clause) => literalIntervals(clause.paramDomains[paramIndex])),
  );
  const baseIntervals = normalizeLiteralIntervals(
    clauses
      .filter((clause) => !recursiveClauseNames.has(clause.fn))
      .flatMap((clause) => literalIntervals(clause.paramDomains[paramIndex])),
  );
  if (!recursiveIntervals.length || !baseIntervals.length) return { terminates: false };

  const clausesByName = new Map(clauses.map((clause) => [clause.fn, clause]));
  const directions = new Set<"increasing" | "decreasing">();
  for (const call of calls) {
    const clause = clausesByName.get(call.clause);
    const sourceIntervals = literalIntervals(clause?.paramDomains[paramIndex]);
    const delta = affineDelta(call.args[paramIndex], param);
    if (!sourceIntervals.length || delta === undefined || delta === 0) {
      return { terminates: false };
    }
    directions.add(delta > 0 ? "increasing" : "decreasing");
    const targetIntervals = normalizeLiteralIntervals(
      sourceIntervals.map((interval) => ({
        start: interval.start + delta,
        end: interval.end + delta,
      })),
    );
    if (!literalIntervalsContain(allIntervals, targetIntervals)) {
      return { terminates: false };
    }
  }
  if (directions.size !== 1) return { terminates: false };

  const direction = [...directions][0]!;
  const recursiveRange = intervalRange(recursiveIntervals);
  const allRange = intervalRange(allIntervals);
  const exitsRecursiveDomain = direction === "increasing"
    ? recursiveRange.max < allRange.max
    : recursiveRange.min > allRange.min;
  return { direction, terminates: exitsRecursiveDomain };
}

interface LiteralInterval {
  start: number;
  end: number;
}

function literalIntervals(domain: RefinedI32Domain | undefined): LiteralInterval[] {
  if (!domain) return [];
  const intervals: LiteralInterval[] = [];
  for (const interval of domain.intervals) {
    if (interval.start.kind !== "literal" || interval.end.kind !== "literal") return [];
    intervals.push({ start: interval.start.value, end: interval.end.value });
  }
  return intervals;
}

function normalizeLiteralIntervals(intervals: LiteralInterval[]): LiteralInterval[] {
  const sorted = intervals
    .filter((interval) => interval.start < interval.end)
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  const result: LiteralInterval[] = [];
  for (const interval of sorted) {
    const previous = result.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      result.push({ ...interval });
    }
  }
  return result;
}

function literalIntervalsContain(
  expected: LiteralInterval[],
  actual: LiteralInterval[],
): boolean {
  return actual.every((actualInterval) =>
    expected.some((expectedInterval) =>
      expectedInterval.start <= actualInterval.start && actualInterval.end <= expectedInterval.end
    )
  );
}

function intervalRange(intervals: LiteralInterval[]): { min: number; max: number } {
  return {
    min: Math.min(...intervals.map((interval) => interval.start)),
    max: Math.max(...intervals.map((interval) => interval.end - 1)),
  };
}

function affineDelta(expr: Expr | undefined, param: string): number | undefined {
  if (!expr) return undefined;
  if (expr.kind === "var" && expr.name === param) return 0;
  if (expr.kind !== "binary") return undefined;
  const leftLiteral = numericLiteralValue(expr.left);
  const rightLiteral = numericLiteralValue(expr.right);
  if (expr.op === "+") {
    if (expr.left.kind === "var" && expr.left.name === param && rightLiteral !== undefined) {
      return rightLiteral;
    }
    if (expr.right.kind === "var" && expr.right.name === param && leftLiteral !== undefined) {
      return leftLiteral;
    }
  }
  if (
    expr.op === "-" && expr.left.kind === "var" && expr.left.name === param &&
    rightLiteral !== undefined
  ) {
    return -rightLiteral;
  }
  return undefined;
}

function numericLiteralValue(expr: Expr): number | undefined {
  if (expr.kind !== "literal" || expr.literalKind !== "number") return undefined;
  const value = Number(expr.value);
  return Number.isSafeInteger(value) ? value : undefined;
}

function classifyRecurrence(
  calls: RecursiveCall[],
  clauses: RecurrenceClause[],
  measure: DomainMeasure | undefined,
): RecurrenceKind {
  const allTail = calls.every((call) => call.tail);
  if (measure?.terminates) return "finite_static";
  if (allTail) return "tail_linear";
  if (
    clauses.some((clause) => clause.body.expr?.kind === "match") &&
    calls.every((call) => !call.args.some((arg) => arg.kind === "binary"))
  ) {
    return "structural";
  }
  return "general_recursive";
}

function recursiveCallDetails(
  expr: Expr | BlockExpr | undefined,
  targets: Set<string>,
  clause: string,
  tailPosition: boolean,
): RecursiveCall[] {
  if (!expr) return [];
  const visitStatement = (stmt: Statement): RecursiveCall[] =>
    stmt.kind === "let" || stmt.kind === "destructure_let"
      ? recursiveCallDetails(stmt.value, targets, clause, false)
      : [];
  switch (expr.kind) {
    case "call": {
      const calleeName = expr.callee.kind === "var" ? expr.callee.name : undefined;
      const calls = targets.has(calleeName ?? "")
        ? [{ clause, target: calleeName!, tail: tailPosition, args: expr.args }]
        : recursiveCallDetails(expr.callee, targets, clause, false);
      return [
        ...calls,
        ...expr.args.flatMap((arg) => recursiveCallDetails(arg, targets, clause, false)),
      ];
    }
    case "match":
      return [
        ...recursiveCallDetails(expr.value, targets, clause, false),
        ...expr.arms.flatMap((arm) =>
          recursiveCallDetails(arm.value, targets, clause, tailPosition)
        ),
      ];
    case "block":
      return [
        ...expr.statements.flatMap(visitStatement),
        ...recursiveCallDetails(expr.expr, targets, clause, tailPosition),
      ];
    case "pipe_bind":
      return [
        ...recursiveCallDetails(expr.value, targets, clause, false),
        ...recursiveCallDetails(expr.body, targets, clause, tailPosition),
      ];
    case "do":
      return [
        ...expr.statements.flatMap((stmt) =>
          stmt.kind === "proof_const"
            ? []
            : recursiveCallDetails(stmt.value, targets, clause, false)
        ),
        ...recursiveCallDetails(expr.expr, targets, clause, tailPosition),
      ];
    case "const_fn":
      return recursiveCallDetails(expr.body, targets, clause, false);
    case "index":
      return [
        ...recursiveCallDetails(expr.target, targets, clause, false),
        ...recursiveCallDetails(expr.index, targets, clause, false),
      ];
    case "binary":
      return [
        ...recursiveCallDetails(expr.left, targets, clause, false),
        ...recursiveCallDetails(expr.right, targets, clause, false),
      ];
    case "shape":
    case "product_constructor":
      return expr.slots.flatMap((slot) => [
        ...(slot.index ? recursiveCallDetails(slot.index, targets, clause, false) : []),
        ...recursiveCallDetails(slot.value, targets, clause, false),
      ]);
    case "static_for_slots":
      return [
        ...(expr.source.kind === "range"
          ? [
            ...recursiveCallDetails(expr.source.start, targets, clause, false),
            ...recursiveCallDetails(expr.source.end, targets, clause, false),
          ]
          : recursiveCallDetails(expr.source.shape, targets, clause, false)),
        ...recursiveCallDetails(expr.value, targets, clause, false),
      ];
    case "field":
      return [
        ...recursiveCallDetails(expr.value, targets, clause, false),
        ...recursiveCallDetails(expr.key, targets, clause, false),
      ];
    case "range":
      return [
        ...recursiveCallDetails(expr.start, targets, clause, false),
        ...recursiveCallDetails(expr.end, targets, clause, false),
      ];
    case "literal":
    case "placeholder":
    case "var":
      return [];
  }
}

function directSelfRecursiveKind(fn: FnDecl): FunctionSummary["recursiveKind"] {
  const calls = directSelfCalls(fn.body, fn.name, true);
  if (calls.nonTail) return "self_non_tail";
  return calls.tail ? "self_tail" : "none";
}

function directSelfCalls(
  expr: Expr | BlockExpr | undefined,
  name: string,
  tailPosition: boolean,
): { tail: boolean; nonTail: boolean } {
  const result = { tail: false, nonTail: false };
  const add = (calls: { tail: boolean; nonTail: boolean }) => {
    result.tail ||= calls.tail;
    result.nonTail ||= calls.nonTail;
  };
  if (!expr) return result;
  switch (expr.kind) {
    case "call":
      if (expr.callee.kind === "var" && expr.callee.name === name) {
        if (tailPosition) result.tail = true;
        else result.nonTail = true;
      } else {
        add(directSelfCalls(expr.callee, name, false));
      }
      expr.args.forEach((arg) => add(directSelfCalls(arg, name, false)));
      return result;
    case "match":
      add(directSelfCalls(expr.value, name, false));
      expr.arms.forEach((arm) => add(directSelfCalls(arm.value, name, tailPosition)));
      return result;
    case "block":
      expr.statements.forEach((stmt) => {
        if (stmt.kind === "let" || stmt.kind === "destructure_let") {
          add(directSelfCalls(stmt.value, name, false));
        }
      });
      add(directSelfCalls(expr.expr, name, tailPosition));
      return result;
    case "pipe_bind":
      add(directSelfCalls(expr.value, name, false));
      add(directSelfCalls(expr.body, name, tailPosition));
      return result;
    case "do":
      expr.statements.forEach((stmt) => {
        if (
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
          stmt.kind === "destructure_let"
        ) {
          add(directSelfCalls(stmt.value, name, false));
        }
      });
      add(directSelfCalls(expr.expr, name, tailPosition));
      return result;
    case "const_fn":
      add(directSelfCalls(expr.body, name, false));
      return result;
    case "index":
      add(directSelfCalls(expr.target, name, false));
      add(directSelfCalls(expr.index, name, false));
      return result;
    case "binary":
      add(directSelfCalls(expr.left, name, false));
      add(directSelfCalls(expr.right, name, false));
      return result;
    case "shape":
    case "product_constructor":
      expr.slots.forEach((slot) => {
        if (slot.index) add(directSelfCalls(slot.index, name, false));
        add(directSelfCalls(slot.value, name, false));
      });
      return result;
    case "static_for_slots":
      if (expr.source.kind === "range") {
        add(directSelfCalls(expr.source.start, name, false));
        add(directSelfCalls(expr.source.end, name, false));
      } else {
        add(directSelfCalls(expr.source.shape, name, false));
      }
      add(directSelfCalls(expr.value, name, false));
      return result;
    case "field":
      add(directSelfCalls(expr.value, name, false));
      add(directSelfCalls(expr.key, name, false));
      return result;
    case "range":
      add(directSelfCalls(expr.start, name, false));
      add(directSelfCalls(expr.end, name, false));
      return result;
    case "literal":
    case "var":
    case "placeholder":
      return result;
  }
}

function calledFunctionList(expr: Expr | BlockExpr | undefined): string[] {
  const names: string[] = [];
  const visit = (item: Expr | BlockExpr | Statement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "call":
        if (item.callee.kind === "var") names.push(item.callee.name);
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
        visit(item.body);
        return;
      case "match":
        visit(item.value);
        item.arms.forEach((arm) => visit(arm.value));
        return;
      case "shape":
      case "product_constructor":
        item.slots.forEach((slot) => {
          visit(slot.index);
          visit(slot.value);
        });
        return;
      case "static_for_slots":
        visitStaticForSource(item.source);
        visit(item.value);
        return;
      case "field":
        visit(item.value);
        visit(item.key);
        return;
      case "range":
        visit(item.start);
        visit(item.end);
        return;
      case "block":
        item.statements.forEach(visit);
        visit(item.expr);
        return;
      case "let":
      case "destructure_let":
        visit(item.value);
        return;
      case "proof_const":
      case "literal":
      case "var":
      case "placeholder":
        return;
    }
  };
  const visitStaticForSource = (source: StaticForSource) => {
    if (source.kind === "range") {
      visit(source.start);
      visit(source.end);
    } else {
      visit(source.shape);
    }
  };
  visit(expr);
  return names;
}

function exprHasKind(expr: Expr | BlockExpr | undefined, kind: Expr["kind"]): boolean {
  if (!expr) return false;
  if (expr.kind === kind) return true;
  return calledSubexpressions(expr).some((item) => exprHasKind(item, kind));
}

function exprHasBranchIntrinsic(expr: Expr | BlockExpr | undefined): boolean {
  return calledFunctionList(expr).some((name) =>
    name.startsWith("@branch_") || name.includes("branch_")
  );
}

function exprHasHostCall(
  expr: Expr | BlockExpr | undefined,
  functions: Map<string, FnDecl>,
): boolean {
  return calledFunctionList(expr).some((name) =>
    functions.get(name)?.primitiveId === "host_effect"
  );
}

function exprReturnsAlias(expr: Expr, name: string): boolean {
  return expr.kind === "var" && (expr.name === name || expr.name.startsWith(`${name}.`) ||
    expr.name.startsWith(`${name}[`));
}

function paramUsedInEffectfulCall(
  block: BlockExpr,
  name: string,
  functions: Map<string, FnDecl>,
): boolean {
  let retained = false;
  const visit = (expr: Expr | undefined) => {
    if (!expr || retained) return;
    if (expr.kind === "call" && expr.callee.kind === "var") {
      const callee = functions.get(expr.callee.name);
      if (
        (callee?.effects.length ?? 0) > 0 && expr.args.some((arg) => exprMentionsName(arg, name))
      ) {
        retained = true;
        return;
      }
    }
    calledSubexpressions(expr).forEach(visit);
  };
  block.statements.forEach((stmt) => {
    if (stmt.kind !== "proof_const") visit(stmt.value);
  });
  visit(block.expr);
  return retained;
}

function paramUsedAsWholeValue(block: BlockExpr, name: string): boolean {
  let used = false;
  const visit = (expr: Expr | undefined) => {
    if (!expr || used) return;
    if (expr.kind === "var" && expr.name === name) {
      used = true;
      return;
    }
    calledSubexpressions(expr).forEach(visit);
  };
  block.statements.forEach((stmt) => {
    if (stmt.kind !== "proof_const") visit(stmt.value);
  });
  visit(block.expr);
  return used;
}

function exprMentionsName(expr: Expr, name: string): boolean {
  return usedNames(expr).has(name);
}

function calledSubexpressions(expr: Expr | BlockExpr): Expr[] {
  switch (expr.kind) {
    case "do":
      return expr.expr ? [expr.expr] : [];
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

function inlineCall(
  name: string,
  args: Expr[],
  inlineable: Map<string, FnDecl>,
  options: { allowMultiValue: boolean },
): Expr | undefined {
  const fn = inlineable.get(name);
  if (!fn || fn.params.length !== args.length) return undefined;
  if (!options.allowMultiValue && !isScalarRuntimeReturn(fn.returnType)) return undefined;
  const statements: Statement[] = [];
  let body = alphaRenameInlineBlock(structuredClone(fn.body) as FnDecl["body"], fn.name);
  fn.params.forEach((param, index) => {
    const arg = args[index];
    if (arg?.kind === "var") {
      body = substituteVar(body, param.name, arg) as FnDecl["body"];
      return;
    }
    const paramName = inlineBindingName(fn.name, param.name);
    statements.push({
      kind: "let",
      name: paramName,
      type: param.type,
      value: arg,
    });
    body = substituteVar(body, param.name, { kind: "var", name: paramName }) as FnDecl["body"];
  });
  return {
    kind: "block",
    statements: [...statements, ...body.statements],
    expr: body.expr,
  };
}

function inlineCallExpr(
  expr: Expr,
  inlineable: Map<string, FnDecl>,
  options: { allowMultiValue: boolean },
): Expr | undefined {
  return expr.kind === "call" && expr.callee.kind === "var"
    ? inlineCall(expr.callee.name, expr.args, inlineable, options)
    : undefined;
}

function alphaRenameInlineBlock(block: BlockExpr, fnName: string): BlockExpr {
  return renameBlockBindings(block, new Map(), fnName);
}

function renameBlockBindings(
  block: BlockExpr,
  outer: Map<string, string>,
  fnName: string,
): BlockExpr {
  const env = new Map(outer);
  const statements: Statement[] = [];
  for (const stmt of block.statements) {
    if (stmt.kind === "proof_const") {
      statements.push(stmt);
      continue;
    }
    const value = renameExprBindings(stmt.value, env, fnName);
    if (stmt.kind === "let") {
      const fresh = inlineBindingName(fnName, stmt.name);
      statements.push({ ...stmt, name: fresh, value });
      env.set(stmt.name, fresh);
      continue;
    }
    const names = stmt.names.map((name) => inlineBindingName(fnName, name));
    statements.push({ ...stmt, names, value });
    stmt.names.forEach((name, index) => env.set(name, names[index] ?? name));
  }
  return {
    ...block,
    statements,
    expr: block.expr ? renameExprBindings(block.expr, env, fnName) : undefined,
  };
}

function renameExprBindings(expr: Expr, env: Map<string, string>, fnName: string): Expr {
  switch (expr.kind) {
    case "do":
      return expr;
    case "const_fn":
      return { ...expr, body: renameExprBindings(expr.body, env, fnName) };
    case "var": {
      const base = baseName(expr.name);
      const renamed = env.get(base);
      return renamed ? { ...expr, name: `${renamed}${expr.name.slice(base.length)}` } : expr;
    }
    case "call":
      return {
        ...expr,
        callee: renameExprBindings(expr.callee, env, fnName),
        args: expr.args.map((arg) => renameExprBindings(arg, env, fnName)),
      };
    case "index":
      return {
        ...expr,
        target: renameExprBindings(expr.target, env, fnName),
        index: renameExprBindings(expr.index, env, fnName),
      };
    case "binary":
      return {
        ...expr,
        left: renameExprBindings(expr.left, env, fnName),
        right: renameExprBindings(expr.right, env, fnName),
      };
    case "pipe_bind": {
      const scoped = new Map(env);
      const fresh = inlineBindingName(fnName, expr.name);
      scoped.set(expr.name, fresh);
      return {
        ...expr,
        name: fresh,
        value: renameExprBindings(expr.value, env, fnName),
        body: renameExprBindings(expr.body, scoped, fnName),
      };
    }
    case "match":
      return {
        ...expr,
        value: renameExprBindings(expr.value, env, fnName),
        arms: expr.arms.map((arm) => {
          const scoped = new Map(env);
          const pattern = renamePatternBindings(arm.pattern, scoped, fnName);
          return { ...arm, pattern, value: renameExprBindings(arm.value, scoped, fnName) };
        }),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index ? renameExprBindings(slot.index, env, fnName) : undefined,
          value: renameExprBindings(slot.value, env, fnName),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: renameStaticForSourceBindings(expr.source, env, fnName),
        value: renameExprBindings(expr.value, env, fnName),
      };
    case "range":
      return {
        ...expr,
        start: renameExprBindings(expr.start, env, fnName),
        end: renameExprBindings(expr.end, env, fnName),
      };
    case "field":
      return {
        ...expr,
        value: renameExprBindings(expr.value, env, fnName),
        key: renameExprBindings(expr.key, env, fnName),
      };
    case "block":
      return renameBlockBindings(expr, env, fnName);
    case "literal":
    case "placeholder":
      return expr;
  }
}

function renameStaticForSourceBindings(
  source: StaticForSource,
  env: Map<string, string>,
  fnName: string,
): StaticForSource {
  return source.kind === "range"
    ? {
      ...source,
      start: renameExprBindings(source.start, env, fnName),
      end: renameExprBindings(source.end, env, fnName),
    }
    : { ...source, shape: renameExprBindings(source.shape, env, fnName) };
}

function renamePatternBindings(
  pattern: ParamPattern,
  env: Map<string, string>,
  fnName: string,
): ParamPattern {
  switch (pattern.kind) {
    case "binding": {
      const fresh = inlineBindingName(fnName, pattern.name);
      env.set(pattern.name, fresh);
      return { ...pattern, name: fresh };
    }
    case "tuple":
      return {
        ...pattern,
        items: pattern.items.map((item) => renamePatternBindings(item, env, fnName)),
      };
    case "constructor":
      return {
        ...pattern,
        args: pattern.args.map((arg) => renamePatternBindings(arg, env, fnName)),
      };
    case "wildcard":
    case "literal":
    case "type":
      return pattern;
  }
}

function inlineBindingName(fnName: string, name: string): string {
  return `__inl_${sanitizeName(fnName)}_${sanitizeName(name)}`;
}

function sanitizeName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_]/g, "_");
}

function optimizeStaticForSource(
  source: StaticForSource,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  config: OptimizerConfig,
): StaticForSource {
  return source.kind === "range"
    ? {
      ...source,
      start: optimizeExpr(source.start, forwarding, inlineable, functions, config),
      end: optimizeExpr(source.end, forwarding, inlineable, functions, config),
    }
    : { ...source, shape: optimizeExpr(source.shape, forwarding, inlineable, functions, config) };
}

function removeUnusedPureLets(block: BlockExpr, functions: Map<string, FnDecl>): BlockExpr {
  const kept: Statement[] = [];
  const used = usedNames(block.expr);
  for (let index = block.statements.length - 1; index >= 0; index--) {
    const stmt = block.statements[index]!;
    if (stmt.kind === "proof_const") {
      kept.unshift(stmt);
      continue;
    }
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    const needed = bindings.some((name) => used.has(name));
    if (!needed && !hasRuntimeEffect(stmt.value, functions)) continue;
    kept.unshift(stmt);
    for (const name of bindings) used.delete(name);
    for (const name of usedNames(stmt.value)) used.add(name);
  }
  return { ...block, statements: kept };
}

function usedNames(expr: Expr | undefined): Set<string> {
  const names = new Set<string>();
  const visit = (item: Expr | undefined) => {
    if (!item) return;
    switch (item.kind) {
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
        for (const name of usedNames(item.body)) if (name !== item.name) names.add(name);
        return;
      case "match":
        visit(item.value);
        for (const arm of item.arms) {
          const scoped = usedNames(arm.value);
          for (const binding of patternBindingNames(arm.pattern)) scoped.delete(binding);
          for (const name of scoped) names.add(name);
        }
        return;
      case "shape":
      case "product_constructor":
        for (const slot of item.slots) {
          visit(slot.index);
          visit(slot.value);
        }
        return;
      case "static_for_slots":
        visitStaticForSource(item.source);
        visit(item.value);
        return;
      case "range":
        visit(item.start);
        visit(item.end);
        return;
      case "field":
        visit(item.value);
        visit(item.key);
        return;
      case "block":
        {
          const blockNames = blockUsedNames(item);
          for (const name of blockNames) names.add(name);
        }
        return;
      case "literal":
      case "placeholder":
        return;
    }
  };
  const visitStaticForSource = (source: StaticForSource) => {
    if (source.kind === "range") {
      visit(source.start);
      visit(source.end);
    } else {
      visit(source.shape);
    }
  };
  visit(expr);
  return names;
}

function usedNameCounts(block: BlockExpr): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: string, count = 1) => counts.set(name, (counts.get(name) ?? 0) + count);
  const merge = (items: Map<string, number>) => {
    for (const [name, count] of items) add(name, count);
  };
  const exprCounts = (expr: Expr | undefined): Map<string, number> => {
    const result = new Map<string, number>();
    const addLocal = (name: string, count = 1) => result.set(name, (result.get(name) ?? 0) + count);
    const mergeLocal = (items: Map<string, number>) => {
      for (const [name, count] of items) addLocal(name, count);
    };
    const visit = (item: Expr | undefined) => {
      if (!item) return;
      switch (item.kind) {
        case "var":
          addLocal(baseName(item.name));
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
        case "pipe_bind": {
          visit(item.value);
          const body = exprCounts(item.body);
          body.delete(item.name);
          mergeLocal(body);
          return;
        }
        case "match":
          visit(item.value);
          for (const arm of item.arms) {
            const armCounts = exprCounts(arm.value);
            for (const binding of patternBindingNames(arm.pattern)) armCounts.delete(binding);
            mergeLocal(armCounts);
          }
          return;
        case "shape":
        case "product_constructor":
          for (const slot of item.slots) {
            visit(slot.index);
            visit(slot.value);
          }
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
        case "range":
          visit(item.start);
          visit(item.end);
          return;
        case "field":
          visit(item.value);
          visit(item.key);
          return;
        case "block":
          mergeLocal(usedNameCounts(item));
          return;
        case "const_fn":
          visit(item.body);
          return;
        case "do":
          for (const stmt of item.statements) {
            if (stmt.kind === "do_bind" || stmt.kind === "do_expr") {
              visit(stmt.value);
              continue;
            }
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
    return result;
  };
  for (const stmt of block.statements) {
    if (stmt.kind !== "proof_const") merge(exprCounts(stmt.value));
  }
  merge(exprCounts(block.expr));
  return counts;
}

function blockUsedNames(block: BlockExpr): Set<string> {
  const used = usedNames(block.expr);
  for (let index = block.statements.length - 1; index >= 0; index--) {
    const stmt = block.statements[index]!;
    if (stmt.kind === "proof_const") continue;
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    const valueNames = usedNames(stmt.value);
    for (const name of bindings) used.delete(name);
    for (const name of valueNames) used.add(name);
  }
  return used;
}

function baseName(name: string): string {
  return name.split(/[.[(]/, 1)[0] ?? name;
}

function hasRuntimeEffect(expr: Expr, functions: Map<string, FnDecl>): boolean {
  switch (expr.kind) {
    case "do":
      return true;
    case "const_fn":
      return hasRuntimeEffect(expr.body, functions);
    case "call":
      return (expr.callee.kind === "var" &&
        (!functions.has(expr.callee.name) ||
          (functions.get(expr.callee.name)?.effects.length ?? 0) > 0)) ||
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
      return expr.slots.some((slot) =>
        (slot.index ? hasRuntimeEffect(slot.index, functions) : false) ||
        hasRuntimeEffect(slot.value, functions)
      );
    case "range":
      return hasRuntimeEffect(expr.start, functions) || hasRuntimeEffect(expr.end, functions);
    case "static_for_slots":
      return hasRuntimeEffect(expr.value, functions) ||
        (expr.source.kind === "range"
          ? hasRuntimeEffect(expr.source.start, functions) ||
            hasRuntimeEffect(expr.source.end, functions)
          : hasRuntimeEffect(expr.source.shape, functions));
    case "field":
      return hasRuntimeEffect(expr.value, functions) || hasRuntimeEffect(expr.key, functions);
    case "block":
      return expr.statements.some((stmt) =>
        (stmt.kind === "let" || stmt.kind === "destructure_let") &&
        hasRuntimeEffect(stmt.value, functions)
      ) || (expr.expr ? hasRuntimeEffect(expr.expr, functions) : false);
    case "literal":
    case "var":
    case "placeholder":
      return false;
  }
}

function substituteStaticForSource(
  source: StaticForSource,
  name: string,
  value: Expr,
): StaticForSource {
  return source.kind === "range"
    ? {
      ...source,
      start: substituteVar(source.start, name, value),
      end: substituteVar(source.end, name, value),
    }
    : { ...source, shape: substituteVar(source.shape, name, value) };
}

function substituteVar(expr: Expr, name: string, value: Expr): Expr {
  switch (expr.kind) {
    case "do":
      return expr;
    case "const_fn":
      return expr.params.includes(name)
        ? expr
        : { ...expr, body: substituteVar(expr.body, name, value) };
    case "var":
      if (expr.name === name) return value;
      if (
        value.kind === "var" &&
        (expr.name.startsWith(`${name}.`) || expr.name.startsWith(`${name}[`))
      ) {
        return { kind: "var", name: `${value.name}${expr.name.slice(name.length)}` };
      }
      return expr;
    case "call":
      return {
        ...expr,
        callee: substituteVar(expr.callee, name, value),
        args: expr.args.map((arg) => substituteVar(arg, name, value)),
      };
    case "index":
      return {
        ...expr,
        target: substituteVar(expr.target, name, value),
        index: substituteVar(expr.index, name, value),
      };
    case "binary":
      return {
        ...expr,
        left: substituteVar(expr.left, name, value),
        right: substituteVar(expr.right, name, value),
      };
    case "match":
      return {
        ...expr,
        value: substituteVar(expr.value, name, value),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: patternBindsName(arm.pattern, name)
            ? arm.value
            : substituteVar(arm.value, name, value),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index ? substituteVar(slot.index, name, value) : undefined,
          value: substituteVar(slot.value, name, value),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: substituteStaticForSource(expr.source, name, value),
        value: substituteVar(expr.value, name, value),
      };
    case "range":
      return {
        ...expr,
        start: substituteVar(expr.start, name, value),
        end: substituteVar(expr.end, name, value),
      };
    case "field":
      return {
        ...expr,
        value: substituteVar(expr.value, name, value),
        key: substituteVar(expr.key, name, value),
      };
    case "pipe_bind":
      return expr.name === name ? { ...expr, value: substituteVar(expr.value, name, value) } : {
        ...expr,
        value: substituteVar(expr.value, name, value),
        body: substituteVar(expr.body, name, value),
      };
    case "block":
      return substituteBlock(expr, name, value);
    case "literal":
    case "placeholder":
      return expr;
  }
}

function substituteBlock(block: BlockExpr, name: string, value: Expr): BlockExpr {
  const statements: Statement[] = [];
  let shadowed = false;
  for (const stmt of block.statements) {
    if (stmt.kind === "proof_const") {
      statements.push(stmt);
      continue;
    }
    statements.push(shadowed ? stmt : { ...stmt, value: substituteVar(stmt.value, name, value) });
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    if (bindings.includes(name)) shadowed = true;
  }
  return {
    ...block,
    statements,
    expr: !shadowed && block.expr ? substituteVar(block.expr, name, value) : block.expr,
  };
}
