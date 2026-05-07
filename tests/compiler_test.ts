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

Deno.test("grammar metadata uses fig identity", async () => {
  const metadata = JSON.parse(await Deno.readTextFile("baba.json"));
  assertEquals(metadata.language.scope, "source.fig");
  assertEquals(metadata.language.fileTypes, ["fig"]);

  const packageJson = JSON.parse(await Deno.readTextFile("generated/baba-workbench/package.json"));
  assertEquals(packageJson.name, "tree-sitter-fig");
  assertEquals(packageJson["tree-sitter"][0].scope, "source.fig");
  assertEquals(packageJson["tree-sitter"][0]["file-types"], ["fig"]);
});

Deno.test("parses language surface declarations and literals", async () => {
  const program = await parse(`
    const clock: fn() -> i64 !{time} = @capability("clock");
    type fn id() { i32 }
    type fn point() { let Point = [x: i32, y: i32]; struct(Point) }
    type fn maybe(A: type) { let Nothing = []; let Some = [value: A]; union(Nothing, Some) }
    type fn buffer(N: count) { let Buffer = [N*i32]; struct(Buffer) }
    type fn weird() { let Weird = [fst: i32, 4*i32, 1*i32]; struct(Weird) }
    type fn eq(T: type) { let Eq = [eql: fn(a: T, b: T) -> bool, neq: fn(a: T, b: T) -> bool]; struct(Eq) }
    fn eql_point(a: point, b: point) -> bool { a.x == b.x }
    fn neq_point(a: point, b: point) -> bool { a.x != b.x }
    const point_eq: eq(point) = [eql: eql_point, neq: neq_point]
    pub fn main() -> i32 !{} {
      let xs: [3*i32] = [1, 2, 3];
      let point: point = Point [x: 1, y: 2];
      let label = \`\`\`hello
world\`\`\`;
      match 1 { _ => 2, }
    }
  `);
  assertEquals(program.moduleName, undefined);
  assertEquals(program.imports[0].effects, ["time"]);
  assert(program.declarations.length >= 5);
});

Deno.test("accepts const declarations without trailing semicolons", async () => {
  const checked = await checkSource(`
    type fn point() { let Point = [x: i32, y: i32]; struct(Point) }
    type fn eq(T: type) { let Eq = [eql: fn(a: T, b: T) -> bool, neq: fn(a: T, b: T) -> bool]; struct(Eq) }
    fn eql_point(a: point, b: point) -> bool { a.x == b.x }
    fn neq_point(a: point, b: point) -> bool { a.x != b.x }
    const point_eq: eq(point) = [eql: eql_point, neq: neq_point]
    const point_eq_again: eq(point) = [eql: eql_point, neq: neq_point]
  `);
  assertEquals(
    checked.program.declarations.filter((decl) => decl.kind === "const").length,
    2,
  );
});

Deno.test("normalizes type function declarations", async () => {
  const checked = await checkSource(`
    type fn id() { i32 }
    type fn point() { let Point = [x: i32, y: i32]; struct(Point) }
    type fn maybe(A: type) { let Nothing = []; let Some = [value: A]; union(Nothing, Some) }
    type fn weird() { let Weird = [fst: i32, 4*i32, 1*i32]; struct(Weird) }
    type fn why(A: count) { let Why = [fst: i32, A*i32]; struct(Why) }
  `);
  const program = checked.program;
  assertEquals(program.declarations[0], {
    kind: "type",
    name: "id",
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
      name: "point",
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
        { name: "Some", shape: { slots: [{ label: "value", type: "A" }] } },
      ],
    },
  );
  assertEquals(
    program.declarations[3].kind === "type" ? program.declarations[3].normalized : undefined,
    {
      kind: "product",
      name: "weird",
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
      A: "count",
    },
  );
});

Deno.test("checks type function result kinds", async () => {
  await checkSource(`
    type fn point() -> struct { let Point = [x: i32]; struct(Point) }
    type fn option(A: type) -> union { let None = []; let Some = [value: A]; union(None, Some) }
    type fn id() -> type { i32 }
  `);
  await assertThrowsCompile(
    "type fn bad() -> struct { i32 }",
    "type.result_kind",
  );
  await assertThrowsCompile(
    "type fn bad() -> struct { let None = []; union(None) }",
    "type.result_kind",
  );
  await assertThrowsCompile(
    "type fn bad() -> union { let Point = [x: i32]; struct(Point) }",
    "type.result_kind",
  );
  await assertThrowsCompile(
    `
      type fn choose(i32: type) -> struct { let Box = [value: i32]; struct(Box) }
      type fn choose(bool: type) -> union { let None = []; union(None) }
    `,
    "type.clause_result_kind",
  );
  await assertThrowsCompile(
    "fn main() -> struct { 1 }",
    "parse.syntax",
  );
});

Deno.test("parses type function examples", async () => {
  const program = await parse(`
    type fn point() { let Point = [x: i32, y: i32]; struct(Point) }
    type fn maybe(A: type) { let Nothing = []; let Some = [value: A]; union(Nothing, Some) }
    type fn why(A: count) { let Why = [fst: i32, A*i32]; struct(Why) }
  `);
  assertEquals(program.declarations.map((decl) => decl.kind === "type" ? decl.name : ""), [
    "point",
    "maybe",
    "why",
  ]);
});

Deno.test("checks product constructor expressions", async () => {
  await checkSource(`
    type fn box() { let Box = [value: i32]; struct(Box) }
    fn make(x: i32) -> box { Box [value: x] }
    pub fn main() -> i32 { make(1).value }
  `);
  await assertThrowsCompile(
    `
    type fn box() { let Box = [value: i32]; struct(Box) }
    fn make(x: i32) -> box { Box [] }
  `,
    "type.constructor_missing_slot",
  );
  await assertThrowsCompile(
    `
    type fn box() { let Box = [value: i32]; struct(Box) }
    fn make(x: i32) -> box { Box [value: x, other: x] }
  `,
    "type.constructor_unknown_slot",
  );
  await assertThrowsCompile(
    `
    fn make(x: i32) -> i32 { Missing [value: x] }
  `,
    "type.unknown_constructor",
  );
});

