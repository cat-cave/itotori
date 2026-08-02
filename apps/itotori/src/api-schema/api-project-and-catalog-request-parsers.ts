import {
  BridgeBundleV02,
  assertBenchmarkReportV02,
  assertRuntimeEvidenceReportV02,
  parseExtractApiRequest,
} from "./dependencies.js";
import { STRICT_API_BODY_KEYS } from "./api-strict-body-keys.js";
import {
  ApiBootstrapCatalogCandidate,
  ApiBootstrapCatalogSelection,
  ApiBootstrapCatalogSourceId,
  ApiConfigureAuthSsoSettingsRequest,
  ApiDraftBranchRequest,
  ApiProjectDecodeExtractRequest,
  ApiProjectImportRequest,
  ApiRecordBenchmarkRequest,
  ApiRecordFindingRequest,
  ApiRuntimeEvidenceRequest,
} from "./api-response-types.js";
import {
  ApiSaveBranchPolicySettingsRequest,
  ApiSaveModelRoutingSettingsRequest,
} from "./api-settings-and-membership-types.js";
import {
  assertCatalogBenchmarkSeedSourceIds,
  assertNullablePublicOpportunityString,
  assertPublicOpportunityString,
} from "./api-catalog-benchmark-validation.js";
import { assertProjectState } from "./api-project-response-validation.js";
import { parseBranchPolicyPolicy } from "./api-settings-response-validation.js";
import {
  asRecord,
  assertBridgeInput,
  assertFindingRecordInput,
  parseAccountSecuritySettings,
  parseAuthSessionPolicy,
  parseAuthSsoProviderConfig,
  parseRequest,
} from "./api-request-validation-helpers.js";
import {
  asArray,
  asStrictRecord,
  assertEnum,
  assertNullableString,
  assertString,
  assertStringArray,
} from "./api-validation-primitives.js";

export class ApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiValidationError";
  }
}

export function parseProjectImportRequest(body: unknown): ApiProjectImportRequest {
  return parseRequest("ApiProjectImportRequest", () => {
    const request = asRecord(body, "ApiProjectImportRequest");
    assertBridgeInput(request.bridge);
    const bootstrapSelection =
      request.bootstrapSelection === undefined
        ? undefined
        : parseBootstrapCatalogSelection(request.bootstrapSelection, request.bridge);
    return {
      bridge: request.bridge,
      ...(bootstrapSelection === undefined ? {} : { bootstrapSelection }),
    };
  });
}

export function parseProjectDecodeExtractRequest(body: unknown): ApiProjectDecodeExtractRequest {
  return parseRequest("ApiProjectDecodeExtractRequest", () => parseExtractApiRequest(body));
}

export function parseDraftBranchRequest(body: unknown): ApiDraftBranchRequest {
  return parseRequest("ApiDraftBranchRequest", () => {
    const request = asRecord(body, "ApiDraftBranchRequest");
    assertProjectState(request.project, "ApiDraftBranchRequest.project");
    assertString(request.targetLocale, "ApiDraftBranchRequest.targetLocale");
    return { project: request.project, targetLocale: request.targetLocale };
  });
}

export function parseBootstrapCatalogSelection(
  value: unknown,
  bridge: BridgeBundleV02,
): ApiBootstrapCatalogSelection {
  const selection = asStrictRecord(value, "ApiBootstrapCatalogSelection", [
    "selectedWorkId",
    "candidates",
  ]);
  assertString(selection.selectedWorkId, "ApiBootstrapCatalogSelection.selectedWorkId");
  const candidates = parseBootstrapCatalogCandidates(
    selection.candidates,
    "ApiBootstrapCatalogSelection.candidates",
  );
  const parsed = { selectedWorkId: selection.selectedWorkId, candidates };
  assertBootstrapSelectionMatchesBridge(parsed, bridge);
  return parsed;
}

