import {
  compileArtifactsFromSource,
  type CompileArtifactsResult,
  type CompileTraceEvent,
  createCompileCache,
  createCompilerSession,
  type ModuleResolveContext,
  type ModuleSource,
} from "../../src/mod.ts";
import { candidateModulePaths } from "../../src/lsp/modules.ts";
import { type BenchmarkScenario, generateLargeCompileProject } from "./generate.ts";

type FigSample = {
  wallMs: number;
  artifact: CompileArtifactsResult;
  cacheStats?: CacheStatsSample;
  trace?: CompileTraceEvent[];
};

type CacheStatsSample = {
  linkedModuleHits: number;
  linkedModuleMisses: number;
  stableLinkedModuleHits: number;
  stableLinkedModuleMisses: number;
  stableImportClosureHits: number;
  stableImportClosureMisses: number;
  importClosureHits: number;
  importClosureMisses: number;
  prunedImportHits: number;
  prunedImportMisses: number;
  prunedSelectionHits: number;
  prunedSelectionMisses: number;
  qualifiedLocalImportHits: number;
  qualifiedLocalImportMisses: number;
  moduleInterfaceHits: number;
  moduleInterfaceMisses: number;
  moduleInterfaceSourceHits: number;
  moduleInterfaceSourceMisses: number;
  stableModuleInterfaceHits: number;
  stableModuleInterfaceMisses: number;
  checkedProgramHits: number;
  checkedProgramMisses: number;
  functionCheckHits: number;
  functionCheckMisses: number;
  typeContractHits: number;
  typeContractMisses: number;
  backendLayoutHits: number;
  backendLayoutMisses: number;
  backendLayoutPlanHits: number;
  backendLayoutPlanMisses: number;
  backendFunctionHits: number;
  backendFunctionMisses: number;
  wasmFunctionHits: number;
  wasmFunctionMisses: number;
  wasmNameSectionHits: number;
  wasmNameSectionMisses: number;
};

class CountingMap<K, V> extends Map<K, V> {
  hits = 0;
  misses = 0;

  override get(key: K): V | undefined {
    const value = super.get(key);
    if (value === undefined) {
      this.misses++;
    } else {
      this.hits++;
    }
    return value;
  }

  override has(key: K): boolean {
    const found = super.has(key);
    if (found) {
      this.hits++;
    } else {
      this.misses++;
    }
    return found;
  }
}

class CountingSet<T> extends Set<T> {
  hits = 0;
  misses = 0;

  override has(value: T): boolean {
    const found = super.has(value);
    if (found) {
      this.hits++;
    } else {
      this.misses++;
    }
    return found;
  }
}

class CountingWeakMap<K extends object, V> extends WeakMap<K, V> {
  hits = 0;
  misses = 0;

  override get(key: K): V | undefined {
    const value = super.get(key);
    if (value === undefined) {
      this.misses++;
    } else {
      this.hits++;
    }
    return value;
  }
}

type BenchMode =
  | "full_uncached"
  | "full_shared_cache"
  | "session_root_edit"
  | "session_leaf_edit"
  | "session_leaf_semantic_edit"
  | "build_cold_cache"
  | "build_warm_noop"
  | "build_root_edit"
  | "build_leaf_edit"
  | "build_leaf_semantic_edit";

type Row = {
  runtime: "fig" | "go";
  mode: string;
  samples: number;
  median_ms: string;
  p90_ms: string;
  parse_ms?: string;
  import_ms?: string;
  check_ms?: string;
  backend_ms?: string;
  backend_layout_ms?: string;
  backend_lower_ms?: string;
  backend_cleanup_ms?: string;
  wasm_encode_ms?: string;
  linked_hits?: string;
  linked_misses?: string;
  stable_linked_hits?: string;
  stable_linked_misses?: string;
  stable_closure_hits?: string;
  stable_closure_misses?: string;
  closure_hits?: string;
  closure_misses?: string;
  pruned_hits?: string;
  pruned_misses?: string;
  pruned_selection_hits?: string;
  pruned_selection_misses?: string;
  local_import_hits?: string;
  local_import_misses?: string;
  interface_hits?: string;
  interface_misses?: string;
  interface_source_hits?: string;
  interface_source_misses?: string;
  stable_interface_hits?: string;
  stable_interface_misses?: string;
  checked_program_hits?: string;
  checked_program_misses?: string;
  fn_check_hits?: string;
  fn_check_misses?: string;
  type_contract_hits?: string;
  type_contract_misses?: string;
  backend_layout_hits?: string;
  backend_layout_misses?: string;
  backend_layout_plan_hits?: string;
  backend_layout_plan_misses?: string;
  backend_fn_hits?: string;
  backend_fn_misses?: string;
  wasm_fn_hits?: string;
  wasm_fn_misses?: string;
  wasm_name_hits?: string;
  wasm_name_misses?: string;
  speedup_vs_fig_uncached: string;
};

