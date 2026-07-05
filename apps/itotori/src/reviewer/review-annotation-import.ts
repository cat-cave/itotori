// UTSUSHI-066 — Import MV/MZ review-package annotations into Itotori as
// deterministic finding records.
//
// A human reviews the MV/MZ REVIEW PACKAGE / demo bundle (UTSUSHI-134 bundle =
// UTSUSHI-010 review manifest + UTSUSHI-006 patched trace + UTSUSHI-065
// screenshot evidence) and annotates it. Each annotation references KNOWN
// coordinates already carried by that package:
//
//   - `manifestId`            the review package it belongs to
//                             (`reviewManifest.reviewPackageId`);
//   - `bridgeUnitRef`         a bridge unit surfaced by the observation
//                             envelope / captures (bridge id + source key);
//   - `traceId`               a trace event id evidenced by the package
//                             (`captureRefs[].evidencesTraceEventId`);
//   - `screenshotArtifactRef` a managed runtime screenshot artifact
//                             (`captureRefs[].artifactRef`);
//   - `reviewerNote`          the free-text annotation;
//   - `severity`             the Itotori finding severity taxonomy;
//   - `redactionStatus`       whether the note is safe to surface verbatim.
//
// Importing is the FEEDBACK BOUNDARY: it accepts an annotation ONLY when its
// bridge unit + trace id (+ screenshot artifact) are KNOWN to the review
// package, then derives a DETERMINISTIC Itotori finding record from the
// annotation content. The same annotation always imports to the same finding
// record (stable id + shape). An annotation that references an unknown bridge
// unit / trace id / screenshot artifact is REJECTED — the boundary never
// silently creates a dangling finding.
//
// Pure + synchronous: no DB, no network, no live game. The deterministic
// finding it produces can be handed to the triage router
// (`reviewAnnotationFindingToHumanFinding`) or persisted downstream.

import {
  HUMAN_FINDING_SEVERITIES,
  type HumanFinding,
  type HumanFindingSeverity,
} from "../triage/human-finding.js";
import { deterministicUuid7, sha256HashString } from "../benchmark-stages/ids.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redaction posture a reviewer stamps on their annotation note. */
export const REVIEW_ANNOTATION_REDACTION_STATUSES = ["unredacted", "redacted"] as const;
export type ReviewAnnotationRedactionStatus = (typeof REVIEW_ANNOTATION_REDACTION_STATUSES)[number];

/**
 * Managed runtime artifact URI root. A screenshot artifactRef MUST live under
 * this prefix — the review surface never paints pixels, it only references the
 * managed runtime artifact (mirrors the demo-bundle capture posture).
 */
export const MANAGED_RUNTIME_URI_ROOT = "artifacts/utsushi/runtime/";

/** Every imported review annotation is attributed to the reviewer surface. */
export const REVIEW_ANNOTATION_ATTRIBUTION = "reviewer" as const;

/** Closed category for review-annotation findings (the triage router branches
 * on `attribution`, not `category`, but the category is surfaced verbatim). */
export const REVIEW_ANNOTATION_FINDING_CATEGORY = "review_annotation" as const;

const FINDING_ID_NAMESPACE = "utsushi-review-annotation-finding";

// ---------------------------------------------------------------------------
// Annotation schema (the 7 carried fields)
// ---------------------------------------------------------------------------

export type ReviewAnnotationBridgeUnitRef = {
  bridgeUnitId: string;
  sourceUnitKey: string;
};

export type ReviewAnnotationScreenshotArtifactRef = {
  artifactId: string;
  uri: string;
};

/**
 * A single review-package annotation. All seven fields are REQUIRED — an
 * annotation with a partial reference cannot be validated as KNOWN and so
 * cannot deterministically anchor a finding.
 */
export type ReviewAnnotation = {
  manifestId: string;
  bridgeUnitRef: ReviewAnnotationBridgeUnitRef;
  traceId: string;
  screenshotArtifactRef: ReviewAnnotationScreenshotArtifactRef;
  reviewerNote: string;
  severity: HumanFindingSeverity;
  redactionStatus: ReviewAnnotationRedactionStatus;
};

