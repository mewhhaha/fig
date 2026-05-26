import { parse } from "./parser.ts";
import {
  type AnalysisCheckResult,
  checkProgram,
  checkProgramForAnalysis,
  type CheckResult,
  type CheckTrace,
  type FunctionCheckCacheEntry,
} from "./check.ts";
import {
  type BackendFunctionCacheEntry,
  type BackendOptions,
  emitWasm,
  emitWat,
  type FigAbiManifest,
  type FigDebugTraceSite,
  type FigProfileSite,
  lowerProgramToBackendArtifact,
  wasmFromBackendModule,
  watFromBackendModule,
} from "./backend.ts";
import type {
  ConstDecl,
  Declaration,
  Expr,
  FnDecl,
  LetDecl,
  OperatorDecl,
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

export {
  createFigHost,
  decodeFigValue,
  encodeFigValue,
  type FigHost,
  type FigInstance,
  instantiateFig,
  parseFigAbiManifest,
} from "./abi.ts";
export type {
  FigAbiFunction,
  FigAbiLayout,
  FigAbiLayoutField,
  FigAbiManifest,
  FigAbiValue,
  FigAbiVariant,
  FigDebugTraceSite,
  FigProfileSite,
} from "./backend.ts";

export interface ModuleSource {
  text: string;
  sourceId?: string;
}

export interface ModuleResolveContext {
  fromSourceId?: string;
  fromModuleName?: string;
}

export type ModuleResolver = (
  moduleName: string,
  context?: ModuleResolveContext,
) => string | ModuleSource | undefined | Promise<string | ModuleSource | undefined>;

export interface CheckSourceOptions extends CompilerPluginOptions {
  sourceId?: string;
  pruneImports?: boolean;
  trace?: boolean | CompileTraceSink;
  compileTrace?: CompileTraceSink;
  cache?: CompileCache;
  resolveModule?: ModuleResolver;
}

export interface CompileSourceOptions extends CheckSourceOptions, BackendOptions {}

export interface CompileArtifactsOptions extends CompileSourceOptions {
  includeWat?: boolean;
}

export interface CompileCache {
  parsedModules: Map<string, Program>;
  resolvedModules: Map<string, Program>;
  prunedImports: Map<string, Program>;
  linkedModules?: Map<string, LinkedModule>;
  importClosures?: Map<string, ImportClosure>;
  referenceSummaries?: Map<string, DeclarationReferenceSummary>;
  functionChecks?: Map<string, FunctionCheckCacheEntry>;
  backendFunctions?: Map<string, BackendFunctionCacheEntry>;
}

export function createCompileCache(): CompileCache {
  return {
    parsedModules: new Map(),
    resolvedModules: new Map(),
    prunedImports: new Map(),
    linkedModules: new Map(),
    importClosures: new Map(),
    referenceSummaries: new Map(),
    functionChecks: new Map(),
    backendFunctions: new Map(),
  };
}

export interface LinkedModule {
  program: Program;
  localNames: string[];
  supportNames: string[];
}

export interface ImportClosure {
  declarations: Declaration[];
  supportNames: string[];
  publicNames?: string[];
}

export interface DeclarationReferenceSummary {
  names: string[];
}

export function createCompilerSession(options: CompilerSessionOptions): CompilerSession {
  const cache = options.cache ?? createCompileCache();
  const rootDependencies = new Map<string, Set<string>>();
  const sources = new Map<string, ModuleSource>();

  const affectedRoots = (sourceId: string): readonly string[] => {
    const roots: string[] = [];
    for (const [rootSourceId, dependencies] of rootDependencies) {
      if (rootSourceId === sourceId || dependencies.has(sourceId)) roots.push(rootSourceId);
    }
    return roots;
  };

  const watchedSourceIds = (rootSourceId?: string): readonly string[] => {
    if (rootSourceId) {
      return [rootSourceId, ...rootDependencies.get(rootSourceId) ?? []];
    }
    const watched = new Set<string>();
    for (const [root, dependencies] of rootDependencies) {
      watched.add(root);
      for (const dependency of dependencies) watched.add(dependency);
    }
    return [...watched];
  };

  const invalidate = (sourceId: string) => invalidateCompileCacheSource(cache, sourceId);

  return {
    update(source) {
      const affected = affectedRoots(source.sourceId);
      sources.set(source.sourceId, source);
      invalidate(source.sourceId);
      return { affectedRoots: affected };
    },
    remove(sourceId) {
      const affected = affectedRoots(sourceId);
      sources.delete(sourceId);
      rootDependencies.delete(sourceId);
      for (const dependencies of rootDependencies.values()) dependencies.delete(sourceId);
      invalidate(sourceId);
      return { affectedRoots: affected };
    },
    affectedRoots,
    watchedSourceIds,
    async compileRoot(source, overrides = {}) {
      sources.set(source.sourceId, source);
      const dependencies: ModuleDependency[] = [];
      const moduleSources = new Map<string, ModuleSource>([[source.sourceId, source]]);
      const graph: ModuleGraphCapture = {
        rootSourceId: source.sourceId,
        requireSourceId: true,
        dependencies,
        moduleSources,
      };
      const affected = affectedRoots(source.sourceId);
      const compileOptions: CompileArtifactsOptionsInternal = {
        ...options,
        ...overrides,
        sourceId: source.sourceId,
        resolveModule: options.resolveModule,
        cache,
        moduleGraph: graph,
      };
      try {
        const artifact = await compileArtifactsFromSourceImpl(source.text, compileOptions);
        const dependencySet = new Set(dependencies.map((item) => item.sourceId));
        rootDependencies.set(source.sourceId, dependencySet);
        for (const [sourceId, moduleSource] of moduleSources) sources.set(sourceId, moduleSource);
        return {
          ok: true,
          artifact,
          dependencies,
          watchedSourceIds: watchedSourceIds(source.sourceId),
          affectedRoots: affected,
        };
      } catch (error) {
        if (!(error instanceof CompileError)) throw error;
        const dependencySet = new Set(dependencies.map((item) => item.sourceId));
        if (dependencySet.size) rootDependencies.set(source.sourceId, dependencySet);
        for (const [sourceId, moduleSource] of moduleSources) sources.set(sourceId, moduleSource);
        return {
          ok: false,
          diagnostics: error.diagnostics,
          dependencies,
          watchedSourceIds: watchedSourceIds(source.sourceId),
          affectedRoots: affected,
        };
      }
    },
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
  abi?: FigAbiManifest;
  debugTraces: readonly FigDebugTraceSite[];
  profileSites: readonly FigProfileSite[];
  checked: ReturnType<typeof checkProgram>;
  timings: CompileArtifactTimings;
  trace?: CheckTrace;
  importTrace?: ImportTrace;
}

export interface CompileArtifactsWithWatResult extends CompileArtifactsResult {
  wat: string;
}

export interface ModuleDependency {
  importerSourceId: string;
  moduleName: string;
  sourceId: string;
}

export type CompilerSessionCompileResult =
  | {
    ok: true;
    artifact: CompileArtifactsResult;
    dependencies: readonly ModuleDependency[];
    watchedSourceIds: readonly string[];
    affectedRoots: readonly string[];
  }
  | {
    ok: false;
    diagnostics: readonly Diagnostic[];
    dependencies: readonly ModuleDependency[];
    watchedSourceIds: readonly string[];
    affectedRoots: readonly string[];
  };

export interface CompilerSessionOptions extends CompileArtifactsOptions {
  resolveModule: ModuleResolver;
}

export interface CompilerSession {
  update(source: ModuleSource & { sourceId: string }): { affectedRoots: readonly string[] };
  remove(sourceId: string): { affectedRoots: readonly string[] };
  affectedRoots(sourceId: string): readonly string[];
  watchedSourceIds(rootSourceId?: string): readonly string[];
  compileRoot(
    source: ModuleSource & { sourceId: string },
    options?: Omit<CompileArtifactsOptions, "sourceId" | "resolveModule" | "cache">,
  ): Promise<CompilerSessionCompileResult>;
}

interface ModuleGraphCapture {
  rootSourceId?: string;
  requireSourceId?: boolean;
  dependencies: ModuleDependency[];
  moduleSources?: Map<string, ModuleSource>;
}

interface CompileArtifactsOptionsInternal extends CompileArtifactsOptions {
  moduleGraph?: ModuleGraphCapture;
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

export async function checkSource(
  source: string,
  options: CheckSourceOptions = {},
): Promise<CheckResult> {
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
      sourceId: options.sourceId,
      importTrace: trace ? { phases: [], compileTrace: trace } : undefined,
    }),
    checkOptions(options),
  );
}

