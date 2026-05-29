# Large Compile Benchmark

This folder contains a tracked temporary benchmark harness plus ignored generated outputs. The
source files are kept so compile-time checkpoints are reproducible; generated Fig/Go projects, Go
caches, and binaries remain disposable.

The runner creates each measured project under a fresh `/tmp/fig-large-compile-*` directory so
parallel runs do not overwrite the in-repo benchmark source or contaminate Go/Fig caches.

It generates a matched Fig project and Go project of roughly project-sized source volume. The Fig
side uses several modules, source imports, type functions, products, matches, pipe-bind, fixed
inline arrays, module qualification, and generated helper kernels. The Go side mirrors the module
graph and algorithmic shape with ordinary packages.

Two scenarios are available:

- `kernels`: the original broad module graph with many direct helper kernels.
- `abstractions`: a larger idiomatic stress case that leans on type functions, attached
  Functor/Monad-style members, product wrappers, fixed arrays, pipe-bind, and layered modules.

Run:

```sh
deno run --allow-read --allow-write --allow-run tmp/large_compile_bench/run.ts
deno run --allow-read --allow-write --allow-run tmp/large_compile_bench/run.ts --loc 9000 --samples 5 --warmup 1
deno run --allow-read --allow-write --allow-run tmp/large_compile_bench/run.ts --scenario abstractions --loc 9000
deno run --allow-read --allow-write --allow-run tmp/large_compile_bench/run.ts --release
```

Outputs:

- `/tmp/fig-large-compile-*/fig_project/`: generated Fig modules.
- `/tmp/fig-large-compile-*/go_project/`: generated Go module.
- `/tmp/fig-large-compile-*/out/`: Go binaries.
- A console table comparing Fig uncached, Fig shared cache, Fig session edits, and Go cold/warm/edit
  builds.