const here = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const runRoot = await Deno.makeTempDir({ prefix: "fig-large-compile-" });
const loc = numberArg("--loc", 9_000);
const modules = numberArg("--modules", 12);
const samples = numberArg("--samples", 5);
const warmup = numberArg("--warmup", 1);
const scenario = scenarioArg("--scenario", "kernels");
const release = Deno.args.includes("--release");
const pruneImports = !Deno.args.includes("--no-prune");
const cacheStatsEnabled = Deno.args.includes("--cache-stats");
const traceEnabled = Deno.args.includes("--trace");
const traceLimit = numberArg("--trace-limit", 25);
const selectedModes = selectedModeArgs();
const project = await generateLargeCompileProject({
  rootDir: runRoot,
  targetLoc: loc,
  modules,
  scenario,
});
await Deno.mkdir(`${runRoot}/out`, { recursive: true });

const figSources = await readFigSources(project.figDir);
const rootSource = figSources.get(project.rootFig)!;
const leafSource = figSources.get(project.leafFig)!;
const goCache = `${runRoot}/.gocache`;
const figOptions = {
  sourceId: project.rootFig,
  resolveModule,
  pruneImports,
  includeWat: false as const,
  optMode: release ? "release" as const : "debug" as const,
};

const goRootSource = await Deno.readTextFile(project.goRoot);
const goLeafSource = await Deno.readTextFile(project.goLeaf);
const rows: Row[] = [];
const measuredTraceEvents: CompileTraceEvent[] = [];
let baseline = 0;

if (shouldRun("full_uncached")) {
  const figUncached = await benchFig(() => {
    const benchCache = createBenchCompileCache();
    return compileFig(rootSource, benchCache);
  });
  baseline = median(figUncached.map((sample) => sample.wallMs));
  rows.push(figRow("full_uncached", figUncached, baseline));
}
if (shouldRun("full_shared_cache")) {
  const sharedCache = createBenchCompileCache();
  rows.push(
    figRow(
      "full_shared_cache",
      await benchFig(() => compileFig(rootSource, sharedCache)),
      baseline,
    ),
  );
}
if (
  shouldRun("session_root_edit") || shouldRun("session_leaf_edit") ||
  shouldRun("session_leaf_semantic_edit")
) {
  const sessionCache = createBenchCompileCache();
  const session = createCompilerSession({ ...figOptions, cache: sessionCache.cache });
  if (shouldRun("session_root_edit")) {
    rows.push(figRow(
      "session_root_edit",
      await benchFig(async (index) => {
        const source = `${rootSource}\n// root edit ${index}`;
        const cacheStatsBefore = snapshotCacheStats(sessionCache.stats);
        const compileTrace = traceEnabled ? [] : undefined;
        const start = performance.now();
        const result = await session.compileRoot({ text: source, sourceId: project.rootFig }, {
          compileTrace,
          includeWat: false,
        });
        const wallMs = performance.now() - start;
        if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
        return {
          wallMs,
          artifact: result.artifact,
          cacheStats: diffCacheStats(cacheStatsBefore, snapshotCacheStats(sessionCache.stats)),
          trace: compileTrace,
        };
      }),
      baseline,
    ));
  }
  if (shouldRun("session_leaf_edit")) {
    rows.push(figRow(
      "session_leaf_edit",
      await benchFig(async (index) => {
        const source = `${leafSource}\n// leaf edit ${index}`;
        figSources.set(project.leafFig, source);
        session.update({ sourceId: project.leafFig, text: source });
        const cacheStatsBefore = snapshotCacheStats(sessionCache.stats);
        const compileTrace = traceEnabled ? [] : undefined;
        const start = performance.now();
        const result = await session.compileRoot({ text: rootSource, sourceId: project.rootFig }, {
          compileTrace,
          includeWat: false,
        });
        const wallMs = performance.now() - start;
        if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
        return {
          wallMs,
          artifact: result.artifact,
          cacheStats: diffCacheStats(cacheStatsBefore, snapshotCacheStats(sessionCache.stats)),
          trace: compileTrace,
        };
      }),
      baseline,
    ));
  }
  if (shouldRun("session_leaf_semantic_edit")) {
    rows.push(figRow(
      "session_leaf_semantic_edit",
      await benchFig(async (index) => {
        const source = semanticLeafEdit(leafSource, index);
        figSources.set(project.leafFig, source);
        session.update({ sourceId: project.leafFig, text: source });
        const cacheStatsBefore = snapshotCacheStats(sessionCache.stats);
        const compileTrace = traceEnabled ? [] : undefined;
        const start = performance.now();
        const result = await session.compileRoot({ text: rootSource, sourceId: project.rootFig }, {
          compileTrace,
          includeWat: false,
        });
        const wallMs = performance.now() - start;
        if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
        return {
          wallMs,
          artifact: result.artifact,
          cacheStats: diffCacheStats(cacheStatsBefore, snapshotCacheStats(sessionCache.stats)),
          trace: compileTrace,
        };
      }),
      baseline,
    ));
  }
}

