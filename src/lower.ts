import type {
  CapabilityImport,
  ConstDecl,
  Declaration,
  DestructureLetDecl,
  Expr,
  FnDecl,
  ForkLetDecl,
  LetDecl,
  Param,
  ParamPattern,
  Program,
  ProofConstDecl,
  ShapeType,
  SourceImport,
  TypeBlock,
  TypeCountExpr,
  TypeDecl,
  TypeExpr,
  TypeMemberExpr,
  TypeParam,
  TypePattern,
  TypeResultKind,
  TypeShape,
} from "./core_ast.ts";
import { fail, type Span } from "./diagnostics.ts";
import type { SyntaxNodeLike } from "../generated/baba-workbench/ast/types.ts";
import { projectNode } from "../generated/baba-workbench/ast/visitor.ts";

type Node = SyntaxNodeLike & {
  namedChildren?: readonly Node[];
  children?: readonly Node[];
  startIndex?: number;
  endIndex?: number;
  startPosition?: { row: number; column: number };
};

export function lowerProgram(root: Node): Program {
  projectNode({ type: "Program", text: root.text });
  const children = named(root);
  const decls = children.filter(is("Decl"));
  const sourceImportConsts = decls.map(unwrap).filter(isSourceImportConst).map(
    lowerSourceImportConst,
  );
  const capabilityConstImports = decls.map(unwrap).filter(isCapabilityConst).map(
    lowerCapabilityConst,
  );
  const declarations = decls.filter((decl) => {
    const unwrapped = unwrap(decl);
    return !isSourceImportConst(unwrapped) && !isCapabilityConst(unwrapped);
  }).map(lowerDecl);
  declarations.push(...lowerInlineTypeMemberFns(declarations));
  return {
    moduleName: undefined,
    imports: capabilityConstImports,
    sourceImports: sourceImportConsts,
    declarations,
  };
}

function lowerCapabilityConst(node: Node): CapabilityImport {
  const nameNode = named(node).find((child) => isIdentifier(child) || isFieldName(child));
  const name = bindingName(nameNode);
  const type = only(node, "Type").text;
  const effects = optional(node, "EffectRow")
    ? named(only(node, "EffectRow")).filter(isIdentifier).map((id) => id.text)
    : [];
  return { kind: "import", name, type, effects };
}

