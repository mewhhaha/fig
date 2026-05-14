import type { Declaration, FnDecl } from "./core_ast.ts";
import {
  defaultCompilerPluginRegistry,
  type CompilerPluginRegistry,
  isKnownIntrinsicId as registryHasIntrinsicId,
} from "./plugins.ts";

export const intrinsicIds = [...defaultCompilerPluginRegistry.intrinsics.keys()] as const;

export type IntrinsicId = string;

export function isKnownIntrinsicId(
  id: string,
  registry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
): id is IntrinsicId {
  return registryHasIntrinsicId(id, registry);
}

export function intrinsicCallId(
  name: string,
  intrinsicIdsByName: Map<string, string>,
): string | undefined {
  return intrinsicIdsByName.get(name);
}

export function intrinsicIdsByFunctionName(
  declarations: Iterable<Declaration>,
  registry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
): Map<string, string> {
  const byName = new Map<string, string>();
  for (const decl of declarations) {
    if (decl.kind !== "fn" || !decl.name) continue;
    const id = decl.primitiveId ?? intrinsicWrapperId(decl, registry);
    if (id) byName.set(decl.name, id);
  }
  return byName;
}

export function intrinsicWrapperId(
  fn: FnDecl,
  registry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
): IntrinsicId | undefined {
  if (fn.primitiveId && isKnownIntrinsicId(fn.primitiveId, registry)) return fn.primitiveId;
  const expr = fn.body.expr;
  if (fn.body.statements.length !== 0 || !expr || expr.kind !== "call") return undefined;
  if (expr.callee.kind !== "var" || !expr.callee.name.startsWith("@")) return undefined;
  const id = expr.callee.name.slice(1);
  return isKnownIntrinsicId(id, registry) ? id : undefined;
}

export function isIntrinsicWrapper(
  fn: FnDecl,
  registry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
): boolean {
  return intrinsicWrapperId(fn, registry) !== undefined;
}
