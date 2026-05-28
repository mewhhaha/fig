# Compile Performance Progress

This note tracks compile-time optimization passes while the compiler is still implemented in
JavaScript/TypeScript. Keep it current when a pass changes the benchmark shape or when repeated
passes stop moving the numbers. Its purpose is to make it obvious when an optimization family is
still paying for itself and when we should stop digging in that area.

## Operating Rule

Use this file as the progress ledger for the compile-time goal. Every optimization attempt should
leave one of three outcomes here:

- `Keep`: the same benchmark improves `session_leaf_semantic_edit` by at least 5%, or the pass
  removes a traced blocker needed for a larger structural change.
- `Stop`: the pass regresses, stays inside benchmark noise, or only improves a local subphase while
  wall-clock time does not move.
- `Stop for now`: the pass is directionally useful but not enough to keep pursuing without new trace
  evidence.

If two consecutive measured kept passes are below the 5% threshold, stop local tuning and switch to
a larger design change. If two consecutive stopped attempts target the same phase, stop working in
that phase until a new trace shows a different bottleneck.

## Current Checkpoint

- Current best observed Fig semantic dependency edit: `~64-65 ms` in repeated focused 15-sample runs
  after skipping the redundant import metadata-hide pass; the latest same-machine Fig-vs-Go recheck
  measured Fig at `67.895 ms` in a 10-sample run.
- Current latest isolated Fig semantic dependency edit after skipping redundant import metadata,
  caching module reference keys by source, and skipping already-validated branch-hint declarations:
  `~58-64 ms` with import `~10 ms`, check `~19-21 ms`, backend `~23-24 ms`, and Wasm encode
  `~6 ms`.
- Latest focused semantic dependency edit after backend profiling coverage: `65.187 ms`, with an
  earlier noisy run at `73.945 ms`; treat this as still inside the current plateau.
- Treat the type-contract validation cache as useful but noisy until it repeatedly revalidates below
  the `~112-122 ms` band.
- The earlier `~107-108 ms` builtin-operator run is discarded as a valid current benchmark because
  it depended on an unsafe custom-operator early return that skipped binary operator lowering.
- Current best Go dependency semantic edit on the same temporary project: `~65 ms` in a focused
  5-sample run after a warm no-op build; latest same-machine recheck measured Go semantic edits at
  `66.218 ms` and Go warm no-op builds at `17.452 ms`.
- Active optimization mode: keep trying JavaScript/compiler-architecture improvements, but only when
  they are structural enough to plausibly move wall time by at least 5%.
- Current local-tuning status: import pruning got one structural win because the cache is keyed by
  stable source id, module interface, module reference graph, and roots, then rehydrates from the
  current declaration bodies. Do not follow it with another narrower prune helper cache.
- Stability recheck on 2026-05-28: the focused 15-sample no-stats run measured `61.122 ms` early
  in the turn, then repeated later at `85.016 ms` and `84.811 ms` without a compiler source change.
  A same-run 5-sample Fig-vs-Go comparison also shifted both runtimes upward: Fig semantic edit
  `94.648 ms`, Go semantic edit `81.931 ms`, Go warm no-op `25.163 ms`. Treat the latest absolute
  values as environment-sensitive; use the phase split and repeated same-run comparisons before
  claiming another gain.
- Session no-op status: root trailing-trivia edits now reuse the parsed root and cached artifact,
  measuring `0.494 ms` in a focused 25-sample run. Imported trailing-trivia edits remain under
  `~1 ms`. This closes the previous no-op comparison concern; the remaining useful comparison is
  semantic dependency edits and broader structural reuse.
- Stable evaluation checkpoint on 2026-05-28: local helper/cache attempts have plateaued. The
  current linked-module cache is intentionally keyed by full source text and dependency source
  text, so it avoids stale bodies by missing on dependency body edits. Reusing linked modules across
  body-only dependency edits now requires a structural rehydration design, not another micro-cache.
- Fresh stabilization run on 2026-05-28 after removing an unfinished stable-linked-cache branch:
  focused semantic dependency edit measured `121.862 ms` without cache telemetry and `139.305 ms`
  with `--cache-stats`. A same-run 5-sample comparison measured Fig semantic edit `132.687 ms`, Go
  semantic edit `119.575 ms`, and Go warm no-op `37.900 ms`. Treat these as the current evaluation
  sample, not a claimed regression root; the environment and harness have already shown large
  absolute-value jitter, and the important decision remains unchanged: stop micro-caches and move
  only with a structural artifact boundary.
- Backend planning artifact reuse on 2026-05-28 caches layout-relevant planning by function body
  shape while ignoring literal values. It reuses return-projection, closure-descriptor, and
  fixed-array plans for literal-only semantic edits, with a regression test proving stale output is
  avoided and structural body edits miss. Focused repeated runs measured `69.982 ms` and cache-stats
  `70.536 ms`; a same-run 5-sample Fig-vs-Go comparison measured Fig semantic edit `61.678 ms`, Go
  semantic edit `76.678 ms`, and Go warm no-op `22.165 ms`.
- Stable linked-module rehydration was attempted and stopped on 2026-05-28. It rehydrated current
  dependency bodies correctly in a focused test, but the large benchmark regressed to `266.493 ms`
  without stats and `281.876 ms` with `--cache-stats`; trace showed `import.merge.module` and
  `import.qualify.imports` dominating. The code was backed out.
- Current stable revalidation after that backout: focused semantic dependency edit `65.234 ms`
  without stats and `65.182 ms` with `--cache-stats`. Treat this as the stable evaluation point:
  import is about `13 ms`, check about `26-27 ms`, backend about `16-19 ms`, and Wasm encode about
  `7 ms`.
- Benchmark harness correction on 2026-05-28: the temporary large benchmark now generates each run
  under a fresh `/tmp/fig-large-compile-*` directory, disables Go VCS stamping with
  `-buildvcs=false`, and uses measured edit indices after the warmup range. This prevents parallel
  benchmark processes from corrupting the shared generated project and avoids measuring exact
  warmup edit reuses as samples.
- Corrected-harness checkpoint: focused Fig semantic dependency edit measured `60.094 ms` without
  stats and `56.592 ms` with `--cache-stats`; trace mode measured `61.892 ms`. A same-run
  Fig-vs-Go comparison measured Fig semantic edit `63.911 ms`, Go warm no-op `16.994 ms`, and Go
  semantic dependency edit `341.895 ms`. Treat older Go semantic-edit numbers from the persistent
  in-repo `.gocache` harness as contaminated by cross-run cache reuse.
- Durable harness checkpoint: `tmp/large_compile_bench/README.md`, `generate.ts`, and `run.ts` are
  now tracked while generated projects/caches remain ignored. A fresh focused run measured Fig
  semantic dependency edit `62.387 ms`; a same-run 5-sample comparison measured Fig semantic edit
  `69.526 ms`, Go warm no-op `17.082 ms`, and Go semantic edit `357.510 ms`.
- Maintenance checkpoint: `deno task bench:large-compile` now runs the durable large compile
  harness, and `deno task check` typechecks the tracked harness source. Large-session no-op checks
  measured root edit `0.968 ms` and leaf comment edit `0.502 ms`; semantic leaf edit in the same
  run measured `57.203 ms`. The task form
  `deno task bench:large-compile -- --mode=session_leaf_semantic_edit --samples 7 --warmup 3`
  measured `60.223 ms`.
- Stable speed checkpoint: caching the whole-program `do`-expression preflight by declaration and
  expression identity is a kept checker gain. Focused 15-sample runs measured `55.946 ms` before a
  scanner cleanup, then `54.168 ms` without stats and `54.617 ms` with `--cache-stats`. The latest
  split is import `~10.9 ms`, check `~20.8 ms`, backend `~14.9 ms`, and Wasm encode `~6.6 ms`.
- Contract checker checkpoint: the syntax-only rewrite misuse scan now caches diagnostics per
  unchanged declaration, while semantic contract declarations are still checked against the current
  program. Focused 15-sample runs measured `49.899 ms` without stats, `49.027 ms` with
  `--cache-stats`, and `48.327 ms` with trace enabled. Traced `check.checkContracts` fell from
  `40.744 ms` total over 15 samples to `4.287 ms`.
- Latest same-run Go comparison after the contract checker gain: Fig semantic dependency edit
  `52.671 ms`, Go warm no-op `15.346 ms`, and Go semantic dependency edit `328.162 ms` over
  7 samples / 3 warmups. The Fig isolated 15-sample run remains the stability reference for local
  keep/stop decisions.
- Checker hit-path extension stopped: caching type-function casing diagnostics, caching
  type-contract declaration keys, lazy-building type-contract maps, and shallow-restoring cached
  function declarations lowered some checker subphase samples but did not clear the `~47 ms` keep
  bar. Focused runs measured `48.525 ms`, `48.093 ms`, and `48.491 ms`; the changes were backed
  out. Post-backout revalidation measured `50.015 ms`, inside the current `~48-50 ms` plateau.
- Selected linked-module materialization stopped: cloning only cached pruned-selection declarations
  before import pruning increased the selection hit counter but did not move wall time. Focused
  runs measured `49.341 ms` without stats and `50.275 ms` with `--cache-stats`, so the code was
  backed out.
- Temporary import closure split trace showed why another local import closure cache is unlikely to
  clear the gate: over 15 traced samples, closure support declaration assembly measured
  `21.823 ms` total and local declaration assembly measured `19.151 ms` total, about `2.7 ms`
  together per rebuild under trace overhead. The trace-only instrumentation was backed out to avoid
  adding normal-path wrapper overhead.
- Stable-state checkpoint on 2026-05-28: after backing out the stopped import/check experiments and
  making no further compiler changes, a focused 15-sample semantic dependency edit measured
  `58.009 ms` without cache telemetry and `50.188 ms` with `--cache-stats`. The cache-stats run
  split as import `10.569 ms`, check `17.535 ms`, backend `13.810 ms`, backend layout `3.303 ms`,
  backend lower `5.041 ms`, backend cleanup `4.154 ms`, and Wasm encode `6.193 ms`. This is the
  current stable place to continue from: correctness is green, helper-level caches are saturated,
  and another pass should only start from a structural artifact boundary.
- Product-constructor declaration transform caching was attempted and stopped on 2026-05-28. The
  targeted cache was correct in a focused semantic-import-edit test, but the focused large
  benchmark measured `102.519 ms` without telemetry and `102.386 ms` with `--cache-stats`, so the
  code was backed out. A post-backout recheck stayed around `99.876 ms` with trace at `112.674 ms`,
  which points to environment jitter in that run family; do not use those absolute numbers as a new
  plateau, but do treat the transform cache as below the keep bar.
- Benchmark telemetry now reports Wasm function-cache hits separately from debug name-section hits.
  A 7-sample semantic dependency edit measured `wasm_fn_hits=2282` and `wasm_fn_misses=2`, matching
  backend function reuse. This confirms the remaining Wasm encode time is mostly module assembly and
  byte copying, not missed function-body encoding; do not spend another pass on encoded-function
  cache plumbing unless these counters regress.
- Pruning cannot be disabled to simplify linked-module reuse. A 15-sample semantic dependency edit
  with `--no-prune` measured `551.790 ms`: import fell slightly to `11.644 ms`, but check exploded
  to `510.458 ms`. The matching pruned run measured `55.961 ms` with check at `20.894 ms`. Any
  body-stable linked-module design must preserve the pruned import surface rather than compiling the
  full transitive module graph.
- Linked-module key telemetry now tracks a body-stable candidate key based on the current module
  full source plus each dependency's source id, interface key, and reference key. A focused
  7-sample semantic dependency edit measured current linked modules at `1 / 10` hits/misses while
  the body-stable candidate measured `10 / 1`. A targeted compiler test proves the candidate key
  survives a dependency body-value edit while the generated Wasm still returns the edited value.
  This does not enable reuse yet; it proves the next implementation should solve current-body
  rehydration for an otherwise-high-hit linked key.
- Narrow stable linked-module rehydration was attempted and stopped on 2026-05-28. A guarded
  alias-only rehydration path initially exposed a correctness bug with transitive support type names;
  after correcting it to match existing local-name qualification, it compiled but regressed the
  focused semantic dependency edit to `92.769 ms`, with import at `40.891 ms`. The executable reuse
  path was backed out, leaving only the telemetry. Post-backout revalidation measured `60.709 ms`
  with import `11.624 ms`.
- Direct code-section body assembly was attempted and stopped on 2026-05-28. Replacing the final
  `encodedFunctions.map((fn) => fn.bytes)` allocation with a direct section writer passed
  `deno check src/backend.ts` and the Wasm encoder cache regression test, but focused
  `session_leaf_semantic_edit` measured `56.443 ms` without telemetry and `55.816 ms` with
  `--cache-stats`. Wasm encode moved only to `5.473-5.872 ms`, while wall time stayed inside the
  established plateau, so the code was backed out.
- Checked-program candidate telemetry was added on 2026-05-28 as opt-in cache instrumentation. A
  focused stale-output test proves a dependency body edit can change generated Wasm while the
  merged-program candidate key still hits. The large benchmark measured `checked_program_hits=1`
  and `checked_program_misses=0` per semantic dependency edit, alongside the existing
  `stable_linked_hits=10` / `stable_linked_misses=1`. Normal runs leave this counter disabled, so
  it is evidence for the next artifact boundary rather than a claimed speedup.
- Checked-program direct reuse was audited and deferred on 2026-05-28. Reusing the whole checked AST
  would stale function bodies, and skipping `checkTypeFunctionCasing` by the body-stable key is not
  safe because that phase validates local function-body annotations. The only clearly safe
  signature-only checks in the current flow are `checkPrimitiveDecls` and
  `checkDotQualifiedTypeMemberSyntax`; a 7-sample trace measured them at roughly `0.35-0.4 ms` per
  rebuild combined, which is below the threshold for a standalone cache. The next checked-program
  pass needs a real split between reusable signature/type setup and body-sensitive validation.
