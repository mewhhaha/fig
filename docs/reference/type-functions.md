# Fig Type Functions

Type functions run at compile time:

```fig
type fn Pair(a: type, b: type) -> struct {
  let Pair = {first: a, second: b};
  struct(Pair)
}
```

Type function bodies contain `let` or `const` bindings and type expressions. a final type
expression is the Result. Result kinds are `type`, `struct`, `union`, and `operator`.

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
operator(#infixl, 60, "+", t.add)
```

`struct(ShapeBinding)` creates a product type. `union(a, b, ...)` creates a sum type.
`operator(fixity, precedence, symbol, target)` creates an operator descriptor. Current expression
syntax resolves user-defined binary operators through visible descriptors, most commonly
`#infix`, `#infixl`, and `#infixr`; the target is a function or attached member reference.

## Attached Members and Contracts

Attached members are ordinary functions with a qualified name. Type functions can require and
reflect those members:

```fig
fn Point.eql(a: Point, b: Point) -> bool { a.x == b.x && a.y == b.y }

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

Proof values passed as `const` parameters are evaluated at compile time and erased from runtime
calls.

## Type Function Patterns

Use these patterns when choosing how to express static intent:

| Intent | Pattern |
| ------ | ------- |
| Define a runtime data layout | Write a `type fn`, bind a PascalCase shape, then return `struct(Shape)` or `union(...)`. |
| Require behavior on a concrete type | Write a contract `type fn` with `@require(@type_has_member(...))` and `@type_member_type(...)`. |
| Call required behavior without runtime dictionaries | Pass `const _proof: contract(t)` and call the attached member as `t.member(...)`. |
| Abstract over a unary type constructor | Accept `t: type fn(a: type) -> type`, use values as `t(a)`, and reflect members on `t`. |
| Choose dispatch from a type value | Pass the type as `const t` or `const t: type`; do not model types as runtime Values. |
| Specialize layout or counts | Pass static shape data as `const n: count`, `const a: type`, or another `const` parameter. |

Prefer inference when ordinary value parameters already determine the type. Pass an explicit
`const t` only when the function needs a type that is otherwise not pinned by a value argument, such
as empty-value construction, explicit `pure(t, ...)` construction, or type-directed static dispatch.

```fig
fn append(const t, const _proof: Semigroup(t), a: t, b: t) -> t {
  t.append(a, b)
}

fn fmap(v: t(a), const f: fn(x: a) -> b, const _proof: Functor(t)) -> t(b) {
  t.map(f, v)
}
```

Const dictionaries are still useful for highly specialized static dispatch, but attached members
plus erased proof parameters are the preferred default for typeclass-like APIs.
