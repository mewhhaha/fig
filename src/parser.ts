import { parse as parseSyntax, type ParseNode } from "../generated/baba-workbench/parser.ts";
import type { SyntaxNodeLike } from "../generated/baba-workbench/ast/types.ts";
import type { Program } from "./core_ast.ts";
import { fail, type Span } from "./diagnostics.ts";
import { lowerProgram } from "./lower.ts";

export async function parse(source: string): Promise<Program> {
  const result = parseSyntax(source);
  if (!result.ok || !result.tree) {
    const diagnostic = result.diagnostics[0];
    fail(
      "parse.syntax",
      diagnostic?.message ?? "syntax error",
      diagnostic?.span ? spanFor(source, diagnostic.span.start, diagnostic.span.end) : undefined,
    );
  }
  return lowerProgram(adaptNode(source, result.tree));
}

function adaptNode(source: string, node: ParseNode): SyntaxNodeLike {
  if (node.kind === "rule") {
    return {
      type: node.name,
      text: source.slice(node.span.start, node.span.end),
      namedChildren: node.children.map((child) => adaptNode(source, child)),
    };
  }
  return {
    type: node.kind === "token" ? node.name : node.value,
    text: node.text,
    namedChildren: [],
  };
}

function spanFor(source: string, start: number, end: number): Span {
  let line = 1;
  let column = 1;
  for (let i = 0; i < start; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { start, end, line, column };
}
