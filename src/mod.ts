import { parse } from "./parser.ts";
import { checkProgram } from "./check.ts";
import { type BackendOptions, emitWasm, emitWat } from "./backend.ts";
import type {
  ConstDecl,
  Declaration,
  Expr,
  FnDecl,
  LetDecl,
  ParamPattern,
  Program,
  ShapeType,
  SourceImport,
  TypeBlock,
  TypeCountExpr,
  TypeDecl,
  TypeExpr,
  TypeMemberExpr,
  TypePattern,
  TypeShape,
} from "./core_ast.ts";
import { CompileError, type Diagnostic } from "./diagnostics.ts";

export interface CheckSourceOptions {
  resolveModule?: (moduleName: string) => string | undefined | Promise<string | undefined>;
}

export interface CompileSourceOptions extends CheckSourceOptions, BackendOptions {}

export async function checkSource(source: string, options: CheckSourceOptions = {}) {
  const program = await parse(source);
  if (!options.resolveModule) return checkProgram(program);
  return checkProgram(
    await resolveSourceImports(program, { resolveModule: options.resolveModule }),
  );
}

export async function watFromSource(
  source: string,
  options: CompileSourceOptions = {},
): Promise<string> {
  return emitWat((await checkSource(source, options)).program, options);
}

export async function wasmFromSource(
  source: string,
  options: CompileSourceOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  return emitWasm((await checkSource(source, options)).program, options);
}

export { parse } from "./parser.ts";
export { tokenize } from "./tokenize.ts";
export { optimizeProgram } from "./optimize.ts";
export { CompileError, formatDiagnostic } from "./diagnostics.ts";

async function resolveSourceImports(
  root: Program,
  options: Required<Pick<CheckSourceOptions, "resolveModule">>,
): Promise<Program> {
  const diagnostics: Diagnostic[] = [];
  const visiting: string[] = [];
  const resolved = new Map<string, Program>();

  async function load(moduleName: string): Promise<Program | undefined> {
    if (resolved.has(moduleName)) return resolved.get(moduleName);
    const cycleStart = visiting.indexOf(moduleName);
    if (cycleStart >= 0) {
      diagnostics.push({
        code: "module.cycle",
        message: `source import cycle: ${[...visiting.slice(cycleStart), moduleName].join(" -> ")}`,
      });
      return undefined;
    }
    visiting.push(moduleName);
    const source = await options.resolveModule(moduleName);
    if (source === undefined) {
      diagnostics.push({
        code: "module.not_found",
        message: `cannot resolve module ${moduleName}`,
      });
      visiting.pop();
      return undefined;
    }
    const parsed = await parse(source);
    const merged = await mergeImports(parsed);
    resolved.set(moduleName, merged);
    visiting.pop();
    return merged;
  }

  async function mergeImports(program: Program): Promise<Program> {
    const importedPrograms: Program[] = [];
    const aliasedImports: { alias: string; program: Program }[] = [];
    const aliases = new Set<string>();
    for (const item of program.sourceImports ?? []) {
      if (item.alias) {
        if (
          aliases.has(item.alias) || program.declarations.some((decl) => decl.name === item.alias)
        ) {
          diagnostics.push({
            code: "module.duplicate_alias",
            message: `source import alias ${item.alias} conflicts with another declaration`,
          });
          continue;
        }
        aliases.add(item.alias);
      }
      const imported = await load(item.module);
      if (!imported) continue;
      if (item.alias) aliasedImports.push({ alias: item.alias, program: imported });
      else importedPrograms.push(imported);
    }
    return mergePrograms(importedPrograms, aliasedImports, program, diagnostics);
  }

  const merged = await mergeImports(root);
  if (diagnostics.length) throw new CompileError(diagnostics);
  return merged;
}

function mergePrograms(
  imports: Program[],
  aliasedImports: { alias: string; program: Program }[],
  program: Program,
  diagnostics: Diagnostic[],
): Program {
  const importedDecls = imports.flatMap((item) => item.declarations);
  const aliasedDecls = aliasedImports.flatMap(({ alias, program }) =>
    qualifyImportedDeclarations(program.declarations, alias)
  );
  const localNames = new Set(program.declarations.map(declarationName));
  const seenImported = new Map<string, Declaration>();
  const declarations: Declaration[] = [];
  for (const decl of [...importedDecls, ...aliasedDecls]) {
    const name = declarationName(decl);
    if (localNames.has(name) || seenImported.has(name)) {
      diagnostics.push({
        code: "module.duplicate_import",
        message: `imported declaration ${name} conflicts with another declaration`,
      });
      continue;
    }
    seenImported.set(name, decl);
    declarations.push(decl);
  }
  declarations.push(...program.declarations);
  return {
    moduleName: program.moduleName,
    imports: [
      ...imports.flatMap((item) => item.imports),
      ...aliasedImports.flatMap((item) => item.program.imports),
      ...program.imports,
    ],
    sourceImports: [],
    declarations,
  };
}

