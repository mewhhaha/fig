import { compileArtifactsFromSource } from "../src/mod.ts";

interface Scenario {
  name: string;
  source: string;
  expected: number | number[];
  args?: number[];
  callsDivisor?: number;
  notes: string;
  expectedShape?: ShapeExpectation;
  forbiddenWat?: RegExp[];
  maxWatBytes?: number;
  maxWasmBytes?: number;
}

interface WatShape {
  function_calls: number;
  return_calls: number;
  branch_calls: number;
  branch_ensure_editable_calls: number;
  branch_materialize_calls: number;
  temporal_intrinsic_calls: number;
  heap_memory_loads: number;
  heap_memory_stores: number;
  fig_objects_refs: number;
  fig_logs_refs: number;
  fig_buffers_refs: number;
  simd_ops: number;
  loops: number;
  recursive_calls: number;
  fixed_dynamic_gets: number;
  fixed_dynamic_sets: number;
  fixed_spread_updates: number;
  fixed_update_slot_copies: number;
  fixed_transient_sets: number;
  fixed_array_representation_flat: number;
  fixed_array_representation_scratch: number;
  fixed_array_representation_packed: number;
}

interface ShapeExpectation {
  module?: PartialShapeExpectation;
  main?: PartialShapeExpectation;
}

type PartialShapeExpectation = Partial<Record<keyof WatShape, { min?: number; max?: number }>>;

const iterations = Number(Deno.args.find((arg) => arg !== "--") ?? 100_000);
const fannkuchReduxSource = await Deno.readTextFile("examples/perf_fannkuch_redux.fig");

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

const compileOptions = {
  resolveModule,
  memoryModel: "branch" as const,
  optMode: "release" as const,
  pruneImports: true,
};

const simdDot1Source = `
  type fn InlineArray(n: count, a: type) -> type {
    let InlineArray = {n*a};
    struct(InlineArray)
  }

  type fn Lane4I32() -> type {
    InlineArray(4, i32)
  }

  pub fn main(seed: i32) -> i32 {
    let row: Lane4I32 = <1 + seed, 2, 3, 4>;
    let col: Lane4I32 = <1, 5, 9, 13>;
    row[0] * col[0] + row[1] * col[1] + row[2] * col[2] + row[3] * col[3]
  }
`;

const scalarFlatShape: ShapeExpectation = {
  module: {
    branch_calls: { max: 0 },
    branch_ensure_editable_calls: { max: 0 },
    temporal_intrinsic_calls: { max: 0 },
    fig_objects_refs: { max: 0 },
    fig_logs_refs: { max: 0 },
    heap_memory_loads: { max: 0 },
    heap_memory_stores: { max: 0 },
    recursive_calls: { max: 0 },
  },
};

const matmulArgs = [
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  1,
  5,
  9,
  13,
  2,
  6,
  10,
  14,
  3,
  7,
  11,
  15,
  4,
  8,
  12,
  16,
];