function lowerSourceImportConst(node: Node): SourceImport {
  const alias = text(first(node, "LowerIdent"), "import alias");
  const match = node.text.match(/@\s*import\s*\(\s*("([^"\\]|\\.)*")\s*\)/);
  if (!match) fail("parse.lower", 'source import requires @import("specifier")', spanFor(node));
  const specifier = JSON.parse(match[1]);
  return { kind: "source_import", module: specifier, alias };
}

function isSourceImportConst(node: Node): boolean {
  return node.type === "ConstDecl" && /@\s*import\s*\(/.test(node.text);
}

function isCapabilityConst(node: Node): boolean {
  return node.type === "ConstDecl" && /@\s*capability\s*\(/.test(node.text);
}

function lowerDecl(node: Node): Declaration {
  const decl = unwrap(node);
  switch (decl.type) {
    case "TypeFnDecl":
      return lowerTypeDecl(decl);
    case "ConstDecl":
      return lowerConst(decl);
    case "FnDecl":
      return lowerFn(decl);
    case "TopLetDecl": {
      const lowered = lowerLet(decl);
      if (lowered.kind === "fork_let" || lowered.kind === "destructure_let") {
        fail(
          "parse.lower",
          "multi-binding let is only valid inside function bodies",
          spanFor(decl),
        );
      }
      return lowered;
    }
    default:
      return unreachable(decl, "declaration");
  }
}

function lowerConst(node: Node): ConstDecl | TypeDecl {
  const nameNode = named(node).find((child) => isIdentifier(child) || isFieldName(child));
  const constValue = only(node, "ConstValue");
  return {
    kind: "const",
    name: bindingName(nameNode),
    type: optional(node, "TypeAnn")
      ? only(only(node, "TypeAnn"), "Type").text
      : optional(node, "Type")?.text,
    value: lowerExpr(first(constValue, "Expr")),
  };
}

function lowerFn(node: Node): FnDecl {
  const fn = optional(node, "FnTail") ?? node;
  const loweredName = optional(node, "FnName")
    ? lowerFnName(only(node, "FnName"))
    : lowerFnName(only(fn, "FnName"));
  const returnType = optional(fn, "ReturnSig")
    ? named(only(fn, "ReturnSig")).find(is("Type"))?.text
    : undefined;
  if (returnType === "struct" || returnType === "union") {
    fail(
      "parse.lower",
      `${returnType} is only valid as a type-function result kind`,
      spanFor(only(fn, "ReturnSig")),
    );
  }
  return {
    kind: "fn",
    public: named(node).some(is("Visibility")),
    name: loweredName.name,
    ...(loweredName.memberOf ? { memberOf: loweredName.memberOf } : {}),
    params: optional(fn, "Params")
      ? named(only(fn, "Params")).filter(is("Param")).map(lowerParam)
      : [],
    returnType,
    effects: optional(fn, "EffectRow")
      ? named(only(fn, "EffectRow")).filter(isIdentifier).map((id) => id.text)
      : [],
    body: lowerBlock(only(fn, "Block")),
  };
}

function lowerFnName(node: Node): { name: string; memberOf?: { owner: string; member: string } } {
  const ids = named(node).filter(isIdentifier);
  const parts = ids.map((id) => id.text);
  const name = parts.join(".");
  if (parts.length < 2) return { name };
  const member = parts[parts.length - 1];
  const owner = parts.slice(0, -1).join(".");
  return { name, memberOf: { owner, member } };
}

function lowerTypeDecl(node: Node): TypeDecl {
  const ids = named(node).filter(isIdentifier);
  const name = text(ids[0], "type name");
  const params = optional(node, "TypeParamsDecl")
    ? named(only(node, "TypeParamsDecl")).filter(is("TypeParamDecl")).map(lowerTypeParam)
    : [];
  const paramPatterns = optional(node, "TypeParamsDecl")
    ? named(only(node, "TypeParamsDecl")).filter(is("TypeParamDecl")).map(lowerTypeParamPattern)
    : [];
  return {
    kind: "type",
    name,
    params,
    resultKind: lowerTypeResultKind(optional(node, "TypeResultSig")),
    ...(paramPatterns.some((pattern, index) =>
        pattern.kind !== "binding" || pattern.name !== params[index]?.name
      )
      ? { paramPatterns }
      : {}),
    body: lowerTypeBlock(only(node, "TypeBlock")),
  };
}

function lowerTypeResultKind(node: Node | undefined): TypeResultKind {
  if (!node) return "type";
  const kind = optional(node, "TypeResultKind")?.text.trim();
  return kind === "struct" || kind === "union" ? kind : "type";
}

function lowerTypeParam(node: Node): TypeParam {
  const kindNode = first(node, "TypeParamKind");
  const pattern = lowerTypeParamPattern(node);
  return {
    name: pattern.kind === "binding"
      ? pattern.name
      : `__type_pattern_${Math.abs(hashText(JSON.stringify(pattern)))}`,
    kind: text(kindNode, "type parameter kind").replace(/\s+/g, " ") as TypeParam["kind"],
  };
}

function lowerTypeParamPattern(node: Node): ParamPattern {
  const literal = optional(node, "Literal");
  if (literal) {
    const lowered = lowerLiteral(literal);
    if (
      lowered.kind === "literal" &&
      (lowered.literalKind === "number" || lowered.literalKind === "bool" ||
        lowered.literalKind === "string" || lowered.literalKind === "literalType")
    ) {
      return { kind: "literal", value: lowered.value, literalKind: lowered.literalKind };
    }
  }
  const field = optionalFieldName(node);
  const ident = named(node).find(isIdentifier);
  const name = field
    ? bindingName(field)
    : ident
    ? ident.text
    : node.text.trim().startsWith("_")
    ? "_"
    : "";
  if (name === "_") return { kind: "wildcard" };
  return knownTypeName(name) ? { kind: "type", name } : { kind: "binding", name };
}

function lowerTypeBlock(node: Node): TypeBlock {
  const statements = [];
  let expr: TypeExpr | undefined;
  for (const item of named(node).filter(is("TypeBlockItem"))) {
    const child = named(item)[0];
    if (child.type === "TypeLetDecl") {
      statements.push({
        kind: "type_let" as const,
        name: text(firstIdentifier(child), "type let name"),
        value: lowerTypeExpr(first(child, "TypeExpr")),
      });
    } else if (child.type === "TypeExpr") {
      if (item.text.trimEnd().endsWith(";")) {
        statements.push({
          kind: "type_let" as const,
          name: `__type_stmt_${statements.length}`,
          value: lowerTypeExpr(child),
        });
      } else {
        expr = lowerTypeExpr(child);
      }
    }
  }
  return { kind: "type_block", statements, expr };
}

function lowerShapeType(node: Node): ShapeType {
  return { slots: named(node).filter(is("ShapeSlot")).map(lowerShapeTypeSlot) };
}

function lowerShapeTypeSlot(node: Node): ShapeType["slots"][number] {
  const body = only(node, "ShapeSlotBody");
  const repeat = named(body)
    .find((child) => child.type === "CountRepeat" || isRepeatIdentifier(child))
    ?.text.replace(/\s*\*$/, "").trim();
  const slot: ShapeType["slots"][number] = {
    label: named(node).find(isFieldName)?.text.replace(/:\s*$/, "").trim(),
    type: optional(body, "Type")?.text ?? body.text,
  };
  if (repeat) slot.repeat = repeat;
  return slot;
}

function lowerTypeExpr(node: Node): TypeExpr {
  const expr = unwrapType(node);
  switch (expr.type) {
    case "TypeMatch": {
      const exprs = named(expr).filter(is("TypeExpr"));
      return {
        kind: "type_match",
        value: lowerTypeExpr(exprs[0]),
        arms: named(expr).filter(is("TypeArm")).map((arm) => ({
          pattern: lowerTypePattern(first(arm, "TypePattern")),
          value: lowerTypeExpr(first(arm, "TypeExpr")),
        })),
      };
    }
    case "TypeBinary": {
      const calls = named(expr).filter(is("TypeCall"));
      const ops = named(expr).filter(is("TypeOp"));
      let current = lowerTypeExpr(calls[0]);
      for (let index = 0; index < ops.length; index++) {
        current = {
          kind: "type_binary",
          op: ops[index].text,
          left: current,
          right: lowerTypeExpr(calls[index + 1]),
        };
      }
      return current;
    }
    case "TypeCall": {
      const children = named(expr);
      let callee = lowerTypeExpr(children[0]);
      for (const args of children.slice(1).filter(is("TypeExprArgs"))) {
        callee = {
          kind: "type_call",
          callee,
          args: named(args).filter(is("TypeExpr")).map(lowerTypeExpr),
        };
      }
      if (
        children[0]?.type === "TypePrimary" && isIdentifier(named(children[0])[0]) &&
        !children.some(is("TypeExprArgs")) && /\)\s*$/.test(expr.text)
      ) {
        return { kind: "type_call", callee, args: [] };
      }
      return callee;
    }
    case "FnType":
      return { kind: "type_fn", source: expr.text };
    case "Literal":
      return lowerTypeLiteral(expr);
    case "StaticBuiltin":
      return { kind: "type_static_ref", name: text(firstIdentifier(expr), "static builtin") };
    case "TypeShape":
      return { kind: "type_shape", shape: lowerTypeShape(expr) };
    case "TypeBuilderName":
      return { kind: "type_ref", name: expr.text };
    case "TypePrimary":
      if (optional(expr, "TypeQualifiedTail")) {
        return { kind: "type_ref", name: expr.text.replace(/\s+/g, "") };
      }
      return lowerTypeExpr(named(expr)[0]);
    case "Type":
      if (optional(expr, "TypeQualifiedTail")) {
        return { kind: "type_ref", name: expr.text.replace(/\s+/g, "") };
      }
      return lowerTypeExpr(named(expr)[0]);
    case "QualifiedTypeName":
      return { kind: "type_ref", name: expr.text.replace(/\s+/g, "") };
    case "LowerIdent":
    case "PascalIdent":
      return { kind: "type_ref", name: expr.text };
    default:
      return unreachable(expr, "type expression");
  }
}

function lowerTypeMember(node: Node): TypeMemberExpr {
  const fn = optional(node, "FnDecl");
  if (fn) {
    const lowered = lowerFn(fn);
    return {
      name: lowered.name,
      type: renderFnType(lowered),
      target: lowered.name,
      inlineFn: lowered,
    };
  }
  const value = lowerExpr(first(node, "Expr"));
  if (value.kind !== "var") {
    fail("parse.lower", "type member target must be a top-level function name", spanFor(node));
  }
  return {
    name: bindingName(firstFieldName(node)),
    type: first(node, "Type").text,
    target: value.name,
  };
}

function lowerInlineTypeMemberFns(declarations: Declaration[]): FnDecl[] {
  const generated: FnDecl[] = [];
  for (const decl of declarations) {
    if (decl.kind !== "type") continue;
    const visit = (expr: TypeExpr | undefined) => {
      if (!expr) return;
      const members = expr.kind === "type_shape" ? expr.shape.members : undefined;
      for (const member of members ?? []) {
        if (!member.inlineFn) continue;
        const fn = member.inlineFn;
        const target = `${decl.name}_${fn.name}`;
        member.target = target;
        generated.push({ ...fn, name: target, generated: true });
      }
    };
    visit(decl.body.expr);
    for (const stmt of decl.body.statements) visit(stmt.value);
  }
  return generated;
}

function renderFnType(fn: FnDecl): string {
  return `fn(${
    fn.params.map((param) => `${param.const ? "const " : ""}${param.name}: ${param.type}`).join(
      ", ",
    )
  }) -> ${fn.returnType ?? "type"}`;
}

function lowerTypePattern(node: Node): TypePattern {
  if (node.text.trim() === "_") return { kind: "wildcard" };
  const child = named(node)[0];
  if (!child) {
    return unreachable(node, "type pattern");
  }
  if (child.type === "Literal") return lowerTypeLiteralPattern(child);
  if (isIdentifier(child)) return { kind: "type", name: child.text };
  return unreachable(child, "type pattern");
}

function lowerTypeLiteral(node: Node): TypeExpr {
  const literal = named(node)[0] ?? node;
  if (literal.type === "Bool") return { kind: "type_bool", value: literal.text === "true" };
  if (literal.type === "String") return { kind: "type_string", value: JSON.parse(literal.text) };
  if (literal.type === "Multiline" || literal.type === "fenced_text") {
    return { kind: "type_string", value: multilineContents(literal.text) };
  }
  if (literal.type === "Number") return { kind: "type_number", value: literal.text };
  if (literal.type === "LiteralType") return { kind: "type_literal", value: literal.text.slice(1) };
  return unreachable(literal, "type literal");
}

function lowerTypeLiteralPattern(node: Node): TypePattern {
  const literal = named(node)[0] ?? node;
  if (literal.type === "Bool") return { kind: "bool", value: literal.text === "true" };
  if (literal.type === "LiteralType") return { kind: "literal", value: literal.text.slice(1) };
  if (literal.type === "String") return { kind: "string", value: JSON.parse(literal.text) };
  if (literal.type === "Number") return { kind: "number", value: literal.text };
  return unreachable(literal, "type literal pattern");
}

function lowerTypeShape(node: Node): TypeShape {
  return { slots: named(node).filter(is("TypeShapeSlot")).map(lowerTypeShapeSlot) };
}

function lowerTypeShapeSlot(node: Node): TypeShape["slots"][number] {
  const body = optional(node, "TypeShapeSlotBody") ?? only(node, "TypeShapeAnonSlotBody");
  const repeatNode = optional(body, "TypeShapeRepeat");
  return {
    label: named(node).find(isFieldName)?.text.replace(/:\s*$/, "").trim(),
    repeat: repeatNode ? lowerTypeRepeat(repeatNode) : undefined,
    type: lowerTypeExpr(optional(body, "TypeExpr") ?? first(body, "TypeNonFnExpr")),
  };
}

function lowerTypeRepeat(node: Node): TypeShape["slots"][number]["repeat"] {
  const parts = node.text.split("*").map((part) => part.trim()).filter(Boolean);
  let expr: TypeCountExpr = countAtom(parts[0]);
  for (const part of parts.slice(1)) {
    expr = { kind: "count_mul", left: expr, right: countAtom(part) };
  }
  return expr;
}

function countAtom(text: string): TypeCountExpr {
  if (/^[0-9]/.test(text)) {
    return { kind: "count_literal" as const, value: Number.parseInt(text, 10), source: text };
  }
  return { kind: "count_ref" as const, name: text };
}

function unwrapType(node: Node): Node {
  const children = named(node);
  if (
    ["TypeExpr", "TypeNonFnExpr", "TypePrimary", "TypeCall", "TypeBinary"].includes(node.type) &&
    children.length === 1
  ) {
    return unwrapType(children[0]);
  }
  return node;
}

function lowerParam(node: Node): Param {
  const patternNode = optional(node, "Pattern") ?? optional(node, "PatternIdent") ??
    optional(node, "Literal") ?? named(node).find((child) => child.text.trim() === "_");
  const nameNode = named(node).find((child) => child.type === "ParamName") ??
    named(node).find((child) => isIdentifier(child) || isFieldName(child));
  const pattern = patternNode ? lowerParamPattern(patternNode) : lowerNameParamPattern(nameNode);
  const name = paramBindingName(pattern, nameNode);
  return {
    name,
    type: optional(node, "Type")?.text ?? optional(node, "TypeAnn")?.text.replace(/^\s*:\s*/, "") ??
      "type",
    const: /^\s*const\b/.test(node.text) ? true : undefined,
    ...(pattern.kind !== "binding" || pattern.name !== name ? { pattern } : {}),
  };
}

function lowerNameParamPattern(node: Node | undefined): ParamPattern {
  const name = node?.type === "ParamName" ? bindingName(named(node)[0]) : bindingName(node);
  return name === "_" ? { kind: "wildcard" } : { kind: "binding", name };
}

function lowerParamPattern(node: Node): ParamPattern {
  const source = node.text.trim();
  if (source === "_") return { kind: "wildcard" };
  const child = named(node)[0];
  if (!child) return { kind: "wildcard" };
  if (node.type === "Literal" || child.type === "Literal") {
    const literal = lowerLiteral(node.type === "Literal" ? node : child);
    if (literal.kind !== "literal") return { kind: "wildcard" };
    if (
      literal.literalKind === "number" || literal.literalKind === "bool" ||
      literal.literalKind === "string" || literal.literalKind === "literalType"
    ) {
      return { kind: "literal", value: literal.value, literalKind: literal.literalKind };
    }
  }
  if (node.type === "PatternIdent" || child.type === "PatternIdent") {
    const patternIdent = node.type === "PatternIdent" ? node : child;
    const ident = firstIdentifier(patternIdent).text;
    const args = optional(patternIdent, "Args")
      ? named(only(patternIdent, "Args")).filter(is("Expr")).map((expr) =>
        expr.text.trim() === "_"
          ? { kind: "wildcard" as const }
          : /^[A-Za-z_][A-Za-z0-9_]*$/.test(expr.text.trim())
          ? { kind: "binding" as const, name: expr.text.trim() }
          : lowerParamPattern({ ...expr, type: "Pattern" })
      )
      : undefined;
    if (args) return { kind: "constructor", name: ident, args };
    return ident === "_" ? { kind: "wildcard" } : { kind: "binding", name: ident };
  }
  return { kind: "binding", name: source };
}

function paramBindingName(pattern: ParamPattern, fallback: Node | undefined): string {
  if (pattern.kind === "binding") return pattern.name;
  const fallbackName = fallback
    ? fallback.type === "ParamName" ? bindingName(named(fallback)[0]) : bindingName(fallback)
    : "";
  return fallbackName && fallbackName !== "_"
    ? fallbackName
    : `__pattern_${Math.abs(hashText(JSON.stringify(pattern)))}`;
}

function knownTypeName(name: string): boolean {
  return ["type", "bool", "string", "i32", "u32", "i64", "u64", "f32", "f64"].includes(name) ||
    /^u([1-9]|[1-5][0-9]|6[0-4])$/.test(name);
}

function hashText(source: string): number {
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) | 0;
  return hash;
}

function lowerLet(node: Node): LetDecl | ForkLetDecl | DestructureLetDecl {
  const ids = named(node).filter((child) => isIdentifier(child) || isFieldName(child));
  const tail = optional(node, "TopLetTail") ?? optional(node, "BlockLetTail") ?? node;
  const tailIds = named(tail).filter(isIdentifier);
  const names = [...ids, ...tailIds].map(bindingName);
  if (names.length > 1) {
    const expr = lowerExpr(only(tail, "Expr"));
    if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === "fork") {
      if (expr.args.length !== 1 || expr.args[0].kind !== "var") {
        fail("parse.lower", "fork(...) source must be a binding name", spanFor(node));
      }
      return { kind: "fork_let", names, source: expr.args[0].name };
    }
    return { kind: "destructure_let", names, value: expr };
  }
  return {
    kind: "let",
    name: bindingName(ids[0]),
    type: named(tail).find(is("Type"))?.text,
    value: lowerExpr(only(tail, "Expr")),
  };
}

