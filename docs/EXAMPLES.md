# Fig Good and Bad Examples

The examples in `tests/fixtures/language` are compiled by
`tests/language_reference_examples_test.ts`. Good fixtures must pass `checkSource`; bad fixtures
must fail with the diagnostic code in their first line.

| Category                                | Good fixture                                  | Bad fixture                                  | Bad pattern                                                                                                  |
| --------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| declarations/imports/capabilities       | `good/declarations_imports_capabilities.fig`  | `bad/capability_effect_missing.fig`          | Calling an effectful capability from a pure function omits the required effect row.                          |
| function clauses and parameter patterns | `good/function_clauses_patterns.fig`          | `bad/function_clause_return_mismatch.fig`    | Repeated clauses for one function must keep the same return type.                                            |
| type functions and result kinds         | `good/type_functions_result_kinds.fig`        | `bad/type_function_result_kind_mismatch.fig` | A type function declared as `struct` must return a product constructor result.                               |
| shape/product/union construction        | `good/shape_product_union.fig`                | `bad/unknown_shape_slot.fig`                 | Product constructors reject fields that are not in the product shape.                                        |
| parsed operators                        | `good/operators.fig`                          | `bad/operator_missing_member.fig`            | Custom operator syntax needs a visible descriptor or primitive implementation.                               |
| ownership, fork, destructuring, effects | `good/ownership_fork_destructure_effects.fig` | `bad/ownership_move_after_pass.fig`          | Moved values cannot be reused.                                                                               |
| static reflection builtins              | `good/static_reflection_builtins.fig`         | `bad/type_reflection_missing_variant.fig`    | Reflecting a missing sum variant reports a focused diagnostic.                                               |
| shape builtins                          | `good/shape_builtins.fig`                     | `bad/shape_builtin_bad_arg.fig`              | Shape builtins require shape arguments and valid selectors.                                                  |
| WGSL helpers                            | `good/wgsl_helpers.fig`                       | `bad/wgsl_bad_source.fig`                    | Type-function references use the current type annotation syntax; malformed helper use fails before checking. |
| backend intrinsic wrappers              | `good/backend_intrinsics.fig`                 | `bad/backend_intrinsic_unknown.fig`          | Unknown `@...` backend intrinsic wrappers are rejected.                                                      |
