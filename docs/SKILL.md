---
name: fig-language
description: Complete reference for Fig language syntax, typing, compile-time type functions, Branch-Bit values, effects, imports, standard prelude modules, WebAssembly lowering, and current compiler constraints. Use when Codex needs to write, read, debug, test, document, or explain .fig programs in this repository.
---

# Fig Language

Use this skill when working on Fig source files, examples, prelude modules, parser/checker behavior,
or language documentation. Treat the implementation and tests as the source of truth; this file
summarizes the current supported surface.

## Canonical References

- Use `docs/LANGUAGE.md` as the language index and reading order.
- Use `docs/reference/syntax.md` for declarations, params, blocks, patterns, literals, imports, and
  effects.
- Use `docs/reference/types.md` for primitive, function, tuple, shape/product/union, repeat, and
  constructor types.
- Use `docs/reference/expressions.md` for calls, constructors, tuples, collections, match,
  operators, named pipe-bind, local bindings, and destructuring.
- Use `docs/reference/type-functions.md` for type blocks, result kinds, parameters, `struct`,
  `union`, operators, and type matches.
- Use `docs/reference/builtins.md` for every `@...` compiler builtin and backend intrinsic.
- Use `docs/reference/semantics.md` for Branch-Bit values, effects, const evaluation, reflection,
  and Wasm portability constraints.
- Use `docs/reference/modules.md` for prelude/web/engine module roles.
- Use `docs/reference/prelude.md` for standard prelude modules, contracts, operators, collections,
  effect helpers, and available library APIs.
- Use `docs/EXAMPLES.md` and `tests/fixtures/language` for tested good/bad reference examples.
- Start with `grammar.ebnf` for accepted syntax.
- Use `examples/all_features.fig` as the compact language tour.
- Use `README.md` for the intended positioning of type functions, prelude use, and portability.
- Use `tests/compiler_test.ts` for edge cases, diagnostics, and checker semantics.
- Use `tests/prelude_test.ts` for prelude, operators, web canvas, and library behavior.
- Use `tests/examples_test.ts` and `tests/backend_ir_test.ts` for WebAssembly/import behavior.
- Use `prelude/*.fig` and `web/canvas.fig` for library APIs.

## Doc Comments

Use `///` doc comments when writing Fig declarations or bindings that should carry markdown metadata
for editor hovers. The compiler stores the stripped text on the checked AST, and the LSP renders it
below the symbol signature when available. Well-formed TSDoc-style tags are accepted by the hover
renderer.

Doc comments attach only to the immediately following binding when there is no blank line, ordinary
`//` comment, or code between the comment block and the binding. Multiple contiguous `///` lines
join with `\n`; the leading `///` and at most one following space are stripped.

```fig
/// Adds two Values.
fn add(
  /// Left operand.
  a: i32,
  /// Right operand.
  b: i32
) -> i32 {
  /// Local sum.
  let sum = a + b;
  sum
}

/// a generic point type.
type fn Point(
  /// Coordinate type.
  a: type
) -> struct {
  /// Product shape.
  let Point = {
    /// Horizontal coordinate.
    x: a,
    /// Vertical coordinate.
    y: a,
  };
  struct(Point)
}
```

Prefer `///` for top-level `fn`, `type fn`, `const`, and `let`; function params; type params;
type-block lets; local lets and type-level const calls; and shape fields. Use ordinary `//` only for
non-hover implementation notes.

## Verification

Run the smallest relevant harness after changes:

```bash
deno test --allow-read --allow-write --allow-run tests/compiler_test.ts
deno test --allow-read --allow-write --allow-run tests/prelude_test.ts
deno task test
```

Use `deno task check` for TypeScript-only compiler edits and `deno task smoke` for CLI smoke tests.
Generated grammar/parser updates require `deno task codegen`.

## Source Files and Modules

Write Fig files with `.fig` extension. A program is a sequence of declarations:

- `type fn` declarations for compile-time type functions.
- `type` declaration sugar for fixed product, sum, and alias layouts.
- `const` declarations for compile-time constants, dictionaries, host IO imports, and imports.
- `fn` or `pub fn` declarations for value functions.
- Top-level `let` declarations for simple Values.

Import modules with namespace aliases:

