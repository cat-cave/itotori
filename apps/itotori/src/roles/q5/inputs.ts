// The on-screen input the Build-LQA Reviewer is allowed to see.
//
// The reviewer judges RESIDUAL TRANSLATION QUALITY ON SCREEN and nothing else.
// Its whole observation of the English target is the RENDER/OCR FRAME: the real
// patched bytes were rendered by the runtime and read back by OCR, and the OCR
// text is the only channel through which the reviewer sees the English line.
//
// This is not an arbitrary choice. The decoded-TextLine observation channel is
// Shift-JIS lead-byte gated: it cannot observe an ASCII-leading English line at
// all, so an English target read from decoded TextLines is a phantom. The
// schema is `.strict()` so an unexpected key is rejected structurally, and
// `assertFrameObserved` additionally deep-scans the raw payload for any decoded
// -TextLine channel key at any depth — the reviewer must never be fed the
// English target through the decoded channel that structurally cannot carry it.

import { z } from "zod";
import {
  IdentifierSchema,
  NonEmptyTextSchema,
  PositiveIntegerSchema,
  RenderAndOcrResultSchema,
  Sha256Schema,
  ShortTextSchema,
  type RenderAndOcrResult,
} from "../../contracts/index.js";

/** The render/OCR fault vocabulary — the deterministic observation kinds the
 * render-and-ocr build step reads back off a real patched-byte frame. Every one
 * of these is an engine/render/glyph/charset/overflow/replay concern that a
 * deterministic build gate owns, NOT a translation-quality judgement. */
export const Q5_RENDER_FAULT_KINDS = [
  "overflow",
  "missing-glyph",
  "charset",
  "layout",
  "ocr-mismatch",
  "replay-coverage",
] as const;

export const Q5RenderFaultKindSchema = z.enum(Q5_RENDER_FAULT_KINDS);
export type Q5RenderFaultKind = z.infer<typeof Q5RenderFaultKindSchema>;

/** One deterministic render/OCR/charset/layout observation over the frame. A
 * FAIL observation is a build fault the deterministic gate owns; a PASS is a
 * clean deterministic fact the reviewer may lean on but never re-derive. */
export const Q5RenderObservationSchema = z
  .object({
    observationId: IdentifierSchema,
    kind: Q5RenderFaultKindSchema,
    status: z.enum(["PASS", "FAIL"]),
    unitId: IdentifierSchema,
    detail: ShortTextSchema,
  })
  .strict();

/** The real patched-byte frame: the runtime rendered the patched bytes and OCR
 * read the on-screen text back. `ocrText` is the SOLE channel through which the
 * reviewer observes the English target — there is deliberately no decoded-text
 * field, because the decoded channel cannot carry an ASCII-leading English line. */
export const Q5RenderFrameSchema = z
  .object({
    frameId: IdentifierSchema,
    /** The content-addressed rendered image the reviewer is judging, not a
     * decoded source-line substitute. It remains a reference: deterministic
     * replay owns its bytes and Q5 never drives the renderer. */
    artifactUri: z.url(),
    patchedBytesHash: Sha256Schema,
    contentHash: Sha256Schema,
    expectedAcceptedOutputId: IdentifierSchema,
    observedUnitIds: z.array(IdentifierSchema).min(1).max(10_000),
    width: PositiveIntegerSchema,
    height: PositiveIntegerSchema,
    ocrText: z.string().max(32_768),
    observations: z.array(Q5RenderObservationSchema).max(10_000),
  })
  .strict();

/** One exact localized-bible rendering. Passing only an opaque rendering ID
 * would let the reviewer name a rule it could not read; Build-LQA receives the
 * actual localized text that governs its residual on-screen judgement. */
export const Q5LocalizedBibleEntrySchema = z
  .object({
    renderingId: IdentifierSchema,
    text: NonEmptyTextSchema,
  })
  .strict();

/** The complete build-LQA review input for one unit. */
export const Q5ReviewInputSchema = z
  .object({
    unitId: IdentifierSchema,
    localizationSnapshotId: Sha256Schema,
    frame: Q5RenderFrameSchema,
    expectedTarget: NonEmptyTextSchema,
    bibleRenderingIds: z.array(IdentifierSchema).min(1).max(1_024),
    localizedBible: z.array(Q5LocalizedBibleEntrySchema).min(1).max(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    const renderedIds = value.localizedBible.map((entry) => entry.renderingId);
    if (new Set(renderedIds).size !== renderedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["localizedBible"],
        message: "localized bible rendering ids must be unique",
      });
    }
    if (
      renderedIds.length !== value.bibleRenderingIds.length ||
      renderedIds.some((id) => !value.bibleRenderingIds.includes(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["localizedBible"],
        message: "localized bible entries must exactly match the cited rendering ids",
      });
    }
    if (!value.frame.observedUnitIds.includes(value.unitId)) {
      context.addIssue({
        code: "custom",
        path: ["frame", "observedUnitIds"],
        message: "patched-byte frame must observe the unit under Build-LQA review",
      });
    }
  });

