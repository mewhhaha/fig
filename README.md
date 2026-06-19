# Fig

Fig is an experimental language and compiler for building portable WebAssembly modules from
statically checked source. It is designed around compile-time type functions, erased contracts,
immutable reusable values, and explicit host IO, so libraries can describe data layout and behavior
in Fig instead of relying on hidden compiler shortcuts.

Fig is useful when you want the shape control of systems programming, the static composition
patterns of functional languages, and a Wasm-first output target with a predictable host boundary.

## What Makes Fig Different

- **Type functions compute types.** Use ordinary compile-time programs to build product layouts,
  union layouts, aliases, fixed inline arrays, refined domains, and contracts.
- **Contracts erase.** Trait- or typeclass-like APIs are checked through `type fn` contracts and
  attached members, then disappear from the runtime representation.
- **Values stay reusable.** Fig source models ordinary data as immutable values. The backend chooses
  whether a value lives in Wasm locals, flattened parameters, or ABI-managed heap storage.
- **WebAssembly is the default target.** Public exports, host imports, and compound values lower to
  a stable Fig ABI with metadata for host embeddings.
- **Familiar patterns translate cleanly.** The standard prelude includes Option/Result, fixed
  arrays, functional helpers, operators, Reader/State/Eff helpers, and pure collection modules.

## Quick Start

From a source checkout:

```bash
deno run --allow-read src/cli.ts check examples/hello.fig
deno run --allow-read src/cli.ts fmt examples/hello.fig
deno run --allow-read src/cli.ts wat examples/hello.fig
deno run --allow-read --allow-write src/cli.ts build examples/hello.fig
deno run --allow-read src/cli.ts run examples/hello.fig
```

Native `fig` binaries are published on GitHub Releases:

```bash
fig check examples/hello.fig
fig fmt examples/hello.fig
fig wat examples/hello.fig
fig build examples/hello.fig
fig run examples/hello.fig
fig lsp
fig version
```

Use the compiler as a TypeScript library from a source checkout:

```ts
import { checkSource, wasmFromSource } from "./src/mod.ts";
```

Run the language server over stdio:

```bash
deno run --allow-read src/lsp/main.ts
```

Use `--compile-profile` with `check`, `wat`, `build`, or `run` to print compiler phase timings. Use
`--runtime-profile` with `run` to collect `@profile("label") { ... }` sites.

## A Small Fig Program

```fig
const operators = @import("prelude.operators");

type Point = struct {x: i32, y: i32}

fn Point::add(a: Point, b: Point) -> Point {
  Point {x: a.x + b.x, y: a.y + b.y}
}

pub fn main() -> i32 {
  let total = Point::add(
    Point {x: 1, y: 2},
    Point {x: 3, y: 4}
  );
  total.x + total.y
}
```

`pub fn` declarations become WebAssembly exports. Non-public functions, type functions, contracts,
and attached members are ordinary Fig declarations checked by the compiler.

## Examples by Task

### Define Records, Variants, and Enums

Fig product types look like records. Union types model tagged variants. Numeric enums use explicit
backing values.

```fig
const operators = @import("prelude.operators");

type Point = struct {x: i32, y: i32}

type Option(a) = union {
  None, Some(value: a)
}

type Mode = enum(i32) {Idle = 0, Run = 1, Back = -1}

fn unwrap_or(value: Option(i32), fallback: i32) -> i32 {
  match value {
    Some(inner) => inner,
    None => fallback
  }
}

fn mode_score(mode: Mode) -> i32 match {
  Idle => 0,
  Run => 1,
  Mode::Back => -1,
  _ => 0,
}

pub fn main() -> i32 {
  unwrap_or(Some(3), 0) + mode_score(Mode::Run)
}
```

### Add Behavior to a Type

Attached members give types namespaced behavior. Contracts can then check for those members at
compile time.

```fig
const operators = @import("prelude.operators");

type Point = struct {x: i32, y: i32}

fn Point::eql(a: Point, b: Point) -> bool {
  a.x == b.x && a.y == b.y
}

type fn HasEql(t: type) -> type {
  let Expected = fn(a: t, b: t) -> bool;
  @require(@type_has_member(t, #eql), "type requires eql");
  @require(@type_member_type(t, #eql) == Expected, "eql has wrong type");
  t
}

pub fn main() -> i32 {
  let point: HasEql(Point) = Point {x: 1, y: 1};
  match Point::eql(point, point) {
    true => 1,
    false => 0,
  }
}
```

### Write Generic Functional Code

Const function parameters specialize at compile time. Prelude contracts such as Functor,
Applicative, and Monad use attached members and erased checks.

