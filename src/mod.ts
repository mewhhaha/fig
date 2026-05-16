import { parse } from "./parser.ts";
import { checkProgram, checkProgramForAnalysis, type CheckTrace } from "./check.ts";
import {
  type BackendOptions,
  emitWasm,
  emitWat,
  lowerProgramToBackendArtifact,
  lowerProgramToBackendModule,
  summarizeBackendLayoutDecisions,
  wasmFromBackendModule,
  watFromBackendModule,
} from "./backend.ts";
import {
  type OptimizationPlan,
  type OptimizeOptions,
  summarizeOptimizationPlan,
} from "./optimize.ts";
import type {
  ConstDecl,
  Declaration,
  Expr,
  FnDecl,
  LetDecl,
  ParamPattern,
  Program,
  ShapeType,
  SourceImport,
  StaticForSource,
  TypeBlock,
  TypeCountExpr,
  TypeDecl,
  TypeExpr,
  TypeMemberExpr,
  TypePattern,
  TypeShape,
} from "./core_ast.ts";
import { CompileError, type Diagnostic } from "./diagnostics.ts";
import { copyAstMetadata, hideAstMetadata } from "./ast_meta.ts";
import type { CompilerPluginOptions } from "./plugins.ts";
import type { CompileTraceSink } from "./trace.ts";

export interface ModuleSource {
  text: string;
  sourceId?: string;
}

export interface CheckSourceOptions extends CompilerPluginOptions {
  sourceId?: string;
  pruneImports?: boolean;
  trace?: boolean | CompileTraceSink;
  compileTrace?: CompileTraceSink;
  cache?: CompileCache;
  resolveModule?: (
    moduleName: string,
  ) => string | ModuleSource | undefined | Promise<string | ModuleSource | undefined>;
}

export interface CompileSourceOptions extends CheckSourceOptions, BackendOptions {}

export interface CompileArtifactsOptions extends CompileSourceOptions {
  includeWat?: boolean;
}

export interface CompileCache {
  parsedModules: Map<string, Program>;
  resolvedModules: Map<string, Program>;
  prunedImports: Map<string, Program>;
}

export function createCompileCache(): CompileCache {
  return {
    parsedModules: new Map(),
    resolvedModules: new Map(),
    prunedImports: new Map(),
  };
}

export interface CompileArtifactTimings {
  parseMs: number;
  importMs: number;
  checkMs: number;
  backendMs: number;
  optimizeMs: number;
  backendLayoutMs: number;
  backendLowerMs: number;
  backendCleanupMs: number;
  watRenderMs: number;
  wasmEncodeMs: number;
  watMs: number;
  wasmMs: number;
}

export interface CompileArtifactsResult {
  wat?: string;
  wasm: Uint8Array<ArrayBuffer>;
  checked: ReturnType<typeof checkProgram>;
  timings: CompileArtifactTimings;
  trace?: CheckTrace;
  importTrace?: ImportTrace;
}

export interface CompileArtifactsWithWatResult extends CompileArtifactsResult {
  wat: string;
}

export interface ImportTrace {
  phases: ImportPhaseTrace[];
}

interface ImportTraceState extends ImportTrace {
  compileTrace?: CompileTraceSink;
}

export interface ImportPhaseTrace {
  name: string;
  ms: number;
  moduleName?: string;
  cacheHit?: boolean;
  declarationCount?: number;
  keptDeclarationCount?: number;
  typeCount?: number;
  fnCount?: number;
  contractCount?: number;
  sourceImportCount?: number;
  referenceCount?: number;
}

export async function checkSource(source: string, options: CheckSourceOptions = {}) {
  const trace = compileTraceSink(options);
  const program = await parse(source, {
    sourceId: options.sourceId,
    trace,
  });
  if (!options.resolveModule) return checkProgram(program, checkOptions(options));
  return checkProgram(
    await resolveSourceImports(program, {
      resolveModule: options.resolveModule,
      pruneImports: options.pruneImports,
      cache: options.cache,
      importTrace: trace ? { phases: [], compileTrace: trace } : undefined,
    }),
    checkOptions(options),
  );
}

export async function checkSourceForAnalysis(source: string, options: CheckSourceOptions = {}) {
  const trace = compileTraceSink(options);
  const program = await parse(source, {
    sourceId: options.sourceId,
    trace,
  });
  return await checkParsedSourceForAnalysis(program, options);
}

export async function checkParsedSourceForAnalysis(
  program: Program,
  options: CheckSourceOptions = {},
) {
  if (!options.resolveModule) return checkProgramForAnalysis(program, checkOptions(options));
  const trace = compileTraceSink(options);
  return checkProgramForAnalysis(
    await resolveSourceImports(program, {
      resolveModule: options.resolveModule,
      pruneImports: options.pruneImports,
      cache: options.cache,
      importTrace: trace ? { phases: [], compileTrace: trace } : undefined,
    }),
    checkOptions(options),
  );
}

export async function watFromSource(
  source: string,
  options: CompileSourceOptions = {},
): Promise<string> {
  return emitWat((await checkSource(source, options)).program, options);
}

export async function wasmFromSource(
  source: string,
  options: CompileSourceOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  return emitWasm((await checkSource(source, options)).program, options);
}

export async function compileWasmFromSource(
  source: string,
  options: CompileSourceOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  return (await compileArtifactsFromSource(source, { ...options, includeWat: false })).wasm;
}

export function compileArtifactsFromSource(
  source: string,
  options?: CompileArtifactsOptions & { includeWat?: true },
): Promise<CompileArtifactsWithWatResult>;
export function compileArtifactsFromSource(
  source: string,
  options: CompileArtifactsOptions & { includeWat: false },
): Promise<CompileArtifactsResult>;
export function compileArtifactsFromSource(
  source: string,
  options: CompileArtifactsOptions = {},
): Promise<CompileArtifactsResult> {
  return compileArtifactsFromSourceImpl(source, options);
}

