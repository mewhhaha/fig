import type { BlockExpr, Declaration, Expr, FnDecl, Program, Statement } from "./core_ast.ts";

export function optimizeProgram(program: Program): Program {
  const optimized = structuredClone(program) as Program;
  const functions = new Map(
    optimized.declarations
      .filter((decl): decl is FnDecl => decl.kind === "fn")
      .map((decl) => [decl.name, decl]),
  );
  const forwarding = forwardingWrappers(functions);

  optimized.declarations = optimized.declarations.map((decl) => optimizeDecl(decl, forwarding, functions));
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

function optimizeDecl(
  decl: Declaration,
  forwarding: Map<string, string>,
  functions: Map<string, FnDecl>,
): Declaration {
  if (decl.kind === "fn") return { ...decl, body: optimizeBlock(decl.body, forwarding, functions) };
  if (decl.kind === "let" || decl.kind === "const") {
    return { ...decl, value: optimizeExpr(decl.value, forwarding, functions) };
  }
  return decl;
}

function optimizeBlock(
  block: BlockExpr,
  forwarding: Map<string, string>,
  functions: Map<string, FnDecl>,
): BlockExpr {
  return {
    ...block,
    statements: block.statements.map((stmt) => optimizeStatement(stmt, forwarding, functions)),
    expr: block.expr ? optimizeExpr(block.expr, forwarding, functions) : undefined,
  };
}

function optimizeStatement(
  stmt: Statement,
  forwarding: Map<string, string>,
  functions: Map<string, FnDecl>,
): Statement {
  if (stmt.kind === "let" || stmt.kind === "destructure_let") {
    return { ...stmt, value: optimizeExpr(stmt.value, forwarding, functions) };
  }
  return stmt;
}

function optimizeExpr(expr: Expr, forwarding: Map<string, string>, functions: Map<string, FnDecl>): Expr {
  switch (expr.kind) {
    case "call": {
      const callee = optimizeExpr(expr.callee, forwarding, functions);
      const args = expr.args.map((arg) => optimizeExpr(arg, forwarding, functions));
      if (callee.kind === "var") {
        const target = forwarding.get(callee.name);
        if (target) return { ...expr, callee: { kind: "var", name: target }, args };
        const inlined = inlineGeneratedCall(callee.name, args, functions);
        if (inlined) return optimizeExpr(inlined, forwarding, functions);
      }
      return { ...expr, callee, args };
    }
    case "index":
      return {
        ...expr,
        target: optimizeExpr(expr.target, forwarding, functions),
        index: optimizeExpr(expr.index, forwarding, functions),
      };
    case "binary":
      return {
        ...expr,
        left: optimizeExpr(expr.left, forwarding, functions),
        right: optimizeExpr(expr.right, forwarding, functions),
      };
    case "pipe_bind":
      {
        const value = optimizeExpr(expr.value, forwarding, functions);
        if (expr.name === "$") {
          return optimizeExpr(substituteVar(expr.body, expr.name, value), forwarding, functions);
        }
        return {
          ...expr,
          value,
          body: optimizeExpr(expr.body, forwarding, functions),
        };
      }
    case "match":
      return {
        ...expr,
        value: optimizeExpr(expr.value, forwarding, functions),
        arms: expr.arms.map((arm) => ({ ...arm, value: optimizeExpr(arm.value, forwarding, functions) })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({ ...slot, value: optimizeExpr(slot.value, forwarding, functions) })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({ ...slot, value: optimizeExpr(slot.value, forwarding, functions) })),
      };
    case "range":
      return {
        ...expr,
        start: optimizeExpr(expr.start, forwarding, functions),
        end: optimizeExpr(expr.end, forwarding, functions),
      };
    case "block":
      return optimizeBlock(expr, forwarding, functions);
    case "literal":
    case "var":
    case "placeholder":
      return expr;
  }
}

function inlineGeneratedCall(
  name: string,
  args: Expr[],
  functions: Map<string, FnDecl>,
): Expr | undefined {
  const fn = functions.get(name);
  if (!fn?.generated || !fn.generatedInlineable || fn.public || fn.params.length !== args.length) return undefined;
  const statements: Statement[] = fn.params.map((param, index) => ({
    kind: "let",
    name: param.name,
    type: param.type,
    value: args[index],
  }));
  return {
    kind: "block",
    statements: [...statements, ...fn.body.statements],
    expr: fn.body.expr,
  };
}

function substituteVar(expr: Expr, name: string, value: Expr): Expr {
  switch (expr.kind) {
    case "var":
      return expr.name === name ? value : expr;
    case "call":
      return {
        ...expr,
        callee: substituteVar(expr.callee, name, value),
        args: expr.args.map((arg) => substituteVar(arg, name, value)),
      };
    case "index":
      return {
        ...expr,
        target: substituteVar(expr.target, name, value),
        index: substituteVar(expr.index, name, value),
      };
    case "binary":
      return {
        ...expr,
        left: substituteVar(expr.left, name, value),
        right: substituteVar(expr.right, name, value),
      };
    case "match":
      return {
        ...expr,
        value: substituteVar(expr.value, name, value),
        arms: expr.arms.map((arm) => ({ ...arm, value: substituteVar(arm.value, name, value) })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({ ...slot, value: substituteVar(slot.value, name, value) })),
      };
    case "range":
      return {
        ...expr,
        start: substituteVar(expr.start, name, value),
        end: substituteVar(expr.end, name, value),
      };
    case "pipe_bind":
      return expr.name === name
        ? { ...expr, value: substituteVar(expr.value, name, value) }
        : {
          ...expr,
          value: substituteVar(expr.value, name, value),
          body: substituteVar(expr.body, name, value),
        };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "let" || stmt.kind === "destructure_let"
            ? { ...stmt, value: substituteVar(stmt.value, name, value) }
            : stmt
        ),
        expr: expr.expr ? substituteVar(expr.expr, name, value) : undefined,
      };
    case "literal":
    case "placeholder":
      return expr;
  }
}
