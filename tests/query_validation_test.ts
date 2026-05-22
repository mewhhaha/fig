import { assertEquals } from "jsr:@std/assert@1";
import { Language, Parser, Query } from "web-tree-sitter";

type Grammar = {
  rules: Record<string, unknown>;
};

const root = new URL("../", import.meta.url);
const grammarUrl = new URL("generated/baba-workbench/src/grammar.json", root);
const parserUrl = new URL("generated/baba-workbench/tree-sitter-fig.wasm", root);
const queriesUrl = new URL("generated/baba-workbench/queries/", root);
const helixQueriesUrl = new URL("helix/runtime/queries/fig/", root);
const queryBuiltins = new Set(["ERROR", "MISSING"]);

Deno.test("generated tree-sitter queries only reference generated nodes", async () => {
  const grammar = JSON.parse(await Deno.readTextFile(grammarUrl)) as Grammar;
  const generatedNodes = new Set(Object.keys(grammar.rules));

  const unknownReferences: string[] = [];
  for await (const entry of Deno.readDir(queriesUrl)) {
    if (!entry.isFile || !entry.name.endsWith(".scm")) continue;
    const query = await Deno.readTextFile(new URL(entry.name, queriesUrl));
    for (const nodeName of extractNamedNodeReferences(query)) {
      if (!generatedNodes.has(nodeName) && !queryBuiltins.has(nodeName)) {
        unknownReferences.push(`${entry.name}: ${nodeName}`);
      }
    }
  }

  assertEquals(unknownReferences, []);
});

