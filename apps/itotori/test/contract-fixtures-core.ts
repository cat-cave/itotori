import {
  ACCEPTED_OUTPUT_SCHEMA_VERSION,
  CONTEXT_SCOPE_SCHEMA_VERSION,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  DEFECT_BUNDLE_SCHEMA_VERSION,
  DRAFT_BATCH_SCHEMA_VERSION,
  FACT_SCHEMA_VERSION,
  LOCALIZATION_SNAPSHOT_SCHEMA_VERSION,
  LOCALIZED_RENDERING_SCHEMA_VERSION,
  REVIEW_VERDICT_SCHEMA_VERSION,
  RUN_MODE_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
} from "../src/contracts/index.js";

export const H1 = `sha256:${"1".repeat(64)}`;
export const H2 = `sha256:${"2".repeat(64)}`;
export const H3 = `sha256:${"3".repeat(64)}`;
export const H4 = `sha256:${"4".repeat(64)}`;
export const NOW = "2026-07-14T12:00:00Z";

export const encrypted = {
  storageRef: "encrypted:payload:1",
  contentHash: H1,
  encryption: "operator-managed",
} as const;

export const routeScope = { kind: "global" } as const;

export const runModeExample = {
  schemaVersion: RUN_MODE_SCHEMA_VERSION,
  runMode: "production",
} as const;

export const contextScopeExample = {
  schemaVersion: CONTEXT_SCOPE_SCHEMA_VERSION,
  contextScope: "whole-game",
} as const;

const revision = (name: string, contentHash = H1) => ({ revisionId: name, contentHash });

export const contextSnapshotExample = {
  schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  snapshotId: "snapshot:context:1",
  contentHash: H1,
  sourceLanguage: "ja",
  decode: revision("decode:1"),
  structure: revision("structure:1"),
  routeGraph: revision("route-graph:1"),
  glossary: revision("glossary:1"),
  style: revision("style:1"),
  humanCorrections: revision("human-corrections:1"),
  externalSources: null,
  sourceUnits: [{ unitId: "unit:1", sourceHash: H2 }],
  revealHorizon: { kind: "complete" },
  contextScope: "whole-game",
} as const;

export const localizationSnapshotExample = {
  schemaVersion: LOCALIZATION_SNAPSHOT_SCHEMA_VERSION,
  snapshotId: "snapshot:localization:1",
  contentHash: H2,
  contextSnapshot: { id: contextSnapshotExample.snapshotId, hash: H1 },
  targetLanguage: "en-US",
  localeBranchId: "locale-branch:1",
  acceptedBibleHead: { headId: "bible-head:1", version: 1, contentHash: H3 },
  acceptedTargetOutputHead: null,
} as const;

export const unitFactExample = {
  schemaVersion: FACT_SCHEMA_VERSION,
  factId: "fact:unit:1",
  snapshotId: contextSnapshotExample.snapshotId,
  hash: H2,
  visibility: { routeScope, fromPlayOrder: 0, throughPlayOrder: null },
  source: "decode",
  value: {
    kind: "unit",
    unitId: "unit:1",
    bridgeUnitId: "bridge-unit:1",
    sceneId: "scene:1",
    playOrderIndex: 0,
    sourceHash: H2,
    sourceSurface: "Synthetic source line.",
    sourceSkeleton: "Synthetic {name} line.",
    surfaceKind: "dialogue",
    speaker: {
      status: "known",
      rawName: "Speaker",
      resolvedDisplayName: "Speaker",
      revealSafeLabel: "Speaker",
      canonicalCharacterId: "character:1",
      color: { red: 10, green: 20, blue: 30 },
    },
    choiceContext: null,
    protectedPlaceholders: [
      { placeholderId: "placeholder:1", kind: "variable", sourceText: "{name}" },
    ],
    sourceAssetRef: "asset:1",
    byteOffset: 0,
    byteLength: 16,
    rawByteHandle: "raw-bytes:1",
    routeScopes: [routeScope],
  },
} as const;

