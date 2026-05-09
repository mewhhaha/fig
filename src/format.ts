import { parse as parseSyntax, type ParseNode, type RuleParseNode } from "../generated/baba-workbench/parser.ts";
import { lex, type Token } from "../generated/baba-workbench/tokenizer.ts";
import { fail } from "./diagnostics.ts";

type Item = TokenItem | CommentItem;
type BraceMode = "block" | "effectRow";
type Delimiter = "(" | "[" | "{" | "<";
type TopLevelDeclKind = "ConstDecl" | "TopLetDecl" | "FnDecl" | "TypeFnDecl";

const MAX_LINE_WIDTH = 100;

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
  const importDecls = collectImportBindingDecls(parsed.tree);
  const topLevelDecls = collectTopLevelDecls(parsed.tree, normalized);
  const topLevelDeclByStart = new Map(topLevelDecls.map((decl) => [decl.start, decl]));
  let skippedThrough = -1;

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
  const matchBraceStarts = collectMatchBraceStarts(items);
  const collectionDelimiterStarts = collectCollectionDelimiterStarts(parsed.tree);

  const writer = new Writer();
  let previousToken: TokenItem | undefined;
  let previousTopLevelDecl: TopLevelDecl | undefined;
  const braceModes: BraceMode[] = [];
  const delimiterContexts: DelimiterContext[] = [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (startOf(item) < skippedThrough) continue;
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
    const topLevelDecl = topLevelDeclByStart.get(token.token.span.start);
    const importDecl = importDecls.get(token.token.span.start);
    if (importDecl) {
      if (previousToken) {
        separate(writer, previousToken, token, {
          braceMode: braceModes.at(-1),
          delimiterContext: delimiterContexts.at(-1),
          topLevel: braceModes.length === 0 && delimiterContexts.length === 0,
          previousTopLevelDecl,
          nextTopLevelDecl: topLevelDecl,
          items,
          rightIndex: index,
        });
      } else {
        writer.lineStart();
      }
      writer.raw(importDecl.text);
      skippedThrough = importDecl.end;
      previousToken = { ...token, text: ";", line: token.line };
      previousTopLevelDecl = topLevelDecl;
      continue;
    }
    const closingEffectRowBrace = token.text === "}" && braceModes.at(-1) === "effectRow";
    const closingDelimiter = delimiterContexts.at(-1);
    if (
      closingDelimiter && (token.text === ")" || token.text === "]" || token.text === ">") &&
      closingDelimiter.delimiter === matchingOpen(token.text) &&
      closingDelimiter.broken
    ) {
      if (!writer.atLineStart()) writer.newline();
      writer.dedent();
      writer.lineStart();
    }
    if (token.text === "}" && !closingEffectRowBrace) {
      if (!writer.atLineStart()) writer.newline();
      writer.dedent();
      writer.lineStart();
    } else if (previousToken) {
      separate(writer, previousToken, token, {
        braceMode: braceModes.at(-1),
        delimiterContext: delimiterContexts.at(-1),
        topLevel: braceModes.length === 0 && delimiterContexts.length === 0,
        previousTopLevelDecl,
        nextTopLevelDecl: topLevelDecl,
        items,
        rightIndex: index,
      });
    } else {
      writer.lineStart();
    }

    writer.raw(token.text);

    if (token.text === "{") {
      const mode: BraceMode = previousToken?.text === "!" ? "effectRow" : "block";
      braceModes.push(mode);
      if (mode === "block") {
        const shouldBreak = matchBraceStarts.has(token.token.span.start) || groupWouldOverflow(writer, items, index);
        delimiterContexts.push({
          delimiter: token.text,
          broken: shouldBreak,
          indented: true,
        });
        writer.indent();
        writer.newline();
        previousToken = undefined;
      } else {
        previousToken = token;
      }
      continue;
    }
    if (token.text === "(" || token.text === "[" || (token.text === "<" && collectionDelimiterStarts.has(token.token.span.start))) {
      const shouldBreak = groupWouldOverflow(writer, items, index);
      delimiterContexts.push({
        delimiter: token.text,
        broken: shouldBreak,
        indented: shouldBreak,
      });
      if (shouldBreak) writer.breakAfterOpenDelimiter();
    }
    if (token.text === ")" || token.text === "]" || (token.text === ">" && closingDelimiter?.delimiter === "<")) {
      delimiterContexts.pop();
    }
    if (token.text === ";" && !nextItemIsTrailingComment(items, index, token.line)) {
      if (
        braceModes.length === 0 && delimiterContexts.length === 0 &&
        nextStartsTopLevelItem(items, index) &&
        shouldBlankBeforeNextTopLevelDecl(previousTopLevelDecl, nextTopLevelDecl(items, index, topLevelDeclByStart))
      ) {
        writer.blankLine();
      } else if (
        braceModes.at(-1) === "block" && delimiterContexts.length === 0 &&
        hasFinalExpressionBeforeBlockClose(items, index)
      ) {
        writer.newline();
      } else {
        writer.newline();
      }
      previousToken = undefined;
      continue;
    }
    if (token.text === "}" && !closingEffectRowBrace) {
      braceModes.pop();
      delimiterContexts.pop();
      if (braceModes.length === 0 && delimiterContexts.length === 0) {
        const nextDecl = nextTopLevelDecl(items, index, topLevelDeclByStart);
        if (shouldBlankBeforeNextTopLevelDecl(previousTopLevelDecl, nextDecl)) writer.blankLine();
        else if (nextDecl) writer.newline();
      } else if (nextStartsDeclaration(items, item)) writer.blankLine();
    } else if (token.text === "}") {
      braceModes.pop();
    }

    if (topLevelDecl) previousTopLevelDecl = topLevelDecl;
    previousToken = token;
  }

  const formatted = writer.finish()
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
  return `${formatted.trimEnd()}\n`;
}