async function compileArtifactsFromSourceImpl(
  source: string,
  options: CompileArtifactsOptions = {},
): Promise<CompileArtifactsResult> {
  const trace = compileTraceSink(options);
  const parseStart = performance.now();
  const parsed = await parse(source, {
    sourceId: options.sourceId,
    trace,
  });
  const parseMs = performance.now() - parseStart;

  let program = parsed;
  let importMs = 0;
  const importTrace: ImportTraceState | undefined = options.trace || trace
    ? { phases: [], compileTrace: trace }
    : undefined;
  if (options.resolveModule) {
    const importStart = performance.now();
    program = await resolveSourceImports(parsed, {
      resolveModule: options.resolveModule,
      pruneImports: options.pruneImports,
      cache: options.cache,
      importTrace,
    });
    importMs = performance.now() - importStart;
  }

  const checkStart = performance.now();
  const checked = checkProgram(program, checkOptions(options));
  const checkMs = performance.now() - checkStart;

  const backendStart = performance.now();
  const loweredBackend = lowerProgramToBackendArtifact(checked.program, {
    ...options,
    compileTrace: trace,
  });
  const backendMs = performance.now() - backendStart;
  const backend = loweredBackend.module;

  let wat: string | undefined;
  let watRenderMs = 0;
  if (options.includeWat !== false) {
    const watStart = performance.now();
    wat = watFromBackendModule(backend);
    watRenderMs = performance.now() - watStart;
  }

  const wasmStart = performance.now();
  const wasm = wasmFromBackendModule(backend, {
    debugNames: (options.optMode ?? "debug") === "debug",
  });
  const wasmEncodeMs = performance.now() - wasmStart;

  return {
    ...(wat !== undefined ? { wat } : {}),
    wasm,
    checked,
    timings: {
      parseMs,
      importMs,
      checkMs,
      backendMs,
      optimizeMs: loweredBackend.timings.optimizeMs,
      backendLayoutMs: loweredBackend.timings.layoutMs,
      backendLowerMs: loweredBackend.timings.lowerMs,
      backendCleanupMs: loweredBackend.timings.cleanupMs,
      watRenderMs,
      wasmEncodeMs,
      watMs: watRenderMs,
      wasmMs: wasmEncodeMs,
    },
    trace: checked.trace,
    importTrace,
  };
}

function compileTraceSink(options: CheckSourceOptions): CompileTraceSink | undefined {
  if (options.compileTrace) return options.compileTrace;
  return typeof options.trace === "boolean" ? undefined : options.trace;
}

function checkOptions(options: CheckSourceOptions): CheckSourceOptions & { trace?: boolean } {
  return { ...options, trace: options.trace === true };
}

export async function explainOptimization(
  source: string,
  options: CompileSourceOptions & OptimizeOptions = {},
): Promise<OptimizationPlan> {
  const checked = await checkSource(source, options);
  const plan = summarizeOptimizationPlan(checked.program, options);
  for (const decision of summarizeBackendLayoutDecisions(checked.program, options)) {
    plan.decisions.push(decision);
    const fnName = typeof decision.evidence?.function === "string"
      ? decision.evidence.function
      : undefined;
    const target = typeof decision.evidence?.target === "string"
      ? decision.evidence.target
      : decision.target;
    const layout = decision.evidence?.layout;
    if (
      fnName &&
      (layout === "packed" || layout === "scratch" || layout === "local_slots")
    ) {
      plan.functions.get(fnName)?.actions.push({
        kind: "choose_layout",
        target,
        layout,
        reason: decision.reason,
      });
    }
  }
  return plan;
}

export { parse } from "./parser.ts";
export { formatSource, isFormatted } from "./format.ts";
export { tokenize } from "./tokenize.ts";
export {
  type BackendModule,
  backendModuleToWasm,
  backendModuleToWat,
  type BackendOptions,
  type BackendPhaseTimings,
  compileBackendModule,
  type LoweredBackendArtifact,
  lowerProgramToBackendArtifact,
  lowerProgramToBackendModule,
  wasmFromBackendModule,
  watFromBackendModule,
} from "./backend.ts";
export {
  type AbstractFunctionFacts,
  type AbstractValue,
  type FunctionFacts,
  type FunctionPlan,
  type LayoutCandidate,
  OPTIMIZATION_RULES,
  type OptimizationDecision,
  type OptimizationPlan,
  type OptimizationRule,
  type OptimizationRuleId,
  OPTIMIZE_PROFILES,
  type OptimizeProfile,
  type OptimizeProfileName,
  optimizeProgram,
  type OptMode,
  type PlannedAction,
  type Recurrence,
  type RewriteRule,
  type RewriteRuleId,
  summarizeAbstractValues,
  summarizeOptimizationPlan,
  summarizeProgram,
  summarizeRecurrences,
} from "./optimize.ts";
export { CompileError, formatDiagnostic } from "./diagnostics.ts";
export { type CheckPhaseTrace, type CheckProgramOptions, type CheckTrace } from "./check.ts";
export { type CompileTraceEvent, type CompileTraceSink, formatCompileTraceEvent } from "./trace.ts";
export {
  COMPILER_PLUGIN_API_VERSION,
  type CompilerAnnotationBuiltin,
  type CompilerDeclarationBuiltin,
  type CompilerDoStrategyBuiltin,
  type CompilerIntrinsicBuiltin,
  type CompilerPlugin,
  type CompilerPluginRegistry,
  type CompilerStaticBuiltin,
  type ConstBuiltinContext,
  type ConstPluginValue,
  createCompilerPluginRegistry,
  type TypeBuiltinContext,
  type TypePluginValue,
} from "./plugins.ts";

