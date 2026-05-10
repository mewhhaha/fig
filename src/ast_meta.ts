export const AST_METADATA_KEYS = ["span", "nameSpan", "nameSpans"] as const;

type MetadataKey = typeof AST_METADATA_KEYS[number];

export function defineAstMetadata<t extends object>(
  target: t,
  source: Partial<Record<MetadataKey, unknown>>,
): t {
  for (const key of AST_METADATA_KEYS) {
    if (!(key in source)) continue;
    Object.defineProperty(target, key, {
      value: source[key],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return target;
}

export function copyAstMetadata<t extends object>(target: t, source: unknown): t {
  if (!source || typeof source !== "object") return target;
  return defineAstMetadata(target, source as Partial<Record<MetadataKey, unknown>>);
}

export function hideAstMetadata<t>(value: t, seen = new WeakSet<object>()): t {
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (seen.has(object)) return value;
  seen.add(object);
  defineAstMetadata(object, object);
  for (const child of Object.values(object)) hideAstMetadata(child, seen);
  return value;
}

export function stripAstMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAstMetadata);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if ((AST_METADATA_KEYS as readonly string[]).includes(key)) continue;
    result[key] = stripAstMetadata(child);
  }
  return result;
}
