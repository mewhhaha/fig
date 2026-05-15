Yes. The next step should be to make optimization/lowering **plan-driven**.

Right now Fig has many good optimization pieces: finite recurrence expansion, abstract value folding, inlining budgets, refined-domain reasoning, backend tail-loop lowering, fixed-array representation planning, WAT-shape benchmark gates, and late backend reachability. But the decisions are spread across checker, optimizer, and backend. That makes results harder to predict and compile-time regressions easier to introduce. The optimizer currently expands finite static recurrences, runs repeated optimization passes, folds abstract facts, and then the backend separately chooses tail-loop/backend lowering and fixed-array plans.

The goal should be:

```txt
Same source shape + same facts + same profile
= same optimization plan
= same lowering shape
= explainable result
```

## 1. Add an explicit optimization profile

Create one place for all thresholds and policy choices:

```ts
export type OptimizeProfileName =
  | "debug"
  | "release_size"
  | "release_speed"
  | "release_balanced";

export interface OptimizeProfile {
  name: OptimizeProfileName;

  inline: {
    scalarBudget: number;
    productBudget: number;
    generatedMultiplier: number;
    allowPublicWrapperInlining: boolean;
  };

  recurrence: {
    unfoldMaxCardinality: number;
    unfoldMaxAstGrowth: number;
    loopLowerMinCardinality: number;
    allowNonTailFiniteUnfold: boolean;
  };

  layout: {
    inlineArrayFlatMaxSlots: number;
    packedBitMaxWidth: number;
    scratchMinSlots: number;
    preferPackedWhenDynamic: boolean;
  };

  abstract: {
    maxPasses: number;
    maxLocalEqualityCandidates: number;
  };
}
```

Then replace scattered constants like:

```ts
const INLINE_COST_BUDGET = 18;
const PRODUCT_INLINE_COST_BUDGET = 12;
const OPTIMIZE_PASSES = 4;
const LOCAL_EQUALITY_CANDIDATE_LIMIT = 64;
```

with profile fields. Those constants currently live in `optimize.ts`, and the optimizer uses them to control recurrence expansion, repeated passes, and local rewrites. 

This makes behavior predictable because every threshold is visible and testable.

## 2. Build an `OptimizationPlan` before rewriting

Before mutating the program, generate a plan:

```ts
export interface OptimizationPlan {
  functions: Map<string, FunctionPlan>;
  decisions: OptimizationDecision[];
}

export interface FunctionPlan {
  name: string;
  summary: FunctionSummary;
  recurrence?: Recurrence;
  representation?: RepresentationPlan;
  actions: PlannedAction[];
}

export type PlannedAction =
  | { kind: "inline"; target: string; reason: string }
  | { kind: "unfold_recurrence"; recurrence: string; cardinality: number }
  | { kind: "lower_tail_loop"; recurrence: string }
  | { kind: "keep_recursive"; recurrence: string; reason: string }
  | { kind: "fold_domain_branch"; reason: string }
  | { kind: "choose_layout"; layout: "flat" | "packed" | "scratch" | "local_slots"; reason: string }
  | { kind: "drop_unreachable"; name: string; reason: string };

export interface OptimizationDecision {
  pass: string;
  target: string;
  action: string;
  reason: string;
  evidence?: Record<string, unknown>;
  beforeCost?: number;
  afterCost?: number;
}
```

Then rewriting consumes the plan instead of rediscovering decisions pass-by-pass.

This matters because Fig already has summaries and recurrence analysis: `FunctionSummary`, `Recurrence`, `DomainMeasure`, `AbstractValue`, and `summarizeRecurrences` exist. Use those as the source of truth for planning. 

## 3. Separate facts from transformations

The current optimizer mixes “learn facts” and “rewrite code.” Make those separate.

Recommended order:

```txt
1. collect facts
2. build plan
3. apply plan
4. run local cleanup
5. verify shape invariants
```

Facts should include:

```ts
interface FunctionFacts {
  typeFacts: Map<string, string>;
  domainFacts: Map<string, RefinedI32Domain>;
  constFacts: Map<string, Expr>;
  effectClass: "pure" | "read_only" | "state" | "volatile" | "host";
  recurrence?: Recurrence;
  callCount: number;
  astCost: number;
  estimatedWasmCost: number;
  layoutCandidates: Map<string, LayoutCandidate[]>;
}
```

