# Fig Semantics

## Branch-Bit Values

Fig's intended value model is Branch-Bit values: ordinary values are immutable, passing or assigning
a value is conceptually cheap, and updating a value returns a new logical value while the original
value remains valid. Heap values use hidden branch handles and copy-before-write when a physical
object is observed through multiple logical values, but pointer identity is not part of the ordinary
value semantics.

Local `let` names are unique within a statement block. Use fresh names for pure intermediate values:

```fig
let stepped = step(world);
let updated = update_player(stepped);
updated
```

Ordinary local `let` statements are source-ordered pure bindings, not assignment or in-place update
steps. When a sequence is intentionally ordered, make that ordering explicit with a monad:

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

Fig source functions are pure by default. Volatile host actions use the compiler primitive `io`:
`@external` functions must take the `io` executor as their first parameter and return `io(T)`. Use
`do @io(_)` or `do @io(T)` to sequence these runtime actions.

Library-level reader/state effects are modeled with typed rows from `prelude.effect`. The row names
the carried context types, and handlers such as `run_state` and `run_reader` supply those contexts:

```fig
const effect = @import("prelude.effect");

fn program() -> effect.Eff({state: Store, reader: Env}, i32) {
  do @monad(effect.Eff({state: Store, reader: Env}, _)) {
    env <- effect.ask();
    store <- effect.get();
    effect.put(store + env);
    effect.Eff::pure(store)
  }
}

pub fn main(env: Env, seed: Store) -> i32 {
  let result = program()
    \program -> effect.run_state(program, seed)
    \program -> effect.run_reader(program, env);
  result.value
}
```

When a computation needs more than one context, run handlers in source order with named pipe-bind.
This keeps the values explicit without nesting handler calls.

ECS code uses the same transparent layering: query-builder functions return typed `ecs.Query(...)`
tokens, `do @monad(ecs.System(...))` sequences real system functions, and commands are explicitly
evaluated against a world value.

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
prelude. Use fixed inline arrays and host IO imports for lower-level work.

The public Wasm ABI is the stable Fig memory ABI. Scalar values stay in ordinary Wasm params and
results. Products, fixed inline arrays, strings, heap arrays, sums, and any other value that needs
more than one scalar slot cross public `pub fn` exports and `@external` imports as `i32` handles
into `fig_objects`. The compiler emits a `fig.abi` custom section that describes public exports,
host imports, value layouts, variant and heap-array metadata, memories, object headers, and helper
names. Host code can parse that manifest or use the TypeScript helpers `instantiateFig`,
`createFigHost`, `encodeFigValue`, and `decodeFigValue`.

`fig_objects` stores object headers followed by flattened payload fields. The current header is
`layout_id`, `payload_bytes`, `flags`, and `ref_count`, each a little-endian `i32`; payload fields
start 16 bytes after the handle. String payload slots store a pointer to a `fig_buffers` UTF-8 byte
buffer. `fig_buffers` uses the same header shape for byte buffers with layout id zero. The runtime
exports `fig_abi_version`, `fig_alloc_object`, `fig_alloc_buffer`, `fig_retain`, and `fig_release`
when a module needs ABI heap passing. The allocators are bump allocators and grow the target memory
when the next object no longer fits.

Internally, Branch-Bit code can still use flattened locals and branch heap handles. Branch code
emits `fig_objects` and `fig_buffers` memories and currently packs internal branch handles as an
`i64` whose high 32 bits are zero and low 32 bits contain the object pointer. Source programs use
ordinary values and public boundaries use the stable Fig memory ABI.
