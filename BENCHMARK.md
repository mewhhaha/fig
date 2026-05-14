# Benchmarks

These numbers compare Fig compiled to Wasm against equivalent Rust kernels. They are machine-local
measurements from the current working tree and should be used mainly for regression tracking.

Fig is compiled with `optMode: "release"` and `memoryModel: "branch"`. The benchmark harness only
reports the internal-loop shape: Deno instantiates the Fig Wasm module and calls exported
`bench(iterations)` once, while the measured loop runs inside Wasm. The comparison table includes
Fig internal-loop rows and native Rust rows.

## Environment

- Date: 2026-05-14
- OS: Linux 7.0.5-1-cachyos x86_64
- Deno: 2.7.14, V8 14.7.173.20-rusty, TypeScript 5.9.2
- Rust: rustc 1.96.0-nightly (3645249d7 2026-03-16)

## Command

```bash
deno run --allow-read --allow-write --allow-run scripts/bench_memory_model_compare.ts 20000000
```

Current status: the release-gated command above completes. The suite includes branchy scalar
systems-style kernels such as collision checks, path-grid scoring, and a small CPU grid raycaster.
The latest saved 20M-iteration run has 16 of 17 rows at or under 1.2x native Rust. The remaining
over-target row is `fannkuch_redux_7`.

The Rust comparison is compiled by the benchmark harness with:

```bash
rustc -C opt-level=3 -C target-cpu=native
```

## Results

Timed rows from the latest run:

| Scenario                         | Calls | Fig ns/call | Rust ns/call | Fig/Rust | Fig compile total ms | Fig Wasm bytes | Checksum  |
| -------------------------------- | ----: | ----------: | -----------: | -------: | -------------------: | -------------: | --------: |
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
| WAT bytes                         |  22694 |
| Wasm bytes                        |   1138 |
| Wasm bytes without hints          |   1138 |
| Wasm code-section payload         |   1055 |
| Remaining `dec` calls             |      0 |
| Remaining `step_*` calls          |      0 |
| Remaining `flip_count_loop` calls |      0 |

The release path is already doing several important things correctly: `search` lowers to a loop,
`prepare`/`score`/`advance` do not survive as calls, `InlineArray.set`/`InlineArray.update` helpers
do not survive as calls, packed `u3` fixed arrays are used, and `fig_buffers` is absent.

The remaining perf pressure appears to be executable-code shape, not plugin dispatch overhead. The
analyzer reports a 1055 byte code-section payload inside the 1138 byte kernel module, with no
branch-hint custom section in this sample. Narrow unsigned scalars inline predictably, product-state helpers
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
but still not fully optimal: `search` still materializes
intermediate products (`prepared`, `scored`, and `next`) and unpacks the packed count field at
branch exits instead of carrying the packed backing all the way into every tail-loop target/result
path. A prototype lexical product-field alias fold reduced size further but was backed out because
inlined tail-loop lowering mutates callee parameter locals; preserving correctness there needs alias
invalidation or destination-aware branch result lowering.

Recent local comparison reruns on this final tree produced `fannkuch_redux_7` internal timings of
`103679.3`, `108065.6`, `105224.6`, `108650.2`, `120498.2`, `103818.7`, `106591.3`, `192031.7`,
`118779.1`, `102704.3`, `131926.0`, `115562.5`, `114405.9`, `109495.8`, `123779.4`, `112639.3`,
`122702.9`, `105304.4`, `138790.7`, `116102.8`, `109109.7`, `116669.0`, `109179.6`, `134063.8`,
`123520.5`, `117591.1`, `116034.2`, `115433.0`, `118172.1`, and `123184.8 ns/call`, against Rust timings of `107435.2`, `97123.5`, `99007.7`, `107722.6`,
`114291.5`, `96560.8`, `98842.2`, `105409.1`, `87820.7`, `84673.4`, `89164.0`, `112099.6`,
`89493.6`, `91065.3`, `90703.0`, `95209.4`, `96173.4`, `100131.4`, `86586.3`, `102757.3`, `86336.5`,
`98276.7`, `93203.3`, `105906.5`, `97941.8`, `94640.8`, `94971.9`, `90468.7`, `93377.0`, and `92675.7 ns/call`. The latest
saved full run above is about `1.22x` Rust runtime, and the best historical Fig result remains
faster than Rust.

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
