import { describe, expect, it } from "vitest";
import type {
  AuthorizationActor,
  CharacterBioRecord,
  CharacterRelationshipDirection,
  CharacterRelationshipInvalidatedReason,
  CharacterRelationshipKind,
  CharacterRelationshipRecord,
  ItotoriCharacterRelationshipRepositoryPort,
  SaveCharacterBioInput,
  SaveCharacterRelationshipInput,
} from "@itotori/db";
import { markStaleCharacterArtifactsForRevision } from "../src/agents/character-relationship/index.js";

class InMemoryCharacterRelationshipRepository implements ItotoriCharacterRelationshipRepositoryPort {
  public bios = new Map<string, CharacterBioRecord>();
  public relationships = new Map<string, CharacterRelationshipRecord>();
  public sourceHashes = new Map<string, string>();

  async saveBio(
    _actor: AuthorizationActor,
    input: SaveCharacterBioInput,
  ): Promise<CharacterBioRecord> {
    const record: CharacterBioRecord = {
      characterBioId: input.characterBioId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      characterId: input.characterId,
      bioLocale: input.bioLocale,
      bioText: input.bioText,
      modelProviderFamily: input.modelProviderFamily,
      modelId: input.modelId,
      modelContextWindowTokens: input.modelContextWindowTokens,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
      promptTemplateVersion: input.promptTemplateVersion,
      promptHash: input.promptHash,
      inputTokenEstimate: input.inputTokenEstimate,
      completionTokens: input.completionTokens,
      status: "Fresh",
      invalidatedAt: null,
      invalidatedReason: null,
      generatedAt: input.generatedAt,
      createdAt: input.generatedAt,
      citations: input.citations.map((c) => ({
        bridgeUnitId: c.bridgeUnitId,
        citedSourceHash: c.citedSourceHash,
        citeOrdinal: c.citeOrdinal,
      })),
    };
    this.bios.set(record.characterBioId, record);
    return record;
  }

  async saveRelationship(
    _actor: AuthorizationActor,
    input: SaveCharacterRelationshipInput,
  ): Promise<CharacterRelationshipRecord> {
    const record: CharacterRelationshipRecord = {
      characterRelationshipId: input.characterRelationshipId,
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      fromCharacterId: input.fromCharacterId,
      toCharacterId: input.toCharacterId,
      kind: input.kind,
      direction: input.direction,
      descriptor: input.descriptor,
      descriptorLocale: input.descriptorLocale,
      modelProviderFamily: input.modelProviderFamily,
      modelId: input.modelId,
      modelContextWindowTokens: input.modelContextWindowTokens,
      modelMaxOutputTokens: input.modelMaxOutputTokens,
      promptTemplateVersion: input.promptTemplateVersion,
      promptHash: input.promptHash,
      status: "Fresh",
      invalidatedAt: null,
      invalidatedReason: null,
      generatedAt: input.generatedAt,
      createdAt: input.generatedAt,
      citations: input.citations.map((c) => ({
        bridgeUnitId: c.bridgeUnitId,
        citedSourceHash: c.citedSourceHash,
        citeOrdinal: c.citeOrdinal,
      })),
    };
    this.relationships.set(record.characterRelationshipId, record);
    return record;
  }

  async loadBioByCharacter(
    _actor: AuthorizationActor,
    query: {
      projectId: string;
      localeBranchId: string;
      sourceRevisionId: string;
      characterId: string;
      promptTemplateVersion?: string;
    },
  ): Promise<CharacterBioRecord | null> {
    const matching = [...this.bios.values()].filter(
      (r) =>
        r.projectId === query.projectId &&
        r.localeBranchId === query.localeBranchId &&
        r.sourceRevisionId === query.sourceRevisionId &&
        r.characterId === query.characterId &&
        (query.promptTemplateVersion === undefined ||
          r.promptTemplateVersion === query.promptTemplateVersion),
    );
    return matching.find((r) => r.status === "Fresh") ?? matching[0] ?? null;
  }

  async loadBios(
    _actor: AuthorizationActor,
    query: {
      projectId: string;
      localeBranchId?: string;
      sourceRevisionId?: string;
      characterId?: string;
      status?: "Fresh" | "Stale";
      promptTemplateVersion?: string;
    },
  ): Promise<CharacterBioRecord[]> {
    return [...this.bios.values()].filter(
      (r) =>
        r.projectId === query.projectId &&
        (query.localeBranchId === undefined || r.localeBranchId === query.localeBranchId) &&
        (query.sourceRevisionId === undefined || r.sourceRevisionId === query.sourceRevisionId) &&
        (query.characterId === undefined || r.characterId === query.characterId) &&
        (query.status === undefined || r.status === query.status) &&
        (query.promptTemplateVersion === undefined ||
          r.promptTemplateVersion === query.promptTemplateVersion),
    );
  }

