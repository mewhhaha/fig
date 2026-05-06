import { parse } from "./parser.ts";
import { checkProgram } from "./check.ts";
import { emitWasm, emitWat } from "./backend.ts";

export function checkSource(source: string) {
  return parse(source).then(checkProgram);
}

export async function watFromSource(source: string): Promise<string> {
  return emitWat((await checkSource(source)).program);
}

export async function wasmFromSource(source: string): Promise<Uint8Array<ArrayBuffer>> {
  return emitWasm((await checkSource(source)).program);
}

export { parse } from "./parser.ts";
export { tokenize } from "./tokenize.ts";
export { optimizeProgram } from "./optimize.ts";
export { CompileError, formatDiagnostic } from "./diagnostics.ts";
