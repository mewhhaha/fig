import type { ShapeTypeSlot, TypeDecl } from "./core_ast.ts";
import { parseRefinedI32Type } from "./refined_scalar.ts";

export type RuntimeTypeClass =
  | "scalar"
  | "flat_product"
  | "inline_array"
  | "heap_handle"
  | "buffer_handle"
  | "closure"
  | "multi";

export interface RuntimeTypeInfo {
  class: RuntimeTypeClass;
  resolvedType?: string;
  slots: string[];
}

export function runtimeTypeInfo(
  type: string | undefined,
  types: TypeDecl[],
): RuntimeTypeInfo {
  if (!type) return { class: "multi", slots: ["i32"] };
  const ioItem = ioActionItemType(type);
  if (ioItem) return runtimeTypeInfo(ioItem, types);
  return runtimeTypeInfoInner(stripBorrowType(type) ?? type, types, new Set());
}

export function runtimeTypeSlots(type: string | undefined, types: TypeDecl[]): string[] {
  return runtimeTypeInfo(type, types).slots;
}

export function resolveRuntimeAliasType(
  type: string | undefined,
  types: TypeDecl[],
): string | undefined {
  let current = stripBorrowType(type);
  const byName = typeDeclMaps(types).byName;
  const byTerminal = typeDeclMaps(types).byTerminal;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const decl = byName.get(current) ?? byTerminal.get(terminalName(current));
    if (decl) {
      if (decl.normalized?.kind !== "alias") return current;
      current = decl.normalized.type;
      continue;
    }
    const callName = typeName(current);
    const callDecl = byName.get(callName) ?? byTerminal.get(terminalName(callName));
    const callArgs = typeCallArgsForBase(current, callName);
    if (callDecl?.normalized?.kind === "alias" && callArgs !== undefined) {
      current = substituteTypeParams(
        callDecl.normalized.type,
        callDecl,
        splitTypeArgs(callArgs),
      );
      continue;
    }
    return current;
  }
  return current;
}

export function runtimeTypeName(type: string): string {
  return typeName(type);
}

export function runtimeTypeCallArgs(type: string, baseName: string): string | undefined {
  return typeCallArgsForBase(type, baseName);
}

export function splitRuntimeTypeArgs(source: string): string[] {
  return splitTypeArgs(source);
}

export function substituteRuntimeTypeParams(
  type: string,
  decl: TypeDecl,
  args: string[],
): string {
  return substituteTypeParams(type, decl, args);
}

function runtimeTypeInfoInner(
  source: string,
  types: TypeDecl[],
  seen: Set<string>,
): RuntimeTypeInfo {
  const trimmed = stripBorrowType(source)?.trim() ?? source.trim();
  if (!trimmed) return { class: "multi", slots: ["i32"] };
  const resolved = resolveRuntimeAliasType(trimmed, types) ?? trimmed;
  const seenKey = `${trimmed}\0${resolved}`;
  if (seen.has(seenKey)) {
    return { class: "flat_product", resolvedType: resolved, slots: [resolved] };
  }
  const scopedSeen = new Set(seen).add(seenKey);

  if (isClosureType(trimmed) || isClosureType(resolved)) {
    return { class: "closure", resolvedType: resolved, slots: [resolved] };
  }
  if (isBufferHandleType(trimmed) || isBufferHandleType(resolved)) {
    return { class: "buffer_handle", resolvedType: resolved, slots: [resolved] };
  }

  const inlineArray = inlineArrayLikeTypeArgs(trimmed, types) ??
    inlineArrayLikeTypeArgs(resolved, types);
  if (inlineArray) {
    const slots = repeatSlots(inlineArray.count, inlineArray.itemType, types, scopedSeen);
    return { class: "inline_array", resolvedType: resolved, slots };
  }

  if (isScalarRuntimeType(resolved)) {
    return { class: "scalar", resolvedType: resolved, slots: [resolved] };
  }

  const productSlots = normalizedProductSlots(resolved, types) ?? structuralProductSlots(resolved);
  if (productSlots) {
    const slots = productSlots.flatMap((slot) =>
      repeatSlots(
        repeatCount(slot.repeat),
        slot.type,
        types,
        scopedSeen,
      )
    );
    return { class: "flat_product", resolvedType: resolved, slots: slots.length ? slots : ["i32"] };
  }

  return { class: "flat_product", resolvedType: resolved, slots: [resolved] };
}

function repeatSlots(
  count: number,
  itemType: string,
  types: TypeDecl[],
  seen: Set<string>,
): string[] {
  const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
  const itemSlots = runtimeTypeInfoInner(itemType, types, seen).slots;
  return Array.from({ length: safeCount }, () => itemSlots).flat();
}