This also helps debugging. If a fold does not happen, the answer should be:

```txt
not folded because:
  recurrence cardinality = 1000
  unfoldMaxCardinality = 18
  recurrence is tail_linear
  chosen action = lower_tail_loop
```

not “some pass did or did not rewrite it.”

## 4. Make recurrence lowering a decision table

This should be deterministic.

```txt
Recurrence kind             Condition                         Action
-------------------------  --------------------------------  -------------------------
finite_static               cardinality <= unfold budget      unfold
finite_static + tail calls   cardinality > unfold budget       lower_tail_loop
tail_linear                  all recursive calls tail          lower_tail_loop
structural                   known finite value                unfold if within budget
structural                   unknown value                     keep recursion
general_recursive            pure + tiny finite domain         unfold if within budget
general_recursive            otherwise                        keep recursion
```

In code:

```ts
function chooseRecurrenceAction(
  recurrence: Recurrence,
  profile: OptimizeProfile,
): PlannedAction {
  const c = recurrence.measure?.cardinality;

  if (
    recurrence.kind === "finite_static" &&
    c !== undefined &&
    c <= profile.recurrence.unfoldMaxCardinality
  ) {
    return {
      kind: "unfold_recurrence",
      recurrence: recurrence.fn,
      cardinality: c,
    };
  }

  if (
    (recurrence.kind === "finite_static" || recurrence.kind === "tail_linear") &&
    recurrence.recursiveCalls.every((call) => call.tail)
  ) {
    return {
      kind: "lower_tail_loop",
      recurrence: recurrence.fn,
    };
  }

  return {
    kind: "keep_recursive",
    recurrence: recurrence.fn,
    reason: "not finite-small and not tail-linear",
  };
}
```

This is especially important because refined-domain recursion is now in the language. The checker now accepts refined `i32` function clauses, builds domain tests, checks overlap, and checks uncovered calls.

## 5. Make layout lowering a decision table too

For fixed arrays/products, use one policy table:

```txt
Value shape                         Condition                     Layout
----------------------------------  ----------------------------  ----------
small scalar tuple                  slots <= flatMaxSlots          flat locals
narrow scalar array                  bit width known               packed
dynamic indexed fixed array          packed possible               packed
dynamic indexed fixed array          packed impossible, large      scratch/local_slots
fully literal array only projected   projected slots known         materialize used slots only
heap-like object                     branch runtime needed         branch heap
```

The backend already has separate plans for scratch, packed, and local-slot arrays, and chooses them during `analyzeFixedArrayPlans`. 

But this should be surfaced as a plan:

```ts
{
  kind: "choose_layout",
  target: "xs",
  layout: "packed",
  reason: "InlineArray(7, u3), dynamic indexing, total width 21 bits"
}
```

This prevents “why did this become scratch memory?” from becoming guesswork.

## 6. Keep lowering structural, not name-based

This is already the right documented policy: optimize a shape because the source/IR has that structure, not because the callee name belongs to a prelude module. The docs explicitly say prelude helpers may be canonical fixtures, but equivalent user-written shapes should get the same representation decision and Wasm shape. 

So the plan should avoid rules like:

```txt
if function name is RangeIter.fold_loop => optimize
```

Prefer:

```txt
if function is pure direct self-tail recursion over i32 induction var
and recursive call updates i -> i + k
and accumulator update is non-effectful
=> lower_tail_loop
```

That keeps the language predictable.

## 7. Add an optimization trace API

Expose:

```ts
export async function explainOptimization(
  source: string,
  options: CompileSourceOptions,
): Promise<OptimizationPlan>
```

Or after checking:

```ts
export function summarizeOptimizationPlan(
  program: Program,
  profile: OptimizeProfile,
): OptimizationPlan
```

Example output:

```json
{
  "target": "RangeIter.fold_loop",
  "actions": [
    {
      "kind": "lower_tail_loop",
      "reason": "direct self-tail recursion; i increases by 1; guard i < end"
    },
    {
      "kind": "inline",
      "target": "add",
      "reason": "private pure scalar helper; astCost=3 <= scalarBudget=18"
    }
  ]
}
```

The repo already exports analysis-style APIs such as `summarizeProgram`, `summarizeRecurrences`, and `summarizeAbstractValues`.  Add `summarizeOptimizationPlan` alongside those.

## 8. Treat every fold as a named rule

