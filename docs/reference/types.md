# Fig Types

Value type annotations use primitive names, function types, shape/product syntax, counted repeats,
and type function calls:

```fig
i32
bool
memory
std.core.option(i32)
fn(x: i32) -> i32
[x: i32, y: i32]
[4*i32]
type
```

Primitive scalar types currently include `bool`, `i32`, `i64`, `u32`, `u64`, `f32`, `f64`, `string`,
`memory`, and unsigned widths `u1` through `u64`.

Function types are `fn(params) -> Type`. Effect rows are part of function declarations and typed
capabilities, written as `!{effect, other}` or `!{}`.

## Shapes, Products, and Unions

Shape/product types use brackets. Slots may be labeled or anonymous:

```fig
[x: i32, y: i32]
[i32, bool]
[]
```

Define concrete product and sum layouts with type functions:

```fig
type fn point() -> struct {
  let Point = [x: i32, y: i32];
  struct(Point)
}

type fn option(A: type) -> union {
  let None = [];
  let Some = [value: A];
  union(None, Some)
}
```

`struct(ShapeBinding)` creates a product type from one type-block shape binding. `union(A, B, ...)`
creates a sum type from type-block shape bindings. For a union, each binding name becomes the
variant constructor name and the bound shape becomes the payload shape.

## Repeats and Constructors

Inline counted arrays use repeat syntax in shapes:

```fig
[4*i32]
[N*A]
```

Values can be composed with the function-shaped builder API:

```fig
inline_array.tabulate(4, i32, make_value)
```

The grammar also accepts PascalCase and lowercase repeat prefixes in type shapes, such as `N*A` or
repeated prefix forms used by type-level shape construction.

Product construction uses the constructor introduced by `struct`:

```fig
Point [x: 1, y: 2]
```

Union constructors use the PascalCase variant names introduced by `union`.
