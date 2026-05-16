The diagnosis is right: **`range_fold_1k` is paying a broad release optimizer cost to erase one small imported abstraction chain**. The final Wasm is tiny, but the compiler is still doing `structuredClone(program)`, recurrence expansion, multiple `runOptimizePasses`, possible second expansion, tail-recurrence lowering, and another round of passes. `runOptimizePasses` also rebuilds function maps, summaries, optimization plans, and walks declarations each pass.

The plan below is agent-ready and focused on making this path simpler, more direct, and more structural.

# Goal

Reduce `range_fold_1k` compile time by making the optimizer:

```txt
reachable-only
recurrence-first
wrapper-aware
single-plan / worklist-based
```

Target for the specific benchmark:

```txt
range_fold_1k optimize bucket: 4.35 ms -> < 1.5 ms
range_fold_1k total compile:   9.08 ms -> ~4–5 ms
```

Do this without adding `RangeIter`-specific or prelude-specific hacks.

---

# Current problem shape

Source:

```fig
range.RangeIter::fold(range.RangeI32::Iter(seed - seed .. 1000), 0, add)
```

The compiler has to erase:

```txt
imported namespaced module
generic range iterator construction
const function parameter f = add
fold wrapper
fold_loop recurrence
release optimizer passes over the checked program
```

The expensive part is not final lowering or Wasm encoding. In the latest local split, the backend bucket is dominated by optimization:

```txt
backend bucket:
  optimize:        4.352 ms
  layout/planning: 0.125 ms
  lowering:        0.510 ms
  cleanup:         0.018 ms
```

This matches the current optimizer structure: `optimizeProgram` broadly clones the program and may run the whole optimize pass pipeline multiple times. 

---

# PR 1 — Add detailed optimizer tracing

## Purpose

Before changing behavior, expose where the 4.35 ms is going inside `optimizeProgram`.

`src/trace.ts` already has `CompileTraceSink`, `traceSync`, `traceAsync`, and `traceInstant`. Use that instead of adding another trace system. 

## Files

```txt
src/optimize.ts
src/mod.ts
scripts/bench_memory_model.ts
```

## Tasks

Add trace events around:

```txt
opt.clone
opt.scope
opt.expandFiniteStaticRecurrences.initial
opt.pass.0.functionMap
opt.pass.0.forwardingWrappers
opt.pass.0.summaries
opt.pass.0.plan
opt.pass.0.inlineable
opt.pass.0.optimizeDecls
opt.pass.0.foldAbstractFacts
opt.expandFiniteStaticRecurrences.second
opt.lowerTailRecurrenceClauseGroups
opt.rewriteUnusedPrivateParams
opt.applyAssumeRewrites
```

Each trace event should include counters:

```ts
{
  declarations,
  functions,
  generatedFunctions,
  contracts,
  reachableFunctions,
  changedFunctions,
  pass,
}
```

Add `trace` plumbing where missing:

```ts
optimizeProgram(program, { optMode, profile, assumeRewrites, trace })
```

## Acceptance criteria

For `range_fold_1k`, benchmark output can show:

```txt
slowest optimizer phase
number of optimized functions
number of optimizer passes actually run
number of functions touched per pass
```

No behavior changes yet.

---

# PR 2 — Build an optimization scope before optimizing

## Problem

The optimizer currently treats the program broadly. For an imported abstraction like range fold, this is too much. The backend already removes unreachable private functions later, but optimization has already paid the cost.

## Goal

Only optimize functions reachable from current-module runtime roots.

## Files

```txt
src/optimize.ts
src/core_ast.ts maybe no change
tests/compiler_test.ts
```

## Tasks

Add:

```ts
interface OptimizationScope {
  runtimeRoots: Set<string>;
  reachableFunctions: Set<string>;
  reachableDeclarations: Set<string>;
}
```

Build it from:

```txt
public functions of the root/current program
top-level lets/consts reachable from those roots
function calls reachable from those roots
generated specializations reachable from those roots
recursive clause groups reachable from those roots
```

Skip:

```txt
contract declarations
unreachable imported helper functions
unreachable type-only helpers
```

Important: keep all declarations in the returned `Program` for now to avoid behavior changes, but **only run expensive optimizer work on scoped functions**.

Modify these helpers to accept scope:

```ts
functionMap(program, scope?)
functionSummaries(program, functions, recurrences, scope?)
summarizeRecurrences(program, scope?)
buildOptimizationPlan(program, profile, precomputed, scope?)
runOptimizePasses(program, config, scope)
```

In `optimizeDecl`, skip non-scoped functions:

```ts
if (decl.kind === "fn" && !scope.reachableFunctions.has(decl.name)) return decl;
```

## Acceptance criteria

For `range_fold_1k`:

```txt
optimizer touches only main + the reachable specialized/wrapper/fold_loop chain
unreachable imported prelude functions are not summarized/planned/rewritten
WAT/Wasm unchanged
```

Add a test:

```txt
import a module with many unused functions
compile one function using one helper
optimization trace reports only reachable helper chain touched
```

