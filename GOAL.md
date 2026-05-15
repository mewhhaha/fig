After re-reading the current repo, the **next improvement** should be:

# Make refined `i32(...)` domains drive recursive clause dispatch

Not more backend micro-optimization yet. The repo already has enough backend machinery to benefit from a stronger type/checking layer: Branch-Bit value semantics, flattened product/inline-array layouts, tail-loop lowering, specialization, SIMD recognition, and benchmark gates are already part of the current direction.

The missing core is that `i32(...)` exists, but it is not yet the organizing principle for recursion, function clauses, exhaustiveness, or specialization.

## What is already there

Fig already has a useful refined-domain substrate:

```fig
type fn Index(n: count) -> type {
  i32(0..n)
}

fn i32.try_domain(const domain: type, x: i32) -> Option(domain) {
  x
}
```

That is in `prelude/core.fig`, and `Index(n)` already aliases to `i32(0..n)`. 

The backend already uses refined `i32` parameter domains for optimization. There is a test where:

```fig
pub fn main(i: i32(0..64)) -> i32 {
  (i / 16) + (i % 16)
}
```

lowers through unsigned shift/and instead of signed div/rem. There is also a `core.i32.try_domain(i32(0..4), raw)` test. 

The refined scalar implementation already parses `i32(...)`, supports `|` and `..`, computes numeric ranges, checks assignability, and maps refined `i32` back to runtime `i32`. 

So the next step is **not** “add `i32(1..4)`.” It is:

```txt
Promote i32-domain information from a helper/parser into the type checker’s clause and recursion model.
```

## The main missing piece

Function clauses currently require parameter types to be exactly equal:

```ts
if (param.type !== first.params[index]?.type) {
  diagnostics.push({
    code: "fn.clause_param_type",
    message: `function ${first.name} clause parameter ${index + 1} has incompatible type`,
  });
}
```

That blocks the recursion-first style we discussed:

```fig
fn sum_go(i: i32(4), xs: Lane4I32, acc: i32) -> i32 {
  acc
}

fn sum_go(i: i32(0..4), xs: Lane4I32, acc: i32) -> i32 {
  sum_go(i + 1, xs, acc + xs[i])
}
```

Today, those two clauses would be considered incompatible because `i32(4)` and `i32(0..4)` are different strings. 

That is the next improvement.

## What to implement first

Add **runtime-signature-compatible refined clauses**.

Current rule:

```txt
same function name => same arity, same visibility, same return type, same effects, exact same param type strings
```

New rule:

```txt
same function name =>
  same arity
  same visibility
  same effects
  compatible return type
  parameter runtime representations match
  refined scalar domains may differ
```

So these clauses should be compatible:

```fig
fn f(x: i32(0)) -> i32 { ... }
fn f(x: i32(1..4)) -> i32 { ... }
fn f(x: i32(4)) -> i32 { ... }
```

because all parameters lower to runtime `i32`.

These should remain incompatible:

```fig
fn f(x: i32) -> i32 { ... }
fn f(x: bool) -> i32 { ... }
```

unless you later add explicit sum/union dispatch.

## Replace clause dispatch with domain dispatch

Right now grouped clauses become generated `__clause_N` functions plus a dispatcher based on literal pattern tests. 

That is fine for:

```fig
fn score(true: bool) -> i32 { 1 }
fn score(false: bool) -> i32 { 0 }
```

but insufficient for:

```fig
fn go(i: i32(0..4), ...) -> T { ... }
fn go(i: i32(4), ...) -> T { ... }
```

The checker should build a domain decision tree:

```txt
go(i)
  if i ∈ i32(4)     -> base clause
  if i ∈ i32(0..4)  -> recursive clause
```

Then the optimizer/backend can lower that to:

```txt
constant branch
range compare
equality compare
bit mask
or fully folded call path
```

depending on the call-site domain.

## Why this should come before TypeId/MIR refactors

I still think the compiler should eventually move away from stringly-typed annotations. The core AST stores param types, return types, let types, type aliases, product slots, and type members as strings. 

But the **fastest high-value vertical slice** is not a total `TypeId` rewrite. It is this smaller change:

```txt
Keep strings for now,
but add a canonical RefinedDomain layer around i32(...) where clauses/checking need it.
```

That gets you the language behavior immediately, and it gives you real examples/tests to justify the larger representation rewrite later.

## The specific missing domain operations

`refined_scalar.ts` currently normalizes by de-duplicating rendered intervals and sorting them. It does not appear to merge adjacent or overlapping literal intervals. For example, these should canonicalize to the same domain:

```fig
i32(0 | 1 | 2 | 3)
i32(0..4)
i32(0..2 | 2..4)
```

The current normalization keeps intervals unique and sorted, but it does not merge them into minimal interval sets. 

That matters because specialization keys and clause coverage should not distinguish equivalent domains.

Add:

```ts
unionDomain(a, b)
intersectDomain(a, b)
subtractDomain(a, b)
domainContains(a, b)
domainIsEmpty(a)
canonicalDomainKey(domain)
cardinality(domain)
```

Then use them for:

```txt
clause compatibility
clause overlap diagnostics
exhaustiveness checks
unreachable clause detection
recursion progress checks
specialization key normalization
```

## The next concrete feature

Add recursive domain clauses:

