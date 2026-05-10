import { parse } from "./parser.ts";
import { checkProgram, checkProgramForAnalysis } from "./check.ts";
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
  StaticForSource,
  TypeBlock,
  TypeCountExpr,
  TypeDecl,
  TypeExpr,
  TypeMemberExpr,
  TypePattern,
  TypeShape,
} from "./core_ast.ts";
import { CompileError, type Diagnostic } from "./diagnostics.ts";
import { copyAstMetadata, hideAstMetadata } from "./ast_meta.ts";

export interface ModuleSource {
  text: string;
  sourceId?: string;
}

export interface CheckSourceOptions {
  sourceId?: string;
  resolveModule?: (
    moduleName: string,
  ) => string | ModuleSource | undefined | Promise<string | ModuleSource | undefined>;
}

export interface CompileSourceOptions extends CheckSourceOptions, BackendOptions {}

export async function checkSource(source: string, options: CheckSourceOptions = {}) {
  const program = await parse(source, { sourceId: options.sourceId });
  if (!options.resolveModule) return checkProgram(program);
  return checkProgram(
    await resolveSourceImports(program, { resolveModule: options.resolveModule }),
  );
}

export async function checkSourceForAnalysis(source: string, options: CheckSourceOptions = {}) {
  const program = await parse(source, { sourceId: options.sourceId });
  return await checkParsedSourceForAnalysis(program, options);
}

export async function checkParsedSourceForAnalysis(
  program: Program,
  options: CheckSourceOptions = {},
) {
  if (!options.resolveModule) return checkProgramForAnalysis(program);
  return checkProgramForAnalysis(
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
export { formatSource, isFormatted } from "./format.ts";
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

  async function load(
    moduleName: string,
    requestedAt?: SourceImport,
  ): Promise<Program | undefined> {
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
        span: requestedAt?.span,
      });
      visiting.pop();
      return undefined;
    }
    const parsed = await parseModuleSource(source, moduleName);
    const merged = await mergeImports(parsed);
    resolved.set(moduleName, merged);
    visiting.pop();
    return merged;
  }

  async function mergeImports(program: Program): Promise<Program> {
    const importedPrograms: Program[] = [];
    const aliasedImports: { alias: string; program: Program }[] = [];
    const destructuredImports: { alias: string; sourceImport: SourceImport; program: Program }[] =
      [];
    const aliases = new Set<string>();
    const reservedNames = new Set(program.declarations.map(declarationName));
    let hiddenImportIndex = 0;
    for (const item of program.sourceImports ?? []) {
      if (item.alias) {
        if (
          aliases.has(item.alias) || program.declarations.some((decl) => decl.name === item.alias)
        ) {
          diagnostics.push({
            code: "module.duplicate_alias",
            message: `source import alias ${item.alias} conflicts with another declaration`,
            span: item.nameSpan ?? item.span,
          });
          continue;
        }
        aliases.add(item.alias);
        reservedNames.add(item.alias);
      }
      if (item.bindings) {
        const seenBindings = new Set<string>();
        for (const binding of item.bindings) {
          if (seenBindings.has(binding.name)) {
            diagnostics.push({
              code: "module.duplicate_binding",
              message: `source import binding ${binding.name} is listed more than once`,
              span: binding.nameSpan ?? binding.span,
            });
          }
          seenBindings.add(binding.name);
        }
      }
      const imported = await load(item.module, item);
      if (!imported) continue;
      if (item.alias) aliasedImports.push({ alias: item.alias, program: imported });
      else if (item.bindings) {
        const alias = nextHiddenImportAlias(reservedNames, hiddenImportIndex++);
        reservedNames.add(alias);
        for (const decl of imported.declarations) {
          reservedNames.add(qualifyName(declarationName(decl), alias));
        }
        destructuredImports.push({
          alias,
          sourceImport: item,
          program: imported,
        });
      } else importedPrograms.push(imported);
    }
    return mergePrograms(
      importedPrograms,
      aliasedImports,
      destructuredImports,
      program,
      diagnostics,
    );
  }

  const merged = await mergeImports(root);
  if (diagnostics.length) throw new CompileError(diagnostics);
  return merged;
}

