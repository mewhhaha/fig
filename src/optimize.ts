import type {
  BlockExpr,
  Declaration,
  Expr,
  FnDecl,
  ParamPattern,
  Program,
  Statement,
  StaticForSource,
} from "./core_ast.ts";

const INLINE_COST_BUDGET = 18;
const PRODUCT_INLINE_COST_BUDGET = 12;
const OPTIMIZE_PASSES = 4;

export type OptLevel = "debug" | "default" | "speed" | "size";

export interface OptimizeOptions {
  optLevel?: OptLevel;
}

interface OptimizerConfig {
  optLevel: OptLevel;
  scalarInlineBudget: number;
  productInlineBudget: number;
  passes: number;
}

export interface FunctionSummary {
  name: string;
  isPublic: boolean;
  isPrimitive: boolean;
  isImported: boolean;
  isPure: boolean;
  effects: string[];
  recursiveKind: "none" | "self_tail" | "self_non_tail" | "mutual";
  astCost: number;
  wasmCostEstimate: number;
  callCount: number;
  returnClass:
    | "scalar"
    | "flat_product"
    | "inline_array"
    | "heap_handle"
    | "buffer_handle"
    | "closure"
    | "multi";
  paramEffects: Map<string, "observe" | "consume" | "retain" | "alias_return">;
  hasMatch: boolean;
  hasLoopShape: boolean;
  hasBranchIntrinsic: boolean;
  hasHostCall: boolean;
  hasConstFunctionParam: boolean;
  slotCountEstimate: number;
  heapWriteCountEstimate: number;
}

export function optimizeProgram(program: Program, options: OptimizeOptions = {}): Program {
  const config = optimizerConfig(options.optLevel ?? "default");
  const optimized = structuredClone(program) as Program;
  for (let pass = 0; pass < config.passes; pass++) {
    const functions = functionMap(optimized);
    const forwarding = forwardingWrappers(functions);
    const summaries = functionSummaries(optimized, functions);
    const inlineable = inlineableFunctions(functions, summaries, config);
    optimized.declarations = optimized.declarations.map((decl) =>
      optimizeDecl(decl, forwarding, inlineable, functions)
    );
  }
  return optimized;
}

function optimizerConfig(optLevel: OptLevel): OptimizerConfig {
  switch (optLevel) {
    case "debug":
      return { optLevel, scalarInlineBudget: 6, productInlineBudget: 4, passes: 1 };
    case "speed":
      return { optLevel, scalarInlineBudget: 36, productInlineBudget: 28, passes: 8 };
    case "size":
      return { optLevel, scalarInlineBudget: 8, productInlineBudget: 0, passes: 2 };
    case "default":
      return {
        optLevel,
        scalarInlineBudget: INLINE_COST_BUDGET,
        productInlineBudget: PRODUCT_INLINE_COST_BUDGET,
        passes: OPTIMIZE_PASSES,
      };
  }
}

function functionMap(program: Program): Map<string, FnDecl> {
  const functions = new Map(
    program.declarations
      .filter((decl): decl is FnDecl => decl.kind === "fn")
      .map((decl) => [decl.name, decl]),
  );
  for (const item of program.imports) {
    functions.set(item.name, {
      kind: "fn",
      public: true,
      name: item.name,
      params: [],
      returnType: item.type,
      effects: item.effects,
      body: { kind: "block", statements: [] },
      primitiveId: "capability",
    });
  }
  return functions;
}

export function summarizeProgram(
  program: Program,
  options: OptimizeOptions = {},
): Map<string, FunctionSummary> {
  const _config = optimizerConfig(options.optLevel ?? "default");
  const functions = functionMap(program);
  return functionSummaries(program, functions);
}