const scenarios: Scenario[] = [
  {
    name: "scalar_reuse_nway",
    expected: 40,
    expectedShape: scalarFlatShape,
    notes: "Repeated scalar reads should lower to direct local.get use, with no copy helper.",
    source: `
      pub fn main(seed: i32) -> i32 {
        let x = seed + 10;
        x + x + x + x
      }
    `,
  },
  {
    name: "product_shadow_update",
    expected: 36,
    expectedShape: scalarFlatShape,
    notes: "Product values are reused and shadowed without fork; flattened fields stay scalar.",
    source: `
      type fn Vec2() -> type {
        let Vec2 = {x: i32, y: i32};
        struct(Vec2)
      }
      fn Vec2.translate(point: Vec2, dx: i32, dy: i32) -> Vec2 {
        Vec2 {x: point.x + dx, y: point.y + dy}
      }
      fn Vec2.score(point: Vec2) -> i32 { point.x + point.y }
      pub fn main(seed: i32) -> i32 {
        let point: Vec2 = Vec2 {x: seed + 1, y: 2};
        let moved = Vec2.translate(point, 10, 0);
        let moved = Vec2.translate(moved, 0, 20);
        Vec2.score(point) + Vec2.score(moved)
      }
    `,
  },
  {
    name: "tail_product_loop_1k",
    expected: 500_500,
    callsDivisor: 20,
    expectedShape: {
      ...scalarFlatShape,
      module: { ...scalarFlatShape.module, loops: { min: 1 } },
    },
    notes:
      "Hot tail loop repeatedly returns updated products through shadowed memory-model values.",
    source: `
      type fn Acc() -> type {
        let Acc = {sum: i32, ticks: i32};
        struct(Acc)
      }
      fn run_loop(i: i32, limit: i32, acc: Acc) -> Acc {
        match i < limit {
          true => run_loop(i + 1, limit, Acc {sum: acc.sum + i, ticks: acc.ticks + 1}),
          false => acc,
        }
      }
      pub fn main(seed: i32) -> i32 {
        let start: Acc = Acc {sum: 0, ticks: 0};
        let out = run_loop(seed - seed, 1000, start);
        out.sum + out.ticks
      }
    `,
  },
  {
    name: "inline_array_builder_map",
    expected: 19,
    callsDivisor: 4,
    expectedShape: {
      ...scalarFlatShape,
      module: { ...scalarFlatShape.module, fig_buffers_refs: { max: 0 } },
    },
    notes: "InlineArray tabulate/map use builder cursor loops and product-like aliases.",
    source: `
      const layout = @import("prelude.layout");
      fn make(i: layout.core.Index(16)) -> i32 { i + 1 }
      fn inc(x: i32) -> i32 { x + 1 }
      pub fn main(seed: i32) -> i32 {
        let xs = layout.InlineArray.tabulate(16, i32, make);
        let ys = layout.InlineArray.map(16, i32, i32, xs, inc);
        ys[0] + ys[15] + seed - seed
      }
    `,
  },
  {
    name: "compact_filter_collect",
    expected: 2,
    callsDivisor: 2,
    expectedShape: {
      ...scalarFlatShape,
      module: { ...scalarFlatShape.module, fig_buffers_refs: { max: 0 } },
    },
    notes: "Iterator filter/map/collect builds a CompactArray without heap allocation.",
    source: `
      const array = @import("prelude.array_static");
      fn inc(x: i32) -> i32 { x + 1 }
      fn keep(x: i32) -> bool { x > 2 }
      pub fn main(seed: i32) -> i32 {
        let xs: array.layout.Lane4I32 = <1, 2, 3, 4>;
        let out: array.CompactArray(4, i32) = array.Iter.collect(
          array.Iter.map(array.Iter.filter(array.layout.InlineArray.Iter(xs), keep), inc)
        );
        out.len + seed - seed
      }
    `,
  },
  {
    name: "alias_snapshot_update",
    expected: 82,
    expectedShape: scalarFlatShape,
    notes:
      "Wide product update keeps the old snapshot live; should stay scalar without branch helpers.",
    source: `
      type fn State() -> type {
        let State = {a: i32, b: i32, c: i32, d: i32, e: i32, f: i32, g: i32, h: i32};
        struct(State)
      }
      fn bump(state: State) -> State {
        State {
          a: state.a + 1,
          b: state.b + 2,
          c: state.c + 3,
          d: state.d + 4,
          e: state.e,
          f: state.f,
          g: state.g,
          h: state.h,
        }
      }
      fn sum(state: State) -> i32 {
        state.a + state.b + state.c + state.d + state.e + state.f + state.g + state.h
      }
      pub fn main(seed: i32) -> i32 {
        let old: State = State {a: seed + 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8};
        let newer = bump(old);
        sum(old) + sum(newer)
      }
    `,
  },
  {
    name: "fixed_collection_update",
    expected: 35,
    callsDivisor: 4,
    expectedShape: {
      ...scalarFlatShape,
      module: {
        ...scalarFlatShape.module,
        branch_materialize_calls: { max: 0 },
        fig_buffers_refs: { max: 0 },
      },
    },
    forbiddenWat: [
      /InlineArrayBuilder/,
      /InlineArray\.(?:set|update)_loop/,
      /call \$.*inline_array_update/,
      /branch_(?:ensure_editable|materialize)/,
      /temporal_/,
      /fig_(?:objects|logs|buffers)/,
    ],
    maxWatBytes: 12_000,
    maxWasmBytes: 1_319,
    notes:
      "InlineArray update keeps the source array live while lowering through spread-copy slots.",
    source: `
      const layout = @import("prelude.layout");
      fn make(i: layout.core.Index(16)) -> i32 { i + 1 }
      fn bump(x: i32) -> i32 { x + 3 }
      pub fn main(seed: i32) -> i32 {
        let xs = layout.InlineArray.tabulate(16, i32, make);
        let ys = layout.InlineArray.update(16, i32, xs, seed - seed + 7, bump);
        xs[7] + ys[7] + ys[15]
      }
    `,
  },
  {
    name: "fixed_collection_spread_update",
    expected: 35,
    callsDivisor: 4,
    expectedShape: {
      ...scalarFlatShape,
      module: {
        ...scalarFlatShape.module,
        branch_materialize_calls: { max: 0 },
        fig_buffers_refs: { max: 0 },
      },
    },
    forbiddenWat: [
      /InlineArrayBuilder/,
      /InlineArray\.(?:set|update)_loop/,
      /branch_(?:ensure_editable|materialize)/,
      /temporal_/,
      /fig_(?:objects|logs|buffers)/,
    ],
    maxWatBytes: 16_000,
    notes: "Indexed spread update copies a fixed inline array with direct slot replacement.",
    source: `
      const layout = @import("prelude.layout");
      pub fn main(seed: i32) -> i32 {
        let xs: layout.InlineArray(16, i32) = <1 + seed - seed, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16>;
        let ys: layout.InlineArray(16, i32) = [...xs, [7]: xs[7] + 3];
        xs[7] + ys[7] + ys[15]
      }
    `,
  },
  {
    name: "collision_aabb_64",
    expected: 9,
    callsDivisor: 8,
    expectedShape: {
      ...scalarFlatShape,
      module: { ...scalarFlatShape.module, loops: { min: 1 } },
    },
    notes: "AABB collision sweep over 64 procedural boxes with a flat product box type.",
    source: `
      type fn Box2() -> type {
        let Box2 = {x: i32, y: i32, w: i32, h: i32};
        struct(Box2)
      }
      fn intersects(a: Box2, b: Box2) -> bool {
        match a.x < b.x + b.w {
          true => match b.x < a.x + a.w {
            true => match a.y < b.y + b.h {
              true => b.y < a.y + a.h,
              false => false,
            },
            false => false,
          },
          false => false,
        }
      }
      fn loop_boxes(i: i32, player: Box2, count: i32) -> i32 {
        match i < 64 {
          true => loop_boxes(
            i + 1,
            player,
            match intersects(player, Box2 {x: (i % 8) * 10, y: (i / 8) * 10, w: 8, h: 8}) {
              true => count + 1,
              false => count,
            }
          ),
          false => count,
        }
      }
      pub fn main(seed: i32) -> i32 {
        let player: Box2 = Box2 {x: seed - seed + 15, y: 15, w: 20, h: 20};
        loop_boxes(0, player, 0)
      }
    `,
  },
  {
    name: "path_grid_score_16",
    expected: 3060,
    callsDivisor: 8,
    expectedShape: {
      ...scalarFlatShape,
      module: { ...scalarFlatShape.module, loops: { min: 1 } },
    },
    notes: "Grid pathfinding-style pass over a 16x16 obstacle field using scalar loop state.",
    source: `
      fn score_loop(i: i32, total: i32) -> i32 {
        match i < 256 {
          true => score_loop(
            i + 1,
            match ((i % 16) + (i / 16)) % 5 != 0 {
              true => total + (i % 16) + (i / 16),
              false => total,
            }
          ),
          false => total,
        }
      }
      pub fn main(seed: i32) -> i32 {
        score_loop(seed - seed, 0)
      }
    `,
  },
  {
    name: "range_fold_1k",
    expected: 499_500,
    callsDivisor: 20,
    expectedShape: {
      ...scalarFlatShape,
      module: { ...scalarFlatShape.module, loops: { min: 1 }, recursive_calls: { max: 0 } },
    },
    notes: "Range fold lowers to a Wasm loop over scalar state.",
    source: `
      const range = @import("prelude.range");
      fn add(acc: i32, x: i32) -> i32 { acc + x }
      pub fn main(seed: i32) -> i32 {
        range.RangeIter.fold(range.RangeI32.Iter(seed - seed .. 1000), 0, add)
      }
    `,
  },
  {
    name: "fannkuch_redux_7",
    expected: 22_816,
    callsDivisor: 1000,
    expectedShape: {
      ...scalarFlatShape,
      module: {
        ...scalarFlatShape.module,
        fig_buffers_refs: { max: 0 },
        fixed_array_representation_scratch: { max: 0 },
        fixed_array_representation_packed: { min: 1 },
        loops: { min: 1 },
      },
    },
    maxWatBytes: 52_000,
    maxWasmBytes: 2_480,
    notes: "CLBG fannkuch-redux n=7 adaptation using fixed arrays and dynamic InlineArray updates.",
    source: fannkuchReduxSource,
  },
  {
    name: "mat4_dot1",
    expected: 90,
    expectedShape: {
      ...scalarFlatShape,
      module: { ...scalarFlatShape.module, simd_ops: { min: 1 } },
    },
    notes: "Single fixed matrix dot product; expected to lower to SIMD dot products.",
    source: simdDot1Source,
  },
  {
    name: "mat4_full",
    expected: [
      90,
      100,
      110,
      120,
      202,
      228,
      254,
      280,
      314,
      356,
      398,
      440,
      426,
      484,
      542,
      600,
    ],
    args: matmulArgs,
    expectedShape: {
      ...scalarFlatShape,
      module: { ...scalarFlatShape.module, simd_ops: { min: 1 } },
    },
    notes: "High-throughput fixed matrix kernel; expected to lower to SIMD dot products.",
    source: await Deno.readTextFile("examples/perf_matmul_simd.fig"),
  },
];

