import { TSDocParser } from "tsdoc";
import {
  checkParsedSourceForAnalysis,
  type ModuleResolveContext,
  type ModuleSource,
  parse,
} from "../mod.ts";
import { CompileError, type Diagnostic as CompileDiagnostic } from "../diagnostics.ts";
import type {
  Declaration,
  EffectImport,
  Expr,
  FnDecl,
  ParamPattern,
  Program,
  ShapeTypeSlot,
  Statement,
  TypeCountExpr,
  TypeDecl,
  TypeExpr,
  TypeMatchArm,
  TypePattern,
  TypeShapeSlot,
} from "../core_ast.ts";
import { candidateModulePaths, pathToUri, uriToPath } from "./modules.ts";
import { PositionMapper } from "./position.ts";
import { InlayHintKind } from "./protocol.ts";
import type {
  CodeAction,
  CompletionItem,
  Diagnostic,
  DocumentSymbol,
  InlayHint,
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
  kind:
    | "fn"
    | "const"
    | "let"
    | "type"
    | "param"
    | "local"
    | "import"
    | "member"
    | "variant";
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
  syntaxProgram?: Program;
}

export interface IndexedImport {
  module: string;
  alias?: string;
  destructured?: boolean;
  uri?: string;
  range: Range;
}

interface MemberCompletionContext {
  receiver: string;
  prefix: string;
  offset: number;
  separator: "." | "::";
}

const BUILTIN_COMPLETIONS: CompletionItem[] = [
  { label: "@import", kind: 3, detail: "source import" },
  { label: "@external", kind: 3, detail: "host IO import" },
  { label: "@require", kind: 3, detail: "compile-time requirement" },
  { label: "prelude.std", kind: 9, detail: "module" },
  { label: "prelude.option", kind: 9, detail: "module" },
  { label: "prelude.result", kind: 9, detail: "module" },
  { label: "prelude.array_static", kind: 9, detail: "module" },
];

