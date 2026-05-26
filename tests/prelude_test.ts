import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
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

Deno.test("prelude array module checks through resolver imports", async () => {
  await checkSource(
    `
    const array = @import("prelude.array_static");
    const layout = @import("prelude.layout");

    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> layout.Lane4I32 { array.map4_i32(inc, #[1, 2, 3, 4]) }
  `,
    { resolveModule },
  );
});

Deno.test("module resolver loads prelude fig files", async () => {
  const source = await resolveModule("prelude.core");
  assert(source?.includes("type fn Eq"));
});

Deno.test("functional prelude checks functor and monad examples", async () => {
  const source = await Deno.readTextFile("examples/prelude_functional.fig");
  await checkSource(source, { resolveModule });
});

Deno.test("monad prelude exposes typed State pure bind and do sequencing", async () => {
  const source = `
    const monads = @import("prelude.monad");
    const core = @import("prelude.core");

    type fn World() -> type {
      let World = {tick: i32};
      struct(World)
    }

    fn add_two_value(x: i32) -> i32 {
      x + 2
    }

    fn add_two() -> monads.State(i32, core.Unit) {
      do @monad(monads.State(i32, _)) {
        monads.State::modify(add_two_value)
      }
    }

    fn step_value(world: World) -> World {
      World {...world, tick: world.tick + 1}
    }

    fn step() -> monads.State(World, core.Unit) {
      do @monad(monads.State(World, _)) {
        monads.State::modify(step_value)
      }
    }

    fn update_player_value(world: World) -> World {
      World {...world, tick: world.tick + 10}
    }

    fn update_player() -> monads.State(World, core.Unit) {
      do @monad(monads.State(World, _)) {
        monads.State::modify(update_player_value)
      }
    }

    fn run_world() -> monads.State(World, World) {
      do @monad(monads.State(World, _)) {
        step();
        update_player();
        monads.State::get()
      }
    }

    fn do_value() -> monads.State(i32, i32) {
      do @monad(monads.State(i32, _)) {
        add_two();
        x <- monads.State::get();
        monads.State::pure(x + 6)
      }
    }

    fn bind_continue(x: i32) -> monads.State(i32, i32) {
      do @monad(monads.State(i32, _)) {
        monads.State::put(x + 1);
        monads.State::get()
      }
    }

    fn bind_value() -> monads.State(i32, i32) {
      monads.State::bind(monads.State::get(), bind_continue)
    }

    pub fn main() -> i32 {
      let value = monads.State::eval(do_value(), 3);
      let direct = monads.State::eval(bind_value(), 3);
      let world = monads.State::eval(run_world(), World {tick: 1});
      value + direct + world.tick
    }
  `;

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 27);
});

Deno.test("monad prelude exposes Reader run helpers", async () => {
  const source = `
    const monads = @import("prelude.monad");

    fn triple(x: i32) -> i32 {
      x * 3
    }

    fn plus_five(x: i32) -> monads.Reader(i32, i32) {
      do @monad(monads.Reader(i32, _)) {
        monads.Reader::pure(x + 5)
      }
    }

    fn do_reader() -> monads.Reader(i32, i32) {
      do @monad(monads.Reader(i32, _)) {
        x <- monads.Reader::ask();
        y <- monads.Reader::asks(triple);
        pure(x + y)
      }
    }

    pub fn main() -> i32 {
      let bound = monads.Reader::run(plus_five(7), 3);
      bound + monads.Reader::run(do_reader(), 4)
    }
  `;

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 28);
});

Deno.test("effect prelude exposes typed reader/state Eff do", async () => {
  const source = `
    const effect = @import("prelude.effect");

    type fn Env() -> type { i32 }
    type fn Store() -> type { i32 }

    fn program() -> effect.Eff({state: Store, reader: Env}, i32) {
      do @monad(effect.Eff({state: Store, reader: Env}, _)) {
        env <- effect.ask();
        store <- effect.get();
        effect.put(store + env);
        effect.Eff::pure(store)
      }
    }

    fn bind_continue(store: Store) -> effect.Eff({state: Store, reader: Env}, i32) {
      do @monad(effect.Eff({state: Store, reader: Env}, _)) {
        env <- effect.ask();
        effect.put(store + env);
        effect.Eff::pure(store)
      }
    }

    fn direct_bind() -> effect.Eff({state: Store, reader: Env}, i32) {
      effect.Eff::bind(effect.get(), bind_continue)
    }

    pub fn main() -> i32 {
      let result = effect.run_reader(effect.run_state(program(), 4), 10);
      let direct = effect.run_reader(effect.run_state(direct_bind(), 4), 10);
      result.value + result.state + direct.value + direct.state
    }
  `;

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 36);
});