function functionSummaries(
  program: Program,
  functions: Map<string, FnDecl>,
): Map<string, FunctionSummary> {
  const callCounts = programCallCounts(program);
  const summaries = new Map<string, FunctionSummary>();
  for (const fn of functions.values()) {
    const imported = fn.primitiveId === "capability" && fn.body.statements.length === 0 &&
      !program.declarations.includes(fn);
    const astCost = functionCost(fn);
    summaries.set(fn.name, {
      name: fn.name,
      isPublic: fn.public,
      isPrimitive: Boolean(fn.primitiveId),
      isImported: imported,
      isPure: fn.effects.length === 0,
      effects: [...fn.effects],
      recursiveKind: exprCallsFunction(fn.body, fn.name) ? "self_non_tail" : "none",
      astCost,
      wasmCostEstimate: astCost,
      callCount: callCounts.get(fn.name) ?? 0,
      returnClass: returnClass(fn.returnType),
      paramEffects: inferParamEffects(fn, functions),
      hasMatch: exprHasKind(fn.body, "match"),
      hasLoopShape: exprCallsFunction(fn.body, fn.name),
      hasBranchIntrinsic: exprHasBranchIntrinsic(fn.body),
      hasHostCall: exprHasHostCall(fn.body, functions),
      hasConstFunctionParam: fn.params.some((param) => param.const && param.type.startsWith("fn")),
      slotCountEstimate: slotCountEstimate(fn.returnType),
      heapWriteCountEstimate: 0,
    });
  }
  return summaries;
}

function programCallCounts(program: Program): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const decl of program.declarations) {
    if (decl.kind === "fn") { for (const name of calledFunctionList(decl.body)) add(name); }
    if ((decl.kind === "let" || decl.kind === "const")) {
      for (const name of calledFunctionList(decl.value)) add(name);
    }
  }
  return counts;
}

function returnClass(type: string | undefined): FunctionSummary["returnClass"] {
  if (!type) return "multi";
  if (isScalarRuntimeReturn(type)) return "scalar";
  if (/InlineArray|InlineArrayList|InlineArrayBuilder/.test(type)) return "inline_array";
  if (/Buffer|String|Bytes/.test(type)) return "buffer_handle";
  if (/fn\s*\(/.test(type)) return "closure";
  if (/[,{}]|\bstruct\(/.test(type)) return "flat_product";
  return "flat_product";
}

function slotCountEstimate(type: string | undefined): number {
  if (!type || isScalarRuntimeReturn(type)) return 1;
  const inline = type.match(/InlineArray\((\d+)/);
  if (inline) return Number.parseInt(inline[1] ?? "1", 10);
  return Math.max(1, splitTopLevel(type.replace(/^struct\((.*)\)$/, "$1")).length);
}

function inferParamEffects(
  fn: FnDecl,
  functions: Map<string, FnDecl>,
): FunctionSummary["paramEffects"] {
  const effects = new Map<string, "observe" | "consume" | "retain" | "alias_return">();
  for (const param of fn.params) {
    if (fn.body.expr && exprReturnsAlias(fn.body.expr, param.name)) {
      effects.set(param.name, "alias_return");
    } else if (paramUsedInEffectfulCall(fn.body, param.name, functions)) {
      effects.set(param.name, "retain");
    } else if (paramUsedAsWholeValue(fn.body, param.name)) {
      effects.set(param.name, "consume");
    } else {
      effects.set(param.name, "observe");
    }
  }
  return effects;
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
  if (fn.public || fn.effects.length || fn.primitiveId || fn.body.statements.length !== 0) {
    return undefined;
  }
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
    if (!direct.has(target)) return target;
    target = direct.get(target);
  }
  return undefined;
}

function optimizeDecl(
  decl: Declaration,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
): Declaration {
  if (decl.kind === "fn") {
    return {
      ...decl,
      body: optimizeBlock(decl.body, forwarding, inlineable, functions, {
        allowMultiValueResult: true,
      }),
    };
  }
  if (decl.kind === "let" || decl.kind === "const") {
    return { ...decl, value: optimizeExpr(decl.value, forwarding, inlineable, functions) };
  }
  return decl;
}

function optimizeBlock(
  block: BlockExpr,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
  options: { allowMultiValueResult?: boolean } = {},
): BlockExpr {
  const expr = block.expr ? optimizeExpr(block.expr, forwarding, inlineable, functions) : undefined;
  const optimized: BlockExpr = {
    ...block,
    statements: block.statements.map((stmt) =>
      optimizeStatement(stmt, forwarding, inlineable, functions)
    ),
    expr: options.allowMultiValueResult && expr
      ? inlineCallExpr(expr, inlineable, { allowMultiValue: true }) ?? expr
      : expr,
  };
  return removeUnusedPureLets(optimized, functions);
}

function optimizeStatement(
  stmt: Statement,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
): Statement {
  if (stmt.kind === "let" || stmt.kind === "destructure_let") {
    const value = optimizeExpr(stmt.value, forwarding, inlineable, functions);
    return {
      ...stmt,
      value: stmt.kind === "destructure_let"
        ? inlineCallExpr(value, inlineable, { allowMultiValue: true }) ?? value
        : value,
    };
  }
  return stmt;
}

function optimizeExpr(
  expr: Expr,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
): Expr {
  switch (expr.kind) {
    case "call": {
      const callee = optimizeExpr(expr.callee, forwarding, inlineable, functions);
      const args = expr.args.map((arg) => optimizeExpr(arg, forwarding, inlineable, functions));
      const staticValue = optimizeStaticShapeCall(callee, args);
      if (staticValue) return staticValue;
      if (callee.kind === "var") {
        const target = forwarding.get(callee.name);
        if (target) return { ...expr, callee: { kind: "var", name: target }, args };
        const inlined = inlineCall(callee.name, args, inlineable, { allowMultiValue: false });
        if (inlined) return optimizeExpr(inlined, forwarding, inlineable, functions);
      }
      return { ...expr, callee, args };
    }
    case "index":
      return {
        ...expr,
        target: optimizeExpr(expr.target, forwarding, inlineable, functions),
        index: optimizeExpr(expr.index, forwarding, inlineable, functions),
      };
    case "binary":
      return optimizeBinary({
        ...expr,
        left: optimizeExpr(expr.left, forwarding, inlineable, functions),
        right: optimizeExpr(expr.right, forwarding, inlineable, functions),
      }, functions);
    case "pipe_bind": {
      const value = optimizeExpr(expr.value, forwarding, inlineable, functions);
      if (expr.name === "$") {
        return optimizeExpr(
          substituteVar(expr.body, expr.name, value),
          forwarding,
          inlineable,
          functions,
        );
      }
      return {
        ...expr,
        value,
        body: optimizeExpr(expr.body, forwarding, inlineable, functions),
      };
    }
    case "match": {
      const value = optimizeExpr(expr.value, forwarding, inlineable, functions);
      if (value.kind === "literal" && value.literalKind === "bool") {
        const selected = expr.arms.find((arm) =>
          arm.pattern.kind === "literal" && arm.pattern.value === value.value
        );
        if (selected) return optimizeExpr(selected.value, forwarding, inlineable, functions);
      }
      return {
        ...expr,
        value,
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: optimizeExpr(arm.value, forwarding, inlineable, functions),
        })),
      };
    }
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: optimizeExpr(slot.value, forwarding, inlineable, functions),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: optimizeExpr(slot.value, forwarding, inlineable, functions),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: optimizeStaticForSource(expr.source, forwarding, inlineable, functions),
        value: optimizeExpr(expr.value, forwarding, inlineable, functions),
      };
    case "range":
      return {
        ...expr,
        start: optimizeExpr(expr.start, forwarding, inlineable, functions),
        end: optimizeExpr(expr.end, forwarding, inlineable, functions),
      };
    case "field":
      return {
        ...expr,
        value: optimizeExpr(expr.value, forwarding, inlineable, functions),
        key: optimizeExpr(expr.key, forwarding, inlineable, functions),
      };
    case "block":
      return optimizeBlock(expr, forwarding, inlineable, functions);
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