if (
  shouldRun("build_cold_cache") || shouldRun("build_warm_noop") ||
  shouldRun("build_root_edit") || shouldRun("build_leaf_edit") ||
  shouldRun("build_leaf_semantic_edit")
) {
  await goBuild(`${runRoot}/out/warmup`, `${runRoot}/.cold-warmup`);
}
if (shouldRun("build_cold_cache")) {
  rows.push(
    goRow(
      "build_cold_cache",
      await benchGo((index) => goBuild(`${runRoot}/out/cold-${index}`, `${runRoot}/cold-${index}`)),
      baseline,
    ),
  );
}
if (
  shouldRun("build_warm_noop") || shouldRun("build_root_edit") ||
  shouldRun("build_leaf_edit") || shouldRun("build_leaf_semantic_edit")
) {
  await goBuild(`${runRoot}/out/app`, goCache);
}
if (shouldRun("build_warm_noop")) {
  rows.push(
    goRow("build_warm_noop", await benchGo(() => goBuild(`${runRoot}/out/app`, goCache)), baseline),
  );
}
if (shouldRun("build_root_edit")) {
  rows.push(goRow(
    "build_root_edit",
    await benchGo(async (index) => {
      await Deno.writeTextFile(
        project.goRoot,
        `${goRootSource}\nvar RootEdit${index} int32 = ${index}\n`,
      );
      await goBuild(`${runRoot}/out/app`, goCache);
    }),
    baseline,
  ));
}
if (shouldRun("build_leaf_edit")) {
  rows.push(goRow(
    "build_leaf_edit",
    await benchGo(async (index) => {
      await Deno.writeTextFile(
        project.goLeaf,
        `${goLeafSource}\nvar LeafEdit${index} int32 = ${index}\n`,
      );
      await goBuild(`${runRoot}/out/app`, goCache);
    }),
    baseline,
  ));
}
if (shouldRun("build_leaf_semantic_edit")) {
  rows.push(goRow(
    "build_leaf_semantic_edit",
    await benchGo(async (index) => {
      await Deno.writeTextFile(project.goLeaf, semanticGoLeafEdit(goLeafSource, index));
      await goBuild(`${runRoot}/out/app`, goCache);
    }),
    baseline,
  ));
}

console.log(
  `run_root=${runRoot} fig_project=${project.figDir} go_project=${project.goDir} actual_fig_loc=${project.figLoc} actual_go_loc=${project.goLoc} modules=${project.modules} kernels_per_module=${project.kernelsPerModule} optMode=${
    release ? "release" : "debug"
  } scenario=${project.scenario} samples=${samples} warmup=${warmup} prune_imports=${
    pruneImports ? "on" : "off"
  } cache_stats=${cacheStatsEnabled ? "on" : "off"} trace=${traceEnabled ? "on" : "off"} modes=${
    selectedModes ? selectedModes.join(",") : "all"
  }`,
);
console.table(rows);
if (traceEnabled) printTraceSummary(measuredTraceEvents, traceLimit);

async function readFigSources(figDir: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for await (const entry of Deno.readDir(figDir)) {
    if (!entry.isFile || !entry.name.endsWith(".fig")) continue;
    const path = `${figDir}/${entry.name}`;
    sources.set(path, await Deno.readTextFile(path));
  }
  return sources;
}

async function resolveModule(
  moduleName: string,
  context?: ModuleResolveContext,
): Promise<ModuleSource | undefined> {
  const importer = context?.fromSourceId ?? project.rootFig;
  for (const path of candidateModulePaths(importer, moduleName)) {
    const text = figSources.get(path);
    if (text !== undefined) return { text, sourceId: path };
  }
  return undefined;
}