Do not just “optimize expression.” Use rule IDs.

Examples:

```ts
type RewriteRuleId =
  | "const.binary.i32"
  | "domain.compare.always_true"
  | "domain.compare.always_false"
  | "match.constant_scrutinee"
  | "call.inline.private_scalar"
  | "call.inline.generated_const_fn"
  | "recurrence.unfold.finite_static"
  | "recurrence.lower.tail_loop"
  | "array.project.used_slots"
  | "array.pack.narrow_unsigned"
  | "product.project.known_slot"
  | "effect.preserve.unused_call_drop";
```

Each rule should have:

```ts
interface RewriteRule {
  id: RewriteRuleId;
  applies(input: RewriteInput): boolean;
  rewrite(input: RewriteInput): RewriteResult;
  reason(input: RewriteInput): string;
}
```

This gives you predictable behavior and good tests:

```txt
expected rules:
  recurrence.lower.tail_loop
  call.inline.private_scalar
  domain.compare.always_true
```

## 9. Add shape tests for decisions, not just WAT

The benchmark harness already measures WAT shape: calls, loops, recursive calls, SIMD ops, memory refs, fixed-array representations, and forbidden WAT patterns.

Keep those tests, but add plan-level tests before WAT:

```ts
const plan = summarizeOptimizationPlan(checked.program, releaseProfile);

assertDecision(plan, {
  target: "RangeIter.fold_loop",
  kind: "lower_tail_loop",
});

assertDecision(plan, {
  target: "add",
  kind: "inline",
});
```

Then WAT tests verify the final result:

```txt
contains loop
does not contain recursive call
does not contain helper call
```

This makes failures easier to diagnose. If the plan says “lower_tail_loop” but WAT has recursive calls, the backend is wrong. If the plan says “keep_recursive,” the planner is wrong.

## 10. Make pass ordering fixed and minimal

Use a stable pipeline:

```txt
A. normalize
B. early import slice
C. type/check/specialize
D. collect facts
E. build optimization plan
F. apply high-level rewrites
G. local simplification
H. representation planning
I. backend lowering
J. backend cleanup
```

Avoid repeated global passes except for a bounded local cleanup phase. The current optimizer runs up to four optimization passes and folds abstract facts during each pass.  That is acceptable for now, but the long-term predictable version is:

```txt
plan once
rewrite once by plan
cleanup until fixed point with a tiny bounded rule set
```

## Concrete implementation order

1. **Add `OptimizeProfile`.** Move inline budgets, recurrence budgets, pass limits, and local equality limits into one object.

2. **Add `OptimizationPlan`.** Start with recurrence and inlining decisions only.

3. **Emit decisions from existing logic.** Do not rewrite behavior yet. Just record why current behavior would happen.

4. **Add plan tests.** Especially for:

   ```txt
   small finite recurrence -> unfold
   large tail recurrence -> lower_tail_loop
   private scalar helper -> inline
   effectful helper -> do not inline
   refined domain branch -> fold
   ```

5. **Refactor recurrence expansion to consume the plan.** This is the first real behavior change.

6. **Refactor layout planning to expose decisions.** Use backend scratch/packed/local-slot choices as `choose_layout` decisions.

7. **Add `--explain-opt` or API output.** Make compile behavior inspectable.

## Example: predictable handling of range fold

For:

```fig
fn add(acc: i32, x: i32) -> i32 { acc + x }

pub fn main(seed: i32) -> i32 {
  range.RangeIter.fold(range.RangeI32.Iter(seed - seed .. 1000), 0, add)
}
```

Expected plan:

```txt
add
  inline: private pure scalar, cost <= budget

RangeIter.fold
  inline: private pure wrapper, cost <= budget

RangeIter.fold_loop
  recurrence: tail_linear
  action: lower_tail_loop
  reason: direct self-tail call, i increases by 1, guard i < end

main
  fold: seed - seed => 0, if safe under profile
```

Expected WAT shape:

```txt
loop: yes
recursive call: no
add call: no
RangeIter.fold call: no
RangeIter.fold_loop call: no
```

## The main design rule

Every optimization should answer three questions:

```txt
Can I do this?      Type/effect/domain facts.
Should I do this?   Cost/profile decision.
Did I do this?      Plan + WAT/IR shape test.
```

That gives Fig a predictable optimization system instead of a growing pile of clever rewrites.

