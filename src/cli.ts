import { checkSource, formatSource, wasmFromSource, watFromSource } from "./mod.ts";
import { CompileError, formatDiagnostic } from "./diagnostics.ts";
import type { MemoryModel } from "./backend.ts";
import { OPTIMIZE_PROFILES, type OptimizeProfileName, type OptMode } from "./optimize.ts";

const [cmd, ...args] = Deno.args;

try {
  const fileIndex = args.findIndex((arg) => arg === "-" || !arg.startsWith("--"));
  const singleFile = fileIndex >= 0 ? args[fileIndex] : undefined;
  const commandRest = args.filter((_, index) => index !== fileIndex);
  const files = args.filter((arg) => arg === "-" || !arg.startsWith("--"));
  const rest = args.filter((arg) => arg !== "-" && arg.startsWith("--"));
  const file = singleFile;
  if (!cmd || !file) usage();
  if (cmd === "fmt") {
    if (
      files.includes("-") &&
      (files.length > 1 || rest.includes("--write") || rest.includes("--check"))
    ) {
      usage();
    }
    if (rest.includes("--write") && rest.includes("--check")) usage();
    if (file === "-") {
      const source = await new Response(Deno.stdin.readable).text();
      const formatted = formatSource(source);
      console.log(formatted.trimEnd());
      Deno.exit(0);
    }
    if (rest.includes("--check")) {
      let failed = false;
      for (const item of files) {
        const source = await Deno.readTextFile(item);
        const formatted = formatSource(source);
        if (formatted !== source) {
          console.error(`${item} is not formatted`);
          failed = true;
        }
      }
      Deno.exit(failed ? 1 : 0);
    }
    for (const item of files) {
      const source = await Deno.readTextFile(item);
      const formatted = formatSource(source);
      if (rest.includes("--write")) {
        if (formatted !== source) await Deno.writeTextFile(item, formatted);
        continue;
      }
      console.log(formatted.trimEnd());
    }
  } else if (cmd === "check") {
    const rest = commandRest;
    const source = await Deno.readTextFile(file);
    const options = { resolveModule: moduleResolver(file) };
    await checkSource(source, options);
    console.log("ok");
  } else if (cmd === "wat") {
    const rest = commandRest;
    const source = await Deno.readTextFile(file);
    const options = {
      resolveModule: moduleResolver(file),
      memoryModel: parseMemoryModel(rest),
      optMode: parseOptMode(rest),
      profile: parseOptimizeProfile(rest),
      branchHints: parseBranchHints(rest),
    };
    console.log(await watFromSource(source, options));
  } else if (cmd === "build") {
    const rest = commandRest;
    const source = await Deno.readTextFile(file);
    const options = {
      resolveModule: moduleResolver(file),
      memoryModel: parseMemoryModel(rest),
      optMode: parseOptMode(rest),
      profile: parseOptimizeProfile(rest),
      branchHints: parseBranchHints(rest),
    };
    const outFlag = rest.indexOf("--out");
    const manifestFlag = rest.indexOf("--shader-manifest");
    const out = outFlag >= 0 ? rest[outFlag + 1] : file.replace(/\.fig$/, ".wasm");
    const manifestOut = manifestFlag >= 0 ? rest[manifestFlag + 1] : undefined;
    await Deno.writeFile(out, await wasmFromSource(source, options));
    if (manifestOut) {
      const checked = await checkSource(source, options);
      await Deno.writeTextFile(
        manifestOut,
        `${JSON.stringify(checked.shaderManifest, null, 2)}\n`,
      );
    }
    console.log(out);
  } else if (cmd === "run") {
    const rest = commandRest;
    const source = await Deno.readTextFile(file);
    const options = {
      resolveModule: moduleResolver(file),
      memoryModel: parseMemoryModel(rest),
      optMode: parseOptMode(rest),
      profile: parseOptimizeProfile(rest),
      branchHints: parseBranchHints(rest),
    };
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
  console.error(
    "usage: fig <check|fmt|wat|build|run> <file> [--write|--check] [--memory temporal|branch-debug|branch] [--release|--release-fast-compile] [--profile name] [--branch-hints|--no-branch-hints] [--out module.wasm] [--shader-manifest manifest.json]",
  );
  Deno.exit(2);
}

function parseMemoryModel(args: string[]): MemoryModel | undefined {
  const eq = args.find((arg) => arg.startsWith("--memory="));
  const value = eq ? eq.slice("--memory=".length) : args[args.indexOf("--memory") + 1];
  if (!value || args.indexOf("--memory") < 0 && !eq) return undefined;
  if (value === "temporal" || value === "branch-debug" || value === "branch") return value;
  usage();
}

function parseOptMode(args: string[]): OptMode {
  if (args.some((arg) => arg === "--opt" || arg.startsWith("--opt=") || arg === "--debug")) {
    usage();
  }
  if (args.some((arg) => arg.startsWith("--release="))) usage();
  return args.includes("--release") || args.includes("--release-fast-compile")
    ? "release"
    : "debug";
}

function parseOptimizeProfile(args: string[]): OptimizeProfileName | undefined {
  if (args.includes("--release-fast-compile")) return "release_fast_compile";
  const eq = args.find((arg) => arg.startsWith("--profile="));
  const value = eq ? eq.slice("--profile=".length) : args[args.indexOf("--profile") + 1];
  if (!value || args.indexOf("--profile") < 0 && !eq) return undefined;
  if (value in OPTIMIZE_PROFILES) return value as OptimizeProfileName;
  usage();
}

function parseBranchHints(args: string[]): boolean | undefined {
  if (args.includes("--branch-hints") && args.includes("--no-branch-hints")) usage();
  if (args.includes("--branch-hints")) return true;
  if (args.includes("--no-branch-hints")) return false;
  return undefined;
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
  const entryUrl = new URL(entryFile, `file://${Deno.cwd()}/`);
  const entryDir = new URL(".", entryUrl);
  if (moduleName.startsWith("./") || moduleName.startsWith("../")) {
    return [new URL(moduleName, entryDir).pathname];
  }
  const relative = `${moduleName.replaceAll(".", "/")}.fig`;
  const dotted = `${moduleName}.fig`;
  const candidates = [
    new URL(relative, entryDir).pathname,
    new URL(dotted, entryDir).pathname,
  ];
  if (moduleName.startsWith("prelude.")) {
    candidates.push(new URL(`../${relative}`, import.meta.url).pathname);
  }
  if (moduleName.startsWith("engine.") || moduleName.startsWith("web.")) {
    candidates.push(new URL(`../${relative}`, import.meta.url).pathname);
  }
  return candidates;
}
