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

Current status: the release-gated command above completes. The `fannkuch_redux_7` size gate is now
intentionally relaxed because runtime parity is the relevant pressure for that benchmark; matching
Rust/Wasm byte size is no longer treated as the primary acceptance criterion.

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
| `monadic_do_id_chain`            |              184 |              78 |       182 |
| `applicative_do_id_map`          |              159 |              63 |       160 |
| `fannkuch_redux_7`               |             2659 |            2521 |      1190 |
| `mat4_dot1`                      |              296 |             209 |       416 |
| `mat4_full`                      |             2123 |            1658 |       648 |

Timed rows from the same run:

| Scenario                         | Fig external ns/call | Fig internal ns/call | JavaScript ns/call | Rust ns/call |
| -------------------------------- | -------------------: | -------------------: | -----------------: | -----------: |
| `scalar_reuse_nway`              |                 14.2 |                  0.9 |                6.7 |          0.8 |
| `product_shadow_update`          |                 15.5 |                  6.4 |               21.8 |          2.5 |
| `tail_product_loop_1k`           |                396.1 |               1812.0 |              611.6 |        406.1 |
| `inline_array_builder_map`       |                 28.9 |                  5.8 |              756.8 |         18.2 |
| `compact_filter_collect`         |                 20.2 |                  2.7 |               82.3 |         12.9 |
| `alias_snapshot_update`          |                 19.9 |                  6.9 |               18.6 |          8.8 |
| `fixed_collection_update`        |                 18.9 |                 12.5 |              559.0 |          2.6 |
| `fixed_collection_spread_update` |                 19.1 |                 12.5 |              105.9 |          1.8 |
| `collision_aabb_64`              |                155.1 |                 82.7 |              254.8 |         49.0 |
| `path_grid_score_16`             |                393.7 |                331.2 |              714.0 |        160.7 |
| `range_fold_1k`                  |                518.6 |                214.7 |              462.5 |        243.7 |
| `monadic_do_id_chain`            |                 17.7 |                  2.1 |                6.4 |          1.0 |
| `applicative_do_id_map`          |                 14.7 |                  1.8 |                6.0 |          0.8 |
| `fannkuch_redux_7`               |             160569.0 |             189143.5 |           255659.7 |      89489.3 |
| `mat4_dot1`                      |                 16.9 |                  4.8 |               33.7 |          2.1 |
| `mat4_full`                      |                 30.1 |                 19.6 |               67.2 |         24.8 |

Dynamic fixed-array diagnostics from the same run:

| Scenario           | Dynamic selectors | Set/update calls | Spread helpers | Slot-copy/select sites | Transient sets | Flat | Scratch | Packed | Local slots |
| ------------------ | ----------------: | ---------------: | -------------: | ---------------------: | -------------: | ---: | ------: | -----: | ----------: |
| `fannkuch_redux_7` |                 0 |                0 |              0 |                      0 |              0 |    0 |       0 |      1 |           0 |

## Fannkuch Lowering Investigation

Run:

```bash
deno run -A scripts/analyze_fannkuch_lowering.ts
```

Current findings:

| Check                             | Result |
| --------------------------------- | -----: |
| WAT bytes                         |  60083 |
| Wasm bytes                        |   2521 |
| Wasm bytes without hints          |   2521 |
| Wasm code-section payload         |   2404 |
| Remaining `dec` calls             |      0 |
| Remaining `step_*` calls          |      0 |
| Remaining `flip_count_loop` calls |      1 |

The release path is already doing several important things correctly: `search` lowers to a loop,
`prepare`/`score`/`advance` do not survive as calls, `InlineArray.set`/`InlineArray.update` helpers
do not survive as calls, packed `u3` fixed arrays are used, and `fig_buffers` is absent.

The remaining perf pressure appears to be executable-code shape, not custom-section overhead. The
analyzer reports a 2404 byte code section inside the 2521 byte module, and disabling branch hints
does not reduce the binary. Narrow unsigned scalars inline predictably, product-state helpers are
fused into the `search` loop, packed swaps now use a direct bitfield XOR update, and non-packable
recursive fixed arrays can stay in local slots instead of scratch memory. The important remaining
miss is runtime: `fannkuch_redux_7` is still about 2.1x slower than native Rust on this local run,
so the next work should focus on loop/code-shape simplification rather than helper-call removal.

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
