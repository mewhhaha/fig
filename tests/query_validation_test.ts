import { assertEquals } from "jsr:@std/assert@1";

type NodeType = {
  type: string;
  named: boolean;
  subtypes?: Array<{ type: string; named: boolean }>;
};

const root = new URL("../", import.meta.url);
const nodeTypesUrl = new URL("generated/baba-workbench/src/node-types.json", root);
const queriesUrl = new URL("generated/baba-workbench/queries/", root);
const queryBuiltins = new Set(["ERROR", "MISSING"]);

Deno.test("generated tree-sitter queries only reference generated nodes", async () => {
  const nodeTypes = JSON.parse(await Deno.readTextFile(nodeTypesUrl)) as NodeType[];
  const generatedNodes = new Set<string>();
  for (const nodeType of nodeTypes) {
    if (nodeType.named) generatedNodes.add(nodeType.type);
    for (const subtype of nodeType.subtypes ?? []) {
      if (subtype.named) generatedNodes.add(subtype.type);
    }
  }

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
