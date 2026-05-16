import {
  compileArtifactsFromSource,
  type CompileTraceEvent,
  createCompileCache,
  type OptimizeProfileName,
} from "../src/mod.ts";

type Row = {
  scenario: string;
  profile: OptimizeProfileName;
  parse_ms: string;
  import_ms: string;
  check_ms: string;
  optimize_ms: string;
  layout_ms: string;
  lower_ms: string;
  cleanup_ms: string;
  wat_render_ms: string;
  wasm_encode_ms: string;
  total_with_wat_ms: string;
  total_wasm_only_ms: string;
  wat_bytes: number;
  wasm_bytes: number;
  loops: number;
  recursive_calls: number;
  function_calls: number;
  slowest_optimizer_phase: string;
  optimizer_passes: number;
  optimizer_touched_functions: number;
};

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
  rows.push({
    scenario: item.scenario,
    profile: item.profile,
    parse_ms: timings.parseMs.toFixed(3),
    import_ms: timings.importMs.toFixed(3),
    check_ms: timings.checkMs.toFixed(3),
    optimize_ms: timings.optimizeMs.toFixed(3),
    layout_ms: timings.backendLayoutMs.toFixed(3),
    lower_ms: timings.backendLowerMs.toFixed(3),
    cleanup_ms: timings.backendCleanupMs.toFixed(3),
    wat_render_ms: timings.watRenderMs.toFixed(3),
    wasm_encode_ms: timings.wasmEncodeMs.toFixed(3),
    total_with_wat_ms: (
      timings.parseMs + timings.importMs + timings.checkMs + timings.backendMs +
      timings.watRenderMs + timings.wasmEncodeMs
    ).toFixed(3),
    total_wasm_only_ms: (
      timings.parseMs + timings.importMs + timings.checkMs + timings.backendMs +
      timings.wasmEncodeMs
    ).toFixed(3),
    wat_bytes: wat.length,
    wasm_bytes: artifact.wasm.byteLength,
    loops: count(wat, /\bloop\b/g),
    recursive_calls: recursiveCallCount(wat),
    function_calls: count(wat, /\bcall \$/g),
    slowest_optimizer_phase: slowestOptimizerPhase(trace),
    optimizer_passes: optimizerPasses(trace),
    optimizer_touched_functions: optimizerTouchedFunctions(trace),
  });
}

console.table(rows);

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
      const count = event.counters?.changedFunctions;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
