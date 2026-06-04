type BabaModule = {
  parseGrammar(source: string): unknown;
  parseMetadata(source: string): unknown;
};

type BabaAdvancedModule = {
  createLexicalSpec(grammar: unknown, options: { skipValidation: boolean }): unknown;
  generateAstTypesSource(
    grammar: unknown,
    options: { metadata: unknown; skipValidation: boolean },
  ): string;
  generateAstVisitorSource(
    grammar: unknown,
    options: { metadata: unknown; skipValidation: boolean },
  ): string;
  generateLexicalManifest(grammar: unknown, options: { spec: unknown }): string;
  generateTokenizerSource(
    grammar: unknown,
    options: { spec: unknown; metadata: unknown; skipValidation: boolean },
  ): string;
  generateTreeSitterGrammar(
    grammar: unknown,
    options: { name: string; metadata: unknown; skipValidation: boolean },
  ): string;
  generateWorkbenchQueries(
    grammar: unknown,
    options: { metadata: unknown; skipValidation: boolean },
  ): Record<string, string>;
};

const dynamicImport = new Function("specifier", "return import(specifier)") as <T>(
  specifier: string,
) => Promise<T>;
const { parseGrammar, parseMetadata } = await dynamicImport<BabaModule>("@mewhhaha/baba");
const {
  createLexicalSpec,
  generateAstTypesSource,
  generateAstVisitorSource,
  generateLexicalManifest,
  generateTokenizerSource,
  generateTreeSitterGrammar,
  generateWorkbenchQueries,
} = await dynamicImport<BabaAdvancedModule>("@mewhhaha/baba/advanced");

const grammarSource = await Deno.readTextFile("grammar.ebnf");
const metadataSource = await Deno.readTextFile("baba.json");
const grammar = parseGrammar(grammarSource);
const metadata = parseMetadata(metadataSource);
const spec = createLexicalSpec(grammar, { skipValidation: true });
const queries = generateWorkbenchQueries(grammar, {
  metadata,
  skipValidation: true,
});
const operatorSymbolChars = ["+", "-", "*", "/", "%", "<", ">", "=", "!", "&", "|", "^", "$"];
const reservedOperatorSymbols = ["->", "=>", "<-", "="];
const operatorSymbolCharSet = JSON.stringify(operatorSymbolChars);
const reservedOperatorSymbolSet = JSON.stringify(reservedOperatorSymbols);
const files: Array<{ path: string; content: string }> = [
  { path: "lexical.json", content: generateLexicalManifest(grammar, { spec }) },
  {
    path: "tokenizer.ts",
    content: generateTokenizerSource(grammar, {
      spec,
      metadata,
      skipValidation: true,
    }),
  },
  {
    path: "grammar.js",
    content: generateTreeSitterGrammar(grammar, {
      name: "fig",
      metadata,
      skipValidation: true,
    }),
  },
  {
    path: "ast/types.ts",
    content: generateAstTypesSource(grammar, {
      metadata,
      skipValidation: true,
    }),
  },
  {
    path: "ast/visitor.ts",
    content: generateAstVisitorSource(grammar, {
      metadata,
      skipValidation: true,
    }),
  },
  ...Object.entries(queries).map(([path, content]) => ({ path: `queries/${path}`, content })),
];

const bundle = { files };

/*
 * Fig's grammar intentionally has tree-sitter conflicts such as do-bind vs expression statements.
 * Baba's generated parser is predictive and rejects those shapes, so the compiler parser sources
 * stay checked in until Baba exposes a non-predictive parser generator path.
 */
await Deno.mkdir("generated/baba-workbench", { recursive: true });