function lowerProofConst(node: Node): ProofConstDecl {
  const name = text(first(node, "PascalIdent"), "proof const name");
  return {
    kind: "proof_const",
    name,
    value: lowerTypeExpr(first(node, "TypeExpr")),
  };
}

function lowerBlock(node: Node): Extract<Expr, { kind: "block" }> {
  const statements: Array<LetDecl | ForkLetDecl | DestructureLetDecl | ProofConstDecl> = [];
  let expr: Expr | undefined;
  for (const child of named(node)) {
    if (child.type === "BlockLetDecl") {
      statements.push(lowerLet(child));
    } else if (child.type === "BlockStmt") {
      const stmt = named(child)[0];
      if (stmt.type === "BlockLetDecl") statements.push(lowerLet(stmt));
      else if (stmt.type === "BlockProofConstDecl") statements.push(lowerProofConst(stmt));
    } else if (child.type === "BlockProofConstDecl") {
      statements.push(lowerProofConst(child));
    } else if (child.type === "Expr") {
      expr = lowerExpr(child);
    }
  }
  return { kind: "block", statements, expr };
}

function lowerExpr(node: Node): Expr {
  const expr = unwrap(node);
  switch (expr.type) {
    case "MatchExpr": {
      const value = first(expr, "Expr");
      const arms = named(expr).filter(is("Arm")).map((arm) => {
        const armExpr = first(arm, "Expr");
        return { pattern: first(arm, "Pattern").text, value: lowerExpr(armExpr) };
      });
      return { kind: "match", value: lowerExpr(value), arms };
    }
    case "PipeBind":
      return lowerPipeBind(expr);
    case "PipeBindAtom":
      return lowerExpr(named(expr)[0]);
    case "Binary":
      return lowerBinary(expr);
    case "Call":
      return lowerCall(expr);
    case "Primary":
      return lowerPrimary(expr);
    case "Block":
      return lowerBlock(expr);
    default:
      return unreachable(expr, "expression");
  }
}

