import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  AnalysisCache,
  completionsAt,
  definitionAt,
  documentSymbols,
  hoverAt,
  prepareRenameAt,
  referencesAt,
  renameAt,
  semanticTokens,
  signatureHelpAt,
  workspaceSymbols,
} from "../src/lsp/analysis.ts";
import { candidateModulePaths, pathToUri } from "../src/lsp/modules.ts";
import { PositionMapper } from "../src/lsp/position.ts";
import type { Diagnostic } from "../src/lsp/protocol.ts";
import { FigLanguageServer } from "../src/lsp/server.ts";

type PublishedDiagnostics = { uri: string; diagnostics: Diagnostic[] };

Deno.test("LSP position mapper uses UTF-16 character offsets", () => {
  const mapper = new PositionMapper("a😀b\ncd");
  assertEquals(mapper.positionAt(3), { line: 0, character: 3 });
  assertEquals(mapper.offsetAt({ line: 0, character: 3 }), 3);
  assertEquals(mapper.positionAt(5), { line: 1, character: 0 });
});

Deno.test("LSP module resolver mirrors project module candidates", () => {
  const paths = candidateModulePaths("/tmp/project/main.fig", "prelude.std");
  assert(paths.some((path) => path.endsWith("/prelude/std.fig")));
  assert(paths.some((path) => path.endsWith("/prelude.std.fig")));
});

Deno.test("LSP analysis publishes checker diagnostics and symbols", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(uri, 1, "pub fn main() { missing_name }");
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(result.diagnostics.some((diagnostic) => diagnostic.source === "fig"));
  assert(documentSymbols(result).some((symbol) => symbol.name === "main"));
});

Deno.test("LSP analysis recovers annotated let type after bad initializer", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(uri, 1, "pub fn main() -> i32 { let x: i32 = $; x }");
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "const.placeholder_context"));
  assert(result.symbols.some((symbol) =>
    symbol.kind === "local" && symbol.name === "x" && symbol.detail === "i32"
  ));
  assert(definitionAt(result, { line: 0, character: 39 })[0]?.uri === uri);
});

Deno.test("LSP analysis recovers known call return type after bad argument", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    "fn id(x: i32) -> i32 { x }\npub fn main() -> i32 { let y = id($); y }",
  );
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "const.placeholder_context"));
  assert(result.symbols.some((symbol) =>
    symbol.kind === "local" && symbol.name === "y" && symbol.detail === "i32"
  ));
});

Deno.test("LSP analysis keeps later symbols after invalid declared return expression", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(uri, 1, "pub fn broken() -> i32 { $ }\nfn after() -> i32 { 1 }");
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "const.placeholder_context"));
  assert(documentSymbols(result).some((symbol) => symbol.name === "broken"));
  assert(documentSymbols(result).some((symbol) => symbol.name === "after"));
  assert(completionsAt(result, { line: 1, character: 3 }).some((item) => item.label === "after"));
});

Deno.test("LSP analysis routes open imported diagnostics to imported URI", async () => {
  const rootUri = pathToUri("/tmp/project/main.fig");
  const importedUri = pathToUri("/tmp/project/broken.fig");
  const cache = new AnalysisCache();
  cache.open(importedUri, 1, "pub fn broken( { 1 }");
  cache.open(rootUri, 1, 'const broken = @import("./broken.fig");\npub fn main() -> i32 { 0 }');

  const result = await cache.reanalyze(rootUri);
  assert(result);
  assertEquals(result.diagnosticsByUri?.[rootUri] ?? [], []);
  assert(
    result.diagnosticsByUri?.[importedUri]?.some((diagnostic) => diagnostic.code === "parse.syntax"),
  );
});

Deno.test("LSP server publishes imported open diagnostics on imported document", async () => {
  const published: PublishedDiagnostics[] = [];
  const server = new FigLanguageServer((params) =>
    published.push(params as PublishedDiagnostics)
  );
  const rootUri = pathToUri("/tmp/project/main.fig");
  const importedUri = pathToUri("/tmp/project/broken.fig");
  await server.handle("textDocument/didOpen", {
    textDocument: {
      uri: importedUri,
      languageId: "fig",
      version: 1,
      text: "pub fn broken( { 1 }",
    },
  });
  await server.handle("textDocument/didOpen", {
    textDocument: {
      uri: rootUri,
      languageId: "fig",
      version: 1,
      text: 'const broken = @import("./broken.fig");\npub fn main() -> i32 { 0 }',
    },
  });

  assert(
    published.some((item) =>
      item.uri === importedUri &&
      item.diagnostics.some((diagnostic) => diagnostic.code === "parse.syntax")
    ),
  );
  const latestRoot = published.filter((item) => item.uri === rootUri).at(-1);
  assertEquals(latestRoot?.diagnostics ?? [], []);
});

