import type {
  ConstDecl,
  Expr,
  FnDecl,
  Param,
  ParamPattern,
  Program,
  ShapeType,
  Statement,
  TypeBody,
  TypeCountExpr,
  TypeDecl,
  TypeExpr,
  TypeParamKind,
  TypePattern,
  TypeResultKind,
  TypeShape,
} from "./core_ast.ts";
import { CompileError, type Diagnostic } from "./diagnostics.ts";
import { intrinsicWrapperId, isIntrinsicWrapper, isKnownIntrinsicId } from "./primitives.ts";
import { type ShaderManifestEntry, shaderManifestEntry, wgslShaderId } from "./wgsl.ts";

export interface CheckResult {
  program: Program;
  shaderManifest: ShaderManifestEntry[];
}

export function checkProgram(program: Program): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const shaderManifest = new Map<number, ShaderManifestEntry>();
  const addShader = (source: string) => {
    const entry = shaderManifestEntry(source);
    shaderManifest.set(entry.id, entry);
    return entry;
  };
  const capabilities = new Map(program.imports.map((item) => [item.name, item.effects]));
  groupFunctionClauses(program, diagnostics);
  const typeDecls = mergeTypeFragments(program, diagnostics);
  checkTypeFunctionCasing(typeDecls, program, diagnostics);
  let fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  let functions = new Set(fnDecls.map((decl) => decl.name));
  checkPrimitiveDecls(fnDecls, diagnostics);
  evaluateTypeDecls(typeDecls, diagnostics);
  attachQualifiedTypeMembers(typeDecls, fnDecls, diagnostics);
  const constValues = evaluateConstDecls(
    program.declarations.filter((decl): decl is ConstDecl => decl.kind === "const"),
    typeDecls,
    fnDecls,
    capabilities,
    addShader,
    diagnostics,
  );
  specializeInferredTypeCalls(
    program,
    new Map(fnDecls.map((decl) => [decl.name, decl])),
    constValues,
    typeDecls,
    diagnostics,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  resolveAttachedMemberCalls(program, typeDecls);
  specializeConstParamCalls(
    program,
    new Map(fnDecls.map((decl) => [decl.name, decl])),
    constValues,
    addShader,
    diagnostics,
  );
  resolveAttachedMemberCalls(program, typeDecls);
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  functions = new Set(fnDecls.map((decl) => decl.name));
  checkConstDictionaries(
    program.declarations.filter((decl): decl is ConstDecl => decl.kind === "const"),
    typeDecls,
    fnDecls,
    capabilities,
    functions,
    diagnostics,
  );
  checkTypeContracts(program, typeDecls, fnDecls, capabilities, diagnostics);
  lowerProductConstructors(program, typeDecls, diagnostics);

  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      if (decl.public && !decl.returnType) {
        diagnostics.push({
          code: "type.public_signature",
          message: `public function ${decl.name} requires an explicit return type`,
        });
      }
      if (!decl.generated && !decl.primitiveId) {
        checkFn(decl, capabilities, diagnostics, typeDecls, fnDecls);
      }
    }
  }
  if (diagnostics.length) throw new CompileError(diagnostics);
  return { program, shaderManifest: [...shaderManifest.values()].sort((a, b) => a.id - b.id) };
}

function checkPrimitiveDecls(fnDecls: FnDecl[], diagnostics: Diagnostic[]) {
  const ids = new Map<string, string>();
  for (const decl of fnDecls) {
    const directWrapperId = directCompilerCallId(decl);
    const id = decl.primitiveId ?? directWrapperId;
    if (!id) continue;
    if (!isKnownIntrinsicId(id)) {
      diagnostics.push({
        code: "primitive.unknown",
        message: `unknown compiler intrinsic ${id} on function ${decl.name}`,
      });
      continue;
    }
    const previous = ids.get(id);
    if (previous) {
      diagnostics.push({
        code: "primitive.duplicate",
        message: `compiler intrinsic ${id} is declared by both ${previous} and ${decl.name}`,
      });
    } else {
      ids.set(id, decl.name);
    }
  }
}

function directCompilerCallId(fn: FnDecl): string | undefined {
  const expr = fn.body.expr;
  if (fn.body.statements.length !== 0 || !expr || expr.kind !== "call") return undefined;
  if (expr.callee.kind !== "var" || !expr.callee.name.startsWith("@")) return undefined;
  const id = expr.callee.name.slice(1);
  return id.startsWith("memory_") || id.startsWith("ptr_") || id.startsWith("wasm_")
    ? id
    : undefined;
}

function groupFunctionClauses(program: Program, diagnostics: Diagnostic[]) {
  const groups = new Map<string, FnDecl[]>();
  for (const decl of program.declarations) {
    if (decl.kind !== "fn" || decl.generated) continue;
    const group = groups.get(decl.name) ?? [];
    group.push(decl);
    groups.set(decl.name, group);
  }
  const replacements = new Map<FnDecl, FnDecl[]>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    if (first.memberOf) {
      diagnostics.push({
        code: "type.duplicate_member",
        message:
          `type ${first.memberOf.owner} has duplicate static member ${first.memberOf.member}`,
      });
      continue;
    }
    let compatible = true;
    for (const clause of group.slice(1)) {
      if (clause.params.length !== first.params.length) {
        diagnostics.push({
          code: "fn.clause_arity",
          message: `function ${first.name} clauses must have the same arity`,
        });
        compatible = false;
      }
      if (clause.public !== first.public) {
        diagnostics.push({
          code: "fn.clause_visibility",
          message: `function ${first.name} clauses must have the same visibility`,
        });
        compatible = false;
      }
      if ((clause.returnType ?? "") !== (first.returnType ?? "")) {
        diagnostics.push({
          code: "fn.clause_return",
          message: `function ${first.name} clauses must have the same return type`,
        });
        compatible = false;
      }
      if (clause.effects.join("\0") !== first.effects.join("\0")) {
        diagnostics.push({
          code: "fn.clause_effects",
          message: `function ${first.name} clauses must have the same effect row`,
        });
        compatible = false;
      }
      clause.params.forEach((param, index) => {
        if (param.type !== first.params[index]?.type) {
          diagnostics.push({
            code: "fn.clause_param_type",
            message: `function ${first.name} clause parameter ${index + 1} has incompatible type`,
          });
          compatible = false;
        }
      });
    }
    if (!compatible) continue;
    const generated = group.map((clause, index): FnDecl => ({
      ...clause,
      memberOf: undefined,
      public: false,
      name: `${clause.name}__clause_${index}`,
      params: clause.params.map((param) => ({
        ...param,
        pattern: { kind: "binding", name: param.name },
      })),
      generated: true,
    }));
    const dispatcher: FnDecl = {
      ...first,
      params: first.params.map((param) => ({
        ...param,
        pattern: { kind: "binding", name: param.name },
      })),
      body: clauseDispatcherBody(first, group),
      generated: true,
    };
    replacements.set(first, [dispatcher, ...generated]);
    for (const clause of group.slice(1)) replacements.set(clause, []);
  }
  if (!replacements.size) return;
  program.declarations = program.declarations.flatMap((decl): Program["declarations"] =>
    decl.kind === "fn" ? (replacements.get(decl) ?? [decl]) : [decl]
  );
}

function clauseDispatcherBody(
  signature: FnDecl,
  clauses: FnDecl[],
): Extract<Expr, { kind: "block" }> {
  const callClause = (index: number): Expr => ({
    kind: "call",
    callee: { kind: "var", name: `${signature.name}__clause_${index}` },
    args: signature.params.map((param) => ({ kind: "var", name: param.name })),
  });
  let expr: Expr = { kind: "literal", literalKind: "number", value: "0" };
  for (let index = clauses.length - 1; index >= 0; index--) {
    expr = buildClauseBranch(signature, clauses[index], index, expr);
  }
  return { kind: "block", statements: [], expr };
}

function buildClauseBranch(signature: FnDecl, clause: FnDecl, index: number, fallback: Expr): Expr {
  const tests = clause.params.map((param, paramIndex) =>
    patternTestExpr(param.pattern, { kind: "var", name: signature.params[paramIndex].name })
  ).filter((expr): expr is Expr => Boolean(expr));
  if (!tests.length) {
    return {
      kind: "call",
      callee: { kind: "var", name: `${signature.name}__clause_${index}` },
      args: signature.params.map((param) => ({ kind: "var", name: param.name })),
    };
  }
  const test = tests.reduce((left, right) => ({ kind: "binary", op: "==", left, right }));
  return {
    kind: "match",
    value: test,
    arms: [
      {
        pattern: "true",
        value: {
          kind: "call",
          callee: { kind: "var", name: `${signature.name}__clause_${index}` },
          args: signature.params.map((param) => ({ kind: "var", name: param.name })),
        },
      },
      { pattern: "_", value: fallback },
    ],
  };
}

function patternTestExpr(pattern: ParamPattern | undefined, value: Expr): Expr | undefined {
  if (!pattern || pattern.kind === "binding" || pattern.kind === "wildcard") return undefined;
  if (pattern.kind === "literal") {
    return {
      kind: "binary",
      op: "==",
      left: value,
      right: { kind: "literal", value: pattern.value, literalKind: pattern.literalKind },
    };
  }
  return undefined;
}

function mergeTypeFragments(program: Program, diagnostics: Diagnostic[]): TypeDecl[] {
  const groups = new Map<string, TypeDecl[]>();
  for (const decl of program.declarations) {
    if (decl.kind !== "type") continue;
    const group = groups.get(decl.name) ?? [];
    group.push(decl);
    groups.set(decl.name, group);
  }

  const replacements = new Map<TypeDecl, TypeDecl>();
  const remove = new Set<TypeDecl>();
  const mergedDecls: TypeDecl[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      mergedDecls.push(group[0]);
      continue;
    }

    if (
      group.some((decl) => decl.paramPatterns?.length) &&
      group.every((decl) => decl.params.length === group[0].params.length)
    ) {
      const primary = group[0];
      for (const clause of group.slice(1)) {
        if (clause.params.length !== primary.params.length) {
          diagnostics.push({
            code: "type.clause_arity",
            message: `type function ${primary.name} clauses must have the same arity`,
          });
        }
        clause.params.forEach((param, index) => {
          if (param.kind !== primary.params[index]?.kind) {
            diagnostics.push({
              code: "type.clause_param_kind",
              message: `type function ${primary.name} clause parameter ${
                index + 1
              } has incompatible kind`,
            });
          }
        });
        if (clause.resultKind !== primary.resultKind) {
          diagnostics.push({
            code: "type.clause_result_kind",
            message: `type function ${primary.name} clauses must have the same result kind`,
          });
        }
      }
      const merged: TypeDecl = {
        ...primary,
        clauses: group,
      };
      replacements.set(primary, merged);
      for (const clause of group.slice(1)) remove.add(clause);
      mergedDecls.push(merged);
      continue;
    }

    diagnostics.push({
      code: "type.duplicate_runtime_fragment",
      message: `type ${group[0].name} has multiple runtime definitions`,
    });
    mergedDecls.push(group[0]);
    for (const fragment of group.slice(1)) remove.add(fragment);
  }

  program.declarations = program.declarations.flatMap((decl): Program["declarations"] => {
    if (decl.kind !== "type") return [decl];
    if (remove.has(decl)) return [];
    return [replacements.get(decl) ?? decl];
  });
  return mergedDecls;
}

function typeFragmentMembers(decl: TypeDecl) {
  const expr = decl.body.expr;
  if (!expr) return [];
  if (expr.kind === "type_shape") return expr.shape.members ?? [];
  const target = builderPrimaryShape(decl, expr);
  if (target) return target.shape.members ?? [];
  return [];
}

function ensureTypeFragmentMembers(decl: TypeDecl) {
  let expr = decl.body.expr;
  if (!expr) {
    expr = decl.body.expr = { kind: "type_shape", shape: { slots: [], members: [] } };
  }
  if (expr.kind === "type_shape") {
    expr.shape.members ??= [];
    return expr.shape.members;
  }
  const target = builderPrimaryShape(decl, expr);
  if (target) {
    target.shape.members ??= [];
    return target.shape.members;
  }
  const replacement: TypeExpr = { kind: "type_shape", shape: { slots: [], members: [] } };
  decl.body.expr = replacement;
  return replacement.shape.members!;
}

function builderPrimaryShape(decl: TypeDecl, expr: TypeExpr) {
  const call = typeBuilderCall(expr);
  if (!call) return undefined;
  const firstArg = call.args[0];
  if (firstArg?.kind !== "type_ref") return undefined;
  const stmt = decl.body.statements.find((stmt) => stmt.name === firstArg.name);
  return stmt?.value.kind === "type_shape" ? stmt.value : undefined;
}

function attachQualifiedTypeMembers(
  types: TypeDecl[],
  functions: FnDecl[],
  diagnostics: Diagnostic[],
) {
  const typesByName = new Map(types.map((decl) => [decl.name, decl]));
  const attached = new Set<string>();
  for (const fn of functions) {
    if (!fn.memberOf || fn.primitiveId || isIntrinsicWrapper(fn)) continue;
    const owner = typesByName.get(fn.memberOf.owner);
    if (!owner) {
      diagnostics.push({
        code: "type.unknown_type",
        message:
          `qualified member function ${fn.name} references unknown type ${fn.memberOf.owner}`,
      });
      continue;
    }
    const key = `${fn.memberOf.owner}.${fn.memberOf.member}`;
    if (
      attached.has(key) ||
      typeFragmentMembers(owner).some((member) => member.name === fn.memberOf!.member)
    ) {
      diagnostics.push({
        code: "type.duplicate_member",
        message: `type ${fn.memberOf.owner} has duplicate static member ${fn.memberOf.member}`,
      });
      continue;
    }
    attached.add(key);
    const member = {
      name: fn.memberOf.member,
      type: renderFnType(fn),
      target: fn.name,
    };
    ensureTypeFragmentMembers(owner).push(member);
    if (owner.normalized?.kind === "product" || owner.normalized?.kind === "sum") {
      owner.normalized.members ??= [];
      owner.normalized.members.push({ ...member });
    }
  }
}

function renderFnType(fn: FnDecl): string {
  return `fn(${
    fn.params.map((param) => `${param.const ? "const " : ""}${param.name}: ${param.type}`).join(
      ", ",
    )
  }) -> ${fn.returnType ?? "type"}`;
}

function resolveAttachedMemberCalls(program: Program, types: TypeDecl[]) {
  const members = new Map<string, string>();
  for (const type of types) {
    const normalized = type.normalized;
    if (normalized?.kind !== "product" && normalized?.kind !== "sum") continue;
    for (const member of normalized.members ?? []) {
      members.set(`${type.name}.${member.name}`, member.target);
    }
  }
  for (const decl of program.declarations) {
    if (decl.kind === "fn") decl.body = rewriteAttachedMembersInBlock(decl.body, members);
    else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = rewriteAttachedMembersInExpr(decl.value, members);
    }
  }
}

function rewriteAttachedMembersInBlock(
  block: Extract<Expr, { kind: "block" }>,
  members: Map<string, string>,
) {
  return {
    ...block,
    statements: block.statements.map((stmt) =>
      stmt.kind === "let"
        ? { ...stmt, value: rewriteAttachedMembersInExpr(stmt.value, members) }
        : stmt
    ),
    expr: block.expr ? rewriteAttachedMembersInExpr(block.expr, members) : undefined,
  };
}

function rewriteAttachedMembersInExpr(expr: Expr, members: Map<string, string>): Expr {
  switch (expr.kind) {
    case "var":
      return members.has(expr.name) ? { kind: "var", name: members.get(expr.name)! } : expr;
    case "call":
      return {
        ...expr,
        callee: rewriteAttachedMembersInExpr(expr.callee, members),
        args: expr.args.map((arg) => rewriteAttachedMembersInExpr(arg, members)),
      };
    case "index":
      return {
        ...expr,
        target: rewriteAttachedMembersInExpr(expr.target, members),
        index: rewriteAttachedMembersInExpr(expr.index, members),
      };
    case "binary":
      return {
        ...expr,
        left: rewriteAttachedMembersInExpr(expr.left, members),
        right: rewriteAttachedMembersInExpr(expr.right, members),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: rewriteAttachedMembersInExpr(expr.value, members),
        body: rewriteAttachedMembersInExpr(expr.body, members),
      };
    case "match":
      return {
        ...expr,
        value: rewriteAttachedMembersInExpr(expr.value, members),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: rewriteAttachedMembersInExpr(arm.value, members),
        })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: rewriteAttachedMembersInExpr(slot.value, members),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: rewriteAttachedMembersInExpr(slot.value, members),
        })),
      };
    case "range":
      return {
        ...expr,
        start: rewriteAttachedMembersInExpr(expr.start, members),
        end: rewriteAttachedMembersInExpr(expr.end, members),
      };
    case "block":
      return rewriteAttachedMembersInBlock(expr, members);
    case "literal":
    case "placeholder":
      return expr;
  }
}

