# Fig Current Goals

Fig is a latest-only language/compiler. Current work should strengthen the stable surface instead of
adding alternate historical paths.

## Compiler

- Keep type functions, contracts, do strategies, inferred type holes, and source imports coherent
  under one checker model.
- Keep compiler diagnostics direct: unsupported syntax should say what is unsupported now, without
  pointing users at historical modes.
- Keep plugins in-process through the stable TypeScript plugin API and first-party builtin registry.

## Backend And ABI

- Treat the Branch-Bit heap runtime and stable `fig.abi` memory ABI as the only public Wasm
  boundary.
- Keep public scalar values direct and compound values handle-based through `fig_objects` and
  `fig_buffers`.
- Keep backend intrinsics narrow and internal: branch handles, heap arrays, fixed layout helpers,
  and stable ABI helpers.
- Preserve browser and Deno portability for the supported WebAssembly feature subset.

## Optimization

- Make release optimization reachable-only, recurrence-aware, and structural.
- Prefer general lowering rules over prelude-specific or example-specific shortcuts.
- Keep benchmark scenarios focused on final Wasm shape: loops where expected, no recursive calls in
  optimized loops, no unexpected heap traffic, and SIMD where recognized.

## Documentation And Examples

- Keep docs phrased as current truth, not transition history.
- Keep examples runnable and representative of current Fig: functional abstractions, comptime-style
  type functions, stable memory ABI, host IO, ECS, and performance layout sketches.
- Keep benchmark notes current enough to guide regressions without preserving completed plan text.