- Function-check environment-key caching was measured and rejected on 2026-05-28. Trace-only
  counters now split the `checkFn loop` enough to show the body-stable environment key costs about
  `0.099 ms` per semantic rebuild over 7 samples, while the full function-check loop remains around
  `2.98 ms`. This is below the threshold for another cache-key layer; the remaining cost is cache-hit
  restoration and loop overhead around thousands of functions.
- Alias import assembly split trace was measured and stopped on 2026-05-28. A temporary guarded
  split inside `import.qualify.imports` showed the miss path spread over support declaration
  assembly (`10.561 ms` total over 7 traced samples), local declaration qualification (`8.043 ms`),
  split/name collection (`6.613 ms`), alias-root scanning (`10.259 ms`), and prune selection
  (`3.624 ms`). `import.qualify.names` and materialization were negligible. The split
  instrumentation was backed out after non-trace runs measured `69.247 ms` and `68.596 ms`, because
  the evidence points to a coarser alias-import artifact boundary rather than more trace hooks or
  helper caches.
- Stable alias-import closure key telemetry was added on 2026-05-28 as opt-in cache
  instrumentation. The key is based on the imported module's source id, interface key, reference
  key, stable dependency keys, import pruning mode, alias, and root set, so it survives body-only
  dependency edits without treating current declaration bodies as reusable. A focused cache-stats
  run measured `stable_closure_hits=29` and `stable_closure_misses=0`, while the existing
  full-source closure cache still measured `closure_hits=13` and `closure_misses=19`. A targeted
  compiler test proves the candidate hits across a dependency body edit while generated Wasm still
  returns the edited value. The next import implementation should use this as a metadata/selection
  artifact key and rehydrate current local declaration bodies through the existing qualified
  declaration caches, not reuse full qualified closures directly.
- Stable alias-import closure plan reuse was attempted and stopped on 2026-05-28. The implementation
  cached selected/local/support/public name metadata under the stable closure key and rehydrated
  current declaration bodies, proving `stable_closure_plan_hits=27` and `misses=0`. It did not move
  wall time: focused runs measured `65.155 ms` before a root-source-key tweak, then `70.672 ms`
  after, with import still around `12-13 ms`; trace still showed `import.qualify.imports` and
  `import.merge.module` around `47 ms` total over 7 samples, plus alias-root scanning around
  `11 ms`. The executable reuse code and root-source-key tweak were backed out. Keep the stable key
  telemetry, but do not add another plan that only avoids prune selection while still walking and
  qualifying current declarations.
- Stable alias-root keying was attempted and stopped on 2026-05-28. The prototype passed the stable
  import surface key as the imported-name side of the alias-root cache key and gave root merges a
  source key so local declaration hashing could be skipped. It passed focused body-stable cache
  tests, but focused runs measured `65.261 ms` without stats and `72.870 ms` with cache stats, so it
  did not clear the wall-time gate. The code was backed out. Alias-root caching alone is not enough
  unless the implementation also avoids the later current-declaration qualification work.
- Checker declaration-scan cleanup was attempted and stopped on 2026-05-28. The prototype replaced
  repeated `program.declarations.filter(...)` calls in `checkProgram` with explicit loop helpers,
  reused const declaration buckets, and iterated the final function-check loop over the current
  function list. It passed focused body-stable tests, but focused runs measured `64.897 ms` without
  stats and `75.290 ms` with cache stats, so it stayed inside the plateau and was backed out. Do
  not spend another pass on declaration bucketing unless a trace shows the scans themselves as a
  dominant event.
- Backend cleanup called-function caching was revalidated and stopped on 2026-05-28. The prototype
  cached lowered-instruction call lists and reused source-body call sets for branch/heap memory
  checks. It measured `60.756 ms` in a focused 15-sample run, while the trace/cache-stats run
  measured `67.949 ms`; cleanup split to `remove_unreachable` `7.665 ms`,
  `needs_branch_memory` `3.612 ms`, and `needs_heap_memory` `2.694 ms` total over 7 traced samples.
  After removing the lowered-instruction call-list cache, the focused run measured `56.045 ms`.
  Keep the cleanup trace split for evidence, but do not keep or repeat the instruction-body cache.
- Backend unreachable direct traversal was kept on 2026-05-28. Instead of allocating a callee-name
  array for every reachable backend body, `removeUnreachableBackendFunctions` now visits nested call
  instructions directly. Focused 15-sample semantic dependency edits measured `44.367 ms` and
  `45.685 ms`, clearing the `~47-48 ms` keep bar. Trace/cache-stats measured `55.391 ms` with
  `backend.cleanup.remove_unreachable` at `14.517 ms` total over 7 traced samples, down from
  `19.680 ms` in the previous trace. This is a kept algorithmic allocation reduction, not another
  identity cache.
- Latest same-run Fig-vs-Go comparison after this cleanup backout measured Fig semantic edit
  `68.844 ms`, Go warm no-op `20.277 ms`, and Go semantic dependency edit `390.564 ms` over
  10 samples / 3 warmups. Treat this as another jitter checkpoint, not a regression root: the
  isolated focused run immediately before it was `56.045 ms`.
- Latest same-run Fig-vs-Go comparison after the direct traversal measured Fig semantic edit
  `47.153 ms`, Go warm no-op `16.197 ms`, and Go semantic dependency edit `309.470 ms` over
  10 samples / 3 warmups. The remaining Go advantage in this harness is warm no-op and process/build
  overhead; Fig semantic dependency edits are well below Go's measured rebuild path.
- Next candidate: interface-stable checked/imported module artifact reuse, or backend/layout bundle
  reuse. The remaining time is split across import relinking, check setup, and backend setup; no
  single phase is much larger than the others.

## Gain Ledger

Use this section as the quick stop/go checkpoint before starting another compile-time pass.

- Current measured plateau: `~44-47 ms` for `session_leaf_semantic_edit` after direct backend
  unreachable traversal. Repeated focused 15-sample runs measured `44.367 ms` and `45.685 ms`;
  same-run Fig-vs-Go measured Fig at `47.153 ms`.
- Keep threshold from this plateau: a repeated focused run should land at or below `~42-43 ms`
  before a local optimization counts as a real gain.
- Current Go comparison target: latest corrected stable same-run semantic edit measured Fig
  `52.671 ms` and Go `328.162 ms`; the latest same-run recheck measured Fig `47.153 ms`,
  Go semantic edit `309.470 ms`, and Go warm no-op `16.197 ms`.
- Current gap to Go: semantic dependency edits are effectively tied in the current temporary
  harness; the remaining obvious gap is Go's build no-op path, while Fig compiler sessions already
  handle comment/trivia no-ops in under `~2 ms`.
- Latest kept structural gain: source-id pruned-selection reuse, from the `~79-80 ms` band to
  `~72-73 ms`.
- Latest kept local gain: parsed annotation type caching, from the `~72-73 ms` band to `~66-68 ms`.
- Latest stopped local attempt: annotation type-call list caching, which measured `66.981 ms` and
  did not improve check time beyond the parsed annotation cache.
- Latest stopped backend attempt: closure descriptor direct-call cache plumbing, which lowered
  backend layout once but regressed wall time to `67.553 ms`.
- Latest stopped import attempt: linked materialization no-clone, which measured `62.633 ms` once
  but repeated at `64.377 ms`, so it stayed inside the current plateau and was backed out.
- Latest comparison checkpoint: Fig semantic edit `67.895 ms`, Go semantic edit `66.218 ms`, and
  Go warm no-op `17.452 ms` in a 10-sample / 3-warmup same-machine run.
- Latest stability checkpoint: focused no-stats reruns measured `61.122 ms`, then `85.016 ms` and
  `84.811 ms`; the same later run family measured Go semantic edit at `81.931 ms` and Go warm
  no-op at `25.163 ms`. This is evidence that the current harness has environment jitter large
  enough to reject single-run claims near the plateau.
- Latest kept no-op gain: parsed-root reuse for trailing-trivia-equivalent root edits, moving
  `session_root_edit` from `1.704 ms` to `0.494 ms` with all downstream phase timings at zero.
- Latest kept backend gain: direct backend unreachable traversal, replacing per-body callee-list
  allocation with immediate nested call visitation. Focused semantic dependency edits moved to
  `44.367 ms` and `45.685 ms`.
- Latest stopped local attempts: backend cleanup called-function caching and type-casing declaration
  caching. Both produced plausible subphase hits but failed the repeated wall-time gate; the cleanup
  instruction-call cache was removed after a `56.045 ms` post-backout focused run. Do not continue
  declaration/body identity caches for semantic dependency edits.
- Latest stopped import micro-cache: imported declaration identity-key caching lowered import in
  repeated runs but failed the wall-time gate, so it was backed out. This reinforces that import
  work needs linked/import-closure rehydration, not another per-declaration helper cache.
- Latest structural decision: defer body-stable linked-module reuse until it can rehydrate current
  dependency bodies from stable interface/reference keys. The existing full-source linked key is the
  safe baseline and should not be weakened without a stale-output regression test.
- Latest stabilization benchmark: focused semantic dependency edit `121.862 ms` without cache stats;
  same-run Fig-vs-Go comparison `132.687 ms` Fig, `119.575 ms` Go semantic edit, `37.900 ms` Go
  warm no-op. Use this as the current baseline until repeated runs prove a lower stable band again.
- Latest kept structural backend gain: layout-planning artifact reuse moved backend layout from the
  current `~17 ms` band to `~4-5 ms`, with focused semantic dependency edits measuring `69.982 ms`
  and same-run Fig-vs-Go measuring Fig `61.678 ms` versus Go `76.678 ms`.
- Latest stopped structural import attempt: stable linked-module rehydration across dependency
  body-only edits. It was correct in a targeted test but regressed the focused benchmark to
  `266-282 ms`, with import merge/qualification dominating, so it was backed out.
- Latest stable checkpoint: focused semantic dependency edit `65.234 ms`; cache-stats repeat
  `65.182 ms`.
- Latest harness correction: generated projects, Go caches, and outputs are now per-run temp
  directories, and measured samples no longer reuse warmup edit indices. Corrected same-run
  comparison measured Fig semantic edit `63.911 ms` and Go semantic edit `341.895 ms`.
- Latest durable checkpoint: tracked large benchmark focused Fig semantic edit `62.387 ms`; same-run
  comparison Fig semantic edit `69.526 ms`, Go semantic edit `357.510 ms`, Go warm no-op
  `17.082 ms`.
- Latest kept support gain: skipping redundant metadata hiding after import parse/patch, which moved
  import from `~16-17 ms` to `~14-15 ms` and wall time to `~64-65 ms`.
- Latest kept import support gain: full-source module reference-key caching, which moved import to
  `~10-11 ms` but did not reset the wall-time plateau.
- Latest kept checker gain: branch-hint validation skips unchanged declarations by identity under
  the default plugin registry, moving focused semantic edits to `58.608 ms` and `60.442 ms` in
  repeated no-stats runs.
- Latest kept checker preflight gain: `do`-expression presence is cached by object identity for the
  predicate-specific scanner, moving repeated focused semantic edits to `54.168-54.617 ms`.
- Latest kept checker contract gain: rewrite misuse diagnostics are cached per unchanged
  declaration, moving focused semantic edits to `49.027-49.899 ms` and reducing traced contract
  checking to `0.286 ms` per rebuild.
- Latest stopped checker hit-path attempt: type-function casing caches, type-contract key/map
  hit-path cleanup, and shallower function-cache restores measured `48.093-48.525 ms` and did not
  beat the `~47 ms` keep bar, so the code was backed out.
- Latest stopped import structural attempt: selected linked-module materialization used cached
  pruned-selection names before cloning, but measured `49.341-50.275 ms` and stayed inside the
  plateau.
- Latest stable-state recheck: focused semantic dependency edit measured `58.009 ms` without
  telemetry and `50.188 ms` with `--cache-stats`; `deno task check` and `deno task test` passed.
  Use this worktree as the baseline for the next structural pass.
- Latest stopped checker transform attempt: product-constructor lowering by declaration identity was
  correct in a targeted cache test but failed the focused benchmark gate and was backed out.
- Latest benchmark telemetry addition: `--cache-stats` now includes `wasm_fn_hits` and
  `wasm_fn_misses`; semantic leaf edits show only the two changed functions miss Wasm encoding.
- Latest pruning control: `--no-prune` is not viable for watch/session semantic edits because it
  moves the cost into whole-program checking and is roughly 10x slower on the large benchmark.
- Latest linked-cache evidence: current linked cache keys miss on dependency body edits, but a
  source/interface/reference dependency key would turn the large benchmark's linked counter from
  `1 / 10` to `10 / 1`; the remaining design problem is cheap pruned current-body rehydration.
- Latest stopped linked-cache implementation: alias-only stable rehydration preserved correctness
  after a qualifier fix but spent more rebuilding the pruned surface than the normal miss path.
- Latest support-only gain: tail scalar-fact body-analysis cache, which lowered backend layout but
  did not reset the plateau by itself.
- Latest stopped attempt: import-closure selection reuse, which produced selection-cache hits but
  regressed wall time to `~79 ms`.
- Latest stopped backend-layout attempt: routing fixed-array private-call scans through the existing
  direct-call WeakMap cache regressed the focused run to `62.602 ms` with backend layout `14.831 ms`,
  so it was backed out. Do not add object-identity lookup layers to backend layout without a
  coarser artifact boundary.

Decision for the next attempt:

