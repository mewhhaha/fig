The repo has already moved further than the previous discussion: `contract fn` exists in the grammar, `ContractDecl` exists in the AST, `contract fn` lowering is implemented, `::` is the associated-name syntax, and checker tracing/memoization exists. The next simplification work should be about **removing overlapping concepts and tightening phase boundaries**, not adding more surface forms.

## Highest-value simplifications

### 1. Keep `contract fn ... -> rewrite`, and stop adding alternate rewrite syntaxes

Current grammar already has:

```ebnf
ContractFnDecl = Visibility? "contract" "fn" FnName "(" Params? ")" ContractReturnSig Block ;
ContractReturnSig = "->" ContractResultKind ;
ContractResultKind = "rewrite" ;
```

and declarations now include `ContractDecl`.

So I would commit to this as the only rewrite declaration form:

```fig
contract fn Option::bind_left_zero() -> rewrite {
  @assume(
    \f -> Option::bind(Option::zero(), f),
    \f -> Option::zero()
  )
}
```

Do **not** also support:

```fig
rewrite fn ...
fn ... -> rewrite
type fn ... -> rewrite
@assume_rewrite(...)
law fn ...
```

That is the main simplification. `contract fn` is broad enough for future compiler-facing facts, but `-> rewrite` keeps the current meaning precise.

### 2. Remove `rewrite` from ordinary type positions unless it is truly needed

The grammar currently has both:

```ebnf
ContractResultKind = "rewrite"
TypeResultKind = "type" | "struct" | "union" | "operator" | "rewrite"
TypeAtom = "type" | "const" | "rewrite" | ...
```



That makes `rewrite` look like a normal type or type-function result. If the intended surface is `contract fn ... -> rewrite`, simplify:

```txt
Allowed:
  contract fn X::rule(...) -> rewrite { ... }

Rejected:
  fn f() -> rewrite { ... }
  type fn T() -> rewrite { ... }
  let x: rewrite = ...
  fn f(x: rewrite) -> i32 { ... }
```

Keep `rewrite` only as `ContractResultKind` for now. This avoids accidental phase confusion.

### 3. Make `.` vs `::` strict

Docs now say qualified names use dots for namespaces and `::` for attached members, with examples like `Option.map`, `Point::eql`, and `Geometry.Layout.vertex2d_i32`. Attached member functions are shown as `fn Point::eql(...)`. 

Simplify the rule:

```txt
.   = module / namespace qualification
::  = associated member or associated contract
```

So prefer:

```fig
std.array.Layout::lane4_i32
Option::bind
Point::eql
contract fn Option::bind_left_zero() -> rewrite { ... }
```

and gradually remove or deprecate member-like `Option.map` examples unless they are truly namespace paths. The lowering already treats `::` specially and records `memberOf`. 

### 4. Keep contracts as extension declarations, not type-body contents

The current split is good:

```fig
type fn Option(a: type) -> union { ... }

fn Option::pure(...) -> Option(a) { ... }
fn Option::bind(...) -> Option(b) { ... }

contract fn Option::bind_left_zero() -> rewrite { ... }
```

This is simpler than embedding rewrite/law blocks inside `type fn` bodies. Type functions define layout/contracts; associated functions define behavior; contract functions define compiler-facing facts.

This also matches the existing design where attached members are ordinary functions visible to reflection, and type functions can require them with `@type_has_member` / `@type_member_type`.

### 5. Do not make `@assume` a general static builtin

If `@assume(...)` is only valid in `contract fn ... -> rewrite`, treat it as a **contract-body form**, not a general-purpose static builtin.

That gives a clean rule:

```txt
@require(...)  -> type/contract checking
@assume(...)   -> only inside contract fn returning rewrite
```

This prevents people from writing `@assume(...)` in type functions or runtime expressions and expecting optimizer behavior.

### 6. Collapse the reflection surface, or at least group it

The plugin registry now lists many `type_*` builtins: member target, function reflection, scalar reflection, layout reflection, inline-array reflection, variant/niche reflection, and more. 

That is powerful, but it is getting wide. Two simplification options:

**Option A: keep the current builtins but document them fully.**
Right now `builtins.md` still documents the older smaller set, so docs and compiler surface are out of sync.

**Option B: add grouped reflection values and reduce one-off APIs later.**

For example:

```fig
@type_members(t)
@type_layout(t)
@type_scalar(t)
@type_fn(t)
@type_variants(t)
```

instead of:

```fig
@type_scalar_min
@type_scalar_max
@type_scalar_bit_width
@type_scalar_signed
@type_scalar_domain
...
```

I would do A first for stability, then consider B if the reflection API becomes hard to maintain.

## Codebase simplifications

### 1. Split contract handling out of `check.ts`

`check.ts` now handles tracing, memoization, type functions, specialization, attached members, rewrites/contracts, function checking, operator lowering, collectors, and product constructors. It also now has `checkRewriteDecls` / `checkRewriteTypeMisuse` phases in the main pipeline.

Extract:

```txt
src/contracts/
  registry.ts
  check.ts
  assume.ts
  facts.ts
  instantiate.ts
```

Target API:

```ts
const contractRegistry = collectContracts(program);
checkContracts(contractRegistry, ctx);
const rewriteFacts = instantiateRewriteFacts(contractRegistry, proofEnv);
```

Then the main checker only orchestrates.

### 2. Make contract declarations invisible to runtime passes

`countProgramCallExpressions` already visits contract bodies, which is fine for trace, but backend/runtime phases should not even see contracts unless explicitly analyzing rewrite facts. 

Simplify with a phase boundary:

```txt
source Program
  -> checked Program + ContractRegistry
  -> optimized runtime Program + RewriteFacts
  -> backend
```

Do not keep asking runtime phases to remember to skip `decl.kind === "contract"`.

### 3. Move `CheckMemo` into its own module

`CheckMemo` now exists with caches for type matches, runtime type, expression binding type, static const values, and call checks. 

Extract:

```txt
src/check/memo.ts
```

and expose targeted helpers:

```ts
memoizedTypeMatch(...)
memoizedRuntimeType(...)
memoizedStaticConst(...)
memoizedCallCheck(...)
```

This keeps cache-key discipline centralized and prevents accidental unsafe caching.

### 4. Stop adding new whole-program phases unless they have counters

The checker pipeline is already phase traced, which is good.

Rule:

```txt
Every new whole-program pass must have:
  trace phase name
  input/output counts
  justification
```

This keeps the repeated-call compile cliff from reappearing.

## Syntax simplification recommendations

Use this final syntax set:

```fig
type fn Option(a: type) -> union { ... }      // type/layout/contract construction

fn Option::bind(...) -> Option(b) { ... }     // associated runtime behavior

contract fn Option::bind_left_zero() -> rewrite {
  @assume(
    \f -> Option::bind(Option::zero(), f),
    \f -> Option::zero()
  )
}
```

And generic:

```fig
contract fn MonadZero::bind_left_zero(
  const M: type fn(a: type) -> type
) -> rewrite {
  const proof = MonadZero(M);

  @assume(
    \f -> M::bind(M::zero(), f),
    \f -> M::zero()
  )
}
```

Do not add a separate `law`, `rewrite fn`, `fn -> rewrite`, or `type fn -> rewrite` surface unless `contract fn` proves insufficient.

## Suggested next concrete task

Clean up the new contract/rewrite feature around a single model:

```txt
contract fn ... -> rewrite
```

Implementation checklist:

```txt
1. Remove or reject `rewrite` as an ordinary TypeAtom.
2. Remove or reject `type fn ... -> rewrite` unless intentionally supported.
3. Ensure ordinary `fn ... -> rewrite` is rejected.
4. Document `contract fn ... -> rewrite`.
5. Document `@assume` as contract-rewrite-only.
6. Add examples for Option::bind_left_zero and MonadZero::bind_left_zero.
7. Extract contract collection/checking into a small module.
8. Ensure runtime/backend functions never receive ContractDecls.
```

That would simplify the language and compiler while preserving the new extensible rewrite direction.
