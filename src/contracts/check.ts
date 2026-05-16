import type { BlockExpr, ContractDecl, Expr, FnDecl, Program, TypeDecl } from "../core_ast.ts";
import type { Diagnostic, Span } from "../diagnostics.ts";

export interface ContractCheckCallbacks {
  inferRuntimeType(
    expr: Expr,
    env: Map<string, string>,
    functions: Map<string, FnDecl>,
    constructorTypes: Map<string, TypeDecl>,
  ): string | undefined;
  runtimeValueTypeAssignable(left: string, right: string): boolean;
}

export function collectContracts(program: Program): ContractDecl[] {
  return program.declarations.filter((decl): decl is ContractDecl => decl.kind === "contract");
}

export function checkContracts(
  program: Program,
  diagnostics: Diagnostic[],
  callbacks: ContractCheckCallbacks,
) {
  checkRewriteDecls(program, collectContracts(program), diagnostics, callbacks);
  checkRewriteTypeMisuse(program, diagnostics);
}

function diagnosticAt(
  code: string,
  message: string,
  spanLike?: { span?: Span; nameSpan?: Span },
): Diagnostic {
  return { code, message, span: spanLike?.nameSpan ?? spanLike?.span };
}

function checkRewriteDecls(
  program: Program,
  contracts: ContractDecl[],
  diagnostics: Diagnostic[],
  callbacks: ContractCheckCallbacks,
) {
  const knownNames = new Set(program.declarations.map((decl) => decl.name));
  const functions = new Map(
    program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn").map((decl) => [
      decl.name,
      decl,
    ]),
  );
  const constructorTypes = new Map(
    program.declarations.flatMap((decl) =>
      decl.kind === "type" && decl.normalized?.kind === "product"
        ? [[decl.normalized.constructor, decl] as const]
        : []
    ),
  );
  for (const decl of contracts) {
    for (const param of decl.params) {
      if (!param.const) {
        diagnostics.push(diagnosticAt(
          "rewrite.param_must_be_const",
          `contract fn rewrite parameter ${param.name} must be const`,
          param,
        ));
      }
    }
    const assume = rewriteAssumeCall(decl.body.expr);
    if (decl.body.statements.some((stmt) => stmt.kind !== "proof_const") || !assume) {
      diagnostics.push(diagnosticAt(
        "rewrite.body",
        "contract fn ... -> rewrite body must end with @assume(lhs_template, rhs_template) and only const proof statements",
        decl.body,
      ));
      continue;
    }
    if (assume.args.length !== 2) {
      diagnostics.push(diagnosticAt(
        "rewrite.assume_arity",
        "@assume requires exactly two const-function templates",
        assume,
      ));
      continue;
    }
    const [left, right] = assume.args;
    if (left?.kind !== "const_fn" || right?.kind !== "const_fn") {
      diagnostics.push(diagnosticAt(
        "rewrite.assume_template",
        "@assume arguments must be const-function templates",
        assume,
      ));
      continue;
    }
    if (left.params.length !== right.params.length) {
      diagnostics.push(diagnosticAt(
        "rewrite.assume_template_arity",
        "@assume templates must have the same arity",
        assume,
      ));
      continue;
    }
    for (let index = 0; index < left.params.length; index++) {
      if (left.params[index] !== right.params[index]) {
        diagnostics.push(diagnosticAt(
          "rewrite.assume_template_params",
          "@assume template parameters must align by position",
          assume,
        ));
        break;
      }
    }
    checkRewriteTemplateMetavariables(left, right, knownNames, diagnostics, assume);
    const leftType = callbacks.inferRuntimeType(left.body, new Map(), functions, constructorTypes);
    const rightType = callbacks.inferRuntimeType(
      right.body,
      new Map(),
      functions,
      constructorTypes,
    );
    if (
      leftType && rightType &&
      !rewriteResultTypesCompatible(leftType, rightType, callbacks.runtimeValueTypeAssignable)
    ) {
      diagnostics.push(diagnosticAt(
        "rewrite.assume_result_type",
        `@assume templates must have compatible result types, got ${leftType} and ${rightType}`,
        assume,
      ));
    }
  }
}

function rewriteResultTypesCompatible(
  left: string,
  right: string,
  runtimeValueTypeAssignable: (left: string, right: string) => boolean,
): boolean {
  if (left === right) return true;
  const scalarTypes = new Set(["bool", "i32", "u32", "i64", "u64", "f32", "f64"]);
  if (scalarTypes.has(left) || scalarTypes.has(right)) return false;
  return runtimeValueTypeAssignable(left, right);
}