function lowerBinary(node: Node): Expr {
  const parts = named(node);
  let left = lowerCall(parts[0]);
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i].text;
    const right = lowerCall(parts[i + 1]);
    left = op === ".." ? { kind: "range", start: left, end: right } : {
      kind: "binary",
      op,
      left,
      right,
    };
  }
  return left;
}

function lowerPipeBind(node: Node): Expr {
  const children = named(node);
  let current = lowerExpr(first(node, "PipeBindAtom"));
  for (let index = 0; index < children.length; index++) {
    const name = children[index];
    if (name.type !== "PipeBindName") continue;
    const body = children.slice(index + 1).find(is("PipeBindAtom"));
    if (!body) return current;
    const bindName = text(named(name)[0] ?? name, "pipe bind name");
    current = {
      kind: "pipe_bind",
      value: current,
      name: bindName,
      body: lowerPipeBindBody(body, bindName),
    };
  }
  return current;
}

function lowerPipeBindBody(node: Node, bindName: string): Expr {
  const body = lowerExpr(node);
  return bindName === "$" ? bindDollarPlaceholders(body) : body;
}

function bindDollarPlaceholders(expr: Expr): Expr {
  if (expr.kind === "placeholder") return { kind: "var", name: "$" };
  switch (expr.kind) {
    case "call":
      return {
        ...expr,
        callee: bindDollarPlaceholders(expr.callee),
        args: expr.args.map(bindDollarPlaceholders),
      };
    case "index":
      return {
        ...expr,
        target: bindDollarPlaceholders(expr.target),
        index: bindDollarPlaceholders(expr.index),
      };
    case "binary":
      return {
        ...expr,
        left: bindDollarPlaceholders(expr.left),
        right: bindDollarPlaceholders(expr.right),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: bindDollarPlaceholders(expr.value),
        body: expr.name === "$" ? expr.body : bindDollarPlaceholders(expr.body),
      };
    case "match":
      return {
        ...expr,
        value: bindDollarPlaceholders(expr.value),
        arms: expr.arms.map((arm) => ({ ...arm, value: bindDollarPlaceholders(arm.value) })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({ ...slot, value: bindDollarPlaceholders(slot.value) })),
      };
    case "range":
      return {
        ...expr,
        start: bindDollarPlaceholders(expr.start),
        end: bindDollarPlaceholders(expr.end),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "let" || stmt.kind === "destructure_let"
            ? { ...stmt, value: bindDollarPlaceholders(stmt.value) }
            : stmt
        ),
        expr: expr.expr ? bindDollarPlaceholders(expr.expr) : undefined,
      };
    case "literal":
    case "var":
      return expr;
  }
}

