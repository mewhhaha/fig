import type {
  ConstDecl,
  Expr,
  FnDecl,
  OperatorDescriptor,
  Param,
  ParamPattern,
  Program,
  ShapeType,
  Statement,
  StaticForSource,
  TypeBody,
  TypeCountExpr,
  TypeDecl,
  TypeExpr,
  TypeParamKind,
  TypePattern,
  TypeResultKind,
  TypeShape,
} from "./core_ast.ts";
import { CompileError, type Diagnostic, type Span } from "./diagnostics.ts";
import { intrinsicWrapperId, isIntrinsicWrapper, isKnownIntrinsicId } from "./primitives.ts";
import { type ShaderManifestEntry, shaderManifestEntry, wgslShaderId } from "./wgsl.ts";

export interface CheckResult {
  program: Program;
  shaderManifest: ShaderManifestEntry[];
}

export interface AnalysisCheckResult extends CheckResult {
  diagnostics: Diagnostic[];
}

function diagnosticAt(
  code: string,
  message: string,
  spanLike?: { span?: Span; nameSpan?: Span },
): Diagnostic {
  return { code, message, span: spanLike?.nameSpan ?? spanLike?.span };
}

function callSiteSpan(expr: Extract<Expr, { kind: "call" }>): Span | undefined {
  const start = expr.callee.span?.start ?? expr.span?.start;
  const end = expr.span?.end ?? expr.args.at(-1)?.span?.end ?? expr.callee.span?.end;
  if (start === undefined || end === undefined) return expr.span ?? expr.callee.span;
  return { ...(expr.span ?? expr.callee.span!), start, end };
}

function exprDiagnosticSpan(expr: Expr | undefined): Span | undefined {
  if (!expr) return undefined;
  if (expr.span) return expr.span;
  if (expr.kind === "call") return callSiteSpan(expr);
  const childSpans = exprChildren(expr).map(exprDiagnosticSpan).filter((span): span is Span =>
    span !== undefined
  );
  if (!childSpans.length) return undefined;
  const start = Math.min(...childSpans.map((span) => span.start));
  const end = Math.max(...childSpans.map((span) => span.end));
  return { ...childSpans[0], start, end };
}

export function checkProgram(program: Program): CheckResult {
  const result = checkProgramInternal(program, { recoverTypes: false });
  if (result.diagnostics.length) throw new CompileError(result.diagnostics);
  return { program: result.program, shaderManifest: result.shaderManifest };
}

export function checkProgramForAnalysis(program: Program): AnalysisCheckResult {
  return checkProgramInternal(program, { recoverTypes: true });
}

function checkProgramInternal(
  program: Program,
  options: { recoverTypes: boolean },
): AnalysisCheckResult {
  const diagnostics: Diagnostic[] = [];
  const shaderManifest = new Map<number, ShaderManifestEntry>();
  const addShader = (source: string) => {
    const entry = shaderManifestEntry(source);
    shaderManifest.set(entry.id, entry);
    return entry;
  };
  const capabilities = new Map(program.imports.map((item) => [item.name, item.effects]));
  checkBorrowTypeRestrictions(program, diagnostics);
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
  resolveAttachedMemberCalls(program, typeDecls);
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
    typeDecls,
    addShader,
    diagnostics,
    true,
  );
  resolveAttachedMemberCalls(program, typeDecls);
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  specializeInferredTypeCalls(
    program,
    new Map(fnDecls.map((decl) => [decl.name, decl])),
    constValues,
    typeDecls,
    diagnostics,
    true,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  resolveAttachedMemberCalls(program, typeDecls);
  specializeConstParamCalls(
    program,
    new Map(fnDecls.map((decl) => [decl.name, decl])),
    constValues,
    typeDecls,
    addShader,
    diagnostics,
    false,
  );
  fnDecls = program.declarations.filter((decl): decl is FnDecl => decl.kind === "fn");
  resolveAttachedMemberCalls(program, typeDecls);
  functions = new Set(fnDecls.map((decl) => decl.name));
  checkConstDictionaries(
    program.declarations.filter((decl): decl is ConstDecl => decl.kind === "const"),
    typeDecls,
    fnDecls,
    capabilities,
    functions,
    diagnostics,
  );
  checkTypeContracts(program, typeDecls, fnDecls, capabilities, constValues, diagnostics);
  lowerResolvedOperators(program, typeDecls, fnDecls, diagnostics);
  lowerCollectorLiterals(program, typeDecls, fnDecls, diagnostics);
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
        checkFn(decl, capabilities, diagnostics, typeDecls, fnDecls, options);
      }
    }
  }
  for (let index = diagnostics.length - 1; index >= 0; index--) {
    const diagnostic = diagnostics[index];
    if (
      diagnostic?.code === "type.builder_arg" &&
      diagnostic.span === undefined &&
      diagnostic.message === "struct(...) requires one type-block shape binding"
    ) {
      diagnostics.splice(index, 1);
    } else if (
      diagnostic?.code === "type.unknown_shape_slot" &&
      diagnostic.message === "unknown shape slot <unknown>"
    ) {
      diagnostics.splice(index, 1);
    } else if (
      diagnostic?.code === "type.unknown_type_member" &&
      /type @shape_slot\(.+, Key\) does not have an empty value/.test(diagnostic.message)
    ) {
      diagnostics.splice(index, 1);
    } else if (
      diagnostic?.code === "const.static_param_arg" &&
      diagnostic.span === undefined
    ) {
      diagnostics.splice(index, 1);
    }
  }
  const hasGenericShapeNoise = diagnostics.some((diagnostic) =>
    diagnostic.code === "type.shape_builtin_arg" && diagnostic.span === undefined
  );
  if (hasGenericShapeNoise) {
    for (let index = diagnostics.length - 1; index >= 0; index--) {
      const diagnostic = diagnostics[index];
      if (
        diagnostic?.span === undefined &&
        (diagnostic.code === "type.shape_builtin_arg" ||
          (diagnostic.code === "type.require" &&
            diagnostic.message.startsWith("entity row field ")))
      ) {
        diagnostics.splice(index, 1);
      }
    }
  }
  return {
    program,
    diagnostics,
    shaderManifest: [...shaderManifest.values()].sort((a, b) => a.id - b.id),
  };
}

function checkBorrowTypeRestrictions(program: Program, diagnostics: Diagnostic[]) {
  const checkType = (
    type: string | undefined,
    context: "param" | "owned",
    spanLike?: { span?: Span; nameSpan?: Span },
  ) => {
    if (!type) return;
    const trimmed = type.trim();
    const fn = parseFnSignature(trimmed);
    if (fn) {
      for (const param of fn.params) checkType(param, "param", spanLike);
      checkType(fn.returnType, "owned", spanLike);
    }
  };
  const checkExpr = (expr: Expr | undefined) => {
    if (!expr) return;
    if (expr.kind === "block") {
      for (const stmt of expr.statements) {
        if (stmt.kind === "let") checkType(stmt.type, "owned", stmt);
        if (stmt.kind === "let" || stmt.kind === "destructure_let") checkExpr(stmt.value);
      }
      checkExpr(expr.expr);
      return;
    }
    for (const child of exprChildValues(expr)) checkExpr(child);
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      for (const param of decl.params) checkType(param.type, "param", param);
      checkType(decl.returnType, "owned", decl);
      checkExpr(decl.body);
    } else if (decl.kind === "let" || decl.kind === "const") {
      checkType(decl.type, "owned", decl);
      checkExpr(decl.value);
    } else {
      for (const stmt of decl.body.statements) checkType(renderTypeExpr(stmt.value), "owned", stmt);
      if (decl.body.expr) checkType(renderTypeExpr(decl.body.expr), "owned", decl);
    }
  }
}

function exprChildValues(expr: Expr): Expr[] {
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
    case "static_for_slots":
      return [
        expr.value,
        ...(expr.source.kind === "range"
          ? [expr.source.start, expr.source.end]
          : [expr.source.shape]),
      ];
    case "field":
      return [expr.value, expr.key];
    case "range":
      return [expr.start, expr.end];
    case "block":
    case "literal":
    case "placeholder":
    case "var":
      return [];
  }
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

function lowerResolvedOperators(
  program: Program,
  typeDecls: TypeDecl[],
  fnDecls: FnDecl[],
  diagnostics: Diagnostic[],
) {
  const descriptors = typeDecls
    .flatMap((decl): { decl: TypeDecl; descriptor: OperatorDescriptor }[] =>
      decl.resultKind === "operator" && decl.normalized?.kind === "operator"
        ? [{ decl, descriptor: decl.normalized.descriptor }]
        : []
    );
  if (!descriptors.length) return;
  const functions = new Map(fnDecls.map((fn) => [fn.name, fn]));
  const constructorTypes = new Map(
    typeDecls.flatMap((decl) =>
      decl.normalized?.kind === "product" ? [[decl.normalized.constructor, decl] as const] : []
    ),
  );
  for (const decl of typeDecls) {
    if (decl.normalized?.kind !== "product") continue;
    const terminal = terminalName(decl.normalized.constructor);
    if (!constructorTypes.has(terminal)) constructorTypes.set(terminal, decl);
  }

  const lowerExpr = (expr: Expr, env: Map<string, string>): Expr => {
    switch (expr.kind) {
      case "binary": {
        const left = lowerExpr(expr.left, env);
        const right = lowerExpr(expr.right, env);
        const leftType = inferRuntimeType(left, env, functions, constructorTypes);
        const rightType = inferRuntimeType(right, env, functions, constructorTypes);
        if (isPrimitiveBinaryOperator(expr.op, leftType, rightType) || (!leftType && !rightType)) {
          return { ...expr, left, right };
        }
        const resolved = resolveInfixOperator(
          expr.op,
          left,
          right,
          env,
          functions,
          constructorTypes,
          descriptors,
        );
        if (!resolved) {
          if (!leftType || !rightType) return { ...expr, left, right };
          diagnostics.push({
            code: "operator.missing",
            message: `no visible operator descriptor matches ${expr.op}`,
          });
          return { ...expr, left, right };
        }
        if (resolved === "ambiguous") {
          diagnostics.push({
            code: "operator.ambiguous",
            message: `multiple visible operator descriptors match ${expr.op}`,
          });
          return { ...expr, left, right };
        }
        return { kind: "call", callee: { kind: "var", name: resolved }, args: [left, right] };
      }
      case "call":
        return {
          ...expr,
          callee: lowerExpr(expr.callee, env),
          args: expr.args.map((arg) => lowerExpr(arg, env)),
        };
      case "index":
        return { ...expr, target: lowerExpr(expr.target, env), index: lowerExpr(expr.index, env) };
      case "pipe_bind":
        return { ...expr, value: lowerExpr(expr.value, env), body: lowerExpr(expr.body, env) };
      case "match":
        return {
          ...expr,
          value: lowerExpr(expr.value, env),
          arms: expr.arms.map((arm) => ({ ...arm, value: lowerExpr(arm.value, env) })),
        };
      case "shape":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value, env) })),
        };
      case "product_constructor":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value, env) })),
        };
      case "range":
        return { ...expr, start: lowerExpr(expr.start, env), end: lowerExpr(expr.end, env) };
      case "block": {
        const scoped = new Map(env);
        const statements = expr.statements.map((stmt) => {
          if (stmt.kind !== "let" && stmt.kind !== "destructure_let") return stmt;
          const value = lowerExpr(stmt.value, scoped);
          if (stmt.kind === "let" && stmt.type) scoped.set(stmt.name, stmt.type);
          else if (stmt.kind === "let") {
            const inferred = inferRuntimeType(value, scoped, functions);
            if (inferred) scoped.set(stmt.name, inferred);
          }
          return { ...stmt, value } as typeof stmt;
        });
        return { ...expr, statements, expr: expr.expr ? lowerExpr(expr.expr, scoped) : undefined };
      }
      default:
        return expr;
    }
  };

  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      const env = new Map(decl.params.map((param) => [param.name, param.type]));
      decl.body = lowerExpr(decl.body, env) as Extract<Expr, { kind: "block" }>;
    } else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = lowerExpr(decl.value, new Map());
    }
  }
}

function isPrimitiveBinaryOperator(op: string, left?: string, right?: string): boolean {
  if (op === "..") return true;
  if (["==", "!="].includes(op) && (literalTypeCarrier(left) || literalTypeCarrier(right))) {
    return (literalTypeCarrier(left) ?? left) === (literalTypeCarrier(right) ?? right);
  }
  return left === "i32" && right === "i32" &&
    ["+", "-", "*", "/", "%", "==", "!=", "<", "<=", ">", ">="].includes(op);
}

function lowerCollectorLiterals(
  program: Program,
  typeDecls: TypeDecl[],
  fnDecls: FnDecl[],
  diagnostics: Diagnostic[],
) {
  const functions = new Map(fnDecls.map((fn) => [fn.name, fn]));
  const lowerExpr = (expr: Expr, expectedType: string | undefined): Expr => {
    switch (expr.kind) {
      case "shape": {
        if (expr.syntax !== "collection") {
          const productSlots = productSlotTypes(expectedType, typeDecls, expr.slots.length);
          return {
            ...expr,
            slots: expr.slots.map((slot, index) => ({
              ...slot,
              value: lowerExpr(
                slot.value,
                slot.label
                  ? expectedShapeSlotType(expectedType, slot.label, typeDecls)
                  : productSlots?.[index],
              ),
            })),
          };
        }
        if (expr.slots.some((slot) => slot.spread)) {
          return {
            ...expr,
            slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value, undefined) })),
          };
        }
        const inlineArray = inlineArrayLikeTypeArgs(expectedType, typeDecls);
        if (inlineArray) {
          return {
            ...expr,
            slots: expr.slots.map((slot) => ({
              ...slot,
              value: lowerExpr(slot.value, inlineArray.itemType),
            })),
          };
        }
        const compactArray = compactArrayTypeArgs(expectedType, typeDecls);
        if (compactArray) {
          if (expr.slots.length > compactArray.count) {
            diagnostics.push(diagnosticAt(
              "collection.capacity",
              `collection literal has ${expr.slots.length} items but ${expectedType} has capacity ${compactArray.count}`,
              expr,
            ));
            return {
              ...expr,
              slots: expr.slots.map((slot) => ({
                ...slot,
                value: lowerExpr(slot.value, compactArray.itemType),
              })),
            };
          }
          const memberBase = compactArrayMemberBase(expectedType, typeDecls);
          if (memberBase) {
            return buildCompactArrayLiteral(
              expr.slots.map((slot) => lowerExpr(slot.value, compactArray.itemType)),
              memberBase,
              compactArray,
            );
          }
          return {
            ...expr,
            slots: expr.slots.map((slot) => ({
              ...slot,
              value: lowerExpr(slot.value, compactArray.itemType),
            })),
          };
        }
        const anonymousProductSlots = productSlotTypes(expectedType, typeDecls, expr.slots.length);
        if (anonymousProductSlots) {
          return {
            ...expr,
            slots: expr.slots.map((slot, index) => ({
              ...slot,
              value: lowerExpr(slot.value, anonymousProductSlots[index]),
            })),
          };
        }
        if (!expectedType) {
          return {
            ...expr,
            slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value, undefined) })),
          };
        }
        const collector = resolveCollectorProtocol(
          expectedType,
          typeDecls,
          functions,
          diagnostics,
          expr,
        );
        if (!collector) {
          return {
            ...expr,
            slots: expr.slots.map((slot) => ({ ...slot, value: lowerExpr(slot.value, undefined) })),
          };
        }
        return buildCollectorLiteral(
          expr.slots.map((slot) => lowerExpr(slot.value, collector.itemType)),
          collector,
        );
      }
      case "call": {
        const callee = lowerExpr(expr.callee, undefined);
        const fn = callee.kind === "var" ? functions.get(callee.name) : undefined;
        return {
          ...expr,
          callee,
          args: expr.args.map((arg, index) => lowerExpr(arg, fn?.params[index]?.type)),
        };
      }
      case "index":
        return {
          ...expr,
          target: lowerExpr(expr.target, undefined),
          index: lowerExpr(expr.index, undefined),
        };
      case "binary":
        return {
          ...expr,
          left: lowerExpr(expr.left, undefined),
          right: lowerExpr(expr.right, undefined),
        };
      case "pipe_bind":
        return {
          ...expr,
          value: lowerExpr(expr.value, undefined),
          body: lowerExpr(expr.body, expectedType),
        };
      case "match":
        return {
          ...expr,
          value: lowerExpr(expr.value, undefined),
          arms: expr.arms.map((arm) => ({ ...arm, value: lowerExpr(arm.value, expectedType) })),
        };
      case "product_constructor":
        return {
          ...expr,
          slots: expr.slots.map((slot) => ({
            ...slot,
            value: lowerExpr(
              slot.value,
              productConstructorSlotType(expr.constructor, slot.label, typeDecls),
            ),
          })),
        };
      case "range":
        return {
          ...expr,
          start: lowerExpr(expr.start, undefined),
          end: lowerExpr(expr.end, undefined),
        };
      case "static_for_slots":
        return { ...expr, value: lowerExpr(expr.value, expectedType) };
      case "field":
        return {
          ...expr,
          value: lowerExpr(expr.value, undefined),
          key: lowerExpr(expr.key, undefined),
        };
      case "block":
        return {
          ...expr,
          statements: expr.statements.map((stmt) => {
            if (stmt.kind === "let") {
              if (!stmt.type && stmt.value.kind === "shape" && stmt.value.syntax === "collection") {
                diagnostics.push(diagnosticAt(
                  "collection.expected_type",
                  "collection literal requires an expected target type",
                  stmt.value,
                ));
              }
              return { ...stmt, value: lowerExpr(stmt.value, stmt.type) };
            }
            if (stmt.kind === "destructure_let") {
              return { ...stmt, value: lowerExpr(stmt.value, undefined) };
            }
            return stmt;
          }),
          expr: expr.expr ? lowerExpr(expr.expr, expectedType) : undefined,
        };
      case "literal":
      case "placeholder":
      case "var":
        return expr;
    }
  };

  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      decl.body = lowerExpr(decl.body, decl.returnType) as Extract<Expr, { kind: "block" }>;
    } else if (decl.kind === "let" || decl.kind === "const") {
      decl.value = lowerExpr(decl.value, decl.type);
    }
  }
}

type CollectorProtocol = {
  constArgs: Expr[];
  start: string;
  push: string;
  finish: string;
  itemType: string;
};

function resolveCollectorProtocol(
  expectedType: string,
  typeDecls: TypeDecl[],
  functions: Map<string, FnDecl>,
  diagnostics: Diagnostic[],
  spanExpr: Expr,
): CollectorProtocol | undefined {
  const sourceType = expectedType.trim();
  const resolved = resolveAliasType(expectedType, typeDecls) ?? sourceType;
  const sourceTypeName = typeNameOf(sourceType);
  const decl = findTypeDecl(typeDecls, sourceTypeName) ??
    findTypeDecl(typeDecls, typeNameOf(resolved));
  const body = decl?.normalized;
  if (!decl) {
    if (expectedType.includes(".")) return undefined;
    diagnostics.push(diagnosticAt(
      "collection.collector_missing",
      `type ${expectedType} does not define collector members`,
      spanExpr,
    ));
    return undefined;
  }
  if (body?.kind !== "product" && body?.kind !== "sum") {
    diagnostics.push(diagnosticAt(
      "collection.collector_missing",
      `type ${expectedType} does not define collector members`,
      spanExpr,
    ));
    return undefined;
  }
  const target = (name: string) => body.members?.find((member) => member.name === name)?.target;
  const start = target("collect_start");
  const push = target("collect_push");
  const finish = target("collect_finish");
  if (!start || !push || !finish) {
    diagnostics.push(diagnosticAt(
      "collection.collector_missing",
      `type ${expectedType} does not define collector members`,
      spanExpr,
    ));
    return undefined;
  }
  const startFn = functions.get(start);
  const pushFn = functions.get(push);
  const finishFn = functions.get(finish);
  if (!startFn || !pushFn || !finishFn) {
    diagnostics.push(diagnosticAt(
      "collection.collector_signature",
      `collector members for ${expectedType} must resolve to functions`,
      spanExpr,
    ));
    return undefined;
  }
  const targetArgs = typeCallArgsForBase(sourceType, sourceTypeName) ??
    typeCallArgsForBase(resolved, typeNameOf(resolved));
  const constArgValues = targetArgs === undefined ? [] : splitTypeArgs(targetArgs);
  const leadingConstCount = startFn.params.findIndex((param) => !param.const);
  const constCount = leadingConstCount < 0 ? startFn.params.length : leadingConstCount;
  const constArgs = constArgValues.slice(0, constCount).map(typeArgExpr);
  const constBindings = new Map(
    startFn.params.slice(0, constCount).map((param, index) => [param.name, constArgValues[index]]),
  );
  const instantiated = (type: string | undefined) =>
    type ? substituteSignatureTypeArgs(type, constBindings) : undefined;
  const builderType = instantiated(startFn.returnType);
  const pushRuntime = pushFn.params.slice(constCount);
  const finishRuntime = finishFn.params.slice(constCount);
  const itemType = instantiated(pushRuntime[1]?.type);
  const expectedTypeCandidates = [
    expectedType,
    expectedType.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, ""),
  ];
  if (
    !builderType ||
    constArgs.length !== constCount ||
    pushRuntime.length !== 2 ||
    finishRuntime.length !== 1 ||
    !typeMatches(builderType, instantiated(pushRuntime[0]?.type) ?? "") ||
    !typeMatches(builderType, instantiated(pushFn.returnType) ?? "") ||
    !typeMatches(builderType, instantiated(finishRuntime[0]?.type) ?? "") ||
    !expectedTypeCandidates.some((candidate) =>
      typeMatches(candidate, instantiated(finishFn.returnType) ?? "")
    ) ||
    !itemType
  ) {
    diagnostics.push(diagnosticAt(
      "collection.collector_signature",
      `collector members for ${expectedType} must have collect_start -> Builder, collect_push(builder, item) -> Builder, and collect_finish(builder) -> Target`,
      spanExpr,
    ));
    return undefined;
  }
  return { constArgs, start, push, finish, itemType };
}

function productSlotTypes(
  expectedType: string | undefined,
  typeDecls: TypeDecl[],
  arity: number,
): string[] | undefined {
  const resolved = resolveAliasType(expectedType, typeDecls) ?? expectedType;
  const decl = findTypeDecl(typeDecls, typeNameOf(resolved ?? ""));
  if (decl?.normalized?.kind !== "product") return undefined;
  const slots = decl.normalized.shape.slots;
  if (slots.length !== arity) return undefined;
  const args = typeCallArgsForBase(resolved ?? "", typeNameOf(resolved ?? ""));
  const argValues = args === undefined ? [] : splitTypeArgs(args);
  const bindings = new Map(decl.params.map((param, index) => [param.name, argValues[index]]));
  return slots.map((slot) => substituteSignatureTypeArgs(slot.type, bindings));
}

function findTypeDecl(typeDecls: TypeDecl[], name: string): TypeDecl | undefined {
  return typeDecls.find((item) => item.name === name) ??
    typeDecls.find((item) => terminalName(item.name) === terminalName(name));
}

function substituteSignatureTypeArgs(
  type: string,
  bindings: Map<string, string | undefined>,
): string {
  let result = type;
  for (const [name, value] of bindings) {
    if (!value) continue;
    result = result.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }
  return result;
}

function typeArgExpr(source: string): Expr {
  if (/^-?\d+$/.test(source)) return { kind: "literal", literalKind: "number", value: source };
  if (source === "true" || source === "false") {
    return { kind: "literal", literalKind: "bool", value: source };
  }
  return { kind: "var", name: source };
}

function buildCollectorLiteral(items: Expr[], collector: CollectorProtocol): Expr {
  let builder: Expr = {
    kind: "call",
    callee: { kind: "var", name: collector.start },
    args: [...collector.constArgs],
  };
  for (const item of items) {
    builder = {
      kind: "call",
      callee: { kind: "var", name: collector.push },
      args: [...collector.constArgs, builder, item],
    };
  }
  return {
    kind: "call",
    callee: { kind: "var", name: collector.finish },
    args: [...collector.constArgs, builder],
  };
}

function buildCompactArrayLiteral(
  items: Expr[],
  memberBase: string,
  compactArray: { count: number; itemType: string },
): Expr {
  const namespaceEnd = memberBase.lastIndexOf(".");
  const namespace = namespaceEnd >= 0 ? `${memberBase.slice(0, namespaceEnd)}.` : "";
  const paddedItems = [
    ...items,
    ...Array.from(
      { length: compactArray.count - items.length },
      () => compactArrayZeroValue(compactArray.itemType),
    ),
  ];
  return {
    kind: "product_constructor",
    constructor: `${namespace}CompactArray`,
    slots: [
      {
        label: "items",
        value: {
          kind: "shape",
          syntax: "collection",
          slots: paddedItems.map((value) => ({ value })),
        },
      },
      {
        label: "len",
        value: { kind: "literal", literalKind: "number", value: String(items.length) },
      },
    ],
  };
}

function compactArrayZeroValue(itemType: string): Expr {
  if (itemType.trim() === "bool") return { kind: "literal", literalKind: "bool", value: "false" };
  return { kind: "literal", literalKind: "number", value: "0" };
}

function resolveInfixOperator(
  symbol: string,
  left: Expr,
  right: Expr,
  env: Map<string, string>,
  functions: Map<string, FnDecl>,
  constructorTypes: Map<string, TypeDecl>,
  descriptors: { decl: TypeDecl; descriptor: OperatorDescriptor }[],
): string | "ambiguous" | undefined {
  const leftType = inferRuntimeType(left, env, functions, constructorTypes);
  const rightType = inferRuntimeType(right, env, functions, constructorTypes);
  const matches: string[] = [];
  for (const { decl, descriptor } of descriptors) {
    if (descriptor.symbol !== symbol || !descriptor.fixity.startsWith("#infix")) continue;
    const target = substituteOperatorTarget(
      descriptor.target,
      decl,
      [leftType, rightType],
      functions,
    );
    const fn = functions.get(target);
    if (!fn || fn.params.length !== 2) continue;
    if (!operandMatchesParam(fn.params[0].type, left, leftType, functions)) continue;
    if (!operandMatchesParam(fn.params[1].type, right, rightType, functions)) continue;
    matches.push(target);
  }
  return matches.length > 1 ? "ambiguous" : matches[0];
}