const rows = [];
for (const scenario of scenarios) {
  let wat: string;
  let wasm: Uint8Array<ArrayBuffer>;
  let compileParseMs = 0;
  let compileImportMs = 0;
  let compileCheckMs = 0;
  let compileWatMs = 0;
  let compileWasmMs = 0;
  try {
    const artifact = await compileArtifactsFromSource(scenario.source, compileOptions);
    wat = artifact.wat;
    wasm = artifact.wasm;
    compileParseMs = artifact.timings.parseMs;
    compileImportMs = artifact.timings.importMs;
    compileCheckMs = artifact.timings.checkMs;
    compileWatMs = artifact.timings.watMs;
    compileWasmMs = artifact.timings.wasmMs;
  } catch (error) {
    throw new Error(`failed to compile benchmark scenario ${scenario.name}: ${String(error)}`);
  }
  const mainWat = functionWat(wat, "main");
  const main = new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports
    .main as CallableFunction;
  const warmup = callMain(main, scenario.args ?? [0]);
  assertExpected(scenario.name, warmup, scenario.expected);

  const calls = Math.max(1, Math.floor(iterations / (scenario.callsDivisor ?? 1)));
  const timed = timeCalls(main, scenario.args, calls);
  const shape = scopedWatShape(wat);
  if (scenario.expectedShape) checkShape(scenario.name, shape, scenario.expectedShape);
  checkWatGates(scenario.name, wat, wasm, scenario);
  rows.push({
    scenario: scenario.name,
    calls,
    checksum: timed.checksum,
    elapsed_ms: timed.elapsedMs.toFixed(3),
    calls_per_ms: (calls / timed.elapsedMs).toFixed(3),
    ns_per_call: ((timed.elapsedMs * 1_000_000) / calls).toFixed(1),
    compile_parse_ms: compileParseMs.toFixed(3),
    compile_import_ms: compileImportMs.toFixed(3),
    compile_check_ms: compileCheckMs.toFixed(3),
    compile_wat_ms: compileWatMs.toFixed(3),
    compile_wasm_ms: compileWasmMs.toFixed(3),
    compile_total_ms: (
      compileParseMs + compileImportMs + compileCheckMs + compileWatMs + compileWasmMs
    ).toFixed(3),
    wat_bytes: wat.length,
    wasm_bytes: wasm.byteLength,
    main_locals: count(mainWat, /\(local \$/g),
    local_gets: count(mainWat, /\blocal\.get \$/g),
    local_sets: count(mainWat, /\blocal\.set \$/g),
    ...shape.module,
    notes: scenario.notes,
  });
}

function checkWatGates(
  name: string,
  wat: string,
  wasm: Uint8Array<ArrayBuffer>,
  scenario: Pick<Scenario, "forbiddenWat" | "maxWatBytes" | "maxWasmBytes">,
) {
  if (scenario.maxWatBytes !== undefined && wat.length > scenario.maxWatBytes) {
    throw new Error(`${name} WAT size expected <= ${scenario.maxWatBytes}B but got ${wat.length}B`);
  }
  if (scenario.maxWasmBytes !== undefined && wasm.byteLength > scenario.maxWasmBytes) {
    throw new Error(
      `${name} Wasm size expected <= ${scenario.maxWasmBytes}B but got ${wasm.byteLength}B`,
    );
  }
  for (const pattern of scenario.forbiddenWat ?? []) {
    if (pattern.test(wat)) throw new Error(`${name} WAT matched forbidden ${pattern}`);
  }
}

console.table(rows);

function callMain(main: CallableFunction, args: number[] = []): number | number[] {
  return main(...args) as number | number[];
}

function timeCalls(
  main: CallableFunction,
  args: number[] = [],
  calls: number,
): { elapsedMs: number; checksum: number } {
  const start = performance.now();
  let checksum = 0;
  for (let index = 0; index < calls; index++) {
    const result = callMain(main, args.length ? args : [index]);
    checksum += Array.isArray(result) ? result[0] : result;
  }
  return { elapsedMs: performance.now() - start, checksum };
}

function assertExpected(name: string, actual: number | number[], expected: number | number[]) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${name} expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function scopedWatShape(wat: string) {
  return {
    module: watShape(wat),
    main: watShape(functionWat(wat, "main")),
  };
}

function watShape(wat: string): WatShape {
  const fixed = fixedArrayShape(wat);
  return {
    function_calls: count(wat, /\bcall \$/g),
    return_calls: count(wat, /\breturn_call \$/g),
    branch_calls: count(wat, /\$[^)\s]*branch_(?:mark|is_branched)\b/g),
    branch_ensure_editable_calls: count(wat, /\$[^)\s]*branch_ensure_editable\b/g),
    branch_materialize_calls: count(wat, /\$[^)\s]*branch_materialize\b/g),
    temporal_intrinsic_calls: count(wat, /\$[^)\s]*temporal_/g),
    heap_memory_loads: count(wat, /\b(?:i32|i64|f32|f64)\.load\b[^\n]*\bfig_objects\b/g),
    heap_memory_stores: count(wat, /\b(?:i32|i64|f32|f64)\.store\b[^\n]*\bfig_objects\b/g),
    fig_objects_refs: count(wat, /\bfig_objects\b/g),
    fig_logs_refs: count(wat, /\bfig_logs\b/g),
    fig_buffers_refs: count(wat, /\bfig_buffers\b/g),
    simd_ops: count(wat, /\bi(?:8|16|32|64|f32|f64)x[0-9]+\./g),
    loops: count(wat, /\bloop\b/g),
    recursive_calls: recursiveCallCount(wat),
    ...fixed,
  };
}

