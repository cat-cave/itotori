import * as deps from "./project-repository-dependencies.js";
import * as api from "./project-repository-types.js";
import * as helpers from "./project-repository-helpers.js";

export function runtimeArtifactRefForDb(
  artifactRef: deps.RuntimeArtifactRefV02,
  runtimeReportId?: string,
): deps.RuntimeArtifactRefV02 {
  helpers.assertPortableRuntimeSchemaArtifactUri(artifactRef.uri);
  const artifactId =
    runtimeReportId === undefined
      ? artifactRef.artifactId
      : helpers.runtimeChildIdFor(runtimeReportId, artifactRef.artifactId);
  const artifactKind = artifactRef.artifactKind;
  const uri =
    runtimeReportId === undefined
      ? artifactRef.uri
      : helpers.runtimeManagedArtifactUriForDb(artifactRef, runtimeReportId);
  const mediaType = artifactRef.mediaType;
  const byteSize = artifactRef.byteSize;
  return {
    artifactId,
    artifactKind,
    uri,
    hash:
      artifactRef.hash ??
      helpers.runtimeManagedArtifactHash({
        artifactId,
        artifactKind,
        uri,
        ...(mediaType === undefined ? {} : { mediaType }),
        ...(byteSize === undefined ? {} : { byteSize }),
      }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(byteSize === undefined ? {} : { byteSize }),
  };
}

export function runtimeChildIdFor(runtimeReportId: string, adapterLocalId: string): string {
  // Runtime adapter child ids are only unique within a report. Repository-owned child
  // evidence rows and derived child artifacts use run-qualified ids to prevent cross-run moves.
  return `${runtimeReportId}:${adapterLocalId}`;
}

export function runtimeManagedArtifactHash(ref: {
  artifactId: string;
  artifactKind: string;
  uri: string;
  mediaType?: string;
  byteSize?: number;
}): string {
  return `sha256:${deps.createHash("sha256").update(helpers.stableJsonStringify(ref)).digest("hex")}`;
}

export const RUNTIME_MANAGED_ARTIFACT_URI_ROOT = "artifacts/utsushi/runtime";

export const RUNTIME_MANAGED_ARTIFACT_KINDS = new Set<string>(deps.RUNTIME_ARTIFACT_KINDS_V02);

export const RUNTIME_ARTIFACT_KIND_DIRECTORIES: Record<deps.RuntimeArtifactKindV02, string> = {
  trace_log: "traces",
  screenshot: "screenshots",
  recording: "recordings",
  capture_metadata: "frame-captures",
  reference_comparison: "conformance-reports",
  runtime_report: "reports",
};

export const RUNTIME_ARTIFACT_KIND_EXTENSIONS: Record<deps.RuntimeArtifactKindV02, string> = {
  trace_log: ".json",
  screenshot: ".png",
  recording: ".webm",
  capture_metadata: ".json",
  reference_comparison: ".json",
  runtime_report: ".json",
};

export function runtimeManagedArtifactUriForDb(
  artifactRef: deps.RuntimeArtifactRefV02,
  runtimeReportId: string,
): string {
  if (artifactRef.uri.startsWith(`${helpers.RUNTIME_MANAGED_ARTIFACT_URI_ROOT}/`)) {
    return artifactRef.uri;
  }
  const directory = helpers.RUNTIME_ARTIFACT_KIND_DIRECTORIES[artifactRef.artifactKind];
  const extension =
    helpers.runtimeArtifactUriExtension(artifactRef.uri) ??
    helpers.RUNTIME_ARTIFACT_KIND_EXTENSIONS[artifactRef.artifactKind];
  return [
    helpers.RUNTIME_MANAGED_ARTIFACT_URI_ROOT,
    runtimeReportId,
    directory,
    `${artifactRef.artifactId}${extension}`,
  ].join("/");
}

export function runtimeArtifactUriExtension(uri: string): string | undefined {
  const filename = uri.split("/").at(-1) ?? "";
  const match = filename.match(/\.[A-Za-z0-9]+$/);
  return match?.[0];
}

export function runtimeTraceEventForDb(
  event: deps.RuntimeEvidenceReportV02["traceEvents"][number],
): Record<string, unknown> {
  return {
    traceEventId: event.traceEventId,
    eventKind: event.eventKind,
    bridgeUnitRef: event.bridgeUnitRef,
    frame: event.frame,
    traceKey: event.traceKey ?? null,
    observedText: event.observedText ?? null,
    artifactRef:
      event.artifactRef === undefined ? null : helpers.runtimeArtifactRefForDb(event.artifactRef),
  };
}

export function runtimeBranchEventForDb(
  event: deps.RuntimeEvidenceReportV02["branchEvents"][number],
): Record<string, unknown> {
  return {
    branchEventId: event.branchEventId,
    bridgeUnitRef: event.bridgeUnitRef,
    frame: event.frame,
    branchPointKey: event.branchPointKey ?? null,
    promptText: event.promptText ?? null,
    selectedOptionId: event.selectedOptionId ?? null,
    options: event.options.map((option) => ({
      optionId: option.optionId,
      label: option.label ?? null,
      labelBridgeUnitRef: option.labelBridgeUnitRef ?? null,
      targetRouteKey: option.targetRouteKey ?? null,
      targetBridgeUnitRef: option.targetBridgeUnitRef ?? null,
    })),
  };
}

export function runtimeCaptureForDb(
  capture: deps.RuntimeEvidenceReportV02["captures"][number],
): Record<string, unknown> {
  return {
    captureId: capture.captureId,
    bridgeUnitRef: capture.bridgeUnitRef,
    evidenceTier: capture.evidenceTier,
    frame: capture.frame,
    width: capture.width,
    height: capture.height,
    nonZeroPixels: capture.nonZeroPixels ?? null,
    region: capture.region ?? null,
    artifactRef: helpers.runtimeArtifactRefForDb(capture.artifactRef),
  };
}

export function runtimeRecordingForDb(
  recording: deps.RuntimeEvidenceReportV02["recordings"][number],
): Record<string, unknown> {
  return {
    recordingId: recording.recordingId,
    bridgeUnitRef: recording.bridgeUnitRef,
    evidenceTier: recording.evidenceTier,
    startedAtFrame: recording.startedAtFrame,
    frameCount: recording.frameCount,
    width: recording.width,
    height: recording.height,
    encoding: recording.encoding,
    artifactRef: helpers.runtimeArtifactRefForDb(recording.artifactRef),
  };
}

export function runtimeReferenceComparisonForDb(
  comparison: NonNullable<deps.RuntimeEvidenceReportV02["referenceComparisons"]>[number],
): Record<string, unknown> {
  return {
    comparisonId: comparison.comparisonId,
    comparisonKind: comparison.comparisonKind,
    status: comparison.status,
    scope: comparison.scope,
    coveredBridgeUnitRefs: comparison.coveredBridgeUnitRefs,
    artifactRef: helpers.runtimeArtifactRefForDb(comparison.artifactRef),
  };
}

export function runtimeValidationFindingForDb(
  finding: deps.RuntimeValidationFindingV02,
): Record<string, unknown> {
  return {
    findingId: finding.findingId,
    findingKind: finding.findingKind,
    severity: finding.severity,
    bridgeUnitRef: finding.bridgeUnitRef ?? null,
    artifactRef:
      finding.artifactRef === undefined
        ? null
        : helpers.runtimeArtifactRefForDb(finding.artifactRef),
    message: finding.message,
    evidenceTier: finding.evidenceTier,
  };
}

export function assertPortableRelativeArtifactUri(uri: string): void {
  helpers.assertPortableRuntimeArtifactUri(uri, {
    allowFixtureUri: false,
    requireManagedRoot: true,
  });
}

export function assertPortableRuntimeSchemaArtifactUri(uri: string): void {
  helpers.assertPortableRuntimeArtifactUri(uri, {
    allowFixtureUri: false,
    requireManagedRoot: false,
  });
}

export function assertPortableLegacyRuntimeArtifactUri(uri: string): void {
  helpers.assertPortableRuntimeArtifactUri(uri, {
    allowFixtureUri: true,
    requireManagedRoot: false,
  });
}

export function assertPortableRuntimeArtifactUri(
  uri: string,
  options: { allowFixtureUri: boolean; requireManagedRoot: boolean },
): void {
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri);
  const allowedFixtureUri = options.allowFixtureUri && uri.startsWith("fixture://");
  const hasTraversalSegment = uri.split("/").some((segment) => segment === "." || segment === "..");
  const hasEmptyPathSegment = uri.split("/").some((segment) => segment.length === 0);
  if (
    uri.startsWith("data:") ||
    uri.startsWith("blob:") ||
    uri.startsWith("file:") ||
    (hasScheme && !allowedFixtureUri) ||
    uri.startsWith("/") ||
    uri.includes("\\") ||
    hasTraversalSegment ||
    (!allowedFixtureUri && hasEmptyPathSegment)
  ) {
    throw new Error(`runtime artifact uri must be a portable relative artifact path: ${uri}`);
  }
  if (
    options.requireManagedRoot &&
    !uri.startsWith(`${helpers.RUNTIME_MANAGED_ARTIFACT_URI_ROOT}/`)
  ) {
    throw new Error(
      `runtime artifact uri must be under managed runtime artifact root ${helpers.RUNTIME_MANAGED_ARTIFACT_URI_ROOT}/: ${uri}`,
    );
  }
}