Deno.test("rejects removed type syntaxes", async () => {
  await assertThrowsCompile("data Option<T> = None | Some(T);", "parse.syntax");
  await assertThrowsCompile("type id = i32;", "parse.syntax");
  await assertThrowsCompile("type point = {x: i32};", "parse.syntax");
  await assertThrowsCompile("type Pair = (i32, i32);", "parse.syntax");
  await assertThrowsCompile("type box(A: type) -> type { struct { value: A } }", "parse.syntax");
  await assertThrowsCompile("fn use(T: type(A: type) -> type) -> i32 { 0 }", "parse.syntax");
  await assertThrowsCompile("class functor(F) { fn map(x: F) -> F; }", "parse.syntax");
  await assertThrowsCompile("instance Functor Array { }", "parse.syntax");
  await assertThrowsCompile(
    "type fn eq(T: type) { if type_is_product(T) { i32 } else { bool } }",
    "parse.syntax",
  );
  await assertThrowsCompile(
    "fn choose(flag: bool) -> i32 { if flag { 1 } else { 0 } }",
    "parse.syntax",
  );
});

Deno.test("rejects removed function syntax", async () => {
  await assertThrowsCompile("fun main() -> i32 { 1 }", "parse.syntax");
  await assertThrowsCompile(
    "fn apply(const f: fun(x: i32) -> i32) -> i32 { f(1) }",
    "parse.syntax",
  );
});

Deno.test("reports type function diagnostics", async () => {
  await assertThrowsCompile(
    "type fn bad(A: count) { let Bad = [x: A, A*i32]; struct(Bad) }",
    "type.param_kind_conflict",
  );
  await assertThrowsCompile("type fn loop() { loop() }", "type.recursive_type_fn");
  await assertThrowsCompile(
    "type fn bad(T: type) { match T { i32 => i32 } } fn f(x: bad(bool)) -> i32 { 1 }",
    "type.non_exhaustive_match",
  );
  await assertThrowsCompile(
    "type fn bad(T: type) { type_is_product(T) } fn f(x: bad(i32)) -> i32 { 1 }",
    "type.static_builtin_prefix",
  );
  await assertThrowsCompile(
    `
    const host: fn() -> bool !{io} = @capability("host");
    fn calls_host(T) -> bool !{io} { host() }
    type fn bad(T: type) { match calls_host(T) { true => i32, false => bool } }
    fn f(x: bad(i32)) -> i32 { 1 }
  `,
    "type.runtime_capability_call",
  );
  await assertThrowsCompile(
    `
    fn unsupported(T) -> bool { [value: true] }
    type fn bad(T: type) { match unsupported(T) { true => i32, false => bool } }
    fn f(x: bad(i32)) -> i32 { 1 }
  `,
    "type.unsupported_expr",
  );
  await assertThrowsCompile(
    "type fn bad(a: type) { let Bad = [value: a]; struct(Bad) }",
    "type.type_param_casing",
  );
  await assertThrowsCompile(
    "type fn Pair(A: type) { let Pair = [fst: A, snd: A]; struct(Pair) }",
    "parse.syntax",
  );
  await assertThrowsCompile(
    "type fn pair(A: type) { let Pair = [fst: A, snd: A]; struct(Pair) } fn f(x: Pair(i32)) -> i32 { 1 }",
    "type.type_fn_reference_casing",
  );
  await checkSource(
    "type fn pair(A: type) { let Pair = [fst: A, snd: A]; struct(Pair) } fn f(x: pair(i32)) -> i32 { 1 }",
  );
});

Deno.test("dispatches ordered type function clauses", async () => {
  const checked = await checkSource(`
    type fn choose(T: type) -> type { T }
    type fn choose(i32: type) -> type { bool }
    type fn count_case(_: count) -> type { i32 }
    type fn count_case(0: count) -> type { bool }
    type fn count_shadow() -> type { count_case(0) }
    fn first(x: choose(i32)) -> bool { x }
  `);
  const first = findFn(checked.program, "first");
  const countShadow = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "count_shadow"
  );
  assertEquals(first?.params[0].type, "choose(i32)");
  assertEquals(countShadow?.normalized, { kind: "alias", type: "count_case(0)" });
});

Deno.test("accepts ordered value function literal clauses", async () => {
  const checked = await checkSource(`
    fn something_n(1: i32) -> i32 { 10 }
    fn something_n(a: i32) -> i32 { A }
    pub fn main() -> i32 { something_n(1) }
  `);
  assertEquals(findFns(checked.program, "something_n__clause_0").length, 1);
  assertEquals(findFns(checked.program, "something_n__clause_1").length, 1);
});

