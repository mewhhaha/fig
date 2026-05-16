import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { checkSource, wasmFromSource, watFromSource } from "../src/mod.ts";

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

Deno.test("all examples parse and check", async () => {
  let discovered = 0;
  for await (const entry of Deno.readDir("examples")) {
    if (!entry.isFile || !entry.name.endsWith(".fig")) continue;
    discovered++;
    const source = await Deno.readTextFile(`examples/${entry.name}`);
    await checkSource(source, { resolveModule });
  }
  assertEquals(discovered > 0, true);
});

Deno.test("all examples lower to WAT and valid wasm modules", async () => {
  for await (const entry of Deno.readDir("examples")) {
    if (!entry.isFile || !entry.name.endsWith(".fig")) continue;
    const source = await Deno.readTextFile(`examples/${entry.name}`);
    await checkSource(source, { resolveModule });
    await watFromSource(source, { resolveModule });
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule }));
  }
});

Deno.test("example wasm modules instantiate with explicit host imports when needed", async () => {
  for await (const entry of Deno.readDir("examples")) {
    if (!entry.isFile || !entry.name.endsWith(".fig")) continue;
    const source = await Deno.readTextFile(`examples/${entry.name}`);
    const module = new WebAssembly.Module(await wasmFromSource(source, { resolveModule }));
    const imports = WebAssembly.Module.imports(module);
    const instance = new WebAssembly.Instance(module, {
      env: {
        clock: () => 1n,
        random: () => 2,
        tick_millis: () => 16,
        input_axis_x: () => 1,
        input_pressed: () => 0,
      },
    });
    if (imports.length === 0 && typeof instance.exports.main === "function") {
      (instance.exports.main as () => unknown)();
    }
  }
});

Deno.test("engine playground tick consumes time and event capabilities", async () => {
  const source = await Deno.readTextFile("examples/engine_playground.fig");
  const module = new WebAssembly.Module(await wasmFromSource(source, { resolveModule }));
  assertEquals(
    WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}`),
    ["env.tick_millis", "env.input_axis_x", "env.input_pressed"],
  );
});

Deno.test("engine playground frame builds, ticks, and renders visible sprites", async () => {
  const source = await Deno.readTextFile("examples/engine_playground.fig");
  const module = new WebAssembly.Module(await wasmFromSource(source, { resolveModule }));
  const instance = new WebAssembly.Instance(module, {
    env: {
      tick_millis: () => 16,
      input_axis_x: () => 1,
      input_pressed: () => 1,
    },
  });
  assertEquals((instance.exports.playground_world_len as () => number)(), 2);
  assertEquals((instance.exports.playground_probe as () => number)(), 8);
  const frame = (instance.exports.main as () => number[])();
  assertEquals(frame[0], 16);
  assertEquals(frame[5], 2);
  assertEquals(frame[48], 8);
});

Deno.test("capability imports are emitted in WAT and wasm", async () => {
  const source = await Deno.readTextFile("examples/effects.fig");
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
    args: ["run", "--allow-read", "src/cli.ts", "run", "examples/effects.fig"],
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

Deno.test("CLI usage names fig", async () => {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/cli.ts"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  assertEquals(output.success, false);
  assertStringIncludes(new TextDecoder().decode(output.stderr), "usage: fig ");
});

Deno.test("CLI defaults to debug mode and --release selects release mode", async () => {
  const path = await Deno.makeTempFile({ suffix: ".fig" });
  await Deno.writeTextFile(
    path,
    `
      fn add1(x: i32) -> i32 { x + 1 }
      pub fn main() -> i32 { add1(41) }
    `,
  );

  const debug = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/cli.ts", "wat", path],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(debug.success, true);
  const debugWat = new TextDecoder().decode(debug.stdout);
  assertStringIncludes(debugWat, "(func $add1");
  assertStringIncludes(debugWat, "call $add1");

  const release = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/cli.ts", "wat", path, "--release"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(release.success, true);
  const releaseWat = new TextDecoder().decode(release.stdout);
  assertEquals(releaseWat.includes("(func $add1"), false);
  assertEquals(releaseWat.includes("call $add1"), false);

  await Deno.remove(path);
});

Deno.test("CLI rejects legacy --opt modes", async () => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "src/cli.ts", "wat", "examples/hello.fig", "--opt", "debug"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(output.success, false);
  assertStringIncludes(new TextDecoder().decode(output.stderr), "usage: fig ");
});

Deno.test("arithmetic example runs through wasm backend", async () => {
  const source = await Deno.readTextFile("examples/arithmetic.fig");
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
  );
  assertEquals((instance.exports.main as () => number)(), 42);
});