```fig
const std = @import("prelude.std");
const local = @import("./local_module.fig");
```

Imported declarations owned by the target module are qualified through the alias. Transitive
dependency declarations keep their own namespace, so import that dependency directly when you need
its names. The alias is an ordinary namespace alias; it does not merge imported names into the
current scope. Duplicate aliases are rejected.

Use destructured source imports only for exact top-level declarations:

```fig
const { map4_i32, lane4_add_i32 } = @import("prelude.array_static");
```

Destructured imports do not support aliases, dotted names, type annotations, or non-`@import`
right-hand sides.

## Names and Visibility

- Type function names are UpperCamelCase, including type constructor references such as `Pair(i32)`.
- Product constructor names are PascalCase and are introduced by `struct(Shape)`.
- Runtime function names are lowercase and may be qualified as attached members, such as
  `Point::eql` or `Box::map`.
- `pub fn` exports through the Wasm backend and must include an explicit return signature.
- Non-public helper functions may omit `pub` but still need parseable parameter and return forms
  when used by the checker.

## Literals and Primitive Types

Use these literal forms:

- Numbers: `42`, `-1`, `42i32`, `1u32`, `1i64`, `1u64`, `1.0f32`, `1.0f64`.
- Booleans: `true`, `false`.
- Characters and strings: `'x'`, `"fig"`.
- Fenced text: Triple backticks, useful for WGSL shader source.
- Literal type tags: `#Tag`, `#field`, `#Some`.
- Tuple and repeat values: `[1, true]`, `[0; 4]`, fixed update `[...xs, [1]: value]`.
- Target-typed collection literals: `#[1, 2, 3]`, including spread such as `#[0, ...rest]`.

Unsuffixed integer literals default from context, commonly to `i32`. Current primitive scalar types
include `bool`, `i32`, `i64`, `u32`, `u64`, `f32`, `f64`, `string`, and arbitrary unsigned integer
widths `u1` through `u64`. Narrow unsigned fields may be storage-packed in product layouts.

## Functions

Declare functions with a block body or a match body:

```fig
fn add(a: i32, b: i32) -> i32 { a + b }
fn choose(flag: bool) -> i32 match {
  true => 1,
  false => 0,
}
pub fn main() -> i32 { add(40, 2) }
```

Parameter forms include:

- `name: Type`
- `const name: Type` for static function/dictionary/type parameters.
- Wildcard parameters such as `_: Type`.

Use a function match body when runtime parameters drive ordered pattern dispatch:

```fig
fn score(left: bool, right: bool) -> i32 match {
  true, true => 3,
  _, _ => 0,
}
```

Runtime functions are limited to five non-`const` parameters. Group related trailing values into a
small product when a function needs more runtime inputs. Const parameters specialize at call sites
and are erased from generated runtime parameters.

Function types use `fn(...) -> Type`; const function parameters enable compile-time specialization:

```fig
fn Map4(const f: fn(i32) -> i32, xs: {4*i32}) -> {4*i32} {
  [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
}
```

## Blocks and Expressions

Blocks contain `let` statements, local type assertions, and a final expression:

```fig
pub fn main() -> i32 {
  let x = 1;
  @assert(Eq(Point));
  x + 1
}
```

Supported expressions include:

- Function calls: `f(x)`.
- Field access: `Point.x`.
- Indexing: `xs[0]`.
- Product construction: `Point {x: 1, y: 2}` with labeled, positioned, punned, or spread slots.
- Shape values: `{x: 1, y: 2}`, `{x, y}`, and `{...base, z: 3}`.
- Tuple and repeat values: `[1, 2]`, `[0; 4]`, fixed update `[...xs, [1]: value]`.
- Target-typed collection literals: `#[1, 2, 3]`, `#[0, ...rest]`.
- `match value { pattern => expr, _ => fallback }` and boolean `if cond { a } else { b }`.
- `rec(args...)` in a runtime function tail position to re-enter the current function with new
  runtime parameter values.
- Binary operators listed in `grammar.ebnf`.
- Ranges: `start .. end`.
- Pipe-bind: `expr \name -> next`.

Boolean `if` is expression sugar for `match` on `bool`. There is no assignment statement; bind new
locals with `let`. Let statements require semicolons.

## Pattern Matching

