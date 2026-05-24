import type { FigAbiLayout, FigAbiManifest, FigAbiValue } from "./backend.ts";

export interface FigInstance {
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
  abi: FigAbiManifest;
}

export interface FigHost {
  call(name: string, ...args: unknown[]): unknown;
  encode(type: string, value: unknown): number | bigint;
  decode(type: string, raw: unknown): unknown;
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
  const section = firstCustomSection(module, "fig.abi");
  if (!section) {
    throw new Error("missing fig.abi custom section");
  }
  const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(section))) as unknown;
  return validateFigAbiManifest(parsed);
}

export function createFigHost(abi: FigAbiManifest, instance: WebAssembly.Instance): FigHost {
  return {
    call(name, ...args) {
      const fn = abi.exports.find((item) => item.name === name);
      if (!fn) throw new Error(`missing Fig export ${name}`);
      if (args.length !== fn.params.length) {
        throw new Error(
          `Fig export ${name} expects ${fn.params.length} arguments, got ${args.length}`,
        );
      }
      const callable = instance.exports[name];
      if (typeof callable !== "function") throw new Error(`missing Wasm export ${name}`);
      const rawArgs = fn.params.map((param, index) =>
        encodeFigValue(abi, instance, param.type, args[index])
      );
      const raw = (callable as CallableFunction)(...rawArgs);
      if (fn.results.length === 0) return undefined;
      if (fn.results.length === 1) return decodeFigValue(abi, instance, fn.results[0]!.type, raw);
      if (!Array.isArray(raw)) {
        throw new Error(`Fig export ${name} returned multiple values in an unsupported host shape`);
      }
      return fn.results.map((result, index) =>
        decodeFigValue(abi, instance, result.type, raw[index])
      );
    },
    encode: (type, value) => encodeFigValue(abi, instance, type, value),
    decode: (type, raw) => decodeFigValue(abi, instance, type, raw),
  };
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
  if (layout.kind === "sum") return encodeSumValue(abi, instance, layout, value);
  if (layout.kind === "heap_array" && Array.isArray(value)) {
    return encodeHeapArrayValue(abi, instance, layout, value);
  }
  const alloc = instance.exports[abi.helpers.allocObject];
  if (typeof alloc !== "function") throw new Error("missing fig_alloc_object export");
  const ptr = Number(alloc(layout.id, layout.size));
  const view = objectView(instance);
  assertWritableHandle(view, ptr, layout.size, type);
  for (const field of layout.fields) {
    writeField(instance, view, ptr + 16 + field.offset, field, fieldValue(value, field, layout));
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
  assertReadableHandle(view, ptr, layout, type);
  if (view.getUint32(ptr, true) !== layout.id) {
    throw new Error(`layout id mismatch for ${type}`);
  }
  if (layout.kind === "sum") return decodeSumValue(instance, view, ptr, layout);
  if (layout.kind === "heap_array") return decodeHeapArrayValue(instance, view, ptr, layout);
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
      passing: layout.passing ?? (layout.kind === "scalar" ? "direct" : "handle"),
      wat: layout.fields.map((field) => field.wat),
      ...((layout.passing ?? (layout.kind === "scalar" ? "direct" : "handle")) === "handle"
        ? { layoutId: layout.id }
        : {}),
    };
  }
  return { type, passing: "direct", wat: ["i32"] };
}

function layoutForValue(abi: FigAbiManifest, descriptor: FigAbiValue): FigAbiLayout {
  const layout = abi.layouts.find((item) => item.id === descriptor.layoutId);
  if (!layout) throw new Error(`missing ABI layout for ${descriptor.type}`);
  return layout;
}

function firstCustomSection(module: WebAssembly.Module, name: string): ArrayBuffer | undefined {
  return WebAssembly.Module.customSections(module, name)[0];
}

function validateFigAbiManifest(value: unknown): FigAbiManifest {
  if (!isRecord(value)) throw new Error("invalid Fig ABI manifest: expected object");
  const version = value.version;
  if (version !== 1) throw new Error("invalid Fig ABI manifest: unsupported version");
  if (value.name !== "fig.memory") throw new Error("invalid Fig ABI manifest: expected fig.memory");
  if (
    value.target !== "wasm32-core-3-browser" || value.pointer !== "i32" || value.endian !== "little"
  ) {
    throw new Error("invalid Fig ABI manifest: unsupported target");
  }
  if (
    !isRecord(value.helpers) || typeof value.helpers.allocObject !== "string" ||
    typeof value.helpers.allocBuffer !== "string"
  ) {
    throw new Error("invalid Fig ABI manifest: missing helpers");
  }
  if (
    !Array.isArray(value.memories) || !Array.isArray(value.exports) ||
    !Array.isArray(value.imports) || !Array.isArray(value.layouts)
  ) {
    throw new Error("invalid Fig ABI manifest: missing arrays");
  }
  validateObjectHeader(value.objectHeader);
  const layoutIds = new Set<number>();
  for (const layout of value.layouts) {
    validateLayout(layout);
    if (layoutIds.has(layout.id)) {
      throw new Error(`invalid Fig ABI manifest: duplicate layout id ${layout.id}`);
    }
    layoutIds.add(layout.id);
  }
  for (const fn of [...value.exports, ...value.imports]) validateAbiFunction(fn, layoutIds);
  return value as unknown as FigAbiManifest;
}

