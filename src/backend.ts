import type { BlockExpr, Expr, FnDecl, Param, Program, Statement } from "./core_ast.ts";
import { optimizeProgram } from "./optimize.ts";

export function emitWat(program: Program): string {
  const optimized = optimizeProgram(program);
  const functions = optimized.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && !decl.params.some((param) => param.const) && Boolean(decl.returnType)
  );
  const bodies = functions.map((fn) => emitFunction(fn));
  return `(module
${bodies.join("\n")}
)`;
}

function emitFunction(fn: FnDecl): string {
  const lines: string[] = [];
  const exportPart = fn.public ? ` (export "${fn.name}")` : "";
  const signature = [
    `(func $${watName(fn.name)}${exportPart}`,
    ...fn.params.map((param) => `(param $${watName(param.name)} ${watType(param)})`),
    `(result ${watType(fn.returnType)})`,
  ].join(" ");
  lines.push(`  ${signature}`);

  const locals = collectLocals(fn.body);
  for (const local of locals) {
    lines.push(`    (local $${watName(local.name)} ${watType(local.type)})`);
  }
  lines.push(...emitBlock(fn.body, 4));
  lines.push("  )");
  return lines.join("\n");
}

function collectLocals(block: BlockExpr): { name: string; type?: string }[] {
  const locals: { name: string; type?: string }[] = [];
  collectBlockLocals(block, locals);
  return locals;
}

function collectBlockLocals(block: BlockExpr, locals: { name: string; type?: string }[]) {
  for (const stmt of block.statements) {
    if (stmt.kind === "let") {
      locals.push({ name: stmt.name, type: stmt.type });
      collectExprLocals(stmt.value, locals);
    }
  }
  if (block.expr) collectExprLocals(block.expr, locals);
}

function collectExprLocals(expr: Expr, locals: { name: string; type?: string }[]) {
  switch (expr.kind) {
    case "block":
      collectBlockLocals(expr, locals);
      return;
    case "call":
      collectExprLocals(expr.callee, locals);
      for (const arg of expr.args) collectExprLocals(arg, locals);
      return;
    case "binary":
      collectExprLocals(expr.left, locals);
      collectExprLocals(expr.right, locals);
      return;
    case "match":
      collectExprLocals(expr.value, locals);
      for (const arm of expr.arms) collectExprLocals(arm.value, locals);
      return;
    case "shape":
      for (const slot of expr.slots) collectExprLocals(slot.value, locals);
      return;
    case "product_constructor":
      for (const slot of expr.slots) collectExprLocals(slot.value, locals);
      return;
    case "range":
      collectExprLocals(expr.start, locals);
      collectExprLocals(expr.end, locals);
      return;
    case "literal":
    case "var":
      return;
  }
}

function emitBlock(block: BlockExpr, indent: number): string[] {
  const lines: string[] = [];
  for (const stmt of block.statements) lines.push(...emitStatement(stmt, indent));
  if (block.expr) lines.push(...emitExpr(block.expr, indent));
  return lines;
}

function emitStatement(stmt: Statement, indent: number): string[] {
  if (stmt.kind === "fork_let") {
    return [
      `${spaces(indent)}local.get $${watName(baseName(stmt.source))}`,
      `${spaces(indent)}local.set $${watName(stmt.left)}`,
      `${spaces(indent)}local.get $${watName(baseName(stmt.source))}`,
      `${spaces(indent)}local.set $${watName(stmt.right)}`,
    ];
  }
  if (stmt.kind === "proof_const") return [];
  return [
    ...emitExpr(stmt.value, indent),
    `${spaces(indent)}local.set $${watName(stmt.name)}`,
  ];
}

function emitExpr(expr: Expr, indent: number): string[] {
  switch (expr.kind) {
    case "literal":
      return emitLiteral(expr, indent);
    case "var":
      return [`${spaces(indent)}local.get $${watName(baseName(expr.name))}`];
    case "call":
      if (expr.callee.kind !== "var") throw new Error("WAT backend only supports direct calls");
      return [
        ...expr.args.flatMap((arg) => emitExpr(arg, indent)),
        `${spaces(indent)}call $${watName(expr.callee.name)}`,
      ];
    case "binary":
      return [
        ...emitExpr(expr.left, indent),
        ...emitExpr(expr.right, indent),
        `${spaces(indent)}${binaryOp(expr.op)}`,
      ];
    case "match":
      return emitMatch(expr, indent);
    case "shape":
      if (expr.slots.length === 0) return [`${spaces(indent)}i32.const 0`];
      return emitExpr(expr.slots[0].value, indent);
    case "product_constructor":
      if (expr.slots.length === 0) return [`${spaces(indent)}i32.const 0`];
      return emitExpr(expr.slots[0].value, indent);
    case "range":
      throw new Error("WAT backend does not support ranges yet");
    case "block":
      return emitBlock(expr, indent);
  }
}