function normalizedProductSlots(
  type: string,
  types: TypeDecl[],
): ShapeTypeSlot[] | undefined {
  const maps = typeDeclMaps(types);
  const name = typeName(type);
  const decl = maps.byName.get(name) ?? maps.byTerminal.get(terminalName(name));
  if (decl?.normalized?.kind !== "product") return undefined;
  const args = typeCallArgsForBase(type, name) ?? typeCallArgsForBase(type, decl.name);
  if (args === undefined) return decl.normalized.shape.slots;
  const values = splitTypeArgs(args);
  return decl.normalized.shape.slots.map((slot) => ({
    ...slot,
    type: substituteTypeParams(slot.type, decl, values),
    ...(slot.repeat ? { repeat: substituteTypeParams(slot.repeat, decl, values) } : {}),
  }));
}

function structuralProductSlots(type: string): ShapeTypeSlot[] | undefined {
  const structArgs = typeCallArgsForBase(type, "struct");
  if (!structArgs) return undefined;
  const trimmed = structArgs.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return splitTypeArgs(inner).map((part, position) => {
    const colon = topLevelColon(part);
    return colon < 0 ? { position, type: part.trim() } : {
      position,
      label: part.slice(0, colon).trim(),
      type: part.slice(colon + 1).trim(),
    };
  });
}

function inlineArrayLikeTypeArgs(
  type: string | undefined,
  types: TypeDecl[],
): { count: number; itemType: string } | undefined {
  const candidates = [type, resolveRuntimeAliasType(type, types)].filter((
    candidate,
  ): candidate is string => Boolean(candidate));
  let args: string | undefined;
  for (const candidate of candidates) {
    const unqualified = candidate.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
    args = typeCallArgsForBase(unqualified, "InlineArray") ??
      typeCallArgsForBase(unqualified, "InlineArrayList") ??
      typeCallArgsForBase(unqualified, "InlineArrayBuilder");
    if (args !== undefined) break;
  }
  if (args === undefined) return undefined;
  const [count, itemType] = splitTypeArgs(args);
  return {
    count: count && /^[0-9]+$/.test(count) ? Number.parseInt(count, 10) : Number.NaN,
    itemType: itemType?.trim() || "i32",
  };
}

function typeDeclMaps(types: TypeDecl[]): {
  byName: Map<string, TypeDecl>;
  byTerminal: Map<string, TypeDecl>;
} {
  return {
    byName: new Map(types.map((decl) => [decl.name, decl])),
    byTerminal: new Map(types.map((decl) => [terminalName(decl.name), decl])),
  };
}

function isScalarRuntimeType(type: string | undefined): boolean {
  if (!type) return false;
  if (parseRefinedI32Type(type)) return true;
  return ["i32", "bool", "char", "count", "i64", "f32", "f64", "u32", "u64"].includes(type) ||
    unsignedBitWidth(type) !== undefined;
}

function ioActionItemType(type: string | undefined): string | undefined {
  const args = typeCallArgsForBase(type?.trim() ?? "", "io");
  if (args === undefined) return undefined;
  return splitTypeArgs(args)[0]?.trim() || "i32";
}

function isClosureType(type: string | undefined): boolean {
  return Boolean(type && /fn\s*\(/.test(type));
}

function isBufferHandleType(type: string | undefined): boolean {
  return Boolean(type && /\b(?:Buffer|String|Bytes)\b/.test(type));
}

function unsignedBitWidth(type: string | undefined): number | undefined {
  const match = type?.match(/^u([1-9][0-9]*)$/);
  if (!match) return undefined;
  const width = Number.parseInt(match[1] ?? "", 10);
  return width >= 1 && width <= 64 ? width : undefined;
}

function typeName(type: string): string {
  return type.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/)?.[1] ??
    type.trim();
}

function terminalName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function typeCallArgsForBase(type: string, baseName: string): string | undefined {
  const trimmed = type.trim();
  const prefix = `${baseName}(`;
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(")")) return undefined;
  return trimmed.slice(prefix.length, -1);
}

function splitTypeArgs(source: string): string[] {
  const args: string[] = [];
  let parenDepth = 0;
  let braceDepth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth--;
    else if (char === "," && parenDepth === 0 && braceDepth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(source.slice(start).trim());
  return args.filter((arg) => arg.length > 0);
}

function substituteTypeParams(type: string, decl: TypeDecl, args: string[]): string {
  let result = type;
  decl.params.forEach((param, index) => {
    const arg = args[index]?.trim();
    if (!arg) return;
    result = result.replace(new RegExp(`\\b${param.name}\\b`, "g"), arg);
  });
  return result;
}

function repeatCount(repeat: string | undefined): number {
  if (!repeat) return 1;
  const parsed = Number.parseInt(repeat, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function topLevelColon(source: string): number {
  let parenDepth = 0;
  let braceDepth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth--;
    else if (char === ":" && parenDepth === 0 && braceDepth === 0) return index;
  }
  return -1;
}

function stripBorrowType(type: string | undefined): string | undefined {
  let current = type?.trim();
  while (current?.startsWith("&")) current = unwrapPrefixedType(current, "&");
  return current;
}

function unwrapPrefixedType(type: string, prefix: string): string | undefined {
  if (!type.startsWith(prefix)) return undefined;
  const inner = type.slice(prefix.length).trim();
  if (!inner.startsWith("(")) return inner;
  let depth = 0;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return inner.slice(1, index).trim();
    }
  }
  return inner;
}
