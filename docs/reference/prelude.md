# Prelude Library

The prelude is a set of ordinary Fig modules under `prelude/*.fig`. It provides pure, portable
library code for the browser and Deno WebAssembly target: static contracts, common data types,
operators, fixed-size value layouts, heap-backed collections, effect carriers, and small utility
domains. Browser-specific host IO stays outside the prelude under `web.*`.

Use the umbrella module for ordinary programs:

```fig
const std = @import("prelude.std");
```

Import a fragment directly when you want a smaller surface or a qualified namespace:

```fig
const array = @import("prelude.array_static");
const vec = @import("prelude.vec");
```

The alias qualifies declarations owned by the imported module, such as `array.map4_i32` or
`vec.Vec::push`. Operator modules are often imported only for their operator declarations, so the
alias may be unused.

## Umbrella Module

`prelude.std` imports the common fragments used by examples and tests:

- Static arrays and performance helpers: `prelude.array_static`.
- Functional helpers and typeclass-like contracts: `prelude.function`.
- Heap-backed collections: `prelude.vec`, `prelude.list`, `prelude.nonempty`, `prelude.queue`,
  `prelude.tree`, `prelude.zipper`, `prelude.map`, `prelude.set`, and `prelude.graph`.
- Pure sum and tuple helpers: `prelude.option`, `prelude.result`, and `prelude.tuple`.
- Reader/state helpers: `prelude.monad`.
- Operator declarations: `prelude.operators`.
- Static schedule metadata: `prelude.schedule`.

Import these fragments directly when you need their qualified APIs. Import omitted fragments
directly too, including `prelude.core`, `prelude.layout`, `prelude.fixed`,
`prelude.fixed_build`, `prelude.range`, `prelude.scalar`, `prelude.order`, `prelude.effect`,
`prelude.optic`, `prelude.derive`, and `prelude.geometry2d`.

## Core Values And Contracts

| Module            | Available surface                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `prelude.core`    | `Eq`, `Semigroup`, `EmptyValue`, `Monoid`, `Copyable`, `Droppable`, `Option`, `Result`, `Pair`, `Tuple2`, `Tuple3`, `Unit`, `Index`, iterator contracts, `append`, `empty`, `unit`, and domain-index helpers. |
| `prelude.derive`  | Source-level declaration tag providers `derive.Eq(Self)` and `derive.EmptyValue(Self)` for generated attached members. |
| `prelude.option`  | `some`, `none`, `guard`, plus `Option::is_some`, `Option::is_none`, `Option::unwrap_or`, `Option::map`, `Option::pure`, `Option::apply`, `Option::bind`, `Option::append`, `Option::empty`, and `Option::or_else`. |
| `prelude.result`  | `ok`, `err`, plus `Result::is_ok`, `Result::is_err`, `Result::unwrap_or`, `Result::map`, `Result::map_err`, `Result::pure`, `Result::apply`, and `Result::bind`. |
| `prelude.tuple`   | `Pair::first`, `Pair::second`, `Pair::swap`, `Pair::map_first`, `Pair::map_second`, `Pair::bimap`, and `Tuple3` field accessors. |
| `prelude.scalar`  | Boolean helpers, `select`, the `Number(t)` contract, and generic `min`, `max`, `clamp`, `between`, `abs`, `signum`, and `square`. |
| `prelude.bool`    | Boolean conversion and negation helpers: `to_i32`, `to_sign`, and `not`.              |
| `prelude.order`   | `Ordering`, `compare_i32`, and predicates for less, equal, and greater cases.                    |

`prelude.num` is a compatibility namespace that imports `prelude.scalar`.

Use `prelude.derive` with core contracts when a type should get source-visible generated members:

```fig
const derive = @import("prelude.derive");
const core = @import("prelude.core");

@[derive.Eq(Self), core.Eq(Self)]
type Point = struct {x: i32, y: i32}
```

## Operators And Functional Helpers

`prelude.function` provides `identity`, `constant`, `compose`, `pipe`, `apply_to`, `flip`,
`Functor`, `Applicative`, `Monad`, `fmap`, `pure`, `apply`, and `bind`. The contracts are ordinary
type functions that require attached members such as `map`, `pure`, `apply`, and `bind`. The helper
functions evaluate their requirements with local `@assert(Contract(t));` calls, so callers pass
only the runtime values:

```fig
let mapped = fmap(Box {value: 1}, inc);
let bound = bind(mapped, wrap);
```

`prelude.operators` declares these operator families:

| Operators                                    | Requirement                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `+`, `-`, `*`, `/`, `%`                      | Attached numeric-style members such as `add`, `sub`, `mul`, `div`, and `rem`. |
| `==`, `!=`, `<`, `<=`, `>`, `>=`             | Attached equality or ordering members on scalar and user-defined types.       |
| `&&`, `||`, `^^`                             | Boolean conjunction, disjunction, and exclusive-or.                           |
| `<>`                                         | `append` member for semigroup-style values.                                   |
| `<$>`, `<&>`, `<*>`, `<**>`, `>>=`, `=<<`    | Functor, applicative, and monad members.                                      |
| `>=>`, `<=<`                                 | Kleisli composition for monadic functions.                                    |

