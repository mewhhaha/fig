import type {
  BlockExpr,
  BranchHint,
  ConstDecl,
  ContractDecl,
  Declaration,
  DoStatement,
  Expr,
  FnDecl,
  OperatorDescriptor,
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
  compilerSpecialForm,
  type CompilerPluginOptions,
  type CompilerPluginRegistry,
  createCompilerPluginRegistry,
  defaultCompilerPluginRegistry,
  isCompilerSpecialForm,
  isStaticBuiltinName,
  staticBuiltinName,
  staticBuiltinParamKind,
} from "./plugins.ts";
import { checkContracts } from "./contracts/check.ts";
import {
  canonicalDomainKey,
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
  contracts: ContractRegistry;
  shaderManifest: ShaderManifestEntry[];
  trace?: CheckTrace;
}

export interface AnalysisCheckResult extends CheckResult {
  diagnostics: Diagnostic[];
}

export interface ContractRegistry {
  declarations: ContractDecl[];
  byName: Map<string, ContractDecl>;
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

interface CallCheckMemo {
  returnType?: string;
}

interface CheckMemo {
  typeMatches: Map<string, boolean>;
  runtimeType: Map<string, string | undefined>;
  exprBindingType: Map<string, string | undefined>;
  staticConstValue: Map<string, ConstValue | undefined>;
  callCheck: Map<string, CallCheckMemo>;
}

export interface CheckProgramOptions extends CompilerPluginOptions {
  trace?: boolean;
}

function diagnosticAt(
  code: string,
  message: string,
  spanLike?: { span?: Span; nameSpan?: Span },
): Diagnostic {
  return { code, message, span: spanLike?.nameSpan ?? spanLike?.span };
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
    contracts: result.contracts,
    shaderManifest: result.shaderManifest,
    trace: result.trace,
  };
}

export function runtimeProgramFromProgram(program: Program): Program {
  return {
    ...program,
    declarations: program.declarations.filter((
      decl,
    ): decl is Exclude<Declaration, { kind: "contract" }> => decl.kind !== "contract"),
  };
}

function contractRegistryFromProgram(program: Program): ContractRegistry {
  const declarations = program.declarations.filter((decl): decl is ContractDecl =>
    decl.kind === "contract"
  );
  return { declarations, byName: new Map(declarations.map((decl) => [decl.name, decl])) };
}

