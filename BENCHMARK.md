# Benchmarks

These numbers are machine-local measurements from the current working tree and should be used mainly
for regression tracking. The latest local run records Fig/Wasm size, runtime, and compilation phase
time; the saved Rust comparison below compares Fig compiled to Wasm against equivalent native Rust
kernels.

Fig is compiled with `optMode: "release"` and `memoryModel: "branch"`. The benchmark harness only
reports the internal-loop shape: Deno instantiates the Fig Wasm module and calls exported
`bench(iterations)` once, while the measured loop runs inside Wasm. The local benchmark harnesses
also enable conservative imported-declaration pruning with `pruneImports: true`. The comparison
table includes Fig internal-loop rows and native Rust rows.

## Environment

- Date: 2026-05-16
- OS: Linux 7.0.5-1-cachyos x86_64
- Deno: 2.7.14, V8 14.7.173.20-rusty, TypeScript 5.9.2
- Rust: rustc 1.96.0-nightly (3645249d7 2026-03-16)

## Latest Local Size/Perf/Compile Run

Run:

```bash
deno run --allow-read scripts/bench_memory_model.ts 100000
deno run --allow-read scripts/bench_range_fold_compile.ts
deno run --allow-read scripts/bench_const_params.ts --sizes=10,100,200,500,1000 --iterations=3
deno run --allow-read scripts/bench_tail_recursion.ts
deno run --allow-read scripts/bench_matmul_simd.ts 100000
```

The memory-model benchmark completed and passed all size/shape gates. The run uses one shared
compile cache across scenarios for parsed source imports, keyed by module source text so changed
module contents do not reuse stale parses. Aliased and destructured source imports are pruned before
qualification when local references or explicit bindings identify a smaller imported root set.
Compile phase columns come from one parsed/imported/checked program; backend lowering runs once,
then WAT and Wasm are rendered and encoded from the same lowered backend module. Backend timing is
also split into release optimization, backend layout/planning, function lowering, and backend
cleanup. The benchmark output also reports `compile_total_with_wat_ms` and
`compile_total_wasm_only_ms`; the selected table's `Total ms` column is the WAT-including total used
for shape-gated benchmark runs. Selected rows:

| Scenario                   |  Calls |  ns/call | Parse ms | Import ms | Check ms | Backend ms | Optimize ms | Layout ms | Lower ms | Cleanup ms | WAT ms | Wasm ms | Total ms | WAT bytes | Wasm bytes | Loops | Recursive calls | SIMD ops |
| -------------------------- | -----: | -------: | -------: | --------: | -------: | ---------: | ----------: | --------: | -------: | ---------: | -----: | ------: | -------: | --------: | ---------: | ----: | --------------: | -------: |
| `scalar_reuse_nway`        | 100000 |     34.7 |    3.566 |     0.772 |    8.956 |      7.634 |       4.168 |     0.906 |    2.200 |      0.198 |  0.240 |   0.507 |   21.676 |       151 |         44 |     0 |               0 |        0 |
| `tail_product_loop_1k`     |   5000 |    333.4 |    1.407 |     0.152 |    1.261 |      7.395 |       1.790 |     1.002 |    4.511 |      0.076 |  0.106 |   0.168 |   10.489 |      1269 |        109 |     1 |               0 |        0 |
| `inline_array_builder_map` |  25000 |     28.4 |    1.450 |    38.363 |   10.615 |     12.786 |       3.554 |     1.207 |    7.522 |      0.483 |  0.023 |   0.081 |   63.317 |       183 |         47 |     0 |               0 |        0 |
| `compact_filter_collect`   |  50000 |     75.0 |    1.319 |    51.836 |    7.328 |     25.777 |       9.460 |     1.218 |   14.913 |      0.162 |  0.975 |   1.577 |   88.811 |     22856 |       1731 |     2 |               0 |        0 |
| `fixed_collection_update`  |  25000 |     30.5 |    0.511 |     5.163 |    2.402 |      3.519 |       1.865 |     0.264 |    1.322 |      0.059 |  0.011 |   0.037 |   11.644 |        91 |         38 |     0 |               0 |        0 |
| `path_grid_score_16`       |  12500 |    180.1 |    0.540 |     0.097 |    0.395 |      1.954 |       0.743 |     0.089 |    1.099 |      0.014 |  0.023 |   0.044 |    3.053 |      1227 |        113 |     1 |               0 |        0 |
| `range_fold_1k`            |   5000 |    249.0 |    0.290 |     2.246 |    0.794 |      2.280 |       1.256 |     0.119 |    0.882 |      0.016 |  0.026 |   0.041 |    5.678 |      2507 |        122 |     1 |               0 |        0 |
| `fannkuch_redux_7`         |    100 | 129123.7 |    6.902 |     4.806 |    3.644 |     28.227 |       5.782 |     2.146 |   20.202 |      0.083 |  0.266 |   0.501 |   44.347 |     21989 |       1146 |     5 |               0 |        0 |
| `mat4_dot1`                | 100000 |     12.9 |    0.619 |     0.064 |    0.303 |      1.221 |       0.553 |     0.043 |    0.606 |      0.012 |  0.030 |   0.123 |    2.360 |       853 |        145 |     0 |               0 |       14 |
| `mat4_full`                | 100000 |     83.1 |    2.884 |     0.184 |    0.792 |      7.150 |       5.763 |     0.087 |    1.253 |      0.038 |  0.045 |   0.106 |   11.161 |      3814 |        426 |     0 |               0 |       38 |