1. A local pass must beat `~47 ms` in repeated focused runs, or it is recorded as `Stop` /
   `Stop for now`.
2. A structural pass may be kept below the 5% wall threshold only if it removes a whole phase or
   creates an artifact boundary needed for checked/imported/backend module reuse.
3. Two more stopped passes against import/check/backend setup mean stop JavaScript micro-tuning and
   move to the larger implementation strategy: interface-stable checked-module and backend-module
   artifact reuse.

## Active Decision

Continue only if the next pass is a `Structural pass` that can plausibly reduce one of these
end-to-end costs in the focused harness:

- Whole-program checking: now around `~17-18 ms` in the focused normal harness after parsed
  annotation type caching, the `do`-preflight cache, and contract rewrite-misuse caching.
- Backend layout/lowering/cleanup plus Wasm encode: now roughly `~19-20 ms` combined in the
  focused harness after backend support caches.
- Import relinking/qualification: now around `~10-11 ms` after skipping redundant import metadata
  hiding and caching module reference keys.

Stop and reconsider the JavaScript strategy when two structural attempts in a row fail to beat the
latest isolated `~48-50 ms` focused run by at least 5%, or when a structural pass needs correctness
invalidation keys that are broader than the work it avoids.

## Next Structural Plan

The remaining Fig-vs-Go gap is now too small for helper-level caches to reliably move. The next
implementation should be an interface-stable checked-module reuse plan, with these constraints:

1. Keep full source keys for any cache that stores declaration bodies or generated qualified
   declarations.
2. Use module interface keys only for artifacts that do not contain stale bodies, or pair them with
   an explicit rehydration step from current parsed/merged module bodies.
3. Split checker work into module-local reusable artifacts before merging, so body-only dependency
   edits can reuse preflight/type declaration/contract results for modules whose interfaces and
   checked declarations are unchanged.
4. Let the final linked program still contain current bodies for changed modules, so backend
   function caches miss only changed functions and reuse unchanged lowered/encoded functions.
5. Prove the design with a test where `main -> mid -> leaf`, a body-only edit in `leaf` changes the
   produced result, and dependent module checker phases report reuse without stale output.
6. Do not add another narrower prune cache. The kept source-id selection cache already turns the
   body-edit case into `19 / 0` pruned-selection hits while rehydrating current declaration bodies;
   the next structural pass must skip or reuse a larger checked/imported/backend artifact.
7. Do not add declaration-level checker preflight caches without eliminating their key cost. A
   successful-preflight cache measured `81.959 ms` and `78.758 ms`, while post-backout measured
   `80.271 ms`; it did not beat the plateau and reinforced that per-declaration cache lookups are
   not the missing structural reuse layer.

Do not start another local cache unless a fresh trace shows a single subphase above roughly `8 ms`
that is not caused by whole-program merged-AST shape.

## Plateau Gate

Before starting another local optimization, classify it as one of these:

- `Local pass`: a focused rewrite, scan, memo, or identity-preserving cleanup inside one phase.
- `Structural pass`: a change that skips or reuses a whole checked/imported/backend artifact by an
  explicit invalidation key.
- `Harness pass`: a benchmark or trace change that gives better evidence but is not claimed as a
  compiler speedup.

Stop the current local optimization family when either condition is true:

- Two consecutive attempts in the same phase are `Stop` or `Stop for now`.
- One kept pass lands below the 5% wall-time threshold and the next attempt in that same family also
  fails to clear 5%.

When the plateau gate trips, do not keep adding micro-caches in that phase. Record the trip in the
decision log and move to a structural pass, a different phase with fresh trace evidence, or a
different implementation strategy.

## Harness

Temporary large benchmark. The harness source is tracked, while generated projects and caches remain
ignored:

```sh
deno run --allow-read --allow-write --allow-run tmp/large_compile_bench/run.ts --samples 5 --warmup 2
deno task bench:large-compile -- --mode=session_leaf_semantic_edit --samples 15 --warmup 5
```

The benchmark compares a multi-module Fig project against a matching Go project. The most important
Fig number is `session_leaf_semantic_edit`, because it exercises an edit in a dependency that forces
semantic invalidation without throwing away the whole compiler session.

For deciding whether a narrow optimization actually moved the current hot path, use the focused mode
selector instead of the full table:

```sh
deno run --allow-read --allow-write --allow-run tmp/large_compile_bench/run.ts --mode=session_leaf_semantic_edit --samples 15 --warmup 5
```

Use the full table for periodic Fig-vs-Go comparison, or run the Go comparison separately after a
warm no-op build:

```sh
deno run --allow-read --allow-write --allow-run tmp/large_compile_bench/run.ts --mode=build_warm_noop,build_leaf_semantic_edit --samples 5 --warmup 2
```

The temporary harness also accepts `--no-prune` for diagnostic comparison. It is not a candidate
default for the current benchmark: pruning off measured `~548 ms` because checking the unpruned
merged program dominates.

Do not keep an optimization based on a single 5-sample full-table run when the focused 15-sample row
does not clear the 5% wall-time threshold.

Do not run two `tmp/large_compile_bench/run.ts` benchmark commands in parallel when comparing rows
from the same checkout. The runner now uses isolated per-run project directories, but parallel runs
still contend for CPU and make wall-time comparisons noisier than the current plateau.

Record every optimization pass here, including failed or noisy attempts. A pass only counts as a
gain when the same harness improves the semantic dependency edit by at least 5% or removes a traced
phase that was blocking the next structural optimization. Otherwise mark it as stopped, even if an
individual trace subphase looks better.

When updating the table:

1. Keep the previous row even if the pass was reverted.
2. Add the benchmark command, sample count, and warmup count if they changed.
3. Record the wall-clock semantic edit number and the largest phase splits reported by the harness.
4. Update the decision log with `Keep`, `Stop`, or `Stop for now`.
5. If two consecutive kept passes are below the 5% threshold, stop local tuning and move to a larger
   design change.

## Progress

