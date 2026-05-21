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
  releaseScenario("eff_state", effSource(["#state"], "state_step")),
  releaseScenario("eff_reader_state", effSource(["#reader", "#state"], "reader_state_step")),
  {
    ...releaseScenario(
      "eff_reader_state_log_clock",
      effSource(["#reader", "#state", "#log", "#clock"], "wide_step"),
    ),
  },
  {
    name: "do_recursive_eff_state_debug",
    source: doRecursiveEffSource(["#state"], "state_step"),
    optMode: "debug",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
  {
    name: "do_recursive_eff_state_release",
    source: doRecursiveEffSource(["#state"], "state_step"),
    optMode: "release",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
  {
    name: "do_recursive_eff_reader_state_debug",
    source: doRecursiveEffSource(["#reader", "#state"], "reader_state_step"),
    optMode: "debug",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
  {
    name: "do_recursive_eff_reader_state_release",
    source: doRecursiveEffSource(["#reader", "#state"], "reader_state_step"),
    optMode: "release",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
  {
    name: "do_recursive_eff_reader_state_log_clock_debug",
    source: doRecursiveEffSource(["#reader", "#state", "#log", "#clock"], "wide_step"),
    optMode: "debug",
    limit: doLimit,
    calls: doCalls,
    run: true,
  },
  {
    name: "do_recursive_eff_reader_state_log_clock_release",
    source: doRecursiveEffSource(["#reader", "#state", "#log", "#clock"], "wide_step"),
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

function effSource(effects: string[], stepName: string): string {
  const rowType = `{${effects.join(", ")}}`;
  const rowValue = `[${effects.join(", ")}]`;
  const proof = effects.length === 1
    ? `effect.Member(${effects[0]}, ${rowValue})`
    : `effect.Members(${rowValue}, ${rowValue})`;
  const proofType = effects.length === 1
    ? `effect.Member(${effects[0]}, effects)`
    : `effect.Members(${rowType}, effects)`;

  return `
    const effect = @import("prelude.effect");

    fn ${stepName}(
      const effects: const,
      const _proof: ${proofType},
      env: i32,
      value: i32
    ) -> effect.Eff(effects, i32) {
      value + env
    }

    fn eff_step(env: i32, value: i32) -> effect.Eff(${rowType}, i32) {
      ${stepName}(${rowValue}, ${proof}, env, value)
    }

    fn eff_loop(i: i32, limit: i32, env: i32, acc: i32) -> effect.Eff(${rowType}, i32) {
      match i < limit {
        true => eff_loop(i + 1, limit, env, eff_step(env, acc)),
        false => acc
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      eff_loop(0, limit, 3, seed)
    }
  `;
}

function doRecursiveEffSource(effects: string[], stepName: string): string {
  const rowType = `{${effects.join(", ")}}`;
  const rowValue = `[${effects.join(", ")}]`;
  const proof = effects.length === 1
    ? `effect.Member(${effects[0]}, ${rowValue})`
    : `effect.Members(${rowValue}, ${rowValue})`;
  const proofType = effects.length === 1
    ? `effect.Member(${effects[0]}, effects)`
    : `effect.Members(${rowType}, effects)`;

  return `
    const effect = @import("prelude.effect");

    fn ${stepName}(
      const effects: const,
      const _proof: ${proofType},
      env: i32,
      value: i32
    ) -> effect.Eff(effects, i32) {
      value + env
    }

    fn eff_step(env: i32, value: i32) -> effect.Eff(${rowType}, i32) {
      ${stepName}(${rowValue}, ${proof}, env, value)
    }

    fn eff_loop(i: i32, limit: i32, env: i32, acc: i32) -> effect.Eff(${rowType}, i32) {
      match i < limit {
        true => do @monad(effect.Eff(${rowType}, _)) {
          next <- eff_step(env, acc);
          eff_loop(i + 1, limit, env, next)
        },
        false => acc
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      eff_loop(0, limit, 3, seed)
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
