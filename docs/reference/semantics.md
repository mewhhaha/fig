# Fig Semantics

## Branch-Bit Values

Fig's intended value model is Branch-Bit values: ordinary values are immutable, passing or assigning
a value is conceptually cheap, and updating a value returns a new logical value while the old value
remains valid. Heap values use hidden branch handles and copy-before-write when a physical object is
observed through multiple logical values, but pointer identity is not part of the ordinary value
semantics.

Repeated `let` bindings are the canonical surface form for carrying the latest version of a value:

```fig
let world = step(world);
let world = update_player(world);
world
```

The right-hand side sees the previous `world`; subsequent expressions see the new one.

The source language does not expose borrow, fork, frozen-reference, pointer, or explicit memory
tokens. Reusing a value is ordinary Fig code; use shadowing when a name should represent a newer
logical value. Product-return destructuring still uses multi-bind:

```fig
let left, right = split(value);
```

## Effects

Effect rows are written as:

```fig
fn pure() -> i32 !{} { 1 }
fn uses_clock() -> i32 !{time} { clock() }
```

An effectful call is rejected unless the caller's effect row covers the callee effects. Host
capabilities declare their effects in the function type used by `@capability`.

## Const Evaluation and Reflection

Top-level constants, type-function bodies, const parameters, local proof consts, and static builtins
are evaluated at compile time. Static reflection exposes product slots, sum variants, attached
members, shape transforms, and selected WGSL metadata.

Compile-time expressions are intentionally smaller than runtime expressions. Unsupported static
forms report focused diagnostics.

Static slots in records and product constructors evaluate a compile-time shape and generate one
field per key. Static `for` statement blocks and array-comprehension-style `[for ...]` literals are
rejected.

## Lowering Policy

Prelude functions are allowed to be canonical fixtures, but optimization eligibility is structural.
The compiler should optimize a fixed update, edit chain, fixed fold, or range fold because the
checked source/IR has that shape, not because the callee name belongs to `prelude.*`.

For example, these two functions are expected to be equivalent lowering candidates:

```fig
fn prelude_path(xs: fixed.Array(4, u3), i: i32, v: u3) -> fixed.Array(4, u3) {
  fixed.Array.set(4, u3, xs, i, v)
}

fn user_path(xs: fixed.Array(4, u3), i: i32, v: u3) -> fixed.Array(4, u3) {
  [...xs, [i]: v]
}
```

When a prelude helper gets optimized, an equivalent user-written shape should get the same
representation decision and Wasm shape modulo names.

## WebAssembly Target

Fig targets WebAssembly 3.0 features supported by current Chromium- and Firefox-family engines and
Deno. Safari/WebKit support is not required unless a task explicitly asks for it.

Prefer the browser and Deno supported subset when adding backend behavior. Heap-backed growable
collections and allocation-backed append APIs are intentionally not part of the current standard
prelude. Use fixed inline arrays and host capabilities for lower-level work.

The Branch-Bit runtime uses multiple internal memories for ordinary heap values: object data and
large byte buffers. Branch code emits `fig_objects` and `fig_buffers` memories and currently packs
branch handles as an `i64` whose high 32 bits are zero and low 32 bits contain the object pointer.
The old source-facing exported `memory` ABI is not part of Fig's public value model.

## Temporal Compatibility

The earlier Temporal Values runtime remains available behind the backend memory mode
`--memory temporal` while migration tests compare both implementations. Temporal compatibility code
emits `fig_objects`, `fig_logs`, and `fig_buffers` memories and packs temporal handles as an `i64`
containing `{ptr: i32, rev: i32}`. Temporal intrinsics are rejected when compiling in `branch` or
`branch-debug` memory mode.
