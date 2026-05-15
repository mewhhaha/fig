# Fig Syntax

Fig source files use the `.fig` extension. a program is a sequence of `type fn`, `const`, `fn`,
`pub fn`, and top-level `let` declarations.

## Names

Lowercase identifiers match `[a-z_][a-z0-9_]*` and are used for functions, locals, fields,
capabilities, imports, primitive type names, and type functions. PascalCase identifiers match
`[a-Z][a-Za-z0-9]*` and are used for product constructors, union variants, and type-level local
shape bindings.

Qualified names use dots, for example `Option.map`, `Point::eql`, or `Geometry.Layout.vertex2d_i32`.
Literal tags begin with `#`, for example `#field`, `#Some`, and `#infixl`.

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

## Imports and Capabilities

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
non-`@import` right-hand sides are rejected. Namespace imports can qualify nested imports, so a
module imported as `std` can expose names such as `std.array.Layout.lane4_i32`.

Host imports are top-level consts whose value is `@capability("name")` and whose type is a function
type:

```fig
const clock: fn() -> i32 !{time} = @capability("clock");
```

Capabilities lower to WebAssembly imports from module `env`. Calling a capability requires the
enclosing function effect row to contain the capability effects.

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
```

## Functions and Parameters

Functions use `fn name(params) -> Type !{effects} { ... }`. `pub fn` exports through the WebAssembly
backend and must include an explicit return type.

```fig
fn add(a: i32, b: i32) -> i32 { a + b }
pub fn main() -> i32 { add(40, 2) }
```

Attached member functions use dotted names and are visible to type reflection:

```fig
fn Point::eql(a: Point, b: Point) -> bool { a.x == b.x }
```

Repeated functions with the same name are ordered clauses. Clauses must keep compatible visibility,
arity, return type, effect row, and runtime parameter representation. Refined `i32(...)` domains may
vary by clause because they all lower to runtime `i32`. The first matching clause wins.

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

Local lets require semicolons. Multi-bind destructuring requires a value with multiple runtime
result slots:

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

There is no assignment statement; bind updated values with `let` shadowing.

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
