# Generated Files

Everything in this directory is generated and should not be edited by hand.

Edit these source files instead:

- `grammar.ebnf` for the Fig grammar
- `baba.json` for baba editor/workbench metadata
- `scripts/generate_grammar.ts` for generation policy and post-processing

Regenerate with:

```sh
deno task grammar
```

Layout:

- `tokenizer.ts`: generated token kind list consumed by the hand-written compiler tokenizer
- `baba-workbench/`: generated baba workbench, tree-sitter grammar, editor scaffolds, and parser
  sources