const RESERVED_COMPILER_VALUE_NAMES = new Set(["return"]);

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
  };
  const checkStatement = (stmt: Statement, allowProfile = true) => {
    if (stmt.kind === "let" || stmt.kind === "proof_const") checkName(stmt.name, stmt);
    if (stmt.kind === "destructure_let") {
      for (const name of stmt.names) checkName(name, { span: stmt.nameSpans?.[name] ?? stmt.span });
    }
    if (stmt.kind === "let" || stmt.kind === "destructure_let") checkExpr(stmt.value);
    if (stmt.kind === "debug_trace") stmt.args.forEach(checkExpr);
  };
  const checkDoStatement = (stmt: DoStatement) => {
    if (stmt.kind === "do_bind") checkName(stmt.name, stmt);
    if (stmt.kind === "let" || stmt.kind === "proof_const") checkName(stmt.name, stmt);
    if (stmt.kind === "destructure_let") {
      for (const name of stmt.names) checkName(name, { span: stmt.nameSpans?.[name] ?? stmt.span });
    }
    if (stmt.kind !== "proof_const" && "value" in stmt) checkExpr(stmt.value);
    if (stmt.kind === "debug_trace") stmt.args.forEach(checkExpr);
  };
  const checkBlock = (block: BlockExpr) => {
    for (const stmt of block.statements) checkStatement(stmt);
    if (block.expr) checkExpr(block.expr);
  };
  const checkExpr = (expr: Expr | undefined) => {
    if (!expr) return;
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
    if (
      decl.kind === "fn" || decl.kind === "const" || decl.kind === "let" || decl.kind === "contract"
    ) {
      checkName(decl.name, decl);
    }
    if (decl.kind === "fn" || decl.kind === "contract") {
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
  const checkTypeExpr = (expr: TypeExpr | undefined) => {
    if (!expr) return;
    if (expr.kind === "type_static_ref" && isCompilerSpecialForm(expr.name, "declaration")) {
      const form = compilerSpecialForm(expr.name);
      diagnostics.push(diagnosticAt(
        "syntax.declaration_builtin",
        `${form?.spelling ?? `@${expr.name}`} is only valid as a top-level const declaration value`,
        expr,
      ));
    }
    for (const child of typeExprChildren(expr)) checkTypeExpr(child);
  };
  const checkStatement = (stmt: Statement) => {
    if (stmt.kind === "let" || stmt.kind === "destructure_let") checkExpr(stmt.value);
    if (stmt.kind === "proof_const") checkTypeExpr(stmt.value);
    if (stmt.kind === "debug_trace") stmt.args.forEach(checkExpr);
  };
  const checkDoStatement = (stmt: DoStatement) => {
    if (stmt.kind === "proof_const") checkTypeExpr(stmt.value);
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
      case "placeholder":
        diagnostics.push(diagnosticAt(
          "syntax.placeholder_removed",
          "$ placeholder syntax has been removed; use a named binding",
          expr,
        ));
        return;
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
        if (expr.name === "$") {
          diagnostics.push(diagnosticAt(
            "syntax.placeholder_removed",
            "$ placeholder pipe-bind has been removed; use a named pipe-bind variable",
            expr,
          ));
        }
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
    if (decl.kind === "fn" || decl.kind === "contract") {
      checkBlock(decl.body);
    } else if (decl.kind === "let" || decl.kind === "const") {
      checkExpr(decl.value);
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
    else if (decl.kind === "contract") checkBlock(decl.body, false);
    else if (decl.kind === "let" || decl.kind === "const") checkExpr(decl.value, false);
  }
}

function typeExprChildren(expr: TypeExpr): TypeExpr[] {
  switch (expr.kind) {
    case "type_call":
      return [expr.callee, ...expr.args];
    case "type_shape":
      return expr.shape.slots.map((slot) => slot.type);
    case "type_match":
      return [expr.value, ...expr.arms.map((arm) => arm.value)];
    case "type_binary":
      return [expr.left, expr.right];
    case "type_ref":
    case "type_hole":
    case "type_static_ref":
    case "type_fn":
    case "type_operator":
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
  const memo = createCheckMemo();
  program.resolvedTypeHoles = [];
  const recordPhase = <T>(
    name: string,
    run: () => T,
    specialization?: SpecializationTrace,
  ): T => {
    if (!trace) return run();
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
  };
  const pluginRegistry = createCompilerPluginRegistry(options.plugins);
  diagnostics.push(...pluginRegistry.diagnostics);
  const shaderManifest = new Map<number, ShaderManifestEntry>();
  const addShader = (source: string) => {
    const entry = shaderManifestEntry(source);
    shaderManifest.set(entry.id, entry);
    return entry;
  };
  const hostIoImports = new Map(program.imports.map((item) => [item.name, item.effects]));
  checkExternalImportsUseExplicitIo(program, diagnostics);
  recordPhase("checkReservedCompilerNames", () => checkReservedCompilerNames(program, diagnostics));
  recordPhase("checkRemovedSyntax", () => checkRemovedSyntax(program, diagnostics));
  recordPhase("checkDebugTraceStatements", () => checkDebugTraceStatements(program, diagnostics));
  recordPhase(
    "prepareInferredTypeAnnotations",
    () => prepareInferredTypeAnnotations(program, diagnostics),
  );
  recordPhase(
    "lowerDoExpressions",
    () => lowerDoExpressions(program, diagnostics, true, program.resolvedTypeHoles),
  );
  recordPhase(
    "checkBorrowTypeRestrictions",
    () => checkBorrowTypeRestrictions(program, diagnostics),
  );
  recordPhase("groupFunctionClauses", () => groupFunctionClauses(program, diagnostics));
  recordPhase("checkBranchHints", () => checkBranchHints(program, diagnostics, pluginRegistry));
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
    "checkContracts",
    () => checkContracts(program, diagnostics, { inferRuntimeType, runtimeValueTypeAssignable }),
  );
  recordPhase(
    "checkPrimitiveDecls",
    () => checkPrimitiveDecls(fnDecls, diagnostics, pluginRegistry),
  );
  recordPhase("evaluateTypeDecls", () => evaluateTypeDecls(typeDecls, diagnostics));
  recordPhase(
    "checkDotQualifiedTypeMemberSyntax",
    () => checkDotQualifiedTypeMemberSyntax(typeDecls, fnDecls, diagnostics),
  );
  recordPhase(
    "attachQualifiedTypeMembers",
    () => attachQualifiedTypeMembers(typeDecls, fnDecls, diagnostics),
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
    "resolveAttachedMemberCalls #1",
    () => resolveAttachedMemberCalls(program, typeDecls),
  );
  const inferredStats1 = createSpecializationTrace();
  recordPhase(
    "specializeInferredTypeCalls #1",
    () =>
      specializeInferredTypeCalls(
        program,
        new Map(fnDecls.map((decl) => [decl.name, decl])),
        constValues,
        typeDecls,
        diagnostics,
        false,
        inferredStats1,
      ),
    inferredStats1,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  recordPhase(
    "resolveAttachedMemberCalls #2",
    () => resolveAttachedMemberCalls(program, typeDecls),
  );
  const constStats1 = createSpecializationTrace();
  recordPhase(
    "specializeConstParamCalls #1",
    () =>
      specializeConstParamCalls(
        program,
        new Map(fnDecls.map((decl) => [decl.name, decl])),
        constValues,
        typeDecls,
        addShader,
        diagnostics,
        true,
        constStats1,
      ),
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
    () =>
      specializeInferredTypeCalls(
        program,
        new Map(fnDecls.map((decl) => [decl.name, decl])),
        constValues,
        typeDecls,
        diagnostics,
        true,
        inferredStats2,
      ),
    inferredStats2,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  recordPhase(
    "resolveAttachedMemberCalls #4",
    () => resolveAttachedMemberCalls(program, typeDecls),
  );
  const constStats2 = createSpecializationTrace();
  recordPhase(
    "specializeConstParamCalls #2",
    () =>
      specializeConstParamCalls(
        program,
        new Map(fnDecls.map((decl) => [decl.name, decl])),
        constValues,
        typeDecls,
        addShader,
        diagnostics,
        false,
        constStats2,
      ),
    constStats2,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  recordPhase(
    "resolveAttachedMemberCalls #5",
    () => resolveAttachedMemberCalls(program, typeDecls),
  );
  recordPhase(
    "lowerDoExpressions #2",
    () => lowerDoExpressions(program, diagnostics, false, program.resolvedTypeHoles),
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  const inferredStats3 = createSpecializationTrace();
  recordPhase(
    "specializeInferredTypeCalls #3",
    () =>
      specializeInferredTypeCalls(
        program,
        new Map(fnDecls.map((decl) => [decl.name, decl])),
        constValues,
        typeDecls,
        diagnostics,
        true,
        inferredStats3,
      ),
    inferredStats3,
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
    ));
  recordPhase(
    "lowerResolvedOperators",
    () => lowerResolvedOperators(program, typeDecls, fnDecls, diagnostics, memo),
  );
  recordPhase(
    "balanceAssociativeBinaryChains",
    () => balanceAssociativeBinaryChains(program, typeDecls),
  );
  recordPhase(
    "lowerCollectorLiterals",
    () => lowerCollectorLiterals(program, typeDecls, fnDecls, diagnostics),
  );
  recordPhase(
    "lowerProductConstructors",
    () => lowerProductConstructors(program, typeDecls, diagnostics),
  );

  recordPhase("checkFn loop", () => {
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
        if (!decl.generated && !decl.primitiveId) {
          checkFn(decl, hostIoImports, diagnostics, typeDecls, [...fnDecls, ...importFnDecls], {
            ...options,
            memo,
          });
        }
      }
    }
  });
  recordPhase(
    "resolveInferredTypeAnnotations",
    () =>
      resolveInferredTypeAnnotations(
        program,
        typeDecls,
        [...fnDecls, ...importFnDecls],
        constValues,
        diagnostics,
        memo,
      ),
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
  return {
    program,
    runtimeProgram: runtimeProgramFromProgram(program),
    contracts: contractRegistryFromProgram(program),
    diagnostics,
    shaderManifest: [...shaderManifest.values()].sort((a, b) => a.id - b.id),
    trace,
  };
}

function balanceAssociativeBinaryChains(program: Program, typeDecls: TypeDecl[]) {
  const descriptorOps = new Set<string>();
  for (const decl of typeDecls) {
    if (decl.resultKind === "operator" && decl.normalized?.kind === "operator") {
      descriptorOps.add(decl.normalized.descriptor.symbol);
    }
  }
  const balanceableOps = new Set(["+", "*", "&&", "||"].filter((op) => !descriptorOps.has(op)));
  if (!balanceableOps.size) return;

  const lowerExpr = (expr: Expr): Expr => {
    switch (expr.kind) {
      case "const_fn":
        return { ...expr, body: lowerExpr(expr.body) };
      case "call":
        return { ...expr, callee: lowerExpr(expr.callee), args: expr.args.map(lowerExpr) };
      case "index":
        return { ...expr, target: lowerExpr(expr.target), index: lowerExpr(expr.index) };
      case "binary": {
        if (balanceableOps.has(expr.op)) {
          const leaves = collectBinaryChainLeaves(expr, expr.op, lowerExpr);
          return leaves.length > 8
            ? buildBalancedBinaryChain(expr.op, leaves)
            : buildLeftBinaryChain(expr.op, leaves, expr);
        }
        return { ...expr, left: lowerExpr(expr.left), right: lowerExpr(expr.right) };
      }
      case "pipe_bind":
        return { ...expr, value: lowerExpr(expr.value), body: lowerExpr(expr.body) };
      case "profile":
        return {
          ...expr,
          args: expr.args.map(lowerExpr),
          body: lowerExpr(expr.body),
        };
      case "match":
        return {
          ...expr,
          value: lowerExpr(expr.value),
          arms: expr.arms.map((arm) => ({ ...arm, value: lowerExpr(arm.value) })),
        };
      case "shape":
      case "product_constructor":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({
            ...slot,
            index: slot.index ? lowerExpr(slot.index) : undefined,
            value: lowerExpr(slot.value),
          })),
        };
      case "static_for_slots":
        return {
          ...expr,
          source: expr.source.kind === "range"
            ? {
              kind: "range",
              start: lowerExpr(expr.source.start),
              end: lowerExpr(expr.source.end),
            }
            : { kind: "shape", shape: lowerExpr(expr.source.shape) },
          value: lowerExpr(expr.value),
        };
      case "field":
        return { ...expr, value: lowerExpr(expr.value), key: lowerExpr(expr.key) };
      case "range":
        return { ...expr, start: lowerExpr(expr.start), end: lowerExpr(expr.end) };
      case "block":
        return {
          ...expr,
          statements: expr.statements.map((stmt) =>
            stmt.kind === "let" || stmt.kind === "destructure_let"
              ? { ...stmt, value: lowerExpr(stmt.value) } as Statement
              : stmt
          ),
          expr: expr.expr ? lowerExpr(expr.expr) : undefined,
        };
      case "do":
      case "literal":
      case "placeholder":
      case "var":
        return expr;
    }
  };

  for (const decl of program.declarations) {
    if (decl.kind === "fn") decl.body = lowerExpr(decl.body) as BlockExpr;
    else if (decl.kind === "contract") decl.body = lowerExpr(decl.body) as BlockExpr;
    else if (decl.kind === "let" || decl.kind === "const") decl.value = lowerExpr(decl.value);
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

function createCheckMemo(): CheckMemo {
  return {
    typeMatches: new Map(),
    runtimeType: new Map(),
    exprBindingType: new Map(),
    staticConstValue: new Map(),
    callCheck: new Map(),
  };
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
    if (decl.kind === "fn" || decl.kind === "contract") visit(decl.body);
    else if (decl.kind === "const" || decl.kind === "let") visit(decl.value);
  }
  return total;
}

function checkBorrowTypeRestrictions(program: Program, diagnostics: Diagnostic[]) {
  const checkType = (
    type: string | undefined,
    context: "param" | "owned",
    spanLike?: { span?: Span; nameSpan?: Span },
  ) => {
    if (!type) return;
    const trimmed = type.trim();
    const fn = parseFnSignature(trimmed);
    if (fn) {
      for (const param of fn.params) checkType(param, "param", spanLike);
      checkType(fn.returnType, "owned", spanLike);
    }
  };
  const checkExpr = (expr: Expr | undefined) => {
    if (!expr) return;
    if (expr.kind === "block") {
      for (const stmt of expr.statements) {
        if (stmt.kind === "let") checkType(stmt.type, "owned", stmt);
        if (stmt.kind === "let" || stmt.kind === "destructure_let") checkExpr(stmt.value);
      }
      checkExpr(expr.expr);
      return;
    }
    for (const child of exprChildValues(expr)) checkExpr(child);
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      for (const param of decl.params) checkType(param.type, "param", param);
      checkType(decl.returnType, "owned", decl);
      checkExpr(decl.body);
    } else if (decl.kind === "let" || decl.kind === "const") {
      checkType(decl.type, "owned", decl);
      checkExpr(decl.value);
    } else if (decl.kind === "contract") {
      for (const param of decl.params) checkType(param.type, "param", param);
      checkExpr(decl.body);
    } else {
      for (const stmt of decl.body.statements) checkType(renderTypeExpr(stmt.value), "owned", stmt);
      if (decl.body.expr) checkType(renderTypeExpr(decl.body.expr), "owned", decl);
    }
  }
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
  ): Expr => {
    switch (expr.kind) {
      case "do":
        recordTypeExprHoleMatches(expr.strategy.effect, expectedType, resolvedTypeHoles);
        return lowerDoExpression(
          expr,
          diagnostics,
          (child) => lowerExpr(child, env),
          functionNames,
          env,
          typeDecls,
          allFnDecls,
          deferUntyped,
          resolvedTypeHoles,
        );
      case "const_fn":
        return { ...expr, body: lowerExpr(expr.body, env) };
      case "call":
        return {
          ...expr,
          callee: lowerExpr(expr.callee, env),
          args: expr.args.map((arg) => lowerExpr(arg, env)),
        };
      case "index":
        return { ...expr, target: lowerExpr(expr.target, env), index: lowerExpr(expr.index, env) };
      case "binary":
        return { ...expr, left: lowerExpr(expr.left, env), right: lowerExpr(expr.right, env) };
      case "pipe_bind": {
        return { ...expr, value: lowerExpr(expr.value, env), body: lowerExpr(expr.body, env) };
      }
      case "profile":
        return {
          ...expr,
          args: expr.args.map((arg) => lowerExpr(arg, env)),
          body: lowerExpr(expr.body, env, expectedType),
        };
      case "match":
        return {
          ...expr,
          value: lowerExpr(expr.value, env),
          arms: expr.arms.map((arm) => ({ ...arm, value: lowerExpr(arm.value, env) })),
        };
      case "shape":
      case "product_constructor":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({
            ...slot,
            index: slot.index ? lowerExpr(slot.index, env) : undefined,
            value: lowerExpr(slot.value, env),
          })),
        };
      case "static_for_slots":
        return {
          ...expr,
          source: expr.source.kind === "range"
            ? {
              kind: "range",
              start: lowerExpr(expr.source.start, env),
              end: lowerExpr(expr.source.end, env),
            }
            : { kind: "shape", shape: lowerExpr(expr.source.shape, env) },
          value: lowerExpr(expr.value, env),
        };
      case "field":
        return { ...expr, value: lowerExpr(expr.value, env), key: lowerExpr(expr.key, env) };
      case "range":
        return { ...expr, start: lowerExpr(expr.start, env), end: lowerExpr(expr.end, env) };
      case "block": {
        const scoped = new Map(env);
        const statements = expr.statements.map((stmt) => {
          if (stmt.kind === "let") {
            const explicit = explicitTypeAnnotation(stmt.type);
            const value = lowerExpr(stmt.value, scoped, explicit);
            const type = explicit ??
              exprBindingType(value, ownershipEnvFromTypes(scoped), typeDecls, allFnDecls);
            if (type) scoped.set(stmt.name, type);
            return { ...stmt, value } as Statement;
          }
          if (stmt.kind === "destructure_let") {
            return { ...stmt, value: lowerExpr(stmt.value, scoped) } as Statement;
          }
          if (stmt.kind === "debug_trace") {
            return { ...stmt, args: stmt.args.map((arg) => lowerExpr(arg, scoped)) } as Statement;
          }
          return stmt;
        });
        return {
          ...expr,
          statements,
          expr: expr.expr ? lowerExpr(expr.expr, scoped, expectedType) : undefined,
        };
      }
      case "literal":
      case "placeholder":
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
      ) as BlockExpr;
    } else if (decl.kind === "contract") {
      decl.body = lowerExpr(
        decl.body,
        new Map(
          decl.params.filter((param) => !param.const).map((param) => [param.name, param.type]),
        ),
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
): Expr {
  const proofEffect = renderTypeExpr(expr.strategy.effect);
  const effect = doRuntimeEffectName(expr.strategy.effect, expr.strategy.name, functionNames) ??
    proofEffect;
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
    diagnostics,
    expr.strategy.span,
  );
  validateDoStrategyEvidence(
    expr.strategy.effect,
    effect,
    strategy,
    functionNames,
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
    monadicDo(effect, loweredStatements, finalExpr),
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

function validateDoStrategyEvidence(
  effect: TypeExpr,
  runtimeEffect: string,
  strategy: string,
  functionNames: Set<string> | undefined,
  diagnostics: Diagnostic[],
  span?: Span,
) {
  if (!functionNames) return;
  const required = strategy === "monad" ? ["bind", "pure"] : ["map", "pure", "apply"];
  const missing = required.filter((member) =>
    !hasDoEffectMember(functionNames, runtimeEffect, member)
  );
  if (!missing.length) return;
  const contract = strategy === "monad" ? "Monad" : "Applicative";
  diagnostics.push({
    code: "do.missing_strategy_proof",
    message: `@${strategy} do requires @satisfies(${
      renderTypeExpr(effect)
    }, ${contract}): missing ${missing.map((member) => `${runtimeEffect}::${member}`).join(", ")}`,
    span,
  });
}

function validateDoStrategyType(
  effect: TypeExpr,
  strategy: string,
  types: TypeDecl[],
  functionNames: Set<string> | undefined,
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
    if (!hasDoEffectMember(functionNames, effectName, member)) {
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
): string | undefined {
  if (effect.kind !== "type_call") return undefined;
  const callee = renderTypeExpr(effect.callee);
  const member = strategy === "applicative" ? "map" : "bind";
  if (hasDoEffectMember(functionNames, callee, member)) return callee;
  return undefined;
}

function hasDoEffectMember(
  functionNames: Set<string> | undefined,
  effectName: string,
  member: string,
): boolean {
  if (!functionNames) return false;
  if (functionNames.has(`${effectName}::${member}`)) return true;
  const localName = effectName.split(".").at(-1) ?? effectName;
  return functionNames.has(`${localName}::${member}`);
}

function findTypeDeclByName(types: TypeDecl[], name: string): TypeDecl | undefined {
  return types.find((item) => item.name === name || terminalName(item.name) === name);
}

function typeExprContainsHole(expr: TypeExpr): boolean {
  switch (expr.kind) {
    case "type_hole":
      return true;
    case "type_call":
      return typeExprContainsHole(expr.callee) || expr.args.some(typeExprContainsHole);
    case "type_shape":
      return expr.shape.slots.some((slot) => typeExprContainsHole(slot.type));
    case "type_match":
      return typeExprContainsHole(expr.value) ||
        expr.arms.some((arm) => typeExprContainsHole(arm.value));
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
    case "placeholder":
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
): Expr {
  const [head, ...tail] = statements;
  if (!head) return finalExpr ?? callExpr(`${effect}::pure`, [{ kind: "var", name: stateName }]);
  if (head.kind === "do_bind" || head.kind === "do_expr") {
    const nextStateName = head.kind === "do_bind" ? head.name : `__state${depth}`;
    return callExpr(`${effect}::bind`, [
      injectStateArgument(head.value, stateName),
      {
        kind: "const_fn",
        params: [nextStateName],
        body: stateMonadicDo(effect, nextStateName, tail, finalExpr, depth + 1),
        allowCaptures: true,
      },
    ]);
  }
  return {
    kind: "block",
    statements: [head],
    expr: stateMonadicDo(effect, stateName, tail, finalExpr, depth),
  };
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
  const proofValue = {
    kind: "type_call" as const,
    callee: { kind: "type_static_ref" as const, name: "satisfies" },
    args: [
      proofEffect,
      { kind: "type_ref" as const, name: strategy === "monad" ? "Monad" : "Applicative" },
    ],
  };
  return {
    kind: "block",
    statements: [{
      kind: "proof_const",
      name: "__do_strategy_proof",
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

function monadicDo(effect: string, statements: DoStatement[], finalExpr: Expr): Expr {
  const [head, ...tail] = statements;
  if (!head) return finalExpr;
  if (head.kind === "do_bind") {
    return callExpr(`${effect}::bind`, [
      head.value,
      {
        kind: "const_fn",
        params: [head.name],
        body: monadicDo(effect, tail, finalExpr),
        allowCaptures: true,
      },
    ]);
  }
  if (head.kind === "do_expr") {
    return callExpr(`${effect}::bind`, [
      head.value,
      {
        kind: "const_fn",
        params: ["_"],
        body: monadicDo(effect, tail, finalExpr),
        allowCaptures: true,
      },
    ]);
  }
  return { kind: "block", statements: [head], expr: monadicDo(effect, tail, finalExpr) };
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
      return [expr.callee, ...expr.args];
    case "index":
      return [expr.target, expr.index];
    case "binary":
      return [expr.left, expr.right];
    case "pipe_bind":
      return [expr.value, expr.body];
    case "profile":
      return [...expr.args, expr.body];
    case "match":
      return [expr.value, ...expr.arms.map((arm) => arm.value)];
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
    case "placeholder":
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
    case "placeholder":
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
) {
  const descriptors = typeDecls
    .flatMap((decl): { decl: TypeDecl; descriptor: OperatorDescriptor }[] =>
      decl.resultKind === "operator" && decl.normalized?.kind === "operator"
        ? [{ decl, descriptor: decl.normalized.descriptor }]
        : []
    );
  if (!descriptors.length) return;
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
      case "binary": {
        const left = lowerExpr(expr.left, env);
        const right = lowerExpr(expr.right, env);
        const leftType = inferRuntimeType(left, env, functions, constructorTypes, memo);
        const rightType = inferRuntimeType(right, env, functions, constructorTypes, memo);
        if (
          isPrimitiveBinaryOperator(expr.op, leftType, rightType, typeDecls) ||
          (!leftType && !rightType)
        ) {
          return { ...expr, left, right };
        }
        const resolved = resolveInfixOperator(
          expr.op,
          left,
          right,
          env,
          functions,
          constructorTypes,
          descriptors,
          memo,
        );
        if (!resolved) {
          if (!leftType || !rightType) return { ...expr, left, right };
          diagnostics.push({
            code: "operator.missing",
            message: `no visible operator descriptor matches ${expr.op}`,
          });
          return { ...expr, left, right };
        }
        if (resolved === "ambiguous") {
          diagnostics.push({
            code: "operator.ambiguous",
            message: `multiple visible operator descriptors match ${expr.op}`,
          });
          return { ...expr, left, right };
        }
        return { kind: "call", callee: { kind: "var", name: resolved }, args: [left, right] };
      }
      case "call":
        return {
          ...expr,
          callee: lowerExpr(expr.callee, env),
          args: expr.args.map((arg) => lowerExpr(arg, env)),
        };
      case "index":
        return { ...expr, target: lowerExpr(expr.target, env), index: lowerExpr(expr.index, env) };
      case "pipe_bind":
        return { ...expr, value: lowerExpr(expr.value, env), body: lowerExpr(expr.body, env) };
      case "match":
        return {
          ...expr,
          value: lowerExpr(expr.value, env),
          arms: expr.arms.map((arm) => ({ ...arm, value: lowerExpr(arm.value, env) })),
        };
      case "shape":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({
            ...slot,
            index: slot.index ? lowerExpr(slot.index, env) : undefined,
            value: lowerExpr(slot.value, env),
          })),
        };
      case "product_constructor":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({
            ...slot,
            index: slot.index ? lowerExpr(slot.index, env) : undefined,
            value: lowerExpr(slot.value, env),
          })),
        };
      case "range":
        return { ...expr, start: lowerExpr(expr.start, env), end: lowerExpr(expr.end, env) };
      case "block": {
        const scoped = new Map(env);
        const statements = expr.statements.map((stmt) => {
          if (stmt.kind !== "let" && stmt.kind !== "destructure_let") return stmt;
          const value = lowerExpr(stmt.value, scoped);
          const explicit = stmt.kind === "let" ? explicitTypeAnnotation(stmt.type) : undefined;
          if (stmt.kind === "let" && explicit) {
            scoped.set(stmt.name, explicit);
          } else if (stmt.kind === "let") {
            const inferred = inferRuntimeType(value, scoped, functions, undefined, memo);
            if (inferred) scoped.set(stmt.name, inferred);
          }
          return { ...stmt, value } as typeof stmt;
        });
        return { ...expr, statements, expr: expr.expr ? lowerExpr(expr.expr, scoped) : undefined };
      }
      default:
        return expr;
    }
  };

  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      const env = new Map(decl.params.map((param) => [param.name, param.type]));
      decl.body = lowerExpr(decl.body, env) as Extract<Expr, { kind: "block" }>;
    } else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = lowerExpr(decl.value, new Map());
    }
  }
}

