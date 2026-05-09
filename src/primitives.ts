import type { Declaration, FnDecl } from "./core_ast.ts";

export const intrinsicIds = [
  "memory_load_i32",
  "memory_store_i32",
  "memory_load_lane4_i32",
  "memory_store_lane4_i32",
  "ptr_from_i32",
  "ptr_add",
  "index_cursor_next",
  "inline_array_builder_start",
  "inline_array_builder_push",
  "inline_array_builder_finish",
  "freeze",
] as const;

export type IntrinsicId = typeof intrinsicIds[number];

const intrinsicIdSet = new Set<string>(intrinsicIds);

export function isKnownIntrinsicId(id: string): id is IntrinsicId {
  return intrinsicIdSet.has(id);
}

export function intrinsicCallId(name: string, intrinsicIdsByName: Map<string, string>): string | undefined {
  return intrinsicIdsByName.get(name);
}

export function intrinsicIdsByFunctionName(declarations: Iterable<Declaration>): Map<string, string> {
  const byName = new Map<string, string>();
  for (const decl of declarations) {
    if (decl.kind !== "fn" || !decl.name) continue;
    const id = decl.primitiveId ?? intrinsicWrapperId(decl);
    if (id) byName.set(decl.name, id);
  }
  return byName;
}

export function intrinsicWrapperId(fn: FnDecl): IntrinsicId | undefined {
  if (fn.primitiveId && isKnownIntrinsicId(fn.primitiveId)) return fn.primitiveId;
  const expr = fn.body.expr;
  if (fn.body.statements.length !== 0 || !expr || expr.kind !== "call") return undefined;
  if (expr.callee.kind !== "var" || !expr.callee.name.startsWith("@")) return undefined;
  const id = expr.callee.name.slice(1);
  return isKnownIntrinsicId(id) ? id : undefined;
}

export function isIntrinsicWrapper(fn: FnDecl): boolean {
  return intrinsicWrapperId(fn) !== undefined;
}
