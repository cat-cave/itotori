// UTSUSHI-066 — review-annotation import boundary tests.
//
// DB-less. Proves: (1) the annotation schema carries all seven fields and
// rejects partial shapes; (2) importing an annotation linked to a KNOWN bridge
// unit + trace id + screenshot artifact creates a DETERMINISTIC Itotori finding
// record (stable id + shape; same annotation → same finding); (3) an annotation
// referencing an UNKNOWN bridge unit / trace id / screenshot / manifest is
// REJECTED (no dangling finding). Synthetic fixtures only.

import { describe, expect, it } from "vitest";
import {
  assertReviewAnnotation,
  buildReviewImportReferenceIndex,
  importReviewAnnotation,
  parseReviewAnnotation,
  REVIEW_ANNOTATION_IMPORT_REJECTION_CODES,
  type ReviewAnnotation,
  ReviewAnnotationImportError,
  ReviewAnnotationValidationError,
  reviewAnnotationFindingToHumanFinding,
  type ReviewImportReferenceIndex,
  type ReviewPackageReferenceSource,
  tryImportReviewAnnotation,
} from "../src/reviewer/review-annotation-import.js";

// ---------------------------------------------------------------------------
// Synthetic review package (structural subset of the UTSUSHI-134 demo bundle).
// ---------------------------------------------------------------------------

const MANIFEST_ID = "ec58da93-216e-7a07-b796-beed7cf97f06";
const TRACE_EVENT_ID = "3291ade3-e2b5-7a4f-9e7f-4e654e2ed1f3";
const SCREENSHOT_ARTIFACT_ID = "76dcaf93-37f1-7227-8869-92285557b5d0";
const SCREENSHOT_URI = `artifacts/utsushi/runtime/58a98a57-e18f-75dc-8bce-19880e3b9856/screenshots/${SCREENSHOT_ARTIFACT_ID}.png`;
const CAPTURE_BRIDGE_UNIT_ID = "5ce7ce53-c610-743e-b987-f54465e15561";
const CAPTURE_SOURCE_KEY = "rpgmaker:Map012.json#/events/3/pages/0/list/5/parameters/0";

const REVIEW_PACKAGE: ReviewPackageReferenceSource = {
  reviewManifest: { reviewPackageId: MANIFEST_ID },
  observationEnvelope: {
    runtimeReportId: "019ed050-0000-7000-8000-000000001000",
    events: [
      {
        bridgeUnitRef: {
          bridgeUnitId: "019ed000-0000-7000-8000-bridgeun0001",
          sourceUnitKey: "mvmz.scene1.line1",
        },
      },
      {
        bridgeUnitRef: {
          bridgeUnitId: "019ed000-0000-7000-8000-bridgeun0003",
          sourceUnitKey: "mvmz.scene1.choice",
        },
        options: [
          {
            bridgeUnitRef: {
              bridgeUnitId: "019ed000-0000-7000-8000-bridgeun0004",
              sourceUnitKey: "mvmz.scene1.choice.opt0",
            },
          },
        ],
      },
    ],
  },
  captureRefs: {
    refs: [
      {
        bridgeUnitRef: {
          bridgeUnitId: CAPTURE_BRIDGE_UNIT_ID,
          sourceUnitKey: CAPTURE_SOURCE_KEY,
        },
        evidencesTraceEventId: TRACE_EVENT_ID,
        artifactRef: { artifactId: SCREENSHOT_ARTIFACT_ID },
      },
    ],
  },
};

function baseAnnotation(): ReviewAnnotation {
  return {
    manifestId: MANIFEST_ID,
    bridgeUnitRef: {
      bridgeUnitId: CAPTURE_BRIDGE_UNIT_ID,
      sourceUnitKey: CAPTURE_SOURCE_KEY,
    },
    traceId: TRACE_EVENT_ID,
    screenshotArtifactRef: { artifactId: SCREENSHOT_ARTIFACT_ID, uri: SCREENSHOT_URI },
    reviewerNote: "Choice label overflows the window; tighten the phrasing.",
    severity: "major",
    redactionStatus: "unredacted",
  };
}

function index(): ReviewImportReferenceIndex {
  return buildReviewImportReferenceIndex(REVIEW_PACKAGE);
}

// ---------------------------------------------------------------------------
// KNOWN-reference index
// ---------------------------------------------------------------------------