export const sceneFactExample = {
  ...unitFactExample,
  factId: "fact:scene:1",
  value: {
    kind: "scene",
    sceneId: "scene:1",
    playOrderIndex: 0,
    unitIds: ["unit:1"],
    speakerCharacterIds: ["character:1"],
    choiceIds: [],
    predecessorSceneIds: [],
    successorSceneIds: [],
    routeScopes: [routeScope],
  },
} as const;

export const routeNodeFactExample = {
  ...unitFactExample,
  factId: "fact:route-node:1",
  value: {
    kind: "route-node",
    nodeId: "route-node:1",
    nodeKind: "scene",
    sceneId: "scene:1",
    playOrderIndex: 0,
    predecessors: [],
    successors: ["route-node:2"],
    reachable: true,
    routeScopes: [routeScope],
  },
} as const;

export const routeEdgeFactExample = {
  ...unitFactExample,
  factId: "fact:route-edge:1",
  value: {
    kind: "route-edge",
    edgeId: "route-edge:1",
    fromNodeId: "route-node:1",
    toNodeId: "route-node:2",
    edgeKind: "dispatch",
    optionIndex: null,
    evidenceId: "evidence:edge:1",
    completeness: "complete",
  },
} as const;

export const characterOccurrenceFactExample = {
  ...unitFactExample,
  factId: "fact:character:1",
  value: {
    kind: "character-occurrence",
    characterId: "character:1",
    decodedLabel: "Speaker",
    revealStatus: "revealed",
    sceneIds: ["scene:1"],
    unitIds: ["unit:1"],
    linesByScene: [{ sceneId: "scene:1", lineCount: 1 }],
    totalLines: 1,
    firstSceneId: "scene:1",
    lastSceneId: "scene:1",
  },
} as const;

export const glossaryFactExample = {
  schemaVersion: FACT_SCHEMA_VERSION,
  factId: "fact:term:1",
  snapshotId: localizationSnapshotExample.snapshotId,
  hash: H3,
  visibility: { routeScope, fromPlayOrder: 0, throughPlayOrder: null },
  source: "glossary",
  value: {
    kind: "glossary-entry",
    termId: "term:1",
    sourceForm: "source-term",
    aliases: [],
    forms: [{ language: "en-US", form: "target term", status: "preferred" }],
    scope: routeScope,
    occurrenceUnitIds: ["unit:1"],
    conflictsWithTermIds: [],
    revision: revision("glossary:1", H3),
  },
} as const;

export const humanNoteFactExample = {
  schemaVersion: FACT_SCHEMA_VERSION,
  factId: "fact:note:1",
  snapshotId: contextSnapshotExample.snapshotId,
  hash: H4,
  visibility: { routeScope, fromPlayOrder: 0, throughPlayOrder: null },
  source: "human-note",
  value: {
    kind: "human-note",
    noteId: "note:1",
    excerpt: "Keep the register direct.",
    revision: revision("notes:1", H4),
    scope: routeScope,
  },
} as const;

export const draftBatchExample = {
  schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
  localizationSnapshotId: localizationSnapshotExample.snapshotId,
  batchId: "batch:1",
  scope: { kind: "whole-scene", sceneId: "scene:1", expectedUnitIds: ["unit:1"] },
  drafts: [
    {
      unitId: "unit:1",
      sourceHash: H2,
      targetSkeleton: "Synthetic {name} target.",
      evidenceIds: [unitFactExample.factId],
      basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
      uncertainty: ["none"],
    },
  ],
} as const;

export const reviewVerdictExample = {
  schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
  reviewId: "review:1",
  localizationSnapshotId: localizationSnapshotExample.snapshotId,
  roleId: "Q1",
  rubric: "meaning",
  unitId: "unit:1",
  basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
  verdict: "PASS",
  severity: "none",
  span: null,
  category: null,
  evidenceIds: [unitFactExample.factId],
  repairConstraint: null,
} as const;

