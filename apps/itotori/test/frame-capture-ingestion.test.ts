// itotori-review-frame-artifact-ingestion — capture-row ingestion tests.
//
// DB-less. Proves the acceptance crux: a render-validate frame artifact
// (both the FrameArtifact announcement and the richer render-validate report)
// ingests into a dashboard-visible CAPTURE ROW linked to its draft unit with
// addressable per-scene/line annotation targets; the row is deterministic
// (two ingests → byte-identical row), redaction-capable (the redacted variant
// excludes the managed runtime URI + content hash), and project-parameterized
// (the same frame announced for two projects produces two distinct rows).
// Synthetic fixtures only — no game-specific paths, no real copyrighted bytes.

import { describe, expect, it } from "vitest";
import {
  assertFrameCaptureRow,
  assertRedactedFrameCaptureRow,
  FRAME_ARTIFACT_KIND_ALLOW_LIST,
  FRAME_CAPTURE_ANNOTATION_TARGET_KINDS,
  FRAME_CAPTURE_REDACTED_FIELDS,
  FRAME_CAPTURE_REDACTION_RULES,
  FRAME_CAPTURE_ROW_SCHEMA_VERSION,
  FRAME_EVIDENCE_TIER_FLOOR,
  FrameCaptureIngestError,
  FrameCaptureValidationError,
  ingestFrameArtifact,
  ingestFrameArtifactParsed,
  ingestRenderValidateReport,
  MANAGED_RUNTIME_ARTIFACT_URI_ROOT,
  REDACTED_FRAME_CAPTURE_VALUE,
  redactFrameCaptureRow,
  tryIngestFrameArtifact,
  type FrameArtifactJson,
  type FrameCaptureProjectContext,
  type FrameCaptureRow,
  type RenderValidateReportJson,
} from "../src/reviewer/frame-capture-ingestion.js";

// ---------------------------------------------------------------------------
// Synthetic project context + frame-artifact fixtures (game-agnostic).
// ---------------------------------------------------------------------------

const PROJECT_ID = "019ed050-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed050-0000-7000-8000-000000000002";
const BRIDGE_UNIT_ID = "019ed050-0000-7000-8000-000000000010";
const SOURCE_UNIT_KEY = "bridge.scene-001.line-007";
const ARTIFACT_ID = "019ed050-0000-7000-8000-000000000020";
const RUN_ID = "019ed050-0000-7000-8000-000000000030";
const ARTIFACT_URI = `${MANAGED_RUNTIME_ARTIFACT_URI_ROOT}${RUN_ID}/screenshots/${ARTIFACT_ID}.png`;

function projectContext(
  overrides: Partial<FrameCaptureProjectContext> = {},
): FrameCaptureProjectContext {
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    bridgeUnitRef: { bridgeUnitId: BRIDGE_UNIT_ID, sourceUnitKey: SOURCE_UNIT_KEY },
    ...overrides,
  };
}

function frameArtifactFixture(overrides: Partial<FrameArtifactJson> = {}): FrameArtifactJson {
  return {
    frameId: `${RUN_ID}:frame:0001`,
    evidenceTier: "E2",
    artifactRef: {
      artifactId: ARTIFACT_ID,
      artifactKind: "screenshot",
      uri: ARTIFACT_URI,
    },
    frameIndex: 1,
    bridgeRef: { bridgeUnitId: BRIDGE_UNIT_ID, sourceUnitKey: SOURCE_UNIT_KEY },
    ...overrides,
  };
}