for (const file of bundle.files) {
  const path = `generated/baba-workbench/${file.path}`;
  const slash = path.lastIndexOf("/");
  if (slash >= 0) await Deno.mkdir(path.slice(0, slash), { recursive: true });
  let content = file.content;
  if (file.path === "grammar.js") {
    content = content.replace("Comment: $ => /\\\\/\\\\/[^\\n]*/", "Comment: $ => /\\/\\/[^\\n]*/");
    content = content.replace(
      "[$.MatchValues],\n  ],",
      "[$.MatchValues],\n    [$.Primary, $.ScalarDomainType],\n    [$.TypePrimary, $.ScalarDomainType],\n  ],",
    );
    content = content.replace(
      "[$.TypePrimary, $.ScalarDomainType],\n  ],",
      "[$.TypePrimary, $.ScalarDomainType],\n    [$.Tag, $.TypePrimary],\n  ],",
    );
  }
  if (file.path === "tokenizer.ts") {
    content = content.replace(
      'const lineComment = "//";\n',
      'const lineComment = "//";\n' +
        `const operatorSymbolChars = new Set(${operatorSymbolCharSet});\n` +
        `const reservedOperatorSymbols = new Set(${reservedOperatorSymbolSet});\n`,
    );
    content = content.replace(
      "  const char = source[start];\n  const symbol = symbols.find((candidate) => source.startsWith(candidate, start));",
      "  const char = source[start];\n" +
        "  const operator = scanOperatorSymbol(source, start);\n" +
        "  if (operator) return operator;\n\n" +
        "  const symbol = symbols.find((candidate) => source.startsWith(candidate, start));",
    );
    content = content.replace(
      "  throw new Error(`Unexpected character '${char}' at ${start}..${start + 1}`);\n}\n\nfunction scanSkip",
      "  throw new Error(`Unexpected character '${char}' at ${start}..${start + 1}`);\n" +
        "}\n\n" +
        "function scanOperatorSymbol(source: string, start: number): Token | null {\n" +
        "  if (!isOperatorSymbolChar(source[start])) return null;\n" +
        "  let end = start + 1;\n" +
        "  while (end < source.length && isOperatorSymbolChar(source[end])) end++;\n" +
        "  const text = source.slice(start, end);\n" +
        "  if (reservedOperatorSymbols.has(text)) return null;\n" +
        '  return { kind: "OperatorSymbol", text, span: { start, end } };\n' +
        "}\n\n" +
        "function isOperatorSymbolChar(char: string | undefined): boolean {\n" +
        "  if (char === undefined) return false;\n" +
        "  return operatorSymbolChars.has(char);\n" +
        "}\n\n" +
        "function scanSkip",
    );
  }
  if (file.path === "queries/highlights.scm") {
    content = content
      .replace("(TypeAtom (LowerIdent) @type)", "(TypeAtom (LowerIdent) @type.parameter)")
      .replace('"." @punctuation.delimiter\n', '"." @punctuation.delimiter\n".." @operator\n')
      .replace("(TypeAtom (PascalIdent) @type.parameter)\n", "")
      .replace("(TypePrimary (LowerIdent) @type)\n", "")
      .replace("(TypePrimary (PascalIdent) @type.parameter)\n", "")
      .replace("(TypeFnDecl (LowerIdent) @type.definition)\n", "")
      .replace("(TypeFnDecl (PascalIdent) @type.definition)", "(TypeFnDecl (PascalIdent) @type)")
      .replace("(TypeLetDecl (PascalIdent) @type)\n", "")
      .replace("(TypeAssertDecl (PascalIdent) @type)\n", "")
      .replace("(Placeholder) @operator\n", "")
      .replace(
        "(ImportBindingItems (PascalIdent) @type.definition)",
        "(ImportBindingItems (PascalIdent) @type)",
      )
      .replace("(CollectionOpen) @constant\n", "")
      .replace("(DoBindName) @constant\n", "")
      .replace("(OperatorSymbol) @constant\n", "");
    content += [
      "(DoStrategy (StaticBuiltin) @keyword.directive)",
      "(BranchHint) @keyword.directive",
      "(DoBindStmt (LowerIdent) @variable)",
      "(CollectionValue (CollectionOpen) @punctuation.bracket)",
      "(Op) @operator",
    ].join("\n") + "\n";
  }
  await Deno.writeTextFile(path, content);
}

await Deno.remove("helix/runtime/queries/fig", { recursive: true }).catch(() => {});
await Deno.mkdir("helix/runtime/queries/fig", { recursive: true });
for await (const entry of Deno.readDir("generated/baba-workbench/queries")) {
  if (!entry.isFile || !entry.name.endsWith(".scm")) continue;
  await Deno.copyFile(
    `generated/baba-workbench/queries/${entry.name}`,
    `helix/runtime/queries/fig/${entry.name}`,
  );
}

const tokenKinds = [
  "import",
  "external",
  "type",
  "const",
  "fn",
  "if",
  "else",
  "let",
  "match",
  "pub",
  "bool",
  "identifier",
  "number",
  "string",
  "char",
  "multiline",
  "literalType",
  "symbol",
];

await Deno.writeTextFile(
  "generated/tokenizer.ts",
  `// Generated by scripts/generate_grammar.ts from grammar.ebnf via @mewhhaha/baba.\n` +
    `export const tokenKinds = ${JSON.stringify(tokenKinds, null, 2)} as const;\n` +
    `export type GeneratedTokenKind = typeof tokenKinds[number];\n`,
);