export function parseBootstrapCatalogCandidates(
  value: unknown,
  label: string,
): ApiBootstrapCatalogCandidate[] {
  const rows = asArray(value, label);
  if (rows.length === 0) {
    throw new Error(`${label} must include at least one candidate`);
  }
  return rows.map((candidateValue, index) => {
    const candidateLabel = `${label}[${index}]`;
    const candidate = asStrictRecord(candidateValue, candidateLabel, [
      "workId",
      "canonicalTitle",
      "sourceIds",
      "adapterId",
    ]);
    assertPublicOpportunityString(candidate.workId, `${candidateLabel}.workId`);
    assertPublicOpportunityString(candidate.canonicalTitle, `${candidateLabel}.canonicalTitle`);
    assertCatalogBenchmarkSeedSourceIds(candidate.sourceIds, `${candidateLabel}.sourceIds`);
    assertNullablePublicOpportunityString(candidate.adapterId, `${candidateLabel}.adapterId`);
    return {
      workId: candidate.workId,
      canonicalTitle: candidate.canonicalTitle,
      sourceIds: candidate.sourceIds as ApiBootstrapCatalogSourceId[],
      adapterId: candidate.adapterId,
    };
  });
}

export function assertBootstrapSelectionMatchesBridge(
  selection: ApiBootstrapCatalogSelection,
  bridge: BridgeBundleV02,
): void {
  const selected = selection.candidates.find(
    (candidate) => candidate.workId === selection.selectedWorkId,
  );
  if (selected === undefined) {
    throw new Error("ApiBootstrapCatalogSelection.selectedWorkId must identify a candidate");
  }

  const bridgeIdentity = bridgeSourceIdentityValues(bridge);
  const selectedIdentity = catalogCandidateIdentityValues(selected);
  if (intersects(bridgeIdentity, selectedIdentity)) {
    return;
  }

  throw new Error("Selected catalog candidate does not match the uploaded bridge source identity");
}

export function bridgeSourceIdentityValues(bridge: BridgeBundleV02): Set<string> {
  return new Set([bridge.sourceGame.gameId]);
}

export function catalogCandidateIdentityValues(
  candidate: ApiBootstrapCatalogCandidate,
): Set<string> {
  return new Set([
    candidate.workId,
    ...candidate.sourceIds.flatMap((sourceId) => [
      sourceId.sourceId,
      `${sourceId.catalogSource}:${sourceId.sourceId}`,
    ]),
  ]);
}

export function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

export function parseRecordFindingRequest(body: unknown): ApiRecordFindingRequest {
  return parseRequest("ApiRecordFindingRequest", () => {
    const request = asRecord(body, "ApiRecordFindingRequest");
    if (request.localeBranchId !== undefined) {
      assertString(request.localeBranchId, "ApiRecordFindingRequest.localeBranchId");
    }
    assertFindingRecordInput(request.finding, "ApiRecordFindingRequest.finding");
    const result: ApiRecordFindingRequest = { finding: request.finding };
    if (request.localeBranchId !== undefined) {
      result.localeBranchId = request.localeBranchId;
    }
    if (request.status !== undefined) {
      assertEnum(
        request.status,
        ["open", "resolved", "superseded"] as const,
        "ApiRecordFindingRequest.status",
      );
      result.status = request.status;
    }
    return result;
  });
}

export function parseRecordBenchmarkRequest(body: unknown): ApiRecordBenchmarkRequest {
  return parseRequest("ApiRecordBenchmarkRequest", () => {
    const request = asRecord(body, "ApiRecordBenchmarkRequest");
    assertBenchmarkReportV02(request.benchmarkReport);
    // policy — the recorded benchmark MUST self-identify its locale
    // branch. There is no separate envelope channel and no project-level
    // fallback: a report that omits localeBranchId is rejected so cost +
    // benchmark records can never be attributed to the wrong branch.
    if (request.benchmarkReport.localeBranchId === undefined) {
      throw new ApiValidationError(
        "ApiRecordBenchmarkRequest.benchmarkReport.localeBranchId is required (a benchmark must identify its target locale branch)",
      );
    }
    return { benchmarkReport: request.benchmarkReport };
  });
}