function checkConstDictionaries(
  consts: ConstDecl[],
  types: TypeDecl[],
  functionDecls: FnDecl[],
  capabilities: Map<string, string[]>,
  functions: Set<string>,
  diagnostics: Diagnostic[],
) {
  const typesByName = new Map(types.map((decl) => [decl.name, decl]));
  const functionsByName = new Map(functionDecls.map((decl) => [decl.name, decl]));
  for (const decl of consts) {
    if (!decl.type) {
      diagnostics.push({
        code: "type.const_annotation",
        message: `const ${decl.name} requires an explicit type annotation`,
      });
    }
    if (decl.value.kind !== "shape") {
      if (!isScalarConstInitializer(decl)) {
        diagnostics.push({
          code: "type.const_shape",
          message: `const ${decl.name} must be initialized with a shape literal`,
        });
      }
      continue;
    }
    if (decl.type) {
      checkConstDictionaryShape(decl, typesByName, functionsByName, capabilities, diagnostics);
    }
    const labels = new Set<string>();
    for (const slot of decl.value.slots) {
      if (slot.label) {
        if (labels.has(slot.label)) {
          diagnostics.push({
            code: "type.duplicate_const_slot",
            message: `const ${decl.name} defines duplicate slot ${slot.label}`,
          });
        }
        labels.add(slot.label);
      }
      if (
        slot.value.kind !== "var" || slot.value.name.includes(".") || slot.value.name.includes("[")
      ) {
        diagnostics.push({
          code: "type.const_slot_function",
          message: `const ${decl.name} slot ${
            slot.label ?? "<anonymous>"
          } must reference a top-level function`,
        });
        continue;
      }
      if (!functions.has(slot.value.name)) {
        diagnostics.push({
          code: "type.unknown_const_function",
          message: `const ${decl.name} references unknown function ${slot.value.name}`,
        });
      }
    }
  }
}

function isScalarConstInitializer(decl: ConstDecl): boolean {
  if (!decl.type || decl.value.kind !== "literal") return false;
  const type = decl.type.trim();
  if (decl.value.literalKind === "number") return type === "i32" || type === "count";
  if (decl.value.literalKind === "bool") return type === "bool";
  if (decl.value.literalKind === "string" || decl.value.literalKind === "multiline") {
    return type === "string" || type === "multiline";
  }
  if (decl.value.literalKind === "char") return type === "char";
  if (decl.value.literalKind === "literalType") return type === "literal";
  return false;
}

function checkConstDictionaryShape(
  decl: ConstDecl,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  diagnostics: Diagnostic[],
) {
  const normalized = decl.type
    ? instantiateAnnotation(decl.type, typesByName, functions, capabilities, diagnostics)
    : undefined;
  if (normalized?.kind !== "product") {
    diagnostics.push({
      code: "type.const_dictionary_type",
      message:
        `const ${decl.name} annotation ${decl.type} does not resolve to a dictionary product type`,
    });
    return;
  }

  const actual = new Set<string>();
  for (const slot of decl.value.kind === "shape" ? decl.value.slots : []) {
    if (!slot.label) {
      diagnostics.push({
        code: "type.const_unknown_slot",
        message: `const ${decl.name} defines unknown dictionary slot <anonymous>`,
      });
      continue;
    }
    actual.add(slot.label);
  }

  const expected = new Set(
    normalized.shape.slots
      .map((slot) => slot.label)
      .filter((label): label is string => label !== undefined),
  );
  for (const label of expected) {
    if (!actual.has(label)) {
      diagnostics.push({
        code: "type.const_missing_slot",
        message: `const ${decl.name} is missing dictionary slot ${label}`,
      });
    }
  }
  for (const label of actual) {
    if (!expected.has(label)) {
      diagnostics.push({
        code: "type.const_unknown_slot",
        message: `const ${decl.name} defines unknown dictionary slot ${label}`,
      });
    }
  }
}

type ConstValue =
  | { kind: "never" }
  | { kind: "bool"; value: boolean }
  | { kind: "number"; value: string }
  | { kind: "string"; value: string }
  | { kind: "literal_type"; value: string }
  | { kind: "type"; name: string; normalized?: TypeBody }
  | { kind: "fn"; name: string }
  | { kind: "shape"; slots: { label?: string; value: ConstValue }[] };

function evaluateConstDecls(
  consts: ConstDecl[],
  types: TypeDecl[],
  functions: FnDecl[],
  capabilities: Map<string, string[]>,
  addShader: (source: string) => ShaderManifestEntry,
  diagnostics: Diagnostic[],
): Map<string, ConstValue> {
  const byConst = new Map(consts.map((decl) => [decl.name, decl]));
  const values = new Map<string, ConstValue>();
  const state = new Map<string, "evaluating" | "done">();
  const typeValues = new Map<string, ConstValue>();
  for (
    const name of [
      "i32",
      "u32",
      "i64",
      "u64",
      "f32",
      "f64",
      "bool",
      "string",
      ...Array.from({ length: 64 }, (_, index) => `u${index + 1}`),
    ]
  ) {
    typeValues.set(name, { kind: "type", name });
  }
  for (const decl of types) {
    typeValues.set(decl.name, { kind: "type", name: decl.name, normalized: decl.normalized });
  }
  const byFn = new Map(functions.map((decl) => [decl.name, decl]));
  const evaluator = new ConstEvaluator(
    typeValues,
    byFn,
    capabilities,
    addShader,
    diagnostics,
    (name) => evaluateConst(name),
  );

  const evaluateConst = (name: string): ConstValue | undefined => {
    const decl = byConst.get(name);
    if (!decl) return undefined;
    const current = state.get(name);
    if (current === "evaluating") {
      diagnostics.push({
        code: "const.cycle",
        message: `const dependency cycle involving ${name}`,
      });
      return undefined;
    }
    if (current === "done") return values.get(name);
    state.set(name, "evaluating");
    const value = evaluator.evalExpr(decl.value, new Map(), []);
    if (value) {
      values.set(name, value);
      const expr = constValueToExpr(value);
      if (expr) decl.value = expr;
    }
    state.set(name, "done");
    return value;
  };

  for (const decl of consts) evaluateConst(decl.name);
  return values;
}

class ConstEvaluator {
  constructor(
    private types: Map<string, ConstValue>,
    private functions: Map<string, FnDecl>,
    private capabilities: Map<string, string[]>,
    private addShader: (source: string) => ShaderManifestEntry,
    private diagnostics: Diagnostic[],
    private constLookup: (name: string) => ConstValue | undefined,
  ) {}

  evalExpr(
    expr: Expr,
    locals: Map<string, ConstValue>,
    callStack: string[],
  ): ConstValue | undefined {
    switch (expr.kind) {
      case "literal":
        if (expr.literalKind === "bool") return { kind: "bool", value: expr.value === "true" };
        if (expr.literalKind === "number") return { kind: "number", value: expr.value };
        if (expr.literalKind === "literalType") {
          return { kind: "literal_type", value: expr.value.slice(1) };
        }
        if (expr.literalKind === "string") {
          return { kind: "string", value: expr.value.slice(1, -1) };
        }
        if (expr.literalKind === "multiline") return { kind: "string", value: expr.value };
        return this.unsupported(
          "const.unsupported_expr",
          "unsupported literal in const evaluation",
        );
      case "var":
        return this.evalVar(expr.name, locals);
      case "shape":
        return {
          kind: "shape",
          slots: expr.slots.map((slot) => ({
            label: slot.label,
            value: this.evalExpr(slot.value, locals, callStack) ?? { kind: "never" },
          })),
        };
      case "product_constructor":
        return this.unsupported(
          "const.unsupported_expr",
          "product constructors are not const-evaluable",
        );
      case "call":
        return this.evalCall(expr, locals, callStack);
      case "binary":
        return this.evalBinary(expr, locals, callStack);
      case "pipe_bind": {
        const value = this.evalExpr(expr.value, locals, callStack);
        if (!value) return undefined;
        return this.evalExpr(expr.body, new Map(locals).set(expr.name, value), callStack);
      }
      case "block":
        return this.evalBlock(expr, new Map(locals), callStack);
      case "match": {
        const value = this.evalExpr(expr.value, locals, callStack);
        if (!value) return undefined;
        const arm = expr.arms.find((arm) => constPatternMatches(arm.pattern, value));
        if (!arm) {
          return this.unsupported("const.unsupported_expr", "const match has no matching arm");
        }
        return this.evalExpr(arm.value, new Map(locals), callStack);
      }
      case "range":
        return this.unsupported("const.unsupported_expr", `${expr.kind} is not const-evaluable`);
    }
  }

  private evalBlock(
    block: Extract<Expr, { kind: "block" }>,
    locals: Map<string, ConstValue>,
    callStack: string[],
  ): ConstValue | undefined {
    if (block.statements.some((stmt) => stmt.kind !== "let" && stmt.kind !== "proof_const")) {
      return this.unsupported("const.unsupported_expr", "fork is not const-evaluable");
    }
    const ordered = orderBlockStatements(block.statements, this.diagnostics);
    for (const stmt of ordered) {
      if (stmt.kind === "let") {
        const value = this.evalExpr(stmt.value, locals, callStack);
        if (!value) return undefined;
        locals.set(stmt.name, value);
      }
    }
    return block.expr ? this.evalExpr(block.expr, locals, callStack) : undefined;
  }

  private evalVar(name: string, locals: Map<string, ConstValue>): ConstValue | undefined {
    const direct = locals.get(name) ?? this.constLookup(name) ?? this.types.get(name);
    if (direct) return direct;
    const fn = this.functions.get(name);
    if (fn) return { kind: "fn", name };
    const dot = name.lastIndexOf(".");
    if (dot >= 0) {
      const base = this.evalVar(name.slice(0, dot), locals);
      const field = name.slice(dot + 1);
      if (base?.kind === "shape") {
        const slot = base.slots.find((item) => item.label === field);
        if (slot) return slot.value;
      }
    }
    return this.unsupported("const.unknown_name", `unknown const-evaluable name ${name}`);
  }

  private evalCall(
    expr: Extract<Expr, { kind: "call" }>,
    locals: Map<string, ConstValue>,
    callStack: string[],
  ): ConstValue | undefined {
    if (expr.callee.kind !== "var") {
      return this.unsupported("const.unsupported_expr", "const calls require a named callee");
    }
    const name = expr.callee.name;
    const args: ConstValue[] = expr.args.map((arg) =>
      this.evalExpr(arg, locals, callStack) ?? { kind: "never" }
    );
    if (args.some((arg) => arg.kind === "never")) return { kind: "never" };
    const builtin = this.evalBuiltin(name, args);
    if (builtin) return builtin;
    const typeValue = this.types.get(name);
    if (typeValue?.kind === "type") {
      return {
        kind: "type",
        name: args.length ? `${name}(${args.map(renderConstTypeArg).join(", ")})` : name,
        normalized: typeValue.normalized,
      };
    }
    if (this.capabilities.has(name)) {
      return this.unsupported(
        "const.runtime_call",
        `cannot call imported capability ${name} during const evaluation`,
      );
    }
    const fn = this.functions.get(name);
    if (!fn) {
      return this.unsupported(
        "const.runtime_call",
        `cannot call unknown function ${name} during const evaluation`,
      );
    }
    if (callStack.includes(name)) {
      return this.unsupported(
        "const.recursive_call",
        `recursive const helper call ${[...callStack, name].join(" -> ")}`,
      );
    }
    if (fn.effects.length) {
      return this.unsupported(
        "const.runtime_call",
        `cannot call effectful function ${name} during const evaluation`,
      );
    }
    const fnLocals = new Map<string, ConstValue>();
    fn.params.forEach((param, index) => fnLocals.set(param.name, args[index] ?? { kind: "never" }));
    return this.evalBlock(fn.body, fnLocals, [...callStack, name]);
  }

  private evalBuiltin(name: string, args: ConstValue[]): ConstValue | undefined {
    if (name === "compile_error") {
      const message = args[0]?.kind === "string" ? args[0].value : "compile-time error";
      this.diagnostics.push({ code: "const.compile_error", message });
      return { kind: "never" };
    }
    if (name === "@wgsl_shader_id" || name === "wgsl_shader_id") {
      const source = args[0]?.kind === "string" ? args[0].value : undefined;
      if (source === undefined) return undefined;
      this.addShader(source);
      return { kind: "number", value: String(wgslShaderId(source)) };
    }
    const type = args[0]?.kind === "type" ? args[0] : undefined;
    if (!type) return undefined;
    if (name === "type_is_product") {
      return { kind: "bool", value: type.normalized?.kind === "product" };
    }
    if (name === "type_is_sum") return { kind: "bool", value: type.normalized?.kind === "sum" };
    if (name === "type_is_alias") return { kind: "bool", value: type.normalized?.kind === "alias" };
    if (name === "type_has_slot") {
      return { kind: "bool", value: hasProductSlot(type, args[1]) };
    }
    if (name === "type_slot_type") {
      const slot = productSlot(type, args[1]);
      if (!slot) {
        this.diagnostics.push({
          code: "const.unknown_type_slot",
          message: `unknown type slot ${literalName(args[1]) ?? "<unknown>"}`,
        });
        return { kind: "never" };
      }
      return {
        kind: "type",
        name: slot.type,
        normalized: this.types.get(slot.type)?.kind === "type"
          ? (this.types.get(slot.type) as Extract<ConstValue, { kind: "type" }>).normalized
          : undefined,
      };
    }
    if (name === "type_has_variant") {
      const variant = literalName(args[1]);
      return {
        kind: "bool",
        value: type.normalized?.kind === "sum" &&
          !!type.normalized.variants.find((item) => item.name === variant),
      };
    }
    if (name === "type_variant_has_slot") {
      const variant = literalName(args[1]);
      const slot = literalName(args[2]);
      const found = type.normalized?.kind === "sum"
        ? type.normalized.variants.find((item) => item.name === variant)
        : undefined;
      return { kind: "bool", value: !!found?.shape?.slots.find((item) => item.label === slot) };
    }
    return undefined;
  }

  private evalBinary(
    expr: Extract<Expr, { kind: "binary" }>,
    locals: Map<string, ConstValue>,
    callStack: string[],
  ): ConstValue | undefined {
    const left = this.evalExpr(expr.left, locals, callStack);
    const right = this.evalExpr(expr.right, locals, callStack);
    if (!left || !right) return undefined;
    if (expr.op === "==" || expr.op === "!=") {
      const equal = constValueKey(left) === constValueKey(right);
      return { kind: "bool", value: expr.op === "==" ? equal : !equal };
    }
    return this.unsupported("const.unsupported_expr", `operator ${expr.op} is not const-evaluable`);
  }

  private unsupported(code: string, message: string): undefined {
    this.diagnostics.push({ code, message });
    return undefined;
  }
}

function literalName(value: ConstValue | undefined): string | undefined {
  return value?.kind === "literal_type" || value?.kind === "string" ? value.value : undefined;
}

function productSlot(type: ConstValue, name: ConstValue | undefined) {
  const slotName = literalName(name);
  if (type.kind !== "type" || type.normalized?.kind !== "product") return undefined;
  return type.normalized.shape.slots.find((slot) => slot.label === slotName);
}

function hasProductSlot(type: ConstValue, name: ConstValue | undefined): boolean {
  return !!productSlot(type, name);
}

function constValueKey(value: ConstValue): string {
  return JSON.stringify(value);
}

function constPatternMatches(pattern: string, value: ConstValue): boolean {
  if (pattern === "_") return true;
  if (value.kind === "bool") return pattern === (value.value ? "true" : "false");
  if (value.kind === "number") return pattern === value.value;
  if (value.kind === "string") return pattern === JSON.stringify(value.value);
  if (value.kind === "literal_type") return pattern === `#${value.value}`;
  if (value.kind === "type") return pattern === value.name;
  return false;
}

function renderConstTypeArg(value: ConstValue): string {
  if (value.kind === "type") return value.name;
  if (value.kind === "number") return value.value;
  if (value.kind === "literal_type") return `#${value.value}`;
  return constValueKey(value);
}

function constValueToExpr(value: ConstValue): Expr | undefined {
  if (value.kind === "shape") {
    return {
      kind: "shape",
      slots: value.slots.map((slot) => ({
        label: slot.label,
        value: constValueToExpr(slot.value) ?? { kind: "var", name: "<never>" },
      })),
    };
  }
  if (value.kind === "fn") return { kind: "var", name: value.name };
  if (value.kind === "bool") {
    return { kind: "literal", literalKind: "bool", value: value.value ? "true" : "false" };
  }
  if (value.kind === "number") {
    return { kind: "literal", literalKind: "number", value: value.value };
  }
  if (value.kind === "string") {
    return { kind: "literal", literalKind: "string", value: JSON.stringify(value.value) };
  }
  if (value.kind === "literal_type") {
    return { kind: "literal", literalKind: "literalType", value: `#${value.value}` };
  }
  return undefined;
}

function specializeInferredTypeCalls(
  program: Program,
  functions: Map<string, FnDecl>,
  consts: Map<string, ConstValue>,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  const context = {
    functions,
    consts,
    diagnostics,
    types,
    typeConstructors: new Map(
      types.flatMap((decl) =>
        decl.normalized?.kind === "product" ? [[decl.normalized.constructor, decl] as const] : []
      ),
    ),
    cache: new Map<string, FnDecl>(),
    usedNames: new Set(program.declarations.map((decl) => "name" in decl ? decl.name : "")),
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn" && !decl.generated) {
      decl.body = specializeInferredBlock(decl.body, context);
    }
  }
  if (context.cache.size) program.declarations.push(...context.cache.values());
}

function specializeInferredBlock(
  block: Extract<Expr, { kind: "block" }>,
  context: {
    functions: Map<string, FnDecl>;
    consts: Map<string, ConstValue>;
    diagnostics: Diagnostic[];
    types: TypeDecl[];
    typeConstructors: Map<string, TypeDecl>;
    cache: Map<string, FnDecl>;
    usedNames: Set<string>;
  },
): Extract<Expr, { kind: "block" }> {
  return {
    ...block,
    statements: block.statements.map((stmt) =>
      stmt.kind === "let"
        ? { ...stmt, value: specializeInferredExpr(stmt.value, context) }
        : stmt.kind === "destructure_let"
        ? { ...stmt, value: specializeInferredExpr(stmt.value, context) }
        : stmt
    ),
    expr: block.expr ? specializeInferredExpr(block.expr, context) : undefined,
  };
}

