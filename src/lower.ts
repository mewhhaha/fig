import type {
  AstNodeMeta,
  BranchHint,
  ConstDecl,
  ContractDecl,
  DebugTraceStmt,
  Declaration,
  DestructureLetDecl,
  DoStatement,
  EffectImport,
  Expr,
  FnDecl,
  LetDecl,
  OperatorDecl,
  Param,
  ParamPattern,
  Program,
  ProofConstDecl,
  ShapeType,
  SourceImport,
  Statement,
  StaticForSource,
  TypeAnnotationHole,
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
import { hideAstMetadata, stripAstMetadata } from "./ast_meta.ts";
import { patternBindingNames } from "./patterns.ts";
import {
  annotationBranchHint,
  compilerSpecialForm,
  defaultCompilerPluginRegistry,
  staticBuiltinName,
} from "./plugins.ts";
import type { SyntaxNodeLike } from "../generated/baba-workbench/ast/types.ts";
import { projectNode } from "../generated/baba-workbench/ast/visitor.ts";

type Node = SyntaxNodeLike & {
  namedChildren?: readonly Node[];
  children?: readonly Node[];
  startIndex?: number;
  endIndex?: number;
  startPosition?: { row: number; column: number };
};

let resolveDoc: (start: number | undefined) => string | undefined = () => undefined;
let currentSourceId: string | undefined;

export function lowerProgram(
  root: Node,
  docResolver: (start: number | undefined) => string | undefined = () => undefined,
  sourceId?: string,
): Program {
  resolveDoc = docResolver;
  currentSourceId = sourceId;
  projectNode({ type: "Program", text: root.text });
  const children = named(root);
  const decls = children.filter(is("Decl"));
  const sourceImportConsts = decls.map(unwrap).filter(isSourceImportConst).map(
    lowerSourceImportConst,
  );
  const externalConstImports = decls.map(unwrap).filter(isExternalConst).map(
    lowerExternalConst,
  );
  const declarations = decls.filter((decl) => {
    const unwrapped = unwrap(decl);
    return !isSourceImportConst(unwrapped) && !isExternalConst(unwrapped);
  }).map(lowerDecl);
  declarations.push(...lowerInlineTypeMemberFns(declarations));
  return hideAstMetadata({
    moduleName: undefined,
    imports: externalConstImports,
    sourceImports: sourceImportConsts,
    declarations,
  }) as Program;
}

function lowerExternalConst(node: Node): EffectImport {
  const nameNode = named(node).find((child) => isIdentifier(child) || isFieldName(child));
  const name = bindingName(nameNode);
  const external = first(node, "ExternalConstValue");
  const stringNode = first(external, "String");
  const externalName = JSON.parse(stringNode.text);
  const type = first(external, "FnType").text;
  return { kind: "import", ...meta(node, nameNode), name, externalName, type, effects: [] };
}

function lowerSourceImportConst(node: Node): SourceImport {
  const match = node.text.match(/@\s*import\s*\(\s*("([^"\\]|\\.)*")\s*\)/);
  if (!match) fail("parse.lower", 'source import requires @import("specifier")', spanFor(node));
  const specifier = JSON.parse(match[1]);
  const bindingList = optional(node, "ImportBindingList");
  if (bindingList) {
    const bindings = identifierDescendants(bindingList).map((nameNode) => ({
      name: nameNode.text,
      ...meta(nameNode, nameNode),
    }));
    return {
      kind: "source_import",
      ...meta(node, bindingList),
      module: specifier,
      bindings,
    };
  }
  const aliasNode = first(node, "LowerIdent");
  const alias = text(aliasNode, "import alias");
  return {
    kind: "source_import",
    ...meta(node, aliasNode),
    module: specifier,
    alias,
  };
}

function isSourceImportConst(node: Node): boolean {
  if (node.type !== "ConstDecl") return false;
  if (optional(node, "ImportBindingList") && !isDeclarationBuiltinConst(node, "import")) {
    fail("parse.lower", 'const deconstruction requires @import("specifier")', spanFor(node));
  }
  return isDeclarationBuiltinConst(node, "import");
}

function isExternalConst(node: Node): boolean {
  return node.type === "ConstDecl" && isDeclarationBuiltinConst(node, "external");
}

function isDeclarationBuiltinConst(node: Node, name: string): boolean {
  return defaultCompilerPluginRegistry.declarationBuiltins.has(name) &&
    new RegExp(`@\\s*${name}\\s*\\(`).test(node.text);
}

function lowerDecl(node: Node): Declaration {
  const decl = unwrap(node);
  switch (decl.type) {
    case "TypeSugarDecl":
      return lowerTypeSugarDecl(decl);
    case "TypeFnDecl":
      return lowerTypeDecl(decl);
    case "ContractFnDecl":
      return lowerContractFn(decl);
    case "OperatorDecl":
      return lowerOperatorDecl(decl);
    case "ConstDecl":
      return lowerConst(decl);
    case "FnDecl":
      return lowerFn(decl);
    case "TopLetDecl": {
      const lowered = lowerLet(decl);
      if (lowered.kind === "destructure_let") {
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

function lowerOperatorDecl(node: Node): OperatorDecl {
  const nameNode = only(node, "OperatorBindingName");
  const value = only(node, "OperatorValue");
  const symbol = text(first(nameNode, "Op"), "operator symbol");
  const fixity = text(first(value, "LiteralType"), "operator fixity") as OperatorDecl["fixity"];
  const precedenceText = text(first(value, "Number"), "operator precedence");
  const precedence = Number.parseInt(precedenceText, 10);
  const target = text(first(value, "OperatorTarget"), "operator target").replace(/\s+/g, "");
  return {
    kind: "operator",
    ...meta(node, nameNode),
    ...doc(node),
    name: `operator:${symbol}`,
    symbol,
    fixity,
    precedence,
    target,
  };
}

function lowerContractFn(node: Node): ContractDecl {
  if (optional(node, "Visibility")) {
    fail("rewrite.public", "contract fn declarations cannot be public", spanFor(node));
  }
  const loweredName = lowerFnName(only(node, "FnName"));
  return {
    kind: "contract",
    ...meta(node, loweredName.nameNode),
    ...doc(node),
    name: loweredName.name,
    ...(loweredName.memberOf ? { memberOf: loweredName.memberOf } : {}),
    params: optional(node, "Params")
      ? named(only(node, "Params")).filter(is("Param")).map(lowerParam)
      : [],
    resultKind: "rewrite",
    body: lowerBlock(only(node, "Block")),
  };
}

function lowerConst(node: Node): ConstDecl | TypeDecl {
  const nameNode = named(node).find((child) => isIdentifier(child) || isFieldName(child));
  const constValue = only(node, "ConstValue");
  const annotation = optional(node, "TypeAnn")
    ? annotationMetadata(only(only(node, "TypeAnn"), "Type"))
    : annotationMetadata(optional(node, "Type"));
  return {
    kind: "const",
    ...meta(node, nameNode),
    ...doc(node),
    name: bindingName(nameNode),
    ...(annotation ? { type: annotation.type, ...annotation.meta } : {}),
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
  const returnTypeNode = optional(fn, "ReturnSig")
    ? named(only(fn, "ReturnSig")).find(is("Type"))
    : undefined;
  const returnTypeMeta = annotationMetadata(returnTypeNode)?.meta;
  if (returnType === "struct" || returnType === "union") {
    fail(
      "parse.lower",
      `${returnType} is only valid as a type-function result kind`,
      spanFor(only(fn, "ReturnSig")),
    );
  }
  return {
    kind: "fn",
    ...meta(node, loweredName.nameNode),
    ...doc(node),
    public: named(node).some(is("Visibility")),
    name: loweredName.name,
    ...(loweredName.memberOf ? { memberOf: loweredName.memberOf } : {}),
    params: optional(fn, "Params")
      ? named(only(fn, "Params")).filter(is("Param")).map(lowerParam)
      : [],
    returnType,
    ...(returnTypeMeta
      ? {
        returnTypeSpan: returnTypeMeta.typeSpan,
        returnTypeHoles: returnTypeMeta.typeHoles,
      }
      : {}),
    effects: [],
    body: lowerBlock(only(fn, "Block")),
    ...(lowerBranchHint(optional(fn, "BranchHint")) ?? {}),
  };
}

function lowerBranchHint(node: Node | undefined): { branchHint: BranchHint } | undefined {
  if (!node) return undefined;
  const hint = staticBuiltinName(node.text.replace(/\s+/g, ""));
  return { branchHint: annotationBranchHint(hint) ?? hint };
}

function lowerFnName(
  node: Node,
): {
  name: string;
  nameNode?: Node;
  memberOf?: { owner: string; member: string; span?: Span; nameSpan?: Span };
} {
  const compact = node.text.replace(/\s+/g, "");
  const ids = identifierDescendants(node);
  if (compact.includes("::")) {
    const [owner, member] = compact.split("::");
    return {
      name: compact,
      nameNode: ids.at(-1),
      memberOf: { owner, member, ...meta(node, ids.at(-1)) },
    };
  }
  const parts = ids.map((id) => id.text);
  const name = parts.join(".");
  return { name, nameNode: ids[0] };
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
    ...meta(node, ids[0]),
    ...doc(node),
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

function lowerTypeSugarDecl(node: Node): TypeDecl {
  const nameNode = first(node, "PascalIdent");
  const name = text(nameNode, "type name");
  const paramsNode = optional(node, "TypeSugarParams");
  const params = paramsNode
    ? descendants(paramsNode, "TypeSugarParam").map(lowerTypeSugarParam)
    : [];
  const body = first(node, "TypeSugarBody");
  const bodyChild = named(body)[0];
  const resultKind: TypeResultKind = bodyChild.type === "TypeSugarStruct"
    ? "struct"
    : bodyChild.type === "TypeSugarUnion"
    ? "union"
    : "type";
  return {
    kind: "type",
    ...meta(node, nameNode),
    ...doc(node),
    name,
    params,
    resultKind,
    body: lowerTypeSugarBlock(name, bodyChild),
  };
}

function lowerTypeSugarParam(node: Node): TypeParam {
  const ident = named(node).find(isIdentifier);
  const kindNode = optional(node, "TypeParamKind");
  return {
    ...meta(node, ident),
    ...doc(node),
    name: text(ident, "type parameter name"),
    kind: kindNode ? text(kindNode, "type parameter kind").replace(/\s+/g, " ") : "type",
  };
}

function lowerTypeSugarBlock(name: string, node: Node): TypeBlock {
  if (node.type === "TypeSugarStruct") {
    const shapeExpr = lowerTypeExpr(first(node, "TypeShape"));
    return {
      kind: "type_block",
      ...spanOnly(node),
      statements: [{
        kind: "type_let",
        ...meta(node),
        name,
        value: shapeExpr,
      }],
      expr: typeCall("struct", [typeRef(name, node)], node),
    };
  }
  if (node.type === "TypeSugarUnion") {
    const variants = descendants(node, "TypeSugarVariant");
    return {
      kind: "type_block",
      ...spanOnly(node),
      statements: variants.map((variant) => {
        const variantName = text(first(variant, "PascalIdent"), "variant name");
        return {
          kind: "type_let" as const,
          ...meta(variant, first(variant, "PascalIdent")),
          ...doc(variant),
          name: variantName,
          value: {
            kind: "type_shape" as const,
            ...spanOnly(variant),
            shape: lowerTypeSugarVariantShape(variant),
          },
        };
      }),
      expr: typeCall(
        "union",
        variants.map((variant) =>
          typeRef(text(first(variant, "PascalIdent"), "variant name"), variant)
        ),
        node,
      ),
    };
  }
  return {
    kind: "type_block",
    ...spanOnly(node),
    statements: [],
    expr: lowerTypeExpr(node),
  };
}

function lowerTypeSugarVariantShape(node: Node): TypeShape {
  const payload = optional(node, "TypeSugarVariantPayload");
  if (!payload) return { slots: [], ...spanOnly(node) };
  return {
    ...spanOnly(payload),
    slots: canonicalizeSlots(
      descendants(payload, "TypeShapeSlot").map(lowerTypeShapeSlot),
      "type shape",
    ),
  };
}

function typeRef(name: string, node: Node): TypeExpr {
  return { kind: "type_ref", ...meta(node), name };
}

function typeCall(callee: string, args: TypeExpr[], node: Node): TypeExpr {
  return {
    kind: "type_call",
    ...spanOnly(node),
    callee: typeRef(callee, node),
    args,
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
    ...meta(node, named(node).find(isIdentifier)),
    ...doc(node),
    name: pattern.kind === "binding"
      ? pattern.name
      : `__type_pattern_${Math.abs(hashText(JSON.stringify(stripAstMetadata(pattern))))}`,
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
        ...meta(child, firstIdentifier(child)),
        ...doc(child),
        name: text(firstIdentifier(child), "type let name"),
        value: lowerTypeExpr(first(child, "TypeExpr")),
      });
    } else if (child.type === "TypeExpr") {
      if (item.text.trimEnd().endsWith(";")) {
        statements.push({
          kind: "type_let" as const,
          ...meta(child),
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
  return {
    ...spanOnly(node),
    slots: canonicalizeSlots(
      named(node).filter(is("ShapeSlot")).map(lowerShapeTypeSlot),
      "shape type",
    ),
  };
}

function lowerShapeTypeSlot(node: Node): ShapeType["slots"][number] {
  const body = only(node, "ShapeSlotBody");
  const key = optional(node, "ShapeSlotKey");
  const repeat = named(body)
    .find((child) => child.type === "CountRepeat" || isRepeatIdentifier(child))
    ?.text.replace(/\s*\*$/, "").trim();
  const slot: ShapeType["slots"][number] = {
    ...meta(node, slotLabelNode(key)),
    ...doc(node),
    ...slotKeyParts(key),
    type: optional(body, "Type")?.text ?? body.text,
  };
  if (repeat) slot.repeat = repeat;
  return slot;
}

function slotLabelNode(node: Node | undefined): Node | undefined {
  return node ? named(node).find(is("LowerIdent")) : undefined;
}

function slotKeyParts(node: Node | undefined): { label?: string; position?: number } {
  if (!node) return {};
  const label = named(node).find(is("LowerIdent"))?.text;
  const positionNode = optional(node, "SlotPosition");
  const parts: { label?: string; position?: number } = {};
  if (label) parts.label = label;
  if (positionNode) {
    const raw = first(positionNode, "Number").text;
    const position = Number.parseInt(raw, 10);
    if (!Number.isInteger(position) || position < 0 || String(position) !== raw) {
      fail(
        "parse.lower",
        `slot position must be a non-negative integer: ${raw}`,
        spanFor(positionNode),
      );
    }
    parts.position = position;
  }
  return parts;
}

function canonicalizeSlots<t extends { position?: number; spread?: boolean; span?: Span }>(
  slots: t[],
  description: string,
): t[] {
  if (!slots.some((slot) => slot.position !== undefined)) return slots;
  const explicit = new Set<number>();
  for (const slot of slots) {
    if (slot.position === undefined || slot.spread) continue;
    if (explicit.has(slot.position)) {
      fail("parse.lower", `duplicate ${description} slot position ${slot.position}`, slot.span);
    }
    explicit.add(slot.position);
  }

  let next = 0;
  const positioned = slots.map((slot) => {
    if (slot.position !== undefined || slot.spread) return slot;
    while (explicit.has(next)) next++;
    explicit.add(next);
    return { ...slot, position: next++ };
  });
  const max = Math.max(...positioned.map((slot) => slot.position ?? -1));
  for (let position = 0; position <= max; position++) {
    if (!positioned.some((slot) => slot.position === position)) {
      fail(
        "parse.lower",
        `non-contiguous ${description} slot positions; missing position ${position}`,
        undefined,
      );
    }
  }
  return positioned.toSorted((left, right) => (left.position ?? 0) - (right.position ?? 0));
}

function lowerTypeExpr(node: Node): TypeExpr {
  const expr = unwrapType(node);
  switch (expr.type) {
    case "TypeMatch": {
      const exprs = named(expr).filter(is("TypeExpr"));
      return {
        kind: "type_match",
        ...spanOnly(expr),
        value: lowerTypeExpr(exprs[0]),
        arms: named(expr).filter(is("TypeArm")).map((arm) => ({
          ...spanOnly(arm),
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
          ...spanOnly(expr),
          op: ops[index].text as "==" | "!=" | "|",
          left: current,
          right: lowerTypeExpr(calls[index + 1]),
        };
      }
      return current;
    }
    case "ScalarDomainType":
      return lowerScalarDomainType(expr);
    case "TypeCall": {
      const children = named(expr);
      let callee = lowerTypeExpr(children[0]);
      for (const args of children.slice(1).filter(is("TypeExprArgs"))) {
        callee = {
          kind: "type_call",
          ...spanOnly(args),
          callee,
          args: named(args).filter(is("TypeExpr")).map(lowerTypeExpr),
        };
      }
      if (
        children[0]?.type === "TypePrimary" && isIdentifier(named(children[0])[0]) &&
        !children.some(is("TypeExprArgs")) && /\)\s*$/.test(expr.text)
      ) {
        return { kind: "type_call", ...spanOnly(expr), callee, args: [] };
      }
      return callee;
    }
    case "FnType":
      return { kind: "type_fn", ...spanOnly(expr), source: expr.text };
    case "Literal":
      return lowerTypeLiteral(expr);
    case "StaticBuiltin":
      return {
        kind: "type_static_ref",
        ...meta(expr, firstStaticBuiltinName(expr)),
        name: lowerStaticBuiltinName(expr),
      };
    case "TypeShape":
      return { kind: "type_shape", ...spanOnly(expr), shape: lowerTypeShape(expr) };
    case "TypeTuple":
      return { kind: "type_shape", ...spanOnly(expr), shape: lowerTypeTuple(expr) };
    case "TypeBuilderName":
      return { kind: "type_ref", ...meta(expr, expr), name: expr.text };
    case "ScalarCarrier":
      return { kind: "type_ref", ...meta(expr, expr), name: expr.text };
    case "TypeHole":
      return { kind: "type_hole", ...spanOnly(expr) };
    case "TypePrimary":
      if (expr.text.trim() === "_") return { kind: "type_hole", ...spanOnly(expr) };
      if (optional(expr, "TypeQualifiedTail")) {
        return { kind: "type_ref", ...spanOnly(expr), name: expr.text.replace(/\s+/g, "") };
      }
      return lowerTypeExpr(named(expr)[0]);
    case "TypeAtom":
      return lowerTypeExpr(named(expr)[0]);
    case "Type":
      if (optional(expr, "TypeQualifiedTail")) {
        return { kind: "type_ref", ...spanOnly(expr), name: expr.text.replace(/\s+/g, "") };
      }
      return lowerTypeExpr(named(expr)[0]);
    case "QualifiedTypeName":
      return { kind: "type_ref", ...spanOnly(expr), name: expr.text.replace(/\s+/g, "") };
    case "LowerIdent":
    case "PascalIdent":
      return { kind: "type_ref", ...meta(expr, expr), name: expr.text };
    default:
      return unreachable(expr, "type expression");
  }
}

function lowerScalarDomainType(node: Node): TypeExpr {
  const carrier = text(first(node, "ScalarCarrier"), "scalar domain carrier");
  return {
    kind: "type_scalar_domain",
    ...spanOnly(node),
    carrier,
    members: descendants(node, "ScalarDomainMember").map(lowerScalarDomainMember),
  };
}

function lowerScalarDomainMember(
  node: Node,
): Extract<TypeExpr, { kind: "type_scalar_domain" }>["members"][number] {
  const endpoints = named(node).filter(is("ScalarDomainEndpoint"));
  return {
    ...spanOnly(node),
    start: lowerScalarDomainEndpoint(endpoints[0] ?? node),
    ...(endpoints[1] ? { end: lowerScalarDomainEndpoint(endpoints[1]) } : {}),
  };
}

function lowerScalarDomainEndpoint(
  node: Node,
): Extract<TypeExpr, { kind: "type_scalar_domain" }>["members"][number]["start"] {
  const literal = node.type === "Literal" || !!optional(node, "Literal") ||
    node.type === "Number" ||
    !!optional(node, "Number");
  return {
    kind: literal ? "literal" : "symbol",
    ...spanOnly(node),
    source: node.text.replace(/\s+/g, ""),
  };
}

function annotationMetadata(
  node: Node | undefined,
): { type: string; meta: { typeSpan?: Span; typeHoles?: TypeAnnotationHole[] } } | undefined {
  if (!node) return undefined;
  const holes = collectTypeAnnotationHoleNodes(node).map((hole) => ({
    ...(spanFor(hole) ? { span: spanFor(hole) } : {}),
  }));
  const typeSpan = spanFor(node);
  return {
    type: node.text,
    meta: {
      ...(typeSpan ? { typeSpan } : {}),
      ...(holes.length ? { typeHoles: holes } : {}),
    },
  };
}

function collectTypeAnnotationHoleNodes(node: Node): Node[] {
  const found: Node[] = [];
  const visit = (current: Node) => {
    if (current.type === "TypeHole" || current.text.trim() === "_") {
      found.push(current);
      return;
    }
    for (const child of current.children ?? current.namedChildren ?? []) visit(child as Node);
  };
  visit(node);
  return found;
}

function collectTypeAnnotationHoles(expr: TypeExpr): TypeAnnotationHole[] {
  const holes: TypeAnnotationHole[] = [];
  const visit = (node: TypeExpr) => {
    if (node.kind === "type_hole") {
      holes.push({ ...(node.span ? { span: node.span } : {}) });
      return;
    }
    switch (node.kind) {
      case "type_call":
        visit(node.callee);
        for (const arg of node.args) visit(arg);
        return;
      case "type_shape":
        for (const slot of node.shape.slots) visit(slot.type);
        return;
      case "type_match":
        visit(node.value);
        for (const arm of node.arms) visit(arm.value);
        return;
      case "type_scalar_domain":
        return;
      case "type_binary":
        visit(node.left);
        visit(node.right);
        return;
      case "type_ref":
      case "type_static_ref":
      case "type_fn":
      case "type_bool":
      case "type_number":
      case "type_char":
      case "type_string":
      case "type_literal":
        return;
    }
  };
  visit(expr);
  return holes;
}

function lowerTypeMember(node: Node): TypeMemberExpr {
  const fn = optional(node, "FnDecl");
  if (fn) {
    const lowered = lowerFn(fn);
    return {
      ...doc(node),
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
    ...meta(node, fn ? undefined : firstFieldName(node)),
    ...doc(node),
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
  if (node.text.trim() === "_") return { kind: "wildcard", ...spanOnly(node) };
  const child = named(node)[0];
  if (!child) {
    return unreachable(node, "type pattern");
  }
  if (child.type === "Literal") return lowerTypeLiteralPattern(child);
  if (isIdentifier(child)) return { kind: "type", ...meta(child, child), name: child.text };
  return unreachable(child, "type pattern");
}

function lowerTypeLiteral(node: Node): TypeExpr {
  const literal = named(node)[0] ?? node;
  if (literal.type === "Bool") {
    return { kind: "type_bool", ...spanOnly(literal), value: literal.text === "true" };
  }
  if (literal.type === "String") {
    return { kind: "type_string", ...spanOnly(literal), value: JSON.parse(literal.text) };
  }
  if (literal.type === "Char") {
    return {
      kind: "type_char",
      ...spanOnly(literal),
      value: JSON.parse(`"${literal.text.slice(1, -1)}"`),
    };
  }
  if (literal.type === "Multiline" || literal.type === "fenced_text") {
    return { kind: "type_string", ...spanOnly(literal), value: multilineContents(literal.text) };
  }
  if (literal.type === "Number") {
    return { kind: "type_number", ...spanOnly(literal), value: literal.text };
  }
  if (literal.type === "LiteralType") {
    return { kind: "type_literal", ...spanOnly(literal), value: literal.text.slice(1) };
  }
  return unreachable(literal, "type literal");
}

function lowerTypeLiteralPattern(node: Node): TypePattern {
  const literal = named(node)[0] ?? node;
  if (literal.type === "Bool") {
    return { kind: "bool", ...spanOnly(literal), value: literal.text === "true" };
  }
  if (literal.type === "LiteralType") {
    return { kind: "literal", ...spanOnly(literal), value: literal.text.slice(1) };
  }
  if (literal.type === "String") {
    return { kind: "string", ...spanOnly(literal), value: JSON.parse(literal.text) };
  }
  if (literal.type === "Char") {
    return {
      kind: "char",
      ...spanOnly(literal),
      value: JSON.parse(`"${literal.text.slice(1, -1)}"`),
    };
  }
  if (literal.type === "Number") {
    return { kind: "number", ...spanOnly(literal), value: literal.text };
  }
  return unreachable(literal, "type literal pattern");
}

function lowerTypeShape(node: Node): TypeShape {
  const body = optional(node, "TypeShapeBody") ?? node;
  return {
    ...spanOnly(node),
    slots: canonicalizeSlots(
      listSlots(body, "TypeShapeSlot").map(lowerTypeShapeSlot),
      "type shape",
    ),
  };
}

function lowerTypeTuple(node: Node): TypeShape {
  const repeat = optional(node, "TypeTupleRepeat");
  if (repeat) {
    const expr = first(repeat, "TypeExpr");
    return {
      ...spanOnly(node),
      slots: [{
        ...spanOnly(repeat),
        position: 0,
        type: lowerTypeExpr(expr),
        repeat: lowerTupleRepeatCount(first(repeat, "TypeRepeatCount")),
      }],
    };
  }
  const exprs = listTupleItems(node, "TypeExpr");
  return {
    ...spanOnly(node),
    slots: exprs.map((expr, position) => ({
      ...spanOnly(expr),
      position,
      type: lowerTypeExpr(expr),
    })),
  };
}

function lowerTypeShapeSlot(node: Node): TypeShape["slots"][number] {
  const body = only(node, "TypeShapeSlotBody");
  const key = optional(node, "ShapeSlotKey");
  const repeatNode = optional(body, "TypeShapeRepeat");
  return {
    ...meta(node, slotLabelNode(key)),
    ...doc(node),
    ...slotKeyParts(key),
    repeat: repeatNode ? lowerTypeRepeat(repeatNode) : undefined,
    type: lowerTypeExpr(optional(body, "TypeExpr") ?? first(body, "TypeNonFnExpr")),
  };
}

function lowerTypeRepeat(node: Node): TypeShape["slots"][number]["repeat"] {
  const base = node.startIndex ?? 0;
  const parts = [...node.text.matchAll(/[^*]+/g)].map((match) => {
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    const start = base + (match.index ?? 0) + leading;
    return { text, start, end: start + text.length };
  }).filter((part) => part.text);
  let expr: TypeCountExpr = countAtom(parts[0].text, spanFromOffsets(parts[0].start, parts[0].end));
  for (const part of parts.slice(1)) {
    const right = countAtom(part.text, spanFromOffsets(part.start, part.end));
    expr = { kind: "count_mul", span: joinSpans(expr.span, right.span), left: expr, right };
  }
  return expr;
}

function lowerTupleRepeatCount(node: Node): TypeCountExpr {
  const child = named(node)[0] ?? node;
  return countAtom(child.text.trim(), spanFor(child));
}

function countAtom(text: string, span?: Span): TypeCountExpr {
  if (/^[0-9]/.test(text)) {
    return {
      kind: "count_literal" as const,
      value: Number.parseInt(text, 10),
      source: text,
      ...(span ? { span } : {}),
    };
  }
  return { kind: "count_ref" as const, name: text, ...(span ? { span } : {}) };
}

function unwrapType(node: Node): Node {
  const children = named(node);
  if (
    ["TypeExpr", "TypeNonFnExpr", "TypePrimary", "TypeCall", "TypeBinary", "TypeUnion", "TypeAtom"]
      .includes(node.type) &&
    children.length === 1
  ) {
    return unwrapType(children[0]);
  }
  return node;
}

function lowerParam(node: Node): Param {
  const patternNode = optional(node, "Pattern") ?? optional(node, "PatternIdent") ??
    optional(node, "Literal") ?? named(node).find((child) => child.text.trim() === "_");
  const constName = node.text.match(/^\s*const\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1];
  const nameNode = constName
    ? named(node).find((child) => isIdentifier(child) && child.text === constName)
    : named(node).find((child) => isIdentifier(child) || isFieldName(child));
  const isConstParam = /^\s*const\b/.test(node.text);
  const pattern = isConstParam && constName
    ? ({ kind: "binding", ...spanOnly(nameNode ?? node), name: constName } as ParamPattern)
    : patternNode
    ? lowerParamPattern(patternNode)
    : lowerNameParamPattern(nameNode);
  const name = paramBindingName(pattern, nameNode);
  const explicitType = constTypeFnAnnotation(node.text) ??
    optional(node, "Type")?.text ??
    optional(node, "TypeAnn")?.text.replace(/^\s*:\s*/, "");
  const annotation = annotationMetadata(optional(node, "Type"));
  return {
    ...meta(node, nameNode),
    ...doc(node),
    name,
    type: explicitType ?? "type",
    ...(annotation?.meta ?? {}),
    const: isConstParam ? true : undefined,
    ...(isConstParam && !explicitType ? { inferStaticType: true } : {}),
    ...(pattern.kind !== "binding" || pattern.name !== name ? { pattern } : {}),
  };
}

function constTypeFnAnnotation(source: string): string | undefined {
  if (!/^\s*const\b/.test(source)) return undefined;
  const match = source.match(/:\s*(type\s+fn\s*\([\s\S]*\)\s*->\s*(?:type|struct|union))/);
  return match?.[1]?.replace(/\s+/g, " ");
}

function lowerNameParamPattern(node: Node | undefined): ParamPattern {
  if (!node) fail("parse.lower", "missing parameter pattern");
  const name = bindingName(node);
  return name === "_"
    ? { kind: "wildcard", ...spanOnly(node) }
    : { kind: "binding", ...meta(node, node), name };
}

function lowerParamPattern(node: Node): ParamPattern {
  const source = node.text.trim();
  if (source === "_") return { kind: "wildcard", ...spanOnly(node) };
  const child = named(node)[0];
  if (!child) return { kind: "wildcard", ...spanOnly(node) };
  if (node.type === "Literal" || child.type === "Literal") {
    const literal = lowerLiteral(node.type === "Literal" ? node : child);
    if (literal.kind !== "literal") return { kind: "wildcard", ...spanOnly(node) };
    if (
      literal.literalKind === "number" || literal.literalKind === "bool" ||
      literal.literalKind === "string" || literal.literalKind === "literalType"
    ) {
      return {
        kind: "literal",
        ...spanOnly(node),
        value: literal.value,
        literalKind: literal.literalKind,
      };
    }
  }
  if (node.type === "TuplePattern" || child.type === "TuplePattern") {
    const tuple = node.type === "TuplePattern" ? node : child;
    return {
      kind: "tuple",
      ...spanOnly(tuple),
      items: listTupleItems(tuple, "Pattern").map(lowerParamPattern),
    };
  }
  if (node.type === "PatternIdent" || child.type === "PatternIdent") {
    const patternIdent = node.type === "PatternIdent" ? node : child;
    const ident = firstIdentifier(patternIdent).text;
    const argsNode = optional(patternIdent, "PatternArgs") ?? optional(patternIdent, "Args");
    const args = argsNode
      ? named(argsNode).filter((node) => node.type === "Pattern" || node.type === "Expr").map((
        expr,
      ) =>
        expr.text.trim() === "_"
          ? { kind: "wildcard" as const, ...spanOnly(expr) }
          : /^[A-Za-z_][A-Za-z0-9_]*$/.test(expr.text.trim())
          ? { kind: "binding" as const, ...spanOnly(expr), name: expr.text.trim() }
          : lowerParamPattern({ ...expr, type: "Pattern" })
      )
      : undefined;
    if (args) {
      return {
        kind: "constructor",
        ...meta(patternIdent, firstIdentifier(patternIdent)),
        name: ident,
        args,
      };
    }
    if (/^[A-Z]/.test(ident)) {
      return {
        kind: "constructor",
        ...meta(patternIdent, firstIdentifier(patternIdent)),
        name: ident,
        args: [],
      };
    }
    return ident === "_"
      ? { kind: "wildcard", ...spanOnly(patternIdent) }
      : { kind: "binding", ...meta(patternIdent, firstIdentifier(patternIdent)), name: ident };
  }
  return { kind: "binding", ...spanOnly(node), name: source };
}

function paramBindingName(pattern: ParamPattern, fallback: Node | undefined): string {
  if (pattern.kind === "binding") return pattern.name;
  const fallbackName = fallback ? bindingName(fallback) : "";
  return fallbackName && fallbackName !== "_"
    ? fallbackName
    : `__pattern_${Math.abs(hashText(JSON.stringify(stripAstMetadata(pattern))))}`;
}

function knownTypeName(name: string): boolean {
  return [
    "type",
    "const",
    "count",
    "bool",
    "char",
    "string",
    "i32",
    "u32",
    "i64",
    "u64",
    "f32",
    "f64",
  ].includes(name) ||
    /^u([1-9]|[1-5][0-9]|6[0-4])$/.test(name);
}

function hashText(source: string): number {
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) | 0;
  return hash;
}

function lowerLet(node: Node): LetDecl | DestructureLetDecl {
  const tuplePattern = optional(node, "TuplePattern");
  if (tuplePattern) {
    const pattern = lowerParamPattern(tuplePattern);
    const names = patternBindingNames(pattern);
    return {
      kind: "destructure_let",
      ...spanOnly(node),
      names,
      value: lowerExpr(only(node, "Expr")),
    };
  }
  const ids = named(node).filter((child) => isIdentifier(child) || isFieldName(child));
  const tail = optional(node, "TopLetTail") ?? optional(node, "BlockLetTail") ?? node;
  const tailIds = named(tail).filter(isIdentifier);
  const names = [...ids, ...tailIds].map(bindingName);
  if (names.length > 1) {
    const expr = lowerExpr(only(tail, "Expr"));
    const bindingNodes = [...ids, ...tailIds];
    const nameDocs = docsByName(bindingNodes);
    const nameSpans = spansByName(bindingNodes);
    return {
      kind: "destructure_let",
      ...spanOnly(node),
      names,
      ...(nameDocs ? { nameDocs } : {}),
      ...(nameSpans ? { nameSpans } : {}),
      value: expr,
    };
  }
  const typeNode = named(tail).find(is("Type"));
  const annotation = annotationMetadata(typeNode);
  return {
    kind: "let",
    ...meta(node, ids[0]),
    ...doc(node),
    name: bindingName(ids[0]),
    ...(annotation ? { type: annotation.type, ...annotation.meta } : {}),
    value: lowerExpr(only(tail, "Expr")),
  };
}

function lowerProofConst(node: Node): ProofConstDecl {
  const nameNode = first(node, "LowerIdent");
  const name = text(nameNode, "proof const name");
  return {
    kind: "proof_const",
    ...meta(node, nameNode),
    ...doc(node),
    name,
    value: lowerTypeExpr(first(node, "TypeExpr")),
  };
}

function lowerDebugTrace(node: Node): DebugTraceStmt {
  const argsNode = optional(node, "Args");
  const args = argsNode ? lowerArgs(argsNode) : [];
  const firstArg = args[0];
  return {
    kind: "debug_trace",
    ...spanOnly(node),
    builtin: "trace",
    args,
    ...(firstArg?.kind === "literal" && firstArg.literalKind === "string"
      ? { message: JSON.parse(firstArg.value) }
      : {}),
  };
}

function lowerBlock(node: Node): Extract<Expr, { kind: "block" }> {
  const statements: (Statement | DoStatement)[] = [];
  let expr: Expr | undefined;
  for (const child of named(node)) {
    if (child.type === "BlockLetDecl") {
      statements.push(lowerLet(child));
    } else if (child.type === "BlockStmt") {
      const stmt = named(child)[0];
      if (stmt.type === "BlockLetDecl") statements.push(lowerLet(stmt));
      else if (stmt.type === "BlockProofConstDecl") statements.push(lowerProofConst(stmt));
      else if (stmt.type === "DebugTraceStmt") statements.push(lowerDebugTrace(stmt));
    } else if (child.type === "BlockProofConstDecl") {
      statements.push(lowerProofConst(child));
    } else if (child.type === "DebugTraceStmt") {
      statements.push(lowerDebugTrace(child));
    } else if (child.type === "Expr") {
      expr = lowerExpr(child);
    }
  }
  return { kind: "block", ...spanOnly(node), statements: statements as Statement[], expr };
}

function lowerDoBind(node: Node): DoStatement {
  return {
    kind: "do_bind",
    ...spanOnly(node),
    name: first(node, "LowerIdent").text,
    value: lowerExpr(first(node, "Expr")),
  };
}

function lowerDoExprStmt(node: Node): DoStatement {
  return {
    kind: "do_expr",
    ...spanOnly(node),
    value: lowerExpr(first(node, "Expr")),
  };
}

function lowerIfArmBlock(node: Node): Expr {
  const block = lowerBlock(node);
  return block.statements.length === 0 && block.expr ? block.expr : block;
}

function lowerExpr(node: Node): Expr {
  const expr = unwrap(node);
  switch (expr.type) {
    case "DoExpr":
      return lowerDoExpr(expr);
    case "ProfileExpr":
      return lowerProfileExpr(expr);
    case "IfExpr": {
      const condition = first(expr, "Expr");
      const blocks = named(expr).filter(is("Block"));
      const trueBlock = blocks[0];
      const falseBlock = blocks[1];
      return {
        kind: "match",
        ...spanOnly(expr),
        value: lowerExpr(condition),
        arms: [
          {
            ...spanOnly(trueBlock),
            pattern: {
              kind: "literal",
              value: "true",
              literalKind: "bool",
              ...spanOnly(trueBlock),
            },
            value: lowerIfArmBlock(trueBlock),
          },
          {
            ...spanOnly(falseBlock),
            pattern: {
              kind: "literal",
              value: "false",
              literalKind: "bool",
              ...spanOnly(falseBlock),
            },
            value: lowerIfArmBlock(falseBlock),
          },
        ],
      };
    }
    case "MatchExpr": {
      const value = first(expr, "MatchValues");
      const arms = named(expr).filter(is("Arm")).map((arm) => {
        const armExpr = first(arm, "Expr");
        return {
          ...spanOnly(arm),
          ...(lowerBranchHint(optional(arm, "BranchHint")) ?? {}),
          pattern: lowerMatchPatterns(first(arm, "MatchPatterns")),
          value: lowerExpr(armExpr),
        };
      });
      return { kind: "match", ...spanOnly(expr), value: lowerMatchValues(value), arms };
    }
    case "ConstFn": {
      const paramsNode = first(expr, "ConstFnParams");
      const params = descendantLowerIdents(paramsNode).map((child) => child.text);
      return {
        kind: "const_fn",
        ...spanOnly(expr),
        params,
        body: lowerExpr(optional(expr, "Block") ?? first(expr, "Expr")),
      };
    }
    case "PipeBind":
    case "CollectionPipeBind":
      return lowerPipeBind(expr);
    case "CollectionExpr":
      return lowerExpr(named(expr)[0]);
    case "PipeBindAtom":
    case "CollectionPipeBindAtom":
      return lowerExpr(named(expr)[0]);
    case "Range":
      return lowerRange(expr);
    case "Binary":
    case "CollectionBinary":
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

function lowerMatchValues(node: Node): Expr {
  const source = optional(node, "MatchValuesParen") ?? node;
  const values = named(source).filter(is("Expr"));
  if (values.length === 1) return lowerExpr(values[0]);
  return {
    kind: "shape",
    syntax: "record",
    ...spanOnly(node),
    slots: values.map((value, position) => ({
      ...spanOnly(value),
      position,
      value: lowerExpr(value),
    })),
  };
}

function lowerProfileExpr(node: Node): Expr {
  const argsNode = optional(node, "Args");
  const args = argsNode ? lowerArgs(argsNode) : [];
  const firstArg = args[0];
  return {
    kind: "profile",
    ...spanOnly(node),
    args,
    ...(firstArg?.kind === "literal" && firstArg.literalKind === "string"
      ? { label: JSON.parse(firstArg.value) }
      : {}),
    body: lowerBlock(only(node, "Block")),
  };
}

function lowerMatchPatterns(node: Node): ParamPattern {
  const patterns = named(node).filter(is("Pattern"));
  if (patterns.length === 1) return lowerParamPattern(patterns[0]);
  return {
    kind: "tuple",
    ...spanOnly(node),
    items: patterns.map(lowerParamPattern),
  };
}

function lowerDoExpr(node: Node): Expr {
  const strategy = first(node, "DoStrategy");
  const block = first(node, "DoBlock");
  const statements: DoStatement[] = [];
  let expr: Expr | undefined;
  const collect = (child: Node) => {
    if (child.type === "DoBindStmt") {
      statements.push(lowerDoBind(child));
    } else if (child.type === "DoExprOrFinal") {
      const childExpr = first(child, "Expr");
      const parts = named(child);
      const hasSemicolon = parts.some((part) => part.text === ";");
      if (hasSemicolon) {
        statements.push({
          kind: "do_expr",
          ...spanOnly(childExpr),
          value: lowerExpr(childExpr),
        });
        for (const nested of parts) {
          if (nested !== childExpr && nested.text !== ";") collect(nested);
        }
      } else {
        expr = lowerExpr(childExpr);
      }
    } else if (child.type === "BlockLetDecl") {
      statements.push(lowerLet(child));
    } else if (child.type === "BlockProofConstDecl") {
      statements.push(lowerProofConst(child));
    } else if (child.type === "DebugTraceStmt") {
      statements.push(lowerDebugTrace(child));
    } else if (child.type === "Expr") {
      expr = lowerExpr(child);
    } else {
      for (const nested of named(child)) collect(nested);
    }
  };
  for (const child of named(block)) collect(child);
  return {
    kind: "do",
    ...spanOnly(node),
    strategy: {
      ...spanOnly(strategy),
      name: first(strategy, "StaticBuiltin").text.replace(/^@/, ""),
      hasEffect: optional(strategy, "TypeExpr") !== undefined,
      effect: optional(strategy, "TypeExpr")
        ? lowerTypeExpr(first(strategy, "TypeExpr"))
        : { kind: "type_ref", ...spanOnly(strategy), name: "io" },
    },
    statements,
    expr,
  };
}

function lowerRange(node: Node): Expr {
  const values = named(node).filter((child) => child.type === "Binary" || child.type === "Expr");
  if (values.length === 1) return lowerExpr(values[0]);
  if (values.length === 2) {
    return {
      kind: "range",
      ...spanOnly(node),
      start: lowerExpr(values[0]),
      end: lowerExpr(values[1]),
    };
  }
  return unreachable(node, "range expression");
}

function lowerBinary(node: Node): Expr {
  const parts = named(node);
  const values: Expr[] = [];
  const ops: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    if (index % 2 === 0) values.push(lowerCall(parts[index]));
    else ops.push(parts[index].text);
  }
  if (!ops.length) return values[0] ?? { kind: "literal", literalKind: "number", value: "0" };
  return {
    kind: "operator_chain",
    ...spanOnly(node),
    first: values[0] ?? { kind: "literal", literalKind: "number", value: "0" },
    rest: ops.map((op, index) => ({
      op,
      value: values[index + 1] ?? { kind: "literal", literalKind: "number", value: "0" },
    })),
  };
}

function lowerPipeBind(node: Node): Expr {
  const children = named(node);
  let current = lowerExpr(optional(node, "PipeBindAtom") ?? first(node, "CollectionPipeBindAtom"));
  for (let index = 0; index < children.length; index++) {
    const name = children[index];
    if (name.type !== "PipeBindName") continue;
    const body = children.slice(index + 1).find((child) =>
      child.type === "PipeBindAtom" || child.type === "CollectionPipeBindAtom"
    );
    if (!body) return current;
    const bindName = text(named(name)[0] ?? name, "pipe bind name");
    const loweredBody = lowerPipeBindBody(body, bindName);
    current = {
      kind: "pipe_bind",
      span: joinSpans(current.span, loweredBody.span),
      value: current,
      name: bindName,
      ...doc(name),
      body: loweredBody,
    };
  }
  return current;
}

function lowerPipeBindBody(node: Node, _bindName: string): Expr {
  return lowerExpr(node);
}

function lowerCall(node: Node): Expr {
  const children = named(node);
  let expr = lowerPrimary(children[0]);
  const isZeroArgCall = !optional(children[0], "ScalarDomainType") &&
    !children.some(is("Args")) && /\)\s*$/.test(node.text);
  let pendingMember: { receiver: Expr; member: string } | undefined;
  let associatedTail = false;
  for (let i = 1; i < children.length; i++) {
    const child = children[i];
    if (child.type === "Args") {
      if (pendingMember) {
        expr = {
          kind: "call",
          ...spanOnly(child),
          callee: {
            kind: "var",
            span: spanFor(child),
            name: receiverMemberName(pendingMember.receiver, pendingMember.member),
          },
          args: [pendingMember.receiver, ...lowerArgs(child)],
        };
        pendingMember = undefined;
      } else {
        expr = { kind: "call", ...spanOnly(child), callee: expr, args: lowerArgs(child) };
        if (expr.callee.kind === "var" && expr.callee.name === "@field" && expr.args.length === 2) {
          expr = { kind: "field", span: expr.span, value: expr.args[0], key: expr.args[1] };
        }
      }
    } else if (child.type === "TypeAssociatedTail") {
      expr = {
        kind: "var",
        ...spanOnly(child),
        name: `${nameOf(expr)}::${text(firstIdentifier(child), "associated member")}`,
      };
      associatedTail = false;
    } else if (child.text === "::") {
      associatedTail = true;
    } else if (
      child.type === "LowerIdent" || child.type === "PascalIdent" ||
      child.type === "ScalarCarrier" || child.type === "Ident"
    ) {
      if (associatedTail) {
        expr = { kind: "var", ...spanOnly(child), name: `${nameOf(expr)}::${child.text}` };
        associatedTail = false;
      } else if (
        (expr.kind === "call" || expr.kind === "range") &&
        (nextNamedCallChild(children, i)?.type === "Args" || children[i + 1]?.type === "(")
      ) {
        pendingMember = { receiver: expr, member: child.text };
      } else if (expr.kind !== "var") {
        expr = {
          kind: "field",
          ...spanOnly(child),
          value: expr,
          key: {
            kind: "literal",
            ...spanOnly(child),
            literalKind: "literalType",
            value: `#${child.text}`,
          },
        };
      } else {
        expr = { kind: "var", ...spanOnly(child), name: `${nameOf(expr)}.${child.text}` };
      }
    } else if (child.type === ")" && pendingMember) {
      expr = {
        kind: "call",
        ...spanOnly(child),
        callee: {
          kind: "var",
          span: spanFor(child),
          name: receiverMemberName(pendingMember.receiver, pendingMember.member),
        },
        args: [pendingMember.receiver],
      };
      pendingMember = undefined;
    } else if (child.type === "Expr") {
      const index = lowerExpr(child);
      if (index.kind === "literal" && index.literalKind === "number") {
        expr = {
          kind: "var",
          span: joinSpans(expr.span, index.span),
          name: `${nameOf(expr)}[${index.value}]`,
        };
      } else {
        expr = { kind: "index", span: joinSpans(expr.span, index.span), target: expr, index };
      }
    } else if (child.type === "ShapeValue") {
      if (expr.kind !== "var") {
        fail("parse.lower", "product constructor requires a named constructor", spanFor(child));
      }
      const shape = lowerShapeValue(child);
      if (shape.kind !== "shape") return unreachable(child, "shape value");
      expr = {
        kind: "product_constructor",
        span: joinSpans(expr.span, shape.span),
        constructor: expr.name,
        slots: shape.slots,
      };
    }
  }
  if (isZeroArgCall) {
    return { kind: "call", ...spanOnly(node), callee: expr, args: [] };
  }
  return expr;
}

function nextNamedCallChild(children: readonly Node[], index: number): Node | undefined {
  return children.slice(index + 1).find((child) => !isCallPunctuation(child));
}

function isCallPunctuation(node: Node): boolean {
  return ["(", ")", ".", "::", ","].includes(node.type);
}

function receiverMemberName(receiver: Expr, member: string): string {
  if (receiver.kind === "range") return `RangeI32.${member}`;
  if (receiver.kind === "call" && receiver.callee.kind === "var") {
    const owner = iteratorReceiverOwner(receiver.callee.name);
    if (owner) return `${owner}.${member}`;
  }
  return member;
}

function iteratorReceiverOwner(callee: string): string | undefined {
  if (callee.endsWith(".layout.InlineArray.iter")) {
    return `${callee.slice(0, -".layout.InlineArray.iter".length)}.iter`;
  }
  if (callee === "InlineArray.iter" || callee.startsWith("Iter.")) return "iter";
  if (callee === "layout.InlineArray.iter") return "iter";
  if (callee === "CompactArray.iter" || callee.startsWith("CompactIter.")) return "compact_iter";
  if (callee === "RangeI32.iter" || callee.startsWith("RangeIter.")) return "range_iter";
  return undefined;
}

function lowerPrimary(node: Node): Expr {
  const child = named(node)[0];
  if (!child) {
    return unreachable(node, "primary");
  }
  switch (child.type) {
    case "DoExpr":
      return lowerDoExpr(child);
    case "Literal":
      return lowerLiteral(child);
    case "StaticBuiltin":
      return {
        kind: "var",
        ...meta(child, firstStaticBuiltinName(child)),
        name: `@${lowerStaticBuiltinName(child)}`,
      };
    case "TypeBuilderName":
      return { kind: "var", ...spanOnly(child), name: child.text };
    case "ScalarDomainType":
      return { kind: "var", ...spanOnly(child), name: child.text.replace(/\s+/g, "") };
    case "ScalarCarrier":
      return { kind: "var", ...spanOnly(child), name: child.text };
    case "PascalIdent":
    case "LowerIdent": {
      const tail = optional(node, "ProductConstructorTail");
      if (tail) {
        const source = tail.text.trim();
        if (/^\[\s*[0-9]+(\.[0-9]+)?[A-Za-z0-9_]*\s*\]$/.test(source)) {
          return {
            kind: "var",
            span: joinSpans(spanFor(child), spanFor(tail)),
            name: `${child.text}${source.replace(/\s+/g, "")}`,
          };
        }
        const shape = lowerShapeValue(only(tail, "ShapeValue"));
        if (shape.kind !== "shape") return unreachable(tail, "shape value");
        return {
          kind: "product_constructor",
          span: joinSpans(spanFor(child), shape.span),
          constructor: child.text,
          slots: shape.slots,
        };
      }
      return { kind: "var", ...meta(child, child), name: child.text };
    }
    case "ParenExpr":
      return lowerExpr(first(child, "Expr"));
    case "Expr":
      return lowerExpr(child);
    case "ProfileExpr":
      return lowerProfileExpr(child);
    case "ShapeValue":
      return lowerShapeValue(child);
    case "CollectionValue":
      return lowerCollectionValue(child);
    case "TupleValue":
      return lowerTupleValue(child);
    case "Block":
      return lowerBlock(child);
    default:
      return unreachable(child, "primary");
  }
}

function lowerShapeValue(node: Node): Expr {
  const slots = canonicalizeSlots(
    lowerShapeValueItems(optional(node, "ShapeValueItems") ?? node),
    "record value",
  );
  if (slots.length === 0) return { kind: "shape", syntax: "record", ...spanOnly(node), slots: [] };
  return {
    kind: "shape",
    syntax: "record",
    ...spanOnly(node),
    slots,
  };
}

function lowerShapeValueItems(node: Node): Extract<Expr, { kind: "shape" }>["slots"] {
  const spread = named(node).find(is("SpreadSlot"));
  if (spread) {
    return [{
      ...spanOnly(spread),
      spread: true,
      value: lowerExpr(first(spread, "Expr")),
    }, ...lowerShapeValueTail(node)];
  }
  const punned = optional(node, "PunnedShapeValueSlot");
  if (punned) {
    const name = first(punned, "LowerIdent").text;
    return [{
      ...meta(punned, first(punned, "LowerIdent")),
      ...doc(punned),
      label: name,
      value: { kind: "var", ...meta(punned, first(punned, "LowerIdent")), name },
    }, ...lowerShapeValueTail(node)];
  }
  const expr =
    named(node).find((child) =>
      child.type === "Expr" || child.type === "CollectionExpr" ||
      child.type === "CollectionPipeBind" || child.type === "CollectionPipeBindAtom" ||
      child.type === "CollectionBinary" || child.type === "Call"
    ) ?? descendants(node, "CollectionExpr")[0] ?? descendants(node, "Expr")[0];
  if (!expr) return [];
  const key = optional(node, "ShapeValueSlotKey");
  return [{
    ...meta(node, slotLabelNode(key)),
    ...doc(node),
    ...slotKeyParts(key),
    value: lowerExpr(expr),
  }, ...lowerShapeValueTail(node)];
}

function lowerShapeValueTail(node: Node): Extract<Expr, { kind: "shape" }>["slots"] {
  const tail = named(node).find(is("ShapeValueTail"));
  const tailItems = tail ? named(tail).find(is("ShapeValueItems")) : undefined;
  return tailItems ? lowerShapeValueItems(tailItems) : [];
}

function lowerCollectionValue(node: Node): Expr {
  return {
    kind: "shape",
    syntax: "collection",
    ...spanOnly(node),
    slots: lowerCollectionValueItems(optional(node, "CollectionValueItems") ?? node),
  };
}

function lowerCollectionValueItems(node: Node): Extract<Expr, { kind: "shape" }>["slots"] {
  const spread = named(node).find((child) =>
    child.type === "SpreadSlot" || child.type === "CollectionSpreadSlot"
  );
  if (spread) {
    return [{
      ...spanOnly(spread),
      spread: true,
      value: lowerExpr(optional(spread, "Expr") ?? first(spread, "CollectionExpr")),
    }, ...lowerCollectionValueTail(node)];
  }
  const override = named(node).find(is("CollectionOverrideSlot"));
  if (override) {
    return [{
      ...spanOnly(override),
      index: lowerExpr(first(override, "Expr")),
      value: lowerExpr(first(override, "CollectionExpr")),
    }, ...lowerCollectionValueTail(node)];
  }
  const expr =
    named(node).find((child) =>
      child.type === "Expr" || child.type === "CollectionExpr" ||
      child.type === "CollectionPipeBind" || child.type === "CollectionPipeBindAtom" ||
      child.type === "CollectionBinary" || child.type === "Call"
    ) ?? descendants(node, "CollectionExpr")[0] ?? descendants(node, "Expr")[0];
  if (!expr) return [];
  return [{
    ...spanOnly(expr),
    value: lowerExpr(expr),
  }, ...lowerCollectionValueTail(node)];
}

function lowerCollectionValueTail(node: Node): Extract<Expr, { kind: "shape" }>["slots"] {
  const tail = named(node).find(is("CollectionValueTail"));
  const tailItems = tail ? named(tail).find(is("CollectionValueItems")) : undefined;
  return tailItems ? lowerCollectionValueItems(tailItems) : [];
}

function lowerTupleValue(node: Node): Expr {
  const repeat = optional(node, "TupleValueRepeat");
  if (repeat) {
    const value = lowerExpr(first(repeat, "Expr"));
    const count = lowerTupleRepeatCount(first(repeat, "TypeRepeatCount"));
    return {
      kind: "shape",
      syntax: "record",
      ...spanOnly(node),
      slots: expandRepeatedValueSlot(value, count, spanOnly(repeat)),
    };
  }
  const items = optional(node, "TupleValueItems") ?? node;
  const slots = lowerTupleValueItems(items);
  if (slots.some((slot) => slot.spread || slot.index)) {
    return {
      kind: "shape",
      syntax: "record",
      ...spanOnly(node),
      slots,
    };
  }
  const exprs = listTupleItems(node, "Expr");
  return {
    kind: "shape",
    syntax: "record",
    ...spanOnly(node),
    slots: exprs.map((expr, position) => ({
      ...spanOnly(expr),
      position,
      value: lowerExpr(expr),
    })),
  };
}

function lowerTupleValueItems(node: Node): Extract<Expr, { kind: "shape" }>["slots"] {
  const spread = named(node).find(is("TupleSpreadSlot"));
  if (spread) {
    return [{
      ...spanOnly(spread),
      spread: true,
      value: lowerExpr(first(spread, "Expr")),
    }, ...lowerTupleValueTail(node)];
  }
  const override = named(node).find(is("TupleOverrideSlot"));
  if (override) {
    const exprs = named(override).filter(is("Expr"));
    return [{
      ...spanOnly(override),
      index: lowerExpr(exprs[0] ?? first(override, "Expr")),
      value: lowerExpr(exprs[1] ?? first(override, "Expr")),
    }, ...lowerTupleValueTail(node)];
  }
  const expr = named(node).find(is("Expr"));
  if (!expr) return [];
  return [{
    ...spanOnly(expr),
    position: 0,
    value: lowerExpr(expr),
  }, ...lowerTupleValueTail(node)].map((slot, position) =>
    slot.spread || slot.index ? slot : { ...slot, position }
  );
}

function lowerTupleValueTail(node: Node): Extract<Expr, { kind: "shape" }>["slots"] {
  const tail = named(node).find(is("TupleValueTail"));
  const tailItems = tail ? named(tail).find(is("TupleValueItems")) : undefined;
  return tailItems ? lowerTupleValueItems(tailItems) : [];
}

function expandRepeatedValueSlot(
  value: Expr,
  count: TypeCountExpr,
  meta: AstNodeMeta,
): Extract<Expr, { kind: "shape" }>["slots"] {
  if (count.kind === "count_literal") {
    return Array.from({ length: count.value }, (_, position) => ({
      ...meta,
      position,
      value,
    }));
  }
  return [{ ...meta, position: 0, value, repeat: count }];
}

function listTupleItems(node: Node, type: "Expr" | "TypeExpr" | "Pattern"): Node[] {
  const found: Node[] = [];
  for (const child of named(node)) {
    if (child.type === type) found.push(child);
    else if (
      child.type === "TupleValue" || child.type === "TupleValueItems" ||
      child.type === "TupleValueTail" || child.type === "TypeTuple" ||
      child.type === "TypeTupleBody" || child.type === "TypeTupleTail" ||
      child.type === "TuplePattern" || child.type === "TuplePatternItems" ||
      child.type === "TuplePatternTail"
    ) {
      found.push(...listTupleItems(child, type));
    }
  }
  return found;
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
    ...spanOnly(literal),
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

function descendantLowerIdents(node: Node): Node[] {
  const result: Node[] = [];
  const visit = (item: Node) => {
    if (item.type === "LowerIdent") result.push(item);
    for (const child of named(item)) visit(child);
  };
  visit(node);
  return result;
}

function docText(node: Node | undefined): string | undefined {
  return resolveDoc(node?.startIndex);
}

function doc(node: Node | undefined): { doc?: string } {
  const value = docText(node);
  return value === undefined ? {} : { doc: value };
}

function docsByName(nodes: Node[]): Record<string, string> | undefined {
  const entries = nodes.flatMap((node): [string, string][] => {
    const value = docText(node);
    return value === undefined ? [] : [[bindingName(node), value]];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function spansByName(nodes: Node[]): Record<string, Span> | undefined {
  const entries = nodes.flatMap((node): [string, Span][] => {
    const span = spanFor(node);
    return span ? [[bindingName(node), span]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function spanOnly(node: Node | undefined): { span?: Span } {
  const span = node ? spanFor(node) : undefined;
  return span ? { span } : {};
}

function meta(node: Node | undefined, nameNode?: Node): { span?: Span; nameSpan?: Span } {
  const span = node ? spanFor(node) : undefined;
  const nameSpan = nameNode ? spanFor(nameNode) : undefined;
  return {
    ...(span ? { span } : {}),
    ...(nameSpan ? { nameSpan } : {}),
  };
}

function joinSpans(left: Span | undefined, right: Span | undefined): Span | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    ...left,
    start: Math.min(left.start, right.start),
    end: Math.max(left.end, right.end),
  };
}

function only(node: Node, type: string): Node {
  const found = named(node).find(is(type));
  if (!found) return unreachable(node, type);
  return found;
}

function optional(node: Node, type: string): Node | undefined {
  return named(node).find(is(type));
}

function descendants(node: Node, type: string): Node[] {
  return named(node).flatMap((child) => child.type === type ? [child] : descendants(child, type));
}

function listSlots(node: Node, type: string): Node[] {
  const found: Node[] = [];
  for (const child of named(node)) {
    if (child.type === type) found.push(child);
    else if (isShapeListContainer(child.type)) found.push(...listSlots(child, type));
  }
  return found;
}

function isShapeListContainer(type: string): boolean {
  return type === "ShapeValue" || type === "ShapeValueItems" || type === "ShapeValueTail" ||
    type === "ShapeType" || type === "ShapeTypeBody" || type === "ShapeTypeTail" ||
    type === "TypeShape" || type === "TypeShapeBody" || type === "TypeShapeTail";
}

function first(node: Node, type: string): Node {
  return only(node, type);
}

function isIdentifier(node: Node | undefined): node is Node {
  return node?.type === "LowerIdent" || node?.type === "PascalIdent" ||
    node?.type === "ScalarCarrier" || node?.type === "Ident";
}

function identifierDescendants(node: Node): Node[] {
  return descendants(node, "LowerIdent")
    .concat(descendants(node, "PascalIdent"))
    .concat(descendants(node, "ScalarCarrier"))
    .sort((left, right) => (left.startIndex ?? 0) - (right.startIndex ?? 0));
}

function isFieldName(node: Node | undefined): node is Node {
  return node?.type === "FieldName";
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

function firstStaticBuiltinName(node: Node): Node {
  const found = named(node).find(isIdentifier);
  if (found) return found;
  if (node.type === "StaticBuiltin" && compilerSpecialForm(node.text)) return node;
  return unreachable(node, "static builtin");
}

function lowerStaticBuiltinName(node: Node): string {
  const found = named(node).find(isIdentifier);
  return found ? text(found, "static builtin") : node.text.replace(/^@/, "");
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
    ...(currentSourceId ? { sourceId: currentSourceId } : {}),
  };
}

function spanFromOffsets(start: number | undefined, end: number | undefined): Span | undefined {
  if (start === undefined || end === undefined) return undefined;
  return {
    start,
    end,
    line: 1,
    column: 1,
    ...(currentSourceId ? { sourceId: currentSourceId } : {}),
  };
}
