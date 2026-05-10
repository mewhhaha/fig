import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  checkSource,
  optimizeProgram,
  parse,
  tokenize,
  wasmFromSource,
  watFromSource,
} from "../src/mod.ts";
import { CompileError } from "../src/diagnostics.ts";
import type { Expr, FnDecl, Program, TypeDecl } from "../src/core_ast.ts";

const resolveProjectModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

async function assertFirstDiagnosticSpanIncludes(
  source: string,
  code: string,
  expectedSource: string,
) {
  try {
    await checkSource(source);
  } catch (error) {
    assert(error instanceof CompileError);
    assertEquals(error.diagnostics[0]?.code, code);
    const span = error.diagnostics[0]?.span;
    assert(span, JSON.stringify(error.diagnostics));
    assertStringIncludes(source.slice(span.start, span.end), expectedSource);
    return;
  }
  throw new Error(`expected ${code}`);
}

Deno.test("grammar metadata uses fig identity", async () => {
  const metadata = JSON.parse(await Deno.readTextFile("baba.json"));
  assertEquals(metadata.language.scope, "source.fig");
  assertEquals(metadata.language.fileTypes, ["fig"]);

  const packageJson = JSON.parse(await Deno.readTextFile("generated/baba-workbench/package.json"));
  assertEquals(packageJson.name, "tree-sitter-fig");
  assertEquals(packageJson["tree-sitter"][0].scope, "source.fig");
  assertEquals(packageJson["tree-sitter"][0]["file-types"], ["fig"]);
});

Deno.test("AST span metadata is hidden and semantic-neutral", async () => {
  const source = `
    fn add_one(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { add_one(41) }
  `;
  const program = await parse(source);
  const main = program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  assert(main);
  assert(main.span);
  assert(!Object.keys(main).includes("span"));
  assert(!JSON.stringify(main).includes('"span"'));
  assertEquals(main, {
    kind: "fn",
    public: true,
    name: "main",
    params: [],
    returnType: "i32",
    effects: [],
    body: main.body,
  });

  const wat = await watFromSource(source);
  assert(!wat.includes("span"));
});

Deno.test("index cursor itself is not an inline-array index proof", async () => {
  await assertThrowsCompile(
    `
      const core = @import("prelude.core");
      type fn InlineArray(n: count, a: type) -> type {
        let InlineArray = {n*a};
        struct(InlineArray)
      }
      fn Bad(xs: InlineArray(3, i32), cursor: core.IndexCursor(3)) -> i32 {
        xs[cursor]
      }
    `,
    "index.requires_proof",
  );
});

Deno.test("static literal expansion and const-label field access lower", async () => {
  const wat = await watFromSource(`
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Pair() -> type {
      let Pair = {left: i32, right: i32};
      struct(Pair)
    }
    fn build() -> InlineArray(3, i32) {
      [0, 1, 2]
    }
    pub fn main() -> i32 {
      let xs: InlineArray(3, i32) = build();
      let p: Pair = Pair {left: 10, right: 32};
      xs[2] + @field(p, #right)
    }
  `);
  assertStringIncludes(wat, "i32.const 0");
  assertStringIncludes(wat, "local.get $p$right");
});

Deno.test("array comprehension syntax is rejected", async () => {
  await assertThrowsCompile(
    `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    pub fn main() -> InlineArray(3, i32) {
      [i | i <- 0 .. 3]
    }
  `,
    "parse.syntax",
  );
});

Deno.test("static for literal syntax is rejected", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn add_index(xs: InlineArray(3, i32), offset: i32) -> InlineArray(3, i32) {
      [for i in 0 .. 3: xs[i] + offset]
    }
  `;
  await assertThrowsCompile(source, "parse.syntax");
});

Deno.test("record static for literal syntax lowers", async () => {
  const wat = await watFromSource(
    `
      const fields = {x: true, y: true};
      pub fn main() -> i32 {
        let value = {for Key, Spec in (fields): 1};
        value.x + value.y
      }
    `,
  );
  assertStringIncludes(wat, "i32.add");
});

Deno.test("product constructor static for literal syntax lowers", async () => {
  const wat = await watFromSource(
    `
      type fn Pair() -> type {
        let Pair = {x: i32, y: i32};
        struct(Pair)
      }
      const fields = {x: true, y: true};
      pub fn main() -> Pair {
        Pair {for Key, Spec in (fields): 1}
      }
    `,
  );
  assertStringIncludes(wat, "(result i32) (result i32)");
});

Deno.test("inline array list spread literals lower as flattened slots", async () => {
  const wat = await watFromSource(
    `
      const layout = @import("prelude.layout");

      fn tail() -> layout.InlineArrayList(2, i32) {
        <2, 3>
      }

      fn build_list() -> layout.InlineArrayList(4, i32) {
        let rest = tail();
        <0, 1, ...rest>
      }

      pub fn main() -> layout.InlineArray(4, i32) {
        layout.InlineArray.from_list(4, i32, build_list())
      }
    `,
    { resolveModule: resolveProjectModule },
  );

  assertStringIncludes(wat, `(result i32) (result i32) (result i32) (result i32)`);
  assert(!wat.includes("collect_start"));
  assert(!wat.includes("collect_push"));
  assert(!wat.includes("collect_finish"));
});

Deno.test("spread entries stay out of product and require inline array list tails", async () => {
  await assertThrowsCompile(
    `
      const layout = @import("prelude.layout");
      type fn Pair() { let Pair = {first: i32, second: i32}; struct(Pair) }
      fn tail() -> layout.InlineArrayList(1, i32) { <2> }
      pub fn Bad() -> Pair { Pair [first: 1, ...tail()] }
    `,
    "parse.syntax",
    { resolveModule: resolveProjectModule },
  );

  await assertThrowsCompile(
    `
      const layout = @import("prelude.layout");
      pub fn Bad(xs: layout.InlineArray(1, i32)) -> layout.InlineArrayList(2, i32) {
        <1, ...xs>
      }
    `,
    "collection.spread_tail_type",
    { resolveModule: resolveProjectModule },
  );
});

Deno.test("target-typed collection literals lower through collector members", async () => {
  const checked = await checkSource(`
    type fn Bag(a: type) {
      let Bag = {sum: i32};
      struct(Bag)
    }
    fn Bag.collect_start(const a: type) -> Bag(a) { Bag {sum: 0} }
    fn Bag.collect_push(const a: type, builder: Bag(a), item: a) -> Bag(a) { builder }
    fn Bag.collect_finish(const a: type, builder: Bag(a)) -> Bag(a) { builder }
    fn take(xs: Bag(i32)) -> Bag(i32) { xs }
    pub fn main() -> i32 {
      let xs: Bag(i32) = <1, 2, 3>;
      let ys = take(<4, 5>);
      xs.sum + ys.sum
    }
  `);
  const main = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  const first = main?.body.statements[0];
  assertEquals(
    first?.kind === "let" && first.value.kind === "call" ? first.value.callee : undefined,
    { kind: "var", name: "Bag.collect_finish" },
  );
  const second = main?.body.statements[1];
  assertEquals(
    second?.kind === "let" && second.value.kind === "call" &&
      second.value.args[0]?.kind === "call"
      ? second.value.args[0].callee
      : undefined,
    { kind: "var", name: "Bag.collect_finish" },
  );
});

Deno.test("collection literals require target collector context", async () => {
  await assertThrowsCompile(
    `
      pub fn Bad() -> i32 {
        let xs = <1, 2, 3>;
        0
      }
    `,
    "collection.expected_type",
  );
  await assertThrowsCompile(
    `
      type fn Scalar() { i32 }
      pub fn Bad() -> Scalar { <1, 2> }
    `,
    "collection.collector_missing",
  );
});

Deno.test("record value punning lowers in records and product constructors", async () => {
  const checked = await checkSource(`
    type fn Pair() -> type {
      let Pair = {left: i32, right: i32};
      struct(Pair)
    }
    fn take(pair: Pair) -> Pair { pair }
    pub fn main() -> i32 {
      let left = 10;
      let right = 32;
      let record = {left, right};
      let product = take(Pair {left, right});
      record.left + product.right
    }
  `);
  const main = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  assertEquals(main?.kind, "fn");
});

Deno.test("tuple values types repeats and destructuring check", async () => {
  await checkSource(`
    type fn Pair() -> type {
      let Pair = [i32, [i32; 3]];
      struct(Pair)
    }
    type fn Lane3() -> type {
      let Lane = [i32; 3];
      struct(Lane)
    }
    fn make_pair() -> Pair { [1, [0; 3]] }
    pub fn main() -> i32 {
      let [head, values] = make_pair();
      head + values[0] + values[1] + values[2]
    }
  `);
});

Deno.test("static for range bounds syntax is rejected", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn double(x: i32) -> i32 { x * 2 }
    fn tight(const n: count) -> InlineArray(n, i32) {
      [for i in 0 .. n: double(i)]
    }
  `;
  await assertThrowsCompile(source, "parse.syntax");
});

Deno.test("field labels remain valid with tight and spaced colons", async () => {
  const source = `
    type fn Pair() -> type {
      let Pair = {left: i32, right : i32};
      struct(Pair)
    }
    type fn Box(t: type) -> type {
      let Box = {value: t};
      struct(Box)
    }
    fn add(x: i32, y : i32) -> i32 { x + y }
    pub fn main() -> i32 {
      let p: Pair = Pair {left: 10, right : 30};
      let b: Box(i32) = Box {value : add(@field(p, #left), @field(p, #right))};
      @field(b, #value)
    }
  `;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 40);
});

Deno.test("inline array tabulation functions compose through layout prelude", async () => {
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
      let mapped = layout.InlineArray.map(4, i32, i32, built, inc);
      let set = layout.InlineArray.set(4, i32, mapped, 2, 99);
      let updated = layout.InlineArray.update(4, i32, set, 0, inc);
      updated[0] + updated[1] + updated[2] + updated[3] + state_mapped[0] + state_mapped[3]
    }
  `;
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule: resolveProjectModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 179);
});

Deno.test("static for statement blocks are rejected", async () => {
  await assertThrowsCompile(
    `
      fn main() -> i32 {
        let acc = 0;
        static for I in 0 .. 3 {
          let acc = acc + I;
        }
        acc
      }
    `,
    "parse.syntax",
  );
});

Deno.test("parses language surface declarations and literals", async () => {
  const program = await parse(`
    const clock: fn() -> i64 !{time} = @capability("clock");
    type fn Id() { i32 }
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Maybe(a: type) { let Nothing = {}; let Some = {value: a}; union(Nothing, Some) }
    type fn Buffer(n: count) { let Buffer = {n*i32}; struct(Buffer) }
    type fn Weird() { let Weird = {fst: i32, 4*i32, 1*i32}; struct(Weird) }
    type fn Eq(t: type) { let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool}; struct(Eq) }
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    fn neq_point(a: Point, b: Point) -> bool { a.x != b.x }
    const point_eq: Eq(Point) = {eql: eql_point, neq: neq_point}
    pub fn main() -> i32 !{} {
      let xs: {3*i32} = [1, 2, 3];
      let point: Point = Point {x: 1, y: 2};
      let label = \`\`\`hello
world\`\`\`;
      match 1 { _ => 2, }
    }
  `);
  assertEquals(program.moduleName, undefined);
  assertEquals(program.imports[0].effects, ["time"]);
  assert(program.declarations.length >= 5);
});

