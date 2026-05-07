# Helix Support

This directory contains Fig language configuration and runtime queries for Helix.

For local testing from the repository root:

```sh
deno task helix
```

That health check uses:

```sh
XDG_CONFIG_HOME=$PWD/helix/config HELIX_RUNTIME=$PWD/helix/runtime
```

To install manually, merge `helix/languages.toml` into your Helix `languages.toml`, then copy or
symlink:

```text
helix/runtime/queries/fig
```

into your Helix runtime query directory.

The Helix query files are copied from Baba's generated query output by `deno task helix`. Edit
`grammar.ebnf` and `baba.json`, then run `deno task codegen` and `deno task helix`.
