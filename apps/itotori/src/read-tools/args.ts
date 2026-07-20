// Strict request-argument schemas for the local read tools.
//
// Every schema is `.strict()`: an unknown argument is a hard parse failure, not
// a silently ignored field. Row/byte bounds are explicit and required, so a
// caller always states how much it will accept and the result always reports
// the effective bounds. `cursor` is optional (absent on the first page).

import { z } from "zod";

import { IdentifierSchema, SubjectIdSchema } from "../contracts/index.js";

const PageArgsShape = {
  maxRows: z.number().int().min(1).max(100_000),
  maxBytes: z.number().int().min(1).max(8_388_608),
  cursor: z.string().min(1).max(2_048).optional(),
} as const;

const SceneIdArg = z.string().min(1).max(256);

export const DecodeGetUnitsArgsSchema = z
  .object({
    selector: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("all") }).strict(),
      z.object({ kind: z.literal("scene"), sceneId: SceneIdArg }).strict(),
      z
        .object({ kind: z.literal("unit-ids"), unitIds: z.array(IdentifierSchema).min(1).max(256) })
        .strict(),
      z
        .object({
          kind: z.literal("play-order-range"),
          from: z.number().int().nonnegative(),
          through: z.number().int().nonnegative(),
        })
        .strict()
        .refine((value) => value.through >= value.from, "play-order range is reversed"),
    ]),
    ...PageArgsShape,
  })
  .strict();

export const DecodeGetNeighborsArgsSchema = z
  .object({
    anchorUnitIds: z.array(IdentifierSchema).min(1).max(256),
    before: z.number().int().min(0).max(256),
    after: z.number().int().min(0).max(256),
    ...PageArgsShape,
  })
  .strict();

export const DecodeGetRouteGraphArgsSchema = z.object({ ...PageArgsShape }).strict();

export const DecodeGetCharacterOccurrencesArgsSchema = z
  .object({ characterId: SubjectIdSchema, ...PageArgsShape })
  .strict();

export const GlossaryLookupArgsSchema = z
  .object({
    selector: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("all") }).strict(),
      z
        .object({ kind: z.literal("term-ids"), termIds: z.array(SubjectIdSchema).min(1).max(256) })
        .strict(),
      z
        .object({
          kind: z.literal("source-forms"),
          forms: z.array(z.string().min(1).max(1_024)).min(1).max(256),
        })
        .strict(),
    ]),
    ...PageArgsShape,
  })
  .strict();

export const OutputsGetAcceptedArgsSchema = z
  .object({
    subjectIds: z.array(IdentifierSchema).min(1).max(1_000),
    stage: z.string().min(1).max(64).optional(),
    ...PageArgsShape,
  })
  .strict();

export const ReferencesSearchArgsSchema = z
  .object({ query: z.string().min(1).max(1_024), ...PageArgsShape })
  .strict();

export type DecodeGetUnitsArgs = z.infer<typeof DecodeGetUnitsArgsSchema>;
export type DecodeGetNeighborsArgs = z.infer<typeof DecodeGetNeighborsArgsSchema>;
export type DecodeGetRouteGraphArgs = z.infer<typeof DecodeGetRouteGraphArgsSchema>;
export type DecodeGetCharacterOccurrencesArgs = z.infer<
  typeof DecodeGetCharacterOccurrencesArgsSchema
>;
export type GlossaryLookupArgs = z.infer<typeof GlossaryLookupArgsSchema>;
export type OutputsGetAcceptedArgs = z.infer<typeof OutputsGetAcceptedArgsSchema>;
export type ReferencesSearchArgs = z.infer<typeof ReferencesSearchArgsSchema>;