export function isRuntimeEvidenceReportV02(
  report: helpers.RuntimeReportInput,
): report is deps.RuntimeEvidenceReportV02 {
  return report.schemaVersion === "0.2.0";
}

export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function benchmarkReportSummaryFromRow(
  row: Record<string, unknown>,
): api.BenchmarkReportSummary {
  const metadata = helpers.isRecord(row.metadata) ? row.metadata : {};
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at ?? metadata.createdAt ?? "");
  const qaAgentsRaw = Array.isArray(metadata.qaAgents) ? metadata.qaAgents : [];
  return {
    benchmarkRunId: String(row.artifact_id),
    projectId: String(row.project_id),
    localeBranchId: helpers.nullableString(row.locale_branch_id),
    benchmarkName: String(metadata.benchmarkName ?? ""),
    status: String(metadata.status ?? "unknown"),
    createdAt,
    sourceLocale: String(metadata.sourceLocale ?? ""),
    targetLocale: String(metadata.targetLocale ?? ""),
    systemCount: Number(metadata.systemCount ?? 0),
    findingCount: Number(metadata.findingCount ?? 0),
    penaltyTotal: Number(metadata.penaltyTotal ?? 0),
    qaAgents: qaAgentsRaw.map(helpers.benchmarkQaAgentSummaryFromMetadata),
  };
}

