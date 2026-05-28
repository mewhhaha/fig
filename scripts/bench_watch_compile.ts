import {
  compileArtifactsFromSource,
  type CompileArtifactsResult,
  type CompileSourceOptions,
  createCompileCache,
  createCompilerSession,
  type ModuleResolveContext,
  type ModuleSource,
} from "../src/mod.ts";
import type { OptimizeProfileName } from "../src/unstable.ts";
import { candidateModulePaths } from "../src/lsp/modules.ts";

type Mode =
  | "full_uncached"
  | "full_shared_cache"
  | "watch_session_same_source"
  | "watch_session_root_edit"
  | "watch_session_import_edit"
  | "watch_session_import_semantic_edit";

type Sample = {
  wallMs: number;
  parseMs: number;
  importMs: number;
  checkMs: number;
  backendMs: number;
  wasmEncodeMs: number;
  wasmBytes: number;
  dependencies: number;
};

type Row = {
  mode: Mode;
  samples: number;
  wall_median_ms: string;
  wall_p90_ms: string;
  parse_median_ms: string;
  import_median_ms: string;
  check_median_ms: string;
  backend_median_ms: string;
  wasm_encode_median_ms: string;
  speedup_vs_full_uncached: string;
  wasm_bytes: number;
  dependencies: number;
};

const file = stringArg("--file") ?? "examples/prelude_std.fig";
const samples = numberArg("--samples", 9);
const warmup = numberArg("--warmup", 2);
const optMode = Deno.args.includes("--release") ? "release" : "debug";
const profile = stringArg("--profile") as OptimizeProfileName | undefined;
const selectedMode = stringArg("--mode") as Mode | undefined;
const rootSourceId = sourceIdForPath(file);
const rootSource = await Deno.readTextFile(file);
const overlay = new Map<string, string>();
let resolvedSourceIds = new Set<string>();
const baseOptions: Omit<CompileSourceOptions, "resolveModule" | "cache"> = {
  sourceId: rootSourceId,
  pruneImports: true,
  optMode,
  ...(profile ? { profile } : {}),
};

const allModes: Mode[] = [
  "full_uncached",
  "full_shared_cache",
  "watch_session_same_source",
  "watch_session_root_edit",
  "watch_session_import_edit",
  "watch_session_import_semantic_edit",
];
const modes = selectedMode ? selectedBenchmarkModes(selectedMode, allModes) : allModes;

const rows: Row[] = [];
let baselineMs = 0;
for (const mode of modes) {
  overlay.clear();
  const modeSamples = await benchMode(mode);
  if (mode === "full_uncached") baselineMs = median(modeSamples.map((sample) => sample.wallMs));
  const wallMedian = median(modeSamples.map((sample) => sample.wallMs));
  const representative = modeSamples[Math.floor(modeSamples.length / 2)]!;
  rows.push({
    mode,
    samples,
    wall_median_ms: wallMedian.toFixed(3),
    wall_p90_ms: p90(modeSamples.map((sample) => sample.wallMs)).toFixed(3),
    parse_median_ms: median(modeSamples.map((sample) => sample.parseMs)).toFixed(3),
    import_median_ms: median(modeSamples.map((sample) => sample.importMs)).toFixed(3),
    check_median_ms: median(modeSamples.map((sample) => sample.checkMs)).toFixed(3),
    backend_median_ms: median(modeSamples.map((sample) => sample.backendMs)).toFixed(3),
    wasm_encode_median_ms: median(modeSamples.map((sample) => sample.wasmEncodeMs)).toFixed(3),
    speedup_vs_full_uncached: baselineMs > 0 ? (baselineMs / wallMedian).toFixed(2) : "1.00",
    wasm_bytes: representative.wasmBytes,
    dependencies: representative.dependencies,
  });
}

console.log(`file=${file} optMode=${optMode} samples=${samples} warmup=${warmup}`);
console.table(rows);

async function benchMode(mode: Mode): Promise<Sample[]> {
  const run = sampleRunner(mode);
  for (let index = 0; index < warmup; index++) {
    await run(index, false);
  }
  const measured: Sample[] = [];
  for (let index = 0; index < samples; index++) {
    measured.push(await run(index, true));
  }
  return measured;
}

