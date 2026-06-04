# Fig Builtins

Most compiler builtins are called with `@name(...)` in Fig source. Static type evaluation strips the
`@` before dispatching internally; source code should keep it. The exception is `return(value)`,
which is a reserved IO expression builtin used to lift a pure value into `io(T)`.

## Compiler Plugin API

The compiler exposes a stable TypeScript plugin API for `@` forms. Hosts pass plugins through
compile/check options; plugins are registered in-process and are not loaded from manifests at
runtime. Each plugin declares `apiVersion: 1`, a unique `id`, and any declaration, static,
annotation, intrinsic, or do-strategy builtins it provides.

First-party compiler behavior is registered through built-in plugins:

| Plugin             | Builtins                                                                   |
| ------------------ | -------------------------------------------------------------------------- |
| `core-imports`     | `@import`, `@external`                                                     |
| `core-static`      | `@require`, `@compile_error`, and the listed static reflection builtins    |
| `core-annotations` | branch hint tags `@[likely]`, `@[unlikely]`                                |
| `core-intrinsics`  | registered backend/internal intrinsics such as branch and heap-array calls |

Plugin ids and builtin names must be unique after the built-in plugins are registered. Duplicate
registrations are compile diagnostics. Builtin names are registered exactly; a prefix such as
`@type_` or `@branch_` does not reserve every spelling under that prefix. Backend plugins register
compiler intrinsic identities; the low-level lowering for those identities still runs through
compiler-owned IR paths rather than raw Wasm byte emission.

## Special Forms by Context

The compiler classifies first-party special forms by the context where each one is valid. This keeps
`@...` syntax explicit instead of treating all prefixed names as interchangeable builtins.

| Category          | Forms                                                                            | Valid context                                     |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| Declaration       | `@import`, `@external`                                                           | top-level `const` declaration values              |
| Static/type-level | `@require`, `@compile_error`, and the exact static reflection names listed below | type and const evaluation, as documented per form |
| Do strategy       | `@io`, `@monad`, `@applicative`                                                  | `do @strategy(...) { ... }`                       |
| Annotation        | `@[likely]`, `@[unlikely]`                                                       | branch hints on match arms                        |
| Instrumentation   | `@trace`, `@profile`                                                             | runtime function bodies                           |
| Internal support  | `@field`, `@replace_field`, `@empty`, and exact heap/inline-array helpers        | compiler-generated or narrow library wrapper code |

`static_for_slots` is an internal checked-AST form used by generated fixed-layout code. It is not
source syntax; source-level `static for` and record/product `for` slots are rejected.

## Module and IO Builtins

| Builtin     | Arguments                         | Returns                 | Phase                             |
| ----------- | --------------------------------- | ----------------------- | --------------------------------- |
| `@import`   | string module specifier           | namespace alias value   | top-level const lowering/checking |
| `@external` | string import name, function type | host IO action function | top-level const checking/backend  |

`@import` and `@external` are declaration-only forms. They are valid as top-level `const` values,
not as ordinary expressions.

`return(value)` is available in expression position when an `io(T)` result is expected. It is not a
normal function and cannot be redefined.

## Debug Trace Statements

`@trace("message");` is a debug-only runtime statement for text breadcrumbs inside ordinary function
blocks and `do` blocks. Debug builds record each trace site in compiler metadata, import
`env.fig_trace(site_id)`, and `fig run` prints `[trace] message` to stderr when execution reaches
the statement.

Release builds erase trace statements before backend lowering. Trace metadata is intentionally not
part of the stable `fig.abi` custom section, and trace statements are not expressions, top-level
declarations, or type-function forms.

## Runtime Profile Expressions

`@profile("label") { expr }` measures a scoped runtime expression without changing its result.
Profiling is disabled by default; disabled profile wrappers compile as if only `expr` was written.

When compiling with `runtimeProfile: true` or running `fig run --runtime-profile`, the backend
records each profile site in a `fig.profile` custom section, imports
`env.fig_profile_enter(site_id)` and `env.fig_profile_exit(site_id)`, and surrounds the profiled
body with those calls. `fig run --runtime-profile` prints a profile table to stderr after program
stdout with label, count, total milliseconds, and average milliseconds.

Profile labels must be string literals. Profile expressions are valid inside runtime function
bodies; top-level values, type functions, signatures, parameters, and other non-runtime contexts
reject them.

