# Fig Type Functions

Fixed product, sum, and alias layouts can use type declaration sugar:

```fig
type Point = struct {x: i32, y: i32}
type Option(a) = union {None, Some(value: a)}
type Count = i32
```

The sugar lowers to ordinary type functions. Use explicit `type fn` declarations when the layout is
computed at compile time:

```fig
type fn Pair(a: type, b: type) -> struct {
  let Pair = {first: a, second: b};
  struct(Pair)
}
```

Type function bodies contain `let` or `const` bindings and type expressions. The final type
expression is the result. Result kinds are `type`, `struct`, `union`, and `operator`.

## Parameters and Clauses

Type parameters use these kinds:

```fig
type fn Id(a: type) -> type { a }
type fn Fixed(n: count, a: type) -> struct { let Fixed = {n*a}; struct(Fixed) }
type fn Proof(x: const) -> type { i32 }
type fn Lift(f: type fn(a: type) -> type) -> type { f(i32) }
```

`count` is parsed as a lowercase kind name. Type constructor parameters use
`type fn(...) -> Result-kind`.

Ordered type-function clauses support literal, wildcard, lowercase binding, and PascalCase type
patterns:

```fig
type fn Choose(i32: type) -> type { bool }
type fn Choose(_: type) -> type { i32 }
```

## Type Expressions

Type-level expressions include primitive type names, qualified names, type calls, literals, shape
expressions, tuple and repeat types, type matches, equality comparisons, builtins, and operator
descriptors.

```fig
match a { i32 => bool, _ => a }
[i32, bool]
[i32; 4]
@type_has_slot(t, #x)
operator(#infixl, 60, "+", t::add)
```

`struct(ShapeBinding)` creates a product type. `union(a, b, ...)` creates a sum type.
`operator(fixity, precedence, symbol, target)` creates an operator descriptor. Current expression
syntax resolves user-defined binary operators through visible descriptors, most commonly `#infix`,
`#infixl`, and `#infixr`; the target is a function or attached member reference.

## Attached Members and Contracts

Attached members are ordinary functions with a qualified name. Type functions can require and
reflect those members:

```fig
fn Point::eql(a: Point, b: Point) -> bool { a.x == b.x && a.y == b.y }

type fn Eq(t: type) -> type {
  let Expected = fn(a: t, b: t) -> bool;
  @require(@type_has_member(t, #eql), "Eq requires eql");
  @require(@type_member_type(t, #eql) == Expected, "Eq.eql has wrong type");
  t
}
```

Type constructor parameters let contracts describe generic families:

```fig
type fn Mapper(f: type fn(a: type) -> type) -> type {
  @require(@type_has_member(f, #map), "mapper requires map");
  f(i32)
}
```

When a contract type function validates a type and returns that same runtime type, annotations are
transparent. The value has the returned runtime type, and the checker records the contract fact for
attached-member calls:

```fig
fn same(a: Eq(t), b: t) -> bool {
  t::eql(a, b)
}
```

This is equivalent to saying `a` is a `t` value and `Eq(t)` is known inside the function. No runtime
wrapper is introduced. Proof values passed as `const` parameters are still evaluated at compile time
and erased from runtime calls.

## Type Function Patterns

Use these patterns when choosing how to express static intent:

| Intent                                         | Pattern                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Define a runtime data layout                   | Write a `type fn`, bind a PascalCase shape, then return `struct(Shape)` or `union(...)`.        |
| Require behavior on a concrete type            | Write a contract `type fn` with `@require(@type_has_member(...))` and `@type_member_type(...)`. |
| Call required behavior carried by a value      | Annotate a value as `contract(t)` and call the attached member as `t::member(...)`.             |
| Call required behavior without a runtime value | Pass `const _proof: contract(t)` as an explicit erased proof fallback.                          |
| Abstract over a unary type constructor         | Accept `t: type fn(a: type) -> type`, use values as `t(a)`, and reflect members on `t`.         |
| Choose dispatch from a type value              | Pass the type as `const t` or `const t: type`; do not model types as runtime Values.            |
| Specialize layout or counts                    | Pass static shape data as `const n: count`, `const a: type`, or another `const` parameter.      |

Prefer inference when ordinary value parameters already determine the type. Pass an explicit
`const t` only when the function needs a type that is otherwise not pinned by a value argument, such
as empty-value construction, explicit `pure(t, ...)` construction, or type-directed static dispatch.

```fig
fn append(a: Semigroup(t), b: t) -> t {
  t::append(a, b)
}

fn fmap(v: t(a), const f: fn(x: a) -> b, const _proof: Functor(t)) -> t(b) {
  t::map(f, v)
}

fn empty(const t: type) -> Monoid(t) {
  t::empty()
}
```

Use contracted parameters when a value carries the type, contracted returns when constructing a
value through a contract, local proof constants when a proof is needed only inside one body, and
explicit `const` proof parameters when the caller must select or provide the proof.

Prelude contracts such as `Eq(t)`, `Functor(t)`, `Applicative(t)`, `Monad(t)`, and `Monoid(t)` are
law-bearing proofs. Their associated `contract fn ... -> rewrite` declarations attach optimizer
rewrite facts directly to the base contract; there is no separate `LawfulX` proof layer.

For effect-style APIs, prefer typed rows and handlers. Do not require callers to pass a separate
capability-list const plus a separate proof when the required context can be inferred from a typed
row such as `{state: Store, reader: Env}`:

```fig
const effect = @import("prelude.effect");

fn program() -> effect.Eff({state: Store, reader: Env}, i32) {
  do @monad(effect.Eff({state: Store, reader: Env}, _)) {
    env <- effect.ask();
    store <- effect.get();
    effect.put(store + env);
    effect.Eff::pure(store)
  }
}

pub fn main(env: Env, seed: Store) -> i32 {
  let result = program()
    \program -> effect.run_state(program, seed)
    \program -> effect.run_reader(program, env);
  result.value
}
```

Static proof parameters are still valid when a function is only checking a typed row label:

```fig
fn low_level(
  const effects: const,
  const _proof: effect.Member(#debug, effects),
  value: i32
) -> effect.Eff(effects, i32) {
  value
}

fn example(value: i32) -> effect.Eff({debug: i32}, i32) {
  low_level({debug: i32}, effect.Member(#debug, {debug: i32}), value)
}
```