```fig
const std = @import("prelude.std");

type Box(a) = struct {value: a}

fn Box::map(const f: fn(x: a) -> b, v: Box(a)) -> Box(b) {
  Box {value: f(v.value)}
}

fn Box::pure(value: a) -> Box(a) {
  Box {value}
}

fn Box::bind(v: Box(a), const f: fn(x: a) -> Box(b)) -> Box(b) {
  f(v.value)
}

fn inc(x: i32) -> i32 {
  x + 1
}

fn wrap(x: i32) -> Box(i32) {
  Box {value: x + 10}
}

pub fn main() -> i32 {
  bind(fmap(Box {value: 1}, inc), wrap).value
}
```

### Pipe Values Through a Flow

Fig does not use `|>` pipeline syntax. Use pipe-bind to give the value on the left a scoped name in
the expression on the right.

```fig
const operators = @import("prelude.operators");

fn inc(x: i32) -> i32 {
  x + 1
}

fn double(x: i32) -> i32 {
  x * 2
}

fn clamp(value: i32) -> i32 {
  match value > 10 {
    true => 10,
    false => value,
  }
}

pub fn main() -> i32 {
  3
    \next -> inc(next)
    \doubled -> double(doubled)
    \bounded -> clamp(bounded)
}
```

### Compute Layouts at Compile Time

Type functions are the Fig answer to many `comptime`, macro, and generic-layout use cases.

```fig
type fn InlineArray(n: count, a: type) -> struct {
  let InlineArray = {n*a};
  struct(InlineArray)
}

fn first(xs: InlineArray(4, i32)) -> i32 {
  xs[0]
}

pub fn main() -> i32 {
  first(#[1, 2, 3, 4])
}
```

Shape reflection can inspect and transform layouts:

```fig
type Payload = struct {id: i32, score: i32, debug: bool}

type fn KeepRuntimeSlot(key: const, _value: const) -> type {
  match key {
    #id => true,
    #score => true,
    _ => false,
  }
}

type fn RuntimeSlots(row: type) -> type {
  @shape_filter(@type_slots(row), KeepRuntimeSlot)
}
```

### Advanced Type Machinery

Fig is not a full dependent type language like Idris: there is no totality checker, implicit proof
search, or default laziness. The advanced surface is still useful for type-level programming:
compile-time functions can compute layouts, `@require` can reject invalid types, refined scalar
domains can carry bounds, declaration tags can generate members, and erased contracts can make
static evidence available without changing runtime data.

When a computation can fail, prefer a Maybe-style `core.Option` pipeline written with
`do @monad(core.Option(_))`. Dynamic checks can produce proof-carrying values: `core.Index(4)` is a
refined `i32(0..4)`, so array access only accepts a checked index.

```fig
const core = @import("prelude.core");
const fixed = @import("prelude.fixed");
const option = @import("prelude.option");
const operators = @import("prelude.operators");

fn checked_sum4(
  xs: fixed.Array(4, i32),
  left_raw: i32,
  right_raw: i32
) -> core.Option(i32) {
  do @monad(core.Option(_)) {
    left <- core.Index::try(4, left_raw);
    right <- core.Index::try(4, right_raw);
    pure(xs[left] + xs[right])
  }
}

pub fn main() -> i32 {
  let xs: fixed.Array(4, i32) = #[10, 20, 30, 40];
  core.Option::unwrap_or(checked_sum4(xs, 1, 3), 0)
}
```

You can use types as route definitions, similar to Haskell Servant-style APIs. Fig can match a
literal string path as a whole, but it does not currently split `"/items/:id"` strings at type
level. For a real route DSL, encode the URL as structured type-level segments. Here
`{items: #lit, id: core.Index(1000)}` represents `/items/:id`; `#lit` marks a fixed segment and the
typed `id` segment becomes a request parameter.

```fig
const core = @import("prelude.core");
const option = @import("prelude.option");
const operators = @import("prelude.operators");

const item_path = {items: #lit, id: core.Index(1000)};

type Item = struct {id: core.Index(1000), stock: i32}

type fn KeepParam(_segment: const, value: const) -> type {
  match value {
    #lit => false,
    _ => true,
  }
}

type fn Request(path: const) -> type {
  let Request = @shape_filter(path, KeepParam);
  struct(Request)
}

type fn Response(method: const, path: const) -> type {
  match method {
    #get => match @shape_first_key(path) {
      #items => match @shape_has_slot(@shape_tail(path), #id) {
        true => Item,
        false => i32,
      },
      _ => @compile_error("unknown route root"),
    },
    _ => @compile_error("unknown method"),
  }
}

type fn Handler(method: const, path: const) -> type {
  fn(request: Request(path)) -> Response(method, path)
}

fn call_item(
  handler: Handler(#get, item_path),
  request: Request(item_path)
) -> Response(#get, item_path) {
  handler(request)
}

fn parse_item(raw_id: i32) -> core.Option(Request(item_path)) {
  do @monad(core.Option(_)) {
    id <- core.Index::try(1000, raw_id);
    pure({id})
  }
}

fn get_item(request: Request(item_path)) -> Response(#get, item_path) {
  Item {id: request.id, stock: 42}
}

pub fn main() -> i32 {
  let item = do @monad(core.Option(_)) {
    request <- parse_item(7);
    pure(call_item(get_item, request))
  };
  match item {
    Some(value) => value.stock,
    None => 0,
  }
}
```

