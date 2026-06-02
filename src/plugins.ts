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

export interface CompilerRewriteRule {
  name: string;
  left: string;
  right: string;
  owner?: string;
  validate?: boolean;
  generic?: {
    contract: string;
    typeParam: string;
  };
}

export interface CompilerContractImplication {
  contract: string;
  implies: readonly string[];
}

export interface CompilerPlugin {
  apiVersion: CompilerPluginApiVersion;
  id: string;
  declarationBuiltins?: readonly CompilerDeclarationBuiltin[];
  staticBuiltins?: readonly CompilerStaticBuiltin[];
  annotationBuiltins?: readonly CompilerAnnotationBuiltin[];
  intrinsics?: readonly CompilerIntrinsicBuiltin[];
  doStrategies?: readonly CompilerDoStrategyBuiltin[];
  rewriteRules?: readonly CompilerRewriteRule[];
  contractImplications?: readonly CompilerContractImplication[];
}

export interface CompilerPluginRegistry {
  plugins: readonly CompilerPlugin[];
  declarationBuiltins: ReadonlyMap<string, CompilerDeclarationBuiltin>;
  staticBuiltins: ReadonlyMap<string, CompilerStaticBuiltin>;
  annotationBuiltins: ReadonlyMap<string, CompilerAnnotationBuiltin>;
  intrinsics: ReadonlyMap<string, CompilerIntrinsicBuiltin>;
  doStrategies: ReadonlyMap<string, CompilerDoStrategyBuiltin>;
  rewriteRules: readonly CompilerRewriteRule[];
  contractImplications: ReadonlyMap<string, readonly string[]>;
  diagnostics: readonly Diagnostic[];
}

export interface CompilerPluginOptions {
  plugins?: readonly CompilerPlugin[];
}

export type CompilerSpecialFormKind =
  | "declaration"
  | "static"
  | "do_strategy"
  | "annotation"
  | "instrumentation"
  | "internal";

export interface CompilerSpecialForm {
  name: string;
  spelling: string;
  kind: CompilerSpecialFormKind;
  sourceFacing: boolean;
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

export const primitiveScalarIntrinsicIds = [
  "i32_add",
  "i32_sub",
  "i32_mul",
  "i32_div",
  "i32_rem",
  "i32_eql",
  "i32_neq",
  "i32_lt",
  "i32_lte",
  "i32_gt",
  "i32_gte",
  "u32_add",
  "u32_sub",
  "u32_mul",
  "u32_div",
  "u32_rem",
  "u32_eql",
  "u32_neq",
  "u32_lt",
  "u32_lte",
  "u32_gt",
  "u32_gte",
  "i64_add",
  "i64_sub",
  "i64_mul",
  "i64_div",
  "i64_rem",
  "i64_eql",
  "i64_neq",
  "i64_lt",
  "i64_lte",
  "i64_gt",
  "i64_gte",
  "u64_add",
  "u64_sub",
  "u64_mul",
  "u64_div",
  "u64_rem",
  "u64_eql",
  "u64_neq",
  "u64_lt",
  "u64_lte",
  "u64_gt",
  "u64_gte",
  "f32_add",
  "f32_sub",
  "f32_mul",
  "f32_div",
  "f32_eql",
  "f32_neq",
  "f32_lt",
  "f32_lte",
  "f32_gt",
  "f32_gte",
  "f64_add",
  "f64_sub",
  "f64_mul",
  "f64_div",
  "f64_eql",
  "f64_neq",
  "f64_lt",
  "f64_lte",
  "f64_gt",
  "f64_gte",
  "bool_and",
  "bool_or",
  "bool_xor",
  "bool_eql",
  "bool_neq",
] as const;

const primitiveScalarIntrinsicIdSet = new Set<string>(primitiveScalarIntrinsicIds);

export function isPrimitiveScalarIntrinsicId(id: string | undefined): boolean {
  return id !== undefined && primitiveScalarIntrinsicIdSet.has(id);
}

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
    ...primitiveScalarIntrinsicIds.map((id) => ({ id })),
  ],
};

