# Fig Expressions

Expressions include literals, variables, calls, field access, indexing, constructors, shape values,
matches, binary operators, ranges, blocks, `fork`, pipe-bind, and `$`.

```fig
add(1, 2)
point.x
xs[0]
Point [x: 1, y: 2]
[x: 1, y: 2]
match value { Some(x) => x, None => 0 }
1 .. 4
```

## Match

Use `match` instead of `if`. Arms are ordered. Function clauses are also ordered and can be used for
literal and wildcard dispatch.

```fig
fn unwrap_or(value: option(i32), fallback: i32) -> i32 {
  match value { Some(inner) => inner, None => fallback }
}
```

## Pipe-Bind and Placeholder

Pipe-bind evaluates the left side, binds it, and evaluates the next atom:

```fig
1 \x -> add(x, 2)
1 \$ -> add($, 2)
```

`$` is also accepted as placeholder syntax in const function helper contexts:

```fig
map4_i32($ + 1, xs)
```

The placeholder creates a unary helper where the checker can infer an expected unary const function.

## Fork and Destructuring

`fork(value)` creates multiple owned copies through multi-bind:

```fig
let a, b, c = fork(original);
```

Only a local variable may be forked. Forking consumes the original.

## Operators

The parser accepts these binary operator symbols: `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `<=`,
`>`, `>=`, `&&`, `||`, `^^`, `<>`, `<$>`, `<*>`, `>>=`, `zip`, and `..`.

Primitive operators are available for primitive types where implemented. Other operator calls are
resolved through visible operator descriptors, commonly imported through `prelude.operators` or
`prelude.std`.

Type expressions support `==` and `!=` for compile-time comparison.