function mergePrograms(
  imports: Program[],
  aliasedImports: { alias: string; program: Program }[],
  destructuredImports: { alias: string; sourceImport: SourceImport; program: Program }[],
  program: Program,
  diagnostics: Diagnostic[],
): Program {
  const importedDecls = imports.flatMap((item) => item.declarations);
  const aliasedDecls = aliasedImports.flatMap(({ alias, program }) =>
    qualifyImportedDeclarations(program.declarations, alias)
  );
  const destructuredDecls = destructuredImports.flatMap((item) =>
    destructureImportedDeclarations(item.sourceImport, item.program, item.alias, diagnostics)
  );
  const localNames = new Set(program.declarations.map(declarationName));
  const seenImported = new Map<string, Declaration>();
  const declarations: Declaration[] = [];
  for (const decl of [...importedDecls, ...aliasedDecls, ...destructuredDecls]) {
    const name = declarationName(decl);
    if (localNames.has(name) || seenImported.has(name)) {
      diagnostics.push({
        code: "module.duplicate_import",
        message: `imported declaration ${name} conflicts with another declaration`,
        span: decl.nameSpan ?? decl.span,
      });
      continue;
    }
    seenImported.set(name, decl);
    declarations.push(decl);
  }
  declarations.push(...program.declarations);
  return hideAstMetadata({
    moduleName: program.moduleName,
    imports: [
      ...imports.flatMap((item) => item.imports),
      ...aliasedImports.flatMap((item) => item.program.imports),
      ...destructuredImports.flatMap((item) => item.program.imports),
      ...program.imports,
    ],
    sourceImports: [],
    declarations,
  });
}

function destructureImportedDeclarations(
  sourceImport: SourceImport,
  program: Program,
  alias: string,
  diagnostics: Diagnostic[],
): Declaration[] {
  const bindings = sourceImport.bindings ?? [];
  const names = new Set(program.declarations.flatMap(collectDeclarationNames));
  const hiddenDecls = qualifyImportedDeclarations(program.declarations, alias).map(markPrivate);
  const selected: Declaration[] = [];
  const seenBindings = new Set<string>();
  for (const binding of bindings) {
    if (seenBindings.has(binding.name)) continue;
    seenBindings.add(binding.name);
    const decl = program.declarations.find((item) => declarationName(item) === binding.name);
    if (!decl) {
      diagnostics.push({
        code: "module.missing_binding",
        message: `module ${sourceImport.module} has no declaration named ${binding.name}`,
        span: binding.nameSpan ?? binding.span,
      });
      continue;
    }
    selected.push(
      unqualifiedSelectedDeclaration(qualifyDeclaration(decl, alias, names), binding.name),
    );
  }
  return [...hiddenDecls, ...selected];
}

function nextHiddenImportAlias(reservedNames: Set<string>, start: number): string {
  let index = start;
  while (true) {
    const alias = `__import${index++}`;
    if (![...reservedNames].some((name) => name === alias || name.startsWith(`${alias}.`))) {
      return alias;
    }
  }
}

function unqualifiedSelectedDeclaration(decl: Declaration, name: string): Declaration {
  if (decl.kind === "fn") return withMeta(decl, { ...decl, name });
  if (decl.kind === "type") return withMeta(decl, { ...decl, name });
  return withMeta(decl, { ...decl, name });
}

function markPrivate(decl: Declaration): Declaration {
  if (decl.kind === "fn" || decl.kind === "type") {
    return withMeta(decl, { ...decl, public: false });
  }
  return decl;
}

async function parseModuleSource(
  source: string | ModuleSource,
  moduleName: string,
): Promise<Program> {
  return typeof source === "string"
    ? await parse(source, { sourceId: moduleName })
    : await parse(source.text, { sourceId: source.sourceId ?? moduleName });
}

function declarationName(decl: Declaration): string {
  return decl.name;
}

function qualifyImportedDeclarations(declarations: Declaration[], alias: string): Declaration[] {
  const names = new Set(declarations.flatMap(collectDeclarationNames));
  return declarations.map((decl) => qualifyDeclaration(decl, alias, names));
}

function collectDeclarationNames(decl: Declaration): string[] {
  if (decl.kind !== "type") return [decl.name];
  return [
    decl.name,
    ...collectTypeBlockNames(decl.body),
    ...(decl.clauses ?? []).flatMap(collectDeclarationNames),
  ];
}

function collectTypeBlockNames(block: TypeBlock): string[] {
  return block.statements.map((stmt) => stmt.name);
}