export const defectBundleExample = {
  schemaVersion: DEFECT_BUNDLE_SCHEMA_VERSION,
  bundleId: "defects:1",
  localizationSnapshotId: localizationSnapshotExample.snapshotId,
  draftBatchId: draftBatchExample.batchId,
  defects: [
    {
      defectId: "defect:1",
      unitId: "unit:1",
      category: "protected-span",
      severity: "major",
      span: { spanId: "span:1", surface: "target", text: "{name}" },
      evidenceIds: [unitFactExample.factId],
      basisFactIds: [unitFactExample.factId],
      repairConstraint: "Restore the protected placeholder.",
      implicatedGates: ["protected-spans"],
      implicatedReviewLanes: [],
      origin: "deterministic",
      gate: "protected-spans",
    },
  ],
  factDominance: [],
  resolution: "repair",
} as const;

export const wikiObjectExample = {
  schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
  objectId: "wiki:style:1",
  kind: "style-contract",
  version: 1,
  lang: "ja",
  subject: { kind: "game", id: "project:1" },
  scope: routeScope,
  body: {
    registerPolicy: "Use a direct register.",
    honorificPolicy: "Preserve meaningful honorifics.",
    nameOrder: "source-order",
    profanityCeiling: "mild",
    punctuationRules: ["Use target-language punctuation."],
    audienceNote: "General audience.",
  },
  claims: [
    {
      claimId: "claim:style:1",
      statement: "The source uses a direct register.",
      scope: routeScope,
      kind: "style",
      confidence: "high",
      citations: [
        {
          evidenceId: unitFactExample.factId,
          evidenceHash: H2,
          snapshotId: contextSnapshotExample.snapshotId,
          subject: { kind: "unit", id: "unit:1" },
          role: "supports",
          playOrderIndex: 0,
        },
      ],
    },
  ],
  media: [],
  dependencies: [],
  provenance: {
    authorMemoKey: H1,
    authorRoleId: "A1",
    editedBy: "agent",
    snapshotKind: "context",
    contextSnapshotId: contextSnapshotExample.snapshotId,
    contextScope: "whole-game",
    runMode: "production",
  },
  provisional: true,
} as const;

export const localizedRenderingExample = {
  schemaVersion: LOCALIZED_RENDERING_SCHEMA_VERSION,
  renderingId: "rendering:1",
  sourceObjectId: wikiObjectExample.objectId,
  sourceObjectKind: "style-contract",
  targetLanguage: "en-US",
  version: 1,
  scope: routeScope,
  body: {
    kind: "style-contract",
    registerGuidance: "Use a direct register.",
    honorificGuidance: "Preserve meaningful honorifics.",
    nameOrder: "source-order",
    profanityCeiling: "mild",
    punctuationRules: ["Use English punctuation."],
  },
  claimRenderings: [
    { claimId: "claim:style:1", text: "The source uses a direct register.", canonicalForms: [] },
  ],
  dependencies: [],
  provenance: {
    basisSourceVersion: 1,
    authorMemoKey: H1,
    editedBy: "agent",
    localizationSnapshotId: localizationSnapshotExample.snapshotId,
    runMode: "production",
  },
  provisional: true,
} as const;

export const acceptedOutputExample = {
  schemaVersion: ACCEPTED_OUTPUT_SCHEMA_VERSION,
  outputId: "output:unit:1",
  version: 1,
  parentOutputIds: [],
  memoKeys: [H1],
  evidenceIds: [unitFactExample.factId],
  acceptedAt: NOW,
  releaseEligibility: {
    kind: "shippable",
    runMode: "production",
    contextScope: "whole-game",
    basis: "wiki-first",
  },
  subjectType: "unit",
  subjectId: "unit:1",
  localizationSnapshotId: localizationSnapshotExample.snapshotId,
  stage: "final",
  sourceHash: H2,
  value: {
    targetSkeleton: "Synthetic {name} target.",
    targetHash: H3,
    translationObjectId: "wiki:translation:1",
    translationObjectVersion: 1,
    parentDraftBatchId: draftBatchExample.batchId,
    basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:1"] },
    gateReceipts: [{ gate: "protected-spans", evidenceHash: H4, status: "PASS" }],
    reviewVerdictIds: [reviewVerdictExample.reviewId],
  },
} as const;
