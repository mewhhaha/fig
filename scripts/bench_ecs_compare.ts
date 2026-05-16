import { compileArtifactsFromSource, createCompileCache } from "../src/mod.ts";

type Runtime = "fig_wasm_host_loop" | "rust";
type ScenarioName = "dense_batch_move_fold_128";

interface Row {
  runtime: Runtime;
  scenario: ScenarioName;
  calls: number;
  checksum: number;
  elapsed_ms: string;
  calls_per_ms: string;
  ns_per_call: string;
  compile_total_ms?: string;
  compile_parse_ms?: string;
  compile_import_ms?: string;
  compile_check_ms?: string;
  compile_backend_ms?: string;
  compile_wat_ms?: string;
  compile_wasm_ms?: string;
  wat_bytes?: number;
  wasm_bytes?: number;
}

interface Scenario {
  name: ScenarioName;
  source: string;
  expected: number;
}

const iterations = Number(positionalArgs()[0] ?? 100_000);
const compileCache = createCompileCache();
const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

const scenarios: Scenario[] = [
  {
    name: "dense_batch_move_fold_128",
    expected: 8_896,
    source: `
      const ecs = @import("engine.ecs");

      type fn Position() -> type {
        let Position = {x: i32, y: i32};
        struct(Position)
      }

      type fn Velocity() -> type {
        let Velocity = {dx: i32, dy: i32};
        struct(Velocity)
      }

      fn move_position(
        index: ecs.BatchIndex(128),
        item: Position,
        velocity: Velocity
      ) -> Position {
        Position {
          x: item.x + velocity.dx + index,
          y: item.y + velocity.dy
        }
      }

      fn score_position(acc: i32, item: Position) -> i32 {
        acc + item.x + item.y
      }

      pub fn main(seed: i32) -> i32 {
        let positions = ecs.batch_fill(
          128,
          Position,
          Position {x: seed, y: seed + 1}
        );
        let moved = ecs.batch_map_with_state(
          positions,
          Velocity {dx: 2, dy: 3},
          move_position
        );
        ecs.batch_fold(moved, 0, score_position)
      }
    `,
  },
];

const figRows: Row[] = [];
for (const scenario of scenarios) {
  figRows.push(await benchFig(scenario, iterations));
}
const rustRows = await benchRust(iterations);
const rows = [...figRows, ...rustRows];

console.table(rows);
console.table(comparisonRows(rows));

async function benchFig(scenario: Scenario, calls: number): Promise<Row> {
  const artifact = await compileArtifactsFromSource(scenario.source, {
    resolveModule,
    cache: compileCache,
    memoryModel: "branch",
    optMode: "release",
    pruneImports: true,
  });
  const exports = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm)).exports;
  const main = exports.main as CallableFunction;
  assertExpected("fig_wasm_host_loop", scenario.name, main(0) as number, scenario.expected);
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < calls; i++) checksum = i32(checksum + (main(i) as number));
  const elapsedMs = performance.now() - start;
  return {
    ...timedRow("fig_wasm_host_loop", scenario.name, calls, checksum, elapsedMs),
    compile_total_ms: (
      artifact.timings.parseMs + artifact.timings.importMs + artifact.timings.checkMs +
      artifact.timings.backendMs + artifact.timings.watMs + artifact.timings.wasmMs
    ).toFixed(3),
    compile_parse_ms: artifact.timings.parseMs.toFixed(3),
    compile_import_ms: artifact.timings.importMs.toFixed(3),
    compile_check_ms: artifact.timings.checkMs.toFixed(3),
    compile_backend_ms: artifact.timings.backendMs.toFixed(3),
    compile_wat_ms: artifact.timings.watMs.toFixed(3),
    compile_wasm_ms: artifact.timings.wasmMs.toFixed(3),
    wat_bytes: artifact.wat.length,
    wasm_bytes: artifact.wasm.byteLength,
  };
}

