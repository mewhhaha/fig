import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  compileArtifactsFromSource,
  createFigHost,
  decodeFigValue,
  encodeFigValue,
  instantiateFig,
  parseFigAbiManifest,
  wasmFromSource,
} from "../src/mod.ts";

const resolveModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

function wasmWithCustomSection(name: string, payload: string): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const payloadBytes = encoder.encode(payload);
  const sectionPayload = new Uint8Array([
    ...varUint(nameBytes.length),
    ...nameBytes,
    ...payloadBytes,
  ]);
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    ...varUint(sectionPayload.length),
    ...sectionPayload,
  ]);
}

function varUint(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
}

Deno.test("stable memory ABI is the default public ABI for products", async () => {
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
  assertEquals(artifact.abi?.version, 1);
  assertEquals(artifact.abi?.name, "fig.memory");
  assertEquals(artifact.abi?.objectHeader?.byteSize, 16);
  const module = new WebAssembly.Module(artifact.wasm);
  assertEquals(WebAssembly.Module.customSections(module, "fig.abi").length, 1);
  const fig = await instantiateFig(artifact.wasm);
  const input = encodeFigValue(fig.abi, fig.instance, "Pair", { x: 10, y: 20 });
  const raw = (fig.instance.exports.main as CallableFunction)(input);

  assertEquals(decodeFigValue(fig.abi, fig.instance, "Pair", raw), { x: 11, y: 22 });
  assertEquals(parseFigAbiManifest(artifact.wasm).exports[0]?.results[0]?.passing, "handle");
  assertEquals((fig.instance.exports.fig_abi_version as CallableFunction)(), 1);
});

Deno.test("stable memory ABI rejects malformed ABI manifests", () => {
  const wasm = wasmWithCustomSection(
    "fig.abi",
    JSON.stringify({
      name: "fig.memory",
      version: 1,
      target: "wasm32-core-3-browser",
      pointer: "i32",
      endian: "little",
      memories: [],
      helpers: {},
      exports: [],
      imports: [],
      layouts: [],
    }),
  );

  assertThrows(() => parseFigAbiManifest(wasm), Error, "invalid Fig ABI manifest: missing helpers");
});

Deno.test("stable memory ABI round-trips fixed arrays through handles", async () => {
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

Deno.test("stable memory ABI preserves single-field product identity with handles", async () => {
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

Deno.test("stable memory ABI round-trips nested string actions through buffers", async () => {
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

Deno.test("stable memory ABI wraps compound host imports", async () => {
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

Deno.test("stable memory ABI host calls exports with JS values", async () => {
  const source = `
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    pub fn main(p: Pair) -> Pair {
      Pair {x: p.x + 1, y: p.y + 2}
    }
  `;

  const fig = await instantiateFig(await wasmFromSource(source));
  const host = createFigHost(fig.abi, fig.instance);

  assertEquals(host.call("main", { x: 10, y: 20 }), { x: 11, y: 22 });
});

Deno.test("stable memory ABI host calls heap arrays with JS arrays", async () => {
  const source = `
    const layout = @import("prelude.layout");
    pub fn main(xs: layout.HeapArray(i32)) -> layout.HeapArray(i32) { xs }
  `;

  const fig = await instantiateFig(await wasmFromSource(source, { resolveModule }));
  const host = createFigHost(fig.abi, fig.instance);

  assertEquals(host.call("main", [4, 5, 6]), [4, 5, 6]);
});

Deno.test("stable memory ABI host calls option-like sums with JS variants", async () => {
  const source = `
    type fn Option(a: type) -> type {
      let None = {};
      let Some = {value: a};
      union(None, Some)
    }
    pub fn main(x: Option(i32)) -> Option(i32) { x }
  `;

  const fig = await instantiateFig(await wasmFromSource(source));
  const host = createFigHost(fig.abi, fig.instance);

  assertEquals(host.call("main", { variant: "Some", value: 7 }), { variant: "Some", value: 7 });
  assertEquals(host.call("main", { variant: "None" }), { variant: "None" });
});

Deno.test("stable memory ABI helpers write to the named buffer memory", async () => {
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

Deno.test("stable memory ABI object allocator grows object memory", async () => {
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

Deno.test("stable memory ABI rejects malformed host product input", async () => {
  const source = `
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    pub fn main(p: Pair) -> Pair { p }
  `;

  const fig = await instantiateFig(await wasmFromSource(source));
  assertThrows(
    () => encodeFigValue(fig.abi, fig.instance, "Pair", { x: 1 }),
    Error,
    "missing ABI field y for Pair",
  );
});

Deno.test("stable memory ABI rejects bad object handles and short payloads", async () => {
  const source = `
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    pub fn main(p: Pair) -> Pair { p }
  `;

  const fig = await instantiateFig(await wasmFromSource(source));
  assertThrows(
    () => decodeFigValue(fig.abi, fig.instance, "Pair", 0),
    Error,
    "invalid ABI handle for Pair",
  );

  const allocObject = fig.instance.exports.fig_alloc_object;
  if (typeof allocObject !== "function") throw new Error("missing object ABI helper");
  const layout = fig.abi.layouts.find((item) => item.type === "Pair");
  assert(layout);
  const ptr = Number(allocObject(layout.id, 0));
  assertThrows(
    () => decodeFigValue(fig.abi, fig.instance, "Pair", ptr),
    Error,
    "short ABI payload for Pair",
  );
});

Deno.test("stable memory ABI layout ids are stable across declaration order", async () => {
  const a = `
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    type fn Box() -> type {
      let Box = {value: i32};
      struct(Box)
    }
    pub fn main(p: Pair) -> Pair { p }
  `;
  const b = `
    type fn Box() -> type {
      let Box = {value: i32};
      struct(Box)
    }
    type fn Pair() -> type {
      let Pair = {x: i32, y: i32};
      struct(Pair)
    }
    pub fn main(p: Pair) -> Pair { p }
  `;

  const left = parseFigAbiManifest(await wasmFromSource(a));
  const right = parseFigAbiManifest(await wasmFromSource(b));
  assertEquals(
    left.layouts.find((item) => item.type === "Pair")?.id,
    right.layouts.find((item) => item.type === "Pair")?.id,
  );
});

Deno.test("stable memory ABI exposes heap array layout metadata", async () => {
  const source = `
    const layout = @import("prelude.layout");
    pub fn main(xs: layout.HeapArray(i32)) -> layout.HeapArray(i32) { xs }
  `;

  const abi = parseFigAbiManifest(
    await wasmFromSource(source, {
      resolveModule,
    }),
  );
  const layout = abi.layouts.find((item) => item.type.endsWith("HeapArray(i32)"));
  assertEquals(layout?.kind, "heap_array");
  assertEquals(layout?.category, "heap_array");
  assertEquals(layout?.item?.type, "i32");
});

Deno.test("stable memory ABI exposes sum variant layout metadata", async () => {
  const source = `
    type fn Option(a: type) -> type {
      let None = {};
      let Some = {value: a};
      union(None, Some)
    }
    pub fn main(x: Option(i32)) -> Option(i32) { x }
  `;

  const abi = parseFigAbiManifest(await wasmFromSource(source));
  const layout = abi.layouts.find((item) => item.type === "Option(i32)");
  assertEquals(layout?.kind, "sum");
  assertEquals(layout?.category, "sum");
  assertEquals(layout?.variants?.map((item) => item.name), ["None", "Some"]);
  assertEquals(layout?.variants?.[1]?.fields[0]?.type, "i32");
});