```fig
fn sum_go(i: i32(4), xs: Lane4I32, acc: i32) -> i32 {
  acc
}

fn sum_go(i: i32(0..4), xs: Lane4I32, acc: i32) -> i32 {
  sum_go(i + 1, xs, acc + xs[i])
}

pub fn sum(xs: Lane4I32) -> i32 {
  sum_go(0, xs, 0)
}
```

Expected compiler behavior:

```txt
1. Accept clauses because both parameter runtime types are i32.
2. Build domain dispatcher.
3. Prove sum_go(0, ...) follows domains 0 -> 1 -> 2 -> 3 -> 4.
4. Either:
   - lower to a tail loop,
   - fully unroll,
   - or keep recursive/tail-call form based on cost.
5. Remove impossible dispatch branches.
```

This unlocks the recursion-first language design without adding `for`.

## Current repo already rejects the wrong loop syntax

This is good: array-comprehension-like syntax and static-for array literals are rejected in tests, and the docs say static-for statement blocks and array-comprehension-style `[for ...]` literals are rejected.

But record/product static slots still exist:

```fig
let value = {for Key, Spec in (fields): 1};
```

and `StaticForSlot` still exists in the grammar/AST.

That is fine if you treat it as **record/type-shape metaprogramming**, not loop syntax. I would document it that way:

```txt
Allowed:
  static record field expansion

Rejected:
  runtime loops
  array comprehensions
  static-for statement blocks
```

## What I would do next, in order

### 1. Add canonical domain operations

Upgrade `refined_scalar.ts` so these normalize identically:

```fig
i32(0 | 1 | 2 | 3)
i32(0..4)
i32(0..2 | 2..4)
```

This makes `i32(...)` suitable for specialization keys and coverage checks.

### 2. Add runtime-compatible clause typing

Change `groupFunctionClauses` to allow refined `i32` parameter domains as long as their runtime carrier is the same. Keep exact return/effect compatibility for now. 

### 3. Build domain dispatch instead of only literal-pattern dispatch

Current clause dispatch only gets tests from parameter patterns. 

Add domain tests from parameter types:

```txt
param type i32(4)    -> x ∈ {4}
param type i32(0..4) -> x ∈ [0,4)
```

### 4. Add overlap/exhaustiveness diagnostics

Example:

```fig
fn f(x: i32(0..4)) -> i32 { 1 }
fn f(x: i32(2..6)) -> i32 { 2 }
```

should warn or error:

```txt
overlapping clauses: i32(2..4)
```

Example:

```fig
fn f(x: i32(0..4)) -> i32 { 1 }
fn f(x: i32(5..8)) -> i32 { 2 }
```

called with `i32(0..8)` should know `i32(4 | 8?)` depending on range semantics is uncovered.

### 5. Add domain-aware recursive-call analysis

The backend currently infers some scalar facts for tail-recursive functions, but it is narrow: it checks only direct self-tail calls, non-negative arguments, and simple `<`/`<=` guard upper bounds.

Move the important part earlier into checking/specialization:

```txt
recursive call:
  go(i + 1)

input domain:
  i32(0..4)

result domain:
  i32(1..5)

covered by:
  recursive clause i32(0..4)
  base clause i32(4)
```

That lets you prove finite recursion and decide whether to unroll or lower to a loop.

### 6. Add tests before major architecture work

Add tests like:

```fig
fn f(x: i32(0)) -> i32 { 10 }
fn f(x: i32(1..4)) -> i32 { 20 }
pub fn main() -> i32 { f(0) + f(2) }
```

Expected release WAT:

```txt
i32.const 30
```

Then recursive:

```fig
fn sum_go(i: i32(4), acc: i32) -> i32 { acc }
fn sum_go(i: i32(0..4), acc: i32) -> i32 { sum_go(i + 1, acc + i) }
pub fn main() -> i32 { sum_go(0, 0) }
```

Expected result:

```txt
6
```

Then decide release-shape expectations:

```txt
tiny finite recursion: no recursive call
larger tail recursion: loop exists, recursive_calls == 0
```

Your benchmark harness already checks WAT/Wasm size, loops, recursive calls, SIMD ops, heap refs, and forbidden WAT patterns, so this fits the existing testing style.

## What was missing from the earlier plan

The earlier plan understated what the repo already has:

1. **`i32(...)` is already implemented enough to optimize div/rem.** It is not just a proposed syntax. 

2. **`Index(n)` already maps to `i32(0..n)`.** That is exactly the right design anchor. 

3. **The backend already recognizes recursion as loops.** The next limitation is not “can recursion lower well?”; it is “can the type checker express refined recursive clauses?”

4. **The real blocker is clause typing.** Exact string equality for clause parameter types prevents the recursion-first domain style. 

5. **The representation is still stringly typed.** That is manageable for now, but it is the deeper architectural debt. 

## Recommendation

Implement this next:

```txt
Domain-compatible function clauses + canonical i32 domain operations + domain dispatch.
```

That is the smallest change that meaningfully moves Fig toward:

```txt
recursive source
finite-domain reasoning
small folded output
fast Wasm
no source loops
```

After that lands, the next architectural refactor should be `TypeId`/`DomainId` interning, because the current compiler still repeatedly parses, compares, rewrites, and substitutes type strings across imports, checking, specialization, optimization, and backend lowering.