function specializeInferredExpr(
  expr: Expr,
  context: {
    functions: Map<string, FnDecl>;
    consts: Map<string, ConstValue>;
    diagnostics: Diagnostic[];
    types: TypeDecl[];
    typeConstructors: Map<string, TypeDecl>;
    cache: Map<string, FnDecl>;
    usedNames: Set<string>;
  },
): Expr {
  switch (expr.kind) {
    case "call": {
      const callee = specializeInferredExpr(expr.callee, context);
      const args = expr.args.map((arg) => specializeInferredExpr(arg, context));
      const fn = callee.kind === "var" ? context.functions.get(callee.name) : undefined;
      if (!fn || !fnUsesInferredTypeVars(fn)) return { ...expr, callee, args };
      return specializeInferredCall(fn, args, context) ?? { ...expr, callee, args };
    }
    case "index":
      return {
        ...expr,
        target: specializeInferredExpr(expr.target, context),
        index: specializeInferredExpr(expr.index, context),
      };
    case "binary":
      return {
        ...expr,
        left: specializeInferredExpr(expr.left, context),
        right: specializeInferredExpr(expr.right, context),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: specializeInferredExpr(expr.value, context),
        body: specializeInferredExpr(expr.body, context),
      };
    case "match":
      return {
        ...expr,
        value: specializeInferredExpr(expr.value, context),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: specializeInferredExpr(arm.value, context),
        })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: specializeInferredExpr(slot.value, context),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: specializeInferredExpr(slot.value, context),
        })),
      };
    case "range":
      return {
        ...expr,
        start: specializeInferredExpr(expr.start, context),
        end: specializeInferredExpr(expr.end, context),
      };
    case "block":
      return specializeInferredBlock(expr, context);
    case "literal":
    case "var":
    case "placeholder":
      return expr;
  }
}

function fnUsesInferredTypeVars(fn: FnDecl): boolean {
  const text = [...fn.params.map((param) => param.type), fn.returnType ?? ""].join(" ");
  return /\b[A-Z][A-Za-z0-9_]*\b/.test(text);
}

function specializeInferredCall(
  fn: FnDecl,
  args: Expr[],
  context: {
    functions: Map<string, FnDecl>;
    consts: Map<string, ConstValue>;
    diagnostics: Diagnostic[];
    types: TypeDecl[];
    typeConstructors: Map<string, TypeDecl>;
    cache: Map<string, FnDecl>;
    usedNames: Set<string>;
  },
): Expr | undefined {
  const types = new Map<string, string>();
  const staticArgNames: string[] = [];
  fn.params.forEach((param, index) => {
    const arg = args[index];
    inferFromValuePattern(param.type, arg, types, context);
    if (param.const) {
      const proof = renderTypeProofArg(arg);
      const match = proof?.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
      const expected = param.type.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([A-Z][A-Za-z0-9_]*)\)$/);
      if (match && expected && match[1] === expected[1]) {
        types.set(expected[2], match[2].trim());
        staticArgNames.push(proof!);
        return;
      }
      if (arg?.kind === "var") {
        const value = context.consts.get(arg.name);
        if (value?.kind === "fn") {
          inferFnTypeArgs(param.type, context.functions.get(value.name), types);
        }
        if (context.functions.has(arg.name)) {
          inferFnTypeArgs(param.type, context.functions.get(arg.name), types);
        }
        staticArgNames.push(arg.name);
      }
    }
  });
  fn.params.forEach((param, index) => {
    const arg = args[index];
    if (param.const && arg?.kind === "var") {
      const value = context.consts.get(arg.name);
      if (value?.kind === "fn") {
        inferFnTypeArgs(
          substituteTypeVars(param.type, types),
          context.functions.get(value.name),
          types,
        );
      }
      const directFn = context.functions.get(arg.name);
      if (directFn) inferFnTypeArgs(substituteTypeVars(param.type, types), directFn, types);
    }
  });
  if (![...collectTypeVars(fn)].every((name) => types.has(name))) return undefined;
  const key = `${fn.name}\0${[...types].map(([k, v]) => `${k}=${v}`).join("\0")}\0${
    staticArgNames.join("\0")
  }`;
  let specialized = context.cache.get(key);
  if (!specialized) {
    const name = allocateSpecializationName(
      fn.name,
      [...types.values(), ...staticArgNames],
      context.usedNames,
    );
    const staticNames = new Map<string, string>();
    fn.params.forEach((param, index) => {
      if (param.const && args[index]?.kind === "var") {
        staticNames.set(param.name, (args[index] as Extract<Expr, { kind: "var" }>).name);
      }
    });
    specialized = {
      ...fn,
      public: false,
      name,
      params: fn.params.filter((param) => !param.const).map((param) => ({
        ...param,
        type: substituteTypeVars(param.type, types),
      })),
      returnType: fn.returnType ? substituteTypeVars(fn.returnType, types) : undefined,
      body: substituteInferredExpr(
        cloneExpr(fn.body),
        types,
        staticNames,
        new Map(),
        context,
      ) as Extract<
        Expr,
        { kind: "block" }
      >,
      generated: true,
    };
    specialized.generatedInlineable = isInlineableGeneratedSpecializationSource(fn) &&
      !exprCallsFunction(specialized.body, specialized.name);
    context.cache.set(key, specialized);
    context.functions.set(name, specialized);
  }
  return {
    kind: "call",
    callee: { kind: "var", name: specialized.name },
    args: args.filter((_arg, index) => !fn.params[index]?.const),
  };
}

function inferFromValuePattern(
  pattern: string,
  arg: Expr | undefined,
  types: Map<string, string>,
  context: {
    functions: Map<string, FnDecl>;
    typeConstructors: Map<string, TypeDecl>;
  },
) {
  if (!arg) return;
  if (arg.kind === "product_constructor") {
    const decl = context.typeConstructors.get(arg.constructor);
    if (decl) {
      bindTypePattern(pattern, renderConstructedType(decl, arg, context), types);
    }
    return;
  }
  if (arg.kind === "literal") {
    const literalType = arg.inferredType ?? (arg.literalKind === "number" ? "i32" : undefined);
    bindTypePattern(pattern, literalType, types);
    return;
  }
  if (arg.kind === "var") {
    const directFn = context.functions.get(arg.name);
    if (directFn) inferFnTypeArgs(pattern, directFn, types);
  }
}

function renderConstructedType(
  decl: TypeDecl,
  arg: Extract<Expr, { kind: "product_constructor" }>,
  context: {
    functions: Map<string, FnDecl>;
    typeConstructors: Map<string, TypeDecl>;
  },
): string {
  if (!decl.params.length) return decl.name;
  const bindings = new Map<string, string>();
  const slots = decl.normalized?.kind === "product" ? decl.normalized.shape.slots : [];
  for (const slot of arg.slots) {
    if (!slot.label) continue;
    const expected = slots.find((item) => item.label === slot.label)?.type;
    const actual = inferExprType(slot.value, context);
    bindTypePattern(expected, actual, bindings);
  }
  if (!decl.params.every((param) => bindings.has(param.name))) return decl.name;
  return `${decl.name}(${decl.params.map((param) => bindings.get(param.name)!).join(", ")})`;
}

function inferExprType(
  expr: Expr,
  context: {
    functions: Map<string, FnDecl>;
    typeConstructors: Map<string, TypeDecl>;
  },
): string | undefined {
  if (expr.kind === "literal") {
    if (expr.inferredType) return expr.inferredType;
    if (expr.literalKind === "number") return "i32";
    if (expr.literalKind === "bool") return "bool";
    if (expr.literalKind === "string" || expr.literalKind === "multiline") return "string";
    if (expr.literalKind === "char") return "char";
    if (expr.literalKind === "literalType") return "literal";
  }
  if (expr.kind === "product_constructor") {
    const decl = context.typeConstructors.get(expr.constructor);
    return decl ? renderConstructedType(decl, expr, context) : undefined;
  }
  if (expr.kind === "var") {
    return context.functions.get(expr.name)
      ? renderFnType(context.functions.get(expr.name)!)
      : undefined;
  }
  return undefined;
}

function collectTypeVars(fn: FnDecl): Set<string> {
  const vars = new Set<string>();
  for (const text of [...fn.params.map((param) => param.type), fn.returnType ?? ""]) {
    for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) vars.add(match[1]);
    for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
      if (match[1].length > 1) vars.delete(match[1]);
    }
  }
  return vars;
}

function literalConstValue(expr: Extract<Expr, { kind: "literal" }>): ConstValue | undefined {
  if (expr.literalKind === "bool") return { kind: "bool", value: expr.value === "true" };
  if (expr.literalKind === "number") return { kind: "number", value: expr.value };
  if (expr.literalKind === "string") return { kind: "string", value: expr.value.slice(1, -1) };
  if (expr.literalKind === "multiline") return { kind: "string", value: expr.value };
  if (expr.literalKind === "literalType") {
    return { kind: "literal_type", value: expr.value.slice(1) };
  }
  return undefined;
}

function literalValueMatchesType(value: ConstValue, expectedType: string): boolean {
  const type = expectedType.trim();
  if (type === "literal") return true;
  if (value.kind === "bool") return type === "bool";
  if (value.kind === "number") return type === "i32" || type === "numeric" || type === "count";
  if (value.kind === "string") return type === "string" || type === "multiline";
  if (value.kind === "literal_type") return type === "literal";
  return false;
}

function literalConstName(value: ConstValue): string {
  if (value.kind === "bool") return value.value ? "true" : "false";
  if (value.kind === "number") return value.value;
  if (value.kind === "string") return `str_${wgslShaderId(value.value)}`;
  if (value.kind === "literal_type") return `#${value.value}`;
  return constValueKey(value);
}

function stringLiteralValue(expr: Expr | undefined): string | undefined {
  if (expr?.kind !== "literal") return undefined;
  if (expr.literalKind === "string") return expr.value.slice(1, -1);
  if (expr.literalKind === "multiline") return expr.value;
  return undefined;
}

function inferFnTypeArgs(expected: string, actual: FnDecl | undefined, types: Map<string, string>) {
  if (!actual) return;
  const expectedSig = parseFnSignature(expected);
  if (!expectedSig) return;
  expectedSig.params.forEach((type, index) =>
    bindTypePattern(type, actual.params[index]?.type, types)
  );
  bindTypePattern(expectedSig.returnType, actual.returnType, types);
}

function parseFnSignature(source: string): { params: string[]; returnType: string } | undefined {
  const match = source.match(/^fn\((.*)\)\s*->\s*(.+)$/);
  if (!match) return undefined;
  return {
    params: match[1].trim() ? match[1].split(",").map((part) => part.split(":").pop()!.trim()) : [],
    returnType: match[2].trim(),
  };
}

function bindTypePattern(
  pattern: string | undefined,
  actual: string | undefined,
  types: Map<string, string>,
) {
  if (!pattern || !actual) return;
  const pCall = pattern.match(/^([A-Z][A-Za-z0-9_]*)\((.*)\)$/);
  const aCall = actual.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
  if (pCall && aCall) {
    types.set(pCall[1], aCall[1]);
    bindTypePattern(pCall[2].trim(), aCall[2].trim(), types);
    return;
  }
  if (/^[A-Z][A-Za-z0-9_]*$/.test(pattern)) types.set(pattern, actual);
}

function substituteTypeVars(source: string, types: Map<string, string>): string {
  let result = source;
  for (const [name, type] of types) {
    result = result.replace(new RegExp(`\\b${name}\\b`, "g"), type);
  }
  return result;
}

function substituteTypeVarsInTypeExpr(expr: TypeExpr, types: Map<string, string>): TypeExpr {
  switch (expr.kind) {
    case "type_ref":
      return types.has(expr.name) ? parseAnnotationType(types.get(expr.name)!) ?? expr : expr;
    case "type_call":
      return {
        ...expr,
        callee: substituteTypeVarsInTypeExpr(expr.callee, types),
        args: expr.args.map((arg) => substituteTypeVarsInTypeExpr(arg, types)),
      };
    case "type_match":
      return {
        ...expr,
        value: substituteTypeVarsInTypeExpr(expr.value, types),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: substituteTypeVarsInTypeExpr(arm.value, types),
        })),
      };
    case "type_binary":
      return {
        ...expr,
        left: substituteTypeVarsInTypeExpr(expr.left, types),
        right: substituteTypeVarsInTypeExpr(expr.right, types),
      };
    case "type_shape":
      return {
        ...expr,
        shape: {
          ...expr.shape,
          slots: expr.shape.slots.map((slot) => ({
            ...slot,
            type: substituteTypeVarsInTypeExpr(slot.type, types),
          })),
        },
      };
    case "type_fn":
      return { ...expr, source: substituteTypeVars(expr.source, types) };
    case "type_static_ref":
    case "type_bool":
    case "type_number":
    case "type_string":
    case "type_literal":
      return expr;
  }
}

function substituteInferredExpr(
  expr: Expr,
  types: Map<string, string>,
  staticNames: Map<string, string>,
  proofTypes = new Map<string, TypeEvalValue>(),
  context?: {
    functions: Map<string, FnDecl>;
    diagnostics: Diagnostic[];
    types: TypeDecl[];
  },
): Expr {
  if (expr.kind === "var") {
    const dot = expr.name.indexOf(".");
    if (dot > 0) {
      const base = expr.name.slice(0, dot);
      const member = expr.name.slice(dot + 1);
      const proofType = proofTypes.get(base);
      const attached = proofType
        ? typeMember(proofType, { kind: "literal", value: member })
        : undefined;
      if (attached) return { kind: "var", name: attached.target };
      const type = types.get(base);
      if (type) return { kind: "var", name: `${type}.${member}` };
    }
    const staticName = staticNames.get(expr.name);
    return staticName ? { kind: "var", name: staticName } : expr;
  }
  if (expr.kind === "call") {
    return {
      ...expr,
      callee: substituteInferredExpr(expr.callee, types, staticNames, proofTypes, context),
      args: expr.args.map((arg) =>
        substituteInferredExpr(arg, types, staticNames, proofTypes, context)
      ),
    };
  }
  if (expr.kind === "index") {
    return {
      ...expr,
      target: substituteInferredExpr(expr.target, types, staticNames, proofTypes, context),
      index: substituteInferredExpr(expr.index, types, staticNames, proofTypes, context),
    };
  }
  if (expr.kind === "binary") {
    return {
      ...expr,
      left: substituteInferredExpr(expr.left, types, staticNames, proofTypes, context),
      right: substituteInferredExpr(expr.right, types, staticNames, proofTypes, context),
    };
  }
  if (expr.kind === "pipe_bind") {
    return {
      ...expr,
      value: substituteInferredExpr(expr.value, types, staticNames, proofTypes, context),
      body: substituteInferredExpr(expr.body, types, staticNames, proofTypes, context),
    };
  }
  if (expr.kind === "match") {
    return {
      ...expr,
      value: substituteInferredExpr(expr.value, types, staticNames),
      arms: expr.arms.map((arm) => ({
        ...arm,
        value: substituteInferredExpr(arm.value, types, staticNames, proofTypes, context),
      })),
    };
  }
  if (expr.kind === "shape") {
    return {
      ...expr,
      slots: expr.slots.map((slot) => ({
        ...slot,
        value: substituteInferredExpr(slot.value, types, staticNames, proofTypes, context),
      })),
    };
  }
  if (expr.kind === "product_constructor") {
    return {
      ...expr,
      slots: expr.slots.map((slot) => ({
        ...slot,
        value: substituteInferredExpr(slot.value, types, staticNames, proofTypes, context),
      })),
    };
  }
  if (expr.kind === "range") {
    return {
      ...expr,
      start: substituteInferredExpr(expr.start, types, staticNames, proofTypes, context),
      end: substituteInferredExpr(expr.end, types, staticNames, proofTypes, context),
    };
  }
  if (expr.kind === "block") {
    const typeEvalLocals = new Map<string, TypeEvalValue>();
    const blockProofTypes = new Map(proofTypes);
    const typesByName = new Map((context?.types ?? []).map((decl) => [decl.name, decl]));
    const typeEvaluator = context
      ? new TypeEvaluator(
        typesByName,
        context.functions,
        new Map(),
        context.diagnostics,
        shaderManifestEntry,
      )
      : undefined;
    return {
      ...expr,
      statements: expr.statements.flatMap((stmt) => {
        if (stmt.kind === "proof_const") {
          const value = typeEvaluator?.eval(
            substituteTypeVarsInTypeExpr(stmt.value, types),
            typeEvalLocals,
          );
          if (!value || value.kind === "never") {
            context?.diagnostics.push({
              code: "type.proof_const",
              message: `proof const ${stmt.name} could not be evaluated`,
            });
          } else {
            typeEvalLocals.set(stmt.name, value);
            if (value.kind === "type") blockProofTypes.set(stmt.name, value);
          }
          return [];
        }
        return [
          stmt.kind === "let"
            ? {
              ...stmt,
              value: substituteInferredExpr(
                stmt.value,
                types,
                staticNames,
                blockProofTypes,
                context,
              ),
            }
            : stmt,
        ];
      }),
      expr: expr.expr
        ? substituteInferredExpr(expr.expr, types, staticNames, blockProofTypes, context)
        : undefined,
    };
  }
  return expr;
}

function specializeConstParamCalls(
  program: Program,
  functions: Map<string, FnDecl>,
  consts: Map<string, ConstValue>,
  addShader: (source: string) => ShaderManifestEntry,
  diagnostics: Diagnostic[],
) {
  const context: ConstSpecializationContext = {
    functions,
    consts,
    diagnostics,
    addShader,
    cache: new Map(),
    usedNames: new Set(program.declarations.map((decl) => "name" in decl ? decl.name : "")),
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn" && !decl.params.some((param) => param.const)) {
      specializeBlock(decl.body, context);
    } else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = specializeExpr(decl.value, context);
    }
  }
  if (context.cache.size > 0) program.declarations.push(...context.cache.values());
}

