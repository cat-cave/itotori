import {
  ASSET_TEXT_DRAFT_SCHEMA_VERSION,
  assertAssetExportOutcome,
  assertAssetQaFinding,
  assertAssetTextDraft,
  isAssetPatchRefusal,
} from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";
import {
  buildAssetExportOutcome,
  buildAssetReviewItem,
  decideAssetReview,
  draftAssetTexts,
  isBlockingAssetFinding,
  runAssetDraftQa,
} from "../src/asset-localization/index.js";
import {
  fixtureTranslateFn,
  inventoryOnlyCapabilityFixture,
  keyAbsentCapabilityFixture,
  supportedEngineCapabilityFixture,
  titleCardOcrDocumentFixture,
  unsupportedEngineCapabilityFixture,
} from "../src/asset-localization/index.js";

const NOW = () => new Date("2026-07-05T00:00:00Z");
const USER = "user-reviewer";

describe("asset-localization loop — draft stage", () => {
  it("drafts asset text from OCR regions carrying asset provenance", () => {
    const doc = titleCardOcrDocumentFixture();
    const drafts = draftAssetTexts(doc, "translate_text", fixtureTranslateFn());

    expect(drafts).toHaveLength(2);
    const [newDraft, loadDraft] = drafts;

    // Parallels a dialogue draft (source→draft text + hashes) but is keyed by
    // asset provenance (asset ref + region + pixel bounds), not a source unit.
    expect(newDraft.schemaVersion).toBe(ASSET_TEXT_DRAFT_SCHEMA_VERSION);
    expect(newDraft.sourceText).toBe("NEW");
    expect(newDraft.draftText).toBe("NUEVO");
    expect(newDraft.provenance.assetRef).toBe("bridgeAssetRef:title-card.png");
    expect(newDraft.provenance.regionId).toBe("region-0001");
    expect(newDraft.provenance.assetName).toBe("title-card.png");
    expect(newDraft.provenance.region).toEqual({ x: 3, y: 3, width: 17, height: 7 });
    expect(newDraft.provenance.sourceUncertain).toBe(false);
    expect(newDraft.provenance.ocrSourceNodeId).toBe("KAIFUU-026");
    expect(newDraft.draftUnitHash).toMatch(/^sha256:/);

    // The uncertain region still drafts (candidate is evidence, not truth).
    expect(loadDraft.sourceText).toBe("LOAD");
    expect(loadDraft.provenance.sourceUncertain).toBe(true);
    expect(loadDraft.provenance.ocrConfidence).toBe("medium");

    for (const draft of drafts) {
      expect(() => assertAssetTextDraft(draft)).not.toThrow();
    }
  });
});

describe("asset-localization loop — QA stage", () => {
  it("flags an uncertain OCR source as a major finding", () => {
    const doc = titleCardOcrDocumentFixture();
    const [, loadDraft] = draftAssetTexts(doc, "translate_text", fixtureTranslateFn());
    const findings = runAssetDraftQa(loadDraft);

    const uncertain = findings.find((f) => f.category === "uncertain-ocr-source");
    expect(uncertain).toBeDefined();
    expect(uncertain?.severity).toBe("major");
    expect(uncertain?.regionId).toBe("region-0004");
    for (const finding of findings) {
      expect(() => assertAssetQaFinding(finding)).not.toThrow();
    }
  });

  it("flags an empty draft as a blocking (critical) finding", () => {
    const doc = titleCardOcrDocumentFixture();
    const [newDraft] = draftAssetTexts(doc, "translate_text", fixtureTranslateFn({ NEW: "" }));
    const findings = runAssetDraftQa(newDraft);

    const empty = findings.find((f) => f.category === "empty-draft");
    expect(empty?.severity).toBe("critical");
    expect(findings.some(isBlockingAssetFinding)).toBe(true);
  });

  it("flags a layout-risk when the target overflows the fixed region width", () => {
    const doc = titleCardOcrDocumentFixture();
    const [newDraft] = draftAssetTexts(
      doc,
      "translate_text",
      fixtureTranslateFn({ NEW: "COMENZAR PARTIDA NUEVA" }),
    );
    const findings = runAssetDraftQa(newDraft);
    expect(findings.some((f) => f.category === "layout-risk")).toBe(true);
  });

  it("produces no findings for a clean, certain, within-width translated region", () => {
    const doc = titleCardOcrDocumentFixture();
    // "NEU" (3 chars) is certain, translated, and within the region width.
    const [newDraft] = draftAssetTexts(doc, "translate_text", fixtureTranslateFn({ NEW: "NEU" }));
    expect(runAssetDraftQa(newDraft)).toHaveLength(0);
  });
});

