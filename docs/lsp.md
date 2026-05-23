# Fig Language Server

The Fig language server runs over stdio and is editor-neutral:

```sh
deno task lsp
```

From a GitHub Release binary, run:

```sh
fig lsp
```

## Status

The language server is usable for Helix-first IntelliSense today. It supports diagnostics, hover,
completion, go-to definition, references, prepare rename, rename, signature help, semantic tokens,
document symbols, workspace symbols, code actions, and formatting. The implementation keeps its
editor metadata in `src/lsp/` and combines parser/checker declarations with source spans for an
LSP-owned semantic Index.

## Helix

From a Fig source checkout, add a language server entry to your Helix `languages.toml`:

```toml
[language-server.fig-lsp]
command = "deno"
args = ["task", "lsp"]

[[language]]
name = "fig"
scope = "source.fig"
file-types = ["fig"]
language-servers = ["fig-lsp"]
formatter = { command = "deno", args = ["run", "--allow-read", "src/cli.ts", "fmt", "-"] }
auto-format = true
```

For a GitHub Release binary on `PATH`, use:

```toml
[language-server.fig-lsp]
command = "fig"
args = ["lsp"]

[[language]]
name = "fig"
scope = "source.fig"
file-types = ["fig"]
language-servers = ["fig-lsp"]
formatter = { command = "fig", args = ["fmt", "-"] }
auto-format = true
```

For a source checkout without `deno task`, point directly at the entry points:

```toml
[language-server.fig-lsp]
command = "deno"
args = ["run", "--allow-read", "src/lsp/main.ts"]

[[language]]
name = "fig"
scope = "source.fig"
file-types = ["fig"]
language-servers = ["fig-lsp"]
formatter = { command = "deno", args = ["run", "--allow-read", "src/cli.ts", "fmt", "-"] }
auto-format = true
```

The protocol is standard LSP, so VS Code and other clients can use the same command through their
own language-server configuration.

## Implemented

The current server provides:

- a stdio LSP server launched with `deno task lsp`.
- `initialize` and `shutdown` handling.
- Full-document text synchronization.
- Diagnostics from parsing, checking, and module resolution.
- Hover for indexed symbols, including symbol kind, name, type or detail text, and doc comments when
  available. Hover works on declarations and indexed references.
- Go-to definition and references for indexed declarations, parameters, locals, imports, members,
  variants, generated symbols, and known intrinsics.
- Prepare rename and rename for non-generated, non-intrinsic source bindings in the current indexed
  document.
- Signature help for calls, triggered by `(` and `,`.
- Semantic tokens with a stable legend for functions, types, parameters, variables, constants,
  members, variants, imports, and builtins.
- Completions for visible bindings, qualified names, `@` directives, known module specifiers, and
  declaration snippets.
- Document symbols for top-level declarations and indexed members.
- Workspace symbols for indexed declarations, imports, members, variants, and public generated
  symbols already known to the server.
- Conservative quick fixes for diagnostics where the server has a clear single-edit replacement.
- Document formatting through the canonical Fig formatter.
- UTF-16 LSP position mapping.
- File and module resolution for relative imports, dotted imports, `prelude.*`, `web.*`, and
  `engine.*` imports.
- Open documents override disk files during import resolution. The server tracks resolved imports
  and republishes diagnostics for affected open dependents after changes.

## Known Limitations

The index is intentionally conservative. It prefers returning no rename or quick fix over producing
an edit for generated, intrinsic, ambiguous, or unresolved symbols. Cross-file rename is limited to
files already indexed by the server; unopened workspace files are not scanned eagerly.

## What To Add Next

The next useful work is to make the server behave more like a mature daily-use LSP:

- Expand cross-file rename beyond already-indexed documents.
- Add more diagnostic-specific quick fixes once checker diagnostics expose reliable replacement
  spans.
- Tighten member completion filtering with checked receiver types.
- Add broader protocol fixtures for aliased imports, generated members, malformed documents, and
  local-binding edge cases.
