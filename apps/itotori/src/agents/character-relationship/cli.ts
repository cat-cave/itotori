import type { AuthorizationActor, ItotoriContextArtifactRepositoryPort } from "@itotori/db";
import { contextArtifactCategoryValues } from "@itotori/db";
import type { ModelProvider, ProviderFamily } from "../../providers/types.js";
import {
  resolveSemanticAgentProvider,
  type SemanticAgentLiveProviderOptions,
} from "../../providers/fake.js";
import {
  generateCharacterRelationships,
  type GenerateCharacterRelationshipsOptions,
} from "./agent.js";
import {
  artifactIsActiveForTemplate,
  loadSemanticArtifacts,
  persistCharacterBioInContext,
  persistCharacterRelationshipInContext,
} from "../semantic-context-store.js";
import { characterNoteArtifactId } from "../../orchestrator/context-brain.js";
import { PROMPT_TEMPLATE_VERSION_V1 } from "./prompt-template.js";
import type {
  BridgeUnitForCharacter,
  CharacterBio,
  CharacterRelationship,
  CharacterRelationshipInput,
  CharacterRelationshipModelProfile,
  CuratedCharacterRef,
} from "./shapes.js";
import type { GlossaryRef } from "../../batch-planner/shapes.js";

export type GenerateCharacterRelationshipsCliInput = {
  projectId: string;
  localeBranchId: string;
  sourceLocale: string;
  sourceRevisionId: string;
  modelProfile: CharacterRelationshipModelProfile;
  characterIdFilter?: string | undefined;
  includeStale?: boolean | undefined;
  dryRun?: boolean | undefined;
};

export type CheckCharacterRelationshipsCliInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  markStale?: boolean | undefined;
};

export type GenerateCharacterRelationshipsCliResult = {
  bios: CharacterBio[];
  relationships: CharacterRelationship[];
  generatedBioCount: number;
  generatedRelationshipCount: number;
  skippedFreshBioCount: number;
};

export type CharacterRelationshipCliDependencies = {
  actor: AuthorizationActor;
  contextArtifactRepository: ItotoriContextArtifactRepositoryPort;
  provider: ModelProvider;
  loadInputContext: (
    actor: AuthorizationActor,
    args: {
      projectId: string;
      localeBranchId: string;
      sourceRevisionId: string;
    },
  ) => Promise<{
    units: BridgeUnitForCharacter[];
    curatedCharacters: CuratedCharacterRef[];
    glossaryExcerpt: GlossaryRef[];
  }>;
  log?: (message: string) => void;
  now?: () => Date;
};

/**
 * Construct the provider for the character-relationship CLI. The `fake`
 * family is reachable ONLY via the explicit
 * `ITOTORI_ALLOW_FAKE_SEMANTIC_AGENT=1` test/dev opt-in. The `openrouter`
 * family is the LIVE path: a real, ZDR-gated `OpenRouterModelProvider`
 * (config-driven pair, cost from real `usage.cost`). Any other non-fake
 * family loud-refuses with a typed error — a real run therefore never feeds
 * fake-derived character context into real translation prompts.
 */
export function resolveCharacterRelationshipProvider(
  family: ProviderFamily,
  live?: SemanticAgentLiveProviderOptions,
): ModelProvider {
  return resolveSemanticAgentProvider({
    agentName: "character-relationship",
    family,
    fakeProviderName: "itotori-character-relationship-fake",
    ...(live !== undefined ? { live } : {}),
  });
}

