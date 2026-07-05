// SHARED-020 — surface-identity + protected-span preservation through
// normalization.
//
// These fixtures run bridge text with EXPANDED surface kinds + PROTECTED SPANS
// through the shared normalization and assert that the surface kind is NOT
// collapsed into generic dialogue and that every protected span keeps its
// offset (startByte/endByte), identity (spanId), and semantic meaning
// (spanKind + preserveMode + raw bytes). The mutation cases prove the
// contract validator would CATCH a collapse or a corrupted span.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertBridgeBundleV02,
  assertNormalizedSurfacePreservesIdentity,
  LEGACY_TEXT_SURFACE_TO_SURFACE_KIND,
  normalizeBridgeSurface,
  normalizedProtectedSpanRaws,
  SurfaceNormalizationIdentityError,
  type BridgeBundleV02,
  type BridgeUnit,
  type LocalizationUnitV02,
  type NormalizedBridgeSurface,
  type SurfaceKindV02,
} from "../src/index.js";

function loadBridgeV02(): BridgeBundleV02 {
  const path = fileURLToPath(new URL("./examples/bridge-v0.2.json", import.meta.url));
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertBridgeBundleV02(value);
  return value;
}

describe("SHARED-020 surface-identity preserving normalization (v0.2 expanded kinds)", () => {
  const bundle = loadBridgeV02();

  it("normalizes every expanded surface kind WITHOUT collapsing it to dialogue", () => {
    // The real fixture bundle carries all ten expanded surface kinds.
    const observedKinds = new Set<SurfaceKindV02>();
    for (const unit of bundle.units) {
      const normalized = normalizeBridgeSurface(unit);
      // The expanded kind survives verbatim.
      expect(normalized.surfaceKind).toBe(unit.surfaceKind);
      observedKinds.add(unit.surfaceKind);
      // A non-dialogue surface is NEVER reduced to generic dialogue.
      if (unit.surfaceKind !== "dialogue") {
        expect(normalized.surfaceKind).not.toBe("dialogue");
      }
      // The canonical form round-trips through the strict validator.
      expect(() => assertNormalizedSurfacePreservesIdentity(unit, normalized)).not.toThrow();
    }
    // Guard: the fixture actually exercises the non-dialogue kinds we care about.
    for (const kind of [
      "choice_label",
      "speaker_name",
      "ui_label",
      "tutorial_text",
      "database_entry",
      "song_title",
      "image_text",
      "metadata_text",
      "narration",
    ] as const) {
      expect(observedKinds.has(kind)).toBe(true);
    }
  });

  it("preserves each protected span's offset, identity, and semantic meaning", () => {
    const unitsWithSpans = bundle.units.filter((unit) => unit.spans.length > 0);
    expect(unitsWithSpans.length).toBeGreaterThan(0);
    for (const unit of unitsWithSpans) {
      const normalized = normalizeBridgeSurface(unit);
      expect(normalized.protectedSpans).toHaveLength(unit.spans.length);
      unit.spans.forEach((span, index) => {
        const normalizedSpan = normalized.protectedSpans[index]!;
        expect(normalizedSpan.spanId).toBe(span.spanId);
        expect(normalizedSpan.spanKind).toBe(span.spanKind);
        expect(normalizedSpan.preserveMode).toBe(span.preserveMode);
        expect(normalizedSpan.startByte).toBe(span.startByte);
        expect(normalizedSpan.endByte).toBe(span.endByte);
        expect(normalizedSpan.raw).toBe(span.raw);
        // Semantic meaning survives: raw still sits at its declared byte offset.
        const sourceBytes = Buffer.from(unit.sourceText, "utf8");
        expect(
          sourceBytes.subarray(normalizedSpan.startByte, normalizedSpan.endByte).toString("utf8"),
        ).toBe(span.raw);
      });
    }
  });
});