async function benchRust(calls: number): Promise<Row[]> {
  const dir = await Deno.makeTempDir({ prefix: "fig_ecs_compare_" });
  const sourcePath = `${dir}/bench.rs`;
  const binaryPath = `${dir}/bench`;
  await Deno.writeTextFile(sourcePath, rustSource());
  const compileOutput = await new Deno.Command("rustc", {
    args: ["-C", "opt-level=3", "-C", "target-cpu=native", sourcePath, "-o", binaryPath],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!compileOutput.success) throw new Error(new TextDecoder().decode(compileOutput.stderr));

  const output = await new Deno.Command(binaryPath, {
    args: [String(calls)],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  return JSON.parse(new TextDecoder().decode(output.stdout)) as Row[];
}

function timedRow(
  runtime: Runtime,
  scenario: ScenarioName,
  calls: number,
  checksum: number,
  elapsedMs: number,
): Row {
  return {
    runtime,
    scenario,
    calls,
    checksum,
    elapsed_ms: elapsedMs.toFixed(3),
    calls_per_ms: (calls / elapsedMs).toFixed(3),
    ns_per_call: ((elapsedMs * 1_000_000) / calls).toFixed(1),
  };
}

function comparisonRows(rows: Row[]) {
  return scenarios.map((scenario) => {
    const fig = rows.find((row) =>
      row.runtime === "fig_wasm_host_loop" && row.scenario === scenario.name
    );
    const rust = rows.find((row) => row.runtime === "rust" && row.scenario === scenario.name);
    if (!fig || !rust) throw new Error(`missing comparison rows for ${scenario.name}`);
    return {
      scenario: scenario.name,
      calls: fig.calls,
      "fig ns/call": fig.ns_per_call,
      "rust ns/call": rust.ns_per_call,
      "fig/rust": (Number(fig.ns_per_call) / Number(rust.ns_per_call)).toFixed(2),
      "fig wasm bytes": fig.wasm_bytes,
      checksum: `${fig.checksum}/${rust.checksum}`,
    };
  });
}

function assertExpected(
  runtime: Runtime,
  scenario: ScenarioName,
  actual: number,
  expected: number,
) {
  if (actual !== expected) {
    throw new Error(`${runtime} ${scenario} expected ${expected} but got ${actual}`);
  }
}

function i32(value: number): number {
  return value | 0;
}

function positionalArgs(): string[] {
  return Deno.args.filter((arg) => arg !== "--");
}

function rustSource(): string {
  return String.raw`
use std::hint::black_box;
use std::time::Instant;

#[derive(Clone, Copy)]
struct Position {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy)]
struct Velocity {
    dx: i32,
    dy: i32,
}

fn dense_batch_move_fold_128(seed: i32) -> i32 {
    let seed = black_box(seed);
    let velocity = black_box(Velocity { dx: 2, dy: 3 });
    let positions = black_box([Position { x: seed, y: seed + 1 }; 128]);
    let mut moved = black_box([Position { x: 0, y: 0 }; 128]);
    for (index, item) in positions.iter().copied().enumerate() {
        moved[index] = Position {
            x: item.x + velocity.dx + index as i32,
            y: item.y + velocity.dy,
        };
    }
    let mut acc = 0_i32;
    for item in moved {
        acc = black_box(acc.wrapping_add(item.x).wrapping_add(item.y));
    }
    acc
}

fn bench(name: &str, calls: usize, expected: i32, f: fn(i32) -> i32) -> String {
    let warmup = f(0);
    assert_eq!(warmup, expected, "{name}");
    let start = Instant::now();
    let mut checksum = 0_i32;
    for i in 0..calls {
        checksum = checksum.wrapping_add(black_box(f(i as i32)));
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
    let calls = std::env::args()
        .nth(1)
        .and_then(|arg| arg.parse::<usize>().ok())
        .unwrap_or(100_000);
    let rows = [
        bench("dense_batch_move_fold_128", calls, 8_896, dense_batch_move_fold_128),
    ];
    println!("[{}]", rows.join(","));
}
`;
}
