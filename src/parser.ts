import { parse as parseSyntax, type ParseNode } from "../generated/baba-workbench/parser.ts";
import type { SyntaxNodeLike } from "../generated/baba-workbench/ast/types.ts";
import type { Program } from "./core_ast.ts";
import { fail, type Span } from "./diagnostics.ts";
import { lowerProgram } from "./lower.ts";
import { type CompileTraceSink, programTraceCounters, traceSync } from "./trace.ts";

export interface ParseOptions {
  sourceId?: string;
  trace?: CompileTraceSink;
}

export async function parse(source: string, options: ParseOptions = {}): Promise<Program> {
  const parsedSource = desugarDataDeclarations(source);
  const lines = new SourceLineMap(parsedSource);
  const result = traceSync(
    options.trace,
    "parse.syntax",
    () => parseSyntax(parsedSource),
    () => ({ sourceBytes: parsedSource.length }),
  );
  if (!result.ok || !result.tree) {
    const diagnostic = result.diagnostics[0];
    const code = looksLikeRemovedAngleCollection(parsedSource)
      ? "syntax.collection_angle_removed"
      : "parse.syntax";
    fail(
      code,
      code === "syntax.collection_angle_removed"
        ? "angle-bracket collection literals have been removed; use #[...]"
        : diagnostic?.message ?? "syntax error",
      diagnostic?.span
        ? lines.span(diagnostic.span.start, diagnostic.span.end, options.sourceId)
        : undefined,
    );
  }
  const tree = result.tree;
  const adapted = traceSync(
    options.trace,
    "parse.adapt",
    () => adaptNode(parsedSource, tree, lines),
    () => ({ sourceBytes: parsedSource.length }),
  );
  const docs = traceSync(
    options.trace,
    "parse.docs",
    () => parsedSource.includes("///") ? docResolver(parsedSource) : () => undefined,
    () => ({ hasDocs: parsedSource.includes("///") }),
  );
  return traceSync(
    options.trace,
    "parse.lower",
    () => lowerProgram(adapted, docs, options.sourceId),
    programTraceCounters,
  );
}

function desugarDataDeclarations(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const start = findNextTypeSugar(source, index);
    if (start < 0) {
      output += source.slice(index);
      break;
    }
    output += source.slice(index, start);
    const parsed = parseTypeSugar(source, start);
    if (!parsed) {
      output += source[start];
      index = start + 1;
      continue;
    }
    output += renderTypeSugar(parsed);
    index = parsed.end;
  }
  return output;
}

interface TypeSugarDecl {
  name: string;
  params: string;
  kind: "struct" | "union" | "alias";
  body: string;
  end: number;
}

function findNextTypeSugar(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const next = source.indexOf("type", index);
    if (next < 0) return -1;
    if (!isWordBoundary(source, next - 1) || !isWordBoundary(source, next + 4)) {
      index = next + 4;
      continue;
    }
    const before = previousNonWhitespace(source, next - 1);
    if (before >= 0 && source[before] !== "}" && source[before] !== ";") {
      index = next + 4;
      continue;
    }
    const afterType = skipWhitespace(source, next + 4);
    if (source.startsWith("fn", afterType) && isWordBoundary(source, afterType + 2)) {
      index = next + 4;
      continue;
    }
    return next;
  }
  return -1;
}