function declarationName(decl: Declaration): string {
  return decl.name;
}

function qualifyImportedDeclarations(declarations: Declaration[], alias: string): Declaration[] {
  const names = new Set(declarations.map((decl) => decl.name));
  return declarations.map((decl) => qualifyDeclaration(decl, alias, names));
}

function qualifyDeclaration(decl: Declaration, alias: string, names: Set<string>): Declaration {
  if (decl.kind === "fn") {
    return {
      ...decl,
      name: qualifyName(decl.name, alias),
      memberOf: decl.memberOf
        ? {
          owner: qualifyReference(decl.memberOf.owner, alias, names),
          member: decl.memberOf.member,
        }
        : undefined,
      params: decl.params.map((param) => ({
        ...param,
        type: qualifyTypeSource(param.type, alias, names),
        pattern: param.pattern ? qualifyParamPattern(param.pattern, alias, names) : undefined,
      })),
      returnType: decl.returnType ? qualifyTypeSource(decl.returnType, alias, names) : undefined,
      body: qualifyExpr(decl.body, alias, names) as FnDecl["body"],
    };
  }
  if (decl.kind === "type") return qualifyTypeDecl(decl, alias, names);
  if (decl.kind === "const") return qualifyConstLike(decl, alias, names);
  return {
    ...decl,
    name: qualifyName(decl.name, alias),
    type: decl.type ? qualifyTypeSource(decl.type, alias, names) : undefined,
    value: qualifyExpr(decl.value, alias, names),
  };
}

function qualifyConstLike<T extends ConstDecl | LetDecl>(
  decl: T,
  alias: string,
  names: Set<string>,
): T {
  return {
    ...decl,
    name: qualifyName(decl.name, alias),
    type: decl.type ? qualifyTypeSource(decl.type, alias, names) : undefined,
    value: qualifyExpr(decl.value, alias, names),
  };
}

function qualifyTypeDecl(decl: TypeDecl, alias: string, names: Set<string>): TypeDecl {
  return {
    ...decl,
    name: qualifyName(decl.name, alias),
    paramPatterns: decl.paramPatterns?.map((pattern) => qualifyParamPattern(pattern, alias, names)),
    body: qualifyTypeBlock(decl.body, alias, names),
    normalized: undefined,
    clauses: decl.clauses?.map((clause) => qualifyTypeDecl(clause, alias, names)),
  };
}

function qualifyTypeBlock(block: TypeBlock, alias: string, names: Set<string>): TypeBlock {
  return {
    kind: "type_block",
    statements: block.statements.map((stmt) => ({
      ...stmt,
      value: qualifyTypeExpr(stmt.value, alias, names),
    })),
    expr: block.expr ? qualifyTypeExpr(block.expr, alias, names) : undefined,
  };
}

function qualifyExpr(expr: Expr, alias: string, names: Set<string>): Expr {
  switch (expr.kind) {
    case "var":
      return { ...expr, name: qualifyReference(expr.name, alias, names) };
    case "call":
      return {
        ...expr,
        callee: qualifyExpr(expr.callee, alias, names),
        args: expr.args.map((arg) => qualifyExpr(arg, alias, names)),
      };
    case "index":
      return {
        ...expr,
        target: qualifyExpr(expr.target, alias, names),
        index: qualifyExpr(expr.index, alias, names),
      };
    case "binary":
      return {
        ...expr,
        left: qualifyExpr(expr.left, alias, names),
        right: qualifyExpr(expr.right, alias, names),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: qualifyExpr(expr.value, alias, names),
        body: qualifyExpr(expr.body, alias, names),
      };
    case "match":
      return {
        ...expr,
        value: qualifyExpr(expr.value, alias, names),
        arms: expr.arms.map((arm) => ({ ...arm, value: qualifyExpr(arm.value, alias, names) })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: qualifyExpr(slot.value, alias, names),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        constructor: qualifyReference(expr.constructor, alias, names),
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: qualifyExpr(slot.value, alias, names),
        })),
      };
    case "range":
      return {
        ...expr,
        start: qualifyExpr(expr.start, alias, names),
        end: qualifyExpr(expr.end, alias, names),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) => {
          if (stmt.kind === "let") return qualifyConstLike(stmt, alias, names);
          if (stmt.kind === "destructure_let") {
            return { ...stmt, value: qualifyExpr(stmt.value, alias, names) };
          }
          if (stmt.kind === "fork_let") {
            return { ...stmt, source: qualifyReference(stmt.source, alias, names) };
          }
          return { ...stmt, value: qualifyTypeExpr(stmt.value, alias, names) };
        }),
        expr: expr.expr ? qualifyExpr(expr.expr, alias, names) : undefined,
      };
    case "literal":
    case "placeholder":
      return expr;
  }
}