Deno.test("rejects incompatible value function clauses", async () => {
  await assertThrowsCompile(
    `
    fn bad(1: i32) -> i32 { 1 }
    fn bad(a: i32, b: i32) -> i32 { A }
  `,
    "fn.clause_arity",
  );
  await assertThrowsCompile(
    `
    fn bad(1: i32) -> i32 { 1 }
    fn bad(a: i32) -> bool { true }
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
    fn prim_add_ptr(x: i32, y: i32) -> i32 { @ptr_add(x, y) }
    fn use_it(x: i32) -> i32 { prim_add_ptr(x, 4) }
  `);
  const wrapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "prim_add_ptr"
  );
  assertEquals(wrapper?.primitiveId, undefined);

  const wat = await watFromSource(`
    fn prim_add_ptr(x: i32, y: i32) -> i32 { @ptr_add(x, y) }
    pub fn main() -> i32 { 1 }
  `);
  assert(!wat.includes("(func $prim_add_ptr"));

  await assertThrowsCompile(
    "fn nope(x: i32) -> i32 { @ptr_not_a_primitive(x) }",
    "primitive.unknown",
  );
  await assertThrowsCompile(
    `fn old_add_ptr(x: i32, y: i32) -> i32 { @wasm_${"ptr"}_add(x, y) }`,
    "primitive.unknown",
  );
  await assertThrowsCompile(
    `
      fn a(x: i32) -> i32 { @ptr_add(x, 1) }
      fn b(x: i32) -> i32 { @ptr_add(x, 1) }
    `,
    "primitive.duplicate",
  );
  await assertThrowsCompile(
    `primitive fn old_add_ptr(x: i32, y: i32) -> i32 = #ptr_add;`,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `import module prelude.std; pub fn main() -> i32 { 1 }`,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `import capability clock: fn() -> i32 !{time}; pub fn main() -> i32 !{time} { clock() }`,
    "parse.syntax",
  );
});