function emitLiteral(
  expr: Extract<Expr, { kind: "literal" }>,
  indent: number,
): string[] {
  if (expr.literalKind === "bool") {
    return [`${spaces(indent)}i32.const ${expr.value === "true" ? 1 : 0}`];
  }
  if (expr.literalKind === "number") {
    return [`${spaces(indent)}i32.const ${Number.parseInt(expr.value, 10)}`];
  }
  throw new Error(`WAT backend does not support ${expr.literalKind} literals yet`);
}

function emitMatch(expr: Extract<Expr, { kind: "match" }>, indent: number): string[] {
  if (expr.arms.length === 0) return [`${spaces(indent)}i32.const 0`];
  return emitMatchArms(expr.value, expr.arms, indent);
}

function emitMatchArms(
  value: Expr,
  arms: { pattern: string; value: Expr }[],
  indent: number,
): string[] {
  const [arm, ...rest] = arms;
  if (!arm) return [`${spaces(indent)}i32.const 0`];
  if (arm.pattern === "_" || rest.length === 0) return emitExpr(arm.value, indent);
  return [
    ...emitExpr(value, indent),
    ...emitPatternTest(arm.pattern, indent),
    `${spaces(indent)}if (result i32)`,
    ...emitExpr(arm.value, indent + 2),
    `${spaces(indent)}else`,
    ...emitMatchArms(value, rest, indent + 2),
    `${spaces(indent)}end`,
  ];
}

function emitPatternTest(pattern: string, indent: number): string[] {
  if (pattern === "true") return [`${spaces(indent)}i32.const 1`, `${spaces(indent)}i32.eq`];
  if (pattern === "false") return [`${spaces(indent)}i32.eqz`];
  const value = Number.parseInt(pattern, 10);
  if (Number.isFinite(value)) {
    return [`${spaces(indent)}i32.const ${value}`, `${spaces(indent)}i32.eq`];
  }
  throw new Error(`WAT backend does not support match pattern ${pattern}`);
}

function binaryOp(op: string): string {
  switch (op) {
    case "+":
      return "i32.add";
    case "-":
      return "i32.sub";
    case "*":
      return "i32.mul";
    case "/":
      return "i32.div_s";
    case "%":
      return "i32.rem_s";
    case "==":
      return "i32.eq";
    case "!=":
      return "i32.ne";
    case "<":
      return "i32.lt_s";
    case "<=":
      return "i32.le_s";
    case ">":
      return "i32.gt_s";
    case ">=":
      return "i32.ge_s";
    default:
      throw new Error(`WAT backend does not support operator ${op}`);
  }
}

function watType(type: string | Param | undefined): string {
  const source = typeof type === "string" || type === undefined ? type : type.type;
  if (source === "i64") return "i64";
  if (source === "f32") return "f32";
  if (source === "f64") return "f64";
  return "i32";
}

function baseName(name: string): string {
  const dot = name.indexOf(".");
  const bracket = name.indexOf("[");
  const end = Math.min(
    dot >= 0 ? dot : name.length,
    bracket >= 0 ? bracket : name.length,
  );
  return name.slice(0, end);
}

function watName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_.$]/g, "_");
}

function spaces(count: number): string {
  return " ".repeat(count);
}

export function emitWasm(program: Program): Uint8Array<ArrayBuffer> {
  const optimized = optimizeProgram(program);
  const main = optimized.declarations.find((decl): decl is FnDecl =>
    decl.kind === "fn" && decl.name === "main"
  );
  const value = main?.body.expr ? constI32(main.body.expr) : 0;
  const bytes: number[] = [
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01,
    0x05,
    0x01,
    0x60,
    0x00,
    0x01,
    0x7f,
    0x03,
    0x02,
    0x01,
    0x00,
    0x07,
    0x08,
    0x01,
    0x04,
    0x6d,
    0x61,
    0x69,
    0x6e,
    0x00,
    0x00,
    0x0a,
  ];
  const body = [0x00, 0x41, ...sleb(value), 0x0b];
  bytes.push(body.length + 2, 0x01, body.length, ...body);
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

function constI32(expr: Expr): number {
  if (expr.kind === "literal" && expr.literalKind === "number") {
    return Number.parseInt(expr.value, 10);
  }
  if (expr.kind === "binary") {
    const left = constI32(expr.left), right = constI32(expr.right);
    if (expr.op === "+") return left + right;
    if (expr.op === "-") return left - right;
    if (expr.op === "*") return left * right;
    if (expr.op === "/") return Math.trunc(left / right);
  }
  if (expr.kind === "match") {
    const value = constI32(expr.value);
    const arm = expr.arms.find((arm) => arm.pattern === "_" || arm.pattern === String(value));
    return arm ? constI32(arm.value) : 0;
  }
  return 0;
}

function sleb(value: number): number[] {
  const out = [];
  let more = true;
  while (more) {
    let byte = value & 0x7f;
    value >>= 7;
    const signBit = byte & 0x40;
    more = !((value === 0 && signBit === 0) || (value === -1 && signBit !== 0));
    if (more) byte |= 0x80;
    out.push(byte);
  }
  return out;
}