function specializeBlock(
  block: Extract<Expr, { kind: "block" }>,
  context: ConstSpecializationContext,
) {
  for (const stmt of block.statements) {
    if (stmt.kind === "let") {
      stmt.value = specializeExpr(stmt.value, context);
    } else if (stmt.kind === "destructure_let") {
      stmt.value = specializeExpr(stmt.value, context);
    }
  }
  if (block.expr) block.expr = specializeExpr(block.expr, context);
}

function specializeExpr(
  expr: Expr,
  context: ConstSpecializationContext,
): Expr {
  switch (expr.kind) {
    case "call": {
      const callee = specializeExpr(expr.callee, context);
      const args = expr.args.map((arg) => specializeExpr(arg, context));
      const direct = callee.kind === "var" ? context.functions.get(callee.name) : undefined;
      if (!direct?.params.some((param) => param.const)) return { ...expr, callee, args };
      return specializeConstParamCall(direct, args, context) ?? { ...expr, callee, args };
    }
    case "index":
      return {
        ...expr,
        target: specializeExpr(expr.target, context),
        index: specializeExpr(expr.index, context),
      };
    case "binary":
      return {
        ...expr,
        left: specializeExpr(expr.left, context),
        right: specializeExpr(expr.right, context),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: specializeExpr(expr.value, context),
        body: specializeExpr(expr.body, context),
      };
    case "match":
      return {
        ...expr,
        value: specializeExpr(expr.value, context),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: specializeExpr(arm.value, context),
        })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: specializeExpr(slot.value, context),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: specializeExpr(slot.value, context),
        })),
      };
    case "range":
      return {
        ...expr,
        start: specializeExpr(expr.start, context),
        end: specializeExpr(expr.end, context),
      };
    case "block": {
      const block = cloneExpr(expr) as Extract<Expr, { kind: "block" }>;
      specializeBlock(block, context);
      return block;
    }
    case "literal":
    case "var":
    case "placeholder":
      return expr;
  }
}

interface ConstSpecializationContext {
  functions: Map<string, FnDecl>;
  consts: Map<string, ConstValue>;
  diagnostics: Diagnostic[];
  addShader: (source: string) => ShaderManifestEntry;
  cache: Map<string, FnDecl>;
  usedNames: Set<string>;
}

function specializeConstParamCall(
  fn: FnDecl,
  args: Expr[],
  context: ConstSpecializationContext,
): Expr | undefined {
  const staticValues = new Map<string, ConstValue>();
  const staticArgNames = new Map<string, string>();
  const constArgNames: string[] = [];
  const runtimeArgs: Expr[] = [];
  for (let index = 0; index < fn.params.length; index++) {
    const param = fn.params[index];
    const arg = args[index] ?? { kind: "var" as const, name: "<missing>" };
    if (param.const) {
      const expectedType = substituteConstParamType(param.type, staticValues);
      const staticArg = staticConstArgValue(arg, expectedType, context);
      if (!staticArg) {
        context.diagnostics.push({
          code: "const.static_param_arg",
          message:
            `const parameter ${param.name} requires a top-level const argument or matching type proof`,
        });
        return undefined;
      }
      staticValues.set(param.name, staticArg.value);
      staticArgNames.set(param.name, staticArg.name);
      constArgNames.push(staticArg.name);
    } else {
      runtimeArgs.push(arg);
    }
  }
  const key = `${fn.name}\0${constArgNames.join("\0")}`;
  let specialized = context.cache.get(key);
  if (!specialized) {
    const specializedName = allocateSpecializationName(fn.name, constArgNames, context.usedNames);
    specialized = {
      kind: "fn",
      public: false,
      name: specializedName,
      params: fn.params.filter((param) => !param.const).map((param) => ({
        ...param,
        type: substituteConstParamType(param.type, staticValues),
      })),
      returnType: fn.returnType ? substituteConstParamType(fn.returnType, staticValues) : undefined,
      effects: [...fn.effects],
      body: cloneExpr(fn.body) as Extract<Expr, { kind: "block" }>,
      generated: true,
      primitiveId: fn.primitiveId,
    };
    context.cache.set(key, specialized);
    context.functions.set(specialized.name, specialized);
    specialized.body = substituteSpecializedExpr(
      specialized.body,
      new Map(),
      staticValues,
      staticArgNames,
      context,
    ) as Extract<Expr, { kind: "block" }>;
    specialized.generatedInlineable = isInlineableGeneratedSpecializationSource(fn) &&
      !exprCallsFunction(specialized.body, specialized.name);
  }
  return { kind: "call", callee: { kind: "var", name: specialized.name }, args: runtimeArgs };
}

function isInlineableGeneratedSpecializationSource(fn: FnDecl): boolean {
  return fn.memberOf?.owner === "iter" || fn.memberOf?.owner === "compact_iter";
}

function exprCallsFunction(expr: Expr | undefined, name: string): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "call":
      return (expr.callee.kind === "var" && expr.callee.name === name) ||
        exprCallsFunction(expr.callee, name) ||
        expr.args.some((arg) => exprCallsFunction(arg, name));
    case "index":
      return exprCallsFunction(expr.target, name) || exprCallsFunction(expr.index, name);
    case "binary":
      return exprCallsFunction(expr.left, name) || exprCallsFunction(expr.right, name);
    case "pipe_bind":
      return exprCallsFunction(expr.value, name) || exprCallsFunction(expr.body, name);
    case "match":
      return exprCallsFunction(expr.value, name) ||
        expr.arms.some((arm) => exprCallsFunction(arm.value, name));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) => exprCallsFunction(slot.value, name));
    case "range":
      return exprCallsFunction(expr.start, name) || exprCallsFunction(expr.end, name);
    case "block":
      return expr.statements.some((stmt) =>
        (stmt.kind === "let" || stmt.kind === "destructure_let") &&
        exprCallsFunction(stmt.value, name)
      ) || exprCallsFunction(expr.expr, name);
    case "literal":
    case "var":
    case "placeholder":
      return false;
  }
}

function staticConstArgValue(
  arg: Expr,
  expectedType: string,
  context: ConstSpecializationContext,
): { name: string; value: ConstValue } | undefined {
  const helper = synthesizePlaceholderHelper(arg, expectedType, context);
  if (helper) return helper;
  if (arg.kind === "var") {
    const value = context.consts.get(arg.name);
    if (value) return { name: arg.name, value };
    if (expectedType.trim().startsWith("fn(") && context.functions.has(arg.name)) {
      return { name: arg.name, value: { kind: "fn", name: arg.name } };
    }
  }
  if (arg.kind === "literal") {
    const value = literalConstValue(arg);
    if (value && literalValueMatchesType(value, expectedType)) {
      return { name: literalConstName(value), value };
    }
  }
  const proof = renderTypeProofArg(arg);
  if (proof && (proof === expectedType || expectedType === "type")) {
    return { name: proof, value: { kind: "type", name: proof } };
  }
  return undefined;
}

function synthesizePlaceholderHelper(
  arg: Expr,
  expectedType: string,
  context: ConstSpecializationContext,
): { name: string; value: ConstValue } | undefined {
  if (!exprContainsPlaceholder(arg)) return undefined;
  const match = expectedType.trim().match(
    /^fn\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)\)\s*->\s*(.+)$/,
  );
  if (!match) {
    context.diagnostics.push({
      code: "const.placeholder_expected_fn",
      message: "$ helper requires an expected unary const fn parameter",
    });
    return undefined;
  }
  const [, paramName, paramType, returnType] = match;
  const captures = [...exprRuntimeCaptures(arg)].filter((name) =>
    name !== "$" && name !== paramName && !context.functions.has(name) && !context.consts.has(name)
  );
  if (captures.length) {
    context.diagnostics.push({
      code: "const.placeholder_capture",
      message: `$ helper cannot capture runtime local ${captures[0]}`,
    });
    return undefined;
  }
  const body = replacePlaceholder(arg, { kind: "var", name: paramName });
  const key = `__placeholder\0${expectedType}\0${JSON.stringify(body)}`;
  let fn = context.cache.get(key);
  if (!fn) {
    const name = allocateSpecializationName(
      "__dollar",
      [expectedType, JSON.stringify(body)],
      context.usedNames,
    );
    fn = {
      kind: "fn",
      public: false,
      name,
      params: [{ name: paramName, type: paramType.trim() }],
      returnType: returnType.trim(),
      effects: [],
      body: { kind: "block", statements: [], expr: body },
      generated: true,
    };
    context.cache.set(key, fn);
    context.functions.set(name, fn);
  }
  return { name: fn.name, value: { kind: "fn", name: fn.name } };
}

function exprContainsPlaceholder(expr: Expr): boolean {
  if (expr.kind === "placeholder") return true;
  return exprChildren(expr).some(exprContainsPlaceholder);
}

function exprRuntimeCaptures(expr: Expr): Set<string> {
  const captures = new Set<string>();
  const visit = (item: Expr) => {
    if (item.kind === "var") captures.add(item.name);
    for (const child of exprChildren(item)) visit(child);
  };
  visit(expr);
  return captures;
}

function replacePlaceholder(expr: Expr, replacement: Expr): Expr {
  if (expr.kind === "placeholder") return cloneExpr(replacement);
  switch (expr.kind) {
    case "call":
      return {
        ...expr,
        callee: replacePlaceholder(expr.callee, replacement),
        args: expr.args.map((arg) => replacePlaceholder(arg, replacement)),
      };
    case "index":
      return {
        ...expr,
        target: replacePlaceholder(expr.target, replacement),
        index: replacePlaceholder(expr.index, replacement),
      };
    case "binary":
      return {
        ...expr,
        left: replacePlaceholder(expr.left, replacement),
        right: replacePlaceholder(expr.right, replacement),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: replacePlaceholder(expr.value, replacement),
        body: replacePlaceholder(expr.body, replacement),
      };
    case "match":
      return {
        ...expr,
        value: replacePlaceholder(expr.value, replacement),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: replacePlaceholder(arm.value, replacement),
        })),
      };
    case "shape":
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: replacePlaceholder(slot.value, replacement),
        })),
      };
    case "range":
      return {
        ...expr,
        start: replacePlaceholder(expr.start, replacement),
        end: replacePlaceholder(expr.end, replacement),
      };
    case "block":
      return {
        ...expr,
        statements: expr.statements.map((stmt) =>
          stmt.kind === "let"
            ? { ...stmt, value: replacePlaceholder(stmt.value, replacement) }
            : stmt.kind === "destructure_let"
            ? { ...stmt, value: replacePlaceholder(stmt.value, replacement) }
            : stmt
        ),
        expr: expr.expr ? replacePlaceholder(expr.expr, replacement) : undefined,
      };
    case "literal":
    case "var":
      return expr;
  }
}

function exprChildren(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "call":
      return [expr.callee, ...expr.args];
    case "index":
      return [expr.target, expr.index];
    case "binary":
      return [expr.left, expr.right];
    case "pipe_bind":
      return [expr.value, expr.body];
    case "match":
      return [expr.value, ...expr.arms.map((arm) => arm.value)];
    case "shape":
    case "product_constructor":
      return expr.slots.map((slot) => slot.value);
    case "range":
      return [expr.start, expr.end];
    case "block":
      return [
        ...expr.statements.flatMap((stmt) =>
          stmt.kind === "let" ? [stmt.value] : stmt.kind === "destructure_let" ? [stmt.value] : []
        ),
        ...(expr.expr ? [expr.expr] : []),
      ];
    case "literal":
    case "var":
    case "placeholder":
      return [];
  }
}

function substituteConstParamType(source: string, values: Map<string, ConstValue>): string {
  let result = source;
  for (const [name, value] of values) {
    if (value.kind === "type") {
      result = result.replace(new RegExp(`\\b${name}\\b`, "g"), value.name);
    }
  }
  return result;
}

function renderTypeProofArg(expr: Expr): string | undefined {
  if (expr.kind === "var") return expr.name;
  if (expr.kind === "call" && expr.callee.kind === "var") {
    const args = expr.args.map(renderTypeProofArg);
    if (args.some((arg) => arg === undefined)) return undefined;
    return `${expr.callee.name}(${args.join(", ")})`;
  }
  return undefined;
}

function allocateSpecializationName(
  fnName: string,
  constArgNames: string[],
  usedNames: Set<string>,
): string {
  const base = sanitizeIdentifier(`${fnName}__${constArgNames.join("__")}`);
  let name = base;
  let suffix = 2;
  while (usedNames.has(name)) name = `${base}__${suffix++}`;
  usedNames.add(name);
  return name;
}

function sanitizeIdentifier(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_]/g, "_");
}

