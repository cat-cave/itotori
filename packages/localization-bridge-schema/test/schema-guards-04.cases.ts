import { describe, expect, it } from "vitest";
import {
  assertAssetPolicyBundleV02,
  assertPatchExportV02,
  evaluatePatchExportCompatibilityV02,
} from "../src/index.js";
import {
  bridgeV02Example,
  assetPolicyV02Example,
  bridgeV02Units,
  cloneRecord,
  patchExportV02Example,
  asTestRecord,
  assetPolicyDecisionById,
  assetPolicyAssetRevision,
} from "./schema-test-helpers.js";

describe("localization bridge schema guards", () => {
  it("accepts textless non-font asset policy decisions without fake source text", () => {
    const assetPolicy = assetPolicyV02Example();

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).not.toThrow();

    const uiArtDecision = assetPolicyDecisionById(
      assetPolicy,
      "019ed004-0000-7000-8000-000000000307",
    );
    const videoDecision = assetPolicyDecisionById(
      assetPolicy,
      "019ed004-0000-7000-8000-000000000308",
    );

    expect(uiArtDecision.assetSurfaceKind).toBe("ui_art");
    expect(uiArtDecision.textSourceKind).toBe("not_applicable");
    expect(uiArtDecision.sourceText).toBeUndefined();
    expect(videoDecision.assetSurfaceKind).toBe("video");
    expect(videoDecision.textSourceKind).toBe("not_applicable");
    expect(videoDecision.sourceText).toBeUndefined();
  });

  it("rejects asset policies without locale-branch scope", () => {
    const assetPolicy = assetPolicyV02Example();
    const localeBranch = asTestRecord(assetPolicy.localeBranch, "asset policy locale branch");
    delete localeBranch.localeBranchId;

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(/localeBranchId/);
  });

  it("rejects asset policy decisions with dangling asset refs", () => {
    const assetPolicy = assetPolicyV02Example();
    const decisions = assetPolicy.decisions as Array<Record<string, unknown>>;
    const firstDecision = asTestRecord(decisions[0], "first asset policy decision");
    const sourceAssetRef = asTestRecord(
      firstDecision.sourceAssetRef,
      "first asset policy source asset ref",
    );
    sourceAssetRef.assetId = "019ed004-0000-7000-8000-00000000ffff";

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(/sourceAssetRef\.assetId/);
  });

  it("rejects asset policy metadata-only records that imply visual runtime validation", () => {
    const assetPolicy = assetPolicyV02Example();
    const decisions = assetPolicy.decisions as Array<Record<string, unknown>>;
    const imageDecision = asTestRecord(decisions[0], "image asset policy decision");
    imageDecision.patchMode = "metadata_only";

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(/metadata_only.*metadata_only/);
  });

  it("rejects asset policy completion claims disguised as enum values", () => {
    const assetPolicy = assetPolicyV02Example();
    const decisions = assetPolicy.decisions as Array<Record<string, unknown>>;
    const uiArtDecision = asTestRecord(decisions[1], "ui art asset policy decision");
    uiArtDecision.textSourceKind = "ocr_complete";

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(/textSourceKind/);
  });

  // SHARED-018 — parameterize font-substitution wrong-kind patchRef coverage
  // across image, audio, and video patch asset kinds instead of exercising only
  // the image case. Each covered kind carries a positive fixture (the kind is
  // admitted in its own correct patch mode/surface) and a negative wrong-kind
  // fixture (a font_substitution_required patchRef pointing at that kind is
  // rejected). If validation is accidentally limited to image patch refs, the
  // audio and video negative rows fail loud.
  const FONT_SUBSTITUTION_WRONG_KIND_MATRIX = [
    {
      kind: "image",
      assetId: "019ed004-0000-7000-8000-000000000101",
      positiveDecisionId: "019ed004-0000-7000-8000-000000000301",
    },
    {
      kind: "audio",
      assetId: "019ed004-0000-7000-8000-000000000103",
      positiveDecisionId: "019ed004-0000-7000-8000-000000000303",
    },
    {
      kind: "video",
      assetId: "019ed004-0000-7000-8000-000000000106",
      positiveDecisionId: "019ed004-0000-7000-8000-000000000306",
    },
  ] as const;

  it.each(FONT_SUBSTITUTION_WRONG_KIND_MATRIX)(
    "SHARED-018 admits $kind patch refs in their correct patch mode (positive fixture)",
    ({ kind, assetId, positiveDecisionId }) => {
      const assetPolicy = assetPolicyV02Example();
      const decision = assetPolicyDecisionById(assetPolicy, positiveDecisionId);
      const patchRef = asTestRecord(decision.patchRef, `${kind} positive patch ref`);
      expect(patchRef.assetId).toBe(assetId);

      expect(() => assertAssetPolicyBundleV02(assetPolicy)).not.toThrow();
    },
  );

  it.each(FONT_SUBSTITUTION_WRONG_KIND_MATRIX)(
    "SHARED-018 rejects font_substitution_required patchRefs that point at $kind assets (wrong-kind fixture)",
    ({ kind, assetId }) => {
      const assetPolicy = assetPolicyV02Example();
      const fontDecision = assetPolicyDecisionById(
        assetPolicy,
        "019ed004-0000-7000-8000-000000000304",
      );
      const patchRef = asTestRecord(fontDecision.patchRef, "font asset policy patch ref");
      patchRef.assetId = assetId;
      patchRef.sourceRevision = assetPolicyAssetRevision(assetPolicy, assetId);

      expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(
        new RegExp(`patchRef\\.assetId assetKind ${kind}.*font_substitution_required`),
      );
    },
  );

  it("SHARED-018 admits font_substitution_required patchRefs that point at font assets (positive fixture)", () => {
    const assetPolicy = assetPolicyV02Example();
    const fontDecision = assetPolicyDecisionById(
      assetPolicy,
      "019ed004-0000-7000-8000-000000000304",
    );
    const patchRef = asTestRecord(fontDecision.patchRef, "font asset policy patch ref");
    expect(patchRef.assetId).toBe("019ed004-0000-7000-8000-000000000104");

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).not.toThrow();
  });

  it("rejects asset replacement patch refs outside the asset policy surface kind", () => {
    const assetPolicy = assetPolicyV02Example();
    const uiArtDecision = assetPolicyDecisionById(
      assetPolicy,
      "019ed004-0000-7000-8000-000000000307",
    );
    const patchRef = asTestRecord(uiArtDecision.patchRef, "textless ui art patch ref");
    const audioAssetId = "019ed004-0000-7000-8000-000000000103";
    patchRef.assetId = audioAssetId;
    patchRef.sourceRevision = assetPolicyAssetRevision(assetPolicy, audioAssetId);

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(
      /patchRef\.assetId assetKind audio.*asset_replacement_required.*ui_art/,
    );
  });

  it("accepts v0.2 patch exports with explicit source compatibility metadata", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);

    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
  });

  it("accepts reordered target mappings for distinct protected spans", () => {
    const bridge = bridgeV02Example();
    const unit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    unit.sourceText = "{item} for {player}";
    unit.spans = [
      {
        spanId: "019ed001-0000-7000-8000-000000000831",
        spanKind: "variable_placeholder",
        raw: "{item}",
        startByte: 0,
        endByte: 6,
        preserveMode: "map",
        variableName: "item",
      },
      {
        spanId: "019ed001-0000-7000-8000-000000000832",
        spanKind: "variable_placeholder",
        raw: "{player}",
        startByte: 11,
        endByte: 19,
        preserveMode: "map",
        variableName: "player",
      },
    ];
    const patchExport = patchExportV02Example(bridge, 1);
    const entry = asTestRecord(
      (patchExport.entries as Array<Record<string, unknown>>)[0],
      "first v0.2 patch export entry",
    );
    entry.targetText = "{player} gets {item}";
    entry.protectedSpanMappings = [
      {
        raw: "{player}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000832",
        sourceStartByte: 11,
        sourceEndByte: 19,
        targetStart: 0,
        targetEnd: 8,
      },
      {
        raw: "{item}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000831",
        sourceStartByte: 0,
        sourceEndByte: 6,
        targetStart: 14,
        targetEnd: 20,
      },
    ];

    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
    expect(report.status).toBe("compatible");
  });

  it("accepts duplicate raw protected spans when source identities and target ranges are explicit", () => {
    const bridge = bridgeV02Example();
    const unit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    unit.sourceText = "{name} meets {name}";
    unit.spans = [
      {
        spanId: "019ed001-0000-7000-8000-000000000841",
        spanKind: "variable_placeholder",
        raw: "{name}",
        startByte: 0,
        endByte: 6,
        preserveMode: "map",
        variableName: "name",
      },
      {
        spanId: "019ed001-0000-7000-8000-000000000842",
        spanKind: "variable_placeholder",
        raw: "{name}",
        startByte: 13,
        endByte: 19,
        preserveMode: "map",
        variableName: "name",
      },
    ];
    const patchExport = patchExportV02Example(bridge, 1);
    const entry = asTestRecord(
      (patchExport.entries as Array<Record<string, unknown>>)[0],
      "first v0.2 patch export entry",
    );
    entry.targetText = "{name} and {name}";
    entry.protectedSpanMappings = [
      {
        raw: "{name}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000842",
        sourceStartByte: 13,
        sourceEndByte: 19,
        targetStart: 0,
        targetEnd: 6,
      },
      {
        raw: "{name}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000841",
        sourceStartByte: 0,
        sourceEndByte: 6,
        targetStart: 11,
        targetEnd: 17,
      },
    ];

    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
    expect(report.status).toBe("compatible");

    const noIdentityPatchExport = cloneRecord(patchExport);
    const noIdentityEntry = asTestRecord(
      (noIdentityPatchExport.entries as Array<Record<string, unknown>>)[0],
      "first no-identity v0.2 patch export entry",
    );
    noIdentityEntry.protectedSpanMappings = [
      { raw: "{name}", targetStart: 0, targetEnd: 6 },
      { raw: "{name}", targetStart: 11, targetEnd: 17 },
    ];

    expect(() => assertPatchExportV02(noIdentityPatchExport)).not.toThrow();
    expect(evaluatePatchExportCompatibilityV02(noIdentityPatchExport, bridge).status).toBe(
      "incompatible",
    );
  });

  it("rejects duplicate source-identity protected spans (strict v0.2 identity)", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge, 1);
    const entry = asTestRecord(
      (patchExport.entries as Array<Record<string, unknown>>)[0],
      "first v0.2 patch export entry",
    );
    // Two mappings reusing the SAME sourceSpanId is an identity collision.
    entry.protectedSpanMappings = [
      {
        raw: "{name}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000861",
        sourceStartByte: 0,
        sourceEndByte: 6,
        targetStart: 0,
        targetEnd: 6,
      },
      {
        raw: "{other}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000861",
        sourceStartByte: 9,
        sourceEndByte: 16,
        targetStart: 11,
        targetEnd: 18,
      },
    ];

    expect(() => assertPatchExportV02(patchExport)).toThrow(
      /kaifuu\.patch_export\.duplicate_source_span_identity/,
    );
  });

  it.each(["sourceStartByte", "sourceEndByte"] as const)(
    "rejects an incomplete optional source-coordinate pair missing %s",
    (missingField) => {
      const bridge = bridgeV02Example();
      const patchExport = patchExportV02Example(bridge, 1);
      const entry = asTestRecord(
        (patchExport.entries as Array<Record<string, unknown>>)[0],
        "first v0.2 patch export entry",
      );
      const mappings = entry.protectedSpanMappings;
      if (!Array.isArray(mappings)) throw new Error("test fixture mappings must be an array");
      const mapping = asTestRecord(mappings[0], "first v0.2 protected-span mapping");
      delete mapping[missingField];

      expect(() => assertPatchExportV02(patchExport)).toThrow(new RegExp(missingField));
    },
  );

  it("accepts raw-only v0.2 protected-span mappings when their raw text is unambiguous", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge, 1);
    const entry = asTestRecord(
      (patchExport.entries as Array<Record<string, unknown>>)[0],
      "first v0.2 patch export entry",
    );
    entry.protectedSpanMappings = [{ raw: "{player}", targetStart: 9, targetEnd: 17 }];

    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
    expect(evaluatePatchExportCompatibilityV02(patchExport, bridge).status).toBe("compatible");
  });

  it("reports protected span mapping mismatches for wrong source identity or collapsed duplicates", () => {
    const bridge = bridgeV02Example();
    const unit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    unit.sourceText = "{name} meets {name}";
    unit.spans = [
      {
        spanId: "019ed001-0000-7000-8000-000000000851",
        spanKind: "variable_placeholder",
        raw: "{name}",
        startByte: 0,
        endByte: 6,
        preserveMode: "map",
        variableName: "name",
      },
      {
        spanId: "019ed001-0000-7000-8000-000000000852",
        spanKind: "variable_placeholder",
        raw: "{name}",
        startByte: 13,
        endByte: 19,
        preserveMode: "map",
        variableName: "name",
      },
    ];
    const patchExport = patchExportV02Example(bridge, 1);
    const entry = asTestRecord(
      (patchExport.entries as Array<Record<string, unknown>>)[0],
      "first v0.2 patch export entry",
    );
    entry.targetText = "{name} and {name}";
    // Both mappings resolve to the same source span through optional source
    // byte coordinates. The schema accepts the paired coordinates, then the
    // compatibility evaluator rejects the collapsed source identity.
    entry.protectedSpanMappings = [
      {
        raw: "{name}",
        sourceStartByte: 0,
        sourceEndByte: 6,
        targetStart: 0,
        targetEnd: 6,
      },
      {
        raw: "{name}",
        sourceStartByte: 0,
        sourceEndByte: 6,
        targetStart: 11,
        targetEnd: 17,
      },
    ];

    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(report.status).toBe("incompatible");
    expect(report.incompatibleUnits).toEqual([
      expect.objectContaining({ reason: "protected_span_mapping_mismatch" }),
    ]);
  });
});
