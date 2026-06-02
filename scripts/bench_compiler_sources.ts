import {
  compileArtifactsFromSource,
  createCompileCache,
  createFigHost,
  instantiateFig,
  type ModuleResolveContext,
  type ModuleSource,
} from "../src/mod.ts";
import { candidateModulePaths } from "../src/lsp/modules.ts";
import { parse } from "../src/parser.ts";
import { tokenize, type Token as SourceToken } from "../src/tokenize.ts";
import type {
  Expr,
  Param,
  ParamPattern,
  Program,
  Statement,
  TypeDecl,
  TypeExpr,
  TypeParam,
} from "../src/core_ast.ts";

type RuntimeName = "deno/js" | "deno/fig" | "go";
type FigWasmOptMode = "debug" | "release";

type Row = {
  runtime: RuntimeName;
  mode: string;
  loc: number;
  samples: number;
  median_ms: string;
  p90_ms: string;
};

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const samples = numberArg("--samples", 5);
const warmup = numberArg("--warmup", 1);
const figRunIters = numberArg("--fig-run-iters", 1);
const figWasmOpt = optModeArg("--fig-wasm-opt", "debug");
const progress = Deno.args.includes("--progress");
const selectedRuntimes = runtimeArgs();
const runRoot = await Deno.makeTempDir({ prefix: "fig-compiler-source-bench-" });
const rows: Row[] = [];
let figWasmSink = 0;

type FigCompilerInput = {
  sourceId: string;
  codes: number[];
  declarationCount: number;
  declarationKindCounts: DeclarationKindCounts;
  functionParamCount: number;
  typeParamCount: number;
  typeResultKindCounts: TypeResultKindCounts;
  typeSugarStatementCount: number;
  declarationSignatureHash: number;
  functionParamSignatureHash: number;
  typeParamSignatureHash: number;
  functionParamTypeSignatureHash: number;
  functionReturnSignatureHash: number;
  valueAnnotationSignatureHash: number;
  functionBodySignatureHash: number;
  typeBodySignatureHash: number;
  declaredTypeClassSignatureHash: number;
  declaredAbiClassSignatureHash: number;
  symbolEnvironmentSignatureHash: number;
  exportAbiSignatureHash: number;
  valueBodyTypeClassSignatureHash: number;
  valueBodyAbiClassSignatureHash: number;
  resolvedValueBodyTypeClassSignatureHash: number;
  resolvedValueBodyAbiClassSignatureHash: number;
  simpleBodyTypeCheckSignatureHash: number;
  namedTypeEnvironmentSignatureHash: number;
  resolvedDeclaredTypeClassSignatureHash: number;
  resolvedDeclaredAbiClassSignatureHash: number;
  resolvedSymbolEnvironmentSignatureHash: number;
  resolvedExportAbiSignatureHash: number;
  resolvedSimpleBodyTypeCheckSignatureHash: number;
  checkedDeclarationTypeSignatureHash: number;
  checkedDiagnosticSignatureHash: number;
  loweredDeclarationSignatureHash: number;
  checkedDeclarationRecordSignatureHash: number;
  checkedExpressionRecordSignatureHash: number;
  checkedExpressionChildRecordSignatureHash: number;
  checkedLocalEnvironmentSignatureHash: number;
  checkedExpressionShapeSignatureHash: number;
  loweredExportRecordSignatureHash: number;
  wasmFunctionRecordSignatureHash: number;
  wasmSectionRecordSignatureHash: number;
  wasmByteRecordSignatureHash: number;
  wasmByteBuffer: number[];
  functionLocalLetCount: number;
  functionLocalTypeAssertCount: number;
  valueMatchExpressionCount: number;
  functionMatchBodyCount: number;
  valueDoExpressionCount: number;
  valueDoBindCount: number;
  valueMatchArmCount: number;
  valuePipeBindCount: number;
  valueOperatorExpressionCount: number;
  valueOperatorSignatureHash: number;
  valueCallExpressionCount: number;
  sourceImportEdgeSignatureHash: number;
  sourceImportGraphDiagnosticSignatureHash: number;
  declarationDependencySignatureHash: number;
  declarationDependencyDiagnosticSignatureHash: number;
  directImportTypeEnvironmentInputs: FigDirectImportTypeEnvironmentInput[];
};

type FigDirectImportTypeEnvironmentInput = {
  sourceId: string;
  importSourceId: string;
  sourceCodes: number[];
  importCodes: number[];
  moduleHash: number;
  signatureHash: number;
  qualifiedResolvedDeclaredTypeClassSignatureHash: number;
  qualifiedResolvedDeclaredAbiClassSignatureHash: number;
  qualifiedResolvedValueBodyTypeClassSignatureHash: number;
  qualifiedResolvedValueBodyAbiClassSignatureHash: number;
  qualifiedResolvedSimpleBodyTypeCheckSignatureHash: number;
  qualifiedResolvedSymbolEnvironmentSignatureHash: number;
  qualifiedResolvedExportAbiSignatureHash: number;
  resolutionRecordSignatureHash: number;
};

type CheckedDeclarationRecordFact = {
  kindTag: number;
  nameHash: number;
  symbolTypeClass: number;
  symbolPayload: number;
  expectedTypeClass: number;
  actualTypeClass: number;
  checkStatus: number;
  diagnosticCode: number;
  loweredAbiClass: number;
};

type CheckedExpressionRecordFact = {
  kindTag: number;
  nameHash: number;
  rootKind: number;
  rootHash: number;
  rootChildCount: number;
  rootChildSignatureHash: number;
  rootGrandchildCount: number;
  rootGrandchildSignatureHash: number;
  rootDescendantCount: number;
  rootDescendantSignatureHash: number;
  rootTypeClass: number;
  resolvedTypeClass: number;
  expectedTypeClass: number;
  checkStatus: number;
  diagnosticCode: number;
  loweredValueTag: number;
  loweredValuePrimary: number;
  loweredValueSecondary: number;
};

type CheckedExpressionChildRecordFact = {
  parentKindTag: number;
  parentNameHash: number;
  childIndex: number;
  childRoleTag: number;
  childLabelHash: number;
  childRootKind: number;
  childRootHash: number;
  childRootTypeClass: number;
  childChildCount: number;
  childDescendantCount: number;
};

type CheckedLocalEnvironmentFact = {
  functionNameHash: number;
  localKindTag: number;
  localNameHash: number;
  valueRootKind: number;
  valueRootHash: number;
  expectedTypeClass: number;
  actualTypeClass: number;
  checkStatus: number;
  diagnosticCode: number;
};

type CheckedExpressionShapeFact = {
  kindTag: number;
  nameHash: number;
  rootKind: number;
  rootHash: number;
  rootSelectorCount: number;
  rootSlotCount: number;
  rootCallArgCount: number;
  rootFieldCount: number;
  rootOperatorCount: number;
  operatorCount: number;
  operatorSignatureHash: number;
  matchCount: number;
  matchArmCount: number;
  doCount: number;
  doBindCount: number;
  pipeBindCount: number;
  callCount: number;
  functionMatchBodyCount: number;
  nameTokenCount: number;
  nameTokenSignatureHash: number;
  literalTokenCount: number;
  literalTokenSignatureHash: number;
  diagnosticCode: number;
};

type LoweredExportRecordFact = {
  nameHash: number;
  paramCount: number;
  returnAbiClass: number;
};

type WasmFunctionRecordFact = {
  nameHash: number;
  exportTag: number;
  runtimeParamCount: number;
  localCount: number;
  resultValType: number;
  bodyOpcode: number;
  bodyImmediate: number;
  terminatorOpcode: number;
  bodySize: number;
  diagnosticCode: number;
};

type WasmSectionRecordFact = {
  sectionId: number;
  itemCount: number;
  payloadSize: number;
  payloadSignature: number;
  diagnosticSignature: number;
};

type WasmByteSectionRecordFact = {
  sectionId: number;
  payloadSize: number;
  payloadLebSize: number;
  sectionSize: number;
  headerSignature: number;
  payloadSignature: number;
  diagnosticSignature: number;
};

type WasmByteModuleRecordFact = {
  magicSignature: number;
  versionSignature: number;
  sectionCount: number;
  byteSize: number;
  sectionSignature: number;
  diagnosticSignature: number;
};

type WasmSectionScan = {
  functionCount: number;
  exportCount: number;
  typePayloadSize: number;
  typePayloadSignature: number;
  functionPayloadSize: number;
  functionPayloadSignature: number;
  exportPayloadSize: number;
  exportPayloadSignature: number;
  codePayloadSize: number;
  codePayloadSignature: number;
  diagnosticSignature: number;
};

type DeclarationKindCounts = {
  functions: number;
  lets: number;
  consts: number;
  types: number;
  sourceImports: number;
};

type TypeResultKindCounts = {
  types: number;
  structs: number;
  unions: number;
};

const declarationKindChecks: {
  label: string;
  tag: number;
  key: keyof DeclarationKindCounts;
}[] = [
  { label: "functions", tag: 1, key: "functions" },
  { label: "lets", tag: 2, key: "lets" },
  { label: "consts", tag: 3, key: "consts" },
  { label: "types", tag: 4, key: "types" },
  { label: "source imports", tag: 5, key: "sourceImports" },
];

const typeResultKindChecks: {
  label: string;
  tag: number;
  key: keyof TypeResultKindCounts;
}[] = [
  { label: "type", tag: 1, key: "types" },
  { label: "struct", tag: 2, key: "structs" },
  { label: "union", tag: 3, key: "unions" },
];

const figCompilerSources = await readFigSourceRoots([`${root}/compiler/fig`]);
const figSources = new Map(figCompilerSources);
await readFigSources(`${root}/prelude`, figSources);
const figRoot = `${root}/compiler/fig/main.fig`;
const goRoot = `${root}/compiler/go`;

if (shouldRun("deno/js")) {
  const source = figSources.get(figRoot);
  if (!source) throw new Error(`missing ${figRoot}`);
  rows.push({
    runtime: "deno/js",
    mode: "compile_fig_artifacts",
    loc: sourceLocFromTexts(figSources.values()),
    samples,
    ...(await timedRow(() => figCompile(source, figRoot))),
  });
}

if (shouldRun("deno/fig")) {
  const source = figSources.get(figRoot);
  if (!source) throw new Error(`missing ${figRoot}`);
  const loc = sourceLocFromTexts(figCompilerSources.values());
  try {
    const runCompiledCompiler = await compiledFigSourceRunner(source, figRoot);
    rows.push({
      runtime: "deno/fig",
      mode: `compiled_${figWasmOpt}_source_tree_${figRunIters}x`,
      loc,
      samples,
      ...(await timedRow((index) => runCompiledCompiler(index))),
    });
  } catch (error) {
    rows.push({
      runtime: "deno/fig",
      mode: unavailableMode("compiled_source_tree_unavailable", error),
      loc,
      samples: 0,
      median_ms: "n/a",
      p90_ms: "n/a",
    });
  }
}

if (shouldRun("go")) {
  rows.push({
    runtime: "go",
    mode: "go_build",
    loc: await sourceLoc(await goSourceFiles(goRoot)),
    samples,
    ...(await timedRow((index) => goBuild(goRoot, index))),
  });
}

console.log(
  `run_root=${runRoot} samples=${samples} warmup=${warmup} runtimes=${
    selectedRuntimes ? selectedRuntimes.join(",") : "all"
  }`,
);
console.table(rows);

async function timedRow(
  run: (index: number) => Promise<void>,
): Promise<{ median_ms: string; p90_ms: string }> {
  for (let index = 0; index < warmup; index++) {
    await run(index);
  }
  const values: number[] = [];
  for (let index = 0; index < samples; index++) {
    const start = performance.now();
    await run(warmup + index);
    values.push(performance.now() - start);
  }
  return {
    median_ms: median(values).toFixed(3),
    p90_ms: p90(values).toFixed(3),
  };
}

function firstNumberArrayMismatch(left: number[], right: number[]): number | undefined {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index++) {
    if (left[index] !== right[index]) return index;
  }
  if (left.length !== right.length) return limit;
  return undefined;
}

function byteWindow(values: number[], index: number): string {
  const start = Math.max(0, index - 8);
  const end = Math.min(values.length, index + 9);
  const items: number[] = [];
  for (let cursor = start; cursor < end; cursor++) {
    items.push(values[cursor] ?? -1);
  }
  return `[${items.join(", ")}] len=${values.length}`;
}

async function figCompile(source: string, sourceId: string): Promise<void> {
  await compileArtifactsFromSource(source, {
    sourceId,
    resolveModule,
    cache: createCompileCache(),
    includeWat: false,
    pruneImports: true,
    optMode: "debug",
  });
}

