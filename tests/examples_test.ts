import { assertEquals } from "jsr:@std/assert@1";
import { checkSource, wasmFromSource } from "../src/mod.ts";

Deno.test("all examples parse and check", async () => {
  for await (const entry of Deno.readDir("examples")) {
    if (!entry.isFile || !entry.name.endsWith(".shovel")) continue;
    const source = await Deno.readTextFile(`examples/${entry.name}`);
    await checkSource(source);
  }
});

Deno.test("arithmetic example runs through wasm backend", async () => {
  const source = await Deno.readTextFile("examples/arithmetic.shovel");
  const instance = new WebAssembly.Instance(new WebAssembly.Module(await wasmFromSource(source)));
  assertEquals((instance.exports.main as () => number)(), 42);
});