| Pass                                            | Fig semantic dependency edit | Delta vs previous |      Import |     Check |   Backend | Wasm encode | Verdict      | Notes                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------: | ----------------: | ----------: | --------: | --------: | ----------: | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial large benchmark                         |                      ~405 ms |                 - |     ~242 ms | ~88-90 ms |    ~50 ms |   ~19-22 ms | Baseline     | Baseline before session-cache passes.                                                                                                                                                                                                                                                                                                                                                                             |
| Parsed import/body cache pass                   |                  ~343-345 ms |          ~15% win |       lower |   similar |   similar |     similar | Keep         | Added parsed source reuse and body-only function reparsing.                                                                                                                                                                                                                                                                                                                                                       |
| Annotation/final-prune/duplicate filtering pass |                  ~303-306 ms |          ~12% win |     ~157 ms |    ~74 ms |    ~51 ms |      ~21 ms | Keep         | Best measured stable run before validation-feature gating.                                                                                                                                                                                                                                                                                                                                                        |
| Validation-feature gating attempt               |                  ~329-332 ms |       ~8% regress | ~169-177 ms | ~77-80 ms | ~53-61 ms |      ~22 ms | Stop         | Regressed/noisy; backed out rather than kept as a gain.                                                                                                                                                                                                                                                                                                                                                           |
| Reference-prefix allocation cleanup             |                  ~365-376 ms |      ~11% regress | ~183-190 ms | ~91-92 ms | ~65-68 ms |      ~25 ms | Stop for now | Trace showed root `import.qualify.imports` down from ~45 ms to ~32 ms, but normal wall runs stayed noisy.                                                                                                                                                                                                                                                                                                         |
| Per-declaration qualification cache             |                      ~362 ms |           ~2% win |     ~182 ms |    ~91 ms |    ~66 ms |      ~25 ms | Stop for now | Reuses qualified declarations across body-only edits, but still does not bypass structural relinking.                                                                                                                                                                                                                                                                                                             |
| Source-backed reference summary cache           |                      ~396 ms |       ~9% regress |     ~179 ms |   ~108 ms |    ~74 ms |      ~30 ms | Stop for now | Prune reference subphases dropped in trace, but end-to-end wall time did not improve enough to count.                                                                                                                                                                                                                                                                                                             |
| Debug optimizer no-op fast path                 |                      ~360 ms |           ~9% win |     ~171 ms |   ~107 ms |    ~59 ms |      ~29 ms | Keep         | Skips optimizer clone/scope in debug builds when no profile syntax needs erasing.                                                                                                                                                                                                                                                                                                                                 |
| Checker preflight fusion                        |                      ~341 ms |           ~5% win |     ~164 ms |    ~92 ms |    ~52 ms |      ~29 ms | Keep         | Fuses early syntax/debug validation for normal compiles and removes the dead borrow-restriction scan.                                                                                                                                                                                                                                                                                                             |
| Per-compile import resolution cache             |                      ~324 ms |           ~5% win |     ~162 ms |    ~87 ms |    ~47 ms |      ~25 ms | Keep         | Reuses module resolver results by importer/specifier during one compile while still recording every edge.                                                                                                                                                                                                                                                                                                         |
| Attached-member empty-map guard                 |                  ~238-245 ms |       ~24-26% win | ~124-127 ms | ~52-54 ms | ~38-42 ms |      ~21 ms | Keep         | Skips five attached-member rewrite walks when the program has no attached type members.                                                                                                                                                                                                                                                                                                                           |
| Collection-literal standalone gate              |                      ~244 ms |      no real gain |     ~130 ms |    ~55 ms |    ~39 ms |      ~21 ms | Stop         | A standalone pre-scan avoided one transform but did not improve end-to-end time; removed it.                                                                                                                                                                                                                                                                                                                      |
| Shared preflight feature reuse attempt          |                  ~287-288 ms |     noisy/no gain | ~153-156 ms | ~54-56 ms | ~50-52 ms |      ~27 ms | Stop         | Reusing preflight flags skipped some no-op passes, but end-to-end semantic edit regressed in repeated runs.                                                                                                                                                                                                                                                                                                       |
| Collection literal lookup memo attempt          |                  ~273-274 ms |   below threshold | ~141-143 ms | ~59-60 ms |    ~45 ms |      ~24 ms | Stop         | Memoized repeated collection target lookups, but `lowerCollectorLiterals` stayed ~10-12 ms in trace.                                                                                                                                                                                                                                                                                                              |
| Wasm encoded-function cache                     |                  ~252-268 ms |        ~5-11% win | ~139-146 ms | ~58-63 ms | ~42-47 ms |   ~12-13 ms | Keep         | Reuses encoded Wasm function bodies for unchanged cached backend functions; semantic edits re-encode misses.                                                                                                                                                                                                                                                                                                      |
| Import closure plan cache attempt               |                      ~260 ms |     no clear gain |     ~144 ms |    ~58 ms |    ~46 ms |      ~12 ms | Stop         | Reused alias closure name plans across body-only edits, but import time stayed in the same range.                                                                                                                                                                                                                                                                                                                 |
| Wasm debug name-section cache                   |                  ~268-284 ms |   phase-only gain | ~147-157 ms | ~65-68 ms | ~47-48 ms |     ~8-9 ms | Keep support | Reuses debug name sections across unchanged function/local names; wall time is still dominated by import.                                                                                                                                                                                                                                                                                                         |
| Split-declaration cache attempt                 |                      ~390 ms |           regress |     ~209 ms |    ~93 ms |    ~68 ms |      ~12 ms | Stop         | WeakMap caching local/transitive declaration splits added overhead in the hot import path.                                                                                                                                                                                                                                                                                                                        |
| Fragment line-map attempt                       |                  ~271-301 ms |     no clear gain | ~155-157 ms | ~66-72 ms | ~50-57 ms |     ~8-9 ms | Stop         | Avoiding full-source line maps during fragment reparses did not move semantic edit time.                                                                                                                                                                                                                                                                                                                          |
| Source-key hash cache attempt                   |                      ~294 ms |           regress |     ~160 ms |    ~70 ms |    ~55 ms |       ~9 ms | Stop         | Reusing source content hashes helped trivial edits but worsened semantic invalidation runs.                                                                                                                                                                                                                                                                                                                       |
| Checker declaration transform cache             |                  ~271-277 ms |   phase-only gain | ~155-156 ms | ~55-60 ms | ~51-54 ms |      ~10 ms | Keep support | Skips idempotent binary-chain and collection-literal lowering for reused declaration objects.                                                                                                                                                                                                                                                                                                                     |
| Shallow merge metadata finalization             |                  ~144-148 ms |       ~45-48% win |   ~23-24 ms | ~62-63 ms |    ~50 ms |       ~8 ms | Keep         | Stops recursively re-hiding metadata across already-hidden imported ASTs after every module merge.                                                                                                                                                                                                                                                                                                                |
| Backend flatten-type memo attempt               |                      ~149 ms |     no clear gain |      ~26 ms |    ~68 ms |    ~49 ms |       ~8 ms | Stop         | Per-layout `flattenType` memo did not move backend or wall time enough to justify the extra cache.                                                                                                                                                                                                                                                                                                                |
| Checker preflight declaration cache attempt     |                  ~142-164 ms |     noisy/no gain |   ~24-27 ms | ~58-66 ms | ~49-58 ms |    ~9-11 ms | Stop         | Declaration identity cache for preflight checks had one good run but repeated runs stayed inside noise.                                                                                                                                                                                                                                                                                                           |
| Builtin operator declaration cache attempt      |                      ~172 ms |           regress |      ~28 ms |    ~72 ms |    ~68 ms |       ~8 ms | Stop         | WeakSet skip around builtin operator lowering added overhead/noise and regressed semantic edit time.                                                                                                                                                                                                                                                                                                              |
| Checked runtime-program reuse attempt           |                      ~145 ms |     no clear gain |      ~26 ms |    ~59 ms |    ~47 ms |       ~8 ms | Stop         | Reused the checker's runtime program in backend debug fast path; backend shifted slightly but wall time did not improve.                                                                                                                                                                                                                                                                                          |
| Nested annotation success memo attempt          |                  ~162-200 ms |           regress |   ~28-32 ms | ~69-82 ms | ~55-75 ms |    ~9-10 ms | Stop         | Per-check memoization of already-valid annotation instantiation added overhead/noise and regressed repeated runs.                                                                                                                                                                                                                                                                                                 |
| Contract preflight fusion attempt               |                  ~163-166 ms |           regress |   ~26-27 ms | ~67-72 ms | ~58-59 ms |    ~9-10 ms | Stop         | Moving rewrite misuse validation into preflight removed one later walk but made the already-hot preflight path slower.                                                                                                                                                                                                                                                                                            |
| Backend called-function cache attempt           |                  ~152-182 ms |     noisy/regress |   ~25-30 ms | ~69-76 ms | ~53-65 ms |       ~9 ms | Stop         | WeakMap caching called-function sets for backend reachability/alias checks made layout noisier and regressed repeated runs.                                                                                                                                                                                                                                                                                       |
| Module interface key foundation                 |                  ~131-167 ms |  foundation/noise |   ~24-25 ms | ~55-71 ms | ~44-60 ms |     ~7-9 ms | Keep support | Adds body-insensitive module interface keys in the compile cache; does not claim a wall-time win yet.                                                                                                                                                                                                                                                                                                             |
| Interface-key name cache attempt                |                  ~143-158 ms |     noisy/no gain |   ~24-25 ms | ~59-70 ms | ~49-52 ms |     ~8-9 ms | Stop         | Tried using interface surface keys for name-only import caches; repeated runs stayed in the current noise band, so the code was backed out.                                                                                                                                                                                                                                                                       |
| Product-constructor identity lowering           |                  ~125-140 ms |        ~8-17% win |   ~23-25 ms | ~52-59 ms | ~41-47 ms |     ~7-8 ms | Keep         | `lowerProductConstructors` now preserves existing expression objects when no subtree changes, reducing checker allocation and preserving downstream cache identity.                                                                                                                                                                                                                                               |
| Product-constructor declaration cache attempt   |                      ~147 ms |           regress |      ~26 ms |    ~65 ms |    ~50 ms |       ~9 ms | Stop         | A WeakMap skip for already-lowered declarations added overhead/noise after identity preservation; backed out.                                                                                                                                                                                                                                                                                                     |
| Backend runtime input fusion attempt            |                      ~148 ms |     no clear gain |      ~26 ms |    ~66 ms |    ~51 ms |       ~9 ms | Stop         | Fusing runtime projection, layout collection, function lists, and intrinsic-id collection into one declaration pass did not move wall time; backed out.                                                                                                                                                                                                                                                           |
| Backend layout environment cache attempt        |                      ~143 ms |   below threshold |      ~25 ms |    ~60 ms |    ~49 ms |       ~9 ms | Stop         | A layout-relevant declaration key reused layout environments, but keying plus reuse did not clear the 5% wall-time threshold; backed out.                                                                                                                                                                                                                                                                         |
| Fresh post-revert baseline                      |                      ~113 ms |                 - |      ~21 ms |    ~47 ms |    ~38 ms |       ~7 ms | Baseline     | A warmed repeated run after backend attempt rollbacks showed the current noise floor is lower than older ~125-140 ms rows.                                                                                                                                                                                                                                                                                        |
| Preflight diagnostics cache attempt             |                      ~136 ms |           regress |      ~26 ms |    ~54 ms |    ~46 ms |       ~8 ms | Stop         | Per-declaration cached fused preflight diagnostics added hashing/cache overhead and regressed the semantic edit; backed out.                                                                                                                                                                                                                                                                                      |
| Same-width literal AST patch attempt            |                      ~151 ms |           regress |      ~26 ms |    ~62 ms |    ~52 ms |       ~8 ms | Stop         | Tried patching numeric literal edits directly in the previous parsed function AST, but clone/search overhead outweighed fragment parsing; backed out.                                                                                                                                                                                                                                                             |
| Backend function hash cache attempt             |                      ~157 ms |           regress |      ~26 ms |    ~77 ms |    ~44 ms |      ~10 ms | Stop         | WeakMap-cached source function hashes cut backend lower to ~7 ms, but wall time and check time regressed; backed out.                                                                                                                                                                                                                                                                                             |
| Focused semantic-edit harness                   |                      ~135 ms |                 - |      ~25 ms |    ~57 ms |    ~45 ms |       ~7 ms | Keep support | Added `--mode` selection to the temporary large benchmark; use 15 samples and 5 warmups for local optimization decisions.                                                                                                                                                                                                                                                                                         |
| Preflight declaration WeakSet attempt           |                  ~127-139 ms |     noisy/no gain |      ~26 ms | ~50-56 ms | ~42-46 ms |     ~8-9 ms | Stop         | Identity-skipped declarations that had already passed fused preflight; first focused run cleared 5%, second did not, so the code was backed out.                                                                                                                                                                                                                                                                  |
| Qualified local import source-key reuse         |                  ~121-123 ms |        ~9-10% win |   ~23-24 ms | ~50-51 ms |    ~40 ms |       ~7 ms | Keep         | Reuses existing resolved source keys for directly imported local-declaration qualification cache keys instead of hashing whole local declaration arrays.                                                                                                                                                                                                                                                          |
| Source-key name-key shortcut attempt            |                 compile fail |                 - |           - |         - |         - |           - | Stop         | Tried using source keys in place of imported/local name-set keys; semantic-edit compile reported missing qualified types, so the shortcut was backed out.                                                                                                                                                                                                                                                         |
| Post-backout focused revalidation               |                  ~148-153 ms |     noisy/regress |   ~28-29 ms | ~61-64 ms | ~50-51 ms |     ~8-9 ms | Baseline     | Two focused 15-sample runs after backing out the unsafe shortcut completed successfully; use this as the active plateau band for the next pass.                                                                                                                                                                                                                                                                   |
| Inferred specialization identity preservation   |                  ~134-137 ms |        ~9-12% win |   ~25-26 ms | ~55-58 ms | ~44-46 ms |     ~7-8 ms | Keep         | `specializeInferredTypeCalls` now preserves unchanged blocks/expressions instead of allocating fresh trees on every pass.                                                                                                                                                                                                                                                                                         |
| Inferred type-var predicate cache               |                  ~130-133 ms |   phase win/noisy |   ~26-27 ms | ~45-49 ms | ~46-50 ms |       ~8 ms | Keep support | Reuses parsed raw inferred type-var sets across repeated specialization gates and semantic edits; traced no-op specialization passes #2/#3 fell to ~0.2 ms.                                                                                                                                                                                                                                                       |
| Contract-work preflight gate attempt            |                  ~130-133 ms |     no clear gain |   ~26-27 ms | ~46-52 ms | ~47-58 ms |       ~8 ms | Stop         | A no-contract preflight scanner had one `~107 ms` run, but focused repeats returned to the current band and trace showed the scanner cost about the same as the skipped contract pass; backed out.                                                                                                                                                                                                                |
| Function-check cache hit sharing attempt        |                      ~139 ms |           regress |      ~28 ms |    ~50 ms |    ~51 ms |       ~9 ms | Stop         | Reusing cached params/locals/effects arrays avoided cloning on check cache hits, but worsened check/backend time in the focused harness; backed out.                                                                                                                                                                                                                                                              |
| Patched-import top-level span shifting          |                  ~120-122 ms |        ~6-10% win |   ~25-26 ms | ~42-43 ms | ~44-45 ms |       ~8 ms | Keep         | Length-changing function-body edits now shift only top-level metadata for unchanged later declarations instead of walking every later declaration subtree.                                                                                                                                                                                                                                                        |
| Builtin operator lowering declaration cache     |                  ~112-122 ms |   no durable gain |   ~24-25 ms | ~38-42 ms | ~41-45 ms |     ~7-8 ms | Keep support | In the no-custom-operator path, unchanged declarations already lowered for builtin operator chains are skipped by identity in later session compiles; the earlier `~107-108 ms` runs were invalidated by restoring custom binary operator lowering.                                                                                                                                                               |
| Fixed-array planning body-analysis memo attempt |                  ~116-126 ms |     noisy/regress |   ~25-26 ms | ~39-42 ms | ~43-46 ms |     ~7-8 ms | Stop         | Memoizing private-call and dynamic-read body walks inside fixed-array planning did not lower backend layout or wall time in repeated focused runs; backed out.                                                                                                                                                                                                                                                    |
| Type-contract validation cache                  |                  ~102-120 ms |         noisy win |   ~22-26 ms | ~31-39 ms | ~41-48 ms |     ~7-8 ms | Keep support | Successful type-contract validation is cached by declaration semantic hash plus type/function/const environment key, so unchanged declarations skip nested annotation instantiation after semantic body edits; repeated later runs rose to ~120 ms.                                                                                                                                                               |
| Imported declaration identity WeakMap attempt   |                  ~114-116 ms |           regress |      ~24 ms | ~34-36 ms | ~45-46 ms |       ~8 ms | Stop         | WeakMap-caching imported declaration identity strings added overhead and regressed repeated focused runs; backed out.                                                                                                                                                                                                                                                                                             |
| Type-contract const-declaration key attempt     |                      ~131 ms |           regress |      ~28 ms |    ~42 ms |    ~53 ms |       ~9 ms | Stop         | Replacing evaluated const-value hashing with const-declaration semantic hashes in the type-contract cache key regressed the focused benchmark; backed out.                                                                                                                                                                                                                                                        |
| Fixed-array layout absence gate attempt         |                      ~156 ms |           regress |      ~36 ms |    ~51 ms |    ~58 ms |      ~10 ms | Stop         | Tried skipping optimized-export clone probes and fixed-array planning when reachable signatures did not contain inline-array types; the gate added enough overhead/noise to regress every major phase, so it was backed out.                                                                                                                                                                                      |
| Cache-stable fixed-array absence gate attempt   |                      ~171 ms |           regress |      ~38 ms |    ~54 ms |    ~65 ms |      ~11 ms | Stop         | Retried the fixed-array absence gate while preserving per-function empty plan maps so backend cache keys stayed shape-compatible; the signature scan/gate still regressed badly, so the whole absence-gate direction was backed out.                                                                                                                                                                              |
| Post-backout noisy revalidation                 |                  ~158-198 ms |    machine slower |   ~30-39 ms | ~50-62 ms | ~61-83 ms |   ~10-12 ms | Harness note | After backing out both fixed-array gates and confirming no gate code remained, repeated focused runs stayed slow; the Go comparison also slowed to ~92 ms, so treat this as machine-state noise until a fresh baseline settles.                                                                                                                                                                                   |
| Cache telemetry harness                         |                       ~91 ms |  harness evidence |      ~21 ms |    ~27 ms |    ~35 ms |       ~7 ms | Keep support | Added opt-in `--cache-stats` columns to the temporary large benchmark; telemetry shows semantic leaf edits hit function-check, type-contract, and backend-function caches `~2282` times with only `~2` misses, so remaining gains are setup/relink/layout overhead around hot caches.                                                                                                                             |
| Memory ABI cleanup plan attempt                 |                    ~92-94 ms |     no clear gain |      ~21 ms | ~27-27 ms | ~36-37 ms |     ~6-7 ms | Stop         | Precomputed public/import memory ABI decisions once per backend cleanup and threaded them through wrappers/import lowering/runtime helpers; repeated focused runs stayed slower than the active best, so the change was backed out.                                                                                                                                                                               |
| Post-ABI-backout revalidation                   |                       ~90 ms |      current best |      ~21 ms |    ~26 ms |    ~35 ms |       ~6 ms | Baseline     | After backing out the memory ABI cleanup plan, the focused harness measured a new current best; use this as the next comparison point.                                                                                                                                                                                                                                                                            |
| Type-casing identity cache attempt              |                    ~88-92 ms |     noisy/no gain |      ~22 ms | ~22-24 ms | ~37-37 ms |     ~7-7 ms | Stop         | Cached successful type annotation casing checks by declaration identity and visible type/value names; one run lowered check time, but the repeat regressed past the current best, so it was backed out.                                                                                                                                                                                                           |
| Default plugin registry reuse attempt           |                       ~93 ms |     no clear gain |      ~21 ms |    ~27 ms |    ~36 ms |       ~7 ms | Stop         | Reused the built-in no-plugin registry instead of rebuilding it in check/backend. The focused run stayed slower than the current best, so the setup-cost fast path was backed out.                                                                                                                                                                                                                                |
| Backend layout-env reuse                        |                    ~86-87 ms |    near-threshold |      ~20 ms |    ~25 ms |    ~33 ms |       ~6 ms | Keep support | Reuses the backend layout environment when function bodies change but the layout surface is stable. Repeated focused runs set a new best, but the improvement is only just below the 5% gain gate, so treat this as support for larger backend-setup reuse rather than a solved phase.                                                                                                                            |
| Backend function hash reuse                     |                    ~79-82 ms |         ~5-8% win |   ~19-20 ms | ~24-25 ms |    ~28 ms |       ~6 ms | Keep         | Caches stable backend hashes for unchanged function AST objects and uses the cached hash in backend function cache keys. Backend lower dropped from roughly ~10.7 ms to ~4.2-4.5 ms in repeated focused runs.                                                                                                                                                                                                     |
| Fixed-array plan artifact cache attempt         |                    ~78-80 ms |     no clear gain |   ~20-20 ms | ~25-25 ms | ~27-28 ms |       ~6 ms | Stop         | Cached whole fixed-array planning artifacts by function/layout hashes. The focused repeats stayed inside the current band and backend layout did not move, so the cache was backed out.                                                                                                                                                                                                                           |
| Aliased import object-dedupe fast path          |                       ~83 ms |           regress |      ~20 ms |    ~27 ms |    ~27 ms |       ~6 ms | Stop         | Tried skipping repeated cached alias support declarations by object identity before span identity keys. It regressed the focused run and did not lower import time, so the fast path was backed out.                                                                                                                                                                                                              |
| Backend layout-hash cache attempt               |                    ~80-81 ms |     no clear gain |      ~20 ms |    ~25 ms |    ~27 ms |       ~6 ms | Stop         | Reused a cached hash for the backend layout environment inside the backend function cache environment key. Focused repeats stayed in the current band, so the hash cache was backed out.                                                                                                                                                                                                                          |
| Root merge cache-key attempt                    |                       ~82 ms |           regress |      ~20 ms |    ~26 ms |    ~28 ms |       ~6 ms | Stop         | Added a stable root source key so root alias-root/final-prune caches could key on root identity. The extra root AST hash/key path cost more than it saved on semantic dependency edits, so it was backed out.                                                                                                                                                                                                     |
| Shared checker environment key attempt          |                    ~79-80 ms |     no clear gain |   ~20-21 ms | ~24-25 ms |    ~27 ms |       ~6 ms | Stop         | Reused the function/type environment key across type-contract and function-check cache paths. Focused repeats stayed in the current band and did not durably reduce check time, so the change was backed out.                                                                                                                                                                                                     |
| Reference-graph prune selection cache attempt   |                    ~82-84 ms |           regress |   ~22-23 ms | ~25-26 ms |    ~28 ms |       ~6 ms | Stop         | Cached import-prune keep sets by current declaration reference graph so body edits could reuse pruning decisions without stale bodies. Key construction cost more than the skipped work in focused 15-sample runs, so the change was backed out.                                                                                                                                                                  |
| Post-prune-backout revalidation                 |                       ~81 ms |      current band |      ~20 ms |    ~25 ms |    ~28 ms |       ~6 ms | Baseline     | After backing out the reference-graph prune selection cache, the focused harness returned to the current plateau band. The current best remains the earlier `~79 ms` backend function hash reuse run.                                                                                                                                                                                                             |
| Backend body-analysis cache                     |                    ~79-80 ms |   backend support |   ~20-20 ms | ~25-26 ms | ~26-27 ms |       ~6 ms | Keep support | Reuses call-set, direct-call, and tail-call body analyses across semantic edits. Backend layout fell from roughly `~18.0-18.3 ms` to `~16.6-16.7 ms`, but wall time stayed in the current plateau band, so treat this as support for broader backend setup reuse.                                                                                                                                                 |
| Backend repeated body-metric caches             |                    ~77-77 ms |   below-threshold |   ~19-19 ms | ~25-25 ms | ~26-26 ms |       ~6 ms | Keep support | Reuses per-body call counts, name-use counts, and inline costs across semantic edits. Focused repeats improved the current band but stayed below the 5% wall-time gate, so this trips the local backend tuning plateau and the next pass should be structural.                                                                                                                                                    |
| Alias-root imported-name source-key shortcut    |                       ~79 ms |           regress |      ~21 ms |    ~25 ms |    ~26 ms |       ~6 ms | Stop         | Passed the imported program source key into alias-root cache key construction to avoid sorting large imported-name sets. The focused run regressed import time and wall time, so the one-line shortcut was backed out.                                                                                                                                                                                            |
| Post-alias-key-backout revalidation             |                       ~80 ms |      current band |      ~20 ms |    ~26 ms |    ~27 ms |       ~6 ms | Baseline     | After backing out the alias-root source-key shortcut, the focused harness returned to the broader current band. The best observed result remains the earlier `~77 ms` backend repeated body-metric run.                                                                                                                                                                                                           |
| Import cache telemetry expansion                |                       ~82 ms |  harness evidence |      ~20 ms |    ~26 ms |    ~30 ms |       ~6 ms | Keep support | Extended the temporary benchmark `--cache-stats` mode to include linked-module, import-closure, pruned-import, and qualified-local-import hits. A focused semantic leaf edit showed linked modules `1 hit / 10 misses`, import closures `13 / 19`, pruned imports `0 / 19`, and local imports `15 / 4`; the next structural target is body-safe pruned/import-closure reuse, not more local qualification caches. |
| Body-safe pruned selection cache attempt        |                    ~78-80 ms |           regress |   ~22-23 ms | ~24-25 ms |    ~26 ms |       ~6 ms | Stop         | Cached pruned-import keep-name sets by a reference-only program key plus roots, then rehydrated against current declarations to avoid stale bodies. Focused 15-sample runs measured `78.199 ms` and `80.045 ms`, worse than the `~77 ms` checkpoint; a `--cache-stats` run still reported pruned imports `0 hit / 19 misses`. The change was backed out.                                                          |
| Post-pruned-selection-backout revalidation      |                    ~78-81 ms |      current band |   ~20-20 ms | ~25-26 ms | ~26-27 ms |     ~6-7 ms | Baseline     | After backing out the pruned-selection cache, focused 15-sample runs measured `81.058 ms` and then `78.258 ms`. Treat this as the same current plateau band; the best observed result remains the earlier `~77 ms` backend repeated body-metric run.                                                                                                                                                              |
| Checker preflight success cache attempt         |                    ~79-82 ms |     no clear gain |   ~21-21 ms | ~24-25 ms | ~26-28 ms |     ~6-6 ms | Stop         | Cached successful per-declaration checker preflight scans by semantic declaration hash. The focused runs measured `81.959 ms` and `78.758 ms`; check time nudged down once, but wall time stayed in the plateau and the cache added another per-declaration key path. The change was backed out.                                                                                                                  |
| Post-preflight-cache-backout revalidation       |                       ~80 ms |      current band |      ~21 ms |    ~25 ms |    ~27 ms |       ~6 ms | Baseline     | After backing out the preflight success cache, the focused harness measured `80.271 ms`. Cache stats still show the useful hot caches already hit `2282 / 2`; remaining misses are linked/pruned/import-closure artifacts, not function/type/backend body caches.                                                                                                                                                 |
| No-prune diagnostic comparison                  |                      ~548 ms |  harness evidence |      ~14 ms |   ~495 ms |    ~31 ms |       ~6 ms | Stop         | Added a temporary `--no-prune` harness flag and measured the same semantic leaf edit without import pruning. Import got cheaper, but check time exploded because the merged program stayed huge. Pruning remains mandatory for this benchmark.                                                                                                                                                                    |
| Folded prune-name graph attempt                 |                    ~79-82 ms |   phase-only gain |      ~19 ms | ~26-26 ms | ~27-28 ms |       ~6 ms | Stop         | Replaced the prune owner map with a name-to-declarations graph. Import improved to `~18.9 ms`, but focused wall runs measured `82.451 ms` and `79.267 ms`, still above the `~77 ms` best. The compiler change was backed out; only the harness diagnostic flag remains.                                                                                                                                           |
| Post-prune-graph-backout revalidation           |                       ~80 ms |      current band |      ~20 ms |    ~25 ms |    ~27 ms |       ~6 ms | Baseline     | After backing out the folded prune graph, the focused harness measured `80.446 ms`. This confirms the phase-only import improvement was not enough to keep under the plateau gate.                                                                                                                                                                                                                                |
| Source-id interface stability telemetry         |                       ~79 ms |  harness evidence |      ~20 ms |    ~26 ms |    ~26 ms |       ~6 ms | Keep support | Added source-id-level interface stability bookkeeping and benchmark counters. A cache-stats semantic leaf edit shows full-source interface hits `11 / 1`, source-id interface hits `12 / 0`, and stable source/interface hits `12 / 0`; the edited leaf keeps its interface stable across body edits. This is foundation evidence for body-rehydrating module artifact reuse, not a wall-time win.                |
| Source-id pruned-selection reuse                |                    ~72-73 ms |         ~5-6% win |   ~16-17 ms | ~24-24 ms | ~25-26 ms |     ~6-6 ms | Keep         | Cached pruned-import keep-name sets by stable source id, module interface key, module reference key, and roots, then rehydrated against current declarations. Focused 15-sample runs measured `72.710 ms` and `72.978 ms`; a cache-stats run showed full-source pruned imports still `0 / 19`, but pruned-selection reuse `19 / 0`. Correctness tests cover body-value edits and body reference-graph changes.    |
| Import-closure selection reuse attempt          |                       ~79 ms |           regress |      ~22 ms |    ~24 ms |    ~26 ms |       ~6 ms | Stop         | Tried extending the source-id/interface/reference selection idea from prune sets to alias import closures, rehydrating current declarations on hit. It produced closure-selection hits `27 / 0`, but replaced cheaper prune-selection hits, raised local import misses, and regressed focused wall time to `79.060 ms`; the change was backed out.                                                                |
| Tail scalar-fact body-analysis cache            |                    ~70-75 ms |   noisy phase win |   ~17-19 ms | ~23-25 ms | ~23-25 ms |     ~6-6 ms | Keep support | Threaded the existing backend analysis cache into tail-parameter scalar fact inference. Focused 15-sample runs measured `70.096 ms`, `74.765 ms`, and `69.714 ms`; backend layout dropped from the `~16-17 ms` band to `~13.7-15.3 ms`, but one wall run was noisy, so count it as support rather than a new plateau by itself.                                                                                   |
| Parsed annotation type cache                    |                    ~66-68 ms |        ~7-10% win |   ~16-17 ms | ~20-20 ms | ~22-23 ms |     ~6-6 ms | Keep         | Reuses parsed annotation type strings through a bounded 4096-entry cache. Focused 15-sample runs measured `65.715 ms`, `67.932 ms`, and a later rebaseline at `65.370 ms`; check time dropped from the `~24 ms` band to roughly `~20 ms`, clearing the local-pass keep threshold.                                                                                                                 |
| Annotation type-call list cache attempt         |                       ~67 ms |     no clear gain |      ~17 ms |    ~20 ms |    ~23 ms |       ~6 ms | Stop         | Cached `collectTypeCalls(parseAnnotationType(annotation))` results by annotation source. The focused 15-sample run measured `66.981 ms`, slower than the latest `65.370 ms` rebaseline and above the new `~63-64 ms` keep bar, so the change was backed out. Post-backout revalidation measured `66.382 ms`.                                                                                                      |
| Closure descriptor direct-call cache attempt    |                    ~67-69 ms |   phase-only gain |   ~17-18 ms | ~21-21 ms | ~22-24 ms |     ~6-6 ms | Stop         | Reused cached backend direct-call lists while collecting closure descriptors. Backend layout dropped once to `12.471 ms`, but focused wall time measured `67.553 ms`; post-backout revalidation measured `69.308 ms` in a noisy run. The change was backed out because it did not beat the `~63-64 ms` keep bar and did not reduce end-to-end time.                                                              |
| Skip redundant import metadata hide             |                    ~64-65 ms |     support gain |   ~14-15 ms | ~20-20 ms | ~23-24 ms |     ~6-6 ms | Keep support | `lowerProgram` already hides AST metadata, so `parseModuleSource` now sets `moduleName` directly instead of recursively hiding metadata again after full parse or body-edit patching. Focused 15-sample runs measured `64.609 ms` and `65.182 ms`; import dropped from the `~16-17 ms` band to `~14-15 ms`, but wall time is just under the 5% gate, so count it as support.                                    |
| Linked materialization no-clone attempt         |                    ~63-64 ms |     no clear gain |   ~14-15 ms | ~20-20 ms | ~23-24 ms |     ~5-6 ms | Stop         | Tried returning the cached linked program directly instead of cloning it on linked-module cache hits. Focused 15-sample runs measured `62.633 ms` and `64.377 ms`, so the repeat stayed in the current plateau and did not clear the `~61-62 ms` keep bar. The change was backed out.                                                                  |
| Normal-path checker compile-profile coverage    |                    ~64-67 ms |  harness evidence |   ~14-14 ms | ~20-21 ms | ~23-24 ms |     ~6-6 ms | Keep support | `--compile-profile` now records normal checker phases without enabling checker trace mode. Focused normal runs measured `66.766 ms` then `64.276 ms`, so the hook stayed inside the current plateau. A compile-profile sample showed import qualification/merge still dominate traceable setup, followed by `check.checkFn loop`, `check.checkContracts`, and `check.checkTypeContracts`.                       |
| Backend layout compile-profile coverage         |                    ~65-74 ms |  harness evidence |   ~14-16 ms | ~20-26 ms | ~24-26 ms |     ~6-6 ms | Keep support | `--compile-profile` now records backend layout/lower subphases. Focused normal runs measured `73.945 ms` then `65.187 ms`, so the repeat returned to the current plateau. A compile-profile sample showed backend layout time concentrated in `backend.layout.fixed_array_plans` `5.606 ms`, `backend.layout.return_projection_plans` `4.183 ms`, and `backend.layout.closure_descriptors` `1.968 ms`. |
| Return-projection use cache attempt             |                    ~66-70 ms |           regress |   ~14-16 ms | ~21-22 ms | ~24-25 ms |     ~6-6 ms | Stop         | Cached projection-use summaries by block object, statement index, and binding name to avoid rebuilding/rescanning remaining let tails in `privateReturnProjectionPlans`. Focused 15-sample runs measured `69.600 ms` and `66.119 ms`, above the `~61-62 ms` keep bar. The change was backed out; post-backout validation was noisy at `74.949 ms`. |
| Profile-hook zero-overhead guard attempt        |                    ~69-71 ms |           regress |   ~15-16 ms | ~21-22 ms | ~24-25 ms |     ~6-6 ms | Stop         | Tried replacing normal-mode `traceSync(undefined, ...)` calls with explicit no-trace branches in checker/backend profiling hooks. Focused 15-sample runs measured `71.275 ms` and `69.343 ms`, so the rewrite was backed out. Post-backout focused validation measured `65.083 ms`, back in the current plateau. |
| Fig-vs-Go current comparison                    |                    67.895 ms | harness evidence  |  13.934 ms | 21.747 ms | 25.009 ms |    6.560 ms | Harness note | Rechecked with `--mode=session_leaf_semantic_edit,build_warm_noop,build_leaf_semantic_edit --samples 10 --warmup 3`. Go measured `66.218 ms` for the matching semantic dependency edit and `17.452 ms` for warm no-op. Fig is within `1.677 ms` of Go on semantic edits in this harness, while no-op remains the obvious Go advantage. Do not use this to keep local helper tuning; use it to stop attempts that cannot clear `~61-62 ms`. |
| Module reference-key source cache               |                    ~66-68 ms |   import support |   ~10-11 ms | ~22-23 ms | ~25-26 ms |     ~6-7 ms | Keep support | Caches `moduleReferenceKey(parsed)` by full module source key while still publishing the current source-id reference key used by pruned-selection reuse. Focused 15-sample runs measured `65.765 ms` and `67.771 ms`; import dropped to `10.779-10.988 ms`, but wall time stayed inside the current plateau, so keep this as structural import support rather than a new plateau. A Wasm vector-section allocation attempt was tried before this and backed out after measuring `77.692 ms` with no encode improvement. |
| Branch-hint declaration validation cache        |                    ~58-64 ms |        ~8-13% win |   ~10-11 ms | ~19-21 ms | ~23-24 ms |     ~6-7 ms | Keep         | Caches declarations that already passed branch-hint validation in a WeakSet under the default plugin registry. Focused 15-sample no-stats runs measured `58.608 ms` and `60.442 ms`; a cache-stats run measured `63.679 ms`. Check time dropped to `18.851-18.876 ms` in the no-stats runs. Keep this as the new active plateau, with the next keep bar around `~57 ms`. |
| Fig-vs-Go post-branch-cache comparison          |                    64.317 ms | harness evidence  |  10.862 ms | 23.476 ms | 23.842 ms |    6.107 ms | Harness note | Rechecked with `--mode=session_leaf_semantic_edit,build_warm_noop,build_leaf_semantic_edit --samples 10 --warmup 3`. Go measured `64.395 ms` for the matching semantic dependency edit and `19.184 ms` for warm no-op. Treat semantic edits as tied in this temporary harness; future gains should target the remaining Fig setup phases or broaden benchmark evidence, not chase the old Go gap. |
| Backend private-call cache reroute attempt      |                    62.602 ms |           regress |  10.066 ms | 20.162 ms | 24.922 ms |    6.135 ms | Stop         | Tried routing fixed-array private-call scans through the existing backend direct-call WeakMap cache. Backend layout increased to `14.831 ms` and wall time stayed above the best post-branch-cache focused runs, so the change was backed out. This reinforces that backend layout needs a coarser planning artifact, not more object-identity lookups. |
| Stability recheck checkpoint                    |                    ~85-95 ms | harness evidence  |   ~14-15 ms | ~28-30 ms | ~33-36 ms |     ~8 ms | Harness note | Repeated focused no-stats runs later in the same turn measured `85.016 ms` and `84.811 ms` without a compiler source change after an earlier `61.122 ms` run. A same-run 5-sample comparison measured Fig semantic edit `94.648 ms`, Go semantic edit `81.931 ms`, and Go warm no-op `25.163 ms`. This is environment jitter evidence, not a compiler regression claim. |
| Parsed-root trailing-trivia reuse               |         semantic unchanged; root no-op 0.494 ms | no-op win | 0.000 ms | 0.000 ms | 0.000 ms | 0.000 ms | Keep         | Reuses the previous parsed root when a compiler session root changes only by trailing standalone trivia, and treats dependency trailing-trivia replacements as artifact-current. `session_root_edit` improved from `1.704 ms` to `0.494 ms` in the large harness; a focused 25-sample root run repeated at `0.494 ms`, with parse/import/check/backend/wasm all zero. Same-run semantic edit stayed in the current noisy band at `74.612 ms` while Go semantic edit measured `78.760 ms`. |
| Backend cleanup called-function cache attempt   |                    ~75-78 ms |     no clear gain |   ~12-13 ms | ~26-27 ms | ~29-30 ms |     ~7 ms | Stop         | Cached called-function lists for reused lowered backend instruction bodies during unreachable-backend-function cleanup. Cleanup dropped once to `3.935 ms`, but focused wall runs measured `75.639 ms` and `77.917 ms` after a `76.727 ms` baseline, so the change stayed inside noise and was backed out. |
| Type-casing declaration cache attempt           |                    80.303 ms |           regress |  13.356 ms | 26.627 ms | 31.636 ms |    7.416 ms | Stop         | Cached successful `checkTypeFunctionCasing` validation by declaration plus type/value-name environment. The targeted cache test hit, but semantic edit wall time regressed to `80.303 ms`; hashing/key cost outweighed the skipped validation. The change was backed out. |
| Imported identity-key cache attempt             |                    ~71-78 ms |   phase-only gain |   ~10-12 ms | ~24-27 ms | ~29-32 ms |     ~7 ms | Stop         | Cached duplicate-filter identity keys in a WeakMap. Import dropped to `10.574-10.964 ms` in repeated runs, but wall time measured `75.739 ms`, `70.981 ms`, then `77.828 ms` in a same-run Fig/Go comparison, so it failed the repeated wall gate and was backed out. |
| Backend unreachable direct traversal            |                    ~44-46 ms |     ~18-20% win |   ~10-10 ms | ~17-17 ms | ~12-12 ms |     ~5 ms | Keep         | Replaced per-function callee-name array allocation in backend unreachable cleanup with direct nested instruction visitation. Focused 15-sample runs measured `44.367 ms` and `45.685 ms`; same-run Fig-vs-Go measured Fig `47.153 ms`, Go warm no-op `16.197 ms`, and Go semantic edit `309.470 ms`. |

