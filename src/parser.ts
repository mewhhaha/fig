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
  const lines = new SourceLineMap(source);
  const result = traceSync(
    options.trace,
    "parse.syntax",
    () => parseSyntax(source),
    () => ({ sourceBytes: source.length }),
  );
  if (!result.ok || !result.tree) {
    const diagnostic = result.diagnostics[0];
    const code = looksLikeRemovedAngleCollection(source)
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
    () => adaptNode(source, tree, lines),
    () => ({ sourceBytes: source.length }),
  );
  const docs = traceSync(
    options.trace,
    "parse.docs",
    () => source.includes("///") ? docResolver(source) : () => undefined,
    () => ({ hasDocs: source.includes("///") }),
  );
  return traceSync(
    options.trace,
    "parse.lower",
    () => lowerProgram(adapted, docs, options.sourceId),
    programTraceCounters,
  );
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