function renderValidateReportFixture(
  overrides: Partial<RenderValidateReportJson> = {},
): RenderValidateReportJson {
  return {
    schemaVersion: "0.1.0",
    engine: "utsushi-reallive",
    sceneId: "scene-001",
    evidenceTier: "E2",
    artifactKind: "screenshot",
    artifactId: ARTIFACT_ID,
    artifactUri: ARTIFACT_URI,
    frameIndex: 1,
    width: 640,
    height: 480,
    textlineCount: 3,
    renderedLineCount: 1,
    renderedTextSha256: "sha256:cafebabe",
    containsExpected: true,
    redaction: "on",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FrameArtifact -> capture row
// ---------------------------------------------------------------------------

describe("ingestFrameArtifact", () => {
  it("ingest_frame_artifact_produces_row_keyed_by_project_and_unit_with_frame_target()", () => {
    const { row } = ingestFrameArtifact(frameArtifactFixture(), projectContext());

    expect(row.schemaVersion).toBe(FRAME_CAPTURE_ROW_SCHEMA_VERSION);
    expect(row.projectId).toBe(PROJECT_ID);
    expect(row.localeBranchId).toBe(LOCALE_BRANCH_ID);
    expect(row.bridgeUnitId).toBe(BRIDGE_UNIT_ID);
    expect(row.sourceUnitKey).toBe(SOURCE_UNIT_KEY);
    expect(row.frameIndex).toBe(1);
    expect(row.evidenceTier).toBe("E2");
    expect(row.sourceArtifactKind).toBe("frame_artifact");
    expect(row.sourceRedactionMode).toBe("unknown");
    expect(row.artifactRef).toEqual({
      artifactId: ARTIFACT_ID,
      artifactKind: "screenshot",
      uri: ARTIFACT_URI,
      mediaType: null,
    });
    expect(row.artifactHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row.width).toBeNull();
    expect(row.height).toBeNull();
    expect(row.sceneId).toBeNull();
    expect(row.redactionStatus).toBe("not_required");

    // A bare FrameArtifact carries no scene/line metadata → exactly one
    // `frame` annotation target, anchored on the monotonic runtime frame.
    expect(row.annotationTargets).toHaveLength(1);
    const [target] = row.annotationTargets;
    expect(target).toBeDefined();
    expect(target!.targetKind).toBe("frame");
    expect(target!.frameIndex).toBe(1);
    expect(target!.sceneId).toBeNull();
    expect(target!.lineIndex).toBeNull();
    expect(target!.bridgeUnitId).toBe(BRIDGE_UNIT_ID);
    expect(target!.sourceUnitKey).toBe(SOURCE_UNIT_KEY);
    expect(target!.label).toBe("frame:1");
    expect(target!.targetId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("ingest_frame_artifact_emits_scene_target_when_context_supplies_scene_id()", () => {
    const { row } = ingestFrameArtifact(
      frameArtifactFixture(),
      projectContext({ sceneId: "scene-001" }),
    );

    expect(row.sceneId).toBe("scene-001");
    const kinds = row.annotationTargets.map((target) => target.targetKind);
    // [scene, frame] — stable order.
    expect(kinds).toEqual(["scene", "frame"]);
    const sceneTarget = row.annotationTargets[0]!;
    expect(sceneTarget.targetKind).toBe("scene");
    expect(sceneTarget.sceneId).toBe("scene-001");
    expect(sceneTarget.frameIndex).toBeNull();
    expect(sceneTarget.label).toBe("scene:scene-001");
    const frameTarget = row.annotationTargets[1]!;
    expect(frameTarget.label).toBe("scene:scene-001/frame:1");
  });

  it("ingest_frame_artifact_is_deterministic_two_ingests_produce_byte_identical_row()", () => {
    const artifact = frameArtifactFixture();
    const context = projectContext();

    const first = ingestFrameArtifact(artifact, context).row;
    const second = ingestFrameArtifact(artifact, context).row;

    // Structural equality — every field, including id + target ids + labels.
    expect(second).toEqual(first);
    // And the byte-serialized form is identical too (no wall-clock leakage).
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("ingest_frame_artifact_project_parameterized_same_frame_two_projects_distinct_rows()", () => {
    const artifact = frameArtifactFixture();
    const ctxA = projectContext({ projectId: "project-A" });
    const ctxB = projectContext({ projectId: "project-B" });

    const rowA = ingestFrameArtifact(artifact, ctxA).row;
    const rowB = ingestFrameArtifact(artifact, ctxB).row;

    expect(rowA.captureRowId).not.toBe(rowB.captureRowId);
    expect(rowA.projectId).toBe("project-A");
    expect(rowB.projectId).toBe("project-B");
    // Same artifact → same locator/hash before redaction, but the row identity
    // (id + annotation target ids) is project-scoped.
    expect(rowA.artifactRef.uri).toBe(rowB.artifactRef.uri);
    expect(rowA.annotationTargets[0]!.targetId).not.toBe(rowB.annotationTargets[0]!.targetId);
  });

  it("ingest_frame_artifact_context_bridge_ref_overrides_runtime_bridge_ref()", () => {
    const artifact = frameArtifactFixture({
      bridgeRef: { bridgeUnitId: "runtime-unit", sourceUnitKey: "runtime-key" },
    });
    const context = projectContext({
      bridgeUnitRef: { bridgeUnitId: "draft-unit", sourceUnitKey: "draft-key" },
    });

    const { row } = ingestFrameArtifact(artifact, context);

    expect(row.bridgeUnitId).toBe("draft-unit");
    expect(row.sourceUnitKey).toBe("draft-key");
  });

  it("ingest_frame_artifact_rejects_evidence_tier_below_floor()", () => {
    const artifact = frameArtifactFixture({ evidenceTier: "E1" });

    expect(() => ingestFrameArtifact(artifact, projectContext())).toThrow(FrameCaptureIngestError);
    expect(() => ingestFrameArtifact(artifact, projectContext())).toThrow(
      /below the per-sink floor/,
    );
  });

  it("ingest_frame_artifact_rejects_artifact_kind_outside_allow_list_at_schema_layer()", () => {
    const artifact = frameArtifactFixture({
      artifactRef: {
        artifactId: ARTIFACT_ID,
        artifactKind: "text_line" as unknown as (typeof FRAME_ARTIFACT_KIND_ALLOW_LIST)[number],
        uri: ARTIFACT_URI,
      },
    });

    // The closed-taxonomy schema assertion rejects an unknown kind before the
    // policy layer even sees it.
    expect(() => ingestFrameArtifact(artifact, projectContext())).toThrow(
      /must be one of: screenshot, frame_capture, recording/,
    );
  });

  it("ingestFrameArtifactParsed_rejects_artifact_kind_outside_allow_list_at_policy_layer()", () => {
    // The parsed entry point skips schema validation; the policy layer is the
    // defense-in-depth that still enforces the allow-list (mirrors the
    // utsushi-core sink's per-payload `FrameArtifact::validate()`).
    const artifact = {
      ...frameArtifactFixture(),
      artifactRef: {
        artifactId: ARTIFACT_ID,
        artifactKind: "text_line",
        uri: ARTIFACT_URI,
      },
    } as unknown as Parameters<typeof ingestFrameArtifactParsed>[0];

    expect(() => ingestFrameArtifactParsed(artifact, projectContext())).toThrow(
      /not in the headless-runtime allow-list/,
    );
  });

  it("ingest_frame_artifact_rejects_unmanaged_artifact_uri()", () => {
    const artifact = frameArtifactFixture({
      artifactRef: {
        artifactId: ARTIFACT_ID,
        artifactKind: "screenshot",
        uri: "/scratch/private/render.png",
      },
    });

    expect(() => ingestFrameArtifact(artifact, projectContext())).toThrow(
      /not under the managed runtime root/,
    );
  });

  it("tryIngest_frame_artifact_returns_row_on_success_and_error_on_rejection()", async () => {
    const [row, error] = await tryIngestFrameArtifact(frameArtifactFixture(), projectContext());
    expect(row).not.toBeNull();
    expect(error).toBeNull();
    assertFrameCaptureRow(row);

    const [rejected, rejectionError] = await tryIngestFrameArtifact(
      frameArtifactFixture({ evidenceTier: "E1" }),
      projectContext(),
    );
    expect(rejected).toBeNull();
    expect(rejectionError).toBeInstanceOf(FrameCaptureIngestError);
  });

  it("assertFrameCaptureRow_is_purely_structural_redaction_invariant_owned_by_assertRedactedFrameCaptureRow()", () => {
    const { row } = ingestFrameArtifact(frameArtifactFixture(), projectContext());
    // A row that claims redacted but kept its URI passes the STRUCTURAL
    // assertion (it has the right shape); the redaction invariant is
    // assertRedactedFrameCaptureRow's job — clean separation of concerns.
    const leakingShape: FrameCaptureRow = {
      ...row,
      redactionStatus: "redacted",
      artifactRef: { ...row.artifactRef },
    };

    expect(() => assertFrameCaptureRow(leakingShape)).not.toThrow();
    expect(() => assertRedactedFrameCaptureRow(leakingShape)).toThrow(
      /artifactRef.uri must be redacted/,
    );
  });
});

// ---------------------------------------------------------------------------
// Render-validate report -> capture row (richer: scene + line targets)
// ---------------------------------------------------------------------------

describe("ingestRenderValidateReport", () => {
  it("ingest_render_validate_report_produces_row_with_scene_frame_and_line_targets()", () => {
    const { row } = ingestRenderValidateReport(renderValidateReportFixture(), projectContext());

    expect(row.schemaVersion).toBe(FRAME_CAPTURE_ROW_SCHEMA_VERSION);
    expect(row.sourceArtifactKind).toBe("render_validate_report");
    expect(row.sceneId).toBe("scene-001");
    expect(row.sourceRedactionMode).toBe("on");
    expect(row.width).toBe(640);
    expect(row.height).toBe(480);

    // [scene, frame, line] — stable order; one line target per rendered line.
    const kinds = row.annotationTargets.map((target) => target.targetKind);
    expect(kinds).toEqual(["scene", "frame", "line"]);
    expect(row.annotationTargets).toHaveLength(3);

    const lineTarget = row.annotationTargets[2]!;
    expect(lineTarget.targetKind).toBe("line");
    expect(lineTarget.frameIndex).toBe(1);
    expect(lineTarget.lineIndex).toBe(0);
    expect(lineTarget.sceneId).toBe("scene-001");
    expect(lineTarget.label).toBe("scene:scene-001/frame:1/line:0");
  });

  it("ingest_render_validate_report_emits_one_line_target_per_textline_count_when_rendered_count_absent()", () => {
    const report = renderValidateReportFixture({
      renderedLineCount: undefined,
      textlineCount: 4,
    });
    const { row } = ingestRenderValidateReport(report, projectContext());

    const lineTargets = row.annotationTargets.filter((target) => target.targetKind === "line");
    expect(lineTargets).toHaveLength(4);
    expect(lineTargets.map((target) => target.lineIndex)).toEqual([0, 1, 2, 3]);
  });

  it("ingest_render_validate_report_records_off_source_redaction_mode()", () => {
    const report = renderValidateReportFixture({ redaction: "off" });
    const { row } = ingestRenderValidateReport(report, projectContext());
    expect(row.sourceRedactionMode).toBe("off");
  });

  it("ingest_render_validate_report_is_deterministic_two_ingests_produce_byte_identical_row()", () => {
    const report = renderValidateReportFixture();
    const context = projectContext();

    const first = ingestRenderValidateReport(report, context).row;
    const second = ingestRenderValidateReport(report, context).row;

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("ingest_render_validate_report_is_project_parameterized()", () => {
    const report = renderValidateReportFixture();
    const rowA = ingestRenderValidateReport(report, projectContext({ projectId: "project-A" })).row;
    const rowB = ingestRenderValidateReport(report, projectContext({ projectId: "project-B" })).row;

    expect(rowA.captureRowId).not.toBe(rowB.captureRowId);
  });

  it("ingest_render_validate_report_rejects_wrong_schema_version()", () => {
    const report = renderValidateReportFixture({ schemaVersion: "0.2.0" as "0.1.0" });
    expect(() => ingestRenderValidateReport(report, projectContext())).toThrow(
      FrameCaptureValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism + ordering invariants (cross-check)
// ---------------------------------------------------------------------------

describe("annotation target ordering + determinism", () => {
  it("annotation_target_order_is_scene_then_frame_then_lines_and_stable_across_ingests()", () => {
    const report = renderValidateReportFixture({ renderedLineCount: 2 });
    const context = projectContext();

    const first = ingestRenderValidateReport(report, context).row;
    const second = ingestRenderValidateReport(report, context).row;

    const expectedOrder: FrameCaptureRow["annotationTargets"][number]["targetKind"][] = [
      "scene",
      "frame",
      "line",
      "line",
    ];
    expect(first.annotationTargets.map((target) => target.targetKind)).toEqual(expectedOrder);
    expect(second.annotationTargets.map((target) => target.targetId)).toEqual(
      first.annotationTargets.map((target) => target.targetId),
    );
  });

  it("annotation_target_kinds_are_within_the_closed_taxonomy()", () => {
    const { row } = ingestRenderValidateReport(renderValidateReportFixture(), projectContext());
    for (const target of row.annotationTargets) {
      expect(FRAME_CAPTURE_ANNOTATION_TARGET_KINDS).toContain(target.targetKind);
    }
  });
});

// ---------------------------------------------------------------------------
// Redaction (raw only in private scope; redacted variant for shared evidence)
// ---------------------------------------------------------------------------

describe("redactFrameCaptureRow", () => {
  it("redaction_excludes_managed_runtime_uri_and_content_hash()", () => {
    const raw = ingestFrameArtifact(frameArtifactFixture(), projectContext()).row;
    // Sanity: the raw private-scope row DOES carry the locator + hash.
    expect(raw.artifactRef.uri).toBe(ARTIFACT_URI);
    expect(raw.artifactHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(raw.redactionStatus).toBe("not_required");

    const redacted = redactFrameCaptureRow(raw);

    expect(redacted.artifactRef.uri).toBeNull();
    expect(redacted.artifactHash).toBeNull();
    expect(redacted.redactionStatus).toBe("redacted");
    expect(redacted.redactionRules).toEqual([...FRAME_CAPTURE_REDACTION_RULES]);
    expect(redacted.redactedFields).toEqual([...FRAME_CAPTURE_REDACTED_FIELDS]);
    // Identity + structural anchors survive so a future annotation UI still
    // has its addressable targets on the shared row.
    expect(redacted.captureRowId).toBe(raw.captureRowId);
    expect(redacted.projectId).toBe(raw.projectId);
    expect(redacted.bridgeUnitId).toBe(raw.bridgeUnitId);
    expect(redacted.annotationTargets).toEqual(raw.annotationTargets);
    // The artifactId survives (it's an identity ref, not a locator); only the
    // URI + hash are stripped.
    expect(redacted.artifactRef.artifactId).toBe(raw.artifactRef.artifactId);
    expect(redacted.artifactRef.artifactKind).toBe(raw.artifactRef.artifactKind);
  });

  it("redaction_is_deterministic_two_redactions_produce_identical_rows()", () => {
    const raw = ingestRenderValidateReport(renderValidateReportFixture(), projectContext()).row;

    const first = redactFrameCaptureRow(raw);
    const second = redactFrameCaptureRow(raw);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("assertRedactedFrameCaptureRow_accepts_a_properly_redacted_row()", () => {
    const redacted = redactFrameCaptureRow(
      ingestFrameArtifact(frameArtifactFixture(), projectContext()).row,
    );
    expect(() => assertRedactedFrameCaptureRow(redacted)).not.toThrow();
  });

  it("assertRedactedFrameCaptureRow_rejects_a_row_that_leaked_its_uri()", () => {
    const raw = ingestFrameArtifact(frameArtifactFixture(), projectContext()).row;
    // Forge a row that claims redacted but kept the URI.
    const leaking: FrameCaptureRow = {
      ...raw,
      redactionStatus: "redacted",
      artifactRef: { ...raw.artifactRef },
      artifactHash: null,
    };
    expect(() => assertRedactedFrameCaptureRow(leaking)).toThrow(
      /artifactRef.uri must be redacted/,
    );
  });

  it("assertRedactedFrameCaptureRow_rejects_a_row_that_leaked_its_hash()", () => {
    const raw = ingestFrameArtifact(frameArtifactFixture(), projectContext()).row;
    const leaking: FrameCaptureRow = {
      ...raw,
      redactionStatus: "redacted",
      artifactRef: { ...raw.artifactRef, uri: null },
    };
    expect(() => assertRedactedFrameCaptureRow(leaking)).toThrow(/artifactHash must be redacted/);
  });

  it("redacted_value_sentinel_is_non_empty_so_shape_stays_valid()", () => {
    expect(REDACTED_FRAME_CAPTURE_VALUE.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Evidence tier floor mirror
// ---------------------------------------------------------------------------

describe("evidence tier floor", () => {
  it("evidence_tier_floor_matches_utsushi_sink_floor_E2()", () => {
    expect(FRAME_EVIDENCE_TIER_FLOOR).toBe("E2");
  });
});
