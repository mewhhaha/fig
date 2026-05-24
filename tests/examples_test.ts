import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { checkSource, decodeFigValue, instantiateFig, wasmFromSource, watFromSource } from "../src/mod.ts";

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
        canvas_init: () => 1,
        gpu_create_shader: () => 1,
        gpu_create_pipeline: () => 1,
        gpu_upload_vertices: () => 1,
        gpu_draw_quads: () => 1,
        gpu_begin_frame: () => 1,
        gpu_draw_rect: () => 1,
        gpu_draw_sprite: () => 1,
        gpu_present: () => 1,
        event_poll: () => 0,
        audio_play: () => 1,
        audio_music: () => 1,
      },
    });
    if (imports.length === 0 && typeof instance.exports.main === "function") {
      (instance.exports.main as () => unknown)();
    }
  }
});

Deno.test("engine playground tick consumes time event and render effects", async () => {
  const source = await Deno.readTextFile("examples/engine_playground.fig");
  const module = new WebAssembly.Module(await wasmFromSource(source, { resolveModule }));
  assertEquals(
    WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}`),
    [
      "env.canvas_init",
      "env.gpu_create_shader",
      "env.gpu_create_pipeline",
      "env.gpu_upload_vertices",
      "env.gpu_draw_quads",
      "env.gpu_begin_frame",
      "env.gpu_draw_rect",
      "env.gpu_draw_sprite",
      "env.gpu_present",
      "env.event_poll",
      "env.tick_millis",
      "env.input_axis_x",
      "env.input_pressed",
    ],
  );
});

Deno.test("engine playground release build handles generated ECS systems", async () => {
  const source = await Deno.readTextFile("examples/engine_playground.fig");
  new WebAssembly.Module(await wasmFromSource(source, { resolveModule, optMode: "release" }));
});

Deno.test("engine playground frame builds, ticks, and renders visible sprites", async () => {
  const source = await Deno.readTextFile("examples/engine_playground.fig");
  const drawCalls: number[][] = [];
  let began = 0;
  let presented = 0;
  const fig = await instantiateFig(await wasmFromSource(source, { resolveModule }), {
    env: {
      tick_millis: () => 16,
      input_axis_x: () => 1,
      input_pressed: () => 1,
      canvas_init: () => 1,
      gpu_create_shader: () => 1,
      gpu_create_pipeline: () => 1,
      gpu_upload_vertices: () => 1,
      gpu_draw_quads: () => 1,
      gpu_begin_frame: (_target: number, _width: number, _height: number) => {
        began++;
        return 1;
      },
      gpu_draw_rect: (...args: number[]) => {
        drawCalls.push(args);
        return 1;
      },
      gpu_draw_sprite: () => 1,
      gpu_present: () => {
        presented++;
        return 1;
      },
      event_poll: () => 0,
    },
  });
  const instance = fig.instance;
  assertEquals((instance.exports.playground_world_len as () => number)(), 2);
  assertEquals((instance.exports.playground_probe as (host: number) => number)(0), 8);
  const frameHandle = (instance.exports.main as (host: number) => number)(0);
  const frame = decodeFigValue(fig.abi, instance, "RenderBatch", frameHandle) as Record<
    string,
    number
  >;
  assertEquals(frame["items$0$x"], 20);
  assertEquals(frame["items$0$rgba"], 2);
  assertEquals(frame.len, 8);
  const rendered = (instance.exports.render_frame as (
    host: number,
    target: number,
    width: number,
    height: number,
  ) => number)(0, 1, 960, 540);
  assertEquals(rendered, 4);
  assertEquals(began, 1);
  assertEquals(presented, 1);
  assertEquals(drawCalls.length, 2);
  assertEquals(drawCalls[0]?.slice(2), [20, 8, 16, 16, 1, 2]);
});

Deno.test("host IO imports are emitted in WAT and wasm", async () => {
  const source = await Deno.readTextFile("examples/effects.fig");
  const wat = await watFromSource(source, { resolveModule });
  assertStringIncludes(wat, `(func $clock (import "env" "clock") (param i32) (result i32))`);
  assertStringIncludes(wat, `(func $random (import "env" "random") (param i32) (result i32))`);
  const module = new WebAssembly.Module(await wasmFromSource(source, { resolveModule }));
  assertEquals(
    WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}`),
    ["env.clock", "env.random"],
  );
});

Deno.test("prelude effect examples run", async () => {
  const expected = new Map([
    ["examples/prelude_effect_reader.fig", 42],
    ["examples/prelude_effect_state.fig", 12],
    ["examples/prelude_effect_debug.fig", 42],
    ["examples/prelude_effect_ecs_do.fig", 7],
    ["examples/prelude_reader_config.fig", 42],
    ["examples/prelude_state_counter.fig", 42],
    ["examples/prelude_reader_state_common.fig", 42],
  ]);
  for (const [file, value] of expected) {
    const source = await Deno.readTextFile(file);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
    );
    assertEquals((instance.exports.main as CallableFunction)(), value);
  }
});

Deno.test("Haskell and Zig inspired examples run", async () => {
  const expected = new Map([
    ["examples/haskell_validation_pipeline.fig", 55],
    ["examples/haskell_reader_state_program.fig", 42],
    ["examples/zig_comptime_record_layout.fig", 37],
    ["examples/zig_static_matrix_schedule.fig", 134],
  ]);
  for (const [file, value] of expected) {
    const source = await Deno.readTextFile(file);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(await wasmFromSource(source, { resolveModule })),
    );
    assertEquals((instance.exports.main as CallableFunction)(), value);
  }
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
