# Fig Type Functions

Type functions run at compile time:

```fig
type fn pair(A: type, B: type) -> struct {
  let Pair = {first: A, second: B};
  struct(Pair)
}
```

Type function bodies contain `let` or `const` PascalCase bindings and type expressions. A final type
expression is the result. Result kinds are `type`, `struct`, `union`, and `operator`.

## Parameters and Clauses

Type parameters use these kinds:

```fig
type fn id(A: type) -> type { A }
type fn fixed(N: count, A: type) -> struct { let Fixed = {N*A}; struct(Fixed) }
type fn proof(X: const) -> type { i32 }
type fn lift(F: type fn(A: type) -> type) -> type { F(i32) }
```

`count` is parsed as a lowercase kind name. Type constructor parameters use
`type fn(...) -> result-kind`.

Ordered type-function clauses support literal, wildcard, lowercase binding, and PascalCase type
patterns:

```fig
type fn choose(i32: type) -> type { bool }
type fn choose(_: type) -> type { i32 }
```

## Type Expressions

Type-level expressions include primitive type names, qualified names, type calls, literals, shape
expressions, tuple and repeat types, borrowed and frozen types, type matches, equality comparisons,
builtins, and operator descriptors.

```fig
match A { i32 => bool, _ => A }
[i32, bool]
[i32; 4]
&(point)
#(layout.inline_array(3, i32))
@type_has_slot(T, #x)
operator(#infixl, 60, "+", T.add)
```

`struct(ShapeBinding)` creates a product type. `union(A, B, ...)` creates a sum type.
`operator(fixity, precedence, symbol, target)` creates an operator descriptor. Current expression
syntax resolves user-defined binary operators through visible descriptors, most commonly
`#infix`, `#infixl`, and `#infixr`; the target is a function or attached member reference.

## Attached Members and Contracts

Attached members are ordinary functions with a qualified name. Type functions can require and
reflect those members:

```fig
fn point.eql(a: point, b: point) -> bool { a.x == b.x && a.y == b.y }

type fn eq(T: type) -> type {
  let Expected = fn(a: T, b: T) -> bool;
  @require(@type_has_member(T, #eql), "Eq requires eql");
  @require(@type_member_type(T, #eql) == Expected, "Eq.eql has wrong type");
  T
}
```

Type constructor parameters let contracts describe generic families:

```fig
type fn mapper(F: type fn(A: type) -> type) -> type {
  @require(@type_has_member(F, #map), "mapper requires map");
  F(i32)
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
| Call required behavior without runtime dictionaries | Pass `const _proof: contract(T)` and call the attached member as `T.member(...)`. |
| Abstract over a unary type constructor | Accept `T: type fn(A: type) -> type`, use values as `T(A)`, and reflect members on `T`. |
| Choose dispatch from a type value | Pass the type as `const T` or `const t: type`; do not model types as runtime values. |
| Specialize layout or counts | Pass static shape data as `const n: count`, `const a: type`, or another `const` parameter. |

Prefer inference when ordinary value parameters already determine the type. Pass an explicit
`const T` only when the function needs a type that is otherwise not pinned by a value argument, such
as empty-value construction, explicit `pure(T, ...)` construction, or type-directed static dispatch.

```fig
fn append(const T, const _proof: semigroup(T), a: T, b: T) -> T {
  T.append(a, b)
}

fn fmap(v: T(A), const f: fn(x: A) -> B, const _proof: functor(T)) -> T(B) {
  T.map(f, v)
}
```

Const dictionaries are still useful for highly specialized static dispatch, but attached members
plus erased proof parameters are the preferred default for typeclass-like APIs.