Type functions can derive precise data structures from other types. This `Patch(row)` turns every
field in a product into an optional field of the same type.

```fig
const core = @import("prelude.core");
const option = @import("prelude.option");
const operators = @import("prelude.operators");

type Profile = struct {id: i32, score: i32, active: bool}

type fn MaybeSlot(_key: const, value: const) -> type {
  core.Option(value)
}

type fn Patch(row: type) -> type {
  @require(@type_is_product(row), "Patch expects a product type");
  let Slots = @type_slots(row);
  let MaybeSlots = @shape_map_with_key(Slots, MaybeSlot);
  struct(MaybeSlots)
}

fn apply_patch(row: Profile, patch: Patch(Profile)) -> Profile {
  Profile {
    id: core.Option::unwrap_or(patch.id, row.id),
    score: core.Option::unwrap_or(patch.score, row.score),
    active: core.Option::unwrap_or(patch.active, row.active),
  }
}

pub fn main() -> i32 {
  let row = Profile {id: 7, score: 10, active: true};
  let no_id: core.Option(i32) = option.none();
  let patch: Patch(Profile) = {
    id: no_id,
    score: option.some(99),
    active: option.some(false)
  };
  let updated = apply_patch(row, patch);
  match updated.active {
    true => updated.score,
    false => updated.id + updated.score,
  }
}
```

Shape filters can derive views by inspecting slot types rather than field names.

```fig
const operators = @import("prelude.operators");

type Telemetry = struct {id: i32, label: string, score: i32, enabled: bool}

type fn KeepNumber(_key: const, value: const) -> type {
  @type_is_number(value)
}

type fn NumberView(row: type) -> type {
  @require(@type_is_product(row), "NumberView expects a product type");
  let Numeric = @shape_filter(@type_slots(row), KeepNumber);
  @require(@shape_count(Numeric) == 2, "expected id and score");
  struct(Numeric)
}

fn numbers(row: Telemetry) -> NumberView(Telemetry) {
  {id: row.id, score: row.score}
}

pub fn main() -> i32 {
  let row = Telemetry {
    id: 7,
    label: "search",
    score: 35,
    enabled: true
  };
  let numeric = numbers(row);
  numeric.id + numeric.score
}
```

Declaration tags can generate attached members from a type and immediately validate the generated
surface with a normal contract.

```fig
const derive = @import("prelude.derive");
const core = @import("prelude.core");
const operators = @import("prelude.operators");

@[derive.Eq(Self), core.Eq(Self)]
type Key = struct {id: i32, shard: i32}

pub fn main() -> i32 {
  match Key::eql(Key {id: 1, shard: 2}, Key {id: 1, shard: 2}) {
    true => 1,
    false => 0,
  }
}
```

Fig is strict by default, but delayed computation is explicit. Use a `const fn() -> T` thunk for
specialized lazy fallback APIs, or keep runtime function values inside Fig when a closure must
capture runtime locals. Function values cannot cross public Wasm exports or host imports.

```fig
const option = @import("prelude.option");
const core = @import("prelude.core");

fn expensive_default() -> core.Option(i32) {
  option.some(99)
}

pub fn main() -> i32 {
  let cached = option.some(1);
  let missing: core.Option(i32) = option.none();
  core.Option::unwrap_or(core.Option::or_else(cached, expensive_default), 0) +
    core.Option::unwrap_or(core.Option::or_else(missing, \() -> option.some(41)), 0)
}
```

### Work with Fixed-Size Data

Use fixed inline arrays and static helpers when the length is known. These patterns are intended for
small kernels, vector lanes, compact buffers, and predictable Wasm lowering.

```fig
const operators = @import("prelude.operators");
const array = @import("prelude.array_static");
const layout = @import("prelude.layout");

fn inc(x: i32) -> i32 {
  x + 1
}

fn add(a: i32, b: i32) -> i32 {
  a + b
}

pub fn main() -> i32 {
  let xs: layout.Lane4I32 = #[1, 2, 3, 4];
  array.fold4_i32(add, 0, array.map4_i32(inc, xs))
}
```