function rewriteAssumeCall(expr: Expr | undefined): Extract<Expr, { kind: "call" }> | undefined {
  return expr?.kind === "call" && expr.callee.kind === "var" && expr.callee.name === "@assume"
    ? expr
    : undefined;
}

function checkRewriteTemplateMetavariables(
  left: Extract<Expr, { kind: "const_fn" }>,
  right: Extract<Expr, { kind: "const_fn" }>,
  knownNames: Set<string>,
  diagnostics: Diagnostic[],
  spanLike: { span?: Span; nameSpan?: Span },
) {
  const params = new Set(left.params);
  const leftNames = rewriteTemplateFreeNames(left.body, params);
  const rightNames = rewriteTemplateFreeNames(right.body, params);
  for (const name of rightNames) {
    if (leftNames.has(name) || knownNames.has(name) || name.includes(".") || name.includes("::")) {
      continue;
    }
    diagnostics.push(diagnosticAt(
      "rewrite.assume_rhs_unknown",
      `@assume RHS references unknown template value ${name}`,
      spanLike,
    ));
  }
}

function rewriteTemplateFreeNames(expr: Expr, params: Set<string>): Set<string> {
  const names = new Set<string>();
  const visit = (item: Expr | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "var":
        if (!params.has(item.name)) names.add(item.name);
        return;
      case "const_fn": {
        const scoped = new Set([...params, ...item.params]);
        for (const name of rewriteTemplateFreeNames(item.body, scoped)) names.add(name);
        return;
      }
      default:
        for (const child of exprChildren(item)) visit(child);
    }
  };
  visit(expr);
  return names;
}

function checkRewriteTypeMisuse(program: Program, diagnostics: Diagnostic[]) {
  const checkTypeText = (
    type: string | undefined,
    spanLike: { span?: Span; nameSpan?: Span } | undefined,
  ) => {
    if (!type) return;
    if (/\brewrite\b/.test(type)) {
      diagnostics.push(diagnosticAt(
        "rewrite.not_runtime_type",
        "rewrite is not a runtime type; use contract fn ... -> rewrite",
        spanLike,
      ));
    }
  };
  const checkBlock = (block: BlockExpr) => {
    for (const stmt of block.statements) {
      if (stmt.kind === "let") checkTypeText(stmt.type, stmt);
      if (stmt.kind === "let" || stmt.kind === "destructure_let") checkExpr(stmt.value);
    }
    if (block.expr) checkExpr(block.expr);
  };
  const checkExpr = (expr: Expr) => {
    if (expr.kind === "call" && expr.callee.kind === "var" && expr.callee.name === "@assume") {
      diagnostics.push(diagnosticAt(
        "rewrite.assume_context",
        "@assume is only valid inside a contract fn ... -> rewrite body",
        expr,
      ));
    }
    if (expr.kind === "block") {
      checkBlock(expr);
      return;
    }
    for (const child of exprChildren(expr)) checkExpr(child);
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      checkTypeText(decl.returnType, decl);
      for (const param of decl.params) checkTypeText(param.type, param);
      checkBlock(decl.body);
    } else if (decl.kind === "let" || decl.kind === "const") {
      checkTypeText(decl.type, decl);
      checkExpr(decl.value);
    } else if (decl.kind === "contract") {
      for (const param of decl.params) checkTypeText(param.type, param);
    }
  }
}

function exprChildren(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "call":
      return [expr.callee, ...expr.args];
    case "const_fn":
      return [expr.body];
    case "index":
      return [expr.target, expr.index];
    case "binary":
      return [expr.left, expr.right];
    case "pipe_bind":
      return [expr.value, expr.body];
    case "match":
      return [expr.value, ...expr.arms.map((arm) => arm.value)];
    case "shape":
    case "product_constructor":
      return expr.slots.flatMap((slot) => slot.index ? [slot.index, slot.value] : [slot.value]);
    case "static_for_slots":
      return [
        ...(expr.source.kind === "range"
          ? [expr.source.start, expr.source.end]
          : [expr.source.shape]),
        expr.value,
      ];
    case "field":
      return [expr.value, expr.key];
    case "range":
      return [expr.start, expr.end];
    case "block":
      return [
        ...expr.statements.flatMap((stmt) => stmt.kind === "proof_const" ? [] : [stmt.value]),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "do":
      return [
        ...expr.statements.flatMap((stmt) =>
          stmt.kind === "proof_const" ? [] : "value" in stmt ? [stmt.value] : []
        ),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "literal":
    case "var":
    case "placeholder":
      return [];
  }
}