The same memory-model benchmark also passed all gates with `--profile=release_fast_compile`.
Selected compile-time comparison against the balanced release profile:

| Scenario                  | Balanced Backend ms | Balanced Total ms | Fast Backend ms | Fast Total ms | Fast WAT bytes | Fast Wasm bytes |
| ------------------------- | ------------------: | ----------------: | --------------: | ------------: | -------------: | --------------: |
| `compact_filter_collect`  |              25.777 |            88.811 |          28.181 |       105.060 |          22856 |            1731 |
| `fixed_collection_update` |               3.519 |            11.644 |           2.775 |        11.940 |             91 |              38 |
| `fannkuch_redux_7`        |              28.227 |            44.347 |          27.501 |        45.359 |          21989 |            1146 |
| `mat4_full`               |               7.150 |            11.161 |           7.767 |        12.106 |           3814 |             426 |

Focused range-fold compile shape from:

```bash
deno run --allow-read scripts/bench_range_fold_compile.ts
```

This uses one shared compile cache, so the final repeated prelude row is the warm balanced result.
The optimized WAT keeps one loop, zero recursive calls, and zero remaining function calls.

| Scenario                          | Profile                | Optimize ms | Total Wasm-only ms | WAT bytes | Wasm bytes | Loops | Recursive calls | Function calls | Optimizer passes | Touched fns | Slowest optimizer phase                             |
| --------------------------------- | ---------------------- | ----------: | -----------------: | --------: | ---------: | ----: | --------------: | -------------: | ---------------: | ----------: | --------------------------------------------------- |
| `direct_loop`                     | `release_balanced`     |       4.782 |             26.998 |       700 |         82 |     1 |               0 |              0 |                2 |           2 | `opt.expandFiniteStaticRecurrences.initial:1.699ms` |
| `user_wrapper_fold`               | `release_balanced`     |       2.372 |              7.991 |       770 |         82 |     1 |               0 |              0 |                2 |           5 | `opt.pass.0.optimizeDecls:0.734ms`                  |
| `prelude_range_fold`              | `release_balanced`     |       2.155 |             13.681 |      2507 |        122 |     1 |               0 |              0 |                1 |           5 | `opt.pass.0.optimizeDecls:0.550ms`                  |
| `prelude_range_fold_fast_compile` | `release_fast_compile` |       1.203 |              5.918 |      2507 |        122 |     1 |               0 |              0 |                1 |           5 | `opt.pass.0.optimizeDecls:0.416ms`                  |
| `prelude_range_fold_balanced`     | `release_balanced`     |       1.058 |              4.464 |      2507 |        122 |     1 |               0 |              0 |                1 |           5 | `opt.pass.0.optimizeDecls:0.367ms`                  |

Focused compile-time scaling from:

```bash
deno run --allow-read scripts/bench_const_params.ts --sizes=10,100,200,500,1000 --iterations=3
```

