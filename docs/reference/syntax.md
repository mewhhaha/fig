# Fig Syntax

Fig source files use the `.fig` extension. A program is a sequence of `type fn`, `const`, `fn`,
`pub fn`, and top-level `let` declarations.

## Names

Lowercase identifiers match `[a-z_][a-z0-9_]*` and are used for functions, locals, fields,
capabilities, imports, primitive type names, and type functions. PascalCase identifiers match
`[A-Z][A-Za-z0-9]*` and are used for product constructors, union variants, and type-level local
shape bindings.

Qualified names use dots, for example `std.option_map`, `point.eql`, or
`geometry.layout.vertex2d_i32`. Literal tags begin with `#`, for example `#field`, `#Some`, and
`#infixl`.

## Doc Comments

Doc comments start with `///` and attach as raw markdown text to the immediately following binding
when there is no blank line, ordinary `//` comment, or code between the comment block and the
binding. The compiler stores the text for future tools such as hover providers; it does not parse
markdown or TSDoc tags yet.

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

/// A generic point product.
type fn point(
  /// Coordinate type.
  A: type
) -> struct {
  /// Product payload shape.
  let Point = [
    /// Horizontal coordinate.
    x: A,
    /// Vertical coordinate.
    y: A,
  ];
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
fn point.eql(a: point, b: point) -> bool { a.x == b.x }
```

Repeated functions with the same name are ordered clauses. Clauses must keep compatible visibility,
arity, return type, effect row, and parameter types. The first matching clause wins.

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
fn variant(Some(value): option(i32)) -> i32 { value }
```

`const` parameters are compile-time parameters. They specialize at call sites and are erased from
runtime parameters where possible.

## Blocks and Patterns

Blocks contain `let` statements, local proof consts, and an optional final expression:

```fig
{
  let x = 1;
  const Proof = eq(i32);
  x + 1
}
```

Local lets require semicolons. Multi-bind destructuring requires a value with multiple runtime
result slots:

```fig
let first, second = make_pair();
```

Patterns are `_`, lowercase bindings, literals, and PascalCase variants with optional payload args:

```fig
match maybe {
  Some(value) => value,
  None => 0,
}
```

There is no assignment statement and no `if` expression; use `let` and `match`.

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
