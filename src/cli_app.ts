import {
  checkSource,
  compileArtifactsFromSource,
  type CompileTraceEvent,
  decodeFigValue,
  formatSource,
  wasmFromSource,
  watFromSource,
} from "./mod.ts";
import { CompileError, formatDiagnostic } from "./diagnostics.ts";
import type { MemoryModel } from "./backend.ts";
import { OPTIMIZE_PROFILES, type OptimizeProfileName, type OptMode } from "./optimize.ts";
import { runStdioServer } from "./lsp/server.ts";
import { FIG_VERSION } from "./version.ts";

export interface CliIo {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  stdinText(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  runLsp(): Promise<void>;
}

const USAGE =
  "usage: fig <check|fmt|wat|build|run> <file> [--write|--check] [--memory branch-debug|branch] [--release|--release-fast-compile] [--profile name] [--runtime-profile|--compile-profile] [--branch-hints|--no-branch-hints] [--out module.wasm] [--shader-manifest manifest.json]\n       fig lsp\n       fig version";

class UsageError extends Error {}

export function createDenoCliIo(): CliIo {
  return {
    readTextFile: (path) => Deno.readTextFile(path),
    writeTextFile: (path, data) => Deno.writeTextFile(path, data),
    writeFile: (path, data) => Deno.writeFile(path, data),
    stdinText: () => new Response(Deno.stdin.readable).text(),
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
    runLsp: () => runStdioServer(),
  };
}

export async function runCli(args: string[], io: CliIo = createDenoCliIo()): Promise<number> {
  try {
    await runCliUnchecked(args, io);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(USAGE);
      return 2;
    }
    if (error instanceof CliExit) return error.code;
    if (error instanceof CompileError) {
      for (const diagnostic of error.diagnostics) io.stderr(formatDiagnostic(diagnostic));
      return 1;
    }
    throw error;
  }
}

async function runCliUnchecked(args: string[], io: CliIo): Promise<void> {
  const [cmd, ...restArgs] = args;
  if (cmd === "version") {
    if (restArgs.length) usage();
    io.stdout(FIG_VERSION);
    return;
  }
  if (cmd === "lsp") {
    if (restArgs.length) usage();
    await io.runLsp();
    return;
  }

  const fileIndex = restArgs.findIndex((arg) => arg === "-" || !arg.startsWith("--"));
  const singleFile = fileIndex >= 0 ? restArgs[fileIndex] : undefined;
  const commandRest = restArgs.filter((_, index) => index !== fileIndex);
  const files = restArgs.filter((arg) => arg === "-" || !arg.startsWith("--"));
  const flags = restArgs.filter((arg) => arg !== "-" && arg.startsWith("--"));
  const file = singleFile;
  if (!cmd || !file) usage();

  if (cmd === "fmt") {
    if (
      files.includes("-") &&
      (files.length > 1 || flags.includes("--write") || flags.includes("--check"))
    ) {
      usage();
    }
    if (flags.includes("--write") && flags.includes("--check")) usage();
    if (file === "-") {
      const source = await io.stdinText();
      io.stdout(formatSource(source).trimEnd());
      return;
    }
    if (flags.includes("--check")) {
      let failed = false;
      for (const item of files) {
        const source = await io.readTextFile(item);
        const formatted = formatSource(source);
        if (formatted !== source) {
          io.stderr(`${item} is not formatted`);
          failed = true;
        }
      }
      if (failed) throw new CliExit(1);
      return;
    }
    for (const item of files) {
      const source = await io.readTextFile(item);
      const formatted = formatSource(source);
      if (flags.includes("--write")) {
        if (formatted !== source) await io.writeTextFile(item, formatted);
        continue;
      }
      io.stdout(formatted.trimEnd());
    }
    return;
  }

  if (cmd === "check") {
    const source = await io.readTextFile(file);
    const compileTrace = parseCompileProfile(commandRest) ? [] : undefined;
    await checkSource(source, compileOptions(file, commandRest, io, compileTrace));
    printCompileProfile(io, compileTrace);
    io.stdout("ok");
    return;
  }

  if (cmd === "wat") {
    const source = await io.readTextFile(file);
    const compileTrace = parseCompileProfile(commandRest) ? [] : undefined;
    const options = compileOptions(file, commandRest, io, compileTrace);
    io.stdout(await watFromSource(source, options));
    printCompileProfile(io, compileTrace);
    return;
  }

  if (cmd === "build") {
    const source = await io.readTextFile(file);
    const compileTrace = parseCompileProfile(commandRest) ? [] : undefined;
    const options = compileOptions(file, commandRest, io, compileTrace);
    const outFlag = commandRest.indexOf("--out");
    const manifestFlag = commandRest.indexOf("--shader-manifest");
    const out = outFlag >= 0 ? commandRest[outFlag + 1] : file.replace(/\.fig$/, ".wasm");
    const manifestOut = manifestFlag >= 0 ? commandRest[manifestFlag + 1] : undefined;
    if (!out) usage();
    await io.writeFile(out, await wasmFromSource(source, options));
    if (manifestOut) {
      const checked = await checkSource(source, options);
      await io.writeTextFile(
        manifestOut,
        `${JSON.stringify(checked.shaderManifest, null, 2)}\n`,
      );
    }
    printCompileProfile(io, compileTrace);
    io.stdout(out);
    return;
  }

  if (cmd === "run") {
    const source = await io.readTextFile(file);
    const compileTrace = parseCompileProfile(commandRest) ? [] : undefined;
    const artifact = await compileArtifactsFromSource(source, {
      ...compileOptions(file, commandRest, io, compileTrace),
      includeWat: false,
    });
    printCompileProfile(io, compileTrace);
    const module = new WebAssembly.Module(artifact.wasm);
    const imports = WebAssembly.Module.imports(module);
    const requiredHostImports = imports.filter((item) =>
      item.module !== "env" ||
      (item.name !== "fig_trace" && item.name !== "fig_profile_enter" &&
        item.name !== "fig_profile_exit")
    );
    if (requiredHostImports.length) {
      const names = requiredHostImports.map((item) => `${item.module}.${item.name}`).join(", ");
      throw new Error(`host imports required: ${names}`);
    }
    const traceMessages = new Map(artifact.debugTraces.map((site) => [site.id, site.message]));
    const runtimeProfile = runtimeProfileRecorder(artifact.profileSites, io);
    const instance = new WebAssembly.Instance(module, {
      env: {
        fig_trace(siteId: number) {
          io.stderr(`[trace] ${traceMessages.get(siteId) ?? `site ${siteId}`}`);
        },
        fig_profile_enter: runtimeProfile.enter,
        fig_profile_exit: runtimeProfile.exit,
      },
    });
    const main = instance.exports.main;
    if (typeof main !== "function") throw new Error("missing exported main");
    const raw = main();
    const mainAbi = artifact.abi?.exports.find((item) => item.name === "main");
    const result = mainAbi?.results[0] && artifact.abi
      ? decodeFigValue(artifact.abi, instance, mainAbi.results[0].type, raw)
      : raw;
    io.stdout(typeof result === "object" ? JSON.stringify(result) : String(result));
    runtimeProfile.print();
    return;
  }

  usage();
}