function parseTypeSugar(source: string, start: number): TypeSugarDecl | undefined {
  let index = skipWhitespace(source, start + 4);
  const name = readPascalIdent(source, index);
  if (!name) return undefined;
  index = skipWhitespace(source, name.end);
  let params = "";
  if (source[index] === "(") {
    const end = findBalanced(source, index, "(", ")");
    if (end < 0) return undefined;
    params = source.slice(index + 1, end);
    index = skipWhitespace(source, end + 1);
  }
  if (source[index] !== "=") return undefined;
  index = skipWhitespace(source, index + 1);
  if (keywordAt(source, index, "struct") || keywordAt(source, index, "union")) {
    const kind = keywordAt(source, index, "struct") ? "struct" : "union";
    index = skipWhitespace(source, index + kind.length);
    if (source[index] !== "{") return undefined;
    const end = findBalanced(source, index, "{", "}");
    if (end < 0) return undefined;
    return {
      name: name.value,
      params,
      kind,
      body: source.slice(index + 1, end),
      end: consumeOptionalSemicolon(source, end + 1),
    };
  }
  const end = findTypeAliasEnd(source, index);
  if (end <= index) return undefined;
  return {
    name: name.value,
    params,
    kind: "alias",
    body: source.slice(index, end).trim(),
    end: consumeOptionalSemicolon(source, end),
  };
}

function renderTypeSugar(decl: TypeSugarDecl): string {
  const params = normalizeTypeSugarParams(decl.params);
  if (decl.kind === "alias") {
    return `type fn ${decl.name}(${params}) -> type { ${decl.body} }`;
  }
  if (decl.kind === "struct") {
    return `type fn ${decl.name}(${params}) -> struct { let ${decl.name} = {${decl.body.trim()}}; struct(${decl.name}) }`;
  }
  const variants = splitTopLevelComma(decl.body)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseUnionVariantSugar);
  return `type fn ${decl.name}(${params}) -> union { ${
    variants.map((variant) => `let ${variant.name} = {${variant.shape}};`).join(" ")
  } union(${variants.map((variant) => variant.name).join(", ")}) }`;
}

function normalizeTypeSugarParams(params: string): string {
  return splitTopLevelComma(params)
    .map((param) => param.trim())
    .filter(Boolean)
    .map((param) => param.includes(":") ? param : `${param}: type`)
    .join(", ");
}

function parseUnionVariantSugar(source: string): { name: string; shape: string } {
  const open = source.indexOf("(");
  if (open < 0) return { name: source.trim(), shape: "" };
  const close = source.lastIndexOf(")");
  return {
    name: source.slice(0, open).trim(),
    shape: close > open ? source.slice(open + 1, close).trim() : "",
  };
}

function readPascalIdent(
  source: string,
  index: number,
): { value: string; end: number } | undefined {
  const match = /^[A-Z][A-Za-z0-9]*/.exec(source.slice(index));
  return match ? { value: match[0], end: index + match[0].length } : undefined;
}

function keywordAt(source: string, index: number, keyword: string): boolean {
  return source.startsWith(keyword, index) && isWordBoundary(source, index + keyword.length);
}

