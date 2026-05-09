# Fig Modules

Prefer `const std = @import("prelude.std");` for ordinary programs. It collects common pure
fragments and operator descriptors. This page summarizes module roles, not full APIs.

Use a namespace import when you want the module surface qualified:

```fig
const array = @import("prelude.array_static");
```

Use a destructured source import when you only want exact declarations as unqualified bindings:

```fig
const { map4_i32, lane4_add_i32 } = @import("prelude.array_static");
```

Destructured imports are top-level source imports only. Entries are plain declaration names; aliases,
dotted names, type annotations, and non-`@import` right-hand sides are not supported.

Namespace imports preserve nested imported namespaces, so a module that imports `prelude.layout` can
expose it as `array.layout` through its own namespace import.

| Import                 | Role                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `prelude.std`          | Common merged pure surface for functions, operators, options/results, tuples, arrays, numeric/order/bool helpers, and schedules. |
| `prelude.core`         | Core static contracts, option/result roots, tuples, index proofs, pointer and memory helpers.                                    |
| `prelude.layout`       | Scalar, lane, tile, matrix, fixed inline-array layouts, collector members, and pointer-oriented layout aliases.                   |
| `prelude.array_static` | Fixed inline array, lane, range iterator, map/zip/fold/reduce, checked get, and compact array helpers.                           |
| `prelude.function`     | Function composition and typeclass-like `functor`, `applicative`, and `monad` helpers.                                           |
| `prelude.operators`    | Operator descriptors for arithmetic, comparison, boolean, append, functor, applicative, and monad syntax.                        |
| `prelude.option`       | Pure option constructors and helpers.                                                                                            |
| `prelude.result`       | Pure result constructors and helpers.                                                                                            |
| `prelude.tuple`        | Tuple and pair helpers.                                                                                                          |
| `prelude.bool`         | Boolean helpers.                                                                                                                 |
| `prelude.num`          | Numeric helpers.                                                                                                                 |
| `prelude.order`        | Ordering/comparison helpers.                                                                                                     |
| `prelude.schedule`     | Static schedule metadata vocabulary.                                                                                             |
| `prelude.geometry2d`   | Pure fixed 2D geometry layout helpers.                                                                                           |
| `web.canvas`           | Browser canvas/GPU/event capabilities plus WGSL shader metadata helpers.                                                         |
| `engine.ecs`           | Experimental engine/ECS-shaped helpers used by examples and tests.                                                               |

Prelude modules are intended to remain pure and portable across the browser and Deno WebAssembly
target. Browser-specific capabilities live under `web.*`.
