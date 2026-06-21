# Fig Syntax

Fig source files use the `.fig` extension. A program is a sequence of `type`, `type fn`, `const`,
operator, `fn`, `pub fn`, and top-level `let` declarations.

Fixed type declarations use these forms:

```fig
type Point = struct {x: i32, y: i32}
type Option(a) = union {None, Some(value: a)}
type Mode = enum(i32) {Read = 1, Write = 2, Back = -1}
type Count = i32
```

## Names

Lowercase identifiers match `[a-z_][a-z0-9_]*` and are used for functions, locals, fields, host IO
import aliases, primitive type names, and ordinary value bindings. PascalCase identifiers match
`[A-Z][A-Za-z0-9]*` and are used for product constructors, union variants, type functions, and
type-level local shape bindings.

Qualified names use `.` for namespace/module qualification and `::` for attached members or
associated contracts, for example `prelude.option.Option`, `Point::eql`, or
`Geometry.Layout::vertex2d_i32`. Literal tags begin with `#`, for example `#field` and `#Some`.

## Surface Shape

Fig’s syntax is intentionally explicit about phase and evidence. The Zig-like part is compile-time
computation through `type fn`, `const` parameters, static reflection, and erased proofs. The
Haskell-like part is contracts, attached members, operators, and `do` strategies for monadic,
applicative, and IO sequencing.

There is no implicit typeclass search. Generic behavior is carried by visible contracts, proof
constants, attached members, or fully spelled do-strategy types such as `State(World, _)`.
Compiler-owned `@...` forms are valid only in their documented contexts.

## Declaration Tags

Tag lists can prefix top-level declarations. Bare lowercase tags are compiler metadata. The
currently supported bare declaration tag is `test`, and it is valid only on function declarations:

```fig
@[test]
fn parses_option() -> bool {
  true
}
```

Declaration tags can also be type-function expressions. These expressions run left to right after
the annotated declaration's signature or type is known. Inside a declaration tag expression, `Self`
names the annotated declaration's type:

```fig
const derive = @import("prelude.derive");
const core = @import("prelude.core");

@[derive.Eq(Self), core.Eq(Self)]
type Point = struct {x: i32, y: i32}

type fn ExportedI32(f: type) -> type {
  @require(@type_is_fn(f), "expected function");
  @require(@type_fn_return(f) == i32, "expected i32 return");
  f
}

@[ExportedI32(Self)]
pub fn main() -> i32 { 1 }
```

For a generic `type Box(a) = ...`, `Self` is `Box(a)`. For a type-constructor declaration, use the
declaration name itself when a contract expects the constructor, such as `@[Functor(Box)]`.

Tags are compiler metadata, not comments. Unknown bare tags are diagnostics, and `@[test]` on a
non-`fn` declaration is rejected. Multiple tag lists can appear before the same declaration, but
duplicate bare tags are rejected. `Self` is rejected outside declaration tag expressions.

## Rewrite Facts

Fig source no longer declares optimizer rewrite facts. Rewrites are compiler-plugin facts, and the
default prelude rewrite plugin provides the standard `Eq`, `Functor`, `Applicative`, `Monad`, and
`Monoid` laws. Source `contract fn ... -> rewrite`, `@assume(...)`, and `rewrite` type annotations
are rejected.

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
non-`@import` right-hand sides are rejected. Namespace imports qualify only the declarations owned
by the imported module. Transitive dependency names keep their own namespace, so import
`prelude.layout` directly when you want names such as `layout.Lane4I32`.

Host imports are top-level consts whose value is `@external("name", fn(...))`. The function type
takes the compiler primitive `io` executor as its first parameter and returns an `io(T)` action:

```fig
const clock = @external("clock", fn(host: io) -> io(i32));
```

External signatures cannot import or export runtime function values.

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

Top-level `@assert(TypeExpr);` evaluates a type-level expression and discards the result:

```fig
@assert(Monoid(Point));
@assert(Functor(Vec));
```

The argument is a type expression. Contract type functions still run their `@require` checks while
evaluating. Concrete arguments are checked immediately; generic arguments are checked when the
surrounding generic code is instantiated.

