## Next goal: make optimization **plan-accurate and linearly scalable** 🧭

The previous goals have mostly landed. The repo now has:

1. **Import pruning and one-pass artifact compilation.** `CheckSourceOptions` has `pruneImports`, and `compileArtifactsFromSource()` parses/imports/checks once, then emits WAT and Wasm from the checked program. `explainOptimization()` also exists and merges optimizer decisions with backend layout decisions.

2. **Optimization profiles and an optimization plan model.** `OptimizeProfile`, `OPTIMIZE_PROFILES`, `OptimizationPlan`, `FunctionPlan`, `PlannedAction`, rule IDs, recurrence decisions, inline decisions, and layout candidates are now in `optimize.ts`.

3. **Recurrence analysis and structural lowering are documented and partially implemented.** The semantics docs now explicitly say source-level static `for` is rejected and fixed repetition is expressed with recursive functions over refined domains; recurrence summaries classify finite static, tail-linear, structural, and general recursion. 

4. **The old `range_fold_1k` compile problem is mostly fixed.** The latest benchmark reports `range_fold_1k` at about **11 ms total compile** with `pruneImports: true`, not ~900 ms. 

So the next goal should not be “add plans” or “add pruning.” Those exist. The next goal should be:

> **Make every major optimization decision both explainable and actually used by the transformation pipeline, while fixing the current repeated-call compile-time scaling cliff.**

## Why this is the right next goal

The latest benchmark shows two current pressure points:

* `compact_filter_collect` now emits about **118 KB WAT** and takes about **793 ms total compile**, and the Rust comparison run stopped because it exceeded the comparison harness WAT-size gate: expected `<= 30000B`, got `120331B`. 
* `bench_const_params` shows repeated-call compile scaling is bad: 100 calls are around **137–143 ms**, 200 calls are around **998–1028 ms**, and 500/1000-call runs did not finish within the 180s timeout.

That second point is especially important because the benchmark’s “direct”, “runtime-dict”, and “const-param” variants all scale poorly. So this is not only a const-parameter problem. It is a **general repeated expression / repeated call / checker-specialization scaling problem**.

The checker still runs several whole-program specialization and member-resolution phases in sequence: inferred type specialization, const-param specialization, attached-member resolution, inferred specialization again, const-param specialization again, then more lowering/checking. 

## Goal statement

**Goal:** Fig release compilation should be predictable from the optimization plan and should scale near-linearly for repeated structural code.

Concrete target:

```txt
Same source shape + same facts + same optimization profile
=> same optimization plan
=> same lowering shape
=> no superlinear repeated-call compile cliff
```

## Acceptance criteria

### 1. Plan accuracy

For representative programs, `explainOptimization()` must report the decisions that actually happen in the emitted WAT/Wasm.

Required cases:

```txt
tail recursive scalar loop       -> recurrence.lower.tail_loop
small finite refined recursion   -> recurrence.unfold.finite_static
private pure scalar helper       -> call.inline.private_scalar
domain-proven branch             -> domain.compare.always_true / false
packed fixed array               -> array.layout_packed
local-slot fixed array           -> array.layout_local_slots
scratch fixed array              -> array.layout_scratch
```

The backend already exposes layout decisions via `summarizeBackendLayoutDecisions()`, and `explainOptimization()` merges those into the plan.

### 2. Plan/action mismatch tests

Add tests that fail if the plan says one thing but the output shape says another.

Example:

```txt
plan says recurrence.lower.tail_loop
WAT must contain loop
WAT must not contain recursive call
```

Example:

```txt
plan says call.inline.private_scalar for add
WAT must not contain call $add
```

### 3. Repeated-call compile-time target

For `scripts/bench_const_params.ts`:

```bash
deno run --allow-read scripts/bench_const_params.ts --sizes=10,100,200,500,1000 --iterations=3
```

Target:

```txt
500 calls completes comfortably
1000 calls completes comfortably
no 180s timeout
growth is roughly linear or at least not 7x for doubling from 100 to 200
```

I would not set a strict millisecond target yet. First goal is to remove the timeout and identify the dominant phase.

### 4. Compact filter collect size target

Restore this gate:

```txt
compact_filter_collect WAT <= 30000B
```

or explain through the optimization plan why the generic pipeline cannot currently be collapsed. The current saved local run has ~118 KB WAT, and the comparison harness failed at ~120 KB. 

## Implementation plan

### Step 1: Add a checker phase trace

Add timing and counters around the checker phases in `checkProgramInternal`:

