import type { BranchHint, TypeBody, TypeParamKind } from "./core_ast.ts";
import type { Diagnostic, Span } from "./diagnostics.ts";

export const COMPILER_PLUGIN_API_VERSION = 1;

export type CompilerPluginApiVersion = typeof COMPILER_PLUGIN_API_VERSION;

export type ConstPluginValue =
  & (
    | { kind: "never" }
    | { kind: "bool"; value: boolean }
    | { kind: "number"; value: string }
    | { kind: "string"; value: string }
    | { kind: "literal_type"; value: string }
    | { kind: "type"; name: string; normalized?: TypeBody }
    | { kind: "fn"; name: string }
    | {
      kind: "product";
      constructor: string;
      slots: { label?: string; value: ConstPluginValue }[];
    }
    | { kind: "shape"; slots: { label?: string; value: ConstPluginValue }[] }
  )
  & { type?: string; span?: Span };

export type TypePluginValue =
  & (
    | { kind: "never" }
    | { kind: "bool"; value: boolean }
    | { kind: "number"; value: string }
    | { kind: "char"; value: string }
    | { kind: "string"; value: string }
    | { kind: "literal"; value: string }
    | { kind: "static_builtin"; name: string }
    | { kind: "shape"; slots: { label?: string; value: TypePluginValue; repeat?: string }[] }
    | { kind: "type"; name: string; normalized?: TypeBody }
  )
  & { span?: Span };

export interface PluginDiagnosticContext {
  report(diagnostic: Diagnostic): void;
}

export interface ConstBuiltinContext extends PluginDiagnosticContext {
  addShader(source: string): { id: number; bindings: unknown[]; locations: unknown[] };
}

export interface TypeBuiltinContext extends PluginDiagnosticContext {
  addShader(source: string): { id: number; bindings: unknown[]; locations: unknown[] };
}

export interface CompilerStaticBuiltin {
  name: string;
  paramKind?: (index: number) => TypeParamKind | undefined;
  evaluateConst?: (
    args: ConstPluginValue[],
    context: ConstBuiltinContext,
  ) => ConstPluginValue | undefined;
  evaluateType?: (
    args: TypePluginValue[],
    context: TypeBuiltinContext,
  ) => TypePluginValue | undefined;
}

export interface CompilerDeclarationBuiltin {
  name: string;
}

export interface CompilerAnnotationBuiltin {
  name: string;
  branchHint?: BranchHint;
}

export interface CompilerIntrinsicBuiltin {
  id: string;
}

export interface CompilerDoStrategyBuiltin {
  name: string;
}

export interface CompilerPlugin {
  apiVersion: CompilerPluginApiVersion;
  id: string;
  declarationBuiltins?: readonly CompilerDeclarationBuiltin[];
  staticBuiltins?: readonly CompilerStaticBuiltin[];
  annotationBuiltins?: readonly CompilerAnnotationBuiltin[];
  intrinsics?: readonly CompilerIntrinsicBuiltin[];
  doStrategies?: readonly CompilerDoStrategyBuiltin[];
}

export interface CompilerPluginRegistry {
  plugins: readonly CompilerPlugin[];
  declarationBuiltins: ReadonlyMap<string, CompilerDeclarationBuiltin>;
  staticBuiltins: ReadonlyMap<string, CompilerStaticBuiltin>;
  annotationBuiltins: ReadonlyMap<string, CompilerAnnotationBuiltin>;
  intrinsics: ReadonlyMap<string, CompilerIntrinsicBuiltin>;
  doStrategies: ReadonlyMap<string, CompilerDoStrategyBuiltin>;
  diagnostics: readonly Diagnostic[];
}

export interface CompilerPluginOptions {
  plugins?: readonly CompilerPlugin[];
}

const shapeFirstArg = new Set([
  "shape_map",
  "shape_concat",
  "shape_has_slot",
  "shape_slot",
  "shape_count",
  "shape_first_key",
  "shape_tail",
  "shape_pick",
  "shape_omit",
  "shape_intersect",
  "shape_difference",
  "shape_rename",
  "shape_map_with_key",
  "shape_filter",
]);

const typeListBuiltinNames = new Set([
  "type_list_contains",
  "type_list_contains_all",
  "type_list_index",
  "type_list_append",
  "type_list_remove",
  "type_list_unique",
  "type_list_is_unique",
]);

