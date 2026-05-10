---
name: fig-language
description: Complete reference for Fig language syntax, typing, compile-time type functions, ownership, effects, imports, standard prelude modules, WebAssembly lowering, and current compiler constraints. Use when Codex needs to write, read, debug, test, document, or explain .fig programs in this repository.
---

# Fig Language

Use this skill when working on Fig source files, examples, prelude modules, parser/checker behavior,
or language documentation. Treat the implementation and tests as the source of truth; this file
summarizes the current supported surface.

## Canonical References

- Use `docs/LANGUAGE.md` as the language index and reading order.
- Use `docs/reference/syntax.md` for declarations, params, blocks, patterns, literals, imports, and
  capabilities.
- Use `docs/reference/types.md` for primitive, function, tuple, shape/product/union, repeat, borrow,
  frozen, and constructor types.
- Use `docs/reference/expressions.md` for calls, constructors, tuples, collections, borrows, match,
  operators, pipe-bind, `$`, `fork`, and destructuring.
- Use `docs/reference/type-functions.md` for type blocks, result kinds, parameters, `struct`,
  `union`, `operator`, and type matches.
- Use `docs/reference/builtins.md` for every `@...` compiler builtin and backend intrinsic.
- Use `docs/reference/semantics.md` for ownership, effects, const evaluation, reflection, and Wasm
  portability constraints.
- Use `docs/reference/modules.md` for prelude/web/engine module roles.
- Use `docs/EXAMPLES.md` and `tests/fixtures/language` for tested good/bad reference examples.
- Start with `grammar.ebnf` for accepted syntax.
- Use `examples/all_features.fig` as the compact language tour.
- Use `README.md` for the intended positioning of type functions, prelude use, and portability.
- Use `tests/compiler_test.ts` for edge cases, diagnostics, and checker semantics.
- Use `tests/prelude_test.ts` for prelude, operators, web canvas, and library behavior.
- Use `tests/examples_test.ts` and `tests/backend_ir_test.ts` for WebAssembly/import behavior.
- Use `prelude/*.fig` and `web/canvas.fig` for library APIs.

## Doc Comments

Use `///` doc comments when writing Fig declarations or bindings that should carry markdown
metadata for editor hovers. The compiler stores the stripped text on the checked AST, and the LSP
renders it below the symbol signature when available. Well-formed TSDoc-style tags are accepted by
the hover renderer.

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
type-block lets; local lets and proof consts; and shape fields. Use ordinary `//` only for
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

Write Fig files with `.fig` extension. a program is a sequence of declarations:

- `type fn` declarations for compile-time type functions.
- `const` declarations for compile-time constants, dictionaries, capabilities, and imports.
- `fn` or `pub fn` declarations for value functions.
- Top-level `let` declarations for simple Values.

Import modules with namespace aliases:

```fig
const std = @import("prelude.std");
const local = @import("./local_module.fig");
```

Imported declarations are qualified through the alias, including nested imports such as
`std.array.Layout.lane4_i32`. The alias is an ordinary namespace alias; it does not merge imported
names into the current scope. Duplicate aliases are rejected.

Use destructured source imports only for exact top-level declarations:

```fig
const { map4_i32, lane4_add_i32 } = @import("prelude.array_static");
```

Destructured imports do not support aliases, dotted names, type annotations, or non-`@import`
right-hand sides.

## Names and Visibility

- Type function names are lowercase, including type constructor references such as `Pair(i32)`.
- Product constructor names are PascalCase and are introduced by `struct(Shape)`.
- Runtime function names are lowercase and may be qualified as attached members, such as `Point.eql`
  or `Box.map`.
- `pub fn` exports through the Wasm backend and must include an explicit return signature.
- Non-public helper functions may omit `pub` but still need parseable parameter and return forms
  when used by the checker.

## Literals and Primitive Types

Use these literal forms:

- Numbers: `42`, `42i32`, `1u32`, `1i64`, `1u64`, `1.0f32`, `1.0f64`.
- Booleans: `true`, `false`.
- Characters and strings: `'x'`, `"fig"`.
- Fenced text: Triple backticks, useful for WGSL shader source.
- Literal type tags: `#Tag`, `#field`, `#infixl`.
- Tuple and repeat values: `[1, true]`, `[0; 4]`.
- Target-typed collection literals: `<1, 2, 3>`, including spread such as `<0, ...rest>`.
- Frozen collection literals: `#[1, 2, 3]` when the expected type is frozen.

Unsuffixed integer literals default from context, commonly to `i32`. Current primitive scalar types
include `bool`, `i32`, `i64`, `u32`, `u64`, `f32`, `f64`, `string`, `memory`, and arbitrary unsigned
integer widths `u1` through `u64`. Narrow unsigned fields may be storage-packed in product layouts.

