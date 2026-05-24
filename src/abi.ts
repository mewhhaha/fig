import type { FigAbiLayout, FigAbiManifest, FigAbiValue } from "./backend.ts";

export interface FigInstance {
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
  abi: FigAbiManifest;
}

export async function instantiateFig(
  wasm: BufferSource | WebAssembly.Module,
  imports: WebAssembly.Imports = {},
): Promise<FigInstance> {
  const module = wasm instanceof WebAssembly.Module ? wasm : new WebAssembly.Module(wasm);
  const abi = parseFigAbiManifest(module);
  const instance = new WebAssembly.Instance(module, imports);
  return { module, instance, abi };
}

export function parseFigAbiManifest(
  moduleOrBytes: WebAssembly.Module | BufferSource,
): FigAbiManifest {
  const module = moduleOrBytes instanceof WebAssembly.Module
    ? moduleOrBytes
    : new WebAssembly.Module(moduleOrBytes);
  const sections = WebAssembly.Module.customSections(module, "fig.abi.v1");
  if (!sections.length) {
    throw new Error("missing fig.abi.v1 custom section");
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(sections[0]!))) as FigAbiManifest;
}

export function encodeFigValue(
  abi: FigAbiManifest,
  instance: WebAssembly.Instance,
  type: string,
  value: unknown,
): number | bigint {
  const descriptor = valueDescriptor(abi, type);
  if (descriptor.passing === "direct") return encodeDirect(value, descriptor.wat[0] ?? "i32");
  const layout = layoutForValue(abi, descriptor);
  const alloc = instance.exports[abi.helpers.allocObject];
  if (typeof alloc !== "function") throw new Error("missing fig_alloc_object export");
  const ptr = Number(alloc(layout.id, layout.size));
  const view = objectView(instance);
  for (const field of layout.fields) {
    writeField(instance, view, ptr + 16 + field.offset, field, fieldValue(value, field.name));
  }
  return ptr;
}

export function decodeFigValue(
  abi: FigAbiManifest,
  instance: WebAssembly.Instance,
  type: string,
  raw: unknown,
): unknown {
  const descriptor = valueDescriptor(abi, type);
  if (descriptor.passing === "direct") return decodeDirect(raw, descriptor.wat[0] ?? "i32");
  const ptr = Number(raw);
  const layout = layoutForValue(abi, descriptor);
  const view = objectView(instance);
  if (view.getUint32(ptr, true) !== layout.id) {
    throw new Error(`layout id mismatch for ${type}`);
  }
  if (layout.fields.length === 1 && layout.fields[0]?.name === "value") {
    return readField(instance, view, ptr + 16 + layout.fields[0].offset, layout.fields[0]);
  }
  const out: Record<string, unknown> = {};
  for (const field of layout.fields) {
    out[field.name] = readField(instance, view, ptr + 16 + field.offset, field);
  }
  return out;
}

function valueDescriptor(abi: FigAbiManifest, type: string): FigAbiValue {
  for (const fn of [...abi.exports, ...abi.imports]) {
    const found = [...fn.params, ...fn.results].find((item) => item.type === type);
    if (found) return found;
  }
  const layout = abi.layouts.find((item) => item.type === type);
  if (layout) {
    return {
      type,
      passing: layout.kind === "scalar" ? "direct" : "handle",
      wat: layout.fields.map((field) => field.wat),
      ...(layout.kind === "scalar" ? {} : { layoutId: layout.id }),
    };
  }
  return { type, passing: "direct", wat: ["i32"] };
}

function layoutForValue(abi: FigAbiManifest, descriptor: FigAbiValue): FigAbiLayout {
  const layout = abi.layouts.find((item) => item.id === descriptor.layoutId);
  if (!layout) throw new Error(`missing ABI layout for ${descriptor.type}`);
  return layout;
}

function objectView(instance: WebAssembly.Instance): DataView {
  const memory = instance.exports.fig_objects;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("missing fig_objects memory");
  return new DataView(memory.buffer);
}

function bufferMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  const memory = instance.exports.fig_buffers;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("missing fig_buffers memory");
  return memory;
}

function fieldValue(value: unknown, name: string): unknown {
  if (name === "value") return value;
  if (Array.isArray(value) && /^[0-9]+/.test(name)) {
    const index = Number.parseInt(name, 10);
    return value[index];
  }
  if (typeof value === "object" && value !== null && name in value) {
    return (value as Record<string, unknown>)[name];
  }
  return 0;
}

function encodeDirect(value: unknown, wat: string): number | bigint {
  if (wat === "i64") return typeof value === "bigint" ? value : BigInt(Number(value ?? 0));
  return Number(value ?? 0);
}

function decodeDirect(value: unknown, wat: string): unknown {
  if (wat === "i64") return typeof value === "bigint" ? value : BigInt(Number(value ?? 0));
  return Number(value ?? 0);
}

function writeField(
  instance: WebAssembly.Instance,
  view: DataView,
  offset: number,
  field: FigAbiLayout["fields"][number],
  value: unknown,
) {
  if (field.type === "string") {
    view.setInt32(offset, encodeString(instance, value), true);
    return;
  }
  switch (field.wat) {
    case "i64":
      view.setBigInt64(offset, BigInt(value as number | bigint), true);
      return;
    case "f32":
      view.setFloat32(offset, Number(value ?? 0), true);
      return;
    case "f64":
      view.setFloat64(offset, Number(value ?? 0), true);
      return;
    default:
      view.setInt32(offset, Number(value ?? 0), true);
  }
}

function readField(
  instance: WebAssembly.Instance,
  view: DataView,
  offset: number,
  field: FigAbiLayout["fields"][number],
) {
  if (field.type === "string") return decodeString(instance, view.getInt32(offset, true));
  switch (field.wat) {
    case "i64":
      return view.getBigInt64(offset, true);
    case "f32":
      return view.getFloat32(offset, true);
    case "f64":
      return view.getFloat64(offset, true);
    default:
      return view.getInt32(offset, true);
  }
}

function encodeString(instance: WebAssembly.Instance, value: unknown): number {
  const alloc = instance.exports.fig_alloc_buffer;
  if (typeof alloc !== "function") throw new Error("missing fig_alloc_buffer export");
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const ptr = Number(alloc(bytes.length));
  new Uint8Array(bufferMemory(instance).buffer, ptr + 16, bytes.length).set(bytes);
  return ptr;
}

function decodeString(instance: WebAssembly.Instance, ptr: number): string {
  if (ptr === 0) return "";
  const memory = bufferMemory(instance);
  const view = new DataView(memory.buffer);
  const length = view.getUint32(ptr + 4, true);
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr + 16, length));
}