  async loadRelationshipsByProject(
    _actor: AuthorizationActor,
    query: {
      projectId: string;
      localeBranchId?: string;
      sourceRevisionId?: string;
      status?: "Fresh" | "Stale";
      promptTemplateVersion?: string;
    },
  ): Promise<CharacterRelationshipRecord[]> {
    return [...this.relationships.values()].filter(
      (r) =>
        r.projectId === query.projectId &&
        (query.localeBranchId === undefined || r.localeBranchId === query.localeBranchId) &&
        (query.sourceRevisionId === undefined || r.sourceRevisionId === query.sourceRevisionId) &&
        (query.status === undefined || r.status === query.status) &&
        (query.promptTemplateVersion === undefined ||
          r.promptTemplateVersion === query.promptTemplateVersion),
    );
  }

  async markBioStale(
    _actor: AuthorizationActor,
    input: {
      characterBioId: string;
      reason: CharacterRelationshipInvalidatedReason;
      invalidatedAt?: Date;
    },
  ): Promise<void> {
    const record = this.bios.get(input.characterBioId);
    if (!record || record.status !== "Fresh") return;
    this.bios.set(input.characterBioId, {
      ...record,
      status: "Stale",
      invalidatedReason: input.reason,
      invalidatedAt: input.invalidatedAt ?? new Date(),
    });
  }

  async markRelationshipStale(
    _actor: AuthorizationActor,
    input: {
      characterRelationshipId: string;
      reason: CharacterRelationshipInvalidatedReason;
      invalidatedAt?: Date;
    },
  ): Promise<void> {
    const record = this.relationships.get(input.characterRelationshipId);
    if (!record || record.status !== "Fresh") return;
    this.relationships.set(input.characterRelationshipId, {
      ...record,
      status: "Stale",
      invalidatedReason: input.reason,
      invalidatedAt: input.invalidatedAt ?? new Date(),
    });
  }

  async currentSourceHashesForBridgeUnits(
    _actor: AuthorizationActor,
    input: { bridgeUnitIds: string[] },
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const id of input.bridgeUnitIds) {
      const hash = this.sourceHashes.get(id);
      if (hash !== undefined) {
        result.set(id, hash);
      }
    }
    return result;
  }
}

const actor: AuthorizationActor = { userId: "local-user" };

function generatedAt(): Date {
  return new Date("2026-06-23T12:00:00Z");
}

async function saveSampleBio(
  repository: InMemoryCharacterRelationshipRepository,
  characterBioId: string,
  characterId: string,
  citations: Array<{ bridgeUnitId: string; citedSourceHash: string; ordinal: number }>,
): Promise<void> {
  await repository.saveBio(actor, {
    characterBioId,
    projectId: "p",
    localeBranchId: "lb",
    sourceRevisionId: "rev-1",
    characterId,
    bioLocale: "ja-JP",
    bioText: `${characterId} bio`,
    modelProviderFamily: "fake",
    modelId: "fake-m",
    modelContextWindowTokens: 8000,
    modelMaxOutputTokens: 512,
    promptTemplateVersion: "itotori-character-relationship-v1",
    promptHash: "h",
    inputTokenEstimate: 10,
    completionTokens: 5,
    generatedAt: generatedAt(),
    citations: citations.map((c) => ({
      bridgeUnitId: c.bridgeUnitId,
      citedSourceHash: c.citedSourceHash,
      citeOrdinal: c.ordinal,
    })),
  });
}

