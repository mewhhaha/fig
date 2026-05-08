# Fig

Fig is an experimental language/compiler focused on static type functions, ownership checks, and
WebAssembly output.

See `docs/LANGUAGE.md` for the full core-language syntax, semantics, and compiler builtin reference.

## Type Function Surface

Type functions currently cover several compile-time concepts:

- Layout constructors: products, sums, aliases, function types, shape types, and counted inline
  arrays.
- Static reflection: product/sum/alias checks, slot lookup, variant lookup, and attached member
  lookup.
- Static contracts: `@require`-checked proofs such as `eq(T)`, `functor(T)`, `droppable(T)`, and
  layout predicates.
- Constructor-polymorphic helpers: generic functions can infer type constructors at call sites and
  use local proof consts such as `const Mapper = functor(T);`.
- Memory-oriented modeling: examples can encode owned values, borrowed handles, arena-tied
  references, fixed inline buffers, and drop capabilities as compile-time type-function contracts.

See `examples/type_fn_memory.fig` for a checked memory-management sketch that ties these pieces
together without adding runtime proof parameters.

## Performance Layout Sketches

For normal performance-oriented code, prefer `const std = @import("prelude.std");`. The prelude is
pure: it exposes common fragments as nested namespaces for core value data, static contracts such as
`eq`, `semigroup`, `monoid`, `functor`, `applicative`, and `monad`, fixed inline layouts,
fixed-array/lane helpers, functional helpers, pure option/result helpers, tuple helpers, boolean and
`i32` utilities, and schedule metadata. Existing fragment imports such as `prelude.core`,
`prelude.layout`, `prelude.array_static`, `prelude.function`, `prelude.option`, `prelude.result`,
`prelude.tuple`, and `prelude.schedule` remain available for smaller surfaces.

```fig
const std = @import("prelude.std");

fn inc(x: i32) -> i32 { x + 1 }

pub fn main() -> i32 {
  let maybe = std.option_map(std.some(1), inc);
  let value = std.option_unwrap_or(maybe, 0);
  let bounded = std.clamp_i32(value + 10, 0, 8);
  let swapped = std.pair_swap(Pair [first: bounded, second: std.result_unwrap_or(std.ok(2), 0)]);
  swapped.first + swapped.second
}
```

The `examples/perf_*.fig` files are checked catalog modules for comparing static performance layout
styles under the current language surface:

- `examples/perf_arrays.fig` is the canonical static-kernel sketch. It uses counted inline layouts,
  fixed lane/tile aliases, and const dictionary specialization to show source-level static dispatch.
- `examples/perf_array_dsl.fig` is a Futhark/Dex-inspired array API shape. It keeps regular lane,
  tile, and tensor helpers explicit while making map-style code easier to read.
- `examples/perf_schedule_dsl.fig` is a Halide-inspired schedule vocabulary. It records tile,
  vectorize, and unroll intent as static contracts and metadata.

These examples keep memory ownership explicit. The prelude provides fixed inline arrays, lane/tile
aliases such as `lane4_i32`, `tile2x4_i32`, and `mat4_i32`, typed Wasm pointer helpers, and
load/store aliases that lower directly to Wasm memory operations.

Use fixed inline arrays and iterators for collection-shaped code for now. `prelude.std` exposes the
pure fixed helpers from `prelude.array_static`, including explicit `lane4_*` helpers,
`range_i32`/range iterators, `iter.map`/`iter.filter`/`iter.fold`, and `compact_array` collection
for fixed-capacity filtered results.

Heap-backed lists and growable vectors are intentionally deferred. The standard prelude does not
provide `list`, `vector`, `vec`, `push`, `pop`, `reserve`, or allocation-backed append APIs yet;
those need an explicit allocator and ownership/lifetime design before they can be portable across
the browser and Deno WebAssembly target.

`prelude.geometry2d` is a tiny pure playground layer for geometry-shaped programs. It provides
integer `vec2`, `vec3`, packed `rgba8`, `vertex2d_i32`, `quad2d_i32`, and `geometry2d_i32` helpers.
The first entry point is quad-first 2D rendering data: `emit_rect2d` and `emit_quad2d` produce fixed
inline vertex geometry that can later be uploaded explicitly by host or memory-token code.

Browser canvas, GPU, shader metadata, and event host capabilities live outside the prelude in
`web.canvas`:

```fig
const canvas = @import("web.canvas");
```