function substituteSpecializedExpr(
  expr: Expr,
  values: Map<string, Expr>,
  staticValues: Map<string, ConstValue>,
  staticArgNames: Map<string, string>,
  context: ConstSpecializationContext,
): Expr {
  switch (expr.kind) {
    case "var": {
      const value = values.get(expr.name);
      if (value) return cloneExpr(value);
      const staticValue = staticValues.get(expr.name);
      if (
        staticValue && (staticValue.kind === "bool" || staticValue.kind === "number" ||
          staticValue.kind === "string" || staticValue.kind === "literal_type")
      ) {
        return constValueToExpr(staticValue) ?? expr;
      }
      const staticArgName = staticArgNames.get(expr.name);
      if (staticArgName) return { kind: "var", name: staticArgName };
      const dot = expr.name.indexOf(".");
      if (dot > 0) {
        const base = expr.name.slice(0, dot);
        const field = expr.name.slice(dot + 1);
        const staticValue = staticValues.get(base);
        if (staticValue?.kind === "shape") {
          const slot = staticValue.slots.find((item) => item.label === field);
          if (slot?.value.kind === "fn") return { kind: "var", name: slot.value.name };
          const slotExpr = slot ? constValueToExpr(slot.value) : undefined;
          if (slotExpr) return slotExpr;
        }
        if (staticValue?.kind === "type") {
          return { kind: "var", name: `${staticValue.name}.${field}` };
        }
      }
      return expr;
    }
    case "call": {
      const callee = substituteSpecializedExpr(
        expr.callee,
        values,
        staticValues,
        staticArgNames,
        context,
      );
      const args = expr.args.map((arg) =>
        substituteSpecializedExpr(arg, values, staticValues, staticArgNames, context)
      );
      const direct = callee.kind === "var" ? context.functions.get(callee.name) : undefined;
      if (direct?.params.some((param) => param.const)) {
        return specializeConstParamCall(direct, args, context) ?? { ...expr, callee, args };
      }
      if (callee.kind === "var" && callee.name === "@wgsl_shader_id") {
        const source = stringLiteralValue(args[0]);
        if (source !== undefined) {
          context.addShader(source);
          return { kind: "literal", literalKind: "number", value: String(wgslShaderId(source)) };
        }
      }
      return { ...expr, callee, args };
    }
    case "index":
      return {
        ...expr,
        target: substituteSpecializedExpr(
          expr.target,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        index: substituteSpecializedExpr(
          expr.index,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
      };
    case "binary":
      return {
        ...expr,
        left: substituteSpecializedExpr(
          expr.left,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        right: substituteSpecializedExpr(
          expr.right,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
      };
    case "pipe_bind":
      return {
        ...expr,
        value: substituteSpecializedExpr(
          expr.value,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        body: substituteSpecializedExpr(
          expr.body,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
      };
    case "match":
      return {
        ...expr,
        value: substituteSpecializedExpr(
          expr.value,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: substituteSpecializedExpr(
            arm.value,
            values,
            staticValues,
            staticArgNames,
            context,
          ),
        })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: substituteSpecializedExpr(
            slot.value,
            values,
            staticValues,
            staticArgNames,
            context,
          ),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: substituteSpecializedExpr(
            slot.value,
            values,
            staticValues,
            staticArgNames,
            context,
          ),
        })),
      };
    case "range":
      return {
        ...expr,
        start: substituteSpecializedExpr(
          expr.start,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        end: substituteSpecializedExpr(
          expr.end,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
      };
    case "block": {
      const scopedValues = new Map(values);
      const scopedStaticValues = new Map(staticValues);
      const scopedStaticArgNames = new Map(staticArgNames);
      const statements: Statement[] = expr.statements.flatMap((stmt): Statement[] => {
        if (stmt.kind === "proof_const") return [];
        if (stmt.kind === "fork_let") return [stmt];
        for (const name of boundNames(stmt)) {
          scopedValues.delete(name);
          scopedStaticValues.delete(name);
          scopedStaticArgNames.delete(name);
        }
        return [{
          ...stmt,
          value: substituteSpecializedExpr(
            stmt.value,
            scopedValues,
            scopedStaticValues,
            scopedStaticArgNames,
            context,
          ),
        }];
      });
      return {
        ...expr,
        statements,
        expr: expr.expr
          ? substituteSpecializedExpr(
            expr.expr,
            scopedValues,
            scopedStaticValues,
            scopedStaticArgNames,
            context,
          )
          : undefined,
      };
    }
    case "literal":
    case "placeholder":
      return expr;
  }
}

function cloneExpr<T extends Expr>(expr: T): T {
  return structuredClone(expr);
}

function evaluateTypeDecls(types: TypeDecl[], diagnostics: Diagnostic[]) {
  const byName = new Map(types.map((decl) => [decl.name, decl]));
  const state = new Map<string, "evaluating" | "done">();

  const evaluate = (decl: TypeDecl): TypeBody | undefined => {
    const current = state.get(decl.name);
    if (current === "evaluating") {
      diagnostics.push({
        code: "type.recursive_type_fn",
        message: `recursive type function ${decl.name}`,
      });
      return undefined;
    }
    if (current === "done") return decl.normalized;

    state.set(decl.name, "evaluating");
    const clauses = decl.clauses ?? [decl];
    for (const clause of clauses) {
      const kinds = new Map<string, TypeParamKind>(
        clause.params.map((param) => [param.name, param.kind]),
      );
      const locals = new Map(clause.body.statements.map((stmt) => [stmt.name, stmt.value]));
      for (const stmt of clause.body.statements) {
        inferKinds(stmt.value, clause, kinds, locals, byName, diagnostics);
      }
      if (clause.body.expr) {
        inferKinds(clause.body.expr, clause, kinds, locals, byName, diagnostics);
      }
      clause.paramKinds = Object.fromEntries(kinds);
    }
    decl.paramKinds = clauses[0].paramKinds;
    const locals = new Map(decl.body.statements.map((stmt) => [stmt.name, stmt.value]));
    decl.normalized = decl.body.expr
      ? normalizeTop(decl, decl.body.expr, locals, byName, diagnostics, evaluate)
      : {
        kind: "product",
        name: decl.name,
        constructor: pascalCase(decl.name),
        shape: { slots: [] },
      };
    checkTypeResultKind(decl, decl.normalized, diagnostics);
    state.set(decl.name, "done");
    return decl.normalized;
  };

  for (const decl of types) evaluate(decl);
}

function checkTypeFunctionCasing(
  types: TypeDecl[],
  program: Program,
  diagnostics: Diagnostic[],
) {
  const lowerNames = new Set(types.map((decl) => decl.name));
  const lowerByPascal = new Map(
    types.map((decl) => [pascalCase(decl.name), decl.name] as const),
  );
  for (const decl of types) {
    if (!startsLowercase(decl.name)) {
      diagnostics.push({
        code: "type.type_fn_casing",
        message: `type function ${decl.name} must start lowercase; use ${lowerFirst(decl.name)}`,
      });
    }
    for (const param of decl.params) {
      if (param.name.startsWith("__type_pattern_")) continue;
      if (!startsUppercase(param.name)) {
        diagnostics.push({
          code: "type.type_param_casing",
          message: `type parameter ${param.name} must start uppercase; use ${
            upperFirst(param.name)
          }`,
        });
      }
    }
  }
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      for (const param of decl.params) {
        checkTypeAnnotationCasing(param.type, lowerNames, lowerByPascal, diagnostics);
      }
      if (decl.returnType) {
        checkTypeAnnotationCasing(decl.returnType, lowerNames, lowerByPascal, diagnostics);
      }
      checkBlockTypeAnnotationCasing(decl.body, lowerNames, lowerByPascal, diagnostics);
    } else if ((decl.kind === "let" || decl.kind === "const") && decl.type) {
      checkTypeAnnotationCasing(decl.type, lowerNames, lowerByPascal, diagnostics);
    }
  }
}

function checkBlockTypeAnnotationCasing(
  block: Extract<Expr, { kind: "block" }>,
  lowerNames: Set<string>,
  lowerByPascal: Map<string, string>,
  diagnostics: Diagnostic[],
) {
  for (const stmt of block.statements) {
    if (stmt.kind === "let" && stmt.type) {
      checkTypeAnnotationCasing(stmt.type, lowerNames, lowerByPascal, diagnostics);
    }
    if (stmt.kind === "let") {
      checkExprTypeAnnotationCasing(stmt.value, lowerNames, lowerByPascal, diagnostics);
    }
  }
  if (block.expr) checkExprTypeAnnotationCasing(block.expr, lowerNames, lowerByPascal, diagnostics);
}

function checkExprTypeAnnotationCasing(
  expr: Expr,
  lowerNames: Set<string>,
  lowerByPascal: Map<string, string>,
  diagnostics: Diagnostic[],
) {
  if (expr.kind === "block") {
    checkBlockTypeAnnotationCasing(expr, lowerNames, lowerByPascal, diagnostics);
  } else if (expr.kind === "match") {
    checkExprTypeAnnotationCasing(expr.value, lowerNames, lowerByPascal, diagnostics);
    for (const arm of expr.arms) {
      checkExprTypeAnnotationCasing(arm.value, lowerNames, lowerByPascal, diagnostics);
    }
  }
}

function checkTypeExprCasing(
  expr: TypeExpr | undefined,
  lowerNames: Set<string>,
  lowerByPascal: Map<string, string>,
  diagnostics: Diagnostic[],
) {
  if (!expr) return;
  if (expr.kind === "type_ref") {
    diagnosePascalTypeFunctionRef(expr.name, lowerNames, lowerByPascal, diagnostics);
  } else if (expr.kind === "type_call") {
    checkTypeExprCasing(expr.callee, lowerNames, lowerByPascal, diagnostics);
    for (const arg of expr.args) checkTypeExprCasing(arg, lowerNames, lowerByPascal, diagnostics);
  } else if (expr.kind === "type_shape") {
    for (const slot of expr.shape.slots) {
      checkTypeExprCasing(slot.type, lowerNames, lowerByPascal, diagnostics);
    }
  } else if (expr.kind === "type_match") {
    checkTypeExprCasing(expr.value, lowerNames, lowerByPascal, diagnostics);
    for (const arm of expr.arms) {
      checkTypeExprCasing(arm.value, lowerNames, lowerByPascal, diagnostics);
    }
  } else if (expr.kind === "type_binary") {
    checkTypeExprCasing(expr.left, lowerNames, lowerByPascal, diagnostics);
    checkTypeExprCasing(expr.right, lowerNames, lowerByPascal, diagnostics);
  }
}

function checkTypeAnnotationCasing(
  annotation: string,
  lowerNames: Set<string>,
  lowerByPascal: Map<string, string>,
  diagnostics: Diagnostic[],
) {
  for (const name of annotation.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (/^u[0-9]+$/.test(name) && !isUnsignedIntegerType(name)) {
      diagnostics.push({
        code: "type.unknown_type",
        message: `unknown unsigned integer type ${name}; use u1 through u64`,
      });
    }
    diagnosePascalTypeFunctionRef(name, lowerNames, lowerByPascal, diagnostics);
  }
}

function diagnosePascalTypeFunctionRef(
  name: string,
  lowerNames: Set<string>,
  lowerByPascal: Map<string, string>,
  diagnostics: Diagnostic[],
) {
  if (name === "String") {
    diagnostics.push({
      code: "type.builtin_type_casing",
      message: "builtin type String is lowercase; use string",
    });
    return;
  }
  if (lowerNames.has(name)) return;
  const lower = lowerByPascal.get(name);
  if (!lower) return;
  diagnostics.push({
    code: "type.type_fn_reference_casing",
    message: `type function ${name} is lowercase; use ${lower}`,
  });
}

function inferKinds(
  expr: TypeExpr,
  decl: TypeDecl,
  kinds: Map<string, TypeParamKind>,
  locals: Map<string, TypeExpr>,
  byName: Map<string, TypeDecl>,
  diagnostics: Diagnostic[],
  expected: TypeParamKind = "type",
) {
  if (expr.kind === "type_ref") {
    if (decl.params.some((param) => param.name === expr.name)) {
      markKind(decl, kinds, expr.name, expected, diagnostics);
    }
    const local = locals.get(expr.name);
    if (local) inferKinds(local, decl, kinds, locals, byName, diagnostics, expected);
    return;
  }
  if (expr.kind === "type_call") {
    inferKinds(expr.callee, decl, kinds, locals, byName, diagnostics, "type");
    const calleeName = expr.callee.kind === "type_ref" ? expr.callee.name : undefined;
    const staticBuiltinName = expr.callee.kind === "type_static_ref" ? expr.callee.name : undefined;
    const calleeDecl = calleeName ? byName.get(calleeName) : undefined;
    if (calleeName && decl.params.some((param) => param.name === calleeName)) {
      const constructorKind = `type fn(${
        expr.args.map((_arg, index) => `_${index}: type`).join(", ")
      }) -> type`;
      markKind(decl, kinds, calleeName, constructorKind, diagnostics);
    }
    expr.args.forEach((arg, index) => {
      const calleeKind = staticBuiltinParamKind(staticBuiltinName, index) ??
        calleeDecl?.paramKinds?.[calleeDecl.params[index]?.name] ?? "type";
      inferKinds(arg, decl, kinds, locals, byName, diagnostics, calleeKind);
    });
    return;
  }
  if (expr.kind === "type_shape") {
    inferShapeKinds(expr.shape, decl, kinds, locals, byName, diagnostics);
    return;
  }
  if (expr.kind === "type_match") {
    inferKinds(expr.value, decl, kinds, locals, byName, diagnostics, "type");
    for (const arm of expr.arms) {
      inferKinds(arm.value, decl, kinds, locals, byName, diagnostics, expected);
    }
    return;
  }
  if (expr.kind === "type_binary") {
    inferKinds(expr.left, decl, kinds, locals, byName, diagnostics, expected);
    inferKinds(expr.right, decl, kinds, locals, byName, diagnostics, expected);
  }
}

function staticBuiltinParamKind(
  name: string | undefined,
  index: number,
): TypeParamKind | undefined {
  if (
    (name === "wgsl_shader_id" || name === "wgsl_bindings" || name === "wgsl_locations") &&
    index === 0
  ) {
    return "string";
  }
  return undefined;
}

function inferShapeKinds(
  shape: TypeShape,
  decl: TypeDecl,
  kinds: Map<string, TypeParamKind>,
  locals: Map<string, TypeExpr>,
  byName: Map<string, TypeDecl>,
  diagnostics: Diagnostic[],
) {
  for (const slot of shape.slots) {
    if (slot.repeat) inferCountKinds(slot.repeat, decl, kinds, diagnostics);
    inferKinds(slot.type, decl, kinds, locals, byName, diagnostics, "type");
  }
}

function inferCountKinds(
  expr: TypeCountExpr,
  decl: TypeDecl,
  kinds: Map<string, TypeParamKind>,
  diagnostics: Diagnostic[],
) {
  if (expr.kind === "count_ref" && decl.params.some((param) => param.name === expr.name)) {
    markKind(decl, kinds, expr.name, "count", diagnostics);
  } else if (expr.kind === "count_mul") {
    inferCountKinds(expr.left, decl, kinds, diagnostics);
    inferCountKinds(expr.right, decl, kinds, diagnostics);
  }
}

function markKind(
  decl: TypeDecl,
  kinds: Map<string, TypeParamKind>,
  name: string,
  kind: TypeParamKind,
  diagnostics: Diagnostic[],
) {
  const existing = kinds.get(name);
  if (existing && !typeParamKindsCompatible(existing, kind)) {
    diagnostics.push({
      code: "type.param_kind_conflict",
      message:
        `type function ${decl.name} parameter ${name} is used as both ${existing} and ${kind}`,
    });
    return;
  }
  kinds.set(name, moreSpecificTypeParamKind(existing, kind));
}

function typeParamKindsCompatible(left: TypeParamKind, right: TypeParamKind): boolean {
  if (left === right) return true;
  if (left === "type" && isTypeConstructorKind(right)) return true;
  if (right === "type" && isTypeConstructorKind(left)) return true;
  if (isTypeConstructorKind(left) && isTypeConstructorKind(right)) {
    return typeConstructorKindArity(left) === typeConstructorKindArity(right) &&
      typeConstructorResultKindsCompatible(
        typeConstructorResultKind(left),
        typeConstructorResultKind(right),
      );
  }
  return false;
}

function moreSpecificTypeParamKind(
  left: TypeParamKind | undefined,
  right: TypeParamKind,
): TypeParamKind {
  if (!left || left === right) return right;
  if (left === "type" && isTypeConstructorKind(right)) return right;
  return left;
}

function isTypeConstructorKind(kind: TypeParamKind): boolean {
  return /^type\s+fn\s*\(/.test(kind);
}

function typeConstructorKindArity(kind: TypeParamKind): number | undefined {
  const match = kind.match(/^type\s+fn\s*\((.*)\)\s*->\s*(type|struct|union)$/);
  if (!match) return undefined;
  const params = match[1].trim();
  return params ? params.split(",").length : 0;
}

function typeConstructorResultKind(kind: TypeParamKind): TypeResultKind | undefined {
  const match = kind.match(/^type\s+fn\s*\(.*\)\s*->\s*(type|struct|union)$/);
  return match?.[1] as TypeResultKind | undefined;
}

function typeConstructorResultKindsCompatible(
  left: TypeResultKind | undefined,
  right: TypeResultKind | undefined,
): boolean {
  if (!left || !right) return false;
  return left === "type" || right === "type" || left === right;
}

function checkTypeResultKind(
  decl: TypeDecl,
  normalized: TypeBody | undefined,
  diagnostics: Diagnostic[],
) {
  if (!normalized || decl.resultKind === "type") return;
  if (decl.resultKind === "struct" && normalized.kind === "product") return;
  if (decl.resultKind === "union" && normalized.kind === "sum") return;
  diagnostics.push({
    code: "type.result_kind",
    message:
      `type function ${decl.name} declares -> ${decl.resultKind} but normalizes to ${normalized.kind}`,
  });
}

function normalizeTop(
  decl: TypeDecl,
  expr: TypeExpr,
  locals: Map<string, TypeExpr>,
  byName: Map<string, TypeDecl>,
  diagnostics: Diagnostic[],
  evaluate: (decl: TypeDecl) => TypeBody | undefined,
): TypeBody {
  const resolved = resolveLocal(expr, locals);
  const builder = typeBuilderCall(resolved);
  if (builder?.name === "struct") {
    const arg = builder.args[0];
    const shapeExpr = arg?.kind === "type_ref" ? locals.get(arg.name) : undefined;
    if (builder.args.length !== 1 || arg?.kind !== "type_ref" || shapeExpr?.kind !== "type_shape") {
      diagnostics.push({
        code: "type.builder_arg",
        message: "struct(...) requires one type-block shape binding",
      });
      return { kind: "alias", type: renderTypeExpr(resolved) };
    }
    const members = normalizeMembers(shapeExpr.shape.members);
    return {
      kind: "product",
      name: decl.name,
      constructor: arg.name,
      shape: normalizeShape(shapeExpr.shape),
      ...(members ? { members } : {}),
    };
  }
  if (builder?.name === "union") {
    const variants = builder.args.map((arg) => {
      const shape = arg.kind === "type_ref" ? locals.get(arg.name) : undefined;
      return arg.kind === "type_ref" && shape?.kind === "type_shape"
        ? { name: arg.name, shape }
        : undefined;
    });
    if (!variants.length || variants.some((variant) => !variant)) {
      diagnostics.push({
        code: "type.builder_arg",
        message: "union(...) requires type-block shape bindings",
      });
      return { kind: "alias", type: renderTypeExpr(resolved) };
    }
    const resolvedVariants = variants as {
      name: string;
      shape: Extract<TypeExpr, { kind: "type_shape" }>;
    }[];
    const members = normalizeMembers(resolvedVariants[0].shape.shape.members);
    return {
      kind: "sum",
      variants: resolvedVariants.map((variant) => ({
        name: variant.name,
        shape: variant.shape.shape.slots.length ? normalizeShape(variant.shape.shape) : undefined,
      })),
      ...(members ? { members } : {}),
    };
  }
  if (resolved.kind === "type_ref") {
    const target = byName.get(resolved.name);
    if (target) evaluate(target);
  }
  if (resolved.kind === "type_call" && resolved.callee.kind === "type_ref") {
    const target = byName.get(resolved.callee.name);
    if (!target) {
      diagnostics.push({
        code: "type.unknown_type",
        message: `unknown type function ${resolved.callee.name}`,
      });
    } else {
      evaluate(target);
    }
  }
  return { kind: "alias", type: renderTypeExpr(resolved) };
}

function startsLowercase(name: string): boolean {
  return /^[a-z_]/.test(name);
}

function startsUppercase(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function lowerFirst(name: string): string {
  return name ? name[0].toLowerCase() + name.slice(1) : name;
}

function upperFirst(name: string): string {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

function pascalCase(name: string): string {
  return name.split(/[_-]+/).filter(Boolean).map((part) =>
    part ? part[0].toUpperCase() + part.slice(1) : ""
  ).join("");
}

function resolveLocal(expr: TypeExpr, locals: Map<string, TypeExpr>): TypeExpr {
  if (expr.kind === "type_ref") return locals.get(expr.name) ?? expr;
  return expr;
}

function typeBuilderCall(
  expr: TypeExpr,
): { name: "struct" | "union"; args: TypeExpr[] } | undefined {
  if (expr.kind !== "type_call" || expr.callee.kind !== "type_ref") return undefined;
  if (expr.callee.name !== "struct" && expr.callee.name !== "union") return undefined;
  return { name: expr.callee.name, args: expr.args };
}

function normalizeShape(shape: TypeShape): ShapeType {
  return {
    slots: shape.slots.map((slot) => ({
      label: slot.label,
      type: renderTypeExpr(slot.type),
      ...(slot.repeat ? { repeat: renderCountExpr(slot.repeat) } : {}),
    })),
  };
}

function normalizeMembers(members: TypeShape["members"] | undefined) {
  return members?.length
    ? members.map((member) => ({ name: member.name, type: member.type, target: member.target }))
    : undefined;
}

function renderTypeExpr(expr: TypeExpr): string {
  switch (expr.kind) {
    case "type_ref":
      return expr.name;
    case "type_static_ref":
      return `@${expr.name}`;
    case "type_call":
      return `${renderTypeExpr(expr.callee)}(${expr.args.map(renderTypeExpr).join(", ")})`;
    case "type_fn":
      return expr.source;
    case "type_shape":
      return renderShape(expr.shape);
    case "type_match":
      return `match ${renderTypeExpr(expr.value)} { ${
        expr.arms.map((arm) => `${renderTypePattern(arm.pattern)} => ${renderTypeExpr(arm.value)}`)
          .join(", ")
      } }`;
    case "type_binary":
      return `${renderTypeExpr(expr.left)} ${expr.op} ${renderTypeExpr(expr.right)}`;
    case "type_bool":
      return expr.value ? "true" : "false";
    case "type_number":
      return expr.value;
    case "type_string":
      return JSON.stringify(expr.value);
    case "type_literal":
      return `#${expr.value}`;
  }
}

function renderTypePattern(pattern: TypePattern): string {
  switch (pattern.kind) {
    case "wildcard":
      return "_";
    case "bool":
      return pattern.value ? "true" : "false";
    case "literal":
      return `#${pattern.value}`;
    case "string":
      return JSON.stringify(pattern.value);
    case "number":
      return pattern.value;
    case "type":
      return pattern.name;
  }
}

function renderShape(shape: TypeShape): string {
  return `[${
    shape.slots.map((slot) =>
      `${slot.label ? `${slot.label}: ` : ""}${
        slot.repeat ? `${renderCountExpr(slot.repeat)} * ` : ""
      }${renderTypeExpr(slot.type)}`
    ).join(", ")
  }]`;
}

function renderShapeItems(shape: TypeShape): string {
  return [
    ...shape.slots.map((slot) =>
      `${slot.label ? `${slot.label}: ` : ""}${
        slot.repeat ? `${renderCountExpr(slot.repeat)} * ` : ""
      }${renderTypeExpr(slot.type)}`
    ),
    ...(shape.members ?? []).map((member) =>
      `const ${member.name}: ${member.type} = ${member.target}`
    ),
  ].join(", ");
}

function renderCountExpr(expr: TypeCountExpr): string {
  switch (expr.kind) {
    case "count_literal":
      return expr.source;
    case "count_ref":
      return expr.name;
    case "count_mul":
      return `${renderCountExpr(expr.left)} * ${renderCountExpr(expr.right)}`;
  }
}

type TypeEvalValue =
  | { kind: "never" }
  | { kind: "bool"; value: boolean }
  | { kind: "number"; value: string }
  | { kind: "string"; value: string }
  | { kind: "literal"; value: string }
  | { kind: "static_builtin"; name: string }
  | { kind: "type"; name: string; normalized?: TypeBody };

function checkTypeContracts(
  program: Program,
  types: TypeDecl[],
  functions: FnDecl[],
  capabilities: Map<string, string[]>,
  diagnostics: Diagnostic[],
) {
  const byName = new Map(types.map((decl) => [decl.name, decl]));
  const byFn = new Map(functions.map((decl) => [decl.name, decl]));
  for (const decl of program.declarations) {
    if (decl.kind === "const" || decl.kind === "let") {
      if (decl.type) {
        instantiateNestedAnnotations(decl.type, byName, byFn, capabilities, diagnostics);
      }
    } else if (decl.kind === "fn") {
      const constTypeParams = new Set<string>();
      for (const param of decl.params) {
        if (
          !annotationReferencesAny(param.type, constTypeParams) &&
          !annotationHasInferredVars(param.type)
        ) {
          instantiateNestedAnnotations(param.type, byName, byFn, capabilities, diagnostics);
        }
        if (param.const && param.type === "type") constTypeParams.add(param.name);
      }
      if (
        decl.returnType && !annotationReferencesAny(decl.returnType, constTypeParams) &&
        !annotationHasInferredVars(decl.returnType)
      ) {
        instantiateNestedAnnotations(decl.returnType, byName, byFn, capabilities, diagnostics);
      }
      checkBlockTypeContracts(decl.body, byName, byFn, capabilities, diagnostics, constTypeParams);
    }
  }
}

function checkBlockTypeContracts(
  block: Extract<Expr, { kind: "block" }>,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  diagnostics: Diagnostic[],
  deferredTypeParams = new Set<string>(),
) {
  for (const stmt of block.statements) {
    if (
      stmt.kind === "let" && stmt.type &&
      !annotationReferencesAny(stmt.type, deferredTypeParams)
    ) {
      instantiateNestedAnnotations(stmt.type, typesByName, functions, capabilities, diagnostics);
    }
    if (stmt.kind === "let") {
      checkExprTypeContracts(stmt.value, typesByName, functions, capabilities, diagnostics);
    }
  }
  if (block.expr) {
    checkExprTypeContracts(block.expr, typesByName, functions, capabilities, diagnostics);
  }
}

function checkExprTypeContracts(
  expr: Expr,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  diagnostics: Diagnostic[],
) {
  if (expr.kind === "block") {
    checkBlockTypeContracts(expr, typesByName, functions, capabilities, diagnostics);
  } else if (expr.kind === "match") {
    checkExprTypeContracts(expr.value, typesByName, functions, capabilities, diagnostics);
    for (const arm of expr.arms) {
      checkExprTypeContracts(arm.value, typesByName, functions, capabilities, diagnostics);
    }
  } else if (expr.kind === "product_constructor" || expr.kind === "shape") {
    for (const slot of expr.slots) {
      checkExprTypeContracts(slot.value, typesByName, functions, capabilities, diagnostics);
    }
  }
}

function lowerProductConstructors(
  program: Program,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  const products = new Map<string, TypeBody & { kind: "product" }>();
  for (const type of types) {
    if (type.normalized?.kind === "product") {
      products.set(type.normalized.constructor, type.normalized);
    }
  }
  const lowerExpr = (expr: Expr): Expr => {
    switch (expr.kind) {
      case "product_constructor": {
        const product = products.get(expr.constructor);
        if (!product) {
          diagnostics.push({
            code: "type.unknown_constructor",
            message: `unknown product constructor ${expr.constructor}`,
          });
        } else {
          checkProductConstructorShape(expr, product, diagnostics);
        }
        return {
          kind: "shape",
          slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value) })),
        };
      }
      case "call":
        return {
          ...expr,
          callee: lowerExpr(expr.callee),
          args: expr.args.map(lowerExpr),
        };
      case "index":
        return {
          ...expr,
          target: lowerExpr(expr.target),
          index: lowerExpr(expr.index),
        };
      case "binary":
        return { ...expr, left: lowerExpr(expr.left), right: lowerExpr(expr.right) };
      case "pipe_bind":
        return { ...expr, value: lowerExpr(expr.value), body: lowerExpr(expr.body) };
      case "match":
        return {
          ...expr,
          value: lowerExpr(expr.value),
          arms: expr.arms.map((arm) => ({ ...arm, value: lowerExpr(arm.value) })),
        };
      case "shape":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value) })),
        };
      case "range":
        return { ...expr, start: lowerExpr(expr.start), end: lowerExpr(expr.end) };
      case "block":
        return {
          ...expr,
          statements: expr.statements.map((stmt) =>
            stmt.kind === "let" || stmt.kind === "destructure_let"
              ? { ...stmt, value: lowerExpr(stmt.value) }
              : stmt
          ),
          expr: expr.expr ? lowerExpr(expr.expr) : undefined,
        };
      case "literal":
      case "var":
      case "placeholder":
        return expr;
    }
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") decl.body = lowerExpr(decl.body) as Extract<Expr, { kind: "block" }>;
    else if (decl.kind === "let" || decl.kind === "const") decl.value = lowerExpr(decl.value);
  }
}