export function isFormatted(source: string): boolean {
  return source === formatSource(source);
}

interface DelimiterContext {
  delimiter: Delimiter;
  broken: boolean;
  indented: boolean;
}

interface SeparateContext {
  braceMode?: BraceMode;
  delimiterContext?: DelimiterContext;
  topLevel?: boolean;
  previousTopLevelDecl?: TopLevelDecl;
  nextTopLevelDecl?: TopLevelDecl;
  items?: Item[];
  rightIndex?: number;
}

interface ImportBindingDecl {
  end: number;
  text: string;
}

interface TopLevelDecl {
  kind: TopLevelDeclKind;
  start: number;
  end: number;
  fnName?: string;
}

function collectImportBindingDecls(root: RuleParseNode | null): Map<number, ImportBindingDecl> {
  const result = new Map<number, ImportBindingDecl>();
  if (!root) return result;
  for (const decl of descendantRules(root, "ConstDecl")) {
    const bindingList = descendantRules(decl, "ImportBindingList")[0];
    const stringToken = descendantTokens(decl, "String")[0];
    if (!bindingList || !stringToken || !containsImportBuiltin(decl)) continue;
    const names = descendantTokens(bindingList, "LowerIdent").map((item) => item.text);
    result.set(decl.span.start, {
      end: decl.span.end,
      text: `const { ${names.join(", ")} } = @import(${stringToken.text});`,
    });
  }
  return result;
}

function collectTopLevelDecls(root: RuleParseNode | null, source: string): TopLevelDecl[] {
  if (!root) return [];
  return root.children
    .filter((child): child is RuleParseNode => child.kind === "rule" && child.name === "Decl")
    .map((decl) => decl.children.find((child): child is RuleParseNode =>
      child.kind === "rule" &&
      (child.name === "ConstDecl" || child.name === "TopLetDecl" || child.name === "FnDecl" ||
        child.name === "TypeFnDecl")
    ))
    .filter((decl): decl is RuleParseNode => !!decl)
    .map((decl): TopLevelDecl => ({
      kind: decl.name as TopLevelDeclKind,
      start: decl.span.start,
      end: decl.span.end,
      fnName: decl.name === "FnDecl" ? topLevelFnName(decl, source) : undefined,
    }));
}

