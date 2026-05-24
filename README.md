# Fig

Fig is an experimental language/compiler focused on static type functions, Branch-Bit values, and
WebAssembly output.

See `docs/LANGUAGE.md` for the full core-language syntax, semantics, and compiler builtin reference.
For migration-style guides, see `docs/guides/rust-patterns.md`, `docs/guides/haskell-patterns.md`,
and `docs/guides/zig-patterns.md`.

## Using Fig

Use the compiler library from a source checkout:

```ts
import { checkSource, wasmFromSource } from "./src/mod.ts";
```

Run the CLI from a source checkout:

```bash
deno run --allow-read src/cli.ts check examples/hello.fig
deno run --allow-read src/cli.ts fmt examples/hello.fig
deno run --allow-read src/cli.ts wat examples/hello.fig
deno run --allow-read --allow-write src/cli.ts build examples/hello.fig
deno run --allow-read src/cli.ts run examples/hello.fig
```

Run the language server over stdio from a source checkout:

```bash
deno run --allow-read src/lsp/main.ts
```

Download native `fig` binaries from GitHub Releases:

```bash
fig check examples/hello.fig
fig fmt examples/hello.fig
fig wat examples/hello.fig
fig build examples/hello.fig
fig run examples/hello.fig
fig lsp
fig version
```

Release archives are published at `https://github.com/mewhhaha/fig/releases` with `SHA256SUMS`.

Use `--compile-profile` with `check`, `wat`, `build`, or `run` to print compiler phase timings. Use
`--runtime-profile` with `run` to collect `@profile("label") { ... }` sites. Debug builds keep
`@trace("message");` statements available to `fig run`; release builds erase trace statements.

## Type Function Surface

Type functions currently cover several compile-time concepts:

- Layout constructors: products, sums, aliases, function types, shape types, and counted inline
  arrays.
- Type declaration sugar for fixed layouts, such as `type Point = struct {x: i32, y: i32}` and
  `type Option(a) = union {None, Some(value: a)}`, plus `type fn` for computed layouts.
- Static reflection: product/sum/alias checks, slot lookup, variant lookup, and attached member
  lookup.
- Static contracts: `@require`-checked proofs such as `Eq(t)`, `Functor(t)`, `Droppable(t)`, and
  layout predicates.
- Constructor-polymorphic helpers: generic functions can infer type constructors at call sites and
  use local proof consts such as `const Mapper = Functor(t);`.
- Reader, state, and effect carriers: `prelude.monad` exposes compiler-lowered `Reader` and `State`
  computations with `run`, `eval`, and `exec`; `prelude.effect` supports typed reader/state rows
  such as `effect.Eff({state: Store, reader: Env}, A)` with explicit handlers.
- Reader and state examples: `examples/prelude_reader_config.fig`,
  `examples/prelude_state_counter.fig`, and `examples/prelude_reader_state_common.fig` show the
  current explicit helper and named pipe-bind handler style.
- Value-layout modeling: examples encode products, sums, fixed inline buffers, compact arrays, and
  static constraints as compile-time type-function contracts.

See `examples/type_fn_memory.fig` for a checked memory-model sketch that ties these pieces together
without adding runtime proof parameters.

## Branch-Bit Memory Model

Fig source uses Branch-Bit values. Ordinary values are immutable and reusable: passing a value to a
function does not consume it. Local `let` names are unique within a block, so pure update chains use
fresh names for each logical version.

```fig
let stepped = step(world);
let integrated = integrate(stepped);
integrated
```

When source order is the point of the computation, use explicit do notation with the effect type
written at its real arity:

```fig
let world = do @monad(State(World, _)) {
  step();
  integrate();
}
```

Product-return destructuring still uses multi-bind:

```fig
let left, right = split(value);
```

Fig code does not expose `fork`, borrowed types or expressions, frozen references, pointer wrappers,
explicit `memory` parameters, or `@memory_*`/`@ptr_*`/`@freeze` intrinsics. Lower-level storage is
an implementation detail of the backend.

For fixed-size value data, the backend flattens products and inline arrays into scalar Wasm locals
and parameters where possible. Reusing a value usually becomes additional `local.get` instructions,
not a runtime copy. Update-heavy fixed data paths use new flattened values and rely on Wasm locals,
tail-loop lowering, specialization, and SIMD pattern recognition for performance.

The public Wasm ABI is the stable Fig memory ABI. Scalars cross `pub fn` exports and `@external`
imports directly; products, fixed inline arrays, strings, heap arrays, sums, and wider flattened
values cross as `i32` handles into `fig_objects`. Fig modules include a `fig.abi` custom section
with stable layout metadata for objects, fixed arrays, strings, sums, and heap arrays, plus helpers
such as `fig_alloc_object`, `fig_alloc_buffer`, `fig_retain`, and `fig_release`. The TypeScript API
exports `instantiateFig`, `createFigHost`, `encodeFigValue`, and `decodeFigValue` for host-side
calls into Fig modules, including UTF-8 string slots stored through `fig_buffers`.