function checkProductConstructorShape(
  expr: Extract<Expr, { kind: "product_constructor" }>,
  product: TypeBody & { kind: "product" },
  diagnostics: Diagnostic[],
) {
  const expected = new Set(
    product.shape.slots.map((slot) => slot.label).filter((label): label is string => !!label),
  );
  const actual = new Set<string>();
  for (const slot of expr.slots) {
    if (!slot.label) continue;
    if (actual.has(slot.label)) {
      diagnostics.push({
        code: "type.duplicate_constructor_slot",
        message: `${expr.constructor} defines duplicate slot ${slot.label}`,
      });
    }
    actual.add(slot.label);
  }
  for (const label of expected) {
    if (!actual.has(label)) {
      diagnostics.push({
        code: "type.constructor_missing_slot",
        message: `${expr.constructor} is missing field ${label}`,
      });
    }
  }
  for (const label of actual) {
    if (!expected.has(label)) {
      diagnostics.push({
        code: "type.constructor_unknown_slot",
        message: `${expr.constructor} has no field ${label}`,
      });
    }
  }
}

function annotationReferencesAny(annotation: string, names: Set<string>): boolean {
  for (const name of names) {
    if (new RegExp(`\\b${name}\\b`).test(annotation)) return true;
  }
  return false;
}

function annotationHasInferredVars(annotation: string): boolean {
  return /\b[A-Z]\b/.test(annotation);
}

function instantiateNestedAnnotations(
  annotation: string,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  diagnostics: Diagnostic[],
) {
  for (const typeExpr of parseAnnotationTypeCalls(annotation)) {
    instantiateTypeExpr(typeExpr, typesByName, functions, capabilities, diagnostics);
  }
}

function instantiateAnnotation(
  annotation: string,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  diagnostics: Diagnostic[],
): TypeBody | undefined {
  const expr = parseAnnotationType(annotation);
  if (!expr) return undefined;
  const value = instantiateTypeExpr(expr, typesByName, functions, capabilities, diagnostics);
  return value?.kind === "type" ? value.normalized : undefined;
}

function instantiateTypeExpr(
  expr: TypeExpr,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  diagnostics: Diagnostic[],
  locals = new Map<string, TypeEvalValue>(),
): TypeEvalValue | undefined {
  const evaluator = new TypeEvaluator(
    typesByName,
    functions,
    capabilities,
    diagnostics,
    shaderManifestEntry,
  );
  return evaluator.eval(expr, locals);
}

class TypeEvaluator {
  constructor(
    private typesByName: Map<string, TypeDecl>,
    private functions: Map<string, FnDecl>,
    private capabilities: Map<string, string[]>,
    private diagnostics: Diagnostic[],
    private addShader: (source: string) => ShaderManifestEntry,
  ) {}

  eval(expr: TypeExpr, locals: Map<string, TypeEvalValue>): TypeEvalValue | undefined {
    switch (expr.kind) {
      case "type_ref":
        return locals.get(expr.name) ?? this.namedType(expr.name);
      case "type_static_ref":
        return { kind: "static_builtin", name: expr.name };
      case "type_call":
        return this.evalCall(expr, locals);
      case "type_shape":
        return {
          kind: "type",
          name: renderShape(substituteShape(expr.shape, locals)),
          normalized: {
            kind: "product",
            name: "shape",
            constructor: "Shape",
            shape: normalizeShape(substituteShape(expr.shape, locals)),
          },
        };
      case "type_fn":
        return { kind: "type", name: substituteTypeSource(expr.source, locals) };
      case "type_match": {
        const value = this.eval(expr.value, locals);
        if (!value) return undefined;
        for (const arm of expr.arms) {
          if (typePatternMatches(arm.pattern, value)) {
            return this.eval(arm.value, new Map(locals));
          }
        }
        this.diagnostics.push({
          code: "type.non_exhaustive_match",
          message: "type match has no matching arm",
        });
        return { kind: "never" };
      }
      case "type_binary": {
        const left = this.eval(expr.left, locals);
        const right = this.eval(expr.right, locals);
        if (!left || !right) return undefined;
        if (expr.op === "==" || expr.op === "!=") {
          const equal = typeEvalKey(left) === typeEvalKey(right);
          return { kind: "bool", value: expr.op === "==" ? equal : !equal };
        }
        return this.unsupported(
          "type.unsupported_expr",
          `operator ${expr.op} is not type-evaluable`,
        );
      }
      case "type_string":
        return { kind: "string", value: expr.value };
      case "type_literal":
        return { kind: "literal", value: expr.value };
      case "type_number":
        return { kind: "number", value: expr.value };
      case "type_bool":
        return { kind: "bool", value: expr.value };
    }
  }

  private evalCall(
    expr: Extract<TypeExpr, { kind: "type_call" }>,
    locals: Map<string, TypeEvalValue>,
  ): TypeEvalValue | undefined {
    const callee = expr.callee.kind === "type_ref"
      ? expr.callee.name
      : expr.callee.kind === "type_static_ref"
      ? `@${expr.callee.name}`
      : undefined;
    const args = expr.args.map((arg) => this.eval(arg, locals) ?? { kind: "never" as const });
    if (!callee) {
      return this.unsupported("type.unsupported_expr", "type calls require a named callee");
    }
    if (callee === "struct" || callee === "union") {
      return this.evalTypeBuilder(callee, expr.args, locals);
    }
    if (callee === "index") {
      return this.namedType(`index(${args.map(renderTypeEvalValue).join(", ")})`);
    }
    if (callee && isStaticBuiltinName(callee) && !callee.startsWith("@")) {
      this.diagnostics.push({
        code: "type.static_builtin_prefix",
        message: `static builtin ${callee} must be called as @${callee}`,
      });
      return { kind: "never" };
    }
    if (callee === "@compile_error") {
      const message = args[0]?.kind === "string" ? args[0].value : "compile-time error";
      this.diagnostics.push({ code: "type.compile_error", message });
      return { kind: "never" };
    }
    const builtin = this.evalBuiltin(callee, args);
    if (builtin) return builtin;
    if (this.capabilities.has(callee)) {
      return this.unsupported(
        "type.runtime_capability_call",
        `cannot call imported capability ${callee} during type evaluation`,
      );
    }
    const fn = this.functions.get(callee);
    if (fn) return this.evalFunction(fn, args, locals, []);
    const decl = this.typesByName.get(callee);
    if (!decl) return this.namedType(`${callee}(${args.map(renderTypeEvalValue).join(", ")})`);
    const selected = this.selectTypeClause(decl, args);
    if (!selected) {
      this.diagnostics.push({
        code: "type.no_matching_clause",
        message: `type function ${callee} has no matching clause`,
      });
      return { kind: "never" };
    }
    selected.params.forEach((param, index) => {
      this.checkTypeArgKind(callee, param, args[index] ?? { kind: "never" });
    });
    const fnLocals = new Map<string, TypeEvalValue>();
    selected.params.forEach((param, index) => {
      bindTypeParamPattern(
        selected.paramPatterns?.[index],
        param.name,
        args[index] ?? { kind: "never" },
        fnLocals,
      );
    });
    for (const stmt of selected.body.statements) {
      const value = this.eval(stmt.value, fnLocals);
      if (!value) return undefined;
      fnLocals.set(stmt.name, value);
    }
    if (!selected.body.expr) {
      return {
        kind: "type",
        name: `${callee}(${args.map(renderTypeEvalValue).join(", ")})`,
        normalized: selected.normalized ?? decl.normalized,
      };
    }
    const result = this.eval(selected.body.expr, fnLocals);
    if (result?.kind === "type") {
      checkTypeResultKind(selected, result.normalized, this.diagnostics);
      return {
        ...result,
        name: `${callee}(${args.map(renderTypeEvalValue).join(", ")})`,
      };
    }
    return result;
  }

  private evalTypeBuilder(
    callee: string,
    rawArgs: TypeExpr[],
    locals: Map<string, TypeEvalValue>,
  ): TypeEvalValue | undefined {
    const args = rawArgs.map((arg) => ({
      source: arg,
      value: this.eval(arg, locals) ?? { kind: "never" as const },
    }));
    if (callee === "struct") {
      const arg = args[0];
      if (args.length !== 1 || arg?.source.kind !== "type_ref" || arg.value.kind !== "type") {
        return this.unsupported(
          "type.builder_arg",
          "struct(...) requires one type-block shape binding",
        );
      }
      const normalized = arg.value.normalized;
      if (normalized?.kind !== "product") {
        return this.unsupported(
          "type.builder_arg",
          "struct(...) requires one type-block shape binding",
        );
      }
      return {
        kind: "type",
        name: `struct(${arg.source.name})`,
        normalized: { ...normalized, name: "struct", constructor: arg.source.name },
      };
    }
    if (
      !args.length ||
      args.some((arg) => arg.source.kind !== "type_ref" || arg.value.kind !== "type")
    ) {
      return this.unsupported("type.builder_arg", "union(...) requires type-block shape bindings");
    }
    return {
      kind: "type",
      name: `union(${args.map((arg) => renderTypeExpr(arg.source)).join(", ")})`,
      normalized: {
        kind: "sum",
        variants: args.map((arg) => {
          const shape = arg.value.kind === "type" && arg.value.normalized?.kind === "product"
            ? arg.value.normalized.shape
            : undefined;
          return {
            name: (arg.source as Extract<TypeExpr, { kind: "type_ref" }>).name,
            ...(shape?.slots.length ? { shape } : {}),
          };
        }),
      },
    };
  }

  private selectTypeClause(decl: TypeDecl, args: TypeEvalValue[]): TypeDecl | undefined {
    for (const clause of decl.clauses ?? [decl]) {
      if (clause.params.length !== args.length) continue;
      let matched = true;
      for (let index = 0; index < clause.params.length; index++) {
        if (
          !typeParamPatternMatches(clause.paramPatterns?.[index], args[index] ?? { kind: "never" })
        ) {
          matched = false;
          break;
        }
      }
      if (matched) return clause;
    }
    return undefined;
  }

