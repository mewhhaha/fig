# Zig Patterns in Fig

This guide maps Zig idioms to Fig. The closest fit is Zig's emphasis on explicit code, compile-time
execution, layout control, and performance visibility. Fig expresses those ideas through type
functions, const parameters, static reflection, fixed inline values, Branch-Bit value semantics, and
WebAssembly inspection.

The practical rule is:

- Zig `comptime` parameters become Fig `const`, `type`, `count`, or type-constructor parameters.
- Zig generic types become Fig `type fn`.
- Zig compile errors become `@require` or `@compile_error`.
- Zig reflection over fields becomes shape and type reflection builtins.
- Zig fixed arrays become counted inline arrays.
- Zig mutable buffers and pointer-heavy code become value layouts plus backend-managed memory.

## Type Functions as Comptime

Zig:

```zig
fn Vec(comptime N: usize, comptime T: type) type { ... }
```

Fig:

```fig
type fn InlineArray(n: count, a: type) -> type {
  let InlineArray = {n*a};
  struct(InlineArray)
}
```

`count` is the kind for static sizes. `type` is the kind for static type values. `const` is the
general kind for static values such as shapes, labels, dictionaries, and metadata.

Use explicit result kinds when they matter:

```fig
type fn Row(a: type) -> struct {
  let Row = {value: a};
  struct(Row)
}

type fn Maybe(a: type) -> union {
  let None = {};
  let Some = {value: a};
  union(None, Some)
}
```

## Static Parameters

Fig functions can take static parameters with `const`:

```fig
fn scale(const factor: i32, value: i32) -> i32 {
  value * factor
}
```

Use `const` when the value should be known to the checker and optimizer. Use ordinary parameters
when the value is runtime data.

Common static parameter shapes:

| Zig shape                    | Fig shape                                      |
| ---------------------------- | ---------------------------------------------- |
| `comptime T: type`           | `const t: type` or `a: type` in `type fn`      |
| `comptime n: usize`          | `const n: count` or `n: count` in `type fn`    |
| `comptime f: fn(...) ...`    | `const f: fn(...) -> ...`                      |
| `comptime tag: enum literal` | `const tag` with literal values such as `#key` |
| generated struct fields      | shape values plus `struct(Shape)`              |

## Compile-Time Validation

Zig:

```zig
if (!condition) @compileError("message");
```

Fig:

```fig
type fn PositiveWidth(n: count) -> type {
  @require(n > 0, "width must be positive");
  i32
}
```

Use `@require(condition, "message")` inside type and const evaluation when failure should produce a
focused diagnostic. Use `@compile_error("message")` when the branch is unconditionally invalid.

## Shape Reflection

Fig represents product layout slots as shapes at compile time. Given a product type, use reflection
to inspect and transform its shape:

```fig
type Payload = struct {id: i32, score: i32, debug: bool}

type fn KeepRuntimeSlot(key: const, _value: const) -> type {
  match key {
    #id => true,
    #score => true,
    _ => false,
  }
}

type fn RuntimeDescriptor(row: type) -> type {
  let Slots = @type_slots(row);
  let RuntimeSlots = @shape_filter(Slots, KeepRuntimeSlot);
  @require(@shape_count(RuntimeSlots) == 2, "descriptor expects two runtime slots");
  struct(RuntimeSlots)
}
```

Important reflection tools:

| Builtin                        | Purpose                                    |
| ------------------------------ | ------------------------------------------ |
| `@type_slots(t)`               | Product slots as a shape                   |
| `@type_has_slot(t, #field)`    | Check a product slot                       |
| `@type_slot_type(t, #field)`   | Read a product slot type                   |
| `@type_variants(t)`            | Union variants as a shape                  |
| `@type_variant_slots(t, #Var)` | Read a union variant payload shape         |
| `@shape_count(shape)`          | Count shape entries                        |
| `@shape_pick(shape, keys)`     | Keep selected slots                        |
| `@shape_omit(shape, keys)`     | Drop selected slots                        |
| `@shape_filter(shape, pred)`   | Keep slots accepted by a mapper            |
| `@shape_map(shape, mapper)`    | Transform slot values                      |
| `@shape_map_with_key(...)`     | Transform slots with key and value         |
| `@shape_concat(a, b)`          | Combine shapes, rejecting duplicate labels |
| `@shape_rename(shape, names)`  | Rename labels                              |

