import type { BlockExpr, Expr, FnDecl, Program, Statement, TypeDecl } from "./core_ast.ts";
import type { Diagnostic, Span } from "./diagnostics.ts";
import type { CompilerPluginRegistry, CompilerRewriteRule } from "./plugins.ts";
import { parseSync } from "./parser.ts";

export interface RewriteTemplate {
  params: string[];
  body: Expr;
}

export interface RewriteFact {
  source: string;
  owner?: string;
  generic?: {
    contract: string;
    typeParam: string;
  };
  left: RewriteTemplate;
  right: RewriteTemplate;
}

export interface RewriteCheckCallbacks {
  inferRuntimeType(
    expr: Expr,
    env: Map<string, string>,
    functions: Map<string, FnDecl>,
    constructorTypes: Map<string, TypeDecl>,
  ): string | undefined;
  runtimeValueTypeAssignable(left: string, right: string): boolean;
}

export function checkPluginRewrites(
  program: Program,
  diagnostics: Diagnostic[],
  callbacks: RewriteCheckCallbacks,
  registry: CompilerPluginRegistry,
) {
  const knownNames = new Set<string>();
  const functions = new Map<string, FnDecl>();
  const constructorTypes = new Map<string, TypeDecl>();
  for (const decl of program.declarations) {
    if ("name" in decl) knownNames.add(decl.name);
    if (decl.kind === "fn") functions.set(decl.name, decl);
    if (decl.kind === "type" && decl.normalized?.kind === "product") {
      constructorTypes.set(decl.normalized.constructor, decl);
    }
  }

  for (const rule of registry.rewriteRules) {
    const parsed = parseRewriteRule(rule, diagnostics);
    if (!parsed) continue;
    if (rule.validate === false) continue;
    validateRewriteRuleTemplates(rule, parsed.left, parsed.right, knownNames, diagnostics);
    validateRewriteRuleResultTypes(
      rule,
      parsed.left,
      parsed.right,
      callbacks,
      functions,
      constructorTypes,
      diagnostics,
    );
  }
}

export function rewriteFactsFromRegistry(
  registry: CompilerPluginRegistry,
  diagnostics?: Diagnostic[],
): RewriteFact[] {
  const facts: RewriteFact[] = [];
  const target = diagnostics ?? [];
  for (const rule of registry.rewriteRules) {
    const parsed = parseRewriteRule(rule, target);
    if (!parsed) continue;
    if (!templatesHaveAlignedParams(parsed.left, parsed.right)) continue;
    facts.push({
      source: rule.name,
      ...(rule.owner ? { owner: rule.owner } : {}),
      ...(rule.generic ? { generic: rule.generic } : {}),
      left: parsed.left,
      right: parsed.right,
    });
  }
  return facts;
}

function parseRewriteRule(
  rule: CompilerRewriteRule,
  diagnostics: Diagnostic[],
): { left: RewriteTemplate; right: RewriteTemplate } | undefined {
  const left = parseRewriteTemplate(rule.left, rule.name, "left", diagnostics);
  const right = parseRewriteTemplate(rule.right, rule.name, "right", diagnostics);
  if (!left || !right) return undefined;
  return { left, right };
}

function parseRewriteTemplate(
  source: string,
  ruleName: string,
  side: string,
  diagnostics: Diagnostic[],
): RewriteTemplate | undefined {
  try {
    const program = parseSync(`const __rewrite_template = ${source};`);
    const decl = program.declarations[0];
    if (decl?.kind === "const" && decl.value.kind === "const_fn") {
      return { params: decl.value.params, body: decl.value.body };
    }
  } catch (error) {
    const diagnostic = firstCompileDiagnostic(error);
    diagnostics.push({
      code: "plugin.rewrite",
      message: `rewrite rule ${ruleName} ${side} template does not parse: ${
        diagnostic?.message ?? String(error)
      }`,
      span: diagnostic?.span,
    });
    return undefined;
  }
  diagnostics.push({
    code: "plugin.rewrite",
    message: `rewrite rule ${ruleName} ${side} template must be a const function`,
  });
  return undefined;
}

function firstCompileDiagnostic(error: unknown): Diagnostic | undefined {
  if (!error || typeof error !== "object") return undefined;
  const diagnostics = (error as { diagnostics?: Diagnostic[] }).diagnostics;
  return diagnostics?.[0];
}

function validateRewriteRuleTemplates(
  rule: CompilerRewriteRule,
  left: RewriteTemplate,
  right: RewriteTemplate,
  knownNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  if (left.params.length !== right.params.length) {
    diagnostics.push({
      code: "plugin.rewrite",
      message: `rewrite rule ${rule.name} templates must have the same arity`,
    });
    return;
  }
  if (!templatesHaveAlignedParams(left, right)) {
    diagnostics.push({
      code: "plugin.rewrite",
      message: `rewrite rule ${rule.name} template parameters must align by position`,
    });
    return;
  }
  checkRewriteTemplateMetavariables(rule, left, right, knownNames, diagnostics);
}