function lowerCall(node: Node): Expr {
  const children = named(node);
  let expr = lowerPrimary(children[0]);
  if (!children.some(is("Args")) && /\)\s*$/.test(node.text)) {
    return { kind: "call", callee: expr, args: [] };
  }
  let pendingMember: { receiver: Expr; member: string } | undefined;
  for (let i = 1; i < children.length; i++) {
    const child = children[i];
    if (child.type === "Args") {
      if (pendingMember) {
        expr = {
          kind: "call",
          callee: {
            kind: "var",
            name: receiverMemberName(pendingMember.receiver, pendingMember.member),
          },
          args: [pendingMember.receiver, ...lowerArgs(child)],
        };
        pendingMember = undefined;
      } else {
        expr = { kind: "call", callee: expr, args: lowerArgs(child) };
      }
    } else if (
      child.type === "LowerIdent" || child.type === "PascalIdent" || child.type === "Ident"
    ) {
      if (
        (expr.kind === "call" || expr.kind === "range" || isPipelineReceiver(expr)) &&
        (nextNamedCallChild(children, i)?.type === "Args" || children[i + 1]?.type === "(")
      ) {
        pendingMember = { receiver: expr, member: child.text };
      } else {
        expr = { kind: "var", name: `${nameOf(expr)}.${child.text}` };
      }
    } else if (child.type === ")" && pendingMember) {
      expr = {
        kind: "call",
        callee: {
          kind: "var",
          name: receiverMemberName(pendingMember.receiver, pendingMember.member),
        },
        args: [pendingMember.receiver],
      };
      pendingMember = undefined;
    } else if (child.type === "Expr") {
      const index = lowerExpr(child);
      if (index.kind === "literal" && index.literalKind === "number") {
        expr = { kind: "var", name: `${nameOf(expr)}[${index.value}]` };
      } else {
        expr = { kind: "index", target: expr, index };
      }
    } else if (child.type === "ShapeValue") {
      if (expr.kind !== "var") {
        fail("parse.lower", "product constructor requires a named constructor", spanFor(child));
      }
      const shape = lowerShapeValue(child);
      if (shape.kind !== "shape") return unreachable(child, "shape value");
      expr = { kind: "product_constructor", constructor: expr.name, slots: shape.slots };
    }
  }
  return expr;
}

