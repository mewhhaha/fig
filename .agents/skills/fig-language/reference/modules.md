# Fig Modules

Prefer `const std = @import("prelude.std");` for ordinary programs. It collects common pure
fragments and operator declarations. This page summarizes module roles and import behavior; see
[Prelude Library](prelude.md) for the prelude API surface.

Use a namespace import when you want the module surface qualified:

```fig
const array = @import("prelude.array_static");
```

Use a destructured source import when you only want exact declarations as unqualified bindings:

```fig
const { map4_i32, lane4_add_i32 } = @import("prelude.array_static");
```

Destructured imports are top-level source imports only. Entries are plain declaration names;
aliases, dotted names, type annotations, and non-`@import` right-hand sides are not supported.

Namespace imports qualify only declarations owned by the imported module. Transitive dependency
names keep their original namespace; if code uses layout types, import `prelude.layout` directly
instead of spelling them through another module such as `array.layout`.

| Import                 | Role                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `prelude.std`          | Common umbrella for functions, monads, operators, options/results, tuples, arrays, heap collections, and schedules. |
| `prelude.core`         | Core static contracts, option/result roots, tuples, and index proofs.                                        |
| `prelude.fixed`        | Canonical fixed-size value arrays and direct spread/update/edit helpers.                                     |
| `prelude.fixed_build`  | Builder fallback for constructing fixed values when direct slots are not convenient.                         |
| `prelude.range`        | Canonical runtime `i32` range iterators and self-tail-recursive fold helpers.                                |
| `prelude.scalar`       | Tiny pure bool helpers and generic numeric scalar helpers guarded by `@type_is_number`.                      |
| `prelude.layout`       | Scalar, lane, tile, matrix, fixed inline-array layouts, and collector members.                               |
| `prelude.array_static` | Fixed inline array, lane, range iterator, map/zip/fold/reduce, checked get, and compact array helpers.       |
| `prelude.vec`          | Heap-backed growable `Vec(A)`, `Slice(A)`, and builder helpers over `layout.HeapArray`.                      |
| `prelude.list`         | Persistent cons-style `List(A)` with heap-backed nodes, head/tail, fold, reverse, and map.                   |
| `prelude.nonempty`     | `NonEmpty(A)` wrapper for a guaranteed head plus list tail.                                                  |
| `prelude.queue`        | FIFO `Queue(A)` with push, peek, and pop helpers.                                                           |
| `prelude.tree`         | Heap-node binary `Tree(A)` with optional child views and preorder fold.                                      |
| `prelude.zipper`       | `TreeZipper(A)` focus/crumb navigation for `prelude.tree`.                                                  |
| `prelude.map`          | Ordered map helpers backed by a left-leaning red/black tree and explicit comparator functions.               |
| `prelude.set`          | Ordered set helpers backed by `prelude.map`.                                                                |
| `prelude.graph`        | Directed `i32` graph helpers using `Vec`, `Queue`, and `Set` for traversal.                                  |
| `prelude.function`     | Function composition and typeclass-like `functor`, `applicative`, and `monad` helpers.                       |
| `prelude.monad`        | Binary `State(S, A)` and explicit `Reader(R, A)` helpers for ordered flows.                                  |
| `prelude.effect`       | Transparent capability-tag helpers such as `Eff`, `Reader`, `State`, `Debug`, `With`, and `WithAll`.         |
| `prelude.operators`    | Operator declarations for arithmetic, comparison, boolean, append, functor, applicative, and monad syntax.   |
| `prelude.option`       | Pure option constructors and helpers.                                                                        |
| `prelude.result`       | Pure result constructors and helpers.                                                                        |
| `prelude.tuple`        | Tuple and pair helpers.                                                                                      |
| `prelude.bool`         | Compatibility namespace that imports `prelude.scalar`.                                                       |
| `prelude.num`          | Compatibility namespace that imports `prelude.scalar`.                                                       |
| `prelude.order`        | `Ordering` union plus comparison predicates and `compare_i32`.                                               |
| `prelude.schedule`     | Static schedule metadata vocabulary.                                                                         |
| `prelude.geometry2d`   | Pure fixed 2D geometry layout helpers.                                                                       |
| `web.canvas`           | Browser canvas/GPU/event host IO imports plus WGSL shader metadata helpers.                                  |
| `engine.ecs`           | Experimental ECS sketch for query and system examples built from ordinary Fig module and type-function code. |

Prelude modules are intended to remain pure and portable across the browser and Deno WebAssembly
target. Browser-specific host IO imports live under `web.*`.