describe("buildReviewImportReferenceIndex", () => {
  it("enumerates known bridge units, trace events, and screenshots from the package", () => {
    const built = index();
    expect(built.manifestId).toBe(MANIFEST_ID);
    // observation events (text + choice + option) AND capture bridge units
    expect(built.bridgeUnits.get("019ed000-0000-7000-8000-bridgeun0001")).toBe("mvmz.scene1.line1");
    expect(built.bridgeUnits.get("019ed000-0000-7000-8000-bridgeun0004")).toBe(
      "mvmz.scene1.choice.opt0",
    );
    expect(built.bridgeUnits.get(CAPTURE_BRIDGE_UNIT_ID)).toBe(CAPTURE_SOURCE_KEY);
    expect(built.traceEventIds.has(TRACE_EVENT_ID)).toBe(true);
    expect(built.screenshotArtifactIds.has(SCREENSHOT_ARTIFACT_ID)).toBe(true);
    expect(built.runtimeReportId).toBe("019ed050-0000-7000-8000-000000001000");
  });

  it("rejects a package with no reviewPackageId", () => {
    expect(() =>
      buildReviewImportReferenceIndex({
        ...REVIEW_PACKAGE,
        reviewManifest: { reviewPackageId: null },
      }),
    ).toThrow(ReviewAnnotationValidationError);
  });
});

// ---------------------------------------------------------------------------
// Schema (all seven fields)
// ---------------------------------------------------------------------------

describe("review annotation schema", () => {
  it("accepts a well-formed annotation carrying all seven fields", () => {
    const parsed = parseReviewAnnotation(baseAnnotation());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "bridgeUnitRef",
        "manifestId",
        "redactionStatus",
        "reviewerNote",
        "screenshotArtifactRef",
        "severity",
        "traceId",
      ].sort(),
    );
    expect(() => assertReviewAnnotation(baseAnnotation())).not.toThrow();
  });

  it.each([
    "manifestId",
    "traceId",
    "reviewerNote",
    "severity",
    "redactionStatus",
    "bridgeUnitRef",
    "screenshotArtifactRef",
  ])("rejects an annotation missing %s", (field) => {
    const annotation = baseAnnotation() as Record<string, unknown>;
    delete annotation[field];
    expect(() => assertReviewAnnotation(annotation)).toThrow(ReviewAnnotationValidationError);
  });

  it("rejects an unknown severity or redaction status", () => {
    expect(() => assertReviewAnnotation({ ...baseAnnotation(), severity: "catastrophic" })).toThrow(
      ReviewAnnotationValidationError,
    );
    expect(() => assertReviewAnnotation({ ...baseAnnotation(), redactionStatus: "maybe" })).toThrow(
      ReviewAnnotationValidationError,
    );
  });

  it("rejects a partial bridgeUnitRef", () => {
    expect(() =>
      assertReviewAnnotation({
        ...baseAnnotation(),
        bridgeUnitRef: { bridgeUnitId: CAPTURE_BRIDGE_UNIT_ID },
      }),
    ).toThrow(ReviewAnnotationValidationError);
  });
});

// ---------------------------------------------------------------------------
// Import boundary: KNOWN → deterministic finding
// ---------------------------------------------------------------------------