async function resolveSourceImports(
  root: Program,
  options:
    & Required<Pick<CheckSourceOptions, "resolveModule">>
    & Pick<
      CheckSourceOptions,
      "cache" | "pruneImports"
    >
    & { importTrace?: ImportTraceState },
): Promise<Program> {
  const diagnostics: Diagnostic[] = [];
  const visiting: string[] = [];
  const resolved = new Map<string, Program>();
  const sharedCache = options.cache;
  const pruneSourceKeys = new WeakMap<Program, string>();

  async function load(
    moduleName: string,
    requestedAt?: SourceImport,
  ): Promise<Program | undefined> {
    if (resolved.has(moduleName)) return resolved.get(moduleName);
    const cycleStart = visiting.indexOf(moduleName);
    if (cycleStart >= 0) {
      diagnostics.push({
        code: "module.cycle",
        message: `source import cycle: ${[...visiting.slice(cycleStart), moduleName].join(" -> ")}`,
      });
      return undefined;
    }
    visiting.push(moduleName);
    const source = await traceImportPhase(
      options.importTrace,
      "import.resolve.root",
      { moduleName },
      () => options.resolveModule(moduleName),
    );
    if (source === undefined) {
      diagnostics.push({
        code: "module.not_found",
        message: `cannot resolve module ${moduleName}`,
        span: requestedAt?.span,
      });
      visiting.pop();
      return undefined;
    }
    const sourceKey = moduleSourceCacheKey(moduleName, source);
    const parsedCacheKey = `parsed\0${sourceKey}`;
    const cachedParsed = sharedCache?.parsedModules.get(parsedCacheKey);
    const parsed = cachedParsed ? cloneProgram(cachedParsed) : await traceImportPhase(
      options.importTrace,
      "import.parse.module",
      { moduleName },
      () => parseModuleSource(source, moduleName),
      importProgramCounters,
    );
    if (cachedParsed) {
      recordImportCacheHit(options.importTrace, "import.parse.module", moduleName, parsed);
    }
    if (!cachedParsed) sharedCache?.parsedModules.set(parsedCacheKey, cloneProgram(parsed));
    const resolvedCacheKey = resolvedModuleCacheKey(sourceKey, options.pruneImports === true);
    const cachedResolved = parsed.sourceImports?.length
      ? undefined
      : sharedCache?.resolvedModules.get(resolvedCacheKey);
    if (cachedResolved) {
      const cloned = cloneProgram(cachedResolved);
      resolved.set(moduleName, cloned);
      pruneSourceKeys.set(cloned, resolvedCacheKey);
      visiting.pop();
      recordImportCacheHit(options.importTrace, "import.merge.module", moduleName, cloned);
      return cloned;
    }
    const merged = await traceImportPhase(
      options.importTrace,
      "import.merge.module",
      { moduleName, ...importProgramCounters(parsed) },
      () => mergeImports(parsed),
    );
    if (!parsed.sourceImports?.length) {
      sharedCache?.resolvedModules.set(resolvedCacheKey, cloneProgram(merged));
      pruneSourceKeys.set(merged, resolvedCacheKey);
    }
    resolved.set(moduleName, merged);
    visiting.pop();
    return merged;
  }

  async function mergeImports(program: Program): Promise<Program> {
    const importedPrograms: Program[] = [];
    const aliasedImports: { alias: string; program: Program }[] = [];
    const destructuredImports: { alias: string; sourceImport: SourceImport; program: Program }[] =
      [];
    const aliases = new Set<string>();
    const reservedNames = new Set(program.declarations.map(declarationName));
    let hiddenImportIndex = 0;
    for (const item of program.sourceImports ?? []) {
      if (item.alias) {
        if (
          aliases.has(item.alias) || program.declarations.some((decl) => decl.name === item.alias)
        ) {
          diagnostics.push({
            code: "module.duplicate_alias",
            message: `source import alias ${item.alias} conflicts with another declaration`,
            span: item.nameSpan ?? item.span,
          });
          continue;
        }
        aliases.add(item.alias);
        reservedNames.add(item.alias);
      }
      if (item.bindings) {
        const seenBindings = new Set<string>();
        for (const binding of item.bindings) {
          if (seenBindings.has(binding.name)) {
            diagnostics.push({
              code: "module.duplicate_binding",
              message: `source import binding ${binding.name} is listed more than once`,
              span: binding.nameSpan ?? binding.span,
            });
          }
          seenBindings.add(binding.name);
        }
      }
      const imported = await load(item.module, item);
      if (!imported) continue;
      if (item.alias) aliasedImports.push({ alias: item.alias, program: imported });
      else if (item.bindings) {
        const alias = nextHiddenImportAlias(reservedNames, hiddenImportIndex++);
        reservedNames.add(alias);
        for (const decl of imported.declarations) {
          reservedNames.add(qualifyName(declarationName(decl), alias));
        }
        destructuredImports.push({
          alias,
          sourceImport: item,
          program: imported,
        });
      } else importedPrograms.push(imported);
    }
    return mergePrograms(
      importedPrograms,
      aliasedImports,
      destructuredImports,
      program,
      diagnostics,
      { pruneImports: options.pruneImports === true, importTrace: options.importTrace },
      {
        prunedImports: sharedCache?.prunedImports,
        sourceKey: (program) => pruneSourceKeys.get(program),
      },
    );
  }

  const merged = await mergeImports(root);
  if (diagnostics.length) throw new CompileError(diagnostics);
  return merged;
}

function mergePrograms(
  imports: Program[],
  aliasedImports: { alias: string; program: Program }[],
  destructuredImports: { alias: string; sourceImport: SourceImport; program: Program }[],
  program: Program,
  diagnostics: Diagnostic[],
  options: { pruneImports: boolean; importTrace?: ImportTraceState },
  cache?: {
    prunedImports?: Map<string, Program>;
    sourceKey(program: Program): string | undefined;
  },
): Program {
  const importedDecls = imports.flatMap((item) => item.declarations).map(markImportedDeclaration);
  const aliasedDecls = traceImportPhaseSync(
    options.importTrace,
    "import.qualify.imports",
    {
      declarationCount: aliasedImports.reduce(
        (sum, item) => sum + item.program.declarations.length,
        0,
      ),
    },
    () =>
      aliasedImports.flatMap(({ alias, program: importedProgram }) => {
        const prunedProgram = options.pruneImports
          ? pruneAliasedImportedProgram(
            importedProgram,
            program.declarations,
            alias,
            options.importTrace,
            cache,
          )
          : importedProgram;
        return qualifyImportedDeclarations(prunedProgram.declarations, alias);
      }),
    (decls) => ({ keptDeclarationCount: decls.length }),
  );
  const destructuredDecls = traceImportPhaseSync(
    options.importTrace,
    "import.destructure.imports",
    {
      declarationCount: destructuredImports.reduce(
        (sum, item) => sum + item.program.declarations.length,
        0,
      ),
    },
    () =>
      destructuredImports.flatMap((item) =>
        destructureImportedDeclarations(
          item.sourceImport,
          item.program,
          item.alias,
          diagnostics,
          options.pruneImports,
          options.importTrace,
          cache,
        )
      ),
  );
  const localNames = new Set(program.declarations.map(declarationName));
  const seenImported = new Map<string, Declaration>();
  const declarations: Declaration[] = [];
  for (const decl of [...importedDecls, ...aliasedDecls, ...destructuredDecls]) {
    const name = declarationName(decl);
    if (localNames.has(name)) {
      diagnostics.push({
        code: "module.duplicate_import",
        message: `imported declaration ${name} conflicts with another declaration`,
        span: decl.nameSpan ?? decl.span,
      });
      continue;
    }
    const previous = seenImported.get(name);
    if (previous && !importedDeclarationsCanShareName(previous, decl)) {
      diagnostics.push({
        code: "module.duplicate_import",
        message: `imported declaration ${name} conflicts with another declaration`,
        span: decl.nameSpan ?? decl.span,
      });
      continue;
    }
    if (!previous) seenImported.set(name, decl);
    declarations.push(decl);
  }
  declarations.push(...program.declarations.map(markRootDeclaration));
  const slicedDeclarations = options.pruneImports
    ? pruneUnusedImportedDeclarations(
      declarations,
      new Set(program.declarations.map(declarationName)),
      options.importTrace,
    )
    : declarations;
  return hideAstMetadata({
    moduleName: program.moduleName,
    imports: [
      ...imports.flatMap((item) => item.imports),
      ...aliasedImports.flatMap((item) => item.program.imports),
      ...destructuredImports.flatMap((item) => item.program.imports),
      ...program.imports,
    ],
    sourceImports: [],
    declarations: slicedDeclarations,
  });
}

