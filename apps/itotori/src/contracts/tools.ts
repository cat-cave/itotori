import { z } from "zod";
import { AcceptedOutputSchema } from "./accepted.js";
import {
  CharacterOccurrenceFactSchema,
  GlossaryFactSchema,
  HumanNoteFactSchema,
  RouteEdgeFactSchema,
  RouteNodeFactSchema,
  UnitFactSchema,
} from "./context.js";
import {
  IdentifierSchema,
  IsoDateSchema,
  LanguageTagSchema,
  NonEmptyTextSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  ShortTextSchema,
} from "./shared.js";

export const DECODE_GET_UNITS_RESULT_SCHEMA_VERSION =
  "itotori.tool.decode-get-units-result.v1" as const;
export const DECODE_GET_NEIGHBORS_RESULT_SCHEMA_VERSION =
  "itotori.tool.decode-get-neighbors-result.v1" as const;
export const DECODE_GET_ROUTE_GRAPH_RESULT_SCHEMA_VERSION =
  "itotori.tool.decode-get-route-graph-result.v1" as const;
export const DECODE_GET_CHARACTER_OCCURRENCES_RESULT_SCHEMA_VERSION =
  "itotori.tool.decode-get-character-occurrences-result.v1" as const;
export const GLOSSARY_LOOKUP_RESULT_SCHEMA_VERSION =
  "itotori.tool.glossary-lookup-result.v1" as const;
export const OUTPUTS_GET_ACCEPTED_RESULT_SCHEMA_VERSION =
  "itotori.tool.outputs-get-accepted-result.v1" as const;
export const REFERENCES_SEARCH_RESULT_SCHEMA_VERSION =
  "itotori.tool.references-search-result.v1" as const;
export const WEB_SEARCH_RESULT_SCHEMA_VERSION = "itotori.tool.web-search-result.v1" as const;
export const BACK_TRANSLATE_RESULT_SCHEMA_VERSION =
  "itotori.tool.back-translate-result.v1" as const;
export const RENDER_AND_OCR_RESULT_SCHEMA_VERSION =
  "itotori.tool.render-and-ocr-result.v1" as const;

const PageCountsShape = {
  requestCursor: z.string().min(1).max(2_048).nullable(),
  returnedRows: NonNegativeIntegerSchema,
  returnedBytes: NonNegativeIntegerSchema,
  maxRows: PositiveIntegerSchema,
  maxBytes: PositiveIntegerSchema,
} as const;

export const ToolResultPageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...PageCountsShape,
      kind: z.literal("complete"),
      nextCursor: z.null(),
    })
    .strict(),
  z
    .object({
      ...PageCountsShape,
      kind: z.literal("more"),
      nextCursor: z.string().min(1).max(2_048),
    })
    .strict(),
]);

const ToolResultBaseShape = {
  snapshotId: Sha256Schema,
  requestHash: Sha256Schema,
  resultHash: Sha256Schema,
  page: ToolResultPageSchema,
} as const;

export const DecodeGetUnitsResultSchema = z
  .object({
    schemaVersion: z.literal(DECODE_GET_UNITS_RESULT_SCHEMA_VERSION),
    tool: z.literal("decode_get_units"),
    ...ToolResultBaseShape,
    facts: z.array(UnitFactSchema).max(100_000),
  })
  .strict();

export const DecodeGetNeighborsResultSchema = z
  .object({
    schemaVersion: z.literal(DECODE_GET_NEIGHBORS_RESULT_SCHEMA_VERSION),
    tool: z.literal("decode_get_neighbors"),
    ...ToolResultBaseShape,
    anchorUnitIds: z.array(IdentifierSchema).min(1).max(256),
    facts: z.array(UnitFactSchema).max(100_000),
  })
  .strict();

const RouteGraphCoverageSchema = z
  .object({
    archiveSceneCount: NonNegativeIntegerSchema,
    emittedSceneCount: NonNegativeIntegerSchema,
    unresolvedEdgeCount: NonNegativeIntegerSchema,
    truncated: z.literal(false),
  })
  .strict();

export const DecodeGetRouteGraphResultSchema = z
  .object({
    schemaVersion: z.literal(DECODE_GET_ROUTE_GRAPH_RESULT_SCHEMA_VERSION),
    tool: z.literal("decode_get_route_graph"),
    ...ToolResultBaseShape,
    facts: z.array(z.union([RouteNodeFactSchema, RouteEdgeFactSchema])).max(200_000),
    coverage: RouteGraphCoverageSchema,
  })
  .strict();

export const DecodeGetCharacterOccurrencesResultSchema = z
  .object({
    schemaVersion: z.literal(DECODE_GET_CHARACTER_OCCURRENCES_RESULT_SCHEMA_VERSION),
    tool: z.literal("decode_get_character_occurrences"),
    ...ToolResultBaseShape,
    facts: z.array(CharacterOccurrenceFactSchema).length(1),
  })
  .strict();

export const GlossaryLookupResultSchema = z
  .object({
    schemaVersion: z.literal(GLOSSARY_LOOKUP_RESULT_SCHEMA_VERSION),
    tool: z.literal("glossary_lookup"),
    ...ToolResultBaseShape,
    glossaryRevisionHash: Sha256Schema,
    facts: z.array(GlossaryFactSchema).max(100_000),
  })
  .strict();

