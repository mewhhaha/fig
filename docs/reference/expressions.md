# Fig Expressions

Expressions include literals, variables, calls, field access, indexing, constructors, shape values,
tuple values, collection literals, matches, `if` sugar, binary operators, ranges, blocks, pipe-bind,
and `$`.

```fig
add(1, 2)
Point.x
xs[0]
Point {x: 1, y: 2}
{x: 1, y: 2}
[1, [0; 3]]
<1, 2, 3>
match value { Some(x) => x, None => 0 }
if ready { 1 } else { 0 }
1 .. 4
```

## Match

Use `match` for variants, literals, and other ordered pattern dispatch. Function clauses are also
ordered and can be used for literal and wildcard dispatch.

```fig
fn unwrap_or(value: Option(i32), fallback: i32) -> i32 {
  match value { Some(inner) => inner, None => fallback }
}
```

Boolean `if` is pure expression sugar:

```fig
if cond {
  a
} else {
  b
}
```

It desugars to:

```fig
match cond {
  true => a,
  false => b,
}
```

For boolean algorithm branches, keep each arm expression-oriented and prefer block `let` bindings
over deeply nested pipe-bind chains when several intermediate values feed the branch result:

```fig
let old_count = state.count[r];
let rotated = rotate_left(state.perm, r);
let count = fixed.Array.update(7, u3, state.count, r, dec);

match old_count > 1 {
  true => State {...state, perm: rotated, count, r},
  false => advance(State {...state, perm: rotated, count, r: r + 1}, r + 1),
}
```

## Const Functions and Pipe-Bind

Const-function literals provide inline templates where an expected `const fn` parameter supplies the
parameter and return types:

```fig
Option.map(\x -> x + 1, some(1))
RangeIter.fold(xs, 0, \(acc, x) -> acc + x)
Option.map(\x -> { let y = x + 1; y }, some(1))
```

They are compile-time templates, not runtime closure values. They are valid only in expected
`const fn` argument positions and cannot capture runtime locals.

Pipe-bind evaluates the left side, binds it, and evaluates the next atom:

```fig
1 \x -> add(x, 2)
1 \$ -> add($, 2)
```

The placeholder pipe-bind form is retained for compatibility, but named pipe-bind variables are the
preferred form. Pipe-bind is intended for short one-step value flow. For state machines or
update-heavy code, block `let` shadowing usually makes the same lowering shape easier to inspect.

## Shadowing and Destructuring

Local `let` bindings may shadow earlier bindings in the same block. The initializer sees the
previous binding, and later expressions see the new binding:

```fig
let x = 1;
let x = x + 1;
x // 2
```

This is the preferred style for update-heavy code because it keeps values immutable while allowing a
name to track the latest logical version.

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

Spread is the canonical update form for product values:

```fig
Player {
  ...player,
  hp: player.hp - 1,
}
```

Static slots generate fields from a compile-time shape:

```fig
const fields = {x: true, y: true};
let record = {for Key, Spec in (fields): 1};
let point = Point {for Key, Spec in (fields): 1};
```

The generated key is used as the slot label. Static slots are supported in records and product
constructors.

## Tuples and Collections

Tuple literals use brackets. Repeat literals use a count expression after `;`:

```fig
let pair = [1, true];
let zeros = [0; 4];
```

Fixed-array updates also use brackets. They copy one fixed source and apply indexed overrides:

```fig
let xs: [i32; 3] = [1, 2, 3];
let ys: [i32; 3] = [...xs, [1]: 32];
```

Repeated `let` shadowing plus fixed-array spread is the canonical source form for edit chains:

```fig
let a = xs[left];
let b = xs[right];
let xs = [...xs, [left]: b];
let xs = [...xs, [right]: a];
xs
```

Angle-bracket collection literals are target-typed and lower through collector members on the
expected type. a spread can append a tail collection when the expected collector supports it:

```fig
let tail: Layout.InlineArrayList(3, i32) = <1, 2, 3>;
let ys: Layout.InlineArrayList(4, i32) = <0, ...tail>;
```

## Operators

The parser accepts these binary operator symbols: `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `<=`,
`>`, `>=`, `&&`, `||`, `^^`, `<>`, `<$>`, `<*>`, `>>=`, `zip`, and `..`.

Primitive operators are available for primitive types where implemented. Other operator calls are
resolved through visible operator descriptors, commonly imported through `prelude.operators` or
`prelude.std`.

Type expressions support `==` and `!=` for compile-time comparison.
