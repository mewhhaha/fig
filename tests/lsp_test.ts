import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  AnalysisCache,
  codeActions,
  completionsAt,
  definitionAt,
  documentSymbols,
  hoverAt,
  inlayHintsAt,
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

function positionIn(source: string, needle: string, inside = 0) {
  const start = source.indexOf(needle);
  assert(start >= 0, `missing test marker: ${needle}`);
  return new PositionMapper(source).positionAt(start + inside);
}

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
  const source = "pub fn main() -> i32 { let x: i32 = true; x }";
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(
    result.symbols.some((symbol) =>
      symbol.kind === "local" && symbol.name === "x" && symbol.detail === "i32"
    ),
  );
  assert(definitionAt(result, positionIn(source, "; x", "; ".length))[0]?.uri === uri);
});

Deno.test("LSP analysis recovers known call return type after bad argument", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    "fn Id(x: i32) -> i32 { x }\npub fn main() -> i32 { let y = Id(true); y }",
  );
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(
    result.symbols.some((symbol) =>
      symbol.kind === "local" && symbol.name === "y" && symbol.detail === "i32"
    ),
  );
});

Deno.test("LSP analysis recovers product slot facts after bad constructor slot", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn Point() -> struct { let Point = {x: i32, y: i32}; struct(Point) }",
    "pub fn main() -> i32 { let p: Point = Point {x: true, y: 1}; p.x }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(
    result.symbols.some((symbol) =>
      symbol.kind === "local" && symbol.name === "p" && symbol.detail === "Point"
    ),
  );
  assert(definitionAt(result, positionIn(source, "p.x", 0))[0]?.uri === uri);
});

Deno.test("LSP analysis recovers projected field type after bad call argument", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    [
      "type fn Point() -> struct { let Point = {x: i32, y: i32}; struct(Point) }",
      "fn make_point(x: i32, y: i32) -> Point { Point {x: x, y: y} }",
      "pub fn main() -> i32 { let tmp = make_point(true, 1); let y = tmp.x; y }",
    ].join("\n"),
  );
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(
    result.symbols.some((symbol) =>
      symbol.kind === "local" && symbol.name === "tmp" && symbol.detail === "Point"
    ),
  );
  assert(
    result.symbols.some((symbol) =>
      symbol.kind === "local" && symbol.name === "y" && symbol.detail === "i32"
    ),
  );
});

Deno.test("LSP analysis checks pipe-bind body against annotated result after bad input", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    "fn Bad(x: i32) -> i32 { x }\npub fn main() -> i32 { let y: i32 = Bad(true) \\value -> 1; let z = y; z }",
  );
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(
    result.symbols.some((symbol) =>
      symbol.kind === "local" && symbol.name === "z" && symbol.detail === "i32"
    ),
  );
  assert(
    result.symbols.some((symbol) =>
      symbol.kind === "local" && symbol.name === "y" && symbol.detail === "i32"
    ),
  );
});

Deno.test("LSP analysis checks match arms against declared return after bad scrutinee", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    "pub fn main() -> i32 {\n  let y: i32 = true;\n  let z = y;\n  z\n}",
  );
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(
    result.symbols.some((symbol) =>
      symbol.kind === "local" && symbol.name === "z" && symbol.detail === "i32"
    ),
  );
});

Deno.test("LSP analysis keeps later symbols after invalid declared return expression", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(uri, 1, "pub fn broken() -> i32 { true }\nfn after() -> i32 { 1 }");
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(documentSymbols(result).some((symbol) => symbol.name === "broken"));
  assert(documentSymbols(result).some((symbol) => symbol.name === "after"));
  assert(completionsAt(result, { line: 1, character: 3 }).some((item) => item.label === "after"));
});

Deno.test("LSP diagnostics use compile-time caller spans", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    `
      type fn Point() { let Point = {x: i32, y: i32}; struct(Point) }
      type fn Eq(t: type) {
        @require(@type_has_member(t, #eql), "Eq requires eql");
      }
      fn same(proof: Eq(Point)) -> bool { true }
    `,
  );
  const result = await cache.reanalyze(uri);
  assert(result);
  const diagnostic = result.diagnostics.find((item) => item.code === "type.require");
  assert(diagnostic);
  assert(
    diagnostic.range.start.line !== 0 || diagnostic.range.start.character !== 0,
    JSON.stringify(diagnostic.range),
  );
  assertEquals(diagnostic.range.start.line, 5);
});

Deno.test("LSP diagnostics use compile-time builtin argument spans", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const source = [
    "type fn Bad(a: type) -> type {",
    "  let Count = @shape_count(a);",
    "  let Out = {Count*i32};",
    "  struct(Out)",
    "}",
    "pub fn f(x: Bad(i32)) -> i32 { 0 }",
  ].join("\n");
  const cache = new AnalysisCache();
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);
  const diagnostic = result.diagnostics.find((item) => item.code === "type.shape_builtin_arg");
  assert(diagnostic);
  const offset = source.indexOf("@shape_count(a)") + "@shape_count(".length;
  assertEquals(diagnostic.range.start, new PositionMapper(source).positionAt(offset));
});

Deno.test("LSP diagnostics use const evaluation argument spans", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const source = [
    "const bad = shape_slot({x: i32}, #missing);",
    "pub fn main() -> i32 { 0 }",
  ].join("\n");
  const cache = new AnalysisCache();
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);
  const diagnostic = result.diagnostics.find((item) => item.code === "type.unknown_shape_slot");
  assert(diagnostic);
  assertEquals(
    diagnostic.range.start,
    new PositionMapper(source).positionAt(source.indexOf("#missing")),
  );
});