export function parseRuntimeEvidenceRequest(body: unknown): ApiRuntimeEvidenceRequest {
  return parseRequest("ApiRuntimeEvidenceRequest", () => {
    const request = asRecord(body, "ApiRuntimeEvidenceRequest");
    assertProjectState(request.project, "ApiRuntimeEvidenceRequest.project");
    assertRuntimeEvidenceReportV02(request.runtimeReport);
    return { project: request.project, runtimeReport: request.runtimeReport };
  });
}

export function parseConfigureAuthSsoSettingsRequest(
  body: unknown,
): ApiConfigureAuthSsoSettingsRequest {
  return parseRequest("ApiConfigureAuthSsoSettingsRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiConfigureAuthSsoSettingsRequest",
      STRICT_API_BODY_KEYS.ApiConfigureAuthSsoSettingsRequest,
    );
    assertString(request.accountId, "ApiConfigureAuthSsoSettingsRequest.accountId");
    return {
      accountId: request.accountId,
      provider: parseAuthSsoProviderConfig(
        request.provider,
        "ApiConfigureAuthSsoSettingsRequest.provider",
      ),
      security: parseAccountSecuritySettings(
        request.security,
        "ApiConfigureAuthSsoSettingsRequest.security",
      ),
      sessionPolicy: parseAuthSessionPolicy(
        request.sessionPolicy,
        "ApiConfigureAuthSsoSettingsRequest.sessionPolicy",
      ),
    };
  });
}

export function parseSaveModelRoutingSettingsRequest(
  body: unknown,
): ApiSaveModelRoutingSettingsRequest {
  return parseRequest("ApiSaveModelRoutingSettingsRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiSaveModelRoutingSettingsRequest",
      STRICT_API_BODY_KEYS.ApiSaveModelRoutingSettingsRequest,
    );
    assertString(request.projectId, "ApiSaveModelRoutingSettingsRequest.projectId");
    assertString(request.taskKind, "ApiSaveModelRoutingSettingsRequest.taskKind");
    assertString(request.providerId, "ApiSaveModelRoutingSettingsRequest.providerId");
    assertString(request.modelId, "ApiSaveModelRoutingSettingsRequest.modelId");
    assertStringArray(
      request.fallbackModelIds,
      "ApiSaveModelRoutingSettingsRequest.fallbackModelIds",
    );
    const fallbackModelIds = asArray(
      request.fallbackModelIds,
      "ApiSaveModelRoutingSettingsRequest.fallbackModelIds",
    ) as string[];
    assertString(request.promptPresetId, "ApiSaveModelRoutingSettingsRequest.promptPresetId");
    assertString(
      request.promptTemplateVersion,
      "ApiSaveModelRoutingSettingsRequest.promptTemplateVersion",
    );
    return {
      projectId: request.projectId,
      taskKind: request.taskKind,
      providerId: request.providerId,
      modelId: request.modelId,
      fallbackModelIds: [...fallbackModelIds],
      promptPresetId: request.promptPresetId,
      promptTemplateVersion: request.promptTemplateVersion,
    };
  });
}

export function parseSaveBranchPolicySettingsRequest(
  body: unknown,
): ApiSaveBranchPolicySettingsRequest {
  return parseRequest("ApiSaveBranchPolicySettingsRequest", () => {
    const request = asStrictRecord(
      body,
      "ApiSaveBranchPolicySettingsRequest",
      STRICT_API_BODY_KEYS.ApiSaveBranchPolicySettingsRequest,
    );
    assertString(request.projectId, "ApiSaveBranchPolicySettingsRequest.projectId");
    assertString(request.localeBranchId, "ApiSaveBranchPolicySettingsRequest.localeBranchId");
    assertNullableString(
      request.expectedPreviousVersionId,
      "ApiSaveBranchPolicySettingsRequest.expectedPreviousVersionId",
    );
    assertString(request.updateReason, "ApiSaveBranchPolicySettingsRequest.updateReason");
    return {
      projectId: request.projectId,
      localeBranchId: request.localeBranchId,
      expectedPreviousVersionId: request.expectedPreviousVersionId,
      updateReason: request.updateReason,
      policy: parseBranchPolicyPolicy(request.policy, "ApiSaveBranchPolicySettingsRequest.policy"),
    };
  });
}