async function compiledFigSourceRunner(
  source: string,
  sourceId: string,
): Promise<(index: number) => Promise<void>> {
  const artifact = await compileArtifactsFromSource(source, {
    sourceId,
    resolveModule,
    cache: createCompileCache(),
    includeWat: false,
    pruneImports: true,
    optMode: figWasmOpt,
  });
  const fig = await instantiateFig(artifact.wasm);
  const host = createFigHost(fig.abi, fig.instance);
  const call = host.call.bind(host);
  host.call = (name, ...args) => {
    if (progress) {
      console.error(`[fig-call] ${name}`);
    }
    const result = call(name, ...args);
    if (progress) {
      console.error(`[fig-done] ${name}`);
    }
    return result;
  };
  const encodedSources = await figCompilerInputs();
  for (const input of encodedSources) {
    if (progress) {
      console.error(`[fig-input] ${input.sourceId}`);
    }
    for (const importInput of input.directImportTypeEnvironmentInputs) {
      if (progress) {
        console.error(`[fig-import] ${importInput.sourceId} -> ${importInput.importSourceId}`);
      }
      const actualDirectImportTypeEnvironmentSignatureHash = Number(
        host.call(
          "compile_direct_import_type_environment_signature_hash",
          importInput.sourceCodes,
          importInput.importCodes,
          importInput.moduleHash,
        ),
      );
      const directImportTypeEnvironmentSignatureMatches =
        actualDirectImportTypeEnvironmentSignatureHash === importInput.signatureHash;
      if (!directImportTypeEnvironmentSignatureMatches) {
        throw new Error(
          `compiled Fig compiler produced direct import type-environment signature hash ` +
            `${actualDirectImportTypeEnvironmentSignatureHash} for ${importInput.sourceId} ` +
            `importing ${importInput.importSourceId}; ` +
            `JS parser produced ${importInput.signatureHash}`,
        );
      }
      const actualQualifiedResolvedDeclaredTypeClassSignatureHash = Number(
        host.call(
          "compile_direct_import_resolved_declared_type_class_signature_hash",
          importInput.sourceCodes,
          importInput.importCodes,
          importInput.moduleHash,
        ),
      );
      const qualifiedResolvedDeclaredTypeClassSignatureMatches =
        actualQualifiedResolvedDeclaredTypeClassSignatureHash ===
          importInput.qualifiedResolvedDeclaredTypeClassSignatureHash;
      if (!qualifiedResolvedDeclaredTypeClassSignatureMatches) {
        throw new Error(
          `compiled Fig compiler produced direct import resolved declared ` +
            `type-class signature hash ${actualQualifiedResolvedDeclaredTypeClassSignatureHash} ` +
            `for ${importInput.sourceId} importing ${importInput.importSourceId}; ` +
            `JS parser produced ${importInput.qualifiedResolvedDeclaredTypeClassSignatureHash}`,
        );
      }
      const actualQualifiedResolvedDeclaredAbiClassSignatureHash = Number(
        host.call(
          "compile_direct_import_resolved_declared_abi_class_signature_hash",
          importInput.sourceCodes,
          importInput.importCodes,
          importInput.moduleHash,
        ),
      );
      const qualifiedResolvedDeclaredAbiClassSignatureMatches =
        actualQualifiedResolvedDeclaredAbiClassSignatureHash ===
          importInput.qualifiedResolvedDeclaredAbiClassSignatureHash;
      if (!qualifiedResolvedDeclaredAbiClassSignatureMatches) {
        throw new Error(
          `compiled Fig compiler produced direct import resolved declared ` +
            `ABI-class signature hash ${actualQualifiedResolvedDeclaredAbiClassSignatureHash} ` +
            `for ${importInput.sourceId} importing ${importInput.importSourceId}; ` +
            `JS parser produced ${importInput.qualifiedResolvedDeclaredAbiClassSignatureHash}`,
        );
      }
      const actualQualifiedResolvedValueBodyTypeClassSignatureHash = Number(
        host.call(
          "compile_direct_import_resolved_value_body_type_class_signature_hash",
          importInput.sourceCodes,
          importInput.importCodes,
          importInput.moduleHash,
        ),
      );
      const qualifiedResolvedValueBodyTypeClassSignatureMatches =
        actualQualifiedResolvedValueBodyTypeClassSignatureHash ===
          importInput.qualifiedResolvedValueBodyTypeClassSignatureHash;
      if (!qualifiedResolvedValueBodyTypeClassSignatureMatches) {
        throw new Error(
          `compiled Fig compiler produced direct import resolved value-body ` +
            `type-class signature hash ${actualQualifiedResolvedValueBodyTypeClassSignatureHash} ` +
            `for ${importInput.sourceId} importing ${importInput.importSourceId}; ` +
            `JS parser produced ${importInput.qualifiedResolvedValueBodyTypeClassSignatureHash}`,
        );
      }
      const actualQualifiedResolvedValueBodyAbiClassSignatureHash = Number(
        host.call(
          "compile_direct_import_resolved_value_body_abi_class_signature_hash",
          importInput.sourceCodes,
          importInput.importCodes,
          importInput.moduleHash,
        ),
      );
      const qualifiedResolvedValueBodyAbiClassSignatureMatches =
        actualQualifiedResolvedValueBodyAbiClassSignatureHash ===
          importInput.qualifiedResolvedValueBodyAbiClassSignatureHash;
      if (!qualifiedResolvedValueBodyAbiClassSignatureMatches) {
        throw new Error(
          `compiled Fig compiler produced direct import resolved value-body ` +
            `ABI-class signature hash ${actualQualifiedResolvedValueBodyAbiClassSignatureHash} ` +
            `for ${importInput.sourceId} importing ${importInput.importSourceId}; ` +
            `JS parser produced ${importInput.qualifiedResolvedValueBodyAbiClassSignatureHash}`,
        );
      }
      const actualQualifiedResolvedSimpleBodyTypeCheckSignatureHash = Number(
        host.call(
          "compile_direct_import_resolved_simple_body_type_check_signature_hash",
          importInput.sourceCodes,
          importInput.importCodes,
          importInput.moduleHash,
        ),
      );
      const qualifiedResolvedSimpleBodyTypeCheckSignatureMatches =
        actualQualifiedResolvedSimpleBodyTypeCheckSignatureHash ===
          importInput.qualifiedResolvedSimpleBodyTypeCheckSignatureHash;
      if (!qualifiedResolvedSimpleBodyTypeCheckSignatureMatches) {
        throw new Error(
          `compiled Fig compiler produced direct import resolved simple body ` +
            `type-check signature hash ` +
            `${actualQualifiedResolvedSimpleBodyTypeCheckSignatureHash} ` +
            `for ${importInput.sourceId} importing ${importInput.importSourceId}; ` +
            `JS parser produced ${importInput.qualifiedResolvedSimpleBodyTypeCheckSignatureHash}`,
        );
      }
      const actualQualifiedResolvedSymbolEnvironmentSignatureHash = Number(
        host.call(
          "compile_direct_import_resolved_symbol_environment_signature_hash",
          importInput.sourceCodes,
          importInput.importCodes,
          importInput.moduleHash,
        ),
      );
      const qualifiedResolvedSymbolEnvironmentSignatureMatches =
        actualQualifiedResolvedSymbolEnvironmentSignatureHash ===
          importInput.qualifiedResolvedSymbolEnvironmentSignatureHash;
      if (!qualifiedResolvedSymbolEnvironmentSignatureMatches) {
        throw new Error(
          `compiled Fig compiler produced direct import resolved symbol ` +
            `environment signature hash ` +
            `${actualQualifiedResolvedSymbolEnvironmentSignatureHash} ` +
            `for ${importInput.sourceId} importing ${importInput.importSourceId}; ` +
            `JS parser produced ${importInput.qualifiedResolvedSymbolEnvironmentSignatureHash}`,
        );
      }
      const actualQualifiedResolvedExportAbiSignatureHash = Number(
        host.call(
          "compile_direct_import_resolved_export_abi_signature_hash",
          importInput.sourceCodes,
          importInput.importCodes,
          importInput.moduleHash,
        ),
      );
      const qualifiedResolvedExportAbiSignatureMatches =
        actualQualifiedResolvedExportAbiSignatureHash ===
          importInput.qualifiedResolvedExportAbiSignatureHash;
      if (!qualifiedResolvedExportAbiSignatureMatches) {
        throw new Error(
          `compiled Fig compiler produced direct import resolved export ` +
            `ABI signature hash ${actualQualifiedResolvedExportAbiSignatureHash} ` +
            `for ${importInput.sourceId} importing ${importInput.importSourceId}; ` +
            `JS parser produced ${importInput.qualifiedResolvedExportAbiSignatureHash}`,
        );
      }
      const actualDirectImportResolutionRecordSignatureHash = Number(
        host.call(
          "compile_direct_import_resolution_record_signature_hash",
          importInput.sourceCodes,
          importInput.importCodes,
          importInput.moduleHash,
        ),
      );
      const directImportResolutionRecordSignatureMatches =
        actualDirectImportResolutionRecordSignatureHash ===
          importInput.resolutionRecordSignatureHash;
      if (!directImportResolutionRecordSignatureMatches) {
        throw new Error(
          `compiled Fig compiler produced direct import resolution-record ` +
            `signature hash ${actualDirectImportResolutionRecordSignatureHash} ` +
            `for ${importInput.sourceId} importing ${importInput.importSourceId}; ` +
            `JS parser produced ${importInput.resolutionRecordSignatureHash}`,
        );
      }
    }
    const actualSourceImportEdgeSignatureHash = Number(
      host.call("compile_source_import_edge_signature_hash", input.codes),
    );
    const sourceImportEdgeSignatureMatches =
      actualSourceImportEdgeSignatureHash === input.sourceImportEdgeSignatureHash;
    if (!sourceImportEdgeSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced source import-edge signature hash ` +
          `${actualSourceImportEdgeSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.sourceImportEdgeSignatureHash}`,
      );
    }
    const actualSourceImportGraphDiagnosticSignatureHash = Number(
      host.call("compile_source_import_graph_diagnostic_signature_hash", input.codes),
    );
    const sourceImportGraphDiagnosticSignatureMatches =
      actualSourceImportGraphDiagnosticSignatureHash ===
        input.sourceImportGraphDiagnosticSignatureHash;
    if (!sourceImportGraphDiagnosticSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced source import graph-diagnostic signature hash ` +
          `${actualSourceImportGraphDiagnosticSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.sourceImportGraphDiagnosticSignatureHash}`,
      );
    }
    const actualDeclarationDependencySignatureHash = Number(
      host.call("compile_declaration_dependency_signature_hash", input.codes),
    );
    const declarationDependencySignatureMatches =
      actualDeclarationDependencySignatureHash === input.declarationDependencySignatureHash;
    if (!declarationDependencySignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced declaration dependency signature hash ` +
          `${actualDeclarationDependencySignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.declarationDependencySignatureHash}`,
      );
    }
    const actualDeclarationDependencyDiagnosticSignatureHash = Number(
      host.call("compile_declaration_dependency_diagnostic_signature_hash", input.codes),
    );
    const declarationDependencyDiagnosticSignatureMatches =
      actualDeclarationDependencyDiagnosticSignatureHash ===
        input.declarationDependencyDiagnosticSignatureHash;
    if (!declarationDependencyDiagnosticSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced declaration dependency diagnostic ` +
          `signature hash ${actualDeclarationDependencyDiagnosticSignatureHash} ` +
          `for ${input.sourceId}; JS parser produced ` +
          `${input.declarationDependencyDiagnosticSignatureHash}`,
      );
    }
    const actualCount = Number(host.call("compile_code_count", input.codes));
    const countMatches = actualCount === input.declarationCount;
    if (!countMatches) {
      throw new Error(
        `compiled Fig compiler parsed ${actualCount} declarations in ${input.sourceId}; ` +
          `JS parser parsed ${input.declarationCount}`,
      );
    }
    for (const check of declarationKindChecks) {
      const actualKindCount = Number(
        host.call("compile_declaration_kind_count", input.codes, check.tag),
      );
      const expectedKindCount = input.declarationKindCounts[check.key];
      const kindCountMatches = actualKindCount === expectedKindCount;
      if (!kindCountMatches) {
        throw new Error(
          `compiled Fig compiler parsed ${actualKindCount} ${check.label} in ${input.sourceId}; ` +
            `JS parser parsed ${expectedKindCount}`,
        );
      }
    }
    const actualParamCount = Number(host.call("compile_function_param_count", input.codes));
    const paramCountMatches = actualParamCount === input.functionParamCount;
    if (!paramCountMatches) {
      throw new Error(
        `compiled Fig compiler parsed ${actualParamCount} function params in ${input.sourceId}; ` +
          `JS parser parsed ${input.functionParamCount}`,
      );
    }
    const actualTypeParamCount = Number(host.call("compile_type_param_count", input.codes));
    const typeParamCountMatches = actualTypeParamCount === input.typeParamCount;
    if (!typeParamCountMatches) {
      throw new Error(
        `compiled Fig compiler parsed ${actualTypeParamCount} type params in ${input.sourceId}; ` +
          `JS parser parsed ${input.typeParamCount}`,
      );
    }
    for (const check of typeResultKindChecks) {
      const actualResultKindCount = Number(
        host.call("compile_type_result_kind_count", input.codes, check.tag),
      );
      const expectedResultKindCount = input.typeResultKindCounts[check.key];
      const resultKindCountMatches = actualResultKindCount === expectedResultKindCount;
      if (!resultKindCountMatches) {
        throw new Error(
          `compiled Fig compiler counted ${actualResultKindCount} ${check.label} ` +
            `type result kinds in ${input.sourceId}; ` +
            `JS parser counted ${expectedResultKindCount}`,
        );
      }
    }
    const actualTypeSugarStatementCount = Number(
      host.call("compile_type_sugar_statement_count", input.codes),
    );
    const typeSugarStatementCountMatches =
      actualTypeSugarStatementCount === input.typeSugarStatementCount;
    if (!typeSugarStatementCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualTypeSugarStatementCount} ` +
          `type-sugar lowered statements in ${input.sourceId}; ` +
          `JS parser counted ${input.typeSugarStatementCount}`,
      );
    }
    const actualSignatureHash = Number(
      host.call("compile_declaration_signature_hash", input.codes),
    );
    const signatureHashMatches = actualSignatureHash === input.declarationSignatureHash;
    if (!signatureHashMatches) {
      throw new Error(
        `compiled Fig compiler produced declaration signature hash ${actualSignatureHash} ` +
          `for ${input.sourceId}; JS parser produced ${input.declarationSignatureHash}`,
      );
    }
    const actualFunctionParamSignatureHash = Number(
      host.call("compile_function_param_signature_hash", input.codes),
    );
    const functionParamSignatureMatches =
      actualFunctionParamSignatureHash === input.functionParamSignatureHash;
    if (!functionParamSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced function parameter signature hash ` +
          `${actualFunctionParamSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.functionParamSignatureHash}`,
      );
    }
    const actualTypeParamSignatureHash = Number(
      host.call("compile_type_param_signature_hash", input.codes),
    );
    const typeParamSignatureMatches = actualTypeParamSignatureHash === input.typeParamSignatureHash;
    if (!typeParamSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced type parameter signature hash ` +
          `${actualTypeParamSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.typeParamSignatureHash}`,
      );
    }
    const actualFunctionParamTypeSignatureHash = Number(
      host.call("compile_function_param_type_signature_hash", input.codes),
    );
    const functionParamTypeSignatureMatches =
      actualFunctionParamTypeSignatureHash === input.functionParamTypeSignatureHash;
    if (!functionParamTypeSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced function parameter type signature hash ` +
          `${actualFunctionParamTypeSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.functionParamTypeSignatureHash}`,
      );
    }
    const actualFunctionReturnSignatureHash = Number(
      host.call("compile_function_return_signature_hash", input.codes),
    );
    const functionReturnSignatureMatches =
      actualFunctionReturnSignatureHash === input.functionReturnSignatureHash;
    if (!functionReturnSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced function return signature hash ` +
          `${actualFunctionReturnSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.functionReturnSignatureHash}`,
      );
    }
    const actualValueAnnotationSignatureHash = Number(
      host.call("compile_value_annotation_signature_hash", input.codes),
    );
    const valueAnnotationSignatureMatches =
      actualValueAnnotationSignatureHash === input.valueAnnotationSignatureHash;
    if (!valueAnnotationSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced value annotation signature hash ` +
          `${actualValueAnnotationSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.valueAnnotationSignatureHash}`,
      );
    }
    const actualFunctionBodySignatureHash = Number(
      host.call("compile_function_body_signature_hash", input.codes),
    );
    const functionBodySignatureMatches =
      actualFunctionBodySignatureHash === input.functionBodySignatureHash;
    if (!functionBodySignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced function body signature hash ` +
          `${actualFunctionBodySignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.functionBodySignatureHash}`,
      );
    }
    const actualTypeBodySignatureHash = Number(
      host.call("compile_type_body_signature_hash", input.codes),
    );
    const typeBodySignatureMatches = actualTypeBodySignatureHash === input.typeBodySignatureHash;
    if (!typeBodySignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced type body signature hash ` +
          `${actualTypeBodySignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.typeBodySignatureHash}`,
      );
    }
    const actualFunctionLocalLetCount = Number(
      host.call("compile_function_local_let_count", input.codes),
    );
    const functionLocalLetCountMatches =
      actualFunctionLocalLetCount === input.functionLocalLetCount;
    if (!functionLocalLetCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualFunctionLocalLetCount} top-level ` +
          `function local let statements in ${input.sourceId}; ` +
          `JS parser counted ${input.functionLocalLetCount}`,
      );
    }
    const actualFunctionLocalTypeAssertCount = Number(
      host.call("compile_function_local_type_assert_count", input.codes),
    );
    const functionLocalTypeAssertCountMatches =
      actualFunctionLocalTypeAssertCount === input.functionLocalTypeAssertCount;
    if (!functionLocalTypeAssertCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualFunctionLocalTypeAssertCount} top-level ` +
        `function local type assertion statements in ${input.sourceId}; ` +
          `JS parser counted ${input.functionLocalTypeAssertCount}`,
      );
    }
    const actualValueMatchExpressionCount = Number(
      host.call("compile_value_match_expression_count", input.codes),
    );
    const valueMatchExpressionCountMatches =
      actualValueMatchExpressionCount === input.valueMatchExpressionCount;
    if (!valueMatchExpressionCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualValueMatchExpressionCount} ` +
          `value match expressions in ${input.sourceId}; ` +
          `JS parser counted ${input.valueMatchExpressionCount}`,
      );
    }
    const actualFunctionMatchBodyCount = Number(
      host.call("compile_function_match_body_count", input.codes),
    );
    const functionMatchBodyCountMatches =
      actualFunctionMatchBodyCount === input.functionMatchBodyCount;
    if (!functionMatchBodyCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualFunctionMatchBodyCount} ` +
          `function match bodies in ${input.sourceId}; ` +
          `JS parser counted ${input.functionMatchBodyCount}`,
      );
    }
    const actualValueDoExpressionCount = Number(
      host.call("compile_value_do_expression_count", input.codes),
    );
    const valueDoExpressionCountMatches =
      actualValueDoExpressionCount === input.valueDoExpressionCount;
    if (!valueDoExpressionCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualValueDoExpressionCount} ` +
          `value do expressions in ${input.sourceId}; ` +
          `JS parser counted ${input.valueDoExpressionCount}`,
      );
    }
    const actualValueDoBindCount = Number(
      host.call("compile_value_do_bind_count", input.codes),
    );
    const valueDoBindCountMatches = actualValueDoBindCount === input.valueDoBindCount;
    if (!valueDoBindCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualValueDoBindCount} ` +
          `value do binds in ${input.sourceId}; ` +
          `JS parser counted ${input.valueDoBindCount}`,
      );
    }
    const actualValueMatchArmCount = Number(
      host.call("compile_value_match_arm_count", input.codes),
    );
    const valueMatchArmCountMatches =
      actualValueMatchArmCount === input.valueMatchArmCount;
    if (!valueMatchArmCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualValueMatchArmCount} ` +
          `value match arms in ${input.sourceId}; ` +
          `JS parser counted ${input.valueMatchArmCount}`,
      );
    }
    const actualValuePipeBindCount = Number(
      host.call("compile_value_pipe_bind_count", input.codes),
    );
    const valuePipeBindCountMatches =
      actualValuePipeBindCount === input.valuePipeBindCount;
    if (!valuePipeBindCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualValuePipeBindCount} ` +
          `value pipe-bind expressions in ${input.sourceId}; ` +
          `JS parser counted ${input.valuePipeBindCount}`,
      );
    }
    const actualValueOperatorExpressionCount = Number(
      host.call("compile_value_operator_expression_count", input.codes),
    );
    const valueOperatorExpressionCountMatches =
      actualValueOperatorExpressionCount === input.valueOperatorExpressionCount;
    if (!valueOperatorExpressionCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualValueOperatorExpressionCount} ` +
          `value operator links in ${input.sourceId}; ` +
          `JS parser counted ${input.valueOperatorExpressionCount}`,
      );
    }
    const actualValueOperatorSignatureHash = Number(
      host.call("compile_value_operator_signature_hash", input.codes),
    );
    const valueOperatorSignatureHashMatches =
      actualValueOperatorSignatureHash === input.valueOperatorSignatureHash;
    if (!valueOperatorSignatureHashMatches) {
      throw new Error(
        `compiled Fig compiler produced value operator signature hash ` +
          `${actualValueOperatorSignatureHash} in ${input.sourceId}; ` +
          `JS parser produced ${input.valueOperatorSignatureHash}`,
      );
    }
    const actualValueCallExpressionCount = Number(
      host.call("compile_value_call_expression_count", input.codes),
    );
    const valueCallExpressionCountMatches =
      actualValueCallExpressionCount === input.valueCallExpressionCount;
    if (!valueCallExpressionCountMatches) {
      throw new Error(
        `compiled Fig compiler counted ${actualValueCallExpressionCount} ` +
          `value call expressions in ${input.sourceId}; ` +
          `JS parser counted ${input.valueCallExpressionCount}`,
      );
    }
    const actualDeclaredTypeClassSignatureHash = Number(
      host.call("compile_declared_type_class_signature_hash", input.codes),
    );
    const declaredTypeClassSignatureMatches =
      actualDeclaredTypeClassSignatureHash === input.declaredTypeClassSignatureHash;
    if (!declaredTypeClassSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced declared type class signature hash ` +
          `${actualDeclaredTypeClassSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.declaredTypeClassSignatureHash}`,
      );
    }
    const actualDeclaredAbiClassSignatureHash = Number(
      host.call("compile_declared_abi_class_signature_hash", input.codes),
    );
    const declaredAbiClassSignatureMatches =
      actualDeclaredAbiClassSignatureHash === input.declaredAbiClassSignatureHash;
    if (!declaredAbiClassSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced declared ABI class signature hash ` +
          `${actualDeclaredAbiClassSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.declaredAbiClassSignatureHash}`,
      );
    }
    const actualSymbolEnvironmentSignatureHash = Number(
      host.call("compile_symbol_environment_signature_hash", input.codes),
    );
    const symbolEnvironmentSignatureMatches =
      actualSymbolEnvironmentSignatureHash === input.symbolEnvironmentSignatureHash;
    if (!symbolEnvironmentSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced symbol environment signature hash ` +
          `${actualSymbolEnvironmentSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.symbolEnvironmentSignatureHash}`,
      );
    }
    const actualExportAbiSignatureHash = Number(
      host.call("compile_export_abi_signature_hash", input.codes),
    );
    const exportAbiSignatureMatches =
      actualExportAbiSignatureHash === input.exportAbiSignatureHash;
    if (!exportAbiSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced export ABI signature hash ` +
          `${actualExportAbiSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.exportAbiSignatureHash}`,
      );
    }
    const actualValueBodyTypeClassSignatureHash = Number(
      host.call("compile_value_body_type_class_signature_hash", input.codes),
    );
    const valueBodyTypeClassSignatureMatches =
      actualValueBodyTypeClassSignatureHash === input.valueBodyTypeClassSignatureHash;
    if (!valueBodyTypeClassSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced value body type-class signature hash ` +
          `${actualValueBodyTypeClassSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.valueBodyTypeClassSignatureHash}`,
      );
    }
    const actualValueBodyAbiClassSignatureHash = Number(
      host.call("compile_value_body_abi_class_signature_hash", input.codes),
    );
    const valueBodyAbiClassSignatureMatches =
      actualValueBodyAbiClassSignatureHash === input.valueBodyAbiClassSignatureHash;
    if (!valueBodyAbiClassSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced value body ABI-class signature hash ` +
          `${actualValueBodyAbiClassSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.valueBodyAbiClassSignatureHash}`,
      );
    }
    const actualResolvedValueBodyTypeClassSignatureHash = Number(
      host.call("compile_resolved_value_body_type_class_signature_hash", input.codes),
    );
    const resolvedValueBodyTypeClassSignatureMatches =
      actualResolvedValueBodyTypeClassSignatureHash ===
        input.resolvedValueBodyTypeClassSignatureHash;
    if (!resolvedValueBodyTypeClassSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced resolved value body type-class signature hash ` +
          `${actualResolvedValueBodyTypeClassSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.resolvedValueBodyTypeClassSignatureHash}`,
      );
    }
    const actualResolvedValueBodyAbiClassSignatureHash = Number(
      host.call("compile_resolved_value_body_abi_class_signature_hash", input.codes),
    );
    const resolvedValueBodyAbiClassSignatureMatches =
      actualResolvedValueBodyAbiClassSignatureHash ===
        input.resolvedValueBodyAbiClassSignatureHash;
    if (!resolvedValueBodyAbiClassSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced resolved value body ABI-class signature hash ` +
          `${actualResolvedValueBodyAbiClassSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.resolvedValueBodyAbiClassSignatureHash}`,
      );
    }
    const actualSimpleBodyTypeCheckSignatureHash = Number(
      host.call("compile_simple_body_type_check_signature_hash", input.codes),
    );
    const simpleBodyTypeCheckSignatureMatches =
      actualSimpleBodyTypeCheckSignatureHash === input.simpleBodyTypeCheckSignatureHash;
    if (!simpleBodyTypeCheckSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced simple body type-check signature hash ` +
          `${actualSimpleBodyTypeCheckSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.simpleBodyTypeCheckSignatureHash}`,
      );
    }
    const actualNamedTypeEnvironmentSignatureHash = Number(
      host.call("compile_named_type_environment_signature_hash", input.codes),
    );
    const namedTypeEnvironmentSignatureMatches =
      actualNamedTypeEnvironmentSignatureHash === input.namedTypeEnvironmentSignatureHash;
    if (!namedTypeEnvironmentSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced named type environment signature hash ` +
          `${actualNamedTypeEnvironmentSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.namedTypeEnvironmentSignatureHash}`,
      );
    }
    const actualResolvedDeclaredTypeClassSignatureHash = Number(
      host.call("compile_resolved_declared_type_class_signature_hash", input.codes),
    );
    const resolvedDeclaredTypeClassSignatureMatches =
      actualResolvedDeclaredTypeClassSignatureHash === input.resolvedDeclaredTypeClassSignatureHash;
    if (!resolvedDeclaredTypeClassSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced resolved declared type-class signature hash ` +
          `${actualResolvedDeclaredTypeClassSignatureHash} for ${input.sourceId}; ` +
        `JS parser produced ${input.resolvedDeclaredTypeClassSignatureHash}`,
      );
    }
    const actualResolvedDeclaredAbiClassSignatureHash = Number(
      host.call("compile_resolved_declared_abi_class_signature_hash", input.codes),
    );
    const resolvedDeclaredAbiClassSignatureMatches =
      actualResolvedDeclaredAbiClassSignatureHash === input.resolvedDeclaredAbiClassSignatureHash;
    if (!resolvedDeclaredAbiClassSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced resolved declared ABI-class signature hash ` +
          `${actualResolvedDeclaredAbiClassSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.resolvedDeclaredAbiClassSignatureHash}`,
      );
    }
    const actualResolvedSymbolEnvironmentSignatureHash = Number(
      host.call("compile_resolved_symbol_environment_signature_hash", input.codes),
    );
    const resolvedSymbolEnvironmentSignatureMatches =
      actualResolvedSymbolEnvironmentSignatureHash === input.resolvedSymbolEnvironmentSignatureHash;
    if (!resolvedSymbolEnvironmentSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced resolved symbol-environment signature hash ` +
          `${actualResolvedSymbolEnvironmentSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.resolvedSymbolEnvironmentSignatureHash}`,
      );
    }
    const actualResolvedExportAbiSignatureHash = Number(
      host.call("compile_resolved_export_abi_signature_hash", input.codes),
    );
    const resolvedExportAbiSignatureMatches =
      actualResolvedExportAbiSignatureHash === input.resolvedExportAbiSignatureHash;
    if (!resolvedExportAbiSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced resolved export ABI signature hash ` +
          `${actualResolvedExportAbiSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.resolvedExportAbiSignatureHash}`,
      );
    }
    const actualResolvedSimpleBodyTypeCheckSignatureHash = Number(
      host.call("compile_resolved_simple_body_type_check_signature_hash", input.codes),
    );
    const resolvedSimpleBodyTypeCheckSignatureMatches =
      actualResolvedSimpleBodyTypeCheckSignatureHash ===
        input.resolvedSimpleBodyTypeCheckSignatureHash;
    if (!resolvedSimpleBodyTypeCheckSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced resolved simple body type-check signature hash ` +
          `${actualResolvedSimpleBodyTypeCheckSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.resolvedSimpleBodyTypeCheckSignatureHash}`,
      );
    }
    const actualCheckedDeclarationTypeSignatureHash = Number(
      host.call("compile_checked_declaration_type_signature_hash", input.codes),
    );
    const checkedDeclarationTypeSignatureMatches =
      actualCheckedDeclarationTypeSignatureHash === input.checkedDeclarationTypeSignatureHash;
    if (!checkedDeclarationTypeSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced checked declaration type signature hash ` +
          `${actualCheckedDeclarationTypeSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.checkedDeclarationTypeSignatureHash}`,
      );
    }
    const actualCheckedDiagnosticSignatureHash = Number(
      host.call("compile_checked_diagnostic_signature_hash", input.codes),
    );
    const checkedDiagnosticSignatureMatches =
      actualCheckedDiagnosticSignatureHash === input.checkedDiagnosticSignatureHash;
    if (!checkedDiagnosticSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced checked diagnostic signature hash ` +
          `${actualCheckedDiagnosticSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.checkedDiagnosticSignatureHash}`,
      );
    }
    const actualLoweredDeclarationSignatureHash = Number(
      host.call("compile_lowered_declaration_signature_hash", input.codes),
    );
    const loweredDeclarationSignatureMatches =
      actualLoweredDeclarationSignatureHash === input.loweredDeclarationSignatureHash;
    if (!loweredDeclarationSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced lowered declaration signature hash ` +
          `${actualLoweredDeclarationSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.loweredDeclarationSignatureHash}`,
      );
    }
    const actualCheckedDeclarationRecordSignatureHash = Number(
      host.call("compile_checked_declaration_record_signature_hash", input.codes),
    );
    const checkedDeclarationRecordSignatureMatches =
      actualCheckedDeclarationRecordSignatureHash ===
        input.checkedDeclarationRecordSignatureHash;
    if (!checkedDeclarationRecordSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced checked declaration record signature hash ` +
          `${actualCheckedDeclarationRecordSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.checkedDeclarationRecordSignatureHash}`,
      );
    }
    const actualCheckedExpressionRecordSignatureHash = Number(
      host.call("compile_checked_expression_record_signature_hash", input.codes),
    );
    const checkedExpressionRecordSignatureMatches =
      actualCheckedExpressionRecordSignatureHash ===
        input.checkedExpressionRecordSignatureHash;
    if (!checkedExpressionRecordSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced checked expression record signature hash ` +
          `${actualCheckedExpressionRecordSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.checkedExpressionRecordSignatureHash}`,
      );
    }
    const actualCheckedExpressionChildRecordSignatureHash = Number(
      host.call("compile_checked_expression_child_record_signature_hash", input.codes),
    );
    const checkedExpressionChildRecordSignatureMatches =
      actualCheckedExpressionChildRecordSignatureHash ===
        input.checkedExpressionChildRecordSignatureHash;
    if (!checkedExpressionChildRecordSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced checked expression child-record signature hash ` +
          `${actualCheckedExpressionChildRecordSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.checkedExpressionChildRecordSignatureHash}`,
      );
    }
    const actualCheckedLocalEnvironmentSignatureHash = Number(
      host.call("compile_checked_local_environment_signature_hash", input.codes),
    );
    const checkedLocalEnvironmentSignatureMatches =
      actualCheckedLocalEnvironmentSignatureHash ===
        input.checkedLocalEnvironmentSignatureHash;
    if (!checkedLocalEnvironmentSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced checked local-environment signature hash ` +
          `${actualCheckedLocalEnvironmentSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.checkedLocalEnvironmentSignatureHash}`,
      );
    }
    const actualCheckedExpressionShapeSignatureHash = Number(
      host.call("compile_checked_expression_shape_signature_hash", input.codes),
    );
    const checkedExpressionShapeSignatureMatches =
      actualCheckedExpressionShapeSignatureHash ===
        input.checkedExpressionShapeSignatureHash;
    if (!checkedExpressionShapeSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced checked expression-shape signature hash ` +
          `${actualCheckedExpressionShapeSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.checkedExpressionShapeSignatureHash}`,
      );
    }
    const actualLoweredExportRecordSignatureHash = Number(
      host.call("compile_lowered_export_record_signature_hash", input.codes),
    );
    const loweredExportRecordSignatureMatches =
      actualLoweredExportRecordSignatureHash ===
        input.loweredExportRecordSignatureHash;
    if (!loweredExportRecordSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced lowered export-record signature hash ` +
          `${actualLoweredExportRecordSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.loweredExportRecordSignatureHash}`,
      );
    }
    const actualWasmFunctionRecordSignatureHash = Number(
      host.call("compile_wasm_function_record_signature_hash", input.codes),
    );
    const wasmFunctionRecordSignatureMatches =
      actualWasmFunctionRecordSignatureHash === input.wasmFunctionRecordSignatureHash;
    if (!wasmFunctionRecordSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced Wasm function-record signature hash ` +
          `${actualWasmFunctionRecordSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.wasmFunctionRecordSignatureHash}`,
      );
    }
    const actualWasmSectionRecordSignatureHash = Number(
      host.call("compile_wasm_section_record_signature_hash", input.codes),
    );
    const wasmSectionRecordSignatureMatches =
      actualWasmSectionRecordSignatureHash === input.wasmSectionRecordSignatureHash;
    if (!wasmSectionRecordSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced Wasm section-record signature hash ` +
          `${actualWasmSectionRecordSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.wasmSectionRecordSignatureHash}`,
      );
    }
    const actualWasmByteRecordSignatureHash = Number(
      host.call("compile_wasm_byte_record_signature_hash", input.codes),
    );
    const wasmByteRecordSignatureMatches =
      actualWasmByteRecordSignatureHash === input.wasmByteRecordSignatureHash;
    if (!wasmByteRecordSignatureMatches) {
      throw new Error(
        `compiled Fig compiler produced Wasm byte-record signature hash ` +
          `${actualWasmByteRecordSignatureHash} for ${input.sourceId}; ` +
          `JS parser produced ${input.wasmByteRecordSignatureHash}`,
      );
    }
    const actualWasmByteBuffer = host.call(
      "compile_wasm_byte_buffer",
      input.codes,
    ) as number[];
    const wasmByteBufferMismatch = firstNumberArrayMismatch(
      actualWasmByteBuffer,
      input.wasmByteBuffer,
    );
    if (wasmByteBufferMismatch !== undefined) {
      throw new Error(
        `compiled Fig compiler produced Wasm byte buffer mismatch ` +
          `for ${input.sourceId} at ${wasmByteBufferMismatch}; ` +
          `actual ${byteWindow(actualWasmByteBuffer, wasmByteBufferMismatch)}; ` +
          `expected ${byteWindow(input.wasmByteBuffer, wasmByteBufferMismatch)}`,
      );
    }
  }
  return async (index: number) => {
    let total = 0;
    for (let offset = 0; offset < figRunIters; offset++) {
      for (const input of encodedSources) {
        total = (total + Number(host.call("compile_codes", input.codes)) + index + offset) | 0;
      }
    }
    figWasmSink = (figWasmSink ^ total) | 0;
    await Promise.resolve();
  };
}

async function figCompilerInputs(): Promise<FigCompilerInput[]> {
  const inputs: FigCompilerInput[] = [];
  for (const [sourceId, source] of figCompilerSources) {
    const program = await parse(source, { sourceId });
    const typeEnvironment = programNamedTypeEnvironment(program);
    const codes = sourceCodes(source);
    const tokens = tokenize(source);
    inputs.push({
      sourceId,
      codes,
      declarationCount: programDeclarationCount(program),
      declarationKindCounts: programDeclarationKindCounts(program),
      functionParamCount: programFunctionParamCount(program),
      typeParamCount: programTypeParamCount(program),
      typeResultKindCounts: programTypeResultKindCounts(program),
      typeSugarStatementCount: programTypeSugarStatementCount(program, source),
      declarationSignatureHash: programDeclarationSignatureHash(program),
      functionParamSignatureHash: programFunctionParamSignatureHash(program),
      typeParamSignatureHash: programTypeParamSignatureHash(program),
      functionParamTypeSignatureHash: programFunctionParamTypeSignatureHash(program),
      functionReturnSignatureHash: programFunctionReturnSignatureHash(program),
      valueAnnotationSignatureHash: programValueAnnotationSignatureHash(program),
      functionBodySignatureHash: programFunctionBodySignatureHash(program, source),
      typeBodySignatureHash: programTypeBodySignatureHash(program, source),
      declaredTypeClassSignatureHash: programDeclaredTypeClassSignatureHash(program),
      declaredAbiClassSignatureHash: programDeclaredAbiClassSignatureHash(program),
      symbolEnvironmentSignatureHash: programSymbolEnvironmentSignatureHash(program),
      exportAbiSignatureHash: programExportAbiSignatureHash(program),
      valueBodyTypeClassSignatureHash: programValueBodyTypeClassSignatureHash(program),
      valueBodyAbiClassSignatureHash: programValueBodyAbiClassSignatureHash(program),
      resolvedValueBodyTypeClassSignatureHash: programResolvedValueBodyTypeClassSignatureHash(
        program,
        typeEnvironment,
      ),
      resolvedValueBodyAbiClassSignatureHash: programResolvedValueBodyAbiClassSignatureHash(
        program,
        typeEnvironment,
      ),
      simpleBodyTypeCheckSignatureHash: programSimpleBodyTypeCheckSignatureHash(program),
      namedTypeEnvironmentSignatureHash: programNamedTypeEnvironmentSignatureHash(
        typeEnvironment,
      ),
      resolvedDeclaredTypeClassSignatureHash: programResolvedDeclaredTypeClassSignatureHash(
        program,
        typeEnvironment,
      ),
      resolvedDeclaredAbiClassSignatureHash: programResolvedDeclaredAbiClassSignatureHash(
        program,
        typeEnvironment,
      ),
      resolvedSymbolEnvironmentSignatureHash: programResolvedSymbolEnvironmentSignatureHash(
        program,
        typeEnvironment,
      ),
      resolvedExportAbiSignatureHash: programResolvedExportAbiSignatureHash(
        program,
        typeEnvironment,
      ),
      resolvedSimpleBodyTypeCheckSignatureHash: programResolvedSimpleBodyTypeCheckSignatureHash(
        program,
        typeEnvironment,
      ),
      checkedDeclarationTypeSignatureHash: programCheckedDeclarationTypeSignatureHash(
        program,
        typeEnvironment,
      ),
      checkedDiagnosticSignatureHash: programCheckedDiagnosticSignatureHash(
        program,
        typeEnvironment,
      ),
      loweredDeclarationSignatureHash: programLoweredDeclarationSignatureHash(
        program,
        typeEnvironment,
      ),
      checkedDeclarationRecordSignatureHash: programCheckedDeclarationRecordSignatureHash(
        program,
        typeEnvironment,
      ),
      checkedExpressionRecordSignatureHash: programCheckedExpressionRecordSignatureHash(
        program,
        typeEnvironment,
      ),
      checkedExpressionChildRecordSignatureHash: programCheckedExpressionChildRecordSignatureHash(
        program,
      ),
      checkedLocalEnvironmentSignatureHash: programCheckedLocalEnvironmentSignatureHash(
        program,
        typeEnvironment,
      ),
      checkedExpressionShapeSignatureHash: programCheckedExpressionShapeSignatureHash(
        program,
        typeEnvironment,
        tokens,
      ),
      loweredExportRecordSignatureHash: programLoweredExportRecordSignatureHash(
        program,
        typeEnvironment,
      ),
      wasmFunctionRecordSignatureHash: programWasmFunctionRecordSignatureHash(
        program,
        typeEnvironment,
      ),
      wasmSectionRecordSignatureHash: programWasmSectionRecordSignatureHash(
        program,
        typeEnvironment,
      ),
      wasmByteRecordSignatureHash: programWasmByteRecordSignatureHash(
        program,
        typeEnvironment,
      ),
      wasmByteBuffer: programWasmByteBuffer(
        program,
        typeEnvironment,
      ),
      functionLocalLetCount: programFunctionLocalLetCount(program),
      functionLocalTypeAssertCount: programFunctionLocalTypeAssertCount(program),
      valueMatchExpressionCount: programValueMatchExpressionCount(program),
      functionMatchBodyCount: programFunctionMatchBodyCount(program),
      valueDoExpressionCount: programValueDoExpressionCount(program),
      valueDoBindCount: programValueDoBindCount(program),
      valueMatchArmCount: programValueMatchArmCount(program),
      valuePipeBindCount: programValuePipeBindCount(program),
      valueOperatorExpressionCount: programValueOperatorExpressionCount(program),
      valueOperatorSignatureHash: programValueOperatorSignatureHash(program, tokens),
      valueCallExpressionCount: programValueCallExpressionCount(program),
      sourceImportEdgeSignatureHash: programSourceImportEdgeSignatureHash(program),
      sourceImportGraphDiagnosticSignatureHash:
        programSourceImportGraphDiagnosticSignatureHash(program),
      declarationDependencySignatureHash: programDeclarationDependencySignatureHash(program),
      declarationDependencyDiagnosticSignatureHash:
        programDeclarationDependencyDiagnosticSignatureHash(program),
      directImportTypeEnvironmentInputs: await programDirectImportTypeEnvironmentInputs(
        program,
        sourceId,
        codes,
      ),
    });
  }
  return inputs;
}

function programDeclarationCount(program: Program): number {
  let sourceImportCount = program.sourceImports?.length;
  if (sourceImportCount === undefined) {
    sourceImportCount = 0;
  }
  return program.imports.length + sourceImportCount + program.declarations.length;
}

function programDeclarationKindCounts(program: Program): DeclarationKindCounts {
  let sourceImportCount = program.sourceImports?.length;
  if (sourceImportCount === undefined) {
    sourceImportCount = 0;
  }
  const counts: DeclarationKindCounts = {
    functions: 0,
    lets: 0,
    consts: 0,
    types: 0,
    sourceImports: sourceImportCount,
  };
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      counts.functions += 1;
      continue;
    }
    if (decl.kind === "let") {
      counts.lets += 1;
      continue;
    }
    if (decl.kind === "const") {
      counts.consts += 1;
      continue;
    }
    if (decl.kind === "type") {
      counts.types += 1;
    }
  }
  return counts;
}

function programFunctionParamCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      total += decl.params.length;
    }
  }
  return total;
}

function programTypeParamCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind === "type") {
      total += decl.params.length;
    }
  }
  return total;
}

function programTypeResultKindCounts(program: Program): TypeResultKindCounts {
  const counts: TypeResultKindCounts = {
    types: 0,
    structs: 0,
    unions: 0,
  };
  for (const decl of program.declarations) {
    if (decl.kind !== "type") {
      continue;
    }
    if (decl.resultKind === "struct") {
      counts.structs += 1;
      continue;
    }
    if (decl.resultKind === "union") {
      counts.unions += 1;
      continue;
    }
    counts.types += 1;
  }
  return counts;
}

function programTypeSugarStatementCount(program: Program, source: string): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "type") {
      continue;
    }
    if (isTypeFunctionDeclaration(source, decl.span, decl.body.span)) {
      continue;
    }
    total += decl.body.statements.length;
  }
  return total;
}

function programDeclarationSignatureHash(program: Program): number {
  let total = 0;
  for (const item of program.sourceImports ?? []) {
    const alias = item.alias ?? "";
    total = signatureMix(
      total,
      declarationSignatureHash(5, textHash(alias), textHash(JSON.stringify(item.module))),
    );
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const primaryName = primaryDeclarationName(decl);
    const auxHash = declarationAuxHash(decl);
    total = signatureMix(
      total,
      declarationSignatureHash(kindTag, textHash(primaryName), auxHash),
    );
  }
  return total;
}

function programFunctionParamSignatureHash(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    for (const param of decl.params) {
      total = signatureMix(total, textHash(paramSignatureName(param)));
    }
  }
  return total;
}

function programTypeParamSignatureHash(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "type") {
      continue;
    }
    for (const param of decl.params) {
      total = signatureMix(total, textHash(typeParamSignatureName(param)));
    }
  }
  return total;
}

function programFunctionParamTypeSignatureHash(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    for (const param of decl.params) {
      total = signatureMix(total, normalizedTypeSignatureHash(param.type));
    }
  }
  return total;
}

function programFunctionReturnSignatureHash(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    total = signatureMix(total, normalizedTypeSignatureHash(decl.returnType));
  }
  return total;
}

function programValueAnnotationSignatureHash(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "let" && decl.kind !== "const") {
      continue;
    }
    if (decl.type === undefined) {
      continue;
    }
    total = signatureMix(total, normalizedTypeSignatureHash(decl.type));
  }
  return total;
}

function programFunctionBodySignatureHash(program: Program, source: string): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    total = signatureMix(total, normalizedSourceSpanHash(source, decl.body.span));
  }
  return total;
}

function programTypeBodySignatureHash(program: Program, source: string): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "type") {
      continue;
    }
    if (isTypeFunctionDeclaration(source, decl.span, decl.body.span)) {
      continue;
    }
    total = signatureMix(total, normalizedSourceSpanHash(source, decl.body.span));
  }
  return total;
}

function programDeclaredTypeClassSignatureHash(program: Program): number {
  let total = 0;
  for (const _item of program.sourceImports ?? []) {
    total = signatureMix(total, declaredTypeClassHash(5, typeClassUnknownTag(), 0));
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const typeClass = declarationTypeClassTag(decl);
    const payload = declarationTypeClassPayload(decl);
    total = signatureMix(total, declaredTypeClassHash(kindTag, typeClass, payload));
  }
  return total;
}

function programDeclaredAbiClassSignatureHash(program: Program): number {
  let total = 0;
  for (const _item of program.sourceImports ?? []) {
    total = signatureMix(total, declaredAbiClassHash(5, abiClassVoidTag()));
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const abiClass = declarationAbiClassTag(decl);
    total = signatureMix(total, declaredAbiClassHash(kindTag, abiClass));
  }
  return total;
}

function programSymbolEnvironmentSignatureHash(program: Program): number {
  let total = 0;
  for (const item of program.sourceImports ?? []) {
    const alias = item.alias ?? "";
    total = signatureMix(
      total,
      symbolEnvironmentHash(
        5,
        textHash(alias),
        typeClassUnknownTag(),
        0,
        abiClassVoidTag(),
      ),
    );
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const nameHash = textHash(primaryDeclarationName(decl));
    const typeClass = declarationTypeClassTag(decl);
    const payload = declarationTypeClassPayload(decl);
    const abiClass = declarationAbiClassTag(decl);
    total = signatureMix(
      total,
      symbolEnvironmentHash(kindTag, nameHash, typeClass, payload, abiClass),
    );
  }
  return total;
}

function programExportAbiSignatureHash(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    if (!decl.public) {
      continue;
    }
    const nameHash = textHash(primaryDeclarationName(decl));
    const returnTypeClass = typeClassFromAnnotation(decl.returnType);
    const returnAbiClass = abiClassFromTypeClass(returnTypeClass);
    total = signatureMix(
      total,
      exportAbiHash(nameHash, decl.params.length, returnAbiClass),
    );
  }
  return total;
}

function programValueBodyTypeClassSignatureHash(program: Program): number {
  let total = 0;
  for (const _item of program.sourceImports ?? []) {
    total = signatureMix(total, valueBodyTypeClassHash(5, typeClassUnknownTag()));
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const typeClass = declarationBodyTypeClassTag(decl);
    total = signatureMix(total, valueBodyTypeClassHash(kindTag, typeClass));
  }
  return total;
}

function programValueBodyAbiClassSignatureHash(program: Program): number {
  let total = 0;
  for (const _item of program.sourceImports ?? []) {
    total = signatureMix(total, valueBodyAbiClassHash(5, abiClassVoidTag()));
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const typeClass = declarationBodyTypeClassTag(decl);
    total = signatureMix(
      total,
      valueBodyAbiClassHash(kindTag, abiClassFromTypeClass(typeClass)),
    );
  }
  return total;
}

function programResolvedValueBodyTypeClassSignatureHash(
  program: Program,
  typeEnvironment: Map<string, number>,
): number {
  let total = 0;
  const symbolEnvironment = programResolvedSymbolTypeEnvironment(program, typeEnvironment);
  const functionReturnEnvironment = programFunctionReturnTypeEnvironment(program, typeEnvironment);
  for (const _item of program.sourceImports ?? []) {
    total = signatureMix(total, valueBodyTypeClassHash(5, typeClassUnknownTag()));
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const typeClass = declarationResolvedBodyTypeClassTag(
      decl,
      symbolEnvironment,
      typeEnvironment,
      functionReturnEnvironment,
    );
    total = signatureMix(total, valueBodyTypeClassHash(kindTag, typeClass));
  }
  return total;
}

function programResolvedValueBodyAbiClassSignatureHash(
  program: Program,
  typeEnvironment: Map<string, number>,
): number {
  let total = 0;
  const symbolEnvironment = programResolvedSymbolTypeEnvironment(program, typeEnvironment);
  const functionReturnEnvironment = programFunctionReturnTypeEnvironment(program, typeEnvironment);
  for (const _item of program.sourceImports ?? []) {
    total = signatureMix(total, valueBodyAbiClassHash(5, abiClassVoidTag()));
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const typeClass = declarationResolvedBodyTypeClassTag(
      decl,
      symbolEnvironment,
      typeEnvironment,
      functionReturnEnvironment,
    );
    total = signatureMix(
      total,
      valueBodyAbiClassHash(kindTag, abiClassFromTypeClass(typeClass)),
    );
  }
  return total;
}

function programSimpleBodyTypeCheckSignatureHash(program: Program): number {
  let total = 0;
  for (const _item of program.sourceImports ?? []) {
    total = signatureMix(
      total,
      simpleBodyTypeCheckHash(
        5,
        typeClassUnknownTag(),
        typeClassUnknownTag(),
        typeCheckUnknownTag(),
      ),
    );
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const expected = declarationExpectedBodyTypeClassTag(decl);
    const actual = declarationBodyTypeClassTag(decl);
    const status = simpleBodyTypeCheckStatus(expected, actual);
    total = signatureMix(
      total,
      simpleBodyTypeCheckHash(kindTag, expected, actual, status),
    );
  }
  return total;
}

function programNamedTypeEnvironment(program: Program): Map<string, number> {
  const declarations = programTypeDeclarations(program);
  const environment = new Map<string, number>();
  for (const decl of program.declarations) {
    if (decl.kind !== "type") {
      continue;
    }
    const resolving = new Set<string>();
    const typeClass = typeDeclarationEnvironmentTypeClass(decl, declarations, resolving);
    environment.set(primaryDeclarationName(decl), typeClass);
  }
  return environment;
}

function programResolvedSymbolTypeEnvironment(
  program: Program,
  typeEnvironment: Map<string, number>,
): Map<string, number> {
  const environment = new Map<string, number>();
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    if (kindTag === 5) {
      continue;
    }
    environment.set(
      primaryDeclarationName(decl),
      declarationResolvedTypeClassTag(decl, typeEnvironment),
    );
  }
  return environment;
}

function programFunctionReturnTypeEnvironment(
  program: Program,
  typeEnvironment: Map<string, number>,
): Map<string, number> {
  const environment = new Map<string, number>();
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    environment.set(
      primaryDeclarationName(decl),
      typeClassFromAnnotation(decl.returnType, typeEnvironment),
    );
  }
  return environment;
}

function programFunctionIndexEnvironment(program: Program): Map<string, number> {
  const environment = new Map<string, number>();
  let functionIndex = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    environment.set(decl.name, functionIndex);
    functionIndex += 1;
  }
  return environment;
}

function programFunctionRuntimeParamCountEnvironment(program: Program): Map<string, number> {
  const environment = new Map<string, number>();
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    environment.set(decl.name, declarationRuntimeParamCount(decl));
  }
  return environment;
}

function programTypeDeclarations(program: Program): Map<string, TypeDecl> {
  const declarations = new Map<string, TypeDecl>();
  for (const decl of program.declarations) {
    if (decl.kind !== "type") {
      continue;
    }
    declarations.set(primaryDeclarationName(decl), decl);
  }
  return declarations;
}

function typeDeclarationEnvironmentTypeClass(
  decl: TypeDecl,
  declarations: Map<string, TypeDecl>,
  resolving: Set<string>,
): number {
  const resultClass = typeClassFromTypeResultKind(decl.resultKind);
  if (resultClass === typeClassProductTag() || resultClass === typeClassUnionTag()) {
    return resultClass;
  }
  return typeExprEnvironmentTypeClass(decl.body.expr, declarations, resolving);
}

function typeExprEnvironmentTypeClass(
  expr: TypeExpr | undefined,
  declarations: Map<string, TypeDecl>,
  resolving: Set<string>,
): number {
  if (expr === undefined) {
    return typeClassUnknownTag();
  }
  if (expr.kind === "type_fn") {
    return typeClassFunctionTag();
  }
  if (expr.kind === "type_shape") {
    return typeClassProductTag();
  }
  if (expr.kind === "type_scalar_domain") {
    return typeClassFromAnnotation(expr.carrier);
  }
  if (expr.kind === "type_ref") {
    return namedTypeEnvironmentTypeClass(expr.name, declarations, resolving);
  }
  if (expr.kind === "type_call") {
    if (expr.callee.kind === "type_ref") {
      return namedTypeEnvironmentTypeClass(expr.callee.name, declarations, resolving);
    }
  }
  return typeClassUnknownTag();
}

function namedTypeEnvironmentTypeClass(
  name: string,
  declarations: Map<string, TypeDecl>,
  resolving: Set<string>,
): number {
  const primitive = typeClassFromAnnotation(name);
  if (primitive !== typeClassUnknownTag()) {
    return primitive;
  }
  const decl = declarations.get(name);
  if (decl === undefined) {
    return typeClassUnknownTag();
  }
  const isResolving = resolving.has(name);
  if (isResolving) {
    return typeClassUnknownTag();
  }
  resolving.add(name);
  const typeClass = typeDeclarationEnvironmentTypeClass(decl, declarations, resolving);
  resolving.delete(name);
  return typeClass;
}

function programNamedTypeEnvironmentSignatureHash(environment: Map<string, number>): number {
  let total = 0;
  for (const [name, typeClass] of environment) {
    total = signatureMix(total, namedTypeEnvironmentHash(textHash(name), typeClass));
  }
  return total;
}

async function programDirectImportTypeEnvironmentInputs(
  program: Program,
  sourceId: string,
  codes: number[],
): Promise<FigDirectImportTypeEnvironmentInput[]> {
  const inputs: FigDirectImportTypeEnvironmentInput[] = [];
  for (const item of program.sourceImports ?? []) {
    const alias = item.alias;
    if (alias === undefined) {
      continue;
    }
    const resolved = await resolveModule(item.module, { fromSourceId: sourceId });
    if (resolved === undefined) {
      continue;
    }
    const importSourceId = resolved.sourceId ?? item.module;
    const importedProgram = await parse(resolved.text, { sourceId: importSourceId });
    const importedEnvironment = programNamedTypeEnvironment(importedProgram);
    const qualifiedEnvironment = qualifiedImportTypeEnvironment(alias, importedEnvironment);
    const combinedEnvironment = new Map<string, number>();
    for (const [name, typeClass] of programNamedTypeEnvironment(program)) {
      combinedEnvironment.set(name, typeClass);
    }
    for (const [name, typeClass] of qualifiedEnvironment) {
      combinedEnvironment.set(name, typeClass);
    }
    const moduleHash = textHash(JSON.stringify(item.module));
    const signatureHash = directImportTypeEnvironmentSignatureHash(
      alias,
      importedEnvironment,
    );
    const qualifiedResolvedDeclaredTypeClassSignatureHash =
      programResolvedDeclaredTypeClassSignatureHash(program, combinedEnvironment);
    const qualifiedResolvedDeclaredAbiClassSignatureHash =
      programResolvedDeclaredAbiClassSignatureHash(program, combinedEnvironment);
    const qualifiedResolvedValueBodyTypeClassSignatureHash =
      programResolvedValueBodyTypeClassSignatureHash(program, combinedEnvironment);
    const qualifiedResolvedValueBodyAbiClassSignatureHash =
      programResolvedValueBodyAbiClassSignatureHash(program, combinedEnvironment);
    const qualifiedResolvedSimpleBodyTypeCheckSignatureHash =
      programResolvedSimpleBodyTypeCheckSignatureHash(program, combinedEnvironment);
    const qualifiedResolvedSymbolEnvironmentSignatureHash =
      programResolvedSymbolEnvironmentSignatureHash(program, combinedEnvironment);
    const qualifiedResolvedExportAbiSignatureHash =
      programResolvedExportAbiSignatureHash(program, combinedEnvironment);
    inputs.push({
      sourceId,
      importSourceId,
      sourceCodes: codes,
      importCodes: sourceCodes(resolved.text),
      moduleHash,
      signatureHash,
      qualifiedResolvedDeclaredTypeClassSignatureHash,
      qualifiedResolvedDeclaredAbiClassSignatureHash,
      qualifiedResolvedValueBodyTypeClassSignatureHash,
      qualifiedResolvedValueBodyAbiClassSignatureHash,
      qualifiedResolvedSimpleBodyTypeCheckSignatureHash,
      qualifiedResolvedSymbolEnvironmentSignatureHash,
      qualifiedResolvedExportAbiSignatureHash,
      resolutionRecordSignatureHash: directImportResolutionRecordSignatureHash(
        moduleHash,
        textHash(alias),
        signatureHash,
        qualifiedResolvedDeclaredTypeClassSignatureHash,
        qualifiedResolvedDeclaredAbiClassSignatureHash,
        qualifiedResolvedValueBodyTypeClassSignatureHash,
        qualifiedResolvedValueBodyAbiClassSignatureHash,
        qualifiedResolvedSimpleBodyTypeCheckSignatureHash,
        qualifiedResolvedSymbolEnvironmentSignatureHash,
        qualifiedResolvedExportAbiSignatureHash,
      ),
    });
  }
  return inputs;
}

function qualifiedImportTypeEnvironment(
  alias: string,
  environment: Map<string, number>,
): Map<string, number> {
  const qualified = new Map<string, number>();
  for (const [name, typeClass] of environment) {
    qualified.set(`${alias}.${name}`, typeClass);
  }
  return qualified;
}

function directImportTypeEnvironmentSignatureHash(
  alias: string,
  environment: Map<string, number>,
): number {
  const aliasHash = textHash(alias);
  let total = 0;
  for (const [name, typeClass] of environment) {
    total = signatureMix(
      total,
      directImportTypeEnvironmentHash(aliasHash, textHash(name), typeClass),
    );
  }
  return total;
}

function directImportResolutionRecordSignatureHash(
  moduleHash: number,
  aliasHash: number,
  typeEnvironmentSignature: number,
  resolvedTypeSignature: number,
  resolvedAbiSignature: number,
  resolvedValueBodyTypeSignature: number,
  resolvedValueBodyAbiSignature: number,
  resolvedSimpleBodyTypeCheckSignature: number,
  resolvedSymbolEnvironmentSignature: number,
  resolvedExportAbiSignature: number,
): number {
  let total = signatureMix(73, moduleHash);
  total = signatureMix(total, aliasHash);
  total = signatureMix(total, typeEnvironmentSignature);
  total = signatureMix(total, resolvedTypeSignature);
  total = signatureMix(total, resolvedAbiSignature);
  total = signatureMix(total, resolvedValueBodyTypeSignature);
  total = signatureMix(total, resolvedValueBodyAbiSignature);
  total = signatureMix(total, resolvedSimpleBodyTypeCheckSignature);
  total = signatureMix(total, resolvedSymbolEnvironmentSignature);
  total = signatureMix(total, resolvedExportAbiSignature);
  return total;
}

function programSourceImportEdgeSignatureHash(program: Program): number {
  let total = 0;
  for (const item of program.sourceImports ?? []) {
    const alias = item.alias ?? "";
    total = signatureMix(
      total,
      sourceImportEdgeHash(textHash(alias), textHash(JSON.stringify(item.module))),
    );
  }
  return total;
}

function sourceImportSpanWidth(item: NonNullable<Program["sourceImports"]>[number]): number {
  const span = item.span;
  if (span === undefined) {
    return 0;
  }
  return span.end - span.start;
}

function programSourceImportGraphDiagnosticSignatureHash(program: Program): number {
  let total = 0;
  for (const item of program.sourceImports ?? []) {
    const alias = item.alias ?? "";
    total = signatureMix(
      total,
      sourceImportGraphDiagnosticHash(
        textHash(alias),
        textHash(JSON.stringify(item.module)),
        sourceImportSpanWidth(item),
        sourceImportGraphNoDiagnosticCode(),
      ),
    );
  }
  return total;
}

function declarationDependencySpanWidth(decl: Program["declarations"][number]): number {
  const span = decl.span;
  if (span === undefined) {
    return 0;
  }
  return span.end - span.start;
}

function declarationHasDependencyBody(decl: Program["declarations"][number]): boolean {
  if (decl.kind === "fn") {
    return true;
  }
  if (decl.kind === "let") {
    return true;
  }
  return decl.kind === "const";
}

type DeclarationDependencyTarget = {
  hash: number;
  edgeTag: number;
};

function declarationSimpleDependencyTarget(
  decl: Program["declarations"][number],
): DeclarationDependencyTarget | undefined {
  if (!declarationHasDependencyBody(decl)) {
    return undefined;
  }
  const body = declarationExpressionShapeBody(decl);
  const rootKind = expressionRootHeadKindTag(body);
  if (rootKind !== expressionRootIdentifierTag()) {
    return undefined;
  }
  if (expressionRootHeadSelectorCount(body) !== 0) {
    const qualifiedHash = expressionRootQualifiedHeadHash(body);
    if (qualifiedHash === undefined) {
      return undefined;
    }
    return {
      hash: qualifiedHash,
      edgeTag: declarationDependencyQualifiedValueEdgeTag(),
    };
  }
  return {
    hash: expressionRootHeadHash(body),
    edgeTag: declarationDependencyValueEdgeTag(),
  };
}

function programDeclarationDependencySignatureHash(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    const target = declarationSimpleDependencyTarget(decl);
    if (target === undefined) {
      continue;
    }
    total = signatureMix(
      total,
      declarationDependencyHash(
        declarationKindTag(decl.kind),
        textHash(primaryDeclarationName(decl)),
        target.hash,
        target.edgeTag,
        declarationDependencySpanWidth(decl),
      ),
    );
  }
  return total;
}

function programDeclarationDependencyDiagnosticSignatureHash(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    const target = declarationSimpleDependencyTarget(decl);
    if (target === undefined) {
      continue;
    }
    const fromHash = textHash(primaryDeclarationName(decl));
    total = signatureMix(
      total,
      declarationDependencyDiagnosticHash(
        declarationKindTag(decl.kind),
        fromHash,
        target.hash,
        target.edgeTag,
        declarationDependencySpanWidth(decl),
        target.edgeTag === declarationDependencyValueEdgeTag()
          ? declarationDependencyDiagnosticCode(program, fromHash, target.hash)
          : declarationDependencyNoDiagnosticCode(),
      ),
    );
  }
  return total;
}

function programResolvedDeclaredTypeClassSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  let total = 0;
  for (const _item of program.sourceImports ?? []) {
    total = signatureMix(total, declaredTypeClassHash(5, typeClassUnknownTag(), 0));
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const typeClass = declarationResolvedTypeClassTag(decl, environment);
    const payload = declarationResolvedTypeClassPayload(decl, environment);
    total = signatureMix(total, declaredTypeClassHash(kindTag, typeClass, payload));
  }
  return total;
}

function programResolvedDeclaredAbiClassSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  let total = 0;
  for (const _item of program.sourceImports ?? []) {
    total = signatureMix(total, declaredAbiClassHash(5, abiClassVoidTag()));
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const abiClass = declarationResolvedAbiClassTag(decl, environment);
    total = signatureMix(total, declaredAbiClassHash(kindTag, abiClass));
  }
  return total;
}

function programResolvedSymbolEnvironmentSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  let total = 0;
  for (const item of program.sourceImports ?? []) {
    const alias = item.alias ?? "";
    total = signatureMix(
      total,
      symbolEnvironmentHash(
        5,
        textHash(alias),
        typeClassUnknownTag(),
        0,
        abiClassVoidTag(),
      ),
    );
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const nameHash = textHash(primaryDeclarationName(decl));
    const typeClass = declarationResolvedTypeClassTag(decl, environment);
    const payload = declarationResolvedTypeClassPayload(decl, environment);
    const abiClass = declarationResolvedAbiClassTag(decl, environment);
    total = signatureMix(
      total,
      symbolEnvironmentHash(kindTag, nameHash, typeClass, payload, abiClass),
    );
  }
  return total;
}

function programResolvedExportAbiSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    if (!decl.public) {
      continue;
    }
    const nameHash = textHash(primaryDeclarationName(decl));
    const returnTypeClass = typeClassFromAnnotation(decl.returnType, environment);
    const returnAbiClass = abiClassFromTypeClass(returnTypeClass);
    total = signatureMix(
      total,
      exportAbiHash(nameHash, decl.params.length, returnAbiClass),
    );
  }
  return total;
}

function programLoweredExportRecordSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    if (!decl.public) {
      continue;
    }
    const returnTypeClass = typeClassFromAnnotation(decl.returnType, environment);
    total = signatureMix(
      total,
      loweredExportRecordFactHash({
        nameHash: textHash(primaryDeclarationName(decl)),
        paramCount: decl.params.length,
        returnAbiClass: abiClassFromTypeClass(returnTypeClass),
      }),
    );
  }
  return total;
}

function programWasmFunctionRecordSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  let total = 0;
  const symbolEnvironment = programResolvedSymbolTypeEnvironment(program, environment);
  const functionReturnEnvironment = programFunctionReturnTypeEnvironment(program, environment);
  const functionIndexEnvironment = programFunctionIndexEnvironment(program);
  const functionRuntimeParamCountEnvironment =
    programFunctionRuntimeParamCountEnvironment(program);
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    const expected = declarationResolvedExpectedBodyTypeClassTag(decl, environment);
    const actual = declarationResolvedBodyTypeClassTag(
      decl,
      symbolEnvironment,
      environment,
      functionReturnEnvironment,
    );
    const bodyAbi = abiClassFromTypeClass(actual);
    const bodyPlan = wasmBodyPlanForDeclaration(
      bodyAbi,
      decl,
      environment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    const resultValType = wasmValTypeForAbi(abiClassFromTypeClass(expected));
    const terminatorOpcode = wasmTerminatorOpcode(resultValType);
    const localCount = declarationFunctionLocalLetCount(decl);
    total = signatureMix(
      total,
      wasmFunctionRecordFactHash({
        nameHash: textHash(primaryDeclarationName(decl)),
        exportTag: decl.public ? 1 : 0,
        runtimeParamCount: declarationRuntimeParamCount(decl),
        localCount,
        resultValType,
        bodyOpcode: bodyPlan.firstOpcode,
        bodyImmediate: bodyPlan.firstImmediate,
        terminatorOpcode,
        bodySize: wasmFunctionBodySize(
          localCount,
          bodyPlan.byteSize,
          terminatorOpcode,
        ),
        diagnosticCode: diagnosticCodeForTypeCheckStatus(
          simpleBodyTypeCheckStatus(expected, actual),
        ),
      }),
    );
  }
  return total;
}

function programWasmSectionRecordSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  const scan = programWasmSectionScan(program, environment);
  return wasmSectionRecordFinalSignature(scan);
}

function programWasmByteRecordSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  const scan = programWasmSectionScan(program, environment);
  return wasmByteRecordFinalSignature(scan);
}

function programWasmByteBuffer(
  program: Program,
  environment: Map<string, number>,
): number[] {
  const facts = programWasmFunctionByteFacts(program, environment);
  const exportCount = wasmFunctionByteFactExportCount(facts);
  const bytes: number[] = [];
  bytes.push(0, 97, 115, 109, 1, 0, 0, 0);
  wasmPushSection(bytes, wasmTypeSectionId(), wasmTypePayloadBytes(facts));
  wasmPushSection(bytes, wasmFunctionSectionId(), wasmFunctionPayloadBytes(facts));
  wasmPushSection(bytes, wasmExportSectionId(), wasmExportPayloadBytes(facts, exportCount));
  wasmPushSection(bytes, wasmCodeSectionId(), wasmCodePayloadBytes(facts));
  return bytes;
}

type WasmFunctionByteFact = {
  name: string;
  public: boolean;
  functionIndex: number;
  runtimeParamCount: number;
  resultValType: number;
  localCount: number;
  bodyOpcode: number;
  bodyImmediate: number;
  bodyInstructions: WasmBodyInstruction[];
  terminatorOpcode: number;
  bodySize: number;
};

type WasmBodyInstruction = {
  opcode: number;
  immediate: number;
};

type WasmBodyPlan = {
  firstOpcode: number;
  firstImmediate: number;
  byteSize: number;
  instructions: WasmBodyInstruction[];
};

type BareCallExpr = Extract<Expr, { kind: "call" }> & {
  callee: Extract<Expr, { kind: "var" }>;
};

function programWasmFunctionByteFacts(
  program: Program,
  environment: Map<string, number>,
): WasmFunctionByteFact[] {
  const facts: WasmFunctionByteFact[] = [];
  const symbolEnvironment = programResolvedSymbolTypeEnvironment(program, environment);
  const functionReturnEnvironment = programFunctionReturnTypeEnvironment(program, environment);
  const functionIndexEnvironment = programFunctionIndexEnvironment(program);
  const functionRuntimeParamCountEnvironment =
    programFunctionRuntimeParamCountEnvironment(program);
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") continue;
    const expected = declarationResolvedExpectedBodyTypeClassTag(decl, environment);
    const actual = declarationResolvedBodyTypeClassTag(
      decl,
      symbolEnvironment,
      environment,
      functionReturnEnvironment,
    );
    const bodyAbi = abiClassFromTypeClass(actual);
    const bodyPlan = wasmBodyPlanForDeclaration(
      bodyAbi,
      decl,
      environment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    const resultValType = wasmValTypeForAbi(abiClassFromTypeClass(expected));
    const terminatorOpcode = wasmTerminatorOpcode(resultValType);
    const localCount = declarationFunctionLocalLetCount(decl);
    const bodySize = wasmFunctionBodySize(
      localCount,
      bodyPlan.byteSize,
      terminatorOpcode,
    );
    facts.push({
      name: primaryDeclarationName(decl),
      public: decl.public,
      functionIndex: facts.length,
      runtimeParamCount: declarationRuntimeParamCount(decl),
      resultValType,
      localCount,
      bodyOpcode: bodyPlan.firstOpcode,
      bodyImmediate: bodyPlan.firstImmediate,
      bodyInstructions: bodyPlan.instructions,
      terminatorOpcode,
      bodySize,
    });
  }
  return facts;
}

function wasmFunctionByteFactExportCount(facts: WasmFunctionByteFact[]): number {
  let total = 0;
  for (const fact of facts) {
    if (fact.public) total += 1;
  }
  return total;
}

function wasmTypePayloadBytes(facts: WasmFunctionByteFact[]): number[] {
  const bytes: number[] = [];
  wasmPushU32Leb(bytes, facts.length);
  for (const fact of facts) {
    wasmPushByte(bytes, 96);
    wasmPushU32Leb(bytes, fact.runtimeParamCount);
    for (let index = 0; index < fact.runtimeParamCount; index++) {
      wasmPushByte(bytes, wasmI32ValType());
    }
    const resultArity = wasmResultArity(fact.resultValType);
    wasmPushU32Leb(bytes, resultArity);
    if (resultArity > 0) {
      wasmPushByte(bytes, fact.resultValType);
    }
  }
  return bytes;
}

function wasmFunctionPayloadBytes(facts: WasmFunctionByteFact[]): number[] {
  const bytes: number[] = [];
  wasmPushU32Leb(bytes, facts.length);
  for (const fact of facts) {
    wasmPushU32Leb(bytes, fact.functionIndex);
  }
  return bytes;
}

function wasmExportPayloadBytes(
  facts: WasmFunctionByteFact[],
  exportCount: number,
): number[] {
  const bytes: number[] = [];
  wasmPushU32Leb(bytes, exportCount);
  for (const fact of facts) {
    if (!fact.public) continue;
    wasmPushNameBytes(bytes, fact.name);
    wasmPushByte(bytes, 0);
    wasmPushU32Leb(bytes, fact.functionIndex);
  }
  return bytes;
}

function wasmCodePayloadBytes(facts: WasmFunctionByteFact[]): number[] {
  const bytes: number[] = [];
  wasmPushU32Leb(bytes, facts.length);
  for (const fact of facts) {
    wasmPushU32Leb(bytes, fact.bodySize);
    wasmPushLocalDecls(bytes, fact.localCount);
    for (const instruction of fact.bodyInstructions) {
      wasmPushInstruction(bytes, instruction.opcode, instruction.immediate);
    }
    wasmPushInstruction(bytes, fact.terminatorOpcode, 0);
    wasmPushByte(bytes, 11);
  }
  return bytes;
}

function wasmPushNameBytes(bytes: number[], name: string) {
  wasmPushU32Leb(bytes, name.length);
  for (let index = 0; index < name.length; index++) {
    wasmPushByte(bytes, name.charCodeAt(index));
  }
}

function wasmPushInstruction(bytes: number[], opcode: number, immediate: number) {
  wasmPushByte(bytes, opcode);
  if (wasmInstructionSize(opcode) > 1) {
    wasmPushByte(bytes, immediate);
  }
}

function wasmPushSection(bytes: number[], sectionId: number, payload: number[]) {
  wasmPushByte(bytes, sectionId);
  wasmPushU32Leb(bytes, payload.length);
  for (const byte of payload) {
    wasmPushByte(bytes, byte);
  }
}

function wasmPushU32Leb(bytes: number[], value: number) {
  let current = value;
  let active = true;
  while (active) {
    wasmPushByte(bytes, wasmU32LebByte(current));
    current = Math.floor(current / 128);
    if (current === 0) {
      active = false;
    }
  }
}

function wasmPushLocalDecls(bytes: number[], localCount: number) {
  if (localCount <= 0) {
    wasmPushU32Leb(bytes, 0);
    return;
  }
  wasmPushU32Leb(bytes, 1);
  wasmPushU32Leb(bytes, localCount);
  wasmPushByte(bytes, wasmI32ValType());
}

function wasmPushByte(bytes: number[], value: number) {
  bytes.push(wasmByteValue(value));
}

function wasmByteValue(value: number): number {
  const reduced = value % 256;
  if (reduced < 0) return reduced + 256;
  return reduced;
}

function initialWasmSectionScan(): WasmSectionScan {
  return {
    functionCount: 0,
    exportCount: 0,
    typePayloadSize: 1,
    typePayloadSignature: 0,
    functionPayloadSize: 1,
    functionPayloadSignature: 0,
    exportPayloadSize: 1,
    exportPayloadSignature: 0,
    codePayloadSize: 1,
    codePayloadSignature: 0,
    diagnosticSignature: 0,
  };
}

function programWasmSectionScan(
  program: Program,
  environment: Map<string, number>,
): WasmSectionScan {
  const scan = initialWasmSectionScan();
  const symbolEnvironment = programResolvedSymbolTypeEnvironment(program, environment);
  const functionReturnEnvironment = programFunctionReturnTypeEnvironment(program, environment);
  const functionIndexEnvironment = programFunctionIndexEnvironment(program);
  const functionRuntimeParamCountEnvironment =
    programFunctionRuntimeParamCountEnvironment(program);
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    const functionIndex = scan.functionCount;
    const expected = declarationResolvedExpectedBodyTypeClassTag(decl, environment);
    const actual = declarationResolvedBodyTypeClassTag(
      decl,
      symbolEnvironment,
      environment,
      functionReturnEnvironment,
    );
    const bodyAbi = abiClassFromTypeClass(actual);
    const bodyPlan = wasmBodyPlanForDeclaration(
      bodyAbi,
      decl,
      environment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    const resultValType = wasmValTypeForAbi(abiClassFromTypeClass(expected));
    const terminatorOpcode = wasmTerminatorOpcode(resultValType);
    const localCount = declarationFunctionLocalLetCount(decl);
    const bodySize = wasmFunctionBodySize(
      localCount,
      bodyPlan.byteSize,
      terminatorOpcode,
    );
    const runtimeParamCount = declarationRuntimeParamCount(decl);
    const diagnosticCode = diagnosticCodeForTypeCheckStatus(
      simpleBodyTypeCheckStatus(expected, actual),
    );
    scan.functionCount += 1;
    scan.typePayloadSize += wasmTypeEntrySize(runtimeParamCount, resultValType);
    scan.typePayloadSignature = signatureMix(
      scan.typePayloadSignature,
      wasmTypeEntrySignature(runtimeParamCount, resultValType),
    );
    scan.functionPayloadSize += 1;
    scan.functionPayloadSignature = signatureMix(
      scan.functionPayloadSignature,
      functionIndex,
    );
    scan.codePayloadSize += wasmCodeEntrySize(bodySize);
    scan.codePayloadSignature = signatureMix(
      scan.codePayloadSignature,
      wasmCodeEntrySignature(
        localCount,
        bodyPlan.firstOpcode,
        bodyPlan.firstImmediate,
        terminatorOpcode,
        bodySize,
      ),
    );
    scan.diagnosticSignature = signatureMix(
      scan.diagnosticSignature,
      diagnosticCode,
    );
    if (decl.public) {
      scan.exportCount += 1;
      const name = primaryDeclarationName(decl);
      scan.exportPayloadSize += wasmExportEntrySize(name.length);
      scan.exportPayloadSignature = signatureMix(
        scan.exportPayloadSignature,
        wasmExportEntrySignature(textHash(name), functionIndex),
      );
    }
  }
  return scan;
}

function wasmSectionRecordFinalSignature(scan: WasmSectionScan): number {
  let total = 0;
  total = signatureMix(
    total,
    wasmSectionRecordFactHash({
      sectionId: wasmTypeSectionId(),
      itemCount: scan.functionCount,
      payloadSize: scan.typePayloadSize,
      payloadSignature: scan.typePayloadSignature,
      diagnosticSignature: scan.diagnosticSignature,
    }),
  );
  total = signatureMix(
    total,
    wasmSectionRecordFactHash({
      sectionId: wasmFunctionSectionId(),
      itemCount: scan.functionCount,
      payloadSize: scan.functionPayloadSize,
      payloadSignature: scan.functionPayloadSignature,
      diagnosticSignature: scan.diagnosticSignature,
    }),
  );
  total = signatureMix(
    total,
    wasmSectionRecordFactHash({
      sectionId: wasmExportSectionId(),
      itemCount: scan.exportCount,
      payloadSize: scan.exportPayloadSize,
      payloadSignature: scan.exportPayloadSignature,
      diagnosticSignature: scan.diagnosticSignature,
    }),
  );
  total = signatureMix(
    total,
    wasmSectionRecordFactHash({
      sectionId: wasmCodeSectionId(),
      itemCount: scan.functionCount,
      payloadSize: scan.codePayloadSize,
      payloadSignature: scan.codePayloadSignature,
      diagnosticSignature: scan.diagnosticSignature,
    }),
  );
  return total;
}

function wasmByteRecordFinalSignature(scan: WasmSectionScan): number {
  const typeSectionSize = wasmSectionTotalSize(scan.typePayloadSize);
  const functionSectionSize = wasmSectionTotalSize(scan.functionPayloadSize);
  const exportSectionSize = wasmSectionTotalSize(scan.exportPayloadSize);
  const codeSectionSize = wasmSectionTotalSize(scan.codePayloadSize);
  const byteSize = wasmModuleHeaderSize() + typeSectionSize +
    functionSectionSize + exportSectionSize + codeSectionSize;
  let sectionSignature = 0;
  sectionSignature = signatureMix(
    sectionSignature,
    wasmByteSectionRecordFactHash(
      wasmByteSectionRecordFact(
        wasmTypeSectionId(),
        scan.typePayloadSize,
        scan.typePayloadSignature,
        scan.diagnosticSignature,
      ),
    ),
  );
  sectionSignature = signatureMix(
    sectionSignature,
    wasmByteSectionRecordFactHash(
      wasmByteSectionRecordFact(
        wasmFunctionSectionId(),
        scan.functionPayloadSize,
        scan.functionPayloadSignature,
        scan.diagnosticSignature,
      ),
    ),
  );
  sectionSignature = signatureMix(
    sectionSignature,
    wasmByteSectionRecordFactHash(
      wasmByteSectionRecordFact(
        wasmExportSectionId(),
        scan.exportPayloadSize,
        scan.exportPayloadSignature,
        scan.diagnosticSignature,
      ),
    ),
  );
  sectionSignature = signatureMix(
    sectionSignature,
    wasmByteSectionRecordFactHash(
      wasmByteSectionRecordFact(
        wasmCodeSectionId(),
        scan.codePayloadSize,
        scan.codePayloadSignature,
        scan.diagnosticSignature,
      ),
    ),
  );
  return wasmByteModuleRecordFactHash({
    magicSignature: wasmMagicSignature(),
    versionSignature: wasmVersionSignature(),
    sectionCount: wasmEmittedSectionCount(),
    byteSize,
    sectionSignature,
    diagnosticSignature: scan.diagnosticSignature,
  });
}

function programResolvedSimpleBodyTypeCheckSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  let total = 0;
  const symbolEnvironment = programResolvedSymbolTypeEnvironment(program, environment);
  const functionReturnEnvironment = programFunctionReturnTypeEnvironment(program, environment);
  for (const _item of program.sourceImports ?? []) {
    total = signatureMix(
      total,
      simpleBodyTypeCheckHash(
        5,
        typeClassUnknownTag(),
        typeClassUnknownTag(),
        typeCheckUnknownTag(),
      ),
    );
  }
  for (const decl of program.declarations) {
    const kindTag = declarationKindTag(decl.kind);
    const expected = declarationResolvedExpectedBodyTypeClassTag(decl, environment);
    const actual = declarationResolvedBodyTypeClassTag(
      decl,
      symbolEnvironment,
      environment,
      functionReturnEnvironment,
    );
    const status = simpleBodyTypeCheckStatus(expected, actual);
    total = signatureMix(
      total,
      simpleBodyTypeCheckHash(kindTag, expected, actual, status),
    );
  }
  return total;
}

function programCheckedDeclarationTypeSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  return factTripleSignatureHash(
    checkedDeclarationTypeFactTag(),
    programResolvedDeclaredTypeClassSignatureHash(program, environment),
    programResolvedValueBodyTypeClassSignatureHash(program, environment),
    programResolvedSimpleBodyTypeCheckSignatureHash(program, environment),
  );
}

function programCheckedDiagnosticSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  return factPairSignatureHash(
    checkedDiagnosticFactTag(),
    programSimpleBodyTypeCheckSignatureHash(program),
    programResolvedSimpleBodyTypeCheckSignatureHash(program, environment),
  );
}

function programLoweredDeclarationSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  return factTripleSignatureHash(
    loweredDeclarationFactTag(),
    programResolvedDeclaredAbiClassSignatureHash(program, environment),
    programResolvedValueBodyAbiClassSignatureHash(program, environment),
    programResolvedExportAbiSignatureHash(program, environment),
  );
}

function programCheckedDeclarationRecordSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  let total = 0;
  const symbolEnvironment = programResolvedSymbolTypeEnvironment(program, environment);
  const functionReturnEnvironment = programFunctionReturnTypeEnvironment(program, environment);
  for (const item of program.sourceImports ?? []) {
    const alias = item.alias ?? "";
    total = signatureMix(
      total,
      checkedDeclarationRecordFactHash({
        kindTag: 5,
        nameHash: textHash(alias),
        symbolTypeClass: typeClassUnknownTag(),
        symbolPayload: 0,
        expectedTypeClass: typeClassUnknownTag(),
        actualTypeClass: typeClassUnknownTag(),
        checkStatus: typeCheckUnknownTag(),
        diagnosticCode: diagnosticCodeForTypeCheckStatus(typeCheckUnknownTag()),
        loweredAbiClass: abiClassVoidTag(),
      }),
    );
  }
  for (const decl of program.declarations) {
    const expected = declarationResolvedExpectedBodyTypeClassTag(decl, environment);
    const actual = declarationResolvedBodyTypeClassTag(
      decl,
      symbolEnvironment,
      environment,
      functionReturnEnvironment,
    );
    total = signatureMix(
      total,
      checkedDeclarationRecordFactHash({
        kindTag: declarationKindTag(decl.kind),
        nameHash: textHash(primaryDeclarationName(decl)),
        symbolTypeClass: declarationResolvedTypeClassTag(decl, environment),
        symbolPayload: declarationResolvedTypeClassPayload(decl, environment),
        expectedTypeClass: expected,
        actualTypeClass: actual,
        checkStatus: simpleBodyTypeCheckStatus(expected, actual),
        diagnosticCode: diagnosticCodeForTypeCheckStatus(
          simpleBodyTypeCheckStatus(expected, actual),
        ),
        loweredAbiClass: declarationResolvedAbiClassTag(decl, environment),
      }),
    );
  }
  return total;
}

function programCheckedExpressionRecordSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  let total = 0;
  const symbolEnvironment = programResolvedSymbolTypeEnvironment(program, environment);
  const functionReturnEnvironment = programFunctionReturnTypeEnvironment(program, environment);
  for (const item of program.sourceImports ?? []) {
    const alias = item.alias ?? "";
    total = signatureMix(
      total,
      checkedExpressionRecordFactHash({
        kindTag: 5,
        nameHash: textHash(alias),
        rootKind: expressionRootNoneTag(),
        rootHash: 0,
        rootChildCount: 0,
        rootChildSignatureHash: 0,
        rootGrandchildCount: 0,
        rootGrandchildSignatureHash: 0,
        rootDescendantCount: 0,
        rootDescendantSignatureHash: 0,
        rootTypeClass: typeClassUnknownTag(),
        resolvedTypeClass: typeClassUnknownTag(),
        expectedTypeClass: typeClassUnknownTag(),
        checkStatus: typeCheckUnknownTag(),
        diagnosticCode: diagnosticCodeForTypeCheckStatus(typeCheckUnknownTag()),
        loweredValueTag: loweredValueVoidTag(),
        loweredValuePrimary: 0,
        loweredValueSecondary: 0,
      }),
    );
  }
  for (const decl of program.declarations) {
    const expected = declarationResolvedExpectedBodyTypeClassTag(decl, environment);
    const resolved = declarationResolvedBodyTypeClassTag(
      decl,
      symbolEnvironment,
      environment,
      functionReturnEnvironment,
    );
    const abiClass = abiClassFromTypeClass(resolved);
    const body = declarationExpressionShapeBody(decl);
    const rootChildren = declarationExpressionRootChildExpressions(decl);
    total = signatureMix(
      total,
      checkedExpressionRecordFactHash({
        kindTag: declarationKindTag(decl.kind),
        nameHash: textHash(primaryDeclarationName(decl)),
        rootKind: expressionRootHeadKindTag(body),
        rootHash: expressionRootHeadHash(body),
        rootChildCount: rootChildren.length,
        rootChildSignatureHash: expressionRootChildSignatureHashFromChildren(rootChildren),
        rootGrandchildCount: expressionRootGrandchildCountFromChildren(rootChildren),
        rootGrandchildSignatureHash: expressionRootGrandchildSignatureHashFromChildren(
          rootChildren,
        ),
        rootDescendantCount: expressionRootDescendantCountFromChildren(rootChildren),
        rootDescendantSignatureHash: expressionRootDescendantSignatureHashFromChildren(
          rootChildren,
        ),
        rootTypeClass: declarationBodyTypeClassTag(decl),
        resolvedTypeClass: resolved,
        expectedTypeClass: expected,
        checkStatus: simpleBodyTypeCheckStatus(expected, resolved),
        diagnosticCode: diagnosticCodeForTypeCheckStatus(
          simpleBodyTypeCheckStatus(expected, resolved),
        ),
        loweredValueTag: loweredValueTagForAbi(abiClass),
        loweredValuePrimary: loweredValuePrimary(abiClass, resolved),
        loweredValueSecondary: loweredValueSecondary(),
      }),
    );
  }
  return total;
}

function programCheckedExpressionChildRecordSignatureHash(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    total = checkedExpressionChildRecordSignatureAppendRecords(
      total,
      declarationKindTag(decl.kind),
      textHash(primaryDeclarationName(decl)),
      0,
      declarationExpressionRootChildRecords(decl),
    ).total;
  }
  return total;
}

type CheckedExpressionChildRecordState = {
  total: number;
  childIndex: number;
};

function checkedExpressionChildRecordSignatureAppend(
  total: number,
  parentKindTag: number,
  parentNameHash: number,
  childIndex: number,
  expr: Expr | undefined,
): CheckedExpressionChildRecordState {
  return checkedExpressionChildRecordSignatureAppendRecords(
    total,
    parentKindTag,
    parentNameHash,
    childIndex,
    expressionRootChildRecords(expr),
  );
}

function checkedExpressionChildRecordSignatureAppendRecords(
  total: number,
  parentKindTag: number,
  parentNameHash: number,
  childIndex: number,
  records: ExpressionRootChildRecord[],
): CheckedExpressionChildRecordState {
  let state = {
    total,
    childIndex,
  };
  for (const child of records) {
    state = {
      total: signatureMix(
        state.total,
        checkedExpressionChildRecordFactHash({
          parentKindTag,
          parentNameHash,
          childIndex: state.childIndex,
          childRoleTag: child.roleTag,
          childLabelHash: child.labelHash,
          childRootKind: expressionRootHeadKindTag(child.value),
          childRootHash: expressionRootHeadHash(child.value),
          childRootTypeClass: expressionRootTypeClassTag(child.value),
          childChildCount: expressionRootChildCount(child.value),
          childDescendantCount: expressionRootDescendantCount(child.value),
        }),
      ),
      childIndex: state.childIndex + 1,
    };
    state = checkedExpressionChildRecordSignatureAppend(
      state.total,
      parentKindTag,
      parentNameHash,
      state.childIndex,
      child.value,
    );
  }
  return state;
}

function programCheckedLocalEnvironmentSignatureHash(
  program: Program,
  environment: Map<string, number>,
): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    const functionNameHash = textHash(primaryDeclarationName(decl));
    for (const statement of decl.body.statements) {
      const fact = checkedLocalEnvironmentFact(
        functionNameHash,
        statement,
        environment,
      );
      if (fact === undefined) {
        continue;
      }
      total = signatureMix(total, checkedLocalEnvironmentFactHash(fact));
    }
  }
  return total;
}

function checkedLocalEnvironmentFact(
  functionNameHash: number,
  statement: Statement,
  environment: Map<string, number>,
): CheckedLocalEnvironmentFact | undefined {
  if (statement.kind === "let") {
    const expected = typeClassFromAnnotation(statement.type, environment);
    const actual = expressionRootTypeClassTag(statement.value);
    return {
      functionNameHash,
      localKindTag: checkedLocalLetTag(),
      localNameHash: textHash(statement.name),
      valueRootKind: expressionRootHeadKindTag(statement.value),
      valueRootHash: expressionRootHeadHash(statement.value),
      expectedTypeClass: expected,
      actualTypeClass: actual,
      checkStatus: simpleBodyTypeCheckStatus(expected, actual),
      diagnosticCode: diagnosticCodeForTypeCheckStatus(
        simpleBodyTypeCheckStatus(expected, actual),
      ),
    };
  }
  if (statement.kind === "destructure_let") {
    const expected = typeClassUnknownTag();
    const actual = expressionRootTypeClassTag(statement.value);
    return {
      functionNameHash,
      localKindTag: checkedLocalLetTag(),
      localNameHash: 0,
      valueRootKind: expressionRootHeadKindTag(statement.value),
      valueRootHash: expressionRootHeadHash(statement.value),
      expectedTypeClass: expected,
      actualTypeClass: actual,
      checkStatus: simpleBodyTypeCheckStatus(expected, actual),
      diagnosticCode: diagnosticCodeForTypeCheckStatus(
        simpleBodyTypeCheckStatus(expected, actual),
      ),
    };
  }
  if (statement.kind === "type_assert") {
    const typeValue = typeClassTypeValueTag();
    return {
      functionNameHash,
      localKindTag: checkedLocalTypeAssertTag(),
      localNameHash: 0,
      valueRootKind: expressionRootNoneTag(),
      valueRootHash: 0,
      expectedTypeClass: typeValue,
      actualTypeClass: typeValue,
      checkStatus: simpleBodyTypeCheckStatus(typeValue, typeValue),
      diagnosticCode: diagnosticCodeForTypeCheckStatus(
        simpleBodyTypeCheckStatus(typeValue, typeValue),
      ),
    };
  }
  return undefined;
}

function programCheckedExpressionShapeSignatureHash(
  program: Program,
  environment: Map<string, number>,
  tokens: SourceToken[],
): number {
  let total = 0;
  const symbolEnvironment = programResolvedSymbolTypeEnvironment(program, environment);
  const functionReturnEnvironment = programFunctionReturnTypeEnvironment(program, environment);
  for (const item of program.sourceImports ?? []) {
    const alias = item.alias ?? "";
    total = signatureMix(
      total,
      checkedExpressionShapeFactHash({
        kindTag: 5,
        nameHash: textHash(alias),
        rootKind: expressionRootNoneTag(),
        rootHash: 0,
        rootSelectorCount: 0,
        rootSlotCount: 0,
        rootCallArgCount: noRootCallArgCount(),
        rootFieldCount: 0,
        rootOperatorCount: 0,
        operatorCount: 0,
        operatorSignatureHash: 0,
        matchCount: 0,
        matchArmCount: 0,
        doCount: 0,
        doBindCount: 0,
        pipeBindCount: 0,
        callCount: 0,
        functionMatchBodyCount: 0,
        nameTokenCount: 0,
        nameTokenSignatureHash: 0,
        literalTokenCount: 0,
        literalTokenSignatureHash: 0,
        diagnosticCode: diagnosticCodeForTypeCheckStatus(typeCheckUnknownTag()),
      }),
    );
  }
  for (const decl of program.declarations) {
    total = signatureMix(
      total,
      checkedExpressionShapeFactHash(
        declarationExpressionShapeFact(
          decl,
          symbolEnvironment,
          environment,
          functionReturnEnvironment,
          tokens,
        ),
      ),
    );
  }
  return total;
}

function declarationExpressionShapeFact(
  decl: Program["declarations"][number],
  symbolEnvironment: Map<string, number>,
  environment: Map<string, number>,
  functionReturnEnvironment: Map<string, number>,
  tokens: SourceToken[],
): CheckedExpressionShapeFact {
  const body = declarationExpressionShapeBody(decl);
  const expected = declarationResolvedExpectedBodyTypeClassTag(decl, environment);
  const actual = declarationResolvedBodyTypeClassTag(
    decl,
    symbolEnvironment,
    environment,
    functionReturnEnvironment,
  );
  const status = simpleBodyTypeCheckStatus(expected, actual);
  return {
    kindTag: declarationKindTag(decl.kind),
    nameHash: textHash(primaryDeclarationName(decl)),
    rootKind: expressionRootHeadKindTag(body),
    rootHash: expressionRootHeadHash(body),
    rootSelectorCount: expressionRootHeadSelectorCount(body),
    rootSlotCount: expressionRootSlotCount(body),
    rootCallArgCount: expressionRootCallArgCount(body),
    rootFieldCount: expressionRootFieldCount(body),
    rootOperatorCount: expressionRootOperatorCount(body),
    operatorCount: expressionOperatorCount(body),
    operatorSignatureHash: expressionOperatorTokenSignatureHash(tokens, body?.span, 0),
    matchCount: expressionMatchCount(body),
    matchArmCount: expressionMatchArmCount(body),
    doCount: expressionDoCount(body),
    doBindCount: expressionDoBindCount(body),
    pipeBindCount: expressionPipeBindCount(body),
    callCount: expressionCallCount(body),
    functionMatchBodyCount: declarationFunctionMatchBodyCount(decl),
    nameTokenCount: expressionNameTokenCount(tokens, body?.span),
    nameTokenSignatureHash: expressionNameTokenSignatureHash(tokens, body?.span),
    literalTokenCount: expressionLiteralTokenCount(tokens, body?.span),
    literalTokenSignatureHash: expressionLiteralTokenSignatureHash(tokens, body?.span),
    diagnosticCode: diagnosticCodeForTypeCheckStatus(status),
  };
}

function declarationExpressionShapeBody(
  decl: Program["declarations"][number],
): Expr | undefined {
  if (decl.kind === "fn") {
    return decl.body;
  }
  if (decl.kind === "let" || decl.kind === "const") {
    return decl.value;
  }
  return undefined;
}

function declarationExpressionRootChildExpressions(
  decl: Program["declarations"][number],
): Expr[] {
  const body = declarationExpressionShapeBody(decl);
  const root = expressionRoot(body);
  if (decl.kind === "fn" && decl.matchBody === true && root?.kind === "match") {
    return expressionRootMatchArmChildExpressions(root);
  }
  return expressionRootChildExpressions(body);
}

function declarationExpressionRootChildRecords(
  decl: Program["declarations"][number],
): ExpressionRootChildRecord[] {
  const body = declarationExpressionShapeBody(decl);
  const root = expressionRoot(body);
  if (decl.kind === "fn" && decl.matchBody === true && root?.kind === "match") {
    return expressionRootMatchArmChildRecords(root);
  }
  return expressionRootChildRecords(body);
}

function declarationFunctionMatchBodyCount(decl: Program["declarations"][number]): number {
  if (decl.kind !== "fn") {
    return 0;
  }
  if (decl.matchBody === true) {
    return 1;
  }
  return 0;
}

function declarationTypeClassTag(decl: Program["declarations"][number]): number {
  if (decl.kind === "fn") {
    return typeClassFunctionTag();
  }
  if (decl.kind === "let" || decl.kind === "const") {
    return typeClassFromAnnotation(decl.type);
  }
  if (decl.kind === "type") {
    return typeClassFromTypeResultKind(decl.resultKind);
  }
  return typeClassUnknownTag();
}

function declarationResolvedTypeClassTag(
  decl: Program["declarations"][number],
  environment: Map<string, number>,
): number {
  if (decl.kind === "fn") {
    return typeClassFunctionTag();
  }
  if (decl.kind === "let" || decl.kind === "const") {
    return typeClassFromAnnotation(decl.type, environment);
  }
  if (decl.kind === "type") {
    const typeClass = environment.get(primaryDeclarationName(decl));
    if (typeClass !== undefined) {
      return typeClass;
    }
    return typeClassFromTypeResultKind(decl.resultKind);
  }
  return typeClassUnknownTag();
}

function declarationResolvedTypeClassPayload(
  decl: Program["declarations"][number],
  environment: Map<string, number>,
): number {
  if (decl.kind !== "fn") {
    return 0;
  }
  return decl.params.length * 31 + typeClassFromAnnotation(decl.returnType, environment);
}

function declarationExpectedBodyTypeClassTag(decl: Program["declarations"][number]): number {
  if (decl.kind === "fn") {
    return typeClassFromAnnotation(decl.returnType);
  }
  if (decl.kind === "let" || decl.kind === "const") {
    return typeClassFromAnnotation(decl.type);
  }
  return typeClassUnknownTag();
}

function declarationResolvedExpectedBodyTypeClassTag(
  decl: Program["declarations"][number],
  environment: Map<string, number>,
): number {
  if (decl.kind === "fn") {
    return typeClassFromAnnotation(decl.returnType, environment);
  }
  if (decl.kind === "let" || decl.kind === "const") {
    return typeClassFromAnnotation(decl.type, environment);
  }
  return typeClassUnknownTag();
}

function declarationBodyTypeClassTag(decl: Program["declarations"][number]): number {
  if (decl.kind === "fn") {
    return expressionRootTypeClassTag(decl.body);
  }
  if (decl.kind === "let" || decl.kind === "const") {
    return expressionRootTypeClassTag(decl.value);
  }
  return typeClassUnknownTag();
}

function declarationResolvedBodyTypeClassTag(
  decl: Program["declarations"][number],
  symbolEnvironment: Map<string, number>,
  typeEnvironment: Map<string, number>,
  functionReturnEnvironment?: Map<string, number>,
): number {
  if (decl.kind === "fn") {
    const bodyEnvironment = functionBodyTypeEnvironment(
      decl,
      typeEnvironment,
      functionReturnEnvironment,
    );
    const root = expressionRoot(decl.body);
    if (decl.matchBody === true && root?.kind === "match") {
      const matchBodyTypeClass = declarationFunctionMatchBodyLiteralResultTypeClassTag(decl);
      if (matchBodyTypeClass !== typeClassUnknownTag()) {
        return matchBodyTypeClass;
      }
      return typeClassUnknownTag();
    }
    const typeClass = expressionRootResolvedTypeClassTag(
      decl.body,
      bodyEnvironment,
      functionReturnEnvironment,
    );
    if (typeClass !== typeClassUnknownTag()) {
      return typeClass;
    }
    if (root?.kind === "var") {
      return declarationLocalLetTypeClass(
        decl,
        root.name,
        typeEnvironment,
        functionReturnEnvironment,
      );
    }
    return typeClassUnknownTag();
  }
  if (decl.kind === "let" || decl.kind === "const") {
    return expressionRootResolvedTypeClassTag(
      decl.value,
      symbolEnvironment,
      functionReturnEnvironment,
    );
  }
  return typeClassUnknownTag();
}

function declarationFunctionMatchBodyLiteralResultTypeClassTag(
  decl: Program["declarations"][number],
): number {
  if (decl.kind !== "fn") {
    return typeClassUnknownTag();
  }
  if (decl.matchBody !== true) {
    return typeClassUnknownTag();
  }
  const root = expressionRoot(decl.body);
  if (root === undefined) {
    return typeClassUnknownTag();
  }
  if (root.kind !== "match") {
    return typeClassUnknownTag();
  }
  let resultTypeClass = typeClassUnknownTag();
  let armCount = 0;
  for (const arm of root.arms) {
    if (arm.guard !== undefined) {
      return typeClassUnknownTag();
    }
    const armTypeClass = expressionSimpleLiteralTypeClassTag(arm.value);
    if (armTypeClass === typeClassUnknownTag()) {
      return typeClassUnknownTag();
    }
    if (resultTypeClass === typeClassUnknownTag()) {
      resultTypeClass = armTypeClass;
    } else if (resultTypeClass !== armTypeClass) {
      return typeClassUnknownTag();
    }
    armCount += 1;
  }
  if (armCount === 0) {
    return typeClassUnknownTag();
  }
  return resultTypeClass;
}

function functionParamTypeEnvironment(
  params: Param[],
  typeEnvironment: Map<string, number>,
): Map<string, number> {
  const environment = new Map<string, number>();
  for (const param of params) {
    environment.set(paramSignatureName(param), typeClassFromAnnotation(param.type, typeEnvironment));
  }
  return environment;
}

function functionBodyTypeEnvironment(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  typeEnvironment: Map<string, number>,
  functionReturnEnvironment?: Map<string, number>,
): Map<string, number> {
  const environment = functionParamTypeEnvironment(decl.params, typeEnvironment);
  for (const statement of decl.body.statements) {
    if (statement.kind !== "let") {
      continue;
    }
    const typeClass = declarationLocalLetTypeClass(
      decl,
      statement.name,
      typeEnvironment,
      functionReturnEnvironment,
    );
    if (typeClass === typeClassUnknownTag()) {
      continue;
    }
    environment.set(statement.name, typeClass);
  }
  return environment;
}

function expressionRoot(expr: Expr | undefined): Expr | undefined {
  if (expr === undefined) {
    return undefined;
  }
  if (expr.kind === "block") {
    return expr.expr;
  }
  return expr;
}

function expressionTypeRoot(expr: Expr | undefined): Expr | undefined {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return undefined;
  }
  if (root.kind === "call") {
    const isParenthesizedExpression = root.args.length === 0 && root.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return expressionTypeRoot(root.callee);
    }
  }
  return root;
}

function expressionRootHeadKindTag(expr: Expr | undefined): number {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return expressionRootNoneTag();
  }
  if (root.kind === "literal") {
    if (root.literalKind === "number") {
      return expressionRootNumberTag();
    }
    if (root.literalKind === "bool") {
      return expressionRootBoolTag();
    }
    if (root.literalKind === "literalType") {
      return expressionRootLiteralTypeTag();
    }
    return expressionRootTextTag();
  }
  if (root.kind === "var") {
    return expressionRootNamedHeadKindTag(root.name);
  }
  if (root.kind === "const_fn") {
    return expressionRootConstFunctionTag();
  }
  if (root.kind === "match") {
    return expressionRootMatchTag();
  }
  if (root.kind === "do") {
    return expressionRootDoTag();
  }
  if (root.kind === "shape") {
    if (root.syntax === "collection") {
      return expressionRootNoneTag();
    }
    return expressionRootShapeTag();
  }
  if (root.kind === "product_constructor") {
    if (expressionHeadNameIsQualified(root.constructor)) {
      return expressionRootNamedHeadKindTag(root.constructor);
    }
    return expressionRootProductConstructorTag();
  }
  if (root.kind === "pipe_bind") {
    return expressionRootHeadKindTag(root.value);
  }
  if (root.kind === "call") {
    const isParenthesizedExpression = root.args.length === 0 && root.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return expressionRootNoneTag();
    }
    return expressionRootHeadKindTag(root.callee);
  }
  if (root.kind === "field") {
    return expressionRootHeadKindTag(root.value);
  }
  if (root.kind === "index") {
    return expressionRootHeadKindTag(root.target);
  }
  if (root.kind === "binary") {
    return expressionRootHeadKindTag(root.left);
  }
  if (root.kind === "operator_chain") {
    return expressionRootHeadKindTag(root.first);
  }
  if (root.kind === "range") {
    return expressionRootHeadKindTag(root.start);
  }
  return expressionRootNoneTag();
}

function expressionRootHeadHash(expr: Expr | undefined): number {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return 0;
  }
  if (root.kind === "literal") {
    if (root.literalKind === "number" || root.literalKind === "bool") {
      return textHash(root.value);
    }
    if (root.literalKind === "literalType") {
      return textHash(root.value);
    }
    return 0;
  }
  if (root.kind === "var") {
    return textHash(expressionLexicalHeadName(root.name));
  }
  if (root.kind === "product_constructor") {
    return textHash(expressionLexicalHeadName(root.constructor));
  }
  if (root.kind === "pipe_bind") {
    return expressionRootHeadHash(root.value);
  }
  if (root.kind === "call") {
    const isParenthesizedExpression = root.args.length === 0 && root.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return 0;
    }
    return expressionRootHeadHash(root.callee);
  }
  if (root.kind === "field") {
    return expressionRootHeadHash(root.value);
  }
  if (root.kind === "index") {
    return expressionRootHeadHash(root.target);
  }
  if (root.kind === "binary") {
    return expressionRootHeadHash(root.left);
  }
  if (root.kind === "operator_chain") {
    return expressionRootHeadHash(root.first);
  }
  if (root.kind === "range") {
    return expressionRootHeadHash(root.start);
  }
  return 0;
}

function expressionRootQualifiedHeadHash(expr: Expr | undefined): number | undefined {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return undefined;
  }
  if (root.kind === "var") {
    return expressionQualifiedHeadNameHash(root.name);
  }
  if (root.kind === "product_constructor") {
    return expressionQualifiedHeadNameHash(root.constructor);
  }
  if (root.kind === "pipe_bind") {
    return expressionRootQualifiedHeadHash(root.value);
  }
  if (root.kind === "call") {
    const isParenthesizedExpression = root.args.length === 0 && root.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return undefined;
    }
    return expressionRootQualifiedHeadHash(root.callee);
  }
  if (root.kind === "field") {
    return expressionRootQualifiedHeadHash(root.value);
  }
  if (root.kind === "index") {
    return expressionRootQualifiedHeadHash(root.target);
  }
  if (root.kind === "binary") {
    return expressionRootQualifiedHeadHash(root.left);
  }
  if (root.kind === "operator_chain") {
    return expressionRootQualifiedHeadHash(root.first);
  }
  if (root.kind === "range") {
    return expressionRootQualifiedHeadHash(root.start);
  }
  return undefined;
}

function expressionQualifiedHeadNameHash(name: string): number | undefined {
  const segments = name.split(/(?:::|\.)/);
  if (!segments.length || segments[0] === "") {
    return undefined;
  }
  let total = textHash(segments[0]);
  const selectorPattern = /(::|\.)/g;
  let selector: RegExpExecArray | null;
  while ((selector = selectorPattern.exec(name)) !== null) {
    const nextStart = selector.index + selector[0].length;
    const nextSelector = name.slice(nextStart).search(/::|\./);
    const nextEnd = nextSelector < 0 ? name.length : nextStart + nextSelector;
    const segment = name.slice(nextStart, nextEnd);
    if (!segment) {
      return undefined;
    }
    const selectorTag = selector[0] === "." ? 1 : 2;
    total = signatureMix(signatureMix(total, selectorTag), textHash(segment));
  }
  return total;
}

function expressionRootChildCount(expr: Expr | undefined): number {
  return expressionRootChildExpressions(expr).length;
}

function expressionRootChildSignatureHash(expr: Expr | undefined): number {
  return expressionRootChildSignatureHashFromChildren(expressionRootChildExpressions(expr));
}

function expressionRootChildSignatureHashFromChildren(children: Expr[]): number {
  let total = 0;
  for (const child of children) {
    total = expressionRootChildSignatureAppend(total, child);
  }
  return total;
}

function expressionRootChildSignatureAppend(total: number, child: Expr): number {
  let next = signatureMix(total, expressionRootHeadKindTag(child));
  next = signatureMix(next, expressionRootHeadHash(child));
  return signatureMix(next, expressionRootTypeClassTag(child));
}

function expressionRootGrandchildCount(expr: Expr | undefined): number {
  return expressionRootGrandchildCountFromChildren(expressionRootChildExpressions(expr));
}

function expressionRootGrandchildCountFromChildren(children: Expr[]): number {
  let total = 0;
  for (const child of children) {
    total += expressionRootChildCount(child);
  }
  return total;
}

function expressionRootGrandchildSignatureHash(expr: Expr | undefined): number {
  return expressionRootGrandchildSignatureHashFromChildren(expressionRootChildExpressions(expr));
}

function expressionRootGrandchildSignatureHashFromChildren(children: Expr[]): number {
  let total = 0;
  for (const child of children) {
    for (const grandchild of expressionRootChildExpressions(child)) {
      total = expressionRootChildSignatureAppend(total, grandchild);
    }
  }
  return total;
}

function expressionRootDescendantCount(expr: Expr | undefined): number {
  return expressionRootDescendantCountFromChildren(expressionRootChildExpressions(expr));
}

function expressionRootDescendantCountFromChildren(children: Expr[]): number {
  let total = 0;
  for (const child of children) {
    total += 1;
    total += expressionRootDescendantCount(child);
  }
  return total;
}

function expressionRootDescendantSignatureHash(expr: Expr | undefined): number {
  return expressionRootDescendantSignatureHashFromChildren(expressionRootChildExpressions(expr));
}

function expressionRootDescendantSignatureHashFromChildren(children: Expr[]): number {
  let total = 0;
  for (const child of children) {
    total = expressionRootChildSignatureAppend(total, child);
    total = expressionRootDescendantSignatureAppend(total, child);
  }
  return total;
}

function expressionRootDescendantSignatureAppend(total: number, expr: Expr): number {
  let next = total;
  for (const child of expressionRootChildExpressions(expr)) {
    next = expressionRootChildSignatureAppend(next, child);
    next = expressionRootDescendantSignatureAppend(next, child);
  }
  return next;
}

type ExpressionRootChildRecord = {
  roleTag: number;
  labelHash: number;
  value: Expr;
};

function expressionRootChildCallRoleTag(): number {
  return 1;
}

function expressionRootChildSlotRoleTag(): number {
  return 2;
}

function expressionRootChildPipeBodyRoleTag(): number {
  return 3;
}

function expressionRootChildDoBindRoleTag(): number {
  return 4;
}

function expressionRootChildDoExprRoleTag(): number {
  return 5;
}

function expressionRootChildDoFinalRoleTag(): number {
  return 6;
}

function expressionRootChildMatchArmRoleTag(): number {
  return 7;
}

function expressionRootChildMatchScrutineeRoleTag(): number {
  return 8;
}

function expressionRootChildMatchGuardRoleTag(): number {
  return 9;
}

function expressionRootChildSlotLabelHash(label: string | undefined): number {
  if (label === undefined) {
    return 0;
  }
  return textHash(label);
}

function expressionRootMatchArmChildRecords(
  root: Extract<Expr, { kind: "match" }>,
): ExpressionRootChildRecord[] {
  const records: ExpressionRootChildRecord[] = [];
  for (const arm of root.arms) {
    if (arm.guard !== undefined) {
      records.push({
        roleTag: expressionRootChildMatchGuardRoleTag(),
        labelHash: 0,
        value: arm.guard,
      });
    }
    records.push({
      roleTag: expressionRootChildMatchArmRoleTag(),
      labelHash: 0,
      value: arm.value,
    });
  }
  return records;
}

function expressionRootMatchArmChildExpressions(
  root: Extract<Expr, { kind: "match" }>,
): Expr[] {
  const children: Expr[] = [];
  for (const arm of root.arms) {
    if (arm.guard !== undefined) {
      children.push(arm.guard);
    }
    children.push(arm.value);
  }
  return children;
}

function expressionRootChildRecords(expr: Expr | undefined): ExpressionRootChildRecord[] {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return [];
  }
  if (root.kind === "shape") {
    if (root.syntax === "collection") {
      return [];
    }
    const records: ExpressionRootChildRecord[] = [];
    for (const slot of root.slots) {
      records.push({
        roleTag: expressionRootChildSlotRoleTag(),
        labelHash: expressionRootChildSlotLabelHash(slot.label),
        value: slot.value,
      });
    }
    return records;
  }
  if (root.kind === "product_constructor") {
    const records: ExpressionRootChildRecord[] = [];
    for (const slot of root.slots) {
      records.push({
        roleTag: expressionRootChildSlotRoleTag(),
        labelHash: expressionRootChildSlotLabelHash(slot.label),
        value: slot.value,
      });
    }
    return records;
  }
  if (root.kind === "call") {
    const isParenthesizedExpression = root.args.length === 0 && root.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return [];
    }
    const calleeArgCount = expressionRootCallArgCount(root.callee);
    if (calleeArgCount !== noRootCallArgCount()) {
      return expressionRootChildRecords(root.callee);
    }
    const records: ExpressionRootChildRecord[] = [];
    for (const arg of root.args) {
      records.push({
        roleTag: expressionRootChildCallRoleTag(),
        labelHash: 0,
        value: arg,
      });
    }
    return records;
  }
  if (root.kind === "match") {
    const records: ExpressionRootChildRecord[] = [];
    records.push({
      roleTag: expressionRootChildMatchScrutineeRoleTag(),
      labelHash: 0,
      value: root.value,
    });
    for (const child of expressionRootMatchArmChildRecords(root)) {
      records.push(child);
    }
    return records;
  }
  if (root.kind === "do") {
    const records: ExpressionRootChildRecord[] = [];
    for (const statement of root.statements) {
      if (statement.kind === "do_bind") {
        records.push({
          roleTag: expressionRootChildDoBindRoleTag(),
          labelHash: 0,
          value: statement.value,
        });
        continue;
      }
      if (statement.kind === "do_expr") {
        records.push({
          roleTag: expressionRootChildDoExprRoleTag(),
          labelHash: 0,
          value: statement.value,
        });
      }
    }
    if (root.expr !== undefined) {
      records.push({
        roleTag: expressionRootChildDoFinalRoleTag(),
        labelHash: 0,
        value: root.expr,
      });
    }
    return records;
  }
  if (root.kind === "pipe_bind") {
    const records: ExpressionRootChildRecord[] = [];
    for (const child of expressionRootChildRecords(root.value)) {
      records.push(child);
    }
    records.push({
      roleTag: expressionRootChildPipeBodyRoleTag(),
      labelHash: 0,
      value: root.body,
    });
    return records;
  }
  if (root.kind === "field") {
    return expressionRootChildRecords(root.value);
  }
  if (root.kind === "index") {
    return expressionRootChildRecords(root.target);
  }
  if (root.kind === "binary") {
    return expressionRootChildRecords(root.left);
  }
  if (root.kind === "operator_chain") {
    return expressionRootChildRecords(root.first);
  }
  if (root.kind === "range") {
    return expressionRootChildRecords(root.start);
  }
  return [];
}

function expressionRootChildExpressions(expr: Expr | undefined): Expr[] {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return [];
  }
  if (root.kind === "shape") {
    if (root.syntax === "collection") {
      return [];
    }
    return root.slots.map((slot) => slot.value);
  }
  if (root.kind === "product_constructor") {
    return root.slots.map((slot) => slot.value);
  }
  if (root.kind === "call") {
    const isParenthesizedExpression = root.args.length === 0 && root.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return [];
    }
    const calleeArgCount = expressionRootCallArgCount(root.callee);
    if (calleeArgCount !== noRootCallArgCount()) {
      return expressionRootChildExpressions(root.callee);
    }
    return root.args;
  }
  if (root.kind === "match") {
    const children: Expr[] = [];
    children.push(root.value);
    for (const child of expressionRootMatchArmChildExpressions(root)) {
      children.push(child);
    }
    return children;
  }
  if (root.kind === "do") {
    const children: Expr[] = [];
    for (const statement of root.statements) {
      if (statement.kind === "do_bind" || statement.kind === "do_expr") {
        children.push(statement.value);
      }
    }
    if (root.expr !== undefined) {
      children.push(root.expr);
    }
    return children;
  }
  if (root.kind === "pipe_bind") {
    const children: Expr[] = [];
    for (const child of expressionRootChildExpressions(root.value)) {
      children.push(child);
    }
    children.push(root.body);
    return children;
  }
  if (root.kind === "field") {
    return expressionRootChildExpressions(root.value);
  }
  if (root.kind === "index") {
    return expressionRootChildExpressions(root.target);
  }
  if (root.kind === "binary") {
    return expressionRootChildExpressions(root.left);
  }
  if (root.kind === "operator_chain") {
    return expressionRootChildExpressions(root.first);
  }
  if (root.kind === "range") {
    return expressionRootChildExpressions(root.start);
  }
  return [];
}

function expressionRootHeadSelectorCount(expr: Expr | undefined): number {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return 0;
  }
  return expressionHeadSelectorCount(root);
}

function expressionHeadSelectorCount(expr: Expr): number {
  if (expr.kind === "var") {
    return expressionHeadNameSelectorCount(expr.name);
  }
  if (expr.kind === "product_constructor") {
    return expressionHeadNameSelectorCount(expr.constructor);
  }
  if (expr.kind === "pipe_bind") {
    return expressionRootHeadSelectorCount(expr.value);
  }
  if (expr.kind === "call") {
    const isParenthesizedExpression = expr.args.length === 0 && expr.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return 0;
    }
    return expressionHeadSelectorCount(expr.callee);
  }
  if (expr.kind === "field") {
    return expressionRootHeadSelectorCount(expr.value);
  }
  if (expr.kind === "index") {
    return expressionRootHeadSelectorCount(expr.target);
  }
  if (expr.kind === "binary") {
    return expressionRootHeadSelectorCount(expr.left);
  }
  if (expr.kind === "operator_chain") {
    return expressionRootHeadSelectorCount(expr.first);
  }
  if (expr.kind === "range") {
    return expressionRootHeadSelectorCount(expr.start);
  }
  return 0;
}

function expressionHeadNameSelectorCount(name: string): number {
  let total = 0;
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    const dotCode = ".".charCodeAt(0);
    if (code === dotCode) {
      total += 1;
      continue;
    }
    const colonCode = ":".charCodeAt(0);
    const nextCode = name.charCodeAt(index + 1);
    if (code === colonCode && nextCode === colonCode) {
      total += 1;
      index += 1;
    }
  }
  return total;
}

function expressionRootSlotCount(expr: Expr | undefined): number {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return 0;
  }
  if (root.kind === "shape") {
    if (root.syntax === "collection") {
      return 0;
    }
    return root.slots.length;
  }
  if (root.kind === "product_constructor") {
    return root.slots.length;
  }
  if (root.kind === "pipe_bind") {
    return expressionRootSlotCount(root.value);
  }
  if (root.kind === "call") {
    const isParenthesizedExpression = root.args.length === 0 && root.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return 0;
    }
    return expressionRootSlotCount(root.callee);
  }
  if (root.kind === "field") {
    return expressionRootSlotCount(root.value);
  }
  if (root.kind === "index") {
    return expressionRootSlotCount(root.target);
  }
  if (root.kind === "binary") {
    return expressionRootSlotCount(root.left);
  }
  if (root.kind === "operator_chain") {
    return expressionRootSlotCount(root.first);
  }
  if (root.kind === "range") {
    return expressionRootSlotCount(root.start);
  }
  return 0;
}

function noRootCallArgCount(): number {
  return 0;
}

function expressionRootCallArgCount(expr: Expr | undefined): number {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return noRootCallArgCount();
  }
  return expressionHeadCallArgCount(root);
}

function expressionRootFieldCount(expr: Expr | undefined): number {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return 0;
  }
  if (root.kind === "field") {
    return 1 + expressionRootFieldCount(root.value);
  }
  if (root.kind === "pipe_bind") {
    return expressionRootFieldCount(root.value);
  }
  if (root.kind === "call") {
    const isParenthesizedExpression = root.args.length === 0 && root.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return 0;
    }
    return expressionRootFieldCount(root.callee);
  }
  if (root.kind === "index") {
    return expressionRootFieldCount(root.target);
  }
  if (root.kind === "binary") {
    return expressionRootFieldCount(root.left);
  }
  if (root.kind === "operator_chain") {
    return expressionRootFieldCount(root.first);
  }
  if (root.kind === "range") {
    return expressionRootFieldCount(root.start);
  }
  return 0;
}

function expressionRootOperatorCount(expr: Expr | undefined): number {
  const root = expressionRoot(expr);
  if (root === undefined) {
    return 0;
  }
  if (root.kind === "operator_chain") {
    return root.rest.length;
  }
  if (root.kind === "pipe_bind") {
    return expressionRootOperatorCount(root.value);
  }
  if (root.kind === "call") {
    const isParenthesizedExpression = root.args.length === 0 && root.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return 0;
    }
    return expressionRootOperatorCount(root.callee);
  }
  if (root.kind === "field") {
    return expressionRootOperatorCount(root.value);
  }
  if (root.kind === "index") {
    return expressionRootOperatorCount(root.target);
  }
  if (root.kind === "binary") {
    return expressionRootOperatorCount(root.left);
  }
  if (root.kind === "range") {
    return expressionRootOperatorCount(root.start);
  }
  return 0;
}

function expressionHeadCallArgCount(expr: Expr): number {
  if (expr.kind === "call") {
    const isParenthesizedExpression = expr.args.length === 0 && expr.callee.kind !== "var";
    if (isParenthesizedExpression) {
      return noRootCallArgCount();
    }
    const calleeArgCount = expressionHeadCallArgCount(expr.callee);
    if (calleeArgCount !== noRootCallArgCount()) {
      return calleeArgCount;
    }
    return expr.args.length + 1;
  }
  if (expr.kind === "pipe_bind") {
    return expressionRootCallArgCount(expr.value);
  }
  if (expr.kind === "field") {
    return expressionRootCallArgCount(expr.value);
  }
  if (expr.kind === "index") {
    return expressionRootCallArgCount(expr.target);
  }
  if (expr.kind === "binary") {
    return expressionRootCallArgCount(expr.left);
  }
  if (expr.kind === "operator_chain") {
    return expressionRootCallArgCount(expr.first);
  }
  if (expr.kind === "range") {
    return expressionRootCallArgCount(expr.start);
  }
  return noRootCallArgCount();
}

function expressionHeadNameIsQualified(name: string): boolean {
  const dotIndex = name.indexOf(".");
  if (dotIndex >= 0) {
    return true;
  }
  return name.indexOf("::") >= 0;
}

function expressionRootNamedHeadKindTag(name: string): number {
  const head = expressionLexicalHeadName(name);
  if (expressionHeadNameIsLiteralType(head)) {
    return expressionRootLiteralTypeTag();
  }
  return expressionRootIdentifierTag();
}

function expressionHeadNameIsLiteralType(name: string): boolean {
  const first = name.charCodeAt(0);
  const upperA = "A".charCodeAt(0);
  const upperZ = "Z".charCodeAt(0);
  if (first >= upperA && first <= upperZ) {
    return true;
  }
  return name.startsWith("#");
}

function expressionLexicalHeadName(name: string): string {
  let end = name.length;
  const dotIndex = name.indexOf(".");
  if (dotIndex >= 0) {
    end = dotIndex;
  }
  const memberIndex = name.indexOf("::");
  if (memberIndex >= 0 && memberIndex < end) {
    end = memberIndex;
  }
  return name.slice(0, end);
}

function expressionRootTypeClassTag(expr: Expr | undefined): number {
  const root = expressionTypeRoot(expr);
  if (root === undefined) {
    return typeClassUnknownTag();
  }
  if (root.kind === "literal") {
    if (root.literalKind === "number") {
      return typeClassI32Tag();
    }
    if (root.literalKind === "bool") {
      return typeClassBoolTag();
    }
    return typeClassUnknownTag();
  }
  if (root.kind === "const_fn") {
    return typeClassFunctionTag();
  }
  if (root.kind === "shape") {
    if (root.syntax === "collection") {
      return typeClassUnknownTag();
    }
    return typeClassProductTag();
  }
  if (root.kind === "product_constructor") {
    return typeClassProductTag();
  }
  return typeClassUnknownTag();
}

function expressionRootResolvedTypeClassTag(
  expr: Expr | undefined,
  environment: Map<string, number>,
  functionReturnEnvironment?: Map<string, number>,
): number {
  const root = expressionTypeRoot(expr);
  if (root === undefined) {
    return typeClassUnknownTag();
  }
  if (root.kind === "var") {
    const typeClass = environment.get(root.name);
    if (typeClass === undefined) {
      return typeClassUnknownTag();
    }
    return typeClass;
  }
  if (root.kind === "call" && root.callee.kind === "var") {
    const returnTypeClass = functionReturnEnvironment?.get(root.callee.name);
    if (returnTypeClass !== undefined) {
      return returnTypeClass;
    }
  }
  const boolMatchTypeClass = expressionSimpleBoolMatchTypeClassTag(
    root,
    environment,
    functionReturnEnvironment,
  );
  if (boolMatchTypeClass !== typeClassUnknownTag()) {
    return boolMatchTypeClass;
  }
  const scalarOperatorTypeClass = expressionSimpleScalarOperatorTypeClassTag(
    root,
    environment,
    functionReturnEnvironment,
  );
  if (scalarOperatorTypeClass !== typeClassUnknownTag()) {
    return scalarOperatorTypeClass;
  }
  return expressionRootTypeClassTag(root);
}

function expressionSimpleLiteralTypeClassTag(expr: Expr | undefined): number {
  const root = expressionTypeRoot(expr);
  if (root === undefined) {
    return typeClassUnknownTag();
  }
  if (root.kind !== "literal") {
    return typeClassUnknownTag();
  }
  if (root.literalKind === "number") {
    return typeClassI32Tag();
  }
  if (root.literalKind === "bool") {
    return typeClassBoolTag();
  }
  return typeClassUnknownTag();
}

type SimpleScalarOperatorExpr = {
  op: string;
  left: Expr;
  right: Expr;
};

function expressionSimpleScalarOperator(expr: Expr | undefined): SimpleScalarOperatorExpr | undefined {
  const root = expressionTypeRoot(expr);
  if (root === undefined) {
    return undefined;
  }
  if (root.kind === "binary") {
    return { op: root.op, left: root.left, right: root.right };
  }
  if (root.kind === "operator_chain") {
    if (root.rest.length !== 1) {
      return undefined;
    }
    const rest = root.rest[0];
    if (rest === undefined) {
      return undefined;
    }
    return { op: rest.op, left: root.first, right: rest.value };
  }
  return undefined;
}

type SimpleBoolMatchExpr = {
  condition: Expr;
  trueValue: Expr;
  falseValue: Expr;
};

function expressionSimpleBoolMatch(expr: Expr | undefined): SimpleBoolMatchExpr | undefined {
  const root = expressionTypeRoot(expr);
  if (root === undefined) {
    return undefined;
  }
  if (root.kind !== "match") {
    return undefined;
  }
  if (root.arms.length !== 2) {
    return undefined;
  }
  let trueValue: Expr | undefined;
  let falseValue: Expr | undefined;
  for (const arm of root.arms) {
    if (arm.guard !== undefined) {
      return undefined;
    }
    if (arm.pattern.kind !== "literal") {
      return undefined;
    }
    if (arm.pattern.literalKind !== "bool") {
      return undefined;
    }
    if (arm.pattern.value === "true") {
      if (trueValue !== undefined) {
        return undefined;
      }
      trueValue = arm.value;
      continue;
    }
    if (arm.pattern.value === "false") {
      if (falseValue !== undefined) {
        return undefined;
      }
      falseValue = arm.value;
      continue;
    }
    return undefined;
  }
  if (trueValue === undefined) {
    return undefined;
  }
  if (falseValue === undefined) {
    return undefined;
  }
  return {
    condition: root.value,
    trueValue,
    falseValue,
  };
}

function expressionSimpleBoolMatchTypeClassTag(
  expr: Expr | undefined,
  environment: Map<string, number>,
  functionReturnEnvironment?: Map<string, number>,
): number {
  const boolMatch = expressionSimpleBoolMatch(expr);
  if (boolMatch === undefined) {
    return typeClassUnknownTag();
  }
  const condition = expressionSimpleScalarOperandTypeClassTag(
    boolMatch.condition,
    environment,
    functionReturnEnvironment,
  );
  if (condition !== typeClassBoolTag()) {
    return typeClassUnknownTag();
  }
  const trueType = expressionSimpleScalarOperandTypeClassTag(
    boolMatch.trueValue,
    environment,
    functionReturnEnvironment,
  );
  if (!typeClassIsScalar(trueType)) {
    return typeClassUnknownTag();
  }
  const falseType = expressionSimpleScalarOperandTypeClassTag(
    boolMatch.falseValue,
    environment,
    functionReturnEnvironment,
  );
  if (trueType !== falseType) {
    return typeClassUnknownTag();
  }
  return trueType;
}

function expressionSimpleScalarOperandTypeClassTag(
  expr: Expr,
  environment: Map<string, number>,
  functionReturnEnvironment?: Map<string, number>,
): number {
  const root = expressionTypeRoot(expr);
  if (root === undefined) {
    return typeClassUnknownTag();
  }
  const operatorTypeClass = expressionSimpleScalarOperatorTypeClassTag(
    expr,
    environment,
    functionReturnEnvironment,
  );
  if (operatorTypeClass !== typeClassUnknownTag()) {
    return operatorTypeClass;
  }
  const boolMatchTypeClass = expressionSimpleBoolMatchTypeClassTag(
    expr,
    environment,
    functionReturnEnvironment,
  );
  if (boolMatchTypeClass !== typeClassUnknownTag()) {
    return boolMatchTypeClass;
  }
  if (root.kind === "literal") {
    if (root.literalKind === "number") {
      return typeClassI32Tag();
    }
    if (root.literalKind === "bool") {
      return typeClassBoolTag();
    }
    return typeClassUnknownTag();
  }
  if (root.kind === "var") {
    const typeClass = environment.get(root.name);
    if (typeClass === undefined) {
      return typeClassUnknownTag();
    }
    return typeClass;
  }
  if (expressionIsBareCall(root)) {
    const returnTypeClass = functionReturnEnvironment?.get(root.callee.name);
    if (returnTypeClass === undefined) {
      return typeClassUnknownTag();
    }
    if (!typeClassIsScalar(returnTypeClass)) {
      return typeClassUnknownTag();
    }
    return returnTypeClass;
  }
  return typeClassUnknownTag();
}

function expressionSimpleScalarOperatorTypeClassTag(
  expr: Expr | undefined,
  environment: Map<string, number>,
  functionReturnEnvironment?: Map<string, number>,
): number {
  const operator = expressionSimpleScalarOperator(expr);
  if (operator === undefined) {
    return typeClassUnknownTag();
  }
  const left = expressionSimpleScalarOperandTypeClassTag(
    operator.left,
    environment,
    functionReturnEnvironment,
  );
  const right = expressionSimpleScalarOperandTypeClassTag(
    operator.right,
    environment,
    functionReturnEnvironment,
  );
  const isArithmetic = operator.op === "+" || operator.op === "-" ||
    operator.op === "*" || operator.op === "/" || operator.op === "%";
  if (isArithmetic) {
    if (left === typeClassI32Tag() && right === typeClassI32Tag()) {
      return typeClassI32Tag();
    }
    return typeClassUnknownTag();
  }
  if (
    operator.op === "<" || operator.op === ">" || operator.op === "<=" ||
    operator.op === ">="
  ) {
    if (left === typeClassI32Tag() && right === typeClassI32Tag()) {
      return typeClassBoolTag();
    }
    return typeClassUnknownTag();
  }
  if (operator.op === "==" || operator.op === "!=") {
    if (typeClassIsScalar(left) && left === right) {
      return typeClassBoolTag();
    }
  }
  return typeClassUnknownTag();
}

function declarationAbiClassTag(decl: Program["declarations"][number]): number {
  if (decl.kind === "fn") {
    return abiClassFunctionTag();
  }
  if (decl.kind === "let" || decl.kind === "const") {
    return abiClassFromTypeClass(typeClassFromAnnotation(decl.type));
  }
  if (decl.kind === "type") {
    return abiClassFromTypeClass(typeClassFromTypeResultKind(decl.resultKind));
  }
  return abiClassVoidTag();
}

function declarationResolvedAbiClassTag(
  decl: Program["declarations"][number],
  environment: Map<string, number>,
): number {
  if (decl.kind === "fn") {
    return abiClassFunctionTag();
  }
  if (decl.kind === "let" || decl.kind === "const") {
    return abiClassFromTypeClass(typeClassFromAnnotation(decl.type, environment));
  }
  if (decl.kind === "type") {
    const typeClass = environment.get(primaryDeclarationName(decl));
    if (typeClass === undefined) {
      return abiClassVoidTag();
    }
    return abiClassFromTypeClass(typeClass);
  }
  return abiClassVoidTag();
}

function declarationTypeClassPayload(decl: Program["declarations"][number]): number {
  if (decl.kind !== "fn") {
    return 0;
  }
  return decl.params.length * 31 + typeClassFromAnnotation(decl.returnType);
}

function typeClassFromAnnotation(type: string | undefined, environment?: Map<string, number>): number {
  if (type === undefined) {
    return typeClassUnknownTag();
  }
  const normalized = type.replace(/\s+/g, "");
  if (normalized === "i32") {
    return typeClassI32Tag();
  }
  if (normalized === "bool") {
    return typeClassBoolTag();
  }
  if (normalized.startsWith("fn(")) {
    return typeClassFunctionTag();
  }
  let lookupName = normalized;
  const appliedIndex = normalized.indexOf("(");
  if (appliedIndex >= 0) {
    lookupName = normalized.slice(0, appliedIndex);
  }
  const namedTypeClass = environment?.get(lookupName);
  const hasResolvedNamedType =
    namedTypeClass !== undefined &&
    namedTypeClass !== typeClassUnknownTag() &&
    namedTypeClass !== typeClassTypeValueTag();
  if (hasResolvedNamedType) {
    return namedTypeClass;
  }
  return typeClassUnknownTag();
}

function typeClassFromTypeResultKind(kind: string): number {
  if (kind === "struct") {
    return typeClassProductTag();
  }
  if (kind === "union") {
    return typeClassUnionTag();
  }
  return typeClassTypeValueTag();
}

function declaredTypeClassHash(kindTag: number, typeClass: number, payload: number): number {
  let total = signatureMix(17, kindTag);
  total = signatureMix(total, typeClass);
  total = signatureMix(total, payload);
  return total;
}

function declaredAbiClassHash(kindTag: number, abiClass: number): number {
  let total = signatureMix(17, kindTag);
  total = signatureMix(total, abiClass);
  return total;
}

function symbolEnvironmentHash(
  kindTag: number,
  nameHash: number,
  typeClass: number,
  payload: number,
  abiClass: number,
): number {
  let total = signatureMix(23, kindTag);
  total = signatureMix(total, nameHash);
  total = signatureMix(total, typeClass);
  total = signatureMix(total, payload);
  total = signatureMix(total, abiClass);
  return total;
}

function exportAbiHash(nameHash: number, paramCount: number, returnAbiClass: number): number {
  let total = signatureMix(29, nameHash);
  total = signatureMix(total, paramCount);
  total = signatureMix(total, returnAbiClass);
  return total;
}

function valueBodyTypeClassHash(kindTag: number, typeClass: number): number {
  let total = signatureMix(31, kindTag);
  total = signatureMix(total, typeClass);
  return total;
}

function valueBodyAbiClassHash(kindTag: number, abiClass: number): number {
  let total = signatureMix(37, kindTag);
  total = signatureMix(total, abiClass);
  return total;
}

function namedTypeEnvironmentHash(nameHash: number, typeClass: number): number {
  let total = signatureMix(43, nameHash);
  total = signatureMix(total, typeClass);
  return total;
}

function directImportTypeEnvironmentHash(
  aliasHash: number,
  nameHash: number,
  typeClass: number,
): number {
  let total = signatureMix(47, aliasHash);
  total = signatureMix(total, nameHash);
  total = signatureMix(total, typeClass);
  return total;
}

function sourceImportEdgeHash(aliasHash: number, moduleHash: number): number {
  let total = signatureMix(89, aliasHash);
  total = signatureMix(total, moduleHash);
  return total;
}

function sourceImportGraphNoDiagnosticCode(): number {
  return 0;
}

function sourceImportGraphDiagnosticHash(
  aliasHash: number,
  moduleHash: number,
  spanWidth: number,
  diagnosticCode: number,
): number {
  let total = signatureMix(97, aliasHash);
  total = signatureMix(total, moduleHash);
  total = signatureMix(total, spanWidth);
  total = signatureMix(total, diagnosticCode);
  return total;
}

function declarationDependencyValueEdgeTag(): number {
  return 11;
}

function declarationDependencyQualifiedValueEdgeTag(): number {
  return 12;
}

function declarationDependencyNoDiagnosticCode(): number {
  return 0;
}

function declarationDependencyCycleDiagnosticCode(): number {
  return 31;
}

function declarationDependencyReaches(
  program: Program,
  currentHash: number,
  targetHash: number,
  budget: number,
): boolean {
  if (currentHash === targetHash) {
    return true;
  }
  if (budget <= 0) {
    return false;
  }
  for (const decl of program.declarations) {
    const fromHash = textHash(primaryDeclarationName(decl));
    if (fromHash !== currentHash) {
      continue;
    }
    const nextTarget = declarationSimpleDependencyTarget(decl);
    if (nextTarget === undefined) {
      continue;
    }
    if (nextTarget.edgeTag !== declarationDependencyValueEdgeTag()) {
      continue;
    }
    if (declarationDependencyReaches(program, nextTarget.hash, targetHash, budget - 1)) {
      return true;
    }
  }
  return false;
}

function declarationDependencyDiagnosticCode(
  program: Program,
  fromHash: number,
  toHash: number,
): number {
  if (declarationDependencyReaches(program, toHash, fromHash, program.declarations.length)) {
    return declarationDependencyCycleDiagnosticCode();
  }
  return declarationDependencyNoDiagnosticCode();
}

function declarationDependencyHash(
  kindTag: number,
  fromHash: number,
  toHash: number,
  edgeTag: number,
  spanWidth: number,
): number {
  let total = signatureMix(103, kindTag);
  total = signatureMix(total, fromHash);
  total = signatureMix(total, toHash);
  total = signatureMix(total, edgeTag);
  total = signatureMix(total, spanWidth);
  return total;
}

function declarationDependencyDiagnosticHash(
  kindTag: number,
  fromHash: number,
  toHash: number,
  edgeTag: number,
  spanWidth: number,
  diagnosticCode: number,
): number {
  let total = signatureMix(107, kindTag);
  total = signatureMix(total, fromHash);
  total = signatureMix(total, toHash);
  total = signatureMix(total, edgeTag);
  total = signatureMix(total, spanWidth);
  total = signatureMix(total, diagnosticCode);
  return total;
}

function simpleBodyTypeCheckHash(
  kindTag: number,
  expected: number,
  actual: number,
  status: number,
): number {
  let total = signatureMix(41, kindTag);
  total = signatureMix(total, expected);
  total = signatureMix(total, actual);
  total = signatureMix(total, status);
  return total;
}

function factPairSignatureHash(kindTag: number, first: number, second: number): number {
  let total = signatureMix(kindTag, first);
  total = signatureMix(total, second);
  return total;
}

function factTripleSignatureHash(
  kindTag: number,
  first: number,
  second: number,
  third: number,
): number {
  let total = factPairSignatureHash(kindTag, first, second);
  total = signatureMix(total, third);
  return total;
}

function checkedDeclarationRecordFactHash(fact: CheckedDeclarationRecordFact): number {
  let total = signatureMix(53, fact.kindTag);
  total = signatureMix(total, fact.nameHash);
  total = signatureMix(total, fact.symbolTypeClass);
  total = signatureMix(total, fact.symbolPayload);
  total = signatureMix(total, fact.expectedTypeClass);
  total = signatureMix(total, fact.actualTypeClass);
  total = signatureMix(total, fact.checkStatus);
  total = signatureMix(total, fact.diagnosticCode);
  total = signatureMix(total, fact.loweredAbiClass);
  return total;
}

function checkedExpressionRecordFactHash(fact: CheckedExpressionRecordFact): number {
  let total = signatureMix(59, fact.kindTag);
  total = signatureMix(total, fact.nameHash);
  total = signatureMix(total, fact.rootKind);
  total = signatureMix(total, fact.rootHash);
  total = signatureMix(total, fact.rootChildCount);
  total = signatureMix(total, fact.rootChildSignatureHash);
  total = signatureMix(total, fact.rootGrandchildCount);
  total = signatureMix(total, fact.rootGrandchildSignatureHash);
  total = signatureMix(total, fact.rootDescendantCount);
  total = signatureMix(total, fact.rootDescendantSignatureHash);
  total = signatureMix(total, fact.rootTypeClass);
  total = signatureMix(total, fact.resolvedTypeClass);
  total = signatureMix(total, fact.expectedTypeClass);
  total = signatureMix(total, fact.checkStatus);
  total = signatureMix(total, fact.diagnosticCode);
  total = signatureMix(total, fact.loweredValueTag);
  total = signatureMix(total, fact.loweredValuePrimary);
  total = signatureMix(total, fact.loweredValueSecondary);
  return total;
}

function checkedExpressionChildRecordFactHash(fact: CheckedExpressionChildRecordFact): number {
  let total = signatureMix(67, fact.parentKindTag);
  total = signatureMix(total, fact.parentNameHash);
  total = signatureMix(total, fact.childIndex);
  total = signatureMix(total, fact.childRoleTag);
  total = signatureMix(total, fact.childLabelHash);
  total = signatureMix(total, fact.childRootKind);
  total = signatureMix(total, fact.childRootHash);
  total = signatureMix(total, fact.childRootTypeClass);
  total = signatureMix(total, fact.childChildCount);
  total = signatureMix(total, fact.childDescendantCount);
  return total;
}

function checkedLocalEnvironmentFactHash(fact: CheckedLocalEnvironmentFact): number {
  let total = signatureMix(61, fact.functionNameHash);
  total = signatureMix(total, fact.localKindTag);
  total = signatureMix(total, fact.localNameHash);
  total = signatureMix(total, fact.valueRootKind);
  total = signatureMix(total, fact.valueRootHash);
  total = signatureMix(total, fact.expectedTypeClass);
  total = signatureMix(total, fact.actualTypeClass);
  total = signatureMix(total, fact.checkStatus);
  total = signatureMix(total, fact.diagnosticCode);
  return total;
}

function checkedExpressionShapeFactHash(fact: CheckedExpressionShapeFact): number {
  let total = signatureMix(67, fact.kindTag);
  total = signatureMix(total, fact.nameHash);
  total = signatureMix(total, fact.rootKind);
  total = signatureMix(total, fact.rootHash);
  total = signatureMix(total, fact.rootSelectorCount);
  total = signatureMix(total, fact.rootSlotCount);
  total = signatureMix(total, fact.rootCallArgCount);
  total = signatureMix(total, fact.rootFieldCount);
  total = signatureMix(total, fact.rootOperatorCount);
  total = signatureMix(total, fact.operatorCount);
  total = signatureMix(total, fact.operatorSignatureHash);
  total = signatureMix(total, fact.matchCount);
  total = signatureMix(total, fact.matchArmCount);
  total = signatureMix(total, fact.doCount);
  total = signatureMix(total, fact.doBindCount);
  total = signatureMix(total, fact.pipeBindCount);
  total = signatureMix(total, fact.callCount);
  total = signatureMix(total, fact.functionMatchBodyCount);
  total = signatureMix(total, fact.nameTokenCount);
  total = signatureMix(total, fact.nameTokenSignatureHash);
  total = signatureMix(total, fact.literalTokenCount);
  total = signatureMix(total, fact.literalTokenSignatureHash);
  total = signatureMix(total, fact.diagnosticCode);
  return total;
}

function loweredExportRecordFactHash(fact: LoweredExportRecordFact): number {
  let total = signatureMix(71, fact.nameHash);
  total = signatureMix(total, fact.paramCount);
  total = signatureMix(total, fact.returnAbiClass);
  return total;
}

function wasmFunctionRecordFactHash(fact: WasmFunctionRecordFact): number {
  let total = signatureMix(73, fact.nameHash);
  total = signatureMix(total, fact.exportTag);
  total = signatureMix(total, fact.runtimeParamCount);
  total = signatureMix(total, fact.localCount);
  total = signatureMix(total, fact.resultValType);
  total = signatureMix(total, fact.bodyOpcode);
  total = signatureMix(total, fact.bodyImmediate);
  total = signatureMix(total, fact.terminatorOpcode);
  total = signatureMix(total, fact.bodySize);
  total = signatureMix(total, fact.diagnosticCode);
  return total;
}

function wasmSectionRecordFactHash(fact: WasmSectionRecordFact): number {
  let total = signatureMix(79, fact.sectionId);
  total = signatureMix(total, fact.itemCount);
  total = signatureMix(total, fact.payloadSize);
  total = signatureMix(total, fact.payloadSignature);
  total = signatureMix(total, fact.diagnosticSignature);
  return total;
}

function wasmByteSectionRecordFactHash(fact: WasmByteSectionRecordFact): number {
  let total = signatureMix(109, fact.sectionId);
  total = signatureMix(total, fact.payloadSize);
  total = signatureMix(total, fact.payloadLebSize);
  total = signatureMix(total, fact.sectionSize);
  total = signatureMix(total, fact.headerSignature);
  total = signatureMix(total, fact.payloadSignature);
  total = signatureMix(total, fact.diagnosticSignature);
  return total;
}

function wasmByteModuleRecordFactHash(fact: WasmByteModuleRecordFact): number {
  let total = signatureMix(113, fact.magicSignature);
  total = signatureMix(total, fact.versionSignature);
  total = signatureMix(total, fact.sectionCount);
  total = signatureMix(total, fact.byteSize);
  total = signatureMix(total, fact.sectionSignature);
  total = signatureMix(total, fact.diagnosticSignature);
  return total;
}

function simpleBodyTypeCheckStatus(expected: number, actual: number): number {
  if (expected === typeClassUnknownTag()) {
    return typeCheckUnknownTag();
  }
  if (actual === typeClassUnknownTag()) {
    return typeCheckUnknownTag();
  }
  if (expected === actual) {
    return typeCheckMatchTag();
  }
  return typeCheckMismatchTag();
}

function typeCheckUnknownTag(): number {
  return 0;
}

function typeCheckMatchTag(): number {
  return 1;
}

function typeCheckMismatchTag(): number {
  return 2;
}

function diagnosticCodeForTypeCheckStatus(status: number): number {
  if (status === typeCheckMismatchTag()) {
    return diagnosticTypeMismatchCode();
  }
  return diagnosticNoCode();
}

function diagnosticNoCode(): number {
  return 0;
}

function diagnosticTypeMismatchCode(): number {
  return 23;
}

function checkedDeclarationTypeFactTag(): number {
  return 1;
}

function checkedDiagnosticFactTag(): number {
  return 2;
}

function loweredDeclarationFactTag(): number {
  return 3;
}

function checkedLocalLetTag(): number {
  return 1;
}

function checkedLocalTypeAssertTag(): number {
  return 2;
}

function expressionRootNoneTag(): number {
  return 0;
}

function expressionRootNumberTag(): number {
  return 1;
}

function expressionRootBoolTag(): number {
  return 2;
}

function expressionRootTextTag(): number {
  return 3;
}

function expressionRootLiteralTypeTag(): number {
  return 4;
}

function expressionRootIdentifierTag(): number {
  return 5;
}

function expressionRootConstFunctionTag(): number {
  return 6;
}

function expressionRootShapeTag(): number {
  return 7;
}

function expressionRootProductConstructorTag(): number {
  return 8;
}

function expressionRootMatchTag(): number {
  return 9;
}

function expressionRootDoTag(): number {
  return 10;
}

function abiClassFromTypeClass(typeClass: number): number {
  if (typeClass === typeClassI32Tag()) {
    return abiClassScalarTag();
  }
  if (typeClass === typeClassBoolTag()) {
    return abiClassScalarTag();
  }
  if (typeClass === typeClassFunctionTag()) {
    return abiClassFunctionTag();
  }
  if (typeClass === typeClassProductTag()) {
    return abiClassHandleTag();
  }
  if (typeClass === typeClassUnionTag()) {
    return abiClassHandleTag();
  }
  return abiClassVoidTag();
}

function typeClassUnknownTag(): number {
  return 0;
}

function typeClassI32Tag(): number {
  return 1;
}

function typeClassBoolTag(): number {
  return 2;
}

function typeClassFunctionTag(): number {
  return 3;
}

function typeClassProductTag(): number {
  return 4;
}

function typeClassUnionTag(): number {
  return 5;
}

function typeClassTypeValueTag(): number {
  return 6;
}

function abiClassVoidTag(): number {
  return 0;
}

function abiClassScalarTag(): number {
  return 1;
}

function abiClassHandleTag(): number {
  return 2;
}

function abiClassFunctionTag(): number {
  return 3;
}

function loweredValueTagForAbi(abiClass: number): number {
  return abiClass;
}

function loweredValueVoidTag(): number {
  return 0;
}

function loweredValuePrimary(
  abiClass: number,
  resolvedTypeClass: number,
): number {
  if (abiClass === abiClassScalarTag()) {
    return resolvedTypeClass;
  }
  if (abiClass === abiClassHandleTag()) {
    return resolvedTypeClass;
  }
  if (abiClass === abiClassFunctionTag()) {
    return resolvedTypeClass;
  }
  return 0;
}

function loweredValueSecondary(): number {
  return 0;
}

function wasmNoValType(): number {
  return 64;
}

function wasmI32ValType(): number {
  return 127;
}

function wasmExternRefValType(): number {
  return 111;
}

function wasmConstOpcode(): number {
  return 65;
}

function wasmLocalGetOpcode(): number {
  return 32;
}

function wasmLocalSetOpcode(): number {
  return 33;
}

function wasmCallOpcode(): number {
  return 16;
}

function wasmIfOpcode(): number {
  return 4;
}

function wasmElseOpcode(): number {
  return 5;
}

function wasmEndOpcode(): number {
  return 11;
}

function wasmI32EqOpcode(): number {
  return 70;
}

function wasmI32NeOpcode(): number {
  return 71;
}

function wasmI32LtSOpcode(): number {
  return 72;
}

function wasmI32GtSOpcode(): number {
  return 74;
}

function wasmI32LeSOpcode(): number {
  return 76;
}

function wasmI32GeSOpcode(): number {
  return 78;
}

function wasmI32AddOpcode(): number {
  return 106;
}

function wasmI32SubOpcode(): number {
  return 107;
}

function wasmI32MulOpcode(): number {
  return 108;
}

function wasmI32DivSOpcode(): number {
  return 109;
}

function wasmI32RemSOpcode(): number {
  return 111;
}

function wasmReturnOpcode(): number {
  return 15;
}

function wasmDropOpcode(): number {
  return 26;
}

function wasmTypeSectionId(): number {
  return 1;
}

function wasmFunctionSectionId(): number {
  return 3;
}

function wasmExportSectionId(): number {
  return 7;
}

function wasmCodeSectionId(): number {
  return 10;
}

function wasmModuleHeaderSize(): number {
  return 8;
}

function wasmEmittedSectionCount(): number {
  return 4;
}

function wasmU32LebByte(value: number): number {
  const payload = value % 128;
  const remaining = Math.floor(value / 128);
  if (remaining > 0) {
    return payload + 128;
  }
  return payload;
}

function wasmU32LebSize(value: number): number {
  let size = 1;
  let remaining = Math.floor(value / 128);
  while (remaining > 0) {
    size += 1;
    remaining = Math.floor(remaining / 128);
  }
  return size;
}

function wasmU32LebSignature(value: number): number {
  let total = 0;
  let current = value;
  let active = true;
  while (active) {
    const byteValue = wasmU32LebByte(current);
    total = signatureMix(total, byteValue);
    current = Math.floor(current / 128);
    if (current === 0) {
      active = false;
    }
  }
  return total;
}

function wasmFixedByte4Signature(
  seed: number,
  first: number,
  second: number,
  third: number,
  fourth: number,
): number {
  let total = signatureMix(seed, first);
  total = signatureMix(total, second);
  total = signatureMix(total, third);
  total = signatureMix(total, fourth);
  return total;
}

function wasmMagicSignature(): number {
  return wasmFixedByte4Signature(101, 0, 97, 115, 109);
}

function wasmVersionSignature(): number {
  return wasmFixedByte4Signature(103, 1, 0, 0, 0);
}

function wasmSectionHeaderSignature(
  sectionId: number,
  payloadSize: number,
): number {
  let total = signatureMix(107, sectionId);
  total = signatureMix(total, wasmU32LebSignature(payloadSize));
  return total;
}

function wasmSectionTotalSize(payloadSize: number): number {
  return 1 + wasmU32LebSize(payloadSize) + payloadSize;
}

function wasmValTypeForAbi(abiClass: number): number {
  if (abiClass === abiClassScalarTag()) {
    return wasmI32ValType();
  }
  if (abiClass === abiClassHandleTag()) {
    return wasmExternRefValType();
  }
  if (abiClass === abiClassFunctionTag()) {
    return wasmI32ValType();
  }
  return wasmNoValType();
}

function wasmBodyOpcodeForAbi(abiClass: number): number {
  if (abiClass === abiClassScalarTag()) {
    return wasmConstOpcode();
  }
  if (abiClass === abiClassHandleTag()) {
    return wasmConstOpcode();
  }
  if (abiClass === abiClassFunctionTag()) {
    return wasmCallOpcode();
  }
  return wasmDropOpcode();
}

function wasmBodyImmediate(abiClass: number, body: Expr | undefined): number {
  if (abiClass === abiClassVoidTag()) {
    return 0;
  }
  return expressionRootHeadHash(body);
}

function declarationRuntimeParamIndex(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  name: string,
): number | undefined {
  let runtimeIndex = 0;
  for (const param of decl.params) {
    if (param.const === true) {
      continue;
    }
    if (param.name === name) {
      return runtimeIndex;
    }
    runtimeIndex += 1;
  }
  return undefined;
}

function declarationLocalLetIndex(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  name: string,
): number | undefined {
  let localIndex = 0;
  for (const statement of decl.body.statements) {
    if (statement.kind === "let") {
      if (statement.name === name) {
        return localIndex;
      }
      localIndex += 1;
      continue;
    }
    if (statement.kind === "destructure_let") {
      localIndex += 1;
    }
  }
  return undefined;
}

function declarationLocalLetTypeClass(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  name: string,
  typeEnvironment: Map<string, number>,
  functionReturnEnvironment?: Map<string, number>,
): number {
  const environment = functionParamTypeEnvironment(decl.params, typeEnvironment);
  for (const statement of decl.body.statements) {
    if (statement.kind !== "let") {
      continue;
    }
    let typeClass = typeClassUnknownTag();
    if (statement.type !== undefined) {
      typeClass = typeClassFromAnnotation(statement.type, typeEnvironment);
    } else {
      typeClass = expressionRootResolvedTypeClassTag(
        statement.value,
        environment,
        functionReturnEnvironment,
      );
    }
    if (statement.name !== name) {
      continue;
    }
    return typeClass;
  }
  return typeClassUnknownTag();
}

function declarationRuntimeOrLocalIndex(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  name: string,
): number | undefined {
  const runtimeIndex = declarationRuntimeParamIndex(decl, name);
  if (runtimeIndex !== undefined) {
    return runtimeIndex;
  }
  const localIndex = declarationLocalLetIndex(decl, name);
  if (localIndex === undefined) {
    return undefined;
  }
  return declarationRuntimeParamCount(decl) + localIndex;
}

function declarationRuntimeOrLocalScalarIndex(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  name: string,
  typeEnvironment: Map<string, number>,
  functionReturnEnvironment: Map<string, number>,
): number | undefined {
  const runtimeIndex = declarationRuntimeParamScalarIndex(decl, name, typeEnvironment);
  if (runtimeIndex !== undefined) {
    return runtimeIndex;
  }
  const localIndex = declarationLocalLetIndex(decl, name);
  if (localIndex === undefined) {
    return undefined;
  }
  const typeClass = declarationLocalLetTypeClass(
    decl,
    name,
    typeEnvironment,
    functionReturnEnvironment,
  );
  if (!typeClassIsScalar(typeClass)) {
    return undefined;
  }
  return declarationRuntimeParamCount(decl) + localIndex;
}

function wasmSmallU7DecimalLiteral(text: string): number | undefined {
  if (text.length === 0) {
    return undefined;
  }
  let value = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 48) {
      return undefined;
    }
    if (code > 57) {
      return undefined;
    }
    value = value * 10 + code - 48;
    if (value >= 128) {
      return undefined;
    }
  }
  return value;
}

function wasmSemanticScalarBodyImmediate(
  abiClass: number,
  body: Expr | undefined,
): number | undefined {
  if (abiClass !== abiClassScalarTag()) {
    return undefined;
  }
  const root = expressionRoot(body);
  if (root === undefined) {
    return undefined;
  }
  if (root.kind !== "literal") {
    return undefined;
  }
  if (root.literalKind === "number") {
    return wasmSmallU7DecimalLiteral(root.value);
  }
  if (root.literalKind === "bool") {
    if (root.value === "true") {
      return 1;
    }
    if (root.value === "false") {
      return 0;
    }
  }
  return undefined;
}

function wasmSemanticScalarBodyInstruction(
  abiClass: number,
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  body: Expr | undefined,
): WasmBodyInstruction | undefined {
  if (abiClass !== abiClassScalarTag()) {
    return undefined;
  }
  const root = expressionRoot(body);
  if (root === undefined) {
    return undefined;
  }
  if (root.kind === "var") {
    const localIndex = declarationRuntimeOrLocalIndex(decl, root.name);
    if (localIndex === undefined) {
      return undefined;
    }
    if (localIndex >= 128) {
      return undefined;
    }
    return { opcode: wasmLocalGetOpcode(), immediate: localIndex };
  }
  const semanticImmediate = wasmSemanticScalarBodyImmediate(abiClass, body);
  if (semanticImmediate !== undefined) {
    return { opcode: wasmConstOpcode(), immediate: semanticImmediate };
  }
  return undefined;
}

function typeClassIsScalar(typeClass: number): boolean {
  if (typeClass === typeClassI32Tag()) {
    return true;
  }
  if (typeClass === typeClassBoolTag()) {
    return true;
  }
  return false;
}

function declarationRuntimeParamScalarIndex(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  name: string,
  typeEnvironment: Map<string, number>,
): number | undefined {
  let runtimeIndex = 0;
  for (const param of decl.params) {
    if (param.const === true) {
      continue;
    }
    if (param.name === name) {
      const paramTypeClass = typeClassFromAnnotation(param.type, typeEnvironment);
      if (!typeClassIsScalar(paramTypeClass)) {
        return undefined;
      }
      return runtimeIndex;
    }
    runtimeIndex += 1;
  }
  return undefined;
}

function wasmScalarExpressionInstructions(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  expr: Expr,
  typeEnvironment: Map<string, number>,
  functionIndexEnvironment: Map<string, number>,
  functionRuntimeParamCountEnvironment: Map<string, number>,
  functionReturnEnvironment: Map<string, number>,
): WasmBodyInstruction[] | undefined {
  const operator = expressionSimpleScalarOperator(expr);
  if (operator !== undefined) {
    const opcode = wasmScalarOperatorOpcode(operator.op);
    if (opcode === undefined) {
      return undefined;
    }
    const left = wasmScalarExpressionInstructions(
      decl,
      operator.left,
      typeEnvironment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    if (left === undefined) {
      return undefined;
    }
    const right = wasmScalarExpressionInstructions(
      decl,
      operator.right,
      typeEnvironment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    if (right === undefined) {
      return undefined;
    }
    return [
      ...left,
      ...right,
      { opcode, immediate: 0 },
    ];
  }
  const boolMatch = expressionSimpleBoolMatch(expr);
  if (boolMatch !== undefined) {
    const branchType = expressionSimpleBoolMatchTypeClassTag(
      expr,
      functionBodyTypeEnvironment(decl, typeEnvironment, functionReturnEnvironment),
      functionReturnEnvironment,
    );
    if (!typeClassIsScalar(branchType)) {
      return undefined;
    }
    const condition = wasmScalarExpressionInstructions(
      decl,
      boolMatch.condition,
      typeEnvironment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    if (condition === undefined) {
      return undefined;
    }
    const trueInstructions = wasmScalarExpressionInstructions(
      decl,
      boolMatch.trueValue,
      typeEnvironment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    if (trueInstructions === undefined) {
      return undefined;
    }
    const falseInstructions = wasmScalarExpressionInstructions(
      decl,
      boolMatch.falseValue,
      typeEnvironment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    if (falseInstructions === undefined) {
      return undefined;
    }
    return [
      ...condition,
      { opcode: wasmIfOpcode(), immediate: wasmI32ValType() },
      ...trueInstructions,
      { opcode: wasmElseOpcode(), immediate: 0 },
      ...falseInstructions,
      { opcode: wasmEndOpcode(), immediate: 0 },
    ];
  }
  const root = expressionRoot(expr);
  if (root === undefined) {
    return undefined;
  }
  if (root.kind === "literal") {
    if (root.literalKind === "number") {
      const value = wasmSmallU7DecimalLiteral(root.value);
      if (value === undefined) {
        return undefined;
      }
      return [{ opcode: wasmConstOpcode(), immediate: value }];
    }
    if (root.literalKind === "bool") {
      if (root.value === "true") {
        return [{ opcode: wasmConstOpcode(), immediate: 1 }];
      }
      if (root.value === "false") {
        return [{ opcode: wasmConstOpcode(), immediate: 0 }];
      }
    }
    return undefined;
  }
  if (root.kind === "var") {
    const runtimeIndex = declarationRuntimeOrLocalScalarIndex(
      decl,
      root.name,
      typeEnvironment,
      functionReturnEnvironment,
    );
    if (runtimeIndex === undefined) {
      return undefined;
    }
    if (runtimeIndex >= 128) {
      return undefined;
    }
    return [{ opcode: wasmLocalGetOpcode(), immediate: runtimeIndex }];
  }
  if (expressionIsBareCall(root)) {
    return wasmScalarCallExpressionInstructions(
      decl,
      root,
      typeEnvironment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
  }
  return undefined;
}

function expressionIsBareCall(root: Expr | undefined): root is BareCallExpr {
  if (root === undefined) {
    return false;
  }
  if (root.kind !== "call") {
    return false;
  }
  if (root.callee.kind !== "var") {
    return false;
  }
  if (root.callee.name.includes(".")) {
    return false;
  }
  if (root.callee.name.includes("::")) {
    return false;
  }
  return true;
}

function wasmScalarLocalInitializerInstructions(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  typeEnvironment: Map<string, number>,
  functionIndexEnvironment: Map<string, number>,
  functionRuntimeParamCountEnvironment: Map<string, number>,
  functionReturnEnvironment: Map<string, number>,
): WasmBodyInstruction[] | undefined {
  const instructions: WasmBodyInstruction[] = [];
  const paramCount = declarationRuntimeParamCount(decl);
  let localIndex = 0;
  for (const statement of decl.body.statements) {
    if (statement.kind === "destructure_let") {
      return undefined;
    }
    if (statement.kind !== "let") {
      continue;
    }
    const initializer = wasmScalarExpressionInstructions(
      decl,
      statement.value,
      typeEnvironment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    if (initializer === undefined) {
      return undefined;
    }
    for (const instruction of initializer) {
      instructions.push(instruction);
    }
    const wasmIndex = paramCount + localIndex;
    if (wasmIndex >= 128) {
      return undefined;
    }
    instructions.push({ opcode: wasmLocalSetOpcode(), immediate: wasmIndex });
    localIndex += 1;
  }
  return instructions;
}

function wasmScalarCallExpressionInstructions(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  root: BareCallExpr,
  typeEnvironment: Map<string, number>,
  functionIndexEnvironment: Map<string, number>,
  functionRuntimeParamCountEnvironment: Map<string, number>,
  functionReturnEnvironment: Map<string, number>,
): WasmBodyInstruction[] | undefined {
  const functionIndex = functionIndexEnvironment.get(root.callee.name);
  if (functionIndex === undefined) {
    return undefined;
  }
  if (functionIndex >= 128) {
    return undefined;
  }
  const runtimeParamCount = functionRuntimeParamCountEnvironment.get(root.callee.name);
  if (runtimeParamCount === undefined) {
    return undefined;
  }
  if (runtimeParamCount !== root.args.length) {
    return undefined;
  }
  const returnTypeClass = functionReturnEnvironment.get(root.callee.name);
  if (returnTypeClass === undefined) {
    return undefined;
  }
  if (!typeClassIsScalar(returnTypeClass)) {
    return undefined;
  }
  if (root.args.length > 5) {
    return undefined;
  }
  const instructions: WasmBodyInstruction[] = [];
  for (const arg of root.args) {
    const argInstructions = wasmScalarExpressionInstructions(
      decl,
      arg,
      typeEnvironment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    if (argInstructions === undefined) {
      return undefined;
    }
    for (const instruction of argInstructions) {
      instructions.push(instruction);
    }
  }
  instructions.push({ opcode: wasmCallOpcode(), immediate: functionIndex });
  return instructions;
}

function wasmScalarCallBodyInstructions(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  typeEnvironment: Map<string, number>,
  functionIndexEnvironment: Map<string, number>,
  functionRuntimeParamCountEnvironment: Map<string, number>,
  functionReturnEnvironment: Map<string, number>,
): WasmBodyInstruction[] | undefined {
  const body = declarationExpressionShapeBody(decl);
  const root = expressionRoot(body);
  if (!expressionIsBareCall(root)) {
    return undefined;
  }
  return wasmScalarCallExpressionInstructions(
    decl,
    root,
    typeEnvironment,
    functionIndexEnvironment,
    functionRuntimeParamCountEnvironment,
    functionReturnEnvironment,
  );
}

function wasmScalarOperatorOpcode(op: string): number | undefined {
  if (op === "+") {
    return wasmI32AddOpcode();
  }
  if (op === "-") {
    return wasmI32SubOpcode();
  }
  if (op === "*") {
    return wasmI32MulOpcode();
  }
  if (op === "/") {
    return wasmI32DivSOpcode();
  }
  if (op === "%") {
    return wasmI32RemSOpcode();
  }
  if (op === "==") {
    return wasmI32EqOpcode();
  }
  if (op === "!=") {
    return wasmI32NeOpcode();
  }
  if (op === "<") {
    return wasmI32LtSOpcode();
  }
  if (op === ">") {
    return wasmI32GtSOpcode();
  }
  if (op === "<=") {
    return wasmI32LeSOpcode();
  }
  if (op === ">=") {
    return wasmI32GeSOpcode();
  }
  return undefined;
}

function wasmScalarOperatorBodyInstructions(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  typeEnvironment: Map<string, number>,
  functionIndexEnvironment: Map<string, number>,
  functionRuntimeParamCountEnvironment: Map<string, number>,
  functionReturnEnvironment: Map<string, number>,
): WasmBodyInstruction[] | undefined {
  const body = declarationExpressionShapeBody(decl);
  const operator = expressionSimpleScalarOperator(body);
  if (operator === undefined) {
    return undefined;
  }
  const opcode = wasmScalarOperatorOpcode(operator.op);
  if (opcode === undefined) {
    return undefined;
  }
  const left = wasmScalarExpressionInstructions(
    decl,
    operator.left,
    typeEnvironment,
    functionIndexEnvironment,
    functionRuntimeParamCountEnvironment,
    functionReturnEnvironment,
  );
  if (left === undefined) {
    return undefined;
  }
  const right = wasmScalarExpressionInstructions(
    decl,
    operator.right,
    typeEnvironment,
    functionIndexEnvironment,
    functionRuntimeParamCountEnvironment,
    functionReturnEnvironment,
  );
  if (right === undefined) {
    return undefined;
  }
  return [
    ...left,
    ...right,
    { opcode, immediate: 0 },
  ];
}

function declarationSingleRuntimeParamTypeClass(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  typeEnvironment: Map<string, number>,
): number {
  let runtimeTypeClass = typeClassUnknownTag();
  let runtimeCount = 0;
  for (const param of decl.params) {
    if (param.const === true) {
      continue;
    }
    runtimeTypeClass = typeClassFromAnnotation(param.type, typeEnvironment);
    runtimeCount += 1;
  }
  if (runtimeCount !== 1) {
    return typeClassUnknownTag();
  }
  return runtimeTypeClass;
}

function wasmScalarFunctionMatchBodyInstructions(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  typeEnvironment: Map<string, number>,
  functionIndexEnvironment: Map<string, number>,
  functionRuntimeParamCountEnvironment: Map<string, number>,
  functionReturnEnvironment: Map<string, number>,
): WasmBodyInstruction[] | undefined {
  if (decl.matchBody !== true) {
    return undefined;
  }
  if (declarationSingleRuntimeParamTypeClass(decl, typeEnvironment) !== typeClassBoolTag()) {
    return undefined;
  }
  const resultTypeClass = declarationFunctionMatchBodyLiteralResultTypeClassTag(decl);
  if (!typeClassIsScalar(resultTypeClass)) {
    return undefined;
  }
  const boolMatch = expressionSimpleBoolMatch(decl.body);
  if (boolMatch === undefined) {
    return undefined;
  }
  const trueInstructions = wasmScalarExpressionInstructions(
    decl,
    boolMatch.trueValue,
    typeEnvironment,
    functionIndexEnvironment,
    functionRuntimeParamCountEnvironment,
    functionReturnEnvironment,
  );
  if (trueInstructions === undefined) {
    return undefined;
  }
  const falseInstructions = wasmScalarExpressionInstructions(
    decl,
    boolMatch.falseValue,
    typeEnvironment,
    functionIndexEnvironment,
    functionRuntimeParamCountEnvironment,
    functionReturnEnvironment,
  );
  if (falseInstructions === undefined) {
    return undefined;
  }
  return [
    { opcode: wasmLocalGetOpcode(), immediate: 0 },
    { opcode: wasmIfOpcode(), immediate: wasmI32ValType() },
    ...trueInstructions,
    { opcode: wasmElseOpcode(), immediate: 0 },
    ...falseInstructions,
    { opcode: wasmEndOpcode(), immediate: 0 },
  ];
}

function wasmInstructionSequenceByteSize(instructions: WasmBodyInstruction[]): number {
  let total = 0;
  for (const instruction of instructions) {
    total += wasmInstructionSize(instruction.opcode);
  }
  return total;
}

function wasmBodyPlanFromInstructions(instructions: WasmBodyInstruction[]): WasmBodyPlan {
  const first = instructions[0];
  return {
    firstOpcode: first?.opcode ?? wasmDropOpcode(),
    firstImmediate: first?.immediate ?? 0,
    byteSize: wasmInstructionSequenceByteSize(instructions),
    instructions,
  };
}

function wasmBodyPlanForDeclaration(
  abiClass: number,
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
  typeEnvironment: Map<string, number>,
  functionIndexEnvironment: Map<string, number>,
  functionRuntimeParamCountEnvironment: Map<string, number>,
  functionReturnEnvironment: Map<string, number>,
): WasmBodyPlan {
  let bodyPlan: WasmBodyPlan | undefined;
  if (abiClass === abiClassScalarTag()) {
    const matchBodyInstructions = wasmScalarFunctionMatchBodyInstructions(
      decl,
      typeEnvironment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    if (matchBodyInstructions !== undefined) {
      bodyPlan = wasmBodyPlanFromInstructions(matchBodyInstructions);
    }
    const body = declarationExpressionShapeBody(decl);
    if (bodyPlan === undefined && body !== undefined && decl.matchBody !== true) {
      const scalarInstructions = wasmScalarExpressionInstructions(
        decl,
        body,
        typeEnvironment,
        functionIndexEnvironment,
        functionRuntimeParamCountEnvironment,
        functionReturnEnvironment,
      );
      if (scalarInstructions !== undefined) {
        bodyPlan = wasmBodyPlanFromInstructions(scalarInstructions);
      }
    }
    if (bodyPlan === undefined) {
      const callInstructions = wasmScalarCallBodyInstructions(
        decl,
        typeEnvironment,
        functionIndexEnvironment,
        functionRuntimeParamCountEnvironment,
        functionReturnEnvironment,
      );
      if (callInstructions !== undefined) {
        bodyPlan = wasmBodyPlanFromInstructions(callInstructions);
      }
    }
    if (bodyPlan === undefined) {
      const operatorInstructions = wasmScalarOperatorBodyInstructions(
        decl,
        typeEnvironment,
        functionIndexEnvironment,
        functionRuntimeParamCountEnvironment,
        functionReturnEnvironment,
      );
      if (operatorInstructions !== undefined) {
        bodyPlan = wasmBodyPlanFromInstructions(operatorInstructions);
      }
    }
    if (bodyPlan === undefined) {
      const instruction = wasmBodyInstructionForDeclaration(abiClass, decl);
      bodyPlan = wasmBodyPlanFromInstructions([instruction]);
    }
    const localInitializers = wasmScalarLocalInitializerInstructions(
      decl,
      typeEnvironment,
      functionIndexEnvironment,
      functionRuntimeParamCountEnvironment,
      functionReturnEnvironment,
    );
    if (localInitializers !== undefined && localInitializers.length > 0) {
      return wasmBodyPlanFromInstructions([
        ...localInitializers,
        ...bodyPlan.instructions,
      ]);
    }
    return bodyPlan;
  }
  const instruction = wasmBodyInstructionForDeclaration(abiClass, decl);
  return wasmBodyPlanFromInstructions([instruction]);
}

function wasmBodyInstructionForDeclaration(
  abiClass: number,
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
): WasmBodyInstruction {
  const body = declarationExpressionShapeBody(decl);
  const semantic = wasmSemanticScalarBodyInstruction(abiClass, decl, body);
  if (semantic !== undefined) {
    return semantic;
  }
  return {
    opcode: wasmBodyOpcodeForAbi(abiClass),
    immediate: wasmBodyImmediate(abiClass, body),
  };
}

function wasmTerminatorOpcode(resultValType: number): number {
  if (resultValType === wasmNoValType()) {
    return wasmDropOpcode();
  }
  return wasmReturnOpcode();
}

function wasmInstructionSize(opcode: number): number {
  if (opcode === wasmConstOpcode()) {
    return 2;
  }
  if (opcode === wasmLocalGetOpcode()) {
    return 2;
  }
  if (opcode === wasmLocalSetOpcode()) {
    return 2;
  }
  if (opcode === wasmCallOpcode()) {
    return 2;
  }
  if (opcode === wasmIfOpcode()) {
    return 2;
  }
  return 1;
}

function wasmFunctionBodySize(
  localCount: number,
  bodyByteSize: number,
  terminatorOpcode: number,
): number {
  return wasmLocalDeclVectorSize(localCount) + bodyByteSize +
    wasmInstructionSize(terminatorOpcode) + 1;
}

function wasmLocalDeclVectorSize(localCount: number): number {
  if (localCount <= 0) {
    return 1;
  }
  return 1 + wasmU32LebSize(localCount) + 1;
}

function wasmResultArity(resultValType: number): number {
  if (resultValType === wasmNoValType()) {
    return 0;
  }
  return 1;
}

function wasmTypeEntrySize(runtimeParamCount: number, resultValType: number): number {
  return 1 + 1 + runtimeParamCount + 1 + wasmResultArity(resultValType);
}

function wasmTypeEntrySignature(runtimeParamCount: number, resultValType: number): number {
  let total = signatureMix(83, runtimeParamCount);
  total = signatureMix(total, resultValType);
  total = signatureMix(total, wasmResultArity(resultValType));
  return total;
}

function wasmExportEntrySize(nameWidth: number): number {
  return 1 + nameWidth + 1 + 1;
}

function wasmExportEntrySignature(nameHash: number, functionIndex: number): number {
  let total = signatureMix(89, nameHash);
  total = signatureMix(total, functionIndex);
  return total;
}

function wasmCodeEntrySize(bodySize: number): number {
  return wasmU32LebSize(bodySize) + bodySize;
}

function wasmCodeEntrySignature(
  localCount: number,
  bodyOpcode: number,
  bodyImmediate: number,
  terminatorOpcode: number,
  bodySize: number,
): number {
  let total = signatureMix(97, localCount);
  total = signatureMix(total, bodyOpcode);
  total = signatureMix(total, bodyImmediate);
  total = signatureMix(total, terminatorOpcode);
  total = signatureMix(total, bodySize);
  return total;
}

function wasmByteSectionRecordFact(
  sectionId: number,
  payloadSize: number,
  payloadSignature: number,
  diagnosticSignature: number,
): WasmByteSectionRecordFact {
  return {
    sectionId,
    payloadSize,
    payloadLebSize: wasmU32LebSize(payloadSize),
    sectionSize: wasmSectionTotalSize(payloadSize),
    headerSignature: wasmSectionHeaderSignature(sectionId, payloadSize),
    payloadSignature,
    diagnosticSignature,
  };
}

function programFunctionLocalLetCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    total += declarationFunctionLocalLetCount(decl);
  }
  return total;
}

function declarationFunctionLocalLetCount(decl: Extract<Program["declarations"][number], { kind: "fn" }>): number {
  let total = 0;
  for (const statement of decl.body.statements) {
    if (statement.kind === "let" || statement.kind === "destructure_let") {
      total += 1;
    }
  }
  return total;
}

function declarationRuntimeParamCount(
  decl: Extract<Program["declarations"][number], { kind: "fn" }>,
): number {
  let total = 0;
  for (const param of decl.params) {
    if (param.const === true) {
      continue;
    }
    total += 1;
  }
  return total;
}

function programFunctionLocalTypeAssertCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    for (const statement of decl.body.statements) {
      if (statement.kind === "type_assert") {
        total += 1;
      }
    }
  }
  return total;
}

function programValueMatchExpressionCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      total += expressionMatchCount(decl.body);
      continue;
    }
    if (decl.kind === "let" || decl.kind === "const") {
      total += expressionMatchCount(decl.value);
    }
  }
  return total;
}

function programFunctionMatchBodyCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind !== "fn") {
      continue;
    }
    if (decl.matchBody === true) {
      total += 1;
    }
  }
  return total;
}

function programValueDoExpressionCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      total += expressionDoCount(decl.body);
      continue;
    }
    if (decl.kind === "let" || decl.kind === "const") {
      total += expressionDoCount(decl.value);
    }
  }
  return total;
}

function programValueDoBindCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      total += expressionDoBindCount(decl.body);
      continue;
    }
    if (decl.kind === "let" || decl.kind === "const") {
      total += expressionDoBindCount(decl.value);
    }
  }
  return total;
}

function programValueMatchArmCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      total += expressionMatchArmCount(decl.body);
      continue;
    }
    if (decl.kind === "let" || decl.kind === "const") {
      total += expressionMatchArmCount(decl.value);
    }
  }
  return total;
}

function programValuePipeBindCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      total += expressionPipeBindCount(decl.body);
      continue;
    }
    if (decl.kind === "let" || decl.kind === "const") {
      total += expressionPipeBindCount(decl.value);
    }
  }
  return total;
}

function programValueOperatorExpressionCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      total += expressionOperatorCount(decl.body);
      continue;
    }
    if (decl.kind === "let" || decl.kind === "const") {
      total += expressionOperatorCount(decl.value);
    }
  }
  return total;
}

function programValueOperatorSignatureHash(program: Program, tokens: SourceToken[]): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      total = expressionOperatorTokenSignatureHash(tokens, decl.body.span, total);
      continue;
    }
    if (decl.kind === "let" || decl.kind === "const") {
      total = expressionOperatorTokenSignatureHash(tokens, decl.value.span, total);
    }
  }
  return total;
}

function programValueCallExpressionCount(program: Program): number {
  let total = 0;
  for (const decl of program.declarations) {
    if (decl.kind === "fn") {
      total += expressionCallCount(decl.body);
      continue;
    }
    if (decl.kind === "let" || decl.kind === "const") {
      total += expressionCallCount(decl.value);
    }
  }
  return total;
}

function expressionMatchCount(expr: Expr | undefined): number {
  if (expr === undefined) {
    return 0;
  }
  let total = 0;
  if (expr.kind === "match") {
    total += 1;
    total += expressionMatchCount(expr.value);
    for (const arm of expr.arms) {
      total += expressionMatchCount(arm.guard);
      total += expressionMatchCount(arm.value);
    }
    return total;
  }
  if (expr.kind === "block") {
    for (const statement of expr.statements) {
      total += statementValueMatchCount(statement);
    }
    total += expressionMatchCount(expr.expr);
    return total;
  }
  if (expr.kind === "do") {
    for (const statement of expr.statements) {
      if (statement.kind === "do_bind" || statement.kind === "do_expr") {
        total += expressionMatchCount(statement.value);
      } else {
        total += statementValueMatchCount(statement);
      }
    }
    total += expressionMatchCount(expr.expr);
    return total;
  }
  if (expr.kind === "const_fn") {
    return expressionMatchCount(expr.body);
  }
  if (expr.kind === "pipe_bind") {
    return expressionMatchCount(expr.value) + expressionMatchCount(expr.body);
  }
  if (expr.kind === "profile") {
    for (const arg of expr.args) {
      total += expressionMatchCount(arg);
    }
    total += expressionMatchCount(expr.body);
    return total;
  }
  if (expr.kind === "call") {
    total += expressionMatchCount(expr.callee);
    for (const arg of expr.args) {
      total += expressionMatchCount(arg);
    }
    return total;
  }
  if (expr.kind === "index") {
    return expressionMatchCount(expr.target) + expressionMatchCount(expr.index);
  }
  if (expr.kind === "binary") {
    return expressionMatchCount(expr.left) + expressionMatchCount(expr.right);
  }
  if (expr.kind === "operator_chain") {
    total += expressionMatchCount(expr.first);
    for (const item of expr.rest) {
      total += expressionMatchCount(item.value);
    }
    return total;
  }
  if (expr.kind === "shape") {
    for (const slot of expr.slots) {
      total += expressionMatchCount(slot.value);
      total += expressionMatchCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "static_for_slots") {
    return expressionMatchCount(expr.value);
  }
  if (expr.kind === "field") {
    return expressionMatchCount(expr.value) + expressionMatchCount(expr.key);
  }
  if (expr.kind === "product_constructor") {
    for (const slot of expr.slots) {
      total += expressionMatchCount(slot.value);
      total += expressionMatchCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "range") {
    return expressionMatchCount(expr.start) + expressionMatchCount(expr.end);
  }
  return 0;
}

function expressionPipeBindCount(expr: Expr | undefined): number {
  if (expr === undefined) {
    return 0;
  }
  let total = 0;
  if (expr.kind === "pipe_bind") {
    total += 1;
    total += expressionPipeBindCount(expr.value);
    total += expressionPipeBindCount(expr.body);
    return total;
  }
  if (expr.kind === "match") {
    total += expressionPipeBindCount(expr.value);
    for (const arm of expr.arms) {
      total += expressionPipeBindCount(arm.guard);
      total += expressionPipeBindCount(arm.value);
    }
    return total;
  }
  if (expr.kind === "block") {
    for (const statement of expr.statements) {
      total += statementValuePipeBindCount(statement);
    }
    total += expressionPipeBindCount(expr.expr);
    return total;
  }
  if (expr.kind === "do") {
    for (const statement of expr.statements) {
      if (statement.kind === "do_bind" || statement.kind === "do_expr") {
        total += expressionPipeBindCount(statement.value);
      } else {
        total += statementValuePipeBindCount(statement);
      }
    }
    total += expressionPipeBindCount(expr.expr);
    return total;
  }
  if (expr.kind === "const_fn") {
    return expressionPipeBindCount(expr.body);
  }
  if (expr.kind === "profile") {
    for (const arg of expr.args) {
      total += expressionPipeBindCount(arg);
    }
    total += expressionPipeBindCount(expr.body);
    return total;
  }
  if (expr.kind === "call") {
    total += expressionPipeBindCount(expr.callee);
    for (const arg of expr.args) {
      total += expressionPipeBindCount(arg);
    }
    return total;
  }
  if (expr.kind === "index") {
    return expressionPipeBindCount(expr.target) + expressionPipeBindCount(expr.index);
  }
  if (expr.kind === "binary") {
    return expressionPipeBindCount(expr.left) + expressionPipeBindCount(expr.right);
  }
  if (expr.kind === "operator_chain") {
    total += expressionPipeBindCount(expr.first);
    for (const item of expr.rest) {
      total += expressionPipeBindCount(item.value);
    }
    return total;
  }
  if (expr.kind === "shape") {
    for (const slot of expr.slots) {
      total += expressionPipeBindCount(slot.value);
      total += expressionPipeBindCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "static_for_slots") {
    return expressionPipeBindCount(expr.value);
  }
  if (expr.kind === "field") {
    return expressionPipeBindCount(expr.value) + expressionPipeBindCount(expr.key);
  }
  if (expr.kind === "product_constructor") {
    for (const slot of expr.slots) {
      total += expressionPipeBindCount(slot.value);
      total += expressionPipeBindCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "range") {
    return expressionPipeBindCount(expr.start) + expressionPipeBindCount(expr.end);
  }
  return 0;
}

function expressionMatchArmCount(expr: Expr | undefined): number {
  if (expr === undefined) {
    return 0;
  }
  let total = 0;
  if (expr.kind === "match") {
    total += expr.arms.length;
    total += expressionMatchArmCount(expr.value);
    for (const arm of expr.arms) {
      total += expressionMatchArmCount(arm.guard);
      total += expressionMatchArmCount(arm.value);
    }
    return total;
  }
  if (expr.kind === "block") {
    for (const statement of expr.statements) {
      total += statementValueMatchArmCount(statement);
    }
    total += expressionMatchArmCount(expr.expr);
    return total;
  }
  if (expr.kind === "do") {
    for (const statement of expr.statements) {
      if (statement.kind === "do_bind" || statement.kind === "do_expr") {
        total += expressionMatchArmCount(statement.value);
      } else {
        total += statementValueMatchArmCount(statement);
      }
    }
    total += expressionMatchArmCount(expr.expr);
    return total;
  }
  if (expr.kind === "const_fn") {
    return expressionMatchArmCount(expr.body);
  }
  if (expr.kind === "pipe_bind") {
    return expressionMatchArmCount(expr.value) + expressionMatchArmCount(expr.body);
  }
  if (expr.kind === "profile") {
    for (const arg of expr.args) {
      total += expressionMatchArmCount(arg);
    }
    total += expressionMatchArmCount(expr.body);
    return total;
  }
  if (expr.kind === "call") {
    total += expressionMatchArmCount(expr.callee);
    for (const arg of expr.args) {
      total += expressionMatchArmCount(arg);
    }
    return total;
  }
  if (expr.kind === "index") {
    return expressionMatchArmCount(expr.target) + expressionMatchArmCount(expr.index);
  }
  if (expr.kind === "binary") {
    return expressionMatchArmCount(expr.left) + expressionMatchArmCount(expr.right);
  }
  if (expr.kind === "operator_chain") {
    total += expressionMatchArmCount(expr.first);
    for (const item of expr.rest) {
      total += expressionMatchArmCount(item.value);
    }
    return total;
  }
  if (expr.kind === "shape") {
    for (const slot of expr.slots) {
      total += expressionMatchArmCount(slot.value);
      total += expressionMatchArmCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "static_for_slots") {
    return expressionMatchArmCount(expr.value);
  }
  if (expr.kind === "field") {
    return expressionMatchArmCount(expr.value) + expressionMatchArmCount(expr.key);
  }
  if (expr.kind === "product_constructor") {
    for (const slot of expr.slots) {
      total += expressionMatchArmCount(slot.value);
      total += expressionMatchArmCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "range") {
    return expressionMatchArmCount(expr.start) + expressionMatchArmCount(expr.end);
  }
  return 0;
}

function expressionDoCount(expr: Expr | undefined): number {
  if (expr === undefined) {
    return 0;
  }
  let total = 0;
  if (expr.kind === "do") {
    total += 1;
    for (const statement of expr.statements) {
      if (statement.kind === "do_bind" || statement.kind === "do_expr") {
        total += expressionDoCount(statement.value);
      } else {
        total += statementValueDoCount(statement);
      }
    }
    total += expressionDoCount(expr.expr);
    return total;
  }
  if (expr.kind === "match") {
    total += expressionDoCount(expr.value);
    for (const arm of expr.arms) {
      total += expressionDoCount(arm.guard);
      total += expressionDoCount(arm.value);
    }
    return total;
  }
  if (expr.kind === "block") {
    for (const statement of expr.statements) {
      total += statementValueDoCount(statement);
    }
    total += expressionDoCount(expr.expr);
    return total;
  }
  if (expr.kind === "const_fn") {
    return expressionDoCount(expr.body);
  }
  if (expr.kind === "pipe_bind") {
    return expressionDoCount(expr.value) + expressionDoCount(expr.body);
  }
  if (expr.kind === "profile") {
    for (const arg of expr.args) {
      total += expressionDoCount(arg);
    }
    total += expressionDoCount(expr.body);
    return total;
  }
  if (expr.kind === "call") {
    total += expressionDoCount(expr.callee);
    for (const arg of expr.args) {
      total += expressionDoCount(arg);
    }
    return total;
  }
  if (expr.kind === "index") {
    return expressionDoCount(expr.target) + expressionDoCount(expr.index);
  }
  if (expr.kind === "binary") {
    return expressionDoCount(expr.left) + expressionDoCount(expr.right);
  }
  if (expr.kind === "operator_chain") {
    total += expressionDoCount(expr.first);
    for (const item of expr.rest) {
      total += expressionDoCount(item.value);
    }
    return total;
  }
  if (expr.kind === "shape") {
    for (const slot of expr.slots) {
      total += expressionDoCount(slot.value);
      total += expressionDoCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "static_for_slots") {
    return expressionDoCount(expr.value);
  }
  if (expr.kind === "field") {
    return expressionDoCount(expr.value) + expressionDoCount(expr.key);
  }
  if (expr.kind === "product_constructor") {
    for (const slot of expr.slots) {
      total += expressionDoCount(slot.value);
      total += expressionDoCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "range") {
    return expressionDoCount(expr.start) + expressionDoCount(expr.end);
  }
  return 0;
}

function expressionDoBindCount(expr: Expr | undefined): number {
  if (expr === undefined) {
    return 0;
  }
  let total = 0;
  if (expr.kind === "do") {
    for (const statement of expr.statements) {
      if (statement.kind === "do_bind") {
        total += 1;
        total += expressionDoBindCount(statement.value);
        continue;
      }
      if (statement.kind === "do_expr") {
        total += expressionDoBindCount(statement.value);
        continue;
      }
      total += statementValueDoBindCount(statement);
    }
    total += expressionDoBindCount(expr.expr);
    return total;
  }
  if (expr.kind === "match") {
    total += expressionDoBindCount(expr.value);
    for (const arm of expr.arms) {
      total += expressionDoBindCount(arm.guard);
      total += expressionDoBindCount(arm.value);
    }
    return total;
  }
  if (expr.kind === "block") {
    for (const statement of expr.statements) {
      total += statementValueDoBindCount(statement);
    }
    total += expressionDoBindCount(expr.expr);
    return total;
  }
  if (expr.kind === "const_fn") {
    return expressionDoBindCount(expr.body);
  }
  if (expr.kind === "pipe_bind") {
    return expressionDoBindCount(expr.value) + expressionDoBindCount(expr.body);
  }
  if (expr.kind === "profile") {
    for (const arg of expr.args) {
      total += expressionDoBindCount(arg);
    }
    total += expressionDoBindCount(expr.body);
    return total;
  }
  if (expr.kind === "call") {
    total += expressionDoBindCount(expr.callee);
    for (const arg of expr.args) {
      total += expressionDoBindCount(arg);
    }
    return total;
  }
  if (expr.kind === "index") {
    return expressionDoBindCount(expr.target) + expressionDoBindCount(expr.index);
  }
  if (expr.kind === "binary") {
    return expressionDoBindCount(expr.left) + expressionDoBindCount(expr.right);
  }
  if (expr.kind === "operator_chain") {
    total += expressionDoBindCount(expr.first);
    for (const item of expr.rest) {
      total += expressionDoBindCount(item.value);
    }
    return total;
  }
  if (expr.kind === "shape") {
    for (const slot of expr.slots) {
      total += expressionDoBindCount(slot.value);
      total += expressionDoBindCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "static_for_slots") {
    return expressionDoBindCount(expr.value);
  }
  if (expr.kind === "field") {
    return expressionDoBindCount(expr.value) + expressionDoBindCount(expr.key);
  }
  if (expr.kind === "product_constructor") {
    for (const slot of expr.slots) {
      total += expressionDoBindCount(slot.value);
      total += expressionDoBindCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "range") {
    return expressionDoBindCount(expr.start) + expressionDoBindCount(expr.end);
  }
  return 0;
}

function statementValueMatchCount(statement: Statement): number {
  if (statement.kind === "let" || statement.kind === "destructure_let") {
    return expressionMatchCount(statement.value);
  }
  if (statement.kind === "debug_trace") {
    let total = 0;
    for (const arg of statement.args) {
      total += expressionMatchCount(arg);
    }
    return total;
  }
  return 0;
}

function expressionOperatorCount(expr: Expr | undefined): number {
  if (expr === undefined) {
    return 0;
  }
  let total = 0;
  if (expr.kind === "operator_chain") {
    total += expr.rest.length;
    total += expressionOperatorCount(expr.first);
    for (const item of expr.rest) {
      total += expressionOperatorCount(item.value);
    }
    return total;
  }
  if (expr.kind === "binary") {
    return 1 + expressionOperatorCount(expr.left) + expressionOperatorCount(expr.right);
  }
  if (expr.kind === "match") {
    total += expressionOperatorCount(expr.value);
    for (const arm of expr.arms) {
      total += expressionOperatorCount(arm.guard);
      total += expressionOperatorCount(arm.value);
    }
    return total;
  }
  if (expr.kind === "block") {
    for (const statement of expr.statements) {
      total += statementValueOperatorCount(statement);
    }
    total += expressionOperatorCount(expr.expr);
    return total;
  }
  if (expr.kind === "do") {
    for (const statement of expr.statements) {
      if (statement.kind === "do_bind" || statement.kind === "do_expr") {
        total += expressionOperatorCount(statement.value);
        continue;
      }
      total += statementValueOperatorCount(statement);
    }
    total += expressionOperatorCount(expr.expr);
    return total;
  }
  if (expr.kind === "const_fn") {
    return expressionOperatorCount(expr.body);
  }
  if (expr.kind === "pipe_bind") {
    return expressionOperatorCount(expr.value) + expressionOperatorCount(expr.body);
  }
  if (expr.kind === "profile") {
    for (const arg of expr.args) {
      total += expressionOperatorCount(arg);
    }
    total += expressionOperatorCount(expr.body);
    return total;
  }
  if (expr.kind === "call") {
    total += expressionOperatorCount(expr.callee);
    for (const arg of expr.args) {
      total += expressionOperatorCount(arg);
    }
    return total;
  }
  if (expr.kind === "index") {
    return expressionOperatorCount(expr.target) + expressionOperatorCount(expr.index);
  }
  if (expr.kind === "field") {
    return expressionOperatorCount(expr.value) + expressionOperatorCount(expr.key);
  }
  if (expr.kind === "shape") {
    for (const slot of expr.slots) {
      total += expressionOperatorCount(slot.value);
      total += expressionOperatorCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "product_constructor") {
    for (const slot of expr.slots) {
      total += expressionOperatorCount(slot.value);
      total += expressionOperatorCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "static_for_slots") {
    return expressionOperatorCount(expr.value);
  }
  if (expr.kind === "range") {
    return expressionOperatorCount(expr.start) + expressionOperatorCount(expr.end);
  }
  return 0;
}

function expressionOperatorTokenSignatureHash(
  tokens: SourceToken[],
  span: { start: number; end: number } | undefined,
  initial: number,
): number {
  if (span === undefined) {
    return initial;
  }
  let total = initial;
  for (const token of tokens) {
    if (token.span.start < span.start) {
      continue;
    }
    if (token.span.start >= span.end) {
      break;
    }
    if (!tokenIsValueOperator(token)) {
      continue;
    }
    total = signatureMix(total, textHash(token.text));
  }
  return total;
}

function expressionNameTokenCount(
  tokens: SourceToken[],
  span: { start: number; end: number } | undefined,
): number {
  if (span === undefined) {
    return 0;
  }
  let total = 0;
  for (const token of tokens) {
    if (token.span.start < span.start) {
      continue;
    }
    if (token.span.start >= span.end) {
      break;
    }
    if (tokenIsExpressionName(token)) {
      total++;
    }
  }
  return total;
}

function expressionNameTokenSignatureHash(
  tokens: SourceToken[],
  span: { start: number; end: number } | undefined,
): number {
  if (span === undefined) {
    return 0;
  }
  let total = 0;
  for (const token of tokens) {
    if (token.span.start < span.start) {
      continue;
    }
    if (token.span.start >= span.end) {
      break;
    }
    if (tokenIsExpressionName(token)) {
      total = signatureMix(total, textHash(token.text));
    }
  }
  return total;
}

function tokenIsExpressionName(token: SourceToken): boolean {
  return token.kind === "identifier" || token.kind === "literalType";
}

function expressionLiteralTokenCount(
  tokens: SourceToken[],
  span: { start: number; end: number } | undefined,
): number {
  if (span === undefined) {
    return 0;
  }
  let total = 0;
  for (const token of tokens) {
    if (token.span.start < span.start) {
      continue;
    }
    if (token.span.start >= span.end) {
      break;
    }
    if (tokenIsExpressionLiteral(token)) {
      total++;
    }
  }
  return total;
}

function expressionLiteralTokenSignatureHash(
  tokens: SourceToken[],
  span: { start: number; end: number } | undefined,
): number {
  if (span === undefined) {
    return 0;
  }
  let total = 0;
  for (const token of tokens) {
    if (token.span.start < span.start) {
      continue;
    }
    if (token.span.start >= span.end) {
      break;
    }
    if (tokenIsExpressionLiteral(token)) {
      total = signatureMix(total, textHash(token.text));
    }
  }
  return total;
}

function tokenIsExpressionLiteral(token: SourceToken): boolean {
  return token.kind === "number" ||
    token.kind === "bool" ||
    token.kind === "string" ||
    token.kind === "char" ||
    token.kind === "multiline";
}

function tokenIsValueOperator(token: SourceToken): boolean {
  if (token.kind !== "symbol") {
    return false;
  }
  if (token.text === "=" || token.text === "=>" || token.text === "<-" || token.text === "->") {
    return false;
  }
  for (let index = 0; index < token.text.length; index++) {
    const code = token.text.charCodeAt(index);
    if (!operatorSymbolCodeMatches(code)) {
      return false;
    }
  }
  return token.text.length > 0;
}

function operatorSymbolCodeMatches(code: number): boolean {
  if (code === 33) return true;
  if (code === 36) return true;
  if (code === 37) return true;
  if (code === 38) return true;
  if (code === 42) return true;
  if (code === 43) return true;
  if (code === 45) return true;
  if (code === 47) return true;
  if (code === 60) return true;
  if (code === 61) return true;
  if (code === 62) return true;
  if (code === 94) return true;
  if (code === 124) return true;
  return false;
}

function expressionCallCount(expr: Expr | undefined): number {
  if (expr === undefined) {
    return 0;
  }
  let total = 0;
  if (expr.kind === "call") {
    const isParenthesizedExpression = expr.args.length === 0 && expr.callee.kind !== "var";
    if (!isParenthesizedExpression) {
      total += 1;
    }
    total += expressionCallCount(expr.callee);
    for (const arg of expr.args) {
      total += expressionCallCount(arg);
    }
    return total;
  }
  if (expr.kind === "match") {
    total += expressionCallCount(expr.value);
    for (const arm of expr.arms) {
      total += expressionCallCount(arm.guard);
      total += expressionCallCount(arm.value);
    }
    return total;
  }
  if (expr.kind === "block") {
    for (const statement of expr.statements) {
      total += statementValueCallCount(statement);
    }
    total += expressionCallCount(expr.expr);
    return total;
  }
  if (expr.kind === "do") {
    for (const statement of expr.statements) {
      if (statement.kind === "do_bind" || statement.kind === "do_expr") {
        total += expressionCallCount(statement.value);
      } else {
        total += statementValueCallCount(statement);
      }
    }
    total += expressionCallCount(expr.expr);
    return total;
  }
  if (expr.kind === "const_fn") {
    return expressionCallCount(expr.body);
  }
  if (expr.kind === "pipe_bind") {
    return expressionCallCount(expr.value) + expressionCallCount(expr.body);
  }
  if (expr.kind === "profile") {
    for (const arg of expr.args) {
      total += expressionCallCount(arg);
    }
    total += expressionCallCount(expr.body);
    return total;
  }
  if (expr.kind === "index") {
    return expressionCallCount(expr.target) + expressionCallCount(expr.index);
  }
  if (expr.kind === "binary") {
    return expressionCallCount(expr.left) + expressionCallCount(expr.right);
  }
  if (expr.kind === "operator_chain") {
    total += expressionCallCount(expr.first);
    for (const item of expr.rest) {
      total += expressionCallCount(item.value);
    }
    return total;
  }
  if (expr.kind === "shape") {
    for (const slot of expr.slots) {
      total += expressionCallCount(slot.value);
      total += expressionCallCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "static_for_slots") {
    return expressionCallCount(expr.value);
  }
  if (expr.kind === "field") {
    return expressionCallCount(expr.value) + expressionCallCount(expr.key);
  }
  if (expr.kind === "product_constructor") {
    for (const slot of expr.slots) {
      total += expressionCallCount(slot.value);
      total += expressionCallCount(slot.index);
    }
    return total;
  }
  if (expr.kind === "range") {
    return expressionCallCount(expr.start) + expressionCallCount(expr.end);
  }
  return 0;
}

function statementValueMatchArmCount(statement: Statement): number {
  if (statement.kind === "let" || statement.kind === "destructure_let") {
    return expressionMatchArmCount(statement.value);
  }
  if (statement.kind === "debug_trace") {
    let total = 0;
    for (const arg of statement.args) {
      total += expressionMatchArmCount(arg);
    }
    return total;
  }
  return 0;
}

function statementValuePipeBindCount(statement: Statement): number {
  if (statement.kind === "let" || statement.kind === "destructure_let") {
    return expressionPipeBindCount(statement.value);
  }
  if (statement.kind === "debug_trace") {
    let total = 0;
    for (const arg of statement.args) {
      total += expressionPipeBindCount(arg);
    }
    return total;
  }
  return 0;
}

function statementValueDoCount(statement: Statement): number {
  if (statement.kind === "let" || statement.kind === "destructure_let") {
    return expressionDoCount(statement.value);
  }
  if (statement.kind === "debug_trace") {
    let total = 0;
    for (const arg of statement.args) {
      total += expressionDoCount(arg);
    }
    return total;
  }
  return 0;
}

function statementValueDoBindCount(statement: Statement): number {
  if (statement.kind === "let" || statement.kind === "destructure_let") {
    return expressionDoBindCount(statement.value);
  }
  if (statement.kind === "debug_trace") {
    let total = 0;
    for (const arg of statement.args) {
      total += expressionDoBindCount(arg);
    }
    return total;
  }
  return 0;
}

function statementValueOperatorCount(statement: Statement): number {
  if (statement.kind === "let" || statement.kind === "destructure_let") {
    return expressionOperatorCount(statement.value);
  }
  if (statement.kind === "debug_trace") {
    let total = 0;
    for (const arg of statement.args) {
      total += expressionOperatorCount(arg);
    }
    return total;
  }
  return 0;
}

function statementValueCallCount(statement: Statement): number {
  if (statement.kind === "let" || statement.kind === "destructure_let") {
    return expressionCallCount(statement.value);
  }
  if (statement.kind === "debug_trace") {
    let total = 0;
    for (const arg of statement.args) {
      total += expressionCallCount(arg);
    }
    return total;
  }
  return 0;
}

function paramSignatureName(param: Param): string {
  if (param.pattern) return patternSignatureName(param.pattern);
  return param.name;
}

function patternSignatureName(pattern: ParamPattern): string {
  if (pattern.kind === "binding") return pattern.name;
  if (pattern.kind === "constructor") return pattern.name;
  if (pattern.kind === "type") return pattern.name;
  if (pattern.kind === "wildcard") return "_";
  if (pattern.kind === "literal") return pattern.value;
  return "(";
}

function typeParamSignatureName(param: TypeParam): string {
  return param.name;
}

function normalizedTypeSignatureHash(type: string | undefined): number {
  if (type === undefined) return 0;
  return textHash(type.replace(/\s+/g, ""));
}

function normalizedSourceSpanHash(
  source: string,
  span: { start: number; end: number } | undefined,
): number {
  if (span === undefined) return 0;
  return textHash(source.slice(span.start, span.end).replace(/\s+/g, ""));
}

function isTypeFunctionDeclaration(
  source: string,
  declSpan: { start: number; end: number } | undefined,
  bodySpan: { start: number; end: number } | undefined,
): boolean {
  if (declSpan === undefined) {
    return false;
  }
  let headerEnd = declSpan.end;
  if (bodySpan !== undefined) {
    headerEnd = bodySpan.start;
  }
  const header = source.slice(declSpan.start, headerEnd).replace(/\s+/g, " ");
  return header.trimStart().startsWith("type fn ");
}

function declarationSignatureHash(kindTag: number, nameHash: number, auxHash: number): number {
  let total = signatureMix(17, kindTag);
  total = signatureMix(total, nameHash);
  total = signatureMix(total, auxHash);
  return total;
}

function declarationKindTag(kind: Program["declarations"][number]["kind"]): number {
  if (kind === "fn") return 1;
  if (kind === "let") return 2;
  if (kind === "const") return 3;
  if (kind === "type") return 4;
  return 3;
}

function primaryDeclarationName(decl: Program["declarations"][number]): string {
  if (decl.kind === "type_assert") {
    return "";
  }
  if (decl.kind === "fn" && decl.memberOf) {
    return decl.memberOf.owner;
  }
  const memberIndex = decl.name.indexOf("::");
  if (memberIndex >= 0) return decl.name.slice(0, memberIndex);
  return decl.name;
}

function declarationAuxHash(decl: Program["declarations"][number]): number {
  if (decl.kind === "fn") return decl.params.length;
  if (decl.kind === "type") return decl.params.length;
  return 0;
}

function signatureMix(total: number, value: number): number {
  return (Math.imul(total, 131) + value) | 0;
}

function textHash(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let total = 0;
  for (const code of bytes) {
    total = (Math.imul(total, 33) + code) | 0;
  }
  return total;
}

function sourceCodes(source: string): number[] {
  return Array.from(new TextEncoder().encode(source), (code) => code);
}

async function goBuild(goDir: string, index: number): Promise<void> {
  const command = new Deno.Command("go", {
    args: [
      "build",
      "-buildvcs=false",
      "-o",
      `${runRoot}/compilerbench-${index}`,
      "./cmd/compilerbench",
    ],
    cwd: goDir,
    env: { GOCACHE: `${runRoot}/gocache` },
    stdout: "null",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}

async function resolveModule(
  moduleName: string,
  context?: ModuleResolveContext,
): Promise<ModuleSource | undefined> {
  const importer = context?.fromSourceId ?? figRoot;
  for (const path of candidateModulePaths(importer, moduleName)) {
    const text = figSources.get(path);
    if (text !== undefined) return { text, sourceId: path };
  }
  return undefined;
}

async function readFigSourceRoots(dirs: string[]): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const dir of dirs) {
    await readFigSources(dir, sources);
  }
  return sources;
}

async function readFigSources(dir: string, sources: Map<string, string>): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await readFigSources(path, sources);
      continue;
    }
    if (entry.isFile && entry.name.endsWith(".fig")) {
      sources.set(path, await Deno.readTextFile(path));
    }
  }
}

async function goSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  await collectFiles(dir, ".go", files);
  files.sort();
  return files;
}

async function collectFiles(dir: string, suffix: string, files: string[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      await collectFiles(path, suffix, files);
      continue;
    }
    if (entry.isFile && entry.name.endsWith(suffix)) {
      files.push(path);
    }
  }
}

async function sourceLoc(files: string[]): Promise<number> {
  let total = 0;
  for (const file of files) {
    total += lineCount(await Deno.readTextFile(file));
  }
  return total;
}

function sourceLocFromTexts(texts: Iterable<string>): number {
  let total = 0;
  for (const text of texts) {
    total += lineCount(text);
  }
  return total;
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

function runtimeArgs(): RuntimeName[] | undefined {
  const values: RuntimeName[] = [];
  for (const arg of Deno.args) {
    if (!arg.startsWith("--runtime=")) continue;
    for (const raw of arg.slice("--runtime=".length).split(",")) {
      const value = raw.trim();
      if (!value) continue;
      const runtime = normalizeRuntimeName(value);
      if (runtime === undefined) throw new Error(`${value} is not a runtime`);
      values.push(runtime);
    }
  }
  const runtimeFlagIndex = Deno.args.indexOf("--runtime");
  if (runtimeFlagIndex >= 0) {
    const raw = Deno.args[runtimeFlagIndex + 1];
    if (!raw) throw new Error("--runtime requires a value");
    for (const value of raw.split(",")) {
      const rawRuntime = value.trim();
      if (!rawRuntime) continue;
      const runtime = normalizeRuntimeName(rawRuntime);
      if (runtime === undefined) throw new Error(`${rawRuntime} is not a runtime`);
      values.push(runtime);
    }
  }
  return values.length ? values : undefined;
}

function normalizeRuntimeName(value: string): RuntimeName | undefined {
  if (value === "js" || value === "deno/js") return "deno/js";
  if (value === "fig" || value === "fig-wasm" || value === "deno/fig") return "deno/fig";
  if (value === "go") return "go";
  return undefined;
}

function shouldRun(runtime: RuntimeName): boolean {
  return !selectedRuntimes || selectedRuntimes.includes(runtime);
}

function unavailableMode(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const compact = message.replace(/\s+/g, " ").slice(0, 500);
  return `${prefix}: ${compact}`;
}

function numberArg(name: string, fallback: number): number {
  const eq = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  const raw = eq ? eq.slice(name.length + 1) : Deno.args[Deno.args.indexOf(name) + 1];
  if (!raw || Deno.args.indexOf(name) < 0 && !eq) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return Math.floor(value);
}

function optModeArg(name: string, fallback: FigWasmOptMode): FigWasmOptMode {
  const eq = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  const raw = eq ? eq.slice(name.length + 1) : Deno.args[Deno.args.indexOf(name) + 1];
  if (!raw || Deno.args.indexOf(name) < 0 && !eq) return fallback;
  if (raw === "debug" || raw === "release") return raw;
  throw new Error(`${name} must be debug or release`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function p90(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0;
}
