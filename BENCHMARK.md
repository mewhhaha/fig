# Benchmarks

These numbers compare Fig compiled to Wasm against equivalent JavaScript and Rust kernels. They are
machine-local measurements from the current working tree and should be used mainly for regression
tracking.

Fig is compiled with `memoryModel: "branch"` and `optLevel: "speed"`. The table reports both the old
exported-call shape and the new internal-loop shape:

- `Fig/Wasm external`: JavaScript calls the exported Wasm `main(seed)` once per measured iteration.
- `Fig/Wasm internal`: JavaScript calls exported Wasm `bench(iterations)` once, and the measured
  loop runs inside Wasm.

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

| Runtime           |                   Scenario | Calls |    Checksum | Elapsed ms |    Calls/ms | ns/call | Detail                                                                         |
| ----------------- | -------------------------: | ----: | ----------: | ---------: | ----------: | ------: | ------------------------------------------------------------------------------ |
| Fig/Wasm external |        `scalar_reuse_nway` | 50000 |  5001900000 |      0.813 |   61505.608 |    16.3 | wat=1369B calls=1 bench_calls=0 loops=1 simd=0 branch=0 ensure=0 temporal=0    |
| Fig/Wasm internal |        `scalar_reuse_nway` | 50000 |   706932704 |      0.052 |  968054.211 |     1.0 | wat=1369B calls=1 bench_calls=0 loops=1 simd=0 branch=0 ensure=0 temporal=0    |
| JavaScript        |        `scalar_reuse_nway` | 50000 |  5001900000 |      0.326 |  153393.996 |     6.5 |                                                                                |
| Rust              |        `scalar_reuse_nway` | 50000 |  5001900000 |      0.046 | 1093398.062 |     0.9 |                                                                                |
| Fig/Wasm external |    `product_shadow_update` | 50000 |  2501750000 |      0.843 |   59297.561 |    16.9 | wat=2995B calls=5 bench_calls=2 loops=1 simd=0 branch=0 ensure=0 temporal=0    |
| Fig/Wasm internal |    `product_shadow_update` | 50000 | -1793217296 |      0.382 |  131035.151 |     7.6 | wat=2995B calls=5 bench_calls=2 loops=1 simd=0 branch=0 ensure=0 temporal=0    |
| JavaScript        |    `product_shadow_update` | 50000 |  2501750000 |      1.126 |   44423.832 |    22.5 |                                                                                |
| Rust              |    `product_shadow_update` | 50000 |  2501750000 |      0.137 |  364699.961 |     2.7 |                                                                                |
| Fig/Wasm external |     `tail_product_loop_1k` |  2500 |  1251250000 |      0.987 |    2532.407 |   394.9 | wat=2803B calls=3 bench_calls=1 loops=2 simd=0 branch=0 ensure=0 temporal=0    |
| Fig/Wasm internal |     `tail_product_loop_1k` |  2500 |  1251250000 |      0.648 |    3858.763 |   259.2 | wat=2803B calls=3 bench_calls=1 loops=2 simd=0 branch=0 ensure=0 temporal=0    |
| JavaScript        |     `tail_product_loop_1k` |  2500 |  1251250000 |      1.557 |    1605.230 |   623.0 |                                                                                |
| Rust              |     `tail_product_loop_1k` |  2500 |  1251250000 |      0.947 |    2640.490 |   378.7 |                                                                                |
| Fig/Wasm external | `inline_array_builder_map` | 12500 |      237500 |      0.383 |   32604.131 |    30.7 | wat=16241B calls=1 bench_calls=0 loops=1 simd=0 branch=0 ensure=0 temporal=0   |
| Fig/Wasm internal | `inline_array_builder_map` | 12500 |      237500 |      0.079 |  158430.398 |     6.3 | wat=16241B calls=1 bench_calls=0 loops=1 simd=0 branch=0 ensure=0 temporal=0   |
| JavaScript        | `inline_array_builder_map` | 12500 |      237500 |      8.693 |    1437.950 |   695.4 |                                                                                |
| Rust              | `inline_array_builder_map` | 12500 |      237500 |      0.222 |   56256.132 |    17.8 |                                                                                |
| Fig/Wasm external |   `compact_filter_collect` | 25000 |       50000 |      1.017 |   24579.373 |    40.7 | wat=11653B calls=9 bench_calls=4 loops=1 simd=0 branch=0 ensure=0 temporal=0   |
| Fig/Wasm internal |   `compact_filter_collect` | 25000 |       50000 |      0.642 |   38915.048 |    25.7 | wat=11653B calls=9 bench_calls=4 loops=1 simd=0 branch=0 ensure=0 temporal=0   |
| JavaScript        |   `compact_filter_collect` | 25000 |       50000 |      2.209 |   11319.772 |    88.3 |                                                                                |
| Rust              |   `compact_filter_collect` | 25000 |       50000 |      0.318 |   78584.721 |    12.7 |                                                                                |
| Fig/Wasm external |    `alias_snapshot_update` | 50000 |  2504050000 |      0.758 |   65948.792 |    15.2 | wat=7221B calls=3 bench_calls=1 loops=1 simd=0 branch=0 ensure=0 temporal=0    |
| Fig/Wasm internal |    `alias_snapshot_update` | 50000 | -1790917296 |      0.339 |  147484.794 |     6.8 | wat=7221B calls=3 bench_calls=1 loops=1 simd=0 branch=0 ensure=0 temporal=0    |
| JavaScript        |    `alias_snapshot_update` | 50000 |  2504050000 |      0.871 |   57421.565 |    17.4 |                                                                                |
| Rust              |    `alias_snapshot_update` | 50000 |  2504050000 |      0.428 |  116825.978 |     8.6 |                                                                                |
| Fig/Wasm external |  `fixed_collection_update` | 12500 |      437500 |      8.336 |    1499.498 |   666.9 | wat=230820B calls=5 bench_calls=1 loops=2 simd=0 branch=0 ensure=0 temporal=0  |
| Fig/Wasm internal |  `fixed_collection_update` | 12500 |      437500 |      1.407 |    8885.287 |   112.5 | wat=230820B calls=5 bench_calls=1 loops=2 simd=0 branch=0 ensure=0 temporal=0  |
| JavaScript        |  `fixed_collection_update` | 12500 |      437500 |      6.724 |    1859.100 |   537.9 |                                                                                |
| Rust              |  `fixed_collection_update` | 12500 |      437500 |      0.032 |  395444.480 |     2.5 |                                                                                |
| Fig/Wasm external |        `collision_aabb_64` |  6250 |       56250 |      1.134 |    5512.913 |   181.4 | wat=4554B calls=3 bench_calls=1 loops=2 simd=0 branch=0 ensure=0 temporal=0    |
| Fig/Wasm internal |        `collision_aabb_64` |  6250 |       56250 |      0.484 |   12900.243 |    77.5 | wat=4554B calls=3 bench_calls=1 loops=2 simd=0 branch=0 ensure=0 temporal=0    |
| JavaScript        |        `collision_aabb_64` |  6250 |       56250 |      1.671 |    3741.287 |   267.3 |                                                                                |
| Rust              |        `collision_aabb_64` |  6250 |       56250 |      0.317 |   19701.359 |    50.8 |                                                                                |
| Fig/Wasm external |       `path_grid_score_16` |  6250 |    19125000 |      2.736 |    2284.214 |   437.8 | wat=1817B calls=3 bench_calls=1 loops=2 simd=0 branch=0 ensure=0 temporal=0    |
| Fig/Wasm internal |       `path_grid_score_16` |  6250 |    19125000 |      1.995 |    3133.547 |   319.1 | wat=1817B calls=3 bench_calls=1 loops=2 simd=0 branch=0 ensure=0 temporal=0    |
| JavaScript        |       `path_grid_score_16` |  6250 |    19125000 |      3.071 |    2034.957 |   491.4 |                                                                                |
| Rust              |       `path_grid_score_16` |  6250 |    19125000 |      1.099 |    5687.283 |   175.8 |                                                                                |
| Fig/Wasm external |            `range_fold_1k` |  2500 |  1248750000 |      1.014 |    2465.914 |   405.5 | wat=2998B calls=5 bench_calls=2 loops=2 simd=0 branch=0 ensure=0 temporal=0    |
| Fig/Wasm internal |            `range_fold_1k` |  2500 |  1248750000 |      0.535 |    4675.904 |   213.9 | wat=2998B calls=5 bench_calls=2 loops=2 simd=0 branch=0 ensure=0 temporal=0    |
| JavaScript        |            `range_fold_1k` |  2500 |  1248750000 |      1.078 |    2319.447 |   431.1 |                                                                                |
| Rust              |            `range_fold_1k` |  2500 |  1248750000 |      0.662 |    3778.176 |   264.7 |                                                                                |
| Fig/Wasm external |                `mat4_dot1` | 50000 |     4500000 |      0.753 |   66431.499 |    15.1 | wat=5310B calls=1 bench_calls=0 loops=1 simd=44 branch=0 ensure=0 temporal=0   |
| Fig/Wasm internal |                `mat4_dot1` | 50000 |     4500000 |      0.228 |  219406.024 |     4.6 | wat=5310B calls=1 bench_calls=0 loops=1 simd=44 branch=0 ensure=0 temporal=0   |
| JavaScript        |                `mat4_dot1` | 50000 |     4500000 |      1.455 |   34357.437 |    29.1 |                                                                                |
| Rust              |                `mat4_dot1` | 50000 |     4500000 |      0.300 |  166812.349 |     6.0 |                                                                                |
| Fig/Wasm external |                `mat4_full` | 50000 |   247200000 |      2.793 |   17901.577 |    55.9 | wat=14304B calls=4 bench_calls=1 loops=1 simd=184 branch=0 ensure=0 temporal=0 |
| Fig/Wasm internal |                `mat4_full` | 50000 |   247200000 |      1.923 |   26003.528 |    38.5 | wat=14304B calls=4 bench_calls=1 loops=1 simd=184 branch=0 ensure=0 temporal=0 |
| JavaScript        |                `mat4_full` | 50000 |   247200000 |      3.602 |   13881.277 |    72.0 |                                                                                |
| Rust              |                `mat4_full` | 50000 |   247200000 |      1.755 |   28485.370 |    35.1 |                                                                                |

## Notes

- Fig/Wasm is produced by the local compiler and instantiated through Deno's WebAssembly runtime.
- The Fig internal-loop checksum is an exported `i32`, so it intentionally shows Wasm `i32` wrapping
  for high-volume scalar/product checksums.
- JavaScript runs in the same Deno/V8 process as the benchmark harness.
- Rust is compiled to a native binary with `black_box` around inputs and loop bodies where the
  harness needs to prevent constant-folding away the measured work.
- The `calls` count is reduced for heavier 1k-loop and builder scenarios by the benchmark harness,
  so `ns/call` is the most comparable per-scenario column.
- The `Detail` column includes WAT-shape counters for Fig: direct calls, calls left in the internal
  bench loop, loops, SIMD operations, branch helpers, ensure-editable helpers, and temporal
  intrinsic references.
- `alias_snapshot_update` and `fixed_collection_update` are deliberately adversarial value-reuse
  cases. The former stays reasonably flat; the latter currently exposes a fixed-array
  update/code-size problem (`230820B` WAT) even though it still emits no branch, ensure, temporal,
  or heap helpers.
- `collision_aabb_64` and `path_grid_score_16` are common systems-style kernels that stress flat
  products, nested conditionals, integer division/modulo, and scalar loop lowering.
