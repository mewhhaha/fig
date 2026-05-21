export async function explainOptimization(
  source: string,
  options: import("./mod.ts").CompileSourceOptions & import("./optimize.ts").OptimizeOptions = {},
): Promise<import("./optimize.ts").OptimizationPlan> {
  const [{ checkSource }, { summarizeBackendLayoutDecisions }, { summarizeOptimizationPlan }] =
    await Promise.all([
      import("./mod.ts"),
      import("./backend.ts"),
      import("./optimize.ts"),
    ]);
  const checked = await checkSource(source, options);
  const plan = summarizeOptimizationPlan(checked.program, options);
  for (const decision of summarizeBackendLayoutDecisions(checked.program, options)) {
    plan.decisions.push(decision);
    const fnName = typeof decision.evidence?.function === "string"
      ? decision.evidence.function
      : undefined;
    const target = typeof decision.evidence?.target === "string"
      ? decision.evidence.target
      : decision.target;
    const layout = decision.evidence?.layout;
    if (
      fnName &&
      (layout === "packed" || layout === "scratch" || layout === "local_slots")
    ) {
      plan.functions.get(fnName)?.actions.push({
        kind: "choose_layout",
        target,
        layout,
        reason: decision.reason,
      });
    }
  }
  return plan;
}

export {
  type BackendModule,
  backendModuleToWasm,
  backendModuleToWat,
  type BackendPhaseTimings,
  compileBackendModule,
  type LoweredBackendArtifact,
  lowerProgramToBackendArtifact,
  lowerProgramToBackendModule,
  summarizeBackendLayoutDecisions,
  wasmFromBackendModule,
  watFromBackendModule,
} from "./backend.ts";
export {
  type AbstractFunctionFacts,
  type AbstractValue,
  type FunctionFacts,
  type FunctionPlan,
  type LayoutCandidate,
  OPTIMIZATION_RULES,
  type OptimizationDecision,
  type OptimizationPlan,
  type OptimizationRule,
  type OptimizationRuleId,
  OPTIMIZE_PROFILES,
  type OptimizeProfile,
  type OptimizeProfileName,
  optimizeProgram,
  type PlannedAction,
  type Recurrence,
  type RewriteRule,
  type RewriteRuleId,
  summarizeAbstractValues,
  summarizeOptimizationPlan,
  summarizeProgram,
  summarizeRecurrences,
} from "./optimize.ts";
