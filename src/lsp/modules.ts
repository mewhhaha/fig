export function uriToPath(uri: string): string {
  return new URL(uri).pathname;
}

export function pathToUri(path: string): string {
  return new URL(path, "file://").href;
}

export function candidateModulePaths(entryPath: string, moduleName: string): string[] {
  const entryUrl = new URL(entryPath, `file://${Deno.cwd()}/`);
  const entryDir = new URL(".", entryUrl);
  if (moduleName.startsWith("./") || moduleName.startsWith("../")) {
    const path = new URL(moduleName, entryDir).pathname;
    return path.endsWith(".fig") ? [path] : [`${path}.fig`, path];
  }
  const relative = `${moduleName.replaceAll(".", "/")}.fig`;
  const dotted = `${moduleName}.fig`;
  const candidates = [
    new URL(relative, entryDir).pathname,
    new URL(dotted, entryDir).pathname,
  ];
  if (!moduleName.startsWith(".") && !moduleName.startsWith("/")) {
    candidates.push(new URL(`../../${relative}`, import.meta.url).pathname);
  }
  return candidates;
}