Deno.test("namespace source imports qualify values and types", async () => {
  const modules = new Map([
    [
      "prelude.std",
      `
        type fn lane4_i32() { [4*i32] }
        type fn pair(A: type, B: type) { [fst: A, snd: B] }
        fn inc_local(x: i32) -> i32 { x + 1 }
        pub fn inc(x: i32) -> i32 { inc_local(x) }
        pub fn map4_i32(f: fn(x: i32) -> i32, xs: lane4_i32) -> lane4_i32 {
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
      pub fn main() -> std.lane4_i32 { std.map4_i32(std.inc, [1, 2, 3, 4]) }
      fn pair_value() -> std.pair(i32, i32) { [1, 2] }
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

Deno.test("namespace source imports support nested qualified references", async () => {
  const modules = new Map([
    [
      "prelude.layout",
      `
        type fn lane4_i32() -> type { [4*i32] }
      `,
    ],
    [
      "prelude.array",
      `
        const layout = @import("prelude.layout");
        pub fn map4_i32(f: fn(x: i32) -> i32, xs: layout.lane4_i32) -> layout.lane4_i32 {
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
      pub fn main() -> std.array.layout.lane4_i32 {
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
        type fn lane4_i32() -> type { [4*i32] }
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

Deno.test("tracks owned values and rejects move-after-pass", async () => {
  await assertThrowsCompile(
    `
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let moved = sink(x);
      x
    }
  `,
    "ownership.use_after_move",
  );
});

Deno.test("allows fork let local reuse and rejects unknown fork source", async () => {
  await checkSource(`
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let forked, y = fork(x);
      let moved = sink(y);
      forked
    }
  `);
  await checkSource(`
    pub fn main() -> i32 {
      let b = a + 1;
      let a = 1;
      b
    }
  `);
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let x, y = fork(missing);
      x
    }
  `,
    "ownership.unknown_fork",
  );
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let x = 1;
      let x = 2;
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
      let y, z = fork(x + 1);
      x
    }
  `,
    "parse.lower",
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
  assertStringIncludes(wat, "call $inc");
  assertStringIncludes(wat, "call $add");
  assertStringIncludes(wat, "call $mul");
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
    type fn pair() { let Pair = [left: i32, right: i32]; struct(Pair) }
    fn make_pair(x: i32) -> pair { Pair [left: x, right: x + 1] }
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
    type fn lane4_i32() { let Lane4I32 = [4*i32]; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: lane4_i32) -> lane4_i32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> lane4_i32 { map4_i32($ + 1, [1, 2, 3, 4]) }
  `);
  assertStringIncludes(wat, "(func $__dollar");
  assertStringIncludes(wat, "call $__dollar");
  await assertThrowsCompile(
    "pub fn main() -> i32 { $ + 1 }",
    "const.placeholder_context",
  );
  await assertThrowsCompile(
    `
    type fn lane4_i32() { let Lane4I32 = [4*i32]; struct(Lane4I32) }
    fn map4_i32(const f: fn(x: i32) -> i32, xs: lane4_i32) -> lane4_i32 {
      [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
    }
    pub fn main() -> lane4_i32 {
      let bump = 1;
      map4_i32($ + bump, [1, 2, 3, 4])
    }
  `,
    "const.placeholder_capture",
  );
});

Deno.test("n-way fork and product result destructuring bind local result slots", async () => {
  const wat = await watFromSource(`
    type fn pair() { let Pair = [first: i32, second: i32]; struct(Pair) }
    fn make_pair() -> pair { [2, 3] }
    fn sink(x: i32) -> i32 { x }
    pub fn main() -> i32 {
      let x = 1;
      let a, b, c = fork(x);
      let used = sink(c);
      let first, second = make_pair();
      a + b + used + first + second
    }
  `);
  assertStringIncludes(wat, "(func $make_pair (result i32) (result i32)");
  assertStringIncludes(wat, "(local $first i32)");
  assertStringIncludes(wat, "(local $second i32)");
  await assertThrowsCompile(
    `
    pub fn main() -> i32 {
      let x = 1;
      let a, b, c = fork(x);
      x
    }
  `,
    "ownership.use_after_move",
  );
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
    type fn pair() { let Pair = [first: i32, second: i32]; struct(Pair) }
    fn make_pair() -> pair { [2, 3] }
    pub fn main() -> i32 {
      let a, b, c = make_pair();
      a
    }
  `,
    "type.destructure_arity",
  );
});

Deno.test("memory load intrinsics borrow memory but stores consume memory tokens", async () => {
  await checkSource(`
    type fn ptr(A: type) -> type {
      let Ptr = [addr: i32];
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
      let base: ptr(i32) = ptr.from_i32(p);
      let p0, p1 = fork(base);
      memory.load_i32(mem0, p0) + memory.load_i32(mem0, p1)
    }
  `);

  await assertThrowsCompile(
    `
    type fn ptr(A: type) -> type {
      let Ptr = [addr: i32];
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
    pub fn main(mem0: memory, p: i32) -> memory {
      let base: ptr(i32) = ptr.from_i32(p);
      let p0, p1 = fork(base);
      let mem1: memory = memory.store_i32(mem0, p0, 1);
      memory.store_i32(mem0, p1, 2)
    }
  `,
    "ownership.use_after_move",
  );
});

Deno.test("models type contracts with explicit const dictionaries", async () => {
  const parsed = await checkSource(`
    type fn point() { let Point = [x: i32, y: i32]; struct(Point) }
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn option(A: type) { let None = []; let Some = [value: A]; union(None, Some) }
    fn requires_product(T) -> bool !{io} { @type_is_product(T) }
    type fn eq(T: type) {
      let Eq = [eql: fn(a: T, b: T) -> bool, neq: fn(a: T, b: T) -> bool];
      match requires_product(T) {
        true => struct(Eq),
        false => @compile_error("eq requires A product type"),
      }
    }
    type fn functor(F: type) {
      let Functor = [map: fn(x: F) -> F];
      match @type_has_slot(F, #value) {
        true => struct(Functor),
        false => @compile_error("functor requires value slot"),
      }
    }
    type fn applicative(F: type) {
      let Applicative = [pure: fn(x: i32) -> F, apply: fn(f: F, x: F) -> F];
      match @type_slot_type(F, #value) {
        i32 => struct(Applicative),
        _ => @compile_error("applicative requires i32 value"),
      }
    }
    type fn monad(F: type) {
      let Monad = [bind: fn(x: F) -> F];
      match @type_is_product(F) {
        true => struct(Monad),
        false => @compile_error("monad requires product"),
      }
    }
    fn eql_point(a: point, b: point) -> bool { a.x == b.x }
    fn neq_point(a: point, b: point) -> bool { a.x != b.x }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    fn pure_box(x: i32) -> box { [value: x] }
    fn apply_box(f: box, x: box) -> box { [value: f.value + x.value] }
    fn bind_box(x: box) -> box { [value: x.value + 10] }
    const point_eq: eq(point) = [eql: eql_point, neq: neq_point];
    const box_functor: functor(box) = [map: map_box];
    const box_applicative: applicative(box) = [pure: pure_box, apply: apply_box];
    const box_monad: monad(box) = [bind: bind_box];
    fn same(dict: eq(point), a: point, b: point) -> i32 {
      match dict.eql(A, B) { true => 1, false => 0 }
    }
    fn mapped(dict: functor(box), x: box) -> i32 { dict.map(x).value }
    fn applied(dict: applicative(box), x: i32) -> i32 { dict.apply(dict.pure(x), [value: 2]).value }
    fn bound(dict: monad(box), x: box) -> i32 { dict.bind(x).value }
    pub fn main() -> i32 {
      same(point_eq, Point [x: 1, y: 2], Point [x: 1, y: 2])
        + mapped(box_functor, [value: 1])
        + applied(box_applicative, 2)
        + bound(box_monad, [value: 3])
    }
  `);
  const eq = parsed.program.declarations.find((decl) => decl.kind === "type" && decl.name === "eq");
  assertEquals(
    eq?.kind === "type" ? eq.normalized : undefined,
    {
      kind: "alias",
      type:
        'match requires_product(T) { true => struct(Eq), false => @compile_error("eq requires A product type") }',
    },
  );
  await checkSource(`
    type fn option(A: type) { let None = []; let Some = [value: A]; union(None, Some) }
    type fn has_some(T: type) {
      let HasSome = [ok: i32];
      match @type_has_variant(T, #Some) == @type_variant_has_slot(T, #Some, #value) {
        true => struct(HasSome),
        false => @compile_error("expected Some value"),
      }
    }
    fn ok() -> i32 { 1 }
    const dict: has_some(option(i32)) = [ok: ok];
  `);
  await checkSource(`
    type fn point() { let Point = [x: i32, y: i32]; struct(Point) }
    type fn eq(T: type) { let Eq = [eql: fn(a: T, b: T) -> bool, neq: fn(a: T, b: T) -> bool]; struct(Eq) }
    fn eql_point(a: point, b: point) -> bool { a.x == b.x }
    fn neq_point(a: point, b: point) -> bool { a.x != b.x }
    const point_eq: eq(point) = [eql: eql_point, neq: neq_point];
    pub fn main() -> i32 { same(1) }
  `);
  await assertThrowsCompile(
    "fn map_array(x: i32) -> i32 { x } const bad = [map: map_array];",
    "type.const_annotation",
  );
  await assertThrowsCompile(
    "fn map_array(x: i32) -> i32 { x } const bad: i32 = map_array;",
    "type.const_shape",
  );
  await assertThrowsCompile(
    `
    type fn eq(T: type) { let Eq = [eql: fn(a: T, b: T) -> bool, neq: fn(a: T, b: T) -> bool]; struct(Eq) }
    const bad: eq(point) = [];
  `,
    "type.const_missing_slot",
  );
  await assertThrowsCompile(
    `
    type fn point() { let Point = [x: i32, y: i32]; struct(Point) }
    type fn eq(T: type) { let Eq = [eql: fn(a: T, b: T) -> bool, neq: fn(a: T, b: T) -> bool]; struct(Eq) }
    fn eql_point(a: point, b: point) -> bool { a.x == b.x }
    fn neq_point(a: point, b: point) -> bool { a.x != b.x }
    const bad: eq(point) = [eql: eql_point, neq: neq_point, other: eql_point];
  `,
    "type.const_unknown_slot",
  );
  await assertThrowsCompile(
    `
    type fn id() { i32 }
    fn map_array(x: i32) -> i32 { x }
    const bad: id = [map: map_array];
  `,
    "type.const_dictionary_type",
  );
  await assertThrowsCompile(
    `
    fn map_array(x: i32) -> i32 { x }
    const bad: i32 = [map: map_array(1)];
  `,
    "type.const_slot_function",
  );
  await assertThrowsCompile(
    `
    const bad: i32 = [map: missing];
  `,
    "type.unknown_const_function",
  );
  await assertThrowsCompile(
    `
    fn map_array(x: i32) -> i32 { x }
    const bad: i32 = [map: map_array, map: map_array];
  `,
    "type.duplicate_const_slot",
  );
  await assertThrowsCompile(
    `
    type fn option(A: type) { let None = []; let Some = [value: A]; union(None, Some) }
    type fn eq(T: type) {
      let Eq = [eql: fn(a: T, b: T) -> bool, neq: fn(a: T, b: T) -> bool];
      match @type_is_product(T) {
        true => struct(Eq),
        false => @compile_error("eq requires A product type"),
      }
    }
    fn eql_i32(a: i32, b: i32) -> bool { A == B }
    fn neq_i32(a: i32, b: i32) -> bool { A != B }
    const bad: eq(option(i32)) = [eql: eql_i32, neq: neq_i32];
  `,
    "type.compile_error",
  );
  await assertThrowsCompile(
    `
    type fn option(A: type) { let None = []; let Some = [value: A]; union(None, Some) }
    type fn eq(T: type) {
      let Eq = [eql: fn(a: T, b: T) -> bool, neq: fn(a: T, b: T) -> bool];
      match @type_is_product(T) {
        true => struct(Eq),
        false => @compile_error("eq requires A product type"),
      }
    }
    fn bad(dict: eq(option(i32))) -> i32 { 0 }
  `,
    "type.compile_error",
  );
  await assertThrowsCompile(
    `
    type fn point() { let Point = [x: i32, y: i32]; struct(Point) }
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) {
      let Functor = [map: fn(x: F) -> F];
      match @type_slot_type(F, #missing) {
        i32 => struct(Functor),
        _ => struct(Functor),
      }
    }
    fn map_box(x: box) -> box { [value: x.value] }
    const bad: functor(point) = [map: map_box];
  `,
    "type.unknown_type_slot",
  );
});

Deno.test("models attached type members for static contracts", async () => {
  const checked = await checkSource(`
    fn eql_point(a: point, b: point) -> bool { a.x == b.x }
    type fn point() { let Point = [x: i32, y: i32]; struct(Point) }
    fn point.eql(a: point, b: point) -> bool { eql_point(a, b) }
    type fn eq(T: type) {
      let Expected = fn(a: T, b: T) -> bool;
      @require(@type_has_member(T, #eql), "Eq requires eql");
      @require(@type_member_type(T, #eql) == Expected, "Eq.eql has wrong type");
    }
    fn same(proof: eq(point), x: point, y: point) -> bool { point.eql(x, y) }
  `);
  const point = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "point"
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
    callee: { kind: "var", name: "point.eql" },
    args: [{ kind: "var", name: "x" }, { kind: "var", name: "y" }],
  });
});

Deno.test("reports attached type member contract failures", async () => {
  await assertThrowsCompile(
    `
      type fn point() { let Point = [x: i32, y: i32]; struct(Point) }
      type fn eq(T: type) {
        @require(@type_has_member(T, #eql), "Eq requires eql");
      }
      fn same(proof: eq(point)) -> bool { true }
    `,
    "type.require",
  );
  await assertThrowsCompile(
    `
      fn eql_point(a: point) -> bool { true }
      type fn point() { let Point = [x: i32]; struct(Point) }
      fn point.eql(a: point) -> bool { eql_point(a) }
      type fn eq(T: type) {
        let Expected = fn(a: T, b: T) -> bool;
        @require(@type_member_type(T, #eql) == Expected, "Eq.eql has wrong type");
      }
      fn same(proof: eq(point)) -> bool { true }
    `,
    "type.require",
  );
});

Deno.test("specializes functor constraints over type constructors", async () => {
  const parsed = await parse(`
    type fn box(A: type) -> type { let Box = [value: A]; struct(Box) }
    fn box.map(v: box(A), const f: fn(x: A) -> B) -> box(B) {
      Box [value: f(v.value)]
    }
  `);
  const parsedMap = parsed.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "box.map"
  );
  assertEquals(parsedMap?.body.expr?.kind, "product_constructor");

  const checked = await checkSource(`
    type fn box(A: type) -> type {
      let Box = [value: A];
      struct(Box)
    }
    fn box.map(v: box(A), const f: fn(x: A) -> B) -> box(B) {
      Box [value: f(v.value)]
    }
    type fn functor(T: type fn(A: type) -> type) -> type {
      let Expected = fn(v: T(A), const f: fn(x: A) -> B) -> T(B);
      @require(@type_has_member(T, #map), "Functor requires map");
      @require(@type_member_type(T, #map) == Expected, "Functor.map has wrong type");
      T
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn mapper(v: T(A), const f: fn(x: A) -> B, const _proof: functor(T)) -> T(B) {
      T.map(v, f)
    }
    pub fn main() -> box(i32) { mapper(Box [value: 1], inc, functor(box)) }
  `);
  const boxMap = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("box_map__")
  );
  assertEquals(boxMap?.body.expr?.kind, "shape");
  const mapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("mapper__")
  );
  assertEquals(mapper?.params, [{ name: "v", type: "box(i32)", const: undefined }]);
  assertEquals(mapper?.returnType, "box(i32)");
  assertEquals(
    mapper?.body.expr?.kind === "call" ? mapper.body.expr.callee : undefined,
    { kind: "var", name: "box_map__inc" },
  );

  await assertThrowsCompile(
    `
      type fn empty(A: type) -> type { let Empty = [value: A]; struct(Empty) }
      type fn functor(T: type fn(A: type) -> type) -> type {
        let Expected = fn(v: T(A), const f: fn(x: A) -> B) -> T(B);
        @require(@type_has_member(T, #map), "Functor requires map");
        @require(@type_member_type(T, #map) == Expected, "Functor.map has wrong type");
        T
      }
      fn bad(const _proof: functor(empty)) -> i32 { 0 }
    `,
    "type.require",
  );
  await assertThrowsCompile(
    `
      type fn bad_box(A: type) -> type {
        let BadBox = [value: A];
        struct(BadBox)
      }
      fn bad_box.map(v: bad_box(A)) -> bad_box(A) { v }
      type fn functor(T: type fn(A: type) -> type) -> type {
        let Expected = fn(v: T(A), const f: fn(x: A) -> B) -> T(B);
        @require(@type_has_member(T, #map), "Functor requires map");
        @require(@type_member_type(T, #map) == Expected, "Functor.map has wrong type");
        T
      }
      fn bad(const _proof: functor(bad_box)) -> i32 { 0 }
    `,
    "type.require",
  );
  await assertThrowsCompile(
    `
      type fn concrete() { let Concrete = [value: i32]; struct(Concrete) }
      type fn functor(T: type fn(A: type) -> type) -> type { T }
      fn bad(const _proof: functor(concrete)) -> i32 { 0 }
    `,
    "type.param_kind",
  );
  await checkSource(`
    type fn box(A: type) -> struct { let Box = [value: A]; struct(Box) }
    type fn functor(T: type fn(A: type) -> struct) -> type { T }
    fn ok(const _proof: functor(box)) -> i32 { 0 }
  `);
  await checkSource(`
    type fn box(A: type) -> struct { let Box = [value: A]; struct(Box) }
    type fn broad(T: type fn(A: type) -> type) -> type { T }
    fn ok(const _proof: broad(box)) -> i32 { 0 }
  `);
  await assertThrowsCompile(
    `
      type fn option(A: type) -> union { let None = []; let Some = [value: A]; union(None, Some) }
      type fn functor(T: type fn(A: type) -> struct) -> type { T }
      fn bad(const _proof: functor(option)) -> i32 { 0 }
    `,
    "type.param_kind",
  );
});

Deno.test("attaches qualified type member functions", async () => {
  const checked = await checkSource(`
    type fn box(A: type) -> type { let Box = [value: A]; struct(Box) }
    fn box.map(v: box(A), const f: fn(x: A) -> B) -> box(B) {
      Box [value: f(v.value)]
    }
    type fn functor(T: type fn(A: type) -> type) -> type {
      let Expected = fn(v: T(A), const f: fn(x: A) -> B) -> T(B);
      @require(@type_has_member(T, #map), "Functor requires map");
      @require(@type_member_type(T, #map) == Expected, "Functor.map has wrong type");
      T
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn mapper(v: T(A), const f: fn(x: A) -> B, const _proof: functor(T)) -> T(B) {
      T.map(v, f)
    }
    pub fn main() -> box(i32) { mapper(Box [value: 1], inc, functor(box)) }
  `);
  const box = checked.program.declarations.find((decl): decl is TypeDecl =>
    decl.kind === "type" && decl.name === "box"
  );
  assertEquals(
    box?.normalized?.kind === "product" ? box.normalized.members : undefined,
    [{ name: "map", type: "fn(v: box(A), const f: fn(x: A) -> B) -> box(B)", target: "box.map" }],
  );
  const mapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("mapper__")
  );
  assertEquals(
    mapper?.body.expr?.kind === "call" ? mapper.body.expr.callee : undefined,
    { kind: "var", name: "box_map__inc" },
  );
  await assertThrowsCompile(
    `
      fn missing.map() -> i32 { 0 }
    `,
    "type.unknown_type",
  );
  await assertThrowsCompile(
    `
      type fn box(A: type) -> type { let Box = [value: A]; struct(Box) }
      fn box.map(v: box(A)) -> box(A) { v }
      fn box.map(v: box(A)) -> box(A) { v }
    `,
    "type.duplicate_member",
  );
});