export async function runGenerateCharacterRelationshipsCli(
  input: GenerateCharacterRelationshipsCliInput,
  deps: CharacterRelationshipCliDependencies,
): Promise<GenerateCharacterRelationshipsCliResult> {
  const log = deps.log ?? noopLog;
  const context = await deps.loadInputContext(deps.actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
  });

  // Skip characters that already have a Fresh bio for this template
  // version unless --include-stale is set. The relationship side is
  // emitted as a full pack per project, so it is regenerated whenever any
  // bio refresh is required.
  let skippedFreshBioCount = 0;
  const charactersToInclude = new Set<string>();
  for (const ref of context.curatedCharacters) {
    if (ref.characterId.trim().length > 0) {
      charactersToInclude.add(ref.characterId);
    }
  }
  for (const unit of context.units) {
    if (unit.speaker && unit.speaker.trim().length > 0) {
      charactersToInclude.add(unit.speaker);
    }
    if (unit.addressees) {
      for (const addressee of unit.addressees) {
        if (addressee.trim().length > 0) {
          charactersToInclude.add(addressee);
        }
      }
    }
  }

  const filteredCharacterId = input.characterIdFilter;
  if (filteredCharacterId !== undefined) {
    for (const id of charactersToInclude) {
      if (id !== filteredCharacterId) {
        charactersToInclude.delete(id);
      }
    }
  }

  // Detect Fresh records up front so we can skip pure regeneration.
  if (!input.includeStale) {
    const existingArtifacts = await loadSemanticArtifacts(
      { actor: deps.actor, repository: deps.contextArtifactRepository },
      {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        categories: [contextArtifactCategoryValues.characterNote],
      },
    );
    for (const characterId of charactersToInclude) {
      const existing = existingArtifacts.find(
        (artifact) =>
          artifact.contextArtifactId === characterNoteArtifactId(input.projectId, characterId) &&
          artifactIsActiveForTemplate(artifact, PROMPT_TEMPLATE_VERSION_V1),
      );
      if (existing !== undefined) {
        charactersToInclude.delete(characterId);
        skippedFreshBioCount += 1;
        log(`skip-fresh characterId=${characterId} artifactId=${existing.contextArtifactId}`);
      }
    }
  }

  if (charactersToInclude.size === 0) {
    return {
      bios: [],
      relationships: [],
      generatedBioCount: 0,
      generatedRelationshipCount: 0,
      skippedFreshBioCount,
    };
  }

  // Emit the full pack in one call so cross-character relationships can
  // be detected. The agent itself emits per-character bios + an edge
  // list; downstream filters by characterId on save.
  const agentInput: CharacterRelationshipInput = {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    sourceLocale: input.sourceLocale,
    units: context.units,
    curatedCharacters: context.curatedCharacters,
    glossaryExcerpt: context.glossaryExcerpt,
    modelProfile: input.modelProfile,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  const options: GenerateCharacterRelationshipsOptions = { provider: deps.provider };
  const output = await generateCharacterRelationships(agentInput, options);

  const finalBios: CharacterBio[] = [];
  for (const bio of output.bios) {
    if (!charactersToInclude.has(bio.characterId)) {
      continue;
    }
    if (input.dryRun) {
      finalBios.push(bio);
    } else {
      finalBios.push(
        await persistCharacterBioInContext(
          { actor: deps.actor, repository: deps.contextArtifactRepository },
          bio,
        ),
      );
    }
    log(`bio characterId=${bio.characterId} bioId=${bio.id} cited=${bio.citedUnitIds.length}`);
  }
  const finalRelationships: CharacterRelationship[] = [];
  for (const relationship of output.relationships) {
    if (
      !charactersToInclude.has(relationship.fromCharacterId) &&
      !charactersToInclude.has(relationship.toCharacterId)
    ) {
      continue;
    }
    if (input.dryRun) {
      finalRelationships.push(relationship);
    } else {
      finalRelationships.push(
        await persistCharacterRelationshipInContext(
          { actor: deps.actor, repository: deps.contextArtifactRepository },
          relationship,
        ),
      );
    }
    log(
      `relationship from=${relationship.fromCharacterId} to=${relationship.toCharacterId} kind=${relationship.kind} cited=${relationship.citedUnitIds.length}`,
    );
  }

  return {
    bios: finalBios,
    relationships: finalRelationships,
    generatedBioCount: finalBios.length,
    generatedRelationshipCount: finalRelationships.length,
    skippedFreshBioCount,
  };
}

