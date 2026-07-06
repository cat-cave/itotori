// itotori-review-frame-artifact-ingestion — turn Utsushi render-validate JSON
// and FrameArtifact outputs into dashboard-visible CAPTURE ROWS.
//
// A render-validate run emits two portable JSON shapes this boundary accepts:
//
//   1. The `FrameArtifact` announcement (crates/utsushi-core/src/sink/frame.rs,
//      serde `camelCase`): a runtime-announced frame reference whose bytes live
//      behind the managed runtime artifact store. The sink never carries bytes;
//      this struct only carries the portable reference + bridge-unit linkage.
//
//   2. The render-validate CLI report (crates/utsushi-cli/src/render_validate.rs,
//      `schemaVersion: "0.1.0"`): the richer sibling that also carries the
//      scene id, rendered-text sha256, line counts, and the source redaction
//      posture the frame was emitted under.
//
// This module is the DATA/INGESTION LAYER (not the visual UI): it produces a
// deterministic, redaction-capable, project-parameterized `FrameCaptureRow`
// keyed by project + bridge unit, carrying addressable per-scene/line
// ANNOTATION TARGETS a future annotation UI attaches notes to. The row is the
// shape a dashboard projection consumes; it carries no copyrighted bytes and
// no local file paths — only managed runtime URIs (and those only in the raw,
// private-scope variant).
//
// Acceptance crux: a render-validate frame artifact appears as a dashboard
// capture row linked to its draft unit with addressable annotation targets;
// deterministic + redaction-capable; project-parameterized.
//
// Pure + synchronous: no DB, no network, no live game, no wall-clock. Every id
// and every field is derived from the inputs, so two ingests of the same
// (project, frame artifact) tuple produce a byte-identical row.

import { deterministicUuid7, sha256HashString } from "../benchmark-stages/ids.js";

// ---------------------------------------------------------------------------
// Constants (mirror the utsushi-core contracts this boundary ingests)
// ---------------------------------------------------------------------------

/**
 * Managed runtime artifact URI root. A frame artifact's `artifactRef.uri` MUST
 * live under this prefix — mirrors `RUNTIME_ARTIFACT_URI_ROOT` in
 * crates/utsushi-core/src/lib.rs and the review-annotation boundary's
 * `MANAGED_RUNTIME_URI_ROOT`. The capture surface never paints pixels and never
 * references a local file path; it only references the managed runtime store.
 */
export const MANAGED_RUNTIME_ARTIFACT_URI_ROOT = "artifacts/utsushi/runtime/";

/**
 * Frame-artifact kinds the headless runtime sink may announce (mirrors
 * `FRAME_ARTIFACT_KIND_ALLOW_LIST` in crates/utsushi-core/src/sink/frame.rs).
 * Anything outside this list is policy-rejected at ingestion.
 */
export const FRAME_ARTIFACT_KIND_ALLOW_LIST = ["screenshot", "frame_capture", "recording"] as const;
export type FrameArtifactKind = (typeof FRAME_ARTIFACT_KIND_ALLOW_LIST)[number];

/**
 * Evidence tier floor for a frame artifact (the sink rejects `evidence_tier <
 * E2`). Mirrors `EvidenceTier` in crates/utsushi-core/src/lib.rs.
 */
export const FRAME_EVIDENCE_TIER_VALUES = ["E1", "E2", "E3", "E4"] as const;
export type FrameEvidenceTier = (typeof FRAME_EVIDENCE_TIER_VALUES)[number];
export const FRAME_EVIDENCE_TIER_FLOOR: FrameEvidenceTier = "E2";

/** Source frame-artifact shape this boundary ingested a row from. */
export const FRAME_CAPTURE_SOURCE_KINDS = ["frame_artifact", "render_validate_report"] as const;
export type FrameCaptureSourceKind = (typeof FRAME_CAPTURE_SOURCE_KINDS)[number];

export const FRAME_CAPTURE_ROW_SCHEMA_VERSION = "itotori.frame_capture_row.v0.1" as const;

/** The closed taxonomy of addressable annotation anchors a capture row emits. */
export const FRAME_CAPTURE_ANNOTATION_TARGET_KINDS = ["scene", "frame", "line"] as const;
export type FrameCaptureAnnotationTargetKind =
  (typeof FRAME_CAPTURE_ANNOTATION_TARGET_KINDS)[number];

/**
 * Redaction posture the source frame was emitted under (mirrors the
 * `redaction` field of the render-validate CLI report and the utsushi
 * `RedactionPolicy`). `on` = a PUBLIC frame whose copyright-sensitive regions
 * were already masked at render time; `off` = a PRIVATE full-fidelity frame.
 * This is the SOURCE posture — independent of the capture-row redaction that
 * nulls the locator for shared/committed rows.
 */
export const SOURCE_REDACTION_MODES = ["on", "off", "unknown"] as const;
export type SourceRedactionMode = (typeof SOURCE_REDACTION_MODES)[number];

/** Capture-row redaction status (mirrors `ObservationRedactionStatus`). */
export const FRAME_CAPTURE_REDACTION_STATUSES = ["not_required", "redacted"] as const;
export type FrameCaptureRedactionStatus = (typeof FRAME_CAPTURE_REDACTION_STATUSES)[number];