Deno.test("attaches slash doc comments to Fig bindings", async () => {
  const checked = await checkSource(`
    /// builds a documented point
    type fn Point(
      /// coordinate type
      a: type
    ) -> struct {
      /// product shape
      let Point = {
        /// x coordinate
        x: a,
        /// y coordinate
        y: a,
      };
      struct(Point)
    }

    /// top constant
    const origin = {x: 0, y: 0};

    /// top let
    let top_value = 1;

    /// adds values
    fn add(
      /// left input
      a: i32,
      /// right input
      b: i32
    ) -> i32 {
      /// local temp
      let tmp = a + b;
      /// local proof
      const proof = i32;
      tmp
    }
  `);
  const point = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "Point"
  );
  assertEquals(point?.doc, "builds a documented point");
  assertEquals(point?.params[0]?.doc, "coordinate type");
  assertEquals(point?.body.statements[0]?.doc, "product shape");
  assertEquals(point?.normalized?.kind === "product" ? point.normalized.shape.slots : undefined, [
    { doc: "x coordinate", label: "x", type: "a" },
    { doc: "y coordinate", label: "y", type: "a" },
  ]);
  const origin = checked.program.declarations.find((decl) => decl.kind === "const");
  assertEquals(origin?.doc, "top constant");
  const topValue = checked.program.declarations.find((decl) => decl.kind === "let");
  assertEquals(topValue?.doc, "top let");
  const add = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "add"
  );
  assertEquals(add?.doc, "adds values");
  assertEquals(add?.params.map((param) => param.doc), ["left input", "right input"]);
  assertEquals(
    add?.body.statements[0]?.kind === "let" ? add.body.statements[0].doc : undefined,
    "local temp",
  );
  assertEquals(
    add?.body.statements[1]?.kind === "proof_const" ? add.body.statements[1].doc : undefined,
    "local proof",
  );
});

Deno.test("doc comments attach only to the immediately following binding", async () => {
  const program = await parse(`
    /// first line
    /// second line
    fn documented() -> i32 { 1 }

    /// separated

    fn blank_breaks() -> i32 { 2 }
    /// blocked
    // ordinary comment
    fn comment_breaks() -> i32 { 3 }
    // ordinary only
    fn ordinary_comment() -> i32 { 4 }
    /// before import is tolerated
    const std = @import("prelude.std");
  `);
  const byName = new Map(program.declarations.map((decl) => [decl.name, decl]));
  assertEquals(byName.get("documented")?.doc, "first line\nsecond line");
  assertEquals(byName.get("blank_breaks")?.doc, undefined);
  assertEquals(byName.get("comment_breaks")?.doc, undefined);
  assertEquals(byName.get("ordinary_comment")?.doc, undefined);
  assertEquals(program.sourceImports?.[0], {
    kind: "source_import",
    module: "prelude.std",
    alias: "std",
  });
});

Deno.test("preserves docs through source import qualification", async () => {
  const checked = await checkSource(
    `
      const lib = @import("lib");
      fn use(v: lib.Box(i32)) -> i32 { v.value }
    `,
    {
      resolveModule: async (module) =>
        module === "lib"
          ? `
            /// imported box
            type fn Box(
              /// payload type
              a: type
            ) -> struct {
              let Box = {
                /// payload field
                value: a,
              };
              struct(Box)
            }
          `
          : undefined,
    },
  );
  const box = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "lib.Box"
  );
  assertEquals(box?.doc, "imported box");
  assertEquals(box?.params[0]?.doc, "payload type");
  assertEquals(
    box?.normalized?.kind === "product" ? box.normalized.shape.slots[0]?.doc : undefined,
    "payload field",
  );
});

Deno.test("accepts const declarations without trailing semicolons", async () => {
  const checked = await checkSource(`
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Eq(t: type) { let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool}; struct(Eq) }
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    fn neq_point(a: Point, b: Point) -> bool { a.x != b.x }
    const point_eq: Eq(Point) = {eql: eql_point, neq: neq_point}
    const point_eq_again: Eq(Point) = {eql: eql_point, neq: neq_point}
  `);
  assertEquals(
    checked.program.declarations.filter((decl) => decl.kind === "const").length,
    2,
  );
});

Deno.test("normalizes type function declarations", async () => {
  const checked = await checkSource(`
    type fn Id() { i32 }
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Maybe(a: type) { let Nothing = {}; let Some = {value: a}; union(Nothing, Some) }
    type fn Weird() { let Weird = {fst: i32, 4*i32, 1*i32}; struct(Weird) }
    type fn Why(a: count) { let Why = {fst: i32, a*i32}; struct(Why) }
  `);
  const program = checked.program;
  assertEquals(program.declarations[0], {
    kind: "type",
    name: "Id",
    params: [],
    resultKind: "type",
    body: {
      kind: "type_block",
      statements: [],
      expr: { kind: "type_ref", name: "i32" },
    },
    normalized: { kind: "alias", type: "i32" },
    paramKinds: {},
  });
  assertEquals(
    program.declarations[1].kind === "type" ? program.declarations[1].normalized : undefined,
    {
      kind: "product",
      name: "Point",
      constructor: "Point",
      shape: { slots: [{ label: "x", type: "i32" }, { label: "y", type: "i32" }] },
    },
  );
  assertEquals(
    program.declarations[2].kind === "type" ? program.declarations[2].normalized : undefined,
    {
      kind: "sum",
      variants: [
        { name: "Nothing", shape: undefined },
        { name: "Some", shape: { slots: [{ label: "value", type: "a" }] } },
      ],
    },
  );
  assertEquals(
    program.declarations[3].kind === "type" ? program.declarations[3].normalized : undefined,
    {
      kind: "product",
      name: "Weird",
      constructor: "Weird",
      shape: {
        slots: [
          { label: "fst", type: "i32" },
          { label: undefined, repeat: "4", type: "i32" },
          { label: undefined, repeat: "1", type: "i32" },
        ],
      },
    },
  );
  assertEquals(
    program.declarations[4].kind === "type" ? program.declarations[4].paramKinds : undefined,
    {
      a: "count",
    },
  );
});

Deno.test("type functions accept const shapes for generated product fields", async () => {
  const checked = await checkSource(`
    type fn Transform2d() -> type { let Transform2d = {x: i32}; struct(Transform2d) }
    type fn Velocity2d() -> type { let Velocity2d = {x: i32}; struct(Velocity2d) }
    type fn Sprite2d() -> type { i32 }
    type fn Entity2d() -> type { i32 }
    type fn ComponentStore(n: count, component: type) -> type {
      let Store = {n*component};
      struct(Store)
    }
    type fn ComponentStoreFor(component: const) -> type {
      ComponentStore(component.count, component.component)
    }
    type fn World2d(entity_count: count, components: const, entity: type) -> type {
      let Base = {entities: ComponentStore(entity_count, entity)};
      let Stores = @shape_map(components, ComponentStoreFor);
      let World2d = @shape_concat(Base, Stores);
      struct(World2d)
    }
    const game_components = {
      transforms: {count: 3, component: Transform2d},
      velocities: {count: 1, component: Velocity2d},
      sprites: {count: 3, component: Sprite2d},
    };
    pub fn use_world(world: World2d(3, game_components, Entity2d)) -> i32 { 0 }
  `);
  const type = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "World2d"
  );
  assertEquals(type?.paramKinds?.components, "const");
  const useWorld = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "use_world"
  );
  assertStringIncludes(useWorld?.params[0]?.type ?? "", "game_components");
});

Deno.test("type functions accept inline const shape arguments", async () => {
  const checked = await checkSource(`
    type fn Transform2d() -> type { i32 }
    type fn Entity2d() -> type { i32 }
    type fn ComponentStore(n: count, component: type) -> type {
      let Store = {n*component};
      struct(Store)
    }
    type fn ComponentStoreFor(component: const) -> type {
      ComponentStore(component.count, component.component)
    }
    type fn World2d(entity_count: count, components: const, entity: type) -> type {
      let Base = {entities: ComponentStore(entity_count, entity)};
      let Stores = @shape_map(components, ComponentStoreFor);
      let World2d = @shape_concat(Base, Stores);
      struct(World2d)
    }
    pub fn use_world(world: World2d(3, {transforms: {count: 3, component: Transform2d}}, Entity2d)) -> i32 { 0 }
  `);
  const useWorld = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "use_world"
  );
  assertStringIncludes(useWorld?.params[0]?.type ?? "", "World2d");
});

Deno.test("shape concat reports duplicate generated fields", async () => {
  await assertThrowsCompile(
    `
      type fn Item() -> type { i32 }
      type fn ComponentStore(n: count, component: type) -> type {
        let Store = {n*component};
        struct(Store)
      }
      type fn ComponentStoreFor(component: const) -> type {
        ComponentStore(component.count, component.component)
      }
      type fn BadWorld(components: const) -> type {
        let Base = {transforms: ComponentStore(1, Item)};
        let Stores = @shape_map(components, ComponentStoreFor);
        let World = @shape_concat(Base, Stores);
        struct(World)
      }
      pub fn use_world(world: BadWorld({transforms: {count: 1, component: Item}})) -> i32 { 0 }
    `,
    "type.shape_concat_duplicate",
  );
});

Deno.test("static shape inspection and transforms build products", async () => {
  const checked = await checkSource(`
    type fn KeepXy(key: const, value: const) -> type {
      match key {
        #x => true,
        #flag => true,
        _ => false,
      }
    }
    type fn RenameValue(key: const, value: const) -> type {
      match key {
        #y => bool,
        _ => value,
      }
    }
    type fn ShapeTools(a: type) -> type {
      let Base = {x: i32, y: i64, z: bool};
      let Picked = @shape_pick(Base, {x: true, z: i32});
      let Omitted = @shape_omit(Base, {z: true});
      let Intersected = @shape_intersect(Picked, Omitted);
      let Difference = @shape_difference(Base, Intersected);
      let Renamed = @shape_rename(Difference, {y: #flag, z: "done"});
      let Mapped = @shape_map_with_key(Renamed, RenameValue);
      let Filtered = @shape_filter(Mapped, KeepXy);
      let Count = @shape_count(Filtered);
      let TrueOut = @shape_concat(Filtered, {extra: @shape_slot(Filtered, #flag)});
      let FalseOut = {missing: i32};
      match @shape_has_slot(Filtered, #flag) {
        true => struct(TrueOut),
        false => struct(FalseOut),
      }
    }
    pub fn use_shape_tools(value: ShapeTools(i32)) -> i32 { 0 }
  `);
  const useShapeTools = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "use_shape_tools"
  );
  assertStringIncludes(useShapeTools?.params[0]?.type ?? "", "ShapeTools");
});

Deno.test("static type reflection feeds shape helpers", async () => {
  const checked = await checkSource(`
    type fn Point() -> type { let Point = {x: i32, y: i32, z: bool}; struct(Point) }
    type fn Option(a: type) -> type { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn ReflectedPoint(a: type) -> type {
      let Slots = @type_slots(Point);
      let Picked = @shape_pick(Slots, {x: true, y: true});
      let Count = @shape_count(Picked);
      let Reflected = {Count*@shape_slot(Picked, #x)};
      struct(Reflected)
    }
    type fn ReflectedSome(a: type) -> type {
      let Variants = @type_variants(Option(i32));
      let SomeSlots = @type_variant_slots(Option(i32), #Some);
      let Missing = {missing: i32};
      match @shape_count(SomeSlots) == @shape_count(@shape_slot(Variants, #Some)) {
        true => struct(SomeSlots),
        false => struct(Missing),
      }
    }
    pub fn use_reflected(point: ReflectedPoint(i32), some: ReflectedSome(i32)) -> i32 { 0 }
  `);
  const useReflected = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "use_reflected"
  );
  assertStringIncludes(useReflected?.params[1]?.type ?? "", "ReflectedSome");
});

Deno.test("generic empty derives primitive and product zero values", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
      const core = @import("prelude.core");
      type fn Point() -> type {
        let Point = {x: i32, visible: bool};
        struct(Point)
      }
      pub fn main() -> i32 {
        let p = core.empty(Point);
        let visible_value = match p.visible { true => 100, false => p.x };
        core.empty(i32) + visible_value
      }
    `,
        { resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 0);
});

Deno.test("literal unions work as runtime value types", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
      fn Choose(x: 1 | 2 | 3) -> i32 { x }
      pub fn main() -> i32 { Choose(2) }
    `),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 2);
});

Deno.test("literal unions reject values outside the closed set", async () => {
  await assertThrowsCompile(
    `
      fn Choose(x: 1 | 2 | 3) -> i32 { x }
      pub fn main() -> i32 { Choose(4) }
    `,
    "type.literal_mismatch",
  );
  await assertThrowsCompile(
    `
      fn tag(x: #why | #this | #tag) -> i32 { 1 }
      pub fn main() -> i32 { tag(#other) }
    `,
    "type.literal_mismatch",
  );
});

