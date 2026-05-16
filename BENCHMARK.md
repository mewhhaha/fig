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
deno run --allow-read scripts/bench_const_params.ts --sizes=10,100,500,1000 --iterations=25
deno run --allow-read scripts/bench_const_params.ts --sizes=200 --iterations=3
deno run --allow-read scripts/bench_tail_recursion.ts
deno run --allow-read scripts/bench_matmul_simd.ts 100000
```

The memory-model benchmark completed and passed all size/shape gates. The run uses one shared
compile cache across scenarios for parsed/resolved source imports. Compile phase columns come from
one parsed/imported/checked program; backend lowering runs once, then WAT and Wasm are rendered and
encoded from the same lowered backend module. Selected rows:

| Scenario                   |  Calls |  ns/call | Parse ms | Import ms | Check ms | Backend ms | WAT ms | Wasm ms | Total ms | WAT bytes | Wasm bytes | Loops | Recursive calls | SIMD ops |
| -------------------------- | -----: | -------: | -------: | --------: | -------: | ---------: | -----: | ------: | -------: | --------: | ---------: | ----: | --------------: | -------: |
| `scalar_reuse_nway`        | 100000 |     34.8 |    3.032 |     0.573 |    8.290 |      6.807 |  0.245 |   0.451 |   19.397 |       151 |         44 |     0 |               0 |        0 |
| `tail_product_loop_1k`     |   5000 |    289.5 |    1.015 |     0.111 |    1.094 |      6.399 |  0.088 |   0.131 |    8.838 |      1269 |        109 |     1 |               0 |        0 |
| `inline_array_builder_map` |  25000 |     21.7 |    0.912 |    36.243 |    9.663 |     20.863 |  0.015 |   0.064 |   67.762 |       183 |         47 |     0 |               0 |        0 |
| `compact_filter_collect`   |  50000 |     49.5 |    0.756 |    77.669 |    6.833 |    112.505 |  0.594 |   0.738 |  199.095 |     22856 |       1731 |     2 |               0 |        0 |
| `fixed_collection_update`  |  25000 |     14.1 |    0.393 |     5.537 |    2.412 |      5.429 |  0.013 |   0.029 |   13.812 |        91 |         38 |     0 |               0 |        0 |
| `path_grid_score_16`       |  12500 |    181.4 |    0.361 |     0.051 |    0.313 |      2.146 |  0.034 |   0.077 |    2.982 |      1227 |        113 |     1 |               0 |        0 |
| `range_fold_1k`            |   5000 |    257.8 |    0.239 |     1.752 |    0.868 |      4.694 |  0.026 |   0.041 |    7.619 |      1265 |        116 |     1 |               0 |        0 |
| `fannkuch_redux_7`         |    100 | 106803.1 |    4.226 |     5.140 |    3.306 |     27.140 |  0.231 |   0.349 |   40.391 |     21989 |       1146 |     5 |               0 |        0 |
| `mat4_dot1`                | 100000 |     14.2 |    0.925 |     0.088 |    0.426 |      1.910 |  0.021 |   0.121 |    3.491 |       853 |        145 |     0 |               0 |       14 |
| `mat4_full`                | 100000 |     86.1 |    1.956 |     0.170 |    0.711 |     12.157 |  0.126 |   0.109 |   15.229 |      3814 |        426 |     0 |               0 |       38 |

The same memory-model benchmark also passed all gates with `--profile=release_fast_compile`.
Selected compile-time comparison against the balanced release profile:

| Scenario                   | Balanced Backend ms | Balanced Total ms | Fast Backend ms | Fast Total ms | Fast WAT bytes | Fast Wasm bytes |
| -------------------------- | ------------------: | ----------------: | --------------: | ------------: | -------------: | --------------: |
| `compact_filter_collect`   |             112.505 |           199.095 |          85.010 |       171.393 |          22856 |            1731 |
| `fixed_collection_update`  |               5.429 |            13.812 |           3.972 |        12.378 |             91 |              38 |
| `fannkuch_redux_7`         |              27.140 |            40.391 |          24.465 |        38.259 |          21989 |            1146 |
| `mat4_full`                |              12.157 |            15.229 |           6.795 |        10.642 |           3814 |             426 |

Focused compile-time scaling from:

```bash
deno run --allow-read scripts/bench_const_params.ts --sizes=10,100,200,500,1000 --iterations=3
```

| Calls | Direct avg ms | Runtime-dict avg ms | Const-param avg ms | Slowest traced check phase at const-param | Const-param specialization summary                                                             |
| ----: | ------------: | ------------------: | -----------------: | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
|    10 |         2.166 |               1.695 |              1.480 | `checkFn loop:0.101ms`                    | `inferred #1 v1/g0/h0/m0; const #1 v0/g0/h0/m0; inferred #2 v1/g0/h0/m0; const #2 v0/g0/h0/m0` |
|   100 |        17.236 |              22.625 |             24.581 | `checkFn loop:1.380ms`                    | `inferred #1 v1/g0/h0/m0; const #1 v0/g0/h0/m0; inferred #2 v1/g0/h0/m0; const #2 v0/g0/h0/m0` |
|   200 |        50.665 |              76.411 |             78.425 | `checkFn loop:4.192ms`                    | `inferred #1 v1/g0/h0/m0; const #1 v0/g0/h0/m0; inferred #2 v1/g0/h0/m0; const #2 v0/g0/h0/m0` |
|   500 |       285.776 |             439.795 |            435.986 | `checkFn loop:17.992ms`                   | `inferred #1 v1/g0/h0/m0; const #1 v0/g0/h0/m0; inferred #2 v1/g0/h0/m0; const #2 v0/g0/h0/m0` |
|  1000 |      1081.818 |            1690.625 |           1694.981 | `checkFn loop:66.324ms`                   | `inferred #1 v1/g0/h0/m0; const #1 v0/g0/h0/m0; inferred #2 v1/g0/h0/m0; const #2 v0/g0/h0/m0` |

