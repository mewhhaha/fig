import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkSource, wasmFromSource, watFromSource } from "../src/mod.ts";

const prelude = (name: string) => Deno.readTextFile(`prelude/${name}.fig`);
const fragment = async (name: string) =>
  (await prelude(name)).split("\n").filter((line) =>
    !line.includes("@import(")
  ).join("\n");

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

Deno.test("prelude fragments compose by concatenation", async () => {
  await checkSource(`
    ${await fragment("core")}
    ${await fragment("layout")}
    ${await fragment("array_static")}

    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> lane4_i32 { map4_i32(inc, [1, 2, 3, 4]) }
  `);
});

Deno.test("module resolver loads prelude fig files", async () => {
  const source = await resolveModule("prelude.core");
  assert(source?.includes("type fn eq"));
});

Deno.test("functional prelude checks functor and monad examples", async () => {
  const source = await Deno.readTextFile("examples/prelude_functional.fig");
  await checkSource(source, { resolveModule });
});

Deno.test("static array prelude checks map zip_with and fold", async () => {
  const source = await Deno.readTextFile("examples/prelude_array_static.fig");
  const checked = await checkSource(source, { resolveModule });
  assertEquals(checked.program.sourceImports?.length ?? 0, 0);
});

Deno.test("schedule metadata composes with static array prelude", async () => {
  const source = await Deno.readTextFile("examples/prelude_perf_pipeline.fig");
  await checkSource(source, { resolveModule });
});

Deno.test("prelude std imports common data layout function and schedule fragments", async () => {
  const checked = await checkSource(
    `
    const merge = @import("prelude.std");

    fn inc(x: i32) -> i32 { x + 1 }

    pub fn main() -> i32 {
      let dims: pair(i32, i32) = Pair [first: 2, second: 4];
      let triple: tuple3(i32, i32, i32) = Tuple3 [first: 1, second: 2, third: 3];
      let lanes: lane4_i32 = map4_i32(inc, [1, 2, 3, 4]);
      let schedule_tile: tile2x4 = [rows: 2, cols: 4];
      let matrix: mat4_i32 = mat4_rows_i32(lanes, [1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]);
      dims.first + dims.second + triple.third + matrix[0][0] + schedule_tile.rows
    }
    `,
    { resolveModule },
  );

  assertEquals(checked.program.sourceImports?.length ?? 0, 0);
});

Deno.test("canvas prelude exposes shader metadata and host imports", async () => {
  const source = `
    const merge = @import("prelude.canvas");

    const shader: string = \`\`\`wgsl
@group(0) @binding(1) var<uniform> camera: mat4x4<f32>;
@vertex fn vs(@location(0) pos: vec2<f32>) -> @location(0) vec4<f32> { return vec4<f32>(); }
\`\`\`;

    type fn layout() -> type {
      shader_layout(\`\`\`wgsl
@group(0) @binding(1) var<uniform> camera: mat4x4<f32>;
@vertex fn vs(@location(0) pos: vec2<f32>) -> @location(0) vec4<f32> { return vec4<f32>(); }
\`\`\`)
    }

    pub fn main() -> i32 !{gpu} {
      gpu_create_shader(shader_id(shader))
    }
  `;
  const checked = await checkSource(source, { resolveModule });
  assertEquals(checked.shaderManifest.length, 1);
  assertEquals(checked.shaderManifest[0].bindings, [{
    group: 0,
    binding: 1,
    name: "camera",
    addressSpace: "uniform",
  }]);
  assertEquals(checked.shaderManifest[0].locations.length, 2);

  const wat = await watFromSource(source, { resolveModule });
  assert(wat.includes(`(func $gpu_create_shader (import "env" "gpu_create_shader")`));
});

