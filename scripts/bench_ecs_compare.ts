import { compileArtifactsFromSource, createCompileCache } from "../src/mod.ts";

type Runtime =
  | "fig_wasm_host_loop_batch_materialized"
  | "fig_wasm_host_loop_batch_iter_fused"
  | "fig_wasm_internal_loop_batch_iter_fused"
  | "fig_wasm_host_loop_world_cmap"
  | "fig_wasm_internal_loop_world_cmap"
  | "fig_wasm_host_loop_world_cmap_fold_fused"
  | "fig_wasm_internal_loop_world_cmap_fold_fused"
  | "fig_wasm_host_loop_world_fill_iter_fused"
  | "fig_wasm_internal_loop_world_fill_iter_fused"
  | "rust";
type ScenarioName = "dense_batch_move_fold_128" | "dense_world_cmap_fold_128";

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
  wat_func_count?: number;
  wat_call_count?: number;
  wat_loop_count?: number;
  wat_if_count?: number;
}

interface Scenario {
  name: ScenarioName;
  expected: number;
  cases: FigCase[];
}

interface FigCase {
  runtime: Exclude<Runtime, "rust">;
  source: string;
  mode: "host" | "internal";
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
    cases: [
      {
        runtime: "fig_wasm_host_loop_batch_materialized",
        mode: "host",
        source: `${scenarioPrelude()}
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
      {
        runtime: "fig_wasm_host_loop_batch_iter_fused",
        mode: "host",
        source: batchFusedSource(),
      },
      {
        runtime: "fig_wasm_internal_loop_batch_iter_fused",
        mode: "internal",
        source: withInternalBench(batchFusedSource()),
      },
    ],
  },
  {
    name: "dense_world_cmap_fold_128",
    expected: 8_896,
    cases: [
      {
        runtime: "fig_wasm_host_loop_world_cmap",
        mode: "host",
        source: worldCmapSource(),
      },
      {
        runtime: "fig_wasm_internal_loop_world_cmap",
        mode: "internal",
        source: withInternalBench(worldCmapSource()),
      },
      {
        runtime: "fig_wasm_host_loop_world_cmap_fold_fused",
        mode: "host",
        source: worldCmapFoldFusedSource(),
      },
      {
        runtime: "fig_wasm_internal_loop_world_cmap_fold_fused",
        mode: "internal",
        source: withInternalBench(worldCmapFoldFusedSource()),
      },
      {
        runtime: "fig_wasm_host_loop_world_fill_iter_fused",
        mode: "host",
        source: worldFillIterFusedSource(),
      },
      {
        runtime: "fig_wasm_internal_loop_world_fill_iter_fused",
        mode: "internal",
        source: withInternalBench(worldFillIterFusedSource()),
      },
    ],
  },
];

const figRows: Row[] = [];
for (const scenario of scenarios) {
  for (const figCase of scenario.cases) {
    figRows.push(await benchFigCase(scenario, figCase, iterations));
  }
}
const rustRows = await benchRust(iterations);
const rows = [...figRows, ...rustRows];

console.table(rows);
console.table(comparisonRows(rows));

async function benchFigCase(
  scenario: Scenario,
  figCase: FigCase,
  calls: number,
): Promise<Row> {
  const artifact = await compileArtifactsFromSource(figCase.source, {
    resolveModule,
    cache: compileCache,
    memoryModel: "branch",
    optMode: "release",
    pruneImports: true,
  });
  const exports = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm)).exports;
  const main = exports.main as CallableFunction;
  assertExpected(figCase.runtime, scenario.name, main(0) as number, scenario.expected);
  const start = performance.now();
  let checksum = 0;
  if (figCase.mode === "internal") {
    const bench = exports.bench as CallableFunction;
    checksum = bench(calls) as number;
  } else {
    for (let i = 0; i < calls; i++) checksum = i32(checksum + (main(i) as number));
  }
  return {
    ...timedRow(figCase.runtime, scenario.name, calls, checksum, performance.now() - start),
    ...artifactMetrics(artifact),
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

function artifactMetrics(
  artifact: Awaited<ReturnType<typeof compileArtifactsFromSource>>,
): Partial<Row> {
  const wat = artifact.wat ?? "";
  return {
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
    wat_bytes: wat.length,
    wasm_bytes: artifact.wasm.byteLength,
    wat_func_count: countWat(wat, /\(func \$/g),
    wat_call_count: countWat(wat, /\bcall \$/g),
    wat_loop_count: countWat(wat, /\bloop\b/g),
    wat_if_count: countWat(wat, /\bif\b/g),
  };
}

function comparisonRows(rows: Row[]) {
  return rows.filter((row) => row.runtime.startsWith("fig_")).map((fig) => {
    const rust = rows.find((row) => row.runtime === "rust" && row.scenario === fig.scenario);
    if (!rust) throw new Error(`missing rust row for ${fig.scenario}`);
    return {
      scenario: fig.scenario,
      runtime: fig.runtime,
      calls: fig.calls,
      "fig ns/call": fig.ns_per_call,
      "rust ns/call": rust.ns_per_call,
      "fig/rust": (Number(fig.ns_per_call) / Number(rust.ns_per_call)).toFixed(2),
      "fig wasm bytes": fig.wasm_bytes,
      "wat ifs": fig.wat_if_count,
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

function countWat(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function i32(value: number): number {
  return value | 0;
}

function positionalArgs(): string[] {
  return Deno.args.filter((arg) => arg !== "--");
}

function scenarioPrelude(): string {
  return `
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
    `;
}

function batchFusedSource(): string {
  return `${scenarioPrelude()}
      pub fn main(seed: i32) -> i32 {
        ecs.batch_iter_map_with_state_fold(
          ecs.batch_fill_iter(128, Position, Position {x: seed, y: seed + 1}),
          Velocity {dx: 2, dy: 3},
          0,
          move_position,
          score_position
        )
      }
    `;
}

function worldCmapSource(): string {
  return `${worldPrelude()}
      pub fn main(seed: i32) -> i32 {
        let systems = seed_systems(seed);
        let moved = ecs.cmap_input(Systems, #positions, systems, move_position);
        ecs.batch_fold(128, Position, i32, moved.world.positions, 0, score_position)
      }
    `;
}

function worldCmapFoldFusedSource(): string {
  return `${worldPrelude()}
      pub fn main(seed: i32) -> i32 {
        let systems = seed_systems(seed);
        ecs.cmap_input_fold(
          Systems,
          #positions,
          systems,
          0,
          move_position,
          score_position
        )
      }
    `;
}

function worldFillIterFusedSource(): string {
  return `${worldTypePrelude()}
      pub fn main(seed: i32) -> i32 {
        let positions = ecs.component_ref(Systems, #positions);
        ecs.map_input_fill_fold(
          positions,
          Velocity {dx: 2, dy: 3},
          Position {x: seed, y: seed + 1},
          0,
          move_position,
          score_position
        )
      }
    `;
}

function worldPrelude(): string {
  return `${worldTypePrelude()}
      fn seed_systems(seed: i32) -> Systems {
        let world: World = ecs.World::empty(128, components);
        Systems {
          world: @replace_field(
            world,
            #positions,
            ecs.batch_fill(128, Position, Position {x: seed, y: seed + 1})
          ),
          input: Velocity {dx: 2, dy: 3}
        }
      }
    `;
}

function worldTypePrelude(): string {
  return `${scenarioPrelude()}
      const components = ecs.components({
        positions: Position
      });

      type fn World() -> type {
        let Expected = @type_slots(ecs.World(128, components));
        let World = {
          entities: ecs.Batch(128, ecs.BatchIndex(128)),
          len: i32,
          positions: ecs.Batch(128, Position)
        };
        let MatchesEcsWorld = @require(
          World == Expected,
          "benchmark World must match ecs.World"
        );
        struct(World)
      }

      type fn Systems() -> type {
        let Systems = {
          world: World,
          input: Velocity
        };
        struct(Systems)
      }
    `;
}

function withInternalBench(source: string): string {
  return `${source}
      fn bench_loop(i: i32, limit: i32, checksum: i32) -> i32 {
        match i == limit {
          true => checksum,
          false => bench_loop(i + 1, limit, checksum + main(i))
        }
      }

      pub fn bench(iterations: i32) -> i32 {
        bench_loop(0, iterations, 0)
      }
    `;
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

#[derive(Clone, Copy)]
struct World {
    entities: [i32; 128],
    len: i32,
    positions: [Position; 128],
}

#[derive(Clone, Copy)]
struct Systems {
    world: World,
    input: Velocity,
}

fn dense_batch_move_fold_128(seed: i32) -> i32 {
    let seed = black_box(seed);
    let velocity = black_box(Velocity { dx: 2, dy: 3 });
    let positions = black_box([Position { x: seed, y: seed + 1 }; 128]);
    positions
        .iter()
        .copied()
        .enumerate()
        .fold(0_i32, |acc, (index, item)| {
            let moved = Position {
                x: item.x + velocity.dx + index as i32,
                y: item.y + velocity.dy,
            };
            black_box(acc.wrapping_add(moved.x).wrapping_add(moved.y))
        })
}

fn dense_world_cmap_fold_128(seed: i32) -> i32 {
    let seed = black_box(seed);
    let world = World {
        entities: [0_i32; 128],
        len: 0,
        positions: [Position { x: seed, y: seed + 1 }; 128],
    };
    let systems = Systems {
        world,
        input: Velocity { dx: 2, dy: 3 },
    };
    let mut moved = systems;
    for (index, item) in systems.world.positions.iter().copied().enumerate() {
        moved.world.positions[index] = Position {
            x: item.x + systems.input.dx + index as i32,
            y: item.y + systems.input.dy,
        };
    }
    moved
        .world
        .positions
        .iter()
        .copied()
        .fold(0_i32, |acc, item| {
            black_box(acc.wrapping_add(item.x).wrapping_add(item.y))
        })
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
        bench("dense_world_cmap_fold_128", calls, 8_896, dense_world_cmap_fold_128),
    ];
    println!("[{}]", rows.join(","));
}
`;
}
