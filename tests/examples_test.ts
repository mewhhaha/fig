import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { checkSource, wasmFromSource, watFromSource } from "../src/mod.ts";

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.shovel`);
  } catch {
    return undefined;
  }
};

Deno.test("all examples parse and check", async () => {
  for await (const entry of Deno.readDir("examples")) {
    if (!entry.isFile || !entry.name.endsWith(".shovel")) continue;
    const source = await Deno.readTextFile(`examples/${entry.name}`);
    await checkSource(source, { resolveModule });
  }
});

Deno.test("all examples lower to WAT and valid wasm modules", async () => {
  for await (const entry of Deno.readDir("examples")) {
    if (!entry.isFile || !entry.name.endsWith(".shovel")) continue;
    const source = await Deno.readTextFile(`examples/${entry.name}`);
    await checkSource(source, { resolveModule });
    await watFromSource(source, { resolveModule });
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule }));
  }
});

Deno.test("example wasm modules instantiate with explicit host imports when needed", async () => {
  for await (const entry of Deno.readDir("examples")) {
    if (!entry.isFile || !entry.name.endsWith(".shovel")) continue;
    const source = await Deno.readTextFile(`examples/${entry.name}`);
    const module = new WebAssembly.Module(await wasmFromSource(source, { resolveModule }));
    const imports = WebAssembly.Module.imports(module);
    const instance = new WebAssembly.Instance(module, {
      env: {
        clock: () => 1n,
        random: () => 2,
      },
    });
    if (imports.length === 0 && typeof instance.exports.main === "function") {
      (instance.exports.main as () => unknown)();
    }
  }
});

Deno.test("capability imports are emitted in WAT and wasm", async () => {
  const source = await Deno.readTextFile("examples/effects.shovel");
  const wat = await watFromSource(source, { resolveModule });
  assertStringIncludes(wat, `(func $clock (import "env" "clock") (result i32))`);
  assertStringIncludes(wat, `(func $random (import "env" "random") (result i32))`);
  const module = new WebAssembly.Module(await wasmFromSource(source, { resolveModule }));
  assertEquals(
    WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}`),
    ["env.clock", "env.random"],
  );
});

Deno.test("CLI run reports required host imports", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/cli.ts", "run", "examples/effects.shovel"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  assertEquals(output.success, false);
  assertStringIncludes(
    new TextDecoder().decode(output.stderr),
    "host imports required: env.clock, env.random",
  );
});

Deno.test("arithmetic example runs through wasm backend", async () => {
  const source = await Deno.readTextFile("examples/arithmetic.shovel");
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as () => number)(), 42);
});