async function benchFig(run: (index: number) => Promise<FigSample>): Promise<FigSample[]> {
  for (let index = 0; index < warmup; index++) await run(index);
  const result: FigSample[] = [];
  for (let index = 0; index < samples; index++) {
    const sample = await run(warmup + index);
    if (sample.trace) {
      for (const event of sample.trace) measuredTraceEvents.push(event);
    }
    result.push(sample);
  }
  return result;
}

type BenchCompileCache = ReturnType<typeof createCompileCache>;

type BenchCacheCounters = {
  linkedModules: CountingMap<string, unknown>;
  stableLinkedModuleKeys: CountingSet<string>;
  stableImportClosureKeys: CountingSet<string>;
  importClosures: CountingMap<string, unknown>;
  prunedImports: CountingMap<string, unknown>;
  prunedImportSelections: CountingMap<string, unknown>;
  qualifiedLocalImports: CountingMap<string, unknown>;
  moduleInterfaceKeys: CountingMap<string, string>;
  moduleInterfaceKeysBySourceId: CountingMap<string, string>;
  stableModuleInterfaces: CountingSet<string>;
  checkedProgramKeys: CountingSet<string>;
  functionChecks: CountingMap<string, unknown>;
  typeContractChecks: CountingSet<string>;
  backendLayouts: CountingMap<string, unknown>;
  backendLayoutPlans: CountingMap<string, unknown>;
  backendFunctions: CountingMap<string, unknown>;
  wasmFunctions: CountingWeakMap<object, unknown>;
  wasmNameSections: CountingMap<string, unknown>;
};

function createBenchCompileCache(): {
  cache: BenchCompileCache;
  stats?: BenchCacheCounters;
} {
  const cache = createCompileCache();
  if (!cacheStatsEnabled) return { cache };
  const linkedModules = new CountingMap<string, unknown>();
  const stableLinkedModuleKeys = new CountingSet<string>();
  const stableImportClosureKeys = new CountingSet<string>();
  const importClosures = new CountingMap<string, unknown>();
  const prunedImports = new CountingMap<string, unknown>();
  const prunedImportSelections = new CountingMap<string, unknown>();
  const qualifiedLocalImports = new CountingMap<string, unknown>();
  const moduleInterfaceKeys = new CountingMap<string, string>();
  const moduleInterfaceKeysBySourceId = new CountingMap<string, string>();
  const stableModuleInterfaces = new CountingSet<string>();
  const checkedProgramKeys = new CountingSet<string>();
  const functionChecks = new CountingMap<string, unknown>();
  const typeContractChecks = new CountingSet<string>();
  const backendLayouts = new CountingMap<string, unknown>();
  const backendLayoutPlans = new CountingMap<string, unknown>();
  const backendFunctions = new CountingMap<string, unknown>();
  const wasmFunctions = new CountingWeakMap<object, unknown>();
  const wasmNameSections = new CountingMap<string, unknown>();
  cache.linkedModules = linkedModules as BenchCompileCache["linkedModules"];
  cache.stableLinkedModuleKeys =
    stableLinkedModuleKeys as BenchCompileCache["stableLinkedModuleKeys"];
  cache.stableImportClosureKeys =
    stableImportClosureKeys as BenchCompileCache["stableImportClosureKeys"];
  cache.importClosures = importClosures as BenchCompileCache["importClosures"];
  cache.prunedImports = prunedImports as BenchCompileCache["prunedImports"];
  cache.prunedImportSelections =
    prunedImportSelections as BenchCompileCache["prunedImportSelections"];
  cache.qualifiedLocalImports = qualifiedLocalImports as BenchCompileCache["qualifiedLocalImports"];
  cache.moduleInterfaceKeys = moduleInterfaceKeys as BenchCompileCache["moduleInterfaceKeys"];
  cache.moduleInterfaceKeysBySourceId =
    moduleInterfaceKeysBySourceId as BenchCompileCache["moduleInterfaceKeysBySourceId"];
  cache.stableModuleInterfaces =
    stableModuleInterfaces as BenchCompileCache["stableModuleInterfaces"];
  cache.checkedProgramKeys = checkedProgramKeys as BenchCompileCache["checkedProgramKeys"];
  cache.functionChecks = functionChecks as BenchCompileCache["functionChecks"];
  cache.typeContractChecks = typeContractChecks;
  cache.backendLayouts = backendLayouts as BenchCompileCache["backendLayouts"];
  cache.backendLayoutPlans = backendLayoutPlans as BenchCompileCache["backendLayoutPlans"];
  cache.backendFunctions = backendFunctions as BenchCompileCache["backendFunctions"];
  cache.wasmFunctions = wasmFunctions as BenchCompileCache["wasmFunctions"];
  cache.wasmNameSections = wasmNameSections as BenchCompileCache["wasmNameSections"];
  return {
    cache,
    stats: {
      linkedModules,
      stableLinkedModuleKeys,
      stableImportClosureKeys,
      importClosures,
      prunedImports,
      prunedImportSelections,
      qualifiedLocalImports,
      moduleInterfaceKeys,
      moduleInterfaceKeysBySourceId,
      stableModuleInterfaces,
      checkedProgramKeys,
      functionChecks,
      typeContractChecks,
      backendLayouts,
      backendLayoutPlans,
      backendFunctions,
      wasmFunctions,
      wasmNameSections,
    },
  };
}

