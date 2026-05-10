import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkSource, CompileError, wasmFromSource, watFromSource } from "../src/mod.ts";

const prelude = (name: string) => Deno.readTextFile(`prelude/${name}.fig`);
const fragment = async (name: string) =>
  (await prelude(name)).split("\n").filter((line) => !line.includes("@import(")).join("\n");

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
    pub fn main() -> Lane4I32 { map4_i32(inc, <1, 2, 3, 4>) }
  `);
});

Deno.test("module resolver loads prelude fig files", async () => {
  const source = await resolveModule("prelude.core");
  assert(source?.includes("type fn Eq"));
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
    const array = @import("prelude.array_static");

    fn inc(x: i32) -> i32 { x + 1 }

    pub fn main() -> i32 {
      let dims: Pair(i32, i32) = Pair {first: 2, second: 4};
      let triple: Tuple3(i32, i32, i32) = Tuple3 {first: 1, second: 2, third: 3};
      let lanes: Lane4I32 = map4_i32(inc, <1, 2, 3, 4>);
      let schedule_tile: Tile2x4 = {rows: 2, cols: 4};
      let matrix: Mat4I32 = mat4_rows_i32(lanes, <1, 2, 3, 4>, <5, 6, 7, 8>, <9, 10, 11, 12>);
      dims.first + dims.second + Triple.third + matrix[0][0] + schedule_tile.rows
    }
    `,
    { resolveModule },
  );

  assertEquals(checked.program.sourceImports?.length ?? 0, 0);
});

Deno.test("prelude std exposes pure fixed collection helpers", async () => {
  const source = `
    const array = @import("prelude.array_static");

    fn inc(x: i32) -> i32 { x + 1 }
    fn add(a: i32, b: i32) -> i32 { a + b }
    fn sum(acc: i32, x: i32) -> i32 { acc + x }
    fn keep(x: i32) -> bool { x > 2 }

    pub fn main() -> i32 {
      let xs: array.layout.Lane4I32 = <1, 2, 3, 4>;
      let for_map, for_zip, for_fold, for_reduce, for_capacity, for_bounds, for_get, for_iter = fork(xs);
      let mapped = array.map4_i32(inc, for_map);
      let zipped = array.zip_with4_i32(add, mapped, for_zip);
      let folded = array.fold4_i32(sum, 0, for_fold);
      let reduced = array.reduce4_i32(add, for_reduce);
      let get_value: i32 = array.get(for_get, 2);
      let collected: array.CompactArray(4, i32) = array.Iter.collect(array.Iter.map(array.Iter.filter(array.layout.InlineArray.Iter(for_iter), keep), inc));
      let range_sum = array.RangeIter.fold(array.RangeI32.Iter(0 .. 4), 0, sum);
      let bounds_value = match array.in_bounds(for_bounds, 3) { true => 1, false => 0 };

      folded + reduced + zipped[0] + array.capacity(for_capacity) + range_sum + collected.len +
        bounds_value + get_value
    }
  `;

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 39);
});

Deno.test("InlineArray.fold_indices uses index cursor loop", async () => {
  const source = `
    const layout = @import("prelude.layout");

    fn add_index(acc: i32, i: layout.core.Index(4)) -> i32 {
      acc + i
    }

    pub fn main() -> i32 {
      layout.InlineArray.fold_indices(4, i32, layout.core.IndexCursor.start(4), 0, add_index)
    }
  `;

  const wat = await watFromSource(source, { resolveModule });
  assert(wat.includes("loop"));
  assert(!wat.includes("call $layout.core.IndexCursor.next"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 6);
});

Deno.test("inline_array public helpers use builder cursor loops", async () => {
  const source = `
    const layout = @import("prelude.layout");

    fn make(i: layout.core.Index(4)) -> i32 { i + 1 }
    fn make_with(i: layout.core.Index(4), offset: i32) -> i32 { i + offset }
    fn inc(x: i32) -> i32 { x + 1 }
    fn add_index(i: layout.core.Index(4), x: i32) -> i32 { x + i }
    fn add_state(i: layout.core.Index(4), x: i32, offset: i32) -> i32 { x + i + offset }

    pub fn main() -> i32 {
      let built = layout.InlineArray.tabulate(4, i32, make);
      let with_state = layout.InlineArray.tabulate_with(4, i32, i32, 10, make_with);
      let indexed = layout.InlineArray.imap(4, i32, i32, with_state, add_index);
      let state_mapped = layout.InlineArray.imap_with_state(4, i32, i32, i32, indexed, 20, add_state);
      let filled = layout.InlineArray.fill(4, i32, 7);
      let mapped = layout.InlineArray.map(4, i32, i32, built, inc);
      let set = layout.InlineArray.set(4, i32, mapped, 2, 99);
      let updated = layout.InlineArray.update(4, i32, set, 0, inc);
      updated[0] + updated[1] + updated[2] + updated[3] + state_mapped[0] + state_mapped[3] + filled[1]
    }
  `;

  const wat = await watFromSource(source, { resolveModule });
  assert(wat.includes("loop"));
  for (
    const forbidden of [
      "call $layout.core.IndexCursor.next",
      "InlineArrayBuilder.start",
      "InlineArrayBuilder.push",
      "InlineArrayBuilder.finish",
      "call $layout.inline_array_map",
      "call $layout.inline_array_imap",
      "call $layout.inline_array_imap_with_state",
      "call $layout.inline_array_fill",
      "call $layout.inline_array_set",
      "call $layout.inline_array_update",
    ]
  ) {
    assert(!wat.includes(forbidden), forbidden);
  }

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 186);
});