Current best observed Fig semantic dependency edit: `44.367 ms` in a focused 15-sample run, with
the repeat at `45.685 ms`. Treat the current stable plateau as `~44-47 ms`, but require same-run
comparison because environment-sensitive rechecks have shifted both Fig and Go upward in the past.

Current latest isolated Fig semantic dependency edit during the stability recheck: `84.811 ms` in a
focused 15-sample run. This latest absolute value is not a new plateau by itself because the
same-machine Go comparison also shifted upward.

Current best Go dependency semantic edit on the same temporary project: ~65 ms in a focused
5-sample run after a warm no-op build. Latest same-machine recheck measured Go semantic edit at
`66.218 ms` and Go warm no-op at `17.452 ms`.

## Decision Log

| Area                                  | Status          | Evidence                                                                                                                                                                    | Next action                                                                                                                                             |
| ------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parsed source and body-only reparses  | Keep            | Moved semantic dependency edits from ~405 ms to ~343-345 ms.                                                                                                                | Preserve this cache path while changing module graph internals.                                                                                         |
| Annotation and final-prune cleanup    | Keep            | Best stable measured run, ~303-306 ms semantic dependency edit.                                                                                                             | Treat this as the current local-optimization baseline.                                                                                                  |
| Validation-feature gating             | Stop            | Regressed/noisy at ~329-332 ms with no clear trace win.                                                                                                                     | Do not revive without a new trace showing validation feature checks dominate.                                                                           |
| Reference qualification micro-passes  | Stop for now    | Subphase traces improved, but end-to-end runs stayed around ~362-376 ms.                                                                                                    | Stop local scan/allocation work unless a future trace isolates one specific hot allocation.                                                             |
| Per-declaration qualification reuse   | Stop for now    | Correct and covered by tests, but semantic dependency edit remains ~362 ms because the linked program is rebuilt.                                                           | Move to interface-stable relinking or incremental check reuse instead of deeper local caches.                                                           |
| Reference summary reuse               | Keep as support | Content-addressed declaration summaries cut repeated prune reference work in traces, but wall time remains ~396 ms in a noisy run.                                          | Keep the correctness-covered cache, but do not spend another pass on pruning unless it reappears as the top trace cost.                                 |
| Debug optimizer no-op work            | Keep            | Debug optimizer clone/scope was pure overhead for ordinary debug compiles; semantic edit backend time fell from ~74 ms to ~59 ms.                                           | Keep; next backend gains need layout/lowering reuse rather than optimizer clone removal.                                                                |
| Checker preflight scans               | Keep            | Semantic dependency edit fell from ~360 ms to ~341 ms; check time fell from ~107 ms to ~92 ms.                                                                              | Keep; further checker gains should come from fewer whole-program transforms, not another validation micro-pass.                                         |
| Import resolver repetition            | Keep            | Semantic dependency edit fell from ~341 ms to ~324 ms; repeated imports no longer rerun specifier resolution in a compile pass.                                             | Keep; deeper import gains still need interface-stable relinking, because import time remains around ~162 ms.                                            |
| Attached-member rewrite passes        | Keep            | Semantic dependency edit fell from ~324 ms to the ~238-245 ms range; the no-member case now returns before five rewrite walks.                                              | Keep; continue looking for whole-program passes that can be skipped from already-known structural facts.                                                |
| Standalone feature gates              | Stop            | The collection-literal gate measured around ~244 ms, inside the same range as the attached-member baseline.                                                                 | Only revive feature gates if they reuse an existing preflight summary instead of adding another full-program scan.                                      |
| Shared feature-summary gates          | Stop            | Reusing the preflight scan for several absence gates measured ~287-288 ms in repeated runs.                                                                                 | Do not spend another pass on absence gates; the benchmark syntax actually uses collections and operator chains.                                         |
| Collection lookup memoization         | Stop            | Lookup memoization measured ~273-274 ms in noisy runs and did not reduce the traced collection lowering phase.                                                              | Further collection gains need a different lowering shape, not cached type helper lookups.                                                               |
| Wasm function encoding                | Keep            | `wasm_encode_ms` fell from roughly ~24 ms to ~12 ms; wall semantic edit measured ~252-268 ms in repeated runs.                                                              | Keep; remaining backend-side wins need layout/lowering reuse because encoding is no longer the backend bottleneck.                                      |
| Import closure plan reuse             | Stop            | A body-stable alias closure plan cache measured ~260 ms in two repeated 5-sample runs, with import still around ~144 ms.                                                    | Do not pursue name-plan caches; the real cost is still rebuilding/qualifying linked module declarations.                                                |
| Wasm debug name section               | Keep as support | `wasm_encode_ms` fell to ~8-9 ms, but semantic edit wall time stayed noisy at ~268-284 ms because import/check dominate.                                                    | Keep the small cache, but do not spend another pass on Wasm encoding until import/check are much lower.                                                 |
| Split-declaration caching             | Stop            | Caching split local/transitive declarations measured ~390 ms, with import up to ~209 ms.                                                                                    | Do not add weak-map micro-caches in the import hot path without a trace showing repeated split scans dominate.                                          |
| Fragment parser line maps             | Stop            | Fragment line-map narrowing measured ~271 ms then ~301 ms, with no stable wall or import win.                                                                               | Parser fragment setup is not the current bottleneck; focus on relinking/check invalidation.                                                             |
| Source-key hashing                    | Stop            | Caching source content hashes measured ~294 ms for semantic edits even though trivial leaf edits got faster.                                                                | Semantic invalidation is dominated by relinking/checking, not source-key hash computation.                                                              |
| Checker declaration transforms        | Keep as support | Declaration identity caches lowered `check_ms` to ~55-60 ms, but semantic edit wall time stayed ~271-277 ms.                                                                | Keep; further check wins need fewer whole-program phases or an incremental checked program shape.                                                       |
| Merge metadata finalization           | Keep            | Replacing recursive `hideAstMetadata` after module merge with shallow program metadata preservation moved semantic edits to ~144-148 ms.                                    | Keep; next gains are in whole-program check and backend layout/lowering, not import metadata walking.                                                   |
| Backend flatten-type memoization      | Stop            | A per-layout flatten cache measured ~149 ms, inside the existing band, with no meaningful backend reduction.                                                                | Do not add broad backend memo maps unless a trace identifies a repeated pure computation above the noise floor.                                         |
| Checker declaration micro-caches      | Stop            | Preflight identity caching measured ~142 ms then ~164 ms; builtin operator identity caching regressed to ~172 ms.                                                           | Stop adding WeakSet skips around small checker walks; move to fewer whole-program phases or checked-program reuse.                                      |
| Backend projection reuse              | Stop            | Reusing `checked.runtimeProgram` avoided a duplicate runtime-program filter but measured ~145 ms, inside the baseline band.                                                 | Do not keep public/backend options for tiny duplicated filters unless they remove a traced blocker.                                                     |
| Annotation validation memoization     | Stop            | Successful nested-annotation memoization measured ~162 ms then ~200 ms, with check/backend both worse.                                                                      | Stop local checker memoization; the next checker win needs a different incremental checked-program shape.                                               |
| Contract validation fusion            | Stop            | Folding rewrite misuse checks into preflight measured ~163-166 ms and increased check time.                                                                                 | Do not add more work to the normal preflight pass; it is already on the hot path.                                                                       |
| Backend call-graph micro-caching      | Stop            | Called-function WeakMap caching measured ~152 ms once, then ~182 ms with backend layout up to ~34 ms.                                                                       | Do not cache tiny backend graph walks by object identity; backend needs a coarser reusable layout artifact.                                             |
| Module interface keys                 | Keep as support | Body-only function/const edits now produce the same module interface key while signature/type edits change it; source-id telemetry reports stable body-edit interfaces.     | Already used by pruned-selection reuse; next use should drive interface-stable relinking or checked-program reuse.                                      |
| Interface-key name caches             | Stop            | Name-only cache keys measured ~143 ms once, then ~158 ms, with import still around ~24-25 ms.                                                                               | Do not spend another pass on import name caches; the remaining gap is check/backend and structural module duplication.                                  |
| Product-constructor lowering          | Keep            | Repeated runs measured ~125 ms and ~140 ms, down from the prior ~144-160 ms band, with check/backend both lower.                                                            | Keep identity-preserving transforms; look for the same always-clone pattern in other checker/backend passes.                                            |
| Product-constructor declaration cache | Stop            | Per-declaration WeakMap skip measured ~147 ms with check/backend worse than the kept identity-only pass.                                                                    | Do not add a separate declaration skip for this pass; the identity-preserving rewrite is the useful part.                                               |
| Backend declaration setup             | Stop            | One-pass runtime/layout/function/intrinsic collection measured ~148 ms with backend still around ~51 ms and layout around ~27 ms.                                           | Do not pursue backend setup scan fusion; backend gains need reusable planning/lowering artifacts, not fewer filters.                                    |
| Backend layout artifact cache         | Stop            | Layout-environment reuse measured ~143 ms, inside the existing band, with backend layout still around ~26 ms.                                                               | Stop backend layout micro-artifacts for now; pursue checked-program reuse or a larger backend lowering artifact only.                                   |
| Checker preflight diagnostic caches   | Stop            | Per-declaration preflight diagnostic caching measured ~136 ms after a fresh ~113 ms baseline.                                                                               | Do not add hash-keyed diagnostic caches around fused preflight; checked-program reuse must skip phases, not memo them.                                  |
| Parser body-edit micro-patching       | Stop            | Same-width numeric literal AST patching measured ~151 ms and regressed check/backend too.                                                                                   | Do not patch parsed ASTs by scanning cloned functions; parser gains need direct node indexes or broader module reuse.                                   |
| Backend function hash caching         | Stop            | Backend lower fell to ~7 ms, but semantic edit wall time regressed to ~157 ms with check around ~77 ms.                                                                     | Do not keep phase-only backend hash wins; only revisit with a benchmark that proves end-to-end wall-time movement.                                      |
| Preflight identity skips              | Stop            | WeakSet-skipping already-valid declarations measured ~127 ms once, then ~139 ms in the focused 15-sample harness.                                                           | Do not keep identity-only preflight skips unless they are part of a larger checked-module reuse artifact.                                               |
| Qualified local import keying         | Keep            | Focused 15-sample runs measured ~123 ms and ~121 ms, down from the ~135 ms focused baseline.                                                                                | Keep source-key based local qualification keys; continue looking for safe keying that avoids hashing without stale bodies.                              |
| Source-key name-key shortcuts         | Stop            | Using source keys as stand-ins for imported/local name sets made the benchmark compile fail with missing qualified types.                                                   | Do not replace name-set cache keys unless the key also proves the exact exported/imported name surface.                                                 |
| Inferred specialization allocation    | Keep            | Focused 15-sample runs measured ~135 ms, ~137 ms, and ~134 ms, down from the revalidated ~148-153 ms plateau.                                                               | Continue looking for always-clone checker/backend passes; keep the gate at repeated focused wall-time improvement.                                      |
| Inferred type-var predicate scans     | Keep as support | Focused runs measured ~135 ms, ~131 ms, and ~124 ms; trace shows no-op inferred specialization phases #2/#3 down from multi-ms to ~0.2 ms.                                  | Keep as support, but count the wall-time band as noisy; next work should avoid another narrow predicate cache unless a trace isolates it.               |
| Contract-work preflight gates         | Stop            | One focused run measured ~107 ms, but repeated runs after correctness tightening and backout measured ~133 ms and ~130 ms; trace showed no durable phase win.               | Do not add standalone contract absence scans; only skip this work from a broader pre-existing summary or checked-module reuse artifact.                 |
| Function-check cache hit cloning      | Stop            | Avoiding params/locals/effects cloning on cache hits measured ~139 ms and made downstream time worse.                                                                       | Keep cache-hit cloning unless a broader immutable checked-module representation removes the mutation risk and proves wall-time movement.                |
| Parser body-edit metadata shifting    | Keep            | Focused 15-sample runs measured ~122 ms and ~120 ms, down from the active ~130-133 ms band.                                                                                 | Keep top-level-only shifting for unchanged declarations; deeper parser gains need better fragment indexing, not subtree metadata walks.                 |
| Builtin operator lowering             | Keep support    | Corrected focused 15-sample runs measured ~122 ms and ~112 ms after restoring custom binary operator lowering; earlier ~107-108 ms runs were not valid.                     | Keep the builtin-only declaration cache as covered support, but do not continue local operator micro-caches without a trace showing a real bottleneck.  |
| Fixed-array planning memoization      | Stop            | Focused 15-sample runs measured ~116 ms then ~126 ms, with backend layout still ~22-25 ms.                                                                                  | Stop backend layout micro-memos; move to a coarser artifact or a different phase with fresh trace evidence.                                             |
| Type-contract validation cache        | Keep support    | Focused 15-sample runs measured ~105 ms and ~102 ms initially, but later isolated revalidation measured ~120 ms.                                                            | Keep as covered support for now, but do not keep pursuing type-contract cache-key micro-tuning without a trace showing key construction dominates.      |
| Import identity micro-cache           | Stop            | Focused 15-sample runs measured ~116 ms then ~114 ms after adding a WeakMap for imported declaration identity keys.                                                         | Do not cache tiny import identity strings; target larger import qualification or backend assembly artifacts instead.                                    |
| Type-contract environment key         | Stop            | Switching the cache environment key from evaluated const values to const declaration semantic hashes measured ~131 ms.                                                      | Keep the evaluated const-value key; do not change cache-key shape without a trace showing key construction dominates.                                   |
| Fixed-array layout absence gates      | Stop            | Backend signature gates for skipping fixed-array layout work measured ~156 ms and ~171 ms, regressing every major phase even when empty plan-map cache shape was preserved. | Do not add absence gates around backend layout unless the feature summary is already available for free and the focused harness proves wall movement.   |
| Cache telemetry harness               | Keep support    | `--cache-stats` shows semantic leaf edits hit function-check, type-contract, and backend-function caches about 2282 times with about 2 misses.                              | Stop trying to improve hit rate for this benchmark; target setup costs that still run despite high hit rates, or checked/backend module artifact reuse. |
| Memory ABI cleanup planning           | Stop            | Precomputing public/import memory-ABI decisions measured ~92-94 ms against an active ~90-91 ms band.                                                                        | Do not pursue backend cleanup micro-fusion; larger backend wins need reusable layout/lowering artifacts or less module setup.                           |
| Type-casing identity caches           | Stop            | Successful declaration identity skips measured ~88 ms once, then ~92 ms with backend/import cost higher.                                                                    | Do not add checker identity caches around validation scans; move to checked-module reuse or skip whole phases by artifact boundary.                     |
| Source-id pruned-selection reuse      | Keep            | Repeated focused 15-sample runs measured `72.710 ms` and `72.978 ms`; cache stats show pruned-selection hits `19 / 0`.                                                      | Keep; do not add narrower prune caches. The next win should reuse checked/imported/backend artifacts by the same stable source/interface boundary.      |
| Import closure selection reuse        | Stop            | Rehydrating alias closure selections hit `27 / 0`, but import rose to `~22 ms` and wall time regressed to `79.060 ms`.                                                      | Do not lift the same selection-only idea to more import helpers; it needs a larger checked/imported/backend artifact boundary to pay off.               |
| Tail scalar-fact body analysis        | Keep support    | Passing the backend cache into tail scalar-fact inference lowered backend layout in focused runs; wall time measured `70.096 ms`, `74.765 ms`, and `69.714 ms`.             | Keep the missing cache plumbing, but continue with larger backend/check artifacts rather than another narrow body-analysis cache.                       |
| Parsed annotation type cache          | Keep            | Repeated focused 15-sample runs measured `65.715 ms` and `67.932 ms`; check time dropped to roughly `20 ms`.                                                                | Keep the bounded parser-result cache. The next local keep bar is now `~63-64 ms`; otherwise move to checked/imported/backend artifact reuse.           |
| Annotation type-call list cache       | Stop            | Caching derived type-call lists measured `66.981 ms` and did not lower check time below the parsed annotation cache plateau.                                                | Do not add another local annotation walker cache unless a fresh trace shows annotation traversal itself above the noise floor.                          |
| Closure descriptor body-analysis cache | Stop           | Reusing backend direct-call lists for closure descriptor collection lowered backend layout once but regressed focused wall time to `67.553 ms`.                              | Do not add more backend body-analysis cache plumbing unless the same run beats the wall-time keep bar.                                                   |
| Redundant import metadata hiding      | Keep support    | Focused runs measured `64.609 ms` and `65.182 ms`; import dropped to `~14-15 ms` after removing a second recursive metadata-hide walk.                                      | Keep; next local keep bar is now `~61-62 ms`. Further gains should skip larger linked/check/backend artifacts, not polish metadata hiding.             |
| Linked materialization no-clone       | Stop            | Returning cached linked programs directly measured `62.633 ms` once, then `64.377 ms` on repeat, with import still `~14-15 ms`.                                             | Backed out. The result did not repeatedly beat the `~61-62 ms` keep bar, and linked-module hits are too sparse for this shortcut to matter here.       |
| Profile-hook zero-overhead guard      | Stop            | Removing no-trace wrapper calls measured `71.275 ms` then `69.343 ms`; after backout the focused harness returned to `65.083 ms`.                                           | Keep the simple profile-hook shape; do not chase profiling wrapper overhead without lower-level JS evidence and a repeated wall-time win.               |
| Current Fig-vs-Go comparison          | Harness note    | Fig semantic edit measured `67.895 ms`; Go semantic edit measured `66.218 ms`; Go warm no-op measured `17.452 ms` in the same 10-sample harness.                            | Stop helper-level tuning for semantic edits unless it can beat `~61-62 ms`; next meaningful work is checked/backend artifact reuse or no-op skipping.  |
| Backend planning artifact cache       | Keep            | Caches return-projection, closure-descriptor, and fixed-array planning by layout-relevant function body shape while ignoring literal values. Focused runs measured `69.982 ms` and `70.536 ms` with cache stats; a same-run Fig-vs-Go comparison measured Fig `61.678 ms` and Go `76.678 ms`. | Keep the artifact boundary and correctness tests. It removes a traced backend-layout blocker, even though absolute wall time remains environment-sensitive near the current plateau. |
| Stable linked-module rehydration      | Stop            | Rehydrating linked modules across dependency body-only edits passed a targeted stale-output test, but focused wall time regressed to `266.493 ms` and `281.876 ms` with cache stats. Trace showed `import.merge.module` at `554.741 ms` total and `import.qualify.imports` at `245.254 ms` total over 3 samples. | Backed out. Do not retry linked-module body-stable reuse unless the design skips qualification/merge work rather than rebuilding it under a new cache key. |
| Post-stable-link-backout revalidation | Baseline        | Focused semantic dependency edit returned to `65.234 ms`; the cache-stats repeat measured `65.182 ms`, with import around `13 ms`, check around `26-27 ms`, backend around `16-19 ms`, and Wasm encode around `7 ms`. | This is the current stable evaluation point. Further work should be structural checked/backend artifact reuse or benchmark broadening, not another import helper cache. |
| Corrected temporary benchmark harness | Keep support    | The benchmark now writes generated Fig/Go projects, Go caches, and outputs under a fresh `/tmp/fig-large-compile-*` run directory, disables Go VCS stamping, and measures edit indices after warmup. Corrected focused Fig runs measured `60.094 ms`, `56.592 ms` with cache stats, and `61.892 ms` in trace mode. A corrected same-run comparison measured Fig semantic edit `63.911 ms`, Go warm no-op `16.994 ms`, and Go semantic edit `341.895 ms`. | Use this as the stable speed checkpoint. Older Go semantic-edit rows from the persistent in-repo cache are not trustworthy for target-setting. |
| Tracked large benchmark checkpoint    | Baseline        | `tmp/large_compile_bench/README.md`, `generate.ts`, and `run.ts` are now unignored/tracked candidates. A fresh focused 15-sample run measured Fig semantic edit `62.387 ms`; a 5-sample Fig-vs-Go run measured Fig `69.526 ms`, Go warm no-op `17.082 ms`, and Go semantic edit `357.510 ms`. | Continue from this checkpoint. Generated projects/caches stay ignored; future agents can reproduce the large benchmark source without relying on local ignored files. |
| Large benchmark task/check coverage   | Keep support    | Added `deno task bench:large-compile` and included the tracked large benchmark source in `deno task check`. A session no-op run measured root edit `0.968 ms`, leaf comment edit `0.502 ms`, and semantic leaf edit `57.203 ms`; the task form measured `60.223 ms` with 7 samples and 3 warmups. | Use this as the stable maintenance point before more compiler changes. The remaining Go advantage in this harness is warm no-op process/build overhead, not semantic dependency edits. |
| Direct code-section body assembly     | Stop            | Replacing the final code-section `encodedFunctions.map((fn) => fn.bytes)` with a direct writer measured `56.443 ms` without telemetry and `55.816 ms` with `--cache-stats`; Wasm encode was `5.473-5.872 ms`. | Backed out. This only improves a small Wasm assembly detail and does not beat the wall-time gate; do not continue Wasm section micro-tuning without a broader artifact boundary. |
| Checked-program candidate telemetry   | Keep support    | Added opt-in `checked_program_hits/misses` counters and a stale-output regression test. Focused `--cache-stats` measured Fig semantic edit `54.520 ms`, `checked_program_hits=1`, `checked_program_misses=0`; a normal no-stats run measured `49.123 ms`. | Keep as evidence for the next structural pass. The key shape survives dependency body edits, but no checked artifact is reused yet. |
| Checked-program direct-reuse audit    | Stop for now    | A fresh 7-sample trace measured `checkPrimitiveDecls` plus `checkDotQualifiedTypeMemberSyntax` at only about `0.35-0.4 ms` per rebuild, while body-sensitive phases such as `checkTypeFunctionCasing`, `lowerProductConstructors`, and contract/type checks remain several milliseconds combined. | Do not add a direct whole-checked-program cache or a local signature-only cache. The checker needs an explicit reusable signature/type setup artifact plus current-body validation. |
| Function-check environment-key split  | Keep support    | Added trace-only `check.checkFn.environment_key` and `check.checkFn.cache` events. A 7-sample trace measured the environment key at `0.696 ms` total, about `0.099 ms` per rebuild; repeated normal focused runs measured `73.757 ms` during a noisy run and then `49.575 ms` on repeat. | Keep the trace split, but do not cache this key. It is too small; further checker gains need to avoid per-function cache-hit restoration or split the checker artifact. |

