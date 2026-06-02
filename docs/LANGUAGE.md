# Fig Language Reference

This file is the entry point for the Fig language documentation. The compiler remains the source of
truth. In a source checkout, use `grammar.ebnf`, `src/check.ts`, `src/primitives.ts`, and the tested
fixtures under `tests/fixtures/language` when behavior and prose disagree.

## Reading Order

1. [Syntax](reference/syntax.md) covers source files, declarations, imports, host IO, parameters,
   blocks, patterns, and literals.
2. [Types](reference/types.md) covers primitive types, function types, shapes, products, unions,
   numeric enums, repeats, and constructors.
3. [Expressions](reference/expressions.md) covers calls, constructors, match, operators, pipe-bind,
   local bindings, and destructuring.
4. [Type Functions](reference/type-functions.md) covers type blocks, result kinds, type parameters,
   `struct`, `union`, operators, and static matches.
5. [Builtins](reference/builtins.md) lists every compiler builtin and backend intrinsic.
6. [Semantics](reference/semantics.md) covers Branch-Bit values, effects, const evaluation,
   reflection, and WebAssembly portability constraints.
7. [Modules](reference/modules.md) summarizes the roles of prelude, web, and engine modules.
8. [Examples](EXAMPLES.md) pairs tested good and bad examples with the reason each bad pattern
   fails.
9. [Pattern Guides](guides/README.md) explain how to reproduce idiomatic Rust, Haskell, and Zig
   patterns in Fig.

For the longer-term type-system and optimizer direction around refined `i32(...)` domains, recursion
analysis, and type-directed partial evaluation, see
[Refinement and Recursion Design Direction](design-refinement-recursion.md).

## Compact Tour

```fig
const std = @import("prelude.std");

type Point = struct {x: i32, y: i32}

fn Point::add(a: Point, b: Point) -> Point {
  Point {x: a.x + b.x, y: a.y + b.y}
}

pub fn main() -> i32 { 42 }
```

Line comments start with `//`. Whitespace is otherwise insignificant.