function validateObjectHeader(value: unknown) {
  if (!isRecord(value) || value.byteSize !== 16 || !Array.isArray(value.fields)) {
    throw new Error("invalid Fig ABI manifest: invalid object header");
  }
}

function validateLayout(value: unknown): asserts value is FigAbiLayout {
  if (!isRecord(value)) throw new Error("invalid Fig ABI manifest: invalid layout");
  if (!Number.isInteger(value.id) || typeof value.type !== "string") {
    throw new Error("invalid Fig ABI manifest: invalid layout identity");
  }
  if (!["scalar", "record", "sum", "heap_array"].includes(String(value.kind))) {
    throw new Error(`invalid Fig ABI manifest: invalid layout kind for ${value.type}`);
  }
  const size = value.size;
  const align = value.align;
  if (
    !Number.isInteger(size) || typeof size !== "number" || size < 0 ||
    !Number.isInteger(align) || typeof align !== "number" || align <= 0
  ) {
    throw new Error(`invalid Fig ABI manifest: invalid layout size for ${value.type}`);
  }
  if (!Array.isArray(value.fields)) {
    throw new Error(`invalid Fig ABI manifest: missing fields for ${value.type}`);
  }
  const end = size;
  for (const field of value.fields) {
    if (!isRecord(field) || typeof field.name !== "string" || typeof field.type !== "string") {
      throw new Error(`invalid Fig ABI manifest: invalid field for ${value.type}`);
    }
    if (!["i32", "i64", "f32", "f64"].includes(String(field.wat))) {
      throw new Error(`invalid Fig ABI manifest: invalid field wasm type for ${value.type}`);
    }
    const offset = field.offset;
    const fieldSize = field.size;
    if (
      !Number.isInteger(offset) || typeof offset !== "number" || offset < 0 ||
      !Number.isInteger(fieldSize) || typeof fieldSize !== "number" || fieldSize <= 0
    ) {
      throw new Error(`invalid Fig ABI manifest: invalid field range for ${value.type}`);
    }
    if (offset + fieldSize > end) {
      throw new Error(`invalid Fig ABI manifest: field exceeds layout size for ${value.type}`);
    }
  }
}