Deno.test("prelude std exposes result option and static contracts", async () => {
  await checkSource(
    `
    const merge = @import("prelude.std");

    type fn box(A: type) -> type {
      let Box = [value: A];
      struct(Box)
    }

    fn box.map(v: box(A), const f: fn(x: A) -> B) -> box(B) {
      Box [value: f(v.value)]
    }

    fn box.bind(v: box(A), const f: fn(x: A) -> box(B)) -> box(B) {
      f(v.value)
    }

    fn ok(value: i32) -> result(i32, i32) { value }
    fn maybe(value: i32) -> option(i32) { value }
    fn inc(x: i32) -> i32 { x + 1 }
    fn wrap(x: i32) -> box(i32) { Box [value: x] }

    pub fn main() -> i32 {
      let result_value: result(i32, i32) = ok(1);
      let option_value: option(i32) = maybe(2);
      box.bind(box.map(Box [value: 3], inc), wrap).value
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude std supports user semigroup types with erased helper proof", async () => {
  const wat = await watFromSource(
    `
    const merge = @import("prelude.std");

    type fn point() -> type {
      let Point = [x: i32, y: i32];
      struct(Point)
    }

    fn point.append(a: point, b: point) -> point {
      Point [x: a.x + b.x, y: a.y + b.y]
    }

    pub fn main() -> i32 {
      let total = append(point, semigroup(point), Point [x: 1, y: 2], Point [x: 3, y: 4]);
      total.x + total.y
    }
    `,
    { resolveModule },
  );

  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $append"));
  assert(!main.includes("call $append__"));
  assert(main.includes("i32.add"));
});

Deno.test("prelude std accepts user monoid contracts", async () => {
  await checkSource(
    `
    const merge = @import("prelude.std");

    type fn point() -> type {
      let Point = [x: i32, y: i32];
      struct(Point)
    }

    fn point.append(a: point, b: point) -> point {
      Point [x: a.x + b.x, y: a.y + b.y]
    }

    fn point.empty() -> point {
      Point [x: 0, y: 0]
    }

    fn zero(const _proof: monoid(point)) -> i32 { 0 }
    `,
    { resolveModule },
  );
});

Deno.test("prelude std rejects incomplete monoid implementations", async () => {
  try {
    await checkSource(
      `
      const merge = @import("prelude.std");

      type fn point() -> type {
        let Point = [x: i32];
        struct(Point)
      }

      fn point.empty() -> point {
        Point [x: 0]
      }

      fn bad(const _proof: monoid(point)) -> i32 { 0 }
      `,
      { resolveModule },
    );
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("Monoid requires append"));
    return;
  }
  throw new Error("expected monoid diagnostic");
});

Deno.test("prelude std helpers support user functor applicative and monad types", async () => {
  await checkSource(
    `
    const merge = @import("prelude.std");

    type fn box(A: type) -> type {
      let Box = [value: A];
      struct(Box)
    }

    fn box.map(v: box(A), const f: fn(x: A) -> B) -> box(B) {
      Box [value: f(v.value)]
    }

    fn box.bind(v: box(A), const f: fn(x: A) -> box(B)) -> box(B) {
      f(v.value)
    }

    fn inc(x: i32) -> i32 { x + 1 }
    fn wrap(x: i32) -> box(i32) { Box [value: x + 10] }

    pub fn main() -> i32 {
      bind(fmap(Box [value: 1], inc, functor(box)), wrap, monad(box)).value
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude std accepts user applicative contracts", async () => {
  await checkSource(
    `
    const merge = @import("prelude.std");

    type fn box(A: type) -> type {
      let Box = [value: A];
      struct(Box)
    }

    fn box.map(v: box(A), const f: fn(x: A) -> B) -> box(B) {
      Box [value: f(v.value)]
    }

    fn box.pure(value: A) -> box(A) {
      Box [value: value]
    }

    fn box.apply(v: box(fn(x: A) -> B), x: box(A)) -> box(B) {
      Box [value: v.value(x.value)]
    }

    fn proof(const _proof: applicative(box)) -> i32 { 0 }
    `,
    { resolveModule },
  );
});

Deno.test("engine prelude emits 2d quad geometry as fixed vertex data", async () => {
  const wat = await watFromSource(
    `
    const merge = @import("prelude.engine");

    pub fn main() -> geometry2d_i32 {
      emit_rect2d(10, 20, 30, 40, 1, rgba8(255, 0, 0, 255))
    }
    `,
    { resolveModule },
  );

  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertEquals(main.match(/\(result i32\)/g)?.length, 25);
  assert(!main.includes("i32.store"));
});

Deno.test("source imports diagnose missing modules", async () => {
  try {
    await checkSource('const merge = @import("prelude.missing"); pub fn main() -> i32 { 1 }', {
      resolveModule,
    });
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("module.not_found"));
    return;
  }
  throw new Error("expected missing module diagnostic");
});

Deno.test("map4 const function lowers to four direct scalar calls", async () => {
  const wat = await watFromSource(
    `
    const merge = @import("prelude.array_static");
    fn inc(x: scalar_i32) -> scalar_i32 { [value: x.value + 1] }
    pub fn main() -> scalar_i32 { map4_scalar_i32(inc, [value: 1]) }
  `,
    { resolveModule },
  );

  assertEquals(wat.match(/call \$inc/g)?.length, 4);
  assert(!wat.includes("(func $map4_scalar_i32 "));
});

Deno.test("lane4_i32 lowers to four scalar Wasm results", async () => {
  const wat = await watFromSource(
    `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> lane4_i32 { map4_i32(inc, [1, 2, 3, 4]) }
  `,
    { resolveModule },
  );

  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(main.includes("(result i32) (result i32) (result i32) (result i32)"));
  assertEquals(wat.match(/call \$inc/g)?.length, 4);
});

Deno.test("zip_with4 const function lowers without a runtime operation parameter", async () => {
  const wat = await watFromSource(
    `
    const merge = @import("prelude.array_static");
    fn add(a: scalar_i32, b: scalar_i32) -> scalar_i32 { [value: a.value + b.value] }
    pub fn main() -> scalar_i32 {
      zip_with4_scalar_i32(add, [value: 1], [value: 2], [value: 3], [value: 4], [value: 5])
    }
  `,
    { resolveModule },
  );

  assertEquals(wat.match(/call \$add/g)?.length, 4);
  assert(!wat.includes("(func $zip_with4_scalar_i32 "));
});

Deno.test("fold4 and reduce4 specialize reducers", async () => {
  const wat = await watFromSource(
    `
    const merge = @import("prelude.array_static");
    fn add(a: i32, b: i32) -> i32 { a + b }
    pub fn main() -> i32 {
      fold4_i32(add, 0, [1, 2, 3, 4]) + reduce4_i32(add, [1, 2, 3, 4])
    }
  `,
    { resolveModule },
  );

  assertEquals(wat.match(/call \$add/g)?.length, 7);
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $fold4_i32\n"));
  assert(!main.includes("call $reduce4_i32\n"));
});

Deno.test("lane arithmetic patterns emit scalar arithmetic without helper calls", async () => {
  const wat = await watFromSource(
    `
    const merge = @import("prelude.std");
    pub fn main() -> i32 {
      let xs: lane4_i32 = [1, 2, 3, 4];
      let ys: lane4_i32 = [5, 6, 7, 8];
      let zs: lane4_i32 = [
        (xs[0] + ys[0]) * 1,
        (xs[1] + ys[1]) * 1,
        (xs[2] + ys[2]) * 1,
        (xs[3] + ys[3]) * 1
      ];
      zs[0] + zs[1] + zs[2] + zs[3]
    }
  `,
    { resolveModule },
  );

  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!wat.includes("(func $lane4_add_i32 "));
  assert(!wat.includes("(func $lane4_mul_i32 "));
  assert(!wat.includes("(func $lane4_dot_i32 "));
  assert(!main.includes("call $lane4_add_i32"));
  assert(!main.includes("call $lane4_mul_i32"));
  assert(!main.includes("call $lane4_dot_i32"));
  assert(main.includes("i32.add"));
  assert(main.includes("i32.mul"));
});

