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

- Date: 2026-05-13
- OS: Linux 7.0.5-1-cachyos x86_64
- Deno: 2.7.14, V8 14.7.173.20-rusty, TypeScript 5.9.2
- Rust: rustc 1.96.0-nightly (3645249d7 2026-03-16)

## Command

```bash
deno run --allow-read --allow-write --allow-run scripts/bench_memory_model_compare.ts 50000
```

Current status: the release-gated command above completes. `fannkuch_redux_7` remains about 1.07x
the stripped Rust/Wasm kernel size and the latest full run is about 1.05x Rust runtime. The table
records the latest local run and the investigation section calls out the remaining emitted pattern.

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
| `scalar_reuse_nway`              |              141 |              54 |       140 |
| `product_shadow_update`          |              186 |             107 |       225 |
| `tail_product_loop_1k`           |              272 |             125 |       348 |
| `inline_array_builder_map`       |              536 |             249 |       530 |
| `compact_filter_collect`         |              695 |             616 |       317 |
| `alias_snapshot_update`          |              245 |             204 |       224 |
| `fixed_collection_update`        |              264 |             183 |       278 |
| `fixed_collection_spread_update` |              235 |             153 |       261 |
| `collision_aabb_64`              |              339 |             238 |       275 |
| `path_grid_score_16`             |              194 |             118 |       189 |
| `range_fold_1k`                  |              229 |             137 |       333 |
| `monadic_do_id_chain`            |              173 |              74 |       182 |
| `applicative_do_id_map`          |              145 |              55 |       160 |
| `fannkuch_redux_7`               |             1427 |            1270 |      1190 |
| `mat4_dot1`                      |              290 |             209 |       416 |
| `mat4_full`                      |             2111 |            1652 |       648 |

Timed rows from the same run:

| Scenario                         | Fig external ns/call | Fig internal ns/call | JavaScript ns/call | Rust ns/call |
| -------------------------------- | -------------------: | -------------------: | -----------------: | -----------: |
| `scalar_reuse_nway`              |                 14.7 |                  0.9 |                7.1 |          0.8 |
| `product_shadow_update`          |                 15.1 |                  6.0 |               20.9 |          2.3 |
| `tail_product_loop_1k`           |                343.0 |                998.6 |              590.0 |        434.2 |
| `inline_array_builder_map`       |                 23.1 |                  6.1 |              661.9 |         22.4 |
| `compact_filter_collect`         |                 33.4 |                  7.1 |               73.1 |         16.4 |
| `alias_snapshot_update`          |                 25.9 |                  4.9 |               21.3 |         10.7 |
| `fixed_collection_update`        |                 18.6 |                 12.6 |              580.9 |          3.2 |
| `fixed_collection_spread_update` |                 13.6 |                  6.2 |               31.4 |          2.3 |
| `collision_aabb_64`              |                137.3 |                 75.4 |              244.2 |         63.8 |
| `path_grid_score_16`             |                458.7 |                317.0 |              567.2 |        214.3 |
| `range_fold_1k`                  |                437.9 |                260.2 |              611.5 |        374.2 |
| `monadic_do_id_chain`            |                 14.7 |                  1.9 |                5.8 |          1.0 |
| `applicative_do_id_map`          |                 18.3 |                  1.9 |                8.1 |          0.8 |
| `fannkuch_redux_7`               |             120503.6 |             120498.2 |           269780.7 |     114291.5 |
| `mat4_dot1`                      |                 16.2 |                  4.3 |               26.2 |          2.2 |
| `mat4_full`                      |                 31.4 |                 19.0 |               69.8 |         23.2 |

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
| WAT bytes                         |  27024 |
| Wasm bytes                        |   1270 |
| Wasm bytes without hints          |   1270 |
| Wasm code-section payload         |   1187 |
| Remaining `dec` calls             |      0 |
| Remaining `step_*` calls          |      0 |
| Remaining `flip_count_loop` calls |      0 |

