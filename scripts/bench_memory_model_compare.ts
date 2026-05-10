import { wasmFromSource, watFromSource } from "../src/mod.ts";

interface FigScenario {
  name: ScenarioName;
  source: string;
  expected: number;
  callsDivisor?: number;
}

type ScenarioName =
  | "scalar_reuse_nway"
  | "product_shadow_update"
  | "tail_product_loop_1k"
  | "inline_array_builder_map"
  | "compact_filter_collect"
  | "range_fold_1k"
  | "mat4_kernel";

interface Row {
  runtime: "fig_wasm" | "javascript" | "rust";
  scenario: ScenarioName;
  calls: number;
  checksum: number;
  elapsed_ms: string;
  calls_per_ms: string;
  ns_per_call: string;
  detail?: string;
}

const iterations = Number(Deno.args.find((arg) => arg !== "--") ?? 100_000);
const simdMat4Source = await Deno.readTextFile("examples/perf_matmul_simd.fig");

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

const figScenarios: FigScenario[] = [
  {
    name: "scalar_reuse_nway",
    expected: 40,
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
    source: `
      const array = @import("prelude.array_static");
      fn add(acc: i32, x: i32) -> i32 { acc + x }
      pub fn main() -> i32 {
        array.RangeIter.fold(array.RangeI32.Iter(0 .. 1000), 0, add)
      }
    `,
  },
  {
    name: "mat4_kernel",
    expected: 90,
    source: `${simdMat4Source.replace("pub fn main(", "fn mat4_main(")}
      pub fn main() -> i32 {
        let result = mat4_main(
          <1, 2, 3, 4>,
          <5, 6, 7, 8>,
          <9, 10, 11, 12>,
          <13, 14, 15, 16>,
          <1, 5, 9, 13>,
          <2, 6, 10, 14>,
          <3, 7, 11, 15>,
          <4, 8, 12, 16>
        );
        result[0][0]
      }`,
  },
];

const jsScenarios: Record<ScenarioName, () => number> = {
  scalar_reuse_nway() {
    const x = 10;
    return x + x + x + x;
  },
  product_shadow_update() {
    type Vec2 = { x: number; y: number };
    const translate = (point: Vec2, dx: number, dy: number): Vec2 => ({
      x: point.x + dx,
      y: point.y + dy,
    });
    const score = (point: Vec2) => point.x + point.y;
    const point = { x: 1, y: 2 };
    let moved = translate(point, 10, 0);
    moved = translate(moved, 0, 20);
    return score(point) + score(moved);
  },
  tail_product_loop_1k() {
    let sum = 0;
    let ticks = 0;
    for (let i = 0; i < 1000; i++) {
      sum += i;
      ticks += 1;
    }
    return sum + ticks;
  },
  inline_array_builder_map() {
    const xs = Array.from({ length: 16 }, (_unused, i) => i + 1);
    const ys = xs.map((x) => x + 1);
    return ys[0] + ys[15];
  },
  compact_filter_collect() {
    const out = [1, 2, 3, 4].filter((x) => x > 2).map((x) => x + 1);
    return out.length;
  },
  range_fold_1k() {
    let acc = 0;
    for (let i = 0; i < 1000; i++) acc += i;
    return acc;
  },
  mat4_kernel() {
    const rows = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
    ];
    const cols = [
      [1, 5, 9, 13],
      [2, 6, 10, 14],
      [3, 7, 11, 15],
      [4, 8, 12, 16],
    ];
    return rows[0]![0]! * cols[0]![0]! + rows[0]![1]! * cols[0]![1]! +
      rows[0]![2]! * cols[0]![2]! + rows[0]![3]! * cols[0]![3]!;
  },
};

const rows: Row[] = [];
for (const scenario of figScenarios) {
  const calls = Math.max(1, Math.floor(iterations / (scenario.callsDivisor ?? 1)));
  rows.push(await benchFig(scenario, calls));
  rows.push(benchJavaScript(scenario.name, scenario.expected, calls));
}
rows.push(...await benchRust(iterations, figScenarios));

console.table(rows);

async function benchFig(scenario: FigScenario, calls: number): Promise<Row> {
  const wat = await watFromSource(scenario.source, { resolveModule });
  const wasm = await wasmFromSource(scenario.source, { resolveModule });
  const main = new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.main as CallableFunction;
  assertExpected("fig_wasm", scenario.name, main() as number, scenario.expected);
  const timed = timeCalls(() => main() as number, calls);
  return row("fig_wasm", scenario.name, calls, timed, `wat=${wat.length}B`);
}

function benchJavaScript(name: ScenarioName, expected: number, calls: number): Row {
  const fn = jsScenarios[name];
  assertExpected("javascript", name, fn(), expected);
  const timed = timeCalls(fn, calls);
  return row("javascript", name, calls, timed);
}

