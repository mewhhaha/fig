import { checkSource, wasmFromSource, watFromSource } from "./mod.ts";
import { CompileError, formatDiagnostic } from "./diagnostics.ts";

const [cmd, file, ...rest] = Deno.args;

try {
  if (!cmd || !file) usage();
  const source = await Deno.readTextFile(file);
  if (cmd === "check") {
    await checkSource(source);
    console.log("ok");
  } else if (cmd === "wat") {
    console.log(await watFromSource(source));
  } else if (cmd === "build") {
    const outFlag = rest.indexOf("--out");
    const out = outFlag >= 0 ? rest[outFlag + 1] : file.replace(/\.shovel$/, ".wasm");
    await Deno.writeFile(out, await wasmFromSource(source));
    console.log(out);
  } else if (cmd === "run") {
    const wasm = await wasmFromSource(source);
    const module = new WebAssembly.Module(wasm);
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
