# Rust Patterns in Fig

This guide maps common Rust idioms to Fig. The closest fit is not a direct syntax translation: Rust
centers traits, impls, ownership, borrowing, and monomorphization. Fig centers type functions,
attached members, erased proof values, Branch-Bit values, and WebAssembly lowering.

The practical rule is:

- Rust `struct` or tuple structs become Fig product types.
- Rust `enum` becomes a Fig `union`.
- Rust inherent `impl Type` methods become attached member functions named `Type::method`.
- Rust trait bounds become `type fn` contracts checked with `@require`.
- Rust generic functions carry evidence explicitly, either as transparent annotations or erased
  `const _proof` parameters.
- Rust ownership and borrowing usually become ordinary value reuse plus fresh names for updates.

## Data Types

Rust:

```rust
struct Point {
    x: i32,
    y: i32,
}
```

Fig:

```fig
type Point = struct {x: i32, y: i32}

fn origin() -> Point {
  Point {x: 0, y: 0}
}
```

For computed layouts, use `type fn`:

```fig
type fn Pair(a: type, b: type) -> struct {
  let Pair = {first: a, second: b};
  struct(Pair)
}
```

Use direct type declaration sugar for fixed layouts and `type fn` when the layout depends on static
parameters, shape reflection, `@require`, or `match`.

## Enums and Pattern Matching

Rust:

```rust
enum Maybe<T> {
    None,
    Some { value: T },
}
```

Fig:

```fig
type Option(a) = union {None, Some(value: a)}

fn unwrap_or(value: Option(i32), fallback: i32) -> i32 {
  match value {
    Some(inner) => inner,
    None => fallback,
  }
}
```

Fig variants are PascalCase constructors. `match` is an expression, so every arm must produce a
compatible result type.

## Inherent Methods

Rust:

```rust
impl Point {
    fn add(a: Point, b: Point) -> Point {
        Point { x: a.x + b.x, y: a.y + b.y }
    }
}
```

Fig:

```fig
fn Point::add(a: Point, b: Point) -> Point {
  Point {x: a.x + b.x, y: a.y + b.y}
}
```

Attached members are ordinary top-level functions with qualified names. They are visible to static
reflection with `@type_has_member` and `@type_member_type`, which is how Fig expresses trait-like
constraints.

Call them directly when the concrete type is known:

```fig
let total = Point::add(Point {x: 1, y: 2}, Point {x: 3, y: 4});
```

## Trait-Like Contracts

Rust:

```rust
trait Draw {
    fn draw(value: Self) -> i32;
}
```

Fig:

```fig
type fn Draw(t: type) -> type {
  let Expected = fn(value: t) -> i32;
  @require(@type_has_member(t, #draw), "Draw requires draw");
  @require(@type_member_type(t, #draw) == Expected, "Draw.draw has wrong type");
  t
}
```

An implementation is just an attached member with the expected signature:

```fig
type Circle = struct {radius: i32}

fn Circle::draw(value: Circle) -> i32 {
  value.radius * 2
}
```

Generic code can use a transparent contract annotation:

```fig
fn draw_twice(value: Draw(t)) -> i32 {
  t::draw(value) + t::draw(value)
}
```

`Draw(t)` checks the contract and returns the runtime type `t`, so the value is still a `t` at
runtime. The contract fact is available inside the function body.

## Explicit Erased Proofs

Rust often lets trait bounds stay implicit:

```rust
fn draw_twice<T: Draw>(value: T) -> i32 { ... }
```

Fig can also pass the proof explicitly:

```fig
fn draw_twice_explicit(value: t, const _proof: Draw(t)) -> i32 {
  t::draw(value) + t::draw(value)
}
```

`const _proof` is evaluated at compile time and erased from runtime calls. Use this style when the
value type should remain visually plain, when the function has several independent constraints, or
when you want to mirror Rust's `where` clause structure.

## Standard Trait Equivalents

The prelude provides small contracts that cover common Rust trait-shaped code:

```fig
const std = @import("prelude.std");
```

Useful contracts include:

| Rust idea             | Fig pattern                                       |
| --------------------- | ------------------------------------------------- |
| `PartialEq` / `Eq`    | `Eq(t)` requiring `t::eql(a, b) -> bool`          |
| `Add`-like append     | `Semigroup(t)` requiring `t::append(a, b) -> t`   |
| `Default` for empty   | `EmptyValue(t)` / `Monoid(t)` with `t::empty()`   |
| `Iterator` step shape | `Iterator(state, item)` with `state::next(state)` |
| `Copy` marker         | `Copyable(t)` as a marker-style contract          |
| `Drop` marker         | `Droppable(t)` as a marker-style contract         |

Example:

```fig
type Point = struct {x: i32, y: i32}

fn Point::append(a: Point, b: Point) -> Point {
  Point {x: a.x + b.x, y: a.y + b.y}
}

fn add_points(a: Point, b: Point) -> Point {
  append(Point, Semigroup(Point), a, b)
}
```

The `append` helper comes from `prelude.core` through `prelude.std`. The proof parameter is explicit
at the call site, so there is no hidden trait search.

## Generic Type Constructors

Rust generic associated type and higher-kinded patterns often become Fig type constructor
parameters.