function isPrimitiveBinaryOperator(
  op: string,
  left: string | undefined,
  right: string | undefined,
  types: TypeDecl[],
): boolean {
  if (op === "..") return true;
  if (["==", "!="].includes(op) && (literalTypeCarrier(left) || literalTypeCarrier(right))) {
    return (literalTypeCarrier(left) ?? left) === (literalTypeCarrier(right) ?? right);
  }
  const leftRuntime = primitiveNumericRuntimeType(left, types);
  const rightRuntime = primitiveNumericRuntimeType(right, types);
  return leftRuntime === "i32" && rightRuntime === "i32" &&
    ["+", "-", "*", "/", "%", "==", "!=", "<", "<=", ">", ">="].includes(op);
}

function primitiveNumericRuntimeType(
  type: string | undefined,
  types: TypeDecl[],
): string | undefined {
  const resolved = resolveAliasType(type, types) ?? type;
  const runtime = scalarDomainRuntimeType(resolved);
  return runtime === "count" ? "i32" : runtime;
}

function lowerCollectorLiterals(
  program: Program,
  typeDecls: TypeDecl[],
  fnDecls: FnDecl[],
  diagnostics: Diagnostic[],
) {
  const functions = new Map(fnDecls.map((fn) => [fn.name, fn]));
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
          arms: expr.arms.map((arm) => ({ ...arm, value: lowerExpr(arm.value, expectedType) })),
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
      case "placeholder":
      case "var":
        return expr;
    }
  };

  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      decl.body = lowerExpr(decl.body, decl.returnType) as Extract<Expr, { kind: "block" }>;
    } else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = lowerExpr(decl.value, explicitTypeAnnotation(decl.type));
    } else if (decl.kind === "contract") {
      decl.body = lowerExpr(decl.body, undefined) as Extract<Expr, { kind: "block" }>;
    }
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

function findTypeDecl(typeDecls: TypeDecl[], name: string): TypeDecl | undefined {
  return typeDecls.find((item) => item.name === name) ??
    typeDecls.find((item) => terminalName(item.name) === terminalName(name));
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
  descriptors: { decl: TypeDecl; descriptor: OperatorDescriptor }[],
  memo?: CheckMemo,
): string | "ambiguous" | undefined {
  const leftType = inferRuntimeType(left, env, functions, constructorTypes, memo);
  const rightType = inferRuntimeType(right, env, functions, constructorTypes, memo);
  const matches: string[] = [];
  for (const { decl, descriptor } of descriptors) {
    if (descriptor.symbol !== symbol || !descriptor.fixity.startsWith("#infix")) continue;
    const target = substituteOperatorTarget(
      descriptor.target,
      decl,
      [leftType, rightType],
      functions,
    );
    const fn = functions.get(target);
    if (!fn || fn.params.length !== 2) continue;
    if (!operandMatchesParam(fn.params[0].type, left, leftType, functions, memo)) continue;
    if (!operandMatchesParam(fn.params[1].type, right, rightType, functions, memo)) continue;
    matches.push(target);
  }
  return matches.length > 1 ? "ambiguous" : matches[0];
}

function operandMatchesParam(
  expected: string,
  expr: Expr,
  actual: string | undefined,
  functions: Map<string, FnDecl>,
  memo?: CheckMemo,
): boolean {
  if (actual && typeMatches(expected, actual, memo)) return true;
  if (expr.kind !== "var") return false;
  return fnTypeMatches(expected, functions.get(expr.name));
}

function substituteOperatorTarget(
  target: string,
  decl: TypeDecl,
  operandTypes: (string | undefined)[],
  functions: Map<string, FnDecl>,
): string {
  if (!decl.params.length) return target;
  const bases = operandTypes
    .filter((type): type is string => !!type && !type.startsWith("fn("))
    .map((type) => type.replace(/\(.*\)$/, ""));
  for (const base of bases) {
    let result = target;
    for (const param of decl.params) {
      result = result.replace(new RegExp(`\\b${param.name}\\.`, "g"), `${base}.`);
      result = result.replace(new RegExp(`\\b${param.name}::`, "g"), `${base}::`);
    }
    if (functions.has(result)) return result;
  }
  return target;
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
    if (expr.literalKind === "number") return finish("i32");
    if (expr.literalKind === "bool") return finish("bool");
    return finish(expr.inferredType);
  }
  if (expr.kind === "var") {
    const localType = stripBorrowType(env.get(expr.name));
    return finish(
      localType ||
        (functions.has(expr.name) ? renderFnType(functions.get(expr.name)!) : undefined),
    );
  }
  if (expr.kind === "call" && expr.callee.kind === "var") {
    return finish(functions.get(expr.callee.name)?.returnType);
  }
  if (expr.kind === "product_constructor") {
    return finish(inferProductConstructorType(expr, env, functions, constructorTypes, memo));
  }
  if (expr.kind === "range") return finish("range_i32");
  return finish(undefined);
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