Primitive scalar support is still visible in source: `prelude.operators` defines attached members
such as `i32::add`, `u64::lt`, `f32::div`, and `bool::and`, and those wrappers call backend
intrinsics like `@i32_add` or `@bool_and`.

## Fixed And Static Data

| Module                   | Available surface                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `prelude.layout`         | `InlineArray(n, a)`, `InlineArrayList`, `InlineArrayBuilder`, `HeapArray`, `Collector`, `Lane4I32`, `Lane4Bool`, `Lane4ScalarI32`, `Tile2x4I32`, `Tile4x4I32`, `Mat4I32`, `ViewI328x2`, and helpers for tabulate, fill, map, indexed map, set, update, fold indices, heap get/set/push, and capacity. |
| `prelude.fixed`          | Canonical `Array(n, a)` over inline layouts, with `set`, `update`, `swap`, and index folding using spread/update forms. |
| `prelude.fixed_build`    | `ArrayBuilder` start, push, and finish helpers for building fixed values when direct slots are not convenient. |
| `prelude.array_static`   | `map4_i32`, `zip_with4_i32`, `fold4_i32`, `reduce4_i32`, lane arithmetic and queries, matrix row helpers, checked `get`, fixed `Iter` map/filter/fold/reduce/collect helpers, `CompactArray`, `RuntimeRange`, `RangeI32`, and `RangeIter`. |
| `prelude.range`          | Runtime `i32` range wrappers with `RangeI32::Iter`, `RangeIter::fold`, `count`, `sum`, and `product`. |
| `prelude.schedule`       | Static schedule metadata types: `Tile`, `Vectorize`, `Unroll`, and the `Tile2x4`, `Vectorize4`, and `Unroll4` aliases. |

Use inline arrays when the size is static and heap-backed collections when growth or persistent
structure is the main requirement.

## Heap-Backed Collections

| Module              | Available surface                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `prelude.vec`       | `Vec`, `Builder`, `Slice`, constructors, length/capacity, get/set/push, append, pure, map, apply, bind, filter, fold, find, any/all, and slices. |
| `prelude.list`      | Persistent cons lists with empty/singleton/cons, length, head, tail, append, pure, map, apply, bind, fold, and reverse. |
| `prelude.nonempty`  | `NonEmpty` values with singleton, cons, head, tail, length, append, pure, map, apply, bind, and conversion to `List`. |
| `prelude.queue`     | FIFO `Queue` with empty, length, emptiness check, push back, append, pure, map, apply, bind, fold, peek front, and pop front. |
| `prelude.tree`      | Heap-node binary `Tree` with construction, map, node/root/value/child lookup, and preorder fold.          |
| `prelude.zipper`    | `TreeZipper` focus navigation with `from_tree`, `map`, `value`, `go_left`, `go_right`, and `go_up`.       |
| `prelude.map`       | Ordered `Map` backed by a left-leaning red/black tree, with empty, length, insert, get, contains, fold in order, and `compare_i32`. |
| `prelude.set`       | Ordered `Set` over `Map`, with empty, length, insert, contains, and `compare_i32`.                        |
| `prelude.graph`     | Directed `i32` graph helpers with edges, edge counts, edge lookup, out-degree, queue/set reachability, and bounded edge-chain reachability. |

Map and set order is caller-supplied through explicit comparator functions.

`Vec::empty()`, `List::empty()`, and `Queue::empty()` are zero-argument members. Give them an
expected result type when no surrounding value pins the element type:

```fig
let xs: vec.Vec(i32) = vec.Vec::empty();
```

## Effects, Optics, And Small Domains

`prelude.monad` exposes explicit `State(S, A)` and `Reader(R, A)` function carriers with `pure`,
`bind`, `get`, `put`, `modify`, `gets`, `ask`, `asks`, `run`, `eval`, and `exec` helpers.

`prelude.effect` builds transparent reader/state effect rows with `Eff`, `EffContext`,
`EffResult`, `ReaderValue`, `StateValue`, `ask`, `get`, `put`, `modify`, `run_state`,
`run_reader`, and `run_pure`. The effect row contracts are checked through ordinary type functions.

`prelude.optic` provides function-based lens helpers: `view`, `set`, `over`, `preview`, `view_or`,
`set_optional`, and `over_optional`.

`prelude.geometry2d` is a small pure geometry layer for fixed 2D data. It includes integer vector,
color, vertex, quad, mesh, and geometry layouts plus helpers such as `vec2`, `vec3`, `rgba8`,
`vertex2d`, `quad2d_rect`, `quad2d_translate`, `emit_quad2d`, `emit_rect2d`, batch construction,
and append helpers.