function fixedArrayShape(wat: string) {
  const helperWat = inlineArrayUpdateHelperWat(wat);
  const fixedDynamicGets = count(wat, /\bselect\b/g);
  const fixedDynamicSets = count(wat, /\bcall \$layout_InlineArray_(?:set|update)__/g);
  const fixedSpreadUpdates = count(wat, /\(func \$layout_InlineArray_(?:set|update)__/g);
  const fixedUpdateSlotCopies = count(helperWat, /\b(?:select|if)\b/g);
  const fixedTransientSets = count(
    wat,
    /\bselect\n\s+local\.set \$[A-Za-z_][A-Za-z0-9_]*\$[0-9]+/g,
  );
  const scratchRefs = count(
    wat,
    /\bfixed_array_scratch\b|\bfig_fixed_scratch\b|\b(?:i32|i64|f32|f64)\.(?:load|store) \(memory \$fig_buffers\)/g,
  );
  const packedRefs = count(wat, /fixed_array_packed|packed_fixed_array/g);
  return {
    fixed_dynamic_gets: fixedDynamicGets,
    fixed_dynamic_sets: fixedDynamicSets,
    fixed_spread_updates: fixedSpreadUpdates,
    fixed_update_slot_copies: fixedUpdateSlotCopies,
    fixed_transient_sets: fixedTransientSets,
    fixed_array_representation_flat: fixedDynamicGets || fixedDynamicSets || fixedSpreadUpdates
      ? 1
      : 0,
    fixed_array_representation_scratch: scratchRefs ? 1 : 0,
    fixed_array_representation_packed: packedRefs ? 1 : 0,
  };
}

function inlineArrayUpdateHelperWat(wat: string): string {
  return [...wat.matchAll(/\(func \$(layout_InlineArray_(?:set|update)__[^\s)]+)[\s\S]*?\n  \)/g)]
    .map((match) => match[0])
    .join("\n");
}