The release path is already doing several important things correctly: `search` lowers to a loop,
`prepare`/`score`/`advance` do not survive as calls, `InlineArray.set`/`InlineArray.update` helpers
do not survive as calls, packed `u3` fixed arrays are used, and `fig_buffers` is absent.

The remaining perf pressure appears to be executable-code shape, not custom-section overhead. The
analyzer reports a 1187 byte code section inside the 1270 byte kernel module, and disabling branch
hints does not reduce the binary. Narrow unsigned scalars inline predictably, product-state helpers
are fused into the `search` loop, packed swaps now use a direct bitfield XOR update, and
non-packable recursive fixed arrays can stay in local slots instead of scratch memory. Dead product
arguments can now alias private inlined product calls when the caller no longer observes the
original product, deadness propagates through simple inlined forwarding branches, locals are ordered
by use frequency before Wasm binary encoding, duplicate lowered locals are removed, and spread-shape
updates reuse backed fixed-array storage before materializing result slots. Packed-array updates
also avoid re-masking values that already came from a compatible packed-array read, parity checks of
the form `(x % 2) == 0` lower through `i32.and` instead of signed remainder, and release cleanup
folds adjacent constant binary instruction sequences into one constant. Tail-recursive product
updates can now keep backed fixed-array fields in their backing store across the self-loop instead
of unpacking and repacking unchanged product slots, including multiple backed fields in the same
product update and direct recursive fixed-array transformer fields. Private fixed-array transformer
results can also stay backed across the caller's self-loop. Single-forward let-bound fixed-array
updates can now be deferred into the backed product update as well, which keeps that fold general
without changing branch evaluation semantics. Tail-loop parameter updates can also fold a local
product state plus matching scalar loop parameter directly into the loop targets, removing the
intermediate inlined `step_active` state materialization pattern. Packed-array stores now skip masks
for typed narrow locals, skip final-lane masks when static loads are already bounded by the packed
storage width, fold adjacent packed-lane copies, reuse a prior dynamic packed read across the
matching read-modify-write update until an intervening packed write invalidates that cache, and
inline single-call private scalar self-tail loops directly into their caller as structured Wasm
loops. Inlined scalar tail loops and private product-returning inlines with packed fixed-array
parameters can initialize the packed backing directly from a local source array, avoiding temporary
callee lane locals when doing so would not duplicate argument evaluation. Structurally recognized
packed prefix-shift fixed-array transformers now fold into direct packed bit operations, removing
the hot `rotate_left_loop` helper loop without depending on benchmark-specific function names.
Packed dynamic stores that immediately follow a cached read of the same lane now use an XOR-delta
update instead of clearing and OR-ing the lane, the prefix-shift fold reuses the packed source local
directly rather than copying it through a second temporary, and cleanup folds multi-value block
results that are immediately stored to locals into direct branch-exit stores.

`fannkuch_redux_7` now has no remaining private helper calls inside `search`, and the kernel size is
about 1.07x Rust/Wasm. The largest emitted pattern is still materialization of
intermediate `search` products (`prepared`, `scored`, and `next`) plus the remaining materialization
of rotated/count fixed-array fields around the hot `step_continue` branch result instead of writing
that result directly into the tail-loop targets. A prototype lexical product-field alias fold reduced
size further but was backed out because inlined tail-loop lowering mutates callee parameter locals;
preserving correctness there needs alias invalidation or destination-aware branch result lowering.

Recent local comparison reruns on this final tree produced `fannkuch_redux_7` internal timings of
`103679.3`, `108065.6`, `105224.6`, `108650.2`, and `120498.2 ns/call`, against Rust timings of
`107435.2`, `97123.5`, `99007.7`, `107722.6`, and `114291.5 ns/call`. The latest full run is about
`1.054x` Rust runtime; across these runs the best Fig result is faster than Rust and the median stays
close to the 1.0x line.

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
  the private product-state search step in release mode. Its current kernel size is about 1.07x the
  Rust/Wasm size reference; the remaining release pressure is mostly binary section overhead and
  stable internal-loop timing.