Yes. The optimization system should be **structural and fact-driven**, not prelude-name-driven.

The repo already states this as the intended policy: prelude functions can be canonical fixtures, but optimization should happen because the checked source or IR has the right shape, not because the callee name belongs to `prelude.*`; equivalent user-written code should get the same lowering decision. 

## Core rule

Do **not** optimize this way:

```txt
if callee == "RangeIter.fold" then lower to loop
if callee == "InlineArray.map" then specialize
if callee starts with "prelude." then trust it
```

Optimize this way:

```txt
if expression has a recognized recurrence shape, lower it
if data has fixed layout facts, flatten/pack it
if branch condition is proven by domain facts, fold it
if pure helper is small and called in a foldable context, inline it
if product construction is immediately projected, remove the product
```

So `prelude.RangeIter.fold`, a user-defined `my_fold`, and a generated helper should all get the same result if they have the same typed shape.

## Set up optimizations around facts

Use facts as the only input to optimization decisions:

```ts
interface OptimizationFacts {
  types: TypeFacts;
  domains: DomainFacts;
  effects: EffectFacts;
  recurrences: RecurrenceFacts;
  layout: LayoutFacts;
  calls: CallGraphFacts;
  constants: ConstFacts;
}
```

Then every optimization rule asks:

```txt
What facts prove this is valid?
What cost profile says this is worth doing?
What structural rewrite should happen?
```

No rule should need to know whether a function came from `prelude`, `std`, `array_static`, or user code.

## The main structural rules to implement

### 1. Tail recursion → loop

Recognize this shape:

```fig
fn go(i: i32, end: i32, acc: i32) -> i32 {
  match i < end {
    true => go(i + 1, end, step(acc, i)),
    false => acc,
  }
}
```

General condition:

```txt
function has only tail calls to itself
recursive call updates parameters by simple expressions
no recursive call appears under non-tail computation
effects are preserved in order
```

Action:

```txt
lower to Wasm loop
```

This should apply to `RangeIter.fold_loop`, `bench_loop`, `score_loop`, or any user-defined equivalent. The backend already has tail-loop lowering for direct self-tail recursion. 

### 2. Finite refined-domain recursion → unfold or loop

Recognize:

```fig
fn go(i: i32(4), acc: i32) -> i32 { acc }
fn go(i: i32(0..4), acc: i32) -> i32 { go(i + 1, acc + i) }
```

General condition:

```txt
recursive clauses partition a finite i32 domain
recursive call moves monotonically through that domain
base clause exits the domain
```

Action:

```txt
small cardinality -> unfold
large cardinality -> loop
```

The repo now has recurrence summaries, domain measures, finite-static classification, and finite recurrence expansion.

### 3. Domain branch folding

Recognize:

```fig
if i < 4 { A } else { B }
```

where:

```txt
i: i32(0..4)
```

Action:

```txt
fold to A
```

General condition:

```txt
condition truth is implied by abstract/domain facts
```

The backend tests already check that comparisons proven by refined domains fold away. 

### 4. Product construction/projection folding

Recognize:

```fig
let p = Point {x: a, y: b};
p.x
```

Action:

```txt
replace with a
```

General condition:

```txt
value is a known product/shape
projection selects a known slot
source expression is effect-safe
```

This is not a `Point` optimization; it is a product-shape optimization.

### 5. Fixed-array projection/update folding

Recognize:

```fig
let xs = [1, 2, 3, 4];
let ys = [...xs, [2]: 99];
ys[2]
```

Action:

```txt
replace with 99
```

and:

```fig
ys[0]
```

becomes:

```txt
xs[0]
```

General condition:

```txt
fixed-size indexed layout
index known or bounded
update source known
```

This should apply to tuple syntax, inline arrays, prelude helpers, or user equivalents if the layout facts are the same.

### 6. Packed/local/scratch layout selection

Do not choose layout by function name.

Choose by facts:

```txt
InlineArray(n, u3), dynamic index, n * 3 <= 32      -> packed i32
InlineArray(n, u8), large dynamic writes            -> packed/scratch depending cost
InlineArray(n, product), no dynamic index            -> flat locals
fixed array used only at known indexes               -> project used slots only
```

The backend already has scratch/packed/local-slot planning paths. Those should be exposed as structural `choose_layout` decisions. 

### 7. Pure helper inlining

Do not inline because function is in `prelude`.

Inline because:

```txt
function is private
function is pure
function cost <= profile budget
function is not recursive unless a recurrence rule handles it
inlining does not duplicate expensive/effectful arguments
```

The optimizer already has function summaries with purity, effect class, recurrence kind, cost, allocation behavior, and stack behavior.

## Create a structural rule registry

Add a registry like:

```ts
interface OptimizationRule {
  id: string;
  phase: "facts" | "plan" | "rewrite" | "lower";
  match(ctx: RuleContext): MatchResult | undefined;
  apply(ctx: RuleContext, match: MatchResult): RewriteResult;
}
```

Example rules:

```txt
recurrence.tail_loop
recurrence.finite_unfold
domain.compare_fold
domain.match_prune
product.project_known_slot
product.construct_project_elim
array.fixed_project_literal
array.fixed_update_project
array.layout_packed
array.layout_flat
call.inline_private_pure
call.forwarding_wrapper
effect.drop_unused_pure
effect.preserve_unused_effectful
```

Every rule has a structural matcher.

Bad:

```ts
if (callee.name === "RangeIter.fold") ...
```

Good:

```ts
if (isPureSelfTailRecurrence(fn) && hasMonotoneI32Induction(fn)) ...
```

## Use traits/protocols only as facts, not names

Some things need semantic protocols, such as collection builders. That is okay if the compiler reasons over **the protocol shape**, not the module name.

For example, collector lowering can depend on:

```txt
Target type has collect_start / collect_push / collect_finish members
with valid signatures
```

not:

```txt
callee is prelude.array_static.CompactArray.collect_*
```

The existing collector protocol already resolves members structurally from the target type and validates signatures. That is the right model. Keep extending this style.

## Add an “explain optimization” path

To make the system predictable, every optimization should emit a decision:

```json
{
  "rule": "recurrence.tail_loop",
  "target": "score_loop",
  "reason": "direct self-tail recursion; induction param i increments by 1; guard i < 256",
  "action": "lower_to_loop"
}
```

and:

```json
{
  "rule": "array.layout_packed",
  "target": "perm",
  "reason": "InlineArray(7, u3), dynamic index, total width 21 bits",
  "action": "use_packed_i32"
}
```

Then tests can assert the decision before asserting WAT shape.

The repo already exports analysis helpers like `summarizeProgram`, `summarizeRecurrences`, and `summarizeAbstractValues`; add `summarizeOptimizationPlan` next to those.

## Add “prelude equivalence” tests

For every important prelude optimization, add a user-written equivalent.

Example:

```fig
fn prelude_path(xs: fixed.Array(4, u3), i: i32, v: u3) -> fixed.Array(4, u3) {
  fixed.Array.set(4, u3, xs, i, v)
}

fn user_path(xs: fixed.Array(4, u3), i: i32, v: u3) -> fixed.Array(4, u3) {
  [...xs, [i]: v]
}
```

The docs already use this exact idea: equivalent user-written shape should get the same representation decision and Wasm shape modulo names. 

Test both:

```txt
same chosen optimization rule
same layout decision
same absence/presence of loop
same absence/presence of helper calls
similar Wasm size
```

## Migration strategy

Audit existing optimizations and classify them:

```txt
Keep:
  structural matcher already

Rewrite:
  name-based matcher but can become structural

Quarantine:
  benchmark-specific/name-specific workaround

Delete:
  obsolete rule now covered by structural facts
```

A useful convention:

```ts
// BAD: name-based
function lowerRangeIterFold(...) { ... }

// GOOD: structural
function lowerPureI32TailFoldRecurrence(...) { ... }
```

Names like `RangeIter.fold` can still appear in tests as fixtures, but not as optimizer conditions.

## Practical rule

An optimization is acceptable only if it can pass this test:

```txt
If I rename the module/function and write the same structure by hand,
does the optimization still fire?
```

If not, the rule is too specific.

## Short implementation plan

1. Add `OptimizationRuleId` and `OptimizationDecision`.
2. Wrap existing major optimizations with decision records.
3. Add `summarizeOptimizationPlan`.
4. Add user-vs-prelude equivalence tests.
5. Refactor any name-based recognizers into structural recognizers.
6. Make benchmark gates assert rule IDs where possible, not just WAT strings.

The end state:

```txt
Prelude code is just convenient source.
Optimization sees typed structure, facts, effects, recurrence shape, and layout shape.
```
