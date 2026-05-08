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
- Use `docs/reference/types.md` for primitive, function, shape/product/union, repeat, and
  constructor types.
- Use `docs/reference/expressions.md` for calls, constructors, match, operators, pipe-bind, `$`,
  `fork`, and destructuring.
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

Use `///` doc comments when writing Fig declarations or bindings that should carry raw markdown
metadata for future hover tooling. The compiler stores the stripped text on the checked AST; there
is no hover UI or TSDoc parsing yet.

Doc comments attach only to the immediately following binding when there is no blank line, ordinary
`//` comment, or code between the comment block and the binding. Multiple contiguous `///` lines
join with `\n`; the leading `///` and at most one following space are stripped.

```fig
/// Adds two values.
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

/// A generic point type.
type fn point(
  /// Coordinate type.
  A: type
) -> struct {
  /// Product shape.
  let Point = [
    /// Horizontal coordinate.
    x: A,
    /// Vertical coordinate.
    y: A,
  ];
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

Write Fig files with `.fig` extension. A program is a sequence of declarations:

- `type fn` declarations for compile-time type functions.
- `const` declarations for compile-time constants, dictionaries, capabilities, and imports.
- `fn` or `pub fn` declarations for value functions.
- Top-level `let` declarations for simple values.

Import modules with namespace aliases:

```fig
const std = @import("prelude.std");
const local = @import("./local_module.fig");
```

Imported declarations are qualified through the alias, including nested imports such as
`std.array.layout.lane4_i32`. The alias is an ordinary namespace alias; it does not merge imported
names into the current scope. Duplicate aliases are rejected.

## Names and Visibility

- Type function names are lowercase, including type constructor references such as `pair(i32)`.
- Product constructor names are PascalCase and are introduced by `struct(Shape)`.
- Runtime function names are lowercase and may be qualified as attached members, such as `point.eql`
  or `box.map`.
- `pub fn` exports through the Wasm backend and must include an explicit return signature.
- Non-public helper functions may omit `pub` but still need parseable parameter and return forms
  when used by the checker.

## Literals and Primitive Types

Use these literal forms:

- Numbers: `42`, `42i32`, `1u32`, `1i64`, `1u64`, `1.0f32`, `1.0f64`.
- Booleans: `true`, `false`.
- Characters and strings: `'x'`, `"fig"`.
- Fenced text: triple backticks, useful for WGSL shader source.
- Literal type tags: `#Tag`, `#field`, `#infixl`.

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
- Literal clauses such as `fn choose(1: i32) -> i32 { 10 }` ordered before broader clauses.
- `_ : Type` placeholders.
- Pattern identifiers for sum variants in limited clause contexts.

Multiple clauses with the same function name are ordered and checked for compatible arity and return
types. Use repeated function definitions when you want to check several parameter values at once;
the first matching clause wins. Const parameters specialize at call sites and are erased from
generated runtime parameters.

Function types use `fn(...) -> Type`; const function parameters enable compile-time specialization:

```fig
fn map4(const f: fn(x: i32) -> i32, xs: [4*i32]) -> [4*i32] {
  [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
}
```

## Blocks and Expressions

Blocks contain `let` statements, local proof `const` declarations, and a final expression:

```fig
pub fn main() -> i32 {
  let x = 1;
  const Proof = eq(point);
  x + 1
}
```

Supported expressions include:

- Function calls: `f(x)`.
- Field access: `point.x`.
- Indexing: `xs[0]`.
- Product construction: `Point [x: 1, y: 2]` or `[1, 2]` where the type is known.
- Shape values: `[x: 1, y: 2]`.
- `match value { pattern => expr, _ => fallback }`.
- Binary operators listed in `grammar.ebnf`.
- Ranges: `start .. end`.
- Pipe-bind: `expr \name -> next` and placeholder form `expr \$ -> use($)`.

There is no `if`; use `match` on `bool`. There is no assignment statement; bind new locals with
`let`. Let statements require semicolons.

## Pattern Matching and Ordered Clauses

Use `match` instead of `if`. A `match` expression has one scrutinee expression and ordered arms.
Patterns support `_`, literals, lowercase bindings, PascalCase variant names, and variant payload
deconstruction:

```fig
fn unwrap_or(value: option(i32), fallback: i32) -> i32 {
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
type fn point() -> struct {
  let Point = [x: i32, y: i32];
  struct(Point)
}

type fn option(A: type) -> union {
  let None = [];
  let Some = [value: A];
  union(None, Some)
}
```