Deno.test("LSP diagnostics use const parameter argument spans", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const source = [
    "fn needs_type(const value: type, x: i32) -> i32 { x }",
    "fn Bad(runtime_dict: i32) -> i32 { needs_type(runtime_dict, 1) }",
  ].join("\n");
  const cache = new AnalysisCache();
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);
  const diagnostic = result.diagnostics.find((item) => item.code === "const.static_param_arg");
  assert(diagnostic);
  const offset = source.indexOf("needs_type(runtime_dict") + "needs_type(".length;
  assertEquals(diagnostic.range.start, new PositionMapper(source).positionAt(offset));
});

Deno.test("LSP code actions convert nested calls to pipe-bind pipelines", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "fn inc(x: i32) -> i32 { x + 1 }",
    "fn add(x: i32, y: i32) -> i32 { x + y }",
    "fn wrap(x: i32) -> i32 { x }",
    "pub fn main() -> i32 { wrap(add(inc(1), 2)) }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const actions = codeActions(
    result,
    new PositionMapper(source).range(
      source.indexOf("inc(1)"),
      source.indexOf("inc(1)"),
    ),
  );
  const action = actions.find((item) => item.title === "Convert nested call to pipe-bind pipeline");
  assert(action);
  assertEquals(
    action.edit?.changes[uri]?.[0].newText,
    "inc(1) \\value -> add(value, 2) \\value -> wrap(value)",
  );
});

Deno.test("LSP code actions choose fresh pipe-bind binders", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "fn inc(x: i32) -> i32 { x + 1 }",
    "fn add(x: i32, y: i32) -> i32 { x + y }",
    "pub fn main(value: i32) -> i32 {",
    "  let value1 = 1;",
    "  add(inc(value), value1)",
    "}",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const actions = codeActions(
    result,
    new PositionMapper(source).range(
      source.indexOf("inc(value)"),
      source.indexOf("inc(value)"),
    ),
  );
  const action = actions.find((item) => item.title === "Convert nested call to pipe-bind pipeline");
  assert(action);
  assertEquals(
    action.edit?.changes[uri]?.[0].newText,
    "inc(value) \\value2 -> add(value2, value1)",
  );
});

Deno.test("LSP code actions combine nested matches into tuple match", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "pub fn main(a: bool, b: bool) -> i32 {",
    "  match a {",
    "    true => match b { true => 1, false => 2 },",
    "    false => match b { true => 3, false => 4 }",
    "  }",
    "}",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const actions = codeActions(
    result,
    new PositionMapper(source).range(
      source.indexOf("match a"),
      source.indexOf("match a"),
    ),
  );
  const action = actions.find((item) => item.title === "Combine nested matches into tuple match");
  assert(action);
  assertEquals(
    action.edit?.changes[uri]?.[0].newText,
    "match [a, b] { [true, true] => 1, [true, false] => 2, [false, true] => 3, [false, false] => 4 }",
  );
});

Deno.test("LSP code actions replace inferred type holes", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn Box(a: type) -> struct { let Box = {value: a}; struct(Box) }",
    "fn one() -> _ { 1 }",
    "fn nested() -> Box(_) { Box {value: 2} }",
    "pub fn main() -> i32 { one() + nested().value }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const actions = codeActions(
    result,
    new PositionMapper(source).range(source.indexOf("-> _") + 3, source.indexOf("-> _") + 3),
  );
  const action = actions.find((item) => item.title === "Replace inferred type holes");
  assert(action);
  assertEquals(action.edit?.changes[uri]?.[0].newText, "i32");

  const nestedActions = codeActions(
    result,
    new PositionMapper(source).range(source.indexOf("Box(_)") + 4, source.indexOf("Box(_)") + 4),
  );
  const nestedAction = nestedActions.find((item) => item.title === "Replace inferred type holes");
  assert(nestedAction);
  assertEquals(nestedAction.edit?.changes[uri]?.[0].newText, "i32");
});

Deno.test("LSP code action replaces multiple inferred type holes", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn Pair(a: type, b: type) -> struct { let Pair = {left: a, right: b}; struct(Pair) }",
    "fn pair() -> Pair(_, _) { Pair {left: 1, right: true} }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const actions = codeActions(
    result,
    new PositionMapper(source).range(
      source.indexOf("Pair(_, _)"),
      source.indexOf("Pair(_, _)") + "Pair(_, _)".length,
    ),
  );
  const action = actions.find((item) => item.title === "Replace inferred type holes");
  assert(action);
  assertEquals(action.edit?.changes[uri]?.map((edit) => edit.newText), ["i32", "bool"]);
});

Deno.test("LSP code action replaces do-strategy inferred type holes", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn Id(a: type) -> type { a }",
    "fn Id::pure(value: a) -> Id(a) { value }",
    "fn Id::bind(value: Id(a), const f: fn(x: a) -> Id(b)) -> Id(b) { f(value) }",
    "fn run() -> Id(i32) { do @monad(Id(_)) { pure(1) } }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const actions = codeActions(
    result,
    new PositionMapper(source).range(source.indexOf("Id(_)") + 3, source.indexOf("Id(_)") + 3),
  );
  const action = actions.find((item) => item.title === "Replace inferred type holes");
  assert(action);
  assertEquals(action.edit?.changes[uri]?.[0].newText, "i32");
});

