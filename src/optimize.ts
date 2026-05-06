import type { BlockExpr, Declaration, Expr, FnDecl, Program, Statement } from "./core_ast.ts";

export function optimizeProgram(program: Program): Program {
  const optimized = structuredClone(program) as Program;
  const functions = new Map(
    optimized.declarations
      .filter((decl): decl is FnDecl => decl.kind === "fn")
      .map((decl) => [decl.name, decl]),
  );
  const forwarding = forwardingWrappers(functions);

  optimized.declarations = optimized.declarations.map((decl) => optimizeDecl(decl, forwarding));
  return optimized;
}

function forwardingWrappers(functions: Map<string, FnDecl>): Map<string, string> {
  const direct = new Map<string, string>();
  for (const fn of functions.values()) {
    const target = directForwardingTarget(fn);
    if (target && functions.has(target)) direct.set(fn.name, target);
  }

  const resolved = new Map<string, string>();
  for (const name of direct.keys()) {
    const target = resolveForwardingTarget(name, direct, functions);
    if (target) resolved.set(name, target);
  }
  return resolved;
}

function directForwardingTarget(fn: FnDecl): string | undefined {
  if (!fn.generated || fn.body.statements.length !== 0) return undefined;
  const expr = fn.body.expr;
  if (!expr || expr.kind !== "call" || expr.callee.kind !== "var") return undefined;
  if (expr.args.length !== fn.params.length) return undefined;
  for (let index = 0; index < fn.params.length; index++) {
    const arg = expr.args[index];
    if (arg.kind !== "var" || arg.name !== fn.params[index].name) return undefined;
  }
  return expr.callee.name;
}

function resolveForwardingTarget(
  name: string,
  direct: Map<string, string>,
  functions: Map<string, FnDecl>,
): string | undefined {
  const seen = new Set<string>([name]);
  let target = direct.get(name);
  while (target) {
    if (seen.has(target)) return undefined;
    seen.add(target);
    const fn = functions.get(target);
    if (!fn) return undefined;
    if (!fn.generated) return target;
    target = direct.get(target);
  }
  return undefined;
}

function optimizeDecl(decl: Declaration, forwarding: Map<string, string>): Declaration {
  if (decl.kind === "fn") return { ...decl, body: optimizeBlock(decl.body, forwarding) };
  if (decl.kind === "let" || decl.kind === "const") {
    return { ...decl, value: optimizeExpr(decl.value, forwarding) };
  }
  return decl;
}

function optimizeBlock(block: BlockExpr, forwarding: Map<string, string>): BlockExpr {
  return {
    ...block,
    statements: block.statements.map((stmt) => optimizeStatement(stmt, forwarding)),
    expr: block.expr ? optimizeExpr(block.expr, forwarding) : undefined,
  };
}

function optimizeStatement(stmt: Statement, forwarding: Map<string, string>): Statement {
  if (stmt.kind !== "let") return stmt;
  return { ...stmt, value: optimizeExpr(stmt.value, forwarding) };
}

function optimizeExpr(expr: Expr, forwarding: Map<string, string>): Expr {
  switch (expr.kind) {
    case "call": {
      const callee = optimizeExpr(expr.callee, forwarding);
      const args = expr.args.map((arg) => optimizeExpr(arg, forwarding));
      if (callee.kind === "var") {
        const target = forwarding.get(callee.name);
        if (target) return { ...expr, callee: { kind: "var", name: target }, args };
      }
      return { ...expr, callee, args };
    }
    case "binary":
      return {
        ...expr,
        left: optimizeExpr(expr.left, forwarding),
        right: optimizeExpr(expr.right, forwarding),
      };
    case "match":
      return {
        ...expr,
        value: optimizeExpr(expr.value, forwarding),
        arms: expr.arms.map((arm) => ({ ...arm, value: optimizeExpr(arm.value, forwarding) })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({ ...slot, value: optimizeExpr(slot.value, forwarding) })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({ ...slot, value: optimizeExpr(slot.value, forwarding) })),
      };
    case "range":
      return {
        ...expr,
        start: optimizeExpr(expr.start, forwarding),
        end: optimizeExpr(expr.end, forwarding),
      };
    case "block":
      return optimizeBlock(expr, forwarding);
    case "literal":
    case "var":
      return expr;
  }
}