  private checkTypeArgKind(callee: string, param: TypeDecl["params"][number], arg: TypeEvalValue) {
    if (param.kind === "count") return;
    if (!isTypeConstructorKind(param.kind)) return;
    if (arg.kind !== "type") {
      this.diagnostics.push({
        code: "type.param_kind",
        message: `${callee} parameter ${param.name} expects a type constructor`,
      });
      return;
    }
    const expectedArity = typeConstructorKindArity(param.kind);
    const baseName = arg.name.replace(/\(.*\)$/, "");
    const actual = this.typesByName.get(baseName);
    if (!actual || actual.params.length !== expectedArity) {
      this.diagnostics.push({
        code: "type.param_kind",
        message:
          `${callee} parameter ${param.name} expects a ${expectedArity}-argument type constructor`,
      });
      return;
    }
    if (
      !typeConstructorResultKindsCompatible(
        typeConstructorResultKind(param.kind),
        actual.resultKind,
      )
    ) {
      this.diagnostics.push({
        code: "type.param_kind",
        message: `${callee} parameter ${param.name} expects a type constructor returning ${
          typeConstructorResultKind(param.kind)
        }`,
      });
    }
  }

  private evalBuiltin(name: string, args: TypeEvalValue[]): TypeEvalValue | undefined {
    if (!name.startsWith("@")) return undefined;
    name = name.slice(1);
    if (name === "require") {
      const ok = args[0]?.kind === "bool" && args[0].value;
      if (!ok) {
        const message = args[1]?.kind === "string" ? args[1].value : "@require failed";
        this.diagnostics.push({ code: "type.require", message });
      }
      return { kind: "bool", value: ok };
    }
    if (name === "wgsl_shader_id") {
      const source = args[0]?.kind === "string" ? args[0].value : undefined;
      if (source === undefined) return undefined;
      this.addShader(source);
      return { kind: "number", value: String(wgslShaderId(source)) };
    }
    if (name === "wgsl_bindings" || name === "wgsl_locations") {
      const source = args[0]?.kind === "string" ? args[0].value : undefined;
      if (source === undefined) return undefined;
      const entry = this.addShader(source);
      const count = name === "wgsl_bindings" ? entry.bindings.length : entry.locations.length;
      return this.namedType(`shader_${name.slice("wgsl_".length)}(${count})`);
    }
    const type = args[0]?.kind === "type" ? args[0] : undefined;
    if (!type) return undefined;
    if (name === "type_is_product") {
      return { kind: "bool", value: type.normalized?.kind === "product" };
    }
    if (name === "type_is_sum") return { kind: "bool", value: type.normalized?.kind === "sum" };
    if (name === "type_is_alias") return { kind: "bool", value: type.normalized?.kind === "alias" };
    if (name === "type_has_slot") return { kind: "bool", value: !!typeProductSlot(type, args[1]) };
    if (name === "type_slot_type") {
      const slot = typeProductSlot(type, args[1]);
      if (!slot) {
        this.diagnostics.push({
          code: "type.unknown_type_slot",
          message: `unknown type slot ${typeLiteralName(args[1]) ?? "<unknown>"}`,
        });
        return { kind: "never" };
      }
      return this.namedType(slot.type);
    }
    if (name === "type_has_member") {
      return { kind: "bool", value: !!typeMember(type, args[1]) };
    }
    if (name === "type_member_type") {
      const member = typeMember(type, args[1]);
      if (!member) {
        this.diagnostics.push({
          code: "type.unknown_type_member",
          message: `unknown type member ${typeLiteralName(args[1]) ?? "<unknown>"}`,
        });
        return { kind: "never" };
      }
      return this.namedType(member.type);
    }
    if (name === "type_has_variant") {
      const variant = typeLiteralName(args[1]);
      return {
        kind: "bool",
        value: type.normalized?.kind === "sum" &&
          !!type.normalized.variants.find((item) => item.name === variant),
      };
    }
    if (name === "type_variant_has_slot") {
      const variant = typeLiteralName(args[1]);
      const slot = typeLiteralName(args[2]);
      const found = type.normalized?.kind === "sum"
        ? type.normalized.variants.find((item) => item.name === variant)
        : undefined;
      return { kind: "bool", value: !!found?.shape?.slots.find((item) => item.label === slot) };
    }
    return undefined;
  }

  private evalFunction(
    fn: FnDecl,
    args: TypeEvalValue[],
    _locals: Map<string, TypeEvalValue>,
    callStack: string[],
  ): TypeEvalValue | undefined {
    if (callStack.includes(fn.name)) {
      return this.unsupported(
        "type.unsupported_expr",
        `recursive type helper call ${[...callStack, fn.name].join(" -> ")}`,
      );
    }
    const fnLocals = new Map<string, TypeEvalValue>();
    fn.params.forEach((param, index) => fnLocals.set(param.name, args[index] ?? { kind: "never" }));
    return this.evalStaticBlock(fn.body, fnLocals, [...callStack, fn.name]);
  }

  private evalStaticExpr(
    expr: Expr,
    locals: Map<string, TypeEvalValue>,
    callStack: string[],
  ): TypeEvalValue | undefined {
    switch (expr.kind) {
      case "literal":
        if (expr.literalKind === "bool") return { kind: "bool", value: expr.value === "true" };
        if (expr.literalKind === "number") return { kind: "number", value: expr.value };
        if (expr.literalKind === "string") {
          return { kind: "string", value: expr.value.slice(1, -1) };
        }
        if (expr.literalKind === "multiline") return { kind: "string", value: expr.value };
        if (expr.literalKind === "literalType") {
          return { kind: "literal", value: expr.value.slice(1) };
        }
        return this.unsupported("type.unsupported_expr", "unsupported literal in type evaluation");
      case "var":
        return locals.get(expr.name) ?? this.namedType(expr.name);
      case "call": {
        if (expr.callee.kind !== "var") {
          return this.unsupported(
            "type.unsupported_expr",
            "type helper calls require a named callee",
          );
        }
        const name = expr.callee.name;
        const args = expr.args.map((arg) =>
          this.evalStaticExpr(arg, locals, callStack) ?? { kind: "never" as const }
        );
        if (isStaticBuiltinName(name) && !name.startsWith("@")) {
          this.diagnostics.push({
            code: "type.static_builtin_prefix",
            message: `static builtin ${name} must be called as @${name}`,
          });
          return { kind: "never" };
        }
        if (name === "@compile_error") {
          const message = args[0]?.kind === "string" ? args[0].value : "compile-time error";
          this.diagnostics.push({ code: "type.compile_error", message });
          return { kind: "never" };
        }
        const builtin = this.evalBuiltin(name, args);
        if (builtin) return builtin;
        if (this.capabilities.has(name)) {
          return this.unsupported(
            "type.runtime_capability_call",
            `cannot call imported capability ${name} during type evaluation`,
          );
        }
        const fn = this.functions.get(name);
        if (!fn) return this.unsupported("type.unsupported_expr", `unknown type helper ${name}`);
        return this.evalFunction(fn, args, locals, callStack);
      }
      case "binary": {
        const left = this.evalStaticExpr(expr.left, locals, callStack);
        const right = this.evalStaticExpr(expr.right, locals, callStack);
        if (!left || !right) return undefined;
        if (expr.op === "==" || expr.op === "!=") {
          const equal = typeEvalKey(left) === typeEvalKey(right);
          return { kind: "bool", value: expr.op === "==" ? equal : !equal };
        }
        return this.unsupported(
          "type.unsupported_expr",
          `operator ${expr.op} is not type-evaluable`,
        );
      }
      case "pipe_bind": {
        const value = this.evalStaticExpr(expr.value, locals, callStack);
        if (!value) return undefined;
        return this.evalStaticExpr(expr.body, new Map(locals).set(expr.name, value), callStack);
      }
      case "block":
        return this.evalStaticBlock(expr, new Map(locals), callStack);
      case "match": {
        const value = this.evalStaticExpr(expr.value, locals, callStack);
        if (!value) return undefined;
        const arm = expr.arms.find((arm) => typeExprPatternMatches(arm.pattern, value));
        if (!arm) {
          return this.unsupported("type.unsupported_expr", "type helper match has no matching arm");
        }
        return this.evalStaticExpr(arm.value, new Map(locals), callStack);
      }
      case "shape":
      case "product_constructor":
      case "range":
        return this.unsupported("type.unsupported_expr", `${expr.kind} is not type-evaluable`);
    }
  }

  private evalStaticBlock(
    block: Extract<Expr, { kind: "block" }>,
    locals: Map<string, TypeEvalValue>,
    callStack: string[],
  ): TypeEvalValue | undefined {
    if (block.statements.some((stmt) => stmt.kind !== "let" && stmt.kind !== "proof_const")) {
      return this.unsupported("type.unsupported_expr", "fork is not type-evaluable");
    }
    const ordered = orderBlockStatements(block.statements, this.diagnostics);
    for (const stmt of ordered) {
      if (stmt.kind === "let") {
        const value = this.evalStaticExpr(stmt.value, locals, callStack);
        if (!value) return undefined;
        locals.set(stmt.name, value);
      }
    }
    return block.expr ? this.evalStaticExpr(block.expr, locals, callStack) : undefined;
  }

  private namedType(name: string): TypeEvalValue {
    const normalized = this.typesByName.get(name)?.normalized;
    return { kind: "type", name, normalized };
  }

  private unsupported(code: string, message: string): undefined {
    this.diagnostics.push({ code, message });
    return undefined;
  }
}

function typeProductSlot(type: TypeEvalValue, name: TypeEvalValue | undefined) {
  const slotName = typeLiteralName(name);
  if (type.kind !== "type" || type.normalized?.kind !== "product") return undefined;
  return type.normalized.shape.slots.find((slot) => slot.label === slotName);
}

function typeMember(type: TypeEvalValue, name: TypeEvalValue | undefined) {
  const memberName = typeLiteralName(name);
  if (type.kind !== "type") return undefined;
  if (type.normalized?.kind === "product" || type.normalized?.kind === "sum") {
    return type.normalized.members?.find((member) => member.name === memberName);
  }
  return undefined;
}

function typeLiteralName(value: TypeEvalValue | undefined): string | undefined {
  return value?.kind === "literal" || value?.kind === "string" ? value.value : undefined;
}

function isStaticBuiltinName(name: string): boolean {
  const bare = name.startsWith("@") ? name.slice(1) : name;
  return [
    "compile_error",
    "type_is_product",
    "type_is_sum",
    "type_is_alias",
    "type_has_slot",
    "type_slot_type",
    "type_has_member",
    "type_member_type",
    "type_has_variant",
    "type_variant_has_slot",
    "require",
    "wgsl_shader_id",
    "wgsl_bindings",
    "wgsl_locations",
  ].includes(bare);
}

function typePatternMatches(pattern: TypePattern, value: TypeEvalValue): boolean {
  if (pattern.kind === "wildcard") return true;
  if (pattern.kind === "bool") return value.kind === "bool" && value.value === pattern.value;
  if (pattern.kind === "literal") return value.kind === "literal" && value.value === pattern.value;
  if (pattern.kind === "string") return value.kind === "string" && value.value === pattern.value;
  if (pattern.kind === "number") return value.kind === "number" && value.value === pattern.value;
  return value.kind === "type" && value.name === pattern.name;
}

function typeParamPatternMatches(pattern: ParamPattern | undefined, value: TypeEvalValue): boolean {
  if (!pattern || pattern.kind === "binding" || pattern.kind === "wildcard") return true;
  if (pattern.kind === "type") return value.kind === "type" && value.name === pattern.name;
  if (pattern.kind === "literal") {
    if (pattern.literalKind === "bool") {
      return value.kind === "bool" && pattern.value === (value.value ? "true" : "false");
    }
    if (pattern.literalKind === "number") {
      return value.kind === "number" && value.value === pattern.value;
    }
    if (pattern.literalKind === "string") {
      return value.kind === "string" && JSON.stringify(value.value) === pattern.value;
    }
    if (pattern.literalKind === "literalType") {
      return value.kind === "literal" && `#${value.value}` === pattern.value;
    }
  }
  return false;
}

function bindTypeParamPattern(
  pattern: ParamPattern | undefined,
  fallbackName: string,
  value: TypeEvalValue,
  locals: Map<string, TypeEvalValue>,
) {
  if (!pattern || pattern.kind === "binding") {
    locals.set(pattern?.kind === "binding" ? pattern.name : fallbackName, value);
  }
}

function typeExprPatternMatches(pattern: string, value: TypeEvalValue): boolean {
  if (pattern === "_") return true;
  if (value.kind === "bool") return pattern === (value.value ? "true" : "false");
  if (value.kind === "number") return pattern === value.value;
  if (value.kind === "string") return pattern === JSON.stringify(value.value);
  if (value.kind === "literal") return pattern === `#${value.value}`;
  if (value.kind === "type") return pattern === value.name;
  return false;
}

function typeEvalKey(value: TypeEvalValue): string {
  return JSON.stringify(value);
}

function renderTypeEvalValue(value: TypeEvalValue): string {
  if (value.kind === "type") return value.name;
  if (value.kind === "literal") return `#${value.value}`;
  if (value.kind === "string") return JSON.stringify(value.value);
  if (value.kind === "number") return value.value;
  if (value.kind === "bool") return value.value ? "true" : "false";
  if (value.kind === "static_builtin") return `@${value.name}`;
  return "<never>";
}

function substituteTypeExpr(expr: TypeExpr, locals: Map<string, TypeEvalValue>): TypeExpr {
  if (expr.kind === "type_ref") {
    const local = locals.get(expr.name);
    if (local?.kind === "type") return parseAnnotationType(local.name) ?? expr;
    if (local?.kind === "literal") return { kind: "type_literal", value: local.value };
    if (local?.kind === "string") return { kind: "type_string", value: local.value };
    return expr;
  }
  if (expr.kind === "type_static_ref") return expr;
  if (expr.kind === "type_call") {
    return {
      kind: "type_call",
      callee: substituteTypeExpr(expr.callee, locals),
      args: expr.args.map((arg) => substituteTypeExpr(arg, locals)),
    };
  }
  if (expr.kind === "type_shape") {
    return { ...expr, shape: substituteShape(expr.shape, locals) };
  }
  if (expr.kind === "type_match") {
    return {
      kind: "type_match",
      value: substituteTypeExpr(expr.value, locals),
      arms: expr.arms.map((arm) => ({
        pattern: arm.pattern,
        value: substituteTypeExpr(arm.value, locals),
      })),
    };
  }
  if (expr.kind === "type_binary") {
    return {
      kind: "type_binary",
      op: expr.op,
      left: substituteTypeExpr(expr.left, locals),
      right: substituteTypeExpr(expr.right, locals),
    };
  }
  return expr;
}

function substituteShape(shape: TypeShape, locals: Map<string, TypeEvalValue>): TypeShape {
  return {
    slots: shape.slots.map((slot) => ({
      ...slot,
      type: substituteTypeExpr(slot.type, locals),
    })),
    members: shape.members?.map((member) => ({
      ...member,
      type: substituteTypeSource(member.type, locals),
    })),
  };
}

function substituteTypeSource(source: string, locals: Map<string, TypeEvalValue>): string {
  let result = source;
  for (const [name, value] of locals) {
    if (value.kind === "type") {
      result = result.replace(new RegExp(`\\b${name}\\b`, "g"), value.name);
    }
  }
  return result;
}

function parseAnnotationTypeCalls(source: string): TypeExpr[] {
  const parsed = parseAnnotationType(source);
  return parsed ? collectTypeCalls(parsed) : [];
}

function collectTypeCalls(expr: TypeExpr): TypeExpr[] {
  const nested: TypeExpr[] = [];
  if (expr.kind === "type_call") {
    nested.push(expr);
    nested.push(...collectTypeCalls(expr.callee));
    for (const arg of expr.args) nested.push(...collectTypeCalls(arg));
  } else if (expr.kind === "type_match") {
    nested.push(...collectTypeCalls(expr.value));
    for (const arm of expr.arms) nested.push(...collectTypeCalls(arm.value));
  } else if (expr.kind === "type_shape") {
    for (const slot of expr.shape.slots) nested.push(...collectTypeCalls(slot.type));
  } else if (expr.kind === "type_fn") {
    for (const item of expr.source.match(/[A-Za-z_][A-Za-z0-9_]*(?:\([^()]*\))/g) ?? []) {
      if (item.startsWith("fn(")) continue;
      const parsed = parseAnnotationType(item);
      if (parsed && parsed.kind !== "type_fn") nested.push(...collectTypeCalls(parsed));
    }
  }
  return nested;
}

function parseAnnotationType(source: string): TypeExpr | undefined {
  const parser = new AnnotationTypeParser(source);
  return parser.parse();
}

class AnnotationTypeParser {
  private index = 0;

  constructor(private source: string) {}

  parse(): TypeExpr | undefined {
    this.skip();
    const expr = this.parseType();
    this.skip();
    return expr;
  }

  private parseType(): TypeExpr | undefined {
    this.skip();
    if (this.peekKeyword("fn")) {
      return { kind: "type_fn", source: this.source.slice(this.index).trim() };
    }
    if (this.peek("[")) return { kind: "type_shape", shape: this.parseShape() };
    const name = this.ident();
    if (!name) return undefined;
    let expr: TypeExpr = { kind: "type_ref", name };
    this.skip();
    while (this.peek("(")) {
      this.index++;
      const args: TypeExpr[] = [];
      this.skip();
      while (!this.peek(")") && this.index < this.source.length) {
        const arg = this.parseType();
        if (!arg) break;
        args.push(arg);
        this.skip();
        if (this.peek(",")) {
          this.index++;
          this.skip();
        } else {
          break;
        }
      }
      if (this.peek(")")) this.index++;
      expr = { kind: "type_call", callee: expr, args };
      this.skip();
    }
    return expr;
  }