function snapshotCacheStats(stats: BenchCacheCounters | undefined): CacheStatsSample | undefined {
  if (!stats) return undefined;
  return {
    linkedModuleHits: stats.linkedModules.hits,
    linkedModuleMisses: stats.linkedModules.misses,
    stableLinkedModuleHits: stats.stableLinkedModuleKeys.hits,
    stableLinkedModuleMisses: stats.stableLinkedModuleKeys.misses,
    stableImportClosureHits: stats.stableImportClosureKeys.hits,
    stableImportClosureMisses: stats.stableImportClosureKeys.misses,
    importClosureHits: stats.importClosures.hits,
    importClosureMisses: stats.importClosures.misses,
    prunedImportHits: stats.prunedImports.hits,
    prunedImportMisses: stats.prunedImports.misses,
    prunedSelectionHits: stats.prunedImportSelections.hits,
    prunedSelectionMisses: stats.prunedImportSelections.misses,
    qualifiedLocalImportHits: stats.qualifiedLocalImports.hits,
    qualifiedLocalImportMisses: stats.qualifiedLocalImports.misses,
    moduleInterfaceHits: stats.moduleInterfaceKeys.hits,
    moduleInterfaceMisses: stats.moduleInterfaceKeys.misses,
    moduleInterfaceSourceHits: stats.moduleInterfaceKeysBySourceId.hits,
    moduleInterfaceSourceMisses: stats.moduleInterfaceKeysBySourceId.misses,
    stableModuleInterfaceHits: stats.stableModuleInterfaces.hits,
    stableModuleInterfaceMisses: stats.stableModuleInterfaces.misses,
    checkedProgramHits: stats.checkedProgramKeys.hits,
    checkedProgramMisses: stats.checkedProgramKeys.misses,
    functionCheckHits: stats.functionChecks.hits,
    functionCheckMisses: stats.functionChecks.misses,
    typeContractHits: stats.typeContractChecks.hits,
    typeContractMisses: stats.typeContractChecks.misses,
    backendLayoutHits: stats.backendLayouts.hits,
    backendLayoutMisses: stats.backendLayouts.misses,
    backendLayoutPlanHits: stats.backendLayoutPlans.hits,
    backendLayoutPlanMisses: stats.backendLayoutPlans.misses,
    backendFunctionHits: stats.backendFunctions.hits,
    backendFunctionMisses: stats.backendFunctions.misses,
    wasmFunctionHits: stats.wasmFunctions.hits,
    wasmFunctionMisses: stats.wasmFunctions.misses,
    wasmNameSectionHits: stats.wasmNameSections.hits,
    wasmNameSectionMisses: stats.wasmNameSections.misses,
  };
}