The repeated-call benchmark now completes through 1000 calls without timeout. Doubling 100 to 200 is
well below the old ~7x cliff, and the checker trace shows the remaining wall time is not dominated
by specialization. The generated specialization count stays stable in the traced benchmark, and the
focused regression test covers the 100 repeated const-param call shape with one generated wrapper,
one specialization cache miss, and cache hits growing with repeated calls.

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

Current status: the release-gated command above did not complete on the 2026-05-15 local rerun. It
stopped before timing rows because `compact_filter_collect` exceeded the comparison harness WAT-size
gate: expected `<= 30000B`, got `120331B`. The saved 2026-05-14 20M-iteration comparison remains
below for historical tracking; that run had 16 of 17 rows at or under 1.2x native Rust. The
remaining over-target row was `fannkuch_redux_7`.

The Rust comparison is compiled by the benchmark harness with:

```bash
rustc -C opt-level=3 -C target-cpu=native
```

## Saved Rust Comparison Results

Timed rows from the saved 2026-05-14 run:

| Scenario                         |    Calls | Fig ns/call | Rust ns/call | Fig/Rust | Fig compile total ms | Fig Wasm bytes |    Checksum |
| -------------------------------- | -------: | ----------: | -----------: | -------: | -------------------: | -------------: | ----------: |
| `scalar_reuse_nway`              | 20000000 |         0.8 |          0.7 |     1.14 |               25.105 |            103 | -1323389440 |
| `product_shadow_update`          | 20000000 |         0.8 |          1.9 |     0.42 |               11.233 |            103 |  1805788928 |
| `tail_product_loop_1k`           |  1000000 |       257.6 |        397.5 |     0.65 |               12.533 |            191 | -2011173632 |
| `inline_array_builder_map`       |  5000000 |         0.8 |         19.2 |     0.04 |              201.836 |            100 |    95000000 |
| `compact_filter_collect`         | 10000000 |         2.4 |         14.2 |     0.17 |              936.584 |            582 |    20000000 |
| `alias_snapshot_update`          | 20000000 |         2.5 |          9.3 |     0.27 |               12.057 |            149 | -1569178368 |
| `fixed_collection_update`        |  5000000 |         1.1 |          2.9 |     0.38 |              159.733 |            100 |   175000000 |
| `fixed_collection_spread_update` |  5000000 |         0.2 |          2.1 |     0.10 |              148.650 |            100 |   175000000 |
| `collision_aabb_64`              |  2500000 |        59.6 |         57.4 |     1.04 |               11.417 |            249 |    22500000 |
| `path_grid_score_16`             |  2500000 |       176.7 |        154.5 |     1.14 |                7.642 |            180 |  -939934592 |
| `cpu_raycaster_64`               |  2500000 |       256.5 |        225.1 |     1.14 |               17.139 |            469 |  1539681120 |
| `range_fold_1k`                  |  1000000 |       228.2 |        249.0 |     0.92 |              908.774 |            169 |  1283793664 |
| `monadic_do_id_chain`            | 20000000 |         0.8 |          1.1 |     0.73 |               10.558 |            113 |  1225788928 |
| `applicative_do_id_map`          | 20000000 |         0.8 |          0.9 |     0.89 |                5.539 |            110 |  1245788928 |
| `fannkuch_redux_7`               |    20000 |    116748.1 |      95371.5 |     1.22 |              235.892 |           1210 |   456320000 |
| `mat4_dot1`                      | 20000000 |         0.7 |          2.2 |     0.32 |                5.738 |            102 |  1800000000 |
| `mat4_full`                      | 20000000 |        13.6 |         25.9 |     0.53 |               37.160 |            899 |    95752192 |

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
