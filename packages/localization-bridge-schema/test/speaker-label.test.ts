import { describe, expect, it } from "vitest";
import {
  assertSpeakerLabelOutput,
  parseSpeakerLabelOutput,
  SPEAKER_IDENTITY_KINDS,
  SPEAKER_LABEL_CONFIDENCES,
  SPEAKER_LABEL_OUTPUT_JSON_SCHEMA,
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  SPEAKER_LABEL_UNKNOWN_REASONS,
  SpeakerLabelResponseValidationError,
  type SpeakerIdentity,
} from "../src/speaker-label.js";

function namedIdentity(): SpeakerIdentity {
  return {
    kind: "named",
    characterId: "char-yusha",
    displayName: "Hero",
  };
}

function maskedIdentity(opts: { internal?: string } = {}): SpeakerIdentity {
  const identity: SpeakerIdentity = {
    kind: "unknown_to_reader",
    maskedCharacterId: "masked-001",
    maskedDisplayName: "??? (cloaked figure)",
  };
  if (opts.internal !== undefined) {
    identity.internalCharacterId = opts.internal;
  }
  return identity;
}

function validLabel(
  overrides: { speakerId?: SpeakerIdentity; bridgeUnitId?: string } = {},
): Record<string, unknown> {
  return {
    bridgeUnitId: overrides.bridgeUnitId ?? "019ed079-0000-7000-8000-00000000a001",
    speakerId: overrides.speakerId ?? namedIdentity(),
    confidence: "high",
    evidenceRefs: ["scene-summary:scene-001", "character-bio:char-yusha"],
    agentRationale: "Speaker tag on prior line names the hero explicitly.",
  };
}

function validOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [validLabel()],
    ...overrides,
  };
}