function groupFunctionClauses(program: Program, diagnostics: Diagnostic[]) {
  const groups = new Map<string, FnDecl[]>();
  for (const decl of program.declarations) {
    if (decl.kind !== "fn" || decl.generated) continue;
    const group = groups.get(decl.name) ?? [];
    group.push(decl);
    groups.set(decl.name, group);
  }
  const replacements = new Map<FnDecl, FnDecl[]>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    let compatible = true;
    const dispatcherParams = first.params.map((param, index) => ({
      ...param,
      type: groupParamDispatchType(group, index),
    }));
    const dispatcherSignature = { ...first, params: dispatcherParams };
    for (const clause of group.slice(1)) {
      if (clause.params.length !== first.params.length) {
        diagnostics.push({
          code: "fn.clause_arity",
          message: `function ${first.name} clauses must have the same arity`,
        });
        compatible = false;
      }
      if (clause.public !== first.public) {
        diagnostics.push({
          code: "fn.clause_visibility",
          message: `function ${first.name} clauses must have the same visibility`,
        });
        compatible = false;
      }
      if ((clause.returnType ?? "") !== (first.returnType ?? "")) {
        diagnostics.push({
          code: "fn.clause_return",
          message: `function ${first.name} clauses must have the same return type`,
        });
        compatible = false;
      }
      if (clause.effects.join("\0") !== first.effects.join("\0")) {
        diagnostics.push({
          code: "fn.clause_effects",
          message: `function ${first.name} clauses must have the same effects`,
        });
        compatible = false;
      }
      clause.params.forEach((param, index) => {
        if (!clauseParamTypesCompatible(first.params[index]?.type, param.type)) {
          diagnostics.push({
            code: "fn.clause_param_type",
            message: `function ${first.name} clause parameter ${index + 1} has incompatible type`,
          });
          compatible = false;
        }
      });
    }
    if (!compatible) continue;
    checkUnreachableFunctionClauses(dispatcherSignature, group, diagnostics);
    checkOverlappingFunctionClauses(group, diagnostics);
    if (
      first.memberOf &&
      group.every((clause) => clauseTests(dispatcherSignature, clause).length === 0)
    ) {
      diagnostics.push({
        code: "type.duplicate_member",
        message:
          `type ${first.memberOf.owner} has duplicate static member ${first.memberOf.member}`,
      });
      continue;
    }
    for (let index = 0; index < group.length; index++) {
      const clause = group[index]!;
      if (!clause.branchHint) continue;
      if (clauseTests(first, clause).length > 0) continue;
      const previous = group[index - 1];
      if (
        index === group.length - 1 && previous &&
        clauseTests(first, previous).length > 0 && !previous.branchHint
      ) continue;
      diagnostics.push({
        code: "branch_hint.unmapped",
        message: "branch hint cannot be attached to a generated runtime conditional",
        span: clause.nameSpan ?? clause.span,
      });
    }
    const generated = group.map((clause, index): FnDecl => ({
      ...clause,
      memberOf: undefined,
      public: false,
      name: `${clause.name}__clause_${index}`,
      params: clause.params.map((param) => ({
        ...param,
        pattern: { kind: "binding", name: param.name },
      })),
      generated: true,
      branchHint: undefined,
    }));
    const inlineableDispatcher = group.every((clause) =>
      !exprCallsFunction(clause.body, first.name)
    );
    const dispatcher: FnDecl = {
      ...first,
      params: dispatcherParams.map((param) => ({
        ...param,
        pattern: { kind: "binding", name: param.name },
      })),
      body: clauseDispatcherBody(dispatcherSignature, group),
      generated: true,
      generatedInlineable: inlineableDispatcher,
      branchHint: undefined,
    };
    replacements.set(first, [dispatcher, ...generated]);
    for (const clause of group.slice(1)) replacements.set(clause, []);
  }
  if (!replacements.size) return;
  program.declarations = program.declarations.flatMap((decl): Program["declarations"] =>
    decl.kind === "fn" ? (replacements.get(decl) ?? [decl]) : [decl]
  );
}

function checkUnreachableFunctionClauses(
  signature: FnDecl,
  clauses: FnDecl[],
  diagnostics: Diagnostic[],
): void {
  if (signature.params.length !== 1 || clauses.length < 2) return;
  let coveredAll = false;
  const coveredValues = new Set<string>();
  for (let index = 0; index < clauses.length; index++) {
    const clause = clauses[index]!;
    const coverage = singleParamClauseCoverage(signature, clause);
    if (coverage === undefined) continue;
    const unreachable = coveredAll ||
      (coverage !== "all" && coverage.every((value) => coveredValues.has(value)));
    if (unreachable) {
      diagnostics.push(diagnosticAt(
        "fn.unreachable_clause",
        `function ${clause.name} clause ${
          index + 1
        } is unreachable because earlier clauses cover it`,
        clause,
      ));
      continue;
    }
    if (coverage === "all") {
      coveredAll = true;
    } else {
      for (const value of coverage) coveredValues.add(value);
    }
  }
}

function checkOverlappingFunctionClauses(
  clauses: FnDecl[],
  diagnostics: Diagnostic[],
): void {
  for (let rightIndex = 1; rightIndex < clauses.length; rightIndex++) {
    const right = clauses[rightIndex]!;
    for (let leftIndex = 0; leftIndex < rightIndex; leftIndex++) {
      const left = clauses[leftIndex]!;
      const overlap = refinedClauseOverlap(left, right);
      if (!overlap) continue;
      diagnostics.push(diagnosticAt(
        "fn.overlapping_clause",
        `function ${right.name} clause ${rightIndex + 1} overlaps clause ${
          leftIndex + 1
        } on ${overlap}`,
        right,
      ));
      break;
    }
  }
}

function refinedClauseOverlap(left: FnDecl, right: FnDecl): string | undefined {
  const overlaps: string[] = [];
  let sawRefinedPair = false;
  let rightContainedInLeft = true;
  for (let index = 0; index < Math.min(left.params.length, right.params.length); index++) {
    const leftDomain = clauseParamEffectiveDomain(left.params[index]);
    const rightDomain = clauseParamEffectiveDomain(right.params[index]);
    if (!leftDomain || !rightDomain) continue;
    sawRefinedPair = true;
    const intersection = intersectDomain(leftDomain, rightDomain);
    if (domainIsEmpty(intersection)) return undefined;
    overlaps.push(canonicalDomainKey(intersection));
    if (!domainContains(leftDomain, rightDomain)) rightContainedInLeft = false;
  }
  if (!sawRefinedPair || rightContainedInLeft) return undefined;
  return overlaps.join(", ");
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
      "fn.clause_domain_uncovered",
      `call to ${calleeName} may reach no function clause for argument ${index + 1} domain ${
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

function clauseParamEffectiveDomain(param: Param | undefined): RefinedI32Domain | undefined {
  if (!param) return undefined;
  const typeDomain = parseRefinedI32Type(param.type);
  const literal = param.pattern
    ? finitePatternValue(param.pattern, scalarDomainRuntimeType(param.type) ?? param.type)
    : undefined;
  if (literal === undefined || !/^-?[0-9]+$/.test(literal)) return typeDomain;
  const value = Number.parseInt(literal, 10);
  if (!Number.isSafeInteger(value)) return typeDomain;
  const literalDomain = scalarFactsFromI32Range({ min: value, max: value }).domain;
  return typeDomain ? intersectDomain(typeDomain, literalDomain) : literalDomain;
}

function singleParamClauseCoverage(
  signature: FnDecl,
  clause: FnDecl,
): "all" | string[] | undefined {
  const param = clause.params[0];
  if (!param) return undefined;
  const pattern = param.pattern;
  const signatureType = scalarDomainRuntimeType(signature.params[0]?.type) ??
    signature.params[0]?.type;
  if (isCatchAllPattern(pattern)) {
    const domainValues = finiteI32DomainValues(parseRefinedI32Type(param.type));
    if (domainValues) return domainValues;
    return signatureType === scalarDomainRuntimeType(param.type) ? "all" : undefined;
  }
  if (!pattern) return undefined;
  const literal = finitePatternValue(pattern, scalarDomainRuntimeType(param.type) ?? param.type);
  return literal === undefined ? undefined : [literal];
}

function groupParamDispatchType(group: FnDecl[], index: number): string {
  const types = group.map((clause) => clause.params[index]?.type);
  const first = types[0] ?? "i32";
  if (types.every((type) => type === first)) return first;
  const runtimeTypes = types.map((type) => scalarDomainRuntimeType(type));
  const runtime = runtimeTypes[0];
  return runtime && runtimeTypes.every((type) => type === runtime) ? runtime : first;
}

function clauseParamTypesCompatible(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === right) return true;
  const leftRuntime = scalarDomainRuntimeType(left);
  const rightRuntime = scalarDomainRuntimeType(right);
  return !!leftRuntime && leftRuntime === rightRuntime;
}

function checkBranchHints(
  program: Program,
  diagnostics: Diagnostic[],
  pluginRegistry: CompilerPluginRegistry,
) {
  const likely = annotationBranchHint("likely", pluginRegistry);
  const unlikely = annotationBranchHint("unlikely", pluginRegistry);
  if (likely !== "likely" || unlikely !== "unlikely") {
    diagnostics.push({
      code: "plugin.annotation",
      message: "core branch hint annotations @likely and @unlikely must be registered",
    });
  }
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") continue;
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
        message: `branch hint on function ${decl.name} is only valid on function clauses`,
        span: decl.nameSpan ?? decl.span,
      });
    }
    checkBranchHintsInBlock(decl.body, diagnostics, pluginRegistry);
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
    case "pipe_bind":
      checkBranchHintsInExpr(expr.value, diagnostics, pluginRegistry);
      checkBranchHintsInExpr(expr.body, diagnostics, pluginRegistry);
      return;
    case "match":
      checkBranchHintsInExpr(expr.value, diagnostics, pluginRegistry);
      validateMatchBranchHints(expr, diagnostics, pluginRegistry);
      expr.arms.forEach((arm) => checkBranchHintsInExpr(arm.value, diagnostics, pluginRegistry));
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
    case "placeholder":
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
    case "type":
      return pattern.name;
    case "tuple":
      return `[${pattern.items.map(renderParamPattern).join(", ")}]`;
    case "constructor":
      return `${pattern.name}(${pattern.args.map(renderParamPattern).join(",")})`;
  }
}

function patternTestExpr(pattern: ParamPattern | undefined, value: Expr): Expr | undefined {
  if (!pattern || pattern.kind === "binding" || pattern.kind === "wildcard") return undefined;
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

function typeFragmentMembers(decl: TypeDecl) {
  const expr = decl.body.expr;
  if (!expr) return [];
  if (expr.kind === "type_shape") return expr.shape.members ?? [];
  const target = builderPrimaryShape(decl, expr);
  if (target) return target.shape.members ?? [];
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
  const replacement: TypeExpr = { kind: "type_shape", shape: { slots: [], members: [] } };
  decl.body.expr = replacement;
  return replacement.shape.members!;
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
    if (!fn.memberOf || fn.primitiveId || isIntrinsicWrapper(fn)) continue;
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
    case "var":
      return members.has(expr.name) ? { kind: "var", name: members.get(expr.name)! } : expr;
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
    case "placeholder":
      return expr;
  }
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
            value: expr.value.slice(1, -1),
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
    if (block.statements.some((stmt) => stmt.kind !== "let" && stmt.kind !== "proof_const")) {
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
      case "operator":
        return { kind: "operator", descriptor: body.descriptor };
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
  if (pattern.kind === "wildcard" || pattern.kind === "binding") return true;
  if (pattern.kind !== "literal" && pattern.kind !== "type") return false;
  const text = renderParamPattern(pattern);
  if (value.kind === "bool") return text === (value.value ? "true" : "false");
  if (value.kind === "number") return text === value.value;
  if (value.kind === "string") return text === JSON.stringify(value.value);
  if (value.kind === "literal_type") return text === `#${value.value}`;
  if (value.kind === "type") return text === value.name;
  return false;
}