Deno.test("inline_array builder preserves flattened product elements", async () => {
  const source = `
    const layout = @import("prelude.layout");

    type fn PairI32() -> type {
      let PairI32 = {x: i32, y: i32};
      struct(PairI32)
    }

    fn make(i: layout.core.Index(2)) -> PairI32 {
      {x: i + 10, y: i + 20}
    }

    pub fn main() -> i32 {
      let xs = layout.InlineArray.tabulate(2, PairI32, make);
      xs[0].x + xs[0].y + xs[1].x + xs[1].y
    }
  `;

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 62);
});

Deno.test("prelude std exposes common operators for custom types", async () => {
  const checked = await checkSource(
    `
    const merge = @import("prelude.std");

    type fn Point() -> struct {
      let Point = {x: i32};
      struct(Point)
    }

    fn Point.add(a: Point, b: Point) -> Point { Point {x: a.x + b.x} }
    fn Point.eql(a: Point, b: Point) -> bool { a.x == b.x }
    fn Point.lt(a: Point, b: Point) -> bool { a.x < b.x }
    fn Point.append(a: Point, b: Point) -> Point { Point {x: a.x + b.x} }

    pub fn add_points(a: Point, b: Point) -> Point { a + b }
    pub fn points_equal(a: Point, b: Point) -> bool { a == b }
    pub fn point_before(a: Point, b: Point) -> bool { a < b }
    pub fn append_points(a: Point, b: Point) -> Point { a <> b }
    `,
    { resolveModule },
  );

  const callees = checked.program.declarations
    .filter((decl) => decl.kind === "fn" && decl.public)
    .map((decl) =>
      decl.kind === "fn" && decl.body.expr?.kind === "call" &&
        decl.body.expr.callee.kind === "var"
        ? decl.body.expr.callee.name
        : ""
    );
  assertEquals(callees, ["Point.add", "Point.eql", "Point.lt", "Point.append"]);
});

