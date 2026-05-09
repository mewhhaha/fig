# Fig Expressions

Expressions include literals, variables, calls, field access, indexing, constructors, shape values,
tuple values, collection literals, matches, binary operators, ranges, blocks, borrows, `fork`,
pipe-bind, and `$`.

```fig
add(1, 2)
point.x
xs[0]
Point {x: 1, y: 2}
{x: 1, y: 2}
[1, [0; 3]]
<1, 2, 3>
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

Tuple and product results can be destructured with multi-bind:

```fig
let [head, tail] = make_pair();
let left, right = split(value);
```

## Records, Constructors, and Slots

Shape values and product constructors use the same slot syntax:

```fig
let x = 1;
let y = 2;
let record = {x, y};
let point = Point {x, y};
```

Slots may be labeled, positioned, punned from a visible local name, or spread from another value:

```fig
{x: 1, [0]: 2, ...rest}
Point {x, y, ...base}
```

Static slots generate fields from a compile-time shape:

```fig
const fields = {x: true, y: true};
let record = {for Key, Spec in (fields): 1};
let point = Point {for Key, Spec in (fields): 1};
```

The generated key is used as the slot label. Static slots are supported in records and product
constructors; static `for` statement blocks are deprecated.

## Tuples, Collections, and Frozen Values

Tuple literals use brackets. Repeat literals use a count expression after `;`:

```fig
let pair = [1, true];
let zeros = [0; 4];
```

Angle-bracket collection literals are target-typed and lower through collector members on the
expected type. A spread can append a tail collection when the expected collector supports it:

```fig
let tail: layout.inline_array_list(3, i32) = <1, 2, 3>;
let ys: layout.inline_array_list(4, i32) = <0, ...tail>;
```

Frozen literals use `#` and require a frozen expected type:

```fig
let xs: #(layout.inline_array(3, i32)) = #[10, 20, 30];
```

## Borrows

`&value` creates a call-scoped borrow for a parameter whose type is written `&(T)`:

```fig
fn sum(point: &(point2d)) -> i32 { point.x + point.y }
let total = sum(&point);
```

Borrows cannot be stored or returned as owned values.

## Operators

The parser accepts these binary operator symbols: `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `<=`,
`>`, `>=`, `&&`, `||`, `^^`, `<>`, `<$>`, `<*>`, `>>=`, `zip`, and `..`.

Primitive operators are available for primitive types where implemented. Other operator calls are
resolved through visible operator descriptors, commonly imported through `prelude.operators` or
`prelude.std`.

Type expressions support `==` and `!=` for compile-time comparison.
