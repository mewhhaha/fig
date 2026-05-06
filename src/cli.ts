import { checkSource, wasmFromSource, watFromSource } from "./mod.ts";
import { CompileError, formatDiagnostic } from "./diagnostics.ts";

const [cmd, file, ...rest] = Deno.args;

try {
  if (!cmd || !file) usage();
  const source = await Deno.readTextFile(file);
  const options = { resolveModule: moduleResolver(file) };
  if (cmd === "check") {
    await checkSource(source, options);
    console.log("ok");
  } else if (cmd === "wat") {
    console.log(await watFromSource(source, options));
  } else if (cmd === "build") {
    const outFlag = rest.indexOf("--out");
    const out = outFlag >= 0 ? rest[outFlag + 1] : file.replace(/\.shovel$/, ".wasm");
    await Deno.writeFile(out, await wasmFromSource(source, options));
    console.log(out);
  } else if (cmd === "run") {
    const wasm = await wasmFromSource(source, options);
    const module = new WebAssembly.Module(wasm);
    const imports = WebAssembly.Module.imports(module);
    if (imports.length) {
      const names = imports.map((item) => `${item.module}.${item.name}`).join(", ");
      throw new Error(`host imports required: ${names}`);
    }
    const instance = new WebAssembly.Instance(module);
    const main = instance.exports.main;
    if (typeof main !== "function") throw new Error("missing exported main");
    console.log(main());
  } else usage();
} catch (error) {
  if (error instanceof CompileError) {
    for (const diagnostic of error.diagnostics) console.error(formatDiagnostic(diagnostic));
    Deno.exit(1);
  }
  throw error;
}

function usage(): never {
  console.error("usage: shovel <check|wat|build|run> <file> [--out module.wasm]");
  Deno.exit(2);
}

function moduleResolver(entryFile: string) {
  return async (moduleName: string): Promise<string | undefined> => {
    for (const path of candidateModulePaths(entryFile, moduleName)) {
      try {
        return await Deno.readTextFile(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return undefined;
  };
}

function candidateModulePaths(entryFile: string, moduleName: string): string[] {
  const relative = `${moduleName.replaceAll(".", "/")}.shovel`;
  const dotted = `${moduleName}.shovel`;
  const entryUrl = new URL(entryFile, `file://${Deno.cwd()}/`);
  const entryDir = new URL(".", entryUrl);
  const candidates = [
    new URL(relative, entryDir).pathname,
    new URL(dotted, entryDir).pathname,
  ];
  if (moduleName.startsWith("prelude.")) {
    candidates.push(new URL(`../${relative}`, import.meta.url).pathname);
  }
  return candidates;
}