/** Sentinel substituted for a redacted free-text field (non-empty, no bytes). */
export const REDACTED_FRAME_CAPTURE_VALUE = "[redacted]";

const CAPTURE_ROW_ID_NAMESPACE = "itotori.frame-capture-row";
const ANNOTATION_TARGET_ID_NAMESPACE = "itotori.frame-capture-row.annotation-target";
const NONE = "<none>";

// ---------------------------------------------------------------------------
// Input shapes (the JSON this boundary ingests)
// ---------------------------------------------------------------------------

/**
 * The `FrameArtifact` announcement JSON (serde `camelCase`) emitted by the
 * utsushi-core sink. Bytes live behind the artifact store; this struct only
 * carries the portable reference + bridge-unit linkage. Mirrors
 * `FrameArtifact` in crates/utsushi-core/src/sink/frame.rs.
 */
export type FrameArtifactJson = {
  frameId: string;
  evidenceTier: FrameEvidenceTier;
  artifactRef: {
    artifactId: string;
    artifactKind: FrameArtifactKind;
    uri: string;
    mediaType?: string;
  };
  width?: number;
  height?: number;
  frameIndex: number;
  bridgeRef?: {
    bridgeUnitId?: string;
    sourceUnitKey?: string;
    runtimeObjectId?: string;
  };
};

/**
 * The render-validate CLI report JSON (`schemaVersion: "0.1.0"`) emitted by
 * crates/utsushi-cli/src/render_validate.rs. Carries the scene id, rendered-
 * text sha256, line counts, and source redaction posture alongside the same
 * managed runtime artifact reference the `FrameArtifact` carries.
 */
export type RenderValidateReportJson = {
  schemaVersion: "0.1.0";
  engine: string;
  sceneId: string;
  evidenceTier: FrameEvidenceTier;
  artifactKind: FrameArtifactKind;
  artifactId: string;
  artifactUri: string;
  artifactPath?: string;
  privateArtifactPath?: string;
  privateArtifactSha256?: string;
  frameIndex: number;
  width?: number;
  height?: number;
  textlineCount?: number;
  renderedLineCount?: number;
  renderedTextSha256?: string;
  expectTextContains?: string;
  containsExpected?: boolean;
  framesAnnounced?: number;
  hasSpeakerNameBox?: boolean;
  hasSpeakerColor?: boolean;
  graphicsObjectCount?: number;
  compositedBgAsset?: string | null;
  bgSource?: string;
  redaction?: "on" | "off";
};

// ---------------------------------------------------------------------------
// Project context (project-parameterized — no hardcoded game/project/path)
// ---------------------------------------------------------------------------

/**
 * The project + draft-unit scope a frame artifact ingests into. Every capture
 * row is keyed by `projectId` + bridge unit, so the same frame artifact
 * announced for two different projects produces two distinct rows (no global
 * keying). The bridge-unit linkage is resolved bridgeRef-first (the runtime
 * knows which unit it rendered), with an optional caller override to bind a
 * transition frame to a specific draft unit.
 */
export type FrameCaptureProjectContext = {
  projectId: string;
  localeBranchId?: string;
  /**
   * Optional scene id override. For a render-validate report the scene comes
   * from the report itself; for a bare FrameArtifact a caller that knows the
   * project structure may supply it so a `scene` annotation target is emitted.
   */
  sceneId?: string;
  /**
   * Optional bridge-unit linkage override. When present, takes precedence over
   * the frame artifact's own `bridgeRef` (lets a caller bind a transition
   * frame to a draft unit, or correct a runtime that omitted the linkage).
   */
  bridgeUnitRef?: {
    bridgeUnitId: string | null;
    sourceUnitKey: string | null;
  };
};

// ---------------------------------------------------------------------------
// Output: the capture row + annotation targets
// ---------------------------------------------------------------------------

/**
 * A managed runtime artifact reference carried by a capture row. The raw
 * variant keeps the URI (private scope only); the redacted variant nulls the
 * URI so no managed artifact locator leaves private scope. Never a local file
 * path — the capture surface only references the managed runtime store.
 */
export type FrameCaptureArtifactRef = {
  artifactId: string;
  artifactKind: FrameArtifactKind;
  uri: string | null;
  mediaType: string | null;
};

/**
 * One addressable annotation anchor a future annotation UI attaches a note to.
 * Stable in id, kind, and label across ingests of the same input (no wall
 * clock). The `label` is derived from structural coordinates (scene id, frame
 * index, line index) — never from copyrighted source bytes.
 */
export type FrameCaptureAnnotationTarget = {
  targetId: string;
  targetKind: FrameCaptureAnnotationTargetKind;
  sceneId: string | null;
  frameIndex: number | null;
  lineIndex: number | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  label: string;
};

/**
 * A dashboard-visible capture row produced from a render-validate frame
 * artifact. Keyed by project + bridge unit; carries the managed runtime
 * artifact reference (raw in private scope, redacted for shared/committed
 * evidence) and the addressable per-scene/line annotation targets. Fully
 * deterministic: two ingests of the same (project, frame artifact) tuple
 * produce a byte-identical row.
 */
