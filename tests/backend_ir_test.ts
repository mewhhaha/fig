import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { wasmFromSource, watFromSource } from "../src/mod.ts";

Deno.test("WAT and wasm share lowered import signatures", async () => {
  const source = `
    const clock: fn() -> i32 !{time} = @capability("clock");
    const random: fn(seed: i32) -> i32 !{entropy} = @capability("random");
    pub fn main() -> i32 !{time, entropy} { clock() + random(1) }
  `;

  const wat = await watFromSource(source);
  assertStringIncludes(wat, `(func $clock (import "env" "clock") (result i32))`);
  assertStringIncludes(wat, `(func $random (import "env" "random") (param i32) (result i32))`);

  const module = new WebAssembly.Module(await wasmFromSource(source));
  assertEquals(
    WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}:${item.kind}`),
    ["env.clock:function", "env.random:function"],
  );
});

Deno.test("backend folds scalar literal arithmetic", async () => {
  const wat = await watFromSource(`pub fn main() -> i32 { 40 + 2 }`);
  assertStringIncludes(wat, "i32.const 42");
  assert(!wat.includes("i32.add"));
});

Deno.test("backend lowers runtime inline-array indexing with branches", async () => {
  const wat = await watFromSource(`
    type fn inline_array(N: count, A: type) -> type {
      let InlineArray = {N*A};
      struct(InlineArray)
    }
    fn get(xs: inline_array(3, i32), index: i32) -> i32 {
      xs[index]
    }
    pub fn main() -> i32 {
      get([4, 5, 6], 1)
    }
  `);
  assertStringIncludes(wat, "if (result i32)");
  assertStringIncludes(wat, "local.get $xs$1");
});

Deno.test("backend does not allocate unused pure locals", async () => {
  const wat = await watFromSource(`
    pub fn main() -> i32 {
      let unused: i32 = 1 + 2;
      9
    }
  `);
  assert(!wat.includes("(local $unused"));
  assert(!wat.includes("i32.const 3"));
});

Deno.test("backend preserves and drops unused effectful capability calls", async () => {
  const wat = await watFromSource(`
    const clock: fn() -> i32 !{time} = @capability("clock");
    pub fn main() -> i32 !{time} {
      let unused: i32 = clock();
      7
    }
  `);
  assertStringIncludes(wat, "call $clock");
  assertStringIncludes(wat, "drop");
});

Deno.test("backend removes private functions unreachable from exports", async () => {
  const wat = await watFromSource(`
    fn unused() -> i32 { 1 }
    fn used() -> i32 { 2 }
    pub fn main() -> i32 { used() }
  `);
  assert(!wat.includes("(func $unused"));
  assertStringIncludes(wat, "(func $used");
});

Deno.test("tail-recursive self calls lower to loops by default", async () => {
  const source = `
    fn sum(n: i32, acc: i32) -> i32 {
      match n { 0 => acc, _ => sum(n - 1, acc + n) }
    }
    pub fn main() -> i32 { sum(100, 0) }
  `;
  const wat = await watFromSource(source);
  const sum = wat.match(/\(func \$sum[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(sum, "loop");
  assert(!sum.includes("call $sum"));
  assert(!sum.includes("return_call $sum"));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 5050);
});

Deno.test("tail-recursive inline-array fold lowers to a loop", async () => {
  const source = `
    type fn inline_array(N: count, A: type) -> type {
      let InlineArray = {N*A};
      struct(InlineArray)
    }
    fn fold_loop(xs: inline_array(3, i32), index: i32, acc: i32) -> i32 {
      let xs_for_get, xs_for_next = fork(xs);
      match index < 3 {
        true => fold_loop(xs_for_next, index + 1, acc + xs_for_get[index]),
        false => acc,
      }
    }
    pub fn main() -> i32 {
      fold_loop([1, 2, 3], 0, 0)
    }
  `;
  const wat = await watFromSource(source);
  const fold = wat.match(/\(func \$fold_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(fold, "loop");
  assert(!fold.includes("call $fold_loop"));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 6);
});

Deno.test("index cursor Yield item proves inline-array indexing and lowers inline", async () => {
  const source = `
    const core = @import("prelude.core");
    type fn inline_array(N: count, A: type) -> type {
      let InlineArray = {N*A};
      struct(InlineArray)
    }
    fn sum_loop(xs: inline_array(3, i32), cursor: core.index_cursor(3), acc: i32) -> i32 {
      let xs_for_get, xs_for_next = fork(xs);
      match core.index_cursor.next(3, cursor) {
        Yield(i, next) => sum_loop(xs_for_next, next, acc + xs_for_get[i]),
        Done => acc,
      }
    }
    pub fn main() -> i32 {
      sum_loop([10, 20, 12], core.index_cursor.start(3), 0)
    }
  `;
  const wat = await watFromSource(source);
  const sum = wat.match(/\(func \$sum_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(sum, "loop");
  assert(!sum.includes("index_cursor.next"));
  assert(!sum.includes("call $sum_loop"));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 42);
});

Deno.test("inline array builder primitives lower without runtime calls", async () => {
  const wat = await watFromSource(`
    type fn index(N: count) -> type { i32 }
    type fn inline_array(N: count, A: type) -> type {
      let InlineArray = {N*A};
      struct(InlineArray)
    }
    type fn inline_array_builder(N: count, A: type) -> type {
      let Builder = {N*A};
      struct(Builder)
    }
    fn inline_array_builder.start(const n: count, const a: type) -> inline_array_builder(n, a) {
      @inline_array_builder_start(n, a)
    }
    fn inline_array_builder.push(
      const n: count,
      const a: type,
      builder: inline_array_builder(n, a),
      i: index(n),
      value: a
    ) -> inline_array_builder(n, a) {
      @inline_array_builder_push(n, a, builder, i, value)
    }
    fn inline_array_builder.finish(const n: count, const a: type, builder: inline_array_builder(n, a)) -> inline_array(n, a) {
      @inline_array_builder_finish(n, a, builder)
    }
    pub fn main() -> i32 {
      let b0 = inline_array_builder.start(2, i32);
      let b1 = inline_array_builder.push(2, i32, b0, 0, 10);
      let b2 = inline_array_builder.push(2, i32, b1, 1, 20);
      let xs = inline_array_builder.finish(2, i32, b2);
      xs[0] + xs[1]
    }
  `);

  assert(!wat.includes("inline_array_builder.start"));
  assert(!wat.includes("inline_array_builder.push"));
  assert(!wat.includes("inline_array_builder.finish"));
  assert(!wat.includes("call $inline_array_builder"));
});

Deno.test("direct self-tail body lowers to a loop by default", async () => {
  const source = `
    fn again(n: i32, acc: i32) -> i32 { again(n - 1, acc + n) }
    pub fn main() -> i32 { again(1, 0) }
  `;
  const wat = await watFromSource(source);
  const again = wat.match(/\(func \$again[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(again, "loop");
  assert(!again.includes("call $again"));
  assert(!again.includes("return_call $again"));
});

Deno.test("tail-recursive match arms can emit return_call when requested", async () => {
  const source = `
    fn sum(n: i32, acc: i32) -> i32 {
      match n { 0 => acc, _ => sum(n - 1, acc + n) }
    }
    pub fn main() -> i32 { sum(10, 0) }
  `;
  const wat = await watFromSource(source, { tailCallMode: "opcode" });
  const sum = wat.match(/\(func \$sum[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(sum, "return_call $sum");

  const loopInstance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source)),
  );
  const opcodeInstance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { tailCallMode: "opcode" })),
  );
  assertEquals(
    (opcodeInstance.exports.main as CallableFunction)(),
    (loopInstance.exports.main as CallableFunction)(),
  );
});

Deno.test("opcode mode rejects non-tail self recursion", async () => {
  await assertTailCallRejected(
    "arithmetic operand",
    `
      fn bad(n: i32) -> i32 { match n { 0 => 0, _ => 1 + bad(n - 1) } }
      pub fn main() -> i32 { bad(3) }
    `,
  );
});

Deno.test("opcode mode rejects direct self recursion outside tail position", async () => {
  await assertTailCallRejected(
    "call argument",
    `
    fn id(x: i32) -> i32 { x }
    fn call_arg(n: i32) -> i32 { match n { 0 => 0, _ => id(call_arg(n - 1)) } }
    pub fn main() -> i32 { call_arg(3) }
  `,
  );
  await assertTailCallRejected(
    "let initializer",
    `
    fn let_init(n: i32) -> i32 {
      let x: i32 = let_init(n - 1);
      x
    }
    pub fn main() -> i32 { let_init(3) }
  `,
  );
  await assertTailCallRejected(
    "dynamic index operand",
    `
    type fn inline_array(N: count, A: type) {
      let InlineArray = {N*A};
      struct(InlineArray)
    }
    type fn lane4_i32() -> type { inline_array(4, i32) }
    fn memory.load_lane4_i32(mem: memory, p: ptr(lane4_i32)) -> lane4_i32 {
  @memory_load_lane4_i32(mem, p)
}
    fn memory.store_lane4_i32(mem: memory, p: ptr(lane4_i32), value: lane4_i32) -> memory {
  @memory_store_lane4_i32(mem, p, value)
}
    type fn index(N: count) -> type { i32 }
    fn dynamic_index_target(n: i32, i: index(4)) -> lane4_i32 {
      let i_call, i_read = fork(i);
      match n { 0 => [0, 0, 0, 0], _ => [dynamic_index_target(n - 1, i_call)[i_read], 0, 0, 0] }
    }
    pub fn main(i: index(4)) -> i32 {
      let i_call, i_read = fork(i);
      dynamic_index_target(3, i_call)[i_read]
    }
  `,
  );
});

async function assertTailCallRejected(label: string, source: string) {
  try {
    await watFromSource(source, { tailCallMode: "opcode" });
  } catch (error) {
    assert(error instanceof Error);
    assertStringIncludes(error.message, "not eligible");
    return;
  }
  throw new Error(`expected non-tail recursive function to be rejected: ${label}`);
}

Deno.test("backend keeps generated forwarding wrappers inlined at call sites", async () => {
  const wat = await watFromSource(`
    type fn box() { let Box = {value: i32}; struct(Box) }
    type fn functor(F: type) { let Functor = {map: fn(x: F) -> F}; struct(Functor) }
    fn map_box(x: box) -> box { {value: x.value + 1} }
    const box_functor: functor(box) = {map: map_box};
    fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
    pub fn main() -> box { mapped(box_functor, {value: 41}) }
  `);
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "call $map_box");
  assert(!wat.includes("(func $mapped__box_functor"));
});

Deno.test("lane4_i32 public ABI stays scalar while pure lane add uses SIMD internally", async () => {
  const source = `
    type fn inline_array(N: count, A: type) {
      let InlineArray = {N*A};
      struct(InlineArray)
    }
    type fn lane4_i32() -> type { inline_array(4, i32) }
    fn memory.load_lane4_i32(mem: memory, p: ptr(lane4_i32)) -> lane4_i32 {
  @memory_load_lane4_i32(mem, p)
}
    fn memory.store_lane4_i32(mem: memory, p: ptr(lane4_i32), value: lane4_i32) -> memory {
  @memory_store_lane4_i32(mem, p, value)
}
    pub fn main(x: lane4_i32, k: i32) -> lane4_i32 {
      [x[0] + k, x[1] + k, x[2] + k, x[3] + k]
    }
  `;
  const wat = await watFromSource(source);
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";

  assertStringIncludes(
    main,
    "(param $x$0 i32) (param $x$1 i32) (param $x$2 i32) (param $x$3 i32) (param $k i32)",
  );
  assertStringIncludes(main, "(result i32) (result i32) (result i32) (result i32)");
  assert(!main.includes("(param v128)"));
  assert(!main.includes("(result v128)"));
  assertStringIncludes(main, "i32x4.splat");
  assertStringIncludes(main, "i32x4.add");

  new WebAssembly.Module(await wasmFromSource(source));
});

Deno.test("SIMD lane add matches scalar result", async () => {
  const source = `
    type fn inline_array(N: count, A: type) {
      let InlineArray = {N*A};
      struct(InlineArray)
    }
    type fn lane4_i32() -> type { inline_array(4, i32) }
    fn memory.load_lane4_i32(mem: memory, p: ptr(lane4_i32)) -> lane4_i32 {
  @memory_load_lane4_i32(mem, p)
}
    fn memory.store_lane4_i32(mem: memory, p: ptr(lane4_i32), value: lane4_i32) -> memory {
  @memory_store_lane4_i32(mem, p, value)
}
    pub fn main(x: lane4_i32, k: i32) -> lane4_i32 {
      [x[0] + k, x[1] + k, x[2] + k, x[3] + k]
    }
  `;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(1, 2, 3, 4, 10), [11, 12, 13, 14]);
});

Deno.test("SIMD dot product lowers matrix multiply kernel", async () => {
  const source = await Deno.readTextFile("examples/perf_matmul_simd.fig");
  const wat = await watFromSource(source);

  assertStringIncludes(wat, "i32x4.mul");
  assertStringIncludes(wat, "i8x16.shuffle");
  assertStringIncludes(wat, "i32x4.add");
  assertStringIncludes(wat, "i32x4.extract_lane");

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals(
    (instance.exports.main as CallableFunction)(
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
    ),
    [
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
  );
});

Deno.test("scalar matrix multiply baseline stays scalar", async () => {
  const source = await Deno.readTextFile("examples/perf_matmul_scalar.fig");
  const wat = await watFromSource(source);

  assert(!wat.includes("i32x4."));
  assertStringIncludes(wat, "i32.mul");
  assertStringIncludes(wat, "i32.add");

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals(
    (instance.exports.main as CallableFunction)(
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
    ),
    [
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
  );
});

Deno.test("memory-backed SIMD matrix multiply emits and runs with wasm memory", async () => {
  const source = await Deno.readTextFile("examples/perf_matmul_mem_simd.fig");
  const wat = await watFromSource(source);

  assertStringIncludes(wat, `(memory (export "memory") 1)`);
  assertStringIncludes(wat, "(param $a i32) (param $b i32) (param $c i32)");
  assertStringIncludes(wat, "v128.load");
  assertStringIncludes(wat, "v128.store");
  assertStringIncludes(wat, "i32x4.mul");
  assertStringIncludes(wat, "i8x16.shuffle");
  assertStringIncludes(wat, "i32x4.add");
  assert(!wat.includes("i32.load"));
  assert(!wat.includes("i32.store"));
  assert(!wat.includes("call $ptr_i32"));
  assert(!wat.includes("call $ptr_lane4_i32"));
  assert(!wat.includes("call $ptr.add"));
  assert(!wat.includes("call $load_lane4_i32"));
  assert(!wat.includes("call $store_lane4_i32"));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  const memory = instance.exports.memory as WebAssembly.Memory;
  const memoryI32 = new Int32Array(memory.buffer);
  memoryI32.set([
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
  ], 0);
  memoryI32.set([
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
  ], 16);
  (instance.exports.main as CallableFunction)(0, 64, 128);

  assertEquals(
    Array.from(memoryI32.slice(32, 48)),
    [
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
  );
});

Deno.test("ptr constructor helper lowers to direct memory address", async () => {
  const wat = await watFromSource(`
    type fn ptr(A: type) -> type {
      let Ptr = {addr: i32};
      struct(Ptr)
    }
    fn memory.load_i32(mem: memory, p: ptr(i32)) -> i32 {
  @memory_load_i32(mem, p)
}
    fn memory.store_i32(mem: memory, p: ptr(i32), value: i32) -> memory {
  @memory_store_i32(mem, p, value)
}
    fn ptr.from_i32(addr: i32) -> ptr(A) {
  @ptr_from_i32(addr)
}
    fn ptr.add(p: ptr(A), bytes: i32) -> ptr(A) {
  @ptr_add(p, bytes)
}
    pub fn main(mem0: memory, p: i32) -> i32 {
      memory.load_i32(mem0, ptr.from_i32(p + 4))
    }
  `);
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";

  assertStringIncludes(main, "local.get $p");
  assertStringIncludes(main, "i32.const 4");
  assertStringIncludes(main, "i32.add");
  assertStringIncludes(main, "i32.load");
  assert(!wat.includes("call $ptr_i32"));
});

Deno.test("chained ptr.add helpers lower without helper calls", async () => {
  const wat = await watFromSource(`
    type fn ptr(A: type) -> type {
      let Ptr = {addr: i32};
      struct(Ptr)
    }
    fn memory.load_i32(mem: memory, p: ptr(i32)) -> i32 {
  @memory_load_i32(mem, p)
}
    fn memory.store_i32(mem: memory, p: ptr(i32), value: i32) -> memory {
  @memory_store_i32(mem, p, value)
}
    fn ptr.from_i32(addr: i32) -> ptr(A) {
  @ptr_from_i32(addr)
}
    fn ptr.add(p: ptr(A), bytes: i32) -> ptr(A) {
  @ptr_add(p, bytes)
}
        pub fn main(mem0: memory, p: i32) -> i32 {
      memory.load_i32(mem0, ptr.add(ptr.add(ptr.from_i32(p), 16), 32))
    }
  `);
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";

  assertStringIncludes(main, "local.get $p");
  assertStringIncludes(main, "i32.const 16");
  assertStringIncludes(main, "i32.const 32");
  assertEquals(main.match(/i32.add/g)?.length, 2);
  assertStringIncludes(main, "i32.load");
  assert(!wat.includes("call $ptr_i32"));
  assert(!wat.includes("call $ptr.add"));
});

Deno.test("scalar load/store aliases lower to memory instructions without helper calls", async () => {
  const wat = await watFromSource(`
    type fn ptr(A: type) -> type {
      let Ptr = {addr: i32};
      struct(Ptr)
    }
    fn memory.load_i32(mem: memory, p: ptr(i32)) -> i32 {
  @memory_load_i32(mem, p)
}
    fn memory.store_i32(mem: memory, p: ptr(i32), value: i32) -> memory {
  @memory_store_i32(mem, p, value)
}
    fn ptr.from_i32(addr: i32) -> ptr(A) {
  @ptr_from_i32(addr)
}
    fn ptr.add(p: ptr(A), bytes: i32) -> ptr(A) {
  @ptr_add(p, bytes)
}
    fn load_i32(mem: memory, p: ptr(i32)) -> i32 {
      memory.load_i32(mem, p)
    }
    fn store_i32(mem: memory, p: ptr(i32), value: i32) -> memory {
      memory.store_i32(mem, p, value)
    }
    pub fn main(mem0: memory, p: i32) -> memory {
      let base: ptr(i32) = ptr.from_i32(p);
      let pp, qp = fork(base);
      let x: i32 = memory.load_i32(mem0, pp);
      memory.store_i32(mem0, qp, x + 1)
    }
  `);

  assertStringIncludes(wat, `(memory (export "memory") 1)`);
  assertStringIncludes(wat, "i32.load");
  assertStringIncludes(wat, "i32.store");
  assert(!wat.includes("call $load_i32"));
  assert(!wat.includes("call $store_i32"));
});

Deno.test("ptr params locals and forks lower as scalar i32 values", async () => {
  const wat = await watFromSource(`
    type fn ptr(A: type) -> type {
      let Ptr = {addr: i32};
      struct(Ptr)
    }
    fn ptr.from_i32(addr: i32) -> ptr(A) {
  @ptr_from_i32(addr)
}
    fn ptr.add(p: ptr(A), bytes: i32) -> ptr(A) {
  @ptr_add(p, bytes)
}
    fn bump(p: ptr(i32)) -> ptr(i32) {
      ptr.add(p, 4)
    }
    pub fn main(p: i32) -> i32 {
      let base: ptr(i32) = ptr.from_i32(p);
      let p0, p1 = fork(base);
      let moved: ptr(i32) = bump(p0);
      ptr.add(moved, p1)
    }
  `);
  const bump = wat.match(/\(func \$bump[\s\S]*?\n  \)/)?.[0] ?? "";
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";

  assertStringIncludes(bump, `(func $bump (param $p i32) (result i32)`);
  assertStringIncludes(main, `(local $base i32)`);
  assertStringIncludes(main, `(local $p0 i32)`);
  assertStringIncludes(main, `(local $p1 i32)`);
  assert(!wat.includes("$addr"));
  assert(!wat.includes("call $ptr.add"));
});

Deno.test("lane4 load/store aliases lower to SIMD memory instructions without helper calls", async () => {
  const wat = await watFromSource(`
    type fn inline_array(N: count, A: type) -> type {
      let InlineArray = {N*A};
      struct(InlineArray)
    }
    type fn lane4_i32() -> type { inline_array(4, i32) }
    fn memory.load_lane4_i32(mem: memory, p: ptr(lane4_i32)) -> lane4_i32 {
  @memory_load_lane4_i32(mem, p)
}
    fn memory.store_lane4_i32(mem: memory, p: ptr(lane4_i32), value: lane4_i32) -> memory {
  @memory_store_lane4_i32(mem, p, value)
}
    type fn ptr(A: type) -> type {
      let Ptr = {addr: i32};
      struct(Ptr)
    }
    fn memory.load_i32(mem: memory, p: ptr(i32)) -> i32 {
  @memory_load_i32(mem, p)
}
    fn memory.store_i32(mem: memory, p: ptr(i32), value: i32) -> memory {
  @memory_store_i32(mem, p, value)
}
    fn ptr.from_i32(addr: i32) -> ptr(A) {
  @ptr_from_i32(addr)
}
    fn ptr.add(p: ptr(A), bytes: i32) -> ptr(A) {
  @ptr_add(p, bytes)
}
    fn load_lane4_i32(mem: memory, p: ptr(lane4_i32)) -> lane4_i32 {
      memory.load_lane4_i32(mem, p)
    }
    fn store_lane4_i32(
      mem: memory,
      p: ptr(lane4_i32),
      value: lane4_i32
    ) -> memory {
      memory.store_lane4_i32(mem, p, value)
    }
    pub fn main(mem0: memory, a: i32, c: i32) -> memory {
      let row: lane4_i32 = memory.load_lane4_i32(mem0, ptr.from_i32(a));
      memory.store_lane4_i32(mem0, ptr.from_i32(c), row)
    }
  `);

  assertStringIncludes(wat, `(memory (export "memory") 1)`);
  assertStringIncludes(wat, "v128.load");
  assertStringIncludes(wat, "v128.store");
  assert(!wat.includes("call $load_lane4_i32"));
  assert(!wat.includes("call $store_lane4_i32"));
});

Deno.test("memory lane intrinsics remain backend aliases", async () => {
  const wat = await watFromSource(`
    type fn inline_array(N: count, A: type) -> type {
      let InlineArray = {N*A};
      struct(InlineArray)
    }
    type fn lane4_i32() -> type { inline_array(4, i32) }
    fn memory.load_lane4_i32(mem: memory, p: ptr(lane4_i32)) -> lane4_i32 {
  @memory_load_lane4_i32(mem, p)
}
    fn memory.store_lane4_i32(mem: memory, p: ptr(lane4_i32), value: lane4_i32) -> memory {
  @memory_store_lane4_i32(mem, p, value)
}
    pub fn main(mem0: memory, a: i32, c: i32) -> memory {
      let row: lane4_i32 = memory.load_lane4_i32(mem0, ptr.from_i32(a));
      memory.store_lane4_i32(mem0, ptr.from_i32(c), row)
    }
  `);

  assertStringIncludes(wat, `(memory (export "memory") 1)`);
  assertStringIncludes(wat, "v128.load");
  assertStringIncludes(wat, "v128.store");
});

Deno.test("unsupported lane patterns fall back to scalar WAT", async () => {
  const wat = await watFromSource(`
    type fn inline_array(N: count, A: type) {
      let InlineArray = {N*A};
      struct(InlineArray)
    }
    type fn lane4_i32() -> type { inline_array(4, i32) }
    fn memory.load_lane4_i32(mem: memory, p: ptr(lane4_i32)) -> lane4_i32 {
  @memory_load_lane4_i32(mem, p)
}
    fn memory.store_lane4_i32(mem: memory, p: ptr(lane4_i32), value: lane4_i32) -> memory {
  @memory_store_lane4_i32(mem, p, value)
}
    pub fn main(x: lane4_i32) -> lane4_i32 {
      [x[0] + 1, x[1] + 2, x[2] + 3, x[3] + 4]
    }
  `);

  assert(!wat.includes("i32x4."));
  assertStringIncludes(wat, "i32.add");
});