function isPipelineReceiver(expr: Expr): boolean {
  return expr.kind === "placeholder" || (expr.kind === "var" && expr.name === "$");
}

function nextNamedCallChild(children: readonly Node[], index: number): Node | undefined {
  return children.slice(index + 1).find((child) => !isCallPunctuation(child));
}

function isCallPunctuation(node: Node): boolean {
  return ["(", ")", ".", ","].includes(node.type);
}

function receiverMemberName(receiver: Expr, member: string): string {
  if (isPipelineReceiver(receiver)) return `iter.${member}`;
  if (receiver.kind === "range") return `range_i32.${member}`;
  if (receiver.kind === "call" && receiver.callee.kind === "var") {
    const owner = iteratorReceiverOwner(receiver.callee.name);
    if (owner) return `${owner}.${member}`;
  }
  return member;
}

function iteratorReceiverOwner(callee: string): string | undefined {
  if (callee.endsWith(".layout.inline_array.iter")) {
    return `${callee.slice(0, -".layout.inline_array.iter".length)}.iter`;
  }
  if (callee === "inline_array.iter" || callee.startsWith("iter.")) return "iter";
  if (callee === "layout.inline_array.iter") return "iter";
  if (callee === "compact_array.iter" || callee.startsWith("compact_iter.")) return "compact_iter";
  if (callee === "range_i32.iter" || callee.startsWith("range_iter.")) return "range_iter";
  return undefined;
}