## Functions

Declare functions with `fn name(params) -> Type !{effects} { ... }`:

```fig
fn add(a: i32, b: i32) -> i32 { a + b }
pub fn main() -> i32 { add(40, 2) }
```

Parameter forms include:

- `name: Type`
- `const name: Type` for static function/dictionary/type parameters.
- `name: &(Type)` for call-scoped borrowed parameters.
- Literal clauses such as `fn Choose(1: i32) -> i32 { 10 }` ordered before broader clauses.
- `_ : Type` placeholders.
- Pattern identifiers for sum variants and tuple destructuring in supported clause contexts.

Multiple clauses with the same function name are ordered and checked for compatible arity and return
types. Use repeated function definitions when you want to check several parameter values at once;
the first matching clause wins. Const parameters specialize at call sites and are erased from
generated runtime parameters.

Function types use `fn(...) -> Type`; const function parameters enable compile-time specialization:

```fig
fn Map4(const f: fn(x: i32) -> i32, xs: {4*i32}) -> {4*i32} {
  [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
}
```

## Blocks and Expressions

Blocks contain `let` statements, local proof `const` declarations, and a final expression:

```fig
pub fn main() -> i32 {
  let x = 1;
  const Proof = Eq(point);
  x + 1
}
```

Supported expressions include:

- Function calls: `f(x)`.
- Field access: `Point.x`.
- Indexing: `xs[0]`.
- Product construction: `Point {x: 1, y: 2}` with labeled, positioned, punned, spread, or static
  generated slots.
- Shape values: `{x: 1, y: 2}`, `{x, y}`, `{...base, z: 3}`, and
  `{for Key, Spec in (fields): value}`.
- Tuple and repeat values: `[1, 2]`, `[0; 4]`.
- Target-typed collection literals: `<1, 2, 3>`, `<0, ...rest>`.
- Borrow expressions: `&value` for `&(Type)` parameters.
- `match value { pattern => expr, _ => fallback }`.
- Binary operators listed in `grammar.ebnf`.
- Ranges: `start .. end`.
- Pipe-bind: `expr \name -> next` and placeholder form `expr \$ -> use($)`.

There is no `if`; use `match` on `bool`. There is no assignment statement; bind new locals with
`let`. Let statements require semicolons.

## Pattern Matching and Ordered Clauses

Use `match` instead of `if`. a `match` expression has one scrutinee expression and ordered arms.
Patterns support `_`, literals, lowercase bindings, PascalCase variant names, and variant payload
deconstruction:

```fig
fn unwrap_or(value: Option(i32), fallback: i32) -> i32 {
  match value { Some(inner) => inner, None => fallback }
}
```

Use repeated function definitions for multi-value case analysis. Clauses resolve in source order,
and every parameter pattern in a clause is checked together:

```fig
fn score(true: bool, true: bool) -> i32 { 3 }
fn score(_: bool, _: bool) -> i32 { 0 }
```

Value function clauses must keep the same arity, visibility, return type, effect row, and parameter
types. Current value-clause dispatch is best for literal, wildcard, and binding cases; use `match`
arms for sum-variant payload deconstruction. Type functions also support ordered clauses and `match`
over static values and types.

## Products, Sums, Shapes, and Arrays

Define concrete product and sum layouts with type functions:

```fig
type fn Point() -> struct {
  let Point = {x: i32, y: i32};
  struct(Point)
}

type fn Option(a: type) -> union {
  let None = {};
  let Some = {value: a};
  union(None, Some)
}
```

Shape slots may be labeled or anonymous. Counted inline arrays use repeat syntax:

```fig
type fn InlineArray(n: count, a: type) -> type {
  let InlineArray = {n*a};
  struct(InlineArray)
}
```

Indexing a fixed inline array with a literal is bounds-Checked. Dynamic indexing requires an
`Index(N)` proof type matching the array length; otherwise use a checked helper that returns an
`option`.

Tuple types use brackets, such as `[i32, bool]` and `[i32; 4]`. Shape and product types use braces.
Borrowed and frozen types use `&(t)` and `#(t)`.

## Type Functions

Type functions run at compile time and return `type`, `struct`, `union`, or `operator`:

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

Use PascalCase names for type parameters. Literal and wildcard clauses are allowed for ordered type
function dispatch, for example `type fn Choose(i32: type) -> type { bool }`.

Inside type functions:

- Use `let` or `const` with PascalCase local names.
- Return a final type expression.
- Use `match` for static branching.
- Use `@compile_error("message")` or `@require(condition, "message")` for diagnostics.
- Do not call effectful host capabilities from type-level evaluation.

When choosing a type-function pattern:

- If you intend to define a runtime data layout, write a `type fn`, bind a PascalCase shape, and
  return `struct(Shape)` or `union(...)`.
- If you intend to require behavior on a type, write a contract `type fn` with `@require` and
  attached members such as `t.eql`, `t.append`, or `t.map`.
- If you intend generic runtime helpers with no runtime proof cost, pass `const _proof:
  contract(t)` and call attached members through `t.member(...)`.
- If you intend to abstract over a unary type constructor, accept `t: type fn(a: type) -> type`,
  use values as `t(a)`, and reflect members on `t`.
- If you intend type-directed construction or dispatch, pass the type as `const t` or
  `const t: type`; avoid modeling types as runtime Values.
- If ordinary value parameters already determine the type, prefer inference. Pass `const t`
  explicitly only for otherwise unpinned cases such as `Empty(t)`, `pure(t, ...)`, or explicit
  static dispatch.
- If you intend static layout/count specialization, use `const n: count`, `const a: type`, or
  another `const` parameter.

## Static Reflection and Shape Builtins

Use static builtins only with the `@` prefix. Current reflection helpers include:

- Type predicates: `@type_is_product(t)`, `@type_has_slot(t, #field)`,
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
fn Point.eql(a: Point, b: Point) -> bool { a.x == b.x }

