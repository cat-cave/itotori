import type { z } from "zod";
import { AcceptedOutputSchema } from "./accepted.js";
import {
  CallResultSchema,
  CallSpecSchema,
  PhysicalStepMemoKeySchema,
  PhysicalStepMemoSchema,
  PhysicalStepMemoValueSchema,
} from "./calls.js";
import {
  ContextSnapshotSchema,
  ConversationEventSchema,
  FactSchema,
  LocalizationSnapshotSchema,
} from "./context.js";
import { DefectBundleSchema, DraftBatchSchema, ReviewVerdictSchema } from "./outputs.js";
import { ContextScopeSchema, RunModeSchema } from "./shared.js";
import {
  BackTranslateResultSchema,
  DecodeGetCharacterOccurrencesResultSchema,
  DecodeGetNeighborsResultSchema,
  DecodeGetRouteGraphResultSchema,
  DecodeGetUnitsResultSchema,
  GlossaryLookupResultSchema,
  OutputsGetAcceptedResultSchema,
  ReferencesSearchResultSchema,
  RenderAndOcrResultSchema,
  WebSearchResultSchema,
} from "./tools.js";
import { LocalizedRenderingSchema, WikiObjectSchema } from "./wiki.js";

/** The canonical terminal inventory is used by strictness and provider-schema gates. */
export const terminalContractSchemas = {
  runMode: RunModeSchema,
  contextScope: ContextScopeSchema,
  callSpec: CallSpecSchema,
  callResult: CallResultSchema as z.ZodType,
  physicalStepMemoKey: PhysicalStepMemoKeySchema,
  physicalStepMemoValue: PhysicalStepMemoValueSchema,
  physicalStepMemo: PhysicalStepMemoSchema,
  contextSnapshot: ContextSnapshotSchema,
  localizationSnapshot: LocalizationSnapshotSchema,
  conversationEvent: ConversationEventSchema,
  fact: FactSchema,
  wikiObject: WikiObjectSchema,
  localizedRendering: LocalizedRenderingSchema,
  draftBatch: DraftBatchSchema,
  reviewVerdict: ReviewVerdictSchema,
  defectBundle: DefectBundleSchema,
  acceptedOutput: AcceptedOutputSchema,
  decodeGetUnitsResult: DecodeGetUnitsResultSchema,
  decodeGetNeighborsResult: DecodeGetNeighborsResultSchema,
  decodeGetRouteGraphResult: DecodeGetRouteGraphResultSchema,
  decodeGetCharacterOccurrencesResult: DecodeGetCharacterOccurrencesResultSchema,
  glossaryLookupResult: GlossaryLookupResultSchema,
  outputsGetAcceptedResult: OutputsGetAcceptedResultSchema,
  referencesSearchResult: ReferencesSearchResultSchema,
  webSearchResult: WebSearchResultSchema,
  backTranslateResult: BackTranslateResultSchema,
  renderAndOcrResult: RenderAndOcrResultSchema,
} as const satisfies Readonly<Record<string, z.ZodType>>;

export type TerminalContractName = keyof typeof terminalContractSchemas;