function qualifyTypeExpr(expr: TypeExpr, alias: string, names: Set<string>): TypeExpr {
  switch (expr.kind) {
    case "type_ref":
      return { ...expr, name: qualifyReference(expr.name, alias, names) };
    case "type_call":
      return {
        ...expr,
        callee: qualifyTypeExpr(expr.callee, alias, names),
        args: expr.args.map((arg) => qualifyTypeExpr(arg, alias, names)),
      };
    case "type_shape":
      return { ...expr, shape: qualifyTypeShape(expr.shape, alias, names) };
    case "type_match":
      return {
        ...expr,
        value: qualifyTypeExpr(expr.value, alias, names),
        arms: expr.arms.map((arm) => ({
          pattern: qualifyTypePattern(arm.pattern, alias, names),
          value: qualifyTypeExpr(arm.value, alias, names),
        })),
      };
    case "type_binary":
      return {
        ...expr,
        left: qualifyTypeExpr(expr.left, alias, names),
        right: qualifyTypeExpr(expr.right, alias, names),
      };
    case "type_fn":
      return { ...expr, source: qualifyTypeSource(expr.source, alias, names) };
    case "type_static_ref":
    case "type_bool":
    case "type_number":
    case "type_string":
    case "type_literal":
      return expr;
  }
}

function qualifyTypeShape(shape: TypeShape, alias: string, names: Set<string>): TypeShape {
  return {
    slots: shape.slots.map((slot) => ({
      ...slot,
      type: qualifyTypeExpr(slot.type, alias, names),
      repeat: slot.repeat ? qualifyTypeCountExpr(slot.repeat, alias, names) : undefined,
    })),
    members: shape.members?.map((member) => qualifyTypeMember(member, alias, names)),
  };
}

function qualifyTypeMember(
  member: TypeMemberExpr,
  alias: string,
  names: Set<string>,
): TypeMemberExpr {
  return {
    ...member,
    type: qualifyTypeSource(member.type, alias, names),
    target: qualifyReference(member.target, alias, names),
    inlineFn: member.inlineFn
      ? qualifyDeclaration(member.inlineFn, alias, names) as FnDecl
      : undefined,
  };
}

function qualifyTypeCountExpr(
  expr: TypeCountExpr,
  alias: string,
  names: Set<string>,
): TypeCountExpr {
  if (expr.kind === "count_ref") {
    return { ...expr, name: qualifyReference(expr.name, alias, names) };
  }
  if (expr.kind === "count_mul") {
    return {
      ...expr,
      left: qualifyTypeCountExpr(expr.left, alias, names),
      right: qualifyTypeCountExpr(expr.right, alias, names),
    };
  }
  return expr;
}

function qualifyParamPattern(
  pattern: ParamPattern,
  alias: string,
  names: Set<string>,
): ParamPattern {
  if (pattern.kind === "constructor" || pattern.kind === "type") {
    return pattern.kind === "constructor"
      ? {
        ...pattern,
        name: qualifyReference(pattern.name, alias, names),
        args: pattern.args.map((arg) => qualifyParamPattern(arg, alias, names)),
      }
      : { ...pattern, name: qualifyReference(pattern.name, alias, names) };
  }
  return pattern;
}

function qualifyTypePattern(pattern: TypePattern, alias: string, names: Set<string>): TypePattern {
  return pattern.kind === "type"
    ? { ...pattern, name: qualifyReference(pattern.name, alias, names) }
    : pattern;
}

function qualifyTypeSource(source: string, alias: string, names: Set<string>): string {
  let result = source;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    result = result.replace(
      new RegExp(`(?<![A-Za-z0-9_.])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g"),
      qualifyName(name, alias),
    );
  }
  return result;
}

function qualifyReference(name: string, alias: string, names: Set<string>): string {
  const head = name.split(/[.(\[]/, 1)[0] ?? name;
  if (!names.has(head)) return name;
  return `${qualifyName(head, alias)}${name.slice(head.length)}`;
}

function qualifyName(name: string, alias: string): string {
  return `${alias}.${name}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