function optimizeBinary(
  expr: Extract<Expr, { kind: "binary" }>,
  functions: Map<string, FnDecl>,
): Expr {
  if (isNumberLiteral(expr.right, 0) && (expr.op === "+" || expr.op === "-")) return expr.left;
  if (isNumberLiteral(expr.left, 0) && expr.op === "+") return expr.right;
  if (isNumberLiteral(expr.right, 1) && expr.op === "*") return expr.left;
  if (isNumberLiteral(expr.left, 1) && expr.op === "*") return expr.right;
  if (isNumberLiteral(expr.right, 1) && expr.op === "/") return expr.left;
  if (
    expr.op === "*" && isNumberLiteral(expr.right, 0) && !hasRuntimeEffect(expr.left, functions)
  ) {
    return expr.right;
  }
  if (
    expr.op === "*" && isNumberLiteral(expr.left, 0) && !hasRuntimeEffect(expr.right, functions)
  ) {
    return expr.left;
  }
  if (expr.op === "==" && isBoolLiteral(expr.right, true)) return expr.left;
  if (expr.op === "==" && isBoolLiteral(expr.left, true)) return expr.right;
  return expr;
}

function isNumberLiteral(expr: Expr, value: number): boolean {
  return expr.kind === "literal" && expr.literalKind === "number" &&
    Number.parseInt(expr.value, 10) === value;
}

