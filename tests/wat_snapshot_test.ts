import { assertEquals } from "jsr:@std/assert@1";
import { watFromSource } from "../src/mod.ts";

Deno.test("golden WAT for arithmetic main", async () => {
  assertEquals(
    await watFromSource(`pub fn main() -> i32 { 7 * 6 }`),
    `(module
  (func $main (export "main") (result i32)
    i32.const 7
    i32.const 6
    i32.mul
  )
)`,
  );
});

Deno.test("golden WAT for direct function calls", async () => {
  assertEquals(
    await watFromSource(`
      fn add1(x: i32) -> i32 { x + 1 }
      pub fn main() -> i32 { add1(41) }
    `),
    `(module
  (func $add1 (param $x i32) (result i32)
    local.get $x
    i32.const 1
    i32.add
  )
  (func $main (export "main") (result i32)
    i32.const 41
    call $add1
  )
)`,
  );
});

Deno.test("golden WAT for multi-arm match", async () => {
  assertEquals(
    await watFromSource(`
      fn classify(x: i32) -> i32 {
        match x {
          0 => 0,
          1 => 10,
          _ => 20,
        }
      }
      pub fn main() -> i32 { classify(1) }
    `),
    `(module
  (func $classify (param $x i32) (result i32)
    local.get $x
    i32.const 0
    i32.eq
    if (result i32)
      i32.const 0
    else
      local.get $x
      i32.const 1
      i32.eq
      if (result i32)
        i32.const 10
      else
        i32.const 20
      end
    end
  )
  (func $main (export "main") (result i32)
    i32.const 1
    call $classify
  )
)`,
  );
});

Deno.test("golden WAT for literal function clauses", async () => {
  assertEquals(
    await watFromSource(`
      fn something_n(1: i32) -> i32 { 10 }
      fn something_n(a: i32) -> i32 { a }
      pub fn main() -> i32 { something_n(2) }
    `),
    `(module
  (func $something_n (param $__pattern_734601027 i32) (result i32)
    local.get $__pattern_734601027
    i32.const 1
    i32.eq
    i32.const 1
    i32.eq
    if (result i32)
      local.get $__pattern_734601027
      call $something_n__clause_0
    else
      local.get $__pattern_734601027
      call $something_n__clause_1
    end
  )
  (func $something_n__clause_0 (param $__pattern_734601027 i32) (result i32)
    i32.const 10
  )
  (func $something_n__clause_1 (param $a i32) (result i32)
    local.get $a
  )
  (func $main (export "main") (result i32)
    i32.const 2
    call $something_n
  )
)`,
  );
});

Deno.test("golden WAT lowers optimized const-param calls directly", async () => {
  assertEquals(
    await watFromSource(`
      type fn box() { let Box = [value: i32]; struct(Box) }
      type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
      fn map_box(x: box) -> box { [value: x.value + 1] }
      const box_functor: functor(box) = [map: map_box];
      fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
      pub fn main() -> box { mapped(box_functor, [value: 41]) }
    `),
    `(module
  (func $map_box (param $x i32) (result i32)
    local.get $x
    i32.const 1
    i32.add
  )
  (func $main (export "main") (result i32)
    i32.const 41
    call $map_box
  )
  (func $mapped__box_functor (param $x i32) (result i32)
    local.get $x
    call $map_box
  )
)`,
  );
});