export type FrameCaptureRow = {
  schemaVersion: typeof FRAME_CAPTURE_ROW_SCHEMA_VERSION;
  captureRowId: string;
  projectId: string;
  localeBranchId: string | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  sceneId: string | null;
  frameIndex: number;
  evidenceTier: FrameEvidenceTier;
  sourceArtifactKind: FrameCaptureSourceKind;
  sourceRedactionMode: SourceRedactionMode;
  artifactRef: FrameCaptureArtifactRef;
  /** `sha256:<hex>` over the canonical (project, artifact) seed, or null in
   * the redacted variant — the content id of the captured frame. */
  artifactHash: string | null;
  width: number | null;
  height: number | null;
  /** Per-scene/line anchors a future annotation UI attaches notes to. Stable
   * in count and order across ingests of the same input. */
  annotationTargets: FrameCaptureAnnotationTarget[];
  redactionStatus: FrameCaptureRedactionStatus;
  redactionRules: string[];
  redactedFields: string[];
};

export type FrameCaptureIngestResult = {
  row: FrameCaptureRow;
};

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

export class FrameCaptureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameCaptureValidationError";
  }
}

export const FRAME_CAPTURE_INGEST_REJECTION_CODES = [
  "evidence_tier_below_floor",
  "artifact_kind_not_allowed",
  "unmanaged_artifact_uri",
  "traversal_artifact_uri",
  "missing_project_id",
  "negative_frame_index",
] as const;
export type FrameCaptureIngestRejectionCode = (typeof FRAME_CAPTURE_INGEST_REJECTION_CODES)[number];