async function saveSampleRelationship(
  repository: InMemoryCharacterRelationshipRepository,
  characterRelationshipId: string,
  from: string,
  to: string,
  kind: CharacterRelationshipKind,
  direction: CharacterRelationshipDirection,
  citations: Array<{ bridgeUnitId: string; citedSourceHash: string; ordinal: number }>,
): Promise<void> {
  await repository.saveRelationship(actor, {
    characterRelationshipId,
    projectId: "p",
    localeBranchId: "lb",
    sourceRevisionId: "rev-1",
    fromCharacterId: from,
    toCharacterId: to,
    kind,
    direction,
    descriptor: `${from}-${to}`,
    descriptorLocale: "ja-JP",
    modelProviderFamily: "fake",
    modelId: "fake-m",
    modelContextWindowTokens: 8000,
    modelMaxOutputTokens: 512,
    promptTemplateVersion: "itotori-character-relationship-v1",
    promptHash: "h",
    generatedAt: generatedAt(),
    citations: citations.map((c) => ({
      bridgeUnitId: c.bridgeUnitId,
      citedSourceHash: c.citedSourceHash,
      citeOrdinal: c.ordinal,
    })),
  });
}

describe("markStaleCharacterArtifactsForRevision", () => {
  it("flags bios + relationships whose citation hashes drift from the current source units", async () => {
    const repository = new InMemoryCharacterRelationshipRepository();
    await saveSampleBio(repository, "bio-a", "勇者", [
      { bridgeUnitId: "u-1", citedSourceHash: "h-1", ordinal: 1 },
    ]);
    await saveSampleBio(repository, "bio-b", "王様", [
      { bridgeUnitId: "u-2", citedSourceHash: "h-2", ordinal: 1 },
    ]);
    await saveSampleRelationship(repository, "rel-1", "勇者", "王様", "Allegiance", "FromAToB", [
      { bridgeUnitId: "u-1", citedSourceHash: "h-1", ordinal: 1 },
    ]);

    // u-1 drifted; u-2 fresh.
    repository.sourceHashes.set("u-1", "h-1-mutated");
    repository.sourceHashes.set("u-2", "h-2");

    const result = await markStaleCharacterArtifactsForRevision(repository, actor, {
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
    });

    expect(result.scannedBioCount).toBe(2);
    expect(result.scannedRelationshipCount).toBe(1);
    expect(result.driftedBios.map((d) => d.characterBioId)).toEqual(["bio-a"]);
    expect(result.driftedRelationships.map((d) => d.characterRelationshipId)).toEqual(["rel-1"]);
    expect(result.markedStaleBioCount).toBe(1);
    expect(result.markedStaleRelationshipCount).toBe(1);
    expect(repository.bios.get("bio-a")?.status).toBe("Stale");
    expect(repository.bios.get("bio-a")?.invalidatedReason).toBe("source_hash_drift");
    expect(repository.bios.get("bio-b")?.status).toBe("Fresh");
    expect(repository.relationships.get("rel-1")?.status).toBe("Stale");
  });

  it("treats a missing bridge unit (unit removed from current revision) as drift", async () => {
    const repository = new InMemoryCharacterRelationshipRepository();
    await saveSampleBio(repository, "bio-removed", "勇者", [
      { bridgeUnitId: "u-removed", citedSourceHash: "h-x", ordinal: 1 },
    ]);
    // No source hashes set -> bridge unit absent.

    const result = await markStaleCharacterArtifactsForRevision(repository, actor, {
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
    });
    expect(result.driftedBios).toHaveLength(1);
    expect(result.markedStaleBioCount).toBe(1);
  });

  it("does not write when markStale=false (dry-run mode)", async () => {
    const repository = new InMemoryCharacterRelationshipRepository();
    await saveSampleBio(repository, "bio-d", "勇者", [
      { bridgeUnitId: "u-1", citedSourceHash: "h-1", ordinal: 1 },
    ]);
    repository.sourceHashes.set("u-1", "h-1-mutated");

    const result = await markStaleCharacterArtifactsForRevision(repository, actor, {
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
      markStale: false,
    });
    expect(result.driftedBios).toHaveLength(1);
    expect(result.markedStaleBioCount).toBe(0);
    expect(repository.bios.get("bio-d")?.status).toBe("Fresh");
  });

  it("returns zero scans when no Fresh records exist", async () => {
    const repository = new InMemoryCharacterRelationshipRepository();
    const result = await markStaleCharacterArtifactsForRevision(repository, actor, {
      projectId: "p",
      localeBranchId: "lb",
      sourceRevisionId: "rev-1",
    });
    expect(result.scannedBioCount).toBe(0);
    expect(result.scannedRelationshipCount).toBe(0);
    expect(result.driftedBios).toHaveLength(0);
    expect(result.driftedRelationships).toHaveLength(0);
    expect(result.markedStaleBioCount).toBe(0);
    expect(result.markedStaleRelationshipCount).toBe(0);
  });
});
