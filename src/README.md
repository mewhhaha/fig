# Hand-Written Compiler Source

This directory is hand-written compiler code. It is safe to edit directly.

`core_ast.ts` is the compiler's hand-written semantic AST/IR. It is not Baba-generated syntax AST
code.

Generated code lives under `generated/`; do not place tree-sitter generated parser files in this
directory.

Baba-generated AST wrappers live under `generated/baba-workbench/ast/`.
