import { wasmFromSource, watFromSource } from "../src/mod.ts";

interface FigScenario {
  name: ScenarioName;
  source: string;
  expected: number;
  callsDivisor?: number;
  expectedShape?: ShapeExpectation;
  forbiddenWat?: RegExp[];
  maxWatBytes?: number;
  maxWasmBytes?: number;
  maxKernelWasmBytes?: number;
}

type ScenarioName =
  | "scalar_reuse_nway"
  | "product_shadow_update"
  | "tail_product_loop_1k"
  | "inline_array_builder_map"
  | "compact_filter_collect"
  | "alias_snapshot_update"
  | "fixed_collection_update"
  | "fixed_collection_spread_update"
  | "collision_aabb_64"
  | "path_grid_score_16"
  | "range_fold_1k"
  | "monadic_do_id_chain"
  | "applicative_do_id_map"
  | "fannkuch_redux_7"
  | "mat4_dot1"
  | "mat4_full";

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
  benchLoop?: PartialShapeExpectation;
  kernel?: PartialShapeExpectation;
}

type PartialShapeExpectation = Partial<Record<keyof WatShape, { min?: number; max?: number }>>;

interface Row {
  runtime:
    | "fig_wasm_external_call"
    | "fig_wasm_internal_loop"
    | "fig_wasm_kernel"
    | "javascript"
    | "rust"
    | "rust_wasm";
  scenario: ScenarioName;
  calls?: number;
  checksum?: number;
  elapsed_ms?: string;
  calls_per_ms?: string;
  ns_per_call?: string;
  wat_bytes?: number;
  wasm_bytes?: number;
  fixed_dynamic_gets?: number;
  fixed_dynamic_sets?: number;
  fixed_spread_updates?: number;
  fixed_update_slot_copies?: number;
  fixed_transient_sets?: number;
  fixed_array_representation_flat?: number;
  fixed_array_representation_scratch?: number;
  fixed_array_representation_packed?: number;
}

const iterations = Number(Deno.args.find((arg) => arg !== "--") ?? 100_000);
const fannkuchReduxSource = await Deno.readTextFile("examples/perf_fannkuch_redux.fig");
const simdMat4Source = await Deno.readTextFile("examples/perf_matmul_simd.fig");
const simdDot1Source = `
  type fn InlineArray(n: count, a: type) -> type {
    let InlineArray = {n*a};
    struct(InlineArray)
  }

  type fn Lane4I32() -> type {
    InlineArray(4, i32)
  }

  pub fn main(seed: i32) -> i32 {
    let row: Lane4I32 = <1 + seed - seed, 2, 3, 4>;
    let col: Lane4I32 = <1, 5, 9, 13>;
    row[0] * col[0] + row[1] * col[1] + row[2] * col[2] + row[3] * col[3]
  }
`;

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
};

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

