# Benchmarks

These numbers compare Fig compiled to Wasm against equivalent JavaScript and Rust kernels. They are
machine-local measurements from the current working tree and should be used mainly for regression
tracking.

Fig is compiled with the compiler's single best-effort optimization mode and
`memoryModel: "branch"`. The tables report both the old exported-call shape and the new
internal-loop shape:

- `Fig/Wasm external`: JavaScript calls the exported Wasm `main(seed)` once per measured iteration.
- `Fig/Wasm internal`: JavaScript calls exported Wasm `bench(iterations)` once, and the measured
  loop runs inside Wasm.
- `Fig/Wasm kernel`: the scenario compiled without the internal benchmark wrapper, used for
  apples-to-apples binary-size comparison with `Rust/Wasm`.

## Environment

- Date: 2026-05-10
- OS: Linux cachyos-x8664 7.0.5-1-cachyos x86_64
- Deno: 2.7.14, V8 14.7.173.20-rusty, TypeScript 5.9.2
- Rust: rustc 1.96.0-nightly (3645249d7 2026-03-16)

## Command

```bash
deno run --allow-read --allow-write --allow-run scripts/bench_memory_model_compare.ts 50000
```

The Rust comparison is compiled by the benchmark harness with:

```bash
rustc -C opt-level=3 -C target-cpu=native
```

## Results

The table below focuses on generated Wasm size. `Fig compare` is the module used for the timed
external/internal benchmark and includes both `main` and `bench`. `Fig kernel` is the same scenario
compiled as a single exported kernel, which is the fair size comparison to `Rust/Wasm`.

| Scenario                         | Fig compare Wasm | Fig kernel Wasm | Rust/Wasm |
| -------------------------------- | ---------------: | --------------: | --------: |
| `scalar_reuse_nway`              |              248 |              84 |       140 |
| `product_shadow_update`          |              430 |             264 |       225 |
| `tail_product_loop_1k`           |              419 |             253 |       348 |
| `inline_array_builder_map`       |              675 |             511 |       530 |
| `compact_filter_collect`         |             1927 |            1762 |       317 |
| `alias_snapshot_update`          |              713 |             549 |       224 |
| `fixed_collection_update`        |             1263 |            1099 |       278 |
| `fixed_collection_spread_update` |              580 |             416 |       261 |
| `collision_aabb_64`              |              661 |             497 |       275 |
| `path_grid_score_16`             |              365 |             200 |       189 |
| `range_fold_1k`                  |              535 |             376 |       333 |
| `fannkuch_redux_7`               |             5526 |            5362 |      1190 |
| `mat4_dot1`                      |              484 |             318 |       416 |
| `mat4_full`                      |             2585 |            2421 |       648 |

Representative timed rows from the same run:

| Scenario                  | Fig external ns/call | Fig internal ns/call | JavaScript ns/call | Rust ns/call |
| ------------------------- | -------------------: | -------------------: | -----------------: | -----------: |
| `fixed_collection_update` |                103.7 |                  2.9 |              652.5 |          2.6 |
| `compact_filter_collect`  |                 80.8 |                 25.7 |               67.0 |         15.3 |
| `fannkuch_redux_7`        |             583233.5 |             570156.9 |           227133.9 |      90699.0 |
| `mat4_full`               |                 44.0 |                 24.2 |               70.9 |         27.8 |

## Notes

- Fig/Wasm is produced by the local compiler and instantiated through Deno's WebAssembly runtime.
- The Fig internal-loop checksum is an exported `i32`, so it intentionally shows Wasm `i32` wrapping
  for high-volume scalar/product checksums.
- JavaScript runs in the same Deno/V8 process as the benchmark harness.
- Rust is compiled to a native binary with `black_box` around inputs and loop bodies where the
  harness needs to prevent constant-folding away the measured work.
- `Rust/Wasm` reports the size of a separate stripped `no_std` `wasm32-unknown-unknown` module for
  the equivalent Rust kernel. It is a binary-size reference only, not a timed runtime column.
- The `calls` count is reduced for heavier 1k-loop and builder scenarios by the benchmark harness,
  so `ns/call` is the most comparable per-scenario column.
- The size table reports binary module sizes in bytes. `Fig compare Wasm` includes benchmark wrapper
  code; `Fig kernel Wasm` does not.
- `alias_snapshot_update`, `fixed_collection_update`, and `fixed_collection_spread_update` are
  deliberately adversarial value-reuse cases. `fixed_collection_update` now uses the public
  `InlineArray.update` spread-copy path and is currently larger than the direct spread baseline.
- `compact_filter_collect` is intentionally left unspecialized here; it still shows the generic
  iterator pipeline cost.
- `mat4_full` keeps the SIMD unrolled lowering in the single compiler mode. Its kernel is still
  larger than Rust's stripped Wasm, which is useful pressure for general code-size improvements.
- `collision_aabb_64` and `path_grid_score_16` are common systems-style kernels that stress flat
  products, nested conditionals, integer division/modulo, and scalar loop lowering.
- `fannkuch_redux_7` is adapted from the Computer Language Benchmarks Game benchmark description and
  uses fixed arrays, dynamic indexing, and repeated public `InlineArray.update`/`set` paths. Its
  binary-size growth is bounded but the runtime gap is suspicious enough to make dynamic fixed-array
  update lowering the next likely investigation target.