Deno.test("literal unions work in product and tuple fields", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
      type fn Tagged() -> type {
        let Tagged = {tag: #why | #this | #tag, word: "hello" | "world", mark: 'a' | 'b'};
        struct(Tagged)
      }
      type fn Pair() -> type {
        let Pair = [1 | 2, "hello" | "world"];
        struct(Pair)
      }
      fn score(value: Tagged) -> i32 {
        match value.tag {
          #this => 10,
          _ => 0
        }
      }
      pub fn main() -> i32 {
        let item: Tagged = Tagged {tag: #this, word: "world", mark: 'b'};
        let pair: Pair = [2, "hello"];
        score(item) + pair[0]
      }
    `),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 12);
});

Deno.test("explicit empty member overrides derived product empty", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
      const core = @import("prelude.core");
      type fn Point() -> type {
        let Point = {x: i32};
        struct(Point)
      }
      fn Point.empty() -> Point { Point {x: 7} }
      pub fn main() -> i32 {
        let p = core.empty(Point);
        p.x
      }
    `,
        { resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 7);
});

Deno.test("generic empty rejects unsupported sum values", async () => {
  await assertThrowsCompile(
    `
      const core = @import("prelude.core");
      type fn MaybeI32() -> type {
        let None = {};
        let Some = {value: i32};
        union(None, Some)
      }
      pub fn main() -> MaybeI32 { core.empty(MaybeI32) }
    `,
    "type.unknown_type_member",
    { resolveModule: resolveProjectModule },
  );
});

Deno.test("ecs sparse query accepts canonical sparse worlds", async () => {
  const checked = await checkSource(
    `
    const ecs = @import("engine.ecs");
    type fn Transform2d() -> type { i32 }
    type fn Velocity2d() -> type { i32 }
    const components = {transform: Transform2d, velocity: Velocity2d};
    const movement_query = {transform: Transform2d, velocity: Velocity2d};
    type fn World() -> type { ecs.SparseWorld(3, components) }
    pub fn main(world: World) -> World {
      world
    }
  `,
    { resolveModule: resolveProjectModule },
  );
  const main = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  assertStringIncludes(main?.params[0]?.type ?? "", "World");
});

Deno.test("ecs sparse query rejects missing sparse component slots", async () => {
  await assertThrowsCompile(
    `
      const ecs = @import("engine.ecs");
      type fn Transform2d() -> type { i32 }
      type fn Sprite2d() -> type { i32 }
      const components = {
        transform: Transform2d,
      };
      const render_query = {
        sprite: Sprite2d,
      };
      const render_query_token: ecs.SparseQuery(ecs.SparseWorld(3, components), render_query) = {};
      pub fn main() -> i32 { 0 }
    `,
    "type.require",
    { resolveModule: resolveProjectModule },
  );
});

Deno.test.ignore("ecs sparse world seeds from partial entity rows", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
      const ecs = @import("engine.ecs");
      type fn Transform2d() -> type { let Transform2d = {x: i32}; struct(Transform2d) }
      type fn Velocity2d() -> type { let Velocity2d = {x: i32}; struct(Velocity2d) }
      const components = {transform: Transform2d, velocity: Velocity2d};
      pub fn main() -> i32 {
        let w = ecs.SparseWorld.empty(components)
          \\w -> ecs.entity.add(w, {transform: Transform2d {x: 1}, velocity: Velocity2d {x: 2}})
          \\w -> ecs.entity.add(w, {transform: Transform2d {x: 10}})
          \\w -> ecs.entity.add(w, {velocity: Velocity2d {x: 20}});
        match w.velocity.present[1] {
          true => 0,
          false => w.transform.values[1].x + w.velocity.values[1].x,
        }
      }
    `,
        { resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 10);
});

Deno.test.ignore("ecs fold infers read shape and skips omitted components", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
      const ecs = @import("engine.ecs");
      type fn Transform2d() -> type { let Transform2d = {x: i32}; struct(Transform2d) }
      type fn Velocity2d() -> type { let Velocity2d = {x: i32}; struct(Velocity2d) }
      const components = {transform: Transform2d, velocity: Velocity2d};
      const movement_reads = {transform: Transform2d, velocity: Velocity2d};
      fn sum_moved(acc: i32, row: ecs.Row(movement_reads)) -> i32 {
        acc + row.transform.x + row.velocity.x
      }
      pub fn main() -> i32 {
        let w = ecs.SparseWorld.empty(components)
          \\w -> ecs.entity.add(w, {transform: Transform2d {x: 1}, velocity: Velocity2d {x: 2}})
          \\w -> ecs.entity.add(w, {transform: Transform2d {x: 10}})
          \\w -> ecs.entity.add(w, {transform: Transform2d {x: 20}, velocity: Velocity2d {x: 3}});
        ecs.fold(w, 0, sum_moved)
      }
    `,
        { resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 26);
});