async function benchRust(totalIterations: number, scenarios: FigScenario[]): Promise<Row[]> {
  const dir = await Deno.makeTempDir({ prefix: "fig_memory_compare_" });
  const sourcePath = `${dir}/bench.rs`;
  const binaryPath = `${dir}/bench`;
  await Deno.writeTextFile(sourcePath, rustSource());
  const compile = new Deno.Command("rustc", {
    args: ["-C", "opt-level=3", "-C", "target-cpu=native", sourcePath, "-o", binaryPath],
    stdout: "piped",
    stderr: "piped",
  });
  const compileOutput = await compile.output();
  if (!compileOutput.success) {
    throw new Error(new TextDecoder().decode(compileOutput.stderr));
  }
  const run = new Deno.Command(binaryPath, {
    args: [String(totalIterations)],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await run.output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  const parsed = JSON.parse(new TextDecoder().decode(output.stdout)) as Row[];
  const expectedNames = new Set(scenarios.map((scenario) => scenario.name));
  return parsed.filter((item) => expectedNames.has(item.scenario));
}

function timeCalls(fn: () => number, calls: number): { elapsedMs: number; checksum: number } {
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < calls; i++) checksum += fn();
  return { elapsedMs: performance.now() - start, checksum };
}

function row(
  runtime: Row["runtime"],
  scenario: ScenarioName,
  calls: number,
  timed: { elapsedMs: number; checksum: number },
  detail?: string,
): Row {
  return {
    runtime,
    scenario,
    calls,
    checksum: timed.checksum,
    elapsed_ms: timed.elapsedMs.toFixed(3),
    calls_per_ms: (calls / timed.elapsedMs).toFixed(3),
    ns_per_call: ((timed.elapsedMs * 1_000_000) / calls).toFixed(1),
    ...(detail ? { detail } : {}),
  };
}

function assertExpected(runtime: string, name: ScenarioName, actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`${runtime} ${name} expected ${expected} but got ${actual}`);
  }
}

function rustSource(): string {
  return String.raw`
use std::hint::black_box;
use std::time::Instant;

#[derive(Clone, Copy)]
struct Vec2 { x: i32, y: i32 }

fn scalar_reuse_nway() -> i32 {
    let x = black_box(10);
    x + x + x + x
}

fn translate(point: Vec2, dx: i32, dy: i32) -> Vec2 {
    Vec2 { x: point.x + dx, y: point.y + dy }
}

fn score(point: Vec2) -> i32 {
    point.x + point.y
}

fn product_shadow_update() -> i32 {
    let point = black_box(Vec2 { x: 1, y: 2 });
    let moved = translate(point, black_box(10), black_box(0));
    let moved = translate(moved, black_box(0), black_box(20));
    score(point) + score(moved)
}

fn tail_product_loop_1k() -> i32 {
    let mut sum = 0;
    let mut ticks = 0;
    for i in 0..black_box(1000) {
        sum = black_box(sum + i);
        ticks = black_box(ticks + 1);
    }
    sum + ticks
}

fn inline_array_builder_map() -> i32 {
    let xs = std::array::from_fn::<_, 16, _>(|i| black_box(i as i32 + 1));
    let ys = xs.map(|x| black_box(x + 1));
    ys[0] + ys[15]
}

fn compact_filter_collect() -> i32 {
    let input = black_box([1, 2, 3, 4]);
    let out: Vec<i32> = input.iter().copied().filter(|x| *x > 2).map(|x| x + 1).collect();
    out.len() as i32
}

fn range_fold_1k() -> i32 {
    (0..black_box(1000)).fold(0, |acc, x| black_box(acc + x))
}

fn mat4_kernel() -> i32 {
    let rows = black_box([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
        [13, 14, 15, 16],
    ]);
    let cols = black_box([
        [1, 5, 9, 13],
        [2, 6, 10, 14],
        [3, 7, 11, 15],
        [4, 8, 12, 16],
    ]);
    black_box(rows[0][0] * cols[0][0] + rows[0][1] * cols[0][1] +
        rows[0][2] * cols[0][2] + rows[0][3] * cols[0][3])
}

fn bench(name: &str, calls: usize, expected: i32, f: fn() -> i32) -> String {
    let warmup = f();
    assert_eq!(warmup, expected, "{name}");
    let start = Instant::now();
    let mut checksum: i64 = 0;
    for _ in 0..calls {
        checksum += black_box(f()) as i64;
    }
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    format!(
        "{{\"runtime\":\"rust\",\"scenario\":\"{}\",\"calls\":{},\"checksum\":{},\"elapsed_ms\":\"{:.3}\",\"calls_per_ms\":\"{:.3}\",\"ns_per_call\":\"{:.1}\"}}",
        name,
        calls,
        checksum,
        elapsed_ms,
        calls as f64 / elapsed_ms,
        elapsed_ms * 1_000_000.0 / calls as f64
    )
}

fn main() {
    let iterations = std::env::args().nth(1).and_then(|arg| arg.parse::<usize>().ok()).unwrap_or(100_000);
    let rows = [
        bench("scalar_reuse_nway", iterations, 40, scalar_reuse_nway),
        bench("product_shadow_update", iterations, 36, product_shadow_update),
        bench("tail_product_loop_1k", std::cmp::max(1, iterations / 20), 500_500, tail_product_loop_1k),
        bench("inline_array_builder_map", std::cmp::max(1, iterations / 4), 19, inline_array_builder_map),
        bench("compact_filter_collect", std::cmp::max(1, iterations / 2), 2, compact_filter_collect),
        bench("range_fold_1k", std::cmp::max(1, iterations / 20), 499_500, range_fold_1k),
        bench("mat4_kernel", iterations, 90, mat4_kernel),
    ];
    println!("[{}]", rows.join(","));
}
`;
}
