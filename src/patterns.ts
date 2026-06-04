import type { ParamPattern } from "./core_ast.ts";

export function isCatchAllPattern(pattern: ParamPattern | undefined): boolean {
  if (!pattern) return true;
  if (pattern.kind === "typed") return false;
  if (pattern.kind === "as") return isCatchAllPattern(pattern.pattern);
  if (pattern.kind === "or") return pattern.alternatives.some(isCatchAllPattern);
  return pattern.kind === "binding" || pattern.kind === "wildcard";
}

export function patternBindingNames(pattern: ParamPattern | undefined): string[] {
  if (!pattern) return [];
  switch (pattern.kind) {
    case "binding":
      return [pattern.name];
    case "tuple":
      return pattern.items.flatMap(patternBindingNames);
    case "constructor":
      return pattern.args.flatMap(patternBindingNames);
    case "or":
      return pattern.alternatives[0] ? patternBindingNames(pattern.alternatives[0]) : [];
    case "as":
      return [pattern.name, ...patternBindingNames(pattern.pattern)];
    case "product":
      return pattern.fields.flatMap((field) => patternBindingNames(field.pattern));
    case "typed":
      return patternBindingNames(pattern.pattern);
    case "wildcard":
    case "literal":
    case "enum_member":
    case "type":
      return [];
  }
}

export function patternBindsName(pattern: ParamPattern | undefined, name: string): boolean {
  return patternBindingNames(pattern).includes(name);
}

export function patternDemandsMatchedValue(pattern: ParamPattern | undefined): boolean {
  if (!pattern) return false;
  switch (pattern.kind) {
    case "literal":
    case "enum_member":
    case "type":
      return true;
    case "tuple":
      return pattern.items.some(patternDemandsMatchedValue);
    case "constructor":
      return pattern.args.some(patternDemandsMatchedValue);
    case "or":
      return pattern.alternatives.some(patternDemandsMatchedValue);
    case "as":
      return patternDemandsMatchedValue(pattern.pattern);
    case "product":
      return true;
    case "typed":
      return true;
    case "binding":
    case "wildcard":
      return false;
  }
}
