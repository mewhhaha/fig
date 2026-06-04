import { assert, assertEquals } from "jsr:@std/assert@1";
import { type CompileSourceOptions, watFromSource as watFromSourceRaw } from "../src/mod.ts";
import { withOperatorPrelude } from "./operator_prelude.ts";

const watFromSource = (source: string, options: CompileSourceOptions = {}) =>
  {
    const prepared = withOperatorPrelude(source, options);
    return watFromSourceRaw(prepared.source, prepared.options);
  };

Deno.test("golden WAT for arithmetic main", async () => {
  assertEquals(
    await watFromSource(`pub fn main() -> i32 { 7 * 6 }`),
    `(module
  (func $main (export "main") (result i32)
    i32.const 7
    i32.const 6
    call $__ops_op_mul__i32
  )
  (func $__ops_op_mul__i32 (param $a i32) (param $b i32) (result i32)
    local.get $a
    local.get $b
    i32.mul
  )
)`,
  );
});

Deno.test("golden WAT for direct function calls", async () => {
  assertEquals(
    await watFromSource(
      `
      fn add1(x: i32) -> i32 { x + 1 }
      pub fn main() -> i32 { add1(41) }
    `,
      { optMode: "release" },
    ),
    `(module
  (func $main (export "main") (result i32)
    i32.const 42
  )
)`,
  );
});

Deno.test("golden WAT for multi-arm match", async () => {
  assertEquals(
    await watFromSource(
      `
      fn classify(x: i32) -> i32 {
        match x {
          0 => 0,
          1 => 10,
          _ => 20,
        }
      }
      pub fn main() -> i32 { classify(1) }
    `,
      { optMode: "release" },
    ),
    `(module
  (func $main (export "main") (result i32)
    i32.const 10
  )
)`,
  );
});

Deno.test("golden WAT for literal function match bodies", async () => {
  assertEquals(
    await watFromSource(
      `
      fn something_n(a: i32) -> i32 match {
        1 => 10,
        a => a,
      }
      pub fn main() -> i32 { something_n(2) }
    `,
      { optMode: "release" },
    ),
    `(module
  (func $main (export "main") (result i32)
    i32.const 2
  )
)`,
  );
});

Deno.test("golden WAT lowers optimized const-param calls directly", async () => {
  assertEquals(
    await watFromSource(
      `
      type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
      fn map_i32(x: i32) -> i32 { x + 1 }
      const i32_functor: Functor(i32) = {map: map_i32};
      fn mapped(const dict: Functor(i32), x: i32) -> i32 { dict.map(x) }
      pub fn main() -> i32 { mapped(i32_functor, 41) }
    `,
      { optMode: "release" },
    ),
    `(module
  (func $main (export "main") (result i32)
    i32.const 42
  )
)`,
  );
});

Deno.test("WAT specializes perf array const dictionary dispatch", async () => {
  const wat = await watFromSource(
    `
    type fn ScalarBox() { let ScalarBox = {value: i32}; struct(ScalarBox) }
    type fn Map4(t: type) { let Map4 = {apply: fn(x: t) -> t}; struct(Map4) }
    fn add1_box(x: ScalarBox) -> ScalarBox { {value: x.value + 1} }
    const scalar_map4: Map4(ScalarBox) = {apply: add1_box};
    fn apply_tile(const ops: Map4(ScalarBox), x: ScalarBox) -> ScalarBox {
      ops.apply(ops.apply(ops.apply(ops.apply(x))))
    }
    pub fn main() -> ScalarBox { apply_tile(scalar_map4, {value: 1}) }
  `,
    { optMode: "release" },
  );

  assert(!wat.includes("(func $apply_tile__scalar_map4"));
  assertEquals(wat.match(/call \$add1_box/g)?.length ?? 0, 0);
  assert(!wat.includes("(func $apply_tile "));

  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(main.includes("i32.const 5"));
  assert(!main.includes("call $apply_tile__scalar_map4"));
  assert(!main.includes("call $apply_tile\n"));
});