export class FrameCaptureIngestError extends Error {
  readonly code: FrameCaptureIngestRejectionCode;
  constructor(code: FrameCaptureIngestRejectionCode, message: string) {
    super(message);
    this.name = "FrameCaptureIngestError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small validation helpers (mirrors review-annotation-import.ts style)
// ---------------------------------------------------------------------------

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FrameCaptureValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (!nonEmptyString(value)) {
    throw new FrameCaptureValidationError(`${label} must be a non-empty string`);
  }
}

function assertOptionalString(value: unknown, label: string): asserts value is string | undefined {
  if (value !== undefined && !(typeof value === "string" && value.length > 0)) {
    throw new FrameCaptureValidationError(`${label} must be a non-empty string when present`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new FrameCaptureValidationError(`${label} must be a non-negative integer`);
  }
}

function assertOptionalNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number | undefined {
  if (value !== undefined) {
    assertNonNegativeInteger(value, label);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new FrameCaptureValidationError(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

function assertOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T | undefined {
  if (value !== undefined) {
    assertEnum(value, allowed, label);
  }
}

function asOptionalNonEmptyString(value: unknown): string | null {
  return nonEmptyString(value) ? value : null;
}

/**
 * Strict schema assertion for the `FrameArtifact` announcement JSON. Mirrors
 * the per-payload validation the utsushi-core sink enforces (evidence floor,
 * artifact-kind allow-list, managed URI root) at the type level; the policy
 * floor is re-enforced by {@link ingestFrameArtifact}.
 */
export function assertFrameArtifactJson(value: unknown): asserts value is FrameArtifactJson {
  const record = asRecord(value, "FrameArtifact");
  assertNonEmptyString(record.frameId, "FrameArtifact.frameId");
  assertEnum(record.evidenceTier, FRAME_EVIDENCE_TIER_VALUES, "FrameArtifact.evidenceTier");
  assertNonNegativeInteger(record.frameIndex, "FrameArtifact.frameIndex");

  const artifactRef = asRecord(record.artifactRef, "FrameArtifact.artifactRef");
  assertNonEmptyString(artifactRef.artifactId, "FrameArtifact.artifactRef.artifactId");
  assertEnum(
    artifactRef.artifactKind,
    FRAME_ARTIFACT_KIND_ALLOW_LIST,
    "FrameArtifact.artifactRef.artifactKind",
  );
  assertNonEmptyString(artifactRef.uri, "FrameArtifact.artifactRef.uri");
  assertOptionalString(artifactRef.mediaType, "FrameArtifact.artifactRef.mediaType");

  assertOptionalNonNegativeInteger(record.width, "FrameArtifact.width");
  assertOptionalNonNegativeInteger(record.height, "FrameArtifact.height");

  if (record.bridgeRef !== undefined) {
    const bridgeRef = asRecord(record.bridgeRef, "FrameArtifact.bridgeRef");
    assertOptionalString(bridgeRef.bridgeUnitId, "FrameArtifact.bridgeRef.bridgeUnitId");
    assertOptionalString(bridgeRef.sourceUnitKey, "FrameArtifact.bridgeRef.sourceUnitKey");
    assertOptionalString(bridgeRef.runtimeObjectId, "FrameArtifact.bridgeRef.runtimeObjectId");
  }
}

/** Parse-and-return a validated, normalized `FrameArtifactJson`. */
export function parseFrameArtifactJson(value: unknown): FrameArtifactJson {
  assertFrameArtifactJson(value);
  return value;
}

/**
 * Strict schema assertion for the render-validate CLI report JSON
 * (`schemaVersion: "0.1.0"`). Strict about the fields the capture row derives
 * from (scene id, artifact ref, frame index, evidence tier, line counts,
 * source redaction posture); tolerant of the richer diagnostic fields the
 * report also carries.
 */
export function assertRenderValidateReportJson(
  value: unknown,
): asserts value is RenderValidateReportJson {
  const record = asRecord(value, "RenderValidateReport");
  if (record.schemaVersion !== "0.1.0") {
    throw new FrameCaptureValidationError(`RenderValidateReport.schemaVersion must be "0.1.0"`);
  }
  assertNonEmptyString(record.engine, "RenderValidateReport.engine");
  assertNonEmptyString(record.sceneId, "RenderValidateReport.sceneId");
  assertEnum(record.evidenceTier, FRAME_EVIDENCE_TIER_VALUES, "RenderValidateReport.evidenceTier");
  assertEnum(
    record.artifactKind,
    FRAME_ARTIFACT_KIND_ALLOW_LIST,
    "RenderValidateReport.artifactKind",
  );
  assertNonEmptyString(record.artifactId, "RenderValidateReport.artifactId");
  assertNonEmptyString(record.artifactUri, "RenderValidateReport.artifactUri");
  assertNonNegativeInteger(record.frameIndex, "RenderValidateReport.frameIndex");

  assertOptionalString(record.artifactPath, "RenderValidateReport.artifactPath");
  assertOptionalString(record.privateArtifactPath, "RenderValidateReport.privateArtifactPath");
  assertOptionalString(record.privateArtifactSha256, "RenderValidateReport.privateArtifactSha256");
  assertOptionalNonNegativeInteger(record.width, "RenderValidateReport.width");
  assertOptionalNonNegativeInteger(record.height, "RenderValidateReport.height");
  assertOptionalNonNegativeInteger(record.textlineCount, "RenderValidateReport.textlineCount");
  assertOptionalNonNegativeInteger(
    record.renderedLineCount,
    "RenderValidateReport.renderedLineCount",
  );
  assertOptionalString(record.renderedTextSha256, "RenderValidateReport.renderedTextSha256");
  assertOptionalString(record.expectTextContains, "RenderValidateReport.expectTextContains");
  assertOptionalNonNegativeInteger(record.framesAnnounced, "RenderValidateReport.framesAnnounced");
  assertOptionalEnum(record.redaction, ["on", "off"], "RenderValidateReport.redaction");
}

/** Parse-and-return a validated, normalized `RenderValidateReportJson`. */
export function parseRenderValidateReportJson(value: unknown): RenderValidateReportJson {
  assertRenderValidateReportJson(value);
  return value;
}

// ---------------------------------------------------------------------------
// Internal helpers (deterministic id derivation + canonical seeds)
// ---------------------------------------------------------------------------

function normalizeOptional(value: string | null | undefined): string {
  return nonEmptyString(value) ? value : NONE;
}

function resolveBridgeUnitId(
  artifact: { bridgeRef?: { bridgeUnitId?: string } } | undefined,
  context: FrameCaptureProjectContext,
): string | null {
  const override = context.bridgeUnitRef?.bridgeUnitId ?? null;
  if (override !== null) {
    return override;
  }
  return asOptionalNonEmptyString(artifact?.bridgeRef?.bridgeUnitId);
}

function resolveSourceUnitKey(
  artifact: { bridgeRef?: { sourceUnitKey?: string } } | undefined,
  context: FrameCaptureProjectContext,
): string | null {
  const override = context.bridgeUnitRef?.sourceUnitKey ?? null;
  if (override !== null) {
    return override;
  }
  return asOptionalNonEmptyString(artifact?.bridgeRef?.sourceUnitKey);
}

/**
 * The canonical seed for a capture row id. Fixed field order → stable
 * serialization independent of input key order. Every field that distinguishes
 * one capture row from another participates, so two ingests of the same
 * (project, artifact) tuple produce the same id and two ingests that differ on
 * any keying field produce different ids.
 */
function captureRowSeed(params: {
  projectId: string;
  localeBranchId: string | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  sceneId: string | null;
  artifactId: string;
  artifactKind: FrameArtifactKind;
  frameIndex: number;
}): string {
  return JSON.stringify([
    params.projectId,
    normalizeOptional(params.localeBranchId),
    normalizeOptional(params.bridgeUnitId),
    normalizeOptional(params.sourceUnitKey),
    normalizeOptional(params.sceneId),
    params.artifactId,
    params.artifactKind,
    params.frameIndex,
  ]);
}

function deriveCaptureRowId(seed: string): string {
  return deterministicUuid7(CAPTURE_ROW_ID_NAMESPACE, seed);
}

function deriveAnnotationTargetId(...parts: string[]): string {
  return deterministicUuid7(ANNOTATION_TARGET_ID_NAMESPACE, ...parts);
}

/**
 * Build the deterministic, ordered annotation targets for a capture row.
 *
 *   - `scene` — emitted when a scene id is known (render-validate report, or a
 *     caller-supplied override). Anchors the whole scene the frame belongs to.
 *   - `frame` — always emitted. Anchors the specific monotonic runtime frame.
 *   - `line` — one per rendered line index in `[0, lineCount)`, when a line
 *     count is derivable (render-validate report). Anchors a single text line
 *     within the frame so a future annotation UI can attach a note to a
 *     specific point.
 *
 * Order is always `[scene?, frame, line...]` so target ordering is stable
 * across ingests.
 */
function buildAnnotationTargets(params: {
  captureRowId: string;
  sceneId: string | null;
  frameIndex: number;
  lineCount: number | null;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
}): FrameCaptureAnnotationTarget[] {
  const targets: FrameCaptureAnnotationTarget[] = [];

  if (params.sceneId !== null) {
    const targetId = deriveAnnotationTargetId(params.captureRowId, "scene", params.sceneId);
    targets.push({
      targetId,
      targetKind: "scene",
      sceneId: params.sceneId,
      frameIndex: null,
      lineIndex: null,
      bridgeUnitId: params.bridgeUnitId,
      sourceUnitKey: params.sourceUnitKey,
      label: `scene:${params.sceneId}`,
    });
  }

  const frameTargetId = deriveAnnotationTargetId(
    params.captureRowId,
    "frame",
    String(params.frameIndex),
  );
  targets.push({
    targetId: frameTargetId,
    targetKind: "frame",
    sceneId: params.sceneId,
    frameIndex: params.frameIndex,
    lineIndex: null,
    bridgeUnitId: params.bridgeUnitId,
    sourceUnitKey: params.sourceUnitKey,
    label:
      params.sceneId === null
        ? `frame:${params.frameIndex}`
        : `scene:${params.sceneId}/frame:${params.frameIndex}`,
  });

  if (params.lineCount !== null && params.lineCount > 0) {
    for (let lineIndex = 0; lineIndex < params.lineCount; lineIndex += 1) {
      const targetId = deriveAnnotationTargetId(
        params.captureRowId,
        "line",
        String(params.frameIndex),
        String(lineIndex),
      );
      targets.push({
        targetId,
        targetKind: "line",
        sceneId: params.sceneId,
        frameIndex: params.frameIndex,
        lineIndex,
        bridgeUnitId: params.bridgeUnitId,
        sourceUnitKey: params.sourceUnitKey,
        label:
          params.sceneId === null
            ? `frame:${params.frameIndex}/line:${lineIndex}`
            : `scene:${params.sceneId}/frame:${params.frameIndex}/line:${lineIndex}`,
      });
    }
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Policy enforcement (the ingest boundary)
// ---------------------------------------------------------------------------

function enforcePolicy(params: {
  evidenceTier: FrameEvidenceTier;
  artifactKind: FrameArtifactKind;
  artifactUri: string;
  projectId: string;
  frameIndex: number;
}): void {
  if (!nonEmptyString(params.projectId)) {
    throw new FrameCaptureIngestError(
      "missing_project_id",
      "FrameCaptureProjectContext.projectId must be a non-empty string",
    );
  }
  if (params.frameIndex < 0) {
    throw new FrameCaptureIngestError(
      "negative_frame_index",
      `frameIndex must be non-negative but was ${params.frameIndex}`,
    );
  }
  const tierRank = FRAME_EVIDENCE_TIER_VALUES.indexOf(params.evidenceTier);
  const floorRank = FRAME_EVIDENCE_TIER_VALUES.indexOf(FRAME_EVIDENCE_TIER_FLOOR);
  if (tierRank < floorRank) {
    throw new FrameCaptureIngestError(
      "evidence_tier_below_floor",
      `FrameArtifact.evidenceTier ${params.evidenceTier} is below the per-sink floor ${FRAME_EVIDENCE_TIER_FLOOR}`,
    );
  }
  if (!FRAME_ARTIFACT_KIND_ALLOW_LIST.includes(params.artifactKind)) {
    throw new FrameCaptureIngestError(
      "artifact_kind_not_allowed",
      `artifactKind ${params.artifactKind} is not in the headless-runtime allow-list: ${FRAME_ARTIFACT_KIND_ALLOW_LIST.join(", ")}`,
    );
  }
  validateManagedRuntimeArtifactUri(params.artifactUri);
}

/**
 * Validate a managed runtime-artifact URI against the SAME accept/reject
 * boundary as the authoritative Rust validator `validate_runtime_artifact_uri`
 * (crates/utsushi-core/src/lib.rs:649). The Rust validator enforces, and this
 * TS port matches, each of these rules:
 *
 *   1. Managed root: the URI must live under
 *      `artifacts/utsushi/runtime/` (Rust strips `{RUNTIME_ARTIFACT_URI_ROOT}/`
 *      or errors). This single prefix check also subsumes Rust's earlier
 *      rejections of absolute paths (`starts_with('/')`), `data:`/`blob:`/
 *      `file:` URIs, and any other URI scheme (`has_uri_scheme`): none of those
 *      shapes can start with the root prefix, so a URI that passes the prefix
 *      check can never be absolute or scheme-bearing.
 *   2. No backslash: Rust rejects `uri.contains('\\')`. Checked here, because a
 *      backslash CAN appear inside an otherwise root-prefixed URI.
 *   3. No traversal / empty segment: Rust splits the relative remainder on '/'
 *      and rejects any segment that is empty, `.`, or `..`. This is the
 *      traversal defense — a `../` (or leading `/`, `//`, `./`) segment that
 *      would escape the managed store is rejected here. (Rust additionally
 *      walks `Path::components()` requiring every one to be `Component::Normal`;
 *      on a POSIX relative path with no empty/`.`/`..` segment and no backslash,
 *      every component is already Normal, so that walk is subsumed.)
 *   4. Minimum depth: Rust requires `>= 3` path components below the root
 *      (run / kind / filename). After the empty-segment check, the split count
 *      equals Rust's component count, so we require `>= 3` segments.
 *
 * Enforcing this BEFORE `artifactRef.uri` is stored on the capture row closes a
 * path-traversal privacy gap: the redaction boundary assumes every stored URI
 * points inside the managed runtime store, so a `../`-shaped URI must never be
 * persisted. This is the single reusable authority for managed artifact URIs.
 */
export function validateManagedRuntimeArtifactUri(uri: string): void {
  // Rule 1: managed root (subsumes absolute / data: / blob: / file: / scheme).
  if (!uri.startsWith(MANAGED_RUNTIME_ARTIFACT_URI_ROOT)) {
    throw new FrameCaptureIngestError(
      "unmanaged_artifact_uri",
      `artifact uri ${uri} is not under the managed runtime root ${MANAGED_RUNTIME_ARTIFACT_URI_ROOT}`,
    );
  }
  // Rule 2: no backslash (portable, non-Windows-path).
  if (uri.includes("\\")) {
    throw new FrameCaptureIngestError(
      "traversal_artifact_uri",
      `artifact uri ${uri} must be a portable managed uri and must not contain a backslash`,
    );
  }
  // Rule 3: no traversal / empty path segment in the remainder below the root.
  const relative = uri.slice(MANAGED_RUNTIME_ARTIFACT_URI_ROOT.length);
  const segments = relative.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new FrameCaptureIngestError(
        "traversal_artifact_uri",
        `artifact uri ${uri} must not contain a traversal or empty path segment`,
      );
    }
  }
  // Rule 4: at least run / kind / filename below the managed root.
  if (segments.length < 3) {
    throw new FrameCaptureIngestError(
      "traversal_artifact_uri",
      `artifact uri ${uri} is missing a run, kind, or filename segment below the managed runtime root`,
    );
  }
}

// ---------------------------------------------------------------------------
// Ingestion: FrameArtifact -> capture row
// ---------------------------------------------------------------------------

/**
 * Ingest a `FrameArtifact` announcement JSON into a dashboard-visible capture
 * row keyed by project + bridge unit, with addressable annotation targets.
 *
 * Deterministic: the same `(project, frameArtifact)` tuple always produces a
 * byte-identical row (stable id, stable target count/order, no wall-clock).
 * Project-parameterized: the row is keyed by `projectId` + bridge unit, so the
 * same frame announced for two projects produces two distinct rows. Raw in
 * private scope — pass the result through {@link redactFrameCaptureRow} for
 * the shared/committed variant.
 */
export function ingestFrameArtifact(
  frameArtifact: FrameArtifactJson,
  context: FrameCaptureProjectContext,
): FrameCaptureIngestResult {
  assertFrameArtifactJson(frameArtifact);
  return ingestFrameArtifactParsed(parseFrameArtifactJson(frameArtifact), context);
}

/** Ingest an already-parsed `FrameArtifactJson` (skips re-validation). */
export function ingestFrameArtifactParsed(
  frameArtifact: FrameArtifactJson,
  context: FrameCaptureProjectContext,
): FrameCaptureIngestResult {
  enforcePolicy({
    evidenceTier: frameArtifact.evidenceTier,
    artifactKind: frameArtifact.artifactRef.artifactKind,
    artifactUri: frameArtifact.artifactRef.uri,
    projectId: context.projectId,
    frameIndex: frameArtifact.frameIndex,
  });

  const bridgeUnitId = resolveBridgeUnitId(frameArtifact, context);
  const sourceUnitKey = resolveSourceUnitKey(frameArtifact, context);
  const sceneId = asOptionalNonEmptyString(context.sceneId);

  const seed = captureRowSeed({
    projectId: context.projectId,
    localeBranchId: asOptionalNonEmptyString(context.localeBranchId),
    bridgeUnitId,
    sourceUnitKey,
    sceneId,
    artifactId: frameArtifact.artifactRef.artifactId,
    artifactKind: frameArtifact.artifactRef.artifactKind,
    frameIndex: frameArtifact.frameIndex,
  });
  const captureRowId = deriveCaptureRowId(seed);
  const artifactHash = sha256HashString(seed);

  const annotationTargets = buildAnnotationTargets({
    captureRowId,
    sceneId,
    frameIndex: frameArtifact.frameIndex,
    lineCount: null,
    bridgeUnitId,
    sourceUnitKey,
  });

  const row: FrameCaptureRow = {
    schemaVersion: FRAME_CAPTURE_ROW_SCHEMA_VERSION,
    captureRowId,
    projectId: context.projectId,
    localeBranchId: asOptionalNonEmptyString(context.localeBranchId),
    bridgeUnitId,
    sourceUnitKey,
    sceneId,
    frameIndex: frameArtifact.frameIndex,
    evidenceTier: frameArtifact.evidenceTier,
    sourceArtifactKind: "frame_artifact",
    sourceRedactionMode: "unknown",
    artifactRef: {
      artifactId: frameArtifact.artifactRef.artifactId,
      artifactKind: frameArtifact.artifactRef.artifactKind,
      uri: frameArtifact.artifactRef.uri,
      mediaType: asOptionalNonEmptyString(frameArtifact.artifactRef.mediaType),
    },
    artifactHash,
    width: frameArtifact.width ?? null,
    height: frameArtifact.height ?? null,
    annotationTargets,
    redactionStatus: "not_required",
    redactionRules: [],
    redactedFields: [],
  };
  return { row };
}

// ---------------------------------------------------------------------------
// Ingestion: render-validate report -> capture row
// ---------------------------------------------------------------------------

/**
 * Ingest a render-validate CLI report JSON (`schemaVersion: "0.1.0"`) into a
 * dashboard-visible capture row. The report carries the scene id + line counts
 * the bare `FrameArtifact` omits, so the resulting row emits a `scene`
 * annotation target and one `line` target per rendered line (a future
 * annotation UI attaches notes to a specific scene/frame/line point).
 *
 * Deterministic + project-parameterized exactly like
 * {@link ingestFrameArtifact}; raw in private scope (redact for shared use).
 */
export function ingestRenderValidateReport(
  report: RenderValidateReportJson,
  context: FrameCaptureProjectContext,
): FrameCaptureIngestResult {
  assertRenderValidateReportJson(report);
  return ingestRenderValidateReportParsed(report, context);
}

/** Ingest an already-parsed render-validate report (skips re-validation). */
export function ingestRenderValidateReportParsed(
  report: RenderValidateReportJson,
  context: FrameCaptureProjectContext,
): FrameCaptureIngestResult {
  enforcePolicy({
    evidenceTier: report.evidenceTier,
    artifactKind: report.artifactKind,
    artifactUri: report.artifactUri,
    projectId: context.projectId,
    frameIndex: report.frameIndex,
  });

  const bridgeUnitId = context.bridgeUnitRef?.bridgeUnitId ?? null;
  const sourceUnitKey = context.bridgeUnitRef?.sourceUnitKey ?? null;
  const sceneId =
    asOptionalNonEmptyString(report.sceneId) ?? asOptionalNonEmptyString(context.sceneId);
  const lineCount = resolveLineCount(report);
  const sourceRedactionMode: SourceRedactionMode =
    report.redaction === "on" ? "on" : report.redaction === "off" ? "off" : "unknown";

  const seed = captureRowSeed({
    projectId: context.projectId,
    localeBranchId: asOptionalNonEmptyString(context.localeBranchId),
    bridgeUnitId,
    sourceUnitKey,
    sceneId,
    artifactId: report.artifactId,
    artifactKind: report.artifactKind,
    frameIndex: report.frameIndex,
  });
  const captureRowId = deriveCaptureRowId(seed);
  const artifactHash = sha256HashString(seed);

  const annotationTargets = buildAnnotationTargets({
    captureRowId,
    sceneId,
    frameIndex: report.frameIndex,
    lineCount,
    bridgeUnitId,
    sourceUnitKey,
  });

  const row: FrameCaptureRow = {
    schemaVersion: FRAME_CAPTURE_ROW_SCHEMA_VERSION,
    captureRowId,
    projectId: context.projectId,
    localeBranchId: asOptionalNonEmptyString(context.localeBranchId),
    bridgeUnitId,
    sourceUnitKey,
    sceneId,
    frameIndex: report.frameIndex,
    evidenceTier: report.evidenceTier,
    sourceArtifactKind: "render_validate_report",
    sourceRedactionMode,
    artifactRef: {
      artifactId: report.artifactId,
      artifactKind: report.artifactKind,
      uri: report.artifactUri,
      mediaType: null,
    },
    artifactHash,
    width: report.width ?? null,
    height: report.height ?? null,
    annotationTargets,
    redactionStatus: "not_required",
    redactionRules: [],
    redactedFields: [],
  };
  return { row };
}

/**
 * The rendered-line count the capture row anchors. Prefers the more specific
 * `renderedLineCount` (the count of lines actually composited into the frame)
 * and falls back to `textlineCount` (the play-order message count) when the
 * render count is absent. Null when neither is present.
 */
function resolveLineCount(report: RenderValidateReportJson): number | null {
  if (typeof report.renderedLineCount === "number") {
    return report.renderedLineCount;
  }
  if (typeof report.textlineCount === "number") {
    return report.textlineCount;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Redaction (raw only in private scope; redacted variant for shared evidence)
// ---------------------------------------------------------------------------

export const FRAME_CAPTURE_REDACTION_RULES = [
  "managed_runtime_uri",
  "artifact_content_hash",
] as const;

/** The fields {@link redactFrameCaptureRow} nulls/redacts. */
export const FRAME_CAPTURE_REDACTED_FIELDS = ["artifactRef.uri", "artifactHash"] as const;

/**
 * Produce the redacted variant of a capture row for shared/committed evidence.
 * The raw variant (with its managed runtime URI + content hash) is private-
 * scope only — a committed/shared row never leaks the artifact locator or the
 * content id. The annotation targets survive (they carry only structural
 * coordinates + labels derived from ids/indices, never copyrighted bytes), so
 * a future annotation UI still has its addressable anchors on the shared row.
 */
export function redactFrameCaptureRow(row: FrameCaptureRow): FrameCaptureRow {
  return {
    ...row,
    artifactRef: {
      ...row.artifactRef,
      uri: null,
    },
    artifactHash: null,
    redactionStatus: "redacted",
    redactionRules: [...FRAME_CAPTURE_REDACTION_RULES],
    redactedFields: [...FRAME_CAPTURE_REDACTED_FIELDS],
  };
}

/**
 * Reject a leakage-shaped redacted capture row. On top of the structural
 * `assertFrameCaptureRow` check it requires that the managed runtime URI and
 * the content hash are redacted (null). Emitting a shared/committed row that
 * still carries either throws here, so a locator cannot leave private scope
 * under the redacted posture.
 */
export function assertRedactedFrameCaptureRow(
  value: unknown,
  label = "RedactedFrameCaptureRow",
): asserts value is FrameCaptureRow {
  assertFrameCaptureRow(value, label);
  const row = value as FrameCaptureRow;
  if (row.artifactRef.uri !== null) {
    throw new Error(
      `${label}.artifactRef.uri must be redacted (null) but leaked a managed runtime URI`,
    );
  }
  if (row.artifactHash !== null) {
    throw new Error(`${label}.artifactHash must be redacted (null) but leaked a content hash`);
  }
  if (row.redactionStatus !== "redacted") {
    throw new Error(`${label}.redactionStatus must be "redacted" but was ${row.redactionStatus}`);
  }
}

// ---------------------------------------------------------------------------
// Structural assertion + try variants
// ---------------------------------------------------------------------------

/**
 * Strict structural assertion for a capture row. Validates the schema version,
 * the keyed-by-project shape, the artifact ref, the evidence tier, the
 * annotation target taxonomy, and the redaction posture invariants.
 */
export function assertFrameCaptureRow(
  value: unknown,
  label = "FrameCaptureRow",
): asserts value is FrameCaptureRow {
  const record = asRecord(value, label);
  if (record.schemaVersion !== FRAME_CAPTURE_ROW_SCHEMA_VERSION) {
    throw new FrameCaptureValidationError(
      `${label}.schemaVersion must be ${FRAME_CAPTURE_ROW_SCHEMA_VERSION}`,
    );
  }
  assertNonEmptyString(record.captureRowId, `${label}.captureRowId`);
  assertNonEmptyString(record.projectId, `${label}.projectId`);
  assertEnum(record.evidenceTier, FRAME_EVIDENCE_TIER_VALUES, `${label}.evidenceTier`);
  assertEnum(record.sourceArtifactKind, FRAME_CAPTURE_SOURCE_KINDS, `${label}.sourceArtifactKind`);
  assertEnum(record.sourceRedactionMode, SOURCE_REDACTION_MODES, `${label}.sourceRedactionMode`);
  assertEnum(record.redactionStatus, FRAME_CAPTURE_REDACTION_STATUSES, `${label}.redactionStatus`);
  assertNonNegativeInteger(record.frameIndex, `${label}.frameIndex`);

  const artifactRef = asRecord(record.artifactRef, `${label}.artifactRef`);
  assertNonEmptyString(artifactRef.artifactId, `${label}.artifactRef.artifactId`);
  assertEnum(
    artifactRef.artifactKind,
    FRAME_ARTIFACT_KIND_ALLOW_LIST,
    `${label}.artifactRef.artifactKind`,
  );
  if (artifactRef.uri !== null && !nonEmptyString(artifactRef.uri)) {
    throw new FrameCaptureValidationError(`${label}.artifactRef.uri must be a string or null`);
  }

  if (!Array.isArray(record.annotationTargets)) {
    throw new FrameCaptureValidationError(`${label}.annotationTargets must be an array`);
  }
  for (const [index, targetValue] of record.annotationTargets.entries()) {
    const target = asRecord(targetValue, `${label}.annotationTargets[${index}]`);
    assertNonEmptyString(target.targetId, `${label}.annotationTargets[${index}].targetId`);
    assertEnum(
      target.targetKind,
      FRAME_CAPTURE_ANNOTATION_TARGET_KINDS,
      `${label}.annotationTargets[${index}].targetKind`,
    );
    assertNonEmptyString(target.label, `${label}.annotationTargets[${index}].label`);
  }
}

/**
 * Non-throwing ingest wrapper. Returns `[row, null]` on success and
 * `[null, error]` on a validation or policy rejection. Mirrors the
 * try-return boundary the render gate / annotation import expose.
 */
export async function tryIngestFrameArtifact(
  frameArtifact: unknown,
  context: FrameCaptureProjectContext,
): Promise<
  readonly [FrameCaptureRow | null, FrameCaptureValidationError | FrameCaptureIngestError | null]
> {
  try {
    const result = ingestFrameArtifact(frameArtifact as FrameArtifactJson, context);
    return [result.row, null] as const;
  } catch (error) {
    if (error instanceof FrameCaptureValidationError || error instanceof FrameCaptureIngestError) {
      return [null, error] as const;
    }
    throw error;
  }
}

/** Non-throwing render-validate-report ingest wrapper. */
export async function tryIngestRenderValidateReport(
  report: unknown,
  context: FrameCaptureProjectContext,
): Promise<
  readonly [FrameCaptureRow | null, FrameCaptureValidationError | FrameCaptureIngestError | null]
> {
  try {
    const result = ingestRenderValidateReport(report as RenderValidateReportJson, context);
    return [result.row, null] as const;
  } catch (error) {
    if (error instanceof FrameCaptureValidationError || error instanceof FrameCaptureIngestError) {
      return [null, error] as const;
    }
    throw error;
  }
}