function diffCacheStats(
  before: CacheStatsSample | undefined,
  after: CacheStatsSample | undefined,
): CacheStatsSample | undefined {
  if (!before || !after) return undefined;
  return {
    linkedModuleHits: after.linkedModuleHits - before.linkedModuleHits,
    linkedModuleMisses: after.linkedModuleMisses - before.linkedModuleMisses,
    stableLinkedModuleHits: after.stableLinkedModuleHits - before.stableLinkedModuleHits,
    stableLinkedModuleMisses: after.stableLinkedModuleMisses - before.stableLinkedModuleMisses,
    stableImportClosureHits: after.stableImportClosureHits - before.stableImportClosureHits,
    stableImportClosureMisses: after.stableImportClosureMisses -
      before.stableImportClosureMisses,
    importClosureHits: after.importClosureHits - before.importClosureHits,
    importClosureMisses: after.importClosureMisses - before.importClosureMisses,
    prunedImportHits: after.prunedImportHits - before.prunedImportHits,
    prunedImportMisses: after.prunedImportMisses - before.prunedImportMisses,
    prunedSelectionHits: after.prunedSelectionHits - before.prunedSelectionHits,
    prunedSelectionMisses: after.prunedSelectionMisses - before.prunedSelectionMisses,
    qualifiedLocalImportHits: after.qualifiedLocalImportHits - before.qualifiedLocalImportHits,
    qualifiedLocalImportMisses: after.qualifiedLocalImportMisses -
      before.qualifiedLocalImportMisses,
    moduleInterfaceHits: after.moduleInterfaceHits - before.moduleInterfaceHits,
    moduleInterfaceMisses: after.moduleInterfaceMisses - before.moduleInterfaceMisses,
    moduleInterfaceSourceHits: after.moduleInterfaceSourceHits -
      before.moduleInterfaceSourceHits,
    moduleInterfaceSourceMisses: after.moduleInterfaceSourceMisses -
      before.moduleInterfaceSourceMisses,
    stableModuleInterfaceHits: after.stableModuleInterfaceHits -
      before.stableModuleInterfaceHits,
    stableModuleInterfaceMisses: after.stableModuleInterfaceMisses -
      before.stableModuleInterfaceMisses,
    checkedProgramHits: after.checkedProgramHits - before.checkedProgramHits,
    checkedProgramMisses: after.checkedProgramMisses - before.checkedProgramMisses,
    functionCheckHits: after.functionCheckHits - before.functionCheckHits,
    functionCheckMisses: after.functionCheckMisses - before.functionCheckMisses,
    typeContractHits: after.typeContractHits - before.typeContractHits,
    typeContractMisses: after.typeContractMisses - before.typeContractMisses,
    backendLayoutHits: after.backendLayoutHits - before.backendLayoutHits,
    backendLayoutMisses: after.backendLayoutMisses - before.backendLayoutMisses,
    backendLayoutPlanHits: after.backendLayoutPlanHits - before.backendLayoutPlanHits,
    backendLayoutPlanMisses: after.backendLayoutPlanMisses - before.backendLayoutPlanMisses,
    backendFunctionHits: after.backendFunctionHits - before.backendFunctionHits,
    backendFunctionMisses: after.backendFunctionMisses - before.backendFunctionMisses,
    wasmFunctionHits: after.wasmFunctionHits - before.wasmFunctionHits,
    wasmFunctionMisses: after.wasmFunctionMisses - before.wasmFunctionMisses,
    wasmNameSectionHits: after.wasmNameSectionHits - before.wasmNameSectionHits,
    wasmNameSectionMisses: after.wasmNameSectionMisses - before.wasmNameSectionMisses,
  };
}

async function compileFig(
  source: string,
  benchCache: { cache: BenchCompileCache; stats?: BenchCacheCounters },
): Promise<FigSample> {
  const compileTrace = traceEnabled ? [] : undefined;
  const cacheStatsBefore = snapshotCacheStats(benchCache.stats);
  const start = performance.now();
  const artifact = await compileArtifactsFromSource(source, {
    ...figOptions,
    cache: benchCache.cache,
    compileTrace,
  });
  return {
    wallMs: performance.now() - start,
    artifact,
    cacheStats: diffCacheStats(cacheStatsBefore, snapshotCacheStats(benchCache.stats)),
    trace: compileTrace,
  };
}

function printTraceSummary(events: CompileTraceEvent[], limit: number) {
  const totals = new Map<string, { name: string; calls: number; totalMs: number; maxMs: number }>();
  for (const event of events) {
    if (event.durationMs <= 0) continue;
    let total = totals.get(event.name);
    if (!total) {
      total = {
        name: event.name,
        calls: 0,
        totalMs: 0,
        maxMs: 0,
      };
      totals.set(event.name, total);
    }
    total.calls++;
    total.totalMs += event.durationMs;
    if (event.durationMs > total.maxMs) total.maxMs = event.durationMs;
  }
  const rows = [...totals.values()]
    .sort((left, right) => right.totalMs - left.totalMs)
    .slice(0, limit)
    .map((item) => {
      return {
        name: item.name,
        calls: item.calls,
        total_ms: item.totalMs.toFixed(3),
        max_ms: item.maxMs.toFixed(3),
        avg_ms: (item.totalMs / item.calls).toFixed(3),
      };
    });
  console.log(`trace_events=${events.length} trace_limit=${limit}`);
  console.table(rows);
}

