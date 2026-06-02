# Fig Good and Bad Examples

## Runnable Examples

The `examples/` directory contains checked and runnable programs. These files are especially useful
for comparing Fig against familiar Haskell and Zig patterns:

| Example                            | Pattern explored                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `haskell_validation_pipeline.fig`  | Functor/Applicative/Monad members, independent applicative combination, and dependent monadic flow. |
| `haskell_reader_state_program.fig` | Reader configuration, State updates, and monadic sequencing.                                        |
| `zig_comptime_record_layout.fig`   | Type reflection, shape filtering/mapping, and compile-time layout checks.                           |
| `zig_static_matrix_schedule.fig`   | Count-parameterized arrays, operation configuration, and static schedule metadata.                  |

In a source checkout, the examples in `tests/fixtures/language` are compiled by
`tests/language_reference_examples_test.ts`. Good fixtures must pass `checkSource`; bad fixtures
must fail with the diagnostic code in their first line.

| Category                                | Good fixture                           | Bad fixture                                     | Bad pattern                                                                                                  |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| declarations/imports/IO                 | `good/declarations_imports_io.fig`     | `bad/external_io_missing.fig`                   | External host IO imports must take an explicit `io` executor and return an `io(T)` action.                   |
| function clauses and parameter patterns | `good/function_clauses_patterns.fig`   | `bad/function_clause_return_mismatch.fig`       | Repeated clauses for one function must keep the same return type.                                            |
| type functions and result kinds         | `good/type_functions_result_kinds.fig` | `bad/type_function_result_kind_mismatch.fig`    | A type function declared as `struct` must return a product constructor result.                               |
| imports, slots, and attached members    | `good/imports_slots_members.fig`       |                                                 | Destructured imports, punned/static/positioned slots, and member contracts check together.                   |
| shape/product/union construction        | `good/shape_product_union.fig`         | `bad/unknown_shape_slot.fig`                    | Product constructors reject fields that are not in the product shape.                                        |
| tuples and collections                  | `good/tuples_collections.fig`          |                                                 | Tuple destructuring and target-typed collection literals check together.                                     |
| parsed operators                        | `good/operators.fig`                   | `bad/operator_missing_member.fig`               | Custom operator syntax needs a visible declaration or primitive implementation.                              |
| IO values and destructuring             | `good/io_values_destructure.fig`       | `bad/unsupported_ownership_move_after_pass.fig` | Unsupported value-consumption forms such as `fork` are rejected.                                             |
| static reflection builtins              | `good/static_reflection_builtins.fig`  | `bad/type_reflection_missing_variant.fig`       | Reflecting a missing sum variant reports a focused diagnostic.                                               |
| shape builtins                          | `good/shape_builtins.fig`              | `bad/shape_builtin_bad_arg.fig`                 | Shape builtins require shape arguments and valid selectors.                                                  |
| WGSL helpers                            | `good/wgsl_helpers.fig`                | `bad/wgsl_bad_source.fig`                       | Type-function references use the current type annotation syntax; malformed helper use fails before checking. |
| backend intrinsic wrappers              | `good/backend_intrinsics.fig`          | `bad/backend_intrinsic_unknown.fig`             | Unknown `@...` backend intrinsic wrappers are rejected.                                                      |
