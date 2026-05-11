import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { wasmFromSource, watFromSource } from "../src/mod.ts";

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

function hasCustomSection(bytes: Uint8Array, name: string): boolean {
  let offset = 8;
  while (offset < bytes.length) {
    const id = bytes[offset++];
    const size = readUleb(bytes, offset);
    offset = size.offset;
    const payloadEnd = offset + size.value;
    if (id === 0) {
      const sectionName = readName(bytes, offset);
      if (sectionName.value === name) return true;
    }
    offset = payloadEnd;
  }
  return false;
}

function readName(bytes: Uint8Array, offset: number): { value: string; offset: number } {
  const size = readUleb(bytes, offset);
  const start = size.offset;
  const end = start + size.value;
  return { value: new TextDecoder().decode(bytes.slice(start, end)), offset: end };
}

function readUleb(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, offset };
}

Deno.test("WAT and wasm share lowered import signatures", async () => {
  const source = `
    const clock: fn() -> i32 !{time} = @capability("clock");
    const random: fn(seed: i32) -> i32 !{entropy} = @capability("random");
    pub fn main() -> i32 !{time, entropy} { clock() + random(1) }
  `;

  const wat = await watFromSource(source, { memoryModel: "temporal" });
  assertStringIncludes(wat, `(func $clock (import "env" "clock") (result i32))`);
  assertStringIncludes(wat, `(func $random (import "env" "random") (param i32) (result i32))`);

  const module = new WebAssembly.Module(await wasmFromSource(source));
  assertEquals(
    WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}:${item.kind}`),
    ["env.clock:function", "env.random:function"],
  );
});

Deno.test("debug is the default opt mode and emits wasm name section", async () => {
  const source = `
    fn add1(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { add1(41) }
  `;
  const debugWat = await watFromSource(source);
  assertStringIncludes(debugWat, "(func $add1");
  assertStringIncludes(debugWat, "call $add1");

  const debugWasm = await wasmFromSource(source);
  assert(hasCustomSection(debugWasm, "name"));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(debugWasm));
  assertEquals((instance.exports.main as CallableFunction)(), 42);

  const releaseWat = await watFromSource(source, { optMode: "release" });
  assert(!releaseWat.includes("(func $add1"));
  assert(!releaseWat.includes("call $add1"));
  assert(!hasCustomSection(await wasmFromSource(source, { optMode: "release" }), "name"));
});

Deno.test("backend folds scalar literal arithmetic", async () => {
  const wat = await watFromSource(`pub fn main() -> i32 { 40 + 2 }`, { optMode: "release" });
  assertStringIncludes(wat, "i32.const 42");
  assert(!wat.includes("i32.add"));
});

Deno.test("backend lowers runtime inline-array indexing with scalar select", async () => {
  const wat = await watFromSource(`
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn get(xs: InlineArray(3, i32), index: i32) -> i32 {
      xs[index]
    }
    pub fn main() -> i32 {
      get([4, 5, 6], 1)
    }
  `);
  assertStringIncludes(wat, "select");
  assertStringIncludes(wat, "i32.eq");
  assertStringIncludes(wat, "i32.const 1");
});

Deno.test("backend does not allocate unused pure locals", async () => {
  const wat = await watFromSource(
    `
    pub fn main() -> i32 {
      let unused: i32 = 1 + 2;
      9
    }
  `,
    { optMode: "release" },
  );
  assert(!wat.includes("(local $unused"));
  assert(!wat.includes("i32.const 3"));
});

Deno.test("backend uses local tee for immediate set get roundtrips", async () => {
  const wat = await watFromSource(
    `
    pub fn main() -> i32 {
      let x = 41;
      x + 1
    }
  `,
    { optMode: "release" },
  );
  const main = wat.match(/\(func \$main__optimized[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "local.tee $x");
  assert(!main.includes("local.set $x\n    local.get $x"));
});

Deno.test("backend removes unreachable instructions after branch terminators", async () => {
  const wat = await watFromSource(
    `
    fn loop_forever() -> i32 { loop_forever() }
    pub fn main() -> i32 { loop_forever() }
  `,
    { optMode: "release" },
  );
  const loop = wat.match(/\(func \$loop_forever[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(loop, "br 0");
  assert(!loop.includes("br 0\n        unreachable"));
});

Deno.test("optimizer simplifies numeric identities without dropping effects", async () => {
  const pure = await watFromSource(
    `
    pub fn main(x: i32) -> i32 { (x * 1) + 0 }
  `,
    { optMode: "release" },
  );
  const pureMain = pure.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!pureMain.includes("i32.mul"));
  assert(!pureMain.includes("i32.add"));

  const samePure = await watFromSource(
    `
    pub fn main(seed: i32) -> i32 { seed - seed }
  `,
    { optMode: "release" },
  );
  const samePureMain = samePure.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(samePureMain, "i32.const 0");
  assert(!samePureMain.includes("i32.sub"));

  const effectful = await watFromSource(
    `
    const clock: fn() -> i32 !{time} = @capability("clock");
    pub fn main() -> i32 !{time} { clock() * 0 }
  `,
    { optMode: "release" },
  );
  assertStringIncludes(effectful, "call $clock");
  assertStringIncludes(effectful, "i32.mul");
});

Deno.test("benchmark-style internal loop calls private kernel directly", async () => {
  const source = `
    fn __bench_kernel(seed: i32) -> i32 {
      let x = seed + 10;
      x + x + x + x
    }
    pub fn main(seed: i32) -> i32 {
      __bench_kernel(seed)
    }
    pub fn bench(iterations: i32) -> i32 {
      bench_loop(0, iterations, 0)
    }
    fn bench_loop(i: i32, end: i32, checksum: i32) -> i32 {
      match i < end {
        true => bench_loop(i + 1, end, checksum + __bench_kernel(i)),
        false => checksum,
      }
    }
  `;
  const wat = await watFromSource(source, { memoryModel: "branch", optMode: "release" });
  const benchLoop = wat.match(/\(func \$bench_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(benchLoop, "loop");
  assert(!benchLoop.includes("call $main"));
  assert(!benchLoop.includes("call $bench_loop"));
  assert(!wat.includes("fig_logs"));
  assert(!wat.includes("fig_objects"));
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

Deno.test("wildcard match skips pure scrutinee but preserves effectful scrutinee", async () => {
  const pure = await watFromSource(`
    fn ignored() -> i32 { 1 + 2 }
    pub fn main() -> i32 {
      match ignored() { _ => 7 }
    }
  `);
  assert(!pure.includes("call $ignored"));
  assert(!pure.includes("i32.const 3"));

  const effectful = await watFromSource(`
    const clock: fn() -> i32 !{time} = @capability("clock");
    pub fn main() -> i32 !{time} {
      match clock() { _ => 7 }
    }
  `);
  assertStringIncludes(effectful, "call $clock");
  assertStringIncludes(effectful, "drop");
});

Deno.test("backend removes private functions unreachable from exports", async () => {
  const wat = await watFromSource(
    `
    fn unused() -> i32 { 1 }
    fn used() -> i32 { 2 }
    pub fn main() -> i32 { used() }
  `,
    { optMode: "release" },
  );
  assert(!wat.includes("(func $unused"));
  assert(!wat.includes("(func $used"));
  assert(!wat.includes("call $used"));
});

Deno.test("optimizer drops pure unused private call arguments only when safe", async () => {
  const pure = await watFromSource(
    `
    fn keep_second(_: i32, b: i32) -> i32 {
      b + b + b + b + b + b + b + b + b + b + b + b
    }
    pub fn main() -> i32 { keep_second(40 + 2, 6) }
  `,
    { optMode: "release" },
  );
  assertStringIncludes(pure, `(func $keep_second (param $b i32) (result i32)`);
  assert(!pure.includes("i32.const 42"));

  const effectful = await watFromSource(
    `
    const clock: fn() -> i32 !{time} = @capability("clock");
    fn keep_second(_: i32, b: i32) -> i32 {
      b + b + b + b + b + b + b + b + b + b + b + b
    }
    pub fn main() -> i32 !{time} { keep_second(clock(), 6) }
  `,
    { optMode: "release" },
  );
  assertStringIncludes(effectful, `(func $keep_second (param $__pattern_`);
  assertStringIncludes(effectful, "call $clock");
  assertStringIncludes(effectful, "call $keep_second");
});

Deno.test("tail-recursive self calls lower to loops by default", async () => {
  const source = `
    fn sum(n: i32, acc: i32) -> i32 {
      match n { 0 => acc, _ => sum(n - 1, acc + n) }
    }
    pub fn main() -> i32 { sum(100, 0) }
  `;
  const wat = await watFromSource(source, { memoryModel: "temporal" });
  const sum = wat.match(/\(func \$sum[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(sum, "loop");
  assert(!sum.includes("call $sum"));
  assert(!sum.includes("return_call $sum"));
  assert(!sum.includes("__tail_tmp"));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 5050);
});

Deno.test("boolean true match patterns branch directly", async () => {
  const wat = await watFromSource(`
    pub fn lt(x: i32, y: i32) -> i32 {
      match x < y { true => 1, false => 0 }
    }
    pub fn main() -> i32 { lt(1, 2) }
  `);
  const lt = wat.match(/\(func \$lt[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(lt, "i32.lt_s");
  assert(!lt.includes("i32.const 1\n    i32.eq"));
});

Deno.test("tail-recursive inline-array fold lowers to a loop", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn fold_loop(xs: InlineArray(3, i32), index: i32, acc: i32) -> i32 {
      match index < 3 {
        true => fold_loop(xs, index + 1, acc + xs[index]),
        false => acc,
      }
    }
    pub fn main() -> i32 {
      fold_loop([1, 2, 3], 0, 0)
    }
  `;
  const wat = await watFromSource(source, { memoryModel: "temporal" });
  const fold = wat.match(/\(func \$fold_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(fold, "loop");
  assert(!fold.includes("call $fold_loop"));
  assert(!fold.includes("__tail_tmp"));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 6);
});

Deno.test("private pipe-bind product search chain fuses into tail loop", async () => {
  const source = `
    type fn State() -> type {
      let State = {x: i32, r: i32, sum: i32};
      struct(State)
    }
    fn prepare(state: State) -> State {
      State { x: state.x + 1, r: state.r, sum: state.sum }
    }
    fn score(state: State) -> State {
      State { x: state.x, r: state.r, sum: state.sum + state.x }
    }
    fn advance(state: State) -> State {
      State { x: state.x, r: state.r + 1, sum: state.sum }
    }
    fn search(state: State) -> State {
      prepare(state) \\prepared ->
        score(prepared) \\scored ->
          advance(scored) \\next ->
            match next.r == 3 {
              true => next,
              false => search(next),
            }
    }
    pub fn main() -> i32 {
      search(State { x: 0, r: 0, sum: 0 }) \\result ->
        result.x * 100 + result.sum
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const search = wat.match(/\(func \$search[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(search, "loop");
  assert(!search.includes("call $prepare"));
  assert(!search.includes("call $score"));
  assert(!search.includes("call $advance"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 306);
});

Deno.test("private let-chain product search chain fuses into same tail loop shape", async () => {
  const source = `
    type fn State() -> type {
      let State = {x: i32, r: i32, sum: i32};
      struct(State)
    }
    fn prepare(state: State) -> State {
      State { x: state.x + 1, r: state.r, sum: state.sum }
    }
    fn score(state: State) -> State {
      State { x: state.x, r: state.r, sum: state.sum + state.x }
    }
    fn advance(state: State) -> State {
      State { x: state.x, r: state.r + 1, sum: state.sum }
    }
    fn search(state: State) -> State {
      let prepared = prepare(state);
      let scored = score(prepared);
      let next = advance(scored);
      match next.r == 3 {
        true => next,
        false => search(next),
      }
    }
    pub fn main() -> i32 {
      search(State { x: 0, r: 0, sum: 0 }) \\result ->
        result.x * 100 + result.sum
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const search = wat.match(/\(func \$search[\s\S]*?\n  \)/)?.[0] ?? "";
  assertEquals((search.match(/\bloop\b/g) ?? []).length, 1);
  assert(!search.includes("call $prepare"));
  assert(!search.includes("call $score"));
  assert(!search.includes("call $advance"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 306);
});

Deno.test("effectful product transformer is not fused into private search loop", async () => {
  const source = `
    const tick: fn() -> i32 !{time} = @capability("tick");
    type fn State() -> type {
      let State = {x: i32, r: i32};
      struct(State)
    }
    fn prepare(state: State) -> State !{time} {
      State { x: state.x + tick(), r: state.r }
    }
    fn advance(state: State) -> State {
      State { x: state.x, r: state.r + 1 }
    }
    fn search(state: State) -> State !{time} {
      prepare(state) \\prepared ->
        advance(prepared) \\next ->
          match next.r == 1 {
            true => next,
            false => search(next),
          }
    }
    pub fn main() -> i32 !{time} {
      search(State { x: 0, r: 0 }) \\result -> result.x
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const search = wat.match(/\(func \$search[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(search, "call $prepare");
  assert(!search.includes("call $advance"));
});

Deno.test("fannkuch search release lowering fuses product-state step", async () => {
  const source = await Deno.readTextFile("examples/perf_fannkuch_redux.fig");
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const search = wat.match(/\(func \$search[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(search, "loop");
  assert(!search.includes("call $prepare"));
  assert(!search.includes("call $score"));
  assert(!search.includes("call $advance"));
  assert(!wat.includes("call $layout_InlineArray_set__"));
  assert(!wat.includes("call $layout_InlineArray_update__"));
  assert(!wat.includes("(func $layout_InlineArray_set__"));
  assert(!wat.includes("(func $layout_InlineArray_update__"));
  assert(!wat.includes("select"));
  assertStringIncludes(wat, "fixed_array_packed");
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(0), 22816);
});

Deno.test("packed fixed-array dynamic read lowers through shift and mask", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn read(xs: layout.InlineArray(4, u3), index: i32) -> i32 {
      xs[index]
    }
    fn bump_read(xs: layout.InlineArray(4, u3), index: i32) -> i32 {
      read(layout.InlineArray.set(4, u3, xs, index, 7), index)
    }
    pub fn main(index: i32) -> i32 {
      bump_read(<1, 2, 3, 4>, index)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const read = wat.match(/\(func \$read[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(read, "fixed_array_packed");
  assertStringIncludes(read, "i32.shr_u");
  assertStringIncludes(read, "i32.and");
  assert(!read.includes("select"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(2), 7);
});

Deno.test("packed fixed-array dynamic set updates with shifts and masks", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn set_at(xs: layout.InlineArray(4, u3), index: i32, value: u3) -> layout.InlineArray(4, u3) {
      layout.InlineArray.set(4, u3, xs, index, value)
    }
    pub fn main(index: i32) -> i32 {
      let ys = set_at(<1, 2, 3, 4>, index, 7);
      ys[0] * 1000 + ys[1] * 100 + ys[2] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const setAt = wat.match(/\(func \$set_at[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(setAt, "fixed_array_packed");
  assertStringIncludes(setAt, "i32.shl");
  assertStringIncludes(setAt, "i32.and");
  assertStringIncludes(setAt, "i32.xor");
  assert(!setAt.includes("select"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(2), 1274);
});

Deno.test("public fixed-array kernel uses optimized private representation clone", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn A() -> type {
      layout.InlineArray(7, u3)
    }
    pub fn public_kernel(xs: A, i: i32, v: u3) -> u3 {
      let ys = layout.InlineArray.set(7, u3, xs, i, v);
      ys[i]
    }
    fn private_kernel(xs: A, i: i32, v: u3) -> u3 {
      let ys = layout.InlineArray.set(7, u3, xs, i, v);
      ys[i]
    }
    pub fn main(i: i32) -> i32 {
      private_kernel(<0, 1, 2, 3, 4, 5, 6>, i, 7)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const publicWrapper = wat.match(/\(func \$public_kernel[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(publicWrapper, `call $public_kernel__optimized`);
  assertStringIncludes(wat, `(func $public_kernel__optimized`);
  assertStringIncludes(wat, "$__fixed_array_packed_xs");
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.public_kernel as CallableFunction)(0, 1, 2, 3, 4, 5, 6, 2, 7), 7);
  assertEquals((instance.exports.main as CallableFunction)(3), 7);
});

Deno.test("packed fixed-array swap stays loop-lowered without helpers", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn swap(xs: layout.InlineArray(4, u3), left: i32, right: i32) -> layout.InlineArray(4, u3) {
      let a = xs[left];
      let b = xs[right];
      layout.InlineArray.set(4, u3, xs, left, b) \\ys ->
      layout.InlineArray.set(4, u3, ys, right, a)
    }
    fn reverse_loop(xs: layout.InlineArray(4, u3), left: i32, right: i32) -> layout.InlineArray(4, u3) {
      match left < right {
        true => reverse_loop(swap(xs, left, right), left + 1, right - 1),
        false => xs,
      }
    }
    pub fn main() -> i32 {
      let ys = reverse_loop(<1, 2, 3, 4>, 0, 3);
      ys[0] * 1000 + ys[1] * 100 + ys[2] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const reverse = wat.match(/\(func \$reverse_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(reverse, "loop");
  assertStringIncludes(reverse, "fixed_array_packed");
  assert(!reverse.includes("select"));
  assert(!reverse.includes("call $swap"));
  assert(!reverse.includes("call $layout_InlineArray_set__4__u3"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 4321);
});

Deno.test("tail-recursive scalar inline-array set mutates dead slots in loop", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn rotate_left_loop(
      xs: layout.InlineArray(4, i32),
      i: i32,
      r: i32,
      first: i32
    ) -> layout.InlineArray(4, i32) {
      match i < r {
        true => rotate_left_loop(layout.InlineArray.set(4, i32, xs, i, xs[i + 1]), i + 1, r, first),
        false => layout.InlineArray.set(4, i32, xs, r, first),
      }
    }
    pub fn main() -> i32 {
      let xs: layout.InlineArray(4, i32) = <1, 2, 3, 4>;
      let ys = rotate_left_loop(xs, 0, 2, xs[0]);
      ys[0] * 1000 + ys[1] * 100 + ys[2] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const rotate = wat.match(/\(func \$rotate_left_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(rotate, "loop");
  assertStringIncludes(rotate, `i32.load (memory $fig_buffers)`);
  assertStringIncludes(rotate, `i32.store (memory $fig_buffers)`);
  assert(!rotate.includes("select"));
  assert(!rotate.includes("call $rotate_left_loop"));
  assert(!rotate.includes("call $layout_InlineArray_set__4__i32"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 2314);
});

Deno.test("tail-recursive scalar inline-array swap mutates dead slots in loop", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn swap(xs: layout.InlineArray(4, i32), left: i32, right: i32) -> layout.InlineArray(4, i32) {
      let a = xs[left];
      let b = xs[right];
      layout.InlineArray.set(4, i32, xs, left, b) \\ys ->
      layout.InlineArray.set(4, i32, ys, right, a)
    }
    fn reverse_loop(xs: layout.InlineArray(4, i32), left: i32, right: i32) -> layout.InlineArray(4, i32) {
      match left < right {
        true => reverse_loop(swap(xs, left, right), left + 1, right - 1),
        false => xs,
      }
    }
    pub fn main() -> i32 {
      let ys = reverse_loop(<1, 2, 3, 4>, 0, 3);
      ys[0] * 1000 + ys[1] * 100 + ys[2] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const reverse = wat.match(/\(func \$reverse_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(reverse, "loop");
  assertStringIncludes(reverse, `i32.load (memory $fig_buffers)`);
  assertStringIncludes(reverse, `i32.store (memory $fig_buffers)`);
  assert(!reverse.includes("select"));
  assert(!reverse.includes("call $swap"));
  assert(!reverse.includes("call $layout_InlineArray_set__4__i32"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 4321);
});

Deno.test("private product fixed-array field dynamic set uses scratch storage", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Box() -> type {
      let Box = {values: layout.InlineArray(4, i32), tag: i32};
      struct(Box)
    }
    fn bump(box: Box, index: i32) -> Box {
      Box {
        values: layout.InlineArray.set(4, i32, box.values, index, box.tag + 1),
        tag: box.tag,
      }
    }
    pub fn main(index: i32) -> i32 {
      let box = Box { values: <1, 2, 3, 4>, tag: 9 };
      let next = bump(box, index);
      next.values[1] * 10 + next.values[2] + next.tag
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const bump = wat.match(/\(func \$bump[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(bump, `i32.load (memory $fig_buffers)`);
  assertStringIncludes(bump, `i32.store (memory $fig_buffers)`);
  assert(!bump.includes("select"));
  assert(!bump.includes("call $layout_InlineArray_set__4__i32"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 112);
  assertEquals((instance.exports.main as CallableFunction)(2), 39);
});

Deno.test("scratch fixed-array update evaluates old value without helper call", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Box() -> type {
      let Box = {values: layout.InlineArray(4, i32), tag: i32};
      struct(Box)
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn bump(box: Box, index: i32) -> Box {
      Box {
        values: layout.InlineArray.update(4, i32, box.values, index, inc),
        tag: box.tag,
      }
    }
    pub fn main(index: i32) -> i32 {
      let box = Box { values: <1, 2, 3, 4>, tag: 9 };
      let next = bump(box, index);
      next.values[1] * 10 + next.values[2] + next.tag
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const bump = wat.match(/\(func \$bump[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(bump, `i32.load (memory $fig_buffers)`);
  assertStringIncludes(bump, `i32.store (memory $fig_buffers)`);
  assert(!bump.includes("select"));
  assert(!bump.includes("call $layout_InlineArray_update__4__i32__inc"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 42);
  assertEquals((instance.exports.main as CallableFunction)(2), 33);
});

Deno.test("scratch fixed-array argument forwards to private dynamic read callee", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn inc(x: i32) -> i32 { x + 1 }
    fn read(xs: layout.InlineArray(4, i32), index: i32) -> i32 {
      xs[index]
    }
    fn bump_read(xs: layout.InlineArray(4, i32), index: i32) -> i32 {
      read(layout.InlineArray.update(4, i32, xs, index, inc), index)
    }
    pub fn main(index: i32) -> i32 {
      bump_read(<1, 2, 3, 4>, index)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const read = wat.match(/\(func \$read[\s\S]*?\n  \)/)?.[0] ?? "";
  const bumpRead = wat.match(/\(func \$bump_read[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(read, `i32.load (memory $fig_buffers)`);
  assertStringIncludes(read, `i32.store (memory $fig_buffers)`);
  assert(!read.includes("select"));
  assert(!bumpRead.includes("call $layout_InlineArray_update__4__i32__inc"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 3);
  assertEquals((instance.exports.main as CallableFunction)(2), 4);
});

Deno.test("index cursor Yield item proves inline-array indexing and lowers inline", async () => {
  const source = `
    const core = @import("prelude.core");
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn sum_loop(xs: InlineArray(3, i32), cursor: core.IndexCursor(3), acc: i32) -> i32 {
      match core.IndexCursor.next(3, cursor) {
        Yield(i, next) => sum_loop(xs, next, acc + xs[i]),
        Done => acc,
      }
    }
    pub fn main() -> i32 {
      sum_loop([10, 20, 12], core.IndexCursor.start(3), 0)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const sum = wat.match(/\(func \$sum_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(sum, "loop");
  assert(!sum.includes("IndexCursor.next"));
  assert(!sum.includes("call $sum_loop"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 42);
});

Deno.test("index cursor Yield wildcard payload skips unused item local", async () => {
  const source = `
    const core = @import("prelude.core");
    fn skip_items(cursor: core.IndexCursor(3), acc: i32) -> i32 {
      match core.IndexCursor.next(3, cursor) {
        Yield(_, next) => skip_items(next, acc + 1),
        Done => acc,
      }
    }
    pub fn main() -> i32 {
      skip_items(core.IndexCursor.start(3), 0)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const skip = wat.match(/\(func \$skip_items[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!skip.includes("__iter_item"));
  assert(!skip.includes("local.set $i"));
  assertStringIncludes(skip, "$next");

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 3);
});

Deno.test("inline array builder primitives lower without runtime calls", async () => {
  const wat = await watFromSource(
    `
    type fn Index(n: count) -> type { i32 }
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn InlineArrayBuilder(n: count, a: type) -> type {
      let Builder = {n*a};
      struct(Builder)
    }
    fn InlineArrayBuilder.start(const n: count, const a: type) -> InlineArrayBuilder(n, a) {
      @inline_array_builder_start(n, a)
    }
    fn InlineArrayBuilder.push(
      const n: count,
      const a: type,
      builder: InlineArrayBuilder(n, a),
      i: Index(n),
      value: a
    ) -> InlineArrayBuilder(n, a) {
      @inline_array_builder_push(n, a, builder, i, value)
    }
    fn InlineArrayBuilder.finish(const n: count, const a: type, builder: InlineArrayBuilder(n, a)) -> InlineArray(n, a) {
      @inline_array_builder_finish(n, a, builder)
    }
    pub fn main() -> i32 {
      let b0 = InlineArrayBuilder.start(2, i32);
      let b1 = InlineArrayBuilder.push(2, i32, b0, 0, 10);
      let b2 = InlineArrayBuilder.push(2, i32, b1, 1, 20);
      let xs = InlineArrayBuilder.finish(2, i32, b2);
      xs[0] + xs[1]
    }
  `,
    { optMode: "release" },
  );

  assert(!wat.includes("InlineArrayBuilder.start"));
  assert(!wat.includes("InlineArrayBuilder.push"));
  assert(!wat.includes("InlineArrayBuilder.finish"));
  assert(!wat.includes("call $inline_array_builder"));
});

Deno.test("indexed spread fixed tuple update lowers without builder loop", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn source(seed: i32) -> InlineArray(4, i32) {
      <seed + 1, 2, 3, 4>
    }
    pub fn main(seed: i32) -> i32 {
      let xs = source(seed);
      let ys: InlineArray(4, i32) = [...xs, [1]: 32];
      xs[1] + ys[1] + ys[3]
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assert(!wat.includes("InlineArrayBuilder"));
  assert(!wat.includes("InlineArray.set_loop"));
  assert(!wat.includes("InlineArray.update_loop"));
  assert(!wat.includes("if"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 38);
});

Deno.test("public inline array update folds statically known index", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn bump(x: i32) -> i32 { x + 3 }
    pub fn main(seed: i32) -> i32 {
      let xs: layout.InlineArray(4, i32) = <1, 2, 3, 4>;
      let ys: layout.InlineArray(4, i32) = layout.InlineArray.update(4, i32, xs, seed - seed + 2, bump);
      xs[2] + ys[2] + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("InlineArray.update_loop"));
  assert(!main.includes("InlineArrayBuilder"));
  assert(!main.includes("if"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 13);
});

Deno.test("backend prunes lowered helpers unused after fixed update lowering", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn make(i: layout.core.Index(16)) -> i32 { i + 1 }
    fn bump(x: i32) -> i32 { x + 3 }
    pub fn main(seed: i32) -> i32 {
      let xs = layout.InlineArray.tabulate(16, i32, make);
      let ys = layout.InlineArray.update(16, i32, xs, seed - seed + 7, bump);
      xs[7] + ys[7] + ys[15]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });

  assertEquals((wat.match(/\(func /g) ?? []).length, 1);
  assert(!wat.includes("InlineArray.update_loop"));
  assert(!wat.includes("InlineArrayBuilder"));
  assert(!wat.includes("call $"));
});

Deno.test("dynamic scalar inline array indexing lowers through select", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    pub fn main(index: i32) -> i32 {
      let xs: InlineArray(4, i32) = <10, 20, 30, 40>;
      xs[index]
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const main = wat.match(/\(func \$main__optimized[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "select");
  assert(!main.includes("if"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(0), 10);
  assertEquals((instance.exports.main as CallableFunction)(2), 30);
  assertEquals((instance.exports.main as CallableFunction)(9), 40);
});

Deno.test("safe dynamic scalar fixed tuple update lowers through select", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    pub fn main(index: i32) -> i32 {
      let xs: InlineArray(4, i32) = <1, 2, 3, 4>;
      let ys: InlineArray(4, i32) = [...xs, [index]: 40 + 2];
      ys[1] + ys[2]
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const main = wat.match(/\(func \$main__optimized[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "select");
  assert(!main.includes("if"));
  assert(!wat.includes("InlineArrayBuilder"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 45);
  assertEquals((instance.exports.main as CallableFunction)(2), 44);
  assertEquals((instance.exports.main as CallableFunction)(9), 5);
});

Deno.test("dynamic indexed spread fixed tuple update is lazy and left-to-right", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn boom() -> i32 { 1 / 0 }
    pub fn main(index: i32) -> i32 {
      let xs: InlineArray(4, i32) = <1, 2, 3, 4>;
      let ys: InlineArray(4, i32) = [...xs, [index]: boom(), [index]: 40];
      ys[1] + ys[2]
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "if (result i32)");
  assert(!wat.includes("InlineArrayBuilder"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 43);
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
      fn Bad(n: i32) -> i32 { match n { 0 => 0, _ => 1 + Bad(n - 1) } }
      pub fn main() -> i32 { Bad(3) }
    `,
  );
});

Deno.test("opcode mode rejects direct self recursion outside tail position", async () => {
  await assertTailCallRejected(
    "call argument",
    `
    fn Id(x: i32) -> i32 { x }
    fn call_arg(n: i32) -> i32 { match n { 0 => 0, _ => Id(call_arg(n - 1)) } }
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
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Lane4I32() -> type { InlineArray(4, i32) }
    type fn Index(n: count) -> type { i32 }
    fn dynamic_index_target(n: i32, i: Index(4)) -> Lane4I32 {
      match n { 0 => [0, 0, 0, 0], _ => [dynamic_index_target(n - 1, i)[i], 0, 0, 0] }
    }
    pub fn main(i: Index(4)) -> i32 {
      dynamic_index_target(3, i)[i]
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
  const wat = await watFromSource(
    `
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box { mapped(box_functor, {value: 41}) }
  `,
    { optMode: "release" },
  );
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $map_box"));
  assert(!wat.includes("(func $mapped__box_functor"));
});

Deno.test("Lane4I32 public ABI stays scalar while pure lane add uses SIMD internally", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Lane4I32() -> type { InlineArray(4, i32) }
    pub fn main(x: Lane4I32, k: i32) -> Lane4I32 {
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
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Lane4I32() -> type { InlineArray(4, i32) }
    pub fn main(x: Lane4I32, k: i32) -> Lane4I32 {
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

Deno.test("temporal intrinsics export temporal memories and pack handles", async () => {
  const source = `
    fn temporal.handle(ptr: i32, rev: i32) -> i64 {
      @temporal_handle(ptr, rev)
    }
    fn temporal.alloc(bytes: i32) -> i64 {
      @temporal_alloc(bytes)
    }
    fn temporal.handle_ptr(handle: i64) -> i32 {
      @temporal_handle_ptr(handle)
    }
    fn temporal.handle_rev(handle: i64) -> i32 {
      @temporal_handle_rev(handle)
    }
    pub fn main() -> i32 {
      temporal.handle_ptr(temporal.handle(7, 2)) +
        temporal.handle_rev(temporal.handle(7, 2)) +
        temporal.handle_ptr(temporal.alloc(64))
    }
  `;
  const wat = await watFromSource(source, { memoryModel: "temporal" });
  assertStringIncludes(wat, `(memory $fig_objects (export "fig_objects") 1)`);
  assertStringIncludes(wat, `(memory $fig_logs (export "fig_logs") 1)`);
  assertStringIncludes(wat, `(memory $fig_buffers (export "fig_buffers") 1)`);
  assert(!wat.includes(`(memory (export "memory") 1)`));
  assertStringIncludes(wat, "i64.extend_i32_u");
  assertStringIncludes(wat, "i64.shl");
  assertStringIncludes(wat, "i64.or");

  const instance = await WebAssembly.instantiate(
    await wasmFromSource(source, { memoryModel: "temporal" }),
    {},
  );
  assertEquals((instance.instance.exports.main as CallableFunction)(), 73);
  assertEquals(
    WebAssembly.Module.exports(instance.module).filter((item) => item.kind === "memory").map((
      item,
    ) => item.name),
    ["fig_objects", "fig_logs", "fig_buffers"],
  );
});

Deno.test("branch memory mode exports branch memories and packs transitional handles", async () => {
  const source = `
    fn branch.handle(ptr: i32) -> i64 {
      @branch_handle(ptr)
    }
    fn branch.handle_ptr(handle: i64) -> i32 {
      @branch_handle_ptr(handle)
    }
    fn branch.mark(handle: i64) -> i64 {
      @branch_mark(handle)
    }
    pub fn main() -> i32 {
      branch.handle_ptr(branch.mark(branch.handle(7)))
    }
  `;
  const wat = await watFromSource(source, { memoryModel: "branch" });
  assertStringIncludes(wat, `(memory $fig_objects (export "fig_objects") 1)`);
  assert(!wat.includes(`fig_logs`));
  assertStringIncludes(wat, `(memory $fig_buffers (export "fig_buffers") 1)`);
  assertStringIncludes(wat, "i64.extend_i32_u");
  assertStringIncludes(wat, "i32.wrap_i64");

  const instance = await WebAssembly.instantiate(
    await wasmFromSource(source, { memoryModel: "branch" }),
    {},
  );
  assertEquals((instance.instance.exports.main as CallableFunction)(), 7);
  assertEquals(
    WebAssembly.Module.exports(instance.module).filter((item) => item.kind === "memory").map((
      item,
    ) => item.name),
    ["fig_objects", "fig_buffers"],
  );
});

Deno.test("branch intrinsics lower to header flags and copy-before-write", async () => {
  const source = `
    fn branch.handle(ptr: i32) -> i64 {
      @branch_handle(ptr)
    }
    fn branch.handle_ptr(handle: i64) -> i32 {
      @branch_handle_ptr(handle)
    }
    fn branch.mark(handle: i64) -> i64 {
      @branch_mark(handle)
    }
    fn branch.is_branched(handle: i64) -> bool {
      @branch_is_branched(handle)
    }
    fn branch.ensure(handle: i64) -> i64 {
      @branch_ensure_editable(handle)
    }
    pub fn mark_then_check(ptr: i32) -> bool {
      branch.is_branched(branch.mark(branch.handle(ptr)))
    }
    pub fn ensure_ptr(ptr: i32) -> i32 {
      branch.handle_ptr(branch.ensure(branch.handle(ptr)))
    }
  `;

  const wat = await watFromSource(source, { memoryModel: "branch-debug" });
  assertStringIncludes(wat, `(memory $fig_objects (export "fig_objects") 1)`);
  assert(!wat.includes("fig_logs"));
  assertStringIncludes(wat, "i32.load align=4 offset=8");
  assertStringIncludes(wat, "i32.store align=4 offset=8");
  assertStringIncludes(wat, "memory.copy");

  const instance = await WebAssembly.instantiate(
    await wasmFromSource(source, { memoryModel: "branch-debug" }),
    {},
  );
  const exports = instance.instance.exports as {
    fig_objects: WebAssembly.Memory;
    mark_then_check: CallableFunction;
    ensure_ptr: CallableFunction;
  };
  const words = new Uint32Array(exports.fig_objects.buffer);
  const ptr = 64;
  words[ptr / 4] = 11;
  words[ptr / 4 + 1] = 8;
  words[ptr / 4 + 2] = 0;
  words[ptr / 4 + 4] = 123;
  words[ptr / 4 + 5] = 456;

  assertEquals(exports.ensure_ptr(ptr), ptr);
  assertEquals(exports.mark_then_check(ptr), 1);

  const copied = exports.ensure_ptr(ptr);
  assertEquals(copied, ptr + 24);
  assertEquals(words[ptr / 4 + 2], 1);
  assertEquals(words[copied / 4], 11);
  assertEquals(words[copied / 4 + 1], 8);
  assertEquals(words[copied / 4 + 2], 0);
  assertEquals(words[copied / 4 + 4], 123);
  assertEquals(words[copied / 4 + 5], 456);
});

Deno.test("branch mode rejects temporal intrinsics", async () => {
  const source = `
    fn temporal.handle(ptr: i32, rev: i32) -> i64 {
      @temporal_handle(ptr, rev)
    }
    pub fn main() -> i64 { temporal.handle(7, 2) }
  `;
  await assertRejects(
    () => watFromSource(source, { memoryModel: "branch" }),
    Error,
    "temporal intrinsics are only available with --memory temporal",
  );
});

Deno.test("explicit temporal mode rejects branch intrinsics", async () => {
  const source = `
    fn branch.handle(ptr: i32) -> i64 {
      @branch_handle(ptr)
    }
    pub fn main() -> i64 { branch.handle(7) }
  `;
  await assertRejects(
    () => watFromSource(source, { memoryModel: "temporal" }),
    Error,
    "branch intrinsics require --memory branch or --memory branch-debug",
  );
});

Deno.test("unsupported lane patterns fall back to scalar WAT", async () => {
  const wat = await watFromSource(`
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Lane4I32() -> type { InlineArray(4, i32) }
    pub fn main(x: Lane4I32) -> Lane4I32 {
      [x[0] + 1, x[1] + 2, x[2] + 3, x[3] + 4]
    }
  `);

  assert(!wat.includes("i32x4."));
  assertStringIncludes(wat, "i32.add");
});
