// The blinded, meaning-only input the Meaning Reviewer is allowed to see.
//
// The reviewer judges MEANING preservation and nothing else. Its whole input is
// authoritative source facts, the candidate target, the localized bible, source
// and accepted-target neighbor windows, and an OPTIONAL back-translation SIGNAL.
// It is BLINDED to author identity: who (or which model/provider) drafted the
// candidate is not part of the record and cannot be smuggled in. The schema is
// `.strict()` so an unexpected key is rejected structurally, and `assertBlinded`
// additionally deep-scans the raw payload for any author-identity key at any
// depth — a defence the flat schema alone cannot give.

import { z } from "zod";
import {
  IdentifierSchema,
  NonEmptyTextSchema,
  Sha256Schema,
  ShortTextSchema,
} from "../../contracts/index.js";

/** One authoritative source fact the reviewer grounds meaning against. */
export const Q1SourceFactSchema = z
  .object({
    factId: IdentifierSchema,
    field: ShortTextSchema,
    text: NonEmptyTextSchema,
  })
  .strict();

/** A neighbor window — source context or an already-accepted target line. The
 * accepted-target surface fixes the one-unit starvation an isolated reviewer
 * suffers, without ever revealing who authored it. */
export const Q1NeighborWindowSchema = z
  .object({
    surface: z.enum(["source", "accepted-target"]),
    unitId: IdentifierSchema,
    text: NonEmptyTextSchema,
  })
  .strict();

/** A back-translation is a SIGNAL the reviewer may INTERPRET, never a verdict.
 * It is carried as its own labelled field so it can never be mistaken for the
 * judgement itself. `note` records why the signal was produced (e.g. tripwire). */
export const Q1BackTranslationSignalSchema = z
  .object({
    kind: z.literal("signal"),
    text: NonEmptyTextSchema,
    note: ShortTextSchema,
  })
  .strict();

/** The complete meaning-only review input for one unit. */
export const Q1ReviewInputSchema = z
  .object({
    unitId: IdentifierSchema,
    localizationSnapshotId: Sha256Schema,
    sourceFacts: z.array(Q1SourceFactSchema).min(1).max(1_024),
    candidateTarget: NonEmptyTextSchema,
    bibleRenderingIds: z.array(IdentifierSchema).max(1_024),
    neighbors: z.array(Q1NeighborWindowSchema).max(1_024),
    backTranslationSignal: Q1BackTranslationSignalSchema.nullable(),
  })
  .strict();

export type Q1SourceFact = z.infer<typeof Q1SourceFactSchema>;
export type Q1NeighborWindow = z.infer<typeof Q1NeighborWindowSchema>;
export type Q1BackTranslationSignal = z.infer<typeof Q1BackTranslationSignalSchema>;
export type Q1ReviewInput = z.infer<typeof Q1ReviewInputSchema>;

/** Author-identity keys the reviewer must never see, in any casing, at any
 * depth. Blinding is what keeps the judgement about the text, not the source. */
export const FORBIDDEN_BLINDING_KEYS: readonly string[] = [
  "author",
  "authorid",
  "authoredby",
  "drafter",
  "drafterid",
  "writer",
  "translator",
  "translatorid",
  "model",
  "modelid",
  "modelprofile",
  "provider",
  "providerid",
  "agent",
  "agentid",
  "speakerauthor",
];

/** Thrown when an author-identity key reaches the blinded reviewer. */
export class Q1BlindingError extends Error {
  constructor(readonly path: string) {
    super(`meaning reviewer is blinded: author-identity key at ${path} is not permitted`);
    this.name = "Q1BlindingError";
  }
}

/** Deep-scan a raw payload and throw if any author-identity key is present. The
 * strict schema rejects unknown keys at the top level; this catches a nested
 * attempt to leak identity through a source fact, neighbor, or signal. */
export function assertBlinded(raw: unknown, path = "$"): void {
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => assertBlinded(item, `${path}[${index}]`));
    return;
  }
  if (raw === null || typeof raw !== "object") return;
  for (const [key, value] of Object.entries(raw)) {
    if (FORBIDDEN_BLINDING_KEYS.includes(key.toLowerCase())) {
      throw new Q1BlindingError(`${path}.${key}`);
    }
    assertBlinded(value, `${path}.${key}`);
  }
}

/** Parse-and-blind: validate the meaning-only shape AND prove nothing carries
 * author identity. The only supported way to construct a review input. */
export function parseQ1ReviewInput(raw: unknown): Q1ReviewInput {
  assertBlinded(raw);
  return Q1ReviewInputSchema.parse(raw);
}
