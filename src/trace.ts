import type { Declaration, Program } from "./core_ast.ts";

export type CompileTraceValue = string | number | boolean | undefined;

export interface CompileTraceEvent {
  name: string;
  durationMs: number;
  counters?: Record<string, CompileTraceValue>;
}

export type CompileTraceSink =
  | CompileTraceEvent[]
  | ((event: CompileTraceEvent) => void)
  | { onCompileTrace(event: CompileTraceEvent): void };

export interface CompileTraceOptions {
  trace?: CompileTraceSink;
}

export function traceSync<t>(
  trace: CompileTraceSink | undefined,
  name: string,
  run: () => t,
  counters?: (result: t) => Record<string, CompileTraceValue>,
): t {
  if (!trace) return run();
  const start = nowMs();
  const result = run();
  emitTrace(trace, {
    name,
    durationMs: nowMs() - start,
    counters: counters?.(result),
  });
  return result;
}

export function traceInstant(
  trace: CompileTraceSink | undefined,
  name: string,
  counters?: Record<string, CompileTraceValue>,
) {
  if (!trace) return;
  emitTrace(trace, { name, durationMs: 0, counters });
}

export async function traceAsync<t>(
  trace: CompileTraceSink | undefined,
  name: string,
  run: () => t | Promise<t>,
  counters?: (result: t) => Record<string, CompileTraceValue>,
): Promise<t> {
  if (!trace) return await run();
  const start = nowMs();
  const result = await run();
  emitTrace(trace, {
    name,
    durationMs: nowMs() - start,
    counters: counters?.(result),
  });
  return result;
}

export function programTraceCounters(program: Program): Record<string, number> {
  const declarations = program.declarations;
  const functions = declarations.filter((decl) => decl.kind === "fn");
  return {
    astNodes: countAstNodes(program),
    declarations: declarations.length,
    functions: functions.length,
    generatedFunctions: functions.filter((decl) => decl.generated).length,
    publicFunctions: functions.filter((decl) => decl.public).length,
    types: declarations.filter((decl) => decl.kind === "type").length,
    consts: declarations.filter((decl) => decl.kind === "const").length,
    lets: declarations.filter((decl) => decl.kind === "let").length,
    imports: program.imports.length,
    sourceImports: program.sourceImports?.length ?? 0,
  };
}

export function formatCompileTraceEvent(event: CompileTraceEvent): string {
  const counters = Object.entries(event.counters ?? {})
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `[trace] ${event.name} ${event.durationMs.toFixed(2)}ms${counters ? ` ${counters}` : ""}`;
}

function emitTrace(trace: CompileTraceSink, event: CompileTraceEvent) {
  if (Array.isArray(trace)) {
    trace.push(event);
  } else if (typeof trace === "function") {
    trace(event);
  } else {
    trace.onCompileTrace(event);
  }
}

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function countAstNodes(program: Program): number {
  let count = 1;
  const seen = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (isAstNode(value)) count++;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "span" || key === "nameSpan" || key === "nameSpans") continue;
      visit(child);
    }
  };
  for (const decl of program.declarations) visit(decl);
  for (const item of program.imports) visit(item);
  for (const item of program.sourceImports ?? []) visit(item);
  return count;
}

function isAstNode(value: object): value is Declaration | { kind: string } {
  return typeof (value as { kind?: unknown }).kind === "string";
}
