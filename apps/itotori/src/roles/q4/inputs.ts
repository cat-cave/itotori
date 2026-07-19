// The route-bound, continuity-only input the Continuity Reviewer is allowed to
// see.
//
// The reviewer judges CALLBACK / FORESHADOW / RELATIONSHIP / ROUTE-ARC
// consistency and nothing else. Its input is the unit under review (the USE
// site), its localized line, the localized route + character bible renderings,
// and the ACCEPTED ORIGIN TRANSLATIONS it judges continuity against — every one
// a real prior unit's accepted target it may cite as a contradiction endpoint.
//
// The whole review is ROUTE-BOUND: `reviewScope` is mandatory, so a review can
// never be assembled without the route it is scoped to. This is a cooperative
// pipeline over trusted, workflow-produced substrate — the strict schema is the
// input check; there is no adversarial input-provenance scan here.

import { z } from "zod";
import {
  IdentifierSchema,
  NonEmptyTextSchema,
  RouteScopeSchema,
  Sha256Schema,
  type RouteScope,
} from "../../contracts/index.js";

/** One accepted ORIGIN translation the reviewer may cite as a continuity
 * endpoint: a real prior unit's id and its accepted localized line. The play
 * order and route scope of this unit are NOT taken from here — they are decode
 * facts the ledger owns; this is only what the reviewer reads on the wire. */
export const Q4OriginTranslationSchema = z
  .object({
    unitId: IdentifierSchema,
    acceptedTarget: NonEmptyTextSchema,
  })
  .strict();

/** The complete continuity-review input for one unit under review. */
export const Q4ReviewInputSchema = z
  .object({
    unitId: IdentifierSchema,
    localizationSnapshotId: Sha256Schema,
    /** The route the review is bound to — every mode is route-bound. */
    reviewScope: RouteScopeSchema,
    /** The localized line of the unit under review (the USE site). */
    currentTarget: NonEmptyTextSchema,
    /** Localized route + character bible renderings the judgement grounds on.
     * Q4 never opens an ungrounded continuity review: at least one accepted
     * localized-bible entry is required on the wire. */
    bibleRenderingIds: z.array(IdentifierSchema).min(1).max(1_024),
    /** Accepted origin translations the reviewer judges continuity against. */
    originTranslations: z.array(Q4OriginTranslationSchema).max(1_024),
  })
  .strict();

export type Q4OriginTranslation = z.infer<typeof Q4OriginTranslationSchema>;
export type Q4ReviewInput = z.infer<typeof Q4ReviewInputSchema>;

/** Parse the route-bound, continuity-only shape. The only supported way to
 * construct a review input — an ill-shaped or route-less input fails closed. */
export function parseQ4ReviewInput(raw: unknown): Q4ReviewInput {
  return Q4ReviewInputSchema.parse(raw);
}

/** The review's route scope — read back as the public route-scope type. */
export function reviewScopeOf(input: Q4ReviewInput): RouteScope {
  return input.reviewScope;
}
