import { assertEquals } from "jsr:@std/assert@1";
import {
  compileArtifactsFromSource,
  decodeFigValue,
  encodeFigValue,
  instantiateFig,
  parseFigAbiManifest,
  wasmFromSource,
} from "../src/mod.ts";

Deno.test("memory-v1 is the default public ABI for products", async () => {
  const source = `
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    pub fn main(p: Pair) -> Pair {
      Pair {x: p.x + 1, y: p.y + 2}
    }
  `;

  const artifact = await compileArtifactsFromSource(source, { includeWat: false });
  assertEquals(artifact.abi?.mode, "memory-v1");
  const fig = await instantiateFig(artifact.wasm);
  const input = encodeFigValue(fig.abi, fig.instance, "Pair", { x: 10, y: 20 });
  const raw = (fig.instance.exports.main as CallableFunction)(input);

  assertEquals(decodeFigValue(fig.abi, fig.instance, "Pair", raw), { x: 11, y: 22 });
  assertEquals(parseFigAbiManifest(artifact.wasm).exports[0]?.results[0]?.passing, "handle");
});

Deno.test("memory-v1 round-trips fixed arrays through handles", async () => {
  const source = `
    type fn InlineArray(n: count, a: type) {
      let InlineArray = {n*a};
      struct(InlineArray)
    }
    pub fn main(xs: InlineArray(3, i32)) -> InlineArray(3, i32) {
      [xs[0] + 1, xs[1] + 2, xs[2] + 3]
    }
  `;

  const fig = await instantiateFig(await wasmFromSource(source));
  const type = "InlineArray(3, i32)";
  const input = encodeFigValue(fig.abi, fig.instance, type, [4, 5, 6]);
  const raw = (fig.instance.exports.main as CallableFunction)(input);

  assertEquals(decodeFigValue(fig.abi, fig.instance, type, raw), {
    "0": 5,
    "1": 7,
    "2": 9,
  });
});

Deno.test("memory-v1 preserves single-field product identity with handles", async () => {
  const source = `
    type fn Box(a: type) -> type {
      let Box = {value: a};
      struct(Box)
    }
    pub fn main(box: Box(i32)) -> Box(i32) {
      Box {value: box.value + 1}
    }
  `;

  const fig = await instantiateFig(await wasmFromSource(source));
  const input = encodeFigValue(fig.abi, fig.instance, "Box(i32)", 41);
  const raw = (fig.instance.exports.main as CallableFunction)(input);

  assertEquals(decodeFigValue(fig.abi, fig.instance, "Box(i32)", raw), 42);
  assertEquals(fig.abi.exports[0]?.params[0]?.passing, "handle");
});

Deno.test("memory-v1 round-trips nested string actions through buffers", async () => {
  const source = `
    const echo = @external("echo", fn(host: io, text: string) -> io(string));
    pub fn main(host: io, text: string) -> io(string) { echo(host, text) }
  `;

  const artifact = await compileArtifactsFromSource(source, { includeWat: false });
  const main = artifact.abi?.exports.find((item) => item.name === "main");
  const echo = artifact.abi?.imports.find((item) => item.name === "echo");

  assertEquals(main?.params[1]?.passing, "handle");
  assertEquals(main?.results[0]?.passing, "handle");
  assertEquals(echo?.results[0]?.passing, "handle");

  let fig: Awaited<ReturnType<typeof instantiateFig>>;
  fig = await instantiateFig(artifact.wasm, {
    env: {
      echo: (_host: number, text: number) => {
        const value = decodeFigValue(fig.abi, fig.instance, "string", text);
        return encodeFigValue(fig.abi, fig.instance, "io(string)", `${value}!`);
      },
    },
  });
  const input = encodeFigValue(fig.abi, fig.instance, "string", "fig");
  const raw = (fig.instance.exports.main as CallableFunction)(0, input);

  assertEquals(decodeFigValue(fig.abi, fig.instance, "io(string)", raw), "fig!");
});

Deno.test("memory-v1 wraps compound host imports", async () => {
  const source = `
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    const bump = @external("bump", fn(host: io, p: Pair) -> io(Pair));
    pub fn main(host: io, p: Pair) -> io(Pair) {
      bump(host, p)
    }
  `;

  let fig: Awaited<ReturnType<typeof instantiateFig>>;
  const resultType = "io(Pair)";
  fig = await instantiateFig(await wasmFromSource(source), {
    env: {
      bump: (_host: number, p: number) => {
        const value = decodeFigValue(fig.abi, fig.instance, "Pair", p) as { x: number; y: number };
        return encodeFigValue(fig.abi, fig.instance, resultType, {
          x: value.x + 10,
          y: value.y + 20,
        });
      },
    },
  });
  const input = encodeFigValue(fig.abi, fig.instance, "Pair", { x: 1, y: 2 });
  const raw = (fig.instance.exports.main as CallableFunction)(0, input);

  assertEquals(decodeFigValue(fig.abi, fig.instance, resultType, raw), { x: 11, y: 22 });
});

Deno.test("memory-v1 helpers write to the named buffer memory", async () => {
  const source = `
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    pub fn main(p: Pair) -> Pair { p }
  `;

  const fig = await instantiateFig(await wasmFromSource(source));
  const allocBuffer = fig.instance.exports.fig_alloc_buffer;
  if (typeof allocBuffer !== "function") throw new Error("missing fig_alloc_buffer export");
  const ptr = Number(allocBuffer(12));
  const buffers = fig.instance.exports.fig_buffers;
  const objects = fig.instance.exports.fig_objects;
  if (!(buffers instanceof WebAssembly.Memory) || !(objects instanceof WebAssembly.Memory)) {
    throw new Error("missing ABI memories");
  }

  assertEquals(new DataView(buffers.buffer).getUint32(ptr + 4, true), 12);
  assertEquals(new DataView(objects.buffer).getUint32(ptr + 4, true), 0);
});

Deno.test("memory-v1 object allocator grows object memory", async () => {
  const source = `
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    pub fn main(p: Pair) -> Pair { p }
  `;

  const fig = await instantiateFig(await wasmFromSource(source));
  const objects = fig.instance.exports.fig_objects;
  const allocObject = fig.instance.exports.fig_alloc_object;
  if (!(objects instanceof WebAssembly.Memory) || typeof allocObject !== "function") {
    throw new Error("missing object ABI helpers");
  }
  const beforePages = objects.buffer.byteLength / 65536;
  const ptr = Number(allocObject(123, objects.buffer.byteLength));
  const afterPages = objects.buffer.byteLength / 65536;

  assertEquals(afterPages, beforePages + 1);
  assertEquals(new DataView(objects.buffer).getUint32(ptr, true), 123);
});