const figScenarios: FigScenario[] = [
  {
    name: "scalar_reuse_nway",
    expected: 40,
    expectedShape: scalarFlatShape,
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
      module: {
        ...scalarFlatShape.module,
        loops: { min: 1 },
      },
    },
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
    maxWatBytes: 17_000,
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
    maxWatBytes: 30_000,
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
      /branch_(?:ensure_editable|materialize)/,
      /temporal_/,
      /fig_(?:objects|logs|buffers)/,
    ],
    maxWatBytes: 12_000,
    maxWasmBytes: 1_319,
    maxKernelWasmBytes: 1_319,
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
    maxWatBytes: 16000,
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
      module: {
        ...scalarFlatShape.module,
        loops: { min: 1 },
      },
    },
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
      module: {
        ...scalarFlatShape.module,
        loops: { min: 1 },
      },
    },
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
      module: {
        ...scalarFlatShape.module,
        loops: { min: 1 },
        recursive_calls: { max: 0 },
      },
    },
    source: `
      const array = @import("prelude.array_static");
      fn add(acc: i32, x: i32) -> i32 { acc + x }
      pub fn main(seed: i32) -> i32 {
        array.RangeIter.fold(array.RangeI32.Iter(seed - seed .. 1000), 0, add)
      }
    `,
  },
  {
    name: "monadic_do_id_chain",
    expected: 7,
    expectedShape: scalarFlatShape,
    source: `
      type fn Id(a: type) -> type { a }

      fn Id.pure(value: a) -> Id(a) {
        value
      }

      fn Id.bind(value: Id(a), const f: fn(x: a) -> Id(b)) -> Id(b) {
        f(value)
      }

      fn get(seed: i32) -> Id(i32) {
        seed + 1
      }

      fn add_id(x: i32) -> Id(i32) {
        x + 2
      }

      pub fn main(seed: i32) -> i32 {
        do @monad(Id) {
          x <- get(seed);
          let y = x + 3;
          z <- add_id(y);
          x + z
        }
      }
    `,
  },
  {
    name: "applicative_do_id_map",
    expected: 8,
    expectedShape: scalarFlatShape,
    source: `
      type fn Id(a: type) -> type { a }

      fn Id.pure(value: a) -> Id(a) {
        value
      }

      fn Id.map(const f: fn(x: a) -> b, value: Id(a)) -> Id(b) {
        f(value)
      }

      fn get(seed: i32) -> Id(i32) {
        seed + 1
      }

      pub fn main(seed: i32) -> i32 {
        do @applicative(Id) {
          x <- get(seed);
          let y = x + 3;
          y * 2
        }
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
    maxWatBytes: 56_000,
    maxWasmBytes: 2_600,
    maxKernelWasmBytes: 2_480,
    source: fannkuchReduxSource,
  },
  {
    name: "mat4_dot1",
    expected: 90,
    expectedShape: {
      ...scalarFlatShape,
      module: {
        ...scalarFlatShape.module,
        simd_ops: { min: 1 },
      },
    },
    source: simdDot1Source,
  },
  {
    name: "mat4_full",
    expected: 4944,
    expectedShape: {
      ...scalarFlatShape,
      module: {
        ...scalarFlatShape.module,
        simd_ops: { min: 1 },
      },
    },
    source: `${simdMat4Source.replace("pub fn main(", "fn mat4_main(")}
      pub fn main(seed: i32) -> i32 {
        let result = mat4_main(
          <1 + seed - seed, 2, 3, 4>,
          <5, 6, 7, 8>,
          <9, 10, 11, 12>,
          <13, 14, 15, 16>,
          <1, 5, 9, 13>,
          <2, 6, 10, 14>,
          <3, 7, 11, 15>,
          <4, 8, 12, 16>
        );
        result[0][0] + result[0][1] + result[0][2] + result[0][3] +
          result[1][0] + result[1][1] + result[1][2] + result[1][3] +
          result[2][0] + result[2][1] + result[2][2] + result[2][3] +
          result[3][0] + result[3][1] + result[3][2] + result[3][3]
      }`,
  },
];

const jsScenarios: Record<ScenarioName, (seed: number) => number> = {
  scalar_reuse_nway(seed: number) {
    const x = seed + 10;
    return x + x + x + x;
  },
  product_shadow_update(seed: number) {
    type Vec2 = { x: number; y: number };
    const translate = (point: Vec2, dx: number, dy: number): Vec2 => ({
      x: point.x + dx,
      y: point.y + dy,
    });
    const score = (point: Vec2) => point.x + point.y;
    const point = { x: seed + 1, y: 2 };
    let moved = translate(point, 10, 0);
    moved = translate(moved, 0, 20);
    return score(point) + score(moved);
  },
  tail_product_loop_1k(seed: number) {
    let sum = 0;
    let ticks = 0;
    for (let i = seed - seed; i < 1000; i++) {
      sum += i;
      ticks += 1;
    }
    return sum + ticks;
  },
  inline_array_builder_map(seed: number) {
    const xs = Array.from({ length: 16 }, (_unused, i) => i + 1);
    const ys = xs.map((x) => x + 1);
    return ys[0] + ys[15] + seed - seed;
  },
  compact_filter_collect(seed: number) {
    const out = [1, 2, 3, 4].filter((x) => x > 2).map((x) => x + 1);
    return out.length + seed - seed;
  },
  alias_snapshot_update(seed: number) {
    type State = {
      a: number;
      b: number;
      c: number;
      d: number;
      e: number;
      f: number;
      g: number;
      h: number;
    };
    const sum = (state: State) =>
      state.a + state.b + state.c + state.d + state.e + state.f + state.g + state.h;
    const old = { a: seed + 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
    const newer = {
      a: old.a + 1,
      b: old.b + 2,
      c: old.c + 3,
      d: old.d + 4,
      e: old.e,
      f: old.f,
      g: old.g,
      h: old.h,
    };
    return sum(old) + sum(newer);
  },
  fixed_collection_update(seed: number) {
    const xs = Array.from({ length: 16 }, (_unused, i) => i + 1);
    const ys = xs.slice();
    ys[seed - seed + 7] += 3;
    return xs[7]! + ys[7]! + ys[15]!;
  },
  fixed_collection_spread_update(seed: number) {
    const xs = [1 + seed - seed, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const ys = xs.slice();
    ys[7] = xs[7]! + 3;
    return xs[7]! + ys[7]! + ys[15]!;
  },
  collision_aabb_64(seed: number) {
    const player = { x: seed - seed + 15, y: 15, w: 20, h: 20 };
    let count = 0;
    for (let i = 0; i < 64; i++) {
      const candidate = { x: (i % 8) * 10, y: Math.trunc(i / 8) * 10, w: 8, h: 8 };
      if (
        player.x < candidate.x + candidate.w && candidate.x < player.x + player.w &&
        player.y < candidate.y + candidate.h && candidate.y < player.y + player.h
      ) {
        count += 1;
      }
    }
    return count;
  },
  path_grid_score_16(seed: number) {
    let total = 0;
    for (let i = seed - seed; i < 256; i++) {
      const x = i % 16;
      const y = Math.trunc(i / 16);
      if ((x + y) % 5 !== 0) total += x + y;
    }
    return total;
  },
  range_fold_1k(seed: number) {
    let acc = 0;
    for (let i = seed - seed; i < 1000; i++) acc += i;
    return acc;
  },
  monadic_do_id_chain(seed: number) {
    const x = seed + 1;
    const y = x + 3;
    const z = y + 2;
    return x + z;
  },
  applicative_do_id_map(seed: number) {
    const x = seed + 1;
    const y = x + 3;
    return y * 2;
  },
  fannkuch_redux_7(seed: number) {
    const n = 7;
    const perm = Array.from({ length: n }, (_unused, i) => i + seed - seed);
    const count = Array.from({ length: n }, () => 0);
    let r = n;
    let index = 0;
    let checksum = 0;
    let maxFlips = 0;
    while (true) {
      while (r !== 1) {
        count[r - 1] = r;
        r--;
      }
      const working = perm.slice();
      let flips = 0;
      while (working[0] !== 0) {
        let left = 0;
        let right = working[0]!;
        while (left < right) {
          const tmp = working[left]!;
          working[left] = working[right]!;
          working[right] = tmp;
          left++;
          right--;
        }
        flips++;
      }
      checksum += index % 2 === 0 ? flips : -flips;
      if (flips > maxFlips) maxFlips = flips;
      while (true) {
        if (r === n) return checksum * 100 + maxFlips;
        const first = perm[0]!;
        for (let i = 0; i < r; i++) perm[i] = perm[i + 1]!;
        perm[r] = first;
        count[r] = count[r]! - 1;
        if (count[r]! > 0) break;
        r++;
      }
      index++;
    }
  },
  mat4_dot1(seed: number) {
    const rows = [
      [1 + seed - seed, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
    ];
    const cols = [
      [1, 5, 9, 13],
      [2, 6, 10, 14],
      [3, 7, 11, 15],
      [4, 8, 12, 16],
    ];
    return rows[0]![0]! * cols[0]![0]! + rows[0]![1]! * cols[0]![1]! +
      rows[0]![2]! * cols[0]![2]! + rows[0]![3]! * cols[0]![3]!;
  },
  mat4_full(seed: number) {
    const rows = [
      [1 + seed - seed, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [13, 14, 15, 16],
    ];
    const cols = [
      [1, 5, 9, 13],
      [2, 6, 10, 14],
      [3, 7, 11, 15],
      [4, 8, 12, 16],
    ];
    let total = 0;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        total += rows[row]![0]! * cols[col]![0]! + rows[row]![1]! * cols[col]![1]! +
          rows[row]![2]! * cols[col]![2]! + rows[row]![3]! * cols[col]![3]!;
      }
    }
    return total;
  },
};

const rows: Row[] = [];
for (const scenario of figScenarios) {
  const calls = Math.max(1, Math.floor(iterations / (scenario.callsDivisor ?? 1)));
  rows.push(...await benchFig(scenario, calls));
  rows.push(benchJavaScript(scenario.name, scenario.expected, calls));
}
rows.push(...await benchRust(iterations, figScenarios));
rows.push(...await benchRustWasmSizes(figScenarios));

printBenchmarkTables(rows, figScenarios.map((scenario) => scenario.name));

function printBenchmarkTables(rows: Row[], scenarioOrder: ScenarioName[]) {
  const runtimes: Row["runtime"][] = [
    "fig_wasm_external_call",
    "fig_wasm_internal_loop",
    "fig_wasm_kernel",
    "javascript",
    "rust",
    "rust_wasm",
  ];
  const metrics: (keyof Row)[] = [
    "calls",
    "checksum",
    "elapsed_ms",
    "calls_per_ms",
    "ns_per_call",
    "wat_bytes",
    "wasm_bytes",
    "fixed_dynamic_gets",
    "fixed_dynamic_sets",
    "fixed_spread_updates",
    "fixed_update_slot_copies",
    "fixed_transient_sets",
    "fixed_array_representation_flat",
    "fixed_array_representation_scratch",
    "fixed_array_representation_packed",
  ];
  for (const scenario of scenarioOrder) {
    const byRuntime = new Map(
      rows.filter((row) => row.scenario === scenario).map((row) => [row.runtime, row]),
    );
    console.log(`\n${scenario}`);
    console.table(
      metrics.map((metric) => {
        const output: Record<string, string | number | undefined> = { metric };
        for (const runtime of runtimes) output[runtime] = byRuntime.get(runtime)?.[metric] ?? "";
        return output;
      }),
    );
  }
}

async function benchFig(scenario: FigScenario, calls: number): Promise<Row[]> {
  const kernelWat = await watFromSource(scenario.source, compileOptions);
  const kernelWasm = await wasmFromSource(scenario.source, compileOptions);
  checkKernelGates(scenario.name, kernelWasm, scenario);
  const source = withInternalBench(scenario.source);
  const wat = await watFromSource(source, compileOptions);
  const wasm = await wasmFromSource(source, compileOptions);
  const exports = new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports;
  const main = exports.main as CallableFunction;
  const bench = exports.bench as CallableFunction;
  const shape = scopedWatShape(wat);
  if (scenario.expectedShape) checkShape(scenario.name, shape, scenario.expectedShape);
  checkWatGates(scenario.name, wat, wasm, scenario);
  assertExpected("fig_wasm_external_call", scenario.name, main(0) as number, scenario.expected);
  assertExpected("fig_wasm_internal_loop", scenario.name, bench(1) as number, scenario.expected);
  const external = timeCalls((seed) => main(seed) as number, calls);
  const start = performance.now();
  const checksum = bench(calls) as number;
  const internal = { elapsedMs: performance.now() - start, checksum };
  const kernelShape = watShape(kernelWat);
  return [
    row(
      "fig_wasm_external_call",
      scenario.name,
      calls,
      external,
      wat.length,
      wasm.byteLength,
      shape.module,
    ),
    row(
      "fig_wasm_internal_loop",
      scenario.name,
      calls,
      internal,
      wat.length,
      wasm.byteLength,
      shape.module,
    ),
    row(
      "fig_wasm_kernel",
      scenario.name,
      undefined,
      undefined,
      kernelWat.length,
      kernelWasm.byteLength,
      kernelShape,
    ),
  ];
}

function checkKernelGates(
  name: string,
  wasm: Uint8Array<ArrayBuffer>,
  scenario: Pick<FigScenario, "maxKernelWasmBytes">,
) {
  if (scenario.maxKernelWasmBytes !== undefined && wasm.byteLength > scenario.maxKernelWasmBytes) {
    throw new Error(
      `${name} kernel Wasm size expected <= ${scenario.maxKernelWasmBytes}B but got ${wasm.byteLength}B`,
    );
  }
}

function checkWatGates(
  name: string,
  wat: string,
  wasm: Uint8Array<ArrayBuffer>,
  scenario: Pick<FigScenario, "forbiddenWat" | "maxWatBytes" | "maxWasmBytes">,
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

function benchJavaScript(name: ScenarioName, expected: number, calls: number): Row {
  const fn = jsScenarios[name];
  assertExpected("javascript", name, fn(0), expected);
  const timed = timeCalls(fn, calls);
  return row("javascript", name, calls, timed);
}

async function benchRust(totalIterations: number, scenarios: FigScenario[]): Promise<Row[]> {
  const dir = await Deno.makeTempDir({ prefix: "fig_memory_compare_" });
  const sourcePath = `${dir}/bench.rs`;
  const binaryPath = `${dir}/bench`;
  await Deno.writeTextFile(sourcePath, rustSource());
  const compile = new Deno.Command("rustc", {
    args: ["-C", "opt-level=3", "-C", "target-cpu=native", sourcePath, "-o", binaryPath],
    stdout: "piped",
    stderr: "piped",
  });
  const compileOutput = await compile.output();
  if (!compileOutput.success) {
    throw new Error(new TextDecoder().decode(compileOutput.stderr));
  }
  const run = new Deno.Command(binaryPath, {
    args: [String(totalIterations)],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await run.output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  const parsed = JSON.parse(new TextDecoder().decode(output.stdout)) as Row[];
  const expectedNames = new Set(scenarios.map((scenario) => scenario.name));
  return parsed.filter((item) => expectedNames.has(item.scenario));
}

async function benchRustWasmSizes(scenarios: FigScenario[]): Promise<Row[]> {
  const dir = await Deno.makeTempDir({ prefix: "fig_memory_compare_rust_wasm_" });
  const rows: Row[] = [];
  for (const scenario of scenarios) {
    const sourcePath = `${dir}/${scenario.name}.rs`;
    const wasmPath = `${dir}/${scenario.name}.wasm`;
    await Deno.writeTextFile(sourcePath, rustWasmSource(scenario.name));
    const compile = new Deno.Command("rustc", {
      args: [
        "--crate-type",
        "cdylib",
        "-C",
        "opt-level=3",
        "-C",
        "panic=abort",
        "-C",
        "lto=fat",
        "-C",
        "codegen-units=1",
        "-C",
        "link-arg=--strip-all",
        "--target",
        "wasm32-unknown-unknown",
        sourcePath,
        "-o",
        wasmPath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await compile.output();
    if (!output.success) {
      throw new Error(new TextDecoder().decode(output.stderr));
    }
    const wasm = await Deno.readFile(wasmPath);
    const main = new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports
      .main as CallableFunction;
    assertExpected("rust_wasm", scenario.name, main(0) as number, scenario.expected);
    rows.push({
      runtime: "rust_wasm",
      scenario: scenario.name,
      wasm_bytes: wasm.byteLength,
    });
  }
  return rows;
}

function timeCalls(
  fn: (seed: number) => number,
  calls: number,
): { elapsedMs: number; checksum: number } {
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < calls; i++) checksum += fn(i);
  return { elapsedMs: performance.now() - start, checksum };
}

function row(
  runtime: Row["runtime"],
  scenario: ScenarioName,
  calls?: number,
  timed?: { elapsedMs: number; checksum: number },
  watBytes?: number,
  wasmBytes?: number,
  shape?: WatShape,
): Row {
  return {
    runtime,
    scenario,
    ...(calls !== undefined ? { calls } : {}),
    ...(timed
      ? {
        checksum: timed.checksum,
        elapsed_ms: timed.elapsedMs.toFixed(3),
        calls_per_ms: calls !== undefined ? (calls / timed.elapsedMs).toFixed(3) : undefined,
        ns_per_call: calls !== undefined
          ? ((timed.elapsedMs * 1_000_000) / calls).toFixed(1)
          : undefined,
      }
      : {}),
    ...(watBytes !== undefined ? { wat_bytes: watBytes } : {}),
    ...(wasmBytes !== undefined ? { wasm_bytes: wasmBytes } : {}),
    ...(shape
      ? {
        fixed_dynamic_gets: shape.fixed_dynamic_gets,
        fixed_dynamic_sets: shape.fixed_dynamic_sets,
        fixed_spread_updates: shape.fixed_spread_updates,
        fixed_update_slot_copies: shape.fixed_update_slot_copies,
        fixed_transient_sets: shape.fixed_transient_sets,
        fixed_array_representation_flat: shape.fixed_array_representation_flat,
        fixed_array_representation_scratch: shape.fixed_array_representation_scratch,
        fixed_array_representation_packed: shape.fixed_array_representation_packed,
      }
      : {}),
  };
}

function assertExpected(runtime: string, name: ScenarioName, actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`${runtime} ${name} expected ${expected} but got ${actual}`);
  }
}

function withInternalBench(source: string): string {
  const kernelSource = source.replace(
    /pub\s+fn\s+main\s*\(\s*seed\s*:\s*i32\s*\)\s*->\s*i32/,
    "fn __bench_kernel(seed: i32) -> i32",
  );
  if (kernelSource === source) {
    throw new Error("benchmark source must define pub fn main(seed: i32) -> i32");
  }
  return `${kernelSource}
    pub fn main(seed: i32) -> i32 {
      __bench_kernel(seed)
    }

    pub fn bench(iterations: i32) -> i32 {
      bench_loop(0, iterations, 0)
    }

    fn bench_loop(i: i32, end: i32, checksum: i32) -> i32 {
      match i < end {
        true => bench_loop(i + 1, end, checksum + __bench_kernel(i)),
        false => checksum,
      }
    }
  `;
}

function scopedWatShape(wat: string) {
  return {
    module: watShape(wat),
    main: watShape(functionWat(wat, "main")),
    benchLoop: watShape(functionWat(wat, "bench_loop")),
    kernel: watShape(functionWat(wat, "__bench_kernel")),
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
  scenario: ScenarioName,
  actual: ReturnType<typeof scopedWatShape>,
  expected: ShapeExpectation,
) {
  checkPartialShape(scenario, "module", actual.module, expected.module);
  checkPartialShape(scenario, "main", actual.main, expected.main);
  checkPartialShape(scenario, "benchLoop", actual.benchLoop, expected.benchLoop);
  checkPartialShape(scenario, "kernel", actual.kernel, expected.kernel);
}

function checkPartialShape(
  scenario: ScenarioName,
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

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rustSource(): string {
  return String.raw`
use std::hint::black_box;
use std::time::Instant;

#[derive(Clone, Copy)]
struct Vec2 { x: i32, y: i32 }

fn scalar_reuse_nway(seed: i32) -> i32 {
    let x = black_box(seed + 10);
    x + x + x + x
}

fn translate(point: Vec2, dx: i32, dy: i32) -> Vec2 {
    Vec2 { x: point.x + dx, y: point.y + dy }
}

fn score(point: Vec2) -> i32 {
    point.x + point.y
}

fn product_shadow_update(seed: i32) -> i32 {
    let point = black_box(Vec2 { x: seed + 1, y: 2 });
    let moved = translate(point, black_box(10), black_box(0));
    let moved = translate(moved, black_box(0), black_box(20));
    score(point) + score(moved)
}

fn tail_product_loop_1k(seed: i32) -> i32 {
    let mut sum = 0;
    let mut ticks = 0;
    for i in (seed - seed)..black_box(1000) {
        sum = black_box(sum + i);
        ticks = black_box(ticks + 1);
    }
    sum + ticks
}

fn inline_array_builder_map(seed: i32) -> i32 {
    let xs = std::array::from_fn::<_, 16, _>(|i| black_box(i as i32 + 1));
    let ys = xs.map(|x| black_box(x + 1));
    ys[0] + ys[15] + seed - seed
}

fn compact_filter_collect(seed: i32) -> i32 {
    let input = black_box([1, 2, 3, 4]);
    let out: Vec<i32> = input.iter().copied().filter(|x| *x > 2).map(|x| x + 1).collect();
    out.len() as i32 + seed - seed
}

#[derive(Clone, Copy)]
struct State8 {
    a: i32,
    b: i32,
    c: i32,
    d: i32,
    e: i32,
    f: i32,
    g: i32,
    h: i32,
}

fn state8_sum(state: State8) -> i32 {
    state.a + state.b + state.c + state.d + state.e + state.f + state.g + state.h
}

fn alias_snapshot_update(seed: i32) -> i32 {
    let old = black_box(State8 { a: seed + 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 });
    let newer = State8 {
        a: old.a + 1,
        b: old.b + 2,
        c: old.c + 3,
        d: old.d + 4,
        e: old.e,
        f: old.f,
        g: old.g,
        h: old.h,
    };
    state8_sum(old) + state8_sum(newer)
}

fn fixed_collection_update(seed: i32) -> i32 {
    let xs = std::array::from_fn::<_, 16, _>(|i| black_box(i as i32 + 1));
    let mut ys = xs;
    ys[(seed - seed + 7) as usize] = black_box(ys[(seed - seed + 7) as usize] + 3);
    xs[7] + ys[7] + ys[15]
}

fn fixed_collection_spread_update(seed: i32) -> i32 {
    let xs = black_box([1 + seed - seed, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    let mut ys = xs;
    ys[7] = black_box(xs[7] + 3);
    xs[7] + ys[7] + ys[15]
}

#[derive(Clone, Copy)]
struct Box2 { x: i32, y: i32, w: i32, h: i32 }

fn intersects(a: Box2, b: Box2) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

fn collision_aabb_64(seed: i32) -> i32 {
    let player = black_box(Box2 { x: seed - seed + 15, y: 15, w: 20, h: 20 });
    let mut count = 0;
    for i in 0..64 {
        let candidate = Box2 { x: (i % 8) * 10, y: (i / 8) * 10, w: 8, h: 8 };
        if intersects(player, candidate) {
            count = black_box(count + 1);
        }
    }
    count
}

fn path_grid_score_16(seed: i32) -> i32 {
    let mut total = 0;
    for i in (seed - seed)..256 {
        let x = i % 16;
        let y = i / 16;
        if (x + y) % 5 != 0 {
            total = black_box(total + x + y);
        }
    }
    total
}

fn range_fold_1k(seed: i32) -> i32 {
    ((seed - seed)..black_box(1000)).fold(0, |acc, x| black_box(acc + x))
}

fn monadic_do_id_chain(seed: i32) -> i32 {
    let x = black_box(seed + 1);
    let y = black_box(x + 3);
    let z = black_box(y + 2);
    x + z
}

fn applicative_do_id_map(seed: i32) -> i32 {
    let x = black_box(seed + 1);
    let y = black_box(x + 3);
    y * 2
}

fn fannkuch_redux_7(seed: i32) -> i32 {
    let mut perm = black_box([seed - seed, 1, 2, 3, 4, 5, 6]);
    let mut count = [0; 7];
    let mut r = 7usize;
    let mut index = 0i32;
    let mut checksum = 0i32;
    let mut max_flips = 0i32;
    loop {
        while r != 1 {
            count[r - 1] = r as i32;
            r -= 1;
        }
        let mut working = perm;
        let mut flips = 0i32;
        while working[0] != 0 {
            let mut left = 0usize;
            let mut right = working[0] as usize;
            while left < right {
                working.swap(left, right);
                left += 1;
                right -= 1;
            }
            flips = black_box(flips + 1);
        }
        checksum = black_box(if index % 2 == 0 { checksum + flips } else { checksum - flips });
        if flips > max_flips {
            max_flips = flips;
        }
        loop {
            if r == 7 {
                return checksum * 100 + max_flips;
            }
            let first = perm[0];
            for i in 0..r {
                perm[i] = perm[i + 1];
            }
            perm[r] = first;
            count[r] -= 1;
            if count[r] > 0 {
                break;
            }
            r += 1;
        }
        index += 1;
    }
}

fn mat4_dot1(seed: i32) -> i32 {
    let rows = black_box([
        [1 + seed - seed, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
        [13, 14, 15, 16],
    ]);
    let cols = black_box([
        [1, 5, 9, 13],
        [2, 6, 10, 14],
        [3, 7, 11, 15],
        [4, 8, 12, 16],
    ]);
    black_box(rows[0][0] * cols[0][0] + rows[0][1] * cols[0][1] +
        rows[0][2] * cols[0][2] + rows[0][3] * cols[0][3])
}

fn mat4_full(seed: i32) -> i32 {
    let rows = black_box([
        [1 + seed - seed, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
        [13, 14, 15, 16],
    ]);
    let cols = black_box([
        [1, 5, 9, 13],
        [2, 6, 10, 14],
        [3, 7, 11, 15],
        [4, 8, 12, 16],
    ]);
    let mut total = 0;
    for row in 0..4 {
        for col in 0..4 {
            total = black_box(total + rows[row][0] * cols[col][0] + rows[row][1] * cols[col][1] +
                rows[row][2] * cols[col][2] + rows[row][3] * cols[col][3]);
        }
    }
    total
}

fn bench(name: &str, calls: usize, expected: i32, f: fn(i32) -> i32) -> String {
    let warmup = f(0);
    assert_eq!(warmup, expected, "{name}");
    let start = Instant::now();
    let mut checksum: i64 = 0;
    for i in 0..calls {
        checksum += black_box(f(i as i32)) as i64;
    }
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    format!(
        "{{\"runtime\":\"rust\",\"scenario\":\"{}\",\"calls\":{},\"checksum\":{},\"elapsed_ms\":\"{:.3}\",\"calls_per_ms\":\"{:.3}\",\"ns_per_call\":\"{:.1}\"}}",
        name,
        calls,
        checksum,
        elapsed_ms,
        calls as f64 / elapsed_ms,
        elapsed_ms * 1_000_000.0 / calls as f64
    )
}

fn main() {
    let iterations = std::env::args().nth(1).and_then(|arg| arg.parse::<usize>().ok()).unwrap_or(100_000);
    let rows = [
        bench("scalar_reuse_nway", iterations, 40, scalar_reuse_nway),
        bench("product_shadow_update", iterations, 36, product_shadow_update),
        bench("tail_product_loop_1k", std::cmp::max(1, iterations / 20), 500_500, tail_product_loop_1k),
        bench("inline_array_builder_map", std::cmp::max(1, iterations / 4), 19, inline_array_builder_map),
        bench("compact_filter_collect", std::cmp::max(1, iterations / 2), 2, compact_filter_collect),
        bench("alias_snapshot_update", iterations, 82, alias_snapshot_update),
        bench("fixed_collection_update", std::cmp::max(1, iterations / 4), 35, fixed_collection_update),
        bench("fixed_collection_spread_update", std::cmp::max(1, iterations / 4), 35, fixed_collection_spread_update),
        bench("collision_aabb_64", std::cmp::max(1, iterations / 8), 9, collision_aabb_64),
        bench("path_grid_score_16", std::cmp::max(1, iterations / 8), 3060, path_grid_score_16),
        bench("range_fold_1k", std::cmp::max(1, iterations / 20), 499_500, range_fold_1k),
        bench("monadic_do_id_chain", iterations, 7, monadic_do_id_chain),
        bench("applicative_do_id_map", iterations, 8, applicative_do_id_map),
        bench("fannkuch_redux_7", std::cmp::max(1, iterations / 1000), 22_816, fannkuch_redux_7),
        bench("mat4_dot1", iterations, 90, mat4_dot1),
        bench("mat4_full", iterations, 4944, mat4_full),
    ];
    println!("[{}]", rows.join(","));
}
`;
}
function rustWasmSource(entry: ScenarioName): string {
  return String.raw`
#![no_std]

use core::hint::black_box;
use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

#[derive(Clone, Copy)]
struct Vec2 { x: i32, y: i32 }

fn scalar_reuse_nway(seed: i32) -> i32 {
    let x = black_box(seed + 10);
    x + x + x + x
}

fn translate(point: Vec2, dx: i32, dy: i32) -> Vec2 {
    Vec2 { x: point.x + dx, y: point.y + dy }
}

fn score(point: Vec2) -> i32 {
    point.x + point.y
}

fn product_shadow_update(seed: i32) -> i32 {
    let point = black_box(Vec2 { x: seed + 1, y: 2 });
    let moved = translate(point, black_box(10), black_box(0));
    let moved = translate(moved, black_box(0), black_box(20));
    score(point) + score(moved)
}

fn tail_product_loop_1k(seed: i32) -> i32 {
    let mut sum = 0;
    let mut ticks = 0;
    for i in (seed - seed)..black_box(1000) {
        sum = black_box(sum + i);
        ticks = black_box(ticks + 1);
    }
    sum + ticks
}

fn inline_array_builder_map(seed: i32) -> i32 {
    let xs = core::array::from_fn::<_, 16, _>(|i| black_box(i as i32 + 1));
    let ys = xs.map(|x| black_box(x + 1));
    ys[0] + ys[15] + seed - seed
}

fn compact_filter_collect(seed: i32) -> i32 {
    let input = black_box([1, 2, 3, 4]);
    let mut len = 0;
    for x in input {
        if x > 2 {
            let _ = black_box(x + 1);
            len += 1;
        }
    }
    len + seed - seed
}

#[derive(Clone, Copy)]
struct State8 {
    a: i32,
    b: i32,
    c: i32,
    d: i32,
    e: i32,
    f: i32,
    g: i32,
    h: i32,
}

fn state8_sum(state: State8) -> i32 {
    state.a + state.b + state.c + state.d + state.e + state.f + state.g + state.h
}

fn alias_snapshot_update(seed: i32) -> i32 {
    let old = black_box(State8 { a: seed + 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 });
    let newer = State8 {
        a: old.a + 1,
        b: old.b + 2,
        c: old.c + 3,
        d: old.d + 4,
        e: old.e,
        f: old.f,
        g: old.g,
        h: old.h,
    };
    state8_sum(old) + state8_sum(newer)
}

fn fixed_collection_update(seed: i32) -> i32 {
    let xs = core::array::from_fn::<_, 16, _>(|i| black_box(i as i32 + 1));
    let mut ys = xs;
    let index = (seed - seed + 7) as usize;
    ys[index] = black_box(ys[index] + 3);
    xs[7] + ys[7] + ys[15]
}

fn fixed_collection_spread_update(seed: i32) -> i32 {
    let xs = black_box([1 + seed - seed, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    let mut ys = xs;
    ys[7] = black_box(xs[7] + 3);
    xs[7] + ys[7] + ys[15]
}

#[derive(Clone, Copy)]
struct Box2 { x: i32, y: i32, w: i32, h: i32 }

fn intersects(a: Box2, b: Box2) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

fn collision_aabb_64(seed: i32) -> i32 {
    let player = black_box(Box2 { x: seed - seed + 15, y: 15, w: 20, h: 20 });
    let mut count = 0;
    for i in 0..64 {
        let candidate = Box2 { x: (i % 8) * 10, y: (i / 8) * 10, w: 8, h: 8 };
        if intersects(player, candidate) {
            count = black_box(count + 1);
        }
    }
    count
}

fn path_grid_score_16(seed: i32) -> i32 {
    let mut total = 0;
    for i in (seed - seed)..256 {
        let x = i % 16;
        let y = i / 16;
        if (x + y) % 5 != 0 {
            total = black_box(total + x + y);
        }
    }
    total
}

fn range_fold_1k(seed: i32) -> i32 {
    ((seed - seed)..black_box(1000)).fold(0, |acc, x| black_box(acc + x))
}

fn monadic_do_id_chain(seed: i32) -> i32 {
    let x = black_box(seed + 1);
    let y = black_box(x + 3);
    let z = black_box(y + 2);
    x + z
}

fn applicative_do_id_map(seed: i32) -> i32 {
    let x = black_box(seed + 1);
    let y = black_box(x + 3);
    y * 2
}

fn fannkuch_redux_7(seed: i32) -> i32 {
    let mut perm = black_box([seed - seed, 1, 2, 3, 4, 5, 6]);
    let mut count = [0; 7];
    let mut r = 7usize;
    let mut index = 0i32;
    let mut checksum = 0i32;
    let mut max_flips = 0i32;
    loop {
        while r != 1 {
            count[r - 1] = r as i32;
            r -= 1;
        }
        let mut working = perm;
        let mut flips = 0i32;
        while working[0] != 0 {
            let mut left = 0usize;
            let mut right = working[0] as usize;
            while left < right {
                working.swap(left, right);
                left += 1;
                right -= 1;
            }
            flips = black_box(flips + 1);
        }
        checksum = black_box(if index % 2 == 0 { checksum + flips } else { checksum - flips });
        if flips > max_flips {
            max_flips = flips;
        }
        loop {
            if r == 7 {
                return checksum * 100 + max_flips;
            }
            let first = perm[0];
            for i in 0..r {
                perm[i] = perm[i + 1];
            }
            perm[r] = first;
            count[r] -= 1;
            if count[r] > 0 {
                break;
            }
            r += 1;
        }
        index += 1;
    }
}

fn mat4_dot1(seed: i32) -> i32 {
    let rows = black_box([
        [1 + seed - seed, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
        [13, 14, 15, 16],
    ]);
    let cols = black_box([
        [1, 5, 9, 13],
        [2, 6, 10, 14],
        [3, 7, 11, 15],
        [4, 8, 12, 16],
    ]);
    black_box(rows[0][0] * cols[0][0] + rows[0][1] * cols[0][1] +
        rows[0][2] * cols[0][2] + rows[0][3] * cols[0][3])
}

fn mat4_full(seed: i32) -> i32 {
    let rows = black_box([
        [1 + seed - seed, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
        [13, 14, 15, 16],
    ]);
    let cols = black_box([
        [1, 5, 9, 13],
        [2, 6, 10, 14],
        [3, 7, 11, 15],
        [4, 8, 12, 16],
    ]);
    let mut total = 0;
    for row in 0..4 {
        for col in 0..4 {
            total = black_box(total + rows[row][0] * cols[col][0] + rows[row][1] * cols[col][1] +
                rows[row][2] * cols[col][2] + rows[row][3] * cols[col][3]);
        }
    }
    total
}

#[unsafe(no_mangle)]
pub extern "C" fn main(seed: i32) -> i32 {
    ${entry}(seed)
}
`;
}
