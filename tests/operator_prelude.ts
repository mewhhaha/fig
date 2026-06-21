import type {
  CompileSourceOptions,
  ModuleResolveContext,
  ModuleSource,
} from "../src/mod.ts";

export const OPERATOR_PRELUDE_IMPORT = 'const __ops = @import("prelude.operators");\n';

const OPERATOR_TOKENS =
  /(?:[A-Za-z0-9_\]\)]|true|false)\s+(?:\+|-|\*|\/|%|==|!=|<=|>=|<|>|&&|\|\||\^\^|<>|<\|>|<\*>|<\*|\*>|<\*\*>|<\$>|<&>|>>=|=<<|>=>|<=<)\s+(?:[A-Za-z0-9_({[]|true|false|-)/;

export const resolveProjectModule = async (moduleName: string) => {
  try {
    return await Deno.readTextFile(`${moduleName.replaceAll(".", "/")}.fig`);
  } catch {
    return undefined;
  }
};

export function sourceHasOperatorPrelude(source: string): boolean {
  return /@import\(\s*"prelude\.(?:operators|std)"\s*\)/.test(source);
}

export function sourceDeclaresOperators(source: string): boolean {
  return /\binfix[lr]?\s+\d+\s+\(/.test(source);
}

export function sourceNeedsOperatorPrelude(source: string): boolean {
  return OPERATOR_TOKENS.test(source) &&
    !sourceHasOperatorPrelude(source) &&
    !sourceDeclaresOperators(source);
}

export function withOperatorPrelude<T extends CompileSourceOptions>(
  source: string,
  options: T = {} as T,
): { source: string; options: T } {
  const optionsWithResolver = options.resolveModule
    ? resolveWithOperatorPrelude(options)
    : options;
  if (!sourceNeedsOperatorPrelude(source)) {
    return { source, options: optionsWithResolver };
  }
  return {
    source: `${OPERATOR_PRELUDE_IMPORT}${source}`,
    options: resolveWithOperatorPrelude(optionsWithResolver),
  };
}

export function resolveWithOperatorPrelude<T extends CompileSourceOptions>(
  options: T = {} as T,
): T {
  const resolveModule = options.resolveModule ?? resolveProjectModule;
  return {
    ...options,
    async resolveModule(moduleName: string, context?: ModuleResolveContext) {
      if (moduleName === "prelude.operators") {
        return await resolveProjectModule(moduleName);
      }
      const resolved = await resolveModule(moduleName, context);
      if (typeof resolved === "string") {
        return withOperatorPrelude(resolved).source;
      }
      if (resolved && typeof resolved === "object" && "text" in resolved) {
        return withOperatorModuleSource(resolved);
      }
      return resolved;
    },
  };
}

function withOperatorModuleSource(source: ModuleSource): ModuleSource {
  return {
    ...source,
    text: withOperatorPrelude(source.text).source,
  };
}