export const OutputsGetAcceptedResultSchema = z
  .object({
    schemaVersion: z.literal(OUTPUTS_GET_ACCEPTED_RESULT_SCHEMA_VERSION),
    tool: z.literal("outputs_get_accepted"),
    ...ToolResultBaseShape,
    outputs: z.array(AcceptedOutputSchema).max(100_000),
  })
  .strict();

const ReferenceSearchHitSchema = z
  .object({
    fact: HumanNoteFactSchema,
    lexicalScore: z.number().min(0).max(1),
    vectorScore: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const ReferencesSearchResultSchema = z
  .object({
    schemaVersion: z.literal(REFERENCES_SEARCH_RESULT_SCHEMA_VERSION),
    tool: z.literal("references_search"),
    ...ToolResultBaseShape,
    hits: z.array(ReferenceSearchHitSchema).max(10_000),
  })
  .strict();

const WebSearchHitSchema = z
  .object({
    evidenceId: z.string().regex(/^web:sha256:[a-f0-9]{64}$/u),
    url: z.url(),
    retrievedOn: IsoDateSchema,
    contentHash: Sha256Schema,
    title: ShortTextSchema,
    excerpt: NonEmptyTextSchema,
    provenance: z.literal("web"),
    confidence: z.enum(["low", "medium"]),
    corroboratingSameGameFactIds: z.array(IdentifierSchema).max(1_024),
  })
  .strict();

export const WebSearchResultSchema = z
  .object({
    schemaVersion: z.literal(WEB_SEARCH_RESULT_SCHEMA_VERSION),
    tool: z.literal("web_search"),
    ...ToolResultBaseShape,
    egressAuthorizedForRole: z.literal("A7"),
    hits: z.array(WebSearchHitSchema).max(1_000),
  })
  .strict();

const BackTranslationSignalSchema = z
  .object({
    kind: z.enum(["omission-risk", "addition-risk", "referent-risk", "term-risk"]),
    confidence: z.enum(["low", "medium", "high"]),
    sourceSpanId: IdentifierSchema.nullable(),
    note: ShortTextSchema,
  })
  .strict();

export const BackTranslateResultSchema = z
  .object({
    schemaVersion: z.literal(BACK_TRANSLATE_RESULT_SCHEMA_VERSION),
    tool: z.literal("back_translate"),
    ...ToolResultBaseShape,
    diagnosticOnly: z.literal(true),
    unitId: IdentifierSchema,
    sourceLanguage: LanguageTagSchema,
    targetLanguage: LanguageTagSchema,
    backTranslation: NonEmptyTextSchema,
    signals: z.array(BackTranslationSignalSchema).max(32),
  })
  .strict();

const RenderObservationSchema = z
  .object({
    observationId: IdentifierSchema,
    kind: z.enum([
      "overflow",
      "missing-glyph",
      "charset",
      "layout",
      "ocr-mismatch",
      "replay-coverage",
    ]),
    status: z.enum(["PASS", "FAIL"]),
    unitId: IdentifierSchema,
    detail: ShortTextSchema,
  })
  .strict();

const RenderedFrameSchema = z
  .object({
    frameId: IdentifierSchema,
    artifactUri: z.url(),
    contentHash: Sha256Schema,
    expectedAcceptedOutputId: IdentifierSchema,
    observedUnitIds: z.array(IdentifierSchema).min(1).max(10_000),
    width: PositiveIntegerSchema,
    height: PositiveIntegerSchema,
    ocrText: z.string().max(32_768),
    observations: z.array(RenderObservationSchema).max(10_000),
  })
  .strict();

export const RenderAndOcrResultSchema = z
  .object({
    schemaVersion: z.literal(RENDER_AND_OCR_RESULT_SCHEMA_VERSION),
    tool: z.literal("render_and_ocr"),
    ...ToolResultBaseShape,
    patchedBytesHash: Sha256Schema,
    frames: z.array(RenderedFrameSchema).max(100_000),
  })
  .strict();

export const ToolResultSchema = z.discriminatedUnion("tool", [
  DecodeGetUnitsResultSchema,
  DecodeGetNeighborsResultSchema,
  DecodeGetRouteGraphResultSchema,
  DecodeGetCharacterOccurrencesResultSchema,
  GlossaryLookupResultSchema,
  OutputsGetAcceptedResultSchema,
  ReferencesSearchResultSchema,
  WebSearchResultSchema,
  BackTranslateResultSchema,
  RenderAndOcrResultSchema,
]);

export type DecodeGetUnitsResult = z.infer<typeof DecodeGetUnitsResultSchema>;
export type DecodeGetNeighborsResult = z.infer<typeof DecodeGetNeighborsResultSchema>;
export type DecodeGetRouteGraphResult = z.infer<typeof DecodeGetRouteGraphResultSchema>;
export type DecodeGetCharacterOccurrencesResult = z.infer<
  typeof DecodeGetCharacterOccurrencesResultSchema
>;
export type GlossaryLookupResult = z.infer<typeof GlossaryLookupResultSchema>;
export type OutputsGetAcceptedResult = z.infer<typeof OutputsGetAcceptedResultSchema>;
export type ReferencesSearchResult = z.infer<typeof ReferencesSearchResultSchema>;
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;
export type BackTranslateResult = z.infer<typeof BackTranslateResultSchema>;
export type RenderAndOcrResult = z.infer<typeof RenderAndOcrResultSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
