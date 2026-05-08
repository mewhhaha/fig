import { checkSourceForAnalysis, type ModuleSource, parse } from "../mod.ts";
import { CompileError, type Diagnostic as CompileDiagnostic } from "../diagnostics.ts";
import type { Declaration, Program, Statement } from "../core_ast.ts";
import { candidateModulePaths, pathToUri, uriToPath } from "./modules.ts";
import { PositionMapper } from "./position.ts";
import type {
  CodeAction,
  CompletionItem,
  Diagnostic,
  DocumentSymbol,
  Location,
  Position,
  Range,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
} from "./protocol.ts";

export interface TextDocument {
  uri: string;
  version: number;
  text: string;
}

export interface IndexedSymbol {
  name: string;
  kind: "fn" | "const" | "let" | "type" | "param" | "local" | "import" | "member" | "variant";
  uri: string;
  range: Range;
  selectionRange: Range;
  detail?: string;
  documentation?: string;
  container?: string;
  generated?: boolean;
  intrinsic?: boolean;
}

export interface IndexedReference {
  name: string;
  uri: string;
  range: Range;
  targetName?: string;
}

export interface AnalysisResult {
  document: TextDocument;
  mapper: PositionMapper;
  diagnostics: Diagnostic[];
  diagnosticsByUri?: Record<string, Diagnostic[]>;
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  imports: IndexedImport[];
  program?: Program;
}

export interface IndexedImport {
  module: string;
  alias?: string;
  uri?: string;
  range: Range;
}

const BUILTIN_COMPLETIONS: CompletionItem[] = [
  { label: "@import", kind: 3, detail: "source import" },
  { label: "@capability", kind: 3, detail: "host capability import" },
  { label: "@require", kind: 3, detail: "compile-time requirement" },
  { label: "prelude.std", kind: 9, detail: "module" },
  { label: "prelude.option", kind: 9, detail: "module" },
  { label: "prelude.result", kind: 9, detail: "module" },
  { label: "prelude.array_static", kind: 9, detail: "module" },
  { label: "web.canvas", kind: 9, detail: "module" },
  { label: "engine.ecs", kind: 9, detail: "module" },
];

export class AnalysisCache {
  private openDocuments = new Map<string, TextDocument>();
  private results = new Map<string, AnalysisResult>();
  private reverseImports = new Map<string, Set<string>>();

  open(uri: string, version: number, text: string): AnalysisResult {
    const document = { uri, version, text };
    this.openDocuments.set(uri, document);
    return this.analyze(document);
  }

  change(uri: string, version: number, text: string): AnalysisResult {
    return this.open(uri, version, text);
  }

  close(uri: string) {
    this.openDocuments.delete(uri);
    this.results.delete(uri);
  }

  get(uri: string): AnalysisResult | undefined {
    const open = this.openDocuments.get(uri);
    if (open) return this.results.get(uri) ?? this.analyze(open);
    return undefined;
  }

