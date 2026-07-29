import { BENCHMARK_TOKEN_COUNT_SOURCES, ProjectCostReport } from "./dependencies.js";
import { asRecord } from "./api-request-validation-helpers.js";
import {
  asArray,
  assertBoolean,
  assertEnum,
  assertNonNegativeInteger,
  assertNonNegativeNumber,
  assertNullableString,
  assertString,
} from "./api-validation-primitives.js";

export function assertProjectCostReport(
  value: unknown,
  label = "ProjectCostReport",
): asserts value is ProjectCostReport {
  const report = asRecord(value, label);
  assertString(report.projectId, `${label}.projectId`);
  assertEnum(report.currency, ["USD"] as const, `${label}.currency`);
  assertNonNegativeInteger(report.runCount, `${label}.runCount`);
  assertNonNegativeInteger(report.billedMicrosUsd, `${label}.billedMicrosUsd`);
  assertNonNegativeInteger(report.zeroRunCount, `${label}.zeroRunCount`);
  const totals = asArray(report.totalsByCostKind, `${label}.totalsByCostKind`);
  for (const [index, totalValue] of totals.entries()) {
    const total = asRecord(totalValue, `${label}.totalsByCostKind[${index}]`);
    assertEnum(
      total.costKind,
      ["billed", "provider_estimate", "zero"] as const,
      `${label}.totalsByCostKind[${index}].costKind`,
    );
    assertNonNegativeInteger(total.runCount, `${label}.totalsByCostKind[${index}].runCount`);
    assertNonNegativeInteger(
      total.amountMicrosUsd,
      `${label}.totalsByCostKind[${index}].amountMicrosUsd`,
    );
    assertNonNegativeInteger(
      total.promptTokens,
      `${label}.totalsByCostKind[${index}].promptTokens`,
    );
    assertNonNegativeInteger(
      total.completionTokens,
      `${label}.totalsByCostKind[${index}].completionTokens`,
    );
    assertNonNegativeInteger(total.totalTokens, `${label}.totalsByCostKind[${index}].totalTokens`);
  }
  const recentRuns = asArray(report.recentRuns, `${label}.recentRuns`);
  for (const [index, runValue] of recentRuns.entries()) {
    const run = asRecord(runValue, `${label}.recentRuns[${index}]`);
    assertString(run.providerRunId, `${label}.recentRuns[${index}].providerRunId`);
    assertString(run.taskKind, `${label}.recentRuns[${index}].taskKind`);
    assertString(run.status, `${label}.recentRuns[${index}].status`);
    assertString(run.startedAt, `${label}.recentRuns[${index}].startedAt`);
    assertString(run.structuredOutputMode, `${label}.recentRuns[${index}].structuredOutputMode`);
    assertNonNegativeInteger(run.retryCount, `${label}.recentRuns[${index}].retryCount`);
    const errorClasses = asArray(run.errorClasses, `${label}.recentRuns[${index}].errorClasses`);
    for (const [errorIndex, errorClass] of errorClasses.entries()) {
      assertString(errorClass, `${label}.recentRuns[${index}].errorClasses[${errorIndex}]`);
    }
    assertString(run.providerFamily, `${label}.recentRuns[${index}].providerFamily`);
    assertString(run.endpointFamily, `${label}.recentRuns[${index}].endpointFamily`);
    assertString(run.providerName, `${label}.recentRuns[${index}].providerName`);
    assertString(run.requestedModelId, `${label}.recentRuns[${index}].requestedModelId`);
    assertString(run.actualModelId, `${label}.recentRuns[${index}].actualModelId`);
    assertNullableString(run.upstreamProvider, `${label}.recentRuns[${index}].upstreamProvider`);
    assertNullableString(run.routeSettingsHash, `${label}.recentRuns[${index}].routeSettingsHash`);
    assertString(run.promptPresetId, `${label}.recentRuns[${index}].promptPresetId`);
    assertString(run.promptTemplateVersion, `${label}.recentRuns[${index}].promptTemplateVersion`);
    assertString(run.promptHash, `${label}.recentRuns[${index}].promptHash`);
    assertBoolean(run.fallbackUsed, `${label}.recentRuns[${index}].fallbackUsed`);
    const fallbackPlan = asArray(run.fallbackPlan, `${label}.recentRuns[${index}].fallbackPlan`);
    for (const [fallbackIndex, fallbackModel] of fallbackPlan.entries()) {
      assertString(fallbackModel, `${label}.recentRuns[${index}].fallbackPlan[${fallbackIndex}]`);
    }
    assertEnum(
      run.costKind,
      ["billed", "provider_estimate", "zero"] as const,
      `${label}.recentRuns[${index}].costKind`,
    );
    if (run.amountMicrosUsd !== null) {
      assertNonNegativeInteger(
        run.amountMicrosUsd,
        `${label}.recentRuns[${index}].amountMicrosUsd`,
      );
    }
    assertEnum(
      run.tokenCountSource,
      BENCHMARK_TOKEN_COUNT_SOURCES,
      `${label}.recentRuns[${index}].tokenCountSource`,
    );
    const tokenTotalLabel = `${label}.recentRuns[${index}].totalTokens`;
    for (const tokenField of [
      "promptTokens",
      "completionTokens",
      "reasoningTokens",
      "cachedInputTokens",
    ] as const) {
      if (run[tokenField] !== null) {
        assertNonNegativeInteger(run[tokenField], `${label}.recentRuns[${index}].${tokenField}`);
      }
    }
    if (run.totalTokens !== null) {
      assertNonNegativeInteger(run.totalTokens, tokenTotalLabel);
    }
    if (run.tokenCountSource === "unknown" && run.totalTokens !== null) {
      throw new Error(
        `${label}.recentRuns[${index}] unknown token source must not include totalTokens`,
      );
    }
    const tokenSubtotal =
      (run.promptTokens === null ? 0 : Number(run.promptTokens)) +
      (run.completionTokens === null ? 0 : Number(run.completionTokens)) +
      (run.reasoningTokens === null ? 0 : Number(run.reasoningTokens));
    if (run.totalTokens !== null && run.totalTokens < tokenSubtotal) {
      throw new Error(
        `${tokenTotalLabel} must cover promptTokens, completionTokens, and reasoningTokens`,
      );
    }
    // policy — every run row carries the captured OR routing
    // posture (the `provider: { order, allow_fallbacks, data_collection,
    // zdr, require_parameters }` block that hit the wire) on
    // `routing_posture`. Pre-migration rows carry the sentinel
    // `{_pre_itotori_230: true}`. We validate the field is present and
    // an object; the typed shape is enforced at the application layer
    // (OpenRouterRoutingPosture).
    asRecord(run.routingPosture, `${label}.recentRuns[${index}].routingPosture`);
  }
  const reuse = asRecord(report.translationMemoryReuse, `${label}.translationMemoryReuse`);
  assertNonNegativeInteger(
    reuse.reuseEventCount,
    `${label}.translationMemoryReuse.reuseEventCount`,
  );
  assertNonNegativeInteger(reuse.appliedCount, `${label}.translationMemoryReuse.appliedCount`);
  assertNonNegativeInteger(reuse.suggestedCount, `${label}.translationMemoryReuse.suggestedCount`);
  assertNonNegativeInteger(
    reuse.providerCallAvoidedCount,
    `${label}.translationMemoryReuse.providerCallAvoidedCount`,
  );
  assertNonNegativeInteger(
    reuse.estimatedPromptTokensSaved,
    `${label}.translationMemoryReuse.estimatedPromptTokensSaved`,
  );
  assertNonNegativeInteger(
    reuse.estimatedCompletionTokensSaved,
    `${label}.translationMemoryReuse.estimatedCompletionTokensSaved`,
  );
  assertNonNegativeInteger(
    reuse.estimatedTotalTokensSaved,
    `${label}.translationMemoryReuse.estimatedTotalTokensSaved`,
  );
  if (reuse.estimatedCostUsdSaved !== null) {
    assertNonNegativeNumber(
      reuse.estimatedCostUsdSaved,
      `${label}.translationMemoryReuse.estimatedCostUsdSaved`,
    );
  }
  const recentEvents = asArray(reuse.recentEvents, `${label}.translationMemoryReuse.recentEvents`);
  for (const [index, eventValue] of recentEvents.entries()) {
    const event = asRecord(eventValue, `${label}.translationMemoryReuse.recentEvents[${index}]`);
    assertString(
      event.reuseEventId,
      `${label}.translationMemoryReuse.recentEvents[${index}].reuseEventId`,
    );
    assertString(
      event.localeBranchId,
      `${label}.translationMemoryReuse.recentEvents[${index}].localeBranchId`,
    );
    assertString(
      event.targetBridgeUnitId,
      `${label}.translationMemoryReuse.recentEvents[${index}].targetBridgeUnitId`,
    );
    assertString(
      event.memorySegmentId,
      `${label}.translationMemoryReuse.recentEvents[${index}].memorySegmentId`,
    );
    assertString(
      event.matchKind,
      `${label}.translationMemoryReuse.recentEvents[${index}].matchKind`,
    );
    assertNonNegativeInteger(
      event.matchScore,
      `${label}.translationMemoryReuse.recentEvents[${index}].matchScore`,
    );
    assertString(
      event.reuseStatus,
      `${label}.translationMemoryReuse.recentEvents[${index}].reuseStatus`,
    );
    assertString(
      event.sourceHash,
      `${label}.translationMemoryReuse.recentEvents[${index}].sourceHash`,
    );
    assertString(
      event.candidateSourceHash,
      `${label}.translationMemoryReuse.recentEvents[${index}].candidateSourceHash`,
    );
    assertString(
      event.targetText,
      `${label}.translationMemoryReuse.recentEvents[${index}].targetText`,
    );
    assertBoolean(
      event.providerCallAvoided,
      `${label}.translationMemoryReuse.recentEvents[${index}].providerCallAvoided`,
    );
    assertNonNegativeInteger(
      event.estimatedPromptTokensSaved,
      `${label}.translationMemoryReuse.recentEvents[${index}].estimatedPromptTokensSaved`,
    );
    assertNonNegativeInteger(
      event.estimatedCompletionTokensSaved,
      `${label}.translationMemoryReuse.recentEvents[${index}].estimatedCompletionTokensSaved`,
    );
    assertNonNegativeInteger(
      event.estimatedTotalTokensSaved,
      `${label}.translationMemoryReuse.recentEvents[${index}].estimatedTotalTokensSaved`,
    );
    if (event.estimatedCostUsdSaved !== null) {
      assertNonNegativeNumber(
        event.estimatedCostUsdSaved,
        `${label}.translationMemoryReuse.recentEvents[${index}].estimatedCostUsdSaved`,
      );
    }
    assertString(
      event.calculation,
      `${label}.translationMemoryReuse.recentEvents[${index}].calculation`,
    );
    asRecord(event.provenance, `${label}.translationMemoryReuse.recentEvents[${index}].provenance`);
    assertString(
      event.createdAt,
      `${label}.translationMemoryReuse.recentEvents[${index}].createdAt`,
    );
  }
}