Use `match` for variants, literals, typed refined-domain patterns, guarded arms, and ordered pattern
dispatch. A `match` expression has one scrutinee expression and ordered arms. Patterns support `_`,
literals, lowercase bindings, tuple patterns, PascalCase variant names, and variant payload
deconstruction:

```fig
fn unwrap_or(value: Option(i32), fallback: i32) -> i32 {
  match value { Some(inner) => inner, None => fallback }
}
```

Guards run after the pattern has matched and can use bindings introduced by that pattern:

```fig
match value {
  n: i32(0..4 | 8) => n,
  _ if value > 20 => 20,
  _ => value,
}
```

Type functions also support ordered clauses and `match` over static values and types.

## Products, Sums, Shapes, and Arrays

Define concrete product and sum layouts with type declaration sugar:

```fig
type Point = struct {x: i32, y: i32}
type Option(a) = union {None, Some(value: a)}
```

Shape slots may be labeled or anonymous. Counted inline arrays use repeat syntax:

```fig
type fn InlineArray(n: count, a: type) -> type {
  let InlineArray = {n*a};
  struct(InlineArray)
}
```

Indexing a fixed inline array with a literal is bounds-checked. Dynamic indexing requires an
`Index(N)` proof type matching the array length; otherwise use a checked helper that returns an
`option`.

Tuple types use brackets, such as `[i32, bool]` and `[i32; 4]`. Shape and product types use braces.

## Type Functions

Type functions run at compile time and return `type`, `struct`, or `union`:

```fig
type fn Id() -> type { i32 }
type fn Pair(a: type, b: type) -> struct {
  let Pair = {first: a, second: b};
  struct(Pair)
}
```

Parameter kinds include:

- `type`
- `count`
- `const`
- type constructors such as `type fn(a: type) -> type`
- result-constrained constructors such as `type fn(a: type) -> struct`

Use lowercase names for type parameters. Literal and wildcard clauses are allowed for ordered type
function dispatch, for example `type fn Choose(i32: type) -> type { bool }`.

Inside type functions:

- Use `let` or `const` bindings for intermediate type expressions.
- Return a final type expression.
- Use `match` for static branching.
- Use `@compile_error("message")` or `@require(condition, "message")` for diagnostics.
- Do not call host IO imports from type-level evaluation.

When choosing a type-function pattern:

- If you intend to define a runtime data layout, write a `type fn`, bind a PascalCase shape, and
  return `struct(Shape)` or `union(...)`.
- If you intend to require behavior on a type, write a contract `type fn` with `@require` and
  attached members such as `t::eql`, `t::append`, or `t::map`.
- If you intend generic runtime helpers with no runtime evidence cost, evaluate the contract inside
  the body with `@assert(contract(t));` and call attached members through `t::member(...)`.
- If you intend to abstract over a unary type constructor, accept `t: type fn(a: type) -> type`, use
  values as `t(a)`, and reflect members on `t`.
- If you intend type-directed construction or dispatch, pass the type as `const t` or
  `const t: type`; avoid modeling types as runtime Values.
- If ordinary value parameters already determine the type, prefer inference. Pass `const t`
  explicitly only for otherwise unpinned cases such as `Empty(t)`, `pure(t, ...)`, or explicit
  static dispatch.
- If you intend static layout/count specialization, use `const n: count`, `const a: type`, or
  another `const` parameter.

Use `_` as an inferred type hole only where a local expression provides the concrete type: function
returns, local or top-level `let`/`const` annotations, nested annotations such as `Box(_)`, and
supported do-strategy value positions. Do not use `_` in parameters, external signatures,
type-function bodies, contracts, product fields, or other positions without an expression-backed
source of inference.

## Static Reflection and Shape Builtins

Use static builtins only with the `@` prefix. Current reflection helpers include:

- Type predicates: `@type_is_product(t)`, `@type_is_number(t)`, `@type_has_slot(t, #field)`,
  `@type_has_variant(t, #Some)`, `@type_variant_has_slot(t, #Some, #value)`,
  `@type_has_member(t, #map)`.
- Type lookup: `@type_slot_type(t, #field)`, `@type_member_type(t, #member)`, `@type_slots(t)`,
  `@type_variants(t)`, `@type_variant_slots(t, #Variant)`.