Deno.test("LSP quickfix groups trailing runtime parameters", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "fn sum(a: i32, b: i32, c: i32, d: i32, e: i32, f: i32) -> i32 {",
    "  a + b + c + d + e + f",
    "}",
    "pub fn main() -> i32 { sum(1, 2, 3, 4, 5, 6) }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);
  const diagnostic = result.diagnostics.find((item) => item.code === "fn.too_many_runtime_params");
  assert(diagnostic);

  const actions = codeActions(result, diagnostic.range);
  const action = actions.find((item) => item.title === "Group trailing parameters into a struct");
  assert(action);
  const edits = action.edit?.changes[uri] ?? [];
  assert(edits.some((edit) => edit.newText === "rest: struct({e: i32, f: i32})"));
  assert(edits.some((edit) => edit.newText === "rest.e"));
  assert(edits.some((edit) => edit.newText === "rest.f"));
  assert(edits.some((edit) => edit.newText === "{e: 5, f: 6}"));
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
    result.diagnosticsByUri?.[importedUri]?.some((diagnostic) =>
      diagnostic.code === "parse.syntax"
    ),
  );
});

Deno.test("LSP server publishes imported open diagnostics on imported document", async () => {
  const published: PublishedDiagnostics[] = [];
  const server = new FigLanguageServer((params) => published.push(params as PublishedDiagnostics));
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

Deno.test("LSP indexes destructured import bindings as imports", async () => {
  const uri = pathToUri("/tmp/project/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    'const { map4_i32, lane4_add_i32, } = @import("./missing.fig");\npub fn main() -> i32 { 0 }',
  );
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === "module.not_found"));
  assert(
    result.symbols.some((symbol) =>
      symbol.kind === "import" && symbol.name === "map4_i32" &&
      symbol.detail === "./missing.fig"
    ),
  );
  assert(
    result.symbols.some((symbol) =>
      symbol.kind === "import" && symbol.name === "lane4_add_i32" &&
      symbol.detail === "./missing.fig"
    ),
  );
  assertEquals(await cache.renameAt(uri, { line: 0, character: 9 }, "renamed"), null);
  assertEquals(referencesAt(result, { line: 0, character: 9 }).length, 1);
});

Deno.test("LSP treats destructured source imports as bindings not namespaces", async () => {
  const dir = await Deno.makeTempDir();
  const importedPath = `${dir}/math.fig`;
  const rootUri = pathToUri(`${dir}/main.fig`);
  const importedUri = pathToUri(importedPath);
  await Deno.writeTextFile(importedPath, "fn add_one(x: i32) -> i32 { x + 1 }");
  const source = 'const { add_one } = @import("./math.fig");\npub fn main() -> i32 { add_one(1) }';
  const cache = new AnalysisCache();
  cache.open(rootUri, 1, source);
  const result = await cache.reanalyze(rootUri);
  assert(result);

  assertEquals(result.imports[0]?.alias, undefined);
  assertEquals(result.imports[0]?.destructured, true);
  assertEquals(hoverAt(result, positionIn(source, "{ add_one", 1)), undefined);
  assertEquals(definitionAt(result, positionIn(source, "add_one(1)", 1))[0]?.uri, importedUri);
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

Deno.test("LSP rename edits imported declaration and importer references", async () => {
  const rootUri = pathToUri("/tmp/project/main.fig");
  const importedUri = pathToUri("/tmp/project/math.fig");
  const cache = new AnalysisCache();
  cache.open(
    importedUri,
    1,
    "fn add_one(x: i32) -> i32 { x + 1 }\nfn local() -> i32 { add_one(1) }",
  );
  cache.open(
    rootUri,
    1,
    'const math = @import("./math.fig");\npub fn main() -> i32 { add_one(1) + math.local() }',
  );
  const result = await cache.reanalyze(rootUri);
  assert(result);

  const edit = await cache.renameAt(rootUri, { line: 1, character: 29 }, "inc");
  assert(edit);
  assertEquals(edit.changes[importedUri]?.length, 2);
  assertEquals(edit.changes[rootUri]?.length, 1);
});

Deno.test("LSP definitions resolve imported and qualified targets", async () => {
  const rootUri = pathToUri("/tmp/project/main.fig");
  const importedUri = pathToUri("/tmp/project/math.fig");
  const cache = new AnalysisCache();
  const imported = "fn add_one(x: i32) -> i32 { x + 1 }\nfn local() -> i32 { add_one(1) }";
  const source =
    'const math = @import("./math.fig");\npub fn main() -> i32 { add_one(1) + math.local() }';
  cache.open(importedUri, 1, imported);
  cache.open(rootUri, 1, source);
  const result = await cache.reanalyze(rootUri);
  assert(result);

  const unqualified = definitionAt(result, positionIn(source, "add_one(1)", 1))[0];
  assertEquals(unqualified?.uri, importedUri);
  assertEquals(
    unqualified?.range.start,
    new PositionMapper(imported).positionAt(imported.indexOf("add_one")),
  );

  const qualifiedPrefix = definitionAt(result, positionIn(source, "math.local", 1))[0];
  assertEquals(qualifiedPrefix?.uri, rootUri);
  assertEquals(
    qualifiedPrefix?.range.start,
    new PositionMapper(source).positionAt(source.indexOf("math")),
  );

  const qualifiedMember = definitionAt(
    result,
    positionIn(source, "math.local", "math.".length + 1),
  )[0];
  assertEquals(qualifiedMember?.uri, importedUri);
  assertEquals(
    qualifiedMember?.range.start,
    new PositionMapper(imported).positionAt(imported.indexOf("local")),
  );
});

Deno.test("LSP definitions prefer pipeline binders over same-named params", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn World() -> struct { let World = {count: i32}; struct(World) }",
    "fn step(value: World) -> World { World {count: value.count + 1} }",
    "pub fn main(seed: World) -> World {",
    "  seed",
    "    \\value -> step(value)",
    "}",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const definition = definitionAt(
    result,
    positionIn(source, "\\value -> step(value)", "\\value -> step(".length),
  )[0];
  assertEquals(definition?.uri, uri);
  assertEquals(
    definition?.range.start,
    new PositionMapper(source).positionAt(source.indexOf("\\value") + 1),
  );
});

Deno.test("LSP rename reads unopened imported files", async () => {
  const dir = await Deno.makeTempDir();
  const importedPath = `${dir}/math.fig`;
  const rootUri = pathToUri(`${dir}/main.fig`);
  const importedUri = pathToUri(importedPath);
  await Deno.writeTextFile(
    importedPath,
    "fn add_one(x: i32) -> i32 { x + 1 }\nfn local() -> i32 { add_one(1) }",
  );
  const cache = new AnalysisCache();
  cache.open(
    rootUri,
    1,
    'const math = @import("./math.fig");\npub fn main() -> i32 { add_one(1) }',
  );
  const result = await cache.reanalyze(rootUri);
  assert(result);

  const edit = await cache.renameAt(rootUri, { line: 1, character: 29 }, "inc");
  assert(edit);
  assertEquals(edit.changes[importedUri]?.length, 2);
  assertEquals(edit.changes[rootUri]?.length, 1);
});

Deno.test("LSP rename does not edit shadowed locals across files", async () => {
  const rootUri = pathToUri("/tmp/project/main.fig");
  const importedUri = pathToUri("/tmp/project/math.fig");
  const cache = new AnalysisCache();
  cache.open(importedUri, 1, "fn helper() -> i32 { let value = 1; value }");
  cache.open(
    rootUri,
    1,
    'const math = @import("./math.fig");\npub fn main() -> i32 { let value = 2; value + helper() }',
  );
  const result = await cache.reanalyze(rootUri);
  assert(result);

  const edit = await cache.renameAt(rootUri, { line: 1, character: 32 }, "renamed");
  assert(edit);
  assertEquals(edit.changes[rootUri]?.length, 2);
  assertEquals(edit.changes[importedUri], undefined);
});

Deno.test("LSP rename rejects invalid targets and disallowed symbols", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(uri, 1, 'const math = @import("./math.fig");\nfn add_one(x: i32) -> i32 { x + 1 }');
  const result = await cache.reanalyze(uri);
  assert(result);

  assertEquals(await cache.renameAt(uri, { line: 1, character: 3 }, "bad-name"), null);
  assertEquals(await cache.renameAt(uri, { line: 0, character: 7 }, "renamed"), null);
});