function collectCollectionDelimiterStarts(root: RuleParseNode | null): Set<number> {
  const starts = new Set<number>();
  if (!root) return starts;
  for (const node of descendantRules(root, "CollectionValue")) {
    starts.add(node.span.start);
  }
  return starts;
}

function topLevelFnName(decl: RuleParseNode, source: string): string | undefined {
  const fnName = descendantRules(decl, "FnName")[0];
  return fnName ? source.slice(fnName.span.start, fnName.span.end).replace(/\s+/g, "") : undefined;
}

function containsImportBuiltin(node: ParseNode): boolean {
  return descendantTokens(node, "import").length > 0 ||
    descendants(node).some((child) => child.kind === "literal" && child.value === "import");
}

function descendantRules(node: ParseNode, name: string): RuleParseNode[] {
  return descendants(node).filter((child): child is RuleParseNode =>
    child.kind === "rule" && child.name === name
  );
}

function descendantTokens(node: ParseNode, name: string): Extract<ParseNode, { kind: "token" }>[] {
  return descendants(node).filter((child): child is Extract<ParseNode, { kind: "token" }> =>
    child.kind === "token" && child.name === name
  );
}

function descendants(node: ParseNode): ParseNode[] {
  if (node.kind !== "rule") return [];
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function separate(
  writer: Writer,
  left: TokenItem,
  right: TokenItem,
  context: SeparateContext = {},
): void {
  const {
    braceMode,
    delimiterContext,
    topLevel,
    previousTopLevelDecl,
    nextTopLevelDecl,
    items,
    rightIndex,
  } = context;
  if (right.text === "}") return;
  if (startsEffectRow(left, right)) return;
  if (braceMode === "effectRow" && left.text === "{") {
    return;
  }
  if (isRepeatPrefix(left.token)) return;
  if (topLevel && nextTopLevelDecl) {
    if (shouldBlankBeforeNextTopLevelDecl(previousTopLevelDecl, nextTopLevelDecl)) {
      writer.blankLine();
    } else if (previousTopLevelDecl) {
      writer.newline();
    }
    return;
  }
  if (left.text === ",") {
    if (
      delimiterContext?.broken || writer.currentColumn() > 55 ||
      writer.wouldOverflow(` ${right.text}`)
    ) {
      if (delimiterContext && !delimiterContext.indented) {
        writer.indent();
        delimiterContext.indented = true;
      }
      writer.softLineBreak();
      if (delimiterContext) delimiterContext.broken = true;
    } else {
      writer.space();
    }
    return;
  }
  if ((left.text === "(" || left.text === "[") && writer.wouldOverflow(right.text)) {
    writer.breakAfterOpenDelimiter();
    if (delimiterContext) delimiterContext.broken = true;
    if (delimiterContext) delimiterContext.indented = true;
    return;
  }
  if (delimiterContext?.delimiter === "<" && (left.text === "<" || right.text === ">")) return;
  if (right.text === "[" && opensBracketWithoutSpace(left)) return;
  if (left.text === "{" || left.text === ";") {
    writer.newline();
    return;
  }
  if (right.line > left.line && declarationKeywords.has(right.text)) {
    writer.newline();
    return;
  }
  if (left.text === "}" && declarationKeywords.has(right.text)) {
    writer.blankLine();
    return;
  }
  if (right.text === "(" && opensParenWithoutSpace(left)) return;
  if (
    right.text === "." &&
    (writer.currentColumn() > 80 ||
      (items && rightIndex !== undefined && callChainWouldBreak(writer, items, rightIndex)))
  ) {
    writer.continuationLineBreak();
    return;
  }
  if (compactBefore.has(right.text) || compactAfter.has(left.text)) return;
  if (spacedSymbols.has(left.text) || spacedSymbols.has(right.text)) {
    if (writer.wouldOverflow(` ${right.text}`)) {
      writer.continuationLineBreak();
      return;
    }
    writer.space();
    return;
  }
  if (binaryOperators.has(left.text) || binaryOperators.has(right.text)) {
    if (
      shouldBreakBefore(right) &&
      (writer.currentColumn() > 55 || writer.wouldOverflow(` ${right.text}`) ||
        (items && rightIndex !== undefined && binaryChainWouldBreak(writer, items, rightIndex)))
    ) {
      writer.continuationLineBreak();
      return;
    }
    writer.space();
    return;
  }
  if (
    right.text === "\\" &&
    (writer.wouldOverflow(` ${right.text}`) ||
      (items && rightIndex !== undefined && pipeChainWouldBreak(writer, items, rightIndex)))
  ) {
    writer.continuationLineBreak();
    return;
  }
  if (writer.wouldOverflow(` ${right.text}`)) {
    writer.continuationLineBreak();
    return;
  }
  writer.space();
}

function shouldBreakBefore(token: TokenItem): boolean {
  return binaryOperators.has(token.text) || token.text === "\\";
}

function matchingOpen(close: string): Delimiter | undefined {
  if (close === ")") return "(";
  if (close === "]") return "[";
  if (close === "}") return "{";
  if (close === ">") return "<";
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

function nextStartsTopLevelItem(items: Item[], index: number): boolean {
  const next = items.slice(index + 1).find((item) => item.kind === "token") as
    | TokenItem
    | undefined;
  return !!next &&
    (next.text === "const" || next.text === "pub" || next.text === "fn" || next.text === "type");
}

function nextTopLevelDecl(
  items: Item[],
  index: number,
  declsByStart: Map<number, TopLevelDecl>,
): TopLevelDecl | undefined {
  const next = items.slice(index + 1).find((item) =>
    item.kind === "token" && declsByStart.has(item.token.span.start)
  ) as TokenItem | undefined;
  return next ? declsByStart.get(next.token.span.start) : undefined;
}

function shouldBlankBeforeNextTopLevelDecl(
  previous: TopLevelDecl | undefined,
  next: TopLevelDecl | undefined,
): boolean {
  if (!previous || !next) return false;
  if (previous.kind === "ConstDecl" && next.kind === "ConstDecl") return false;
  if (previous.kind === "FnDecl" && next.kind === "FnDecl" && previous.fnName === next.fnName) {
    return false;
  }
  return true;
}

function hasFinalExpressionBeforeBlockClose(items: Item[], semicolonIndex: number): boolean {
  let braceDepth = 0;
  let delimiterDepth = 0;
  let sawToken = false;

  for (let index = semicolonIndex + 1; index < items.length; index++) {
    const item = items[index];
    if (item.kind !== "token") continue;

    if (delimiterDepth === 0 && braceDepth === 0) {
      if (item.text === "}") return sawToken;
      if (item.text === ";") return false;
    }

    if (item.text === "(" || item.text === "[") delimiterDepth++;
    else if ((item.text === ")" || item.text === "]") && delimiterDepth > 0) delimiterDepth--;
    else if (delimiterDepth === 0 && item.text === "{") braceDepth++;
    else if (delimiterDepth === 0 && item.text === "}") {
      if (braceDepth === 0) return sawToken;
      braceDepth--;
    }

    if (braceDepth === 0 && delimiterDepth === 0) sawToken = true;
  }

  return false;
}

function collectMatchBraceStarts(items: Item[]): Set<number> {
  const starts = new Set<number>();
  const pendingMatchDepths: number[] = [];
  let depth = 0;

  for (const item of items) {
    if (item.kind !== "token") continue;

    if (item.text === "match") {
      pendingMatchDepths.push(depth);
      continue;
    }

    if (item.text === "{") {
      const pendingIndex = pendingMatchDepths.lastIndexOf(depth);
      if (pendingIndex !== -1) {
        starts.add(item.token.span.start);
        pendingMatchDepths.splice(pendingIndex, 1);
      }
      depth++;
      continue;
    }

    if (item.text === "(" || item.text === "[") {
      depth++;
      continue;
    }

    if (item.text === ")" || item.text === "]" || item.text === "}") {
      if (depth > 0) depth--;
      for (let index = pendingMatchDepths.length - 1; index >= 0; index--) {
        if (pendingMatchDepths[index] > depth) pendingMatchDepths.splice(index, 1);
      }
      continue;
    }

    if (item.text === ";" || item.text === "," || item.text === "=>") {
      for (let index = pendingMatchDepths.length - 1; index >= 0; index--) {
        if (pendingMatchDepths[index] >= depth) pendingMatchDepths.splice(index, 1);
      }
    }
  }

  return starts;
}

function groupWouldOverflow(writer: Writer, items: Item[], openIndex: number): boolean {
  const open = items[openIndex];
  if (open?.kind !== "token" || (open.text !== "(" && open.text !== "[" && open.text !== "{")) {
    return false;
  }

  const close = open.text === "(" ? ")" : open.text === "[" ? "]" : "}";
  let depth = 0;
  let hasComma = false;
  let hasTopLevelField = false;
  let flatLength = 0;
  let previous: TokenItem | undefined;

  for (let index = openIndex + 1; index < items.length; index++) {
    const item = items[index];
    if (item.kind === "comment") return false;

    if (item.text === close) {
      if (depth === 0) {
        flatLength += item.text.length;
        return hasComma && (open.text !== "{" || hasTopLevelField) &&
          (writer.wouldOverflow(" ".repeat(flatLength)) ||
            (open.text !== "{" && writer.currentColumn() + flatLength > 55));
      }
      depth--;
    } else if (item.text === "(" || item.text === "[" || item.text === "{") {
      depth++;
    } else if ((item.text === ")" || item.text === "]" || item.text === "}") && depth > 0) {
      depth--;
    }

    if (item.text === "," && depth === 0) hasComma = true;
    if (item.text === ":" && depth === 0) hasTopLevelField = true;
    if (previous) flatLength += flatSeparatorLength(previous, item);
    flatLength += item.text.length;
    previous = item;
  }

  return false;
}

function flatSeparatorLength(left: TokenItem, right: TokenItem): number {
  if (
    right.text === "]" || right.text === ")" || right.text === "," || right.text === "." ||
    right.text === ":"
  ) {
    return 0;
  }
  if (
    left.text === "(" || left.text === "[" || left.text === "." || left.text === "@" ||
    left.text === "\\"
  ) {
    return 0;
  }
  return 1;
}

function pipeChainWouldBreak(writer: Writer, items: Item[], slashIndex: number): boolean {
  const slash = items[slashIndex];
  if (slash?.kind !== "token" || slash.text !== "\\") return false;

  let depth = 0;
  let flatLength = 0;
  let previous: TokenItem | undefined;

  for (let index = slashIndex; index < items.length; index++) {
    const item = items[index];
    if (item.kind === "comment") return true;

    if (depth === 0 && index > slashIndex && (item.text === ";" || item.text === "}")) break;

    if (previous) flatLength += flatSeparatorLength(previous, item);
    flatLength += item.text.length;
    previous = item;

    if (item.text === "(" || item.text === "[" || item.text === "{") depth++;
    else if ((item.text === ")" || item.text === "]" || item.text === "}") && depth > 0) depth--;
  }

  return writer.currentColumn() + flatLength > 55 || writer.wouldOverflow(" ".repeat(flatLength));
}

function callChainWouldBreak(writer: Writer, items: Item[], dotIndex: number): boolean {
  const dot = items[dotIndex];
  if (dot?.kind !== "token" || dot.text !== ".") return false;

  const startIndex = callChainStart(items, dotIndex);
  let depth = 0;
  let flatLength = 0;
  let callCount = 0;
  let previous: TokenItem | undefined;

  for (let index = startIndex; index < items.length; index++) {
    const item = items[index];
    if (item.kind === "comment") break;

    if (
      depth === 0 && index > startIndex &&
      (item.text === ";" || item.text === "," || item.text === "{" || item.text === "}" || item.text === "=>" ||
        item.text === "->" || binaryOperators.has(item.text) || item.text === "\\")
    ) {
      break;
    }

    if (
      depth === 0 &&
      item.text === "(" &&
      index >= 2 &&
      items[index - 1]?.kind === "token" &&
      items[index - 2]?.kind === "token" &&
      (items[index - 2] as TokenItem).text === "."
    ) {
      callCount++;
    }

    if (previous) flatLength += flatSeparatorLength(previous, item);
    flatLength += item.text.length;
    previous = item;

    if (item.text === "(" || item.text === "[" || item.text === "{") depth++;
    else if ((item.text === ")" || item.text === "]" || item.text === "}") && depth > 0) depth--;
    else if (depth === 0 && (item.text === ")" || item.text === "]")) break;
  }

  return callCount > 1 &&
    (flatLength > 55 || writer.currentColumn() + flatLength > 55 ||
      writer.wouldOverflow(" ".repeat(flatLength)));
}

function callChainStart(items: Item[], dotIndex: number): number {
  let startIndex = dotIndex;
  let backwardDepth = 0;
  for (let index = dotIndex - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "comment") break;
    if (item.text === ")" || item.text === "]" || item.text === "}") backwardDepth++;
    else if ((item.text === "(" || item.text === "[" || item.text === "{") && backwardDepth > 0) backwardDepth--;
    else if (
      backwardDepth === 0 &&
      (item.text === ";" || item.text === "," || item.text === "{" || item.text === "=>" ||
        item.text === "->" || binaryOperators.has(item.text) || item.text === "\\")
    ) {
      break;
    }
    startIndex = index;
  }
  return startIndex;
}

function binaryChainWouldBreak(writer: Writer, items: Item[], operatorIndex: number): boolean {
  const operator = items[operatorIndex];
  if (operator?.kind !== "token" || !binaryOperators.has(operator.text)) return false;

  let startIndex = operatorIndex;
  let backwardDepth = 0;
  for (let index = operatorIndex - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === "comment") break;
    if (item.text === ")" || item.text === "]" || item.text === "}") backwardDepth++;
    else if ((item.text === "(" || item.text === "[" || item.text === "{") && backwardDepth > 0) backwardDepth--;
    else if (
      backwardDepth === 0 &&
      (item.text === ";" || item.text === "," || item.text === "{" || item.text === "=>" || item.text === "->")
    ) {
      break;
    }
    startIndex = index;
  }

  let depth = 0;
  let flatLength = 0;
  let operatorCount = 0;
  let previous: TokenItem | undefined;

  for (let index = startIndex; index < items.length; index++) {
    const item = items[index];
    if (item.kind === "comment") return true;

    if (depth === 0 && index > startIndex && (item.text === ";" || item.text === "," || item.text === "}")) {
      break;
    }
    if (item.text === "(" || item.text === "[" || item.text === "{") depth++;
    else if ((item.text === ")" || item.text === "]" || item.text === "}") && depth > 0) depth--;
    else if (depth === 0 && (item.text === ")" || item.text === "]")) break;

    if (depth === 0 && binaryOperators.has(item.text)) operatorCount++;
    if (previous) flatLength += flatSeparatorLength(previous, item);
    flatLength += item.text.length;
    previous = item;
  }

  return operatorCount > 1 && flatLength > 55;
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
  private column = 0;

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

  wouldOverflow(text: string): boolean {
    return !this.lineFresh && this.column + text.length > MAX_LINE_WIDTH;
  }

  currentColumn(): number {
    return this.column;
  }

  softLineBreak(): void {
    this.newline();
    this.lineStart();
  }

  continuationLineBreak(): void {
    this.newline();
    if (this.lineFresh) {
      this.push("  ".repeat(this.level + 1));
      this.lineFresh = false;
    }
  }

  breakAfterOpenDelimiter(): void {
    this.indent();
    this.newline();
    this.lineStart();
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
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) this.column += text.length;
    else this.column = text.length - lastNewline - 1;
  }

  private trimLastCharacter(): void {
    const last = this.chunks.at(-1);
    if (!last) return;
    if (last.length === 1) this.chunks.pop();
    else this.chunks[this.chunks.length - 1] = last.slice(0, -1);
    this.tail = this.chunks.join("").slice(-8);
    this.column = Math.max(0, this.column - 1);
  }
}