```fig
type fn Mapper(f: type fn(a: type) -> type) -> type {
  let Expected = fn(const map: fn(x: a) -> b, v: f(a)) -> f(b);
  @require(@type_has_member(f, #map), "Mapper requires map");
  @require(@type_member_type(f, #map) == Expected, "Mapper.map has wrong type");
  f(i32)
}
```

The prelude already defines `Functor`, `Applicative`, and `Monad` this way. A unary type constructor
such as `Box(a)` can satisfy them by attaching `Box::map`, `Box::pure`, `Box::apply`, and
`Box::bind`.

```fig
type Box(a) = struct {value: a}

fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
  Box {value: f(v.value)}
}
```

Then generic code can require `Functor(Box)`:

```fig
fn mapped(v: t(a), const f: fn(x: a) -> b, const _proof: Functor(t)) -> t(b) {
  t::map(f, v)
}
```

## Ownership and Borrowing

Fig does not expose Rust-style moves, borrows, mutable references, lifetimes, or `unsafe` pointer
blocks in source code. The source model is Branch-Bit values:

```fig
let stepped = step(world);
let updated = update_player(stepped);
updated
```

Passing a value does not consume it:

```fig
let a = score(world);
let b = render_cost(world);
a + b
```

Use fresh names for new logical versions. The backend decides whether that becomes scalar locals,
copy-before-write heap handles, or no runtime copy at all.

Rust mutable update:

```rust
world.step();
world.update_player();
```

Fig ordered update:

```fig
let world2 = step(world);
let world3 = update_player(world2);
world3
```

When ordering is semantically part of the program, use `State`:

```fig
const monad = @import("prelude.monad");

fn update() -> monad.State(World, World) {
  do @monad(monad.State(World, _)) {
    current <- monad.State::get();
    let next = step(current);
    monad.State::put(next);
    monad.State::get()
  }
}
```

## Error Handling

Rust `Result<T, E>` maps to a Fig union:

```fig
const std = @import("prelude.std");

fn checked(value: i32) -> Result(i32, i32) {
  match value == 0 {
    true => Err {error: 1},
    false => Ok {value},
  }
}

fn use_result(value: Result(i32, i32)) -> i32 {
  match value {
    Ok(inner) => inner,
    Err(code) => code.error,
  }
}
```

Prelude `Option` and `Result` modules provide `map`, `bind`, `unwrap_or`, and related helpers. Use
`match` when the branch behavior is domain-specific; use attached members when you want reusable
pipelines.

## Closures, Function Values, and Callbacks

Rust closures that capture runtime locals do not translate directly to ordinary Fig runtime lambdas.
Fig has const-function templates for compile-time function parameters:

```fig
fn map_one(value: i32, const f: fn(x: i32) -> i32) -> i32 {
  f(value)
}
```

Use top-level functions when possible:

```fig
fn inc(x: i32) -> i32 { x + 1 }

fn run() -> i32 {
  map_one(41, inc)
}
```

For scoped value flow, use pipe-bind:

```fig
load_config()
  \config -> run_with_config(config)
```

Fig intentionally does not support `|>` pipeline syntax.

## Dynamic Dispatch

Rust `dyn Trait` has no direct Fig equivalent today. Prefer:

- A `union` when the set of cases is known.
- A `type fn` contract and specialization when the type is static.
- A host-side handle or external import when the value is truly dynamic outside Wasm.
- A runtime function value only for internal callback-shaped code that does not cross the public
  Wasm ABI.

If you would write `Box<dyn Draw>` in Rust, first ask whether the set of variants is known:

```fig
type Shape = union {
  Circle(radius: i32),
  Rect(width: i32, height: i32)
}

fn draw(value: Shape) -> i32 {
  match value {
    Circle(circle) => circle.radius * 2,
    Rect(rect) => rect.width + rect.height,
  }
}
```

## Modules and Visibility

Rust modules and imports map to Fig source imports:

```fig
const std = @import("prelude.std");
const array = @import("prelude.array_static");
const { map4_i32 } = @import("prelude.array_static");
```

`pub fn` exports through the WebAssembly ABI. A public function must have an explicit return
annotation; `-> _` is allowed when the checker resolves it before ABI checking.

## What Not To Translate Literally

- Do not introduce source-level ownership markers. Fig has no `move`, `borrow`, `&`, `&mut`, or
  lifetime syntax.
- Do not expect implicit trait solving. Carry contracts in annotations or proof parameters.
- Do not use Rust-style method receiver syntax. Use attached members such as `Point::add(a, b)`.
- Do not model every Rust iterator as a heap object. Prefer fixed inline arrays, range iterators, or
  explicit state machines.
- Do not use dynamic dispatch when static specialization or a `union` is enough.

## Checklist

When porting Rust-shaped code to Fig:

1. Define data first with `type` sugar or `type fn`.
2. Attach behavior as `Type::member` functions.
3. Define contracts with `type fn` and `@require`.
4. Pick transparent annotations for simple bounds and erased `const _proof` parameters for explicit
   generic evidence.
5. Replace mutable updates with fresh values or `State`.
6. Replace `Result`/`Option` flows with unions, `match`, or prelude methods.
7. Inspect public boundary behavior with `fig wat`, `fig run`, and the stable memory ABI docs.