function renderConstTypeArg(value: ConstValue): string {
  if (value.kind === "type") return value.name;
  if (value.kind === "fn") return value.name;
  if (value.kind === "number") return value.value;
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
    const reportAmbiguous = !decl.generated && !fnUsesInferredTypeVars(decl, consts);
    decl.body = specializeInferredBlock(
      decl.body,
      context,
      new Map(decl.params.map((param) => [param.name, param.type])),
      !decl.generated && decl.returnType && !annotationHasInferredVars(decl.returnType)
        ? decl.returnType
        : undefined,
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
  return {
    ...block,
    statements: block.statements.map((stmt) => {
      if (stmt.kind === "let") {
        const value = specializeInferredExpr(
          stmt.value,
          context,
          scoped,
          explicitTypeAnnotation(stmt.type),
          reportAmbiguous,
        );
        const type = explicitTypeAnnotation(stmt.type) ?? inferExprType(value, context, scoped);
        if (type) scoped.set(stmt.name, type);
        return { ...stmt, value };
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
        const slotTypes = stmt.slotTypes ?? (type ? stmt.names.map(() => type) : undefined);
        if (slotTypes) {
          stmt.names.forEach((name, index) => {
            const slotType = slotTypes[index] ?? type;
            if (slotType) scoped.set(name, slotType);
          });
        }
        return { ...stmt, value, slotTypes };
      }
      return stmt;
    }),
    expr: block.expr
      ? specializeInferredExpr(block.expr, context, scoped, expectedType, reportAmbiguous)
      : undefined,
  };
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
    case "const_fn":
      return { ...expr, span: expr.span, body: specializeInferredExpr(expr.body, context, env) };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => specializeInferredExpr(arg, context, env)),
        body: specializeInferredExpr(expr.body, context, env, expectedType, reportAmbiguous),
      };
    case "call": {
      context.stats && (context.stats.visitedCalls += 1);
      const callee = specializeInferredExpr(expr.callee, context, env);
      const fn = callee.kind === "var" ? context.functions.get(callee.name) : undefined;
      const args = expr.args.map((arg) =>
        specializeInferredExpr(arg, context, env, undefined, false)
      );
      if (!fn || !fnUsesInferredTypeVars(fn, context.consts)) return { ...expr, callee, args };
      return specializeInferredCall(
        fn,
        args,
        context,
        env,
        callSiteSpan(expr),
        expectedType,
        reportAmbiguous,
      ) ??
        { ...expr, callee, args };
    }
    case "index":
      return {
        ...expr,
        target: specializeInferredExpr(expr.target, context, env),
        index: specializeInferredExpr(expr.index, context, env),
      };
    case "binary":
      return {
        ...expr,
        left: specializeInferredExpr(expr.left, context, env),
        right: specializeInferredExpr(expr.right, context, env),
      };
    case "pipe_bind": {
      const value = specializeInferredExpr(expr.value, context, env);
      const valueType = inferExprType(value, context, env);
      const scoped = valueType && !hasUnresolvedStaticTypeName(valueType, context)
        ? new Map(env).set(expr.name, valueType)
        : env;
      return {
        ...expr,
        value,
        body: specializeInferredExpr(expr.body, context, scoped, expectedType),
      };
    }
    case "match":
      return {
        ...expr,
        value: specializeInferredExpr(expr.value, context, env),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: specializeInferredExpr(arm.value, context, env, expectedType),
        })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index ? specializeInferredExpr(slot.index, context, env) : undefined,
          value: specializeInferredExpr(slot.value, context, env),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          index: slot.index ? specializeInferredExpr(slot.index, context, env) : undefined,
          value: specializeInferredExpr(slot.value, context, env),
        })),
      };
    case "range":
      return {
        ...expr,
        start: specializeInferredExpr(expr.start, context, env),
        end: specializeInferredExpr(expr.end, context, env),
      };
    case "static_for_slots":
      return {
        ...expr,
        value: specializeInferredExpr(expr.value, context, env),
      };
    case "field":
      return {
        ...expr,
        value: specializeInferredExpr(expr.value, context, env),
        key: specializeInferredExpr(expr.key, context, env),
      };
    case "block":
      return specializeInferredBlock(expr, context, env, expectedType, reportAmbiguous);
    case "literal":
    case "var":
    case "placeholder":
      return expr;
  }
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

function fnUsesInferredTypeVars(fn: FnDecl, consts?: Map<string, ConstValue>): boolean {
  return collectTypeVars(fn, consts).size > 0;
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
    const nonConstParams = fn.params.filter((param) => !param.const);
    const omitConstArgs = false;
    let runtimeArgIndex = 0;
    const argsByParam = fn.params.map((param, index) => {
      if (!omitConstArgs) return args[index];
      if (param.const) return undefined;
      return args[runtimeArgIndex++];
    });
    for (let index = 0; index < fn.params.length; index++) {
      const param = fn.params[index];
      const arg = argsByParam[index];
      if (!param.const || !arg) continue;
      if (exprContainsPlaceholder(arg)) continue;
      if (!staticConstArgValue(arg, substituteTypeVars(param.type, types), context)) {
        return undefined;
      }
    }
    fn.params.forEach((param, index) => {
      const arg = argsByParam[index];
      inferFromValuePattern(param.type, arg, types, context, env);
      if (param.const) {
        if (!arg) return;
        const staticArg = staticConstArgValue(arg, substituteTypeVars(param.type, types), context);
        if (!staticArg) return;
        const match = staticArg.name.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
        const expected = param.type.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([a-z][A-Za-z0-9_]*)\)$/);
        if (match && expected && match[1] === expected[1]) {
          types.set(expected[2], match[2].trim());
          staticArgNames.push(staticArg.name);
          staticNames.set(param.name, staticArg.name);
          return;
        }
        if (staticArg.value.kind === "fn") {
          inferFnTypeArgs(
            param.type,
            context.functions.get(staticArg.value.name),
            types,
            context.consts,
          );
        }
        staticArgNames.push(staticArg.name);
        staticNames.set(param.name, staticArg.name);
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
    });
    const missingTypeVars = [...collectTypeVars(fn, context.consts)].filter((name) =>
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
        runtimeSpecializedType(specializedType, context.types),
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

function inferFromValuePattern(
  pattern: ParamPattern | string,
  arg: Expr | undefined,
  types: Map<string, string>,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
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
    const literalType = arg.inferredType ?? (arg.literalKind === "number" ? "i32" : undefined);
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
    const directFn = context.functions.get(arg.name);
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
  },
  env = new Map<string, string>(),
): string | undefined {
  if (expr.kind === "literal") {
    if (expr.inferredType) return expr.inferredType;
    if (expr.literalKind === "number") return "i32";
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
    const fn = context.functions.get(expr.callee.name);
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

function collectTypeVars(fn: FnDecl, consts?: Map<string, ConstValue>): Set<string> {
  const vars = new Set<string>();
  const staticParams = new Set(
    fn.params.filter((param) => param.const).map((param) => param.name),
  );
  for (const text of [...fn.params.map((param) => param.type), fn.returnType ?? ""]) {
    collectFreeTypeVars(text, vars, staticParams, consts);
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
  if (!parsed) return;
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
      for (const item of parseAnnotationTypeCalls(expr.source)) visit(item);
    }
  };
  visit(parsed);
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
  if (expr.literalKind === "string") return { kind: "string", value: expr.value.slice(1, -1) };
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
  if (value.kind === "string") return type === "string" || type === "multiline";
  if (value.kind === "literal_type") return type === "literal";
  if (value.kind === "type") return type === "type";
  if (value.kind === "fn") return type.trim().startsWith("fn(");
  return false;
}

function literalConstName(value: ConstValue): string {
  if (value.kind === "bool") return value.value ? "true" : "false";
  if (value.kind === "number") return value.value;
  if (value.kind === "string") return `str_${wgslShaderId(value.value)}`;
  if (value.kind === "literal_type") return `#${value.value}`;
  return constValueKey(value);
}

function stringLiteralValue(expr: Expr | undefined): string | undefined {
  if (expr?.kind !== "literal") return undefined;
  if (expr.literalKind === "string") return expr.value.slice(1, -1);
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
  pattern = substituteTypeVars(pattern, types);
  actual = substituteTypeVars(actual, types);
  const key = `${pattern}\0${actual}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (isInferredTypeVarName(pattern)) {
    if (isUnresolvedInferredBinding(actual) && !consts?.has(actual.trim())) return;
    types.set(pattern, actual);
    return;
  }
  actual = actual.includes("(") ? actual : resolveAliasType(actual, typeDecls) ?? actual;
  if (pattern === actual) return;
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
    case "type_binary":
      return {
        ...expr,
        left: substituteTypeVarsInTypeExpr(expr.left, types, staticNames),
        right: substituteTypeVarsInTypeExpr(expr.right, types, staticNames),
      };
    case "type_operator":
      return expr;
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
    return {
      ...expr,
      callee: substituteInferredExpr(expr.callee, types, staticNames, proofTypes, context),
      args: expr.args.map((arg) =>
        substituteInferredExpr(arg, types, staticNames, proofTypes, context)
      ),
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
      if (stmt.kind === "proof_const") {
        const value = typeEvaluator?.eval(
          substituteTypeVarsInTypeExpr(stmt.value, types, staticNames),
          typeEvalLocals,
        );
        if (!value || value.kind === "never") {
          context?.diagnostics.push({
            code: "type.proof_const",
            message: `proof const ${stmt.name} could not be evaluated`,
            span: context.diagnosticSpan,
          });
        } else {
          typeEvalLocals.set(stmt.name, value);
          if (value.kind === "type") blockProofTypes.set(stmt.name, value);
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
      !fnUsesInferredTypeVars(decl, consts)
    ) {
      specializeBlock(
        decl.body,
        context,
        new Map(
          decl.params.filter((param) => !param.const).map((param) => [param.name, param.type]),
        ),
        decl.returnType,
      );
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
        context.activeStaticValues = active;
        try {
          specializeBlock(
            decl.body,
            context,
            new Map(decl.params.map((param) => [param.name, param.type])),
            decl.returnType,
          );
        } finally {
          context.activeStaticValues = previousActive;
        }
      }
    }
  }
  for (const decl of context.runtimeClosureCache.values()) {
    specializeBlock(
      decl.body,
      context,
      new Map(decl.params.map((param) => [param.name, param.type])),
      decl.returnType,
    );
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
        const direct = callee.kind === "var" ? context.functions.get(callee.name) : undefined;
        const args = expr.args.map((arg, index) => {
          const param = direct?.params[index];
          const rawExpected = param && !param.const ? param.type : undefined;
          const expected = rawExpected && !typeHasFreeInferredVars(rawExpected, context.consts)
            ? rawExpected
            : undefined;
          return specializeExpr(arg, context, env, expected);
        });
        if (!direct?.params.some((param) => param.const)) {
          if (direct && fnUsesInferredTypeVars(direct, context.consts)) {
            return specializeInferredCall(
              direct,
              args,
              context,
              env,
              callSiteSpan(expr),
              expectedType,
              false,
            ) ?? { ...expr, callee, args };
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
      case "placeholder":
        return expr;
    }
  } finally {
    context.runtimeEnv = previousRuntimeEnv;
  }
}

function expectedFunctionType(
  expectedType: string | undefined,
  types: TypeDecl[] = [],
): string | undefined {
  const direct = expectedType?.trim();
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
      runtimeArgs.push(arg);
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
  context: ConstSpecializationContext,
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
    case "placeholder":
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
  if (/^-?[0-9]+$/.test(source)) return { kind: "number", value: source };
  if (source.startsWith("#")) return { kind: "literal_type", value: source.slice(1) };
  return { kind: "type", name: source };
}

function isConstValue(value: unknown): value is ConstValue {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (
    kind === "bool" || kind === "number" || kind === "string" || kind === "literal_type" ||
    kind === "type" || kind === "fn" || kind === "never"
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
    !staticValues.has(name)
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
  const body = arg.body;
  const key = `__const_fn\0${expectedType}\0${JSON.stringify(body)}`;
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
  const paramNames = new Set(arg.params);
  const captureNames = [...exprRuntimeCaptures(body)].filter((name) =>
    !paramNames.has(name) && !context.functions.has(name) && !context.consts.has(name)
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
  const key = `__closure_fn\0${expectedType}\0${JSON.stringify(body)}\0${
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

function exprContainsPlaceholder(expr: Expr): boolean {
  if (expr.kind === "placeholder") return true;
  return exprChildren(expr).some(exprContainsPlaceholder);
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

function replacePlaceholder(expr: Expr, replacement: Expr): Expr {
  if (expr.kind === "placeholder") return cloneExpr(replacement);
  switch (expr.kind) {
    case "do":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
            ? { ...stmt, value: replacePlaceholder(stmt.value, replacement) }
            : stmt
        ),
        expr: expr.expr ? replacePlaceholder(expr.expr, replacement) : undefined,
      };
    case "const_fn":
      return { ...expr, body: replacePlaceholder(expr.body, replacement) };
    case "profile":
      return {
        ...expr,
        args: expr.args.map((arg) => replacePlaceholder(arg, replacement)),
        body: replacePlaceholder(expr.body, replacement),
      };
    case "call":
      return {
        ...expr,
        callee: replacePlaceholder(expr.callee, replacement),
        args: expr.args.map((arg) => replacePlaceholder(arg, replacement)),
      };
    case "index":
      return {
        ...expr,
        target: replacePlaceholder(expr.target, replacement),
        index: replacePlaceholder(expr.index, replacement),
      };
    case "binary":
      return {
        ...expr,
        left: replacePlaceholder(expr.left, replacement),
        right: replacePlaceholder(expr.right, replacement),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: replacePlaceholder(expr.value, replacement),
        body: replacePlaceholder(expr.body, replacement),
      };
    case "match":
      return {
        ...expr,
        value: replacePlaceholder(expr.value, replacement),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: replacePlaceholder(arm.value, replacement),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: replacePlaceholder(slot.value, replacement),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: replaceStaticForSourcePlaceholder(expr.source, replacement),
        value: replacePlaceholder(expr.value, replacement),
      };
    case "field":
      return {
        ...expr,
        value: replacePlaceholder(expr.value, replacement),
        key: replacePlaceholder(expr.key, replacement),
      };
    case "range":
      return {
        ...expr,
        start: replacePlaceholder(expr.start, replacement),
        end: replacePlaceholder(expr.end, replacement),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "let"
            ? { ...stmt, value: replacePlaceholder(stmt.value, replacement) }
            : stmt.kind === "destructure_let"
            ? { ...stmt, value: replacePlaceholder(stmt.value, replacement) }
            : stmt
        ),
        expr: expr.expr ? replacePlaceholder(expr.expr, replacement) : undefined,
      };
    case "literal":
    case "var":
      return expr;
  }
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
    case "placeholder":
    case "var":
      return expr;
  }
}