function pruneAliasedImportedProgram(
  importedProgram: Program,
  localDeclarations: Declaration[],
  alias: string,
  importTrace?: ImportTraceState,
  cache?: {
    prunedImports?: Map<string, Program>;
    sourceKey(program: Program): string | undefined;
  },
): Program {
  const roots = traceImportPhaseSync(
    importTrace,
    "import.prune.alias_roots",
    {
      moduleName: importedProgram.moduleName,
      declarationCount: importedProgram.declarations.length,
    },
    () => aliasReferenceRoots(importedProgram.declarations, localDeclarations, alias),
    (result) => ({ referenceCount: result.size }),
  );
  return pruneImportedProgram(importedProgram, roots, importTrace, cache);
}

function pruneImportedProgram(
  importedProgram: Program,
  roots: Set<string>,
  importTrace?: ImportTraceState,
  cache?: {
    prunedImports?: Map<string, Program>;
    sourceKey(program: Program): string | undefined;
  },
): Program {
  if (!roots.size) return { ...importedProgram, declarations: [] };
  const sourceKey = cache?.sourceKey(importedProgram);
  const cacheKey = sourceKey ? prunedImportCacheKey(sourceKey, roots) : undefined;
  const cached = cacheKey ? cache?.prunedImports?.get(cacheKey) : undefined;
  if (cached) {
    const cloned = cloneProgram(cached);
    recordImportCacheHit(
      importTrace,
      "import.prune.finish",
      importedProgram.moduleName ?? "",
      cloned,
    );
    return cloned;
  }
  const declarations = pruneUnusedImportedDeclarations(
    importedProgram.declarations,
    roots,
    importTrace,
  );
  const pruned = { ...importedProgram, declarations };
  if (cacheKey) cache?.prunedImports?.set(cacheKey, cloneProgram(pruned));
  traceImportPhaseSync(
    importTrace,
    "import.prune.finish",
    {
      moduleName: importedProgram.moduleName,
      declarationCount: importedProgram.declarations.length,
      keptDeclarationCount: declarations.length,
    },
    () => undefined,
  );
  return pruned;
}

function aliasReferenceRoots(
  importedDeclarations: Declaration[],
  localDeclarations: Declaration[],
  alias: string,
): Set<string> {
  const qualifiedNames = new Set(
    importedDeclarations
      .flatMap(collectDeclarationNames)
      .map((name) => qualifyName(name, alias)),
  );
  const nameIndex = createDeclarationNameIndex(qualifiedNames);
  const roots = new Set<string>();
  for (const decl of localDeclarations) {
    for (const ref of referencedDeclarationNames(decl, nameIndex)) {
      if (ref.startsWith(`${alias}.`)) roots.add(ref.slice(alias.length + 1));
    }
  }
  return roots;
}

function pruneUnusedImportedDeclarations(
  declarations: Declaration[],
  localNames: Set<string>,
  importTrace?: ImportTraceState,
): Declaration[] {
  const { byName, ownerByName, nameIndex } = traceImportPhaseSync(
    importTrace,
    "import.prune.collect_names",
    { declarationCount: declarations.length },
    () => {
      const byName = new Map<string, Declaration[]>();
      for (const decl of declarations) {
        const group = byName.get(decl.name) ?? [];
        group.push(decl);
        byName.set(decl.name, group);
      }
      const ownerByName = new Map<string, string>();
      for (const decl of declarations) {
        for (const name of collectDeclarationNames(decl)) ownerByName.set(name, decl.name);
      }
      const declarationNames = new Set(declarations.flatMap(collectDeclarationNames));
      return { byName, ownerByName, nameIndex: createDeclarationNameIndex(declarationNames) };
    },
  );
  const keep = new Set<string>(localNames);
  const work = [...localNames];
  let referenceCount = 0;
  let referenceMs = 0;
  traceImportPhaseSync(
    importTrace,
    "import.prune.worklist",
    { declarationCount: declarations.length },
    () => {
      while (work.length) {
        const name = work.pop()!;
        for (const decl of byName.get(name) ?? []) {
          const referenceStart = performance.now();
          const refs = referencedDeclarationNames(decl, nameIndex);
          referenceMs += performance.now() - referenceStart;
          referenceCount += refs.size;
          for (const ref of refs) {
            const owner = ownerByName.get(ref) ?? ref;
            const ownerWasKept = keep.has(owner);
            keep.add(ref);
            if (ownerWasKept) continue;
            keep.add(owner);
            work.push(owner);
          }
        }
        for (const clause of byName.get(name) ?? []) {
          if (keep.has(clause.name)) continue;
          keep.add(clause.name);
          work.push(clause.name);
        }
      }
    },
    () => ({ keptDeclarationCount: keep.size, referenceCount }),
  );
  recordImportPhase(importTrace, {
    name: "import.prune.references",
    ms: referenceMs,
    declarationCount: declarations.length,
    keptDeclarationCount: keep.size,
    referenceCount,
  });
  return declarations.filter((decl) => localNames.has(decl.name) || keep.has(decl.name));
}

interface DeclarationNameIndex {
  names: Set<string>;
  firstSegments: Set<string>;
}

function createDeclarationNameIndex(names: Set<string>): DeclarationNameIndex {
  const firstSegments = new Set<string>();
  for (const name of names) firstSegments.add(nameFirstSegment(name));
  return { names, firstSegments };
}