function findBalanced(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const skipped = skipStringOrComment(source, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    const char = source[index];
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findTypeAliasEnd(source: string, start: number): number {
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  for (let index = start; index < source.length; index++) {
    const skipped = skipStringOrComment(source, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    const char = source[index];
    if (char === "(") paren++;
    else if (char === ")") paren--;
    else if (char === "{") brace++;
    else if (char === "}") {
      if (brace === 0) return index;
      brace--;
    } else if (char === "[") bracket++;
    else if (char === "]") bracket--;
    else if (char === ";" && paren === 0 && brace === 0 && bracket === 0) return index;
    else if (char === "\n" && paren === 0 && brace === 0 && bracket === 0) return index;
  }
  return source.length;
}

function splitTopLevelComma(source: string): string[] {
  const items: string[] = [];
  let start = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(") paren++;
    else if (char === ")") paren--;
    else if (char === "{") brace++;
    else if (char === "}") brace--;
    else if (char === "[") bracket++;
    else if (char === "]") bracket--;
    else if (char === "," && paren === 0 && brace === 0 && bracket === 0) {
      items.push(source.slice(start, index));
      start = index + 1;
    }
  }
  items.push(source.slice(start));
  return items;
}

function skipStringOrComment(source: string, index: number): number {
  if (source.startsWith("//", index)) {
    const end = source.indexOf("\n", index + 2);
    return end < 0 ? source.length : end + 1;
  }
  const quote = source[index];
  if (quote !== '"' && quote !== "'") return index;
  for (let cursor = index + 1; cursor < source.length; cursor++) {
    if (source[cursor] === "\\") {
      cursor++;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
  }
  return source.length;
}

function skipWhitespace(source: string, index: number): number {
  while (/\s/.test(source[index] ?? "")) index++;
  return index;
}

function previousNonWhitespace(source: string, index: number): number {
  while (index >= 0 && /\s/.test(source[index] ?? "")) index--;
  return index;
}

function consumeOptionalSemicolon(source: string, index: number): number {
  const next = skipWhitespace(source, index);
  return source[next] === ";" ? next + 1 : index;
}

function isWordBoundary(source: string, index: number): boolean {
  const char = source[index];
  return !char || !/[A-Za-z0-9_]/.test(char);
}

function looksLikeRemovedAngleCollection(source: string): boolean {
  return /(^|[=(:,{\[]|\breturn\b)\s*<\s*(?:[0-9]|true\b|false\b|\.\.\.|[A-Za-z_][A-Za-z0-9_]*\s*[,+-])[\s\S]{0,200}>/
    .test(
      source,
    );
}

function adaptNode(source: string, node: ParseNode, lines: SourceLineMap): SyntaxNodeLike {
  if (node.kind === "rule") {
    return {
      type: node.name,
      get text() {
        return source.slice(node.span.start, node.span.end);
      },
      startIndex: node.span.start,
      endIndex: node.span.end,
      startPosition: lines.position(node.span.start),
      namedChildren: node.children.map((child) => adaptNode(source, child, lines)),
    } as SyntaxNodeLike;
  }
  return {
    type: node.kind === "token" ? node.name : node.value,
    text: node.text,
    startIndex: node.span.start,
    endIndex: node.span.end,
    startPosition: lines.position(node.span.start),
    namedChildren: [],
  } as SyntaxNodeLike;
}

function docResolver(source: string): (start: number | undefined) => string | undefined {
  const docs = new Map<number, string>();
  const lines = source.matchAll(/[^\n]*(?:\n|$)/g);
  let offset = 0;
  let pending: string[] | undefined;
  let pendingLine = -1;
  let lineNo = 0;
  for (const match of lines) {
    const raw = match[0];
    if (!raw) break;
    const line = raw.replace(/\r?\n$/, "");
    const doc = line.match(/^\s*\/\/\/ ?(.*)$/);
    if (doc) {
      if (!pending || pendingLine !== lineNo - 1) pending = [];
      pending.push(doc[1]);
      pendingLine = lineNo;
    } else if (/^\s*$/.test(line) || /^\s*\/\//.test(line)) {
      pending = undefined;
      pendingLine = -1;
    } else {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (pending && pendingLine === lineNo - 1) docs.set(offset + indent, pending.join("\n"));
      pending = undefined;
      pendingLine = -1;
    }
    offset += raw.length;
    lineNo++;
  }
  return (start) => start === undefined ? undefined : docs.get(start);
}

class SourceLineMap {
  readonly lineStarts: number[] = [0];

  constructor(readonly source: string) {
    for (let index = 0; index < source.length; index++) {
      if (source[index] === "\n") this.lineStarts.push(index + 1);
    }
  }

  span(start: number, end: number, sourceId?: string): Span {
    const position = this.position(start);
    return {
      start,
      end,
      line: position.row + 1,
      column: position.column + 1,
      ...(sourceId ? { sourceId } : {}),
    };
  }

  position(offset: number): { row: number; column: number } {
    const safeOffset = Math.max(0, Math.min(offset, this.source.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.lineStarts[mid]! <= safeOffset) low = mid + 1;
      else high = mid - 1;
    }
    const row = Math.max(0, low - 1);
    return { row, column: safeOffset - this.lineStarts[row]! };
  }
}
