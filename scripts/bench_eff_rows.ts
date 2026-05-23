import { compileArtifactsFromSource } from "../src/mod.ts";

type Scenario = {
  name: string;
  source: string;
  optMode: "debug" | "release";
  limit: number;
  calls: number;
  run: boolean;
  note?: string;
};

type BenchRow = {
  scenario: string;
  opt_mode: "debug" | "release";
  status: string;
  limit: number;
  calls: number;
  result: number | string;
  compile_ms: string;
  median_ms: string;
  ns_per_main: string;
  ns_per_step: string;
  wasm_bytes: number;
  wat_bytes: number;
  wat_calls: number;
  wat_loops: number;
  wat_ifs: number;
};

const limit = numberArg("--limit", 10_000);
const calls = numberArg("--calls", 30_000);
const samples = numberArg("--samples", 9);
const seed = numberArg("--seed", 1);
const doLimit = numberArg("--do-limit", Math.min(limit, 1_000));
const doCalls = numberArg("--do-calls", Math.min(calls, 3_000));

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

const scenarios: Scenario[] = [
  releaseScenario("direct", directSource()),
  releaseScenario("eff_reader", readerEffSource()),
  releaseScenario("eff_state", stateEffSource()),
  releaseScenario("eff_reader_state", readerStateEffSource(false)),
  {
    ...releaseScenario(
      "eff_reader_state_debug_clock",
      readerStateEffSource(true),
    ),
  },
  {
    name: "do_recursive_eff_state_debug",
    source: stateEffSource(),
    optMode: "debug",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
  {
    name: "do_recursive_eff_state_release",
    source: stateEffSource(),
    optMode: "release",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
  {
    name: "do_recursive_eff_reader_state_debug",
    source: readerStateEffSource(false),
    optMode: "debug",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
  {
    name: "do_recursive_eff_reader_state_release",
    source: readerStateEffSource(false),
    optMode: "release",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
  {
    name: "do_recursive_eff_reader_state_debug_clock_debug",
    source: readerStateEffSource(true),
    optMode: "debug",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
  {
    name: "do_recursive_eff_reader_state_debug_clock_release",
    source: readerStateEffSource(true),
    optMode: "release",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
];

const rows: BenchRow[] = [];

for (const scenario of scenarios) {
  const compileStart = performance.now();
  const artifact = await compileArtifactsFromSource(scenario.source, {
    resolveModule,
    optMode: scenario.optMode,
  });
  const compileMs = performance.now() - compileStart;
  const watMetrics = {
    wasm_bytes: artifact.wasm.length,
    wat_bytes: artifact.wat.length,
    wat_calls: count(artifact.wat, /\bcall \$/g),
    wat_loops: count(artifact.wat, /\bloop\b/g),
    wat_ifs: count(artifact.wat, /\bif\b/g),
  };

  if (!scenario.run) {
    rows.push({
      scenario: scenario.name,
      opt_mode: scenario.optMode,
      status: scenario.note ?? "compile_only",
      limit: scenario.limit,
      calls: scenario.calls,
      result: "-",
      compile_ms: compileMs.toFixed(3),
      median_ms: "-",
      ns_per_main: "-",
      ns_per_step: "-",
      ...watMetrics,
    });
    continue;
  }

  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  const main = instance.exports.main as CallableFunction;
  resetFigHeap(instance);
  const result = main(seed, scenario.limit) as number;
  const wanted = seed + 3 * scenario.limit;
  if (result !== wanted) {
    throw new Error(`${scenario.name} returned ${result}, expected ${wanted}`);
  }

  const timings: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < samples + 2; sample++) {
    const start = performance.now();
    let local = 0;
    for (let i = 0; i < scenario.calls; i++) {
      resetFigHeap(instance);
      local += main(seed + (i % 7), scenario.limit) as number;
    }
    const elapsed = performance.now() - start;
    checksum ^= local;
    if (sample >= 2) timings.push(elapsed);
  }
  if (checksum === Number.MIN_SAFE_INTEGER) {
    throw new Error("unreachable checksum guard");
  }

  const medianMs = median(timings);
  rows.push({
    scenario: scenario.name,
    opt_mode: scenario.optMode,
    status: "ok",
    limit: scenario.limit,
    calls: scenario.calls,
    result,
    compile_ms: compileMs.toFixed(3),
    median_ms: medianMs.toFixed(3),
    ns_per_main: ((medianMs * 1_000_000) / scenario.calls).toFixed(2),
    ns_per_step: ((medianMs * 1_000_000) / (scenario.calls * scenario.limit)).toFixed(4),
    ...watMetrics,
  });
}

console.log(
  `limit=${limit} calls=${calls} do_limit=${doLimit} do_calls=${doCalls} samples=${samples} seed=${seed}`,
);
console.table(rows);

function releaseScenario(name: string, source: string): Scenario {
  return { name, source, optMode: "release", limit, calls, run: true };
}

function directSource(): string {
  return `
    fn direct_step(env: i32, value: i32) -> i32 {
      value + env
    }

    fn direct_loop(i: i32, limit: i32, env: i32, acc: i32) -> i32 {
      match i < limit {
        true => direct_loop(i + 1, limit, env, direct_step(env, acc)),
        false => acc
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      direct_loop(0, limit, 3, seed)
    }
  `;
}

function readerEffSource(): string {
  return `
    const effect = @import("prelude.effect");

    type fn Env() -> type { i32 }

    fn eff_loop_value(i: i32, limit: i32, env: Env, acc: i32) -> i32 {
      match i < limit {
        true => eff_loop_value(i + 1, limit, env, acc + env),
        false => acc
      }
    }

    fn eff_loop(i: i32, limit: i32, acc: i32) -> effect.Eff({reader: Env}, i32) {
      \\ctx -> {
        eff_loop_value(i, limit, ctx.reader, acc)
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      effect.run_reader(eff_loop(0, limit, seed), 3)
    }
  `;
}

function stateEffSource(): string {
  return `
    const effect = @import("prelude.effect");

    type fn Store() -> type { i32 }

    fn eff_loop_value(i: i32, limit: i32, store: Store) -> Store {
      match i < limit {
        true => eff_loop_value(i + 1, limit, store + 3),
        false => store
      }
    }

    fn eff_loop(i: i32, limit: i32) -> effect.Eff({state: Store}, Store) {
      \\ctx -> {
        let next = eff_loop_value(i, limit, ctx.state);
        {value: next, state: next}
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      let result = effect.run_state_only(eff_loop(0, limit), seed);
      result.value
    }
  `;
}

function readerStateEffSource(includeTracingCarriers: boolean): string {
  const rowType = includeTracingCarriers
    ? "{state: Store, reader: Env, debug: Debug, clock: Clock}"
    : "{state: Store, reader: Env}";
  const runnerParams = includeTracingCarriers
    ? "_initial: Store, _env: Env, _debug: Debug, _clock: Clock"
    : "_initial: Store, _env: Env";
  const runnerArgs = includeTracingCarriers ? "seed, 3, 0, 0" : "seed, 3";
  return `
    const effect = @import("prelude.effect");
    const core = @import("prelude.core");
    const monad = @import("prelude.monad");

    type fn Store() -> type { i32 }
    type fn Env() -> type { i32 }
    type fn Debug() -> type { i32 }
    type fn Clock() -> type { i32 }

    fn eff_loop_value(i: i32, limit: i32, env: Env, store: Store) -> Store {
      match i < limit {
        true => eff_loop_value(i + 1, limit, env, store + env),
        false => store
      }
    }

    fn eff_loop(i: i32, limit: i32) -> effect.Eff(${rowType}, Store) {
      \\ctx -> {
        let next = eff_loop_value(i, limit, ctx.reader, ctx.state);
        {value: next, state: next}
      }
    }

    fn run_effect(
      value: effect.Eff(${rowType}, Store),
      ${runnerParams}
    ) -> monad.StateResult(Store, Store) {
      ${
    includeTracingCarriers
      ? "value({state: _initial, reader: _env, debug: _debug, clock: _clock})"
      : "value({state: _initial, reader: _env})"
  }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      let result = run_effect(eff_loop(0, limit), ${runnerArgs});
      result.value
    }
  `;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function resetFigHeap(instance: WebAssembly.Instance) {
  const memory = instance.exports.fig_objects;
  if (!(memory instanceof WebAssembly.Memory)) return;
  new DataView(memory.buffer).setUint32(0, 0, true);
}

function stringArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = Deno.args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

function numberArg(name: string, fallback: number): number {
  const value = Number(stringArg(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