  private parseShape(): TypeShape {
    this.index++;
    const slots: TypeShape["slots"] = [];
    this.skip();
    while (!this.peek("]") && this.index < this.source.length) {
      const start = this.index;
      const first = this.ident();
      let label: string | undefined;
      this.skip();
      if (first && this.peek(":")) {
        label = first;
        this.index++;
      } else {
        this.index = start;
      }
      const type = this.parseType() ??
        { kind: "type_ref" as const, name: this.readUntil([",", "]"]).trim() };
      slots.push({ label, type });
      this.skip();
      if (this.peek(",")) {
        this.index++;
        this.skip();
      }
    }
    if (this.peek("]")) this.index++;
    return { slots };
  }

  private ident(): string | undefined {
    this.skip();
    const match = this.source.slice(this.index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!match) return undefined;
    this.index += match[0].length;
    return match[0];
  }

  private readUntil(chars: string[]): string {
    const start = this.index;
    while (this.index < this.source.length && !chars.includes(this.source[this.index])) {
      this.index++;
    }
    return this.source.slice(start, this.index);
  }

  private peek(text: string): boolean {
    this.skip();
    return this.source.startsWith(text, this.index);
  }

  private peekKeyword(text: string): boolean {
    this.skip();
    return this.source.startsWith(text, this.index) &&
      !/[A-Za-z0-9_]/.test(this.source[this.index + text.length] ?? "");
  }

  private skip() {
    while (/\s/.test(this.source[this.index] ?? "")) this.index++;
  }
}

function checkFn(
  fn: FnDecl,
  capabilities: Map<string, string[]>,
  diagnostics: Diagnostic[],
  types: TypeDecl[],
  functions: FnDecl[],
) {
  const env = new Map<string, { moved: boolean; forkDebt: number; type?: string }>();
  for (const param of fn.params) {
    env.set(param.name, { moved: false, forkDebt: 0, type: param.type });
  }
  checkBlock(fn.body, env, capabilities, fn.effects, diagnostics, fn.returnType, types, functions);
}

function checkStatement(
  stmt: Statement,
  env: Map<string, { moved: boolean; forkDebt: number; type?: string }>,
  capabilities: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  types: TypeDecl[],
  functions: FnDecl[],
) {
  if (stmt.kind === "let") {
    checkExpr(stmt.value, env, capabilities, effects, diagnostics, stmt.type, types, functions);
    env.set(stmt.name, { moved: false, forkDebt: 0, type: stmt.type });
    return;
  }
  if (stmt.kind === "proof_const") return;
  if (stmt.kind === "destructure_let") {
    checkExpr(stmt.value, env, capabilities, effects, diagnostics, undefined, types, functions);
    const slots = destructureSlotTypes(stmt.value, types, functions);
    if (slots.length <= 1) {
      diagnostics.push({
        code: "type.destructure_non_multi",
        message: "destructuring let requires a value with multiple runtime result slots",
      });
    } else if (slots.length !== stmt.names.length) {
      diagnostics.push({
        code: "type.destructure_arity",
        message: `destructuring let expected ${slots.length} names but got ${stmt.names.length}`,
      });
    }
    stmt.slotTypes = slots;
    for (let index = 0; index < stmt.names.length; index++) {
      env.set(stmt.names[index], { moved: false, forkDebt: 0, type: slots[index] });
    }
    return;
  }

  const binding = env.get(stmt.source);
  if (!binding) {
    diagnostics.push({
      code: "ownership.unknown_fork",
      message: `cannot fork unknown value ${stmt.source}`,
    });
    return;
  }
  if (binding.moved) {
    diagnostics.push({
      code: "ownership.use_after_move",
      message: `value ${stmt.source} was moved`,
    });
    return;
  }
  binding.moved = true;
  stmt.sourceType = binding.type;
  for (const name of stmt.names) {
    env.set(name, { moved: false, forkDebt: 0, type: binding.type });
  }
}

function destructureSlotTypes(expr: Expr, types: TypeDecl[], functions: FnDecl[]): string[] {
  let returnType: string | undefined;
  if (expr.kind === "call") {
    const callee = expr.callee;
    if (callee.kind === "var") {
      returnType = functions.find((fn) => fn.name === callee.name)?.returnType;
    }
  }
  if (!returnType) return [];
  return runtimeSlotTypes(returnType, types);
}

function runtimeSlotTypes(type: string, types: TypeDecl[]): string[] {
  const decl = types.find((item) => item.name === typeNameOf(type));
  if (decl?.normalized?.kind !== "product") return [type];
  const slots = decl.normalized.shape.slots.flatMap((slot) =>
    Array.from({ length: slot.repeat ? Number.parseInt(slot.repeat, 10) : 1 }, () => slot.type)
  );
  return slots.length > 1 ? slots : [type];
}

function typeNameOf(type: string): string {
  return type.trim().split("(")[0]?.trim() ?? type.trim();
}

function checkExpr(
  expr: Expr,
  env: Map<string, { moved: boolean; forkDebt: number; type?: string }>,
  capabilities: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expectedType?: string,
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
) {
  switch (expr.kind) {
    case "var": {
      checkProjection(expr.name, env, types, diagnostics);
      const binding = env.get(expr.name);
      if (binding?.moved) {
        diagnostics.push({
          code: "ownership.use_after_move",
          message: `value ${expr.name} was moved`,
        });
      }
      return;
    }
    case "placeholder":
      diagnostics.push({
        code: "const.placeholder_context",
        message: "$ is only valid in a pipeline stage or expected unary const fn argument",
      });
      return;
    case "call": {
      if (expr.callee.kind === "var") {
        const calleeName = expr.callee.name;
        if (
          calleeName.startsWith("range_iter.") &&
          !functions.some((fn) => fn.name === calleeName) &&
          !capabilities.has(calleeName)
        ) {
          diagnostics.push({
            code: "function.unknown",
            message: `unknown function ${calleeName}`,
          });
        }
        const capabilityEffects = capabilities.get(calleeName);
        if (capabilityEffects && !capabilityEffects.every((effect) => effects.includes(effect))) {
          diagnostics.push({
            code: "effect.pure_host_call",
            message: `capability ${expr.callee.name} requires effects {${
              capabilityEffects.join(", ")
            }}`,
          });
        }
      }
      const borrowArgIndexes = borrowedCallArgIndexes(expr, functions);
      for (let index = 0; index < expr.args.length; index++) {
        const arg = expr.args[index];
        checkExpr(arg, env, capabilities, effects, diagnostics, undefined, types, functions);
        if (borrowArgIndexes.has(index)) continue;
        if (arg.kind === "var") {
          const binding = env.get(arg.name);
          if (binding && binding.forkDebt === 0) binding.moved = true;
          else if (binding) binding.forkDebt--;
        }
      }
      return;
    }
    case "index":
      checkExpr(expr.target, env, capabilities, effects, diagnostics, undefined, types, functions);
      checkExpr(expr.index, env, capabilities, effects, diagnostics, undefined, types, functions);
      checkDirectIndex(expr, env, types, diagnostics);
      return;
    case "binary":
      checkExpr(
        expr.left,
        env,
        capabilities,
        effects,
        diagnostics,
        numericExpectedType(expectedType),
        types,
        functions,
      );
      checkExpr(
        expr.right,
        env,
        capabilities,
        effects,
        diagnostics,
        numericExpectedType(expectedType),
        types,
        functions,
      );
      return;
    case "pipe_bind": {
      checkExpr(expr.value, env, capabilities, effects, diagnostics, undefined, types, functions);
      if (expr.value.kind === "var") {
        const binding = env.get(expr.value.name);
        if (binding && binding.forkDebt === 0) binding.moved = true;
        else if (binding) binding.forkDebt--;
      }
      const scoped = new Map(env);
      scoped.set(expr.name, {
        moved: false,
        forkDebt: 0,
        type: exprBindingType(expr.value, env, types, functions),
      });
      checkExpr(
        expr.body,
        scoped,
        capabilities,
        effects,
        diagnostics,
        expectedType,
        types,
        functions,
      );
      return;
    }
    case "match":
      checkExpr(expr.value, env, capabilities, effects, diagnostics, undefined, types, functions);
      for (const arm of expr.arms) {
        checkExpr(
          arm.value,
          new Map(env),
          capabilities,
          effects,
          diagnostics,
          expectedType,
          types,
          functions,
        );
      }
      return;
    case "shape":
      for (const slot of expr.slots) {
        checkExpr(slot.value, env, capabilities, effects, diagnostics, undefined, types, functions);
      }
      return;
    case "product_constructor":
      for (const slot of expr.slots) {
        checkExpr(slot.value, env, capabilities, effects, diagnostics, undefined, types, functions);
      }
      return;
    case "range":
      checkExpr(expr.start, env, capabilities, effects, diagnostics, undefined, types, functions);
      checkExpr(expr.end, env, capabilities, effects, diagnostics, undefined, types, functions);
      return;
    case "block":
      checkBlock(
        expr,
        new Map(env),
        capabilities,
        effects,
        diagnostics,
        expectedType,
        types,
        functions,
      );
      return;
    case "literal":
      if (
        expr.literalKind === "number" && expectedType === "i32" && isUnsuffixedInteger(expr.value)
      ) {
        expr.inferredType = "i32";
      }
      return;
  }
}

function borrowedCallArgIndexes(
  expr: Extract<Expr, { kind: "call" }>,
  functions: FnDecl[],
): Set<number> {
  if (expr.callee.kind !== "var") return new Set();
  const calleeName = expr.callee.name;
  const fn = functions.find((fn) => fn.name === calleeName);
  const intrinsicId = fn ? intrinsicWrapperId(fn) : undefined;
  if (intrinsicId === "memory_load_i32" || intrinsicId === "memory_load_lane4_i32") {
    return new Set([0]);
  }
  return new Set();
}

function exprBindingType(
  expr: Expr,
  env: Map<string, { moved: boolean; forkDebt: number; type?: string }>,
  _types: TypeDecl[],
  functions: FnDecl[],
): string | undefined {
  if (expr.kind === "var") return env.get(expr.name)?.type;
  if (expr.kind === "call") {
    const callee = expr.callee;
    if (callee.kind === "var") return functions.find((fn) => fn.name === callee.name)?.returnType;
  }
  if (expr.kind === "pipe_bind") return exprBindingType(expr.body, env, _types, functions);
  if (expr.kind === "range") return "range_i32";
  if (expr.kind === "literal") return expr.inferredType;
  return undefined;
}

function checkBlock(
  block: Extract<Expr, { kind: "block" }>,
  env: Map<string, { moved: boolean; forkDebt: number; type?: string }>,
  capabilities: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expectedType?: string,
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
) {
  const ordered = orderBlockStatements(block.statements, diagnostics);
  for (const stmt of ordered) {
    checkStatement(stmt, env, capabilities, effects, diagnostics, types, functions);
  }
  if (block.expr) {
    checkExpr(block.expr, env, capabilities, effects, diagnostics, expectedType, types, functions);
  }
}

function checkProjection(
  name: string,
  env: Map<string, { moved: boolean; forkDebt: number; type?: string }>,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  const match = name.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[[0-9]+\])+$/);
  if (!match) return;
  const baseType = env.get(match[1])?.type;
  const index = Number.parseInt(name.match(/\[([0-9]+)\]/)?.[1] ?? "", 10);
  const capacity = inlineArrayCapacity(baseType, types);
  if (capacity !== undefined && index >= capacity) {
    diagnostics.push({
      code: "index.out_of_bounds",
      message: `inline array index ${index} is out of bounds for capacity ${capacity}`,
    });
  }
}

function checkDirectIndex(
  expr: Extract<Expr, { kind: "index" }>,
  env: Map<string, { moved: boolean; forkDebt: number; type?: string }>,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  if (expr.target.kind !== "var") return;
  const targetType = env.get(expr.target.name)?.type;
  const capacity = inlineArrayCapacity(targetType, types);
  if (capacity === undefined) return;
  if (expr.index.kind === "literal" && expr.index.literalKind === "number") {
    const index = Number.parseInt(expr.index.value, 10);
    if (index >= capacity) {
      diagnostics.push({
        code: "index.out_of_bounds",
        message: `inline array index ${index} is out of bounds for capacity ${capacity}`,
      });
    }
    return;
  }
  const indexType = expr.index.kind === "var" ? env.get(expr.index.name)?.type : undefined;
  const proof = indexType?.match(/^index\((\d+)\)$/);
  if (proof && Number.parseInt(proof[1], 10) === capacity) return;
  diagnostics.push({
    code: "index.requires_proof",
    message:
      `direct inline-array indexing requires index(${capacity}); use get(xs, i) for raw i32 checked access`,
  });
}

function inlineArrayCapacity(type: string | undefined, types: TypeDecl[]): number | undefined {
  const resolved = resolveAliasType(type, types);
  const match = resolved?.match(/^inline_array\((\d+),/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function resolveAliasType(type: string | undefined, types: TypeDecl[]): string | undefined {
  let current = type?.trim();
  const byName = new Map(types.map((decl) => [decl.name, decl]));
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const decl = byName.get(current);
    if (decl?.normalized?.kind !== "alias") return current;
    current = decl.normalized.type;
  }
  return current;
}

function orderBlockStatements(statements: Statement[], diagnostics: Diagnostic[]): Statement[] {
  const owners = new Map<string, number>();
  let hasDuplicate = false;
  statements.forEach((stmt, index) => {
    for (const name of boundNames(stmt)) {
      if (owners.has(name)) {
        diagnostics.push({
          code: "type.duplicate_local",
          message: `duplicate local binding ${name}`,
        });
        hasDuplicate = true;
      } else {
        owners.set(name, index);
      }
    }
  });
  if (hasDuplicate) return statements;

  const dependencies = statements.map((stmt) => {
    const refs = new Set<string>();
    collectStatementRefs(stmt, refs);
    return [...refs]
      .map((name) => owners.get(name))
      .filter((index): index is number => index !== undefined);
  });
  const state = new Array<"visiting" | "done" | undefined>(statements.length);
  const ordered: Statement[] = [];
  let hasCycle = false;

  const visit = (index: number, stack: number[]) => {
    if (state[index] === "done") return;
    if (state[index] === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(index)), index]
        .map((item) => boundNames(statements[item]).join(", "))
        .join(" -> ");
      diagnostics.push({
        code: "type.local_cycle",
        message: `local binding cycle${cycle ? `: ${cycle}` : ""}`,
      });
      hasCycle = true;
      return;
    }
    state[index] = "visiting";
    for (const dependency of dependencies[index]) visit(dependency, [...stack, index]);
    state[index] = "done";
    ordered.push(statements[index]);
  };

  for (let index = 0; index < statements.length; index++) visit(index, []);
  return hasCycle ? statements : ordered;
}

function boundNames(stmt: Statement): string[] {
  if (stmt.kind === "let") return [stmt.name];
  if (stmt.kind === "proof_const") return [stmt.name];
  return stmt.names;
}

function collectStatementRefs(stmt: Statement, refs: Set<string>) {
  if (stmt.kind === "let") collectExprRefs(stmt.value, refs, new Set());
  else if (stmt.kind === "destructure_let") collectExprRefs(stmt.value, refs, new Set());
  else if (stmt.kind === "fork_let") refs.add(stmt.source);
}

function collectExprRefs(expr: Expr, refs: Set<string>, shadowed: Set<string>) {
  switch (expr.kind) {
    case "var":
      if (!shadowed.has(expr.name)) refs.add(expr.name);
      return;
    case "call":
      collectExprRefs(expr.callee, refs, shadowed);
      for (const arg of expr.args) collectExprRefs(arg, refs, shadowed);
      return;
    case "binary":
      collectExprRefs(expr.left, refs, shadowed);
      collectExprRefs(expr.right, refs, shadowed);
      return;
    case "pipe_bind": {
      collectExprRefs(expr.value, refs, shadowed);
      const nestedShadowed = new Set(shadowed);
      nestedShadowed.add(expr.name);
      collectExprRefs(expr.body, refs, nestedShadowed);
      return;
    }
    case "match":
      collectExprRefs(expr.value, refs, shadowed);
      for (const arm of expr.arms) collectExprRefs(arm.value, refs, shadowed);
      return;
    case "shape":
      for (const slot of expr.slots) collectExprRefs(slot.value, refs, shadowed);
      return;
    case "product_constructor":
      for (const slot of expr.slots) collectExprRefs(slot.value, refs, shadowed);
      return;
    case "range":
      collectExprRefs(expr.start, refs, shadowed);
      collectExprRefs(expr.end, refs, shadowed);
      return;
    case "block":
      collectBlockRefs(expr, refs, shadowed);
      return;
    case "literal":
    case "placeholder":
      return;
  }
}

function collectBlockRefs(
  block: Extract<Expr, { kind: "block" }>,
  refs: Set<string>,
  shadowed: Set<string>,
) {
  const nestedShadowed = new Set(shadowed);
  for (const stmt of block.statements) {
    for (const name of boundNames(stmt)) nestedShadowed.add(name);
  }
  for (const stmt of block.statements) {
    if (stmt.kind === "let") collectExprRefs(stmt.value, refs, nestedShadowed);
    else if (stmt.kind === "destructure_let") collectExprRefs(stmt.value, refs, nestedShadowed);
    else if (stmt.kind === "fork_let" && !nestedShadowed.has(stmt.source)) refs.add(stmt.source);
  }
  if (block.expr) collectExprRefs(block.expr, refs, nestedShadowed);
}

function numericExpectedType(expectedType: string | undefined): string | undefined {
  return expectedType === "i32" ? "i32" : undefined;
}

function isUnsuffixedInteger(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function isUnsignedIntegerType(type: string): boolean {
  const match = type.match(/^u([1-9][0-9]*)$/);
  if (!match) return false;
  const width = Number.parseInt(match[1], 10);
  return width >= 1 && width <= 64;
}