function operandMatchesParam(
  expected: string,
  expr: Expr,
  actual: string | undefined,
  functions: Map<string, FnDecl>,
): boolean {
  if (actual && typeMatches(expected, actual)) return true;
  if (expr.kind !== "var") return false;
  return fnTypeMatches(expected, functions.get(expr.name));
}

function substituteOperatorTarget(
  target: string,
  decl: TypeDecl,
  operandTypes: (string | undefined)[],
  functions: Map<string, FnDecl>,
): string {
  if (!decl.params.length) return target;
  const bases = operandTypes
    .filter((type): type is string => !!type && !type.startsWith("fn("))
    .map((type) => type.replace(/\(.*\)$/, ""));
  for (const base of bases) {
    let result = target;
    for (const param of decl.params) {
      result = result.replace(new RegExp(`\\b${param.name}\\.`, "g"), `${base}.`);
    }
    if (functions.has(result)) return result;
  }
  return target;
}

function typeMatches(expected: string, actual: string): boolean {
  expected = stripBorrowType(expected);
  actual = stripBorrowType(actual);
  if (isFrozenType(expected) !== isFrozenType(actual)) return false;
  const expectedLiteral = canonicalLiteralType(expected);
  const actualLiteral = canonicalLiteralType(actual);
  if (expectedLiteral || actualLiteral) return runtimeValueTypeAssignable(expected, actual);
  if (expected === actual || isInferredTypeVarName(expected)) return true;
  return runtimeTypePatternMatches(expected, actual, new Map());
}

function fnTypeMatches(expected: string, actual: FnDecl | undefined): boolean {
  if (!actual) return false;
  const expectedSig = parseFnSignature(expected);
  if (!expectedSig || expectedSig.params.length !== actual.params.length) return false;
  const bindings = new Map<string, string>();
  return expectedSig.params.every((param, index) =>
    runtimeTypePatternMatches(param, actual.params[index]?.type, bindings)
  ) && runtimeTypePatternMatches(expectedSig.returnType, actual.returnType, bindings);
}

function runtimeTypePatternMatches(
  expected: string | undefined,
  actual: string | undefined,
  bindings: Map<string, string>,
): boolean {
  if (!expected || !actual) return false;
  expected = stripBorrowType(expected);
  actual = stripBorrowType(actual);
  if (isFrozenType(expected) !== isFrozenType(actual)) return false;
  const expectedLiteral = canonicalLiteralType(expected);
  const actualLiteral = canonicalLiteralType(actual);
  if (expectedLiteral || actualLiteral) return runtimeValueTypeAssignable(expected, actual);
  if (expected === actual) return true;
  if (isInferredTypeVarName(expected)) {
    const bound = bindings.get(expected);
    if (bound) return bound === actual;
    bindings.set(expected, actual);
    return true;
  }
  const expectedCall = expected.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
  const actualCall = actual.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
  if (!expectedCall || !actualCall || expectedCall[1] !== actualCall[1]) return false;
  const expectedArgs = splitTypeArgs(expectedCall[2]);
  const actualArgs = splitTypeArgs(actualCall[2]);
  return expectedArgs.length === actualArgs.length &&
    expectedArgs.every((arg, index) => runtimeTypePatternMatches(arg, actualArgs[index], bindings));
}

function splitTypeArgs(source: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) args.push(tail);
  return args;
}

function inferRuntimeType(
  expr: Expr,
  env: Map<string, string>,
  functions: Map<string, FnDecl>,
  constructorTypes?: Map<string, TypeDecl>,
): string | undefined {
  if (expr.kind === "literal") {
    if (expr.inferredType) return expr.inferredType;
    if (expr.literalKind === "number") return "i32";
    if (expr.literalKind === "bool") return "bool";
    return expr.inferredType;
  }
  if (expr.kind === "var") {
    const localType = stripBorrowType(env.get(expr.name));
    return localType ||
      (functions.has(expr.name) ? renderFnType(functions.get(expr.name)!) : undefined);
  }
  if (expr.kind === "call" && expr.callee.kind === "var") {
    return functions.get(expr.callee.name)?.returnType;
  }
  if (expr.kind === "product_constructor") {
    return inferProductConstructorType(expr, env, functions, constructorTypes);
  }
  if (expr.kind === "range") return "range_i32";
  return undefined;
}

function inferProductConstructorType(
  expr: Extract<Expr, { kind: "product_constructor" }>,
  env: Map<string, string>,
  functions: Map<string, FnDecl>,
  constructorTypes?: Map<string, TypeDecl>,
): string | undefined {
  const decl = constructorTypes?.get(expr.constructor);
  if (!decl) return undefined;
  if (!decl.params.length || decl.normalized?.kind !== "product") return decl.name;
  const bindings = new Map<string, string>();
  for (const slot of expr.slots) {
    if (!slot.label) continue;
    const expected = decl.normalized.shape.slots.find((item) => item.label === slot.label)?.type;
    const actual = inferRuntimeType(slot.value, env, functions, constructorTypes);
    if (expected && actual) runtimeTypePatternMatches(expected, actual, bindings);
  }
  if (!decl.params.every((param) => bindings.has(param.name))) return decl.name;
  return `${decl.name}(${decl.params.map((param) => bindings.get(param.name)!).join(", ")})`;
}

function directCompilerCallId(fn: FnDecl): string | undefined {
  const expr = fn.body.expr;
  if (fn.body.statements.length !== 0 || !expr || expr.kind !== "call") return undefined;
  if (expr.callee.kind !== "var" || !expr.callee.name.startsWith("@")) return undefined;
  const id = expr.callee.name.slice(1);
  return id.startsWith("memory_") || id.startsWith("ptr_") || id === "freeze" ? id : undefined;
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
        pattern: literalPattern("true", "bool"),
        value: {
          kind: "call",
          callee: { kind: "var", name: `${signature.name}__clause_${index}` },
          args: signature.params.map((param) => ({ kind: "var", name: param.name })),
        },
      },
      { pattern: wildcardPattern(), value: fallback },
    ],
  };
}

function wildcardPattern(): ParamPattern {
  return { kind: "wildcard" };
}

function literalPattern(
  value: string,
  literalKind: "number" | "bool" | "string" | "literalType",
): ParamPattern {
  return { kind: "literal", value, literalKind };
}

function renderParamPattern(pattern: ParamPattern): string {
  switch (pattern.kind) {
    case "binding":
      return pattern.name;
    case "wildcard":
      return "_";
    case "literal":
      return pattern.value;
    case "type":
      return pattern.name;
    case "tuple":
      return `[${pattern.items.map(renderParamPattern).join(", ")}]`;
    case "constructor":
      return `${pattern.name}(${pattern.args.map(renderParamPattern).join(",")})`;
  }
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
      if (!fn.memberOf.owner.includes(".") && fn.params.length === 0) {
        diagnostics.push({
          code: "type.unknown_type",
          message: `unknown type ${fn.memberOf.owner}`,
        });
      }
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
      ...(fn.doc ? { doc: fn.doc } : {}),
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
    case "static_for_slots":
      return {
        ...expr,
        value: rewriteAttachedMembersInExpr(expr.value, members),
      };
    case "field":
      return {
        ...expr,
        value: rewriteAttachedMembersInExpr(expr.value, members),
        key: rewriteAttachedMembersInExpr(expr.key, members),
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
    if (decl.value.kind !== "shape") {
      if (!isScalarConstInitializer(decl)) {
        diagnostics.push({
          code: "type.const_shape",
          message: `const ${decl.name} must be initialized with a shape literal`,
        });
      }
      continue;
    }
    if (!decl.type && isTypeReferenceShape(decl.value, typesByName)) {
      checkDuplicateConstShapeLabels(decl.name, decl.value, diagnostics);
      continue;
    }
    if (!decl.type && !isFunctionDictionaryShape(decl.value)) {
      checkDuplicateConstShapeLabels(decl.name, decl.value, diagnostics);
      continue;
    }
    if (!decl.type) {
      diagnostics.push({
        code: "type.const_annotation",
        message: `const ${decl.name} requires an explicit type annotation`,
      });
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

function isFunctionDictionaryShape(value: Extract<Expr, { kind: "shape" }>): boolean {
  return value.slots.every((slot) => slot.value.kind === "var");
}

function isTypeReferenceShape(
  value: Extract<Expr, { kind: "shape" }>,
  typesByName: Map<string, TypeDecl>,
): boolean {
  return value.slots.length > 0 &&
    value.slots.every((slot) => slot.value.kind === "var" && typesByName.has(slot.value.name));
}

function checkDuplicateConstShapeLabels(
  name: string,
  value: Extract<Expr, { kind: "shape" }>,
  diagnostics: Diagnostic[],
) {
  const labels = new Set<string>();
  for (const slot of value.slots) {
    if (!slot.label) continue;
    if (labels.has(slot.label)) {
      diagnostics.push({
        code: "type.duplicate_const_slot",
        message: `const ${name} defines duplicate slot ${slot.label}`,
      });
    }
    labels.add(slot.label);
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
    ? instantiateAnnotation(
      decl.type,
      typesByName,
      functions,
      capabilities,
      new Map(),
      diagnostics,
      decl.span,
    )
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
  & (
    | { kind: "never" }
    | { kind: "bool"; value: boolean }
    | { kind: "number"; value: string }
    | { kind: "string"; value: string }
    | { kind: "literal_type"; value: string }
    | { kind: "type"; name: string; normalized?: TypeBody }
    | { kind: "fn"; name: string }
    | { kind: "shape"; slots: { label?: string; value: ConstValue }[] }
  )
  & { type?: string; span?: Span };

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
    new Map(types.map((decl) => [decl.name, decl])),
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
    const value = evaluator.evalExpr(decl.value, new Map(), [], decl.value.span ?? decl.span);
    if (value) {
      value.type = decl.type;
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
  private diagnosticSpan?: Span;

  constructor(
    private types: Map<string, ConstValue>,
    private typesByName: Map<string, TypeDecl>,
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
    diagnosticSpan?: Span,
  ): ConstValue | undefined {
    if (diagnosticSpan) {
      const previous = this.diagnosticSpan;
      this.diagnosticSpan = diagnosticSpan;
      const value = this.evalExpr(expr, locals, callStack);
      this.diagnosticSpan = previous;
      return value;
    }
    switch (expr.kind) {
      case "literal":
        if (expr.literalKind === "bool") {
          return this.withSpan({ kind: "bool", value: expr.value === "true" }, expr.span);
        }
        if (expr.literalKind === "number") {
          return this.withSpan({ kind: "number", value: expr.value }, expr.span);
        }
        if (expr.literalKind === "literalType") {
          return this.withSpan({ kind: "literal_type", value: expr.value.slice(1) }, expr.span);
        }
        if (expr.literalKind === "string") {
          return this.withSpan({ kind: "string", value: expr.value.slice(1, -1) }, expr.span);
        }
        if (expr.literalKind === "multiline") {
          return this.withSpan({ kind: "string", value: expr.value }, expr.span);
        }
        return this.unsupported(
          "const.unsupported_expr",
          "unsupported literal in const evaluation",
        );
      case "var":
        return this.evalVar(expr.name, locals);
      case "shape":
        return {
          kind: "shape",
          span: expr.span,
          slots: expr.slots.map((slot) => ({
            label: slot.label,
            value: this.withSpan(
              this.evalExpr(slot.value, locals, callStack) ?? { kind: "never" },
              slot.value.span,
            ),
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
      return this.unsupported("const.unsupported_expr", "unsupported const block statement");
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
      this.withSpan(this.evalExpr(arg, locals, callStack) ?? { kind: "never" }, arg.span)
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
        span: expr.span,
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
      this.report("const.compile_error", message, args[0]?.span);
      return { kind: "never" };
    }
    if (name === "@wgsl_shader_id" || name === "wgsl_shader_id") {
      const source = args[0]?.kind === "string" ? args[0].value : undefined;
      if (source === undefined) return undefined;
      this.addShader(source);
      return { kind: "number", value: String(wgslShaderId(source)) };
    }
    const shape = args[0]?.kind === "shape" ? args[0] : undefined;
    if (shape) {
      if (name === "shape_has_slot") {
        const label = literalName(args[1]);
        return { kind: "bool", value: !!shape.slots.find((slot) => slot.label === label) };
      }
      if (name === "shape_slot") {
        const label = literalName(args[1]);
        const slot = shape.slots.find((slot) => slot.label === label);
        if (!slot) {
          this.report(
            "type.unknown_shape_slot",
            `unknown shape slot ${label ?? "<unknown>"}`,
            args[1]?.span ?? args[0]?.span,
          );
          return { kind: "never" };
        }
        return slot.value;
      }
      if (name === "shape_count") return { kind: "number", value: String(shape.slots.length) };
      if (name === "shape_first_key") {
        const first = shape.slots[0];
        if (!first?.label) {
          this.report(
            "type.shape_empty",
            "@shape_first_key requires a non-empty labeled shape",
            args[0]?.span,
          );
          return { kind: "never" };
        }
        return { kind: "literal_type", value: first.label };
      }
      if (name === "shape_tail") {
        if (!shape.slots.length) {
          this.report("type.shape_empty", "@shape_tail requires a non-empty shape", args[0]?.span);
          return { kind: "never" };
        }
        return { kind: "shape", slots: shape.slots.slice(1) };
      }
      if (name === "shape_pick" || name === "shape_intersect") {
        const labels = constSelectorLabels(args[1]);
        if (!labels) return undefined;
        return {
          kind: "shape",
          slots: shape.slots.filter((slot) => slot.label && labels.has(slot.label)),
        };
      }
      if (name === "shape_omit" || name === "shape_difference") {
        const labels = constSelectorLabels(args[1]);
        if (!labels) return undefined;
        return {
          kind: "shape",
          slots: shape.slots.filter((slot) => !slot.label || !labels.has(slot.label)),
        };
      }
      if (name === "shape_rename") {
        const renames = args[1]?.kind === "shape" ? args[1] : undefined;
        if (!renames) return undefined;
        const renameByOld = new Map<string, string>();
        for (const slot of renames.slots) {
          const next = literalName(slot.value);
          if (!slot.label || next === undefined) return undefined;
          renameByOld.set(slot.label, next);
        }
        const slots = shape.slots.map((slot) => ({
          ...slot,
          label: slot.label ? renameByOld.get(slot.label) ?? slot.label : slot.label,
        }));
        const seen = new Set<string>();
        for (const slot of slots) {
          if (!slot.label) continue;
          if (seen.has(slot.label)) {
            this.report(
              "type.shape_rename_duplicate",
              `@shape_rename defines duplicate field ${slot.label}`,
              args[1]?.span ?? args[0]?.span,
            );
            return { kind: "never" };
          }
          seen.add(slot.label);
        }
        return { kind: "shape", slots };
      }
    }
    const type = args[0]?.kind === "type" ? this.resolveType(args[0]) : undefined;
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
        this.report(
          "const.unknown_type_slot",
          `unknown type slot ${literalName(args[1]) ?? "<unknown>"}`,
          args[1]?.span ?? args[0]?.span,
        );
        return { kind: "never" };
      }
      return {
        kind: "type",
        name: slot.type,
        normalized: this.types.get(slot.type)?.kind === "type"
          ? this.resolveType(this.types.get(slot.type) as Extract<ConstValue, { kind: "type" }>)
            ?.normalized
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
    if (name === "type_slots") return constTypeSlots(type);
    if (name === "type_slot_count") {
      return {
        kind: "number",
        value: String(type.normalized?.kind === "product" ? type.normalized.shape.slots.length : 0),
      };
    }
    if (name === "type_variant_slots") {
      return constTypeVariantSlots(type, args[1], this.diagnostics, args[1]?.span ?? args[0]?.span);
    }
    if (name === "type_variants") return constTypeVariants(type);
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
      const equal = this.constValueKey(left) === this.constValueKey(right);
      return { kind: "bool", value: expr.op === "==" ? equal : !equal };
    }
    return this.unsupported("const.unsupported_expr", `operator ${expr.op} is not const-evaluable`);
  }

  private unsupported(code: string, message: string): undefined {
    this.report(code, message);
    return undefined;
  }

  private report(code: string, message: string, span = this.diagnosticSpan) {
    this.diagnostics.push({ code, message, span });
  }

  private withSpan<t extends ConstValue | undefined>(value: t, span?: Span): t {
    if (!value || value.span || !span) return value;
    return { ...value, span } as t;
  }

  private constValueKey(value: ConstValue): string {
    if (value.kind === "shape") {
      return JSON.stringify({
        kind: "shape",
        slots: value.slots.map((slot) => ({
          label: slot.label,
          value: this.constValueKey(slot.value),
        })),
      });
    }
    if (value.kind === "type") {
      const resolved = this.resolveType(value);
      return resolved.normalized
        ? JSON.stringify(this.typeBodyKey(resolved.normalized))
        : resolved.name;
    }
    return constValueKey(value);
  }

  private typeBodyKey(body: TypeBody): unknown {
    switch (body.kind) {
      case "alias": {
        const resolved = this.resolveType({ kind: "type", name: body.type });
        return resolved.normalized ? this.typeBodyKey(resolved.normalized) : resolved.name;
      }
      case "product":
        return {
          kind: "product",
          shape: body.shape.slots.map((slot) => ({
            label: slot.label,
            type: this.constValueKey({ kind: "type", name: slot.type }),
            repeat: slot.repeat,
          })),
        };
      case "sum":
        return {
          kind: "sum",
          variants: body.variants.map((variant) => ({
            name: variant.name,
            shape: variant.shape?.slots.map((slot) => ({
              label: slot.label,
              type: this.constValueKey({ kind: "type", name: slot.type }),
              repeat: slot.repeat,
            })) ?? [],
          })),
        };
      case "operator":
        return { kind: "operator", descriptor: body.descriptor };
    }
  }

  private resolveType(
    type: Extract<ConstValue, { kind: "type" }>,
    seen = new Set<string>(),
  ): Extract<ConstValue, { kind: "type" }> {
    if (seen.has(type.name)) return type;
    seen.add(type.name);
    const evaluator = new TypeEvaluator(
      this.typesByName,
      this.functions,
      this.capabilities,
      this.types,
      this.diagnostics,
      this.addShader,
      this.diagnosticSpan,
    );
    const parsedName = parseAnnotationType(type.name);
    if (parsedName) {
      const evaluated = evaluator.eval(parsedName, new Map());
      if (evaluated?.kind === "type") {
        const resolved = {
          kind: "type" as const,
          name: evaluated.name,
          normalized: evaluated.normalized,
        };
        if (resolved.name !== type.name) return this.resolveType(resolved, seen);
        if (resolved.normalized && !type.normalized) type = resolved;
      }
    }
    const decl = this.typesByName.get(type.name);
    if (decl && decl.params.length === 0 && decl.body.expr) {
      const parsedCall = parseAnnotationType(`${type.name}()`);
      const evaluated = parsedCall ? evaluator.eval(parsedCall, new Map()) : undefined;
      if (evaluated?.kind === "type") {
        const resolved = {
          kind: "type" as const,
          name: evaluated.name,
          normalized: evaluated.normalized,
        };
        if (resolved.name !== type.name) return this.resolveType(resolved, seen);
        if (resolved.normalized && !type.normalized) type = resolved;
      }
    }
    if (type.normalized?.kind === "alias") {
      const parsed = parseAnnotationType(type.normalized.type);
      if (parsed) {
        const evaluated = evaluator.eval(parsed, new Map());
        if (evaluated?.kind === "type") {
          return this.resolveType({
            kind: "type",
            name: evaluated.name,
            normalized: evaluated.normalized,
          }, seen);
        }
      }
    }
    return type;
  }
}

function literalName(value: ConstValue | undefined): string | undefined {
  return value?.kind === "literal_type" || value?.kind === "string" ? value.value : undefined;
}

function constSelectorLabels(value: ConstValue | undefined): Set<string> | undefined {
  if (value?.kind !== "shape") return undefined;
  const labels = new Set<string>();
  for (const slot of value.slots) {
    if (!slot.label) return undefined;
    labels.add(slot.label);
  }
  return labels;
}

function constTypeSlots(type: ConstValue): ConstValue {
  if (type.kind !== "type" || type.normalized?.kind !== "product") {
    return { kind: "shape", slots: [] };
  }
  return {
    kind: "shape",
    slots: type.normalized.shape.slots.map((slot) => ({
      label: slot.label,
      value: { kind: "type", name: slot.type },
    })),
  };
}

function constTypeVariantSlots(
  type: ConstValue,
  variantValue: ConstValue | undefined,
  diagnostics: Diagnostic[],
  span?: Span,
): ConstValue {
  const variantName = literalName(variantValue);
  const variant = type.kind === "type" && type.normalized?.kind === "sum"
    ? type.normalized.variants.find((item) => item.name === variantName)
    : undefined;
  if (!variant) {
    diagnostics.push({
      code: "type.unknown_type_variant",
      message: `unknown type variant ${variantName ?? "<unknown>"}`,
      span,
    });
    return { kind: "never" };
  }
  return {
    kind: "shape",
    slots: variant.shape?.slots.map((slot) => ({
      label: slot.label,
      value: { kind: "type", name: slot.type },
    })) ?? [],
  };
}

function constTypeVariants(type: ConstValue): ConstValue {
  if (type.kind !== "type" || type.normalized?.kind !== "sum") return { kind: "shape", slots: [] };
  return {
    kind: "shape",
    slots: type.normalized.variants.map((variant) => ({
      label: variant.name,
      value: {
        kind: "shape",
        slots: variant.shape?.slots.map((slot) => ({
          label: slot.label,
          value: { kind: "type", name: slot.type },
        })) ?? [],
      },
    })),
  };
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
  return JSON.stringify(serializableConstValue(value));
}

function serializableConstValue(value: ConstValue): ConstValue {
  const { span: _span, ...rest } = value;
  if (rest.kind !== "shape") return rest as ConstValue;
  return {
    ...rest,
    slots: rest.slots.map((slot) => ({
      label: slot.label,
      value: serializableConstValue(slot.value),
    })),
  } as ConstValue;
}

function constValueWithSpan<t extends ConstValue | undefined>(value: t, span?: Span): t {
  if (!value || value.span || !span) return value;
  return { ...value, span } as t;
}

function constPatternMatches(pattern: ParamPattern, value: ConstValue): boolean {
  if (pattern.kind === "wildcard" || pattern.kind === "binding") return true;
  if (pattern.kind !== "literal" && pattern.kind !== "type") return false;
  const text = renderParamPattern(pattern);
  if (value.kind === "bool") return text === (value.value ? "true" : "false");
  if (value.kind === "number") return text === value.value;
  if (value.kind === "string") return text === JSON.stringify(value.value);
  if (value.kind === "literal_type") return text === `#${value.value}`;
  if (value.kind === "type") return text === value.name;
  return false;
}

function renderConstTypeArg(value: ConstValue): string {
  if (value.kind === "type") return value.name;
  if (value.kind === "fn") return value.name;
  if (value.kind === "number") return value.value;
  if (value.kind === "literal_type") return `#${value.value}`;
  if (value.kind === "shape") {
    return `{${
      value.slots.map((slot) => {
        const rendered = renderConstTypeArg(slot.value);
        return slot.label ? `${slot.label}: ${rendered}` : rendered;
      }).join(", ")
    }}`;
  }
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
  if (value.kind === "type") return { kind: "var", name: value.name };
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
  includeGenerated = false,
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
  const queue = program.declarations.filter((decl): decl is FnDecl =>
    decl.kind === "fn" && (includeGenerated || !decl.generated)
  );
  const queued = new Set(queue.map((decl) => decl.name));
  for (let index = 0; index < queue.length; index++) {
    const decl = queue[index]!;
    decl.body = specializeInferredBlock(
      decl.body,
      context,
      new Map(decl.params.map((param) => [param.name, param.type])),
    );
    for (const generated of context.cache.values()) {
      if (!queued.has(generated.name)) {
        queued.add(generated.name);
        queue.push(generated);
      }
    }
  }
  const declared = new Set(program.declarations.map((decl) => "name" in decl ? decl.name : ""));
  const fresh = [...context.cache.values()].filter((decl) => !declared.has(decl.name));
  if (fresh.length) program.declarations.push(...fresh);
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
    diagnosticSpan?: Span;
  },
  env = new Map<string, string>(),
): Extract<Expr, { kind: "block" }> {
  const scoped = new Map(env);
  return {
    ...block,
    statements: block.statements.map((stmt) => {
      if (stmt.kind === "let") {
        const value = specializeInferredExpr(stmt.value, context, scoped);
        const type = stmt.type ?? inferExprType(value, context, scoped);
        if (type) scoped.set(stmt.name, type);
        return { ...stmt, value };
      }
      if (stmt.kind === "destructure_let") {
        const value = specializeInferredExpr(stmt.value, context, scoped);
        const type = inferExprType(value, context, scoped);
        const slotTypes = stmt.slotTypes ?? (type ? stmt.names.map(() => type) : undefined);
        if (slotTypes) {
          stmt.names.forEach((name, index) => {
            const slotType = slotTypes[index] ?? type;
            if (slotType) scoped.set(name, slotType);
          });
        }
        return { ...stmt, value, slotTypes };
      }
      return stmt;
    }),
    expr: block.expr ? specializeInferredExpr(block.expr, context, scoped) : undefined,
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
  env = new Map<string, string>(),
): Expr {
  switch (expr.kind) {
    case "call": {
      const callee = specializeInferredExpr(expr.callee, context, env);
      const args = expr.args.map((arg) => specializeInferredExpr(arg, context, env));
      const fn = callee.kind === "var" ? context.functions.get(callee.name) : undefined;
      if (!fn || !fnUsesInferredTypeVars(fn, context.consts)) return { ...expr, callee, args };
      return specializeInferredCall(fn, args, context, env, callSiteSpan(expr)) ??
        { ...expr, callee, args };
    }
    case "index":
      return {
        ...expr,
        target: specializeInferredExpr(expr.target, context, env),
        index: specializeInferredExpr(expr.index, context, env),
      };
    case "binary":
      return {
        ...expr,
        left: specializeInferredExpr(expr.left, context, env),
        right: specializeInferredExpr(expr.right, context, env),
      };
    case "pipe_bind": {
      const value = specializeInferredExpr(expr.value, context, env);
      const valueType = inferExprType(value, context, env);
      const scoped = valueType && !hasUnresolvedStaticTypeName(valueType, context)
        ? new Map(env).set(expr.name, valueType)
        : env;
      return {
        ...expr,
        value,
        body: specializeInferredExpr(expr.body, context, scoped),
      };
    }
    case "match":
      return {
        ...expr,
        value: specializeInferredExpr(expr.value, context, env),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: specializeInferredExpr(arm.value, context, env),
        })),
      };
    case "shape":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: specializeInferredExpr(slot.value, context, env),
        })),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.map((slot) => ({
          ...slot,
          value: specializeInferredExpr(slot.value, context, env),
        })),
      };
    case "range":
      return {
        ...expr,
        start: specializeInferredExpr(expr.start, context, env),
        end: specializeInferredExpr(expr.end, context, env),
      };
    case "static_for_slots":
      return {
        ...expr,
        value: specializeInferredExpr(expr.value, context, env),
      };
    case "field":
      return {
        ...expr,
        value: specializeInferredExpr(expr.value, context, env),
        key: specializeInferredExpr(expr.key, context, env),
      };
    case "block":
      return specializeInferredBlock(expr, context, env);
    case "literal":
    case "var":
    case "placeholder":
      return expr;
  }
}

function hasUnresolvedStaticTypeName(
  type: string,
  context: { consts?: Map<string, ConstValue>; types?: TypeDecl[] },
): boolean {
  for (const match of type.matchAll(/\b([a-z][A-Za-z0-9_]*)\b/g)) {
    const name = match[1]!;
    const index = match.index ?? 0;
    const next = type.slice(index + name.length).trimStart()[0];
    if (next === "(" || next === ":" || next === "." || isBuiltinTypeName(name)) continue;
    if (context.consts?.has(name)) continue;
    if (context.types?.some((decl) => decl.name === name || terminalName(decl.name) === name)) {
      continue;
    }
    return true;
  }
  return false;
}

function fnUsesInferredTypeVars(fn: FnDecl, consts?: Map<string, ConstValue>): boolean {
  return collectTypeVars(fn, consts).size > 0;
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
    diagnosticSpan?: Span;
  },
  env = new Map<string, string>(),
  diagnosticSpan?: Span,
): Expr | undefined {
  const previousDiagnosticSpan = context.diagnosticSpan;
  if (diagnosticSpan) context.diagnosticSpan = diagnosticSpan;
  try {
    const types = new Map<string, string>();
    const staticArgNames: string[] = [];
    const nonConstParams = fn.params.filter((param) => !param.const);
    const omitConstArgs = false;
    let runtimeArgIndex = 0;
    const argsByParam = fn.params.map((param, index) => {
      if (!omitConstArgs) return args[index];
      if (param.const) return undefined;
      return args[runtimeArgIndex++];
    });
    for (let index = 0; index < fn.params.length; index++) {
      const param = fn.params[index];
      const arg = argsByParam[index];
      if (!param.const || !arg) continue;
      if (exprContainsPlaceholder(arg)) continue;
      const proofArg = renderTypeProofArg(arg);
      if (proofArg) continue;
      if (arg.kind === "var" && (context.consts.has(arg.name) || context.functions.has(arg.name))) {
        continue;
      }
      if (arg.kind === "var") return undefined;
      return undefined;
    }
    fn.params.forEach((param, index) => {
      const arg = argsByParam[index];
      inferFromValuePattern(param.type, arg, types, context, env);
      if (param.const) {
        if (!arg) return;
        const proof = renderTypeProofArg(arg);
        const match = proof?.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
        const expected = param.type.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([a-z][A-Za-z0-9_]*)\)$/);
        if (match && expected && match[1] === expected[1]) {
          types.set(expected[2], match[2].trim());
          staticArgNames.push(proof!);
          return;
        }
        if (arg?.kind === "var") {
          const value = context.consts.get(arg.name);
          if (value?.kind === "fn") {
            inferFnTypeArgs(param.type, context.functions.get(value.name), types, context.consts);
          }
          if (context.functions.has(arg.name)) {
            inferFnTypeArgs(param.type, context.functions.get(arg.name), types, context.consts);
          }
          staticArgNames.push(arg.name);
        }
      }
    });
    fn.params.forEach((param, index) => {
      const arg = argsByParam[index];
      if (param.const && arg?.kind === "var") {
        const value = context.consts.get(arg.name);
        if (value?.kind === "fn") {
          inferFnTypeArgs(
            substituteTypeVars(param.type, types),
            context.functions.get(value.name),
            types,
            context.consts,
          );
        }
        const directFn = context.functions.get(arg.name);
        if (directFn) {
          inferFnTypeArgs(substituteTypeVars(param.type, types), directFn, types, context.consts);
        }
      }
    });
    if (![...collectTypeVars(fn, context.consts)].every((name) => types.has(name))) {
      return undefined;
    }
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
      const inferredBody = substituteInferredExpr(
        cloneExpr(fn.body),
        types,
        staticNames,
        new Map(),
        context,
      ) as Extract<Expr, { kind: "block" }>;
      specialized = {
        ...fn,
        public: false,
        name,
        params: fn.params.filter((param) => !param.const).map((param) => ({
          ...param,
          type: substituteStaticNamesInType(substituteTypeVars(param.type, types), staticNames),
        })),
        returnType: fn.returnType
          ? substituteStaticNamesInType(substituteTypeVars(fn.returnType, types), staticNames)
          : undefined,
        body: inferredBody,
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
      args: omitConstArgs ? args : args.filter((_arg, index) => !fn.params[index]?.const),
    };
  } finally {
    context.diagnosticSpan = previousDiagnosticSpan;
  }
}