describe("SpeakerLabelOutput", () => {
  it("accepts a fully-populated label with a `named` identity", () => {
    expect(() => assertSpeakerLabelOutput(validOutput())).not.toThrow();
  });

  it("accepts an empty labels array", () => {
    expect(() =>
      assertSpeakerLabelOutput({
        schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
        labels: [],
      }),
    ).not.toThrow();
  });

  it("accepts each of the four SpeakerIdentity kinds", () => {
    const labels = [
      validLabel({ bridgeUnitId: "u-001", speakerId: namedIdentity() }),
      validLabel({ bridgeUnitId: "u-002", speakerId: maskedIdentity() }),
      validLabel({
        bridgeUnitId: "u-003",
        speakerId: { kind: "unknown_to_parser", reason: "no_signal" },
      }),
      validLabel({ bridgeUnitId: "u-004", speakerId: { kind: "narration" } }),
    ];
    expect(() =>
      assertSpeakerLabelOutput({
        schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
        labels,
      }),
    ).not.toThrow();
  });

  it("accepts an unknown_to_reader identity carrying an internalCharacterId", () => {
    expect(() =>
      assertSpeakerLabelOutput(
        validOutput({
          labels: [validLabel({ speakerId: maskedIdentity({ internal: "char-yusha" }) })],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an output without schemaVersion", () => {
    expect(() => assertSpeakerLabelOutput({ labels: [] })).toThrow(
      SpeakerLabelResponseValidationError,
    );
  });

  it("rejects an output with the wrong schemaVersion", () => {
    expect(() => assertSpeakerLabelOutput({ schemaVersion: "v0", labels: [] })).toThrow(
      /schemaVersion/,
    );
  });

  it("rejects unknown top-level properties", () => {
    expect(() =>
      assertSpeakerLabelOutput({
        schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
        labels: [],
        extra: 1,
      }),
    ).toThrow(/extra/);
  });

  it("rejects labels missing a required field", () => {
    const label = validLabel();
    delete (label as Record<string, unknown>).confidence;
    expect(() => assertSpeakerLabelOutput(validOutput({ labels: [label] }))).toThrow(/confidence/);
  });

  it("rejects unknown label-level properties", () => {
    const label = validLabel();
    (label as Record<string, unknown>).score = 0.9;
    expect(() => assertSpeakerLabelOutput(validOutput({ labels: [label] }))).toThrow(/score/);
  });

  it("rejects an unknown SpeakerIdentity kind", () => {
    expect(() =>
      assertSpeakerLabelOutput(
        validOutput({
          labels: [validLabel({ speakerId: { kind: "voice_only" } as unknown as SpeakerIdentity })],
        }),
      ),
    ).toThrow(/kind/);
  });

  it("rejects a named identity missing displayName", () => {
    expect(() =>
      assertSpeakerLabelOutput(
        validOutput({
          labels: [
            validLabel({
              speakerId: { kind: "named", characterId: "x" } as unknown as SpeakerIdentity,
            }),
          ],
        }),
      ),
    ).toThrow(/displayName/);
  });

  it("rejects a named identity carrying an internalCharacterId (cross-kind leak)", () => {
    expect(() =>
      assertSpeakerLabelOutput(
        validOutput({
          labels: [
            validLabel({
              speakerId: {
                kind: "named",
                characterId: "char-yusha",
                displayName: "Hero",
                internalCharacterId: "leak-attempt",
              } as unknown as SpeakerIdentity,
            }),
          ],
        }),
      ),
    ).toThrow(/internalCharacterId/);
  });

  it("rejects an unknown_to_parser identity with an invalid reason", () => {
    expect(() =>
      assertSpeakerLabelOutput(
        validOutput({
          labels: [
            validLabel({
              speakerId: {
                kind: "unknown_to_parser",
                reason: "vibes",
              } as unknown as SpeakerIdentity,
            }),
          ],
        }),
      ),
    ).toThrow(/reason/);
  });

  it("rejects an invalid confidence", () => {
    expect(() =>
      assertSpeakerLabelOutput(
        validOutput({ labels: [{ ...validLabel(), confidence: "certain" }] }),
      ),
    ).toThrow(/confidence/);
  });

  it("rejects evidenceRefs containing an empty string", () => {
    expect(() =>
      assertSpeakerLabelOutput(validOutput({ labels: [{ ...validLabel(), evidenceRefs: [""] }] })),
    ).toThrow(/evidenceRefs/);
  });

  it("parseSpeakerLabelOutput surfaces a JSON parse error as a typed error", () => {
    expect(() => parseSpeakerLabelOutput("not-json")).toThrow(SpeakerLabelResponseValidationError);
  });

  it("parseSpeakerLabelOutput round-trips a stringified output", () => {
    const out = validOutput();
    const parsed = parseSpeakerLabelOutput(JSON.stringify(out));
    expect(parsed.schemaVersion).toBe(SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION);
    expect(parsed.labels).toHaveLength(1);
    expect(parsed.labels[0]!.speakerId.kind).toBe("named");
  });

  it("identity kind / confidence / reason enums match the JSON schema constants", () => {
    const confidenceEnum = (
      SPEAKER_LABEL_OUTPUT_JSON_SCHEMA.properties.labels.items.properties.confidence as {
        enum: ReadonlyArray<string>;
      }
    ).enum;
    expect([...confidenceEnum]).toEqual([...SPEAKER_LABEL_CONFIDENCES]);
    const branches = SPEAKER_LABEL_OUTPUT_JSON_SCHEMA.properties.labels.items.properties.speakerId
      .oneOf as ReadonlyArray<{ properties: { kind: { const: string } } }>;
    expect(branches.map((branch) => branch.properties.kind.const)).toEqual([
      ...SPEAKER_IDENTITY_KINDS,
    ]);
    const unknownReasonBranch = branches.find(
      (branch) => branch.properties.kind.const === "unknown_to_parser",
    );
    expect(unknownReasonBranch).toBeDefined();
    const reasonEnum = (
      unknownReasonBranch as unknown as {
        properties: { reason: { enum: ReadonlyArray<string> } };
      }
    ).properties.reason.enum;
    expect([...reasonEnum]).toEqual([...SPEAKER_LABEL_UNKNOWN_REASONS]);
  });
});
