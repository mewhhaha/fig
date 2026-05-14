# Benchmarks

These numbers compare Fig compiled to Wasm against equivalent Rust kernels. They are machine-local
measurements from the current working tree and should be used mainly for regression tracking.

Fig is compiled with `optMode: "release"` and `memoryModel: "branch"`. The benchmark harness only
reports the internal-loop shape: Deno instantiates the Fig Wasm module and calls exported
`bench(iterations)` once, while the measured loop runs inside Wasm. The comparison table is limited
to Fig internal-loop rows and native Rust rows.

## Environment

- Date: 2026-05-14
- OS: Linux 7.0.5-1-cachyos x86_64
- Deno: 2.7.14, V8 14.7.173.20-rusty, TypeScript 5.9.2
- Rust: rustc 1.96.0-nightly (3645249d7 2026-03-16)

## Command

```bash
deno run --allow-read --allow-write --allow-run scripts/bench_memory_model_compare.ts 100000
```

Current status: the release-gated command above completes. The suite includes branchy scalar
systems-style kernels such as collision checks, path-grid scoring, and a small CPU grid raycaster.
The latest saved run has 13 of 17 rows at or under 1.2x native Rust; the remaining over-target rows
are `collision_aabb_64`, `cpu_raycaster_64`, `range_fold_1k`, and `fannkuch_redux_7`.

The Rust comparison is compiled by the benchmark harness with:

```bash
rustc -C opt-level=3 -C target-cpu=native
```

## Results

Timed rows from the latest run:

| Scenario                         |  Calls | Fig internal ns/call | Rust ns/call | Ratio |    Checksum |
| -------------------------------- | -----: | -------------------: | -----------: | ----: | ----------: |
| `scalar_reuse_nway`              | 100000 |                  0.8 |          0.8 |  1.00 | -1471036480 |
| `product_shadow_update`          | 100000 |                  0.7 |          2.3 |  0.30 |  1413565408 |
| `tail_product_loop_1k`           |   5000 |                309.4 |        430.4 |  0.72 | -1792467296 |
| `inline_array_builder_map`       |  25000 |                  0.8 |         18.3 |  0.04 |      475000 |
| `compact_filter_collect`         |  50000 |                 15.0 |         12.8 |  1.17 |      100000 |
| `alias_snapshot_update`          | 100000 |                  4.1 |         10.1 |  0.41 |  1418165408 |
| `fixed_collection_update`        |  25000 |                  0.8 |          3.2 |  0.25 |      875000 |
| `fixed_collection_spread_update` |  25000 |                  0.8 |          2.3 |  0.35 |      875000 |
| `collision_aabb_64`              |  12500 |                100.8 |         60.6 |  1.66 |      112500 |
| `path_grid_score_16`             |  12500 |                195.1 |        169.3 |  1.15 |    38250000 |
| `cpu_raycaster_64`               |  12500 |                279.8 |        225.0 |  1.24 |    72124247 |
| `range_fold_1k`                  |   5000 |                336.5 |        263.6 |  1.28 | -1797467296 |
| `monadic_do_id_chain`            | 100000 |                  0.9 |          1.4 |  0.64 |  1410665408 |
| `applicative_do_id_map`          | 100000 |                  0.9 |          1.2 |  0.75 |  1410765408 |
| `fannkuch_redux_7`               |    100 |             123520.5 |      97941.8 |  1.26 |     2281600 |
| `mat4_dot1`                      | 100000 |                  0.8 |          2.0 |  0.40 |     9000000 |
| `mat4_full`                      | 100000 |                 20.1 |         26.0 |  0.77 |   494400000 |

## Fannkuch Lowering Investigation

Run:

```bash
deno run -A scripts/analyze_fannkuch_lowering.ts
```

Current findings:

| Check                             | Result |
| --------------------------------- | -----: |
| WAT bytes                         |  24017 |
| Wasm bytes                        |   1184 |
| Wasm bytes without hints          |   1184 |
| Wasm code-section payload         |   1101 |
| Remaining `dec` calls             |      0 |
| Remaining `step_*` calls          |      0 |
| Remaining `flip_count_loop` calls |      0 |

The release path is already doing several important things correctly: `search` lowers to a loop,
`prepare`/`score`/`advance` do not survive as calls, `InlineArray.set`/`InlineArray.update` helpers
do not survive as calls, packed `u3` fixed arrays are used, and `fig_buffers` is absent.

The remaining perf pressure appears to be executable-code shape, not custom-section overhead. The
analyzer reports a 1101 byte code section inside the 1184 byte kernel module, and disabling branch
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

`fannkuch_redux_7` now has no remaining private helper calls inside `search`, and the kernel size is
about 0.99x Rust/Wasm. The hot WAT is close but still not fully optimal: `search` still materializes
intermediate products (`prepared`, `scored`, and `next`) and unpacks the packed count field at
branch exits instead of carrying the packed backing all the way into every tail-loop target/result
path. A prototype lexical product-field alias fold reduced size further but was backed out because
inlined tail-loop lowering mutates callee parameter locals; preserving correctness there needs alias
invalidation or destination-aware branch result lowering.

Recent local comparison reruns on this final tree produced `fannkuch_redux_7` internal timings of
`103679.3`, `108065.6`, `105224.6`, `108650.2`, `120498.2`, `103818.7`, `106591.3`, `192031.7`,
`118779.1`, `102704.3`, `131926.0`, `115562.5`, `114405.9`, `109495.8`, `123779.4`, `112639.3`,
`122702.9`, `105304.4`, `138790.7`, `116102.8`, `109109.7`, `116669.0`, `109179.6`, `134063.8`, and
`123520.5 ns/call`, against Rust timings of `107435.2`, `97123.5`, `99007.7`, `107722.6`,
`114291.5`, `96560.8`, `98842.2`, `105409.1`, `87820.7`, `84673.4`, `89164.0`, `112099.6`,
`89493.6`, `91065.3`, `90703.0`, `95209.4`, `96173.4`, `100131.4`, `86586.3`, `102757.3`, `86336.5`,
`98276.7`, `93203.3`, `105906.5`, and `97941.8 ns/call`. The latest saved full run above is about
`1.26x` Rust runtime, and the best historical Fig result remains faster than Rust.

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