Deno.test("effect prelude reports missing effect proofs", async () => {
  await assertThrowsCompile(
    `
      const effect = @import("prelude.effect");
      fn bad(const _proof: effect.Member(#reader, {state: i32})) -> i32 { 0 }
    `,
    "type.require",
    { resolveModule },
  );
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
      let lanes: Lane4I32 = map4_i32(inc, #[1, 2, 3, 4]);
      let schedule_tile: Tile2x4 = {rows: 2, cols: 4};
      let matrix: Mat4I32 = mat4_rows_i32(lanes, #[1, 2, 3, 4], #[5, 6, 7, 8], #[9, 10, 11, 12]);
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
    const layout = @import("prelude.layout");

    fn inc(x: i32) -> i32 { x + 1 }
    fn add(a: i32, b: i32) -> i32 { a + b }
    fn sum(acc: i32, x: i32) -> i32 { acc + x }
    fn keep(x: i32) -> bool { x > 2 }

    pub fn main() -> i32 {
      let xs: layout.Lane4I32 = #[1, 2, 3, 4];
      let mapped = array.map4_i32(inc, xs);
      let zipped = array.zip_with4_i32(add, mapped, xs);
      let folded = array.fold4_i32(sum, 0, xs);
      let reduced = array.reduce4_i32(add, xs);
      let get_value: i32 = array.get(xs, 2);
      let collected: array.CompactArray(4, i32) = array.Iter::collect(array.Iter::map(array.Iter::filter(layout.InlineArray::Iter(xs), keep), inc));
      let range_sum = array.RangeIter::fold(array.RangeI32::Iter(0 .. 4), 0, sum);
      let bounds_value = match array.in_bounds(xs, 3) { true => 1, false => 0 };

      folded + reduced + zipped[0] + array.capacity(xs) + range_sum + collected.len +
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

Deno.test("InlineArray::fold_indices uses index cursor loop", async () => {
  const source = `
    const layout = @import("prelude.layout");
    const core = @import("prelude.core");

    fn add_index(acc: i32, i: core.Index(4)) -> i32 {
      acc + i
    }

    pub fn main() -> i32 {
      layout.InlineArray::fold_indices(4, i32, core.IndexCursor::start(4), 0, add_index)
    }
  `;

  const wat = await watFromSource(source, { resolveModule });
  assert(wat.includes("loop"));
  assert(!wat.includes("call $core.IndexCursor__next"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 6);
});

Deno.test("inline_array public helpers compose without runtime helper calls", async () => {
  const source = `
    const layout = @import("prelude.layout");
    const core = @import("prelude.core");

    fn make(i: core.Index(4)) -> i32 { i + 1 }
    fn make_with(i: core.Index(4), offset: i32) -> i32 { i + offset }
    fn inc(x: i32) -> i32 { x + 1 }
    fn add_index(i: core.Index(4), x: i32) -> i32 { x + i }
    fn add_state(i: core.Index(4), x: i32, offset: i32) -> i32 { x + i + offset }

    pub fn main() -> i32 {
      let built = layout.InlineArray::tabulate(4, i32, make);
      let with_state = layout.InlineArray::tabulate_with(4, i32, i32, 10, make_with);
      let indexed = layout.InlineArray::imap(4, i32, i32, with_state, add_index);
      let state_mapped = layout.InlineArray::imap_with_state(4, i32, i32, i32, indexed, 20, add_state);
      let filled = layout.InlineArray::fill(4, i32, 7);
      let mapped = layout.InlineArray::map(4, i32, i32, built, inc);
      let set = layout.InlineArray::set(4, i32, mapped, 2, 99);
      let updated = layout.InlineArray::update(4, i32, set, 0, inc);
      updated[0] + updated[1] + updated[2] + updated[3] + state_mapped[0] + state_mapped[3] + filled[1]
    }
  `;

  const wat = await watFromSource(source, { resolveModule });
  for (
    const forbidden of [
      "call $core.IndexCursor::next",
      "InlineArrayBuilder::start",
      "InlineArrayBuilder::push",
      "InlineArrayBuilder::finish",
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

Deno.test("inline_array tabulate and map lower to compact direct slots", async () => {
  const source = `
    const layout = @import("prelude.layout");
    const core = @import("prelude.core");

    fn make(i: core.Index(16)) -> i32 { i + 1 }
    fn inc(x: i32) -> i32 { x + 1 }

    pub fn main() -> i32 {
      let xs = layout.InlineArray::tabulate(16, i32, make);
      let ys = layout.InlineArray::map(16, i32, i32, xs, inc);
      ys[0] + ys[15]
    }
  `;

  const wat = await watFromSource(source, { resolveModule });
  assert(wat.length < 20_000, `unexpected WAT size ${wat.length}`);
  assertEquals(wat.match(/\bif\b/g)?.length ?? 0, 0);
  assertEquals(wat.match(/i32\.eq/g)?.length ?? 0, 0);
  assert(!wat.includes("InlineArrayBuilder::push"));
  assert(!wat.includes("InlineArray::tabulate_loop"));
  assert(!wat.includes("InlineArray::map_loop"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 19);
});

Deno.test("inline_array builder preserves flattened product elements", async () => {
  const source = `
    const layout = @import("prelude.layout");
    const core = @import("prelude.core");

    type fn PairI32() -> type {
      let PairI32 = {x: i32, y: i32};
      struct(PairI32)
    }

    fn make(i: core.Index(2)) -> PairI32 {
      {x: i + 10, y: i + 20}
    }

    pub fn main() -> i32 {
      let xs = layout.InlineArray::tabulate(2, PairI32, make);
      xs[0].x + xs[0].y + xs[1].x + xs[1].y
    }
  `;

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 62);
});

Deno.test("inline_array direct helper lowering preserves flattened product elements", async () => {
  const source = `
    const layout = @import("prelude.layout");
    const core = @import("prelude.core");

    type fn PairI32() -> type {
      let PairI32 = {x: i32, y: i32};
      struct(PairI32)
    }

    fn make(i: core.Index(4)) -> PairI32 {
      {x: i + 10, y: i + 20}
    }
    fn move(pair: PairI32) -> PairI32 {
      {x: pair.x + 1, y: pair.y + 2}
    }

    pub fn main() -> i32 {
      let xs = layout.InlineArray::tabulate(4, PairI32, make);
      let ys = layout.InlineArray::map(4, PairI32, PairI32, xs, move);
      ys[0].x + ys[0].y + ys[3].x + ys[3].y
    }
  `;

  const wat = await watFromSource(source, { resolveModule });
  assert(wat.length < 20_000, `unexpected WAT size ${wat.length}`);
  assert(!wat.includes("InlineArrayBuilder::push"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 72);
});

Deno.test("fixed prelude exposes canonical spread update and builder fallback", async () => {
  const source = `
    const fixed = @import("prelude.fixed");
    const build = @import("prelude.fixed_build");

    fn inc(x: u3) -> u3 { x + 1 }
    fn helper_set(xs: fixed.Array(4, u3), index: i32, value: u3) -> fixed.Array(4, u3) {
      fixed.Array::set(4, u3, xs, index, value)
    }
    fn user_set(xs: fixed.Array(4, u3), index: i32, value: u3) -> fixed.Array(4, u3) {
      [...xs, [index]: value]
    }
    fn helper_update(xs: fixed.Array(4, u3), index: i32) -> fixed.Array(4, u3) {
      fixed.Array::update(4, u3, xs, index, inc)
    }

    pub fn main(index: i32) -> i32 {
      let b0 = build.ArrayBuilder::start(4, u3);
      let b1 = build.ArrayBuilder::push(4, u3, b0, 0, 1);
      let b2 = build.ArrayBuilder::push(4, u3, b1, 1, 2);
      let b3 = build.ArrayBuilder::push(4, u3, b2, 2, 3);
      let b4 = build.ArrayBuilder::push(4, u3, b3, 3, 4);
      let xs: fixed.Array(4, u3) = build.ArrayBuilder::finish(4, u3, b4);
      let helper = helper_set(xs, index, 7);
      let user = user_set(xs, index, 7);
      let updated = helper_update(xs, index);
      helper[index] + user[index] + updated[index]
    }
  `;

  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  assert(!wat.includes("fig_buffers"));
  assert(!wat.includes("call $fixed_Array_set"));
  assert(!wat.includes("call $fixed_Array_update"));
  assert(!wat.includes("call $inline_array_builder"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(2), 18);
});

Deno.test("range prelude fold matches user self-tail-recursive loop shape", async () => {
  const source = `
    const range = @import("prelude.range");

    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn user_fold_loop(i: i32, end: i32, acc: i32) -> i32 {
      match i < end {
        true => user_fold_loop(i + 1, end, acc + i),
        false => acc,
      }
    }

    pub fn main() -> i32 {
      let prelude_sum = range.RangeIter::fold(range.RangeI32::Iter(0 .. 10), 0, add);
      let user_sum = user_fold_loop(0, 10, 0);
      prelude_sum * 100 + user_sum
    }
  `;

  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const preludeFold = wat.match(/\(func \$range_RangeIter__fold_loop__add[\s\S]*?\n  \)/)?.[0] ??
    "";
  const userFold = wat.match(/\(func \$user_fold_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(wat, "loop");
  if (preludeFold) assertStringIncludes(preludeFold, "loop");
  assert(!wat.includes("call $range_RangeIter__fold_loop__add"));
  assert(!userFold.includes("call $user_fold_loop"));
  assert(!preludeFold.includes("call $range_RangeIter__fold_loop__add"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 4545);
});

Deno.test("prelude std exposes common operators for custom types", async () => {
  const checked = await checkSource(
    `
    const merge = @import("prelude.std");

    type fn Point() -> struct {
      let Point = {x: i32};
      struct(Point)
    }

    fn Point::add(a: Point, b: Point) -> Point { Point {x: a.x + b.x} }
    fn Point::eql(a: Point, b: Point) -> bool { a.x == b.x }
    fn Point::lt(a: Point, b: Point) -> bool { a.x < b.x }
    fn Point::append(a: Point, b: Point) -> Point { Point {x: a.x + b.x} }

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
  assertEquals(callees, [
    "operators.op_add",
    "operators.op_eql",
    "operators.op_lt",
    "operators.op_append",
  ]);
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

    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }

    fn Box::apply(v: Box(fn(x: a) -> b), x: Box(a)) -> Box(b) {
      Box {value: v.value(x.value)}
    }

    pub fn main(f: Box(fn(x: i32) -> i32), x: Box(i32)) -> Box(i32) {
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
    assertEquals(main.body.expr.callee.name, "operators.op_apply");
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

    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }

    fn Box::pure(value: a) -> Box(a) {
      Box {value}
    }

    fn Box::apply(v: Box(fn(x: a) -> b), x: Box(a)) -> Box(b) {
      Box {value: v.value(x.value)}
    }

    fn Box::bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {
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
  assert(
    calls.some((call) =>
      call?.callee === "operators.op_map" && call.args.join(",") === "var,shape"
    ),
  );
  assert(
    calls.some((call) =>
      call?.callee === "operators.op_bind" && call.args.join(",") === "shape,var"
    ),
  );
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

Deno.test("prelude monad inherits applicative requirements", async () => {
  await checkSource(
    `
    const merge = @import("prelude.std");

    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }

    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) { Box {value: f(v.value)} }
    fn Box::pure(value: a) -> Box(a) { Box {value} }
    fn Box::apply(v: Box(fn(x: a) -> b), x: Box(a)) -> Box(b) { Box {value: v.value(x.value)} }
    fn Box::bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) { f(v.value) }

    pub fn main() -> i32 {
      const proof = @satisfies(Box, Monad);
      1
    }
    `,
    { resolveModule },
  );

  await assertThrowsCompile(
    `
    const merge = @import("prelude.std");

    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }

    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) { Box {value: f(v.value)} }
    fn Box::pure(value: a) -> Box(a) { Box {value} }
    fn Box::bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) { f(v.value) }

    pub fn main() -> i32 {
      const proof = @satisfies(Box, Monad);
      1
    }
    `,
    "type.require",
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

Deno.test("prelude option concept methods construct map bind append and unwrap", async () => {
  await checkSource(
    `
    const option = @import("prelude.option");
    const core = @import("prelude.core");

    fn inc(x: i32) -> i32 { x + 1 }
    fn bump_to_option(x: i32) -> core.Option(i32) { option.some(x + 1) }
    fn fallback() -> core.Option(i32) { option.some(9) }

    pub fn main() -> i32 {
      let empty: core.Option(i32) = option.none();
      let mapped = core.Option::map(inc, option.some(1));
      let bound = core.Option::bind(mapped, bump_to_option);
      let picked = core.Option::append(empty, bound);
      core.Option::unwrap_or(picked, 0) + core.Option::unwrap_or(core.Option::or_else(empty, fallback), 0)
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude result methods construct map bind and unwrap", async () => {
  await checkSource(
    `
    const result = @import("prelude.result");
    const core = @import("prelude.core");

    fn inc(x: i32) -> i32 { x + 1 }
    fn err_inc(x: i32) -> i32 { x + 10 }
    fn next(x: i32) -> core.Result(i32, i32) { result.ok(x + 1) }

    pub fn main() -> i32 {
      let mapped = core.Result::map(inc, result.ok(1));
      let mapped_err = core.Result::map_err(err_inc, mapped);
      core.Result::unwrap_or(core.Result::bind(mapped_err, next), 0)
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude tuple methods extract swap and map", async () => {
  await checkSource(
    `
    const tuple = @import("prelude.tuple");
    const core = @import("prelude.core");

    fn inc(x: i32) -> i32 { x + 1 }

    pub fn main() -> i32 {
      let swapped = core.Pair::swap(Pair {first: 1, second: 2});
      let mapped = core.Pair::bimap(inc, inc, Pair {first: 3, second: 4});
      let triple: core.Tuple3(i32, i32, i32) = Tuple3 {first: 5, second: 6, third: 7};
      swapped.first + core.Pair::first(mapped) + core.Tuple3::third(triple)
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude optic helpers view set over and optional focuses", async () => {
  const wasm = await wasmFromSource(
    `
    const optic = @import("prelude.optic");
    const option = @import("prelude.option");
    const core = @import("prelude.core");

    fn id_value(root: i32) -> i32 { root }
    fn replace_value(root: i32, value: i32) -> i32 { value }
    fn inc(value: i32) -> i32 { value + 1 }
    fn positive(root: i32) -> core.Option(i32) {
      match root > 0 { true => option.some(root), false => option.none() }
    }
    type fn Point() -> type { let Point = {x: i32, y: i32}; struct(Point) }
    fn point_x(root: Point) -> i32 { root.x }
    fn set_point_x(root: Point, value: i32) -> Point { Point {... root, x: value} }

    pub fn main() -> i32 {
      optic.view(optic.over(1, id_value, replace_value, inc), id_value) +
        optic.view_or(0, 7, positive) +
        optic.view(
          optic.over(Point {x: 4, y: 5}, point_x, set_point_x, inc),
          point_x
        )
    }
    `,
    { resolveModule },
  );
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm));
  assertEquals((instance.exports.main as () => number)(), 14);
});

Deno.test("prelude scalar and function helpers check", async () => {
  await checkSource(
    `
    const fun = @import("prelude.function");
    const scalar = @import("prelude.scalar");

    fn inc(x: i32) -> i32 { x + 1 }
    fn add(a: i32, b: i32) -> i32 { a + b }

    pub fn main() -> i32 {
      let clamped = scalar.clamp(i32, scalar.Number(i32), scalar.abs(i32, scalar.Number(i32), 0 - 3), 0, 2);
      scalar.select(scalar.between(i32, scalar.Number(i32), clamped, 1, 3), fun.pipe(clamped, inc), 0) + fun.flip(add, 4, 5)
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude scalar exposes generic numeric helpers", async () => {
  const source = `
    const scalar = @import("prelude.scalar");

    fn require_number(const t: type, const _proof: scalar.Number(t)) -> i32 { 0 }

    pub fn main(x: i32, y: u3) -> i32 {
      let signed = scalar.signum(i32, scalar.Number(i32), x) +
        scalar.abs(i32, scalar.Number(i32), x);
      let bounded = scalar.clamp(i32, scalar.Number(i32), signed, 0, 9);
      let unsigned = scalar.signum(u3, scalar.Number(u3), y) +
        scalar.square(u3, scalar.Number(u3), y);
      let proof = require_number(u17, scalar.Number(u17));
      let in_range = scalar.between(i32, scalar.Number(i32), bounded, 0, 9);
      scalar.select(in_range, bounded + unsigned + proof, 0)
    }
  `;

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(0 - 3, 2), 7);
  assertEquals((instance.exports.main as CallableFunction)(4, 0), 5);
});

Deno.test("type_is_number covers primitive and arbitrary-width numeric types", async () => {
  await checkSource(
    `
    const scalar = @import("prelude.scalar");

    type fn ExpectNumber(t: type) -> type {
      @require(@type_is_number(t), "number");
      t
    }

    type fn ExpectNotNumber(t: type) -> type {
      @require(@type_is_number(t) == false, "not number");
      t
    }

    fn ok_i32(const _proof: ExpectNumber(i32)) -> i32 { 0 }
    fn ok_u3(const _proof: ExpectNumber(u3)) -> i32 { 0 }
    fn ok_f64(const _proof: ExpectNumber(f64)) -> i32 { 0 }
    fn ok_bool(const _proof: ExpectNotNumber(bool)) -> i32 { 0 }

    pub fn main() -> i32 {
      ok_i32(ExpectNumber(i32)) + ok_u3(ExpectNumber(u3)) +
        ok_f64(ExpectNumber(f64)) + ok_bool(ExpectNotNumber(bool))
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
    assert(!source.includes("@effect("), `${entry.name} declares an unsupported effect import`);
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

    pub fn main(host: io) -> i32 {
      canvas.gpu_create_shader(host, canvas.shader_id(shader))
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

    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }

    fn Box::bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {
      f(v.value)
    }

    fn ok(value: i32) -> Result(i32, i32) { value }
    fn Maybe(value: i32) -> Option(i32) { value }
    fn inc(x: i32) -> i32 { x + 1 }
    fn wrap(x: i32) -> Box(i32) { Box {value: x} }

    pub fn main() -> i32 {
      let result_value: Result(i32, i32) = ok(1);
      let option_value: Option(i32) = Maybe(2);
      Box::bind(Box::map(inc, Box {value: 3}), wrap).value
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude std supports user semigroup types with erased helper proof", async () => {
  const wasm = await wasmFromSource(
    `
    const core = @import("prelude.core");

    type fn Point() -> type {
      let Point = {x: i32, y: i32};
      struct(Point)
    }

    fn Point::append(a: Point, b: Point) -> Point {
      Point {x: a.x + b.x, y: a.y + b.y}
    }

    pub fn main(seed: i32) -> i32 {
      let total = core.append(
        Point,
        core.Semigroup(Point),
        Point {x: seed, y: 2},
        Point {x: 3, y: 4}
      );
      total.x + total.y
    }
    `,
    { resolveModule, optMode: "release" },
  );
  const wat = await watFromSource(
    `
    const core = @import("prelude.core");

    type fn Point() -> type {
      let Point = {x: i32, y: i32};
      struct(Point)
    }

    fn Point::append(a: Point, b: Point) -> Point {
      Point {x: a.x + b.x, y: a.y + b.y}
    }

    pub fn main(seed: i32) -> i32 {
      let total = core.append(
        Point,
        core.Semigroup(Point),
        Point {x: seed, y: 2},
        Point {x: 3, y: 4}
      );
      total.x + total.y
    }
    `,
    { resolveModule, optMode: "release" },
  );

  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $append"));
  assert(!main.includes("call $append__"));
  assert(main.includes("i32.add"));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm));
  assertEquals((instance.exports.main as CallableFunction)(1), 10);
});

Deno.test("prelude std accepts user monoid contracts", async () => {
  await checkSource(
    `
    const merge = @import("prelude.std");

    type fn Point() -> type {
      let Point = {x: i32, y: i32};
      struct(Point)
    }

    fn Point::append(a: Point, b: Point) -> Point {
      Point {x: a.x + b.x, y: a.y + b.y}
    }

    fn Point::empty() -> Point {
      Point {x: 0, y: 0}
    }

    fn zero(const _proof: Monoid(Point)) -> i32 { 0 }
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

      fn Point::empty() -> Point {
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

    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }

    fn Box::bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {
      f(v.value)
    }

    fn inc(x: i32) -> i32 { x + 1 }
    fn wrap(x: i32) -> Box(i32) { Box {value: x + 10} }

    pub fn main() -> i32 {
      bind(fmap(Box {value: 1}, inc, Functor(Box)), wrap, Monad(Box)).value
    }
    `,
    { resolveModule },
  );
});

Deno.test("prelude std exposes option as functor applicative monad and semigroup", async () => {
  await checkSource(
    `
    const merge = @import("prelude.std");

    fn inc(x: i32) -> i32 { x + 1 }
    fn inc_to_option(x: i32) -> Option(i32) { some(x + 10) }

    fn proof(
      const _functor: Functor(Option),
      const _applicative: Applicative(Option),
      const _monad: Monad(Option),
      const _semigroup: Semigroup(Option(i32)),
      const _monoid: Monoid(Option(i32))
    ) -> i32 {
      0
    }

    pub fn main() -> i32 {
      let mapped = fmap(some(1), inc, Functor(Option));
      let applied = apply(some(inc), mapped, Applicative(Option));
      let bound = bind(applied, inc_to_option, Monad(Option));
      let picked = append(Option(i32), Semigroup(Option(i32)), none(), bound);
      proof(Functor(Option), Applicative(Option), Monad(Option), Semigroup(Option(i32)), Monoid(Option(i32))) +
        Option::unwrap_or(picked, 0)
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

    fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }

    fn Box::pure(value: a) -> Box(a) {
      Box {value: value}
    }

    fn Box::apply(v: Box(fn(x: a) -> b), x: Box(a)) -> Box(b) {
      Box {value: v.value(x.value)}
    }

    fn proof(const _proof: Applicative(Box)) -> i32 { 0 }
    `,
    { resolveModule },
  );
});

Deno.test("geometry2d prelude emits 2d quad geometry as fixed vertex data", async () => {
  const wat = await watFromSource(
    `
    const geometry = @import("prelude.geometry2d");

    pub fn main() -> geometry.Geometry2dI32 {
      geometry.emit_rect2d(10, 20, 30, 40, 1, geometry.rgba8(255, 0, 0, 255))
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
    const array = @import("prelude.array_static");
    const core = @import("prelude.core");
    fn inc(x: core.ScalarI32) -> core.ScalarI32 { {value: x.value + 1} }
    pub fn main() -> core.ScalarI32 { array.map4_scalar_i32(inc, {value: 1}) }
  `,
    { resolveModule },
  );

  assert((wat.match(/call \$inc/g)?.length ?? 0) <= 4);
  assert(!wat.includes("(func $map4_scalar_i32 "));
});

Deno.test("Lane4I32 lowers to four scalar Wasm results", async () => {
  const wat = await watFromSource(
    `
    const array = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    const layout = @import("prelude.layout");
    pub fn main() -> layout.Lane4I32 { array.map4_i32(inc, #[1, 2, 3, 4]) }
  `,
    { resolveModule, optMode: "release" },
  );

  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(main.includes("(result i32) (result i32) (result i32) (result i32)"));
  assertEquals(wat.match(/call \$inc/g)?.length ?? 0, 0);
});

Deno.test("zip_with4 const function lowers without a runtime operation parameter", async () => {
  const wat = await watFromSource(
    `
    const array = @import("prelude.array_static");
    const core = @import("prelude.core");
    fn add(a: core.ScalarI32, b: core.ScalarI32) -> core.ScalarI32 { {value: a.value + b.value} }
    pub fn main() -> core.ScalarI32 {
      array.zip_with4_scalar_i32(add, {value: 1}, {value: 2}, {value: 3}, {value: 4}, {value: 5})
    }
  `,
    { resolveModule },
  );

  assert((wat.match(/call \$add/g)?.length ?? 0) <= 4);
  assert(!wat.includes("(func $zip_with4_scalar_i32 "));
});

Deno.test("fold4 and reduce4 specialize reducers", async () => {
  const wat = await watFromSource(
    `
    const array = @import("prelude.array_static");
    fn add(a: i32, b: i32) -> i32 { a + b }
    pub fn main() -> i32 {
      array.fold4_i32(add, 0, #[1, 2, 3, 4]) + array.reduce4_i32(add, #[1, 2, 3, 4])
    }
  `,
    { resolveModule, optMode: "release" },
  );

  assertEquals(wat.match(/call \$add/g)?.length ?? 0, 0);
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $fold4_i32\n"));
  assert(!main.includes("call $reduce4_i32\n"));
});

Deno.test("lane arithmetic patterns emit scalar arithmetic without helper calls", async () => {
  const wat = await watFromSource(
    `
    const merge = @import("prelude.std");
    const layout = @import("prelude.layout");
    pub fn main(seed: i32) -> i32 {
      let xs: layout.Lane4I32 = #[seed, 2, 3, 4];
      let ys: layout.Lane4I32 = #[5, 6, 7, 8];
      let zs: layout.Lane4I32 = [
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
  const wasm = await wasmFromSource(
    `
    const merge = @import("prelude.std");
    const layout = @import("prelude.layout");
    pub fn main(seed: i32) -> i32 {
      let xs: layout.Lane4I32 = #[seed, 2, 3, 4];
      let ys: layout.Lane4I32 = #[5, 6, 7, 8];
      let zs: layout.Lane4I32 = [
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
  assert(!main.includes("i32.mul"));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm));
  assertEquals((instance.exports.main as CallableFunction)(1), 36);
});

Deno.test("Lane4I32 helper surface checks queries reductions transforms and shapes", async () => {
  const source = `
    const merge = @import("prelude.array_static");
    fn inc(x: i32) -> i32 { x + 1 }
    fn even(x: i32) -> bool { x % 2 == 0 }
    fn positive(x: i32) -> bool { x > 0 }
    pub fn main() -> i32 {
      let xs: Lane4I32 = #[1, 2, 3, 4];
      let set = lane4_set_i32(xs, 1, 9);
      let updated = lane4_update_i32(xs, 2, inc);
      let replaced = lane4_replace_where_i32(xs, even, 0);
      let taken = lane4_take_i32(xs, 2);
      let dropped = lane4_drop_i32(xs, 2);
      let reversed = lane4_reverse_i32(xs);
      let left = lane4_rotate_left_i32(xs);
      let right = lane4_rotate_right_i32(xs);
      let found = match lane4_index_of_i32(xs, 3) { Some(value) => value, None => 99 };
      let missing = match lane4_index_of_i32(xs, 7) { Some(value) => value, None => 5 };
      let invalid = lane4_set_i32(xs, 9, 99);
      let predicates = match lane4_any_i32(xs, even) {
        true => match lane4_all_i32(xs, positive) { true => lane4_count_i32(#[1, 2, 3, 4], even), false => 0 },
        false => 0,
      };
      lane4_length_i32(#[1, 2, 3, 4]) +
        lane4_sum_i32(#[1, 2, 3, 4]) +
        lane4_product_i32(#[1, 2, 3, 4]) +
        lane4_min_i32(#[7, 2, 9, 4]) +
        lane4_max_i32(#[7, 2, 9, 4]) +
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
      let empty: CompactArray(4, i32) = CompactArray {items: #[9, 9, 9, 9], len: 0};
      let part: CompactArray(4, i32) = CompactArray {items: #[2, 4, 8, 16], len: 2};
      let full: CompactArray(4, i32) = CompactArray {items: #[1, 2, 3, 4], len: 4};
      let mapped = CompactArray::map(4, i32, i32, part, inc);
      let in_bounds = match CompactArray::get(4, i32, mapped, 1) { Some(value) => value, None => 0 };
      let out_bounds = match CompactArray::get(4, i32, mapped, 2) { Some(value) => value, None => 7 };
      let empty_value = match CompactArray::is_empty(4, i32, empty) { true => 3, false => 0 };
      CompactArray::capacity(4, i32, full) + CompactArray::fold(4, i32, i32, full, 0, add) +
        CompactArray::count(4, i32, full, even) + in_bounds + out_bounds + empty_value
    }
  `;
  await checkSource(source, { resolveModule });
});

Deno.test("generic compact_array supports bounded literals and push overflow", async () => {
  const source = `
    const array = @import("prelude.array_static");

    pub fn main() -> i32 {
      let xs: array.CompactArray(5, i32) = #[1, 2, 3];
      let pushed = array.CompactArray::push(5, i32, xs, 4);
      let full: array.CompactArray(2, bool) = #[true, false];
      let overflowed = array.CompactArray::push(2, bool, full, true);
      let full_value = match array.CompactArray::is_full(2, bool, full) {
        true => 1,
        false => 0,
      };
      let overflow_value = array.CompactArray::len(2, bool, overflowed) * 10;
      let item: i32 = array.CompactArray::get(5, i32, pushed, 3);
      item + array.CompactArray::len(5, i32, pushed) + overflow_value + full_value
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
      #[1, 2, 3]
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
      let xs = InlineArray::Iter(#[1, 2, 3, 4]).filter(keep).map(inc);
      let any_value = match xs.any(small) { true => 1, false => 0 };
      let all_value = match xs.all(small) { true => 2, false => 0 };
      any_value + all_value + xs.count() + xs.sum()
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
      Iter::fold(Iter::map(InlineArray::Iter(#[1, 2, 3, 4]), inc), 0, add)
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
      InlineArray::Iter(#[1, 2, 3, 4]).map(inc).reverse().fold(0, add)
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
    const layout = @import("prelude.layout");
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn keep(x: i32) -> bool { x > 2 }
    pub fn main() -> i32 {
      array.Iter::fold(array.Iter::map(array.Iter::filter(layout.InlineArray::Iter(#[1, 2, 3, 4]), keep), inc), 0, add)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $array.Iter::filter"));
  assert(!main.includes("call $array.Iter::map"));
  assert(!main.includes("call $array.Iter::fold"));

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
    const layout = @import("prelude.layout");
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    fn keep(x: i32) -> bool { x > 2 }
    pub fn main() -> i32 {
      layout.InlineArray::Iter(#[1, 2, 3, 4]) \\iter -> array.Iter::fold(array.Iter::map(array.Iter::filter(iter, keep), inc), 0, add)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $array.Iter::filter"));
  assert(!main.includes("call $array.Iter::map"));
  assert(!main.includes("call $array.Iter::fold"));

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
    const layout = @import("prelude.layout");
    fn inc(x: i32) -> i32 { x + 1 }
    fn keep(x: i32) -> bool { x > 2 }
    pub fn main() -> i32 {
      let out: array.CompactArray(4, i32) = array.Iter::collect(array.Iter::map(array.Iter::filter(layout.InlineArray::Iter(#[1, 2, 3, 4]), keep), inc));
      out.len + out.items[0] + out.items[1] + out.items[2]
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $array.Iter::filter"));
  assert(!main.includes("call $array.Iter::map"));

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
      array.RangeIter::fold(array.RangeI32::Iter(0 .. 10), 0, add)
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
      array.RangeIter::fold(array.RangeI32::Iter(5 .. 5), 42, add)
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
        `pub fn main() -> i32 { RangeIter::collect((0 .. 10).Iter()) }`,
        "unknown function RangeIter::collect",
      ],
      [
        `fn add(acc: i32, x: i32) -> i32 { acc + x } pub fn main() -> i32 { RangeIter::reduce((0 .. 10).Iter(), add) }`,
        "unknown function RangeIter::reduce",
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