function referencedDeclarationNames(
  decl: Declaration,
  nameIndex: DeclarationNameIndex,
): Set<string> {
  const refs = new Set<string>();
  const add = (name: string | undefined) => {
    if (!name || name.startsWith("@")) return;
    const match = longestReferencedName(name, nameIndex);
    if (match) refs.add(match);
  };
  const addTypeSource = (source: string | undefined) => {
    if (!source) return;
    for (const token of typeSourceReferenceTokens(source, nameIndex)) add(token);
  };
  const visitPattern = (pattern: ParamPattern | undefined) => {
    if (!pattern) return;
    if (pattern.kind === "constructor" || pattern.kind === "type") add(pattern.name);
    if (pattern.kind === "constructor" || pattern.kind === "tuple") {
      const items = pattern.kind === "constructor" ? pattern.args : pattern.items;
      for (const item of items) visitPattern(item);
    }
  };
  const visitExpr = (expr: Expr | undefined) => {
    if (!expr) return;
    switch (expr.kind) {
      case "do":
        add(expr.strategy.name);
        visitTypeExpr(expr.strategy.effect);
        for (const stmt of expr.statements) {
          if (
            stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
          ) {
            visitExpr(stmt.value);
          } else visitTypeExpr(stmt.value);
        }
        visitExpr(expr.expr);
        return;
      case "var":
        add(expr.name);
        return;
      case "call":
        visitExpr(expr.callee);
        expr.args.forEach(visitExpr);
        return;
      case "const_fn":
        visitExpr(expr.body);
        return;
      case "index":
        visitExpr(expr.target);
        visitExpr(expr.index);
        return;
      case "binary":
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case "pipe_bind":
        visitExpr(expr.value);
        visitExpr(expr.body);
        return;
      case "match":
        visitExpr(expr.value);
        for (const arm of expr.arms) {
          visitPattern(arm.pattern);
          visitExpr(arm.value);
        }
        return;
      case "shape":
      case "product_constructor":
        if (expr.kind === "product_constructor") add(expr.constructor);
        for (const slot of expr.slots) {
          visitExpr(slot.index);
          visitExpr(slot.value);
          if (slot.repeat) visitTypeCountExpr(slot.repeat);
        }
        return;
      case "static_for_slots":
        visitStaticForSource(expr.source);
        visitExpr(expr.value);
        return;
      case "field":
        visitExpr(expr.value);
        visitExpr(expr.key);
        return;
      case "range":
        visitExpr(expr.start);
        visitExpr(expr.end);
        return;
      case "block":
        for (const stmt of expr.statements) {
          if (stmt.kind === "proof_const") {
            visitTypeExpr(stmt.value);
          } else {
            if (stmt.kind === "let") addTypeSource(stmt.type);
            visitExpr(stmt.value);
          }
        }
        visitExpr(expr.expr);
        return;
      case "literal":
      case "placeholder":
        return;
    }
  };
  const visitTypeExpr = (expr: TypeExpr | undefined) => {
    if (!expr) return;
    switch (expr.kind) {
      case "type_ref":
      case "type_static_ref":
        add(expr.name);
        return;
      case "type_call":
        visitTypeExpr(expr.callee);
        expr.args.forEach(visitTypeExpr);
        return;
      case "type_fn":
        addTypeSource(expr.source);
        return;
      case "type_shape":
        visitTypeShape(expr.shape);
        return;
      case "type_match":
        visitTypeExpr(expr.value);
        for (const arm of expr.arms) {
          if (arm.pattern.kind === "type") add(arm.pattern.name);
          visitTypeExpr(arm.value);
        }
        return;
      case "type_operator":
        add(expr.descriptor.target);
        return;
      case "type_binary":
        visitTypeExpr(expr.left);
        visitTypeExpr(expr.right);
        return;
      case "type_bool":
      case "type_number":
      case "type_char":
      case "type_string":
      case "type_literal":
        return;
    }
  };
  const visitTypeShape = (shape: TypeShape) => {
    for (const slot of shape.slots) {
      visitTypeExpr(slot.type);
      if (slot.repeat) visitTypeCountExpr(slot.repeat);
    }
    for (const member of shape.members ?? []) {
      addTypeSource(member.type);
      add(member.target);
      if (member.inlineFn) visitDecl(member.inlineFn);
    }
  };
  const visitTypeCountExpr = (expr: TypeCountExpr) => {
    if (expr.kind === "count_ref") add(expr.name);
    if (expr.kind === "count_mul") {
      visitTypeCountExpr(expr.left);
      visitTypeCountExpr(expr.right);
    }
  };
  const visitStaticForSource = (source: StaticForSource) => {
    if (source.kind === "range") {
      visitExpr(source.start);
      visitExpr(source.end);
    } else visitExpr(source.shape);
  };
  const visitTypeBlock = (block: TypeBlock) => {
    for (const stmt of block.statements) visitTypeExpr(stmt.value);
    visitTypeExpr(block.expr);
  };
  const visitDecl = (item: Declaration) => {
    if (item.kind === "fn") {
      add(item.memberOf?.owner);
      for (const param of item.params) {
        addTypeSource(param.type);
        visitPattern(param.pattern);
      }
      addTypeSource(item.returnType);
      visitExpr(item.body);
      return;
    }
    if (item.kind === "type") {
      visitTypeBlock(item.body);
      for (const clause of item.clauses ?? []) visitDecl(clause);
      return;
    }
    if (item.kind === "contract") {
      add(item.memberOf?.owner);
      for (const param of item.params) {
        addTypeSource(param.type);
        visitPattern(param.pattern);
      }
      visitExpr(item.body);
      return;
    }
    addTypeSource(item.type);
    visitExpr(item.value);
  };
  visitDecl(decl);
  return refs;
}

function longestReferencedName(
  name: string,
  nameIndex: DeclarationNameIndex,
): string | undefined {
  for (const candidate of qualifiedReferencePrefixes(name)) {
    if (nameIndex.names.has(candidate)) return candidate;
  }
  return undefined;
}

function typeSourceReferenceTokens(
  source: string,
  nameIndex: DeclarationNameIndex,
): string[] {
  const refs: string[] = [];
  const pattern = /[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)*/g;
  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    if (nameIndex.firstSegments.has(nameFirstSegment(token))) refs.push(token);
  }
  return refs;
}

function splitQualifiedReference(name: string): string[] {
  return name.split(/(?:::|\.)/).filter(Boolean);
}

function qualifiedReferencePrefixes(name: string): string[] {
  const pieces = name.match(/[A-Za-z_][A-Za-z0-9_]*|::|\./g) ?? [];
  const prefixes: string[] = [];
  for (let index = pieces.length; index > 0; index -= 2) {
    prefixes.push(pieces.slice(0, index).join(""));
  }
  return prefixes;
}

function nameFirstSegment(name: string): string {
  return splitQualifiedReference(name)[0] ?? name;
}

function importedDeclarationsCanShareName(left: Declaration, right: Declaration): boolean {
  return left.kind === "fn" && right.kind === "fn";
}