function compileOptions(
  file: string,
  args: string[],
  io: CliIo,
  compileTrace?: CompileTraceEvent[],
) {
  rejectRemovedAbiFlag(args);
  return {
    resolveModule: moduleResolver(file, io),
    memoryModel: parseMemoryModel(args),
    optMode: parseOptMode(args),
    profile: parseOptimizeProfile(args),
    runtimeProfile: parseRuntimeProfile(args),
    branchHints: parseBranchHints(args),
    ...(compileTrace ? { compileTrace } : {}),
  };
}

function usage(): never {
  throw new UsageError();
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function parseMemoryModel(args: string[]): MemoryModel | undefined {
  const eq = args.find((arg) => arg.startsWith("--memory="));
  const value = eq ? eq.slice("--memory=".length) : args[args.indexOf("--memory") + 1];
  if (!value || args.indexOf("--memory") < 0 && !eq) return undefined;
  if (value === "branch-debug" || value === "branch") return value;
  usage();
}

function rejectRemovedAbiFlag(args: string[]) {
  if (args.some((arg) => arg === "--abi" || arg.startsWith("--abi="))) usage();
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

function parseRuntimeProfile(args: string[]): boolean {
  if (args.some((arg) => arg.startsWith("--runtime-profile="))) usage();
  return args.includes("--runtime-profile");
}

function parseCompileProfile(args: string[]): boolean {
  if (args.some((arg) => arg.startsWith("--compile-profile="))) usage();
  return args.includes("--compile-profile");
}

function parseBranchHints(args: string[]): boolean | undefined {
  if (args.includes("--branch-hints") && args.includes("--no-branch-hints")) usage();
  if (args.includes("--branch-hints")) return true;
  if (args.includes("--no-branch-hints")) return false;
  return undefined;
}

function printCompileProfile(io: CliIo, trace: CompileTraceEvent[] | undefined) {
  if (!trace) return;
  io.stderr("[compile-profile] phase ms");
  for (const event of trace) {
    io.stderr(`[compile-profile] ${event.name} ${event.durationMs.toFixed(3)}`);
  }
}

function runtimeProfileRecorder(
  sites: readonly { id: number; label: string }[],
  io: CliIo,
) {
  const labels = new Map(sites.map((site) => [site.id, site.label]));
  const stacks = new Map<number, number[]>();
  const totals = new Map<number, { count: number; totalMs: number }>();
  return {
    enter(siteId: number) {
      const stack = stacks.get(siteId) ?? [];
      stack.push(performance.now());
      stacks.set(siteId, stack);
    },
    exit(siteId: number) {
      const stack = stacks.get(siteId);
      const start = stack?.pop();
      if (start === undefined) return;
      const total = totals.get(siteId) ?? { count: 0, totalMs: 0 };
      total.count += 1;
      total.totalMs += performance.now() - start;
      totals.set(siteId, total);
    },
    print() {
      if (!sites.length) return;
      const byLabel = new Map<string, { count: number; totalMs: number }>();
      for (const site of sites) {
        const current = totals.get(site.id) ?? { count: 0, totalMs: 0 };
        const label = labels.get(site.id) ?? `site ${site.id}`;
        const aggregate = byLabel.get(label) ?? { count: 0, totalMs: 0 };
        aggregate.count += current.count;
        aggregate.totalMs += current.totalMs;
        byLabel.set(label, aggregate);
      }
      io.stderr("[profile] label count total_ms avg_ms");
      for (const [label, total] of byLabel) {
        const avg = total.count > 0 ? total.totalMs / total.count : 0;
        io.stderr(
          `[profile] ${JSON.stringify(label)} ${total.count} ${total.totalMs.toFixed(3)} ${
            avg.toFixed(3)
          }`,
        );
      }
    },
  };
}

function moduleResolver(entryFile: string, io: CliIo) {
  return async (moduleName: string): Promise<string | undefined> => {
    for (const path of candidateModulePaths(entryFile, moduleName)) {
      try {
        return await io.readTextFile(path);
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
  candidates.push(new URL(`../${relative}`, import.meta.url).pathname);
  return candidates;
}