Go comparison on the same temporary project:

| Case                                       |      Time |
| ------------------------------------------ | --------: |
| `go build` after dependency semantic edit  | ~73-77 ms |
| `go build` latest dependency semantic edit |    ~65 ms |
| `go build` post-ABI-backout semantic edit  |    ~67 ms |
| `go build` latest semantic edit            |    ~65 ms |
| `go build` latest recheck                  |    ~72 ms |
| `go build` current semantic edit           | 66.218 ms |
| `go build` current warm no-op              | 17.452 ms |
| `go build` post-branch-cache semantic edit | 64.395 ms |
| `go build` post-branch-cache warm no-op    | 19.184 ms |
| `go build` corrected-harness semantic edit | 341.895 ms |
| `go build` corrected-harness warm no-op    | 16.994 ms |
| `go build` tracked-harness semantic edit   | 357.510 ms |
| `go build` tracked-harness warm no-op      | 17.082 ms |

## Current Bottlenecks

- Import relinking and namespace qualification are no longer the largest semantic dependency edit
  cost after removing recursive metadata hiding from module merge.
- Checker whole-program transforms are still measurable even when most declarations are unchanged,
  but parsed annotation type caching moved focused normal check time down to roughly `~20 ms`.
- Backend layout, lowering, cleanup, and Wasm encoding together remain around `~28-29 ms` in recent
  focused runs; no individual backend subphase is large enough to justify another helper cache.