function inferFromValuePattern(
  pattern: ParamPattern | string,
  arg: Expr | undefined,
  types: Map<string, string>,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
  },
  env = new Map<string, string>(),
) {
  const rendered = typeof pattern === "string" ? pattern : renderParamPattern(pattern);
  if (!arg) return;
  if (arg.kind === "product_constructor") {
    const decl = context.typeConstructors.get(arg.constructor);
    if (decl) {
      bindTypePattern(
        rendered,
        renderConstructedType(decl, arg, context),
        types,
        context.types ?? [],
      );
    }
    return;
  }
  if (arg.kind === "literal") {
    const literalType = arg.inferredType ?? (arg.literalKind === "number" ? "i32" : undefined);
    bindTypePattern(rendered, literalType, types, context.types ?? [], context.consts);
    return;
  }
  if (arg.kind === "shape") {
    bindTypePattern(
      rendered,
      inferExprType(arg, context, env),
      types,
      context.types ?? [],
      context.consts,
    );
    return;
  }
  if (arg.kind === "var") {
    const directFn = context.functions.get(arg.name);
    if (directFn) inferFnTypeArgs(rendered, directFn, types, context.consts);
    bindTypePattern(
      rendered,
      inferExprType(arg, context, env),
      types,
      context.types ?? [],
      context.consts,
    );
  }
}

function renderConstructedType(
  decl: TypeDecl,
  arg: Extract<Expr, { kind: "product_constructor" }>,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
  },
): string {
  if (!decl.params.length) return decl.name;
  const bindings = new Map<string, string>();
  const slots = decl.normalized?.kind === "product" ? decl.normalized.shape.slots : [];
  for (const slot of arg.slots) {
    if (!slot.label) continue;
    const expected = slots.find((item) => item.label === slot.label)?.type;
    const actual = inferExprType(slot.value, context);
    bindTypePattern(expected, actual, bindings, context.types ?? [], context.consts);
  }
  if (!decl.params.every((param) => bindings.has(param.name))) return decl.name;
  return `${decl.name}(${decl.params.map((param) => bindings.get(param.name)!).join(", ")})`;
}

function inferExprType(
  expr: Expr,
  context: {
    functions: Map<string, FnDecl>;
    consts?: Map<string, ConstValue>;
    typeConstructors: Map<string, TypeDecl>;
    types?: TypeDecl[];
  },
  env = new Map<string, string>(),
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
  if (expr.kind === "shape") {
    const slots = expr.slots.map((slot) => {
      const label = slot.label ? `${slot.label}: ` : "";
      return `${label}${inferExprType(slot.value, context, env) ?? "i32"}`;
    });
    return `struct({${slots.join(", ")}})`;
  }
  if (expr.kind === "call" && expr.callee.kind === "var") {
    return context.functions.get(expr.callee.name)?.returnType;
  }
  if (expr.kind === "pipe_bind") {
    const valueType = inferExprType(expr.value, context, env);
    const scoped = valueType ? new Map(env).set(expr.name, valueType) : env;
    return inferExprType(expr.body, context, scoped);
  }
  if (expr.kind === "var") {
    const projected = inferVarType(expr.name, env, context.types ?? []);
    if (projected) return projected;
    const constType = context.consts?.get(expr.name)?.type;
    if (constType) return constType;
    return context.functions.get(expr.name)
      ? renderFnType(context.functions.get(expr.name)!)
      : undefined;
  }
  return undefined;
}

function inferVarType(
  name: string,
  env: Map<string, string>,
  types: TypeDecl[],
): string | undefined {
  const parts = name.split(".");
  let current = env.get(parts[0]);
  for (const field of parts.slice(1)) {
    current = projectTypeField(current, field, types);
    if (!current) return undefined;
  }
  return current;
}

function projectTypeField(
  type: string | undefined,
  field: string,
  types: TypeDecl[],
): string | undefined {
  if (!type) return undefined;
  const decl = resolveTypeDecl(type, types);
  if (decl?.normalized?.kind !== "product") return undefined;
  const bindings = genericBindings(type, decl);
  const slot = decl.normalized.shape.slots.find((item) => item.label === field);
  return slot ? substituteTypeVars(slot.type, bindings) : undefined;
}

function resolveTypeDecl(type: string, types: TypeDecl[]): TypeDecl | undefined {
  let current = type;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const decl = types.find((item) => item.name === typeNameOf(current));
    if (!decl) return undefined;
    if (decl.normalized?.kind !== "alias") return decl;
    current = substituteTypeVars(decl.normalized.type, genericBindings(current, decl));
  }
  return undefined;
}

function genericBindings(type: string, decl: TypeDecl): Map<string, string> {
  const match = type.match(/^[A-Za-z_][A-Za-z0-9_.]*\((.*)\)$/);
  const args = match ? splitTypeArgs(match[1]) : [];
  return new Map(
    decl.params.map((param, index) => [param.name, args[index]?.trim() ?? param.name]),
  );
}

function collectTypeVars(fn: FnDecl, consts?: Map<string, ConstValue>): Set<string> {
  const vars = new Set<string>();
  const staticParams = new Set(
    fn.params.filter((param) => param.const).map((param) => param.name),
  );
  for (const text of [...fn.params.map((param) => param.type), fn.returnType ?? ""]) {
    collectFreeTypeVars(text, vars, staticParams, consts);
  }
  return vars;
}

