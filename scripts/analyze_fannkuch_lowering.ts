import { checkSource, wasmFromSource, watFromSource } from "../src/mod.ts";
import { optimizeProgram, summarizeProgram } from "../src/unstable.ts";

type SectionRow = {
  id: number;
  name: string;
  payload_bytes: number;
  total_bytes: number;
};

type HotFunctionRow = {
  name: string;
  wat_bytes: number;
  loops: number;
  calls: number;
  return_calls: number;
  dec_calls: number;
  step_calls: number;
  fixed_array_packed_refs: number;
  fixed_array_local_slot_refs: number;
  fig_buffers_refs: number;
  shifts: number;
  selects: number;
  call_targets: string;
};

const source = await Deno.readTextFile("examples/perf_fannkuch_redux.fig");

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

const checked = (await checkSource(source, { resolveModule })).program;
const optimized = optimizeProgram(checked, { optMode: "release" });
const wat = await watFromSource(source, {
  resolveModule,
  optMode: "release",
  memoryModel: "branch",
});
const wasm = await wasmFromSource(source, {
  resolveModule,
  optMode: "release",
  memoryModel: "branch",
});
const wasmNoHints = await wasmFromSource(source, {
  resolveModule,
  optMode: "release",
  memoryModel: "branch",
  branchHints: false,
});

const functionNames = [
  "dec",
  "max_i32",
  "swap",
  "reverse_prefix_loop",
  "flip_count_loop",
  "score",
  "prepare",
  "rotate_left_loop",
  "rotate_left",
  "step_continue",
  "step_active",
  "advance",
  "search",
];

console.log("fannkuch_redux_7 lowering analysis");
console.log({
  optMode: "release",
  memoryModel: "branch",
  wat_bytes: wat.length,
  wasm_bytes: wasm.byteLength,
  wasm_bytes_without_branch_hints: wasmNoHints.byteLength,
});

printSummary("checked", checked);
printSummary("optimized", optimized);

console.log("\nhot WAT function shape");
console.table(hotFunctionRows(wat));

console.log("\nWasm sections");
console.table(sectionRows(wasm));

console.log("\nremaining whole-module call targets");
console.table(callTargetRows(wat));

function printSummary(label: string, program: typeof checked) {
  const summaries = summarizeProgram(program, { optMode: "release" });
  console.log(`\n${label} function summaries`);
  console.table(
    functionNames.map((name) => {
      const summary = summaries.get(name);
      return summary
        ? {
          name,
          recursive: summary.recursiveKind,
          ast_cost: summary.astCost,
          return_class: summary.returnClass,
          calls: summary.callCount,
          inline_candidate: !summary.isPublic && !summary.isPrimitive && summary.isPure &&
            summary.recursiveKind === "none",
        }
        : { name, missing: true };
    }),
  );
}

function hotFunctionRows(moduleWat: string): HotFunctionRow[] {
  return [
    "main",
    "search",
    "flip_count_loop",
    "step_active",
    "step_continue",
  ].map((name) => {
    const body = functionWat(moduleWat, name);
    const callTargets = [...body.matchAll(/\b(?:call|return_call) \$([^\s)]+)/g)]
      .map((match) => match[1] ?? "");
    return {
      name,
      wat_bytes: body.length,
      loops: count(body, /\bloop\b/g),
      calls: count(body, /\bcall \$/g),
      return_calls: count(body, /\breturn_call \$/g),
      dec_calls: callTargets.filter((target) => target === "dec").length,
      step_calls: callTargets.filter((target) =>
        target === "step_active" || target === "step_continue"
      ).length,
      fixed_array_packed_refs: count(body, /fixed_array_packed/g),
      fixed_array_local_slot_refs: count(body, /__fixed_local_slot|__fixed_swap_/g),
      fig_buffers_refs: count(body, /fig_buffers/g),
      shifts: count(body, /\b(?:i32|i64)\.(?:shl|shr_[su])\b/g),
      selects: count(body, /\bselect\b/g),
      call_targets: [...new Set(callTargets)].join(", ") || "<none>",
    };
  });
}

function callTargetRows(moduleWat: string) {
  const counts = new Map<string, number>();
  for (const match of moduleWat.matchAll(/\b(?:call|return_call) \$([^\s)]+)/g)) {
    const target = match[1] ?? "";
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([target, calls]) => ({ target, calls }));
}

function functionWat(moduleWat: string, name: string): string {
  return moduleWat.match(new RegExp(`\\(func \\$${escapeRegExp(name)}[\\s\\S]*?\\n  \\)`))?.[0] ??
    "";
}

function sectionRows(wasmBytes: Uint8Array): SectionRow[] {
  const rows: SectionRow[] = [];
  let offset = 8;
  while (offset < wasmBytes.length) {
    const start = offset;
    const id = wasmBytes[offset++] ?? 0;
    const size = readUleb(wasmBytes, offset);
    offset = size.next;
    const payloadStart = offset;
    let sectionName = sectionNameForId(id);
    if (id === 0) {
      const customName = readName(wasmBytes, payloadStart);
      sectionName = customName.name ? `custom:${customName.name}` : "custom";
    }
    offset += size.value;
    rows.push({
      id,
      name: sectionName,
      payload_bytes: size.value,
      total_bytes: offset - start,
    });
  }
  return rows;
}

function readName(bytes: Uint8Array, offset: number): { name: string; next: number } {
  const length = readUleb(bytes, offset);
  const start = length.next;
  const end = start + length.value;
  return { name: new TextDecoder().decode(bytes.slice(start, end)), next: end };
}

function readUleb(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let index = offset;
  while (index < bytes.length) {
    const byte = bytes[index++] ?? 0;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, next: index };
}

function sectionNameForId(id: number): string {
  return [
    "custom",
    "type",
    "import",
    "function",
    "table",
    "memory",
    "global",
    "export",
    "start",
    "element",
    "code",
    "data",
    "data_count",
  ][id] ?? `unknown:${id}`;
}

function count(sourceText: string, pattern: RegExp): number {
  return sourceText.match(pattern)?.length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