function isBoolLiteral(expr: Expr, value: boolean): boolean {
  return expr.kind === "literal" && expr.literalKind === "bool" && expr.value === String(value);
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

function inlineableFunctions(
  functions: Map<string, FnDecl>,
  summaries: Map<string, FunctionSummary>,
  config: OptimizerConfig,
): Map<string, FnDecl> {
  const result = new Map<string, FnDecl>();
  for (const fn of functions.values()) {
    const summary = summaries.get(fn.name);
    if (!summary || !isInlineableFunction(summary)) continue;
    if (summary.recursiveKind !== "none") continue;
    if (summary.astCost > inlineBudget(fn, summary, config)) continue;
    result.set(fn.name, fn);
  }
  return result;
}

function isInlineableFunction(summary: FunctionSummary): boolean {
  return !summary.isPublic && !summary.isPrimitive && summary.isPure;
}

function isScalarRuntimeReturn(type: string | undefined): boolean {
  return type === "i32" || type === "bool" || type === "char" || type === "count" ||
    type === "i64" || type === "f32" || type === "f64";
}

function inlineBudget(
  fn: FnDecl,
  summary: FunctionSummary,
  config: OptimizerConfig,
): number {
  if (summary.returnClass !== "scalar") return config.productInlineBudget;
  return fn.generatedInlineable ? config.scalarInlineBudget * 2 : config.scalarInlineBudget;
}

function functionCost(fn: FnDecl): number {
  return fn.body.statements.reduce((sum, stmt) => sum + statementCost(stmt), 0) +
    (fn.body.expr ? exprCost(fn.body.expr) : 0);
}

function statementCost(stmt: Statement): number {
  switch (stmt.kind) {
    case "let":
    case "destructure_let":
      return 1 + exprCost(stmt.value);
    case "proof_const":
      return 0;
  }
}

function exprCost(expr: Expr): number {
  switch (expr.kind) {
    case "call":
      return 2 + exprCost(expr.callee) + expr.args.reduce((sum, arg) => sum + exprCost(arg), 0);
    case "index":
      return 2 + exprCost(expr.target) + exprCost(expr.index);
    case "binary":
      return 1 + exprCost(expr.left) + exprCost(expr.right);
    case "pipe_bind":
      return 1 + exprCost(expr.value) + exprCost(expr.body);
    case "match":
      return 2 + exprCost(expr.value) +
        expr.arms.reduce((sum, arm) => sum + exprCost(arm.value), 0);
    case "shape":
    case "product_constructor":
      return 1 + expr.slots.reduce((sum, slot) => sum + exprCost(slot.value), 0);
    case "static_for_slots":
      return 4 + exprCost(expr.value) + staticForSourceCost(expr.source);
    case "range":
      return 1 + exprCost(expr.start) + exprCost(expr.end);
    case "field":
      return 1 + exprCost(expr.value) + exprCost(expr.key);
    case "block":
      return expr.statements.reduce((sum, stmt) => sum + statementCost(stmt), 0) +
        (expr.expr ? exprCost(expr.expr) : 0);
    case "literal":
    case "var":
    case "placeholder":
      return 1;
  }
}

function staticForSourceCost(source: StaticForSource): number {
  return source.kind === "range"
    ? exprCost(source.start) + exprCost(source.end)
    : exprCost(source.shape);
}

function exprCallsFunction(expr: Expr | BlockExpr | undefined, name: string): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "call":
      return (expr.callee.kind === "var" && expr.callee.name === name) ||
        exprCallsFunction(expr.callee, name) ||
        expr.args.some((arg) => exprCallsFunction(arg, name));
    case "index":
      return exprCallsFunction(expr.target, name) || exprCallsFunction(expr.index, name);
    case "binary":
      return exprCallsFunction(expr.left, name) || exprCallsFunction(expr.right, name);
    case "pipe_bind":
      return exprCallsFunction(expr.value, name) || exprCallsFunction(expr.body, name);
    case "match":
      return exprCallsFunction(expr.value, name) ||
        expr.arms.some((arm) => exprCallsFunction(arm.value, name));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) => exprCallsFunction(slot.value, name));
    case "static_for_slots":
      return exprCallsFunction(expr.value, name) ||
        (expr.source.kind === "range"
          ? exprCallsFunction(expr.source.start, name) || exprCallsFunction(expr.source.end, name)
          : exprCallsFunction(expr.source.shape, name));
    case "field":
      return exprCallsFunction(expr.value, name) || exprCallsFunction(expr.key, name);
    case "range":
      return exprCallsFunction(expr.start, name) || exprCallsFunction(expr.end, name);
    case "block":
      return expr.statements.some((stmt) =>
        (stmt.kind === "let" || stmt.kind === "destructure_let") &&
        exprCallsFunction(stmt.value, name)
      ) || exprCallsFunction(expr.expr, name);
    case "literal":
    case "var":
    case "placeholder":
      return false;
  }
}

