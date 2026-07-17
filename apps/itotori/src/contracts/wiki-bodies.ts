import { z } from "zod";
import { DraftBatchSchema } from "./outputs.js";
import {
  IdentifierSchema,
  NonEmptyTextSchema,
  NonNegativeIntegerSchema,
  RouteScopeSchema,
  ShortTextSchema,
  SubjectIdSchema,
} from "./shared.js";

export const StyleContractBodySchema = z
  .object({
    registerPolicy: NonEmptyTextSchema,
    honorificPolicy: NonEmptyTextSchema,
    nameOrder: z.enum(["source-order", "given-first", "contextual"]),
    profanityCeiling: z.enum(["none", "mild", "moderate", "unrestricted"]),
    punctuationRules: z.array(ShortTextSchema).max(128),
    audienceNote: NonEmptyTextSchema,
  })
  .strict();

export const TermRulingBodySchema = z
  .object({
    termId: SubjectIdSchema,
    sourceForm: ShortTextSchema,
    meaning: NonEmptyTextSchema,
    register: NonEmptyTextSchema,
    confidence: z.enum(["low", "medium", "high"]),
    sourceScope: RouteScopeSchema,
    aliases: z.array(ShortTextSchema).max(256),
  })
  .strict();

export const SceneSummaryBodySchema = z
  .object({
    sceneId: IdentifierSchema,
    beat: NonEmptyTextSchema,
    subtext: NonEmptyTextSchema,
    openThreads: z.array(ShortTextSchema).max(256),
  })
  .strict();

export const StorySoFarBodySchema = z
  .object({
    throughSceneId: IdentifierSchema,
    summary: NonEmptyTextSchema,
    openThreads: z.array(ShortTextSchema).max(1_024),
  })
  .strict();

const ArcLinkSchema = z
  .object({
    linkId: IdentifierSchema,
    originEvidenceId: IdentifierSchema,
    destinationEvidenceId: IdentifierSchema,
    description: NonEmptyTextSchema,
  })
  .strict();

const RelationshipDeltaSchema = z
  .object({
    counterpartId: SubjectIdSchema,
    fromPlayOrder: NonNegativeIntegerSchema,
    toPlayOrder: NonNegativeIntegerSchema,
    before: NonEmptyTextSchema,
    after: NonEmptyTextSchema,
  })
  .strict();

export const RouteArcBodySchema = z
  .object({
    routeId: IdentifierSchema,
    arcSummary: NonEmptyTextSchema,
    callbacks: z.array(ArcLinkSchema).max(10_000),
    foreshadows: z.array(ArcLinkSchema).max(10_000),
    relationshipDeltas: z.array(RelationshipDeltaSchema).max(10_000),
    revealHorizon: NonNegativeIntegerSchema,
  })
  .strict();

const VoiceCounterpartSchema = z
  .object({
    counterpartId: SubjectIdSchema,
    addressForm: ShortTextSchema,
    registerDelta: NonEmptyTextSchema,
    scope: RouteScopeSchema,
  })
  .strict();

const VoiceArcPositionSchema = z
  .object({
    scope: RouteScopeSchema,
    fromPlayOrder: NonNegativeIntegerSchema,
    toPlayOrder: NonNegativeIntegerSchema,
    register: NonEmptyTextSchema,
    note: NonEmptyTextSchema,
    evidenceId: IdentifierSchema,
  })
  .strict();

export const VoiceProfileBodySchema = z
  .object({
    characterId: SubjectIdSchema,
    base: z
      .object({
        pronoun: ShortTextSchema,
        register: NonEmptyTextSchema,
        tics: z.array(ShortTextSchema).max(256),
      })
      .strict(),
    perCounterpart: z.array(VoiceCounterpartSchema).max(10_000),
    perArcPosition: z.array(VoiceArcPositionSchema).max(10_000),
  })
  .strict();

const AdaptationOptionSchema = z
  .object({
    optionId: IdentifierSchema,
    strategy: NonEmptyTextSchema,
    tradeoffs: z.array(ShortTextSchema).min(1).max(32),
  })
  .strict();

export const AdaptationNoteBodySchema = z
  .object({
    subjectId: IdentifierSchema,
    communicativeFunction: NonEmptyTextSchema,
    constraints: z.array(ShortTextSchema).max(128),
    boundedOptions: z.array(AdaptationOptionSchema).min(1).max(16),
  })
  .strict();

