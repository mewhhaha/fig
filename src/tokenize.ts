import {
  lex as generatedLex,
  type Token as GeneratedToken,
  type TokenKind,
} from "../generated/baba-workbench/tokenizer.ts";
import { fail, type Span } from "./diagnostics.ts";

export type GeneratedTokenKind =
  | "module"
  | "import"
  | "capability"
  | "type"
  | "const"
  | "fn"
  | "let"
  | "fork"
  | "match"
  | "pub"
  | "bool"
  | "zip"
  | "identifier"
  | "number"
  | "string"
  | "char"
  | "multiline"
  | "literalType"
  | "symbol";

export interface Token {
  kind: GeneratedTokenKind;
  text: string;
  span: Span;
}

export const lex = generatedLex;

export function tokenize(source: string): Token[] {
  try {
    return generatedLex(source).filter((token) => token.kind !== "eof").map((token) =>
      normalizeToken(source, token)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("parse.tokenize", message);
  }
}

function normalizeToken(source: string, token: GeneratedToken): Token {
  const textKind = token.kind === "keyword" ? token.text : token.kind;
  const kind = normalizeKind(textKind as TokenKind | string);
  return { kind, text: token.text, span: spanFor(source, token.span.start, token.span.end) };
}

function normalizeKind(kind: TokenKind | string): GeneratedTokenKind {
  if (kind === "Number" || kind === "number") return "number";
  if (kind === "String" || kind === "string") return "string";
  if (kind === "Char" || kind === "char") return "char";
  if (kind === "Bool" || kind === "bool") return "bool";
  if (kind === "true" || kind === "false") return "bool";
  if (kind === "Multiline" || kind === "fenced_text") return "multiline";
  if (kind === "LiteralType") return "literalType";
  if (
    kind === "Ident" || kind === "LowerIdent" || kind === "PascalIdent" || kind === "identifier"
  ) return "identifier";
  if (kind === "symbol") return "symbol";
  return kind as GeneratedTokenKind;
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
