// Lightweight closed value sets for api-schema guards.
//
// These mirror the persisted DB enums/lists without importing the DB package
// root. The API schema guards run in both Node and the browser client; pulling
// `@itotori/db` into the browser bundle drags Node-only repository/pg code.

// itotori-translation-scope-settings — mirrors
// `translationScopeValues`/`TranslationScope` (packages/itotori-db +
// apps/itotori/src/orchestrator/project-driven-executor.ts). Cumulative
// tiers: dialogue-only -> dialogue-and-choices -> dialogue-choices-ui -> all.
export const translationScopeValues = {
  dialogueOnly: "dialogue-only",
  dialogueAndChoices: "dialogue-and-choices",
  dialogueChoicesUi: "dialogue-choices-ui",
  all: "all",
} as const;

export const catalogSourceValues = {
  vndb: "vndb",
  egs: "egs",
  dlsite: "dlsite",
  steam: "steam",
  igdb: "igdb",
  wikidata: "wikidata",
  localCorpus: "local_corpus",
  kaifuu: "kaifuu",
  manual: "manual",
} as const;

export const catalogSourceRecordKindValues = {
  rawCache: "raw_cache",
  normalizedRecord: "normalized_record",
  recordedFixture: "recorded_fixture",
  localScan: "local_scan",
  manualAssertion: "manual_assertion",
  importerRequest: "importer_request",
} as const;

export const catalogRawContentRedactionClassValues = {
  publicRaw: "public_raw",
  publicMetadata: "public_metadata",
  privateCorpus: "private_corpus",
  redacted: "redacted",
} as const;

export const catalogExternalIdKindValues = {
  sourceRecord: "source_record",
  releaseRecord: "release_record",
  storeProduct: "store_product",
  knowledgeBaseEntity: "knowledge_base_entity",
  localDetection: "local_detection",
  manualAlias: "manual_alias",
} as const;

export const catalogConfidenceValues = {
  high: "high",
  medium: "medium",
  low: "low",
  unknown: "unknown",
} as const;

export const catalogLanguageStatusValues = {
  officialFull: "official_full",
  fanFull: "fan_full",
  fanPartial: "fan_partial",
  mtl: "mtl",
  interfaceOnly: "interface_only",
  none: "none",
  unverifiedConsole: "unverified_console",
  unknown: "unknown",
} as const;

export const catalogLanguageStatusScopeValues = {
  work: "work",
  release: "release",
  platform: "platform",
} as const;

export const catalogConflictKindValues = {
  externalId: "external_id",
  languageStatus: "language_status",
  release: "release",
  title: "title",
  engine: "engine",
  unknown: "unknown",
} as const;

export const catalogConflictStatusValues = {
  open: "open",
  resolved: "resolved",
  ignored: "ignored",
} as const;

export const catalogCandidateMatchStatusValues = {
  reviewPending: "review_pending",
  duplicateSource: "duplicate_source",
} as const;

export const catalogCompletenessPoolValues = {
  mtlOnly: "mtl_only",
  fanPartial: "fan_partial",
  noEnglish: "no_english",
  unknown: "unknown",
  conflict: "conflict",
} as const;

export const assetLocalizationDecisionAssetKindValues = {
  imageWithText: "image_with_text",
  songTitle: "song_title",
  uiArt: "ui_art",
  font: "font",
  video: "video",
  romanization: "romanization",
  fullLocalization: "full_localization",
  doNotTranslate: "do_not_translate",
} as const;

export const assetLocalizationDecisionPolicyValues = {
  keepOriginal: "keep_original",
  translateText: "translate_text",
  swapWithReplacement: "swap_with_replacement",
  romanize: "romanize",
  fullLocalize: "full_localize",
  skip: "skip",
} as const;

export const assetLocalizationDecisionAssetKindList = Object.values(
  assetLocalizationDecisionAssetKindValues,
);

export const assetLocalizationDecisionPolicyList = Object.values(
  assetLocalizationDecisionPolicyValues,
);

export const feedbackTypeValues = {
  objectiveDefect: "objective_defect",
  stylePreference: "style_preference",
  glossaryCanonIssue: "glossary_canon_issue",
  unclearContext: "unclear_context",
  runtimeIssue: "runtime_issue",
  assetIssue: "asset_issue",
} as const;

export const reviewerQueueItemKindValues = {
  qa: "qa",
  style: "style",
  glossary: "glossary",
  feedback: "feedback",
  runtimeEvidence: "runtime_evidence",
} as const;

export const reviewerQueueItemStateValues = {
  pending: "pending",
  inReview: "in_review",
  accepted: "accepted",
  rejected: "rejected",
  repairRequested: "repair_requested",
  deferred: "deferred",
  escalated: "escalated",
} as const;

export const reviewerQueueActionValues = {
  approve: "approve",
  reject: "reject",
  defer: "defer",
  escalate: "escalate",
  importRuntimeFeedback: "import_runtime_feedback",
} as const;

export const reviewerQueueItemKindList = Object.values(reviewerQueueItemKindValues);
export const reviewerQueueItemStateList = Object.values(reviewerQueueItemStateValues);
export const reviewerQueueActionList = Object.values(reviewerQueueActionValues);

export const wikiEntryKindValues = {
  character: "character",
  term: "term",
} as const;

/** Browser-safe mirror of the generic node-6 context wiki kinds. */
export const wikiContextEntryKindValues = {
  scene: "scene",
  character: "character",
  route: "route",
  term: "term",
  speaker: "speaker",
  glossary: "glossary",
  style: "style",
  note: "note",
} as const;

export const wikiContextEntryKindList = Object.values(wikiContextEntryKindValues);