function replaceStaticForSourcePlaceholder(
  source: Extract<Expr, { kind: "static_for_slots" }>["source"],
  replacement: Expr,
): Extract<Expr, { kind: "static_for_slots" }>["source"] {
  return source.kind === "range"
    ? {
      kind: "range",
      start: replacePlaceholder(source.start, replacement),
      end: replacePlaceholder(source.end, replacement),
    }
    : { kind: "shape", shape: replacePlaceholder(source.shape, replacement) };
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
      return [expr.callee, ...expr.args];
    case "index":
      return [expr.target, expr.index];
    case "binary":
      return [expr.left, expr.right];
    case "pipe_bind":
      return [expr.value, expr.body];
    case "profile":
      return [...expr.args, expr.body];
    case "match":
      return [expr.value, ...expr.arms.map((arm) => arm.value)];
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
    case "placeholder":
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
          if (stmt.kind === "proof_const") return [];
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
    case "placeholder":
      return expr;
  }
}

function runtimeEnvHasName(env: Map<string, string> | undefined, name: string): boolean {
  return Boolean(env?.has(name));
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
  for (const [key, child] of Object.entries(value)) out[key] = clonePlainExpr(child, seen);
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
    return Number.parseInt(expr.value, 10);
  }
  if (expr.kind === "var") {
    const value = staticValues.get(expr.name);
    if (value?.kind === "number") return Number.parseInt(value.value, 10);
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
      const l = Number.parseInt(left.value, 10);
      const r = Number.parseInt(right.value, 10);
      if (expr.op === "+") {
        return finish(constValueWithSpan({ kind: "number", value: String(l + r) }, expr.span));
      }
      if (expr.op === "-") {
        return finish(constValueWithSpan({ kind: "number", value: String(l - r) }, expr.span));
      }
    }
    return finish(undefined);
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
    case "type_match":
      visitTypeExpr(expr.value, visit);
      for (const arm of expr.arms) visitTypeExpr(arm.value, visit);
      return;
    case "type_binary":
      visitTypeExpr(expr.left, visit);
      visitTypeExpr(expr.right, visit);
      return;
    case "type_ref":
    case "type_hole":
    case "type_static_ref":
    case "type_fn":
    case "type_operator":
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
  } else if (expr.kind === "type_match") {
    validateTypeExprScalarDomains(expr.value, diagnostics);
    for (const arm of expr.arms) validateTypeExprScalarDomains(arm.value, diagnostics);
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
    } else if (node.kind === "type_match") {
      visit(node.value);
      for (const arm of node.arms) visit(arm.value);
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
        checkTypeAnnotationCasing(param.type, typeNames, diagnostics, param.span);
      }
      if (decl.returnType) {
        checkTypeAnnotationCasing(decl.returnType, typeNames, diagnostics, decl.span);
      }
      checkBlockTypeAnnotationCasing(decl.body, typeNames, diagnostics);
    } else if (decl.kind === "let" || decl.kind === "const") {
      const explicit = explicitTypeAnnotation(decl.type);
      if (explicit) checkTypeAnnotationCasing(explicit, typeNames, diagnostics, decl.span);
    }
  }
}

function checkBlockTypeAnnotationCasing(
  block: Extract<Expr, { kind: "block" }>,
  typeNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  for (const stmt of block.statements) {
    const explicit = stmt.kind === "let" ? explicitTypeAnnotation(stmt.type) : undefined;
    if (stmt.kind === "let" && explicit) {
      checkTypeAnnotationCasing(explicit, typeNames, diagnostics, stmt.span);
    }
    if (stmt.kind === "let") {
      checkExprTypeAnnotationCasing(stmt.value, typeNames, diagnostics);
    }
  }
  if (block.expr) checkExprTypeAnnotationCasing(block.expr, typeNames, diagnostics);
}

function explicitTypeAnnotation(type: string | undefined): string | undefined {
  return type?.trim() === "_" ? undefined : type;
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
      } else if (stmt.kind === "proof_const") {
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
    } else if (decl.kind === "contract") {
      for (const param of decl.params) {
        diagnoseUnsupported(
          param.typeHoles,
          "type holes are only allowed in expression-backed type annotations and do-strategy type arguments",
        );
      }
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
    } else if (decl.kind === "contract") {
      const env = new Map(
        decl.params.filter((param) => !param.const).map((param) => [param.name, param.type]),
      );
      inferAndResolveBlockType(decl.body, env, context, resolveAnnotation);
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
  diagnostics: Diagnostic[],
) {
  if (expr.kind === "block") {
    checkBlockTypeAnnotationCasing(expr, typeNames, diagnostics);
  } else if (expr.kind === "match") {
    checkExprTypeAnnotationCasing(expr.value, typeNames, diagnostics);
    for (const arm of expr.arms) {
      checkExprTypeAnnotationCasing(arm.value, typeNames, diagnostics);
    }
  }
}

function checkTypeExprCasing(
  expr: TypeExpr | undefined,
  typeNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  if (!expr) return;
  if (expr.kind === "type_ref") {
    diagnoseTypeRefCasing(expr.name, false, typeNames, diagnostics, expr.span);
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
        diagnoseTypeRefCasing(expr.callee.name, true, typeNames, diagnostics, expr.callee.span);
      }
    } else {
      checkTypeExprCasing(expr.callee, typeNames, diagnostics);
    }
    for (const arg of expr.args) checkTypeExprCasing(arg, typeNames, diagnostics);
  } else if (expr.kind === "type_shape") {
    for (const slot of expr.shape.slots) {
      checkTypeExprCasing(slot.type, typeNames, diagnostics);
    }
  } else if (expr.kind === "type_match") {
    checkTypeExprCasing(expr.value, typeNames, diagnostics);
    for (const arm of expr.arms) {
      checkTypeExprCasing(arm.value, typeNames, diagnostics);
    }
  } else if (expr.kind === "type_binary") {
    checkTypeExprCasing(expr.left, typeNames, diagnostics);
    checkTypeExprCasing(expr.right, typeNames, diagnostics);
  }
}

function checkTypeAnnotationCasing(
  annotation: string,
  typeNames: Set<string>,
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
  checkTypeExprCasing(parsed, typeNames, diagnostics);
}

function diagnoseScalarDomainTypeExpr(
  expr: Extract<TypeExpr, { kind: "type_call" }>,
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
  if (expr.kind === "type_match") {
    inferKinds(expr.value, decl, kinds, locals, byName, diagnostics, "type");
    for (const arm of expr.arms) {
      inferKinds(arm.value, decl, kinds, locals, byName, diagnostics, expected);
    }
    return;
  }
  if (expr.kind === "type_operator") return;
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
  const match = kind.match(/^type\s+fn\s*\((.*)\)\s*->\s*(type|struct|union|operator)$/);
  if (!match) return undefined;
  const params = match[1].trim();
  return params ? params.split(",").length : 0;
}