function lowerPrimary(node: Node): Expr {
  const child = named(node)[0];
  if (!child) {
    return unreachable(node, "primary");
  }
  switch (child.type) {
    case "Literal":
      return lowerLiteral(child);
    case "Placeholder":
      return { kind: "placeholder" };
    case "ForkBuiltin":
      return { kind: "var", name: "fork" };
    case "StaticBuiltin":
      return { kind: "var", name: `@${text(firstIdentifier(child), "static builtin")}` };
    case "PascalIdent":
    case "LowerIdent": {
      const tail = optional(node, "ProductConstructorTail");
      if (tail) {
        const source = tail.text.trim();
        if (/^\[\s*[0-9]+(\.[0-9]+)?[A-Za-z0-9_]*\s*\]$/.test(source)) {
          return { kind: "var", name: `${child.text}${source.replace(/\s+/g, "")}` };
        }
        const shape = lowerShapeValue(only(tail, "ShapeValue"));
        if (shape.kind !== "shape") return unreachable(tail, "shape value");
        return { kind: "product_constructor", constructor: child.text, slots: shape.slots };
      }
      return { kind: "var", name: child.text };
    }
    case "ParenExpr":
      return lowerExpr(first(child, "Expr"));
    case "Expr":
      return lowerExpr(child);
    case "ShapeValue":
      return lowerShapeValue(child);
    case "Block":
      return lowerBlock(child);
    default:
      return unreachable(child, "primary");
  }
}

