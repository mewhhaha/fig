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
  return parseWithOffset(source, source, 0, options);
}

export async function parseFragment(
  source: string,
  fullSource: string,
  spanOffset: number,
  options: ParseOptions = {},
): Promise<Program> {
  return parseWithOffset(source, fullSource, spanOffset, options);
}

async function parseWithOffset(
  source: string,
  fullSource: string,
  spanOffset: number,
  options: ParseOptions,
): Promise<Program> {
  const lines = new SourceLineMap(fullSource);
  const result = traceSync(
    options.trace,
    "parse.syntax",
    () => parseSyntax(source),
    () => ({ sourceBytes: source.length }),
  );
  if (!result.ok || !result.tree) {
    const diagnostic = result.diagnostics[0];
    fail(
      "parse.syntax",
      diagnostic?.message ?? "syntax error",
      diagnostic?.span
        ? lines.span(
          diagnostic.span.start + spanOffset,
          diagnostic.span.end + spanOffset,
          options.sourceId,
        )
        : undefined,
    );
  }
  const tree = result.tree;
  const adapted = traceSync(
    options.trace,
    "parse.adapt",
    () => adaptNode(fullSource, tree, lines, spanOffset),
    () => ({ sourceBytes: source.length }),
  );
  const docs = traceSync(
    options.trace,
    "parse.docs",
    () => fullSource.includes("///") ? docResolver(fullSource) : () => undefined,
    () => ({ hasDocs: fullSource.includes("///") }),
  );
  return traceSync(
    options.trace,
    "parse.lower",
    () => lowerProgram(adapted, docs, options.sourceId),
    programTraceCounters,
  );
}

function adaptNode(
  source: string,
  node: ParseNode,
  lines: SourceLineMap,
  spanOffset: number,
): SyntaxNodeLike {
  const start = node.span.start + spanOffset;
  const end = node.span.end + spanOffset;
  if (node.kind === "rule") {
    const namedChildren = [];
    for (const child of node.children) {
      const childName = child.kind === "rule" || child.kind === "token" ? child.name : child.value;
      if (childName === "Whitespace" || childName === "Comment") continue;
      namedChildren.push(adaptNode(source, child, lines, spanOffset));
    }
    return {
      type: node.name,
      get text() {
        return source.slice(start, end);
      },
      startIndex: start,
      endIndex: end,
      startPosition: lines.position(start),
      namedChildren,
    } as SyntaxNodeLike;
  }
  return {
    type: node.kind === "token" ? node.name : node.value,
    text: source.slice(start, end),
    startIndex: start,
    endIndex: end,
    startPosition: lines.position(start),
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
  private lastRow = 0;

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
    let row = Math.min(this.lastRow, this.lineStarts.length - 1);
    if (this.lineStarts[row]! <= safeOffset) {
      while (row + 1 < this.lineStarts.length && this.lineStarts[row + 1]! <= safeOffset) row++;
    } else {
      while (row > 0 && this.lineStarts[row]! > safeOffset) row--;
    }
    this.lastRow = row;
    return { row, column: safeOffset - this.lineStarts[row]! };
  }
}
