import { assert, assertEquals } from "jsr:@std/assert@1";
import { watFromSource } from "../src/mod.ts";

Deno.test("golden WAT for arithmetic main", async () => {
  assertEquals(
    await watFromSource(`pub fn main() -> i32 { 7 * 6 }`),
    `(module
  (func $main (export "main") (result i32)
    i32.const 42
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
    (local $__inl_add1_x i32)
    i32.const 41
    local.tee $__inl_add1_x
    i32.const 1
    i32.add
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
    (local $__inl_classify_x i32)
    i32.const 1
    local.tee $__inl_classify_x
    i32.const 0
    i32.eq
    if (result i32)
      i32.const 0
    else
      local.get $__inl_classify_x
      i32.const 1
      i32.eq
      if (result i32)
        i32.const 10
      else
        i32.const 20
      end
    end
  )
)`,
  );
});

Deno.test("golden WAT for literal function clauses", async () => {
  assertEquals(
    await watFromSource(
      `
      fn something_n(1: i32) -> i32 { 10 }
      fn something_n(a: i32) -> i32 { a }
      pub fn main() -> i32 { something_n(2) }
    `,
      { optMode: "release" },
    ),
    `(module
  (func $main (export "main") (result i32)
    (local $__inl_something_n___pattern_734601027 i32)
    i32.const 2
    local.tee $__inl_something_n___pattern_734601027
    i32.const 1
    i32.eq
    if (result i32)
      i32.const 10
    else
      local.get $__inl_something_n___pattern_734601027
    end
  )
)`,
  );
});

Deno.test("golden WAT lowers optimized const-param calls directly", async () => {
  assertEquals(
    await watFromSource(
      `
      type fn Box() { let Box = {value: i32}; struct(Box) }
      type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
      fn map_box(x: Box) -> Box { {value: x.value + 1} }
      const box_functor: Functor(Box) = {map: map_box};
      fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
      pub fn main() -> Box { mapped(box_functor, {value: 41}) }
    `,
      { optMode: "release" },
    ),
    `(module
  (func $main (export "main") (result i32)
    (local $__inl_map_box_x$value i32)
    i32.const 41
    local.tee $__inl_map_box_x$value
    i32.const 1
    i32.add
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

  assert(wat.includes("(func $apply_tile__scalar_map4 (param $x$value i32) (result i32)"));
  assertEquals(wat.match(/call \$add1_box/g)?.length ?? 0, 0);
  assert(!wat.includes("(func $apply_tile "));

  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(main.includes("call $apply_tile__scalar_map4"));
  assert(!main.includes("call $apply_tile\n"));
});