Deno.test("LSP analysis keeps unresolved import diagnostics on importing URI", async () => {
  const rootUri = pathToUri("/tmp/project/main.fig");
  const cache = new AnalysisCache();
  cache.open(rootUri, 1, 'const missing = @import("./missing.fig");\npub fn main() -> i32 { 0 }');
  const result = await cache.reanalyze(rootUri);
  assert(result);
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "module.not_found"));
});

Deno.test("LSP hover definition and completion use visible bindings", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = `
    /// adds one
    fn add_one(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { add_one(1) }
  `;
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);
  const hover = hoverAt(result, { line: 2, character: 8 });
  assert(hover?.contents.value.includes("adds one"));
  const definition = definitionAt(result, { line: 3, character: 30 });
  assertEquals(definition[0]?.uri, uri);
  assert(
    completionsAt(result, { line: 3, character: 10 }).some((item) => item.label === "add_one"),
  );
  assert(referencesAt(result, { line: 3, character: 30 }).length >= 2);
  assertEquals(prepareRenameAt(result, { line: 2, character: 8 })?.placeholder, "add_one");
  const rename = renameAt(result, { line: 2, character: 8 }, "inc");
  assert(rename?.changes[uri].some((edit) => edit.newText === "inc"));
  const signature = signatureHelpAt(result, { line: 3, character: 36 }) as {
    signatures: { label: string }[];
    activeParameter: number;
  };
  assert(signature.signatures[0].label.includes("add_one"));
  assertEquals(signature.activeParameter, 0);
  assert(semanticTokens(result).data.length > 0);
  assert(workspaceSymbols([result], "add").some((item) => item.name === "add_one"));
});

Deno.test("LSP server handles initialize open hover completion and document symbols", async () => {
  const published: unknown[] = [];
  const server = new FigLanguageServer((params) => published.push(params));
  const init = await server.handle("initialize", {});
  assert(init);
  assertEquals(
    (init as { capabilities: { documentFormattingProvider?: boolean } }).capabilities
      .documentFormattingProvider,
    true,
  );
  assertEquals(
    (init as { capabilities: { referencesProvider?: boolean } }).capabilities.referencesProvider,
    true,
  );
  const uri = pathToUri("/tmp/main.fig");
  await server.handle("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "fig",
      version: 1,
      text: "fn answer() -> i32 { 42 }\npub fn main() -> i32 { answer() }",
    },
  });
  assert(published.length > 0);
  const completion = await server.handle("textDocument/completion", {
    textDocument: { uri },
    position: { line: 1, character: 10 },
  }) as { items: { label: string }[] };
  assert(completion.items.some((item) => item.label === "answer"));
  const symbols = await server.handle("textDocument/documentSymbol", {
    textDocument: { uri },
  }) as { name: string }[];
  assert(symbols.some((symbol) => symbol.name === "main"));
  const references = await server.handle("textDocument/references", {
    textDocument: { uri },
    position: { line: 1, character: 25 },
    context: { includeDeclaration: true },
  }) as unknown[];
  assert(references.length >= 2);
  const semantic = await server.handle("textDocument/semanticTokens/full", {
    textDocument: { uri },
  }) as { data: number[] };
  assert(semantic.data.length > 0);
});

Deno.test("LSP completions cover import strings directives and snippets", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(uri, 1, 'const Std = @import("prelude.');
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(
    completionsAt(result, { line: 0, character: 29 }).some((item) => item.label === "prelude.std"),
  );
  assert(
    completionsAt(result, { line: 0, character: 13 }).some((item) => item.label === "@import"),
  );
  assert(
    completionsAt(result, { line: 0, character: 0 }).some((item) => item.insertTextFormat === 2),
  );
});

Deno.test("LSP server formats documents with canonical Fig formatter", async () => {
  const server = new FigLanguageServer();
  const uri = pathToUri("/tmp/main.fig");
  await server.handle("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "fig",
      version: 1,
      text: "fn main()->i32{1}",
    },
  });
  const edits = await server.handle("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: 2, insertSpaces: true },
  }) as { newText: string }[];
  assertEquals(edits.length, 1);
  assertEquals(edits[0].newText, "fn main() -> i32 {\n  1\n}\n");
});

Deno.test("LSP server returns no formatting edits for already formatted documents", async () => {
  const server = new FigLanguageServer();
  const uri = pathToUri("/tmp/formatted.fig");
  await server.handle("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "fig",
      version: 1,
      text: "fn main() -> i32 {\n  1\n}\n",
    },
  });
  const edits = await server.handle("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: 2, insertSpaces: true },
  }) as { newText: string }[];
  assertEquals(edits, []);
});

Deno.test("LSP server returns no formatting edits for invalid documents", async () => {
  const server = new FigLanguageServer();
  const uri = pathToUri("/tmp/invalid.fig");
  await server.handle("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "fig",
      version: 1,
      text: "fn main( -> i32 { 1 }",
    },
  });
  const edits = await server.handle("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: 2, insertSpaces: true },
  }) as { newText: string }[];
  assertEquals(edits, []);
});