function calledFunctionList(expr: Expr | BlockExpr | undefined): string[] {
  const names: string[] = [];
  const visit = (item: Expr | BlockExpr | Statement | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "call":
        if (item.callee.kind === "var") names.push(item.callee.name);
        visit(item.callee);
        item.args.forEach(visit);
        return;
      case "index":
        visit(item.target);
        visit(item.index);
        return;
      case "binary":
        visit(item.left);
        visit(item.right);
        return;
      case "pipe_bind":
        visit(item.value);
        visit(item.body);
        return;
      case "match":
        visit(item.value);
        item.arms.forEach((arm) => visit(arm.value));
        return;
      case "shape":
      case "product_constructor":
        item.slots.forEach((slot) => visit(slot.value));
        return;
      case "static_for_slots":
        visitStaticForSource(item.source);
        visit(item.value);
        return;
      case "field":
        visit(item.value);
        visit(item.key);
        return;
      case "range":
        visit(item.start);
        visit(item.end);
        return;
      case "block":
        item.statements.forEach(visit);
        visit(item.expr);
        return;
      case "let":
      case "destructure_let":
        visit(item.value);
        return;
      case "proof_const":
      case "literal":
      case "var":
      case "placeholder":
        return;
    }
  };
  const visitStaticForSource = (source: StaticForSource) => {
    if (source.kind === "range") {
      visit(source.start);
      visit(source.end);
    } else {
      visit(source.shape);
    }
  };
  visit(expr);
  return names;
}

function exprHasKind(expr: Expr | BlockExpr | undefined, kind: Expr["kind"]): boolean {
  if (!expr) return false;
  if (expr.kind === kind) return true;
  return calledSubexpressions(expr).some((item) => exprHasKind(item, kind));
}

function exprHasBranchIntrinsic(expr: Expr | BlockExpr | undefined): boolean {
  return calledFunctionList(expr).some((name) =>
    name.startsWith("@branch_") || name.includes("branch_")
  );
}

function exprHasHostCall(
  expr: Expr | BlockExpr | undefined,
  functions: Map<string, FnDecl>,
): boolean {
  return calledFunctionList(expr).some((name) => functions.get(name)?.primitiveId === "capability");
}

function exprReturnsAlias(expr: Expr, name: string): boolean {
  return expr.kind === "var" && (expr.name === name || expr.name.startsWith(`${name}.`) ||
    expr.name.startsWith(`${name}[`));
}

function paramUsedInEffectfulCall(
  block: BlockExpr,
  name: string,
  functions: Map<string, FnDecl>,
): boolean {
  let retained = false;
  const visit = (expr: Expr | undefined) => {
    if (!expr || retained) return;
    if (expr.kind === "call" && expr.callee.kind === "var") {
      const callee = functions.get(expr.callee.name);
      if (
        (callee?.effects.length ?? 0) > 0 && expr.args.some((arg) => exprMentionsName(arg, name))
      ) {
        retained = true;
        return;
      }
    }
    calledSubexpressions(expr).forEach(visit);
  };
  block.statements.forEach((stmt) => {
    if (stmt.kind !== "proof_const") visit(stmt.value);
  });
  visit(block.expr);
  return retained;
}

function paramUsedAsWholeValue(block: BlockExpr, name: string): boolean {
  let used = false;
  const visit = (expr: Expr | undefined) => {
    if (!expr || used) return;
    if (expr.kind === "var" && expr.name === name) {
      used = true;
      return;
    }
    calledSubexpressions(expr).forEach(visit);
  };
  block.statements.forEach((stmt) => {
    if (stmt.kind !== "proof_const") visit(stmt.value);
  });
  visit(block.expr);
  return used;
}

function exprMentionsName(expr: Expr, name: string): boolean {
  return usedNames(expr).has(name);
}

function calledSubexpressions(expr: Expr | BlockExpr): Expr[] {
  switch (expr.kind) {
    case "call":
      return [expr.callee, ...expr.args];
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
      return expr.slots.map((slot) => slot.value);
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
    case "literal":
    case "var":
    case "placeholder":
      return [];
  }
}

