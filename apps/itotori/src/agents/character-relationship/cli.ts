import type { AuthorizationActor, ItotoriCharacterRelationshipRepositoryPort } from "@itotori/db";
import { FakeModelProvider } from "../../providers/fake.js";
import type { ModelProvider, ProviderFamily } from "../../providers/types.js";
import {
  generateCharacterRelationships,
  type GenerateCharacterRelationshipsOptions,
} from "./agent.js";
import { persistCharacterBio, persistCharacterRelationship } from "./persistence.js";
import { PROMPT_TEMPLATE_VERSION_V1 } from "./prompt-template.js";
import {
  markStaleCharacterArtifactsForRevision,
  type CharacterStalenessScanResult,
} from "./staleness.js";
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
  repository: ItotoriCharacterRelationshipRepositoryPort;
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
 * Construct a default provider for the CLI. Live providers are opt-in via
 * env: `ITOTORI_LIVE_PROVIDER=1` must be set to allow any non-fake family.
 * Mirrors the scene-summary CLI posture (ADR 0002).
 */
export function resolveCharacterRelationshipProvider(family: ProviderFamily): ModelProvider {
  if (family === "fake") {
    return new FakeModelProvider({ providerName: "itotori-character-relationship-fake" });
  }
  if (process.env.ITOTORI_LIVE_PROVIDER !== "1") {
    throw new Error(
      `character-relationship CLI refused to construct provider family '${family}': set ITOTORI_LIVE_PROVIDER=1 to opt in`,
    );
  }
  throw new Error(
    `character-relationship CLI does not yet support provider family '${family}' in this entry point`,
  );
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
    for (const id of [...charactersToInclude]) {
      if (id !== filteredCharacterId) {
        charactersToInclude.delete(id);
      }
    }
  }

  // Detect Fresh records up front so we can skip pure regeneration.
  if (!input.includeStale) {
    for (const characterId of [...charactersToInclude]) {
      const existing = await deps.repository.loadBioByCharacter(deps.actor, {
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        characterId,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION_V1,
      });
      if (existing?.status === "Fresh") {
        charactersToInclude.delete(characterId);
        skippedFreshBioCount += 1;
        log(`skip-fresh characterId=${characterId} bioId=${existing.characterBioId}`);
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
      finalBios.push(await persistCharacterBio(deps.repository, deps.actor, bio));
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
        await persistCharacterRelationship(deps.repository, deps.actor, relationship),
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
): Promise<CharacterStalenessScanResult> {
  const log = deps.log ?? noopLog;
  const result = await markStaleCharacterArtifactsForRevision(deps.repository, deps.actor, {
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    markStale: input.markStale ?? false,
  });
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

function noopLog(_message: string): void {
  // intentionally empty
}
