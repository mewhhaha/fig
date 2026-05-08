import { parse as parseSyntax } from "../generated/baba-workbench/parser.ts";
import { lex, type Token } from "../generated/baba-workbench/tokenizer.ts";
import { fail } from "./diagnostics.ts";

type Item = TokenItem | CommentItem;
type BraceMode = "block" | "effectRow";

interface TokenItem {
  kind: "token";
  token: Token;
  text: string;
  line: number;
}

interface CommentItem {
  kind: "comment";
  text: string;
  line: number;
  hasBlankBefore: boolean;
  trailing: boolean;
  span: { start: number; end: number };
}

const binaryOperators = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "&&",
  "||",
  "^^",
  "<>",
  "<$>",
  "<*>",
  ">>=",
  "zip",
  "..",
]);

const compactBefore = new Set([")", "]", ",", ";", ".", ":"]);
const compactAfter = new Set(["(", "[", ".", "@", "\\"]);
const spacedSymbols = new Set(["=", "->", "=>"]);
const declarationKeywords = new Set(["pub", "fn", "type", "const", "let", "capability", "import"]);

export function formatSource(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lineStarts = computeLineStarts(normalized);
  const parsed = parseSyntax(normalized);
  if (!parsed.ok || !parsed.tree) {
    const diagnostic = parsed.diagnostics[0];
    fail(
      "parse.syntax",
      diagnostic?.message ?? "syntax error",
      diagnostic?.span
        ? spanFor(normalized, diagnostic.span.start, diagnostic.span.end)
        : undefined,
    );
  }

  const tokens = lex(normalized).filter((token) => token.kind !== "eof");
  const comments = scanComments(normalized, tokens, lineStarts);
  const items: Item[] = [
    ...tokens.map((token): TokenItem => ({
      kind: "token",
      token,
      text: normalizeTokenText(token),
      line: lineFor(lineStarts, token.span.start),
    })),
    ...comments,
  ].sort((a, b) => startOf(a) - startOf(b));

  const writer = new Writer();
  let previousToken: TokenItem | undefined;
  const braceModes: BraceMode[] = [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.kind === "comment") {
      if (item.trailing && !writer.atLineStart()) {
        writer.space();
        writer.raw(item.text);
        writer.newline();
      } else {
        if (!writer.atLineStart()) writer.newline();
        if (item.hasBlankBefore) writer.blankLine();
        writer.lineStart();
        writer.raw(item.text);
        writer.newline();
      }
      previousToken = undefined;
      continue;
    }

    const token = item;
    const closingEffectRowBrace = token.text === "}" && braceModes.at(-1) === "effectRow";
    if (token.text === "}" && !closingEffectRowBrace) {
      if (!writer.atLineStart()) writer.newline();
      writer.dedent();
      writer.lineStart();
    } else if (previousToken) {
      separate(writer, previousToken, token, braceModes.at(-1));
    } else {
      writer.lineStart();
    }

    writer.raw(token.text);

    if (token.text === "{") {
      const mode: BraceMode = previousToken?.text === "!" ? "effectRow" : "block";
      braceModes.push(mode);
      if (mode === "block") {
        writer.indent();
        writer.newline();
        previousToken = undefined;
      } else {
        previousToken = token;
      }
      continue;
    }
    if (token.text === ";" && !nextItemIsTrailingComment(items, index, token.line)) {
      writer.newline();
      previousToken = undefined;
      continue;
    }
    if (token.text === "}") {
      braceModes.pop();
      if (nextStartsDeclaration(items, item)) writer.blankLine();
    }

    previousToken = token;
  }

  return `${writer.finish().replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function isFormatted(source: string): boolean {
  return source === formatSource(source);
}

function separate(writer: Writer, left: TokenItem, right: TokenItem, braceMode?: BraceMode): void {
  if (right.text === "}") return;
  if (startsEffectRow(left, right)) return;
  if (braceMode === "effectRow" && left.text === "{") return;
  if (isRepeatPrefix(left.token)) return;
  if (left.text === ",") {
    writer.space();
    return;
  }
  if (right.text === "[" && opensBracketWithoutSpace(left)) return;
  if (left.text === "{" || left.text === ";") {
    writer.newline();
    return;
  }
  if (left.text === "}" && declarationKeywords.has(right.text)) {
    writer.blankLine();
    return;
  }
  if (right.text === "(" && opensParenWithoutSpace(left)) return;
  if (compactBefore.has(right.text) || compactAfter.has(left.text)) return;
  if (spacedSymbols.has(left.text) || spacedSymbols.has(right.text)) {
    writer.space();
    return;
  }
  if (binaryOperators.has(left.text) || binaryOperators.has(right.text)) {
    writer.space();
    return;
  }
  writer.space();
}

function startsEffectRow(left: TokenItem, right: TokenItem): boolean {
  return left.text === "!" && (right.text === "{" || right.text === "{}");
}

function opensBracketWithoutSpace(left: TokenItem): boolean {
  if (left.text === "=" || left.text === "=>" || left.text === ":") return false;
  if (startsProductConstructor(left)) return false;
  return isIndexOrCallBracket(left) || isShapeLiteralBracket(left) || isStaticForBracket(left);
}

function opensParenWithoutSpace(left: TokenItem): boolean {
  return left.text !== "in" && left.text !== "..";
}

function startsProductConstructor(left: TokenItem): boolean {
  return left.token.kind === "PascalIdent";
}

function isIndexOrCallBracket(left: TokenItem): boolean {
  return left.text !== "";
}

function isShapeLiteralBracket(_left: TokenItem): boolean {
  return true;
}

function isStaticForBracket(_left: TokenItem): boolean {
  return true;
}

function normalizeTokenText(token: Token): string {
  if (isRepeatPrefix(token)) return token.text.replace(/\s+/g, "");
  return token.text;
}

function isRepeatPrefix(token: Token): boolean {
  return token.kind.endsWith("Repeat") || token.kind === "TypeRepeatPrefix";
}

function scanComments(source: string, tokens: Token[], lineStarts: number[]): CommentItem[] {
  const byLineCode = new Map<number, Token[]>();
  for (const token of tokens) {
    const line = lineFor(lineStarts, token.span.start);
    const list = byLineCode.get(line) ?? [];
    list.push(token);
    byLineCode.set(line, list);
  }

  const comments: CommentItem[] = [];
  const pattern = /\/\/[^\n]*/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (insideLiteral(tokens, start)) continue;
    const end = start + match[0].length;
    const line = lineFor(lineStarts, start);
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const before = source.slice(lineStart, start);
    comments.push({
      kind: "comment",
      text: match[0],
      line,
      hasBlankBefore: hasBlankLineBefore(source, lineStart),
      trailing: /\S/.test(before) &&
        (byLineCode.get(line)?.some((token) => token.span.end <= start) ?? false),
      span: { start, end },
    });
  }
  return comments;
}

function insideLiteral(tokens: Token[], offset: number): boolean {
  return tokens.some((token) =>
    (token.kind === "String" || token.kind === "Char" || token.kind === "string" ||
      token.kind === "char" || token.kind === "fenced_text" || token.kind === "fenced_template") &&
    token.span.start < offset && offset < token.span.end
  );
}

function hasBlankLineBefore(source: string, lineStart: number): boolean {
  if (lineStart === 0) return false;
  const previousEnd = lineStart - 1;
  const previousStart = source.lastIndexOf("\n", previousEnd - 1) + 1;
  return source.slice(previousStart, previousEnd).trim() === "";
}

function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineFor(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function startOf(item: Item): number {
  return item.kind === "token" ? item.token.span.start : item.span.start;
}

function nextStartsDeclaration(items: Item[], current: TokenItem): boolean {
  const index = items.indexOf(current);
  const next = items.slice(index + 1).find((item) => item.kind === "token") as
    | TokenItem
    | undefined;
  return !!next && declarationKeywords.has(next.text);
}

function nextItemIsTrailingComment(items: Item[], index: number, line: number): boolean {
  const next = items[index + 1];
  return next?.kind === "comment" && next.trailing && next.line === line;
}

function spanFor(source: string, start: number, end: number) {
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

class Writer {
  private chunks: string[] = [];
  private level = 0;
  private lineFresh = true;
  private tail = "";

  indent(): void {
    this.level++;
  }

  dedent(): void {
    this.level = Math.max(0, this.level - 1);
  }

  atLineStart(): boolean {
    return this.lineFresh;
  }

  lineStart(): void {
    if (!this.lineFresh) return;
    this.push("  ".repeat(this.level));
    this.lineFresh = false;
  }

  raw(text: string): void {
    this.lineStart();
    this.push(text);
  }

  space(): void {
    if (!this.lineFresh && !this.peekEndsWith(" ") && !this.peekEndsWith("\n")) this.push(" ");
  }

  newline(): void {
    while (this.peekEndsWith(" ")) this.trimLastCharacter();
    if (!this.peekEndsWith("\n")) this.push("\n");
    this.lineFresh = true;
  }

  blankLine(): void {
    this.newline();
    if (!this.peekEndsWith("\n\n")) this.push("\n");
    this.lineFresh = true;
  }

  finish(): string {
    return this.chunks.join("");
  }

  private peekEndsWith(text: string): boolean {
    return this.tail.endsWith(text);
  }

  private push(text: string): void {
    if (!text) return;
    this.chunks.push(text);
    this.tail = `${this.tail}${text}`.slice(-8);
  }

  private trimLastCharacter(): void {
    const last = this.chunks.at(-1);
    if (!last) return;
    if (last.length === 1) this.chunks.pop();
    else this.chunks[this.chunks.length - 1] = last.slice(0, -1);
    this.tail = this.chunks.join("").slice(-8);
  }
}