describe("importReviewAnnotation — feedback boundary", () => {
  it("creates a deterministic finding record from a known-linked annotation", () => {
    const { finding } = importReviewAnnotation(baseAnnotation(), index());
    expect(finding.attribution).toBe("reviewer");
    expect(finding.category).toBe("review_annotation");
    expect(finding.severity).toBe("major");
    expect(finding.bridgeUnitId).toBe(CAPTURE_BRIDGE_UNIT_ID);
    expect(finding.findingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(finding.provenance).toEqual({
      source: "utsushi_review_annotation",
      manifestId: MANIFEST_ID,
      bridgeUnitRef: { bridgeUnitId: CAPTURE_BRIDGE_UNIT_ID, sourceUnitKey: CAPTURE_SOURCE_KEY },
      traceId: TRACE_EVENT_ID,
      screenshotArtifactRef: { artifactId: SCREENSHOT_ARTIFACT_ID, uri: SCREENSHOT_URI },
      redactionStatus: "unredacted",
      annotationHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it("is DETERMINISTIC — the same annotation imports to the same finding record", () => {
    const idx = index();
    const first = importReviewAnnotation(baseAnnotation(), idx).finding;
    // Re-import with a re-built index and independently constructed annotation.
    const second = importReviewAnnotation(baseAnnotation(), index()).finding;
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("changes the finding id when the annotation content changes", () => {
    const a = importReviewAnnotation(baseAnnotation(), index()).finding;
    const b = importReviewAnnotation(
      { ...baseAnnotation(), reviewerNote: "A different reviewer note." },
      index(),
    ).finding;
    expect(b.findingId).not.toBe(a.findingId);
  });

  it("never surfaces a redacted reviewer note verbatim, yet stays deterministic", () => {
    const redacted: ReviewAnnotation = {
      ...baseAnnotation(),
      reviewerNote: "SECRET internal reviewer text that must not leak.",
      redactionStatus: "redacted",
    };
    const first = importReviewAnnotation(redacted, index()).finding;
    const second = importReviewAnnotation(redacted, index()).finding;
    expect(first.summary).not.toContain("SECRET");
    expect(first.summary).toContain("redacted");
    expect(second).toEqual(first);
  });

  it("bridges the deterministic finding into a HumanFinding for the triage router", () => {
    const finding = importReviewAnnotation(baseAnnotation(), index()).finding;
    const recordedAt = new Date("2026-07-05T00:00:00.000Z");
    const human = reviewAnnotationFindingToHumanFinding(finding, recordedAt);
    expect(human).toEqual({
      findingId: finding.findingId,
      bridgeUnitId: CAPTURE_BRIDGE_UNIT_ID,
      attribution: "reviewer",
      severity: "major",
      category: "review_annotation",
      summary: finding.summary,
      recordedAt,
    });
  });
});

// ---------------------------------------------------------------------------
// Import boundary: UNKNOWN → rejected (no dangling finding)
// ---------------------------------------------------------------------------

describe("importReviewAnnotation — unknown-reference rejection", () => {
  it("rejects an annotation referencing an UNKNOWN bridge unit", () => {
    const annotation: ReviewAnnotation = {
      ...baseAnnotation(),
      bridgeUnitRef: {
        bridgeUnitId: "00000000-0000-7000-8000-notaknownunit",
        sourceUnitKey: "mvmz.unknown",
      },
    };
    expect(() => importReviewAnnotation(annotation, index())).toThrow(ReviewAnnotationImportError);
    try {
      importReviewAnnotation(annotation, index());
    } catch (error) {
      expect((error as ReviewAnnotationImportError).code).toBe("unknown_bridge_unit");
    }
  });

  it("rejects an annotation referencing an UNKNOWN trace id", () => {
    const outcome = tryImportReviewAnnotation(
      { ...baseAnnotation(), traceId: "00000000-0000-7000-8000-notaknowntrace" },
      index(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.code).toBe("unknown_trace_id");
    }
  });

  it("rejects a bridge unit whose sourceUnitKey does not match the known key", () => {
    const outcome = tryImportReviewAnnotation(
      {
        ...baseAnnotation(),
        bridgeUnitRef: { bridgeUnitId: CAPTURE_BRIDGE_UNIT_ID, sourceUnitKey: "mvmz.wrong.key" },
      },
      index(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.code).toBe("bridge_unit_source_key_mismatch");
    }
  });

  it("rejects an unknown screenshot artifact and an unmanaged screenshot uri", () => {
    const unknownArtifact = tryImportReviewAnnotation(
      {
        ...baseAnnotation(),
        screenshotArtifactRef: {
          artifactId: "00000000-0000-7000-8000-notaknownart",
          uri: `${"artifacts/utsushi/runtime/"}x/screenshots/00000000-0000-7000-8000-notaknownart.png`,
        },
      },
      index(),
    );
    expect(unknownArtifact.ok).toBe(false);
    if (!unknownArtifact.ok) {
      expect(unknownArtifact.rejection.code).toBe("unknown_screenshot_artifact");
    }

    const unmanaged = tryImportReviewAnnotation(
      {
        ...baseAnnotation(),
        screenshotArtifactRef: {
          artifactId: SCREENSHOT_ARTIFACT_ID,
          uri: `https://evil.example/${SCREENSHOT_ARTIFACT_ID}.png`,
        },
      },
      index(),
    );
    expect(unmanaged.ok).toBe(false);
    if (!unmanaged.ok) {
      expect(unmanaged.rejection.code).toBe("unmanaged_screenshot_uri");
    }
  });

  it("rejects an annotation whose manifestId belongs to a different review package", () => {
    const outcome = tryImportReviewAnnotation(
      { ...baseAnnotation(), manifestId: "ffffffff-216e-7a07-b796-beed7cf97f06" },
      index(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.code).toBe("manifest_mismatch");
    }
  });

  it("flags a schema-invalid annotation without throwing", () => {
    const outcome = tryImportReviewAnnotation({ manifestId: MANIFEST_ID }, index());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.code).toBe("schema_invalid");
    }
  });

  it("exposes every rejection code as a stable enum", () => {
    expect([...REVIEW_ANNOTATION_IMPORT_REJECTION_CODES]).toEqual([
      "manifest_mismatch",
      "unknown_bridge_unit",
      "bridge_unit_source_key_mismatch",
      "unknown_trace_id",
      "unknown_screenshot_artifact",
      "unmanaged_screenshot_uri",
    ]);
  });
});