- Latest cache telemetry shows the semantic leaf edit already gets about 2282 function-check hits,
  2282 type-contract hits, and 2282 backend-function hits with only about 2 misses each. The next
  useful pass should reduce setup/relink/layout work that still happens around those hot caches, not
  chase higher hit rates.
- Checked-program candidate telemetry now shows the fully merged checked-program key can hit across
  dependency body edits while current Wasm output still changes. The next checked reuse pass should
  split the artifact so reusable checker setup is separated from current declaration bodies.
- Whole checked AST reuse is unsafe under the current representation because checked declarations
  contain lowered/current function bodies. A body-stable checker artifact must store body-independent
  type/signature setup separately from any body-mutating transforms.
- Function-check environment-key construction is not a bottleneck after signature-hash caching; the
  remaining `checkFn loop` cost is mostly walking/restoring cached function declarations.
- A standalone scan skip did not improve the benchmark. The next skip should reuse already-collected
  feature information or target the import graph shape.
- Allocation cleanup inside reference qualification helps traced subphases, but it does not move the
  end-to-end benchmark enough to count as a strategic gain.
- Per-declaration qualification reuse reduces repeated work after body-only edits, but the compiler
  still rebuilds and rechecks the linked whole-program shape.
- Source-backed reference summary reuse makes pruning cheaper after body-only edits, but the
  dominant cost has shifted back to repeated module merges, qualification, and whole-program
  check/backend passes.
