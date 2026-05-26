# Fig Syntax

Fig source files use the `.fig` extension. A program is a sequence of `type`, `type fn`,
`contract fn`, `const`, `fn`, `pub fn`, and top-level `let` declarations.

## Names

Lowercase identifiers match `[a-z_][a-z0-9_]*` and are used for functions, locals, fields, host IO
import aliases, primitive type names, and ordinary value bindings. PascalCase identifiers match
`[A-Z][A-Za-z0-9]*` and are used for product constructors, union variants, type functions, and
type-level local shape bindings.

Qualified names use `.` for namespace/module qualification and `::` for attached members or
associated contracts, for example `prelude.option.Option`, `Point::eql`, or
`Geometry.Layout::vertex2d_i32`. Literal tags begin with `#`, for example `#field`, `#Some`, and
`#infixl`.

## Surface Shape

Fig’s syntax is intentionally explicit about phase and evidence. The Zig-like part is compile-time
computation through `type fn`, `const` parameters, static reflection, and erased proofs. The
Haskell-like part is contracts, attached members, operators, and `do` strategies for monadic,
applicative, and IO sequencing.

There is no implicit typeclass search. Generic behavior is carried by visible contracts, proof
constants, attached members, or fully spelled do-strategy types such as `State(World, _)`.
Compiler-owned `@...` forms are valid only in their documented contexts.

## Contract Rewrites

Compiler-facing rewrite facts use `contract fn ... -> rewrite`. This is the only rewrite declaration
form; ordinary `fn ... -> rewrite`, `type fn ... -> rewrite`, and `rewrite` type annotations are
rejected.

```fig
contract fn Option::bind_left_zero() -> rewrite {
  @assume(
    \f -> Option::bind(Option::zero(), f),
    \f -> Option::zero()
  )
}

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

`@assume(lhs_template, rhs_template)` is valid only as the final expression of a
`contract fn ... -> rewrite` body. Contract rewrite parameters must be `const`; proof constants may
appear before the final `@assume`.

## Doc Comments

Doc comments start with `///` and attach as raw markdown text to the immediately following binding
when there is no blank line, ordinary `//` comment, or code between the comment block and the
binding. The compiler stores the text on the checked AST, and LSP hover renders the text below the
symbol signature. TSDoc-style tags such as `@param` and `@returns` are accepted by the hover
renderer when they are well formed.

```fig
/// Adds two numbers.
fn add(
  /// Left operand.
  a: i32,
  /// Right operand.
  b: i32
) -> i32 {
  /// Sum before returning.
  let sum = a + b;
  sum
}

/// a generic point product.
type fn Point(
  /// Coordinate type.
  a: type
) -> struct {
  /// Product payload shape.
  let Point = {
    /// Horizontal coordinate.
    x: a,
    /// Vertical coordinate.
    y: a,
  };
  struct(Point)
}
```

Multiple contiguous `///` lines join with newlines after stripping the marker and at most one
following space. Ordinary `//` comments remain non-doc comments.

## Imports and Host IO

Import a module with a top-level const:

```fig
const std = @import("prelude.std");
const local = @import("./local_module.fig");
```

The alias becomes a namespace. Imported declarations stay qualified through the alias; imports do
not merge declarations into local scope. Duplicate import aliases are rejected.

Destructured source imports select exact declarations as unqualified local bindings:

```fig
const { map4_i32, lane4_add_i32 } = @import("prelude.array_static");
```

Destructured import entries are plain declaration names. Aliases, dotted names, annotations, and
non-`@import` right-hand sides are rejected. Namespace imports qualify only the declarations owned by
the imported module. Transitive dependency names keep their own namespace, so import `prelude.layout`
directly when you want names such as `layout.Lane4I32`.

Host imports are top-level consts whose value is `@external("name", fn(...))`. The function type
takes the compiler primitive `io` executor as its first parameter and returns an `io(T)` action:

```fig
const clock = @external("clock", fn(host: io) -> io(i32));
```

Host IO imports lower to WebAssembly imports from module `env`. Pass the `io` executor explicitly
and sequence actions with `do @io(_)`:

```fig
pub fn main(host: io) -> io(i32) {
  do @io(_) {
    now <- clock(host);
    return(now)
  }
}
```