// ---------------------------------------------------------------------------
// Deterministic finding record (the Itotori finding the boundary emits)
// ---------------------------------------------------------------------------

/**
 * Provenance carried onto the finding so a reviewer/consumer can trace it back
 * to the exact review-package coordinates it was imported from.
 */
export type ReviewAnnotationFindingProvenance = {
  source: "utsushi_review_annotation";
  manifestId: string;
  bridgeUnitRef: ReviewAnnotationBridgeUnitRef;
  traceId: string;
  screenshotArtifactRef: ReviewAnnotationScreenshotArtifactRef;
  redactionStatus: ReviewAnnotationRedactionStatus;
  /** `sha256:<hex>` over the canonical annotation — the finding's content id. */
  annotationHash: string;
};

/**
 * Deterministic Itotori finding record. Intentionally carries NO wall-clock
 * field: every field is derived from the annotation content, so the same
 * annotation always imports to the same record (byte-identical). Its core is
 * `HumanFinding`-compatible (attribution/severity/category/summary/bridgeUnitId)
 * so it feeds the triage router via `reviewAnnotationFindingToHumanFinding`.
 */
export type ReviewAnnotationFinding = {
  findingId: string;
  attribution: typeof REVIEW_ANNOTATION_ATTRIBUTION;
  severity: HumanFindingSeverity;
  category: typeof REVIEW_ANNOTATION_FINDING_CATEGORY;
  bridgeUnitId: string;
  summary: string;
  provenance: ReviewAnnotationFindingProvenance;
};

export type ReviewAnnotationImportResult = {
  finding: ReviewAnnotationFinding;
};

// ---------------------------------------------------------------------------
// KNOWN-reference index (built from the review package)
// ---------------------------------------------------------------------------

type MaybeBridgeUnitRef = {
  bridgeUnitId?: string | null;
  sourceUnitKey?: string | null;
};

/**
 * Structural subset of the MV/MZ review package (UTSUSHI-134 demo bundle /
 * UTSUSHI-010 manifest) needed to enumerate its KNOWN references. Accepts the
 * committed bundle shape as-is.
 */
export type ReviewPackageReferenceSource = {
  reviewManifest: { reviewPackageId: string | null };
  observationEnvelope: {
    runtimeReportId?: string | null;
    events: ReadonlyArray<{
      bridgeUnitRef: MaybeBridgeUnitRef;
      options?: ReadonlyArray<{ bridgeUnitRef: MaybeBridgeUnitRef }>;
    }>;
  };
  captureRefs: {
    refs: ReadonlyArray<{
      bridgeUnitRef: MaybeBridgeUnitRef;
      evidencesTraceEventId?: string | null;
      artifactRef: { artifactId: string };
    }>;
  };
};

/**
 * The set of references a review package KNOWS about. An annotation may only
 * import against the package it belongs to (`manifestId`) and may only
 * reference bridge units / trace events / screenshots enumerated here.
 */