Deno.test("LSP hover renders TSDoc and inferred types", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = `
    /// Adds a value.
    ///
    /// @param x - input value
    /// @returns incremented value
    fn add_one(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 {
      let y = add_one(1);
      y
    }
  `;
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const fnHover = hoverAt(result, { line: 5, character: 8 });
  assert(fnHover?.contents.value.startsWith("```fig\nfn add_one(x: i32) -> i32\n```"));
  assertStringIncludes(fnHover?.contents.value ?? "", "```fig\nfn add_one(x: i32) -> i32\n```");
  assertStringIncludes(fnHover?.contents.value ?? "", "Adds a value.");
  assertStringIncludes(fnHover?.contents.value ?? "", "**Parameters**");
  assertStringIncludes(fnHover?.contents.value ?? "", "`x`: input value");
  assertStringIncludes(fnHover?.contents.value ?? "", "**Returns**");
  assertStringIncludes(fnHover?.contents.value ?? "", "incremented value");

  const localHover = hoverAt(result, { line: 7, character: 10 });
  assertStringIncludes(localHover?.contents.value ?? "", "```fig\ny: i32\n```");

  const callHover = hoverAt(result, { line: 7, character: 18 });
  assertStringIncludes(callHover?.contents.value ?? "", "```fig\nfn add_one(x: i32) -> i32\n```");
});

Deno.test("LSP hover renders host IO signatures and inferred let results first", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    [
      'const clock = @external("clock", fn(host: io) -> io(i32));',
      "pub fn main(host: io) -> io(i32) {",
      "  do @io(_) {",
      "    now <- clock(host);",
      "    return(now)",
      "  }",
      "}",
    ].join("\n"),
  );
  const result = await cache.reanalyze(uri);
  assert(result);

  const effectHover = hoverAt(result, { line: 0, character: 7 });
  assert(
    effectHover?.contents.value.startsWith(
      "```fig\nconst clock: fn(host: io) -> io(i32)\n```",
    ),
  );

  const nowHover = hoverAt(result, { line: 3, character: 5 });
  assert(nowHover?.contents.value.startsWith("```fig\nnow: i32\n```"));
});

