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

The `_` token marks an inferred type hole only where the checker has a local expression to inspect.
It is accepted in function return annotations, local and top-level `let`/`const` annotations, nested
annotation positions such as `Box(_)`, and value positions in `do` strategy type calls such as
`Option(_)` or `State(World, _)`.

Holes are rejected in parameter types, external import signatures, type-function bodies, contract
signatures, product fields, and other positions without a local value expression to infer from.

Primitive scalar types currently include `bool`, `i32`, `i64`, `u32`, `u64`, `f32`, `f64`, `string`,
the compiler-owned IO executor type `io`, and unsigned widths `u1` through `u64`.

Use `@type_is_number(t)` in compile-time contracts to test whether `t` is one of the numeric scalar
types, including arbitrary unsigned widths such as `u3` or `u17`.

Function types are `fn(params) -> Type`. Host imports use an explicit first `io` executor parameter
and return `io(T)` actions. Library-level reader/state effects use typed rows such as
`prelude.effect.Eff({state: Store, reader: Env}, A)` and must be handled with `run_state`,
`run_reader`, and `run_pure`.

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

Define fixed product and sum layouts with type declaration sugar:

```fig
type Point = struct {x: i32, y: i32}
type Option(a) = union {None, Some(value: a)}
type Status = enum(i32) {Ready = 1, Done = 2}
```

Use `type fn` when the layout is computed or needs type-level control flow:

```fig
type fn RuntimeDescriptor(row: type) -> struct {
  let Slots = @type_slots(row);
  let RuntimeSlots = @shape_pick(Slots, {id: true, score: true});
  struct(RuntimeSlots)
}
```

`struct(ShapeBinding)` creates a product type from one type-block shape binding. `union(a, b, ...)`
creates a sum type from type-block shape bindings. For a union, each binding name becomes the
variant constructor name and the bound shape becomes the payload shape.

Numeric enums are scalar aliases with named integer members. `type Status = enum(i32) {Ready = 1}`
normalizes to the backing type `i32`, and member references such as `Status::Ready` lower to the
declared integer value while keeping the user-facing enum type in annotations. Enum members can also
be used as match patterns. In a match over a known enum type, bare variants are inferred from the
scrutinee type, so `match status { Ready => 1, _ => 0 }` is equivalent to matching the declared
backing value. Signed numeric enum values such as `Back = -1` are accepted for signed backing types.
Enum backing types must be integer scalar types: `i32`, `i64`, `u32`, or `u64`. Refined `i32(...)`
domains are also accepted as enum backings, and every enum member must be inside the declared
domain:

```fig
type Channel = enum(i32(0..4)) {Red = 0, Green = 1, Blue = 2, Alpha = 3}
```

## Repeats and Constructors

Inline counted arrays use repeat syntax in shapes:

```fig
{4*i32}
{N*a}
[a; N]
```

Values can be composed with the function-shaped builder API:

```fig
InlineArray::tabulate(4, i32, make_value)
```

The grammar also accepts PascalCase and lowercase repeat prefixes in type shapes, such as `N*a` or
repeated prefix forms used by type-level shape construction.

Product construction uses the constructor introduced by `struct`:

```fig
Point {x: 1, y: 2}
```

Union constructors use the PascalCase variant names introduced by `union`.