async function benchGo(run: (index: number) => Promise<void>): Promise<number[]> {
  for (let index = 0; index < warmup; index++) await run(index);
  const result: number[] = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now();
    await run(warmup + index);
    result.push(performance.now() - start);
  }
  return result;
}

async function goBuild(out: string, cache: string): Promise<void> {
  const command = new Deno.Command("go", {
    args: ["build", "-buildvcs=false", "-o", out, "./cmd/app"],
    cwd: project.goDir,
    env: { GOCACHE: cache },
    stdout: "null",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
}

function semanticLeafEdit(source: string, index: number): string {
  const replacement = `seed + ${index + 4}`;
  const edited = source.replace("seed + 3", replacement);
  if (edited === source) throw new Error("could not find Fig semantic leaf edit site");
  return edited;
}

function semanticGoLeafEdit(source: string, index: number): string {
  const replacement = `seed + ${index + 4}`;
  const edited = source.replace("seed + 3", replacement);
  if (edited === source) throw new Error("could not find Go semantic leaf edit site");
  return edited;
}

function figRow(mode: string, samples: FigSample[], baseline: number): Row {
  const walls = samples.map((sample) => sample.wallMs);
  const timings = samples.map((sample) => sample.artifact.timings);
  const row: Row = {
    runtime: "fig",
    mode,
    samples: samples.length,
    median_ms: median(walls).toFixed(3),
    p90_ms: p90(walls).toFixed(3),
    parse_ms: median(timings.map((item) => item.parseMs)).toFixed(3),
    import_ms: median(timings.map((item) => item.importMs)).toFixed(3),
    check_ms: median(timings.map((item) => item.checkMs)).toFixed(3),
    backend_ms: median(timings.map((item) => item.backendMs)).toFixed(3),
    backend_layout_ms: median(timings.map((item) => item.backendLayoutMs)).toFixed(3),
    backend_lower_ms: median(timings.map((item) => item.backendLowerMs)).toFixed(3),
    backend_cleanup_ms: median(timings.map((item) => item.backendCleanupMs)).toFixed(3),
    wasm_encode_ms: median(timings.map((item) => item.wasmEncodeMs)).toFixed(3),
    speedup_vs_fig_uncached: speedupText(baseline, median(walls)),
  };
  const stats = samples
    .map((sample) => sample.cacheStats)
    .filter((sample): sample is CacheStatsSample => Boolean(sample));
  if (stats.length) {
    row.linked_hits = median(stats.map((item) => item.linkedModuleHits)).toFixed(0);
    row.linked_misses = median(stats.map((item) => item.linkedModuleMisses)).toFixed(0);
    row.stable_linked_hits = median(stats.map((item) => item.stableLinkedModuleHits)).toFixed(0);
    row.stable_linked_misses = median(stats.map((item) => item.stableLinkedModuleMisses)).toFixed(
      0,
    );
    row.stable_closure_hits = median(stats.map((item) => item.stableImportClosureHits)).toFixed(0);
    row.stable_closure_misses = median(stats.map((item) => item.stableImportClosureMisses))
      .toFixed(0);
    row.closure_hits = median(stats.map((item) => item.importClosureHits)).toFixed(0);
    row.closure_misses = median(stats.map((item) => item.importClosureMisses)).toFixed(0);
    row.pruned_hits = median(stats.map((item) => item.prunedImportHits)).toFixed(0);
    row.pruned_misses = median(stats.map((item) => item.prunedImportMisses)).toFixed(0);
    row.pruned_selection_hits = median(stats.map((item) => item.prunedSelectionHits)).toFixed(0);
    row.pruned_selection_misses = median(stats.map((item) => item.prunedSelectionMisses)).toFixed(
      0,
    );
    row.local_import_hits = median(stats.map((item) => item.qualifiedLocalImportHits)).toFixed(0);
    row.local_import_misses = median(stats.map((item) => item.qualifiedLocalImportMisses))
      .toFixed(0);
    row.interface_hits = median(stats.map((item) => item.moduleInterfaceHits)).toFixed(0);
    row.interface_misses = median(stats.map((item) => item.moduleInterfaceMisses)).toFixed(0);
    row.interface_source_hits = median(stats.map((item) => item.moduleInterfaceSourceHits))
      .toFixed(0);
    row.interface_source_misses = median(stats.map((item) => item.moduleInterfaceSourceMisses))
      .toFixed(0);
    row.stable_interface_hits = median(stats.map((item) => item.stableModuleInterfaceHits))
      .toFixed(0);
    row.stable_interface_misses = median(stats.map((item) => item.stableModuleInterfaceMisses))
      .toFixed(0);
    row.checked_program_hits = median(stats.map((item) => item.checkedProgramHits)).toFixed(0);
    row.checked_program_misses = median(stats.map((item) => item.checkedProgramMisses)).toFixed(0);
    row.fn_check_hits = median(stats.map((item) => item.functionCheckHits)).toFixed(0);
    row.fn_check_misses = median(stats.map((item) => item.functionCheckMisses)).toFixed(0);
    row.type_contract_hits = median(stats.map((item) => item.typeContractHits)).toFixed(0);
    row.type_contract_misses = median(stats.map((item) => item.typeContractMisses)).toFixed(0);
    row.backend_layout_hits = median(stats.map((item) => item.backendLayoutHits)).toFixed(0);
    row.backend_layout_misses = median(stats.map((item) => item.backendLayoutMisses)).toFixed(0);
    row.backend_layout_plan_hits = median(stats.map((item) => item.backendLayoutPlanHits))
      .toFixed(0);
    row.backend_layout_plan_misses = median(stats.map((item) => item.backendLayoutPlanMisses))
      .toFixed(0);
    row.backend_fn_hits = median(stats.map((item) => item.backendFunctionHits)).toFixed(0);
    row.backend_fn_misses = median(stats.map((item) => item.backendFunctionMisses)).toFixed(0);
    row.wasm_fn_hits = median(stats.map((item) => item.wasmFunctionHits)).toFixed(0);
    row.wasm_fn_misses = median(stats.map((item) => item.wasmFunctionMisses)).toFixed(0);
    row.wasm_name_hits = median(stats.map((item) => item.wasmNameSectionHits)).toFixed(0);
    row.wasm_name_misses = median(stats.map((item) => item.wasmNameSectionMisses)).toFixed(0);
  }
  return row;
}

function goRow(mode: string, samples: number[], baseline: number): Row {
  return {
    runtime: "go",
    mode,
    samples: samples.length,
    median_ms: median(samples).toFixed(3),
    p90_ms: p90(samples).toFixed(3),
    speedup_vs_fig_uncached: speedupText(baseline, median(samples)),
  };
}

function speedupText(baseline: number, value: number): string {
  return baseline > 0 && value > 0 ? (baseline / value).toFixed(2) : "";
}

function shouldRun(mode: BenchMode): boolean {
  return !selectedModes || selectedModes.includes(mode);
}

function selectedModeArgs(): BenchMode[] | undefined {
  const values: BenchMode[] = [];
  for (const arg of Deno.args) {
    if (!arg.startsWith("--mode=")) continue;
    for (const raw of arg.slice("--mode=".length).split(",")) {
      const value = raw.trim();
      if (!value) continue;
      if (!isBenchMode(value)) throw new Error(`${value} is not a benchmark mode`);
      values.push(value);
    }
  }
  const modeFlagIndex = Deno.args.indexOf("--mode");
  if (modeFlagIndex >= 0) {
    const raw = Deno.args[modeFlagIndex + 1];
    if (!raw) throw new Error("--mode requires a value");
    for (const value of raw.split(",")) {
      const mode = value.trim();
      if (!mode) continue;
      if (!isBenchMode(mode)) throw new Error(`${mode} is not a benchmark mode`);
      values.push(mode);
    }
  }
  return values.length ? values : undefined;
}

function isBenchMode(value: string): value is BenchMode {
  return value === "full_uncached" ||
    value === "full_shared_cache" ||
    value === "session_root_edit" ||
    value === "session_leaf_edit" ||
    value === "session_leaf_semantic_edit" ||
    value === "build_cold_cache" ||
    value === "build_warm_noop" ||
    value === "build_root_edit" ||
    value === "build_leaf_edit" ||
    value === "build_leaf_semantic_edit";
}

function numberArg(name: string, fallback: number): number {
  const eq = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  const raw = eq ? eq.slice(name.length + 1) : Deno.args[Deno.args.indexOf(name) + 1];
  if (!raw || Deno.args.indexOf(name) < 0 && !eq) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return Math.floor(value);
}

function scenarioArg(name: string, fallback: BenchmarkScenario): BenchmarkScenario {
  const eq = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  const raw = eq ? eq.slice(name.length + 1) : Deno.args[Deno.args.indexOf(name) + 1];
  if (!raw || Deno.args.indexOf(name) < 0 && !eq) return fallback;
  if (raw === "kernels" || raw === "abstractions") return raw;
  throw new Error(`${name} must be kernels or abstractions`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function p90(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0;
}