- Shape operations: `@shape_has_slot`, `@shape_slot`, `@shape_count`, `@shape_first_key`,
  `@shape_tail`, `@shape_pick`, `@shape_omit`, `@shape_intersect`, `@shape_difference`,
  `@shape_rename`, `@shape_map`, `@shape_map_with_key`, `@shape_filter`, `@shape_concat`.

Shape maps require mapper type functions. `@shape_map_with_key` and `@shape_filter` mappers take
`(Key: const, Value: const)`. `@shape_filter` predicates must return `bool`. Generated shape fields
must be labeled, and duplicate generated labels are rejected.

## Static Contracts and Attached Members

Model typeclasses as ordinary type functions plus attached member functions:

```fig
fn Point::eql(a: Point, b: Point) -> bool { a.x == b.x }

type fn Eq(t: type) -> type {
  let Expected = fn(a: t, b: t) -> bool;
  @require(@type_has_member(t, #eql), "Eq requires eql");
  @require(@type_member_type(t, #eql) == Expected, "Eq.eql has wrong type");
  t
}
```

Attached members use qualified function names, are discoverable through type reflection, and can be
called statically as `t::map(...)` inside generic code. Local `@assert(Functor(t));` calls evaluate
the contract and discard the returned type-level value.

Prelude contracts such as `Eq(t)`, `Functor(t)`, `Applicative(t)`, `Monad(t)`, and `Monoid(t)` get
their optimizer law rewrites from the default prelude rewrite compiler plugin. Do not introduce or
use a separate `LawfulX` contract for those standard proofs.

Const dictionaries are product-shaped constants whose fields are function references:

```fig
const point_eq: Eq(Point) = {eql: Point::eql, neq: Point.neq};
```

Fields must match the annotated product shape, and slot values must be function references rather
than runtime calls.

## Functional Programming Patterns

Prefer ordinary Fig functions plus erased static contracts for functional abstractions. Import
`prelude.std` when possible.

Use const function parameters for higher-order helpers. They specialize away at call sites:

```fig
fn twice(value: a, const f: fn(x: a) -> a) -> a {
  f(f(value))
}

fn inc(x: i32) -> i32 { x + 1 }
pub fn main() -> i32 { twice(1, inc) }
```

Use point-free helpers from `prelude.function` or `prelude.std` for small compositions: `identity`,
`constant`, `compose`, `pipe`, `apply_to`, and `flip`.

Define functor-like types by attaching a `map` member to a unary type constructor:

```fig
type Box(a) = struct {value: a}

fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
  Box {value: f(v.value)}
}

fn inc(x: i32) -> i32 { x + 1 }

pub fn main() -> i32 {
  fmap(Box {value: 1}, inc).value
}
```

Define monad-like types by attaching both `map` and `bind`:

```fig
fn Box::bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {
  f(v.value)
}

fn wrap(x: i32) -> Box(i32) {
  Box {value: x + 10}
}

pub fn main() -> i32 {
  bind(fmap(Box {value: 1}, inc), wrap).value
}
```

Do notation requires the strategy to spell the effect at its declared arity. Use `_` for value type
arguments inferred by the block:

```fig
pub fn from_option() -> Option(i32) {
  do @monad(Option(_)) {
    x <- some(1);
    pure(x + 1)
  }
}

pub fn from_state(world: World) -> State(World, World) {
  do @monad(State(World, _)) {
    step();
    update_player();
  }
}
```

Do not write bare or partial strategies such as `do @monad(Box)`, `do @monad(Option)`, or
`do @monad(State(World))`. State-threaded strategies still need a concrete state argument, such as
`State(World, _)` rather than `State(_, _)`.

Define applicative-like types with `map`, `pure`, and `apply`:

```fig
fn Box::pure(value: a) -> Box(a) { Box {value: value} }
fn Box::apply(v: Box(fn(x: a) -> b), x: Box(a)) -> Box(b) { Box {value: v.value(x.value)} }
fn inc(x: i32) -> i32 { x + 1 }
pub fn main() -> i32 {
  apply(Box {value: inc}, Box {value: 1}).value
}
```

Use semigroup/monoid patterns for append and empty operations on concrete types:

