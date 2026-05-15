# Fig Builtins

Builtins are called with `@name(...)` in Fig source. Static type evaluation strips the `@` before
dispatching internally; source code should keep it.

## Compiler Plugin API

The compiler exposes a stable TypeScript plugin API for `@` forms. Hosts pass plugins through
compile/check options; v1 plugins are registered in-process and are not loaded from manifests at
runtime. Each plugin declares `apiVersion: 1`, a unique `id`, and any declaration, static,
annotation, intrinsic, or do-strategy builtins it provides.

First-party compiler behavior is registered through built-in plugins:

| Plugin             | Builtins                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `core-imports`     | `@import`, `@capability`                                          |
| `core-static`      | `@require`, `@compile_error`, `@shape_*`, `@type_*`, `@wgsl_*`    |
| `core-annotations` | `@likely`, `@unlikely`                                            |
| `core-intrinsics`  | backend/compiler intrinsics such as `@branch_*` and `@temporal_*` |

Plugin ids and builtin names must be unique after the built-in plugins are registered. Duplicate
registrations are compile diagnostics. In v1, backend plugins register compiler intrinsic
identities; the low-level lowering for those identities still runs through compiler-owned IR paths
rather than raw Wasm byte emission.

## Module and Capability Builtins

| Builtin       | Arguments               | Returns                       | Phase                             |
| ------------- | ----------------------- | ----------------------------- | --------------------------------- |
| `@import`     | string module specifier | namespace alias value         | top-level const lowering/checking |
| `@capability` | string import name      | annotated function capability | top-level const checking/backend  |

## Diagnostics and Contracts

| Builtin          | Arguments             | Returns | Phase                     |
| ---------------- | --------------------- | ------- | ------------------------- |
| `@compile_error` | optional string       | never   | const and type evaluation |
| `@require`       | bool, optional string | bool    | type evaluation           |

`@require` emits a diagnostic when the first argument is not `true`.

## Type Reflection

These builtins take a type value as their first argument and run during type evaluation. Most also
work during const evaluation when their arguments are compile-time Values.

| Builtin                  | Arguments                                                      | Returns                                     |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------- |
| `@type_is_product`       | `t: type`                                                      | `bool`                                      |
| `@type_is_sum`           | `t: type`                                                      | `bool`                                      |
| `@type_is_alias`         | `t: type`                                                      | `bool`                                      |
| `@type_is_number`        | `t: type`                                                      | `bool`                                      |
| `@type_has_slot`         | `t: type`, `slot: #literal/string`                             | `bool`                                      |
| `@type_slot_type`        | `t: type`, `slot: #literal/string`                             | slot `type`, or diagnostic                  |
| `@type_has_member`       | `t: type`, `member: #literal/string`                           | `bool`                                      |
| `@type_member_type`      | `t: type`, `member: #literal/string`                           | member function `type`, or diagnostic       |
| `@type_has_variant`      | `t: type`, `variant: #literal/string`                          | `bool`                                      |
| `@type_variant_has_slot` | `t: type`, `variant: #literal/string`, `slot: #literal/string` | `bool`                                      |
| `@type_slots`            | `t: type`                                                      | shape of product slots                      |
| `@type_slot_count`       | `t: type`                                                      | numeric slot count; non-products return `0` |
| `@type_variant_slots`    | `t: type`, `variant: #literal/string`                          | shape of variant slots                      |
| `@type_variants`         | `t: type`                                                      | shape describing variants                   |

## Shape Builtins

Shape builtins operate on compile-time shape values such as `{x: i32, y: bool}`.

| Builtin               | Arguments                        | Returns    |
| --------------------- | -------------------------------- | ---------- |
| `@shape_has_slot`     | shape, label                     | `bool`     |
| `@shape_slot`         | shape, label                     | slot value |
| `@shape_count`        | shape                            | number     |
| `@shape_first_key`    | shape                            | first key  |
| `@shape_tail`         | shape                            | shape      |
| `@shape_pick`         | shape, selector shape            | shape      |
| `@shape_omit`         | shape, selector shape            | shape      |
| `@shape_intersect`    | shape, selector shape            | shape      |
| `@shape_difference`   | shape, selector shape            | shape      |
| `@shape_rename`       | shape, rename shape              | shape      |
| `@shape_map`          | shape, one-arg mapper type fn    | shape      |
| `@shape_map_with_key` | shape, two-arg mapper type fn    | shape      |
| `@shape_filter`       | shape, two-arg predicate type fn | shape      |
| `@shape_concat`       | one or more shapes               | shape      |

## WGSL Helpers

| Builtin           | Arguments          | Returns                    | Phase                                          |
| ----------------- | ------------------ | -------------------------- | ---------------------------------------------- |
| `@wgsl_shader_id` | string/fenced text | numeric shader id          | const and type evaluation, expression checking |
| `@wgsl_bindings`  | string/fenced text | `shader_bindings(N)` type  | type evaluation                                |
| `@wgsl_locations` | string/fenced text | `shader_locations(N)` type | type evaluation                                |

The compiler records shader manifest entries when these helpers are evaluated.

## Inline Array Expression Builtins

These builtins are compiler-recognized expression primitives used by the `prelude.layout`
`inline_array` helpers. They generate fixed structural product slots during const specialization;
source code should prefer the public `InlineArray::tabulate`, `tabulate_with`, `imap`,
`imap_with_state`, `fill`, `map`, `set`, and `update` APIs.

| Builtin                         | Purpose                                  |
| ------------------------------- | ---------------------------------------- |
| `@inline_array_tabulate`        | build each slot from its `core.Index(N)` |
| `@inline_array_tabulate_with`   | tabulate with an explicit state value    |
| `@inline_array_map`             | map slots with the current value         |
| `@inline_array_imap`            | map slots with index and current value   |
| `@inline_array_imap_with_state` | indexed map with an explicit state value |
| `@inline_array_fill`            | repeat one value into every slot         |
| `@inline_array_set`             | rebuild with one slot replaced           |
| `@inline_array_update`          | rebuild with one slot transformed        |

## Backend Intrinsics

Backend intrinsics are recognized when a normal Fig function wraps a single intrinsic call. The
wrapper function supplies the public API and types. The public backend surface is limited to hidden
heap-handle support and fixed inline-array construction helpers; explicit memory and pointer
intrinsics are not source-facing Fig builtins.

| Intrinsic                 | Arguments                     | Returns        |
| ------------------------- | ----------------------------- | -------------- |
| `@branch_handle`          | pointer `i32`                 | branch handle  |
| `@branch_handle_ptr`      | branch handle                 | pointer `i32`  |
| `@branch_mark`            | branch handle                 | branch handle  |
| `@branch_is_branched`     | branch handle                 | bool           |
| `@branch_ensure_editable` | branch handle                 | branch handle  |
| `@branch_materialize`     | branch handle                 | branch handle  |
| `@temporal_handle`        | pointer `i32`, revision `i32` | packed handle  |
| `@temporal_handle_ptr`    | packed handle                 | pointer `i32`  |
| `@temporal_handle_rev`    | packed handle                 | revision `i32` |

The `@branch_*` intrinsics are accepted in `branch` and `branch-debug` memory modes. The
`@temporal_*` intrinsics are compatibility-only and are accepted in `temporal` memory mode.