function typeConstructorResultKind(kind: TypeParamKind): TypeResultKind | undefined {
  const match = kind.match(/^type\s+fn\s*\(.*\)\s*->\s*(type|struct|union|operator)$/);
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
  if (decl.resultKind === "struct" && normalized.kind === "product") return;
  if (decl.resultKind === "union" && normalized.kind === "sum") return;
  if (decl.resultKind === "operator" && normalized.kind === "operator") return;
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
  if (resolved.kind === "type_operator") {
    return { kind: "operator", descriptor: resolved.descriptor };
  }
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
    const target = byName.get(resolved.callee.name);
    const rendered = renderTypeExpr(resolved);
    if (!target && !/^(?:i32|i64|u32|u64|f32|f64)\s*\(/.test(rendered)) {
      diagnostics.push({
        code: "type.unknown_type",
        message: `unknown type function ${resolved.callee.name}`,
      });
    } else if (target) {
      evaluate(target);
    }
  }
  return { kind: "alias", type: renderTypeExpr(resolved) };
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
    case "type_match":
      return `match ${renderTypeExpr(expr.value)} { ${
        expr.arms.map((arm) => `${renderTypePattern(arm.pattern)} => ${renderTypeExpr(arm.value)}`)
          .join(", ")
      } }`;
    case "type_operator":
      return `operator(${expr.descriptor.fixity}, ${expr.descriptor.precedence}, "${expr.descriptor.symbol}", ${expr.descriptor.target})`;
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
  if (expr.literalKind === "string") return { kind: "string", value: expr.value.slice(1, -1) };
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
): boolean {
  if (!expected || !actual) return true;
  const refined = refinedI32Assignable(resolveAliasFree(expected), resolveAliasFree(actual));
  if (refined !== undefined) return refined;
  const expectedLiteral = canonicalLiteralType(expected);
  const actualLiteral = canonicalLiteralType(actual);
  if (expectedLiteral) return actualLiteral === expectedLiteral;
  if (actualLiteral && literalTypeCarrier(actualLiteral) === expected.trim()) return true;
  const expectedRuntime = scalarDomainRuntimeType(expected);
  const actualRuntime = scalarDomainRuntimeType(actual);
  if (expectedRuntime && actualRuntime && expectedRuntime === actualRuntime) return true;
  return true;
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
) {
  const byName = new Map(types.map((decl) => [decl.name, decl]));
  const byFn = new Map(functions.map((decl) => [decl.name, decl]));
  for (const decl of program.declarations) {
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
  }
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
  const lowerExpr = (expr: Expr): Expr => {
    switch (expr.kind) {
      case "do":
        return lowerDoExpression(expr, diagnostics, lowerExpr);
      case "const_fn":
        return { ...expr, span: expr.span, body: lowerExpr(expr.body) };
      case "profile":
        return {
          ...expr,
          args: expr.args.map(lowerExpr),
          body: lowerExpr(expr.body),
        };
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
      case "call":
        return {
          ...expr,
          callee: lowerExpr(expr.callee),
          args: expr.args.map(lowerExpr),
        };
      case "index":
        return {
          ...expr,
          target: lowerExpr(expr.target),
          index: lowerExpr(expr.index),
        };
      case "binary":
        return { ...expr, left: lowerExpr(expr.left), right: lowerExpr(expr.right) };
      case "pipe_bind":
        return { ...expr, value: lowerExpr(expr.value), body: lowerExpr(expr.body) };
      case "match":
        return {
          ...expr,
          value: lowerExpr(expr.value),
          arms: expr.arms.map((arm) => ({ ...arm, value: lowerExpr(arm.value) })),
        };
      case "shape":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value) })),
        };
      case "static_for_slots":
        return {
          ...expr,
          source: lowerStaticForSourceExpr(expr.source, lowerExpr),
          value: lowerExpr(expr.value),
        };
      case "range":
        return { ...expr, start: lowerExpr(expr.start), end: lowerExpr(expr.end) };
      case "static_for_slots":
        return { ...expr, value: lowerExpr(expr.value) };
      case "field":
        return { ...expr, value: lowerExpr(expr.value), key: lowerExpr(expr.key) };
      case "block":
        return {
          ...expr,
          statements: expr.statements.map((stmt) =>
            stmt.kind === "let" || stmt.kind === "destructure_let"
              ? { ...stmt, value: lowerExpr(stmt.value) }
              : stmt
          ),
          expr: expr.expr ? lowerExpr(expr.expr) : undefined,
        };
      case "literal":
      case "var":
      case "placeholder":
        return expr;
    }
  };
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
      case "type_fn":
        return { kind: "type", name: substituteTypeSource(expr.source, locals) };
      case "type_operator":
        return {
          kind: "type",
          name: renderTypeExpr(expr),
          normalized: {
            kind: "operator",
            descriptor: expr.descriptor,
          },
        };
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
        if (expr.op === "..") {
          return this.namedType(`${renderTypeEvalValue(left)}..${renderTypeEvalValue(right)}`);
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
    const evaluatedCallee =
      expr.callee.kind === "type_ref" || expr.callee.kind === "type_static_ref"
        ? undefined
        : this.eval(expr.callee, locals);
    const callee = expr.callee.kind === "type_ref"
      ? expr.callee.name
      : expr.callee.kind === "type_static_ref"
      ? `@${expr.callee.name}`
      : evaluatedCallee?.kind === "type"
      ? evaluatedCallee.name
      : undefined;
    if (!callee) {
      return this.unsupported("type.unsupported_expr", "type calls require a named callee");
    }
    if (callee === "@satisfies") {
      return this.evalSatisfiesRaw(expr, locals);
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
    const decl = this.typesByName.get(callee) ?? this.typesByName.get(terminalName(callee));
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
    return this.evalTypeFunction(callee, decl, args);
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
    const pluginValue = pluginBuiltin?.evaluateType?.(args, {
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
    const type = args[0]?.kind === "type" ? this.resolveTypeValue(args[0]) : undefined;
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
    if (name === "type_has_member") {
      return { kind: "bool", value: !!this.typeMember(type, args[1]) };
    }
    if (name === "type_member_type") {
      const member = this.typeMember(type, args[1]);
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
    if (name === "type_members") return this.typeMembers(type);
    if (name === "type_member_target") {
      const member = this.typeMember(type, args[1]);
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

  private evalSatisfiesRaw(
    expr: Extract<TypeExpr, { kind: "type_call" }>,
    locals: Map<string, TypeEvalValue>,
  ): TypeEvalValue | undefined {
    const [effectExpr, contractExpr] = expr.args;
    if (!effectExpr || !contractExpr) {
      return this.unsupported("type.satisfies", "@satisfies requires an effect and contract");
    }
    const contract = renderTypeExpr(contractExpr);
    const effect = renderTypeExpr(effectExpr);
    const contractName = terminalName(contract);
    const contractDecl = this.typesByName.get(contract) ?? this.typesByName.get(contractName) ??
      [...this.typesByName.values()].find((type) => terminalName(type.name) === contractName);
    if (contractDecl) {
      this.evalTypeFunction(
        contractDecl.name,
        contractDecl,
        [this.withSpan({ kind: "type", name: effect }, effectExpr.span)],
      );
    }
    return this.namedType(`${contractName}(${effect})`);
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
          return { kind: "string", value: expr.value.slice(1, -1) };
        }
        if (expr.literalKind === "multiline") return { kind: "string", value: expr.value };
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
    if (block.statements.some((stmt) => stmt.kind !== "let" && stmt.kind !== "proof_const")) {
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
    const decl = this.typesByName.get(typeNameOf(type.name));
    const bindings = decl ? genericBindings(type.name, decl) : new Map<string, string>();
    const explicit = members.map((member) => ({
      ...member,
      type: substituteTypeVars(member.type, bindings),
    }));
    const withDerivedEmpty = typeHasDerivedEmpty(type) &&
        !explicit.some((member) => member.name === "empty")
      ? [...explicit, {
        name: "empty",
        type: `fn() -> ${type.name}`,
        target: `${type.name}::empty`,
      }]
      : explicit;
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
    type = this.resolveTypeValue(type);
    if (type.normalized?.kind === "product" || type.normalized?.kind === "sum") {
      const member = type.normalized.members?.find((member) => member.name === memberName);
      if (member) {
        const decl = this.typesByName.get(typeNameOf(type.name));
        const bindings = decl ? genericBindings(type.name, decl) : new Map<string, string>();
        return { ...member, type: substituteTypeVars(member.type, bindings) };
      }
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
    return resolved.name;
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
      case "operator":
        return { kind: "operator", descriptor: body.descriptor };
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
    if (item.effects.length > 0) {
      diagnostics.push({
        code: "external.io_effects_removed",
        message:
          "external imports use the primitive io parameter instead of function effect syntax",
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
  if (context.functions.has(`${type}::empty`)) {
    return { kind: "call", callee: { kind: "var", name: `${type}::empty` }, args: [] };
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
  return "<never>";
}

function substituteTypeExpr(expr: TypeExpr, locals: Map<string, TypeEvalValue>): TypeExpr {
  if (expr.kind === "type_ref") {
    const local = locals.get(expr.name);
    if (local?.kind === "type") return parseAnnotationType(local.name) ?? expr;
    if (local?.kind === "literal") return { kind: "type_literal", value: local.value };
    if (local?.kind === "char") return { kind: "type_char", value: local.value };
    if (local?.kind === "string") return { kind: "type_string", value: local.value };
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
  if (expr.kind === "type_binary") {
    return {
      kind: "type_binary",
      op: expr.op,
      left: substituteTypeExpr(expr.left, locals),
      right: substituteTypeExpr(expr.right, locals),
    };
  }
  if (expr.kind === "type_operator") return expr;
  return expr;
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
    case "operator":
      return body;
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
  const parser = new AnnotationTypeParser(source);
  return parser.parse();
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
    let expr = this.parseRange();
    if (!expr) return undefined;
    while (this.peek("|")) {
      this.index++;
      const right = this.parseRange();
      if (!right) return undefined;
      expr = { kind: "type_binary", op: "|", left: expr, right };
    }
    return expr;
  }

  private parseRange(): TypeExpr | undefined {
    let expr = this.parsePrimaryType();
    if (!expr) return undefined;
    if (this.peek("..")) {
      this.index += 2;
      const right = this.parsePrimaryType();
      if (!right) return undefined;
      expr = { kind: "type_binary", op: "..", left: expr, right };
    }
    return expr;
  }

  private parsePrimaryType(): TypeExpr | undefined {
    this.skip();
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
    const number = this.source.slice(this.index).match(/^[0-9]+/);
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
  if (exprContainsStaticExpansion(fn.body) || isInlineArrayExprBuiltinWrapper(fn)) return;
  const env = new Map<string, OwnershipBinding>();
  const runtimeOptions = {
    ...options,
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
      new Map(functions.map((item) => [item.name, item])),
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
    case "placeholder":
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
  if (stmt.kind === "proof_const") return;
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
  const decl = types.find((item) => item.name === typeNameOf(type));
  if (decl?.normalized?.kind !== "product") return [type];
  const slots = decl.normalized.shape.slots.flatMap((slot) =>
    Array.from({ length: slot.repeat ? Number.parseInt(slot.repeat, 10) : 1 }, () => slot.type)
  );
  return slots.length > 1 ? slots : [type];
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
    ctx.types.some((item) => item.name === base || terminalName(item.name) === terminalName(base));
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
  const decl = types.find((item) =>
    item.name === base || terminalName(item.name) === terminalName(base)
  );
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
      } else if (stmt.kind === "proof_const") {
        validateSatisfiesProofConst(stmt.value, ctx);
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
          if (stmt.kind !== "proof_const" && "value" in stmt) visitExpr(stmt.value, proofs);
        }
        visitExpr(expr.expr, proofs);
        return;
      case "literal":
      case "placeholder":
        return;
    }
  };
  visitBlock(block, initialProofs);
}

function validateSatisfiesProofConst(expr: TypeExpr, ctx: CheckContext) {
  if (
    expr.kind !== "type_call" ||
    expr.callee.kind !== "type_static_ref" ||
    expr.callee.name !== "satisfies"
  ) return;
  const effect = expr.args[0];
  if (!effect || !typeExprIsConcreteProofTarget(effect)) return;
  const typeEvaluator = new TypeEvaluator(
    new Map(ctx.types.map((decl) => [decl.name, decl])),
    new Map(ctx.functions.map((fn) => [fn.name, fn])),
    new Map(),
    new Map(),
    ctx.diagnostics,
    shaderManifestEntry,
    defaultCompilerPluginRegistry,
  );
  typeEvaluator.eval(expr, new Map(), expr.span);
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
    case "type_static_ref":
      return false;
    case "type_fn":
    case "type_shape":
    case "type_match":
    case "type_operator":
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
      case "type_operator":
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
      checkProjection(expr.name, env, types, diagnostics);
      if (expr.name === "io" && !env.has("io")) {
        diagnostics.push(diagnosticAt(
          "const.unknown_name",
          "unknown IO executor io; pass an explicit io parameter",
          expr,
        ));
      }
      const binding = env.get(expr.name);
      if (
        expectedType && binding?.type &&
        !runtimeValueTypeAssignable(expectedType, binding.type)
      ) {
        diagnostics.push(diagnosticAt(
          "type.literal_mismatch",
          `expected ${expectedType} but got ${binding.type}`,
          expr,
        ));
      }
      return;
    }
    case "placeholder":
      diagnostics.push({
        code: "const.placeholder_context",
        message: "$ is only valid in a pipeline stage or expected unary const fn argument",
      });
      return;
    case "call": {
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
      if (calleeName !== undefined) {
        if (calleeName === "fork") {
          diagnostics.push(diagnosticAt(
            "function.unknown",
            "unknown function fork",
            expr.callee,
          ));
        }
        if (
          (calleeName.startsWith("RangeIter.") || calleeName.startsWith("RangeIter::")) &&
          !functions.some((fn) =>
            fn.name === calleeName || fn.name.endsWith(`.${calleeName}`) ||
            fn.name.endsWith(`::${calleeName}`)
          ) &&
          !hostIoImports.has(calleeName)
        ) {
          diagnostics.push(diagnosticAt(
            "function.unknown",
            `unknown function ${calleeName}`,
            expr.callee,
          ));
        }
      }
      const fn = calleeName ? functions.find((fn) => fn.name === calleeName) : undefined;
      const calleeSignature = !fn && calleeName
        ? parseFnSignature(projectedBindingType(calleeName, env, types) ?? "")
        : undefined;
      for (let index = 0; index < expr.args.length; index++) {
        const arg = expr.args[index];
        const rawExpected = fn?.params[index]?.type ?? calleeSignature?.params[index];
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
          !runtimeValueTypeAssignable(expected, actual)
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
        if (actual && !runtimeValueTypeAssignable(expectedType, actual)) {
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
      checkRuntimeMatchCoverage(expr, matchValueType, diagnostics, types);
      for (const arm of expr.arms) {
        const armEnv = narrowedEnvForMatchPattern(expr.value, arm.pattern, env, types);
        bindMatchPatternLocals(arm.pattern, matchValueType, armEnv, diagnostics, types);
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
      if (expectedType && literalTypeMembers(expectedType)) {
        if (literalExprFitsType(expr, expectedType)) {
          expr.inferredType = canonicalLiteralType(expectedType);
        } else {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `literal ${expr.value} is not assignable to ${expectedType}`,
            expr,
          ));
        }
      }
      if (
        expr.literalKind === "number" && expectedType === "i32" && isUnsuffixedInteger(expr.value)
      ) {
        expr.inferredType = "i32";
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
    return finish(projectedBindingType(expr.name, env, types));
  }
  if (expr.kind === "call" && isIoReturnCall(expr)) {
    return finish(
      expr.args.length === 1
        ? `io(${exprBindingType(expr.args[0]!, env, types, functions, options) ?? "i32"})`
        : "io(i32)",
    );
  }
  if (expr.kind === "binary") {
    if (["==", "!=", "<", "<=", ">", ">="].includes(expr.op)) return finish("bool");
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
  if (expr.kind === "call") {
    const callee = expr.callee;
    if (callee.kind === "var") {
      const callKey = memo ? callCheckMemoKey(expr, env) : undefined;
      const cachedCall = callKey ? memo!.callCheck.get(callKey) : undefined;
      if (cachedCall) return finish(cachedCall.returnType);
      const returnType = functions.find((fn) => fn.name === callee.name)?.returnType;
      if (callKey) memo!.callCheck.set(callKey, { returnType });
      return finish(returnType);
    }
  }
  if (expr.kind === "product_constructor") {
    const type = types.find((item) =>
      item.normalized?.kind === "product" && item.normalized.constructor === expr.constructor
    );
    return finish(type?.name);
  }
  if (expr.kind === "shape") {
    return finish(inferExprType(
      expr,
      {
        functions: new Map(functions.map((fn) => [fn.name, fn])),
        typeConstructors: new Map(
          types.flatMap((decl): [string, TypeDecl][] =>
            decl.normalized?.kind === "product" ? [[decl.normalized.constructor, decl]] : []
          ),
        ),
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
  if (expr.kind !== "binary") return finish(undefined);
  const left = exprI32Range(expr.left, env, types, functions, options);
  const right = exprI32Range(expr.right, env, types, functions, options);
  if (!left || !right) return finish(undefined);
  if (expr.op === "+") {
    return finish(i32FactsFromRangeBounds(left.min + right.min, left.max + right.max));
  }
  if (expr.op === "-") {
    return finish(i32FactsFromRangeBounds(left.min - right.max, left.max - right.min));
  }
  if (expr.op === "*") {
    const products = [
      left.min * right.min,
      left.min * right.max,
      left.max * right.min,
      left.max * right.max,
    ];
    return finish(i32FactsFromRangeBounds(Math.min(...products), Math.max(...products)));
  }
  const divisor = staticIntegerLiteral(expr.right);
  if (divisor === undefined || divisor <= 0 || left.min < 0) return finish(undefined);
  if (expr.op === "/") {
    return finish(scalarFactsFromI32Range({ min: 0, max: Math.floor(left.max / divisor) }));
  }
  if (expr.op === "%") {
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
  if (!/^-?[0-9]+$/.test(expr.value)) return undefined;
  return Number.parseInt(expr.value, 10);
}

function literalRuntimeType(expr: Expr): string | undefined {
  if (expr.kind !== "literal") return undefined;
  if (expr.literalKind === "number") return "i32";
  if (expr.literalKind === "bool") return "bool";
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
  const [base, ...fields] = name.split(".");
  let current = env.get(base)?.type;
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
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  const match = name.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[[0-9]+\])+$/);
  if (!match) return;
  const baseType = env.get(match[1])?.type;
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
  const resolvedType = resolveAliasType(matchValueType, types) ?? matchValueType;
  const domain = resolvedType === "bool"
    ? ["false", "true"]
    : finiteI32DomainValues(parseRefinedI32Type(resolvedType));
  if (!domain) return;

  const required = new Set(domain);
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
    if (isCatchAllPattern(arm.pattern)) {
      for (const value of required) covered.add(value);
      exhaustiveAt = index;
      continue;
    }
    const literal = finitePatternValue(arm.pattern, resolvedType);
    if (literal === undefined) continue;
    if (!required.has(literal)) {
      diagnostics.push(diagnosticAt(
        "match.unreachable_arm",
        `match arm ${renderParamPattern(arm.pattern)} is unreachable for ${resolvedType}`,
        arm,
      ));
      continue;
    }
    if (covered.has(literal)) {
      diagnostics.push(diagnosticAt(
        "match.unreachable_arm",
        `match arm ${renderParamPattern(arm.pattern)} is shadowed by an earlier arm`,
        arm,
      ));
      continue;
    }
    covered.add(literal);
    if (covered.size === required.size) exhaustiveAt = index;
  }

  if (covered.size < required.size) {
    const missing = [...required].filter((value) => !covered.has(value));
    diagnostics.push(diagnosticAt(
      "type.non_exhaustive_match",
      `match is missing ${missing.slice(0, 4).join(", ")}${
        missing.length > 4 ? ", ..." : ""
      } for ${resolvedType}`,
      expr,
    ));
  }
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

function finitePatternValue(
  pattern: ParamPattern,
  matchValueType: string | undefined,
): string | undefined {
  if (matchValueType === "bool") return boolPatternValue(pattern)?.toString();
  if (pattern.kind !== "literal" || pattern.literalKind !== "number") return undefined;
  if (!/^-?[0-9]+$/.test(pattern.value)) return undefined;
  const value = Number.parseInt(pattern.value, 10);
  return Number.isSafeInteger(value) ? String(value) : undefined;
}

function narrowedEnvForMatchPattern(
  value: Expr,
  pattern: ParamPattern,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
): Map<string, OwnershipBinding> {
  const scoped = new Map(env);
  const truth = boolPatternValue(pattern);
  if (truth === undefined) return scoped;
  const narrowed = conditionI32Narrowing(value, truth);
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
): { name: string; domain: RefinedI32Domain } | undefined {
  if (expr.kind !== "binary") return undefined;
  if (expr.op === "==" && expr.left.kind === "var") {
    const right = endpointForI32Condition(expr.right);
    if (right?.kind === "literal") {
      return {
        name: expr.left.name,
        domain: equalityNarrowingDomain(right, truth),
      };
    }
  }
  if (expr.op === "==" && expr.right.kind === "var") {
    const left = endpointForI32Condition(expr.left);
    if (left?.kind === "literal") {
      return {
        name: expr.right.name,
        domain: equalityNarrowingDomain(left, truth),
      };
    }
  }
  if (expr.left.kind === "var") {
    const right = endpointForI32Condition(expr.right);
    const domain = right ? leftVarComparisonDomain(expr.op, right, truth) : undefined;
    if (domain) return { name: expr.left.name, domain };
  }
  if (expr.right.kind === "var") {
    const left = endpointForI32Condition(expr.left);
    const domain = left ? rightVarComparisonDomain(expr.op, left, truth) : undefined;
    if (domain) return { name: expr.right.name, domain };
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

function sumVariantSlotTypes(
  valueType: string | undefined,
  variantName: string,
  types: TypeDecl[],
): string[] | undefined {
  const resolved = resolveAliasType(valueType, types) ?? valueType?.trim();
  if (!resolved) return undefined;
  const decl = findTypeDecl(types, typeNameOf(resolved));
  if (decl?.normalized?.kind !== "sum") return undefined;
  const variant = decl.normalized.variants.find((item) => item.name === variantName);
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
  } else if (pattern.kind === "tuple" && type) {
    const slots = runtimeSlotTypes(type, types);
    for (let index = 0; index < pattern.items.length; index++) {
      bindPatternName(pattern.items[index], slots[index] ?? undefined, env, types);
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
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const decl = byName.get(current) ?? byTerminal.get(terminalName(current));
    if (decl) {
      if (decl.normalized?.kind !== "alias") return current;
      current = decl.normalized.type;
      continue;
    }
    const callName = typeNameOf(current);
    const callDecl = byName.get(callName) ?? byTerminal.get(terminalName(callName));
    const callArgs = typeCallArgsForBase(current, callName);
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

function typeCallArgsForBase(type: string, baseName: string): string | undefined {
  const prefix = `${baseName}(`;
  if (!type.startsWith(prefix) || !type.endsWith(")")) return undefined;
  return type.slice(prefix.length, -1);
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
  } else if (stmt.kind === "proof_const") {
    collectTypeExprRefs(stmt.value, refs);
  } else if (stmt.kind === "debug_trace") {
    for (const arg of stmt.args) collectExprRefs(arg, refs, new Set());
  }
}

function boundNames(stmt: Statement): string[] {
  if (stmt.kind === "let") return [stmt.name];
  if (stmt.kind === "proof_const") return [stmt.name];
  if (stmt.kind === "debug_trace") return [];
  return stmt.names;
}

function doBoundNames(stmt: DoStatement): string[] {
  if (stmt.kind === "do_bind") return [stmt.name];
  if (stmt.kind === "do_expr") return [];
  return boundNames(stmt);
}

function spanForBoundName(stmt: Statement, name: string): { span?: Span; nameSpan?: Span } {
  if (stmt.kind === "let" || stmt.kind === "proof_const") return stmt;
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
  else if (stmt.kind === "proof_const") collectTypeExprRefs(stmt.value, refs);
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
    case "type_binary":
      collectTypeExprRefs(expr.left, refs);
      collectTypeExprRefs(expr.right, refs);
      return;
    case "type_hole":
    case "type_static_ref":
    case "type_fn":
    case "type_operator":
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
    case "placeholder":
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

function isUnsuffixedInteger(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function isUnsignedIntegerType(type: string): boolean {
  const match = type.match(/^u([1-9][0-9]*)$/);
  if (!match) return false;
  const width = Number.parseInt(match[1], 10);
  return width >= 1 && width <= 64;
}