function coreStaticParamKind(name: string, index: number): TypeParamKind | undefined {
  if (typeListBuiltinNames.has(name)) return "const";
  if (shapeFirstArg.has(name) && index === 0) return "const";
  if (name === "shape_map" && index === 1) return "type fn(_: const) -> type";
  if ((name === "shape_map_with_key" || name === "shape_filter") && index === 1) {
    return "type fn(_: const, _: const) -> type";
  }
  if (
    (name === "shape_pick" || name === "shape_omit" || name === "shape_intersect" ||
      name === "shape_difference" || name === "shape_rename") && index === 1
  ) return "const";
  if (name === "shape_concat") return "const";
  if (
    (name === "type_slots" || name === "type_slot_count" || name === "type_variant_slots" ||
      name === "type_variants" || name === "type_members" || name === "type_member_target" ||
      name === "type_layout" ||
      name === "type_storage_kind" || name === "type_flat_slot_count" ||
      name === "type_flat_slots" || name === "type_size_bits" || name === "type_align_bits" ||
      name === "type_is_inline_array" || name === "type_inline_array_len" ||
      name === "type_inline_array_item" || name === "type_is_fn" || name === "type_fn_params" ||
      name === "type_fn_return" || name === "type_fn_param_count" ||
      name === "type_is_scalar" || name === "type_scalar_carrier" ||
      name === "type_scalar_min" || name === "type_scalar_max" ||
      name === "type_scalar_bit_width" || name === "type_scalar_signed" ||
      name === "type_scalar_domain" || name === "type_is_refined_scalar" ||
      name === "type_variant_count" || name === "type_variant_tag_type" ||
      name === "type_variant_payload_type" ||
      name === "type_has_niche" || name === "type_niche_value") && index === 0
  ) return "type";
  if (
    (name === "wgsl_shader_id" || name === "wgsl_bindings" || name === "wgsl_locations") &&
    index === 0
  ) return "string";
  return undefined;
}

const coreStaticBuiltinNames = [
  "compile_error",
  "type_is_product",
  "type_is_sum",
  "type_is_alias",
  "type_is_number",
  "type_has_slot",
  "type_slot_type",
  "type_has_member",
  "type_member_type",
  "type_members",
  "type_member_target",
  "type_is_fn",
  "type_fn_params",
  "type_fn_return",
  "type_fn_param_count",
  "type_is_scalar",
  "type_scalar_carrier",
  "type_scalar_min",
  "type_scalar_max",
  "type_scalar_bit_width",
  "type_scalar_signed",
  "type_scalar_domain",
  "type_is_refined_scalar",
  "type_layout",
  "type_storage_kind",
  "type_flat_slot_count",
  "type_flat_slots",
  "type_size_bits",
  "type_align_bits",
  "type_is_inline_array",
  "type_inline_array_len",
  "type_inline_array_item",
  "type_has_variant",
  "type_variant_has_slot",
  "type_variant_count",
  "type_variant_tag_type",
  "type_variant_payload_type",
  "type_has_niche",
  "type_niche_value",
  "type_list_contains",
  "type_list_contains_all",
  "type_list_index",
  "type_list_append",
  "type_list_remove",
  "type_list_unique",
  "type_list_is_unique",
  "type_slots",
  "type_slot_count",
  "type_variant_slots",
  "type_variants",
  "require",
  "wgsl_shader_id",
  "wgsl_bindings",
  "wgsl_locations",
  "shape_map",
  "shape_concat",
  "shape_has_slot",
  "shape_slot",
  "shape_count",
  "shape_first_key",
  "shape_tail",
  "shape_pick",
  "shape_omit",
  "shape_intersect",
  "shape_difference",
  "shape_rename",
  "shape_map_with_key",
  "shape_filter",
] as const;

export const coreImportsPlugin: CompilerPlugin = {
  apiVersion: COMPILER_PLUGIN_API_VERSION,
  id: "core-imports",
  declarationBuiltins: [{ name: "import" }, { name: "external" }],
};

export const coreStaticPlugin: CompilerPlugin = {
  apiVersion: COMPILER_PLUGIN_API_VERSION,
  id: "core-static",
  staticBuiltins: coreStaticBuiltinNames.map((name) => ({
    name,
    paramKind: (index: number) => coreStaticParamKind(name, index),
  })),
};

export const coreAnnotationsPlugin: CompilerPlugin = {
  apiVersion: COMPILER_PLUGIN_API_VERSION,
  id: "core-annotations",
  annotationBuiltins: [
    { name: "likely", branchHint: "likely" },
    { name: "unlikely", branchHint: "unlikely" },
  ],
};

