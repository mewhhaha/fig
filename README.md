# Shovel

Shovel is an experimental language/compiler focused on static type functions, ownership checks, and
WebAssembly output.

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

See `examples/type_fn_memory.shovel` for a checked memory-management sketch that ties these pieces
together without adding runtime proof parameters.

## Performance Layout Sketches

The `examples/perf_*.shovel` files are checked catalog modules for comparing static performance
layout styles under the current language surface:

- `examples/perf_arrays.shovel` is the canonical static-kernel sketch. It uses counted inline
  layouts, fixed lane/tile aliases, and const dictionary specialization to show source-level static
  dispatch.
- `examples/perf_array_dsl.shovel` is a Futhark/Dex-inspired array API shape. It keeps regular
  lane, tile, and tensor helpers explicit while making map-style code easier to read.
- `examples/perf_schedule_dsl.shovel` is a Halide-inspired schedule vocabulary. It records tile,
  vectorize, and unroll intent as static contracts and metadata.

These examples do not add compiler prelude imports, source-module imports, memory-backed arrays, or
real WebAssembly SIMD emission. Today they are standalone checked modules users can copy from until
Shovel has module imports and prelude support.