export function benchmarkQaAgentSummaryFromMetadata(value: unknown): api.BenchmarkQaAgentSummary {
  const record = helpers.isRecord(value) ? value : {};
  return {
    qaAgentId: String(record.qaAgentId ?? ""),
    qaAgentVersion: String(record.qaAgentVersion ?? ""),
    evaluatedSystemId: String(record.evaluatedSystemId ?? ""),
    truePositives: Number(record.truePositives ?? 0),
    falsePositives: Number(record.falsePositives ?? 0),
    falseNegatives: Number(record.falseNegatives ?? 0),
    seededPrecision: Number(record.seededPrecision ?? 0),
    seededRecall: Number(record.seededRecall ?? 0),
    f1: Number(record.f1 ?? 0),
    findingsEmitted: Number(record.findingsEmitted ?? 0),
    scorableFindings: Number(record.scorableFindings ?? 0),
  };
}

export async function getApprovedStyleGuideVersionIdInTx(
  db: Pick<deps.ItotoriDatabase, "select">,
  localeBranchId: string,
): Promise<string | null> {
  const rows = await db
    .select({ approvedVersionId: deps.styleGuides.approvedVersionId })
    .from(deps.styleGuides)
    .where(deps.eq(deps.styleGuides.localeBranchId, localeBranchId))
    .limit(1);
  return rows[0]?.approvedVersionId ?? null;
}

export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => (typeof entry === "string" && entry.length > 0 ? [entry] : []));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePatchExportContract(
  patchExport: deps.PatchExport | deps.PatchExportV02,
  bridge: deps.BridgeBundle | deps.BridgeBundleV02,
): void {
  if (patchExport.schemaVersion === deps.BRIDGE_SCHEMA_VERSION_V02) {
    deps.assertPatchExportV02(patchExport);
    if (bridge.schemaVersion !== deps.BRIDGE_SCHEMA_VERSION_V02) {
      throw new Error("PatchExportV02 requires a v0.2 source bridge");
    }
    const report = deps.evaluatePatchExportCompatibilityV02(patchExport, bridge);
    if (report.status !== "compatible") {
      const reasons = report.incompatibleUnits.map((unit) => unit.reason ?? "unknown").join(", ");
      throw new Error(`PatchExportV02 source compatibility failed: ${reasons}`);
    }
    return;
  }
  deps.assertPatchExport(patchExport);
}

export function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => helpers.stableJsonStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${helpers.stableJsonStringify(record[key])}`)
    .join(",")}}`;
}

export function runtimeArtifactDiagnostic(
  uri: string | null,
  hash: string | null,
  metadata: unknown,
): string | null {
  const redactedFields =
    helpers.isRecord(metadata) && Array.isArray(metadata.redactedFields)
      ? helpers.stringArray(metadata.redactedFields)
      : [];
  if (redactedFields.length > 0) {
    return `redacted fields: ${redactedFields.join(", ")}`;
  }
  if (uri === null) {
    return "artifact record has no managed artifact-store URI";
  }
  try {
    helpers.assertPortableRelativeArtifactUri(uri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `blocked unmanaged artifact link: ${message}`;
  }
  if (hash === null) {
    return "managed artifact link missing content hash";
  }
  return null;
}

/**
 * Coerces a raw `metadata->>'hashProvenance'` cell back into the exported
 * discriminator. Rows written before the provenance field existed (legacy
 * v0.1 frame captures, older projections) and redacted/missing cells surface
 * as `null` so the dashboard can render them as unknown rather than mistaking
 * them for content-backed or fallback hashes.
 */
export function runtimeArtifactHashProvenanceFromRow(
  value: unknown,
): api.RuntimeArtifactHashProvenance | null {
  if (typeof value !== "string") {
    return null;
  }
  return api.RUNTIME_ARTIFACT_HASH_PROVENANCES.includes(value as api.RuntimeArtifactHashProvenance)
    ? (value as api.RuntimeArtifactHashProvenance)
    : null;
}