Deno.test("LSP hover renders top-level values inferred from host IO calls", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    [
      'const clock = @external("clock", fn(host: io) -> io(i32));',
      "const host = 0;",
      "const top_const = clock(host);",
      "let top_let = clock(host);",
      "let copied = top_const;",
    ].join("\n"),
  );
  const result = await cache.reanalyze(uri);
  assert(result);

  const topConstHover = hoverAt(result, { line: 2, character: 7 });
  assert(topConstHover?.contents.value.startsWith("```fig\nconst top_const: io(i32)\n```"));

  const topLetHover = hoverAt(result, { line: 3, character: 5 });
  assert(topLetHover?.contents.value.startsWith("```fig\nlet top_let: io(i32)\n```"));

  const copiedHover = hoverAt(result, { line: 4, character: 5 });
  assert(copiedHover?.contents.value.startsWith("```fig\nlet copied: io(i32)\n```"));
});

Deno.test("LSP hover renders structural types for inferred const records", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    [
      "type fn Transform2d() -> struct { let Transform2d = {x: i32}; struct(Transform2d) }",
      "type fn Velocity2d() -> struct { let Velocity2d = {x: i32}; struct(Velocity2d) }",
      "const movement_query = {",
      "  transforms: { count: 3, component: Transform2d },",
      "  velocities: { count: 3, component: Velocity2d },",
      "}",
    ].join("\n"),
  );
  const result = await cache.reanalyze(uri);
  assert(result);

  const hover = hoverAt(result, { line: 2, character: 7 });
  assert(
    hover?.contents.value.startsWith(
      "```fig\nconst movement_query: {transforms: {count: i32, component: type fn Transform2d() -> struct}, velocities: {count: i32, component: type fn Velocity2d() -> struct}}\n```",
    ),
  );
});

Deno.test("LSP hover renders field and expression type details", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    [
      "type fn Point() -> struct {",
      "  let Point = {",
      "    /// horizontal position",
      "    x: i32,",
      "    y: i32",
      "  };",
      "  struct(Point)",
      "}",
      "fn make_point() -> Point { Point {x: 1, y: 2} }",
      "pub fn main() -> i32 { let p = make_point(); p.x }",
    ].join("\n"),
  );
  const result = await cache.reanalyze(uri);
  assert(result);

  const fnUseHover = hoverAt(result, { line: 9, character: 34 });
  assertStringIncludes(fnUseHover?.contents.value ?? "", "fn make_point() -> Point");

  const callHover = hoverAt(result, { line: 9, character: 42 });
  assertStringIncludes(callHover?.contents.value ?? "", "make_point(...): Point");

  const constructorHover = hoverAt(result, { line: 8, character: 28 });
  assertStringIncludes(constructorHover?.contents.value ?? "", "Point: Point");

  const fieldHover = hoverAt(result, { line: 9, character: 47 });
  assertStringIncludes(fieldHover?.contents.value ?? "", "x: i32");
  assertStringIncludes(fieldHover?.contents.value ?? "", "horizontal position");
});

Deno.test("LSP hover preserves product constructor type for inferred lets", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn Velocity2d() -> struct {",
    "  let Velocity2d = {x: i32, y: i32};",
    "  struct(Velocity2d)",
    "}",
    "pub fn main() -> i32 {",
    "  let speed = 4;",
    "  let velocity0 = Velocity2d {x: speed, y: 0};",
    "  velocity0.x",
    "}",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const bindingHover = hoverAt(result, positionIn(source, "velocity0 =", 1));
  assertStringIncludes(bindingHover?.contents.value ?? "", "```fig\nvelocity0: Velocity2d\n```");

  const referenceHover = hoverAt(result, positionIn(source, "velocity0.x", 1));
  assertStringIncludes(referenceHover?.contents.value ?? "", "```fig\nvelocity0: Velocity2d\n```");
});

Deno.test("LSP hover resolves individual dotted value segments", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn Geometry() -> struct {",
    "  let Geometry = {",
    "    vertices: i32,",
    "    /// total vertex count",
    "    vertex_count: i32",
    "  };",
    "  struct(Geometry)",
    "}",
    "fn count(geometry: Geometry) -> i32 { geometry.vertex_count }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const use = "geometry.vertex_count";
  const baseHover = hoverAt(result, positionIn(source, use, 1));
  assertStringIncludes(baseHover?.contents.value ?? "", "```fig\ngeometry: Geometry\n```");
  assertEquals(
    baseHover?.range,
    new PositionMapper(source).range(
      source.indexOf(use),
      source.indexOf(use) + "geometry".length,
    ),
  );

  const fieldHover = hoverAt(result, positionIn(source, use, "Geometry.".length + 1));
  assertStringIncludes(fieldHover?.contents.value ?? "", "```fig\nvertex_count: i32\n```");
  assertStringIncludes(fieldHover?.contents.value ?? "", "total vertex count");
  assertEquals(
    fieldHover?.range,
    new PositionMapper(source).range(
      source.indexOf(use) + "Geometry.".length,
      source.indexOf(use) + use.length,
    ),
  );
});

Deno.test("LSP hover prefers dotted value bases over same-named types", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn Thing() -> struct { let Thing = {value: i32}; struct(Thing) }",
    "fn read(thing: Thing) -> i32 { thing.value }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const valueHover = hoverAt(result, positionIn(source, "thing.value", 1));
  assertStringIncludes(valueHover?.contents.value ?? "", "```fig\nthing: Thing\n```");
  assert(!valueHover?.contents.value.includes("type fn Thing"));
});