describe("asset-localization loop — review + export (happy path)", () => {
  it("drafts → QA's → reviews (approve) → exports a patch payload for a supported engine", () => {
    const doc = titleCardOcrDocumentFixture();
    const [newDraft] = draftAssetTexts(doc, "translate_text", fixtureTranslateFn());
    const findings = runAssetDraftQa(newDraft);

    const item = buildAssetReviewItem(newDraft, findings);
    expect(item.reviewItemRef).toBe(newDraft.draftId);
    expect(item.recommendedAction).toBe("approve");
    expect(item.provenance.regionId).toBe("region-0001");

    const decision = decideAssetReview(item, "approve", USER, { now: NOW });
    expect(decision.state).toBe("accepted");

    const outcome = buildAssetExportOutcome(
      newDraft,
      decision,
      findings,
      supportedEngineCapabilityFixture(),
    );
    expect(outcome.kind).toBe("patch");
    if (outcome.kind === "patch") {
      expect(outcome.draftText).toBe("NUEVO");
      expect(outcome.patchBackMode).toBe("re_encrypt_same_key");
      expect(outcome.provenance.assetRef).toBe("bridgeAssetRef:title-card.png");
    }
    expect(() => assertAssetExportOutcome(outcome)).not.toThrow();
  });
});

describe("asset-localization loop — unsupported patching stays EXPLICIT", () => {
  it("refuses (typed) when the engine cannot patch — never a silent drop", () => {
    const doc = titleCardOcrDocumentFixture();
    const [newDraft] = draftAssetTexts(doc, "translate_text", fixtureTranslateFn());
    const decision = decideAssetReview(buildAssetReviewItem(newDraft, []), "approve", USER, {
      now: NOW,
    });

    const outcome = buildAssetExportOutcome(
      newDraft,
      decision,
      [],
      unsupportedEngineCapabilityFixture(),
    );
    expect(isAssetPatchRefusal(outcome)).toBe(true);
    if (isAssetPatchRefusal(outcome)) {
      expect(outcome.reason).toBe("unsupported_engine");
      expect(outcome.detail).toContain("siglus");
      expect(outcome.assetRef).toBe("bridgeAssetRef:title-card.png");
      expect(outcome.regionId).toBe("region-0001");
    }
    expect(() => assertAssetExportOutcome(outcome)).not.toThrow();
  });

  it("refuses inventory-only assets (does not pretend every asset is editable)", () => {
    const doc = titleCardOcrDocumentFixture();
    const [newDraft] = draftAssetTexts(doc, "translate_text", fixtureTranslateFn());
    const decision = decideAssetReview(buildAssetReviewItem(newDraft, []), "approve", USER, {
      now: NOW,
    });
    const outcome = buildAssetExportOutcome(
      newDraft,
      decision,
      [],
      inventoryOnlyCapabilityFixture(),
    );
    expect(isAssetPatchRefusal(outcome) && outcome.reason).toBe("inventory_only");
  });

  it("refuses when the encrypted-media key is absent", () => {
    const doc = titleCardOcrDocumentFixture();
    const [newDraft] = draftAssetTexts(doc, "translate_text", fixtureTranslateFn());
    const decision = decideAssetReview(buildAssetReviewItem(newDraft, []), "approve", USER, {
      now: NOW,
    });
    const outcome = buildAssetExportOutcome(newDraft, decision, [], keyAbsentCapabilityFixture());
    expect(isAssetPatchRefusal(outcome) && outcome.reason).toBe("key_absent");
  });

  it("refuses when the reviewer rejected the draft", () => {
    const doc = titleCardOcrDocumentFixture();
    const [newDraft] = draftAssetTexts(doc, "translate_text", fixtureTranslateFn());
    const decision = decideAssetReview(buildAssetReviewItem(newDraft, []), "reject", USER, {
      now: NOW,
      rationale: "wrong glyphs",
    });
    const outcome = buildAssetExportOutcome(
      newDraft,
      decision,
      [],
      supportedEngineCapabilityFixture(),
    );
    expect(isAssetPatchRefusal(outcome) && outcome.reason).toBe("draft_rejected");
  });

  it("refuses (qa_blocked) when a blocking QA finding is still open on approval", () => {
    const doc = titleCardOcrDocumentFixture();
    const [newDraft] = draftAssetTexts(doc, "translate_text", fixtureTranslateFn({ NEW: "  " }));
    const findings = runAssetDraftQa(newDraft);
    const item = buildAssetReviewItem(newDraft, findings);
    expect(item.recommendedAction).toBe("revise");
    // Reviewer force-approves despite the blocking finding; export still refuses.
    const decision = decideAssetReview(item, "approve", USER, { now: NOW });
    const outcome = buildAssetExportOutcome(
      newDraft,
      decision,
      findings,
      supportedEngineCapabilityFixture(),
    );
    expect(isAssetPatchRefusal(outcome) && outcome.reason).toBe("qa_blocked");
  });
});