Deno.test("inline array iterators support explicit attached dispatch", async () => {
  const checked = await checkSource(
    `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main() -> i32 {
      iter.fold(iter.map(inline_array.iter([1, 2, 3, 4]), inc), 0, add)
    }
  `,
    { resolveModule },
  );

  const main = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name === "main"
  );
  assert(main?.kind === "fn");
  assertEquals(main.returnType, "i32");
});

Deno.test("fluent inline array iterator chains preserve receivers and fuse", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main() -> i32 {
      inline_array.iter([1, 2, 3, 4]).map(inc).reverse().fold(0, add)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });

  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $inline_array_iter"));
  assert(!main.includes("call $iter_map"));
  assert(!main.includes("call $iter_reverse"));
  assert(!main.includes("call $iter_fold"));
});

Deno.test("inline array iterator filter map fold fuses and runs", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn keep(x: i32) -> bool { x > 2 }
    pub fn main() -> i32 {
      iter.fold(iter.map(iter.filter(inline_array.iter([1, 2, 3, 4]), keep), inc), 0, add)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $inline_array_iter"));
  assert(!main.includes("call $iter_filter"));
  assert(!main.includes("call $iter_map"));
  assert(!main.includes("call $iter_fold"));
  assert(main.includes("if (result i32)"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 9);
});

Deno.test("pipe-bound fluent iterator chains resolve receivers and fuse", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn keep(x: i32) -> bool { x > 2 }
    pub fn main() -> i32 {
      inline_array.iter([1, 2, 3, 4]) \\$ -> $.filter(keep).map(inc).fold(0, add)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $inline_array_iter"));
  assert(!main.includes("call $iter_filter"));
  assert(!main.includes("call $iter_map"));
  assert(!main.includes("call $iter_fold"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 9);
});

Deno.test("inline array iterator filter collect compacts valid prefix", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn keep(x: i32) -> bool { x > 2 }
    pub fn main() -> i32 {
      let out: compact_array = iter.collect(iter.map(iter.filter(inline_array.iter([1, 2, 3, 4]), keep), inc));
      out.len + out.items[0] + out.items[1] + out.items[2]
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $iter_filter"));
  assert(!main.includes("call $iter_map"));
  assert(!main.includes("call $iter_collect"));
  assert(main.includes("if (result i32)"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 11);
});

Deno.test("runtime range fold emits loop and runs", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main() -> i32 {
      (0 .. 10).iter().fold(0, add)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  assert(wat.includes("loop"));
  assert(!wat.includes("call $range_iter_filter"));
  assert(!wat.includes("call $range_iter_map"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 45);
});

Deno.test("runtime range map and filter are unsupported for now", async () => {
  for (
    const [source, expected] of [
      [
        `fn inc(x: i32) -> i32 { x + 1 } fn add(acc: i32, x: i32) -> i32 { acc + x } pub fn main() -> i32 { (0 .. 10).iter().map(inc).fold(0, add) }`,
        "range_iter.map",
      ],
      [
        `fn keep(x: i32) -> bool { x > 2 } fn add(acc: i32, x: i32) -> i32 { acc + x } pub fn main() -> i32 { (0 .. 10).iter().filter(keep).fold(0, add) }`,
        "range_iter.filter",
      ],
    ]
  ) {
    try {
      await checkSource(`const merge = @import("prelude.array_static"); ${source}`, {
        resolveModule,
      });
    } catch (error) {
      assert(error instanceof Error);
      assert(error.message.includes(expected));
      continue;
    }
    throw new Error(`expected diagnostic containing ${expected}`);
  }
});

Deno.test("empty runtime range folds to the initial accumulator", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main() -> i32 {
      (5 .. 5).iter().fold(42, add)
    }
  `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 42);
});

Deno.test("runtime range collect and reduce require static safety proofs", async () => {
  for (
    const [source, expected] of [
      [
        `pub fn main() -> i32 { range_iter.collect((0 .. 10).iter()) }`,
        "unknown function range_iter.collect",
      ],
      [
        `fn add(acc: i32, x: i32) -> i32 { acc + x } pub fn main() -> i32 { range_iter.reduce((0 .. 10).iter(), add) }`,
        "unknown function range_iter.reduce",
      ],
    ]
  ) {
    try {
      await checkSource(`const merge = @import("prelude.array_static"); ${source}`, {
        resolveModule,
      });
    } catch (error) {
      assert(error instanceof Error);
      assert(error.message.includes(expected));
      continue;
    }
    throw new Error(`expected diagnostic containing ${expected}`);
  }
});