Deno.test("infers local proof consts at generic call sites", async () => {
  const checked = await checkSource(`
    type fn box(A: type) -> type {
      let Box = [value: A];
      struct(Box)
    }
    fn box.map(v: box(A), const f: fn(x: A) -> B) -> box(B) {
      Box [value: f(v.value)]
    }
    type fn functor(T: type fn(A: type) -> type) -> type {
      let Expected = fn(v: T(A), const f: fn(x: A) -> B) -> T(B);
      @require(@type_has_member(T, #map), "Functor requires map");
      @require(@type_member_type(T, #map) == Expected, "Functor.map has wrong type");
      T
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn mapper(v: T(A), const f: fn(x: A) -> B) -> T(B) {
      const Mapper = functor(T);
      Mapper.map(v, f)
    }
    pub fn main() -> box(i32) {
      mapper(Box [value: 1], inc)
    }
  `);
  const mapper = checked.program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name.startsWith("mapper__")
  );
  assertEquals(mapper?.params, [{ name: "v", type: "box(i32)", const: undefined }]);
  assertEquals(mapper?.returnType, "box(i32)");
  assertEquals(mapper?.body.statements, []);
  assertEquals(
    mapper?.body.expr?.kind === "call" ? mapper.body.expr.callee : undefined,
    { kind: "var", name: "box_map__inc" },
  );

  await assertThrowsCompile(
    `
      type fn empty(A: type) -> type {
        let Empty = [value: A];
        struct(Empty)
      }
      type fn functor(T: type fn(A: type) -> type) -> type {
        @require(@type_has_member(T, #map), "Functor requires map");
        T
      }
      fn inc(x: i32) -> i32 { x + 1 }
      fn mapper(v: T(A), const f: fn(x: A) -> B) -> T(B) {
        const Mapper = functor(T);
        v
      }
      pub fn main() -> empty(i32) { mapper(Empty [value: 1], inc) }
    `,
    "type.require",
  );

  await assertThrowsCompile(
    `
      type fn box(A: type) -> type {
        let Box = [value: A];
        struct(Box)
      }
      fn bad(v: T(A)) -> T(A) {
        const mapper = T;
        v
      }
      pub fn main() -> box(i32) { bad(Box [value: 1]) }
    `,
    "parse.syntax",
  );
});

