# Fig Type Functions

Type functions run at compile time:

```fig
type fn pair(A: type, B: type) -> struct {
  let Pair = [first: A, second: B];
  struct(Pair)
}
```

Type function bodies contain `let` or `const` PascalCase bindings and type expressions. A final type
expression is the result. Result kinds are `type`, `struct`, `union`, and `operator`.

## Parameters and Clauses

Type parameters use these kinds:

```fig
type fn id(A: type) -> type { A }
type fn fixed(N: count, A: type) -> struct { let Fixed = [N*A]; struct(Fixed) }
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
expressions, type matches, equality comparisons, builtins, and operator descriptors.

```fig
match A { i32 => bool, _ => A }
@type_has_slot(T, #x)
operator(#infixl, 60, "+", T.add)
```

`struct(ShapeBinding)` creates a product type. `union(A, B, ...)` creates a sum type.
`operator(fixity, precedence, symbol, target)` creates an operator descriptor. Supported fixity tags
are `#infix`, `#infixl`, and `#infixr`; the target is a function or attached member reference.