Deno.test("LSP hover walks nested dotted value chains by segment", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn ComponentNext() -> struct {",
    "  let ComponentNext = {transforms: i32};",
    "  struct(ComponentNext)",
    "}",
    "type fn World() -> struct {",
    "  let World = {component_next: ComponentNext};",
    "  struct(World)",
    "}",
    "fn read(world: World) -> i32 { world.component_next.transforms }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const use = "world.component_next.transforms";
  const worldHover = hoverAt(result, positionIn(source, use, 1));
  assertStringIncludes(worldHover?.contents.value ?? "", "```fig\nworld: World\n```");

  const nextHover = hoverAt(result, positionIn(source, use, "world.".length + 1));
  assertStringIncludes(
    nextHover?.contents.value ?? "",
    "```fig\ncomponent_next: ComponentNext\n```",
  );

  const transformsHover = hoverAt(
    result,
    positionIn(source, use, "world.component_next.".length + 1),
  );
  assertStringIncludes(transformsHover?.contents.value ?? "", "```fig\ntransforms: i32\n```");
});

Deno.test("LSP hover falls back to raw malformed TSDoc", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    "/// Broken {@link\nfn Bad() -> i32 { 0 }\npub fn main() -> i32 { Bad() }",
  );
  const result = await cache.reanalyze(uri);
  assert(result);
  const hover = hoverAt(result, { line: 1, character: 3 });
  assertStringIncludes(hover?.contents.value ?? "", "Broken {@link");
});

Deno.test("LSP hover resolves pipeline step binder types", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn World() -> struct {",
    "  let World = {count: i32};",
    "  struct(World)",
    "}",
    "fn start() -> World { World {count: 1} }",
    "fn step(value: World) -> World { World {count: value.count + 1} }",
    "fn finish(value: World) -> i32 { value.count }",
    "pub fn main() -> i32 {",
    "  start()",
    "    \\w -> step(w)",
    "    \\w -> finish(w)",
    "}",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const firstBinder = hoverAt(result, positionIn(source, "\\w -> step", 1));
  assertStringIncludes(firstBinder?.contents.value ?? "", "```fig\nw: World\n```");
  const firstUse = hoverAt(result, positionIn(source, "step(w)", "step(".length));
  assertStringIncludes(firstUse?.contents.value ?? "", "```fig\nw: World\n```");
  const secondBinder = hoverAt(result, positionIn(source, "\\w -> finish", 1));
  assertStringIncludes(secondBinder?.contents.value ?? "", "```fig\nw: World\n```");
});

Deno.test("LSP hover keeps qualified pipeline return types across final i32 step", async () => {
  const rootUri = pathToUri("/tmp/project/main.fig");
  const ecsUri = pathToUri("/tmp/project/ecs.fig");
  const cache = new AnalysisCache();
  cache.open(
    ecsUri,
    1,
    "fn run(w: PlaygroundWorld, events: i32, system: fn(w: PlaygroundWorld) -> PlaygroundWorld) -> PlaygroundWorld { w }",
  );
  const source = [
    'const ecs = @import("./ecs.fig");',
    "type fn PlaygroundWorld() -> struct {",
    "  let World = {count: i32};",
    "  struct(World)",
    "}",
    "fn seed_world() -> PlaygroundWorld { World {count: 1} }",
    "fn movement_system(w: PlaygroundWorld) -> PlaygroundWorld { w }",
    "fn velocity_system(w: PlaygroundWorld) -> PlaygroundWorld { w }",
    "fn render_system(w: PlaygroundWorld) -> i32 { w.count }",
    "pub fn main(events: i32) -> i32 {",
    "  seed_world()",
    "    \\w -> ecs.run(w, events, movement_system)",
    "    \\w -> ecs.run(w, events, velocity_system)",
    "    \\w -> render_system(w)",
    "}",
  ].join("\n");
  cache.open(rootUri, 1, source);
  const result = await cache.reanalyze(rootUri);
  assert(result);

  const firstRun = hoverAt(
    result,
    positionIn(source, "\\w -> ecs.run(w, events, movement_system)", 1),
  );
  assertStringIncludes(firstRun?.contents.value ?? "", "```fig\nw: PlaygroundWorld\n```");
  const secondRun = hoverAt(
    result,
    positionIn(source, "\\w -> ecs.run(w, events, velocity_system)", 1),
  );
  assertStringIncludes(secondRun?.contents.value ?? "", "```fig\nw: PlaygroundWorld\n```");
  const render = hoverAt(result, positionIn(source, "\\w -> render_system(w)", 1));
  assertStringIncludes(render?.contents.value ?? "", "```fig\nw: PlaygroundWorld\n```");
});

Deno.test("LSP hover covers checked AST syntax nodes without symbol hovers", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    'const std = @import("prelude.std");',
    'const clock = @external("clock", fn(host: io) -> io(i32));',
    "type fn Pair() -> struct {",
    "  let Pair = {first: i32, second: i32};",
    "  struct(Pair)",
    "}",
    "type fn Checked(t: type) -> type {",
    '  @require(@type_is_product(Pair), "pair");',
    "  t",
    "}",
    "fn make_pair() -> Pair { Pair {first: 2, second: 3} }",
    "fn read(host: io, flag: bool) -> i32 {",
    "  let left, right = make_pair();",
    "  let piped = left \\value -> value + right;",
    "  let made = Pair {first: piped, second: clock(host)};",
    "  match flag {",
    "    true => made.first,",
    "    _ => made.second",
    "  }",
    "}",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const expectHover = (needle: string, inside: number, expected: string) => {
    const hover = hoverAt(result, positionIn(source, needle, inside));
    assertStringIncludes(hover?.contents.value ?? "", expected);
  };
  expectHover("std = @import", 1, "```fig\nprelude.std\n```");
  expectHover("@require", 1, "```fig\n@require: static type reference\n```");
  expectHover("left, right", 1, "```fig\nleft: i32\n```");
  expectHover("\\value ->", 2, "```fig\nvalue: i32\n```");
  expectHover("value + right", "value ".length + 1, "binary expression");
  expectHover("first: i32", 1, "```fig\nfirst: i32\n```");
  expectHover("_ => made.second", 0, "wildcard pattern");
});