Shape slots may be labeled or anonymous. Counted inline arrays use repeat syntax:

```fig
type fn inline_array(N: count, A: type) -> type {
  let InlineArray = [N*A];
  struct(InlineArray)
}
```

Indexing a fixed inline array with a literal is bounds-checked. Dynamic indexing requires an
`index(N)` proof type matching the array length; otherwise use a checked helper that returns an
`option`.

## Type Functions

Type functions run at compile time and return `type`, `struct`, `union`, or `operator`:

```fig
type fn id() -> type { i32 }
type fn pair(A: type, B: type) -> struct {
  let Pair = [first: A, second: B];
  struct(Pair)
}
```

Parameter kinds include:

- `type`
- `count`
- `const`
- type constructors such as `type fn(A: type) -> type`
- result-constrained constructors such as `type fn(A: type) -> struct`

Use PascalCase names for type parameters. Literal and wildcard clauses are allowed for ordered type
function dispatch, for example `type fn choose(i32: type) -> type { bool }`.

Inside type functions:

- Use `let` or `const` with PascalCase local names.
- Return a final type expression.
- Use `match` for static branching.
- Use `@compile_error("message")` or `@require(condition, "message")` for diagnostics.
- Do not call effectful host capabilities from type-level evaluation.

## Static Reflection and Shape Builtins

Use static builtins only with the `@` prefix. Current reflection helpers include:

- Type predicates: `@type_is_product(T)`, `@type_has_slot(T, #field)`,
  `@type_has_variant(T, #Some)`, `@type_variant_has_slot(T, #Some, #value)`,
  `@type_has_member(T, #map)`.
- Type lookup: `@type_slot_type(T, #field)`, `@type_member_type(T, #member)`, `@type_slots(T)`,
  `@type_variants(T)`, `@type_variant_slots(T, #Variant)`.
- Shape operations: `@shape_has_slot`, `@shape_slot`, `@shape_count`, `@shape_pick`, `@shape_omit`,
  `@shape_intersect`, `@shape_difference`, `@shape_rename`, `@shape_map`, `@shape_map_with_key`,
  `@shape_filter`, `@shape_concat`.

Shape maps require mapper type functions. `@shape_map_with_key` and `@shape_filter` mappers take
`(Key: const, Value: const)`. `@shape_filter` predicates must return `bool`. Generated shape fields
must be labeled, and duplicate generated labels are rejected.

## Static Contracts and Attached Members

Model typeclasses as ordinary type functions plus attached member functions:

```fig
fn point.eql(a: point, b: point) -> bool { a.x == b.x }

type fn eq(T: type) -> type {
  let Expected = fn(a: T, b: T) -> bool;
  @require(@type_has_member(T, #eql), "Eq requires eql");
  @require(@type_member_type(T, #eql) == Expected, "Eq.eql has wrong type");
  T
}
```

Attached members use qualified function names, are discoverable through type reflection, and can be
called statically as `T.map(...)` inside generic code. Local proof consts such as
`const Mapper = functor(T);` are erased after they prove the contract.

Const dictionaries are product-shaped constants whose fields are function references:

```fig
const point_eq: eq(point) = [eql: point.eql, neq: point.neq];
```

Fields must match the annotated product shape, and slot values must be function references rather
than runtime calls.

## Functional Programming Patterns

Prefer ordinary Fig functions plus erased static contracts for functional abstractions. Import
`prelude.std` when possible.

Use const function parameters for higher-order helpers. They specialize away at call sites:

```fig
fn twice(value: A, const f: fn(x: A) -> A) -> A {
  f(f(value))
}

fn inc(x: i32) -> i32 { x + 1 }
pub fn main() -> i32 { twice(1, inc) }
```

Use point-free helpers from `prelude.function` or `prelude.std` for small compositions: `identity`,
`constant`, `compose`, `pipe`, `apply_to`, and `flip`.

Define functor-like types by attaching a `map` member to a unary type constructor:

```fig
type fn box(A: type) -> type {
  let Box = [value: A];
  struct(Box)
}

fn box.map(const f: fn(x: A) -> B, v: box(A)) -> box(B) {
  Box [value: f(v.value)]
}

fn inc(x: i32) -> i32 { x + 1 }

pub fn main() -> i32 {
  fmap(Box [value: 1], inc, functor(box)).value
}
```

Define monad-like types by attaching both `map` and `bind`:

```fig
fn box.bind(v: box(A), const f: fn(x: A) -> box(B)) -> box(B) {
  f(v.value)
}

fn wrap(x: i32) -> box(i32) {
  Box [value: x + 10]
}

pub fn main() -> i32 {
  bind(fmap(Box [value: 1], inc, functor(box)), wrap, monad(box)).value
}
```

Define applicative-like types with `map`, `pure`, and `apply`:

```fig
fn box.pure(value: A) -> box(A) { Box [value: value] }
fn box.apply(v: box(fn(x: A) -> B), x: box(A)) -> box(B) { Box [value: v.value(x.value)] }
fn proof(const _proof: applicative(box)) -> i32 { 0 }
```

Use semigroup/monoid patterns for append and empty operations on concrete types:

```fig
fn point.append(a: point, b: point) -> point {
  Point [x: a.x + b.x, y: a.y + b.y]
}
fn point.empty() -> point { Point [x: 0, y: 0] }

pub fn main() -> i32 {
  let total = append(point, semigroup(point), Point [x: 1, y: 2], Point [x: 3, y: 4]);
  total.x + total.y
}
```

Use `option` and `result` helpers for branchless success/failure pipelines:

```fig
const option = @import("prelude.option");

fn inc(x: i32) -> i32 { x + 1 }
fn next(x: i32) -> option.core.option(i32) { option.some(x + 1) }

pub fn main() -> i32 {
  let maybe = option.option_and_then(option.option_map(option.some(1), inc), next);
  option.option_unwrap_or(maybe, 0)
}
```

Use `prelude.array_static` for collection-shaped code. Prefer fixed inline arrays and iterators over
heap-backed vectors:

```fig
const array = @import("prelude.array_static");

fn inc(x: i32) -> i32 { x + 1 }
fn sum(acc: i32, x: i32) -> i32 { acc + x }

pub fn main() -> i32 {
  let xs: array.layout.lane4_i32 = [1, 2, 3, 4];
  let ys = array.map4_i32(inc, xs);
  array.fold4_i32(sum, 0, ys)
}
```

Use operator syntax only after importing visible descriptors, usually through `prelude.std`.
Functional operator forms lower to attached members:

```fig
const merge = @import("prelude.std");

pub fn mapped() -> box(i32) { inc <$> Box [value: 1] }
pub fn bound() -> box(i32) { Box [value: 1] >>= wrap }
```

When implementing new abstractions, keep the contract as a `type fn`, attach runtime behavior with
qualified member functions, pass proof values as `const _proof` parameters, and rely on
specialization to erase proof and dispatch overhead.

## Operators

Built-in parser symbols include arithmetic, comparison, boolean, append, applicative, functor,
monad, range, and `zip` symbols:

```fig
+ - * / % == != < <= > >= && || ^^ <> <$> <*> >>= zip ..
```

Runtime operator calls are resolved through visible operator descriptors. Define descriptors with a
type function returning `operator`:

```fig
type fn op_add(T: type) -> operator {
  operator(#infixl, 60, "+", T.add)
}
```

Supported fixity tags are `#infix`, `#infixl`, and `#infixr`. The prelude exposes common operator
descriptors in `prelude.operators` and through `prelude.std`.

## Ownership and Forking

Fig tracks moves for values. Passing a value to a function consumes it unless the operation is known
to borrow it. Reusing a moved local is rejected.

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

The arity must match the flattened product result.

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
fn memory.load_i32(mem: memory, p: ptr(i32)) -> i32 { @memory_load_i32(mem, p) }
fn memory.store_i32(mem: memory, p: ptr(i32), value: i32) -> memory {
  @memory_store_i32(mem, p, value)
}
fn ptr.from_i32(addr: i32) -> ptr(A) { @ptr_from_i32(addr) }
fn ptr.add(p: ptr(A), bytes: i32) -> ptr(A) { @ptr_add(p, bytes) }
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
- `prelude.layout`: scalar, lane, tile, matrix, pointer-oriented layout aliases.
- `prelude.array_static`: fixed `lane4_i32` helpers, map/zip/fold/reduce, checked get, bounds, range
  iterators, compact arrays, and iterator map/filter/fold/collect.
- `prelude.function`: `functor`, `applicative`, `monad`, `fmap`, `bind`, `pipe`, `flip`.
- `prelude.operators`: common operator descriptors.
- `prelude.option`, `prelude.result`, `prelude.tuple`, `prelude.bool`, `prelude.num`,
  `prelude.order`, and `prelude.schedule`.
- `prelude.geometry2d`: fixed 2D vector, color, vertex, quad, and geometry helpers.

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
typeclass-like evidence as ordinary `type fn` product builders plus `const` values.
