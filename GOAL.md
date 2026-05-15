The next thing to do should be:

# Fix the repeated-call compile-time scaling cliff with trace-guided checker memoization

The repo has already landed the pieces we previously wanted: import pruning, one-pass artifact compilation, optimization profiles, `OptimizationPlan`, `explainOptimization`, backend layout decisions, plan/WAT consistency tests, and checker phase tracing. So the next step is not another planning layer. It is to use the new tracing to remove the worst remaining compile-time cliff.

## Current state

`BENCHMARK.md` says `range_fold_1k` is fixed: it is now about **11 ms total compile** with `pruneImports: true`, down from the old ~900 ms range-fold issue. The remaining clear compile-time problem is `bench_const_params`: 10 repeated calls compile in ~1.6–2 ms, 100 calls compile in ~137–143 ms, 200 calls compile in ~998–1028 ms, and 500/1000 did not finish within the 180s timeout. 

The repo now has exactly the instrumentation needed to attack this. `CheckTrace` records phase time, function count, generated function count, call expression count, diagnostics, and specialization stats.  The checker now records phases around the repeated specialization/member-resolution pipeline, including `resolveAttachedMemberCalls` and both inferred/const specialization passes.

`bench_const_params.ts` now runs `checkSource(source, { trace: true })` and prints `slowest_check_phase` plus specialization counts like visited calls, generated specializations, cache hits, and cache misses. 

So the next goal is now measurable.

## Goal

Make repeated structural code compile near-linearly.

Concrete target:

```txt
deno run --allow-read scripts/bench_const_params.ts --sizes=10,100,200,500,1000 --iterations=3
```

should complete without timeout, and doubling from 100 to 200 should not grow by ~7x.

I would define success as:

```txt
200 calls: no longer near 1s
500 calls: completes comfortably
1000 calls: completes without timeout
specialization cache stats explain remaining work
```

## Why this is the right next task

`compact_filter_collect` is also a problem: it currently emits about **118 KB WAT** and takes about **793 ms total compile**, and the comparison harness failed because WAT exceeded the 30 KB gate. 

But the repeated-call cliff is more fundamental. It affects direct calls, runtime-dict calls, and const-param calls, so it points to general checker/expression traversal behavior rather than one prelude pipeline. `bench_const_params.ts` generates repeated expressions like:

```fig
map_box(Box {value: 1}).value
mapped(box_functor, Box {value: 1}).value
```

and measures direct, runtime dictionary, and const-param variants. 

Fixing that will improve more programs than just the compact iterator case.

## Plan

### 1. Run the trace and update the benchmark note

Run:

```bash
deno run --allow-read scripts/bench_const_params.ts --sizes=10,100,200 --iterations=3
```

Record for each mode:

```txt
slowest_check_phase
specialization visited/generated/hits/misses
function count
generated function count
call expression count
```

The benchmark script already prints the slowest phase and specialization summary. 

This tells whether the cliff is mostly:

```txt
checkFn loop
specializeConstParamCalls
specializeInferredTypeCalls
resolveAttachedMemberCalls
lowerProductConstructors
```

### 2. Add a reusable check cache context

Right now `checkProgramInternal` orchestrates a lot of repeated whole-program passes. The next step should not be a huge worklist rewrite yet. Start by adding a shared checker cache:

```ts
interface CheckMemo {
  typeMatches: Map<string, boolean>;
  runtimeType: Map<string, string | undefined>;
  exprBindingType: Map<string, string | undefined>;
  staticConstValue: Map<string, ConstValue | undefined>;
  callCheck: Map<string, CallCheckMemo>;
}
```

Thread it through the expensive checker/type functions first, not everywhere.

Start with safe pure caches:

```txt
typeMatches(expected, actual)
runtimeTypePatternMatches(expected, actual)
inferRuntimeType(expr, env signature)
staticConstExprValue(expr, static values signature)
```

These functions are repeatedly asked the same questions in repeated-call programs.

### 3. Add structural keys for repeated pure expressions

For expression-level caching, use conservative keys. Do not cache everything.

A good first key:

```ts
type ExprKey =
  | literal(value, kind)
  | var(name, knownTypeOrConstVersion)
  | call(calleeName, argKeys, expectedType)
  | productConstructor(constructor, slotKeys)
  | field(valueKey, keyKey)
  | binary(op, leftKey, rightKey)
```

Only cache if:

```txt
expression is pure
no placeholder
no effectful capability call
no unresolved generic local
environment key is stable
```

For the benchmark, this should catch hundreds of identical expressions:

```fig
Box {value: 1}
map_box(Box {value: 1}).value
mapped(box_functor, Box {value: 1}).value
```

### 4. Specialization cache stats should become actionable

The trace already records specialization stats.  Use them to decide which path is bad:

If there are many cache misses for the same logical specialization, fix canonical specialization keys.

If there are many cache hits but the pass is still slow, reduce repeated traversal.

If generated function count grows with repeated identical calls, fix specialization reuse.

If generated function count is stable but check time explodes, memoize expression/type checking.

### 5. Add a scaling regression test

Add a test that does not require huge sizes, maybe 50 and 100 calls, and asserts structural outputs rather than exact timing:

```txt
generated specialization count remains constant
checked direct calls scale with source calls only
specialization misses stay small
```

Then keep timing in `bench_const_params.ts`.

Example acceptance:

```txt
100 repeated const-param calls:
  generated mapped__box_functor count == 1
  specializeConstParamCalls cache misses <= small constant
  cache hits grows with repeated calls
```

### 6. Only after that, move to a dirty worklist

Once memoization is in place, the next bigger improvement is replacing this repeated full-pipeline shape:

```txt
resolveAttachedMemberCalls
specializeInferredTypeCalls
resolveAttachedMemberCalls
specializeConstParamCalls
resolveAttachedMemberCalls
specializeInferredTypeCalls
resolveAttachedMemberCalls
specializeConstParamCalls
resolveAttachedMemberCalls
```

with a dirty worklist. The current phase trace makes this visible.

But I would not start with the worklist. Memoization is smaller, safer, and likely enough to prove where the cliff is.

## Deliverable

Make this the next milestone:

```txt
Milestone: repeated-call checker scaling
```

Deliver:

```txt
1. BENCHMARK.md updated with traced bench_const_params results.
2. CheckMemo added for type/runtime/static/call facts.
3. bench_const_params 500 and 1000 no longer time out.
4. Specialization stats show stable generated specialization count.
5. No WAT/runtime regression in memory-model benchmarks.
```

This is the best next step because the repo now has enough explainability infrastructure; the remaining value is turning that into a concrete compile-time scaling fix.