Deno.test("qualified zero-argument calls stay calls after lowering", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
      const geometry = @import("prelude.geometry2d");
      pub fn main() -> i32 {
        let batch = Geometry.empty_geometry2d_batch3();
        batch.vertex_count
      }
    `,
        { resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 0);
});

Deno.test("const declarations cannot be annotated as type", async () => {
  await assertThrowsCompile(
    `
      type fn Transform2d() -> type { let Transform2d = {x: i32}; struct(Transform2d) }
      const components: type = {transform: Transform2d};
      pub fn main() -> i32 { 0 }
    `,
    "type.const_dictionary_type",
  );
});

Deno.test.ignore("ecs sparse world entity rows reject extra fields", async () => {
  await assertThrowsCompile(
    `
      const ecs = @import("engine.ecs");
      type fn Transform2d() -> type { let Transform2d = {x: i32}; struct(Transform2d) }
      const components = {transform: Transform2d};
      pub fn main() -> i32 {
        let w = ecs.SparseWorld.empty(components)
          \\w -> ecs.entity.add(w, {transform: Transform2d {x: 1}, sprite: 1});
        0
      }
    `,
    "type.require",
    { resolveModule: resolveProjectModule },
  );
});

Deno.test.ignore("ecs sparse world entity rows reject mismatched component values", async () => {
  await assertThrowsCompile(
    `
      const ecs = @import("engine.ecs");
      type fn Transform2d() -> type { let Transform2d = {x: i32}; struct(Transform2d) }
      const components = {transform: Transform2d};
      pub fn main() -> i32 {
        let w = ecs.SparseWorld.empty(components)
          \\w -> ecs.entity.add(w, {transform: true});
        0
      }
    `,
    "type.require",
    { resolveModule: resolveProjectModule },
  );
});

Deno.test.ignore("ecs sparse world entity add leaves fixed storage unchanged after capacity", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(
        `
      const ecs = @import("engine.ecs");
      type fn Marker() -> type { let Marker = {tag: i32}; struct(Marker) }
      const components = {marker: Marker};
      pub fn main() -> i32 {
        let w = ecs.SparseWorld.empty(components)
          \\w -> ecs.entity.add(w, {marker: Marker {tag: 1}})
          \\w -> ecs.entity.add(w, {marker: Marker {tag: 2}})
          \\w -> ecs.entity.add(w, {marker: Marker {tag: 3}})
          \\w -> ecs.entity.add(w, {marker: Marker {tag: 4}});
        w.next_entity_id + w.marker.values[2].tag
      }
    `,
        { resolveModule: resolveProjectModule },
      ),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 7);
});

Deno.test("shape and type reflection diagnostics are focused", async () => {
  await assertThrowsCompile(
    "type fn Bad(a: type) -> type { let Shape = {x: a}; let X = @shape_slot(Shape, #y); let Out = {value: X}; struct(Out) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.unknown_shape_slot",
  );
  await assertThrowsCompile(
    "type fn Option(a: type) -> type { let None = {}; union(None) } type fn Bad(a: type) -> type { @type_variant_slots(Option(a), #Some) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.unknown_type_variant",
  );
  await assertThrowsCompile(
    "type fn Bad(a: type) -> type { let Shape = {x: a, y: a}; let Renamed = @shape_rename(Shape, {x: #z, y: #z}); struct(Renamed) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.shape_rename_duplicate",
  );
  await assertThrowsCompile(
    "type fn Bad(a: type) -> type { let Count = @shape_count(a); let Out = {Count*i32}; struct(Out) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.shape_builtin_arg",
  );
  await assertThrowsCompile(
    "type fn NotBool(key: const, value: const) -> type { value } type fn Bad(a: type) -> type { let Shape = {x: a}; let Filtered = @shape_filter(Shape, NotBool); struct(Filtered) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.shape_filter",
  );
});

Deno.test("compile-time builtin diagnostics prefer offending argument spans", async () => {
  await assertFirstDiagnosticSpanIncludes(
    "type fn Bad(a: type) -> type { let Count = @shape_count(a); let Out = {Count*i32}; struct(Out) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.shape_builtin_arg",
    "a",
  );
  await assertFirstDiagnosticSpanIncludes(
    "type fn Bad(a: type) -> type { let Shape = {x: a}; let X = @shape_slot(Shape, #missing); let Out = {value: X}; struct(Out) } pub fn f(x: Bad(i32)) -> i32 { 0 }",
    "type.unknown_shape_slot",
    "#missing",
  );
  await assertFirstDiagnosticSpanIncludes(
    "type fn Point() -> type { let Point = {x: i32}; struct(Point) } type fn Bad(t: type) -> type { @type_slot_type(t, #missing) } pub fn f(x: Bad(Point)) -> i32 { 0 }",
    "type.unknown_type_slot",
    "#missing",
  );
  await assertFirstDiagnosticSpanIncludes(
    "const bad = shape_slot({x: i32}, #missing); pub fn main() -> i32 { 0 }",
    "type.unknown_shape_slot",
    "#missing",
  );
});

Deno.test("checks type function result kinds", async () => {
  await checkSource(`
    type fn Point() -> struct { let Point = {x: i32}; struct(Point) }
    type fn Option(a: type) -> union { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn Id() -> type { i32 }
  `);
  await assertThrowsCompile(
    "type fn Bad() -> struct { i32 }",
    "type.result_kind",
  );
  await assertThrowsCompile(
    "type fn Bad() -> struct { let None = {}; union(None) }",
    "type.result_kind",
  );
  await assertThrowsCompile(
    "type fn Bad() -> union { let Point = {x: i32}; struct(Point) }",
    "type.result_kind",
  );
  await assertThrowsCompile(
    `
      type fn Choose(i32: type) -> struct { let Box = {value: i32}; struct(Box) }
      type fn Choose(bool: type) -> union { let None = {}; union(None) }
    `,
    "type.clause_result_kind",
  );
  await assertThrowsCompile(
    "fn main() -> struct { 1 }",
    "parse.syntax",
  );
});

Deno.test("operator descriptors lower custom infix calls", async () => {
  const checked = await checkSource(`
    type fn Plus(t: type) -> operator {
      operator(#infixl, 60, "+", t.add)
    }
    type fn Box() -> struct {
      let Box = {value: i32};
      struct(Box)
    }
    fn Box.add(a: Box, b: Box) -> Box { Box {value: a.value + b.value} }
    pub fn main(a: Box, b: Box) -> Box { a + b }
  `);
  const main = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name === "main"
  );
  if (!main || main.kind !== "fn") throw new Error("missing main");
  assertEquals(main.body.expr?.kind, "call");
  if (main.body.expr?.kind === "call" && main.body.expr.callee.kind === "var") {
    assertEquals(main.body.expr.callee.name, "Box.add");
  }
});

Deno.test("operator descriptors lower custom comparison and append calls", async () => {
  const checked = await checkSource(`
    type fn EqOp(t: type) -> operator {
      operator(#infix, 40, "==", t.eql)
    }
    type fn LtOp(t: type) -> operator {
      operator(#infix, 50, "<", t.lt)
    }
    type fn AppendOp(t: type) -> operator {
      operator(#infixr, 55, "<>", t.append)
    }
    type fn Box() -> struct {
      let Box = {value: i32};
      struct(Box)
    }
    fn Box.eql(a: Box, b: Box) -> bool { a.value == b.value }
    fn Box.lt(a: Box, b: Box) -> bool { a.value < b.value }
    fn Box.append(a: Box, b: Box) -> Box { Box {value: a.value + b.value} }
    pub fn Eq(a: Box, b: Box) -> bool { a == b }
    pub fn lt(a: Box, b: Box) -> bool { a < b }
    pub fn append(a: Box, b: Box) -> Box { a <> b }
  `);
  const callees = checked.program.declarations
    .filter((decl) => decl.kind === "fn" && decl.public)
    .map((decl) =>
      decl.kind === "fn" && decl.body.expr?.kind === "call" &&
        decl.body.expr.callee.kind === "var"
        ? decl.body.expr.callee.name
        : ""
    );
  assertEquals(callees, ["Box.eql", "Box.lt", "Box.append"]);
});

Deno.test("operator parser honors precedence for extended symbols", async () => {
  const checked = await checkSource(`
    pub fn main() -> i32 { 1 + 2 * 3 % 4 }
  `);
  const main = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name === "main"
  );
  if (!main || main.kind !== "fn") throw new Error("missing main");
  assertEquals(main.body.expr?.kind, "binary");
  if (main.body.expr?.kind === "binary") assertEquals(main.body.expr.op, "+");
});

Deno.test("parses type function examples", async () => {
  const program = await parse(`
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Maybe(a: type) { let Nothing = {}; let Some = {value: a}; union(Nothing, Some) }
    type fn Why(a: count) { let Why = {fst: i32, a*i32}; struct(Why) }
  `);
  assertEquals(program.declarations.map((decl) => decl.kind === "type" ? decl.name : ""), [
    "Point",
    "Maybe",
    "Why",
  ]);
});

Deno.test("checks product constructor expressions", async () => {
  await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    fn make(x: i32) -> Box { Box {value: x} }
    pub fn main() -> i32 { make(1).value }
  `);
  await assertThrowsCompile(
    `
    type fn Box() { let Box = {value: i32}; struct(Box) }
    fn make(x: i32) -> Box { Box {} }
  `,
    "type.constructor_missing_slot",
  );
  await assertThrowsCompile(
    `
    type fn Box() { let Box = {value: i32}; struct(Box) }
    fn make(x: i32) -> Box { Box {value: x, other: x} }
  `,
    "type.constructor_unknown_slot",
  );
  await assertThrowsCompile(
    `
    fn make(x: i32) -> i32 { Missing {value: x} }
  `,
    "type.unknown_constructor",
  );
});

Deno.test("reports type function diagnostics", async () => {
  await assertThrowsCompile(
    "type fn Bad(a: count) { let Bad = {x: a, a*i32}; struct(Bad) }",
    "type.param_kind_conflict",
  );
  await assertThrowsCompile("type fn Loop() { Loop() }", "type.recursive_type_fn");
  await assertThrowsCompile(
    "type fn Bad(t: type) { match t { i32 => i32 } } fn f(x: Bad(bool)) -> i32 { 1 }",
    "type.non_exhaustive_match",
  );
  await assertThrowsCompile(
    "type fn Bad(t: type) { type_is_product(t) } fn f(x: Bad(i32)) -> i32 { 1 }",
    "type.static_builtin_prefix",
  );
  await assertThrowsCompile(
    `
    const host: fn() -> bool !{io} = @capability("host");
    fn calls_host(t) -> bool !{io} { host() }
    type fn Bad(t: type) { match calls_host(t) { true => i32, false => bool } }
    fn f(x: Bad(i32)) -> i32 { 1 }
  `,
    "type.runtime_capability_call",
  );
  await assertThrowsCompile(
    `
    fn unsupported(t) -> bool { 1 + 2 }
    type fn Bad(t: type) { match unsupported(t) { true => i32, false => bool } }
    fn f(x: Bad(i32)) -> i32 { 1 }
  `,
    "type.unsupported_expr",
  );
  await assertThrowsCompile(
    "type fn bad(a: type) { let Bad = {value: a}; struct(Bad) }",
    "parse.syntax",
  );
  await assertThrowsCompile(
    "type fn Bad(A: type) { let Bad = {value: A}; struct(Bad) }",
    "type.type_param_casing",
  );
  await assertThrowsCompile(
    "type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) } fn f(x: option(i32)) -> i32 { 1 }",
    "type.lowercase_type_constructor",
  );
  await checkSource(
    "type fn Pair(a: type) { let Pair = {fst: a, snd: a}; struct(Pair) } fn f(x: Pair(i32)) -> i32 { 1 }",
  );
  await checkSource(
    "type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) } fn unwrap_or(value: Option(a), fallback: a) -> a { match value { Some(x) => x, None => fallback } }",
  );
});

Deno.test("dispatches ordered type function clauses", async () => {
  const checked = await checkSource(`
    type fn Choose(t: type) -> type { t }
    type fn Choose(i32: type) -> type { bool }
    type fn CountCase(_: count) -> type { i32 }
    type fn CountCase(0: count) -> type { bool }
    type fn CountShadow() -> type { CountCase(0) }
    fn first(x: Choose(i32)) -> bool { x }
  `);
  const first = findFn(checked.program, "first");
  const countShadow = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "CountShadow"
  );
  assertEquals(first?.params[0].type, "Choose(i32)");
  assertEquals(countShadow?.normalized, { kind: "alias", type: "CountCase(0)" });
});

Deno.test("accepts ordered value function literal clauses", async () => {
  const checked = await checkSource(`
    fn something_n(1: i32) -> i32 { 10 }
    fn something_n(a: i32) -> i32 { a }
    pub fn main() -> i32 { something_n(1) }
  `);
  assertEquals(findFns(checked.program, "something_n__clause_0").length, 1);
  assertEquals(findFns(checked.program, "something_n__clause_1").length, 1);
});

Deno.test("rejects incompatible value function clauses", async () => {
  await assertThrowsCompile(
    `
    fn Bad(1: i32) -> i32 { 1 }
    fn Bad(a: i32, b: i32) -> i32 { a }
  `,
    "fn.clause_arity",
  );
  await assertThrowsCompile(
    `
    fn Bad(1: i32) -> i32 { 1 }
    fn Bad(a: i32) -> bool { true }
  `,
    "fn.clause_return",
  );
});

Deno.test("reports tree-sitter syntax errors", async () => {
  await assertThrowsCompile("pub fn main( { 1 }", "parse.syntax");
});

Deno.test("parser front end is Baba generated", async () => {
  const parserSource = await Deno.readTextFile(new URL("../src/parser.ts", import.meta.url));
  assert(parserSource.includes("../generated/baba-workbench/parser.ts"));
  assert(!parserSource.includes("tokenize("));
  assert(!parserSource.includes("class Parser"));
});

Deno.test("tokenizes through Baba generated lexer", () => {
  const tokens = tokenize(`
    // comment
    pub fn main() -> i32 !{} {
      let text = \`\`\`hello
world\`\`\`;
      #Tag 42 "ok" 'x' true zip ..
    }
  `);
  assertEquals(
    tokens.map((token) => [token.kind, token.text]),
    [
      ["pub", "pub"],
      ["fn", "fn"],
      ["identifier", "main"],
      ["symbol", "("],
      ["symbol", ")"],
      ["symbol", "->"],
      ["identifier", "i32"],
      ["symbol", "!"],
      ["symbol", "{}"],
      ["symbol", "{"],
      ["let", "let"],
      ["identifier", "text"],
      ["symbol", "="],
      ["multiline", "```hello\nworld```"],
      ["symbol", ";"],
      ["literalType", "#Tag"],
      ["number", "42"],
      ["string", '"ok"'],
      ["char", "'x'"],
      ["bool", "true"],
      ["zip", "zip"],
      ["symbol", ".."],
      ["symbol", "}"],
    ],
  );
});

Deno.test("rejects public functions without return signatures", async () => {
  await assertThrowsCompile(
    `
    pub fn main() { 1 }
  `,
    "type.public_signature",
  );
});

Deno.test("compiler intrinsic wrappers typecheck and stay out of runtime output", async () => {
  const checked = await checkSource(`
    fn temporal.handle(ptr: i32, rev: i32) -> i64 { @temporal_handle(ptr, rev) }
    fn use_it(x: i32) -> i64 { temporal.handle(x, 4) }
  `);
  const wrapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "temporal.handle"
  );
  assertEquals(wrapper?.primitiveId, undefined);

  const wat = await watFromSource(`
    fn temporal.handle(ptr: i32, rev: i32) -> i64 { @temporal_handle(ptr, rev) }
    pub fn main() -> i32 { 1 }
  `);
  assert(!wat.includes("(func $temporal.handle"));

  await assertThrowsCompile(
    "fn nope(x: i32) -> i32 { @ptr_not_a_primitive(x) }",
    "primitive.unknown",
  );
  await checkSource(`
    fn a(x: i32) -> i64 { @temporal_handle(x, 1) }
    fn b(x: i32) -> i64 { @temporal_handle(x, 1) }
  `);
});

Deno.test("namespace source imports qualify values and types", async () => {
  const modules = new Map([
    [
      "prelude.std",
      `
        type fn Lane4I32() { {4*i32} }
        type fn Pair(a: type, b: type) { {fst: a, snd: b} }
        fn inc_local(x: i32) -> i32 { x + 1 }
        pub fn inc(x: i32) -> i32 { inc_local(x) }
        pub fn map4_i32(f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
          [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
        }
      `,
    ],
    [
      "./local_module.fig",
      `
        fn helper(x: i32) -> i32 { x + 2 }
        pub fn use_helper(x: i32) -> i32 { helper(x) }
      `,
    ],
  ]);
  const seen: string[] = [];
  const resolveModule = (specifier: string) => {
    seen.push(specifier);
    return modules.get(specifier);
  };

  const checked = await checkSource(
    `
      const std = @import("prelude.std");
      const local = @import("./local_module.fig");
      pub fn main() -> std.Lane4I32 { std.map4_i32(std.inc, [1, 2, 3, 4]) }
      fn pair_value() -> std.Pair(i32, i32) { {fst: 1, snd: 2} }
      fn local_value() -> i32 { local.use_helper(1) }
    `,
    { resolveModule },
  );

  assertEquals(seen, ["prelude.std", "./local_module.fig"]);
  assert(checked.program.declarations.some((decl) => decl.name === "std.map4_i32"));
  assert(checked.program.declarations.some((decl) => decl.name === "std.inc_local"));
  assert(!checked.program.declarations.some((decl) => decl.name === "std"));

  assert(!checked.program.declarations.some((decl) => decl.name === "map4_i32"));
  await assertThrowsCompile(
    `
      const std = @import("prelude.std");
      const std = @import("./local_module.fig");
      pub fn main() -> i32 { 1 }
    `,
    "module.duplicate_alias",
    { resolveModule },
  );
});

Deno.test("destructured source imports select exact declarations", async () => {
  const modules = new Map([
    [
      "prelude.array",
      `
        type fn Lane4I32() -> type { {4*i32} }
        fn inc_local(x: i32) -> i32 { x + 1 }
        pub fn lane4_add_i32(xs: Lane4I32, ys: Lane4I32) -> Lane4I32 {
          [xs[0] + ys[0], xs[1] + ys[1], xs[2] + ys[2], xs[3] + ys[3]]
        }
        pub fn map4_i32(f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
          [f(inc_local(xs[0])), f(xs[1]), f(xs[2]), f(xs[3])]
        }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  const parsed = await parse('const { map4_i32, } = @import("prelude.array");');
  assertEquals(parsed.sourceImports?.[0].bindings?.map((binding) => binding.name), ["map4_i32"]);

  const checked = await checkSource(
    `
      const { map4_i32, lane4_add_i32 } = @import("prelude.array");
      fn inc(x: i32) -> i32 { x + 1 }
      pub fn main() -> i32 {
        let xs = map4_i32(inc, [1, 2, 3, 4]);
        lane4_add_i32(xs, xs)[0]
      }
    `,
    { resolveModule },
  );

  const names = checked.program.declarations.map((decl) => decl.name);
  assert(names.includes("map4_i32"));
  assert(names.includes("lane4_add_i32"));
  assert(names.some((name) => name.endsWith(".inc_local")));
  assert(!names.includes("inc_local"));
});

Deno.test("destructured source imports diagnose invalid bindings and conflicts", async () => {
  const modules = new Map([
    ["prelude.array", "pub fn map4_i32(x: i32) -> i32 { x }"],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  await assertThrowsCompile(
    'const { missing } = @import("prelude.array"); pub fn main() -> i32 { 1 }',
    "module.missing_binding",
    { resolveModule },
  );
  await assertThrowsCompile(
    'const { map4_i32, map4_i32 } = @import("prelude.array"); pub fn main() -> i32 { 1 }',
    "module.duplicate_binding",
    { resolveModule },
  );
  await assertThrowsCompile(
    'const { map4_i32 } = @import("prelude.array"); fn map4_i32() -> i32 { 1 }',
    "module.duplicate_import",
    { resolveModule },
  );
  await assertThrowsCompile(
    "const { map4_i32 } = 1; pub fn main() -> i32 { 1 }",
    "parse.lower",
  );
});

Deno.test("namespace source imports support nested qualified references", async () => {
  const modules = new Map([
    [
      "prelude.layout",
      `
        type fn Lane4I32() -> type { {4*i32} }
      `,
    ],
    [
      "prelude.array",
      `
        const layout = @import("prelude.layout");
        pub fn map4_i32(f: fn(x: i32) -> i32, xs: layout.Lane4I32) -> layout.Lane4I32 {
          [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
        }
      `,
    ],
    [
      "prelude.std",
      `
        const array = @import("prelude.array");
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  await checkSource(
    `
      const std = @import("prelude.std");
      fn inc(x: i32) -> i32 { x + 1 }
      pub fn main() -> std.array.layout.Lane4I32 {
        std.array.map4_i32(inc, [1, 2, 3, 4])
      }
    `,
    { resolveModule },
  );
});

Deno.test("merge source import alias is ordinary namespace alias", async () => {
  const modules = new Map([
    [
      "prelude.array",
      `
        type fn Lane4I32() -> type { {4*i32} }
        pub fn map4_i32(x: i32) -> i32 { x + 1 }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  const checked = await checkSource(
    `
      const merge = @import("prelude.array");
      pub fn main() -> i32 { merge.map4_i32(1) }
    `,
    { resolveModule },
  );
  assert(checked.program.declarations.some((decl) => decl.name === "merge.map4_i32"));
  assert(!checked.program.declarations.some((decl) => decl.name === "map4_i32"));
  await assertThrowsCompile(
    `
      const merge = @import("prelude.array");
      const merge = @import("prelude.array");
      pub fn main() -> i32 { 1 }
    `,
    "module.duplicate_alias",
    { resolveModule },
  );
});

Deno.test("source import diagnostics use import span and module source ids", async () => {
  try {
    await checkSource('const lib = @import("missing.lib"); pub fn main() -> i32 { 1 }', {
      sourceId: "root.fig",
      resolveModule: () => undefined,
    });
    throw new Error("expected missing module diagnostic");
  } catch (error) {
    assert(error instanceof CompileError);
    const diagnostic = error.diagnostics.find((item) => item.code === "module.not_found");
    assert(diagnostic, JSON.stringify(error.diagnostics));
    assertEquals(diagnostic.span?.sourceId, "root.fig");
    assertEquals(diagnostic.span?.line, 1);
    assertEquals(diagnostic.span?.column, 1);
  }

  try {
    await checkSource('const lib = @import("string.lib"); pub fn main() -> i32 { 1 }', {
      resolveModule: () => "pub fn Bad( { 1 }",
    });
    throw new Error("expected imported module diagnostic");
  } catch (error) {
    assert(error instanceof CompileError);
    const diagnostic = error.diagnostics.find((item) => item.code === "parse.syntax");
    assert(diagnostic, JSON.stringify(error.diagnostics));
    assertEquals(diagnostic.span?.sourceId, "string.lib");
  }

  try {
    await checkSource('const lib = @import("named.lib"); pub fn main() -> i32 { 1 }', {
      resolveModule: () => ({
        text: "pub fn Bad( { 1 }",
        sourceId: "virtual/named.fig",
      }),
    });
    throw new Error("expected imported module diagnostic");
  } catch (error) {
    assert(error instanceof CompileError);
    const diagnostic = error.diagnostics.find((item) => item.code === "parse.syntax");
    assert(diagnostic, JSON.stringify(error.diagnostics));
    assertEquals(diagnostic.span?.sourceId, "virtual/named.fig");
  }
});

Deno.test("namespace source imports qualify static slots fields and type-block names", async () => {
  const modules = new Map([
    [
      "layout.lib",
      `
        type fn Pair() -> type {
          let Pair = {left: i32, right: i32};
          struct(Pair)
        }
        type fn Triple() -> type { {3*i32} }
        const default_pair = {left: 7, right: 11}
        pub fn build() -> Triple {
          [11, 12, 13]
        }
      `,
    ],
  ]);
  const resolveModule = (specifier: string) => modules.get(specifier);

  const checked = await checkSource(
    `
      const layout = @import("layout.lib");
      pub fn main() -> i32 {
        let xs: layout.Triple = layout.build();
        xs[0] + @field(layout.default_pair, #left)
      }
    `,
    { resolveModule },
  );

  const names = checked.program.declarations.map((decl) => decl.name);
  const pairDecl = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "layout.Pair"
  );
  assert(names.includes("layout.default_pair"));
  assert(pairDecl?.body.statements.some((stmt) => stmt.name === "layout.Pair"));
  assert(!names.includes("default_pair"));
  assert(!pairDecl?.body.statements.some((stmt) => stmt.name === "Pair"));
});

Deno.test("rejects pure calls to effectful host capabilities", async () => {
  await assertThrowsCompile(
    `
    const clock: fn() -> i64 !{time} = @capability("clock");
    pub fn main() -> i32 { clock() }
  `,
    "effect.pure_host_call",
  );
});

Deno.test("accepts explicit effect rows for host capabilities", async () => {
  await checkSource(`
    const clock: fn() -> i32 !{time} = @capability("clock");
    pub fn main() -> i32 !{time} { clock() }
  `);
});

Deno.test("temporal values allow reuse after calls", async () => {
  await checkSource(
    `
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let moved = sink(x);
      x + moved
    }
  `,
  );
});

Deno.test("rejects removed ownership and explicit memory forms", async () => {
  await assertThrowsCompile("pub fn main() -> i32 { fork(1) }", "function.unknown");
  await assertThrowsCompile("fn bad(x: &(i32)) -> i32 { 0 }", "parse.syntax");
  await assertThrowsCompile("pub fn main() -> i32 { let x = 1; &x }", "parse.syntax");
  await assertThrowsCompile("fn bad(x: #(i32)) -> i32 { 0 }", "parse.syntax");
  await assertThrowsCompile("pub fn main() -> i32 { let xs = #[1, 2, 3]; 0 }", "parse.syntax");
  await assertThrowsCompile("pub fn main(mem: memory) -> i32 { 0 }", "type.unknown_type");
  await assertThrowsCompile("fn bad(x: i32) -> i32 { @memory_load_i32(x, x) }", "primitive.unknown");
  await assertThrowsCompile("fn bad(x: i32) -> i32 { @ptr_add(x, 1) }", "primitive.unknown");
  await assertThrowsCompile("fn bad(x: i32) -> i32 { @freeze(x) }", "primitive.unknown");
});

Deno.test("allows shadowing and temporal local reuse", async () => {
  await checkSource(`
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let moved = sink(x);
      x + moved
    }
  `);
  await checkSource(`
    pub fn main() -> i32 {
      let b = a + 1;
      let a = 1;
      b
    }
  `);
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
        pub fn main() -> i32 {
          let x = 1;
          let x = x + 1;
          let x = x * 10;
          x
        }
      `),
    ),
  );
  assertEquals((instance.exports.main as () => number)(), 20);
  await checkSource(`
    pub fn main() -> i32 {
      let x = 1;
      let x = 2;
      x
    }
  `);
  await assertThrowsCompile(
    `
    fn pair() -> [i32, i32] { [1, 2] }
    pub fn main() -> i32 {
      let x, x = pair();
      x
    }
  `,
    "type.duplicate_local",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let a = b;
      let b = a;
      a
    }
  `,
    "type.local_cycle",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      x = 1;
      x
    }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let
      x = 1
      x
    }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let x = 1
      let y = 2;
      x
    }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let y = 2
      y
    }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let x = 1;
      let y, z = other(x);
      x
    }
  `,
    "type.destructure_non_multi",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let x = 1;
      let y, z = x + 1;
      x
    }
  `,
    "type.destructure_non_multi",
  );
});

Deno.test("pipe bind syntax lowers through scoped bind bodies", async () => {
  const wat = await watFromSource(`
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(a: i32, b: i32) -> i32 { a + b }
    fn mul(a: i32, b: i32) -> i32 { a * b }
    pub fn main() -> i32 {
      1 \\$ -> inc($) \\y -> add(1, y) \\z -> mul(z, 2)
    }
  `);
  assert(!wat.includes("call $inc"));
  assert(!wat.includes("call $add"));
  assert(!wat.includes("call $mul"));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(`
    fn inc(x: i32) -> i32 { x + 1 }
    fn add(a: i32, b: i32) -> i32 { a + b }
    fn mul(a: i32, b: i32) -> i32 { a * b }
    pub fn main() -> i32 {
      1 \\$ -> inc($) \\y -> add(1, y) \\z -> mul(z, 2)
    }
  `)));
  assertEquals((instance.exports.main as CallableFunction)(), 6);
  await assertThrowsCompile(
    "pub fn main() -> i32 { \\x -> x + 1 }",
    "parse.syntax",
  );
  await assertThrowsCompile(
    "fn map4_i32(const f: fn(x: i32) -> i32, xs: i32) -> i32 { xs } pub fn main() -> i32 { map4_i32(\\x -> x + 1, 1) }",
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    fn add(a: i32, b: i32) -> i32 { a + b }
    pub fn main() -> i32 { 1 |> add(1) }
  `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
    fn add(a: i32, b: i32) -> i32 { a + b }
    pub fn main() -> i32 { 1 |> add($, $) }
  `,
    "parse.syntax",
  );
});

Deno.test("pipe bind evaluates left once and binds flattened products", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
    type fn Pair() { let Pair = {left: i32, right: i32}; struct(Pair) }
    fn make_pair(x: i32) -> Pair { Pair {left: x, right: x + 1} }
    pub fn main() -> i32 {
      make_pair(4) \\p -> p.left + p.right
    }
  `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 9);
});

Deno.test("$ const function helper sugar is unary and rejects runtime captures", async () => {
  const wat = await watFromSource(`
    type fn Lane4I32() { let Lane4I32 = {4*i32}; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> Lane4I32 { map4_i32($ + 1, [1, 2, 3, 4]) }
  `);
  assert(!wat.includes("(func $__dollar"));
  assert(!wat.includes("call $__dollar"));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(`
    type fn Lane4I32() { let Lane4I32 = {4*i32}; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> Lane4I32 { map4_i32($ + 1, [1, 2, 3, 4]) }
  `)));
  assertEquals((instance.exports.main as CallableFunction)(), [2, 3, 4, 5]);
  await assertThrowsCompile(
    "pub fn main() -> i32 { $ + 1 }",
    "const.placeholder_context",
  );
  await assertThrowsCompile(
    `
    type fn Lane4I32() { let Lane4I32 = {4*i32}; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> Lane4I32 {
      let bump = 1;
      map4_i32($ + bump, [1, 2, 3, 4])
    }
  `,
    "const.placeholder_capture",
  );
  await assertFirstDiagnosticSpanIncludes(
    `
    fn needs_type(const value: type) -> i32 { 0 }
    pub fn main() -> i32 { needs_type($ + 1) }
  `,
    "const.placeholder_expected_fn",
    "$ + 1",
  );
  await assertFirstDiagnosticSpanIncludes(
    `
    type fn Lane4I32() { let Lane4I32 = {4*i32}; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> Lane4I32 {
      let bump = 1;
      map4_i32($ + bump, [1, 2, 3, 4])
    }
  `,
    "const.placeholder_capture",
    "$ + bump",
  );
});

