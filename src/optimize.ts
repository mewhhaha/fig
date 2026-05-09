import type { BlockExpr, Declaration, Expr, FnDecl, Program, StaticForSource, Statement } from "./core_ast.ts";

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
      const staticValue = optimizeStaticShapeCall(callee, args);
      if (staticValue) return staticValue;
      if (callee.kind === "var") {
        const target = forwarding.get(callee.name);
        if (target) return { ...expr, callee: { kind: "var", name: target }, args };
        const inlined = inlineGeneratedCall(callee.name, args, functions);
        if (inlined) return optimizeExpr(inlined, forwarding, functions);
      }
      return { ...expr, callee, args };
    }
    case "borrow":
      return { ...expr, value: optimizeExpr(expr.value, forwarding, functions) };
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
      {
        const value = optimizeExpr(expr.value, forwarding, functions);
        if (value.kind === "literal" && value.literalKind === "bool") {
          const selected = expr.arms.find((arm) =>
            arm.pattern.kind === "literal" && arm.pattern.value === value.value
          );
          if (selected) return optimizeExpr(selected.value, forwarding, functions);
        }
        return {
        ...expr,
        value,
        arms: expr.arms.map((arm) => ({ ...arm, value: optimizeExpr(arm.value, forwarding, functions) })),
        };
      }
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
    case "static_for_slots":
      return {
        ...expr,
        source: optimizeStaticForSource(expr.source, forwarding, functions),
        value: optimizeExpr(expr.value, forwarding, functions),
      };
    case "range":
      return {
        ...expr,
        start: optimizeExpr(expr.start, forwarding, functions),
        end: optimizeExpr(expr.end, forwarding, functions),
      };
    case "field":
      return {
        ...expr,
        value: optimizeExpr(expr.value, forwarding, functions),
        key: optimizeExpr(expr.key, forwarding, functions),
      };
    case "block":
      return optimizeBlock(expr, forwarding, functions);
    case "literal":
    case "var":
    case "placeholder":
      return expr;
  }
}

function optimizeStaticShapeCall(callee: Expr, args: Expr[]): Expr | undefined {
  if (callee.kind !== "var" || callee.name !== "@shape_has_slot") return undefined;
  const slotsArg = args[0];
  const keyArg = args[1];
  if (
    slotsArg?.kind !== "call" || slotsArg.callee.kind !== "var" ||
    slotsArg.callee.name !== "@type_slots" || keyArg?.kind !== "literal" ||
    keyArg.literalKind !== "literalType"
  ) return undefined;
  const typeArg = slotsArg.args[0];
  if (typeArg?.kind !== "var") return undefined;
  const labels = inlineStructLabels(typeArg.name);
  if (!labels) return undefined;
  return { kind: "literal", literalKind: "bool", value: String(labels.has(keyArg.value.slice(1))) };
}

function inlineStructLabels(type: string): Set<string> | undefined {
  const trimmed = type.trim();
  if (!trimmed.startsWith("struct({") || !trimmed.endsWith("})")) return undefined;
  const inner = trimmed.slice("struct({".length, -2).trim();
  if (!inner) return new Set();
  const labels = new Set<string>();
  for (const part of splitTopLevel(inner)) {
    const colon = part.indexOf(":");
    if (colon > 0) labels.add(part.slice(0, colon).trim());
  }
  return labels;
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const ch = source[index];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
}

function inlineGeneratedCall(
  name: string,
  args: Expr[],
  functions: Map<string, FnDecl>,
): Expr | undefined {
  const fn = functions.get(name);
  if (!fn?.generated || !fn.generatedInlineable || fn.public || fn.params.length !== args.length) return undefined;
  const statements: Statement[] = [];
  let body = structuredClone(fn.body) as FnDecl["body"];
  fn.params.forEach((param, index) => {
    const arg = args[index];
    if (arg?.kind === "var") {
      body = substituteVar(body, param.name, arg) as FnDecl["body"];
      return;
    }
    if (arg?.kind === "borrow" && arg.value.kind === "var") {
      body = substituteVar(body, param.name, arg.value) as FnDecl["body"];
      return;
    }
    statements.push({
      kind: "let",
      name: param.name,
      type: param.type,
      value: arg,
    });
  });
  return {
    kind: "block",
    statements: [...statements, ...body.statements],
    expr: body.expr,
  };
}

function optimizeStaticForSource(
  source: StaticForSource,
  forwarding: Map<string, string>,
  functions: Map<string, FnDecl>,
): StaticForSource {
  return source.kind === "range"
    ? {
      ...source,
      start: optimizeExpr(source.start, forwarding, functions),
      end: optimizeExpr(source.end, forwarding, functions),
    }
    : { ...source, shape: optimizeExpr(source.shape, forwarding, functions) };
}

function substituteStaticForSource(
  source: StaticForSource,
  name: string,
  value: Expr,
): StaticForSource {
  return source.kind === "range"
    ? {
      ...source,
      start: substituteVar(source.start, name, value),
      end: substituteVar(source.end, name, value),
    }
    : { ...source, shape: substituteVar(source.shape, name, value) };
}

function substituteVar(expr: Expr, name: string, value: Expr): Expr {
  switch (expr.kind) {
    case "var":
      if (expr.name === name) return value;
      if (value.kind === "var" && (expr.name.startsWith(`${name}.`) || expr.name.startsWith(`${name}[`))) {
        return { kind: "var", name: `${value.name}${expr.name.slice(name.length)}` };
      }
      return expr;
    case "call":
      return {
        ...expr,
        callee: substituteVar(expr.callee, name, value),
        args: expr.args.map((arg) => substituteVar(arg, name, value)),
      };
    case "borrow":
      return { ...expr, value: substituteVar(expr.value, name, value) };
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
    case "static_for_slots":
      return {
        ...expr,
        source: substituteStaticForSource(expr.source, name, value),
        value: substituteVar(expr.value, name, value),
      };
    case "range":
      return {
        ...expr,
        start: substituteVar(expr.start, name, value),
        end: substituteVar(expr.end, name, value),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: substituteStaticForSource(expr.source, name, value),
        value: substituteVar(expr.value, name, value),
      };
    case "field":
      return {
        ...expr,
        value: substituteVar(expr.value, name, value),
        key: substituteVar(expr.key, name, value),
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
