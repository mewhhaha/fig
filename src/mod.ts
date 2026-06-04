import { parse, parseFragment } from "./parser.ts";
import {
  type AnalysisCheckResult,
  checkProgram,
  checkProgramForAnalysis,
  type CheckResult,
  type CheckTrace,
  type FunctionCheckCacheEntry,
} from "./check.ts";
import {
  type BackendCache,
  type BackendFunction,
  type BackendFunctionCacheEntry,
  type BackendLayoutCacheEntry,
  type BackendOptions,
  type BackendPlanningCacheEntry,
  emitWasm,
  emitWat,
  type FigAbiManifest,
  type FigDebugTraceSite,
  type FigProfileSite,
  lowerProgramToBackendArtifact,
  wasmFromBackendModule,
  type WasmFunctionCacheEntry,
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
import {
  AST_METADATA_KEYS,
  copyAstMetadata,
  defineAstMetadata,
  hideAstMetadata,
} from "./ast_meta.ts";
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
  prunedImportSelections?: Map<string, Set<string>>;
  linkedModules?: Map<string, LinkedModule>;
  stableLinkedModuleKeys?: Set<string>;
  stableImportClosureKeys?: Set<string>;
  importClosures?: Map<string, ImportClosure>;
  aliasReferenceRoots?: Map<string, Set<string>>;
  importedDeclarationNames?: Map<string, Set<string>>;
  qualifiedLocalImports?: Map<string, Declaration[]>;
  qualifiedDeclarations?: Map<string, Declaration>;
  qualifiedEffectImports?: Map<string, Program["imports"]>;
  moduleInterfaceKeys?: Map<string, string>;
  moduleInterfaceKeysBySourceId?: Map<string, string>;
  stableModuleInterfaces?: Set<string>;
  moduleReferenceKeys?: Map<string, string>;
  moduleReferenceKeysBySourceId?: Map<string, string>;
  referenceSummaries?: Map<string, DeclarationReferenceSummary>;
  referenceSummariesByDeclaration?: WeakMap<object, Map<string, DeclarationReferenceSummary>>;
  parsedBySourceId?: Map<string, ParsedSourceEntry>;
  functionChecks?: Map<string, FunctionCheckCacheEntry>;
  checkedProgramKeys?: Set<string>;
  semanticHashes?: WeakMap<object, string>;
  signatureHashes?: WeakMap<object, string>;
  annotationWork?: WeakMap<object, boolean>;
  doExpressionWork?: WeakMap<object, boolean>;
  builtinOperatorLoweredDeclarations?: WeakSet<object>;
  branchHintCheckedDeclarations?: WeakSet<object>;
  balancedBinaryDeclarations?: WeakSet<object>;
  collectorLoweredDeclarations?: WeakMap<object, string>;
  inferredTypeVars?: WeakMap<object, { key: string; vars: Set<string> }>;
  typeContractChecks?: Set<string>;
  backendLayouts?: Map<string, BackendLayoutCacheEntry>;
  backendLayoutPlans?: Map<string, BackendPlanningCacheEntry>;
  backendBodyCalls?: BackendCache["backendBodyCalls"];
  backendDirectCalls?: BackendCache["backendDirectCalls"];
  backendTailCalls?: BackendCache["backendTailCalls"];
  backendCallCounts?: BackendCache["backendCallCounts"];
  backendNameUses?: BackendCache["backendNameUses"];
  backendInlineCosts?: BackendCache["backendInlineCosts"];
  backendFunctionHashes?: WeakMap<object, string>;
  backendPlanningHashes?: WeakMap<object, string>;
  backendFunctions?: Map<string, BackendFunctionCacheEntry>;
  wasmFunctions?: WeakMap<BackendFunction, WasmFunctionCacheEntry>;
  wasmNameSections?: Map<string, number[]>;
}

export function createCompileCache(): CompileCache {
  return {
    parsedModules: new Map(),
    resolvedModules: new Map(),
    prunedImports: new Map(),
    prunedImportSelections: new Map(),
    linkedModules: new Map(),
    stableLinkedModuleKeys: new Set(),
    importClosures: new Map(),
    aliasReferenceRoots: new Map(),
    importedDeclarationNames: new Map(),
    qualifiedLocalImports: new Map(),
    qualifiedDeclarations: new Map(),
    qualifiedEffectImports: new Map(),
    moduleInterfaceKeys: new Map(),
    moduleInterfaceKeysBySourceId: new Map(),
    stableModuleInterfaces: new Set(),
    moduleReferenceKeys: new Map(),
    moduleReferenceKeysBySourceId: new Map(),
    referenceSummaries: new Map(),
    referenceSummariesByDeclaration: new WeakMap(),
    parsedBySourceId: new Map(),
    functionChecks: new Map(),
    semanticHashes: new WeakMap(),
    signatureHashes: new WeakMap(),
    annotationWork: new WeakMap(),
    doExpressionWork: new WeakMap(),
    builtinOperatorLoweredDeclarations: new WeakSet(),
    branchHintCheckedDeclarations: new WeakSet(),
    balancedBinaryDeclarations: new WeakSet(),
    collectorLoweredDeclarations: new WeakMap(),
    inferredTypeVars: new WeakMap(),
    typeContractChecks: new Set(),
    backendLayouts: new Map(),
    backendLayoutPlans: new Map(),
    backendBodyCalls: new WeakMap(),
    backendDirectCalls: new WeakMap(),
    backendTailCalls: new WeakMap(),
    backendCallCounts: new WeakMap(),
    backendNameUses: new WeakMap(),
    backendInlineCosts: new WeakMap(),
    backendFunctionHashes: new WeakMap(),
    backendPlanningHashes: new WeakMap(),
    backendFunctions: new Map(),
    wasmFunctions: new WeakMap(),
    wasmNameSections: new Map(),
  };
}

export interface LinkedModule {
  program: Program;
  localSourceKey?: string;
  stableImportSurfaceKey?: string;
  localNames: string[];
  supportNames: string[];
  names?: Set<string>;
  namesKey?: string;
  imports: Program["imports"];
}

export interface ImportClosure {
  declarations: Declaration[];
  supportDeclarationCount?: number;
  supportNames: Set<string>;
  publicNames?: Set<string>;
  hasEffectImports?: boolean;
}

export interface DeclarationReferenceSummary {
  names: Set<string>;
}

interface ParsedSourceEntry {
  text: string;
  program: Program;
}

const DECLARATION_SOURCE_ID_CACHE = new WeakMap<Declaration, string | false>();
const COMPILER_SESSION_PARSED_ROOT_CACHE_LIMIT = 32;

export function createCompilerSession(options: CompilerSessionOptions): CompilerSession {
  const cache = options.cache ?? createCompileCache();
  const rootDependencies = new Map<string, Set<string>>();
  const sources = new Map<string, ModuleSource>();
  const artifactCache = new Map<string, CompilerSessionArtifactCacheEntry>();
  const parsedRootCache = new Map<string, Program>();
  const parsedRootBySourceId = new Map<string, ParsedSourceEntry>();
  const parsedRootHashCache = new WeakMap<Program, string>();

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
      cache.parsedBySourceId?.delete(sourceId);
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
        const reuseOptionsKey = compilerSessionArtifactOptionsKey(compileOptions);
        let parsedRoot: Program | undefined;
        let parseMs: number | undefined;
        let artifact: CompileArtifactsResult;
        const reuseCandidate = reuseOptionsKey
          ? await parseCompilerSessionRoot(
            source,
            compileOptions,
            parsedRootCache,
            parsedRootBySourceId,
          )
          : undefined;
        if (reuseCandidate) {
          parsedRoot = reuseCandidate.program;
          parseMs = reuseCandidate.parseMs;
          const rootKey = compilerSessionArtifactRootKey(parsedRoot, parsedRootHashCache);
          const artifactKey = `${source.sourceId}\0${reuseOptionsKey}\0${rootKey}`;
          const cached = artifactCache.get(artifactKey);
          if (
            cached &&
            await compilerSessionArtifactDependenciesCurrent(
              cached,
              sources,
              cache,
            )
          ) {
            rootDependencies.set(
              source.sourceId,
              new Set(cached.dependencies.map((item) => item.sourceId)),
            );
            return {
              ok: true,
              artifact: reuseCompilerSessionArtifact(cached.artifact, parseMs),
              dependencies: cached.dependencies,
              watchedSourceIds: watchedSourceIds(source.sourceId),
              affectedRoots: affected,
            };
          }
          artifact = await compileArtifactsFromSourceImpl(source.text, {
            ...compileOptions,
            parsedRoot,
            parseMs,
          });
          const dependencySources = cachedModuleSources(
            source.sourceId,
            dependencies,
            moduleSources,
            sources,
          );
          const dependencySourceKeys = compilerSessionDependencySourceKeys(dependencySources);
          artifactCache.set(artifactKey, {
            artifact,
            dependencies: dependencies.map((item) => ({ ...item })),
            dependencySourceKeys,
            dependencyTexts: compilerSessionDependencyTexts(dependencySources),
          });
        } else {
          artifact = await compileArtifactsFromSourceImpl(source.text, compileOptions);
        }
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

async function parseCompilerSessionRoot(
  source: ModuleSource & { sourceId: string },
  options: CompileArtifactsOptionsInternal,
  cache: Map<string, Program>,
  bySourceId: Map<string, ParsedSourceEntry>,
): Promise<{ program: Program; parseMs: number }> {
  const cacheKey = moduleSourceCacheKey(source.sourceId, source);
  const cached = cache.get(cacheKey);
  if (cached) return { program: cached, parseMs: 0 };
  const text = moduleSourceText(source);
  const previous = bySourceId.get(source.sourceId);
  if (previous && sourceTrailingTriviaEquivalent(previous.text, text)) {
    cache.set(cacheKey, previous.program);
    return { program: previous.program, parseMs: 0 };
  }
  const parseStart = performance.now();
  const program = await parse(text, { sourceId: options.sourceId });
  cache.set(cacheKey, program);
  bySourceId.set(source.sourceId, { text, program });
  if (cache.size > COMPILER_SESSION_PARSED_ROOT_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  return {
    program,
    parseMs: performance.now() - parseStart,
  };
}

function compilerSessionArtifactOptionsKey(
  options: CompileArtifactsOptionsInternal,
): string | undefined {
  if (options.trace || options.compileTrace || options.plugins?.length) return undefined;
  if (options.profile && typeof options.profile !== "string") return undefined;
  return JSON.stringify({
    includeWat: options.includeWat !== false,
    pruneImports: options.pruneImports === true,
    optMode: options.optMode ?? "debug",
    profile: options.profile,
    memoryModel: options.memoryModel ?? "branch",
    tailCallMode: options.tailCallMode,
    runtimeProfile: options.runtimeProfile === true,
    branchHints: options.branchHints,
    assumeRewrites: options.assumeRewrites === true,
  });
}

function compilerSessionArtifactRootKey(
  program: Program,
  cache?: WeakMap<Program, string>,
): string {
  const cached = cache?.get(program);
  if (cached) return cached;
  const key = stableAstHashWithMetadata(program);
  cache?.set(program, key);
  return key;
}

function cachedModuleSources(
  rootSourceId: string,
  dependencies: readonly ModuleDependency[],
  moduleSources: Map<string, ModuleSource>,
  sources: Map<string, ModuleSource>,
): Map<string, ModuleSource> {
  const result = new Map<string, ModuleSource>();
  for (const dependency of dependencies) {
    const source = moduleSources.get(dependency.sourceId) ?? sources.get(dependency.sourceId);
    if (source) result.set(dependency.sourceId, source);
  }
  result.delete(rootSourceId);
  return result;
}

function compilerSessionDependencySourceKeys(
  sources: Map<string, ModuleSource>,
): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [sourceId, source] of sources) {
    keys.set(sourceId, moduleSourceCacheKey(sourceId, source));
  }
  return keys;
}