function inlineCall(
  name: string,
  args: Expr[],
  inlineable: Map<string, FnDecl>,
  options: { allowMultiValue: boolean },
): Expr | undefined {
  const fn = inlineable.get(name);
  if (!fn || fn.params.length !== args.length) return undefined;
  if (!options.allowMultiValue && !isScalarRuntimeReturn(fn.returnType)) return undefined;
  const statements: Statement[] = [];
  let body = alphaRenameInlineBlock(structuredClone(fn.body) as FnDecl["body"], fn.name);
  fn.params.forEach((param, index) => {
    const arg = args[index];
    if (arg?.kind === "var") {
      body = substituteVar(body, param.name, arg) as FnDecl["body"];
      return;
    }
    const paramName = inlineBindingName(fn.name, param.name);
    statements.push({
      kind: "let",
      name: paramName,
      type: param.type,
      value: arg,
    });
    body = substituteVar(body, param.name, { kind: "var", name: paramName }) as FnDecl["body"];
  });
  return {
    kind: "block",
    statements: [...statements, ...body.statements],
    expr: body.expr,
  };
}

function inlineCallExpr(
  expr: Expr,
  inlineable: Map<string, FnDecl>,
  options: { allowMultiValue: boolean },
): Expr | undefined {
  return expr.kind === "call" && expr.callee.kind === "var"
    ? inlineCall(expr.callee.name, expr.args, inlineable, options)
    : undefined;
}

function alphaRenameInlineBlock(block: BlockExpr, fnName: string): BlockExpr {
  return renameBlockBindings(block, new Map(), fnName);
}

function renameBlockBindings(
  block: BlockExpr,
  outer: Map<string, string>,
  fnName: string,
): BlockExpr {
  const env = new Map(outer);
  const statements: Statement[] = [];
  for (const stmt of block.statements) {
    if (stmt.kind === "proof_const") {
      statements.push(stmt);
      continue;
    }
    const value = renameExprBindings(stmt.value, env, fnName);
    if (stmt.kind === "let") {
      const fresh = inlineBindingName(fnName, stmt.name);
      statements.push({ ...stmt, name: fresh, value });
      env.set(stmt.name, fresh);
      continue;
    }
    const names = stmt.names.map((name) => inlineBindingName(fnName, name));
    statements.push({ ...stmt, names, value });
    stmt.names.forEach((name, index) => env.set(name, names[index] ?? name));
  }
  return {
    ...block,
    statements,
    expr: block.expr ? renameExprBindings(block.expr, env, fnName) : undefined,
  };
}

function renameExprBindings(expr: Expr, env: Map<string, string>, fnName: string): Expr {
  switch (expr.kind) {
    case "var": {
      const base = baseName(expr.name);
      const renamed = env.get(base);
      return renamed ? { ...expr, name: `${renamed}${expr.name.slice(base.length)}` } : expr;
    }
    case "call":
      return {
        ...expr,
        callee: renameExprBindings(expr.callee, env, fnName),
        args: expr.args.map((arg) => renameExprBindings(arg, env, fnName)),
      };
    case "index":
      return {
        ...expr,
        target: renameExprBindings(expr.target, env, fnName),
        index: renameExprBindings(expr.index, env, fnName),
      };
    case "binary":
      return {
        ...expr,
        left: renameExprBindings(expr.left, env, fnName),
        right: renameExprBindings(expr.right, env, fnName),
      };
    case "pipe_bind": {
      const scoped = new Map(env);
      const fresh = inlineBindingName(fnName, expr.name);
      scoped.set(expr.name, fresh);
      return {
        ...expr,
        name: fresh,
        value: renameExprBindings(expr.value, env, fnName),
        body: renameExprBindings(expr.body, scoped, fnName),
      };
    }
    case "match":
      return {
        ...expr,
        value: renameExprBindings(expr.value, env, fnName),
        arms: expr.arms.map((arm) => {
          const scoped = new Map(env);
          const pattern = renamePatternBindings(arm.pattern, scoped, fnName);
          return { ...arm, pattern, value: renameExprBindings(arm.value, scoped, fnName) };
        }),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: renameExprBindings(slot.value, env, fnName),
        })),
      };
    case "static_for_slots":
      return {
        ...expr,
        source: renameStaticForSourceBindings(expr.source, env, fnName),
        value: renameExprBindings(expr.value, env, fnName),
      };
    case "range":
      return {
        ...expr,
        start: renameExprBindings(expr.start, env, fnName),
        end: renameExprBindings(expr.end, env, fnName),
      };
    case "field":
      return {
        ...expr,
        value: renameExprBindings(expr.value, env, fnName),
        key: renameExprBindings(expr.key, env, fnName),
      };
    case "block":
      return renameBlockBindings(expr, env, fnName);
    case "literal":
    case "placeholder":
      return expr;
  }
}