function validateAbiFunction(value: unknown, layoutIds: Set<number>) {
  if (
    !isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.params) ||
    !Array.isArray(value.results)
  ) {
    throw new Error("invalid Fig ABI manifest: invalid function");
  }
  for (const item of [...value.params, ...value.results]) {
    if (!isRecord(item) || typeof item.type !== "string" || !Array.isArray(item.wat)) {
      throw new Error(`invalid Fig ABI manifest: invalid value descriptor for ${value.name}`);
    }
    if (item.passing !== "direct" && item.passing !== "handle") {
      throw new Error(`invalid Fig ABI manifest: invalid passing mode for ${value.name}`);
    }
    const layoutId = item.layoutId;
    if (
      item.passing === "handle" &&
      (!Number.isInteger(layoutId) || typeof layoutId !== "number" || !layoutIds.has(layoutId))
    ) {
      throw new Error(`invalid Fig ABI manifest: missing handle layout for ${value.name}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function objectView(instance: WebAssembly.Instance): DataView {
  const memory = instance.exports.fig_objects;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("missing fig_objects memory");
  return new DataView(memory.buffer);
}

function allocObject(
  instance: WebAssembly.Instance,
  abi: FigAbiManifest,
  layoutId: number,
  payloadBytes: number,
): number {
  const alloc = instance.exports[abi.helpers.allocObject];
  if (typeof alloc !== "function") throw new Error("missing fig_alloc_object export");
  return Number(alloc(layoutId, payloadBytes));
}

function bufferMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  const memory = instance.exports.fig_buffers;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("missing fig_buffers memory");
  return memory;
}

function assertReadableHandle(
  view: DataView,
  ptr: number,
  layout: FigAbiLayout,
  type: string,
) {
  assertPointer(ptr, type);
  assertRange(view, ptr, 16, type);
  const payloadBytes = view.getUint32(ptr + 4, true);
  if (payloadBytes < layout.size) {
    throw new Error(
      `short ABI payload for ${type}: expected ${layout.size} bytes, got ${payloadBytes}`,
    );
  }
  assertRange(view, ptr + 16, payloadBytes, type);
}

function assertWritableHandle(view: DataView, ptr: number, payloadBytes: number, type: string) {
  assertPointer(ptr, type);
  assertRange(view, ptr, 16 + payloadBytes, type);
}

function assertPointer(ptr: number, type: string) {
  if (!Number.isInteger(ptr) || ptr <= 0 || ptr % 4 !== 0) {
    throw new Error(`invalid ABI handle for ${type}: ${ptr}`);
  }
}

function assertRange(view: DataView, offset: number, size: number, type: string) {
  if (
    !Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0 ||
    offset + size > view.byteLength
  ) {
    throw new Error(`ABI handle out of bounds for ${type}`);
  }
}

function fieldValue(
  value: unknown,
  field: FigAbiLayout["fields"][number],
  layout: FigAbiLayout,
): unknown {
  const name = field.name;
  if (name === "value") return value;
  if (Array.isArray(value) && /^[0-9]+$/.test(name)) {
    const index = Number.parseInt(name, 10);
    if (index in value) return value[index];
    throw new Error(`missing ABI array field ${name} for ${layout.type}`);
  }
  if (typeof value === "object" && value !== null && name in value) {
    return (value as Record<string, unknown>)[name];
  }
  throw new Error(`missing ABI field ${name} for ${layout.type}`);
}

function encodeSumValue(
  abi: FigAbiManifest,
  instance: WebAssembly.Instance,
  layout: FigAbiLayout,
  value: unknown,
): number {
  if (!Array.isArray(layout.variants) || !layout.variants.length) {
    throw new Error(`unsupported ABI sum layout ${layout.type}`);
  }
  if (!isRecord(value) || typeof value.variant !== "string") {
    throw new Error(`sum ${layout.type} requires { variant: string, ... }`);
  }
  const variant = layout.variants.find((item) => item.name === value.variant);
  if (!variant) throw new Error(`unknown variant ${String(value.variant)} for ${layout.type}`);
  const ptr = allocObject(instance, abi, layout.id, layout.size);
  const view = objectView(instance);
  assertWritableHandle(view, ptr, layout.size, layout.type);
  if (!layout.fields.length) return ptr;
  if (!variant.fields.length) {
    writeZeroFields(instance, view, ptr, layout);
    return ptr;
  }
  if (variant.fields.length !== layout.fields.length) {
    throw new Error(
      `unsupported ABI sum layout ${layout.type}: variant payload does not match runtime layout`,
    );
  }
  for (let index = 0; index < layout.fields.length; index++) {
    const field = layout.fields[index]!;
    const variantField = variant.fields[index]!;
    writeField(
      instance,
      view,
      ptr + 16 + field.offset,
      field,
      variantFieldValue(value, variantField, layout),
    );
  }
  return ptr;
}

function decodeSumValue(
  instance: WebAssembly.Instance,
  view: DataView,
  ptr: number,
  layout: FigAbiLayout,
): unknown {
  if (!Array.isArray(layout.variants) || !layout.variants.length) {
    throw new Error(`unsupported ABI sum layout ${layout.type}`);
  }
  const empty = layout.variants.find((variant) => variant.fields.length === 0);
  const payloadVariants = layout.variants.filter((variant) => variant.fields.length > 0);
  if (layout.fields.length === 1 && empty && payloadVariants.length === 1) {
    const field = layout.fields[0]!;
    const raw = readField(instance, view, ptr + 16 + field.offset, field);
    if (raw === 0) return { variant: empty.name };
    const variant = payloadVariants[0]!;
    return { variant: variant.name, [variant.fields[0]?.name ?? "value"]: raw };
  }
  if (payloadVariants.length === 1 && payloadVariants[0]!.fields.length === layout.fields.length) {
    const variant = payloadVariants[0]!;
    const out: Record<string, unknown> = { variant: variant.name };
    for (let index = 0; index < layout.fields.length; index++) {
      const field = layout.fields[index]!;
      const variantField = variant.fields[index]!;
      out[variantField.name] = readField(instance, view, ptr + 16 + field.offset, field);
    }
    return out;
  }
  throw new Error(`unsupported ABI sum layout ${layout.type}: cannot recover variant tag`);
}

function writeZeroFields(
  instance: WebAssembly.Instance,
  view: DataView,
  ptr: number,
  layout: FigAbiLayout,
) {
  for (const field of layout.fields) writeField(instance, view, ptr + 16 + field.offset, field, 0);
}

function variantFieldValue(
  value: Record<string, unknown>,
  field: FigAbiLayout["fields"][number],
  layout: FigAbiLayout,
): unknown {
  if (field.name in value) return value[field.name];
  throw new Error(`missing ABI field ${field.name} for ${layout.type}.${String(value.variant)}`);
}

function encodeHeapArrayValue(
  abi: FigAbiManifest,
  instance: WebAssembly.Instance,
  layout: FigAbiLayout,
  value: unknown[],
): number {
  if (!layout.item) throw new Error(`missing heap array item metadata for ${layout.type}`);
  const byteLength = value.length * layout.item.stride;
  const backingPtr = byteLength === 0 ? 0 : allocObject(instance, abi, 0, byteLength);
  const dataPtr = backingPtr === 0 ? 0 : backingPtr + 16;
  if (byteLength > 0) {
    const view = objectView(instance);
    assertRange(view, dataPtr, byteLength, layout.type);
    value.forEach((item, index) =>
      writeHeapArrayItem(instance, view, dataPtr + index * layout.item!.stride, layout, item, index)
    );
  }
  const ptr = allocObject(instance, abi, layout.id, layout.size);
  const view = objectView(instance);
  assertWritableHandle(view, ptr, layout.size, layout.type);
  const descriptor: Record<string, unknown> = {
    ptr: dataPtr,
    len: value.length,
    cap: value.length,
  };
  for (const field of layout.fields) {
    writeField(
      instance,
      view,
      ptr + 16 + field.offset,
      field,
      fieldValue(descriptor, field, layout),
    );
  }
  return ptr;
}

function decodeHeapArrayValue(
  instance: WebAssembly.Instance,
  view: DataView,
  ptr: number,
  layout: FigAbiLayout,
): unknown[] {
  if (!layout.item) throw new Error(`missing heap array item metadata for ${layout.type}`);
  const descriptor: Record<string, number> = {};
  for (const field of layout.fields) {
    descriptor[field.name] = Number(readField(instance, view, ptr + 16 + field.offset, field));
  }
  const dataPtr = descriptor.ptr ?? 0;
  const len = descriptor.len ?? 0;
  const cap = descriptor.cap ?? 0;
  if (!Number.isInteger(len) || len < 0 || !Number.isInteger(cap) || cap < len) {
    throw new Error(`invalid heap array descriptor for ${layout.type}`);
  }
  if (len === 0) return [];
  assertRange(view, dataPtr, len * layout.item.stride, layout.type);
  return Array.from(
    { length: len },
    (_item, index) =>
      readHeapArrayItem(instance, view, dataPtr + index * layout.item!.stride, layout),
  );
}

function writeHeapArrayItem(
  instance: WebAssembly.Instance,
  view: DataView,
  offset: number,
  layout: FigAbiLayout,
  value: unknown,
  index: number,
) {
  if (!layout.item) throw new Error(`missing heap array item metadata for ${layout.type}`);
  for (const field of layout.item.fields) {
    writeField(
      instance,
      view,
      offset + field.offset,
      field,
      fieldValue(value, field, { ...layout, type: `${layout.type}[${index}]` }),
    );
  }
}

function readHeapArrayItem(
  instance: WebAssembly.Instance,
  view: DataView,
  offset: number,
  layout: FigAbiLayout,
): unknown {
  if (!layout.item) throw new Error(`missing heap array item metadata for ${layout.type}`);
  if (layout.item.fields.length === 1 && layout.item.fields[0]?.name === "value") {
    const field = layout.item.fields[0];
    return readField(instance, view, offset + field.offset, field);
  }
  const out: Record<string, unknown> = {};
  for (const field of layout.item.fields) {
    out[field.name] = readField(instance, view, offset + field.offset, field);
  }
  return out;
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
  const memory = bufferMemory(instance);
  assertWritableHandle(new DataView(memory.buffer), ptr, bytes.length, "string");
  new Uint8Array(memory.buffer, ptr + 16, bytes.length).set(bytes);
  return ptr;
}

function decodeString(instance: WebAssembly.Instance, ptr: number): string {
  if (ptr === 0) return "";
  const memory = bufferMemory(instance);
  const view = new DataView(memory.buffer);
  assertPointer(ptr, "string");
  assertRange(view, ptr, 16, "string");
  const length = view.getUint32(ptr + 4, true);
  assertRange(view, ptr + 16, length, "string");
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr + 16, length));
}
