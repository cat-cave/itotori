// The one durable home for semantic-agent output.
//
// Scene summaries, character notes, route maps, and terminology candidates
// used to have one table family per agent. That made the standalone CLIs a
// parallel context system beside the live loop. This module projects each
// agent's already-validated output into the central context-artifact store
// used by the loop and by all downstream readers.

import {
  contextArtifactCategoryValues,
  contextArtifactStatusValues,
  type AuthorizationActor,
  type ContextArtifactRecord,
  type ContextArtifactSourceUnitInput,
  type ItotoriContextArtifactRepositoryPort,
} from "@itotori/db";
import {
  characterNoteArtifactId,
  characterRelationshipArtifactId,
  routeMapArtifactId,
  sceneSummaryArtifactId,
  terminologyCandidateArtifactId,
} from "../orchestrator/context-brain.js";
import type { CharacterBio, CharacterRelationship } from "./character-relationship/shapes.js";
import type { RouteChoice, RouteMap } from "./route-choice-map/shapes.js";
import type { SceneSummary } from "./scene-summary/shapes.js";
import type { TerminologyCandidate } from "./terminology-candidate/shapes.js";

const PRODUCER_TOOL = "tool.context-brain";

export type CentralSemanticArtifactDependencies = {
  actor: AuthorizationActor;
  repository: ItotoriContextArtifactRepositoryPort;
};

export type SemanticArtifactQuery = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  categories: readonly string[];
};

/** Read central semantic artifacts, including stale rows for CLI inspection. */
export async function loadSemanticArtifacts(
  deps: CentralSemanticArtifactDependencies,
  query: SemanticArtifactQuery,
): Promise<ContextArtifactRecord[]> {
  const result = await deps.repository.retrieveArtifacts(deps.actor, {
    projectId: query.projectId,
    localeBranchId: query.localeBranchId,
    sourceRevisionId: query.sourceRevisionId,
    categories: query.categories,
    includeStale: true,
    limit: 500,
  });
  if (result.status !== "completed") {
    const detail = result.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
    throw new Error(`context artifact retrieval failed: ${detail || "unknown diagnostic"}`);
  }
  return result.matches;
}

export function artifactIsActiveForTemplate(
  artifact: ContextArtifactRecord,
  promptTemplateVersion: string,
): boolean {
  const metadataTemplateVersion = artifactDataString(artifact, "promptTemplateVersion");
  return (
    artifact.status === contextArtifactStatusValues.active &&
    (metadataTemplateVersion ?? artifact.producerVersion) === promptTemplateVersion
  );
}

export function artifactDataString(
  artifact: ContextArtifactRecord,
  key: string,
): string | undefined {
  const value = artifact.data[key];
  return typeof value === "string" ? value : undefined;
}

