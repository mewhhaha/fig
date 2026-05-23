import { compileArtifactsFromSource } from "../src/mod.ts";

type Scenario = {
  name: string;
  source: string;
};

type BenchRow = {
  scenario: string;
  result: number;
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
const onlyScenario = stringArg("--scenario");

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

const scenarios: Scenario[] = [
  { name: "direct", source: directSource() },
  { name: "reader_fn", source: readerSource() },
  { name: "state_fn", source: stateSource() },
  { name: "eff_reader_state_fn", source: stackSource() },
];

const rows: BenchRow[] = [];
let expected: number | undefined;

for (const scenario of scenarios.filter((scenario) => !onlyScenario || scenario.name === onlyScenario)) {
  const compileStart = performance.now();
  const artifact = await compileArtifactsFromSource(scenario.source, {
    resolveModule,
    optMode: "release",
  });
  const compileMs = performance.now() - compileStart;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  const main = instance.exports.main as CallableFunction;
  resetFigHeap(instance);
  const result = main(seed, limit) as number;
  const wanted = seed + 3 * limit;
  if (result !== wanted) {
    throw new Error(`${scenario.name} returned ${result}, expected ${wanted}`);
  }
  expected ??= result;
  if (result !== expected) {
    throw new Error(`${scenario.name} returned ${result}, expected ${expected}`);
  }

  const timings: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < samples + 2; sample++) {
    const start = performance.now();
    let local = 0;
    for (let i = 0; i < calls; i++) {
      resetFigHeap(instance);
      local += main(seed + (i % 7), limit) as number;
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
    result,
    compile_ms: compileMs.toFixed(3),
    median_ms: medianMs.toFixed(3),
    ns_per_main: ((medianMs * 1_000_000) / calls).toFixed(2),
    ns_per_step: ((medianMs * 1_000_000) / (calls * limit)).toFixed(4),
    wasm_bytes: artifact.wasm.length,
    wat_bytes: artifact.wat.length,
    wat_calls: count(artifact.wat, /\bcall \$/g),
    wat_loops: count(artifact.wat, /\bloop\b/g),
    wat_ifs: count(artifact.wat, /\bif\b/g),
  });
}

console.log(`limit=${limit} calls=${calls} samples=${samples} seed=${seed}`);
console.table(rows);

function directSource(): string {
  return `
    type fn Env() -> type { i32 }
    type fn Store() -> type { i32 }

    fn pack(env: Env, store: Store) -> i32 { store * 8 + env }
    fn frame_env(frame: i32) -> Env { frame % 8 }
    fn frame_store(frame: i32) -> Store { frame / 8 }

    fn direct_start(env: Env, store: Store) -> i32 { pack(env, store) }
    fn direct_ask(frame: i32) -> i32 { pack(frame_env(frame), frame_store(frame)) }
    fn direct_get(frame: i32) -> i32 { pack(frame_env(frame), frame_store(frame)) }
    fn direct_bump(frame: i32) -> i32 {
      pack(frame_env(frame), frame_store(frame) + frame_env(frame))
    }
    fn direct_guard(frame: i32) -> i32 {
      match frame_store(frame) < 2000000000 { true => frame, false => 0 }
    }
    fn direct_put(frame: i32) -> i32 { pack(frame_env(frame), frame_store(frame)) }

    fn direct_step(env: Env, store: Store) -> i32 {
      direct_put(direct_guard(direct_bump(direct_get(direct_ask(direct_start(env, store))))))
    }

    fn direct_continue(i: i32, limit: i32, env: Env, stepped: i32) -> i32 {
      match stepped == 0 {
        true => 0,
        false => direct_loop(i + 1, limit, env, frame_store(stepped))
      }
    }

    fn direct_loop(i: i32, limit: i32, env: Env, store: Store) -> i32 {
      match i < limit {
        true => direct_continue(i, limit, env, direct_step(env, store)),
        false => pack(env, store)
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      let env: Env = 3;
      let done = direct_loop(0, limit, env, seed);
      match done == 0 { true => 0, false => frame_store(done) }
    }
  `;
}

function stackSource(): string {
  return `
    const effect = @import("prelude.effect");

    type fn Env() -> type { i32 }
    type fn Store() -> type { i32 }

    fn stack_loop_value(i: i32, limit: i32, env: Env, store: Store) -> Store {
      match i < limit {
        true => match store + env < 2000000000 {
          true => stack_loop_value(i + 1, limit, env, store + env),
          false => 0
        },
        false => store
      }
    }

    fn stack_loop(i: i32, limit: i32) -> effect.Eff({state: Store, reader: Env}, Store) {
      \\ctx -> {
        let next = stack_loop_value(i, limit, ctx.reader, ctx.state);
        {value: next, state: next}
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      let result = effect.run_reader(effect.run_state(stack_loop(0, limit), seed), 3);
      result.value
    }
  `;
}

function readerSource(): string {
  return `
    const monad = @import("prelude.monad");

    type fn Env() -> type { i32 }

    fn reader_loop_value(i: i32, limit: i32, env: Env, acc: i32) -> i32 {
      match i < limit {
        true => reader_loop_value(i + 1, limit, env, acc + env),
        false => acc
      }
    }

    fn reader_loop(i: i32, limit: i32, acc: i32) -> monad.Reader(Env, i32) {
      \\env -> {
        reader_loop_value(i, limit, env, acc)
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      monad.Reader::run(reader_loop(0, limit, seed), 3)
    }
  `;
}

function stateSource(): string {
  return `
    const monad = @import("prelude.monad");

    type fn Store() -> type { i32 }

    fn state_loop_value(i: i32, limit: i32, store: Store) -> Store {
      match i < limit {
        true => state_loop_value(i + 1, limit, store + 3),
        false => store
      }
    }

    fn state_loop(i: i32, limit: i32) -> monad.State(Store, Store) {
      \\store -> {
        let next = state_loop_value(i, limit, store);
        {value: next, state: next}
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      monad.State::eval(state_loop(0, limit), seed)
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