Top-level `let` binds a simple value:

```fig
let size = 4;
let value: i32 = 1;
let inferred: _ = 1;
```

`_` in a top-level or local `let`/`const` annotation asks the checker to fill the concrete type from
the initializer.

## Functions and Parameters

Functions use either a block body or a match body. `pub fn` exports through the WebAssembly backend
and must include an explicit return annotation; `-> _` is accepted when the body resolves to a
concrete exportable type. Public exports cannot import or export runtime function values.

```fig
fn add(a: i32, b: i32) -> i32 { a + b }
fn choose(flag: bool) -> i32 match {
  true => 1,
  false => 0,
}
fn inferred() -> _ { 1 }
pub fn main() -> i32 { add(40, 2) }
```

Attached member functions use `::` names and are visible to type reflection:

```fig
fn Point::eql(a: Point, b: Point) -> bool { a.x == b.x }
```

Match-body functions dispatch over runtime parameters with the same pattern syntax as `match`.
Multiple runtime parameters are matched positionally, so a two-parameter function can use two
patterns per arm:

```fig
fn score(left: bool, right: bool) -> i32 match {
  true, true => 3,
  true, false => 1,
  false, true => 0,
  false, false => 0,
}

fn unwrap(value: Option(i32)) -> i32 match {
  Some(inner) => inner,
  None => 0,
}
```

Parameter forms include:

```fig
fn f(x: i32) -> i32 { x }
fn g(const f: fn(x: i32) -> i32, x: i32) -> i32 { f(x) }
fn ignore(_: i32) -> i32 { 0 }
```

Runtime functions are limited to five non-`const` parameters. Group related trailing values into a
small product when a function needs more runtime inputs:

```fig
fn weighted_sum(
  a: i32,
  b: i32,
  c: i32,
  rest: struct({d: i32, e: i32})
) -> i32 {
  a + b + c + rest.d + rest.e
}
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

Blocks contain `let` statements, local type assertions, and an optional final expression:

```fig
{
  let x = 1;
  @assert(Eq(i32));
  x + 1
}
```

Local lets require semicolons and are source-ordered; a local can only reference earlier locals in
the same block. Multi-bind destructuring requires a value with multiple runtime result slots:

```fig
let first, second = make_pair();
let [head, tail] = make_pair();
```

Patterns are `_`, lowercase bindings, literals, tuple patterns, enum members such as
`Status::Ready`, bare enum variants when the matched value has a known enum type, PascalCase
variants with optional payload args, and typed patterns. Guard expressions run after the pattern has
matched and can use names bound by that pattern. Typed patterns are useful for refined scalar-domain
cases:

```fig
match maybe {
  Some(value) => value,
  None => 0,
}

match n {
  small: i32(0..4 | 8) => small,
  _ if n > 20 => 20,
  _ => n,
}
```

Match arm values may also be statement-bearing blocks, useful when a branch result needs local
bindings:

```fig
match maybe {
  Some(value) => {
    let next = value + 1;
    next
  },
  None => 0,
}
```

Boolean `if` is expression sugar for `match` on `bool`, and `else if` nests another boolean match in
the fallback arm. Parenthesized `if (let Pattern = value)` is expression sugar for
`match value { Pattern => ..., _ => ... }`, with pattern bindings scoped to the first block:

```fig
if (let Some(value) = maybe) {
  value
} else if fallback_ready {
  1
} else {
  0
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
-1
42i32
1u32
1i64
1u64
1_000
1.0f32
1.0f64
1_000.5f64
true
false
'x'
"fig"
#Some
```

Decimal number literals may use `_` between digits. Fenced text literals use triple backticks and
are useful for shader source.

Number, character, string, and `#Tag` literals can also be used as exact literal types in
annotations and type functions.

## Rejected Syntax

`static for` statement blocks and record/product `for` slots are not supported as surface loop
syntax. Use recursive helpers over refined domains for fixed repetition, and use `type fn` helpers
with const shapes for record/type-shape metaprogramming.

Array-comprehension-style literals such as `[for i in 0 .. 3: expr]` are rejected. Use tuple/list
literals, inline-array helpers, or recursive builders instead.
