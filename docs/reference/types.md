# Fig Types

Value type annotations use primitive names, function types, record/shape syntax, tuple syntax,
counted repeats, type function calls, borrow types, and frozen types:

```fig
i32
bool
memory
std.core.option(i32)
fn(x: i32) -> i32
{x: i32, y: i32}
{4*i32}
[i32, bool]
[i32; 4]
&(point)
#(layout.inline_array(3, i32))
type
```

Primitive scalar types currently include `bool`, `i32`, `i64`, `u32`, `u64`, `f32`, `f64`, `string`,
`memory`, and unsigned widths `u1` through `u64`.

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
type fn point() -> struct {
  let Point = {x: i32, y: i32};
  struct(Point)
}

type fn option(A: type) -> union {
  let None = {};
  let Some = {value: A};
  union(None, Some)
}
```

`struct(ShapeBinding)` creates a product type from one type-block shape binding. `union(A, B, ...)`
creates a sum type from type-block shape bindings. For a union, each binding name becomes the
variant constructor name and the bound shape becomes the payload shape.

## Repeats and Constructors

Inline counted arrays use repeat syntax in shapes:

```fig
{4*i32}
{N*A}
[A; N]
```

Values can be composed with the function-shaped builder API:

```fig
inline_array.tabulate(4, i32, make_value)
```

The grammar also accepts PascalCase and lowercase repeat prefixes in type shapes, such as `N*A` or
repeated prefix forms used by type-level shape construction.

Product construction uses the constructor introduced by `struct`:

```fig
Point {x: 1, y: 2}
```

Union constructors use the PascalCase variant names introduced by `union`.

## Borrowed and Frozen Types

Borrowed parameter types are written as `&(T)`. A value can be borrowed only at a call site that
expects a borrowed parameter:

```fig
fn sum_twice(p: &(point)) -> i32 { p.x + p.x }
let total = sum_twice(&p);
```

Borrowed values cannot be stored in locals, returned, or passed to owned parameters.

Frozen references are written as `#(T)`. Static frozen collection literals use `#[...]` and require
an expected frozen inline-array-like type:

```fig
let xs: #(layout.inline_array(3, i32)) = #[10, 20, 30];
```

Frozen references can be indexed and projected, but they cannot be used where an owned value is
required. Owned values can be frozen through the explicit arena API in `prelude.core`.
