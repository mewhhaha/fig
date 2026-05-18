# Fig Language Reference

This file is the entry point for the Fig language documentation. The compiler remains the source of
truth: use `grammar.ebnf`, `src/check.ts`, `src/primitives.ts`, and the tested fixtures under
`tests/fixtures/language` when behavior and prose disagree.

## Reading Order

1. [Syntax](reference/syntax.md) covers source files, declarations, imports, host effects,
   parameters, blocks, patterns, and literals.
2. [Types](reference/types.md) covers primitive types, function types, shapes, products, unions,
   repeats, and constructors.
3. [Expressions](reference/expressions.md) covers calls, constructors, match, operators, pipe-bind,
   `$`, shadowing, and destructuring.
4. [Type Functions](reference/type-functions.md) covers type blocks, result kinds, type parameters,
   `struct`, `union`, `operator`, and static matches.
5. [Builtins](reference/builtins.md) lists every compiler builtin and backend intrinsic.
6. [Semantics](reference/semantics.md) covers Branch-Bit values, effects, const evaluation,
   reflection, and WebAssembly portability constraints.
7. [Modules](reference/modules.md) summarizes the roles of prelude, web, and engine modules.
8. [Examples](EXAMPLES.md) pairs tested good and bad examples with the reason each bad pattern
   fails.

For the longer-term type-system and optimizer direction around refined `i32(...)` domains, recursion
analysis, and type-directed partial evaluation, see
[Refinement and Recursion Design Direction](design-refinement-recursion.md).

## Compact Tour

```fig
const std = @import("prelude.std");

type fn Point() -> struct {
  let Point = {x: i32, y: i32};
  struct(Point)
}

fn Point::add(a: Point, b: Point) -> Point {
  Point {x: a.x + b.x, y: a.y + b.y}
}

pub fn main() -> i32 { 42 }
```

Line comments start with `//`. Whitespace is otherwise insignificant.
