import type { Expr, Program } from "../src/core_ast.ts";
import { type CheckTrace, checkSource, optimizeProgram } from "../src/mod.ts";

const sizes = stringArg("--sizes")
  ?.split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0) ?? [10, 100, 500, 1000];
const iterations = numberArg("--iterations", 25);

for (const size of sizes) {
  const rows = [];
  for (const mode of ["direct", "runtime-dict", "const-param"] as const) {
    const source = sourceFor(mode, size);
    await checkSource(source);
    const samples = [];
    let program: Program | undefined;
    let trace: CheckTrace | undefined;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const checked = await checkSource(source, { trace: true });
      program = checked.program;
      trace = checked.trace;
      samples.push(performance.now() - start);
    }
    const counts = countCalls(program!);
    const optimizeStart = performance.now();
    const optimized = optimizeProgram(program!);
    const optimizeMs = performance.now() - optimizeStart;
    const optimizedCounts = countCalls(optimized, { includeGenerated: false });
    rows.push({
      mode,
      calls: size,
      avg_ms: avg(samples).toFixed(3),
      p95_ms: percentile(samples, 0.95).toFixed(3),
      optimize_ms: optimizeMs.toFixed(3),
      checked_direct_calls: counts.get("map_box") ?? 0,
      checked_runtime_dict_calls: counts.get("dict.map") ?? 0,
      checked_wrapper_calls: counts.get("mapped__box_functor") ?? 0,
      checked_generated_direct_calls: countGeneratedDirectCalls(program!),
      optimized_direct_calls: optimizedCounts.get("map_box") ?? 0,
      optimized_runtime_dict_calls: optimizedCounts.get("dict.map") ?? 0,
      optimized_wrapper_calls: optimizedCounts.get("mapped__box_functor") ?? 0,
      slowest_check_phase: slowestPhase(trace),
      specialization: specializationSummary(trace),
    });
  }
  console.table(rows);
}

function sourceFor(mode: "direct" | "runtime-dict" | "const-param", calls: number): string {
  const mappedParam = mode === "const-param" ? "const dict: Functor(box)" : "dict: Functor(box)";
  const call = mode === "direct"
    ? "map_box(Box {value: 1}).value"
    : "mapped(box_functor, Box {value: 1}).value";
  return `
    type fn Box() -> type {
      let Box = {value: i32};
      struct(Box)
    }
    type fn Functor(f: type) -> type {
      let Functor = {map: fn(x: f) -> f};
      struct(Functor)
    }
    fn map_box(x: Box) -> Box {
      Box {value: x.value + 1}
    }
    const box_functor: Functor(box) = {map: map_box};
    fn mapped(${mappedParam}, x: Box) -> Box {
      dict.map(x)
    }
    pub fn main() -> i32 {
      ${Array.from({ length: calls }, () => call).join(" +\n      ")}
    }
  `;
}

function countCalls(
  program: Program,
  options: { includeGenerated?: boolean } = {},
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      if (options.includeGenerated === false && decl.generated) continue;
      countExpr(decl.body, counts);
    } else if (decl.kind === "const" || decl.kind === "let") countExpr(decl.value, counts);
  }
  return counts;
}

function countExpr(expr: Expr, counts: Map<string, number>) {
  switch (expr.kind) {
    case "call":
      if (expr.callee.kind === "var") {
        counts.set(expr.callee.name, (counts.get(expr.callee.name) ?? 0) + 1);
      }
      countExpr(expr.callee, counts);
      for (const arg of expr.args) countExpr(arg, counts);
      return;
    case "binary":
      countExpr(expr.left, counts);
      countExpr(expr.right, counts);
      return;
    case "match":
      countExpr(expr.value, counts);
      for (const arm of expr.arms) countExpr(arm.value, counts);
      return;
    case "shape":
      for (const slot of expr.slots) countExpr(slot.value, counts);
      return;
    case "range":
      countExpr(expr.start, counts);
      countExpr(expr.end, counts);
      return;
    case "block":
      for (const stmt of expr.statements) {
        if (stmt.kind === "let") countExpr(stmt.value, counts);
      }
      if (expr.expr) countExpr(expr.expr, counts);
      return;
    case "literal":
    case "var":
      return;
  }
}

function countGeneratedDirectCalls(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn" || !decl.generated) continue;
    const counts = new Map<string, number>();
    countExpr(decl.body, counts);
    total += counts.get("map_box") ?? 0;
  }
  return total;
}

function slowestPhase(trace: CheckTrace | undefined): string {
  const phase = trace?.phases.toSorted((left, right) => right.ms - left.ms)[0];
  return phase ? `${phase.name}:${phase.ms.toFixed(3)}ms` : "";
}

function specializationSummary(trace: CheckTrace | undefined): string {
  if (!trace) return "";
  const parts = trace.phases
    .filter((phase) => phase.specialization)
    .map((phase) => {
      const stats = phase.specialization!;
      return `${phase.name}=v${stats.visitedCalls}/g${stats.generatedSpecializations}/h${stats.cacheHits}/m${stats.cacheMisses}`;
    });
  return parts.join(" ");
}

function avg(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function stringArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = Deno.args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

function numberArg(name: string, fallback: number): number {
  const value = Number(stringArg(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