export type ReviewImportReferenceIndex = {
  manifestId: string;
  runtimeReportId: string | null;
  /** bridgeUnitId -> its canonical sourceUnitKey (from the package). */
  bridgeUnits: Map<string, string>;
  /** trace EVENT ids evidenced by the package (capture `evidencesTraceEventId`). */
  traceEventIds: Set<string>;
  /** managed screenshot artifact ids surfaced by the package captures. */
  screenshotArtifactIds: Set<string>;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function indexBridgeUnitRef(
  target: Map<string, string>,
  ref: MaybeBridgeUnitRef | undefined,
): void {
  if (ref === undefined) {
    return;
  }
  if (nonEmptyString(ref.bridgeUnitId) && nonEmptyString(ref.sourceUnitKey)) {
    target.set(ref.bridgeUnitId, ref.sourceUnitKey);
  }
}

/**
 * Build the KNOWN-reference index from a review package. Bridge units are drawn
 * from every observation event (text + choice + choice options) AND every
 * capture; trace event ids + screenshot artifact ids are drawn from the
 * captures. Throws if the package carries no `reviewPackageId` — an index
 * without a manifest identity cannot gate imports.
 */
export function buildReviewImportReferenceIndex(
  source: ReviewPackageReferenceSource,
): ReviewImportReferenceIndex {
  const manifestId = source.reviewManifest.reviewPackageId;
  if (!nonEmptyString(manifestId)) {
    throw new ReviewAnnotationValidationError(
      "review package is missing reviewManifest.reviewPackageId; cannot gate imports",
    );
  }

  const bridgeUnits = new Map<string, string>();
  const traceEventIds = new Set<string>();
  const screenshotArtifactIds = new Set<string>();

  for (const event of source.observationEnvelope.events) {
    indexBridgeUnitRef(bridgeUnits, event.bridgeUnitRef);
    for (const option of event.options ?? []) {
      indexBridgeUnitRef(bridgeUnits, option.bridgeUnitRef);
    }
  }

  for (const capture of source.captureRefs.refs) {
    indexBridgeUnitRef(bridgeUnits, capture.bridgeUnitRef);
    if (nonEmptyString(capture.evidencesTraceEventId)) {
      traceEventIds.add(capture.evidencesTraceEventId);
    }
    if (nonEmptyString(capture.artifactRef.artifactId)) {
      screenshotArtifactIds.add(capture.artifactRef.artifactId);
    }
  }

  return {
    manifestId,
    runtimeReportId: nonEmptyString(source.observationEnvelope.runtimeReportId)
      ? source.observationEnvelope.runtimeReportId
      : null,
    bridgeUnits,
    traceEventIds,
    screenshotArtifactIds,
  };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

export class ReviewAnnotationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewAnnotationValidationError";
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReviewAnnotationValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (!nonEmptyString(value)) {
    throw new ReviewAnnotationValidationError(`${label} must be a non-empty string`);
  }
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ReviewAnnotationValidationError(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

/**
 * Strict schema assertion for a review annotation. All seven fields are
 * validated; unknown-shape input throws a typed error (no silent coercion).
 */
export function assertReviewAnnotation(value: unknown): asserts value is ReviewAnnotation {
  const record = asRecord(value, "ReviewAnnotation");
  assertNonEmptyString(record.manifestId, "ReviewAnnotation.manifestId");

  const bridgeUnitRef = asRecord(record.bridgeUnitRef, "ReviewAnnotation.bridgeUnitRef");
  assertNonEmptyString(bridgeUnitRef.bridgeUnitId, "ReviewAnnotation.bridgeUnitRef.bridgeUnitId");
  assertNonEmptyString(bridgeUnitRef.sourceUnitKey, "ReviewAnnotation.bridgeUnitRef.sourceUnitKey");

  assertNonEmptyString(record.traceId, "ReviewAnnotation.traceId");

  const artifactRef = asRecord(
    record.screenshotArtifactRef,
    "ReviewAnnotation.screenshotArtifactRef",
  );
  assertNonEmptyString(artifactRef.artifactId, "ReviewAnnotation.screenshotArtifactRef.artifactId");
  assertNonEmptyString(artifactRef.uri, "ReviewAnnotation.screenshotArtifactRef.uri");

  assertNonEmptyString(record.reviewerNote, "ReviewAnnotation.reviewerNote");
  assertEnum(record.severity, HUMAN_FINDING_SEVERITIES, "ReviewAnnotation.severity");
  assertEnum(
    record.redactionStatus,
    REVIEW_ANNOTATION_REDACTION_STATUSES,
    "ReviewAnnotation.redactionStatus",
  );
}

/** Parse-and-return a validated, normalized `ReviewAnnotation`. */
export function parseReviewAnnotation(value: unknown): ReviewAnnotation {
  assertReviewAnnotation(value);
  return {
    manifestId: value.manifestId,
    bridgeUnitRef: {
      bridgeUnitId: value.bridgeUnitRef.bridgeUnitId,
      sourceUnitKey: value.bridgeUnitRef.sourceUnitKey,
    },
    traceId: value.traceId,
    screenshotArtifactRef: {
      artifactId: value.screenshotArtifactRef.artifactId,
      uri: value.screenshotArtifactRef.uri,
    },
    reviewerNote: value.reviewerNote,
    severity: value.severity,
    redactionStatus: value.redactionStatus,
  };
}

// ---------------------------------------------------------------------------
// Import boundary (KNOWN-ness gate + deterministic finding creation)
// ---------------------------------------------------------------------------

export const REVIEW_ANNOTATION_IMPORT_REJECTION_CODES = [
  "manifest_mismatch",
  "unknown_bridge_unit",
  "bridge_unit_source_key_mismatch",
  "unknown_trace_id",
  "unknown_screenshot_artifact",
  "unmanaged_screenshot_uri",
] as const;
export type ReviewAnnotationImportRejectionCode =
  (typeof REVIEW_ANNOTATION_IMPORT_REJECTION_CODES)[number];

export class ReviewAnnotationImportError extends Error {
  readonly code: ReviewAnnotationImportRejectionCode;
  constructor(code: ReviewAnnotationImportRejectionCode, message: string) {
    super(message);
    this.name = "ReviewAnnotationImportError";
    this.code = code;
  }
}

function assertKnownReferences(
  annotation: ReviewAnnotation,
  index: ReviewImportReferenceIndex,
): void {
  if (annotation.manifestId !== index.manifestId) {
    throw new ReviewAnnotationImportError(
      "manifest_mismatch",
      `annotation manifestId ${annotation.manifestId} does not belong to review package ${index.manifestId}`,
    );
  }

  const knownSourceKey = index.bridgeUnits.get(annotation.bridgeUnitRef.bridgeUnitId);
  if (knownSourceKey === undefined) {
    throw new ReviewAnnotationImportError(
      "unknown_bridge_unit",
      `bridge unit ${annotation.bridgeUnitRef.bridgeUnitId} is not known to review package ${index.manifestId}`,
    );
  }
  if (knownSourceKey !== annotation.bridgeUnitRef.sourceUnitKey) {
    throw new ReviewAnnotationImportError(
      "bridge_unit_source_key_mismatch",
      `bridge unit ${annotation.bridgeUnitRef.bridgeUnitId} sourceUnitKey ${annotation.bridgeUnitRef.sourceUnitKey} does not match the known key ${knownSourceKey}`,
    );
  }

  if (!index.traceEventIds.has(annotation.traceId)) {
    throw new ReviewAnnotationImportError(
      "unknown_trace_id",
      `trace id ${annotation.traceId} is not evidenced by review package ${index.manifestId}`,
    );
  }

  if (!index.screenshotArtifactIds.has(annotation.screenshotArtifactRef.artifactId)) {
    throw new ReviewAnnotationImportError(
      "unknown_screenshot_artifact",
      `screenshot artifact ${annotation.screenshotArtifactRef.artifactId} is not surfaced by review package ${index.manifestId}`,
    );
  }
  if (!annotation.screenshotArtifactRef.uri.startsWith(MANAGED_RUNTIME_URI_ROOT)) {
    throw new ReviewAnnotationImportError(
      "unmanaged_screenshot_uri",
      `screenshot uri ${annotation.screenshotArtifactRef.uri} is not a managed runtime artifact uri`,
    );
  }
}

function canonicalAnnotationString(annotation: ReviewAnnotation): string {
  // Fixed field order → stable serialization independent of input key order.
  return JSON.stringify([
    annotation.manifestId,
    annotation.bridgeUnitRef.bridgeUnitId,
    annotation.bridgeUnitRef.sourceUnitKey,
    annotation.traceId,
    annotation.screenshotArtifactRef.artifactId,
    annotation.screenshotArtifactRef.uri,
    annotation.reviewerNote,
    annotation.severity,
    annotation.redactionStatus,
  ]);
}

function summarizeAnnotation(annotation: ReviewAnnotation): string {
  if (annotation.redactionStatus === "redacted") {
    // Never surface a redacted note verbatim; the summary stays deterministic
    // by depending only on the note LENGTH, not its content.
    return `Review annotation (redacted note, ${annotation.reviewerNote.length} chars)`;
  }
  const collapsed = annotation.reviewerNote.replace(/\s+/g, " ").trim();
  const note = collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 197)}...`;
  return `Review annotation: ${note}`;
}

function buildReviewAnnotationFinding(annotation: ReviewAnnotation): ReviewAnnotationFinding {
  const annotationHash = sha256HashString(canonicalAnnotationString(annotation));
  const findingId = deterministicUuid7(
    FINDING_ID_NAMESPACE,
    annotation.manifestId,
    annotation.bridgeUnitRef.bridgeUnitId,
    annotation.bridgeUnitRef.sourceUnitKey,
    annotation.traceId,
    annotation.screenshotArtifactRef.artifactId,
    annotation.severity,
    annotation.redactionStatus,
    annotation.reviewerNote,
  );
  return {
    findingId,
    attribution: REVIEW_ANNOTATION_ATTRIBUTION,
    severity: annotation.severity,
    category: REVIEW_ANNOTATION_FINDING_CATEGORY,
    bridgeUnitId: annotation.bridgeUnitRef.bridgeUnitId,
    summary: summarizeAnnotation(annotation),
    provenance: {
      source: "utsushi_review_annotation",
      manifestId: annotation.manifestId,
      bridgeUnitRef: annotation.bridgeUnitRef,
      traceId: annotation.traceId,
      screenshotArtifactRef: annotation.screenshotArtifactRef,
      redactionStatus: annotation.redactionStatus,
      annotationHash,
    },
  };
}

/**
 * FEEDBACK BOUNDARY. Validate an annotation's schema, gate it against the
 * review package's KNOWN references, and derive a DETERMINISTIC Itotori finding
 * record. Throws `ReviewAnnotationValidationError` on bad shape and
 * `ReviewAnnotationImportError` on an unknown/mismatched reference — the
 * boundary never emits a dangling finding.
 */
export function importReviewAnnotation(
  annotation: unknown,
  index: ReviewImportReferenceIndex,
): ReviewAnnotationImportResult {
  const parsed = parseReviewAnnotation(annotation);
  assertKnownReferences(parsed, index);
  return { finding: buildReviewAnnotationFinding(parsed) };
}

export type ReviewAnnotationImportOutcome =
  | { ok: true; finding: ReviewAnnotationFinding }
  | {
      ok: false;
      rejection: {
        code: ReviewAnnotationImportRejectionCode | "schema_invalid";
        message: string;
      };
    };

/**
 * Non-throwing variant of {@link importReviewAnnotation}. Returns a FLAGGED
 * rejection instead of throwing so a batch importer can partition an annotation
 * set into imported findings vs. rejected annotations without try/catch.
 */
export function tryImportReviewAnnotation(
  annotation: unknown,
  index: ReviewImportReferenceIndex,
): ReviewAnnotationImportOutcome {
  try {
    return { ok: true, finding: importReviewAnnotation(annotation, index).finding };
  } catch (error) {
    if (error instanceof ReviewAnnotationImportError) {
      return { ok: false, rejection: { code: error.code, message: error.message } };
    }
    if (error instanceof ReviewAnnotationValidationError) {
      return { ok: false, rejection: { code: "schema_invalid", message: error.message } };
    }
    throw error;
  }
}

/**
 * Bridge the deterministic finding into the triage router's `HumanFinding`
 * surface. The pure finding carries no wall-clock; the caller supplies the
 * `recordedAt` at persistence time (keeping the imported record deterministic).
 */
export function reviewAnnotationFindingToHumanFinding(
  finding: ReviewAnnotationFinding,
  recordedAt: Date,
): HumanFinding {
  return {
    findingId: finding.findingId,
    bridgeUnitId: finding.bridgeUnitId,
    attribution: finding.attribution,
    severity: finding.severity,
    category: finding.category,
    summary: finding.summary,
    recordedAt,
  };
}