const MEMBER_COMPLETION_PLACEHOLDER = "__fig_completion_placeholder";

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

  async moduleText(
    entryUri: string,
    moduleName: string,
    context?: ModuleResolveContext,
  ): Promise<ModuleSource | undefined> {
    const importerUri = context?.fromSourceId?.startsWith("file://")
      ? context.fromSourceId
      : entryUri;
    for (const path of candidateModulePaths(uriToPath(importerUri), moduleName)) {
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
    const mapperForUri = (targetUri: string) => {
      if (targetUri === document.uri) return mapper;
      const open = this.openDocuments.get(targetUri);
      return open ? new PositionMapper(open.text) : mapper;
    };
    const diagnosticsByUri: Record<string, Diagnostic[]> = { [document.uri]: [] };
    let program: Program | undefined;
    let syntaxProgram: Program | undefined;
    try {
      syntaxProgram = await parse(document.text, { sourceId: document.uri });
      const parsedForCheck = await parse(document.text, { sourceId: document.uri });
      const checked = await checkParsedSourceForAnalysis(parsedForCheck, {
        sourceId: document.uri,
        resolveModule: (moduleName, context) => this.moduleText(uri, moduleName, context),
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
        ...indexProgram(document.uri, program, document.text, mapper, mapperForUri),
        ...indexSource(document.uri, document.text, mapper),
        ...builtinSymbols(document.uri, mapper),
      ],
      references: indexReferences(document.uri, document.text, mapper),
      imports: indexImports(document.uri, document.text, mapper)
        .map((item) => ({ ...item, uri: this.resolveImportUri(uri, item.module) })),
      program,
      syntaxProgram,
    };
    result.symbols = dedupeSymbols(result.symbols);
    this.updateReverseImports(uri, result.imports);
    this.results.set(uri, result);
    return result;
  }

  async completionsAt(uri: string, position: Position): Promise<CompletionItem[]> {
    const result = this.get(uri) ?? await this.reanalyze(uri);
    if (!result) return [];
    const importCompletions = await this.destructuredImportCompletionsAt(result, position);
    if (importCompletions) return importCompletions;
    const memberCompletions = await this.memberCompletionsAt(result, position);
    return memberCompletions ?? completionsAt(result, position);
  }

  async renameAt(
    uri: string,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    const result = this.get(uri) ?? await this.reanalyze(uri);
    if (!result || !/^[A-Za-z_][\w]*$/.test(newName)) return null;
    const prepared = prepareRenameAt(result, position);
    const symbol = resolvedSymbolAt(result, position);
    if (!prepared || !symbol || !isRenameableSymbol(symbol)) return null;
    const target = await this.canonicalRenameSymbol(result, symbol);
    if (!target || !isRenameableSymbol(target)) return null;
    const candidates = await this.renameCandidateResults(result);
    const editsByUri: Record<string, TextEdit[]> = {};
    for (const candidate of candidates) {
      const edits = renameEditsForSymbol(candidate, target, newName);
      if (edits.length) editsByUri[candidate.document.uri] = dedupeEdits(edits);
    }
    return Object.keys(editsByUri).length ? { changes: editsByUri } : null;
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

  private async renameCandidateResults(root: AnalysisResult): Promise<AnalysisResult[]> {
    const seen = new Set<string>();
    const results: AnalysisResult[] = [];
    const queue = [root.document.uri];
    for (const dependent of this.reverseImports.get(root.document.uri) ?? []) queue.push(dependent);
    while (queue.length) {
      const uri = queue.shift()!;
      if (seen.has(uri)) continue;
      seen.add(uri);
      const result = await this.resultForUri(uri);
      if (!result) continue;
      results.push(result);
      for (const item of result.imports) {
        if (item.uri && !seen.has(item.uri)) queue.push(item.uri);
      }
      for (const dependent of this.reverseImports.get(uri) ?? []) {
        if (!seen.has(dependent)) queue.push(dependent);
      }
    }
    return results;
  }

  private async canonicalRenameSymbol(
    result: AnalysisResult,
    symbol: IndexedSymbol,
  ): Promise<IndexedSymbol | undefined> {
    const [prefix, ...rest] = symbol.name.split(".");
    if (!rest.length) return symbol;
    const imported = result.imports.find((item) => item.uri && importPrefix(item) === prefix);
    if (!imported?.uri) return symbol;
    const importedResult = await this.resultForUri(imported.uri);
    return importedResult?.symbols.find((item) =>
      item.kind === symbol.kind && item.name === rest.join(".")
    ) ?? symbol;
  }

  private async resultForUri(uri: string): Promise<AnalysisResult | undefined> {
    const open = this.openDocuments.get(uri);
    if (open) return await this.reanalyze(uri);
    const cached = this.results.get(uri);
    if (cached?.program) return cached;
    try {
      const text = await Deno.readTextFile(uriToPath(uri));
      const document = { uri, version: 0, text };
      const mapper = new PositionMapper(text);
      const mapperForUri = (targetUri: string) => {
        if (targetUri === uri) return mapper;
        const open = this.openDocuments.get(targetUri);
        return open ? new PositionMapper(open.text) : mapper;
      };
      let program: Program | undefined;
      let syntaxProgram: Program | undefined;
      try {
        syntaxProgram = await parse(text, { sourceId: uri });
        const parsedForCheck = await parse(text, { sourceId: uri });
        const checked = await checkParsedSourceForAnalysis(parsedForCheck, {
          sourceId: uri,
          resolveModule: (moduleName, context) => this.moduleText(uri, moduleName, context),
        });
        program = checked.program;
      } catch {
        // Keep regex-indexed recovery for malformed unopened files.
      }
      const result: AnalysisResult = {
        document,
        mapper,
        diagnostics: [],
        symbols: [
          ...indexProgram(uri, program, text, mapper, mapperForUri),
          ...indexSource(uri, text, mapper),
          ...builtinSymbols(uri, mapper),
        ],
        references: indexReferences(uri, text, mapper),
        imports: indexImports(uri, text, mapper)
          .map((item) => ({ ...item, uri: this.resolveImportUri(uri, item.module) })),
        program,
        syntaxProgram,
      };
      result.symbols = dedupeSymbols(result.symbols);
      this.results.set(uri, result);
      this.updateReverseImports(uri, result.imports);
      return result;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }

  private async memberCompletionsAt(
    result: AnalysisResult,
    position: Position,
  ): Promise<CompletionItem[] | undefined> {
    const context = memberCompletionContext(result.document.text, result.mapper.offsetAt(position));
    if (!context) return undefined;
    const checked = result.program
      ? result
      : await this.repairedMemberCompletionResult(result, context);
    if (!checked) return undefined;
    return memberCompletionItems(checked, context);
  }

  private async destructuredImportCompletionsAt(
    result: AnalysisResult,
    position: Position,
  ): Promise<CompletionItem[] | undefined> {
    const context = destructuredImportCompletionContext(
      result.document.text,
      result.mapper.offsetAt(position),
    );
    if (!context) return undefined;
    const source = await this.moduleText(result.document.uri, context.module);
    if (!source) return [];
    try {
      const program = await parse(source.text, { sourceId: source.sourceId });
      const selected = new Set(context.selectedNames);
      const items: CompletionItem[] = [];
      for (const decl of program.declarations) {
        if (decl.kind === "type_assert") continue;
        if (decl.kind === "operator") continue;
        const name = declarationCompletionName(decl);
        if (!name || selected.has(name)) continue;
        items.push({
          label: name,
          kind: completionKind(decl.kind),
          detail: detailForDecl(decl, program),
          documentation: "doc" in decl ? decl.doc : undefined,
        });
        selected.add(name);
      }
      return dedupeCompletions(items);
    } catch {
      return [];
    }
  }

  private async repairedMemberCompletionResult(
    result: AnalysisResult,
    context: MemberCompletionContext,
  ): Promise<AnalysisResult | undefined> {
    const repairedText = result.document.text.slice(0, context.offset) +
      MEMBER_COMPLETION_PLACEHOLDER +
      result.document.text.slice(context.offset);
    const repairedDocument = { ...result.document, text: repairedText };
    const mapper = new PositionMapper(repairedText);
    try {
      const program = await parse(repairedText, { sourceId: result.document.uri });
      const checked = await checkParsedSourceForAnalysis(program, {
        sourceId: result.document.uri,
        resolveModule: (moduleName, context) =>
          this.moduleText(result.document.uri, moduleName, context),
      });
      const repaired: AnalysisResult = {
        document: repairedDocument,
        mapper,
        diagnostics: [],
        symbols: [
          ...indexProgram(result.document.uri, checked.program, repairedText, mapper),
          ...indexSource(result.document.uri, repairedText, mapper),
          ...builtinSymbols(result.document.uri, mapper),
        ],
        references: indexReferences(result.document.uri, repairedText, mapper),
        imports: indexImports(result.document.uri, repairedText, mapper)
          .map((item) => ({
            ...item,
            uri: this.resolveImportUri(result.document.uri, item.module),
          })),
        program: checked.program,
      };
      repaired.symbols = dedupeSymbols(repaired.symbols);
      return repaired;
    } catch {
      return undefined;
    }
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
  const offset = result.mapper.offsetAt(position);
  const qualifiedValue = qualifiedValueHoverAt(result, position);
  if (qualifiedValue) return qualifiedValue;
  const word = wordAt(result.document.text, offset);
  if (word && !word.includes(".")) {
    const pipeBinder = nearestPipeBinderSymbol(result, word, offset);
    if (pipeBinder) return hoverForSymbol(pipeBinder);
  }
  if (word?.includes(".")) {
    const projected = projectedVarInfo(word, result);
    if (projected) {
      const range = wordRange(result, offset);
      return hoverForSymbol({
        name: projected.name,
        kind: projected.kind,
        uri: result.document.uri,
        range,
        selectionRange: range,
        detail: projected.detail,
        documentation: projected.documentation,
      });
    }
    const expression = expressionHoverAt(result, position);
    if (expression) return expression;
  }
  const direct = directSymbolAt(result, position);
  if (direct) return hoverForSymbol(direct);
  const constructor = productConstructorHoverAt(result, position);
  if (constructor) return constructor;
  const resolvedWord = word && !word.includes(".") ? resolvedSymbolAt(result, position) : undefined;
  if (resolvedWord?.kind === "local") return hoverForSymbol(resolvedWord);
  const expression = expressionHoverAt(result, position);
  if (expression) return expression;
  const call = callExpressionHoverAt(result, position);
  if (call) return call;
  const operator = operatorHoverAt(result, position);
  if (operator) return operator;
  const ast = checkedAstHoverAt(result, position);
  if (ast) return ast;
  const resolved = resolvedSymbolAt(result, position);
  return resolved ? hoverForSymbol(resolved) : undefined;
}

export function definitionAt(result: AnalysisResult, position: Position): Location[] {
  const symbol = qualifiedDefinitionSymbolAt(result, position) ??
    resolvedSymbolAt(result, position);
  return symbol ? [{ uri: symbol.uri, range: symbol.selectionRange }] : [];
}

export function completionsAt(result: AnalysisResult, position: Position): CompletionItem[] {
  const offset = result.mapper.offsetAt(position);
  const memberContext = memberCompletionContext(result.document.text, offset);
  if (memberContext) {
    const memberItems = memberCompletionItems(result, memberContext);
    if (memberItems) return memberItems;
  }
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
      insertText: "type fn ${1:name}(${2:t: type}) -> type {\n  ${0:t}\n}",
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

export function inlayHintsAt(result: AnalysisResult, range: Range): InlayHint[] {
  if (!result.program) return [];
  const hints: InlayHint[] = [];
  const letSearchStarts = new Map<string, number>();
  const visitBlock = (expr: Expr | undefined, localTypes = new Map<string, string>()) => {
    if (!expr || expr.kind !== "block") return;
    const blockTypes = new Map(localTypes);
    for (const stmt of expr.statements) {
      if (stmt.kind === "let") {
        const hint = inlayHintForLet(result, stmt, blockTypes, letSearchStarts);
        if (hint && positionInRange(hint.position, range)) hints.push(hint);
        visitExpr(stmt.value, blockTypes);
        recordStatementTypes(stmt, result.program!, blockTypes);
      } else if (stmt.kind === "destructure_let") {
        visitExpr(stmt.value, blockTypes);
        recordStatementTypes(stmt, result.program!, blockTypes);
      }
    }
    visitExpr(expr.expr, blockTypes);
  };
  const visitExpr = (expr: Expr | undefined, localTypes = new Map<string, string>()) => {
    if (!expr) return;
    if (expr.kind === "block") {
      visitBlock(expr, localTypes);
      return;
    }
    if (expr.kind === "const_fn") return;
    for (const child of childExprs(expr)) visitExpr(child, localTypes);
  };
  for (const decl of result.program.declarations) {
    if (decl.kind === "fn" && (decl.imported || decl.generated)) continue;
    if (decl.kind === "fn") {
      visitBlock(decl.body, new Map(decl.params.map((param) => [param.name, param.type])));
    }
  }
  return hints;
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
  if (!prepared || !symbol || !isRenameableSymbol(symbol) || !/^[A-Za-z_][\w]*$/.test(newName)) {
    return null;
  }
  const edits = renameEditsForSymbol(result, symbol, newName);
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
      ["fn", "const", "let", "type", "import", "member", "variant"].includes(
        symbol.kind,
      )
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
    if (diagnostic.code === "fn.too_many_runtime_params") {
      const action = groupTrailingParametersAction(result, diagnostic);
      if (action) actions.push(action);
    }
  }
  actions.push(...inferredTypeHoleCodeActions(result, range));
  actions.push(...refactorCodeActions(result, range));
  return dedupeCodeActions(actions);
}

function groupTrailingParametersAction(
  result: AnalysisResult,
  diagnostic: Diagnostic,
): CodeAction | undefined {
  const program = result.syntaxProgram ?? result.program;
  if (!program) return undefined;
  const diagnosticStart = result.mapper.offsetAt(diagnostic.range.start);
  const fn = program.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && !!decl.span && decl.span.start <= diagnosticStart &&
    diagnosticStart <= decl.span.end
  );
  if (!fn || !fn.span) return undefined;
  const runtime = fn.params.filter((param) => !param.const);
  if (runtime.length <= 5) return undefined;
  const keep = runtime.slice(0, 4);
  const grouped = runtime.slice(4);
  if (!grouped.every((param) => param.span && isSimpleGroupedParam(param))) return undefined;
  const first = grouped[0]!;
  const last = grouped[grouped.length - 1]!;
  if (!first.span || !last.span) return undefined;
  const restName = freshGroupedParamName(fn);
  const groupedType = `struct({${
    grouped.map((param) => `${param.name}: ${param.type}`).join(", ")
  }})`;
  const edits: TextEdit[] = [{
    range: result.mapper.range(first.span.start, last.span.end),
    newText: `${restName}: ${groupedType}`,
  }];
  edits.push(...groupedParamBodyEdits(result, fn, grouped, restName));
  edits.push(...groupedParamCallEdits(result, fn, keep.length, grouped));
  return {
    title: "Group trailing parameters into a struct",
    kind: "quickfix",
    diagnostics: [diagnostic],
    edit: { changes: { [result.document.uri]: dedupeEdits(edits) } },
  };
}

function freshGroupedParamName(fn: FnDecl): string {
  const used = new Set(fn.params.map((param) => param.name));
  if (!used.has("rest")) return "rest";
  for (let index = 1; index < 1000; index++) {
    const candidate = `rest${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return "__rest";
}

function isSimpleGroupedParam(param: FnDecl["params"][number]): boolean {
  return !param.pattern || param.pattern.kind === "binding";
}

function groupedParamBodyEdits(
  result: AnalysisResult,
  fn: FnDecl,
  grouped: FnDecl["params"],
  restName: string,
): TextEdit[] {
  const bodySpan = fn.body.span;
  if (!bodySpan) return [];
  const source = result.document.text;
  const edits: TextEdit[] = [];
  const names = new Set(grouped.map((param) => param.name));
  const pattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  pattern.lastIndex = bodySpan.start;
  for (
    let match = pattern.exec(source);
    match && match.index < bodySpan.end;
    match = pattern.exec(source)
  ) {
    const name = match[0];
    if (!names.has(name)) continue;
    edits.push({
      range: result.mapper.range(match.index, match.index + name.length),
      newText: `${restName}.${name}`,
    });
  }
  return edits;
}

function groupedParamCallEdits(
  result: AnalysisResult,
  fn: FnDecl,
  keepCount: number,
  grouped: FnDecl["params"],
): TextEdit[] {
  const program = result.syntaxProgram ?? result.program;
  if (!program) return [];
  const edits: TextEdit[] = [];
  const visit = (expr: Expr | undefined) => {
    if (!expr) return;
    if (
      expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === fn.name &&
      expr.args.length >= keepCount + grouped.length
    ) {
      const first = expr.args[keepCount];
      const last = expr.args[keepCount + grouped.length - 1];
      if (first?.span && last?.span) {
        const fields = grouped.map((param, index) => {
          const arg = expr.args[keepCount + index]!;
          return `${param.name}: ${sourceForSpan(result, arg.span!)}`;
        }).join(", ");
        edits.push({
          range: result.mapper.range(first.span.start, last.span.end),
          newText: `{${fields}}`,
        });
      }
    }
    for (const child of childExprs(expr)) visit(child);
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") visit(decl.body);
    else if (decl.kind === "let" || decl.kind === "const") visit(decl.value);
  }
  return edits;
}

function inferredTypeHoleCodeActions(result: AnalysisResult, range: Range): CodeAction[] {
  const holes = (result.program?.resolvedTypeHoles ?? [])
    .filter((hole) => !hole.span.sourceId || hole.span.sourceId === result.document.uri)
    .map((hole) => ({
      range: result.mapper.range(hole.span.start, hole.span.end),
      newText: hole.replacement,
    }))
    .filter((edit) => rangesOverlap(range, edit.range));
  if (!holes.length) return [];
  return [{
    title: "Replace inferred type holes",
    kind: "refactor.rewrite",
    edit: {
      changes: {
        [result.document.uri]: dedupeEdits(holes),
      },
    },
  }];
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

function refactorCodeActions(result: AnalysisResult, range: Range): CodeAction[] {
  if (!result.program) return [];
  const actions: CodeAction[] = [];
  for (const expr of exprsOverlappingRange(result, range)) {
    const pipeline = nestedCallPipelineEdit(result, expr);
    if (pipeline) actions.push(pipeline);
    const match = nestedMatchFlattenEdit(result, expr);
    if (match) actions.push(match);
  }
  return actions;
}

function exprsOverlappingRange(result: AnalysisResult, range: Range): Expr[] {
  const program = result.syntaxProgram ?? result.program;
  if (!program) return [];
  const found: Expr[] = [];
  const visitStatement = (stmt: Statement) => {
    if (stmt.kind === "let" || stmt.kind === "destructure_let") visitExpr(stmt.value);
  };
  const visitExpr = (expr: Expr | undefined) => {
    const span = expr ? fullExprSpan(result, expr) : undefined;
    if (!expr || !span) return;
    const exprRange = rangeFromSpan(span, result.mapper);
    if (!exprRange || !rangesOverlap(range, exprRange)) return;
    found.push(expr);
    if (expr.kind === "block") {
      for (const stmt of expr.statements) visitStatement(stmt);
      visitExpr(expr.expr);
      return;
    }
    for (const child of childExprs(expr)) visitExpr(child);
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") visitExpr(decl.body);
    else if (decl.kind === "let" || decl.kind === "const") visitExpr(decl.value);
  }
  return found.sort((a, b) => spanLength(b.span) - spanLength(a.span));
}

function nestedCallPipelineEdit(result: AnalysisResult, expr: Expr): CodeAction | undefined {
  const span = fullExprSpan(result, expr);
  if (expr.kind !== "call" || !span) return undefined;
  const pipeline = callPipelineParts(result, expr);
  if (!pipeline || pipeline.steps.length === 0) return undefined;
  const binder = freshPipelineBinder(result, span);
  const steps = pipeline.steps.map((step) => `${step.prefix}${binder}${step.suffix}`);
  const newText = [pipeline.base, ...steps].join(` \\${binder} -> `);
  if (newText === sourceForSpan(result, span)) return undefined;
  return {
    title: "Convert nested call to pipe-bind pipeline",
    kind: "refactor.rewrite",
    edit: {
      changes: {
        [result.document.uri]: [{
          range: result.mapper.range(span.start, span.end),
          newText,
        }],
      },
    },
  };
}

function callPipelineParts(
  result: AnalysisResult,
  expr: Extract<Expr, { kind: "call" }>,
): { base: string; steps: { prefix: string; suffix: string }[] } | undefined {
  const nested = expr.args.find((arg) => arg.kind === "call") as
    | Extract<Expr, { kind: "call" }>
    | undefined;
  const exprSpan = fullExprSpan(result, expr);
  const nestedSpan = nested ? fullExprSpan(result, nested) : undefined;
  if (!nested || !nestedSpan || !exprSpan) return undefined;
  const prefix = result.document.text.slice(exprSpan.start, nestedSpan.start);
  const suffix = result.document.text.slice(nestedSpan.end, exprSpan.end);
  const step = { prefix, suffix };
  const prior = callPipelineParts(result, nested);
  return prior
    ? { base: prior.base, steps: [...prior.steps, step] }
    : { base: sourceForSpan(result, nestedSpan), steps: [step] };
}

function freshPipelineBinder(result: AnalysisResult, span: NonNullable<Expr["span"]>): string {
  const used = new Set<string>();
  for (const match of sourceForSpan(result, span).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    used.add(match[0]);
  }
  const owner = result.symbols.find((symbol) =>
    symbol.kind === "fn" && rangeContainsSpan(result, symbol.range, span)
  );
  const container = owner?.name;
  for (const symbol of result.symbols) {
    if (
      (symbol.kind === "local" || symbol.kind === "param") &&
      (!container || symbol.container === container)
    ) {
      used.add(symbol.name);
    }
  }
  if (!used.has("value")) return "value";
  for (let index = 1; index < 1000; index++) {
    const candidate = `value${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return "__pipeline_value";
}

function nestedMatchFlattenEdit(result: AnalysisResult, expr: Expr): CodeAction | undefined {
  if (expr.kind !== "match" || !expr.span || expr.arms.length === 0) return undefined;
  if (expr.arms.some((arm) => arm.guard)) return undefined;
  const innerMatches = expr.arms.map((arm) => arm.value);
  if (
    !innerMatches.every((item): item is Extract<Expr, { kind: "match" }> => item.kind === "match")
  ) {
    return undefined;
  }
  const firstInner = innerMatches[0];
  if (innerMatches.some((item) => item.arms.some((arm) => arm.guard))) return undefined;
  if (!firstInner.value.span || !expr.value.span) return undefined;
  const innerValue = sourceForSpan(result, firstInner.value.span);
  if (
    !innerMatches.every((item) =>
      item.value.span && sourceForSpan(result, item.value.span) === innerValue
    )
  ) {
    return undefined;
  }
  if (expr.arms.some((arm) => patternBindingNamesForHover(arm.pattern).length > 0)) {
    return undefined;
  }
  const outerValue = sourceForSpan(result, expr.value.span);
  const arms: string[] = [];
  for (const outerArm of expr.arms) {
    if (!outerArm.pattern.span) return undefined;
    const outerPattern = sourceForSpan(result, outerArm.pattern.span);
    const inner = outerArm.value as Extract<Expr, { kind: "match" }>;
    for (const innerArm of inner.arms) {
      if (!innerArm.pattern.span || !innerArm.value.span) return undefined;
      arms.push(
        `[${outerPattern}, ${sourceForSpan(result, innerArm.pattern.span)}] => ${
          sourceForSpan(result, innerArm.value.span)
        }`,
      );
    }
  }
  const newText = `match [${outerValue}, ${innerValue}] { ${arms.join(", ")} }`;
  return {
    title: "Combine nested matches into tuple match",
    kind: "refactor.rewrite",
    edit: {
      changes: {
        [result.document.uri]: [{
          range: result.mapper.range(expr.span.start, expr.span.end),
          newText,
        }],
      },
    },
  };
}

function sourceForSpan(
  result: AnalysisResult,
  span: NonNullable<CompileDiagnostic["span"]>,
): string {
  return result.document.text.slice(span.start, span.end);
}

function fullExprSpan(result: AnalysisResult, expr: Expr): CompileDiagnostic["span"] {
  if (expr.kind === "call") {
    const joined = joinDiagnosticSpans(fullExprSpan(result, expr.callee), expr.span);
    if (!joined) return joined;
    let end = joined.end;
    while (/\s/.test(result.document.text[end] ?? "")) end++;
    if (result.document.text[end] === ")") end++;
    return { ...joined, end };
  }
  return expr.span;
}

function joinDiagnosticSpans(
  left: CompileDiagnostic["span"],
  right: CompileDiagnostic["span"],
): CompileDiagnostic["span"] {
  if (!left) return right;
  if (!right) return left;
  return {
    ...left,
    start: Math.min(left.start, right.start),
    end: Math.max(left.end, right.end),
  };
}

function patternBindingNamesForHover(pattern: ParamPattern): string[] {
  switch (pattern.kind) {
    case "binding":
      return [pattern.name];
    case "tuple":
      return pattern.items.flatMap(patternBindingNamesForHover);
    case "constructor":
      return pattern.args.flatMap(patternBindingNamesForHover);
    case "typed":
      return patternBindingNamesForHover(pattern.pattern);
    case "wildcard":
    case "literal":
    case "enum_member":
    case "type":
      return [];
  }
}

function dedupeCodeActions(actions: CodeAction[]): CodeAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const edits = action.edit?.changes
      ? Object.entries(action.edit.changes).flatMap(([uri, items]) =>
        items.map((item) =>
          `${uri}:${item.range.start.line}:${item.range.start.character}:${item.range.end.line}:${item.range.end.character}:${item.newText}`
        )
      ).join("|")
      : "";
    const key = `${action.kind ?? ""}:${action.title}:${edits}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rangeFromSpan(
  span: CompileDiagnostic["span"],
  mapper: PositionMapper,
): Range | undefined {
  return span ? mapper.range(span.start, span.end) : undefined;
}

function sourceIdForSpan(span: CompileDiagnostic["span"]): string | undefined {
  return span?.sourceId;
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
  mapperForUri: (uri: string) => PositionMapper = () => mapper,
): IndexedSymbol[] {
  if (!program) return [];
  const symbols = [
    ...program.imports.map((item) => symbolForEffectImport(uri, item, source, mapper)),
    ...(program.sourceImports ?? []).flatMap((item) => symbolForSourceImport(uri, item, mapper)),
  ];
  const topLevelTypes = new Map<string, string>();
  for (const decl of program.declarations) {
    symbols.push(...symbolForDecl(uri, decl, program, source, mapper, topLevelTypes, mapperForUri));
    recordDeclarationType(decl, program, topLevelTypes);
  }
  return symbols;
}

function symbolForSourceImport(
  uri: string,
  item: NonNullable<Program["sourceImports"]>[number],
  mapper: PositionMapper,
): IndexedSymbol[] {
  const detail = item.module;
  if (item.bindings?.length) {
    return item.bindings.map((binding) => {
      const range = rangeFromSpan(binding.nameSpan ?? binding.span, mapper) ?? mapper.range(0, 0);
      return {
        name: binding.name,
        kind: "import" as const,
        uri,
        range,
        selectionRange: range,
        detail,
      };
    });
  }
  const range = rangeFromSpan(item.nameSpan ?? item.span, mapper) ?? mapper.range(0, 0);
  return [{
    name: item.alias ?? item.module,
    kind: "import",
    uri,
    range,
    selectionRange: range,
    detail,
  }];
}

function symbolForEffectImport(
  uri: string,
  item: EffectImport,
  source: string,
  mapper: PositionMapper,
): IndexedSymbol {
  const range = rangeFromSpan(item.nameSpan ?? item.span, mapper) ??
    rangeFromFound(findNameRange(source, item.name, "const"), mapper) ?? mapper.range(0, 0);
  return {
    name: item.name,
    kind: "const",
    uri,
    range,
    selectionRange: range,
    detail: detailForEffectImport(item),
  };
}

function symbolForDecl(
  uri: string,
  decl: Declaration,
  program: Program,
  source: string,
  mapper: PositionMapper,
  topLevelTypes: Map<string, string>,
  mapperForUri: (uri: string) => PositionMapper,
): IndexedSymbol[] {
  if (decl.kind === "type_assert") return [];
  const symbolUri = sourceIdForSpan(decl.nameSpan ?? decl.span) ?? uri;
  const symbolMapper = mapperForUri(symbolUri);
  const symbolSource = symbolUri === uri ? source : undefined;
  const range = rangeFromSpan(decl.nameSpan ?? decl.span, symbolMapper) ??
    (symbolSource
      ? rangeFromFound(findNameRange(symbolSource, decl.name, decl.kind), symbolMapper)
      : undefined) ??
    symbolMapper.range(0, 0);
  const symbolKind: IndexedSymbol["kind"] = decl.kind === "operator"
    ? "const"
    : decl.kind;
  const base: IndexedSymbol = {
    name: decl.name,
    kind: symbolKind,
    uri: symbolUri,
    range,
    selectionRange: range,
    documentation: "doc" in decl ? decl.doc : undefined,
    detail: detailForDecl(decl, program, topLevelTypes),
  };
  const extra: IndexedSymbol[] = [];
  if (decl.kind === "fn") {
    const localTypes = new Map(topLevelTypes);
    for (const param of decl.params) localTypes.set(param.name, param.type);
    for (const param of decl.params) {
      const paramRange = rangeFromSpan(param.nameSpan ?? param.span, symbolMapper) ??
        (symbolSource
          ? rangeFromFound(findNameRange(symbolSource, param.name), symbolMapper)
          : undefined) ??
        range;
      extra.push({
        name: param.name,
        kind: "param",
        uri: symbolUri,
        range: paramRange,
        selectionRange: paramRange,
        detail: param.type,
        documentation: param.doc,
        container: decl.name,
      });
    }
    for (const stmt of decl.body.statements) {
      extra.push(
        ...symbolsForStatement(
          symbolUri,
          stmt,
          symbolSource ?? source,
          symbolMapper,
          decl.name,
          program,
          localTypes,
        ),
      );
      extra.push(
        ...symbolsForExpr(
          symbolUri,
          statementValue(stmt),
          symbolSource ?? source,
          symbolMapper,
          decl.name,
          program,
          localTypes,
        ),
      );
      recordStatementTypes(stmt, program, localTypes);
    }
    extra.push(
      ...symbolsForExpr(
        symbolUri,
        decl.body.expr,
        symbolSource ?? source,
        symbolMapper,
        decl.name,
        program,
        localTypes,
      ),
    );
  }
  if (decl.kind === "type") {
    for (const param of decl.params) {
      const paramRange = rangeFromSpan(param.nameSpan ?? param.span, symbolMapper) ??
        (symbolSource
          ? rangeFromFound(findNameRange(symbolSource, param.name), symbolMapper)
          : undefined) ??
        range;
      extra.push({
        name: param.name,
        kind: "param",
        uri: symbolUri,
        range: paramRange,
        selectionRange: paramRange,
        detail: param.kind,
        documentation: param.doc,
        container: decl.name,
      });
    }
    for (const stmt of decl.body.statements) {
      const memberRange = rangeFromSpan(stmt.nameSpan ?? stmt.span, symbolMapper) ??
        (symbolSource
          ? rangeFromFound(findNameRange(symbolSource, stmt.name), symbolMapper)
          : undefined) ??
        range;
      extra.push({
        name: stmt.name,
        kind: "member",
        uri: symbolUri,
        range: memberRange,
        selectionRange: memberRange,
        documentation: stmt.doc,
        container: decl.name,
      });
    }
  }
  return [base, ...extra];
}

function symbolsForExpr(
  uri: string,
  expr: Expr | undefined,
  source: string,
  mapper: PositionMapper,
  container: string,
  program?: Program,
  localTypes?: Map<string, string>,
): IndexedSymbol[] {
  if (!expr) return [];
  switch (expr.kind) {
    case "do":
      return [
        ...expr.statements.flatMap((stmt) =>
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
            ? symbolsForExpr(uri, stmt.value, source, mapper, container, program, localTypes)
            : []
        ),
        ...symbolsForExpr(uri, expr.expr, source, mapper, container, program, localTypes),
      ];
    case "const_fn":
      return symbolsForExpr(uri, expr.body, source, mapper, container, program, localTypes);
    case "profile":
      return [
        ...expr.args.flatMap((arg) =>
          symbolsForExpr(uri, arg, source, mapper, container, program, localTypes)
        ),
        ...symbolsForExpr(uri, expr.body, source, mapper, container, program, localTypes),
      ];
    case "block": {
      const blockTypes = new Map(localTypes);
      const symbols: IndexedSymbol[] = [];
      for (const stmt of expr.statements) {
        symbols.push(
          ...symbolsForStatement(uri, stmt, source, mapper, container, program, blockTypes),
        );
        symbols.push(
          ...symbolsForExpr(
            uri,
            statementValue(stmt),
            source,
            mapper,
            container,
            program,
            blockTypes,
          ),
        );
        if (program) recordStatementTypes(stmt, program, blockTypes);
      }
      symbols.push(
        ...symbolsForExpr(uri, expr.expr, source, mapper, container, program, blockTypes),
      );
      return symbols;
    }
    case "pipe_bind": {
      const valueType = program && localTypes
        ? expressionTypeFromProgram(expr.value, program, localTypes)
        : undefined;
      const binderSpan = pipeBindNameSpanFromSource(source, expr);
      const binderRange = rangeFromSpan(binderSpan, mapper) ??
        rangeFromFound(findNameRange(source, expr.name), mapper) ?? mapper.range(0, 0);
      const scopedTypes = new Map(localTypes);
      if (valueType) scopedTypes.set(expr.name, valueType);
      return [
        ...symbolsForExpr(uri, expr.value, source, mapper, container, program, localTypes),
        {
          name: expr.name,
          kind: "local",
          uri,
          range: binderRange,
          selectionRange: binderRange,
          detail: valueType,
          documentation: expr.doc,
          container,
        },
        ...symbolsForExpr(uri, expr.body, source, mapper, container, program, scopedTypes),
      ];
    }
    case "match":
      return [
        ...symbolsForExpr(uri, expr.value, source, mapper, container, program, localTypes),
        ...expr.arms.flatMap((arm) =>
          symbolsForExpr(uri, arm.value, source, mapper, container, program, localTypes)
        ),
      ];
    case "call":
      if (expr.tailRec) {
        return expr.args.flatMap((arg) =>
          symbolsForExpr(uri, arg, source, mapper, container, program, localTypes)
        );
      }
      return [
        ...symbolsForExpr(uri, expr.callee, source, mapper, container, program, localTypes),
        ...expr.args.flatMap((arg) =>
          symbolsForExpr(uri, arg, source, mapper, container, program, localTypes)
        ),
      ];
    case "index":
      return [
        ...symbolsForExpr(uri, expr.target, source, mapper, container, program, localTypes),
        ...symbolsForExpr(uri, expr.index, source, mapper, container, program, localTypes),
      ];
    case "binary":
      return [
        ...symbolsForExpr(uri, expr.left, source, mapper, container, program, localTypes),
        ...symbolsForExpr(uri, expr.right, source, mapper, container, program, localTypes),
      ];
    case "operator_chain":
      return [
        ...symbolsForExpr(uri, expr.first, source, mapper, container, program, localTypes),
        ...expr.rest.flatMap((item) =>
          symbolsForExpr(uri, item.value, source, mapper, container, program, localTypes)
        ),
      ];
    case "shape":
    case "product_constructor":
      return expr.slots.flatMap((slot) =>
        symbolsForExpr(uri, slot.value, source, mapper, container, program, localTypes)
      );
    case "static_for_slots":
      return symbolsForExpr(uri, expr.value, source, mapper, container, program, localTypes);
    case "field":
      return [
        ...symbolsForExpr(uri, expr.value, source, mapper, container, program, localTypes),
        ...symbolsForExpr(uri, expr.key, source, mapper, container, program, localTypes),
      ];
    case "range":
      return [
        ...symbolsForExpr(uri, expr.start, source, mapper, container, program, localTypes),
        ...symbolsForExpr(uri, expr.end, source, mapper, container, program, localTypes),
      ];
    case "literal":
    case "var":
      return [];
  }
}

function statementValue(stmt: Statement): Expr | undefined {
  return stmt.kind === "let" || stmt.kind === "destructure_let" ? stmt.value : undefined;
}

function inlayHintForLet(
  result: AnalysisResult,
  stmt: Statement,
  localTypes: Map<string, string>,
  searchStarts: Map<string, number>,
): InlayHint | undefined {
  if (stmt.kind !== "let") {
    return undefined;
  }
  const nameSpan = findInlayLetNameRange(result, stmt, searchStarts);
  const range = rangeFromFound(nameSpan, result.mapper);
  if (!range) return undefined;
  if (hasExplicitLetAnnotation(result, stmt, nameSpan)) return undefined;
  if (!rangeLooksLikeLetBinding(result.document.text, result.mapper, range, stmt.name)) {
    return undefined;
  }
  const type = stmt.type ?? expressionTypeFromProgram(stmt.value, result.program, localTypes);
  if (!type) return undefined;
  return {
    position: range.end,
    label: `: ${displayType(type)}`,
    kind: InlayHintKind.Type,
  };
}

function rangeLooksLikeLetBinding(
  source: string,
  mapper: PositionMapper,
  range: Range,
  name: string,
): boolean {
  const start = mapper.offsetAt(range.start);
  const lineStart = source.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const prefix = source.slice(lineStart, start);
  return new RegExp(`\\blet\\s+$`).test(prefix) &&
    source.slice(start, start + name.length) === name;
}

function hasExplicitLetAnnotation(
  result: AnalysisResult,
  stmt: Extract<Statement, { kind: "let" }>,
  nameRange?: { start: number; end: number },
) {
  const found = nameRange ?? findStatementNameRange(result.document.text, stmt);
  const start = stmt.nameSpan?.end ?? found?.end ?? stmt.span?.start;
  if (start === undefined) return false;
  const nextEquals = result.document.text.indexOf("=", start);
  const nextSemicolon = result.document.text.indexOf(";", start);
  const end = stmt.value.span?.start ??
    (nextEquals >= 0 && (nextSemicolon < 0 || nextEquals < nextSemicolon)
      ? nextEquals
      : stmt.span?.end);
  if (end === undefined || end < start) return false;
  const between = result.document.text.slice(start, end);
  const equals = between.indexOf("=");
  return (equals >= 0 ? between.slice(0, equals) : between).includes(":");
}

function findInlayLetNameRange(
  result: AnalysisResult,
  stmt: Extract<Statement, { kind: "let" }>,
  searchStarts: Map<string, number>,
): { start: number; end: number } | undefined {
  const exact = spanForStatementName(stmt, stmt.name);
  if (exact) {
    searchStarts.set(stmt.name, exact.end);
    return { start: exact.start, end: exact.end };
  }
  const found = findNextLetNameRange(
    result.document.text,
    stmt.name,
    searchStarts.get(stmt.name) ?? 0,
  );
  if (found) searchStarts.set(stmt.name, found.end);
  return found;
}

function findNextLetNameRange(
  source: string,
  name: string,
  from: number,
): { start: number; end: number } | undefined {
  const pattern = new RegExp(`\\blet\\s+(${escapeRegExp(name)})(?![A-Za-z0-9_])`, "g");
  pattern.lastIndex = from;
  const match = pattern.exec(source);
  if (!match || match.index === undefined) return undefined;
  const start = match.index + match[0].length - name.length;
  return { start, end: start + name.length };
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findStatementNameRange(
  source: string,
  stmt: Extract<Statement, { kind: "let" }>,
): { start: number; end: number } | undefined {
  if (stmt.nameSpan) return stmt.nameSpan;
  if (stmt.span) {
    const found = findNameRange(source.slice(stmt.span.start, stmt.span.end), stmt.name);
    return found
      ? { start: stmt.span.start + found.start, end: stmt.span.start + found.end }
      : undefined;
  }
  return findNameRange(source, stmt.name);
}

function symbolsForStatement(
  uri: string,
  stmt: Statement,
  source: string,
  mapper: PositionMapper,
  container: string,
  program?: Program,
  localTypes?: Map<string, string>,
): IndexedSymbol[] {
  const names = stmt.kind === "let"
    ? [stmt.name]
    : stmt.kind === "destructure_let"
    ? stmt.names
    : [];
  return names.map((name) => {
    const range = rangeFromSpan(spanForStatementName(stmt, name), mapper) ??
      rangeFromFound(findNameRange(source, name), mapper) ?? mapper.range(0, 0);
    return {
      name,
      kind: "local",
      uri,
      range,
      selectionRange: range,
      detail: detailForStatementName(stmt, name, program, localTypes),
      container,
    };
  });
}

function detailForStatementName(
  stmt: Statement,
  name: string,
  program?: Program,
  localTypes = new Map<string, string>(),
): string | undefined {
  if (stmt.kind === "let") {
    return stmt.type ?? expressionTypeFromProgram(stmt.value, program, localTypes);
  }
  if (stmt.kind === "type_assert") return undefined;
  if (stmt.kind === "destructure_let") {
    const index = stmt.names.indexOf(name);
    return index >= 0 ? stmt.slotTypes?.[index] : undefined;
  }
  return undefined;
}

function recordStatementTypes(
  stmt: Statement,
  program: Program,
  localTypes: Map<string, string>,
) {
  if (stmt.kind === "let") {
    const type = stmt.type ?? expressionTypeFromProgram(stmt.value, program, localTypes);
    if (type) localTypes.set(stmt.name, type);
    return;
  }
  if (stmt.kind === "destructure_let") {
    stmt.names.forEach((name, index) => {
      const type = stmt.slotTypes?.[index];
      if (type) localTypes.set(name, type);
    });
    return;
  }
}

function recordDeclarationType(
  decl: Declaration,
  program: Program,
  localTypes: Map<string, string>,
) {
  if (decl.kind !== "let" && decl.kind !== "const") return;
  const type = decl.type ?? expressionTypeFromProgram(decl.value, program, localTypes);
  if (type) localTypes.set(decl.name, type);
}

function expressionTypeFromProgram(
  expr: Expr,
  program: Program | undefined,
  localTypes: Map<string, string>,
): string | undefined {
  if (expr.kind === "var") {
    const local = localTypes.get(expr.name);
    if (local) return local;
    const decl = program?.declarations.find((item) =>
      item.kind !== "type_assert" && item.name === expr.name
    );
    if (decl?.kind === "fn" || decl?.kind === "type") {
      return detailForDecl(decl, program, localTypes);
    }
    return undefined;
  }
  if (expr.kind === "call" && expr.callee.kind === "var") {
    const name = expr.callee.name;
    const fn = program?.declarations.find((decl): decl is FnDecl =>
      decl.kind === "fn" && (decl.name === name || decl.name.endsWith(`.${name}`))
    );
    if (fn?.returnType) return fn.returnType;
    const effectImport = program?.imports.find((item) => item.name === name);
    return effectImport ? functionReturnType(effectImport.type) : undefined;
  }
  if (expr.kind === "literal") {
    if (expr.inferredType) return expr.inferredType;
    if (expr.literalKind === "number") return "i32";
    if (expr.literalKind === "bool") return "bool";
    if (expr.literalKind === "string" || expr.literalKind === "multiline") return "string";
    if (expr.literalKind === "char") return "char";
  }
  if (expr.kind === "range") return "range_i32";
  if (expr.kind === "shape") {
    if (expr.inferredType) return expr.inferredType;
    return shapeExpressionType(
      expr,
      (value) => expressionTypeFromProgram(value, program, localTypes),
    );
  }
  if (expr.kind === "pipe_bind") return expressionTypeFromProgram(expr.body, program, localTypes);
  if (expr.kind === "match") {
    const armTypes = expr.arms.map((arm) =>
      expressionTypeFromProgram(arm.value, program, localTypes)
    );
    const first = armTypes[0];
    return first && armTypes.every((type) => type === first) ? first : undefined;
  }
  if (expr.kind === "product_constructor") {
    const type = program?.declarations.find((decl): decl is TypeDecl =>
      decl.kind === "type" &&
      decl.normalized?.kind === "product" &&
      decl.normalized.constructor === expr.constructor
    );
    return type?.name;
  }
  return undefined;
}

function spanForStatementName(
  stmt: Statement,
  name: string,
): CompileDiagnostic["span"] | undefined {
  if (stmt.kind === "let") return stmt.nameSpan ?? stmt.span;
  if (stmt.kind === "destructure_let") {
    return stmt.nameSpans?.[name] ?? stmt.span;
  }
  return undefined;
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
  const destructuredImportRegex = /\bconst\s*\{\s*([^}]*)\}\s*=\s*@import\s*\(\s*"([^"]+)"/g;
  for (const match of source.matchAll(destructuredImportRegex)) {
    const listStart = match.index + match[0].indexOf(match[1]);
    const bindingRegex = /\b[A-Za-z_][\w]*\b/g;
    for (const binding of match[1].matchAll(bindingRegex)) {
      const start = listStart + (binding.index ?? 0);
      const name = binding[0];
      const range = mapper.range(start, start + name.length);
      symbols.push({
        name,
        kind: "import",
        uri,
        range,
        selectionRange: range,
        detail: match[2],
      });
    }
  }
  const declRegex =
    /^\s*(?:pub\s+)?(?:(fn|const|let)(?!\s*\{)\s+([A-Za-z_][\w.]*)|type\s+fn\s+([A-Za-z_][\w]*))/gm;
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
  const matchedImportOffsets = new Set<number>();
  const namespaceImportRegex = /\bconst\s+([a-z_][\w]*)\b[^=\n]*=\s*@import\s*\(\s*"([^"]+)"/g;
  for (const match of source.matchAll(namespaceImportRegex)) {
    const importOffset = match.index + match[0].indexOf("@import");
    matchedImportOffsets.add(importOffset);
    const start = match.index + match[0].indexOf(match[2]);
    imports.push({
      module: match[2],
      alias: match[1],
      range: mapper.range(start, start + match[2].length),
    });
  }
  const destructuredImportRegex = /\bconst\s*\{\s*[^}]*\}\s*=\s*@import\s*\(\s*"([^"]+)"/g;
  for (const match of source.matchAll(destructuredImportRegex)) {
    const importOffset = match.index + match[0].indexOf("@import");
    matchedImportOffsets.add(importOffset);
    const start = match.index + match[0].indexOf(match[1]);
    imports.push({
      module: match[1],
      destructured: true,
      range: mapper.range(start, start + match[1].length),
    });
  }
  const sourceImportRegex = /@import\s*\(\s*"([^"]+)"\s*(?:,\s*alias\s*:\s*([A-Za-z_][\w]*))?/g;
  for (const match of source.matchAll(sourceImportRegex)) {
    if (matchedImportOffsets.has(match.index)) continue;
    const start = match.index + match[0].indexOf(match[1]);
    imports.push({
      module: match[1],
      alias: match[2],
      range: mapper.range(start, start + match[1].length),
    });
  }
  return imports;
}

interface DestructuredImportCompletionContext {
  module: string;
  selectedNames: string[];
}

function destructuredImportCompletionContext(
  source: string,
  offset: number,
): DestructuredImportCompletionContext | undefined {
  const importStartRegex = /\bconst\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = importStartRegex.exec(source))) {
    const open = source.indexOf("{", match.index);
    if (open < 0 || open > offset) continue;
    const close = source.indexOf("}", open + 1);
    if (close < 0 || offset > close) continue;
    const after = source.slice(close + 1);
    const importMatch = after.match(/^\s*=\s*@import\s*\(\s*"([^"]+)"/);
    if (!importMatch) continue;
    const names = source.slice(open + 1, close)
      .match(/\b[A-Za-z_][\w]*\b/g) ?? [];
    const word = wordAt(source, offset);
    return {
      module: importMatch[1],
      selectedNames: names.filter((name) => name !== word),
    };
  }
  return undefined;
}

function declarationCompletionName(decl: Declaration): string | undefined {
  return decl.kind === "fn" || decl.kind === "const" ||
      decl.kind === "let" || decl.kind === "type"
    ? decl.name
    : undefined;
}

function indexReferences(uri: string, source: string, mapper: PositionMapper): IndexedReference[] {
  const refs: IndexedReference[] = [];
  const tokenRegex = /@?[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/g;
  const declarationStarts = new Set<number>();
  for (
    const match of source.matchAll(
      /(?:fn|const(?!\s*\{)|let)\s+([A-Za-z_][\w.]*)|type\s+fn\s+([A-Za-z_][\w]*)/g,
    )
  ) {
    const name = match[1] ?? match[2];
    declarationStarts.add(match.index + match[0].lastIndexOf(name));
  }
  for (const match of source.matchAll(/\bconst\s*\{\s*([^}]*)\}\s*=\s*@import\s*\(/g)) {
    const listStart = match.index + match[0].indexOf(match[1]);
    for (const binding of match[1].matchAll(/\b[A-Za-z_][\w]*\b/g)) {
      declarationStarts.add(listStart + (binding.index ?? 0));
    }
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

function detailForDecl(
  decl: Declaration,
  program?: Program,
  localTypes = new Map<string, string>(),
): string {
  if (decl.kind === "type_assert") {
    return `@assert(${renderTypeExprHover(decl.value)})`;
  }
  if (decl.kind === "fn") {
    return `fn ${decl.name}(${
      decl.params.map((param) => `${param.name}: ${param.type}`).join(", ")
    })${decl.returnType ? ` -> ${decl.returnType}` : ""}`;
  }
  if (decl.kind === "type") {
    return `type fn ${decl.name}(${
      decl.params.map((param) => `${param.name}: ${param.kind}`).join(", ")
    }) -> ${decl.resultKind}`;
  }
  if (decl.kind === "operator") {
    return `${decl.fixity.slice(1)} ${decl.precedence} (${decl.symbol}) = ${decl.target}`;
  }
  const type = decl.type ?? expressionTypeFromProgram(decl.value, program, localTypes);
  return `${decl.kind} ${decl.name}${type ? `: ${type}` : ""}`;
}

function detailForEffectImport(item: EffectImport): string {
  return `const ${item.name}: ${item.type}`;
}

function hoverForSymbol(
  symbol: IndexedSymbol,
): { contents: { kind: "markdown"; value: string }; range?: Range } {
  return {
    contents: { kind: "markdown", value: renderHoverMarkdown(symbol) },
    range: symbol.selectionRange,
  };
}

function renderHoverMarkdown(symbol: IndexedSymbol): string {
  const lines: string[] = [];
  const signature = hoverSignature(symbol);
  if (signature) lines.push("", "```fig", signature, "```");
  lines.push(`**${symbol.kind}** \`${symbol.name}\``);
  const docs = renderDocumentation(symbol.documentation);
  if (docs) lines.push("", docs);
  return lines.join("\n").trimStart();
}

function hoverSignature(symbol: IndexedSymbol): string | undefined {
  if (symbol.detail?.startsWith("fn ") || symbol.detail?.startsWith("type fn ")) {
    return displayType(symbol.detail);
  }
  if (symbol.kind === "param" || symbol.kind === "local") {
    return symbol.detail ? `${symbol.name}: ${displayType(symbol.detail)}` : symbol.name;
  }
  if (symbol.kind === "const" || symbol.kind === "let") {
    return symbol.detail ? displayType(symbol.detail) : symbol.name;
  }
  if (symbol.kind === "member" || symbol.kind === "variant") {
    return symbol.detail ? `${symbol.name}: ${displayType(symbol.detail)}` : symbol.name;
  }
  return symbol.detail ? displayType(symbol.detail) : undefined;
}

function displayType(type: string): string {
  return type.replace(
    /(?<![A-Za-z0-9_])(?:[A-Za-z_][A-Za-z0-9_]*\.)+([A-Z][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g,
    "$1",
  );
}

function renderDocumentation(documentation: string | undefined): string | undefined {
  if (!documentation?.trim()) return undefined;
  const parsed = new TSDocParser().parseString(toTsdocComment(documentation));
  if (parsed.log.messages.length) return documentation.trim();
  const doc = parsed.docComment;
  const sections: string[] = [];
  const summary = renderDocNode(doc.summarySection).trim();
  if (summary) sections.push(summary);
  const remarks = renderDocNode(doc.remarksBlock?.content).trim();
  if (remarks) sections.push(`**Remarks**\n\n${remarks}`);
  const params = doc.params.blocks.map((block) => {
    const content = renderDocNode(block.content).trim();
    return content ? `- \`${block.parameterName}\`: ${content}` : `- \`${block.parameterName}\``;
  });
  if (params.length) sections.push(`**Parameters**\n\n${params.join("\n")}`);
  const typeParams = doc.typeParams.blocks.map((block) => {
    const content = renderDocNode(block.content).trim();
    return content ? `- \`${block.parameterName}\`: ${content}` : `- \`${block.parameterName}\``;
  });
  if (typeParams.length) sections.push(`**Type Parameters**\n\n${typeParams.join("\n")}`);
  const returns = renderDocNode(doc.returnsBlock?.content).trim();
  if (returns) sections.push(`**Returns**\n\n${returns}`);
  const deprecated = renderDocNode(doc.deprecatedBlock?.content).trim();
  if (deprecated) sections.push(`**Deprecated**\n\n${deprecated}`);
  for (const block of doc.seeBlocks) {
    const content = renderDocNode(block.content).trim();
    if (content) sections.push(`**See Also**\n\n${content}`);
  }
  for (const block of doc.customBlocks) {
    const tag = block.blockTag.tagName.replace(/^@/, "");
    const title = tag.replace(/(^|[-_])(\w)/g, (_match, _sep, char: string) => char.toUpperCase());
    const content = renderDocNode(block.content).trim();
    if (content) sections.push(`**${title}**\n\n${content}`);
  }
  return sections.length ? sections.join("\n\n") : documentation.trim();
}

function toTsdocComment(documentation: string): string {
  return `/**\n${
    documentation.split(/\r?\n/).map((line) => ` * ${line.replace(/\*\//g, "*\\/")}`).join("\n")
  }\n */`;
}

function renderDocNode(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const docNode = node as {
    kind?: string;
    text?: string;
    code?: string;
    urlDestination?: string;
    linkText?: string;
    getChildNodes?: () => unknown[];
  };
  if (docNode.kind === "PlainText") return docNode.text ?? "";
  if (docNode.kind === "CodeSpan") {
    const code = docNode.code ?? renderDocChildren(docNode);
    return code ? `\`${code.trim()}\`` : "";
  }
  if (docNode.kind === "FencedCode") return `\n\`\`\`\n${docNode.code ?? ""}\n\`\`\`\n`;
  if (docNode.kind === "SoftBreak") return "\n";
  if (docNode.kind === "LinkTag") {
    const text = docNode.linkText ?? docNode.urlDestination ?? renderDocChildren(docNode);
    return docNode.urlDestination ? `[${text}](${docNode.urlDestination})` : text;
  }
  if (docNode.kind === "Paragraph") return renderDocChildren(docNode);
  if (docNode.kind === "Section") return renderDocChildren(docNode);
  return renderDocChildren(docNode);
}

function renderDocChildren(node: { getChildNodes?: () => unknown[] }): string {
  return node.getChildNodes?.().map(renderDocNode).join("") ?? "";
}

function symbolAt(result: AnalysisResult, position: Position): IndexedSymbol | undefined {
  return directSymbolAt(result, position) ?? (() => {
    const offset = result.mapper.offsetAt(position);
    const word = wordAt(result.document.text, offset);
    return word
      ? result.symbols.find((item) => item.name === word || item.name.endsWith(`.${word}`))
      : undefined;
  })();
}

function directSymbolAt(result: AnalysisResult, position: Position): IndexedSymbol | undefined {
  const offset = result.mapper.offsetAt(position);
  const word = wordAt(result.document.text, offset);
  if (!word) return undefined;
  const candidates = result.symbols.filter((symbol) => {
    if (symbol.uri !== result.document.uri) return false;
    const start = result.mapper.offsetAt(symbol.selectionRange.start);
    const end = result.mapper.offsetAt(symbol.selectionRange.end);
    return offset >= start && offset <= end;
  });
  const namedCandidates = candidates.filter((item) =>
    item.name === word || item.name === `@${word}` || lastSegment(item.name) === word
  );
  return namedCandidates.sort((a, b) => {
    const aName = word && (a.name === word || a.name === `@${word}` || lastSegment(a.name) === word)
      ? 0
      : 1;
    const bName = word && (b.name === word || b.name === `@${word}` || lastSegment(b.name) === word)
      ? 0
      : 1;
    if (aName !== bName) return aName - bName;
    const aLocal = a.kind === "local" ? 0 : 1;
    const bLocal = b.kind === "local" ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    return rangeLength(result, a.selectionRange) - rangeLength(result, b.selectionRange);
  })[0];
}

function resolvedSymbolAt(result: AnalysisResult, position: Position): IndexedSymbol | undefined {
  const offset = result.mapper.offsetAt(position);
  const word = wordAt(result.document.text, offset);
  if (!word) return undefined;
  const pipeBinder = nearestPipeBinderSymbol(result, word, offset);
  if (
    pipeBinder &&
    result.mapper.offsetAt(pipeBinder.selectionRange.start) < offset
  ) {
    return pipeBinder;
  }
  const direct = symbolAt(result, position);
  if (direct) return direct;
  return resolveNameAtOffset(result, word, offset) ?? resolveName(result, word);
}

function qualifiedDefinitionSymbolAt(
  result: AnalysisResult,
  position: Position,
): IndexedSymbol | undefined {
  const offset = result.mapper.offsetAt(position);
  const segment = qualifiedSegmentAt(result.document.text, offset);
  if (!segment) return undefined;
  if (segment.segmentIndex === 0) {
    return resolveValueNameAt(result, segment.segmentText, offset);
  }
  if (segment.fullText.includes("::")) {
    return resolveName(result, segment.fullText);
  }
  return resolveName(result, segment.segmentText);
}

function isRenameableSymbol(symbol: IndexedSymbol): boolean {
  return !symbol.generated && !symbol.intrinsic &&
    !["member", "variant", "import"].includes(symbol.kind);
}

function renameEditsForSymbol(
  result: AnalysisResult,
  symbol: IndexedSymbol,
  newName: string,
): TextEdit[] {
  const edits: TextEdit[] = [];
  if ((symbol.kind === "local" || symbol.kind === "param") && result.document.uri !== symbol.uri) {
    return edits;
  }
  const declaration = result.symbols.find((candidate) => sameSymbolIdentity(candidate, symbol));
  if (declaration) {
    edits.push({ range: declaration.selectionRange, newText: newName });
  }
  for (const reference of result.references) {
    const offset = result.mapper.offsetAt(reference.range.start);
    const resolved = resolveNameAtOffset(result, reference.targetName ?? reference.name, offset) ??
      resolveName(result, reference.targetName ?? reference.name);
    if (resolved && equivalentSymbol(result, resolved, symbol)) {
      edits.push({ range: reference.range, newText: newName });
    }
  }
  return edits;
}

function equivalentSymbol(
  result: AnalysisResult,
  candidate: IndexedSymbol,
  target: IndexedSymbol,
): boolean {
  if (sameSymbolIdentity(candidate, target)) return true;
  const [prefix, ...rest] = candidate.name.split(".");
  if (!rest.length || rest.join(".") !== target.name || candidate.kind !== target.kind) {
    return false;
  }
  return result.imports.some((item) => {
    const importedPrefix = importPrefix(item);
    return item.uri === target.uri && importedPrefix !== undefined && importedPrefix === prefix;
  });
}

function importPrefix(item: IndexedImport): string | undefined {
  if (item.alias) return item.alias;
  if (item.destructured) return undefined;
  const file = item.module.split("/").at(-1) ?? item.module;
  return file.replace(/\.fig$/, "").split(".").at(-1) ?? file;
}

function sameSymbolIdentity(candidate: IndexedSymbol, target: IndexedSymbol): boolean {
  return candidate.uri === target.uri &&
    candidate.kind === target.kind &&
    candidate.name === target.name &&
    candidate.selectionRange.start.line === target.selectionRange.start.line &&
    candidate.selectionRange.start.character === target.selectionRange.start.character &&
    candidate.selectionRange.end.line === target.selectionRange.end.line &&
    candidate.selectionRange.end.character === target.selectionRange.end.character;
}

function resolveName(result: AnalysisResult, name: string): IndexedSymbol | undefined {
  return preferredResolvedSymbol(result.symbols.filter((item) => item.name === name)) ??
    preferredResolvedSymbol(result.symbols.filter((item) => item.name === name.split(".")[0])) ??
    preferredResolvedSymbol(result.symbols.filter((item) => item.name === lastSegment(name))) ??
    preferredResolvedSymbol(
      result.symbols.filter((item) => item.name.endsWith(`.${lastSegment(name)}`)),
    );
}

function preferredResolvedSymbol(symbols: IndexedSymbol[]): IndexedSymbol | undefined {
  return symbols.find((item) => item.kind !== "import") ?? symbols[0];
}

function resolveNameAtOffset(
  result: AnalysisResult,
  name: string,
  offset: number,
): IndexedSymbol | undefined {
  const pipeBinder = nearestPipeBinderSymbol(result, name, offset);
  if (pipeBinder) return pipeBinder;
  const localCandidates = result.symbols.filter((item) =>
    (item.kind === "local" || item.kind === "param") &&
    item.uri === result.document.uri &&
    (item.name === name || lastSegment(item.name) === name) &&
    result.mapper.offsetAt(item.selectionRange.start) <= offset
  );
  return localCandidates.sort((a, b) => {
    const aLocal = a.kind === "local" ? 0 : 1;
    const bLocal = b.kind === "local" ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    return result.mapper.offsetAt(b.selectionRange.start) -
      result.mapper.offsetAt(a.selectionRange.start);
  })[0];
}

function nearestPipeBinderSymbol(
  result: AnalysisResult,
  name: string,
  offset: number,
): IndexedSymbol | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\\\\\s*(${escaped})\\s*->`, "g");
  let match: RegExpExecArray | null;
  let best: { start: number; end: number } | undefined;
  while ((match = regex.exec(result.document.text))) {
    const nameStart = match.index + match[0].indexOf(match[1]);
    const nameEnd = nameStart + name.length;
    if (nameStart > offset) break;
    best = { start: nameStart, end: nameEnd };
  }
  if (!best) return undefined;
  const range = result.mapper.range(best.start, best.end);
  const indexed = result.symbols.find((symbol) =>
    symbol.kind === "local" && symbol.uri === result.document.uri && symbol.name === name &&
    result.mapper.offsetAt(symbol.selectionRange.start) === best.start
  );
  const detail = indexed?.detail ?? nearestPipeBinderType(result, name, best.start);
  return {
    name,
    kind: "local",
    uri: result.document.uri,
    range,
    selectionRange: range,
    detail,
    documentation: indexed?.documentation,
    container: indexed?.container ?? enclosingFunctionName(result, offset),
  };
}

function nearestPipeBinderType(
  result: AnalysisResult,
  name: string,
  binderStart: number,
): string | undefined {
  const previousStage = previousPipelineStageType(result, binderStart);
  if (previousStage) return previousStage;
  const container = enclosingFunctionName(result, binderStart);
  const candidates = result.symbols.filter((symbol) =>
    symbol.kind === "local" &&
    symbol.uri === result.document.uri &&
    symbol.name === name &&
    symbol.container === container &&
    symbol.detail
  );
  return candidates.sort((a, b) =>
    Math.abs(result.mapper.offsetAt(a.selectionRange.start) - binderStart) -
    Math.abs(result.mapper.offsetAt(b.selectionRange.start) - binderStart)
  )[0]?.detail;
}

function previousPipelineStageType(
  result: AnalysisResult,
  binderStart: number,
): string | undefined {
  const source = result.document.text;
  const before = source.slice(0, binderStart);
  const previousPipe = [...before.matchAll(/\\\s*[A-Za-z_]\w*\s*->/g)].at(-1);
  const stageStart = previousPipe
    ? (previousPipe.index ?? 0) + previousPipe[0].length
    : pipelineBaseStart(source, binderStart);
  const stageText = source.slice(stageStart, binderStart).trim();
  return callTextReturnType(stageText, result);
}

function pipelineBaseStart(source: string, binderStart: number): number {
  const before = source.slice(0, binderStart);
  const lineStart = before.lastIndexOf("\n");
  const previousLineStart = before.lastIndexOf("\n", Math.max(0, lineStart - 1));
  return previousLineStart >= 0 ? previousLineStart + 1 : 0;
}

function callTextReturnType(text: string, result: AnalysisResult): string | undefined {
  const match = text.match(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/);
  if (!match) return undefined;
  const name = match[1];
  const fn = functionDecl(result, name);
  if (fn?.returnType) return fn.returnType;
  const symbol = resolveName(result, name);
  return symbol?.detail ? functionReturnType(symbol.detail) : undefined;
}

function qualifiedValueHoverAt(
  result: AnalysisResult,
  position: Position,
): { contents: { kind: "markdown"; value: string }; range?: Range } | undefined {
  const offset = result.mapper.offsetAt(position);
  const segment = qualifiedSegmentAt(result.document.text, offset);
  if (!segment) return undefined;
  const base = resolveValueNameAt(result, segment.segments[0].text, offset);
  if (!base) return undefined;
  if (segment.segmentIndex === 0) {
    return hoverForSymbol({
      ...base,
      range: segment.segmentRange,
      selectionRange: segment.segmentRange,
    });
  }
  let current = symbolValueType(base);
  let info:
    | { name: string; kind: IndexedSymbol["kind"]; detail?: string; documentation?: string }
    | undefined;
  for (let index = 1; index <= segment.segmentIndex; index++) {
    const field = fieldNameFromQualifiedSegment(segment.segments[index]);
    if (!current || !field) return undefined;
    info = projectedFieldInfo(current, field, result);
    current = info?.detail;
  }
  if (!info) return undefined;
  return hoverForSymbol({
    name: segment.segmentText,
    kind: info.kind,
    uri: result.document.uri,
    range: segment.segmentRange,
    selectionRange: segment.segmentRange,
    detail: info.detail,
    documentation: info.documentation,
  });
}

function resolveValueNameAt(
  result: AnalysisResult,
  name: string,
  offset: number,
): IndexedSymbol | undefined {
  const container = enclosingFunctionName(result, offset);
  const valueKinds: IndexedSymbol["kind"][] = ["local", "param", "let", "const", "import", "fn"];
  const priority = new Map(valueKinds.map((kind, index) => [kind, index]));
  const candidates = result.symbols.filter((symbol) => {
    if (symbol.name !== name || !priority.has(symbol.kind)) return false;
    if ((symbol.kind === "local" || symbol.kind === "param") && symbol.container !== container) {
      return false;
    }
    const start = result.mapper.offsetAt(symbol.selectionRange.start);
    return start <= offset;
  });
  return candidates.sort((a, b) => {
    const priorityDelta = priority.get(a.kind)! - priority.get(b.kind)!;
    if (priorityDelta) return priorityDelta;
    return result.mapper.offsetAt(b.selectionRange.start) -
      result.mapper.offsetAt(a.selectionRange.start);
  })[0];
}

function enclosingFunctionName(result: AnalysisResult, offset: number): string | undefined {
  return result.program?.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && spanContainsOffset(decl.span, offset, result.document.uri)
  )?.name;
}

function expressionHoverAt(
  result: AnalysisResult,
  position: Position,
): { contents: { kind: "markdown"; value: string }; range?: Range } | undefined {
  const offset = result.mapper.offsetAt(position);
  const expr = smallestExprAt(result.program, offset, result.document.uri);
  if (!expr) return undefined;
  const info = expressionTypeInfo(expr, result);
  if (!info) return undefined;
  const range = rangeFromSpan(expr.span, result.mapper);
  const symbol: IndexedSymbol = {
    name: info.name,
    kind: info.kind,
    uri: result.document.uri,
    range: range ?? result.mapper.range(offset, offset),
    selectionRange: range ?? result.mapper.range(offset, offset),
    detail: info.detail,
    documentation: info.documentation,
  };
  return hoverForSymbol(symbol);
}

function callExpressionHoverAt(
  result: AnalysisResult,
  position: Position,
): { contents: { kind: "markdown"; value: string }; range?: Range } | undefined {
  const offset = result.mapper.offsetAt(position);
  const call = callBefore(result.document.text, offset);
  if (!call) return undefined;
  const symbol = resolveName(result, call.name);
  const detail = symbol?.detail ? functionReturnType(symbol.detail) : undefined;
  const fn = functionDecl(result, call.name);
  const type = fn?.returnType ?? detail;
  if (!type) return undefined;
  const open = result.document.text.lastIndexOf("(", offset);
  if (open >= 0 && isDeclarationParameterList(result.document.text, open)) {
    return undefined;
  }
  const nameStart = open >= 0 ? open - call.name.length : offset;
  const close = result.document.text.indexOf(")", Math.max(open, 0));
  const range = result.mapper.range(
    Math.max(0, nameStart),
    close >= 0 ? close + 1 : offset,
  );
  return hoverForSymbol({
    name: `${call.name}(...)`,
    kind: "local",
    uri: result.document.uri,
    range,
    selectionRange: range,
    detail: type,
  });
}

function isDeclarationParameterList(source: string, open: number): boolean {
  const lineStart = source.lastIndexOf("\n", open - 1) + 1;
  return /\b(?:fn|type\s+fn)\s+[A-Za-z_][\w.]*\s*$/.test(source.slice(lineStart, open));
}

function productConstructorHoverAt(
  result: AnalysisResult,
  position: Position,
): { contents: { kind: "markdown"; value: string }; range?: Range } | undefined {
  const offset = result.mapper.offsetAt(position);
  const word = wordAt(result.document.text, offset);
  if (!word) return undefined;
  const decl = typeDecls(result).find((item) =>
    item.normalized?.kind === "product" && item.normalized.constructor === word
  );
  if (!decl) return undefined;
  const range = wordRange(result, offset);
  return hoverForSymbol({
    name: word,
    kind: "local",
    uri: result.document.uri,
    range,
    selectionRange: range,
    detail: decl.name,
  });
}

function operatorHoverAt(
  result: AnalysisResult,
  position: Position,
): { contents: { kind: "markdown"; value: string }; range?: Range } | undefined {
  const offset = result.mapper.offsetAt(position);
  const match = result.document.text.slice(Math.max(0, offset - 2), offset + 3)
    .match(/(\.\.|==|!=|<=|>=|&&|\|\||[+\-*/%<>])/);
  if (!match?.[1]) return undefined;
  const start = Math.max(0, offset - 2) + (match.index ?? 0);
  const end = start + match[1].length;
  if (offset < start || offset > end) return undefined;
  const range = result.mapper.range(start, end);
  const name = match[1] === ".." ? "range_i32" : `${match[1]} expression`;
  const detail = match[1] === ".." ? "range expression" : "binary expression";
  return hoverForSymbol({
    name,
    kind: "local",
    uri: result.document.uri,
    range,
    selectionRange: range,
    detail,
  });
}

interface AstHoverCandidate {
  span: CompileDiagnostic["span"];
  symbol: IndexedSymbol;
}

function checkedAstHoverAt(
  result: AnalysisResult,
  position: Position,
): { contents: { kind: "markdown"; value: string }; range?: Range } | undefined {
  if (!result.program) return undefined;
  const offset = result.mapper.offsetAt(position);
  const candidates: AstHoverCandidate[] = [];
  const add = (
    span: CompileDiagnostic["span"],
    name: string,
    detail?: string,
    kind: IndexedSymbol["kind"] = "local",
    documentation?: string,
  ) => {
    if (!spanContainsOffset(span, offset, result.document.uri)) return;
    const range = rangeFromSpan(span, result.mapper) ?? result.mapper.range(offset, offset);
    candidates.push({
      span,
      symbol: {
        name,
        kind,
        uri: result.document.uri,
        range,
        selectionRange: range,
        detail,
        documentation,
      },
    });
  };
  const visitPattern = (pattern: ParamPattern | undefined, type?: string) => {
    if (!pattern) return;
    add(pattern.span, renderParamPatternHover(pattern), type ?? patternHoverKind(pattern));
    if (pattern.kind === "tuple") {
      for (const item of pattern.items) visitPattern(item);
    } else if (pattern.kind === "constructor") {
      for (const item of pattern.args) visitPattern(item);
    } else if (pattern.kind === "typed") {
      visitPattern(pattern.pattern, pattern.type);
    }
  };
  const visitCount = (count: TypeCountExpr | undefined) => {
    if (!count) return;
    add(count.span, renderCountExprHover(count), "count expression");
    if (count.kind === "count_mul") {
      visitCount(count.left);
      visitCount(count.right);
    }
  };
  const visitTypePattern = (pattern: TypePattern | undefined) => {
    if (!pattern) return;
    add(pattern.span, renderTypePatternHover(pattern), "type pattern");
  };
  const visitTypeExpr = (expr: TypeExpr | undefined) => {
    if (!expr) return;
    add(expr.span, renderTypeExprHover(expr), typeExprKindHover(expr));
    switch (expr.kind) {
      case "type_call":
        visitTypeExpr(expr.callee);
        for (const arg of expr.args) visitTypeExpr(arg);
        break;
      case "type_shape":
        for (const slot of expr.shape.slots) visitTypeShapeSlot(slot);
        for (const member of expr.shape.members ?? []) {
          add(member.nameSpan ?? member.span, member.name, member.type, "member", member.doc);
        }
        break;
      case "type_match":
        visitTypeExpr(expr.value);
        for (const arm of expr.arms) visitTypeMatchArm(arm);
        break;
      case "type_binary":
        visitTypeExpr(expr.left);
        visitTypeExpr(expr.right);
        break;
      case "type_scalar_domain":
        break;
      case "type_ref":
      case "type_hole":
      case "type_static_ref":
      case "type_fn":
      case "type_bool":
      case "type_number":
      case "type_char":
      case "type_string":
      case "type_literal":
        break;
    }
  };
  const visitTypeShapeSlot = (slot: TypeShapeSlot) => {
    const slotName = slot.label ?? (slot.position !== undefined ? `[${slot.position}]` : "slot");
    add(slot.nameSpan ?? slot.span, slotName, renderTypeExprHover(slot.type), "member", slot.doc);
    visitCount(slot.repeat);
    visitTypeExpr(slot.type);
  };
  const visitTypeMatchArm = (arm: TypeMatchArm) => {
    add(
      arm.span,
      `${renderTypePatternHover(arm.pattern)} => ${renderTypeExprHover(arm.value)}`,
      "type match arm",
    );
    visitTypePattern(arm.pattern);
    visitTypeExpr(arm.value);
  };
  const infoForExpr = (
    expr: Expr,
    localTypes: Map<string, string>,
  ): { name: string; kind: IndexedSymbol["kind"]; detail?: string; documentation?: string } => {
    if (expr.kind === "var") {
      const local = localTypes.get(expr.name);
      if (local) return { name: expr.name, kind: "local", detail: local };
    }
    const info = expressionTypeInfo(expr, result);
    if (info) return info;
    const type = expressionTypeFromProgram(expr, result.program, localTypes);
    return type
      ? { name: renderExprName(expr), kind: "local", detail: type }
      : expressionSyntaxInfo(expr);
  };
  const visitExpr = (expr: Expr | undefined, localTypes = new Map<string, string>()) => {
    if (!expr) return;
    const info = infoForExpr(expr, localTypes);
    add(expr.span, info.name, info.detail, info.kind, info.documentation);
    switch (expr.kind) {
      case "block":
        {
          const blockTypes = new Map(localTypes);
          for (const stmt of expr.statements) {
            visitStatement(stmt, blockTypes);
            recordStatementTypesForHover(stmt, blockTypes);
          }
          visitExpr(expr.expr, blockTypes);
        }
        break;
      case "pipe_bind":
        {
          const valueType = expressionTypeFromProgram(expr.value, result.program, localTypes);
          const scopedTypes = new Map(localTypes);
          if (valueType) scopedTypes.set(expr.name, valueType);
          add(pipeBindNameSpan(result, expr), expr.name, valueType, "local", expr.doc);
          visitExpr(expr.value, localTypes);
          visitExpr(expr.body, scopedTypes);
        }
        break;
      case "match":
        visitExpr(expr.value, localTypes);
        for (const arm of expr.arms) {
          const guard = arm.guard ? " if ..." : "";
          add(arm.span, `${renderParamPatternHover(arm.pattern)}${guard} => ...`, "match arm");
          visitPattern(arm.pattern);
          if (arm.guard) visitExpr(arm.guard, localTypes);
          visitExpr(arm.value, localTypes);
        }
        break;
      case "call":
        if (!expr.tailRec) visitExpr(expr.callee, localTypes);
        for (const arg of expr.args) visitExpr(arg, localTypes);
        break;
      case "index":
        visitExpr(expr.target, localTypes);
        visitExpr(expr.index, localTypes);
        break;
      case "binary":
        visitExpr(expr.left, localTypes);
        visitExpr(expr.right, localTypes);
        break;
      case "shape":
      case "product_constructor":
        for (const slot of expr.slots) {
          const slotName = slot.label ??
            (slot.position !== undefined ? `[${slot.position}]` : "slot");
          add(
            slot.nameSpan ?? slot.span,
            slotName,
            expressionTypeFromProgram(slot.value, result.program, localTypes),
            "member",
            slot.doc,
          );
          visitCount(slot.repeat);
          visitExpr(slot.value, localTypes);
        }
        break;
      case "static_for_slots":
        add(staticForExprBinderSpan(result, expr, expr.iterator), expr.iterator, "static iterator");
        if (expr.valueIterator) {
          add(
            staticForExprBinderSpan(result, expr, expr.valueIterator),
            expr.valueIterator,
            "static value iterator",
          );
        }
        if (expr.source.kind === "range") {
          visitExpr(expr.source.start, localTypes);
          visitExpr(expr.source.end, localTypes);
        } else {
          visitExpr(expr.source.shape, localTypes);
        }
        visitExpr(expr.value, localTypes);
        break;
      case "field":
        visitExpr(expr.value, localTypes);
        visitExpr(expr.key, localTypes);
        break;
      case "range":
        visitExpr(expr.start, localTypes);
        visitExpr(expr.end, localTypes);
        break;
      case "literal":
      case "var":
        break;
    }
  };
  const recordStatementTypesForHover = (
    stmt: Statement,
    localTypes: Map<string, string>,
  ) => {
    if (stmt.kind === "let") {
      const type = stmt.type ?? expressionTypeFromProgram(stmt.value, result.program, localTypes);
      if (type) localTypes.set(stmt.name, type);
    } else if (stmt.kind === "destructure_let") {
      stmt.names.forEach((name, index) => {
        const type = stmt.slotTypes?.[index];
        if (type) localTypes.set(name, type);
      });
    }
  };
  const visitStatement = (stmt: Statement, localTypes = new Map<string, string>()) => {
    if (stmt.kind === "let") {
      add(
        stmt.nameSpan ?? stmt.span,
        stmt.name,
        stmt.type ?? expressionTypeFromProgram(stmt.value, result.program, localTypes),
        "local",
        stmt.doc,
      );
      visitExpr(stmt.value, localTypes);
    } else if (stmt.kind === "destructure_let") {
      stmt.names.forEach((name, index) =>
        add(
          stmt.nameSpans?.[name] ?? stmt.span,
          name,
          stmt.slotTypes?.[index],
          "local",
          stmt.nameDocs?.[name],
        )
      );
      visitExpr(stmt.value, localTypes);
    } else if (stmt.kind === "type_assert") {
      visitTypeExpr(stmt.value);
    }
  };

  for (const item of result.program.imports) {
    add(item.nameSpan ?? item.span, item.name, detailForEffectImport(item), "const");
  }
  for (const item of result.program.sourceImports ?? []) {
    const detail = `@import("${item.module}")`;
    add(item.nameSpan ?? item.span, item.alias ?? item.module, detail, "import");
    for (const binding of item.bindings ?? []) {
      add(binding.nameSpan ?? binding.span, binding.name, detail, "import");
    }
  }
  for (const decl of result.program.declarations) {
    if (decl.kind === "fn") {
      add(
        decl.nameSpan ?? decl.span,
        decl.name,
        detailForDecl(decl, result.program),
        decl.kind,
        decl.doc,
      );
      for (const param of decl.params) {
        add(param.nameSpan ?? param.span, param.name, param.type, "param", param.doc);
        visitPattern(param.pattern, param.type);
      }
      const localTypes = new Map<string, string>();
      for (const param of decl.params) localTypes.set(param.name, param.type);
      visitExpr(decl.body, localTypes);
    } else if (decl.kind === "type") {
      add(
        decl.nameSpan ?? decl.span,
        decl.name,
        detailForDecl(decl, result.program),
        "type",
        decl.doc,
      );
      for (const param of decl.params) {
        add(param.nameSpan ?? param.span, param.name, param.kind, "param", param.doc);
      }
      for (const pattern of decl.paramPatterns ?? []) visitPattern(pattern);
      for (const stmt of decl.body.statements) {
        add(
          stmt.nameSpan ?? stmt.span,
          stmt.name,
          renderTypeExprHover(stmt.value),
          "member",
          stmt.doc,
        );
        visitTypeExpr(stmt.value);
      }
      visitTypeExpr(decl.body.expr);
    } else if (decl.kind === "operator") {
      add(
        decl.nameSpan ?? decl.span,
        decl.name,
        detailForDecl(decl, result.program),
        "const",
        decl.doc,
      );
    } else if (decl.kind === "type_assert") {
      visitTypeExpr(decl.value);
    } else {
      add(
        decl.nameSpan ?? decl.span,
        decl.name,
        detailForDecl(decl, result.program),
        decl.kind,
        decl.doc,
      );
      visitExpr(decl.value);
    }
  }
  const best = candidates
    .filter((candidate) => spanContainsOffset(candidate.span, offset, result.document.uri))
    .sort((a, b) => spanLength(a.span) - spanLength(b.span))[0];
  return best ? hoverForSymbol(best.symbol) : undefined;
}

function smallestExprAt(
  program: Program | undefined,
  offset: number,
  sourceId: string,
): Expr | undefined {
  if (!program) return undefined;
  let best: Expr | undefined;
  const visit = (expr: Expr | undefined) => {
    if (!expr || !spanContainsOffset(expr.span, offset, sourceId)) return;
    if (!best || spanLength(expr.span) < spanLength(best.span)) best = expr;
    for (const child of childExprs(expr)) visit(child);
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") visit(decl.body);
    else if (decl.kind === "let" || decl.kind === "const") visit(decl.value);
  }
  return best;
}

function childExprs(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "do":
      return [
        ...expr.statements.flatMap((stmt) =>
          stmt.kind === "do_bind" || stmt.kind === "do_expr" || stmt.kind === "let" ||
            stmt.kind === "destructure_let"
            ? [stmt.value]
            : []
        ),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "const_fn":
      return [expr.body];
    case "profile":
      return [...expr.args, expr.body];
    case "block":
      return [
        ...expr.statements.flatMap((stmt) => statementValue(stmt) ? [statementValue(stmt)!] : []),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "pipe_bind":
      return [expr.value, expr.body];
    case "match":
      return [
        expr.value,
        ...expr.arms.flatMap((arm) => arm.guard ? [arm.guard, arm.value] : [arm.value]),
      ];
    case "call":
      if (expr.tailRec) return expr.args;
      return [expr.callee, ...expr.args];
    case "index":
      return [expr.target, expr.index];
    case "binary":
      return [expr.left, expr.right];
    case "operator_chain":
      return [expr.first, ...expr.rest.map((item) => item.value)];
    case "shape":
    case "product_constructor":
      return expr.slots.map((slot) => slot.value);
    case "static_for_slots":
      return [expr.value];
    case "field":
      return [expr.value, expr.key];
    case "range":
      return [expr.start, expr.end];
    case "literal":
    case "var":
      return [];
  }
}

function spanContainsOffset(
  span: CompileDiagnostic["span"],
  offset: number,
  sourceId: string,
): boolean {
  if (!span) return false;
  if (span.sourceId && span.sourceId !== sourceId) return false;
  return offset >= span.start && offset <= span.end;
}

function spanLength(span: CompileDiagnostic["span"]): number {
  return span ? span.end - span.start : Number.MAX_SAFE_INTEGER;
}

function rangeLength(result: AnalysisResult, range: Range): number {
  return result.mapper.offsetAt(range.end) - result.mapper.offsetAt(range.start);
}

function expressionTypeInfo(
  expr: Expr,
  result: AnalysisResult,
):
  | { name: string; kind: IndexedSymbol["kind"]; detail?: string; documentation?: string }
  | undefined {
  if (expr.kind === "var") {
    const projected = projectedVarInfo(expr.name, result);
    if (projected) return projected;
    const resolved = resolveName(result, expr.name);
    if (resolved) return resolved;
  }
  if (expr.kind === "field") {
    const base = expressionType(expr.value, result);
    const field = fieldName(expr.key);
    if (base && field) return projectedFieldInfo(base, field, result);
  }
  const type = expressionType(expr, result);
  if (!type) return undefined;
  return { name: renderExprName(expr), kind: "local", detail: type };
}

function expressionSyntaxInfo(
  expr: Expr,
): { name: string; kind: IndexedSymbol["kind"]; detail?: string; documentation?: string } {
  switch (expr.kind) {
    case "do":
      return { name: "do expression", kind: "local" };
    case "const_fn":
      return { name: "const function", kind: "local" };
    case "profile":
      return { name: "profile expression", kind: "local" };
    case "binary":
      return { name: `${expr.op} expression`, kind: "local", detail: "binary expression" };
    case "operator_chain":
      return { name: "operator chain", kind: "local" };
    case "index":
      return { name: "index expression", kind: "local" };
    case "match":
      return { name: "match expression", kind: "local" };
    case "pipe_bind":
      return { name: "pipe-bind expression", kind: "local" };
    case "block":
      return { name: "block expression", kind: "local" };
    case "call":
      if (expr.tailRec) return { name: "rec expression", kind: "local" };
      return { name: renderExprName(expr), kind: "local", detail: "call expression" };
    case "field":
      return { name: "field projection", kind: "local" };
    case "static_for_slots":
      return { name: "static-for slots", kind: "local" };
    case "shape":
      return {
        name: expr.syntax === "collection" ? "collection value" : "record value",
        kind: "local",
      };
    case "product_constructor":
      return { name: expr.constructor, kind: "local", detail: "product constructor" };
    case "range":
      return { name: "range_i32", kind: "local" };
    case "literal":
      return {
        name: expr.value,
        kind: "local",
        detail: expr.inferredType ?? literalTypeName(expr),
      };
    case "var":
      return { name: expr.name, kind: "local" };
  }
}

function literalTypeName(expr: Extract<Expr, { kind: "literal" }>): string | undefined {
  if (expr.literalKind === "number") return "i32";
  if (expr.literalKind === "bool") return "bool";
  if (expr.literalKind === "string" || expr.literalKind === "multiline") return "string";
  if (expr.literalKind === "char") return "char";
  if (expr.literalKind === "literalType") return "literal";
  return undefined;
}

function expressionType(expr: Expr, result: AnalysisResult): string | undefined {
  if (expr.kind === "literal") {
    if (expr.inferredType) return expr.inferredType;
    if (expr.literalKind === "number") return "i32";
    if (expr.literalKind === "bool") return "bool";
    if (expr.literalKind === "string" || expr.literalKind === "multiline") return "string";
    if (expr.literalKind === "char") return "char";
    if (expr.literalKind === "literalType") return "literal";
  }
  if (expr.kind === "var") {
    const symbol = resolveName(result, expr.name);
    const type = symbolValueType(symbol);
    if (type) return type;
    return projectedVarInfo(expr.name, result)?.detail;
  }
  if (expr.kind === "call") {
    const calleeName = expr.callee.kind === "var" ? expr.callee.name : undefined;
    const fn = calleeName ? functionDecl(result, calleeName) : undefined;
    if (fn?.returnType) return fn.returnType;
    const symbol = calleeName ? resolveName(result, calleeName) : undefined;
    return symbol?.detail ? functionReturnType(symbol.detail) : undefined;
  }
  if (expr.kind === "product_constructor") {
    return typeDecls(result).find((decl) =>
      decl.normalized?.kind === "product" && decl.normalized.constructor === expr.constructor
    )?.name;
  }
  if (expr.kind === "field") {
    const base = expressionType(expr.value, result);
    const field = fieldName(expr.key);
    return base && field ? projectedFieldInfo(base, field, result)?.detail : undefined;
  }
  if (expr.kind === "pipe_bind") return expressionType(expr.body, result);
  if (expr.kind === "match") {
    const armTypes = expr.arms.map((arm) => expressionType(arm.value, result));
    const first = armTypes[0];
    return first && armTypes.every((type) => type === first) ? first : undefined;
  }
  if (expr.kind === "range") return "range_i32";
  if (expr.kind === "shape") {
    if (expr.inferredType) return expr.inferredType;
    return shapeExpressionType(expr, (value) => expressionType(value, result));
  }
  return undefined;
}

function shapeExpressionType(
  expr: Extract<Expr, { kind: "shape" }>,
  typeOf: (value: Expr) => string | undefined,
): string | undefined {
  const items = expr.slots.map((slot) => {
    const type = slot.spread ? "..." : typeOf(slot.value) ?? "unknown";
    return slot.label ? `${slot.label}: ${type}` : type;
  });
  return `{${items.join(", ")}}`;
}

function symbolValueType(symbol: IndexedSymbol | undefined): string | undefined {
  if (!symbol?.detail) return undefined;
  if (symbol.kind === "fn") return functionReturnType(symbol.detail);
  if (symbol.kind === "const" || symbol.kind === "let") {
    const prefix = `${symbol.kind} ${symbol.name}:`;
    return symbol.detail.startsWith(prefix)
      ? symbol.detail.slice(prefix.length).trim()
      : symbol.detail;
  }
  return symbol.detail;
}

function projectedVarInfo(
  name: string,
  result: AnalysisResult,
):
  | { name: string; kind: IndexedSymbol["kind"]; detail?: string; documentation?: string }
  | undefined {
  const [base, ...fields] = name.split(".");
  if (!fields.length) return undefined;
  let current = symbolValueType(resolveName(result, base));
  let info:
    | { name: string; kind: IndexedSymbol["kind"]; detail?: string; documentation?: string }
    | undefined;
  for (const field of fields) {
    if (!current) return undefined;
    info = projectedFieldInfo(current, field, result);
    current = info?.detail;
  }
  return info ? { ...info, name } : undefined;
}

function projectedFieldInfo(
  type: string,
  field: string,
  result: AnalysisResult,
):
  | { name: string; kind: IndexedSymbol["kind"]; detail?: string; documentation?: string }
  | undefined {
  const decl = resolveTypeDecl(type, typeDecls(result));
  if (decl?.normalized?.kind !== "product") return undefined;
  const slot = decl.normalized.shape.slots.find((item) => item.label === field);
  return slot
    ? { name: field, kind: "member", detail: slot.type, documentation: slot.doc }
    : undefined;
}

function memberCompletionItems(
  result: AnalysisResult,
  context: MemberCompletionContext,
): CompletionItem[] | undefined {
  const receiverSymbol = resolveName(result, context.receiver);
  const receiverType = receiverSymbol?.kind === "type"
    ? receiverSymbol.name
    : typeForQualifiedValue(context.receiver, result);
  const decl = receiverType ? resolveTypeDecl(receiverType, typeDecls(result)) : undefined;
  if (!decl?.normalized) return undefined;
  const items: CompletionItem[] = [];
  if (receiverSymbol?.kind === "type" && context.separator === "::") {
    if (decl.enum) {
      for (const variant of decl.enum.variants) {
        items.push({
          label: variant.name,
          kind: completionKind("const"),
          detail: decl.name,
          documentation: variant.doc,
        });
      }
    }
    if (decl.normalized.kind === "product" || decl.normalized.kind === "sum") {
      for (const member of decl.normalized.members ?? []) {
        items.push({
          label: member.name,
          kind: completionKind("fn"),
          detail: member.type,
          documentation: member.doc,
        });
      }
    }
  } else if (context.separator === "." && decl.normalized.kind === "product") {
    for (const slot of decl.normalized.shape.slots) {
      if (!slot.label) continue;
      items.push({
        label: slot.label,
        kind: completionKind("member"),
        detail: slot.type,
        documentation: slot.doc,
      });
    }
  }
  const filtered = items.filter((item) => item.label.startsWith(context.prefix));
  return dedupeCompletions(filtered);
}

function typeForQualifiedValue(name: string, result: AnalysisResult): string | undefined {
  const [base, ...fields] = name.split(".");
  let current = symbolValueType(resolveName(result, base));
  for (const field of fields) {
    if (!current) return undefined;
    current = projectedFieldInfo(current, field, result)?.detail;
  }
  return current;
}

function resolveTypeDecl(type: string, types: TypeDecl[]): TypeDecl | undefined {
  return types.find((decl) => decl.name === typeName(type));
}

function typeName(type: string): string {
  return type.trim().replace(/\(.*\)$/, "");
}

function typeDecls(result: AnalysisResult): TypeDecl[] {
  return result.program?.declarations.filter((decl): decl is TypeDecl => decl.kind === "type") ??
    [];
}

function functionDecl(result: AnalysisResult, name: string): FnDecl | undefined {
  return result.program?.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && (decl.name === name || decl.name.endsWith(`.${name}`))
  );
}

function functionReturnType(detail: string): string | undefined {
  return detail.match(/\)\s*->\s*([^!]+?)(?:\s*!|$)/)?.[1]?.trim();
}

function fieldName(expr: Expr): string | undefined {
  if (expr.kind === "var") return expr.name;
  if (expr.kind === "literal" && expr.literalKind === "literalType") return expr.value.slice(1);
  if (expr.kind === "literal" && expr.literalKind === "string") return expr.value.slice(1, -1);
  return undefined;
}

interface QualifiedSegment {
  text: string;
  identifierStart: number;
  identifierEnd: number;
}

interface QualifiedSegmentMatch {
  fullText: string;
  segmentText: string;
  segmentIndex: number;
  segmentRange: Range;
  segments: QualifiedSegment[];
}

function qualifiedSegmentAt(source: string, offset: number): QualifiedSegmentMatch | undefined {
  if (source[offset] === "." || source[offset] === "[" || source[offset] === "]") {
    return undefined;
  }
  const chainRegex =
    /[A-Za-z_]\w*(?:\[[^\]\s.:]*\])?(?:(?:\.|::)[A-Za-z_]\w*(?:\[[^\]\s.:]*\])?)*/g;
  for (const match of source.matchAll(chainRegex)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if ((!match[0].includes(".") && !match[0].includes("::")) || offset < start || offset > end) {
      continue;
    }
    const segments = qualifiedSegments(match[0], start);
    const segmentIndex = segments.findIndex((segment) =>
      offset >= segment.identifierStart && offset <= segment.identifierEnd
    );
    if (segmentIndex < 0) return undefined;
    const segment = segments[segmentIndex];
    return {
      fullText: match[0],
      segmentText: segment.text,
      segmentIndex,
      segmentRange: new PositionMapper(source).range(
        segment.identifierStart,
        segment.identifierEnd,
      ),
      segments,
    };
  }
  return undefined;
}

function qualifiedSegments(fullText: string, start: number): QualifiedSegment[] {
  const segments: QualifiedSegment[] = [];
  const segmentRegex = /([A-Za-z_]\w*)(\[[^\]\s.]*\])?/g;
  for (const match of fullText.matchAll(segmentRegex)) {
    const segmentStart = start + (match.index ?? 0);
    segments.push({
      text: match[0],
      identifierStart: segmentStart,
      identifierEnd: segmentStart + match[1].length,
    });
  }
  return segments;
}

function fieldNameFromQualifiedSegment(segment: QualifiedSegment | undefined): string | undefined {
  return segment?.text.match(/^[A-Za-z_]\w*/)?.[0];
}

function renderExprName(expr: Expr): string {
  if (expr.kind === "call" && expr.callee.kind === "var") return `${expr.callee.name}(...)`;
  if (expr.kind === "product_constructor") return expr.constructor;
  if (expr.kind === "literal") return expr.value;
  if (expr.kind === "var") return expr.name;
  return expr.kind;
}

function renderParamPatternHover(pattern: ParamPattern): string {
  switch (pattern.kind) {
    case "binding":
      return pattern.name;
    case "wildcard":
      return "_";
    case "literal":
      return pattern.value;
    case "enum_member":
      return pattern.name;
    case "tuple":
      return `[${pattern.items.map(renderParamPatternHover).join(", ")}]`;
    case "constructor":
      return `${pattern.name}(${pattern.args.map(renderParamPatternHover).join(", ")})`;
    case "type":
      return pattern.name;
    case "typed":
      return `${renderParamPatternHover(pattern.pattern)}: ${pattern.type}`;
  }
}

function patternHoverKind(pattern: ParamPattern): string {
  switch (pattern.kind) {
    case "binding":
      return "binding pattern";
    case "wildcard":
      return "wildcard pattern";
    case "literal":
      return `${pattern.literalKind} pattern`;
    case "tuple":
      return "tuple pattern";
    case "constructor":
      return "constructor pattern";
    case "enum_member":
      return "enum member pattern";
    case "type":
      return "type pattern";
    case "typed":
      return "typed pattern";
  }
}

function renderTypeExprHover(expr: TypeExpr): string {
  switch (expr.kind) {
    case "type_ref":
      return expr.name;
    case "type_hole":
      return "_";
    case "type_static_ref":
      return `@${expr.name}`;
    case "type_call":
      return `${renderTypeExprHover(expr.callee)}(${
        expr.args.map(renderTypeExprHover).join(", ")
      })`;
    case "type_fn":
      return expr.source.replace(/\s+/g, " ").trim();
    case "type_shape":
      return `{${
        expr.shape.slots.map((slot) =>
          `${renderTypeShapeSlotKey(slot)}${
            slot.repeat ? `${renderCountExprHover(slot.repeat)} * ` : ""
          }${renderTypeExprHover(slot.type)}`
        ).join(", ")
      }}`;
    case "type_match":
      return `match ${renderTypeExprHover(expr.value)} { ${
        expr.arms.map((arm) =>
          `${renderTypePatternHover(arm.pattern)} => ${renderTypeExprHover(arm.value)}`
        ).join(", ")
      } }`;
    case "type_binary":
      return `${renderTypeExprHover(expr.left)} ${expr.op} ${renderTypeExprHover(expr.right)}`;
    case "type_scalar_domain":
      return `${expr.carrier}(${
        expr.members.map((member) => {
          const start = member.start.source;
          const end = member.end?.source;
          return end ? `${start}..${end}` : start;
        }).join(" | ")
      })`;
    case "type_bool":
      return expr.value ? "true" : "false";
    case "type_number":
      return expr.value;
    case "type_char":
      return `'${expr.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "type_string":
      return JSON.stringify(expr.value);
    case "type_literal":
      return `#${expr.value}`;
  }
}

function typeExprKindHover(expr: TypeExpr): string {
  switch (expr.kind) {
    case "type_ref":
      return "type reference";
    case "type_hole":
      return "type hole";
    case "type_static_ref":
      return "static type reference";
    case "type_call":
      return "type call";
    case "type_fn":
      return "function type";
    case "type_shape":
      return "shape type";
    case "type_match":
      return "type match";
    case "type_binary":
      return "type expression";
    case "type_scalar_domain":
      return "refined scalar domain";
    case "type_bool":
    case "type_number":
    case "type_char":
    case "type_string":
    case "type_literal":
      return "type literal";
  }
}

function renderTypePatternHover(pattern: TypePattern): string {
  switch (pattern.kind) {
    case "wildcard":
      return "_";
    case "bool":
      return pattern.value ? "true" : "false";
    case "literal":
      return `#${pattern.value}`;
    case "string":
      return JSON.stringify(pattern.value);
    case "char":
      return `'${pattern.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "number":
      return pattern.value;
    case "type":
      return pattern.name;
  }
}

function renderTypeShapeSlotKey(slot: { label?: string; position?: number }): string {
  if (slot.label && slot.position !== undefined) return `${slot.label}[${slot.position}]: `;
  if (slot.label) return `${slot.label}: `;
  if (slot.position !== undefined) return `[${slot.position}]: `;
  return "";
}

function renderCountExprHover(expr: TypeCountExpr): string {
  switch (expr.kind) {
    case "count_literal":
      return expr.source;
    case "count_ref":
      return expr.name;
    case "count_mul":
      return `${renderCountExprHover(expr.left)} * ${renderCountExprHover(expr.right)}`;
  }
}

function pipeBindNameSpan(
  result: AnalysisResult,
  expr: Extract<Expr, { kind: "pipe_bind" }>,
): CompileDiagnostic["span"] {
  return pipeBindNameSpanFromSource(result.document.text, expr);
}

function pipeBindNameSpanFromSource(
  sourceText: string,
  expr: Extract<Expr, { kind: "pipe_bind" }>,
): CompileDiagnostic["span"] {
  if (!expr.span) return undefined;
  const source = sourceText.slice(expr.span.start, expr.span.end);
  const escaped = expr.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\\\\\s*(${escaped})\\s*->`).exec(source);
  if (match?.index === undefined) return expr.span;
  const start = expr.span.start + match.index + match[0].indexOf(match[1]);
  return { ...expr.span, start, end: start + expr.name.length };
}

function staticForExprBinderSpan(
  result: AnalysisResult,
  expr: Extract<Expr, { kind: "static_for_slots" }>,
  name: string,
): CompileDiagnostic["span"] {
  if (!expr.span) return undefined;
  const source = result.document.text.slice(expr.span.start, expr.span.end);
  const match = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).exec(source);
  if (!match?.index) return expr.span;
  return {
    ...expr.span,
    start: expr.span.start + match.index,
    end: expr.span.start + match.index + name.length,
  };
}

function wordAt(source: string, offset: number): string | undefined {
  const left = source.slice(0, offset).match(/[A-Za-z_][\w.]*$/)?.[0] ?? "";
  const right = source.slice(offset).match(/^[\w.]*/)?.[0] ?? "";
  const word = `${left}${right}`;
  return word || undefined;
}

function wordRange(result: AnalysisResult, offset: number): Range {
  const left = result.document.text.slice(0, offset).match(/[A-Za-z_][\w.]*$/)?.[0] ?? "";
  const right = result.document.text.slice(offset).match(/^[\w.]*/)?.[0] ?? "";
  return result.mapper.range(offset - left.length, offset + right.length);
}

function memberCompletionContext(
  source: string,
  offset: number,
): MemberCompletionContext | undefined {
  const before = source.slice(0, offset);
  const match = before.match(/([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)(\.|::)([A-Za-z_][\w]*)?$/);
  if (!match) return undefined;
  return { receiver: match[1], separator: match[2] as "." | "::", prefix: match[3] ?? "", offset };
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

function rangeContainsSpan(
  result: AnalysisResult,
  range: Range,
  span: NonNullable<CompileDiagnostic["span"]>,
): boolean {
  return result.mapper.offsetAt(range.start) <= span.start &&
    span.end <= result.mapper.offsetAt(range.end);
}

function positionInRange(position: Position, range: Range): boolean {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
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
