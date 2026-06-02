# Fig Guides for Familiar Language Patterns

These guides show how to write Fig code when you are reaching for patterns that are idiomatic in
Rust, Haskell, or Zig. They are not compatibility layers. Fig keeps its own surface: explicit type
functions, erased proof values, attached members, Branch-Bit values, and WebAssembly output.

- [Rust Patterns in Fig](rust-patterns.md) covers trait-like contracts, attached methods, generic
  bounds, sum types, error handling, ownership translation, and erased evidence.
- [Haskell Patterns in Fig](haskell-patterns.md) covers algebraic data types, Functor, Applicative,
  Monad, do notation, Reader/State/Eff, operators, and rewrite laws.
- [Zig Patterns in Fig](zig-patterns.md) covers `comptime`-style type functions, static reflection,
  inline layouts, index proofs, explicit host IO, profiling, and memory-efficient value code.

Use these guides with the checked examples:

- `examples/prelude_typeclasses.fig`
- `examples/prelude_functional.fig`
- `examples/haskell_validation_pipeline.fig`
- `examples/haskell_reader_state_program.fig`
- `examples/zig_comptime_record_layout.fig`
- `examples/zig_static_matrix_schedule.fig`
- `examples/type_fn_memory.fig`
