# Refinement and Recursion Design Direction

Fig's strongest compiler direction is restricted dependent/refinement typing plus recursion analysis
plus type-directed partial evaluation. The goal is a recursion-first source language where small
recursive programs can compile to constants, straight-line code, SIMD-shaped code, compact loops, or
ordinary runtime recursion according to proof and cost.

This note records the implemented restricted direction. The implementation deliberately stays within
finite scalar domains, const parameters, bounded recurrence analysis, explicit effects, and local
optimization instead of growing into full dependent typing or global proof search.

## Core Restrictions

Keep the theory finite and canonical:

- Scalar refinements are finite integer domains, represented as normalized interval sets.
- Types may depend on `const` parameters and finite scalar domains.
- Types may not depend on arbitrary runtime values.
- Subtyping, overlap, and exhaustiveness for scalar domains must be decidable without general SMT.
- Recursive unfolding is bounded by domain cardinality, recurrence classification, effects, and
  code-size/runtime cost summaries.

Avoid full dependent type theory, global proof search, global equality saturation, and implicit
folding of effectful code.

## Refined Scalar Domains

The initial refinement fragment is `i32(...)`:

```fig
i32(1)
i32(1 | 2 | 3)
i32(1..4)
i32(1 | 3..10 | 12)
```

The compiler should canonicalize these as interval sets with half-open bounds:

```text
i32(1 | 3..10 | 12) = [1, 2) union [3, 10) union [12, 13)
```

That representation should power:

- Subtyping: `i32(1 | 2) <: i32(0..4)`.
- Bounds proofs: `i: i32(0..4)` proves direct access into a length-4 lane.
- Clause dispatch: refined domains are ordered value-clause tests over runtime `i32`.
- Branch folding: singleton and empty domains remove impossible control flow.
- Specialization keys: equivalent domains canonicalize to the same key.

Domain operations should be semantic set operations:

```text
i32(1 | 2) <: i32(1..3)
i32(1..4) | i32(4) = i32(1..5)
i32(0..4) & i32(2..6) = i32(2..4)
i32(0..4) - i32(2) = i32(0..2 | 3..4)
```

## Static and Dynamic Phases

Use a DML/ATS-style split between statics and dynamics:

```fig
fn map_go(
  const n: count,
  i: i32(0..n),
  xs: InlineArray(n, i32)
) -> InlineArray(n, i32)
```

`n` is static. `i` is runtime but has a static finite-domain fact. The checker and optimizer can
reason about `i`, but type formation remains restricted to const parameters and finite scalar
domains.

## Bidirectional Checking

Refinement checking should be bidirectional:

- Function parameters are checked from annotations.
- Function bodies are checked against declared return types.
- Literals are checked against expected types when available.
- Calls synthesize their return type from the callee.
- Match arms are checked against the expected result type.
- Recursive clauses are checked against one shared runtime signature plus per-clause domains.

Arithmetic can still infer internal facts. For example, while checking `x + 1` against `i32`, the
checker may learn that the expression has domain `i32(1..5)` when `x: i32(0..4)`.

## Occurrence Narrowing

Branch-sensitive refinement should narrow variables inside proven arms:

```fig
match i < 4 {
  true => xs[i],
  false => 0,
}
```

Inside the `true` arm, `i` should be intersected with the `< 4` interval. Inside the `false` arm,
future work should track the complement fact when it is representable. This drives bounds proofs,
dead-branch elimination, and recursive progress checks.

## Recurrence Classification

Recursive source remains the surface replacement for loops. The checker/lowerer should classify
recursion into:

```text
finite_static
tail_linear
structural
general_recursive
```

A finite-static proof needs:

- A measured refined-domain parameter.
- Monotonic recursive progress, such as `i -> i + 1`.
- Recursive arguments that remain covered by clause domains.
- A non-recursive exit domain.
- Effects that allow the intended transformation.

For example:

```fig
fn sum_go(i: i32(4), xs: Lane4I32, acc: i32) -> i32 { acc }
fn sum_go(i: i32(0..4), xs: Lane4I32, acc: i32) -> i32 {
  sum_go(i + 1, xs, acc + xs[i])
}
```

The compiler can then choose full unrolling, Wasm loop lowering, tail-call lowering, or normal
recursion.

## Abstract Interpretation and Partial Evaluation

The optimizer uses a small abstract interpreter over the checked core AST, which is the current
MIR-level optimization representation in this compiler. Abstract values include:

```text
unknown
constant
i32 domain
bool domain
product facts
unreachable
```

When a recurrence is finite and pure enough, the optimizer may unfold recursive calls symbolically.
For example, `pow(x, 3)` over a bounded exponent domain can become `x * x * x` when the recurrence
proof and cost model allow it.

Unfolding must be bounded by:

- Domain cardinality.
- Code-size budget.
- Runtime instruction budget.
- Recurrence classification.
- Effect class.
- Allocation and stack behavior.

## Effects and Cost

Effect rows are part of optimization soundness:

- Pure code may be folded, duplicated, reordered, and inlined.
- Read-only effects may be inlined but not duplicated freely.
- State, host, random, time, and I/O effects cannot be folded unless the capability is explicitly
  proven safe for that transformation.

Each function summary tracks estimated Wasm bytes, runtime instructions, maximum unfolding
cardinality, effect class, allocation behavior, and tail-call/stack behavior. Those summaries feed
the choice between unroll, loop lowering, tail calls, or no transformation.

## Local Equality Saturation

After recursion folding, use local e-graphs for small expression cleanup only. The whole program
should not be put into one e-graph. Candidate rewrites include:

```text
x + 0 = x
x * 1 = x
x * 0 = 0
x + x = x * 2
(x + 1) - 1 = x
i < 4 where i: i32(0..4) = true
```

Extraction should minimize Wasm bytes first, then runtime cost, then locals.

## Implementation Order

1. Finite-domain refinement types for `i32(...)`.
2. Semantic subtyping for union, intersection, subset, overlap, and difference.
3. Bidirectional checking around refined domains.
4. Occurrence narrowing for `match` and condition facts.
5. Recursive clause analysis using size-change-style measures.
6. Domain abstract interpretation over the checked core AST/MIR-level optimizer representation.
7. Type-directed partial evaluation for finite recursive calls.
8. Effect-aware folding rules.
9. Local equality saturation after folding.
10. Resource summaries to select unroll, loop, tail-call, or normal recursion.