export const CharacterBioBodySchema = z
  .object({
    characterId: SubjectIdSchema,
    storyRole: NonEmptyTextSchema,
    definingTraits: z.array(ShortTextSchema).min(1).max(128),
    notableMomentEvidenceIds: z.array(IdentifierSchema).min(1).max(1_024),
  })
  .strict();

const RelationshipSchema = z
  .object({
    counterpartId: SubjectIdSchema,
    relationship: NonEmptyTextSchema,
    scope: RouteScopeSchema,
    establishingEvidenceIds: z.array(IdentifierSchema).min(1).max(1_024),
  })
  .strict();

export const CharacterBackgroundBodySchema = z
  .object({
    characterId: SubjectIdSchema,
    background: NonEmptyTextSchema,
    relationships: z.array(RelationshipSchema).max(10_000),
  })
  .strict();

const CharacterShiftSchema = z
  .object({
    fromPlayOrder: NonNegativeIntegerSchema,
    toPlayOrder: NonNegativeIntegerSchema,
    stateBefore: NonEmptyTextSchema,
    stateAfter: NonEmptyTextSchema,
    evidenceIds: z.array(IdentifierSchema).min(1).max(1_024),
  })
  .strict();

export const CharacterRouteArcBodySchema = z
  .object({
    characterId: SubjectIdSchema,
    routeId: IdentifierSchema,
    shifts: z.array(CharacterShiftSchema).max(10_000),
  })
  .strict();

export const SpeakerHypothesisBodySchema = z
  .object({
    unitId: IdentifierSchema,
    candidateCharacterId: SubjectIdSchema,
    confidence: z.enum(["low", "medium", "high"]),
    revealSceneId: IdentifierSchema,
  })
  .strict();

export const TranslationBodySchema = z
  .object({
    draftBatch: DraftBatchSchema,
  })
  .strict();

const LocalizedSectionSchema = z
  .object({
    sectionId: IdentifierSchema,
    heading: ShortTextSchema,
    text: NonEmptyTextSchema,
    scope: RouteScopeSchema,
  })
  .strict();

const LocalizedProseBodyShape = {
  sections: z.array(LocalizedSectionSchema).min(1).max(1_024),
} as const;

const LocalizedStyleBodySchema = z
  .object({
    kind: z.literal("style-contract"),
    registerGuidance: NonEmptyTextSchema,
    honorificGuidance: NonEmptyTextSchema,
    nameOrder: z.enum(["source-order", "given-first", "contextual"]),
    profanityCeiling: z.enum(["none", "mild", "moderate", "unrestricted"]),
    punctuationRules: z.array(ShortTextSchema).max(128),
  })
  .strict();

const CanonicalTermFormSchema = z
  .object({
    form: ShortTextSchema,
    status: z.enum(["preferred", "allowed", "forbidden"]),
    scope: RouteScopeSchema,
  })
  .strict();

const LocalizedTermBodySchema = z
  .object({
    kind: z.literal("term-ruling"),
    termId: SubjectIdSchema,
    canonicalForms: z.array(CanonicalTermFormSchema).min(1).max(256),
    registerGuidance: NonEmptyTextSchema,
  })
  .strict();

const LocalizedVoiceBodySchema = z
  .object({
    kind: z.literal("voice-profile"),
    characterId: SubjectIdSchema,
    baseRegisterGuidance: NonEmptyTextSchema,
    counterpartGuidance: z.array(LocalizedSectionSchema).max(1_024),
    arcGuidance: z.array(LocalizedSectionSchema).max(1_024),
  })
  .strict();

const LocalizedSpeakerHypothesisBodySchema = z
  .object({
    kind: z.literal("speaker-hypothesis"),
    displayLabel: ShortTextSchema,
    disclosureGuidance: NonEmptyTextSchema,
  })
  .strict();

function localizedProseBody<const Kind extends string>(kind: Kind) {
  return z.object({ kind: z.literal(kind), ...LocalizedProseBodyShape }).strict();
}

export const LocalizedBodySchema = z.discriminatedUnion("kind", [
  LocalizedStyleBodySchema,
  LocalizedTermBodySchema,
  localizedProseBody("scene-summary"),
  localizedProseBody("story-so-far"),
  localizedProseBody("route-arc"),
  LocalizedVoiceBodySchema,
  localizedProseBody("adaptation-note"),
  localizedProseBody("character-bio"),
  localizedProseBody("character-background"),
  localizedProseBody("character-route-arc"),
  LocalizedSpeakerHypothesisBodySchema,
]);

export type LocalizedBody = z.infer<typeof LocalizedBodySchema>;
