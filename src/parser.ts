import { parse as parseSyntax, type ParseNode } from "../generated/baba-workbench/parser.ts";
import type { SyntaxNodeLike } from "../generated/baba-workbench/ast/types.ts";
import type { Program } from "./core_ast.ts";
import { fail, type Span } from "./diagnostics.ts";
import { lowerProgram } from "./lower.ts";

export interface ParseOptions {
  sourceId?: string;
}

export async function parse(source: string, options: ParseOptions = {}): Promise<Program> {
  const result = parseSyntax(source);
  if (!result.ok || !result.tree) {
    const diagnostic = result.diagnostics[0];
    fail(
      "parse.syntax",
      diagnostic?.message ?? "syntax error",
      diagnostic?.span
        ? spanFor(source, diagnostic.span.start, diagnostic.span.end, options.sourceId)
        : undefined,
    );
  }
  return lowerProgram(adaptNode(source, result.tree), docResolver(source), options.sourceId);
}

function adaptNode(source: string, node: ParseNode): SyntaxNodeLike {
  if (node.kind === "rule") {
    return {
      type: node.name,
      text: source.slice(node.span.start, node.span.end),
      startIndex: node.span.start,
      endIndex: node.span.end,
      startPosition: positionFor(source, node.span.start),
      namedChildren: node.children.map((child) => adaptNode(source, child)),
    } as SyntaxNodeLike;
  }
  return {
    type: node.kind === "token" ? node.name : node.value,
    text: node.text,
    startIndex: node.span.start,
    endIndex: node.span.end,
    startPosition: positionFor(source, node.span.start),
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

function spanFor(source: string, start: number, end: number, sourceId?: string): Span {
  let line = 1;
  let column = 1;
  for (let i = 0; i < start; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { start, end, line, column, ...(sourceId ? { sourceId } : {}) };
}

function positionFor(source: string, offset: number): { row: number; column: number } {
  let row = 0;
  let column = 0;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      row++;
      column = 0;
    } else column++;
  }
  return { row, column };
}
