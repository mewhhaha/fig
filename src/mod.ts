import { parse } from "./parser.ts";
import { checkProgram } from "./check.ts";
import { emitWasm, emitWat } from "./backend.ts";
import type { Declaration, Program } from "./core_ast.ts";
import { CompileError, type Diagnostic } from "./diagnostics.ts";

export interface CheckSourceOptions {
  resolveModule?: (moduleName: string) => string | Promise<string | undefined>;
}

export async function checkSource(source: string, options: CheckSourceOptions = {}) {
  const program = await parse(source);
  if (!options.resolveModule) return checkProgram(program);
  return checkProgram(
    await resolveSourceImports(program, { resolveModule: options.resolveModule }),
  );
}

export async function watFromSource(
  source: string,
  options: CheckSourceOptions = {},
): Promise<string> {
  return emitWat((await checkSource(source, options)).program);
}

export async function wasmFromSource(
  source: string,
  options: CheckSourceOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  return emitWasm((await checkSource(source, options)).program);
}

export { parse } from "./parser.ts";
export { tokenize } from "./tokenize.ts";
export { optimizeProgram } from "./optimize.ts";
export { CompileError, formatDiagnostic } from "./diagnostics.ts";

async function resolveSourceImports(
  root: Program,
  options: Required<Pick<CheckSourceOptions, "resolveModule">>,
): Promise<Program> {
  const diagnostics: Diagnostic[] = [];
  const visiting: string[] = [];
  const resolved = new Map<string, Program>();

  async function load(moduleName: string): Promise<Program | undefined> {
    if (resolved.has(moduleName)) return resolved.get(moduleName);
    const cycleStart = visiting.indexOf(moduleName);
    if (cycleStart >= 0) {
      diagnostics.push({
        code: "module.cycle",
        message: `source import cycle: ${[...visiting.slice(cycleStart), moduleName].join(" -> ")}`,
      });
      return undefined;
    }
    visiting.push(moduleName);
    const source = await options.resolveModule(moduleName);
    if (source === undefined) {
      diagnostics.push({
        code: "module.not_found",
        message: `cannot resolve module ${moduleName}`,
      });
      visiting.pop();
      return undefined;
    }
    const parsed = await parse(source);
    const merged = await mergeImports(parsed);
    resolved.set(moduleName, merged);
    visiting.pop();
    return merged;
  }

  async function mergeImports(program: Program): Promise<Program> {
    const importedPrograms: Program[] = [];
    for (const item of program.sourceImports ?? []) {
      const imported = await load(item.module);
      if (imported) importedPrograms.push(imported);
    }
    return mergePrograms(importedPrograms, program, diagnostics);
  }

  const merged = await mergeImports(root);
  if (diagnostics.length) throw new CompileError(diagnostics);
  return merged;
}

function mergePrograms(imports: Program[], program: Program, diagnostics: Diagnostic[]): Program {
  const importedDecls = imports.flatMap((item) => item.declarations);
  const localNames = new Set(program.declarations.map(declarationName));
  const seenImported = new Map<string, Declaration>();
  const declarations: Declaration[] = [];
  for (const decl of importedDecls) {
    const name = declarationName(decl);
    if (localNames.has(name) || seenImported.has(name)) {
      diagnostics.push({
        code: "module.duplicate_import",
        message: `imported declaration ${name} conflicts with another declaration`,
      });
      continue;
    }
    seenImported.set(name, decl);
    declarations.push(decl);
  }
  declarations.push(...program.declarations);
  return {
    moduleName: program.moduleName,
    imports: [...imports.flatMap((item) => item.imports), ...program.imports],
    sourceImports: [],
    declarations,
  };
}

function declarationName(decl: Declaration): string {
  return decl.name;
}