function checkShape(
  scenario: string,
  actual: ReturnType<typeof scopedWatShape>,
  expected: ShapeExpectation,
) {
  checkPartialShape(scenario, "module", actual.module, expected.module);
  checkPartialShape(scenario, "main", actual.main, expected.main);
}

function checkPartialShape(
  scenario: string,
  scope: keyof ShapeExpectation,
  actual: WatShape,
  expected: PartialShapeExpectation | undefined,
) {
  if (!expected) return;
  for (
    const [key, range] of Object.entries(expected) as [
      keyof WatShape,
      { min?: number; max?: number },
    ][]
  ) {
    const value = actual[key];
    if (range.min !== undefined && value < range.min) {
      throw new Error(`${scenario} ${scope}.${key} expected >= ${range.min} but got ${value}`);
    }
    if (range.max !== undefined && value > range.max) {
      throw new Error(`${scenario} ${scope}.${key} expected <= ${range.max} but got ${value}`);
    }
  }
}

function functionWat(wat: string, name: string): string {
  return wat.match(new RegExp(`\\(func \\$${escapeRegExp(name)}[\\s\\S]*?\\n  \\)`))?.[0] ??
    "";
}

function recursiveCallCount(wat: string): number {
  let recursive = 0;
  const fnPattern = /\(func \$([^\s)]+)[\s\S]*?\n  \)/g;
  for (const match of wat.matchAll(fnPattern)) {
    const [, name] = match;
    const body = match[0];
    recursive += count(body, new RegExp(`\\bcall \\$${escapeRegExp(name)}\\b`, "g"));
    recursive += count(body, new RegExp(`\\breturn_call \\$${escapeRegExp(name)}\\b`, "g"));
  }
  return recursive;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
