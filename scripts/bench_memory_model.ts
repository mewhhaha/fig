import { wasmFromSource, watFromSource } from "../src/mod.ts";

interface Scenario {
  name: string;
  source: string;
  expected: number | number[];
  args?: number[];
  callsDivisor?: number;
  notes: string;
}

const iterations = Number(Deno.args.find((arg) => arg !== "--") ?? 100_000);

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

const matmulArgs = [
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  1,
  5,
  9,
  13,
  2,
  6,
  10,
  14,
  3,
  7,
  11,
  15,
  4,
  8,
  12,
  16,
];

const scenarios: Scenario[] = [
  {
    name: "scalar_reuse_nway",
    expected: 40,
    notes: "Repeated scalar reads should lower to direct local.get use, with no copy helper.",
    source: `
      pub fn main() -> i32 {
        let x = 10;
        x + x + x + x
      }
    `,
  },
  {
    name: "product_shadow_update",
    expected: 36,
    notes: "Product values are reused and shadowed without fork; flattened fields stay scalar.",
    source: `
      type fn Vec2() -> type {
        let Vec2 = {x: i32, y: i32};
        struct(Vec2)
      }
      fn Vec2.translate(point: Vec2, dx: i32, dy: i32) -> Vec2 {
        Vec2 {x: point.x + dx, y: point.y + dy}
      }
      fn Vec2.score(point: Vec2) -> i32 { point.x + point.y }
      pub fn main() -> i32 {
        let point: Vec2 = Vec2 {x: 1, y: 2};
        let moved = Vec2.translate(point, 10, 0);
        let moved = Vec2.translate(moved, 0, 20);
        Vec2.score(point) + Vec2.score(moved)
      }
    `,
  },
  {
    name: "tail_product_loop_1k",
    expected: 500_500,
    callsDivisor: 20,
    notes:
      "Hot tail loop repeatedly returns updated products through shadowed memory-model values.",
    source: `
      type fn Acc() -> type {
        let Acc = {sum: i32, ticks: i32};
        struct(Acc)
      }
      fn run_loop(i: i32, limit: i32, acc: Acc) -> Acc {
        match i < limit {
          true => run_loop(i + 1, limit, Acc {sum: acc.sum + i, ticks: acc.ticks + 1}),
          false => acc,
        }
      }
      pub fn main() -> i32 {
        let start: Acc = Acc {sum: 0, ticks: 0};
        let out = run_loop(0, 1000, start);
        out.sum + out.ticks
      }
    `,
  },
  {
    name: "inline_array_builder_map",
    expected: 19,
    callsDivisor: 4,
    notes: "InlineArray tabulate/map use builder cursor loops and product-like aliases.",
    source: `
      const layout = @import("prelude.layout");
      fn make(i: layout.core.Index(16)) -> i32 { i + 1 }
      fn inc(x: i32) -> i32 { x + 1 }
      pub fn main() -> i32 {
        let xs = layout.InlineArray.tabulate(16, i32, make);
        let ys = layout.InlineArray.map(16, i32, i32, xs, inc);
        ys[0] + ys[15]
      }
    `,
  },
  {
    name: "compact_filter_collect",
    expected: 2,
    callsDivisor: 2,
    notes: "Iterator filter/map/collect builds a CompactArray without heap allocation.",
    source: `
      const array = @import("prelude.array_static");
      fn inc(x: i32) -> i32 { x + 1 }
      fn keep(x: i32) -> bool { x > 2 }
      pub fn main() -> i32 {
        let xs: array.layout.Lane4I32 = <1, 2, 3, 4>;
        let out: array.CompactArray(4, i32) = array.Iter.collect(
          array.Iter.map(array.Iter.filter(array.layout.InlineArray.Iter(xs), keep), inc)
        );
        out.len
      }
    `,
  },
  {
    name: "range_fold_1k",
    expected: 499_500,
    callsDivisor: 20,
    notes: "Range fold lowers to a Wasm loop over scalar state.",
    source: `
      const array = @import("prelude.array_static");
      fn add(acc: i32, x: i32) -> i32 { acc + x }
      pub fn main() -> i32 {
        array.RangeIter.fold(array.RangeI32.Iter(0 .. 1000), 0, add)
      }
    `,
  },
  {
    name: "simd_mat4_kernel",
    expected: [
      90,
      100,
      110,
      120,
      202,
      228,
      254,
      280,
      314,
      356,
      398,
      440,
      426,
      484,
      542,
      600,
    ],
    args: matmulArgs,
    notes: "High-throughput fixed matrix kernel; expected to lower to SIMD dot products.",
    source: await Deno.readTextFile("examples/perf_matmul_simd.fig"),
  },
];

const rows = [];
for (const scenario of scenarios) {
  let wat: string;
  let wasm: Uint8Array<ArrayBuffer>;
  try {
    wat = await watFromSource(scenario.source, { resolveModule });
    wasm = await wasmFromSource(scenario.source, { resolveModule });
  } catch (error) {
    throw new Error(`failed to compile benchmark scenario ${scenario.name}: ${String(error)}`);
  }
  const mainWat = mainFunctionWat(wat);
  const main = new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports
    .main as CallableFunction;
  const warmup = callMain(main, scenario.args);
  assertExpected(scenario.name, warmup, scenario.expected);

  const calls = Math.max(1, Math.floor(iterations / (scenario.callsDivisor ?? 1)));
  const timed = timeCalls(main, scenario.args, calls);
  rows.push({
    scenario: scenario.name,
    calls,
    checksum: timed.checksum,
    elapsed_ms: timed.elapsedMs.toFixed(3),
    calls_per_ms: (calls / timed.elapsedMs).toFixed(3),
    ns_per_call: ((timed.elapsedMs * 1_000_000) / calls).toFixed(1),
    wat_bytes: wat.length,
    main_locals: count(mainWat, /\(local \$/g),
    local_gets: count(mainWat, /\blocal\.get \$/g),
    local_sets: count(mainWat, /\blocal\.set \$/g),
    loops: count(wat, /\bloop\b/g),
    simd_ops: count(wat, /\bi(?:8|16|32|64|f32|f64)x[0-9]+\./g),
    notes: scenario.notes,
  });
}

console.table(rows);

function callMain(main: CallableFunction, args: number[] = []): number | number[] {
  return main(...args) as number | number[];
}

function timeCalls(
  main: CallableFunction,
  args: number[] = [],
  calls: number,
): { elapsedMs: number; checksum: number } {
  const start = performance.now();
  let checksum = 0;
  for (let index = 0; index < calls; index++) {
    const result = callMain(main, args);
    checksum += Array.isArray(result) ? result[0] : result;
  }
  return { elapsedMs: performance.now() - start, checksum };
}

function assertExpected(name: string, actual: number | number[], expected: number | number[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${name} expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function mainFunctionWat(wat: string): string {
  return wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}
