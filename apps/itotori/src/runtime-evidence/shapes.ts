// Runtime-evidence QA shapes.
//
// A QA agent inspects Utsushi runtime evidence (runtime observation events,
// screenshot captures, launched-runtime proof) EXCLUSIVELY through the tools in `tools.ts`. It never opens a raw
// artifact file. Every tool resolves a MANAGED ARTIFACT REF against the
// `RuntimeEvidenceArtifactStore` (artifact-store.ts) and every finding it
// emits CITES the managed refs it read — trace-only, screenshot-backed, or
// both.
//
// These are the wire shapes both the deterministic checks and the agent
// findings commit to. They are provider-free and DB-free so the tools +
// deterministic path are testable without a live model or Postgres.

import type {
  Bcp47Locale,
  RuntimeArtifactKindV02,
  RuntimeEvidenceTierV02,
  Uuid7,
} from "@itotori/localization-bridge-schema";

/**
 * The five runtime-evidence finding kinds a QA agent can surface.
 *   - `missing_text`  — an expected bridge unit produced NO observed runtime
 *                       text (trace-only; fully deterministic).
 *   - `wrong_branch`  — a branch selected a route that the expected route map
 *                       forbids (trace-only; deterministic given the map).
 *   - `layout`        — a rendered element / OCR region overflows the frame
 *                       (screenshot-backed; geometric overflow is
 *                       deterministic).
 *   - `mismatch`      — observed runtime text != the expected translation
 *                       (trace + optionally screenshot; EXACT/normalized
 *                       mismatch is deterministic, semantic paraphrase is the
 *                       agent's job).
 *   - `ocr_hint`      — an informational OCR text-region hint lifted from a
 *                       screenshot capture (screenshot-backed; extraction is
 *                       deterministic, interpretation is the agent's job).
 */
export const RUNTIME_EVIDENCE_FINDING_KINDS = [
  "missing_text",
  "wrong_branch",
  "layout",
  "mismatch",
  "ocr_hint",
] as const;
export type RuntimeEvidenceFindingKind = (typeof RUNTIME_EVIDENCE_FINDING_KINDS)[number];

/** Aligned with `HumanFindingSeverity` so triage routing maps 1:1. */
export const RUNTIME_EVIDENCE_SEVERITIES = ["critical", "major", "minor", "info"] as const;
export type RuntimeEvidenceSeverity = (typeof RUNTIME_EVIDENCE_SEVERITIES)[number];

/**
 * Whether a finding is backed by trace evidence, screenshot evidence, or
 * both. Every finding names its backing so a reviewer knows what class of
 * proof stands behind it.
 */
export const RUNTIME_EVIDENCE_BACKINGS = ["trace", "screenshot", "both"] as const;
export type RuntimeEvidenceBacking = (typeof RUNTIME_EVIDENCE_BACKINGS)[number];

/** The kind of managed artifact a citation points at. */
export const RUNTIME_EVIDENCE_CITATION_KINDS = [
  "report",
  "trace",
  "branch",
  "screenshot",
  "ocr",
] as const;
export type RuntimeEvidenceCitationKind = (typeof RUNTIME_EVIDENCE_CITATION_KINDS)[number];

export const RUNTIME_EVIDENCE_DETECTOR_KINDS = ["deterministic_check", "agent"] as const;
export type RuntimeEvidenceDetectorKind = (typeof RUNTIME_EVIDENCE_DETECTOR_KINDS)[number];

/**
 * A MANAGED artifact reference. Tools read runtime evidence + screenshots
 * through these refs; findings cite them. `hash` is `null` only when the
 * source artifact never carried one (never omitted — JSON-stable).
 */
export type ManagedArtifactRef = {
  artifactId: string;
  artifactKind: RuntimeArtifactKindV02;
  uri: string;
  hash: string | null;
};

/**
 * One citation on a finding. It names the managed artifact that backs the
 * claim (`artifactRef`), the observation/trace/branch event id inside it when
 * one applies (`observationEventId`), and a human-readable `detail`.
 */
export type RuntimeEvidenceCitation = {
  citationKind: RuntimeEvidenceCitationKind;
  artifactRef: ManagedArtifactRef;
  observationEventId: string | null;
  detail: string;
};

/**
 * A single runtime-evidence finding. Produced by a deterministic tool
 * (`detectorKind: "deterministic_check"`) or by the agent
 * (`detectorKind: "agent"`). Always carries at least one citation.
 */
export type RuntimeEvidenceFinding = {
  findingId: string;
  findingKind: RuntimeEvidenceFindingKind;
  severity: RuntimeEvidenceSeverity;
  detectorKind: RuntimeEvidenceDetectorKind;
  bridgeUnitId: string | null;
  sourceUnitKey: string | null;
  message: string;
  expected: string | null;
  observed: string | null;
  evidenceBacking: RuntimeEvidenceBacking;
  citations: RuntimeEvidenceCitation[];
};

/**
 * One OCR text-region hint recognised over a screenshot capture. The
 * managed OCR artifact (screenshot capture + an OCR pass) holds these; the
 * `ocr-hints` and `layout` tools resolve them through the store.
 */
export type ScreenshotOcrRegion = {
  regionId: string;
  bridgeUnitId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  recognizedText: string;
};

/**
 * A managed OCR artifact keyed to a screenshot capture's `artifactRef`.
 * `screenshotArtifactId` MUST equal the capture screenshot artifact id so a
 * tool can resolve OCR for a capture it found in the report.
 */
export type ScreenshotOcrArtifact = {
  artifactId: string;
  screenshotArtifactId: string;
  frameWidth: number;
  frameHeight: number;
  capturedAtFrame: number;
  regions: ScreenshotOcrRegion[];
};

/**
 * Expectation for one bridge unit the runtime SHOULD have rendered.
 * Presence in the expectation set means "this unit must produce observed
 * text"; a defined `expectedText` additionally pins the exact rendered
 * string (post-translation), enabling the deterministic mismatch check.
 */
export type RuntimeUnitExpectation = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  expectedText?: string;
};

/**
 * Expectation for one branch point: the set of route keys the branch is
 * ALLOWED to lead to. A selected option resolving to any other route key is
 * an unambiguous `wrong_branch` finding.
 */
export type RuntimeBranchExpectation = {
  branchPointKey: string;
  allowedRouteKeys: string[];
};

export type RuntimeEvidenceExpectations = {
  sourceLocale?: Bcp47Locale;
  targetLocale?: Bcp47Locale;
  units: RuntimeUnitExpectation[];
  branches: RuntimeBranchExpectation[];
};

export const RUNTIME_EVIDENCE_EVIDENCE_TIER_VALUES: readonly RuntimeEvidenceTierV02[] = [
  "E0",
  "E1",
  "E2",
  "E3",
  "E4",
];

/**
 * Raised when a tool is handed a managed artifact ref the store cannot
 * resolve. A hard error, never a silent empty result — a misconfigured
 * managed store must surface, not masquerade as "no findings".
 */
export class RuntimeEvidenceArtifactUnresolvedError extends Error {
  constructor(
    public readonly artifactId: string,
    public readonly artifactKind: string,
  ) {
    super(
      `runtime-evidence tool refused: managed artifact ${artifactKind} '${artifactId}' did not resolve in the store`,
    );
    this.name = "RuntimeEvidenceArtifactUnresolvedError";
  }
}
