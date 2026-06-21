import type {
  BlockExpr,
  BranchHint,
  ConstDecl,
  DebugTraceStmt,
  Declaration,
  DeclarationTag,
  DoStatement,
  Expr,
  FnDecl,
  OperatorDecl,
  Param,
  ParamPattern,
  Program,
  ResolvedTypeHole,
  ShapeType,
  Statement,
  StaticForSource,
  TypeAnnotationHole,
  TypeBody,
  TypeCountExpr,
  TypeDecl,
  TypeExpr,
  TypeMember,
  TypeParamKind,
  TypePattern,
  TypeResultKind,
  TypeShape,
  TypeVariant,
} from "./core_ast.ts";
import { CompileError, type Diagnostic, type Span } from "./diagnostics.ts";
import { isCatchAllPattern, patternBindingNames } from "./patterns.ts";
import { intrinsicWrapperId, isIntrinsicWrapper, isKnownIntrinsicId } from "./primitives.ts";
import {
  annotationBranchHint,
  type CompilerPluginOptions,
  type CompilerPluginRegistry,
  compilerSpecialForm,
  createCompilerPluginRegistry,
  defaultCompilerPluginRegistry,
  isCompilerSpecialForm,
  isPrimitiveScalarIntrinsicId,
  isStaticBuiltinName,
  staticBuiltinName,
  staticBuiltinParamKind,
  type TypePluginValue,
} from "./plugins.ts";
import { type CompileTraceSink, traceInstant, traceSync } from "./trace.ts";
import { checkPluginRewrites } from "./rewrites.ts";
import { normalizeTypeSourceForParsing } from "./type_source.ts";
import {
  canonicalDomainKey,
  cardinality,
  domainContains,
  type DomainInterval,
  domainIsEmpty,
  endpointFromTypeExprText,
  I32_MAX,
  I32_MAX_EXCLUSIVE,
  I32_MIN,
  intersectDomain,
  literalEndpoint,
  parseRefinedI32Type,
  refinedI32Assignable,
  refinedI32ContainsLiteral,
  type RefinedI32Domain,
  refinedI32DomainDifference,
  refinedI32DomainIntersection,
  refinedI32FromRange,
  refinedI32TypeCanonical,
  renderRefinedI32Domain,
  scalarDomainRuntimeType,
  scalarFactsFromI32Range,
  scalarFactsFromRefinedI32Type,
  subtractDomain,
  unionDomain,
  validateScalarDomainType,
} from "./refined_scalar.ts";
import { type ShaderManifestEntry, shaderManifestEntry, wgslShaderId } from "./wgsl.ts";

export interface CheckResult {
  program: Program;
  runtimeProgram: Program;
  shaderManifest: ShaderManifestEntry[];
  trace?: CheckTrace;
}

export interface AnalysisCheckResult extends CheckResult {
  diagnostics: Diagnostic[];
}

export interface CheckTrace {
  phases: CheckPhaseTrace[];
}

export interface CheckPhaseTrace {
  name: string;
  ms: number;
  functionCount: number;
  generatedFunctionCount: number;
  callExpressionCount: number;
  diagnosticCount: number;
  specialization?: SpecializationTrace;
}

export interface SpecializationTrace {
  visitedCalls: number;
  generatedSpecializations: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface FunctionCheckCacheEntry {
  fn: FnDecl;
}

interface InferredTypeVarCacheEntry {
  key: string;
  vars: Set<string>;
}

const PARSED_ANNOTATION_TYPE_CACHE_LIMIT = 4096;
const parsedAnnotationTypeCache = new Map<string, TypeExpr | false>();

export interface CheckCache {
  functionChecks?: Map<string, FunctionCheckCacheEntry>;
  semanticHashes?: WeakMap<object, string>;
  signatureHashes?: WeakMap<object, string>;
  annotationWork?: WeakMap<object, boolean>;
  doExpressionWork?: WeakMap<object, boolean>;
  builtinOperatorLoweredDeclarations?: WeakSet<object>;
  branchHintCheckedDeclarations?: WeakSet<object>;
  balancedBinaryDeclarations?: WeakSet<object>;
  collectorLoweredDeclarations?: WeakMap<object, string>;
  inferredTypeVars?: WeakMap<object, InferredTypeVarCacheEntry>;
  typeContractChecks?: Set<string>;
}

interface CallCheckMemo {
  returnType?: string;
}

interface CheckMemo {
  typeMatches: Map<string, boolean>;
  runtimeType: Map<string, string | undefined>;
  exprBindingType: Map<string, string | undefined>;
  staticConstValue: Map<string, ConstValue | undefined>;
  callCheck: Map<string, CallCheckMemo>;
  typeVarsByFunction: WeakMap<FnDecl, Set<string>>;
  cachedTypeVarsByFunction?: WeakMap<object, InferredTypeVarCacheEntry>;
}

export interface CheckProgramOptions extends CompilerPluginOptions {
  trace?: boolean;
  compileTrace?: CompileTraceSink;
  cache?: CheckCache;
}

function diagnosticAt(
  code: string,
  message: string,
  spanLike?: { span?: Span; nameSpan?: Span },
): Diagnostic {
  return { code, message, span: spanLike?.nameSpan ?? spanLike?.span };
}

function checkRemovedRewriteTypeText(
  type: string | undefined,
  diagnostics: Diagnostic[],
  spanLike?: { span?: Span; nameSpan?: Span },
) {
  if (!type) return;
  if (!/\brewrite\b/.test(type)) return;
  diagnostics.push(diagnosticAt(
    "rewrite.not_source",
    "rewrite is not a source type; compiler rewrites are provided by plugins",
    spanLike,
  ));
}

function checkRemovedAssumeCall(expr: Expr, diagnostics: Diagnostic[]) {
  if (expr.kind !== "call") return;
  if (expr.callee.kind !== "var") return;
  if (expr.callee.name !== "@assume") return;
  diagnostics.push(diagnosticAt(
    "rewrite.assume_removed",
    "@assume is only available inside compiler plugin rewrite templates",
    expr,
  ));
}

function callSiteSpan(expr: Extract<Expr, { kind: "call" }>): Span | undefined {
  const start = expr.callee.span?.start ?? expr.span?.start;
  const end = expr.span?.end ?? expr.args.at(-1)?.span?.end ?? expr.callee.span?.end;
  if (start === undefined || end === undefined) return expr.span ?? expr.callee.span;
  return { ...(expr.span ?? expr.callee.span!), start, end };
}

function exprDiagnosticSpan(expr: Expr | undefined): Span | undefined {
  if (!expr) return undefined;
  if (expr.span) return expr.span;
  if (expr.kind === "call") return callSiteSpan(expr);
  const childSpans = exprChildren(expr).map(exprDiagnosticSpan).filter((span): span is Span =>
    span !== undefined
  );
  if (!childSpans.length) return undefined;
  const start = Math.min(...childSpans.map((span) => span.start));
  const end = Math.max(...childSpans.map((span) => span.end));
  return { ...childSpans[0], start, end };
}

export function checkProgram(program: Program, options: CheckProgramOptions = {}): CheckResult {
  const result = checkProgramInternal(program, { recoverTypes: false, ...options });
  if (result.diagnostics.length) throw new CompileError(result.diagnostics);
  return {
    program: result.program,
    runtimeProgram: result.runtimeProgram,
    shaderManifest: result.shaderManifest,
    trace: result.trace,
  };
}

export function runtimeProgramFromProgram(program: Program): Program {
  return {
    ...program,
    declarations: program.declarations.filter((
      decl,
    ): decl is Exclude<Declaration, { kind: "operator" }> => decl.kind !== "operator"),
  };
}

const RESERVED_COMPILER_VALUE_NAMES = new Set(["return"]);
const MAX_RUNTIME_FN_PARAMS = 5;

function runtimeParams(params: Param[]): Param[] {
  return params.filter((param) => !param.const);
}

function checkRuntimeParamLimit(decl: FnDecl, diagnostics: Diagnostic[]) {
  if (decl.imported || decl.generated || decl.primitiveId) return;
  const params = runtimeParams(decl.params);
  if (params.length <= MAX_RUNTIME_FN_PARAMS) return;
  const overflow = params[MAX_RUNTIME_FN_PARAMS];
  diagnostics.push(diagnosticAt(
    "fn.too_many_runtime_params",
    `function ${decl.name} has ${params.length} runtime parameters; the limit is ${MAX_RUNTIME_FN_PARAMS}`,
    overflow ?? decl,
  ));
}

function checkFnMatchBody(decl: FnDecl, diagnostics: Diagnostic[]) {
  if (!decl.matchBody) return;
  const params = runtimeParams(decl.params);
  if (!params.length) {
    diagnostics.push(diagnosticAt(
      "fn.match_no_runtime_params",
      `function ${decl.name} match body needs at least one runtime parameter`,
      decl,
    ));
    return;
  }
  const match = decl.body.expr?.kind === "match" ? decl.body.expr : undefined;
  if (!match) return;
  for (const arm of match.arms) {
    const arity = patternArity(arm.pattern);
    if (arity === params.length) continue;
    diagnostics.push(diagnosticAt(
      "fn.match_arity",
      `function ${decl.name} match arm has ${arity} pattern${
        arity === 1 ? "" : "s"
      } but expected ${params.length}`,
      arm,
    ));
  }
  checkFunctionMatchBodyPatternCoverage(decl, match, params, diagnostics);
}

function checkRuntimeFunctionDeclarations(program: Program, diagnostics: Diagnostic[]) {
  const byName = new Map<string, FnDecl>();
  for (const decl of program.declarations) {
    if (decl.kind !== "fn" || decl.generated || decl.imported || decl.primitiveId) continue;
    const previous = byName.get(decl.name);
    if (previous) {
      diagnostics.push(diagnosticAt(
        "fn.duplicate",
        `function ${decl.name} is already declared; use one match body for runtime dispatch`,
        decl,
      ));
    } else {
      byName.set(decl.name, decl);
    }
    for (const param of decl.params) {
      if (runtimeParamPatternAllowed(param.pattern)) continue;
      diagnostics.push(diagnosticAt(
        "fn.param_pattern",
        "function parameter patterns are only valid in match bodies",
        param,
      ));
    }
  }
}

function runtimeParamPatternAllowed(pattern: ParamPattern | undefined): boolean {
  if (!pattern) return true;
  if (pattern.kind === "wildcard") return true;
  return false;
}

interface FunctionMatchArmCoverage {
  index: number;
  arm: Extract<Expr, { kind: "match" }>["arms"][number];
  domains: RefinedI32Domain[];
}

function checkFunctionMatchBodyPatternCoverage(
  decl: FnDecl,
  match: Extract<Expr, { kind: "match" }>,
  params: Param[],
  diagnostics: Diagnostic[],
) {
  const previous: FunctionMatchArmCoverage[] = [];
  let catchAllIndex: number | undefined;
  let singleParamCovered: RefinedI32Domain | undefined;
  for (let index = 0; index < match.arms.length; index++) {
    const arm = match.arms[index]!;
    if (catchAllIndex !== undefined) {
      diagnostics.push(diagnosticAt(
        "match.unreachable_arm",
        `function ${decl.name} match arm ${index + 1} is unreachable because arm ${
          catchAllIndex + 1
        } covers all values`,
        arm,
      ));
      continue;
    }
    if (arm.guard) continue;
    const patterns = functionMatchArmPatterns(arm.pattern, params.length);
    if (!patterns) continue;
    const catchesAll = patterns.every((pattern) => isCatchAllPattern(pattern));
    if (catchesAll) {
      catchAllIndex = index;
      continue;
    }
    const domains = functionMatchArmI32Domains(params, patterns);
    if (!domains) continue;
    if (domains.some(domainIsEmpty)) {
      diagnostics.push(diagnosticAt(
        "match.unreachable_arm",
        `function ${decl.name} match arm ${index + 1} is unreachable`,
        arm,
      ));
      continue;
    }
    if (domains.length === 1 && singleParamCovered) {
      const current = domains[0]!;
      if (domainContains(singleParamCovered, current)) {
        diagnostics.push(diagnosticAt(
          "match.unreachable_arm",
          `function ${decl.name} match arm ${index + 1} is shadowed by earlier arms`,
          arm,
        ));
        continue;
      }
    }
    const overlap = overlappingFunctionMatchArm(previous, domains);
    if (overlap) {
      const code = overlap.contained ? "match.unreachable_arm" : "match.overlapping_arm";
      const message = overlap.contained
        ? `function ${decl.name} match arm ${index + 1} is shadowed by arm ${overlap.index + 1}`
        : `function ${decl.name} match arm ${index + 1} overlaps arm ${overlap.index + 1} on ${
          canonicalDomainKey(overlap.domain)
        }`;
      diagnostics.push(diagnosticAt(code, message, arm));
      continue;
    }
    if (domains.length === 1) {
      singleParamCovered = singleParamCovered
        ? unionDomain(singleParamCovered, domains[0]!)
        : domains[0]!;
    }
    previous.push({ index, arm, domains });
  }
}

function functionMatchArmI32Domains(
  params: Param[],
  patterns: ParamPattern[],
): RefinedI32Domain[] | undefined {
  const domains: RefinedI32Domain[] = [];
  for (let index = 0; index < params.length; index++) {
    const param = params[index]!;
    const pattern = patterns[index]!;
    const domain = functionMatchPatternI32Domain(param.type, pattern);
    if (!domain) return undefined;
    domains.push(domain);
  }
  return domains;
}

function functionMatchPatternI32Domain(
  paramType: string,
  pattern: ParamPattern | undefined,
): RefinedI32Domain | undefined {
  const paramRuntime = scalarDomainRuntimeType(paramType) ?? paramType;
  let domain = parseRefinedI32Type(paramType);
  if (!domain && paramRuntime === "i32") domain = anyI32Domain();
  if (!domain) return undefined;
  if (!pattern) return domain;
  if (pattern.kind === "binding" || pattern.kind === "wildcard") return domain;
  if (pattern.kind === "as") return functionMatchPatternI32Domain(paramType, pattern.pattern);
  if (pattern.kind === "or") {
    let combined: RefinedI32Domain | undefined;
    for (const alternative of pattern.alternatives) {
      const next = functionMatchPatternI32Domain(paramType, alternative);
      if (!next) return undefined;
      combined = combined ? unionDomain(combined, next) : next;
    }
    return combined ? intersectDomain(domain, combined) : undefined;
  }
  if (pattern.kind === "literal" && pattern.literalKind === "number") {
    if (!/^-?[0-9]+$/.test(pattern.value)) return undefined;
    const value = Number.parseInt(pattern.value, 10);
    if (!Number.isSafeInteger(value)) return undefined;
    const literalDomain = scalarFactsFromI32Range({ min: value, max: value }).domain;
    return intersectDomain(domain, literalDomain);
  }
  if (pattern.kind === "typed") {
    const inner = functionMatchPatternI32Domain(pattern.type, pattern.pattern);
    return inner ? intersectDomain(domain, inner) : undefined;
  }
  return undefined;
}

type FiniteMatchDomainKind = "bool" | "i32" | "enum" | "sum";

interface FiniteMatchDomain {
  kind: FiniteMatchDomainKind;
  type: string;
  values: string[];
}

function checkFunctionMatchBodyFiniteCoverage(
  decl: FnDecl,
  match: Extract<Expr, { kind: "match" }>,
  params: Param[],
  diagnostics: Diagnostic[],
  types: TypeDecl[],
) {
  const domains: FiniteMatchDomain[] = [];
  for (const param of params) {
    const domain = finiteRuntimeMatchDomain(param.type, types);
    if (!domain) return;
    domains.push(domain);
  }
  const total = domains.reduce((product, domain) => product * domain.values.length, 1);
  if (total <= 0 || total > MATCH_EXHAUSTIVE_DOMAIN_LIMIT) return;
  const required = new Set(crossProductKeys(domains.map((domain) => domain.values)));
  const covered = new Set<string>();
  let exhaustiveAt: number | undefined;
  for (let index = 0; index < match.arms.length; index++) {
    const arm = match.arms[index]!;
    if (exhaustiveAt !== undefined) {
      diagnostics.push(diagnosticAt(
        "match.unreachable_arm",
        `function ${decl.name} match arm ${index + 1} is unreachable because arm ${
          exhaustiveAt + 1
        } covers all values`,
        arm,
      ));
      continue;
    }
    if (arm.guard) continue;
    const patterns = functionMatchArmPatterns(arm.pattern, params.length);
    if (!patterns) return;
    const valuesByParam: string[][] = [];
    for (let paramIndex = 0; paramIndex < params.length; paramIndex++) {
      const values = finitePatternValues(patterns[paramIndex]!, domains[paramIndex]!, types);
      if (!values) return;
      valuesByParam.push(values);
    }
    const keys = crossProductKeys(valuesByParam).filter((key) => required.has(key));
    if (!keys.length) {
      diagnostics.push(diagnosticAt(
        "match.unreachable_arm",
        `function ${decl.name} match arm ${index + 1} is unreachable`,
        arm,
      ));
      continue;
    }
    const alreadyCovered = keys.filter((key) => covered.has(key));
    if (alreadyCovered.length === keys.length) {
      diagnostics.push(diagnosticAt(
        "match.unreachable_arm",
        `function ${decl.name} match arm ${index + 1} is shadowed by earlier arms`,
        arm,
      ));
      continue;
    }
    if (alreadyCovered.length > 0) {
      diagnostics.push(diagnosticAt(
        "match.overlapping_arm",
        `function ${decl.name} match arm ${index + 1} overlaps earlier arms`,
        arm,
      ));
      continue;
    }
    for (const key of keys) covered.add(key);
    if (covered.size === required.size) exhaustiveAt = index;
  }
  if (covered.size < required.size) {
    const missing = [...required].filter((value) => !covered.has(value));
    diagnostics.push(diagnosticAt(
      "type.non_exhaustive_match",
      `function ${decl.name} match is missing ${missing.slice(0, 4).join(", ")}${
        missing.length > 4 ? ", ..." : ""
      }`,
      match,
    ));
  }
}

function checkFunctionMatchBodyFiniteCoverageForProgram(
  program: Program,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  for (const decl of program.declarations) {
    if (decl.kind !== "fn" || !decl.matchBody || decl.generated || decl.imported) continue;
    const params = runtimeParams(decl.params);
    if (params.length < 2) continue;
    const match = decl.body.expr?.kind === "match" ? decl.body.expr : undefined;
    if (!match) continue;
    checkFunctionMatchBodyFiniteCoverage(decl, match, params, diagnostics, types);
  }
}

function crossProductKeys(valuesByParam: string[][]): string[] {
  let keys = [""];
  for (const values of valuesByParam) {
    const next: string[] = [];
    for (const key of keys) {
      for (const value of values) {
        next.push(key ? `${key}\0${value}` : value);
      }
    }
    keys = next;
  }
  return keys;
}

function overlappingFunctionMatchArm(
  previous: FunctionMatchArmCoverage[],
  domains: RefinedI32Domain[],
): { index: number; contained: boolean; domain: RefinedI32Domain } | undefined {
  for (const item of previous) {
    if (item.domains.length !== domains.length) continue;
    const intersections: RefinedI32Domain[] = [];
    let overlaps = true;
    let contained = true;
    for (let index = 0; index < domains.length; index++) {
      const left = item.domains[index]!;
      const right = domains[index]!;
      const intersection = intersectDomain(left, right);
      if (domainIsEmpty(intersection)) {
        overlaps = false;
        break;
      }
      intersections.push(intersection);
      if (!domainContains(left, right)) contained = false;
    }
    if (!overlaps) continue;
    return { index: item.index, contained, domain: intersections[0]! };
  }
  return undefined;
}

function expandFunctionMatchBodies(program: Program) {
  const replacements = new Map<FnDecl, FnDecl[]>();
  for (const decl of program.declarations) {
    if (decl.kind !== "fn" || decl.generated || !decl.matchBody) continue;
    if (!exprCallsFunction(decl.body, decl.name)) continue;
    const expanded = expandFunctionMatchBody(decl);
    if (expanded) replacements.set(decl, expanded);
  }
  if (!replacements.size) return;
  program.declarations = program.declarations.flatMap((decl): Program["declarations"] =>
    decl.kind === "fn" ? (replacements.get(decl) ?? [decl]) : [decl]
  );
}

function expandFunctionMatchBody(decl: FnDecl): FnDecl[] | undefined {
  const match = decl.body.expr?.kind === "match" ? decl.body.expr : undefined;
  if (!match) return undefined;
  if (match.arms.some((arm) => arm.guard)) return undefined;
  const runtimeIndexes = decl.params
    .map((param, index) => param.const ? -1 : index)
    .filter((index) => index >= 0);
  if (!runtimeIndexes.length) return undefined;
  const clauses: FnDecl[] = [];
  for (let index = 0; index < match.arms.length; index++) {
    const arm = match.arms[index]!;
    const patterns = functionMatchArmPatterns(arm.pattern, runtimeIndexes.length);
    if (!patterns) return undefined;
    const params = decl.params.map((param, paramIndex) => {
      const runtimeIndex = runtimeIndexes.indexOf(paramIndex);
      if (runtimeIndex < 0) return functionClauseBindingParam(param);
      return functionClauseParamFromPattern(param, patterns[runtimeIndex]);
    });
    const clause: FnDecl = {
      ...decl,
      memberOf: undefined,
      public: false,
      name: `${decl.name}__clause_${index}`,
      params,
      body: { kind: "block", statements: [], expr: arm.value },
      generated: true,
      matchBody: undefined,
      branchHint: arm.branchHint,
    };
    clauses.push({
      ...clause,
      body: clauseBodyWithParamPatternBindings(clause),
    });
  }
  const dispatcherParams = decl.params.map(functionClauseBindingParam);
  const dispatcherSignature = { ...decl, params: dispatcherParams };
  const inlineableDispatcher = clauses.every((clause) =>
    !exprCallsFunction(clause.body, decl.name)
  );
  const dispatcher: FnDecl = {
    ...decl,
    params: dispatcherParams,
    body: clauseDispatcherBody(dispatcherSignature, clauses),
    generated: true,
    generatedInlineable: inlineableDispatcher,
    matchBody: undefined,
    branchHint: undefined,
  };
  return [dispatcher, ...clauses];
}

function functionMatchArmPatterns(
  pattern: ParamPattern,
  arity: number,
): ParamPattern[] | undefined {
  if (arity === 1) return [pattern];
  if (pattern.kind === "tuple" && pattern.items.length === arity) return pattern.items;
  return undefined;
}

function functionClauseBindingParam(param: Param): Param {
  return {
    ...param,
    pattern: { kind: "binding", name: param.name },
  };
}

function functionClauseParamFromPattern(param: Param, pattern: ParamPattern | undefined): Param {
  if (!pattern) return functionClauseBindingParam(param);
  if (pattern.kind === "typed") {
    const inner = functionClauseParamFromPattern({ ...param, type: pattern.type }, pattern.pattern);
    return { ...inner, type: pattern.type };
  }
  if (pattern.kind === "binding") {
    return {
      ...param,
      name: pattern.name,
      pattern: { kind: "binding", name: pattern.name },
    };
  }
  if (pattern.kind === "wildcard") {
    return {
      ...param,
      pattern,
    };
  }
  return {
    ...param,
    pattern,
  };
}

function patternArity(pattern: ParamPattern): number {
  if (pattern.kind === "typed") return patternArity(pattern.pattern);
  if (pattern.kind === "tuple") return pattern.items.length;
  return 1;
}

function envWithPatternBindings(
  pattern: ParamPattern,
  valueType: string | undefined,
  env: Map<string, string>,
  types: TypeDecl[],
): Map<string, string> {
  const scoped = new Map(env);
  addPatternBindingTypes(pattern, valueType, scoped, types);
  return scoped;
}

function addPatternBindingTypes(
  pattern: ParamPattern | undefined,
  valueType: string | undefined,
  env: Map<string, string>,
  types: TypeDecl[],
) {
  if (!pattern) return;
  if (pattern.kind === "binding") {
    env.set(pattern.name, valueType ?? "i32");
    return;
  }
  if (pattern.kind === "typed") {
    addPatternBindingTypes(pattern.pattern, pattern.type, env, types);
    return;
  }
  if (pattern.kind === "as") {
    env.set(pattern.name, valueType ?? "i32");
    addPatternBindingTypes(pattern.pattern, valueType, env, types);
    return;
  }
  if (pattern.kind === "or") {
    if (pattern.alternatives[0]) {
      addPatternBindingTypes(pattern.alternatives[0], valueType, env, types);
    }
    return;
  }
  if (pattern.kind === "tuple" && valueType) {
    const slots = runtimeSlotTypes(valueType, types);
    for (let index = 0; index < pattern.items.length; index++) {
      addPatternBindingTypes(pattern.items[index], slots[index] ?? "i32", env, types);
    }
    return;
  }
  if (pattern.kind === "product") {
    const slots = structuralProductSlotsForType(valueType, types) ?? [];
    for (const field of pattern.fields) {
      const slot = slots.find((item, index) => (item.label ?? String(index)) === field.label);
      addPatternBindingTypes(field.pattern, slot?.type ?? "i32", env, types);
    }
    return;
  }
  if (pattern.kind === "constructor") {
    const slots = sumVariantSlotTypes(valueType, pattern.name, types) ?? [];
    for (let index = 0; index < pattern.args.length; index++) {
      addPatternBindingTypes(pattern.args[index], slots[index] ?? "i32", env, types);
    }
  }
}

function checkReservedCompilerNames(program: Program, diagnostics: Diagnostic[]) {
  const checkName = (name: string | undefined, spanLike?: { span?: Span; nameSpan?: Span }) => {
    if (!name) return;
    if (!RESERVED_COMPILER_VALUE_NAMES.has(name)) return;
    diagnostics.push(diagnosticAt(
      "name.reserved",
      `${name} is reserved for a compiler builtin`,
      spanLike,
    ));
  };
  const checkPattern = (pattern: ParamPattern | undefined) => {
    if (pattern?.kind === "binding") checkName(pattern.name, pattern);
    if (pattern?.kind === "tuple") {
      for (const item of pattern.items) checkPattern(item);
    }
    if (pattern?.kind === "constructor") {
      for (const item of pattern.args) checkPattern(item);
    }
    if (pattern?.kind === "typed") checkPattern(pattern.pattern);
  };
  const checkStatement = (stmt: Statement, allowProfile = true) => {
    if (stmt.kind === "let") checkName(stmt.name, stmt);
    if (stmt.kind === "destructure_let") {
      for (const name of stmt.names) checkName(name, { span: stmt.nameSpans?.[name] ?? stmt.span });
    }
    if (stmt.kind === "let" || stmt.kind === "destructure_let") checkExpr(stmt.value);
    if (stmt.kind === "debug_trace") stmt.args.forEach(checkExpr);
  };
  const checkDoStatement = (stmt: DoStatement) => {
    if (stmt.kind === "do_bind") checkName(stmt.name, stmt);
    if (stmt.kind === "let") checkName(stmt.name, stmt);
    if (stmt.kind === "destructure_let") {
      for (const name of stmt.names) checkName(name, { span: stmt.nameSpans?.[name] ?? stmt.span });
    }
    if (stmt.kind !== "type_assert" && "value" in stmt) checkExpr(stmt.value);
    if (stmt.kind === "debug_trace") stmt.args.forEach(checkExpr);
  };
  const checkBlock = (block: BlockExpr) => {
    for (const stmt of block.statements) checkStatement(stmt);
    if (block.expr) checkExpr(block.expr);
  };
  const checkExpr = (expr: Expr | undefined) => {
    if (!expr) return;
    checkRemovedAssumeCall(expr, diagnostics);
    switch (expr.kind) {
      case "const_fn":
        for (const param of expr.params) checkName(param, expr);
        checkExpr(expr.body);
        return;
      case "pipe_bind":
        checkName(expr.name, expr);
        checkExpr(expr.value);
        checkExpr(expr.body);
        return;
      case "match":
        checkExpr(expr.value);
        for (const arm of expr.arms) {
          checkPattern(arm.pattern);
          checkExpr(arm.guard);
          checkExpr(arm.value);
        }
        return;
      case "shape":
      case "product_constructor":
        for (const slot of expr.slots) {
          if (slot.index) checkExpr(slot.index);
          checkExpr(slot.value);
        }
        return;
      case "static_for_slots":
        if (expr.source.kind === "range") {
          checkExpr(expr.source.start);
          checkExpr(expr.source.end);
        } else {
          checkExpr(expr.source.shape);
        }
        checkExpr(expr.value);
        return;
      case "block":
        checkBlock(expr);
        return;
      case "do":
        for (const stmt of expr.statements) checkDoStatement(stmt);
        checkExpr(expr.expr);
        return;
      default:
        for (const child of exprChildren(expr)) checkExpr(child);
        return;
    }
  };
  for (const item of program.imports) checkName(item.name, item);
  for (const decl of program.declarations) {
    if (decl.kind === "fn" || decl.kind === "const" || decl.kind === "let") {
      checkName(decl.name, decl);
    }
    if (decl.kind === "fn") {
      for (const param of decl.params) checkName(param.name, param);
      checkBlock(decl.body);
    } else if (decl.kind === "const" || decl.kind === "let") {
      checkExpr(decl.value);
    } else if (decl.kind === "type") {
      for (const stmt of decl.body.statements) checkName(stmt.name, stmt);
    }
  }
}

function checkRemovedSyntax(program: Program, diagnostics: Diagnostic[]) {
  const checkTypeExpr = (expr: TypeExpr | undefined, allowSelf = false) => {
    if (!expr) return;
    if (expr.kind === "type_ref" && expr.name === "Self" && !allowSelf) {
      diagnostics.push(diagnosticAt(
        "type.self_context",
        "Self is only valid inside declaration tag expressions",
        expr,
      ));
    }
    if (expr.kind === "type_static_ref" && isCompilerSpecialForm(expr.name, "declaration")) {
      const form = compilerSpecialForm(expr.name);
      diagnostics.push(diagnosticAt(
        "syntax.declaration_builtin",
        `${form?.spelling ?? `@${expr.name}`} is only valid as a top-level const declaration value`,
        expr,
      ));
    }
    for (const child of typeExprChildren(expr)) checkTypeExpr(child, allowSelf);
  };
  const checkStatement = (stmt: Statement) => {
    if (stmt.kind === "let" || stmt.kind === "destructure_let") checkExpr(stmt.value);
    if (stmt.kind === "let") checkRemovedRewriteTypeText(stmt.type, diagnostics, stmt);
    if (stmt.kind === "type_assert") checkTypeExpr(stmt.value);
    if (stmt.kind === "debug_trace") stmt.args.forEach(checkExpr);
  };
  const checkDoStatement = (stmt: DoStatement) => {
    if (stmt.kind === "type_assert") checkTypeExpr(stmt.value);
    else if ("value" in stmt) checkExpr(stmt.value);
    if (stmt.kind === "debug_trace") stmt.args.forEach(checkExpr);
  };
  const checkBlock = (block: BlockExpr) => {
    for (const stmt of block.statements) checkStatement(stmt);
    if (block.expr) checkExpr(block.expr);
  };
  const checkExpr = (expr: Expr | undefined) => {
    if (!expr) return;
    switch (expr.kind) {
      case "var":
        if (expr.name.startsWith("@") && isCompilerSpecialForm(expr.name, "declaration")) {
          const form = compilerSpecialForm(expr.name);
          diagnostics.push(diagnosticAt(
            "syntax.declaration_builtin",
            `${form?.spelling ?? expr.name} is only valid as a top-level const declaration value`,
            expr,
          ));
        }
        return;
      case "pipe_bind":
        checkExpr(expr.value);
        checkExpr(expr.body);
        return;
      case "const_fn":
        checkExpr(expr.body);
        return;
      case "match":
        checkExpr(expr.value);
        for (const arm of expr.arms) checkExpr(arm.value);
        return;
      case "shape":
      case "product_constructor":
        for (const slot of expr.slots) {
          if (slot.index) checkExpr(slot.index);
          checkExpr(slot.value);
        }
        return;
      case "static_for_slots":
        if (expr.source.kind === "range") {
          checkExpr(expr.source.start);
          checkExpr(expr.source.end);
        } else {
          checkExpr(expr.source.shape);
        }
        checkExpr(expr.value);
        return;
      case "block":
        checkBlock(expr);
        return;
      case "do":
        checkTypeExpr(expr.strategy.effect);
        for (const stmt of expr.statements) checkDoStatement(stmt);
        checkExpr(expr.expr);
        return;
      default:
        for (const child of exprChildren(expr)) checkExpr(child);
        return;
    }
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      checkRemovedRewriteTypeText(decl.returnType, diagnostics, decl);
      for (const param of decl.params) checkRemovedRewriteTypeText(param.type, diagnostics, param);
      checkBlock(decl.body);
    } else if (decl.kind === "let" || decl.kind === "const") {
      checkRemovedRewriteTypeText(decl.type, diagnostics, decl);
      checkExpr(decl.value);
    } else if (decl.kind === "type_assert") {
      checkTypeExpr(decl.value);
    } else if (decl.kind === "type") {
      for (const stmt of decl.body.statements) checkTypeExpr(stmt.value);
      checkTypeExpr(decl.body.expr);
    }
  }
}

function checkDebugTraceStatements(program: Program, diagnostics: Diagnostic[]) {
  const checkStatement = (stmt: Statement, allowProfile = true) => {
    if (stmt.kind === "debug_trace") {
      if (stmt.builtin !== "trace") {
        diagnostics.push(diagnosticAt(
          "debug.trace_builtin",
          `unknown debug statement @${stmt.builtin}; use @trace("message")`,
          stmt,
        ));
      }
      if (stmt.args.length !== 1) {
        diagnostics.push(diagnosticAt(
          "debug.trace_arity",
          "@trace expects exactly one string literal argument",
          stmt,
        ));
      } else {
        const message = stmt.args[0];
        if (message?.kind !== "literal" || message.literalKind !== "string") {
          diagnostics.push(diagnosticAt(
            "debug.trace_message",
            "@trace expects a string literal message",
            message ?? stmt,
          ));
        }
      }
      for (const arg of stmt.args) checkExpr(arg, allowProfile);
      return;
    }
    if (stmt.kind === "let" || stmt.kind === "destructure_let") {
      checkExpr(stmt.value, allowProfile);
    }
  };
  const checkDoStatement = (stmt: DoStatement, allowProfile = true) => {
    if (stmt.kind === "do_bind" || stmt.kind === "do_expr") {
      checkExpr(stmt.value, allowProfile);
      return;
    }
    checkStatement(stmt, allowProfile);
  };
  const checkBlock = (block: BlockExpr, allowProfile = true) => {
    for (const stmt of block.statements) checkStatement(stmt, allowProfile);
    if (block.expr) checkExpr(block.expr, allowProfile);
  };
  const checkExpr = (expr: Expr | undefined, allowProfile = true) => {
    if (!expr) return;
    if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === "@trace") {
      diagnostics.push(diagnosticAt(
        "debug.trace_context",
        '@trace is only valid as a statement, for example @trace("message");',
        expr,
      ));
    }
    if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === "@profile") {
      diagnostics.push(diagnosticAt(
        "profile.context",
        '@profile is only valid as a scoped expression, for example @profile("label") { value }',
        expr,
      ));
    }
    if (expr.kind === "profile") {
      if (!allowProfile) {
        diagnostics.push(diagnosticAt(
          "profile.context",
          "@profile is only valid inside runtime function bodies",
          expr,
        ));
      }
      if (expr.args.length !== 1) {
        diagnostics.push(diagnosticAt(
          "profile.arity",
          "@profile expects exactly one string literal label",
          expr,
        ));
      } else {
        const label = expr.args[0];
        if (label?.kind !== "literal" || label.literalKind !== "string") {
          diagnostics.push(diagnosticAt(
            "profile.label",
            "@profile expects a string literal label",
            label ?? expr,
          ));
        }
      }
      for (const arg of expr.args) checkExpr(arg, allowProfile);
      checkExpr(expr.body, allowProfile);
      return;
    }
    if (expr.kind === "block") {
      checkBlock(expr, allowProfile);
      return;
    }
    if (expr.kind === "do") {
      for (const stmt of expr.statements) checkDoStatement(stmt, allowProfile);
      checkExpr(expr.expr, allowProfile);
      return;
    }
    for (const child of exprChildren(expr)) checkExpr(child);
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") checkBlock(decl.body);
    else if (decl.kind === "let" || decl.kind === "const") checkExpr(decl.value, false);
  }
}

function checkPreflightSyntax(program: Program, diagnostics: Diagnostic[]) {
  const checkName = (name: string | undefined, spanLike?: { span?: Span; nameSpan?: Span }) => {
    if (!name) return;
    if (!RESERVED_COMPILER_VALUE_NAMES.has(name)) return;
    diagnostics.push(diagnosticAt(
      "name.reserved",
      `${name} is reserved for a compiler builtin`,
      spanLike,
    ));
  };
  const checkPattern = (pattern: ParamPattern | undefined) => {
    if (pattern?.kind === "binding") checkName(pattern.name, pattern);
    if (pattern?.kind === "tuple") {
      for (const item of pattern.items) checkPattern(item);
    }
    if (pattern?.kind === "constructor") {
      for (const item of pattern.args) checkPattern(item);
    }
    if (pattern?.kind === "typed") checkPattern(pattern.pattern);
  };
  const checkTypeExpr = (expr: TypeExpr | undefined, allowSelf = false) => {
    if (!expr) return;
    if (expr.kind === "type_ref" && expr.name === "Self" && !allowSelf) {
      diagnostics.push(diagnosticAt(
        "type.self_context",
        "Self is only valid inside declaration tag expressions",
        expr,
      ));
    }
    if (expr.kind === "type_static_ref" && isCompilerSpecialForm(expr.name, "declaration")) {
      const form = compilerSpecialForm(expr.name);
      diagnostics.push(diagnosticAt(
        "syntax.declaration_builtin",
        `${form?.spelling ?? `@${expr.name}`} is only valid as a top-level const declaration value`,
        expr,
      ));
    }
    for (const child of typeExprChildren(expr)) checkTypeExpr(child, allowSelf);
  };
  const checkTraceStatement = (stmt: DebugTraceStmt, allowProfile: boolean) => {
    if (stmt.builtin !== "trace") {
      diagnostics.push(diagnosticAt(
        "debug.trace_builtin",
        `unknown debug statement @${stmt.builtin}; use @trace("message")`,
        stmt,
      ));
    }
    if (stmt.args.length !== 1) {
      diagnostics.push(diagnosticAt(
        "debug.trace_arity",
        "@trace expects exactly one string literal argument",
        stmt,
      ));
    } else {
      const message = stmt.args[0];
      if (message?.kind !== "literal" || message.literalKind !== "string") {
        diagnostics.push(diagnosticAt(
          "debug.trace_message",
          "@trace expects a string literal message",
          message ?? stmt,
        ));
      }
    }
    for (const arg of stmt.args) checkExpr(arg, allowProfile);
  };
  const checkStatement = (stmt: Statement, allowProfile: boolean) => {
    if (stmt.kind === "let") checkName(stmt.name, stmt);
    if (stmt.kind === "let") checkRemovedRewriteTypeText(stmt.type, diagnostics, stmt);
    if (stmt.kind === "destructure_let") {
      for (const name of stmt.names) checkName(name, { span: stmt.nameSpans?.[name] ?? stmt.span });
    }
    if (stmt.kind === "let" || stmt.kind === "destructure_let") {
      checkExpr(stmt.value, allowProfile);
      return;
    }
    if (stmt.kind === "type_assert") {
      checkTypeExpr(stmt.value);
      return;
    }
    checkTraceStatement(stmt, allowProfile);
  };
  const checkDoStatement = (stmt: DoStatement, allowProfile: boolean) => {
    if (stmt.kind === "do_bind") {
      checkName(stmt.name, stmt);
      checkExpr(stmt.value, allowProfile);
      return;
    }
    if (stmt.kind === "do_expr") {
      checkExpr(stmt.value, allowProfile);
      return;
    }
    checkStatement(stmt, allowProfile);
  };
  const checkBlock = (block: BlockExpr, allowProfile: boolean) => {
    for (const stmt of block.statements) checkStatement(stmt, allowProfile);
    if (block.expr) checkExpr(block.expr, allowProfile);
  };
  const checkExpr = (expr: Expr | undefined, allowProfile: boolean) => {
    if (!expr) return;
    checkRemovedAssumeCall(expr, diagnostics);
    switch (expr.kind) {
      case "var":
        if (expr.name.startsWith("@") && isCompilerSpecialForm(expr.name, "declaration")) {
          const form = compilerSpecialForm(expr.name);
          diagnostics.push(diagnosticAt(
            "syntax.declaration_builtin",
            `${form?.spelling ?? expr.name} is only valid as a top-level const declaration value`,
            expr,
          ));
        }
        return;
      case "call":
        if (expr.callee.kind === "var" && expr.callee.name === "@trace") {
          diagnostics.push(diagnosticAt(
            "debug.trace_context",
            '@trace is only valid as a statement, for example @trace("message");',
            expr,
          ));
        }
        if (expr.callee.kind === "var" && expr.callee.name === "@profile") {
          diagnostics.push(diagnosticAt(
            "profile.context",
            '@profile is only valid as a scoped expression, for example @profile("label") { value }',
            expr,
          ));
        }
        checkExpr(expr.callee, allowProfile);
        for (const arg of expr.args) checkExpr(arg, allowProfile);
        return;
      case "const_fn":
        for (const param of expr.params) checkName(param, expr);
        checkExpr(expr.body, allowProfile);
        return;
      case "pipe_bind":
        checkName(expr.name, expr);
        checkExpr(expr.value, allowProfile);
        checkExpr(expr.body, allowProfile);
        return;
      case "profile":
        if (!allowProfile) {
          diagnostics.push(diagnosticAt(
            "profile.context",
            "@profile is only valid inside runtime function bodies",
            expr,
          ));
        }
        if (expr.args.length !== 1) {
          diagnostics.push(diagnosticAt(
            "profile.arity",
            "@profile expects exactly one string literal label",
            expr,
          ));
        } else {
          const label = expr.args[0];
          if (label?.kind !== "literal" || label.literalKind !== "string") {
            diagnostics.push(diagnosticAt(
              "profile.label",
              "@profile expects a string literal label",
              label ?? expr,
            ));
          }
        }
        for (const arg of expr.args) checkExpr(arg, allowProfile);
        checkExpr(expr.body, allowProfile);
        return;
      case "match":
        checkExpr(expr.value, allowProfile);
        for (const arm of expr.arms) {
          checkPattern(arm.pattern);
          checkExpr(arm.guard, allowProfile);
          checkExpr(arm.value, allowProfile);
        }
        return;
      case "shape":
      case "product_constructor":
        for (const slot of expr.slots) {
          if (slot.index) checkExpr(slot.index, allowProfile);
          checkExpr(slot.value, allowProfile);
        }
        return;
      case "static_for_slots":
        if (expr.source.kind === "range") {
          checkExpr(expr.source.start, allowProfile);
          checkExpr(expr.source.end, allowProfile);
        } else {
          checkExpr(expr.source.shape, allowProfile);
        }
        checkExpr(expr.value, allowProfile);
        return;
      case "block":
        checkBlock(expr, allowProfile);
        return;
      case "do":
        checkTypeExpr(expr.strategy.effect);
        for (const stmt of expr.statements) checkDoStatement(stmt, allowProfile);
        checkExpr(expr.expr, allowProfile);
        return;
      default:
        for (const child of exprChildren(expr)) checkExpr(child, allowProfile);
        return;
    }
  };
  for (const item of program.imports) checkName(item.name, item);
  for (const decl of program.declarations) {
    for (const tag of decl.tags ?? []) {
      if (tag.kind === "expr") checkTypeExpr(tag.expr, true);
    }
    if (decl.kind === "fn" || decl.kind === "const" || decl.kind === "let") {
      checkName(decl.name, decl);
    }
    if (decl.kind === "fn") {
      checkRuntimeParamLimit(decl, diagnostics);
      checkFnMatchBody(decl, diagnostics);
      for (const param of decl.params) checkName(param.name, param);
      for (const param of decl.params) checkRemovedRewriteTypeText(param.type, diagnostics, param);
      checkRemovedRewriteTypeText(decl.returnType, diagnostics, decl);
      checkBlock(decl.body, true);
    } else if (decl.kind === "const" || decl.kind === "let") {
      checkRemovedRewriteTypeText(decl.type, diagnostics, decl);
      checkExpr(decl.value, false);
    } else if (decl.kind === "type_assert") {
      checkTypeExpr(decl.value);
    } else if (decl.kind === "type") {
      for (const stmt of decl.body.statements) {
        checkName(stmt.name, stmt);
        checkTypeExpr(stmt.value);
      }
      checkTypeExpr(decl.body.expr);
    }
  }
}

const CORE_DECLARATION_TAGS = new Set(["test"]);

function checkDeclarationTags(program: Program, diagnostics: Diagnostic[]) {
  for (const item of program.imports) {
    checkDeclarationTagList("import", item.tags, diagnostics);
  }
  for (const item of program.sourceImports ?? []) {
    checkDeclarationTagList("source_import", item.tags, diagnostics);
  }
  for (const decl of program.declarations) {
    checkDeclarationTagList(decl, decl.tags, diagnostics);
  }
}

function checkDeclarationTagList(
  owner: Declaration | "import" | "source_import",
  tags: DeclarationTag[] | undefined,
  diagnostics: Diagnostic[],
) {
  if (!tags || tags.length === 0) return;
  const seen = new Set<string>();
  const ownerKind = typeof owner === "string" ? owner : owner.kind;
  for (const tag of tags) {
    if (tag.kind === "expr") continue;
    if (!CORE_DECLARATION_TAGS.has(tag.name)) {
      diagnostics.push(diagnosticAt(
        "tag.unknown",
        `unknown declaration tag @[${tag.name}]`,
        tag,
      ));
      continue;
    }
    if (!declarationTestTagAllowed(owner)) {
      diagnostics.push(diagnosticAt(
        "tag.context",
        `declaration tag @[${tag.name}] is only valid on functions and zero-argument type functions`,
        tag,
      ));
    }
    if (seen.has(tag.name)) {
      diagnostics.push(diagnosticAt(
        "tag.duplicate",
        `duplicate declaration tag @[${tag.name}]`,
        tag,
      ));
      continue;
    }
    seen.add(tag.name);
  }
}

function declarationTestTagAllowed(owner: Declaration | "import" | "source_import"): boolean {
  if (typeof owner === "string") return false;
  if (owner.kind === "fn") return true;
  if (owner.kind === "type" && owner.params.length === 0) return true;
  return false;
}

function declarationHasLegacyTestTag(decl: Declaration): boolean {
  return !!decl.tags?.some((tag) => tag.kind === "legacy" && tag.name === "test");
}

function evaluateTypeTestDeclarations(
  types: TypeDecl[],
  functions: FnDecl[],
  hostIoImports: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  addShader: (source: string) => ShaderManifestEntry,
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
) {
  const typesByName = new Map(types.map((decl) => [decl.name, decl]));
  const functionsByName = new Map(functions.map((decl) => [decl.name, decl]));
  for (const decl of types) {
    if (!declarationHasLegacyTestTag(decl) || decl.params.length !== 0) continue;
    const evaluator = new TypeEvaluator(
      typesByName,
      functionsByName,
      hostIoImports,
      consts,
      diagnostics,
      addShader,
      pluginRegistry,
      decl.span,
    );
    const locals = new Map<string, TypeEvalValue>();
    for (const stmt of decl.body.statements) {
      const value = evaluator.eval(stmt.value, locals, stmt.span);
      if (value) locals.set(stmt.name, value);
    }
    if (decl.body.expr) {
      evaluator.eval(decl.body.expr, locals, decl.body.expr.span);
    }
  }
}

function typeExprChildren(expr: TypeExpr): TypeExpr[] {
  switch (expr.kind) {
    case "type_call":
      return [expr.callee, ...expr.args];
    case "type_shape":
      return expr.shape.slots.map((slot) => slot.type);
    case "type_members":
      return [expr.target];
    case "type_match":
      return [expr.value, ...expr.arms.map((arm) => arm.value)];
    case "type_scalar_domain":
      return [];
    case "type_binary":
      return [expr.left, expr.right];
    case "type_ref":
    case "type_hole":
    case "type_static_ref":
    case "type_fn":
    case "type_bool":
    case "type_number":
    case "type_char":
    case "type_string":
    case "type_literal":
      return [];
  }
}

export function checkProgramForAnalysis(
  program: Program,
  options: CheckProgramOptions = {},
): AnalysisCheckResult {
  return checkProgramInternal(program, { recoverTypes: true, ...options });
}

function checkProgramInternal(
  program: Program,
  options: { recoverTypes: boolean } & CheckProgramOptions,
): AnalysisCheckResult {
  const diagnostics: Diagnostic[] = [];
  const trace: CheckTrace | undefined = options.trace ? { phases: [] } : undefined;
  const memo = createCheckMemo(options.cache?.inferredTypeVars);
  const pendingFunctionCheckCacheWrites: {
    cache: Map<string, FunctionCheckCacheEntry>;
    key: string;
    entry: FunctionCheckCacheEntry;
  }[] = [];
  program.resolvedTypeHoles = [];
  const compileTrace = options.compileTrace;
  const recordPhase = <T>(
    name: string,
    run: () => T,
    specialization?: SpecializationTrace,
  ): T => {
    if (!trace) return traceSync(compileTrace, `check.${name}`, run);
    return traceSync(compileTrace, `check.${name}`, () => {
      const start = performance.now();
      try {
        return run();
      } finally {
        trace.phases.push({
          name,
          ms: performance.now() - start,
          functionCount: countProgramFunctions(program),
          generatedFunctionCount: countProgramFunctions(program, true),
          callExpressionCount: countProgramCallExpressions(program),
          diagnosticCount: diagnostics.length,
          specialization,
        });
      }
    });
  };
  const pluginRegistry = createCompilerPluginRegistry(options.plugins);
  diagnostics.push(...pluginRegistry.diagnostics);
  const hasDoExpressions = programHasDoExpressions(program, options.cache?.doExpressionWork);
  const shaderManifest = new Map<number, ShaderManifestEntry>();
  const addShader = (source: string) => {
    const entry = shaderManifestEntry(source);
    shaderManifest.set(entry.id, entry);
    return entry;
  };
  const hostIoImports = new Map(program.imports.map((item) => [item.name, item.effects]));
  checkExternalImportsUseExplicitIo(program, diagnostics);
  recordPhase("checkDeclarationTags", () => checkDeclarationTags(program, diagnostics));
  if (trace) {
    recordPhase(
      "checkReservedCompilerNames",
      () => checkReservedCompilerNames(program, diagnostics),
    );
    recordPhase("checkRemovedSyntax", () => checkRemovedSyntax(program, diagnostics));
    recordPhase("checkDebugTraceStatements", () => checkDebugTraceStatements(program, diagnostics));
  } else {
    checkPreflightSyntax(program, diagnostics);
  }
  const hasInferredTypeAnnotationWork = programHasInferredTypeAnnotationWork(
    program,
    options.cache?.annotationWork,
  );
  recordPhase(
    "prepareInferredTypeAnnotations",
    () => {
      if (hasInferredTypeAnnotationWork) {
        prepareInferredTypeAnnotations(program, diagnostics);
      }
    },
  );
  recordPhase(
    "lowerDoExpressions",
    () => {
      if (hasDoExpressions) {
        lowerDoExpressions(program, diagnostics, true, program.resolvedTypeHoles);
      }
    },
  );
  recordPhase(
    "checkRuntimeFunctionDeclarations",
    () => checkRuntimeFunctionDeclarations(program, diagnostics),
  );
  recordPhase("expandFunctionMatchBodies", () => expandFunctionMatchBodies(program));
  recordPhase("checkBranchHints", () =>
    checkBranchHints(
      program,
      diagnostics,
      pluginRegistry,
      options.plugins?.length ? undefined : options.cache?.branchHintCheckedDeclarations,
    ));
  const typeDecls = recordPhase(
    "mergeTypeFragments",
    () => mergeTypeFragments(program, diagnostics),
  );
  recordPhase(
    "checkTypeFunctionCasing",
    () => checkTypeFunctionCasing(typeDecls, program, diagnostics),
  );
  let fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  const importFnDecls = program.imports.map(importAsCheckFn);
  let functions = new Set([...fnDecls, ...importFnDecls].map((decl) => decl.name));
  recordPhase(
    "checkPrimitiveDecls",
    () => checkPrimitiveDecls(fnDecls, diagnostics, pluginRegistry),
  );
  recordPhase("evaluateTypeDecls", () => evaluateTypeDecls(typeDecls, diagnostics));
  recordPhase(
    "evaluateDeclarationTagExpressions",
    () =>
      evaluateDeclarationTagExpressions(
        program,
        typeDecls,
        fnDecls,
        hostIoImports,
        new Map(),
        addShader,
        diagnostics,
        pluginRegistry,
      ),
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  recordPhase(
    "rewriteEnumMemberReferences",
    () => rewriteEnumMemberReferences(program, typeDecls, diagnostics),
  );
  recordPhase(
    "checkFunctionMatchBodyFiniteCoverage",
    () => checkFunctionMatchBodyFiniteCoverageForProgram(program, typeDecls, diagnostics),
  );
  recordPhase(
    "checkPluginRewrites",
    () =>
      checkPluginRewrites(
        program,
        diagnostics,
        { inferRuntimeType, runtimeValueTypeAssignable },
        pluginRegistry,
      ),
  );
  recordPhase(
    "checkDotQualifiedTypeMemberSyntax",
    () => checkDotQualifiedTypeMemberSyntax(typeDecls, fnDecls, diagnostics),
  );
  recordPhase(
    "attachQualifiedTypeMembers",
    () => attachQualifiedTypeMembers(typeDecls, fnDecls, diagnostics),
  );
  recordPhase(
    "lowerMemberwiseEql",
    () => lowerMemberwiseEql(program, typeDecls, diagnostics),
  );
  let constValues = recordPhase("evaluateConstDecls", () =>
    evaluateConstDecls(
      program.declarations.filter((decl): decl is ConstDecl => decl.kind === "const"),
      typeDecls,
      fnDecls,
      hostIoImports,
      addShader,
      [],
      pluginRegistry,
    ));
  recordPhase(
    "evaluateTypeTestDeclarations",
    () =>
      evaluateTypeTestDeclarations(
        typeDecls,
        fnDecls,
        hostIoImports,
        constValues,
        addShader,
        diagnostics,
        pluginRegistry,
      ),
  );
  recordPhase(
    "resolveAttachedMemberCalls #1",
    () => resolveAttachedMemberCalls(program, typeDecls),
  );
  const inferredStats1 = createSpecializationTrace();
  recordPhase(
    "specializeInferredTypeCalls #1",
    () => {
      if (hasInferredTypeSpecializationTargets(fnDecls, constValues, false, memo)) {
        specializeInferredTypeCalls(
          program,
          new Map(fnDecls.map((decl) => [decl.name, decl])),
          constValues,
          typeDecls,
          diagnostics,
          false,
          inferredStats1,
        );
      }
    },
    inferredStats1,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  recordPhase(
    "resolveAttachedMemberCalls #2",
    () => resolveAttachedMemberCalls(program, typeDecls),
  );
  const constStats1 = createSpecializationTrace();
  const needsConstSpecialization1 = programNeedsConstSpecialization(
    program,
    fnDecls,
    constValues,
    typeDecls,
    memo,
  );
  recordPhase(
    "specializeConstParamCalls #1",
    () => {
      if (needsConstSpecialization1) {
        specializeConstParamCalls(
          program,
          new Map(fnDecls.map((decl) => [decl.name, decl])),
          constValues,
          typeDecls,
          addShader,
          diagnostics,
          true,
          constStats1,
        );
      }
    },
    constStats1,
  );
  recordPhase(
    "resolveAttachedMemberCalls #3",
    () => resolveAttachedMemberCalls(program, typeDecls),
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  const inferredStats2 = createSpecializationTrace();
  recordPhase(
    "specializeInferredTypeCalls #2",
    () => {
      if (hasInferredTypeSpecializationTargets(fnDecls, constValues, true, memo)) {
        specializeInferredTypeCalls(
          program,
          new Map(fnDecls.map((decl) => [decl.name, decl])),
          constValues,
          typeDecls,
          diagnostics,
          true,
          inferredStats2,
        );
      }
    },
    inferredStats2,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  recordPhase(
    "resolveAttachedMemberCalls #4",
    () => resolveAttachedMemberCalls(program, typeDecls),
  );
  const constStats2 = createSpecializationTrace();
  const needsConstSpecialization2 = programNeedsConstSpecialization(
    program,
    fnDecls,
    constValues,
    typeDecls,
    memo,
  );
  recordPhase(
    "specializeConstParamCalls #2",
    () => {
      if (needsConstSpecialization2) {
        specializeConstParamCalls(
          program,
          new Map(fnDecls.map((decl) => [decl.name, decl])),
          constValues,
          typeDecls,
          addShader,
          diagnostics,
          false,
          constStats2,
        );
      }
    },
    constStats2,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  recordPhase(
    "resolveAttachedMemberCalls #5",
    () => resolveAttachedMemberCalls(program, typeDecls),
  );
  recordPhase(
    "lowerDoExpressions #2",
    () => {
      if (hasDoExpressions) {
        lowerDoExpressions(program, diagnostics, false, program.resolvedTypeHoles);
      }
    },
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  const inferredStats3 = createSpecializationTrace();
  recordPhase(
    "specializeInferredTypeCalls #3",
    () => {
      if (hasInferredTypeSpecializationTargets(fnDecls, constValues, true, memo)) {
        specializeInferredTypeCalls(
          program,
          new Map(fnDecls.map((decl) => [decl.name, decl])),
          constValues,
          typeDecls,
          diagnostics,
          true,
          inferredStats3,
        );
      }
    },
    inferredStats3,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  const constStats3 = createSpecializationTrace();
  const needsConstSpecialization3 = programNeedsConstSpecialization(
    program,
    fnDecls,
    constValues,
    typeDecls,
    memo,
  );
  recordPhase(
    "specializeConstParamCalls #3",
    () => {
      if (needsConstSpecialization3) {
        specializeConstParamCalls(
          program,
          new Map(fnDecls.map((decl) => [decl.name, decl])),
          constValues,
          typeDecls,
          addShader,
          diagnostics,
          false,
          constStats3,
        );
      }
    },
    constStats3,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  recordPhase(
    "resolveAttachedMemberCalls #6",
    () => resolveAttachedMemberCalls(program, typeDecls),
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  constValues = recordPhase("evaluateConstDecls #2", () =>
    evaluateConstDecls(
      program.declarations.filter((decl): decl is ConstDecl => decl.kind === "const"),
      typeDecls,
      fnDecls,
      hostIoImports,
      addShader,
      diagnostics,
      pluginRegistry,
    ));
  functions = new Set([...fnDecls, ...importFnDecls].map((decl) => decl.name));
  recordPhase("checkConstDictionaries", () =>
    checkConstDictionaries(
      program.declarations.filter((decl): decl is ConstDecl => decl.kind === "const"),
      typeDecls,
      fnDecls,
      hostIoImports,
      functions,
      diagnostics,
    ));
  recordPhase("checkTypeContracts", () =>
    checkTypeContracts(
      program,
      typeDecls,
      fnDecls,
      hostIoImports,
      constValues,
      diagnostics,
      pluginRegistry,
      options.cache,
    ));
  const needsOperatorSpecialization = programHasOperatorChains(program);
  recordPhase(
    "lowerResolvedOperators",
    () => lowerResolvedOperators(program, typeDecls, fnDecls, diagnostics, memo, options.cache),
  );
  if (needsOperatorSpecialization) {
    fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
    const operatorInferredStats = createSpecializationTrace();
    recordPhase(
      "specializeInferredTypeCalls #operators",
      () => {
        if (hasInferredTypeSpecializationTargets(fnDecls, constValues, true, memo)) {
          specializeInferredTypeCalls(
            program,
            new Map(fnDecls.map((decl) => [decl.name, decl])),
            constValues,
            typeDecls,
            diagnostics,
            true,
            operatorInferredStats,
          );
        }
      },
      operatorInferredStats,
    );
    fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
    const operatorConstStats = createSpecializationTrace();
    const needsOperatorConstSpecialization = programNeedsConstSpecialization(
      program,
      fnDecls,
      constValues,
      typeDecls,
      memo,
    );
    recordPhase(
      "specializeConstParamCalls #operators",
      () => {
        if (needsOperatorConstSpecialization) {
          specializeConstParamCalls(
            program,
            new Map(fnDecls.map((decl) => [decl.name, decl])),
            constValues,
            typeDecls,
            addShader,
            diagnostics,
            false,
            operatorConstStats,
          );
        }
      },
      operatorConstStats,
    );
    fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
    recordPhase(
      "resolveAttachedMemberCalls #operators",
      () => resolveAttachedMemberCalls(program, typeDecls),
    );
    fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  }
  recordPhase(
    "balanceAssociativeBinaryChains",
    () => balanceAssociativeBinaryChains(program, options.cache?.balancedBinaryDeclarations),
  );
  recordPhase(
    "lowerCollectorLiterals",
    () => lowerCollectorLiterals(program, typeDecls, fnDecls, diagnostics, options.cache),
  );
  recordPhase(
    "lowerProductConstructors",
    () => lowerProductConstructors(program, typeDecls, diagnostics),
  );

  recordPhase("checkFn loop", () => {
    const allFnDecls = [...fnDecls, ...importFnDecls];
    const functionMap = new Map(allFnDecls.map((decl) => [decl.name, decl]));
    const typeConstructorMap = typeDeclIndex(typeDecls).productByConstructor;
    const globalValueMap = globalRuntimeValueBindings(program, constValues, allFnDecls);
    const functionBodyCheckSet = runtimeFunctionBodyCheckSet(program, allFnDecls, functionMap);
    const functionCheckCache = options.recoverTypes ? undefined : options.cache?.functionChecks;
    const functionCheckEnvKey = functionCheckCache
      ? traceSync(
        compileTrace,
        "check.checkFn.environment_key",
        () =>
          functionCheckEnvironmentKey(
            typeDecls,
            allFnDecls,
            hostIoImports,
            globalValueMap,
            options.cache?.signatureHashes,
          ),
      )
      : undefined;
    let functionCheckCacheHits = 0;
    let functionCheckCacheMisses = 0;
    for (const decl of program.declarations) {
      if (decl.kind === "fn") {
        if (decl.public && !decl.returnType) {
          diagnostics.push({
            code: "type.public_signature",
            message: `public function ${decl.name} requires an explicit return type`,
          });
        }
        const boundaryPublic = decl.rootPublic ?? (decl.public && !decl.imported);
        if (
          boundaryPublic &&
          (typeIsRuntimeFunctionValue(decl.returnType, typeDecls) ||
            decl.params.some((param) =>
              !param.const && typeIsRuntimeFunctionValue(param.type, typeDecls)
            ))
        ) {
          diagnostics.push({
            code: "function.closure_boundary",
            message: `public function ${decl.name} cannot import or export runtime function values`,
            span: decl.span,
          });
        }
        if (!decl.generated && !decl.primitiveId && functionBodyCheckSet.has(decl.name)) {
          const cacheKey = functionCheckEnvKey
            ? functionCheckCacheKey(decl, functionCheckEnvKey, options.cache?.semanticHashes)
            : undefined;
          const cached = cacheKey ? functionCheckCache?.get(cacheKey) : undefined;
          if (cached) {
            functionCheckCacheHits++;
            Object.assign(decl, cloneCachedFnDecl(cached.fn));
            continue;
          }
          if (cacheKey) {
            functionCheckCacheMisses++;
          }
          const diagnosticCount = diagnostics.length;
          checkFn(decl, hostIoImports, diagnostics, typeDecls, allFnDecls, {
            ...options,
            memo,
            functionMap,
            typeConstructorMap,
            globalValueMap,
          });
          if (cacheKey && diagnostics.length === diagnosticCount) {
            pendingFunctionCheckCacheWrites.push({
              cache: functionCheckCache!,
              key: cacheKey,
              entry: { fn: cloneFnForCheckCacheWrite(decl) },
            });
          }
        }
      }
    }
    traceInstant(compileTrace, "check.checkFn.cache", {
      cacheHits: functionCheckCacheHits,
      cacheMisses: functionCheckCacheMisses,
    });
  });
  recordPhase(
    "resolveInferredTypeAnnotations",
    () => {
      if (hasInferredTypeAnnotationWork) {
        resolveInferredTypeAnnotations(
          program,
          typeDecls,
          [...fnDecls, ...importFnDecls],
          constValues,
          diagnostics,
          memo,
        );
      }
    },
  );
  for (let index = diagnostics.length - 1; index >= 0; index--) {
    const diagnostic = diagnostics[index];
    if (
      diagnostic?.code === "type.builder_arg" &&
      diagnostic.span === undefined &&
      diagnostic.message === "struct(...) requires one type-block shape binding"
    ) {
      diagnostics.splice(index, 1);
    } else if (
      diagnostic?.code === "type.unknown_shape_slot" &&
      diagnostic.message === "unknown shape slot <unknown>"
    ) {
      diagnostics.splice(index, 1);
    } else if (
      diagnostic?.code === "type.unknown_type_member" &&
      /type @shape_slot\(.+, Key\) does not have an empty value/.test(diagnostic.message)
    ) {
      diagnostics.splice(index, 1);
    } else if (
      diagnostic?.code === "const.static_param_arg" &&
      diagnostic.span === undefined
    ) {
      diagnostics.splice(index, 1);
    }
  }
  const hasGenericShapeNoise = diagnostics.some((diagnostic) =>
    diagnostic.code === "type.shape_builtin_arg" && diagnostic.span === undefined
  );
  if (hasGenericShapeNoise) {
    for (let index = diagnostics.length - 1; index >= 0; index--) {
      const diagnostic = diagnostics[index];
      if (
        diagnostic?.span === undefined &&
        (diagnostic.code === "type.shape_builtin_arg" ||
          (diagnostic.code === "type.require" &&
            diagnostic.message.startsWith("entity row field ")))
      ) {
        diagnostics.splice(index, 1);
      }
    }
  }
  if (diagnostics.length === 0) {
    for (const write of pendingFunctionCheckCacheWrites) {
      write.cache.set(write.key, write.entry);
    }
  }
  return {
    program,
    runtimeProgram: runtimeProgramFromProgram(program),
    diagnostics,
    shaderManifest: [...shaderManifest.values()].sort((a, b) => a.id - b.id),
    trace,
  };
}

function balanceAssociativeBinaryChains(program: Program, balanced?: WeakSet<object>) {
  const balanceableOps = new Set(["+", "*", "&&", "||"]);
  if (!balanceableOps.size) return;

  const mapExprArray = (items: Expr[]): Expr[] => {
    let changed = false;
    const mapped = items.map((item) => {
      const next = lowerExpr(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? mapped : items;
  };

  const lowerExpr = (expr: Expr): Expr => {
    switch (expr.kind) {
      case "const_fn": {
        const body = lowerExpr(expr.body);
        return body === expr.body ? expr : { ...expr, body };
      }
      case "call": {
        const callee = lowerExpr(expr.callee);
        const args = mapExprArray(expr.args);
        return callee === expr.callee && args === expr.args ? expr : { ...expr, callee, args };
      }
      case "index": {
        const target = lowerExpr(expr.target);
        const index = lowerExpr(expr.index);
        return target === expr.target && index === expr.index ? expr : { ...expr, target, index };
      }
      case "binary": {
        if (balanceableOps.has(expr.op)) {
          const leaves = collectBinaryChainLeaves(expr, expr.op, lowerExpr);
          const balanced = leaves.length > 8
            ? buildBalancedBinaryChain(expr.op, leaves)
            : buildLeftBinaryChain(expr.op, leaves, expr);
          return balanced === expr ? expr : balanced;
        }
        const left = lowerExpr(expr.left);
        const right = lowerExpr(expr.right);
        return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
      }
      case "operator_chain": {
        const first = lowerExpr(expr.first);
        let restChanged = false;
        const rest = expr.rest.map((item) => {
          const value = lowerExpr(item.value);
          if (value !== item.value) restChanged = true;
          return value === item.value ? item : { ...item, value };
        });
        return first === expr.first && !restChanged ? expr : { ...expr, first, rest };
      }
      case "pipe_bind": {
        const value = lowerExpr(expr.value);
        const body = lowerExpr(expr.body);
        return value === expr.value && body === expr.body ? expr : { ...expr, value, body };
      }
      case "profile": {
        const args = mapExprArray(expr.args);
        const body = lowerExpr(expr.body);
        return args === expr.args && body === expr.body ? expr : { ...expr, args, body };
      }
      case "match": {
        const value = lowerExpr(expr.value);
        let armsChanged = false;
        const arms = expr.arms.map((arm) => {
          const guard = arm.guard ? lowerExpr(arm.guard) : undefined;
          const armValue = lowerExpr(arm.value);
          if (guard !== arm.guard || armValue !== arm.value) armsChanged = true;
          return guard === arm.guard && armValue === arm.value
            ? arm
            : { ...arm, ...(guard ? { guard } : {}), value: armValue };
        });
        return value === expr.value && !armsChanged ? expr : { ...expr, value, arms };
      }
      case "shape":
      case "product_constructor": {
        let slotsChanged = false;
        const slots = expr.slots.map((slot) => {
          const index = slot.index ? lowerExpr(slot.index) : undefined;
          const value = lowerExpr(slot.value);
          if (index !== slot.index || value !== slot.value) slotsChanged = true;
          return index === slot.index && value === slot.value ? slot : { ...slot, index, value };
        });
        return slotsChanged ? { ...expr, slots } : expr;
      }
      case "static_for_slots": {
        let source = expr.source;
        if (expr.source.kind === "range") {
          const start = lowerExpr(expr.source.start);
          const end = lowerExpr(expr.source.end);
          if (start !== expr.source.start || end !== expr.source.end) {
            source = { kind: "range", start, end };
          }
        } else {
          const shape = lowerExpr(expr.source.shape);
          if (shape !== expr.source.shape) source = { kind: "shape", shape };
        }
        const value = lowerExpr(expr.value);
        return source === expr.source && value === expr.value ? expr : { ...expr, source, value };
      }
      case "field": {
        const value = lowerExpr(expr.value);
        const key = lowerExpr(expr.key);
        return value === expr.value && key === expr.key ? expr : { ...expr, value, key };
      }
      case "range": {
        const start = lowerExpr(expr.start);
        const end = lowerExpr(expr.end);
        return start === expr.start && end === expr.end ? expr : { ...expr, start, end };
      }
      case "block": {
        let statementsChanged = false;
        const statements = expr.statements.map((stmt) => {
          if (stmt.kind !== "let" && stmt.kind !== "destructure_let") return stmt;
          const value = lowerExpr(stmt.value);
          if (value !== stmt.value) statementsChanged = true;
          return value === stmt.value ? stmt : { ...stmt, value } as Statement;
        });
        const blockExpr = expr.expr ? lowerExpr(expr.expr) : undefined;
        return !statementsChanged && blockExpr === expr.expr
          ? expr
          : { ...expr, statements, expr: blockExpr };
      }
      case "do":
      case "literal":
      case "var":
        return expr;
    }
  };

  for (const decl of program.declarations) {
    if (balanced?.has(decl)) continue;
    if (decl.kind === "fn") decl.body = lowerExpr(decl.body) as BlockExpr;
    else if (decl.kind === "let" || decl.kind === "const") decl.value = lowerExpr(decl.value);
    balanced?.add(decl);
  }
}

function collectBinaryChainLeaves(
  expr: Expr,
  op: string,
  lowerExpr: (expr: Expr) => Expr,
): Expr[] {
  if (expr.kind !== "binary" || expr.op !== op) return [lowerExpr(expr)];
  return [
    ...collectBinaryChainLeaves(expr.left, op, lowerExpr),
    ...collectBinaryChainLeaves(expr.right, op, lowerExpr),
  ];
}

function buildLeftBinaryChain(op: string, leaves: Expr[], fallback: Expr): Expr {
  const [head, ...tail] = leaves;
  if (!head) return fallback;
  return tail.reduce<Expr>((left, right) => ({
    kind: "binary",
    op,
    left,
    right,
    span: joinExprSpans(left, right),
  }), head);
}

function buildBalancedBinaryChain(op: string, leaves: Expr[]): Expr {
  if (leaves.length === 1) return leaves[0]!;
  const mid = Math.floor(leaves.length / 2);
  const left = buildBalancedBinaryChain(op, leaves.slice(0, mid));
  const right = buildBalancedBinaryChain(op, leaves.slice(mid));
  return {
    kind: "binary",
    op,
    left,
    right,
    span: joinExprSpans(left, right),
  };
}

function joinExprSpans(left: Expr, right: Expr): Span | undefined {
  const leftSpan = exprDiagnosticSpan(left);
  const rightSpan = exprDiagnosticSpan(right);
  if (!leftSpan || !rightSpan) return leftSpan ?? rightSpan;
  return {
    ...leftSpan,
    start: Math.min(leftSpan.start, rightSpan.start),
    end: Math.max(leftSpan.end, rightSpan.end),
  };
}

function createSpecializationTrace(): SpecializationTrace {
  return { visitedCalls: 0, generatedSpecializations: 0, cacheHits: 0, cacheMisses: 0 };
}

function createCheckMemo(
  cachedTypeVarsByFunction?: WeakMap<object, InferredTypeVarCacheEntry>,
): CheckMemo {
  return {
    typeMatches: new Map(),
    runtimeType: new Map(),
    exprBindingType: new Map(),
    staticConstValue: new Map(),
    callCheck: new Map(),
    typeVarsByFunction: new WeakMap(),
    cachedTypeVarsByFunction,
  };
}

function functionCheckEnvironmentKey(
  types: TypeDecl[],
  functions: FnDecl[],
  hostIoImports: Map<string, unknown>,
  globalValues?: Map<string, OwnershipBinding>,
  signatureHashes?: WeakMap<object, string>,
): string {
  let hash = 0x811c9dc5;
  hash = hashUpdateString(hash, "types:");
  for (const decl of types) {
    hash = hashUpdateString(
      hashUpdateString(hash, ","),
      cachedSignatureHash(decl, signatureHashes),
    );
  }
  hash = hashUpdateString(hash, ";functions:[");
  for (const decl of functions) {
    hash = hashUpdateString(
      hashUpdateString(hash, ","),
      cachedFunctionSignatureHash(decl, signatureHashes),
    );
  }
  hash = hashUpdateString(hash, "];imports:");
  hash = hashSemanticValue(hash, [...hostIoImports.entries()]);
  hash = hashUpdateString(hash, ";globals:");
  hash = hashUpdateString(hash, ownershipEnvKey(globalValues ?? new Map()));
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function typeContractEnvironmentKey(
  types: TypeDecl[],
  functions: FnDecl[],
  hostIoImports: Map<string, unknown>,
  consts: Map<string, ConstValue>,
  signatureHashes?: WeakMap<object, string>,
): string {
  let hash = 0x811c9dc5;
  hash = hashUpdateString(
    hash,
    functionCheckEnvironmentKey(types, functions, hostIoImports, undefined, signatureHashes),
  );
  hash = hashUpdateString(hash, ";consts:");
  hash = hashSemanticValue(hash, [...consts.entries()]);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function typeContractDeclarationCacheKey(
  decl: Declaration,
  environmentKey: string,
  semanticHashes?: WeakMap<object, string>,
): string {
  const sourceId = decl.span?.sourceId ?? decl.nameSpan?.sourceId ?? "<unknown>";
  const name = "name" in decl ? decl.name : "<anonymous>";
  return `type_contract\0${sourceId}\0${decl.kind}\0${name}\0${environmentKey}\0${
    stableSemanticHash(decl, semanticHashes)
  }`;
}

function cachedSignatureHash(decl: TypeDecl, cache?: WeakMap<object, string>): string {
  const cached = cache?.get(decl);
  if (cached) return cached;
  const hash = stableSemanticHash(decl);
  cache?.set(decl, hash);
  return hash;
}

function cachedFunctionSignatureHash(decl: FnDecl, cache?: WeakMap<object, string>): string {
  const cached = cache?.get(decl);
  if (cached) return cached;
  const hash = functionSignatureHash(decl);
  cache?.set(decl, hash);
  return hash;
}

function functionSignatureHash(decl: FnDecl): string {
  let hash = 0x811c9dc5;
  hash = hashUpdateString(hash, "{name:");
  hash = hashUpdateString(hash, decl.name);
  hash = hashUpdateString(hash, ";params:[");
  for (const param of decl.params) {
    hash = hashUpdateString(hash, "{name:");
    hash = hashUpdateString(hash, param.name);
    hash = hashUpdateString(hash, ";type:");
    hash = hashUpdateString(hash, param.type);
    hash = hashUpdateString(hash, ";const:");
    hash = hashUpdateString(hash, param.const ? "1" : "0");
    hash = hashUpdateString(hash, ";infer:");
    hash = hashUpdateString(hash, param.inferStaticType ? "1" : "0");
    hash = hashUpdateString(hash, "}");
  }
  hash = hashUpdateString(hash, "];return:");
  hash = hashUpdateString(hash, decl.returnType ?? "");
  hash = hashUpdateString(hash, ";effects:");
  hash = hashSemanticValue(hash, decl.effects ?? []);
  hash = hashUpdateString(hash, ";public:");
  hash = hashUpdateString(hash, decl.public ? "1" : "0");
  hash = hashUpdateString(hash, ";imported:");
  hash = hashUpdateString(hash, decl.imported ? "1" : "0");
  hash = hashUpdateString(hash, ";generated:");
  hash = hashUpdateString(hash, decl.generated ? "1" : "0");
  hash = hashUpdateString(hash, "}");
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function functionCheckCacheKey(
  decl: FnDecl,
  environmentKey: string,
  semanticHashes?: WeakMap<object, string>,
): string {
  const sourceId = decl.span?.sourceId ?? decl.nameSpan?.sourceId ?? "<unknown>";
  return `fn_check\0${sourceId}\0${decl.name}\0${environmentKey}\0${
    stableSemanticHash(decl, semanticHashes)
  }`;
}

function cloneCachedFnDecl(fn: FnDecl): FnDecl {
  return {
    ...fn,
    memberOf: fn.memberOf ? { ...fn.memberOf } : undefined,
    params: clonePlainValue(fn.params) as FnDecl["params"],
    locals: fn.locals ? clonePlainValue(fn.locals) as FnDecl["locals"] : undefined,
    effects: [...fn.effects],
    returnTypeHoles: fn.returnTypeHoles
      ? clonePlainValue(fn.returnTypeHoles) as FnDecl["returnTypeHoles"]
      : undefined,
    body: fn.body,
  };
}

function cloneFnForCheckCacheWrite(fn: FnDecl): FnDecl {
  return clonePlainValue(fn) as FnDecl;
}

function clonePlainValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clonePlainValue);
  const clone: Record<string, unknown> = {};
  const source = value as Record<string, unknown>;
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    clone[key] = clonePlainValue(source[key]);
  }
  return clone;
}

function stableSemanticHash(value: unknown, cache?: WeakMap<object, string>): string {
  if (value && typeof value === "object") {
    const cached = cache?.get(value);
    if (cached) return cached;
  }
  const hash = (hashSemanticValue(0x811c9dc5, value) >>> 0).toString(16).padStart(8, "0");
  if (value && typeof value === "object") {
    cache?.set(value, hash);
  }
  return hash;
}

function hashSemanticValue(hash: number, value: unknown): number {
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
      hash = hashSemanticValue(hashUpdateString(hash, ","), item);
    }
    return hashUpdateString(hash, "]");
  }
  hash = hashUpdateString(hash, "{");
  const object = value as Record<string, unknown>;
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    const child = object[key];
    if (isSemanticMetadataKey(key) || child === undefined) continue;
    hash = hashUpdateString(hashUpdateString(hash, key), ":");
    hash = hashSemanticValue(hash, child);
    hash = hashUpdateString(hash, ";");
  }
  return hashUpdateString(hash, "}");
}

function isSemanticMetadataKey(key: string): boolean {
  return key === "span" || key === "nameSpan" || key === "typeSpan" ||
    key === "returnTypeSpan" || key === "typeHoles" || key === "returnTypeHoles" ||
    key === "inferredType" || key === "slotTypes";
}

function hashUpdateString(hash: number, text: string): number {
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

function hasInferredTypeSpecializationTargets(
  functions: FnDecl[],
  consts: Map<string, ConstValue>,
  includeGenerated: boolean,
  memo?: CheckMemo,
): boolean {
  return functions.some((decl) =>
    (includeGenerated || !decl.generated) && fnUsesInferredTypeVars(decl, consts, memo)
  );
}

function programNeedsConstSpecialization(
  program: Program,
  functions: FnDecl[],
  consts: Map<string, ConstValue>,
  types: TypeDecl[],
  memo?: CheckMemo,
): boolean {
  if (
    functions.some((decl) =>
      decl.params.some((param) => param.const) || fnUsesInferredTypeVars(decl, consts, memo)
    )
  ) {
    return true;
  }
  return programHasConstFnExpressions(program) ||
    programHasRuntimeFunctionValueTypes(program, types);
}

function programHasConstFnExpressions(program: Program): boolean {
  return programHasExpr(program, (expr) => expr.kind === "const_fn");
}

function programHasRuntimeFunctionValueTypes(program: Program, types: TypeDecl[]): boolean {
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      if (typeIsRuntimeFunctionValue(decl.returnType, types)) return true;
      if (
        decl.params.some((param) => !param.const && typeIsRuntimeFunctionValue(param.type, types))
      ) {
        return true;
      }
    } else if (decl.kind === "let" || decl.kind === "const") {
      if (typeIsRuntimeFunctionValue(explicitTypeAnnotation(decl.type), types)) return true;
    }
  }
  return false;
}

function countProgramFunctions(program: Program, generatedOnly = false): number {
  return program.declarations.filter((decl) =>
    decl.kind === "fn" && (!generatedOnly || decl.generated)
  ).length;
}

function countProgramCallExpressions(program: Program): number {
  let total = 0;
  const visit = (expr: Expr | undefined) => {
    if (!expr) return;
    if (expr.kind === "call") total++;
    for (const child of exprChildValues(expr)) visit(child);
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") visit(decl.body);
    else if (decl.kind === "const" || decl.kind === "let") visit(decl.value);
  }
  return total;
}

function lowerDoExpressions(
  program: Program,
  diagnostics: Diagnostic[],
  deferUntyped = false,
  resolvedTypeHoles: ResolvedTypeHole[] = [],
) {
  const fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  const importFnDecls = program.imports.map(importAsCheckFn);
  const allFnDecls = [...fnDecls, ...importFnDecls];
  const typeDecls = program.declarations.filter((decl): decl is TypeDecl => decl.kind === "type");
  const functionNames = new Set(
    allFnDecls.map((decl) => decl.name),
  );
  const functions = new Map(allFnDecls.map((decl) => [decl.name, decl]));
  const lowerExpr = (
    expr: Expr,
    env: Map<string, string> = new Map(),
    expectedType?: string,
    currentFn?: FnDecl,
  ): Expr => {
    switch (expr.kind) {
      case "do":
        recordTypeExprHoleMatches(expr.strategy.effect, expectedType, resolvedTypeHoles);
        return lowerDoExpression(
          expr,
          diagnostics,
          (child) => lowerExpr(child, env, undefined, currentFn),
          functionNames,
          env,
          typeDecls,
          allFnDecls,
          deferUntyped,
          resolvedTypeHoles,
          currentFn?.name,
        );
      case "const_fn":
        return { ...expr, body: lowerExpr(expr.body, env, undefined, currentFn) };
      case "call":
        return {
          ...expr,
          callee: lowerExpr(expr.callee, env, undefined, currentFn),
          args: expr.args.map((arg) => lowerExpr(arg, env, undefined, currentFn)),
        };
      case "index":
        return {
          ...expr,
          target: lowerExpr(expr.target, env, undefined, currentFn),
          index: lowerExpr(expr.index, env, undefined, currentFn),
        };
      case "binary":
        return {
          ...expr,
          left: lowerExpr(expr.left, env, undefined, currentFn),
          right: lowerExpr(expr.right, env, undefined, currentFn),
        };
      case "operator_chain":
        return {
          ...expr,
          first: lowerExpr(expr.first, env, undefined, currentFn),
          rest: expr.rest.map((item) => ({
            ...item,
            value: lowerExpr(item.value, env, undefined, currentFn),
          })),
        };
      case "pipe_bind": {
        return {
          ...expr,
          value: lowerExpr(expr.value, env, undefined, currentFn),
          body: lowerExpr(expr.body, env, undefined, currentFn),
        };
      }
      case "profile":
        return {
          ...expr,
          args: expr.args.map((arg) => lowerExpr(arg, env, undefined, currentFn)),
          body: lowerExpr(expr.body, env, expectedType, currentFn),
        };
      case "match":
        return {
          ...expr,
          value: lowerExpr(expr.value, env, undefined, currentFn),
          arms: expr.arms.map((arm) => ({
            ...arm,
            ...(arm.guard ? { guard: lowerExpr(arm.guard, env, undefined, currentFn) } : {}),
            value: lowerExpr(arm.value, env, expectedType, currentFn),
          })),
        };
      case "shape":
      case "product_constructor":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({
            ...slot,
            index: slot.index ? lowerExpr(slot.index, env, undefined, currentFn) : undefined,
            value: lowerExpr(slot.value, env, undefined, currentFn),
          })),
        };
      case "static_for_slots":
        return {
          ...expr,
          source: expr.source.kind === "range"
            ? {
              kind: "range",
              start: lowerExpr(expr.source.start, env, undefined, currentFn),
              end: lowerExpr(expr.source.end, env, undefined, currentFn),
            }
            : { kind: "shape", shape: lowerExpr(expr.source.shape, env, undefined, currentFn) },
          value: lowerExpr(expr.value, env, undefined, currentFn),
        };
      case "field":
        return {
          ...expr,
          value: lowerExpr(expr.value, env, undefined, currentFn),
          key: lowerExpr(expr.key, env, undefined, currentFn),
        };
      case "range":
        return {
          ...expr,
          start: lowerExpr(expr.start, env, undefined, currentFn),
          end: lowerExpr(expr.end, env, undefined, currentFn),
        };
      case "profile":
        return {
          ...expr,
          args: expr.args.map((arg) => lowerExpr(arg, env, undefined, currentFn)),
          body: lowerExpr(expr.body, env, undefined, currentFn),
        };
      case "block": {
        const scoped = new Map(env);
        const statements = expr.statements.map((stmt) => {
          if (stmt.kind === "let") {
            const explicit = explicitTypeAnnotation(stmt.type);
            const value = lowerExpr(stmt.value, scoped, explicit, currentFn);
            const type = explicit ??
              exprBindingType(value, ownershipEnvFromTypes(scoped), typeDecls, allFnDecls);
            if (type) scoped.set(stmt.name, type);
            return { ...stmt, value } as Statement;
          }
          if (stmt.kind === "destructure_let") {
            return {
              ...stmt,
              value: lowerExpr(stmt.value, scoped, undefined, currentFn),
            } as Statement;
          }
          if (stmt.kind === "debug_trace") {
            return {
              ...stmt,
              args: stmt.args.map((arg) => lowerExpr(arg, scoped, undefined, currentFn)),
            } as Statement;
          }
          return stmt;
        });
        return {
          ...expr,
          statements,
          expr: expr.expr ? lowerExpr(expr.expr, scoped, expectedType, currentFn) : undefined,
        };
      }
      case "literal":
      case "var":
        return expr;
    }
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      decl.body = lowerExpr(
        decl.body,
        new Map(
        decl.params.filter((param) => !param.const).map((param) => [param.name, param.type]),
      ),
      decl.returnType,
      decl,
    ) as BlockExpr;
    } else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = lowerExpr(decl.value, new Map(), explicitTypeAnnotation(decl.type));
    }
  }
}

function lowerDoExpression(
  expr: Extract<Expr, { kind: "do" }>,
  diagnostics: Diagnostic[],
  lowerExpr: (expr: Expr) => Expr,
  functionNames?: Set<string>,
  env: Map<string, string> = new Map(),
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
  deferUntyped = false,
  resolvedTypeHoles: ResolvedTypeHole[] = [],
  tailRecTarget?: string,
): Expr {
  const proofEffect = renderTypeExpr(expr.strategy.effect);
  const effect = doRuntimeEffectName(
    expr.strategy.effect,
    expr.strategy.name,
    functionNames,
    types,
    functions,
  ) ?? proofEffect;
  const strategy = expr.strategy.name;
  if (!functionNames && types.length === 0 && functions.length === 0) {
    return mapDoExpressionChildren(expr, lowerExpr);
  }
  if (strategy === "io") {
    return lowerIoDoExpression(expr, diagnostics, lowerExpr, env, types, functions);
  }
  if (strategy !== "monad" && strategy !== "applicative") {
    diagnostics.push({
      code: "do.unknown_strategy",
      message: `unknown do strategy @${strategy}`,
      span: expr.strategy.span,
    });
    return expr.expr
      ? lowerExpr(expr.expr)
      : { kind: "literal", literalKind: "number", value: "0" };
  }
  validateDoStrategyType(
    expr.strategy.effect,
    strategy,
    types,
    functionNames,
    functions,
    diagnostics,
    expr.strategy.span,
  );
  validateDoStrategyEvidence(
    expr.strategy.effect,
    effect,
    strategy,
    functionNames,
    types,
    functions,
    diagnostics,
    expr.span,
  );
  validateDoStatementLocals(expr.statements, diagnostics);
  if (
    strategy === "monad" &&
    expr.strategy.effect.kind === "type_call" &&
    expr.strategy.effect.args.length >= 2 &&
    expr.strategy.effect.args[0]?.kind === "type_hole" &&
    expr.statements.some((stmt) => stmt.kind === "do_expr")
  ) {
    diagnostics.push({
      code: "do.state_type_hole",
      message: "state-threaded do requires a concrete first strategy argument; use State(World, _)",
      span: expr.strategy.effect.args[0].span ?? expr.strategy.span,
    });
  }
  const lowerDoChild = (child: Expr, shadowed = new Set<string>()) =>
    lowerExpr(rewriteDoEffectOperations(child, effect, shadowed));
  let loweredStatements: DoStatement[] = [];
  let shadowedDoNames = new Set<string>();
  for (const stmt of expr.statements) {
    if (stmt.kind === "do_bind") {
      loweredStatements.push({ ...stmt, value: lowerDoChild(stmt.value, shadowedDoNames) });
      shadowedDoNames = shadowNames(shadowedDoNames, [stmt.name]);
    } else if (stmt.kind === "do_expr") {
      loweredStatements.push({ ...stmt, value: lowerDoChild(stmt.value, shadowedDoNames) });
    } else if (stmt.kind === "let") {
      loweredStatements.push({ ...stmt, value: lowerDoChild(stmt.value, shadowedDoNames) });
      shadowedDoNames = shadowNames(shadowedDoNames, [stmt.name]);
    } else if (stmt.kind === "destructure_let") {
      loweredStatements.push({ ...stmt, value: lowerDoChild(stmt.value, shadowedDoNames) });
      shadowedDoNames = shadowNames(shadowedDoNames, stmt.names);
    } else if (stmt.kind === "debug_trace") {
      loweredStatements.push({
        ...stmt,
        args: stmt.args.map((arg) => lowerDoChild(arg, shadowedDoNames)),
      });
    } else {
      loweredStatements.push(stmt);
    }
  }
  const state = stateDoContext(expr.strategy.effect, strategy, functionNames, env, types);
  if (state) {
    const finalIsEffectOperation = expr.expr && isDoEffectOperationCall(expr.expr, effect);
    const stateStatements: DoStatement[] = expr.expr && !finalIsEffectOperation
      ? [...loweredStatements, {
        kind: "do_expr",
        value: lowerDoChild(expr.expr, shadowedDoNames),
        span: expr.expr.span,
      }]
      : loweredStatements;
    return withDoStrategyProof(
      expr.strategy.effect,
      strategy,
      stateMonadicDo(
        effect,
        state.name,
        stateStatements,
        finalIsEffectOperation ? lowerDoChild(expr.expr!, shadowedDoNames) : undefined,
        0,
        tailRecTarget,
      ),
      types,
    );
  }
  const trailingExprStmt = !expr.expr && loweredStatements.at(-1)?.kind === "do_expr"
    ? loweredStatements.at(-1) as Extract<DoStatement, { kind: "do_expr" }>
    : undefined;
  if (trailingExprStmt) loweredStatements = loweredStatements.slice(0, -1);
  if (!expr.expr) {
    if (!trailingExprStmt) {
      diagnostics.push({
        code: "do.missing_final_expr",
        message: "do block requires a final expression",
        span: expr.span,
      });
      return { kind: "literal", literalKind: "number", value: "0", span: expr.span };
    }
  }
  const finalExpr = trailingExprStmt?.value ?? lowerDoChild(expr.expr!, shadowedDoNames);
  if (strategy === "applicative") {
    validateApplicativeDoDependencies(loweredStatements, diagnostics);
    return withDoStrategyProof(
      expr.strategy.effect,
      strategy,
      applicativeDo(effect, loweredStatements, finalExpr, diagnostics, expr.span),
      types,
    );
  }
  return withDoStrategyProof(
    expr.strategy.effect,
    strategy,
    monadicDo(effect, loweredStatements, finalExpr, tailRecTarget),
    types,
  );
}

function mapDoExpressionChildren(
  expr: Extract<Expr, { kind: "do" }>,
  lowerExpr: (expr: Expr) => Expr,
): Expr {
  return {
    ...expr,
    statements: expr.statements.map((stmt): DoStatement => {
      if (
        stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
        stmt.kind === "destructure_let"
      ) {
        return { ...stmt, value: lowerExpr(stmt.value) };
      }
      if (stmt.kind === "debug_trace") {
        return { ...stmt, args: stmt.args.map(lowerExpr) };
      }
      return stmt;
    }),
    expr: expr.expr ? lowerExpr(expr.expr) : undefined,
  };
}

function lowerIoDoExpression(
  expr: Extract<Expr, { kind: "do" }>,
  diagnostics: Diagnostic[],
  lowerExpr: (expr: Expr) => Expr,
  env: Map<string, string>,
  types: TypeDecl[],
  functions: FnDecl[],
): Expr {
  validateDoStatementLocals(expr.statements, diagnostics);
  if (!expr.strategy.hasEffect) {
    diagnostics.push({
      code: "do.io_strategy_arity",
      message: "IO do requires a value type argument; use do @io(_)",
      span: expr.strategy.span,
    });
  }
  const expectedReturnType = expr.strategy.hasEffect
    ? validateIoDoStrategyType(expr.strategy.effect, diagnostics, expr.strategy.span)
    : undefined;
  if (!expr.expr) {
    diagnostics.push({
      code: "do.io_return",
      message: "do @io(...) requires a final io(T) expression",
      span: expr.span,
    });
    return { kind: "literal", literalKind: "number", value: "0" };
  }
  const scoped = new Map(env);
  const statements: Statement[] = [];
  let discardIndex = 0;
  for (const stmt of expr.statements) {
    if (stmt.kind === "do_bind") {
      const value = lowerExpr(stmt.value);
      const actionType = exprBindingType(value, ownershipEnvFromTypes(scoped), types, functions);
      const itemType = ioActionItemType(actionType);
      if (!itemType) {
        diagnostics.push({
          code: "do.io_bind_action",
          message: "<- in do @io(...) requires an io(T) action",
          span: stmt.span,
        });
      }
      const type = itemType ?? "i32";
      statements.push({ kind: "let", name: stmt.name, type, value, span: stmt.span });
      scoped.set(stmt.name, type);
      continue;
    }
    if (stmt.kind === "do_expr") {
      const value = lowerExpr(stmt.value);
      const actionType = exprBindingType(value, ownershipEnvFromTypes(scoped), types, functions);
      const itemType = ioActionItemType(actionType);
      if (!itemType) {
        diagnostics.push({
          code: "do.io_expr_action",
          message: "expression statements in do @io(...) must be io(T) actions",
          span: stmt.span,
        });
      }
      statements.push({
        kind: "let",
        name: `__io${discardIndex++}`,
        type: itemType ?? "i32",
        value,
        span: stmt.span,
      });
      continue;
    }
    if (stmt.kind === "let") {
      const value = lowerExpr(stmt.value);
      const type = explicitTypeAnnotation(stmt.type) ??
        exprBindingType(value, ownershipEnvFromTypes(scoped), types, functions);
      if (type) scoped.set(stmt.name, type);
      statements.push({
        ...stmt,
        value,
        ...(type && !explicitTypeAnnotation(stmt.type) ? { type } : {}),
      });
      continue;
    }
    if (stmt.kind === "destructure_let") {
      statements.push({ ...stmt, value: lowerExpr(stmt.value) });
      continue;
    }
    if (stmt.kind === "debug_trace") {
      statements.push({ ...stmt, args: stmt.args.map(lowerExpr) });
      continue;
    }
    statements.push(stmt);
  }
  const finalAction = lowerExpr(expr.expr);
  const finalActionType = exprBindingType(
    finalAction,
    ownershipEnvFromTypes(scoped),
    types,
    functions,
  );
  const actualReturnType = ioActionItemType(finalActionType);
  if (!actualReturnType) {
    diagnostics.push({
      code: "do.io_return",
      message: "do @io(...) final expression must be io(T); use return(value)",
      span: expr.expr.span ?? expr.span,
    });
  }
  if (
    expectedReturnType && actualReturnType && !typeMatches(expectedReturnType, actualReturnType)
  ) {
    diagnostics.push({
      code: "do.io_return_type",
      message: `do @io(${expectedReturnType}) final return has type ${actualReturnType}`,
      span: expr.expr.span,
    });
  }
  const returnValue = unwrapIoReturnAction(finalAction);
  return {
    kind: "block",
    span: expr.span,
    statements,
    expr: returnValue,
  };
}

function isIoReturnCall(expr: Expr): boolean {
  return expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === "return";
}

function unwrapIoReturnAction(expr: Expr): Expr {
  return isIoReturnCall(expr) && expr.kind === "call" && expr.args.length === 1
    ? expr.args[0]!
    : expr;
}

function validateIoDoStrategyType(
  effect: TypeExpr,
  diagnostics: Diagnostic[],
  span?: Span,
): string | undefined {
  if (effect.kind === "type_hole") return undefined;
  if (typeExprContainsHole(effect)) {
    diagnostics.push({
      code: "do.io_strategy_type",
      message: "type holes are only allowed as the direct do @io(_) argument",
      span: effect.span ?? span,
    });
    return undefined;
  }
  const rendered = renderTypeExpr(effect);
  if (rendered === "io" || rendered.startsWith("io(")) {
    diagnostics.push({
      code: "do.io_strategy_type",
      message: "do @io(T) expects the carried value type T, not io or io(T)",
      span: effect.span ?? span,
    });
    return undefined;
  }
  return rendered;
}

function ownershipEnvFromTypes(env: Map<string, string>): Map<string, OwnershipBinding> {
  return new Map([...env].map(([name, type]) => [name, { moved: false, type }]));
}

function globalRuntimeValueBindings(
  program: Program,
  consts: Map<string, ConstValue>,
  functions: FnDecl[],
): Map<string, OwnershipBinding> {
  const globals = new Map<string, OwnershipBinding>();
  const functionMap = new Map<string, FnDecl>();
  for (const fn of functions) {
    functionMap.set(fn.name, fn);
  }
  for (const decl of program.declarations) {
    if (decl.kind !== "let" && decl.kind !== "const") continue;
    let type = explicitTypeAnnotation(decl.type);
    if (!type) {
      type = constValueRuntimeType(consts.get(decl.name), functionMap);
    }
    if (!type) {
      type = literalRuntimeType(decl.value);
    }
    if (!type && decl.value.kind === "var") {
      type = functionValueType(functionMap.get(decl.value.name));
    }
    globals.set(decl.name, { moved: false, type });
  }
  return globals;
}

function runtimeFunctionBodyCheckSet(
  program: Program,
  functions: FnDecl[],
  functionMap: Map<string, FnDecl>,
): Set<string> {
  const check = new Set<string>();
  const queue: FnDecl[] = [];
  const enqueue = (fn: FnDecl | undefined) => {
    if (!fn) return;
    if (check.has(fn.name)) return;
    check.add(fn.name);
    queue.push(fn);
  };
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") continue;
    if (decl.imported) continue;
    enqueue(decl);
  }
  while (queue.length) {
    const fn = queue.shift();
    if (!fn) continue;
    const refs = new Set<string>();
    collectBlockRefs(fn.body, refs, new Set(fn.params.map((param) => param.name)));
    for (const ref of refs) {
      enqueue(functionDeclForName(ref, functions, { recoverTypes: false, functionMap }));
    }
  }
  return check;
}

function constValueRuntimeType(
  value: ConstValue | undefined,
  functions: Map<string, FnDecl>,
): string | undefined {
  if (!value) return undefined;
  if (value.type) return value.type;
  if (value.kind === "number") return "i32";
  if (value.kind === "bool") return "bool";
  if (value.kind === "string") return "string";
  if (value.kind === "fn") return functionValueType(functions.get(value.name));
  return undefined;
}

function functionValueType(fn: FnDecl | undefined): string | undefined {
  if (!fn) return undefined;
  if (!fn.returnType) return undefined;
  const params: string[] = [];
  for (const param of fn.params) {
    if (param.const) return undefined;
    params.push(`${param.name}: ${param.type}`);
  }
  return `fn(${params.join(", ")}) -> ${fn.returnType}`;
}

function validateDoStrategyEvidence(
  effect: TypeExpr,
  runtimeEffect: string,
  strategy: string,
  functionNames: Set<string> | undefined,
  types: TypeDecl[],
  functions: FnDecl[],
  diagnostics: Diagnostic[],
  span?: Span,
) {
  if (!functionNames) return;
  const required = strategy === "monad" ? ["bind", "pure"] : ["map", "pure", "apply"];
  const missing = required.filter((member) =>
    !hasDoEffectMember(functionNames, runtimeEffect, member, types, functions)
  );
  if (!missing.length) return;
  const contract = strategy === "monad" ? "Monad" : "Applicative";
  diagnostics.push({
    code: "do.missing_strategy_proof",
    message: `@${strategy} do requires @assert(${contract}(${renderTypeExpr(effect)})): missing ${
      missing.map((member) => `${runtimeEffect}::${member}`).join(", ")
    }`,
    span,
  });
}

function validateDoStrategyType(
  effect: TypeExpr,
  strategy: string,
  types: TypeDecl[],
  functionNames: Set<string> | undefined,
  functions: FnDecl[],
  diagnostics: Diagnostic[],
  span?: Span,
) {
  if (effect.kind !== "type_call") {
    diagnostics.push({
      code: "do.strategy_type",
      message:
        `@${strategy} strategy must name the effect at its declared arity, for example Option(_) or State(World, _)`,
      span,
    });
    return;
  }
  if (typeExprContainsHole(effect.callee)) {
    diagnostics.push({
      code: "do.strategy_type",
      message: `@${strategy} strategy hole cannot be used as the effect constructor`,
      span: effect.callee.span ?? span,
    });
    return;
  }
  const nestedHole = effect.args.find((arg) =>
    arg.kind !== "type_hole" && typeExprContainsHole(arg)
  );
  if (nestedHole) {
    diagnostics.push({
      code: "do.strategy_type",
      message: "type holes are only allowed as direct do-strategy type arguments",
      span: nestedHole.span ?? span,
    });
  }
  const effectName = renderTypeExpr(effect.callee);
  const decl = findTypeDeclByName(types, effectName);
  if (!decl) {
    const member = strategy === "applicative" ? "map" : "bind";
    if (!hasDoEffectMember(functionNames, effectName, member, types, functions)) {
      diagnostics.push({
        code: "do.strategy_type",
        message: `unknown @${strategy} strategy effect ${effectName}`,
        span: effect.callee.span ?? span,
      });
    }
    return;
  }
  if (effect.args.length !== decl.params.length) {
    diagnostics.push({
      code: "do.strategy_arity",
      message: `@${strategy} strategy ${effectName} expects ${decl.params.length} type argument${
        decl.params.length === 1 ? "" : "s"
      }, got ${effect.args.length}; use _ for inferred value positions`,
      span,
    });
  }
}

function doRuntimeEffectName(
  effect: TypeExpr,
  strategy: string,
  functionNames?: Set<string>,
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
): string | undefined {
  if (effect.kind !== "type_call") return undefined;
  const callee = renderTypeExpr(effect.callee);
  const member = strategy === "applicative" ? "map" : "bind";
  if (hasDoEffectMember(functionNames, callee, member, types, functions)) return callee;
  if (findTypeDeclByName(types, callee)) return callee;
  return undefined;
}

function hasDoEffectMember(
  functionNames: Set<string> | undefined,
  effectName: string,
  member: string,
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
): boolean {
  return doEffectMemberTarget(functionNames, effectName, member, types, functions) !== undefined;
}

function doEffectMemberTarget(
  functionNames: Set<string> | undefined,
  effectName: string,
  member: string,
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
): string | undefined {
  if (!functionNames) return undefined;
  const candidates = doEffectOwnerCandidates(effectName);
  for (const candidate of candidates) {
    const direct = `${candidate}::${member}`;
    if (functionNames.has(direct)) return direct;
  }
  for (const fn of functions) {
    if (fn.memberOf?.member !== member) continue;
    if (candidates.includes(fn.memberOf.owner) && functionNames.has(fn.name)) return fn.name;
  }
  for (const candidate of candidates) {
    const decl = findTypeDeclByName(types, typeNameOf(candidate));
    const found = decl ? typeFragmentMembers(decl).find((item) => item.name === member) : undefined;
    if (found && functionNames.has(found.target)) return found.target;
    const normalized = decl?.normalized;
    const members = normalized?.kind === "product" || normalized?.kind === "sum"
      ? normalized.members ?? []
      : [];
    const normalizedMember = members.find((item) => item.name === member);
    if (normalizedMember && functionNames.has(normalizedMember.target)) {
      return normalizedMember.target;
    }
  }
  return undefined;
}

function doEffectOwnerCandidates(effectName: string): string[] {
  const candidates: string[] = [];
  const push = (candidate: string | undefined) => {
    if (!candidate) return;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };
  push(effectName);
  const stripped = stripDoEffectTypeArgs(effectName);
  push(stripped);
  for (const candidate of [...candidates]) {
    push(typeNameOf(candidate));
  }
  for (const candidate of [...candidates]) {
    push(terminalName(candidate));
  }
  return candidates;
}

function stripDoEffectTypeArgs(effectName: string): string {
  const index = effectName.indexOf("(");
  if (index < 0) return effectName;
  return effectName.slice(0, index);
}

function findTypeDeclByName(types: TypeDecl[], name: string): TypeDecl | undefined {
  return findTypeDecl(types, name);
}

function typeExprContainsHole(expr: TypeExpr): boolean {
  switch (expr.kind) {
    case "type_hole":
      return true;
    case "type_call":
      return typeExprContainsHole(expr.callee) || expr.args.some(typeExprContainsHole);
    case "type_shape":
      return expr.shape.slots.some((slot) => typeExprContainsHole(slot.type));
    case "type_members":
      return typeExprContainsHole(expr.target);
    case "type_match":
      return typeExprContainsHole(expr.value) ||
        expr.arms.some((arm) => typeExprContainsHole(arm.value));
    case "type_scalar_domain":
      return false;
    case "type_binary":
      return typeExprContainsHole(expr.left) || typeExprContainsHole(expr.right);
    default:
      return false;
  }
}

function recordTypeExprHoleMatches(
  pattern: TypeExpr,
  actualSource: string | undefined,
  resolved: ResolvedTypeHole[],
) {
  if (!actualSource || !typeExprContainsHole(pattern)) return;
  const actual = parseAnnotationType(actualSource);
  if (!actual) return;
  const visit = (left: TypeExpr, right: TypeExpr): boolean => {
    if (left.kind === "type_hole") {
      const replacement = renderTypeExpr(right);
      if (left.span && !typeHasFreeInferredVars(replacement)) {
        resolved.push({ span: left.span, replacement });
      }
      return true;
    }
    if (left.kind === "type_call" && right.kind === "type_call") {
      if (renderTypeExpr(left.callee) !== renderTypeExpr(right.callee)) return false;
      if (left.args.length !== right.args.length) return false;
      return left.args.every((arg, index) => visit(arg, right.args[index]!));
    }
    return renderTypeExpr(left) === renderTypeExpr(right);
  };
  visit(pattern, actual);
}

function recordStrategyTypeHoleResolutions(
  pattern: TypeExpr,
  actual: string | undefined,
  resolved: ResolvedTypeHole[],
) {
  if (!actual || !typeExprContainsHole(pattern)) return;
  const patternText = renderTypeExpr(pattern);
  const holeSpans = new Map<string, Span>();
  const rewritten = replaceTypeExprHolesWithVariables(pattern, holeSpans);
  const reverse = new Map([...holeSpans].map(([variable, span]) => [variable, span]));
  const inferred = new Map<string, string>();
  bindTypePattern(rewritten, actual, inferred);
  for (const [variable, replacement] of inferred) {
    const span = reverse.get(variable);
    if (!span || typeHasFreeInferredVars(replacement)) continue;
    resolved.push({ span, replacement });
  }
  if (pattern.kind === "type_hole" && pattern.span && !typeHasFreeInferredVars(actual)) {
    resolved.push({ span: pattern.span, replacement: actual });
  }
  if (patternText === "_") return;
}

function replaceTypeExprHolesWithVariables(
  expr: TypeExpr,
  bindings: Map<string, Span>,
): string {
  if (expr.kind === "type_hole") {
    const span = expr.span;
    const variable = span
      ? `inferred_type_hole_${span.start}_${span.end}`
      : `inferred_type_hole_${bindings.size}`;
    if (span) bindings.set(variable, span);
    return variable;
  }
  if (expr.kind === "type_call") {
    return `${replaceTypeExprHolesWithVariables(expr.callee, bindings)}(${
      expr.args.map((arg) => replaceTypeExprHolesWithVariables(arg, bindings)).join(", ")
    })`;
  }
  if (expr.kind === "type_shape") {
    return renderShape({
      ...expr.shape,
      slots: expr.shape.slots.map((slot) => ({
        ...slot,
        type: parseAnnotationType(replaceTypeExprHolesWithVariables(slot.type, bindings)) ??
          slot.type,
      })),
    });
  }
  if (expr.kind === "type_members") {
    return `members(${replaceTypeExprHolesWithVariables(expr.target, bindings)})`;
  }
  return renderTypeExpr(expr);
}

function strategyValuePatternType(
  pattern: TypeExpr,
  valueType: string | undefined,
): string | undefined {
  if (!valueType || pattern.kind !== "type_call") return valueType;
  return `${renderTypeExpr(pattern.callee)}(${
    pattern.args.map((arg) => arg.kind === "type_hole" ? valueType : renderTypeExpr(arg)).join(", ")
  })`;
}

function doPureValueType(
  expr: Expr,
  env: Map<string, string>,
  types: TypeDecl[],
  functions: FnDecl[],
): string | undefined {
  if (expr.kind !== "call" || expr.args.length !== 1) return undefined;
  const callee = expr.callee.kind === "var" ? expr.callee.name : undefined;
  if (!callee || (callee !== "pure" && !callee.endsWith("::pure") && !callee.endsWith(".pure"))) {
    return undefined;
  }
  return exprBindingType(expr.args[0]!, ownershipEnvFromTypes(env), types, functions);
}

function stateDoContext(
  _effect: TypeExpr,
  _strategy: string,
  _functionNames: Set<string> | undefined,
  _env: Map<string, string>,
  _types: TypeDecl[] = [],
): { name: string; type: string } | undefined {
  return undefined;
}

const DO_EFFECT_OPERATION_NAMES = new Set(["pure", "bind", "map", "apply"]);

function rewriteDoEffectOperations(
  expr: Expr,
  effect: string,
  shadowed = new Set<string>(),
): Expr {
  switch (expr.kind) {
    case "var":
      return isUnqualifiedDoEffectOperation(expr.name) && !shadowed.has(expr.name)
        ? { ...expr, name: `${effect}::${expr.name}` }
        : expr;
    case "call":
      return {
        ...expr,
        callee: rewriteDoEffectOperations(expr.callee, effect, shadowed),
        args: expr.args.map((arg) => rewriteDoEffectOperations(arg, effect, shadowed)),
      };
    case "const_fn":
      return {
        ...expr,
        body: rewriteDoEffectOperations(expr.body, effect, shadowNames(shadowed, expr.params)),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: rewriteDoEffectOperations(expr.value, effect, shadowed),
        body: rewriteDoEffectOperations(expr.body, effect, shadowNames(shadowed, [expr.name])),
      };
    case "index":
      return {
        ...expr,
        target: rewriteDoEffectOperations(expr.target, effect, shadowed),
        index: rewriteDoEffectOperations(expr.index, effect, shadowed),
      };
    case "binary":
      return {
        ...expr,
        left: rewriteDoEffectOperations(expr.left, effect, shadowed),
        right: rewriteDoEffectOperations(expr.right, effect, shadowed),
      };
    case "operator_chain":
      return {
        ...expr,
        first: rewriteDoEffectOperations(expr.first, effect, shadowed),
        rest: expr.rest.map((item) => ({
          ...item,
          value: rewriteDoEffectOperations(item.value, effect, shadowed),
        })),
      };
    case "match":
      return {
        ...expr,
        value: rewriteDoEffectOperations(expr.value, effect, shadowed),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: rewriteDoEffectOperations(
            arm.value,
            effect,
            shadowNames(shadowed, patternBindingNames(arm.pattern)),
          ),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index ? rewriteDoEffectOperations(slot.index, effect, shadowed) : undefined,
          value: rewriteDoEffectOperations(slot.value, effect, shadowed),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: expr.source.kind === "range"
          ? {
            kind: "range",
            start: rewriteDoEffectOperations(expr.source.start, effect, shadowed),
            end: rewriteDoEffectOperations(expr.source.end, effect, shadowed),
          }
          : {
            kind: "shape",
            shape: rewriteDoEffectOperations(expr.source.shape, effect, shadowed),
          },
        value: rewriteDoEffectOperations(
          expr.value,
          effect,
          shadowNames(
            shadowed,
            [expr.iterator, expr.valueIterator].filter((name): name is string => !!name),
          ),
        ),
      };
    case "field":
      return {
        ...expr,
        value: rewriteDoEffectOperations(expr.value, effect, shadowed),
      };
    case "range":
      return {
        ...expr,
        start: rewriteDoEffectOperations(expr.start, effect, shadowed),
        end: rewriteDoEffectOperations(expr.end, effect, shadowed),
      };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => rewriteDoEffectOperations(arg, effect, shadowed)),
        body: rewriteDoEffectOperations(expr.body, effect, shadowed),
      };
    case "block": {
      let scoped = new Set(shadowed);
      const statements = expr.statements.map((stmt) => {
        if (stmt.kind === "let") {
          const value = rewriteDoEffectOperations(stmt.value, effect, scoped);
          scoped = shadowNames(scoped, [stmt.name]);
          return { ...stmt, value } as Statement;
        }
        if (stmt.kind === "destructure_let") {
          const value = rewriteDoEffectOperations(stmt.value, effect, scoped);
          scoped = shadowNames(scoped, stmt.names);
          return { ...stmt, value } as Statement;
        }
        return stmt;
      });
      return {
        ...expr,
        statements,
        expr: expr.expr ? rewriteDoEffectOperations(expr.expr, effect, scoped) : undefined,
      };
    }
    case "do":
    case "literal":
      return expr;
  }
}

function isDoEffectOperationCall(expr: Expr, effect: string): boolean {
  if (expr.kind !== "call" || expr.callee.kind !== "var") return false;
  const name = expr.callee.name;
  if (isUnqualifiedDoEffectOperation(name)) return true;
  return name.startsWith(`${effect}::`) &&
    DO_EFFECT_OPERATION_NAMES.has(name.slice(effect.length + 2));
}

function isUnqualifiedDoEffectOperation(name: string): boolean {
  return !name.includes("::") && !name.includes(".") && DO_EFFECT_OPERATION_NAMES.has(name);
}

function shadowNames(shadowed: Set<string>, names: string[]): Set<string> {
  const next = new Set(shadowed);
  for (const name of names) next.add(name);
  return next;
}

function stateMonadicDo(
  effect: string,
  stateName: string,
  statements: DoStatement[],
  finalExpr: Expr | undefined,
  depth = 0,
  tailRecTarget?: string,
): Expr {
  const [head, ...tail] = statements;
  if (!head) {
    const result = finalExpr ?? callExpr(`${effect}::pure`, [{ kind: "var", name: stateName }]);
    return annotateTailRecTarget(result, tailRecTarget);
  }
  if (head.kind === "do_bind" || head.kind === "do_expr") {
    const nextStateName = head.kind === "do_bind" ? head.name : `__state${depth}`;
    const body = stateMonadicDo(effect, nextStateName, tail, finalExpr, depth + 1, tailRecTarget);
    return callExpr(`${effect}::bind`, [
      injectStateArgument(head.value, stateName),
      {
        kind: "const_fn",
        params: [nextStateName],
        body,
        allowCaptures: true,
        ...(tailRecTarget ? { tailRecTarget } : {}),
      },
    ]);
  }
  return {
    kind: "block",
    statements: [head],
    expr: stateMonadicDo(effect, stateName, tail, finalExpr, depth, tailRecTarget),
  };
}

function annotateTailRecTarget(expr: Expr, target: string | undefined): Expr {
  if (!target) return expr;
  const annotateStatement = (stmt: DoStatement): DoStatement => {
    if (
      stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
      stmt.kind === "destructure_let"
    ) {
      return { ...stmt, value: annotateTailRecTarget(stmt.value, target) };
    }
    if (stmt.kind === "debug_trace") {
      return { ...stmt, args: stmt.args.map((arg) => annotateTailRecTarget(arg, target)) };
    }
    return stmt;
  };
  switch (expr.kind) {
    case "do":
      return {
        ...expr,
        statements: expr.statements.map(annotateStatement),
        expr: expr.expr ? annotateTailRecTarget(expr.expr, target) : undefined,
      };
    case "const_fn":
      return { ...expr, body: annotateTailRecTarget(expr.body, target) };
    case "call": {
      const args = expr.args.map((arg) => annotateTailRecTarget(arg, target));
      if (expr.tailRec) {
        return { ...expr, args, tailRecTarget: expr.tailRecTarget ?? target };
      }
      return {
        ...expr,
        callee: annotateTailRecTarget(expr.callee, target),
        args,
      };
    }
    case "index":
      return {
        ...expr,
        target: annotateTailRecTarget(expr.target, target),
        index: annotateTailRecTarget(expr.index, target),
      };
    case "binary":
      return {
        ...expr,
        left: annotateTailRecTarget(expr.left, target),
        right: annotateTailRecTarget(expr.right, target),
      };
    case "operator_chain":
      return {
        ...expr,
        first: annotateTailRecTarget(expr.first, target),
        rest: expr.rest.map((item) => ({
          ...item,
          value: annotateTailRecTarget(item.value, target),
        })),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: annotateTailRecTarget(expr.value, target),
        body: annotateTailRecTarget(expr.body, target),
      };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => annotateTailRecTarget(arg, target)),
        body: annotateTailRecTarget(expr.body, target),
      };
    case "match":
      return {
        ...expr,
        value: annotateTailRecTarget(expr.value, target),
        arms: expr.arms.map((arm) => ({
          ...arm,
          ...(arm.guard ? { guard: annotateTailRecTarget(arm.guard, target) } : {}),
          value: annotateTailRecTarget(arm.value, target),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index ? annotateTailRecTarget(slot.index, target) : undefined,
          value: annotateTailRecTarget(slot.value, target),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: expr.source.kind === "range"
          ? {
            kind: "range",
            start: annotateTailRecTarget(expr.source.start, target),
            end: annotateTailRecTarget(expr.source.end, target),
          }
          : { kind: "shape", shape: annotateTailRecTarget(expr.source.shape, target) },
        value: annotateTailRecTarget(expr.value, target),
      };
    case "field":
      return {
        ...expr,
        value: annotateTailRecTarget(expr.value, target),
        key: annotateTailRecTarget(expr.key, target),
      };
    case "range":
      return {
        ...expr,
        start: annotateTailRecTarget(expr.start, target),
        end: annotateTailRecTarget(expr.end, target),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map(annotateStatement) as Statement[],
        expr: expr.expr ? annotateTailRecTarget(expr.expr, target) : undefined,
      };
    case "literal":
    case "var":
      return expr;
  }
}

function injectStateArgument(expr: Expr, stateName: string): Expr {
  if (expr.kind !== "call") return expr;
  return {
    ...expr,
    args: [{ kind: "var", name: stateName }, ...expr.args],
  };
}

function withDoStrategyProof(
  effect: TypeExpr,
  strategy: string,
  expr: Expr,
  types: TypeDecl[] = [],
): Expr {
  const proofEffect = doStrategyProofEffect(effect);
  if (!proofEffect || !needsDoStrategyProof(proofEffect, types)) return expr;
  const contractName = strategy === "monad" ? "Monad" : "Applicative";
  const contractDecl = findTypeDeclByName(types, contractName);
  if (!contractDecl) return expr;
  const proofValue = {
    kind: "type_call" as const,
    callee: { kind: "type_ref" as const, name: contractDecl.name },
    args: [proofEffect],
  };
  return {
    kind: "block",
    statements: [{
      kind: "type_assert",
      value: proofValue,
    }],
    expr,
  };
}

function doStrategyProofEffect(effect: TypeExpr): TypeExpr | undefined {
  if (!typeExprContainsHole(effect)) return effect;
  if (
    effect.kind === "type_call" && effect.args.length === 1 && effect.args[0]?.kind === "type_hole"
  ) {
    return effect.callee;
  }
  return undefined;
}

function needsDoStrategyProof(effect: TypeExpr, types: TypeDecl[]): boolean {
  if (effect.kind !== "type_call") return true;
  const callee = renderTypeExpr(effect.callee);
  const decl = findTypeDeclByName(types, callee);
  return decl ? effect.args.length >= decl.params.length : false;
}

function monadicDo(
  effect: string,
  statements: DoStatement[],
  finalExpr: Expr,
  tailRecTarget?: string,
): Expr {
  const [head, ...tail] = statements;
  if (!head) return annotateTailRecTarget(finalExpr, tailRecTarget);
  if (head.kind === "do_bind") {
    const body = monadicDo(effect, tail, finalExpr, tailRecTarget);
    return callExpr(`${effect}::bind`, [
      head.value,
      {
        kind: "const_fn",
        params: [head.name],
        body,
        allowCaptures: true,
        ...(tailRecTarget ? { tailRecTarget } : {}),
      },
    ]);
  }
  if (head.kind === "do_expr") {
    const body = monadicDo(effect, tail, finalExpr, tailRecTarget);
    return callExpr(`${effect}::bind`, [
      head.value,
      {
        kind: "const_fn",
        params: ["_"],
        body,
        allowCaptures: true,
        ...(tailRecTarget ? { tailRecTarget } : {}),
      },
    ]);
  }
  return {
    kind: "block",
    statements: [head],
    expr: monadicDo(effect, tail, finalExpr, tailRecTarget),
  };
}

function validateApplicativeDoDependencies(
  statements: DoStatement[],
  diagnostics: Diagnostic[],
) {
  const derived = new Set<string>();
  for (const stmt of statements) {
    if (stmt.kind === "do_bind" || stmt.kind === "do_expr") {
      const refs = new Set<string>();
      collectExprRefs(stmt.value, refs, new Set());
      const dependency = firstSetIntersection(refs, derived);
      if (dependency) {
        diagnostics.push({
          code: "do.applicative_dependency",
          message:
            `@applicative action cannot depend on previous applicative binding ${dependency}`,
          span: stmt.span,
        });
      }
      if (stmt.kind === "do_bind") derived.add(stmt.name);
      continue;
    }
    if (stmt.kind === "let" || stmt.kind === "destructure_let") {
      const refs = new Set<string>();
      collectExprRefs(stmt.value, refs, new Set());
      if (firstSetIntersection(refs, derived)) {
        for (const name of doBoundNames(stmt)) derived.add(name);
      }
    }
  }
}

function applicativeDo(
  effect: string,
  statements: DoStatement[],
  finalExpr: Expr,
  diagnostics: Diagnostic[],
  span?: Span,
): Expr {
  const analysis = applicativeDoAnalysis(statements);
  const pureValue = applicativePureValue(finalExpr, effect);
  let finalValue = pureValue;
  const actions = [...analysis.actions];
  if (!actions.length) return blockWithStatements(analysis.outerStatements, finalExpr);
  if (!finalValue) {
    const refs = new Set<string>();
    collectExprRefs(finalExpr, refs, new Set());
    const dependency = firstSetIntersection(refs, analysis.derivedNames);
    if (dependency) {
      diagnostics.push({
        code: "do.applicative_return",
        message:
          `@applicative final expression depends on ${dependency}; wrap the return value with pure(...)`,
        span: finalExpr.span ?? span,
      });
      return blockWithStatements(analysis.outerStatements, finalExpr);
    }
    const name = freshApplicativeName("__do_applicative_final", statements, finalExpr);
    actions.push({ name, value: finalExpr });
    finalValue = { kind: "var", name };
  }
  const body: Expr = analysis.innerStatements.length
    ? { kind: "block", statements: analysis.innerStatements, expr: finalValue }
    : finalValue;
  const lowered = applicativeActionChain(effect, actions, body);
  return analysis.outerStatements.length
    ? { kind: "block", statements: analysis.outerStatements, expr: lowered }
    : lowered;
}

function blockWithStatements(statements: Statement[], expr: Expr): Expr {
  return statements.length ? { kind: "block", statements, expr } : expr;
}

function applicativeDoAnalysis(statements: DoStatement[]): {
  actions: { name: string; value: Expr }[];
  outerStatements: Statement[];
  innerStatements: Statement[];
  derivedNames: Set<string>;
} {
  const actions: { name: string; value: Expr }[] = [];
  const outerStatements: Statement[] = [];
  const innerStatements: Statement[] = [];
  const derivedNames = new Set<string>();
  let discardIndex = 0;
  for (const stmt of statements) {
    if (stmt.kind === "do_bind") {
      actions.push({ name: stmt.name, value: stmt.value });
      derivedNames.add(stmt.name);
      continue;
    }
    if (stmt.kind === "do_expr") {
      actions.push({ name: `__do_applicative_discard${discardIndex++}`, value: stmt.value });
      continue;
    }
    if (stmt.kind === "let" || stmt.kind === "destructure_let") {
      const refs = new Set<string>();
      collectExprRefs(stmt.value, refs, new Set());
      if (firstSetIntersection(refs, derivedNames)) {
        innerStatements.push(stmt);
        for (const name of doBoundNames(stmt)) derivedNames.add(name);
      } else {
        outerStatements.push(stmt);
      }
      continue;
    }
    outerStatements.push(stmt);
  }
  return { actions, outerStatements, innerStatements, derivedNames };
}

function applicativePureValue(expr: Expr, effect: string): Expr | undefined {
  if (expr.kind !== "call" || expr.args.length !== 1 || expr.callee.kind !== "var") {
    return undefined;
  }
  const name = expr.callee.name;
  if (name === "pure" || name === `${effect}::pure` || name === `${effect}.pure`) {
    return expr.args[0];
  }
  return undefined;
}

function applicativeActionChain(
  effect: string,
  actions: { name: string; value: Expr }[],
  body: Expr,
): Expr {
  const [first, ...rest] = actions;
  if (!first) return body;
  let combined = callExpr(`${effect}::map`, [
    curriedConstFn(actions.map((action) => action.name), body),
    first.value,
  ]);
  for (const action of rest) {
    combined = callExpr(`${effect}::apply`, [combined, action.value]);
  }
  return combined;
}

function curriedConstFn(params: string[], body: Expr): Expr {
  const [head, ...tail] = params;
  if (!head) return body;
  return {
    kind: "const_fn",
    params: [head],
    body: curriedConstFn(tail, body),
    allowCaptures: true,
  };
}

function firstSetIntersection(left: Set<string>, right: Set<string>): string | undefined {
  for (const value of left) {
    if (right.has(value)) return value;
  }
  return undefined;
}

function freshApplicativeName(prefix: string, statements: DoStatement[], finalExpr: Expr): string {
  const used = new Set<string>();
  for (const stmt of statements) {
    for (const name of doBoundNames(stmt)) used.add(name);
    if (stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let") {
      collectExprRefs(stmt.value, used, new Set());
    } else if (stmt.kind === "destructure_let") {
      collectExprRefs(stmt.value, used, new Set());
    }
  }
  collectExprRefs(finalExpr, used, new Set());
  let name = prefix;
  let index = 0;
  while (used.has(name)) name = `${prefix}${++index}`;
  return name;
}

function callExpr(name: string, args: Expr[]): Expr {
  return { kind: "call", callee: { kind: "var", name }, args };
}

function exprChildValues(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "do":
      return [
        ...expr.statements.flatMap((stmt) =>
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
            ? [stmt.value]
            : []
        ),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "const_fn":
      return [expr.body];
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
    case "profile":
      return [...expr.args, expr.body];
    case "match":
      return [
        expr.value,
        ...expr.arms.flatMap((arm) => arm.guard ? [arm.guard, arm.value] : [arm.value]),
      ];
    case "shape":
    case "product_constructor":
      return expr.slots.map((slot) => slot.value);
    case "static_for_slots":
      return [
        expr.value,
        ...(expr.source.kind === "range"
          ? [expr.source.start, expr.source.end]
          : [expr.source.shape]),
      ];
    case "field":
      return [expr.value, expr.key];
    case "range":
      return [expr.start, expr.end];
    case "block":
    case "literal":
    case "var":
      return [];
  }
}

function structuralExprKey(expr: Expr): string | undefined {
  switch (expr.kind) {
    case "literal":
      return `lit:${expr.literalKind}:${expr.value}:${expr.inferredType ?? ""}`;
    case "var":
      return `var:${expr.name}`;
    case "call": {
      if (expr.tailRec) {
        const args = expr.args.map(structuralExprKey);
        if (args.some((arg) => !arg)) return undefined;
        return `rec:${expr.tailRecTarget ?? ""}(${args.join(",")})`;
      }
      const callee = structuralExprKey(expr.callee);
      if (!callee) return undefined;
      const args = expr.args.map(structuralExprKey);
      if (args.some((arg) => !arg)) return undefined;
      return `call(${callee};${args.join(",")})`;
    }
    case "binary": {
      const left = structuralExprKey(expr.left);
      const right = structuralExprKey(expr.right);
      return left && right ? `bin:${expr.op}(${left},${right})` : undefined;
    }
    case "operator_chain": {
      const first = structuralExprKey(expr.first);
      const rest = expr.rest.map((item) => {
        const value = structuralExprKey(item.value);
        return value ? `${item.op}:${value}` : undefined;
      });
      return first && rest.every(Boolean) ? `opchain(${first};${rest.join(",")})` : undefined;
    }
    case "product_constructor":
    case "shape": {
      const slots = expr.slots.map((slot) => {
        const value = structuralExprKey(slot.value);
        const index = slot.index ? structuralExprKey(slot.index) : "";
        return value && index !== undefined
          ? `${slot.label ?? ""}:${slot.spread ? "..." : ""}${index}=${value}`
          : undefined;
      });
      if (slots.some((slot) => !slot)) return undefined;
      return expr.kind === "product_constructor"
        ? `ctor:${expr.constructor}{${slots.join(",")}}`
        : `shape:${expr.syntax ?? ""}{${slots.join(",")}}`;
    }
    case "field": {
      const value = structuralExprKey(expr.value);
      const key = structuralExprKey(expr.key);
      return value && key ? `field(${value},${key})` : undefined;
    }
    case "range": {
      const start = structuralExprKey(expr.start);
      const end = structuralExprKey(expr.end);
      return start && end ? `range(${start},${end})` : undefined;
    }
    case "index": {
      const target = structuralExprKey(expr.target);
      const index = structuralExprKey(expr.index);
      return target && index ? `index(${target},${index})` : undefined;
    }
    case "pipe_bind":
    case "match":
    case "block":
    case "static_for_slots":
    case "const_fn":
    case "do":
      return undefined;
  }
}

function stringEnvKey(env: Map<string, string>): string {
  return [...env].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\0");
}

function ownershipEnvKey(env: Map<string, OwnershipBinding>): string {
  return [...env].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, binding]) => `${name}=${binding.type ?? ""}:${binding.moved ? 1 : 0}`)
    .join("\0");
}

function constEnvKey(env: Map<string, ConstValue>): string {
  return [...env].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${constValueKey(value)}`)
    .join("\0");
}

function checkPrimitiveDecls(
  fnDecls: FnDecl[],
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
) {
  const ids = new Map<string, string>();
  for (const decl of fnDecls) {
    const directWrapperId = directCompilerCallId(decl);
    const id = decl.primitiveId ?? directWrapperId;
    if (!id) continue;
    if (!isKnownIntrinsicId(id, pluginRegistry)) {
      diagnostics.push({
        code: "primitive.unknown",
        message: `unknown compiler intrinsic ${id} on function ${decl.name}`,
      });
      continue;
    }
    const previous = ids.get(id);
    if (previous) {
      diagnostics.push({
        code: "primitive.duplicate",
        message: `compiler intrinsic ${id} is declared by both ${previous} and ${decl.name}`,
      });
    } else {
      ids.set(id, decl.name);
    }
  }
}

function lowerResolvedOperators(
  program: Program,
  typeDecls: TypeDecl[],
  fnDecls: FnDecl[],
  diagnostics: Diagnostic[],
  memo?: CheckMemo,
  cache?: CheckCache,
) {
  const operators = program.declarations.filter((decl): decl is OperatorDecl =>
    decl.kind === "operator"
  );
  checkOperatorDeclarationConflicts(operators, diagnostics);
  if (!operators.length && !programHasOperatorChains(program)) return;
  const loweredDeclarations = operators.length
    ? undefined
    : cache?.builtinOperatorLoweredDeclarations;
  const operatorBySymbol = new Map(operators.map((decl) => [decl.symbol, decl]));
  const functions = new Map(fnDecls.map((fn) => [fn.name, fn]));
  const constructorTypes = new Map(
    typeDecls.flatMap((decl) =>
      decl.normalized?.kind === "product" ? [[decl.normalized.constructor, decl] as const] : []
    ),
  );
  for (const decl of typeDecls) {
    if (decl.normalized?.kind !== "product") continue;
    const terminal = terminalName(decl.normalized.constructor);
    if (!constructorTypes.has(terminal)) constructorTypes.set(terminal, decl);
  }

  const lowerExpr = (expr: Expr, env: Map<string, string>): Expr => {
    switch (expr.kind) {
      case "operator_chain": {
        const values = [expr.first, ...expr.rest.map((item) => item.value)].map((item) =>
          lowerExpr(item, env)
        );
        const ops = expr.rest.map((item) => item.op);
        return lowerExpr(buildOperatorTree(values, ops, operatorBySymbol, diagnostics, expr), env);
      }
      case "binary": {
        const left = lowerExpr(expr.left, env);
        const right = lowerExpr(expr.right, env);
        const leftType = inferRuntimeType(left, env, functions, constructorTypes, memo);
        const rightType = inferRuntimeType(right, env, functions, constructorTypes, memo);
        const unresolved = left === expr.left && right === expr.right
          ? expr
          : { ...expr, left, right };
        if (!leftType && !rightType) return unresolved;
        const resolved = resolveInfixOperator(
          expr.op,
          left,
          right,
          env,
          functions,
          constructorTypes,
          typeDecls,
          operators,
          memo,
        );
        if (!resolved) {
          if (!leftType || !rightType) return unresolved;
          diagnostics.push(diagnosticAt(
            "operator.missing",
            `no visible operator declaration matches ${expr.op}` +
              ` for ${leftType ?? "unknown"} and ${rightType ?? "unknown"}`,
            expr,
          ));
          return unresolved;
        }
        if (resolved === "ambiguous") {
          diagnostics.push({
            code: "operator.ambiguous",
            message: `multiple visible operator declarations match ${expr.op}`,
          });
          return unresolved;
        }
        return { kind: "call", callee: { kind: "var", name: resolved }, args: [left, right] };
      }
      case "call": {
        const callee = lowerExpr(expr.callee, env);
        let argsChanged = false;
        const args = expr.args.map((arg) => {
          const next = lowerExpr(arg, env);
          if (next !== arg) argsChanged = true;
          return next;
        });
        return callee === expr.callee && !argsChanged ? expr : { ...expr, callee, args };
      }
      case "index": {
        const target = lowerExpr(expr.target, env);
        const index = lowerExpr(expr.index, env);
        return target === expr.target && index === expr.index ? expr : { ...expr, target, index };
      }
      case "field": {
        const value = lowerExpr(expr.value, env);
        const key = lowerExpr(expr.key, env);
        return value === expr.value && key === expr.key ? expr : { ...expr, value, key };
      }
      case "pipe_bind": {
        const value = lowerExpr(expr.value, env);
        const body = lowerExpr(expr.body, env);
        return value === expr.value && body === expr.body ? expr : { ...expr, value, body };
      }
      case "match": {
        const value = lowerExpr(expr.value, env);
        const valueType = inferRuntimeType(value, env, functions, constructorTypes, memo);
        let armsChanged = false;
        const arms = expr.arms.map((arm) => {
          const armEnv = envWithPatternBindings(arm.pattern, valueType, env, typeDecls);
          const guard = arm.guard ? lowerExpr(arm.guard, armEnv) : undefined;
          const armValue = lowerExpr(arm.value, armEnv);
          if (guard !== arm.guard || armValue !== arm.value) armsChanged = true;
          return guard === arm.guard && armValue === arm.value
            ? arm
            : { ...arm, ...(guard ? { guard } : {}), value: armValue };
        });
        return value === expr.value && !armsChanged ? expr : { ...expr, value, arms };
      }
      case "shape":
      case "product_constructor": {
        let slotsChanged = false;
        const slots = expr.slots.map((slot) => {
          const index = slot.index ? lowerExpr(slot.index, env) : undefined;
          const value = lowerExpr(slot.value, env);
          if (index !== slot.index || value !== slot.value) slotsChanged = true;
          return index === slot.index && value === slot.value ? slot : { ...slot, index, value };
        });
        return slotsChanged ? { ...expr, slots } : expr;
      }
      case "range": {
        const start = lowerExpr(expr.start, env);
        const end = lowerExpr(expr.end, env);
        return start === expr.start && end === expr.end ? expr : { ...expr, start, end };
      }
      case "profile": {
        let argsChanged = false;
        const args = expr.args.map((arg) => {
          const next = lowerExpr(arg, env);
          if (next !== arg) argsChanged = true;
          return next;
        });
        const body = lowerExpr(expr.body, env);
        return !argsChanged && body === expr.body ? expr : { ...expr, args, body };
      }
      case "static_for_slots": {
        let source = expr.source;
        if (expr.source.kind === "range") {
          const start = lowerExpr(expr.source.start, env);
          const end = lowerExpr(expr.source.end, env);
          if (start !== expr.source.start || end !== expr.source.end) {
            source = { kind: "range", start, end };
          }
        } else {
          const shape = lowerExpr(expr.source.shape, env);
          if (shape !== expr.source.shape) source = { kind: "shape", shape };
        }
        const value = lowerExpr(expr.value, env);
        return source === expr.source && value === expr.value ? expr : { ...expr, source, value };
      }
      case "const_fn": {
        const body = lowerExpr(expr.body, env);
        return body === expr.body ? expr : { ...expr, body };
      }
      case "block": {
        const scoped = new Map(env);
        let statementsChanged = false;
        const statements = expr.statements.map((stmt) => {
          if (stmt.kind !== "let" && stmt.kind !== "destructure_let") return stmt;
          const value = lowerExpr(stmt.value, scoped);
          const explicit = stmt.kind === "let" ? explicitTypeAnnotation(stmt.type) : undefined;
          const explicitIsConcrete = explicit !== undefined && !typeHasFreeInferredVars(explicit);
          if (stmt.kind === "let" && explicitIsConcrete) {
            scoped.set(stmt.name, explicit);
          } else if (stmt.kind === "let") {
            const inferred = inferRuntimeType(value, scoped, functions, undefined, memo);
            if (inferred) scoped.set(stmt.name, inferred);
          }
          if (value !== stmt.value) statementsChanged = true;
          return value === stmt.value ? stmt : { ...stmt, value } as typeof stmt;
        });
        const blockExpr = expr.expr ? lowerExpr(expr.expr, scoped) : undefined;
        return !statementsChanged && blockExpr === expr.expr
          ? expr
          : { ...expr, statements, expr: blockExpr };
      }
      default:
        return expr;
    }
  };

  for (const decl of program.declarations) {
    if (loweredDeclarations?.has(decl)) continue;
    if (decl.kind === "fn") {
      const env = new Map(decl.params.map((param) => [param.name, param.type]));
      decl.body = lowerExpr(decl.body, env) as Extract<Expr, { kind: "block" }>;
      loweredDeclarations?.add(decl);
    } else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = lowerExpr(decl.value, new Map());
      loweredDeclarations?.add(decl);
    }
  }
}

function programHasExpr(
  program: Program,
  predicate: (expr: Expr) => boolean,
  cache?: WeakMap<object, boolean>,
): boolean {
  const visitExpr = (expr: Expr | undefined): boolean => {
    if (!expr) return false;
    const cached = cache?.get(expr);
    if (cached !== undefined) return cached;
    let result = false;
    if (predicate(expr)) {
      cache?.set(expr, true);
      return true;
    }
    switch (expr.kind) {
      case "call":
        result = visitExpr(expr.callee) || expr.args.some(visitExpr);
        break;
      case "index":
        result = visitExpr(expr.target) || visitExpr(expr.index);
        break;
      case "field":
        result = visitExpr(expr.value) || visitExpr(expr.key);
        break;
      case "binary":
        result = visitExpr(expr.left) || visitExpr(expr.right);
        break;
      case "operator_chain":
        result = visitExpr(expr.first) || expr.rest.some((item) => visitExpr(item.value));
        break;
      case "pipe_bind":
        result = visitExpr(expr.value) || visitExpr(expr.body);
        break;
      case "match":
        result = visitExpr(expr.value) ||
          expr.arms.some((arm) => visitExpr(arm.guard) || visitExpr(arm.value));
        break;
      case "shape":
      case "product_constructor":
        result = expr.slots.some((slot) => visitExpr(slot.index) || visitExpr(slot.value));
        break;
      case "range":
        result = visitExpr(expr.start) || visitExpr(expr.end);
        break;
      case "profile":
        result = expr.args.some(visitExpr) || visitExpr(expr.body);
        break;
      case "static_for_slots":
        result =
          (expr.source.kind === "range"
            ? visitExpr(expr.source.start) || visitExpr(expr.source.end)
            : visitExpr(expr.source.shape)) || visitExpr(expr.value);
        break;
      case "const_fn":
        result = visitExpr(expr.body);
        break;
      case "do":
        result = expr.statements.some((stmt) => {
          if (
            stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
          ) {
            return visitExpr(stmt.value);
          }
          return stmt.kind === "debug_trace" && stmt.args.some(visitExpr);
        }) || visitExpr(expr.expr);
        break;
      case "block":
        result = expr.statements.some((stmt) => {
          if (stmt.kind === "let" || stmt.kind === "destructure_let") return visitExpr(stmt.value);
          return stmt.kind === "debug_trace" && stmt.args.some(visitExpr);
        }) || visitExpr(expr.expr);
        break;
      case "var":
      case "literal":
        result = false;
        break;
    }
    cache?.set(expr, result);
    return result;
  };
  for (const decl of program.declarations) {
    const cached = cache?.get(decl);
    if (cached !== undefined) {
      if (cached) return true;
      continue;
    }
    let result = false;
    if (decl.kind === "fn") {
      result = visitExpr(decl.body);
    } else if (decl.kind === "let" || decl.kind === "const") {
      result = visitExpr(decl.value);
    }
    cache?.set(decl, result);
    if (result) return true;
  }
  return false;
}

function programHasOperatorChains(program: Program): boolean {
  return programHasExpr(
    program,
    (expr) => expr.kind === "operator_chain" || expr.kind === "binary",
  );
}

function programHasDoExpressions(program: Program, cache?: WeakMap<object, boolean>): boolean {
  return programHasExpr(program, (expr) => expr.kind === "do", cache);
}

function checkOperatorDeclarationConflicts(
  operators: OperatorDecl[],
  diagnostics: Diagnostic[],
) {
  const bySymbol = new Map<string, OperatorDecl>();
  for (const decl of operators) {
    if (!["#infixl", "#infixr", "#infix"].includes(decl.fixity)) {
      diagnostics.push(diagnosticAt(
        "operator.fixity",
        `unsupported operator fixity ${decl.fixity}`,
        decl,
      ));
      continue;
    }
    if (!Number.isInteger(decl.precedence)) {
      diagnostics.push(diagnosticAt(
        "operator.precedence",
        `operator ${decl.symbol} precedence must be an integer`,
        decl,
      ));
      continue;
    }
    const previous = bySymbol.get(decl.symbol);
    if (!previous) {
      bySymbol.set(decl.symbol, decl);
      continue;
    }
    if (previous.fixity !== decl.fixity || previous.precedence !== decl.precedence) {
      diagnostics.push(diagnosticAt(
        "operator.conflict",
        `operator ${decl.symbol} has conflicting fixity or precedence`,
        decl,
      ));
    }
  }
}

const EMPTY_OPERATOR_MAP = new Map<string, OperatorDecl>();

function buildOperatorTree(
  values: Expr[],
  ops: string[],
  operators: Map<string, OperatorDecl>,
  diagnostics: Diagnostic[],
  source: Expr,
): Expr {
  const exprs = values.length ? [values[0]!] : [];
  const stack: string[] = [];
  const reduce = () => {
    const op = stack.pop()!;
    const right = exprs.pop()!;
    const left = exprs.pop()!;
    exprs.push({ kind: "binary", span: joinExprSpans(left, right), op, left, right });
  };
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]!;
    const meta = operatorMetadata(op, operators);
    while (stack.length) {
      const top = stack.at(-1)!;
      const topMeta = operatorMetadata(top, operators);
      if (
        topMeta.precedence > meta.precedence ||
        (topMeta.precedence === meta.precedence && meta.fixity !== "#infixr")
      ) {
        if (
          topMeta.precedence === meta.precedence &&
          (topMeta.fixity === "#infix" || meta.fixity === "#infix")
        ) {
          diagnostics.push(diagnosticAt(
            "operator.associativity",
            `operator ${op} is non-associative; add parentheses`,
            source,
          ));
        }
        reduce();
        continue;
      }
      break;
    }
    stack.push(op);
    exprs.push(values[index + 1]!);
  }
  while (stack.length) reduce();
  return exprs[0] ?? { kind: "literal", literalKind: "number", value: "0" };
}

function operatorMetadata(
  symbol: string,
  operators: Map<string, OperatorDecl>,
): Pick<OperatorDecl, "fixity" | "precedence"> {
  const declared = operators.get(symbol);
  if (declared) return declared;
  return builtinOperatorMetadata(symbol);
}

function builtinOperatorMetadata(symbol: string): Pick<OperatorDecl, "fixity" | "precedence"> {
  const table: Record<string, Pick<OperatorDecl, "fixity" | "precedence">> = {
    "||": { fixity: "#infixr", precedence: 20 },
    "^^": { fixity: "#infixr", precedence: 25 },
    "&&": { fixity: "#infixr", precedence: 30 },
    "==": { fixity: "#infix", precedence: 40 },
    "!=": { fixity: "#infix", precedence: 40 },
    "<": { fixity: "#infix", precedence: 50 },
    "<=": { fixity: "#infix", precedence: 50 },
    ">": { fixity: "#infix", precedence: 50 },
    ">=": { fixity: "#infix", precedence: 50 },
    "+": { fixity: "#infixl", precedence: 60 },
    "-": { fixity: "#infixl", precedence: 60 },
    "*": { fixity: "#infixl", precedence: 70 },
    "/": { fixity: "#infixl", precedence: 70 },
    "%": { fixity: "#infixl", precedence: 70 },
  };
  return table[symbol] ?? { fixity: "#infixl", precedence: 50 };
}

function lowerCollectorLiterals(
  program: Program,
  typeDecls: TypeDecl[],
  fnDecls: FnDecl[],
  diagnostics: Diagnostic[],
  cache?: CheckCache,
) {
  const functions = new Map(fnDecls.map((fn) => [fn.name, fn]));
  const collectorEnvKey = cache?.collectorLoweredDeclarations
    ? functionCheckEnvironmentKey(typeDecls, fnDecls, new Map(), undefined, cache.signatureHashes)
    : undefined;
  const lowerExpr = (expr: Expr, expectedType: string | undefined): Expr => {
    switch (expr.kind) {
      case "do":
        return lowerDoExpression(expr, diagnostics, (child) => lowerExpr(child, undefined));
      case "const_fn":
        return { ...expr, span: expr.span, body: lowerExpr(expr.body, undefined) };
      case "profile":
        return {
          ...expr,
          args: expr.args.map((arg) => lowerExpr(arg, undefined)),
          body: lowerExpr(expr.body, expectedType),
        };
      case "shape": {
        if (expr.syntax !== "collection") {
          const productSlots = productSlotTypes(expectedType, typeDecls, expr.slots.length);
          return {
            ...expr,
            slots: expr.slots.map((slot, index) => ({
              ...slot,
              value: lowerExpr(
                slot.value,
                slot.label
                  ? expectedShapeSlotType(expectedType, slot.label, typeDecls)
                  : productSlots?.[index],
              ),
            })),
          };
        }
        if (expr.slots.some((slot) => slot.spread || slot.index)) {
          return {
            ...expr,
            slots: expr.slots.map((slot) => ({
              ...slot,
              index: slot.index ? lowerExpr(slot.index, undefined) : undefined,
              value: lowerExpr(
                slot.value,
                slot.index ? inlineArrayLikeTypeArgs(expectedType, typeDecls)?.itemType : undefined,
              ),
            })),
          };
        }
        const inlineArray = inlineArrayLikeTypeArgs(expectedType, typeDecls);
        if (inlineArray) {
          return {
            ...expr,
            slots: expr.slots.map((slot) => ({
              ...slot,
              value: lowerExpr(slot.value, inlineArray.itemType),
            })),
          };
        }
        const compactArray = compactArrayTypeArgs(expectedType, typeDecls);
        if (compactArray) {
          if (expr.slots.length > compactArray.count) {
            diagnostics.push(diagnosticAt(
              "collection.capacity",
              `collection literal has ${expr.slots.length} items but ${expectedType} has capacity ${compactArray.count}`,
              expr,
            ));
            return {
              ...expr,
              slots: expr.slots.map((slot) => ({
                ...slot,
                value: lowerExpr(slot.value, compactArray.itemType),
              })),
            };
          }
          const memberBase = compactArrayMemberBase(expectedType, typeDecls);
          if (memberBase) {
            return buildCompactArrayLiteral(
              expr.slots.map((slot) => lowerExpr(slot.value, compactArray.itemType)),
              memberBase,
              compactArray,
            );
          }
          return {
            ...expr,
            slots: expr.slots.map((slot) => ({
              ...slot,
              value: lowerExpr(slot.value, compactArray.itemType),
            })),
          };
        }
        const anonymousProductSlots = productSlotTypes(expectedType, typeDecls, expr.slots.length);
        if (anonymousProductSlots) {
          return {
            ...expr,
            slots: expr.slots.map((slot, index) => ({
              ...slot,
              value: lowerExpr(slot.value, anonymousProductSlots[index]),
            })),
          };
        }
        if (!expectedType) {
          return {
            ...expr,
            slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value, undefined) })),
          };
        }
        const collector = resolveCollectorProtocol(
          expectedType,
          typeDecls,
          functions,
          diagnostics,
          expr,
        );
        if (!collector) {
          return {
            ...expr,
            slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value, undefined) })),
          };
        }
        return buildCollectorLiteral(
          expr.slots.map((slot) => lowerExpr(slot.value, collector.itemType)),
          collector,
        );
      }
      case "call": {
        const callee = lowerExpr(expr.callee, undefined);
        const fn = callee.kind === "var" ? functions.get(callee.name) : undefined;
        return {
          ...expr,
          callee,
          args: expr.args.map((arg, index) => lowerExpr(arg, fn?.params[index]?.type)),
        };
      }
      case "index":
        return {
          ...expr,
          target: lowerExpr(expr.target, undefined),
          index: lowerExpr(expr.index, undefined),
        };
      case "binary":
        return {
          ...expr,
          left: lowerExpr(expr.left, undefined),
          right: lowerExpr(expr.right, undefined),
        };
      case "operator_chain":
        return {
          ...expr,
          first: lowerExpr(expr.first, undefined),
          rest: expr.rest.map((item) => ({ ...item, value: lowerExpr(item.value, undefined) })),
        };
      case "pipe_bind":
        return {
          ...expr,
          value: lowerExpr(expr.value, undefined),
          body: lowerExpr(expr.body, expectedType),
        };
      case "match":
        return {
          ...expr,
          value: lowerExpr(expr.value, undefined),
          arms: expr.arms.map((arm) => ({
            ...arm,
            ...(arm.guard ? { guard: lowerExpr(arm.guard, undefined) } : {}),
            value: lowerExpr(arm.value, expectedType),
          })),
        };
      case "product_constructor":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({
            ...slot,
            value: lowerExpr(
              slot.value,
              productConstructorSlotType(expr.constructor, slot.label, typeDecls),
            ),
          })),
        };
      case "range":
        return {
          ...expr,
          start: lowerExpr(expr.start, undefined),
          end: lowerExpr(expr.end, undefined),
        };
      case "static_for_slots":
        return { ...expr, value: lowerExpr(expr.value, expectedType) };
      case "field":
        return {
          ...expr,
          value: lowerExpr(expr.value, undefined),
          key: lowerExpr(expr.key, undefined),
        };
      case "block":
        return {
          ...expr,
          statements: expr.statements.map((stmt) => {
            if (stmt.kind === "let") {
              const expected = explicitTypeAnnotation(stmt.type);
              if (!expected && stmt.value.kind === "shape" && stmt.value.syntax === "collection") {
                diagnostics.push(diagnosticAt(
                  "collection.expected_type",
                  "collection literal requires an expected target type",
                  stmt.value,
                ));
              }
              return { ...stmt, value: lowerExpr(stmt.value, expected) };
            }
            if (stmt.kind === "destructure_let") {
              return { ...stmt, value: lowerExpr(stmt.value, undefined) };
            }
            return stmt;
          }),
          expr: expr.expr ? lowerExpr(expr.expr, expectedType) : undefined,
        };
      case "literal":
      case "var":
        return expr;
    }
  };

  for (const decl of program.declarations) {
    const cachedEnvKey = cache?.collectorLoweredDeclarations?.get(decl);
    if (collectorEnvKey && cachedEnvKey === collectorEnvKey) continue;
    if (decl.kind === "fn") {
      decl.body = lowerExpr(decl.body, decl.returnType) as Extract<Expr, { kind: "block" }>;
    } else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = lowerExpr(decl.value, explicitTypeAnnotation(decl.type));
    }
    if (collectorEnvKey) cache?.collectorLoweredDeclarations?.set(decl, collectorEnvKey);
  }
}

type CollectorProtocol = {
  constArgs: Expr[];
  start: string;
  push: string;
  finish: string;
  itemType: string;
};

function resolveCollectorProtocol(
  expectedType: string,
  typeDecls: TypeDecl[],
  functions: Map<string, FnDecl>,
  diagnostics: Diagnostic[],
  spanExpr: Expr,
): CollectorProtocol | undefined {
  const sourceType = expectedType.trim();
  const resolved = resolveAliasType(expectedType, typeDecls) ?? sourceType;
  const sourceTypeName = typeNameOf(sourceType);
  const decl = findTypeDecl(typeDecls, sourceTypeName) ??
    findTypeDecl(typeDecls, typeNameOf(resolved));
  const body = decl?.normalized;
  if (!decl) {
    if (expectedType.includes(".")) return undefined;
    diagnostics.push(diagnosticAt(
      "collection.collector_missing",
      `type ${expectedType} does not define collector members`,
      spanExpr,
    ));
    return undefined;
  }
  if (body?.kind !== "product" && body?.kind !== "sum") {
    diagnostics.push(diagnosticAt(
      "collection.collector_missing",
      `type ${expectedType} does not define collector members`,
      spanExpr,
    ));
    return undefined;
  }
  const target = (name: string) => body.members?.find((member) => member.name === name)?.target;
  const start = target("collect_start");
  const push = target("collect_push");
  const finish = target("collect_finish");
  if (!start || !push || !finish) {
    diagnostics.push(diagnosticAt(
      "collection.collector_missing",
      `type ${expectedType} does not define collector members`,
      spanExpr,
    ));
    return undefined;
  }
  const startFn = functions.get(start);
  const pushFn = functions.get(push);
  const finishFn = functions.get(finish);
  if (!startFn || !pushFn || !finishFn) {
    diagnostics.push(diagnosticAt(
      "collection.collector_signature",
      `collector members for ${expectedType} must resolve to functions`,
      spanExpr,
    ));
    return undefined;
  }
  const targetArgs = typeCallArgsForBase(sourceType, sourceTypeName) ??
    typeCallArgsForBase(resolved, typeNameOf(resolved));
  const constArgValues = targetArgs === undefined ? [] : splitTypeArgs(targetArgs);
  const leadingConstCount = startFn.params.findIndex((param) => !param.const);
  const constCount = leadingConstCount < 0 ? startFn.params.length : leadingConstCount;
  const constArgs = constArgValues.slice(0, constCount).map(typeArgExpr);
  const constBindings = new Map(
    startFn.params.slice(0, constCount).map((param, index) => [param.name, constArgValues[index]]),
  );
  const instantiated = (type: string | undefined) =>
    type ? substituteSignatureTypeArgs(type, constBindings) : undefined;
  const builderType = instantiated(startFn.returnType);
  const pushRuntime = pushFn.params.slice(constCount);
  const finishRuntime = finishFn.params.slice(constCount);
  const itemType = instantiated(pushRuntime[1]?.type);
  const expectedTypeCandidates = [
    expectedType,
    expectedType.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, ""),
  ];
  if (
    !builderType ||
    constArgs.length !== constCount ||
    pushRuntime.length !== 2 ||
    finishRuntime.length !== 1 ||
    !typeMatches(builderType, instantiated(pushRuntime[0]?.type) ?? "") ||
    !typeMatches(builderType, instantiated(pushFn.returnType) ?? "") ||
    !typeMatches(builderType, instantiated(finishRuntime[0]?.type) ?? "") ||
    !expectedTypeCandidates.some((candidate) =>
      typeMatches(candidate, instantiated(finishFn.returnType) ?? "")
    ) ||
    !itemType
  ) {
    diagnostics.push(diagnosticAt(
      "collection.collector_signature",
      `collector members for ${expectedType} must have collect_start -> Builder, collect_push(builder, item) -> Builder, and collect_finish(builder) -> Target`,
      spanExpr,
    ));
    return undefined;
  }
  return { constArgs, start, push, finish, itemType };
}

function productSlotTypes(
  expectedType: string | undefined,
  typeDecls: TypeDecl[],
  arity: number,
): string[] | undefined {
  const structural = structuralProductSlotsForType(expectedType, typeDecls);
  if (structural) {
    if (structural.length !== arity) return undefined;
    return structural.map((slot) => slot.type);
  }
  const resolved = resolveAliasType(expectedType, typeDecls) ?? expectedType;
  const decl = findTypeDecl(typeDecls, typeNameOf(resolved ?? ""));
  if (decl?.normalized?.kind !== "product") return undefined;
  const slots = decl.normalized.shape.slots;
  if (slots.length !== arity) return undefined;
  const args = typeCallArgsForBase(resolved ?? "", typeNameOf(resolved ?? ""));
  const argValues = args === undefined ? [] : splitTypeArgs(args);
  const bindings = new Map(decl.params.map((param, index) => [param.name, argValues[index]]));
  return slots.map((slot) => substituteSignatureTypeArgs(slot.type, bindings));
}

interface TypeDeclIndex {
  byName: Map<string, TypeDecl>;
  byTerminalName: Map<string, TypeDecl>;
  productByConstructor: Map<string, TypeDecl>;
}

const TYPE_DECL_INDEX_CACHE = new WeakMap<TypeDecl[], TypeDeclIndex>();

function typeDeclIndex(typeDecls: TypeDecl[]): TypeDeclIndex {
  const cached = TYPE_DECL_INDEX_CACHE.get(typeDecls);
  if (
    cached &&
    (cached.productByConstructor.size ||
      !typeDecls.some((item) => item.normalized?.kind === "product"))
  ) {
    return cached;
  }
  const byName = new Map<string, TypeDecl>();
  const byTerminalName = new Map<string, TypeDecl>();
  const productByConstructor = new Map<string, TypeDecl>();
  for (const item of typeDecls) {
    byName.set(item.name, item);
    byTerminalName.set(terminalName(item.name), item);
    if (item.normalized?.kind === "product") {
      productByConstructor.set(item.normalized.constructor, item);
    }
  }
  const index = { byName, byTerminalName, productByConstructor };
  TYPE_DECL_INDEX_CACHE.set(typeDecls, index);
  return index;
}

function findTypeDecl(typeDecls: TypeDecl[], name: string): TypeDecl | undefined {
  const index = typeDeclIndex(typeDecls);
  return index.byName.get(name) ??
    (isQualifiedTypeName(name) ? undefined : index.byTerminalName.get(terminalName(name)));
}

function isQualifiedTypeName(name: string): boolean {
  return name.includes(".") || name.includes("::");
}

function substituteSignatureTypeArgs(
  type: string,
  bindings: Map<string, string | undefined>,
): string {
  let result = type;
  for (const [name, value] of bindings) {
    if (!value) continue;
    result = result.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }
  return result;
}

function typeArgExpr(source: string): Expr {
  if (/^-?\d+$/.test(source)) return { kind: "literal", literalKind: "number", value: source };
  if (source === "true" || source === "false") {
    return { kind: "literal", literalKind: "bool", value: source };
  }
  return { kind: "var", name: source };
}

function buildCollectorLiteral(items: Expr[], collector: CollectorProtocol): Expr {
  let builder: Expr = {
    kind: "call",
    callee: { kind: "var", name: collector.start },
    args: [...collector.constArgs],
  };
  for (const item of items) {
    builder = {
      kind: "call",
      callee: { kind: "var", name: collector.push },
      args: [...collector.constArgs, builder, item],
    };
  }
  return {
    kind: "call",
    callee: { kind: "var", name: collector.finish },
    args: [...collector.constArgs, builder],
  };
}

function buildCompactArrayLiteral(
  items: Expr[],
  memberBase: string,
  compactArray: { count: number; itemType: string },
): Expr {
  const namespaceEnd = memberBase.lastIndexOf(".");
  const namespace = namespaceEnd >= 0 ? `${memberBase.slice(0, namespaceEnd)}.` : "";
  const paddedItems = [
    ...items,
    ...Array.from(
      { length: compactArray.count - items.length },
      () => compactArrayZeroValue(compactArray.itemType),
    ),
  ];
  return {
    kind: "product_constructor",
    constructor: `${namespace}CompactArray`,
    slots: [
      {
        label: "items",
        value: {
          kind: "shape",
          syntax: "collection",
          slots: paddedItems.map((value) => ({ value })),
        },
      },
      {
        label: "len",
        value: { kind: "literal", literalKind: "number", value: String(items.length) },
      },
    ],
  };
}

function compactArrayZeroValue(itemType: string): Expr {
  if (itemType.trim() === "bool") return { kind: "literal", literalKind: "bool", value: "false" };
  return { kind: "literal", literalKind: "number", value: "0" };
}

function resolveInfixOperator(
  symbol: string,
  left: Expr,
  right: Expr,
  env: Map<string, string>,
  functions: Map<string, FnDecl>,
  constructorTypes: Map<string, TypeDecl>,
  typeDecls: TypeDecl[],
  operators: OperatorDecl[],
  memo?: CheckMemo,
): string | "ambiguous" | undefined {
  const leftType = inferRuntimeType(left, env, functions, constructorTypes, memo);
  const rightType = inferRuntimeType(right, env, functions, constructorTypes, memo);
  const matches: string[] = [];
  for (const decl of operators) {
    if (decl.symbol !== symbol || !decl.fixity.startsWith("#infix")) continue;
    const fn = functions.get(decl.target);
    if (
      !fn ||
      !operatorTargetMatches(fn, left, right, leftType, rightType, functions, typeDecls, memo)
    ) {
      continue;
    }
    matches.push(decl.target);
  }
  return matches.length > 1 ? "ambiguous" : matches[0];
}

function operatorTargetMatches(
  fn: FnDecl,
  left: Expr,
  right: Expr,
  leftType: string | undefined,
  rightType: string | undefined,
  functions: Map<string, FnDecl>,
  typeDecls: TypeDecl[],
  memo?: CheckMemo,
): boolean {
  if (fn.params.length < 2 || fn.params.slice(2).some((param) => !param.const)) return false;
  let leftMatchType = operatorOperandContractType(leftType, typeDecls) ?? leftType;
  let rightMatchType = operatorOperandContractType(rightType, typeDecls) ?? rightType;
  if (
    left.kind === "literal" && left.literalKind === "number" && rightMatchType &&
    numericLiteralCanMatchType(rightMatchType, typeDecls)
  ) {
    leftMatchType = rightMatchType;
  }
  if (
    right.kind === "literal" && right.literalKind === "number" && leftMatchType &&
    numericLiteralCanMatchType(leftMatchType, typeDecls)
  ) {
    rightMatchType = leftMatchType;
  }
  const bindings = new Map<string, string>();
  bindTypePattern(fn.params[0]!.type, leftMatchType, bindings, typeDecls);
  bindTypePattern(fn.params[1]!.type, rightMatchType, bindings, typeDecls);
  if (left.kind === "var") inferFnTypeArgs(fn.params[0]!.type, functions.get(left.name), bindings);
  if (right.kind === "var") {
    inferFnTypeArgs(fn.params[1]!.type, functions.get(right.name), bindings);
  }
  const leftExpected = substituteTypeVars(fn.params[0]!.type, bindings);
  const rightExpected = substituteTypeVars(fn.params[1]!.type, bindings);
  return operandMatchesParam(leftExpected, left, leftMatchType, functions, typeDecls, memo) &&
    operandMatchesParam(rightExpected, right, rightMatchType, functions, typeDecls, memo) &&
    operatorConstProofParamsSatisfied(fn.params.slice(2), bindings, typeDecls);
}

function operatorOperandContractType(
  type: string | undefined,
  typeDecls: TypeDecl[],
): string | undefined {
  const trimmed = type?.trim();
  if (!trimmed) return undefined;
  const backed = scalarBackedRuntimeType(trimmed, typeDecls);
  if (backed) return backed;
  if (trimmed === "count") return "i32";
  const runtime = scalarDomainRuntimeType(trimmed);
  if (runtime) return runtime;
  const scalar = scalarReflection(trimmed);
  if (!scalar) return undefined;
  if (scalar.carrier === "i32" || scalar.carrier === "i64") return scalar.carrier;
  if (scalar.carrier === "u32" || scalar.carrier === "u64") return scalar.carrier;
  const width = scalar.bitWidth;
  if (width === undefined) return undefined;
  return width <= 32 ? "u32" : "u64";
}

function operatorConstProofParamsSatisfied(
  params: Param[],
  bindings: Map<string, string>,
  typeDecls: TypeDecl[],
): boolean {
  for (const param of params) {
    if (!param.const) return false;
    const proofType = substituteTypeVars(param.type, bindings);
    const base = typeNameOf(proofType);
    const args = typeCallArgsForBase(proofType, base);
    if (args === undefined) continue;
    const decl = typeDecls.find((item) =>
      item.name === base || terminalName(item.name) === terminalName(base)
    );
    if (!decl) continue;
    const required = typeDeclRequiredMembers(decl);
    if (!required.length) continue;
    const argValues = splitTypeArgs(args).map((arg) => arg.trim());
    for (const member of required) {
      const index = decl.params.findIndex((item) => item.name === member.paramName);
      const targetType = index >= 0 ? argValues[index] : undefined;
      if (targetType && isInferredTypeVarName(targetType)) continue;
      if (!targetType || !typeHasAttachedMember(targetType, member.member, typeDecls)) return false;
    }
  }
  return true;
}

function typeHasAttachedMember(type: string, member: string, typeDecls: TypeDecl[]): boolean {
  const name = typeNameOf(type);
  const decl = findTypeDecl(typeDecls, name);
  const normalized = decl?.normalized;
  if (normalized?.kind !== "product" && normalized?.kind !== "sum") return false;
  return (normalized.members ?? []).some((item) => item.name === member);
}

function operandMatchesParam(
  expected: string,
  expr: Expr,
  actual: string | undefined,
  functions: Map<string, FnDecl>,
  typeDecls: TypeDecl[],
  memo?: CheckMemo,
): boolean {
  if (actual && typeMatches(expected, actual, memo)) return true;
  if (actual && scalarBackedTypeMatches(expected, actual, typeDecls, memo)) return true;
  if (expr.kind === "literal" && expr.literalKind === "number") {
    if (numericLiteralCanMatchType(expected, typeDecls)) return true;
  }
  if (expr.kind !== "var") return false;
  return fnTypeMatches(expected, functions.get(expr.name));
}

function numericLiteralCanMatchType(type: string, typeDecls: TypeDecl[]): boolean {
  const trimmed = stripBorrowType(type).trim();
  if (!trimmed) return false;
  const scalar = scalarReflection(trimmed);
  if (scalar) return true;
  const backed = scalarBackedRuntimeType(trimmed, typeDecls);
  if (backed) return true;
  return trimmed === "i32" || trimmed === "u32" || trimmed === "i64" || trimmed === "u64" ||
    trimmed === "f32" || trimmed === "f64" || trimmed === "count";
}

function scalarBackedTypeMatches(
  expected: string,
  actual: string,
  typeDecls: TypeDecl[],
  memo?: CheckMemo,
): boolean {
  const expectedScalar = scalarBackedRuntimeType(expected, typeDecls);
  const actualScalar = scalarBackedRuntimeType(actual, typeDecls);
  if (!expectedScalar || !actualScalar) return false;
  return typeMatches(expectedScalar, actualScalar, memo);
}

function scalarBackedRuntimeType(
  type: string | undefined,
  typeDecls: TypeDecl[],
  seen = new Set<string>(),
): string | undefined {
  const trimmed = stripBorrowType(type ?? "").trim();
  if (!trimmed) return undefined;
  const scalar = scalarReflection(trimmed);
  if (scalar) return scalar.carrier;
  if (trimmed === "count") return "i32";
  if (seen.has(trimmed)) return undefined;
  seen.add(trimmed);
  const resolvedAlias = resolveAliasType(trimmed, typeDecls);
  if (resolvedAlias && resolvedAlias !== trimmed) {
    return scalarBackedRuntimeType(resolvedAlias, typeDecls, seen);
  }
  const name = typeNameOf(trimmed);
  const decl = findTypeDecl(typeDecls, name);
  if (decl?.enum) {
    return scalarBackedRuntimeType(decl.enum.backing, typeDecls, seen);
  }
  if (decl?.normalized?.kind === "alias") {
    return scalarBackedRuntimeType(decl.normalized.type, typeDecls, seen);
  }
  return undefined;
}

function typeMatches(expected: string, actual: string, memo?: CheckMemo): boolean {
  expected = stripBorrowType(expected);
  actual = stripBorrowType(actual);
  const key = memo ? `${expected}\0${actual}` : undefined;
  if (key && memo!.typeMatches.has(key)) return memo!.typeMatches.get(key)!;
  const finish = (value: boolean) => {
    if (key) memo!.typeMatches.set(key, value);
    return value;
  };
  if (isFrozenType(expected) !== isFrozenType(actual)) return false;
  const expectedLiteral = canonicalLiteralType(expected);
  const actualLiteral = canonicalLiteralType(actual);
  if (expectedLiteral || actualLiteral) return finish(runtimeValueTypeAssignable(expected, actual));
  const refined = refinedI32Assignable(expected, actual);
  if (refined !== undefined) return finish(refined);
  if (expected === actual || isInferredTypeVarName(expected)) return finish(true);
  return finish(runtimeTypePatternMatches(expected, actual, new Map(), memo));
}

function fnTypeMatches(expected: string, actual: FnDecl | undefined): boolean {
  if (!actual) return false;
  const expectedSig = parseFnSignature(expected);
  if (!expectedSig || expectedSig.params.length !== actual.params.length) return false;
  const bindings = new Map<string, string>();
  return expectedSig.params.every((param, index) =>
    runtimeTypePatternMatches(param, actual.params[index]?.type, bindings)
  ) && runtimeTypePatternMatches(expectedSig.returnType, actual.returnType, bindings);
}

function runtimeTypePatternMatches(
  expected: string | undefined,
  actual: string | undefined,
  bindings: Map<string, string>,
  memo?: CheckMemo,
): boolean {
  if (!expected || !actual) return false;
  expected = stripBorrowType(expected);
  actual = stripBorrowType(actual);
  const canMemo = memo && bindings.size === 0 && !isInferredTypeVarName(expected);
  const key = canMemo ? `${expected}\0${actual}` : undefined;
  if (key && memo!.typeMatches.has(key)) return memo!.typeMatches.get(key)!;
  const finish = (value: boolean) => {
    if (key) memo!.typeMatches.set(key, value);
    return value;
  };
  if (isFrozenType(expected) !== isFrozenType(actual)) return false;
  const expectedLiteral = canonicalLiteralType(expected);
  const actualLiteral = canonicalLiteralType(actual);
  if (expectedLiteral || actualLiteral) return finish(runtimeValueTypeAssignable(expected, actual));
  const refined = refinedI32Assignable(expected, actual);
  if (refined !== undefined) return finish(refined);
  if (expected === actual) return finish(true);
  if (isInferredTypeVarName(expected)) {
    const bound = bindings.get(expected);
    if (bound) return bound === actual;
    bindings.set(expected, actual);
    return true;
  }
  const expectedCall = expected.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
  const actualCall = actual.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
  if (!expectedCall || !actualCall || expectedCall[1] !== actualCall[1]) return finish(false);
  const expectedArgs = splitTypeArgs(expectedCall[2]);
  const actualArgs = splitTypeArgs(actualCall[2]);
  return finish(
    expectedArgs.length === actualArgs.length &&
      expectedArgs.every((arg, index) =>
        runtimeTypePatternMatches(arg, actualArgs[index], bindings, memo)
      ),
  );
}

function splitTypeArgs(source: string): string[] {
  const args: string[] = [];
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;
    else if (char === "," && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) args.push(tail);
  return args;
}

function runtimeTypeMemoKey(
  expr: Expr,
  env: Map<string, string>,
  constructorTypes?: Map<string, TypeDecl>,
): string | undefined {
  const exprKey = structuralExprKey(expr);
  if (!exprKey) return undefined;
  return [
    exprKey,
    stringEnvKey(env),
    constructorTypes ? [...constructorTypes.keys()].sort().join(",") : "",
  ].join("\0");
}

function inferRuntimeType(
  expr: Expr,
  env: Map<string, string>,
  functions: Map<string, FnDecl>,
  constructorTypes?: Map<string, TypeDecl>,
  memo?: CheckMemo,
): string | undefined {
  const key = memo ? runtimeTypeMemoKey(expr, env, constructorTypes) : undefined;
  if (key && memo!.runtimeType.has(key)) return memo!.runtimeType.get(key);
  const finish = (type: string | undefined) => {
    if (key) memo!.runtimeType.set(key, type);
    return type;
  };
  if (expr.kind === "literal") {
    if (expr.inferredType) return finish(expr.inferredType);
    if (expr.literalKind === "number") {
      return finish(numericLiteralExplicitType(expr.value) ?? "i32");
    }
    if (expr.literalKind === "bool") return finish("bool");
    return finish(expr.inferredType);
  }
  if (expr.kind === "binary") {
    return finish(inferScalarOperatorResultType(
      expr.op,
      inferRuntimeType(expr.left, env, functions, constructorTypes, memo),
      inferRuntimeType(expr.right, env, functions, constructorTypes, memo),
    ));
  }
  if (expr.kind === "operator_chain") {
    return finish(inferOperatorChainResultType(
      expr,
      (child) => inferRuntimeType(child, env, functions, constructorTypes, memo),
    ));
  }
  if (expr.kind === "var") {
    const localType = stripBorrowType(env.get(expr.name));
    return finish(
      localType ||
        (functions.has(expr.name) ? renderFnType(functions.get(expr.name)!) : undefined),
    );
  }
  if (expr.kind === "call" && expr.callee.kind === "var") {
    const fn = functions.get(expr.callee.name);
    if (!fn) return finish(undefined);
    if (!fn.returnType) return finish(undefined);
    const bindings = new Map<string, string>();
    fn.params.forEach((param, index) => {
      if (param.const) return;
      const arg = expr.args[index];
      if (!arg) return;
      bindTypePattern(
        param.type,
        inferRuntimeType(arg, env, functions, constructorTypes, memo),
        bindings,
      );
    });
    return finish(substituteTypeVars(fn.returnType, bindings));
  }
  if (expr.kind === "product_constructor") {
    return finish(inferProductConstructorType(expr, env, functions, constructorTypes, memo));
  }
  if (expr.kind === "range") return finish("range_i32");
  return finish(undefined);
}

function inferScalarOperatorResultType(
  op: string,
  leftType: string | undefined,
  rightType: string | undefined,
): string | undefined {
  const left = scalarDomainRuntimeType(leftType) ?? leftType;
  const right = scalarDomainRuntimeType(rightType) ?? rightType;
  if (arithmeticBinaryOp(op)) {
    if (left === "i32" && right === "i32") return "i32";
    return undefined;
  }
  if (booleanBinaryOp(op)) {
    if (left === "bool" && right === "bool") return "bool";
    return undefined;
  }
  if (!comparisonBinaryOp(op)) return undefined;
  if (op === "==" || op === "!=") {
    if (left !== undefined && left === right) return "bool";
    return undefined;
  }
  if (left === "i32" && right === "i32") return "bool";
  return undefined;
}

function inferOperatorChainResultType(
  expr: Extract<Expr, { kind: "operator_chain" }>,
  inferChild: (expr: Expr) => string | undefined,
): string | undefined {
  let current = inferChild(expr.first);
  for (const item of expr.rest) {
    const right = inferChild(item.value);
    current = inferScalarOperatorResultType(item.op, current, right);
    if (!current) return undefined;
  }
  return current;
}

function inferProductConstructorType(
  expr: Extract<Expr, { kind: "product_constructor" }>,
  env: Map<string, string>,
  functions: Map<string, FnDecl>,
  constructorTypes?: Map<string, TypeDecl>,
  memo?: CheckMemo,
): string | undefined {
  const decl = constructorTypes?.get(expr.constructor);
  if (!decl) return undefined;
  if (!decl.params.length || decl.normalized?.kind !== "product") return decl.name;
  const bindings = new Map<string, string>();
  for (const slot of expr.slots) {
    if (!slot.label) continue;
    const expected = decl.normalized.shape.slots.find((item) => item.label === slot.label)?.type;
    const actual = inferRuntimeType(slot.value, env, functions, constructorTypes, memo);
    if (expected && actual) runtimeTypePatternMatches(expected, actual, bindings, memo);
  }
  if (!decl.params.every((param) => bindings.has(param.name))) return decl.name;
  return `${decl.name}(${decl.params.map((param) => bindings.get(param.name)!).join(", ")})`;
}

function directCompilerCallId(fn: FnDecl): string | undefined {
  const expr = fn.body.expr;
  if (fn.body.statements.length !== 0 || !expr || expr.kind !== "call") return undefined;
  if (expr.callee.kind !== "var" || !expr.callee.name.startsWith("@")) return undefined;
  const id = expr.callee.name.slice(1);
  return id.startsWith("memory_") || id.startsWith("ptr_") || id === "freeze" ? id : undefined;
}

function clauseBodyWithParamPatternBindings(clause: FnDecl): Extract<Expr, { kind: "block" }> {
  let expr: Expr = clause.body;
  let wrapped = false;
  for (let index = clause.params.length - 1; index >= 0; index--) {
    const param = clause.params[index];
    if (!paramPatternNeedsBodyMatch(param)) continue;
    expr = {
      kind: "match",
      value: { kind: "var", name: param.name },
      arms: [{
        pattern: param.pattern!,
        value: expr,
      }],
    };
    wrapped = true;
  }
  if (!wrapped) return clause.body;
  return { kind: "block", statements: [], expr };
}

function paramPatternNeedsBodyMatch(param: Param | undefined): boolean {
  const pattern = param?.pattern;
  if (!pattern || pattern.kind === "binding") return false;
  return patternBindingNames(pattern).length > 0;
}

function checkCallClauseDomainCoverage(
  expr: Extract<Expr, { kind: "call" }>,
  calleeName: string,
  env: Map<string, OwnershipBinding>,
  diagnostics: Diagnostic[],
  types: TypeDecl[],
  functions: FnDecl[],
  options: RuntimeCheckOptions,
): void {
  const clauses = functions.filter((fn) =>
    fn.generated && fn.name.startsWith(`${calleeName}__clause_`)
  );
  if (!clauses.length) return;
  const dispatcher = functions.find((fn) => fn.name === calleeName);
  const arity = dispatcher?.params.length ?? clauses[0]?.params.length ?? 0;
  for (let index = 0; index < Math.min(expr.args.length, arity); index++) {
    const covered = refinedClauseParameterUnion(clauses, index);
    if (!covered) continue;
    const actual = refinedArgumentDomain(
      expr.args[index]!,
      env,
      types,
      functions,
      options.recoverTypes,
    );
    if (!actual || domainContains(covered, actual)) continue;
    const uncovered = subtractDomain(actual, covered);
    if (!uncovered || domainIsEmpty(uncovered)) continue;
    diagnostics.push(diagnosticAt(
      "fn.match_domain_uncovered",
      `call to ${calleeName} may reach no function match arm for argument ${index + 1} domain ${
        canonicalDomainKey(uncovered)
      }`,
      expr.args[index],
    ));
  }
}

function refinedClauseParameterUnion(
  clauses: FnDecl[],
  index: number,
): RefinedI32Domain | undefined {
  let covered: RefinedI32Domain | undefined;
  for (const clause of clauses) {
    const param = clause.params[index];
    if (!param) return undefined;
    const domain = parseRefinedI32Type(param.type);
    if (!domain) return undefined;
    covered = covered ? unionDomain(covered, domain) : domain;
  }
  return covered;
}

function refinedArgumentDomain(
  arg: Expr,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
  recoverTypes: boolean,
): RefinedI32Domain | undefined {
  const literal = staticIntegerLiteral(arg);
  if (literal !== undefined) return scalarFactsFromI32Range({ min: literal, max: literal }).domain;
  const actual = exprBindingType(arg, env, types, functions, recoverTypes);
  const resolved = resolveAliasType(actual, types) ?? actual;
  return parseRefinedI32Type(resolved);
}

function checkBranchHints(
  program: Program,
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
  checkedDeclarations?: WeakSet<object>,
) {
  const likely = annotationBranchHint("likely", pluginRegistry);
  const unlikely = annotationBranchHint("unlikely", pluginRegistry);
  if (likely !== "likely" || unlikely !== "unlikely") {
    diagnostics.push({
      code: "plugin.annotation",
      message: "core branch hint tags @[likely] and @[unlikely] must be registered",
    });
  }
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") continue;
    if (checkedDeclarations?.has(decl)) continue;
    const diagnosticCount = diagnostics.length;
    if (decl.branchHint) {
      decl.branchHint = normalizeBranchHintAnnotation(
        decl.branchHint,
        decl,
        diagnostics,
        pluginRegistry,
      );
    }
    if (decl.branchHint && !decl.generated) {
      diagnostics.push({
        code: "branch_hint.unused",
        message: `branch hint on function ${decl.name} is only valid on match arms`,
        span: decl.nameSpan ?? decl.span,
      });
    }
    checkBranchHintsInBlock(decl.body, diagnostics, pluginRegistry);
    if (diagnostics.length === diagnosticCount) {
      checkedDeclarations?.add(decl);
    }
  }
}

function checkBranchHintsInBlock(
  block: BlockExpr,
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
) {
  for (const stmt of block.statements) {
    if (stmt.kind === "let" || stmt.kind === "destructure_let") {
      checkBranchHintsInExpr(stmt.value, diagnostics, pluginRegistry);
    }
  }
  if (block.expr) checkBranchHintsInExpr(block.expr, diagnostics, pluginRegistry);
}

function checkBranchHintsInExpr(
  expr: Expr,
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
) {
  switch (expr.kind) {
    case "block":
      checkBranchHintsInBlock(expr, diagnostics, pluginRegistry);
      return;
    case "call":
      checkBranchHintsInExpr(expr.callee, diagnostics, pluginRegistry);
      expr.args.forEach((arg) => checkBranchHintsInExpr(arg, diagnostics, pluginRegistry));
      return;
    case "index":
      checkBranchHintsInExpr(expr.target, diagnostics, pluginRegistry);
      checkBranchHintsInExpr(expr.index, diagnostics, pluginRegistry);
      return;
    case "binary":
      checkBranchHintsInExpr(expr.left, diagnostics, pluginRegistry);
      checkBranchHintsInExpr(expr.right, diagnostics, pluginRegistry);
      return;
    case "operator_chain":
      checkBranchHintsInExpr(expr.first, diagnostics, pluginRegistry);
      expr.rest.forEach((item) => checkBranchHintsInExpr(item.value, diagnostics, pluginRegistry));
      return;
    case "pipe_bind":
      checkBranchHintsInExpr(expr.value, diagnostics, pluginRegistry);
      checkBranchHintsInExpr(expr.body, diagnostics, pluginRegistry);
      return;
    case "match":
      checkBranchHintsInExpr(expr.value, diagnostics, pluginRegistry);
      validateMatchBranchHints(expr, diagnostics, pluginRegistry);
      expr.arms.forEach((arm) => {
        if (arm.guard) checkBranchHintsInExpr(arm.guard, diagnostics, pluginRegistry);
        checkBranchHintsInExpr(arm.value, diagnostics, pluginRegistry);
      });
      return;
    case "shape":
    case "product_constructor":
      expr.slots.forEach((slot) => {
        if (slot.index) checkBranchHintsInExpr(slot.index, diagnostics, pluginRegistry);
        checkBranchHintsInExpr(slot.value, diagnostics, pluginRegistry);
      });
      return;
    case "range":
      checkBranchHintsInExpr(expr.start, diagnostics, pluginRegistry);
      checkBranchHintsInExpr(expr.end, diagnostics, pluginRegistry);
      return;
    case "static_for_slots":
      checkBranchHintsInExpr(expr.value, diagnostics, pluginRegistry);
      return;
    case "field":
      checkBranchHintsInExpr(expr.value, diagnostics, pluginRegistry);
      checkBranchHintsInExpr(expr.key, diagnostics, pluginRegistry);
      return;
    case "literal":
    case "var":
      return;
  }
}

function normalizeBranchHintAnnotation(
  name: string,
  node: { span?: Span; nameSpan?: Span },
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
): BranchHint {
  const annotation = pluginRegistry.annotationBuiltins.get(name);
  if (!annotation) {
    diagnostics.push({
      code: "plugin.unknown_annotation",
      message: `unknown annotation @${name}`,
      span: node.nameSpan ?? node.span,
    });
    return name;
  }
  if (!annotation.branchHint) {
    diagnostics.push({
      code: "plugin.annotation_phase",
      message: `annotation @${name} cannot be used as a branch hint`,
      span: node.nameSpan ?? node.span,
    });
    return name;
  }
  return annotation.branchHint;
}

function validateMatchBranchHints(
  expr: Extract<Expr, { kind: "match" }>,
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
) {
  expr.arms.forEach((arm, index) => {
    if (!arm.branchHint) return;
    arm.branchHint = normalizeBranchHintAnnotation(
      arm.branchHint,
      arm,
      diagnostics,
      pluginRegistry,
    );
    if (arm.guard) return;
    const isLast = index === expr.arms.length - 1;
    const previous = expr.arms[index - 1];
    if (!isLast && !isCatchAllPattern(arm.pattern)) return;
    if (isLast && previous && !previous.branchHint) return;
    diagnostics.push({
      code: "branch_hint.unmapped",
      message: "branch hint cannot be attached to a generated runtime conditional",
      span: arm.span,
    });
  });
}

function clauseDispatcherBody(
  signature: FnDecl,
  clauses: FnDecl[],
): Extract<Expr, { kind: "block" }> {
  const callClause = (index: number): Expr => ({
    kind: "call",
    callee: { kind: "var", name: `${signature.name}__clause_${index}` },
    args: signature.params.map((param) => ({ kind: "var", name: param.name })),
  });
  let expr: Expr = { kind: "literal", literalKind: "number", value: "0" };
  for (let index = clauses.length - 1; index >= 0; index--) {
    expr = buildClauseBranch(signature, clauses[index], index, expr, clauses[index + 1]);
  }
  return { kind: "block", statements: [], expr };
}

function buildClauseBranch(
  signature: FnDecl,
  clause: FnDecl,
  index: number,
  fallback: Expr,
  nextClause?: FnDecl,
): Expr {
  const tests = clauseTests(signature, clause);
  const success: Expr = {
    kind: "call",
    callee: { kind: "var", name: `${signature.name}__clause_${index}` },
    args: signature.params.map((param) => ({ kind: "var", name: param.name })),
  };
  if (!tests.length) return success;
  const nextHint = nextClause?.branchHint && clauseTests(signature, nextClause).length === 0
    ? invertBranchHint(nextClause.branchHint)
    : undefined;
  const branchHint = clause.branchHint ?? nextHint;
  return buildClauseTestBranch(tests, success, fallback, branchHint);
}

type ClauseTest =
  | { kind: "expr"; test: Expr }
  | { kind: "domain"; value: Expr; domain: NonNullable<ReturnType<typeof parseRefinedI32Type>> };

function buildClauseTestBranch(
  tests: ClauseTest[],
  success: Expr,
  fallback: Expr,
  branchHint?: BranchHint,
): Expr {
  const [test, ...rest] = tests;
  if (!test) return success;
  const next = buildClauseTestBranch(rest, success, fallback);
  if (test.kind === "domain") {
    return buildDomainTestBranch(test.value, test.domain.intervals, next, fallback, branchHint);
  }
  return {
    kind: "match",
    value: test.test,
    arms: [
      {
        pattern: literalPattern("true", "bool"),
        ...(branchHint ? { branchHint } : {}),
        value: next,
      },
      { pattern: wildcardPattern(), value: fallback },
    ],
  };
}

function buildDomainTestBranch(
  value: Expr,
  intervals: NonNullable<ReturnType<typeof parseRefinedI32Type>>["intervals"],
  success: Expr,
  fallback: Expr,
  branchHint?: BranchHint,
): Expr {
  let expr = fallback;
  for (let index = intervals.length - 1; index >= 0; index--) {
    expr = buildIntervalTestBranch(value, intervals[index], success, expr, branchHint);
  }
  return expr;
}

function buildIntervalTestBranch(
  value: Expr,
  interval: DomainInterval,
  success: Expr,
  fallback: Expr,
  branchHint?: BranchHint,
): Expr {
  if (
    interval.start.kind === "literal" && interval.end.kind === "literal" &&
    interval.end.value === interval.start.value + 1
  ) {
    return matchTrue(
      {
        kind: "binary",
        op: "==",
        left: value,
        right: { kind: "literal", literalKind: "number", value: interval.start.source },
      },
      success,
      fallback,
      branchHint,
    );
  }
  const lower = matchTrue(
    {
      kind: "binary",
      op: "<=",
      left: endpointExpr(interval.start),
      right: value,
    },
    matchTrue(
      {
        kind: "binary",
        op: "<",
        left: value,
        right: endpointExpr(interval.end),
      },
      success,
      fallback,
    ),
    fallback,
    branchHint,
  );
  return lower;
}

function endpointExpr(endpoint: DomainInterval["start"]): Expr {
  return endpoint.kind === "literal"
    ? { kind: "literal", literalKind: "number", value: endpoint.source }
    : { kind: "var", name: endpoint.name };
}

function matchTrue(
  test: Expr,
  success: Expr,
  fallback: Expr,
  branchHint?: BranchHint,
): Expr {
  return {
    kind: "match",
    value: test,
    arms: [
      {
        pattern: literalPattern("true", "bool"),
        ...(branchHint ? { branchHint } : {}),
        value: success,
      },
      { pattern: wildcardPattern(), value: fallback },
    ],
  };
}

function invertBranchHint(hint: BranchHint): BranchHint {
  return hint === "likely" ? "unlikely" : "likely";
}

function clauseTests(signature: FnDecl, clause: FnDecl): ClauseTest[] {
  return [
    ...clausePatternTests(signature, clause).map((test): ClauseTest => ({ kind: "expr", test })),
    ...clauseDomainTests(signature, clause),
  ];
}

function clausePatternTests(signature: FnDecl, clause: FnDecl): Expr[] {
  return clause.params.map((param, paramIndex) =>
    patternTestExpr(param.pattern, { kind: "var", name: signature.params[paramIndex].name })
  ).filter((expr): expr is Expr => Boolean(expr));
}

function clauseDomainTests(signature: FnDecl, clause: FnDecl): ClauseTest[] {
  return clause.params.flatMap((param, paramIndex): ClauseTest[] => {
    const domain = parseRefinedI32Type(param.type);
    if (!domain) return [];
    return [{
      kind: "domain",
      value: { kind: "var", name: signature.params[paramIndex].name },
      domain,
    }];
  });
}

function wildcardPattern(): ParamPattern {
  return { kind: "wildcard" };
}

function literalPattern(
  value: string,
  literalKind: "number" | "bool" | "string" | "literalType",
): ParamPattern {
  return { kind: "literal", value, literalKind };
}

function renderParamPattern(pattern: ParamPattern): string {
  switch (pattern.kind) {
    case "binding":
      return pattern.name;
    case "wildcard":
      return "_";
    case "literal":
      return pattern.value;
    case "enum_member":
      return pattern.name;
    case "type":
      return pattern.name;
    case "tuple":
      return `[${pattern.items.map(renderParamPattern).join(", ")}]`;
    case "constructor":
      return `${pattern.name}(${pattern.args.map(renderParamPattern).join(",")})`;
    case "or":
      return pattern.alternatives.map(renderParamPattern).join(" | ");
    case "as":
      return `${pattern.name} @ ${renderParamPattern(pattern.pattern)}`;
    case "product":
      return `${pattern.name} {${
        pattern.fields.map((field) => {
          if (field.pattern.kind === "binding" && field.pattern.name === field.label) {
            return field.label;
          }
          return `${field.label}: ${renderParamPattern(field.pattern)}`;
        }).join(", ")
      }}`;
    case "typed":
      return `${renderParamPattern(pattern.pattern)}: ${pattern.type}`;
  }
}

function patternTestExpr(pattern: ParamPattern | undefined, value: Expr): Expr | undefined {
  if (!pattern || pattern.kind === "binding" || pattern.kind === "wildcard") return undefined;
  if (pattern.kind === "typed") {
    const inner = patternTestExpr(pattern.pattern, value);
    const domain = parseRefinedI32Type(pattern.type);
    if (!domain) return inner;
    const domainTest = buildDomainTestBranch(
      value,
      domain.intervals,
      { kind: "literal", literalKind: "bool", value: "true" },
      { kind: "literal", literalKind: "bool", value: "false" },
    );
    if (!inner) return domainTest;
    return {
      kind: "binary",
      op: "&&",
      left: inner,
      right: domainTest,
    };
  }
  if (pattern.kind === "literal") {
    return {
      kind: "binary",
      op: "==",
      left: value,
      right: { kind: "literal", value: pattern.value, literalKind: pattern.literalKind },
    };
  }
  return undefined;
}

function mergeTypeFragments(program: Program, diagnostics: Diagnostic[]): TypeDecl[] {
  const groups = new Map<string, TypeDecl[]>();
  for (const decl of program.declarations) {
    if (decl.kind !== "type") continue;
    const group = groups.get(decl.name) ?? [];
    group.push(decl);
    groups.set(decl.name, group);
  }

  const replacements = new Map<TypeDecl, TypeDecl>();
  const remove = new Set<TypeDecl>();
  const mergedDecls: TypeDecl[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      mergedDecls.push(group[0]);
      continue;
    }

    if (
      group.some((decl) => decl.paramPatterns?.length) &&
      group.every((decl) => decl.params.length === group[0].params.length)
    ) {
      const primary = group[0];
      for (const clause of group.slice(1)) {
        if (clause.params.length !== primary.params.length) {
          diagnostics.push({
            code: "type.clause_arity",
            message: `type function ${primary.name} clauses must have the same arity`,
          });
        }
        clause.params.forEach((param, index) => {
          if (param.kind !== primary.params[index]?.kind) {
            diagnostics.push({
              code: "type.clause_param_kind",
              message: `type function ${primary.name} clause parameter ${
                index + 1
              } has incompatible kind`,
            });
          }
        });
        if (clause.resultKind !== primary.resultKind) {
          diagnostics.push({
            code: "type.clause_result_kind",
            message: `type function ${primary.name} clauses must have the same result kind`,
          });
        }
      }
      const merged: TypeDecl = {
        ...primary,
        clauses: group,
      };
      replacements.set(primary, merged);
      for (const clause of group.slice(1)) remove.add(clause);
      mergedDecls.push(merged);
      continue;
    }

    diagnostics.push({
      code: "type.duplicate_runtime_fragment",
      message: `type ${group[0].name} has multiple runtime definitions`,
    });
    mergedDecls.push(group[0]);
    for (const fragment of group.slice(1)) remove.add(fragment);
  }

  program.declarations = program.declarations.flatMap((decl): Program["declarations"] => {
    if (decl.kind !== "type") return [decl];
    if (remove.has(decl)) return [];
    return [replacements.get(decl) ?? decl];
  });
  return mergedDecls;
}

const TYPE_FRAGMENT_MEMBER_SHAPE = "__fig_type_members";

function typeFragmentMembers(decl: TypeDecl) {
  const expr = decl.body.expr;
  if (expr) {
    if (expr.kind === "type_shape") return expr.shape.members ?? [];
    const target = builderPrimaryShape(decl, expr);
    if (target) return target.shape.members ?? [];
  }
  const synthetic = syntheticMemberShape(decl);
  if (synthetic) return synthetic.shape.members ?? [];
  return [];
}

function ensureTypeFragmentMembers(decl: TypeDecl) {
  let expr = decl.body.expr;
  if (!expr) {
    expr = decl.body.expr = { kind: "type_shape", shape: { slots: [], members: [] } };
  }
  if (expr.kind === "type_shape") {
    expr.shape.members ??= [];
    return expr.shape.members;
  }
  const target = builderPrimaryShape(decl, expr);
  if (target) {
    target.shape.members ??= [];
    return target.shape.members;
  }
  const synthetic = syntheticMemberShape(decl);
  if (synthetic) {
    synthetic.shape.members ??= [];
    return synthetic.shape.members;
  }
  const replacement: TypeExpr = { kind: "type_shape", shape: { slots: [], members: [] } };
  decl.body.statements.push({
    kind: "type_let",
    name: TYPE_FRAGMENT_MEMBER_SHAPE,
    value: replacement,
  });
  return replacement.shape.members!;
}

function syntheticMemberShape(
  decl: TypeDecl,
): Extract<TypeExpr, { kind: "type_shape" }> | undefined {
  const stmt = decl.body.statements.find((item) => item.name === TYPE_FRAGMENT_MEMBER_SHAPE);
  if (stmt?.value.kind !== "type_shape") return undefined;
  return stmt.value;
}

function builderPrimaryShape(decl: TypeDecl, expr: TypeExpr) {
  const call = typeBuilderCall(expr);
  if (!call) return undefined;
  const firstArg = call.args[0];
  if (firstArg?.kind !== "type_ref") return undefined;
  const stmt = decl.body.statements.find((stmt) => stmt.name === firstArg.name);
  return stmt?.value.kind === "type_shape" ? stmt.value : undefined;
}

function attachQualifiedTypeMembers(
  types: TypeDecl[],
  functions: FnDecl[],
  diagnostics: Diagnostic[],
) {
  const typesByName = new Map(types.map((decl) => [decl.name, decl]));
  const attached = new Set<string>();
  for (const fn of functions) {
    const intrinsicId = intrinsicWrapperId(fn);
    if (
      !fn.memberOf || fn.primitiveId ||
      (intrinsicId !== undefined && !isPrimitiveScalarIntrinsicId(intrinsicId))
    ) {
      continue;
    }
    const owner = typesByName.get(fn.memberOf.owner);
    if (!owner) {
      if (!fn.memberOf.owner.includes(".") && fn.params.length === 0) {
        diagnostics.push({
          code: "type.unknown_type",
          message: `unknown type ${fn.memberOf.owner}`,
        });
      }
      continue;
    }
    const key = `${fn.memberOf.owner}::${fn.memberOf.member}`;
    if (
      attached.has(key) ||
      typeFragmentMembers(owner).some((member) => member.name === fn.memberOf!.member)
    ) {
      diagnostics.push({
        code: "type.duplicate_member",
        message: `type ${fn.memberOf.owner} has duplicate static member ${fn.memberOf.member}`,
      });
      continue;
    }
    attached.add(key);
    const member = {
      ...(fn.doc ? { doc: fn.doc } : {}),
      name: fn.memberOf.member,
      type: renderFnType(fn),
      target: fn.name,
    };
    ensureTypeFragmentMembers(owner).push(member);
    if (owner.normalized?.kind === "product" || owner.normalized?.kind === "sum") {
      owner.normalized.members ??= [];
      owner.normalized.members.push({ ...member });
    }
  }
}

function checkDotQualifiedTypeMemberSyntax(
  types: TypeDecl[],
  functions: FnDecl[],
  diagnostics: Diagnostic[],
) {
  const typeNames = new Set(types.map((decl) => decl.name));
  for (const fn of functions) {
    if (fn.memberOf || fn.primitiveId || isIntrinsicWrapper(fn) || !fn.name.includes(".")) continue;
    const split = fn.name.lastIndexOf(".");
    const owner = fn.name.slice(0, split);
    const member = fn.name.slice(split + 1);
    if (!typeNames.has(owner)) continue;
    diagnostics.push({
      code: "type.member_syntax",
      message: `type member ${owner}.${member} must be declared as ${owner}::${member}`,
      span: fn.nameSpan ?? fn.span,
    });
  }
}

function renderFnType(fn: FnDecl): string {
  return `fn(${
    fn.params.map((param) => `${param.const ? "const " : ""}${param.name}: ${param.type}`).join(
      ", ",
    )
  }) -> ${fn.returnType ?? "type"}`;
}

function resolveAttachedMemberCalls(program: Program, types: TypeDecl[]) {
  const members = new Map<string, string>();
  for (const type of types) {
    const normalized = type.normalized;
    if (normalized?.kind !== "product" && normalized?.kind !== "sum") continue;
    for (const member of normalized.members ?? []) {
      members.set(`${type.name}::${member.name}`, member.target);
    }
  }
  for (const decl of program.declarations) {
    if (decl.kind !== "fn" || !decl.memberOf) continue;
    const key = `${decl.memberOf.owner}::${decl.memberOf.member}`;
    if (!members.has(key)) members.set(key, decl.name);
  }
  if (!members.size) return;
  for (const decl of program.declarations) {
    if (decl.kind === "fn") decl.body = rewriteAttachedMembersInBlock(decl.body, members);
    else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = rewriteAttachedMembersInExpr(decl.value, members);
    }
  }
}

function rewriteAttachedMembersInBlock(
  block: Extract<Expr, { kind: "block" }>,
  members: Map<string, string>,
) {
  return {
    ...block,
    statements: block.statements.map((stmt) =>
      stmt.kind === "let"
        ? { ...stmt, value: rewriteAttachedMembersInExpr(stmt.value, members) }
        : stmt
    ),
    expr: block.expr ? rewriteAttachedMembersInExpr(block.expr, members) : undefined,
  };
}

function rewriteAttachedMembersInExpr(expr: Expr, members: Map<string, string>): Expr {
  switch (expr.kind) {
    case "do":
      return lowerDoExpression(expr, [], (child) => rewriteAttachedMembersInExpr(child, members));
    case "const_fn":
      return { ...expr, span: expr.span, body: rewriteAttachedMembersInExpr(expr.body, members) };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => rewriteAttachedMembersInExpr(arg, members)),
        body: rewriteAttachedMembersInExpr(expr.body, members),
      };
    case "var": {
      const target = attachedMemberTargetName(expr.name, members);
      if (target) return { kind: "var", name: target };
      return expr;
    }
    case "call":
      return {
        ...expr,
        callee: rewriteAttachedMembersInExpr(expr.callee, members),
        args: expr.args.map((arg) => rewriteAttachedMembersInExpr(arg, members)),
      };
    case "index":
      return {
        ...expr,
        target: rewriteAttachedMembersInExpr(expr.target, members),
        index: rewriteAttachedMembersInExpr(expr.index, members),
      };
    case "binary":
      return {
        ...expr,
        left: rewriteAttachedMembersInExpr(expr.left, members),
        right: rewriteAttachedMembersInExpr(expr.right, members),
      };
    case "operator_chain":
      return {
        ...expr,
        first: rewriteAttachedMembersInExpr(expr.first, members),
        rest: expr.rest.map((item) => ({
          ...item,
          value: rewriteAttachedMembersInExpr(item.value, members),
        })),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: rewriteAttachedMembersInExpr(expr.value, members),
        body: rewriteAttachedMembersInExpr(expr.body, members),
      };
    case "match":
      return {
        ...expr,
        value: rewriteAttachedMembersInExpr(expr.value, members),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: rewriteAttachedMembersInExpr(arm.value, members),
        })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: rewriteAttachedMembersInExpr(slot.value, members),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: rewriteAttachedMembersInExpr(slot.value, members),
        })),
      };
    case "range":
      return {
        ...expr,
        start: rewriteAttachedMembersInExpr(expr.start, members),
        end: rewriteAttachedMembersInExpr(expr.end, members),
      };
    case "static_for_slots":
      return {
        ...expr,
        value: rewriteAttachedMembersInExpr(expr.value, members),
      };
    case "field":
      return {
        ...expr,
        value: rewriteAttachedMembersInExpr(expr.value, members),
        key: rewriteAttachedMembersInExpr(expr.key, members),
      };
    case "block":
      return rewriteAttachedMembersInBlock(expr, members);
    case "literal":
      return expr;
  }
}

function attachedMemberTargetName(name: string, members: Map<string, string>): string | undefined {
  const direct = members.get(name);
  if (direct) return direct;
  const match = name.match(/^(.+)::([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) return undefined;
  const owner = match[1];
  const member = match[2];
  if (!owner || !member) return undefined;
  const carrierOwner = primitiveMemberOwnerTypeName(owner);
  if (carrierOwner === owner) return undefined;
  return members.get(`${carrierOwner}::${member}`);
}

function rewriteEnumMemberReferences(
  program: Program,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  const replacements = enumMemberReplacements(types, diagnostics);
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      decl.params = decl.params.map((param) =>
        rewriteEnumMembersInParam(param, replacements, diagnostics)
      );
      decl.locals = decl.locals?.map((param) =>
        rewriteEnumMembersInParam(param, replacements, diagnostics)
      );
      decl.body = rewriteEnumMembersInBlock(decl.body, replacements, diagnostics);
    }
    if (decl.kind === "let" || decl.kind === "const") {
      decl.value = rewriteEnumMembersInExpr(decl.value, replacements, diagnostics);
    }
  }
}

type EnumMemberReplacement = { type: string; value: string };

function enumMemberReplacements(
  types: TypeDecl[],
  diagnostics?: Diagnostic[],
): Map<string, EnumMemberReplacement> {
  const replacements = new Map<string, EnumMemberReplacement>();
  for (const decl of types) {
    const enumBody = decl.enum;
    if (!enumBody) continue;
    if (decl.params.length > 0) {
      diagnostics?.push({
        code: "type.enum_params",
        message: `enum type ${decl.name} cannot declare type parameters`,
        span: decl.span,
      });
    }
    if (!isIntegerEnumBacking(enumBody.backing)) {
      diagnostics?.push({
        code: "type.enum_backing",
        message: `enum type ${decl.name} must use an integer backing type`,
        span: enumBody.span ?? decl.span,
      });
    }
    const names = new Set<string>();
    for (const variant of enumBody.variants) {
      if (names.has(variant.name)) {
        diagnostics?.push({
          code: "type.duplicate_enum_variant",
          message: `enum type ${decl.name} defines duplicate variant ${variant.name}`,
          span: variant.span,
        });
        continue;
      }
      names.add(variant.name);
      if (!isIntegerEnumValue(variant.value, enumBody.backing)) {
        diagnostics?.push({
          code: "type.enum_value",
          message:
            `enum variant ${decl.name}::${variant.name} must use an integer literal compatible with ${enumBody.backing}`,
          span: variant.span,
        });
      }
      if (!enumValueInBackingDomain(variant.value, enumBody.backing)) {
        diagnostics?.push({
          code: "type.enum_value",
          message:
            `enum variant ${decl.name}::${variant.name} value ${variant.value} is outside ${enumBody.backing}`,
          span: variant.span,
        });
      }
      replacements.set(`${decl.name}::${variant.name}`, { type: decl.name, value: variant.value });
    }
  }
  return replacements;
}

function legacyEnumMemberSuggestion(
  name: string,
  replacements: Map<string, EnumMemberReplacement>,
): string | undefined {
  if (name.includes("::")) return undefined;
  const separator = name.lastIndexOf(".");
  if (separator < 0) return undefined;
  const suggested = `${name.slice(0, separator)}::${name.slice(separator + 1)}`;
  return replacements.has(suggested) ? suggested : undefined;
}

function enumMemberSyntaxDiagnostic(
  name: string,
  suggestion: string,
  spanLike?: { span?: Span },
): Diagnostic {
  return {
    code: "type.enum_member_syntax",
    message: `enum member ${name} uses '.'; use ${suggestion}`,
    span: spanLike?.span,
  };
}

function isIntegerEnumBacking(type: string): boolean {
  const runtime = scalarDomainRuntimeType(type);
  return runtime === "i32" || runtime === "i64" || runtime === "u32" || runtime === "u64";
}

function isIntegerEnumValue(value: string, backing: string): boolean {
  if (value.includes(".")) return false;
  const suffix = value.match(/[a-z][a-z0-9]*$/)?.[0];
  if (!suffix) return true;
  return suffix === scalarDomainRuntimeType(backing);
}

function enumValueInBackingDomain(value: string, backing: string): boolean {
  const domain = parseRefinedI32Type(backing);
  if (!domain) return true;
  const literal = enumIntegerLiteral(value);
  if (literal === undefined) return false;
  return refinedI32ContainsLiteral(backing, literal);
}

function enumIntegerLiteral(value: string): number | undefined {
  if (value.includes(".")) return undefined;
  const match = value.match(/^-?[0-9]+/);
  const source = match?.[0];
  if (!source) return undefined;
  const parsed = Number.parseInt(source, 10);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return parsed;
}

function rewriteEnumMembersInBlock(
  block: Extract<Expr, { kind: "block" }>,
  replacements: Map<string, EnumMemberReplacement>,
  diagnostics: Diagnostic[],
) {
  return {
    ...block,
    statements: block.statements.map((stmt) =>
      rewriteEnumMembersInStatement(stmt, replacements, diagnostics) as Statement
    ),
    expr: block.expr ? rewriteEnumMembersInExpr(block.expr, replacements, diagnostics) : undefined,
  };
}

function rewriteEnumMembersInParam(
  param: Param,
  replacements: Map<string, EnumMemberReplacement>,
  diagnostics: Diagnostic[],
): Param {
  if (!param.pattern) return param;
  return {
    ...param,
    pattern: rewriteEnumMembersInPattern(param.pattern, replacements, diagnostics),
  };
}

function rewriteEnumMembersInStatement(
  stmt: Statement | DoStatement,
  replacements: Map<string, EnumMemberReplacement>,
  diagnostics: Diagnostic[],
): Statement | DoStatement {
  if (stmt.kind === "let") {
    return { ...stmt, value: rewriteEnumMembersInExpr(stmt.value, replacements, diagnostics) };
  }
  if (stmt.kind === "destructure_let") {
    return { ...stmt, value: rewriteEnumMembersInExpr(stmt.value, replacements, diagnostics) };
  }
  if (stmt.kind === "debug_trace") {
    return {
      ...stmt,
      args: stmt.args.map((arg) => rewriteEnumMembersInExpr(arg, replacements, diagnostics)),
    };
  }
  if (stmt.kind === "do_bind" || stmt.kind === "do_expr") {
    return { ...stmt, value: rewriteEnumMembersInExpr(stmt.value, replacements, diagnostics) };
  }
  return stmt;
}

function rewriteEnumMembersInPattern(
  pattern: ParamPattern,
  replacements: Map<string, EnumMemberReplacement>,
  diagnostics: Diagnostic[],
): ParamPattern {
  switch (pattern.kind) {
    case "enum_member": {
      const replacement = replacements.get(pattern.name);
      if (replacement) {
        return {
          kind: "literal",
          span: pattern.span,
          literalKind: "number",
          value: replacement.value,
        };
      }
      const suggestion = legacyEnumMemberSuggestion(pattern.name, replacements);
      if (suggestion) {
        diagnostics.push(enumMemberSyntaxDiagnostic(pattern.name, suggestion, pattern));
        const suggestedReplacement = replacements.get(suggestion)!;
        return {
          kind: "literal",
          span: pattern.span,
          literalKind: "number",
          value: suggestedReplacement.value,
        };
      }
      diagnostics.push({
        code: "type.enum_member",
        message: `unknown enum member ${pattern.name}`,
        span: pattern.span,
      });
      return pattern;
    }
    case "tuple":
      return {
        ...pattern,
        items: pattern.items.map((item) =>
          rewriteEnumMembersInPattern(item, replacements, diagnostics)
        ),
      };
    case "constructor":
      return {
        ...pattern,
        args: pattern.args.map((arg) =>
          rewriteEnumMembersInPattern(arg, replacements, diagnostics)
        ),
      };
    case "or":
      return {
        ...pattern,
        alternatives: pattern.alternatives.map((alternative) =>
          rewriteEnumMembersInPattern(alternative, replacements, diagnostics)
        ),
      };
    case "as":
      return {
        ...pattern,
        pattern: rewriteEnumMembersInPattern(pattern.pattern, replacements, diagnostics),
      };
    case "product":
      return {
        ...pattern,
        fields: pattern.fields.map((field) => ({
          ...field,
          pattern: rewriteEnumMembersInPattern(field.pattern, replacements, diagnostics),
        })),
      };
    case "typed":
      return {
        ...pattern,
        pattern: rewriteEnumMembersInPattern(pattern.pattern, replacements, diagnostics),
      };
    case "binding":
    case "wildcard":
    case "literal":
    case "type":
      return pattern;
  }
}

function rewriteEnumMembersInExpr(
  expr: Expr,
  replacements: Map<string, EnumMemberReplacement>,
  diagnostics: Diagnostic[],
): Expr {
  switch (expr.kind) {
    case "var": {
      const replacement = replacements.get(expr.name);
      if (replacement) {
        return {
          kind: "literal",
          span: expr.span,
          literalKind: "number",
          value: replacement.value,
          inferredType: replacement.type,
        };
      }
      const suggestion = legacyEnumMemberSuggestion(expr.name, replacements);
      if (!suggestion) return expr;
      diagnostics.push(enumMemberSyntaxDiagnostic(expr.name, suggestion, expr));
      const suggestedReplacement = replacements.get(suggestion)!;
      return {
        kind: "literal",
        span: expr.span,
        literalKind: "number",
        value: suggestedReplacement.value,
        inferredType: suggestedReplacement.type,
      };
    }
    case "do":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          rewriteEnumMembersInStatement(stmt, replacements, diagnostics)
        ),
        expr: expr.expr
          ? rewriteEnumMembersInExpr(expr.expr, replacements, diagnostics)
          : undefined,
      };
    case "const_fn":
      return { ...expr, body: rewriteEnumMembersInExpr(expr.body, replacements, diagnostics) };
    case "pipe_bind":
      return {
        ...expr,
        value: rewriteEnumMembersInExpr(expr.value, replacements, diagnostics),
        body: rewriteEnumMembersInExpr(expr.body, replacements, diagnostics),
      };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => rewriteEnumMembersInExpr(arg, replacements, diagnostics)),
        body: rewriteEnumMembersInExpr(expr.body, replacements, diagnostics),
      };
    case "call":
      return {
        ...expr,
        callee: rewriteEnumMembersInExpr(expr.callee, replacements, diagnostics),
        args: expr.args.map((arg) => rewriteEnumMembersInExpr(arg, replacements, diagnostics)),
      };
    case "index":
      return {
        ...expr,
        target: rewriteEnumMembersInExpr(expr.target, replacements, diagnostics),
        index: rewriteEnumMembersInExpr(expr.index, replacements, diagnostics),
      };
    case "binary":
      return {
        ...expr,
        left: rewriteEnumMembersInExpr(expr.left, replacements, diagnostics),
        right: rewriteEnumMembersInExpr(expr.right, replacements, diagnostics),
      };
    case "operator_chain":
      return {
        ...expr,
        first: rewriteEnumMembersInExpr(expr.first, replacements, diagnostics),
        rest: expr.rest.map((item) => ({
          ...item,
          value: rewriteEnumMembersInExpr(item.value, replacements, diagnostics),
        })),
      };
    case "match":
      return {
        ...expr,
        value: rewriteEnumMembersInExpr(expr.value, replacements, diagnostics),
        arms: expr.arms.map((arm) => ({
          ...arm,
          pattern: rewriteEnumMembersInPattern(arm.pattern, replacements, diagnostics),
          guard: arm.guard
            ? rewriteEnumMembersInExpr(arm.guard, replacements, diagnostics)
            : undefined,
          value: rewriteEnumMembersInExpr(arm.value, replacements, diagnostics),
        })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index
            ? rewriteEnumMembersInExpr(slot.index, replacements, diagnostics)
            : undefined,
          value: rewriteEnumMembersInExpr(slot.value, replacements, diagnostics),
        })),
      };
    case "static_for_slots": {
      const source = expr.source.kind === "range"
        ? {
          ...expr.source,
          start: rewriteEnumMembersInExpr(expr.source.start, replacements, diagnostics),
          end: rewriteEnumMembersInExpr(expr.source.end, replacements, diagnostics),
        }
        : {
          ...expr.source,
          shape: rewriteEnumMembersInExpr(expr.source.shape, replacements, diagnostics),
        };
      return {
        ...expr,
        source,
        value: rewriteEnumMembersInExpr(expr.value, replacements, diagnostics),
      };
    }
    case "field":
      return {
        ...expr,
        value: rewriteEnumMembersInExpr(expr.value, replacements, diagnostics),
        key: rewriteEnumMembersInExpr(expr.key, replacements, diagnostics),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index
            ? rewriteEnumMembersInExpr(slot.index, replacements, diagnostics)
            : undefined,
          value: rewriteEnumMembersInExpr(slot.value, replacements, diagnostics),
        })),
      };
    case "range":
      return {
        ...expr,
        start: rewriteEnumMembersInExpr(expr.start, replacements, diagnostics),
        end: rewriteEnumMembersInExpr(expr.end, replacements, diagnostics),
      };
    case "block":
      return rewriteEnumMembersInBlock(expr, replacements, diagnostics);
    case "literal":
      return expr;
  }
}

function rewriteContextualEnumPatternsInMatch(
  expr: Extract<Expr, { kind: "match" }>,
  matchValueType: string | undefined,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  if (!matchValueType) return;
  const replacements = enumMemberReplacements(types);
  expr.arms = expr.arms.map((arm) => ({
    ...arm,
    pattern: rewriteContextualEnumPattern(
      arm.pattern,
      matchValueType,
      types,
      replacements,
      diagnostics,
    ),
  }));
}

function rewriteContextualEnumPattern(
  pattern: ParamPattern,
  valueType: string | undefined,
  types: TypeDecl[],
  replacements: Map<string, EnumMemberReplacement>,
  diagnostics: Diagnostic[],
): ParamPattern {
  if (!valueType) return pattern;
  switch (pattern.kind) {
    case "typed":
      return {
        ...pattern,
        pattern: rewriteContextualEnumPattern(
          pattern.pattern,
          pattern.type,
          types,
          replacements,
          diagnostics,
        ),
      };
    case "tuple": {
      const slots = runtimeSlotTypes(valueType, types);
      return {
        ...pattern,
        items: pattern.items.map((item, index) =>
          rewriteContextualEnumPattern(
            item,
            slots[index] ?? undefined,
            types,
            replacements,
            diagnostics,
          )
        ),
      };
    }
    case "constructor":
      return rewriteContextualEnumConstructorPattern(
        pattern,
        valueType,
        types,
        replacements,
        diagnostics,
      );
    case "or":
      return {
        ...pattern,
        alternatives: pattern.alternatives.map((alternative) =>
          rewriteContextualEnumPattern(alternative, valueType, types, replacements, diagnostics)
        ),
      };
    case "as":
      return {
        ...pattern,
        pattern: rewriteContextualEnumPattern(
          pattern.pattern,
          valueType,
          types,
          replacements,
          diagnostics,
        ),
      };
    case "product": {
      const slots = structuralProductSlotsForType(valueType, types) ?? [];
      return {
        ...pattern,
        fields: pattern.fields.map((field) => ({
          ...field,
          pattern: rewriteContextualEnumPattern(
            field.pattern,
            slots.find((slot) => slot.label === field.label)?.type,
            types,
            replacements,
            diagnostics,
          ),
        })),
      };
    }
    case "enum_member":
      return rewriteEnumMembersInPattern(pattern, replacements, diagnostics);
    case "binding":
    case "wildcard":
    case "literal":
    case "type":
      return pattern;
  }
}

function rewriteContextualEnumConstructorPattern(
  pattern: Extract<ParamPattern, { kind: "constructor" }>,
  valueType: string,
  types: TypeDecl[],
  replacements: Map<string, EnumMemberReplacement>,
  diagnostics: Diagnostic[],
): ParamPattern {
  const enumDecl = enumDeclForPatternType(valueType, types);
  if (!enumDecl?.enum) return pattern;
  const patternName = terminalName(pattern.name);
  const variant = enumDecl.enum.variants.find((item) => item.name === patternName);
  if (!variant) {
    diagnostics.push({
      code: "type.enum_member",
      message: `enum type ${enumDecl.name} has no member ${pattern.name}`,
      span: pattern.span,
    });
    return pattern;
  }
  if (pattern.args.length > 0) {
    diagnostics.push({
      code: "type.enum_member",
      message: `enum member ${enumDecl.name}::${variant.name} does not bind payloads`,
      span: pattern.span,
    });
  }
  const replacement = replacements.get(`${enumDecl.name}::${variant.name}`);
  return {
    kind: "literal",
    span: pattern.span,
    literalKind: "number",
    value: replacement?.value ?? variant.value,
  };
}

function enumDeclForPatternType(
  valueType: string | undefined,
  types: TypeDecl[],
): TypeDecl | undefined {
  if (!valueType) return undefined;
  const decl = findTypeDecl(types, typeNameOf(valueType));
  return decl?.enum ? decl : undefined;
}

function checkConstDictionaries(
  consts: ConstDecl[],
  types: TypeDecl[],
  functionDecls: FnDecl[],
  hostIoImports: Map<string, string[]>,
  functions: Set<string>,
  diagnostics: Diagnostic[],
) {
  const typesByName = new Map(types.map((decl) => [decl.name, decl]));
  const functionsByName = new Map(functionDecls.map((decl) => [decl.name, decl]));
  for (const decl of consts) {
    if (hasConstEvaluationDiagnosticForDecl(decl, diagnostics)) {
      continue;
    }
    if (
      decl.value.kind === "shape" && decl.value.inferredType &&
      isRuntimeProductConstType(
        decl.type ?? decl.value.inferredType,
        typesByName,
        functionsByName,
        hostIoImports,
        diagnostics,
      )
    ) {
      continue;
    }
    if (decl.value.kind !== "shape") {
      const expectedLiteralType = decl.type
        ? constLiteralAnnotationType(
          decl,
          types,
          typesByName,
          functionsByName,
          hostIoImports,
          diagnostics,
        )
        : undefined;
      if (
        decl.value.kind === "literal" && expectedLiteralType &&
        literalTypeMembers(expectedLiteralType)
      ) {
        if (!literalExprFitsType(decl.value, expectedLiteralType)) {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `literal ${decl.value.value} is not assignable to ${decl.type}`,
            decl.value,
          ));
        }
        continue;
      }
      if (isRuntimeScalarConstInitializer(decl)) {
        continue;
      }
      if (
        isRuntimeProductConstInitializer(
          decl,
          typesByName,
          functionsByName,
          hostIoImports,
          diagnostics,
        )
      ) {
        continue;
      }
      if (!isScalarConstInitializer(decl)) {
        diagnostics.push({
          code: "type.const_shape",
          message: `const ${decl.name} must be initialized with a shape literal`,
        });
      }
      continue;
    }
    if (!decl.type && isTypeReferenceShape(decl.value, typesByName)) {
      checkDuplicateConstShapeLabels(decl.name, decl.value, diagnostics);
      continue;
    }
    if (!decl.type && !isFunctionDictionaryShape(decl.value)) {
      checkDuplicateConstShapeLabels(decl.name, decl.value, diagnostics);
      continue;
    }
    if (!decl.type) {
      diagnostics.push({
        code: "type.const_annotation",
        message: `const ${decl.name} requires an explicit type annotation`,
      });
    }
    if (decl.type) {
      checkConstDictionaryShape(decl, typesByName, functionsByName, hostIoImports, diagnostics);
    }
    const labels = new Set<string>();
    for (const slot of decl.value.slots) {
      if (slot.label) {
        if (labels.has(slot.label)) {
          diagnostics.push({
            code: "type.duplicate_const_slot",
            message: `const ${decl.name} defines duplicate slot ${slot.label}`,
          });
        }
        labels.add(slot.label);
      }
      if (
        slot.value.kind !== "var" || slot.value.name.includes(".") || slot.value.name.includes("[")
      ) {
        diagnostics.push({
          code: "type.const_slot_function",
          message: `const ${decl.name} slot ${
            slot.label ?? "<anonymous>"
          } must reference a top-level function`,
        });
        continue;
      }
      if (!functions.has(slot.value.name)) {
        diagnostics.push({
          code: "type.unknown_const_function",
          message: `const ${decl.name} references unknown function ${slot.value.name}`,
        });
      }
    }
  }
}

function isFunctionDictionaryShape(value: Extract<Expr, { kind: "shape" }>): boolean {
  return value.slots.every((slot) => slot.value.kind === "var");
}

function isTypeReferenceShape(
  value: Extract<Expr, { kind: "shape" }>,
  typesByName: Map<string, TypeDecl>,
): boolean {
  return value.slots.length > 0 &&
    value.slots.every((slot) => slot.value.kind === "var" && typesByName.has(slot.value.name));
}

function checkDuplicateConstShapeLabels(
  name: string,
  value: Extract<Expr, { kind: "shape" }>,
  diagnostics: Diagnostic[],
) {
  const labels = new Set<string>();
  for (const slot of value.slots) {
    if (!slot.label) continue;
    if (labels.has(slot.label)) {
      diagnostics.push({
        code: "type.duplicate_const_slot",
        message: `const ${name} defines duplicate slot ${slot.label}`,
      });
    }
    labels.add(slot.label);
  }
}

function hasConstEvaluationDiagnosticForDecl(decl: ConstDecl, diagnostics: Diagnostic[]): boolean {
  const span = decl.value.span ?? decl.span;
  return diagnostics.some((diagnostic) =>
    diagnostic.code.startsWith("const.") &&
    (diagnostic.span && span ? spansOverlap(diagnostic.span, span) : !diagnostic.span && !span)
  );
}

function spansOverlap(left: Span, right: Span): boolean {
  return left.start < right.end && right.start < left.end;
}

function removeConstShapeSlotFallbackDiagnostics(
  diagnostics: Diagnostic[],
  start: number,
) {
  for (let index = diagnostics.length - 1; index >= start; index--) {
    if (diagnostics[index]?.code === "const.unknown_name") diagnostics.splice(index, 1);
  }
}

function constLiteralAnnotationType(
  decl: ConstDecl,
  types: TypeDecl[],
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  hostIoImports: Map<string, string[]>,
  diagnostics: Diagnostic[],
): string | undefined {
  if (!decl.type) return undefined;
  const resolved = resolveAliasType(decl.type, types) ?? decl.type;
  if (literalTypeMembers(resolved)) return resolved;
  const normalized = instantiateAnnotation(
    decl.type,
    typesByName,
    functions,
    hostIoImports,
    new Map(),
    diagnostics,
    decl.span,
  );
  if (normalized?.kind === "alias" && literalTypeMembers(normalized.type)) {
    return normalized.type;
  }
  return resolved;
}

function isScalarConstInitializer(decl: ConstDecl): boolean {
  if (!decl.type || decl.value.kind !== "literal") return false;
  const type = decl.type.trim();
  if (decl.value.literalKind === "number") return type === "i32" || type === "count";
  if (decl.value.literalKind === "bool") return type === "bool";
  if (decl.value.literalKind === "string" || decl.value.literalKind === "multiline") {
    return type === "string" || type === "multiline";
  }
  if (decl.value.literalKind === "char") return type === "char";
  if (decl.value.literalKind === "literalType") return type === "literal";
  return false;
}

function isRuntimeScalarConstInitializer(decl: ConstDecl): boolean {
  if (decl.value.kind !== "literal") return false;
  if (decl.value.literalKind === "number") return true;
  if (decl.value.literalKind === "bool") return true;
  if (decl.value.literalKind === "string" || decl.value.literalKind === "multiline") return true;
  if (decl.value.literalKind === "char") return true;
  if (decl.value.literalKind === "literalType") return true;
  return false;
}

function isRuntimeProductConstInitializer(
  decl: ConstDecl,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  hostIoImports: Map<string, string[]>,
  diagnostics: Diagnostic[],
): boolean {
  if (!decl.type || decl.value.kind !== "product_constructor") return false;
  return isRuntimeProductConstType(decl.type, typesByName, functions, hostIoImports, diagnostics);
}

function isRuntimeProductConstType(
  type: string | undefined,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  hostIoImports: Map<string, string[]>,
  diagnostics: Diagnostic[],
): boolean {
  if (!type) return false;
  const normalized = instantiateAnnotation(
    type,
    typesByName,
    functions,
    hostIoImports,
    new Map(),
    diagnostics,
  );
  return normalized?.kind === "product";
}

function checkConstDictionaryShape(
  decl: ConstDecl,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  hostIoImports: Map<string, string[]>,
  diagnostics: Diagnostic[],
) {
  const normalized = decl.type
    ? instantiateAnnotation(
      decl.type,
      typesByName,
      functions,
      hostIoImports,
      new Map(),
      diagnostics,
      decl.span,
    )
    : undefined;
  if (normalized?.kind !== "product") {
    diagnostics.push({
      code: "type.const_dictionary_type",
      message:
        `const ${decl.name} annotation ${decl.type} does not resolve to a dictionary product type`,
    });
    return;
  }

  const actual = new Set<string>();
  for (const slot of decl.value.kind === "shape" ? decl.value.slots : []) {
    if (!slot.label) {
      diagnostics.push({
        code: "type.const_unknown_slot",
        message: `const ${decl.name} defines unknown dictionary slot <anonymous>`,
      });
      continue;
    }
    actual.add(slot.label);
  }

  const expected = new Set(
    normalized.shape.slots
      .map((slot) => slot.label)
      .filter((label): label is string => label !== undefined),
  );
  for (const label of expected) {
    if (!actual.has(label)) {
      diagnostics.push({
        code: "type.const_missing_slot",
        message: `const ${decl.name} is missing dictionary slot ${label}`,
      });
    }
  }
  for (const label of actual) {
    if (!expected.has(label)) {
      diagnostics.push({
        code: "type.const_unknown_slot",
        message: `const ${decl.name} defines unknown dictionary slot ${label}`,
      });
    }
  }
}

type ConstValue =
  & (
    | { kind: "never" }
    | { kind: "bool"; value: boolean }
    | { kind: "number"; value: string }
    | { kind: "char"; value: string }
    | { kind: "string"; value: string }
    | { kind: "literal_type"; value: string }
    | { kind: "type"; name: string; normalized?: TypeBody }
    | { kind: "fn"; name: string }
    | {
      kind: "product";
      constructor: string;
      slots: { label?: string; value: ConstValue }[];
    }
    | { kind: "shape"; slots: { label?: string; value: ConstValue }[]; runtime?: boolean }
  )
  & { type?: string; span?: Span };

function decodeStringLiteralValue(source: string): string {
  return JSON.parse(source);
}

function evaluateConstDecls(
  consts: ConstDecl[],
  types: TypeDecl[],
  functions: FnDecl[],
  hostIoImports: Map<string, string[]>,
  addShader: (source: string) => ShaderManifestEntry,
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
): Map<string, ConstValue> {
  const byConst = new Map(consts.map((decl) => [decl.name, decl]));
  const values = new Map<string, ConstValue>();
  const state = new Map<string, "evaluating" | "done">();
  const typeValues = new Map<string, ConstValue>();
  for (
    const name of [
      "i32",
      "u32",
      "i64",
      "u64",
      "f32",
      "f64",
      "bool",
      "string",
      ...Array.from({ length: 64 }, (_, index) => `u${index + 1}`),
    ]
  ) {
    typeValues.set(name, { kind: "type", name });
  }
  for (const decl of types) {
    typeValues.set(decl.name, { kind: "type", name: decl.name, normalized: decl.normalized });
  }
  const byFn = new Map(functions.map((decl) => [decl.name, decl]));
  const evaluator = new ConstEvaluator(
    typeValues,
    new Map(types.map((decl) => [decl.name, decl])),
    byFn,
    hostIoImports,
    addShader,
    diagnostics,
    (name) => evaluateConst(name),
    pluginRegistry,
  );

  const evaluateConst = (name: string): ConstValue | undefined => {
    const decl = byConst.get(name);
    if (!decl) return undefined;
    const current = state.get(name);
    if (current === "evaluating") {
      diagnostics.push({
        code: "const.cycle",
        message: `const dependency cycle involving ${name}`,
      });
      return undefined;
    }
    if (current === "done") return values.get(name);
    state.set(name, "evaluating");
    const value = evaluator.evalExpr(decl.value, new Map(), [], decl.value.span ?? decl.span);
    if (value) {
      value.type = decl.type ?? value.type;
      values.set(name, value);
      const expr = constValueToExpr(value);
      if (expr) decl.value = expr;
    }
    state.set(name, "done");
    return value;
  };

  for (const decl of consts) evaluateConst(decl.name);
  return values;
}

class ConstEvaluator {
  private diagnosticSpan?: Span;

  constructor(
    private types: Map<string, ConstValue>,
    private typesByName: Map<string, TypeDecl>,
    private functions: Map<string, FnDecl>,
    private hostIoImports: Map<string, string[]>,
    private addShader: (source: string) => ShaderManifestEntry,
    private diagnostics: Diagnostic[],
    private constLookup: (name: string) => ConstValue | undefined,
    private pluginRegistry: CompilerPluginRegistry,
  ) {}

  evalExpr(
    expr: Expr,
    locals: Map<string, ConstValue>,
    callStack: string[],
    diagnosticSpan?: Span,
  ): ConstValue | undefined {
    if (diagnosticSpan) {
      const previous = this.diagnosticSpan;
      this.diagnosticSpan = diagnosticSpan;
      const value = this.evalExpr(expr, locals, callStack);
      this.diagnosticSpan = previous;
      return value;
    }
    switch (expr.kind) {
      case "literal":
        if (expr.literalKind === "bool") {
          return this.withSpan({
            kind: "bool",
            value: expr.value === "true",
            ...(expr.inferredType ? { type: expr.inferredType } : {}),
          }, expr.span);
        }
        if (expr.literalKind === "number") {
          return this.withSpan({
            kind: "number",
            value: expr.value,
            ...(expr.inferredType ? { type: expr.inferredType } : {}),
          }, expr.span);
        }
        if (expr.literalKind === "literalType") {
          return this.withSpan({
            kind: "literal_type",
            value: expr.value.slice(1),
            ...(expr.inferredType ? { type: expr.inferredType } : {}),
          }, expr.span);
        }
        if (expr.literalKind === "string") {
          return this.withSpan({
            kind: "string",
            value: decodeStringLiteralValue(expr.value),
            ...(expr.inferredType ? { type: expr.inferredType } : {}),
          }, expr.span);
        }
        if (expr.literalKind === "multiline") {
          return this.withSpan({
            kind: "string",
            value: expr.value,
            ...(expr.inferredType ? { type: expr.inferredType } : {}),
          }, expr.span);
        }
        if (expr.literalKind === "char") {
          return this.withSpan({
            kind: "char",
            value: JSON.parse(`"${expr.value.slice(1, -1)}"`),
            ...(expr.inferredType ? { type: expr.inferredType } : {}),
          }, expr.span);
        }
        return this.unsupported(
          "const.unsupported_expr",
          "unsupported literal in const evaluation",
        );
      case "var":
        return this.evalVar(expr.name, locals);
      case "shape":
        const slots: { label?: string; value: ConstValue }[] = [];
        for (const slot of expr.slots) {
          const diagnosticStart = this.diagnostics.length;
          const value = this.withSpan(
            this.evalExpr(slot.value, locals, callStack) ?? { kind: "never" },
            slot.value.span,
          );
          if (value.kind === "never") {
            removeConstShapeSlotFallbackDiagnostics(this.diagnostics, diagnosticStart);
            return undefined;
          }
          slots.push({ label: slot.label, value });
        }
        return {
          kind: "shape",
          span: expr.span,
          ...(expr.inferredType ? { type: expr.inferredType, runtime: true } : {}),
          slots,
        };
      case "product_constructor":
        return this.evalProductConstructor(expr, locals, callStack);
      case "call":
        return this.evalCall(expr, locals, callStack);
      case "binary":
        return this.evalBinary(expr, locals, callStack);
      case "operator_chain":
        return this.evalExpr(
          buildOperatorTree(
            [expr.first, ...expr.rest.map((item) => item.value)],
            expr.rest.map((item) => item.op),
            EMPTY_OPERATOR_MAP,
            this.diagnostics,
            expr,
          ),
          locals,
          callStack,
        );
      case "pipe_bind": {
        const value = this.evalExpr(expr.value, locals, callStack);
        if (!value) return undefined;
        return this.evalExpr(expr.body, new Map(locals).set(expr.name, value), callStack);
      }
      case "block":
        return this.evalBlock(expr, new Map(locals), callStack);
      case "match": {
        const value = this.evalExpr(expr.value, locals, callStack);
        if (!value) return undefined;
        const arm = expr.arms.find((arm) => constPatternMatches(arm.pattern, value));
        if (!arm) {
          return this.unsupported("const.unsupported_expr", "const match has no matching arm");
        }
        return this.evalExpr(arm.value, new Map(locals), callStack);
      }
      case "range":
        return this.unsupported("const.unsupported_expr", `${expr.kind} is not const-evaluable`);
    }
  }

  private evalBlock(
    block: Extract<Expr, { kind: "block" }>,
    locals: Map<string, ConstValue>,
    callStack: string[],
  ): ConstValue | undefined {
    if (block.statements.some((stmt) => stmt.kind !== "let" && stmt.kind !== "type_assert")) {
      return this.unsupported("const.unsupported_expr", "unsupported const block statement");
    }
    const ordered = orderBlockStatements(block.statements, this.diagnostics);
    for (const stmt of ordered) {
      if (stmt.kind === "let") {
        const value = this.evalExpr(stmt.value, locals, callStack);
        if (!value) return undefined;
        locals.set(stmt.name, value);
      }
    }
    return block.expr ? this.evalExpr(block.expr, locals, callStack) : undefined;
  }

  private evalProductConstructor(
    expr: Extract<Expr, { kind: "product_constructor" }>,
    locals: Map<string, ConstValue>,
    callStack: string[],
  ): ConstValue | undefined {
    const slots: { label?: string; value: ConstValue }[] = [];
    for (const slot of expr.slots) {
      const value = this.withSpan(
        this.evalExpr(slot.value, locals, callStack) ?? { kind: "never" },
        slot.value.span,
      );
      if (value.kind === "never") return value;
      if (slot.spread) {
        if (value.kind === "product" || value.kind === "shape") {
          slots.push(...value.slots.map((item) => ({ label: item.label, value: item.value })));
          continue;
        }
        this.report(
          "const.unsupported_expr",
          "const product spread requires a const product or shape value",
          slot.value.span,
        );
        return undefined;
      }
      slots.push({ label: slot.label, value });
    }
    return {
      kind: "product",
      constructor: expr.constructor,
      slots,
      span: expr.span,
    };
  }

  private evalVar(name: string, locals: Map<string, ConstValue>): ConstValue | undefined {
    if (name === "@field") return { kind: "never" };
    const direct = locals.get(name) ?? this.constLookup(name) ?? this.types.get(name);
    if (direct) return direct;
    if (isKnownTypeProof(name, [...this.typesByName.values()]) || name.startsWith("fn(")) {
      return { kind: "type", name };
    }
    const fn = this.functions.get(name);
    if (fn) return { kind: "fn", name };
    const dot = name.lastIndexOf(".");
    if (dot >= 0) {
      const base = this.evalVar(name.slice(0, dot), locals);
      const field = name.slice(dot + 1);
      if (base?.kind === "never") return base;
      if (base?.kind === "shape" || base?.kind === "product") {
        const slot = base.slots.findLast((item) => item.label === field);
        if (slot) return slot.value;
      }
    }
    return this.unsupported("const.unknown_name", `unknown const-evaluable name ${name}`);
  }

  private evalCall(
    expr: Extract<Expr, { kind: "call" }>,
    locals: Map<string, ConstValue>,
    callStack: string[],
  ): ConstValue | undefined {
    if (expr.callee.kind !== "var") {
      return this.unsupported("const.unsupported_expr", "const calls require a named callee");
    }
    const name = expr.callee.name;
    const args: ConstValue[] = expr.args.map((arg) =>
      this.withSpan(this.evalExpr(arg, locals, callStack) ?? { kind: "never" }, arg.span)
    );
    if (args.some((arg) => arg.kind === "never")) return { kind: "never" };
    const builtin = this.evalBuiltin(name, args);
    if (builtin) return builtin;
    const typeValue = this.types.get(name);
    if (typeValue?.kind === "type") {
      return {
        kind: "type",
        name: args.length ? `${name}(${args.map(renderConstTypeArg).join(", ")})` : name,
        normalized: typeValue.normalized,
        span: expr.span,
      };
    }
    if (this.hostIoImports.has(name)) {
      return this.unsupported(
        "const.runtime_call",
        `cannot call imported host IO function ${name} during const evaluation`,
      );
    }
    const fn = this.functions.get(name);
    if (!fn) {
      return this.unsupported(
        "const.runtime_call",
        `cannot call unknown function ${name} during const evaluation`,
      );
    }
    if (callStack.includes(name)) {
      return this.unsupported(
        "const.recursive_call",
        `recursive const helper call ${[...callStack, name].join(" -> ")}`,
      );
    }
    if (fn.effects.length) {
      return this.unsupported(
        "const.runtime_call",
        `cannot call effectful function ${name} during const evaluation`,
      );
    }
    const fnLocals = new Map<string, ConstValue>();
    const fnQualifier = fn.name.includes(".") ? fn.name.slice(0, fn.name.lastIndexOf(".")) : "";
    fn.params.forEach((param, index) => {
      const value = args[index] ?? { kind: "never" };
      fnLocals.set(param.name, value);
      if (fnQualifier) fnLocals.set(`${fnQualifier}.${param.name}`, value);
    });
    const value = this.evalBlock(fn.body, fnLocals, [...callStack, name]);
    if (!value || !fn.returnType) return value;
    const staticBindings = new Map<string, string>();
    fn.params.forEach((param, index) => {
      if (!param.const) return;
      const arg = args[index];
      if (arg) staticBindings.set(param.name, renderConstTypeArg(arg));
    });
    const returnType = substituteTypeVars(fn.returnType, staticBindings);
    const runtimeShape = value.kind === "shape" &&
      isRuntimeProductConstType(
        returnType,
        this.typesByName,
        this.functions,
        this.hostIoImports,
        this.diagnostics,
      );
    return { ...value, type: returnType, ...(runtimeShape ? { runtime: true } : {}) };
  }

  private evalBuiltin(name: string, args: ConstValue[]): ConstValue | undefined {
    const pluginBuiltin = this.pluginRegistry.staticBuiltins.get(staticBuiltinName(name));
    const pluginValue = pluginBuiltin?.evaluateConst?.(args, {
      addShader: this.addShader,
      report: (diagnostic) => this.diagnostics.push(diagnostic),
    });
    if (pluginValue) return pluginValue as ConstValue;
    if (name.startsWith("@")) name = name.slice(1);
    if (name === "field") {
      const source = args[0];
      const label = literalName(args[1]);
      if ((source?.kind === "shape" || source?.kind === "product") && label) {
        const slot = source.slots.findLast((item) => item.label === label);
        if (slot) return slot.value;
        this.report(
          "type.unknown_shape_slot",
          `unknown shape slot ${label}`,
          args[1]?.span ?? args[0]?.span,
        );
      }
      return { kind: "never" };
    }
    if (name === "compile_error") {
      const message = args[0]?.kind === "string" ? args[0].value : "compile-time error";
      this.report("const.compile_error", message, args[0]?.span);
      return { kind: "never" };
    }
    if (name === "wgsl_shader_id") {
      const source = args[0]?.kind === "string" ? args[0].value : undefined;
      if (source === undefined) return undefined;
      this.addShader(source);
      return { kind: "number", value: String(wgslShaderId(source)) };
    }
    const shape = args[0]?.kind === "shape" ? args[0] : undefined;
    if (shape) {
      if (name === "shape_has_slot") {
        const label = literalName(args[1]);
        return { kind: "bool", value: !!shape.slots.find((slot) => slot.label === label) };
      }
      if (name === "shape_slot") {
        const label = literalName(args[1]);
        const slot = shape.slots.find((slot) => slot.label === label);
        if (!slot) {
          this.report(
            "type.unknown_shape_slot",
            `unknown shape slot ${label ?? "<unknown>"}`,
            args[1]?.span ?? args[0]?.span,
          );
          return { kind: "never" };
        }
        return slot.value;
      }
      if (name === "shape_count") return { kind: "number", value: String(shape.slots.length) };
      if (name === "shape_first_key") {
        const first = shape.slots[0];
        if (!first?.label) {
          this.report(
            "type.shape_empty",
            "@shape_first_key requires a non-empty labeled shape",
            args[0]?.span,
          );
          return { kind: "never" };
        }
        return { kind: "literal_type", value: first.label };
      }
      if (name === "shape_tail") {
        if (!shape.slots.length) {
          this.report("type.shape_empty", "@shape_tail requires a non-empty shape", args[0]?.span);
          return { kind: "never" };
        }
        return { kind: "shape", slots: shape.slots.slice(1) };
      }
      if (name === "shape_pick" || name === "shape_intersect") {
        const labels = constSelectorLabels(args[1]);
        if (!labels) return undefined;
        return {
          kind: "shape",
          slots: shape.slots.filter((slot) => slot.label && labels.has(slot.label)),
        };
      }
      if (name === "shape_omit" || name === "shape_difference") {
        const labels = constSelectorLabels(args[1]);
        if (!labels) return undefined;
        return {
          kind: "shape",
          slots: shape.slots.filter((slot) => !slot.label || !labels.has(slot.label)),
        };
      }
      if (name === "shape_rename") {
        const renames = args[1]?.kind === "shape" ? args[1] : undefined;
        if (!renames) return undefined;
        const renameByOld = new Map<string, string>();
        for (const slot of renames.slots) {
          const next = literalName(slot.value);
          if (!slot.label || next === undefined) return undefined;
          renameByOld.set(slot.label, next);
        }
        const slots = shape.slots.map((slot) => ({
          ...slot,
          label: slot.label ? renameByOld.get(slot.label) ?? slot.label : slot.label,
        }));
        const seen = new Set<string>();
        for (const slot of slots) {
          if (!slot.label) continue;
          if (seen.has(slot.label)) {
            this.report(
              "type.shape_rename_duplicate",
              `@shape_rename defines duplicate field ${slot.label}`,
              args[1]?.span ?? args[0]?.span,
            );
            return { kind: "never" };
          }
          seen.add(slot.label);
        }
        return { kind: "shape", slots };
      }
    }
    if (name === "type_list_contains") {
      const list = constTypeList(args[0], "@type_list_contains", this.diagnostics);
      if (!list) return undefined;
      const item = args[1];
      return { kind: "bool", value: !!item && constListIndex(list, item) >= 0 };
    }
    if (name === "type_list_contains_all") {
      const required = constTypeList(args[0], "@type_list_contains_all", this.diagnostics);
      const available = constTypeList(args[1], "@type_list_contains_all", this.diagnostics);
      if (!required || !available) return undefined;
      return {
        kind: "bool",
        value: required.slots.every((slot) => constListIndex(available, slot.value) >= 0),
      };
    }
    if (name === "type_list_index") {
      const list = constTypeList(args[0], "@type_list_index", this.diagnostics);
      if (!list) return undefined;
      const item = args[1];
      const index = item ? constListIndex(list, item) : -1;
      if (index < 0) {
        this.report(
          "type.list_member",
          `@type_list_index could not find ${item ? renderConstTypeArg(item) : "<missing>"}`,
          item?.span ?? args[0]?.span,
        );
        return { kind: "never" };
      }
      return { kind: "number", value: String(index) };
    }
    if (name === "type_list_append") {
      const left = constTypeList(args[0], "@type_list_append", this.diagnostics);
      const right = constTypeList(args[1], "@type_list_append", this.diagnostics);
      if (!left || !right) return undefined;
      return { kind: "shape", slots: [...left.slots, ...right.slots] };
    }
    if (name === "type_list_remove") {
      const list = constTypeList(args[0], "@type_list_remove", this.diagnostics);
      const item = args[1];
      if (!list || !item) return undefined;
      const itemKey = constValueKey(item);
      return {
        kind: "shape",
        slots: list.slots.filter((slot) => constValueKey(slot.value) !== itemKey),
      };
    }
    if (name === "type_list_unique") {
      const list = constTypeList(args[0], "@type_list_unique", this.diagnostics);
      return list ? constUniqueList(list) : undefined;
    }
    if (name === "type_list_is_unique") {
      const list = constTypeList(args[0], "@type_list_is_unique", this.diagnostics);
      return list
        ? { kind: "bool", value: constUniqueList(list).slots.length === list.slots.length }
        : undefined;
    }
    const domainBuiltin = evalConstDomainBuiltin(
      name,
      args,
      [...this.typesByName.values()],
      (diagnostic) => {
        this.report(
          diagnostic.code,
          diagnostic.message,
          diagnostic.span,
        );
      },
    );
    if (domainBuiltin) return domainBuiltin;
    const type = args[0]?.kind === "type" ? this.resolveType(args[0]) : undefined;
    if (!type) return undefined;
    if (name === "type_is_product") {
      return { kind: "bool", value: type.normalized?.kind === "product" };
    }
    if (name === "type_is_sum") return { kind: "bool", value: type.normalized?.kind === "sum" };
    if (name === "type_is_alias") return { kind: "bool", value: type.normalized?.kind === "alias" };
    if (name === "type_is_number") return { kind: "bool", value: isNumericType(type.name) };
    if (name === "type_has_slot") {
      return { kind: "bool", value: hasProductSlot(type, args[1]) };
    }
    if (name === "type_slot_type") {
      const slot = productSlot(type, args[1]);
      if (!slot) {
        this.report(
          "const.unknown_type_slot",
          `unknown type slot ${literalName(args[1]) ?? "<unknown>"}`,
          args[1]?.span ?? args[0]?.span,
        );
        return { kind: "never" };
      }
      return {
        kind: "type",
        name: slot.type,
        normalized: this.types.get(slot.type)?.kind === "type"
          ? this.resolveType(this.types.get(slot.type) as Extract<ConstValue, { kind: "type" }>)
            ?.normalized
          : undefined,
      };
    }
    if (name === "type_members") return constTypeMembers(type, this.typesByName);
    if (name === "type_member_target") {
      const member = constTypeMember(type, args[1], this.typesByName);
      if (!member) {
        this.report(
          "type.unknown_type_member",
          `unknown type member ${literalName(args[1]) ?? "<unknown>"}`,
          args[1]?.span ?? args[0]?.span,
        );
        return { kind: "never" };
      }
      return this.functions.has(member.target)
        ? { kind: "fn", name: member.target }
        : { kind: "string", value: member.target };
    }
    const fn = parseFnSignatureDetailed(args[0]?.kind === "type" ? args[0].name : "");
    if (name === "type_is_fn") return { kind: "bool", value: !!fn };
    if (name === "type_fn_params") return fn ? constFnParamsValue(fn) : undefined;
    if (name === "type_fn_return") return fn ? { kind: "type", name: fn.returnType } : undefined;
    if (name === "type_fn_param_count") {
      return fn ? { kind: "number", value: String(fn.params.length) } : undefined;
    }
    const scalar = args[0]?.kind === "type" ? scalarReflection(args[0].name) : undefined;
    if (name === "type_is_scalar") return { kind: "bool", value: !!scalar };
    if (name === "type_is_refined_scalar") {
      return {
        kind: "bool",
        value: args[0]?.kind === "type" && !!parseRefinedI32Type(args[0].name),
      };
    }
    if (name === "type_scalar_carrier") {
      return scalar ? { kind: "literal_type", value: scalar.carrier } : undefined;
    }
    if (name === "type_scalar_min") {
      return scalar?.min !== undefined ? { kind: "number", value: String(scalar.min) } : undefined;
    }
    if (name === "type_scalar_max") {
      return scalar?.max !== undefined ? { kind: "number", value: String(scalar.max) } : undefined;
    }
    if (name === "type_scalar_bit_width") {
      return scalar?.bitWidth !== undefined
        ? { kind: "number", value: String(scalar.bitWidth) }
        : undefined;
    }
    if (name === "type_scalar_signed") {
      return scalar ? { kind: "bool", value: scalar.signed } : undefined;
    }
    if (name === "type_scalar_domain") return scalar ? scalarDomainConstValue(scalar) : undefined;
    const typeName = args[0]?.kind === "type" ? args[0].name : "";
    const typeDecls = [...this.typesByName.values()];
    if (name === "type_is_inline_array") {
      return { kind: "bool", value: !!inlineArrayLikeTypeArgs(typeName, typeDecls) };
    }
    if (name === "type_inline_array_len") {
      const array = inlineArrayLikeTypeArgs(typeName, typeDecls);
      return array ? { kind: "number", value: String(array.count) } : undefined;
    }
    if (name === "type_inline_array_item") {
      const array = inlineArrayLikeTypeArgs(typeName, typeDecls);
      return array ? { kind: "type", name: array.itemType } : undefined;
    }
    if (name === "type_storage_kind") {
      return {
        kind: "literal_type",
        value: renderTypeEvalValue(typeStorageKindValue(constToTypeEvalValue(args[0]!), typeDecls))
          .slice(1),
      };
    }
    if (name === "type_layout") return typeLayoutConstValue(typeName, typeDecls);
    if (name === "type_flat_slot_count") {
      return { kind: "number", value: String(flatTypeSlots(typeName, typeDecls).length) };
    }
    if (name === "type_flat_slots") return typeFlatSlotsConstValue(typeName, typeDecls);
    if (name === "type_size_bits") {
      const bits = typeSizeBits(typeName, typeDecls);
      return bits === undefined ? undefined : { kind: "number", value: String(bits) };
    }
    if (name === "type_align_bits") {
      const bits = typeAlignBits(typeName, typeDecls);
      return bits === undefined ? undefined : { kind: "number", value: String(bits) };
    }
    if (name === "type_has_variant") {
      const variant = literalName(args[1]);
      return {
        kind: "bool",
        value: type.normalized?.kind === "sum" &&
          !!type.normalized.variants.find((item) => item.name === variant),
      };
    }
    if (name === "type_variant_has_slot") {
      const variant = literalName(args[1]);
      const slot = literalName(args[2]);
      const found = type.normalized?.kind === "sum"
        ? type.normalized.variants.find((item) => item.name === variant)
        : undefined;
      return { kind: "bool", value: !!found?.shape?.slots.find((item) => item.label === slot) };
    }
    if (name === "type_variant_count") {
      return {
        kind: "number",
        value: String(type.normalized?.kind === "sum" ? type.normalized.variants.length : 0),
      };
    }
    if (name === "type_variant_tag_type") {
      const count = type.normalized?.kind === "sum" ? type.normalized.variants.length : 0;
      return { kind: "type", name: count <= 1 ? "u1" : `u${Math.ceil(Math.log2(count))}` };
    }
    if (name === "type_variant_payload_type") {
      const variantName = literalName(args[1]);
      const variant = type.normalized?.kind === "sum"
        ? type.normalized.variants.find((item) => item.name === variantName)
        : undefined;
      return variant ? { kind: "type", name: variantPayloadType(variant) } : undefined;
    }
    if (name === "type_has_niche") return { kind: "bool", value: false };
    if (name === "type_niche_value") return undefined;
    if (name === "type_slots") return constTypeSlots(type);
    if (name === "type_slot_count") {
      return {
        kind: "number",
        value: String(type.normalized?.kind === "product" ? type.normalized.shape.slots.length : 0),
      };
    }
    if (name === "type_variant_slots") {
      return constTypeVariantSlots(type, args[1], this.diagnostics, args[1]?.span ?? args[0]?.span);
    }
    if (name === "type_variants") return constTypeVariants(type);
    return undefined;
  }

  private evalBinary(
    expr: Extract<Expr, { kind: "binary" }>,
    locals: Map<string, ConstValue>,
    callStack: string[],
  ): ConstValue | undefined {
    const left = this.evalExpr(expr.left, locals, callStack);
    const right = this.evalExpr(expr.right, locals, callStack);
    if (!left || !right) return undefined;
    if (expr.op === "==" || expr.op === "!=") {
      const equal = this.constValueKey(left) === this.constValueKey(right);
      return { kind: "bool", value: expr.op === "==" ? equal : !equal };
    }
    if (left.kind === "number" && right.kind === "number") {
      const leftValue = Number(left.value);
      const rightValue = Number(right.value);
      if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
        switch (expr.op) {
          case "+":
            return { kind: "number", value: String(leftValue + rightValue) };
          case "-":
            return { kind: "number", value: String(leftValue - rightValue) };
          case "*":
            return { kind: "number", value: String(leftValue * rightValue) };
          case "/":
            if (rightValue === 0) break;
            return { kind: "number", value: String(Math.trunc(leftValue / rightValue)) };
          case "%":
            if (rightValue === 0) break;
            return { kind: "number", value: String(leftValue % rightValue) };
          case "<":
            return { kind: "bool", value: leftValue < rightValue };
          case "<=":
            return { kind: "bool", value: leftValue <= rightValue };
          case ">":
            return { kind: "bool", value: leftValue > rightValue };
          case ">=":
            return { kind: "bool", value: leftValue >= rightValue };
        }
      }
    }
    return this.unsupported("const.unsupported_expr", `operator ${expr.op} is not const-evaluable`);
  }

  private unsupported(code: string, message: string): undefined {
    this.report(code, message);
    return undefined;
  }

  private report(code: string, message: string, span = this.diagnosticSpan) {
    this.diagnostics.push({ code, message, span });
  }

  private withSpan<t extends ConstValue | undefined>(value: t, span?: Span): t {
    if (!value || value.span || !span) return value;
    return { ...value, span } as t;
  }

  private constValueKey(value: ConstValue): string {
    if (value.kind === "shape") {
      return JSON.stringify({
        kind: "shape",
        slots: value.slots.map((slot) => ({
          label: slot.label,
          value: this.constValueKey(slot.value),
        })),
      });
    }
    if (value.kind === "product") {
      return JSON.stringify({
        kind: "product",
        constructor: value.constructor,
        slots: value.slots.map((slot) => ({
          label: slot.label,
          value: this.constValueKey(slot.value),
        })),
      });
    }
    if (value.kind === "type") {
      const resolved = this.resolveType(value);
      return resolved.normalized
        ? JSON.stringify(this.typeBodyKey(resolved.normalized))
        : resolved.name;
    }
    return constValueKey(value);
  }

  private typeBodyKey(body: TypeBody): unknown {
    switch (body.kind) {
      case "alias": {
        const resolved = this.resolveType({ kind: "type", name: body.type });
        return resolved.normalized ? this.typeBodyKey(resolved.normalized) : resolved.name;
      }
      case "product":
        return {
          kind: "product",
          shape: body.shape.slots.map((slot) => ({
            label: slot.label,
            type: this.constValueKey({ kind: "type", name: slot.type }),
            repeat: slot.repeat,
          })),
        };
      case "sum":
        return {
          kind: "sum",
          variants: body.variants.map((variant) => ({
            name: variant.name,
            shape: variant.shape?.slots.map((slot) => ({
              label: slot.label,
              type: this.constValueKey({ kind: "type", name: slot.type }),
              repeat: slot.repeat,
            })) ?? [],
          })),
        };
    }
  }

  private resolveType(
    type: Extract<ConstValue, { kind: "type" }>,
    seen = new Set<string>(),
  ): Extract<ConstValue, { kind: "type" }> {
    if (seen.has(type.name)) return type;
    seen.add(type.name);
    const evaluator = new TypeEvaluator(
      this.typesByName,
      this.functions,
      this.hostIoImports,
      this.types,
      this.diagnostics,
      this.addShader,
      this.pluginRegistry,
      this.diagnosticSpan,
    );
    const parsedName = parseAnnotationType(type.name);
    if (parsedName) {
      const evaluated = evaluator.eval(parsedName, new Map());
      if (evaluated?.kind === "type") {
        const resolved = {
          kind: "type" as const,
          name: evaluated.name,
          normalized: evaluated.normalized,
        };
        if (resolved.name !== type.name) return this.resolveType(resolved, seen);
        if (resolved.normalized && !type.normalized) type = resolved;
      }
    }
    const decl = this.typesByName.get(type.name);
    if (decl && decl.params.length === 0 && decl.body.expr) {
      const parsedCall = parseAnnotationType(`${type.name}()`);
      const evaluated = parsedCall ? evaluator.eval(parsedCall, new Map()) : undefined;
      if (evaluated?.kind === "type") {
        const resolved = {
          kind: "type" as const,
          name: evaluated.name,
          normalized: evaluated.normalized,
        };
        if (resolved.name !== type.name) return this.resolveType(resolved, seen);
        if (resolved.normalized && !type.normalized) type = resolved;
      }
    }
    if (type.normalized?.kind === "alias") {
      const parsed = parseAnnotationType(type.normalized.type);
      if (parsed) {
        const evaluated = evaluator.eval(parsed, new Map());
        if (evaluated?.kind === "type") {
          return this.resolveType({
            kind: "type",
            name: evaluated.name,
            normalized: evaluated.normalized,
          }, seen);
        }
      }
    }
    return type;
  }
}

function literalName(value: ConstValue | undefined): string | undefined {
  return value?.kind === "literal_type" || value?.kind === "string" ? value.value : undefined;
}

function constSelectorLabels(value: ConstValue | undefined): Set<string> | undefined {
  if (value?.kind !== "shape") return undefined;
  const labels = new Set<string>();
  for (const slot of value.slots) {
    if (!slot.label) return undefined;
    labels.add(slot.label);
  }
  return labels;
}

function constTypeSlots(type: ConstValue): ConstValue {
  if (type.kind !== "type" || type.normalized?.kind !== "product") {
    return { kind: "shape", slots: [] };
  }
  return {
    kind: "shape",
    slots: type.normalized.shape.slots.map((slot) => ({
      label: slot.label,
      value: { kind: "type", name: slot.type },
    })),
  };
}

function constTypeVariantSlots(
  type: ConstValue,
  variantValue: ConstValue | undefined,
  diagnostics: Diagnostic[],
  span?: Span,
): ConstValue {
  const variantName = literalName(variantValue);
  const variant = type.kind === "type" && type.normalized?.kind === "sum"
    ? type.normalized.variants.find((item) => item.name === variantName)
    : undefined;
  if (!variant) {
    diagnostics.push({
      code: "type.unknown_type_variant",
      message: `unknown type variant ${variantName ?? "<unknown>"}`,
      span,
    });
    return { kind: "never" };
  }
  return {
    kind: "shape",
    slots: variant.shape?.slots.map((slot) => ({
      label: slot.label,
      value: { kind: "type", name: slot.type },
    })) ?? [],
  };
}

function constTypeVariants(type: ConstValue): ConstValue {
  if (type.kind !== "type" || type.normalized?.kind !== "sum") return { kind: "shape", slots: [] };
  return {
    kind: "shape",
    slots: type.normalized.variants.map((variant) => ({
      label: variant.name,
      value: {
        kind: "shape",
        slots: variant.shape?.slots.map((slot) => ({
          label: slot.label,
          value: { kind: "type", name: slot.type },
        })) ?? [],
      },
    })),
  };
}

function constTypeMember(
  type: ConstValue,
  name: ConstValue | undefined,
  typesByName: Map<string, TypeDecl>,
): TypeMember | undefined {
  const memberName = literalName(name);
  if (type.kind !== "type") return undefined;
  const resolved = resolveConstTypeValue(type, typesByName);
  if (resolved.normalized?.kind === "product" || resolved.normalized?.kind === "sum") {
    const member = resolved.normalized.members?.find((item) => item.name === memberName);
    if (member) {
      const decl = typesByName.get(typeNameOf(resolved.name));
      const bindings = decl ? genericBindings(resolved.name, decl) : new Map<string, string>();
      return { ...member, type: substituteTypeVars(member.type, bindings) };
    }
  }
  if (
    memberName === "empty" &&
    typeHasDerivedEmpty(constToTypeEvalValue(resolved) as TypeEvalValue & { kind: "type" })
  ) {
    return { name: "empty", type: `fn() -> ${resolved.name}`, target: `${resolved.name}::empty` };
  }
  return undefined;
}

function constTypeMembers(
  type: ConstValue,
  typesByName: Map<string, TypeDecl>,
): ConstValue {
  if (type.kind !== "type") return { kind: "shape", slots: [] };
  const resolved = resolveConstTypeValue(type, typesByName);
  const normalized = resolved.normalized;
  const members = normalized?.kind === "product" || normalized?.kind === "sum"
    ? normalized.members ?? []
    : [];
  const decl = typesByName.get(typeNameOf(resolved.name));
  const bindings = decl ? genericBindings(resolved.name, decl) : new Map<string, string>();
  const explicit = members.map((member) => ({
    ...member,
    type: substituteTypeVars(member.type, bindings),
  }));
  const withDerivedEmpty =
    typeHasDerivedEmpty(constToTypeEvalValue(resolved) as TypeEvalValue & { kind: "type" }) &&
      !explicit.some((member) => member.name === "empty")
      ? [...explicit, {
        name: "empty",
        type: `fn() -> ${resolved.name}`,
        target: `${resolved.name}::empty`,
      }]
      : explicit;
  return {
    kind: "shape",
    slots: withDerivedEmpty.map((member) => ({
      label: member.name,
      value: memberMetadataConstValue(member),
    })),
  };
}

function resolveConstTypeValue(
  type: Extract<ConstValue, { kind: "type" }>,
  typesByName: Map<string, TypeDecl>,
): Extract<ConstValue, { kind: "type" }> {
  if (type.normalized) return type;
  const decl = typesByName.get(typeNameOf(type.name));
  return decl?.normalized ? { ...type, normalized: decl.normalized } : type;
}

function typeLayoutConstValue(type: string, types: TypeDecl[]): ConstValue {
  const array = inlineArrayLikeTypeArgs(type, types);
  const itemBits = array ? typeSizeBits(array.itemType, types) : undefined;
  const totalBits = typeSizeBits(type, types);
  const storage = typeStorageKindConst(type, types);
  return {
    kind: "shape",
    slots: [
      { label: "kind", value: { kind: "literal_type", value: storage } },
      ...(array
        ? [
          { label: "len", value: { kind: "number" as const, value: String(array.count) } },
          { label: "item", value: { kind: "type" as const, name: array.itemType } },
        ]
        : []),
      ...(itemBits !== undefined
        ? [{ label: "item_bits", value: { kind: "number" as const, value: String(itemBits) } }]
        : []),
      ...(totalBits !== undefined
        ? [{ label: "total_bits", value: { kind: "number" as const, value: String(totalBits) } }]
        : []),
      {
        label: "flat_slot_count",
        value: { kind: "number", value: String(flatTypeSlots(type, types).length) },
      },
    ],
  };
}

function typeStorageKindConst(type: string, types: TypeDecl[]): string {
  const array = inlineArrayLikeTypeArgs(type, types);
  if (array) {
    const itemBits = typeSizeBits(array.itemType, types);
    return itemBits !== undefined && itemBits * array.count <= 64 ? "packed" : "flat";
  }
  const decl = findTypeDecl(types, typeNameOf(resolveAliasType(type, types) ?? type));
  if (decl?.normalized?.kind === "sum") return "tagged_union";
  if (decl?.normalized?.kind === "product") return "flat";
  return scalarReflection(type) ? "scalar" : "opaque";
}

function typeFlatSlotsConstValue(type: string, types: TypeDecl[]): ConstValue {
  return {
    kind: "shape",
    slots: flatTypeSlots(type, types).map((slot, index) => ({
      label: `slot${index}`,
      value: { kind: "type", name: slot },
    })),
  };
}

function productSlot(type: ConstValue, name: ConstValue | undefined) {
  const slotName = literalName(name);
  if (type.kind !== "type" || type.normalized?.kind !== "product") return undefined;
  return type.normalized.shape.slots.find((slot) => slot.label === slotName);
}

function hasProductSlot(type: ConstValue, name: ConstValue | undefined): boolean {
  return !!productSlot(type, name);
}

function constValueKey(value: ConstValue): string {
  return JSON.stringify(serializableConstValue(value));
}

function constTypeList(
  value: ConstValue | undefined,
  builtin: string,
  diagnostics: Diagnostic[],
): Extract<ConstValue, { kind: "shape" }> | undefined {
  if (value?.kind !== "shape") {
    if (value?.kind !== "never") {
      diagnostics.push({
        code: "type.list_builtin_arg",
        message: `${builtin} requires a type list`,
        span: value?.span,
      });
    }
    return undefined;
  }
  const invalid = value.slots.find((slot) => slot.label);
  if (invalid) {
    diagnostics.push({
      code: "type.list_builtin_arg",
      message: `${builtin} type list items must be unlabeled`,
      span: value.span,
    });
    return undefined;
  }
  return value;
}

function constListIndex(
  list: Extract<ConstValue, { kind: "shape" }>,
  item: ConstValue,
): number {
  const itemKey = constValueKey(item);
  return list.slots.findIndex((slot) => constValueKey(slot.value) === itemKey);
}

function constUniqueList(
  list: Extract<ConstValue, { kind: "shape" }>,
): Extract<ConstValue, { kind: "shape" }> {
  const seen = new Set<string>();
  const slots: Extract<ConstValue, { kind: "shape" }>["slots"] = [];
  for (const slot of list.slots) {
    const key = constValueKey(slot.value);
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push(slot);
  }
  return { kind: "shape", slots };
}

function serializableConstValue(value: ConstValue): ConstValue {
  const { span: _span, ...rest } = value;
  if (rest.kind !== "shape" && rest.kind !== "product") return rest as ConstValue;
  return {
    ...rest,
    slots: rest.slots.map((slot) => ({
      label: slot.label,
      value: serializableConstValue(slot.value),
    })),
  } as ConstValue;
}

function constValueWithSpan<t extends ConstValue | undefined>(value: t, span?: Span): t {
  if (!value || value.span || !span) return value;
  return { ...value, span } as t;
}

function constPatternMatches(pattern: ParamPattern, value: ConstValue): boolean {
  if (pattern.kind === "typed") return constPatternMatches(pattern.pattern, value);
  if (pattern.kind === "wildcard" || pattern.kind === "binding") return true;
  if (pattern.kind !== "literal" && pattern.kind !== "type") return false;
  const text = renderParamPattern(pattern);
  if (value.kind === "bool") return text === (value.value ? "true" : "false");
  if (value.kind === "number") return text === value.value;
  if (value.kind === "char") return text === renderLiteralTypeMember(value);
  if (value.kind === "string") return text === JSON.stringify(value.value);
  if (value.kind === "literal_type") return text === `#${value.value}`;
  if (value.kind === "type") return text === value.name;
  return false;
}

function renderConstTypeArg(value: ConstValue): string {
  if (value.kind === "type") return value.name;
  if (value.kind === "fn") return value.name;
  if (value.kind === "bool") return value.value ? "true" : "false";
  if (value.kind === "number") return value.value;
  if (value.kind === "char") return renderLiteralTypeMember(value);
  if (value.kind === "string") return JSON.stringify(value.value);
  if (value.kind === "literal_type") return `#${value.value}`;
  if (value.kind === "shape") {
    return `{${
      value.slots.map((slot) => {
        const rendered = renderConstTypeArg(slot.value);
        return slot.label ? `${slot.label}: ${rendered}` : rendered;
      }).join(", ")
    }}`;
  }
  if (value.kind === "product") {
    return `${value.constructor} {${
      value.slots.map((slot) => {
        const rendered = renderConstTypeArg(slot.value);
        return slot.label ? `${slot.label}: ${rendered}` : rendered;
      }).join(", ")
    }}`;
  }
  return constValueKey(value);
}

function constValueToExpr(value: ConstValue): Expr | undefined {
  if (value.kind === "product") {
    if (value.type) {
      return {
        kind: "shape",
        syntax: "record",
        inferredType: value.type,
        slots: value.slots.map((slot) => ({
          label: slot.label,
          value: constValueToExpr(slot.value) ?? { kind: "var", name: "<never>" },
        })),
      };
    }
    return {
      kind: "product_constructor",
      constructor: value.constructor,
      slots: value.slots.map((slot) => ({
        label: slot.label,
        value: constValueToExpr(slot.value) ?? { kind: "var", name: "<never>" },
      })),
    };
  }
  if (value.kind === "shape") {
    return {
      kind: "shape",
      syntax: value.runtime && value.type ? "record" : undefined,
      inferredType: value.runtime ? value.type : undefined,
      slots: value.slots.map((slot) => ({
        label: slot.label,
        value: constValueToExpr(slot.value) ?? { kind: "var", name: "<never>" },
      })),
    };
  }
  if (value.kind === "type") return { kind: "var", name: value.name };
  if (value.kind === "fn") return { kind: "var", name: value.name };
  if (value.kind === "bool") {
    return {
      kind: "literal",
      literalKind: "bool",
      value: value.value ? "true" : "false",
      ...(value.type ? { inferredType: value.type } : {}),
    };
  }
  if (value.kind === "number") {
    return {
      kind: "literal",
      literalKind: "number",
      value: value.value,
      ...(value.type ? { inferredType: value.type } : {}),
    };
  }
  if (value.kind === "string") {
    return {
      kind: "literal",
      literalKind: "string",
      value: JSON.stringify(value.value),
      ...(value.type ? { inferredType: value.type } : {}),
    };
  }
  if (value.kind === "char") {
    return {
      kind: "literal",
      literalKind: "char",
      value: renderLiteralTypeMember(value),
      ...(value.type ? { inferredType: value.type } : {}),
    };
  }
  if (value.kind === "literal_type") {
    return {
      kind: "literal",
      literalKind: "literalType",
      value: `#${value.value}`,
      ...(value.type ? { inferredType: value.type } : {}),
    };
  }
  return undefined;
}

function specializeInferredTypeCalls(
  program: Program,
  functions: Map<string, FnDecl>,
  consts: Map<string, ConstValue>,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
  includeGenerated = false,
  stats?: SpecializationTrace,
) {
  const context = {
    functions,
    consts,
    diagnostics,
    types,
    typeConstructors: new Map(
      types.flatMap((decl) =>
        decl.normalized?.kind === "product" ? [[decl.normalized.constructor, decl] as const] : []
      ),
    ),
    cache: new Map<string, FnDecl>(),
    memo: createCheckMemo(),
    usedNames: new Set(program.declarations.map((decl) => "name" in decl ? decl.name : "")),
    stats,
  };
  const queue = program.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && (includeGenerated || !decl.generated)
  );
  const queued = new Set(queue.map((decl) => decl.name));
  for (let index = 0; index < queue.length; index++) {
    const decl = queue[index]!;
    const reportAmbiguous = !decl.generated && !fnUsesInferredTypeVars(decl, consts, context.memo);
    const expectedReturnType = decl.returnType && !annotationHasInferredVars(decl.returnType)
      ? decl.returnType
      : undefined;
    decl.body = specializeInferredBlock(
      decl.body,
      context,
      new Map(decl.params.map((param) => [param.name, param.type])),
      expectedReturnType,
      reportAmbiguous,
    );
    for (const generated of context.cache.values()) {
      if (!queued.has(generated.name)) {
        queued.add(generated.name);
        queue.push(generated);
      }
    }
  }
  const declared = new Set(program.declarations.map((decl) => "name" in decl ? decl.name : ""));
  const fresh = [...context.cache.values()].filter((decl) => !declared.has(decl.name));
  if (fresh.length) program.declarations.push(...fresh);
}

function specializeInferredBlock(
  block: Extract<Expr, { kind: "block" }>,
  context: {
    functions: Map<string, FnDecl>;
    consts: Map<string, ConstValue>;
    diagnostics: Diagnostic[];
    types: TypeDecl[];
    typeConstructors: Map<string, TypeDecl>;
    cache: Map<string, FnDecl>;
    memo: CheckMemo;
    usedNames: Set<string>;
    stats?: SpecializationTrace;
    diagnosticSpan?: Span;
  },
  env = new Map<string, string>(),
  expectedType?: string,
  reportAmbiguous = true,
): Extract<Expr, { kind: "block" }> {
  const scoped = new Map(env);
  let statements = block.statements;
  let changed = false;
  const nextStatements: Statement[] = [];
  for (const stmt of block.statements) {
    if (stmt.kind === "let") {
      const explicit = explicitTypeAnnotation(stmt.type);
      const value = specializeInferredExpr(
        stmt.value,
        context,
        scoped,
        explicit,
        reportAmbiguous,
      );
      let type = explicit;
      type ??= inferExprType(value, context, scoped);
      if (type) scoped.set(stmt.name, type);
      if (value === stmt.value) {
        nextStatements.push(stmt);
      } else {
        changed = true;
        nextStatements.push({ ...stmt, value });
      }
      continue;
    }
    if (stmt.kind === "destructure_let") {
      const value = specializeInferredExpr(
        stmt.value,
        context,
        scoped,
        undefined,
        reportAmbiguous,
      );
      const type = inferExprType(value, context, scoped);
      let slotTypes = stmt.slotTypes;
      if (!slotTypes && type) {
        slotTypes = [];
        for (let index = 0; index < stmt.names.length; index++) slotTypes.push(type);
      }
      if (slotTypes) {
        for (let index = 0; index < stmt.names.length; index++) {
          let slotType: string | undefined = slotTypes[index];
          if (!slotType) slotType = type;
          if (slotType) scoped.set(stmt.names[index]!, slotType);
        }
      }
      if (value === stmt.value && slotTypes === stmt.slotTypes) {
        nextStatements.push(stmt);
      } else {
        changed = true;
        nextStatements.push({ ...stmt, value, slotTypes });
      }
      continue;
    }
    nextStatements.push(stmt);
  }
  if (changed) statements = nextStatements;
  let expr: Expr | undefined;
  if (block.expr) {
    expr = specializeInferredExpr(block.expr, context, scoped, expectedType, reportAmbiguous);
  }
  if (statements === block.statements && expr === block.expr) return block;
  return { ...block, statements, expr };
}

function specializeInferredExpr(
  expr: Expr,
  context: {
    functions: Map<string, FnDecl>;
    consts: Map<string, ConstValue>;
    diagnostics: Diagnostic[];
    types: TypeDecl[];
    typeConstructors: Map<string, TypeDecl>;
    cache: Map<string, FnDecl>;
    memo: CheckMemo;
    usedNames: Set<string>;
    stats?: SpecializationTrace;
  },
  env = new Map<string, string>(),
  expectedType?: string,
  reportAmbiguous = true,
): Expr {
  switch (expr.kind) {
    case "do":
      return lowerDoExpression(
        expr,
        context.diagnostics,
        (child) => specializeInferredExpr(child, context, env),
      );
    case "const_fn": {
      const body = specializeInferredExpr(expr.body, context, env);
      if (body === expr.body) return expr;
      return { ...expr, body };
    }
    case "profile": {
      const args = specializeInferredExprArray(expr.args, context, env);
      const body = specializeInferredExpr(expr.body, context, env, expectedType, reportAmbiguous);
      if (args === expr.args && body === expr.body) return expr;
      return { ...expr, args, body };
    }
    case "call": {
      context.stats && (context.stats.visitedCalls += 1);
      const callee = specializeInferredExpr(expr.callee, context, env);
      let fn: FnDecl | undefined;
      if (callee.kind === "var") fn = context.functions.get(callee.name);
      let args = expr.args;
      let argsChanged = false;
      const nextArgs: Expr[] = [];
      for (let index = 0; index < expr.args.length; index++) {
        const param = fn?.params[index];
        let argExpectedType: string | undefined;
        if (param && !param.const && !typeHasFreeInferredVars(param.type, context.consts)) {
          argExpectedType = param.type;
        }
        const arg = specializeInferredExpr(
          expr.args[index]!,
          context,
          env,
          argExpectedType,
          false,
        );
        if (arg !== expr.args[index]) argsChanged = true;
        nextArgs.push(arg);
      }
      if (argsChanged) args = nextArgs;
      if (!fn || !fnUsesInferredTypeVars(fn, context.consts, context.memo)) {
        if (callee === expr.callee && args === expr.args) return expr;
        return { ...expr, callee, args };
      }
      const specialized = specializeInferredCall(
        fn,
        args,
        context,
        env,
        callSiteSpan(expr),
        expectedType,
        reportAmbiguous,
      );
      if (specialized) return specialized;
      if (callee === expr.callee && args === expr.args) return expr;
      return { ...expr, callee, args };
    }
    case "index": {
      const target = specializeInferredExpr(expr.target, context, env);
      const index = specializeInferredExpr(expr.index, context, env);
      if (target === expr.target && index === expr.index) return expr;
      return { ...expr, target, index };
    }
    case "binary": {
      const left = specializeInferredExpr(expr.left, context, env);
      const right = specializeInferredExpr(expr.right, context, env);
      if (left === expr.left && right === expr.right) return expr;
      return { ...expr, left, right };
    }
    case "operator_chain": {
      const first = specializeInferredExpr(expr.first, context, env);
      let rest = expr.rest;
      let changed = first !== expr.first;
      const nextRest: typeof expr.rest = [];
      for (const item of expr.rest) {
        const value = specializeInferredExpr(item.value, context, env);
        if (value === item.value) {
          nextRest.push(item);
        } else {
          changed = true;
          nextRest.push({ ...item, value });
        }
      }
      if (changed) rest = nextRest;
      if (!changed) return expr;
      return { ...expr, first, rest };
    }
    case "pipe_bind": {
      let value = specializeInferredExpr(expr.value, context, env);
      let valueType = inferExprType(value, context, env);
      let scoped = env;
      if (valueType && !hasUnresolvedStaticTypeName(valueType, context)) {
        scoped = new Map(env);
        scoped.set(expr.name, valueType);
      }
      let body = specializeInferredExpr(expr.body, context, scoped, expectedType);
      const bodyExpectedValueType = inferredLocalExpectedType(expr.name, body, context);
      const needsValueContext = bodyExpectedValueType &&
        (!valueType || hasUnresolvedStaticTypeName(valueType, context));
      if (needsValueContext) {
        const contextualValue = specializeInferredExpr(
          expr.value,
          context,
          env,
          bodyExpectedValueType,
          reportAmbiguous,
        );
        value = contextualValue;
        valueType = inferExprType(value, context, env) ?? bodyExpectedValueType;
        if (!hasUnresolvedStaticTypeName(valueType, context)) {
          scoped = new Map(env);
          scoped.set(expr.name, valueType);
          body = specializeInferredExpr(expr.body, context, scoped, expectedType);
        }
      }
      if (value === expr.value && body === expr.body) return expr;
      return { ...expr, value, body };
    }
    case "match": {
      const value = specializeInferredExpr(expr.value, context, env);
      const valueType = inferExprType(value, context, env);
      let arms = expr.arms;
      let changed = value !== expr.value;
      const nextArms: typeof expr.arms = [];
      for (const arm of expr.arms) {
        const scoped = envWithPatternBindings(arm.pattern, valueType, env, context.types);
        let guard: Expr | undefined;
        if (arm.guard) {
          guard = specializeInferredExpr(arm.guard, context, scoped, "bool", reportAmbiguous);
        }
        const armValue = specializeInferredExpr(arm.value, context, scoped, expectedType);
        if (guard === arm.guard && armValue === arm.value) {
          nextArms.push(arm);
        } else {
          changed = true;
          const nextArm = { ...arm, value: armValue };
          if (guard) nextArm.guard = guard;
          nextArms.push(nextArm);
        }
      }
      if (changed) arms = nextArms;
      if (!changed) return expr;
      return { ...expr, value, arms };
    }
    case "shape": {
      const slots = specializeInferredSlots(expr.slots, context, env);
      if (slots === expr.slots) return expr;
      return { ...expr, slots };
    }
    case "product_constructor": {
      const slots = specializeInferredSlots(expr.slots, context, env);
      if (slots === expr.slots) return expr;
      return { ...expr, slots };
    }
    case "range": {
      const start = specializeInferredExpr(expr.start, context, env);
      const end = specializeInferredExpr(expr.end, context, env);
      if (start === expr.start && end === expr.end) return expr;
      return { ...expr, start, end };
    }
    case "static_for_slots": {
      const value = specializeInferredExpr(expr.value, context, env);
      if (value === expr.value) return expr;
      return { ...expr, value };
    }
    case "field": {
      const value = specializeInferredExpr(expr.value, context, env);
      const key = specializeInferredExpr(expr.key, context, env);
      if (value === expr.value && key === expr.key) return expr;
      return { ...expr, value, key };
    }
    case "block":
      return specializeInferredBlock(expr, context, env, expectedType, reportAmbiguous);
    case "literal":
    case "var":
      return expr;
  }
}

function specializeInferredExprArray(
  items: Expr[],
  context: Parameters<typeof specializeInferredExpr>[1],
  env: Map<string, string>,
  expectedType?: string,
  reportAmbiguous = true,
): Expr[] {
  let changed = false;
  const result: Expr[] = [];
  for (const item of items) {
    const next = specializeInferredExpr(item, context, env, expectedType, reportAmbiguous);
    if (next !== item) changed = true;
    result.push(next);
  }
  if (changed) return result;
  return items;
}

function specializeInferredSlots<T extends { index?: Expr; value: Expr }>(
  slots: T[],
  context: Parameters<typeof specializeInferredExpr>[1],
  env: Map<string, string>,
): T[] {
  let changed = false;
  const result: T[] = [];
  for (const slot of slots) {
    let index: Expr | undefined;
    if (slot.index) index = specializeInferredExpr(slot.index, context, env);
    const value = specializeInferredExpr(slot.value, context, env);
    if (index === slot.index && value === slot.value) {
      result.push(slot);
    } else {
      changed = true;
      result.push({ ...slot, index, value });
    }
  }
  if (changed) return result;
  return slots;
}

function inferredLocalExpectedType(
  name: string,
  expr: Expr,
  context: {
    functions: Map<string, FnDecl>;
    consts: Map<string, ConstValue>;
    types: TypeDecl[];
  },
): string | undefined {
  let found: string | undefined;
  let conflict = false;
  const addCandidate = (candidate: string | undefined) => {
    if (!candidate || typeHasFreeInferredVars(candidate, context.consts)) return;
    const runtimeType = runtimeSpecializedType(candidate, context.types) ?? candidate;
    if (!found) {
      found = runtimeType;
      return;
    }
    if (found !== runtimeType) conflict = true;
  };
  const visit = (item: Expr | undefined) => {
    if (!item || conflict) return;
    if (item.kind === "call" && item.callee.kind === "var") {
      const fn = context.functions.get(item.callee.name);
      if (fn) {
        for (const argsByParam of inferCallArgLayouts(fn, item.args)) {
          for (let index = 0; index < argsByParam.length; index++) {
            const arg = argsByParam[index];
            if (!arg || arg.kind !== "var" || arg.name !== name) continue;
            const param = fn.params[index];
            if (!param || param.const) continue;
            addCandidate(param.type);
          }
        }
      }
    }
    switch (item.kind) {
      case "do":
        for (const stmt of item.statements) {
          if (
            stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
          ) {
            visit(stmt.value);
          }
          if (stmt.kind === "do_bind" && stmt.name === name) return;
          if (stmt.kind === "let" && stmt.name === name) return;
          if (stmt.kind === "destructure_let" && stmt.names.includes(name)) return;
        }
        visit(item.expr);
        return;
      case "const_fn":
        if (!item.params.includes(name)) visit(item.body);
        return;
      case "profile":
        for (const arg of item.args) visit(arg);
        visit(item.body);
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
      case "operator_chain":
        visit(item.first);
        for (const rest of item.rest) visit(rest.value);
        return;
      case "pipe_bind":
        visit(item.value);
        if (item.name !== name) visit(item.body);
        return;
      case "match":
        visit(item.value);
        for (const arm of item.arms) {
          if (patternBindingNames(arm.pattern).includes(name)) continue;
          visit(arm.value);
        }
        return;
      case "shape":
      case "product_constructor":
        for (const slot of item.slots) visit(slot.value);
        return;
      case "static_for_slots":
        if (item.source.kind === "range") {
          visit(item.source.start);
          visit(item.source.end);
        } else {
          visit(item.source.shape);
        }
        if (item.iterator !== name && item.valueIterator !== name) visit(item.value);
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
        for (const stmt of item.statements) {
          if (stmt.kind === "let") {
            visit(stmt.value);
            if (stmt.name === name) return;
          } else if (stmt.kind === "destructure_let") {
            visit(stmt.value);
            if (stmt.names.includes(name)) return;
          }
        }
        visit(item.expr);
        return;
      case "literal":
      case "var":
        return;
    }
  };
  visit(expr);
  if (conflict) return undefined;
  return found;
}

function hasUnresolvedStaticTypeName(
  type: string,
  context: { consts?: Map<string, ConstValue>; types?: TypeDecl[] },
): boolean {
  for (const match of type.matchAll(/\b([a-z][A-Za-z0-9_]*)\b/g)) {
    const name = match[1]!;
    const index = match.index ?? 0;
    const next = type.slice(index + name.length).trimStart()[0];
    if (next === "(" || next === ":" || next === "." || isBuiltinTypeName(name)) continue;
    if (context.consts?.has(name)) continue;
    if (context.types?.some((decl) => decl.name === name || terminalName(decl.name) === name)) {
      continue;
    }
    return true;
  }
  return false;
}

function fnUsesInferredTypeVars(
  fn: FnDecl,
  consts?: Map<string, ConstValue>,
  memo?: CheckMemo,
): boolean {
  const vars = collectRawTypeVars(fn, memo);
  if (!consts) return vars.size > 0;
  for (const name of vars) {
    if (!consts.has(name)) return true;
  }
  return false;
}

function specializeInferredCall(
  fn: FnDecl,
  args: Expr[],
  context: {
    functions: Map<string, FnDecl>;
    consts: Map<string, ConstValue>;
    diagnostics: Diagnostic[];
    types: TypeDecl[];
    typeConstructors: Map<string, TypeDecl>;
    cache: Map<string, FnDecl>;
    memo: CheckMemo;
    usedNames: Set<string>;
    stats?: SpecializationTrace;
    diagnosticSpan?: Span;
  },
  env = new Map<string, string>(),
  diagnosticSpan?: Span,
  expectedType?: string,
  reportAmbiguous = true,
): Expr | undefined {
  const previousDiagnosticSpan = context.diagnosticSpan;
  if (diagnosticSpan) context.diagnosticSpan = diagnosticSpan;
  try {
    const types = new Map<string, string>();
    const staticArgNames: string[] = [];
    const staticNames = new Map<string, string>();
    const operatorContractVars = operatorContractTypeVars(fn);
    const nonConstParams = fn.params.filter((param) => !param.const);
    const omitConstArgs = false;
    let runtimeArgIndex = 0;
    const argsByParam = fn.params.map((param, index) => {
      if (!omitConstArgs) return args[index];
      if (param.const) return undefined;
      return args[runtimeArgIndex++];
    });
    fn.params.forEach((param, index) => {
      const arg = argsByParam[index];
      inferFromValuePattern(param.type, arg, types, context, env);
      if (param.const) {
        if (!arg) return;
        if (arg.kind === "const_fn") {
          inferConstFnLiteralTypeArgs(substituteTypeVars(param.type, types), arg, types, context);
        }
      }
    });
    fn.params.forEach((param, index) => {
      const arg = argsByParam[index];
      if (param.const && arg?.kind === "var") {
        const value = context.consts.get(arg.name);
        if (value?.kind === "fn") {
          inferFnTypeArgs(
            substituteTypeVars(param.type, types),
            context.functions.get(value.name),
            types,
            context.consts,
          );
        }
        const directFn = context.functions.get(arg.name);
        if (directFn) {
          inferFnTypeArgs(substituteTypeVars(param.type, types), directFn, types, context.consts);
        }
      }
    });
    bindTypePattern(
      fn.returnType,
      expectedType ? runtimeSpecializedType(expectedType, context.types) : undefined,
      types,
      context.types,
      context.consts,
    );
    fn.params.forEach((param, index) => {
      inferFromValuePattern(param.type, argsByParam[index], types, context, env);
      const arg = argsByParam[index];
      if (param.const && arg?.kind === "const_fn") {
        inferConstFnLiteralTypeArgs(substituteTypeVars(param.type, types), arg, types, context);
      }
    });
    canonicalizeOperatorContractTypeVars(types, operatorContractVars, context.types);
    for (let index = 0; index < fn.params.length; index++) {
      const param = fn.params[index];
      const arg = argsByParam[index];
      if (!param.const) continue;
      if (!arg) return undefined;
      const expectedConstType = substituteTypeVars(param.type, types);
      const staticArg = staticConstArgValue(arg, expectedConstType, context);
      if (!staticArg) return undefined;
      const match = staticArg.name.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
      const expected = param.type.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([a-z][A-Za-z0-9_]*)\)$/);
      if (match && expected && match[1] === expected[1]) {
        types.set(expected[2], match[2].trim());
      }
      if (staticArg.value.kind === "fn") {
        inferFnTypeArgs(
          expectedConstType,
          context.functions.get(staticArg.value.name),
          types,
          context.consts,
        );
      }
      staticArgNames.push(staticArg.name);
      staticNames.set(param.name, staticArg.name);
    }
    const missingTypeVars = [...collectTypeVars(fn, context.consts, context.memo)].filter((name) =>
      !types.has(name)
    );
    if (missingTypeVars.length) {
      return undefined;
    }
    const key = `${fn.name}\0${[...types].map(([k, v]) => `${k}=${v}`).join("\0")}\0${
      staticArgNames.join("\0")
    }`;
    let specialized = context.cache.get(key);
    if (specialized) {
      context.stats && (context.stats.cacheHits += 1);
    } else {
      context.stats && (context.stats.cacheMisses += 1);
    }
    if (!specialized) {
      const name = allocateSpecializationName(
        fn.name,
        [...types.values(), ...staticArgNames],
        context.usedNames,
      );
      const inferredBody = substituteInferredExpr(
        cloneExpr(fn.body),
        types,
        staticNames,
        new Map(),
        {
          ...context,
          runtimeEnv: new Map(
            nonConstParams.map((param) => [param.name, param.type]),
          ),
        },
      ) as Extract<Expr, { kind: "block" }>;
      specialized = {
        ...fn,
        public: false,
        name,
        params: fn.params.filter((param) => !param.const).map((param) => ({
          ...param,
          type: runtimeSpecializedRequiredType(
            substituteStaticNamesInType(substituteTypeVars(param.type, types), staticNames),
            context.types,
          ),
        })),
        returnType: runtimeSpecializedType(
          fn.returnType
            ? substituteStaticNamesInType(substituteTypeVars(fn.returnType, types), staticNames)
            : undefined,
          context.types,
        ),
        body: inferredBody,
        generated: true,
      };
      specialized.body = expandReplaceFieldsWithEnv(
        specialized.body,
        new Map(specialized.params.map((param) => [param.name, param.type])),
        context.types,
      ) as Extract<Expr, { kind: "block" }>;
      specialized.generatedInlineable = isInlineableGeneratedSpecializationSource(fn) &&
        !exprCallsFunction(specialized.body, specialized.name);
      context.cache.set(key, specialized);
      context.functions.set(name, specialized);
      context.stats && (context.stats.generatedSpecializations += 1);
    }
    const expectedArgs = args.map((arg, index) => {
      const param = fn.params[index];
      if (!param) return arg;
      if (param.const) return arg;
      const specializedType = substituteStaticNamesInType(
        substituteTypeVars(param.type, types),
        staticNames,
      );
      return specializeInferredExpr(
        arg,
        context,
        env,
        specializedType,
      );
    });
    return {
      kind: "call",
      callee: { kind: "var", name: specialized.name },
      args: omitConstArgs
        ? expectedArgs
        : expectedArgs.filter((_arg, index) => !fn.params[index]?.const),
    };
  } finally {
    context.diagnosticSpan = previousDiagnosticSpan;
  }
}

function operatorContractTypeVars(fn: FnDecl): Set<string> {
  const vars = new Set<string>();
  for (const stmt of fn.body.statements) {
    if (stmt.kind !== "type_assert") continue;
    const value = stmt.value;
    if (value.kind !== "type_call") continue;
    let calleeName: string | undefined;
    if (value.callee.kind === "type_ref" || value.callee.kind === "type_static_ref") {
      calleeName = terminalName(value.callee.name);
    }
    if (!calleeName?.startsWith("Op")) continue;
    for (const arg of value.args) {
      if (arg.kind === "type_ref" && isInferredTypeVarName(arg.name)) vars.add(arg.name);
    }
  }
  return vars;
}

function canonicalizeOperatorContractTypeVars(
  types: Map<string, string>,
  operatorContractVars: Set<string>,
  typeDecls: TypeDecl[],
) {
  for (const name of operatorContractVars) {
    const value = types.get(name);
    const carrier = operatorOperandContractType(value, typeDecls);
    if (carrier) types.set(name, carrier);
  }
}

function inferFromValuePattern(
  pattern: ParamPattern | string,
  arg: Expr | undefined,
  types: Map<string, string>,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
    currentFn?: FnDecl;
  },
  env = new Map<string, string>(),
) {
  const rendered = typeof pattern === "string" ? pattern : renderParamPattern(pattern);
  const runtimePattern = transparentContractRuntimeType(rendered, context.types ?? []) ?? rendered;
  if (!arg) return;
  if (arg.kind === "product_constructor") {
    const decl = context.typeConstructors.get(arg.constructor);
    if (decl) {
      bindTypePattern(
        runtimePattern,
        renderConstructedType(decl, arg, context),
        types,
        context.types ?? [],
      );
    }
    return;
  }
  if (arg.kind === "literal") {
    let literalType = arg.inferredType;
    if (!literalType) {
      literalType = inferExprType(arg, context, env);
    }
    bindTypePattern(runtimePattern, literalType, types, context.types ?? [], context.consts);
    return;
  }
  if (arg.kind === "shape") {
    bindTypePattern(
      runtimePattern,
      inferExprType(arg, context, env),
      types,
      context.types ?? [],
      context.consts,
    );
    return;
  }
  if (arg.kind === "var") {
    const directFn = functionDeclForNameInMap(arg.name, context.functions);
    if (directFn) inferFnTypeArgs(rendered, directFn, types, context.consts);
    bindTypePattern(
      runtimePattern,
      inferExprType(arg, context, env),
      types,
      context.types ?? [],
      context.consts,
    );
    return;
  }
  const proof = exprLooksLikeTypeProof(arg, context.types ?? [])
    ? renderTypeProofArg(arg)
    : undefined;
  if (proof) {
    bindTypePattern(runtimePattern, proof, types, context.types ?? [], context.consts);
    return;
  }
  bindTypePattern(
    runtimePattern,
    inferExprType(arg, context, env),
    types,
    context.types ?? [],
    context.consts,
  );
}

function functionDeclForNameInMap(
  name: string,
  functions: Map<string, FnDecl>,
): FnDecl | undefined {
  const candidates = functionLookupCandidates(name);
  for (const candidate of candidates) {
    const mapped = functions.get(candidate);
    if (mapped) return mapped;
  }
  for (const candidate of candidates) {
    for (const fn of functions.values()) {
      if (importedFunctionNameMatches(fn.name, candidate)) return fn;
    }
  }
  for (const candidate of candidates) {
    if (candidate.includes(".") || candidate.includes("::")) continue;
    for (const fn of functions.values()) {
      if (functionTerminalMemberName(fn.name) === candidate) return fn;
    }
  }
  return undefined;
}

function runtimeSpecializedType(type: string | undefined, types: TypeDecl[]): string | undefined {
  return type ? transparentContractRuntimeType(type, types) ?? type : undefined;
}

function runtimeSpecializedRequiredType(type: string, types: TypeDecl[]): string {
  return transparentContractRuntimeType(type, types) ?? type;
}

function renderConstructedType(
  decl: TypeDecl,
  arg: Extract<Expr, { kind: "product_constructor" }>,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
    currentFn?: FnDecl;
  },
): string {
  if (!decl.params.length) return decl.name;
  const bindings = new Map<string, string>();
  const slots = decl.normalized?.kind === "product" ? decl.normalized.shape.slots : [];
  for (const slot of arg.slots) {
    if (!slot.label) continue;
    const expected = slots.find((item) => item.label === slot.label)?.type;
    const actual = inferExprType(slot.value, context);
    bindTypePattern(expected, actual, bindings, context.types ?? [], context.consts);
  }
  if (!decl.params.every((param) => bindings.has(param.name))) return decl.name;
  return `${decl.name}(${decl.params.map((param) => bindings.get(param.name)!).join(", ")})`;
}

function inferExprType(
  expr: Expr,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
    currentFn?: FnDecl;
  },
  env = new Map<string, string>(),
): string | undefined {
  if (expr.kind === "literal") {
    if (expr.inferredType) return expr.inferredType;
    if (expr.literalKind === "number") return numericLiteralExplicitType(expr.value) ?? "i32";
    if (expr.literalKind === "bool") return "bool";
    if (expr.literalKind === "string" || expr.literalKind === "multiline") return "string";
    if (expr.literalKind === "char") return "char";
    if (expr.literalKind === "literalType") return "literal";
  }
  if (expr.kind === "product_constructor") {
    const decl = context.typeConstructors.get(expr.constructor);
    return decl ? renderConstructedType(decl, expr, context) : undefined;
  }
  if (expr.kind === "shape") {
    if (expr.inferredType) return expr.inferredType;
    const spreadType = inferProductSpreadShapeType(expr, context, env);
    if (spreadType) return spreadType;
    const slots = expr.slots.map((slot) => {
      const label = slot.label ? `${slot.label}: ` : "";
      return `${label}${inferExprType(slot.value, context, env) ?? "i32"}`;
    });
    return `struct({${slots.join(", ")}})`;
  }
  if (expr.kind === "binary") {
    return inferScalarOperatorResultType(
      expr.op,
      inferExprType(expr.left, context, env),
      inferExprType(expr.right, context, env),
    );
  }
  if (expr.kind === "operator_chain") {
    return inferOperatorChainResultType(expr, (child) => inferExprType(child, context, env));
  }
  if (expr.kind === "call" && expr.tailRec) {
    const currentFn = context.currentFn;
    const targetName = expr.tailRecTarget ?? currentFn?.tailRecTarget ?? currentFn?.name;
    const targetFn = targetName
      ? (targetName === currentFn?.name ? currentFn : context.functions.get(targetName))
      : undefined;
    return targetFn?.returnType;
  }
  if (expr.kind === "call" && expr.callee.kind === "var") {
    if (isIoReturnCall(expr)) {
      return expr.args.length === 1
        ? `io(${inferExprType(expr.args[0]!, context, env) ?? "i32"})`
        : "io(i32)";
    }
    if (expr.callee.name === "@empty") {
      const proof = renderTypeProofArg(expr.args[0]);
      const resolved = proof ? resolveStaticTypeName(proof, context.types ?? []) : undefined;
      if (resolved?.kind === "type") return resolved.name;
      if (proof) return proof;
    }
    const localFn = parseExpectedFnType(env.get(expr.callee.name) ?? "");
    if (localFn) return localFn.returnType;
    const fn = functionDeclForNameInMap(expr.callee.name, context.functions);
    if (!fn) return undefined;
    return inferCallReturnType(expr, fn, context, env) ?? fn.returnType;
  }
  if (expr.kind === "pipe_bind") {
    const valueType = inferExprType(expr.value, context, env);
    const scoped = valueType ? new Map(env).set(expr.name, valueType) : env;
    return inferExprType(expr.body, context, scoped);
  }
  if (expr.kind === "profile") return inferExprType(expr.body, context, env);
  if (expr.kind === "field") {
    const valueType = inferExprType(expr.value, context, env);
    const label = exprLiteralLabel(expr.key);
    return label ? projectTypeField(valueType, label, context.types ?? [], context) : undefined;
  }
  if (expr.kind === "var") {
    const projected = inferVarType(expr.name, env, context.types ?? [], context);
    if (projected) return projected;
    const constType = context.consts?.get(expr.name)?.type;
    if (constType) return constType;
    return context.functions.get(expr.name)
      ? renderFnType(context.functions.get(expr.name)!)
      : undefined;
  }
  return undefined;
}

function inferProductSpreadShapeType(
  expr: Extract<Expr, { kind: "shape" }>,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
  },
  env: Map<string, string>,
): string | undefined {
  if (!expr.slots.some((slot) => slot.spread) || expr.slots.some((slot) => slot.index)) {
    return undefined;
  }
  const types = context.types ?? [];
  const merged = new Map<string, string>();
  const functions = context.functions;
  const consts = context.consts ?? new Map();
  for (const slot of expr.slots) {
    if (slot.spread) {
      const sourceType = inferExprType(slot.value, context, env);
      const sourceSlots = structuralProductSlotsForType(sourceType, types, functions, consts);
      if (!sourceSlots) return undefined;
      for (const sourceSlot of sourceSlots) {
        if (sourceSlot.label) merged.set(sourceSlot.label, sourceSlot.type);
      }
      continue;
    }
    if (!slot.label) return undefined;
    merged.set(slot.label, inferExprType(slot.value, context, env) ?? "i32");
  }
  if (!merged.size) return undefined;
  return `struct({${[...merged].map(([label, type]) => `${label}: ${type}`).join(", ")}})`;
}

function inferCallReturnType(
  expr: Extract<Expr, { kind: "call" }>,
  fn: FnDecl,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
  },
  env: Map<string, string>,
): string | undefined {
  if (!fn.returnType) return undefined;
  const bindings = new Map<string, string>();
  for (const argsByParam of inferCallArgLayouts(fn, expr.args)) {
    argsByParam.forEach((arg, index) => {
      inferFromValuePattern(fn.params[index]?.type ?? "", arg, bindings, context, env);
    });
  }
  return substituteTypeVars(fn.returnType, bindings);
}

function inferCallArgLayouts(fn: FnDecl, args: Expr[]): Array<Array<Expr | undefined>> {
  const layouts: Array<Array<Expr | undefined>> = [];
  if (args.length === fn.params.length) layouts.push(args);
  const leadingConstCount = leadingConstParamCount(fn);
  if (leadingConstCount > 0 && args.length === fn.params.length - leadingConstCount) {
    layouts.push(
      fn.params.map((param, index) =>
        index < leadingConstCount && param.const ? undefined : args[index - leadingConstCount]
      ),
    );
  }
  if (!layouts.length) layouts.push(args);
  return layouts;
}

function inferVarType(
  name: string,
  env: Map<string, string>,
  types: TypeDecl[],
  context?: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
  },
): string | undefined {
  const parts = name.split(".");
  let current = env.get(parts[0]);
  for (const field of parts.slice(1)) {
    current = projectTypeField(current, field, types, context);
    if (!current) return undefined;
  }
  return current;
}

function projectTypeField(
  type: string | undefined,
  field: string,
  types: TypeDecl[],
  context?: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
  },
): string | undefined {
  if (!type) return undefined;
  const structural = structuralProductSlotsForType(
    type,
    types,
    context?.functions ?? new Map(),
    context?.consts ?? new Map(),
  );
  const structuralSlot = structural?.find((slot) => slot.label === field);
  if (structuralSlot) return structuralSlot.type;
  const structArgs = typeCallArgsForBase(type, "struct");
  if (structArgs) return projectTypeField(structArgs.trim(), field, types, context);
  const decl = resolveTypeDecl(type, types);
  if (decl?.normalized?.kind === "product") {
    const bindings = genericBindings(type, decl);
    const slot = decl.normalized.shape.slots.find((item) => item.label === field);
    if (slot) return substituteTypeVars(slot.type, bindings);
  }
  if (!context) return undefined;
  const blockSlot = projectTypeBlockField(type, field, types, context);
  if (blockSlot) return blockSlot;
  const parsed = parseAnnotationType(type);
  if (!parsed) return undefined;
  const diagnostics: Diagnostic[] = [];
  const evaluator = new TypeEvaluator(
    new Map(types.map((item) => [item.name, item])),
    context.functions,
    new Map(),
    context.consts ?? new Map(),
    diagnostics,
    shaderManifestEntry,
    defaultCompilerPluginRegistry,
  );
  const evaluated = evaluator.eval(parsed, new Map());
  const resolved = evaluated?.kind === "type" ? evaluator.resolve(evaluated) : evaluated;
  if (resolved?.kind !== "type" || resolved.normalized?.kind !== "product") return undefined;
  return resolved.normalized.shape.slots.find((item) => item.label === field)?.type;
}

function projectTypeBlockField(
  type: string,
  field: string,
  types: TypeDecl[],
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
  },
): string | undefined {
  const decl = types.find((item) => item.name === typeNameOf(type));
  if (!decl || decl.body.statements.length === 0) return undefined;
  const call = type.match(/^[A-Za-z_][A-Za-z0-9_.]*\((.*)\)$/);
  const argTexts = call ? splitTypeArgs(call[1]) : [];
  const diagnostics: Diagnostic[] = [];
  const typesByName = new Map(types.map((item) => [item.name, item]));
  const locals = new Map<string, TypeEvalValue>();
  for (const [index, param] of decl.params.entries()) {
    const parsed = parseAnnotationType(argTexts[index] ?? param.name);
    const value = parsed
      ? instantiateTypeExpr(
        parsed,
        typesByName,
        context.functions,
        new Map(),
        context.consts ?? new Map(),
        diagnostics,
      )
      : undefined;
    locals.set(param.name, value ?? { kind: "type", name: argTexts[index] ?? param.name });
  }
  for (const stmt of decl.body.statements) {
    const value = instantiateTypeExpr(
      stmt.value,
      typesByName,
      context.functions,
      new Map(),
      context.consts ?? new Map(),
      diagnostics,
      locals,
    );
    if (!value) return undefined;
    locals.set(stmt.name, value);
  }
  for (const value of locals.values()) {
    if (value.kind !== "shape") continue;
    const slot = value.slots.find((item) => item.label === field);
    if (slot?.value.kind === "type") return slot.value.name;
  }
  return undefined;
}

function structuralProductSlotsForType(
  type: string | undefined,
  types: TypeDecl[],
  functions: Map<string, FnDecl> = new Map(),
  consts: Map<string, ConstValue> = new Map(),
): { label?: string; type: string; repeat?: string }[] | undefined {
  if (!type) return undefined;
  const block = structuralProductSlotsFromTypeBlock(type, types, functions, consts);
  if (block) return block;
  const direct = structuralProductSlotsFromTypeExpr(type, types, functions, consts);
  if (direct) return direct;
  const resolved = resolveAliasType(type, types) ?? type;
  const decl = resolveTypeDecl(resolved, types);
  if (decl?.normalized?.kind === "product") {
    const bindings = genericBindings(resolved, decl);
    return decl.normalized.shape.slots.map((slot) => ({
      label: slot.label,
      type: substituteTypeVars(slot.type, bindings),
      repeat: slot.repeat ? substituteTypeVars(slot.repeat, bindings) : undefined,
    }));
  }
  return structuralProductSlotsFromTypeExpr(resolved, types, functions, consts);
}

function structuralProductSlotsFromTypeBlock(
  type: string,
  types: TypeDecl[],
  functions: Map<string, FnDecl>,
  consts: Map<string, ConstValue>,
): { label?: string; type: string; repeat?: string }[] | undefined {
  const decl = types.find((item) => item.name === typeNameOf(type));
  if (!decl || decl.body.statements.length === 0) return undefined;
  const call = type.match(/^[A-Za-z_][A-Za-z0-9_.]*\((.*)\)$/);
  const argTexts = call ? splitTypeArgs(call[1]) : [];
  const diagnostics: Diagnostic[] = [];
  const typesByName = new Map(types.map((item) => [item.name, item]));
  const locals = new Map<string, TypeEvalValue>();
  for (const [index, param] of decl.params.entries()) {
    locals.set(param.name, { kind: "type", name: argTexts[index] ?? param.name });
  }
  for (const stmt of decl.body.statements) {
    const value = instantiateTypeExpr(
      stmt.value,
      typesByName,
      functions,
      new Map(),
      consts,
      diagnostics,
      locals,
    );
    if (value) locals.set(stmt.name, value);
  }
  const expr = decl.body.expr;
  if (
    expr?.kind === "type_call" &&
    expr.callee.kind === "type_ref" &&
    expr.callee.name === "struct" &&
    expr.args[0]?.kind === "type_ref"
  ) {
    const shape = locals.get(expr.args[0].name);
    if (shape?.kind === "shape") {
      return shape.slots.map((slot) => ({
        label: slot.label,
        type: slot.value.kind === "type" ? slot.value.name : renderTypeEvalValue(slot.value),
        repeat: slot.repeat,
      }));
    }
  }
  return undefined;
}

function structuralProductSlotsFromTypeExpr(
  type: string,
  types: TypeDecl[],
  functions: Map<string, FnDecl>,
  consts: Map<string, ConstValue>,
): { label?: string; type: string; repeat?: string }[] | undefined {
  const parsed = parseAnnotationType(type);
  if (!parsed) return undefined;
  const diagnostics: Diagnostic[] = [];
  const evaluator = new TypeEvaluator(
    new Map(types.map((item) => [item.name, item])),
    functions,
    new Map(),
    consts,
    diagnostics,
    shaderManifestEntry,
    defaultCompilerPluginRegistry,
  );
  const evaluated = evaluator.eval(parsed, new Map());
  const product = evaluated?.kind === "type" ? evaluator.resolve(evaluated) : evaluated;
  if (product?.kind !== "type" || product.normalized?.kind !== "product") return undefined;
  return product.normalized.shape.slots;
}

function resolveTypeDecl(type: string, types: TypeDecl[]): TypeDecl | undefined {
  let current = type;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const decl = types.find((item) => item.name === typeNameOf(current));
    if (!decl) return undefined;
    if (decl.normalized?.kind !== "alias") return decl;
    current = substituteTypeVars(decl.normalized.type, genericBindings(current, decl));
  }
  return undefined;
}

function genericBindings(type: string, decl: TypeDecl): Map<string, string> {
  const match = type.match(/^[A-Za-z_][A-Za-z0-9_.]*\((.*)\)$/);
  const args = match ? splitTypeArgs(match[1]) : [];
  return new Map(
    decl.params.map((param, index) => [param.name, args[index]?.trim() ?? param.name]),
  );
}

function collectRawTypeVars(fn: FnDecl, memo?: CheckMemo): Set<string> {
  const cached = memo?.typeVarsByFunction.get(fn);
  if (cached) return cached;
  const key = functionTypeVarCacheKey(fn);
  const persistent = memo?.cachedTypeVarsByFunction?.get(fn);
  if (persistent?.key === key) {
    memo?.typeVarsByFunction.set(fn, persistent.vars);
    return persistent.vars;
  }
  const vars = new Set<string>();
  const staticParams = new Set(
    fn.params.filter((param) => param.const).map((param) => param.name),
  );
  for (const text of [...fn.params.map((param) => param.type), fn.returnType ?? ""]) {
    collectFreeTypeVars(text, vars, staticParams);
  }
  memo?.typeVarsByFunction.set(fn, vars);
  memo?.cachedTypeVarsByFunction?.set(fn, { key, vars });
  return vars;
}

function functionTypeVarCacheKey(fn: FnDecl): string {
  let key = fn.returnType ?? "";
  for (const param of fn.params) {
    key += `\0${param.const ? "const" : "runtime"}\0${param.name}\0${param.type}`;
  }
  return key;
}

function collectTypeVars(
  fn: FnDecl,
  consts?: Map<string, ConstValue>,
  memo?: CheckMemo,
): Set<string> {
  const raw = collectRawTypeVars(fn, memo);
  if (!consts) return new Set(raw);
  const vars = new Set<string>();
  for (const name of raw) {
    if (!consts.has(name)) vars.add(name);
  }
  return vars;
}

function collectFreeTypeVars(
  annotation: string,
  vars: Set<string>,
  staticTypeParams = new Set<string>(),
  consts?: Map<string, ConstValue>,
) {
  const parsed = parseAnnotationType(annotation);
  if (!parsed) {
    collectFunctionTypeTextVars(annotation, vars, staticTypeParams, consts);
    return;
  }
  const visitSource = (source: string | undefined) => {
    if (!source) return;
    const parsedSource = parseAnnotationType(source);
    if (parsedSource) visit(parsedSource);
  };
  const visit = (expr: TypeExpr, callee = false) => {
    if (expr.kind === "type_ref") {
      if (
        !callee && isInferredTypeVarName(expr.name) && !staticTypeParams.has(expr.name) &&
        !consts?.has(expr.name)
      ) {
        vars.add(expr.name);
      }
      return;
    }
    if (expr.kind === "type_call") {
      visit(expr.callee, true);
      for (const arg of expr.args) visit(arg);
    } else if (expr.kind === "type_shape") {
      for (const slot of expr.shape.slots) visit(slot.type);
    } else if (expr.kind === "type_match") {
      visit(expr.value);
      for (const arm of expr.arms) visit(arm.value);
    } else if (expr.kind === "type_binary") {
      visit(expr.left);
      visit(expr.right);
    } else if (expr.kind === "type_fn") {
      const signature = parseFnSignature(expr.source);
      if (signature) {
        for (const param of signature.params) visitSource(param);
        visitSource(signature.returnType);
      } else {
        for (const item of parseAnnotationTypeCalls(expr.source)) visit(item);
      }
    }
  };
  visit(parsed);
}

function collectFunctionTypeTextVars(
  annotation: string,
  vars: Set<string>,
  staticTypeParams: Set<string>,
  consts?: Map<string, ConstValue>,
) {
  annotation = normalizeTypeSourceForParsing(annotation);
  const pattern = /(?:->|:)\s*([a-z][A-Za-z0-9_]*)\b/g;
  for (const match of annotation.matchAll(pattern)) {
    const name = match[1];
    if (!name) continue;
    const end = (match.index ?? 0) + match[0].length;
    const next = annotation[end];
    if (name === "fn" || next === "." || next === "(") continue;
    if (staticTypeParams.has(name)) continue;
    if (consts?.has(name)) continue;
    if (!isInferredTypeVarName(name)) continue;
    vars.add(name);
  }
}

function typeHasFreeInferredVars(annotation: string, consts?: Map<string, ConstValue>): boolean {
  const vars = new Set<string>();
  collectFreeTypeVars(annotation, vars, new Set(), consts);
  const fn = parseExpectedFnType(annotation);
  if (fn) {
    for (const param of fn.params) collectFreeTypeVars(param.type, vars, new Set(), consts);
    collectFreeTypeVars(fn.returnType, vars, new Set(), consts);
  }
  return vars.size > 0;
}

function literalConstValue(expr: Extract<Expr, { kind: "literal" }>): ConstValue | undefined {
  if (expr.literalKind === "bool") return { kind: "bool", value: expr.value === "true" };
  if (expr.literalKind === "number") return { kind: "number", value: expr.value };
  if (expr.literalKind === "char") {
    return { kind: "char", value: JSON.parse(`"${expr.value.slice(1, -1)}"`) };
  }
  if (expr.literalKind === "string") {
    return { kind: "string", value: decodeStringLiteralValue(expr.value) };
  }
  if (expr.literalKind === "multiline") return { kind: "string", value: expr.value };
  if (expr.literalKind === "literalType") {
    return { kind: "literal_type", value: expr.value.slice(1) };
  }
  return undefined;
}

function literalValueMatchesType(value: ConstValue, expectedType: string): boolean {
  const type = expectedType.trim();
  const literalMembers = literalTypeMembers(type);
  if (literalMembers) {
    const key = value.kind === "bool"
      ? `bool:${value.value ? "true" : "false"}`
      : value.kind === "number"
      ? `number:${value.value}`
      : value.kind === "char"
      ? `char:${value.value}`
      : value.kind === "string"
      ? `string:${value.value}`
      : value.kind === "literal_type"
      ? `literal:${value.value}`
      : undefined;
    return key ? literalMembers.some((member) => literalTypeMemberKey(member) === key) : false;
  }
  if (type === "const") return true;
  if (type === "literal") return true;
  if (value.kind === "bool") return type === "bool";
  if (value.kind === "number") return type === "i32" || type === "numeric" || type === "count";
  if (value.kind === "char") return type === "char";
  if (value.kind === "string") return type === "string" || type === "multiline";
  if (value.kind === "literal_type") return type === "literal";
  if (value.kind === "type") return type === "type";
  if (value.kind === "fn") return type.trim().startsWith("fn(");
  return false;
}

function literalConstName(value: ConstValue): string {
  if (value.kind === "bool") return value.value ? "true" : "false";
  if (value.kind === "number") return value.value;
  if (value.kind === "char") return `char_${value.value.codePointAt(0) ?? 0}`;
  if (value.kind === "string") return `str_${wgslShaderId(value.value)}`;
  if (value.kind === "literal_type") return `#${value.value}`;
  return constValueKey(value);
}

function stringLiteralValue(expr: Expr | undefined): string | undefined {
  if (expr?.kind !== "literal") return undefined;
  if (expr.literalKind === "string") return decodeStringLiteralValue(expr.value);
  if (expr.literalKind === "multiline") return expr.value;
  return undefined;
}

function inferFnTypeArgs(
  expected: string,
  actual: FnDecl | undefined,
  types: Map<string, string>,
  consts?: Map<string, ConstValue>,
) {
  if (!actual) return;
  const expectedSig = parseFnSignature(expected);
  if (!expectedSig) return;
  expectedSig.params.forEach((type, index) =>
    bindTypePattern(type, actual.params[index]?.type, types, [], consts)
  );
  bindTypePattern(expectedSig.returnType, actual.returnType, types, [], consts);
}

function parseFnSignature(source: string): { params: string[]; returnType: string } | undefined {
  const parsed = parseFnSignatureDetailed(source);
  if (!parsed) return undefined;
  return {
    params: parsed.params.map((param) => param.type),
    returnType: parsed.returnType,
  };
}

function isInferredTypeVarName(name: string): boolean {
  return /^[a-z][A-Za-z0-9_]*$/.test(name) && !isBuiltinTypeName(name);
}

function bindTypePattern(
  pattern: string | undefined,
  actual: string | undefined,
  types: Map<string, string>,
  typeDecls: TypeDecl[] = [],
  consts?: Map<string, ConstValue>,
  seen = new Set<string>(),
) {
  if (!pattern || !actual) return;
  pattern = normalizeTypeSourceForParsing(substituteTypeVars(pattern, types));
  actual = normalizeTypeSourceForParsing(substituteTypeVars(actual, types));
  const key = `${pattern}\0${actual}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (isInferredTypeVarName(pattern)) {
    if (isUnresolvedInferredBinding(actual) && !consts?.has(actual.trim())) return;
    if (inferredBindingMentionsName(actual, pattern)) return;
    types.set(pattern, actual);
    return;
  }
  actual = actual.includes("(") ? actual : resolveAliasType(actual, typeDecls) ?? actual;
  if (pattern === actual) return;
  const pFn = parseFnSignature(pattern);
  const aFn = parseFnSignature(actual);
  if (pFn && aFn && pFn.params.length === aFn.params.length) {
    for (let index = 0; index < pFn.params.length; index++) {
      bindTypePattern(pFn.params[index], aFn.params[index], types, typeDecls, consts, seen);
    }
    bindTypePattern(pFn.returnType, aFn.returnType, types, typeDecls, consts, seen);
    return;
  }
  if (
    pattern.startsWith("&(") && pattern.endsWith(")") && actual.startsWith("&(") &&
    actual.endsWith(")")
  ) {
    bindTypePattern(
      pattern.slice(2, -1).trim(),
      actual.slice(2, -1).trim(),
      types,
      typeDecls,
      consts,
      seen,
    );
    return;
  }
  const pCall = pattern.match(/^([A-Za-z_][A-Za-z0-9_.]*)\(([\s\S]*)\)$/);
  const aCall = actual.match(/^([A-Za-z_][A-Za-z0-9_.]*)\(([\s\S]*)\)$/);
  if (pCall && !aCall) {
    const resolvedPattern = resolveAliasType(pattern, typeDecls);
    if (resolvedPattern && resolvedPattern !== pattern) {
      bindTypePattern(resolvedPattern, actual, types, typeDecls, consts, seen);
    }
    return;
  }
  if (pCall && aCall) {
    if (isInferredTypeVarName(pCall[1])) {
      if (!isUnresolvedInferredBinding(aCall[1]) || consts?.has(aCall[1].trim())) {
        types.set(pCall[1], aCall[1]);
      }
      bindTypePattern(pCall[2].trim(), aCall[2].trim(), types, typeDecls, consts, seen);
      return;
    }
    if (terminalName(pCall[1]) === terminalName(aCall[1])) {
      const patternArgs = splitTypeArgs(pCall[2]);
      const actualArgs = splitTypeArgs(aCall[2]);
      for (let index = 0; index < patternArgs.length; index++) {
        bindTypePattern(
          patternArgs[index]?.trim(),
          actualArgs[index]?.trim(),
          types,
          typeDecls,
          consts,
          seen,
        );
      }
      return;
    }
    const resolvedPattern = resolveAliasType(pattern, typeDecls);
    if (resolvedPattern && resolvedPattern !== pattern) {
      bindTypePattern(resolvedPattern, actual, types, typeDecls, consts, seen);
      return;
    }
    const resolvedActual = resolveAliasType(actual, typeDecls);
    if (resolvedActual && resolvedActual !== actual) {
      bindTypePattern(pattern, resolvedActual, types, typeDecls, consts, seen);
    }
    return;
  }
}

function isUnresolvedInferredBinding(actual: string): boolean {
  return isInferredTypeVarName(actual.trim());
}

function inferredBindingMentionsName(actual: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(actual);
}

function substituteTypeVars(source: string, types: Map<string, string>): string {
  let result = source;
  for (const [name, type] of types) {
    result = result.replace(new RegExp(`\\b${name}\\b`, "g"), type);
  }
  return result;
}

function substituteStaticNamesInType(source: string, staticNames: Map<string, string>): string {
  let result = source;
  for (const [name, value] of staticNames) {
    result = result.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }
  return result;
}

function substituteTypeVarsInTypeExpr(
  expr: TypeExpr,
  types: Map<string, string>,
  staticNames = new Map<string, string>(),
): TypeExpr {
  switch (expr.kind) {
    case "type_ref":
      if (types.has(expr.name)) return parseAnnotationType(types.get(expr.name)!) ?? expr;
      if (staticNames.has(expr.name)) {
        return parseAnnotationType(staticNames.get(expr.name)!) ?? expr;
      }
      return expr;
    case "type_hole":
      return expr;
    case "type_call":
      return {
        ...expr,
        callee: substituteTypeVarsInTypeExpr(expr.callee, types, staticNames),
        args: expr.args.map((arg) => substituteTypeVarsInTypeExpr(arg, types, staticNames)),
      };
    case "type_match":
      return {
        ...expr,
        value: substituteTypeVarsInTypeExpr(expr.value, types, staticNames),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: substituteTypeVarsInTypeExpr(arm.value, types, staticNames),
        })),
      };
    case "type_members":
      return {
        ...expr,
        target: substituteTypeVarsInTypeExpr(expr.target, types, staticNames),
      };
    case "type_binary":
      return {
        ...expr,
        left: substituteTypeVarsInTypeExpr(expr.left, types, staticNames),
        right: substituteTypeVarsInTypeExpr(expr.right, types, staticNames),
      };
    case "type_scalar_domain":
      return {
        ...expr,
        members: expr.members.map((member) => {
          const substituteEndpoint = (
            endpoint: Extract<TypeExpr, { kind: "type_scalar_domain" }>["members"][number][
              "start"
            ],
          ) =>
            endpoint.kind === "symbol" && staticNames.has(endpoint.source)
              ? { ...endpoint, kind: "literal" as const, source: staticNames.get(endpoint.source)! }
              : endpoint;
          return {
            ...member,
            start: substituteEndpoint(member.start),
            ...(member.end ? { end: substituteEndpoint(member.end) } : {}),
          };
        }),
      };
    case "type_shape":
      return {
        ...expr,
        shape: {
          ...expr.shape,
          slots: expr.shape.slots.map((slot) => ({
            ...slot,
            type: substituteTypeVarsInTypeExpr(slot.type, types, staticNames),
          })),
        },
      };
    case "type_fn":
      return {
        ...expr,
        source: substituteStaticNamesInType(substituteTypeVars(expr.source, types), staticNames),
      };
    case "type_static_ref":
    case "type_bool":
    case "type_number":
    case "type_char":
    case "type_string":
    case "type_literal":
      return expr;
  }
}

function substituteInferredExpr(
  expr: Expr,
  types: Map<string, string>,
  staticNames: Map<string, string>,
  proofTypes = new Map<string, TypeEvalValue>(),
  context?: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    diagnostics: Diagnostic[];
    types: TypeDecl[];
    diagnosticSpan?: Span;
    runtimeEnv?: Map<string, string>;
  },
): Expr {
  if (expr.kind === "var") {
    const assoc = expr.name.indexOf("::");
    const dot = expr.name.indexOf(".");
    const split = assoc > 0 ? assoc : dot;
    if (split > 0) {
      const separator = assoc > 0 ? "::" : ".";
      const base = expr.name.slice(0, split);
      const member = expr.name.slice(split + separator.length);
      if (runtimeEnvHasName(context?.runtimeEnv, base)) return expr;
      const proofType = proofTypes.get(base);
      const attached = proofType
        ? typeMember(proofType, { kind: "literal", value: member })
        : undefined;
      if (attached) return { kind: "var", name: attached.target };
      const type = types.get(base);
      if (type) return { kind: "var", name: `${type}${separator}${member}` };
      const staticName = staticNames.get(base);
      if (staticName) {
        const staticValue = context?.consts?.get(staticName);
        if (staticValue?.kind === "shape") {
          const slot = staticValue.slots.find((item) => item.label === member);
          if (slot?.value.kind === "fn") return { kind: "var", name: slot.value.name };
        }
        return { kind: "var", name: `${staticName}${separator}${member}` };
      }
    }
    if (runtimeEnvHasName(context?.runtimeEnv, expr.name)) return expr;
    const type = types.get(expr.name);
    if (type) {
      const staticExpr = constValueToExpr(constValueFromRenderedTypeArg(type));
      return staticExpr ?? { kind: "var", name: type };
    }
    const staticName = staticNames.get(expr.name);
    if (staticName) {
      const staticValue = constValueFromRenderedTypeArg(staticName);
      return constValueToExpr(staticValue) ?? { kind: "var", name: staticName };
    }
    return expr;
  }
  if (expr.kind === "call") {
    const callee = substituteInferredExpr(expr.callee, types, staticNames, proofTypes, context);
    const direct = callee.kind === "var" ? context?.functions.get(callee.name) : undefined;
    return {
      ...expr,
      callee,
      args: expr.args.map((arg, index) => {
        const param = direct?.params[index];
        const argContext = param?.const && param.type.trim() === "type"
          ? substituteContextWithoutRuntimeBindings(context, [...types.keys()])
          : context;
        return substituteInferredExpr(arg, types, staticNames, proofTypes, argContext);
      }),
    };
  }
  if (expr.kind === "const_fn") {
    return {
      ...expr,
      body: substituteInferredExpr(
        expr.body,
        types,
        staticNames,
        proofTypes,
        substituteContextWithRuntimeBindings(context, expr.params),
      ),
    };
  }
  if (expr.kind === "index") {
    return {
      ...expr,
      target: substituteInferredExpr(expr.target, types, staticNames, proofTypes, context),
      index: substituteInferredExpr(expr.index, types, staticNames, proofTypes, context),
    };
  }
  if (expr.kind === "binary") {
    return {
      ...expr,
      left: substituteInferredExpr(expr.left, types, staticNames, proofTypes, context),
      right: substituteInferredExpr(expr.right, types, staticNames, proofTypes, context),
    };
  }
  if (expr.kind === "pipe_bind") {
    const bodyContext = substituteContextWithRuntimeBindings(context, [expr.name]);
    return {
      ...expr,
      value: substituteInferredExpr(expr.value, types, staticNames, proofTypes, context),
      body: substituteInferredExpr(expr.body, types, staticNames, proofTypes, bodyContext),
    };
  }
  if (expr.kind === "match") {
    return {
      ...expr,
      value: substituteInferredExpr(expr.value, types, staticNames, proofTypes, context),
      arms: expr.arms.map((arm) => ({
        ...arm,
        value: substituteInferredExpr(
          arm.value,
          types,
          staticNames,
          proofTypes,
          substituteContextWithRuntimeBindings(context, patternBindingNames(arm.pattern)),
        ),
      })),
    };
  }
  if (expr.kind === "shape") {
    return {
      ...expr,
      slots: expr.slots.map((slot) => ({
        ...slot,
        value: substituteInferredExpr(slot.value, types, staticNames, proofTypes, context),
      })),
    };
  }
  if (expr.kind === "product_constructor") {
    return {
      ...expr,
      slots: expr.slots.map((slot) => ({
        ...slot,
        value: substituteInferredExpr(slot.value, types, staticNames, proofTypes, context),
      })),
    };
  }
  if (expr.kind === "static_for_slots") {
    return {
      ...expr,
      source: substituteInferredStaticForSource(
        expr.source,
        types,
        staticNames,
        proofTypes,
        context,
      ),
      value: substituteInferredExpr(expr.value, types, staticNames, proofTypes, context),
    };
  }
  if (expr.kind === "range") {
    return {
      ...expr,
      start: substituteInferredExpr(expr.start, types, staticNames, proofTypes, context),
      end: substituteInferredExpr(expr.end, types, staticNames, proofTypes, context),
    };
  }
  if (expr.kind === "field") {
    return {
      ...expr,
      value: substituteInferredExpr(expr.value, types, staticNames, proofTypes, context),
      key: substituteInferredExpr(expr.key, types, staticNames, proofTypes, context),
    };
  }
  if (expr.kind === "block") {
    const typeEvalLocals = new Map<string, TypeEvalValue>();
    const blockProofTypes = new Map(proofTypes);
    const typesByName = new Map((context?.types ?? []).map((decl) => [decl.name, decl]));
    const typeEvaluator = context
      ? new TypeEvaluator(
        typesByName,
        context.functions,
        new Map(),
        context.consts ?? new Map(),
        context.diagnostics,
        shaderManifestEntry,
        defaultCompilerPluginRegistry,
        context.diagnosticSpan,
      )
      : undefined;
    const blockContext = context
      ? {
        ...context,
        runtimeEnv: context.runtimeEnv ? new Map(context.runtimeEnv) : new Map<string, string>(),
      }
      : undefined;
    const statements: Statement[] = [];
    for (const stmt of expr.statements) {
      if (stmt.kind === "type_assert") {
        const value = typeEvaluator?.eval(
          substituteTypeVarsInTypeExpr(stmt.value, types, staticNames),
          typeEvalLocals,
        );
        if (!value || value.kind === "never") {
          context?.diagnostics.push({
            code: "type.type_assert",
            message: "type assertion could not be evaluated",
            span: context.diagnosticSpan,
          });
        }
        continue;
      }
      if (stmt.kind === "let") {
        statements.push({
          ...stmt,
          type: explicitTypeAnnotation(stmt.type)
            ? substituteStaticNamesInType(
              substituteTypeVars(explicitTypeAnnotation(stmt.type)!, types),
              staticNames,
            )
            : undefined,
          value: substituteInferredExpr(
            stmt.value,
            types,
            staticNames,
            blockProofTypes,
            blockContext,
          ),
        });
      } else {
        statements.push(stmt);
      }
      for (const name of boundNames(stmt)) blockContext?.runtimeEnv?.set(name, "");
    }
    return {
      ...expr,
      statements,
      expr: expr.expr
        ? substituteInferredExpr(expr.expr, types, staticNames, blockProofTypes, blockContext)
        : undefined,
    };
  }
  return expr;
}

function substituteInferredStaticForSource(
  source: StaticForSource,
  types: Map<string, string>,
  staticNames: Map<string, string>,
  proofTypes: Map<string, TypeEvalValue>,
  context: Parameters<typeof substituteInferredExpr>[4],
): StaticForSource {
  if (source.kind === "shape") {
    return {
      ...source,
      shape: substituteInferredExpr(source.shape, types, staticNames, proofTypes, context),
    };
  }
  return {
    ...source,
    start: substituteInferredExpr(source.start, types, staticNames, proofTypes, context),
    end: substituteInferredExpr(source.end, types, staticNames, proofTypes, context),
  };
}

function specializeConstParamCalls(
  program: Program,
  functions: Map<string, FnDecl>,
  consts: Map<string, ConstValue>,
  types: TypeDecl[],
  addShader: (source: string) => ShaderManifestEntry,
  diagnostics: Diagnostic[],
  emitDiagnostics = true,
  stats?: SpecializationTrace,
) {
  const context: ConstSpecializationContext = {
    functions,
    consts,
    types,
    diagnostics,
    emitDiagnostics,
    addShader,
    cache: new Map(),
    memo: createCheckMemo(),
    constFnCaptures: new Map(),
    runtimeClosureCache: new Map(),
    specializedStaticValues: new Map(),
    usedNames: new Set(program.declarations.map((decl) => "name" in decl ? decl.name : "")),
    typeConstructors: new Map(
      types.flatMap((decl) =>
        decl.normalized?.kind === "product" ? [[decl.normalized.constructor, decl] as const] : []
      ),
    ),
    stats,
  };
  for (const decl of program.declarations) {
    if (
      decl.kind === "fn" && !decl.params.some((param) => param.const) &&
      !fnUsesInferredTypeVars(decl, consts, context.memo)
    ) {
      const previousCurrentFn = context.currentFn;
      context.currentFn = decl;
      try {
        specializeBlock(
          decl.body,
          context,
          new Map(
            decl.params.filter((param) => !param.const).map((param) => [param.name, param.type]),
          ),
          decl.returnType,
        );
      } finally {
        context.currentFn = previousCurrentFn;
      }
    } else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = specializeExpr(decl.value, context, new Map());
    }
  }
  let processedGenerated = 0;
  while (processedGenerated < context.cache.size) {
    const generated = [...context.cache.values()].slice(processedGenerated);
    processedGenerated = context.cache.size;
    for (const decl of generated) {
      if (!decl.params.some((param) => param.const)) {
        const active = context.specializedStaticValues.get(decl.name);
        const previousActive = context.activeStaticValues;
        const previousCurrentFn = context.currentFn;
        context.activeStaticValues = active;
        context.currentFn = decl;
        try {
          specializeBlock(
            decl.body,
            context,
            new Map(decl.params.map((param) => [param.name, param.type])),
            decl.returnType,
          );
        } finally {
          context.activeStaticValues = previousActive;
          context.currentFn = previousCurrentFn;
        }
      }
    }
  }
  for (const decl of context.runtimeClosureCache.values()) {
    const previousCurrentFn = context.currentFn;
    context.currentFn = decl;
    try {
      specializeBlock(
        decl.body,
        context,
        new Map(decl.params.map((param) => [param.name, param.type])),
        decl.returnType,
      );
    } finally {
      context.currentFn = previousCurrentFn;
    }
  }
  if (context.cache.size > 0) program.declarations.push(...context.cache.values());
  if (context.runtimeClosureCache.size > 0) {
    program.declarations.push(...context.runtimeClosureCache.values());
  }
}

function specializeBlock(
  block: Extract<Expr, { kind: "block" }>,
  context: ConstSpecializationContext,
  env: Map<string, string>,
  expectedType?: string,
) {
  block.statements = block.statements.flatMap((stmt): Statement[] => {
    if (stmt.kind === "let") {
      const expected = explicitTypeAnnotation(stmt.type);
      stmt.value = specializeExpr(stmt.value, context, env, expected);
      const type = expected ?? inferExprType(stmt.value, context, env);
      if (type) env.set(stmt.name, type);
    } else if (stmt.kind === "destructure_let") {
      stmt.value = specializeExpr(stmt.value, context, env);
    }
    return [stmt];
  });
  if (block.expr) block.expr = specializeExpr(block.expr, context, env, expectedType);
}

function specializeExpr(
  expr: Expr,
  context: ConstSpecializationContext,
  env: Map<string, string>,
  expectedType?: string,
): Expr {
  const previousRuntimeEnv = context.runtimeEnv;
  context.runtimeEnv = env;
  try {
    switch (expr.kind) {
      case "do":
        return specializeDoExpr(expr, context, env);
      case "profile":
        return {
          ...expr,
          args: expr.args.map((arg) => specializeExpr(arg, context, env)),
          body: specializeExpr(expr.body, context, env, expectedType),
        };
      case "const_fn": {
        const expectedFn = expectedFunctionType(expectedType, context.types);
        const body = context.activeStaticValues
          ? substituteSpecializedExpr(
            expr.body,
            new Map(),
            context.activeStaticValues.values,
            context.activeStaticValues.names,
            context,
          )
          : expr.body;
        const specializedExpr = body === expr.body ? expr : { ...expr, body };
        return expectedFn
          ? synthesizeRuntimeClosureExpr(specializedExpr, expectedFn, context, env) ?? expr
          : expr;
      }
      case "call": {
        context.stats && (context.stats.visitedCalls += 1);
        const callee = specializeExpr(expr.callee, context, env);
        const direct = callee.kind === "var"
          ? constSpecializationFunctionDecl(callee.name, context)
          : undefined;
        const args = expr.args.map((arg, index) => {
          const param = direct?.params[index];
          const rawExpected = param && !param.const ? param.type : undefined;
          const expected = rawExpected && !typeHasFreeInferredVars(rawExpected, context.consts)
            ? rawExpected
            : undefined;
          return specializeExpr(arg, context, env, expected);
        });
        if (!direct?.params.some((param) => param.const)) {
          if (direct && fnUsesInferredTypeVars(direct, context.consts, context.memo)) {
            const specialized = specializeInferredCall(
              direct,
              args,
              context,
              env,
              callSiteSpan(expr),
              expectedType,
              false,
            );
            if (specialized) {
              return specializeConcreteCallArgs(specialized, context, env);
            }
            return { ...expr, callee, args };
          }
          return { ...expr, callee, args };
        }
        return specializeConstParamCall(
          direct,
          args,
          context,
          callSiteSpan(expr),
          new Map(),
          expectedType,
        ) ??
          { ...expr, callee, args };
      }
      case "index":
        return {
          ...expr,
          target: specializeExpr(expr.target, context, env),
          index: specializeExpr(expr.index, context, env),
        };
      case "binary":
        return {
          ...expr,
          left: specializeExpr(expr.left, context, env),
          right: specializeExpr(expr.right, context, env),
        };
      case "operator_chain":
        return {
          ...expr,
          first: specializeExpr(expr.first, context, env),
          rest: expr.rest.map((item) => ({
            ...item,
            value: specializeExpr(item.value, context, env),
          })),
        };
      case "pipe_bind":
        const pipeValue = specializeExpr(expr.value, context, env);
        return {
          ...expr,
          value: pipeValue,
          body: specializeExpr(expr.body, context, new Map(env).set(expr.name, "")),
        };
      case "match":
        return {
          ...expr,
          value: specializeExpr(expr.value, context, env),
          arms: expr.arms.map((arm) => ({
            ...arm,
            value: specializeExpr(arm.value, context, env),
          })),
        };
      case "shape":
        return {
          ...expr,
          slots: expr.slots.flatMap((slot) =>
            expandSpecializedShapeSlot(
              slot,
              new Map(),
              context.consts,
              new Map(),
              context,
            ).map((expanded) => ({
              ...expanded,
              value: specializeExpr(expanded.value, context, env),
            }))
          ),
        };
      case "product_constructor":
        return {
          ...expr,
          slots: expr.slots.flatMap((slot) =>
            expandSpecializedShapeSlot(
              slot,
              new Map(),
              context.consts,
              new Map(),
              context,
            ).map((expanded) => ({
              ...expanded,
              value: specializeExpr(expanded.value, context, env),
            }))
          ),
        };
      case "range":
        return {
          ...expr,
          start: specializeExpr(expr.start, context, env),
          end: specializeExpr(expr.end, context, env),
        };
      case "static_for_slots":
        return expr;
      case "field":
        return {
          ...expr,
          value: specializeExpr(expr.value, context, env),
          key: specializeExpr(expr.key, context, env),
        };
      case "block": {
        const block = cloneExpr(expr) as Extract<Expr, { kind: "block" }>;
        specializeBlock(block, context, new Map(env), expectedType);
        return block;
      }
      case "literal":
      case "var":
        if (
          expr.kind === "var" && expectedFunctionType(expectedType, context.types) &&
          context.functions.has(expr.name) && !env.has(expr.name)
        ) {
          return runtimeClosureMakeExpr(expr.name, []);
        }
        return expr;
        return expr;
    }
  } finally {
    context.runtimeEnv = previousRuntimeEnv;
  }
}

function specializeConcreteCallArgs(
  expr: Expr,
  context: ConstSpecializationContext,
  env: Map<string, string>,
): Expr {
  if (expr.kind !== "call" || expr.callee.kind !== "var") return expr;
  const direct = context.functions.get(expr.callee.name);
  if (!direct) return expr;
  let changed = false;
  const args = expr.args.map((arg, index) => {
    const param = direct.params[index];
    const expected = param && !param.const && !typeHasFreeInferredVars(param.type, context.consts)
      ? param.type
      : undefined;
    if (!expected) return arg;
    const next = specializeExpr(arg, context, env, expected);
    if (next !== arg) changed = true;
    return next;
  });
  if (!changed) return expr;
  return { ...expr, args };
}

function expectedFunctionType(
  expectedType: string | undefined,
  types: TypeDecl[] = [],
): string | undefined {
  const direct = normalizeTypeSourceForParsing(expectedType?.trim() ?? "");
  if (direct?.startsWith("fn(")) return direct;
  const resolved = resolveAliasType(direct, types)?.trim();
  return resolved?.startsWith("fn(") ? resolved : undefined;
}

function specializeDoExpr(
  expr: Extract<Expr, { kind: "do" }>,
  context: ConstSpecializationContext,
  env: Map<string, string>,
): Expr {
  const scoped = new Map(env);
  const statements = expr.statements.map((stmt): DoStatement => {
    if (stmt.kind === "do_bind") {
      const value = specializeExpr(stmt.value, context, scoped);
      scoped.set(stmt.name, "");
      return { ...stmt, value };
    }
    if (stmt.kind === "do_expr") {
      return { ...stmt, value: specializeExpr(stmt.value, context, scoped) };
    }
    if (stmt.kind === "let") {
      const value = specializeExpr(stmt.value, context, scoped);
      const type = explicitTypeAnnotation(stmt.type) ?? inferExprType(value, context, scoped);
      if (type) scoped.set(stmt.name, type);
      return { ...stmt, value };
    }
    if (stmt.kind === "destructure_let") {
      const value = specializeExpr(stmt.value, context, scoped);
      for (const name of stmt.names) scoped.set(name, "");
      return { ...stmt, value };
    }
    return stmt;
  });
  return {
    ...expr,
    statements,
    expr: expr.expr ? specializeExpr(expr.expr, context, scoped) : undefined,
  };
}

interface ConstSpecializationContext {
  functions: Map<string, FnDecl>;
  consts: Map<string, ConstValue>;
  types: TypeDecl[];
  typeConstructors: Map<string, TypeDecl>;
  diagnostics: Diagnostic[];
  emitDiagnostics: boolean;
  addShader: (source: string) => ShaderManifestEntry;
  cache: Map<string, FnDecl>;
  memo: CheckMemo;
  constFnCaptures: Map<string, Param[]>;
  runtimeClosureCache: Map<string, FnDecl>;
  specializedStaticValues: Map<
    string,
    { values: Map<string, ConstValue>; names: Map<string, string> }
  >;
  activeStaticValues?: { values: Map<string, ConstValue>; names: Map<string, string> };
  usedNames: Set<string>;
  stats?: SpecializationTrace;
  diagnosticSpan?: Span;
  runtimeEnv?: Map<string, string>;
  currentFn?: FnDecl;
}

type StaticConstArgContext =
  & Pick<
    ConstSpecializationContext,
    "functions" | "consts" | "types" | "diagnostics"
  >
  & Partial<
    Pick<
      ConstSpecializationContext,
      "addShader" | "constFnCaptures" | "diagnosticSpan" | "emitDiagnostics" | "memo"
    >
  >;

function constSpecializationFunctionDecl(
  name: string,
  context: ConstSpecializationContext,
): FnDecl | undefined {
  const exact = context.functions.get(name);
  if (exact || name.includes(".") || name.includes("::")) return exact;
  if (!CONST_SPECIALIZATION_TERMINAL_HELPERS.has(name)) return undefined;
  const matches = [...context.functions.values()].filter((fn) =>
    !fn.name.includes("::") && terminalName(fn.name) === name
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return undefined;
  const signature = constSpecializationSignatureKey(matches[0]!);
  return matches.every((fn) => constSpecializationSignatureKey(fn) === signature)
    ? matches[0]
    : undefined;
}

function constSpecializationSignatureKey(fn: FnDecl): string {
  const params = fn.params.map((param) =>
    `${param.const ? "const " : ""}${param.name}:${param.type}`
  ).join(",");
  return `${params}->${fn.returnType}`;
}

const CONST_SPECIALIZATION_TERMINAL_HELPERS = new Set(["fmap", "bind", "apply", "pure"]);

function hasConstFnHelperContext(
  context: StaticConstArgContext,
): context is ConstSpecializationContext {
  return !!context.addShader && !!context.constFnCaptures &&
    context.emitDiagnostics !== undefined;
}

function specializeConstParamCall(
  fn: FnDecl,
  args: Expr[],
  context: ConstSpecializationContext,
  diagnosticSpan?: Span,
  outerStaticValues = new Map<string, ConstValue>(),
  expectedType?: string,
): Expr | undefined {
  const previousDiagnosticSpan = context.diagnosticSpan;
  if (diagnosticSpan) context.diagnosticSpan = diagnosticSpan;
  try {
    const explicit = specializeConstParamCallAttempt(
      fn,
      args,
      context,
      outerStaticValues,
      false,
      false,
      expectedType,
    );
    if (explicit) return explicit;
    const inferred = specializeConstParamCallAttempt(
      fn,
      args,
      context,
      outerStaticValues,
      true,
      false,
      expectedType,
    );
    if (inferred) return inferred;
    return specializeConstParamCallAttempt(
      fn,
      args,
      context,
      outerStaticValues,
      false,
      true,
      expectedType,
    );
  } finally {
    context.diagnosticSpan = previousDiagnosticSpan;
  }
}

function specializeConstParamCallAttempt(
  fn: FnDecl,
  args: Expr[],
  context: ConstSpecializationContext,
  outerStaticValues: Map<string, ConstValue>,
  omitLeadingConstArgs: boolean,
  emitDiagnostics: boolean,
  expectedType?: string,
): Expr | undefined {
  const leadingConstCount = leadingConstParamCount(fn);
  if (omitLeadingConstArgs) {
    if (leadingConstCount === 0) return undefined;
    if (args.length !== fn.params.length - leadingConstCount) return undefined;
  }
  const argsByParam = fn.params.map((param, index) => {
    if (!omitLeadingConstArgs) {
      return args[index];
    }
    if (index < leadingConstCount && param.const) return undefined;
    return args[index - leadingConstCount];
  });
  const inferredStaticBindings = inferConstStaticBindings(fn, argsByParam, context);
  bindTypePattern(
    fn.returnType,
    expectedType,
    inferredStaticBindings,
    context.types,
    context.consts,
  );
  const staticValues = new Map<string, ConstValue>();
  const staticArgNames = new Map<string, string>();
  const staticParamNames = new Set(
    fn.params.filter((param) => param.const).map((param) => param.name),
  );
  const inferredTypes = new Map(
    [...inferredStaticBindings].filter(([name]) => !staticParamNames.has(name)),
  );
  const constArgNames: string[] = [];
  const runtimeArgs: Expr[] = [];
  const captureParams: Param[] = [];
  for (let index = 0; index < fn.params.length; index++) {
    const param = fn.params[index];
    const arg = argsByParam[index];
    if (param.const) {
      const expectedType = param.inferStaticType ? undefined : substituteTypeVars(
        substituteConstParamType(param.type, staticValues, staticArgNames),
        inferredStaticBindings,
      );
      const staticArg = arg
        ? staticConstArgValue(arg, expectedType, context, outerStaticValues)
        : omitLeadingConstArgs && index < leadingConstCount
        ? inferredStaticArgValue(param, inferredStaticBindings, expectedType, context)
        : undefined;
      if (!staticArg) {
        if (emitDiagnostics && context.emitDiagnostics) {
          context.diagnostics.push({
            code: "const.static_param_arg",
            message:
              `const parameter ${param.name} on ${fn.name} requires a top-level const argument or matching type proof`,
            span: arg?.span ?? context.diagnosticSpan,
          });
        }
        return undefined;
      }
      staticValues.set(param.name, staticArg.value);
      const expectedForInference = substituteConstParamType(
        substituteTypeVars(param.type, inferredStaticBindings),
        staticValues,
        staticArgNames,
      );
      if (staticArg.value.kind === "fn") {
        inferFnTypeArgs(
          expectedForInference,
          context.functions.get(staticArg.value.name),
          inferredTypes,
          context.consts,
        );
      } else if (arg?.kind === "var" && context.functions.has(arg.name)) {
        inferFnTypeArgs(
          expectedForInference,
          context.functions.get(arg.name),
          inferredTypes,
          context.consts,
        );
      }
      if (!context.consts.has(staticArg.name)) {
        staticValues.set(staticArg.name, staticArg.value);
      }
      staticArgNames.set(param.name, staticArg.name);
      constArgNames.push(staticArg.name);
      if (staticArg.value.kind === "fn") {
        for (const capture of context.constFnCaptures.get(staticArg.value.name) ?? []) {
          if (!captureParams.some((item) => item.name === capture.name)) {
            captureParams.push(capture);
          }
        }
      }
    } else {
      if (!arg) {
        return undefined;
      }
      const specializedParamType = substituteTypeVars(
        substituteConstParamType(param.type, staticValues, staticArgNames),
        inferredStaticBindings,
      );
      let runtimeArg = arg;
      if (!typeHasFreeInferredVars(specializedParamType, context.consts)) {
        runtimeArg = specializeExpr(
          arg,
          context,
          context.runtimeEnv ?? new Map(),
          specializedParamType,
        );
      }
      runtimeArgs.push(runtimeArg);
    }
  }
  const key = `${fn.name}\0${constArgNames.join("\0")}\0${
    [...inferredTypes].map(([name, type]) => `${name}=${type}`).join("\0")
  }`;
  let specialized = context.cache.get(key);
  if (specialized) {
    context.stats && (context.stats.cacheHits += 1);
  } else {
    context.stats && (context.stats.cacheMisses += 1);
  }
  if (!specialized) {
    const specializedName = allocateSpecializationName(fn.name, constArgNames, context.usedNames);
    specialized = {
      kind: "fn",
      public: false,
      name: specializedName,
      params: fn.params.filter((param) => !param.const).map((param) => ({
        ...param,
        type: substituteTypeVars(
          substituteConstParamType(param.type, staticValues, staticArgNames),
          inferredTypes,
        ),
      })).concat(captureParams),
      returnType: fn.returnType
        ? substituteTypeVars(
          substituteConstParamType(fn.returnType, staticValues, staticArgNames),
          inferredTypes,
        )
        : undefined,
      effects: [...fn.effects],
      body: substituteInferredExpr(
        cloneExpr(fn.body),
        inferredTypes,
        new Map(),
        new Map(),
        {
          ...context,
          runtimeEnv: new Map(
            fn.params.filter((param) => !param.const).map((param) => [param.name, param.type]),
          ),
        },
      ) as Extract<Expr, { kind: "block" }>,
      generated: true,
      primitiveId: fn.primitiveId,
    };
    context.cache.set(key, specialized);
    context.functions.set(specialized.name, specialized);
    const activeStaticValues = {
      values: new Map(staticValues),
      names: new Map(staticArgNames),
    };
    context.specializedStaticValues.set(specialized.name, activeStaticValues);
    const previousRuntimeEnv = context.runtimeEnv;
    const previousActiveStaticValues = context.activeStaticValues;
    context.activeStaticValues = activeStaticValues;
    context.runtimeEnv = new Map(specialized.params.map((param) => [param.name, param.type]));
    try {
      specialized.body = substituteSpecializedExpr(
        specialized.body,
        new Map(),
        staticValues,
        staticArgNames,
        context,
      ) as Extract<Expr, { kind: "block" }>;
      specialized.body = substituteStaticValueRefs(
        specialized.body,
        staticValues,
      ) as Extract<Expr, { kind: "block" }>;
      specializeBlock(
        specialized.body,
        context,
        new Map(specialized.params.map((param) => [param.name, param.type])),
        specialized.returnType,
      );
    } finally {
      context.runtimeEnv = previousRuntimeEnv;
      context.activeStaticValues = previousActiveStaticValues;
    }
    specialized.generatedInlineable = isInlineableGeneratedSpecializationSource(fn) &&
      !exprCallsFunction(specialized.body, specialized.name);
    context.stats && (context.stats.generatedSpecializations += 1);
  }
  return {
    kind: "call",
    callee: { kind: "var", name: specialized.name },
    args: runtimeArgs.concat(captureParams.map((param) => ({ kind: "var", name: param.name }))),
  };
}

function leadingConstParamCount(fn: FnDecl): number {
  let count = 0;
  for (const param of fn.params) {
    if (!param.const) break;
    count++;
  }
  return count;
}

function inferConstStaticBindings(
  fn: FnDecl,
  argsByParam: (Expr | undefined)[],
  context: ConstSpecializationContext,
): Map<string, string> {
  const bindings = new Map<string, string>();
  const env = context.runtimeEnv ?? new Map<string, string>();
  fn.params.forEach((param, index) => {
    const arg = argsByParam[index];
    if (!arg) return;
    inferFromValuePattern(param.type, arg, bindings, context, env);
    if (param.const && arg.kind === "var") {
      const value = context.consts.get(arg.name);
      if (value?.kind === "fn") {
        inferFnTypeArgs(param.type, context.functions.get(value.name), bindings, context.consts);
      }
      const directFn = context.functions.get(arg.name);
      if (directFn) inferFnTypeArgs(param.type, directFn, bindings, context.consts);
    }
    if (param.const && arg.kind === "const_fn") {
      inferConstFnLiteralTypeArgs(param.type, arg, bindings, context);
    }
  });
  return bindings;
}

function inferConstFnLiteralTypeArgs(
  expectedType: string,
  arg: Extract<Expr, { kind: "const_fn" }>,
  bindings: Map<string, string>,
  context: {
    functions: Map<string, FnDecl>;
    consts: Map<string, ConstValue>;
    types: TypeDecl[];
    typeConstructors: Map<string, TypeDecl>;
    runtimeEnv?: Map<string, string>;
    currentFn?: FnDecl;
  },
) {
  const substitutedExpected = substituteTypeVars(expectedType, bindings);
  const signature = parseExpectedFnType(substitutedExpected);
  if (!signature || signature.params.length !== arg.params.length) return;
  const fnEnv = new Map(context.runtimeEnv ?? []);
  signature.params.forEach((param, index) => {
    const name = arg.params[index];
    if (name) fnEnv.set(name, param.type);
  });
  const bodyType = inferExprType(arg.body, context, fnEnv);
  bindTypePattern(signature.returnType, bodyType, bindings, context.types, context.consts);
}

function collectExplicitConstArgNames(
  expr: Expr | undefined,
  functions: Map<string, FnDecl>,
  names = new Set<string>(),
): Set<string> {
  if (!expr) return names;
  if (expr.kind === "call") {
    if (expr.callee.kind === "var") {
      const fn = functions.get(expr.callee.name);
      fn?.params.forEach((param, index) => {
        const arg = expr.args[index];
        if (param.const && arg?.kind === "var") names.add(arg.name);
      });
    }
    collectExplicitConstArgNames(expr.callee, functions, names);
    expr.args.forEach((arg) => collectExplicitConstArgNames(arg, functions, names));
    return names;
  }
  if (expr.kind === "block") {
    expr.statements.forEach((stmt) => {
      if (
        (stmt.kind === "let" || stmt.kind === "destructure_let") && isRuntimeExprNode(stmt.value)
      ) {
        collectExplicitConstArgNames(stmt.value, functions, names);
      }
    });
    collectExplicitConstArgNames(expr.expr, functions, names);
    return names;
  }
  if (expr.kind === "binary") {
    collectExplicitConstArgNames(expr.left, functions, names);
    collectExplicitConstArgNames(expr.right, functions, names);
  } else if (expr.kind === "index") {
    collectExplicitConstArgNames(expr.target, functions, names);
    collectExplicitConstArgNames(expr.index, functions, names);
  } else if (expr.kind === "field") {
    collectExplicitConstArgNames(expr.value, functions, names);
    collectExplicitConstArgNames(expr.key, functions, names);
  } else if (expr.kind === "match") {
    collectExplicitConstArgNames(expr.value, functions, names);
    expr.arms.forEach((arm) => collectExplicitConstArgNames(arm.value, functions, names));
  } else if (expr.kind === "pipe_bind") {
    collectExplicitConstArgNames(expr.value, functions, names);
    collectExplicitConstArgNames(expr.body, functions, names);
  } else if (expr.kind === "shape" || expr.kind === "product_constructor") {
    expr.slots.forEach((slot) => {
      collectExplicitConstArgNames(slot.index, functions, names);
      collectExplicitConstArgNames(slot.value, functions, names);
    });
  } else if (expr.kind === "range") {
    collectExplicitConstArgNames(expr.start, functions, names);
    collectExplicitConstArgNames(expr.end, functions, names);
  } else if (expr.kind === "static_for_slots") {
    collectExplicitConstArgNames(expr.value, functions, names);
  }
  return names;
}

function isRuntimeExprNode(value: Expr | TypeExpr): value is Expr {
  return !value.kind.startsWith("type_");
}

function inferredStaticArgValue(
  param: Param,
  bindings: Map<string, string>,
  expectedType: string | undefined,
  context: ConstSpecializationContext,
): { name: string; value: ConstValue } | undefined {
  const binding = bindings.get(param.name)?.trim();
  if (!binding) return undefined;
  const constValue = context.consts.get(binding);
  if (constValue && (!expectedType || constValueMatchesExpectedType(constValue, expectedType))) {
    return { name: binding, value: constValue };
  }
  const keyed = constValueFromKeyName(binding);
  if (keyed && (!expectedType || constValueMatchesExpectedType(keyed, expectedType))) {
    return { name: renderConstTypeArg(keyed), value: keyed };
  }
  if (/^-?[0-9]+$/.test(binding)) {
    const value: ConstValue = { kind: "number", value: binding };
    if (!expectedType || literalValueMatchesType(value, expectedType)) {
      return { name: literalConstName(value), value };
    }
  }
  if (context.functions.has(binding)) {
    const value: ConstValue = { kind: "fn", name: binding };
    if (!expectedType || constValueMatchesExpectedType(value, expectedType)) {
      return { name: binding, value };
    }
  }
  const knownTypeProof = isKnownTypeProof(binding, context.types) || /^[A-Z]/.test(binding);
  if ((expectedType === "type" || !expectedType) && knownTypeProof) {
    const value: ConstValue = { kind: "type", name: binding };
    if (!expectedType || constValueMatchesExpectedType(value, expectedType)) {
      return { name: binding, value };
    }
  }
  return undefined;
}

function isInlineableGeneratedSpecializationSource(fn: FnDecl): boolean {
  if (operatorContractTypeVars(fn).size > 0) return true;
  const owner = fn.memberOf?.owner;
  const terminalOwner = owner ? terminalName(owner).toLowerCase() : undefined;
  return terminalOwner === "iter" || terminalOwner === "compactiter" ||
    terminalOwner === "compact_iter" || terminalOwner === "query";
}

function exprCallsFunction(expr: Expr | undefined, name: string): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "do":
      return expr.statements.some((stmt) =>
        (stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
          stmt.kind === "destructure_let") &&
        exprCallsFunction(stmt.value, name)
      ) || exprCallsFunction(expr.expr, name);
    case "const_fn":
      return exprCallsFunction(expr.body, name);
    case "profile":
      return expr.args.some((arg) => exprCallsFunction(arg, name)) ||
        exprCallsFunction(expr.body, name);
    case "call":
      return (expr.callee.kind === "var" && expr.callee.name === name) ||
        exprCallsFunction(expr.callee, name) ||
        expr.args.some((arg) => exprCallsFunction(arg, name));
    case "index":
      return exprCallsFunction(expr.target, name) || exprCallsFunction(expr.index, name);
    case "binary":
      return exprCallsFunction(expr.left, name) || exprCallsFunction(expr.right, name);
    case "operator_chain":
      return exprCallsFunction(expr.first, name) ||
        expr.rest.some((item) => exprCallsFunction(item.value, name));
    case "pipe_bind":
      return exprCallsFunction(expr.value, name) || exprCallsFunction(expr.body, name);
    case "match":
      return exprCallsFunction(expr.value, name) ||
        expr.arms.some((arm) => exprCallsFunction(arm.value, name));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) => exprCallsFunction(slot.value, name));
    case "static_for_slots":
      return exprCallsFunction(expr.value, name) ||
        exprCallsFunction(
          expr.source.kind === "range" ? expr.source.start : expr.source.shape,
          name,
        ) ||
        (expr.source.kind === "range" && exprCallsFunction(expr.source.end, name));
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
      return false;
  }
}

function staticConstArgValue(
  arg: Expr,
  expectedType: string | undefined,
  context: StaticConstArgContext,
  staticValues = new Map<string, ConstValue>(),
): { name: string; value: ConstValue } | undefined {
  const helper = expectedType && hasConstFnHelperContext(context)
    ? synthesizeConstFnHelper(arg, expectedType, context, staticValues)
    : undefined;
  if (helper) return helper;
  if (arg.kind === "literal") {
    const evaluatedStaticValue = staticConstExprValue(arg, staticValues, context);
    if (evaluatedStaticValue && !expectedType) {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
    if (
      evaluatedStaticValue && expectedType &&
      constValueMatchesExpectedType(evaluatedStaticValue, expectedType)
    ) {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
  }
  if (arg.kind === "var") {
    const staticValue = staticValues.get(arg.name) ?? constValueFromKeyName(arg.name);
    if (staticValue && !expectedType) {
      return { name: renderConstTypeArg(staticValue), value: staticValue };
    }
    if (staticValue?.kind === "fn" && expectedType === "type") {
      return { name: renderConstTypeArg(staticValue), value: staticValue };
    }
    if (staticValue?.kind === "fn" && expectedType?.trim().startsWith("fn(")) {
      return { name: renderConstTypeArg(staticValue), value: staticValue };
    }
    if (staticValue && expectedType && constValueMatchesExpectedType(staticValue, expectedType)) {
      return { name: renderConstTypeArg(staticValue), value: staticValue };
    }
  }
  if (
    arg.kind === "binary" ||
    (arg.kind === "call" && arg.callee.kind === "var" && isStaticBuiltinName(arg.callee.name))
  ) {
    const evaluatedStaticValue = staticConstExprValue(arg, staticValues, context);
    if (evaluatedStaticValue && !expectedType) {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
    if (evaluatedStaticValue?.kind === "fn" && expectedType === "type") {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
    if (
      evaluatedStaticValue && expectedType &&
      (constValueMatchesExpectedType(evaluatedStaticValue, expectedType) ||
        (expectedType === "type" && evaluatedStaticValue.kind === "shape"))
    ) {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
  }
  if (arg.kind === "shape") {
    const evaluatedStaticValue = staticConstExprValue(arg, staticValues, context);
    if (evaluatedStaticValue && !expectedType) {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
    if (
      evaluatedStaticValue && expectedType &&
      (constValueMatchesExpectedType(evaluatedStaticValue, expectedType) ||
        (expectedType === "type" && evaluatedStaticValue.kind === "shape"))
    ) {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
  }
  if (arg.kind === "call" && arg.callee.kind === "var" && isStaticBuiltinName(arg.callee.name)) {
    return undefined;
  }
  const proof = renderTypeProofArg(arg);
  if (proof && !expectedType) {
    if (isInferredTypeVarName(proof) && !staticValues.has(proof) && !context.consts.has(proof)) {
      return undefined;
    }
    return { name: proof, value: { kind: "type", name: proof } };
  }
  if (
    proof && expectedType &&
    (typeProofMatchesExpected(proof, expectedType) ||
      (expectedType === "type" && isKnownStaticProofArg(proof, context.types)))
  ) {
    if (isInferredTypeVarName(proof) && !staticValues.has(proof) && !context.consts.has(proof)) {
      return undefined;
    }
    return { name: proof, value: { kind: "type", name: proof } };
  }
  if (
    proof && expectedType === "type" && arg.kind === "call" && arg.callee.kind === "var" &&
    isStaticBuiltinName(arg.callee.name)
  ) {
    return { name: proof, value: { kind: "type", name: proof } };
  }
  if (arg.kind === "var") {
    const value = context.consts.get(arg.name);
    if (value && !expectedType) {
      return { name: arg.name, value };
    }
    if (value && expectedType && constValueMatchesExpectedType(value, expectedType)) {
      return { name: arg.name, value };
    }
    if (!expectedType && /^[A-Z]/.test(arg.name)) {
      return { name: arg.name, value: { kind: "type", name: arg.name } };
    }
    if (!expectedType && context.functions.has(arg.name)) {
      return { name: arg.name, value: { kind: "fn", name: arg.name } };
    }
    if (expectedType === "type" && /^[A-Z]/.test(arg.name)) {
      return { name: arg.name, value: { kind: "type", name: arg.name } };
    }
    if (expectedType === "type" && arg.name.startsWith("struct(")) {
      return { name: arg.name, value: { kind: "type", name: arg.name } };
    }
    if (expectedType === "type" && context.functions.has(arg.name)) {
      return { name: arg.name, value: { kind: "fn", name: arg.name } };
    }
    if (expectedType?.trim().startsWith("fn(") && context.functions.has(arg.name)) {
      return { name: arg.name, value: { kind: "fn", name: arg.name } };
    }
  }
  if (arg.kind === "literal") {
    const value = literalConstValue(arg);
    if (value && (!expectedType || literalValueMatchesType(value, expectedType))) {
      return { name: literalConstName(value), value };
    }
  }
  return undefined;
}

function constValueMatchesExpectedType(value: ConstValue, expectedType: string): boolean {
  if (expectedType === "type" && value.kind === "type") return true;
  if (expectedType === "const" && value.kind === "shape") return true;
  return literalValueMatchesType(value, expectedType) || value.type === expectedType;
}

function typeProofMatchesExpected(proof: string, expectedType: string): boolean {
  if (isInferredTypeVarName(expectedType.trim())) return true;
  const proofDomain = parseRefinedI32Type(proof);
  const expectedDomain = parseRefinedI32Type(expectedType);
  if (proofDomain || expectedDomain) {
    return refinedI32TypeCanonical(proof) === refinedI32TypeCanonical(expectedType);
  }
  if (proof === expectedType) return true;
  const proofCall = proof.match(/^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  const expectedCall = expectedType.match(/^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  if (!proofCall || !expectedCall) return terminalName(proof) === terminalName(expectedType);
  if (terminalName(proofCall[1]) !== terminalName(expectedCall[1])) return false;
  const proofArgs = splitTypeArgs(proofCall[2]);
  const expectedArgs = splitTypeArgs(expectedCall[2]);
  return proofArgs.length === expectedArgs.length &&
    proofArgs.every((arg, index) =>
      typeProofMatchesExpected(arg.trim(), expectedArgs[index]!.trim())
    );
}

function constValueFromKeyName(name: string): ConstValue | undefined {
  if (
    ["i32", "u32", "i64", "u64", "f32", "f64", "bool", "string", "io"].includes(name) ||
    isUnsignedIntegerType(name)
  ) {
    return { kind: "type", name };
  }
  const shape = constShapeValueFromTypeArg(name);
  if (shape) return shape;
  if (!name.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(name);
    return isConstValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function constShapeValueFromTypeArg(source: string): ConstValue | undefined {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return { kind: "shape", slots: [] };
  return {
    kind: "shape",
    slots: splitTypeArgs(inner).map((part) => {
      const colon = topLevelTypeColon(part);
      if (colon < 0) return { value: constValueFromRenderedTypeArg(part.trim()) };
      return {
        label: part.slice(0, colon).trim(),
        value: constValueFromRenderedTypeArg(part.slice(colon + 1).trim()),
      };
    }),
  };
}

function constValueFromRenderedTypeArg(source: string): ConstValue {
  const nestedShape = constShapeValueFromTypeArg(source);
  if (nestedShape) return nestedShape;
  if (source === "true" || source === "false") return { kind: "bool", value: source === "true" };
  if (/^-?[0-9]+(?:\.[0-9]+)?(?:i32|u32|i64|u64|f32|f64)?$/.test(source)) {
    return { kind: "number", value: source };
  }
  if (source.startsWith("'") && source.endsWith("'")) {
    return { kind: "char", value: JSON.parse(`"${source.slice(1, -1)}"`) };
  }
  if (source.startsWith('"') && source.endsWith('"')) {
    return { kind: "string", value: JSON.parse(source) };
  }
  if (source.startsWith("#")) return { kind: "literal_type", value: source.slice(1) };
  return { kind: "type", name: source };
}

function isConstValue(value: unknown): value is ConstValue {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (
    kind === "bool" || kind === "number" || kind === "char" || kind === "string" ||
    kind === "literal_type" || kind === "type" || kind === "fn" || kind === "never"
  ) {
    return true;
  }
  if (kind !== "shape") return false;
  const slots = (value as { slots?: unknown }).slots;
  return Array.isArray(slots) &&
    slots.every((slot) =>
      !!slot && typeof slot === "object" &&
      (!("label" in slot) || typeof (slot as { label?: unknown }).label === "string") &&
      isConstValue((slot as { value?: unknown }).value)
    );
}

function isKnownTypeProof(proof: string, types: TypeDecl[]): boolean {
  const name = typeNameOf(proof);
  return [
    "i32",
    "u32",
    "i64",
    "u64",
    "f32",
    "f64",
    "bool",
    "string",
    "io",
  ].includes(name) || types.some((type) => type.name === name || type.name === terminalName(name));
}

function isKnownStaticProofArg(proof: string, types: TypeDecl[]): boolean {
  return isKnownTypeProof(proof, types) || refinedI32TypeCanonical(proof) !== undefined ||
    /^-?[0-9]+$/.test(proof);
}

function exprLooksLikeTypeProof(expr: Expr, types: TypeDecl[]): boolean {
  const proof = renderTypeProofArg(expr);
  return proof ? isKnownStaticProofArg(proof, types) : false;
}

function synthesizeConstFnHelper(
  arg: Expr,
  expectedType: string,
  context: ConstSpecializationContext,
  staticValues = new Map<string, ConstValue>(),
): { name: string; value: ConstValue } | undefined {
  if (arg.kind !== "const_fn") return undefined;
  const signature = parseExpectedFnType(expectedType);
  if (!signature) {
    context.diagnostics.push({
      code: "const.const_fn_expected_fn",
      message: "const fn literal requires an expected const fn parameter",
      span: exprDiagnosticSpan(arg) ?? context.diagnosticSpan,
    });
    return undefined;
  }
  if (typeHasFreeInferredVars(expectedType, context.consts)) return undefined;
  if (arg.params.length !== signature.params.length) {
    context.diagnostics.push({
      code: "const.const_fn_arity",
      message:
        `const fn literal has ${arg.params.length} parameter(s), expected ${signature.params.length}`,
      span: exprDiagnosticSpan(arg) ?? context.diagnosticSpan,
    });
    return undefined;
  }
  const paramNames = new Set(arg.params);
  const captureNames = [...exprRuntimeCaptures(arg.body)].filter((name) =>
    !paramNames.has(name) && !context.functions.has(name) && !context.consts.has(name) &&
    !staticValues.has(name) && !isKnownQualifiedGlobalRoot(name, context, staticValues)
  );
  const captures = captureNames.map((name) => {
    const type = context.runtimeEnv?.get(name);
    return type ? { name, type } : undefined;
  });
  if (captures.length && !arg.allowCaptures) {
    context.diagnostics.push({
      code: "const.const_fn_capture",
      message: `const fn literal cannot capture runtime local ${captureNames[0]}`,
      span: exprDiagnosticSpan(arg) ?? context.diagnosticSpan,
    });
    return undefined;
  }
  const missing = captures.find((capture) => !capture);
  if (missing) {
    context.diagnostics.push({
      code: "const.const_fn_capture",
      message: `const fn literal cannot capture runtime local ${
        captureNames[captures.indexOf(missing)]
      }`,
      span: exprDiagnosticSpan(arg) ?? context.diagnosticSpan,
    });
    return undefined;
  }
  const body = annotateTailRecTarget(arg.body, arg.tailRecTarget);
  const key = `__const_fn\0${expectedType}\0${arg.tailRecTarget ?? ""}\0${JSON.stringify(body)}`;
  let fn = context.cache.get(key);
  if (!fn) {
    const name = allocateSpecializationName(
      "__const_fn",
      [expectedType, JSON.stringify(body)],
      context.usedNames,
    );
    fn = {
      kind: "fn",
      public: false,
      name,
      params: signature.params.map((param, index) => ({
        name: arg.params[index] ?? param.name,
        type: param.type,
      })).concat(captures.filter((capture): capture is Param => !!capture)),
      returnType: signature.returnType,
      effects: [],
      body: { kind: "block", statements: [], expr: body },
      generated: true,
      ...(arg.tailRecTarget ? { tailRecTarget: arg.tailRecTarget } : {}),
    };
    fn.generatedInlineable = !exprCallsFunction(fn.body, fn.name);
    context.cache.set(key, fn);
    context.functions.set(name, fn);
    context.constFnCaptures.set(name, captures.filter((capture): capture is Param => !!capture));
  }
  return { name: fn.name, value: { kind: "fn", name: fn.name } };
}

function synthesizeRuntimeClosureExpr(
  arg: Extract<Expr, { kind: "const_fn" }>,
  expectedType: string,
  context: ConstSpecializationContext,
  env: Map<string, string>,
): Expr | undefined {
  let body = arg.body;
  if (context.activeStaticValues) {
    const previousRuntimeEnv = context.runtimeEnv;
    context.runtimeEnv = env;
    try {
      body = substituteSpecializedExpr(
        body,
        new Map(),
        context.activeStaticValues.values,
        context.activeStaticValues.names,
        context,
      );
    } finally {
      context.runtimeEnv = previousRuntimeEnv;
    }
    for (const [name, value] of context.activeStaticValues.values) {
      if (value.kind !== "fn") continue;
      const target = context.activeStaticValues.names.get(name) ?? value.name;
      body = replaceNamedVar(body, name, { kind: "var", name: target });
    }
  }
  const signature = parseExpectedFnType(expectedType);
  if (!signature) {
    context.diagnostics.push({
      code: "const.const_fn_expected_fn",
      message: "fn literal requires an expected function type",
      span: exprDiagnosticSpan(arg) ?? context.diagnosticSpan,
    });
    return undefined;
  }
  if (arg.params.length !== signature.params.length) {
    context.diagnostics.push({
      code: "const.const_fn_arity",
      message:
        `fn literal has ${arg.params.length} parameter(s), expected ${signature.params.length}`,
      span: exprDiagnosticSpan(arg) ?? context.diagnosticSpan,
    });
    return undefined;
  }
  body = annotateTailRecTarget(body, arg.tailRecTarget);
  const paramNames = new Set(arg.params);
  const captureNames = [...exprRuntimeCaptures(body)].filter((name) =>
    !paramNames.has(name) && !context.functions.has(name) && !context.consts.has(name) &&
    !isKnownQualifiedGlobalRoot(name, { ...context, runtimeEnv: env })
  );
  const captures = captureNames.map((name) => {
    const type = env.get(name) ?? context.runtimeEnv?.get(name);
    return type ? { name, type } : undefined;
  });
  const missing = captures.find((capture) => !capture);
  if (missing) {
    context.diagnostics.push({
      code: "const.const_fn_capture",
      message: `fn literal cannot capture runtime local ${captureNames[captures.indexOf(missing)]}`,
      span: exprDiagnosticSpan(arg) ?? context.diagnosticSpan,
    });
    return undefined;
  }
  const captureParams = captures.filter((capture): capture is Param => !!capture);
  const key = `__closure_fn\0${expectedType}\0${arg.tailRecTarget ?? ""}\0${JSON.stringify(body)}\0${
    captureParams.map((capture) => `${capture.name}:${capture.type}`).join("\0")
  }`;
  let fn = context.runtimeClosureCache.get(key);
  if (!fn) {
    const name = allocateSpecializationName(
      "__closure_fn",
      [expectedType, JSON.stringify(body), ...captureParams.map((capture) => capture.name)],
      context.usedNames,
    );
    fn = {
      kind: "fn",
      public: false,
      name,
      params: signature.params.map((param, index) => ({
        name: arg.params[index] ?? param.name,
        type: param.type,
      })).concat(captureParams),
      returnType: signature.returnType,
      effects: [],
      body: { kind: "block", statements: [], expr: body },
      generated: true,
      generatedInlineable: false,
      ...(arg.tailRecTarget ? { tailRecTarget: arg.tailRecTarget } : {}),
    };
    context.runtimeClosureCache.set(key, fn);
    context.functions.set(name, fn);
    const previousRuntimeEnv = context.runtimeEnv;
    context.runtimeEnv = new Map(fn.params.map((param) => [param.name, param.type]));
    try {
      specializeBlock(
        fn.body,
        context,
        new Map(fn.params.map((param) => [param.name, param.type])),
        fn.returnType,
      );
    } finally {
      context.runtimeEnv = previousRuntimeEnv;
    }
  }
  return runtimeClosureMakeExpr(
    fn.name,
    captureParams.map((param) => ({ kind: "var", name: param.name } as Expr)),
  );
}

function runtimeClosureMakeExpr(target: string, captures: Expr[]): Expr {
  return {
    kind: "call",
    callee: { kind: "var", name: `@closure_make/${target}` },
    args: captures,
  };
}

function isKnownQualifiedGlobalRoot(
  name: string,
  context: {
    functions: Map<string, FnDecl>;
    consts: Map<string, ConstValue>;
    runtimeEnv?: Map<string, string>;
  },
  staticValues = new Map<string, ConstValue>(),
): boolean {
  if (context.runtimeEnv?.has(name)) return false;
  const prefix = `${name}.`;
  for (const key of context.functions.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  for (const key of context.consts.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  for (const key of staticValues.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function parseExpectedFnType(
  source: string,
): { params: { name: string; type: string }[]; returnType: string } | undefined {
  const trimmed = source.trim();
  if (!trimmed.startsWith("fn(")) return undefined;
  const close = findMatchingParen(trimmed, 2);
  if (close < 0) return undefined;
  const rest = trimmed.slice(close + 1).trim();
  if (!rest.startsWith("->")) return undefined;
  const paramsSource = trimmed.slice(3, close).trim();
  const params = paramsSource
    ? splitTypeArgs(paramsSource).map((param, index) => {
      const colon = topLevelTypeColon(param);
      if (colon < 0) return undefined;
      const name = param.slice(0, colon).trim();
      const type = param.slice(colon + 1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !type) return undefined;
      return { name, type, index };
    })
    : [];
  if (params.some((param) => !param)) return undefined;
  return {
    params: params.map((param) => ({ name: param!.name, type: param!.type })),
    returnType: rest.slice(2).trim(),
  };
}

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function exprRuntimeCaptures(expr: Expr): Set<string> {
  const captures = new Set<string>();
  const visit = (item: Expr, bound = new Set<string>()) => {
    if (item.kind === "var") {
      const rootName = item.name.split(".")[0] ?? item.name;
      if (!bound.has(rootName)) captures.add(rootName);
      return;
    }
    if (item.kind === "const_fn") {
      const scoped = new Set(bound);
      for (const param of item.params) scoped.add(param);
      visit(item.body, scoped);
      return;
    }
    if (item.kind === "pipe_bind") {
      visit(item.value, bound);
      visit(item.body, new Set(bound).add(item.name));
      return;
    }
    if (item.kind === "match") {
      visit(item.value, bound);
      for (const arm of item.arms) {
        const scoped = new Set(bound);
        for (const name of patternBindingNames(arm.pattern)) scoped.add(name);
        visit(arm.value, scoped);
      }
      return;
    }
    if (item.kind === "static_for_slots") {
      if (item.source.kind === "range") {
        visit(item.source.start, bound);
        visit(item.source.end, bound);
      } else {
        visit(item.source.shape, bound);
      }
      const scoped = new Set(bound).add(item.iterator);
      if (item.valueIterator) scoped.add(item.valueIterator);
      visit(item.value, scoped);
      return;
    }
    if (item.kind === "block") {
      const scoped = new Set(bound);
      for (const stmt of item.statements) {
        if (stmt.kind === "let") {
          visit(stmt.value, scoped);
          scoped.add(stmt.name);
        } else if (stmt.kind === "destructure_let") {
          visit(stmt.value, scoped);
          for (const name of stmt.names) scoped.add(name);
        }
      }
      if (item.expr) visit(item.expr, scoped);
      return;
    }
    for (const child of exprChildren(item)) visit(child, bound);
  };
  visit(expr);
  return captures;
}

function replaceNamedVar(expr: Expr, name: string, replacement: Expr): Expr {
  if (expr.kind === "var" && expr.name === name) return cloneExpr(replacement);
  switch (expr.kind) {
    case "do":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
            ? { ...stmt, value: replaceNamedVar(stmt.value, name, replacement) }
            : stmt
        ),
        expr: expr.expr ? replaceNamedVar(expr.expr, name, replacement) : undefined,
      };
    case "const_fn":
      return expr.params.includes(name)
        ? expr
        : { ...expr, body: replaceNamedVar(expr.body, name, replacement) };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => replaceNamedVar(arg, name, replacement)),
        body: replaceNamedVar(expr.body, name, replacement),
      };
    case "call":
      if (expr.tailRec) {
        return {
          ...expr,
          args: expr.args.map((arg) => replaceNamedVar(arg, name, replacement)),
        };
      }
      return {
        ...expr,
        callee: replaceNamedVar(expr.callee, name, replacement),
        args: expr.args.map((arg) => replaceNamedVar(arg, name, replacement)),
      };
    case "index":
      return {
        ...expr,
        target: replaceNamedVar(expr.target, name, replacement),
        index: replaceNamedVar(expr.index, name, replacement),
      };
    case "binary":
      return {
        ...expr,
        left: replaceNamedVar(expr.left, name, replacement),
        right: replaceNamedVar(expr.right, name, replacement),
      };
    case "operator_chain":
      return {
        ...expr,
        first: replaceNamedVar(expr.first, name, replacement),
        rest: expr.rest.map((item) => ({
          ...item,
          value: replaceNamedVar(item.value, name, replacement),
        })),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: replaceNamedVar(expr.value, name, replacement),
        body: expr.name === name ? expr.body : replaceNamedVar(expr.body, name, replacement),
      };
    case "match":
      return {
        ...expr,
        value: replaceNamedVar(expr.value, name, replacement),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: replaceNamedVar(arm.value, name, replacement),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: replaceNamedVar(slot.value, name, replacement),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: replaceStaticForSourceNamedVar(expr.source, name, replacement),
        value: replaceNamedVar(expr.value, name, replacement),
      };
    case "field":
      return {
        ...expr,
        value: replaceNamedVar(expr.value, name, replacement),
        key: replaceNamedVar(expr.key, name, replacement),
      };
    case "range":
      return {
        ...expr,
        start: replaceNamedVar(expr.start, name, replacement),
        end: replaceNamedVar(expr.end, name, replacement),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) => {
          if (stmt.kind === "let") {
            return {
              ...stmt,
              value: replaceNamedVar(stmt.value, name, replacement),
            };
          }
          if (stmt.kind === "destructure_let") {
            return { ...stmt, value: replaceNamedVar(stmt.value, name, replacement) };
          }
          return stmt;
        }),
        expr: expr.expr ? replaceNamedVar(expr.expr, name, replacement) : undefined,
      };
    case "literal":
    case "var":
      return expr;
  }
}

function replaceStaticForSourceNamedVar(
  source: Extract<Expr, { kind: "static_for_slots" }>["source"],
  name: string,
  replacement: Expr,
): Extract<Expr, { kind: "static_for_slots" }>["source"] {
  return source.kind === "range"
    ? {
      kind: "range",
      start: replaceNamedVar(source.start, name, replacement),
      end: replaceNamedVar(source.end, name, replacement),
    }
    : { kind: "shape", shape: replaceNamedVar(source.shape, name, replacement) };
}

function exprChildren(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "do":
      return [
        ...expr.statements.flatMap((stmt) =>
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
            ? [stmt.value]
            : []
        ),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "const_fn":
      return [expr.body];
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
    case "profile":
      return [...expr.args, expr.body];
    case "match":
      return [
        expr.value,
        ...expr.arms.flatMap((arm) => arm.guard ? [arm.guard, arm.value] : [arm.value]),
      ];
    case "shape":
    case "product_constructor":
      return expr.slots.map((slot) => slot.value);
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
          stmt.kind === "let" ? [stmt.value] : stmt.kind === "destructure_let" ? [stmt.value] : []
        ),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "literal":
    case "var":
      return [];
  }
}

function substituteConstParamType(
  source: string,
  values: Map<string, ConstValue>,
  names: Map<string, string> = new Map(),
): string {
  let result = source;
  for (const [name, value] of values) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    if (value.kind === "type") {
      result = result.replace(pattern, value.name);
    } else if (value.kind === "number") {
      result = result.replace(pattern, value.value);
    } else if (names.has(name)) {
      result = result.replace(pattern, names.get(name) ?? name);
    }
  }
  return result;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderTypeProofArg(expr: Expr): string | undefined {
  if (expr.kind === "literal" && expr.literalKind === "number") return expr.value;
  if (expr.kind === "literal" && expr.literalKind === "bool") return expr.value;
  if (expr.kind === "literal" && expr.literalKind === "literalType") return expr.value;
  if (expr.kind === "literal" && expr.literalKind === "string") return expr.value;
  if (expr.kind === "literal" && expr.literalKind === "char") return expr.value;
  if (expr.kind === "var") return canonicalTypeProofName(expr.name);
  if (expr.kind === "range") {
    const start = renderTypeProofArg(expr.start);
    const end = renderTypeProofArg(expr.end);
    return start && end ? `${start}..${end}` : undefined;
  }
  if (expr.kind === "call" && expr.callee.kind === "var") {
    const args = expr.args.map(renderTypeProofArg);
    if (args.some((arg) => arg === undefined)) return undefined;
    return canonicalTypeProofName(`${expr.callee.name}(${args.join(", ")})`);
  }
  if (expr.kind === "shape") {
    const slots = expr.slots.map((slot) => {
      const type = renderTypeProofArg(slot.value);
      if (!type) return undefined;
      return `${slot.label ? `${slot.label}: ` : ""}${type}`;
    });
    if (slots.some((slot) => slot === undefined)) return undefined;
    return `{${slots.join(", ")}}`;
  }
  return undefined;
}

function canonicalTypeProofName(proof: string): string {
  return refinedI32TypeCanonical(proof) ?? proof;
}

function allocateSpecializationName(
  fnName: string,
  constArgNames: string[],
  usedNames: Set<string>,
): string {
  const base = sanitizeIdentifier(`${fnName}__${constArgNames.join("__")}`);
  let name = base;
  let suffix = 2;
  while (usedNames.has(name)) name = `${base}__${suffix++}`;
  usedNames.add(name);
  return name;
}

function sanitizeIdentifier(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_]/g, "_");
}

function isInlineArrayExprBuiltin(name: string): boolean {
  return [
    "@inline_array_tabulate",
    "@inline_array_tabulate_with",
    "@inline_array_imap",
    "@inline_array_map",
    "@inline_array_imap_with_state",
    "@inline_array_fill",
    "@inline_array_set",
    "@inline_array_update",
  ].includes(name);
}

function expandInlineArrayExprBuiltin(
  name: string,
  args: Expr[],
  staticValues: Map<string, ConstValue>,
  context: ConstSpecializationContext,
): Expr | undefined {
  const iterator = "i";
  const n = args[0];
  if (!n) return undefined;
  const source: StaticForSource = {
    kind: "range",
    start: { kind: "literal", literalKind: "number", value: "0" },
    end: n,
  };
  const index: Expr = { kind: "var", name: iterator };
  const call = (callee: Expr | undefined, callArgs: Expr[]): Expr =>
    callee
      ? { kind: "call", callee, args: callArgs }
      : { kind: "literal", literalKind: "number", value: "0" };
  const indexed = (target: Expr | undefined): Expr =>
    target
      ? { kind: "index", target, index: cloneExpr(index) }
      : { kind: "literal", literalKind: "number", value: "0" };
  let value: Expr | undefined;
  switch (name) {
    case "@inline_array_tabulate":
      value = call(args[2], [cloneExpr(index)]);
      break;
    case "@inline_array_tabulate_with":
      value = call(args[4], [cloneExpr(index), args[3] ?? cloneExpr(index)]);
      break;
    case "@inline_array_imap": {
      const x = indexed(args[3]);
      value = call(args[4], [cloneExpr(index), x]);
      break;
    }
    case "@inline_array_map": {
      const x = indexed(args[3]);
      value = call(args[4], [x]);
      break;
    }
    case "@inline_array_imap_with_state": {
      const x = indexed(args[4]);
      value = call(args[6], [cloneExpr(index), x, args[5] ?? cloneExpr(index)]);
      break;
    }
    case "@inline_array_fill":
      value = args[2];
      break;
    case "@inline_array_set":
      value = {
        kind: "match",
        value: {
          kind: "binary",
          op: "==",
          left: cloneExpr(index),
          right: args[3] ?? cloneExpr(index),
        },
        arms: [
          { pattern: literalPattern("true", "bool"), value: args[4] ?? cloneExpr(index) },
          { pattern: literalPattern("false", "bool"), value: indexed(args[2]) },
        ],
      };
      break;
    case "@inline_array_update":
      value = {
        kind: "match",
        value: {
          kind: "binary",
          op: "==",
          left: cloneExpr(index),
          right: args[3] ?? cloneExpr(index),
        },
        arms: [
          { pattern: literalPattern("true", "bool"), value: call(args[4], [indexed(args[2])]) },
          { pattern: literalPattern("false", "bool"), value: indexed(args[2]) },
        ],
      };
      break;
  }
  if (!value) return undefined;
  const slot = {
    value: {
      kind: "static_for_slots" as const,
      iterator,
      source,
      labeled: false,
      value,
    },
  };
  return {
    kind: "shape",
    slots: expandSpecializedShapeSlot(slot, new Map(), staticValues, new Map(), context),
  };
}

function substituteSpecializedExpr(
  expr: Expr,
  values: Map<string, Expr>,
  staticValues: Map<string, ConstValue>,
  staticArgNames: Map<string, string>,
  context: ConstSpecializationContext,
): Expr {
  switch (expr.kind) {
    case "do":
      return lowerDoExpression(
        expr,
        context.diagnostics,
        (child) => substituteSpecializedExpr(child, values, staticValues, staticArgNames, context),
      );
    case "const_fn":
      return {
        ...expr,
        body: substituteSpecializedExpr(expr.body, values, staticValues, staticArgNames, context),
      };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) =>
          substituteSpecializedExpr(arg, values, staticValues, staticArgNames, context)
        ),
        body: substituteSpecializedExpr(expr.body, values, staticValues, staticArgNames, context),
      };
    case "var": {
      const value = values.get(expr.name);
      if (value) return cloneExpr(value);
      if (runtimeEnvHasName(context.runtimeEnv, expr.name)) return expr;
      const staticValue = staticValues.get(expr.name);
      const staticArgName = staticArgNames.get(expr.name);
      if (
        staticArgName &&
        (staticValue?.kind === "shape" || staticValue?.kind === "type" ||
          staticValue?.kind === "fn")
      ) {
        return { kind: "var", name: staticArgName };
      }
      if (
        staticValue && (staticValue.kind === "bool" || staticValue.kind === "number" ||
          staticValue.kind === "string" || staticValue.kind === "literal_type" ||
          staticValue.kind === "type" || staticValue.kind === "fn")
      ) {
        return constValueToExpr(staticValue) ?? expr;
      }
      if (staticArgName) return { kind: "var", name: staticArgName };
      if (staticValue?.kind === "shape") return constValueToExpr(staticValue) ?? expr;
      const assoc = expr.name.indexOf("::");
      const dot = expr.name.indexOf(".");
      const split = assoc > 0 ? assoc : dot;
      if (split > 0) {
        const separator = assoc > 0 ? "::" : ".";
        const base = expr.name.slice(0, split);
        if (runtimeEnvHasName(context.runtimeEnv, base)) return expr;
        const field = expr.name.slice(split + separator.length);
        const staticValue = staticValues.get(base);
        if (staticValue?.kind === "shape") {
          const slot = staticValue.slots.find((item) => item.label === field);
          if (slot?.value.kind === "fn") return { kind: "var", name: slot.value.name };
          const slotExpr = slot ? constValueToExpr(slot.value) : undefined;
          if (slotExpr) return slotExpr;
        }
        if (staticValue?.kind === "type") {
          return { kind: "var", name: `${staticValue.name}${separator}${field}` };
        }
      }
      return expr;
    }
    case "call": {
      if (expr.callee.kind === "var" && expr.callee.name.startsWith("@shape_")) {
        const staticValue = staticConstExprValue(
          expr,
          staticValues,
          { ...context, diagnostics: [] },
        );
        const staticExpr = staticValue ? constValueToExpr(staticValue) : undefined;
        if (staticExpr) return staticExpr;
      }
      const callee = substituteSpecializedExpr(
        expr.callee,
        values,
        staticValues,
        staticArgNames,
        context,
      );
      const args = expr.args.map((arg) =>
        substituteSpecializedExpr(arg, values, staticValues, staticArgNames, context)
      );
      const captured = callee.kind === "var"
        ? context.constFnCaptures.get(callee.name)?.map((param) => ({
          kind: "var" as const,
          name: param.name,
        })) ??
          []
        : [];
      const callArgs = captured.length ? args.concat(captured) : args;
      if (callee.kind === "var" && callee.name === "@replace_field") {
        const replacement = expandReplaceField(callArgs, staticValues, context);
        if (replacement) return replacement;
      }
      if (callee.kind === "var" && callee.name === "@empty") {
        const emptyType = renderTypeProofArg(callArgs[0]);
        const emptyExpr = emptyType ? emptyExprForType(emptyType, context) : undefined;
        if (emptyExpr) return emptyExpr;
        if (context.emitDiagnostics) {
          context.diagnostics.push({
            code: "type.unknown_type_member",
            message: `type ${emptyType ?? "<unknown>"} does not have an empty value`,
            span: callArgs[0]?.span ?? context.diagnosticSpan,
          });
        }
        return { ...expr, callee, args: callArgs };
      }
      const direct = callee.kind === "var" ? context.functions.get(callee.name) : undefined;
      if (direct?.params.some((param) => param.const)) {
        return specializeConstParamCall(
          direct,
          callArgs,
          context,
          callSiteSpan(expr),
          staticValues,
        ) ??
          { ...expr, callee, args: callArgs };
      }
      if (!direct && callee.kind === "var" && args.length === 0) {
        const emptyType = emptyMemberOwner(callee.name);
        const emptyExpr = emptyType ? emptyExprForType(emptyType, context) : undefined;
        if (emptyExpr) return emptyExpr;
        if (emptyType) {
          if (context.emitDiagnostics) {
            context.diagnostics.push({
              code: "type.unknown_type_member",
              message: `type ${emptyType} does not have an empty value`,
              span: context.diagnosticSpan,
            });
          }
        }
      }
      if (callee.kind === "var" && callee.name === "@wgsl_shader_id") {
        const source = stringLiteralValue(callArgs[0]);
        if (source !== undefined) {
          context.addShader(source);
          return { kind: "literal", literalKind: "number", value: String(wgslShaderId(source)) };
        }
      }
      if (callee.kind === "var" && callee.name.startsWith("@shape_")) {
        const staticValue = staticConstExprValue(
          { ...expr, callee, args },
          staticValues,
          context.emitDiagnostics ? context : { ...context, diagnostics: [] },
        );
        const staticExpr = staticValue ? constValueToExpr(staticValue) : undefined;
        if (staticExpr) return staticExpr;
      }
      if (callee.kind === "var" && isInlineArrayExprBuiltin(callee.name)) {
        return expandInlineArrayExprBuiltin(callee.name, callArgs, staticValues, context) ??
          { ...expr, callee, args: callArgs };
      }
      return { ...expr, callee, args: callArgs };
    }
    case "index":
      return {
        ...expr,
        target: substituteSpecializedExpr(
          expr.target,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        index: substituteSpecializedExpr(
          expr.index,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
      };
    case "binary":
      return {
        ...expr,
        left: substituteSpecializedExpr(
          expr.left,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        right: substituteSpecializedExpr(
          expr.right,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
      };
    case "operator_chain":
      return {
        ...expr,
        first: substituteSpecializedExpr(
          expr.first,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        rest: expr.rest.map((item) => ({
          ...item,
          value: substituteSpecializedExpr(
            item.value,
            values,
            staticValues,
            staticArgNames,
            context,
          ),
        })),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: substituteSpecializedExpr(
          expr.value,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        body: substituteSpecializedExpr(
          expr.body,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
      };
    case "match": {
      const value = substituteSpecializedExpr(
        expr.value,
        values,
        staticValues,
        staticArgNames,
        context,
      );
      const staticValue = staticConstExprValue(value, staticValues, context);
      if (staticValue) {
        const selected = expr.arms.find((arm) => constPatternMatches(arm.pattern, staticValue));
        if (selected) {
          return substituteSpecializedExpr(
            selected.value,
            values,
            staticValues,
            staticArgNames,
            context,
          );
        }
      }
      return {
        ...expr,
        value,
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: substituteSpecializedExpr(
            arm.value,
            values,
            staticValues,
            staticArgNames,
            context,
          ),
        })),
      };
    }
    case "shape":
      return {
        ...expr,
        slots: expr.slots.flatMap((slot) =>
          expandSpecializedShapeSlot(slot, values, staticValues, staticArgNames, context)
        ),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.flatMap((slot) =>
          expandSpecializedShapeSlot(slot, values, staticValues, staticArgNames, context)
        ),
      };
    case "range":
      return {
        ...expr,
        start: substituteSpecializedExpr(
          expr.start,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        end: substituteSpecializedExpr(
          expr.end,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
      };
    case "static_for_slots":
      return expr;
    case "field": {
      const value = substituteSpecializedExpr(
        expr.value,
        values,
        staticValues,
        staticArgNames,
        context,
      );
      const key = substituteSpecializedExpr(
        expr.key,
        values,
        staticValues,
        staticArgNames,
        context,
      );
      const label = staticLabelName(key, staticValues) ??
        (expr.key.kind === "var"
          ? staticLabelName(
            { kind: "var", name: staticArgNames.get(expr.key.name) ?? "" },
            staticValues,
          ) ?? staticArgNames.get(expr.key.name)?.replace(/^_+/, "")
          : undefined);
      if (value.kind === "var" && label) return { kind: "var", name: `${value.name}.${label}` };
      return { ...expr, value, key };
    }
    case "block": {
      const scopedValues = new Map(values);
      const scopedStaticValues = new Map(staticValues);
      const scopedStaticArgNames = new Map(staticArgNames);
      const previousRuntimeEnv = context.runtimeEnv;
      context.runtimeEnv = previousRuntimeEnv ? new Map(previousRuntimeEnv) : undefined;
      try {
        const statements: Statement[] = expr.statements.flatMap((stmt): Statement[] => {
          if (stmt.kind === "type_assert") return [];
          if (stmt.kind === "debug_trace") return [stmt];
          for (const name of boundNames(stmt)) {
            scopedValues.delete(name);
            scopedStaticValues.delete(name);
            scopedStaticArgNames.delete(name);
            context.runtimeEnv?.delete(name);
          }
          const value = substituteSpecializedExpr(
            stmt.value,
            scopedValues,
            scopedStaticValues,
            scopedStaticArgNames,
            context,
          );
          if (stmt.kind === "let") {
            const explicit = explicitTypeAnnotation(stmt.type);
            const type = explicit
              ? substituteConstParamType(explicit, scopedStaticValues, scopedStaticArgNames)
              : inferExprType(
                value,
                context,
                context.runtimeEnv ?? new Map(),
              );
            if (type) context.runtimeEnv?.set(stmt.name, type);
            return [{ ...stmt, type: type ?? stmt.type, value }];
          }
          return [{ ...stmt, value }];
        });
        return {
          ...expr,
          statements,
          expr: expr.expr
            ? substituteSpecializedExpr(
              expr.expr,
              scopedValues,
              scopedStaticValues,
              scopedStaticArgNames,
              context,
            )
            : undefined,
        };
      } finally {
        context.runtimeEnv = previousRuntimeEnv;
      }
    }
    case "literal":
      return expr;
  }
}

function runtimeEnvHasName(env: Map<string, string> | undefined, name: string): boolean {
  return Boolean(env?.has(name));
}

function substituteContextWithoutRuntimeBindings(
  context: Parameters<typeof substituteInferredExpr>[4],
  names: string[],
): Parameters<typeof substituteInferredExpr>[4] {
  if (!context || names.length === 0 || !context.runtimeEnv) return context;
  const runtimeEnv = new Map(context.runtimeEnv);
  for (const name of names) runtimeEnv.delete(name);
  return { ...context, runtimeEnv };
}

function substituteContextWithRuntimeBindings(
  context: Parameters<typeof substituteInferredExpr>[4],
  names: string[],
): Parameters<typeof substituteInferredExpr>[4] {
  if (!context || names.length === 0) return context;
  const runtimeEnv = context.runtimeEnv ? new Map(context.runtimeEnv) : new Map<string, string>();
  for (const name of names) runtimeEnv.set(name, runtimeEnv.get(name) ?? "");
  return { ...context, runtimeEnv };
}

function cloneExpr<t extends Expr>(expr: t): t {
  return clonePlainExpr(expr);
}

function clonePlainExpr<t>(value: t, seen = new WeakMap<object, unknown>()): t {
  if (!value || typeof value !== "object") return value;
  const found = seen.get(value as object);
  if (found) return found as t;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(clonePlainExpr(item, seen));
    return out as t;
  }
  const out: Record<string, unknown> = {};
  seen.set(value as object, out);
  const source = value as Record<string, unknown>;
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    out[key] = clonePlainExpr(source[key], seen);
  }
  return out as t;
}

function expandSpecializedShapeSlot(
  slot: { label?: string; value: Expr },
  values: Map<string, Expr>,
  staticValues: Map<string, ConstValue>,
  staticArgNames: Map<string, string>,
  context: ConstSpecializationContext,
): { label?: string; value: Expr }[] {
  const generator = slot.value;
  if (generator.kind !== "static_for_slots") {
    return [{
      ...slot,
      value: substituteSpecializedExpr(slot.value, values, staticValues, staticArgNames, context),
    }];
  }
  const source = staticForItems(generator.source, values, staticValues, staticArgNames, context);
  if (!source) {
    return [{
      ...slot,
      value: {
        ...generator,
        source: substituteSpecializedStaticForSource(
          generator.source,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        value: substituteSpecializedExpr(
          generator.value,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
      },
    }];
  }
  return source.map((item) => {
    const scopedValues = new Map(values);
    const scopedStaticValues = new Map(staticValues);
    const scopedStaticArgNames = new Map(staticArgNames);
    scopedStaticValues.set(generator.iterator, item.key);
    scopedStaticArgNames.set(generator.iterator, renderConstTypeArg(item.key));
    if (generator.valueIterator) {
      scopedStaticValues.set(generator.valueIterator, item.value);
      scopedStaticArgNames.set(generator.valueIterator, renderConstTypeArg(item.value));
    }
    const value = substituteSpecializedExpr(
      generator.value,
      scopedValues,
      scopedStaticValues,
      scopedStaticArgNames,
      context,
    );
    return { label: generator.labeled ? literalName(item.key) : undefined, value };
  });
}

function substituteSpecializedStaticForSource(
  source: StaticForSource,
  values: Map<string, Expr>,
  staticValues: Map<string, ConstValue>,
  staticArgNames: Map<string, string>,
  context: ConstSpecializationContext,
): StaticForSource {
  if (source.kind === "shape") {
    return {
      ...source,
      shape: substituteSpecializedExpr(source.shape, values, staticValues, staticArgNames, context),
    };
  }
  return {
    ...source,
    start: substituteSpecializedExpr(source.start, values, staticValues, staticArgNames, context),
    end: substituteSpecializedExpr(source.end, values, staticValues, staticArgNames, context),
  };
}

function staticForItems(
  source: Extract<Expr, { kind: "static_for_slots" }>["source"],
  values: Map<string, Expr>,
  staticValues: Map<string, ConstValue>,
  staticArgNames: Map<string, string>,
  context: ConstSpecializationContext,
): { key: ConstValue; value: ConstValue }[] | undefined {
  if (source.kind === "range") {
    const startExpr = substituteSpecializedExpr(
      source.start,
      values,
      staticValues,
      staticArgNames,
      context,
    );
    const endExpr = substituteSpecializedExpr(
      source.end,
      values,
      staticValues,
      staticArgNames,
      context,
    );
    const start = staticNumber(startExpr, staticValues);
    const end = staticNumber(endExpr, staticValues);
    if (start === undefined || end === undefined) return undefined;
    return Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
      const value = { kind: "number" as const, value: String(start + offset) };
      return { key: value, value };
    });
  }
  const shapeExpr = substituteSpecializedExpr(
    source.shape,
    values,
    staticValues,
    staticArgNames,
    context,
  );
  const shape = shapeExpr.kind === "var"
    ? staticValues.get(shapeExpr.name)
    : staticConstExprValue(shapeExpr, staticValues, context);
  if (shape?.kind !== "shape") return undefined;
  return shape.slots.map((slot) => ({
    key: { kind: "literal_type", value: slot.label ?? "" },
    value: slot.value,
  }));
}

function staticNumber(expr: Expr, staticValues: Map<string, ConstValue>): number | undefined {
  if (expr.kind === "literal" && expr.literalKind === "number") {
    return staticIntegerNumberLiteral(expr.value);
  }
  if (expr.kind === "var") {
    const value = staticValues.get(expr.name);
    if (value?.kind === "number") return staticIntegerNumberLiteral(value.value);
  }
  if (expr.kind === "binary") {
    const left = staticNumber(expr.left, staticValues);
    const right = staticNumber(expr.right, staticValues);
    if (left === undefined || right === undefined) return undefined;
    if (expr.op === "+") return left + right;
    if (expr.op === "-") return left - right;
  }
  return undefined;
}

function substituteStaticValueRefs(
  expr: Expr,
  staticValues: Map<string, ConstValue>,
  shadowed = new Set<string>(),
): Expr {
  switch (expr.kind) {
    case "var": {
      if (shadowed.has(expr.name)) return expr;
      const value = staticValues.get(expr.name);
      return value ? constValueToExpr(value) ?? expr : expr;
    }
    case "call":
      return {
        ...expr,
        callee: substituteStaticValueRefs(expr.callee, staticValues, shadowed),
        args: expr.args.map((arg) => substituteStaticValueRefs(arg, staticValues, shadowed)),
      };
    case "binary":
      return {
        ...expr,
        left: substituteStaticValueRefs(expr.left, staticValues, shadowed),
        right: substituteStaticValueRefs(expr.right, staticValues, shadowed),
      };
    case "match":
      return {
        ...expr,
        value: substituteStaticValueRefs(expr.value, staticValues, shadowed),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: substituteStaticValueRefs(
            arm.value,
            staticValues,
            shadowNames(shadowed, patternBindingNames(arm.pattern)),
          ),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index
            ? substituteStaticValueRefs(slot.index, staticValues, shadowed)
            : undefined,
          value: substituteStaticValueRefs(slot.value, staticValues, shadowed),
        })),
      };
    case "field":
      return {
        ...expr,
        value: substituteStaticValueRefs(expr.value, staticValues, shadowed),
        key: substituteStaticValueRefs(expr.key, staticValues, shadowed),
      };
    case "block": {
      let scoped = new Set(shadowed);
      const statements = expr.statements.map((stmt): Statement => {
        if (stmt.kind === "type_assert") return stmt;
        if (stmt.kind === "debug_trace") {
          return {
            ...stmt,
            args: stmt.args.map((arg) => substituteStaticValueRefs(arg, staticValues, scoped)),
          };
        }
        const value = substituteStaticValueRefs(stmt.value, staticValues, scoped);
        if (stmt.kind === "let") {
          scoped = shadowNames(scoped, [stmt.name]);
          return { ...stmt, value };
        }
        scoped = shadowNames(scoped, stmt.names);
        return { ...stmt, value };
      });
      return {
        ...expr,
        statements,
        expr: expr.expr ? substituteStaticValueRefs(expr.expr, staticValues, scoped) : undefined,
      };
    }
    case "const_fn":
      return {
        ...expr,
        body: substituteStaticValueRefs(
          expr.body,
          staticValues,
          shadowNames(shadowed, expr.params),
        ),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: substituteStaticValueRefs(expr.value, staticValues, shadowed),
        body: substituteStaticValueRefs(
          expr.body,
          staticValues,
          shadowNames(shadowed, [expr.name]),
        ),
      };
    case "literal":
    case "do":
    case "index":
    case "operator_chain":
    case "profile":
    case "static_for_slots":
    case "range":
      return expr;
  }
}

function staticLabelName(expr: Expr, staticValues: Map<string, ConstValue>): string | undefined {
  if (expr.kind === "literal" && expr.literalKind === "literalType") {
    return expr.value.replace(/^#/, "");
  }
  if (expr.kind === "literal" && expr.literalKind === "string") return expr.value.slice(1, -1);
  if (expr.kind === "var") return literalName(staticValues.get(expr.name));
  return literalName(staticConstExprValue(expr, staticValues));
}

function expandReplaceField(
  args: Expr[],
  staticValues: Map<string, ConstValue>,
  context: ConstSpecializationContext,
): Expr | undefined {
  if (args.length !== 3) return undefined;
  const [source, key, value] = args;
  const label = staticLabelName(key, staticValues);
  if (!label || source.kind !== "var" || !context.runtimeEnv) return undefined;
  const env = new Map(
    [...context.runtimeEnv.entries()].map((
      [name, type],
    ): [string, OwnershipBinding] => [name, { type, moved: false }]),
  );
  const sourceType = projectedBindingType(source.name, env, context.types);
  const slots = structuralProductSlotsForType(
    sourceType,
    context.types,
    context.functions,
    context.consts,
  );
  if (!slots) return undefined;
  if (!slots.some((slot) => slot.label === label)) return undefined;
  return {
    kind: "shape",
    syntax: "record",
    slots: slots.flatMap((slot) => {
      if (!slot.label) return [];
      return [{
        label: slot.label,
        value: slot.label === label ? value : { kind: "var", name: `${source.name}.${slot.label}` },
      }];
    }),
  };
}

function expandReplaceFieldsWithEnv(
  expr: Expr,
  env: Map<string, string>,
  types: TypeDecl[],
): Expr {
  if (expr.kind === "call") {
    const callee = expandReplaceFieldsWithEnv(expr.callee, env, types);
    const args = expr.args.map((arg) => expandReplaceFieldsWithEnv(arg, env, types));
    if (callee.kind === "var" && callee.name === "@replace_field") {
      return expandReplaceFieldWithEnv(args, env, types) ?? { ...expr, callee, args };
    }
    return { ...expr, callee, args };
  }
  if (expr.kind === "block") {
    const scoped = new Map(env);
    const statements = expr.statements.map((stmt) => {
      if (stmt.kind !== "let" && stmt.kind !== "destructure_let") return stmt;
      const value = expandReplaceFieldsWithEnv(stmt.value, scoped, types);
      if (stmt.kind === "let") {
        const type = explicitTypeAnnotation(stmt.type) ?? exprBindingType(
          value,
          new Map([...scoped].map(([name, type]) => [
            name,
            { type, moved: false },
          ])),
          types,
          [],
        );
        if (type) scoped.set(stmt.name, type);
        return { ...stmt, type: type ?? stmt.type, value };
      }
      return { ...stmt, value };
    });
    return {
      ...expr,
      statements,
      expr: expr.expr ? expandReplaceFieldsWithEnv(expr.expr, scoped, types) : undefined,
    };
  }
  if (expr.kind === "const_fn") {
    const scoped = new Map(env);
    for (const param of expr.params) scoped.delete(param);
    return { ...expr, body: expandReplaceFieldsWithEnv(expr.body, scoped, types) };
  }
  if (expr.kind === "pipe_bind") {
    const value = expandReplaceFieldsWithEnv(expr.value, env, types);
    const scoped = new Map(env);
    const valueType = exprBindingType(
      value,
      new Map([...env].map(([name, type]) => [
        name,
        { type, moved: false },
      ])),
      types,
      [],
    );
    if (valueType) scoped.set(expr.name, valueType);
    return { ...expr, value, body: expandReplaceFieldsWithEnv(expr.body, scoped, types) };
  }
  if (expr.kind === "index") {
    return {
      ...expr,
      target: expandReplaceFieldsWithEnv(expr.target, env, types),
      index: expandReplaceFieldsWithEnv(expr.index, env, types),
    };
  }
  if (expr.kind === "binary") {
    return {
      ...expr,
      left: expandReplaceFieldsWithEnv(expr.left, env, types),
      right: expandReplaceFieldsWithEnv(expr.right, env, types),
    };
  }
  if (expr.kind === "match") {
    return {
      ...expr,
      value: expandReplaceFieldsWithEnv(expr.value, env, types),
      arms: expr.arms.map((arm) => ({
        ...arm,
        value: expandReplaceFieldsWithEnv(arm.value, env, types),
      })),
    };
  }
  if (expr.kind === "shape" || expr.kind === "product_constructor") {
    return {
      ...expr,
      slots: expr.slots.map((slot) => ({
        ...slot,
        index: slot.index ? expandReplaceFieldsWithEnv(slot.index, env, types) : undefined,
        value: expandReplaceFieldsWithEnv(slot.value, env, types),
      })),
    };
  }
  if (expr.kind === "field") {
    return {
      ...expr,
      value: expandReplaceFieldsWithEnv(expr.value, env, types),
      key: expandReplaceFieldsWithEnv(expr.key, env, types),
    };
  }
  if (expr.kind === "range") {
    return {
      ...expr,
      start: expandReplaceFieldsWithEnv(expr.start, env, types),
      end: expandReplaceFieldsWithEnv(expr.end, env, types),
    };
  }
  if (expr.kind === "static_for_slots") {
    return {
      ...expr,
      source: expr.source.kind === "range"
        ? {
          kind: "range",
          start: expandReplaceFieldsWithEnv(expr.source.start, env, types),
          end: expandReplaceFieldsWithEnv(expr.source.end, env, types),
        }
        : {
          kind: "shape",
          shape: expandReplaceFieldsWithEnv(expr.source.shape, env, types),
        },
      value: expandReplaceFieldsWithEnv(expr.value, env, types),
    };
  }
  return expr;
}

function expandReplaceFieldWithEnv(
  args: Expr[],
  env: Map<string, string>,
  types: TypeDecl[],
): Expr | undefined {
  if (args.length !== 3) return undefined;
  const [source, key, value] = args;
  const label = exprLiteralLabel(key);
  if (!label || source.kind !== "var") return undefined;
  const sourceType = inferVarType(source.name, env, types);
  const slots = structuralProductSlotsForType(sourceType, types);
  if (!slots) return undefined;
  if (!slots.some((slot) => slot.label === label)) return undefined;
  return {
    kind: "shape",
    syntax: "record",
    inferredType: sourceType,
    slots: slots.flatMap((slot) => {
      if (!slot.label) return [];
      return [{
        label: slot.label,
        value: slot.label === label ? value : { kind: "var", name: `${source.name}.${slot.label}` },
      }];
    }),
  };
}

function exprLiteralLabel(expr: Expr | undefined): string | undefined {
  if (!expr) return undefined;
  if (
    expr.kind === "call" &&
    expr.callee.kind === "var" &&
    expr.callee.name === "@shape_first_key" &&
    expr.args[0]?.kind === "shape"
  ) {
    return expr.args[0].slots[0]?.label;
  }
  if (expr.kind !== "literal") return undefined;
  if (expr.literalKind === "literalType") return expr.value.replace(/^#/, "");
  if (expr.literalKind === "string") return expr.value;
  return undefined;
}

function staticConstExprValue(
  expr: Expr | undefined,
  staticValues: Map<string, ConstValue>,
  context?: {
    consts?: Map<string, ConstValue>;
    functions?: Map<string, FnDecl>;
    diagnostics?: Diagnostic[];
    diagnosticSpan?: Span;
    types?: TypeDecl[];
    memo?: CheckMemo;
  },
): ConstValue | undefined {
  if (!expr) return undefined;
  const key = context?.memo ? staticConstMemoKey(expr, staticValues) : undefined;
  if (key && context!.memo!.staticConstValue.has(key)) {
    return context!.memo!.staticConstValue.get(key);
  }
  const finish = (value: ConstValue | undefined) => {
    if (key) context!.memo!.staticConstValue.set(key, value);
    return value;
  };
  if (expr.kind === "literal") {
    return finish(constValueWithSpan(literalConstValue(expr), expr.span));
  }
  if (expr.kind === "var") {
    if (expr.name.startsWith("struct(")) {
      return finish(constValueWithSpan({ kind: "type", name: expr.name }, expr.span));
    }
    return finish(constValueWithSpan(
      staticValues.get(expr.name) ?? context?.consts?.get(expr.name) ??
        constValueFromKeyName(expr.name) ??
        resolveStaticTypeName(expr.name, context?.types) ??
        (context?.functions?.has(expr.name) ? { kind: "fn", name: expr.name } : undefined),
      expr.span,
    ));
  }
  if (expr.kind === "binary") {
    const left = staticConstExprValue(expr.left, staticValues, context);
    const right = staticConstExprValue(expr.right, staticValues, context);
    if (!left || !right) return finish(undefined);
    if (expr.op === "==" || expr.op === "!=") {
      const equal = constValueKey(left) === constValueKey(right);
      return finish(constValueWithSpan(
        { kind: "bool", value: expr.op === "==" ? equal : !equal },
        expr.span,
      ));
    }
    if (left.kind === "number" && right.kind === "number") {
      const l = staticIntegerNumberLiteral(left.value);
      const r = staticIntegerNumberLiteral(right.value);
      if (l === undefined || r === undefined) return finish(undefined);
      if (expr.op === "+") {
        return finish(constValueWithSpan({ kind: "number", value: String(l + r) }, expr.span));
      }
      if (expr.op === "-") {
        return finish(constValueWithSpan({ kind: "number", value: String(l - r) }, expr.span));
      }
    }
    return finish(undefined);
  }
  if (expr.kind === "operator_chain") {
    return finish(staticConstExprValue(
      buildOperatorTree(
        [expr.first, ...expr.rest.map((item) => item.value)],
        expr.rest.map((item) => item.op),
        EMPTY_OPERATOR_MAP,
        context?.diagnostics ?? [],
        expr,
      ),
      staticValues,
      context,
    ));
  }
  if (expr.kind === "shape") {
    return finish({
      kind: "shape",
      span: expr.span,
      slots: expr.slots.map((slot) => ({
        label: slot.label,
        value: constValueWithSpan(
          staticConstExprValue(slot.value, staticValues, context) ?? { kind: "never" },
          slot.value.span,
        ),
      })),
    });
  }
  if (expr.kind !== "call" || expr.callee.kind !== "var") return finish(undefined);
  const name = expr.callee.name.replace(/^@/, "");
  if (!isStaticBuiltinName(name)) {
    const proof = renderTypeProofArg(expr);
    if (proof && isKnownTypeProof(proof, context?.types ?? [])) {
      return finish(resolveStaticTypeName(proof, context?.types) ?? { kind: "type", name: proof });
    }
  }
  const args = expr.args.map((arg) =>
    constValueWithSpan(staticConstExprValue(arg, staticValues, context), arg.span)
  );
  const shape = args[0]?.kind === "shape" ? args[0] : undefined;
  if (name === "type_slots") {
    const rawType = resolveStaticConstType(args[0], context?.types);
    const rawInlineStructSlots = rawType?.kind === "type"
      ? inlineStructTypeSlots(rawType.name)
      : undefined;
    if (rawInlineStructSlots) return finish(rawInlineStructSlots);
    const type = resolveStaticTypeConst(rawType, context);
    const inlineStructSlots = type?.kind === "type" ? inlineStructTypeSlots(type.name) : undefined;
    if (inlineStructSlots) return finish(inlineStructSlots);
    return finish(
      type?.kind === "type" && type.normalized?.kind === "product"
        ? constTypeSlots(type)
        : undefined,
    );
  }
  if (name === "type_slot_count") {
    const type = resolveStaticConstType(args[0], context?.types);
    return finish({
      kind: "number",
      value: String(
        type?.kind === "type" && type.normalized?.kind === "product"
          ? type.normalized.shape.slots.length
          : 0,
      ),
    });
  }
  if (name === "type_slot_type") {
    const type = resolveStaticTypeConst(resolveStaticConstType(args[0], context?.types), context);
    const label = literalName(args[1]);
    const slot = type?.kind === "type" && type.normalized?.kind === "product"
      ? type.normalized.shape.slots.find((slot) => slot.label === label)
      : undefined;
    return finish(slot ? { kind: "type", name: slot.type } : undefined);
  }
  if (!shape) return finish(undefined);
  if (name === "shape_slot") {
    const label = literalName(args[1]);
    const slot = shape.slots.find((slot) => slot.label === label);
    if (!slot) {
      context?.diagnostics?.push({
        code: "type.unknown_shape_slot",
        message: `unknown shape slot ${label ?? "<unknown>"}`,
        span: args[1]?.span ?? args[0]?.span ?? context.diagnosticSpan,
      });
      return finish({ kind: "never" });
    }
    return finish(slot.value);
  }
  if (name === "shape_has_slot") {
    const label = literalName(args[1]);
    return finish({ kind: "bool", value: !!shape.slots.find((slot) => slot.label === label) });
  }
  if (name === "shape_count") {
    return finish({ kind: "number", value: String(shape.slots.length) });
  }
  if (name === "shape_first_key") {
    const first = shape.slots[0];
    if (!first?.label) {
      return finish(undefined);
    }
    return finish({ kind: "literal_type", value: first.label });
  }
  if (name === "shape_tail") {
    if (!shape.slots.length) {
      return finish(undefined);
    }
    return finish({ kind: "shape", slots: shape.slots.slice(1) });
  }
  return finish(undefined);
}

function staticConstMemoKey(
  expr: Expr,
  staticValues: Map<string, ConstValue>,
): string | undefined {
  const exprKey = structuralExprKey(expr);
  if (!exprKey) return undefined;
  return `${exprKey}\0${constEnvKey(staticValues)}`;
}

function inlineStructTypeSlots(type: string): ConstValue | undefined {
  const args = type.trim().startsWith("struct(") && type.trim().endsWith(")")
    ? type.trim().slice("struct(".length, -1)
    : undefined;
  if (!args) return undefined;
  const trimmed = args.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return { kind: "shape", slots: [] };
  return {
    kind: "shape",
    slots: splitTypeArgs(inner).map((part) => {
      const colon = topLevelTypeColon(part);
      if (colon < 0) return { value: { kind: "type", name: part.trim() } };
      return {
        label: part.slice(0, colon).trim(),
        value: { kind: "type", name: part.slice(colon + 1).trim() },
      };
    }),
  };
}

function topLevelTypeColon(source: string): number {
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const ch = source[index];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === ":" && depth === 0) return index;
  }
  return -1;
}

function resolveStaticConstType(
  value: ConstValue | undefined,
  types: TypeDecl[] | undefined,
): ConstValue | undefined {
  if (value?.kind !== "type") return undefined;
  if (value.normalized) return value;
  return resolveStaticTypeName(value.name, types) ?? value;
}

function resolveStaticTypeName(
  name: string,
  types: TypeDecl[] | undefined,
): ConstValue | undefined {
  const found = types?.find((type) => type.name === name || type.name === terminalName(name));
  return found ? { kind: "type", name, normalized: found.normalized } : undefined;
}

function resolveStaticTypeConst(
  value: ConstValue | undefined,
  context: Parameters<typeof staticConstExprValue>[2],
): ConstValue | undefined {
  if (value?.kind !== "type" || !context?.types) return value;
  const evaluator = new TypeEvaluator(
    new Map(context.types.map((decl) => [decl.name, decl])),
    context.functions ?? new Map(),
    new Map(),
    context.consts ?? new Map(),
    context.diagnostics ?? [],
    shaderManifestEntry,
    defaultCompilerPluginRegistry,
    context.diagnosticSpan,
  );
  const resolved = evaluator.resolve({
    kind: "type",
    name: value.name,
    normalized: value.normalized,
  });
  return resolved.kind === "type"
    ? { kind: "type", name: resolved.name, normalized: resolved.normalized }
    : value;
}

function evaluateTypeDecls(types: TypeDecl[], diagnostics: Diagnostic[]) {
  const byName = new Map(types.map((decl) => [decl.name, decl]));
  const state = new Map<string, "evaluating" | "done">();

  const evaluate = (decl: TypeDecl): TypeBody | undefined => {
    const current = state.get(decl.name);
    if (current === "evaluating") {
      diagnostics.push({
        code: "type.recursive_type_fn",
        message: `recursive type function ${decl.name}`,
      });
      return undefined;
    }
    if (current === "done") return decl.normalized;

    state.set(decl.name, "evaluating");
    const clauses = decl.clauses ?? [decl];
    for (const clause of clauses) {
      const kinds = new Map<string, TypeParamKind>(
        clause.params.map((param) => [param.name, param.kind]),
      );
      const locals = new Map(clause.body.statements.map((stmt) => [stmt.name, stmt.value]));
      for (const stmt of clause.body.statements) {
        validateTypeExprHoles(stmt.value, diagnostics);
        validateTypeExprScalarDomains(stmt.value, diagnostics);
        inferKinds(stmt.value, clause, kinds, locals, byName, diagnostics);
      }
      if (clause.body.expr) {
        validateTypeExprHoles(clause.body.expr, diagnostics);
        validateTypeExprScalarDomains(clause.body.expr, diagnostics);
        inferKinds(clause.body.expr, clause, kinds, locals, byName, diagnostics);
      }
      clause.paramKinds = Object.fromEntries(kinds);
    }
    decl.paramKinds = clauses[0].paramKinds;
    const locals = new Map(decl.body.statements.map((stmt) => [stmt.name, stmt.value]));
    decl.normalized = decl.body.expr
      ? normalizeTop(decl, decl.body.expr, locals, byName, diagnostics, evaluate)
      : {
        kind: "product",
        name: decl.name,
        constructor: pascalCase(decl.name),
        shape: { slots: [] },
      };
    checkTypeResultKind(decl, decl.normalized, diagnostics);
    state.set(decl.name, "done");
    return decl.normalized;
  };

  for (const decl of types) evaluate(decl);
}

function evaluateDeclarationTagExpressions(
  program: Program,
  types: TypeDecl[],
  functions: FnDecl[],
  hostIoImports: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  addShader: (source: string) => ShaderManifestEntry,
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
) {
  const typesByName = new Map(types.map((decl) => [decl.name, decl]));
  const functionsByName = new Map(functions.map((decl) => [decl.name, decl]));
  const constructorMap = typeDeclIndex(types).productByConstructor;
  const context = {
    functions: functionsByName,
    consts,
    typeConstructors: constructorMap,
    types,
  };
  for (const decl of [...program.declarations]) {
    const exprTags = (decl.tags ?? []).filter((tag) => tag.kind === "expr");
    if (!exprTags.length) continue;
    const self = declarationTagSelfValue(decl, context);
    const tagAllowed = declarationExpressionTagsAllowed(decl);
    for (const tag of exprTags) {
      if (!tagAllowed) {
        diagnostics.push(diagnosticAt(
          "tag.context",
          "declaration tag expressions are only valid on type, fn, const, and let declarations",
          tag,
        ));
        continue;
      }
      const locals = declarationTagLocals(decl, self);
      const evaluator = new TypeEvaluator(
        typesByName,
        functionsByName,
        hostIoImports,
        consts,
        diagnostics,
        addShader,
        pluginRegistry,
        tag.span,
        true,
      );
      const before = diagnostics.length;
      const value = tag.expr ? evaluator.eval(tag.expr, locals, tag.span) : undefined;
      if (diagnostics.length > before && value?.kind !== "members") continue;
      if (value?.kind === "members") {
        installGeneratedTagMembers(program, functionsByName, types, value, tag, diagnostics);
      }
    }
  }
}

function declarationExpressionTagsAllowed(decl: Declaration): boolean {
  return decl.kind === "type" || decl.kind === "fn" || decl.kind === "const" || decl.kind === "let";
}

function declarationTagLocals(
  decl: Declaration,
  self: TypeEvalValue | undefined,
): Map<string, TypeEvalValue> {
  const locals = new Map<string, TypeEvalValue>();
  if (self) locals.set("Self", self);
  if (decl.kind !== "type") return locals;
  for (const param of decl.params) {
    if (param.kind === "count") {
      locals.set(param.name, { kind: "number", value: param.name });
    } else if (param.kind === "bool") {
      locals.set(param.name, { kind: "bool", value: false });
    } else if (param.kind === "string" || param.kind === "char" || param.kind === "literal") {
      locals.set(param.name, { kind: "literal", value: param.name });
    } else {
      locals.set(param.name, { kind: "type", name: param.name });
    }
  }
  return locals;
}

function declarationTagSelfValue(
  decl: Declaration,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
  },
): TypeEvalValue | undefined {
  if (decl.kind === "type") {
    return {
      kind: "type",
      name: typeDeclSelfName(decl),
      normalized: decl.normalized,
    };
  }
  if (decl.kind === "fn") {
    return { kind: "type", name: renderFnType(decl) };
  }
  if (decl.kind === "const" || decl.kind === "let") {
    const inferred = decl.type ?? inferExprType(decl.value, context);
    return inferred ? { kind: "type", name: inferred } : undefined;
  }
  return undefined;
}

function typeDeclSelfName(decl: TypeDecl): string {
  if (!decl.params.length) return decl.name;
  return `${decl.name}(${decl.params.map((param) => param.name).join(", ")})`;
}

function installGeneratedTagMembers(
  program: Program,
  functionsByName: Map<string, FnDecl>,
  types: TypeDecl[],
  value: Extract<TypeEvalValue, { kind: "members" }>,
  tag: DeclarationTag,
  diagnostics: Diagnostic[],
) {
  for (const fn of value.functions) {
    const owner = fn.memberOf?.owner;
    const member = fn.memberOf?.member;
    if (!owner || !member) continue;
    const conflict = generatedMemberConflict(program, types, owner, member);
    if (conflict) {
      diagnostics.push(diagnosticAt(
        "type.duplicate_member",
        `type ${owner} has duplicate static member ${member}`,
        tag,
      ));
      continue;
    }
    program.declarations.push(fn);
    functionsByName.set(fn.name, fn);
  }
}

function generatedMemberConflict(
  program: Program,
  types: TypeDecl[],
  owner: string,
  member: string,
): boolean {
  for (const decl of program.declarations) {
    if (decl.kind !== "fn" || !decl.memberOf) continue;
    if (decl.memberOf.owner === owner && decl.memberOf.member === member) return true;
  }
  const ownerDecl = types.find((decl) => decl.name === owner);
  return !!ownerDecl && typeFragmentMembers(ownerDecl).some((item) => item.name === member);
}

function visitTypeExpr(expr: TypeExpr, visit: (expr: TypeExpr) => void) {
  visit(expr);
  switch (expr.kind) {
    case "type_call":
      visitTypeExpr(expr.callee, visit);
      for (const arg of expr.args) visitTypeExpr(arg, visit);
      return;
    case "type_shape":
      for (const slot of expr.shape.slots) visitTypeExpr(slot.type, visit);
      return;
    case "type_members":
      visitTypeExpr(expr.target, visit);
      return;
    case "type_match":
      visitTypeExpr(expr.value, visit);
      for (const arm of expr.arms) visitTypeExpr(arm.value, visit);
      return;
    case "type_scalar_domain":
      return;
    case "type_binary":
      visitTypeExpr(expr.left, visit);
      visitTypeExpr(expr.right, visit);
      return;
    case "type_ref":
    case "type_hole":
    case "type_static_ref":
    case "type_fn":
    case "type_bool":
    case "type_number":
    case "type_char":
    case "type_string":
    case "type_literal":
      return;
  }
}

function validateTypeExprScalarDomains(expr: TypeExpr, diagnostics: Diagnostic[]) {
  if (expr.kind === "type_call") diagnoseScalarDomainTypeExpr(expr, diagnostics);
  if (expr.kind === "type_call") {
    validateTypeExprScalarDomains(expr.callee, diagnostics);
    for (const arg of expr.args) validateTypeExprScalarDomains(arg, diagnostics);
  } else if (expr.kind === "type_shape") {
    for (const slot of expr.shape.slots) validateTypeExprScalarDomains(slot.type, diagnostics);
  } else if (expr.kind === "type_members") {
    validateTypeExprScalarDomains(expr.target, diagnostics);
  } else if (expr.kind === "type_match") {
    validateTypeExprScalarDomains(expr.value, diagnostics);
    for (const arm of expr.arms) validateTypeExprScalarDomains(arm.value, diagnostics);
  } else if (expr.kind === "type_scalar_domain") {
    diagnoseScalarDomainTypeExpr(expr, diagnostics);
  } else if (expr.kind === "type_binary") {
    validateTypeExprScalarDomains(expr.left, diagnostics);
    validateTypeExprScalarDomains(expr.right, diagnostics);
  }
}

function validateTypeExprHoles(expr: TypeExpr, diagnostics: Diagnostic[]) {
  const visit = (node: TypeExpr) => {
    if (node.kind === "type_hole") {
      diagnostics.push({
        code: "type.hole_context",
        message: "type holes are only allowed in do-strategy type arguments",
        span: node.span,
      });
      return;
    }
    if (node.kind === "type_call") {
      visit(node.callee);
      for (const arg of node.args) visit(arg);
    } else if (node.kind === "type_shape") {
      for (const slot of node.shape.slots) visit(slot.type);
    } else if (node.kind === "type_members") {
      visit(node.target);
    } else if (node.kind === "type_match") {
      visit(node.value);
      for (const arm of node.arms) visit(arm.value);
    } else if (node.kind === "type_scalar_domain") {
      return;
    } else if (node.kind === "type_binary") {
      visit(node.left);
      visit(node.right);
    }
  };
  visit(expr);
}

function checkTypeFunctionCasing(
  types: TypeDecl[],
  program: Program,
  diagnostics: Diagnostic[],
) {
  const typeNames = new Set(types.map((decl) => decl.name));
  const valueNames = new Set(
    program.declarations.flatMap((decl) =>
      decl.kind === "fn" || decl.kind === "let" || decl.kind === "const" ? [decl.name] : []
    ),
  );
  for (const decl of types) {
    if (!startsUppercase(terminalName(decl.name))) {
      diagnostics.push(diagnosticAt(
        "type.type_fn_casing",
        `type function ${decl.name} must start uppercase; use ${upperFirst(pascalCase(decl.name))}`,
        decl,
      ));
    }
    for (const param of decl.params) {
      if (param.name.startsWith("__type_pattern_")) continue;
      if (!startsLowercase(param.name)) {
        diagnostics.push(diagnosticAt(
          "type.type_param_casing",
          `type parameter ${param.name} must start lowercase; use ${lowerFirst(param.name)}`,
          param,
        ));
      }
    }
  }
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      for (const param of decl.params) {
        checkTypeAnnotationCasing(param.type, typeNames, valueNames, diagnostics, param.span);
      }
      if (decl.returnType) {
        checkTypeAnnotationCasing(decl.returnType, typeNames, valueNames, diagnostics, decl.span);
      }
      checkBlockTypeAnnotationCasing(decl.body, typeNames, valueNames, diagnostics);
    } else if (decl.kind === "let" || decl.kind === "const") {
      const explicit = explicitTypeAnnotation(decl.type);
      if (explicit) {
        checkTypeAnnotationCasing(explicit, typeNames, valueNames, diagnostics, decl.span);
      }
    }
  }
}

function checkBlockTypeAnnotationCasing(
  block: Extract<Expr, { kind: "block" }>,
  typeNames: Set<string>,
  valueNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  for (const stmt of block.statements) {
    const explicit = stmt.kind === "let" ? explicitTypeAnnotation(stmt.type) : undefined;
    if (stmt.kind === "let" && explicit) {
      checkTypeAnnotationCasing(explicit, typeNames, valueNames, diagnostics, stmt.span);
    }
    if (stmt.kind === "let") {
      checkExprTypeAnnotationCasing(stmt.value, typeNames, valueNames, diagnostics);
    }
  }
  if (block.expr) checkExprTypeAnnotationCasing(block.expr, typeNames, valueNames, diagnostics);
}

function explicitTypeAnnotation(type: string | undefined): string | undefined {
  return type?.trim() === "_" ? undefined : type;
}

function programHasInferredTypeAnnotationWork(
  program: Program,
  cache?: WeakMap<object, boolean>,
): boolean {
  for (const item of program.imports) {
    if (annotationTextContainsHole(item.type)) return true;
  }
  for (const decl of program.declarations) {
    if (declHasInferredTypeAnnotationWork(decl, cache)) return true;
  }
  return false;
}

function declHasInferredTypeAnnotationWork(
  decl: Declaration,
  cache?: WeakMap<object, boolean>,
): boolean {
  const cached = cache?.get(decl);
  if (cached !== undefined) return cached;
  let result = false;
  if (decl.kind === "fn") {
    for (const param of decl.params) {
      if (param.typeHoles?.length) {
        result = true;
        break;
      }
    }
    if (!result && decl.kind === "fn" && decl.returnTypeHoles?.length) result = true;
    if (!result) result = blockHasInferredTypeAnnotationWork(decl.body, cache);
    cache?.set(decl, result);
    return result;
  }
  if (decl.kind === "let" || decl.kind === "const") {
    result = decl.typeHoles?.length ? true : exprHasInferredTypeAnnotationWork(decl.value, cache);
    cache?.set(decl, result);
    return result;
  }
  if (decl.kind === "type") {
    for (const clause of decl.clauses ?? []) {
      if (declHasInferredTypeAnnotationWork(clause, cache)) {
        result = true;
        break;
      }
    }
  }
  cache?.set(decl, result);
  return result;
}

function blockHasInferredTypeAnnotationWork(
  block: BlockExpr,
  cache?: WeakMap<object, boolean>,
): boolean {
  for (const stmt of block.statements) {
    if (stmt.kind === "let") {
      if (stmt.typeHoles?.length) return true;
      if (exprHasInferredTypeAnnotationWork(stmt.value, cache)) return true;
    } else if (stmt.kind === "destructure_let") {
      if (exprHasInferredTypeAnnotationWork(stmt.value, cache)) return true;
    }
  }
  return block.expr ? exprHasInferredTypeAnnotationWork(block.expr, cache) : false;
}

function exprHasInferredTypeAnnotationWork(expr: Expr, cache?: WeakMap<object, boolean>): boolean {
  const cached = cache?.get(expr);
  if (cached !== undefined) return cached;
  let result = false;
  switch (expr.kind) {
    case "block":
      result = blockHasInferredTypeAnnotationWork(expr, cache);
      break;
    case "do":
      for (const stmt of expr.statements) {
        if (
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
          stmt.kind === "destructure_let"
        ) {
          if (stmt.kind === "let" && stmt.typeHoles?.length) {
            result = true;
            break;
          }
          if (exprHasInferredTypeAnnotationWork(stmt.value, cache)) {
            result = true;
            break;
          }
        }
      }
      if (!result && expr.expr) result = exprHasInferredTypeAnnotationWork(expr.expr, cache);
      break;
    case "const_fn":
      result = exprHasInferredTypeAnnotationWork(expr.body, cache);
      break;
    case "call":
      if (exprHasInferredTypeAnnotationWork(expr.callee, cache)) {
        result = true;
        break;
      }
      for (const arg of expr.args) {
        if (exprHasInferredTypeAnnotationWork(arg, cache)) {
          result = true;
          break;
        }
      }
      break;
    case "index":
      result = exprHasInferredTypeAnnotationWork(expr.target, cache) ||
        exprHasInferredTypeAnnotationWork(expr.index, cache);
      break;
    case "binary":
      result = exprHasInferredTypeAnnotationWork(expr.left, cache) ||
        exprHasInferredTypeAnnotationWork(expr.right, cache);
      break;
    case "operator_chain":
      if (exprHasInferredTypeAnnotationWork(expr.first, cache)) {
        result = true;
        break;
      }
      for (const item of expr.rest) {
        if (exprHasInferredTypeAnnotationWork(item.value, cache)) {
          result = true;
          break;
        }
      }
      break;
    case "pipe_bind":
      result = exprHasInferredTypeAnnotationWork(expr.value, cache) ||
        exprHasInferredTypeAnnotationWork(expr.body, cache);
      break;
    case "profile":
      for (const arg of expr.args) {
        if (exprHasInferredTypeAnnotationWork(arg, cache)) {
          result = true;
          break;
        }
      }
      if (!result) result = exprHasInferredTypeAnnotationWork(expr.body, cache);
      break;
    case "match":
      if (exprHasInferredTypeAnnotationWork(expr.value, cache)) {
        result = true;
        break;
      }
      for (const arm of expr.arms) {
        if (exprHasInferredTypeAnnotationWork(arm.value, cache)) {
          result = true;
          break;
        }
      }
      break;
    case "shape":
    case "product_constructor":
      for (const slot of expr.slots) {
        if (exprHasInferredTypeAnnotationWork(slot.value, cache)) {
          result = true;
          break;
        }
      }
      break;
    case "static_for_slots":
      if (expr.source.kind === "range") {
        if (exprHasInferredTypeAnnotationWork(expr.source.start, cache)) result = true;
        if (!result && exprHasInferredTypeAnnotationWork(expr.source.end, cache)) result = true;
      } else if (exprHasInferredTypeAnnotationWork(expr.source.shape, cache)) result = true;
      if (!result) result = exprHasInferredTypeAnnotationWork(expr.value, cache);
      break;
    case "field":
      result = exprHasInferredTypeAnnotationWork(expr.value, cache) ||
        exprHasInferredTypeAnnotationWork(expr.key, cache);
      break;
    case "range":
      result = exprHasInferredTypeAnnotationWork(expr.start, cache) ||
        exprHasInferredTypeAnnotationWork(expr.end, cache);
      break;
    case "literal":
    case "var":
      result = false;
      break;
  }
  cache?.set(expr, result);
  return result;
}

function prepareInferredTypeAnnotations(program: Program, diagnostics: Diagnostic[]) {
  const prepare = (
    type: string | undefined,
    typeSpan: Span | undefined,
    holes:
      | TypeAnnotationHole[]
      | undefined,
  ): string | undefined => {
    if (!type || !holes?.length || !typeSpan) return type;
    const sorted = holes
      .filter((hole) => hole.span)
      .toSorted((left, right) => (right.span?.start ?? 0) - (left.span?.start ?? 0));
    let current = type;
    for (const hole of sorted) {
      const span = hole.span!;
      const start = span.start - typeSpan.start;
      const end = span.end - typeSpan.start;
      if (start < 0 || end < start || end > current.length) continue;
      const variable = `inferred_type_hole_${span.start}_${span.end}`;
      hole.variable = variable;
      current = `${current.slice(0, start)}${variable}${current.slice(end)}`;
    }
    return current;
  };
  const diagnoseUnsupported = (holes: TypeAnnotationHole[] | undefined, message: string) => {
    for (const hole of holes ?? []) {
      diagnostics.push({
        code: "type.hole_context",
        message,
        span: hole.span,
      });
    }
  };
  const visitBlock = (block: BlockExpr) => {
    for (const stmt of block.statements) {
      if (stmt.kind === "let") {
        stmt.type = prepare(stmt.type, stmt.typeSpan, stmt.typeHoles);
        visitExpr(stmt.value);
      } else if (stmt.kind === "destructure_let") {
        visitExpr(stmt.value);
      } else if (stmt.kind === "type_assert") {
        // Proof/type expressions keep the stricter type-expression validation path.
      }
    }
    if (block.expr) visitExpr(block.expr);
  };
  const visitExpr = (expr: Expr) => {
    if (expr.kind === "block") {
      visitBlock(expr);
      return;
    }
    for (const child of exprChildren(expr)) visitExpr(child);
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      for (const param of decl.params) {
        diagnoseUnsupported(
          param.typeHoles,
          "type holes are only allowed in expression-backed type annotations and do-strategy type arguments",
        );
      }
      decl.returnType = prepare(decl.returnType, decl.returnTypeSpan, decl.returnTypeHoles);
      visitBlock(decl.body);
    } else if (decl.kind === "let" || decl.kind === "const") {
      decl.type = prepare(decl.type, decl.typeSpan, decl.typeHoles);
      visitExpr(decl.value);
    }
  }
  for (const item of program.imports) {
    if (annotationTextContainsHole(item.type)) {
      diagnostics.push({
        code: "type.hole_context",
        message: "type holes are not allowed in external import signatures",
        span: item.span,
      });
    }
  }
}

function annotationTextContainsHole(type: string | undefined): boolean {
  return /(^|[^A-Za-z0-9_])_([^A-Za-z0-9_]|$)/.test(type ?? "");
}

function resolveInferredTypeAnnotations(
  program: Program,
  types: TypeDecl[],
  functions: FnDecl[],
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  memo: CheckMemo,
) {
  const resolved = program.resolvedTypeHoles ?? [];
  const context = {
    functions: new Map(functions.map((fn) => [fn.name, fn])),
    consts,
    typeConstructors: productConstructorMap(types),
    types,
  };
  const resolveAnnotation = (
    current: string | undefined,
    holes: TypeAnnotationHole[] | undefined,
    actual: string | undefined,
    spanLike?: { span?: Span; nameSpan?: Span },
  ): string | undefined => {
    if (!current || !holes?.length) return current;
    if (!actual || typeHasFreeInferredVars(actual, consts) || annotationTextContainsHole(actual)) {
      diagnostics.push({
        code: "type.inferred_type_ambiguous",
        message: "cannot resolve inferred type hole without a concrete expression type",
        span: holes.find((hole) => hole.span)?.span ?? spanLike?.span,
      });
      return current;
    }
    if (!inferredAnnotationPatternMatches(current, actual, memo)) {
      diagnostics.push(diagnosticAt(
        "type.literal_mismatch",
        `expected ${renderTypeHolesAsUnderscores(current, holes)} but got ${actual}`,
        spanLike,
      ));
      return current;
    }
    const bindings = new Map<string, string>();
    bindTypePattern(current, actual, bindings, types, consts);
    let next = current;
    for (const hole of holes) {
      if (!hole.variable) continue;
      const replacement = bindings.get(hole.variable) ??
        (current.trim() === hole.variable ? actual : undefined);
      if (!replacement || typeHasFreeInferredVars(replacement, consts)) {
        diagnostics.push({
          code: "type.inferred_type_ambiguous",
          message: "cannot resolve inferred type hole without a concrete expression type",
          span: hole.span ?? spanLike?.span,
        });
        continue;
      }
      hole.replacement = replacement;
      next = next.replace(new RegExp(`\\b${escapeRegExp(hole.variable)}\\b`, "g"), replacement);
      if (hole.span) resolved.push({ span: hole.span, replacement });
    }
    return next;
  };
  const resolveExpr = (expr: Expr, env: Map<string, string>) => {
    if (expr.kind === "block") {
      inferAndResolveBlockType(expr, env, context, resolveAnnotation);
      return;
    }
    for (const child of exprChildren(expr)) resolveExpr(child, env);
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      const env = new Map(
        decl.params.filter((param) => !param.const).map((param) => [param.name, param.type]),
      );
      const actual = inferAndResolveBlockType(
        decl.body,
        env,
        context,
        resolveAnnotation,
        decl.returnType,
      );
      decl.returnType = resolveAnnotation(decl.returnType, decl.returnTypeHoles, actual, decl);
    } else if (decl.kind === "let" || decl.kind === "const") {
      resolveExpr(decl.value, new Map());
      const actual = inferExprTypeForAnnotation(decl.value, decl.type, context, new Map()) ??
        inferExprType(decl.value, context);
      decl.type = resolveAnnotation(decl.type, decl.typeHoles, actual, decl);
    }
  }
  program.resolvedTypeHoles = dedupeResolvedTypeHoles(resolved);
}

function inferAndResolveBlockType(
  block: BlockExpr,
  env: Map<string, string>,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
  },
  resolveAnnotation: (
    current: string | undefined,
    holes: TypeAnnotationHole[] | undefined,
    actual: string | undefined,
    spanLike?: { span?: Span; nameSpan?: Span },
  ) => string | undefined,
  expectedFinalType?: string,
): string | undefined {
  const scoped = new Map(env);
  for (const stmt of block.statements) {
    if (stmt.kind === "let") {
      inferAndResolveNestedExpr(stmt.value, scoped, context, resolveAnnotation);
      const actual = inferExprTypeForAnnotation(stmt.value, stmt.type, context, scoped) ??
        inferExprType(stmt.value, context, scoped);
      stmt.type = resolveAnnotation(stmt.type, stmt.typeHoles, actual, stmt);
      const binding = stmt.type && !typeHasFreeInferredVars(stmt.type, context.consts)
        ? stmt.type
        : actual;
      if (binding) scoped.set(stmt.name, binding);
    } else if (stmt.kind === "destructure_let") {
      inferAndResolveNestedExpr(stmt.value, scoped, context, resolveAnnotation);
    }
  }
  if (block.expr) {
    inferAndResolveNestedExpr(block.expr, scoped, context, resolveAnnotation);
    return inferExprTypeForAnnotation(block.expr, expectedFinalType, context, scoped) ??
      inferExprType(block.expr, context, scoped);
  }
  return undefined;
}

function inferExprTypeForAnnotation(
  expr: Expr,
  annotation: string | undefined,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
  },
  env: Map<string, string>,
): string | undefined {
  if (!annotation) return undefined;
  if (!annotation.includes("inferred_type_hole_")) return undefined;
  const call = annotation.match(/^([A-Za-z_][A-Za-z0-9_.]*)\(([\s\S]*)\)$/);
  if (!call) return undefined;
  const decl = (context.types ?? []).find((item) =>
    item.name === call[1] || terminalName(item.name) === terminalName(call[1])
  );
  if (decl?.normalized?.kind !== "product") return undefined;
  if (expr.kind !== "shape" && expr.kind !== "product_constructor") return undefined;
  const exprTypeName = expr.kind === "product_constructor" ? expr.constructor : expr.inferredType;
  if (exprTypeName && terminalName(typeNameOf(exprTypeName)) !== terminalName(decl.name)) {
    return undefined;
  }
  const slots = expr.slots.filter((slot) => slot.label);
  if (!slots.length) return undefined;
  const bindings = new Map<string, string>();
  const args = splitTypeArgs(call[2]);
  decl.params.forEach((param, index) => {
    const arg = args[index];
    if (arg) bindTypePattern(param.name, arg, bindings, context.types ?? [], context.consts);
  });
  for (const slot of slots) {
    const expected = decl.normalized.shape.slots.find((item) => item.label === slot.label)?.type;
    const actual = inferExprType(slot.value, context, env);
    bindTypePattern(expected, actual, bindings, context.types ?? [], context.consts);
  }
  const renderedArgs = decl.params.map((param) => {
    const arg = bindings.get(param.name);
    return arg ? substituteTypeVars(arg, bindings) : undefined;
  });
  if (renderedArgs.some((arg) => !arg || typeHasFreeInferredVars(arg, context.consts))) {
    return undefined;
  }
  return `${decl.name}(${renderedArgs.join(", ")})`;
}

function inferAndResolveNestedExpr(
  expr: Expr,
  env: Map<string, string>,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
  },
  resolveAnnotation: (
    current: string | undefined,
    holes: TypeAnnotationHole[] | undefined,
    actual: string | undefined,
    spanLike?: { span?: Span; nameSpan?: Span },
  ) => string | undefined,
) {
  if (expr.kind === "block") {
    inferAndResolveBlockType(expr, new Map(env), context, resolveAnnotation);
    return;
  }
  for (const child of exprChildren(expr)) {
    inferAndResolveNestedExpr(child, env, context, resolveAnnotation);
  }
}

function productConstructorMap(types: TypeDecl[]): Map<string, TypeDecl> {
  const constructors = new Map(
    types.flatMap((decl) =>
      decl.normalized?.kind === "product" ? [[decl.normalized.constructor, decl] as const] : []
    ),
  );
  for (const decl of types) {
    if (decl.normalized?.kind !== "product") continue;
    const terminal = terminalName(decl.normalized.constructor);
    if (!constructors.has(terminal)) constructors.set(terminal, decl);
  }
  return constructors;
}

function inferredAnnotationPatternMatches(
  expected: string,
  actual: string,
  memo: CheckMemo,
): boolean {
  if (typeMatches(expected, actual, memo)) return true;
  if (isInferredTypeVarName(expected.trim())) return true;
  const expectedCall = expected.match(/^([A-Za-z_][A-Za-z0-9_.]*)\(([\s\S]*)\)$/);
  const actualCall = actual.match(/^([A-Za-z_][A-Za-z0-9_.]*)\(([\s\S]*)\)$/);
  if (!expectedCall || !actualCall) return false;
  if (terminalName(expectedCall[1]) !== terminalName(actualCall[1])) return false;
  const expectedArgs = splitTypeArgs(expectedCall[2]);
  const actualArgs = splitTypeArgs(actualCall[2]);
  return expectedArgs.length === actualArgs.length &&
    expectedArgs.every((arg, index) =>
      inferredAnnotationPatternMatches(arg, actualArgs[index] ?? "", memo)
    );
}

function renderTypeHolesAsUnderscores(type: string, holes: TypeAnnotationHole[]): string {
  let rendered = type;
  for (const hole of holes) {
    if (!hole.variable) continue;
    rendered = rendered.replace(new RegExp(`\\b${escapeRegExp(hole.variable)}\\b`, "g"), "_");
  }
  return rendered;
}

function dedupeResolvedTypeHoles(holes: ResolvedTypeHole[]): ResolvedTypeHole[] {
  const seen = new Set<string>();
  return holes.filter((hole) => {
    const key = `${
      hole.span.sourceId ?? ""
    }:${hole.span.start}:${hole.span.end}:${hole.replacement}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function checkExprTypeAnnotationCasing(
  expr: Expr,
  typeNames: Set<string>,
  valueNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  if (expr.kind === "block") {
    checkBlockTypeAnnotationCasing(expr, typeNames, valueNames, diagnostics);
  } else if (expr.kind === "match") {
    checkExprTypeAnnotationCasing(expr.value, typeNames, valueNames, diagnostics);
    for (const arm of expr.arms) {
      checkExprTypeAnnotationCasing(arm.value, typeNames, valueNames, diagnostics);
    }
  }
}

function checkTypeExprCasing(
  expr: TypeExpr | undefined,
  typeNames: Set<string>,
  valueNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  if (!expr) return;
  if (expr.kind === "type_ref") {
    diagnoseTypeRefCasing(expr.name, false, typeNames, valueNames, diagnostics, expr.span);
  } else if (expr.kind === "type_hole") {
    diagnostics.push({
      code: "type.hole_context",
      message: "type holes are only allowed in do-strategy type arguments",
      span: expr.span,
    });
  } else if (expr.kind === "type_call") {
    diagnoseScalarDomainTypeExpr(expr, diagnostics);
    if (expr.callee.kind === "type_ref") {
      if (expr.callee.name !== "struct" && expr.callee.name !== "union") {
        diagnoseTypeRefCasing(
          expr.callee.name,
          true,
          typeNames,
          valueNames,
          diagnostics,
          expr.callee.span,
        );
      }
    } else {
      checkTypeExprCasing(expr.callee, typeNames, valueNames, diagnostics);
    }
    for (const arg of expr.args) checkTypeExprCasing(arg, typeNames, valueNames, diagnostics);
  } else if (expr.kind === "type_shape") {
    for (const slot of expr.shape.slots) {
      checkTypeExprCasing(slot.type, typeNames, valueNames, diagnostics);
    }
  } else if (expr.kind === "type_members") {
    checkTypeExprCasing(expr.target, typeNames, valueNames, diagnostics);
  } else if (expr.kind === "type_match") {
    checkTypeExprCasing(expr.value, typeNames, valueNames, diagnostics);
    for (const arm of expr.arms) {
      checkTypeExprCasing(arm.value, typeNames, valueNames, diagnostics);
    }
  } else if (expr.kind === "type_scalar_domain") {
    diagnoseScalarDomainTypeExpr(expr, diagnostics);
  } else if (expr.kind === "type_binary") {
    checkTypeExprCasing(expr.left, typeNames, valueNames, diagnostics);
    checkTypeExprCasing(expr.right, typeNames, valueNames, diagnostics);
  }
}

function checkTypeAnnotationCasing(
  annotation: string,
  typeNames: Set<string>,
  valueNames: Set<string>,
  diagnostics: Diagnostic[],
  span?: Span,
) {
  for (const name of annotation.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (/^u[0-9]+$/.test(name) && !isUnsignedIntegerType(name)) {
      diagnostics.push({
        code: "type.unknown_type",
        message: `unknown unsigned integer type ${name}; use u1 through u64`,
        span,
      });
    }
  }
  const parsed = parseAnnotationType(annotation);
  checkTypeExprCasing(parsed, typeNames, valueNames, diagnostics);
}

function diagnoseScalarDomainTypeExpr(
  expr: Extract<TypeExpr, { kind: "type_call" | "type_scalar_domain" }>,
  diagnostics: Diagnostic[],
) {
  const diagnostic = validateScalarDomainType(renderTypeExpr(expr));
  if (!diagnostic) return;
  diagnostics.push({
    code: diagnostic.code,
    message: diagnostic.message,
    span: expr.span,
  });
}

function diagnoseTypeRefCasing(
  name: string,
  callee: boolean,
  typeNames: Set<string>,
  valueNames: Set<string>,
  diagnostics: Diagnostic[],
  span?: Span,
) {
  if (name === "String") {
    diagnostics.push({
      code: "type.builtin_type_casing",
      message: "builtin type String is lowercase; use string",
      span,
    });
    return;
  }
  if (name === "memory") {
    diagnostics.push({
      code: "type.unknown_type",
      message: "unknown type memory",
      span,
    });
    return;
  }
  if (typeNames.has(name) || isBuiltinTypeName(name)) return;
  if (isQualifiedTypeName(name) && !valueNames.has(name)) {
    diagnostics.push({
      code: "type.unknown_type",
      message: `unknown type ${name}`,
      span,
    });
    return;
  }
  if (callee && isInferredTypeVarName(name) && name.length > 1) {
    diagnostics.push({
      code: "type.lowercase_type_constructor",
      message: `lowercase type variable ${name} cannot be called as a type constructor`,
      span,
    });
  }
}

function inferKinds(
  expr: TypeExpr,
  decl: TypeDecl,
  kinds: Map<string, TypeParamKind>,
  locals: Map<string, TypeExpr>,
  byName: Map<string, TypeDecl>,
  diagnostics: Diagnostic[],
  expected: TypeParamKind = "type",
) {
  if (expr.kind === "type_ref") {
    if (decl.params.some((param) => param.name === expr.name)) {
      markKind(decl, kinds, expr.name, expected, diagnostics);
    }
    const local = locals.get(expr.name);
    if (local) inferKinds(local, decl, kinds, locals, byName, diagnostics, expected);
    return;
  }
  if (expr.kind === "type_call") {
    inferKinds(expr.callee, decl, kinds, locals, byName, diagnostics, "type");
    const calleeName = expr.callee.kind === "type_ref" ? expr.callee.name : undefined;
    const staticBuiltinName = expr.callee.kind === "type_static_ref" ? expr.callee.name : undefined;
    const calleeDecl = calleeName ? lookupTypeDecl(byName, calleeName) : undefined;
    if (calleeName && decl.params.some((param) => param.name === calleeName)) {
      const constructorKind = `type fn(${
        expr.args.map((_arg, index) => `_${index}: type`).join(", ")
      }) -> type`;
      markKind(decl, kinds, calleeName, constructorKind, diagnostics);
    }
    expr.args.forEach((arg, index) => {
      const calleeKind = calleeName === "i32" && index === 0
        ? "count"
        : staticBuiltinParamKind(staticBuiltinName, index) ??
          calleeDecl?.paramKinds?.[calleeDecl.params[index]?.name] ??
          calleeDecl?.params[index]?.kind ??
          "type";
      inferKinds(arg, decl, kinds, locals, byName, diagnostics, calleeKind);
    });
    return;
  }
  if (expr.kind === "type_shape") {
    inferShapeKinds(expr.shape, decl, kinds, locals, byName, diagnostics);
    return;
  }
  if (expr.kind === "type_members") {
    inferKinds(expr.target, decl, kinds, locals, byName, diagnostics, "type");
    return;
  }
  if (expr.kind === "type_match") {
    inferKinds(expr.value, decl, kinds, locals, byName, diagnostics, "type");
    for (const arm of expr.arms) {
      inferKinds(arm.value, decl, kinds, locals, byName, diagnostics, expected);
    }
    return;
  }
  if (expr.kind === "type_scalar_domain") {
    for (const member of expr.members) {
      for (const endpoint of [member.start, member.end]) {
        if (
          endpoint?.kind === "symbol" &&
          decl.params.some((param) => param.name === endpoint.source)
        ) {
          markKind(decl, kinds, endpoint.source, "count", diagnostics);
        }
      }
    }
    return;
  }
  if (expr.kind === "type_binary") {
    inferKinds(expr.left, decl, kinds, locals, byName, diagnostics, expected);
    inferKinds(expr.right, decl, kinds, locals, byName, diagnostics, expected);
  }
}

function lookupTypeDecl(byName: Map<string, TypeDecl>, name: string): TypeDecl | undefined {
  return byName.get(name) ?? byName.get(terminalName(name)) ??
    Array.from(byName.values()).find((decl) => terminalName(decl.name) === terminalName(name));
}

function inferShapeKinds(
  shape: TypeShape,
  decl: TypeDecl,
  kinds: Map<string, TypeParamKind>,
  locals: Map<string, TypeExpr>,
  byName: Map<string, TypeDecl>,
  diagnostics: Diagnostic[],
) {
  for (const slot of shape.slots) {
    if (slot.repeat) inferCountKinds(slot.repeat, decl, kinds, diagnostics);
    inferKinds(slot.type, decl, kinds, locals, byName, diagnostics, "type");
  }
}

function inferCountKinds(
  expr: TypeCountExpr,
  decl: TypeDecl,
  kinds: Map<string, TypeParamKind>,
  diagnostics: Diagnostic[],
) {
  if (expr.kind === "count_ref" && decl.params.some((param) => param.name === expr.name)) {
    markKind(decl, kinds, expr.name, "count", diagnostics);
  } else if (expr.kind === "count_mul") {
    inferCountKinds(expr.left, decl, kinds, diagnostics);
    inferCountKinds(expr.right, decl, kinds, diagnostics);
  }
}

function markKind(
  decl: TypeDecl,
  kinds: Map<string, TypeParamKind>,
  name: string,
  kind: TypeParamKind,
  diagnostics: Diagnostic[],
) {
  const existing = kinds.get(name);
  if (existing && !typeParamKindsCompatible(existing, kind)) {
    diagnostics.push({
      code: "type.param_kind_conflict",
      message:
        `type function ${decl.name} parameter ${name} is used as both ${existing} and ${kind}`,
    });
    return;
  }
  kinds.set(name, moreSpecificTypeParamKind(existing, kind));
}

function typeParamKindsCompatible(left: TypeParamKind, right: TypeParamKind): boolean {
  if (left === right) return true;
  if (left === "const" || right === "const") return true;
  if (left === "type" && isTypeConstructorKind(right)) return true;
  if (right === "type" && isTypeConstructorKind(left)) return true;
  if (isTypeConstructorKind(left) && isTypeConstructorKind(right)) {
    return typeConstructorKindArity(left) === typeConstructorKindArity(right) &&
      typeConstructorResultKindsCompatible(
        typeConstructorResultKind(left),
        typeConstructorResultKind(right),
      );
  }
  return false;
}

function moreSpecificTypeParamKind(
  left: TypeParamKind | undefined,
  right: TypeParamKind,
): TypeParamKind {
  if (!left || left === right) return right;
  if (left === "const" || right === "const") return "const";
  if (left === "type" && isTypeConstructorKind(right)) return right;
  return left;
}

function isTypeConstructorKind(kind: TypeParamKind): boolean {
  return /^type\s+fn\s*\(/.test(kind);
}

function typeConstructorKindArity(kind: TypeParamKind): number | undefined {
  const match = kind.match(/^type\s+fn\s*\((.*)\)\s*->\s*(type|struct|union|members)$/);
  if (!match) return undefined;
  const params = match[1].trim();
  return params ? params.split(",").length : 0;
}

function typeConstructorResultKind(kind: TypeParamKind): TypeResultKind | undefined {
  const match = kind.match(/^type\s+fn\s*\(.*\)\s*->\s*(type|struct|union|members)$/);
  return match?.[1] as TypeResultKind | undefined;
}

function typeConstructorResultKindsCompatible(
  left: TypeResultKind | undefined,
  right: TypeResultKind | undefined,
): boolean {
  if (!left || !right) return false;
  return left === "type" || right === "type" || left === right;
}

function checkTypeResultKind(
  decl: TypeDecl,
  normalized: TypeBody | undefined,
  diagnostics: Diagnostic[],
) {
  if (!normalized || decl.resultKind === "type") return;
  if (decl.resultKind === "members") return;
  if (decl.resultKind === "struct" && normalized.kind === "product") return;
  if (decl.resultKind === "union" && normalized.kind === "sum") return;
  diagnostics.push({
    code: "type.result_kind",
    message:
      `type function ${decl.name} declares -> ${decl.resultKind} but normalizes to ${normalized.kind}`,
  });
}

function normalizeTop(
  decl: TypeDecl,
  expr: TypeExpr,
  locals: Map<string, TypeExpr>,
  byName: Map<string, TypeDecl>,
  diagnostics: Diagnostic[],
  evaluate: (decl: TypeDecl) => TypeBody | undefined,
): TypeBody {
  const resolved = resolveLocal(expr, locals);
  const typeLetDocs = new Map(decl.body.statements.map((stmt) => [stmt.name, stmt.doc]));
  const builder = typeBuilderCall(resolved);
  if (builder?.name === "struct") {
    const arg = builder.args[0];
    const shapeExpr = arg?.kind === "type_ref" ? locals.get(arg.name) : undefined;
    if (
      builder.args.length === 1 && arg?.kind === "type_ref" && shapeExpr &&
      shapeExpr.kind !== "type_shape"
    ) {
      return { kind: "alias", type: renderTypeExpr(resolved) };
    }
    if (builder.args.length !== 1 || arg?.kind !== "type_ref" || shapeExpr?.kind !== "type_shape") {
      diagnostics.push({
        code: "type.builder_arg",
        message: "struct(...) requires one type-block shape binding",
      });
      return { kind: "alias", type: renderTypeExpr(resolved) };
    }
    const members = normalizeMembers(shapeExpr.shape.members);
    return {
      kind: "product",
      name: decl.name,
      constructor: arg.name,
      shape: normalizeShape(shapeExpr.shape),
      ...(members ? { members } : {}),
    };
  }
  if (builder?.name === "union") {
    const variants = builder.args.map((arg) => {
      const shape = arg.kind === "type_ref" ? locals.get(arg.name) : undefined;
      return arg.kind === "type_ref" && shape?.kind === "type_shape"
        ? { name: arg.name, shape }
        : undefined;
    });
    if (!variants.length || variants.some((variant) => !variant)) {
      diagnostics.push({
        code: "type.builder_arg",
        message: "union(...) requires type-block shape bindings",
      });
      return { kind: "alias", type: renderTypeExpr(resolved) };
    }
    const resolvedVariants = variants as {
      name: string;
      shape: Extract<TypeExpr, { kind: "type_shape" }>;
    }[];
    const members = normalizeMembers(resolvedVariants[0].shape.shape.members);
    return {
      kind: "sum",
      variants: resolvedVariants.map((variant) => ({
        ...(typeLetDocs.get(variant.name) ? { doc: typeLetDocs.get(variant.name) } : {}),
        name: variant.name,
        shape: variant.shape.shape.slots.length ? normalizeShape(variant.shape.shape) : undefined,
      })),
      ...(members ? { members } : {}),
    };
  }
  if (resolved.kind === "type_ref") {
    const target = byName.get(resolved.name);
    if (target) evaluate(target);
  }
  if (resolved.kind === "type_call" && resolved.callee.kind === "type_ref") {
    const calleeName = resolved.callee.name;
    const target = byName.get(calleeName);
    const rendered = renderTypeExpr(resolved);
    const typeParamCall = decl.params.some((param) => param.name === calleeName);
    if (!target && !typeParamCall && !/^(?:i32|i64|u32|u64|f32|f64)\s*\(/.test(rendered)) {
      diagnostics.push({
        code: "type.unknown_type",
        message: `unknown type function ${calleeName}`,
      });
    } else if (target) {
      evaluate(target);
    }
  }
  const alias = evaluateAliasTypeExpr(resolved, decl.name, byName, diagnostics);
  if (!alias) {
    if (decl.params.length === 0) {
      diagnostics.push(diagnosticAt(
        "type.alias_not_type",
        `type alias ${decl.name} must resolve to a type`,
        resolved,
      ));
    }
    return { kind: "alias", type: renderTypeExpr(resolved) };
  }
  return { kind: "alias", type: alias };
}

function evaluateAliasTypeExpr(
  expr: TypeExpr,
  currentName: string,
  byName: Map<string, TypeDecl>,
  diagnostics: Diagnostic[],
): string | undefined {
  if (typeExprReferencesName(expr, currentName)) return renderTypeExpr(expr);
  const before = diagnostics.length;
  const evaluator = new TypeEvaluator(
    byName,
    new Map(),
    new Map(),
    new Map(),
    diagnostics,
    shaderManifestEntry,
    defaultCompilerPluginRegistry,
    expr.span,
  );
  const value = evaluator.eval(expr, new Map());
  diagnostics.splice(before);
  if (value?.kind === "type") return value.name;
  const literalMembers = value ? literalTypeMembersFromTypeResult(value) : undefined;
  if (literalMembers) return renderLiteralUnionType(literalMembers);
  if (value?.kind === "shape") return renderTypeExpr(expr);
  if (value?.kind === "never" || !value) return renderTypeExpr(expr);
  return undefined;
}

function typeExprReferencesName(expr: TypeExpr, name: string): boolean {
  if (expr.kind === "type_ref") return expr.name === name || terminalName(expr.name) === name;
  if (expr.kind === "type_call") {
    if (typeExprReferencesName(expr.callee, name)) return true;
    for (const arg of expr.args) {
      if (typeExprReferencesName(arg, name)) return true;
    }
  } else if (expr.kind === "type_shape") {
    for (const slot of expr.shape.slots) {
      if (typeExprReferencesName(slot.type, name)) return true;
    }
  } else if (expr.kind === "type_members") {
    return typeExprReferencesName(expr.target, name);
  } else if (expr.kind === "type_match") {
    if (typeExprReferencesName(expr.value, name)) return true;
    for (const arm of expr.arms) {
      if (typeExprReferencesName(arm.value, name)) return true;
    }
  } else if (expr.kind === "type_binary") {
    return typeExprReferencesName(expr.left, name) || typeExprReferencesName(expr.right, name);
  }
  return false;
}

function startsLowercase(name: string): boolean {
  return /^[a-z_]/.test(name);
}

function startsUppercase(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function isBuiltinTypeName(name: string): boolean {
  return [
    "bool",
    "char",
    "const",
    "count",
    "f32",
    "f64",
    "fn",
    "i32",
    "i64",
    "io",
    "literal",
    "numeric",
    "operator",
    "string",
    "type",
    "u32",
    "u64",
  ].includes(name) || isUnsignedIntegerType(name);
}

function lowerFirst(name: string): string {
  return name ? name[0].toLowerCase() + name.slice(1) : name;
}

function upperFirst(name: string): string {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

function pascalCase(name: string): string {
  return name.split(/[_-]+/).filter(Boolean).map((part) =>
    part ? part[0].toUpperCase() + part.slice(1) : ""
  ).join("");
}

function resolveLocal(expr: TypeExpr, locals: Map<string, TypeExpr>): TypeExpr {
  if (expr.kind === "type_ref") return locals.get(expr.name) ?? expr;
  return expr;
}

function typeBuilderCall(
  expr: TypeExpr,
): { name: "struct" | "union"; args: TypeExpr[] } | undefined {
  if (expr.kind !== "type_call" || expr.callee.kind !== "type_ref") return undefined;
  if (expr.callee.name !== "struct" && expr.callee.name !== "union") return undefined;
  return { name: expr.callee.name, args: expr.args };
}

function normalizeShape(shape: TypeShape): ShapeType {
  return {
    slots: shape.slots.map((slot) => ({
      ...(slot.doc ? { doc: slot.doc } : {}),
      label: slot.label,
      type: renderTypeExpr(slot.type),
      ...(slot.repeat ? { repeat: renderCountExpr(slot.repeat) } : {}),
    })),
  };
}

function normalizeMembers(members: TypeShape["members"] | undefined) {
  return members?.length
    ? members.map((member) => ({
      ...(member.doc ? { doc: member.doc } : {}),
      name: member.name,
      type: member.type,
      target: member.target,
    }))
    : undefined;
}

function renderTypeExpr(expr: TypeExpr): string {
  switch (expr.kind) {
    case "type_ref":
      return expr.name;
    case "type_hole":
      return "_";
    case "type_static_ref":
      return `@${expr.name}`;
    case "type_call":
      return `${renderTypeExpr(expr.callee)}(${expr.args.map(renderTypeExpr).join(", ")})`;
    case "type_fn":
      return expr.source;
    case "type_shape":
      return renderShape(expr.shape);
    case "type_members":
      return `members(${renderTypeExpr(expr.target)})`;
    case "type_match":
      return `match ${renderTypeExpr(expr.value)} { ${
        expr.arms.map((arm) => `${renderTypePattern(arm.pattern)} => ${renderTypeExpr(arm.value)}`)
          .join(", ")
      } }`;
    case "type_scalar_domain":
      return renderTypeScalarDomainExpr(expr);
    case "type_binary":
      return `${renderTypeExpr(expr.left)} ${expr.op} ${renderTypeExpr(expr.right)}`;
    case "type_bool":
      return expr.value ? "true" : "false";
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

function renderTypeScalarDomainExpr(
  expr: Extract<TypeExpr, { kind: "type_scalar_domain" }>,
): string {
  return `${expr.carrier}(${expr.members.map(renderTypeScalarDomainMember).join(" | ")})`;
}

function renderTypeScalarDomainMember(
  member: Extract<TypeExpr, { kind: "type_scalar_domain" }>["members"][number],
): string {
  const start = renderTypeScalarDomainEndpoint(member.start);
  const end = member.end ? renderTypeScalarDomainEndpoint(member.end) : undefined;
  return end ? `${start}..${end}` : start;
}

function renderTypeScalarDomainEndpoint(
  endpoint: Extract<TypeExpr, { kind: "type_scalar_domain" }>["members"][number]["start"],
): string {
  return endpoint.source;
}

type LiteralTypeMember = {
  kind: "number" | "bool" | "string" | "char" | "literal";
  value: string;
};

function canonicalLiteralType(type: string | undefined): string | undefined {
  const expr = type ? parseAnnotationType(type) : undefined;
  if (!expr) return undefined;
  const members = literalTypeMembersFromExpr(expr);
  return members ? renderLiteralUnionType(members) : undefined;
}

function literalTypeMembers(type: string | undefined): LiteralTypeMember[] | undefined {
  const expr = type ? parseAnnotationType(type) : undefined;
  return expr ? literalTypeMembersFromExpr(expr) : undefined;
}

function literalTypeMembersFromExpr(expr: TypeExpr): LiteralTypeMember[] | undefined {
  if (expr.kind === "type_binary" && expr.op === "|") {
    const left = literalTypeMembersFromExpr(expr.left);
    const right = literalTypeMembersFromExpr(expr.right);
    return left && right ? canonicalLiteralMembers([...left, ...right]) : undefined;
  }
  const member = literalTypeMemberFromExpr(expr);
  return member ? [member] : undefined;
}

function literalTypeMemberFromExpr(expr: TypeExpr): LiteralTypeMember | undefined {
  if (expr.kind === "type_number") return { kind: "number", value: expr.value };
  if (expr.kind === "type_bool") return { kind: "bool", value: expr.value ? "true" : "false" };
  if (expr.kind === "type_string") return { kind: "string", value: expr.value };
  if (expr.kind === "type_char") return { kind: "char", value: expr.value };
  if (expr.kind === "type_literal") return { kind: "literal", value: expr.value };
  return undefined;
}

function literalTypeMembersFromEval(value: TypeEvalValue): LiteralTypeMember[] | undefined {
  if (value.kind === "number") return [{ kind: "number", value: value.value }];
  if (value.kind === "bool") return [{ kind: "bool", value: value.value ? "true" : "false" }];
  if (value.kind === "string") return [{ kind: "string", value: value.value }];
  if (value.kind === "char") return [{ kind: "char", value: value.value }];
  if (value.kind === "literal") return [{ kind: "literal", value: value.value }];
  if (value.kind === "type") return literalTypeMembers(value.name);
  return undefined;
}

function literalTypeMembersFromTypeResult(value: TypeEvalValue): LiteralTypeMember[] | undefined {
  const members = literalTypeMembersFromEval(value);
  if (!members || members.some((member) => member.kind === "bool")) return undefined;
  return members;
}

function canonicalLiteralMembers(members: LiteralTypeMember[]): LiteralTypeMember[] {
  const byKey = new Map<string, LiteralTypeMember>();
  for (const member of members) byKey.set(literalTypeMemberKey(member), member);
  return [...byKey.values()].toSorted((left, right) =>
    literalTypeMemberKey(left).localeCompare(literalTypeMemberKey(right))
  );
}

function renderLiteralUnionType(members: LiteralTypeMember[]): string {
  return canonicalLiteralMembers(members).map(renderLiteralTypeMember).join(" | ");
}

function renderLiteralTypeMember(member: LiteralTypeMember): string {
  if (member.kind === "string") return JSON.stringify(member.value);
  if (member.kind === "char") {
    return `'${member.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (member.kind === "literal") return `#${member.value}`;
  return member.value;
}

function literalTypeMemberKey(member: LiteralTypeMember): string {
  return `${member.kind}:${member.value}`;
}

function literalExprMember(expr: Expr): LiteralTypeMember | undefined {
  if (expr.kind !== "literal") return undefined;
  if (expr.literalKind === "number") return { kind: "number", value: expr.value };
  if (expr.literalKind === "bool") return { kind: "bool", value: expr.value };
  if (expr.literalKind === "string") {
    return { kind: "string", value: decodeStringLiteralValue(expr.value) };
  }
  if (expr.literalKind === "char") {
    return { kind: "char", value: JSON.parse(`"${expr.value.slice(1, -1)}"`) };
  }
  if (expr.literalKind === "literalType") return { kind: "literal", value: expr.value.slice(1) };
  return undefined;
}

function literalExprFitsType(expr: Expr, expectedType: string | undefined): boolean {
  const member = literalExprMember(expr);
  const members = literalTypeMembers(expectedType);
  if (!member || !members) return false;
  const key = literalTypeMemberKey(member);
  return members.some((item) => literalTypeMemberKey(item) === key);
}

function literalTypeCarrier(type: string | undefined): string | undefined {
  const members = literalTypeMembers(type);
  if (!members) return undefined;
  if (members.every((member) => member.kind === "bool")) return "bool";
  return "i32";
}

function runtimeValueTypeAssignable(
  expected: string | undefined,
  actual: string | undefined,
  types: TypeDecl[] = [],
): boolean {
  if (!expected || !actual) return true;
  const refined = refinedI32Assignable(
    resolveAliasFree(expected),
    resolveAliasFree(actual),
  );
  if (refined !== undefined) return refined;
  const resolvedExpected = resolveAliasType(expected, types) ?? expected.trim();
  const resolvedActual = resolveAliasType(actual, types) ?? actual.trim();
  const expectedLiteral = canonicalLiteralType(resolvedExpected);
  const actualLiteral = canonicalLiteralType(resolvedActual);
  if (expectedLiteral) return actualLiteral === expectedLiteral;
  if (actualLiteral && literalTypeCarrier(actualLiteral) === resolvedExpected.trim()) return true;
  const expectedRuntime = scalarDomainRuntimeType(expected);
  const actualRuntime = scalarDomainRuntimeType(actual);
  if (expectedRuntime && actualRuntime && expectedRuntime === actualRuntime) return true;
  if (isNumericType(resolvedExpected) && isNumericType(resolvedActual)) {
    return numericRuntimeTypesAssignable(resolvedExpected, resolvedActual);
  }
  return true;
}

function numericRuntimeTypesAssignable(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  const expectedLane = numericLoweringLane(expected);
  const actualLane = numericLoweringLane(actual);
  return expectedLane !== undefined && expectedLane === actualLane;
}

function numericLoweringLane(type: string): "i32" | "i64" | "f32" | "f64" | undefined {
  const scalar = scalarReflection(type.trim());
  if (!scalar) return undefined;
  if (scalar.carrier === "f32") return "f32";
  if (scalar.carrier === "f64") return "f64";
  if (scalar.carrier === "i64" || scalar.carrier === "u64") return "i64";
  const width = scalar.bitWidth;
  if (width !== undefined && width > 32) return "i64";
  return "i32";
}

function resolveAliasFree(type: string | undefined): string | undefined {
  return type?.trim();
}

function renderTypePattern(pattern: TypePattern): string {
  switch (pattern.kind) {
    case "wildcard":
      return "_";
    case "bool":
      return pattern.value ? "true" : "false";
    case "literal":
      return `#${pattern.value}`;
    case "string":
      return JSON.stringify(pattern.value);
    case "char":
      return `'${pattern.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "number":
      return pattern.value;
    case "type":
      return pattern.name;
  }
}

function renderShape(shape: TypeShape): string {
  return `{${
    shape.slots.map((slot) =>
      `${renderShapeSlotKey(slot)}${slot.repeat ? `${renderCountExpr(slot.repeat)} * ` : ""}${
        renderTypeExpr(slot.type)
      }`
    ).join(", ")
  }}`;
}

function renderShapeItems(shape: TypeShape): string {
  return [
    ...shape.slots.map((slot) =>
      `${renderShapeSlotKey(slot)}${slot.repeat ? `${renderCountExpr(slot.repeat)} * ` : ""}${
        renderTypeExpr(slot.type)
      }`
    ),
    ...(shape.members ?? []).map((member) =>
      `const ${member.name}: ${member.type} = ${member.target}`
    ),
  ].join(", ");
}

function renderShapeSlotKey(slot: { label?: string; position?: number }): string {
  if (slot.label && slot.position !== undefined) return `${slot.label}[${slot.position}]: `;
  if (slot.label) return `${slot.label}: `;
  if (slot.position !== undefined) return `[${slot.position}]: `;
  return "";
}

function renderCountExpr(expr: TypeCountExpr): string {
  switch (expr.kind) {
    case "count_literal":
      return expr.source;
    case "count_ref":
      return expr.name;
    case "count_mul":
      return `${renderCountExpr(expr.left)} * ${renderCountExpr(expr.right)}`;
  }
}

function parseTypeCount(source: string): TypeCountExpr {
  const trimmed = source.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    return { kind: "count_literal", value: Number.parseInt(trimmed, 10), source: trimmed };
  }
  return { kind: "count_ref", name: trimmed };
}

function renderTypeEvalCountExpr(expr: TypeCountExpr, locals: Map<string, TypeEvalValue>): string {
  switch (expr.kind) {
    case "count_literal":
      return expr.source;
    case "count_ref": {
      const value = locals.get(expr.name);
      return value?.kind === "number" ? value.value : expr.name;
    }
    case "count_mul":
      return `${renderTypeEvalCountExpr(expr.left, locals)} * ${
        renderTypeEvalCountExpr(expr.right, locals)
      }`;
  }
}

type TypeEvalValue =
  & (
    | { kind: "never" }
    | { kind: "bool"; value: boolean }
    | { kind: "number"; value: string }
    | { kind: "char"; value: string }
    | { kind: "string"; value: string }
    | { kind: "literal"; value: string }
    | { kind: "static_builtin"; name: string }
    | { kind: "shape"; slots: { label?: string; value: TypeEvalValue; repeat?: string }[] }
    | { kind: "members"; target: string; functions: FnDecl[] }
    | { kind: "type"; name: string; normalized?: TypeBody }
  )
  & { span?: Span };

function checkTypeContracts(
  program: Program,
  types: TypeDecl[],
  functions: FnDecl[],
  hostIoImports: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
  cache?: CheckCache,
) {
  const byName = new Map(types.map((decl) => [decl.name, decl]));
  const byFn = new Map(functions.map((decl) => [decl.name, decl]));
  const environmentKey = cache?.typeContractChecks
    ? typeContractEnvironmentKey(
      types,
      functions,
      hostIoImports,
      consts,
      cache.signatureHashes,
    )
    : undefined;
  for (const decl of program.declarations) {
    const cacheKey = environmentKey && (decl.kind === "const" || decl.kind === "let" ||
        decl.kind === "fn")
      ? typeContractDeclarationCacheKey(decl, environmentKey, cache?.semanticHashes)
      : undefined;
    if (cacheKey && cache?.typeContractChecks?.has(cacheKey)) continue;
    const diagnosticStart = diagnostics.length;
    if (decl.kind === "const" || decl.kind === "let") {
      if (decl.type) {
        instantiateNestedAnnotations(
          decl.type,
          byName,
          byFn,
          hostIoImports,
          consts,
          diagnostics,
          decl.span,
          pluginRegistry,
        );
      }
    } else if (decl.kind === "fn") {
      const constTypeParams = new Set<string>();
      for (const param of decl.params) {
        if (
          !annotationReferencesAny(param.type, constTypeParams) &&
          !annotationHasInferredVars(param.type)
        ) {
          instantiateNestedAnnotations(
            param.type,
            byName,
            byFn,
            hostIoImports,
            consts,
            diagnostics,
            param.span ?? decl.span,
            pluginRegistry,
          );
        }
        if (param.const && (param.type === "type" || param.inferStaticType)) {
          constTypeParams.add(param.name);
        }
      }
      if (
        decl.returnType && !annotationReferencesAny(decl.returnType, constTypeParams) &&
        !annotationHasInferredVars(decl.returnType)
      ) {
        instantiateNestedAnnotations(
          decl.returnType,
          byName,
          byFn,
          hostIoImports,
          consts,
          diagnostics,
          decl.span,
          pluginRegistry,
        );
      }
      checkBlockTypeContracts(
        decl.body,
        byName,
        byFn,
        hostIoImports,
        consts,
        diagnostics,
        constTypeParams,
        pluginRegistry,
      );
    } else if (decl.kind === "type_assert") {
      validateProofConst(
        decl.value,
        byName,
        byFn,
        hostIoImports,
        consts,
        diagnostics,
        decl.span,
        pluginRegistry,
      );
    }
    if (cacheKey && diagnostics.length === diagnosticStart) {
      cache?.typeContractChecks?.add(cacheKey);
    }
  }
}

function checkBlockTypeContracts(
  block: Extract<Expr, { kind: "block" }>,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  hostIoImports: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  deferredTypeParams = new Set<string>(),
  pluginRegistry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
) {
  for (const stmt of block.statements) {
    if (
      stmt.kind === "let" && stmt.type &&
      !annotationReferencesAny(stmt.type, deferredTypeParams)
    ) {
      instantiateNestedAnnotations(
        stmt.type,
        typesByName,
        functions,
        hostIoImports,
        consts,
        diagnostics,
        stmt.span,
        pluginRegistry,
      );
    }
    if (stmt.kind === "let") {
      checkExprTypeContracts(
        stmt.value,
        typesByName,
        functions,
        hostIoImports,
        consts,
        diagnostics,
        pluginRegistry,
      );
    } else if (stmt.kind === "type_assert" && typeExprIsConcreteProofTarget(stmt.value)) {
      validateProofConst(
        stmt.value,
        typesByName,
        functions,
        hostIoImports,
        consts,
        diagnostics,
        stmt.span,
        pluginRegistry,
      );
    }
  }
  if (block.expr) {
    checkExprTypeContracts(
      block.expr,
      typesByName,
      functions,
      hostIoImports,
      consts,
      diagnostics,
      pluginRegistry,
    );
  }
}

function validateProofConst(
  expr: TypeExpr,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  hostIoImports: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  diagnosticSpan: Span | undefined,
  pluginRegistry: CompilerPluginRegistry,
) {
  instantiateTypeExpr(
    expr,
    typesByName,
    functions,
    hostIoImports,
    consts,
    diagnostics,
    new Map(),
    diagnosticSpan,
    pluginRegistry,
  );
}

function checkExprTypeContracts(
  expr: Expr,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  hostIoImports: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
) {
  if (expr.kind === "block") {
    checkBlockTypeContracts(
      expr,
      typesByName,
      functions,
      hostIoImports,
      consts,
      diagnostics,
      new Set(),
      pluginRegistry,
    );
  } else if (expr.kind === "match") {
    checkExprTypeContracts(
      expr.value,
      typesByName,
      functions,
      hostIoImports,
      consts,
      diagnostics,
      pluginRegistry,
    );
    for (const arm of expr.arms) {
      checkExprTypeContracts(
        arm.value,
        typesByName,
        functions,
        hostIoImports,
        consts,
        diagnostics,
        pluginRegistry,
      );
    }
  } else if (expr.kind === "product_constructor" || expr.kind === "shape") {
    for (const slot of expr.slots) {
      checkExprTypeContracts(
        slot.value,
        typesByName,
        functions,
        hostIoImports,
        consts,
        diagnostics,
        pluginRegistry,
      );
    }
  } else if (expr.kind === "do") {
    for (const stmt of expr.statements) {
      if (stmt.kind === "type_assert" && typeExprIsConcreteProofTarget(stmt.value)) {
        validateProofConst(
          stmt.value,
          typesByName,
          functions,
          hostIoImports,
          consts,
          diagnostics,
          stmt.span,
          pluginRegistry,
        );
      } else if (stmt.kind !== "type_assert" && "value" in stmt) {
        checkExprTypeContracts(
          stmt.value,
          typesByName,
          functions,
          hostIoImports,
          consts,
          diagnostics,
          pluginRegistry,
        );
      }
    }
    if (expr.expr) {
      checkExprTypeContracts(
        expr.expr,
        typesByName,
        functions,
        hostIoImports,
        consts,
        diagnostics,
        pluginRegistry,
      );
    }
  }
}

function lowerMemberwiseEql(
  program: Program,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  const lowerExprArray = (items: Expr[], currentFn?: FnDecl): Expr[] => {
    let changed = false;
    const lowered: Expr[] = [];
    for (const item of items) {
      const next = lowerExpr(item, currentFn);
      if (next !== item) changed = true;
      lowered.push(next);
    }
    return changed ? lowered : items;
  };
  const lowerExpr = (expr: Expr, currentFn?: FnDecl): Expr => {
    if (
      expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === "@memberwise_eql"
    ) {
      return lowerMemberwiseEqlCall(expr, types, diagnostics);
    }
    switch (expr.kind) {
      case "do":
        return lowerDoExpression(expr, diagnostics, (item) => lowerExpr(item, currentFn));
      case "const_fn": {
        const body = lowerExpr(expr.body, currentFn);
        return body === expr.body ? expr : { ...expr, body };
      }
      case "profile": {
        const args = lowerExprArray(expr.args, currentFn);
        const body = lowerExpr(expr.body, currentFn);
        return args === expr.args && body === expr.body ? expr : { ...expr, args, body };
      }
      case "call": {
        const callee = lowerExpr(expr.callee, currentFn);
        const args = lowerExprArray(expr.args, currentFn);
        return callee === expr.callee && args === expr.args ? expr : { ...expr, callee, args };
      }
      case "index": {
        const target = lowerExpr(expr.target, currentFn);
        const index = lowerExpr(expr.index, currentFn);
        return target === expr.target && index === expr.index ? expr : { ...expr, target, index };
      }
      case "binary": {
        const left = lowerExpr(expr.left, currentFn);
        const right = lowerExpr(expr.right, currentFn);
        return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
      }
      case "operator_chain": {
        const first = lowerExpr(expr.first, currentFn);
        let changed = first !== expr.first;
        const rest = expr.rest.map((item) => {
          const value = lowerExpr(item.value, currentFn);
          if (value === item.value) return item;
          changed = true;
          return { ...item, value };
        });
        return changed ? { ...expr, first, rest } : expr;
      }
      case "pipe_bind": {
        const value = lowerExpr(expr.value, currentFn);
        const body = lowerExpr(expr.body, currentFn);
        return value === expr.value && body === expr.body ? expr : { ...expr, value, body };
      }
      case "match": {
        const value = lowerExpr(expr.value, currentFn);
        let changed = value !== expr.value;
        const arms = expr.arms.map((arm) => {
          const guard = arm.guard ? lowerExpr(arm.guard, currentFn) : undefined;
          const armValue = lowerExpr(arm.value, currentFn);
          if (guard === arm.guard && armValue === arm.value) return arm;
          changed = true;
          return { ...arm, ...(guard ? { guard } : {}), value: armValue };
        });
        return changed ? { ...expr, value, arms } : expr;
      }
      case "shape":
      case "product_constructor": {
        let changed = false;
        const slots = expr.slots.map((slot) => {
          const index = slot.index ? lowerExpr(slot.index, currentFn) : undefined;
          const value = lowerExpr(slot.value, currentFn);
          if (index === slot.index && value === slot.value) return slot;
          changed = true;
          return { ...slot, ...(index ? { index } : {}), value };
        });
        return changed ? { ...expr, slots } : expr;
      }
      case "static_for_slots": {
        const source = lowerStaticForSourceExpr(expr.source, (item) => lowerExpr(item, currentFn));
        const value = lowerExpr(expr.value, currentFn);
        return source === expr.source && value === expr.value ? expr : { ...expr, source, value };
      }
      case "range": {
        const start = lowerExpr(expr.start, currentFn);
        const end = lowerExpr(expr.end, currentFn);
        return start === expr.start && end === expr.end ? expr : { ...expr, start, end };
      }
      case "field": {
        const value = lowerExpr(expr.value, currentFn);
        const key = lowerExpr(expr.key, currentFn);
        return value === expr.value && key === expr.key ? expr : { ...expr, value, key };
      }
      case "block": {
        let changed = false;
        const statements = expr.statements.map((stmt) => {
          if (stmt.kind !== "let" && stmt.kind !== "destructure_let") return stmt;
          const value = lowerExpr(stmt.value, currentFn);
          if (value === stmt.value) return stmt;
          changed = true;
          return { ...stmt, value } as Statement;
        });
        const body = expr.expr ? lowerExpr(expr.expr, currentFn) : undefined;
        if (body !== expr.expr) changed = true;
        return changed ? { ...expr, statements, expr: body } : expr;
      }
      case "literal":
      case "var":
        return expr;
    }
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      decl.body = lowerExpr(decl.body, decl) as Extract<Expr, { kind: "block" }>;
    } else if (decl.kind === "let" || decl.kind === "const") decl.value = lowerExpr(decl.value);
  }
}

function lowerMemberwiseEqlCall(
  expr: Extract<Expr, { kind: "call" }>,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
  currentFn?: FnDecl,
): Expr {
  if (expr.args.length !== 3) {
    diagnostics.push(diagnosticAt(
      "type.memberwise_eql",
      "@memberwise_eql expects a type, left value, and right value",
      expr,
    ));
    return expr;
  }
  const left = expr.args[1]!;
  const right = expr.args[2]!;
  const explicitTypeName = renderTypeProofArg(expr.args[0]!);
  const fallbackTypeName = memberwiseValueType(left, currentFn);
  let typeName = explicitTypeName;
  let decl = typeName ? resolveTypeDecl(typeName, types) : undefined;
  if (!decl && fallbackTypeName) {
    typeName = fallbackTypeName;
    decl = resolveTypeDecl(typeName, types);
  }
  const product = decl?.normalized?.kind === "product" ? decl.normalized : undefined;
  if (!typeName || !decl || !product) {
    diagnostics.push(diagnosticAt(
      "type.memberwise_eql",
      "@memberwise_eql requires a product type",
      expr.args[0] ?? expr,
    ));
    return expr;
  }
  const bindings = genericBindings(typeName, decl);
  const terms: Expr[] = [];
  const assertions: Statement[] = [];
  for (const slot of product.shape.slots) {
    if (!slot.label) {
      diagnostics.push(diagnosticAt(
        "type.memberwise_eql",
        "@memberwise_eql requires labeled product fields",
        expr,
      ));
      return expr;
    }
    const slotType = substituteTypeVars(slot.type, bindings);
    const proof = memberwiseEqProof(slotType);
    if (proof) assertions.push({ kind: "type_assert", value: proof });
    terms.push({
      kind: "call",
      callee: { kind: "var", name: `${slotType}::eql` },
      args: [
        memberwiseField(left, slot.label),
        memberwiseField(right, slot.label),
      ],
    });
  }
  if (!terms.length) return { kind: "literal", literalKind: "bool", value: "true" };
  let current = terms[0]!;
  for (const term of terms.slice(1)) {
    current = { kind: "binary", op: "&&", left: current, right: term };
  }
  if (assertions.length) return { kind: "block", statements: assertions, expr: current };
  return current;
}

function memberwiseEqProof(type: string): TypeExpr | undefined {
  return parseAnnotationType(`core.Eq(${type})`);
}

function memberwiseValueType(value: Expr, currentFn?: FnDecl): string | undefined {
  if (value.kind !== "var" || !currentFn) return undefined;
  for (const param of currentFn.params) {
    if (param.name === value.name) return param.type;
  }
  return undefined;
}

function memberwiseField(value: Expr, label: string): Expr {
  return {
    kind: "field",
    value,
    key: { kind: "literal", literalKind: "literalType", value: `#${label}` },
  };
}

function lowerProductConstructors(
  program: Program,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  const products = new Map<string, TypeBody & { kind: "product" }>();
  const productsByTerminal = new Map<string, Array<TypeBody & { kind: "product" }>>();
  for (const type of types) {
    if (type.normalized?.kind === "product") {
      products.set(type.normalized.constructor, type.normalized);
      const terminal = terminalName(type.normalized.constructor);
      const existing = productsByTerminal.get(terminal) ?? [];
      existing.push(type.normalized);
      productsByTerminal.set(terminal, existing);
    }
  }
  const lowerExprArray = (items: Expr[]): Expr[] => {
    let changed = false;
    const lowered: Expr[] = [];
    for (const item of items) {
      const next = lowerExpr(item);
      if (next !== item) changed = true;
      lowered.push(next);
    }
    return changed ? lowered : items;
  };
  const lowerSlots = <T extends { value: Expr }>(slots: T[]): T[] => {
    let changed = false;
    const lowered: T[] = [];
    for (const slot of slots) {
      const value = lowerExpr(slot.value);
      if (value !== slot.value) {
        changed = true;
        lowered.push({ ...slot, value });
      } else {
        lowered.push(slot);
      }
    }
    return changed ? lowered : slots;
  };
  function lowerExpr(expr: Expr): Expr {
    switch (expr.kind) {
      case "do":
        return lowerDoExpression(expr, diagnostics, lowerExpr);
      case "const_fn": {
        const body = lowerExpr(expr.body);
        return body === expr.body ? expr : { ...expr, body };
      }
      case "profile": {
        const args = lowerExprArray(expr.args);
        const body = lowerExpr(expr.body);
        return args === expr.args && body === expr.body ? expr : { ...expr, args, body };
      }
      case "product_constructor": {
        const product = resolveProductConstructor(expr.constructor, products, productsByTerminal);
        const anonymousShape = product ? undefined : constShapeValueFromTypeArg(expr.constructor);
        if (!product && anonymousShape?.kind === "shape") {
          return {
            kind: "shape",
            syntax: "record",
            span: expr.span,
            inferredType: `struct(${expr.constructor})`,
            slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value) })),
          };
        }
        if (!product) {
          diagnostics.push(diagnosticAt(
            "type.unknown_constructor",
            `unknown product constructor ${expr.constructor}`,
            expr,
          ));
        } else {
          checkProductConstructorShape(expr, product, diagnostics);
        }
        return {
          kind: "shape",
          syntax: "record",
          span: expr.span,
          inferredType: product?.name,
          slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value) })),
        };
      }
      case "call": {
        const callee = lowerExpr(expr.callee);
        const args = lowerExprArray(expr.args);
        return callee === expr.callee && args === expr.args ? expr : { ...expr, callee, args };
      }
      case "index": {
        const target = lowerExpr(expr.target);
        const index = lowerExpr(expr.index);
        return target === expr.target && index === expr.index ? expr : { ...expr, target, index };
      }
      case "binary": {
        const left = lowerExpr(expr.left);
        const right = lowerExpr(expr.right);
        return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
      }
      case "operator_chain": {
        const first = lowerExpr(expr.first);
        let changed = first !== expr.first;
        const rest = expr.rest.map((item) => {
          const value = lowerExpr(item.value);
          if (value === item.value) return item;
          changed = true;
          return { ...item, value };
        });
        return changed ? { ...expr, first, rest } : expr;
      }
      case "pipe_bind": {
        const value = lowerExpr(expr.value);
        const body = lowerExpr(expr.body);
        return value === expr.value && body === expr.body ? expr : { ...expr, value, body };
      }
      case "match": {
        const value = lowerExpr(expr.value);
        let changed = value !== expr.value;
        const arms = expr.arms.map((arm) => {
          const armValue = lowerExpr(arm.value);
          if (armValue === arm.value) return arm;
          changed = true;
          return { ...arm, value: armValue };
        });
        return changed ? { ...expr, value, arms } : expr;
      }
      case "shape": {
        const slots = lowerSlots(expr.slots);
        return slots === expr.slots ? expr : { ...expr, slots };
      }
      case "static_for_slots": {
        const source = lowerStaticForSourceExpr(expr.source, lowerExpr);
        const value = lowerExpr(expr.value);
        return source === expr.source && value === expr.value ? expr : { ...expr, source, value };
      }
      case "range": {
        const start = lowerExpr(expr.start);
        const end = lowerExpr(expr.end);
        return start === expr.start && end === expr.end ? expr : { ...expr, start, end };
      }
      case "field": {
        const value = lowerExpr(expr.value);
        const key = lowerExpr(expr.key);
        return value === expr.value && key === expr.key ? expr : { ...expr, value, key };
      }
      case "block": {
        let changed = false;
        const statements = expr.statements.map((stmt) => {
          if (stmt.kind !== "let" && stmt.kind !== "destructure_let") return stmt;
          const value = lowerExpr(stmt.value);
          if (value === stmt.value) return stmt;
          changed = true;
          return { ...stmt, value };
        });
        const body = expr.expr ? lowerExpr(expr.expr) : undefined;
        if (body !== expr.expr) changed = true;
        return changed ? { ...expr, statements, expr: body } : expr;
      }
      case "literal":
      case "var":
        return expr;
    }
  }
  for (const decl of program.declarations) {
    if (decl.kind === "fn") decl.body = lowerExpr(decl.body) as Extract<Expr, { kind: "block" }>;
    else if (decl.kind === "let" || decl.kind === "const") decl.value = lowerExpr(decl.value);
  }
}

function resolveProductConstructor(
  name: string,
  products: Map<string, TypeBody & { kind: "product" }>,
  productsByTerminal: Map<string, Array<TypeBody & { kind: "product" }>>,
): TypeBody & { kind: "product" } | undefined {
  const exact = products.get(name);
  if (exact) return exact;
  if (name.includes(".")) return undefined;
  const matches = productsByTerminal.get(name) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function terminalName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function lowerStaticForSourceExpr(
  source: StaticForSource,
  lowerExpr: (expr: Expr) => Expr,
): StaticForSource {
  return source.kind === "range"
    ? { ...source, start: lowerExpr(source.start), end: lowerExpr(source.end) }
    : { ...source, shape: lowerExpr(source.shape) };
}

function checkProductConstructorShape(
  expr: Extract<Expr, { kind: "product_constructor" }>,
  product: TypeBody & { kind: "product" },
  diagnostics: Diagnostic[],
) {
  const hasSpread = expr.slots.some((slot) => slot.spread);
  const expected = new Set(
    product.shape.slots.map((slot) => slot.label).filter((label): label is string => !!label),
  );
  const actual = new Set<string>();
  for (const slot of expr.slots) {
    if (slot.value.kind === "static_for_slots") continue;
    if (slot.spread) continue;
    if (!slot.label) continue;
    actual.add(slot.label);
  }
  if (!hasSpread && !expr.slots.some((slot) => slot.value.kind === "static_for_slots")) {
    for (const label of expected) {
      if (!actual.has(label)) {
        diagnostics.push(diagnosticAt(
          "type.constructor_missing_slot",
          `${expr.constructor} is missing field ${label}`,
          expr,
        ));
      }
    }
  }
  for (const label of actual) {
    if (!expected.has(label)) {
      const slot = expr.slots.find((item) => item.label === label);
      diagnostics.push(diagnosticAt(
        "type.constructor_unknown_slot",
        `${expr.constructor} has no field ${label}`,
        slot ?? expr,
      ));
    }
  }
}

function annotationReferencesAny(annotation: string, names: Set<string>): boolean {
  for (const name of names) {
    if (new RegExp(`\\b${name}\\b`).test(annotation)) return true;
  }
  return false;
}

function annotationHasInferredVars(annotation: string): boolean {
  const vars = new Set<string>();
  collectFreeTypeVars(annotation, vars);
  return vars.size > 0;
}

function instantiateNestedAnnotations(
  annotation: string,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  hostIoImports: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  diagnosticSpan?: Span,
  pluginRegistry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
) {
  for (const typeExpr of parseAnnotationTypeCalls(annotation)) {
    instantiateTypeExpr(
      typeExpr,
      typesByName,
      functions,
      hostIoImports,
      consts,
      diagnostics,
      new Map(),
      diagnosticSpan,
      pluginRegistry,
    );
  }
}

function instantiateAnnotation(
  annotation: string,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  hostIoImports: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  diagnosticSpan?: Span,
  pluginRegistry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
): TypeBody | undefined {
  const expr = parseAnnotationType(annotation);
  if (!expr) return undefined;
  const value = instantiateTypeExpr(
    expr,
    typesByName,
    functions,
    hostIoImports,
    consts,
    diagnostics,
    new Map(),
    diagnosticSpan,
    pluginRegistry,
  );
  return value?.kind === "type" ? value.normalized : undefined;
}

function instantiateTypeExpr(
  expr: TypeExpr,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  hostIoImports: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  locals = new Map<string, TypeEvalValue>(),
  diagnosticSpan?: Span,
  pluginRegistry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
): TypeEvalValue | undefined {
  const evaluator = new TypeEvaluator(
    typesByName,
    functions,
    hostIoImports,
    consts,
    diagnostics,
    shaderManifestEntry,
    pluginRegistry,
    diagnosticSpan,
  );
  return evaluator.eval(expr, locals);
}

class TypeEvaluator {
  constructor(
    private typesByName: Map<string, TypeDecl>,
    private functions: Map<string, FnDecl>,
    private hostIoImports: Map<string, string[]>,
    private consts: Map<string, ConstValue>,
    private diagnostics: Diagnostic[],
    private addShader: (source: string) => ShaderManifestEntry,
    private pluginRegistry: CompilerPluginRegistry,
    private diagnosticSpan?: Span,
    private allowMembersResult = false,
  ) {}

  eval(
    expr: TypeExpr,
    locals: Map<string, TypeEvalValue>,
    diagnosticSpan?: Span,
  ): TypeEvalValue | undefined {
    if (diagnosticSpan) {
      const previous = this.diagnosticSpan;
      this.diagnosticSpan = diagnosticSpan;
      const value = this.eval(expr, locals);
      this.diagnosticSpan = previous;
      return value;
    }
    switch (expr.kind) {
      case "type_ref":
        return this.evalRef(expr.name, locals);
      case "type_hole":
        this.reportDiagnostic({
          code: "type.hole_context",
          message: "type holes are only allowed in do-strategy type arguments",
          span: expr.span,
        });
        return { kind: "never" };
      case "type_static_ref":
        return { kind: "static_builtin", name: expr.name };
      case "type_call":
        return this.evalCall(expr, locals);
      case "type_shape":
        return {
          kind: "shape",
          slots: expr.shape.slots.map((slot) => ({
            label: slot.label,
            value: this.withSpan(this.eval(slot.type, locals) ?? { kind: "never" }, slot.type.span),
          })),
          span: expr.span,
        };
      case "type_members":
        return this.evalMembers(expr, locals);
      case "type_fn":
        return { kind: "type", name: substituteTypeSource(expr.source, locals) };
      case "type_match": {
        const value = this.eval(expr.value, locals);
        if (!value) return undefined;
        for (const arm of expr.arms) {
          if (typePatternMatches(arm.pattern, value)) {
            return this.eval(arm.value, new Map(locals));
          }
        }
        this.reportDiagnostic({
          code: "type.non_exhaustive_match",
          message: "type match has no matching arm",
        });
        return { kind: "never" };
      }
      case "type_scalar_domain": {
        const rendered = renderTypeExpr(expr);
        return this.namedType(refinedI32TypeCanonical(rendered) ?? rendered);
      }
      case "type_binary": {
        const left = this.eval(expr.left, locals);
        const right = this.eval(expr.right, locals);
        if (!left || !right) return undefined;
        if (expr.op === "==" || expr.op === "!=") {
          const leftKey = this.typeEvalKey(left);
          const rightKey = this.typeEvalKey(right);
          const equal = leftKey === rightKey;
          return { kind: "bool", value: expr.op === "==" ? equal : !equal };
        }
        if (expr.op === "|") {
          const members = [
            ...(literalTypeMembersFromEval(left) ?? []),
            ...(literalTypeMembersFromEval(right) ?? []),
          ];
          const leftMembers = literalTypeMembersFromEval(left);
          const rightMembers = literalTypeMembersFromEval(right);
          if (leftMembers && rightMembers) return this.namedType(renderLiteralUnionType(members));
          return this.namedType(`${renderTypeEvalValue(left)} | ${renderTypeEvalValue(right)}`);
        }
        return this.unsupported(
          "type.unsupported_expr",
          `operator ${expr.op} is not type-evaluable`,
        );
      }
      case "type_string":
        return { kind: "string", value: expr.value };
      case "type_char":
        return { kind: "char", value: expr.value };
      case "type_literal":
        return { kind: "literal", value: expr.value };
      case "type_number":
        return { kind: "number", value: expr.value };
      case "type_bool":
        return { kind: "bool", value: expr.value };
    }
  }

  private evalCall(
    expr: Extract<TypeExpr, { kind: "type_call" }>,
    locals: Map<string, TypeEvalValue>,
  ): TypeEvalValue | undefined {
    const localCallee = expr.callee.kind === "type_ref" ? locals.get(expr.callee.name) : undefined;
    const evaluatedCallee =
      expr.callee.kind === "type_ref" || expr.callee.kind === "type_static_ref"
        ? undefined
        : this.eval(expr.callee, locals);
    const callee = expr.callee.kind === "type_ref"
      ? localCallee?.kind === "type" ? localCallee.name : expr.callee.name
      : expr.callee.kind === "type_static_ref"
      ? `@${expr.callee.name}`
      : evaluatedCallee?.kind === "type"
      ? evaluatedCallee.name
      : undefined;
    if (!callee) {
      return this.unsupported("type.unsupported_expr", "type calls require a named callee");
    }
    const args = expr.args.map((arg) =>
      this.withSpan(this.eval(arg, locals) ?? { kind: "never" as const }, arg.span)
    );
    if (callee === "struct" || callee === "union") {
      return this.evalTypeBuilder(callee, expr.args, locals);
    }
    if (callee === "index") {
      return this.withSpan(
        this.namedType(`index(${args.map(renderTypeEvalValue).join(", ")})`),
        expr.span,
      );
    }
    if (callee && isStaticBuiltinName(callee, this.pluginRegistry) && !callee.startsWith("@")) {
      this.reportDiagnostic({
        code: "type.static_builtin_prefix",
        message: `static builtin ${callee} must be called as @${callee}`,
      });
      return { kind: "never" };
    }
    if (callee === "@compile_error") {
      const message = args[0]?.kind === "string" ? args[0].value : "compile-time error";
      this.reportDiagnostic({ code: "type.compile_error", message });
      return { kind: "never" };
    }
    const builtin = this.evalBuiltin(callee, args);
    if (builtin) return builtin;
    if (callee.startsWith("@")) {
      this.reportDiagnostic({
        code: "type.unknown_static_builtin",
        message: `unknown static builtin ${callee}`,
      });
      return { kind: "never" };
    }
    if (this.hostIoImports.has(callee)) {
      return this.unsupported(
        "type.runtime_effect_call",
        `cannot call imported host IO function ${callee} during type evaluation`,
      );
    }
    const fn = this.functions.get(callee);
    if (fn) return this.evalFunction(fn, args, locals, []);
    const decl = lookupTypeDecl(this.typesByName, callee);
    if (!decl) {
      return this.withSpan(
        this.namedType(`${callee}(${args.map(renderTypeEvalValue).join(", ")})`),
        expr.span,
      );
    }
    if (args.length < decl.params.length) {
      return this.withSpan(
        this.namedType(`${callee}(${args.map(renderTypeEvalValue).join(", ")})`),
        expr.span,
      );
    }
    return this.evalTypeFunction(decl.name, decl, args);
  }

  private evalTypeBuilder(
    callee: string,
    rawArgs: TypeExpr[],
    locals: Map<string, TypeEvalValue>,
  ): TypeEvalValue | undefined {
    const args = rawArgs.map((arg) => ({
      source: arg,
      value: this.withSpan(this.eval(arg, locals) ?? { kind: "never" as const }, arg.span),
    }));
    if (callee === "struct") {
      const arg = args[0];
      if (args.length !== 1) {
        return this.unsupported(
          "type.builder_arg",
          "struct(...) requires one type-block shape binding",
        );
      }
      const normalized = arg.value.kind === "type"
        ? arg.value.normalized
        : arg.value.kind === "shape"
        ? typeShapeValueToProduct(arg.value)
        : undefined;
      if (normalized?.kind !== "product") {
        return this.unsupported(
          "type.builder_arg",
          "struct(...) requires one type-block shape binding",
        );
      }
      return {
        kind: "type",
        name: `struct(${renderTypeExpr(arg.source)})`,
        normalized: { ...normalized, name: "struct", constructor: renderTypeExpr(arg.source) },
      };
    }
    if (
      !args.length ||
      args.some((arg) =>
        arg.source.kind !== "type_ref" ||
        (arg.value.kind !== "type" && arg.value.kind !== "shape")
      )
    ) {
      return this.unsupported("type.builder_arg", "union(...) requires type-block shape bindings");
    }
    return {
      kind: "type",
      name: `union(${args.map((arg) => renderTypeExpr(arg.source)).join(", ")})`,
      normalized: {
        kind: "sum",
        variants: args.map((arg) => {
          const shape = arg.value.kind === "type" && arg.value.normalized?.kind === "product"
            ? arg.value.normalized.shape
            : arg.value.kind === "shape"
            ? typeShapeValueToProduct(arg.value)?.shape
            : undefined;
          return {
            name: (arg.source as Extract<TypeExpr, { kind: "type_ref" }>).name,
            ...(shape?.slots.length ? { shape } : {}),
          };
        }),
      },
    };
  }

  private evalMembers(
    expr: Extract<TypeExpr, { kind: "type_members" }>,
    locals: Map<string, TypeEvalValue>,
  ): TypeEvalValue | undefined {
    if (!this.allowMembersResult) {
      this.reportDiagnostic({
        code: "type.members_context",
        message: "members(...) is only valid as a declaration tag expression result",
        span: expr.span,
      });
      return { kind: "never" };
    }
    const target = this.withSpan(this.eval(expr.target, locals), expr.target.span);
    if (target?.kind !== "type") {
      return this.unsupported(
        "type.members_target",
        "members(...) requires a target type",
        target?.span ?? expr.target.span,
      );
    }
    return {
      kind: "members",
      target: target.name,
      functions: expr.functions.map((fn) =>
        this.instantiateMemberFunction(fn, target.name, locals)
      ),
      span: expr.span,
    };
  }

  private instantiateMemberFunction(
    fn: FnDecl,
    target: string,
    locals: Map<string, TypeEvalValue>,
  ): FnDecl {
    if (fn.memberOf || fn.name.includes(".")) {
      this.reportDiagnostic({
        code: "type.members_member_name",
        message: "members blocks can generate simple attached member functions only",
        span: fn.nameSpan ?? fn.span,
      });
    }
    const owner = typeNameOf(target);
    const member = fn.memberOf?.member ?? terminalName(fn.name);
    return {
      ...fn,
      public: false,
      name: `${owner}::${member}`,
      memberOf: {
        owner,
        member,
        ...(fn.span ? { span: fn.span } : {}),
        ...(fn.nameSpan ? { nameSpan: fn.nameSpan } : {}),
      },
      params: fn.params.map((param) => ({
        ...param,
        type: substituteTypeSource(param.type, locals),
      })),
      returnType: fn.returnType ? substituteTypeSource(fn.returnType, locals) : undefined,
      body: substituteTypeEvalLocalsInBlock(fn.body, locals),
      generated: true,
    };
  }

  private selectTypeClause(decl: TypeDecl, args: TypeEvalValue[]): TypeDecl | undefined {
    for (const clause of decl.clauses ?? [decl]) {
      if (clause.params.length !== args.length) continue;
      let matched = true;
      for (let index = 0; index < clause.params.length; index++) {
        if (
          !typeParamPatternMatches(clause.paramPatterns?.[index], args[index] ?? { kind: "never" })
        ) {
          matched = false;
          break;
        }
      }
      if (matched) return clause;
    }
    return undefined;
  }

  private checkTypeArgKind(callee: string, param: TypeDecl["params"][number], arg: TypeEvalValue) {
    if (param.kind === "count" || param.kind === "const") return;
    if (!isTypeConstructorKind(param.kind)) return;
    if (arg.kind !== "type") {
      this.reportDiagnostic({
        code: "type.param_kind",
        message: `${callee} parameter ${param.name} expects a type constructor`,
        span: arg.span,
      });
      return;
    }
    const expectedArity = typeConstructorKindArity(param.kind);
    const baseName = arg.name.replace(/\(.*\)$/, "");
    const actual = this.typesByName.get(baseName);
    if (!actual || actual.params.length !== expectedArity) {
      this.reportDiagnostic({
        code: "type.param_kind",
        message:
          `${callee} parameter ${param.name} expects a ${expectedArity}-argument type constructor`,
        span: arg.span,
      });
      return;
    }
    if (
      !typeConstructorResultKindsCompatible(
        typeConstructorResultKind(param.kind),
        actual.resultKind,
      )
    ) {
      this.reportDiagnostic({
        code: "type.param_kind",
        message: `${callee} parameter ${param.name} expects a type constructor returning ${
          typeConstructorResultKind(param.kind)
        }`,
        span: arg.span,
      });
    }
  }

  private evalBuiltin(name: string, args: TypeEvalValue[]): TypeEvalValue | undefined {
    const pluginBuiltin = this.pluginRegistry.staticBuiltins.get(staticBuiltinName(name));
    const pluginArgs = args as unknown as TypePluginValue[];
    const pluginValue = pluginBuiltin?.evaluateType?.(pluginArgs, {
      addShader: this.addShader,
      report: (diagnostic) => this.diagnostics.push(diagnostic),
    });
    if (pluginValue) return pluginValue as TypeEvalValue;
    if (!name.startsWith("@")) return undefined;
    name = name.slice(1);
    if (name === "require") {
      const ok = args[0]?.kind === "bool" && args[0].value;
      if (!ok) {
        const message = args[1]?.kind === "string" ? args[1].value : "@require failed";
        this.reportDiagnostic({ code: "type.require", message });
      }
      return { kind: "bool", value: ok };
    }
    if (name === "wgsl_shader_id") {
      const source = args[0]?.kind === "string" ? args[0].value : undefined;
      if (source === undefined) return undefined;
      this.addShader(source);
      return { kind: "number", value: String(wgslShaderId(source)) };
    }
    if (name === "wgsl_bindings" || name === "wgsl_locations") {
      const source = args[0]?.kind === "string" ? args[0].value : undefined;
      if (source === undefined) return undefined;
      const entry = this.addShader(source);
      const count = name === "wgsl_bindings" ? entry.bindings.length : entry.locations.length;
      return this.namedType(`shader_${name.slice("wgsl_".length)}(${count})`);
    }
    if (name === "shape_map") return this.evalShapeMap(args);
    if (name === "shape_concat") return this.evalShapeConcat(args);
    if (name === "shape_has_slot") return this.evalShapeHasSlot(args);
    if (name === "shape_slot") return this.evalShapeSlot(args);
    if (name === "shape_count") return this.evalShapeCount(args);
    if (name === "shape_first_key") return this.evalShapeFirstKey(args);
    if (name === "shape_tail") return this.evalShapeTail(args);
    if (name === "shape_pick") return this.evalShapePick(args);
    if (name === "shape_omit") return this.evalShapeOmit(args);
    if (name === "shape_intersect") return this.evalShapeIntersect(args);
    if (name === "shape_difference") return this.evalShapeDifference(args);
    if (name === "shape_rename") return this.evalShapeRename(args);
    if (name === "shape_map_with_key") return this.evalShapeMapWithKey(args);
    if (name === "shape_filter") return this.evalShapeFilter(args);
    if (name === "type_list_contains") {
      const list = this.expectTypeList(args[0], "@type_list_contains");
      if (!list) return undefined;
      const item = args[1];
      return { kind: "bool", value: !!item && this.typeListIndex(list, item) >= 0 };
    }
    if (name === "type_list_contains_all") {
      const required = this.expectTypeList(args[0], "@type_list_contains_all");
      const available = this.expectTypeList(args[1], "@type_list_contains_all");
      if (!required || !available) return undefined;
      return {
        kind: "bool",
        value: required.slots.every((slot) => this.typeListIndex(available, slot.value) >= 0),
      };
    }
    if (name === "type_list_index") {
      const list = this.expectTypeList(args[0], "@type_list_index");
      if (!list) return undefined;
      const item = args[1];
      const index = item ? this.typeListIndex(list, item) : -1;
      if (index < 0) {
        this.reportDiagnostic({
          code: "type.list_member",
          message: `@type_list_index could not find ${
            item ? renderTypeEvalValue(item) : "<missing>"
          }`,
          span: item?.span ?? args[0]?.span,
        });
        return { kind: "never" };
      }
      return { kind: "number", value: String(index) };
    }
    if (name === "type_list_append") {
      const left = this.expectTypeList(args[0], "@type_list_append");
      const right = this.expectTypeList(args[1], "@type_list_append");
      if (!left || !right) return undefined;
      return { kind: "shape", slots: [...left.slots, ...right.slots] };
    }
    if (name === "type_list_remove") {
      const list = this.expectTypeList(args[0], "@type_list_remove");
      const item = args[1];
      if (!list || !item) return undefined;
      const itemKey = this.typeEvalKey(item);
      return {
        kind: "shape",
        slots: list.slots.filter((slot) => this.typeEvalKey(slot.value) !== itemKey),
      };
    }
    if (name === "type_list_unique") {
      const list = this.expectTypeList(args[0], "@type_list_unique");
      return list ? this.uniqueTypeList(list) : undefined;
    }
    if (name === "type_list_is_unique") {
      const list = this.expectTypeList(args[0], "@type_list_is_unique");
      return list
        ? { kind: "bool", value: this.uniqueTypeList(list).slots.length === list.slots.length }
        : undefined;
    }
    const domainBuiltin = evalTypeDomainBuiltin(
      name,
      args,
      [...this.typesByName.values()],
      (diagnostic) => {
        this.reportDiagnostic(diagnostic);
      },
    );
    if (domainBuiltin) return domainBuiltin;
    const originalType = args[0]?.kind === "type" ? args[0] : undefined;
    if (name === "type_has_member") {
      if (!originalType) return undefined;
      return { kind: "bool", value: !!this.typeMember(originalType, args[1]) };
    }
    if (name === "type_member_type") {
      if (!originalType) return undefined;
      const member = this.typeMember(originalType, args[1]);
      if (!member) {
        this.reportDiagnostic({
          code: "type.unknown_type_member",
          message: `unknown type member ${typeLiteralName(args[1]) ?? "<unknown>"}`,
          span: args[1]?.span ?? args[0]?.span,
        });
        return { kind: "never" };
      }
      return this.namedType(member.type);
    }
    if (name === "type_members") {
      if (!originalType) return undefined;
      return this.typeMembers(originalType);
    }
    if (name === "type_member_target") {
      if (!originalType) return undefined;
      const member = this.typeMember(originalType, args[1]);
      if (!member) {
        this.reportDiagnostic({
          code: "type.unknown_type_member",
          message: `unknown type member ${typeLiteralName(args[1]) ?? "<unknown>"}`,
          span: args[1]?.span ?? args[0]?.span,
        });
        return { kind: "never" };
      }
      return { kind: "string", value: member.target };
    }
    const type = originalType ? this.resolveTypeValue(originalType) : undefined;
    if (!type) return undefined;
    if (name === "type_is_product") {
      return { kind: "bool", value: type.normalized?.kind === "product" };
    }
    if (name === "type_is_sum") return { kind: "bool", value: type.normalized?.kind === "sum" };
    if (name === "type_is_alias") return { kind: "bool", value: type.normalized?.kind === "alias" };
    if (name === "type_is_number") return { kind: "bool", value: isNumericType(type.name) };
    if (name === "type_has_slot") {
      return { kind: "bool", value: !!this.typeProductSlot(type, args[1]) };
    }
    if (name === "type_slot_type") {
      const slot = this.typeProductSlot(type, args[1]);
      if (!slot) {
        this.reportDiagnostic({
          code: "type.unknown_type_slot",
          message: `unknown type slot ${typeLiteralName(args[1]) ?? "<unknown>"}`,
          span: args[1]?.span ?? args[0]?.span,
        });
        return { kind: "never" };
      }
      return this.namedType(slot.type);
    }
    const fn = parseFnSignatureDetailed(renderTypeEvalValue(args[0] ?? { kind: "never" }));
    if (name === "type_is_fn") return { kind: "bool", value: !!fn };
    if (name === "type_fn_params") return fn ? typeFnParamsValue(fn) : undefined;
    if (name === "type_fn_return") return fn ? this.namedType(fn.returnType) : undefined;
    if (name === "type_fn_param_count") {
      return fn ? { kind: "number", value: String(fn.params.length) } : undefined;
    }
    if (name === "type_is_scalar") return { kind: "bool", value: !!scalarReflection(type.name) };
    if (name === "type_is_refined_scalar") {
      return { kind: "bool", value: !!parseRefinedI32Type(type.name) };
    }
    const scalar = scalarReflection(type.name);
    if (name === "type_scalar_carrier") {
      return scalar ? { kind: "literal", value: scalar.carrier } : undefined;
    }
    if (name === "type_scalar_min") {
      return scalar?.min !== undefined ? { kind: "number", value: String(scalar.min) } : undefined;
    }
    if (name === "type_scalar_max") {
      return scalar?.max !== undefined ? { kind: "number", value: String(scalar.max) } : undefined;
    }
    if (name === "type_scalar_bit_width") {
      return scalar?.bitWidth !== undefined
        ? { kind: "number", value: String(scalar.bitWidth) }
        : undefined;
    }
    if (name === "type_scalar_signed") {
      return scalar ? { kind: "bool", value: scalar.signed } : undefined;
    }
    if (name === "type_scalar_domain") {
      return scalar ? scalarDomainTypeValue(scalar) : undefined;
    }
    if (name === "type_is_inline_array") {
      return {
        kind: "bool",
        value: !!inlineArrayLikeTypeArgs(type.name, [...this.typesByName.values()]),
      };
    }
    if (name === "type_inline_array_len") {
      const array = inlineArrayLikeTypeArgs(type.name, [...this.typesByName.values()]);
      return array ? { kind: "number", value: String(array.count) } : undefined;
    }
    if (name === "type_inline_array_item") {
      const array = inlineArrayLikeTypeArgs(type.name, [...this.typesByName.values()]);
      return array ? this.namedType(array.itemType) : undefined;
    }
    if (name === "type_storage_kind") {
      return typeStorageKindValue(type, [...this.typesByName.values()]);
    }
    if (name === "type_layout") return typeLayoutValue(type, [...this.typesByName.values()]);
    if (name === "type_flat_slot_count") {
      return {
        kind: "number",
        value: String(flatTypeSlots(type.name, [...this.typesByName.values()]).length),
      };
    }
    if (name === "type_flat_slots") {
      return typeFlatSlotsValue(type.name, [...this.typesByName.values()]);
    }
    if (name === "type_size_bits") {
      const bits = typeSizeBits(type.name, [...this.typesByName.values()]);
      return bits === undefined ? undefined : { kind: "number", value: String(bits) };
    }
    if (name === "type_align_bits") {
      const bits = typeAlignBits(type.name, [...this.typesByName.values()]);
      return bits === undefined ? undefined : { kind: "number", value: String(bits) };
    }
    if (name === "type_has_variant") {
      const variant = typeLiteralName(args[1]);
      return {
        kind: "bool",
        value: type.normalized?.kind === "sum" &&
          !!type.normalized.variants.find((item) => item.name === variant),
      };
    }
    if (name === "type_variant_has_slot") {
      const variant = typeLiteralName(args[1]);
      const slot = typeLiteralName(args[2]);
      const found = type.normalized?.kind === "sum"
        ? type.normalized.variants.find((item) => item.name === variant)
        : undefined;
      return { kind: "bool", value: !!found?.shape?.slots.find((item) => item.label === slot) };
    }
    if (name === "type_variant_count") {
      return {
        kind: "number",
        value: String(type.normalized?.kind === "sum" ? type.normalized.variants.length : 0),
      };
    }
    if (name === "type_variant_tag_type") {
      const count = type.normalized?.kind === "sum" ? type.normalized.variants.length : 0;
      return count <= 1 ? this.namedType("u1") : this.namedType(`u${Math.ceil(Math.log2(count))}`);
    }
    if (name === "type_variant_payload_type") {
      const variantName = typeLiteralName(args[1]);
      const variant = type.normalized?.kind === "sum"
        ? type.normalized.variants.find((item) => item.name === variantName)
        : undefined;
      if (!variant) return undefined;
      return this.namedType(variantPayloadType(variant));
    }
    if (name === "type_has_niche") return { kind: "bool", value: false };
    if (name === "type_niche_value") return undefined;
    if (name === "type_slots") return this.typeSlots(type);
    if (name === "type_slot_count") {
      return {
        kind: "number",
        value: String(type.normalized?.kind === "product" ? type.normalized.shape.slots.length : 0),
      };
    }
    if (name === "type_variant_slots") return this.typeVariantSlots(type, args[1]);
    if (name === "type_variants") return this.typeVariants(type);
    return undefined;
  }

  private evalFunction(
    fn: FnDecl,
    args: TypeEvalValue[],
    _locals: Map<string, TypeEvalValue>,
    callStack: string[],
  ): TypeEvalValue | undefined {
    if (callStack.includes(fn.name)) {
      return this.unsupported(
        "type.unsupported_expr",
        `recursive type helper call ${[...callStack, fn.name].join(" -> ")}`,
      );
    }
    const fnLocals = new Map<string, TypeEvalValue>();
    fn.params.forEach((param, index) => {
      const value = args[index] ?? { kind: "never" as const };
      fnLocals.set(param.name, value);
      if (param.pattern?.kind === "constructor" && param.pattern.args.length === 0) {
        fnLocals.set(param.pattern.name, value);
      }
      if (value.kind === "type") fnLocals.set(param.type, value);
    });
    return this.evalStaticBlock(fn.body, fnLocals, [...callStack, fn.name]);
  }

  private evalStaticExpr(
    expr: Expr,
    locals: Map<string, TypeEvalValue>,
    callStack: string[],
  ): TypeEvalValue | undefined {
    switch (expr.kind) {
      case "literal":
        if (expr.literalKind === "bool") return { kind: "bool", value: expr.value === "true" };
        if (expr.literalKind === "number") return { kind: "number", value: expr.value };
        if (expr.literalKind === "string") {
          return { kind: "string", value: decodeStringLiteralValue(expr.value) };
        }
        if (expr.literalKind === "multiline") return { kind: "string", value: expr.value };
        if (expr.literalKind === "char") {
          return { kind: "char", value: JSON.parse(`"${expr.value.slice(1, -1)}"`) };
        }
        if (expr.literalKind === "literalType") {
          return { kind: "literal", value: expr.value.slice(1) };
        }
        return this.unsupported("type.unsupported_expr", "unsupported literal in type evaluation");
      case "var":
        return this.evalRef(expr.name, locals);
      case "call": {
        if (expr.callee.kind !== "var") {
          return this.unsupported(
            "type.unsupported_expr",
            "type helper calls require a named callee",
          );
        }
        const name = expr.callee.name;
        const args = expr.args.map((arg) =>
          this.withSpan(
            this.evalStaticExpr(arg, locals, callStack) ?? { kind: "never" as const },
            arg.span,
          )
        );
        if (isStaticBuiltinName(name, this.pluginRegistry) && !name.startsWith("@")) {
          this.reportDiagnostic({
            code: "type.static_builtin_prefix",
            message: `static builtin ${name} must be called as @${name}`,
          });
          return { kind: "never" };
        }
        if (name === "@compile_error") {
          const message = args[0]?.kind === "string" ? args[0].value : "compile-time error";
          this.reportDiagnostic({ code: "type.compile_error", message });
          return { kind: "never" };
        }
        const builtin = this.evalBuiltin(name, args);
        if (builtin) return builtin;
        if (name.startsWith("@")) {
          this.reportDiagnostic({
            code: "type.unknown_static_builtin",
            message: `unknown static builtin ${name}`,
          });
          return { kind: "never" };
        }
        if (this.hostIoImports.has(name)) {
          return this.unsupported(
            "type.runtime_effect_call",
            `cannot call imported host IO function ${name} during type evaluation`,
          );
        }
        const fn = this.functions.get(name);
        if (!fn) return this.unsupported("type.unsupported_expr", `unknown type helper ${name}`);
        return this.evalFunction(fn, args, locals, callStack);
      }
      case "binary": {
        const left = this.evalStaticExpr(expr.left, locals, callStack);
        const right = this.evalStaticExpr(expr.right, locals, callStack);
        if (!left || !right) return undefined;
        if (expr.op === "==" || expr.op === "!=") {
          const leftKey = this.typeEvalKey(left);
          const rightKey = this.typeEvalKey(right);
          const equal = leftKey === rightKey;
          return { kind: "bool", value: expr.op === "==" ? equal : !equal };
        }
        return this.unsupported(
          "type.unsupported_expr",
          `operator ${expr.op} is not type-evaluable`,
        );
      }
      case "operator_chain":
        return this.evalStaticExpr(
          buildOperatorTree(
            [expr.first, ...expr.rest.map((item) => item.value)],
            expr.rest.map((item) => item.op),
            EMPTY_OPERATOR_MAP,
            this.diagnostics,
            expr,
          ),
          locals,
          callStack,
        );
      case "pipe_bind": {
        const value = this.evalStaticExpr(expr.value, locals, callStack);
        if (!value) return undefined;
        return this.evalStaticExpr(expr.body, new Map(locals).set(expr.name, value), callStack);
      }
      case "block":
        return this.evalStaticBlock(expr, new Map(locals), callStack);
      case "match": {
        const value = this.evalStaticExpr(expr.value, locals, callStack);
        if (!value) return undefined;
        const arm = expr.arms.find((arm) => typeExprPatternMatches(arm.pattern, value));
        if (!arm) {
          return this.unsupported("type.unsupported_expr", "type helper match has no matching arm");
        }
        return this.evalStaticExpr(arm.value, new Map(locals), callStack);
      }
      case "shape":
        return {
          kind: "shape",
          slots: expr.slots.map((slot) => ({
            label: slot.label,
            value: this.withSpan(
              this.evalStaticExpr(slot.value, locals, callStack) ?? { kind: "never" },
              slot.value.span,
            ),
          })),
        };
      case "product_constructor":
      case "range":
        return this.unsupported("type.unsupported_expr", `${expr.kind} is not type-evaluable`);
    }
  }

  private evalStaticBlock(
    block: Extract<Expr, { kind: "block" }>,
    locals: Map<string, TypeEvalValue>,
    callStack: string[],
  ): TypeEvalValue | undefined {
    if (block.statements.some((stmt) => stmt.kind !== "let" && stmt.kind !== "type_assert")) {
      return this.unsupported("type.unsupported_expr", "unsupported type block statement");
    }
    const ordered = orderBlockStatements(block.statements, this.diagnostics);
    for (const stmt of ordered) {
      if (stmt.kind === "let") {
        const value = this.withSpan(
          this.evalStaticExpr(stmt.value, locals, callStack),
          stmt.value.span,
        );
        if (!value) return undefined;
        locals.set(stmt.name, value);
      }
    }
    return block.expr ? this.evalStaticExpr(block.expr, locals, callStack) : undefined;
  }

  private namedType(name: string): Extract<TypeEvalValue, { kind: "type" }> {
    const normalized = this.typesByName.get(name)?.normalized ??
      this.typesByName.get(terminalName(name))?.normalized;
    return { kind: "type", name, normalized };
  }

  private evalRef(name: string, locals: Map<string, TypeEvalValue>): TypeEvalValue {
    const direct = locals.get(name);
    if (direct) return direct;
    const constValue = this.consts.get(name);
    if (constValue) return this.constToEval(constValue);
    const dot = name.lastIndexOf(".");
    if (dot >= 0) {
      const base = this.evalRef(name.slice(0, dot), locals);
      const field = name.slice(dot + 1);
      if (base.kind === "shape") {
        const slot = base.slots.find((item) => item.label === field);
        if (slot) return slot.value;
      }
      if (base.kind === "type") return this.namedType(`${base.name}.${field}`);
    }
    return this.namedType(name);
  }

  private constToEval(value: ConstValue): TypeEvalValue {
    switch (value.kind) {
      case "bool":
        return { kind: "bool", value: value.value };
      case "number":
        return { kind: "number", value: value.value };
      case "char":
        return { kind: "char", value: value.value };
      case "string":
        return { kind: "string", value: value.value };
      case "literal_type":
        return { kind: "literal", value: value.value };
      case "type":
        return { kind: "type", name: value.name, normalized: value.normalized };
      case "fn": {
        const decl = this.typesByName.get(value.name);
        if (decl?.params.length === 0) {
          return this.evalTypeFunction(value.name, decl, []) ?? { kind: "never" };
        }
        return { kind: "never" };
      }
      case "shape":
        return {
          kind: "shape",
          slots: value.slots.map((slot) => ({
            label: slot.label,
            value: this.constToEval(slot.value),
          })),
        };
      default:
        return { kind: "never" };
    }
  }

  private evalShapeMap(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = args[0];
    const mapper = args[1];
    if (shape?.kind !== "shape" || mapper?.kind !== "type") {
      if (shape?.kind === "type" || shape?.kind === "never") return { kind: "shape", slots: [] };
      return this.unsupported(
        "type.shape_map",
        "@shape_map requires a shape and mapper type fn",
        shape?.span ?? mapper?.span,
      );
    }
    const mapperCall = mapper.name.match(/^(.+)\((.*)\)$/);
    const mapperName = mapperCall ? mapperCall[1]!.trim() : mapper.name;
    const mapperArgs = mapperCall
      ? splitTypeArgs(mapperCall[2]!).map((arg) => {
        const parsed = parseAnnotationType(arg);
        return parsed ? this.eval(parsed, new Map()) ?? { kind: "never" as const } : {
          kind: "never" as const,
        };
      })
      : [];
    const decl = this.typesByName.get(mapperName);
    if (!decl || decl.params.length !== mapperArgs.length + 1) {
      return this.unsupported(
        "type.shape_map",
        "@shape_map mapper must be a one-argument type fn",
        mapper.span,
      );
    }
    return {
      kind: "shape",
      slots: shape.slots.map((slot, index) => {
        if (!slot.label) {
          this.reportDiagnostic({
            code: "type.shape_map_unlabeled",
            message: `@shape_map input slot ${index} must be labeled`,
          });
        }
        const mapped = this.evalTypeFunction(mapperName, decl, [...mapperArgs, slot.value]);
        return { label: slot.label, value: mapped ?? { kind: "never" } };
      }),
    };
  }

  private evalTypeFunction(
    callee: string,
    decl: TypeDecl,
    args: TypeEvalValue[],
  ): TypeEvalValue | undefined {
    const selected = this.selectTypeClause(decl, args);
    if (!selected) {
      this.reportDiagnostic({
        code: "type.no_matching_clause",
        message: `type function ${callee} has no matching clause`,
      });
      return { kind: "never" };
    }
    selected.params.forEach((param, index) => {
      this.checkTypeArgKind(callee, param, args[index] ?? { kind: "never" });
    });
    const fnLocals = new Map<string, TypeEvalValue>();
    selected.params.forEach((param, index) => {
      bindTypeParamPattern(
        selected.paramPatterns?.[index],
        param.name,
        args[index] ?? { kind: "never" },
        fnLocals,
      );
    });
    for (const stmt of selected.body.statements) {
      const value = this.withSpan(this.eval(stmt.value, fnLocals), stmt.value.span);
      if (!value) return undefined;
      fnLocals.set(stmt.name, value);
    }
    if (!selected.body.expr) {
      return {
        kind: "type",
        name: `${callee}(${args.map(renderTypeEvalValue).join(", ")})`,
        normalized: selected.normalized ?? decl.normalized,
      };
    }
    const result = this.eval(selected.body.expr, fnLocals);
    if (selected.resultKind === "members") {
      if (result?.kind !== "members") {
        this.reportDiagnostic({
          code: "type.result_kind",
          message: `type function ${selected.name} declares -> members but does not return members`,
        });
      }
      return result;
    }
    if (result?.kind === "members") {
      this.reportDiagnostic({
        code: "type.result_kind",
        message:
          `type function ${selected.name} returns members but declares -> ${selected.resultKind}`,
      });
      return result;
    }
    if (result?.kind === "type") {
      const normalized = result.normalized
        ? substituteTypeBodyEval(this.withTypeDeclMembers(result.normalized, selected), fnLocals)
        : result.normalized;
      checkTypeResultKind(selected, normalized, this.diagnostics);
      return {
        ...result,
        normalized,
        name: `${callee}(${args.map(renderTypeEvalValue).join(", ")})`,
      };
    }
    const literalMembers = result ? literalTypeMembersFromTypeResult(result) : undefined;
    if (selected.resultKind === "type" && literalMembers) {
      return {
        kind: "type",
        name: `${callee}(${args.map(renderTypeEvalValue).join(", ")})`,
        normalized: { kind: "alias", type: renderLiteralUnionType(literalMembers) },
      };
    }
    return result;
  }

  private evalShapeConcat(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const slots: { label?: string; value: TypeEvalValue }[] = [];
    const seen = new Set<string>();
    for (const [shapeIndex, arg] of args.entries()) {
      if (arg.kind !== "shape") {
        if (arg.kind === "never" || arg.kind === "type") continue;
        return this.unsupported("type.shape_concat", "@shape_concat requires shape arguments");
      }
      for (const slot of arg.slots) {
        if (slot.label && seen.has(slot.label)) {
          this.reportDiagnostic({
            code: "type.shape_concat_duplicate",
            message: `@shape_concat defines duplicate field ${slot.label}`,
          });
        }
        if (slot.label) seen.add(slot.label);
        else if (shapeIndex > 0) {
          this.reportDiagnostic({
            code: "type.shape_concat_unlabeled",
            message: "@shape_concat generated fields must be labeled",
          });
        }
        slots.push(slot);
      }
    }
    return { kind: "shape", slots };
  }

  private evalShapeHasSlot(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_has_slot");
    const label = typeLiteralName(args[1]);
    if (!shape || label === undefined) return undefined;
    return { kind: "bool", value: !!shape.slots.find((slot) => slot.label === label) };
  }

  private evalShapeFirstKey(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_first_key");
    if (!shape) return undefined;
    const first = shape.slots[0];
    if (!first?.label) {
      this.reportDiagnostic({
        code: "type.shape_empty",
        message: "@shape_first_key requires a non-empty labeled shape",
        span: shape.span,
      });
      return { kind: "never" };
    }
    return { kind: "literal", value: first.label };
  }

  private evalShapeTail(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_tail");
    if (!shape) return undefined;
    if (!shape.slots.length) {
      this.reportDiagnostic({
        code: "type.shape_empty",
        message: "@shape_tail requires a non-empty shape",
        span: shape.span,
      });
      return { kind: "never" };
    }
    return { kind: "shape", slots: shape.slots.slice(1) };
  }

  private evalShapeSlot(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_slot");
    const label = typeLiteralName(args[1]);
    if (!shape || label === undefined) return undefined;
    const slot = shape.slots.find((slot) => slot.label === label);
    if (!slot) {
      this.reportDiagnostic({
        code: "type.unknown_shape_slot",
        message: `unknown shape slot ${label}`,
        span: args[1]?.span ?? shape.span,
      });
      return { kind: "never" };
    }
    return slot.value;
  }

  private evalShapeCount(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_count");
    if (!shape) return undefined;
    return { kind: "number", value: String(shape.slots.length) };
  }

  private evalShapePick(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_pick");
    const labels = this.selectorLabels(args[1], "@shape_pick");
    if (!shape || !labels) return undefined;
    return {
      kind: "shape",
      slots: shape.slots.filter((slot) => slot.label && labels.has(slot.label)),
    };
  }

  private evalShapeOmit(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_omit");
    const labels = this.selectorLabels(args[1], "@shape_omit");
    if (!shape || !labels) return undefined;
    return {
      kind: "shape",
      slots: shape.slots.filter((slot) => !slot.label || !labels.has(slot.label)),
    };
  }

  private evalShapeIntersect(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_intersect");
    const labels = this.selectorLabels(args[1], "@shape_intersect");
    if (!shape || !labels) return undefined;
    return {
      kind: "shape",
      slots: shape.slots.filter((slot) => slot.label && labels.has(slot.label)),
    };
  }

  private evalShapeDifference(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_difference");
    const labels = this.selectorLabels(args[1], "@shape_difference");
    if (!shape || !labels) return undefined;
    return {
      kind: "shape",
      slots: shape.slots.filter((slot) => !slot.label || !labels.has(slot.label)),
    };
  }

  private evalShapeRename(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_rename");
    const renames = this.expectShape(args[1], "@shape_rename");
    if (!shape || !renames) return undefined;
    const renameByOld = new Map<string, string>();
    for (const slot of renames.slots) {
      const next = typeLiteralName(slot.value);
      if (!slot.label || next === undefined) {
        return this.unsupported(
          "type.shape_builtin_arg",
          "@shape_rename renames must be labeled literal or string values",
          args[1]?.span,
        );
      }
      renameByOld.set(slot.label, next);
    }
    const result = shape.slots.map((slot) => ({
      ...slot,
      label: slot.label ? renameByOld.get(slot.label) ?? slot.label : slot.label,
    }));
    const seen = new Set<string>();
    for (const slot of result) {
      if (!slot.label) continue;
      if (seen.has(slot.label)) {
        this.reportDiagnostic({
          code: "type.shape_rename_duplicate",
          message: `@shape_rename defines duplicate field ${slot.label}`,
          span: args[1]?.span ?? shape.span,
        });
        return { kind: "never" };
      }
      seen.add(slot.label);
    }
    return { kind: "shape", slots: result };
  }

  private evalShapeMapWithKey(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_map_with_key");
    const mapper = args[1];
    if (!shape || mapper?.kind !== "type") {
      return this.unsupported(
        "type.shape_map_with_key",
        "@shape_map_with_key requires a shape and mapper type fn",
        shape?.span ?? mapper?.span,
      );
    }
    const decl = this.typeFunctionDecl(
      mapper.name,
      2,
      "@shape_map_with_key",
      "type.shape_map_with_key",
      mapper.span,
    );
    if (!decl) return undefined;
    return {
      kind: "shape",
      slots: shape.slots.map((slot) => ({
        label: slot.label,
        value: this.evalTypeFunction(mapper.name.replace(/\(.*\)$/, ""), decl, [
          { kind: "literal", value: slot.label ?? "" },
          slot.value,
        ]) ?? { kind: "never" },
      })),
    };
  }

  private evalShapeFilter(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_filter");
    const predicate = args[1];
    if (!shape || predicate?.kind !== "type") {
      return this.unsupported(
        "type.shape_filter",
        "@shape_filter requires a shape and predicate type fn",
        shape?.span ?? predicate?.span,
      );
    }
    const decl = this.typeFunctionDecl(
      predicate.name,
      2,
      "@shape_filter",
      "type.shape_filter",
      predicate.span,
    );
    if (!decl) return undefined;
    const name = predicate.name.replace(/\(.*\)$/, "");
    const slots = [];
    for (const slot of shape.slots) {
      const keep = this.evalTypeFunction(name, decl, [
        { kind: "literal", value: slot.label ?? "" },
        slot.value,
      ]);
      if (keep?.kind !== "bool") {
        this.reportDiagnostic({
          code: "type.shape_filter",
          message: "@shape_filter predicate must return bool",
          span: predicate.span,
        });
        return { kind: "never" };
      }
      if (keep.value) slots.push(slot);
    }
    return { kind: "shape", slots };
  }

  private expectShape(
    value: TypeEvalValue | undefined,
    builtin: string,
  ): Extract<TypeEvalValue, { kind: "shape" }> | undefined {
    if (value?.kind === "shape") return value;
    if (value?.kind === "never") return undefined;
    return this.unsupported(
      "type.shape_builtin_arg",
      `${builtin} requires a shape argument`,
      value?.span,
    );
  }

  private expectTypeList(
    value: TypeEvalValue | undefined,
    builtin: string,
  ): Extract<TypeEvalValue, { kind: "shape" }> | undefined {
    const shape = this.expectShape(value, builtin);
    if (!shape) return undefined;
    const invalid = shape.slots.find((slot) => slot.label || slot.repeat);
    if (invalid) {
      return this.unsupported(
        "type.list_builtin_arg",
        `${builtin} type list items must be unlabeled and non-repeated`,
        shape.span,
      );
    }
    return shape;
  }

  private typeListIndex(
    list: Extract<TypeEvalValue, { kind: "shape" }>,
    item: TypeEvalValue,
  ): number {
    const itemKey = this.typeEvalKey(item);
    return list.slots.findIndex((slot) => this.typeEvalKey(slot.value) === itemKey);
  }

  private uniqueTypeList(
    list: Extract<TypeEvalValue, { kind: "shape" }>,
  ): Extract<TypeEvalValue, { kind: "shape" }> {
    const seen = new Set<string>();
    const slots: Extract<TypeEvalValue, { kind: "shape" }>["slots"] = [];
    for (const slot of list.slots) {
      const key = this.typeEvalKey(slot.value);
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(slot);
    }
    return { kind: "shape", slots };
  }

  private selectorLabels(
    value: TypeEvalValue | undefined,
    builtin: string,
  ): Set<string> | undefined {
    const shape = this.expectShape(value, builtin);
    if (!shape) return undefined;
    const labels = new Set<string>();
    for (const slot of shape.slots) {
      if (!slot.label) {
        return this.unsupported(
          "type.shape_builtin_arg",
          `${builtin} selector slots must be labeled`,
          shape.span,
        );
      }
      labels.add(slot.label);
    }
    return labels;
  }

  private typeFunctionDecl(
    name: string,
    arity: number,
    builtin: string,
    code: string,
    span?: Span,
  ): TypeDecl | undefined {
    const mapperName = name.replace(/\(.*\)$/, "");
    const decl = this.typesByName.get(mapperName);
    if (!decl || decl.params.length !== arity) {
      this.reportDiagnostic({
        code,
        message: `${builtin} callback must be a ${arity}-argument type fn`,
        span,
      });
      return undefined;
    }
    return decl;
  }

  private typeSlots(type: TypeEvalValue): TypeEvalValue {
    if (type.kind === "type") type = this.resolveTypeValue(type);
    if (type.kind === "shape") return type;
    if (type.kind !== "type" || type.normalized?.kind !== "product") {
      return { kind: "shape", slots: [] };
    }
    return {
      kind: "shape",
      slots: type.normalized.shape.slots.map((slot) => ({
        label: slot.label,
        repeat: slot.repeat,
        value: this.namedType(slot.type),
      })),
    };
  }

  private typeVariantSlots(
    type: TypeEvalValue,
    variantValue: TypeEvalValue | undefined,
  ): TypeEvalValue {
    if (type.kind === "type") type = this.resolveTypeValue(type);
    const variantName = typeLiteralName(variantValue);
    const variant = type.kind === "type" && type.normalized?.kind === "sum"
      ? type.normalized.variants.find((item) => item.name === variantName)
      : undefined;
    if (!variant) {
      this.reportDiagnostic({
        code: "type.unknown_type_variant",
        message: `unknown type variant ${variantName ?? "<unknown>"}`,
        span: variantValue?.span ?? type.span,
      });
      return { kind: "never" };
    }
    return {
      kind: "shape",
      slots: variant.shape?.slots.map((slot) => ({
        label: slot.label,
        repeat: slot.repeat,
        value: this.namedType(slot.type),
      })) ?? [],
    };
  }

  private typeVariants(type: TypeEvalValue): TypeEvalValue {
    if (type.kind === "type") type = this.resolveTypeValue(type);
    if (type.kind !== "type" || type.normalized?.kind !== "sum") {
      return { kind: "shape", slots: [] };
    }
    return {
      kind: "shape",
      slots: type.normalized.variants.map((variant) => ({
        label: variant.name,
        value: {
          kind: "shape",
          slots: variant.shape?.slots.map((slot) => ({
            label: slot.label,
            repeat: slot.repeat,
            value: this.namedType(slot.type),
          })) ?? [],
        },
      })),
    };
  }

  private typeMembers(type: TypeEvalValue): TypeEvalValue {
    if (type.kind === "type") type = this.resolveTypeValue(type);
    if (type.kind !== "type") return { kind: "shape", slots: [] };
    const normalized = type.normalized;
    const members = normalized?.kind === "product" || normalized?.kind === "sum"
      ? normalized.members ?? []
      : [];
    const decl = lookupTypeDecl(this.typesByName, typeNameOf(type.name));
    const bindings = decl ? genericBindings(type.name, decl) : new Map<string, string>();
    const explicit = members.map((member) => ({
      ...member,
      type: substituteTypeVars(member.type, bindings),
    }));
    const explicitNames = new Set(explicit.map((member) => member.name));
    const functionMembers = this.functionTypeMembers(type.name)
      .filter((member) => !explicitNames.has(member.name));
    const withDerivedEmpty = typeHasDerivedEmpty(type) &&
        !explicitNames.has("empty") &&
        !functionMembers.some((member) => member.name === "empty")
      ? [...explicit, ...functionMembers, {
        name: "empty",
        type: `fn() -> ${type.name}`,
        target: `${type.name}::empty`,
      }]
      : [...explicit, ...functionMembers];
    return {
      kind: "shape",
      slots: withDerivedEmpty.map((member) => ({
        label: member.name,
        value: memberMetadataTypeValue(member),
      })),
    };
  }

  resolve(value: TypeEvalValue): TypeEvalValue {
    return value.kind === "type" ? this.resolveTypeValue(value) : value;
  }

  private unsupported(code: string, message: string, span?: Span): undefined {
    this.reportDiagnostic({ code, message, span });
    return undefined;
  }

  private reportDiagnostic(diagnostic: Diagnostic) {
    this.diagnostics.push({
      ...diagnostic,
      span: diagnostic.span ?? this.diagnosticSpan,
    });
  }

  private withSpan<t extends TypeEvalValue | undefined>(value: t, span?: Span): t {
    if (!value || value.span || !span) return value;
    return { ...value, span } as t;
  }

  private withTypeDeclMembers(body: TypeBody, decl: TypeDecl): TypeBody {
    if (body.kind !== "product" && body.kind !== "sum") return body;
    const members = decl.normalized?.kind === body.kind ? decl.normalized.members : undefined;
    return members?.length ? { ...body, members } : body;
  }

  private typeProductSlot(type: TypeEvalValue, name: TypeEvalValue | undefined) {
    const slotName = typeLiteralName(name);
    if (type.kind !== "type") return undefined;
    type = this.resolveTypeValue(type);
    if (type.normalized?.kind !== "product") return undefined;
    return type.normalized.shape.slots.find((slot) => slot.label === slotName);
  }

  private typeMember(type: TypeEvalValue, name: TypeEvalValue | undefined) {
    const memberName = typeLiteralName(name);
    if (type.kind !== "type") return undefined;
    const ownerName = typeNameOf(type.name);
    const directDecl = lookupTypeDecl(this.typesByName, ownerName);
    const declared = directDecl
      ? typeFragmentMembers(directDecl).find((member) => member.name === memberName)
      : undefined;
    if (declared && directDecl) {
      const bindings = genericBindings(type.name, directDecl);
      return { ...declared, type: substituteTypeVars(declared.type, bindings) };
    }
    type = this.resolveTypeValue(type);
    if (type.normalized?.kind === "product" || type.normalized?.kind === "sum") {
      const member = type.normalized.members?.find((member) => member.name === memberName);
      if (member) {
        const decl = lookupTypeDecl(this.typesByName, typeNameOf(type.name));
        const bindings = decl ? genericBindings(type.name, decl) : new Map<string, string>();
        return { ...member, type: substituteTypeVars(member.type, bindings) };
      }
    }
    const functionMember = this.functionTypeMember(type.name, memberName);
    if (functionMember) return functionMember;
    if (memberName === "empty" && typeHasDerivedEmpty(type)) {
      return {
        name: "empty",
        type: `fn() -> ${type.name}`,
        target: `${type.name}::empty`,
      };
    }
    return undefined;
  }

  private functionTypeMembers(typeName: string) {
    const members: TypeMember[] = [];
    const seen = new Set<string>();
    const carrierOwner = primitiveMemberOwnerTypeName(typeName);
    const genericOwner = typeNameOf(typeName);
    for (const fn of this.functions.values()) {
      if (!fn.memberOf) continue;
      const matchesExactOwner = fn.memberOf.owner === typeName;
      const matchesGenericOwner = genericOwner !== typeName && fn.memberOf.owner === genericOwner;
      const matchesCarrierOwner = carrierOwner !== typeName && fn.memberOf.owner === carrierOwner;
      if (!matchesExactOwner && !matchesGenericOwner && !matchesCarrierOwner) continue;
      if (seen.has(fn.memberOf.member)) continue;
      seen.add(fn.memberOf.member);
      let type = renderFnType(fn);
      if (matchesCarrierOwner) type = renderFnTypeForMemberOwner(fn, typeName);
      members.push({
        ...(fn.doc ? { doc: fn.doc } : {}),
        name: fn.memberOf.member,
        type,
        target: fn.name,
      });
    }
    return members;
  }

  private functionTypeMember(typeName: string, memberName: string | undefined) {
    if (!memberName) return undefined;
    return this.functionTypeMembers(typeName).find((member) => member.name === memberName);
  }

  private resolveTypeValue(
    type: Extract<TypeEvalValue, { kind: "type" }>,
    seen = new Set<string>(),
  ): Extract<TypeEvalValue, { kind: "type" }> {
    if (seen.has(type.name)) return type;
    seen.add(type.name);
    if (type.normalized) {
      const decl = this.typesByName.get(typeNameOf(type.name));
      if (!(type.normalized.kind === "alias" && (decl?.body.statements.length ?? 0) > 0)) {
        return type;
      }
    }

    const call = type.name.match(/^(.+)\((.*)\)$/);
    if (call) {
      const base = call[1].trim();
      const directDecl = this.typesByName.get(base);
      const decl = directDecl ?? this.typesByName.get(terminalName(base));
      if (decl) {
        const args = splitTypeArgs(call[2]).map((arg) => {
          const parsed = parseAnnotationType(arg);
          return parsed ? this.eval(parsed, new Map()) ?? { kind: "never" as const } : {
            kind: "never" as const,
          };
        });
        if (
          decl.normalized?.kind === "alias" && decl.params.every((param) => param.kind !== "const")
        ) {
          if (decl.body.statements.length > 0) {
            const called = this.selectTypeClause(decl, args)
              ? this.evalTypeFunction(directDecl ? base : decl.name, decl, args)
              : undefined;
            if (called?.kind === "type" && called.normalized) {
              return this.resolveTypeValue(called, seen);
            }
          }
          const aliased = substituteAliasTypeParams(
            decl.normalized.type,
            decl,
            args.map(renderTypeEvalValue),
          );
          return this.resolveTypeValue(this.namedType(aliased), seen);
        }
        const called = this.selectTypeClause(decl, args)
          ? this.evalTypeFunction(directDecl ? base : decl.name, decl, args)
          : undefined;
        if (called?.kind === "type") {
          if (called.name !== type.name) return this.resolveTypeValue(called, seen);
          if (called.normalized) type = called;
        }
      }
    }

    const expr = parseAnnotationType(type.name);
    if (expr) {
      const expanded = this.eval(expr, new Map());
      if (expanded?.kind === "type") {
        if (expanded.name !== type.name) return this.resolveTypeValue(expanded, seen);
        if (expanded.normalized && !type.normalized) type = expanded;
      }
      if (expr.kind === "type_call" && expr.callee.kind === "type_ref") {
        const directDecl = this.typesByName.get(expr.callee.name);
        const decl = directDecl ?? this.typesByName.get(terminalName(expr.callee.name));
        if (decl) {
          const args = expr.args.map((arg) =>
            this.eval(arg, new Map()) ?? { kind: "never" as const }
          );
          const called = this.selectTypeClause(decl, args)
            ? this.evalTypeFunction(directDecl ? expr.callee.name : decl.name, decl, args)
            : undefined;
          if (called?.kind === "type") {
            if (called.name !== type.name) return this.resolveTypeValue(called, seen);
            if (called.normalized && !type.normalized) type = called;
          }
        }
      }
    }

    const decl = this.typesByName.get(type.name);
    if (decl && decl.params.length === 0 && decl.body.expr) {
      const expanded = this.evalTypeFunction(type.name, decl, []);
      if (expanded?.kind === "type") {
        if (expanded.name !== type.name) return this.resolveTypeValue(expanded, seen);
        if (expanded.normalized && !type.normalized) type = expanded;
      }
    }

    if (type.normalized?.kind === "alias") {
      const aliasExpr = parseAnnotationType(type.normalized.type);
      if (aliasExpr) {
        const expanded = this.eval(aliasExpr, new Map());
        if (expanded?.kind === "type") return this.resolveTypeValue(expanded, seen);
      }
    }

    return type;
  }

  private typeEvalKey(value: TypeEvalValue): string {
    switch (value.kind) {
      case "shape":
        return JSON.stringify({
          kind: "shape",
          slots: value.slots.map((slot) => ({
            label: slot.label,
            repeat: slot.repeat,
            value: this.typeEvalKey(slot.value),
          })),
        });
      case "type":
        return this.typeEvalTypeKey(value);
      default:
        return renderTypeEvalValue(value);
    }
  }

  private typeEvalTypeKey(value: Extract<TypeEvalValue, { kind: "type" }>): string {
    const resolved = this.resolveTypeValue(value);
    if (resolved.normalized) return JSON.stringify(this.typeBodyEvalKey(resolved.normalized));
    if (resolved.name.startsWith("{")) {
      try {
        const parsed = JSON.parse(resolved.name) as TypeEvalValue;
        if (parsed.kind === "type") return this.typeEvalTypeKey(parsed);
        if (parsed.kind === "shape") return this.typeEvalKey(parsed);
      } catch {
        // Fall through to the rendered name.
      }
    }
    const array = resolved.name.match(/(?:^|\.)InlineArray\((.*)\)$/);
    if (array) {
      const args = splitTypeArgs(array[1]);
      return JSON.stringify({
        kind: "product",
        shape: [{
          type: this.typeEvalTypeKey(this.namedType(args[1]?.trim() ?? "i32")),
        }],
      });
    }
    const fnKey = this.typeEvalFnTypeKey(resolved.name);
    if (fnKey) return fnKey;
    return resolved.name.trim();
  }

  private typeEvalFnTypeKey(source: string): string | undefined {
    const fn = parseFnSignatureDetailed(source);
    if (!fn) return undefined;
    return JSON.stringify({
      kind: "fn",
      params: fn.params.map((param) => ({
        isConst: parsedFnParamIsConst(param),
        type: this.typeEvalTypeKey(this.namedType(param.type)),
      })),
      returnType: this.typeEvalTypeKey(this.namedType(fn.returnType)),
    });
  }

  private typeBodyEvalKey(body: TypeBody): unknown {
    switch (body.kind) {
      case "alias": {
        const resolved = this.resolveTypeValue(this.namedType(body.type));
        return resolved.normalized
          ? this.typeBodyEvalKey(resolved.normalized)
          : { kind: "type", name: resolved.name };
      }
      case "product":
        return {
          kind: "product",
          shape: body.shape.slots.map((slot) => ({
            label: slot.label,
            type: this.typeEvalTypeKey(this.namedType(slot.type)),
            repeat: slot.repeat,
          })),
        };
      case "sum":
        return {
          kind: "sum",
          variants: body.variants.map((variant) => ({
            name: variant.name,
            shape: variant.shape?.slots.map((slot) => ({
              label: slot.label,
              type: this.typeEvalTypeKey(this.namedType(slot.type)),
              repeat: slot.repeat,
            })) ?? [],
          })),
        };
    }
  }
}

function typeProductSlot(type: TypeEvalValue, name: TypeEvalValue | undefined) {
  const slotName = typeLiteralName(name);
  if (type.kind !== "type" || type.normalized?.kind !== "product") return undefined;
  return type.normalized.shape.slots.find((slot) => slot.label === slotName);
}

function memberMetadataTypeValue(member: { type: string; target: string }): TypeEvalValue {
  return {
    kind: "shape",
    slots: [
      { label: "type", value: { kind: "type", name: member.type } },
      { label: "target", value: { kind: "string", value: member.target } },
    ],
  };
}

function memberMetadataConstValue(member: { type: string; target: string }): ConstValue {
  return {
    kind: "shape",
    slots: [
      { label: "type", value: { kind: "type", name: member.type } },
      { label: "target", value: { kind: "string", value: member.target } },
    ],
  };
}

function typeValue(name: string): TypeEvalValue {
  return { kind: "type", name };
}

interface ParsedFnSignature {
  params: { name?: string; type: string }[];
  returnType: string;
  effects: string[];
}

function parsedFnParamIsConst(param: ParsedFnSignature["params"][number]): boolean {
  const name = param.name?.trim();
  if (!name) return false;
  return name === "const" || name.startsWith("const ");
}

function parseFnSignatureDetailed(source: string): ParsedFnSignature | undefined {
  const match = source.trim().match(/^fn\(([\s\S]*)\)\s*->\s*([\s\S]+)$/);
  if (!match) return undefined;
  const params = match[1].trim()
    ? splitTypeArgs(match[1]).map((part) => {
      const colon = part.indexOf(":");
      return colon >= 0
        ? { name: part.slice(0, colon).trim(), type: part.slice(colon + 1).trim() }
        : { type: part.trim() };
    })
    : [];
  return { params, returnType: match[2].trim(), effects: [] };
}

function checkExternalImportsUseExplicitIo(program: Program, diagnostics: Diagnostic[]) {
  for (const item of program.imports) {
    const signature = parseFnSignatureDetailed(item.type);
    if (
      signature &&
      [signature.returnType, ...signature.params.map((param) => param.type)].some((type) =>
        type.trim().startsWith("fn(")
      )
    ) {
      diagnostics.push({
        code: "function.closure_boundary",
        message: `external import ${item.name} cannot import or export runtime function values`,
        span: item.span,
      });
    }
    const firstParam = signature?.params[0];
    if (!signature || !firstParam || !isIoTypeName(firstParam.type)) {
      diagnostics.push({
        code: "external.io_param",
        message: `external import ${item.name} must take io as its first parameter`,
        span: item.span,
      });
    }
    if (signature && !ioActionItemType(signature.returnType)) {
      diagnostics.push({
        code: "external.io_return",
        message: `external import ${item.name} must return io(T)`,
        span: item.span,
      });
    }
  }
}

function typeIsRuntimeFunctionValue(type: string | undefined, types: TypeDecl[]): boolean {
  const direct = type?.trim();
  if (!direct) return false;
  if (direct.startsWith("fn(")) return true;
  return !!resolveAliasType(direct, types)?.trim().startsWith("fn(");
}

function isIoTypeName(type: string): boolean {
  return type.trim() === "io";
}

function ioActionItemType(type: string | undefined): string | undefined {
  const args = typeCallArgsForBase(type?.trim() ?? "", "io");
  if (args === undefined) return undefined;
  return splitTypeArgs(args)[0]?.trim() || "i32";
}

function importAsCheckFn(item: Program["imports"][number]): FnDecl {
  const signature = parseFnSignatureDetailed(item.type);
  return {
    kind: "fn",
    public: false,
    imported: true,
    rootPublic: false,
    name: item.name,
    params: signature?.params.map((param, index) => ({
      name: param.name || `arg${index}`,
      type: param.type,
    })) ?? [],
    returnType: signature?.returnType ?? "i32",
    effects: item.effects,
    body: { kind: "block", statements: [] },
    primitiveId: "host_effect",
  };
}

function typeFnParamsValue(fn: ParsedFnSignature): TypeEvalValue {
  return {
    kind: "shape",
    slots: fn.params.map((param, index) => ({
      label: param.name || `_${index}`,
      value: typeValue(param.type),
    })),
  };
}

function constFnParamsValue(fn: ParsedFnSignature): ConstValue {
  return {
    kind: "shape",
    slots: fn.params.map((param, index) => ({
      label: param.name || `_${index}`,
      value: { kind: "type", name: param.type },
    })),
  };
}

function constFnEffectsValue(effects: string[]): ConstValue {
  return {
    kind: "shape",
    slots: effects.map((effect) => ({ label: effect, value: { kind: "bool", value: true } })),
  };
}

type ScalarReflection = {
  carrier: string;
  bitWidth?: number;
  min?: number;
  max?: number;
  signed: boolean;
  refined?: string;
};

function scalarReflection(type: string): ScalarReflection | undefined {
  const trimmed = type.trim();
  const refined = scalarFactsFromRefinedI32Type(trimmed);
  if (refined) {
    return {
      carrier: "i32",
      bitWidth: 32,
      min: refined.range?.min,
      max: refined.range?.max,
      signed: true,
      refined: renderRefinedI32Domain(refined.domain),
    };
  }
  const unsigned = trimmed.match(/^u([1-9][0-9]*)$/);
  if (unsigned) {
    const width = Number.parseInt(unsigned[1], 10);
    if (width >= 1 && width <= 64) {
      return { carrier: trimmed, bitWidth: width, min: 0, max: 2 ** width - 1, signed: false };
    }
  }
  if (trimmed === "i32") {
    return { carrier: "i32", bitWidth: 32, min: I32_MIN, max: I32_MAX, signed: true };
  }
  if (trimmed === "i64") return { carrier: "i64", bitWidth: 64, signed: true };
  if (trimmed === "u32") {
    return { carrier: "u32", bitWidth: 32, min: 0, max: 2 ** 32 - 1, signed: false };
  }
  if (trimmed === "u64") return { carrier: "u64", bitWidth: 64, min: 0, signed: false };
  if (trimmed === "bool") return { carrier: "bool", bitWidth: 1, min: 0, max: 1, signed: false };
  if (trimmed === "f32") return { carrier: "f32", bitWidth: 32, signed: true };
  if (trimmed === "f64") return { carrier: "f64", bitWidth: 64, signed: true };
  return undefined;
}

function primitiveMemberOwnerTypeName(type: string): string {
  const scalar = scalarReflection(type);
  if (!scalar) return type;
  if (scalar.carrier === "bool") return "bool";
  if (scalar.carrier === "f32" || scalar.carrier === "f64") return scalar.carrier;
  const width = scalar.bitWidth;
  if (scalar.signed) {
    if (width === undefined || width <= 32) return "i32";
    return "i64";
  }
  if (width === undefined || width <= 32) return "u32";
  return "u64";
}

function renderFnTypeForMemberOwner(fn: FnDecl, owner: string): string {
  const params = fn.params.map((param) => {
    let type = param.type;
    if (fn.memberOf && type === fn.memberOf.owner) type = owner;
    return `${param.name}: ${type}`;
  }).join(", ");
  let returnType = fn.returnType ?? "i32";
  if (fn.memberOf && returnType === fn.memberOf.owner) returnType = owner;
  return `fn(${params}) -> ${returnType}`;
}

function scalarDomainTypeValue(scalar: ScalarReflection): TypeEvalValue {
  return {
    kind: "shape",
    slots: [
      { label: "carrier", value: { kind: "literal", value: scalar.carrier } },
      ...(scalar.min !== undefined
        ? [{ label: "min", value: { kind: "number" as const, value: String(scalar.min) } }]
        : []),
      ...(scalar.max !== undefined
        ? [{ label: "max", value: { kind: "number" as const, value: String(scalar.max) } }]
        : []),
      ...(scalar.refined
        ? [{ label: "domain", value: { kind: "string" as const, value: scalar.refined } }]
        : []),
    ],
  };
}

function scalarDomainConstValue(scalar: ScalarReflection): ConstValue {
  return {
    kind: "shape",
    slots: [
      { label: "carrier", value: { kind: "literal_type", value: scalar.carrier } },
      ...(scalar.min !== undefined
        ? [{ label: "min", value: { kind: "number" as const, value: String(scalar.min) } }]
        : []),
      ...(scalar.max !== undefined
        ? [{ label: "max", value: { kind: "number" as const, value: String(scalar.max) } }]
        : []),
      ...(scalar.refined
        ? [{ label: "domain", value: { kind: "string" as const, value: scalar.refined } }]
        : []),
    ],
  };
}

function evalTypeDomainBuiltin(
  name: string,
  args: TypeEvalValue[],
  types: TypeDecl[],
  report: (diagnostic: Diagnostic) => void,
): TypeEvalValue | undefined {
  const result = evalDomainBuiltin(
    name,
    args.map((arg) => refinedDomainFromTypeEvalValue(arg, types)),
    report,
    args[0]?.span,
  );
  if (!result) return undefined;
  if (result.kind === "bool") return result;
  if (result.kind === "number") return result;
  if (result.kind === "never") return result;
  return { kind: "type", name: result.name };
}

function evalConstDomainBuiltin(
  name: string,
  args: ConstValue[],
  types: TypeDecl[],
  report: (diagnostic: Diagnostic) => void,
): ConstValue | undefined {
  const result = evalDomainBuiltin(
    name,
    args.map((arg) => refinedDomainFromConstValue(arg, types)),
    report,
    args[0]?.span,
  );
  if (!result) return undefined;
  if (result.kind === "bool") return result;
  if (result.kind === "number") return result;
  if (result.kind === "never") return result;
  return { kind: "type", name: result.name };
}

type DomainBuiltinResult =
  | { kind: "bool"; value: boolean }
  | { kind: "number"; value: string }
  | { kind: "never" }
  | { kind: "type"; name: string };

function evalDomainBuiltin(
  name: string,
  domains: (RefinedI32Domain | undefined)[],
  report: (diagnostic: Diagnostic) => void,
  span?: Span,
): DomainBuiltinResult | undefined {
  if (!isTypeDomainBuiltinName(name)) return undefined;
  const left = domains[0];
  if (!left) return domainBuiltinArgError(name, 1, report, span);
  if (name === "type_domain_cardinality") {
    const count = cardinality(left);
    if (count === undefined) {
      report({
        code: "type.domain_cardinality",
        message: "@type_domain_cardinality requires literal finite domain endpoints",
        span,
      });
      return { kind: "never" };
    }
    return { kind: "number", value: String(count) };
  }

  const right = domains[1];
  if (!right) return domainBuiltinArgError(name, 2, report, span);
  if (name === "type_domain_contains") {
    return { kind: "bool", value: domainContains(left, right) };
  }
  if (name === "type_domain_union") {
    return domainBuiltinTypeResult(unionDomain(left, right), report, span);
  }
  if (name === "type_domain_intersect") {
    return domainBuiltinTypeResult(intersectDomain(left, right), report, span);
  }
  if (name === "type_domain_difference") {
    const difference = subtractDomain(left, right);
    if (!difference) {
      report({
        code: "type.domain_difference",
        message: "@type_domain_difference could not subtract symbolic domain endpoints",
        span,
      });
      return { kind: "never" };
    }
    return domainBuiltinTypeResult(difference, report, span);
  }
  return undefined;
}

function isTypeDomainBuiltinName(name: string): boolean {
  return name === "type_domain_union" ||
    name === "type_domain_intersect" ||
    name === "type_domain_difference" ||
    name === "type_domain_contains" ||
    name === "type_domain_cardinality";
}

function domainBuiltinArgError(
  name: string,
  index: number,
  report: (diagnostic: Diagnostic) => void,
  span?: Span,
): DomainBuiltinResult {
  report({
    code: "type.domain_builtin_arg",
    message: `@${name} argument ${index} must be a refined i32 domain`,
    span,
  });
  return { kind: "never" };
}

function domainBuiltinTypeResult(
  domain: RefinedI32Domain,
  report: (diagnostic: Diagnostic) => void,
  span?: Span,
): DomainBuiltinResult {
  if (domainIsEmpty(domain)) {
    report({
      code: "type.scalar_domain_empty",
      message: "scalar domain result is empty",
      span,
    });
    return { kind: "never" };
  }
  return { kind: "type", name: renderRefinedI32Domain(domain) };
}

function refinedDomainFromTypeEvalValue(
  value: TypeEvalValue | undefined,
  types: TypeDecl[],
): RefinedI32Domain | undefined {
  if (value?.kind !== "type") return undefined;
  return refinedDomainFromTypeName(value.name, types);
}

function refinedDomainFromConstValue(
  value: ConstValue | undefined,
  types: TypeDecl[],
): RefinedI32Domain | undefined {
  if (value?.kind !== "type") return undefined;
  return refinedDomainFromTypeName(value.name, types);
}

function refinedDomainFromTypeName(
  name: string,
  types: TypeDecl[],
): RefinedI32Domain | undefined {
  const resolved = resolveAliasType(name, types) ?? name;
  return parseRefinedI32Type(resolved) ?? parseRefinedI32Type(name);
}

function flatTypeSlots(type: string, types: TypeDecl[], seen = new Set<string>()): string[] {
  const resolved = resolveAliasType(type, types) ?? type;
  if (seen.has(resolved)) return [resolved];
  seen.add(resolved);
  const array = inlineArrayLikeTypeArgs(resolved, types);
  if (array) {
    return Array.from({ length: array.count }, () => array.itemType).flatMap((item) =>
      flatTypeSlots(item, types, seen)
    );
  }
  const scalar = scalarReflection(resolved);
  if (scalar) return [resolved];
  const decl = findTypeDecl(types, typeNameOf(resolved));
  if (decl?.normalized?.kind === "product") {
    const bindings = genericBindings(resolved, decl);
    return decl.normalized.shape.slots.flatMap((slot) => {
      const slotType = substituteTypeVars(slot.type, bindings);
      const repeat = slot.repeat
        ? Number.parseInt(substituteTypeVars(slot.repeat, bindings), 10)
        : 1;
      return Array.from({ length: Number.isFinite(repeat) ? repeat : 1 }, () => slotType)
        .flatMap((item) => flatTypeSlots(item, types, seen));
    });
  }
  return [resolved];
}

function typeSizeBits(type: string, types: TypeDecl[]): number | undefined {
  const array = inlineArrayLikeTypeArgs(type, types);
  if (array) {
    const item = typeSizeBits(array.itemType, types);
    return item === undefined ? undefined : item * array.count;
  }
  const scalar = scalarReflection(resolveAliasType(type, types) ?? type);
  if (scalar?.bitWidth !== undefined) return scalar.bitWidth;
  const slots = flatTypeSlots(type, types);
  if (!slots.length) return 0;
  let total = 0;
  for (const slot of slots) {
    const bits = typeSizeBits(slot, types);
    if (bits === undefined) return undefined;
    total += bits;
  }
  return total;
}

function typeAlignBits(type: string, types: TypeDecl[]): number | undefined {
  const slots = flatTypeSlots(type, types);
  const aligns = slots.map((slot) => typeSizeBits(slot, types)).filter((bits): bits is number =>
    bits !== undefined
  );
  return aligns.length ? Math.max(...aligns) : typeSizeBits(type, types);
}

function typeStorageKindValue(type: TypeEvalValue, types: TypeDecl[]): TypeEvalValue {
  const array = type.kind === "type" ? inlineArrayLikeTypeArgs(type.name, types) : undefined;
  if (array) {
    const itemBits = typeSizeBits(array.itemType, types);
    const packed = itemBits !== undefined && itemBits * array.count <= 64;
    return { kind: "literal", value: packed ? "packed" : "flat" };
  }
  if (type.kind === "type" && type.normalized?.kind === "sum") {
    return { kind: "literal", value: "tagged_union" };
  }
  if (type.kind === "type" && type.normalized?.kind === "product") {
    return { kind: "literal", value: "flat" };
  }
  return {
    kind: "literal",
    value: scalarReflection(type.kind === "type" ? type.name : "") ? "scalar" : "opaque",
  };
}

function typeLayoutValue(type: TypeEvalValue, types: TypeDecl[]): TypeEvalValue {
  const name = type.kind === "type" ? type.name : "";
  const array = inlineArrayLikeTypeArgs(name, types);
  const itemBits = array ? typeSizeBits(array.itemType, types) : undefined;
  const totalBits = typeSizeBits(name, types);
  return {
    kind: "shape",
    slots: [
      { label: "kind", value: typeStorageKindValue(type, types) },
      ...(array
        ? [
          { label: "len", value: { kind: "number" as const, value: String(array.count) } },
          { label: "item", value: typeValue(array.itemType) },
        ]
        : []),
      ...(itemBits !== undefined
        ? [{ label: "item_bits", value: { kind: "number" as const, value: String(itemBits) } }]
        : []),
      ...(totalBits !== undefined
        ? [{ label: "total_bits", value: { kind: "number" as const, value: String(totalBits) } }]
        : []),
      {
        label: "flat_slot_count",
        value: { kind: "number", value: String(flatTypeSlots(name, types).length) },
      },
    ],
  };
}

function typeFlatSlotsValue(type: string, types: TypeDecl[]): TypeEvalValue {
  return {
    kind: "shape",
    slots: flatTypeSlots(type, types).map((slot, index) => ({
      label: `slot${index}`,
      value: typeValue(slot),
    })),
  };
}

function variantPayloadType(variant: TypeVariant): string {
  const slots = variant.shape?.slots ?? [];
  if (!slots.length) return "struct({})";
  if (slots.length === 1 && !slots[0].label && !slots[0].repeat) return slots[0].type;
  return `struct({${
    slots.map((slot) => `${slot.label ? `${slot.label}: ` : ""}${slot.type}`).join(", ")
  }})`;
}

function constToTypeEvalValue(value: ConstValue): TypeEvalValue {
  switch (value.kind) {
    case "bool":
      return { kind: "bool", value: value.value };
    case "number":
      return { kind: "number", value: value.value };
    case "char":
      return { kind: "char", value: value.value };
    case "string":
      return { kind: "string", value: value.value };
    case "literal_type":
      return { kind: "literal", value: value.value };
    case "type":
      return { kind: "type", name: value.name, normalized: value.normalized };
    case "shape":
      return {
        kind: "shape",
        slots: value.slots.map((slot) => ({
          label: slot.label,
          value: constToTypeEvalValue(slot.value),
        })),
      };
    default:
      return { kind: "never" };
  }
}

function typeShapeValueToProduct(
  shape: Extract<TypeEvalValue, { kind: "shape" }>,
): TypeBody & { kind: "product" } {
  return {
    kind: "product",
    name: "shape",
    constructor: "Shape",
    shape: {
      slots: shape.slots.map((slot) => ({
        label: slot.label,
        repeat: slot.repeat,
        type: slot.value.kind === "type" ? slot.value.name : renderTypeEvalValue(slot.value),
      })),
    },
  };
}

function typeMember(type: TypeEvalValue, name: TypeEvalValue | undefined) {
  const memberName = typeLiteralName(name);
  if (type.kind !== "type") return undefined;
  if (type.normalized?.kind === "product" || type.normalized?.kind === "sum") {
    const member = type.normalized.members?.find((member) => member.name === memberName);
    if (member) return member;
  }
  if (memberName === "empty" && typeHasDerivedEmpty(type)) {
    return {
      name: "empty",
      type: `fn() -> ${type.name}`,
      target: `${type.name}::empty`,
    };
  }
  return undefined;
}

function emptyMemberOwner(name: string): string | undefined {
  return name.endsWith("::empty") ? name.slice(0, -"::empty".length) : undefined;
}

function emptyExprForType(type: string, context: ConstSpecializationContext): Expr | undefined {
  const memberName = `${type}::empty`;
  if (context.functions.has(memberName) && context.currentFn?.name !== memberName) {
    return { kind: "call", callee: { kind: "var", name: memberName }, args: [] };
  }
  const parsed = parseAnnotationType(type);
  if (parsed) {
    const diagnostics: Diagnostic[] = [];
    const evaluator = new TypeEvaluator(
      new Map(context.types.map((decl) => [decl.name, decl])),
      context.functions,
      new Map(),
      context.consts,
      diagnostics,
      shaderManifestEntry,
      defaultCompilerPluginRegistry,
      context.diagnosticSpan,
    );
    const evaluated = evaluator.eval(parsed, new Map(), context.diagnosticSpan);
    if (evaluated?.kind === "type") {
      const derived = derivedEmptyExprForTypeValue(evaluated, context);
      if (derived) return derived;
    }
  }
  return derivedEmptyExpr(type, context);
}

function typeHasDerivedEmpty(
  type: Extract<TypeEvalValue, { kind: "type" }>,
  seen = new Set<string>(),
): boolean {
  if (isEmptyPrimitiveType(type.name)) return true;
  const name = terminalName(type.name);
  if (isEmptyPrimitiveType(name)) return true;
  if (seen.has(type.name)) return false;
  seen.add(type.name);
  if (type.normalized?.kind === "alias") {
    return typeHasDerivedEmpty({ kind: "type", name: type.normalized.type }, seen);
  }
  if (type.normalized?.kind !== "product") return false;
  return type.normalized.shape.slots.every((slot) =>
    typeHasDerivedEmpty({ kind: "type", name: slot.type }, seen)
  );
}

function derivedEmptyExpr(
  type: string,
  context: ConstSpecializationContext,
  seen = new Set<string>(),
): Expr | undefined {
  const literal = literalTypeMembers(type)?.[0];
  if (literal) return literalTypeMemberExpr(literal);
  if (isEmptyNumericType(type)) return { kind: "literal", literalKind: "number", value: "0" };
  const name = terminalName(type);
  if (name === "bool") return { kind: "literal", literalKind: "bool", value: "false" };
  if (isEmptyNumericType(name)) return { kind: "literal", literalKind: "number", value: "0" };
  if (seen.has(type)) return undefined;
  seen.add(type);
  const decl = resolveTypeDecl(type, context.types);
  if (!decl?.normalized) return undefined;
  if (decl.normalized.kind === "alias") {
    return derivedEmptyExpr(decl.normalized.type, context, seen);
  }
  if (decl.normalized.kind !== "product") return undefined;
  const bindings = genericBindings(type, decl);
  const slots = [];
  for (const slot of decl.normalized.shape.slots) {
    const slotType = substituteTypeVars(slot.type, bindings);
    const value = emptyExprForType(slotType, context);
    if (!value) return undefined;
    slots.push({ label: slot.label, value });
  }
  return {
    kind: "product_constructor",
    constructor: decl.normalized.constructor,
    slots,
  };
}

function derivedEmptyExprForTypeValue(
  type: Extract<TypeEvalValue, { kind: "type" }>,
  context: ConstSpecializationContext,
  seen = new Set<string>(),
): Expr | undefined {
  const literal = literalTypeMembers(type.name)?.[0];
  if (literal) return literalTypeMemberExpr(literal);
  if (isEmptyNumericType(type.name)) return { kind: "literal", literalKind: "number", value: "0" };
  const name = terminalName(type.name);
  if (name === "bool") return { kind: "literal", literalKind: "bool", value: "false" };
  if (isEmptyNumericType(name)) return { kind: "literal", literalKind: "number", value: "0" };
  if (seen.has(type.name)) return undefined;
  seen.add(type.name);
  if (type.normalized?.kind === "alias") {
    return derivedEmptyExpr(type.normalized.type, context, seen);
  }
  if (type.normalized?.kind !== "product") return derivedEmptyExpr(type.name, context, seen);
  const slots = [];
  for (const slot of type.normalized.shape.slots) {
    const value = emptyExprForType(slot.type, context);
    if (!value) return undefined;
    slots.push({ label: slot.label, value });
  }
  return {
    kind: "product_constructor",
    constructor: type.normalized.constructor,
    slots,
  };
}

function literalTypeMemberExpr(member: LiteralTypeMember): Expr {
  if (member.kind === "bool") {
    return { kind: "literal", literalKind: "bool", value: member.value };
  }
  if (member.kind === "number") {
    return { kind: "literal", literalKind: "number", value: member.value };
  }
  if (member.kind === "string") {
    return { kind: "literal", literalKind: "string", value: JSON.stringify(member.value) };
  }
  if (member.kind === "char") {
    return { kind: "literal", literalKind: "char", value: renderLiteralTypeMember(member) };
  }
  return { kind: "literal", literalKind: "literalType", value: `#${member.value}` };
}

function isEmptyPrimitiveType(type: string): boolean {
  return type === "bool" || isEmptyNumericType(type);
}

function isEmptyNumericType(type: string): boolean {
  return isNumericType(type) || refinedI32ContainsLiteral(type, 0);
}

function isNumericType(type: string): boolean {
  return ["i32", "u32", "i64", "u64", "f32", "f64"].includes(type) ||
    unsignedBitWidth(type) !== undefined;
}

function unsignedBitWidth(type: string): number | undefined {
  const match = type.match(/^u([1-9][0-9]*)$/);
  if (!match) return undefined;
  const width = Number.parseInt(match[1], 10);
  return width >= 1 && width <= 64 ? width : undefined;
}

function typeLiteralName(value: TypeEvalValue | undefined): string | undefined {
  return value?.kind === "literal" || value?.kind === "string" || value?.kind === "char"
    ? value.value
    : undefined;
}

function typePatternMatches(pattern: TypePattern, value: TypeEvalValue): boolean {
  if (pattern.kind === "wildcard") return true;
  if (pattern.kind === "bool") return value.kind === "bool" && value.value === pattern.value;
  if (pattern.kind === "literal") return value.kind === "literal" && value.value === pattern.value;
  if (pattern.kind === "string") return value.kind === "string" && value.value === pattern.value;
  if (pattern.kind === "char") return value.kind === "char" && value.value === pattern.value;
  if (pattern.kind === "number") return value.kind === "number" && value.value === pattern.value;
  return value.kind === "type" && value.name === pattern.name;
}

function typeParamPatternMatches(pattern: ParamPattern | undefined, value: TypeEvalValue): boolean {
  if (!pattern || pattern.kind === "binding" || pattern.kind === "wildcard") return true;
  if (pattern.kind === "typed") return typeParamPatternMatches(pattern.pattern, value);
  if (pattern.kind === "type") return value.kind === "type" && value.name === pattern.name;
  if (pattern.kind === "literal") {
    if (pattern.literalKind === "bool") {
      return value.kind === "bool" && pattern.value === (value.value ? "true" : "false");
    }
    if (pattern.literalKind === "number") {
      return value.kind === "number" && value.value === pattern.value;
    }
    if (pattern.literalKind === "string") {
      return value.kind === "string" && JSON.stringify(value.value) === pattern.value;
    }
    if (pattern.literalKind === "char") {
      return value.kind === "char" && `'${value.value}'` === pattern.value;
    }
    if (pattern.literalKind === "literalType") {
      return value.kind === "literal" && `#${value.value}` === pattern.value;
    }
  }
  return false;
}

function bindTypeParamPattern(
  pattern: ParamPattern | undefined,
  fallbackName: string,
  value: TypeEvalValue,
  locals: Map<string, TypeEvalValue>,
) {
  locals.set(
    pattern?.kind === "binding" || pattern?.kind === "type" ? pattern.name : fallbackName,
    value,
  );
}

function typeExprPatternMatches(pattern: ParamPattern, value: TypeEvalValue): boolean {
  if (pattern.kind === "typed") return typeExprPatternMatches(pattern.pattern, value);
  if (pattern.kind === "wildcard" || pattern.kind === "binding") return true;
  if (pattern.kind !== "literal" && pattern.kind !== "type") return false;
  const text = renderParamPattern(pattern);
  if (value.kind === "bool") return text === (value.value ? "true" : "false");
  if (value.kind === "number") return text === value.value;
  if (value.kind === "string") return text === JSON.stringify(value.value);
  if (value.kind === "literal") return text === `#${value.value}`;
  if (value.kind === "char") return text === `'${value.value}'`;
  if (value.kind === "type") return text === value.name;
  return false;
}

function renderTypeEvalValue(value: TypeEvalValue): string {
  if (value.kind === "type") return value.name;
  if (value.kind === "literal") return `#${value.value}`;
  if (value.kind === "char") return `'${value.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (value.kind === "string") return JSON.stringify(value.value);
  if (value.kind === "number") return value.value;
  if (value.kind === "bool") return value.value ? "true" : "false";
  if (value.kind === "static_builtin") return `@${value.name}`;
  if (value.kind === "shape") {
    return `[${
      value.slots.map((slot) =>
        `${slot.label ? `${slot.label}: ` : ""}${renderTypeEvalValue(slot.value)}`
      ).join(", ")
    }]`;
  }
  if (value.kind === "members") return `members(${value.target})`;
  return "<never>";
}

function substituteTypeExpr(expr: TypeExpr, locals: Map<string, TypeEvalValue>): TypeExpr {
  if (expr.kind === "type_ref") {
    const local = locals.get(expr.name);
    if (local?.kind === "type") return parseAnnotationType(local.name) ?? expr;
    if (local?.kind === "literal") return { kind: "type_literal", value: local.value };
    if (local?.kind === "char") return { kind: "type_char", value: local.value };
    if (local?.kind === "string") return { kind: "type_string", value: local.value };
    if (local?.kind === "number") return { kind: "type_number", value: local.value };
    if (local?.kind === "bool") return { kind: "type_bool", value: local.value };
    return expr;
  }
  if (expr.kind === "type_static_ref") return expr;
  if (expr.kind === "type_call") {
    return {
      kind: "type_call",
      callee: substituteTypeExpr(expr.callee, locals),
      args: expr.args.map((arg) => substituteTypeExpr(arg, locals)),
    };
  }
  if (expr.kind === "type_shape") {
    return { ...expr, shape: substituteShape(expr.shape, locals) };
  }
  if (expr.kind === "type_members") {
    return { ...expr, target: substituteTypeExpr(expr.target, locals) };
  }
  if (expr.kind === "type_match") {
    return {
      kind: "type_match",
      value: substituteTypeExpr(expr.value, locals),
      arms: expr.arms.map((arm) => ({
        pattern: arm.pattern,
        value: substituteTypeExpr(arm.value, locals),
      })),
    };
  }
  if (expr.kind === "type_scalar_domain") return substituteScalarDomainExpr(expr, locals);
  if (expr.kind === "type_binary") {
    return {
      kind: "type_binary",
      op: expr.op,
      left: substituteTypeExpr(expr.left, locals),
      right: substituteTypeExpr(expr.right, locals),
    };
  }
  return expr;
}

function substituteScalarDomainExpr(
  expr: Extract<TypeExpr, { kind: "type_scalar_domain" }>,
  locals: Map<string, TypeEvalValue>,
): TypeExpr {
  const substituteEndpoint = (
    endpoint: Extract<TypeExpr, { kind: "type_scalar_domain" }>["members"][number]["start"],
  ) => {
    const local = endpoint.kind === "symbol" ? locals.get(endpoint.source) : undefined;
    return local?.kind === "number"
      ? { ...endpoint, kind: "literal" as const, source: local.value }
      : endpoint;
  };
  return {
    ...expr,
    members: expr.members.map((member) => ({
      ...member,
      start: substituteEndpoint(member.start),
      ...(member.end ? { end: substituteEndpoint(member.end) } : {}),
    })),
  };
}

function substituteShape(shape: TypeShape, locals: Map<string, TypeEvalValue>): TypeShape {
  return {
    slots: shape.slots.map((slot) => ({
      ...slot,
      type: substituteTypeExpr(slot.type, locals),
    })),
    members: shape.members?.map((member) => ({
      ...member,
      type: substituteTypeSource(member.type, locals),
    })),
  };
}

function substituteTypeSource(source: string, locals: Map<string, TypeEvalValue>): string {
  let result = source;
  for (const [name, value] of locals) {
    if (value.kind === "type") {
      result = result.replace(new RegExp(`\\b${name}\\b`, "g"), value.name);
    } else if (value.kind === "shape") {
      for (const slot of value.slots) {
        if (!slot.label) continue;
        result = result.replace(
          new RegExp(`\\b${name}\\.${slot.label}\\b`, "g"),
          renderTypeEvalValue(slot.value),
        );
      }
    }
  }
  return result;
}

function substituteTypeEvalLocalsInBlock(
  block: Extract<Expr, { kind: "block" }>,
  locals: Map<string, TypeEvalValue>,
): Extract<Expr, { kind: "block" }> {
  return {
    ...block,
    statements: block.statements.map((stmt) => {
      if (stmt.kind === "let") {
        return {
          ...stmt,
          ...(stmt.type ? { type: substituteTypeSource(stmt.type, locals) } : {}),
          value: substituteTypeEvalLocalsInExpr(stmt.value, locals),
        };
      }
      if (stmt.kind === "destructure_let") {
        return { ...stmt, value: substituteTypeEvalLocalsInExpr(stmt.value, locals) };
      }
      if (stmt.kind === "type_assert") {
        return { ...stmt, value: substituteTypeExpr(stmt.value, locals) };
      }
      return stmt;
    }),
    expr: block.expr ? substituteTypeEvalLocalsInExpr(block.expr, locals) : undefined,
  };
}

function substituteTypeEvalLocalsInExpr(
  expr: Expr,
  locals: Map<string, TypeEvalValue>,
): Expr {
  switch (expr.kind) {
    case "var":
      return { ...expr, name: substituteTypeEvalLocalName(expr.name, locals) };
    case "literal":
      return expr;
    case "call":
      return {
        ...expr,
        callee: substituteTypeEvalLocalsInExpr(expr.callee, locals),
        args: expr.args.map((arg) => substituteTypeEvalLocalsInExpr(arg, locals)),
      };
    case "index":
      return {
        ...expr,
        target: substituteTypeEvalLocalsInExpr(expr.target, locals),
        index: substituteTypeEvalLocalsInExpr(expr.index, locals),
      };
    case "binary":
      return {
        ...expr,
        left: substituteTypeEvalLocalsInExpr(expr.left, locals),
        right: substituteTypeEvalLocalsInExpr(expr.right, locals),
      };
    case "operator_chain":
      return {
        ...expr,
        first: substituteTypeEvalLocalsInExpr(expr.first, locals),
        rest: expr.rest.map((item) => ({
          ...item,
          value: substituteTypeEvalLocalsInExpr(item.value, locals),
        })),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: substituteTypeEvalLocalsInExpr(expr.value, locals),
        body: substituteTypeEvalLocalsInExpr(expr.body, locals),
      };
    case "const_fn":
      return { ...expr, body: substituteTypeEvalLocalsInExpr(expr.body, locals) };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => substituteTypeEvalLocalsInExpr(arg, locals)),
        body: substituteTypeEvalLocalsInExpr(expr.body, locals),
      };
    case "match":
      return {
        ...expr,
        value: substituteTypeEvalLocalsInExpr(expr.value, locals),
        arms: expr.arms.map((arm) => ({
          ...arm,
          ...(arm.guard ? { guard: substituteTypeEvalLocalsInExpr(arm.guard, locals) } : {}),
          value: substituteTypeEvalLocalsInExpr(arm.value, locals),
        })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          ...(slot.index ? { index: substituteTypeEvalLocalsInExpr(slot.index, locals) } : {}),
          value: substituteTypeEvalLocalsInExpr(slot.value, locals),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        constructor: substituteTypeEvalLocalName(expr.constructor, locals),
        slots: expr.slots.map((slot) => ({
          ...slot,
          ...(slot.index ? { index: substituteTypeEvalLocalsInExpr(slot.index, locals) } : {}),
          value: substituteTypeEvalLocalsInExpr(slot.value, locals),
        })),
      };
    case "field":
      return {
        ...expr,
        value: substituteTypeEvalLocalsInExpr(expr.value, locals),
        key: substituteTypeEvalLocalsInExpr(expr.key, locals),
      };
    case "range":
      return {
        ...expr,
        start: substituteTypeEvalLocalsInExpr(expr.start, locals),
        end: substituteTypeEvalLocalsInExpr(expr.end, locals),
      };
    case "static_for_slots": {
      const source = expr.source.kind === "range"
        ? {
          kind: "range" as const,
          start: substituteTypeEvalLocalsInExpr(expr.source.start, locals),
          end: substituteTypeEvalLocalsInExpr(expr.source.end, locals),
        }
        : {
          kind: "shape" as const,
          shape: substituteTypeEvalLocalsInExpr(expr.source.shape, locals),
        };
      return { ...expr, source, value: substituteTypeEvalLocalsInExpr(expr.value, locals) };
    }
    case "do":
      return {
        ...expr,
        strategy: {
          ...expr.strategy,
          effect: substituteTypeExpr(expr.strategy.effect, locals),
        },
        statements: expr.statements.map((stmt) => {
          if (stmt.kind === "do_bind" || stmt.kind === "do_expr") {
            return { ...stmt, value: substituteTypeEvalLocalsInExpr(stmt.value, locals) };
          }
          if (stmt.kind === "let") {
            return {
              ...stmt,
              ...(stmt.type ? { type: substituteTypeSource(stmt.type, locals) } : {}),
              value: substituteTypeEvalLocalsInExpr(stmt.value, locals),
            };
          }
          if (stmt.kind === "destructure_let") {
            return { ...stmt, value: substituteTypeEvalLocalsInExpr(stmt.value, locals) };
          }
          if (stmt.kind === "type_assert") {
            return { ...stmt, value: substituteTypeExpr(stmt.value, locals) };
          }
          return stmt;
        }),
        expr: expr.expr ? substituteTypeEvalLocalsInExpr(expr.expr, locals) : undefined,
      };
    case "block":
      return substituteTypeEvalLocalsInBlock(expr, locals);
  }
}

function substituteTypeEvalLocalName(
  name: string,
  locals: Map<string, TypeEvalValue>,
): string {
  for (const [localName, value] of locals) {
    if (value.kind !== "type") continue;
    if (name === localName) return value.name;
    if (name.startsWith(`${localName}::`)) return `${value.name}${name.slice(localName.length)}`;
    if (name.startsWith(`${localName}.`)) return `${value.name}${name.slice(localName.length)}`;
  }
  return name;
}

function substituteTypeBodyEval(body: TypeBody, locals: Map<string, TypeEvalValue>): TypeBody {
  switch (body.kind) {
    case "alias":
      return { ...body, type: substituteTypeSource(body.type, locals) };
    case "product":
      return {
        ...body,
        shape: {
          ...body.shape,
          slots: body.shape.slots.map((slot) => ({
            ...slot,
            type: substituteTypeSource(slot.type, locals),
          })),
        },
      };
    case "sum":
      return {
        ...body,
        variants: body.variants.map((variant) => ({
          ...variant,
          shape: variant.shape
            ? {
              ...variant.shape,
              slots: variant.shape.slots.map((slot) => ({
                ...slot,
                type: substituteTypeSource(slot.type, locals),
              })),
            }
            : undefined,
        })),
      };
  }
}

function parseAnnotationTypeCalls(source: string): TypeExpr[] {
  const parsed = parseAnnotationType(source);
  return parsed ? collectTypeCalls(parsed) : [];
}

function collectTypeCalls(expr: TypeExpr): TypeExpr[] {
  const nested: TypeExpr[] = [];
  if (expr.kind === "type_call") {
    nested.push(expr);
    nested.push(...collectTypeCalls(expr.callee));
    for (const arg of expr.args) nested.push(...collectTypeCalls(arg));
  } else if (expr.kind === "type_match") {
    nested.push(...collectTypeCalls(expr.value));
    for (const arm of expr.arms) nested.push(...collectTypeCalls(arm.value));
  } else if (expr.kind === "type_shape") {
    for (const slot of expr.shape.slots) nested.push(...collectTypeCalls(slot.type));
  } else if (expr.kind === "type_scalar_domain") {
    return nested;
  } else if (expr.kind === "type_fn") {
    for (const item of expr.source.match(/[A-Za-z_][A-Za-z0-9_]*(?:\([^()]*\))/g) ?? []) {
      if (item.startsWith("fn(")) continue;
      const parsed = parseAnnotationType(item);
      if (parsed && parsed.kind !== "type_fn") nested.push(...collectTypeCalls(parsed));
    }
  }
  return nested;
}

function parseAnnotationType(source: string): TypeExpr | undefined {
  source = normalizeTypeSourceForParsing(source);
  const cached = parsedAnnotationTypeCache.get(source);
  if (cached !== undefined) {
    if (cached === false) return undefined;
    return cached;
  }
  const parser = new AnnotationTypeParser(source);
  const parsed = parser.parse();
  if (parsedAnnotationTypeCache.size >= PARSED_ANNOTATION_TYPE_CACHE_LIMIT) {
    parsedAnnotationTypeCache.clear();
  }
  parsedAnnotationTypeCache.set(source, parsed ?? false);
  return parsed;
}

class AnnotationTypeParser {
  private index = 0;

  constructor(private source: string) {}

  parse(): TypeExpr | undefined {
    this.skip();
    const expr = this.parseType();
    this.skip();
    return this.index >= this.source.length ? expr : undefined;
  }

  private parseType(): TypeExpr | undefined {
    return this.parseUnion();
  }

  private parseUnion(): TypeExpr | undefined {
    let expr = this.parsePrimaryType();
    if (!expr) return undefined;
    while (this.peek("|")) {
      this.index++;
      const right = this.parsePrimaryType();
      if (!right) return undefined;
      expr = { kind: "type_binary", op: "|", left: expr, right };
    }
    return expr;
  }

  private parsePrimaryType(): TypeExpr | undefined {
    this.skip();
    if (this.peekKeyword("match")) {
      return this.parseMatchType();
    }
    if (this.peekKeyword("fn")) {
      return { kind: "type_fn", source: this.source.slice(this.index).trim() };
    }
    if (this.peek("{")) return { kind: "type_shape", shape: this.parseShape() };
    if (this.peek("[")) return { kind: "type_shape", shape: this.parseTupleShape() };
    if (this.peek("@")) {
      this.index++;
      const name = this.ident();
      if (!name) return undefined;
      return { kind: "type_static_ref", name };
    }
    if (this.peek("#")) {
      this.index++;
      if (this.peek("(")) {
        this.index++;
        const inner = this.parseType();
        this.skip();
        if (this.peek(")")) this.index++;
        return inner
          ? { kind: "type_call", callee: { kind: "type_ref", name: "#" }, args: [inner] }
          : undefined;
      }
      const value = this.ident();
      if (!value) return undefined;
      return { kind: "type_literal", value };
    }
    if (this.peekKeyword("true")) {
      this.index += "true".length;
      return { kind: "type_bool", value: true };
    }
    if (this.peekKeyword("false")) {
      this.index += "false".length;
      return { kind: "type_bool", value: false };
    }
    if (this.peek("_")) {
      this.index++;
      return { kind: "type_hole" };
    }
    if (this.peek('"')) {
      const text = this.quoted('"');
      return text === undefined ? undefined : { kind: "type_string", value: JSON.parse(text) };
    }
    if (this.peek("'")) {
      const text = this.quoted("'");
      return text === undefined
        ? undefined
        : { kind: "type_char", value: JSON.parse(`"${text.slice(1, -1)}"`) };
    }
    const number = this.source.slice(this.index).match(
      /^-?[0-9]+(?:\.[0-9]+)?(?:i32|u32|i64|u64|f32|f64)?/,
    );
    if (number) {
      this.index += number[0].length;
      return { kind: "type_number", value: number[0] };
    }
    const name = this.ident();
    if (!name) return undefined;
    let fullName = name;
    while (this.peek(".")) {
      this.index++;
      const part = this.ident();
      if (!part) break;
      fullName += `.${part}`;
    }
    const scalarDomain = this.parseScalarDomainType(fullName);
    if (scalarDomain) return scalarDomain;
    let expr: TypeExpr = { kind: "type_ref", name: fullName };
    this.skip();
    while (this.peek("(")) {
      this.index++;
      const args: TypeExpr[] = [];
      this.skip();
      while (!this.peek(")") && this.index < this.source.length) {
        const arg = this.parseType();
        if (!arg) break;
        args.push(arg);
        this.skip();
        if (this.peek(",")) {
          this.index++;
          this.skip();
        } else {
          break;
        }
      }
      if (this.peek(")")) this.index++;
      expr = { kind: "type_call", callee: expr, args };
      this.skip();
    }
    return expr;
  }

  private parseMatchType(): TypeExpr | undefined {
    this.index += "match".length;
    const value = this.parseType();
    if (!value) return undefined;
    this.skip();
    if (!this.peek("{")) return undefined;
    this.index++;
    const arms: Extract<TypeExpr, { kind: "type_match" }>["arms"] = [];
    this.skip();
    while (!this.peek("}") && this.index < this.source.length) {
      const pattern = this.parseTypePattern();
      this.skip();
      if (!this.peek("=>")) return undefined;
      this.index += 2;
      const armValue = this.parseType();
      if (!pattern || !armValue) return undefined;
      arms.push({ pattern, value: armValue });
      this.skip();
      if (this.peek(",")) {
        this.index++;
        this.skip();
      } else {
        break;
      }
    }
    if (!this.peek("}")) return undefined;
    this.index++;
    return { kind: "type_match", value, arms };
  }

  private parseTypePattern(): TypePattern | undefined {
    this.skip();
    if (this.peek("_")) {
      this.index++;
      return { kind: "wildcard" };
    }
    if (this.peekKeyword("true")) {
      this.index += "true".length;
      return { kind: "bool", value: true };
    }
    if (this.peekKeyword("false")) {
      this.index += "false".length;
      return { kind: "bool", value: false };
    }
    if (this.peek("#")) {
      this.index++;
      const value = this.ident();
      return value ? { kind: "literal", value } : undefined;
    }
    if (this.peek('"')) {
      const text = this.quoted('"');
      return text === undefined ? undefined : { kind: "string", value: JSON.parse(text) };
    }
    if (this.peek("'")) {
      const text = this.quoted("'");
      return text === undefined
        ? undefined
        : { kind: "char", value: JSON.parse(`"${text.slice(1, -1)}"`) };
    }
    const number = this.source.slice(this.index).match(
      /^-?[0-9]+(?:\.[0-9]+)?(?:i32|u32|i64|u64|f32|f64)?/,
    );
    if (number) {
      this.index += number[0].length;
      return { kind: "number", value: number[0] };
    }
    const name = this.ident();
    return name ? { kind: "type", name } : undefined;
  }

  private parseScalarDomainType(carrier: string): TypeExpr | undefined {
    if (!["i32", "i64", "u32", "u64", "f32", "f64"].includes(carrier)) return undefined;
    this.skip();
    if (!this.peek("(")) return undefined;
    this.index++;
    this.skip();
    const members: Extract<TypeExpr, { kind: "type_scalar_domain" }>["members"] = [];
    while (!this.peek(")") && this.index < this.source.length) {
      const start = this.parseScalarDomainEndpoint();
      if (!start) break;
      this.skip();
      let end: typeof start | undefined;
      if (this.peek("..")) {
        this.index += 2;
        end = this.parseScalarDomainEndpoint();
        if (!end) break;
        this.skip();
      }
      members.push({ start, ...(end ? { end } : {}) });
      if (this.peek("|")) {
        this.index++;
        this.skip();
        continue;
      }
      break;
    }
    if (this.peek(")")) {
      this.index++;
      return { kind: "type_scalar_domain", carrier, members };
    }
    return undefined;
  }

  private parseScalarDomainEndpoint():
    | Extract<TypeExpr, { kind: "type_scalar_domain" }>["members"][number]["start"]
    | undefined {
    this.skip();
    const number = this.source.slice(this.index).match(/^-?[0-9]+/);
    if (number) {
      this.index += number[0].length;
      return { kind: "literal", source: number[0] };
    }
    if (this.peek('"')) {
      const text = this.quoted('"');
      return text === undefined ? undefined : { kind: "literal", source: text };
    }
    if (this.peek("'")) {
      const text = this.quoted("'");
      return text === undefined ? undefined : { kind: "literal", source: text };
    }
    if (this.peek("#")) {
      this.index++;
      const value = this.ident();
      return value ? { kind: "literal", source: `#${value}` } : undefined;
    }
    if (this.peekKeyword("true")) {
      this.index += "true".length;
      return { kind: "literal", source: "true" };
    }
    if (this.peekKeyword("false")) {
      this.index += "false".length;
      return { kind: "literal", source: "false" };
    }
    const name = this.ident();
    if (!name) return undefined;
    let source = name;
    while (this.peek(".")) {
      this.index++;
      const part = this.ident();
      if (!part) break;
      source += `.${part}`;
    }
    return { kind: "symbol", source };
  }

  private quoted(quote: '"' | "'"): string | undefined {
    this.skip();
    if (!this.source.startsWith(quote, this.index)) return undefined;
    const start = this.index;
    this.index++;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "\\") {
        this.index += 2;
        continue;
      }
      this.index++;
      if (char === quote) return this.source.slice(start, this.index);
    }
    return undefined;
  }

  private parseShape(): TypeShape {
    this.index++;
    const slots: TypeShape["slots"] = [];
    this.skip();
    while (!this.peek("}") && this.index < this.source.length) {
      const start = this.index;
      const first = this.ident();
      let label: string | undefined;
      let position: number | undefined;
      this.skip();
      if (first && this.peek("[")) {
        this.index++;
        const digits = this.source.slice(this.index).match(/^[0-9]+/);
        if (digits) {
          position = Number.parseInt(digits[0], 10);
          this.index += digits[0].length;
        }
        if (this.peek("]")) this.index++;
        this.skip();
      } else if (!first && this.peek("[")) {
        this.index++;
        const digits = this.source.slice(this.index).match(/^[0-9]+/);
        if (digits) {
          position = Number.parseInt(digits[0], 10);
          this.index += digits[0].length;
        }
        if (this.peek("]")) this.index++;
        this.skip();
      }
      if ((first || position !== undefined) && this.peek(":")) {
        label = first;
        this.index++;
      } else {
        this.index = start;
        position = undefined;
      }
      const type = this.parseType() ??
        { kind: "type_ref" as const, name: this.readUntil([",", "}"]).trim() };
      slots.push({ label, position, type });
      this.skip();
      if (this.peek(",")) {
        this.index++;
        this.skip();
      }
    }
    if (this.peek("}")) this.index++;
    return { slots };
  }

  private parseTupleShape(): TypeShape {
    this.index++;
    const slots: TypeShape["slots"] = [];
    this.skip();
    if (this.peek("]")) {
      this.index++;
      return { slots };
    }
    const first = this.parseType();
    this.skip();
    if (this.peek(";")) {
      this.index++;
      this.skip();
      const count = this.readUntil(["]"]).trim();
      if (this.peek("]")) this.index++;
      return {
        slots: [{
          position: 0,
          type: first ?? { kind: "type_ref", name: "type" },
          repeat: parseTypeCount(count),
        }],
      };
    }
    if (first) slots.push({ position: 0, type: first });
    let position = 1;
    while (this.peek(",") && this.index < this.source.length) {
      this.index++;
      this.skip();
      if (this.peek("]")) break;
      const type = this.parseType();
      if (!type) break;
      slots.push({ position, type });
      position++;
      this.skip();
    }
    if (this.peek("]")) this.index++;
    return { slots };
  }

  private ident(): string | undefined {
    this.skip();
    const match = this.source.slice(this.index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!match) return undefined;
    this.index += match[0].length;
    return match[0];
  }

  private readUntil(chars: string[]): string {
    const start = this.index;
    while (this.index < this.source.length && !chars.includes(this.source[this.index])) {
      this.index++;
    }
    return this.source.slice(start, this.index);
  }

  private peek(text: string): boolean {
    this.skip();
    return this.source.startsWith(text, this.index);
  }

  private peekKeyword(text: string): boolean {
    this.skip();
    return this.source.startsWith(text, this.index) &&
      !/[A-Za-z0-9_]/.test(this.source[this.index + text.length] ?? "");
  }

  private skip() {
    while (/\s/.test(this.source[this.index] ?? "")) this.index++;
  }
}

interface OwnershipBinding {
  moved: boolean;
  type?: string;
}

interface RuntimeCheckOptions {
  recoverTypes: boolean;
  memo?: CheckMemo;
  currentFn?: FnDecl;
  functionMap?: Map<string, FnDecl>;
  typeConstructorMap?: Map<string, TypeDecl>;
  globalValueMap?: Map<string, OwnershipBinding>;
  bindingTypeCache?: WeakMap<Expr, string | null>;
  i32FactsCache?: WeakMap<Expr, ReturnType<typeof scalarFactsFromI32Range> | null>;
}

interface ProofFact {
  source: string;
  contract: string;
  args: string[];
}

interface TypeFacts {
  runtimeType: string;
  proofFacts: ProofFact[];
}

interface SynthResult {
  type?: string;
  proofFacts: ProofFact[];
  effects?: string[];
}

interface CheckContext {
  env: Map<string, OwnershipBinding>;
  hostIoImports: Map<string, string[]>;
  effects: string[];
  types: TypeDecl[];
  functions: FnDecl[];
  diagnostics: Diagnostic[];
  options: RuntimeCheckOptions;
  proofFacts: ProofFact[];
}

function checkFn(
  fn: FnDecl,
  hostIoImports: Map<string, string[]>,
  diagnostics: Diagnostic[],
  types: TypeDecl[],
  functions: FnDecl[],
  options: RuntimeCheckOptions,
) {
  checkRuntimeScalarDomainSymbols(fn, diagnostics);
  checkRecExpressions(fn, diagnostics, functions);
  if (exprContainsStaticExpansion(fn.body) || isInlineArrayExprBuiltinWrapper(fn)) return;
  const env = new Map<string, OwnershipBinding>();
  const runtimeOptions = {
    ...options,
    currentFn: fn,
    memo: options.memo,
    bindingTypeCache: new WeakMap<Expr, string | null>(),
    i32FactsCache: new WeakMap<Expr, ReturnType<typeof scalarFactsFromI32Range> | null>(),
  };
  const ctx = checkContext(
    env,
    hostIoImports,
    fn.effects,
    diagnostics,
    types,
    functions,
    runtimeOptions,
  );
  for (const param of fn.params) {
    const normalized = normalizeExpectedType(param.type, ctx);
    ctx.proofFacts.push(...(normalized?.proofFacts ?? []));
    env.set(param.name, { moved: false, type: normalized?.runtimeType ?? param.type });
  }
  const returnType = normalizeExpectedType(fn.returnType, ctx);
  ctx.proofFacts.push(...(returnType?.proofFacts ?? []));
  checkTypeVariableMemberProofs(fn.body, ctx, [...ctx.proofFacts]);
  if (!fnUsesInferredTypeVars(fn)) {
    checkAmbiguousNullaryInferredCalls(
      fn.body,
      options.functionMap ?? new Map(functions.map((item) => [item.name, item])),
      diagnostics,
    );
  }
  checkBlock(
    fn.body,
    env,
    hostIoImports,
    fn.effects,
    diagnostics,
    returnType?.runtimeType ?? fn.returnType,
    types,
    functions,
    runtimeOptions,
  );
}

function checkRuntimeScalarDomainSymbols(fn: FnDecl, diagnostics: Diagnostic[]) {
  const staticParams = new Set(
    fn.params.filter((param) => param.const).map((param) => param.name),
  );
  for (const param of fn.params) {
    checkScalarDomainSymbols(param.type, staticParams, diagnostics, param);
  }
  checkScalarDomainSymbols(fn.returnType, staticParams, diagnostics, fn);
  checkBlockScalarDomainSymbols(fn.body, staticParams, diagnostics);
}

function checkBlockScalarDomainSymbols(
  block: BlockExpr,
  staticParams: Set<string>,
  diagnostics: Diagnostic[],
) {
  for (const stmt of block.statements) {
    if (stmt.kind === "let" && explicitTypeAnnotation(stmt.type)) {
      checkScalarDomainSymbols(stmt.type, staticParams, diagnostics, stmt);
    }
    if (stmt.kind === "let" || stmt.kind === "destructure_let") {
      checkExprScalarDomainSymbols(stmt.value, staticParams, diagnostics);
    }
  }
  if (block.expr) checkExprScalarDomainSymbols(block.expr, staticParams, diagnostics);
}

function checkRecExpressions(fn: FnDecl, diagnostics: Diagnostic[], functions: FnDecl[] = []) {
  const functionMap = new Map(functions.map((item) => [item.name, item]));
  functionMap.set(fn.name, fn);
  const recTargetName = (expr: Extract<Expr, { kind: "call" }>): string =>
    expr.tailRecTarget ?? fn.tailRecTarget ?? fn.name;
  const recTargetFn = (expr: Extract<Expr, { kind: "call" }>): FnDecl | undefined => {
    const target = recTargetName(expr);
    return target === fn.name ? fn : functionMap.get(target);
  };
  const targetMatchesFn = (target: string | undefined): boolean =>
    !target || target === fn.name || target === fn.tailRecTarget;
  const visitStatement = (stmt: Statement) => {
    if (stmt.kind === "let" || stmt.kind === "destructure_let") {
      visitExpr(stmt.value, false, false);
      return;
    }
    if (stmt.kind === "debug_trace") {
      for (const arg of stmt.args) visitExpr(arg, false, false);
    }
  };
  const visitBlock = (block: BlockExpr, tailPosition: boolean, inConstFn: boolean) => {
    for (const stmt of block.statements) {
      if (stmt.kind === "let" || stmt.kind === "destructure_let") {
        visitExpr(stmt.value, false, inConstFn);
      } else if (stmt.kind === "debug_trace") {
        for (const arg of stmt.args) visitExpr(arg, false, inConstFn);
      }
    }
    if (block.expr) visitExpr(block.expr, tailPosition, inConstFn);
  };
  const visitExpr = (expr: Expr, tailPosition: boolean, inConstFn: boolean) => {
    if (expr.kind === "call" && expr.tailRec) {
      const targetFn = recTargetFn(expr);
      const targetName = recTargetName(expr);
      const activeParams = runtimeParams(targetFn?.params ?? fn.params);
      const validConstTarget = targetMatchesFn(expr.tailRecTarget ?? fn.tailRecTarget);
      if (inConstFn && !validConstTarget) {
        diagnostics.push(diagnosticAt(
          "rec.context",
          "rec(...) is only valid in a runtime function body",
          expr,
        ));
      } else if (!targetFn) {
        diagnostics.push(diagnosticAt(
          "rec.context",
          `rec(...) target ${targetName} is not a known runtime function`,
          expr,
        ));
      } else if (!tailPosition) {
        diagnostics.push(diagnosticAt(
          "rec.tail_position",
          "rec(...) must be returned directly from a tail position",
          expr,
        ));
      }
      if (expr.args.length !== activeParams.length) {
        diagnostics.push(diagnosticAt(
          "rec.arity",
          `rec(...) expects ${activeParams.length} runtime arguments for ${targetName}, got ${expr.args.length}`,
          expr,
        ));
      }
      for (const arg of expr.args) visitExpr(arg, false, inConstFn);
      return;
    }
    switch (expr.kind) {
      case "do":
        for (const stmt of expr.statements) {
          if (
            stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
          ) {
            visitExpr(stmt.value, false, inConstFn);
          } else if (stmt.kind === "debug_trace") {
            for (const arg of stmt.args) visitExpr(arg, false, inConstFn);
          }
        }
        if (expr.expr) visitExpr(expr.expr, tailPosition, inConstFn);
        return;
      case "const_fn":
        if (targetMatchesFn(expr.tailRecTarget)) {
          visitExpr(expr.body, tailPosition, false);
        } else {
          visitExpr(expr.body, false, true);
        }
        return;
      case "profile":
        for (const arg of expr.args) visitExpr(arg, false, inConstFn);
        visitExpr(expr.body, tailPosition, inConstFn);
        return;
      case "call":
        visitExpr(expr.callee, false, inConstFn);
        for (const arg of expr.args) {
          const argTailPosition = arg.kind === "const_fn" &&
            targetMatchesFn(arg.tailRecTarget) &&
            tailPosition;
          visitExpr(arg, argTailPosition, inConstFn);
        }
        return;
      case "index":
        visitExpr(expr.target, false, inConstFn);
        visitExpr(expr.index, false, inConstFn);
        return;
      case "binary":
        visitExpr(expr.left, false, inConstFn);
        visitExpr(expr.right, false, inConstFn);
        return;
      case "operator_chain":
        visitExpr(expr.first, false, inConstFn);
        for (const item of expr.rest) visitExpr(item.value, false, inConstFn);
        return;
      case "pipe_bind":
        visitExpr(expr.value, false, inConstFn);
        visitExpr(expr.body, tailPosition, inConstFn);
        return;
      case "match":
        visitExpr(expr.value, false, inConstFn);
        for (const arm of expr.arms) {
          if (arm.guard) visitExpr(arm.guard, false, inConstFn);
          visitExpr(arm.value, tailPosition, inConstFn);
        }
        return;
      case "shape":
      case "product_constructor":
        for (const slot of expr.slots) {
          if (slot.index) visitExpr(slot.index, false, inConstFn);
          visitExpr(slot.value, false, inConstFn);
        }
        return;
      case "static_for_slots":
        if (expr.source.kind === "range") {
          visitExpr(expr.source.start, false, inConstFn);
          visitExpr(expr.source.end, false, inConstFn);
        } else {
          visitExpr(expr.source.shape, false, inConstFn);
        }
        visitExpr(expr.value, false, inConstFn);
        return;
      case "field":
        visitExpr(expr.value, false, inConstFn);
        visitExpr(expr.key, false, inConstFn);
        return;
      case "range":
        visitExpr(expr.start, false, inConstFn);
        visitExpr(expr.end, false, inConstFn);
        return;
      case "block":
        visitBlock(expr, tailPosition, inConstFn);
        return;
      case "literal":
      case "var":
        return;
    }
  };
  for (const stmt of fn.body.statements) visitStatement(stmt);
  if (fn.body.expr) visitExpr(fn.body.expr, true, false);
}

function checkExprScalarDomainSymbols(
  expr: Expr,
  staticParams: Set<string>,
  diagnostics: Diagnostic[],
) {
  if (expr.kind === "block") {
    checkBlockScalarDomainSymbols(expr, staticParams, diagnostics);
  } else if (expr.kind === "match") {
    checkExprScalarDomainSymbols(expr.value, staticParams, diagnostics);
    for (const arm of expr.arms) checkExprScalarDomainSymbols(arm.value, staticParams, diagnostics);
  }
}

function checkScalarDomainSymbols(
  type: string | undefined,
  staticParams: Set<string>,
  diagnostics: Diagnostic[],
  spanLike?: { span?: Span; nameSpan?: Span },
) {
  const domain = parseRefinedI32Type(type);
  if (!domain) return;
  const symbols = new Set<string>();
  for (const interval of domain.intervals) {
    if (interval.start.kind === "symbol") symbols.add(interval.start.name);
    if (interval.end.kind === "symbol") symbols.add(interval.end.name);
  }
  for (const symbol of symbols) {
    if (staticParams.has(symbol)) continue;
    diagnostics.push({
      code: "type.scalar_domain_endpoint",
      message: `scalar domain endpoint ${symbol} must be a const parameter`,
      span: spanLike?.span ?? spanLike?.nameSpan,
    });
  }
}

function exprContainsStaticExpansion(expr: Expr | undefined): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "do":
      return expr.statements.some((stmt) =>
        (stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
          stmt.kind === "destructure_let") &&
        exprContainsStaticExpansion(stmt.value)
      ) || exprContainsStaticExpansion(expr.expr);
    case "const_fn":
      return exprContainsStaticExpansion(expr.body);
    case "profile":
      return expr.args.some(exprContainsStaticExpansion) ||
        exprContainsStaticExpansion(expr.body);
    case "static_for_slots":
      return true;
    case "block":
      return expr.statements.some((stmt) =>
        stmt.kind === "let" && exprContainsStaticExpansion(stmt.value) ||
        stmt.kind === "destructure_let" && exprContainsStaticExpansion(stmt.value)
      ) || exprContainsStaticExpansion(expr.expr);
    case "call":
      return exprContainsStaticExpansion(expr.callee) ||
        expr.args.some(exprContainsStaticExpansion);
    case "index":
      return exprContainsStaticExpansion(expr.target) || exprContainsStaticExpansion(expr.index);
    case "binary":
      return exprContainsStaticExpansion(expr.left) || exprContainsStaticExpansion(expr.right);
    case "operator_chain":
      return exprContainsStaticExpansion(expr.first) ||
        expr.rest.some((item) => exprContainsStaticExpansion(item.value));
    case "pipe_bind":
      return exprContainsStaticExpansion(expr.value) || exprContainsStaticExpansion(expr.body);
    case "match":
      return exprContainsStaticExpansion(expr.value) ||
        expr.arms.some((arm) => exprContainsStaticExpansion(arm.value));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) => exprContainsStaticExpansion(slot.value));
    case "field":
      return exprContainsStaticExpansion(expr.value) || exprContainsStaticExpansion(expr.key);
    case "range":
      return exprContainsStaticExpansion(expr.start) || exprContainsStaticExpansion(expr.end);
    case "literal":
    case "var":
      return false;
  }
}

function checkStatement(
  stmt: Statement,
  env: Map<string, OwnershipBinding>,
  hostIoImports: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  types: TypeDecl[],
  functions: FnDecl[],
  options: RuntimeCheckOptions,
) {
  if (stmt.kind === "let") {
    const ctx = checkContext(
      env,
      hostIoImports,
      effects,
      diagnostics,
      types,
      functions,
      options,
    );
    const annotated = normalizeExpectedType(explicitTypeAnnotation(stmt.type), ctx);
    checkExpr(
      stmt.value,
      env,
      hostIoImports,
      effects,
      diagnostics,
      annotated?.runtimeType ?? explicitTypeAnnotation(stmt.type),
      types,
      functions,
      options,
    );
    stmt.type = annotated?.runtimeType ?? explicitTypeAnnotation(stmt.type) ??
      exprBindingType(stmt.value, env, types, functions, options);
    ctx.proofFacts.push(...(annotated?.proofFacts ?? []));
    env.set(stmt.name, { moved: false, type: stmt.type });
    return;
  }
  if (stmt.kind === "type_assert") {
    return;
  }
  if (stmt.kind === "destructure_let") {
    checkExpr(
      stmt.value,
      env,
      hostIoImports,
      effects,
      diagnostics,
      undefined,
      types,
      functions,
      options,
    );
    const slots = destructureSlotTypes(stmt.value, types, functions);
    if (slots.length <= 1) {
      diagnostics.push({
        code: "type.destructure_non_multi",
        message: "destructuring let requires a value with multiple runtime result slots",
      });
    } else if (slots.length !== stmt.names.length) {
      diagnostics.push({
        code: "type.destructure_arity",
        message: `destructuring let expected ${slots.length} names but got ${stmt.names.length}`,
      });
    }
    stmt.slotTypes = slots;
    for (let index = 0; index < stmt.names.length; index++) {
      env.set(stmt.names[index], { moved: false, type: slots[index] });
    }
    return;
  }
}

function isStaticBinding(binding: { type?: string } | undefined): boolean {
  return binding?.type === "count" || binding?.type === "type" || binding?.type === "const" ||
    binding?.type?.startsWith("fn(") === true;
}

function isBorrowType(type: string | undefined): boolean {
  return type?.trim().startsWith("&") === true;
}

function stripBorrowType(type: string | undefined): string {
  let current = type?.trim() ?? "";
  while (isBorrowType(current)) current = unwrapPrefixedType(current, "&");
  return current;
}

function isFrozenType(type: string | undefined): boolean {
  return type?.trim().startsWith("#(") === true;
}

function stripFrozenType(type: string | undefined): string {
  let current = type?.trim() ?? "";
  while (isFrozenType(current)) current = unwrapPrefixedType(current, "#");
  return current;
}

function stripReferenceType(type: string | undefined): string {
  let current = type?.trim() ?? "";
  let changed = true;
  while (changed) {
    changed = false;
    if (isBorrowType(current)) {
      current = stripBorrowType(current);
      changed = true;
    }
    if (isFrozenType(current)) {
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
    const char = source[index];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0 && index !== source.length - 1) return false;
    }
  }
  return depth === 0;
}

function destructureSlotTypes(expr: Expr, types: TypeDecl[], functions: FnDecl[]): string[] {
  let returnType: string | undefined;
  if (expr.kind === "call") {
    const callee = expr.callee;
    if (callee.kind === "var") {
      returnType = functions.find((fn) => fn.name === callee.name)?.returnType;
    }
  }
  if (!returnType) return [];
  return runtimeSlotTypes(returnType, types);
}

function runtimeSlotTypes(type: string, types: TypeDecl[]): string[] {
  const structural = structuralSlotTypes(type);
  if (structural) return structural.length > 1 ? structural : [type];
  const decl = findTypeDecl(types, typeNameOf(type));
  if (decl?.normalized?.kind !== "product") return [type];
  const slots = decl.normalized.shape.slots.flatMap((slot) =>
    Array.from({ length: slot.repeat ? Number.parseInt(slot.repeat, 10) : 1 }, () => slot.type)
  );
  return slots.length > 1 ? slots : [type];
}

function structuralSlotTypes(type: string | undefined): string[] | undefined {
  if (!type) return undefined;
  const parsed = parseAnnotationType(type);
  const shape = structuralTypeShape(parsed);
  if (!shape) return undefined;
  const slots: string[] = [];
  for (const slot of shape.slots) {
    const count = slot.repeat?.kind === "count_literal"
      ? Number.parseInt(slot.repeat.source, 10)
      : 1;
    if (!Number.isFinite(count) || count <= 0) return undefined;
    const slotType = renderTypeExpr(slot.type);
    for (let index = 0; index < count; index++) {
      slots.push(slotType);
    }
  }
  return slots;
}

function structuralTypeShape(type: TypeExpr | undefined): TypeShape | undefined {
  if (!type) return undefined;
  if (type.kind === "type_shape") return type.shape;
  if (type.kind !== "type_call") return undefined;
  if (type.callee.kind !== "type_ref" || type.callee.name !== "struct") return undefined;
  const first = type.args[0];
  if (first?.kind !== "type_shape") return undefined;
  return first.shape;
}

function typeNameOf(type: string): string {
  return type.trim().split("(")[0]?.trim() ?? type.trim();
}

function checkExpr(
  expr: Expr,
  env: Map<string, OwnershipBinding>,
  hostIoImports: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expectedType?: string,
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
  options: RuntimeCheckOptions = { recoverTypes: false },
): SynthResult {
  const ctx = checkContext(
    env,
    hostIoImports,
    effects,
    diagnostics,
    types,
    functions,
    options,
  );
  return checkExprAgainst(expr, normalizeExpectedType(expectedType, ctx), ctx);
}

function checkExprAgainst(
  expr: Expr,
  expected: TypeFacts | undefined,
  ctx: CheckContext,
): SynthResult {
  checkExprImpl(
    expr,
    ctx.env,
    ctx.hostIoImports,
    ctx.effects,
    ctx.diagnostics,
    expected?.runtimeType,
    ctx.types,
    ctx.functions,
    ctx.options,
  );
  if (expected) ctx.proofFacts.push(...expected.proofFacts);
  return synthExpr(expr, ctx);
}

function synthExpr(expr: Expr, ctx: CheckContext): SynthResult {
  return {
    type: exprBindingTypeImpl(expr, ctx.env, ctx.types, ctx.functions, ctx.options),
    proofFacts: [],
  };
}

function normalizeExpectedType(
  source: string | undefined,
  ctx: CheckContext,
): TypeFacts | undefined {
  if (!source) return undefined;
  const runtimeType = transparentContractRuntimeType(source, ctx.types) ?? source;
  const base = typeNameOf(source.trim());
  const recordsProof = typeCallArgsForBase(source.trim(), base) !== undefined &&
    findTypeDecl(ctx.types, base) !== undefined;
  return {
    runtimeType,
    proofFacts: recordsProof ? [proofFactFromTypeSource(source)] : [],
  };
}

function transparentContractRuntimeType(source: string, types: TypeDecl[]): string | undefined {
  const trimmed = source.trim();
  const base = typeNameOf(trimmed);
  const args = typeCallArgsForBase(trimmed, base);
  if (args === undefined) return undefined;
  const decl = findTypeDecl(types, base);
  if (!decl || !typeDeclContainsContractCheck(decl, types)) return undefined;
  const runtimeType = resolveAliasType(trimmed, types);
  return runtimeType && runtimeType !== trimmed ? runtimeType : undefined;
}

function typeDeclContainsContractCheck(
  decl: TypeDecl,
  types: TypeDecl[],
  seen = new Set<string>(),
): boolean {
  if (seen.has(decl.name)) return false;
  seen.add(decl.name);
  for (const clause of decl.clauses ?? [decl]) {
    const exprs = [
      ...clause.body.statements.map((stmt) => stmt.value),
      ...(clause.body.expr ? [clause.body.expr] : []),
    ];
    for (const expr of exprs) {
      if (typeExprContainsContractCheck(expr, types, seen)) return true;
    }
  }
  return false;
}

function typeExprContainsContractCheck(
  expr: TypeExpr,
  types: TypeDecl[],
  seen: Set<string>,
): boolean {
  if (expr.kind === "type_call") {
    if (expr.callee.kind === "type_static_ref" && expr.callee.name === "require") return true;
    if (
      expr.callee.kind === "type_ref" &&
      typeDeclContainsContractCheckForName(expr.callee.name, types, seen)
    ) {
      return true;
    }
    return typeExprContainsContractCheck(expr.callee, types, seen) ||
      expr.args.some((arg) => typeExprContainsContractCheck(arg, types, seen));
  }
  if (expr.kind === "type_shape") {
    return expr.shape.slots.some((slot) => typeExprContainsContractCheck(slot.type, types, seen));
  }
  if (expr.kind === "type_match") {
    return typeExprContainsContractCheck(expr.value, types, seen) ||
      expr.arms.some((arm) => typeExprContainsContractCheck(arm.value, types, seen));
  }
  if (expr.kind === "type_scalar_domain") return false;
  if (expr.kind === "type_binary") {
    return typeExprContainsContractCheck(expr.left, types, seen) ||
      typeExprContainsContractCheck(expr.right, types, seen);
  }
  if (expr.kind === "type_fn") {
    return parseAnnotationTypeCalls(expr.source).some((call) =>
      typeExprContainsContractCheck(call, types, seen)
    );
  }
  return false;
}

function typeDeclContainsContractCheckForName(
  name: string,
  types: TypeDecl[],
  seen: Set<string>,
): boolean {
  const decl = types.find((item) =>
    item.name === name || terminalName(item.name) === terminalName(name)
  );
  return decl ? typeDeclContainsContractCheck(decl, types, seen) : false;
}

function proofFactFromTypeSource(source: string): ProofFact {
  const trimmed = source.trim();
  const base = typeNameOf(trimmed);
  const args = typeCallArgsForBase(trimmed, base);
  return {
    source: trimmed,
    contract: terminalName(base),
    args: args === undefined ? [] : splitTypeArgs(args).map((arg) => arg.trim()),
  };
}

function checkTypeVariableMemberProofs(
  block: Extract<Expr, { kind: "block" }>,
  ctx: CheckContext,
  initialProofs: ProofFact[],
) {
  const visitBlock = (item: Extract<Expr, { kind: "block" }>, proofs: ProofFact[]) => {
    const active = [...proofs];
    for (const stmt of item.statements) {
      if (stmt.kind === "let" || stmt.kind === "destructure_let") {
        visitExpr(stmt.value, active);
      }
      if (stmt.kind === "let") {
        active.push(
          ...(normalizeExpectedType(explicitTypeAnnotation(stmt.type), ctx)?.proofFacts ?? []),
        );
      } else if (stmt.kind === "type_assert") {
        active.push(...(normalizeExpectedType(renderTypeExpr(stmt.value), ctx)?.proofFacts ?? []));
      }
    }
    if (item.expr) visitExpr(item.expr, active);
  };
  const visitExpr = (expr: Expr | undefined, proofs: ProofFact[]) => {
    if (!expr) return;
    switch (expr.kind) {
      case "var": {
        const member = expr.name.match(/^([a-z][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/);
        if (
          member &&
          !proofFactsGuaranteeMember(member[1]!, member[2]!, proofs, ctx.types)
        ) {
          ctx.diagnostics.push(diagnosticAt(
            "type.member_requires_proof",
            `type variable ${member[1]}::${member[2]} requires a contract proof in scope`,
            expr,
          ));
        }
        return;
      }
      case "block":
        visitBlock(expr, proofs);
        return;
      case "const_fn":
        visitExpr(expr.body, proofs);
        return;
      case "call":
        visitExpr(expr.callee, proofs);
        for (const arg of expr.args) visitExpr(arg, proofs);
        return;
      case "index":
        visitExpr(expr.target, proofs);
        visitExpr(expr.index, proofs);
        return;
      case "binary":
        visitExpr(expr.left, proofs);
        visitExpr(expr.right, proofs);
        return;
      case "pipe_bind":
        visitExpr(expr.value, proofs);
        visitExpr(expr.body, proofs);
        return;
      case "match":
        visitExpr(expr.value, proofs);
        for (const arm of expr.arms) visitExpr(arm.value, proofs);
        return;
      case "shape":
      case "product_constructor":
        for (const slot of expr.slots) {
          if (slot.index) visitExpr(slot.index, proofs);
          visitExpr(slot.value, proofs);
        }
        return;
      case "static_for_slots":
        if (expr.source.kind === "range") {
          visitExpr(expr.source.start, proofs);
          visitExpr(expr.source.end, proofs);
        } else {
          visitExpr(expr.source.shape, proofs);
        }
        visitExpr(expr.value, proofs);
        return;
      case "field":
        visitExpr(expr.value, proofs);
        visitExpr(expr.key, proofs);
        return;
      case "range":
        visitExpr(expr.start, proofs);
        visitExpr(expr.end, proofs);
        return;
      case "do":
        for (const stmt of expr.statements) {
          if (stmt.kind !== "type_assert" && "value" in stmt) visitExpr(stmt.value, proofs);
        }
        visitExpr(expr.expr, proofs);
        return;
      case "literal":
        return;
    }
  };
  visitBlock(block, initialProofs);
}

function typeExprIsConcreteProofTarget(expr: TypeExpr): boolean {
  switch (expr.kind) {
    case "type_ref":
      return !/^[a-z][A-Za-z0-9_]*$/.test(expr.name) || isPrimitiveTypeName(expr.name);
    case "type_hole":
      return false;
    case "type_call":
      return typeExprIsConcreteProofTarget(expr.callee) &&
        expr.args.every(typeExprIsConcreteProofTarget);
    case "type_members":
      return typeExprIsConcreteProofTarget(expr.target);
    case "type_static_ref":
      return false;
    case "type_fn":
    case "type_shape":
    case "type_match":
    case "type_scalar_domain":
    case "type_binary":
    case "type_bool":
    case "type_number":
    case "type_char":
    case "type_string":
    case "type_literal":
      return true;
  }
}

function isPrimitiveTypeName(name: string): boolean {
  return ["i32", "u32", "i64", "u64", "f32", "f64", "bool", "string"].includes(name);
}

function proofFactsGuaranteeMember(
  receiver: string,
  member: string,
  proofs: ProofFact[],
  types: TypeDecl[],
): boolean {
  for (const proof of proofs) {
    const decl = types.find((item) =>
      item.name === proof.contract || terminalName(item.name) === terminalName(proof.contract)
    );
    if (!decl) continue;
    const requiredMembers = typeDeclRequiredMembers(decl);
    if (!requiredMembers.length && proof.args.includes(receiver)) return true;
    for (const required of requiredMembers) {
      const index = decl.params.findIndex((param) => param.name === required.paramName);
      if (required.member === member && index >= 0 && proof.args[index] === receiver) return true;
    }
  }
  return false;
}

function typeDeclRequiredMembers(decl: TypeDecl): { paramName: string; member: string }[] {
  const required: { paramName: string; member: string }[] = [];
  const visit = (expr: TypeExpr | undefined) => {
    if (!expr) return;
    if (
      expr.kind === "type_call" &&
      expr.callee.kind === "type_static_ref" &&
      expr.callee.name === "type_has_member"
    ) {
      const [target, member] = expr.args;
      if (target?.kind === "type_ref" && member?.kind === "type_literal") {
        required.push({ paramName: target.name, member: member.value });
      }
    }
    switch (expr.kind) {
      case "type_call":
        visit(expr.callee);
        for (const arg of expr.args) visit(arg);
        return;
      case "type_shape":
        for (const slot of expr.shape.slots) visit(slot.type);
        return;
      case "type_match":
        visit(expr.value);
        for (const arm of expr.arms) visit(arm.value);
        return;
      case "type_scalar_domain":
        return;
      case "type_binary":
        visit(expr.left);
        visit(expr.right);
        return;
      case "type_fn":
        for (const call of parseAnnotationTypeCalls(expr.source)) visit(call);
        return;
      case "type_ref":
      case "type_hole":
      case "type_static_ref":
      case "type_bool":
      case "type_number":
      case "type_char":
      case "type_string":
      case "type_literal":
        return;
    }
  };
  for (const clause of decl.clauses ?? [decl]) {
    for (const stmt of clause.body.statements) visit(stmt.value);
    visit(clause.body.expr);
  }
  return required;
}

function checkAmbiguousNullaryInferredCalls(
  block: Extract<Expr, { kind: "block" }>,
  functions: Map<string, FnDecl>,
  diagnostics: Diagnostic[],
) {
  const visit = (expr: Expr | undefined) => {
    if (!expr) return;
    if (expr.kind === "call" && expr.callee.kind === "var") {
      const fn = functions.get(expr.callee.name);
      if (
        fn &&
        !fn.generated &&
        fnUsesInferredTypeVars(fn) &&
        fn.params.length === 0
      ) {
        const missing = [...collectTypeVars(fn)][0] ?? "type";
        diagnostics.push(diagnosticAt(
          "type.inferred_type_ambiguous",
          `cannot infer ${missing} for ${fn.name} without an expected type`,
          expr,
        ));
      }
    }
    for (const child of exprChildren(expr)) visit(child);
  };
  visit(block);
}

function checkContext(
  env: Map<string, OwnershipBinding>,
  hostIoImports: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  types: TypeDecl[],
  functions: FnDecl[],
  options: RuntimeCheckOptions,
  proofFacts: ProofFact[] = [],
): CheckContext {
  return { env, hostIoImports, effects, diagnostics, types, functions, options, proofFacts };
}

function typeFactsForRuntimeType(type: string | undefined): TypeFacts | undefined {
  return type ? { runtimeType: type, proofFacts: [] } : undefined;
}

function checkExprImpl(
  expr: Expr,
  env: Map<string, OwnershipBinding>,
  hostIoImports: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expectedType?: string,
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
  options: RuntimeCheckOptions = { recoverTypes: false },
) {
  switch (expr.kind) {
    case "const_fn": {
      const expectedFn = expectedFunctionType(expectedType, types);
      const signature = expectedFn ? parseExpectedFnType(expectedFn) : undefined;
      if (signature) {
        const nextEnv = new Map(env);
        for (let index = 0; index < expr.params.length; index++) {
          const param = signature.params[index];
          if (param && expr.params[index]) {
            nextEnv.set(expr.params[index], { moved: false, type: param.type });
          }
        }
        checkExpr(
          expr.body,
          nextEnv,
          hostIoImports,
          effects,
          diagnostics,
          signature.returnType,
          types,
          functions,
          options,
        );
        return;
      }
      diagnostics.push({
        code: "const.const_fn_context",
        message: "const fn literal is only valid as an expected const fn argument",
        span: expr.span,
      });
      return;
    }
    case "var": {
      checkProjection(expr.name, env, options.globalValueMap, types, diagnostics);
      if (expr.name === "io" && !env.has("io")) {
        diagnostics.push(diagnosticAt(
          "const.unknown_name",
          "unknown IO executor io; pass an explicit io parameter",
          expr,
        ));
      }
      const projectedType = projectedBindingTypeFromEnvs(
        expr.name,
        env,
        options.globalValueMap,
        types,
      );
      const functionDecl = functionDeclForName(expr.name, functions, options);
      let actualType = projectedType;
      if (!actualType) {
        actualType = functionValueType(functionDecl);
      }
      if (!actualType) {
        actualType = sumVariantConstructorReturnType(
          expr.name,
          [],
          env,
          types,
          functions,
          options,
          expectedType,
        );
      }
      const knownStatic = nameIsStaticLike(expr.name, expectedType, types);
      const knownBinding = bindingNameExists(expr.name, env, options.globalValueMap);
      const knownFunction = functionDecl !== undefined;
      const knownVariant = actualType !== undefined;
      const knownTypeVariableMember = isTypeVariableMemberName(expr.name);
      if (
        expr.name !== "io" && !knownBinding && !knownFunction && !knownVariant &&
        !knownStatic && !knownTypeVariableMember
      ) {
        diagnostics.push(diagnosticAt(
          "const.unknown_name",
          `unknown value ${expr.name}`,
          expr,
        ));
      }
      if (
        expectedType && actualType &&
        !runtimeValueTypeAssignable(expectedType, actualType, types)
      ) {
        diagnostics.push(diagnosticAt(
          "type.literal_mismatch",
          `expected ${expectedType} but got ${actualType}`,
          expr,
        ));
      }
      return;
    }
    case "call": {
      if (expr.tailRec) {
        const currentFn = options.currentFn;
        const targetName = expr.tailRecTarget ?? currentFn?.tailRecTarget ?? currentFn?.name;
        const targetFn = targetName
          ? (targetName === currentFn?.name ? currentFn : options.functionMap?.get(targetName))
          : undefined;
        if (!targetFn) {
          diagnostics.push(diagnosticAt(
            "rec.context",
            "rec(...) is only valid in a runtime function body",
            expr,
          ));
          for (const arg of expr.args) {
            checkExpr(
              arg,
              env,
              hostIoImports,
              effects,
              diagnostics,
              undefined,
              types,
              functions,
              options,
            );
          }
          return;
        }
        const params = runtimeParams(targetFn.params);
        for (let index = 0; index < expr.args.length; index++) {
          const arg = expr.args[index];
          const expected = params[index]?.type;
          checkExpr(
            arg,
            env,
            hostIoImports,
            effects,
            diagnostics,
            expected,
            types,
            functions,
            options,
          );
          const actual = exprBindingType(arg, env, types, functions, options);
          if (
            expected && actual &&
            !runtimeValueTypeAssignable(expected, actual, types)
          ) {
            diagnostics.push(diagnosticAt(
              "type.literal_mismatch",
              `expected ${expected} but got ${actual}`,
              arg,
            ));
          }
        }
        if (
          expectedType &&
          targetFn.returnType &&
          !runtimeValueTypeAssignable(expectedType, targetFn.returnType, types)
        ) {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `expected ${expectedType} but got ${targetFn.returnType}`,
            expr,
          ));
        }
        return;
      }
      const calleeName = expr.callee.kind === "var" ? expr.callee.name : undefined;
      if (calleeName === "return") {
        if (expr.args.length !== 1) {
          diagnostics.push(diagnosticAt(
            "io.return_arity",
            "return(value) expects exactly one argument",
            expr,
          ));
          return;
        }
        if (expectedType && !ioActionItemType(expectedType)) {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `expected ${expectedType} but got io(${
              exprBindingType(expr.args[0]!, env, types, functions, options) ?? "i32"
            })`,
            expr,
          ));
        }
        const itemType = ioActionItemType(expectedType);
        checkExpr(
          expr.args[0]!,
          env,
          hostIoImports,
          effects,
          diagnostics,
          itemType,
          types,
          functions,
          options,
        );
        return;
      }
      let fn: FnDecl | undefined;
      if (calleeName) {
        fn = functionDeclForName(calleeName, functions, options);
        if (
          fn && calleeName.includes("::") && fn.name !== calleeName &&
          !importedFunctionNameMatches(fn.name, calleeName)
        ) {
          fn = undefined;
        }
      }
      if (!fn && callIsStaticTypeExpression(expr, expectedType, types)) {
        return;
      }
      if (
        !fn && calleeName && !calleeName.includes("::") && startsUppercase(terminalName(calleeName))
      ) {
        return;
      }
      let calleeType: string | undefined;
      if (!fn && calleeName) {
        calleeType = projectedBindingTypeFromEnvs(
          calleeName,
          env,
          options.globalValueMap,
          types,
        );
      }
      let calleeSignature: ReturnType<typeof parseFnSignature> | undefined;
      if (!fn && calleeName && calleeType) {
        calleeSignature = parseFnSignature(calleeType);
      }
      let variantReturnType: string | undefined;
      if (!fn && !calleeSignature && calleeName) {
        variantReturnType = sumVariantConstructorReturnType(
          calleeName,
          expr.args,
          env,
          types,
          functions,
          options,
          expectedType,
        );
      }
      if (calleeName !== undefined) {
        const directIntrinsicCall = calleeName.startsWith("@");
        const knownBindingCallee = bindingNameExists(calleeName, env, options.globalValueMap);
        const knownStaticCallee = isStaticBuiltinName(calleeName) ||
          isCompilerSpecialForm(calleeName, "internal");
        const hasCallable = fn !== undefined || calleeSignature !== undefined ||
          variantReturnType !== undefined || hostIoImports.has(calleeName) ||
          directIntrinsicCall || knownStaticCallee || isTypeVariableMemberName(calleeName) ||
          knownBindingCallee;
        if (!hasCallable) {
          diagnostics.push(diagnosticAt(
            "function.unknown",
            `unknown function ${calleeName}`,
            expr.callee,
          ));
        }
      }
      for (let index = 0; index < expr.args.length; index++) {
        const arg = expr.args[index];
        const rawExpected = fn?.params[index]?.type ?? calleeSignature?.params[index] ??
          staticCallArgExpectedType(calleeName, index);
        const expected = normalizeExpectedType(
          rawExpected,
          checkContext(
            env,
            hostIoImports,
            effects,
            diagnostics,
            types,
            functions,
            options,
          ),
        )?.runtimeType ?? rawExpected;
        checkExpr(
          arg,
          env,
          hostIoImports,
          effects,
          diagnostics,
          expected,
          types,
          functions,
          options,
        );
        const actual = exprBindingType(arg, env, types, functions, options);
        if (
          expected && actual &&
          !runtimeValueTypeAssignable(expected, actual, types)
        ) {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `expected ${expected} but got ${actual}`,
            arg,
          ));
        }
      }
      if (calleeName) {
        checkCallClauseDomainCoverage(
          expr,
          calleeName,
          env,
          diagnostics,
          types,
          functions,
          options,
        );
      }
      if (expectedType) {
        const actual = exprBindingType(expr, env, types, functions, options);
        if (actual && !runtimeValueTypeAssignable(expectedType, actual, types)) {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `expected ${expectedType} but got ${actual}`,
            expr,
          ));
        }
      }
      return;
    }
    case "index":
      checkExpr(
        expr.target,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      checkExpr(
        expr.index,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      checkDirectIndex(expr, env, types, functions, diagnostics, options);
      return;
    case "binary":
      if (expr.op === "==" || expr.op === "!=") {
        checkExpr(
          expr.left,
          env,
          hostIoImports,
          effects,
          diagnostics,
          undefined,
          types,
          functions,
          options,
        );
        const leftType = exprBindingType(expr.left, env, types, functions, options);
        checkExpr(
          expr.right,
          env,
          hostIoImports,
          effects,
          diagnostics,
          leftType,
          types,
          functions,
          options,
        );
      } else {
        checkExpr(
          expr.left,
          env,
          hostIoImports,
          effects,
          diagnostics,
          numericExpectedType(expectedType),
          types,
          functions,
          options,
        );
        checkExpr(
          expr.right,
          env,
          hostIoImports,
          effects,
          diagnostics,
          numericExpectedType(expectedType),
          types,
          functions,
          options,
        );
      }
      if (expectedType) {
        const actual = exprBindingType(expr, env, types, functions, options);
        if (actual && !runtimeValueTypeAssignable(expectedType, actual, types)) {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `expected ${expectedType} but got ${actual}`,
            expr,
          ));
        }
      }
      return;
    case "pipe_bind": {
      checkExpr(
        expr.value,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      if (expr.value.kind === "var") {
        const binding = env.get(expr.value.name);
        if (binding) binding.moved = true;
      }
      const scoped = new Map(env);
      scoped.set(expr.name, {
        moved: false,
        type: exprBindingType(expr.value, env, types, functions, options),
      });
      checkExpr(
        expr.body,
        scoped,
        hostIoImports,
        effects,
        diagnostics,
        expectedType,
        types,
        functions,
        options,
      );
      return;
    }
    case "match":
      checkExpr(
        expr.value,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      const matchValueType = exprBindingType(
        expr.value,
        env,
        types,
        functions,
        options,
      );
      rewriteContextualEnumPatternsInMatch(expr, matchValueType, types, diagnostics);
      checkRuntimeMatchCoverage(expr, matchValueType, diagnostics, types);
      for (const arm of expr.arms) {
        const armEnv = narrowedEnvForMatchPattern(expr.value, arm.pattern, env, types, functions);
        bindMatchPatternLocals(arm.pattern, matchValueType, armEnv, diagnostics, types);
        if (arm.guard) {
          checkExpr(
            arm.guard,
            armEnv,
            hostIoImports,
            effects,
            diagnostics,
            "bool",
            types,
            functions,
            options,
          );
          const guardType = exprBindingType(arm.guard, armEnv, types, functions, options);
          if (guardType && !runtimeValueTypeAssignable("bool", guardType, types)) {
            diagnostics.push(diagnosticAt(
              "type.guard",
              `match guard must be bool, got ${guardType}`,
              arm.guard,
            ));
          }
        }
        checkExpr(
          arm.value,
          armEnv,
          hostIoImports,
          effects,
          diagnostics,
          expectedType,
          types,
          functions,
          options,
        );
      }
      return;
    case "shape":
      if (expr.slots.some((slot) => slot.spread || slot.index)) {
        if (expr.syntax === "record" && expr.slots.some((slot) => slot.index)) {
          checkFixedCollectionUpdateLiteral(
            expr,
            env,
            hostIoImports,
            effects,
            diagnostics,
            inlineArrayLikeTypeArgs(expectedType, types),
            types,
            functions,
            options,
          );
        } else if (expr.syntax === "record") {
          checkProductSpreadLiteral(
            expr,
            env,
            hostIoImports,
            effects,
            diagnostics,
            expectedType ?? expr.inferredType,
            types,
            functions,
            options,
          );
        } else {
          checkInlineArraySpreadLiteral(
            expr,
            env,
            hostIoImports,
            effects,
            diagnostics,
            expectedType,
            types,
            functions,
            options,
          );
        }
        return;
      }
      for (const slot of expr.slots) {
        checkExpr(
          slot.value,
          env,
          hostIoImports,
          effects,
          diagnostics,
          options.recoverTypes ? expectedShapeSlotType(expectedType, slot.label, types) : undefined,
          types,
          functions,
          options,
        );
      }
      return;
    case "product_constructor":
      for (const slot of expr.slots) {
        checkExpr(
          slot.value,
          env,
          hostIoImports,
          effects,
          diagnostics,
          options.recoverTypes
            ? productConstructorSlotType(expr.constructor, slot.label, types)
            : undefined,
          types,
          functions,
          options,
        );
      }
      return;
    case "range":
      checkExpr(
        expr.start,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      checkExpr(
        expr.end,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      return;
    case "static_for_slots":
      checkExpr(
        expr.value,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      return;
    case "field":
      checkExpr(
        expr.value,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      checkExpr(
        expr.key,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      return;
    case "block":
      checkBlock(
        expr,
        new Map(env),
        hostIoImports,
        effects,
        diagnostics,
        expectedType,
        types,
        functions,
        options,
      );
      return;
    case "literal":
      const refinedExpectedType = resolveAliasType(expectedType, types) ?? expectedType;
      if (refinedExpectedType && parseRefinedI32Type(refinedExpectedType)) {
        const value = staticIntegerLiteral(expr);
        if (value !== undefined && refinedI32ContainsLiteral(refinedExpectedType, value)) {
          expr.inferredType = refinedI32TypeCanonical(refinedExpectedType);
        } else {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `literal ${expr.value} is not assignable to ${expectedType}`,
            expr,
          ));
        }
        return;
      }
      if (refinedExpectedType && literalTypeMembers(refinedExpectedType)) {
        if (literalExprFitsType(expr, refinedExpectedType)) {
          expr.inferredType = canonicalLiteralType(refinedExpectedType);
        } else {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `literal ${expr.value} is not assignable to ${expectedType}`,
            expr,
          ));
        }
      }
      if (expr.literalKind === "number") {
        const literalType = numericLiteralExplicitType(expr.value);
        if (literalType) {
          expr.inferredType = literalType;
          if (
            expectedType &&
            !explicitNumericLiteralTypeAssignable(
              resolveAliasType(expectedType, types) ?? expectedType,
              literalType,
              types,
            )
          ) {
            diagnostics.push(diagnosticAt(
              "type.literal_mismatch",
              `expected ${expectedType} but got ${literalType}`,
              expr,
            ));
          }
        } else {
          const inferredType = contextualNumericLiteralType(expectedType, expr.value, types);
          if (inferredType) {
            expr.inferredType = inferredType;
          } else if (expectedType && numericLiteralCanMatchType(expectedType, types)) {
            diagnostics.push(diagnosticAt(
              "type.literal_mismatch",
              `literal ${expr.value} is not assignable to ${expectedType}`,
              expr,
            ));
          }
        }
      }
      return;
  }
}

function borrowedCallArgIndexes(
  expr: Extract<Expr, { kind: "call" }>,
  functions: FnDecl[],
): Set<number> {
  if (expr.callee.kind !== "var") return new Set();
  const calleeName = expr.callee.name;
  const fn = functions.find((fn) => fn.name === calleeName);
  const intrinsicId = fn ? intrinsicWrapperId(fn) : undefined;
  return new Set();
}

function exprBindingType(
  expr: Expr,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
  options: boolean | RuntimeCheckOptions = false,
): string | undefined {
  const runtimeOptions = typeof options === "boolean" ? { recoverTypes: options } : options;
  return synthExpr(
    expr,
    checkContext(
      env,
      new Map(),
      [],
      [],
      types,
      functions,
      runtimeOptions,
    ),
  ).type;
}

function exprBindingTypeImpl(
  expr: Expr,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
  options: boolean | RuntimeCheckOptions = false,
): string | undefined {
  const recoverTypes = typeof options === "boolean" ? options : options.recoverTypes;
  const cache = typeof options === "boolean" ? undefined : options.bindingTypeCache;
  const memo = typeof options === "boolean" ? undefined : options.memo;
  const structuralKey = memo ? exprBindingTypeMemoKey(expr, env, types) : undefined;
  if (structuralKey && memo!.exprBindingType.has(structuralKey)) {
    return memo!.exprBindingType.get(structuralKey);
  }
  const cached = cache?.get(expr);
  if (cached !== undefined) return cached ?? undefined;
  const finish = (type: string | undefined) => {
    cache?.set(expr, type ?? null);
    if (structuralKey) memo!.exprBindingType.set(structuralKey, type);
    return type;
  };
  if (expr.kind === "var") {
    const projected = projectedBindingTypeFromEnvs(
      expr.name,
      env,
      typeof options === "boolean" ? undefined : options.globalValueMap,
      types,
    );
    if (projected) return finish(projected);
    if (typeof options !== "boolean") {
      const functionType = functionValueType(functionDeclForName(expr.name, functions, options));
      if (functionType) return finish(functionType);
      return finish(sumVariantConstructorReturnType(
        expr.name,
        [],
        env,
        types,
        functions,
        options,
      ));
    }
    return finish(undefined);
  }
  if (expr.kind === "call" && expr.tailRec) {
    let currentFn: FnDecl | undefined;
    if (typeof options !== "boolean") {
      currentFn = options.currentFn;
      const targetName = expr.tailRecTarget ?? currentFn?.tailRecTarget;
      if (targetName && targetName !== currentFn?.name) {
        currentFn = options.functionMap?.get(targetName) ?? currentFn;
      }
    }
    return finish(currentFn?.returnType);
  }
  if (expr.kind === "call" && isIoReturnCall(expr)) {
    return finish(
      expr.args.length === 1
        ? `io(${exprBindingType(expr.args[0]!, env, types, functions, options) ?? "i32"})`
        : "io(i32)",
    );
  }
  if (expr.kind === "binary") {
    if (booleanBinaryOp(expr.op)) return finish("bool");
    if (comparisonBinaryOp(expr.op)) return finish("bool");
    const facts = exprI32Facts(expr, env, types, functions, options);
    if (facts) return finish(renderRefinedI32Domain(facts.domain));
    if (arithmeticBinaryOp(expr.op)) {
      const left = scalarDomainRuntimeType(
        exprBindingType(expr.left, env, types, functions, options),
      );
      const right = scalarDomainRuntimeType(
        exprBindingType(expr.right, env, types, functions, options),
      );
      if (left === "i32" && right === "i32") return finish("i32");
    }
  }
  if (expr.kind === "operator_chain") {
    const type = inferOperatorChainResultType(
      expr,
      (child) => exprBindingType(child, env, types, functions, options),
    );
    if (type) return finish(type);
  }
  if (expr.kind === "call") {
    const operation = i32BinaryOperation(expr, functions, options);
    if (operation && comparisonBinaryOp(operation.op)) return finish("bool");
    const facts = exprI32Facts(expr, env, types, functions, options);
    if (facts) return finish(renderRefinedI32Domain(facts.domain));
    const callee = expr.callee;
    if (callee.kind === "var") {
      const callKey = memo ? callCheckMemoKey(expr, env) : undefined;
      const cachedCall = callKey ? memo!.callCheck.get(callKey) : undefined;
      if (cachedCall) return finish(cachedCall.returnType);
      let returnType: string | undefined;
      if (typeof options !== "boolean") {
        returnType = functionDeclForName(callee.name, functions, options)?.returnType;
      } else {
        returnType = functions.find((fn) => fn.name === callee.name)?.returnType;
      }
      if (!returnType) {
        const calleeType = projectedBindingTypeFromEnvs(
          callee.name,
          env,
          typeof options === "boolean" ? undefined : options.globalValueMap,
          types,
        );
        if (calleeType) {
          returnType = parseFnSignature(calleeType)?.returnType;
        }
      }
      if (!returnType && typeof options !== "boolean") {
        returnType = sumVariantConstructorReturnType(
          callee.name,
          expr.args,
          env,
          types,
          functions,
          options,
        );
      }
      if (callKey) memo!.callCheck.set(callKey, { returnType });
      return finish(returnType);
    }
  }
  if (expr.kind === "product_constructor") {
    const type = (typeof options === "boolean" ? undefined : options.typeConstructorMap)?.get(
      expr.constructor,
    ) ?? typeDeclIndex(types).productByConstructor.get(expr.constructor);
    return finish(type?.name);
  }
  if (expr.kind === "shape") {
    if (expr.inferredType) return finish(expr.inferredType);
    if (!expr.slots.some((slot) => slot.spread || slot.index)) {
      const slots: string[] = [];
      for (const slot of expr.slots) {
        const label = slot.label ? `${slot.label}: ` : "";
        const slotType = exprBindingType(slot.value, env, types, functions, options) ??
          literalRuntimeType(slot.value) ?? "i32";
        slots.push(`${label}${slotType}`);
      }
      return finish(`struct({${slots.join(", ")}})`);
    }
    return finish(inferExprType(
      expr,
      {
        functions: new Map(functions.map((fn) => [fn.name, fn])),
        typeConstructors: (typeof options === "boolean" ? undefined : options.typeConstructorMap) ??
          typeDeclIndex(types).productByConstructor,
        types,
      },
      new Map([...env].map(([name, binding]) => [name, binding.type ?? ""])),
    ));
  }
  if (expr.kind === "pipe_bind") {
    return finish(exprBindingType(expr.body, env, types, functions, options));
  }
  if (expr.kind === "match") {
    const armTypes = expr.arms.map((arm) =>
      exprBindingType(arm.value, env, types, functions, options)
    );
    const first = armTypes[0];
    if (first && armTypes.every((type) => type === first)) return finish(first);
  }
  if (expr.kind === "range") return finish("range_i32");
  if (expr.kind === "literal") return finish(expr.inferredType);
  if (recoverTypes) return finish(recoveredExprType(expr, env, types, functions));
  return finish(undefined);
}

function exprBindingTypeMemoKey(
  expr: Expr,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
): string | undefined {
  const exprKey = structuralExprKey(expr);
  if (!exprKey) return undefined;
  return `${exprKey}\0${ownershipEnvKey(env)}\0${types.map((type) => type.name).sort().join(",")}`;
}

function callCheckMemoKey(
  expr: Extract<Expr, { kind: "call" }>,
  env: Map<string, OwnershipBinding>,
): string | undefined {
  const exprKey = structuralExprKey(expr);
  if (!exprKey) return undefined;
  return `${exprKey}\0${ownershipEnvKey(env)}`;
}

function arithmeticBinaryOp(op: string): boolean {
  return op === "+" || op === "-" || op === "*" || op === "/" || op === "%";
}

function comparisonBinaryOp(op: string): boolean {
  return op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=";
}

function booleanBinaryOp(op: string): boolean {
  return op === "&&" || op === "||" || op === "^^";
}

function i32BinaryOperation(
  expr: Expr,
  functions: FnDecl[],
  options: boolean | RuntimeCheckOptions = false,
): { op: string; left: Expr; right: Expr } | undefined {
  if (expr.kind === "binary") return { op: expr.op, left: expr.left, right: expr.right };
  if (expr.kind !== "call" || expr.callee.kind !== "var" || expr.args.length !== 2) {
    return undefined;
  }
  let runtimeOptions: RuntimeCheckOptions;
  if (typeof options === "boolean") {
    runtimeOptions = { recoverTypes: options };
  } else {
    runtimeOptions = options;
  }
  const fn = functionDeclForName(expr.callee.name, functions, runtimeOptions);
  if (!fn || fn.params.length !== 2) return undefined;
  const leftParam = scalarDomainRuntimeType(fn.params[0]?.type) ?? fn.params[0]?.type;
  const rightParam = scalarDomainRuntimeType(fn.params[1]?.type) ?? fn.params[1]?.type;
  if (leftParam !== "i32" || rightParam !== "i32") return undefined;
  const bodyExpr = fn.body.expr;
  if (bodyExpr?.kind !== "call" || bodyExpr.callee.kind !== "var") return undefined;
  const op = primitiveI32OperationName(bodyExpr.callee.name);
  if (!op) return undefined;
  return { op, left: expr.args[0]!, right: expr.args[1]! };
}

function primitiveI32OperationName(name: string): string | undefined {
  let intrinsic: string | undefined;
  if (name.startsWith("@i32_")) intrinsic = name.slice("@i32_".length);
  let member: string | undefined;
  if (name.includes("i32::")) {
    member = name.slice(name.lastIndexOf("i32::") + "i32::".length);
  }
  const op = intrinsic ?? member;
  if (op === "add") return "+";
  if (op === "sub") return "-";
  if (op === "mul") return "*";
  if (op === "div") return "/";
  if (op === "rem") return "%";
  if (op === "eql") return "==";
  if (op === "neq") return "!=";
  if (op === "lt") return "<";
  if (op === "lte") return "<=";
  if (op === "gt") return ">";
  if (op === "gte") return ">=";
  return undefined;
}

function exprI32Facts(
  expr: Expr,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
  options: boolean | RuntimeCheckOptions,
): ReturnType<typeof scalarFactsFromI32Range> | undefined {
  const recoverTypes = typeof options === "boolean" ? options : options.recoverTypes;
  const cache = typeof options === "boolean" ? undefined : options.i32FactsCache;
  const cached = cache?.get(expr);
  if (cached !== undefined) return cached ?? undefined;
  const finish = (facts: ReturnType<typeof scalarFactsFromI32Range> | undefined) => {
    cache?.set(expr, facts ?? null);
    return facts;
  };
  const literal = staticIntegerLiteral(expr);
  if (literal !== undefined) {
    return finish(
      literal >= I32_MIN && literal <= I32_MAX
        ? scalarFactsFromI32Range({ min: literal, max: literal })
        : undefined,
    );
  }
  if (expr.kind === "var") {
    const type = resolveAliasType(projectedBindingType(expr.name, env, types), types) ??
      projectedBindingType(expr.name, env, types);
    return finish(scalarFactsFromRefinedI32Type(type));
  }
  const operation = i32BinaryOperation(expr, functions, options);
  if (!operation) return finish(undefined);
  const left = exprI32Range(operation.left, env, types, functions, options);
  const right = exprI32Range(operation.right, env, types, functions, options);
  if (!left || !right) return finish(undefined);
  if (operation.op === "+") {
    return finish(i32FactsFromRangeBounds(left.min + right.min, left.max + right.max));
  }
  if (operation.op === "-") {
    return finish(i32FactsFromRangeBounds(left.min - right.max, left.max - right.min));
  }
  if (operation.op === "*") {
    const products = [
      left.min * right.min,
      left.min * right.max,
      left.max * right.min,
      left.max * right.max,
    ];
    return finish(i32FactsFromRangeBounds(Math.min(...products), Math.max(...products)));
  }
  const divisor = staticIntegerLiteral(operation.right);
  if (divisor === undefined || divisor <= 0 || left.min < 0) return finish(undefined);
  if (operation.op === "/") {
    return finish(scalarFactsFromI32Range({ min: 0, max: Math.floor(left.max / divisor) }));
  }
  if (operation.op === "%") {
    return finish(scalarFactsFromI32Range({ min: 0, max: divisor - 1 }));
  }
  return finish(undefined);
}

function exprI32Range(
  expr: Expr,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
  options: boolean | RuntimeCheckOptions,
): { min: number; max: number } | undefined {
  return exprI32Facts(expr, env, types, functions, options)?.range;
}

function i32FactsFromRangeBounds(
  min: number,
  max: number,
): ReturnType<typeof scalarFactsFromI32Range> | undefined {
  return min >= I32_MIN && max <= I32_MAX ? scalarFactsFromI32Range({ min, max }) : undefined;
}

function recoveredExprType(
  expr: Expr,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
): string | undefined {
  const flatEnv = new Map([...env].map(([name, binding]) => [name, binding.type ?? ""] as const));
  for (const [name, type] of [...flatEnv]) {
    if (!type) flatEnv.delete(name);
  }
  const constructorTypes = new Map(
    types.flatMap((decl): [string, TypeDecl][] =>
      decl.normalized?.kind === "product" ? [[decl.normalized.constructor, decl]] : []
    ),
  );
  return inferRuntimeType(
    expr,
    flatEnv,
    new Map(functions.map((fn) => [fn.name, fn])),
    constructorTypes,
  );
}

function expectedShapeSlotType(
  expectedType: string | undefined,
  label: string | undefined,
  types: TypeDecl[],
): string | undefined {
  if (!label) return undefined;
  const structural = structuralProductSlotsForType(expectedType, types);
  const structuralSlot = structural?.find((slot) => slot.label === label);
  if (structuralSlot) return structuralSlot.type;
  const resolved = resolveAliasType(expectedType, types);
  const decl = types.find((item) => item.name === typeNameOf(resolved ?? ""));
  if (decl?.normalized?.kind !== "product") return undefined;
  return decl.normalized.shape.slots.find((slot) => slot.label === label)?.type;
}

function checkProductSpreadLiteral(
  expr: Extract<Expr, { kind: "shape" }>,
  env: Map<string, OwnershipBinding>,
  hostIoImports: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expectedType: string | undefined,
  types: TypeDecl[],
  functions: FnDecl[],
  options: RuntimeCheckOptions,
) {
  const functionMap = new Map(functions.map((fn) => [fn.name, fn]));
  let targetSlots = structuralProductSlotsForType(expectedType, types, functionMap);
  const hasFixedTarget = !!targetSlots;
  const targetByLabel = () =>
    new Map((targetSlots ?? []).filter((slot) => slot.label).map((slot) => [slot.label!, slot]));
  const merged = new Set<string>();

  for (const slot of expr.slots) {
    if (slot.index) {
      diagnostics.push(diagnosticAt(
        "product.spread_index",
        "product spread literals do not support indexed override entries",
        slot,
      ));
      continue;
    }
    if (slot.spread) {
      checkExpr(
        slot.value,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      const sourceType = exprBindingType(slot.value, env, types, functions, options);
      const sourceSlots = structuralProductSlotsForType(sourceType, types, functionMap);
      if (!sourceSlots) {
        diagnostics.push(diagnosticAt(
          "product.spread_source",
          "product spread source must have a product type",
          slot,
        ));
        continue;
      }
      if (!targetSlots) targetSlots = sourceSlots;
      const target = targetByLabel();
      for (const sourceSlot of sourceSlots) {
        if (!sourceSlot.label) continue;
        if (!hasFixedTarget || target.has(sourceSlot.label)) merged.add(sourceSlot.label);
      }
      continue;
    }
    if (!slot.label) {
      diagnostics.push(diagnosticAt(
        "product.spread_field",
        "product spread literals require labeled fields",
        slot,
      ));
      checkExpr(
        slot.value,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      continue;
    }
    let target = targetByLabel();
    const actualSlotType = exprBindingType(slot.value, env, types, functions, options) ??
      literalRuntimeType(slot.value) ?? "i32";
    if (!hasFixedTarget && !target.has(slot.label)) {
      targetSlots = [...(targetSlots ?? []), { label: slot.label, type: actualSlotType }];
      target = targetByLabel();
    }
    const expectedSlotType = target.get(slot.label)?.type;
    checkExpr(
      slot.value,
      env,
      hostIoImports,
      effects,
      diagnostics,
      expectedSlotType,
      types,
      functions,
      options,
    );
    if (hasFixedTarget && !expectedSlotType) {
      diagnostics.push(diagnosticAt(
        "product.spread_unknown_field",
        `product spread target has no field ${slot.label}`,
        slot,
      ));
    }
    merged.add(slot.label);
  }

  if (!targetSlots) {
    diagnostics.push(diagnosticAt(
      "product.spread_target",
      "product spread literal requires an expected product type or product spread source",
      expr,
    ));
    return;
  }

  for (const targetSlot of targetSlots) {
    if (targetSlot.label && !merged.has(targetSlot.label)) {
      diagnostics.push(diagnosticAt(
        "product.spread_missing_field",
        `product spread literal is missing field ${targetSlot.label}`,
        expr,
      ));
    }
  }
}

function checkInlineArraySpreadLiteral(
  expr: Extract<Expr, { kind: "shape" }>,
  env: Map<string, OwnershipBinding>,
  hostIoImports: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expectedType: string | undefined,
  types: TypeDecl[],
  functions: FnDecl[],
  options: RuntimeCheckOptions,
) {
  const hasOverrides = expr.slots.some((slot) => slot.index);
  if (hasOverrides) {
    diagnostics.push(diagnosticAt(
      "collection.fixed_update_square_syntax",
      "indexed fixed-array updates use square brackets, for example [...xs, [i]: value]",
      expr,
    ));
  }
  for (const slot of expr.slots) {
    if (slot.label) {
      diagnostics.push(diagnosticAt(
        "collection.spread_labeled",
        "spread entries are only valid in unlabeled collection literals",
        slot,
      ));
    }
    if (slot.index && slot.spread) {
      diagnostics.push(diagnosticAt(
        "collection.indexed_spread",
        "collection override entries cannot also be spread entries",
        slot,
      ));
    }
  }
  const expected = inlineArrayLikeTypeArgs(expectedType, types);
  if (!expected) {
    diagnostics.push(diagnosticAt(
      "collection.expected_type",
      "collection spread literal requires an expected inline_array or inline_array_list type",
      expr,
    ));
  }
  if (hasOverrides) {
    return;
  }
  const itemType = expected?.itemType;
  let itemCount = expr.slots.filter((slot) => !slot.spread).length;
  for (const slot of expr.slots) {
    if (slot.spread) {
      checkExpr(
        slot.value,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      const actual = inlineArrayLikeTypeArgs(
        exprBindingType(slot.value, env, types, functions, options),
        types,
      );
      if (!actual || actual.kind !== "inline_array_list") {
        diagnostics.push(diagnosticAt(
          "collection.spread_tail_type",
          "spread tail must have inline_array_list type",
          slot,
        ));
      } else {
        itemCount += actual.count;
        if (itemType && !typeMatches(itemType, actual.itemType)) {
          diagnostics.push(diagnosticAt(
            "collection.spread_item_type",
            `spread tail item type ${actual.itemType} does not match expected ${itemType}`,
            slot,
          ));
        }
      }
    } else {
      checkExpr(
        slot.value,
        env,
        hostIoImports,
        effects,
        diagnostics,
        itemType,
        types,
        functions,
        options,
      );
    }
  }
  if (expected && Number.isFinite(expected.count) && itemCount !== expected.count) {
    diagnostics.push(diagnosticAt(
      "collection.spread_arity",
      `collection literal has ${itemCount} items but expected ${expected.count}`,
      expr,
    ));
  }
}

function checkFixedCollectionUpdateLiteral(
  expr: Extract<Expr, { kind: "shape" }>,
  env: Map<string, OwnershipBinding>,
  hostIoImports: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expected:
    | { kind: "inline_array" | "inline_array_list"; count: number; itemType: string }
    | undefined,
  types: TypeDecl[],
  functions: FnDecl[],
  options: RuntimeCheckOptions,
) {
  if (!expected || expected.kind !== "inline_array") {
    diagnostics.push(diagnosticAt(
      "collection.fixed_update_target",
      "indexed collection override requires an expected fixed inline_array target type",
      expr,
    ));
  }
  const spreads = expr.slots.filter((slot) => slot.spread);
  const overrides = expr.slots.filter((slot) => slot.index);
  if (spreads.length !== 1) {
    diagnostics.push(diagnosticAt(
      "collection.fixed_update_spread",
      "indexed collection override requires exactly one spread source",
      expr,
    ));
  }
  if (overrides.length === 0) {
    diagnostics.push(diagnosticAt(
      "collection.fixed_update_override",
      "indexed collection override requires at least one indexed override entry",
      expr,
    ));
  }
  for (const slot of expr.slots) {
    if (!slot.spread && !slot.index) {
      diagnostics.push(diagnosticAt(
        "collection.fixed_update_item",
        "indexed collection override literals only support a fixed spread source and override entries",
        slot,
      ));
    }
  }
  const itemType = expected?.itemType;
  for (const slot of expr.slots) {
    if (slot.spread) {
      checkExpr(
        slot.value,
        env,
        hostIoImports,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      const actual = inlineArrayLikeTypeArgs(
        exprBindingType(slot.value, env, types, functions, options),
        types,
      );
      if (!actual || actual.kind !== "inline_array") {
        diagnostics.push(diagnosticAt(
          "collection.fixed_update_source",
          "indexed collection override spread source must have fixed inline_array type",
          slot,
        ));
      } else if (expected) {
        if (
          Number.isFinite(actual.count) && Number.isFinite(expected.count) &&
          actual.count !== expected.count
        ) {
          diagnostics.push(diagnosticAt(
            "collection.fixed_update_size",
            `spread source has size ${actual.count} but expected ${expected.count}`,
            slot,
          ));
        }
        if (!typeMatches(expected.itemType, actual.itemType)) {
          diagnostics.push(diagnosticAt(
            "collection.fixed_update_item_type",
            `spread source item type ${actual.itemType} does not match expected ${expected.itemType}`,
            slot,
          ));
        }
      }
      continue;
    }
    if (!slot.index) continue;
    checkExpr(
      slot.index,
      env,
      hostIoImports,
      effects,
      diagnostics,
      undefined,
      types,
      functions,
      options,
    );
    checkExpr(
      slot.value,
      env,
      hostIoImports,
      effects,
      diagnostics,
      itemType,
      types,
      functions,
      options,
    );
    const actualValueType = exprBindingType(slot.value, env, types, functions, options) ??
      literalRuntimeType(slot.value);
    if (itemType && actualValueType && !typeMatches(itemType, actualValueType)) {
      diagnostics.push(diagnosticAt(
        "collection.fixed_update_value_type",
        `collection override value type ${actualValueType} does not match expected ${itemType}`,
        slot.value,
      ));
    }
    const literalIndex = staticIntegerLiteral(slot.index);
    if (
      expected && literalIndex !== undefined && (literalIndex < 0 || literalIndex >= expected.count)
    ) {
      diagnostics.push(diagnosticAt(
        "collection.fixed_update_index_bounds",
        `collection override index ${literalIndex} is out of bounds for size ${expected.count}`,
        slot.index,
      ));
    }
  }
}

function staticIntegerLiteral(expr: Expr): number | undefined {
  if (expr.kind !== "literal" || expr.literalKind !== "number") return undefined;
  return staticIntegerNumberLiteral(expr.value);
}

function literalRuntimeType(expr: Expr): string | undefined {
  if (expr.kind !== "literal") return undefined;
  if (expr.literalKind === "number") return numericLiteralExplicitType(expr.value) ?? "i32";
  if (expr.literalKind === "bool") return "bool";
  if (expr.literalKind === "char") return "char";
  if (expr.literalKind === "string" || expr.literalKind === "multiline") return "string";
  if (expr.literalKind === "literalType") return "literal";
  return expr.inferredType;
}

function inlineArrayLikeTypeArgs(
  type: string | undefined,
  types: TypeDecl[],
): { kind: "inline_array" | "inline_array_list"; count: number; itemType: string } | undefined {
  const resolved = resolveAliasType(type, types)?.trim();
  if (!resolved) return undefined;
  const tupleRepeat = resolved.match(/^\[\s*(.+?)\s*;\s*([0-9]+)\s*\]$/);
  if (tupleRepeat) {
    return {
      kind: "inline_array",
      count: Number.parseInt(tupleRepeat[2], 10),
      itemType: tupleRepeat[1].trim(),
    };
  }
  const shapeRepeat = resolved.match(/^\{\s*([0-9]+)\s*\*\s*(.+?)\s*\}$/);
  if (shapeRepeat) {
    return {
      kind: "inline_array",
      count: Number.parseInt(shapeRepeat[1], 10),
      itemType: shapeRepeat[2].trim(),
    };
  }
  const decl = findTypeDecl(types, typeNameOf(resolved));
  if (decl?.normalized?.kind === "product") {
    const slot = decl.normalized.shape.slots[0];
    if (decl.normalized.shape.slots.length === 1 && !slot.label && slot.repeat) {
      const args = typeCallArgsForBase(resolved, typeNameOf(resolved));
      const argValues = args === undefined ? [] : splitTypeArgs(args);
      const bindings = new Map(decl.params.map((param, index) => [param.name, argValues[index]]));
      const repeat = substituteSignatureTypeArgs(slot.repeat, bindings);
      const itemType = substituteSignatureTypeArgs(slot.type, bindings);
      const constructor = decl.normalized.constructor.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
      const typeName = terminalName(decl.name);
      return {
        kind: constructor.startsWith("InlineArrayList(") || typeName === "InlineArrayList"
          ? "inline_array_list"
          : "inline_array",
        count: Number.parseInt(repeat, 10),
        itemType,
      };
    }
  }
  const unqualified = resolved.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
  const base = unqualified.startsWith("InlineArrayList(")
    ? "InlineArrayList"
    : unqualified.startsWith("InlineArray(")
    ? "InlineArray"
    : undefined;
  if (!base || !unqualified.endsWith(")")) return undefined;
  const args = splitTypeArgs(unqualified.slice(`${base}(`.length, -1));
  const count = Number.parseInt(args[0]?.trim() ?? "", 10);
  const itemType = args[1]?.trim();
  if (!itemType) return undefined;
  return {
    kind: base === "InlineArrayList" ? "inline_array_list" : "inline_array",
    count,
    itemType,
  };
}

function compactArrayTypeArgs(
  type: string | undefined,
  types: TypeDecl[],
): { count: number; itemType: string } | undefined {
  const candidates = [type?.trim(), resolveAliasType(type, types)?.trim()].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    const unqualified = candidate.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
    if (!unqualified.startsWith("CompactArray(") || !unqualified.endsWith(")")) continue;
    const args = splitTypeArgs(unqualified.slice("CompactArray(".length, -1));
    const count = Number.parseInt(args[0]?.trim() ?? "", 10);
    const itemType = args[1]?.trim();
    if (Number.isFinite(count) && itemType) return { count, itemType };
  }
  return undefined;
}

function compactArrayMemberBase(type: string | undefined, types: TypeDecl[]): string | undefined {
  const candidates = [type?.trim(), resolveAliasType(type, types)?.trim()].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    const typeName = typeNameOf(candidate);
    if (terminalName(typeName) === "CompactArray") return typeName;
  }
  return undefined;
}

function productConstructorSlotType(
  constructor: string,
  label: string | undefined,
  types: TypeDecl[],
): string | undefined {
  if (!label) return undefined;
  const decl = types.find((item) =>
    item.normalized?.kind === "product" && item.normalized.constructor === constructor
  );
  return decl?.normalized?.kind === "product"
    ? decl.normalized.shape.slots.find((slot) => slot.label === label)?.type
    : undefined;
}

function projectedBindingType(
  name: string,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
): string | undefined {
  return projectedBindingTypeFromEnvs(name, env, undefined, types);
}

function projectedBindingTypeFromEnvs(
  name: string,
  env: Map<string, OwnershipBinding>,
  globals: Map<string, OwnershipBinding> | undefined,
  types: TypeDecl[],
): string | undefined {
  const exact = env.get(name) ?? globals?.get(name);
  if (exact) return exact.type;
  const [baseProjection, ...fields] = name.split(".");
  const base = rootBindingName(baseProjection);
  let binding = env.get(base);
  if (!binding) {
    binding = globals?.get(base);
  }
  let current = binding?.type;
  const indexes = [...baseProjection.matchAll(/\[[0-9]+\]/g)];
  for (const _index of indexes) {
    current = inlineArrayLikeTypeArgs(current, types)?.itemType;
    if (!current) return undefined;
  }
  for (const field of fields) {
    current = projectTypeField(
      resolveAliasType(stripReferenceType(current), types) ?? stripReferenceType(current),
      field,
      types,
    );
    if (!current) return undefined;
  }
  return current;
}

function rootBindingName(name: string): string {
  const match = name.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!match) return name;
  return match[1];
}

function bindingNameExists(
  name: string,
  env: Map<string, OwnershipBinding>,
  globals: Map<string, OwnershipBinding> | undefined,
): boolean {
  if (env.has(name) || globals?.has(name) === true) return true;
  const base = rootBindingName(name.split(".")[0]);
  return env.has(base) || globals?.has(base) === true;
}

function functionDeclForName(
  name: string,
  functions: FnDecl[],
  options: RuntimeCheckOptions,
): FnDecl | undefined {
  const candidates = functionLookupCandidates(name);
  for (const candidate of candidates) {
    const mapped = options.functionMap?.get(candidate);
    if (mapped) return mapped;
  }
  for (const candidate of candidates) {
    const exact = functions.find((fn) => fn.name === candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const qualified = functions.find((fn) => importedFunctionNameMatches(fn.name, candidate));
    if (qualified) return qualified;
  }
  for (const candidate of candidates) {
    if (candidate.includes(".") || candidate.includes("::")) continue;
    const terminalMatch = functions.find((fn) => functionTerminalMemberName(fn.name) === candidate);
    if (terminalMatch) return terminalMatch;
  }
  return undefined;
}

function functionLookupCandidates(name: string): string[] {
  const candidates = [name];
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const owner = name.slice(0, dot);
    const member = name.slice(dot + 1);
    candidates.push(`${owner}::${member}`);
    const canonicalOwner = canonicalQualifiedIteratorOwner(owner);
    if (canonicalOwner) candidates.push(`${canonicalOwner}::${member}`);
    if (startsUppercase(terminalName(owner))) candidates.push(member);
  }
  const associated = name.match(/^([A-Za-z_][A-Za-z0-9_]*)[.:]{1,2}([A-Za-z_][A-Za-z0-9_]*)$/);
  if (associated) {
    const owner = canonicalIteratorOwner(associated[1]);
    if (owner) candidates.push(`${owner}::${associated[2]}`);
  }
  return candidates;
}

function importedFunctionNameMatches(actual: string, requested: string): boolean {
  if (!requested.includes(".") && !requested.includes("::")) return false;
  if (actual === requested) return true;
  return actual.endsWith(`.${requested}`);
}

function functionTerminalMemberName(name: string): string {
  const associated = name.lastIndexOf("::");
  if (associated >= 0) return name.slice(associated + 2);
  return terminalName(name);
}

function canonicalIteratorOwner(owner: string): string | undefined {
  if (owner === "iter") return "Iter";
  if (owner === "compact_iter") return "CompactIter";
  if (owner === "range_iter") return "RangeIter";
  return undefined;
}

function canonicalQualifiedIteratorOwner(owner: string): string | undefined {
  const dot = owner.lastIndexOf(".");
  if (dot < 0) return canonicalIteratorOwner(owner);
  const prefix = owner.slice(0, dot);
  const canonical = canonicalIteratorOwner(owner.slice(dot + 1));
  if (!canonical) return undefined;
  return `${prefix}.${canonical}`;
}

function isTypeVariableMemberName(name: string): boolean {
  return /^[a-z][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function staticNameMatchesExpectedType(
  name: string,
  expectedType: string | undefined,
  types: TypeDecl[],
): boolean {
  if (!expectedType) return false;
  const expected = expectedType.trim();
  if (expected === "type") {
    if (isInferredTypeVarName(name)) return true;
    if (isKnownStaticProofArg(name, types)) return true;
    if (isBuiltinTypeName(name)) return true;
    return resolveStaticTypeName(name, types) !== undefined;
  }
  const value = constValueFromKeyName(name);
  if (!value) return false;
  return constValueMatchesExpectedType(value, expected);
}

function nameIsStaticLike(
  name: string,
  expectedType: string | undefined,
  types: TypeDecl[],
): boolean {
  if (name.startsWith("@")) {
    return isCompilerSpecialForm(name) || isStaticBuiltinName(name);
  }
  if (staticNameMatchesExpectedType(name, expectedType, types)) return true;
  if (expectedType === "const" && isInferredTypeVarName(name)) return true;
  if (expectedType === undefined && isKnownStaticProofArg(name, types)) return true;
  return staticMemberNameKnown(name, types);
}

function staticMemberNameKnown(name: string, types: TypeDecl[]): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const owner = name.slice(0, dot);
  if (!startsUppercase(terminalName(owner))) return false;
  const field = name.slice(dot + 1);
  const decl = findTypeDecl(types, owner);
  if (decl?.normalized?.kind === "product") {
    return decl.normalized.shape.slots.some((slot) => slot.label === field);
  }
  const resolved = resolveAliasType(owner, types);
  const resolvedDecl = findTypeDecl(types, typeNameOf(resolved ?? ""));
  if (resolvedDecl?.normalized?.kind === "product") {
    return resolvedDecl.normalized.shape.slots.some((slot) => slot.label === field);
  }
  return true;
}

function typeBuilderName(name: string): boolean {
  return name === "struct" || name === "union";
}

function staticCallArgExpectedType(
  calleeName: string | undefined,
  index: number,
): string | undefined {
  if (!calleeName) return undefined;
  const staticParam = staticBuiltinParamKind(calleeName, index);
  if (typeof staticParam === "string") return staticParam;
  const name = staticBuiltinName(calleeName);
  if (name === "empty" && index === 0) return "type";
  if (name === "field" && index === 1) return "const";
  if (name === "replace_field" && index === 1) return "const";
  return undefined;
}

function callIsStaticTypeExpression(
  expr: Extract<Expr, { kind: "call" }>,
  expectedType: string | undefined,
  types: TypeDecl[],
): boolean {
  if (expr.callee.kind !== "var") return false;
  if (typeBuilderName(expr.callee.name)) return true;
  if (expr.callee.name.includes("::")) return false;
  const typeDecl = findTypeDecl(types, expr.callee.name);
  if (!typeDecl && expectedType?.trim() === "type" && isBuiltinTypeName(expr.callee.name)) {
    return true;
  }
  if (!typeDecl && !startsUppercase(terminalName(expr.callee.name))) return false;
  if (!expectedType) return true;
  const expected = expectedType.trim();
  if (isStaticBinding({ type: expected })) return true;
  if (!typeDecl) return startsUppercase(terminalName(expr.callee.name));
  return terminalName(typeNameOf(expected)) === terminalName(typeDecl.name);
}

function sumVariantConstructorReturnType(
  name: string,
  args: Expr[],
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
  options: RuntimeCheckOptions,
  expectedType?: string,
): string | undefined {
  const expectedBase = expectedType ? typeNameOf(expectedType) : undefined;
  for (const decl of types) {
    if (decl.normalized?.kind !== "sum") continue;
    if (
      expectedBase && typeNameOf(decl.name) !== expectedBase &&
      terminalName(decl.name) !== expectedBase
    ) {
      continue;
    }
    const variant = decl.normalized.variants.find((item) =>
      item.name === name || terminalName(item.name) === terminalName(name)
    );
    if (!variant) continue;
    return instantiateSumVariantReturnType(
      decl,
      variant,
      args,
      env,
      types,
      functions,
      options,
      expectedType,
    );
  }
  return undefined;
}

function instantiateSumVariantReturnType(
  decl: TypeDecl,
  variant: TypeVariant,
  args: Expr[],
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
  options: RuntimeCheckOptions,
  expectedType?: string,
): string {
  if (!decl.params.length) return decl.name;
  const bindings = new Map<string, string>();
  const expectedArgs = expectedType ? typeCallArgsForBase(expectedType, decl.name) : undefined;
  if (expectedArgs !== undefined) {
    const values = splitTypeArgs(expectedArgs);
    for (let index = 0; index < decl.params.length; index++) {
      const value = values[index]?.trim();
      if (value) {
        bindings.set(decl.params[index].name, value);
      }
    }
  }
  const slots = variant.shape?.slots ?? [];
  for (let index = 0; index < args.length; index++) {
    const expected = slots[index]?.type;
    const actual = exprBindingType(args[index], env, types, functions, options);
    bindTypePattern(expected, actual, bindings, types);
  }
  const values: string[] = [];
  for (const param of decl.params) {
    const value = bindings.get(param.name);
    if (!value) return decl.name;
    values.push(value);
  }
  return `${decl.name}(${values.join(", ")})`;
}

function isInlineArrayExprBuiltinWrapper(fn: FnDecl): boolean {
  const expr = fn.body.expr;
  return fn.body.statements.length === 0 &&
    expr?.kind === "call" &&
    expr.callee.kind === "var" &&
    isInlineArrayExprBuiltin(expr.callee.name);
}

function checkBlock(
  block: Extract<Expr, { kind: "block" }>,
  env: Map<string, OwnershipBinding>,
  hostIoImports: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expectedType?: string,
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
  options: RuntimeCheckOptions = { recoverTypes: false },
) {
  const ordered = orderBlockStatements(block.statements, diagnostics);
  for (const stmt of ordered) {
    checkStatement(stmt, env, hostIoImports, effects, diagnostics, types, functions, options);
  }
  if (block.expr) {
    checkExpr(
      block.expr,
      env,
      hostIoImports,
      effects,
      diagnostics,
      expectedType,
      types,
      functions,
      options,
    );
  }
}

function checkProjection(
  name: string,
  env: Map<string, OwnershipBinding>,
  globals: Map<string, OwnershipBinding> | undefined,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  const match = name.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[[0-9]+\])+$/);
  if (!match) return;
  const base = rootBindingName(match[1]);
  let baseType = env.get(base)?.type;
  if (!baseType) {
    baseType = globals?.get(base)?.type;
  }
  const index = Number.parseInt(name.match(/\[([0-9]+)\]/)?.[1] ?? "", 10);
  const capacity = inlineArrayCapacity(stripFrozenType(baseType), types);
  if (capacity !== undefined && index >= capacity) {
    diagnostics.push({
      code: "index.out_of_bounds",
      message: `inline array index ${index} is out of bounds for capacity ${capacity}`,
    });
  }
}

const MATCH_EXHAUSTIVE_DOMAIN_LIMIT = 256;

function checkRuntimeMatchCoverage(
  expr: Extract<Expr, { kind: "match" }>,
  matchValueType: string | undefined,
  diagnostics: Diagnostic[],
  types: TypeDecl[],
): void {
  const domain = finiteRuntimeMatchDomain(matchValueType, types);
  if (!domain) return;

  const required = new Set(domain.values);
  const covered = new Set<string>();
  let exhaustiveAt: number | undefined;
  for (let index = 0; index < expr.arms.length; index++) {
    const arm = expr.arms[index]!;
    if (exhaustiveAt !== undefined) {
      diagnostics.push(diagnosticAt(
        "match.unreachable_arm",
        `match arm ${index + 1} is unreachable because an earlier arm covers all values`,
        arm,
      ));
      continue;
    }
    if (arm.guard) continue;
    const values = finitePatternValues(arm.pattern, domain, types);
    if (!values) continue;
    const reachable = values.filter((value) => required.has(value));
    if (!reachable.length) {
      diagnostics.push(diagnosticAt(
        "match.unreachable_arm",
        `match arm ${renderParamPattern(arm.pattern)} is unreachable for ${domain.type}`,
        arm,
      ));
      continue;
    }
    if (reachable.every((value) => covered.has(value))) {
      diagnostics.push(diagnosticAt(
        "match.unreachable_arm",
        `match arm ${renderParamPattern(arm.pattern)} is shadowed by an earlier arm`,
        arm,
      ));
      continue;
    }
    for (const value of reachable) covered.add(value);
    if (covered.size === required.size) exhaustiveAt = index;
  }

  if (covered.size < required.size) {
    const missing = [...required].filter((value) => !covered.has(value));
    diagnostics.push(diagnosticAt(
      "type.non_exhaustive_match",
      `match is missing ${missing.slice(0, 4).join(", ")}${
        missing.length > 4 ? ", ..." : ""
      } for ${domain.type}`,
      expr,
    ));
  }
}

function finiteRuntimeMatchDomain(
  matchValueType: string | undefined,
  types: TypeDecl[],
): FiniteMatchDomain | undefined {
  const originalType = matchValueType?.trim();
  if (!originalType) return undefined;
  const originalDecl = findTypeDecl(types, typeNameOf(originalType));
  if (originalDecl?.enum) {
    const values = finiteEnumDomainValues(originalDecl);
    if (!values) return undefined;
    return {
      kind: "enum",
      type: originalType,
      values,
    };
  }
  const resolvedType = resolveAliasType(matchValueType, types) ?? matchValueType;
  if (!resolvedType) return undefined;
  const enumDecl = findTypeDecl(types, typeNameOf(resolvedType));
  if (enumDecl?.enum) {
    const values = finiteEnumDomainValues(enumDecl);
    if (!values) return undefined;
    return {
      kind: "enum",
      type: resolvedType,
      values,
    };
  }
  if (resolvedType === "bool") {
    return { kind: "bool", type: resolvedType, values: ["false", "true"] };
  }
  const i32Values = finiteI32DomainValues(parseRefinedI32Type(resolvedType));
  if (i32Values) return { kind: "i32", type: resolvedType, values: i32Values };
  const sumDecl = findTypeDecl(types, typeNameOf(resolvedType));
  if (sumDecl?.normalized?.kind === "sum") {
    return {
      kind: "sum",
      type: resolvedType,
      values: sumDecl.normalized.variants.map((variant) => terminalName(variant.name)),
    };
  }
  return undefined;
}

function finiteEnumDomainValues(decl: TypeDecl): string[] | undefined {
  if (!decl.enum) return undefined;
  const backingValues = finiteI32DomainValues(parseRefinedI32Type(decl.enum.backing));
  if (!backingValues) return undefined;
  const variantValues = decl.enum.variants.map((variant) => variant.value);
  const variants = new Set(variantValues);
  if (backingValues.length !== variants.size) return undefined;
  for (const value of backingValues) {
    if (!variants.has(value)) return undefined;
  }
  return variantValues;
}

function finiteI32DomainValues(domain: RefinedI32Domain | undefined): string[] | undefined {
  if (!domain) return undefined;
  const values: string[] = [];
  for (const interval of domain.intervals) {
    if (interval.start.kind !== "literal" || interval.end.kind !== "literal") return undefined;
    const count = interval.end.value - interval.start.value;
    if (count < 0 || values.length + count > MATCH_EXHAUSTIVE_DOMAIN_LIMIT) return undefined;
    for (let value = interval.start.value; value < interval.end.value; value++) {
      values.push(String(value));
    }
  }
  return values;
}

function finitePatternValues(
  pattern: ParamPattern,
  domain: FiniteMatchDomain,
  types: TypeDecl[],
): string[] | undefined {
  if (isCatchAllPattern(pattern)) return domain.values;
  if (pattern.kind === "typed") {
    const typedDomain = finiteRuntimeMatchDomain(pattern.type, types);
    const activeDomain = typedDomain?.kind === domain.kind ? typedDomain : domain;
    const values = finitePatternValues(pattern.pattern, activeDomain, types);
    if (!values) return undefined;
    return values.filter((value) => domain.values.includes(value));
  }
  if (pattern.kind === "as") return finitePatternValues(pattern.pattern, domain, types);
  if (pattern.kind === "or") {
    const values = new Set<string>();
    for (const alternative of pattern.alternatives) {
      const alternativeValues = finitePatternValues(alternative, domain, types);
      if (!alternativeValues) return undefined;
      for (const value of alternativeValues) values.add(value);
    }
    return [...values];
  }
  if (domain.kind === "bool") {
    const value = boolPatternValue(pattern);
    return value === undefined ? undefined : [value.toString()];
  }
  if ((domain.kind === "i32" || domain.kind === "enum") && pattern.kind === "literal") {
    if (pattern.literalKind !== "number") return undefined;
    if (!/^-?[0-9]+$/.test(pattern.value)) return undefined;
    const value = Number.parseInt(pattern.value, 10);
    return Number.isSafeInteger(value) ? [String(value)] : undefined;
  }
  if (domain.kind === "sum") {
    if (pattern.kind === "constructor" || pattern.kind === "type") {
      return [terminalName(pattern.name)];
    }
  }
  return undefined;
}

function narrowedEnvForMatchPattern(
  value: Expr,
  pattern: ParamPattern,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
): Map<string, OwnershipBinding> {
  const scoped = new Map(env);
  const truth = boolPatternValue(pattern);
  if (truth === undefined) return scoped;
  const narrowed = conditionI32Narrowing(value, truth, functions);
  if (!narrowed) return scoped;
  const binding = scoped.get(narrowed.name);
  const currentType = resolveAliasType(binding?.type, types) ?? binding?.type;
  if (scalarDomainRuntimeType(currentType) !== "i32") return scoped;
  if (
    !scalarFactsFromRefinedI32Type(currentType) &&
    narrowed.domain.intervals.every(isUpperOnlyI32Narrowing)
  ) {
    return scoped;
  }
  const currentDomain = parseRefinedI32Type(currentType) ?? anyI32Domain();
  const refined = refinedI32DomainIntersection(currentDomain, narrowed.domain);
  if (!refined.intervals.length) return scoped;
  scoped.set(narrowed.name, {
    moved: binding?.moved ?? false,
    type: renderRefinedI32Domain(refined),
  });
  return scoped;
}

function isUpperOnlyI32Narrowing(interval: DomainInterval): boolean {
  if (interval.start.kind !== "literal" || interval.start.value !== I32_MIN) return false;
  return !(
    interval.end.kind === "literal" &&
    interval.end.value === interval.start.value + 1
  );
}

function conditionI32Narrowing(
  expr: Expr,
  truth: boolean,
  functions: FnDecl[],
): { name: string; domain: RefinedI32Domain } | undefined {
  const operation = i32BinaryOperation(expr, functions);
  if (!operation) return undefined;
  if (operation.op === "==" && operation.left.kind === "var") {
    const right = endpointForI32Condition(operation.right);
    if (right?.kind === "literal") {
      return {
        name: operation.left.name,
        domain: equalityNarrowingDomain(right, truth),
      };
    }
  }
  if (operation.op === "==" && operation.right.kind === "var") {
    const left = endpointForI32Condition(operation.left);
    if (left?.kind === "literal") {
      return {
        name: operation.right.name,
        domain: equalityNarrowingDomain(left, truth),
      };
    }
  }
  if (operation.left.kind === "var") {
    const right = endpointForI32Condition(operation.right);
    const domain = right ? leftVarComparisonDomain(operation.op, right, truth) : undefined;
    if (domain) return { name: operation.left.name, domain };
  }
  if (operation.right.kind === "var") {
    const left = endpointForI32Condition(operation.left);
    const domain = left ? rightVarComparisonDomain(operation.op, left, truth) : undefined;
    if (domain) return { name: operation.right.name, domain };
  }
  return undefined;
}

function equalityNarrowingDomain(
  endpoint: DomainInterval["start"] & { kind: "literal" },
  truth: boolean,
): RefinedI32Domain {
  const singleton = domainFromIntervals([{
    start: endpoint,
    end: literalEndpoint(endpoint.value + 1),
  }]);
  if (truth) return singleton;
  return refinedI32DomainDifference(anyI32Domain(), singleton) ?? anyI32Domain();
}

function leftVarComparisonDomain(
  op: string,
  endpoint: DomainInterval["end"],
  truth: boolean,
): RefinedI32Domain | undefined {
  if (op === "<") {
    return truth ? lessThanDomain(endpoint) : greaterEqualDomain(endpoint);
  }
  if (op === "<=") {
    const next = incrementEndpoint(endpoint);
    return next ? (truth ? lessThanDomain(next) : greaterEqualDomain(next)) : undefined;
  }
  if (op === ">") {
    const next = incrementEndpoint(endpoint);
    return next ? (truth ? greaterEqualDomain(next) : lessThanDomain(next)) : undefined;
  }
  if (op === ">=") {
    return truth ? greaterEqualDomain(endpoint) : lessThanDomain(endpoint);
  }
  return undefined;
}

function rightVarComparisonDomain(
  op: string,
  endpoint: DomainInterval["start"],
  truth: boolean,
): RefinedI32Domain | undefined {
  if (op === "<") {
    const next = incrementEndpoint(endpoint);
    return next ? (truth ? greaterEqualDomain(next) : lessThanDomain(next)) : undefined;
  }
  if (op === "<=") {
    return truth ? greaterEqualDomain(endpoint) : lessThanDomain(endpoint);
  }
  if (op === ">") {
    return truth ? lessThanDomain(endpoint) : greaterEqualDomain(endpoint);
  }
  if (op === ">=") {
    const next = incrementEndpoint(endpoint);
    return next ? (truth ? lessThanDomain(next) : greaterEqualDomain(next)) : undefined;
  }
  return undefined;
}

function lessThanDomain(end: DomainInterval["end"]): RefinedI32Domain {
  return domainFromIntervals([{ start: literalEndpoint(I32_MIN), end }]);
}

function greaterEqualDomain(start: DomainInterval["start"]): RefinedI32Domain {
  return domainFromIntervals([{ start, end: literalEndpoint(I32_MAX_EXCLUSIVE) }]);
}

function anyI32Domain(): RefinedI32Domain {
  return domainFromIntervals([{
    start: literalEndpoint(I32_MIN),
    end: literalEndpoint(I32_MAX_EXCLUSIVE),
  }]);
}

function domainFromIntervals(intervals: DomainInterval[]): RefinedI32Domain {
  return refinedI32DomainIntersection(
    { carrier: "i32", intervals },
    anyI32DomainRaw(),
  );
}

function anyI32DomainRaw(): RefinedI32Domain {
  return {
    carrier: "i32",
    intervals: [{ start: literalEndpoint(I32_MIN), end: literalEndpoint(I32_MAX_EXCLUSIVE) }],
  };
}

function endpointForI32Condition(expr: Expr): ReturnType<typeof endpointFromTypeExprText> {
  if (expr.kind === "literal" && expr.literalKind === "number") {
    const value = staticIntegerLiteral(expr);
    return value === undefined ? undefined : literalEndpoint(value);
  }
  if (expr.kind === "var") return endpointFromTypeExprText(expr.name);
  return undefined;
}

function incrementEndpoint(
  endpoint: ReturnType<typeof endpointFromTypeExprText>,
): ReturnType<typeof endpointFromTypeExprText> {
  if (!endpoint) return undefined;
  return endpoint.kind === "literal" ? literalEndpoint(endpoint.value + 1) : undefined;
}

function boolPatternValue(pattern: ParamPattern): boolean | undefined {
  if (pattern.kind === "typed") return boolPatternValue(pattern.pattern);
  if (pattern.kind === "literal") {
    if (pattern.value === "true") return true;
    if (pattern.value === "false") return false;
  }
  if (pattern.kind === "type") {
    if (pattern.name === "true") return true;
    if (pattern.name === "false") return false;
  }
  return undefined;
}

function bindMatchPatternLocals(
  pattern: ParamPattern,
  valueType: string | undefined,
  env: Map<string, OwnershipBinding>,
  diagnostics: Diagnostic[],
  types: TypeDecl[],
) {
  if (pattern.kind === "typed") {
    checkTypedPatternType(pattern, valueType, diagnostics, types);
    bindMatchPatternLocals(pattern.pattern, pattern.type, env, diagnostics, types);
    return;
  }
  if (pattern.kind === "as") {
    env.set(pattern.name, { moved: false, type: valueType });
    bindMatchPatternLocals(pattern.pattern, valueType, env, diagnostics, types);
    return;
  }
  if (pattern.kind === "or") {
    checkOrPatternBindings(pattern, valueType, diagnostics, types);
    if (pattern.alternatives[0]) {
      bindMatchPatternLocals(pattern.alternatives[0], valueType, env, diagnostics, types);
    }
    return;
  }
  if (pattern.kind === "product") {
    bindProductPatternLocals(pattern, valueType, env, diagnostics, types);
    return;
  }
  const step = parseIterStepType(valueType);
  if (pattern.kind === "binding") {
    env.set(pattern.name, { moved: false, type: valueType });
    return;
  }
  if (pattern.kind === "tuple") {
    const slots = valueType ? runtimeSlotTypes(valueType, types) : [];
    for (let index = 0; index < pattern.items.length; index++) {
      bindPatternName(pattern.items[index], slots[index] ?? undefined, env, types);
    }
    return;
  }
  if (pattern.kind !== "constructor") return;
  const variantSlots = sumVariantSlotTypes(valueType, pattern.name, types);
  if (variantSlots) {
    for (let index = 0; index < pattern.args.length; index++) {
      bindPatternName(pattern.args[index], variantSlots[index] ?? undefined, env, types);
    }
    return;
  }
  if (!step) return;
  if (pattern.name === "Done") {
    if (pattern.args.length) {
      diagnostics.push({
        code: "match.pattern_payload",
        message: "Done pattern does not bind payloads",
      });
    }
    return;
  }
  if (pattern.name !== "Yield") {
    diagnostics.push({
      code: "match.unknown_variant",
      message: `unknown step variant ${pattern.name}`,
    });
    return;
  }
  if (pattern.args.length !== 2) {
    diagnostics.push({
      code: "match.pattern_payload",
      message: "Yield pattern requires item and next binders",
    });
    return;
  }
  bindPatternName(pattern.args[0], step.item, env, types);
  bindPatternName(pattern.args[1], step.state, env, types);
}

function checkOrPatternBindings(
  pattern: Extract<ParamPattern, { kind: "or" }>,
  valueType: string | undefined,
  diagnostics: Diagnostic[],
  types: TypeDecl[],
) {
  const expected = patternBindingTypeMap(pattern.alternatives[0], valueType, types);
  const expectedNames = [...expected.keys()].sort();
  for (const alternative of pattern.alternatives.slice(1)) {
    const actual = patternBindingTypeMap(alternative, valueType, types);
    const actualNames = [...actual.keys()].sort();
    if (expectedNames.join("\0") !== actualNames.join("\0")) {
      diagnostics.push(diagnosticAt(
        "match.pattern_binding",
        "or-pattern alternatives must bind the same names",
        alternative,
      ));
      continue;
    }
    for (const name of expectedNames) {
      const left = expected.get(name);
      const right = actual.get(name);
      if (!left || !right) continue;
      if (
        runtimeValueTypeAssignable(left, right, types) &&
        runtimeValueTypeAssignable(right, left, types)
      ) {
        continue;
      }
      diagnostics.push(diagnosticAt(
        "type.pattern_mismatch",
        `or-pattern binding ${name} has incompatible types ${left} and ${right}`,
        alternative,
      ));
    }
  }
}

function patternBindingTypeMap(
  pattern: ParamPattern | undefined,
  valueType: string | undefined,
  types: TypeDecl[],
): Map<string, string | undefined> {
  const env = new Map<string, string | undefined>();
  addPatternBindingTypeEntries(pattern, valueType, env, types);
  return env;
}

function addPatternBindingTypeEntries(
  pattern: ParamPattern | undefined,
  valueType: string | undefined,
  env: Map<string, string | undefined>,
  types: TypeDecl[],
) {
  if (!pattern) return;
  if (pattern.kind === "binding") {
    env.set(pattern.name, valueType);
    return;
  }
  if (pattern.kind === "typed") {
    addPatternBindingTypeEntries(pattern.pattern, pattern.type, env, types);
    return;
  }
  if (pattern.kind === "as") {
    env.set(pattern.name, valueType);
    addPatternBindingTypeEntries(pattern.pattern, valueType, env, types);
    return;
  }
  if (pattern.kind === "or") {
    addPatternBindingTypeEntries(pattern.alternatives[0], valueType, env, types);
    return;
  }
  if (pattern.kind === "tuple") {
    const slots = valueType ? runtimeSlotTypes(valueType, types) : [];
    for (let index = 0; index < pattern.items.length; index++) {
      addPatternBindingTypeEntries(pattern.items[index], slots[index], env, types);
    }
    return;
  }
  if (pattern.kind === "constructor") {
    const slots = sumVariantSlotTypes(valueType, pattern.name, types) ?? [];
    for (let index = 0; index < pattern.args.length; index++) {
      addPatternBindingTypeEntries(pattern.args[index], slots[index], env, types);
    }
    return;
  }
  if (pattern.kind === "product") {
    const slots = structuralProductSlotsForType(valueType, types) ?? [];
    for (const field of pattern.fields) {
      const slot = slots.find((item, index) => (item.label ?? String(index)) === field.label);
      addPatternBindingTypeEntries(field.pattern, slot?.type, env, types);
    }
  }
}

function bindProductPatternLocals(
  pattern: Extract<ParamPattern, { kind: "product" }>,
  valueType: string | undefined,
  env: Map<string, OwnershipBinding>,
  diagnostics: Diagnostic[],
  types: TypeDecl[],
) {
  const resolved = resolveAliasType(valueType, types) ?? valueType;
  const valueName = resolved ? typeNameOf(resolved) : undefined;
  if (valueName && terminalName(valueName) !== terminalName(pattern.name)) {
    diagnostics.push(diagnosticAt(
      "type.pattern_mismatch",
      `product pattern ${pattern.name} cannot match ${valueType}`,
      pattern,
    ));
  }
  const slots = structuralProductSlotsForType(valueType, types);
  if (!slots) {
    diagnostics.push(diagnosticAt(
      "type.pattern_mismatch",
      `product pattern ${pattern.name} requires a product value`,
      pattern,
    ));
    return;
  }
  const seen = new Set<string>();
  for (const field of pattern.fields) {
    if (seen.has(field.label)) {
      diagnostics.push(diagnosticAt(
        "match.duplicate_field",
        `duplicate product pattern field ${field.label}`,
        field,
      ));
      continue;
    }
    seen.add(field.label);
    const slot = slots.find((item, index) => (item.label ?? String(index)) === field.label);
    if (!slot) {
      diagnostics.push(diagnosticAt(
        "match.unknown_field",
        `product pattern ${pattern.name} has no field ${field.label}`,
        field,
      ));
      continue;
    }
    bindPatternName(field.pattern, slot.type, env, types);
  }
}

function checkTypedPatternType(
  pattern: Extract<ParamPattern, { kind: "typed" }>,
  valueType: string | undefined,
  diagnostics: Diagnostic[],
  types: TypeDecl[],
) {
  const actual = resolveAliasType(valueType, types) ?? valueType;
  const expected = resolveAliasType(pattern.type, types) ?? pattern.type;
  const actualRuntime = scalarDomainRuntimeType(actual) ?? actual;
  const expectedRuntime = scalarDomainRuntimeType(expected) ?? expected;
  if (!actualRuntime || !expectedRuntime || actualRuntime === expectedRuntime) return;
  diagnostics.push(diagnosticAt(
    "type.pattern_mismatch",
    `pattern type ${pattern.type} cannot match ${valueType}`,
    pattern,
  ));
}

function sumVariantSlotTypes(
  valueType: string | undefined,
  variantName: string,
  types: TypeDecl[],
): string[] | undefined {
  const resolved = resolveAliasType(valueType, types) ?? valueType?.trim();
  if (!resolved) return undefined;
  const decl = findTypeDecl(types, typeNameOf(resolved));
  if (decl?.normalized?.kind !== "sum") return undefined;
  const variant = decl.normalized.variants.find((item) =>
    item.name === variantName || terminalName(item.name) === terminalName(variantName)
  );
  if (!variant) return undefined;
  const args = typeCallArgsForBase(resolved, typeNameOf(resolved));
  const argValues = args === undefined ? [] : splitTypeArgs(args);
  const bindings = new Map(decl.params.map((param, index) => [param.name, argValues[index]]));
  return (variant.shape?.slots ?? []).map((slot) =>
    resolveAliasType(substituteSignatureTypeArgs(slot.type, bindings), types) ??
      substituteSignatureTypeArgs(slot.type, bindings)
  );
}

function bindPatternName(
  pattern: ParamPattern,
  type: string | undefined,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
) {
  if (pattern.kind === "binding") {
    env.set(pattern.name, { moved: false, type });
  } else if (pattern.kind === "typed") {
    bindPatternName(pattern.pattern, pattern.type, env, types);
  } else if (pattern.kind === "as") {
    env.set(pattern.name, { moved: false, type });
    bindPatternName(pattern.pattern, type, env, types);
  } else if (pattern.kind === "or") {
    if (pattern.alternatives[0]) bindPatternName(pattern.alternatives[0], type, env, types);
  } else if (pattern.kind === "tuple" && type) {
    const slots = runtimeSlotTypes(type, types);
    for (let index = 0; index < pattern.items.length; index++) {
      bindPatternName(pattern.items[index], slots[index] ?? undefined, env, types);
    }
  } else if (pattern.kind === "constructor" && type) {
    const slots = sumVariantSlotTypes(type, pattern.name, types);
    if (!slots) return;
    for (let index = 0; index < pattern.args.length; index++) {
      bindPatternName(pattern.args[index], slots[index] ?? undefined, env, types);
    }
  } else if (pattern.kind === "product") {
    const slots = structuralProductSlotsForType(type, types) ?? [];
    for (const field of pattern.fields) {
      const slot = slots.find((item, index) => (item.label ?? String(index)) === field.label);
      bindPatternName(field.pattern, slot?.type, env, types);
    }
  }
}

function parseIterStepType(type: string | undefined): { state: string; item: string } | undefined {
  const args = typeCallArgsForBase(type?.trim() ?? "", "IterStep");
  if (!args) return undefined;
  const [state, item] = splitTypeArgs(args);
  return state && item ? { state: state.trim(), item: item.trim() } : undefined;
}

function checkDirectIndex(
  expr: Extract<Expr, { kind: "index" }>,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
  diagnostics: Diagnostic[],
  options: RuntimeCheckOptions,
) {
  if (expr.target.kind !== "var") return;
  const targetType = stripBorrowType(env.get(expr.target.name)?.type);
  const capacity = inlineArrayCapacity(targetType, types);
  if (capacity === undefined) return;
  if (expr.index.kind === "literal" && expr.index.literalKind === "number") {
    const index = Number.parseInt(expr.index.value, 10);
    if (index >= capacity) {
      diagnostics.push({
        code: "index.out_of_bounds",
        message: `inline array index ${index} is out of bounds for capacity ${capacity}`,
      });
    }
    return;
  }
  const indexType = exprBindingType(expr.index, env, types, functions, options);
  if (indexTypeProvesInlineArrayCapacity(indexType, capacity, types)) return;
  const resolvedIndexType = resolveAliasType(indexType, types) ?? indexType;
  if (scalarFactsFromRefinedI32Type(resolvedIndexType)) {
    diagnostics.push({
      code: "index.requires_proof",
      message: `direct inline-array indexing proof must match index(${capacity})`,
    });
    return;
  }
  if (indexType === undefined || scalarDomainRuntimeType(resolvedIndexType) === "i32") return;
  diagnostics.push({
    code: "index.requires_proof",
    message: `direct inline-array indexing proof must match index(${capacity})`,
  });
}

function indexTypeProvesInlineArrayCapacity(
  indexType: string | undefined,
  capacity: number,
  types: TypeDecl[],
): boolean {
  const resolved = resolveAliasType(indexType, types) ?? indexType;
  const expected = refinedI32FromRange(literalEndpoint(0), literalEndpoint(capacity));
  return refinedI32Assignable(expected, resolved) === true;
}

function inlineArrayCapacity(type: string | undefined, types: TypeDecl[]): number | undefined {
  const resolved = resolveAliasType(type, types);
  const match = resolved?.match(/^InlineArray\((\d+),/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function resolveAliasType(type: string | undefined, types: TypeDecl[]): string | undefined {
  let current = type?.trim();
  const byName = new Map(types.map((decl) => [decl.name, decl]));
  const byTerminal = new Map(types.map((decl) => [terminalName(decl.name), decl]));
  const find = (name: string) =>
    byName.get(name) ??
      (isQualifiedTypeName(name) ? undefined : byTerminal.get(terminalName(name)));
  const evaluateAlias = (source: string, currentName: string): string | undefined => {
    const expr = parseAnnotationType(source);
    if (!expr) return undefined;
    return evaluateAliasTypeExpr(expr, currentName, byName, []);
  };
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const staticResolved = resolveStaticAliasTypeSource(current);
    if (staticResolved && staticResolved !== current) {
      current = staticResolved;
      continue;
    }
    const decl = find(current);
    if (decl) {
      if (decl.normalized?.kind !== "alias") return current;
      current = decl.normalized.type;
      continue;
    }
    const callName = typeNameOf(current);
    const callDecl = find(callName);
    const callArgs = typeCallArgsForBase(current, callName);
    if (callDecl?.normalized?.kind === "alias" && callArgs !== undefined) {
      const substituted = substituteAliasTypeParams(
        callDecl.normalized.type,
        callDecl,
        splitTypeArgs(callArgs),
      );
      current = evaluateAlias(substituted, callDecl.name) ?? substituted;
      continue;
    }
    return current;
  }
  return current;
}

function resolveStaticAliasTypeSource(source: string): string | undefined {
  const call = source.trim().match(/^@shape_slot\(([\s\S]*)\)$/);
  if (!call) return undefined;
  const args = splitTypeArgs(call[1] ?? "");
  if (args.length !== 2) return undefined;
  const shape = parseAnnotationType(args[0]!.trim());
  const key = args[1]!.trim().replace(/^#/, "");
  if (shape?.kind !== "type_shape" || !key) return undefined;
  const slot = shape.shape.slots.find((item) => item.label === key);
  return slot ? renderTypeExpr(slot.type) : undefined;
}

function typeCallArgsForBase(type: string, baseName: string): string | undefined {
  type = type.trim();
  const prefix = `${baseName}(`;
  if (type.startsWith(prefix) && type.endsWith(")")) return type.slice(prefix.length, -1);
  const open = type.indexOf("(");
  if (open <= 0 || !type.endsWith(")")) return undefined;
  const callee = type.slice(0, open).trim();
  if (terminalName(callee) !== terminalName(baseName)) return undefined;
  return type.slice(open + 1, -1);
}

function substituteAliasTypeParams(type: string, decl: TypeDecl, args: string[]): string {
  const signature = parseExpectedFnType(type);
  if (signature) {
    const bindings = new Map<string, string>();
    decl.params.forEach((param, index) => {
      const arg = args[index]?.trim();
      if (arg) bindings.set(param.name, arg);
    });
    const params = signature.params.map((param) =>
      `${param.name}: ${substituteTypeVars(param.type, bindings)}`
    ).join(", ");
    return `fn(${params}) -> ${substituteTypeVars(signature.returnType, bindings)}`;
  }
  let result = type;
  decl.params.forEach((param, index) => {
    const arg = args[index]?.trim();
    if (!arg) return;
    result = result.replace(new RegExp(`\\b${param.name}\\b`, "g"), arg);
  });
  return result;
}

function orderBlockStatements(statements: Statement[], diagnostics: Diagnostic[]): Statement[] {
  const owners = new Map<string, number>();
  let hasDuplicate = false;
  statements.forEach((stmt, index) => {
    const names = boundNames(stmt);
    const localNames = new Set<string>();
    for (const name of names) {
      if (localNames.has(name) || owners.has(name)) {
        diagnostics.push(diagnosticAt(
          "type.duplicate_local",
          `duplicate local binding ${name}`,
          spanForBoundName(stmt, name),
        ));
        hasDuplicate = true;
        continue;
      }
      localNames.add(name);
      owners.set(name, index);
    }
  });
  if (hasDuplicate) return statements;

  statements.forEach((stmt, index) => {
    const refs = new Set<string>();
    collectStatementRefs(stmt, refs);
    for (const name of refs) {
      const owner = owners.get(name);
      if (owner === undefined || owner < index) continue;
      diagnostics.push(diagnosticAt(
        "type.local_order",
        owner === index
          ? `local binding ${name} cannot reference itself`
          : `local binding ${name} must be declared before it is used`,
        stmt,
      ));
    }
  });
  return statements;
}

function validateDoStatementLocals(statements: DoStatement[], diagnostics: Diagnostic[]) {
  const owners = new Map<string, number>();
  statements.forEach((stmt, index) => {
    const names = doBoundNames(stmt);
    const localNames = new Set<string>();
    for (const name of names) {
      if (localNames.has(name) || owners.has(name)) {
        diagnostics.push(diagnosticAt(
          "type.duplicate_local",
          `duplicate local binding ${name}`,
          spanForDoBoundName(stmt, name),
        ));
        continue;
      }
      localNames.add(name);
      owners.set(name, index);
    }
  });
  statements.forEach((stmt, index) => {
    const refs = new Set<string>();
    collectDoStatementRefs(stmt, refs);
    for (const name of refs) {
      const owner = owners.get(name);
      if (owner === undefined || owner < index) continue;
      diagnostics.push(diagnosticAt(
        "type.local_order",
        owner === index
          ? `local binding ${name} cannot reference itself`
          : `local binding ${name} must be declared before it is used`,
        stmt,
      ));
    }
  });
}

function collectDoStatementRefs(stmt: DoStatement, refs: Set<string>) {
  if (stmt.kind === "let" || stmt.kind === "destructure_let" || stmt.kind === "do_bind") {
    collectExprRefs(stmt.value, refs, new Set());
  } else if (stmt.kind === "do_expr") {
    collectExprRefs(stmt.value, refs, new Set());
  } else if (stmt.kind === "type_assert") {
    collectTypeExprRefs(stmt.value, refs);
  } else if (stmt.kind === "debug_trace") {
    for (const arg of stmt.args) collectExprRefs(arg, refs, new Set());
  }
}

function boundNames(stmt: Statement): string[] {
  if (stmt.kind === "let") return [stmt.name];
  if (stmt.kind === "type_assert") return [];
  if (stmt.kind === "debug_trace") return [];
  return stmt.names;
}

function doBoundNames(stmt: DoStatement): string[] {
  if (stmt.kind === "do_bind") return [stmt.name];
  if (stmt.kind === "do_expr") return [];
  return boundNames(stmt);
}

function spanForBoundName(stmt: Statement, name: string): { span?: Span; nameSpan?: Span } {
  if (stmt.kind === "let") return stmt;
  if (stmt.kind === "destructure_let") {
    return { span: stmt.nameSpans?.[name] ?? stmt.span };
  }
  return stmt;
}

function spanForDoBoundName(stmt: DoStatement, name: string): { span?: Span; nameSpan?: Span } {
  if (stmt.kind === "do_bind") return stmt;
  if (stmt.kind === "do_expr") return stmt;
  return spanForBoundName(stmt, name);
}

function collectStatementRefs(stmt: Statement, refs: Set<string>) {
  if (stmt.kind === "let") collectExprRefs(stmt.value, refs, new Set());
  else if (stmt.kind === "destructure_let") collectExprRefs(stmt.value, refs, new Set());
  else if (stmt.kind === "type_assert") collectTypeExprRefs(stmt.value, refs);
  else if (stmt.kind === "debug_trace") {
    for (const arg of stmt.args) collectExprRefs(arg, refs, new Set());
  }
}

function collectTypeExprRefs(expr: TypeExpr, refs: Set<string>) {
  switch (expr.kind) {
    case "type_ref":
      refs.add(expr.name);
      return;
    case "type_call":
      collectTypeExprRefs(expr.callee, refs);
      for (const arg of expr.args) collectTypeExprRefs(arg, refs);
      return;
    case "type_shape":
      for (const slot of expr.shape.slots) collectTypeExprRefs(slot.type, refs);
      return;
    case "type_match":
      collectTypeExprRefs(expr.value, refs);
      for (const arm of expr.arms) collectTypeExprRefs(arm.value, refs);
      return;
    case "type_scalar_domain":
      return;
    case "type_binary":
      collectTypeExprRefs(expr.left, refs);
      collectTypeExprRefs(expr.right, refs);
      return;
    case "type_hole":
    case "type_static_ref":
    case "type_fn":
    case "type_bool":
    case "type_number":
    case "type_char":
    case "type_string":
    case "type_literal":
      return;
  }
}

function collectExprRefs(expr: Expr, refs: Set<string>, shadowed: Set<string>) {
  switch (expr.kind) {
    case "var":
      if (!shadowed.has(expr.name)) refs.add(expr.name);
      return;
    case "call":
      collectExprRefs(expr.callee, refs, shadowed);
      for (const arg of expr.args) collectExprRefs(arg, refs, shadowed);
      return;
    case "index":
      collectExprRefs(expr.target, refs, shadowed);
      collectExprRefs(expr.index, refs, shadowed);
      return;
    case "binary":
      collectExprRefs(expr.left, refs, shadowed);
      collectExprRefs(expr.right, refs, shadowed);
      return;
    case "operator_chain":
      collectExprRefs(expr.first, refs, shadowed);
      for (const item of expr.rest) collectExprRefs(item.value, refs, shadowed);
      return;
    case "const_fn": {
      collectExprRefs(expr.body, refs, shadowNames(shadowed, expr.params));
      return;
    }
    case "pipe_bind": {
      collectExprRefs(expr.value, refs, shadowed);
      const nestedShadowed = new Set(shadowed);
      nestedShadowed.add(expr.name);
      collectExprRefs(expr.body, refs, nestedShadowed);
      return;
    }
    case "match":
      collectExprRefs(expr.value, refs, shadowed);
      for (const arm of expr.arms) collectExprRefs(arm.value, refs, shadowed);
      return;
    case "shape":
      for (const slot of expr.slots) {
        if (slot.index) collectExprRefs(slot.index, refs, shadowed);
        collectExprRefs(slot.value, refs, shadowed);
      }
      return;
    case "product_constructor":
      for (const slot of expr.slots) {
        if (slot.index) collectExprRefs(slot.index, refs, shadowed);
        collectExprRefs(slot.value, refs, shadowed);
      }
      return;
    case "static_for_slots": {
      if (expr.source.kind === "range") {
        collectExprRefs(expr.source.start, refs, shadowed);
        collectExprRefs(expr.source.end, refs, shadowed);
      } else {
        collectExprRefs(expr.source.shape, refs, shadowed);
      }
      collectExprRefs(
        expr.value,
        refs,
        shadowNames(
          shadowed,
          [expr.iterator, expr.valueIterator].filter((name): name is string => !!name),
        ),
      );
      return;
    }
    case "field":
      collectExprRefs(expr.value, refs, shadowed);
      collectExprRefs(expr.key, refs, shadowed);
      return;
    case "range":
      collectExprRefs(expr.start, refs, shadowed);
      collectExprRefs(expr.end, refs, shadowed);
      return;
    case "block":
      collectBlockRefs(expr, refs, shadowed);
      return;
    case "do":
      collectDoRefs(expr, refs, shadowed);
      return;
    case "literal":
      return;
  }
}

function collectDoRefs(
  expr: Extract<Expr, { kind: "do" }>,
  refs: Set<string>,
  shadowed: Set<string>,
) {
  const nestedShadowed = new Set(shadowed);
  for (const stmt of expr.statements) {
    for (const name of doBoundNames(stmt)) nestedShadowed.add(name);
  }
  for (const stmt of expr.statements) {
    if (stmt.kind === "let" || stmt.kind === "destructure_let" || stmt.kind === "do_bind") {
      collectExprRefs(stmt.value, refs, nestedShadowed);
    } else if (stmt.kind === "do_expr") {
      collectExprRefs(stmt.value, refs, nestedShadowed);
    }
  }
  if (expr.expr) collectExprRefs(expr.expr, refs, nestedShadowed);
}

function collectBlockRefs(
  block: Extract<Expr, { kind: "block" }>,
  refs: Set<string>,
  shadowed: Set<string>,
) {
  const nestedShadowed = new Set(shadowed);
  for (const stmt of block.statements) {
    for (const name of boundNames(stmt)) nestedShadowed.add(name);
  }
  for (const stmt of block.statements) {
    if (stmt.kind === "let") collectExprRefs(stmt.value, refs, nestedShadowed);
    else if (stmt.kind === "destructure_let") collectExprRefs(stmt.value, refs, nestedShadowed);
  }
  if (block.expr) collectExprRefs(block.expr, refs, nestedShadowed);
}

function numericExpectedType(expectedType: string | undefined): string | undefined {
  return scalarDomainRuntimeType(expectedType) === "i32" ? "i32" : undefined;
}

function contextualNumericLiteralType(
  expectedType: string | undefined,
  value: string,
  types: TypeDecl[],
): string | undefined {
  if (!expectedType || numericLiteralExplicitType(value)) return undefined;
  const resolved = resolveAliasType(expectedType, types) ?? expectedType.trim();
  if (resolved === "count") {
    const literal = staticIntegerNumberLiteral(value);
    return literal !== undefined && literal >= 0 ? "i32" : undefined;
  }
  const scalar = scalarReflection(resolved);
  if (!scalar) return undefined;
  const normalized = normalizedNumberLiteralText(value);
  const literal = Number(normalized);
  if (!Number.isFinite(literal)) return undefined;
  const floatTarget = scalar.carrier === "f32" || scalar.carrier === "f64";
  if (!floatTarget && !Number.isInteger(literal)) return undefined;
  if (!floatTarget && !isUnsuffixedInteger(normalized)) return undefined;
  if (scalar.min !== undefined && literal < scalar.min) return undefined;
  if (scalar.max !== undefined && literal > scalar.max) return undefined;
  if (!scalar.signed && literal < 0) return undefined;
  return resolved;
}

function explicitNumericLiteralTypeAssignable(
  expectedType: string,
  literalType: string,
  types: TypeDecl[],
): boolean {
  const resolvedExpected = resolveAliasType(expectedType, types) ?? expectedType.trim();
  if (!isNumericType(resolvedExpected)) {
    return runtimeValueTypeAssignable(resolvedExpected, literalType, types);
  }
  return resolvedExpected === literalType;
}

function isUnsuffixedInteger(value: string): boolean {
  return /^-?[0-9](_?[0-9])*$/.test(value);
}

function numericLiteralExplicitType(value: string): string | undefined {
  return value.match(/(i32|u32|i64|u64|f32|f64)$/)?.[1];
}

function normalizedNumberLiteralText(value: string): string {
  return value.replaceAll("_", "").replace(/(i32|u32|i64|u64|f32|f64)$/, "");
}

function staticIntegerNumberLiteral(value: string): number | undefined {
  const explicitType = numericLiteralExplicitType(value);
  if (explicitType === "f32" || explicitType === "f64") return undefined;
  const normalized = normalizedNumberLiteralText(value);
  if (!/^-?[0-9]+$/.test(normalized)) return undefined;
  return Number.parseInt(normalized, 10);
}

function isUnsignedIntegerType(type: string): boolean {
  const match = type.match(/^u([1-9][0-9]*)$/);
  if (!match) return false;
  const width = Number.parseInt(match[1], 10);
  return width >= 1 && width <= 64;
}