export async function checkSourceForAnalysis(
  source: string,
  options: CheckSourceOptions = {},
): Promise<AnalysisCheckResult> {
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
): Promise<AnalysisCheckResult> {
  if (!options.resolveModule) return checkProgramForAnalysis(program, checkOptions(options));
  const trace = compileTraceSink(options);
  return checkProgramForAnalysis(
    await resolveSourceImports(program, {
      resolveModule: options.resolveModule,
      pruneImports: options.pruneImports,
      cache: options.cache,
      sourceId: options.sourceId,
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
  options: CompileArtifactsOptionsInternal = {},
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
      sourceId: options.sourceId,
      importTrace,
      moduleGraph: options.moduleGraph,
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
    backendCache: options.cache,
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
    ...(backend.abi ? { abi: backend.abi } : {}),
    debugTraces: backend.debugTraces,
    profileSites: backend.profileSites,
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

export { parse } from "./parser.ts";
export { formatSource, isFormatted } from "./format.ts";
export { tokenize } from "./tokenize.ts";
export { type BackendOptions } from "./backend.ts";
export { type OptimizeProfile, type OptimizeProfileName, type OptMode } from "./optimize.ts";
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
export { FIG_VERSION } from "./version.ts";

async function resolveSourceImports(
  root: Program,
  options:
    & Required<Pick<CheckSourceOptions, "resolveModule">>
    & Pick<
      CheckSourceOptions,
      "cache" | "pruneImports" | "sourceId"
    >
    & { importTrace?: ImportTraceState; moduleGraph?: ModuleGraphCapture },
): Promise<Program> {
  const diagnostics: Diagnostic[] = [];
  const visiting: string[] = [];
  const resolved = new Map<string, Program>();
  const sharedCache = options.cache;
  const pruneSourceKeys = new WeakMap<Program, string>();
  const rootSourceId = options.moduleGraph?.rootSourceId ?? options.sourceId ??
    programSourceId(root);

  async function load(
    moduleName: string,
    requestedAt?: SourceImport,
    importer: Program = root,
  ): Promise<Program | undefined> {
    const importerSourceId = programSourceId(importer) ?? rootSourceId ?? "<root>";
    const source = await traceImportPhase(
      options.importTrace,
      "import.resolve.root",
      { moduleName },
      () =>
        options.resolveModule(moduleName, {
          fromSourceId: importerSourceId,
          fromModuleName: importer.moduleName,
        }),
    );
    if (source === undefined) {
      diagnostics.push({
        code: "module.not_found",
        message: `cannot resolve module ${moduleName}`,
        span: requestedAt?.span,
      });
      return undefined;
    }
    if (options.moduleGraph?.requireSourceId && !moduleSourceHasStableId(source)) {
      diagnostics.push({
        code: "module.source_id_required",
        message: `compiler sessions require a stable sourceId for module ${moduleName}`,
        span: requestedAt?.span,
      });
      return undefined;
    }
    const sourceId = moduleSourceId(moduleName, source);
    options.moduleGraph?.dependencies.push({ importerSourceId, moduleName, sourceId });
    options.moduleGraph?.moduleSources?.set(sourceId, normalizedModuleSource(moduleName, source));
    if (resolved.has(sourceId)) return resolved.get(sourceId);
    const cycleStart = visiting.indexOf(sourceId);
    if (cycleStart >= 0) {
      diagnostics.push({
        code: "module.cycle",
        message: `source import cycle: ${[...visiting.slice(cycleStart), sourceId].join(" -> ")}`,
      });
      return undefined;
    }
    visiting.push(sourceId);
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
    if (!cachedParsed) sharedCache?.parsedModules.set(parsedCacheKey, parsed);
    const resolvedCacheKey = resolvedModuleCacheKey(sourceKey, options.pruneImports === true);
    const cachedResolved = parsed.sourceImports?.length
      ? undefined
      : sharedCache?.resolvedModules.get(resolvedCacheKey);
    if (cachedResolved) {
      const cloned = cloneProgram(cachedResolved);
      resolved.set(sourceId, cloned);
      pruneSourceKeys.set(cloned, resolvedCacheKey);
      visiting.pop();
      recordImportCacheHit(options.importTrace, "import.merge.module", moduleName, cloned);
      return cloned;
    }
    const merged = await traceImportPhase(
      options.importTrace,
      "import.merge.module",
      { moduleName, ...importProgramCounters(parsed) },
      () => mergeImports(parsed, sourceKey, moduleName),
    );
    if (!parsed.sourceImports?.length) {
      sharedCache?.resolvedModules.set(resolvedCacheKey, merged);
      pruneSourceKeys.set(merged, resolvedCacheKey);
    }
    resolved.set(sourceId, merged);
    visiting.pop();
    return merged;
  }

  async function mergeImports(
    program: Program,
    currentSourceKey?: string,
    currentModuleName?: string,
  ): Promise<Program> {
    const importedPrograms: Program[] = [];
    const aliasedImports: { alias: string; program: Program }[] = [];
    const destructuredImports: { alias: string; sourceImport: SourceImport; program: Program }[] =
      [];
    const dependencyKeys: string[] = [];
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
      const imported = await load(item.module, item, program);
      if (!imported) continue;
      const dependencyKey = pruneSourceKeys.get(imported);
      if (dependencyKey) dependencyKeys.push(dependencyKey);
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
    const linkedCacheKey = currentSourceKey
      ? linkedModuleCacheKey(currentSourceKey, options.pruneImports === true, dependencyKeys)
      : undefined;
    const cachedLinked = linkedCacheKey
      ? sharedCache?.linkedModules?.get(linkedCacheKey)
      : undefined;
    if (cachedLinked) {
      const cloned = cloneProgram(cachedLinked.program);
      pruneSourceKeys.set(cloned, linkedCacheKey!);
      recordImportCacheHit(
        options.importTrace,
        "import.link.module",
        currentModuleName ?? program.moduleName ?? "",
        cloned,
      );
      return cloned;
    }
    const diagnosticCount = diagnostics.length;
    const merged = mergePrograms(
      importedPrograms,
      aliasedImports,
      destructuredImports,
      program,
      diagnostics,
      {
        pruneImports: options.pruneImports === true,
        importTrace: options.importTrace,
        enforceTransitiveSupportDiagnostics: program === root,
      },
      {
        prunedImports: sharedCache?.prunedImports,
        importClosures: sharedCache?.importClosures,
        referenceSummaries: sharedCache?.referenceSummaries,
        sourceKey: (program) => pruneSourceKeys.get(program),
      },
    );
    if (linkedCacheKey) {
      pruneSourceKeys.set(merged, linkedCacheKey);
      if (diagnostics.length === diagnosticCount) {
        const { localDecls, transitiveDecls } = splitModuleLocalDeclarations(merged);
        sharedCache?.linkedModules?.set(linkedCacheKey, {
          program: merged,
          localNames: localDecls.flatMap(collectDeclarationNames),
          supportNames: transitiveDecls.flatMap(collectDeclarationNames),
        });
      }
    }
    return merged;
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
  options: {
    pruneImports: boolean;
    importTrace?: ImportTraceState;
    enforceTransitiveSupportDiagnostics: boolean;
  },
  cache?: {
    prunedImports?: Map<string, Program>;
    importClosures?: Map<string, ImportClosure>;
    referenceSummaries?: Map<string, DeclarationReferenceSummary>;
    sourceKey(program: Program): string | undefined;
  },
): Program {
  const importedDecls = imports.flatMap((item) => item.declarations).map(markImportedDeclaration);
  const aliasedSurfaces = traceImportPhaseSync(
    options.importTrace,
    "import.qualify.imports",
    {
      declarationCount: aliasedImports.reduce(
        (sum, item) => sum + item.program.declarations.length,
        0,
      ),
    },
    () =>
      aliasedImports.map(({ alias, program: importedProgram }) => {
        const roots = options.pruneImports
          ? traceImportPhaseSync(
            options.importTrace,
            "import.prune.alias_roots",
            {
              moduleName: importedProgram.moduleName,
              declarationCount: importedProgram.declarations.length,
            },
            () => aliasReferenceRoots(importedProgram.declarations, program.declarations, alias),
            (result) => ({ referenceCount: result.size }),
          )
          : new Set(importedProgram.declarations.flatMap(collectDeclarationNames));
        const sourceKey = cache?.sourceKey(importedProgram);
        const closureCacheKey = sourceKey
          ? importClosureCacheKey(sourceKey, alias, roots, options.pruneImports)
          : undefined;
        const cached = closureCacheKey ? cache?.importClosures?.get(closureCacheKey) : undefined;
        if (cached) {
          recordImportPhase(options.importTrace, {
            name: "import.closure.cache",
            ms: 0,
            cacheHit: true,
            declarationCount: cached.declarations.length,
            referenceCount: cached.supportNames.length,
          });
          return {
            declarations: cloneDeclarations(cached.declarations),
            supportNames: new Set(cached.supportNames),
            publicNames: new Set(cached.publicNames ?? []),
          };
        }
        const prunedProgram = options.pruneImports
          ? pruneImportedProgram(importedProgram, roots, options.importTrace, cache)
          : importedProgram;
        const { localDecls, transitiveDecls } = splitModuleLocalDeclarations(prunedProgram);
        const localNames = new Set(localDecls.flatMap(collectDeclarationNames));
        const supportNames = new Set(transitiveDecls.flatMap(collectDeclarationNames));
        const publicNames = new Set([...localNames].map((name) => qualifyName(name, alias)));
        const declarations = [
          ...transitiveDecls.map(markImportedDeclaration),
          ...qualifyEffectImportsAsDeclarations(
            prunedProgram.imports,
            alias,
            localNames,
          ),
          ...qualifyImportedDeclarations(localDecls, alias, localNames),
        ];
        if (closureCacheKey) {
          cache?.importClosures?.set(closureCacheKey, {
            declarations,
            supportNames: [...supportNames],
            publicNames: [...publicNames],
          });
        }
        return { declarations, supportNames, publicNames };
      }),
    (surfaces) => ({
      keptDeclarationCount: surfaces.reduce((sum, item) => sum + item.declarations.length, 0),
      referenceCount: surfaces.reduce((sum, item) => sum + item.supportNames.size, 0),
    }),
  );
  const aliasedDecls = aliasedSurfaces.flatMap((item) => item.declarations);
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
  const transitiveSupportNames = new Set(aliasedSurfaces.flatMap((item) => [...item.supportNames]));
  for (const publicName of aliasedSurfaces.flatMap((item) => [...item.publicNames])) {
    transitiveSupportNames.delete(publicName);
  }
  if (options.enforceTransitiveSupportDiagnostics) {
    checkTransitiveSupportReferences(
      program.declarations,
      transitiveSupportNames,
      diagnostics,
    );
  }
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
    if (previous && sameImportedDeclarationIdentity(previous, decl)) {
      continue;
    }
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
      cache?.referenceSummaries,
      cache?.sourceKey(program) ? `program_prune\0${cache.sourceKey(program)}` : undefined,
    )
    : declarations;
  return hideAstMetadata({
    moduleName: program.moduleName,
    imports: [
      ...imports.flatMap((item) => item.imports),
      ...aliasedImports.flatMap((item) =>
        qualifyEffectImportTypes(
          item.program.imports,
          item.alias,
          new Set(item.program.declarations.flatMap(collectDeclarationNames)),
        )
      ),
      ...destructuredImports.flatMap((item) =>
        qualifyEffectImportTypes(
          item.program.imports,
          item.alias,
          new Set(item.program.declarations.flatMap(collectDeclarationNames)),
        )
      ),
      ...program.imports,
    ],
    sourceImports: [],
    declarations: slicedDeclarations,
  });
}

function pruneImportedProgram(
  importedProgram: Program,
  roots: Set<string>,
  importTrace?: ImportTraceState,
  cache?: {
    prunedImports?: Map<string, Program>;
    referenceSummaries?: Map<string, DeclarationReferenceSummary>;
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
    cache?.referenceSummaries,
    cacheKey,
  );
  const pruned = { ...importedProgram, declarations };
  if (cacheKey) cache?.prunedImports?.set(cacheKey, pruned);
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

function splitModuleLocalDeclarations(program: Program): {
  localDecls: Declaration[];
  transitiveDecls: Declaration[];
} {
  const moduleName = program.moduleName;
  if (!moduleName) return { localDecls: program.declarations, transitiveDecls: [] };
  const localDecls: Declaration[] = [];
  const transitiveDecls: Declaration[] = [];
  for (const decl of program.declarations) {
    const sourceId = declarationSourceId(decl);
    if (!sourceId || sourceId === moduleName) localDecls.push(decl);
    else transitiveDecls.push(decl);
  }
  return { localDecls, transitiveDecls };
}

function declarationSourceId(decl: Declaration): string | undefined {
  if (decl.span?.sourceId) return decl.span.sourceId;
  if (decl.nameSpan?.sourceId) return decl.nameSpan.sourceId;
  if (decl.kind === "type") {
    for (const clause of decl.clauses ?? []) {
      const sourceId = declarationSourceId(clause);
      if (sourceId) return sourceId;
    }
  }
  return undefined;
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

function checkTransitiveSupportReferences(
  localDeclarations: Declaration[],
  supportNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  if (!supportNames.size) return;
  const nameIndex = createDeclarationNameIndex(supportNames);
  const reported = new Set<string>();
  for (const decl of localDeclarations) {
    for (const ref of referencedDeclarationNames(decl, nameIndex)) {
      if (!supportNames.has(ref) || reported.has(ref)) continue;
      reported.add(ref);
      diagnostics.push({
        code: "module.transitive_import",
        message:
          `declaration ${ref} belongs to an imported module's dependency; import that module directly`,
        span: decl.nameSpan ?? decl.span,
      });
    }
  }
}

function pruneUnusedImportedDeclarations(
  declarations: Declaration[],
  localNames: Set<string>,
  importTrace?: ImportTraceState,
  referenceSummaries?: Map<string, DeclarationReferenceSummary>,
  referenceSummaryKey?: string,
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
          const refs = cachedReferencedDeclarationNames(
            decl,
            nameIndex,
            referenceSummaries,
            referenceSummaryKey,
          );
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

function cachedReferencedDeclarationNames(
  decl: Declaration,
  nameIndex: DeclarationNameIndex,
  referenceSummaries?: Map<string, DeclarationReferenceSummary>,
  referenceSummaryKey?: string,
): Set<string> {
  const cacheKey = referenceSummaryKey
    ? declarationReferenceSummaryKey(referenceSummaryKey, decl)
    : undefined;
  const cached = cacheKey ? referenceSummaries?.get(cacheKey) : undefined;
  if (cached) return new Set(cached.names);
  const refs = referencedDeclarationNames(decl, nameIndex);
  if (cacheKey) referenceSummaries?.set(cacheKey, { names: [...refs] });
  return refs;
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
          } else if (stmt.kind === "proof_const") visitTypeExpr(stmt.value);
          else if (stmt.kind === "debug_trace") stmt.args.forEach(visitExpr);
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
      case "operator_chain":
        visitExpr(expr.first);
        for (const item of expr.rest) {
          add(`operator:${item.op}`);
          visitExpr(item.value);
        }
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
          } else if (stmt.kind === "let" || stmt.kind === "destructure_let") {
            if (stmt.kind === "let") addTypeSource(stmt.type);
            visitExpr(stmt.value);
          } else if (stmt.kind === "debug_trace") {
            stmt.args.forEach(visitExpr);
          }
        }
        visitExpr(expr.expr);
        return;
      case "literal":
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
      case "type_hole":
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
      case "type_scalar_domain":
        for (const member of expr.members) {
          if (member.start.kind === "symbol") add(member.start.source);
          if (member.end?.kind === "symbol") add(member.end.source);
        }
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
    if (item.kind === "operator") {
      add(item.target);
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
  if (declarationSourceId(left) && declarationSourceId(left) === declarationSourceId(right)) {
    return true;
  }
  return (left.kind === "fn" && right.kind === "fn") ||
    (left.kind === "operator" && right.kind === "operator");
}

function sameImportedDeclarationIdentity(left: Declaration, right: Declaration): boolean {
  if (left.kind !== right.kind) return false;
  if (declarationName(left) !== declarationName(right)) return false;
  const leftSpan = left.nameSpan ?? left.span;
  const rightSpan = right.nameSpan ?? right.span;
  if (!leftSpan || !rightSpan) return false;
  return leftSpan.sourceId === rightSpan.sourceId &&
    leftSpan.start === rightSpan.start &&
    leftSpan.end === rightSpan.end;
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
  const { localDecls } = splitModuleLocalDeclarations(program);
  const localDeclarationNames = new Set(localDecls.map(declarationName));
  for (const binding of bindings) {
    if (!localDeclarationNames.has(binding.name)) {
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
    const decl = localDecls.find((item) => declarationName(item) === binding.name);
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
  if (decl.kind === "operator") return withMeta(decl, { ...decl, imported: true });
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
  if (decl.kind === "operator") return withMeta(decl, { ...decl, imported: true });
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
  const sourceId = moduleSourceId(moduleName, source);
  const parsed = typeof source === "string"
    ? await parse(source, { sourceId })
    : await parse(source.text, { sourceId });
  return hideAstMetadata({ ...parsed, moduleName: sourceId }) as Program;
}

function moduleSourceCacheKey(moduleName: string, source: string | ModuleSource): string {
  const sourceId = moduleSourceId(moduleName, source);
  const text = typeof source === "string" ? source : source.text;
  return `${sourceId}\0${text.length}\0${hashString(text)}`;
}

function moduleSourceId(moduleName: string, source: string | ModuleSource): string {
  return typeof source === "string" ? moduleName : source.sourceId ?? moduleName;
}

function moduleSourceHasStableId(source: string | ModuleSource): boolean {
  return typeof source !== "string" && !!source.sourceId;
}

function normalizedModuleSource(moduleName: string, source: string | ModuleSource): ModuleSource {
  return typeof source === "string"
    ? { text: source, sourceId: moduleName }
    : { text: source.text, sourceId: source.sourceId ?? moduleName };
}

function programSourceId(program: Program): string | undefined {
  if (program.moduleName) return program.moduleName;
  for (const decl of program.declarations) {
    if (decl.span?.sourceId) return decl.span.sourceId;
  }
  for (const sourceImport of program.sourceImports ?? []) {
    if (sourceImport.span?.sourceId) return sourceImport.span.sourceId;
  }
  return undefined;
}

function invalidateCompileCacheSource(cache: CompileCache, sourceId: string) {
  const markers = [`\0${sourceId}\0`, `${sourceId}\0`];
  const matches = (key: string) => markers.some((marker) => key.includes(marker));
  for (
    const map of [
      cache.parsedModules,
      cache.resolvedModules,
      cache.prunedImports,
      cache.linkedModules,
      cache.importClosures,
      cache.referenceSummaries,
      cache.functionChecks,
      cache.backendFunctions,
    ]
  ) {
    if (!map) continue;
    for (const key of map.keys()) {
      if (matches(key)) map.delete(key);
    }
  }
}

function resolvedModuleCacheKey(sourceKey: string, pruneImports: boolean): string {
  return `${pruneImports ? "pruned" : "full"}\0${sourceKey}`;
}

function linkedModuleCacheKey(
  sourceKey: string,
  pruneImports: boolean,
  dependencyKeys: string[],
): string {
  return `linked\0${pruneImports ? "pruned" : "full"}\0${sourceKey}\0${
    [...dependencyKeys].sort().join("\0")
  }`;
}

function prunedImportCacheKey(sourceKey: string, roots: Set<string>): string {
  return `pruned_import\0${sourceKey}\0${[...roots].sort().join("\0")}`;
}

function importClosureCacheKey(
  sourceKey: string,
  alias: string,
  roots: Set<string>,
  pruneImports: boolean,
): string {
  return `import_closure\0${pruneImports ? "pruned" : "full"}\0${sourceKey}\0${alias}\0${
    [...roots].sort().join("\0")
  }`;
}

function declarationReferenceSummaryKey(prefix: string, decl: Declaration): string {
  return `decl_refs\0${prefix}\0${declarationName(decl)}`;
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

function cloneDeclarations(declarations: Declaration[]): Declaration[] {
  return cloneProgram({ imports: [], declarations }).declarations;
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
  return decl.kind === "operator" ? operatorDeclarationName(decl) : decl.name;
}

function operatorDeclarationName(decl: OperatorDecl): string {
  return `operator:${decl.symbol}`;
}

function qualifyImportedDeclarations(
  declarations: Declaration[],
  alias: string,
  names = new Set(declarations.flatMap(collectDeclarationNames)),
): Declaration[] {
  return declarations.map((decl) => qualifyDeclaration(decl, alias, names));
}

function qualifyEffectImportsAsDeclarations(
  imports: Program["imports"],
  alias: string,
  names: Set<string>,
): FnDecl[] {
  return imports.map((item) => {
    const signature = parseFunctionType(item.type);
    return {
      kind: "fn",
      public: false,
      imported: true,
      rootPublic: false,
      name: qualifyName(item.name, alias),
      params: signature.params.map((param) => ({
        ...param,
        type: qualifyTypeSource(param.type, alias, names),
      })),
      returnType: qualifyTypeSource(signature.returnType, alias, names),
      effects: [...item.effects],
      body: {
        kind: "block",
        statements: [],
        expr: {
          kind: "call",
          callee: { kind: "var", name: item.name },
          args: signature.params.map((param) => ({ kind: "var", name: param.name })),
        },
      },
    };
  });
}

function qualifyEffectImportTypes(
  imports: Program["imports"],
  alias: string,
  names: Set<string>,
): Program["imports"] {
  return imports.map((item) => ({
    ...item,
    type: qualifyFunctionTypeSource(item.type, alias, names),
  }));
}

function qualifyFunctionTypeSource(source: string, alias: string, names: Set<string>): string {
  const signature = parseFunctionType(source);
  const params = signature.params.map((param) =>
    `${param.name}: ${qualifyTypeSource(param.type, alias, names)}`
  ).join(", ");
  const returnType = qualifyTypeSource(signature.returnType, alias, names);
  return `fn(${params}) -> ${returnType}`;
}

function parseFunctionType(
  type: string,
): { params: { name: string; type: string }[]; returnType: string } {
  const match = type.match(/^fn\s*\(([\s\S]*?)\)\s*->\s*([\s\S]+)$/);
  const params = splitTopLevelComma(match?.[1] ?? "").map((part, index) => {
    const pieces = part.split(":");
    return {
      name: pieces.length > 1 ? pieces[0].trim() : `arg${index}`,
      type: (pieces.at(-1) ?? "i32").trim(),
    };
  });
  return { params, returnType: match?.[2].trim() ?? "i32" };
}

function splitTopLevelComma(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      const part = source.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function collectDeclarationNames(decl: Declaration): string[] {
  if (decl.kind === "operator") return [operatorDeclarationName(decl)];
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
    const locals = paramLocalNames(decl.params);
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
      body: qualifyExpr(decl.body, alias, names, locals) as FnDecl["body"],
    });
  }
  if (decl.kind === "contract") {
    const locals = paramLocalNames(decl.params);
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
      body: qualifyExpr(decl.body, alias, names, locals) as typeof decl.body,
    });
  }
  if (decl.kind === "type") return qualifyTypeDecl(decl, alias, names);
  if (decl.kind === "const") return qualifyConstLike(decl, alias, names);
  if (decl.kind === "operator") {
    return withMeta(decl, {
      ...decl,
      imported: true,
      target: qualifyReference(decl.target, alias, names),
    });
  }
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

function paramLocalNames(params: { name: string; pattern?: ParamPattern }[]): Set<string> {
  const locals = new Set<string>();
  for (const param of params) {
    locals.add(param.name);
    collectParamPatternBindings(param.pattern, locals);
  }
  return locals;
}

function collectParamPatternBindings(pattern: ParamPattern | undefined, locals: Set<string>): void {
  if (!pattern) return;
  if (pattern.kind === "binding") {
    locals.add(pattern.name);
    return;
  }
  if (pattern.kind === "tuple") {
    for (const item of pattern.items) collectParamPatternBindings(item, locals);
    return;
  }
  if (pattern.kind === "constructor") {
    for (const item of pattern.args) collectParamPatternBindings(item, locals);
  }
}

function withLocal(locals: Set<string>, name: string): Set<string> {
  const next = new Set(locals);
  next.add(name);
  return next;
}

function withLocals(locals: Set<string>, names: string[]): Set<string> {
  const next = new Set(locals);
  for (const name of names) next.add(name);
  return next;
}

function isLocalReference(name: string, locals: Set<string>): boolean {
  for (const local of locals) {
    if (name === local || name.startsWith(`${local}.`) || name.startsWith(`${local}::`)) {
      return true;
    }
  }
  return false;
}

function qualifyReferenceExpr(
  name: string,
  alias: string,
  names: Set<string>,
  locals: Set<string>,
): string {
  if ((name.includes(".") || name.includes("::")) && names.has(name)) {
    return qualifyReference(name, alias, names);
  }
  return isLocalReference(name, locals) ? name : qualifyReference(name, alias, names);
}

function qualifyExpr(
  expr: Expr,
  alias: string,
  names: Set<string>,
  locals: Set<string> = new Set(),
): Expr {
  switch (expr.kind) {
    case "do":
      return withMeta(expr, {
        ...expr,
        strategy: {
          ...expr.strategy,
          effect: qualifyTypeExpr(expr.strategy.effect, alias, names),
        },
        ...qualifyDoBody(expr.statements, expr.expr, alias, names, locals),
      });
    case "var":
      return withMeta(expr, {
        ...expr,
        name: qualifyReferenceExpr(expr.name, alias, names, locals),
      });
    case "call":
      return withMeta(expr, {
        ...expr,
        callee: qualifyExpr(expr.callee, alias, names, locals),
        args: expr.args.map((arg) => qualifyExpr(arg, alias, names, locals)),
      });
    case "const_fn":
      return withMeta(expr, {
        ...expr,
        body: qualifyExpr(expr.body, alias, names, withLocals(locals, expr.params)),
      });
    case "profile":
      return withMeta(expr, {
        ...expr,
        args: expr.args.map((arg) => qualifyExpr(arg, alias, names, locals)),
        body: qualifyExpr(expr.body, alias, names, locals),
      });
    case "index":
      return withMeta(expr, {
        ...expr,
        target: qualifyExpr(expr.target, alias, names, locals),
        index: qualifyExpr(expr.index, alias, names, locals),
      });
    case "binary":
      return withMeta(expr, {
        ...expr,
        left: qualifyExpr(expr.left, alias, names, locals),
        right: qualifyExpr(expr.right, alias, names, locals),
      });
    case "operator_chain":
      return withMeta(expr, {
        ...expr,
        first: qualifyExpr(expr.first, alias, names, locals),
        rest: expr.rest.map((item) =>
          withMeta(item, { ...item, value: qualifyExpr(item.value, alias, names, locals) })
        ),
      });
    case "pipe_bind":
      return withMeta(expr, {
        ...expr,
        value: qualifyExpr(expr.value, alias, names, locals),
        body: qualifyExpr(expr.body, alias, names, withLocal(locals, expr.name)),
      });
    case "match":
      return withMeta(expr, {
        ...expr,
        value: qualifyExpr(expr.value, alias, names, locals),
        arms: expr.arms.map((arm) => {
          const armLocals = new Set(locals);
          collectParamPatternBindings(arm.pattern, armLocals);
          return withMeta(arm, {
            ...arm,
            pattern: qualifyParamPattern(arm.pattern, alias, names),
            value: qualifyExpr(arm.value, alias, names, armLocals),
          });
        }),
      });
    case "shape":
      return withMeta(expr, {
        ...expr,
        slots: expr.slots.map((slot) =>
          withMeta(slot, {
            ...slot,
            index: slot.index ? qualifyExpr(slot.index, alias, names, locals) : undefined,
            value: qualifyExpr(slot.value, alias, names, locals),
          })
        ),
      });
    case "static_for_slots": {
      const valueLocals = withLocal(locals, expr.iterator);
      const nextValueLocals = expr.valueIterator
        ? withLocal(valueLocals, expr.valueIterator)
        : valueLocals;
      return withMeta(expr, {
        ...expr,
        source: qualifyStaticForSource(expr.source, alias, names, locals),
        value: qualifyExpr(expr.value, alias, names, nextValueLocals),
      });
    }
    case "product_constructor":
      return withMeta(expr, {
        ...expr,
        constructor: qualifyReferenceExpr(expr.constructor, alias, names, locals),
        slots: expr.slots.map((slot) =>
          withMeta(slot, {
            ...slot,
            index: slot.index ? qualifyExpr(slot.index, alias, names, locals) : undefined,
            value: qualifyExpr(slot.value, alias, names, locals),
          })
        ),
      });
    case "range":
      return withMeta(expr, {
        ...expr,
        start: qualifyExpr(expr.start, alias, names, locals),
        end: qualifyExpr(expr.end, alias, names, locals),
      });
    case "field":
      return withMeta(expr, {
        ...expr,
        value: qualifyExpr(expr.value, alias, names, locals),
        key: qualifyExpr(expr.key, alias, names, locals),
      });
    case "block":
      return withMeta(expr, { ...expr, ...qualifyBlockBody(expr, alias, names, locals) });
    case "literal":
      return expr;
  }
}

function qualifyBlockBody(
  block: Extract<Expr, { kind: "block" }>,
  alias: string,
  names: Set<string>,
  locals: Set<string>,
): Pick<Extract<Expr, { kind: "block" }>, "statements" | "expr"> {
  let currentLocals = new Set(locals);
  const statements = block.statements.map((stmt) => {
    if (stmt.kind === "let") {
      const qualified = withMeta(stmt, {
        ...stmt,
        type: stmt.type ? qualifyTypeSource(stmt.type, alias, names) : undefined,
        value: qualifyExpr(stmt.value, alias, names, currentLocals),
      });
      currentLocals = withLocal(currentLocals, stmt.name);
      return qualified;
    }
    if (stmt.kind === "destructure_let") {
      const qualified = withMeta(stmt, {
        ...stmt,
        value: qualifyExpr(stmt.value, alias, names, currentLocals),
      });
      currentLocals = withLocals(currentLocals, stmt.names);
      return qualified;
    }
    if (stmt.kind === "proof_const") {
      return withMeta(stmt, { ...stmt, value: qualifyTypeExpr(stmt.value, alias, names) });
    }
    return stmt;
  });
  return {
    statements,
    expr: block.expr ? qualifyExpr(block.expr, alias, names, currentLocals) : undefined,
  };
}

function qualifyDoBody(
  statements: Extract<Expr, { kind: "do" }>["statements"],
  expr: Expr | undefined,
  alias: string,
  names: Set<string>,
  locals: Set<string>,
): Pick<Extract<Expr, { kind: "do" }>, "statements" | "expr"> {
  let currentLocals = new Set(locals);
  const qualifiedStatements = statements.map((stmt) => {
    if (stmt.kind === "do_bind") {
      const qualified = withMeta(stmt, {
        ...stmt,
        value: qualifyExpr(stmt.value, alias, names, currentLocals),
      });
      currentLocals = withLocal(currentLocals, stmt.name);
      return qualified;
    }
    if (stmt.kind === "do_expr") {
      return withMeta(stmt, {
        ...stmt,
        value: qualifyExpr(stmt.value, alias, names, currentLocals),
      });
    }
    if (stmt.kind === "let") {
      const qualified = withMeta(stmt, {
        ...stmt,
        type: stmt.type ? qualifyTypeSource(stmt.type, alias, names) : undefined,
        value: qualifyExpr(stmt.value, alias, names, currentLocals),
      });
      currentLocals = withLocal(currentLocals, stmt.name);
      return qualified;
    }
    if (stmt.kind === "destructure_let") {
      const qualified = withMeta(stmt, {
        ...stmt,
        value: qualifyExpr(stmt.value, alias, names, currentLocals),
      });
      currentLocals = withLocals(currentLocals, stmt.names);
      return qualified;
    }
    if (stmt.kind === "proof_const") {
      return withMeta(stmt, { ...stmt, value: qualifyTypeExpr(stmt.value, alias, names) });
    }
    return stmt;
  });
  return {
    statements: qualifiedStatements,
    expr: expr ? qualifyExpr(expr, alias, names, currentLocals) : undefined,
  };
}

function qualifyTypeExpr(expr: TypeExpr, alias: string, names: Set<string>): TypeExpr {
  switch (expr.kind) {
    case "type_ref":
      return withMeta(expr, { ...expr, name: qualifyReference(expr.name, alias, names) });
    case "type_hole":
      return expr;
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
    case "type_scalar_domain":
      return withMeta(expr, {
        ...expr,
        members: expr.members.map((member) =>
          withMeta(member, {
            ...member,
            start: member.start.kind === "symbol"
              ? withMeta(member.start, {
                ...member.start,
                source: qualifyReference(member.start.source, alias, names),
              })
              : member.start,
            end: member.end?.kind === "symbol"
              ? withMeta(member.end, {
                ...member.end,
                source: qualifyReference(member.end.source, alias, names),
              })
              : member.end,
          })
        ),
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
  locals: Set<string> = new Set(),
): StaticForSource {
  return source.kind === "range"
    ? withMeta(source, {
      ...source,
      start: qualifyExpr(source.start, alias, names, locals),
      end: qualifyExpr(source.end, alias, names, locals),
    })
    : withMeta(source, { ...source, shape: qualifyExpr(source.shape, alias, names, locals) });
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
  return source.replace(
    /[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)*/g,
    (token, offset: number) => {
      const previous = offset > 0 ? source[offset - 1] : undefined;
      if (previous === "@" || previous === "#") return token;
      if (/^\s*:(?!:)/.test(source.slice(offset + token.length))) return token;
      return qualifyReference(token, alias, names);
    },
  );
}

function qualifyReference(name: string, alias: string, names: Set<string>): string {
  if (name.startsWith("@")) return name;
  for (const candidate of qualifiedReferencePrefixes(name)) {
    if (names.has(candidate)) {
      return `${qualifyName(candidate, alias)}${name.slice(candidate.length)}`;
    }
  }
  return name;
}

function qualifyName(name: string, alias: string): string {
  return `${alias}.${name}`;
}
