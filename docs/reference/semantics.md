# Fig Semantics

## Branch-Bit Values

Fig's intended value model is Branch-Bit values: ordinary values are immutable, passing or assigning
a value is conceptually cheap, and updating a value returns a new logical value while the old value
remains valid. Heap values use hidden branch handles and copy-before-write when a physical object is
observed through multiple logical values, but pointer identity is not part of the ordinary value
semantics.

Local `let` names are unique within a statement block. Use fresh names for pure intermediate
values:

```fig
let stepped = step(world);
let updated = update_player(stepped);
updated
```

Ordinary local `let` statements are dependency-ordered pure bindings, not temporal update steps.
When a sequence is intentionally ordered, make that ordering explicit with a monad:

```fig
let world = do @monad(State(World, _)) {
  step();
  update_player();
}
```

The strategy type is always written at its real arity. `_` marks the carried value type inferred
from the block; it does not stand for the threaded state type.

The source language does not expose borrow, fork, frozen-reference, pointer, or explicit memory
tokens. Reusing a value is ordinary Fig code. Product-return destructuring still uses multi-bind:

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
host effects declare their effect rows in the function type used by `@effect`.

## Const Evaluation and Reflection

Top-level constants, type-function bodies, const parameters, local proof consts, and static builtins
are evaluated at compile time. Static reflection exposes product slots, sum variants, attached
members, shape transforms, and selected WGSL metadata.

Compile-time expressions are intentionally smaller than runtime expressions. Unsupported static
forms report focused diagnostics.

Source-level static `for` forms are rejected, including statement blocks, record/product static
slots, and array-comprehension-style `[for ...]` literals. Fixed repetition is expressed with
recursive functions over refined domains, leaving unrolling or loop lowering to the compiler.

## Recurrence Analysis

The compiler records recursive functions as recurrence summaries before backend lowering. A
recurrence summary groups generated function clauses, records refined `i32(...)` parameter domains,
tracks direct recursive call sites, and classifies the shape as finite static, tail-linear,
structural, or general.

Domain-refined clauses such as `i32(4)` and `i32(0..4)` share the same runtime `i32` representation,
so dispatch remains ordinary value dispatch while the optimizer still has finite domain evidence.
Finite static classification, including tiny non-tail cases, requires a measured refined-domain
parameter whose recursive argument progresses monotonically, remains covered by the clause domains,
and has a non-recursive exit domain. Tail recursion without that proof remains tail-linear. In
release mode, small proven finite-static recurrences with constant measured arguments may be
expanded before the normal optimizer folds the result. Proven direct self-tail recursion may lower
to a Wasm loop or tail-call opcode; broader unrolling, branch-folding, and SIMD decisions should
consume the recurrence summary rather than reconstructing recursion from cloned source bodies.

## Lowering Policy

Prelude functions are allowed to be canonical fixtures, but optimization eligibility is structural.
The compiler should optimize a fixed update, edit chain, fixed fold, or range fold because the
checked source/IR has that shape, not because the callee name belongs to `prelude.*`.

For example, these two functions are expected to be equivalent lowering candidates:

```fig
fn prelude_path(xs: fixed.Array(4, u3), i: i32, v: u3) -> fixed.Array(4, u3) {
  fixed.Array::set(4, u3, xs, i, v)
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
prelude. Use fixed inline arrays and host effects for lower-level work.

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
