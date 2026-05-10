import { wasmFromSource, watFromSource } from "../src/mod.ts";

type Variant = "default_tail_recursive" | "opcode_return_call" | "default_non_tail_recursive";

const repeats = 40;
const calls = 1_000;

const sources: Record<string, Record<Variant, string>> = {
  sum: {
    default_tail_recursive: tailSum(),
    opcode_return_call: tailSum(),
    default_non_tail_recursive: nonTailSum(),
  },
  pipeline: {
    default_tail_recursive: tailPipeline(),
    opcode_return_call: tailPipeline(),
    default_non_tail_recursive: nonTailPipeline(),
  },
  stress: {
    default_tail_recursive: tailStress(),
    opcode_return_call: tailStress(),
    default_non_tail_recursive: nonTailStress(),
  },
};

for (const [name, variants] of Object.entries(sources)) {
  console.log(`\n${name}`);
  for (
    const variant of [
      "default_tail_recursive",
      "opcode_return_call",
      "default_non_tail_recursive",
    ] as const
  ) {
    const largeN = name === "stress" ? 100_000 : 20_000;
    const n = variant === "opcode_return_call" ? largeN : 500;
    const source = variants[variant].replaceAll("__N__", String(n));
    const mode = variant === "opcode_return_call" ? { tailCallMode: "opcode" as const } : {};
    const wat = await watFromSource(source, mode);
    const hasRecursiveCall = /\bcall\s+\$(sum|fold|count_down)\b/.test(wat);
    const hasReturnCall = /\breturn_call\b/.test(wat);
    let ok = true;
    let overflow = false;
    let median = Number.NaN;
    let p95 = Number.NaN;
    try {
      const wasm = await wasmFromSource(source, mode);
      const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm));
      const main = instance.exports.main as CallableFunction;
      main();
      const samples = Array.from({ length: repeats }, () => timeCalls(main));
      samples.sort((a, b) => a - b);
      median = samples[Math.floor(samples.length / 2)] ?? Number.NaN;
      p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.NaN;
    } catch (error) {
      ok = false;
      overflow = error instanceof RangeError || String(error).includes("call stack");
    }
    if (variant !== "opcode_return_call") {
      overflow = await overflows(variants[variant].replaceAll("__N__", String(largeN)));
    }
    console.log(JSON.stringify({
      variant,
      compile_instantiate: ok,
      median_ms: Number.isFinite(median) ? median.toFixed(3) : null,
      p95_ms: Number.isFinite(p95) ? p95.toFixed(3) : null,
      large_n_overflow: overflow,
      wat_recursive_call: hasRecursiveCall,
      wat_return_call: hasReturnCall,
    }));
  }
}

async function overflows(source: string): Promise<boolean> {
  try {
    const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
    (instance.exports.main as CallableFunction)();
    return false;
  } catch (error) {
    return error instanceof RangeError || String(error).includes("call stack");
  }
}

function timeCalls(main: CallableFunction): number {
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < calls; i++) checksum += main() as number;
  if (checksum === 13) console.log(checksum);
  return performance.now() - start;
}

function tailSum(): string {
  return `
    fn sum(n: i32, acc: i32) -> i32 {
      match n { 0 => acc, _ => sum(n - 1, acc + n) }
    }
    pub fn main() -> i32 { sum(__N__, 0) }
  `;
}

function nonTailSum(): string {
  return `
    fn sum(n: i32, acc: i32) -> i32 {
      match n { 0 => acc, _ => 0 + sum(n - 1, acc + n) }
    }
    pub fn main() -> i32 { sum(__N__, 0) }
  `;
}

function tailPipeline(): string {
  return `
    fn even(x: i32) -> bool { (x / 2) * 2 == x }
    fn square(x: i32) -> i32 { x * x }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn fold(i: i32, end: i32, acc: i32) -> i32 {
      match i < end {
        true => match even(i) {
          true => fold(i + 1, end, add(acc, square(i))),
          false => fold(i + 1, end, acc),
        },
        false => acc,
      }
    }
    pub fn main() -> i32 { fold(0, __N__, 0) }
  `;
}

function nonTailPipeline(): string {
  return tailPipeline()
    .replaceAll("fold(i_next_even + 1", "0 + fold(i_next_even + 1")
    .replaceAll("fold(i_next_odd + 1", "0 + fold(i_next_odd + 1");
}

function tailStress(): string {
  return `
    fn count_down(n: i32, acc: i32) -> i32 {
      match n { 0 => acc, _ => count_down(n - 1, acc + 1) }
    }
    pub fn main() -> i32 { count_down(__N__, 0) }
  `;
}

function nonTailStress(): string {
  return `
    fn count_down(n: i32, acc: i32) -> i32 {
      match n { 0 => acc, _ => 0 + count_down(n - 1, acc + 1) }
    }
    pub fn main() -> i32 { count_down(__N__, 0) }
  `;
}
