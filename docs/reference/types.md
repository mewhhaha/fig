# Fig Types

Value type annotations use primitive names, function types, record/shape syntax, tuple syntax,
counted repeats, and type function calls:

```fig
i32
bool
std.core.Option(i32)
fn(x: i32) -> i32
{x: i32, y: i32}
{4*i32}
[i32, bool]
[i32; 4]
type
```

Primitive scalar types currently include `bool`, `i32`, `i64`, `u32`, `u64`, `f32`, `f64`, `string`,
and unsigned widths `u1` through `u64`.

Use `@type_is_number(t)` in compile-time contracts to test whether `t` is one of the numeric scalar
types, including arbitrary unsigned widths such as `u3` or `u17`.

Function types are `fn(params) -> Type`. Effect rows are part of function declarations and typed
capabilities, written as `!{effect, other}` or `!{}`.

## Shapes, Products, and Unions

Shape/product types use braces. Slots may be labeled, anonymous, or explicitly positioned:

```fig
{x: i32, y: i32}
{i32, bool}
{fst: i32, [0]: i32, [1]: bool}
```

Tuple types use brackets and lower to positional product shapes:

```fig
[i32, bool]
[i32; 3]
```

Define concrete product and sum layouts with type functions:

```fig
type fn Point() -> struct {
  let Point = {x: i32, y: i32};
  struct(Point)
}

type fn Option(a: type) -> union {
  let None = {};
  let Some = {value: a};
  union(None, Some)
}
```

`struct(ShapeBinding)` creates a product type from one type-block shape binding. `union(a, b, ...)`
creates a sum type from type-block shape bindings. For a union, each binding name becomes the
variant constructor name and the bound shape becomes the payload shape.

## Repeats and Constructors

Inline counted arrays use repeat syntax in shapes:

```fig
{4*i32}
{N*a}
[a; N]
```

Values can be composed with the function-shaped builder API:

```fig
InlineArray.tabulate(4, i32, make_value)
```

The grammar also accepts PascalCase and lowercase repeat prefixes in type shapes, such as `N*a` or
repeated prefix forms used by type-level shape construction.

Product construction uses the constructor introduced by `struct`:

```fig
Point {x: 1, y: 2}
```

Union constructors use the PascalCase variant names introduced by `union`.