export const coreIntrinsicsPlugin: CompilerPlugin = {
  apiVersion: COMPILER_PLUGIN_API_VERSION,
  id: "core-intrinsics",
  intrinsics: [
    { id: "branch_handle" },
    { id: "branch_handle_ptr" },
    { id: "branch_mark" },
    { id: "branch_is_branched" },
    { id: "branch_ensure_editable" },
    { id: "branch_materialize" },
    { id: "index_cursor_next" },
    { id: "heap_array_new" },
    { id: "heap_array_ensure_capacity" },
    { id: "heap_array_get" },
    { id: "heap_array_set" },
    { id: "heap_array_push" },
    { id: "inline_array_builder_start" },
    { id: "inline_array_builder_push" },
    { id: "inline_array_builder_finish" },
  ],
};

export const builtinCompilerPlugins = [
  coreImportsPlugin,
  coreStaticPlugin,
  coreAnnotationsPlugin,
  coreIntrinsicsPlugin,
] as const;

export function createCompilerPluginRegistry(
  plugins: readonly CompilerPlugin[] = [],
): CompilerPluginRegistry {
  const allPlugins = [...builtinCompilerPlugins, ...plugins];
  const diagnostics: Diagnostic[] = [];
  const pluginIds = new Set<string>();
  const declarationBuiltins = new Map<string, CompilerDeclarationBuiltin>();
  const staticBuiltins = new Map<string, CompilerStaticBuiltin>();
  const annotationBuiltins = new Map<string, CompilerAnnotationBuiltin>();
  const intrinsics = new Map<string, CompilerIntrinsicBuiltin>();
  const doStrategies = new Map<string, CompilerDoStrategyBuiltin>();

  for (const plugin of allPlugins) {
    if (plugin.apiVersion !== COMPILER_PLUGIN_API_VERSION) {
      diagnostics.push({
        code: "plugin.api_version",
        message:
          `compiler plugin ${plugin.id} targets API ${plugin.apiVersion}; expected ${COMPILER_PLUGIN_API_VERSION}`,
      });
    }
    if (pluginIds.has(plugin.id)) {
      diagnostics.push({
        code: "plugin.duplicate",
        message: `compiler plugin ${plugin.id} is registered more than once`,
      });
    }
    pluginIds.add(plugin.id);
    addNamed(plugin, "declaration builtin", plugin.declarationBuiltins, declarationBuiltins);
    addNamed(plugin, "static builtin", plugin.staticBuiltins, staticBuiltins);
    addNamed(plugin, "annotation builtin", plugin.annotationBuiltins, annotationBuiltins);
    addNamed(plugin, "do strategy", plugin.doStrategies, doStrategies);
    for (const intrinsic of plugin.intrinsics ?? []) {
      const previous = intrinsics.get(intrinsic.id);
      if (previous) {
        diagnostics.push({
          code: "plugin.duplicate_builtin",
          message: `compiler intrinsic ${intrinsic.id} is registered more than once`,
        });
      } else {
        intrinsics.set(intrinsic.id, intrinsic);
      }
    }
  }

  return {
    plugins: allPlugins,
    declarationBuiltins,
    staticBuiltins,
    annotationBuiltins,
    intrinsics,
    doStrategies,
    diagnostics,
  };

  function addNamed<T extends { name: string }>(
    plugin: CompilerPlugin,
    label: string,
    items: readonly T[] | undefined,
    target: Map<string, T>,
  ) {
    for (const item of items ?? []) {
      const previous = target.get(item.name);
      if (previous) {
        diagnostics.push({
          code: "plugin.duplicate_builtin",
          message: `${label} @${item.name} is registered more than once`,
        });
      } else {
        target.set(item.name, item);
      }
    }
  }
}

export const defaultCompilerPluginRegistry = createCompilerPluginRegistry();

export function staticBuiltinName(name: string): string {
  return name.startsWith("@") ? name.slice(1) : name;
}

export function isStaticBuiltinName(
  name: string,
  registry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
): boolean {
  return registry.staticBuiltins.has(staticBuiltinName(name));
}

export function staticBuiltinParamKind(
  name: string | undefined,
  index: number,
  registry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
): TypeParamKind | undefined {
  return name
    ? registry.staticBuiltins.get(staticBuiltinName(name))?.paramKind?.(index)
    : undefined;
}

export function isKnownIntrinsicId(
  id: string,
  registry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
): boolean {
  return registry.intrinsics.has(id);
}

export function annotationBranchHint(
  name: string,
  registry: CompilerPluginRegistry = defaultCompilerPluginRegistry,
): BranchHint | undefined {
  return registry.annotationBuiltins.get(staticBuiltinName(name))?.branchHint;
}