// A minimal, fully-typed v0.2 unit builder so span-kind variety
// (control_markup / ruby_annotation) can be exercised directly.
function makeV02Unit(overrides: {
  surfaceKind: SurfaceKindV02;
  sourceText: string;
  spans: LocalizationUnitV02["spans"];
}): LocalizationUnitV02 {
  return {
    bridgeUnitId: "019ed001-0000-7000-8000-0000000009a1",
    surfaceId: "019ed001-0000-7000-8000-0000000009b1",
    surfaceKind: overrides.surfaceKind,
    sourceUnitKey: "script/synthetic#line-001",
    occurrenceId: "synthetic-001",
    sourceLocale: "ja-JP",
    sourceText: overrides.sourceText,
    sourceHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    sourceRevision: {
      revisionId: "019ed001-0000-7000-8000-0000000009c1",
      revisionKind: "content_hash",
      value: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    },
    sourceAssetRef: {
      assetId: "019ed001-0000-7000-8000-0000000009d1",
      assetKey: "script/synthetic",
    },
    sourceLocation: {
      containerKey: "script/synthetic",
      entryPath: ["commands", "0"],
      range: { startByte: 0, endByte: Buffer.from(overrides.sourceText, "utf8").length },
    },
    context: {},
    spans: overrides.spans,
    patchRef: {
      assetId: "019ed001-0000-7000-8000-0000000009d1",
      writeMode: "replace",
      sourceUnitKey: "script/synthetic#line-001",
      sourceRevision: {
        revisionId: "019ed001-0000-7000-8000-0000000009c1",
        revisionKind: "content_hash",
        value: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      },
    },
    runtimeExpectation: { expectationKind: "trace_text", traceKey: "synthetic-001" },
  };
}

describe("SHARED-020 protected-span semantics survive across span kinds", () => {
  // sourceText: "選ぶ<clear>るび" — a control_markup span + a ruby_annotation span.
  const sourceText = "選ぶ<clear>るび";
  const bytes = (s: string): number => Buffer.from(s, "utf8").length;
  const clearStart = bytes("選ぶ");
  const clearEnd = clearStart + bytes("<clear>");
  const rubyStart = clearEnd;
  const rubyEnd = rubyStart + bytes("るび");

  const unit = makeV02Unit({
    surfaceKind: "choice_label",
    sourceText,
    spans: [
      {
        spanId: "019ed001-0000-7000-8000-000000000f01",
        spanKind: "control_markup",
        raw: "<clear>",
        startByte: clearStart,
        endByte: clearEnd,
        preserveMode: "exact",
        parsedName: "clear",
      },
      {
        spanId: "019ed001-0000-7000-8000-000000000f02",
        spanKind: "ruby_annotation",
        raw: "るび",
        startByte: rubyStart,
        endByte: rubyEnd,
        preserveMode: "map",
        baseStartByte: rubyStart,
        baseEndByte: rubyEnd,
        annotationStartByte: rubyStart,
        annotationEndByte: rubyEnd,
        annotationText: "ruby",
      },
    ],
  });

  it("keeps the choice_label surface + both span kinds intact", () => {
    const normalized = normalizeBridgeSurface(unit);
    expect(normalized.surfaceKind).toBe("choice_label");
    expect(normalizedProtectedSpanRaws(normalized)).toEqual(["<clear>", "るび"]);
    expect(normalized.protectedSpans.map((s) => s.spanKind)).toEqual([
      "control_markup",
      "ruby_annotation",
    ]);
    expect(() => assertNormalizedSurfacePreservesIdentity(unit, normalized)).not.toThrow();
  });

  // --- Mutation cases: the validator must CATCH collapse / corruption. ---

  it("catches a collapsed surface kind (choice_label -> dialogue)", () => {
    const normalized = normalizeBridgeSurface(unit);
    const collapsed: NormalizedBridgeSurface = { ...normalized, surfaceKind: "dialogue" };
    expect(() => assertNormalizedSurfacePreservesIdentity(unit, collapsed)).toThrow(
      SurfaceNormalizationIdentityError,
    );
    expect(() => assertNormalizedSurfacePreservesIdentity(unit, collapsed)).toThrow(/collapsed/);
  });

  it("catches a shifted protected-span offset", () => {
    const normalized = normalizeBridgeSurface(unit);
    const corrupted: NormalizedBridgeSurface = {
      ...normalized,
      protectedSpans: normalized.protectedSpans.map((span, index) =>
        index === 0 ? { ...span, startByte: span.startByte + 1, endByte: span.endByte + 1 } : span,
      ),
    };
    expect(() => assertNormalizedSurfacePreservesIdentity(unit, corrupted)).toThrow(
      /offset shifted/,
    );
  });

  it("catches a mutated protected-span identity", () => {
    const normalized = normalizeBridgeSurface(unit);
    const corrupted: NormalizedBridgeSurface = {
      ...normalized,
      protectedSpans: normalized.protectedSpans.map((span, index) =>
        index === 0 ? { ...span, spanId: "019ed001-0000-7000-8000-0000000000ff" } : span,
      ),
    };
    expect(() => assertNormalizedSurfacePreservesIdentity(unit, corrupted)).toThrow(
      /identity changed/,
    );
  });

  it("catches a mutated protected-span semantic kind", () => {
    const normalized = normalizeBridgeSurface(unit);
    const corrupted: NormalizedBridgeSurface = {
      ...normalized,
      protectedSpans: normalized.protectedSpans.map((span, index) =>
        index === 0 ? { ...span, spanKind: "variable_placeholder" as const } : span,
      ),
    };
    expect(() => assertNormalizedSurfacePreservesIdentity(unit, corrupted)).toThrow(
      /semantics changed/,
    );
  });

  it("catches a dropped protected span", () => {
    const normalized = normalizeBridgeSurface(unit);
    const corrupted: NormalizedBridgeSurface = {
      ...normalized,
      protectedSpans: normalized.protectedSpans.slice(0, 1),
    };
    expect(() => assertNormalizedSurfacePreservesIdentity(unit, corrupted)).toThrow(
      /count changed/,
    );
  });
});