```txt
lowerDoExpressions
groupFunctionClauses
evaluateTypeDecls
evaluateConstDecls
resolveAttachedMemberCalls
specializeInferredTypeCalls #1
specializeConstParamCalls #1
specializeInferredTypeCalls #2
specializeConstParamCalls #2
checkConstDictionaries
checkTypeContracts
lowerResolvedOperators
lowerCollectorLiterals
lowerProductConstructors
checkFn loop
```

For each phase, record:

```txt
ms
function count
generated function count
call expression count
specialization cache hits/misses
diagnostic count
```

This should be exposed through something like:

```ts
compileArtifactsFromSource(source, { trace: true })
```

or a separate:

```ts
compileTraceFromSource(source, options)
```

The benchmark already reports parse/import/check/WAT/Wasm timing from one checked program, so adding checker subphase timing is the natural next layer.

### Step 2: Make the optimization plan authoritative for inlining and recurrence

Right now the plan exists, but the optimizer still builds a plan inside every optimization pass, derives inlineable functions, rewrites, folds abstract facts, and repeats.

Move toward this:

```txt
collect facts once
build plan once
apply planned high-level rewrites
run bounded local cleanup
verify shape
```

Do not try to convert the entire optimizer at once. Start with these two actions because they are already plan-backed:

```txt
inline
recurrence.unfold / recurrence.lower_tail_loop / keep_recursive
```

### Step 3: Fix repeated-call checking with memoized call/type facts

The repeated-call benchmark generates many copies of expressions like:

```fig
map_box(Box {value: 1}).value
mapped(box_functor, Box {value: 1}).value
```

The script is intentionally simple and shows direct, runtime-dict, and const-param forms all scaling badly. 

Add memoization keyed by structural call shape:

```ts
type CallCheckKey = {
  callee: string;
  argShapeKeys: string[];
  expectedType?: string;
  envShapeKey: string;
};
```

Cache:

```txt
inferred return type
resolved callee
specialization target
effect row result
shape/product projection facts
```

This should be conservative: if the call references local variables with different types or mutable/shadowed state, the key changes.

### Step 4: Add specialization cache accounting

The checker already has repeated specialization phases.  The next goal should make specialization visible:

```txt
specializeInferredTypeCalls:
  visited calls
  generated specializations
  cache hits
  cache misses

specializeConstParamCalls:
  visited calls
  generated specializations
  cache hits
  cache misses
```

If the 100→200 call cliff comes from repeated misses or repeated full-program rescans, the trace will show it.

### Step 5: Reduce whole-program repeated scans

After tracing, replace repeated whole-program “scan everything again” phases with a dirty worklist:

```txt
initial dirty set: all root functions
when a generated specialization is added:
  mark only callers / affected functions dirty
when attached member calls are resolved:
  mark only changed functions dirty
stop when dirty set is empty
```

This should be scoped first to specialization/member-resolution phases. Do not rewrite the whole checker yet.

### Step 6: Add structural equivalence tests

Because the project explicitly wants structural optimizations, add tests like:

```fig
fn user_fold_loop(i: i32, end: i32, acc: i32) -> i32 {
  match i < end {
    true => user_fold_loop(i + 1, end, acc + i),
    false => acc,
  }
}
```

and compare it to the prelude/range fold shape.

Both should produce:

```txt
same plan action: recurrence.lower.tail_loop
same WAT property: loop yes, recursive call no
```

The docs already state that prelude helpers are fixtures, but equivalent user-written shapes should get the same representation decision and Wasm shape modulo names. 

## The immediate concrete task

Start with this milestone:

> **Milestone 1: Explain and fix the 100→200 repeated-call compile cliff.**

Deliverables:

1. Add checker subphase timing.
2. Add specialization cache hit/miss counters.
3. Run `bench_const_params` with `10,100,200`.
4. Identify whether the time is in specialization, type checking, lowering, or expression traversal.
5. Add one memoization/worklist fix.
6. Re-run `10,100,200,500`.

Success:

```txt
200-call case no longer takes ~1s.
500-call case completes without timeout.
No benchmark WAT/runtime regression.
```

## Why this is better than adding more optimizations now

The compiler already has many powerful rules. The current risk is that more rules will make behavior less predictable and compile time worse unless the plan and checker scaling are under control.

So the next goal is not “more clever folding.”

It is:

```txt
Make the existing folding/lowering decisions observable,
make them structural,
and make repeated code compile predictably.
```