## Constants and Lets

Top-level constants are compile-time values:

```fig
const answer = 42;
const eql: fn(a: i32, b: i32) -> bool = i32.eql;
```

Top-level `let` binds a simple value:

```fig
let size = 4;
let value: i32 = 1;
let inferred: _ = 1;
```

`_` in a top-level or local `let`/`const` annotation asks the checker to fill the concrete type from
the initializer.

## Functions and Parameters

Functions use `fn name(params) -> Type { ... }`. `pub fn` exports through the WebAssembly backend
and must include an explicit return annotation; `-> _` is accepted when the body resolves to a
concrete exportable type.

```fig
fn add(a: i32, b: i32) -> i32 { a + b }
fn inferred() -> _ { 1 }
pub fn main() -> i32 { add(40, 2) }
```

Attached member functions use `::` names and are visible to type reflection:

```fig
fn Point::eql(a: Point, b: Point) -> bool { a.x == b.x }
```

Repeated functions with the same name are ordered clauses. Clauses must keep compatible visibility,
arity, return type, and runtime parameter representation. Refined `i32(...)` domains may vary by
clause because they all lower to runtime `i32`. The first matching clause wins.

```fig
fn score(true: bool, true: bool) -> i32 { 3 }
fn score(_: bool, _: bool) -> i32 { 0 }
```

Parameter forms include:

```fig
fn f(x: i32) -> i32 { x }
fn g(const f: fn(x: i32) -> i32, x: i32) -> i32 { f(x) }
fn h(1: i32) -> i32 { 10 }
fn ignore(_: i32) -> i32 { 0 }
fn variant(Some(value): Option(i32)) -> i32 { value }
fn tuple([left, right]: Pair) -> i32 { left + right }
```

Refined scalar domains can be used for recursive and overloaded clause selection:

```fig
fn go(i: i32(4), acc: i32) -> i32 { acc }
fn go(i: i32(0..4), acc: i32) -> i32 { go(i + 1, acc + i) }
```

`const` parameters are compile-time parameters. They specialize at call sites and are erased from
runtime parameters where possible.

Inline const-function literals can be passed where a `const fn` parameter is expected:

```fig
fn map4_i32(const f: fn(x: i32) -> i32, xs: Lane4I32) -> Lane4I32 {
  [f(xs[0]), f(xs[1]), f(xs[2]), f(xs[3])]
}

map4_i32(\x -> x + 1, xs)
fold4_i32(\(acc, x) -> acc + x, 0, xs)
```

They are compile-time templates, not runtime closure values.

## Blocks and Patterns

Blocks contain `let` statements, local proof consts, and an optional final expression:

```fig
{
  let x = 1;
  const Proof = Eq(i32);
  x + 1
}
```

Local lets require semicolons and are source-ordered; a local can only reference earlier locals in
the same block. Multi-bind destructuring requires a value with multiple runtime result slots:

```fig
let first, second = make_pair();
let [head, tail] = make_pair();
```

Patterns are `_`, lowercase bindings, literals, tuple patterns, and PascalCase variants with
optional payload args:

```fig
match maybe {
  Some(value) => value,
  None => 0,
}
```

There is no assignment statement. Use fresh local names for pure intermediate values, or use
`do @monad(State(T, _))` when source order represents an ordered state transition.

Do-strategy annotations must use a fully applied type constructor with `_` for inferred value
positions: `do @monad(Option(_))`, `do @monad(Box(_))`, `do @monad(State(World, _))`, and
`do @monad(Reader(Env, _))`. Bare constructors such as `@monad(Option)` or partial calls such as
`@monad(State(World))` are invalid.

## Literals

Literal forms are:

```fig
42
42i32
1u32
1i64
1u64
1.0f32
1.0f64
true
false
'x'
"fig"
#Some
```

Fenced text literals use triple backticks and are useful for shader source.

## Rejected Syntax

`static for` statement blocks and record/product `for` slots are not supported as surface loop
syntax. Use recursive helpers over refined domains for fixed repetition, and use `type fn` helpers
with const shapes for record/type-shape metaprogramming.

Array-comprehension-style literals such as `[for i in 0 .. 3: expr]` are rejected. Use tuple/list
literals, inline-array helpers, or recursive builders instead.