Deno.test("product result destructuring binds local result slots", async () => {
  const wat = await watFromSource(`
    type fn Pair() { let Pair = {first: i32, second: i32}; struct(Pair) }
    fn make_pair() -> Pair { [2, 3] }
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let used = sink(x);
      let first, second = make_pair();
      x + used + first + second
    }
  `);
  assert(!wat.includes("(func $make_pair (result i32) (result i32)"));
  assertStringIncludes(wat, "(local $first i32)");
  assertStringIncludes(wat, "(local $second i32)");
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(`
    type fn Pair() { let Pair = {first: i32, second: i32}; struct(Pair) }
    fn make_pair() -> Pair { [2, 3] }
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let used = sink(x);
      let first, second = make_pair();
      x + used + first + second
    }
  `)));
  assertEquals((instance.exports.main as CallableFunction)(), 7);
  await assertThrowsCompile(
    `
    pub fn make_one() -> i32 { 1 }
    pub fn main() -> i32 {
      let a, b = make_one();
      a
    }
  `,
    "type.destructure_non_multi",
  );
  await assertThrowsCompile(
    `
    type fn Pair() { let Pair = {first: i32, second: i32}; struct(Pair) }
    fn make_pair() -> Pair { [2, 3] }
    pub fn main() -> i32 {
      let a, b, c = make_pair();
      a
    }
  `,
    "type.destructure_arity",
  );
});