| Calls | Direct avg ms | Runtime-dict avg ms | Const-param avg ms | Slowest parse phase at const-param | Slowest check phase at const-param | Const-param specialization summary                                                             |
| ----: | ------------: | ------------------: | -----------------: | ---------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
|    10 |         2.836 |               1.843 |              2.011 | `parse.syntax:0.795ms`             | `checkFn loop:0.112ms`             | `inferred #1 v1/g0/h0/m0; const #1 v0/g0/h0/m0; inferred #2 v1/g0/h0/m0; const #2 v0/g0/h0/m0` |
|   100 |         6.576 |               7.580 |              7.052 | `parse.syntax:2.072ms`             | `checkFn loop:0.381ms`             | `inferred #1 v1/g0/h0/m0; const #1 v0/g0/h0/m0; inferred #2 v1/g0/h0/m0; const #2 v0/g0/h0/m0` |
|   200 |         7.815 |              11.119 |              9.027 | `parse.syntax:4.396ms`             | `checkFn loop:0.861ms`             | `inferred #1 v1/g0/h0/m0; const #1 v0/g0/h0/m0; inferred #2 v1/g0/h0/m0; const #2 v0/g0/h0/m0` |
|   500 |        20.395 |              23.582 |             24.837 | `parse.syntax:12.706ms`            | `checkFn loop:2.671ms`             | `inferred #1 v1/g0/h0/m0; const #1 v0/g0/h0/m0; inferred #2 v1/g0/h0/m0; const #2 v0/g0/h0/m0` |
|  1000 |        37.369 |              42.317 |             43.744 | `parse.syntax:15.980ms`            | `checkFn loop:2.766ms`             | `inferred #1 v1/g0/h0/m0; const #1 v0/g0/h0/m0; inferred #2 v1/g0/h0/m0; const #2 v0/g0/h0/m0` |

The repeated-call benchmark now completes through 1000 calls without timeout. The primitive `+`
chain is balanced after operator resolution, so the checker loop is no longer the visible 1000-call
bottleneck; parse syntax/lowering is now the larger remaining traced cost. The generated
specialization count stays stable in the traced benchmark, and the focused regression test covers
the 100 repeated const-param call shape with one generated wrapper, one specialization cache miss,
and cache hits growing with repeated calls.

The current memory-model run also passed the compact-filter WAT gate: `compact_filter_collect`
compiled to 22856 WAT bytes and 1731 Wasm bytes, under the 30000-byte WAT limit.

Tail-recursion benchmark medians:

| Scenario   | Variant                    | Median ms | p95 ms | Large-n overflow | `return_call` |
| ---------- | -------------------------- | --------: | -----: | ---------------- | ------------: |
| `sum`      | default tail recursive     |     0.138 |  0.162 | false            |         false |
| `sum`      | opcode return-call         |     6.486 |  8.985 | false            |          true |
| `sum`      | default non-tail recursive |     0.221 |  0.452 | true             |         false |
| `pipeline` | default tail recursive     |     0.264 |  0.357 | false            |         false |
| `pipeline` | opcode return-call         |    15.848 | 24.225 | false            |          true |
| `pipeline` | default non-tail recursive |     0.273 |  0.391 | false            |         false |
| `stress`   | default tail recursive     |     0.104 |  0.169 | false            |         false |
| `stress`   | opcode return-call         |    35.892 | 41.036 | false            |          true |
| `stress`   | default non-tail recursive |     0.225 |  0.331 | true             |         false |

SIMD matmul at 100000 iterations:

| Scalar ms | SIMD ms | Speedup | SIMD mul ops | SIMD shuffle ops |          Checksum |
| --------: | ------: | ------: | -----------: | ---------------: | ----------------: |
|     6.867 |   6.493 |  1.058x |           16 |               32 | `9000000/9000000` |

## Rust Comparison Command

```bash
deno run --allow-read --allow-write --allow-run scripts/bench_memory_model_compare.ts 20000000
```

Current status: the release-gated command above completed on the 2026-05-16 local rerun. The
comparison harness compiles an internal `bench` wrapper around each Fig scenario, so its Fig compile
totals are not identical to the memory-model table above. The current comparison has 12 of 17 rows
at or under 1.2x native Rust. The over-target rows are `compact_filter_collect`,
`collision_aabb_64`, `path_grid_score_16`, `cpu_raycaster_64`, and `range_fold_1k`.

The Rust comparison is compiled by the benchmark harness with:

```bash
rustc -C opt-level=3 -C target-cpu=native
```

## Latest Rust Comparison Results

Timed rows from the 2026-05-16 run:

| Scenario                         |    Calls | Fig ns/call | Rust ns/call | Fig/Rust | Fig compile total ms | Fig Wasm bytes |    Checksum |
| -------------------------------- | -------: | ----------: | -----------: | -------: | -------------------: | -------------: | ----------: |
| `scalar_reuse_nway`              | 20000000 |         0.8 |          0.6 |     1.33 |               28.904 |            103 | -1323389440 |
| `product_shadow_update`          | 20000000 |         0.8 |          1.9 |     0.42 |               10.241 |            103 |  1805788928 |
| `tail_product_loop_1k`           |  1000000 |       233.1 |        434.9 |     0.54 |                9.020 |            191 | -2011173632 |
| `inline_array_builder_map`       |  5000000 |         0.7 |         20.1 |     0.03 |               58.201 |            100 |    95000000 |
| `compact_filter_collect`         | 10000000 |        19.6 |         13.7 |     1.43 |               89.313 |           1745 |    20000000 |
| `alias_snapshot_update`          | 20000000 |         2.5 |          9.0 |     0.28 |               12.647 |            149 | -1569178368 |
| `fixed_collection_update`        |  5000000 |         0.7 |          2.8 |     0.25 |               12.606 |            100 |   175000000 |
| `fixed_collection_spread_update` |  5000000 |         0.3 |          2.0 |     0.15 |                8.163 |            100 |   175000000 |
| `collision_aabb_64`              |  2500000 |       106.3 |         52.2 |     2.04 |                7.321 |            364 |    22500000 |
| `path_grid_score_16`             |  2500000 |       300.3 |        158.7 |     1.89 |                5.039 |            245 |  -939934592 |
| `cpu_raycaster_64`               |  2500000 |       644.4 |        218.4 |     2.95 |               10.039 |            761 |  1539681120 |
| `range_fold_1k`                  |  1000000 |       504.0 |        248.5 |     2.03 |                9.930 |            256 |  1283793664 |
| `monadic_do_id_chain`            | 20000000 |         0.7 |          1.1 |     0.64 |                7.491 |            113 |  1225788928 |
| `applicative_do_id_map`          | 20000000 |         0.7 |          0.9 |     0.78 |                3.829 |            110 |  1245788928 |
| `fannkuch_redux_7`               |    20000 |    108510.3 |      90094.1 |     1.20 |               39.885 |           1218 |   456320000 |
| `mat4_dot1`                      | 20000000 |         0.7 |          2.0 |     0.35 |                3.800 |            102 |  1800000000 |
| `mat4_full`                      | 20000000 |        13.9 |         25.4 |     0.55 |               17.765 |            899 |    95752192 |

## Fannkuch Lowering Investigation

Run:

```bash
deno run -A scripts/analyze_fannkuch_lowering.ts
```

Current findings:

| Check                             | Result |
| --------------------------------- | -----: |
| WAT bytes                         |  22881 |
| Wasm bytes                        |   1146 |
| Wasm bytes without hints          |   1146 |
| Wasm code-section payload         |   1063 |
| Remaining `dec` calls             |      0 |
| Remaining `step_*` calls          |      0 |
| Remaining `flip_count_loop` calls |      0 |

The release path is already doing several important things correctly: `search` lowers to a loop,
`prepare`/`score`/`advance` do not survive as calls, `InlineArray.set`/`InlineArray.update` helpers
do not survive as calls, packed `u3` fixed arrays are used, and `fig_buffers` is absent.

The remaining perf pressure appears to be executable-code shape, not plugin dispatch overhead. The
analyzer reports a 1063 byte code-section payload inside the 1146 byte kernel module, with no
branch-hint custom section in this sample. Narrow unsigned scalars inline predictably, product-state
helpers are fused into the `search` loop, packed swaps now use a direct bitfield XOR update, and
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
results that are immediately stored to locals into direct branch-exit stores. Private fixed-array
transformer forwarding wrappers can now keep their forwarded array parameter backed when inlined,
removing scalar lane copies before packed transformer folds. Backed fixed-array transformer blocks
can also fold pure scalar aliases into the packed prefix-shift recognizer, so wrapper locals like
`let first = xs[0]` do not have to survive when the transformer writes into backed storage. Cleanup
now also folds forwarded fixed-array lane temps through branch-local product updates, so branch arms
that forward `rotated`/`count`-style fixed-array products can write the destination product slots
directly instead of preserving a temporary lane shuttle through both arms. Public exports now inline
non-recursive private scalar-product helpers, pure scalar helpers, and pure one-use scalar arguments
while leaving fixed-array product helpers on the existing backed-storage lowering path. Private
wrappers keep array-free product-returning self-tail loops callable instead of embedding a second
loop into the caller, while fixed-array product tail loops still take the backed-storage fusion
path. Let-bound fixed-array updates now project static index consumers instead of materializing
every updated slot, and pure tabulated source arrays can project only the source indexes that those
updates/readbacks observe. Fixed-array spread updates now feed those projection uses back to the
spread source, and literal fixed arrays can materialize only the slots that survive the projection.
Tail-loop lowering folds pure scalar branch aliases, avoids per-iteration copies introduced by
generic branch-local bindings, and public exports can inline single-use private product and scalar
tail loops when the callee has no helper calls or fixed-array storage plans. Tail-call lowering also
skips unchanged scalar parameters, removing invariant loop-target stores from both direct self-tail
calls and generated parameter-update blocks. Match lowering can share repeated pure scalar div/rem
subexpressions between a scrutinee and its arms when the subexpression is already evaluated by the
scrutinee and has a statically safe divisor. Release lowering also uses `select` for pure
non-trapping two-arm scalar accumulator updates with non-call conditions, keeping branch-heavy loops
branchless without speculating trapping arithmetic or predicate helper calls. The optimizer also
unwraps parenthesized expression calls before algebraic cleanup, folds pure `(a + x) - x` shapes,
lowers power-of-two scalar multiplication through shifts, and keeps fully literal SIMD lane arrays
scalar until a vector operation actually needs them. Generated pure const-function helpers are now
marked inlineable, and scalar call inlining aliases one-use pure scalar arguments plus simple scalar
variable arguments.