Deno.test("generated tree-sitter queries compile against the wasm parser", async () => {
  await Parser.init();
  const language = await Language.load(parserUrl.pathname);
  const failures: string[] = [];

  for await (const entry of Deno.readDir(queriesUrl)) {
    if (!entry.isFile || !entry.name.endsWith(".scm")) continue;
    try {
      new Query(language, await Deno.readTextFile(new URL(entry.name, queriesUrl)));
    } catch (error) {
      failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  assertEquals(failures, []);
});

Deno.test("workbench and Helix highlight queries stay in sync", async () => {
  const workbenchHighlights = await Deno.readTextFile(new URL("highlights.scm", queriesUrl));
  const helixHighlights = await Deno.readTextFile(new URL("highlights.scm", helixQueriesUrl));

  assertEquals(workbenchHighlights, helixHighlights);
});

Deno.test("highlight query captures shape field identifiers", async () => {
  await Parser.init();
  const language = await Language.load(parserUrl.pathname);
  const parser = new Parser();
  parser.setLanguage(language);
  const source = `
type fn Point() -> struct {
  let Point = {x: i32, y: i32};
  struct(Point)
}
fn origin() -> {x: i32, y: i32} {
  {x: 0, y: 0}
}
`;
  const tree = parser.parse(source);
  if (!tree) throw new Error("failed to parse shape highlight smoke source");
  const query = new Query(language, await Deno.readTextFile(new URL("highlights.scm", queriesUrl)));

  const memberTexts = query.captures(tree.rootNode)
    .filter((capture) => capture.name === "variable.other.member")
    .map((capture) => capture.node.text);

  assertEquals(memberTexts, ["x", "y", "x", "y"]);
});

Deno.test("highlight query captures static builtin identifiers", async () => {
  await Parser.init();
  const language = await Language.load(parserUrl.pathname);
  const parser = new Parser();
  parser.setLanguage(language);
  const source = `fn main() -> i32 { @inline_array_builder_start(2, i32) }`;
  const tree = parser.parse(source);
  if (!tree) throw new Error("failed to parse highlight smoke source");
  const query = new Query(language, await Deno.readTextFile(new URL("highlights.scm", queriesUrl)));

  const captures = query.captures(tree.rootNode).map((capture) => ({
    name: capture.name,
    text: capture.node.text,
  }));

  assertEquals(
    captures.some(({ name, text }) =>
      name === "function.builtin" && text === "inline_array_builder_start"
    ),
    true,
  );
});

Deno.test("highlight query captures type function and const declaration names", async () => {
  await Parser.init();
  const language = await Language.load(parserUrl.pathname);
  const parser = new Parser();
  parser.setLanguage(language);
  const source = `
type fn Hello() -> type { i32 }
const answer: i32 = 42;
const { map4_i32, Geometry2dI32 } = @import("prelude.array_static");
`;
  const tree = parser.parse(source);
  if (!tree) throw new Error("failed to parse declaration highlight smoke source");
  const query = new Query(language, await Deno.readTextFile(new URL("highlights.scm", queriesUrl)));

  const captures = query.captures(tree.rootNode).map((capture) => ({
    name: capture.name,
    text: capture.node.text,
  }));

  assertEquals(
    captures.filter((capture) => capture.name === "type").map((capture) => capture.text),
    ["Hello", "Geometry2dI32"],
  );
  assertEquals(
    captures.some(({ name, text }) => name === "constant" && text === "map4_i32"),
    true,
  );
  assertEquals(
    captures.some(({ name, text }) => name === "constant" && text === "answer"),
    true,
  );
});

Deno.test("highlight query captures type identifiers inside union types", async () => {
  await Parser.init();
  const language = await Language.load(parserUrl.pathname);
  const parser = new Parser();
  parser.setLanguage(language);
  const source = `fn Choose(x: left | right | result) -> left { x }`;
  const tree = parser.parse(source);
  if (!tree) throw new Error("failed to parse union highlight smoke source");
  const query = new Query(language, await Deno.readTextFile(new URL("highlights.scm", queriesUrl)));

  const captures = query.captures(tree.rootNode).map((capture) => ({
    name: capture.name,
    text: capture.node.text,
  }));

  assertEquals(
    captures.filter((capture) => capture.name === "type.parameter").map((capture) => capture.text),
    ["left", "right", "result", "left"],
  );
});

Deno.test("highlight query separates do bind arrows and comparison operators", async () => {
  await Parser.init();
  const language = await Language.load(parserUrl.pathname);
  const parser = new Parser();
  parser.setLanguage(language);
  const source = `
fn main(a: i32, b: i32) -> i32 {
  do @monad(Id(_)) {
    row <- each(4);
    if a < b { 1 } else { 2 }
  }
}
`;
  const tree = parser.parse(source);
  if (!tree) throw new Error("failed to parse do highlight smoke source");
  const query = new Query(language, await Deno.readTextFile(new URL("highlights.scm", queriesUrl)));

  const captures = query.captures(tree.rootNode).map((capture) => ({
    name: capture.name,
    text: capture.node.text,
  }));

  assertEquals(
    captures.some(({ name, text }) => name === "keyword.directive" && text === "@monad"),
    true,
  );
  assertEquals(captures.some(({ name, text }) => name === "variable" && text === "row"), true);
  assertEquals(captures.some(({ name, text }) => name === "operator" && text === "<-"), true);
  assertEquals(captures.some(({ name, text }) => name === "operator" && text === "<"), true);
  assertEquals(captures.some(({ name, text }) => name === "constant" && text.includes("<")), false);
});

Deno.test("highlight query distinguishes collection delimiters from comparison operators", async () => {
  await Parser.init();
  const language = await Language.load(parserUrl.pathname);
  const parser = new Parser();
  parser.setLanguage(language);
  const source = `
type fn Bag(a: type) {
  let Bag = {sum: i32};
  struct(Bag)
}
fn list() -> Bag(i32) { #[1, 2] }
`;
  const tree = parser.parse(source);
  if (!tree) throw new Error("failed to parse collection highlight smoke source");
  const query = new Query(language, await Deno.readTextFile(new URL("highlights.scm", queriesUrl)));

  const captures = query.captures(tree.rootNode).map((capture) => ({
    name: capture.name,
    text: capture.node.text,
  }));

  assertEquals(
    captures.filter(({ name, text }) => name === "punctuation.bracket" && text === "#[").length,
    1,
  );
  assertEquals(
    captures.filter(({ name, text }) => name === "punctuation.bracket" && text === "]").length,
    1,
  );
  assertEquals(captures.some(({ name, text }) => name === "constant" && text === "#["), false);
  assertEquals(captures.some(({ name, text }) => name === "constant" && text === "]"), false);
});

function extractNamedNodeReferences(query: string): string[] {
  const references = new Set<string>();
  const queryWithoutStrings = stripStringsAndComments(query);
  for (const match of queryWithoutStrings.matchAll(/\(([A-Za-z_][A-Za-z0-9_]*)/g)) {
    references.add(match[1]);
  }
  return [...references].sort();
}

function stripStringsAndComments(source: string): string {
  let result = "";
  let inString = false;
  let inComment = false;
  let escaped = false;

  for (const char of source) {
    if (inComment) {
      if (char === "\n") {
        inComment = false;
        result += char;
      } else {
        result += " ";
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      result += char === "\n" ? "\n" : " ";
      continue;
    }

    if (char === ";") {
      inComment = true;
      result += " ";
    } else if (char === '"') {
      inString = true;
      result += " ";
    } else {
      result += char;
    }
  }

  return result;
}