type fn Eq(t: type) -> type {
  let Expected = fn(a: t, b: t) -> bool;
  @require(@type_has_member(t, #eql), "Eq requires eql");
  @require(@type_member_type(t, #eql) == Expected, "Eq.eql has wrong type");
  t
}
```

Attached members use qualified function names, are discoverable through type reflection, and can be
called statically as `t.map(...)` inside generic code. Local proof consts such as
`const Mapper = Functor(t);` are erased after they prove the contract.

Const dictionaries are product-shaped constants whose fields are function references:

```fig
const point_eq: Eq(point) = {eql: Point.eql, neq: Point.neq};
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
type fn Box(a: type) -> type {
  let Box = {value: a};
  struct(Box)
}

fn Box.map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
  Box {value: f(v.value)}
}

fn inc(x: i32) -> i32 { x + 1 }

pub fn main() -> i32 {
  fmap(Box {value: 1}, inc, Functor(box)).value
}
```

Define monad-like types by attaching both `map` and `bind`:

```fig
fn Box.bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {
  f(v.value)
}

fn wrap(x: i32) -> Box(i32) {
  Box {value: x + 10}
}

pub fn main() -> i32 {
  bind(fmap(Box {value: 1}, inc, Functor(box)), wrap, Monad(box)).value
}
```

Define applicative-like types with `map`, `pure`, and `apply`:

```fig
fn Box.pure(value: a) -> Box(a) { Box {value: value} }
fn Box.apply(v: Box(fn(x: a) -> b), x: Box(a)) -> Box(b) { Box {value: v.value(x.value)} }
fn Proof(const _proof: Applicative(box)) -> i32 { 0 }
```

Use semigroup/monoid patterns for append and empty operations on concrete types:

```fig
fn Point.append(a: Point, b: Point) -> Point {
  Point {x: a.x + b.x, y: a.y + b.y}
}
fn Point.empty() -> Point { Point {x: 0, y: 0} }

pub fn main() -> i32 {
  let total = append(point, Semigroup(point), Point {x: 1, y: 2}, Point {x: 3, y: 4});
  total.x + total.y
}
```

Use `option` and `result` helpers for branchless success/failure pipelines:

```fig
const option = @import("prelude.Option");

fn inc(x: i32) -> i32 { x + 1 }
fn next(x: i32) -> Option.core.Option(i32) { Option.some(x + 1) }

pub fn main() -> i32 {
  let maybe = Option.option_and_then(Option.option_map(Option.some(1), inc), next);
  Option.option_unwrap_or(maybe, 0)
}
```

Use `prelude.array_static` for collection-shaped code. Prefer fixed inline arrays and iterators over
heap-backed vectors:

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

Use operator syntax only after importing visible descriptors, usually through `prelude.std`.
Functional operator forms lower to attached members:

```fig
const merge = @import("prelude.std");

pub fn mapped() -> Box(i32) { inc <$> Box {value: 1} }
pub fn bound() -> Box(i32) { Box {value: 1} >>= wrap }
```

When implementing new abstractions, keep the contract as a `type fn`, attach runtime behavior with
qualified member functions, pass proof values as `const _proof` parameters, and rely on
specialization to erase proof and dispatch overhead. Const dictionaries are still useful for highly
specialized static dispatch, but attached members plus erased proof parameters are the preferred
default for typeclass-like APIs.

## Operators

Built-in parser symbols include arithmetic, comparison, boolean, append, applicative, functor,
monad, range, and `zip` symbols:

```fig
+ - * / % == != < <= > >= && || ^^ <> <$> <*> >>= zip ..
```

Runtime operator calls are resolved through visible operator descriptors. Define descriptors with a
type function returning `operator`:

```fig
type fn OpAdd(t: type) -> operator {
  operator(#infixl, 60, "+", t.add)
}
```

Current expression syntax resolves user-defined binary operators through visible descriptors,
usually `#infix`, `#infixl`, or `#infixr`. The prelude exposes common operator descriptors in
`prelude.operators` and through `prelude.std`.

## Ownership and Forking

Fig tracks moves for Values. Passing a value to a function consumes it unless the operation is known
to borrow it. Reusing a moved local is rejected.

Use `&value` only for a call-scoped borrow into an `&(Type)` parameter:

```fig
fn sum(p: &(point)) -> i32 { p.x + p.y }
let total = sum(&point);
```

Borrowed values cannot be stored, returned, or passed as owned parameters.

Use `fork(value)` to create multiple owned copies:

```fig
let original = 1;
let a, b, c = fork(original);
```

Only a local variable may be forked. Forking consumes the original. Product-return destructuring
also uses multi-bind:

```fig
let first, second = make_pair();
```

The arity must match the flattened product Result.

## Effects and Capabilities

Declare host imports as const capabilities:

```fig
const clock: fn() -> i32 !{time} = @capability("clock");
pub fn main() -> i32 !{time} { clock() }
```

Calling an effectful host function from a pure function is rejected. Effect rows use `!{name}` or
`!{}` and must cover the host capabilities used by the function. Capabilities lower to Wasm imports
from module `env`.

## Memory and Wasm Intrinsics

The backend targets WebAssembly and supports explicit memory tokens and pointer wrappers. Intrinsic
wrappers use normal Fig functions whose body is a compiler primitive:

```fig
fn memory.load_i32(mem: memory, p: Ptr(i32)) -> i32 { @memory_load_i32(mem, p) }
fn memory.store_i32(mem: memory, p: Ptr(i32), value: i32) -> memory {
  @memory_store_i32(mem, p, value)
}
fn Ptr.from_i32(addr: i32) -> Ptr(a) { @ptr_from_i32(addr) }
fn Ptr.add(p: Ptr(a), bytes: i32) -> Ptr(a) { @ptr_add(p, bytes) }
```

Loads borrow the memory token; stores consume and return a new memory token. Lane intrinsics such as
`@memory_load_lane4_i32` and `@memory_store_lane4_i32` are available for fixed lanes.

## Placeholder and Pipe Sugar

Use `$` only in const function helper contexts, such as a const function argument:

```fig
map4_i32($ + 1, [1, 2, 3, 4])
```

The placeholder creates a unary helper and cannot capture runtime locals. Use pipe-bind for scoped
value flow:

```fig
1 \$ -> inc($) \y -> add(1, y)
```

Fig does not support `|>` pipeline syntax or lambda literals like `\x -> x + 1` as ordinary
expressions.

## Prelude Modules

Prefer `const std = @import("prelude.std");` for normal programs. It imports common pure fragments:

- `prelude.core`: `eq`, `semigroup`, `monoid`, `copyable`, `option`, `result`, tuples, `index`,
  `ptr`, memory helpers.
- `prelude.layout`: Scalar, lane, tile, matrix, pointer-oriented layout aliases.
- `prelude.array_static`: Fixed `lane4_i32` helpers, map/zip/fold/reduce, checked get, bounds, range
  iterators, compact arrays, and iterator map/filter/fold/collect.
- `prelude.function`: `functor`, `applicative`, `monad`, `fmap`, `bind`, `pipe`, `flip`.
- `prelude.operators`: common operator descriptors.
- `prelude.option`, `prelude.result`, `prelude.tuple`, `prelude.bool`, `prelude.num`,
  `prelude.order`, and `prelude.schedule`.
- `prelude.geometry2d`: Fixed 2D vector, color, vertex, quad, and geometry helpers.

Prelude modules are pure and do not declare host capabilities. Heap-backed lists, growable vectors,
allocation-backed append, `push`, `pop`, and `reserve` are intentionally absent.

## Web Canvas Module

Use `const canvas = @import("web.canvas");` for browser-facing host capabilities and WGSL metadata.
It provides canvas/GPU/event capabilities, event record helpers, `shader_id`, and `shader_layout`.
WGSL shader layout reflection uses fenced source strings and extracts bindings/locations into the
compiler shader manifest.

## Current Syntax Checklist

Use `type fn` for type-level computation, `match` for branching, attached members for namespaced
operations, `@import` for modules, and `@capability` for host imports. Model dictionaries and
typeclass-like evidence as ordinary `type fn` product builders plus `const` Values.