Deno.test("rejects legacy const type extension fragments", async () => {
  await assertThrowsCompile(
    `
      type fn box(A: type) -> type { let Box = [value: A]; struct(Box) }
      type fn functor(T: type fn(A: type) -> type) -> type {
        @require(@type_has_member(T, #map), "Functor requires map");
        T
      }
      const Box: functor(box) = struct { }
    `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
      type fn box(A: type) -> type { let Box = [value: A]; struct(Box) }
      type fn functor(T: type fn(A: type) -> type) -> type {
        let Expected = fn(v: T(A), const f: fn(x: A) -> B) -> T(B);
        @require(@type_member_type(T, #map) == Expected, "Functor.map has wrong type");
        T
      }
      const Box: functor(box) = struct {
        fn map(v: box(A)) -> box(A) { v }
      }
    `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
      const Box: i32 = struct { value: i32 }
    `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
      const Maybe: i32 = union { None, Some [value: i32] }
    `,
    "parse.syntax",
  );
  await assertThrowsCompile(
    `
      type fn box(A: type) -> type { let Box = [value: A]; struct(Box) }
      type fn box(A: type) -> type { let Box = [other: A]; struct(Box) }
    `,
    "type.duplicate_runtime_fragment",
  );
  await assertThrowsCompile(
    `
      type fn box(A: type) -> type {
        let Box = [value: A];
        struct(Box)
      }
      fn box.map(v: box(A)) -> box(A) { v }
      fn box.map(v: box(A)) -> box(A) { v }
    `,
    "type.duplicate_member",
  );
  await assertThrowsCompile(
    `
      type fn functor(T: type fn(A: type) -> type) -> type { T }
      const Missing: functor(missing) = struct { }
    `,
    "parse.syntax",
  );
});

Deno.test("specializes const parameters at call sites", async () => {
  const checked = await checkSource(`
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    const box_functor: functor(box) = [map: map_box];
    fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
    pub fn main() -> box {
      let a = mapped(box_functor, [value: 1]);
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
    { name: "x", type: "box", const: undefined },
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
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
    fn bad(dict: functor(box), x: box) -> box { mapped(dict, x) }
  `,
    "const.static_param_arg",
  );
});

Deno.test("memoizes distinct const parameter specializations", async () => {
  const checked = await checkSource(`
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    fn map_box_alt(x: box) -> box { [value: x.value + 2] }
    const box_functor: functor(box) = [map: map_box];
    const alt_functor: functor(box) = [map: map_box_alt];
    fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
    pub fn main() -> box {
      let a = mapped(box_functor, [value: 1]);
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
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    fn map_box_alt(x: box) -> box { [value: x.value + 2] }
    const box_functor: functor(box) = [map: map_box];
    const alt_functor: functor(box) = [map: map_box_alt];
    fn mapped_twice(const first: functor(box), const second: functor(box), x: box) -> box {
      second.map(first.map(x))
    }
    pub fn main() -> box { mapped_twice(box_functor, alt_functor, [value: 1]) }
  `);
  const specialized = findFn(checked.program, "mapped_twice__box_functor__alt_functor");
  assertEquals(specialized?.kind === "fn" ? specialized.params : undefined, [
    { name: "x", type: "box", const: undefined },
  ]);
  assert(specialized?.kind === "fn" && specialized.generated);
});

Deno.test("reuses nested const-specialized calls", async () => {
  const checked = await checkSource(`
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    const box_functor: functor(box) = [map: map_box];
    fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
    fn mapped_outer(const dict: functor(box), x: box) -> box { mapped(dict, x) }
    pub fn main() -> box {
      let a = mapped_outer(box_functor, [value: 1]);
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
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    const box_functor: functor(box) = [map: map_box];
    fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
    pub fn main() -> box { mapped(box_functor, [value: 1]) }
  `);

  assertEquals(findFns(checked.program, "mapped__box_functor").length, 1);
  const checkedMain = findFn(checked.program, "main");
  assertEquals(
    checkedMain?.body.expr?.kind === "call" ? checkedMain.body.expr.callee : undefined,
    { kind: "var", name: "mapped__box_functor" },
  );

  const optimized = optimizeProgram(checked.program);
  const optimizedMain = findFn(optimized, "main");
  assertEquals(
    optimizedMain?.body.expr?.kind === "call" ? optimizedMain.body.expr.callee : undefined,
    { kind: "var", name: "map_box" },
  );
});

Deno.test("optimizes repeated forwarding wrapper call sites", async () => {
  const checked = await checkSource(`
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    const box_functor: functor(box) = [map: map_box];
    fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
    pub fn main() -> box {
      let a = mapped(box_functor, [value: 1]);
      let b = mapped(box_functor, a);
      mapped(box_functor, b)
    }
  `);

  assertEquals(findFns(checked.program, "mapped__box_functor").length, 1);
  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("mapped__box_functor") ?? 0, 0);
  assertEquals(counts.get("map_box") ?? 0, 3);
});

Deno.test("optimizes nested forwarding specializations transitively", async () => {
  const checked = await checkSource(`
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    const box_functor: functor(box) = [map: map_box];
    fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
    fn mapped_outer(const dict: functor(box), x: box) -> box { mapped(dict, x) }
    pub fn main() -> box { mapped_outer(box_functor, [value: 1]) }
  `);

  const counts = countCalls(optimizeProgram(checked.program), { includeGenerated: false });
  assertEquals(counts.get("mapped_outer__box_functor") ?? 0, 0);
  assertEquals(counts.get("mapped__box_functor") ?? 0, 0);
  assertEquals(counts.get("map_box") ?? 0, 1);
});

Deno.test("does not inline non-forwarding generated specializations", async () => {
  const checked = await checkSource(`
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    const box_functor: functor(box) = [map: map_box];
    fn mapped(const dict: functor(box), x: box) -> box {
      let y = dict.map(x);
      dict.map(y)
    }
    pub fn main() -> box { mapped(box_functor, [value: 1]) }
  `);

  const counts = countCalls(optimizeProgram(checked.program));
  assertEquals(counts.get("mapped__box_functor") ?? 0, 1);
});

Deno.test("optimizes specialization calls by resolved generated name", async () => {
  const checked = await checkSource(`
    type fn box() { let Box = [value: i32]; struct(Box) }
    type fn functor(F: type) { let Functor = [map: fn(x: F) -> F]; struct(Functor) }
    fn map_box(x: box) -> box { [value: x.value + 1] }
    const box_functor: functor(box) = [map: map_box];
    fn mapped__box_functor(x: box) -> box { x }
    fn mapped(const dict: functor(box), x: box) -> box { dict.map(x) }
    pub fn main() -> box { mapped(box_functor, [value: 1]) }
  `);

  assertEquals(findFns(checked.program, "mapped__box_functor").length, 1);
  assertEquals(findFns(checked.program, "mapped__box_functor__2").length, 1);
  const optimizedMain = findFn(optimizeProgram(checked.program), "main");
  assertEquals(
    optimizedMain?.body.expr?.kind === "call" ? optimizedMain.body.expr.callee : undefined,
    { kind: "var", name: "map_box" },
  );
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
    type fn inline_array(N: count, A: type) {
      let InlineArray = [N*A];
      struct(InlineArray)
    }
    type fn lane4_i32() -> type { inline_array(4, i32) }
    fn memory.load_lane4_i32(mem: memory, p: ptr(lane4_i32)) -> lane4_i32 {
  @memory_load_lane4_i32(mem, p)
}
    fn memory.store_lane4_i32(mem: memory, p: ptr(lane4_i32), value: lane4_i32) -> memory {
  @memory_store_lane4_i32(mem, p, value)
}
    type fn lane8_i32() -> type { inline_array(8, i32) }
    type fn lane8_alias() -> type { lane8_i32 }
    type fn option(A: type) -> union {
      let None = [];
      let Some = [value: A];
      union(None, Some)
    }
    fn get(xs: lane4_i32, i: i32) -> option(i32) { 0 }
  `;
  await checkSource(`${header} fn ok(xs: lane4_i32) -> i32 { xs[0] }`);
  await assertThrowsCompile(
    `${header} fn bad(xs: lane4_i32) -> i32 { xs[4] }`,
    "index.out_of_bounds",
  );
  await checkSource(`${header} fn ok(xs: lane4_i32, i: index(4)) -> i32 { xs[i] }`);
  await checkSource(`${header} fn ok(xs: lane8_alias, i: index(8)) -> i32 { xs[i] }`);
  await checkSource(`${header} fn checked(xs: lane4_i32, i: i32) -> option(i32) { get(xs, i) }`);
  await assertThrowsCompile(
    `${header} fn bad(xs: lane4_i32, i: i32) -> i32 { xs[i] }`,
    "index.requires_proof",
  );
  await assertThrowsCompile(
    `${header} fn bad(xs: lane8_alias, i: index(4)) -> i32 { xs[i] }`,
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

  await assertThrowsCompile("pub fn bad(x: u0) -> u0 { x }", "type.unknown_type");
  await assertThrowsCompile("pub fn bad(x: u65) -> u65 { x }", "type.unknown_type");

  const packedByte = await watFromSource(`
    type fn pair() { let Pair = [a: u1, b: u7]; struct(Pair) }
    pub fn main(p: pair) -> u7 { p.b }
  `);
  assertStringIncludes(packedByte, `(param $p$a$b i32)`);
  assertStringIncludes(packedByte, `i32.shr_u`);
  assertStringIncludes(packedByte, `i32.const 127`);
  assertStringIncludes(packedByte, `i32.and`);

  const packedNibbles = await watFromSource(`
    type fn pair() { let Pair = [a: u4, b: u4]; struct(Pair) }
    pub fn main(p: pair) -> pair { p }
  `);
  assertStringIncludes(packedNibbles, `(param $p$a$b i32)`);
  assertStringIncludes(packedNibbles, `(result i32)`);

  const separateByteLanes = await watFromSource(`
    type fn pair() { let Pair = [a: u7, b: u7]; struct(Pair) }
    pub fn main(p: pair) -> pair { p }
  `);
  assertStringIncludes(separateByteLanes, `(param $p$a i32) (param $p$b i32)`);
  assertStringIncludes(separateByteLanes, `(result i32) (result i32)`);

  const arrayLanes = await watFromSource(`
    type fn lane4_u7() -> type { let Lane = [4*u7]; struct(Lane) }
    pub fn main(xs: lane4_u7) -> lane4_u7 { xs }
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