Deno.test("prelude std exposes bool infix operators", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
        const merge = @import("prelude.std");

        pub fn main() -> i32 {
          let both = true && false;
          let either = true || false;
          let one = true ^^ false;
          let same = true == true;
          let different = true != false;
          match both {
            true => 0,
            false => match either {
              true => match one {
                true => match same {
                  true => match different { true => 1, false => 0 },
                  false => 0,
                },
                false => 0,
              },
              false => 0,
            },
          }
        }
        `,
        { resolveModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 1);
});

Deno.test("prelude std exposes applicative apply operator", async () => {
  const checked = await checkSource(
    `
    const merge = @import("prelude.std");

    type fn Box() -> type {
      let Box = {value: i32};
      struct(Box)
    }

    fn Box.apply(v: Box, x: Box) -> Box {
      Box {value: v.value + x.value}
    }

    pub fn main(f: Box, x: Box) -> Box {
      f <*> x
    }
    `,
    { resolveModule },
  );

  const main = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name === "main"
  );
  if (!main || main.kind !== "fn") throw new Error("missing main");
  assertEquals(main.body.expr?.kind, "call");
  if (main.body.expr?.kind === "call" && main.body.expr.callee.kind === "var") {
    assertEquals(main.body.expr.callee.name, "Box.apply");
  }
});

Deno.test("prelude std exposes functor map and monad bind operators", async () => {
  const checked = await checkSource(
    `
    const merge = @import("prelude.std");

    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }

    fn Box.map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }

    fn Box.bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {
      f(v.value)
    }

    fn inc(x: i32) -> i32 { x + 1 }
    fn wrap(x: i32) -> Box(i32) { Box {value: x + 10} }

    pub fn mapped() -> Box(i32) { inc <$> Box {value: 1} }
    pub fn bound() -> Box(i32) { Box {value: 1} >>= wrap }
    `,
    { resolveModule },
  );

  const calls = checked.program.declarations
    .filter((decl) => decl.kind === "fn" && decl.body.expr?.kind === "call")
    .map((decl) => {
      if (
        decl.kind !== "fn" || decl.body.expr?.kind !== "call" ||
        decl.body.expr.callee.kind !== "var"
      ) return undefined;
      return {
        callee: decl.body.expr.callee.name,
        args: decl.body.expr.args.map((arg) => arg.kind),
      };
    });
  assert(calls.some((call) => call?.callee === "Box.map" && call.args.join(",") === "var,shape"));
  assert(calls.some((call) => call?.callee === "Box.bind" && call.args.join(",") === "shape,var"));
});

Deno.test("prelude std rejects functional operators without matching members", async () => {
  await assertThrowsCompile(
    `
    const merge = @import("prelude.std");
    type fn Point() -> type {
      let Point = {x: i32};
      struct(Point)
    }
    fn inc(x: Point) -> Point { x }
    pub fn main(a: Point) -> Point { inc <$> a }
    `,
    "operator.missing",
    { resolveModule },
  );
});

Deno.test("prelude std keeps heap collection APIs out of the pure surface", async () => {
  const std = await Deno.readTextFile("prelude/std.fig");
  const array = await Deno.readTextFile("prelude/array_static.fig");
  const purePrelude = `${std}\n${array}`;

  for (const name of ["list", "vector", "vec", "pop", "reserve", "append"]) {
    assert(
      !new RegExp(`\\b(fn|type fn)\\s+(?:[a-z_]+\\.)?${name}\\b`).test(purePrelude),
      `unexpected dynamic collection helper ${name}`,
    );
  }
});

Deno.test("prelude option helpers construct map bind and unwrap", async () => {
  await checkSource(
    `
    const option = @import("prelude.option");

    fn inc(x: i32) -> i32 { x + 1 }
    fn next(x: i32) -> Option.core.Option(i32) { Option.some(x + 1) }
    fn fallback() -> Option.core.Option(i32) { Option.some(9) }

    pub fn main() -> i32 {
      let mapped = Option.option_map(Option.some(1), inc);
      let bound = Option.option_and_then(mapped, next);
      Option.option_unwrap_or(bound, 0) + Option.option_unwrap_or(Option.option_or_else(Option.none(), fallback), 0)
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude result helpers construct map bind and unwrap", async () => {
  await checkSource(
    `
    const result = @import("prelude.result");

    fn inc(x: i32) -> i32 { x + 1 }
    fn err_inc(x: i32) -> i32 { x + 10 }
    fn next(x: i32) -> result.core.Result(i32, i32) { result.ok(x + 1) }

    pub fn main() -> i32 {
      let mapped = result.result_map(result.ok(1), inc);
      let mapped_err = result.result_map_err(mapped, err_inc);
      result.result_unwrap_or(result.result_and_then(mapped_err, next), 0)
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude tuple helpers extract swap and map", async () => {
  await checkSource(
    `
    const tuple = @import("prelude.tuple");

    fn inc(x: i32) -> i32 { x + 1 }

    pub fn main() -> i32 {
      let swapped = tuple.pair_swap(Pair {first: 1, second: 2});
      let mapped = tuple.pair_map(Pair {first: 3, second: 4}, inc, inc);
      let triple: tuple.core.Tuple3(i32, i32, i32) = Tuple3 {first: 5, second: 6, third: 7};
      swapped.first + tuple.pair_first(mapped) + tuple.tuple3_third(triple)
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude bool order num and function helpers check", async () => {
  await checkSource(
    `
    const bools = @import("prelude.bool");
    const fun = @import("prelude.function");
    const num = @import("prelude.num");
    const order = @import("prelude.order");

    fn inc(x: i32) -> i32 { x + 1 }
    fn add(a: i32, b: i32) -> i32 { a + b }

    pub fn main() -> i32 {
      let clamped = order.clamp_i32(num.abs_i32(0 - 3), 0, 2);
      let predicate_value, pipe_value = fork(clamped);
      bools.select(order.between_i32(predicate_value, 1, 3), fun.pipe(pipe_value, inc), 0) + fun.flip(add, 4, 5)
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude fig modules are pure", async () => {
  for await (const entry of Deno.readDir("prelude")) {
    if (!entry.isFile || !entry.name.endsWith(".fig")) {
      continue;
    }
    const source = await Deno.readTextFile(`prelude/${entry.name}`);
    assert(!source.includes("@capability("), `${entry.name} declares a capability`);
  }

  const std = await Deno.readTextFile("prelude/std.fig");
  assert(!std.includes('@import("web.'), "prelude.std imports a web module");
});

Deno.test("web canvas package exposes shader metadata and host imports", async () => {
  const source = `
    const canvas = @import("web.canvas");

    const shader: string = \`\`\`wgsl
@group(0) @binding(1) var<uniform> camera: mat4x4<f32>;
@vertex fn vs(@location(0) pos: vec2<f32>) -> @location(0) vec4<f32> { return vec4<f32>(); }
\`\`\`;

    type fn Layout() -> type {
      canvas.ShaderLayout(\`\`\`wgsl
@group(0) @binding(1) var<uniform> camera: mat4x4<f32>;
@vertex fn vs(@location(0) pos: vec2<f32>) -> @location(0) vec4<f32> { return vec4<f32>(); }
\`\`\`)
    }

    pub fn main() -> i32 !{gpu} {
      canvas.gpu_create_shader(canvas.shader_id(shader))
    }
  `;
  const checked = await checkSource(source, { resolveModule });
  assertEquals(checked.shaderManifest.length, 1);
  assertEquals(checked.shaderManifest[0]?.bindings, [
    { group: 0, binding: 1, name: "camera", addressSpace: "uniform" },
  ]);

  const wat = await watFromSource(source, { resolveModule });
  assert(wat.includes(`(func $gpu_create_shader (import "env" "gpu_create_shader")`));
});

Deno.test("prelude std exposes result option and static contracts", async () => {
  await checkSource(
    `
    const merge = @import("prelude.std");

    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }

    fn Box.map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }

    fn Box.bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {
      f(v.value)
    }

    fn ok(value: i32) -> Result(i32, i32) { value }
    fn Maybe(value: i32) -> Option(i32) { value }
    fn inc(x: i32) -> i32 { x + 1 }
    fn wrap(x: i32) -> Box(i32) { Box {value: x} }

    pub fn main() -> i32 {
      let result_value: Result(i32, i32) = ok(1);
      let option_value: Option(i32) = Maybe(2);
      Box.bind(Box.map(inc, Box {value: 3}), wrap).value
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude std supports user semigroup types with erased helper proof", async () => {
  const wat = await watFromSource(
    `
    const merge = @import("prelude.std");

    type fn Point() -> type {
      let Point = {x: i32, y: i32};
      struct(Point)
    }

    fn Point.append(a: Point, b: Point) -> Point {
      Point {x: a.x + b.x, y: a.y + b.y}
    }

    pub fn main() -> i32 {
      let total = append(point, Semigroup(point), Point {x: 1, y: 2}, Point {x: 3, y: 4});
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

    type fn Point() -> type {
      let Point = {x: i32, y: i32};
      struct(Point)
    }

    fn Point.append(a: Point, b: Point) -> Point {
      Point {x: a.x + b.x, y: a.y + b.y}
    }

    fn Point.empty() -> Point {
      Point {x: 0, y: 0}
    }

    fn zero(const _proof: Monoid(point)) -> i32 { 0 }
    `,
    { resolveModule },
  );
});

Deno.test("prelude std rejects incomplete monoid implementations", async () => {
  try {
    await checkSource(
      `
      ${await fragment("core")}

      type fn Point() -> type {
        let Point = {x: i32};
        struct(Point)
      }

      fn Point.empty() -> Point {
        Point {x: 0}
      }

      fn Bad(const _proof: Monoid(Point)) -> i32 { 0 }
      pub fn main() -> i32 { Bad(Monoid(Point)) }
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

    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }

    fn Box.map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }

    fn Box.bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {
      f(v.value)
    }

    fn inc(x: i32) -> i32 { x + 1 }
    fn wrap(x: i32) -> Box(i32) { Box {value: x + 10} }

    pub fn main() -> i32 {
      bind(fmap(Box {value: 1}, inc, Functor(box)), wrap, Monad(box)).value
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude std accepts user applicative contracts", async () => {
  await checkSource(
    `
    const merge = @import("prelude.std");

    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }

    fn Box.map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }

    fn Box.pure(value: a) -> Box(a) {
      Box {value: value}
    }

    fn Box.apply(v: Box(fn(x: a) -> b), x: Box(a)) -> Box(b) {
      Box {value: v.value(x.value)}
    }

    fn proof(const _proof: Applicative(box)) -> i32 { 0 }
    `,
    { resolveModule },
  );
});

Deno.test("geometry2d prelude emits 2d quad geometry as fixed vertex data", async () => {
  const geometry = (await fragment("geometry2d")).replaceAll("layout.", "");
  const wat = await watFromSource(
    `
    ${await fragment("core")}
    ${await fragment("layout")}
    ${geometry}

    pub fn main() -> Geometry2dI32 {
      emit_rect2d(10, 20, 30, 40, 1, rgba8(255, 0, 0, 255))
    }
    `,
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
    const array = @import("prelude.array_static");
    fn inc(x: array.layout.core.ScalarI32) -> array.layout.core.ScalarI32 { {value: x.value + 1} }
    pub fn main() -> array.layout.core.ScalarI32 { array.map4_scalar_i32(inc, {value: 1}) }
  `,
    { resolveModule },
  );

  assertEquals(wat.match(/call \$inc/g)?.length, 4);
  assert(!wat.includes("(func $map4_scalar_i32 "));
});

Deno.test("Lane4I32 lowers to four scalar Wasm results", async () => {
  const wat = await watFromSource(
    `
    const array = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> array.layout.Lane4I32 { array.map4_i32(inc, <1, 2, 3, 4>) }
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
    const array = @import("prelude.array_static");
    fn add(a: array.layout.core.ScalarI32, b: array.layout.core.ScalarI32) -> array.layout.core.ScalarI32 { {value: a.value + b.value} }
    pub fn main() -> array.layout.core.ScalarI32 {
      array.zip_with4_scalar_i32(add, {value: 1}, {value: 2}, {value: 3}, {value: 4}, {value: 5})
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
    const array = @import("prelude.array_static");
    fn add(a: i32, b: i32) -> i32 { a + b }
    pub fn main() -> i32 {
      array.fold4_i32(add, 0, <1, 2, 3, 4>) + array.reduce4_i32(add, <1, 2, 3, 4>)
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
      let xs: Lane4I32 = <1, 2, 3, 4>;
      let ys: Lane4I32 = <5, 6, 7, 8>;
      let zs: Lane4I32 = [
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

Deno.test("Lane4I32 helper surface checks queries reductions transforms and shapes", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn even(x: i32) -> bool { x % 2 == 0 }
    fn positive(x: i32) -> bool { x > 0 }
    pub fn main() -> i32 {
      let xs: Lane4I32 = <1, 2, 3, 4>;
      let a, b, c, d, e, f, g, h, i, j, k, l, m = fork(xs);
      let set = lane4_set_i32(a, 1, 9);
      let updated = lane4_update_i32(b, 2, inc);
      let replaced = lane4_replace_where_i32(c, even, 0);
      let taken = lane4_take_i32(d, 2);
      let dropped = lane4_drop_i32(e, 2);
      let reversed = lane4_reverse_i32(f);
      let left = lane4_rotate_left_i32(g);
      let right = lane4_rotate_right_i32(h);
      let found = match lane4_index_of_i32(i, 3) { Some(value) => value, None => 99 };
      let missing = match lane4_index_of_i32(j, 7) { Some(value) => value, None => 5 };
      let invalid = lane4_set_i32(k, 9, 99);
      let predicates = match lane4_any_i32(l, even) {
        true => match lane4_all_i32(m, positive) { true => lane4_count_i32(<1, 2, 3, 4>, even), false => 0 },
        false => 0,
      };
      lane4_length_i32(<1, 2, 3, 4>) +
        lane4_sum_i32(<1, 2, 3, 4>) +
        lane4_product_i32(<1, 2, 3, 4>) +
        lane4_min_i32(<7, 2, 9, 4>) +
        lane4_max_i32(<7, 2, 9, 4>) +
        set[1] + updated[2] + replaced[1] + taken[1] + dropped[0] +
        reversed[0] + left[3] + right[0] + found + missing + invalid[1] +
        predicates
    }
  `;
  await checkSource(source, { resolveModule });
});

Deno.test("compact_array helpers check len guards and fixed capacity", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn even(x: i32) -> bool { x % 2 == 0 }
    pub fn main() -> i32 {
      let empty: CompactArray(4, i32) = CompactArray {items: <9, 9, 9, 9>, len: 0};
      let part: CompactArray(4, i32) = CompactArray {items: <2, 4, 8, 16>, len: 2};
      let full: CompactArray(4, i32) = CompactArray {items: <1, 2, 3, 4>, len: 4};
      let mapped = CompactArray.map(4, i32, i32, part, inc);
      let mapped_in, mapped_out = fork(mapped);
      let full_capacity, full_fold, full_count = fork(full);
      let in_bounds = match CompactArray.get(4, i32, mapped_in, 1) { Some(value) => value, None => 0 };
      let out_bounds = match CompactArray.get(4, i32, mapped_out, 2) { Some(value) => value, None => 7 };
      let empty_value = match CompactArray.is_empty(4, i32, empty) { true => 3, false => 0 };
      CompactArray.capacity(4, i32, full_capacity) + CompactArray.fold(4, i32, i32, full_fold, 0, add) +
        CompactArray.count(4, i32, full_count, even) + in_bounds + out_bounds + empty_value
    }
  `;
  await checkSource(source, { resolveModule });
});

Deno.test("generic compact_array supports bounded literals and push overflow", async () => {
  const source = `
    const array = @import("prelude.array_static");

    pub fn main() -> i32 {
      let xs: array.CompactArray(5, i32) = <1, 2, 3>;
      let pushed = array.CompactArray.push(5, i32, xs, 4);
      let full: array.CompactArray(2, bool) = <true, false>;
      let full_for_push, full_for_check = fork(full);
      let overflowed = array.CompactArray.push(2, bool, full_for_push, true);
      let full_value = match array.CompactArray.is_full(2, bool, full_for_check) {
        true => 1,
        false => 0,
      };
      let overflow_value = array.CompactArray.len(2, bool, overflowed) * 10;
      let pushed_for_get, pushed_for_len = fork(pushed);
      let item: i32 = array.CompactArray.get(5, i32, pushed_for_get, 3);
      item + array.CompactArray.len(5, i32, pushed_for_len) + overflow_value + full_value
    }
  `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 29);
});

Deno.test("compact_array collection literals reject items past capacity", async () => {
  await assertThrowsCompile(
    `
    const array = @import("prelude.array_static");
    pub fn Bad() -> array.CompactArray(2, i32) {
      <1, 2, 3>
    }
    `,
    "collection.capacity",
    { resolveModule },
  );
});

Deno.test("iterator convenience helpers check and fuse", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn keep(x: i32) -> bool { x > 2 }
    fn small(x: i32) -> bool { x < 5 }
    pub fn main() -> i32 {
      let xs = InlineArray.Iter(<1, 2, 3, 4>).filter(keep).map(inc);
      let for_any, for_all, for_count, for_sum = fork(xs);
      let any_value = match for_any.any(small) { true => 1, false => 0 };
      let all_value = match for_all.all(small) { true => 2, false => 0 };
      any_value + all_value + for_count.count() + for_sum.sum()
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $iter_any"));
  assert(!main.includes("call $iter_all"));
  assert(!main.includes("call $iter_count"));
  assert(!main.includes("call $iter_sum"));
});

Deno.test("inline array iterators support explicit attached dispatch", async () => {
  const checked = await checkSource(
    `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main() -> i32 {
      Iter.fold(Iter.map(InlineArray.Iter(<1, 2, 3, 4>), inc), 0, add)
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
      InlineArray.Iter(<1, 2, 3, 4>).map(inc).reverse().fold(0, add)
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
    const array = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn keep(x: i32) -> bool { x > 2 }
    pub fn main() -> i32 {
      array.Iter.fold(array.Iter.map(array.Iter.filter(array.layout.InlineArray.Iter(<1, 2, 3, 4>), keep), inc), 0, add)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $array.Iter.filter"));
  assert(!main.includes("call $array.Iter.map"));
  assert(!main.includes("call $array.Iter.fold"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 9);
});

Deno.test("pipe-bound fluent iterator chains resolve receivers and fuse", async () => {
  const source = `
    const array = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn keep(x: i32) -> bool { x > 2 }
    pub fn main() -> i32 {
      array.layout.InlineArray.Iter(<1, 2, 3, 4>) \\$ -> array.Iter.fold(array.Iter.map(array.Iter.filter($, keep), inc), 0, add)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $array.Iter.filter"));
  assert(!main.includes("call $array.Iter.map"));
  assert(!main.includes("call $array.Iter.fold"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 9);
});

Deno.test("inline array iterator filter collect compacts valid prefix", async () => {
  const source = `
    const array = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn keep(x: i32) -> bool { x > 2 }
    pub fn main() -> i32 {
      let out: array.CompactArray(4, i32) = array.Iter.collect(array.Iter.map(array.Iter.filter(array.layout.InlineArray.Iter(<1, 2, 3, 4>), keep), inc));
      out.len + out.items[0] + out.items[1] + out.items[2]
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $array.Iter.filter"));
  assert(!main.includes("call $array.Iter.map"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 11);
});

Deno.test("runtime range fold emits loop and runs", async () => {
  const source = `
    const array = @import("prelude.array_static");
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main() -> i32 {
      array.RangeIter.fold(array.RangeI32.Iter(0 .. 10), 0, add)
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

Deno.test("runtime range map and filter remain inert for now", async () => {
  for (
    const source of [
      `fn inc(x: i32) -> i32 { x + 1 } fn add(acc: i32, x: i32) -> i32 { acc + x } pub fn main() -> i32 { (0 .. 10).Iter().map(inc).fold(0, add) }`,
      `fn keep(x: i32) -> bool { x > 2 } fn add(acc: i32, x: i32) -> i32 { acc + x } pub fn main() -> i32 { (0 .. 10).Iter().filter(keep).fold(0, add) }`,
    ]
  ) {
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(
        await wasmFromSource(`const merge = @import("prelude.array_static"); ${source}`, {
          resolveModule,
        }),
      ),
    );
    assertEquals((instance.exports.main as CallableFunction)(), 0);
  }
});

Deno.test("empty runtime range folds to the initial accumulator", async () => {
  const source = `
    const array = @import("prelude.array_static");
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main() -> i32 {
      array.RangeIter.fold(array.RangeI32.Iter(5 .. 5), 42, add)
    }
  `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { resolveModule }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 42);
});

Deno.test("runtime range count sum and product check empty and non-empty ranges", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    pub fn main() -> i32 {
      (0 .. 5).Iter().count() + (0 .. 5).Iter().sum() + (1 .. 5).Iter().product() +
        (5 .. 5).Iter().count() + (5 .. 5).Iter().sum() + (5 .. 5).Iter().product()
    }
  `;
  await checkSource(source, { resolveModule });
});

Deno.test("runtime range collect and reduce require static safety proofs", async () => {
  for (
    const [source, expected] of [
      [
        `pub fn main() -> i32 { RangeIter.collect((0 .. 10).Iter()) }`,
        "unknown function RangeIter.collect",
      ],
      [
        `fn add(acc: i32, x: i32) -> i32 { acc + x } pub fn main() -> i32 { RangeIter.reduce((0 .. 10).Iter(), add) }`,
        "unknown function RangeIter.reduce",
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

async function assertThrowsCompile(
  source: string,
  code: string,
  options?: Parameters<typeof checkSource>[1],
) {
  try {
    await checkSource(source, options);
  } catch (error) {
    if (error instanceof CompileError) {
      assert(
        error.diagnostics.some((diagnostic) => diagnostic.code === code),
        JSON.stringify(error.diagnostics),
      );
      return;
    }
    throw error;
  }
  throw new Error(`expected ${code}`);
}