Deno.test("LSP hover covers type expressions slots patterns and count expressions", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn Choose(key: const, n: count, a: type) -> type {",
    "  let Pick = match key { #x => a, _ => {n*a} };",
    "  Pick",
    "}",
    "type fn UseChoose() -> type { Choose(#x, 2, i32) }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const expectHover = (needle: string, inside: number, expected: string) => {
    const hover = hoverAt(result, positionIn(source, needle, inside));
    assertStringIncludes(hover?.contents.value ?? "", expected);
  };
  expectHover("key: const", 1, "```fig\nkey: const\n```");
  expectHover("match key", 1, "type match");
  expectHover("#x =>", 1, "type pattern");
  expectHover("_ =>", 0, "type pattern");
  expectHover("n*a", 0, "```fig\nn: count expression\n```");
  expectHover("{n*a}", 0, "shape type");
  expectHover("Choose(#x, 2, i32)", "Choose(#x".length, "Choose(...): type");
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

Deno.test("LSP completions suggest destructured import bindings from source module", async () => {
  const dir = await Deno.makeTempDir();
  const modulePath = `${dir}/geometry.fig`;
  const uri = pathToUri(`${dir}/main.fig`);
  await Deno.writeTextFile(
    modulePath,
    [
      "type fn Geometry2dI32() -> type { i32 }",
      "fn quad2d_rect(x: i32) -> i32 { x }",
      "const origin: i32 = 0",
    ].join("\n"),
  );
  const source = 'const { Geom } = @import("./geometry.fig");\npub fn main() -> i32 { 0 }';
  const cache = new AnalysisCache();
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);
  assert(!result.diagnostics.some((diagnostic) => diagnostic.code === "parse.syntax"));

  const items = await cache.completionsAt(uri, positionIn(source, "Geom", 2));
  assert(items.some((item) => item.label === "Geometry2dI32" && item.kind === 7));
  assert(items.some((item) => item.label === "quad2d_rect" && item.kind === 3));
  assert(items.some((item) => item.label === "origin" && item.kind === 21));
});

Deno.test("LSP completions filter checked product members after dot", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const lines = [
    "type fn Point() -> struct {",
    "  let Point = {",
    "    /// horizontal position",
    "    x: i32,",
    "    y: i32",
    "  };",
    "  struct(Point)",
    "}",
    "fn unrelated() -> i32 { 0 }",
    "pub fn main() -> i32 { let p: Point = Point {x: 1, y: 2}; p.y }",
  ];
  cache.open(uri, 1, lines.join("\n"));

  const items = await cache.completionsAt(uri, { line: 9, character: lines[9].indexOf("p.") + 2 });
  assert(items.some((item) =>
    item.label === "x" && item.detail === "i32" &&
    item.documentation?.includes("horizontal position")
  ));
  assert(items.some((item) => item.label === "y" && item.detail === "i32"));
  assert(!items.some((item) => item.label === "unrelated"));
  assert(!items.some((item) => item.label === "fn"));

  const prefixed = await cache.completionsAt(uri, {
    line: 9,
    character: lines[9].indexOf("p.") + 3,
  });
  assertEquals(prefixed.map((item) => item.label), ["y"]);
});

Deno.test("LSP completions include checked attached type members after ::", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const lines = [
    "type fn Point() -> struct { let Point = {x: i32}; struct(Point) }",
    "/// equality member",
    "fn Point::eql(a: Point, b: Point) -> bool { a.x == b.x }",
    "pub fn main() -> i32 { Point:: }",
  ];
  cache.open(uri, 1, lines.join("\n"));

  const items = await cache.completionsAt(uri, {
    line: 3,
    character: lines[3].indexOf("Point::") + 7,
  });
  assert(items.some((item) =>
    item.label === "eql" &&
    item.detail === "fn(a: Point, b: Point) -> bool" &&
    item.documentation?.includes("equality member")
  ));
});

Deno.test("LSP completions fall back when member receiver cannot be checked", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const line = "pub fn main() -> i32 { missing. }";
  cache.open(uri, 1, line);

  const items = await cache.completionsAt(uri, {
    line: 0,
    character: line.indexOf("missing.") + 8,
  });
  assert(items.some((item) => item.label === "@import"));
  assert(items.some((item) => item.label === "fn"));
});

Deno.test("LSP inlay hints render inferred local let types", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  cache.open(
    uri,
    1,
    "pub fn main() -> i32 { let y = 0 .. 3; let explicit: RangeI32 = y; let z = y; 1 }",
  );
  const result = await cache.reanalyze(uri);
  assert(result);

  const hints = inlayHintsAt(result, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 80 },
  });
  assertEquals(hints.map((hint) => hint.label), [": range_i32", ": range_i32"]);
  assertEquals(hints.map((hint) => hint.kind), [1, 1]);

  const firstHintOnly = inlayHintsAt(result, {
    start: { line: 0, character: 24 },
    end: { line: 0, character: 35 },
  });
  assertEquals(firstHintOnly.map((hint) => hint.label), [": range_i32"]);
});