function templatesHaveAlignedParams(left: RewriteTemplate, right: RewriteTemplate): boolean {
  if (left.params.length !== right.params.length) return false;
  for (let index = 0; index < left.params.length; index++) {
    if (left.params[index] !== right.params[index]) return false;
  }
  return true;
}

function checkRewriteTemplateMetavariables(
  rule: CompilerRewriteRule,
  left: RewriteTemplate,
  right: RewriteTemplate,
  knownNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  const params = new Set(left.params);
  const leftNames = rewriteTemplateFreeNames(left.body, params);
  const rightNames = rewriteTemplateFreeNames(right.body, params);
  for (const name of rightNames) {
    if (leftNames.has(name)) continue;
    if (knownNames.has(name)) continue;
    if (name.includes(".") || name.includes("::")) continue;
    diagnostics.push({
      code: "plugin.rewrite",
      message: `rewrite rule ${rule.name} RHS references unknown template value ${name}`,
    });
  }
}

function validateRewriteRuleResultTypes(
  rule: CompilerRewriteRule,
  left: RewriteTemplate,
  right: RewriteTemplate,
  callbacks: RewriteCheckCallbacks,
  functions: Map<string, FnDecl>,
  constructorTypes: Map<string, TypeDecl>,
  diagnostics: Diagnostic[],
) {
  const leftType = callbacks.inferRuntimeType(left.body, new Map(), functions, constructorTypes);
  const rightType = callbacks.inferRuntimeType(right.body, new Map(), functions, constructorTypes);
  if (!leftType || !rightType) return;
  const compatible = rewriteResultTypesCompatible(
    leftType,
    rightType,
    callbacks.runtimeValueTypeAssignable,
  );
  if (compatible) return;
  diagnostics.push({
    code: "plugin.rewrite",
    message:
      `rewrite rule ${rule.name} templates must have compatible result types, got ${leftType} and ${rightType}`,
  });
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

function rewriteTemplateFreeNames(expr: Expr, params: Set<string>): Set<string> {
  const names = new Set<string>();
  const visit = (item: Expr | undefined) => {
    if (!item) return;
    if (item.kind === "var") {
      if (!params.has(item.name)) names.add(item.name);
      return;
    }
    if (item.kind === "const_fn") {
      const scoped = new Set(params);
      for (const param of item.params) scoped.add(param);
      for (const name of rewriteTemplateFreeNames(item.body, scoped)) names.add(name);
      return;
    }
    for (const child of exprChildren(item)) visit(child);
  };
  visit(expr);
  return names;
}

function exprChildren(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "call":
      if (expr.tailRec) return expr.args;
      return [expr.callee, ...expr.args];
    case "profile":
      return [...expr.args, expr.body];
    case "const_fn":
      return [expr.body];
    case "index":
      return [expr.target, expr.index];
    case "binary":
      return [expr.left, expr.right];
    case "operator_chain":
      return [expr.first, ...expr.rest.map((item) => item.value)];
    case "pipe_bind":
      return [expr.value, expr.body];
    case "match":
      return [
        expr.value,
        ...expr.arms.flatMap((arm) => arm.guard ? [arm.guard, arm.value] : [arm.value]),
      ];
    case "shape":
    case "product_constructor":
      return expr.slots.flatMap((slot) => {
        if (slot.index) return [slot.index, slot.value];
        return [slot.value];
      });
    case "static_for_slots":
      if (expr.source.kind === "range") {
        return [expr.source.start, expr.source.end, expr.value];
      }
      return [expr.source.shape, expr.value];
    case "field":
      return [expr.value, expr.key];
    case "range":
      return [expr.start, expr.end];
    case "block":
      return blockChildren(expr);
    case "do":
      return [
        ...expr.statements.flatMap((stmt) => {
          if (stmt.kind === "proof_const") return [];
          if ("value" in stmt) return [stmt.value];
          if (stmt.kind === "debug_trace") return stmt.args;
          return [];
        }),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "literal":
    case "var":
      return [];
  }
}

function blockChildren(block: BlockExpr): Expr[] {
  const children: Expr[] = [];
  for (const stmt of block.statements) {
    collectStatementChildren(stmt, children);
  }
  if (block.expr) children.push(block.expr);
  return children;
}

function collectStatementChildren(stmt: Statement, children: Expr[]) {
  if (stmt.kind === "proof_const") return;
  if (stmt.kind === "debug_trace") {
    children.push(...stmt.args);
    return;
  }
  children.push(stmt.value);
}
