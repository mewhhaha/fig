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
