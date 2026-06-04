# Fig Expressions

Expressions include literals, variables, calls, field access, indexing, constructors, shape values,
tuple values, collection literals, matches, `if` sugar, binary operators, ranges, blocks, and
pipe-bind. `rec(...)` is a checked tail-recursive step for the current runtime function.

```fig
add(1, 2)
Point.x
xs[0]
Point {x: 1, y: 2}
{x: 1, y: 2}
[1, [0; 3]]
#[1, 2, 3]
match value { Some(x) => x, None => 0 }
if ready { 1 } else { 0 }
1 .. 4
```

## Tail Recursion

Use `rec(...)` in a function tail position to re-enter the current runtime function with new runtime
parameter values:

```fig
fn sum(n: i32, acc: i32) -> i32 {
  match n {
    0 => acc,
    _ => rec(n - 1, acc + n),
  }
}
```

`rec(...)` must be returned directly from a tail position, and its argument count must match the
function's runtime parameter count. It is invalid in call arguments, arithmetic operands, local
initializers, const-function literals, and top-level bindings.

## Match

Use `match` for variants, literals, refined-domain typed patterns, guards, and other ordered pattern
dispatch. Numeric enum members are patterns too, and bare enum variants are inferred when the
scrutinee has a known enum type.

```fig
fn unwrap_or(value: Option(i32), fallback: i32) -> i32 {
  match value { Some(inner) => inner, None => fallback }
}

fn clamp_domain(value: i32) -> i32 {
  match value {
    n: i32(0..100) => n,
    _ if value < 0 => 0,
    _ => 100,
  }
}

type Status = enum(i32) {Ready = 1, Done = 2}

fn status_score(status: Status) -> i32 {
  match status {
    Ready => 10,
    Done => 20,
    _ => 0,
  }
}
```

When several runtime inputs define the cases, use a function match body. It keeps the function
signature single and puts deconstruction beside the branch results:

```fig
fn score(left: bool, right: bool) -> i32 match {
  true, true => 3,
  true, false => 1,
  _, _ => 0,
}
```

Match arms can carry branch hint tags:

```fig
match value {
  @[likely] 0 => fast_path(),
  @[unlikely] _ => fallback(),
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
let count = fixed.Array::update(7, u3, state.count, r, dec);

match old_count > 1 {
  true => State {...state, perm: rotated, count, r},
  false => advance(State {...state, perm: rotated, count, r: r + 1}, r + 1),
}
```

## Const Functions and Pipe-Bind

Const-function literals provide inline templates where an expected `const fn` parameter supplies the
parameter and return types:

```fig
Option::map(\x -> x + 1, some(1))
RangeIter::fold(xs, 0, \(acc, x) -> acc + x)
Option::map(\x -> { let y = x + 1; y }, some(1))
```

They are compile-time templates, not runtime closure values. They are valid only in expected
`const fn` argument positions and cannot capture runtime locals.

Pipe-bind evaluates the left side, binds it, and evaluates the next atom:

```fig
1 \x -> add(x, 2)
```

Pipe-bind requires a named binding. The `$` placeholder form is not part of the language. Pipe-bind
is intended for short one-step value flow. For state machines or update-heavy code, use fresh
block-local names for pure values or an explicit `do @monad(State(T, _))` sequence for ordered state
transitions.

## Do Strategies

`do` blocks name their sequencing strategy with a static builtin and, for ordinary strategies, an
explicit effect type call:

```fig
do @monad(Option(_)) {
  x <- maybe_value();
  pure(x + 1)
}

do @monad(State(World, _)) {
  step();
  update_player();
}
```

Host IO uses the built-in `do @io(_)` strategy. It sequences `io(T)` actions, binds `<-` names as
`T`, and requires a final `io(T)` action. Use the compiler builtin `return(value)` to lift a pure
value into `io(T)`, and use `do @io(T)` when the carried value type should be written explicitly:

```fig
const clock = @external("clock", fn(host: io) -> io(i32));

pub fn main(host: io) -> io(i32) {
  do @io(_) {
    now <- clock(host);
    return(now + 1)
  }
}
```

The strategy must be a type call whose argument count matches the declared type function arity. Use
`_` only for the value type positions the `do` block should infer. For example, unary monads use
`Option(_)` or `Box(_)`; binary monads use `State(World, _)` or `Reader(Env, _)`.

Bare or partially applied strategy constructors are rejected:

```fig
do @monad(Option) { ... }       // invalid: missing Option value argument
do @monad(Box) { ... }          // invalid: missing Box value argument
do @monad(State(World)) { ... } // invalid: State has arity 2
```

`_` can also appear in expression-backed type annotations when the body or initializer determines
the concrete type:

```fig
fn next() -> _ { 1 }
let next: _ = current + 1;
let wrapped: Box(_) = Box {value: 1};
```

It remains invalid for function parameters or other positions where there is no local body,
initializer, or do-block value type to infer from. State-threaded `do` blocks still require the
state argument to be concrete, such as `State(World, _)` rather than `State(_, _)`.

## Local Bindings and Destructuring

Local `let` bindings must use unique names within the same block. Initializers are source-ordered: a
local can reference parameters, top-level declarations, and earlier locals, but not later locals.

```fig
let start = 1;
let next = start + 1;
next
```

Use fresh names for pure intermediate values. Use `do @monad(State(T, _))` when the source order is
the meaning of the computation.

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

Source-level static slot generation is not part of the expression language. Write explicit record or
product slots, or express fixed repetition through recursive helpers that match refined domains.

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

Fresh local names plus fixed-array spread are the canonical source form for pure edit chains:

```fig
let a = xs[left];
let b = xs[right];
let with_left = [...xs, [left]: b];
let swapped = [...with_left, [right]: a];
swapped
```

Angle-bracket collection literals are target-typed and lower through collector members on the
expected type. A spread can append a tail collection when the expected collector supports it:

```fig
let tail: Layout.InlineArrayList(3, i32) = #[1, 2, 3];
let ys: Layout.InlineArrayList(4, i32) = #[0, ...tail];
```

## Operators

The parser accepts operator symbols made from the operator character set
`+ - * / % < > = ! & | ^ $`. Operator symbols are not compiler features by themselves; they become
meaningful only through visible operator declarations.

Ranges use dedicated `start .. end` syntax. `..` is not an overloadable operator.

All runtime operator calls resolve through visible operator declarations, commonly imported through
`prelude.operators` or `prelude.std`. The primitive arithmetic, comparison, and boolean operators in
the prelude are ordinary declarations that call primitive attached members such as `i32::add` and
`bool::and`; those members wrap backend intrinsics.

Operator declarations are top-level declarations:

```fig
fn append(a: Box, b: Box) -> Box { Box::append(a, b) }
infixr 55 (<>) = append;
```

Type expressions parse the same operator token. The checker currently evaluates only primitive
type-level operators such as `==`, `!=`, and literal-type union `|`; other type-expression operators
are rejected as not type-evaluable.