  async moduleText(entryUri: string, moduleName: string): Promise<ModuleSource | undefined> {
    for (const path of candidateModulePaths(uriToPath(entryUri), moduleName)) {
      const uri = pathToUri(path);
      const open = this.openDocuments.get(uri);
      if (open) return { text: open.text, sourceId: uri };
      try {
        return { text: await Deno.readTextFile(path), sourceId: uri };
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return undefined;
  }

  private analyze(document: TextDocument): AnalysisResult {
    const mapper = new PositionMapper(document.text);
    const result: AnalysisResult = {
      document,
      mapper,
      diagnostics: [],
      symbols: indexSource(document.uri, document.text, mapper),
      references: indexReferences(document.uri, document.text, mapper),
      imports: indexImports(document.uri, document.text, mapper),
    };
    this.results.set(document.uri, result);
    return result;
  }

  async reanalyze(uri: string): Promise<AnalysisResult | undefined> {
    const document = this.openDocuments.get(uri);
    if (!document) return undefined;
    const mapper = new PositionMapper(document.text);
    const diagnosticsByUri: Record<string, Diagnostic[]> = { [document.uri]: [] };
    let program: Program | undefined;
    try {
      program = await parse(document.text, { sourceId: document.uri });
      const checked = await checkSourceForAnalysis(document.text, {
        sourceId: document.uri,
        resolveModule: (moduleName) => this.moduleText(uri, moduleName),
      });
      program = checked.program;
      for (const item of checked.diagnostics) {
        if (
          item.span?.sourceId &&
          item.span.sourceId !== document.uri &&
          !this.openDocuments.has(item.span.sourceId)
        ) {
          continue;
        }
        const targetUri = item.span?.sourceId === document.uri || !item.span?.sourceId
          ? document.uri
          : item.span.sourceId;
        const targetDocument = this.openDocuments.get(targetUri) ?? document;
        const targetMapper = targetUri === document.uri
          ? mapper
          : new PositionMapper(targetDocument.text);
        (diagnosticsByUri[targetUri] ??= []).push(toLspDiagnostic(item, targetMapper));
      }
    } catch (error) {
      if (error instanceof CompileError) {
        for (const item of error.diagnostics) {
          if (
            item.span?.sourceId &&
            item.span.sourceId !== document.uri &&
            !this.openDocuments.has(item.span.sourceId)
          ) {
            continue;
          }
          const targetUri = item.span?.sourceId === document.uri || !item.span?.sourceId
            ? document.uri
            : item.span.sourceId;
          const targetDocument = this.openDocuments.get(targetUri) ?? document;
          const targetMapper = targetUri === document.uri
            ? mapper
            : new PositionMapper(targetDocument.text);
          (diagnosticsByUri[targetUri] ??= []).push(toLspDiagnostic(item, targetMapper));
        }
      } else {
        diagnosticsByUri[document.uri].push({
          range: mapper.range(0, 0),
          severity: 1,
          source: "fig",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const result: AnalysisResult = {
      document,
      mapper,
      diagnostics: diagnosticsByUri[document.uri],
      diagnosticsByUri,
      symbols: [
        ...indexProgram(document.uri, program, document.text, mapper),
        ...indexSource(document.uri, document.text, mapper),
        ...builtinSymbols(document.uri, mapper),
      ],
      references: indexReferences(document.uri, document.text, mapper),
      imports: indexImports(document.uri, document.text, mapper)
        .map((item) => ({ ...item, uri: this.resolveImportUri(uri, item.module) })),
      program,
    };
    result.symbols = dedupeSymbols(result.symbols);
    this.updateReverseImports(uri, result.imports);
    this.results.set(uri, result);
    return result;
  }

  async reanalyzeAffected(uri: string): Promise<AnalysisResult[]> {
    const seen = new Set<string>();
    const queue = [uri];
    const results: AnalysisResult[] = [];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const result = await this.reanalyze(next);
      if (result) results.push(result);
      for (const dependent of this.reverseImports.get(next) ?? []) queue.push(dependent);
    }
    return results;
  }

  allResults(): AnalysisResult[] {
    return [...this.results.values()];
  }

  private resolveImportUri(entryUri: string, moduleName: string): string | undefined {
    for (const path of candidateModulePaths(uriToPath(entryUri), moduleName)) {
      const uri = pathToUri(path);
      if (this.openDocuments.has(uri)) return uri;
      try {
        Deno.statSync(path);
        return uri;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return undefined;
  }

  private updateReverseImports(uri: string, imports: IndexedImport[]) {
    for (const dependents of this.reverseImports.values()) dependents.delete(uri);
    for (const item of imports) {
      if (!item.uri) continue;
      const dependents = this.reverseImports.get(item.uri) ?? new Set<string>();
      dependents.add(uri);
      this.reverseImports.set(item.uri, dependents);
    }
  }
}

export function hoverAt(
  result: AnalysisResult,
  position: Position,
): { contents: { kind: "markdown"; value: string }; range?: Range } | undefined {
  const symbol = symbolAt(result, position);
  if (!symbol) return undefined;
  const lines = [`**${symbol.kind}** \`${symbol.name}\``];
  if (symbol.detail) lines.push("", symbol.detail);
  if (symbol.documentation) lines.push("", symbol.documentation);
  return { contents: { kind: "markdown", value: lines.join("\n") }, range: symbol.selectionRange };
}

export function definitionAt(result: AnalysisResult, position: Position): Location[] {
  const symbol = resolvedSymbolAt(result, position);
  return symbol ? [{ uri: symbol.uri, range: symbol.selectionRange }] : [];
}

export function completionsAt(result: AnalysisResult, position: Position): CompletionItem[] {
  const offset = result.mapper.offsetAt(position);
  const prefix = qualifiedPrefix(result.document.text, offset);
  const importString = importStringPrefix(result.document.text, offset);
  if (importString) {
    return BUILTIN_COMPLETIONS.filter((item) => item.detail === "module").map((item) => ({
      ...item,
      label: item.label,
    }));
  }
  if (sourceBefore(result.document.text, offset).endsWith("@")) {
    return BUILTIN_COMPLETIONS.filter((item) => item.label.startsWith("@"));
  }
  const symbols = result.symbols
    .filter((item) => !prefix || item.name.startsWith(`${prefix}.`))
    .map((item) => ({
      label: prefix ? item.name.slice(prefix.length + 1) : item.name,
      kind: completionKind(item.kind),
      detail: item.detail ?? item.kind,
      documentation: item.documentation,
    }));
  const snippets: CompletionItem[] = [
    {
      label: "fn",
      kind: 15,
      detail: "function snippet",
      insertText: "fn ${1:name}(${2}) -> ${3:i32} {\n  ${0}\n}",
      insertTextFormat: 2,
    },
    {
      label: "type fn",
      kind: 15,
      detail: "type function snippet",
      insertText: "type fn ${1:name}(${2:T: type}) -> type {\n  ${0:T}\n}",
      insertTextFormat: 2,
    },
  ];
  return dedupeCompletions([...symbols, ...BUILTIN_COMPLETIONS, ...snippets]);
}

export function documentSymbols(result: AnalysisResult): DocumentSymbol[] {
  return result.symbols
    .filter((item) =>
      ["fn", "const", "let", "type", "import", "member", "variant"].includes(item.kind)
    )
    .filter((item) => !item.container || item.kind === "member" || item.kind === "variant")
    .map((item) => ({
      name: item.name,
      kind: symbolKind(item.kind),
      range: item.range,
      selectionRange: item.selectionRange,
      detail: item.detail,
    }));
}

export function referencesAt(result: AnalysisResult, position: Position): Location[] {
  const symbol = resolvedSymbolAt(result, position);
  if (!symbol || symbol.generated || symbol.intrinsic) return [];
  const names = new Set([symbol.name, lastSegment(symbol.name)]);
  const locations = result.references
    .filter((item) => names.has(item.targetName ?? item.name) || names.has(item.name))
    .map((item) => ({ uri: item.uri, range: item.range }));
  locations.push({ uri: symbol.uri, range: symbol.selectionRange });
  return dedupeLocations(locations);
}

export function prepareRenameAt(
  result: AnalysisResult,
  position: Position,
): { range: Range; placeholder: string } | null {
  const symbol = resolvedSymbolAt(result, position);
  if (
    !symbol || symbol.generated || symbol.intrinsic ||
    ["member", "variant", "import"].includes(symbol.kind)
  ) {
    return null;
  }
  return { range: symbol.selectionRange, placeholder: lastSegment(symbol.name) };
}

export function renameAt(
  result: AnalysisResult,
  position: Position,
  newName: string,
): WorkspaceEdit | null {
  const prepared = prepareRenameAt(result, position);
  const symbol = resolvedSymbolAt(result, position);
  if (!prepared || !symbol || !/^[A-Za-z_][\w]*$/.test(newName)) return null;
  const edits: TextEdit[] = referencesAt(result, position)
    .filter((location) => location.uri === result.document.uri)
    .map((location) => ({ range: location.range, newText: newName }));
  return { changes: { [result.document.uri]: dedupeEdits(edits) } };
}

export function signatureHelpAt(result: AnalysisResult, position: Position): unknown {
  const offset = result.mapper.offsetAt(position);
  const call = callBefore(result.document.text, offset);
  if (!call) return null;
  const symbol = result.symbols.find((item) =>
    item.name === call.name || item.name.endsWith(`.${call.name}`)
  );
  if (!symbol?.detail) return null;
  const params = parameterLabels(symbol.detail);
  return {
    signatures: [{
      label: symbol.detail,
      documentation: symbol.documentation,
      parameters: params.map((label) => ({ label })),
    }],
    activeSignature: 0,
    activeParameter: Math.min(call.argIndex, Math.max(params.length - 1, 0)),
  };
}

export const SEMANTIC_TOKEN_TYPES = [
  "function",
  "type",
  "parameter",
  "variable",
  "constant",
  "property",
  "enumMember",
  "namespace",
  "keyword",
];

export function semanticTokens(result: AnalysisResult): { data: number[] } {
  const tokens = result.symbols
    .filter((symbol) => !symbol.generated)
    .map((symbol) => ({
      line: symbol.selectionRange.start.line,
      char: symbol.selectionRange.start.character,
      length: Math.max(
        1,
        symbol.selectionRange.end.character - symbol.selectionRange.start.character,
      ),
      type: semanticTokenType(symbol.kind),
    }))
    .sort((a, b) => a.line - b.line || a.char - b.char);
  const data: number[] = [];
  let line = 0;
  let char = 0;
  for (const token of tokens) {
    data.push(
      token.line - line,
      token.line === line ? token.char - char : token.char,
      token.length,
      token.type,
      0,
    );
    line = token.line;
    char = token.char;
  }
  return { data };
}

export function workspaceSymbols(results: AnalysisResult[], query = ""): SymbolInformation[] {
  const needle = query.toLowerCase();
  return results.flatMap((result) => result.symbols)
    .filter((symbol) => !needle || symbol.name.toLowerCase().includes(needle))
    .filter((symbol) =>
      ["fn", "const", "let", "type", "import", "member", "variant"].includes(symbol.kind)
    )
    .map((symbol) => ({
      name: symbol.name,
      kind: symbolKind(symbol.kind),
      location: { uri: symbol.uri, range: symbol.selectionRange },
      containerName: symbol.container,
    }));
}

export function codeActions(result: AnalysisResult, range: Range): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const diagnostic of result.diagnostics) {
    if (!rangesOverlap(range, diagnostic.range)) continue;
    if (diagnostic.code === "module.not_found") {
      const match = diagnostic.message.match(/cannot resolve module ([\w.]+)/);
      const module = match?.[1];
      const suggestion = moduleSuggestion(module);
      if (suggestion) {
        actions.push({
          title: `Use ${suggestion}`,
          kind: "quickfix",
          diagnostics: [diagnostic],
          edit: {
            changes: {
              [result.document.uri]: [{ range: diagnostic.range, newText: suggestion }],
            },
          },
        });
      }
    }
  }
  return actions;
}

function toLspDiagnostic(diagnostic: CompileDiagnostic, mapper: PositionMapper): Diagnostic {
  const range = diagnostic.span
    ? mapper.range(diagnostic.span.start, diagnostic.span.end)
    : mapper.range(0, 0);
  return {
    range,
    severity: 1,
    code: diagnostic.code,
    source: "fig",
    message: diagnostic.message,
  };
}

function rangeFromSpan(
  span: CompileDiagnostic["span"],
  mapper: PositionMapper,
): Range | undefined {
  return span ? mapper.range(span.start, span.end) : undefined;
}

function rangeFromFound(
  found: { start: number; end: number } | undefined,
  mapper: PositionMapper,
): Range | undefined {
  return found ? mapper.range(found.start, found.end) : undefined;
}

function indexProgram(
  uri: string,
  program: Program | undefined,
  source: string,
  mapper: PositionMapper,
): IndexedSymbol[] {
  if (!program) return [];
  return program.declarations.flatMap((decl) => symbolForDecl(uri, decl, source, mapper));
}

function symbolForDecl(
  uri: string,
  decl: Declaration,
  source: string,
  mapper: PositionMapper,
): IndexedSymbol[] {
  const range = rangeFromSpan(decl.nameSpan ?? decl.span, mapper) ??
    rangeFromFound(findNameRange(source, decl.name, decl.kind), mapper) ?? mapper.range(0, 0);
  const base: IndexedSymbol = {
    name: decl.name,
    kind: decl.kind,
    uri,
    range,
    selectionRange: range,
    documentation: "doc" in decl ? decl.doc : undefined,
    detail: detailForDecl(decl),
  };
  const extra: IndexedSymbol[] = [];
  if (decl.kind === "fn") {
    for (const param of decl.params) {
      const paramRange = rangeFromSpan(param.nameSpan ?? param.span, mapper) ??
        rangeFromFound(findNameRange(source, param.name), mapper) ?? range;
      extra.push({
        name: param.name,
        kind: "param",
        uri,
        range: paramRange,
        selectionRange: paramRange,
        detail: param.type,
        documentation: param.doc,
        container: decl.name,
      });
    }
    for (const stmt of decl.body.statements) {
      extra.push(...symbolsForStatement(uri, stmt, source, mapper, decl.name));
    }
  }
  if (decl.kind === "type") {
    for (const param of decl.params) {
      const paramRange = rangeFromSpan(param.nameSpan ?? param.span, mapper) ??
        rangeFromFound(findNameRange(source, param.name), mapper) ?? range;
      extra.push({
        name: param.name,
        kind: "param",
        uri,
        range: paramRange,
        selectionRange: paramRange,
        detail: param.kind,
        documentation: param.doc,
        container: decl.name,
      });
    }
    for (const stmt of decl.body.statements) {
      const memberRange = rangeFromSpan(stmt.nameSpan ?? stmt.span, mapper) ??
        rangeFromFound(findNameRange(source, stmt.name), mapper) ?? range;
      extra.push({
        name: stmt.name,
        kind: "member",
        uri,
        range: memberRange,
        selectionRange: memberRange,
        documentation: stmt.doc,
        container: decl.name,
      });
    }
  }
  return [base, ...extra];
}

function symbolsForStatement(
  uri: string,
  stmt: Statement,
  source: string,
  mapper: PositionMapper,
  container: string,
): IndexedSymbol[] {
  const names = stmt.kind === "let" || stmt.kind === "proof_const"
    ? [stmt.name]
    : stmt.kind === "fork_let" || stmt.kind === "destructure_let"
    ? stmt.names
    : [stmt.iterator, stmt.valueIterator].filter((item): item is string => !!item);
  return names.map((name) => {
    const range = rangeFromSpan(spanForStatementName(stmt, name), mapper) ??
      rangeFromFound(findNameRange(source, name), mapper) ?? mapper.range(0, 0);
    return {
      name,
      kind: "local",
      uri,
      range,
      selectionRange: range,
      detail: detailForStatementName(stmt, name),
      container,
    };
  });
}

function detailForStatementName(stmt: Statement, name: string): string | undefined {
  if (stmt.kind === "let") return stmt.type;
  if (stmt.kind === "proof_const") return undefined;
  if (stmt.kind === "destructure_let") {
    const index = stmt.names.indexOf(name);
    return index >= 0 ? stmt.slotTypes?.[index] : undefined;
  }
  if (stmt.kind === "fork_let") return stmt.sourceType;
  return undefined;
}

function spanForStatementName(
  stmt: Statement,
  name: string,
): CompileDiagnostic["span"] | undefined {
  if (stmt.kind === "let" || stmt.kind === "proof_const") return stmt.nameSpan ?? stmt.span;
  if (stmt.kind === "fork_let" || stmt.kind === "destructure_let") {
    return stmt.nameSpans?.[name] ?? stmt.span;
  }
  return stmt.nameSpan ?? stmt.span;
}

function indexSource(uri: string, source: string, mapper: PositionMapper): IndexedSymbol[] {
  const symbols: IndexedSymbol[] = [];
  const importRegex = /\bconst\s+([a-z_][\w]*)\b[^=\n]*=\s*@import\s*\(\s*"([^"]+)"/g;
  for (const match of source.matchAll(importRegex)) {
    const start = match.index + match[0].indexOf(match[1]);
    const range = mapper.range(start, start + match[1].length);
    symbols.push({
      name: match[1],
      kind: "import",
      uri,
      range,
      selectionRange: range,
      detail: match[2],
    });
  }
  const declRegex =
    /^\s*(?:pub\s+)?(?:(fn|const|let)\s+([A-Za-z_][\w.]*)|type\s+fn\s+([A-Za-z_][\w]*))/gm;
  for (const match of source.matchAll(declRegex)) {
    const name = match[2] ?? match[3];
    const kind = (match[1] ?? "type") as IndexedSymbol["kind"];
    const start = match.index + match[0].lastIndexOf(name);
    const range = mapper.range(start, start + name.length);
    symbols.push({ name, kind, uri, range, selectionRange: range, detail: kind });
  }
  return symbols;
}

function indexImports(uri: string, source: string, mapper: PositionMapper): IndexedImport[] {
  const imports: IndexedImport[] = [];
  const sourceImportRegex = /@import\s*\(\s*"([^"]+)"\s*(?:,\s*alias\s*:\s*([A-Za-z_][\w]*))?/g;
  for (const match of source.matchAll(sourceImportRegex)) {
    const start = match.index + match[0].indexOf(match[1]);
    imports.push({
      module: match[1],
      alias: match[2],
      range: mapper.range(start, start + match[1].length),
    });
  }
  return imports;
}

function indexReferences(uri: string, source: string, mapper: PositionMapper): IndexedReference[] {
  const refs: IndexedReference[] = [];
  const tokenRegex = /@?[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/g;
  const declarationStarts = new Set<number>();
  for (
    const match of source.matchAll(
      /(?:fn|const|let)\s+([A-Za-z_][\w.]*)|type\s+fn\s+([A-Za-z_][\w]*)/g,
    )
  ) {
    const name = match[1] ?? match[2];
    declarationStarts.add(match.index + match[0].lastIndexOf(name));
  }
  for (const match of source.matchAll(tokenRegex)) {
    if (declarationStarts.has(match.index)) continue;
    if (isInsideString(source, match.index)) continue;
    const name = match[0];
    if (FIG_KEYWORDS.has(name)) continue;
    refs.push({
      name,
      uri,
      range: mapper.range(match.index, match.index + name.length),
      targetName: name,
    });
  }
  return refs;
}

function builtinSymbols(uri: string, mapper: PositionMapper): IndexedSymbol[] {
  const range = mapper.range(0, 0);
  return BUILTIN_COMPLETIONS.filter((item) => item.label.startsWith("@")).map((item) => ({
    name: item.label,
    kind: "const",
    uri,
    range,
    selectionRange: range,
    detail: item.detail,
    intrinsic: true,
  }));
}

function dedupeSymbols(symbols: IndexedSymbol[]): IndexedSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key =
      `${symbol.uri}:${symbol.kind}:${symbol.name}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detailForDecl(decl: Declaration): string {
  if (decl.kind === "fn") {
    return `fn ${decl.name}(${
      decl.params.map((param) => `${param.name}: ${param.type}`).join(", ")
    })${decl.returnType ? ` -> ${decl.returnType}` : ""}${
      decl.effects.length ? ` !{${decl.effects.join(", ")}}` : ""
    }`;
  }
  if (decl.kind === "type") {
    return `type fn ${decl.name}(${
      decl.params.map((param) => `${param.name}: ${param.kind}`).join(", ")
    }) -> ${decl.resultKind}`;
  }
  return `${decl.kind} ${decl.name}${decl.type ? `: ${decl.type}` : ""}`;
}

function symbolAt(result: AnalysisResult, position: Position): IndexedSymbol | undefined {
  const offset = result.mapper.offsetAt(position);
  return result.symbols.find((symbol) => {
    const start = result.mapper.offsetAt(symbol.selectionRange.start);
    const end = result.mapper.offsetAt(symbol.selectionRange.end);
    return offset >= start && offset <= end;
  }) ?? (() => {
    const word = wordAt(result.document.text, offset);
    return word
      ? result.symbols.find((item) => item.name === word || item.name.endsWith(`.${word}`))
      : undefined;
  })();
}

function resolvedSymbolAt(result: AnalysisResult, position: Position): IndexedSymbol | undefined {
  const direct = symbolAt(result, position);
  if (direct) return direct;
  const offset = result.mapper.offsetAt(position);
  const word = wordAt(result.document.text, offset);
  if (!word) return undefined;
  return resolveName(result, word);
}

function resolveName(result: AnalysisResult, name: string): IndexedSymbol | undefined {
  return result.symbols.find((item) => item.name === name) ??
    result.symbols.find((item) => item.name === lastSegment(name)) ??
    result.symbols.find((item) => item.name.endsWith(`.${lastSegment(name)}`));
}

function wordAt(source: string, offset: number): string | undefined {
  const left = source.slice(0, offset).match(/[A-Za-z_][\w.]*$/)?.[0] ?? "";
  const right = source.slice(offset).match(/^[\w.]*/)?.[0] ?? "";
  const word = `${left}${right}`;
  return word || undefined;
}

function qualifiedPrefix(source: string, offset: number): string | undefined {
  const before = source.slice(0, offset);
  const match = before.match(/([A-Za-z_][\w.]*)\.$/);
  return match?.[1];
}

function sourceBefore(source: string, offset: number): string {
  return source.slice(0, offset);
}

function importStringPrefix(source: string, offset: number): boolean {
  const before = source.slice(0, offset);
  return /@import\s*\(\s*"[^"]*$/.test(before);
}

function isInsideString(source: string, offset: number): boolean {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const before = source.slice(lineStart, offset);
  return (before.match(/"/g)?.length ?? 0) % 2 === 1;
}

function callBefore(
  source: string,
  offset: number,
): { name: string; argIndex: number } | undefined {
  const before = source.slice(0, offset);
  let depth = 0;
  let open = -1;
  for (let index = before.length - 1; index >= 0; index--) {
    const char = before[index];
    if (char === ")") depth++;
    else if (char === "(") {
      if (depth === 0) {
        open = index;
        break;
      }
      depth--;
    }
  }
  if (open < 0) return undefined;
  const name = before.slice(0, open).match(/([A-Za-z_][\w.]*)\s*$/)?.[1];
  if (!name) return undefined;
  const args = before.slice(open + 1);
  return { name, argIndex: args ? args.split(",").length - 1 : 0 };
}

function parameterLabels(detail: string): string[] {
  const inside = detail.match(/\((.*)\)/)?.[1] ?? "";
  if (!inside.trim()) return [];
  return inside.split(",").map((item) => item.trim());
}

function lastSegment(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function dedupeLocations(locations: Location[]): Location[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeEdits(edits: TextEdit[]): TextEdit[] {
  const seen = new Set<string>();
  return edits.filter((edit) => {
    const key = `${edit.range.start.line}:${edit.range.start.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function semanticTokenType(kind: IndexedSymbol["kind"]): number {
  return kind === "fn"
    ? 0
    : kind === "type"
    ? 1
    : kind === "param"
    ? 2
    : kind === "const"
    ? 4
    : kind === "member"
    ? 5
    : kind === "variant"
    ? 6
    : kind === "import"
    ? 7
    : 3;
}

function rangesOverlap(left: Range, right: Range): boolean {
  return comparePosition(left.start, right.end) <= 0 && comparePosition(right.start, left.end) <= 0;
}

function comparePosition(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function moduleSuggestion(module?: string): string | undefined {
  if (!module) return undefined;
  return BUILTIN_COMPLETIONS.find((item) =>
    item.detail === "module" && item.label.endsWith(lastSegment(module))
  )?.label;
}

const FIG_KEYWORDS = new Set([
  "fn",
  "pub",
  "let",
  "const",
  "type",
  "return",
  "match",
  "if",
  "else",
  "true",
  "false",
  "alias",
]);

function findNameRange(
  source: string,
  name: string,
  kind?: string,
): { start: number; end: number } | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = kind === "fn"
    ? [`\\bfn\\s+(${escaped})\\b`]
    : kind === "type"
    ? [`\\btype\\s+fn\\s+(${escaped})\\b`]
    : [`\\b(${escaped})\\b`];
  for (const pattern of patterns) {
    const match = new RegExp(pattern).exec(source);
    if (match?.index !== undefined) {
      const start = match.index + match[0].lastIndexOf(match[1]);
      return { start, end: start + match[1].length };
    }
  }
  return undefined;
}

function completionKind(kind: IndexedSymbol["kind"]): number {
  return kind === "fn"
    ? 3
    : kind === "type"
    ? 7
    : kind === "const"
    ? 21
    : kind === "import"
    ? 9
    : 6;
}

function symbolKind(kind: IndexedSymbol["kind"]): number {
  return kind === "fn"
    ? 12
    : kind === "type"
    ? 5
    : kind === "const"
    ? 14
    : kind === "import"
    ? 2
    : 13;
}

function dedupeCompletions(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.label)) return false;
    seen.add(item.label);
    return true;
  });
}