export const preludeRewritesPlugin: CompilerPlugin = {
  apiVersion: COMPILER_PLUGIN_API_VERSION,
  id: "prelude-rewrites",
  rewriteRules: [
    {
      name: "Eq::reflexive",
      owner: "Eq",
      validate: false,
      generic: { contract: "Eq", typeParam: "T" },
      left: "\\x -> T::eql(x, x)",
      right: "\\x -> true",
    },
    {
      name: "Functor::map_identity",
      owner: "Functor",
      validate: false,
      generic: { contract: "Functor", typeParam: "T" },
      left: "\\x -> T::map(identity, x)",
      right: "\\x -> x",
    },
    {
      name: "Applicative::apply_pure_identity",
      owner: "Applicative",
      validate: false,
      generic: { contract: "Applicative", typeParam: "T" },
      left: "\\x -> T::apply(T::pure(identity), x)",
      right: "\\x -> x",
    },
    {
      name: "Applicative::apply_pure",
      owner: "Applicative",
      validate: false,
      generic: { contract: "Applicative", typeParam: "T" },
      left: "\\(f, x) -> T::apply(T::pure(f), x)",
      right: "\\(f, x) -> T::map(f, x)",
    },
    {
      name: "Monad::bind_pure_left",
      owner: "Monad",
      validate: false,
      generic: { contract: "Monad", typeParam: "T" },
      left: "\\(x, f) -> T::bind(T::pure(x), f)",
      right: "\\(x, f) -> f(x)",
    },
    {
      name: "Monad::bind_pure_right",
      owner: "Monad",
      validate: false,
      generic: { contract: "Monad", typeParam: "T" },
      left: "\\m -> T::bind(m, T::pure)",
      right: "\\m -> m",
    },
    {
      name: "Monoid::append_empty_left",
      owner: "Monoid",
      validate: false,
      generic: { contract: "Monoid", typeParam: "T" },
      left: "\\x -> T::append(T::empty(), x)",
      right: "\\x -> x",
    },
    {
      name: "Monoid::append_empty_right",
      owner: "Monoid",
      validate: false,
      generic: { contract: "Monoid", typeParam: "T" },
      left: "\\x -> T::append(x, T::empty())",
      right: "\\x -> x",
    },
  ],
  contractImplications: [
    { contract: "Monad", implies: ["Applicative"] },
    { contract: "Applicative", implies: ["Functor"] },
    { contract: "Monoid", implies: ["Semigroup"] },
  ],
};

export const builtinCompilerPlugins = [
  coreImportsPlugin,
  coreStaticPlugin,
  coreAnnotationsPlugin,
  coreIntrinsicsPlugin,
  preludeRewritesPlugin,
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
  const rewriteRules: CompilerRewriteRule[] = [];
  const rewriteRuleNames = new Set<string>();
  const contractImplications = new Map<string, string[]>();

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
    for (const rule of plugin.rewriteRules ?? []) {
      if (rewriteRuleNames.has(rule.name)) {
        diagnostics.push({
          code: "plugin.duplicate_rewrite",
          message: `rewrite rule ${rule.name} is registered more than once`,
        });
      } else {
        rewriteRuleNames.add(rule.name);
        rewriteRules.push(rule);
      }
    }
    for (const implication of plugin.contractImplications ?? []) {
      const existing = contractImplications.get(implication.contract);
      if (existing) {
        for (const implied of implication.implies) {
          if (!existing.includes(implied)) existing.push(implied);
        }
      } else {
        contractImplications.set(implication.contract, [...implication.implies]);
      }
    }
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
    rewriteRules,
    contractImplications,
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

const exactCompilerSpecialForms = [
  { name: "import", kind: "declaration", sourceFacing: true },
  { name: "external", kind: "declaration", sourceFacing: true },
  { name: "io", kind: "do_strategy", sourceFacing: true },
  { name: "monad", kind: "do_strategy", sourceFacing: true },
  { name: "applicative", kind: "do_strategy", sourceFacing: true },
  { name: "likely", kind: "annotation", sourceFacing: true },
  { name: "unlikely", kind: "annotation", sourceFacing: true },
  { name: "trace", kind: "instrumentation", sourceFacing: true },
  { name: "profile", kind: "instrumentation", sourceFacing: true },
  { name: "field", kind: "internal", sourceFacing: false },
  { name: "replace_field", kind: "internal", sourceFacing: false },
  { name: "empty", kind: "internal", sourceFacing: false },
  { name: "index_cursor_next", kind: "internal", sourceFacing: false },
  { name: "heap_array_new", kind: "internal", sourceFacing: false },
  { name: "heap_array_ensure_capacity", kind: "internal", sourceFacing: false },
  { name: "heap_array_get", kind: "internal", sourceFacing: false },
  { name: "heap_array_set", kind: "internal", sourceFacing: false },
  { name: "heap_array_push", kind: "internal", sourceFacing: false },
  { name: "inline_array_builder_start", kind: "internal", sourceFacing: false },
  { name: "inline_array_builder_push", kind: "internal", sourceFacing: false },
  { name: "inline_array_builder_finish", kind: "internal", sourceFacing: false },
  ...coreStaticBuiltinNames.map((name) => ({
    name,
    kind: "static" as const,
    sourceFacing: true,
  })),
] as const satisfies readonly {
  name: string;
  kind: CompilerSpecialFormKind;
  sourceFacing: boolean;
}[];

const compilerSpecialFormsByName = new Map<string, CompilerSpecialForm>();
for (const form of exactCompilerSpecialForms) {
  compilerSpecialFormsByName.set(form.name, {
    ...form,
    spelling: `@${form.name}`,
  });
}

export function compilerSpecialForm(name: string): CompilerSpecialForm | undefined {
  const normalized = name === "$" ? "$" : staticBuiltinName(name);
  return compilerSpecialFormsByName.get(normalized);
}

export function compilerSpecialFormKind(name: string): CompilerSpecialFormKind | undefined {
  return compilerSpecialForm(name)?.kind;
}

export function isCompilerSpecialForm(
  name: string,
  kind?: CompilerSpecialFormKind,
): boolean {
  const form = compilerSpecialForm(name);
  return !!form && (!kind || form.kind === kind);
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