The Branch-Bit heap runtime uses separate Wasm memories named `fig_objects` and `fig_buffers` for
heap objects and large byte buffers. Transitional internal branch handles are `i64` values whose
high 32 bits are zero and whose low 32 bits contain the object pointer. Heap object headers store
`layout_id`, payload size, flags, and refcount; writes go through copy-before-write when an object
is branched or pinned.

## Performance Layout Sketches

For normal performance-oriented code, prefer `const std = @import("prelude.std");`. The prelude is
pure: it exposes common fragments as nested namespaces for core value data, static contracts such as
`eq`, `semigroup`, `monoid`, `functor`, `applicative`, and `monad`, fixed inline layouts,
fixed-array/lane helpers, functional helpers, pure option/result methods, tuple methods, and
schedule metadata. Existing fragment imports such as `prelude.core`, `prelude.layout`,
`prelude.array_static`, `prelude.function`, `prelude.option`, `prelude.result`, `prelude.tuple`,
`prelude.scalar`, and `prelude.schedule` remain available for smaller surfaces.

```fig
const std = @import("prelude.std");

fn inc(x: i32) -> i32 { x + 1 }

pub fn main() -> i32 {
  let maybe = Option.map(inc, some(1));
  let value = Option.unwrap_or(maybe, 0);
  let bounded = value + 8;
  let pair: Pair(i32, i32) = {first: bounded, second: Result.unwrap_or(ok(2), 0)};
  let swapped = Pair.swap(pair);
  swapped.first + swapped.second
}
```

The `examples/perf_*.fig` files are checked catalog modules for comparing static performance layout
styles under the current language surface:

- `examples/perf_arrays.fig` is the canonical static-kernel sketch. It uses counted inline layouts,
  fixed lane/tile aliases, and const dictionary specialization to show source-level static dispatch.
- `examples/perf_array_dsl.fig` is a Futhark/Dex-inspired array API shape. It keeps regular lane,
  tile, and tensor helpers explicit while making map-style code easier to read.
- `examples/perf_schedule_dsl.fig` is a Halide-inspired schedule vocabulary. It records tile,
  vectorize, and unroll intent as static contracts and metadata.

These examples use value layouts rather than source-level memory tokens. The prelude provides fixed
inline arrays and lane/tile aliases such as `lane4_i32`, `tile2x4_i32`, and `mat4_i32`.

Use fixed inline arrays and iterators for collection-shaped code for now. `prelude.std` exposes the
pure fixed helpers from `prelude.array_static`, including explicit `lane4_*` helpers,
`range_i32`/range iterators, `Iter.map`/`Iter.filter`/`Iter.fold`, and `compact_array` collection
for fixed-capacity filtered results.

Heap-backed lists and growable vectors are intentionally deferred. The standard prelude does not
provide `list`, `vector`, `vec`, `push`, `pop`, `reserve`, or allocation-backed append APIs yet;
those should be built on the backend heap runtime.

`prelude.geometry2d` is a tiny pure playground layer for geometry-shaped programs. It provides
integer `vec2`, `vec3`, packed `rgba8`, `vertex2d_i32`, `quad2d_i32`, and `geometry2d_i32` helpers.
The first entry point is quad-first 2D rendering data: `emit_rect2d` and `emit_quad2d` produce fixed
inline vertex geometry that can later be uploaded by explicit host IO imports.

Browser canvas, GPU, shader metadata, and event IO imports live outside the prelude in `web.canvas`:

```fig
const canvas = @import("web.canvas");
```

Host IO imports are declared with `@external("name", fn(host: io, ...) -> io(T))`. Runtime entry
points pass the primitive `io` executor explicitly and use `do @io(_)` to sequence actions.

## Benchmarking

From a source checkout, run the memory model benchmark harness with:

```bash
deno run --allow-read scripts/bench_memory_model.ts 50000
```

The harness compiles each scenario to Wasm, validates the result, runs the exported `main` many
times, and reports timing plus WAT-shape counters. Current scenarios cover:

- Scalar n-way reuse.
- Product reuse and repeated product updates.
- A 1k-iteration tail-recursive product loop.
- `InlineArray.tabulate` plus `InlineArray.map` builder loops.
- Iterator filter/map/collect into `CompactArray`.
- A 1k-item range fold lowered to a Wasm loop.
- A fixed 4x4 matrix kernel that lowers to SIMD operations.

The numbers are machine-local, but the important regressions to watch are extra helper calls,
unexpected heap/memory operations, missing loops for recursive folds, or missing SIMD operations in
the matrix kernel.

From a source checkout, compare the same scenarios against idiomatic JavaScript and optimized Rust:

```bash
deno run --allow-read --allow-write --allow-run scripts/bench_memory_model_compare.ts 50000
```

That script benchmarks Fig/Wasm, JavaScript running in the current V8 runtime, and Rust compiled
with `rustc -C opt-level=3 -C target-cpu=native`. Rust inputs are passed through `black_box` so the
pure kernels do not disappear into compile-time constants.

From a source checkout, compare the dense ECS batch primitives against a similar optimized Rust
fixed-array kernel:

```bash
deno task bench:ecs-compare -- 100000
```

That benchmark fills a 128-entity position batch, maps it with a velocity, folds the moved positions
into a checksum, and validates the Fig/Wasm and Rust checksums match.
