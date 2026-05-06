import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { wasmFromSource, watFromSource } from "../src/mod.ts";

Deno.test("WAT and wasm share lowered import signatures", async () => {
  const source = `
    import capability clock: fn() -> i32 !{time};
    import capability random: fn(seed: i32) -> i32 !{entropy};
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
    import capability clock: fn() -> i32 !{time};
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

Deno.test("backend keeps generated forwarding wrappers inlined at call sites", async () => {
  const wat = await watFromSource(`
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    const box_functor: functor(box) = [map: map_box];
    fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
    pub fn main() -> box { mapped(box_functor, [value: 41]) }
  `);
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "call $map_box");
  assert(!wat.includes("(func $mapped__box_functor"));
});

Deno.test("lane4_i32 public ABI stays scalar while pure lane add uses SIMD internally", async () => {
  const source = `
    type fn inline_array(N: count, A: type) {
      let InlineArray = [N*A];
      struct(InlineArray)
    }
    type fn lane4_i32() -> type { inline_array(4, i32) }
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
      let InlineArray = [N*A];
      struct(InlineArray)
    }
    type fn lane4_i32() -> type { inline_array(4, i32) }
    pub fn main(x: lane4_i32, k: i32) -> lane4_i32 {
      [x[0] + k, x[1] + k, x[2] + k, x[3] + k]
    }
  `;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(1, 2, 3, 4, 10), [11, 12, 13, 14]);
});

Deno.test("unsupported lane patterns fall back to scalar WAT", async () => {
  const wat = await watFromSource(`
    type fn inline_array(N: count, A: type) {
      let InlineArray = [N*A];
      struct(InlineArray)
    }
    type fn lane4_i32() -> type { inline_array(4, i32) }
    pub fn main(x: lane4_i32) -> lane4_i32 {
      [x[0] + 1, x[1] + 2, x[2] + 3, x[3] + 4]
    }
  `);

  assert(!wat.includes("i32x4."));
  assertStringIncludes(wat, "i32.add");
});
