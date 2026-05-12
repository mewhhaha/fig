# Benchmarks

These numbers compare Fig compiled to Wasm against equivalent JavaScript and Rust kernels. They are
machine-local measurements from the current working tree and should be used mainly for regression
tracking.

Fig is compiled with `optMode: "release"` and `memoryModel: "branch"`. The tables report both the
old exported-call shape and the new internal-loop shape:

- `Fig/Wasm external`: JavaScript calls the exported Wasm `main(seed)` once per measured iteration.
- `Fig/Wasm internal`: JavaScript calls exported Wasm `bench(iterations)` once, and the measured
  loop runs inside Wasm.
- `Fig/Wasm kernel`: the scenario compiled without the internal benchmark wrapper, used for
  apples-to-apples binary-size comparison with `Rust/Wasm`.

## Environment

- Date: 2026-05-12
- OS: Linux 7.0.5-1-cachyos x86_64
- Deno: 2.7.14, V8 14.7.173.20-rusty, TypeScript 5.9.2
- Rust: rustc 1.96.0-nightly (3645249d7 2026-03-16)

## Command

```bash
deno run --allow-read --allow-write --allow-run scripts/bench_memory_model_compare.ts 50000
```

Current status: the release-gated command above does not complete because `fannkuch_redux_7` exceeds
its kernel Wasm size gate:

```text
fannkuch_redux_7 kernel Wasm size expected <= 2480B but got 4665B
```

The measurements below were captured from the same harness with the size gates temporarily disabled,
using `20000` iterations. Treat them as current-tree diagnostic numbers rather than a clean
benchmark pass.

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
| `scalar_reuse_nway`              |              147 |              54 |       140 |
| `product_shadow_update`          |              200 |             107 |       225 |
| `tail_product_loop_1k`           |              303 |             137 |       348 |
| `inline_array_builder_map`       |              548 |             255 |       530 |
| `compact_filter_collect`         |              790 |             714 |       317 |
| `alias_snapshot_update`          |              281 |             204 |       224 |
| `fixed_collection_update`        |              270 |             183 |       278 |
| `fixed_collection_spread_update` |              270 |             183 |       261 |
| `collision_aabb_64`              |              411 |             304 |       275 |
| `path_grid_score_16`             |              228 |             146 |       189 |
| `range_fold_1k`                  |              241 |             143 |       333 |
| `fannkuch_redux_7`               |             4802 |            4665 |      1190 |
| `mat4_dot1`                      |              296 |             209 |       416 |
| `mat4_full`                      |             2123 |            1658 |       648 |

Timed rows from the same run:

| Scenario                         | Fig external ns/call | Fig internal ns/call | JavaScript ns/call | Rust ns/call |
| -------------------------------- | -------------------: | -------------------: | -----------------: | -----------: |
| `scalar_reuse_nway`              |                 19.6 |                  1.1 |               11.4 |          0.8 |
| `product_shadow_update`          |                 18.6 |                  7.2 |               36.4 |          2.8 |
| `tail_product_loop_1k`           |                568.8 |               1167.7 |              815.3 |        584.8 |
| `inline_array_builder_map`       |                 42.0 |                  5.8 |              645.6 |         24.3 |
| `compact_filter_collect`         |                 37.6 |                  3.4 |               71.4 |         15.5 |
| `alias_snapshot_update`          |                 21.5 |                  8.4 |               85.4 |          9.2 |
| `fixed_collection_update`        |                 19.6 |                 16.5 |              727.2 |          3.5 |
| `fixed_collection_spread_update` |                 43.4 |                 13.7 |               43.3 |          1.9 |
| `collision_aabb_64`              |                236.1 |                 77.7 |              459.4 |         50.5 |
| `path_grid_score_16`             |                418.8 |                309.8 |              697.6 |        128.3 |
| `range_fold_1k`                  |                532.4 |                215.5 |              664.5 |        253.2 |
| `fannkuch_redux_7`               |             197477.7 |             179623.3 |           306556.6 |      88958.2 |
| `mat4_dot1`                      |                 19.3 |                  9.9 |               41.5 |          2.1 |
| `mat4_full`                      |                109.8 |                 36.8 |              222.1 |         24.8 |

Dynamic fixed-array diagnostics from the same run:

| Scenario           | Dynamic selectors | Set/update calls | Spread helpers | Slot-copy/select sites | Transient sets | Flat | Scratch | Packed |
| ------------------ | ----------------: | ---------------: | -------------: | ---------------------: | -------------: | ---: | ------: | -----: |
| `fannkuch_redux_7` |                 0 |                0 |              0 |                      0 |              0 |    0 |       0 |      1 |

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
  uses fixed arrays, dynamic indexing, and repeated public `InlineArray.update`/`set` paths. The
  current lowering uses packed bounded arrays for the dynamic reverse/rotate/count paths and fuses
  the private product-state search step in release mode. Its current kernel size regresses past the
  release gate, so it is the main code-size follow-up before treating this run as healthy.
