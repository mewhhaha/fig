import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  type CompileSourceOptions,
  createFigHost,
  instantiateFig,
  wasmFromSource as wasmFromSourceRaw,
  watFromSource as watFromSourceRaw,
} from "../src/mod.ts";

const watFromSource = (source: string, options: CompileSourceOptions = {}) =>
  watFromSourceRaw(source, options);
const wasmFromSource = (source: string, options: CompileSourceOptions = {}) =>
  wasmFromSourceRaw(source, options);

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

function hasCustomSection(bytes: Uint8Array, name: string): boolean {
  let offset = 8;
  while (offset < bytes.length) {
    const id = bytes[offset++];
    const size = readUleb(bytes, offset);
    offset = size.offset;
    const payloadEnd = offset + size.value;
    if (id === 0) {
      const sectionName = readName(bytes, offset);
      if (sectionName.value === name) return true;
    }
    offset = payloadEnd;
  }
  return false;
}

function customSection(bytes: Uint8Array<ArrayBuffer>, name: string): Uint8Array | undefined {
  const module = new WebAssembly.Module(bytes);
  const section = WebAssembly.Module.customSections(module, name)[0];
  return section ? new Uint8Array(section) : undefined;
}

function numericFields(value: unknown): unknown[] {
  assert(typeof value === "object" && value !== null);
  return Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, item]) => item);
}

function decodeBranchHints(
  bytes: Uint8Array<ArrayBuffer>,
): { functionIndex: number; hints: { offset: number; hint: number }[] }[] {
  const section = customSection(bytes, "metadata.code.branch_hint");
  if (!section) return [];
  let offset = 0;
  const functions = readUleb(section, offset);
  offset = functions.offset;
  const result = [];
  for (let fn = 0; fn < functions.value; fn++) {
    const functionIndex = readUleb(section, offset);
    offset = functionIndex.offset;
    const hints = readUleb(section, offset);
    offset = hints.offset;
    const entries = [];
    for (let index = 0; index < hints.value; index++) {
      const hintOffset = readUleb(section, offset);
      const reserved = readUleb(section, hintOffset.offset);
      const hint = readUleb(section, reserved.offset);
      assertEquals(reserved.value, 1);
      offset = hint.offset;
      entries.push({ offset: hintOffset.value, hint: hint.value });
    }
    result.push({ functionIndex: functionIndex.value, hints: entries });
  }
  return result;
}

function readName(bytes: Uint8Array, offset: number): { value: string; offset: number } {
  const size = readUleb(bytes, offset);
  const start = size.offset;
  const end = start + size.value;
  return { value: new TextDecoder().decode(bytes.slice(start, end)), offset: end };
}

function readUleb(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, offset };
}