export type Q5RenderObservation = z.infer<typeof Q5RenderObservationSchema>;
export type Q5RenderFrame = z.infer<typeof Q5RenderFrameSchema>;
export type Q5LocalizedBibleEntry = z.infer<typeof Q5LocalizedBibleEntrySchema>;
export type Q5ReviewInput = z.infer<typeof Q5ReviewInputSchema>;

/** Keys that would smuggle the English target in through the decoded-TextLine
 * channel — the channel that is Shift-JIS lead-byte gated and CANNOT observe an
 * ASCII-leading English line. The English target is observable ONLY through the
 * frame's OCR text; any of these keys, at any depth, is a category error. */
export const FORBIDDEN_DECODED_OBSERVATION_KEYS: readonly string[] = [
  "decodedtextline",
  "decodedtextlines",
  "textline",
  "textlines",
  "decodedtarget",
  "decodedenglish",
  "decodedline",
  "decodedlines",
  "sjistextline",
  "sjistextlines",
];

/** Thrown when the English target is offered through the decoded channel. */
export class Q5DecodedObservationError extends Error {
  constructor(readonly path: string) {
    super(
      `build-LQA reviewer observes the English target through render/OCR only: ` +
        `decoded-text channel key at ${path} cannot carry an ASCII-leading English line`,
    );
    this.name = "Q5DecodedObservationError";
  }
}

/** Deep-scan a raw payload and throw if any decoded-TextLine channel key is
 * present. The strict schema rejects unknown keys at each level; this catches a
 * nested attempt to leak an English observation through the decoded channel and
 * names the exact category error instead of a generic parse failure. */
export function assertFrameObserved(raw: unknown, path = "$"): void {
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => assertFrameObserved(item, `${path}[${index}]`));
    return;
  }
  if (raw === null || typeof raw !== "object") return;
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_DECODED_OBSERVATION_KEYS.includes(key.toLowerCase())) {
      throw new Q5DecodedObservationError(`${path}.${key}`);
    }
    assertFrameObserved(value, `${path}.${key}`);
  }
}

/** Parse-and-gate: validate the on-screen shape AND prove the English target is
 * not offered through the decoded channel. The only supported constructor. */
export function parseQ5ReviewInput(raw: unknown): Q5ReviewInput {
  assertFrameObserved(raw);
  return Q5ReviewInputSchema.parse(raw);
}

/** Thrown when a requested frame is absent from a render/OCR result. */
export class Q5FrameNotObservedError extends Error {
  constructor(readonly frameId: string) {
    super(`render/OCR result carries no frame ${frameId}`);
    this.name = "Q5FrameNotObservedError";
  }
}

/** Project a real render-and-ocr result frame into the reviewer's frame input.
 * This is the concrete tie: the reviewer's "patched-byte frame" is exactly the
 * deterministic render/OCR channel output, carrying the patched-bytes hash, the
 * OCR-read English text, and the deterministic observations — never a decoded
 * TextLine. Consumes the render result READ-ONLY. */
export function q5FrameFromRenderResult(
  result: RenderAndOcrResult,
  frameId: string,
): Q5RenderFrame {
  const parsed = RenderAndOcrResultSchema.parse(result);
  const frame = parsed.frames.find((candidate) => candidate.frameId === frameId);
  if (!frame) throw new Q5FrameNotObservedError(frameId);
  return Q5RenderFrameSchema.parse({
    frameId: frame.frameId,
    artifactUri: frame.artifactUri,
    patchedBytesHash: parsed.patchedBytesHash,
    contentHash: frame.contentHash,
    expectedAcceptedOutputId: frame.expectedAcceptedOutputId,
    observedUnitIds: frame.observedUnitIds,
    width: frame.width,
    height: frame.height,
    ocrText: frame.ocrText,
    observations: frame.observations.map((observation) => ({
      observationId: observation.observationId,
      kind: observation.kind,
      status: observation.status,
      unitId: observation.unitId,
      detail: observation.detail,
    })),
  });
}