function destructureImportedDeclarations(
  sourceImport: SourceImport,
  program: Program,
  alias: string,
  diagnostics: Diagnostic[],
  pruneImports: boolean,
  importTrace?: ImportTraceState,
  cache?: {
    prunedImports?: Map<string, Program>;
    sourceKey(program: Program): string | undefined;
  },
): Declaration[] {
  const bindings = sourceImport.bindings ?? [];
  const bindingNames = new Set(bindings.map((binding) => binding.name));
  for (const binding of bindings) {
    if (!program.declarations.some((item) => declarationName(item) === binding.name)) {
      diagnostics.push({
        code: "module.missing_binding",
        message: `module ${sourceImport.module} has no declaration named ${binding.name}`,
        span: binding.nameSpan ?? binding.span,
      });
    }
  }
  const prunedProgram = pruneImports
    ? pruneImportedProgram(program, bindingNames, importTrace, cache)
    : program;
  const names = new Set(prunedProgram.declarations.flatMap(collectDeclarationNames));
  const hiddenDecls = qualifyImportedDeclarations(prunedProgram.declarations, alias).map(
    markPrivate,
  );
  const selected: Declaration[] = [];
  const seenBindings = new Set<string>();
  for (const binding of bindings) {
    if (seenBindings.has(binding.name)) continue;
    seenBindings.add(binding.name);
    const decl = prunedProgram.declarations.find((item) => declarationName(item) === binding.name);
    if (!decl) continue;
    selected.push(
      unqualifiedSelectedDeclaration(qualifyDeclaration(decl, alias, names), binding.name),
    );
  }
  return [...hiddenDecls, ...selected];
}

function nextHiddenImportAlias(reservedNames: Set<string>, start: number): string {
  let index = start;
  while (true) {
    const alias = `__import${index++}`;
    if (![...reservedNames].some((name) => name === alias || name.startsWith(`${alias}.`))) {
      return alias;
    }
  }
}

function unqualifiedSelectedDeclaration(decl: Declaration, name: string): Declaration {
  if (decl.kind === "fn") {
    return withMeta(decl, { ...decl, name, imported: true, rootPublic: false });
  }
  if (decl.kind === "type") return withMeta(decl, { ...decl, name });
  return withMeta(decl, { ...decl, name });
}

function markPrivate(decl: Declaration): Declaration {
  if (decl.kind === "fn" || decl.kind === "type") {
    return withMeta(decl, { ...decl, public: false });
  }
  return decl;
}

function markImportedDeclaration(decl: Declaration): Declaration {
  if (decl.kind === "fn") return withMeta(decl, { ...decl, imported: true, rootPublic: false });
  return decl;
}

function markRootDeclaration(decl: Declaration): Declaration {
  if (decl.kind === "fn") {
    return withMeta(decl, {
      ...decl,
      imported: false,
      rootPublic: decl.public === true,
    });
  }
  return decl;
}

async function parseModuleSource(
  source: string | ModuleSource,
  moduleName: string,
): Promise<Program> {
  return typeof source === "string"
    ? await parse(source, { sourceId: moduleName })
    : await parse(source.text, { sourceId: source.sourceId ?? moduleName });
}

function moduleSourceCacheKey(moduleName: string, source: string | ModuleSource): string {
  const sourceId = typeof source === "string" ? moduleName : source.sourceId ?? moduleName;
  const text = typeof source === "string" ? source : source.text;
  return `${sourceId}\0${text.length}\0${hashString(text)}`;
}

function resolvedModuleCacheKey(sourceKey: string, pruneImports: boolean): string {
  return `${pruneImports ? "pruned" : "full"}\0${sourceKey}`;
}

function prunedImportCacheKey(sourceKey: string, roots: Set<string>): string {
  return `pruned_import\0${sourceKey}\0${[...roots].sort().join("\0")}`;
}