function renameStaticForSourceBindings(
  source: StaticForSource,
  env: Map<string, string>,
  fnName: string,
): StaticForSource {
  return source.kind === "range"
    ? {
      ...source,
      start: renameExprBindings(source.start, env, fnName),
      end: renameExprBindings(source.end, env, fnName),
    }
    : { ...source, shape: renameExprBindings(source.shape, env, fnName) };
}

function renamePatternBindings(
  pattern: ParamPattern,
  env: Map<string, string>,
  fnName: string,
): ParamPattern {
  switch (pattern.kind) {
    case "binding": {
      const fresh = inlineBindingName(fnName, pattern.name);
      env.set(pattern.name, fresh);
      return { ...pattern, name: fresh };
    }
    case "tuple":
      return {
        ...pattern,
        items: pattern.items.map((item) => renamePatternBindings(item, env, fnName)),
      };
    case "constructor":
      return {
        ...pattern,
        args: pattern.args.map((arg) => renamePatternBindings(arg, env, fnName)),
      };
    case "wildcard":
    case "literal":
    case "type":
      return pattern;
  }
}

function inlineBindingName(fnName: string, name: string): string {
  return `__inl_${sanitizeName(fnName)}_${sanitizeName(name)}`;
}

function sanitizeName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_]/g, "_");
}

function optimizeStaticForSource(
  source: StaticForSource,
  forwarding: Map<string, string>,
  inlineable: Map<string, FnDecl>,
  functions: Map<string, FnDecl>,
): StaticForSource {
  return source.kind === "range"
    ? {
      ...source,
      start: optimizeExpr(source.start, forwarding, inlineable, functions),
      end: optimizeExpr(source.end, forwarding, inlineable, functions),
    }
    : { ...source, shape: optimizeExpr(source.shape, forwarding, inlineable, functions) };
}

function removeUnusedPureLets(block: BlockExpr, functions: Map<string, FnDecl>): BlockExpr {
  const kept: Statement[] = [];
  const used = usedNames(block.expr);
  for (let index = block.statements.length - 1; index >= 0; index--) {
    const stmt = block.statements[index]!;
    if (stmt.kind === "proof_const") {
      kept.unshift(stmt);
      continue;
    }
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    const needed = bindings.some((name) => used.has(name));
    if (!needed && !hasRuntimeEffect(stmt.value, functions)) continue;
    kept.unshift(stmt);
    for (const name of bindings) used.delete(name);
    for (const name of usedNames(stmt.value)) used.add(name);
  }
  return { ...block, statements: kept };
}

function usedNames(expr: Expr | undefined): Set<string> {
  const names = new Set<string>();
  const visit = (item: Expr | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "var":
        names.add(baseName(item.name));
        return;
      case "call":
        visit(item.callee);
        for (const arg of item.args) visit(arg);
        return;
      case "index":
        visit(item.target);
        visit(item.index);
        return;
      case "binary":
        visit(item.left);
        visit(item.right);
        return;
      case "pipe_bind":
        visit(item.value);
        for (const name of usedNames(item.body)) if (name !== item.name) names.add(name);
        return;
      case "match":
        visit(item.value);
        for (const arm of item.arms) visit(arm.value);
        return;
      case "shape":
      case "product_constructor":
        for (const slot of item.slots) visit(slot.value);
        return;
      case "static_for_slots":
        visitStaticForSource(item.source);
        visit(item.value);
        return;
      case "range":
        visit(item.start);
        visit(item.end);
        return;
      case "field":
        visit(item.value);
        visit(item.key);
        return;
      case "block":
        {
          const blockNames = blockUsedNames(item);
          for (const name of blockNames) names.add(name);
        }
        return;
      case "literal":
      case "placeholder":
        return;
    }
  };
  const visitStaticForSource = (source: StaticForSource) => {
    if (source.kind === "range") {
      visit(source.start);
      visit(source.end);
    } else {
      visit(source.shape);
    }
  };
  visit(expr);
  return names;
}