Deno.test("models type contracts with explicit const dictionaries", async () => {
  const parsed = await checkSource(`
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) }
    fn requires_product(t) -> bool !{io} { @type_is_product(t) }
    type fn Eq(t: type) {
      let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool};
      match requires_product(t) {
        true => struct(Eq),
        false => @compile_error("Eq requires a product type"),
      }
    }
    type fn Functor(f: type) {
      let Functor = {map: fn(x: f) -> f};
      match @type_has_slot(f, #value) {
        true => struct(Functor),
        false => @compile_error("Functor requires value slot"),
      }
    }
    type fn Applicative(f: type) {
      let Applicative = {pure: fn(x: i32) -> f, apply: fn(f: f, x: f) -> f};
      match @type_slot_type(f, #value) {
        i32 => struct(Applicative),
        _ => @compile_error("Applicative requires i32 value"),
      }
    }
    type fn Monad(f: type) {
      let Monad = {bind: fn(x: f) -> f};
      match @type_is_product(f) {
        true => struct(Monad),
        false => @compile_error("Monad requires product"),
      }
    }
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    fn neq_point(a: Point, b: Point) -> bool { a.x != b.x }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    fn pure_box(x: i32) -> Box { {value: x} }
    fn apply_box(f: Box, x: Box) -> Box { {value: f.value + x.value} }
    fn bind_box(x: Box) -> Box { {value: x.value + 10} }
    const point_eq: Eq(Point) = {eql: eql_point, neq: neq_point};
    const box_functor: Functor(Box) = {map: map_box};
    const box_applicative: Applicative(Box) = {pure: pure_box, apply: apply_box};
    const box_monad: Monad(Box) = {bind: bind_box};
    fn same(dict: Eq(Point), a: Point, b: Point) -> i32 {
      match dict.eql(a, b) { true => 1, false => 0 }
    }
    fn mapped(dict: Functor(Box), x: Box) -> i32 { dict.map(x).value }
    fn applied(dict: Applicative(Box), x: i32) -> i32 { dict.apply(dict.pure(x), {value: 2}).value }
    fn bound(dict: Monad(Box), x: Box) -> i32 { dict.bind(x).value }
    pub fn main() -> i32 {
      same(point_eq, Point {x: 1, y: 2}, Point {x: 1, y: 2})
        + mapped(box_functor, {value: 1})
        + applied(box_applicative, 2)
        + bound(box_monad, {value: 3})
    }
  `);
  const eq = parsed.program.declarations.find((decl) => decl.kind === "type" && decl.name === "Eq");
  assertEquals(
    eq?.kind === "type" ? eq.normalized : undefined,
    {
      kind: "alias",
      type:
        'match requires_product(t) { true => struct(Eq), false => @compile_error("Eq requires a product type") }',
    },
  );
  await checkSource(`
    type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn HasSome(t: type) {
      let HasSome = {ok: i32};
      match @type_has_variant(t, #Some) == @type_variant_has_slot(t, #Some, #value) {
        true => struct(HasSome),
        false => @compile_error("expected Some value"),
      }
    }
    fn ok() -> i32 { 1 }
    const dict: HasSome(Option(i32)) = {ok: ok};
  `);
  await checkSource(`
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Eq(t: type) { let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool}; struct(Eq) }
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    fn neq_point(a: Point, b: Point) -> bool { a.x != b.x }
    const point_eq: Eq(Point) = {eql: eql_point, neq: neq_point};
    pub fn main() -> i32 { same(1) }
  `);
  await assertThrowsCompile(
    "fn map_array(x: i32) -> i32 { x } const bad = {map: map_array};",
    "type.const_annotation",
  );
  await assertThrowsCompile(
    "fn map_array(x: i32) -> i32 { x } const bad: i32 = map_array;",
    "type.const_shape",
  );
  await assertThrowsCompile(
    `
    type fn Eq(t: type) { let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool}; struct(Eq) }
    const bad: Eq(Point) = {};
  `,
    "type.const_missing_slot",
  );
  await assertThrowsCompile(
    `
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Eq(t: type) { let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool}; struct(Eq) }
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    fn neq_point(a: Point, b: Point) -> bool { a.x != b.x }
    const bad: Eq(Point) = {eql: eql_point, neq: neq_point, other: eql_point};
  `,
    "type.const_unknown_slot",
  );
  await assertThrowsCompile(
    `
    type fn Id() { i32 }
    fn map_array(x: i32) -> i32 { x }
    const bad: Id = {map: map_array};
  `,
    "type.const_dictionary_type",
  );
  await assertThrowsCompile(
    `
    fn map_array(x: i32) -> i32 { x }
    const bad: i32 = {map: map_array(1)};
  `,
    "type.const_slot_function",
  );
  await assertThrowsCompile(
    `
    const bad: i32 = {map: missing};
  `,
    "type.unknown_const_function",
  );
  await assertThrowsCompile(
    `
    fn map_array(x: i32) -> i32 { x }
    const bad: i32 = {map: map_array, map: map_array};
  `,
    "type.duplicate_const_slot",
  );
  await assertThrowsCompile(
    `
    type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn Eq(t: type) {
      let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool};
      match @type_is_product(t) {
        true => struct(Eq),
        false => @compile_error("Eq requires a product type"),
      }
    }
    fn eql_i32(a: i32, b: i32) -> bool { a == b }
    fn neq_i32(a: i32, b: i32) -> bool { a != b }
    const bad: Eq(Option(i32)) = {eql: eql_i32, neq: neq_i32};
  `,
    "type.compile_error",
  );
  await assertThrowsCompile(
    `
    type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) }
    type fn Eq(t: type) {
      let Eq = {eql: fn(a: t, b: t) -> bool, neq: fn(a: t, b: t) -> bool};
      match @type_is_product(t) {
        true => struct(Eq),
        false => @compile_error("Eq requires a product type"),
      }
    }
    fn Bad(dict: Eq(Option(i32))) -> i32 { 0 }
  `,
    "type.compile_error",
  );
  await assertThrowsCompile(
    `
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) {
      let Functor = {map: fn(x: f) -> f};
      match @type_slot_type(f, #missing) {
        i32 => struct(Functor),
        _ => struct(Functor),
      }
    }
    fn map_box(x: Box) -> Box { {value: x.value} }
    const bad: Functor(Point) = {map: map_box};
  `,
    "type.unknown_type_slot",
  );
});

Deno.test("models attached type members for static contracts", async () => {
  const checked = await checkSource(`
    fn eql_point(a: Point, b: Point) -> bool { a.x == b.x }
    type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
    fn Point.eql(a: Point, b: Point) -> bool { eql_point(a, b) }
    type fn Eq(t: type) {
      let Expected = fn(a: t, b: t) -> bool;
      @require(@type_has_member(t, #eql), "Eq requires eql");
      @require(@type_member_type(t, #eql) == Expected, "Eq.eql has wrong type");
    }
    fn same(proof: Eq(Point), x: Point, y: Point) -> bool { Point.eql(x, y) }
  `);
  const point = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "Point"
  );
  assertEquals(point?.normalized?.kind === "product" ? point.normalized.shape.slots : undefined, [
    { label: "x", type: "i32" },
    { label: "y", type: "i32" },
  ]);
  const same = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "same"
  );
  assertEquals(same?.body.expr, {
    kind: "call",
    callee: { kind: "var", name: "Point.eql" },
    args: [{ kind: "var", name: "x" }, { kind: "var", name: "y" }],
  });
});

Deno.test("reports attached type member contract failures", async () => {
  await assertThrowsCompile(
    `
      type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
      type fn Eq(t: type) {
        @require(@type_has_member(t, #eql), "Eq requires eql");
      }
      fn same(proof: Eq(Point)) -> bool { true }
    `,
    "type.require",
  );
  await assertThrowsCompile(
    `
      fn eql_point(a: Point) -> bool { true }
      type fn Point() { let Point = {x: i32}; struct(Point) }
      fn Point.eql(a: Point) -> bool { eql_point(a) }
      type fn Eq(t: type) {
        let Expected = fn(a: t, b: t) -> bool;
        @require(@type_member_type(t, #eql) == Expected, "Eq.eql has wrong type");
      }
      fn same(proof: Eq(Point)) -> bool { true }
    `,
    "type.require",
  );
});

Deno.test("reports compile-time contract failures on caller spans", async () => {
  await assertFirstDiagnosticSpanIncludes(
    `
      type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
      type fn Eq(t: type) {
        @require(@type_has_member(t, #eql), "Eq requires eql");
      }
      fn same(proof: Eq(Point)) -> bool { true }
    `,
    "type.require",
    "proof: Eq(Point)",
  );

  await assertFirstDiagnosticSpanIncludes(
    `
      type fn Empty(a: type) -> type {
        let Empty = {value: a};
        struct(Empty)
      }
      type fn Functor(t: type fn(a: type) -> type) -> type {
        @require(@type_has_member(t, #map), "Functor requires map");
        t
      }
      fn inc(x: i32) -> i32 { x + 1 }
      fn mapper(v: t(a), const f: fn(x: a) -> b) -> t(b) {
        const mapper = Functor(t);
        v
      }
      pub fn main() -> Empty(i32) { mapper(Empty {value: 1}, inc) }
    `,
    "type.require",
    "mapper(Empty {value: 1}, inc",
  );

  await assertFirstDiagnosticSpanIncludes(
    `
      type fn Option(a: type) { let None = {}; let Some = {value: a}; union(None, Some) }
      type fn Eq(t: type) {
        match @type_is_product(t) {
          true => t,
          false => @compile_error("Eq requires product"),
        }
      }
      const bad: Eq(Option(i32)) = {};
    `,
    "type.compile_error",
    "const bad: Eq(Option(i32))",
  );
});

