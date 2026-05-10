# Benchmarks

These numbers compare Fig compiled to Wasm against equivalent JavaScript and Rust kernels. They are
machine-local measurements from the current working tree and should be used mainly for regression
tracking.

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

| Runtime    |                   Scenario | Calls |   Checksum | Elapsed ms |    Calls/ms | ns/call | Detail     |
| ---------- | -------------------------: | ----: | ---------: | ---------: | ----------: | ------: | ---------- |
| Fig/Wasm   |        `scalar_reuse_nway` | 50000 |    2000000 |      0.638 |   78365.116 |    12.8 | wat=196B   |
| JavaScript |        `scalar_reuse_nway` | 50000 |    2000000 |      0.500 |   99986.202 |    10.0 |            |
| Rust       |        `scalar_reuse_nway` | 50000 |    2000000 |      0.044 | 1127649.977 |     0.9 |            |
| Fig/Wasm   |    `product_shadow_update` | 50000 |    1800000 |      0.844 |   59230.548 |    16.9 | wat=850B   |
| JavaScript |    `product_shadow_update` | 50000 |    1800000 |      1.181 |   42349.589 |    23.6 |            |
| Rust       |    `product_shadow_update` | 50000 |    1800000 |      0.124 |  402026.212 |     2.5 |            |
| Fig/Wasm   |     `tail_product_loop_1k` |  2500 | 1251250000 |      0.979 |    2552.794 |   391.7 | wat=1178B  |
| JavaScript |     `tail_product_loop_1k` |  2500 | 1251250000 |      1.243 |    2011.590 |   497.1 |            |
| Rust       |     `tail_product_loop_1k` |  2500 | 1251250000 |      1.189 |    2102.079 |   475.7 |            |
| Fig/Wasm   | `inline_array_builder_map` | 12500 |     237500 |      0.373 |   33486.119 |    29.9 | wat=8476B  |
| JavaScript | `inline_array_builder_map` | 12500 |     237500 |      8.149 |    1533.959 |   651.9 |            |
| Rust       | `inline_array_builder_map` | 12500 |     237500 |      0.277 |   45139.553 |    22.2 |            |
| Fig/Wasm   |   `compact_filter_collect` | 25000 |      50000 |      1.118 |   22369.983 |    44.7 | wat=9035B  |
| JavaScript |   `compact_filter_collect` | 25000 |      50000 |      2.176 |   11489.720 |    87.0 |            |
| Rust       |   `compact_filter_collect` | 25000 |      50000 |      0.383 |   65217.958 |    15.3 |            |
| Fig/Wasm   |            `range_fold_1k` |  2500 | 1248750000 |      0.932 |    2682.493 |   372.8 | wat=1574B  |
| JavaScript |            `range_fold_1k` |  2500 | 1248750000 |      0.832 |    3004.811 |   332.8 |            |
| Rust       |            `range_fold_1k` |  2500 | 1248750000 |      0.663 |    3773.135 |   265.0 |            |
| Fig/Wasm   |              `mat4_kernel` | 50000 |    4500000 |      2.650 |   18870.652 |    53.0 | wat=13139B |
| JavaScript |              `mat4_kernel` | 50000 |    4500000 |      1.299 |   38482.911 |    26.0 |            |
| Rust       |              `mat4_kernel` | 50000 |    4500000 |      0.127 |  392403.076 |     2.5 |            |

## Notes

- Fig/Wasm is produced by the local compiler and instantiated through Deno's WebAssembly runtime.
- JavaScript runs in the same Deno/V8 process as the benchmark harness.
- Rust is compiled to a native binary with `black_box` around inputs and loop bodies where the
  harness needs to prevent constant-folding away the measured work.
- The `calls` count is reduced for heavier 1k-loop and builder scenarios by the benchmark harness,
  so `ns/call` is the most comparable per-scenario column.