---

# PR 3 — Separate “root public” from “module public”

## Problem

Imported declarations may retain `public: true`. But public in the imported module does not mean exported from the current Wasm module. If optimizer treats imported public functions as non-inlineable, wrapper erasure becomes more expensive.

The docs now emphasize namespace imports and associated names, while imported declarations remain qualified through aliases. 

## Goal

Only root-module `pub fn`s should be considered current-module export roots.

## Files

```txt
src/mod.ts
src/optimize.ts
src/backend.ts
tests/compiler_test.ts
```

## Tasks

During import qualification, mark imported runtime declarations as not current-export roots.

Simplest first version:

```ts
interface FnDecl {
  public: boolean;          // source declaration visibility
  rootPublic?: boolean;     // true only for root module pub functions
  imported?: boolean;
}
```

Or avoid AST change and compute root roots before merge:

```ts
const rootPublicNames = new Set(root.declarations.filter(pub fn).map(name))
```

Then pass that into optimization/backend.

Update inline policy:

```txt
Do not inline root public exports.
Imported/public-but-not-root functions may be inlined if private from current compilation perspective.
```

## Acceptance criteria

For aliased prelude imports:

```txt
range.RangeIter::fold can be treated as inlineable if pure/small/reachable
root pub main is not inlined away as an export
```

No exported ABI regression.

---

# PR 4 — Move recurrence lowering before repeated cleanup passes

## Problem

For range fold, the important structural fact is:

```txt
fold_loop is direct self-tail recursion over scalar state
```

The optimizer should identify and lower/normalize that early, not after several broad passes.

## Files

```txt
src/optimize.ts
tests/compiler_test.ts
```

## Tasks

Restructure `optimizeProgram` from this:

```ts
clone
expand finite recurrences
runOptimizePasses
maybe expand again
runOptimizePasses
maybe lower tail recurrence groups
runOptimizePasses
rewrite unused params
```

to this shape:

```ts
clone
build scope
build recurrence summary once

if finite_static small:
  expand finite recurrences in scoped functions

if tail_linear or large finite_static:
  lowerTailRecurrenceClauseGroups in scoped functions

runOptimizeWorklist / cleanup passes only on dirty scoped functions

rewrite unused params
```

The key change:

```txt
lower tail recurrence groups before broad cleanup
```

so wrapper/loop shape gets simplified earlier.

## Acceptance criteria

For `range_fold_1k`:

```txt
optimization plan includes recurrence.lower.tail_loop for the fold loop
tail recurrence lowering happens before the first full cleanup pass
WAT contains loop
WAT does not contain recursive call
WAT does not contain fold wrapper call
```

---

# PR 5 — Replace repeated full optimize passes with a dirty worklist

## Problem

`release_balanced` allows 4 abstract passes, and the current optimizer may run those passes multiple times. Each pass rebuilds summaries/plans and maps.

## Goal

Run high-level decisions once, then clean up only functions that changed.

## Files

```txt
src/optimize.ts
tests/compiler_test.ts
```

## Tasks

Add:

```ts
interface DirtyOptimizerState {
  functions: Map<string, FnDecl>;
  summaries: Map<string, FunctionSummary>;
  plan: OptimizationPlan;
  dirty: Set<string>;
}
```

Pipeline:

```txt
1. Build function map once.
2. Build recurrence summary once.
3. Build optimization plan once.
4. Seed dirty set with reachable roots.
5. Process dirty functions:
   - inline small pure wrappers
   - fold abstract facts
   - simplify matches
   - simplify products/projections
   - record changed callees/callers as dirty only when needed
6. Stop when dirty set empty or max iterations reached.
```

For first version, keep old `runOptimizePasses` behind a fallback flag:

```ts
useWorklistOptimizer?: boolean
```

Then make it default after tests pass.

## Simpler first implementation

If a full worklist is too much, do this first:

```txt
Build function map/summaries/plan once outside pass loop.
Reuse them for all passes.
Only re-run plan after recurrence expansion or tail-group lowering changed the call graph.
```

This alone should cut overhead.

## Acceptance criteria

For `range_fold_1k`:

```txt
function maps/summaries/plans are not rebuilt 4+ times
optimizer trace shows <= 2 cleanup iterations
optimize bucket drops significantly
WAT/Wasm unchanged
```

---

# PR 6 — Add a structural wrapper-erasure prepass

## Problem

Range fold involves wrapper functions:

```txt
RangeI32::Iter(...)
RangeIter::fold(...)
RangeIter::fold_loop(...)
add
```

The compiler should erase small pure forwarding/wrapper functions before running general abstract optimization.

## Files

```txt
src/optimize.ts
tests/compiler_test.ts
```

## Tasks

Add a prepass:

```ts
inlinePureForwardingWrappers(program, scope, config)
```

It should inline functions that are:

```txt
private/effective-private
pure
non-recursive
small
return scalar or flat product
called from scoped functions
```

This should include wrappers of the form:

```fig
fn fold(iter, init, const f) -> i32 {
  fold_loop(iter.start, iter.end, init, f)
}
```

and constructors of simple product-like range iterators:

```fig
fn RangeI32::Iter(range) -> RangeIter {
  ...
}
```

Do not make it name-based. Match structure only.

## Acceptance criteria

Add a test with a user-written wrapper chain equivalent to range fold:

```fig
fn make_iter(...)
fn fold(...)
fn fold_loop(...)
pub fn main(...) { fold(make_iter(...), 0, add) }
```

Expected:

```txt
same optimization decision as prelude range fold
loop survives
wrappers do not survive as calls
```

This aligns with the existing policy that optimization eligibility should be structural, not tied to prelude names. 

---

# PR 7 — Add a direct “range fold” compile regression benchmark

## Problem

The full benchmark suite is noisy. The range example needs a focused compile benchmark.

## Files

```txt
scripts/bench_range_fold_compile.ts
BENCHMARK.md
```

## Script

Add a small benchmark comparing:

```txt
1. direct hand-written tail loop
2. user-written wrapper fold
3. prelude range fold
4. prelude range fold with release_fast_compile
5. prelude range fold with release_balanced
```

For each, print:

```txt
parse
import
check
optimize
layout
lower
cleanup
wat render
wasm encode
total
WAT bytes
Wasm bytes
loops
recursive calls
function calls
```

## Acceptance criteria

`BENCHMARK.md` tracks:

```txt
direct_loop vs user_wrapper_fold vs prelude_range_fold
```

The target should be:

```txt
prelude_range_fold no more than ~2–3x direct_loop compile time
```

instead of ~6–7x.

---

# PR 8 — Keep `release_fast_compile`, but use it as a fallback profile, not the main fix

The benchmark already shows:

```txt
release_balanced range_fold_1k: optimize 4.352 ms
release_fast_compile:          optimize 2.409 ms
```

So the profile helps, but it does not solve the core issue.

Keep it, document it, but aim to make `release_balanced` cheaper by default through structural optimizer changes.

---

# Detailed target optimizer shape

Current shape:

```txt
optimizeProgram
  structuredClone(program)
  expandFiniteStaticRecurrences
  runOptimizePasses × N
    functionMap
    forwardingWrappers
    functionSummaries
    buildOptimizationPlan
    inlineableFunctions
    optimizeDecl for all decls
    foldAbstractFactsInProgram
  maybe expand
  runOptimizePasses × N
  maybe lower tail groups
  runOptimizePasses × N
  rewriteUnusedPrivateParams
```

Target shape:

```txt
optimizeProgram
  structuredClone(program)
  buildOptimizationScope
  collect functionMap once
  collect recurrences once
  buildOptimizationPlan once

  high-level structural rewrites:
    inline pure forwarding wrappers in scope
    expand tiny finite recurrences in scope
    lower tail recurrence groups in scope

  local cleanup worklist:
    fold constants/domains
    fold matches
    fold product/project
    inline remaining tiny helpers
    rewrite unused private params

  return optimized program
```

---

# Pitfalls to avoid

## 1. Do not special-case `RangeIter`

This must not be:

```ts
if (name.includes("RangeIter")) ...
```

It should be structural:

```txt
pure wrapper
direct self-tail recursion
scalar induction variable
pure accumulator step
const function parameter specialized
```

## 2. Do not globally inline imported public declarations

Only inline functions that are not current-module export roots. Imported public functions are not necessarily current Wasm exports.

## 3. Do not optimize contract declarations as runtime code

Contracts now exist in the AST, and backend already filters them through `runtimeProgramView`.  Keep contracts out of runtime optimization/lowering paths unless collecting rewrite facts.

## 4. Do not sacrifice final shape

For `range_fold_1k`, still require:

```txt
Wasm tiny
one loop
zero recursive calls
no leftover fold/fold_loop calls
```

---

# Suggested agent task list

Give the agent this exact sequence:

```txt
1. Add optimizer phase tracing inside optimizeProgram.
2. Run range_fold_1k and record where optimize time goes.
3. Add OptimizationScope and restrict summaries/plans/optimizeDecl to reachable runtime functions.
4. Separate root-public exports from imported-public declarations for inline decisions.
5. Move lowerTailRecurrenceClauseGroups before repeated cleanup passes.
6. Hoist functionMap/summaries/plan creation out of the pass loop where possible.
7. Add a small pure-wrapper erasure prepass for effective-private functions.
8. Add focused range fold compile benchmark.
9. Update BENCHMARK.md with direct loop vs wrapper fold vs prelude fold.
```

---

# Expected result

After PRs 1–6, `range_fold_1k` should stop paying the broad whole-program release optimizer cost. It should compile more like:

```txt
parse/import/check
specialize add
erase RangeI32::Iter / RangeIter::fold wrapper
recognize/lower fold_loop recurrence
run small cleanup over main + fold_loop chain
emit Wasm
```

The final compiled code should stay the same, but the path to get there should be much shorter.