## Compile Profiling

`fig check|wat|build|run --compile-profile` prints compiler phase timings to stderr. This is
separate from the optimizer `--profile name` flag, which selects optimization budgets.

## Diagnostics and Contracts

| Builtin          | Arguments             | Returns | Phase                     |
| ---------------- | --------------------- | ------- | ------------------------- |
| `@compile_error` | optional string       | never   | const and type evaluation |
| `@require`       | bool, optional string | bool    | type evaluation           |
| `@assert`        | type expression       | erased  | source type checking      |

`@require` emits a diagnostic when the first argument is not `true`. `@assert(TypeExpr);` evaluates
a type expression in source and discards the result.

Contract checks are ordinary type-function calls. Use `@assert(Contract(Target));` when only the
checking side effects matter and the type-level result can be discarded:

```fig
@assert(Monoid(Point));
@assert(Functor(Vec));
```

Named `const` declarations can keep a type-level result when later compile-time code needs it.
`const _ = Contract(Target);` is just an ordinary discarded const binding; prefer
`@assert(Contract(Target));` when the source only needs the check.

`@assume` is not a source builtin. Rewrite assumptions are supplied by compiler plugins as
const-function template strings.

## Type Reflection

These builtins take a type value as their first argument and run during type evaluation. Most also
work during const evaluation when their arguments are compile-time Values.

| Builtin                      | Arguments                                                      | Returns                                     |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| `@type_is_product`           | `t: type`                                                      | `bool`                                      |
| `@type_is_sum`               | `t: type`                                                      | `bool`                                      |
| `@type_is_alias`             | `t: type`                                                      | `bool`                                      |
| `@type_is_number`            | `t: type`                                                      | `bool`                                      |
| `@type_has_slot`             | `t: type`, `slot: #literal/string`                             | `bool`                                      |
| `@type_slot_type`            | `t: type`, `slot: #literal/string`                             | slot `type`, or diagnostic                  |
| `@type_has_member`           | `t: type`, `member: #literal/string`                           | `bool`                                      |
| `@type_member_type`          | `t: type`, `member: #literal/string`                           | member function `type`, or diagnostic       |
| `@type_members`              | `t: type`                                                      | shape of attached members                   |
| `@type_member_target`        | `t: type`, `member: #literal/string`                           | target member function name                 |
| `@type_is_fn`                | `t: type`                                                      | `bool`                                      |
| `@type_fn_params`            | `t: type`                                                      | shape of function parameter types           |
| `@type_fn_return`            | `t: type`                                                      | function return `type`                      |
| `@type_fn_param_count`       | `t: type`                                                      | numeric parameter count                     |
| `@type_is_scalar`            | `t: type`                                                      | `bool`                                      |
| `@type_scalar_carrier`       | `t: type`                                                      | scalar carrier tag                          |
| `@type_scalar_min`           | `t: type`                                                      | numeric minimum                             |
| `@type_scalar_max`           | `t: type`                                                      | numeric maximum                             |
| `@type_scalar_bit_width`     | `t: type`                                                      | numeric bit width                           |
| `@type_scalar_signed`        | `t: type`                                                      | `bool`                                      |
| `@type_scalar_domain`        | `t: type`                                                      | scalar domain metadata                      |
| `@type_is_refined_scalar`    | `t: type`                                                      | `bool`                                      |
| `@type_domain_union`         | `a: type`, `b: type`                                           | canonical refined `i32(...)` union          |
| `@type_domain_intersect`     | `a: type`, `b: type`                                           | canonical refined `i32(...)` intersection   |
| `@type_domain_difference`    | `a: type`, `b: type`                                           | canonical refined `i32(...)` difference     |
| `@type_domain_contains`      | `expected: type`, `actual: type`                               | `bool`                                      |
| `@type_domain_cardinality`   | `t: type`                                                      | finite member count                         |
| `@type_layout`               | `t: type`                                                      | layout metadata shape                       |
| `@type_storage_kind`         | `t: type`                                                      | storage kind tag                            |
| `@type_flat_slot_count`      | `t: type`                                                      | flattened slot count                        |
| `@type_flat_slots`           | `t: type`                                                      | shape of flattened slot types               |
| `@type_size_bits`            | `t: type`                                                      | numeric size in bits                        |
| `@type_align_bits`           | `t: type`                                                      | numeric alignment in bits                   |
| `@type_is_inline_array`      | `t: type`                                                      | `bool`                                      |
| `@type_inline_array_len`     | `t: type`                                                      | inline array length                         |
| `@type_inline_array_item`    | `t: type`                                                      | inline array item `type`                    |
| `@type_has_variant`          | `t: type`, `variant: #literal/string`                          | `bool`                                      |
| `@type_variant_has_slot`     | `t: type`, `variant: #literal/string`, `slot: #literal/string` | `bool`                                      |
| `@type_variant_count`        | `t: type`                                                      | numeric variant count                       |
| `@type_variant_tag_type`     | `t: type`                                                      | variant tag `type`                          |
| `@type_variant_payload_type` | `t: type`, `variant: #literal/string`                          | payload `type`, or empty type               |
| `@type_has_niche`            | `t: type`                                                      | `bool`                                      |
| `@type_niche_value`          | `t: type`                                                      | niche value metadata                        |
| `@type_slots`                | `t: type`                                                      | shape of product slots                      |
| `@type_slot_count`           | `t: type`                                                      | numeric slot count; non-products return `0` |
| `@type_variant_slots`        | `t: type`, `variant: #literal/string`                          | shape of variant slots                      |
| `@type_variants`             | `t: type`                                                      | shape describing variants                   |