Use heap-backed modules such as `prelude.vec`, `prelude.map`, `prelude.set`, `prelude.tree`, and
`prelude.graph` when growth or persistent structures matter more than fixed layout.

### Call Host IO

Host imports are explicit. An external IO action takes the `io` executor and returns `io(T)`;
`do @io(_)` sequences those actions.

```fig
const operators = @import("prelude.operators");

const clock = @external("clock", fn(host: io) -> io(i32));
const random = @external("random", fn(host: io) -> io(i32));

pub fn main(host: io) -> io(i32) {
  do @io(_) {
    now <- clock(host);
    entropy <- random(host);
    return(now + entropy)
  }
}
```

Browser canvas, GPU, shader metadata, and event IO helpers live in `web.canvas`:

```fig
const canvas = @import("web.canvas");
```

## Coming from Another Language

| If you reach for...           | In Fig, start with...                                                        |
| ----------------------------- | ---------------------------------------------------------------------------- |
| Rust traits                   | Attached members plus `type fn` contracts such as `Eq(t)` or `HasEql(t)`.    |
| Rust enums and `Result`       | `union` types, `match`, and the `prelude.option` / `prelude.result` modules. |
| Rust ownership updates        | Immutable value bindings and fresh names for each logical version.           |
| Haskell ADTs                  | `struct`, `union`, and pattern matching.                                     |
| Haskell typeclasses           | Prelude contracts with erased evidence and attached members.                 |
| Haskell `do` notation         | `do @monad(T(_))`, `do @applicative(T(_))`, and `do @io(_)`.                 |
| Haskell laziness              | Explicit thunks: `const fn() -> T` or internal runtime `fn() -> T` values.   |
| Idris-style indexed data      | Refined scalar domains, `type fn` contracts, and proof-carrying values.      |
| Pipeline operators            | Pipe-bind syntax: `expr \name -> next_expr`.                                 |
| Zig `comptime`                | `type fn`, `const` parameters, shape reflection, and `@require`.             |
| Zig packed/static layout work | Counted inline arrays, refined scalar domains, and fixed prelude layouts.    |
| TypeScript/Wasm host glue     | `pub fn`, `@external`, the Fig ABI manifest, and `src/mod.ts` helpers.       |

Detailed guides:

- [Rust Patterns in Fig](docs/guides/rust-patterns.md)
- [Haskell Patterns in Fig](docs/guides/haskell-patterns.md)
- [Zig Patterns in Fig](docs/guides/zig-patterns.md)

## Checked Example Programs

The `examples/` directory is the fastest way to see complete programs:

| Example                                     | What it shows                                                         |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `examples/prelude_typeclasses.fig`          | Attached members, Eq-style checks, Functor/Applicative/Monad members. |
| `examples/prelude_functional.fig`           | Functional helpers, composition, and prelude abstractions.            |
| `examples/haskell_validation_pipeline.fig`  | Applicative validation and dependent monadic flow.                    |
| `examples/haskell_reader_state_program.fig` | Reader configuration, State updates, and sequencing.                  |
| `examples/zig_comptime_record_layout.fig`   | Shape reflection and compile-time layout checks.                      |
| `examples/zig_static_matrix_schedule.fig`   | Count-parameterized arrays and static schedule metadata.              |
| `examples/prelude_array_static.fig`         | Fixed lane helpers, map, and fold.                                    |
| `examples/prelude_effect_state.fig`         | Typed state effects through `prelude.effect`.                         |
| `examples/effects.fig`                      | Explicit host IO imports and `do @io`.                                |
| `examples/type_fn_memory.fig`               | A larger layout/modeling sketch built from type functions.            |

See [docs/EXAMPLES.md](docs/EXAMPLES.md) for the tested good/bad language examples and why the bad
patterns fail.

## Documentation Map

- [Language Reference](docs/LANGUAGE.md) is the main syntax and semantics index.
- [Prelude Reference](docs/reference/prelude.md) lists standard modules, contracts, operators,
  collections, and effect helpers.
- [Builtins Reference](docs/reference/builtins.md) lists compiler builtins and backend intrinsics.
- [Semantics Reference](docs/reference/semantics.md) covers Branch-Bit values, effects, const
  evaluation, reflection, and Wasm portability.
- [Guides](docs/guides/README.md) translate familiar Rust, Haskell, and Zig patterns into Fig.

## Project Status

Fig is experimental. The compiler, language server, TypeScript API, prelude, examples, and Wasm
backend live in this repository and evolve together. The default portability target is WebAssembly
features available in current Chromium- and Firefox-family browsers and Deno.