function sampleRunner(mode: Mode): (index: number, measured: boolean) => Promise<Sample> {
  if (mode === "full_uncached") {
    return () => compileFull(rootSource, createCompileCache());
  }
  if (mode === "full_shared_cache") {
    const cache = createCompileCache();
    return () => compileFull(rootSource, cache);
  }

  const session = createCompilerSession({
    ...baseOptions,
    resolveModule,
    includeWat: false,
  });
  let importEditSourceId: string | undefined;
  let semanticImportEditSourceId: string | undefined;
  return async (index, measured) => {
    let source = rootSource;
    if (mode === "watch_session_root_edit") {
      source = `${rootSource}\n// watch root edit ${index} ${measured ? "measured" : "warmup"}`;
    }
    if (mode === "watch_session_import_edit" && importEditSourceId) {
      const original = overlay.get(importEditSourceId) ??
        await Deno.readTextFile(importEditSourceId);
      const edited = `${original}\n// watch import edit ${index} ${
        measured ? "measured" : "warmup"
      }`;
      overlay.set(importEditSourceId, edited);
      session.update({ sourceId: importEditSourceId, text: edited });
    }
    if (mode === "watch_session_import_semantic_edit" && semanticImportEditSourceId) {
      const original = await Deno.readTextFile(semanticImportEditSourceId);
      const edited = semanticImportEdit(original, index + (measured ? warmup : 0));
      if (!edited) {
        throw new Error("could not find a stable semantic edit site in imported module");
      }
      overlay.set(semanticImportEditSourceId, edited);
      session.update({ sourceId: semanticImportEditSourceId, text: edited });
    }
    const start = performance.now();
    const result = await session.compileRoot({ text: source, sourceId: rootSourceId }, {
      includeWat: false,
    });
    const wallMs = performance.now() - start;
    if (!result.ok) {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    }
    importEditSourceId ??= result.dependencies[0]?.sourceId;
    semanticImportEditSourceId ??= await firstSemanticImportEditSourceId(
      result.dependencies.map((dependency) => dependency.sourceId),
    );
    return sampleFromArtifact(result.artifact, wallMs, result.dependencies.length);
  };
}

async function compileFull(
  source: string,
  cache: ReturnType<typeof createCompileCache>,
): Promise<Sample> {
  const start = performance.now();
  resolvedSourceIds = new Set();
  const artifact = await compileArtifactsFromSource(source, {
    ...baseOptions,
    resolveModule,
    cache,
    includeWat: false,
  });
  const wallMs = performance.now() - start;
  return sampleFromArtifact(artifact, wallMs, resolvedSourceIds.size);
}

function sampleFromArtifact(
  artifact: CompileArtifactsResult,
  wallMs: number,
  dependencies: number,
): Sample {
  return {
    wallMs,
    parseMs: artifact.timings.parseMs,
    importMs: artifact.timings.importMs,
    checkMs: artifact.timings.checkMs,
    backendMs: artifact.timings.backendMs,
    wasmEncodeMs: artifact.timings.wasmEncodeMs,
    wasmBytes: artifact.wasm.byteLength,
    dependencies,
  };
}

async function firstSemanticImportEditSourceId(
  sourceIds: readonly string[],
): Promise<string | undefined> {
  for (const sourceId of sourceIds) {
    try {
      if (semanticImportEdit(await Deno.readTextFile(sourceId), 1)) return sourceId;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return undefined;
}

function semanticImportEdit(source: string, index: number): string | undefined {
  const replacement = `+ ${index % 17}`;
  if (source.includes("+ 0")) return source.replace("+ 0", replacement);
  if (source.includes("- 0")) return source.replace("- 0", replacement);
  const fnLine = source.match(/^fn [^{\n]+\{([^{}\n]+)\}$/m);
  if (fnLine) {
    return source.replace(fnLine[0], fnLine[0].replace("}", ` ${replacement} }`));
  }
  return undefined;
}

async function resolveModule(
  moduleName: string,
  context?: ModuleResolveContext,
): Promise<ModuleSource | undefined> {
  const importer = context?.fromSourceId && isPathLikeSourceId(context.fromSourceId)
    ? sourceIdToPath(context.fromSourceId)
    : rootSourceId;
  for (const path of candidateModulePaths(importer, moduleName)) {
    try {
      const text = overlay.get(path) ?? await Deno.readTextFile(path);
      resolvedSourceIds.add(path);
      return {
        text,
        sourceId: path,
      };
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return undefined;
}

function sourceIdForPath(path: string): string {
  return new URL(path, `file://${Deno.cwd()}/`).pathname;
}

function sourceIdToPath(sourceId: string): string {
  return sourceId.startsWith("file://") ? new URL(sourceId).pathname : sourceId;
}

function isPathLikeSourceId(sourceId: string): boolean {
  return sourceId.startsWith("/") || sourceId.startsWith("./") || sourceId.startsWith("../") ||
    sourceId.startsWith("file://");
}

function stringArg(name: string): string | undefined {
  const eq = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

function numberArg(name: string, fallback: number): number {
  const raw = stringArg(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

function selectedBenchmarkModes(mode: Mode, allModes: Mode[]): Mode[] {
  if (!allModes.includes(mode)) {
    throw new Error(`${mode} is not a benchmark mode`);
  }
  return [mode];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function p90(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0;
}
