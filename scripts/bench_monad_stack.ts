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

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

const scenarios: Scenario[] = [
  { name: "direct", source: directSource() },
  { name: "either_reader_state_stack", source: stackSource() },
];

const rows: BenchRow[] = [];
let expected: number | undefined;

for (const scenario of scenarios) {
  const compileStart = performance.now();
  const artifact = await compileArtifactsFromSource(scenario.source, {
    resolveModule,
    optMode: "release",
  });
  const compileMs = performance.now() - compileStart;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.wasm));
  const main = instance.exports.main as CallableFunction;
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
    const monad = @import("prelude.monad");

    type fn Env() -> type { i32 }
    type fn Store() -> type { i32 }
    type fn Error() -> type { i32 }

    // This is the benchmark's Either layer. It is intentionally transparent like
    // today's Reader and State helpers, with 0 reserved for the Left path.
    type fn Either(error: type, value: type) -> type { value }
    fn Either::pure(value: a) -> Either(error, a) { value }
    fn Either::bind(
      value: Either(error, a),
      const f: fn(x: a) -> Either(error, b)
    ) -> Either(error, b) {
      match value == 0 { true => 0, false => f(value) }
    }

    type fn Stack(value: type) -> type {
      Either(Error, monad.Reader(Env, monad.State(Store, value)))
    }
    fn Stack::pure(value: a) -> Stack(a) {
      Either::pure(monad.Reader::pure(monad.State::pure(value)))
    }
    fn Stack::bind(value: Stack(a), const f: fn(x: a) -> Stack(b)) -> Stack(b) {
      Either::bind(value, f)
    }

    fn pack(env: Env, store: Store) -> i32 { store * 8 + env }
    fn frame_env(frame: i32) -> Env { frame % 8 }
    fn frame_store(frame: i32) -> Store { frame / 8 }

    fn start(env: Env, store: Store) -> Stack(i32) { Stack::pure(pack(env, store)) }
    fn ask_frame(frame: i32) -> Stack(i32) {
      let env: monad.Reader(Env, Env) = monad.Reader::ask(frame_env(frame));
      Stack::pure(pack(env, frame_store(frame)))
    }
    fn get_frame(frame: i32) -> Stack(i32) {
      let store: monad.State(Store, Store) = monad.State::get(frame_store(frame));
      Stack::pure(pack(frame_env(frame), store))
    }
    fn bump_frame(frame: i32) -> Stack(i32) {
      Stack::pure(pack(frame_env(frame), frame_store(frame) + frame_env(frame)))
    }
    fn guard_frame(frame: i32) -> Stack(i32) {
      match frame_store(frame) < 2000000000 { true => Stack::pure(frame), false => 0 }
    }
    fn put_frame(frame: i32) -> Stack(i32) {
      let stored: monad.State(Store, Store) = monad.State::put(frame_store(frame), frame_store(frame));
      Stack::pure(pack(frame_env(frame), stored))
    }

    fn stack_step(env: Env, store: Store) -> Stack(i32) {
      do @monad(Stack(_)) {
        frame <- start(env, store);
        asked <- ask_frame(frame);
        current <- get_frame(asked);
        bumped <- bump_frame(current);
        checked <- guard_frame(bumped);
        put_frame(checked)
      }
    }

    fn stack_continue(i: i32, limit: i32, env: Env, stepped: Stack(i32)) -> Stack(i32) {
      match stepped == 0 {
        true => 0,
        false => stack_loop(i + 1, limit, env, frame_store(stepped))
      }
    }

    fn stack_loop(i: i32, limit: i32, env: Env, store: Store) -> Stack(i32) {
      match i < limit {
        true => stack_continue(i, limit, env, stack_step(env, store)),
        false => Stack::pure(pack(env, store))
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      let env: Env = 3;
      let done = stack_loop(0, limit, env, seed);
      match done == 0 { true => 0, false => frame_store(done) }
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