export async function runCheckCharacterRelationshipsCli(
  input: CheckCharacterRelationshipsCliInput,
  deps: CharacterRelationshipCliDependencies,
): Promise<CentralCharacterCheckResult> {
  const log = deps.log ?? noopLog;
  const artifacts = await loadSemanticArtifacts(
    { actor: deps.actor, repository: deps.contextArtifactRepository },
    {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      categories: [contextArtifactCategoryValues.characterNote],
    },
  );
  const invalidated =
    input.markStale === true
      ? await deps.contextArtifactRepository.invalidateAffectedArtifacts(deps.actor, {
          projectId: input.projectId,
          localeBranchId: input.localeBranchId,
          sourceRevisionId: input.sourceRevisionId,
          reason: "standalone_cli_check",
        })
      : undefined;
  const invalidatedSet = new Set(invalidated?.invalidatedArtifactIds ?? []);
  const bioArtifacts = artifacts.filter(
    (artifact) =>
      typeof artifact.data.characterId === "string" &&
      typeof artifact.data.fromCharacterId !== "string" &&
      typeof artifact.data.toCharacterId !== "string",
  );
  const relationshipArtifacts = artifacts.filter(
    (artifact) =>
      typeof artifact.data.fromCharacterId === "string" &&
      typeof artifact.data.toCharacterId === "string",
  );
  const result: CentralCharacterCheckResult = {
    scannedBioCount: bioArtifacts.length,
    scannedRelationshipCount: relationshipArtifacts.length,
    driftedBios: bioArtifacts
      .filter((artifact) => invalidatedSet.has(artifact.contextArtifactId))
      .map((artifact) => ({
        characterId: String(artifact.data.characterId),
        characterBioId: artifact.contextArtifactId,
        driftedBridgeUnitIds: artifact.sourceUnits.map((sourceUnit) => sourceUnit.bridgeUnitId),
      })),
    driftedRelationships: relationshipArtifacts
      .filter((artifact) => invalidatedSet.has(artifact.contextArtifactId))
      .map((artifact) => ({
        fromCharacterId: String(artifact.data.fromCharacterId),
        toCharacterId: String(artifact.data.toCharacterId ?? ""),
        characterRelationshipId: artifact.contextArtifactId,
        driftedBridgeUnitIds: artifact.sourceUnits.map((sourceUnit) => sourceUnit.bridgeUnitId),
      })),
    markedStaleBioCount: bioArtifacts.filter((artifact) =>
      invalidatedSet.has(artifact.contextArtifactId),
    ).length,
    markedStaleRelationshipCount: relationshipArtifacts.filter((artifact) =>
      invalidatedSet.has(artifact.contextArtifactId),
    ).length,
  };
  log(
    `scanned bios=${result.scannedBioCount} relationships=${result.scannedRelationshipCount} ` +
      `drifted bios=${result.driftedBios.length} relationships=${result.driftedRelationships.length} ` +
      `marked-stale bios=${result.markedStaleBioCount} relationships=${result.markedStaleRelationshipCount}`,
  );
  for (const drift of result.driftedBios) {
    log(
      `drift bio characterId=${drift.characterId} bioId=${drift.characterBioId} units=${drift.driftedBridgeUnitIds.join(",")}`,
    );
  }
  for (const drift of result.driftedRelationships) {
    log(
      `drift relationship from=${drift.fromCharacterId} to=${drift.toCharacterId} relationshipId=${drift.characterRelationshipId} units=${drift.driftedBridgeUnitIds.join(",")}`,
    );
  }
  return result;
}

export type CentralCharacterCheckResult = {
  scannedBioCount: number;
  scannedRelationshipCount: number;
  driftedBios: Array<{
    characterId: string;
    characterBioId: string;
    driftedBridgeUnitIds: string[];
  }>;
  driftedRelationships: Array<{
    fromCharacterId: string;
    toCharacterId: string;
    characterRelationshipId: string;
    driftedBridgeUnitIds: string[];
  }>;
  markedStaleBioCount: number;
  markedStaleRelationshipCount: number;
};

function noopLog(_message: string): void {
  // intentionally empty
}
