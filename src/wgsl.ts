export interface WgslBinding {
  group: number;
  binding: number;
  name: string;
  addressSpace?: string;
}

export interface WgslLocation {
  location: number;
  name: string;
  stage?: "vertex" | "fragment";
}

export interface ShaderManifestEntry {
  id: number;
  source: string;
  bindings: WgslBinding[];
  locations: WgslLocation[];
}

export function wgslShaderId(source: string): number {
  const hash = fnv1a32(source);
  return hash & 0x7fffffff;
}

export function scanWgsl(source: string): Omit<ShaderManifestEntry, "id" | "source"> {
  return {
    bindings: scanBindings(source),
    locations: scanLocations(source),
  };
}

export function shaderManifestEntry(source: string): ShaderManifestEntry {
  return {
    id: wgslShaderId(source),
    source,
    ...scanWgsl(source),
  };
}

function scanBindings(source: string): WgslBinding[] {
  const bindings: WgslBinding[] = [];
  const pattern =
    /@group\(\s*(\d+)\s*\)\s*@binding\(\s*(\d+)\s*\)\s*var(?:<([^>]+)>)?\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(pattern)) {
    bindings.push({
      group: Number.parseInt(match[1], 10),
      binding: Number.parseInt(match[2], 10),
      name: match[4],
      ...(match[3]?.trim() ? { addressSpace: match[3].trim() } : {}),
    });
  }
  return bindings.sort((left, right) =>
    left.group - right.group || left.binding - right.binding || left.name.localeCompare(right.name)
  );
}

function scanLocations(source: string): WgslLocation[] {
  const locations: WgslLocation[] = [];
  const locPattern = /@location\(\s*(\d+)\s*\)\s*([A-Za-z_][A-Za-z0-9_]*)?/g;
  for (const match of source.matchAll(locPattern)) {
    locations.push({
      location: Number.parseInt(match[1], 10),
      name: match[2] ?? "return",
      stage: nearestStage(source, match.index ?? 0),
    });
  }
  return locations.sort((left, right) =>
    left.location - right.location || (left.stage ?? "").localeCompare(right.stage ?? "") ||
    left.name.localeCompare(right.name)
  );
}

function nearestStage(source: string, index: number): "vertex" | "fragment" | undefined {
  const prefix = source.slice(0, index);
  const vertex = prefix.lastIndexOf("@vertex");
  const fragment = prefix.lastIndexOf("@fragment");
  if (vertex < 0 && fragment < 0) return undefined;
  return vertex > fragment ? "vertex" : "fragment";
}

function fnv1a32(source: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