describe("SHARED-020 legacy v0.1 surfaces widen deterministically, never collapse", () => {
  const legacyUnit: BridgeUnit = {
    bridgeUnitId: "019ed001-0000-7000-8000-000000000a01",
    sourceUnitKey: "script/legacy#line-001",
    occurrenceId: "legacy-001",
    sourceHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    sourceLocale: "ja-JP",
    sourceText: "設定{value}を保存",
    textSurface: "system",
    protectedSpans: [
      {
        kind: "variable_placeholder",
        raw: "{value}",
        start: Buffer.from("設定", "utf8").length,
        end: Buffer.from("設定", "utf8").length + Buffer.from("{value}", "utf8").length,
        preserveMode: "map",
        variableName: "value",
      },
    ],
    patchRef: {
      assetId: "asset-legacy",
      writeMode: "replace",
      sourceUnitKey: "script/legacy#line-001",
    },
  };

  it("widens 'system' to 'metadata_text' (NOT dialogue) and preserves the span", () => {
    const normalized = normalizeBridgeSurface(legacyUnit);
    expect(LEGACY_TEXT_SURFACE_TO_SURFACE_KIND.system).toBe("metadata_text");
    expect(normalized.surfaceKind).toBe("metadata_text");
    expect(normalized.surfaceKind).not.toBe("dialogue");
    const span = normalized.protectedSpans[0]!;
    expect(span.spanKind).toBe("variable_placeholder");
    expect(span.preserveMode).toBe("map");
    expect(span.raw).toBe("{value}");
    expect(span.startByte).toBe(legacyUnit.protectedSpans[0]!.start);
    expect(span.endByte).toBe(legacyUnit.protectedSpans[0]!.end);
    expect(() => assertNormalizedSurfacePreservesIdentity(legacyUnit, normalized)).not.toThrow();
  });

  it("synthesizes a stable span identity for legacy spans (deterministic)", () => {
    const first = normalizeBridgeSurface(legacyUnit);
    const second = normalizeBridgeSurface(legacyUnit);
    expect(first.protectedSpans[0]!.spanId).toBe(second.protectedSpans[0]!.spanId);
    expect(first.protectedSpans[0]!.spanId).toContain(legacyUnit.bridgeUnitId);
  });
});