## Type-List Builtins

Type-list builtins operate on compile-time list shapes such as `[#reader, #state]`. They are used by
`prelude.effect` capability-list proofs and can also hold type values.

| Builtin                   | Arguments        | Returns                    |
| ------------------------- | ---------------- | -------------------------- |
| `@type_list_contains`     | list, item       | `bool`                     |
| `@type_list_contains_all` | required, actual | `bool`                     |
| `@type_list_index`        | list, item       | numeric index or error     |
| `@type_list_append`       | left, right      | combined type list         |
| `@type_list_remove`       | list, item       | list without matching item |
| `@type_list_unique`       | list             | deduplicated list          |
| `@type_list_is_unique`    | list             | `bool`                     |

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
wrapper function supplies the public API and types. Operator syntax still resolves through visible
source declarations; `prelude.operators` exposes primitive scalar operators by defining attached
members such as `i32::add` and `bool::and` that wrap the scalar intrinsics below. Explicit memory
and pointer intrinsics are not source-facing Fig builtins.

| Intrinsic                 | Arguments     | Returns       |
| ------------------------- | ------------- | ------------- |
| `@branch_handle`          | pointer `i32` | branch handle |
| `@branch_handle_ptr`      | branch handle | pointer `i32` |
| `@branch_mark`            | branch handle | branch handle |
| `@branch_is_branched`     | branch handle | bool          |
| `@branch_ensure_editable` | branch handle | branch handle |
| `@branch_materialize`     | branch handle | branch handle |

The `@branch_*` intrinsics are accepted in `branch` and `branch-debug` memory modes.

Primitive scalar intrinsic names are exact backend forms registered by `core-intrinsics`:

| Intrinsic family                                                           | Purpose                                  |
| -------------------------------------------------------------------------- | ---------------------------------------- |
| `@i32_add`, `@i32_sub`, `@i32_mul`, `@i32_div`, `@i32_rem`                 | signed 32-bit arithmetic                 |
| `@u32_add`, `@u32_sub`, `@u32_mul`, `@u32_div`, `@u32_rem`                 | unsigned 32-bit arithmetic               |
| `@i64_add`, `@i64_sub`, `@i64_mul`, `@i64_div`, `@i64_rem`                 | signed 64-bit arithmetic                 |
| `@u64_add`, `@u64_sub`, `@u64_mul`, `@u64_div`, `@u64_rem`                 | unsigned 64-bit arithmetic               |
| `@f32_add`, `@f32_sub`, `@f32_mul`, `@f32_div`                             | 32-bit floating-point arithmetic         |
| `@f64_add`, `@f64_sub`, `@f64_mul`, `@f64_div`                             | 64-bit floating-point arithmetic         |
| `@i32_eql` through `@i32_gte`, and matching `u32/i64/u64/f32/f64` families | scalar equality and ordering comparisons |
| `@bool_and`, `@bool_or`, `@bool_xor`, `@bool_eql`, `@bool_neq`             | boolean operations and comparisons       |
