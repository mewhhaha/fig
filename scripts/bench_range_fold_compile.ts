import {
  compileArtifactsFromSource,
  type CompileTraceEvent,
  createCompileCache,
} from "../src/mod.ts";
import type { OptimizeProfileName } from "../src/unstable.ts";

type Row = {
  scenario: string;
  profile: OptimizeProfileName;
  iterations: number;
  parse_median_ms: string;
  import_median_ms: string;
  check_median_ms: string;
  optimize_median_ms: string;
  optimize_p90_ms: string;
  layout_median_ms: string;
  lower_median_ms: string;
  cleanup_median_ms: string;
  wat_render_median_ms: string;
  wasm_encode_median_ms: string;
  total_with_wat_median_ms: string;
  total_with_wat_p90_ms: string;
  total_wasm_only_median_ms: string;
  total_wasm_only_p90_ms: string;
  wat_bytes: number;
  wasm_bytes: number;
  loops: number;
  recursive_calls: number;
  function_calls: number;
  slowest_optimizer_phase: string;
  optimizer_passes: number;
  optimizer_touched_functions: number;
};

type Sample = {
  trace: CompileTraceEvent[];
  parseMs: number;
  importMs: number;
  checkMs: number;
  optimizeMs: number;
  layoutMs: number;
  lowerMs: number;
  cleanupMs: number;
  watRenderMs: number;
  wasmEncodeMs: number;
  totalWithWatMs: number;
  totalWasmOnlyMs: number;
  watBytes: number;
  wasmBytes: number;
  loops: number;
  recursiveCalls: number;
  functionCalls: number;
};

const warmupIterations = 1;
const measuredIterations = 7;
const cache = createCompileCache();
const cases: { scenario: string; profile: OptimizeProfileName; source: string }[] = [
  { scenario: "direct_loop", profile: "release_balanced", source: directLoopSource() },
  { scenario: "user_wrapper_fold", profile: "release_balanced", source: userWrapperFoldSource() },
  { scenario: "prelude_range_fold", profile: "release_balanced", source: preludeRangeFoldSource() },
  {
    scenario: "prelude_range_fold_fast_compile",
    profile: "release_fast_compile",
    source: preludeRangeFoldSource(),
  },
  {
    scenario: "prelude_range_fold_balanced",
    profile: "release_balanced",
    source: preludeRangeFoldSource(),
  },
];

const rows: Row[] = [];
for (const item of cases) {
  for (let index = 0; index < warmupIterations; index++) {
    await compileSample(item);
  }
  const samples: Sample[] = [];
  for (let index = 0; index < measuredIterations; index++) {
    samples.push(await compileSample(item));
  }
  const representative = samples[Math.floor(samples.length / 2)]!;
  rows.push({
    scenario: item.scenario,
    profile: item.profile,
    iterations: measuredIterations,
    parse_median_ms: formatStat(samples, (sample) => sample.parseMs, median),
    import_median_ms: formatStat(samples, (sample) => sample.importMs, median),
    check_median_ms: formatStat(samples, (sample) => sample.checkMs, median),
    optimize_median_ms: formatStat(samples, (sample) => sample.optimizeMs, median),
    optimize_p90_ms: formatStat(samples, (sample) => sample.optimizeMs, p90),
    layout_median_ms: formatStat(samples, (sample) => sample.layoutMs, median),
    lower_median_ms: formatStat(samples, (sample) => sample.lowerMs, median),
    cleanup_median_ms: formatStat(samples, (sample) => sample.cleanupMs, median),
    wat_render_median_ms: formatStat(samples, (sample) => sample.watRenderMs, median),
    wasm_encode_median_ms: formatStat(samples, (sample) => sample.wasmEncodeMs, median),
    total_with_wat_median_ms: formatStat(samples, (sample) => sample.totalWithWatMs, median),
    total_with_wat_p90_ms: formatStat(samples, (sample) => sample.totalWithWatMs, p90),
    total_wasm_only_median_ms: formatStat(samples, (sample) => sample.totalWasmOnlyMs, median),
    total_wasm_only_p90_ms: formatStat(samples, (sample) => sample.totalWasmOnlyMs, p90),
    wat_bytes: representative.watBytes,
    wasm_bytes: representative.wasmBytes,
    loops: representative.loops,
    recursive_calls: representative.recursiveCalls,
    function_calls: representative.functionCalls,
    slowest_optimizer_phase: slowestOptimizerPhase(representative.trace),
    optimizer_passes: optimizerPasses(representative.trace),
    optimizer_touched_functions: optimizerTouchedFunctions(representative.trace),
  });
}

console.table(rows);

