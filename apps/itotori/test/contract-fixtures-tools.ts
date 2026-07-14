import {
  BACK_TRANSLATE_RESULT_SCHEMA_VERSION,
  DECODE_GET_CHARACTER_OCCURRENCES_RESULT_SCHEMA_VERSION,
  DECODE_GET_NEIGHBORS_RESULT_SCHEMA_VERSION,
  DECODE_GET_ROUTE_GRAPH_RESULT_SCHEMA_VERSION,
  DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
  GLOSSARY_LOOKUP_RESULT_SCHEMA_VERSION,
  OUTPUTS_GET_ACCEPTED_RESULT_SCHEMA_VERSION,
  REFERENCES_SEARCH_RESULT_SCHEMA_VERSION,
  RENDER_AND_OCR_RESULT_SCHEMA_VERSION,
  WEB_SEARCH_RESULT_SCHEMA_VERSION,
} from "../src/contracts/index.js";
import {
  H1,
  H2,
  H3,
  H4,
  acceptedOutputExample,
  characterOccurrenceFactExample,
  contextSnapshotExample,
  glossaryFactExample,
  humanNoteFactExample,
  localizationSnapshotExample,
  routeEdgeFactExample,
  routeNodeFactExample,
  unitFactExample,
} from "./contract-fixtures-core.js";

const completePage = (returnedRows: number) => ({
  kind: "complete" as const,
  requestCursor: null,
  nextCursor: null,
  returnedRows,
  returnedBytes: 512,
  maxRows: 100,
  maxBytes: 65_536,
});

const contextEnvelope = {
  snapshotId: contextSnapshotExample.snapshotId,
  requestHash: H1,
  resultHash: H2,
} as const;

const localizationEnvelope = {
  snapshotId: localizationSnapshotExample.snapshotId,
  requestHash: H1,
  resultHash: H2,
} as const;

export const decodeGetUnitsResultExample = {
  schemaVersion: DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
  tool: "decode_get_units",
  ...contextEnvelope,
  page: completePage(1),
  facts: [unitFactExample],
} as const;

export const decodeGetNeighborsResultExample = {
  schemaVersion: DECODE_GET_NEIGHBORS_RESULT_SCHEMA_VERSION,
  tool: "decode_get_neighbors",
  ...contextEnvelope,
  page: completePage(1),
  anchorUnitIds: ["unit:1"],
  facts: [unitFactExample],
} as const;

export const decodeGetRouteGraphResultExample = {
  schemaVersion: DECODE_GET_ROUTE_GRAPH_RESULT_SCHEMA_VERSION,
  tool: "decode_get_route_graph",
  ...contextEnvelope,
  page: completePage(2),
  facts: [routeNodeFactExample, routeEdgeFactExample],
  coverage: {
    archiveSceneCount: 1,
    emittedSceneCount: 1,
    unresolvedEdgeCount: 0,
    truncated: false,
  },
} as const;

export const decodeGetCharacterOccurrencesResultExample = {
  schemaVersion: DECODE_GET_CHARACTER_OCCURRENCES_RESULT_SCHEMA_VERSION,
  tool: "decode_get_character_occurrences",
  ...contextEnvelope,
  page: completePage(1),
  facts: [characterOccurrenceFactExample],
} as const;

export const glossaryLookupResultExample = {
  schemaVersion: GLOSSARY_LOOKUP_RESULT_SCHEMA_VERSION,
  tool: "glossary_lookup",
  ...localizationEnvelope,
  page: completePage(1),
  glossaryRevisionHash: H3,
  facts: [glossaryFactExample],
} as const;

export const outputsGetAcceptedResultExample = {
  schemaVersion: OUTPUTS_GET_ACCEPTED_RESULT_SCHEMA_VERSION,
  tool: "outputs_get_accepted",
  ...localizationEnvelope,
  page: completePage(1),
  outputs: [acceptedOutputExample],
} as const;

export const referencesSearchResultExample = {
  schemaVersion: REFERENCES_SEARCH_RESULT_SCHEMA_VERSION,
  tool: "references_search",
  ...contextEnvelope,
  page: completePage(1),
  hits: [{ fact: humanNoteFactExample, lexicalScore: 0.9, vectorScore: null }],
} as const;

export const webSearchResultExample = {
  schemaVersion: WEB_SEARCH_RESULT_SCHEMA_VERSION,
  tool: "web_search",
  ...contextEnvelope,
  page: completePage(1),
  egressAuthorizedForRole: "A7",
  hits: [
    {
      evidenceId: `web:${H4}`,
      url: "https://example.invalid/reference",
      retrievedOn: "2026-07-14",
      contentHash: H4,
      title: "Synthetic reference",
      excerpt: "A synthetic external reference excerpt.",
      provenance: "web",
      confidence: "medium",
      corroboratingSameGameFactIds: [],
    },
  ],
} as const;

export const backTranslateResultExample = {
  schemaVersion: BACK_TRANSLATE_RESULT_SCHEMA_VERSION,
  tool: "back_translate",
  ...localizationEnvelope,
  page: completePage(1),
  diagnosticOnly: true,
  unitId: "unit:1",
  sourceLanguage: "ja",
  targetLanguage: "en-US",
  backTranslation: "Synthetic back translation.",
  signals: [
    {
      kind: "referent-risk",
      confidence: "low",
      sourceSpanId: null,
      note: "The referent may merit source-aware review.",
    },
  ],
} as const;

export const renderAndOcrResultExample = {
  schemaVersion: RENDER_AND_OCR_RESULT_SCHEMA_VERSION,
  tool: "render_and_ocr",
  ...localizationEnvelope,
  page: completePage(1),
  patchedBytesHash: H3,
  frames: [
    {
      frameId: "frame:1",
      artifactUri: "https://example.invalid/frame.png",
      contentHash: H4,
      expectedAcceptedOutputId: acceptedOutputExample.outputId,
      observedUnitIds: ["unit:1"],
      width: 1280,
      height: 720,
      ocrText: "Synthetic target line.",
      observations: [
        {
          observationId: "observation:1",
          kind: "replay-coverage",
          status: "PASS",
          unitId: "unit:1",
          detail: "The accepted unit was observed in patched bytes.",
        },
      ],
    },
  ],
} as const;