function lowerShapeValue(node: Node): Expr {
  const init = optional(node, "ShapeInit");
  if (!init) return { kind: "shape", slots: [] };
  return {
    kind: "shape",
    slots: named(init).filter(is("ShapeValueSlot")).map((slot) => ({
      label: named(slot).find(isFieldName)?.text.replace(/:\s*$/, "").trim(),
      value: lowerExpr(first(slot, "Expr")),
    })),
  };
}

function lowerLiteral(node: Node): Expr {
  const literal = named(node)[0] ?? node;
  const literalKind = literal.type === "Bool"
    ? "bool"
    : literal.type === "Number"
    ? "number"
    : literal.type === "String"
    ? "string"
    : literal.type === "Char"
    ? "char"
    : literal.type === "Multiline" || literal.type === "fenced_text"
    ? "multiline"
    : "literalType";
  return {
    kind: "literal",
    value: literalKind === "multiline" ? multilineContents(literal.text) : literal.text,
    literalKind,
  };
}

function multilineContents(source: string): string {
  const match = source.match(/^```[A-Za-z0-9_-]*\r?\n?([\s\S]*?)```$/);
  return match ? match[1] : source;
}

function lowerArgs(node: Node): Expr[] {
  return named(node).filter(is("Expr")).map(lowerExpr);
}

function unwrap(node: Node): Node {
  const children = named(node);
  if (["Decl", "Stmt", "Expr"].includes(node.type) && children.length === 1) {
    return unwrap(children[0]);
  }
  return node;
}

function named(node: Node): readonly Node[] {
  return ((node.namedChildren ?? []) as readonly Node[]).filter((child) =>
    child.type !== "Whitespace" && child.type !== "Comment"
  );
}

function only(node: Node, type: string): Node {
  const found = named(node).find(is(type));
  if (!found) return unreachable(node, type);
  return found;
}

function optional(node: Node, type: string): Node | undefined {
  return named(node).find(is(type));
}

function first(node: Node, type: string): Node {
  return only(node, type);
}

function isIdentifier(node: Node | undefined): node is Node {
  return node?.type === "LowerIdent" || node?.type === "PascalIdent" || node?.type === "Ident";
}

function isFieldName(node: Node | undefined): node is Node {
  return node?.type === "LowerFieldName" || node?.type === "FieldName";
}

function isRepeatIdentifier(node: Node | undefined): node is Node {
  return node?.type === "LowerIdentRepeat" || node?.type === "PascalIdentRepeat" ||
    node?.type === "IdentRepeat";
}

function firstIdentifier(node: Node): Node {
  const found = named(node).find(isIdentifier);
  if (!found) return unreachable(node, "identifier");
  return found;
}

function firstFieldName(node: Node): Node {
  const found = named(node).find(isFieldName);
  if (!found) return unreachable(node, "field name");
  return found;
}

function optionalFieldName(node: Node): Node | undefined {
  return named(node).find(isFieldName);
}

function is(type: string) {
  return (node: Node) => node.type === type;
}

function text(node: Node | undefined, label: string): string {
  if (!node) fail("parse.lower", `missing ${label}`);
  return node.text;
}

function pathText(node: Node): string {
  return named(node).filter(isIdentifier).map((child) => child.text).join(".");
}

function nameOf(expr: Expr): string {
  return expr.kind === "var" ? expr.name : expr.kind;
}

function bindingName(node: Node | undefined): string {
  return text(node, "binding name").replace(/:\s*$/, "").trim();
}

function unreachable(node: Node, expected: string): never {
  fail("parse.lower", `could not lower ${expected} from ${node.type}`, spanFor(node));
}

function spanFor(node: Node): Span | undefined {
  if (
    node.startIndex === undefined || node.endIndex === undefined || node.startPosition === undefined
  ) return undefined;
  return {
    start: node.startIndex,
    end: node.endIndex,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  };
}