`fannkuch_redux_7` now has no remaining private helper calls inside `search`. The hot WAT is close
but still not fully optimal: `search` still materializes intermediate products (`prepared`,
`scored`, and `next`) and unpacks the packed count field at branch exits instead of carrying the
packed backing all the way into every tail-loop target/result path. A prototype lexical
product-field alias fold reduced size further but was backed out because inlined tail-loop lowering
mutates callee parameter locals; preserving correctness there needs alias invalidation or
destination-aware branch result lowering.

Recent local comparison reruns on this final tree produced `fannkuch_redux_7` internal timings of
`103679.3`, `108065.6`, `105224.6`, `108650.2`, `120498.2`, `103818.7`, `106591.3`, `192031.7`,
`118779.1`, `102704.3`, `131926.0`, `115562.5`, `114405.9`, `109495.8`, `123779.4`, `112639.3`,
`122702.9`, `105304.4`, `138790.7`, `116102.8`, `109109.7`, `116669.0`, `109179.6`, `134063.8`,
`123520.5`, `117591.1`, `116034.2`, `115433.0`, `118172.1`, and `123184.8 ns/call`, against Rust
timings of `107435.2`, `97123.5`, `99007.7`, `107722.6`, `114291.5`, `96560.8`, `98842.2`,
`105409.1`, `87820.7`, `84673.4`, `89164.0`, `112099.6`, `89493.6`, `91065.3`, `90703.0`, `95209.4`,
`96173.4`, `100131.4`, `86586.3`, `102757.3`, `86336.5`, `98276.7`, `93203.3`, `105906.5`,
`97941.8`, `94640.8`, `94971.9`, `90468.7`, `93377.0`, and `92675.7 ns/call`. The latest saved full
run above is about `1.22x` Rust runtime, and the best historical Fig result remains faster than
Rust.

## Notes

- Fig/Wasm is produced by the local compiler and instantiated through Deno's WebAssembly runtime.
- The Fig internal-loop checksum is an exported `i32`, so it intentionally shows Wasm `i32` wrapping
  for high-volume scalar/product checksums.
- Rust is compiled to a native binary with `black_box` around inputs and loop bodies where the
  harness needs to prevent constant-folding away the measured work.
- The `calls` count is reduced for heavier 1k-loop and builder scenarios by the benchmark harness,
  so `ns/call` is the most comparable per-scenario column.
- `alias_snapshot_update`, `fixed_collection_update`, and `fixed_collection_spread_update` are
  deliberately adversarial value-reuse cases. `fixed_collection_update` now projects both the
  updated result slots and the pure tabulated source slots that are actually read later, and
  `fixed_collection_spread_update` projects spread source literals through the same used-index
  analysis.
- `compact_filter_collect` is intentionally left unspecialized here; it still shows the generic
  iterator pipeline cost.
- `mat4_full` shares repeated SIMD dot-product bodies through a generated private helper in release
  mode and avoids packing fully literal lane arrays only to extract them back to scalar ABI slots.
- `collision_aabb_64`, `path_grid_score_16`, and `cpu_raycaster_64` are common systems-style kernels
  that stress flat products, nested conditionals, integer division/modulo, scalar loop lowering, and
  branchy grid traversal.
- `fannkuch_redux_7` is adapted from the Computer Language Benchmarks Game benchmark description and
  uses fixed arrays, dynamic indexing, and repeated public `InlineArray.update`/`set` paths. The
  current lowering uses packed bounded arrays for the dynamic reverse/rotate/count paths and fuses
  the private product-state search step in release mode. Its current kernel size is about 0.99x the
  Rust/Wasm size reference; the remaining release pressure is mostly product-result materialization
  and stable internal-loop timing.