function hashString(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cloneProgram(program: Program): Program {
  const clone = structuredClone(program) as Program;
  restoreAstMetadata(clone, program);
  return hideAstMetadata(clone);
}

function restoreAstMetadata(target: unknown, source: unknown, seen = new WeakSet<object>()) {
  if (!target || !source || typeof target !== "object" || typeof source !== "object") return;
  if (seen.has(source)) return;
  seen.add(source);
  copyAstMetadata(target, source);
  if (Array.isArray(target) && Array.isArray(source)) {
    for (let index = 0; index < source.length; index++) {
      restoreAstMetadata(target[index], source[index], seen);
    }
    return;
  }
  const targetObject = target as Record<string, unknown>;
  for (const [key, child] of Object.entries(source)) {
    restoreAstMetadata(targetObject[key], child, seen);
  }
}

function recordImportCacheHit(
  trace: ImportTraceState | undefined,
  name: string,
  moduleName: string,
  program: Program,
) {
  recordImportPhase(trace, {
    name,
    ms: 0,
    moduleName,
    cacheHit: true,
    ...importProgramCounters(program),
  });
}

async function traceImportPhase<t>(
  trace: ImportTraceState | undefined,
  name: string,
  detail: Omit<ImportPhaseTrace, "name" | "ms">,
  fn: () => Promise<t> | t,
  after?: (result: t) => Omit<ImportPhaseTrace, "name" | "ms">,
): Promise<t> {
  if (!trace) return await fn();
  const start = performance.now();
  const result = await fn();
  recordImportPhase(trace, {
    name,
    ms: performance.now() - start,
    ...detail,
    ...(after?.(result) ?? {}),
  });
  return result;
}

function traceImportPhaseSync<t>(
  trace: ImportTraceState | undefined,
  name: string,
  detail: Omit<ImportPhaseTrace, "name" | "ms">,
  fn: () => t,
  after?: (result: t) => Omit<ImportPhaseTrace, "name" | "ms">,
): t {
  if (!trace) return fn();
  const start = performance.now();
  const result = fn();
  recordImportPhase(trace, {
    name,
    ms: performance.now() - start,
    ...detail,
    ...(after?.(result) ?? {}),
  });
  return result;
}

function recordImportPhase(trace: ImportTraceState | undefined, phase: ImportPhaseTrace) {
  if (!trace) return;
  trace.phases.push(phase);
  recordCompileTrace(trace.compileTrace, {
    name: phase.name,
    durationMs: phase.ms,
    counters: importTraceCounters(phase),
  });
}

function importTraceCounters(phase: ImportPhaseTrace) {
  return {
    moduleName: phase.moduleName,
    cacheHit: phase.cacheHit,
    declarationsIn: phase.declarationCount,
    declarationsOut: phase.keptDeclarationCount,
    typeCount: phase.typeCount,
    fnCount: phase.fnCount,
    contractCount: phase.contractCount,
    sourceImportCount: phase.sourceImportCount,
    referencedNameCount: phase.referenceCount,
    keptNameCount: phase.keptDeclarationCount,
  };
}

function importProgramCounters(program: Program) {
  return {
    declarationCount: program.declarations.length,
    typeCount: program.declarations.filter((decl) => decl.kind === "type").length,
    fnCount: program.declarations.filter((decl) => decl.kind === "fn").length,
    contractCount: program.declarations.filter((decl) => decl.kind === "contract").length,
    sourceImportCount: program.sourceImports?.length ?? 0,
  };
}

function recordCompileTrace(
  trace: CompileTraceSink | undefined,
  event: {
    name: string;
    durationMs: number;
    counters?: Record<string, string | number | boolean | undefined>;
  },
) {
  if (!trace) return;
  if (Array.isArray(trace)) trace.push(event);
  else if (typeof trace === "function") trace(event);
  else trace.onCompileTrace(event);
}

function declarationName(decl: Declaration): string {
  return decl.name;
}

function qualifyImportedDeclarations(declarations: Declaration[], alias: string): Declaration[] {
  const names = new Set(declarations.flatMap(collectDeclarationNames));
  return declarations.map((decl) => qualifyDeclaration(decl, alias, names));
}

function collectDeclarationNames(decl: Declaration): string[] {
  if (decl.kind !== "type") return [decl.name];
  return [
    decl.name,
    ...collectTypeBlockNames(decl.body),
    ...(decl.clauses ?? []).flatMap(collectDeclarationNames),
  ];
}

function collectTypeBlockNames(block: TypeBlock): string[] {
  return block.statements.map((stmt) => stmt.name);
}

function qualifyDeclaration(decl: Declaration, alias: string, names: Set<string>): Declaration {
  if (decl.kind === "fn") {
    return withMeta(decl, {
      ...decl,
      imported: true,
      rootPublic: false,
      name: qualifyName(decl.name, alias),
      memberOf: decl.memberOf
        ? {
          ...decl.memberOf,
          owner: qualifyReference(decl.memberOf.owner, alias, names),
          member: decl.memberOf.member,
        }
        : undefined,
      params: decl.params.map((param) => ({
        ...param,
        type: qualifyTypeSource(param.type, alias, names),
        pattern: param.pattern ? qualifyParamPattern(param.pattern, alias, names) : undefined,
      })),
      returnType: decl.returnType ? qualifyTypeSource(decl.returnType, alias, names) : undefined,
      body: qualifyExpr(decl.body, alias, names) as FnDecl["body"],
    });
  }
  if (decl.kind === "contract") {
    return withMeta(decl, {
      ...decl,
      name: qualifyName(decl.name, alias),
      memberOf: decl.memberOf
        ? {
          ...decl.memberOf,
          owner: qualifyReference(decl.memberOf.owner, alias, names),
          member: decl.memberOf.member,
        }
        : undefined,
      params: decl.params.map((param) => ({
        ...param,
        type: qualifyTypeSource(param.type, alias, names),
        pattern: param.pattern ? qualifyParamPattern(param.pattern, alias, names) : undefined,
      })),
      body: qualifyExpr(decl.body, alias, names) as typeof decl.body,
    });
  }
  if (decl.kind === "type") return qualifyTypeDecl(decl, alias, names);
  if (decl.kind === "const") return qualifyConstLike(decl, alias, names);
  return withMeta(decl, {
    ...decl,
    name: qualifyName(decl.name, alias),
    type: decl.type ? qualifyTypeSource(decl.type, alias, names) : undefined,
    value: qualifyExpr(decl.value, alias, names),
  });
}

function qualifyConstLike<t extends ConstDecl | LetDecl>(
  decl: t,
  alias: string,
  names: Set<string>,
): t {
  return withMeta(decl, {
    ...decl,
    name: qualifyName(decl.name, alias),
    type: decl.type ? qualifyTypeSource(decl.type, alias, names) : undefined,
    value: qualifyExpr(decl.value, alias, names),
  });
}

function qualifyTypeDecl(decl: TypeDecl, alias: string, names: Set<string>): TypeDecl {
  return withMeta(decl, {
    ...decl,
    name: qualifyName(decl.name, alias),
    paramPatterns: decl.paramPatterns?.map((pattern) => qualifyParamPattern(pattern, alias, names)),
    body: qualifyTypeBlock(decl.body, alias, names),
    normalized: undefined,
    clauses: decl.clauses?.map((clause) => qualifyTypeDecl(clause, alias, names)),
  });
}

function qualifyTypeBlock(block: TypeBlock, alias: string, names: Set<string>): TypeBlock {
  return withMeta(block, {
    kind: "type_block",
    statements: block.statements.map((stmt) =>
      withMeta(stmt, {
        ...stmt,
        name: qualifyName(stmt.name, alias),
        value: qualifyTypeExpr(stmt.value, alias, names),
      })
    ),
    expr: block.expr ? qualifyTypeExpr(block.expr, alias, names) : undefined,
  });
}

function qualifyExpr(expr: Expr, alias: string, names: Set<string>): Expr {
  switch (expr.kind) {
    case "do":
      return withMeta(expr, {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
            ? { ...stmt, value: qualifyExpr(stmt.value, alias, names) }
            : stmt
        ),
        expr: expr.expr ? qualifyExpr(expr.expr, alias, names) : undefined,
      });
    case "var":
      return withMeta(expr, { ...expr, name: qualifyReference(expr.name, alias, names) });
    case "call":
      return withMeta(expr, {
        ...expr,
        callee: qualifyExpr(expr.callee, alias, names),
        args: expr.args.map((arg) => qualifyExpr(arg, alias, names)),
      });
    case "const_fn":
      return withMeta(expr, { ...expr, body: qualifyExpr(expr.body, alias, names) });
    case "index":
      return withMeta(expr, {
        ...expr,
        target: qualifyExpr(expr.target, alias, names),
        index: qualifyExpr(expr.index, alias, names),
      });
    case "binary":
      return withMeta(expr, {
        ...expr,
        left: qualifyExpr(expr.left, alias, names),
        right: qualifyExpr(expr.right, alias, names),
      });
    case "pipe_bind":
      return withMeta(expr, {
        ...expr,
        value: qualifyExpr(expr.value, alias, names),
        body: qualifyExpr(expr.body, alias, names),
      });
    case "match":
      return withMeta(expr, {
        ...expr,
        value: qualifyExpr(expr.value, alias, names),
        arms: expr.arms.map((arm) =>
          withMeta(arm, { ...arm, value: qualifyExpr(arm.value, alias, names) })
        ),
      });
    case "shape":
      return withMeta(expr, {
        ...expr,
        slots: expr.slots.map((slot) =>
          withMeta(slot, {
            ...slot,
            value: qualifyExpr(slot.value, alias, names),
          })
        ),
      });
    case "static_for_slots":
      return withMeta(expr, {
        ...expr,
        source: qualifyStaticForSource(expr.source, alias, names),
        value: qualifyExpr(expr.value, alias, names),
      });
    case "product_constructor":
      return withMeta(expr, {
        ...expr,
        constructor: qualifyReference(expr.constructor, alias, names),
        slots: expr.slots.map((slot) =>
          withMeta(slot, {
            ...slot,
            value: qualifyExpr(slot.value, alias, names),
          })
        ),
      });
    case "range":
      return withMeta(expr, {
        ...expr,
        start: qualifyExpr(expr.start, alias, names),
        end: qualifyExpr(expr.end, alias, names),
      });
    case "field":
      return withMeta(expr, {
        ...expr,
        value: qualifyExpr(expr.value, alias, names),
        key: qualifyExpr(expr.key, alias, names),
      });
    case "block":
      return withMeta(expr, {
        ...expr,
        statements: expr.statements.map((stmt) => {
          if (stmt.kind === "let") {
            return withMeta(stmt, {
              ...stmt,
              type: stmt.type ? qualifyTypeSource(stmt.type, alias, names) : undefined,
              value: qualifyExpr(stmt.value, alias, names),
            });
          }
          if (stmt.kind === "destructure_let") {
            return withMeta(stmt, { ...stmt, value: qualifyExpr(stmt.value, alias, names) });
          }
          if (stmt.kind === "proof_const") {
            return withMeta(stmt, { ...stmt, value: qualifyTypeExpr(stmt.value, alias, names) });
          }
          return stmt;
        }),
        expr: expr.expr ? qualifyExpr(expr.expr, alias, names) : undefined,
      });
    case "literal":
    case "placeholder":
      return expr;
  }
}