Deno.test("specializes functor constraints over type constructors", async () => {
  const parsed = await parse(`
    type fn Box(a: type) -> type { let Box = {value: a}; struct(Box) }
    fn Box.map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }
  `);
  const parsedMap = parsed.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "Box.map"
  );
  assertEquals(parsedMap?.body.expr?.kind, "product_constructor");

  const checked = await checkSource(`
    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }
    fn Box.map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }
    type fn Functor(t: type fn(a: type) -> type) -> type {
      let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
      @require(@type_has_member(t, #map), "Functor requires map");
      @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
      t
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn mapper(v: t(a), const f: fn(x: a) -> b, const _proof: Functor(t)) -> t(b) {
      t.map(f, v)
    }
    pub fn main() -> Box(i32) { mapper(Box {value: 1}, inc, Functor(Box)) }
  `);
  const boxMap = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("Box_map__")
  );
  assertEquals(boxMap?.body.expr?.kind, "shape");
  const mapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("mapper__")
  );
  assertEquals(mapper?.params, [{ name: "v", type: "Box(i32)", const: undefined }]);
  assertEquals(mapper?.returnType, "Box(i32)");
  assertEquals(
    mapper?.body.expr?.kind === "call" ? mapper.body.expr.callee : undefined,
    { kind: "var", name: "Box_map__i32__i32__inc" },
  );

  await assertThrowsCompile(
    `
      type fn Empty(a: type) -> type { let Empty = {value: a}; struct(Empty) }
      type fn Functor(t: type fn(a: type) -> type) -> type {
        let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
        @require(@type_has_member(t, #map), "Functor requires map");
        @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
        t
      }
      fn Bad(const _proof: Functor(Empty)) -> i32 { 0 }
    `,
    "type.require",
  );
  await assertThrowsCompile(
    `
      type fn BadBox(a: type) -> type {
        let BadBox = {value: a};
        struct(BadBox)
      }
      fn BadBox.map(v: BadBox(a)) -> BadBox(a) { v }
      type fn Functor(t: type fn(a: type) -> type) -> type {
        let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
        @require(@type_has_member(t, #map), "Functor requires map");
        @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
        t
      }
      fn Bad(const _proof: Functor(BadBox)) -> i32 { 0 }
    `,
    "type.require",
  );
  await assertThrowsCompile(
    `
      type fn Concrete() { let Concrete = {value: i32}; struct(Concrete) }
      type fn Functor(t: type fn(a: type) -> type) -> type { t }
      fn Bad(const _proof: Functor(Concrete)) -> i32 { 0 }
    `,
    "type.param_kind",
  );
  await checkSource(`
    type fn Box(a: type) -> struct { let Box = {value: a}; struct(Box) }
    type fn Functor(t: type fn(a: type) -> struct) -> type { t }
    fn ok(const _proof: Functor(Box)) -> i32 { 0 }
  `);
  await checkSource(`
    type fn Box(a: type) -> struct { let Box = {value: a}; struct(Box) }
    type fn Broad(t: type fn(a: type) -> type) -> type { t }
    fn ok(const _proof: Broad(Box)) -> i32 { 0 }
  `);
  await assertThrowsCompile(
    `
      type fn Option(a: type) -> union { let None = {}; let Some = {value: a}; union(None, Some) }
      type fn Functor(t: type fn(a: type) -> struct) -> type { t }
      fn Bad(const _proof: Functor(Option)) -> i32 { 0 }
    `,
    "type.param_kind",
  );
});

Deno.test("attaches qualified type member functions", async () => {
  const checked = await checkSource(`
    type fn Box(a: type) -> type { let Box = {value: a}; struct(Box) }
    fn Box.map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }
    type fn Functor(t: type fn(a: type) -> type) -> type {
      let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
      @require(@type_has_member(t, #map), "Functor requires map");
      @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
      t
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn mapper(v: t(a), const f: fn(x: a) -> b, const _proof: Functor(t)) -> t(b) {
      t.map(f, v)
    }
    pub fn main() -> Box(i32) { mapper(Box {value: 1}, inc, Functor(Box)) }
  `);
  const box = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "Box"
  );
  assertEquals(
    box?.normalized?.kind === "product" ? box.normalized.members : undefined,
    [{ name: "map", type: "fn(const f: fn(x: a) -> b, v: Box(a)) -> Box(b)", target: "Box.map" }],
  );
  const mapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("mapper__")
  );
  assertEquals(
    mapper?.body.expr?.kind === "call" ? mapper.body.expr.callee : undefined,
    { kind: "var", name: "Box_map__i32__i32__inc" },
  );
  await assertThrowsCompile(
    `
      fn missing.map() -> i32 { 0 }
    `,
    "type.unknown_type",
  );
  await assertThrowsCompile(
    `
      type fn Box(a: type) -> type { let Box = {value: a}; struct(Box) }
      fn Box.map(v: Box(a)) -> Box(a) { v }
      fn Box.map(v: Box(a)) -> Box(a) { v }
    `,
    "type.duplicate_member",
  );
});

Deno.test("infers local proof consts at generic call sites", async () => {
  const checked = await checkSource(`
    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }
    fn Box.map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
      Box {value: f(v.value)}
    }
    type fn Functor(t: type fn(a: type) -> type) -> type {
      let Expected = fn(const f: fn(x: a) -> b, v: t(a)) -> t(b);
      @require(@type_has_member(t, #map), "Functor requires map");
      @require(@type_member_type(t, #map) == Expected, "Functor.map has wrong type");
      t
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn mapper(v: t(a), const f: fn(x: a) -> b) -> t(b) {
      const mapper = Functor(t);
      mapper.map(f, v)
    }
    pub fn main() -> Box(i32) {
      mapper(Box {value: 1}, inc)
    }
  `);
  const mapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("mapper__")
  );
  assertEquals(mapper?.params, [{ name: "v", type: "Box(i32)", const: undefined }]);
  assertEquals(mapper?.returnType, "Box(i32)");
  assertEquals(mapper?.body.statements, []);
  assertEquals(
    mapper?.body.expr?.kind === "call" ? mapper.body.expr.callee : undefined,
    { kind: "var", name: "Box_map__i32__i32__inc" },
  );

  await assertThrowsCompile(
    `
      type fn Empty(a: type) -> type {
        let Empty = {value: a};
        struct(Empty)
      }
      type fn Functor(t: type fn(a: type) -> type) -> type {
        @require(@type_has_member(t, #map), "Functor requires map");
        t
      }
      fn inc(x: i32) -> i32 { x + 1 }
      fn mapper(v: t(a), const f: fn(x: a) -> b) -> t(b) {
        const mapper = Functor(t);
        v
      }
      pub fn main() -> Empty(i32) { mapper(Empty {value: 1}, inc) }
    `,
    "type.require",
  );

  await assertThrowsCompile(
    `
      type fn Box(a: type) -> type {
        let Box = {value: a};
        struct(Box)
      }
      fn Bad(v: t(a)) -> t(a) {
        const Mapper = t;
        v
      }
      pub fn main() -> Box(i32) { Bad(Box {value: 1}) }
    `,
    "parse.syntax",
  );
});

Deno.test("rejects duplicate type function fragments and members", async () => {
  await assertThrowsCompile(
    `
      type fn Box(a: type) -> type { let Box = {value: a}; struct(Box) }
      type fn Box(a: type) -> type { let Box = {other: a}; struct(Box) }
    `,
    "type.duplicate_runtime_fragment",
  );
  await assertThrowsCompile(
    `
      type fn Box(a: type) -> type {
        let Box = {value: a};
        struct(Box)
      }
      fn Box.map(v: Box(a)) -> Box(a) { v }
      fn Box.map(v: Box(a)) -> Box(a) { v }
    `,
    "type.duplicate_member",
  );
});

Deno.test("specializes const parameters at call sites", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box {
      let a = mapped(box_functor, {value: 1});
      mapped(box_functor, a)
    }
  `);
  const mapped = findFn(checked.program, "mapped");
  assertEquals(mapped?.kind === "fn" ? mapped.params[0].const : undefined, true);
  const specialized = checked.program.declarations.filter((decl) =>
    decl.kind === "fn" && decl.name === "mapped__box_functor"
  );
  assertEquals(specialized.length, 1);
  assertEquals(specialized[0].kind === "fn" ? specialized[0].params : undefined, [
    { name: "x", type: "Box", const: undefined },
  ]);
  assertEquals(
    specialized[0].kind === "fn" && specialized[0].body.expr?.kind === "call"
      ? specialized[0].body.expr.callee
      : undefined,
    { kind: "var", name: "map_box" },
  );
  const main = findFn(checked.program, "main");
  const expr = main?.kind === "fn" ? main.body.expr : undefined;
  assertEquals(expr?.kind, "call");
  assertEquals(expr?.kind === "call" ? expr.callee : undefined, {
    kind: "var",
    name: "mapped__box_functor",
  });

  await assertThrowsCompile(
    `
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    fn Bad(dict: Functor(Box), x: Box) -> Box { mapped(dict, x) }
  `,
    "const.static_param_arg",
  );
  await assertFirstDiagnosticSpanIncludes(
    `
    fn needs_type(const value: type, x: i32) -> i32 { x }
    fn Bad(runtime_dict: i32) -> i32 { needs_type(runtime_dict, 1) }
  `,
    "const.static_param_arg",
    "runtime_dict",
  );
});

Deno.test("infers unannotated const parameter static kinds", async () => {
  const checked = await checkSource(`
    type fn Transform2d() -> type { let Transform2d = {x: i32}; struct(Transform2d) }
    type fn ComponentValues(selected: const) -> type {
      let Values = @shape_map(selected, ComponentValue);
      struct(Values)
    }
    type fn ComponentValue(component: const) -> type { component }
    fn first_value(const selected, values: ComponentValues(selected)) -> i32 {
      values.transform.x
    }
    const movement_reads = {transform: Transform2d};
    pub fn main(values: ComponentValues(movement_reads)) -> i32 {
      first_value(movement_reads, values)
    }
  `);
  const source = findFn(checked.program, "first_value");
  assertEquals(source?.kind === "fn" ? source.params[0]?.inferStaticType : undefined, true);
  const specialized = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name === "first_value__movement_reads"
  );
  assertEquals(specialized?.kind === "fn" ? specialized.params : undefined, [
    { name: "values", type: "ComponentValues(movement_reads)", const: undefined },
  ]);
});

Deno.test("unannotated const type proofs specialize as types", async () => {
  const checked = await checkSource(`
    fn keep(const t, value: t) -> t { value }
    pub fn main() -> i32 { keep(i32, 7) }
  `);
  const specialized = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name.startsWith("keep__i32")
  );
  assertEquals(specialized?.kind === "fn" ? specialized.returnType : undefined, "i32");
  assertEquals(specialized?.kind === "fn" ? specialized.params[0]?.type : undefined, "i32");
});

Deno.test("infers type parameters through temporal runtime arguments", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Events() { let Events = {delta: i32}; struct(Events) }
    fn bump(world: Box, events: Events) -> Box {
      {value: world.value + events.delta}
    }
    fn run(
      world: w,
      events: e,
      const system: fn(world: w, events: e) -> w
    ) -> w {
      system(world, events)
    }
    pub fn main() -> Box {
      let world = Box {value: 1};
      let events = Events {delta: 2};
      run(world, events, bump)
    }
  `);
  const specialized = checked.program.declarations.find((decl) =>
    decl.kind === "fn" && decl.name === "run__Box__Events__bump"
  );
  assertEquals(specialized?.kind === "fn" ? specialized.params : undefined, [
    { name: "world", type: "Box", const: undefined },
    { name: "events", type: "Events", const: undefined },
  ]);
});

Deno.test("memoizes distinct const parameter specializations", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    fn map_box_alt(x: Box) -> Box { {value: x.value + 2} }
    const box_functor: Functor(Box) = {map: map_box};
    const alt_functor: Functor(Box) = {map: map_box_alt};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box {
      let a = mapped(box_functor, {value: 1});
      mapped(alt_functor, a)
    }
  `);
  const generated = checked.program.declarations.filter((decl) =>
    decl.kind === "fn" && decl.name.startsWith("mapped__")
  ).map((decl) => decl.name).sort();
  assertEquals(generated, ["mapped__alt_functor", "mapped__box_functor"]);
});

Deno.test("names specializations with multiple const parameters", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    fn map_box_alt(x: Box) -> Box { {value: x.value + 2} }
    const box_functor: Functor(Box) = {map: map_box};
    const alt_functor: Functor(Box) = {map: map_box_alt};
    fn mapped_twice(const first: Functor(Box), const second: Functor(Box), x: Box) -> Box {
      second.map(first.map(x))
    }
    pub fn main() -> Box { mapped_twice(box_functor, alt_functor, {value: 1}) }
  `);
  const specialized = findFn(checked.program, "mapped_twice__box_functor__alt_functor");
  assertEquals(specialized?.kind === "fn" ? specialized.params : undefined, [
    { name: "x", type: "Box", const: undefined },
  ]);
  assert(specialized?.kind === "fn" && specialized.generated);
});