function qualifyDeclaration(decl: Declaration, alias: string, names: Set<string>): Declaration {
  if (decl.kind === "fn") {
    return withMeta(decl, {
      ...decl,
      name: qualifyName(decl.name, alias),
      memberOf: decl.memberOf
        ? {
          ...decl.memberOf,
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
    });
  }
  if (decl.kind === "type") return qualifyTypeDecl(decl, alias, names);
  if (decl.kind === "const") return qualifyConstLike(decl, alias, names);
  return withMeta(decl, {
    ...decl,
    name: qualifyName(decl.name, alias),
    type: decl.type ? qualifyTypeSource(decl.type, alias, names) : undefined,
    value: qualifyExpr(decl.value, alias, names),
  });
}

function qualifyConstLike<t extends ConstDecl | LetDecl>(
  decl: t,
  alias: string,
  names: Set<string>,
): t {
  return withMeta(decl, {
    ...decl,
    name: qualifyName(decl.name, alias),
    type: decl.type ? qualifyTypeSource(decl.type, alias, names) : undefined,
    value: qualifyExpr(decl.value, alias, names),
  });
}

function qualifyTypeDecl(decl: TypeDecl, alias: string, names: Set<string>): TypeDecl {
  return withMeta(decl, {
    ...decl,
    name: qualifyName(decl.name, alias),
    paramPatterns: decl.paramPatterns?.map((pattern) => qualifyParamPattern(pattern, alias, names)),
    body: qualifyTypeBlock(decl.body, alias, names),
    normalized: undefined,
    clauses: decl.clauses?.map((clause) => qualifyTypeDecl(clause, alias, names)),
  });
}

function qualifyTypeBlock(block: TypeBlock, alias: string, names: Set<string>): TypeBlock {
  return withMeta(block, {
    kind: "type_block",
    statements: block.statements.map((stmt) =>
      withMeta(stmt, {
        ...stmt,
        name: qualifyName(stmt.name, alias),
        value: qualifyTypeExpr(stmt.value, alias, names),
      })
    ),
    expr: block.expr ? qualifyTypeExpr(block.expr, alias, names) : undefined,
  });
}

function qualifyExpr(expr: Expr, alias: string, names: Set<string>): Expr {
  switch (expr.kind) {
    case "var":
      return withMeta(expr, { ...expr, name: qualifyReference(expr.name, alias, names) });
    case "call":
      return withMeta(expr, {
        ...expr,
        callee: qualifyExpr(expr.callee, alias, names),
        args: expr.args.map((arg) => qualifyExpr(arg, alias, names)),
      });
    case "borrow":
      return withMeta(expr, { ...expr, value: qualifyExpr(expr.value, alias, names) });
    case "index":
      return withMeta(expr, {
        ...expr,
        target: qualifyExpr(expr.target, alias, names),
        index: qualifyExpr(expr.index, alias, names),
      });
    case "binary":
      return withMeta(expr, {
        ...expr,
        left: qualifyExpr(expr.left, alias, names),
        right: qualifyExpr(expr.right, alias, names),
      });
    case "pipe_bind":
      return withMeta(expr, {
        ...expr,
        value: qualifyExpr(expr.value, alias, names),
        body: qualifyExpr(expr.body, alias, names),
      });
    case "match":
      return withMeta(expr, {
        ...expr,
        value: qualifyExpr(expr.value, alias, names),
        arms: expr.arms.map((arm) =>
          withMeta(arm, { ...arm, value: qualifyExpr(arm.value, alias, names) })
        ),
      });
    case "shape":
      return withMeta(expr, {
        ...expr,
        slots: expr.slots.map((slot) =>
          withMeta(slot, {
            ...slot,
            value: qualifyExpr(slot.value, alias, names),
          })
        ),
      });
    case "static_for_slots":
      return withMeta(expr, {
        ...expr,
        source: qualifyStaticForSource(expr.source, alias, names),
        value: qualifyExpr(expr.value, alias, names),
      });
    case "product_constructor":
      return withMeta(expr, {
        ...expr,
        constructor: qualifyReference(expr.constructor, alias, names),
        slots: expr.slots.map((slot) =>
          withMeta(slot, {
            ...slot,
            value: qualifyExpr(slot.value, alias, names),
          })
        ),
      });
    case "range":
      return withMeta(expr, {
        ...expr,
        start: qualifyExpr(expr.start, alias, names),
        end: qualifyExpr(expr.end, alias, names),
      });
    case "field":
      return withMeta(expr, {
        ...expr,
        value: qualifyExpr(expr.value, alias, names),
        key: qualifyExpr(expr.key, alias, names),
      });
    case "block":
      return withMeta(expr, {
        ...expr,
        statements: expr.statements.map((stmt) => {
          if (stmt.kind === "let") {
            return withMeta(stmt, {
              ...stmt,
              type: stmt.type ? qualifyTypeSource(stmt.type, alias, names) : undefined,
              value: qualifyExpr(stmt.value, alias, names),
            });
          }
          if (stmt.kind === "destructure_let") {
            return withMeta(stmt, { ...stmt, value: qualifyExpr(stmt.value, alias, names) });
          }
          if (stmt.kind === "fork_let") {
            return withMeta(stmt, { ...stmt, source: qualifyReference(stmt.source, alias, names) });
          }
          if (stmt.kind === "proof_const") {
            return withMeta(stmt, { ...stmt, value: qualifyTypeExpr(stmt.value, alias, names) });
          }
          return stmt;
        }),
        expr: expr.expr ? qualifyExpr(expr.expr, alias, names) : undefined,
      });
    case "literal":
    case "placeholder":
      return expr;
  }
}

function qualifyTypeExpr(expr: TypeExpr, alias: string, names: Set<string>): TypeExpr {
  switch (expr.kind) {
    case "type_ref":
      return withMeta(expr, { ...expr, name: qualifyReference(expr.name, alias, names) });
    case "type_call":
      return withMeta(expr, {
        ...expr,
        callee: qualifyTypeExpr(expr.callee, alias, names),
        args: expr.args.map((arg) => qualifyTypeExpr(arg, alias, names)),
      });
    case "type_shape":
      return withMeta(expr, { ...expr, shape: qualifyTypeShape(expr.shape, alias, names) });
    case "type_match":
      return withMeta(expr, {
        ...expr,
        value: qualifyTypeExpr(expr.value, alias, names),
        arms: expr.arms.map((arm) =>
          withMeta(arm, {
            pattern: qualifyTypePattern(arm.pattern, alias, names),
            value: qualifyTypeExpr(arm.value, alias, names),
          })
        ),
      });
    case "type_binary":
      return withMeta(expr, {
        ...expr,
        left: qualifyTypeExpr(expr.left, alias, names),
        right: qualifyTypeExpr(expr.right, alias, names),
      });
    case "type_operator":
      return withMeta(expr, {
        ...expr,
        descriptor: {
          ...expr.descriptor,
          target: qualifyReference(expr.descriptor.target, alias, names),
        },
      });
    case "type_fn":
      return withMeta(expr, { ...expr, source: qualifyTypeSource(expr.source, alias, names) });
    case "type_static_ref":
    case "type_bool":
    case "type_number":
    case "type_char":
    case "type_string":
    case "type_literal":
      return expr;
  }
}

function qualifyStaticForSource(
  source: StaticForSource,
  alias: string,
  names: Set<string>,
): StaticForSource {
  return source.kind === "range"
    ? withMeta(source, {
      ...source,
      start: qualifyExpr(source.start, alias, names),
      end: qualifyExpr(source.end, alias, names),
    })
    : withMeta(source, { ...source, shape: qualifyExpr(source.shape, alias, names) });
}

function qualifyTypeShape(shape: TypeShape, alias: string, names: Set<string>): TypeShape {
  return withMeta(shape, {
    slots: shape.slots.map((slot) =>
      withMeta(slot, {
        ...slot,
        type: qualifyTypeExpr(slot.type, alias, names),
        repeat: slot.repeat ? qualifyTypeCountExpr(slot.repeat, alias, names) : undefined,
      })
    ),
    members: shape.members?.map((member) => qualifyTypeMember(member, alias, names)),
  });
}

function qualifyTypeMember(
  member: TypeMemberExpr,
  alias: string,
  names: Set<string>,
): TypeMemberExpr {
  return withMeta(member, {
    ...member,
    type: qualifyTypeSource(member.type, alias, names),
    target: qualifyReference(member.target, alias, names),
    inlineFn: member.inlineFn
      ? qualifyDeclaration(member.inlineFn, alias, names) as FnDecl
      : undefined,
  });
}

function qualifyTypeCountExpr(
  expr: TypeCountExpr,
  alias: string,
  names: Set<string>,
): TypeCountExpr {
  if (expr.kind === "count_ref") {
    return withMeta(expr, { ...expr, name: qualifyReference(expr.name, alias, names) });
  }
  if (expr.kind === "count_mul") {
    return withMeta(expr, {
      ...expr,
      left: qualifyTypeCountExpr(expr.left, alias, names),
      right: qualifyTypeCountExpr(expr.right, alias, names),
    });
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
      ? withMeta(pattern, {
        ...pattern,
        name: qualifyReference(pattern.name, alias, names),
        args: pattern.args.map((arg) => qualifyParamPattern(arg, alias, names)),
      })
      : withMeta(pattern, { ...pattern, name: qualifyReference(pattern.name, alias, names) });
  }
  return pattern;
}

function qualifyTypePattern(pattern: TypePattern, alias: string, names: Set<string>): TypePattern {
  return pattern.kind === "type"
    ? withMeta(pattern, { ...pattern, name: qualifyReference(pattern.name, alias, names) })
    : pattern;
}

function withMeta<t extends object>(source: unknown, target: t): t {
  return copyAstMetadata(target, source);
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
  const match = [...names]
    .filter((candidate) => name === candidate || name.startsWith(`${candidate}.`))
    .sort((a, b) => b.length - a.length)[0];
  if (!match) return name;
  return `${qualifyName(match, alias)}${name.slice(match.length)}`;
}

function qualifyName(name: string, alias: string): string {
  return `${alias}.${name}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
