import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkSource, watFromSource } from "../src/mod.ts";

const prelude = (name: string) => Deno.readTextFile(`prelude/${name}.shovel`);
const fragment = async (name: string) =>
  (await prelude(name)).split("\n").filter((line) =>
    !line.startsWith("module ") && !line.startsWith("import module ")
  ).join("\n");

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.shovel`);
  } catch {
    return undefined;
  }
};

Deno.test("prelude fragments compose by concatenation", async () => {
  await checkSource(`
    ${await fragment("core")}
    ${await fragment("layout")}
    ${await fragment("array_static")}

    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> lane4_i32 { map4_i32(inc, [1, 2, 3, 4]) }
  `);
});

Deno.test("functional prelude checks functor and monad examples", async () => {
  const source = await Deno.readTextFile("examples/prelude_functional.shovel");
  await checkSource(source, { resolveModule });
});

Deno.test("static array prelude checks map zip_with and fold", async () => {
  const source = await Deno.readTextFile("examples/prelude_array_static.shovel");
  const checked = await checkSource(source, { resolveModule });
  assertEquals(checked.program.sourceImports?.length ?? 0, 0);
});

Deno.test("schedule metadata composes with static array prelude", async () => {
  const source = await Deno.readTextFile("examples/prelude_perf_pipeline.shovel");
  await checkSource(source, { resolveModule });
});

Deno.test("source imports diagnose missing modules", async () => {
  try {
    await checkSource("import module prelude.missing; pub fn main() -> i32 { 1 }", {
      resolveModule,
    });
  } catch (error) {
    assert(error instanceof Error);
    assert(error.message.includes("module.not_found"));
    return;
  }
  throw new Error("expected missing module diagnostic");
});

Deno.test("map4 const function lowers to four direct scalar calls", async () => {
  const wat = await watFromSource(
    `
    import module prelude.array_static;
    fn inc(x: scalar_i32) -> scalar_i32 { [value: x.value + 1] }
    pub fn main() -> scalar_i32 { map4_scalar_i32(inc, [value: 1]) }
  `,
    { resolveModule },
  );

  assertEquals(wat.match(/call \$inc/g)?.length, 4);
  assert(!wat.includes("(func $map4_scalar_i32 "));
});

Deno.test("lane4_i32 lowers to four scalar Wasm results", async () => {
  const wat = await watFromSource(`
    import module prelude.array_static;
    fn inc(x: i32) -> i32 { x + 1 }
    pub fn main() -> lane4_i32 { map4_i32(inc, [1, 2, 3, 4]) }
  `, { resolveModule });

  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(main.includes("(result i32) (result i32) (result i32) (result i32)"));
  assertEquals(wat.match(/call \$inc/g)?.length, 4);
});

Deno.test("zip_with4 const function lowers without a runtime operation parameter", async () => {
  const wat = await watFromSource(
    `
    import module prelude.array_static;
    fn add(a: scalar_i32, b: scalar_i32) -> scalar_i32 { [value: a.value + b.value] }
    pub fn main() -> scalar_i32 {
      zip_with4_scalar_i32(add, [value: 1], [value: 2], [value: 3], [value: 4], [value: 5])
    }
  `,
    { resolveModule },
  );

  assertEquals(wat.match(/call \$add/g)?.length, 4);
  assert(!wat.includes("(func $zip_with4_scalar_i32 "));
});

Deno.test("fold4 and reduce4 specialize reducers", async () => {
  const wat = await watFromSource(
    `
    import module prelude.array_static;
    fn add(a: i32, b: i32) -> i32 { a + b }
    pub fn main() -> i32 {
      fold4_i32(add, 0, [1, 2, 3, 4]) + reduce4_i32(add, [1, 2, 3, 4])
    }
  `,
    { resolveModule },
  );

  assertEquals(wat.match(/call \$add/g)?.length, 7);
  const main = wat.match(/\(func \$main[\s\S]*?\n  \)/)?.[0] ?? "";
  assert(!main.includes("call $fold4_i32\n"));
  assert(!main.includes("call $reduce4_i32\n"));
});