```fig
fn Point::append(a: Point, b: Point) -> Point {
  Point {x: a.x + b.x, y: a.y + b.y}
}
fn Point::empty() -> Point { Point {x: 0, y: 0} }

pub fn main() -> i32 {
  let total = append(Point {x: 1, y: 2}, Point {x: 3, y: 4});
  total.x + total.y
}
```

Use attached `Option` and `Result` methods for branchless success/failure pipelines:

```fig
const option = @import("prelude.option");

fn inc(x: i32) -> i32 { x + 1 }
fn next(x: i32) -> option.core.Option(i32) { option.some(x + 1) }

pub fn main() -> i32 {
  let maybe = option.core.Option::bind(option.core.Option::map(inc, option.some(1)), next);
  option.core.Option::unwrap_or(maybe, 0)
}
```

Use `prelude.array_static` for static collection-shaped code. Prefer fixed inline arrays and
iterators when the length is known and scalar-local lowering is useful:

```fig
const array = @import("prelude.array_static");

fn inc(x: i32) -> i32 { x + 1 }
fn sum(acc: i32, x: i32) -> i32 { acc + x }

pub fn main() -> i32 {
  let xs: array.Layout.lane4_i32 = [1, 2, 3, 4];
  let ys = array.map4_i32(inc, xs);
  array.fold4_i32(sum, 0, ys)
}
```

Use direct module imports for heap-backed compiler data structures: `prelude.vec`, `prelude.list`,
`prelude.nonempty`, `prelude.queue`, `prelude.tree`, `prelude.zipper`, `prelude.map`,
`prelude.set`, and `prelude.graph`.

Use operator syntax only after importing visible declarations, usually through `prelude.std`.
Functional operator forms lower to attached members:

```fig
const merge = @import("prelude.std");

pub fn mapped() -> Box(i32) { inc <$> Box {value: 1} }
pub fn bound() -> Box(i32) { Box {value: 1} >>= wrap }
pub fn flipped() -> Box(i32) { wrap =<< Box {value: 1} }
```

When implementing new abstractions, keep the contract as a `type fn`, attach runtime behavior with
qualified member functions, evaluate required contracts with local `@assert(Contract(t));` calls,
and rely on specialization to erase the compile-time check and dispatch overhead. Const dictionaries
are still useful for highly specialized static dispatch, but attached members plus local discarded
type-level const calls are the preferred default for typeclass-like APIs.

## Operators

The parser accepts operator symbols made from the operator character set
`+ - * / % < > = ! & | ^ $`. Operator symbols are ordinary source-level
names, not compiler features by themselves:

```fig
+ - * / % == != < <= > >= && || ^^ <> <$> <&> <*> <**> >>= =<< >=> <=<
```

Ranges use dedicated `start .. end` syntax. `..` is not an overloadable operator.

Runtime operator calls are resolved through visible operator declarations. Define an operator as a
top-level fixity declaration that points at a normal function:

```fig
fn add_point(a: Point, b: Point) -> Point { Point::add(a, b) }
infixl 60 (+) = add_point;
```

Current expression syntax resolves runtime binary operators through visible declarations,
using `infix`, `infixl`, or `infixr`. The prelude exposes common operator declarations in
`prelude.operators` and through `prelude.std`. Primitive scalar operators are also source-visible:
`prelude.operators` defines attached members such as `i32::add` and `bool::and` as wrappers around
backend intrinsics like `@i32_add` and `@bool_and`.

Type expressions parse the same operator token, but only primitive type-level operators such as
`==`, `!=`, and literal-type union `|` are currently type-evaluable.

## Branch-Bit Values and Local Bindings

Fig uses Branch-Bit values: ordinary values are immutable, reusable, and can be passed to multiple
functions without explicit borrowing or copying syntax. Local names must be unique within a block;
use fresh names for pure intermediate values:

```fig
let stepped = step(world);
let updated = update_player(stepped);
updated
```

Use `do @monad(State(T, _))` for ordered state transitions:

```fig
let world = do @monad(State(World, _)) {
  step();
  update_player();
}
```

Use explicit `Reader` helpers for read-only context flows. `Reader::ask(env)` is the broadest
pattern; `Reader::asks(env, f)` is useful when `f` is a top-level function known at the call site.
Product-return destructuring uses multi-bind:

```fig
let first, second = make_pair();
```

The binder count must match the flattened product result slots.

## Effects and Capabilities

Declare host imports as external IO actions:

```fig
const clock = @external("clock", fn(host: io) -> io(i32));

pub fn main(host: io) -> io(i32) {
  do @io(_) {
    now <- clock(host);
    return(now)
  }
}
```

Host imports take the `io` executor value explicitly and lower to Wasm imports from module `env`.
Under the stable memory ABI, compound host import params/results cross as `i32` handles and are
described by the emitted `fig.abi` custom section. Use typed `prelude.effect` rows such as
`effect.Eff({state: Store, reader: Env}, A)` for library-level reader/state effect modeling, and
handle them with `run_state` and `run_reader`.

## Heap Runtime Intrinsics

The backend targets WebAssembly and uses branch memories for heap values and the public memory ABI:
`fig_objects` and `fig_buffers`. Public Fig code should model data as values and fixed inline
arrays; explicit source-level memory tokens, pointer wrappers, and memory load/store intrinsics are
no longer part of the language surface. Host embeddings should use the ABI manifest and exported
helpers (`fig_alloc_object`, `fig_alloc_buffer`, `fig_retain`, `fig_release`) rather than relying on
flattened product slots.

Compiler-recognized branch intrinsics such as `@branch_handle`, `@branch_mark`, and
`@branch_ensure_editable` may appear behind narrow internal wrappers. Ordinary Fig modules should
prefer prelude APIs and host IO imports.

## Const Function and Pipe Sugar

Use const-function literals for inline compile-time function arguments:

```fig
map4_i32(\x -> x + 1, [1, 2, 3, 4])
fold4_i32(\(acc, x) -> acc + x, 0, xs)
```

Const-function literals are templates for expected `const fn` parameters. They are not runtime
closure values and cannot capture runtime locals. Use pipe-bind for scoped value flow:

```fig
1 \x -> inc(x) \y -> add(1, y)
```

Fig does not support `|>` pipeline syntax or lambda literals like `\x -> x + 1` as ordinary runtime
expressions.

## Prelude Modules

Prefer `const std = @import("prelude.std");` for normal programs. It imports common pure fragments:

- `prelude.core`: `eq`, `semigroup`, `monoid`, `copyable`, `option`, `result`, tuples, and `index`.
- `prelude.layout`: Scalar, lane, tile, matrix, and fixed inline-array layout aliases.
- `prelude.array_static`: Fixed `lane4_i32` helpers, map/zip/fold/reduce, checked get, bounds, range
  iterators, compact arrays, and iterator map/filter/fold/collect.
- `prelude.function`: `functor`, `applicative`, `monad`, `fmap`, `bind`, `pipe`, `flip`.
- `prelude.monad`: `State(S, A)` and explicit `Reader(R, A)` helpers.
- `prelude.operators`: common operator declarations.
- `prelude.option`, `prelude.result`, `prelude.tuple`, `prelude.scalar`, and `prelude.schedule`.
- `prelude.vec`, `prelude.list`, `prelude.nonempty`, `prelude.queue`, `prelude.tree`,
  `prelude.zipper`, `prelude.map`, `prelude.set`, and `prelude.graph`: heap-backed compiler data
  structures, including graph reachability helpers for dependency checks.
- `prelude.geometry2d`: Fixed 2D vector, color, vertex, quad, and geometry helpers.

Prelude modules are pure and do not declare host IO imports. Fixed inline arrays remain preferred
for static sizes; heap-backed collection modules are available for growth, queues, tree/zippers,
ordered maps/sets, and graph traversal.

## Web Canvas Module

Use `const canvas = @import("web.canvas");` for browser-facing host IO imports and WGSL metadata. It
provides canvas/GPU/event effects, event record helpers, `shader_id`, and `shader_layout`. WGSL
shader layout reflection uses fenced source strings and extracts bindings/locations into the
compiler shader manifest.

## Current Syntax Checklist

Use `type fn` for type-level computation, `match` for branching, attached members for namespaced
operations, `@import` for modules, and `@external` for host imports. Model dictionaries and
typeclass-like evidence as ordinary `type fn` product builders plus `const` Values.
