import { wasmFromSource, watFromSource } from "../src/mod.ts";

const iterations = Number(Deno.args[0] ?? 100_000);
const scalarSource = await Deno.readTextFile("examples/perf_matmul_scalar.fig");
const simdSource = await Deno.readTextFile("examples/perf_matmul_simd.fig");
const memSource = await Deno.readTextFile("examples/perf_matmul_mem_simd.fig");

const scalarWat = await watFromSource(scalarSource);
const simdWat = await watFromSource(simdSource);
const memWat = await watFromSource(memSource);

if (scalarWat.includes("i32x4.")) {
  throw new Error("scalar matrix multiplication benchmark unexpectedly lowered to SIMD");
}
for (const [name, wat] of [["simd", simdWat], ["memory_simd", memWat]] as const) {
  if (!wat.includes("i32x4.mul") || !wat.includes("i8x16.shuffle")) {
    throw new Error(`${name} matrix multiplication benchmark did not lower to SIMD reduction`);
  }
}
if (
  !memWat.includes('(memory (export "memory") 1)') || !memWat.includes("v128.load") ||
  !memWat.includes("v128.store")
) {
  throw new Error("memory-backed benchmark did not emit exported memory and v128 load/store");
}

const scalarMain = instantiateMain(await wasmFromSource(scalarSource));
const simdMain = instantiateMain(await wasmFromSource(simdSource));
const memInstance = new WebAssembly.Instance(
  new WebAssembly.Module(await wasmFromSource(memSource)),
);
const memMain = memInstance.exports.main as CallableFunction;
const memory = memInstance.exports.memory as WebAssembly.Memory;

const args = [
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

const expected = [
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
];

assertResult("scalar", scalarMain(...args) as number[], expected);
assertResult("simd", simdMain(...args) as number[], expected);

const aPtr = 0;
const bPtr = 64;
const cPtr = 128;
const memoryI32 = new Int32Array(memory.buffer);
memoryI32.set(args.slice(0, 16), aPtr / 4);
memoryI32.set(args.slice(16), bPtr / 4);
memMain(aPtr, bPtr, cPtr);
assertResult("memory_simd", Array.from(memoryI32.slice(cPtr / 4, cPtr / 4 + 16)), expected);

const scalar = timeLoop(() => scalarMain(...args) as number[]);
const simd = timeLoop(() => simdMain(...args) as number[]);
const memorySimd = timeMemoryLoop(() => memMain(aPtr, bPtr, cPtr));

console.table([{
  iterations,
  scalar_ms: scalar.elapsedMs.toFixed(3),
  simd_ms: simd.elapsedMs.toFixed(3),
  memory_simd_ms: memorySimd.elapsedMs.toFixed(3),
  scalar_calls_per_ms: (iterations / scalar.elapsedMs).toFixed(3),
  simd_calls_per_ms: (iterations / simd.elapsedMs).toFixed(3),
  memory_simd_calls_per_ms: (iterations / memorySimd.elapsedMs).toFixed(3),
  simd_speedup: (scalar.elapsedMs / simd.elapsedMs).toFixed(3),
  memory_simd_speedup: (scalar.elapsedMs / memorySimd.elapsedMs).toFixed(3),
  checksum: `${scalar.checksum}/${simd.checksum}/${memorySimd.checksum}`,
  simd_mul_ops: count(simdWat, /i32x4\.mul/g),
  simd_shuffle_ops: count(simdWat, /i8x16\.shuffle/g),
  memory_simd_load_ops: count(memWat, /v128\.load/g),
  memory_simd_store_ops: count(memWat, /v128\.store/g),
  memory_simd_mul_ops: count(memWat, /i32x4\.mul/g),
  memory_simd_shuffle_ops: count(memWat, /i8x16\.shuffle/g),
}]);

function instantiateMain(wasm: Uint8Array<ArrayBuffer>): CallableFunction {
  return new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.main as CallableFunction;
}

function timeLoop(call: () => number[]) {
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < iterations; i++) checksum += call()[0];
  return { elapsedMs: performance.now() - start, checksum };
}

function timeMemoryLoop(call: () => unknown) {
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    call();
    checksum += memoryI32[cPtr / 4];
  }
  return { elapsedMs: performance.now() - start, checksum };
}

function assertResult(name: string, actual: number[], expectedResult: number[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expectedResult)) {
    throw new Error(`${name} matmul result mismatch: ${JSON.stringify(actual)}`);
  }
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}
