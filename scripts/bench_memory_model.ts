import { wasmFromSource, watFromSource } from "../src/mod.ts";

interface Scenario {
  name: string;
  source: string;
  expected: number;
  forkTargets: string[];
}

const iterations = Number(Deno.args.find((arg) => arg !== "--") ?? 100_000);

const scenarios: Scenario[] = [
  {
    name: "scalar_nway",
    expected: 40,
    forkTargets: ["a", "b", "c", "d"],
    source: `
      pub fn main() -> i32 {
        let x = 10;
        let a, b, c, d = fork(x);
        a + b + c + d
      }
    `,
  },
  {
    name: "nested_alias_chain",
    expected: 28,
    forkTargets: ["a", "b", "c", "d", "e", "f"],
    source: `
      pub fn main() -> i32 {
        let x = 7;
        let a, b = fork(x);
        let c, d = fork(a);
        let e, f = fork(c);
        e + f + d + b
      }
    `,
  },
  {
    name: "product_projection",
    expected: 14,
    forkTargets: ["a", "b", "c"],
    source: `
      type fn Pair() -> type {
        let Pair = {left: i32, right: i32};
        struct(Pair)
      }
      fn score(p: Pair) -> i32 { p.left + p.right }
      pub fn main() -> i32 {
        let pair: Pair = Pair {left: 2, right: 5};
        let a, b, c = fork(pair);
        score(a) + b.left + c.right
      }
    `,
  },
  {
    name: "inline_array_index",
    expected: 8,
    forkTargets: ["a", "b", "c"],
    source: `
      type fn InlineArray(n: count, a: type) -> type {
        let InlineArray = {n*a};
        struct(InlineArray)
      }
      pub fn main() -> i32 {
        let xs: InlineArray(4, i32) = <1, 2, 3, 4>;
        let a, b, c = fork(xs);
        a[0] + b[2] + c[3]
      }
    `,
  },
  {
    name: "branch_match",
    expected: 11,
    forkTargets: ["cond", "then_x", "else_x"],
    source: `
      pub fn main() -> i32 {
        let x = 9;
        let cond, then_x, else_x = fork(x);
        match cond == 0 {
          true => then_x + 1,
          false => else_x + 2
        }
      }
    `,
  },
];

const rows = [];
for (const scenario of scenarios) {
  const wat = await watFromSource(scenario.source);
  const wasm = await wasmFromSource(scenario.source);
  const mainWat = mainFunctionWat(wat);
  const main = new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports.main as CallableFunction;
  const warmup = main() as number;
  if (warmup !== scenario.expected) {
    throw new Error(`${scenario.name} expected ${scenario.expected} but got ${warmup}`);
  }

  const timed = timeCalls(main);
  const eagerForkTargets = scenario.forkTargets.filter((name) => hasEagerForkTarget(mainWat, name));
  rows.push({
    scenario: scenario.name,
    iterations,
    checksum: timed.checksum,
    elapsed_ms: timed.elapsedMs.toFixed(3),
    calls_per_ms: (iterations / timed.elapsedMs).toFixed(3),
    wat_bytes: wat.length,
    main_locals: count(mainWat, /\(local \$/g),
    local_gets: count(mainWat, /\blocal\.get \$/g),
    local_sets: count(mainWat, /\blocal\.set \$/g),
    fork_target_locals: eagerForkTargets.length,
    eager_fork_targets: eagerForkTargets.join(",") || "-",
  });
}

console.table(rows);

function timeCalls(main: CallableFunction): { elapsedMs: number; checksum: number } {
  const start = performance.now();
  let checksum = 0;
  for (let index = 0; index < iterations; index++) checksum += main() as number;
  return { elapsedMs: performance.now() - start, checksum };
}

function mainFunctionWat(wat: string): string {
  return wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
}

function hasEagerForkTarget(mainWat: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  return new RegExp(`\\(local \\$${escaped}(?:\\s|\\$)`).test(mainWat) ||
    new RegExp(`\\blocal\\.set \\$${escaped}(?:\\s|\\$)`).test(mainWat);
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