async function compileSample(item: {
  scenario: string;
  profile: OptimizeProfileName;
  source: string;
}): Promise<Sample> {
  const trace: CompileTraceEvent[] = [];
  const artifact = await compileArtifactsFromSource(item.source, {
    resolveModule: resolveProjectModule,
    pruneImports: true,
    optMode: "release",
    profile: item.profile,
    memoryModel: "branch",
    cache,
    compileTrace: trace,
  });
  const wat = artifact.wat ?? "";
  const timings = artifact.timings;
  const totalWithWatMs = timings.parseMs + timings.importMs + timings.checkMs + timings.backendMs +
    timings.watRenderMs + timings.wasmEncodeMs;
  const totalWasmOnlyMs = timings.parseMs + timings.importMs + timings.checkMs + timings.backendMs +
    timings.wasmEncodeMs;
  return {
    trace,
    parseMs: timings.parseMs,
    importMs: timings.importMs,
    checkMs: timings.checkMs,
    optimizeMs: timings.optimizeMs,
    layoutMs: timings.backendLayoutMs,
    lowerMs: timings.backendLowerMs,
    cleanupMs: timings.backendCleanupMs,
    watRenderMs: timings.watRenderMs,
    wasmEncodeMs: timings.wasmEncodeMs,
    totalWithWatMs,
    totalWasmOnlyMs,
    watBytes: wat.length,
    wasmBytes: artifact.wasm.byteLength,
    loops: count(wat, /\bloop\b/g),
    recursiveCalls: recursiveCallCount(wat),
    functionCalls: count(wat, /\bcall \$/g),
  };
}

function directLoopSource(): string {
  return `
    fn loop(i: i32, end: i32, acc: i32) -> i32 {
      match i < end {
        true => loop(i + 1, end, acc + i),
        false => acc,
      }
    }
    pub fn main(seed: i32) -> i32 {
      loop(seed - seed, 1000, 0)
    }
  `;
}

function userWrapperFoldSource(): string {
  return `
    type fn Iter() {
      let Iter = {start: i32, end: i32};
      struct(Iter)
    }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn make_iter(start: i32, end: i32) -> Iter {
      Iter {start: start, end: end}
    }
    fn fold(iter: Iter, init: i32) -> i32 {
      fold_loop(iter.start, iter.end, init)
    }
    fn fold_loop(i: i32, end: i32, acc: i32) -> i32 {
      match i < end {
        true => fold_loop(i + 1, end, add(acc, i)),
        false => acc,
      }
    }
    pub fn main(seed: i32) -> i32 {
      fold(make_iter(seed - seed, 1000), 0)
    }
  `;
}

function preludeRangeFoldSource(): string {
  return `
    const range = @import("prelude.range");
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main(seed: i32) -> i32 {
      range.RangeIter::fold(range.RangeI32::Iter(seed - seed .. 1000), 0, add)
    }
  `;
}

function resolveProjectModule(moduleName: string): string | undefined {
  try {
    return Deno.readTextFileSync(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
}

function slowestOptimizerPhase(trace: CompileTraceEvent[]): string {
  const phase = trace
    .filter((event) => event.name.startsWith("opt."))
    .toSorted((left, right) => right.durationMs - left.durationMs)[0];
  return phase ? `${phase.name}:${phase.durationMs.toFixed(3)}ms` : "";
}

function optimizerPasses(trace: CompileTraceEvent[]): number {
  const passes = new Set<number>();
  for (const event of trace) {
    const pass = event.counters?.pass;
    if (typeof pass === "number") passes.add(pass);
  }
  return passes.size;
}

function optimizerTouchedFunctions(trace: CompileTraceEvent[]): number {
  return trace
    .filter((event) => event.name.endsWith(".optimizeDecls"))
    .reduce((max, event) => {
      const count = event.counters?.optimizedFunctions ?? event.counters?.changedFunctions;
      return typeof count === "number" ? Math.max(max, count) : max;
    }, 0);
}

function recursiveCallCount(wat: string): number {
  let recursive = 0;
  const fnPattern = /\(func \$([^\s)]+)[\s\S]*?\n  \)/g;
  for (const match of wat.matchAll(fnPattern)) {
    const [, name] = match;
    const body = match[0];
    recursive += count(body, new RegExp(`\\bcall \\$${escapeRegExp(name)}\\b`, "g"));
    recursive += count(body, new RegExp(`\\breturn_call \\$${escapeRegExp(name)}\\b`, "g"));
  }
  return recursive;
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function formatStat(
  samples: Sample[],
  select: (sample: Sample) => number,
  summarize: (values: number[]) => number,
): string {
  return summarize(samples.map(select)).toFixed(3);
}

function median(values: number[]): number {
  const sorted = [...values].toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function p90(values: number[]): number {
  const sorted = [...values].toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