Deno.test("reuses nested const-specialized calls", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    fn mapped_outer(const dict: Functor(Box), x: Box) -> Box { mapped(dict, x) }
    pub fn main() -> Box {
      let a = mapped_outer(box_functor, {value: 1});
      mapped_outer(box_functor, a)
    }
  `);
  assertEquals(
    checked.program.declarations.filter((decl) =>
      decl.kind === "fn" && decl.name === "mapped_outer__box_functor"
    ).length,
    1,
  );
  assertEquals(
    checked.program.declarations.filter((decl) =>
      decl.kind === "fn" && decl.name === "mapped__box_functor"
    ).length,
    1,
  );
  const outer = findFn(checked.program, "mapped_outer__box_functor");
  assertEquals(
    outer?.kind === "fn" && outer.body.expr?.kind === "call" ? outer.body.expr.callee : undefined,
    { kind: "var", name: "mapped__box_functor" },
  );
});

Deno.test("optimizes const-parameter forwarding wrappers to direct calls", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box { mapped(box_functor, {value: 1}) }
  `);

  assertEquals(findFns(checked.program, "mapped__box_functor").length, 1);
  const checkedMain = findFn(checked.program, "main");
  assertEquals(
    checkedMain?.body.expr?.kind === "call" ? checkedMain.body.expr.callee : undefined,
    { kind: "var", name: "mapped__box_functor" },
  );

  const optimized = optimizeProgram(checked.program);
  const counts = countCalls(optimized, { includeGenerated: false });
  assertEquals(counts.get("mapped__box_functor") ?? 0, 0);
  assertEquals(counts.get("map_box") ?? 0, 0);
});

Deno.test("optimizes repeated forwarding wrapper call sites", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box {
      let a = mapped(box_functor, {value: 1});
      let b = mapped(box_functor, a);
      mapped(box_functor, b)
    }
  `);

  assertEquals(findFns(checked.program, "mapped__box_functor").length, 1);
  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("mapped__box_functor") ?? 0, 0);
  assertEquals(counts.get("map_box") ?? 0, 2);
});

Deno.test("optimizes nested forwarding specializations transitively", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    fn mapped_outer(const dict: Functor(Box), x: Box) -> Box { mapped(dict, x) }
    pub fn main() -> Box { mapped_outer(box_functor, {value: 1}) }
  `);

  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("mapped_outer__box_functor") ?? 0, 0);
  assertEquals(counts.get("mapped__box_functor") ?? 0, 0);
  assertEquals(counts.get("map_box") ?? 0, 0);
});

Deno.test("inlines small product-return generated specializations at full-return sites", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box {
      let y = dict.map(x);
      dict.map(y)
    }
    pub fn main() -> Box { mapped(box_functor, {value: 1}) }
  `);

  const counts = countCalls(optimizeProgram(checked.program));
  assertEquals(counts.get("mapped__box_functor") ?? 0, 0);
});

Deno.test("optimizes specialization calls by resolved generated name", async () => {
  const checked = await checkSource(`
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped__box_functor(x: Box) -> Box { x }
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box { mapped(box_functor, {value: 1}) }
  `);

  assertEquals(findFns(checked.program, "mapped__box_functor").length, 1);
  assertEquals(findFns(checked.program, "mapped__box_functor__2").length, 1);
  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("mapped__box_functor__2") ?? 0, 0);
  assertEquals(counts.get("map_box") ?? 0, 0);
});

Deno.test("optimizes tiny private pure helpers by inlining", async () => {
  const checked = await checkSource(`
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { inc(41) }
  `);
  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("inc") ?? 0, 0);
});

Deno.test("does not inline large private helpers above the cost budget", async () => {
  const checked = await checkSource(`
    fn many(x: i32) -> i32 {
      let a = x + 1;
      let b = a + 1;
      let c = b + 1;
      let d = c + 1;
      let e = d + 1;
      let f = e + 1;
      let g = f + 1;
      let h = g + 1;
      h + 1
    }
    pub fn main() -> i32 { many(1) }
  `);
  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("many") ?? 0, 1);
});

Deno.test("does not inline recursive or effectful helpers", async () => {
  const checked = await checkSource(`
    const clock: fn() -> i32 !{time} = @capability("clock");
    fn tick() -> i32 !{time} { clock() }
    fn count(n: i32) -> i32 { match n { 0 => 0, _ => count(n - 1) } }
    pub fn main() -> i32 !{time} { tick() + count(2) }
  `);
  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("tick") ?? 0, 1);
  assertEquals(counts.get("count") ?? 0, 2);
});

Deno.test("inlining preserves shadowed local bindings", async () => {
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(`
        fn helper(x: i32) -> i32 {
          let x = 2;
          x
        }
        pub fn main() -> i32 { helper(40) }
      `),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 2);
});

Deno.test("product helpers do not inline into nested value arguments", async () => {
  const checked = await checkSource(`
    type fn Pair() { let Pair = {left: i32, right: i32}; struct(Pair) }
    fn make_pair() -> Pair { Pair {left: 1, right: 2} }
    fn sum(pair: Pair) -> i32 { pair.left + pair.right }
    pub fn main() -> i32 { sum(make_pair()) }
  `);
  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("make_pair") ?? 0, 1);
});

Deno.test("emits deterministic WAT and valid wasm32", async () => {
  const source = `pub fn main() -> i32 { 40 + 2 }`;
  assertEquals(
    await watFromSource(source),
    `(module
  (func $main (export "main") (result i32)
    i32.const 42
  )
)`,
  );
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as () => number)(), 42);
});

Deno.test("defaults unsuffixed integer literals in i32 contexts", async () => {
  const returned = await checkSource("pub fn main() -> i32 { 40 + 2 }");
  const main = returned.program.declarations.find((decl) => decl.kind === "fn");
  assertEquals(
    main?.kind === "fn" && main.body.expr?.kind === "binary" &&
      main.body.expr.left.kind === "literal"
      ? main.body.expr.left.inferredType
      : undefined,
    "i32",
  );

  const annotated = await checkSource("pub fn main() -> i32 { let x: i32 = 40; x }");
  const annotatedMain = annotated.program.declarations.find((decl) => decl.kind === "fn");
  assertEquals(
    annotatedMain?.kind === "fn" &&
      annotatedMain.body.statements[0]?.kind === "let" &&
      annotatedMain.body.statements[0].value.kind === "literal"
      ? annotatedMain.body.statements[0].value.inferredType
      : undefined,
    "i32",
  );

  await checkSource("pub fn main() -> i32 { 40i32 }");
});

Deno.test("checks bounded inline array indexing", async () => {
  const header = `
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Lane4I32() -> type { InlineArray(4, i32) }
    type fn Lane8I32() -> type { InlineArray(8, i32) }
    type fn Lane8Alias() -> type { Lane8I32 }
    type fn Option(a: type) -> union {
      let None = {};
      let Some = {value: a};
      union(None, Some)
    }
    fn get(xs: Lane4I32, i: i32) -> Option(i32) { 0 }
  `;
  await checkSource(`${header} fn ok(xs: Lane4I32) -> i32 { xs[0] }`);
  await assertThrowsCompile(
    `${header} fn Bad(xs: Lane4I32) -> i32 { xs[4] }`,
    "index.out_of_bounds",
  );
  await checkSource(`${header} fn ok(xs: Lane4I32, i: Index(4)) -> i32 { xs[i] }`);
  await checkSource(`${header} fn ok(xs: Lane8Alias, i: Index(8)) -> i32 { xs[i] }`);
  await checkSource(`${header} fn checked(xs: Lane4I32, i: i32) -> Option(i32) { get(xs, i) }`);
  await checkSource(`${header} fn runtime(xs: Lane4I32, i: i32) -> i32 { xs[i] }`);
  await assertThrowsCompile(
    `${header} fn Bad(xs: Lane8Alias, i: Index(4)) -> i32 { xs[i] }`,
    "index.requires_proof",
  );
});

Deno.test("supports arbitrary unsigned integer widths with storage-lane packing", async () => {
  await checkSource(`
    pub fn one(x: u1) -> u1 { x }
    pub fn seven(x: u7) -> u7 { x }
    pub fn eight(x: u8) -> u8 { x }
    pub fn sixteen(x: u16) -> u16 { x }
    pub fn thirty_one(x: u31) -> u31 { x }
    pub fn thirty_two(x: u32) -> u32 { x }
    pub fn sixty_four(x: u64) -> u64 { x }
  `);

  await assertThrowsCompile("pub fn Bad(x: u0) -> u0 { x }", "type.unknown_type");
  await assertThrowsCompile("pub fn Bad(x: u65) -> u65 { x }", "type.unknown_type");

  const packedByte = await watFromSource(`
    type fn Pair() { let Pair = {a: u1, b: u7}; struct(Pair) }
    pub fn main(p: Pair) -> u7 { p.b }
  `);
  assertStringIncludes(packedByte, `(param $p$a$b i32)`);
  assertStringIncludes(packedByte, `i32.shr_u`);
  assertStringIncludes(packedByte, `i32.const 127`);
  assertStringIncludes(packedByte, `i32.and`);

  const packedNibbles = await watFromSource(`
    type fn Pair() { let Pair = {a: u4, b: u4}; struct(Pair) }
    pub fn main(p: Pair) -> Pair { p }
  `);
  assertStringIncludes(packedNibbles, `(param $p$a$b i32)`);
  assertStringIncludes(packedNibbles, `(result i32)`);

  const separateByteLanes = await watFromSource(`
    type fn Pair() { let Pair = {a: u7, b: u7}; struct(Pair) }
    pub fn main(p: Pair) -> Pair { p }
  `);
  assertStringIncludes(separateByteLanes, `(param $p$a i32) (param $p$b i32)`);
  assertStringIncludes(separateByteLanes, `(result i32) (result i32)`);

  const arrayLanes = await watFromSource(`
    type fn Lane4U7() -> type { let Lane = {4*u7}; struct(Lane) }
    pub fn main(xs: Lane4U7) -> Lane4U7 { xs }
  `);
  assertStringIncludes(
    arrayLanes,
    `(param $xs$0 i32) (param $xs$1 i32) (param $xs$2 i32) (param $xs$3 i32)`,
  );
  assertStringIncludes(arrayLanes, `(result i32) (result i32) (result i32) (result i32)`);

  const publicAbi = await watFromSource(`pub fn main(x: u7, y: u64) -> u7 { x }`);
  assertStringIncludes(publicAbi, `(param $x i32) (param $y i64) (result i32)`);
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

function findFn(program: Program, name: string): FnDecl | undefined {
  return program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === name
  );
}

function findFns(program: Program, name: string): FnDecl[] {
  return program.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === name
  );
}

function countCalls(
  program: Program,
  options: { includeGenerated?: boolean } = {},
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      if (options.includeGenerated === false && decl.generated) continue;
      countExprCalls(decl.body, counts);
    } else if (decl.kind === "let" || decl.kind === "const") countExprCalls(decl.value, counts);
  }
  return counts;
}

function countExprCalls(expr: Expr, counts: Map<string, number>) {
  switch (expr.kind) {
    case "call":
      if (expr.callee.kind === "var") {
        counts.set(expr.callee.name, (counts.get(expr.callee.name) ?? 0) + 1);
      }
      countExprCalls(expr.callee, counts);
      for (const arg of expr.args) countExprCalls(arg, counts);
      return;
    case "index":
      countExprCalls(expr.target, counts);
      countExprCalls(expr.index, counts);
      return;
    case "binary":
      countExprCalls(expr.left, counts);
      countExprCalls(expr.right, counts);
      return;
    case "match":
      countExprCalls(expr.value, counts);
      for (const arm of expr.arms) countExprCalls(arm.value, counts);
      return;
    case "shape":
      for (const slot of expr.slots) countExprCalls(slot.value, counts);
      return;
    case "range":
      countExprCalls(expr.start, counts);
      countExprCalls(expr.end, counts);
      return;
    case "block":
      for (const stmt of expr.statements) {
        if (stmt.kind === "let") countExprCalls(stmt.value, counts);
      }
      if (expr.expr) countExprCalls(expr.expr, counts);
      return;
    case "literal":
    case "var":
    case "placeholder":
      return;
  }
}