function compilerSessionDependencyTexts(
  sources: Map<string, ModuleSource>,
): Map<string, string> {
  const texts = new Map<string, string>();
  for (const [sourceId, source] of sources) texts.set(sourceId, moduleSourceText(source));
  return texts;
}

function compilerSessionArtifactDependenciesCurrent(
  entry: CompilerSessionArtifactCacheEntry,
  sources: Map<string, ModuleSource>,
  compileCache?: CompileCache,
): boolean {
  for (const [sourceId, key] of entry.dependencySourceKeys) {
    const source = sources.get(sourceId);
    if (!source) return false;
    if (moduleSourceCacheKey(sourceId, source) === key) continue;
    const previousText = entry.dependencyTexts.get(sourceId);
    if (previousText && isTrailingTriviaOnlyAppend(previousText, moduleSourceText(source))) {
      continue;
    }
    if (previousText && sourceTrailingTriviaEquivalent(previousText, moduleSourceText(source))) {
      continue;
    }
    compileCache?.parsedModules.delete(`parsed\0${key}`);
    return false;
  }
  return true;
}

function reuseCompilerSessionArtifact(
  artifact: CompileArtifactsResult,
  parseMs: number,
): CompileArtifactsResult {
  return {
    ...artifact,
    timings: {
      parseMs,
      importMs: 0,
      checkMs: 0,
      backendMs: 0,
      optimizeMs: 0,
      backendLayoutMs: 0,
      backendLowerMs: 0,
      backendCleanupMs: 0,
      watRenderMs: 0,
      wasmEncodeMs: 0,
      watMs: 0,
      wasmMs: 0,
    },
    trace: undefined,
    importTrace: undefined,
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
  parsedRoot?: Program;
  parseMs?: number;
}

interface CompilerSessionArtifactCacheEntry {
  artifact: CompileArtifactsResult;
  dependencies: ModuleDependency[];
  dependencySourceKeys: Map<string, string>;
  dependencyTexts: Map<string, string>;
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
  let parsed = options.parsedRoot;
  let parseMs = options.parseMs;
  if (!parsed) {
    const parseStart = performance.now();
    parsed = await parse(source, {
      sourceId: options.sourceId,
      trace,
    });
    parseMs = performance.now() - parseStart;
  }
  parseMs ??= 0;

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
  recordCheckedProgramCandidate(program, options);
  const checked = checkProgram(program, checkOptions(options));
  const checkMs = performance.now() - checkStart;

  const backendStart = performance.now();
  const loweredBackend = lowerProgramToBackendArtifact(checked.program, {
    ...options,
    compileTrace: trace,
    backendCache: options.cache,
    reuseCachedBackendFunctions: true,
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
    cache: options.cache,
    trace,
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

function recordCheckedProgramCandidate(
  program: Program,
  options: CompileArtifactsOptionsInternal,
) {
  const checkedProgramKeys = options.cache?.checkedProgramKeys;
  if (!checkedProgramKeys || options.plugins?.length) return;
  const key = checkedProgramCandidateKey(program, options);
  checkedProgramKeys.has(key);
  checkedProgramKeys.add(key);
}

function checkedProgramCandidateKey(
  program: Program,
  options: CompileArtifactsOptionsInternal,
): string {
  return `checked_program\0${options.assumeRewrites === true ? "assume" : "default"}\0${
    moduleInterfaceKey(program)
  }\0${moduleReferenceKey(program)}`;
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
  type CompilerRewriteRule,
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
  const resolvedSources = new Map<string, {
    source: string | ModuleSource;
    sourceId: string;
    normalized: ModuleSource;
  }>();
  const sharedCache = options.cache;
  const pruneSourceKeys = new WeakMap<Program, string>();
  const linkedSurfaces = new WeakMap<Program, LinkedModule>();
  const linkedPrograms = new WeakMap<Program, Program>();
  const rootSourceId = options.moduleGraph?.rootSourceId ?? options.sourceId ??
    programSourceId(root);

  async function load(
    moduleName: string,
    requestedAt?: SourceImport,
    importer: Program = root,
  ): Promise<Program | undefined> {
    const importerSourceId = programSourceId(importer) ?? rootSourceId ?? "<root>";
    const resolutionKey = `${importerSourceId}\0${moduleName}`;
    let resolvedSource = resolvedSources.get(resolutionKey);
    if (!resolvedSource) {
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
      resolvedSource = {
        source,
        sourceId: moduleSourceId(moduleName, source),
        normalized: normalizedModuleSource(moduleName, source),
      };
      resolvedSources.set(resolutionKey, resolvedSource);
    } else {
      recordImportPhase(options.importTrace, {
        name: "import.resolve.root",
        ms: 0,
        moduleName,
        cacheHit: true,
      });
    }
    const { source, sourceId } = resolvedSource;
    options.moduleGraph?.dependencies.push({ importerSourceId, moduleName, sourceId });
    options.moduleGraph?.moduleSources?.set(sourceId, resolvedSource.normalized);
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
    const parsed = cachedParsed ?? await traceImportPhase(
      options.importTrace,
      "import.parse.module",
      { moduleName },
      () =>
        parseModuleSource(
          source,
          moduleName,
          sharedCache?.parsedBySourceId?.get(sourceId),
        ),
      importProgramCounters,
    );
    if (cachedParsed) {
      recordImportCacheHit(options.importTrace, "import.parse.module", moduleName, parsed);
    }
    if (!cachedParsed) sharedCache?.parsedModules.set(parsedCacheKey, parsed);
    let interfaceKey = sharedCache?.moduleInterfaceKeys?.get(sourceKey);
    if (!interfaceKey) {
      interfaceKey = moduleInterfaceKey(parsed);
      sharedCache?.moduleInterfaceKeys?.set(sourceKey, interfaceKey);
    }
    if (interfaceKey) {
      sharedCache?.moduleInterfaceKeysBySourceId?.get(sourceId);
      sharedCache?.moduleInterfaceKeysBySourceId?.set(sourceId, interfaceKey);
      const stableInterfaceKey = moduleStableInterfaceCacheKey(sourceId, interfaceKey);
      sharedCache?.stableModuleInterfaces?.has(stableInterfaceKey);
      sharedCache?.stableModuleInterfaces?.add(stableInterfaceKey);
    }
    let referenceKey = sharedCache?.moduleReferenceKeys?.get(sourceKey);
    if (!referenceKey) {
      referenceKey = moduleReferenceKey(parsed);
      sharedCache?.moduleReferenceKeys?.set(sourceKey, referenceKey);
    }
    sharedCache?.moduleReferenceKeysBySourceId?.set(sourceId, referenceKey);
    if (!cachedParsed) {
      sharedCache?.parsedBySourceId?.set(sourceId, {
        text: moduleSourceText(source),
        program: parsed,
      });
    }
    const resolvedCacheKey = resolvedModuleCacheKey(sourceKey, options.pruneImports === true);
    const cachedResolved = parsed.sourceImports?.length
      ? undefined
      : sharedCache?.resolvedModules.get(resolvedCacheKey);
    if (cachedResolved) {
      resolved.set(sourceId, cachedResolved);
      pruneSourceKeys.set(cachedResolved, resolvedCacheKey);
      visiting.pop();
      recordImportCacheHit(options.importTrace, "import.merge.module", moduleName, cachedResolved);
      return cachedResolved;
    }
    const merged = await traceImportPhase(
      options.importTrace,
      "import.merge.module",
      { moduleName, ...importProgramCountersIfTrace(options.importTrace, parsed) },
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

  function materializeLoadedProgram(program: Program): Program {
    const linkedProgram = linkedPrograms.get(program);
    if (!linkedProgram) return program;
    const cloned = cloneProgram(linkedProgram);
    const sourceKey = pruneSourceKeys.get(program);
    if (sourceKey) pruneSourceKeys.set(cloned, sourceKey);
    return cloned;
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
    const stableDependencyKeys: string[] = [];
    const aliases = new Set<string>();
    const reservedNames = declarationPrimaryNameSet(program.declarations);
    let hiddenImportIndex = 0;
    for (const item of program.sourceImports ?? []) {
      if (item.alias) {
        const aliasConflicts = aliases.has(item.alias) || reservedNames.has(item.alias);
        if (aliasConflicts) {
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
      const stableDependencyKey = stableLinkedDependencyKey(imported, sharedCache);
      if (stableDependencyKey) stableDependencyKeys.push(stableDependencyKey);
      if (item.alias) aliasedImports.push({ alias: item.alias, program: imported });
      else if (item.bindings) {
        const materialized = materializeLoadedProgram(imported);
        const alias = nextHiddenImportAlias(reservedNames, hiddenImportIndex++);
        reservedNames.add(alias);
        for (const decl of materialized.declarations) {
          if (decl.kind === "type_assert") continue;
          reservedNames.add(qualifyName(declarationName(decl), alias));
        }
        destructuredImports.push({
          alias,
          sourceImport: item,
          program: materialized,
        });
      } else importedPrograms.push(materializeLoadedProgram(imported));
    }
    const linkedCacheKey = currentSourceKey
      ? linkedModuleCacheKey(currentSourceKey, options.pruneImports === true, dependencyKeys)
      : undefined;
    const stableLinkedCacheKey = currentSourceKey &&
        stableDependencyKeys.length === dependencyKeys.length
      ? stableLinkedModuleCacheKey(
        currentSourceKey,
        options.pruneImports === true,
        stableDependencyKeys,
      )
      : undefined;
    const stableModuleSourceId = programSourceId(program) ?? currentModuleName;
    let stableImportSurfaceKey: string | undefined;
    if (stableModuleSourceId && stableDependencyKeys.length === dependencyKeys.length) {
      const interfaceKey = sharedCache?.moduleInterfaceKeysBySourceId?.get(stableModuleSourceId);
      const referenceKey = sharedCache?.moduleReferenceKeysBySourceId?.get(stableModuleSourceId);
      if (interfaceKey && referenceKey) {
        stableImportSurfaceKey = stableImportSurfaceCacheKey(
          stableModuleSourceId,
          interfaceKey,
          referenceKey,
          options.pruneImports === true,
          stableDependencyKeys,
        );
      }
    }
    const stableLinkedCacheHit = stableLinkedCacheKey
      ? sharedCache?.stableLinkedModuleKeys?.has(stableLinkedCacheKey) ?? false
      : false;
    if (stableLinkedCacheKey && options.importTrace) {
      recordImportPhase(options.importTrace, {
        name: "import.link.stable_key",
        ms: 0,
        moduleName: currentModuleName ?? program.moduleName,
        cacheHit: stableLinkedCacheHit,
        declarationCount: dependencyKeys.length,
        keptDeclarationCount: stableDependencyKeys.length,
      });
    }
    const cachedLinked = linkedCacheKey
      ? sharedCache?.linkedModules?.get(linkedCacheKey)
      : undefined;
    if (cachedLinked) {
      const linkedProgram: Program = {
        moduleName: cachedLinked.program.moduleName ?? currentModuleName ?? program.moduleName,
        imports: cloneAstValue(cachedLinked.imports) as Program["imports"],
        sourceImports: [],
        declarations: [],
      };
      pruneSourceKeys.set(linkedProgram, linkedCacheKey!);
      linkedSurfaces.set(linkedProgram, cachedLinked);
      linkedPrograms.set(linkedProgram, cachedLinked.program);
      recordImportCacheHit(
        options.importTrace,
        "import.link.module",
        currentModuleName ?? program.moduleName ?? "",
        linkedProgram,
      );
      return linkedProgram;
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
        prunedImportSelections: sharedCache?.prunedImportSelections,
        importClosures: sharedCache?.importClosures,
        stableImportClosureKeys: sharedCache?.stableImportClosureKeys,
        aliasReferenceRoots: sharedCache?.aliasReferenceRoots,
        importedDeclarationNames: sharedCache?.importedDeclarationNames,
        qualifiedEffectImports: sharedCache?.qualifiedEffectImports,
        qualifiedLocalImports: sharedCache?.qualifiedLocalImports,
        qualifiedDeclarations: sharedCache?.qualifiedDeclarations,
        referenceSummaries: sharedCache?.referenceSummaries,
        referenceSummariesByDeclaration: sharedCache?.referenceSummariesByDeclaration,
        moduleInterfaceKeysBySourceId: sharedCache?.moduleInterfaceKeysBySourceId,
        moduleReferenceKeysBySourceId: sharedCache?.moduleReferenceKeysBySourceId,
        semanticHashes: sharedCache?.semanticHashes,
        localSourceKey: currentSourceKey,
        sourceKey: (program) => pruneSourceKeys.get(program),
        sourceText: (sourceId) => sharedCache?.parsedBySourceId?.get(sourceId)?.text,
        linkedSurface: (program) => linkedSurfaces.get(program),
        materializeLinkedProgram: materializeLoadedProgram,
      },
    );
    if (linkedCacheKey) {
      pruneSourceKeys.set(merged, linkedCacheKey);
      if (diagnostics.length === diagnosticCount) {
        const { localDecls, transitiveDecls } = splitModuleLocalDeclarations(merged);
        const surface = {
          program: merged,
          localSourceKey: currentSourceKey,
          stableImportSurfaceKey,
          localNames: collectDeclarationNameArray(localDecls),
          supportNames: collectDeclarationNameArray(transitiveDecls),
          imports: merged.imports,
        };
        sharedCache?.linkedModules?.set(linkedCacheKey, surface);
        if (stableLinkedCacheKey) sharedCache?.stableLinkedModuleKeys?.add(stableLinkedCacheKey);
        linkedSurfaces.set(merged, surface);
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
    prunedImportSelections?: Map<string, Set<string>>;
    importClosures?: Map<string, ImportClosure>;
    stableImportClosureKeys?: Set<string>;
    aliasReferenceRoots?: Map<string, Set<string>>;
    importedDeclarationNames?: Map<string, Set<string>>;
    qualifiedEffectImports?: Map<string, Program["imports"]>;
    qualifiedLocalImports?: Map<string, Declaration[]>;
    qualifiedDeclarations?: Map<string, Declaration>;
    referenceSummaries?: Map<string, DeclarationReferenceSummary>;
    referenceSummariesByDeclaration?: WeakMap<object, Map<string, DeclarationReferenceSummary>>;
    moduleInterfaceKeysBySourceId?: Map<string, string>;
    moduleReferenceKeysBySourceId?: Map<string, string>;
    semanticHashes?: WeakMap<object, string>;
    localSourceKey?: string;
    sourceKey(program: Program): string | undefined;
    sourceText?(sourceId: string): string | undefined;
    linkedSurface?(program: Program): LinkedModule | undefined;
    materializeLinkedProgram?(program: Program): Program;
  },
): Program {
  const importedDecls: Declaration[] = [];
  for (const importedProgram of imports) {
    for (const decl of importedProgram.declarations) {
      if (decl.kind === "type_assert") continue;
      importedDecls.push(markImportedDeclaration(decl));
    }
  }
  const seenAliasedImportIdentities = new Map<string, Set<string>>();
  const seenAliasedImportIdentityFallbacks = new Map<string, Declaration[]>();
  const keepAliasedImportDeclaration = (decl: Declaration): boolean => {
    const name = declarationName(decl);
    const identity = importedDeclarationIdentityKey(decl);
    if (identity) {
      const identities = seenAliasedImportIdentities.get(name);
      if (identities?.has(identity)) return false;
      if (identities) identities.add(identity);
      else seenAliasedImportIdentities.set(name, new Set([identity]));
      return true;
    }
    const previous = seenAliasedImportIdentityFallbacks.get(name);
    if (previous?.some((item) => sameImportedDeclarationIdentity(item, decl))) return false;
    if (previous) previous.push(decl);
    else seenAliasedImportIdentityFallbacks.set(name, [decl]);
    return true;
  };
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
        const importedNames = importedDeclarationNames(importedProgram, cache);
        const surface = cache?.linkedSurface?.(importedProgram);
        const importedNamesKey = surface ? linkedModuleNamesKey(surface) : undefined;
        const sourceKey = cache?.sourceKey(importedProgram);
        const roots = options.pruneImports
          ? traceImportPhaseSync(
            options.importTrace,
            "import.prune.alias_roots",
            {
              moduleName: importedProgram.moduleName,
              declarationCount: importedProgram.declarations.length,
            },
            () =>
              cachedAliasReferenceRootsFromNames(
                importedNames,
                program.declarations,
                alias,
                cache?.aliasReferenceRoots,
                cache?.localSourceKey,
                importedNamesKey,
              ),
            (result) => ({ referenceCount: result.size }),
          )
          : importedNames;
        const closureCacheKey = sourceKey
          ? importClosureCacheKey(sourceKey, alias, roots, options.pruneImports)
          : undefined;
        const stableClosureKey = surface?.stableImportSurfaceKey
          ? stableImportClosureCacheKey(
            surface.stableImportSurfaceKey,
            alias,
            roots,
            options.pruneImports,
          )
          : undefined;
        if (stableClosureKey && cache?.stableImportClosureKeys) {
          cache.stableImportClosureKeys.has(stableClosureKey);
          cache.stableImportClosureKeys.add(stableClosureKey);
        }
        const cached = closureCacheKey ? cache?.importClosures?.get(closureCacheKey) : undefined;
        if (cached) {
          const declarations = filteredCachedImportClosureDeclarations(
            cached,
            keepAliasedImportDeclaration,
          );
          recordImportPhase(options.importTrace, {
            name: "import.closure.cache",
            ms: 0,
            cacheHit: true,
            declarationCount: declarations.length,
            referenceCount: cached.supportNames.size,
          });
          return {
            declarations,
            supportNames: cached.supportNames,
            publicNames: cached.publicNames ?? new Set(),
            prePruned: options.pruneImports && cached.hasEffectImports !== true,
          };
        }
        const fullImportedProgram = cache?.materializeLinkedProgram?.(importedProgram) ??
          importedProgram;
        const prunedProgram = options.pruneImports
          ? pruneImportedProgram(
            fullImportedProgram,
            roots,
            options.importTrace,
            cache,
          )
          : fullImportedProgram;
        const { localDecls, transitiveDecls } = splitModuleLocalDeclarations(prunedProgram);
        const namedLocalDecls = localDecls.filter((decl) => decl.kind !== "type_assert");
        const namedTransitiveDecls = transitiveDecls.filter((decl) => decl.kind !== "type_assert");
        const localNames = collectDeclarationNameSet(namedLocalDecls);
        const supportNames = collectDeclarationNameSet(namedTransitiveDecls);
        const publicNames = qualifyNameSet(localNames, alias);
        const declarations: Declaration[] = [];
        const cachedDeclarations: Declaration[] | undefined = closureCacheKey ? [] : undefined;
        for (const decl of namedTransitiveDecls) {
          const importedDecl = markImportedDeclaration(decl);
          cachedDeclarations?.push(importedDecl);
          if (keepAliasedImportDeclaration(importedDecl)) {
            declarations.push(importedDecl);
          }
        }
        if (prunedProgram.imports.length) {
          const effectImports = qualifyEffectImportsAsDeclarations(
            prunedProgram.imports,
            alias,
            localNames,
          );
          for (const decl of effectImports) {
            declarations.push(decl);
            cachedDeclarations?.push(decl);
          }
        }
        const qualifiedLocalDecls = cachedQualifiedLocalDeclarations(
          namedLocalDecls,
          alias,
          localNames,
          surface?.localSourceKey ?? sourceKey,
          cache?.qualifiedLocalImports,
          cache?.qualifiedDeclarations,
          cache?.semanticHashes,
        );
        for (const decl of qualifiedLocalDecls) {
          declarations.push(decl);
          cachedDeclarations?.push(decl);
        }
        if (closureCacheKey) {
          cache?.importClosures?.set(closureCacheKey, {
            declarations: cachedDeclarations ?? declarations,
            supportDeclarationCount: namedTransitiveDecls.length,
            supportNames,
            publicNames,
            hasEffectImports: prunedProgram.imports.length > 0,
          });
        }
        return {
          declarations,
          supportNames,
          publicNames,
          prePruned: options.pruneImports && prunedProgram.imports.length === 0,
        };
      }),
    (surfaces) => ({
      keptDeclarationCount: surfaces.reduce((sum, item) => sum + item.declarations.length, 0),
      referenceCount: surfaces.reduce((sum, item) => sum + item.supportNames.size, 0),
    }),
  );
  const aliasedDecls: Declaration[] = [];
  for (const surface of aliasedSurfaces) {
    for (const decl of surface.declarations) {
      aliasedDecls.push(decl);
    }
  }
  const destructuredDecls = traceImportPhaseSync(
    options.importTrace,
    "import.destructure.imports",
    {
      declarationCount: destructuredImports.reduce(
        (sum, item) => sum + item.program.declarations.length,
        0,
      ),
    },
    () => {
      const declarations: Declaration[] = [];
      for (const item of destructuredImports) {
        const itemDeclarations = destructureImportedDeclarations(
          item.sourceImport,
          item.program,
          item.alias,
          diagnostics,
          options.pruneImports,
          options.importTrace,
          cache,
        );
        for (const decl of itemDeclarations) {
          declarations.push(decl);
        }
      }
      return declarations;
    },
  );
  if (options.enforceTransitiveSupportDiagnostics) {
    const transitiveSupportNames = new Set<string>();
    for (const surface of aliasedSurfaces) {
      for (const supportName of surface.supportNames) {
        transitiveSupportNames.add(supportName);
      }
    }
    for (const surface of aliasedSurfaces) {
      for (const publicName of surface.publicNames) {
        transitiveSupportNames.delete(publicName);
      }
    }
    checkTransitiveSupportReferences(
      program.declarations,
      transitiveSupportNames,
      diagnostics,
    );
  }
  const localNames = declarationPrimaryNameSet(program.declarations);
  let allAliasedImportsPrePruned = options.pruneImports &&
    imports.length === 0 &&
    destructuredImports.length === 0;
  for (const surface of aliasedSurfaces) {
    if (!surface.prePruned) {
      allAliasedImportsPrePruned = false;
      break;
    }
  }
  const seenImported = new Map<string, Declaration>();
  const declarations: Declaration[] = [];
  const appendImportDeclaration = (decl: Declaration): void => {
    const name = declarationName(decl);
    if (localNames.has(name)) {
      diagnostics.push({
        code: "module.duplicate_import",
        message: `imported declaration ${name} conflicts with another declaration`,
        span: decl.nameSpan ?? decl.span,
      });
      return;
    }
    const previous = seenImported.get(name);
    if (previous && sameImportedDeclarationIdentity(previous, decl)) {
      return;
    }
    if (previous && !importedDeclarationsCanShareName(previous, decl)) {
      diagnostics.push({
        code: "module.duplicate_import",
        message: `imported declaration ${name} conflicts with another declaration`,
        span: decl.nameSpan ?? decl.span,
      });
      return;
    }
    if (!previous) seenImported.set(name, decl);
    declarations.push(decl);
  };
  for (const decl of importedDecls) {
    appendImportDeclaration(decl);
  }
  for (const decl of aliasedDecls) {
    appendImportDeclaration(decl);
  }
  for (const decl of destructuredDecls) {
    appendImportDeclaration(decl);
  }
  for (const decl of program.declarations) {
    declarations.push(markRootDeclaration(decl));
  }
  const slicedDeclarations = options.pruneImports && !allAliasedImportsPrePruned
    ? pruneUnusedImportedDeclarations(
      declarations,
      localNames,
      options.importTrace,
      cache?.referenceSummaries,
      cache?.referenceSummariesByDeclaration,
      cache?.semanticHashes,
      cache?.sourceText,
      cache?.sourceKey(program) ? `program_prune\0${cache.sourceKey(program)}` : undefined,
    )
    : declarations;
  const mergedImports: Program["imports"] = [];
  for (const importedProgram of imports) {
    for (const item of importedProgram.imports) {
      mergedImports.push(item);
    }
  }
  for (const item of aliasedImports) {
    if (!item.program.imports.length) {
      continue;
    }
    const names = importedDeclarationNames(item.program, cache);
    const effectImports = cachedQualifiedEffectImportTypes(
      item.program.imports,
      item.alias,
      names,
      cache?.sourceKey(item.program),
      cache?.qualifiedEffectImports,
    );
    for (const effectImport of effectImports) {
      mergedImports.push(effectImport);
    }
  }
  for (const item of destructuredImports) {
    if (!item.program.imports.length) {
      continue;
    }
    const effectImports = cachedQualifiedEffectImportTypes(
      item.program.imports,
      item.alias,
      collectDeclarationNameSet(item.program.declarations),
      cache?.sourceKey(item.program),
      cache?.qualifiedEffectImports,
    );
    for (const effectImport of effectImports) {
      mergedImports.push(effectImport);
    }
  }
  for (const item of program.imports) {
    mergedImports.push(item);
  }
  return copyAstMetadata({
    moduleName: program.moduleName,
    imports: mergedImports,
    sourceImports: [],
    declarations: slicedDeclarations,
  }, program);
}

function filteredCachedImportClosureDeclarations(
  closure: ImportClosure,
  keepSupportDeclaration: (decl: Declaration) => boolean,
): Declaration[] {
  const supportDeclarationCount = closure.supportDeclarationCount;
  if (supportDeclarationCount === undefined) {
    return closure.declarations.filter(keepSupportDeclaration);
  }
  return filterImportClosureDeclarations(
    closure.declarations,
    supportDeclarationCount,
    keepSupportDeclaration,
  );
}

function filterImportClosureDeclarations(
  declarations: Declaration[],
  supportDeclarationCount: number,
  keepSupportDeclaration: (decl: Declaration) => boolean,
): Declaration[] {
  if (supportDeclarationCount <= 0) return declarations;
  const filtered: Declaration[] = [];
  for (let index = 0; index < supportDeclarationCount; index++) {
    const decl = declarations[index];
    if (decl && keepSupportDeclaration(decl)) filtered.push(decl);
  }
  for (let index = supportDeclarationCount; index < declarations.length; index++) {
    const decl = declarations[index];
    if (decl) filtered.push(decl);
  }
  return filtered;
}

function pruneImportedProgram(
  importedProgram: Program,
  roots: Set<string>,
  importTrace?: ImportTraceState,
  cache?: {
    prunedImports?: Map<string, Program>;
    prunedImportSelections?: Map<string, Set<string>>;
    referenceSummaries?: Map<string, DeclarationReferenceSummary>;
    referenceSummariesByDeclaration?: WeakMap<object, Map<string, DeclarationReferenceSummary>>;
    moduleInterfaceKeysBySourceId?: Map<string, string>;
    moduleReferenceKeysBySourceId?: Map<string, string>;
    semanticHashes?: WeakMap<object, string>;
    sourceKey(program: Program): string | undefined;
    sourceText?: (sourceId: string) => string | undefined;
  },
): Program {
  if (!roots.size) return { ...importedProgram, declarations: [] };
  const sourceKey = cache?.sourceKey(importedProgram);
  const cacheKey = sourceKey ? prunedImportCacheKey(sourceKey, roots) : undefined;
  const cached = cacheKey ? cache?.prunedImports?.get(cacheKey) : undefined;
  if (cached) {
    recordImportCacheHit(
      importTrace,
      "import.prune.finish",
      importedProgram.moduleName ?? "",
      cached,
    );
    return cached;
  }
  const sourceId = importedProgram.moduleName;
  let interfaceKey: string | undefined;
  let referenceKey: string | undefined;
  let selectionKey: string | undefined;
  let cachedSelection: Set<string> | undefined;
  if (sourceId) {
    interfaceKey = cache?.moduleInterfaceKeysBySourceId?.get(sourceId);
    referenceKey = cache?.moduleReferenceKeysBySourceId?.get(sourceId);
  }
  if (sourceId && interfaceKey && referenceKey) {
    selectionKey = prunedImportSelectionCacheKey(sourceId, interfaceKey, referenceKey, roots);
    cachedSelection = cache?.prunedImportSelections?.get(selectionKey);
  }
  if (cachedSelection) {
    const declarations = filterDeclarationsByPrimaryNames(
      importedProgram.declarations,
      cachedSelection,
    );
    const pruned = { ...importedProgram, declarations };
    if (cacheKey) cache?.prunedImports?.set(cacheKey, pruned);
    recordImportPhase(importTrace, {
      name: "import.prune.selection_cache",
      ms: 0,
      cacheHit: true,
      moduleName: importedProgram.moduleName,
      declarationCount: importedProgram.declarations.length,
      keptDeclarationCount: declarations.length,
    });
    return pruned;
  }
  const declarations = pruneUnusedImportedDeclarations(
    importedProgram.declarations,
    roots,
    importTrace,
    cache?.referenceSummaries,
    cache?.referenceSummariesByDeclaration,
    cache?.semanticHashes,
    cache?.sourceText,
    cacheKey,
  );
  const pruned = { ...importedProgram, declarations };
  if (selectionKey) {
    cache?.prunedImportSelections?.set(selectionKey, declarationPrimaryNameSet(declarations));
  }
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

function filterDeclarationsByPrimaryNames(
  declarations: Declaration[],
  names: Set<string>,
): Declaration[] {
  const kept: Declaration[] = [];
  for (const decl of declarations) {
    if (names.has(declarationName(decl))) kept.push(decl);
  }
  return kept;
}

function declarationAttachedMemberName(decl: Declaration): string | undefined {
  if (decl.kind === "fn" && decl.memberOf) return decl.memberOf.member;
  if (decl.kind === "type_assert") return undefined;
  const index = decl.name.lastIndexOf("::");
  if (index < 0) return undefined;
  return decl.name.slice(index + 2);
}

function attachedMemberReferenceName(name: string): string | undefined {
  const index = name.lastIndexOf("::");
  if (index < 0) return undefined;
  const member = name.slice(index + 2);
  if (!member) return undefined;
  return `member:${member}`;
}

function referencedAttachedMemberName(name: string): string | undefined {
  if (!name.startsWith("member:")) return undefined;
  const member = name.slice("member:".length);
  if (!member) return undefined;
  return member;
}

function typeMemberRequirementReference(expr: TypeExpr): string | undefined {
  if (expr.kind !== "type_call") return undefined;
  if (expr.callee.kind !== "type_static_ref") return undefined;
  const name = expr.callee.name;
  const checksMember = name === "type_has_member" || name === "type_member_type" ||
    name === "type_member_target";
  if (!checksMember) return undefined;
  const member = expr.args[1];
  if (!member || member.kind !== "type_literal") return undefined;
  if (typeof member.value !== "string") return undefined;
  if (!member.value) return undefined;
  return `member:${member.value}`;
}

function declarationSourceId(decl: Declaration): string | undefined {
  const cached = DECLARATION_SOURCE_ID_CACHE.get(decl);
  if (cached !== undefined) return cached || undefined;
  let sourceId: string | undefined;
  if (decl.span?.sourceId) {
    sourceId = decl.span.sourceId;
  } else if (decl.nameSpan?.sourceId) {
    sourceId = decl.nameSpan.sourceId;
  } else if (decl.kind === "type") {
    for (const clause of decl.clauses ?? []) {
      sourceId = declarationSourceId(clause);
      if (sourceId) break;
    }
  }
  DECLARATION_SOURCE_ID_CACHE.set(decl, sourceId ?? false);
  return sourceId;
}

function aliasReferenceRoots(
  importedDeclarations: Declaration[],
  localDeclarations: Declaration[],
  alias: string,
): Set<string> {
  return aliasReferenceRootsFromNames(
    collectDeclarationNameSet(importedDeclarations),
    localDeclarations,
    alias,
  );
}

function cachedAliasReferenceRootsFromNames(
  importedNames: Set<string>,
  localDeclarations: Declaration[],
  alias: string,
  cache?: Map<string, Set<string>>,
  localSourceKey?: string,
  importedNamesKey?: string,
): Set<string> {
  const cacheKey = cache
    ? aliasReferenceRootsCacheKey(
      importedNames,
      localDeclarations,
      alias,
      localSourceKey,
      importedNamesKey,
    )
    : undefined;
  const cached = cacheKey ? cache?.get(cacheKey) : undefined;
  if (cached) return cached;
  const roots = aliasReferenceRootsFromNames(importedNames, localDeclarations, alias);
  if (cacheKey) cache?.set(cacheKey, roots);
  return roots;
}

function aliasReferenceRootsFromNames(
  importedNames: Set<string>,
  localDeclarations: Declaration[],
  alias: string,
): Set<string> {
  const roots = new Set<string>();
  const aliasNameIndex: DeclarationNameIndex = {
    names: new Set(),
    firstSegments: new Set([alias]),
    key: alias,
  };
  const add = (name: string | undefined) => {
    addAliasReferenceRoot(name, importedNames, alias, roots);
  };
  const addTypeSource = (source: string | undefined) => {
    if (!source) return;
    for (const token of typeSourceReferenceTokens(source, aliasNameIndex)) add(token);
  };
  for (const decl of localDeclarations) {
    visitDeclarationReferenceNames(decl, add, addTypeSource);
  }
  return roots;
}

function addAliasReferenceRoot(
  name: string | undefined,
  importedNames: Set<string>,
  alias: string,
  roots: Set<string>,
) {
  if (!name || name.startsWith("@")) return;
  if (name.startsWith("operator:")) {
    if (importedNames.has(name)) roots.add(name);
    return;
  }
  if (hasQualifiedSeparator(name) && importedNames.has(name)) {
    roots.add(name);
    return;
  }
  const prefix = `${alias}.`;
  if (!name.startsWith(prefix)) return;
  const unqualified = name.slice(prefix.length);
  if (!unqualified) return;
  if (importedNames.has(unqualified)) {
    roots.add(unqualified);
    return;
  }
  if (!hasQualifiedSeparator(unqualified)) return;
  const candidate = longestQualifiedPrefixInSet(unqualified, importedNames);
  if (candidate) roots.add(candidate);
}

function importedDeclarationNames(
  program: Program,
  cache?: {
    importedDeclarationNames?: Map<string, Set<string>>;
    sourceKey?(program: Program): string | undefined;
    linkedSurface?(program: Program): LinkedModule | undefined;
  },
): Set<string> {
  const sourceKey = cache?.sourceKey?.(program);
  const cached = sourceKey ? cache?.importedDeclarationNames?.get(sourceKey) : undefined;
  if (cached) return cached;
  const surface = cache?.linkedSurface?.(program);
  if (surface) {
    const names = linkedModuleNameSet(surface);
    if (sourceKey) cache?.importedDeclarationNames?.set(sourceKey, names);
    return names;
  }
  const names = collectDeclarationNameSet(program.declarations);
  if (sourceKey) cache?.importedDeclarationNames?.set(sourceKey, names);
  return names;
}

function linkedModuleNameSet(surface: LinkedModule): Set<string> {
  if (surface.names) return surface.names;
  const names = new Set<string>();
  for (const name of surface.localNames) {
    names.add(name);
  }
  for (const name of surface.supportNames) {
    names.add(name);
  }
  surface.names = names;
  return names;
}

function linkedModuleNamesKey(surface: LinkedModule): string {
  if (surface.namesKey) return surface.namesKey;
  const names = linkedModuleNameSet(surface);
  const key = `names:${declarationNamesKey(names)}`;
  surface.namesKey = key;
  return key;
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
      if (ref.startsWith("operator:")) continue;
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
  referenceSummariesByDeclaration?: WeakMap<object, Map<string, DeclarationReferenceSummary>>,
  semanticHashes?: WeakMap<object, string>,
  sourceText?: (sourceId: string) => string | undefined,
  referenceSummaryKey?: string,
): Declaration[] {
  const { byName, ownerByName, ownersByMember, nameIndex } = traceImportPhaseSync(
    importTrace,
    "import.prune.collect_names",
    { declarationCount: declarations.length },
    () => {
      const byName = new Map<string, Array<Declaration & { name: string }>>();
      const ownerByName = new Map<string, string>();
      const ownersByMember = new Map<string, Set<string>>();
      const declarationNames = new Set<string>();
      for (const decl of declarations) {
        if (decl.kind === "type_assert") continue;
        const group = byName.get(decl.name) ?? [];
        group.push(decl);
        byName.set(decl.name, group);
        const member = declarationAttachedMemberName(decl);
        if (member) {
          let owners = ownersByMember.get(member);
          if (!owners) {
            owners = new Set();
            ownersByMember.set(member, owners);
          }
          owners.add(decl.name);
        }
        visitDeclarationNames(decl, (name) => {
          ownerByName.set(name, decl.name);
          declarationNames.add(name);
        });
      }
      return {
        byName,
        ownerByName,
        ownersByMember,
        nameIndex: createDeclarationNameIndex(declarationNames),
      };
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
          const referenceStart = importTrace ? performance.now() : 0;
          const refs = cachedReferencedDeclarationNames(
            decl,
            nameIndex,
            referenceSummaries,
            referenceSummariesByDeclaration,
            semanticHashes,
            sourceText,
            referenceSummaryKey,
          );
          if (importTrace) {
            referenceMs += performance.now() - referenceStart;
            referenceCount += refs.size;
          }
          for (const ref of refs) {
            const member = referencedAttachedMemberName(ref);
            if (member) {
              for (const owner of ownersByMember.get(member) ?? []) {
                if (keep.has(owner)) continue;
                keep.add(owner);
                work.push(owner);
              }
              continue;
            }
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
  const kept: Declaration[] = [];
  for (const decl of declarations) {
    if (decl.kind === "type_assert") {
      kept.push(decl);
      continue;
    }
    if (localNames.has(decl.name) || keep.has(decl.name)) kept.push(decl);
  }
  return kept;
}

function cachedReferencedDeclarationNames(
  decl: Declaration,
  nameIndex: DeclarationNameIndex,
  referenceSummaries?: Map<string, DeclarationReferenceSummary>,
  referenceSummariesByDeclaration?: WeakMap<object, Map<string, DeclarationReferenceSummary>>,
  semanticHashes?: WeakMap<object, string>,
  sourceText?: (sourceId: string) => string | undefined,
  referenceSummaryKey?: string,
): Set<string> {
  const byNameIndex = referenceSummariesByDeclaration?.get(decl);
  const cachedByDeclaration = byNameIndex?.get(nameIndex.key);
  if (cachedByDeclaration) return cachedByDeclaration.names;
  const stableCacheKey = stableDeclarationReferenceSummaryKey(
    decl,
    nameIndex,
    sourceText,
    semanticHashes,
  );
  const cachedStable = stableCacheKey ? referenceSummaries?.get(stableCacheKey) : undefined;
  if (cachedStable) {
    setDeclarationReferenceSummary(
      decl,
      nameIndex.key,
      cachedStable,
      referenceSummariesByDeclaration,
    );
    return cachedStable.names;
  }
  const cacheKey = referenceSummaryKey
    ? declarationReferenceSummaryKey(referenceSummaryKey, decl)
    : undefined;
  const cached = cacheKey ? referenceSummaries?.get(cacheKey) : undefined;
  if (cached) {
    setDeclarationReferenceSummary(
      decl,
      nameIndex.key,
      cached,
      referenceSummariesByDeclaration,
    );
    return cached.names;
  }
  const refs = referencedDeclarationNames(decl, nameIndex);
  const summary = { names: refs };
  setDeclarationReferenceSummary(
    decl,
    nameIndex.key,
    summary,
    referenceSummariesByDeclaration,
  );
  if (stableCacheKey) referenceSummaries?.set(stableCacheKey, summary);
  if (cacheKey) referenceSummaries?.set(cacheKey, summary);
  return refs;
}

function stableDeclarationReferenceSummaryKey(
  decl: Declaration,
  nameIndex: DeclarationNameIndex,
  sourceText?: (sourceId: string) => string | undefined,
  semanticHashes?: WeakMap<object, string>,
): string | undefined {
  const span = decl.span ?? decl.nameSpan;
  const sourceId = span?.sourceId;
  const text = sourceId ? sourceText?.(sourceId) : undefined;
  if (span && sourceId && text) {
    return `decl_refs_source\0${nameIndex.key}\0${decl.kind}\0${
      declarationName(decl)
    }\0${sourceId}\0${hashString(text.slice(span.start, span.end))}`;
  }
  const identity = importedDeclarationIdentityKey(decl);
  if (!identity) return undefined;
  return `decl_refs_stable\0${nameIndex.key}\0${identity}\0${
    cachedAstSemanticHash(decl, semanticHashes)
  }`;
}

function setDeclarationReferenceSummary(
  decl: Declaration,
  nameIndexKey: string,
  summary: DeclarationReferenceSummary,
  cache?: WeakMap<object, Map<string, DeclarationReferenceSummary>>,
) {
  if (!cache) return;
  let byNameIndex = cache.get(decl);
  if (!byNameIndex) {
    byNameIndex = new Map();
    cache.set(decl, byNameIndex);
  }
  byNameIndex.set(nameIndexKey, summary);
}

interface DeclarationNameIndex {
  names: Set<string>;
  firstSegments: Set<string>;
  key: string;
}

function createDeclarationNameIndex(names: Set<string>): DeclarationNameIndex {
  const firstSegments = new Set<string>();
  for (const name of names) firstSegments.add(nameFirstSegment(name));
  return { names, firstSegments, key: declarationNamesKey(names) };
}

function referencedDeclarationNames(
  decl: Declaration,
  nameIndex: DeclarationNameIndex,
): Set<string> {
  const refs = new Set<string>();
  const add = (name: string | undefined) => {
    if (!name || name.startsWith("@")) return;
    if (name.startsWith("operator:")) {
      if (nameIndex.names.has(name)) refs.add(name);
      return;
    }
    const member = attachedMemberReferenceName(name);
    const match = longestReferencedName(name, nameIndex);
    if (match) {
      refs.add(match);
      if (member && match !== name && !nameIndex.names.has(name)) refs.add(member);
      return;
    }
    if (member) refs.add(member);
  };
  const addTypeSource = (source: string | undefined) => {
    if (!source) return;
    for (const token of typeSourceReferenceTokens(source, nameIndex)) add(token);
  };
  visitDeclarationReferenceNames(decl, add, addTypeSource);
  return refs;
}

function doStrategyMemberReferences(strategy: string, effect: TypeExpr): string[] {
  const effectName = doStrategyEffectConstructorName(effect);
  if (!effectName) return [];
  if (strategy === "monad") {
    return [`${effectName}::pure`, `${effectName}::bind`];
  }
  if (strategy === "applicative") {
    return [`${effectName}::map`, `${effectName}::pure`, `${effectName}::apply`];
  }
  return [];
}

function doStrategyEffectConstructorName(effect: TypeExpr): string | undefined {
  if (effect.kind === "type_ref") return effect.name;
  if (effect.kind === "type_static_ref") return effect.name;
  if (effect.kind === "type_call") return doStrategyEffectConstructorName(effect.callee);
  return undefined;
}

function visitDeclarationReferenceNames(
  decl: Declaration,
  add: (name: string | undefined) => void,
  addTypeSource: (source: string | undefined) => void,
) {
  const visitPattern = (pattern: ParamPattern | undefined) => {
    if (!pattern) return;
    if (
      pattern.kind === "constructor" || pattern.kind === "type" || pattern.kind === "enum_member"
    ) {
      add(pattern.name);
    }
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
        for (const member of doStrategyMemberReferences(expr.strategy.name, expr.strategy.effect)) {
          add(member);
        }
        for (const stmt of expr.statements) {
          if (
            stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
          ) {
            visitExpr(stmt.value);
          } else if (stmt.kind === "type_assert") visitTypeExpr(stmt.value);
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
        add(`operator:${expr.op}`);
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
          visitExpr(arm.guard);
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
          if (stmt.kind === "type_assert") {
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
        add(typeMemberRequirementReference(expr));
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
    if (item.kind === "type_assert") {
      visitTypeExpr(item.value);
      return;
    }
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
    if (item.kind === "operator") {
      add(item.target);
      return;
    }
    addTypeSource(item.type);
    visitExpr(item.value);
  };
  visitDecl(decl);
}

function longestReferencedName(
  name: string,
  nameIndex: DeclarationNameIndex,
): string | undefined {
  if (!isQualifiedReferenceName(name)) return undefined;
  if (nameIndex.names.has(name)) return name;
  if (!hasQualifiedSeparator(name)) return undefined;
  return longestQualifiedPrefixInSet(name, nameIndex.names);
}

function typeSourceReferenceTokens(
  source: string,
  nameIndex: DeclarationNameIndex,
): string[] {
  const refs: string[] = [];
  const pattern = /[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const token = match[0];
    if (nameIndex.firstSegments.has(nameFirstSegment(token))) refs.push(token);
  }
  return refs;
}

function longestQualifiedPrefixInSet(name: string, names: Set<string>): string | undefined {
  for (let end = name.length; end > 0;) {
    const dot = name.lastIndexOf(".", end - 1);
    const colon = name.lastIndexOf("::", end - 1);
    const separator = Math.max(dot, colon);
    if (separator < 0) return undefined;
    end = separator;
    const candidate = name.slice(0, end);
    if (names.has(candidate)) return candidate;
  }
  return undefined;
}

function nameFirstSegment(name: string): string {
  const dot = name.indexOf(".");
  const colon = name.indexOf("::");
  if (dot < 0 && colon < 0) return name;
  if (dot < 0) return name.slice(0, colon);
  if (colon < 0) return name.slice(0, dot);
  return name.slice(0, Math.min(dot, colon));
}

function hasQualifiedSeparator(name: string): boolean {
  return name.indexOf(".") >= 0 || name.indexOf("::") >= 0;
}

function isQualifiedReferenceName(name: string): boolean {
  let segmentStart = true;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    const identifierChar = (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95 ||
      (!segmentStart && code >= 48 && code <= 57);
    if (identifierChar) {
      segmentStart = false;
      continue;
    }
    if (segmentStart) return false;
    if (name[index] === ".") {
      segmentStart = true;
      continue;
    }
    if (name[index] === ":" && name[index + 1] === ":") {
      segmentStart = true;
      index++;
      continue;
    }
    return false;
  }
  return !segmentStart;
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

function importedDeclarationIdentityKey(decl: Declaration): string | undefined {
  const span = decl.nameSpan ?? decl.span;
  if (!span) return undefined;
  return `${decl.kind}\0${declarationName(decl)}\0${span.sourceId}\0${span.start}\0${span.end}`;
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
  const bindingNames = new Set<string>();
  for (const binding of bindings) {
    bindingNames.add(binding.name);
  }
  const { localDecls: allLocalDecls } = splitModuleLocalDeclarations(program);
  const localDecls = allLocalDecls.filter((decl) => decl.kind !== "type_assert");
  const localDeclarationNames = declarationPrimaryNameSet(localDecls);
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
  const names = collectDeclarationNameSet(prunedProgram.declarations);
  const hiddenDecls: Declaration[] = [];
  for (const decl of qualifyImportedDeclarations(prunedProgram.declarations, alias)) {
    hiddenDecls.push(markPrivate(decl));
  }
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
  for (const decl of selected) {
    hiddenDecls.push(decl);
  }
  return hiddenDecls;
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
  if (decl.kind === "fn") {
    const alreadyImported = decl.imported === true && decl.rootPublic === false;
    if (alreadyImported) return decl;
    return withMeta(decl, { ...decl, imported: true, rootPublic: false });
  }
  if (decl.kind === "operator") {
    if (decl.imported === true) return decl;
    return withMeta(decl, { ...decl, imported: true });
  }
  return decl;
}

function markRootDeclaration(decl: Declaration): Declaration {
  if (decl.kind === "fn") {
    const rootPublic = decl.public === true;
    const alreadyRoot = decl.imported === false && decl.rootPublic === rootPublic;
    if (alreadyRoot) return decl;
    return withMeta(decl, {
      ...decl,
      imported: false,
      rootPublic,
    });
  }
  return decl;
}

async function parseModuleSource(
  source: string | ModuleSource,
  moduleName: string,
  previous?: ParsedSourceEntry,
): Promise<Program> {
  const sourceId = moduleSourceId(moduleName, source);
  const text = moduleSourceText(source);
  const patched = previous
    ? await patchParsedProgramForFunctionBodyEdit(previous, text, sourceId)
    : undefined;
  const parsed = patched ?? await parse(text, { sourceId });
  parsed.moduleName = sourceId;
  return parsed;
}

async function patchParsedProgramForFunctionBodyEdit(
  previous: ParsedSourceEntry,
  text: string,
  sourceId: string,
): Promise<Program | undefined> {
  if (previous.text === text) return previous.program;
  const diff = sourceDiffRange(previous.text, text);
  if (!diff) return previous.program;
  const changedIndex = previous.program.declarations.findIndex((decl) => {
    if (decl.kind !== "fn") return false;
    const span = decl.span;
    if (!span) return false;
    return span.start <= diff.start && diff.oldEnd <= span.end;
  });
  if (changedIndex < 0) return undefined;
  const changedDecl = previous.program.declarations[changedIndex];
  if (changedDecl.kind !== "fn" || !changedDecl.span) return undefined;
  const start = changedDecl.span.start;
  const end = changedDecl.span.end + diff.delta;
  if (end <= start || end > text.length) return undefined;
  const source = text.slice(start, end);
  let parsedFragment: Program;
  try {
    parsedFragment = await parseFragment(source, text, start, { sourceId });
  } catch {
    return undefined;
  }
  if (parsedFragment.sourceImports?.length) return undefined;
  if (parsedFragment.declarations.length !== 1) return undefined;
  const replacement = parsedFragment.declarations[0];
  if (replacement.kind !== "fn") return undefined;
  if (replacement.name !== changedDecl.name) return undefined;
  const declarations: Declaration[] = [];
  for (let index = 0; index < previous.program.declarations.length; index++) {
    const decl = previous.program.declarations[index];
    if (index === changedIndex) {
      declarations.push(replacement);
      continue;
    }
    declarations.push(shiftAstItemAfterEdit(decl, diff.oldEnd, diff.delta));
  }
  const sourceImports: Program["sourceImports"] = [];
  for (const sourceImport of previous.program.sourceImports ?? []) {
    sourceImports.push(shiftAstItemAfterEdit(sourceImport, diff.oldEnd, diff.delta));
  }
  const imports: Program["imports"] = [];
  for (const item of previous.program.imports) {
    imports.push(shiftAstItemAfterEdit(item, diff.oldEnd, diff.delta));
  }
  return {
    ...previous.program,
    imports,
    sourceImports,
    declarations,
  };
}

function shiftAstItemAfterEdit<t>(item: t, oldEnd: number, delta: number): t {
  if (delta === 0 || !item || typeof item !== "object") return item;
  const object = item as { span?: { start: number }; nameSpan?: { start: number } };
  const span = object.span ?? object.nameSpan;
  if (span && span.start >= oldEnd) return shiftTopLevelAstMetadata(item, oldEnd, delta);
  return item;
}

function shiftTopLevelAstMetadata<t>(value: t, after: number, delta: number): t {
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const metadata: Partial<Record<(typeof AST_METADATA_KEYS)[number], unknown>> = {};
  for (const key of AST_METADATA_KEYS) {
    const child = object[key];
    if (child === undefined) continue;
    metadata[key] = shiftMetadataValue(child, after, delta);
  }
  defineAstMetadata(object, metadata);
  return value;
}

function sourceDiffRange(
  previous: string,
  current: string,
): { start: number; oldEnd: number; delta: number } | undefined {
  let start = 0;
  while (
    start < previous.length && start < current.length &&
    previous.charCodeAt(start) === current.charCodeAt(start)
  ) {
    start++;
  }
  if (start === previous.length && start === current.length) return undefined;
  let previousEnd = previous.length;
  let currentEnd = current.length;
  while (
    previousEnd > start && currentEnd > start &&
    previous.charCodeAt(previousEnd - 1) === current.charCodeAt(currentEnd - 1)
  ) {
    previousEnd--;
    currentEnd--;
  }
  return {
    start,
    oldEnd: previousEnd,
    delta: current.length - previous.length,
  };
}

function shiftAstMetadata<t>(
  value: t,
  after: number,
  delta: number,
  seen = new WeakSet<object>(),
): t {
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (seen.has(object)) return value;
  seen.add(object);
  const metadata: Partial<Record<(typeof AST_METADATA_KEYS)[number], unknown>> = {};
  for (const key of AST_METADATA_KEYS) {
    const child = object[key];
    if (child === undefined) continue;
    metadata[key] = shiftMetadataValue(child, after, delta);
  }
  defineAstMetadata(object, metadata);
  for (const child of Object.values(object)) {
    shiftAstMetadata(child, after, delta, seen);
  }
  return value;
}

function shiftMetadataValue(value: unknown, after: number, delta: number): unknown {
  if (Array.isArray(value)) {
    const shifted: unknown[] = [];
    for (const item of value) shifted.push(shiftMetadataValue(item, after, delta));
    return shifted;
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const start = typeof object.start === "number" ? object.start : undefined;
  const end = typeof object.end === "number" ? object.end : undefined;
  const shifted: Record<string, unknown> = {};
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    shifted[key] = shiftMetadataValue(object[key], after, delta);
  }
  if (start !== undefined && start >= after) shifted.start = start + delta;
  if (end !== undefined && end >= after) shifted.end = end + delta;
  return shifted;
}

function moduleSourceCacheKey(moduleName: string, source: string | ModuleSource): string {
  const sourceId = moduleSourceId(moduleName, source);
  const text = moduleSourceText(source);
  return `${sourceId}\0${text.length}\0${hashString(text)}`;
}

export function moduleInterfaceKey(program: Program): string {
  let hash = 0x811c9dc5;
  hash = hashUpdateString(hash, "imports:");
  for (const item of program.imports) {
    hash = hashUpdateString(hash, item.name);
    hash = hashUpdateString(hash, item.externalName ?? "");
    hash = hashUpdateString(hash, item.type);
    hash = hashUpdateString(hash, item.effects.join(","));
    hash = hashUpdateString(hash, ";");
  }
  hash = hashUpdateString(hash, "sourceImports:");
  for (const item of program.sourceImports ?? []) {
    hash = hashUpdateString(hash, item.module);
    hash = hashUpdateString(hash, item.alias ?? "");
    for (const binding of item.bindings ?? []) hash = hashUpdateString(hash, binding.name);
    hash = hashUpdateString(hash, ";");
  }
  hash = hashUpdateString(hash, "declarations:");
  for (const decl of program.declarations) {
    hash = hashUpdateString(hash, declarationInterfaceKey(decl));
    hash = hashUpdateString(hash, ";");
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function moduleReferenceKey(program: Program): string {
  const names = collectDeclarationNameSet(program.declarations);
  const nameIndex = createDeclarationNameIndex(names);
  let hash = 0x811c9dc5;
  hash = hashUpdateString(hash, "module_refs");
  for (const decl of program.declarations) {
    hash = hashUpdateString(hash, decl.kind);
    hash = hashUpdateString(hash, declarationName(decl));
    hash = hashUpdateString(hash, ":");
    for (const ref of [...referencedDeclarationNames(decl, nameIndex)].sort()) {
      hash = hashUpdateString(hash, ref);
      hash = hashUpdateString(hash, ",");
    }
    hash = hashUpdateString(hash, ";");
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function declarationInterfaceKey(decl: Declaration): string {
  let hash = 0x811c9dc5;
  hash = hashUpdateString(hash, decl.kind);
  hash = hashUpdateString(hash, declarationName(decl));
  if (decl.kind === "fn") {
    hash = hashUpdateString(hash, decl.public ? "pub" : "priv");
    hash = hashUpdateString(hash, decl.externalName ?? "");
    hash = hashUpdateString(hash, decl.returnType ?? "");
    hash = hashUpdateString(hash, decl.effects.join(","));
    hash = hashUpdateString(hash, decl.primitiveId ?? "");
    hash = hashUpdateString(hash, decl.branchHint ?? "");
    for (const param of decl.params) {
      hash = hashUpdateString(hash, param.name);
      hash = hashUpdateString(hash, param.type);
      hash = hashUpdateString(hash, param.const ? "const" : "runtime");
    }
  } else if (decl.kind === "let" || decl.kind === "const") {
    hash = hashUpdateString(hash, decl.type ?? "");
  } else if (decl.kind === "operator") {
    hash = hashUpdateString(hash, decl.symbol);
    hash = hashUpdateString(hash, decl.fixity);
    hash = hashUpdateString(hash, `${decl.precedence}`);
    hash = hashUpdateString(hash, decl.target);
  } else if (decl.kind === "type") {
    hash = hashTypeDeclInterface(hash, decl);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hashTypeDeclInterface(hash: number, decl: TypeDecl): number {
  hash = hashUpdateString(hash, decl.resultKind);
  for (const param of decl.params) {
    hash = hashUpdateString(hash, param.name);
    hash = hashUpdateString(hash, param.kind);
  }
  hash = hashAstSemanticValue(hash, decl.body);
  hash = hashAstSemanticValue(hash, decl.normalized);
  hash = hashAstSemanticValue(hash, decl.paramKinds);
  for (const clause of decl.clauses ?? []) {
    hash = hashUpdateString(hash, declarationInterfaceKey(clause));
  }
  return hash;
}

function moduleSourceId(moduleName: string, source: string | ModuleSource): string {
  return typeof source === "string" ? moduleName : source.sourceId ?? moduleName;
}

function moduleSourceText(source: string | ModuleSource): string {
  return typeof source === "string" ? source : source.text;
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
  // Function/check and backend caches are content-addressed by declaration and environment hashes,
  // so source edits can leave them in place; changed declarations naturally miss by key.
  for (
    const map of [
      cache.parsedModules,
      cache.resolvedModules,
      cache.prunedImports,
      cache.linkedModules,
      cache.importClosures,
      cache.moduleInterfaceKeys,
      cache.moduleReferenceKeys,
      cache.qualifiedEffectImports,
      cache.qualifiedLocalImports,
      cache.importedDeclarationNames,
    ]
  ) {
    if (!map) continue;
    for (const key of map.keys()) {
      if (matches(key)) map.delete(key);
    }
  }
  if (cache.referenceSummaries) {
    for (const key of cache.referenceSummaries.keys()) {
      if (key.startsWith("decl_refs_source\0") || key.startsWith("decl_refs_stable\0")) {
        continue;
      }
      if (matches(key)) cache.referenceSummaries.delete(key);
    }
  }
}

function resolvedModuleCacheKey(sourceKey: string, pruneImports: boolean): string {
  return `${pruneImports ? "pruned" : "full"}\0${sourceKey}`;
}

function moduleStableInterfaceCacheKey(sourceId: string, interfaceKey: string): string {
  return `stable_interface\0${sourceId}\0${interfaceKey}`;
}

function prunedImportSelectionCacheKey(
  sourceId: string,
  interfaceKey: string,
  referenceKey: string,
  roots: Set<string>,
): string {
  return `pruned_selection\0${sourceId}\0${interfaceKey}\0${referenceKey}\0${
    [...roots].sort().join("\0")
  }`;
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

function stableLinkedDependencyKey(
  program: Program,
  cache?: Pick<
    CompileCache,
    "moduleInterfaceKeysBySourceId" | "moduleReferenceKeysBySourceId"
  >,
): string | undefined {
  const sourceId = program.moduleName;
  if (!sourceId) return undefined;
  const interfaceKey = cache?.moduleInterfaceKeysBySourceId?.get(sourceId);
  const referenceKey = cache?.moduleReferenceKeysBySourceId?.get(sourceId);
  if (!interfaceKey || !referenceKey) return undefined;
  return `dep\0${sourceId}\0${interfaceKey}\0${referenceKey}`;
}

function stableLinkedModuleCacheKey(
  sourceKey: string,
  pruneImports: boolean,
  stableDependencyKeys: string[],
): string {
  return `stable_linked\0${pruneImports ? "pruned" : "full"}\0${sourceKey}\0${
    [...stableDependencyKeys].sort().join("\0")
  }`;
}

function stableImportSurfaceCacheKey(
  sourceId: string,
  interfaceKey: string,
  referenceKey: string,
  pruneImports: boolean,
  stableDependencyKeys: string[],
): string {
  return `stable_import_surface\0${sourceId}\0${
    pruneImports ? "pruned" : "full"
  }\0${interfaceKey}\0${referenceKey}\0${[...stableDependencyKeys].sort().join("\0")}`;
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

function stableImportClosureCacheKey(
  stableSurfaceKey: string,
  alias: string,
  roots: Set<string>,
  pruneImports: boolean,
): string {
  return `stable_import_closure\0${
    pruneImports ? "pruned" : "full"
  }\0${stableSurfaceKey}\0${alias}\0${[...roots].sort().join("\0")}`;
}

function qualifiedEffectImportsCacheKey(sourceKey: string, alias: string): string {
  return `effect_imports\0${sourceKey}\0${alias}`;
}

function qualifiedLocalDeclarationsCacheKey(
  declarations: Declaration[],
  alias: string,
  names: Set<string>,
  localSourceKey?: string,
): string {
  const localKey = localSourceKey ?? `ast:${stableAstSemanticHash(declarations)}`;
  return `local_imports\0${alias}\0${declarationNamesKey(names)}\0${localKey}`;
}

function qualifiedDeclarationCacheKey(
  decl: Declaration,
  alias: string,
  namesKey: string,
  semanticHashes?: WeakMap<object, string>,
): string {
  return `local_decl\0${alias}\0${namesKey}\0${declarationName(decl)}\0${
    cachedAstSemanticHash(decl, semanticHashes)
  }`;
}

function aliasReferenceRootsCacheKey(
  importedNames: Set<string>,
  localDeclarations: Declaration[],
  alias: string,
  localSourceKey?: string,
  importedNamesKey?: string,
): string {
  const localKey = localSourceKey ?? `ast:${stableAstSemanticHash(localDeclarations)}`;
  const namesKey = importedNamesKey ?? `names:${declarationNamesKey(importedNames)}`;
  return `alias_roots\0${alias}\0${namesKey}\0${localKey}`;
}

function declarationNamesKey(names: Set<string>): string {
  return hashString([...names].sort().join("\0"));
}

function declarationReferenceSummaryKey(prefix: string, decl: Declaration): string {
  return `decl_refs\0${prefix}\0${declarationName(decl)}`;
}

function stableAstHashWithMetadata(value: unknown): string {
  return (hashAstValueWithMetadata(0x811c9dc5, value) >>> 0).toString(16).padStart(8, "0");
}

function stableAstSemanticHash(value: unknown): string {
  return (hashAstSemanticValue(0x811c9dc5, value) >>> 0).toString(16).padStart(8, "0");
}

function cachedAstSemanticHash(value: object, cache?: WeakMap<object, string>): string {
  const cached = cache?.get(value);
  if (cached) return cached;
  const hash = stableAstSemanticHash(value);
  cache?.set(value, hash);
  return hash;
}

function hashAstValueWithMetadata(hash: number, value: unknown): number {
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
      hash = hashAstValueWithMetadata(hashUpdateString(hash, ","), item);
    }
    return hashUpdateString(hash, "]");
  }
  hash = hashUpdateString(hash, "{");
  const object = value as Record<string, unknown>;
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    const child = object[key];
    if ((AST_METADATA_KEYS as readonly string[]).includes(key) || child === undefined) continue;
    hash = hashUpdateString(hashUpdateString(hash, key), ":");
    hash = hashAstValueWithMetadata(hash, child);
    hash = hashUpdateString(hash, ";");
  }
  for (const key of AST_METADATA_KEYS) {
    if (!(key in object)) continue;
    const child = object[key];
    if (child === undefined) continue;
    hash = hashUpdateString(hashUpdateString(hash, key), ":");
    hash = hashAstValueWithMetadata(hash, child);
    hash = hashUpdateString(hash, ";");
  }
  return hashUpdateString(hash, "}");
}

function hashAstSemanticValue(hash: number, value: unknown): number {
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
      hash = hashAstSemanticValue(hashUpdateString(hash, ","), item);
    }
    return hashUpdateString(hash, "]");
  }
  hash = hashUpdateString(hash, "{");
  const object = value as Record<string, unknown>;
  for (const key in object) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
    const child = object[key];
    if ((AST_METADATA_KEYS as readonly string[]).includes(key) || child === undefined) continue;
    hash = hashUpdateString(hashUpdateString(hash, key), ":");
    hash = hashAstSemanticValue(hash, child);
    hash = hashUpdateString(hash, ";");
  }
  return hashUpdateString(hash, "}");
}

function hashUpdateString(hash: number, text: string): number {
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

function hashString(text: string): string {
  let hash = 0x811c9dc5;
  hash = hashUpdateString(hash, text);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isTrailingTriviaOnlyAppend(previous: string, current: string): boolean {
  return current.startsWith(previous) && isSourceTrivia(current.slice(previous.length));
}

function sourceTrailingTriviaEquivalent(previous: string, current: string): boolean {
  return sourceWithoutTrailingTrivia(previous) === sourceWithoutTrailingTrivia(current);
}

function sourceWithoutTrailingTrivia(text: string): string {
  let end = text.length;
  while (end > 0) {
    const beforeWhitespace = end;
    while (end > 0) {
      const char = text[end - 1];
      if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") break;
      end--;
    }
    const lineStart = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(lineStart, end);
    let firstContent = 0;
    while (firstContent < line.length) {
      const char = line[firstContent];
      if (char !== " " && char !== "\t") break;
      firstContent++;
    }
    const hasLineComment = line.startsWith("//", firstContent);
    if (hasLineComment) {
      end = lineStart;
      continue;
    }
    if (end !== beforeWhitespace) continue;
    break;
  }
  return text.slice(0, end);
}

function isSourceTrivia(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index++;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index++;
      continue;
    }
    return false;
  }
  return true;
}

function cloneProgram(program: Program): Program {
  return cloneAstValue(program) as Program;
}

function cloneDeclarations(declarations: Declaration[], preserveMetadata = true): Declaration[] {
  if (!preserveMetadata) {
    return declarations.map((decl) =>
      copyAstMetadata(cloneAstValueLight(decl) as Declaration, decl)
    );
  }
  return cloneAstValue(declarations, undefined, preserveMetadata) as Declaration[];
}

function cloneAstValueLight(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneAstValueLight);
  const clone: Record<string, unknown> = {};
  const source = value as Record<string, unknown>;
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    clone[key] = cloneAstValueLight(source[key]);
  }
  return clone;
}

function cloneAstValue(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
  preserveMetadata = true,
): unknown {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  const cached = seen.get(object);
  if (cached) return cached;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(object, clone);
    for (const item of value) clone.push(cloneAstValue(item, seen, preserveMetadata));
    if (preserveMetadata) copyAstMetadata(clone, value);
    return clone;
  }
  const clone: Record<string, unknown> = {};
  seen.set(object, clone);
  const source = value as Record<string, unknown>;
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    clone[key] = cloneAstValue(source[key], seen, preserveMetadata);
  }
  if (preserveMetadata) copyAstMetadata(clone, value);
  return clone;
}

function recordImportCacheHit(
  trace: ImportTraceState | undefined,
  name: string,
  moduleName: string,
  program: Program,
) {
  if (!trace) return;
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
    sourceImportCount: program.sourceImports?.length ?? 0,
  };
}

function importProgramCountersIfTrace(trace: ImportTraceState | undefined, program: Program) {
  return trace ? importProgramCounters(program) : {};
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
  if (decl.kind === "type_assert") return "";
  return decl.kind === "operator" ? operatorDeclarationName(decl) : decl.name;
}

function operatorDeclarationName(decl: OperatorDecl): string {
  return `operator:${decl.symbol}`;
}

function qualifyImportedDeclarations(
  declarations: Declaration[],
  alias: string,
  names = collectDeclarationNameSet(declarations),
): Declaration[] {
  const qualified: Declaration[] = [];
  for (const decl of declarations) {
    qualified.push(qualifyDeclaration(decl, alias, names));
  }
  return qualified;
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

function cachedQualifiedEffectImportTypes(
  imports: Program["imports"],
  alias: string,
  names: Set<string>,
  sourceKey?: string,
  cache?: Map<string, Program["imports"]>,
): Program["imports"] {
  const cacheKey = sourceKey ? qualifiedEffectImportsCacheKey(sourceKey, alias) : undefined;
  const cached = cacheKey ? cache?.get(cacheKey) : undefined;
  if (cached) return cloneAstValue(cached) as Program["imports"];
  const qualified = qualifyEffectImportTypes(imports, alias, names);
  if (cacheKey) cache?.set(cacheKey, cloneAstValue(qualified) as Program["imports"]);
  return qualified;
}

function cachedQualifiedLocalDeclarations(
  declarations: Declaration[],
  alias: string,
  names: Set<string>,
  localSourceKey?: string,
  cache?: Map<string, Declaration[]>,
  declarationCache?: Map<string, Declaration>,
  semanticHashes?: WeakMap<object, string>,
): Declaration[] {
  const cacheKey = cache
    ? qualifiedLocalDeclarationsCacheKey(declarations, alias, names, localSourceKey)
    : undefined;
  const cached = cacheKey ? cache?.get(cacheKey) : undefined;
  if (cached) return cloneAstValue(cached) as Declaration[];
  const qualified = cachedQualifiedDeclarations(
    declarations,
    alias,
    names,
    declarationCache,
    semanticHashes,
  );
  if (cacheKey) cache?.set(cacheKey, cloneAstValue(qualified) as Declaration[]);
  return qualified;
}

function cachedQualifiedDeclarations(
  declarations: Declaration[],
  alias: string,
  names: Set<string>,
  cache?: Map<string, Declaration>,
  semanticHashes?: WeakMap<object, string>,
): Declaration[] {
  if (!cache) return qualifyImportedDeclarations(declarations, alias, names);
  const namesKey = declarationNamesKey(names);
  const qualified: Declaration[] = [];
  for (const decl of declarations) {
    const cacheKey = qualifiedDeclarationCacheKey(decl, alias, namesKey, semanticHashes);
    const cached = cache.get(cacheKey);
    if (cached) {
      qualified.push(cloneAstValue(cached) as Declaration);
      continue;
    }
    const next = qualifyDeclaration(decl, alias, names);
    cache.set(cacheKey, cloneAstValue(next) as Declaration);
    qualified.push(next);
  }
  return qualified;
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
  const names: string[] = [];
  visitDeclarationNames(decl, (name) => names.push(name));
  return names;
}

function visitDeclarationNames(decl: Declaration, add: (name: string) => void) {
  if (decl.kind === "type_assert") return;
  if (decl.kind === "operator") {
    add(operatorDeclarationName(decl));
    return;
  }
  add(decl.name);
  if (decl.kind !== "type") return;
  for (const stmt of decl.body.statements) {
    add(stmt.name);
  }
  for (const clause of decl.clauses ?? []) {
    visitDeclarationNames(clause, add);
  }
}

function collectDeclarationNameArray(declarations: Declaration[]): string[] {
  const names: string[] = [];
  for (const decl of declarations) {
    visitDeclarationNames(decl, (name) => names.push(name));
  }
  return names;
}

function collectDeclarationNameSet(declarations: Declaration[]): Set<string> {
  const names = new Set<string>();
  for (const decl of declarations) {
    visitDeclarationNames(decl, (name) => names.add(name));
  }
  return names;
}

function declarationPrimaryNameSet(declarations: Declaration[]): Set<string> {
  const names = new Set<string>();
  for (const decl of declarations) {
    if (decl.kind === "type_assert") continue;
    names.add(declarationName(decl));
  }
  return names;
}

function qualifyNameSet(names: Set<string>, alias: string): Set<string> {
  const qualified = new Set<string>();
  for (const name of names) qualified.add(qualifyName(name, alias));
  return qualified;
}

function qualifyDeclaration(decl: Declaration, alias: string, names: Set<string>): Declaration {
  if (decl.kind === "type_assert") {
    return withMeta(decl, { ...decl, value: qualifyTypeExpr(decl.value, alias, names) });
  }
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
  if (locals.has(name)) return true;
  if (!hasQualifiedSeparator(name)) return false;
  for (const local of locals) {
    if (name.startsWith(`${local}.`) || name.startsWith(`${local}::`)) {
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
          const nextArm = withMeta(arm, {
            ...arm,
            pattern: qualifyParamPattern(arm.pattern, alias, names),
            value: qualifyExpr(arm.value, alias, names, armLocals),
          });
          if (arm.guard) {
            nextArm.guard = qualifyExpr(arm.guard, alias, names, armLocals);
          }
          return nextArm;
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
    if (stmt.kind === "type_assert") {
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
    if (stmt.kind === "type_assert") {
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
  if (pattern.kind === "constructor" || pattern.kind === "type" || pattern.kind === "enum_member") {
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
      if (typeTokenIsFieldLabel(source, offset + token.length)) return token;
      return qualifyReference(token, alias, names);
    },
  );
}

function typeTokenIsFieldLabel(source: string, end: number): boolean {
  let index = end;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    const whitespace = code === 32 || code === 9 || code === 10 || code === 13;
    if (!whitespace) break;
    index++;
  }
  return source[index] === ":" && source[index + 1] !== ":";
}

function qualifyReference(name: string, alias: string, names: Set<string>): string {
  if (name.startsWith("@")) return name;
  if (!isQualifiedReferenceName(name)) return name;
  if (names.has(name)) return qualifyName(name, alias);
  if (!hasQualifiedSeparator(name)) return name;
  const candidate = longestQualifiedPrefixInSet(name, names);
  if (candidate) return `${qualifyName(candidate, alias)}${name.slice(candidate.length)}`;
  return name;
}

function qualifyName(name: string, alias: string): string {
  return `${alias}.${name}`;
}