Mapper type functions used with shape builtins take static values:

```fig
type fn RewriteSlot(key: const, value: const) -> type {
  match key {
    #debug => bool,
    _ => value,
  }
}
```

## Layout Construction

Use shape bindings to construct runtime layouts:

```fig
type fn Header(payload: type) -> type {
  let Header = {
    len: i32,
    value: payload
  };
  struct(Header)
}
```

Use direct type declaration sugar for fixed layouts:

```fig
type Vec2 = struct {x: i32, y: i32}
type Pixel = struct {r: u8, g: u8, b: u8, a: u8}
```

Use `union(...)` for tagged alternatives:

```fig
type DrawCommand = union {
  Clear(color: i32),
  Rect(x: i32, y: i32, w: i32, h: i32)
}
```

## Fixed Inline Arrays

Zig fixed array:

```zig
var xs: [4]i32 = .{1, 2, 3, 4};
```

Fig fixed inline array:

```fig
type fn Lane4I32() -> type {
  let Lane4I32 = {4*i32};
  struct(Lane4I32)
}

fn values() -> Lane4I32 {
  #[1, 2, 3, 4]
}
```

The prelude exposes fixed layouts and helpers in `prelude.layout`, `prelude.array_static`, and
`prelude.std`.

Prefer fixed inline arrays when:

- The length is known statically.
- You want values flattened into scalar Wasm locals and results where possible.
- You want the optimizer to see map/fold/update structure.
- You do not need allocation-backed growth.

When growth is required, import `prelude.vec` directly. Its `Vec(A)`, `Slice(A)`, and `Builder(A)`
helpers are heap-backed ordinary Fig values; fixed inline arrays remain the better choice when the
length is statically known and you want scalar-local lowering.

## Index Proofs and Bounds

Use refined index types when a dynamic index must be proven in range:

```fig
const core = @import("prelude.core");

fn at4(xs: [i32; 4], i: core.Index(4)) -> i32 {
  xs[i]
}
```

`Index(n)` is a refined `i32(0..n)` type. When you have an ordinary `i32`, convert with checked
helpers such as `Index::try` and handle the resulting option.

This is the Fig equivalent of pushing bounds checks toward static facts instead of scattering
unchecked pointer arithmetic through the program.

## Value Updates Instead of Pointer Mutation

Zig often writes in-place updates through pointers or slices. Fig source writes new values:

```fig
type Particle = struct {x: i32, vx: i32}

fn step(p: Particle) -> Particle {
  Particle {x: p.x + p.vx, vx: p.vx}
}
```

For fixed-size values, this usually lowers to scalar locals rather than heap allocation. Reusing a
value is ordinary Fig code:

```fig
let old_score = score(world);
let stepped = step(world);
old_score + score(stepped)
```

The backend handles flattening, local reuse, tail-loop lowering, copy-before-write heap objects, and
stable ABI handles.

## Memory Model

Fig source does not expose Zig-style allocators, raw pointers, slices, or manual `free`. The public
Wasm ABI is the stable Fig memory ABI:

- Scalars cross public exports/imports directly.
- Products, fixed inline arrays, strings, heap arrays, sums, and wider flattened values cross as
  `i32` handles into `fig_objects`.
- Large byte data uses `fig_buffers`.
- Layout metadata is emitted in the `fig.abi` custom section.
- Host code should use `instantiateFig`, `createFigHost`, `encodeFigValue`, and `decodeFigValue`.

Source code should model data as values and fixed layouts. Backend memory details are intentionally
not ordinary Fig syntax.

## Branch-Bit Efficiency

Branch-Bit values let source code stay value-oriented while the backend chooses efficient storage.
The programmer-facing rules are:

- Passing a value does not consume it.
- Updating a value creates a new logical value.
- Fixed products and inline arrays are flattened into Wasm locals and parameters when possible.
- Heap objects use hidden branch handles and copy-before-write when shared or pinned.
- Public ABI handles are stable and described by metadata.

This gives you Zig-like predictability without exposing pointer ownership in the source language.

## Static Operation Dictionaries

Zig often passes comptime operation sets. Fig can model these as static types or value dictionaries.

```fig
type ScaleOps = struct {factor: i32}

fn scale_i32(ops: ScaleOps, x: i32) -> i32 {
  x * ops.factor
}

fn map2(ops: ScaleOps, xs: [i32; 2]) -> [i32; 2] {
  #[scale_i32(ops, xs[0]), scale_i32(ops, xs[1])]
}
```

For more static dispatch, use contracts and attached members:

```fig
type fn ScalarOp(t: type) -> type {
  let Expected = fn(x: t) -> t;
  @require(@type_has_member(t, #apply), "ScalarOp requires apply");
  @require(@type_member_type(t, #apply) == Expected, "ScalarOp.apply has wrong type");
  t
}
```

Use ordinary value dictionaries when runtime data is useful. Use `const` proof dictionaries when the
operation set is compile-time evidence.

## Schedule and Metadata Types

Zig performance code often carries static layout and scheduling facts. Fig can encode those as
ordinary product types or static contracts:

```fig
type Schedule2x3 = struct {
  rows: i32,
  cols: i32,
  vector_width: i32,
  unroll: i32
}

type ScheduledMatrix = struct {
  data: Matrix2x3I32,
  schedule: Schedule2x3
}
```

The checked examples `examples/perf_schedule_dsl.fig` and `examples/zig_static_matrix_schedule.fig`
show this style. The metadata is explicit data unless a type function consumes it at compile time.

## Host IO

Zig imports and exports are explicit. Fig host IO is also explicit:

```fig
const read_tick = @external("read_tick", fn(host: io) -> io(i32));

pub fn main(host: io) -> io(i32) {
  do @io(_) {
    tick <- read_tick(host);
    return(tick + 1)
  }
}
```

External imports must take `io` first and return `io(T)` actions. Pure Fig functions do not perform
host effects.

## Inspecting Generated Wasm

Use the CLI like a Zig developer would use build output and disassembly:

```bash
fig check examples/zig_static_matrix_schedule.fig
fig wat examples/zig_static_matrix_schedule.fig
fig build examples/zig_static_matrix_schedule.fig
fig run examples/hello.fig
```

Use compile profiling when changing compiler behavior:

```bash
fig check examples/perf_arrays.fig --compile-profile
```

Use runtime profiling around source expressions:

```fig
fn measured(x: i32) -> i32 {
  @profile("hot step") {
    x + 1
  }
}
```

Then run:

```bash
fig run examples/hello.fig --runtime-profile
```

Use `@trace("message");` in debug builds for breadcrumbs. Release builds erase traces.

## What Not To Translate Literally

- Do not write source-level allocators, pointers, or slices. Model values and let the backend manage
  storage.
- Do not use `comptime` syntax. Use `type fn`, `const`, `type`, and `count`.
- Do not use `var` or assignment. Use fresh `let` names.
- Do not use unchecked pointer arithmetic for speed. Use refined indexes, fixed inline arrays, and
  static proofs.
- Do not encode application-specific shortcuts in the compiler. Express requirements through type
  functions, contracts, reflection, intrinsics, or library code.

## Checklist

When porting Zig-shaped code to Fig:

1. Move generic type construction into `type fn`.
2. Replace `comptime` parameters with `type`, `count`, or `const`.
3. Replace `@compileError` branches with `@require` or `@compile_error`.
4. Replace field reflection with `@type_slots` and shape builtins.
5. Prefer fixed inline arrays for static-size data.
6. Use refined indexes for dynamic access into fixed data.
7. Write value updates with fresh names.
8. Keep host IO explicit through `io(T)` actions.
9. Inspect generated WAT and profiles when performance matters.