export function artifactDataStringArray(artifact: ContextArtifactRecord, key: string): string[] {
  const value = artifact.data[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

// These builders are intentionally shared by the standalone CLIs and the
// live agentic loop. A central artifact is one canonical serialized shape,
// not merely one table with subtly different producers.
export function sceneSummaryArtifactData(summary: SceneSummary): Record<string, unknown> {
  return {
    semanticKind: "scene_summary",
    sceneId: summary.sceneId,
    summaryLocale: summary.summaryLocale,
    citedUnitIds: summary.citedUnitIds,
    citedUnitHashes: summary.citedUnitHashes,
    modelProfile: summary.modelProfile,
    promptTemplateVersion: summary.promptTemplateVersion,
    promptHash: summary.promptHash,
    inputTokenEstimate: summary.inputTokenEstimate,
    completionTokens: summary.completionTokens,
    generatedAt: summary.generatedAt,
  };
}

export function characterBioArtifactData(bio: CharacterBio): Record<string, unknown> {
  return {
    semanticKind: "character_bio",
    characterId: bio.characterId,
    bioLocale: bio.bioLocale,
    citedUnitIds: bio.citedUnitIds,
    citedUnitHashes: bio.citedUnitHashes,
    modelProfile: bio.modelProfile,
    promptTemplateVersion: bio.promptTemplateVersion,
    promptHash: bio.promptHash,
    inputTokenEstimate: bio.inputTokenEstimate,
    completionTokens: bio.completionTokens,
    generatedAt: bio.generatedAt,
  };
}

export function characterRelationshipArtifactData(
  relationship: CharacterRelationship,
): Record<string, unknown> {
  return {
    semanticKind: "character_relationship",
    fromCharacterId: relationship.fromCharacterId,
    toCharacterId: relationship.toCharacterId,
    kind: relationship.kind,
    direction: relationship.direction,
    descriptorLocale: relationship.descriptorLocale,
    citedUnitIds: relationship.citedUnitIds,
    citedUnitHashes: relationship.citedUnitHashes,
    modelProfile: relationship.modelProfile,
    promptTemplateVersion: relationship.promptTemplateVersion,
    promptHash: relationship.promptHash,
    generatedAt: relationship.generatedAt,
  };
}

export function routeMapArtifactData(route: RouteMap): Record<string, unknown> {
  return {
    semanticKind: "route_map",
    routeKey: route.routeKey,
    routeTitle: route.routeTitle,
    mapLocale: route.mapLocale,
    citedUnitIds: route.citedUnitIds,
    citedUnitHashes: route.citedUnitHashes,
    modelProfile: route.modelProfile,
    promptTemplateVersion: route.promptTemplateVersion,
    promptHash: route.promptHash,
    inputTokenEstimate: route.inputTokenEstimate,
    completionTokens: route.completionTokens,
    generatedAt: route.generatedAt,
  };
}

export function routeChoiceArtifactData(choice: RouteChoice): Record<string, unknown> {
  return {
    semanticKind: "route_choice",
    choiceKey: choice.choiceKey,
    kind: choice.kind,
    fromRouteKey: choice.fromRouteKey,
    mapLocale: choice.mapLocale,
    options: choice.options,
    citedUnitIds: choice.citedUnitIds,
    citedUnitHashes: choice.citedUnitHashes,
    modelProfile: choice.modelProfile,
    promptTemplateVersion: choice.promptTemplateVersion,
    promptHash: choice.promptHash,
    generatedAt: choice.generatedAt,
  };
}

export function terminologyCandidateArtifactData(
  candidate: TerminologyCandidate,
): Record<string, unknown> {
  return {
    semanticKind: "terminology_candidate",
    surfaceForm: candidate.surfaceForm,
    surfaceLocale: candidate.surfaceLocale,
    kind: candidate.kind,
    rationale: candidate.rationale,
    readingHint: candidate.readingHint,
    citedUnitIds: candidate.citedUnitIds,
    citedUnitHashes: candidate.citedUnitHashes,
    modelProfile: candidate.modelProfile,
    promptTemplateVersion: candidate.promptTemplateVersion,
    promptHash: candidate.promptHash,
    inputTokenEstimate: candidate.inputTokenEstimate,
    completionTokens: candidate.completionTokens,
    generatedAt: candidate.generatedAt,
  };
}

export async function persistSceneSummaryInContext(
  deps: CentralSemanticArtifactDependencies,
  summary: SceneSummary,
): Promise<SceneSummary> {
  const record = await deps.repository.upsertArtifact(deps.actor, {
    contextArtifactId: sceneSummaryArtifactId(summary.projectId, summary.sceneId),
    projectId: summary.projectId,
    localeBranchId: summary.localeBranchId,
    sourceRevisionId: summary.sourceRevisionId,
    category: contextArtifactCategoryValues.sceneSummary,
    title: `Scene summary ${summary.sceneId}`,
    body: summary.summaryText,
    data: sceneSummaryArtifactData(summary),
    producedByAgent: "scene-summary",
    producedByTool: PRODUCER_TOOL,
    producerVersion: summary.promptTemplateVersion,
    provenance: {
      kind: "semantic_enrichment",
      agentLabel: "scene-summary",
      promptHash: summary.promptHash,
    },
    sourceUnits: citations(
      summary.citedUnitIds,
      summary.citedUnitHashes,
      `scene:${summary.sceneId}`,
    ),
  });
  return withCentralArtifactId(summary, record.contextArtifactId);
}

export async function persistCharacterBioInContext(
  deps: CentralSemanticArtifactDependencies,
  bio: CharacterBio,
): Promise<CharacterBio> {
  const record = await deps.repository.upsertArtifact(deps.actor, {
    contextArtifactId: characterNoteArtifactId(bio.projectId, bio.characterId),
    projectId: bio.projectId,
    localeBranchId: bio.localeBranchId,
    sourceRevisionId: bio.sourceRevisionId,
    category: contextArtifactCategoryValues.characterNote,
    title: `Character: ${bio.characterId}`,
    body: bio.bioText,
    data: characterBioArtifactData(bio),
    producedByAgent: "character-relationship",
    producedByTool: PRODUCER_TOOL,
    producerVersion: bio.promptTemplateVersion,
    provenance: {
      kind: "semantic_enrichment",
      agentLabel: "character-relationship",
      promptHash: bio.promptHash,
    },
    sourceUnits: citations(bio.citedUnitIds, bio.citedUnitHashes, `character:${bio.characterId}`),
  });
  return withCentralArtifactId(bio, record.contextArtifactId);
}

export async function persistCharacterRelationshipInContext(
  deps: CentralSemanticArtifactDependencies,
  relationship: CharacterRelationship,
): Promise<CharacterRelationship> {
  const key = `${relationship.fromCharacterId}->${relationship.toCharacterId}:${relationship.kind}`;
  const record = await deps.repository.upsertArtifact(deps.actor, {
    contextArtifactId: characterRelationshipArtifactId(relationship.projectId, key),
    projectId: relationship.projectId,
    localeBranchId: relationship.localeBranchId,
    sourceRevisionId: relationship.sourceRevisionId,
    category: contextArtifactCategoryValues.characterNote,
    title: `Relationship: ${key}`,
    body: relationship.descriptor,
    data: characterRelationshipArtifactData(relationship),
    producedByAgent: "character-relationship",
    producedByTool: PRODUCER_TOOL,
    producerVersion: relationship.promptTemplateVersion,
    provenance: {
      kind: "semantic_enrichment",
      agentLabel: "character-relationship",
      promptHash: relationship.promptHash,
    },
    sourceUnits: citations(
      relationship.citedUnitIds,
      relationship.citedUnitHashes,
      `character-relationship:${key}`,
    ),
  });
  return withCentralArtifactId(relationship, record.contextArtifactId);
}

export async function persistRouteMapInContext(
  deps: CentralSemanticArtifactDependencies,
  route: RouteMap,
): Promise<RouteMap> {
  const record = await deps.repository.upsertArtifact(deps.actor, {
    contextArtifactId: routeMapArtifactId(route.projectId, route.routeKey),
    projectId: route.projectId,
    localeBranchId: route.localeBranchId,
    sourceRevisionId: route.sourceRevisionId,
    category: contextArtifactCategoryValues.routeMap,
    title: route.routeTitle || `Route: ${route.routeKey}`,
    body: route.routeSummary,
    data: routeMapArtifactData(route),
    producedByAgent: "route-choice-map",
    producedByTool: PRODUCER_TOOL,
    producerVersion: route.promptTemplateVersion,
    provenance: {
      kind: "semantic_enrichment",
      agentLabel: "route-choice-map",
      promptHash: route.promptHash,
    },
    sourceUnits: citations(route.citedUnitIds, route.citedUnitHashes, `route:${route.routeKey}`),
  });
  return withCentralArtifactId(route, record.contextArtifactId);
}

export async function persistRouteChoiceInContext(
  deps: CentralSemanticArtifactDependencies,
  choice: RouteChoice,
): Promise<RouteChoice> {
  const record = await deps.repository.upsertArtifact(deps.actor, {
    contextArtifactId: routeMapArtifactId(choice.projectId, `choice:${choice.choiceKey}`),
    projectId: choice.projectId,
    localeBranchId: choice.localeBranchId,
    sourceRevisionId: choice.sourceRevisionId,
    category: contextArtifactCategoryValues.routeMap,
    title: `Choice: ${choice.choiceKey}`,
    body: choice.promptSummary,
    data: routeChoiceArtifactData(choice),
    producedByAgent: "route-choice-map",
    producedByTool: PRODUCER_TOOL,
    producerVersion: choice.promptTemplateVersion,
    provenance: {
      kind: "semantic_enrichment",
      agentLabel: "route-choice-map",
      promptHash: choice.promptHash,
    },
    sourceUnits: citations(
      choice.citedUnitIds,
      choice.citedUnitHashes,
      `choice:${choice.choiceKey}`,
    ),
  });
  return withCentralArtifactId(choice, record.contextArtifactId);
}

export async function persistTerminologyCandidateInContext(
  deps: CentralSemanticArtifactDependencies,
  candidate: TerminologyCandidate,
): Promise<TerminologyCandidate> {
  const record = await deps.repository.upsertArtifact(deps.actor, {
    contextArtifactId: terminologyCandidateArtifactId(candidate.projectId, candidate.surfaceForm),
    projectId: candidate.projectId,
    localeBranchId: candidate.localeBranchId,
    sourceRevisionId: candidate.sourceRevisionId,
    category: contextArtifactCategoryValues.terminologyCandidate,
    title: `Term candidate: ${candidate.surfaceForm}`,
    body: `${candidate.surfaceForm} (${candidate.kind}): ${candidate.rationale}`,
    data: terminologyCandidateArtifactData(candidate),
    producedByAgent: "terminology-candidate",
    producedByTool: PRODUCER_TOOL,
    producerVersion: candidate.promptTemplateVersion,
    provenance: {
      kind: "semantic_enrichment",
      agentLabel: "terminology-candidate",
      promptHash: candidate.promptHash,
    },
    sourceUnits: citations(
      candidate.citedUnitIds,
      candidate.citedUnitHashes,
      `terminology:${candidate.surfaceForm}`,
    ),
  });
  return withCentralArtifactId(candidate, record.contextArtifactId);
}

function citations(
  ids: readonly string[],
  hashes: readonly string[],
  citation: string,
): ContextArtifactSourceUnitInput[] {
  if (ids.length === 0) {
    throw new Error(`central semantic artifact ${citation} must cite at least one source unit`);
  }
  if (ids.length !== hashes.length) {
    throw new Error(`central semantic artifact ${citation} has mismatched citation hashes`);
  }
  return ids.map((bridgeUnitId, index) => ({
    bridgeUnitId,
    citation,
    metadata: { sourceHash: hashes[index] ?? "" },
  }));
}

function withCentralArtifactId<T extends { id: string }>(value: T, contextArtifactId: string): T {
  return { ...value, id: contextArtifactId };
}