function blockUsedNames(block: BlockExpr): Set<string> {
  const used = usedNames(block.expr);
  for (let index = block.statements.length - 1; index >= 0; index--) {
    const stmt = block.statements[index]!;
    if (stmt.kind === "proof_const") continue;
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    const valueNames = usedNames(stmt.value);
    for (const name of bindings) used.delete(name);
    for (const name of valueNames) used.add(name);
  }
  return used;
}

function baseName(name: string): string {
  return name.split(/[.[(]/, 1)[0] ?? name;
}

function hasRuntimeEffect(expr: Expr, functions: Map<string, FnDecl>): boolean {
  switch (expr.kind) {
    case "call":
      return (expr.callee.kind === "var" &&
        (functions.get(expr.callee.name)?.effects.length ?? 0) > 0) ||
        hasRuntimeEffect(expr.callee, functions) ||
        expr.args.some((arg) => hasRuntimeEffect(arg, functions));
    case "index":
      return hasRuntimeEffect(expr.target, functions) || hasRuntimeEffect(expr.index, functions);
    case "binary":
      return hasRuntimeEffect(expr.left, functions) || hasRuntimeEffect(expr.right, functions);
    case "pipe_bind":
      return hasRuntimeEffect(expr.value, functions) || hasRuntimeEffect(expr.body, functions);
    case "match":
      return hasRuntimeEffect(expr.value, functions) ||
        expr.arms.some((arm) => hasRuntimeEffect(arm.value, functions));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) => hasRuntimeEffect(slot.value, functions));
    case "range":
      return hasRuntimeEffect(expr.start, functions) || hasRuntimeEffect(expr.end, functions);
    case "static_for_slots":
      return hasRuntimeEffect(expr.value, functions) ||
        (expr.source.kind === "range"
          ? hasRuntimeEffect(expr.source.start, functions) ||
            hasRuntimeEffect(expr.source.end, functions)
          : hasRuntimeEffect(expr.source.shape, functions));
    case "field":
      return hasRuntimeEffect(expr.value, functions) || hasRuntimeEffect(expr.key, functions);
    case "block":
      return expr.statements.some((stmt) =>
        (stmt.kind === "let" || stmt.kind === "destructure_let") &&
        hasRuntimeEffect(stmt.value, functions)
      ) || (expr.expr ? hasRuntimeEffect(expr.expr, functions) : false);
    case "literal":
    case "var":
    case "placeholder":
      return false;
  }
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
      if (
        value.kind === "var" &&
        (expr.name.startsWith(`${name}.`) || expr.name.startsWith(`${name}[`))
      ) {
        return { kind: "var", name: `${value.name}${expr.name.slice(name.length)}` };
      }
      return expr;
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
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: patternBinds(arm.pattern, name)
            ? arm.value
            : substituteVar(arm.value, name, value),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: substituteVar(slot.value, name, value),
        })),
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
    case "field":
      return {
        ...expr,
        value: substituteVar(expr.value, name, value),
        key: substituteVar(expr.key, name, value),
      };
    case "pipe_bind":
      return expr.name === name ? { ...expr, value: substituteVar(expr.value, name, value) } : {
        ...expr,
        value: substituteVar(expr.value, name, value),
        body: substituteVar(expr.body, name, value),
      };
    case "block":
      return substituteBlock(expr, name, value);
    case "literal":
    case "placeholder":
      return expr;
  }
}

function substituteBlock(block: BlockExpr, name: string, value: Expr): BlockExpr {
  const statements: Statement[] = [];
  let shadowed = false;
  for (const stmt of block.statements) {
    if (stmt.kind === "proof_const") {
      statements.push(stmt);
      continue;
    }
    statements.push(shadowed ? stmt : { ...stmt, value: substituteVar(stmt.value, name, value) });
    const bindings = stmt.kind === "let" ? [stmt.name] : stmt.names;
    if (bindings.includes(name)) shadowed = true;
  }
  return {
    ...block,
    statements,
    expr: !shadowed && block.expr ? substituteVar(block.expr, name, value) : block.expr,
  };
}

function patternBinds(
  pattern: { kind: string; name?: string; args?: unknown[] },
  name: string,
): boolean {
  if ((pattern.kind === "binding" || pattern.kind === "constructor") && pattern.name === name) {
    return true;
  }
  const args = pattern.args;
  return Array.isArray(args) &&
    args.some((arg) =>
      typeof arg === "object" && arg !== null &&
      patternBinds(arg as { kind: string; name?: string; args?: unknown[] }, name)
    );
}