function collectFreeTypeVars(
  annotation: string,
  vars: Set<string>,
  staticTypeParams = new Set<string>(),
  consts?: Map<string, ConstValue>,
) {
  const parsed = parseAnnotationType(annotation);
  if (!parsed) return;
  const visit = (expr: TypeExpr, callee = false) => {
    if (expr.kind === "type_ref") {
      if (
        !callee && isInferredTypeVarName(expr.name) && !staticTypeParams.has(expr.name) &&
        !consts?.has(expr.name)
      ) {
        vars.add(expr.name);
      }
      return;
    }
    if (expr.kind === "type_call") {
      visit(expr.callee, true);
      for (const arg of expr.args) visit(arg);
    } else if (expr.kind === "type_shape") {
      for (const slot of expr.shape.slots) visit(slot.type);
    } else if (expr.kind === "type_match") {
      visit(expr.value);
      for (const arm of expr.arms) visit(arm.value);
    } else if (expr.kind === "type_binary") {
      visit(expr.left);
      visit(expr.right);
    } else if (expr.kind === "type_fn") {
      for (const item of parseAnnotationTypeCalls(expr.source)) visit(item);
    }
  };
  visit(parsed);
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
  const literalMembers = literalTypeMembers(type);
  if (literalMembers) {
    const key = value.kind === "bool"
      ? `bool:${value.value ? "true" : "false"}`
      : value.kind === "number"
      ? `number:${value.value}`
      : value.kind === "string"
      ? `string:${value.value}`
      : value.kind === "literal_type"
      ? `literal:${value.value}`
      : undefined;
    return key ? literalMembers.some((member) => literalTypeMemberKey(member) === key) : false;
  }
  if (type === "const") return true;
  if (type === "literal") return true;
  if (value.kind === "bool") return type === "bool";
  if (value.kind === "number") return type === "i32" || type === "numeric" || type === "count";
  if (value.kind === "string") return type === "string" || type === "multiline";
  if (value.kind === "literal_type") return type === "literal";
  if (value.kind === "type") return type === "type";
  if (value.kind === "fn") return type.trim().startsWith("fn(");
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

function inferFnTypeArgs(
  expected: string,
  actual: FnDecl | undefined,
  types: Map<string, string>,
  consts?: Map<string, ConstValue>,
) {
  if (!actual) return;
  const expectedSig = parseFnSignature(expected);
  if (!expectedSig) return;
  expectedSig.params.forEach((type, index) =>
    bindTypePattern(type, actual.params[index]?.type, types, [], consts)
  );
  bindTypePattern(expectedSig.returnType, actual.returnType, types, [], consts);
}

function parseFnSignature(source: string): { params: string[]; returnType: string } | undefined {
  const match = source.match(/^fn\((.*)\)\s*->\s*(.+)$/);
  if (!match) return undefined;
  return {
    params: match[1].trim()
      ? splitTypeArgs(match[1]).map((part) => {
        const colon = part.indexOf(":");
        return (colon >= 0 ? part.slice(colon + 1) : part).trim();
      })
      : [],
    returnType: match[2].trim(),
  };
}

function isInferredTypeVarName(name: string): boolean {
  return /^[a-z][A-Za-z0-9_]*$/.test(name) && !isBuiltinTypeName(name);
}

function bindTypePattern(
  pattern: string | undefined,
  actual: string | undefined,
  types: Map<string, string>,
  typeDecls: TypeDecl[] = [],
  consts?: Map<string, ConstValue>,
) {
  if (!pattern || !actual) return;
  if (isInferredTypeVarName(pattern)) {
    if (isUnresolvedInferredBinding(actual) && !consts?.has(actual.trim())) return;
    types.set(pattern, actual);
    return;
  }
  actual = actual.includes("(") ? actual : resolveAliasType(actual, typeDecls) ?? actual;
  if (pattern === actual) return;
  if (
    pattern.startsWith("&(") && pattern.endsWith(")") && actual.startsWith("&(") &&
    actual.endsWith(")")
  ) {
    bindTypePattern(
      pattern.slice(2, -1).trim(),
      actual.slice(2, -1).trim(),
      types,
      typeDecls,
      consts,
    );
    return;
  }
  const pCall = pattern.match(/^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  const aCall = actual.match(/^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  if (pCall && aCall) {
    if (isInferredTypeVarName(pCall[1])) {
      if (!isUnresolvedInferredBinding(aCall[1]) || consts?.has(aCall[1].trim())) {
        types.set(pCall[1], aCall[1]);
      }
      bindTypePattern(pCall[2].trim(), aCall[2].trim(), types, typeDecls, consts);
      return;
    }
    if (terminalName(pCall[1]) === terminalName(aCall[1])) {
      const patternArgs = splitTypeArgs(pCall[2]);
      const actualArgs = splitTypeArgs(aCall[2]);
      for (let index = 0; index < patternArgs.length; index++) {
        bindTypePattern(
          patternArgs[index]?.trim(),
          actualArgs[index]?.trim(),
          types,
          typeDecls,
          consts,
        );
      }
    }
    return;
  }
}

function isUnresolvedInferredBinding(actual: string): boolean {
  return isInferredTypeVarName(actual.trim());
}

function substituteTypeVars(source: string, types: Map<string, string>): string {
  let result = source;
  for (const [name, type] of types) {
    result = result.replace(new RegExp(`\\b${name}\\b`, "g"), type);
  }
  return result;
}

function substituteStaticNamesInType(source: string, staticNames: Map<string, string>): string {
  let result = source;
  for (const [name, value] of staticNames) {
    result = result.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }
  return result;
}

function substituteTypeVarsInTypeExpr(
  expr: TypeExpr,
  types: Map<string, string>,
  staticNames = new Map<string, string>(),
): TypeExpr {
  switch (expr.kind) {
    case "type_ref":
      if (types.has(expr.name)) return parseAnnotationType(types.get(expr.name)!) ?? expr;
      if (staticNames.has(expr.name)) {
        return parseAnnotationType(staticNames.get(expr.name)!) ?? expr;
      }
      return expr;
    case "type_call":
      return {
        ...expr,
        callee: substituteTypeVarsInTypeExpr(expr.callee, types, staticNames),
        args: expr.args.map((arg) => substituteTypeVarsInTypeExpr(arg, types, staticNames)),
      };
    case "type_match":
      return {
        ...expr,
        value: substituteTypeVarsInTypeExpr(expr.value, types, staticNames),
        arms: expr.arms.map((arm) => ({
          ...arm,
          value: substituteTypeVarsInTypeExpr(arm.value, types, staticNames),
        })),
      };
    case "type_binary":
      return {
        ...expr,
        left: substituteTypeVarsInTypeExpr(expr.left, types, staticNames),
        right: substituteTypeVarsInTypeExpr(expr.right, types, staticNames),
      };
    case "type_operator":
      return expr;
    case "type_shape":
      return {
        ...expr,
        shape: {
          ...expr.shape,
          slots: expr.shape.slots.map((slot) => ({
            ...slot,
            type: substituteTypeVarsInTypeExpr(slot.type, types, staticNames),
          })),
        },
      };
    case "type_fn":
      return {
        ...expr,
        source: substituteStaticNamesInType(substituteTypeVars(expr.source, types), staticNames),
      };
    case "type_static_ref":
    case "type_bool":
    case "type_number":
    case "type_char":
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
    consts?: Map<string, ConstValue>;
    diagnostics: Diagnostic[];
    types: TypeDecl[];
    diagnosticSpan?: Span;
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
      const staticName = staticNames.get(base);
      if (staticName) {
        const staticValue = context?.consts?.get(staticName);
        if (staticValue?.kind === "shape") {
          const slot = staticValue.slots.find((item) => item.label === member);
          if (slot?.value.kind === "fn") return { kind: "var", name: slot.value.name };
        }
        return { kind: "var", name: `${staticName}.${member}` };
      }
    }
    const type = types.get(expr.name);
    if (type) return { kind: "var", name: type };
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
  if (expr.kind === "static_for_slots") {
    return {
      ...expr,
      source: substituteInferredStaticForSource(
        expr.source,
        types,
        staticNames,
        proofTypes,
        context,
      ),
      value: substituteInferredExpr(expr.value, types, staticNames, proofTypes, context),
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
        context.consts ?? new Map(),
        context.diagnostics,
        shaderManifestEntry,
        context.diagnosticSpan,
      )
      : undefined;
    return {
      ...expr,
      statements: expr.statements.flatMap((stmt) => {
        if (stmt.kind === "proof_const") {
          const value = typeEvaluator?.eval(
            substituteTypeVarsInTypeExpr(stmt.value, types, staticNames),
            typeEvalLocals,
          );
          if (!value || value.kind === "never") {
            context?.diagnostics.push({
              code: "type.proof_const",
              message: `proof const ${stmt.name} could not be evaluated`,
              span: context.diagnosticSpan,
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
              type: stmt.type
                ? substituteStaticNamesInType(substituteTypeVars(stmt.type, types), staticNames)
                : stmt.type,
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

function substituteInferredStaticForSource(
  source: StaticForSource,
  types: Map<string, string>,
  staticNames: Map<string, string>,
  proofTypes: Map<string, TypeEvalValue>,
  context: Parameters<typeof substituteInferredExpr>[4],
): StaticForSource {
  if (source.kind === "shape") {
    return {
      ...source,
      shape: substituteInferredExpr(source.shape, types, staticNames, proofTypes, context),
    };
  }
  return {
    ...source,
    start: substituteInferredExpr(source.start, types, staticNames, proofTypes, context),
    end: substituteInferredExpr(source.end, types, staticNames, proofTypes, context),
  };
}

function specializeConstParamCalls(
  program: Program,
  functions: Map<string, FnDecl>,
  consts: Map<string, ConstValue>,
  types: TypeDecl[],
  addShader: (source: string) => ShaderManifestEntry,
  diagnostics: Diagnostic[],
  emitDiagnostics = true,
) {
  const context: ConstSpecializationContext = {
    functions,
    consts,
    types,
    diagnostics,
    emitDiagnostics,
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
  let processedGenerated = 0;
  while (processedGenerated < context.cache.size) {
    const generated = [...context.cache.values()].slice(processedGenerated);
    processedGenerated = context.cache.size;
    for (const decl of generated) {
      if (!decl.params.some((param) => param.const)) specializeBlock(decl.body, context);
    }
  }
  if (context.cache.size > 0) program.declarations.push(...context.cache.values());
}

function specializeBlock(
  block: Extract<Expr, { kind: "block" }>,
  context: ConstSpecializationContext,
) {
  block.statements = block.statements.flatMap((stmt): Statement[] => {
    if (stmt.kind === "let") {
      stmt.value = specializeExpr(stmt.value, context);
    } else if (stmt.kind === "destructure_let") {
      stmt.value = specializeExpr(stmt.value, context);
    }
    return [stmt];
  });
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
      return specializeConstParamCall(direct, args, context, callSiteSpan(expr)) ??
        { ...expr, callee, args };
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
        slots: expr.slots.flatMap((slot) =>
          expandSpecializedShapeSlot(
            slot,
            new Map(),
            context.consts,
            new Map(),
            context,
          ).map((expanded) => ({ ...expanded, value: specializeExpr(expanded.value, context) }))
        ),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.flatMap((slot) =>
          expandSpecializedShapeSlot(
            slot,
            new Map(),
            context.consts,
            new Map(),
            context,
          ).map((expanded) => ({ ...expanded, value: specializeExpr(expanded.value, context) }))
        ),
      };
    case "range":
      return {
        ...expr,
        start: specializeExpr(expr.start, context),
        end: specializeExpr(expr.end, context),
      };
    case "static_for_slots":
      return expr;
    case "field":
      return {
        ...expr,
        value: specializeExpr(expr.value, context),
        key: specializeExpr(expr.key, context),
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
  types: TypeDecl[];
  diagnostics: Diagnostic[];
  emitDiagnostics: boolean;
  addShader: (source: string) => ShaderManifestEntry;
  cache: Map<string, FnDecl>;
  usedNames: Set<string>;
  diagnosticSpan?: Span;
}

function specializeConstParamCall(
  fn: FnDecl,
  args: Expr[],
  context: ConstSpecializationContext,
  diagnosticSpan?: Span,
  outerStaticValues = new Map<string, ConstValue>(),
): Expr | undefined {
  const previousDiagnosticSpan = context.diagnosticSpan;
  if (diagnosticSpan) context.diagnosticSpan = diagnosticSpan;
  try {
    const staticValues = new Map<string, ConstValue>();
    const staticArgNames = new Map<string, string>();
    const inferredTypes = new Map<string, string>();
    const constArgNames: string[] = [];
    const runtimeArgs: Expr[] = [];
    for (let index = 0; index < fn.params.length; index++) {
      const param = fn.params[index];
      const arg = args[index] ?? { kind: "var" as const, name: "<missing>" };
      if (param.const) {
        const expectedType = param.inferStaticType
          ? undefined
          : substituteConstParamType(param.type, staticValues, staticArgNames);
        const staticArg = staticConstArgValue(arg, expectedType, context, outerStaticValues);
        if (!staticArg) {
          if (context.emitDiagnostics) {
            context.diagnostics.push({
              code: "const.static_param_arg",
              message:
                `const parameter ${param.name} on ${fn.name} requires a top-level const argument or matching type proof`,
              span: arg.span ?? context.diagnosticSpan,
            });
          }
          return undefined;
        }
        staticValues.set(param.name, staticArg.value);
        const expectedForInference = substituteConstParamType(
          param.type,
          staticValues,
          staticArgNames,
        );
        if (staticArg.value.kind === "fn") {
          inferFnTypeArgs(
            expectedForInference,
            context.functions.get(staticArg.value.name),
            inferredTypes,
            context.consts,
          );
        } else if (arg.kind === "var" && context.functions.has(arg.name)) {
          inferFnTypeArgs(
            expectedForInference,
            context.functions.get(arg.name),
            inferredTypes,
            context.consts,
          );
        }
        if (!context.consts.has(staticArg.name)) {
          staticValues.set(staticArg.name, staticArg.value);
        }
        staticArgNames.set(param.name, staticArg.name);
        constArgNames.push(staticArg.name);
      } else {
        runtimeArgs.push(arg);
      }
    }
    const key = `${fn.name}\0${constArgNames.join("\0")}\0${
      [...inferredTypes].map(([name, type]) => `${name}=${type}`).join("\0")
    }`;
    let specialized = context.cache.get(key);
    if (!specialized) {
      const specializedName = allocateSpecializationName(fn.name, constArgNames, context.usedNames);
      specialized = {
        kind: "fn",
        public: false,
        name: specializedName,
        params: fn.params.filter((param) => !param.const).map((param) => ({
          ...param,
          type: substituteTypeVars(
            substituteConstParamType(param.type, staticValues, staticArgNames),
            inferredTypes,
          ),
        })),
        returnType: fn.returnType
          ? substituteTypeVars(
            substituteConstParamType(fn.returnType, staticValues, staticArgNames),
            inferredTypes,
          )
          : undefined,
        effects: [...fn.effects],
        body: substituteInferredExpr(
          cloneExpr(fn.body),
          inferredTypes,
          new Map(),
          new Map(),
          context,
        ) as Extract<Expr, { kind: "block" }>,
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
  } finally {
    context.diagnosticSpan = previousDiagnosticSpan;
  }
}

function isInlineableGeneratedSpecializationSource(fn: FnDecl): boolean {
  const owner = fn.memberOf?.owner;
  return owner === "iter" || owner === "compact_iter" || owner === "query" ||
    owner?.endsWith(".query") === true;
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
    case "static_for_slots":
      return exprCallsFunction(expr.value, name) ||
        exprCallsFunction(
          expr.source.kind === "range" ? expr.source.start : expr.source.shape,
          name,
        ) ||
        (expr.source.kind === "range" && exprCallsFunction(expr.source.end, name));
    case "field":
      return exprCallsFunction(expr.value, name) || exprCallsFunction(expr.key, name);
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
  expectedType: string | undefined,
  context: ConstSpecializationContext,
  staticValues = new Map<string, ConstValue>(),
): { name: string; value: ConstValue } | undefined {
  const helper = expectedType ? synthesizePlaceholderHelper(arg, expectedType, context) : undefined;
  if (helper) return helper;
  if (arg.kind === "var") {
    const staticValue = staticValues.get(arg.name) ?? constValueFromKeyName(arg.name);
    if (staticValue && !expectedType) {
      return { name: renderConstTypeArg(staticValue), value: staticValue };
    }
    if (staticValue?.kind === "fn" && expectedType === "type") {
      return { name: renderConstTypeArg(staticValue), value: staticValue };
    }
    if (staticValue && expectedType && constValueMatchesExpectedType(staticValue, expectedType)) {
      return { name: renderConstTypeArg(staticValue), value: staticValue };
    }
  }
  if (
    arg.kind === "binary" ||
    (arg.kind === "call" && arg.callee.kind === "var" && isStaticBuiltinName(arg.callee.name))
  ) {
    const evaluatedStaticValue = staticConstExprValue(arg, staticValues, context);
    if (evaluatedStaticValue && !expectedType) {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
    if (evaluatedStaticValue?.kind === "fn" && expectedType === "type") {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
    if (
      evaluatedStaticValue && expectedType &&
      (constValueMatchesExpectedType(evaluatedStaticValue, expectedType) ||
        (expectedType === "type" && evaluatedStaticValue.kind === "shape"))
    ) {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
  }
  if (arg.kind === "shape") {
    const evaluatedStaticValue = staticConstExprValue(arg, staticValues, context);
    if (evaluatedStaticValue && !expectedType) {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
    if (
      evaluatedStaticValue && expectedType &&
      (constValueMatchesExpectedType(evaluatedStaticValue, expectedType) ||
        (expectedType === "type" && evaluatedStaticValue.kind === "shape"))
    ) {
      return { name: renderConstTypeArg(evaluatedStaticValue), value: evaluatedStaticValue };
    }
  }
  if (arg.kind === "call" && arg.callee.kind === "var" && isStaticBuiltinName(arg.callee.name)) {
    return undefined;
  }
  const proof = renderTypeProofArg(arg);
  if (proof && !expectedType) {
    if (isInferredTypeVarName(proof) && !staticValues.has(proof) && !context.consts.has(proof)) {
      return undefined;
    }
    return { name: proof, value: { kind: "type", name: proof } };
  }
  if (
    proof && expectedType &&
    (typeProofMatchesExpected(proof, expectedType) ||
      (expectedType === "type" && isKnownTypeProof(proof, context.types)))
  ) {
    if (isInferredTypeVarName(proof) && !staticValues.has(proof) && !context.consts.has(proof)) {
      return undefined;
    }
    return { name: proof, value: { kind: "type", name: proof } };
  }
  if (
    proof && expectedType === "type" && arg.kind === "call" && arg.callee.kind === "var" &&
    isStaticBuiltinName(arg.callee.name)
  ) {
    return { name: proof, value: { kind: "type", name: proof } };
  }
  if (arg.kind === "var") {
    const value = context.consts.get(arg.name);
    if (value && !expectedType) {
      return { name: arg.name, value };
    }
    if (value && expectedType && constValueMatchesExpectedType(value, expectedType)) {
      return { name: arg.name, value };
    }
    if (!expectedType && /^[A-Z]/.test(arg.name)) {
      return { name: arg.name, value: { kind: "type", name: arg.name } };
    }
    if (!expectedType && context.functions.has(arg.name)) {
      return { name: arg.name, value: { kind: "fn", name: arg.name } };
    }
    if (expectedType === "type" && /^[A-Z]/.test(arg.name)) {
      return { name: arg.name, value: { kind: "type", name: arg.name } };
    }
    if (expectedType === "type" && context.functions.has(arg.name)) {
      return { name: arg.name, value: { kind: "fn", name: arg.name } };
    }
    if (expectedType?.trim().startsWith("fn(") && context.functions.has(arg.name)) {
      return { name: arg.name, value: { kind: "fn", name: arg.name } };
    }
  }
  if (arg.kind === "literal") {
    const value = literalConstValue(arg);
    if (value && (!expectedType || literalValueMatchesType(value, expectedType))) {
      return { name: literalConstName(value), value };
    }
  }
  return undefined;
}

function constValueMatchesExpectedType(value: ConstValue, expectedType: string): boolean {
  if (expectedType === "type" && value.kind === "type") return true;
  if (expectedType === "const" && value.kind === "shape") return true;
  return literalValueMatchesType(value, expectedType) || value.type === expectedType;
}

function typeProofMatchesExpected(proof: string, expectedType: string): boolean {
  if (proof === expectedType) return true;
  const proofCall = proof.match(/^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  const expectedCall = expectedType.match(/^([A-Za-z_][A-Za-z0-9_.]*)\((.*)\)$/);
  if (!proofCall || !expectedCall) return terminalName(proof) === terminalName(expectedType);
  if (terminalName(proofCall[1]) !== terminalName(expectedCall[1])) return false;
  const proofArgs = splitTypeArgs(proofCall[2]);
  const expectedArgs = splitTypeArgs(expectedCall[2]);
  return proofArgs.length === expectedArgs.length &&
    proofArgs.every((arg, index) =>
      typeProofMatchesExpected(arg.trim(), expectedArgs[index]!.trim())
    );
}

function constValueFromKeyName(name: string): ConstValue | undefined {
  const shape = constShapeValueFromTypeArg(name);
  if (shape) return shape;
  if (!name.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(name);
    return isConstValue(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function constShapeValueFromTypeArg(source: string): ConstValue | undefined {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return { kind: "shape", slots: [] };
  return {
    kind: "shape",
    slots: splitTypeArgs(inner).map((part) => {
      const colon = topLevelTypeColon(part);
      if (colon < 0) return { value: constValueFromRenderedTypeArg(part.trim()) };
      return {
        label: part.slice(0, colon).trim(),
        value: constValueFromRenderedTypeArg(part.slice(colon + 1).trim()),
      };
    }),
  };
}

function constValueFromRenderedTypeArg(source: string): ConstValue {
  const nestedShape = constShapeValueFromTypeArg(source);
  if (nestedShape) return nestedShape;
  if (source === "true" || source === "false") return { kind: "bool", value: source === "true" };
  if (/^-?[0-9]+$/.test(source)) return { kind: "number", value: source };
  if (source.startsWith("#")) return { kind: "literal_type", value: source.slice(1) };
  return { kind: "type", name: source };
}

function isConstValue(value: unknown): value is ConstValue {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (
    kind === "bool" || kind === "number" || kind === "string" || kind === "literal_type" ||
    kind === "type" || kind === "fn" || kind === "never"
  ) {
    return true;
  }
  if (kind !== "shape") return false;
  const slots = (value as { slots?: unknown }).slots;
  return Array.isArray(slots) &&
    slots.every((slot) =>
      !!slot && typeof slot === "object" &&
      (!("label" in slot) || typeof (slot as { label?: unknown }).label === "string") &&
      isConstValue((slot as { value?: unknown }).value)
    );
}

function isKnownTypeProof(proof: string, types: TypeDecl[]): boolean {
  const name = proof.replace(/\(.*\)$/, "");
  return [
    "i32",
    "u32",
    "i64",
    "u64",
    "f32",
    "f64",
    "bool",
    "string",
  ].includes(name) || types.some((type) => type.name === name || type.name === terminalName(name));
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
      span: exprDiagnosticSpan(arg) ?? context.diagnosticSpan,
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
      span: exprDiagnosticSpan(arg) ?? context.diagnosticSpan,
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
    case "static_for_slots":
      return {
        ...expr,
        source: replaceStaticForSourcePlaceholder(expr.source, replacement),
        value: replacePlaceholder(expr.value, replacement),
      };
    case "field":
      return {
        ...expr,
        value: replacePlaceholder(expr.value, replacement),
        key: replacePlaceholder(expr.key, replacement),
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

function replaceStaticForSourcePlaceholder(
  source: Extract<Expr, { kind: "static_for_slots" }>["source"],
  replacement: Expr,
): Extract<Expr, { kind: "static_for_slots" }>["source"] {
  return source.kind === "range"
    ? {
      kind: "range",
      start: replacePlaceholder(source.start, replacement),
      end: replacePlaceholder(source.end, replacement),
    }
    : { kind: "shape", shape: replacePlaceholder(source.shape, replacement) };
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
    case "static_for_slots":
      return [
        ...(expr.source.kind === "range"
          ? [expr.source.start, expr.source.end]
          : [expr.source.shape]),
        expr.value,
      ];
    case "field":
      return [expr.value, expr.key];
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

function substituteConstParamType(
  source: string,
  values: Map<string, ConstValue>,
  names: Map<string, string> = new Map(),
): string {
  let result = source;
  for (const [name, value] of values) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    if (value.kind === "type") {
      result = result.replace(pattern, value.name);
    } else if (value.kind === "number") {
      result = result.replace(pattern, value.value);
    } else if (names.has(name)) {
      result = result.replace(pattern, names.get(name) ?? name);
    }
  }
  return result;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function isInlineArrayExprBuiltin(name: string): boolean {
  return [
    "@inline_array_tabulate",
    "@inline_array_tabulate_with",
    "@inline_array_imap",
    "@inline_array_map",
    "@inline_array_imap_with_state",
    "@inline_array_fill",
    "@inline_array_set",
    "@inline_array_update",
  ].includes(name);
}

function expandInlineArrayExprBuiltin(
  name: string,
  args: Expr[],
  staticValues: Map<string, ConstValue>,
  context: ConstSpecializationContext,
): Expr | undefined {
  const iterator = "i";
  const n = args[0];
  if (!n) return undefined;
  const source: StaticForSource = {
    kind: "range",
    start: { kind: "literal", literalKind: "number", value: "0" },
    end: n,
  };
  const index: Expr = { kind: "var", name: iterator };
  const call = (callee: Expr | undefined, callArgs: Expr[]): Expr =>
    callee
      ? { kind: "call", callee, args: callArgs }
      : { kind: "literal", literalKind: "number", value: "0" };
  const indexed = (target: Expr | undefined): Expr =>
    target
      ? { kind: "index", target, index: cloneExpr(index) }
      : { kind: "literal", literalKind: "number", value: "0" };
  let value: Expr | undefined;
  switch (name) {
    case "@inline_array_tabulate":
      value = call(args[2], [cloneExpr(index)]);
      break;
    case "@inline_array_tabulate_with":
      value = call(args[4], [cloneExpr(index), args[3] ?? cloneExpr(index)]);
      break;
    case "@inline_array_imap": {
      const x = indexed(args[3]);
      value = call(args[4], [cloneExpr(index), x]);
      break;
    }
    case "@inline_array_map": {
      const x = indexed(args[3]);
      value = call(args[4], [x]);
      break;
    }
    case "@inline_array_imap_with_state": {
      const x = indexed(args[4]);
      value = call(args[6], [cloneExpr(index), x, args[5] ?? cloneExpr(index)]);
      break;
    }
    case "@inline_array_fill":
      value = args[2];
      break;
    case "@inline_array_set":
      value = {
        kind: "match",
        value: {
          kind: "binary",
          op: "==",
          left: cloneExpr(index),
          right: args[3] ?? cloneExpr(index),
        },
        arms: [
          { pattern: literalPattern("true", "bool"), value: args[4] ?? cloneExpr(index) },
          { pattern: literalPattern("false", "bool"), value: indexed(args[2]) },
        ],
      };
      break;
    case "@inline_array_update":
      value = {
        kind: "match",
        value: {
          kind: "binary",
          op: "==",
          left: cloneExpr(index),
          right: args[3] ?? cloneExpr(index),
        },
        arms: [
          { pattern: literalPattern("true", "bool"), value: call(args[4], [indexed(args[2])]) },
          { pattern: literalPattern("false", "bool"), value: indexed(args[2]) },
        ],
      };
      break;
  }
  if (!value) return undefined;
  const slot = {
    value: {
      kind: "static_for_slots" as const,
      iterator,
      source,
      labeled: false,
      value,
    },
  };
  return {
    kind: "shape",
    slots: expandSpecializedShapeSlot(slot, new Map(), staticValues, new Map(), context),
  };
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
      const staticArgName = staticArgNames.get(expr.name);
      if (
        staticArgName &&
        (staticValue?.kind === "shape" || staticValue?.kind === "type" ||
          staticValue?.kind === "fn")
      ) {
        return { kind: "var", name: staticArgName };
      }
      if (
        staticValue && (staticValue.kind === "bool" || staticValue.kind === "number" ||
          staticValue.kind === "string" || staticValue.kind === "literal_type" ||
          staticValue.kind === "type" || staticValue.kind === "fn")
      ) {
        return constValueToExpr(staticValue) ?? expr;
      }
      if (staticArgName) return { kind: "var", name: staticArgName };
      if (staticValue?.kind === "shape") return constValueToExpr(staticValue) ?? expr;
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
      if (expr.callee.kind === "var" && expr.callee.name.startsWith("@shape_")) {
        const staticValue = staticConstExprValue(
          expr,
          staticValues,
          context.emitDiagnostics ? context : { ...context, diagnostics: [] },
        );
        const staticExpr = staticValue ? constValueToExpr(staticValue) : undefined;
        if (staticExpr) return staticExpr;
      }
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
      if (callee.kind === "var" && callee.name === "@empty") {
        const emptyType = renderTypeProofArg(args[0]);
        const emptyExpr = emptyType ? emptyExprForType(emptyType, context) : undefined;
        if (emptyExpr) return emptyExpr;
        if (context.emitDiagnostics) {
          context.diagnostics.push({
            code: "type.unknown_type_member",
            message: `type ${emptyType ?? "<unknown>"} does not have an empty value`,
            span: args[0]?.span ?? context.diagnosticSpan,
          });
        }
        return { ...expr, callee, args };
      }
      const direct = callee.kind === "var" ? context.functions.get(callee.name) : undefined;
      if (direct?.params.some((param) => param.const)) {
        return specializeConstParamCall(direct, args, context, callSiteSpan(expr), staticValues) ??
          { ...expr, callee, args };
      }
      if (!direct && callee.kind === "var" && args.length === 0) {
        const emptyType = emptyMemberOwner(callee.name);
        const emptyExpr = emptyType ? emptyExprForType(emptyType, context) : undefined;
        if (emptyExpr) return emptyExpr;
        if (emptyType) {
          if (context.emitDiagnostics) {
            context.diagnostics.push({
              code: "type.unknown_type_member",
              message: `type ${emptyType} does not have an empty value`,
              span: context.diagnosticSpan,
            });
          }
        }
      }
      if (callee.kind === "var" && callee.name === "@wgsl_shader_id") {
        const source = stringLiteralValue(args[0]);
        if (source !== undefined) {
          context.addShader(source);
          return { kind: "literal", literalKind: "number", value: String(wgslShaderId(source)) };
        }
      }
      if (callee.kind === "var" && callee.name.startsWith("@shape_")) {
        const staticValue = staticConstExprValue(
          { ...expr, callee, args },
          staticValues,
          context.emitDiagnostics ? context : { ...context, diagnostics: [] },
        );
        const staticExpr = staticValue ? constValueToExpr(staticValue) : undefined;
        if (staticExpr) return staticExpr;
      }
      if (callee.kind === "var" && isInlineArrayExprBuiltin(callee.name)) {
        return expandInlineArrayExprBuiltin(callee.name, args, staticValues, context) ??
          { ...expr, callee, args };
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
    case "match": {
      const value = substituteSpecializedExpr(
        expr.value,
        values,
        staticValues,
        staticArgNames,
        context,
      );
      const staticValue = staticConstExprValue(value, staticValues, context);
      if (staticValue) {
        const selected = expr.arms.find((arm) => constPatternMatches(arm.pattern, staticValue));
        if (selected) {
          return substituteSpecializedExpr(
            selected.value,
            values,
            staticValues,
            staticArgNames,
            context,
          );
        }
      }
      return {
        ...expr,
        value,
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
    }
    case "shape":
      return {
        ...expr,
        slots: expr.slots.flatMap((slot) =>
          expandSpecializedShapeSlot(slot, values, staticValues, staticArgNames, context)
        ),
      };
    case "product_constructor":
      return {
        ...expr,
        slots: expr.slots.flatMap((slot) =>
          expandSpecializedShapeSlot(slot, values, staticValues, staticArgNames, context)
        ),
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
    case "static_for_slots":
      return expr;
    case "field": {
      const value = substituteSpecializedExpr(
        expr.value,
        values,
        staticValues,
        staticArgNames,
        context,
      );
      const key = substituteSpecializedExpr(
        expr.key,
        values,
        staticValues,
        staticArgNames,
        context,
      );
      const label = staticLabelName(key, staticValues);
      if (value.kind === "var" && label) return { kind: "var", name: `${value.name}.${label}` };
      return { ...expr, value, key };
    }
    case "block": {
      const scopedValues = new Map(values);
      const scopedStaticValues = new Map(staticValues);
      const scopedStaticArgNames = new Map(staticArgNames);
      const statements: Statement[] = expr.statements.flatMap((stmt): Statement[] => {
        if (stmt.kind === "proof_const") return [];
        for (const name of boundNames(stmt)) {
          scopedValues.delete(name);
          scopedStaticValues.delete(name);
          scopedStaticArgNames.delete(name);
        }
        const value = substituteSpecializedExpr(
          stmt.value,
          scopedValues,
          scopedStaticValues,
          scopedStaticArgNames,
          context,
        );
        if (stmt.kind === "let") {
          return [{
            ...stmt,
            type: stmt.type
              ? substituteConstParamType(stmt.type, scopedStaticValues, scopedStaticArgNames)
              : stmt.type,
            value,
          }];
        }
        return [{ ...stmt, value }];
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

function cloneExpr<t extends Expr>(expr: t): t {
  return clonePlainExpr(expr);
}

function clonePlainExpr<t>(value: t, seen = new WeakMap<object, unknown>()): t {
  if (!value || typeof value !== "object") return value;
  const found = seen.get(value as object);
  if (found) return found as t;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(clonePlainExpr(item, seen));
    return out as t;
  }
  const out: Record<string, unknown> = {};
  seen.set(value as object, out);
  for (const [key, child] of Object.entries(value)) out[key] = clonePlainExpr(child, seen);
  return out as t;
}

function expandSpecializedShapeSlot(
  slot: { label?: string; value: Expr },
  values: Map<string, Expr>,
  staticValues: Map<string, ConstValue>,
  staticArgNames: Map<string, string>,
  context: ConstSpecializationContext,
): { label?: string; value: Expr }[] {
  const generator = slot.value;
  if (generator.kind !== "static_for_slots") {
    return [{
      ...slot,
      value: substituteSpecializedExpr(slot.value, values, staticValues, staticArgNames, context),
    }];
  }
  const source = staticForItems(generator.source, values, staticValues, staticArgNames, context);
  if (!source) {
    return [{
      ...slot,
      value: {
        ...generator,
        source: substituteSpecializedStaticForSource(
          generator.source,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
        value: substituteSpecializedExpr(
          generator.value,
          values,
          staticValues,
          staticArgNames,
          context,
        ),
      },
    }];
  }
  return source.map((item) => {
    const scopedValues = new Map(values);
    const scopedStaticValues = new Map(staticValues);
    const scopedStaticArgNames = new Map(staticArgNames);
    scopedStaticValues.set(generator.iterator, item.key);
    scopedStaticArgNames.set(generator.iterator, renderConstTypeArg(item.key));
    if (generator.valueIterator) {
      scopedStaticValues.set(generator.valueIterator, item.value);
      scopedStaticArgNames.set(generator.valueIterator, renderConstTypeArg(item.value));
    }
    const value = substituteSpecializedExpr(
      generator.value,
      scopedValues,
      scopedStaticValues,
      scopedStaticArgNames,
      context,
    );
    return { label: generator.labeled ? literalName(item.key) : undefined, value };
  });
}

function substituteSpecializedStaticForSource(
  source: StaticForSource,
  values: Map<string, Expr>,
  staticValues: Map<string, ConstValue>,
  staticArgNames: Map<string, string>,
  context: ConstSpecializationContext,
): StaticForSource {
  if (source.kind === "shape") {
    return {
      ...source,
      shape: substituteSpecializedExpr(source.shape, values, staticValues, staticArgNames, context),
    };
  }
  return {
    ...source,
    start: substituteSpecializedExpr(source.start, values, staticValues, staticArgNames, context),
    end: substituteSpecializedExpr(source.end, values, staticValues, staticArgNames, context),
  };
}

function staticForItems(
  source: Extract<Expr, { kind: "static_for_slots" }>["source"],
  values: Map<string, Expr>,
  staticValues: Map<string, ConstValue>,
  staticArgNames: Map<string, string>,
  context: ConstSpecializationContext,
): { key: ConstValue; value: ConstValue }[] | undefined {
  if (source.kind === "range") {
    const startExpr = substituteSpecializedExpr(
      source.start,
      values,
      staticValues,
      staticArgNames,
      context,
    );
    const endExpr = substituteSpecializedExpr(
      source.end,
      values,
      staticValues,
      staticArgNames,
      context,
    );
    const start = staticNumber(startExpr, staticValues);
    const end = staticNumber(endExpr, staticValues);
    if (start === undefined || end === undefined) return undefined;
    return Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
      const value = { kind: "number" as const, value: String(start + offset) };
      return { key: value, value };
    });
  }
  const shapeExpr = substituteSpecializedExpr(
    source.shape,
    values,
    staticValues,
    staticArgNames,
    context,
  );
  const shape = shapeExpr.kind === "var"
    ? staticValues.get(shapeExpr.name)
    : staticConstExprValue(shapeExpr, staticValues, context);
  if (shape?.kind !== "shape") return undefined;
  return shape.slots.map((slot) => ({
    key: { kind: "literal_type", value: slot.label ?? "" },
    value: slot.value,
  }));
}

function staticNumber(expr: Expr, staticValues: Map<string, ConstValue>): number | undefined {
  if (expr.kind === "literal" && expr.literalKind === "number") {
    return Number.parseInt(expr.value, 10);
  }
  if (expr.kind === "var") {
    const value = staticValues.get(expr.name);
    if (value?.kind === "number") return Number.parseInt(value.value, 10);
  }
  if (expr.kind === "binary") {
    const left = staticNumber(expr.left, staticValues);
    const right = staticNumber(expr.right, staticValues);
    if (left === undefined || right === undefined) return undefined;
    if (expr.op === "+") return left + right;
    if (expr.op === "-") return left - right;
  }
  return undefined;
}

function staticLabelName(expr: Expr, staticValues: Map<string, ConstValue>): string | undefined {
  if (expr.kind === "literal" && expr.literalKind === "literalType") {
    return expr.value.replace(/^#/, "");
  }
  if (expr.kind === "literal" && expr.literalKind === "string") return expr.value.slice(1, -1);
  if (expr.kind === "var") return literalName(staticValues.get(expr.name));
  return literalName(staticConstExprValue(expr, staticValues));
}

function staticConstExprValue(
  expr: Expr | undefined,
  staticValues: Map<string, ConstValue>,
  context?: {
    consts?: Map<string, ConstValue>;
    functions?: Map<string, FnDecl>;
    diagnostics?: Diagnostic[];
    diagnosticSpan?: Span;
    types?: TypeDecl[];
  },
): ConstValue | undefined {
  if (!expr) return undefined;
  if (expr.kind === "literal") return constValueWithSpan(literalConstValue(expr), expr.span);
  if (expr.kind === "var") {
    if (expr.name.startsWith("struct(")) {
      return constValueWithSpan({ kind: "type", name: expr.name }, expr.span);
    }
    return constValueWithSpan(
      staticValues.get(expr.name) ?? context?.consts?.get(expr.name) ??
        constValueFromKeyName(expr.name) ??
        resolveStaticTypeName(expr.name, context?.types) ??
        (context?.functions?.has(expr.name) ? { kind: "fn", name: expr.name } : undefined),
      expr.span,
    );
  }
  if (expr.kind === "binary") {
    const left = staticConstExprValue(expr.left, staticValues, context);
    const right = staticConstExprValue(expr.right, staticValues, context);
    if (!left || !right) return undefined;
    if (expr.op === "==" || expr.op === "!=") {
      const equal = constValueKey(left) === constValueKey(right);
      return constValueWithSpan(
        { kind: "bool", value: expr.op === "==" ? equal : !equal },
        expr.span,
      );
    }
    if (left.kind === "number" && right.kind === "number") {
      const l = Number.parseInt(left.value, 10);
      const r = Number.parseInt(right.value, 10);
      if (expr.op === "+") {
        return constValueWithSpan({ kind: "number", value: String(l + r) }, expr.span);
      }
      if (expr.op === "-") {
        return constValueWithSpan({ kind: "number", value: String(l - r) }, expr.span);
      }
    }
    return undefined;
  }
  if (expr.kind === "shape") {
    return {
      kind: "shape",
      span: expr.span,
      slots: expr.slots.map((slot) => ({
        label: slot.label,
        value: constValueWithSpan(
          staticConstExprValue(slot.value, staticValues, context) ?? { kind: "never" },
          slot.value.span,
        ),
      })),
    };
  }
  if (expr.kind !== "call" || expr.callee.kind !== "var") return undefined;
  const name = expr.callee.name.replace(/^@/, "");
  const args = expr.args.map((arg) =>
    constValueWithSpan(staticConstExprValue(arg, staticValues, context), arg.span)
  );
  const shape = args[0]?.kind === "shape" ? args[0] : undefined;
  if (name === "type_slots") {
    const rawType = resolveStaticConstType(args[0], context?.types);
    const rawInlineStructSlots = rawType?.kind === "type"
      ? inlineStructTypeSlots(rawType.name)
      : undefined;
    if (rawInlineStructSlots) return rawInlineStructSlots;
    const type = resolveStaticTypeConst(rawType, context);
    const sparseSlots = staticSparseWorldTypeSlots(type, context);
    if (sparseSlots) return sparseSlots;
    const inlineStructSlots = type?.kind === "type" ? inlineStructTypeSlots(type.name) : undefined;
    if (inlineStructSlots) return inlineStructSlots;
    return type?.kind === "type" && type.normalized?.kind === "product"
      ? constTypeSlots(type)
      : undefined;
  }
  if (name === "type_slot_count") {
    const type = resolveStaticConstType(args[0], context?.types);
    return {
      kind: "number",
      value: String(
        type?.kind === "type" && type.normalized?.kind === "product"
          ? type.normalized.shape.slots.length
          : 0,
      ),
    };
  }
  if (name === "type_slot_type") {
    const type = resolveStaticTypeConst(resolveStaticConstType(args[0], context?.types), context);
    const label = literalName(args[1]);
    const slot = type?.kind === "type" && type.normalized?.kind === "product"
      ? type.normalized.shape.slots.find((slot) => slot.label === label)
      : undefined;
    return slot ? { kind: "type", name: slot.type } : undefined;
  }
  if (!shape) return undefined;
  if (name === "shape_slot") {
    const label = literalName(args[1]);
    const slot = shape.slots.find((slot) => slot.label === label);
    if (!slot) {
      context?.diagnostics?.push({
        code: "type.unknown_shape_slot",
        message: `unknown shape slot ${label ?? "<unknown>"}`,
        span: args[1]?.span ?? args[0]?.span ?? context.diagnosticSpan,
      });
      return { kind: "never" };
    }
    return slot.value;
  }
  if (name === "shape_has_slot") {
    const label = literalName(args[1]);
    return { kind: "bool", value: !!shape.slots.find((slot) => slot.label === label) };
  }
  if (name === "shape_count") return { kind: "number", value: String(shape.slots.length) };
  if (name === "shape_first_key") {
    const first = shape.slots[0];
    if (!first?.label) {
      context?.diagnostics?.push({
        code: "type.shape_empty",
        message: "@shape_first_key requires a non-empty labeled shape",
        span: args[0]?.span ?? context.diagnosticSpan,
      });
      return { kind: "never" };
    }
    return { kind: "literal_type", value: first.label };
  }
  if (name === "shape_tail") {
    if (!shape.slots.length) {
      context?.diagnostics?.push({
        code: "type.shape_empty",
        message: "@shape_tail requires a non-empty shape",
        span: args[0]?.span ?? context.diagnosticSpan,
      });
      return { kind: "never" };
    }
    return { kind: "shape", slots: shape.slots.slice(1) };
  }
  return undefined;
}

function inlineStructTypeSlots(type: string): ConstValue | undefined {
  const args = type.trim().startsWith("struct(") && type.trim().endsWith(")")
    ? type.trim().slice("struct(".length, -1)
    : undefined;
  if (!args) return undefined;
  const trimmed = args.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return { kind: "shape", slots: [] };
  return {
    kind: "shape",
    slots: splitTypeArgs(inner).map((part) => {
      const colon = topLevelTypeColon(part);
      if (colon < 0) return { value: { kind: "type", name: part.trim() } };
      return {
        label: part.slice(0, colon).trim(),
        value: { kind: "type", name: part.slice(colon + 1).trim() },
      };
    }),
  };
}

function topLevelTypeColon(source: string): number {
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const ch = source[index];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === ":" && depth === 0) return index;
  }
  return -1;
}

function resolveStaticConstType(
  value: ConstValue | undefined,
  types: TypeDecl[] | undefined,
): ConstValue | undefined {
  if (value?.kind !== "type") return undefined;
  if (value.normalized) return value;
  return resolveStaticTypeName(value.name, types) ?? value;
}

function resolveStaticTypeName(
  name: string,
  types: TypeDecl[] | undefined,
): ConstValue | undefined {
  const found = types?.find((type) => type.name === name || type.name === terminalName(name));
  return found ? { kind: "type", name, normalized: found.normalized } : undefined;
}

function resolveStaticTypeConst(
  value: ConstValue | undefined,
  context: Parameters<typeof staticConstExprValue>[2],
): ConstValue | undefined {
  if (value?.kind !== "type" || !context?.types) return value;
  const evaluator = new TypeEvaluator(
    new Map(context.types.map((decl) => [decl.name, decl])),
    context.functions ?? new Map(),
    new Map(),
    context.consts ?? new Map(),
    context.diagnostics ?? [],
    shaderManifestEntry,
    context.diagnosticSpan,
  );
  const resolved = evaluator.resolve({
    kind: "type",
    name: value.name,
    normalized: value.normalized,
  });
  return resolved.kind === "type"
    ? { kind: "type", name: resolved.name, normalized: resolved.normalized }
    : value;
}

function staticSparseWorldTypeSlots(
  type: ConstValue | undefined,
  context: Parameters<typeof staticConstExprValue>[2],
): ConstValue | undefined {
  if (type?.kind !== "type") return undefined;
  const sparseType = type.normalized?.kind === "alias" ? type.normalized.type : type.name;
  const match = sparseType.match(/(?:^|\.)SparseWorld\((.*)\)$/);
  if (!match) return undefined;
  const args = splitTypeArgs(match[1]);
  const componentsName = args[1]?.trim();
  const componentsValue = componentsName ? context?.consts?.get(componentsName) : undefined;
  const components = componentsValue?.kind === "shape" ? componentsValue : undefined;
  if (components?.kind !== "shape") return undefined;
  return {
    kind: "shape",
    slots: [
      { label: "next_entity_id", value: { kind: "type", name: "i32" } },
      { label: "defaults", value: { kind: "type", name: `ComponentValues(${componentsName})` } },
      ...components.slots.map((slot) => ({
        label: slot.label,
        value: {
          kind: "type" as const,
          name: `ComponentSlot(${args[0]?.trim() ?? "3"}, ${renderConstTypeArg(slot.value)})`,
        },
      })),
    ],
  };
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
  const typeNames = new Set(types.map((decl) => decl.name));
  for (const decl of types) {
    if (!startsUppercase(terminalName(decl.name))) {
      diagnostics.push(diagnosticAt(
        "type.type_fn_casing",
        `type function ${decl.name} must start uppercase; use ${upperFirst(pascalCase(decl.name))}`,
        decl,
      ));
    }
    for (const param of decl.params) {
      if (param.name.startsWith("__type_pattern_")) continue;
      if (!startsLowercase(param.name)) {
        diagnostics.push(diagnosticAt(
          "type.type_param_casing",
          `type parameter ${param.name} must start lowercase; use ${lowerFirst(param.name)}`,
          param,
        ));
      }
    }
  }
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      for (const param of decl.params) {
        checkTypeAnnotationCasing(param.type, typeNames, diagnostics, param.span);
      }
      if (decl.returnType) {
        checkTypeAnnotationCasing(decl.returnType, typeNames, diagnostics, decl.span);
      }
      checkBlockTypeAnnotationCasing(decl.body, typeNames, diagnostics);
    } else if ((decl.kind === "let" || decl.kind === "const") && decl.type) {
      checkTypeAnnotationCasing(decl.type, typeNames, diagnostics, decl.span);
    }
  }
}

function checkBlockTypeAnnotationCasing(
  block: Extract<Expr, { kind: "block" }>,
  typeNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  for (const stmt of block.statements) {
    if (stmt.kind === "let" && stmt.type) {
      checkTypeAnnotationCasing(stmt.type, typeNames, diagnostics, stmt.span);
    }
    if (stmt.kind === "let") {
      checkExprTypeAnnotationCasing(stmt.value, typeNames, diagnostics);
    }
  }
  if (block.expr) checkExprTypeAnnotationCasing(block.expr, typeNames, diagnostics);
}

function checkExprTypeAnnotationCasing(
  expr: Expr,
  typeNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  if (expr.kind === "block") {
    checkBlockTypeAnnotationCasing(expr, typeNames, diagnostics);
  } else if (expr.kind === "match") {
    checkExprTypeAnnotationCasing(expr.value, typeNames, diagnostics);
    for (const arm of expr.arms) {
      checkExprTypeAnnotationCasing(arm.value, typeNames, diagnostics);
    }
  }
}

function checkTypeExprCasing(
  expr: TypeExpr | undefined,
  typeNames: Set<string>,
  diagnostics: Diagnostic[],
) {
  if (!expr) return;
  if (expr.kind === "type_ref") {
    diagnoseTypeRefCasing(expr.name, false, typeNames, diagnostics, expr.span);
  } else if (expr.kind === "type_call") {
    if (expr.callee.kind === "type_ref") {
      diagnoseTypeRefCasing(expr.callee.name, true, typeNames, diagnostics, expr.callee.span);
    } else {
      checkTypeExprCasing(expr.callee, typeNames, diagnostics);
    }
    for (const arg of expr.args) checkTypeExprCasing(arg, typeNames, diagnostics);
  } else if (expr.kind === "type_shape") {
    for (const slot of expr.shape.slots) {
      checkTypeExprCasing(slot.type, typeNames, diagnostics);
    }
  } else if (expr.kind === "type_match") {
    checkTypeExprCasing(expr.value, typeNames, diagnostics);
    for (const arm of expr.arms) {
      checkTypeExprCasing(arm.value, typeNames, diagnostics);
    }
  } else if (expr.kind === "type_binary") {
    checkTypeExprCasing(expr.left, typeNames, diagnostics);
    checkTypeExprCasing(expr.right, typeNames, diagnostics);
  }
}

function checkTypeAnnotationCasing(
  annotation: string,
  typeNames: Set<string>,
  diagnostics: Diagnostic[],
  span?: Span,
) {
  for (const name of annotation.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (/^u[0-9]+$/.test(name) && !isUnsignedIntegerType(name)) {
      diagnostics.push({
        code: "type.unknown_type",
        message: `unknown unsigned integer type ${name}; use u1 through u64`,
        span,
      });
    }
  }
  const parsed = parseAnnotationType(annotation);
  checkTypeExprCasing(parsed, typeNames, diagnostics);
}

function diagnoseTypeRefCasing(
  name: string,
  callee: boolean,
  typeNames: Set<string>,
  diagnostics: Diagnostic[],
  span?: Span,
) {
  if (name === "String") {
    diagnostics.push({
      code: "type.builtin_type_casing",
      message: "builtin type String is lowercase; use string",
      span,
    });
    return;
  }
  if (name === "memory") {
    diagnostics.push({
      code: "type.unknown_type",
      message: "unknown type memory",
      span,
    });
    return;
  }
  if (typeNames.has(name) || isBuiltinTypeName(name)) return;
  if (callee && isInferredTypeVarName(name) && name.length > 1) {
    diagnostics.push({
      code: "type.lowercase_type_constructor",
      message: `lowercase type variable ${name} cannot be called as a type constructor`,
      span,
    });
  }
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
    const calleeDecl = calleeName ? lookupTypeDecl(byName, calleeName) : undefined;
    if (calleeName && decl.params.some((param) => param.name === calleeName)) {
      const constructorKind = `type fn(${
        expr.args.map((_arg, index) => `_${index}: type`).join(", ")
      }) -> type`;
      markKind(decl, kinds, calleeName, constructorKind, diagnostics);
    }
    expr.args.forEach((arg, index) => {
      const calleeKind = staticBuiltinParamKind(staticBuiltinName, index) ??
        calleeDecl?.paramKinds?.[calleeDecl.params[index]?.name] ??
        calleeDecl?.params[index]?.kind ??
        "type";
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
  if (expr.kind === "type_operator") return;
  if (expr.kind === "type_binary") {
    inferKinds(expr.left, decl, kinds, locals, byName, diagnostics, expected);
    inferKinds(expr.right, decl, kinds, locals, byName, diagnostics, expected);
  }
}

function lookupTypeDecl(byName: Map<string, TypeDecl>, name: string): TypeDecl | undefined {
  return byName.get(name) ?? byName.get(terminalName(name)) ??
    Array.from(byName.values()).find((decl) => terminalName(decl.name) === terminalName(name));
}

function staticBuiltinParamKind(
  name: string | undefined,
  index: number,
): TypeParamKind | undefined {
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
  if (name && shapeFirstArg.has(name) && index === 0) return "const";
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
      name === "type_variants") && index === 0
  ) return "type";
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
  if (left === "const" || right === "const") return true;
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
  if (left === "const" || right === "const") return "const";
  if (left === "type" && isTypeConstructorKind(right)) return right;
  return left;
}

function isTypeConstructorKind(kind: TypeParamKind): boolean {
  return /^type\s+fn\s*\(/.test(kind);
}

function typeConstructorKindArity(kind: TypeParamKind): number | undefined {
  const match = kind.match(/^type\s+fn\s*\((.*)\)\s*->\s*(type|struct|union|operator)$/);
  if (!match) return undefined;
  const params = match[1].trim();
  return params ? params.split(",").length : 0;
}

function typeConstructorResultKind(kind: TypeParamKind): TypeResultKind | undefined {
  const match = kind.match(/^type\s+fn\s*\(.*\)\s*->\s*(type|struct|union|operator)$/);
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
  if (decl.resultKind === "operator" && normalized.kind === "operator") return;
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
  const typeLetDocs = new Map(decl.body.statements.map((stmt) => [stmt.name, stmt.doc]));
  if (resolved.kind === "type_operator") {
    return { kind: "operator", descriptor: resolved.descriptor };
  }
  const builder = typeBuilderCall(resolved);
  if (builder?.name === "struct") {
    const arg = builder.args[0];
    const shapeExpr = arg?.kind === "type_ref" ? locals.get(arg.name) : undefined;
    if (
      builder.args.length === 1 && arg?.kind === "type_ref" && shapeExpr &&
      shapeExpr.kind !== "type_shape"
    ) {
      return { kind: "alias", type: renderTypeExpr(resolved) };
    }
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
        ...(typeLetDocs.get(variant.name) ? { doc: typeLetDocs.get(variant.name) } : {}),
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

function isBuiltinTypeName(name: string): boolean {
  return [
    "bool",
    "char",
    "const",
    "count",
    "f32",
    "f64",
    "fn",
    "i32",
    "i64",
    "literal",
    "numeric",
    "operator",
    "string",
    "type",
    "u32",
    "u64",
  ].includes(name) || isUnsignedIntegerType(name);
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
      ...(slot.doc ? { doc: slot.doc } : {}),
      label: slot.label,
      type: renderTypeExpr(slot.type),
      ...(slot.repeat ? { repeat: renderCountExpr(slot.repeat) } : {}),
    })),
  };
}

function normalizeMembers(members: TypeShape["members"] | undefined) {
  return members?.length
    ? members.map((member) => ({
      ...(member.doc ? { doc: member.doc } : {}),
      name: member.name,
      type: member.type,
      target: member.target,
    }))
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
    case "type_operator":
      return `operator(${expr.descriptor.fixity}, ${expr.descriptor.precedence}, "${expr.descriptor.symbol}", ${expr.descriptor.target})`;
    case "type_binary":
      return `${renderTypeExpr(expr.left)} ${expr.op} ${renderTypeExpr(expr.right)}`;
    case "type_bool":
      return expr.value ? "true" : "false";
    case "type_number":
      return expr.value;
    case "type_char":
      return `'${expr.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "type_string":
      return JSON.stringify(expr.value);
    case "type_literal":
      return `#${expr.value}`;
  }
}

type LiteralTypeMember = {
  kind: "number" | "bool" | "string" | "char" | "literal";
  value: string;
};

function canonicalLiteralType(type: string | undefined): string | undefined {
  const expr = type ? parseAnnotationType(type) : undefined;
  if (!expr) return undefined;
  const members = literalTypeMembersFromExpr(expr);
  return members ? renderLiteralUnionType(members) : undefined;
}

function literalTypeMembers(type: string | undefined): LiteralTypeMember[] | undefined {
  const expr = type ? parseAnnotationType(type) : undefined;
  return expr ? literalTypeMembersFromExpr(expr) : undefined;
}

function literalTypeMembersFromExpr(expr: TypeExpr): LiteralTypeMember[] | undefined {
  if (expr.kind === "type_binary" && expr.op === "|") {
    const left = literalTypeMembersFromExpr(expr.left);
    const right = literalTypeMembersFromExpr(expr.right);
    return left && right ? canonicalLiteralMembers([...left, ...right]) : undefined;
  }
  const member = literalTypeMemberFromExpr(expr);
  return member ? [member] : undefined;
}

function literalTypeMemberFromExpr(expr: TypeExpr): LiteralTypeMember | undefined {
  if (expr.kind === "type_number") return { kind: "number", value: expr.value };
  if (expr.kind === "type_bool") return { kind: "bool", value: expr.value ? "true" : "false" };
  if (expr.kind === "type_string") return { kind: "string", value: expr.value };
  if (expr.kind === "type_char") return { kind: "char", value: expr.value };
  if (expr.kind === "type_literal") return { kind: "literal", value: expr.value };
  return undefined;
}

function literalTypeMembersFromEval(value: TypeEvalValue): LiteralTypeMember[] | undefined {
  if (value.kind === "number") return [{ kind: "number", value: value.value }];
  if (value.kind === "bool") return [{ kind: "bool", value: value.value ? "true" : "false" }];
  if (value.kind === "string") return [{ kind: "string", value: value.value }];
  if (value.kind === "char") return [{ kind: "char", value: value.value }];
  if (value.kind === "literal") return [{ kind: "literal", value: value.value }];
  if (value.kind === "type") return literalTypeMembers(value.name);
  return undefined;
}

function canonicalLiteralMembers(members: LiteralTypeMember[]): LiteralTypeMember[] {
  const byKey = new Map<string, LiteralTypeMember>();
  for (const member of members) byKey.set(literalTypeMemberKey(member), member);
  return [...byKey.values()].toSorted((left, right) =>
    literalTypeMemberKey(left).localeCompare(literalTypeMemberKey(right))
  );
}

function renderLiteralUnionType(members: LiteralTypeMember[]): string {
  return canonicalLiteralMembers(members).map(renderLiteralTypeMember).join(" | ");
}

function renderLiteralTypeMember(member: LiteralTypeMember): string {
  if (member.kind === "string") return JSON.stringify(member.value);
  if (member.kind === "char") {
    return `'${member.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (member.kind === "literal") return `#${member.value}`;
  return member.value;
}

function literalTypeMemberKey(member: LiteralTypeMember): string {
  return `${member.kind}:${member.value}`;
}

function literalExprMember(expr: Expr): LiteralTypeMember | undefined {
  if (expr.kind !== "literal") return undefined;
  if (expr.literalKind === "number") return { kind: "number", value: expr.value };
  if (expr.literalKind === "bool") return { kind: "bool", value: expr.value };
  if (expr.literalKind === "string") return { kind: "string", value: expr.value.slice(1, -1) };
  if (expr.literalKind === "char") {
    return { kind: "char", value: JSON.parse(`"${expr.value.slice(1, -1)}"`) };
  }
  if (expr.literalKind === "literalType") return { kind: "literal", value: expr.value.slice(1) };
  return undefined;
}

function literalExprFitsType(expr: Expr, expectedType: string | undefined): boolean {
  const member = literalExprMember(expr);
  const members = literalTypeMembers(expectedType);
  if (!member || !members) return false;
  const key = literalTypeMemberKey(member);
  return members.some((item) => literalTypeMemberKey(item) === key);
}

function literalTypeCarrier(type: string | undefined): string | undefined {
  const members = literalTypeMembers(type);
  if (!members) return undefined;
  if (members.every((member) => member.kind === "bool")) return "bool";
  return "i32";
}

function runtimeValueTypeAssignable(
  expected: string | undefined,
  actual: string | undefined,
): boolean {
  if (!expected || !actual) return true;
  const expectedLiteral = canonicalLiteralType(expected);
  const actualLiteral = canonicalLiteralType(actual);
  if (expectedLiteral) return actualLiteral === expectedLiteral;
  if (actualLiteral && literalTypeCarrier(actualLiteral) === expected.trim()) return true;
  return true;
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
    case "char":
      return `'${pattern.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "number":
      return pattern.value;
    case "type":
      return pattern.name;
  }
}

function renderShape(shape: TypeShape): string {
  return `{${
    shape.slots.map((slot) =>
      `${renderShapeSlotKey(slot)}${slot.repeat ? `${renderCountExpr(slot.repeat)} * ` : ""}${
        renderTypeExpr(slot.type)
      }`
    ).join(", ")
  }}`;
}

function renderShapeItems(shape: TypeShape): string {
  return [
    ...shape.slots.map((slot) =>
      `${renderShapeSlotKey(slot)}${slot.repeat ? `${renderCountExpr(slot.repeat)} * ` : ""}${
        renderTypeExpr(slot.type)
      }`
    ),
    ...(shape.members ?? []).map((member) =>
      `const ${member.name}: ${member.type} = ${member.target}`
    ),
  ].join(", ");
}

function renderShapeSlotKey(slot: { label?: string; position?: number }): string {
  if (slot.label && slot.position !== undefined) return `${slot.label}[${slot.position}]: `;
  if (slot.label) return `${slot.label}: `;
  if (slot.position !== undefined) return `[${slot.position}]: `;
  return "";
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

function parseTypeCount(source: string): TypeCountExpr {
  const trimmed = source.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    return { kind: "count_literal", value: Number.parseInt(trimmed, 10), source: trimmed };
  }
  return { kind: "count_ref", name: trimmed };
}

function renderTypeEvalCountExpr(expr: TypeCountExpr, locals: Map<string, TypeEvalValue>): string {
  switch (expr.kind) {
    case "count_literal":
      return expr.source;
    case "count_ref": {
      const value = locals.get(expr.name);
      return value?.kind === "number" ? value.value : expr.name;
    }
    case "count_mul":
      return `${renderTypeEvalCountExpr(expr.left, locals)} * ${
        renderTypeEvalCountExpr(expr.right, locals)
      }`;
  }
}

type TypeEvalValue =
  & (
    | { kind: "never" }
    | { kind: "bool"; value: boolean }
    | { kind: "number"; value: string }
    | { kind: "char"; value: string }
    | { kind: "string"; value: string }
    | { kind: "literal"; value: string }
    | { kind: "static_builtin"; name: string }
    | { kind: "shape"; slots: { label?: string; value: TypeEvalValue; repeat?: string }[] }
    | { kind: "type"; name: string; normalized?: TypeBody }
  )
  & { span?: Span };

function checkTypeContracts(
  program: Program,
  types: TypeDecl[],
  functions: FnDecl[],
  capabilities: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
) {
  const byName = new Map(types.map((decl) => [decl.name, decl]));
  const byFn = new Map(functions.map((decl) => [decl.name, decl]));
  for (const decl of program.declarations) {
    if (decl.kind === "const" || decl.kind === "let") {
      if (decl.type) {
        instantiateNestedAnnotations(
          decl.type,
          byName,
          byFn,
          capabilities,
          consts,
          diagnostics,
          decl.span,
        );
      }
    } else if (decl.kind === "fn") {
      const constTypeParams = new Set<string>();
      for (const param of decl.params) {
        if (
          !annotationReferencesAny(param.type, constTypeParams) &&
          !annotationHasInferredVars(param.type)
        ) {
          instantiateNestedAnnotations(
            param.type,
            byName,
            byFn,
            capabilities,
            consts,
            diagnostics,
            param.span ?? decl.span,
          );
        }
        if (param.const && (param.type === "type" || param.inferStaticType)) {
          constTypeParams.add(param.name);
        }
      }
      if (
        decl.returnType && !annotationReferencesAny(decl.returnType, constTypeParams) &&
        !annotationHasInferredVars(decl.returnType)
      ) {
        instantiateNestedAnnotations(
          decl.returnType,
          byName,
          byFn,
          capabilities,
          consts,
          diagnostics,
          decl.span,
        );
      }
      checkBlockTypeContracts(
        decl.body,
        byName,
        byFn,
        capabilities,
        consts,
        diagnostics,
        constTypeParams,
      );
    }
  }
}

function checkBlockTypeContracts(
  block: Extract<Expr, { kind: "block" }>,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  deferredTypeParams = new Set<string>(),
) {
  for (const stmt of block.statements) {
    if (
      stmt.kind === "let" && stmt.type &&
      !annotationReferencesAny(stmt.type, deferredTypeParams)
    ) {
      instantiateNestedAnnotations(
        stmt.type,
        typesByName,
        functions,
        capabilities,
        consts,
        diagnostics,
        stmt.span,
      );
    }
    if (stmt.kind === "let") {
      checkExprTypeContracts(stmt.value, typesByName, functions, capabilities, consts, diagnostics);
    }
  }
  if (block.expr) {
    checkExprTypeContracts(block.expr, typesByName, functions, capabilities, consts, diagnostics);
  }
}

function checkExprTypeContracts(
  expr: Expr,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
) {
  if (expr.kind === "block") {
    checkBlockTypeContracts(expr, typesByName, functions, capabilities, consts, diagnostics);
  } else if (expr.kind === "match") {
    checkExprTypeContracts(expr.value, typesByName, functions, capabilities, consts, diagnostics);
    for (const arm of expr.arms) {
      checkExprTypeContracts(arm.value, typesByName, functions, capabilities, consts, diagnostics);
    }
  } else if (expr.kind === "product_constructor" || expr.kind === "shape") {
    for (const slot of expr.slots) {
      checkExprTypeContracts(slot.value, typesByName, functions, capabilities, consts, diagnostics);
    }
  }
}

function lowerProductConstructors(
  program: Program,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  const products = new Map<string, TypeBody & { kind: "product" }>();
  const productsByTerminal = new Map<string, Array<TypeBody & { kind: "product" }>>();
  for (const type of types) {
    if (type.normalized?.kind === "product") {
      products.set(type.normalized.constructor, type.normalized);
      const terminal = terminalName(type.normalized.constructor);
      const existing = productsByTerminal.get(terminal) ?? [];
      existing.push(type.normalized);
      productsByTerminal.set(terminal, existing);
    }
  }
  const lowerExpr = (expr: Expr): Expr => {
    switch (expr.kind) {
      case "product_constructor": {
        const product = resolveProductConstructor(expr.constructor, products, productsByTerminal);
        if (!product) {
          diagnostics.push(diagnosticAt(
            "type.unknown_constructor",
            `unknown product constructor ${expr.constructor}`,
            expr,
          ));
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
      case "static_for_slots":
        return {
          ...expr,
          source: lowerStaticForSourceExpr(expr.source, lowerExpr),
          value: lowerExpr(expr.value),
        };
      case "range":
        return { ...expr, start: lowerExpr(expr.start), end: lowerExpr(expr.end) };
      case "static_for_slots":
        return { ...expr, value: lowerExpr(expr.value) };
      case "field":
        return { ...expr, value: lowerExpr(expr.value), key: lowerExpr(expr.key) };
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

function resolveProductConstructor(
  name: string,
  products: Map<string, TypeBody & { kind: "product" }>,
  productsByTerminal: Map<string, Array<TypeBody & { kind: "product" }>>,
): TypeBody & { kind: "product" } | undefined {
  const exact = products.get(name);
  if (exact) return exact;
  if (name.includes(".")) return undefined;
  const matches = productsByTerminal.get(name) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function terminalName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function lowerStaticForSourceExpr(
  source: StaticForSource,
  lowerExpr: (expr: Expr) => Expr,
): StaticForSource {
  return source.kind === "range"
    ? { ...source, start: lowerExpr(source.start), end: lowerExpr(source.end) }
    : { ...source, shape: lowerExpr(source.shape) };
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
    if (slot.value.kind === "static_for_slots") continue;
    if (slot.spread) {
      diagnostics.push(diagnosticAt(
        "collection.spread_product",
        "spread entries are only valid in unlabeled collection literals",
        slot,
      ));
    }
    if (!slot.label) continue;
    if (actual.has(slot.label)) {
      diagnostics.push(diagnosticAt(
        "type.duplicate_constructor_slot",
        `${expr.constructor} defines duplicate slot ${slot.label}`,
        slot,
      ));
    }
    actual.add(slot.label);
  }
  if (!expr.slots.some((slot) => slot.value.kind === "static_for_slots")) {
    for (const label of expected) {
      if (!actual.has(label)) {
        diagnostics.push(diagnosticAt(
          "type.constructor_missing_slot",
          `${expr.constructor} is missing field ${label}`,
          expr,
        ));
      }
    }
  }
  for (const label of actual) {
    if (!expected.has(label)) {
      const slot = expr.slots.find((item) => item.label === label);
      diagnostics.push(diagnosticAt(
        "type.constructor_unknown_slot",
        `${expr.constructor} has no field ${label}`,
        slot ?? expr,
      ));
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
  const vars = new Set<string>();
  collectFreeTypeVars(annotation, vars);
  return vars.size > 0;
}

function instantiateNestedAnnotations(
  annotation: string,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  diagnosticSpan?: Span,
) {
  for (const typeExpr of parseAnnotationTypeCalls(annotation)) {
    instantiateTypeExpr(
      typeExpr,
      typesByName,
      functions,
      capabilities,
      consts,
      diagnostics,
      new Map(),
      diagnosticSpan,
    );
  }
}

function instantiateAnnotation(
  annotation: string,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  diagnosticSpan?: Span,
): TypeBody | undefined {
  const expr = parseAnnotationType(annotation);
  if (!expr) return undefined;
  const value = instantiateTypeExpr(
    expr,
    typesByName,
    functions,
    capabilities,
    consts,
    diagnostics,
    new Map(),
    diagnosticSpan,
  );
  return value?.kind === "type" ? value.normalized : undefined;
}

function instantiateTypeExpr(
  expr: TypeExpr,
  typesByName: Map<string, TypeDecl>,
  functions: Map<string, FnDecl>,
  capabilities: Map<string, string[]>,
  consts: Map<string, ConstValue>,
  diagnostics: Diagnostic[],
  locals = new Map<string, TypeEvalValue>(),
  diagnosticSpan?: Span,
): TypeEvalValue | undefined {
  const evaluator = new TypeEvaluator(
    typesByName,
    functions,
    capabilities,
    consts,
    diagnostics,
    shaderManifestEntry,
    diagnosticSpan,
  );
  return evaluator.eval(expr, locals);
}

class TypeEvaluator {
  constructor(
    private typesByName: Map<string, TypeDecl>,
    private functions: Map<string, FnDecl>,
    private capabilities: Map<string, string[]>,
    private consts: Map<string, ConstValue>,
    private diagnostics: Diagnostic[],
    private addShader: (source: string) => ShaderManifestEntry,
    private diagnosticSpan?: Span,
  ) {}

  eval(
    expr: TypeExpr,
    locals: Map<string, TypeEvalValue>,
    diagnosticSpan?: Span,
  ): TypeEvalValue | undefined {
    if (diagnosticSpan) {
      const previous = this.diagnosticSpan;
      this.diagnosticSpan = diagnosticSpan;
      const value = this.eval(expr, locals);
      this.diagnosticSpan = previous;
      return value;
    }
    switch (expr.kind) {
      case "type_ref":
        return this.evalRef(expr.name, locals);
      case "type_static_ref":
        return { kind: "static_builtin", name: expr.name };
      case "type_call":
        return this.evalCall(expr, locals);
      case "type_shape":
        return {
          kind: "shape",
          slots: expr.shape.slots.map((slot) => ({
            label: slot.label,
            value: this.withSpan(this.eval(slot.type, locals) ?? { kind: "never" }, slot.type.span),
          })),
          span: expr.span,
        };
      case "type_fn":
        return { kind: "type", name: substituteTypeSource(expr.source, locals) };
      case "type_operator":
        return {
          kind: "type",
          name: renderTypeExpr(expr),
          normalized: {
            kind: "operator",
            descriptor: expr.descriptor,
          },
        };
      case "type_match": {
        const value = this.eval(expr.value, locals);
        if (!value) return undefined;
        for (const arm of expr.arms) {
          if (typePatternMatches(arm.pattern, value)) {
            return this.eval(arm.value, new Map(locals));
          }
        }
        this.reportDiagnostic({
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
          const leftKey = this.typeEvalKey(left);
          const rightKey = this.typeEvalKey(right);
          const equal = leftKey === rightKey;
          return { kind: "bool", value: expr.op === "==" ? equal : !equal };
        }
        if (expr.op === "|") {
          const members = [
            ...(literalTypeMembersFromEval(left) ?? []),
            ...(literalTypeMembersFromEval(right) ?? []),
          ];
          if (members.length) return this.namedType(renderLiteralUnionType(members));
        }
        return this.unsupported(
          "type.unsupported_expr",
          `operator ${expr.op} is not type-evaluable`,
        );
      }
      case "type_string":
        return { kind: "string", value: expr.value };
      case "type_char":
        return { kind: "char", value: expr.value };
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
    const evaluatedCallee =
      expr.callee.kind === "type_ref" || expr.callee.kind === "type_static_ref"
        ? undefined
        : this.eval(expr.callee, locals);
    const callee = expr.callee.kind === "type_ref"
      ? expr.callee.name
      : expr.callee.kind === "type_static_ref"
      ? `@${expr.callee.name}`
      : evaluatedCallee?.kind === "type"
      ? evaluatedCallee.name
      : undefined;
    const args = expr.args.map((arg) =>
      this.withSpan(this.eval(arg, locals) ?? { kind: "never" as const }, arg.span)
    );
    if (!callee) {
      return this.unsupported("type.unsupported_expr", "type calls require a named callee");
    }
    if (callee === "struct" || callee === "union") {
      return this.evalTypeBuilder(callee, expr.args, locals);
    }
    if (callee === "index") {
      return this.withSpan(
        this.namedType(`index(${args.map(renderTypeEvalValue).join(", ")})`),
        expr.span,
      );
    }
    if (callee && isStaticBuiltinName(callee) && !callee.startsWith("@")) {
      this.reportDiagnostic({
        code: "type.static_builtin_prefix",
        message: `static builtin ${callee} must be called as @${callee}`,
      });
      return { kind: "never" };
    }
    if (callee === "@compile_error") {
      const message = args[0]?.kind === "string" ? args[0].value : "compile-time error";
      this.reportDiagnostic({ code: "type.compile_error", message });
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
    const decl = this.typesByName.get(callee) ?? this.typesByName.get(terminalName(callee));
    if (!decl) {
      return this.withSpan(
        this.namedType(`${callee}(${args.map(renderTypeEvalValue).join(", ")})`),
        expr.span,
      );
    }
    return this.evalTypeFunction(callee, decl, args);
  }

  private evalTypeBuilder(
    callee: string,
    rawArgs: TypeExpr[],
    locals: Map<string, TypeEvalValue>,
  ): TypeEvalValue | undefined {
    const args = rawArgs.map((arg) => ({
      source: arg,
      value: this.withSpan(this.eval(arg, locals) ?? { kind: "never" as const }, arg.span),
    }));
    if (callee === "struct") {
      const arg = args[0];
      if (args.length !== 1) {
        return this.unsupported(
          "type.builder_arg",
          "struct(...) requires one type-block shape binding",
        );
      }
      const normalized = arg.value.kind === "type"
        ? arg.value.normalized
        : arg.value.kind === "shape"
        ? typeShapeValueToProduct(arg.value)
        : undefined;
      if (normalized?.kind !== "product") {
        return this.unsupported(
          "type.builder_arg",
          "struct(...) requires one type-block shape binding",
        );
      }
      return {
        kind: "type",
        name: `struct(${renderTypeExpr(arg.source)})`,
        normalized: { ...normalized, name: "struct", constructor: renderTypeExpr(arg.source) },
      };
    }
    if (
      !args.length ||
      args.some((arg) =>
        arg.source.kind !== "type_ref" ||
        (arg.value.kind !== "type" && arg.value.kind !== "shape")
      )
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
            : arg.value.kind === "shape"
            ? typeShapeValueToProduct(arg.value)?.shape
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
    if (param.kind === "count" || param.kind === "const") return;
    if (!isTypeConstructorKind(param.kind)) return;
    if (arg.kind !== "type") {
      this.reportDiagnostic({
        code: "type.param_kind",
        message: `${callee} parameter ${param.name} expects a type constructor`,
        span: arg.span,
      });
      return;
    }
    const expectedArity = typeConstructorKindArity(param.kind);
    const baseName = arg.name.replace(/\(.*\)$/, "");
    const actual = this.typesByName.get(baseName);
    if (!actual || actual.params.length !== expectedArity) {
      this.reportDiagnostic({
        code: "type.param_kind",
        message:
          `${callee} parameter ${param.name} expects a ${expectedArity}-argument type constructor`,
        span: arg.span,
      });
      return;
    }
    if (
      !typeConstructorResultKindsCompatible(
        typeConstructorResultKind(param.kind),
        actual.resultKind,
      )
    ) {
      this.reportDiagnostic({
        code: "type.param_kind",
        message: `${callee} parameter ${param.name} expects a type constructor returning ${
          typeConstructorResultKind(param.kind)
        }`,
        span: arg.span,
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
        this.reportDiagnostic({ code: "type.require", message });
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
    if (name === "shape_map") return this.evalShapeMap(args);
    if (name === "shape_concat") return this.evalShapeConcat(args);
    if (name === "shape_has_slot") return this.evalShapeHasSlot(args);
    if (name === "shape_slot") return this.evalShapeSlot(args);
    if (name === "shape_count") return this.evalShapeCount(args);
    if (name === "shape_first_key") return this.evalShapeFirstKey(args);
    if (name === "shape_tail") return this.evalShapeTail(args);
    if (name === "shape_pick") return this.evalShapePick(args);
    if (name === "shape_omit") return this.evalShapeOmit(args);
    if (name === "shape_intersect") return this.evalShapeIntersect(args);
    if (name === "shape_difference") return this.evalShapeDifference(args);
    if (name === "shape_rename") return this.evalShapeRename(args);
    if (name === "shape_map_with_key") return this.evalShapeMapWithKey(args);
    if (name === "shape_filter") return this.evalShapeFilter(args);
    const type = args[0]?.kind === "type" ? this.resolveTypeValue(args[0]) : undefined;
    if (!type) return undefined;
    if (name === "type_is_product") {
      return { kind: "bool", value: type.normalized?.kind === "product" };
    }
    if (name === "type_is_sum") return { kind: "bool", value: type.normalized?.kind === "sum" };
    if (name === "type_is_alias") return { kind: "bool", value: type.normalized?.kind === "alias" };
    if (name === "type_has_slot") {
      return { kind: "bool", value: !!this.typeProductSlot(type, args[1]) };
    }
    if (name === "type_slot_type") {
      const slot = this.typeProductSlot(type, args[1]);
      if (!slot) {
        this.reportDiagnostic({
          code: "type.unknown_type_slot",
          message: `unknown type slot ${typeLiteralName(args[1]) ?? "<unknown>"}`,
          span: args[1]?.span ?? args[0]?.span,
        });
        return { kind: "never" };
      }
      return this.namedType(slot.type);
    }
    if (name === "type_has_member") {
      return { kind: "bool", value: !!this.typeMember(type, args[1]) };
    }
    if (name === "type_member_type") {
      const member = this.typeMember(type, args[1]);
      if (!member) {
        this.reportDiagnostic({
          code: "type.unknown_type_member",
          message: `unknown type member ${typeLiteralName(args[1]) ?? "<unknown>"}`,
          span: args[1]?.span ?? args[0]?.span,
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
    if (name === "type_slots") return this.typeSlots(type);
    if (name === "type_slot_count") {
      return {
        kind: "number",
        value: String(type.normalized?.kind === "product" ? type.normalized.shape.slots.length : 0),
      };
    }
    if (name === "type_variant_slots") return this.typeVariantSlots(type, args[1]);
    if (name === "type_variants") return this.typeVariants(type);
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
    fn.params.forEach((param, index) => {
      const value = args[index] ?? { kind: "never" as const };
      fnLocals.set(param.name, value);
      if (param.pattern?.kind === "constructor" && param.pattern.args.length === 0) {
        fnLocals.set(param.pattern.name, value);
      }
      if (value.kind === "type") fnLocals.set(param.type, value);
    });
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
        return this.evalRef(expr.name, locals);
      case "call": {
        if (expr.callee.kind !== "var") {
          return this.unsupported(
            "type.unsupported_expr",
            "type helper calls require a named callee",
          );
        }
        const name = expr.callee.name;
        const args = expr.args.map((arg) =>
          this.withSpan(
            this.evalStaticExpr(arg, locals, callStack) ?? { kind: "never" as const },
            arg.span,
          )
        );
        if (isStaticBuiltinName(name) && !name.startsWith("@")) {
          this.reportDiagnostic({
            code: "type.static_builtin_prefix",
            message: `static builtin ${name} must be called as @${name}`,
          });
          return { kind: "never" };
        }
        if (name === "@compile_error") {
          const message = args[0]?.kind === "string" ? args[0].value : "compile-time error";
          this.reportDiagnostic({ code: "type.compile_error", message });
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
          const leftKey = this.typeEvalKey(left);
          const rightKey = this.typeEvalKey(right);
          const equal = leftKey === rightKey;
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
        return {
          kind: "shape",
          slots: expr.slots.map((slot) => ({
            label: slot.label,
            value: this.withSpan(
              this.evalStaticExpr(slot.value, locals, callStack) ?? { kind: "never" },
              slot.value.span,
            ),
          })),
        };
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
      return this.unsupported("type.unsupported_expr", "unsupported type block statement");
    }
    const ordered = orderBlockStatements(block.statements, this.diagnostics);
    for (const stmt of ordered) {
      if (stmt.kind === "let") {
        const value = this.withSpan(
          this.evalStaticExpr(stmt.value, locals, callStack),
          stmt.value.span,
        );
        if (!value) return undefined;
        locals.set(stmt.name, value);
      }
    }
    return block.expr ? this.evalStaticExpr(block.expr, locals, callStack) : undefined;
  }

  private namedType(name: string): Extract<TypeEvalValue, { kind: "type" }> {
    const normalized = this.typesByName.get(name)?.normalized ??
      this.typesByName.get(terminalName(name))?.normalized;
    return { kind: "type", name, normalized };
  }

  private evalRef(name: string, locals: Map<string, TypeEvalValue>): TypeEvalValue {
    const direct = locals.get(name);
    if (direct) return direct;
    const constValue = this.consts.get(name);
    if (constValue) return this.constToEval(constValue);
    const dot = name.lastIndexOf(".");
    if (dot >= 0) {
      const base = this.evalRef(name.slice(0, dot), locals);
      const field = name.slice(dot + 1);
      if (base.kind === "shape") {
        const slot = base.slots.find((item) => item.label === field);
        if (slot) return slot.value;
      }
      if (base.kind === "type") return this.namedType(`${base.name}.${field}`);
    }
    return this.namedType(name);
  }

  private constToEval(value: ConstValue): TypeEvalValue {
    switch (value.kind) {
      case "bool":
        return { kind: "bool", value: value.value };
      case "number":
        return { kind: "number", value: value.value };
      case "string":
        return { kind: "string", value: value.value };
      case "literal_type":
        return { kind: "literal", value: value.value };
      case "type":
        return { kind: "type", name: value.name, normalized: value.normalized };
      case "fn": {
        const decl = this.typesByName.get(value.name);
        if (decl?.params.length === 0) {
          return this.evalTypeFunction(value.name, decl, []) ?? { kind: "never" };
        }
        return { kind: "never" };
      }
      case "shape":
        return {
          kind: "shape",
          slots: value.slots.map((slot) => ({
            label: slot.label,
            value: this.constToEval(slot.value),
          })),
        };
      default:
        return { kind: "never" };
    }
  }

  private evalShapeMap(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = args[0];
    const mapper = args[1];
    if (shape?.kind !== "shape" || mapper?.kind !== "type") {
      if (shape?.kind === "type" || shape?.kind === "never") return { kind: "shape", slots: [] };
      return this.unsupported(
        "type.shape_map",
        "@shape_map requires a shape and mapper type fn",
        shape?.span ?? mapper?.span,
      );
    }
    const mapperName = mapper.name.replace(/\(.*\)$/, "");
    const decl = this.typesByName.get(mapperName);
    if (!decl || decl.params.length !== 1) {
      return this.unsupported(
        "type.shape_map",
        "@shape_map mapper must be a one-argument type fn",
        mapper.span,
      );
    }
    return {
      kind: "shape",
      slots: shape.slots.map((slot, index) => {
        if (!slot.label) {
          this.reportDiagnostic({
            code: "type.shape_map_unlabeled",
            message: `@shape_map input slot ${index} must be labeled`,
          });
        }
        const mapped = this.evalTypeFunction(mapperName, decl, [slot.value]);
        return { label: slot.label, value: mapped ?? { kind: "never" } };
      }),
    };
  }

  private evalTypeFunction(
    callee: string,
    decl: TypeDecl,
    args: TypeEvalValue[],
  ): TypeEvalValue | undefined {
    const selected = this.selectTypeClause(decl, args);
    if (!selected) {
      this.reportDiagnostic({
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
      const value = this.withSpan(this.eval(stmt.value, fnLocals), stmt.value.span);
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
      const normalized = result.normalized
        ? substituteTypeBodyEval(this.withTypeDeclMembers(result.normalized, selected), fnLocals)
        : result.normalized;
      checkTypeResultKind(selected, normalized, this.diagnostics);
      return {
        ...result,
        normalized,
        name: `${callee}(${args.map(renderTypeEvalValue).join(", ")})`,
      };
    }
    return result;
  }

  private evalShapeConcat(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const slots: { label?: string; value: TypeEvalValue }[] = [];
    const seen = new Set<string>();
    for (const [shapeIndex, arg] of args.entries()) {
      if (arg.kind !== "shape") {
        if (arg.kind === "never" || arg.kind === "type") continue;
        return this.unsupported("type.shape_concat", "@shape_concat requires shape arguments");
      }
      for (const slot of arg.slots) {
        if (slot.label && seen.has(slot.label)) {
          this.reportDiagnostic({
            code: "type.shape_concat_duplicate",
            message: `@shape_concat defines duplicate field ${slot.label}`,
          });
        }
        if (slot.label) seen.add(slot.label);
        else if (shapeIndex > 0) {
          this.reportDiagnostic({
            code: "type.shape_concat_unlabeled",
            message: "@shape_concat generated fields must be labeled",
          });
        }
        slots.push(slot);
      }
    }
    return { kind: "shape", slots };
  }

  private evalShapeHasSlot(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_has_slot");
    const label = typeLiteralName(args[1]);
    if (!shape || label === undefined) return undefined;
    return { kind: "bool", value: !!shape.slots.find((slot) => slot.label === label) };
  }

  private evalShapeFirstKey(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_first_key");
    if (!shape) return undefined;
    const first = shape.slots[0];
    if (!first?.label) {
      this.reportDiagnostic({
        code: "type.shape_empty",
        message: "@shape_first_key requires a non-empty labeled shape",
        span: shape.span,
      });
      return { kind: "never" };
    }
    return { kind: "literal", value: first.label };
  }

  private evalShapeTail(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_tail");
    if (!shape) return undefined;
    if (!shape.slots.length) {
      this.reportDiagnostic({
        code: "type.shape_empty",
        message: "@shape_tail requires a non-empty shape",
        span: shape.span,
      });
      return { kind: "never" };
    }
    return { kind: "shape", slots: shape.slots.slice(1) };
  }

  private evalShapeSlot(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_slot");
    const label = typeLiteralName(args[1]);
    if (!shape || label === undefined) return undefined;
    const slot = shape.slots.find((slot) => slot.label === label);
    if (!slot) {
      this.reportDiagnostic({
        code: "type.unknown_shape_slot",
        message: `unknown shape slot ${label}`,
        span: args[1]?.span ?? shape.span,
      });
      return { kind: "never" };
    }
    return slot.value;
  }

  private evalShapeCount(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_count");
    if (!shape) return undefined;
    return { kind: "number", value: String(shape.slots.length) };
  }

  private evalShapePick(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_pick");
    const labels = this.selectorLabels(args[1], "@shape_pick");
    if (!shape || !labels) return undefined;
    return {
      kind: "shape",
      slots: shape.slots.filter((slot) => slot.label && labels.has(slot.label)),
    };
  }

  private evalShapeOmit(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_omit");
    const labels = this.selectorLabels(args[1], "@shape_omit");
    if (!shape || !labels) return undefined;
    return {
      kind: "shape",
      slots: shape.slots.filter((slot) => !slot.label || !labels.has(slot.label)),
    };
  }

  private evalShapeIntersect(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_intersect");
    const labels = this.selectorLabels(args[1], "@shape_intersect");
    if (!shape || !labels) return undefined;
    return {
      kind: "shape",
      slots: shape.slots.filter((slot) => slot.label && labels.has(slot.label)),
    };
  }

  private evalShapeDifference(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_difference");
    const labels = this.selectorLabels(args[1], "@shape_difference");
    if (!shape || !labels) return undefined;
    return {
      kind: "shape",
      slots: shape.slots.filter((slot) => !slot.label || !labels.has(slot.label)),
    };
  }

  private evalShapeRename(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_rename");
    const renames = this.expectShape(args[1], "@shape_rename");
    if (!shape || !renames) return undefined;
    const renameByOld = new Map<string, string>();
    for (const slot of renames.slots) {
      const next = typeLiteralName(slot.value);
      if (!slot.label || next === undefined) {
        return this.unsupported(
          "type.shape_builtin_arg",
          "@shape_rename renames must be labeled literal or string values",
          args[1]?.span,
        );
      }
      renameByOld.set(slot.label, next);
    }
    const result = shape.slots.map((slot) => ({
      ...slot,
      label: slot.label ? renameByOld.get(slot.label) ?? slot.label : slot.label,
    }));
    const seen = new Set<string>();
    for (const slot of result) {
      if (!slot.label) continue;
      if (seen.has(slot.label)) {
        this.reportDiagnostic({
          code: "type.shape_rename_duplicate",
          message: `@shape_rename defines duplicate field ${slot.label}`,
          span: args[1]?.span ?? shape.span,
        });
        return { kind: "never" };
      }
      seen.add(slot.label);
    }
    return { kind: "shape", slots: result };
  }

  private evalShapeMapWithKey(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_map_with_key");
    const mapper = args[1];
    if (!shape || mapper?.kind !== "type") {
      return this.unsupported(
        "type.shape_map_with_key",
        "@shape_map_with_key requires a shape and mapper type fn",
        shape?.span ?? mapper?.span,
      );
    }
    const decl = this.typeFunctionDecl(
      mapper.name,
      2,
      "@shape_map_with_key",
      "type.shape_map_with_key",
      mapper.span,
    );
    if (!decl) return undefined;
    return {
      kind: "shape",
      slots: shape.slots.map((slot) => ({
        label: slot.label,
        value: this.evalTypeFunction(mapper.name.replace(/\(.*\)$/, ""), decl, [
          { kind: "literal", value: slot.label ?? "" },
          slot.value,
        ]) ?? { kind: "never" },
      })),
    };
  }

  private evalShapeFilter(args: TypeEvalValue[]): TypeEvalValue | undefined {
    const shape = this.expectShape(args[0], "@shape_filter");
    const predicate = args[1];
    if (!shape || predicate?.kind !== "type") {
      return this.unsupported(
        "type.shape_filter",
        "@shape_filter requires a shape and predicate type fn",
        shape?.span ?? predicate?.span,
      );
    }
    const decl = this.typeFunctionDecl(
      predicate.name,
      2,
      "@shape_filter",
      "type.shape_filter",
      predicate.span,
    );
    if (!decl) return undefined;
    const name = predicate.name.replace(/\(.*\)$/, "");
    const slots = [];
    for (const slot of shape.slots) {
      const keep = this.evalTypeFunction(name, decl, [
        { kind: "literal", value: slot.label ?? "" },
        slot.value,
      ]);
      if (keep?.kind !== "bool") {
        this.reportDiagnostic({
          code: "type.shape_filter",
          message: "@shape_filter predicate must return bool",
          span: predicate.span,
        });
        return { kind: "never" };
      }
      if (keep.value) slots.push(slot);
    }
    return { kind: "shape", slots };
  }

  private expectShape(
    value: TypeEvalValue | undefined,
    builtin: string,
  ): Extract<TypeEvalValue, { kind: "shape" }> | undefined {
    if (value?.kind === "shape") return value;
    if (value?.kind === "never") return undefined;
    return this.unsupported(
      "type.shape_builtin_arg",
      `${builtin} requires a shape argument`,
      value?.span,
    );
  }

  private selectorLabels(
    value: TypeEvalValue | undefined,
    builtin: string,
  ): Set<string> | undefined {
    const shape = this.expectShape(value, builtin);
    if (!shape) return undefined;
    const labels = new Set<string>();
    for (const slot of shape.slots) {
      if (!slot.label) {
        return this.unsupported(
          "type.shape_builtin_arg",
          `${builtin} selector slots must be labeled`,
          shape.span,
        );
      }
      labels.add(slot.label);
    }
    return labels;
  }

  private typeFunctionDecl(
    name: string,
    arity: number,
    builtin: string,
    code: string,
    span?: Span,
  ): TypeDecl | undefined {
    const mapperName = name.replace(/\(.*\)$/, "");
    const decl = this.typesByName.get(mapperName);
    if (!decl || decl.params.length !== arity) {
      this.reportDiagnostic({
        code,
        message: `${builtin} callback must be a ${arity}-argument type fn`,
        span,
      });
      return undefined;
    }
    return decl;
  }

  private typeSlots(type: TypeEvalValue): TypeEvalValue {
    if (type.kind === "type") type = this.resolveTypeValue(type);
    if (type.kind === "shape") return type;
    if (type.kind !== "type" || type.normalized?.kind !== "product") {
      return { kind: "shape", slots: [] };
    }
    return {
      kind: "shape",
      slots: type.normalized.shape.slots.map((slot) => ({
        label: slot.label,
        repeat: slot.repeat,
        value: this.namedType(slot.type),
      })),
    };
  }

  private typeVariantSlots(
    type: TypeEvalValue,
    variantValue: TypeEvalValue | undefined,
  ): TypeEvalValue {
    if (type.kind === "type") type = this.resolveTypeValue(type);
    const variantName = typeLiteralName(variantValue);
    const variant = type.kind === "type" && type.normalized?.kind === "sum"
      ? type.normalized.variants.find((item) => item.name === variantName)
      : undefined;
    if (!variant) {
      this.reportDiagnostic({
        code: "type.unknown_type_variant",
        message: `unknown type variant ${variantName ?? "<unknown>"}`,
        span: variantValue?.span ?? type.span,
      });
      return { kind: "never" };
    }
    return {
      kind: "shape",
      slots: variant.shape?.slots.map((slot) => ({
        label: slot.label,
        repeat: slot.repeat,
        value: this.namedType(slot.type),
      })) ?? [],
    };
  }

  private typeVariants(type: TypeEvalValue): TypeEvalValue {
    if (type.kind === "type") type = this.resolveTypeValue(type);
    if (type.kind !== "type" || type.normalized?.kind !== "sum") {
      return { kind: "shape", slots: [] };
    }
    return {
      kind: "shape",
      slots: type.normalized.variants.map((variant) => ({
        label: variant.name,
        value: {
          kind: "shape",
          slots: variant.shape?.slots.map((slot) => ({
            label: slot.label,
            repeat: slot.repeat,
            value: this.namedType(slot.type),
          })) ?? [],
        },
      })),
    };
  }

  resolve(value: TypeEvalValue): TypeEvalValue {
    return value.kind === "type" ? this.resolveTypeValue(value) : value;
  }

  private unsupported(code: string, message: string, span?: Span): undefined {
    this.reportDiagnostic({ code, message, span });
    return undefined;
  }

  private reportDiagnostic(diagnostic: Diagnostic) {
    this.diagnostics.push({
      ...diagnostic,
      span: diagnostic.span ?? this.diagnosticSpan,
    });
  }

  private withSpan<t extends TypeEvalValue | undefined>(value: t, span?: Span): t {
    if (!value || value.span || !span) return value;
    return { ...value, span } as t;
  }

  private withTypeDeclMembers(body: TypeBody, decl: TypeDecl): TypeBody {
    if (body.kind !== "product" && body.kind !== "sum") return body;
    const members = decl.normalized?.kind === body.kind ? decl.normalized.members : undefined;
    return members?.length ? { ...body, members } : body;
  }

  private typeProductSlot(type: TypeEvalValue, name: TypeEvalValue | undefined) {
    const slotName = typeLiteralName(name);
    if (type.kind !== "type") return undefined;
    type = this.resolveTypeValue(type);
    if (type.normalized?.kind !== "product") return undefined;
    return type.normalized.shape.slots.find((slot) => slot.label === slotName);
  }

  private typeMember(type: TypeEvalValue, name: TypeEvalValue | undefined) {
    const memberName = typeLiteralName(name);
    if (type.kind !== "type") return undefined;
    type = this.resolveTypeValue(type);
    if (type.normalized?.kind === "product" || type.normalized?.kind === "sum") {
      const member = type.normalized.members?.find((member) => member.name === memberName);
      if (member) {
        const decl = this.typesByName.get(typeNameOf(type.name));
        const bindings = decl ? genericBindings(type.name, decl) : new Map<string, string>();
        return { ...member, type: substituteTypeVars(member.type, bindings) };
      }
    }
    if (memberName === "empty" && typeHasDerivedEmpty(type)) {
      return {
        name: "empty",
        type: `fn() -> ${type.name}`,
        target: `${type.name}.empty`,
      };
    }
    return undefined;
  }

  private resolveTypeValue(
    type: Extract<TypeEvalValue, { kind: "type" }>,
    seen = new Set<string>(),
  ): Extract<TypeEvalValue, { kind: "type" }> {
    if (seen.has(type.name)) return type;
    seen.add(type.name);
    if (type.normalized) return type;

    const call = type.name.match(/^(.+)\((.*)\)$/);
    if (call) {
      const base = call[1].trim();
      const directDecl = this.typesByName.get(base);
      const decl = directDecl ?? this.typesByName.get(terminalName(base));
      if (decl) {
        const args = splitTypeArgs(call[2]).map((arg) => {
          const parsed = parseAnnotationType(arg);
          return parsed ? this.eval(parsed, new Map()) ?? { kind: "never" as const } : {
            kind: "never" as const,
          };
        });
        if (
          decl.normalized?.kind === "alias" && decl.params.every((param) => param.kind !== "const")
        ) {
          const aliased = substituteAliasTypeParams(
            decl.normalized.type,
            decl,
            args.map(renderTypeEvalValue),
          );
          return this.resolveTypeValue(this.namedType(aliased), seen);
        }
        const called = this.selectTypeClause(decl, args)
          ? this.evalTypeFunction(directDecl ? base : decl.name, decl, args)
          : undefined;
        if (called?.kind === "type") {
          if (called.name !== type.name) return this.resolveTypeValue(called, seen);
          if (called.normalized) type = called;
        }
      }
    }

    const expr = parseAnnotationType(type.name);
    if (expr) {
      const expanded = this.eval(expr, new Map());
      if (expanded?.kind === "type") {
        if (expanded.name !== type.name) return this.resolveTypeValue(expanded, seen);
        if (expanded.normalized && !type.normalized) type = expanded;
      }
      if (expr.kind === "type_call" && expr.callee.kind === "type_ref") {
        const directDecl = this.typesByName.get(expr.callee.name);
        const decl = directDecl ?? this.typesByName.get(terminalName(expr.callee.name));
        if (decl) {
          const args = expr.args.map((arg) =>
            this.eval(arg, new Map()) ?? { kind: "never" as const }
          );
          const called = this.selectTypeClause(decl, args)
            ? this.evalTypeFunction(directDecl ? expr.callee.name : decl.name, decl, args)
            : undefined;
          if (called?.kind === "type") {
            if (called.name !== type.name) return this.resolveTypeValue(called, seen);
            if (called.normalized && !type.normalized) type = called;
          }
        }
      }
    }

    const decl = this.typesByName.get(type.name);
    if (decl && decl.params.length === 0 && decl.body.expr) {
      const expanded = this.evalTypeFunction(type.name, decl, []);
      if (expanded?.kind === "type") {
        if (expanded.name !== type.name) return this.resolveTypeValue(expanded, seen);
        if (expanded.normalized && !type.normalized) type = expanded;
      }
    }

    if (type.normalized?.kind === "alias") {
      const aliasExpr = parseAnnotationType(type.normalized.type);
      if (aliasExpr) {
        const expanded = this.eval(aliasExpr, new Map());
        if (expanded?.kind === "type") return this.resolveTypeValue(expanded, seen);
      }
    }

    return type;
  }

  private typeEvalKey(value: TypeEvalValue): string {
    switch (value.kind) {
      case "shape":
        return JSON.stringify({
          kind: "shape",
          slots: value.slots.map((slot) => ({
            label: slot.label,
            repeat: slot.repeat,
            value: this.typeEvalKey(slot.value),
          })),
        });
      case "type":
        return this.typeEvalTypeKey(value);
      default:
        return renderTypeEvalValue(value);
    }
  }

  private typeEvalTypeKey(value: Extract<TypeEvalValue, { kind: "type" }>): string {
    const resolved = this.resolveTypeValue(value);
    if (resolved.normalized) return JSON.stringify(this.typeBodyEvalKey(resolved.normalized));
    if (resolved.name.startsWith("{")) {
      try {
        const parsed = JSON.parse(resolved.name) as TypeEvalValue;
        if (parsed.kind === "type") return this.typeEvalTypeKey(parsed);
        if (parsed.kind === "shape") return this.typeEvalKey(parsed);
      } catch {
        // Fall through to the rendered name.
      }
    }
    const array = resolved.name.match(/(?:^|\.)(?:ComponentStore|InlineArray)\((.*)\)$/);
    if (array) {
      const args = splitTypeArgs(array[1]);
      return JSON.stringify({
        kind: "product",
        shape: [{
          type: this.typeEvalTypeKey(this.namedType(args[1]?.trim() ?? "i32")),
        }],
      });
    }
    return resolved.name;
  }

  private typeBodyEvalKey(body: TypeBody): unknown {
    switch (body.kind) {
      case "alias": {
        const resolved = this.resolveTypeValue(this.namedType(body.type));
        return resolved.normalized
          ? this.typeBodyEvalKey(resolved.normalized)
          : { kind: "type", name: resolved.name };
      }
      case "product":
        return {
          kind: "product",
          shape: body.shape.slots.map((slot) => ({
            label: slot.label,
            type: this.typeEvalTypeKey(this.namedType(slot.type)),
            repeat: slot.repeat,
          })),
        };
      case "sum":
        return {
          kind: "sum",
          variants: body.variants.map((variant) => ({
            name: variant.name,
            shape: variant.shape?.slots.map((slot) => ({
              label: slot.label,
              type: this.typeEvalTypeKey(this.namedType(slot.type)),
              repeat: slot.repeat,
            })) ?? [],
          })),
        };
      case "operator":
        return { kind: "operator", descriptor: body.descriptor };
    }
  }
}

function typeProductSlot(type: TypeEvalValue, name: TypeEvalValue | undefined) {
  const slotName = typeLiteralName(name);
  if (type.kind !== "type" || type.normalized?.kind !== "product") return undefined;
  return type.normalized.shape.slots.find((slot) => slot.label === slotName);
}

function constToTypeEvalValue(value: ConstValue): TypeEvalValue {
  switch (value.kind) {
    case "bool":
      return { kind: "bool", value: value.value };
    case "number":
      return { kind: "number", value: value.value };
    case "string":
      return { kind: "string", value: value.value };
    case "literal_type":
      return { kind: "literal", value: value.value };
    case "type":
      return { kind: "type", name: value.name, normalized: value.normalized };
    case "shape":
      return {
        kind: "shape",
        slots: value.slots.map((slot) => ({
          label: slot.label,
          value: constToTypeEvalValue(slot.value),
        })),
      };
    default:
      return { kind: "never" };
  }
}

function typeShapeValueToProduct(
  shape: Extract<TypeEvalValue, { kind: "shape" }>,
): TypeBody & { kind: "product" } {
  return {
    kind: "product",
    name: "shape",
    constructor: "Shape",
    shape: {
      slots: shape.slots.map((slot) => ({
        label: slot.label,
        repeat: slot.repeat,
        type: slot.value.kind === "type" ? slot.value.name : renderTypeEvalValue(slot.value),
      })),
    },
  };
}

function typeMember(type: TypeEvalValue, name: TypeEvalValue | undefined) {
  const memberName = typeLiteralName(name);
  if (type.kind !== "type") return undefined;
  if (type.normalized?.kind === "product" || type.normalized?.kind === "sum") {
    const member = type.normalized.members?.find((member) => member.name === memberName);
    if (member) return member;
  }
  if (memberName === "empty" && typeHasDerivedEmpty(type)) {
    return {
      name: "empty",
      type: `fn() -> ${type.name}`,
      target: `${type.name}.empty`,
    };
  }
  return undefined;
}

function emptyMemberOwner(name: string): string | undefined {
  return name.endsWith(".empty") ? name.slice(0, -".empty".length) : undefined;
}

function emptyExprForType(type: string, context: ConstSpecializationContext): Expr | undefined {
  if (context.functions.has(`${type}.empty`)) {
    return { kind: "call", callee: { kind: "var", name: `${type}.empty` }, args: [] };
  }
  return derivedEmptyExpr(type, context.types);
}

function typeHasDerivedEmpty(
  type: Extract<TypeEvalValue, { kind: "type" }>,
  seen = new Set<string>(),
): boolean {
  const name = terminalName(type.name);
  if (isEmptyPrimitiveType(name)) return true;
  if (seen.has(type.name)) return false;
  seen.add(type.name);
  if (type.normalized?.kind === "alias") {
    return typeHasDerivedEmpty({ kind: "type", name: type.normalized.type }, seen);
  }
  if (type.normalized?.kind !== "product") return false;
  return type.normalized.shape.slots.every((slot) =>
    typeHasDerivedEmpty({ kind: "type", name: slot.type }, seen)
  );
}

function derivedEmptyExpr(
  type: string,
  types: TypeDecl[],
  seen = new Set<string>(),
): Expr | undefined {
  const literal = literalTypeMembers(type)?.[0];
  if (literal) return literalTypeMemberExpr(literal);
  const name = terminalName(type);
  if (name === "bool") return { kind: "literal", literalKind: "bool", value: "false" };
  if (isEmptyNumericType(name)) return { kind: "literal", literalKind: "number", value: "0" };
  if (seen.has(type)) return undefined;
  seen.add(type);
  const decl = resolveTypeDecl(type, types);
  if (!decl?.normalized) return undefined;
  if (decl.normalized.kind === "alias") return derivedEmptyExpr(decl.normalized.type, types, seen);
  if (decl.normalized.kind !== "product") return undefined;
  const bindings = genericBindings(type, decl);
  const slots = [];
  for (const slot of decl.normalized.shape.slots) {
    const slotType = substituteTypeVars(slot.type, bindings);
    const value = derivedEmptyExpr(slotType, types, seen);
    if (!value) return undefined;
    slots.push({ label: slot.label, value });
  }
  return {
    kind: "product_constructor",
    constructor: decl.normalized.constructor,
    slots,
  };
}

function literalTypeMemberExpr(member: LiteralTypeMember): Expr {
  if (member.kind === "bool") {
    return { kind: "literal", literalKind: "bool", value: member.value };
  }
  if (member.kind === "number") {
    return { kind: "literal", literalKind: "number", value: member.value };
  }
  if (member.kind === "string") {
    return { kind: "literal", literalKind: "string", value: JSON.stringify(member.value) };
  }
  if (member.kind === "char") {
    return { kind: "literal", literalKind: "char", value: renderLiteralTypeMember(member) };
  }
  return { kind: "literal", literalKind: "literalType", value: `#${member.value}` };
}

function isEmptyPrimitiveType(type: string): boolean {
  return type === "bool" || isEmptyNumericType(type);
}

function isEmptyNumericType(type: string): boolean {
  return ["i32", "u32", "i64", "u64", "f32", "f64"].includes(type) ||
    unsignedBitWidth(type) !== undefined;
}

function unsignedBitWidth(type: string): number | undefined {
  const match = type.match(/^u([1-9][0-9]*)$/);
  if (!match) return undefined;
  const width = Number.parseInt(match[1], 10);
  return width >= 1 && width <= 64 ? width : undefined;
}

function typeLiteralName(value: TypeEvalValue | undefined): string | undefined {
  return value?.kind === "literal" || value?.kind === "string" || value?.kind === "char"
    ? value.value
    : undefined;
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
  ].includes(bare);
}

function typePatternMatches(pattern: TypePattern, value: TypeEvalValue): boolean {
  if (pattern.kind === "wildcard") return true;
  if (pattern.kind === "bool") return value.kind === "bool" && value.value === pattern.value;
  if (pattern.kind === "literal") return value.kind === "literal" && value.value === pattern.value;
  if (pattern.kind === "string") return value.kind === "string" && value.value === pattern.value;
  if (pattern.kind === "char") return value.kind === "char" && value.value === pattern.value;
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
    if (pattern.literalKind === "char") {
      return value.kind === "char" && `'${value.value}'` === pattern.value;
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
  locals.set(
    pattern?.kind === "binding" || pattern?.kind === "type" ? pattern.name : fallbackName,
    value,
  );
}

function typeExprPatternMatches(pattern: ParamPattern, value: TypeEvalValue): boolean {
  if (pattern.kind === "wildcard" || pattern.kind === "binding") return true;
  if (pattern.kind !== "literal" && pattern.kind !== "type") return false;
  const text = renderParamPattern(pattern);
  if (value.kind === "bool") return text === (value.value ? "true" : "false");
  if (value.kind === "number") return text === value.value;
  if (value.kind === "string") return text === JSON.stringify(value.value);
  if (value.kind === "literal") return text === `#${value.value}`;
  if (value.kind === "char") return text === `'${value.value}'`;
  if (value.kind === "type") return text === value.name;
  return false;
}

function renderTypeEvalValue(value: TypeEvalValue): string {
  if (value.kind === "type") return value.name;
  if (value.kind === "literal") return `#${value.value}`;
  if (value.kind === "char") return `'${value.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (value.kind === "string") return JSON.stringify(value.value);
  if (value.kind === "number") return value.value;
  if (value.kind === "bool") return value.value ? "true" : "false";
  if (value.kind === "static_builtin") return `@${value.name}`;
  if (value.kind === "shape") {
    return `[${
      value.slots.map((slot) =>
        `${slot.label ? `${slot.label}: ` : ""}${renderTypeEvalValue(slot.value)}`
      ).join(", ")
    }]`;
  }
  return "<never>";
}

function substituteTypeExpr(expr: TypeExpr, locals: Map<string, TypeEvalValue>): TypeExpr {
  if (expr.kind === "type_ref") {
    const local = locals.get(expr.name);
    if (local?.kind === "type") return parseAnnotationType(local.name) ?? expr;
    if (local?.kind === "literal") return { kind: "type_literal", value: local.value };
    if (local?.kind === "char") return { kind: "type_char", value: local.value };
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
  if (expr.kind === "type_operator") return expr;
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
    } else if (value.kind === "shape") {
      for (const slot of value.slots) {
        if (!slot.label) continue;
        result = result.replace(
          new RegExp(`\\b${name}\\.${slot.label}\\b`, "g"),
          renderTypeEvalValue(slot.value),
        );
      }
    }
  }
  return result;
}

function substituteTypeBodyEval(body: TypeBody, locals: Map<string, TypeEvalValue>): TypeBody {
  switch (body.kind) {
    case "alias":
      return { ...body, type: substituteTypeSource(body.type, locals) };
    case "product":
      return {
        ...body,
        shape: {
          ...body.shape,
          slots: body.shape.slots.map((slot) => ({
            ...slot,
            type: substituteTypeSource(slot.type, locals),
          })),
        },
      };
    case "sum":
      return {
        ...body,
        variants: body.variants.map((variant) => ({
          ...variant,
          shape: variant.shape
            ? {
              ...variant.shape,
              slots: variant.shape.slots.map((slot) => ({
                ...slot,
                type: substituteTypeSource(slot.type, locals),
              })),
            }
            : undefined,
        })),
      };
    case "operator":
      return body;
  }
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
    return this.index >= this.source.length ? expr : undefined;
  }

  private parseType(): TypeExpr | undefined {
    return this.parseUnion();
  }

  private parseUnion(): TypeExpr | undefined {
    let expr = this.parsePrimaryType();
    if (!expr) return undefined;
    while (this.peek("|")) {
      this.index++;
      const right = this.parsePrimaryType();
      if (!right) return undefined;
      expr = { kind: "type_binary", op: "|", left: expr, right };
    }
    return expr;
  }

  private parsePrimaryType(): TypeExpr | undefined {
    this.skip();
    if (this.peekKeyword("fn")) {
      return { kind: "type_fn", source: this.source.slice(this.index).trim() };
    }
    if (this.peek("{")) return { kind: "type_shape", shape: this.parseShape() };
    if (this.peek("[")) return { kind: "type_shape", shape: this.parseTupleShape() };
    if (this.peek("@")) {
      this.index++;
      const name = this.ident();
      if (!name) return undefined;
      return { kind: "type_static_ref", name };
    }
    if (this.peek("#")) {
      this.index++;
      if (this.peek("(")) {
        this.index++;
        const inner = this.parseType();
        this.skip();
        if (this.peek(")")) this.index++;
        return inner
          ? { kind: "type_call", callee: { kind: "type_ref", name: "#" }, args: [inner] }
          : undefined;
      }
      const value = this.ident();
      if (!value) return undefined;
      return { kind: "type_literal", value };
    }
    if (this.peekKeyword("true")) {
      this.index += "true".length;
      return { kind: "type_bool", value: true };
    }
    if (this.peekKeyword("false")) {
      this.index += "false".length;
      return { kind: "type_bool", value: false };
    }
    if (this.peek('"')) {
      const text = this.quoted('"');
      return text === undefined ? undefined : { kind: "type_string", value: JSON.parse(text) };
    }
    if (this.peek("'")) {
      const text = this.quoted("'");
      return text === undefined
        ? undefined
        : { kind: "type_char", value: JSON.parse(`"${text.slice(1, -1)}"`) };
    }
    const number = this.source.slice(this.index).match(/^[0-9]+/);
    if (number) {
      this.index += number[0].length;
      return { kind: "type_number", value: number[0] };
    }
    const name = this.ident();
    if (!name) return undefined;
    let fullName = name;
    while (this.peek(".")) {
      this.index++;
      const part = this.ident();
      if (!part) break;
      fullName += `.${part}`;
    }
    let expr: TypeExpr = { kind: "type_ref", name: fullName };
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

  private quoted(quote: '"' | "'"): string | undefined {
    this.skip();
    if (!this.source.startsWith(quote, this.index)) return undefined;
    const start = this.index;
    this.index++;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "\\") {
        this.index += 2;
        continue;
      }
      this.index++;
      if (char === quote) return this.source.slice(start, this.index);
    }
    return undefined;
  }

  private parseShape(): TypeShape {
    this.index++;
    const slots: TypeShape["slots"] = [];
    this.skip();
    while (!this.peek("}") && this.index < this.source.length) {
      const start = this.index;
      const first = this.ident();
      let label: string | undefined;
      let position: number | undefined;
      this.skip();
      if (first && this.peek("[")) {
        this.index++;
        const digits = this.source.slice(this.index).match(/^[0-9]+/);
        if (digits) {
          position = Number.parseInt(digits[0], 10);
          this.index += digits[0].length;
        }
        if (this.peek("]")) this.index++;
        this.skip();
      } else if (!first && this.peek("[")) {
        this.index++;
        const digits = this.source.slice(this.index).match(/^[0-9]+/);
        if (digits) {
          position = Number.parseInt(digits[0], 10);
          this.index += digits[0].length;
        }
        if (this.peek("]")) this.index++;
        this.skip();
      }
      if ((first || position !== undefined) && this.peek(":")) {
        label = first;
        this.index++;
      } else {
        this.index = start;
        position = undefined;
      }
      const type = this.parseType() ??
        { kind: "type_ref" as const, name: this.readUntil([",", "}"]).trim() };
      slots.push({ label, position, type });
      this.skip();
      if (this.peek(",")) {
        this.index++;
        this.skip();
      }
    }
    if (this.peek("}")) this.index++;
    return { slots };
  }

  private parseTupleShape(): TypeShape {
    this.index++;
    const slots: TypeShape["slots"] = [];
    this.skip();
    if (this.peek("]")) {
      this.index++;
      return { slots };
    }
    const first = this.parseType();
    this.skip();
    if (this.peek(";")) {
      this.index++;
      this.skip();
      const count = this.readUntil(["]"]).trim();
      if (this.peek("]")) this.index++;
      return {
        slots: [{
          position: 0,
          type: first ?? { kind: "type_ref", name: "type" },
          repeat: parseTypeCount(count),
        }],
      };
    }
    if (first) slots.push({ position: 0, type: first });
    let position = 1;
    while (this.peek(",") && this.index < this.source.length) {
      this.index++;
      this.skip();
      if (this.peek("]")) break;
      const type = this.parseType();
      if (!type) break;
      slots.push({ position, type });
      position++;
      this.skip();
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

interface OwnershipBinding {
  moved: boolean;
  type?: string;
}

function checkFn(
  fn: FnDecl,
  capabilities: Map<string, string[]>,
  diagnostics: Diagnostic[],
  types: TypeDecl[],
  functions: FnDecl[],
  options: { recoverTypes: boolean },
) {
  if (
    exprContainsStaticExpansion(fn.body) || isInlineArrayExprBuiltinWrapper(fn) ||
    fn.name.endsWith("ComponentStore.set")
  ) return;
  const env = new Map<string, OwnershipBinding>();
  for (const param of fn.params) {
    env.set(param.name, { moved: false, type: param.type });
  }
  checkBlock(
    fn.body,
    env,
    capabilities,
    fn.effects,
    diagnostics,
    fn.returnType,
    types,
    functions,
    options,
  );
}

function exprContainsStaticExpansion(expr: Expr | undefined): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "static_for_slots":
      return true;
    case "block":
      return expr.statements.some((stmt) =>
        stmt.kind === "let" && exprContainsStaticExpansion(stmt.value) ||
        stmt.kind === "destructure_let" && exprContainsStaticExpansion(stmt.value)
      ) || exprContainsStaticExpansion(expr.expr);
    case "call":
      return exprContainsStaticExpansion(expr.callee) ||
        expr.args.some(exprContainsStaticExpansion);
    case "index":
      return exprContainsStaticExpansion(expr.target) || exprContainsStaticExpansion(expr.index);
    case "binary":
      return exprContainsStaticExpansion(expr.left) || exprContainsStaticExpansion(expr.right);
    case "pipe_bind":
      return exprContainsStaticExpansion(expr.value) || exprContainsStaticExpansion(expr.body);
    case "match":
      return exprContainsStaticExpansion(expr.value) ||
        expr.arms.some((arm) => exprContainsStaticExpansion(arm.value));
    case "shape":
    case "product_constructor":
      return expr.slots.some((slot) => exprContainsStaticExpansion(slot.value));
    case "field":
      return exprContainsStaticExpansion(expr.value) || exprContainsStaticExpansion(expr.key);
    case "range":
      return exprContainsStaticExpansion(expr.start) || exprContainsStaticExpansion(expr.end);
    case "literal":
    case "placeholder":
    case "var":
      return false;
  }
}

function checkStatement(
  stmt: Statement,
  env: Map<string, OwnershipBinding>,
  capabilities: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  types: TypeDecl[],
  functions: FnDecl[],
  options: { recoverTypes: boolean },
) {
  if (stmt.kind === "let") {
    checkExpr(
      stmt.value,
      env,
      capabilities,
      effects,
      diagnostics,
      stmt.type,
      types,
      functions,
      options,
    );
    stmt.type ??= exprBindingType(stmt.value, env, types, functions, options.recoverTypes);
    env.set(stmt.name, { moved: false, type: stmt.type });
    return;
  }
  if (stmt.kind === "proof_const") return;
  if (stmt.kind === "destructure_let") {
    checkExpr(
      stmt.value,
      env,
      capabilities,
      effects,
      diagnostics,
      undefined,
      types,
      functions,
      options,
    );
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
      env.set(stmt.names[index], { moved: false, type: slots[index] });
    }
    return;
  }
}

function isStaticBinding(binding: { type?: string } | undefined): boolean {
  return binding?.type === "count" || binding?.type === "type" || binding?.type === "const" ||
    binding?.type?.startsWith("fn(") === true;
}

function isBorrowType(type: string | undefined): boolean {
  return type?.trim().startsWith("&") === true;
}

function stripBorrowType(type: string | undefined): string {
  let current = type?.trim() ?? "";
  while (isBorrowType(current)) current = unwrapPrefixedType(current, "&");
  return current;
}

function isFrozenType(type: string | undefined): boolean {
  return type?.trim().startsWith("#(") === true;
}

function stripFrozenType(type: string | undefined): string {
  let current = type?.trim() ?? "";
  while (isFrozenType(current)) current = unwrapPrefixedType(current, "#");
  return current;
}

function stripReferenceType(type: string | undefined): string {
  let current = type?.trim() ?? "";
  let changed = true;
  while (changed) {
    changed = false;
    if (isBorrowType(current)) {
      current = stripBorrowType(current);
      changed = true;
    }
    if (isFrozenType(current)) {
      current = stripFrozenType(current);
      changed = true;
    }
  }
  return current;
}

function unwrapPrefixedType(type: string, prefix: "&" | "#"): string {
  let current = type.trim();
  if (!current.startsWith(prefix)) return current;
  current = current.slice(prefix.length).trim();
  if (current.startsWith("(") && current.endsWith(")") && enclosesWholeType(current)) {
    return current.slice(1, -1).trim();
  }
  return current;
}

function enclosesWholeType(source: string): boolean {
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0 && index !== source.length - 1) return false;
    }
  }
  return depth === 0;
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
  env: Map<string, OwnershipBinding>,
  capabilities: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expectedType?: string,
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
  options: { recoverTypes: boolean } = { recoverTypes: false },
) {
  switch (expr.kind) {
    case "var": {
      checkProjection(expr.name, env, types, diagnostics);
      const binding = env.get(expr.name);
      if (
        expectedType && binding?.type && !runtimeValueTypeAssignable(expectedType, binding.type)
      ) {
        diagnostics.push(diagnosticAt(
          "type.literal_mismatch",
          `expected ${expectedType} but got ${binding.type}`,
          expr,
        ));
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
      const calleeName = expr.callee.kind === "var" ? expr.callee.name : undefined;
      if (calleeName !== undefined) {
        if (calleeName === "fork") {
          diagnostics.push(diagnosticAt(
            "function.unknown",
            "unknown function fork",
            expr.callee,
          ));
        }
        if (
          calleeName.startsWith("RangeIter.") &&
          !functions.some((fn) => fn.name === calleeName || fn.name.endsWith(`.${calleeName}`)) &&
          !capabilities.has(calleeName)
        ) {
          diagnostics.push(diagnosticAt(
            "function.unknown",
            `unknown function ${calleeName}`,
            expr.callee,
          ));
        }
        const capabilityEffects = capabilities.get(calleeName);
        if (capabilityEffects && !capabilityEffects.every((effect) => effects.includes(effect))) {
          diagnostics.push({
            code: "effect.pure_host_call",
            message: `capability ${calleeName} requires effects {${capabilityEffects.join(", ")}}`,
          });
        }
      }
      const fn = calleeName ? functions.find((fn) => fn.name === calleeName) : undefined;
      const calleeSignature = !fn && calleeName
        ? parseFnSignature(projectedBindingType(calleeName, env, types) ?? "")
        : undefined;
      for (let index = 0; index < expr.args.length; index++) {
        const arg = expr.args[index];
        const expected = fn?.params[index]?.type ?? calleeSignature?.params[index];
        checkExpr(
          arg,
          env,
          capabilities,
          effects,
          diagnostics,
          expected,
          types,
          functions,
          options,
        );
        const actual = exprBindingType(arg, env, types, functions, options.recoverTypes);
        if (expected && actual && !runtimeValueTypeAssignable(expected, actual)) {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `expected ${expected} but got ${actual}`,
            arg,
          ));
        }
      }
      return;
    }
    case "index":
      checkExpr(
        expr.target,
        env,
        capabilities,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      checkExpr(
        expr.index,
        env,
        capabilities,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      checkDirectIndex(expr, env, types, diagnostics);
      return;
    case "binary":
      if (expr.op === "==" || expr.op === "!=") {
        checkExpr(
          expr.left,
          env,
          capabilities,
          effects,
          diagnostics,
          undefined,
          types,
          functions,
          options,
        );
        const leftType = exprBindingType(expr.left, env, types, functions, options.recoverTypes);
        checkExpr(
          expr.right,
          env,
          capabilities,
          effects,
          diagnostics,
          leftType,
          types,
          functions,
          options,
        );
      } else {
        checkExpr(
          expr.left,
          env,
          capabilities,
          effects,
          diagnostics,
          numericExpectedType(expectedType),
          types,
          functions,
          options,
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
          options,
        );
      }
      return;
    case "pipe_bind": {
      checkExpr(
        expr.value,
        env,
        capabilities,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      if (expr.value.kind === "var") {
        const binding = env.get(expr.value.name);
        if (binding) binding.moved = true;
      }
      const scoped = new Map(env);
      scoped.set(expr.name, {
        moved: false,
        type: exprBindingType(expr.value, env, types, functions, options.recoverTypes),
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
        options,
      );
      return;
    }
    case "match":
      checkExpr(
        expr.value,
        env,
        capabilities,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      const matchValueType = exprBindingType(
        expr.value,
        env,
        types,
        functions,
        options.recoverTypes,
      );
      for (const arm of expr.arms) {
        const armEnv = new Map(env);
        bindMatchPatternLocals(arm.pattern, matchValueType, armEnv, diagnostics, types);
        checkExpr(
          arm.value,
          armEnv,
          capabilities,
          effects,
          diagnostics,
          expectedType,
          types,
          functions,
          options,
        );
      }
      return;
    case "shape":
      if (expr.slots.some((slot) => slot.spread)) {
        checkInlineArraySpreadLiteral(
          expr,
          env,
          capabilities,
          effects,
          diagnostics,
          expectedType,
          types,
          functions,
          options,
        );
        return;
      }
      for (const slot of expr.slots) {
        checkExpr(
          slot.value,
          env,
          capabilities,
          effects,
          diagnostics,
          options.recoverTypes ? expectedShapeSlotType(expectedType, slot.label, types) : undefined,
          types,
          functions,
          options,
        );
      }
      return;
    case "product_constructor":
      for (const slot of expr.slots) {
        if (slot.spread) {
          diagnostics.push(diagnosticAt(
            "collection.spread_product",
            "spread entries are only valid in unlabeled collection literals",
            slot,
          ));
        }
      }
      for (const slot of expr.slots) {
        checkExpr(
          slot.value,
          env,
          capabilities,
          effects,
          diagnostics,
          options.recoverTypes
            ? productConstructorSlotType(expr.constructor, slot.label, types)
            : undefined,
          types,
          functions,
          options,
        );
      }
      return;
    case "range":
      checkExpr(
        expr.start,
        env,
        capabilities,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      checkExpr(
        expr.end,
        env,
        capabilities,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      return;
    case "static_for_slots":
      checkExpr(
        expr.value,
        env,
        capabilities,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      return;
    case "field":
      checkExpr(
        expr.value,
        env,
        capabilities,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      checkExpr(
        expr.key,
        env,
        capabilities,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
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
        options,
      );
      return;
    case "literal":
      if (expectedType && literalTypeMembers(expectedType)) {
        if (literalExprFitsType(expr, expectedType)) {
          expr.inferredType = canonicalLiteralType(expectedType);
        } else {
          diagnostics.push(diagnosticAt(
            "type.literal_mismatch",
            `literal ${expr.value} is not assignable to ${expectedType}`,
            expr,
          ));
        }
      }
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
  return new Set();
}

function exprBindingType(
  expr: Expr,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
  recoverTypes = false,
): string | undefined {
  if (expr.kind === "var") return projectedBindingType(expr.name, env, types);
  if (expr.kind === "call") {
    const callee = expr.callee;
    if (callee.kind === "var") return functions.find((fn) => fn.name === callee.name)?.returnType;
  }
  if (expr.kind === "product_constructor") {
    const type = types.find((item) =>
      item.normalized?.kind === "product" && item.normalized.constructor === expr.constructor
    );
    return type?.name;
  }
  if (expr.kind === "pipe_bind") {
    return exprBindingType(expr.body, env, types, functions, recoverTypes);
  }
  if (expr.kind === "match") {
    const armTypes = expr.arms.map((arm) =>
      exprBindingType(arm.value, env, types, functions, recoverTypes)
    );
    const first = armTypes[0];
    if (first && armTypes.every((type) => type === first)) return first;
  }
  if (expr.kind === "range") return "range_i32";
  if (expr.kind === "literal") return expr.inferredType;
  if (recoverTypes) return recoveredExprType(expr, env, types, functions);
  return undefined;
}

function recoveredExprType(
  expr: Expr,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  functions: FnDecl[],
): string | undefined {
  const flatEnv = new Map([...env].map(([name, binding]) => [name, binding.type ?? ""] as const));
  for (const [name, type] of [...flatEnv]) {
    if (!type) flatEnv.delete(name);
  }
  const constructorTypes = new Map(
    types.flatMap((decl): [string, TypeDecl][] =>
      decl.normalized?.kind === "product" ? [[decl.normalized.constructor, decl]] : []
    ),
  );
  return inferRuntimeType(
    expr,
    flatEnv,
    new Map(functions.map((fn) => [fn.name, fn])),
    constructorTypes,
  );
}

function expectedShapeSlotType(
  expectedType: string | undefined,
  label: string | undefined,
  types: TypeDecl[],
): string | undefined {
  if (!label) return undefined;
  const resolved = resolveAliasType(expectedType, types);
  const decl = types.find((item) => item.name === typeNameOf(resolved ?? ""));
  if (decl?.normalized?.kind !== "product") return undefined;
  return decl.normalized.shape.slots.find((slot) => slot.label === label)?.type;
}

function checkInlineArraySpreadLiteral(
  expr: Extract<Expr, { kind: "shape" }>,
  env: Map<string, OwnershipBinding>,
  capabilities: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expectedType: string | undefined,
  types: TypeDecl[],
  functions: FnDecl[],
  options: { recoverTypes: boolean },
) {
  for (const slot of expr.slots) {
    if (slot.label) {
      diagnostics.push(diagnosticAt(
        "collection.spread_labeled",
        "spread entries are only valid in unlabeled collection literals",
        slot,
      ));
    }
  }
  const expected = inlineArrayLikeTypeArgs(expectedType, types);
  if (!expected) {
    diagnostics.push(diagnosticAt(
      "collection.expected_type",
      "collection spread literal requires an expected inline_array or inline_array_list type",
      expr,
    ));
  }
  const itemType = expected?.itemType;
  let itemCount = expr.slots.filter((slot) => !slot.spread).length;
  for (const slot of expr.slots) {
    if (slot.spread) {
      checkExpr(
        slot.value,
        env,
        capabilities,
        effects,
        diagnostics,
        undefined,
        types,
        functions,
        options,
      );
      const actual = inlineArrayLikeTypeArgs(
        exprBindingType(slot.value, env, types, functions, options.recoverTypes),
        types,
      );
      if (!actual || actual.kind !== "inline_array_list") {
        diagnostics.push(diagnosticAt(
          "collection.spread_tail_type",
          "spread tail must have inline_array_list type",
          slot,
        ));
      } else {
        itemCount += actual.count;
        if (itemType && !typeMatches(itemType, actual.itemType)) {
          diagnostics.push(diagnosticAt(
            "collection.spread_item_type",
            `spread tail item type ${actual.itemType} does not match expected ${itemType}`,
            slot,
          ));
        }
      }
    } else {
      checkExpr(
        slot.value,
        env,
        capabilities,
        effects,
        diagnostics,
        itemType,
        types,
        functions,
        options,
      );
    }
  }
  if (expected && Number.isFinite(expected.count) && itemCount !== expected.count) {
    diagnostics.push(diagnosticAt(
      "collection.spread_arity",
      `collection literal has ${itemCount} items but expected ${expected.count}`,
      expr,
    ));
  }
}

function inlineArrayLikeTypeArgs(
  type: string | undefined,
  types: TypeDecl[],
): { kind: "inline_array" | "inline_array_list"; count: number; itemType: string } | undefined {
  const resolved = resolveAliasType(type, types)?.trim();
  if (!resolved) return undefined;
  const shapeRepeat = resolved.match(/^\{\s*([0-9]+)\s*\*\s*(.+?)\s*\}$/);
  if (shapeRepeat) {
    return {
      kind: "inline_array",
      count: Number.parseInt(shapeRepeat[1], 10),
      itemType: shapeRepeat[2].trim(),
    };
  }
  const decl = findTypeDecl(types, typeNameOf(resolved));
  if (decl?.normalized?.kind === "product") {
    const slot = decl.normalized.shape.slots[0];
    if (decl.normalized.shape.slots.length === 1 && !slot.label && slot.repeat) {
      const args = typeCallArgsForBase(resolved, typeNameOf(resolved));
      const argValues = args === undefined ? [] : splitTypeArgs(args);
      const bindings = new Map(decl.params.map((param, index) => [param.name, argValues[index]]));
      const repeat = substituteSignatureTypeArgs(slot.repeat, bindings);
      const itemType = substituteSignatureTypeArgs(slot.type, bindings);
      const constructor = decl.normalized.constructor.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
      const typeName = terminalName(decl.name);
      return {
        kind: constructor.startsWith("InlineArrayList(") || typeName === "InlineArrayList"
          ? "inline_array_list"
          : "inline_array",
        count: Number.parseInt(repeat, 10),
        itemType,
      };
    }
  }
  const unqualified = resolved.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
  const base = unqualified.startsWith("InlineArrayList(")
    ? "InlineArrayList"
    : unqualified.startsWith("InlineArray(")
    ? "InlineArray"
    : undefined;
  if (!base || !unqualified.endsWith(")")) return undefined;
  const args = splitTypeArgs(unqualified.slice(`${base}(`.length, -1));
  const count = Number.parseInt(args[0]?.trim() ?? "", 10);
  const itemType = args[1]?.trim();
  if (!itemType) return undefined;
  return {
    kind: base === "InlineArrayList" ? "inline_array_list" : "inline_array",
    count,
    itemType,
  };
}

function compactArrayTypeArgs(
  type: string | undefined,
  types: TypeDecl[],
): { count: number; itemType: string } | undefined {
  const candidates = [type?.trim(), resolveAliasType(type, types)?.trim()].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    const unqualified = candidate.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)+/, "");
    if (!unqualified.startsWith("CompactArray(") || !unqualified.endsWith(")")) continue;
    const args = splitTypeArgs(unqualified.slice("CompactArray(".length, -1));
    const count = Number.parseInt(args[0]?.trim() ?? "", 10);
    const itemType = args[1]?.trim();
    if (Number.isFinite(count) && itemType) return { count, itemType };
  }
  return undefined;
}

function compactArrayMemberBase(type: string | undefined, types: TypeDecl[]): string | undefined {
  const candidates = [type?.trim(), resolveAliasType(type, types)?.trim()].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    const typeName = typeNameOf(candidate);
    if (terminalName(typeName) === "CompactArray") return typeName;
  }
  return undefined;
}

function productConstructorSlotType(
  constructor: string,
  label: string | undefined,
  types: TypeDecl[],
): string | undefined {
  if (!label) return undefined;
  const decl = types.find((item) =>
    item.normalized?.kind === "product" && item.normalized.constructor === constructor
  );
  return decl?.normalized?.kind === "product"
    ? decl.normalized.shape.slots.find((slot) => slot.label === label)?.type
    : undefined;
}

function projectedBindingType(
  name: string,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
): string | undefined {
  const [base, ...fields] = name.split(".");
  let current = env.get(base)?.type;
  for (const field of fields) {
    const resolved = resolveAliasType(stripReferenceType(current), types);
    const decl = findTypeDecl(types, typeNameOf(resolved ?? ""));
    if (decl?.normalized?.kind !== "product") return undefined;
    const args = typeCallArgsForBase(resolved ?? "", typeNameOf(resolved ?? ""));
    const argValues = args === undefined ? [] : splitTypeArgs(args);
    const bindings = new Map(decl.params.map((param, index) => [param.name, argValues[index]]));
    const slotType = decl.normalized.shape.slots.find((slot) => slot.label === field)?.type;
    current = slotType ? substituteSignatureTypeArgs(slotType, bindings) : undefined;
  }
  return current;
}

function isInlineArrayExprBuiltinWrapper(fn: FnDecl): boolean {
  const expr = fn.body.expr;
  return fn.body.statements.length === 0 &&
    expr?.kind === "call" &&
    expr.callee.kind === "var" &&
    isInlineArrayExprBuiltin(expr.callee.name);
}

function checkBlock(
  block: Extract<Expr, { kind: "block" }>,
  env: Map<string, OwnershipBinding>,
  capabilities: Map<string, string[]>,
  effects: string[],
  diagnostics: Diagnostic[],
  expectedType?: string,
  types: TypeDecl[] = [],
  functions: FnDecl[] = [],
  options: { recoverTypes: boolean } = { recoverTypes: false },
) {
  const ordered = orderBlockStatements(block.statements, diagnostics);
  for (const stmt of ordered) {
    checkStatement(stmt, env, capabilities, effects, diagnostics, types, functions, options);
  }
  if (block.expr) {
    checkExpr(
      block.expr,
      env,
      capabilities,
      effects,
      diagnostics,
      expectedType,
      types,
      functions,
      options,
    );
  }
}

function checkProjection(
  name: string,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  const match = name.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[[0-9]+\])+$/);
  if (!match) return;
  const baseType = env.get(match[1])?.type;
  const index = Number.parseInt(name.match(/\[([0-9]+)\]/)?.[1] ?? "", 10);
  const capacity = inlineArrayCapacity(stripFrozenType(baseType), types);
  if (capacity !== undefined && index >= capacity) {
    diagnostics.push({
      code: "index.out_of_bounds",
      message: `inline array index ${index} is out of bounds for capacity ${capacity}`,
    });
  }
}

function bindMatchPatternLocals(
  pattern: ParamPattern,
  valueType: string | undefined,
  env: Map<string, OwnershipBinding>,
  diagnostics: Diagnostic[],
  types: TypeDecl[],
) {
  const step = parseIterStepType(valueType);
  if (pattern.kind === "binding") {
    env.set(pattern.name, { moved: false, type: valueType });
    return;
  }
  if (pattern.kind === "tuple") {
    const slots = valueType ? runtimeSlotTypes(valueType, types) : [];
    for (let index = 0; index < pattern.items.length; index++) {
      bindPatternName(pattern.items[index], slots[index] ?? undefined, env, types);
    }
    return;
  }
  if (pattern.kind !== "constructor" || !step) return;
  if (pattern.name === "Done") {
    if (pattern.args.length) {
      diagnostics.push({
        code: "match.pattern_payload",
        message: "Done pattern does not bind payloads",
      });
    }
    return;
  }
  if (pattern.name !== "Yield") {
    diagnostics.push({
      code: "match.unknown_variant",
      message: `unknown step variant ${pattern.name}`,
    });
    return;
  }
  if (pattern.args.length !== 2) {
    diagnostics.push({
      code: "match.pattern_payload",
      message: "Yield pattern requires item and next binders",
    });
    return;
  }
  bindPatternName(pattern.args[0], step.item, env, types);
  bindPatternName(pattern.args[1], step.state, env, types);
}

function bindPatternName(
  pattern: ParamPattern,
  type: string | undefined,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
) {
  if (pattern.kind === "binding") {
    env.set(pattern.name, { moved: false, type });
  } else if (pattern.kind === "tuple" && type) {
    const slots = runtimeSlotTypes(type, types);
    for (let index = 0; index < pattern.items.length; index++) {
      bindPatternName(pattern.items[index], slots[index] ?? undefined, env, types);
    }
  }
}

function parseIterStepType(type: string | undefined): { state: string; item: string } | undefined {
  const args = typeCallArgsForBase(type?.trim() ?? "", "IterStep");
  if (!args) return undefined;
  const [state, item] = splitTypeArgs(args);
  return state && item ? { state: state.trim(), item: item.trim() } : undefined;
}

function checkDirectIndex(
  expr: Extract<Expr, { kind: "index" }>,
  env: Map<string, OwnershipBinding>,
  types: TypeDecl[],
  diagnostics: Diagnostic[],
) {
  if (expr.target.kind !== "var") return;
  const targetType = stripBorrowType(env.get(expr.target.name)?.type);
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
  const proof = indexType?.match(/^Index\((\d+)\)$/);
  if (proof && Number.parseInt(proof[1], 10) === capacity) return;
  if (indexType === undefined || indexType === "i32") return;
  diagnostics.push({
    code: "index.requires_proof",
    message: `direct inline-array indexing proof must match index(${capacity})`,
  });
}

function inlineArrayCapacity(type: string | undefined, types: TypeDecl[]): number | undefined {
  const resolved = resolveAliasType(type, types);
  const match = resolved?.match(/^InlineArray\((\d+),/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function resolveAliasType(type: string | undefined, types: TypeDecl[]): string | undefined {
  let current = type?.trim();
  const byName = new Map(types.map((decl) => [decl.name, decl]));
  const byTerminal = new Map(types.map((decl) => [terminalName(decl.name), decl]));
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const decl = byName.get(current) ?? byTerminal.get(terminalName(current));
    if (decl) {
      if (decl.normalized?.kind !== "alias") return current;
      current = decl.normalized.type;
      continue;
    }
    const callName = typeNameOf(current);
    const callDecl = byName.get(callName) ?? byTerminal.get(terminalName(callName));
    const callArgs = typeCallArgsForBase(current, callName);
    if (callDecl?.normalized?.kind === "alias" && callArgs !== undefined) {
      current = substituteAliasTypeParams(
        callDecl.normalized.type,
        callDecl,
        splitTypeArgs(callArgs),
      );
      continue;
    }
    return current;
  }
  return current;
}

function typeCallArgsForBase(type: string, baseName: string): string | undefined {
  const prefix = `${baseName}(`;
  if (!type.startsWith(prefix) || !type.endsWith(")")) return undefined;
  return type.slice(prefix.length, -1);
}

function substituteAliasTypeParams(type: string, decl: TypeDecl, args: string[]): string {
  let result = type;
  decl.params.forEach((param, index) => {
    const arg = args[index]?.trim();
    if (!arg) return;
    result = result.replace(new RegExp(`\\b${param.name}\\b`, "g"), arg);
  });
  return result;
}

function orderBlockStatements(statements: Statement[], diagnostics: Diagnostic[]): Statement[] {
  const owners = new Map<string, number>();
  let hasDuplicateInBinding = false;
  let hasShadowing = false;
  statements.forEach((stmt, index) => {
    const names = boundNames(stmt);
    const localNames = new Set<string>();
    for (const name of names) {
      if (localNames.has(name)) {
        diagnostics.push(diagnosticAt(
          "type.duplicate_local",
          `duplicate local binding ${name}`,
          spanForBoundName(stmt, name),
        ));
        hasDuplicateInBinding = true;
        continue;
      }
      localNames.add(name);
      if (owners.has(name)) {
        hasShadowing = true;
      } else {
        owners.set(name, index);
      }
    }
  });
  if (hasDuplicateInBinding || hasShadowing) return statements;

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

function spanForBoundName(stmt: Statement, name: string): { span?: Span; nameSpan?: Span } {
  if (stmt.kind === "let" || stmt.kind === "proof_const") return stmt;
  if (stmt.kind === "destructure_let") {
    return { span: stmt.nameSpans?.[name] ?? stmt.span };
  }
  return stmt;
}

function collectStatementRefs(stmt: Statement, refs: Set<string>) {
  if (stmt.kind === "let") collectExprRefs(stmt.value, refs, new Set());
  else if (stmt.kind === "destructure_let") collectExprRefs(stmt.value, refs, new Set());
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