function qualifyTypeExpr(expr: TypeExpr, alias: string, names: Set<string>): TypeExpr {
  switch (expr.kind) {
    case "type_ref":
      return withMeta(expr, { ...expr, name: qualifyReference(expr.name, alias, names) });
    case "type_call":
      return withMeta(expr, {
        ...expr,
        callee: qualifyTypeExpr(expr.callee, alias, names),
        args: expr.args.map((arg) => qualifyTypeExpr(arg, alias, names)),
      });
    case "type_shape":
      return withMeta(expr, { ...expr, shape: qualifyTypeShape(expr.shape, alias, names) });
    case "type_match":
      return withMeta(expr, {
        ...expr,
        value: qualifyTypeExpr(expr.value, alias, names),
        arms: expr.arms.map((arm) =>
          withMeta(arm, {
            pattern: qualifyTypePattern(arm.pattern, alias, names),
            value: qualifyTypeExpr(arm.value, alias, names),
          })
        ),
      });
    case "type_binary":
      return withMeta(expr, {
        ...expr,
        left: qualifyTypeExpr(expr.left, alias, names),
        right: qualifyTypeExpr(expr.right, alias, names),
      });
    case "type_operator":
      return withMeta(expr, {
        ...expr,
        descriptor: {
          ...expr.descriptor,
          target: qualifyReference(expr.descriptor.target, alias, names),
        },
      });
    case "type_fn":
      return withMeta(expr, { ...expr, source: qualifyTypeSource(expr.source, alias, names) });
    case "type_static_ref":
    case "type_bool":
    case "type_number":
    case "type_char":
    case "type_string":
    case "type_literal":
      return expr;
  }
}

function qualifyStaticForSource(
  source: StaticForSource,
  alias: string,
  names: Set<string>,
): StaticForSource {
  return source.kind === "range"
    ? withMeta(source, {
      ...source,
      start: qualifyExpr(source.start, alias, names),
      end: qualifyExpr(source.end, alias, names),
    })
    : withMeta(source, { ...source, shape: qualifyExpr(source.shape, alias, names) });
}

function qualifyTypeShape(shape: TypeShape, alias: string, names: Set<string>): TypeShape {
  return withMeta(shape, {
    slots: shape.slots.map((slot) =>
      withMeta(slot, {
        ...slot,
        type: qualifyTypeExpr(slot.type, alias, names),
        repeat: slot.repeat ? qualifyTypeCountExpr(slot.repeat, alias, names) : undefined,
      })
    ),
    members: shape.members?.map((member) => qualifyTypeMember(member, alias, names)),
  });
}

function qualifyTypeMember(
  member: TypeMemberExpr,
  alias: string,
  names: Set<string>,
): TypeMemberExpr {
  return withMeta(member, {
    ...member,
    type: qualifyTypeSource(member.type, alias, names),
    target: qualifyReference(member.target, alias, names),
    inlineFn: member.inlineFn
      ? qualifyDeclaration(member.inlineFn, alias, names) as FnDecl
      : undefined,
  });
}

function qualifyTypeCountExpr(
  expr: TypeCountExpr,
  alias: string,
  names: Set<string>,
): TypeCountExpr {
  if (expr.kind === "count_ref") {
    return withMeta(expr, { ...expr, name: qualifyReference(expr.name, alias, names) });
  }
  if (expr.kind === "count_mul") {
    return withMeta(expr, {
      ...expr,
      left: qualifyTypeCountExpr(expr.left, alias, names),
      right: qualifyTypeCountExpr(expr.right, alias, names),
    });
  }
  return expr;
}

function qualifyParamPattern(
  pattern: ParamPattern,
  alias: string,
  names: Set<string>,
): ParamPattern {
  if (pattern.kind === "constructor" || pattern.kind === "type") {
    return pattern.kind === "constructor"
      ? withMeta(pattern, {
        ...pattern,
        name: qualifyReference(pattern.name, alias, names),
        args: pattern.args.map((arg) => qualifyParamPattern(arg, alias, names)),
      })
      : withMeta(pattern, { ...pattern, name: qualifyReference(pattern.name, alias, names) });
  }
  return pattern;
}

function qualifyTypePattern(pattern: TypePattern, alias: string, names: Set<string>): TypePattern {
  return pattern.kind === "type"
    ? withMeta(pattern, { ...pattern, name: qualifyReference(pattern.name, alias, names) })
    : pattern;
}

function withMeta<t extends object>(source: unknown, target: t): t {
  return copyAstMetadata(target, source);
}

function qualifyTypeSource(source: string, alias: string, names: Set<string>): string {
  let result = source;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    result = result.replace(
      new RegExp(`(?<![A-Za-z0-9_.])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g"),
      qualifyName(name, alias),
    );
  }
  return result;
}

function qualifyReference(name: string, alias: string, names: Set<string>): string {
  const match = [...names]
    .filter((candidate) =>
      name === candidate || name.startsWith(`${candidate}.`) || name.startsWith(`${candidate}::`)
    )
    .sort((a, b) => b.length - a.length)[0];
  if (!match) return name;
  return `${qualifyName(match, alias)}${name.slice(match.length)}`;
}

function qualifyName(name: string, alias: string): string {
  return `${alias}.${name}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