Deno.test("LSP inlay hints place repeated unspanned local names once per source binding", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "pub fn a(x: i32) -> i32 { let flag = x > 0; match flag { true => 1, false => 0 } }",
    "pub fn b(x: i32) -> i32 { let flag = x > 1; match flag { true => 1, false => 0 } }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const hints = inlayHintsAt(result, {
    start: { line: 0, character: 0 },
    end: { line: 2, character: 0 },
  });
  assertEquals(hints.map((hint) => hint.label), [": bool", ": bool"]);
  assertEquals(hints.map((hint) => hint.position), [
    { line: 0, character: 34 },
    { line: 1, character: 34 },
  ]);
});

Deno.test("LSP inlay hints ignore type-block shape declarations", async () => {
  const uri = pathToUri("/tmp/main.fig");
  const cache = new AnalysisCache();
  const source = [
    "type fn Collider2d() -> type {",
    "  let Collider2d = {",
    "    offset_x: i32,",
    "    offset_y: i32,",
    "    w: i32,",
    "    h: i32,",
    "    active: i32",
    "  };",
    "  struct(Collider2d)",
    "}",
    "pub fn main() -> i32 { let active = 1; active }",
  ].join("\n");
  cache.open(uri, 1, source);
  const result = await cache.reanalyze(uri);
  assert(result);

  const hints = inlayHintsAt(result, {
    start: { line: 0, character: 0 },
    end: { line: 10, character: 0 },
  });
  assertEquals(hints.map((hint) => hint.label), []);
});

Deno.test("LSP inlay hints infer product constructors and hide import aliases", async () => {
  const rootUri = pathToUri("/tmp/project/main.fig");
  const geometryUri = pathToUri("/tmp/project/geometry.fig");
  const cache = new AnalysisCache();
  cache.open(
    geometryUri,
    1,
    [
      "type fn Geometry2dBatchI32(capacity: count) -> struct {",
      "  let Geometry2dBatchI32 = {len: i32};",
      "  struct(Geometry2dBatchI32)",
      "}",
      "fn empty_geometry2d_batch(const capacity: count) -> Geometry2dBatchI32(capacity) {",
      "  Geometry2dBatchI32 {len: 0}",
      "}",
      "fn append_geometry2d_batch(",
      "  front: Geometry2dBatchI32(capacity),",
      "  back: Geometry2dBatchI32(capacity)",
      ") -> Geometry2dBatchI32(capacity) {",
      "  front",
      "}",
    ].join("\n"),
  );
  const source = [
    'const { Geometry2dBatchI32, empty_geometry2d_batch, append_geometry2d_batch } = @import("./geometry.fig");',
    "type fn Velocity2d() -> struct {",
    "  let Velocity2d = {x: i32, y: i32};",
    "  struct(Velocity2d)",
    "}",
    "pub fn main() -> i32 {",
    "  let speed = 4;",
    "  let velocity0 = Velocity2d {x: speed, y: 0};",
    "  let acc0 = empty_geometry2d_batch(3);",
    "  let acc1 = append_geometry2d_batch(acc0, acc0);",
    "  velocity0.x + acc1.len",
    "}",
  ].join("\n");
  cache.open(rootUri, 1, source);
  const result = await cache.reanalyze(rootUri);
  assert(result);

  const labels = inlayHintsAt(result, {
    start: { line: 0, character: 0 },
    end: { line: 20, character: 0 },
  }).map((hint) => hint.label);
  assert(labels.includes(": Velocity2d"));
  assertEquals(labels.filter((label) => label === ": Geometry2dBatchI32(3)").length, 1);
  assert(labels.includes(": Geometry2dBatchI32(capacity)"));
  assertEquals(labels.some((label) => label.includes("__import")), false);

  const hover = hoverAt(result, positionIn(source, "acc0 =", 1));
  assertStringIncludes(hover?.contents.value ?? "", "```fig\nacc0: Geometry2dBatchI32(3)\n```");
  assertEquals(hover?.contents.value.includes("__import"), false);
});

Deno.test("LSP server advertises and returns inlay hints", async () => {
  const server = new FigLanguageServer();
  const init = await server.handle("initialize", {});
  assertEquals(
    (init as { capabilities: { inlayHintProvider?: boolean } }).capabilities.inlayHintProvider,
    true,
  );
  const uri = pathToUri("/tmp/main.fig");
  await server.handle("textDocument/didOpen", {
    textDocument: {
      uri,
      languageId: "fig",
      version: 1,
      text: "pub fn main() -> i32 { let y = 0 .. 3; 1 }",
    },
  });
  const hints = await server.handle("textDocument/inlayHint", {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 80 } },
  }) as { label: string }[];
  assertEquals(hints.map((hint) => hint.label), [": range_i32"]);
});

Deno.test("LSP inlay hints return empty for invalid documents", async () => {
  const uri = pathToUri("/tmp/invalid.fig");
  const cache = new AnalysisCache();
  cache.open(uri, 1, "fn main( -> i32 { let y = 1; y }");
  const result = await cache.reanalyze(uri);
  assert(result);

  assertEquals(
    inlayHintsAt(result, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 80 },
    }),
    [],
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