- Debug backend optimization no longer clones/scopes the whole program unless profile expressions
  need erasing.
- Early checker syntax/debug validation now uses one normal-compile preflight walk, and the legacy
  no-op borrow-restriction scan has been removed.
- Repeated imports now reuse resolver results inside a compile pass, but linked module bodies still
  rebuild when a dependency body changes.
- Attached-member rewrites now return immediately when no attached members exist, removing repeated
  no-op program walks from the common case.
- Two follow-up local checker attempts did not clear the keep threshold: shared preflight gates and
  collection lookup memoization. The next pass should avoid checker micro-caches unless a trace
  isolates a new dominant subphase.
- Wasm function body encoding now reuses unchanged cached backend functions, and debug name sections
  are reused when function/local names are unchanged. Full module section assembly still rebuilds.
- A body-stable import closure plan cache did not move import time enough to keep; avoid another
  cache that only remembers selected names while still rebuilding declarations.
- Split-declaration and fragment parser micro-caches did not move the benchmark; the next import
  attempt needs to avoid rebuilding linked declarations rather than speeding up helper scans.
- Source-key hash caching helped no-op dependency edits but regressed semantic edits; do not chase
  cache-key hashing until relinking is structurally cheaper.
- Declaration transform identity caches help checker time, but they do not solve the main wall-time
  bottleneck because import relinking still rebuilds the linked program.
- Module merge now preserves only the new program object's metadata instead of recursively walking
  every imported declaration to hide metadata that was already hidden by parsing or qualification.
  This cuts import time from roughly ~155 ms to ~23-24 ms on the semantic dependency edit benchmark.
- Follow-up backend/checker micro-caches after the metadata win did not produce stable wall-time
  gains. The next real movement likely needs checked-program reuse or a backend layout/lowering
  cache with a stronger invalidation key than per-pass WeakSet skips.
- Two more local attempts after that also stopped: reusing the checker's runtime program in backend
  layout stayed inside noise, and memoizing successful annotation instantiation regressed repeated
  runs. Treat local backend/check micro-caches as exhausted until the compiler has a structural
  reuse plan.
- Moving rewrite misuse validation into preflight also regressed. The preflight pass should stay
  narrow; structural checker gains need to avoid whole-program checking rather than moving more
  checks into the first traversal.
- Backend called-function caching also regressed. Avoid object-identity micro-caches in backend
  layout; the next backend attempt should cache or reuse a whole layout/planning artifact with an
  explicit invalidation key.
- Module interface keys now exist and are stored in the compile cache. They are used for
  source-id-level pruned-selection reuse, but not yet for checked-module or backend-module reuse.
- Backend micro-artifact caches are plateauing again. Whole fixed-array planning and layout-hash
  reuse stayed inside the `~79 ms` band after backend function hash reuse, so backend work should
  resume only with a larger lowering/layout bundle or new trace evidence.
- A follow-up attempt to apply interface keys only to name caches did not move the benchmark. This
  reinforces that import name collection is no longer the useful target; interface keys should only
  come back when they skip checking or backend work without reusing stale dependency bodies.
- Product constructor lowering no longer rebuilds every expression tree unconditionally. This is a
  kept pass because it reduces allocation in check and keeps unchanged checked declarations more
  stable for backend caches.
- Adding a second declaration-level skip to product-constructor lowering regressed. The useful
  pattern is preserving identity while walking, not adding another WeakMap lookup around this pass.
- The earlier full-reference pruned-selection cache was stopped, but the source-id version is kept:
  stable source/interface/reference keys produce useful `19 / 0` pruned-selection hits and rehydrate
  from current declarations after body edits. Future import work should now reuse a larger artifact,
  such as a checked/imported module bundle, not another keep-name cache.
- Checker preflight success caching has also been tried and stopped. Even when it skipped known-good
  declarations, semantic hashing and per-declaration lookup cost kept wall time in the same band.
  Future checker work should reuse a checked module bundle or skip whole-program setup, not add
  another declaration-level success cache.
- Import pruning is mandatory for the benchmark. `--no-prune` lowered import time but pushed
  checking to roughly `~495 ms`. Source-id pruned-selection reuse is the current kept prune win,
  lowering focused import to `~16-17 ms`.
- Source-id interface stability is now measured and used for pruned-selection reuse. The same idea
  has not yet been lifted to linked/import-closure or checked-module artifacts, which is the next
  meaningful structural boundary.
- Imported modules no longer recurse through `hideAstMetadata` a second time after parsing or
  fragment patching. This moved import to roughly `~14-15 ms`; any remaining import work needs to
  skip linked/qualified artifact construction rather than remove metadata overhead.
- Normal `--compile-profile` output now includes checker subphases without enabling checker trace
  mode. A warmed semantic leaf edit sample measured wall `71.141 ms` under profiling overhead, with
  top events `import.qualify.imports` `6.192 ms`, `import.merge.module` `5.500 ms`,
  `check.checkFn loop` `2.823 ms`, `check.checkContracts` `1.872 ms`, and
  `check.checkTypeContracts` `1.209 ms`.
- Normal `--compile-profile` output now also includes backend layout/lower subphases. A warmed
  semantic leaf edit sample measured wall `72.418 ms` under profiling overhead, with
  `backend.layout.fixed_array_plans` `5.606 ms`, `backend.layout.return_projection_plans`
  `4.183 ms`, `backend.layout.closure_descriptors` `1.968 ms`, and
  `backend.lower.environment_key` `0.513 ms`. The stopped fixed-array body-analysis and artifact
  cache attempts mean the next backend pass should be a coarser backend planning artifact, not
  another private-call/dynamic-read memo.
- A return-projection use-cache attempt also stopped. Caching remaining-tail projection summaries
  by original block object and statement index measured `69.600 ms` then `66.119 ms`, so even the
  narrower return-projection path does not justify another backend local cache. Treat backend local
  memoization as exhausted unless a new trace shows a single subphase that can clear the full
  `~61-62 ms` keep bar.
- A profile-hook zero-overhead guard rewrite also stopped. It should have removed no-trace closure
  overhead, but repeated focused runs measured `71.275 ms` and `69.343 ms`; after backing it out,
  the focused harness returned to `65.083 ms`. Keep the simpler profiling wrapper shape unless a
  lower-level JS trace proves the wrapper itself dominates.
- The current Fig-vs-Go same-machine comparison no longer justifies more helper-level JavaScript
  tuning for semantic dependency edits: Fig measured `67.895 ms` and Go measured `66.218 ms` in
  the same 10-sample harness. The remaining clear Go advantage is warm no-op at `17.452 ms`, which
  points to checked/backend artifact reuse and no-op skipping rather than local memoization.
- Module reference-key caching by full source key lowered focused import time to roughly
  `10-11 ms`, because unchanged imported modules no longer recompute their reference graph on every
  semantic dependency edit. Wall time remained `~66-68 ms`, so this is support for import setup
  reuse, not a reason to continue narrower import helper caches.
- Branch-hint validation now skips declarations already validated under the default plugin registry.
  This is the first checker skip after the latest import support pass that cleared the wall keep
  threshold: no-stats focused runs measured `58.608 ms` and `60.442 ms`, with check time down to
  about `18.9 ms`.
- A Wasm vector-section assembly rewrite was tried and backed out. Avoiding the intermediate
  `items.flat()` payload did not reduce Wasm encode time and measured `77.692 ms` in the focused
  harness, so Wasm encoding needs a different representation or broader artifact reuse before it is
  worth revisiting.
- A post-annotation-cache trace run measured `89.154 ms` with trace overhead: import `19.123 ms`,
  check `36.992 ms`, backend `25.282 ms`, and Wasm encode `6.272 ms`. The trace-only checker split
  still shows broad preflight scans at the top because trace mode disables the fused normal
  preflight; use normal focused splits for keep/stop decisions.
- Annotation parsing was a real repeated cost, but caching the derived type-call list was not. Stop
  the annotation local-cache family unless a new trace shows annotation traversal above the noise
  floor.

## Stop Rule

Stop local micro-optimization and switch to a larger design pass when two consecutive measured kept
passes improve `session_leaf_semantic_edit` by less than 5%, or when trace data keeps pointing at
structural relinking/qualification work that cannot be avoided with local caches.

The next local pass should be rejected unless it can plausibly move at least one of these measured
costs:

- Import relinking/qualification: currently ~10-11 ms in recent focused runs.
- Whole-program checking: currently ~17-18 ms in recent focused runs.
- Backend layout/lowering/encoding: currently ~17-18 ms combined in recent focused runs.

Latest detailed focused split after backend unreachable direct traversal:

- Whole-program checking: ~17-18 ms.
- Backend layout/planning: ~3-4 ms.
- Backend lowering: ~5 ms.
- Backend cleanup: ~2.6-2.9 ms.
- Wasm encoding: ~5-5.5 ms.

If a change only improves a subphase while the end-to-end semantic edit stays within noise, record
it as `Stop for now` and do not keep iterating in that area.

The likely larger design is an interface-stable module graph plus checked-program reuse:

- Each module gets an interface key made from public type/function/import signatures, operator
  declarations, public const type information, and exported effects.
- A dependency body edit with the same interface key should reuse checked dependent modules instead
  of rebuilding and validating their full declarations.
- Backend lowering should consume a stable checked module bundle so unchanged functions keep their
  lowered-function and encoded-Wasm cache keys without rebuilding the entire linked AST shape.
- The invalidation key must include plugin registry, memory model, opt mode, profile settings,
  public ABI shape, and any whole-program feature that changes lowering.

## Verification

Before keeping a compile-time optimization pass, run:

```sh
deno task check
deno test --allow-read --allow-write --allow-run tests/compiler_test.ts
deno task test
git diff --check
```
