// ITOTORI-017 — Patch-safety enumeration test.
//
// The hidden-identity preservation invariant has TWO halves:
//   1. The agent refuses to emit a `named` label for a hidden character
//      (covered in speaker-label-agent.test.ts).
//   2. When a label DOES carry an internal-tracking field, that field
//      MUST be stripped before the label rides the patch export.
//
// This test enumerates every SpeakerIdentity variant, runs each through
// `prepareSpeakerLabelForPatchExport`, and asserts:
//   - the returned object has the same kind discriminator;
//   - the returned object's JSON serialization does NOT contain the
//     string "internalCharacterId" — regardless of the variant, and
//     regardless of whether the internal id was populated on input;
//   - the named / unknown_to_parser / narration variants pass through
//     unchanged.
//
// We rely on string-search on the JSON because that's what an auditor
// would do: a stray internalCharacterId anywhere in the serialized
// payload is a leak.

import { describe, expect, it } from "vitest";
import {
  prepareSpeakerLabelForPatchExport,
  type SpeakerLabel,
} from "../src/agents/speaker-label/index.js";

function baseLabel(overrides: Partial<SpeakerLabel> = {}): SpeakerLabel {
  return {
    bridgeUnitId: "019ed079-0000-7000-8000-00000000a001",
    speakerId: { kind: "narration" },
    confidence: "high",
    evidenceRefs: ["scene-summary:scene-001"],
    agentRationale: "Default.",
    ...overrides,
  };
}

function variants(): { name: string; label: SpeakerLabel }[] {
  return [
    {
      name: "named",
      label: baseLabel({
        speakerId: {
          kind: "named",
          characterId: "char-yusha",
          displayName: "Hero",
        },
      }),
    },
    {
      name: "unknown_to_reader without internalCharacterId",
      label: baseLabel({
        speakerId: {
          kind: "unknown_to_reader",
          maskedCharacterId: "masked-001",
          maskedDisplayName: "??? (cloaked figure)",
        },
      }),
    },
    {
      name: "unknown_to_reader WITH internalCharacterId (the leak case)",
      label: baseLabel({
        speakerId: {
          kind: "unknown_to_reader",
          maskedCharacterId: "masked-001",
          maskedDisplayName: "??? (cloaked figure)",
          internalCharacterId: "char-maou",
        },
      }),
    },
    {
      name: "unknown_to_parser",
      label: baseLabel({
        speakerId: { kind: "unknown_to_parser", reason: "conflicting_signals" },
      }),
    },
    {
      name: "narration",
      label: baseLabel({ speakerId: { kind: "narration" } }),
    },
  ];
}

describe("prepareSpeakerLabelForPatchExport — variant enumeration", () => {
  it.each(variants())("strips internalCharacterId for $name", ({ label }) => {
    const publicLabel = prepareSpeakerLabelForPatchExport(label);
    const serialized = JSON.stringify(publicLabel);
    expect(serialized).not.toContain("internalCharacterId");
    // The kind discriminator survives.
    expect(publicLabel.speakerId.kind).toBe(label.speakerId.kind);
  });

  it("preserves all non-private fields for a `named` identity", () => {
    const label = baseLabel({
      speakerId: { kind: "named", characterId: "char-yusha", displayName: "Hero" },
    });
    const publicLabel = prepareSpeakerLabelForPatchExport(label);
    expect(publicLabel.speakerId).toEqual({
      kind: "named",
      characterId: "char-yusha",
      displayName: "Hero",
    });
    expect(publicLabel.bridgeUnitId).toBe(label.bridgeUnitId);
    expect(publicLabel.confidence).toBe(label.confidence);
    expect(publicLabel.evidenceRefs).toEqual(label.evidenceRefs);
    expect(publicLabel.agentRationale).toBe(label.agentRationale);
  });

  it("retains the masked id and masked display name on unknown_to_reader (the reader-visible fields are NOT stripped)", () => {
    const label = baseLabel({
      speakerId: {
        kind: "unknown_to_reader",
        maskedCharacterId: "masked-001",
        maskedDisplayName: "??? (cloaked figure)",
        internalCharacterId: "char-maou",
      },
    });
    const publicLabel = prepareSpeakerLabelForPatchExport(label);
    expect(publicLabel.speakerId).toEqual({
      kind: "unknown_to_reader",
      maskedCharacterId: "masked-001",
      maskedDisplayName: "??? (cloaked figure)",
    });
    const serialized = JSON.stringify(publicLabel);
    expect(serialized).toContain("masked-001");
    expect(serialized).not.toContain("char-maou");
  });

  it("preserves unknown_to_parser reasons verbatim", () => {
    const label = baseLabel({
      speakerId: { kind: "unknown_to_parser", reason: "ambient_dialogue" },
    });
    const publicLabel = prepareSpeakerLabelForPatchExport(label);
    expect(publicLabel.speakerId).toEqual({
      kind: "unknown_to_parser",
      reason: "ambient_dialogue",
    });
  });

  it("collapses narration to the bare discriminator", () => {
    const label = baseLabel({ speakerId: { kind: "narration" } });
    const publicLabel = prepareSpeakerLabelForPatchExport(label);
    expect(publicLabel.speakerId).toEqual({ kind: "narration" });
  });

  it("does not retain references to mutable input arrays (evidenceRefs is copied)", () => {
    const label = baseLabel({
      speakerId: { kind: "narration" },
      evidenceRefs: ["a", "b"],
    });
    const publicLabel = prepareSpeakerLabelForPatchExport(label);
    label.evidenceRefs.push("c");
    expect(publicLabel.evidenceRefs).toEqual(["a", "b"]);
  });

  it("hidden-identity leak audit: serialized payload of every variant is free of the internal id string", () => {
    // Single-shot audit pass for use in CI dashboards. If this test ever
    // turns red, the patch-export pipeline is leaking a hidden identity.
    const audit = variants()
      .map((v) => JSON.stringify(prepareSpeakerLabelForPatchExport(v.label)))
      .join("\n");
    expect(audit).not.toContain("internalCharacterId");
    expect(audit).not.toContain("char-maou");
  });
});