Deno.test("WAT and wasm share lowered import signatures", async () => {
  const source = `
    const clock = @external("clock", fn(host: io) -> io(i32));
    const random = @external("random", fn(host: io, seed: i32) -> io(i32));
    pub fn main(host: io) -> i32 { clock(host) + random(host, 1) }
  `;

  const wat = await watFromSource(source);
  assertStringIncludes(wat, `(func $clock (import "env" "clock") (param i32) (result i32))`);
  assertStringIncludes(
    wat,
    `(func $random (import "env" "random") (param i32) (param i32) (result i32))`,
  );

  const module = new WebAssembly.Module(await wasmFromSource(source));
  assertEquals(
    WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}:${item.kind}`),
    ["env.clock:function", "env.random:function"],
  );
});

Deno.test("do @io lowers IO actions to transparent runtime values", async () => {
  const source = `
    const tick = @external("tick_ms", fn(host: io) -> io(i32));
    pub fn main(host: io) -> io(i32) {
      do @io(_) {
        now <- tick(host);
        return(now + 1)
      }
    }
  `;

  const wat = await watFromSource(source);
  assertStringIncludes(wat, `(func $tick (import "env" "tick_ms") (param i32) (result i32))`);
  assertStringIncludes(wat, `(func $main (export "main") (param $host i32) (result i32)`);
  assertStringIncludes(wat, "call $tick");
  assert(!wat.includes("call $return"));
});

Deno.test("release backend preserves host calls through private wrappers", async () => {
  const source = `
    const draw = @external("draw", fn(host: io, x: i32) -> io(i32));
    fn wrapper(host: io, x: i32) -> i32 { draw(host, x) }
    fn choose(host: io, x: i32) -> i32 {
      match x > 0 {
        true => wrapper(host, x),
        false => 0
      }
    }
    pub fn main(host: io, x: i32) -> i32 { choose(host, x) }
  `;

  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "call $draw");
  new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" }));
});

Deno.test("debug is the default opt mode and emits wasm name section", async () => {
  const source = `
    fn add1(x: i32) -> i32 { x + 1 }
    pub fn main() -> i32 { add1(41) }
  `;
  const debugWat = await watFromSource(source);
  assertStringIncludes(debugWat, "(func $add1");
  assertStringIncludes(debugWat, "call $add1");

  const debugWasm = await wasmFromSource(source);
  assert(hasCustomSection(debugWasm, "name"));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(debugWasm));
  assertEquals((instance.exports.main as CallableFunction)(), 42);

  const releaseWat = await watFromSource(source, { optMode: "release" });
  assert(!releaseWat.includes("(func $add1"));
  assert(!releaseWat.includes("call $add1"));
  assert(!hasCustomSection(await wasmFromSource(source, { optMode: "release" }), "name"));
});

Deno.test("private calls inside field projections stay reachable", async () => {
  const source = `
    type fn Pair() -> type { let Pair = {x: i32, y: i32}; struct(Pair) }
    type fn Patch() -> type { let Patch = {value: Pair}; struct(Patch) }
    fn make_patch(pair: Pair) -> Patch { Patch {value: pair} }
    fn apply(pair: Pair) -> Pair { make_patch(pair).value }
    pub fn main(pair: Pair) -> Pair { apply(pair) }
  `;

  const wat = await watFromSource(source);
  assertStringIncludes(wat, "call $make_patch");
  new WebAssembly.Module(await wasmFromSource(source));
});

Deno.test("static shape-count matches lower only the reachable arm", async () => {
  const source = `
    type fn Pair() -> type { let Pair = {x: i32, y: i32}; struct(Pair) }
    fn scalar() -> i32 { 1 }
    fn choose(pair: Pair) -> Pair {
      match @shape_count({}) {
        0 => pair,
        _ => scalar(),
      }
    }
    pub fn main(pair: Pair) -> Pair { choose(pair) }
  `;

  const wat = await watFromSource(source);
  assert(!wat.includes("call $scalar"));
  new WebAssembly.Module(await wasmFromSource(source));
});

Deno.test("const-key field projection lowers on anonymous struct rows", async () => {
  const source = `
    type fn Point() -> type { let Point = {x: i32, y: i32}; struct(Point) }
    fn select(const field: const, row: row_t) -> Point {
      @field(row, field)
    }
    pub fn main() -> i32 {
      select(#point, {point: Point {x: 3, y: 4}, other: 9}).y
    }
  `;

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 4);
});

Deno.test("branch hints emit release custom section and WAT annotations", async () => {
  const source = `
    pub fn main(x: i32) -> i32 {
      match x {
        @likely 0 => 1,
        _ => 2,
      }
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, `if (@metadata.code.branch_hint "\\01")`);

  const release = await wasmFromSource(source, { optMode: "release" });
  const hints = decodeBranchHints(release);
  assertEquals(hints.length, 1);
  assertEquals(hints[0]?.functionIndex, 0);
  assertEquals(hints[0]?.hints.map((hint) => hint.hint), [1]);
  assertEquals(
    hints[0]?.hints.map((hint) => hint.offset),
    hints[0]?.hints.map((hint) => hint.offset).toSorted((left, right) => left - right),
  );

  assert(!hasCustomSection(await wasmFromSource(source), "metadata.code.branch_hint"));
  assert(
    hasCustomSection(
      await wasmFromSource(source, { branchHints: true }),
      "metadata.code.branch_hint",
    ),
  );
  assert(
    !hasCustomSection(
      await wasmFromSource(source, { optMode: "release", branchHints: false }),
      "metadata.code.branch_hint",
    ),
  );
});

Deno.test("function clause branch hints lower to dispatcher branch metadata", async () => {
  const clauses = `
    @likely fn score(true: bool) -> i32 { 1 }
    fn score(false: bool) -> i32 { 0 }
    pub fn main(x: bool) -> i32 { score(x) }
  `;
  const handwritten = `
    fn score(x: bool) -> i32 {
      match x {
        @likely true => 1,
        _ => 0,
      }
    }
    pub fn main(x: bool) -> i32 { score(x) }
  `;
  const clauseHints = decodeBranchHints(await wasmFromSource(clauses, { optMode: "release" }));
  const matchHints = decodeBranchHints(await wasmFromSource(handwritten, { optMode: "release" }));
  assertEquals(clauseHints.flatMap((fn) => fn.hints.map((hint) => hint.hint)), [1]);
  assertEquals(matchHints.flatMap((fn) => fn.hints.map((hint) => hint.hint)), [1]);
});

Deno.test("large refined recursive function clauses lower to a loop", async () => {
  const source = `
    fn sum_go(i: i32(1000), acc: i32) -> i32 {
      acc
    }
    fn sum_go(i: i32(0..1000), acc: i32) -> i32 {
      sum_go(i + 1, acc + i)
    }
    pub fn main() -> i32 {
      sum_go(0, 0)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "loop");
  assert(!wat.includes("call $sum_go"));
  assert(!wat.includes("call $sum_go__clause_"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 499500);
});

Deno.test("backend folds scalar literal arithmetic", async () => {
  const wat = await watFromSource(`pub fn main() -> i32 { 40 + 2 }`, { optMode: "release" });
  assertStringIncludes(wat, "i32.const 42");
  assert(!wat.includes("i32.add"));
});

Deno.test("release folds static projections from let-bound values", async () => {
  const source = `
    type fn Lane4I32() -> type {
      let Lane4I32 = {4*i32};
      struct(Lane4I32)
    }
    pub fn main(seed: i32) -> i32 {
      let row: Lane4I32 = #[1 + seed - seed, 2, 3, 4];
      let col: Lane4I32 = #[1, 5, 9, 13];
      row[0] * col[0] + row[1] * col[1] + row[2] * col[2] + row[3] * col[3]
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.const 90");
  assert(!wat.includes("i32x4"));
  assert(!wat.includes("i32.mul"));
});

Deno.test("release folds const locals and inlines trivial private scalar helpers", async () => {
  const source = `
    fn kernel() -> i32 {
      let x = 8;
      let y = x + 3;
      x + y + 16
    }
    fn loop_sum(i: i32, end: i32, checksum: i32) -> i32 {
      match i < end {
        true => loop_sum(i + 1, end, checksum + kernel()),
        false => checksum,
      }
    }
    pub fn main(iterations: i32) -> i32 {
      loop_sum(0, iterations, 0)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const loop = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(loop, "i32.const 35");
  assert(!loop.includes("call $kernel"));
});

Deno.test("backend lowers power-of-two multiplication through shifts", async () => {
  const source = `
    pub fn main(x: i32) -> i32 {
      (x + 3) * 8
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.const 3");
  assertStringIncludes(wat, "i32.shl");
  assert(!wat.includes("i32.mul"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  const main = instance.exports.main as CallableFunction;
  assertEquals(main(2), 40);
  assertEquals(main(-5), -16);
});

Deno.test("optimizer combines repeated pure scalar adds into multiplication", async () => {
  const source = `
    pub fn main(seed: i32) -> i32 {
      let x = seed + 10;
      x + x + x + x
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.shl");
  assertEquals((wat.match(/i32\.add/g) ?? []).length, 1);
});

Deno.test("backend lowers signed power-of-two div rem through shifts", async () => {
  const source = `
    pub fn main(x: i32) -> i32 {
      (x / 8) * 100 + (x % 8)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.shr_s");
  assertStringIncludes(wat, "i32.and");
  assert(!wat.includes("i32.div_s"));
  assert(!wat.includes("i32.rem_s"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  const main = instance.exports.main as CallableFunction;
  assertEquals(main(17), 201);
  assertEquals(main(-17), -201);
});

Deno.test("backend reuses repeated scalar div rem subexpressions across match arms", async () => {
  const source = `
    fn score_loop(i: i32, total: i32) -> i32 {
      match i < 256 {
        true => score_loop(
          i + 1,
          match ((i % (0 - 10)) + (i / (0 - 10))) % 5 != 0 {
            true => total + (i % (0 - 10)) + (i / (0 - 10)),
            false => total,
          }
        ),
        false => total,
      }
    }
    pub fn main(seed: i32) -> i32 {
      score_loop(seed - seed, 0)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "__match_shared");
  assertEquals((wat.match(/i32\.div_s/g) ?? []).length, 1);
  assertEquals((wat.match(/i32\.rem_s/g) ?? []).length, 2);

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), -1590);
});

Deno.test("backend uses unsigned power-of-two reductions for nonnegative tail indexes", async () => {
  const source = `
    fn score_loop(i: i32, total: i32) -> i32 {
      match i < 16 {
        true => score_loop(i + 1, total + (i % 4) + (i / 4)),
        false => total,
      }
    }
    pub fn main() -> i32 {
      score_loop(0, 0)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.shr_u");
  assertStringIncludes(wat, "i32.and");
  assert(!wat.includes("i32.shr_s"));
  assert(!wat.includes("i32.div_s"));
  assert(!wat.includes("i32.rem_s"));
});

Deno.test("backend lowers nonnegative constant remainder through reciprocal multiply", async () => {
  const source = `
    fn score_loop(i: i32, total: i32) -> i32 {
      match i < 1024 {
        true => score_loop(i + 1, total + (i % 3) + (i % 5)),
        false => total,
      }
    }
    pub fn main() -> i32 {
      score_loop(0, 0)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i64.mul");
  assertStringIncludes(wat, "i64.shr_u");
  assert(!wat.includes("i32.rem_s"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 3069);
});

Deno.test("backend lowers small-range divisibility checks through bit masks", async () => {
  const source = `
    fn score_loop(i: i32, total: i32) -> i32 {
      match i < 32 {
        true => score_loop(i + 1, match i % 5 != 0 { true => total + i, false => total }),
        false => total,
      }
    }
    pub fn main() -> i32 {
      score_loop(0, 0)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.shr_u");
  assertStringIncludes(wat, "i32.and");
  assert(!wat.includes("i64.mul"));
  assert(!wat.includes("i32.mul"));
  assert(!wat.includes("i32.rem_s"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 391);
});

Deno.test("backend uses refined i32 parameter domains for div/rem lowering", async () => {
  const source = `
    pub fn main(i: i32(0..64)) -> i32 {
      (i / 16) + (i % 16)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.shr_u");
  assertStringIncludes(wat, "i32.and");
  assert(!wat.includes("i32.div_s"));
  assert(!wat.includes("i32.rem_s"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(31), 16);
});

Deno.test("backend uses false-branch scalar facts from refined comparisons", async () => {
  const source = `
    pub fn main(i: i32) -> i32 {
      if i < 0 { 0 } else { i / 4 }
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.shr_u");
  assert(!wat.includes("i32.shr_s"));
  assert(!wat.includes("i32.div_s"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  const main = instance.exports.main as CallableFunction;
  assertEquals(main(-4), 0);
  assertEquals(main(7), 1);
});

Deno.test("backend folds comparisons proven by refined i32 domains", async () => {
  const source = `
    pub fn main(i: i32(0..4), j: i32(4..8)) -> i32 {
      let a = if i < 4 { 10 } else { 1 };
      let b = if j < 4 { 1 } else { 20 };
      a + b
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assert(!wat.includes("i32.lt_s"));
  assertStringIncludes(wat, "i32.const 30");

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(3, 4), 30);
});

Deno.test("backend lowers Index::try refined-domain matches as checked bounds", async () => {
  const source = `
    const core = @import("prelude.core");
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    pub fn main(raw: i32, xs: InlineArray(4, i32)) -> i32 {
      match core.Index::try(4, raw) {
        Some(i) => xs[i],
        None => 0,
      }
    }
    pub fn generic(raw: i32) -> i32 {
      match core.i32::try_domain(i32(0..4), raw) {
        Some(i) => i + 1,
        None => 0,
      }
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  assertStringIncludes(wat, "local.tee $__domain_tmp0");
  assertStringIncludes(wat, "i32.ge_s");
  assertStringIncludes(wat, "i32.le_s");

  const fig = await instantiateFig(await wasmFromSource(source, { resolveModule }));
  const host = createFigHost(fig.abi, fig.instance);
  assertEquals(host.call("main", 2, [10, 20, 30, 40]), 30);
  assertEquals(host.call("main", -1, [10, 20, 30, 40]), 0);
  assertEquals(host.call("main", 4, [10, 20, 30, 40]), 0);
  const generic = fig.instance.exports.generic as CallableFunction;
  assertEquals(generic(2), 3);
  assertEquals(generic(4), 0);
});

Deno.test("backend compacts adjacent refined-domain singleton checks", async () => {
  const source = `const core = @import("prelude.core");
type fn Small() -> type { i32(1 | 2 | 3) }
pub fn main(raw: i32) -> i32 {
  match core.i32.try_domain(Small, raw) {
    Some(i) => i + 10,
    None => 0,
  }
}
`;
  const wat = await watFromSource(source, { resolveModule });
  assertStringIncludes(wat, "i32.const 1");
  assertStringIncludes(wat, "i32.ge_s");
  assertStringIncludes(wat, "i32.const 3");
  assertStringIncludes(wat, "i32.le_s");
  assert(!wat.includes("i32.or"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  const main = instance.exports.main as CallableFunction;
  assertEquals(main(1), 11);
  assertEquals(main(3), 13);
  assertEquals(main(4), 0);
});

Deno.test("backend lowers nonnegative odd divisibility checks through modular inverses", async () => {
  const source = `
    fn score_loop(i: i32, total: i32) -> i32 {
      match i < 64 {
        true => score_loop(i + 1, match i % 5 != 0 { true => total + i, false => total }),
        false => total,
      }
    }
    pub fn main() -> i32 {
      score_loop(0, 0)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.mul");
  assertStringIncludes(wat, "i32.le_u");
  assert(!wat.includes("i64.mul"));
  assert(!wat.includes("i32.rem_s"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 1626);
});

Deno.test("backend lowers parity remainder comparisons through bit tests", async () => {
  const source = `
    pub fn main(x: i32) -> i32 {
      if x % 2 == 0 { 1 } else { 0 }
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.and");
  assertStringIncludes(wat, "i32.eqz");
  assert(!wat.includes("i32.rem_s"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  const main = instance.exports.main as CallableFunction;
  assertEquals(main(4), 1);
  assertEquals(main(5), 0);
  assertEquals(main(-3), 0);
  assertEquals(main(-4), 1);
});

Deno.test("backend lowers zero comparisons through eqz", async () => {
  const source = `
    pub fn main(x: i32) -> i32 {
      let zero = if x == 0 { 10 } else { 0 };
      let nonzero = if x != 0 { 1 } else { 0 };
      zero + nonzero
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "i32.eqz");
  assert(!/i32\.eqz\s+i32\.eqz\s+if/.test(wat));
  assert(!wat.includes("i32.const 0\n    i32.eq"));
  assert(!wat.includes("i32.const 0\n    i32.ne"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  const main = instance.exports.main as CallableFunction;
  assertEquals(main(0), 10);
  assertEquals(main(5), 1);
});

Deno.test("backend lowers runtime inline-array indexing with scalar select", async () => {
  const wat = await watFromSource(`
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn get(xs: InlineArray(3, i32), index: i32) -> i32 {
      xs[index]
    }
    pub fn main() -> i32 {
      get([4, 5, 6], 1)
    }
  `);
  assertStringIncludes(wat, "select");
  assertStringIncludes(wat, "i32.eq");
  assertStringIncludes(wat, "i32.const 1");
});

Deno.test("backend does not allocate unused pure locals", async () => {
  const wat = await watFromSource(
    `
    pub fn main() -> i32 {
      let unused: i32 = 1 + 2;
      9
    }
  `,
    { optMode: "release" },
  );
  assert(!wat.includes("(local $unused"));
  assert(!wat.includes("i32.const 3"));
});

Deno.test("backend folds immediate set get roundtrips", async () => {
  const wat = await watFromSource(
    `
    pub fn main() -> i32 {
      let x = 41;
      x + 1
    }
  `,
    { optMode: "release" },
  );
  const main = wat.match(/\(func \$main__optimized[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "i32.const 42");
  assert(!main.includes("local.tee $x"));
  assert(!main.includes("local.set $x\n    local.get $x"));
});

Deno.test("backend removes unreachable instructions after branch terminators", async () => {
  const wat = await watFromSource(
    `
    fn loop_forever() -> i32 { loop_forever() }
    pub fn main() -> i32 { loop_forever() }
  `,
    { optMode: "release" },
  );
  const loop = wat.match(/\(func \$loop_forever[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(loop, "br 0");
  assert(!loop.includes("br 0\n        unreachable"));
});

Deno.test("optimizer simplifies numeric identities without dropping effects", async () => {
  const pure = await watFromSource(
    `
    pub fn main(x: i32) -> i32 { (x * 1) + 0 }
  `,
    { optMode: "release" },
  );
  const pureMain = pure.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!pureMain.includes("i32.mul"));
  assert(!pureMain.includes("i32.add"));

  const samePure = await watFromSource(
    `
    pub fn main(seed: i32) -> i32 { seed - seed }
  `,
    { optMode: "release" },
  );
  const samePureMain = samePure.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(samePureMain, "i32.const 0");
  assert(!samePureMain.includes("i32.sub"));

  const cancelAdd = await watFromSource(
    `
    pub fn main(seed: i32) -> i32 { (1 + seed) - seed }
  `,
    { optMode: "release" },
  );
  const cancelAddMain = cancelAdd.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(cancelAddMain, "i32.const 1");
  assert(!cancelAddMain.includes("local.get $seed"));

  const cancelSubtract = await watFromSource(
    `
    pub fn main(seed: i32) -> i32 { (seed - 7) + 7 }
  `,
    { optMode: "release" },
  );
  const cancelSubtractMain = cancelSubtract.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(cancelSubtractMain, "local.get $seed");
  assert(!cancelSubtractMain.includes("i32.sub"));
  assert(!cancelSubtractMain.includes("i32.add"));

  const cancelNegated = await watFromSource(
    `
    pub fn main(seed: i32) -> i32 { (1 - seed) + seed }
  `,
    { optMode: "release" },
  );
  const cancelNegatedMain = cancelNegated.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(cancelNegatedMain, "i32.const 1");
  assert(!cancelNegatedMain.includes("local.get $seed"));

  const effectful = await watFromSource(
    `
    const clock = @external("clock", fn(host: io) -> io(i32));
    pub fn main(host: io) -> i32 { clock(host) * 0 }
  `,
    { optMode: "release" },
  );
  assertStringIncludes(effectful, "call $clock");
  assertStringIncludes(effectful, "i32.mul");
});

Deno.test("benchmark-style internal loop calls private kernel directly", async () => {
  const source = `
    fn __bench_kernel(seed: i32) -> i32 {
      let x = seed + 10;
      x + x + x + x
    }
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
  const wat = await watFromSource(source, { memoryModel: "branch", optMode: "release" });
  const benchLoop = wat.match(/\(func \$bench_loop[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$bench[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(benchLoop, "loop");
  assert(!benchLoop.includes("call $main"));
  assert(!benchLoop.includes("call $bench_loop"));
  assert(!wat.includes("fig_objects"));
});

Deno.test("backend preserves and drops unused host IO calls", async () => {
  const wat = await watFromSource(`
    const clock = @external("clock", fn(host: io) -> io(i32));
    pub fn main(host: io) -> i32 {
      let unused: i32 = clock(host);
      7
    }
  `);
  assertStringIncludes(wat, "call $clock");
  assertStringIncludes(wat, "drop");
});

Deno.test("wildcard match skips pure scrutinee but preserves effectful scrutinee", async () => {
  const pure = await watFromSource(`
    fn ignored() -> i32 { 1 + 2 }
    pub fn main() -> i32 {
      match ignored() { _ => 7 }
    }
  `);
  assert(!pure.includes("call $ignored"));
  assert(!pure.includes("i32.const 3"));

  const effectful = await watFromSource(`
    const clock = @external("clock", fn(host: io) -> io(i32));
    pub fn main(host: io) -> i32 {
      match clock(host) { _ => 7 }
    }
  `);
  assertStringIncludes(effectful, "call $clock");
  assertStringIncludes(effectful, "drop");
});

Deno.test("backend removes private functions unreachable from exports", async () => {
  const wat = await watFromSource(
    `
    fn unused() -> i32 { 1 }
    fn used() -> i32 { 2 }
    pub fn main() -> i32 { used() }
  `,
    { optMode: "release" },
  );
  assert(!wat.includes("(func $unused"));
  assert(!wat.includes("(func $used"));
  assert(!wat.includes("call $used"));
});

Deno.test("public exports inline private scalar product helpers", async () => {
  const source = `
    type fn Vec2() -> type {
      let Vec2 = {x: i32, y: i32};
      struct(Vec2)
    }
    fn translate(point: Vec2, dx: i32, dy: i32) -> Vec2 {
      Vec2 {x: point.x + dx, y: point.y + dy}
    }
    pub fn main(seed: i32) -> i32 {
      let point: Vec2 = Vec2 {x: seed + 1, y: 2};
      let moved = translate(point, 10, 20);
      point.x + point.y + moved.x + moved.y
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assert(!wat.includes("call $translate"));
  assert(!wat.includes("(func $translate"));
  assert(!wat.includes("__inl_translate_"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(3), 42);
});

Deno.test("public exports inline single-use private product tail loops", async () => {
  const source = `
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
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "loop");
  assert(!wat.includes("call $run_loop"));
  assert(!wat.includes("(func $run_loop"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 500500);
});

Deno.test("private wrappers keep array-free product tail loops callable", async () => {
  const source = `
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
    fn __bench_kernel(seed: i32) -> i32 {
      let start: Acc = Acc {sum: 0, ticks: 0};
      let out = run_loop(seed - seed, 1000, start);
      out.sum + out.ticks
    }
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
  const wat = await watFromSource(source, { memoryModel: "branch", optMode: "release" });
  const benchLoop = wat.match(/\(func \$bench_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(wat, "(func $run_loop");
  assertStringIncludes(benchLoop, "call $run_loop");
  assert(!benchLoop.includes("__inl_run_loop"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(
      await wasmFromSource(source, { memoryModel: "branch", optMode: "release" }),
    ),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 500500);
  assertEquals((instance.exports.bench as CallableFunction)(1), 500500);
});

Deno.test("public exports inline private pure scalar helpers", async () => {
  const source = `
    fn inc(x: i32) -> i32 { x + 1 }
    fn twice(x: i32) -> i32 { x * 2 }
    pub fn main(seed: i32) -> i32 {
      twice(inc(seed))
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assert(!wat.includes("call $inc"));
  assert(!wat.includes("call $twice"));
  assert(!wat.includes("(func $inc"));
  assert(!wat.includes("(func $twice"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(3), 8);
});

Deno.test("release inlines generated pure const-function helpers", async () => {
  const source = `
    type fn Id(a: type) -> type { a }

    fn Id::pure(value: a) -> Id(a) {
      value
    }

    fn Id::bind(value: Id(a), const f: fn(x: a) -> Id(b)) -> Id(b) {
      f(value)
    }

    fn get(seed: i32) -> Id(i32) {
      seed + 1
    }

    fn add_id(x: i32) -> Id(i32) {
      x + 2
    }

    pub fn main(seed: i32) -> i32 {
      do @monad(Id(_)) {
        x <- get(seed);
        let y = x + 3;
        z <- add_id(y);
        x + z
      }
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assert(!wat.includes("call $__const_fn"));
  assert(!wat.includes("(func $__const_fn"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 9);
});

Deno.test("optimizer drops pure unused private call arguments only when safe", async () => {
  const pure = await watFromSource(
    `
    fn keep_second(_: i32, b: i32) -> i32 {
      b + b + b + b + b + b + b + b + b + b + b + b
    }
    pub fn main() -> i32 { keep_second(40 + 2, 6) }
  `,
    { optMode: "release" },
  );
  assertStringIncludes(pure, "i32.const 72");
  assert(!pure.includes("i32.const 42"));

  const effectful = await watFromSource(
    `
    const clock = @external("clock", fn(host: io) -> io(i32));
    fn keep_second(_: i32, b: i32) -> i32 {
      b + b + b + b + b + b + b + b + b + b + b + b
    }
    pub fn main(host: io) -> i32 { keep_second(clock(host), 6) }
  `,
    { optMode: "release" },
  );
  assertStringIncludes(effectful, "call $clock");
  assertStringIncludes(effectful, "i32.const 72");
  assert(!effectful.includes("call $keep_second"));
});

Deno.test("tail-recursive self calls lower to loops by default", async () => {
  const source = `
    fn sum(n: i32, acc: i32) -> i32 {
      match n { 0 => acc, _ => sum(n - 1, acc + n) }
    }
    pub fn main() -> i32 { sum(100, 0) }
  `;
  const wat = await watFromSource(source);
  const sum = wat.match(/\(func \$sum[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(sum, "loop");
  assert(!sum.includes("call $sum"));
  assert(!sum.includes("return_call $sum"));
  assert(!sum.includes("__tail_tmp"));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 5050);
});

Deno.test("public exports inline single-use private scalar tail loops", async () => {
  const source = `
    fn sum(n: i32, acc: i32) -> i32 {
      match n { 0 => acc, _ => sum(n - 1, acc + n) }
    }
    pub fn main() -> i32 { sum(100, 0) }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "loop");
  assert(!wat.includes("call $sum"));
  assert(!wat.includes("(func $sum"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 5050);
});

Deno.test("private scalar tail-continuation helpers expose self-tail loops", async () => {
  const source = `
    fn sum_continue(n: i32, acc: i32) -> i32 {
      match n == 0 {
        true => acc,
        false => sum(n - 1, acc + n + 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8)
      }
    }
    fn sum(n: i32, acc: i32) -> i32 {
      sum_continue(n, acc)
    }
    pub fn main() -> i32 { sum(4, 0) }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const sum = wat.match(/\(func \$sum[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(/\bloop\b/.test(sum));
  assert(!wat.includes("call $sum_continue"));
  assert(!sum.includes("call $sum"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 154);
});

Deno.test("state monad recursive do updates state without direct self-calls", async () => {
  const source = `
    const monad = @import("prelude.monad");
    const core = @import("prelude.core");

    type fn Store() -> type { i32 }

    fn step() -> monad.State(Store, core.Unit) {
      do @monad(monad.State(Store, _)) {
        store <- monad.State::get();
        monad.State::put(store + 1)
      }
    }

    fn state_loop(i: i32, limit: i32) -> monad.State(Store, Store) {
      match i < limit {
        true => do @monad(monad.State(Store, _)) {
          step();
          state_loop(i + 1, limit)
        },
        false => monad.State::get()
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      monad.State::eval(state_loop(0, limit), seed)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const stateLoop = wat.match(/\(func \$state_loop[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!stateLoop.includes("call $state_loop"));
  assert(!wat.includes("call_indirect"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1, 4), 5);
});

Deno.test("transparent Reader loop lowers through function encoding without indirect calls", async () => {
  const source = `
    const monad = @import("prelude.monad");

    type fn Env() -> type { i32 }

    fn reader_loop_value(i: i32, limit: i32, env: Env, acc: i32) -> i32 {
      match i < limit {
        true => reader_loop_value(i + 1, limit, env, acc + env),
        false => acc
      }
    }

    fn reader_loop(i: i32, limit: i32, acc: i32) -> monad.Reader(Env, i32) {
      \\env -> reader_loop_value(i, limit, env, acc)
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      monad.Reader::run(reader_loop(0, limit, seed), 3)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const closureLoop = wat.match(/\(func \$__closure_fn__fn_env[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(/\bloop\b/.test(closureLoop));
  assert(!closureLoop.includes("call $reader_loop_value"));
  assert(!wat.includes("call_indirect"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1, 1000), 3001);
});

Deno.test("transparent State loop lowers through function encoding without indirect calls", async () => {
  const source = `
    const monad = @import("prelude.monad");

    type fn Store() -> type { i32 }

    fn state_loop_value(i: i32, limit: i32, store: Store) -> Store {
      match i < limit {
        true => state_loop_value(i + 1, limit, store + 3),
        false => store
      }
    }

    fn state_loop(i: i32, limit: i32) -> monad.State(Store, Store) {
      \\store -> {
        let next = state_loop_value(i, limit, store);
        {value: next, state: next}
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      monad.State::eval(state_loop(0, limit), seed)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const closureLoop = wat.match(/\(func \$__closure_fn__fn_state[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(/\bloop\b/.test(closureLoop));
  assert(!closureLoop.includes("call $state_loop_value"));
  assert(!wat.includes("call_indirect"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1, 1000), 3001);
});

Deno.test("transparent Eff loop lowers through function encoding without indirect calls", async () => {
  const source = `
    const effect = @import("prelude.effect");

    type fn Env() -> type { i32 }
    type fn Store() -> type { i32 }

    fn eff_loop_value(i: i32, limit: i32, env: Env, store: Store) -> Store {
      match i < limit {
        true => eff_loop_value(i + 1, limit, env, store + env),
        false => store
      }
    }

    fn eff_loop(i: i32, limit: i32) -> effect.Eff({state: Store, reader: Env}, Store) {
      \\ctx -> {
        let next = eff_loop_value(i, limit, ctx.reader, ctx.state);
        {value: next, state: next}
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      let result = effect.run_reader(effect.run_state(eff_loop(0, limit), seed), 3);
      result.value
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const closureLoop = wat.match(/\(func \$__closure_fn__fn_ctx[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(/\bloop\b/.test(closureLoop));
  assert(!closureLoop.includes("call $eff_loop_value"));
  assert(!wat.includes("call_indirect"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1, 1000), 3001);
});

Deno.test("transparent capability helpers lower to scalar tail loops", async () => {
  const source = `
    const effect = @import("prelude.effect");

    fn step(
      const effects: const,
      const _proof: effect.Member(#state, effects),
      value: i32
    ) -> effect.Eff(effects, i32) {
      value + 1
    }

    fn loop(i: i32, limit: i32, acc: i32) -> effect.Eff({#state}, i32) {
      match i < limit {
        true => loop(i + 1, limit, step([#state], effect.Member(#state, [#state]), acc)),
        false => acc
      }
    }

    pub fn main(limit: i32) -> i32 {
      loop(0, limit, 0)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const loopFn = wat.match(/\(func \$loop[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(/\bloop\b/.test(loopFn));
  assert(!loopFn.includes("call $loop"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(4), 4);
});

Deno.test("recursive Eff do release loop advances captured induction state", async () => {
  const source = `
    const effect = @import("prelude.effect");

    fn eff_step(env: i32, value: i32) -> effect.Eff({state: i32, reader: i32}, i32) {
      effect.Eff::pure(value + env)
    }

    fn eff_loop(i: i32, limit: i32, env: i32, acc: i32) -> effect.Eff({state: i32, reader: i32}, i32) {
      match i < limit {
        true => do @monad(effect.Eff({state: i32, reader: i32}, _)) {
          next <- eff_step(env, acc);
          eff_loop(i + 1, limit, env, next)
        },
        false => effect.Eff::pure(acc)
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      effect.run_reader(effect.run_state(eff_loop(0, limit, 3, seed), 0), 0).value
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const loop = wat.match(/\(func \$eff_loop[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!loop.includes("call $eff_loop"));
  assert(!wat.includes("call $__const_fn"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1, 20), 61);
  assertEquals((instance.exports.main as CallableFunction)(1, 1000), 3001);
});

Deno.test("recursive reader/state Eff do release loop advances captured induction state", async () => {
  const source = `
    const effect = @import("prelude.effect");

    fn eff_step(env: i32, value: i32) -> effect.Eff({state: i32, reader: i32}, i32) {
      effect.Eff::pure(value + env)
    }

    fn eff_loop(i: i32, limit: i32, env: i32, acc: i32) -> effect.Eff({state: i32, reader: i32}, i32) {
      match i < limit {
        true => do @monad(effect.Eff({state: i32, reader: i32}, _)) {
          next <- eff_step(env, acc);
          eff_loop(i + 1, limit, env, next)
        },
        false => effect.Eff::pure(acc)
      }
    }

    pub fn main(seed: i32, limit: i32) -> i32 {
      effect.run_reader(effect.run_state(eff_loop(0, limit, 3, seed), 0), 0).value
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const loop = wat.match(/\(func \$eff_loop[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!loop.includes("call $eff_loop"));
  assert(!wat.includes("call $__const_fn"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1, 20), 61);
  assertEquals((instance.exports.main as CallableFunction)(1, 1000), 3001);
});

Deno.test("tail-loop lowering skips unchanged scalar parameters", async () => {
  const source = `
    fn sum_to(i: i32, limit: i32, acc: i32) -> i32 {
      match i < limit {
        true => sum_to(i + 1, limit, acc + i),
        false => acc,
      }
    }
    pub fn main(seed: i32) -> i32 {
      sum_to(seed - seed, 1000, 0)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const limitSets = wat.match(/local\.set \$__inl_sum_to_\d+_limit/g) ?? [];
  assertEquals(limitSets.length, 1);
  assert(!wat.includes("call $sum_to"));
  assert(!wat.includes("(func $sum_to"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 499500);
});

Deno.test("tail-loop lowering stores dependent scalar updates before clobbering prior params", async () => {
  const source = `
    fn sum_to(i: i32, limit: i32, acc: i32) -> i32 {
      match i < limit {
        true => sum_to(i + 1, limit, acc + ((i + 10) * 4)),
        false => acc,
      }
    }
    pub fn main(seed: i32) -> i32 {
      sum_to(seed - seed, 4, 0)
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertMatch(
    main,
    /local\.set \$__inl_sum_to_\d+_acc[\s\S]*local\.set \$__inl_sum_to_\d+_i/,
  );
  assert(!wat.includes("call $sum_to"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 184);
});

Deno.test("boolean true match patterns branch directly", async () => {
  const wat = await watFromSource(`
    pub fn lt(x: i32, y: i32) -> i32 {
      match x < y { true => 1, false => 0 }
    }
    pub fn main() -> i32 { lt(1, 2) }
  `);
  const lt = wat.match(/\(func \$lt[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(lt, "i32.lt_s");
  assert(!lt.includes("i32.const 1\n    i32.eq"));
});

Deno.test("release lowers pure conditional scalar updates through select", async () => {
  const source = `
    pub fn main(x: i32, total: i32) -> i32 {
      match x != 0 {
        true => total + x,
        false => total,
      }
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "select");
  assert(!wat.includes("if (result i32)"));

  const trapping = await watFromSource(
    `
    pub fn main(x: i32, total: i32) -> i32 {
      match x != 0 {
        true => total / x,
        false => total,
      }
    }
  `,
    { optMode: "release" },
  );
  assert(!trapping.includes("select"));
  assertStringIncludes(trapping, "if (result i32)");

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  const main = instance.exports.main as CallableFunction;
  assertEquals(main(0, 10), 10);
  assertEquals(main(5, 10), 15);
});

Deno.test("tail-recursive inline-array fold lowers to a loop", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn fold_loop(xs: InlineArray(3, i32), index: i32, acc: i32) -> i32 {
      match index < 3 {
        true => fold_loop(xs, index + 1, acc + xs[index]),
        false => acc,
      }
    }
    pub fn main() -> i32 {
      fold_loop([1, 2, 3], 0, 0)
    }
  `;
  const wat = await watFromSource(source);
  const fold = wat.match(/\(func \$fold_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(fold, "loop");
  assert(!fold.includes("call $fold_loop"));
  assert(!fold.includes("__tail_tmp"));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 6);
});

Deno.test("private pipe-bind product search chain fuses into tail loop", async () => {
  const source = `
    type fn State() -> type {
      let State = {x: i32, r: i32, sum: i32};
      struct(State)
    }
    fn prepare(state: State) -> State {
      State { x: state.x + 1, r: state.r, sum: state.sum }
    }
    fn score(state: State) -> State {
      State { x: state.x, r: state.r, sum: state.sum + state.x }
    }
    fn advance(state: State) -> State {
      State { x: state.x, r: state.r + 1, sum: state.sum }
    }
    fn search(state: State) -> State {
      prepare(state) \\prepared ->
        score(prepared) \\scored ->
          advance(scored) \\next ->
            match next.r == 3 {
              true => next,
              false => search(next),
            }
    }
    pub fn main() -> i32 {
      search(State { x: 0, r: 0, sum: 0 }) \\result ->
        result.x * 100 + result.sum
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const lowered = wat.match(/\(func \$search[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(lowered, "loop");
  assert(!lowered.includes("call $prepare"));
  assert(!lowered.includes("call $score"));
  assert(!lowered.includes("call $advance"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 306);
});

Deno.test("private let-chain product search chain fuses into same tail loop shape", async () => {
  const source = `
    type fn State() -> type {
      let State = {x: i32, r: i32, sum: i32};
      struct(State)
    }
    fn prepare(state: State) -> State {
      State { x: state.x + 1, r: state.r, sum: state.sum }
    }
    fn score(state: State) -> State {
      State { x: state.x, r: state.r, sum: state.sum + state.x }
    }
    fn advance(state: State) -> State {
      State { x: state.x, r: state.r + 1, sum: state.sum }
    }
    fn search(state: State) -> State {
      let prepared = prepare(state);
      let scored = score(prepared);
      let next = advance(scored);
      match next.r == 3 {
        true => next,
        false => search(next),
      }
    }
    pub fn main() -> i32 {
      search(State { x: 0, r: 0, sum: 0 }) \\result ->
        result.x * 100 + result.sum
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const lowered = wat.match(/\(func \$search[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertEquals((lowered.match(/\bloop\b/g) ?? []).length, 1);
  assert(!lowered.includes("call $prepare"));
  assert(!lowered.includes("call $score"));
  assert(!lowered.includes("call $advance"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 306);
});

Deno.test("effectful product transformer is not fused into private search loop", async () => {
  const source = `
    const tick = @external("tick", fn(host: io) -> io(i32));
    type fn State() -> type {
      let State = {x: i32, r: i32};
      struct(State)
    }
    fn prepare(host: io, state: State) -> State {
      State { x: state.x + tick(host), r: state.r }
    }
    fn advance(state: State) -> State {
      State { x: state.x, r: state.r + 1 }
    }
    fn search(host: io, state: State) -> State {
      prepare(host, state) \\prepared ->
        advance(prepared) \\next ->
          match next.r == 1 {
            true => next,
            false => search(host, next),
          }
    }
    pub fn main(host: io) -> i32 {
      search(host, State { x: 0, r: 0 }) \\result -> result.x
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const search = wat.match(/\(func \$search[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(search, "call $prepare");
  assert(!search.includes("call $advance"));
});

Deno.test("fannkuch search release lowering fuses product-state step", async () => {
  const source = await Deno.readTextFile("examples/perf_fannkuch_redux.fig");
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const search = wat.match(/\(func \$search[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(search, "loop");
  assert(!search.includes("call $prepare"));
  assert(!search.includes("call $score"));
  assert(!search.includes("call $advance"));
  assert(!wat.includes("call $dec"));
  assert(!wat.includes("call $step_active"));
  assert(!wat.includes("call $flip_count_loop"));
  assert(!wat.includes("call $layout_InlineArray_set__"));
  assert(!wat.includes("call $layout_InlineArray_update__"));
  assert(!wat.includes("(func $layout_InlineArray_set__"));
  assert(!wat.includes("(func $layout_InlineArray_update__"));
  assert(!search.includes("__inl_step_active_state"));
  assert(!/__inl_flip_count_loop_[^\s)]*_xs\$[0-9]/.test(search));
  assert(!/__inl_rotate_left_[^\s)]*_xs\$[0-9]/.test(search));
  assert(!/__inl_rotate_left_loop_[^\s)]*_xs\$[0-9]/.test(search));
  assertStringIncludes(wat, "fixed_array_packed");
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(0), 22816);
});

Deno.test("packed fixed-array dynamic read lowers through shift and mask", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn read(xs: layout.InlineArray(4, u3), index: i32) -> i32 {
      xs[index]
    }
    fn bump_read(xs: layout.InlineArray(4, u3), index: i32) -> i32 {
      read(layout.InlineArray::set(4, u3, xs, index, 7), index)
    }
    pub fn main(index: i32) -> i32 {
      bump_read(#[1, 2, 3, 4], index)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const read = wat.match(/\(func \$read[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(read, "i32.shr_u");
  assertStringIncludes(read, "i32.and");
  assert(!read.includes("select"));
  assert(!read.includes("call $layout_InlineArray_index__"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(2), 7);
});

Deno.test("packed fixed-array dynamic set updates with shifts and masks", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn set_at(xs: layout.InlineArray(4, u3), index: i32, value: u3) -> layout.InlineArray(4, u3) {
      layout.InlineArray::set(4, u3, xs, index, value)
    }
    pub fn main(index: i32) -> i32 {
      let ys = set_at(#[1, 2, 3, 4], index, 7);
      ys[0] * 1000 + ys[1] * 100 + ys[2] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const setAt = wat.match(/\(func \$set_at[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(setAt, "fixed_array_packed");
  assertStringIncludes(setAt, "i32.shl");
  assertStringIncludes(setAt, "i32.and");
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(2), 1274);
});

Deno.test("packed fixed-array update inlines small private scalar updater", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn dec(x: u3) -> u3 {
      x - 1
    }
    fn update_at(xs: layout.InlineArray(7, u3), index: i32) -> layout.InlineArray(7, u3) {
      layout.InlineArray::update(7, u3, xs, index, dec)
    }
    pub fn main(index: i32) -> i32 {
      let ys = update_at(#[0, 1, 2, 3, 4, 5, 6], index);
      ys[0] * 1000000 + ys[1] * 100000 + ys[2] * 10000 + ys[3] * 1000 +
        ys[4] * 100 + ys[5] * 10 + ys[6]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  assert(!wat.includes("call $dec"));
  assert(!wat.includes("call $layout_InlineArray_update__7__u3"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(3), 122456);
});

Deno.test("packed fixed-array read/update reuses prior dynamic lane", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn dec(x: u3) -> u3 {
      x - 1
    }
    fn update_after_read(xs: layout.InlineArray(7, u3), index: i32) -> i32 {
      let prior = xs[index];
      let ys = layout.InlineArray::update(7, u3, xs, index, dec);
      prior * 10 + ys[index]
    }
    pub fn main(index: i32) -> i32 {
      update_after_read(#[0, 1, 2, 3, 4, 5, 6], index)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const update = wat.match(/\(func \$update_after_read[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(update, "fixed_array_packed");
  assert(!update.includes("__fixed_array_packed_old"));
  assertStringIncludes(update, "i32.xor");
  assert(!update.includes("i32.const -1"));
  assert(!wat.includes("call $dec"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(4), 43);
});

Deno.test("public fixed-array kernel uses optimized private representation clone", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn A() -> type {
      layout.InlineArray(7, u3)
    }
    pub fn public_kernel(xs: A, i: i32, v: u3) -> u3 {
      let ys = layout.InlineArray::set(7, u3, xs, i, v);
      ys[i]
    }
    fn private_kernel(xs: A, i: i32, v: u3) -> u3 {
      let ys = layout.InlineArray::set(7, u3, xs, i, v);
      ys[i]
    }
    pub fn main(i: i32) -> i32 {
      private_kernel(#[0, 1, 2, 3, 4, 5, 6], i, 7)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const publicWrapper = wat.match(/\(func \$public_kernel[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(publicWrapper, `call $public_kernel__optimized`);
  assertStringIncludes(wat, `(func $public_kernel__optimized`);
  assertStringIncludes(wat, "$__fixed_array_packed_xs");
  assertStringIncludes(wat, `(memory $fig_buffers`);

  const fig = await instantiateFig(
    await wasmFromSource(source, { resolveModule, optMode: "release" }),
  );
  const host = createFigHost(fig.abi, fig.instance);
  assertEquals(host.call("public_kernel", [0, 1, 2, 3, 4, 5, 6], 2, 7), 7);
  assertEquals((fig.instance.exports.main as CallableFunction)(3), 7);
});

Deno.test("packed fixed-array swap stays loop-lowered without helpers", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn swap(xs: layout.InlineArray(4, u3), left: i32, right: i32) -> layout.InlineArray(4, u3) {
      let a = xs[left];
      let b = xs[right];
      layout.InlineArray::set(4, u3, xs, left, b) \\ys ->
      layout.InlineArray::set(4, u3, ys, right, a)
    }
    fn reverse_loop(xs: layout.InlineArray(4, u3), left: i32, right: i32) -> layout.InlineArray(4, u3) {
      match left < right {
        true => reverse_loop(swap(xs, left, right), left + 1, right - 1),
        false => xs,
      }
    }
    pub fn main() -> i32 {
      let ys = reverse_loop(#[1, 2, 3, 4], 0, 3);
      ys[0] * 1000 + ys[1] * 100 + ys[2] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const reverse = wat.match(/\(func \$reverse_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(reverse, "loop");
  assertStringIncludes(reverse, "fixed_array_packed");
  assert(!reverse.includes("select"));
  assert(!reverse.includes("call $swap"));
  assert(!reverse.includes("call $layout_InlineArray_set__4__u3"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 4321);
});

Deno.test("user fixed-array edit chain lowers like helper swap", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Perm4() -> type { layout.InlineArray(4, u3) }
    fn user_swap(xs: Perm4, left: i32, right: i32) -> Perm4 {
      let a = xs[left];
      let b = xs[right];
      let with_left: Perm4 = [...xs, [left]: b];
      let swapped: Perm4 = [...with_left, [right]: a];
      swapped
    }
    fn reverse_loop(xs: Perm4, left: i32, right: i32) -> Perm4 {
      match left < right {
        true => reverse_loop(user_swap(xs, left, right), left + 1, right - 1),
        false => xs,
      }
    }
    pub fn main() -> i32 {
      let ys = reverse_loop(#[1, 2, 3, 4], 0, 3);
      ys[0] * 1000 + ys[1] * 100 + ys[2] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const reverse = wat.match(/\(func \$reverse_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(reverse, "loop");
  assertStringIncludes(reverse, "fixed_array_packed");
  assert(!reverse.includes("select"));
  assert(!reverse.includes("call $user_swap"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 4321);
});

Deno.test("tail-recursive scalar inline-array set mutates local slots in loop", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn rotate_left_loop(
      xs: layout.InlineArray(4, i32),
      i: i32,
      r: i32,
      first: i32
    ) -> layout.InlineArray(4, i32) {
      match i < r {
        true => rotate_left_loop(layout.InlineArray::set(4, i32, xs, i, xs[i + 1]), i + 1, r, first),
        false => layout.InlineArray::set(4, i32, xs, r, first),
      }
    }
    pub fn main() -> i32 {
      let xs: layout.InlineArray(4, i32) = #[1, 2, 3, 4];
      let ys = rotate_left_loop(xs, 0, 2, xs[0]);
      ys[0] * 1000 + ys[1] * 100 + ys[2] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const rotate = wat.match(/\(func \$rotate_left_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(rotate, "loop");
  assertStringIncludes(rotate, "select");
  assert(!rotate.includes("fig_buffers"));
  assert(!rotate.includes("call $rotate_left_loop"));
  assert(!rotate.includes("call $layout_InlineArray_set__4__i32"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 2314);
});

Deno.test("tail-recursive packed adjacent lane copy folds dynamic shifts", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn rotate_left_loop(
      xs: layout.InlineArray(7, u3),
      i: i32,
      r: i32,
      first: u3
    ) -> layout.InlineArray(7, u3) {
      match i < r {
        true => rotate_left_loop(layout.InlineArray::set(7, u3, xs, i, xs[i + 1]), i + 1, r, first),
        false => layout.InlineArray::set(7, u3, xs, r, first),
      }
    }
    pub fn main(seed: i32) -> i32 {
      let xs: layout.InlineArray(7, u3) = #[seed, 2, 3, 4, 5, 6, 0];
      let ys = rotate_left_loop(xs, 0, 4, xs[0]);
      ys[0] * 1000000 + ys[1] * 100000 + ys[2] * 10000 + ys[3] * 1000 +
        ys[4] * 100 + ys[5] * 10 + ys[6]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "fixed_array_packed_prefix_shift");
  assert(!main.includes("call $rotate_left_loop"));
  assert(!main.includes("call $layout_InlineArray_set__7__u3"));
  assert(!main.includes("loop"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 2345160);
});

Deno.test("private fixed-array forwarding transformer parameter stays packed when inlined", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Perm() -> type { layout.InlineArray(7, u3) }
    fn rotate_left_loop(xs: Perm, i: i32, r: i32, first: u3) -> Perm {
      if i < r {
        rotate_left_loop(layout.InlineArray::set(7, u3, xs, i, xs[i + 1]), i + 1, r, first)
      } else {
        layout.InlineArray::set(7, u3, xs, r, first)
      }
    }
    fn rotate_left(xs: Perm, r: i32) -> Perm {
      let first: u3 = xs[0];
      rotate_left_loop(xs, 0, r, first)
    }
    fn step(xs: Perm, r: i32) -> Perm {
      rotate_left(xs, r)
    }
    pub fn main() -> i32 {
      let ys = step(#[0, 1, 2, 3, 4, 5, 6], 3);
      ys[0] * 100 + ys[1] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  assertStringIncludes(wat, "fixed_array_packed_prefix_shift");
  assert(!/__inl_rotate_left_[^\s)]*_xs\$[0-9]/.test(wat));
  assert(!wat.includes("call $rotate_left_loop"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 120);
});

Deno.test("backed fixed-array transformer folds pure scalar aliases into prefix shift", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Perm() -> type { layout.InlineArray(7, u3) }
    fn rotate_left_loop(xs: Perm, i: i32, r: i32, first: u3) -> Perm {
      if i < r {
        rotate_left_loop(layout.InlineArray::set(7, u3, xs, i, xs[i + 1]), i + 1, r, first)
      } else {
        layout.InlineArray::set(7, u3, xs, r, first)
      }
    }
    fn apply(xs: Perm, r: i32) -> Perm {
      let first: u3 = xs[0];
      rotate_left_loop(xs, 0, r, first)
    }
    fn spin(xs: Perm, i: i32) -> Perm {
      if i < 1 { spin(apply(xs, 3), i + 1) } else { xs }
    }
    pub fn main() -> i32 {
      let ys = spin(#[0, 1, 2, 3, 4, 5, 6], 0);
      ys[0] * 100 + ys[1] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  assertStringIncludes(wat, "__fixed_array_packed_xs");
  assert(!/__inl_apply_[^\s)]*first/.test(wat));
  assert(!wat.includes("call $apply"));
  assert(!wat.includes("call $rotate_left_loop"));
  assert(!/i32\.const 7\s+i32\.and\s+i32\.const 7\s+i32\.and/.test(wat));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 120);
});

Deno.test("tail-recursive scalar inline-array swap mutates local slots in loop", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn swap(xs: layout.InlineArray(4, i32), left: i32, right: i32) -> layout.InlineArray(4, i32) {
      let a = xs[left];
      let b = xs[right];
      layout.InlineArray::set(4, i32, xs, left, b) \\ys ->
      layout.InlineArray::set(4, i32, ys, right, a)
    }
    fn reverse_loop(xs: layout.InlineArray(4, i32), left: i32, right: i32) -> layout.InlineArray(4, i32) {
      match left < right {
        true => reverse_loop(swap(xs, left, right), left + 1, right - 1),
        false => xs,
      }
    }
    pub fn main() -> i32 {
      let ys = reverse_loop(#[1, 2, 3, 4], 0, 3);
      ys[0] * 1000 + ys[1] * 100 + ys[2] * 10 + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const reverse = wat.match(/\(func \$reverse_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(reverse, "loop");
  assertStringIncludes(reverse, "select");
  assert(!reverse.includes("fig_buffers"));
  assert(!reverse.includes("call $swap"));
  assert(!reverse.includes("call $layout_InlineArray_set__4__i32"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 4321);
});

Deno.test("tail-recursive product fixed-array field update stays backed in loop", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Counts() -> type { layout.InlineArray(4, u3) }
    type fn State() -> type {
      let State = {values: Counts, r: i32};
      struct(State)
    }
    fn prepare(state: State) -> State {
      if state.r != 1 {
        prepare(State {
          values: layout.InlineArray::set(4, u3, state.values, state.r - 1, state.r),
          r: state.r - 1,
        })
      } else {
        state
      }
    }
    pub fn main() -> i32 {
      let result = prepare(State { values: #[0, 0, 0, 0], r: 3 });
      result.values[1] * 10 + result.values[2] + result.r
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const prepare = wat.match(/\(func \$prepare[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(prepare, "__fixed_array_packed_state$values");
  assert(!prepare.includes("local.set $state$values$0"));
  assert(!prepare.includes("local.set $state$values$1"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 24);
});

Deno.test("tail-recursive product update keeps multiple fixed-array fields backed", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Small() -> type { layout.InlineArray(4, u3) }
    type fn State() -> type {
      let State = {left: Small, right: Small, r: i32};
      struct(State)
    }
    fn prepare(state: State) -> State {
      if state.r != 0 {
        prepare(State {
          left: layout.InlineArray::set(4, u3, state.left, state.r, state.r),
          right: layout.InlineArray::set(4, u3, state.right, state.r, state.r + 1),
          r: state.r - 1,
        })
      } else {
        state
      }
    }
    pub fn main() -> i32 {
      let result = prepare(State { left: #[0, 0, 0, 0], right: #[0, 0, 0, 0], r: 3 });
      result.left[2] * 100 + result.right[2] * 10 + result.r
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const prepare = wat.match(/\(func \$prepare[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(prepare, "__fixed_array_packed_state$left");
  assertStringIncludes(prepare, "__fixed_array_packed_state$right");
  assert(!prepare.includes("local.set $state$left$0"));
  assert(!prepare.includes("local.set $state$right$0"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 230);
});

Deno.test("tail-recursive product update keeps recursive fixed-array transformer field backed", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Small() -> type { layout.InlineArray(4, u3) }
    type fn State() -> type {
      let State = {xs: Small, r: i32};
      struct(State)
    }
    fn rotate_loop(xs: Small, i: i32, first: u3) -> Small {
      if i < 3 {
        rotate_loop(layout.InlineArray::set(4, u3, xs, i, xs[i + 1]), i + 1, first)
      } else {
        layout.InlineArray::set(4, u3, xs, 3, first)
      }
    }
    fn step(state: State) -> State {
      if state.r != 0 {
        let first: u3 = state.xs[0];
        step(State { xs: rotate_loop(state.xs, 0, first), r: state.r - 1 })
      } else {
        state
      }
    }
    pub fn main() -> i32 {
      let result = step(State { xs: #[1, 2, 3, 0], r: 1 });
      result.xs[0] * 100 + result.xs[1] * 10 + result.xs[2]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const step = wat.match(/\(func \$step[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(step, "__fixed_array_packed_state$xs");
  assert(!step.includes("local.set $state$xs$0"));
  assert(!/__inl_rotate_loop_[0-9]+_xs\$0/.test(step));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 230);
});

Deno.test("tail-recursive product update defers let-bound fixed-array update into backing", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Small() -> type { layout.InlineArray(4, u3) }
    type fn State() -> type {
      let State = {count: Small, r: i32};
      struct(State)
    }
    fn step(state: State) -> State {
      if state.r != 0 {
        let count = layout.InlineArray::set(4, u3, state.count, state.r, state.r);
        step(State { count: count, r: state.r - 1 })
      } else {
        state
      }
    }
    pub fn main() -> i32 {
      let result = step(State { count: #[0, 0, 0, 0], r: 2 });
      result.count[1] * 100 + result.count[2] * 10 + result.r
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const step = wat.match(/\(func \$step[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(step, "__fixed_array_packed_state$count");
  assert(!step.includes("local.set $count$0"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 120);
});

Deno.test("backed product tail loop updates scalar parameters when product stays in place", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Counts() -> type { layout.InlineArray(4, u3) }
    type fn State() -> type {
      let State = {count: Counts, r: i32, index: i32};
      struct(State)
    }
    fn step_continue(state: State, r: i32) -> State {
      let prior = state.count[r];
      let count = layout.InlineArray::update(4, u3, state.count, r, dec);
      if prior > 1 {
        State { count: count, r: r, index: state.index + 1 }
      } else {
        step_active(State { count: count, r: r + 1, index: state.index }, r + 1)
      }
    }
    fn step_active(state: State, r: i32) -> State {
      if r == 4 { state } else { step_continue(state, r) }
    }
    fn dec(x: u3) -> u3 { x - 1 }
    pub fn main() -> i32 {
      let result = step_active(State { count: #[1, 1, 3, 0], r: 1, index: 1 }, 1);
      result.r * 100000 + result.index * 1000 + result.count[1] * 100 + result.count[2] * 10
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  assertStringIncludes(wat, "loop");
  assert(!wat.includes("call $step_continue"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 202020);
});

Deno.test("tail-recursive fixed-array transformer stays backed across caller loop", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Perm() -> type { layout.InlineArray(4, u3) }
    fn swap(xs: Perm, left: i32, right: i32) -> Perm {
      let a = xs[left];
      let b = xs[right];
      layout.InlineArray::set(4, u3, xs, left, b)
        \\ys -> layout.InlineArray::set(4, u3, ys, right, a)
    }
    fn reverse_loop(xs: Perm, left: i32, right: i32) -> Perm {
      if left < right {
        reverse_loop(swap(xs, left, right), left + 1, right - 1)
      } else {
        xs
      }
    }
    fn flip_loop(xs: Perm, flips: i32) -> i32 {
      let first: u3 = xs[0];
      if first != 0 {
        flip_loop(reverse_loop(xs, 0, first), flips + 1)
      } else {
        flips
      }
    }
    pub fn main() -> i32 {
      flip_loop(#[2, 1, 0, 3], 0)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const flip = wat.match(/\(func \$flip_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(flip, "__fixed_array_packed_xs");
  assert(!flip.includes("local.set $xs$0"));
  assert(!/__inl_reverse_loop_[0-9]+_xs\$0/.test(flip));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 1);
});

Deno.test("private product fixed-array field dynamic set avoids helper calls and runs", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Box() -> type {
      let Box = {values: layout.InlineArray(4, i32), tag: i32};
      struct(Box)
    }
    fn bump(box: Box, index: i32) -> Box {
      Box {
        values: layout.InlineArray::set(4, i32, box.values, index, box.tag + 1),
        tag: box.tag,
      }
    }
    pub fn main(index: i32) -> i32 {
      let box = Box { values: #[1, 2, 3, 4], tag: 9 };
      let next = bump(box, index);
      next.values[1] * 10 + next.values[2] + next.tag
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const bump = wat.match(/\(func \$bump[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!bump.includes("call $layout_InlineArray_set__4__i32"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 112);
  assertEquals((instance.exports.main as CallableFunction)(2), 39);
});

Deno.test("scratch fixed-array update evaluates prior value without helper call", async () => {
  const source = `
    const layout = @import("prelude.layout");
    type fn Box() -> type {
      let Box = {values: layout.InlineArray(4, i32), tag: i32};
      struct(Box)
    }
    fn inc(x: i32) -> i32 { x + 1 }
    fn bump(box: Box, index: i32) -> Box {
      Box {
        values: layout.InlineArray::update(4, i32, box.values, index, inc),
        tag: box.tag,
      }
    }
    pub fn main(index: i32) -> i32 {
      let box = Box { values: #[1, 2, 3, 4], tag: 9 };
      let next = bump(box, index);
      next.values[1] * 10 + next.values[2] + next.tag
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const bump = wat.match(/\(func \$bump[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(bump, `i32.load (memory $fig_buffers)`);
  assertStringIncludes(bump, `i32.store (memory $fig_buffers)`);
  assert(!bump.includes("select"));
  assert(!bump.includes("call $layout_InlineArray_update__4__i32__inc"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 42);
  assertEquals((instance.exports.main as CallableFunction)(2), 33);
});

Deno.test("scratch fixed-array argument forwards to private dynamic read callee", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn inc(x: i32) -> i32 { x + 1 }
    fn read(xs: layout.InlineArray(4, i32), index: i32) -> i32 {
      xs[index]
    }
    fn bump_read(xs: layout.InlineArray(4, i32), index: i32) -> i32 {
      read(layout.InlineArray::update(4, i32, xs, index, inc), index)
    }
    pub fn main(index: i32) -> i32 {
      bump_read(#[1, 2, 3, 4], index)
    }
  `;
  const wat = await watFromSource(source, { resolveModule });
  const read = wat.match(/\(func \$read[\s\S]*?\n  \)/)?.[0] ?? "";
  const bumpRead = wat.match(/\(func \$bump_read[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(read, `i32.load (memory $fig_buffers)`);
  assertStringIncludes(read, `i32.store (memory $fig_buffers)`);
  assert(!read.includes("select"));
  assert(!bumpRead.includes("call $layout_InlineArray_update__4__i32__inc"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 3);
  assertEquals((instance.exports.main as CallableFunction)(2), 4);
});

Deno.test("index cursor Yield item proves inline-array indexing and lowers inline", async () => {
  const source = `
    const core = @import("prelude.core");
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn sum_loop(xs: InlineArray(3, i32), cursor: core.IndexCursor(3), acc: i32) -> i32 {
      match core.IndexCursor::next(3, cursor) {
        Yield(i, next) => sum_loop(xs, next, acc + xs[i]),
        Done => acc,
      }
    }
    pub fn main() -> i32 {
      sum_loop([10, 20, 12], core.IndexCursor::start(3), 0)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const sum = wat.match(/\(func \$sum_loop[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(sum, "loop");
  assert(!sum.includes("IndexCursor::next"));
  assert(!sum.includes("call $sum_loop"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 42);
});

Deno.test("index cursor Yield wildcard payload skips unused item local", async () => {
  const source = `
    const core = @import("prelude.core");
    fn skip_items(cursor: core.IndexCursor(3), acc: i32) -> i32 {
      match core.IndexCursor::next(3, cursor) {
        Yield(_, next) => skip_items(next, acc + 1),
        Done => acc,
      }
    }
    pub fn main() -> i32 {
      skip_items(core.IndexCursor::start(3), 0)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const skip = wat.match(/\(func \$skip_items[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!skip.includes("__iter_item"));
  assert(!skip.includes("local.set $i"));
  assertStringIncludes(skip, "$next");

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(), 3);
});

Deno.test("inline array builder primitives lower without runtime calls", async () => {
  const wat = await watFromSource(
    `
    type fn Index(n: count) -> type { i32(0..n) }
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn InlineArrayBuilder(n: count, a: type) -> type {
      let Builder = {n*a};
      struct(Builder)
    }
    fn InlineArrayBuilder::start(const n: count, const a: type) -> InlineArrayBuilder(n, a) {
      @inline_array_builder_start(n, a)
    }
    fn InlineArrayBuilder::push(
      const n: count,
      const a: type,
      builder: InlineArrayBuilder(n, a),
      i: Index(n),
      value: a
    ) -> InlineArrayBuilder(n, a) {
      @inline_array_builder_push(n, a, builder, i, value)
    }
    fn InlineArrayBuilder::finish(const n: count, const a: type, builder: InlineArrayBuilder(n, a)) -> InlineArray(n, a) {
      @inline_array_builder_finish(n, a, builder)
    }
    pub fn main() -> i32 {
      let b0 = InlineArrayBuilder::start(2, i32);
      let b1 = InlineArrayBuilder::push(2, i32, b0, 0, 10);
      let b2 = InlineArrayBuilder::push(2, i32, b1, 1, 20);
      let xs = InlineArrayBuilder::finish(2, i32, b2);
      xs[0] + xs[1]
    }
  `,
    { optMode: "release" },
  );

  assert(!wat.includes("InlineArrayBuilder::start"));
  assert(!wat.includes("InlineArrayBuilder::push"));
  assert(!wat.includes("InlineArrayBuilder::finish"));
  assert(!wat.includes("call $inline_array_builder"));
});

Deno.test("indexed spread fixed tuple update lowers without builder loop", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn source(seed: i32) -> InlineArray(4, i32) {
      #[seed + 1, 2, 3, 4]
    }
    pub fn main(seed: i32) -> i32 {
      let xs = source(seed);
      let ys: InlineArray(4, i32) = [...xs, [1]: 32];
      xs[1] + ys[1] + ys[3]
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assert(!wat.includes("InlineArrayBuilder"));
  assert(!wat.includes("InlineArray.set_loop"));
  assert(!wat.includes("InlineArray.update_loop"));
  assert(!wat.includes("if"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 38);
});

Deno.test("public inline array update folds statically known index", async () => {
  const source = `
    const layout = @import("prelude.layout");
    fn bump(x: i32) -> i32 { x + 3 }
    pub fn main(seed: i32) -> i32 {
      let xs: layout.InlineArray(4, i32) = #[1, 2, 3, 4];
      let ys: layout.InlineArray(4, i32) = layout.InlineArray::update(4, i32, xs, seed - seed + 2, bump);
      xs[2] + ys[2] + ys[3]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("InlineArray.update_loop"));
  assert(!main.includes("InlineArrayBuilder"));
  assert(!main.includes("if"));
  assertStringIncludes(main, "i32.const 13");
  assert(!main.includes("local.set $ys$0"));
  assert(!main.includes("local.set $ys$1"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 13);
});

Deno.test("projected fixed-array update only tabulates source indexes used later", async () => {
  const source = `
    const layout = @import("prelude.layout");
    const core = @import("prelude.core");
    fn make(i: core.Index(16)) -> i32 { i + 1 }
    fn bump(x: i32) -> i32 { x + 3 }
    pub fn main(seed: i32) -> i32 {
      let xs = layout.InlineArray::tabulate(16, i32, make);
      let ys = layout.InlineArray::update(16, i32, xs, seed - seed + 7, bump);
      xs[7] + ys[7] + ys[15]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "i32.const 35");
  assert(!main.includes("local.set $xs$0"));
  assert(!main.includes("local.set $xs$14"));
  assert(!main.includes("call $make"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 35);
});

Deno.test("projected fixed-array spread update only materializes used source indexes", async () => {
  const source = `
    const layout = @import("prelude.layout");
    pub fn main(seed: i32) -> i32 {
      let xs: layout.InlineArray(16, i32) = #[1 + seed - seed, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
      let ys: layout.InlineArray(16, i32) = [...xs, [7]: xs[7] + 3];
      xs[7] + ys[7] + ys[15]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "i32.const 35");
  assert(!main.includes("local.set $xs$0"));
  assert(!main.includes("local.set $xs$14"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 35);
});

Deno.test("backend prunes lowered helpers unused after fixed update lowering", async () => {
  const source = `
    const layout = @import("prelude.layout");
    const core = @import("prelude.core");
    fn make(i: core.Index(16)) -> i32 { i + 1 }
    fn bump(x: i32) -> i32 { x + 3 }
    pub fn main(seed: i32) -> i32 {
      let xs = layout.InlineArray::tabulate(16, i32, make);
      let ys = layout.InlineArray::update(16, i32, xs, seed - seed + 7, bump);
      xs[7] + ys[7] + ys[15]
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });

  assertEquals((wat.match(/\(func /g) ?? []).length, 1);
  assert(!wat.includes("InlineArray.update_loop"));
  assert(!wat.includes("InlineArrayBuilder"));
  assert(!wat.includes("call $"));
});

Deno.test("tail-loop lowering folds pure scalar branch aliases", async () => {
  const source = `
    const array = @import("prelude.array_static");
    fn add(acc: i32, x: i32) -> i32 { acc + x }
    pub fn main(seed: i32) -> i32 {
      array.RangeIter::fold(array.RangeI32::Iter(seed - seed .. 1000), 0, add)
    }
  `;
  const wat = await watFromSource(source, { resolveModule, optMode: "release" });
  const loop = wat.match(/\(func \$array_RangeIter_fold_loop__add[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!loop.includes("acc_then"));
  assert(!loop.includes("acc_else"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(10), 499500);
});

Deno.test("dynamic scalar inline array indexing lowers through select", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    pub fn main(index: i32) -> i32 {
      let xs: InlineArray(4, i32) = #[10, 20, 30, 40];
      xs[index]
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const main = wat.match(/\(func \$main__optimized[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "select");
  assert(!main.includes("if"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(0), 10);
  assertEquals((instance.exports.main as CallableFunction)(2), 30);
  assertEquals((instance.exports.main as CallableFunction)(9), 40);
});

Deno.test("safe dynamic scalar fixed tuple update lowers through select", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    pub fn main(index: i32) -> i32 {
      let xs: InlineArray(4, i32) = #[1, 2, 3, 4];
      let ys: InlineArray(4, i32) = [...xs, [index]: 40 + 2];
      ys[1] + ys[2]
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const main = wat.match(/\(func \$main__optimized[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(main, "select");
  assert(!main.includes("if"));
  assert(!wat.includes("InlineArrayBuilder"));
  assert(!wat.includes("fig_buffers"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 45);
  assertEquals((instance.exports.main as CallableFunction)(2), 44);
  assertEquals((instance.exports.main as CallableFunction)(9), 5);
});

Deno.test("dynamic indexed spread fixed tuple update is lazy and left-to-right", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) -> type {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    fn boom() -> i32 { 1 / 0 }
    pub fn main(index: i32) -> i32 {
      let xs: InlineArray(4, i32) = #[1, 2, 3, 4];
      let ys: InlineArray(4, i32) = [...xs, [index]: boom(), [index]: 40];
      ys[1] + ys[2]
    }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  assertStringIncludes(wat, "if (result i32)");
  assert(!wat.includes("InlineArrayBuilder"));

  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { optMode: "release" })),
  );
  assertEquals((instance.exports.main as CallableFunction)(1), 43);
});

Deno.test("direct self-tail body lowers to a loop by default", async () => {
  const source = `
    fn again(n: i32, acc: i32) -> i32 { again(n - 1, acc + n) }
    pub fn main() -> i32 { again(1, 0) }
  `;
  const wat = await watFromSource(source);
  const again = wat.match(/\(func \$again[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(again, "loop");
  assert(!again.includes("call $again"));
  assert(!again.includes("return_call $again"));
});

Deno.test("if sugar preserves self-tail loop lowering", async () => {
  const source = `
    fn sum(n: i32, acc: i32) -> i32 {
      if n == 0 {
        acc
      } else {
        sum(n - 1, acc + n)
      }
    }
    pub fn main() -> i32 { sum(5, 0) }
  `;
  const wat = await watFromSource(source, { optMode: "release" });
  const sum = wat.match(/\(func \$sum[\s\S]*?\n  \)/)?.[0] ??
    wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(sum, "loop");
  assert(!sum.includes("call $sum"));

  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as CallableFunction)(), 15);
});

Deno.test("tail-recursive match arms can emit return_call when requested", async () => {
  const source = `
    fn sum(n: i32, acc: i32) -> i32 {
      match n { 0 => acc, _ => sum(n - 1, acc + n) }
    }
    pub fn main() -> i32 { sum(10, 0) }
  `;
  const wat = await watFromSource(source, { tailCallMode: "opcode" });
  const sum = wat.match(/\(func \$sum[\s\S]*?\n  \)/)?.[0] ?? "";
  assertStringIncludes(sum, "return_call $sum");

  const loopInstance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source)),
  );
  const opcodeInstance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { tailCallMode: "opcode" })),
  );
  assertEquals(
    (opcodeInstance.exports.main as CallableFunction)(),
    (loopInstance.exports.main as CallableFunction)(),
  );
});

Deno.test("opcode mode rejects non-tail self recursion", async () => {
  await assertTailCallRejected(
    "arithmetic operand",
    `
      fn Bad(n: i32) -> i32 { match n { 0 => 0, _ => 1 + Bad(n - 1) } }
      pub fn main() -> i32 { Bad(3) }
    `,
  );
});

Deno.test("opcode mode rejects direct self recursion outside tail position", async () => {
  await assertTailCallRejected(
    "call argument",
    `
    fn Id(x: i32) -> i32 { x }
    fn call_arg(n: i32) -> i32 { match n { 0 => 0, _ => Id(call_arg(n - 1)) } }
    pub fn main() -> i32 { call_arg(3) }
  `,
  );
  await assertTailCallRejected(
    "let initializer",
    `
    fn let_init(n: i32) -> i32 {
      let x: i32 = let_init(n - 1);
      x
    }
    pub fn main() -> i32 { let_init(3) }
  `,
  );
  await assertTailCallRejected(
    "dynamic index operand",
    `
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Lane4I32() -> type { InlineArray(4, i32) }
    type fn Index(n: count) -> type { i32(0..n) }
    fn dynamic_index_target(n: i32, i: Index(4)) -> Lane4I32 {
      match n { 0 => [0, 0, 0, 0], _ => [dynamic_index_target(n - 1, i)[i], 0, 0, 0] }
    }
    pub fn main(i: Index(4)) -> i32 {
      dynamic_index_target(3, i)[i]
    }
  `,
  );
});

async function assertTailCallRejected(label: string, source: string) {
  try {
    await watFromSource(source, { tailCallMode: "opcode" });
  } catch (error) {
    assert(error instanceof Error);
    assertStringIncludes(error.message, "not eligible");
    return;
  }
  throw new Error(`expected non-tail recursive function to be rejected: ${label}`);
}

Deno.test("backend keeps generated forwarding wrappers inlined at call sites", async () => {
  const wat = await watFromSource(
    `
    type fn Box() { let Box = {value: i32}; struct(Box) }
    type fn Functor(f: type) { let Functor = {map: fn(x: f) -> f}; struct(Functor) }
    fn map_box(x: Box) -> Box { {value: x.value + 1} }
    const box_functor: Functor(Box) = {map: map_box};
    fn mapped(const dict: Functor(Box), x: Box) -> Box { dict.map(x) }
    pub fn main() -> Box { mapped(box_functor, {value: 41}) }
  `,
    { optMode: "release" },
  );
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $map_box"));
  assert(!wat.includes("(func $mapped__box_functor"));
});

Deno.test("Lane4I32 public ABI stays scalar while pure lane add uses SIMD internally", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Lane4I32() -> type { InlineArray(4, i32) }
    pub fn main(x: Lane4I32, k: i32) -> Lane4I32 {
      [x[0] + k, x[1] + k, x[2] + k, x[3] + k]
    }
  `;
  const wat = await watFromSource(source);
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";

  assertStringIncludes(
    main,
    "(param $x$0 i32) (param $x$1 i32) (param $x$2 i32) (param $x$3 i32) (param $k i32)",
  );
  assertStringIncludes(main, "(result i32) (result i32) (result i32) (result i32)");
  assert(!main.includes("(param v128)"));
  assert(!main.includes("(result v128)"));
  assertStringIncludes(main, "i32x4.splat");
  assertStringIncludes(main, "i32x4.add");

  new WebAssembly.Module(await wasmFromSource(source));
});

Deno.test("SIMD lane add matches scalar result", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Lane4I32() -> type { InlineArray(4, i32) }
    pub fn main(x: Lane4I32, k: i32) -> Lane4I32 {
      [x[0] + k, x[1] + k, x[2] + k, x[3] + k]
    }
  `;
  const fig = await instantiateFig(await wasmFromSource(source));
  const host = createFigHost(fig.abi, fig.instance);
  assertEquals(numericFields(host.call("main", [1, 2, 3, 4], 10)), [11, 12, 13, 14]);
});

Deno.test("SIMD dot product lowers matrix multiply kernel", async () => {
  const source = await Deno.readTextFile("examples/perf_matmul_simd.fig");
  const wat = await watFromSource(source, { optMode: "release" });

  assertStringIncludes(wat, "i32x4.mul");
  assertStringIncludes(wat, "i8x16.shuffle");
  assertStringIncludes(wat, "i32x4.add");
  assertStringIncludes(wat, "i32x4.extract_lane");
  assertStringIncludes(wat, "(func $__fig_dot4_i32");
  assertStringIncludes(wat, "call $__fig_dot4_i32");

  const fig = await instantiateFig(await wasmFromSource(source, { optMode: "release" }));
  const host = createFigHost(fig.abi, fig.instance);
  const result = host.call(
    "main",
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 16],
    [1, 5, 9, 13],
    [2, 6, 10, 14],
    [3, 7, 11, 15],
    [4, 8, 12, 16],
  );
  assertEquals(
    numericFields(result),
    [
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
  );
});

Deno.test("scalar matrix multiply baseline stays scalar", async () => {
  const source = await Deno.readTextFile("examples/perf_matmul_scalar.fig");
  const wat = await watFromSource(source);

  assert(!wat.includes("i32x4."));
  assertStringIncludes(wat, "i32.mul");
  assertStringIncludes(wat, "i32.add");

  const fig = await instantiateFig(await wasmFromSource(source));
  const host = createFigHost(fig.abi, fig.instance);
  assertEquals(
    numericFields(
      host.call(
        "main",
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
      ),
    ),
    [
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
  );
});

Deno.test("branch memory mode exports branch memories and packs handles", async () => {
  const source = `
    fn branch.handle(ptr: i32) -> i64 {
      @branch_handle(ptr)
    }
    fn branch.handle_ptr(handle: i64) -> i32 {
      @branch_handle_ptr(handle)
    }
    fn branch.mark(handle: i64) -> i64 {
      @branch_mark(handle)
    }
    pub fn main() -> i32 {
      branch.handle_ptr(branch.mark(branch.handle(7)))
    }
  `;
  const wat = await watFromSource(source, { memoryModel: "branch" });
  assertStringIncludes(wat, `(memory $fig_objects (export "fig_objects") 1)`);
  assertStringIncludes(wat, `(memory $fig_buffers (export "fig_buffers") 1)`);
  assertStringIncludes(wat, "i64.extend_i32_u");
  assertStringIncludes(wat, "i32.wrap_i64");

  const instance = await WebAssembly.instantiate(
    await wasmFromSource(source, { memoryModel: "branch" }),
    {},
  );
  assertEquals((instance.instance.exports.main as CallableFunction)(), 7);
  assertEquals(
    WebAssembly.Module.exports(instance.module).filter((item) => item.kind === "memory").map((
      item,
    ) => item.name),
    ["fig_objects", "fig_buffers"],
  );
});

Deno.test("branch intrinsics lower to header flags and copy-before-write", async () => {
  const source = `
    fn branch.handle(ptr: i32) -> i64 {
      @branch_handle(ptr)
    }
    fn branch.handle_ptr(handle: i64) -> i32 {
      @branch_handle_ptr(handle)
    }
    fn branch.mark(handle: i64) -> i64 {
      @branch_mark(handle)
    }
    fn branch.is_branched(handle: i64) -> bool {
      @branch_is_branched(handle)
    }
    fn branch.ensure(handle: i64) -> i64 {
      @branch_ensure_editable(handle)
    }
    pub fn mark_then_check(ptr: i32) -> bool {
      branch.is_branched(branch.mark(branch.handle(ptr)))
    }
    pub fn ensure_ptr(ptr: i32) -> i32 {
      branch.handle_ptr(branch.ensure(branch.handle(ptr)))
    }
  `;

  const wat = await watFromSource(source, { memoryModel: "branch-debug" });
  assertStringIncludes(wat, `(memory $fig_objects (export "fig_objects") 1)`);
  assertStringIncludes(wat, "i32.load align=4 offset=8");
  assertStringIncludes(wat, "i32.store align=4 offset=8");
  assertStringIncludes(wat, "memory.copy");

  const instance = await WebAssembly.instantiate(
    await wasmFromSource(source, { memoryModel: "branch-debug" }),
    {},
  );
  const exports = instance.instance.exports as {
    fig_objects: WebAssembly.Memory;
    mark_then_check: CallableFunction;
    ensure_ptr: CallableFunction;
  };
  const words = new Uint32Array(exports.fig_objects.buffer);
  const ptr = 64;
  words[ptr / 4] = 11;
  words[ptr / 4 + 1] = 8;
  words[ptr / 4 + 2] = 0;
  words[ptr / 4 + 4] = 123;
  words[ptr / 4 + 5] = 456;

  assertEquals(exports.ensure_ptr(ptr), ptr);
  assertEquals(exports.mark_then_check(ptr), 1);

  const copied = exports.ensure_ptr(ptr);
  assertEquals(copied, ptr + 24);
  assertEquals(words[ptr / 4 + 2], 1);
  assertEquals(words[copied / 4], 11);
  assertEquals(words[copied / 4 + 1], 8);
  assertEquals(words[copied / 4 + 2], 0);
  assertEquals(words[copied / 4 + 4], 123);
  assertEquals(words[copied / 4 + 5], 456);
});

Deno.test("debug trace statements import trace hook and release erases them", async () => {
  const source = `
    pub fn main() -> i32 {
      @trace("entered main");
      42
    }
  `;

  const debugWat = await watFromSource(source);
  assertStringIncludes(debugWat, `(import "env" "fig_trace"`);
  assertStringIncludes(debugWat, "call $__fig_trace");
  const debugBytes = await wasmFromSource(source);
  assert(customSection(debugBytes, "fig.trace"));

  const releaseWat = await watFromSource(source, { optMode: "release" });
  assert(!releaseWat.includes("fig_trace"));
  assert(!releaseWat.includes("__fig_trace"));
  const releaseBytes = await wasmFromSource(source, { optMode: "release" });
  assertEquals(customSection(releaseBytes, "fig.trace"), undefined);
});

Deno.test("runtime profile expressions import hooks and preserve result stack", async () => {
  const source = `
    type fn Pair() -> type { let Pair = {left: i32, right: i32}; struct(Pair) }
    pub fn main() -> Pair {
      @profile("pair") { {left: 40, right: 2} }
    }
  `;

  const wat = await watFromSource(source, { runtimeProfile: true });
  assertStringIncludes(wat, `(import "env" "fig_profile_enter"`);
  assertStringIncludes(wat, `(import "env" "fig_profile_exit"`);
  assertStringIncludes(wat, "call $__fig_profile_enter");
  assertStringIncludes(wat, "call $__fig_profile_exit");
  assertStringIncludes(wat, "local.set $__profile_tmp");

  const bytes = await wasmFromSource(source, { runtimeProfile: true });
  assert(customSection(bytes, "fig.profile"));

  const erased = await watFromSource(source);
  assert(!erased.includes("fig_profile_enter"));
  assert(!erased.includes("__profile_tmp"));
});

Deno.test("unsupported lane patterns fall back to scalar WAT", async () => {
  const wat = await watFromSource(`
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    type fn Lane4I32() -> type { InlineArray(4, i32) }
    pub fn main(x: Lane4I32) -> Lane4I32 {
      [x[0] + 1, x[1] + 2, x[2] + 3, x[3] + 4]
    }
  `);

  assert(!wat.includes("i32x4."));
  assertStringIncludes(wat, "i32.add");
});
