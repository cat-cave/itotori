// ITOTORI-149 — Character-relationship CLI snapshot test
// (end-to-end gap #3 deferred by ITOTORI-014).
//
// Spec contract (per qd node ITOTORI-149):
//   • CLI snapshot asserts the human-readable output of
//     `generate-character-relationships` AND `check-character-relationships`
//     matches committed snapshots.
//   • The test MUST use FakeModelProvider (no live LLM call).
//   • The test MUST NOT require DATABASE_URL (uses an in-memory repository).
//
// The committed snapshots pin the handler's stdout text shape — any
// accidental re-order, rename, or unit change to the counters in
// `apps/itotori/src/cli-handlers.ts:runGenerateCharacterRelationshipsHandler`
// / `runCheckCharacterRelationshipsHandler` is caught by these bytes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { describe, expect, it, vi } from "vitest";
import {
  runItotoriCliCommand,
  type ItotoriCliDependencies,
  type ItotoriCliServices,
} from "../src/cli-handlers.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import {
  runCheckCharacterRelationshipsCli,
  runGenerateCharacterRelationshipsCli,
  type CharacterRelationshipCliDependencies,
} from "../src/agents/character-relationship/index.js";
import type { GlossaryRef } from "../src/batch-planner/shapes.js";

const here = dirname(fileURLToPath(import.meta.url));

const ACTOR: AuthorizationActor = { userId: "local-user" };
const FIXED_NOW = new Date("2026-06-23T12:00:00.000Z");

// Sealed provider pack — same JSON the recorded-bundle replay uses, but here
// the FakeModelProvider emits it directly so the CLI test path stays
// hermetic (no RecordedModelProvider machinery in scope).
const SEALED_PACK_JSON = JSON.stringify({
  bios: [
    {
      characterId: "勇者",
      bioText: "物語の主人公。王様と王女に深く関わる。",
      citedUnitIds: [
        "019ed218-0000-7000-8000-000000000a01",
        "019ed218-0000-7000-8000-000000000a03",
      ],
    },
    {
      characterId: "王様",
      bioText: "この国の統治者。勇者を信頼している。",
      citedUnitIds: [
        "019ed218-0000-7000-8000-000000000a01",
        "019ed218-0000-7000-8000-000000000a02",
      ],
    },
    {
      characterId: "王女",
      bioText: "勇者の古くからの友人。",
      citedUnitIds: ["019ed218-0000-7000-8000-000000000a03"],
    },
  ],
  relationships: [
    {
      fromCharacterId: "勇者",
      toCharacterId: "王様",
      kind: "Allegiance",
      direction: "FromAToB",
      descriptor: "勇者は王様に仕える",
      citedUnitIds: ["019ed218-0000-7000-8000-000000000a01"],
    },
    {
      fromCharacterId: "勇者",
      toCharacterId: "王女",
      kind: "Friendship",
      direction: "Symmetric",
      descriptor: "幼馴染",
      citedUnitIds: ["019ed218-0000-7000-8000-000000000a03"],
    },
  ],
});

function unitsFixture() {
  return [
    {
      bridgeUnitId: "019ed218-0000-7000-8000-000000000a01",
      sourceUnitKey: "scene.001.line.001",
      sourceText: "勇者は王様に挨拶した。",
      sourceHash: "hash-cli-1",
      speaker: "勇者",
      addressees: ["王様"],
    },
    {
      bridgeUnitId: "019ed218-0000-7000-8000-000000000a02",
      sourceUnitKey: "scene.001.line.002",
      sourceText: "王様はうなずいた。",
      sourceHash: "hash-cli-2",
      speaker: "王様",
    },
    {
      bridgeUnitId: "019ed218-0000-7000-8000-000000000a03",
      sourceUnitKey: "scene.001.line.003",
      sourceText: "勇者と王女は古くからの友人だ。",
      sourceHash: "hash-cli-3",
      speaker: "narrator",
      addressees: ["勇者", "王女"],
    },
  ];
}

function curatedFixture() {
  return [
    { characterId: "勇者", displayName: "勇者ハル" },
    { characterId: "王様", displayName: "王" },
    { characterId: "王女", displayName: "王女ミラ" },
  ];
}

function glossaryFixture(): GlossaryRef[] {
  return [
    {
      termId: "term-yusha",
      termKey: "yusha",
      preferredSourceForm: "勇者",
      preferredTargetForm: "hero",
      hitBridgeUnitIds: ["019ed218-0000-7000-8000-000000000a01"],
    },
  ];
}

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
    const matches = [...this.bios.values()].filter(
      (r) =>
        r.projectId === query.projectId &&
        r.localeBranchId === query.localeBranchId &&
        r.sourceRevisionId === query.sourceRevisionId &&
        r.characterId === query.characterId &&
        (query.promptTemplateVersion === undefined ||
          r.promptTemplateVersion === query.promptTemplateVersion),
    );
    return matches.find((r) => r.status === "Fresh") ?? matches[0] ?? null;
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

function captureStdout(): { chunks: string[]; restore(): void } {
  const chunks: string[] = [];
  const stream = process.stdout;
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    chunks,
    restore() {
      stream.write = original;
    },
  };
}

function readSnapshot(name: string): string {
  return readFileSync(join(here, "fixtures", name), "utf8");
}

function buildCharacterRelationshipService(
  repository: InMemoryCharacterRelationshipRepository,
  providerFactory: () => ReturnType<typeof FakeModelProvider>,
): NonNullable<ItotoriCliServices["characterRelationship"]> {
  return {
    defaultModelId: "itotori-fake-character-relationship-v0",
    defaultProviderId: "fake-fixture",
    defaultProviderFamily: "fake",
    defaultContextWindowTokens: 16000,
    cliDependencies: async (_family, _providerRunsDir) => {
      const provider = providerFactory();
      return {
        actor: ACTOR,
        repository,
        provider,
        now: () => FIXED_NOW,
        loadInputContext: async () => ({
          units: unitsFixture(),
          curatedCharacters: curatedFixture(),
          glossaryExcerpt: glossaryFixture(),
        }),
      } satisfies CharacterRelationshipCliDependencies;
    },
  };
}

function buildServices(
  characterRelationship: NonNullable<ItotoriCliServices["characterRelationship"]>,
): ItotoriCliServices {
  // The character-relationship commands only need the characterRelationship
  // port on `ItotoriCliServices`. The CLI handler resolves other ports via
  // `withServices` only when the matching command fires, so a partial
  // services object is safe here.
  return { characterRelationship } as unknown as ItotoriCliServices;
}

function noOpDependencies(services: ItotoriCliServices): ItotoriCliDependencies {
  return {
    io: { readJson: vi.fn(), writeJson: vi.fn() },
    migrateDatabase: vi.fn(async () => {}),
    withServices: async (callback) => await callback(services),
  };
}

describe("character-relationship CLI snapshot (ITOTORI-149)", () => {
  it("generate-character-relationships --dry-run writes the committed stdout text shape", async () => {
    const repository = new InMemoryCharacterRelationshipRepository();
    const service = buildCharacterRelationshipService(
      repository,
      () =>
        new FakeModelProvider({
          providerName: "character-relationship-fake",
          modelId: "itotori-fake-character-relationship-v0",
          generate: () => SEALED_PACK_JSON,
        }),
    );

    const writes = captureStdout();
    try {
      await runItotoriCliCommand(
        [
          "generate-character-relationships",
          "--project",
          "p-cli",
          "--locale-branch",
          "lb-cli",
          "--source-locale",
          "ja-JP",
          "--source-revision",
          "rev-cli",
          "--provider",
          "fake",
          "--dry-run",
        ],
        noOpDependencies(buildServices(service)),
      );
    } finally {
      writes.restore();
    }

    const expected = readSnapshot("character-relationship-cli-snapshot-generate.txt");
    expect(writes.chunks.join("")).toBe(expected);
    // --dry-run must NOT have persisted anything; the in-memory repo must
    // remain empty so this proves the snapshot pins the no-write path too.
    expect(repository.bios.size).toBe(0);
    expect(repository.relationships.size).toBe(0);
  });

  it("check-character-relationships writes the committed stdout text shape (drift detected, no mark-stale)", async () => {
    const repository = new InMemoryCharacterRelationshipRepository();

    // Seed a Fresh bio + a Fresh relationship whose citations will be
    // flagged as drifted by the staleness check below. The check handler
    // itself only LOADS + READS — it does not need FakeModelProvider (no
    // LLM call), satisfying the no-live-LLM contract.
    await repository.saveBio(ACTOR, {
      characterBioId: "bio-cli-1",
      projectId: "p-cli",
      localeBranchId: "lb-cli",
      sourceRevisionId: "rev-cli",
      characterId: "勇者",
      bioLocale: "ja-JP",
      bioText: "物語の主人公。",
      modelProviderFamily: "fake",
      modelId: "itotori-fake-character-relationship-v0",
      modelContextWindowTokens: 16000,
      modelMaxOutputTokens: 1024,
      promptTemplateVersion: "itotori-character-relationship-v1",
      promptHash: "sha256:cli-snapshot-1",
      inputTokenEstimate: 100,
      completionTokens: 50,
      generatedAt: FIXED_NOW,
      citations: [
        {
          bridgeUnitId: "019ed218-0000-7000-8000-000000000a01",
          citedSourceHash: "hash-cli-1",
          citeOrdinal: 1,
        },
      ],
    });
    await repository.saveBio(ACTOR, {
      characterBioId: "bio-cli-2",
      projectId: "p-cli",
      localeBranchId: "lb-cli",
      sourceRevisionId: "rev-cli",
      characterId: "王様",
      bioLocale: "ja-JP",
      bioText: "王様 bio。",
      modelProviderFamily: "fake",
      modelId: "itotori-fake-character-relationship-v0",
      modelContextWindowTokens: 16000,
      modelMaxOutputTokens: 1024,
      promptTemplateVersion: "itotori-character-relationship-v1",
      promptHash: "sha256:cli-snapshot-2",
      inputTokenEstimate: 100,
      completionTokens: 50,
      generatedAt: FIXED_NOW,
      citations: [
        {
          bridgeUnitId: "019ed218-0000-7000-8000-000000000a02",
          citedSourceHash: "hash-cli-2",
          citeOrdinal: 1,
        },
      ],
    });
    await repository.saveBio(ACTOR, {
      characterBioId: "bio-cli-3",
      projectId: "p-cli",
      localeBranchId: "lb-cli",
      sourceRevisionId: "rev-cli",
      characterId: "王女",
      bioLocale: "ja-JP",
      bioText: "王女 bio。",
      modelProviderFamily: "fake",
      modelId: "itotori-fake-character-relationship-v0",
      modelContextWindowTokens: 16000,
      modelMaxOutputTokens: 1024,
      promptTemplateVersion: "itotori-character-relationship-v1",
      promptHash: "sha256:cli-snapshot-3",
      inputTokenEstimate: 100,
      completionTokens: 50,
      generatedAt: FIXED_NOW,
      citations: [
        {
          bridgeUnitId: "019ed218-0000-7000-8000-000000000a03",
          citedSourceHash: "hash-cli-3",
          citeOrdinal: 1,
        },
      ],
    });
    await repository.saveRelationship(ACTOR, {
      characterRelationshipId: "rel-cli-1",
      projectId: "p-cli",
      localeBranchId: "lb-cli",
      sourceRevisionId: "rev-cli",
      fromCharacterId: "勇者",
      toCharacterId: "王女",
      kind: "Friendship" as CharacterRelationshipKind,
      direction: "Symmetric" as CharacterRelationshipDirection,
      descriptor: "幼馴染",
      descriptorLocale: "ja-JP",
      modelProviderFamily: "fake",
      modelId: "itotori-fake-character-relationship-v0",
      modelContextWindowTokens: 16000,
      modelMaxOutputTokens: 1024,
      promptTemplateVersion: "itotori-character-relationship-v1",
      promptHash: "sha256:cli-snapshot-rel",
      generatedAt: FIXED_NOW,
      citations: [
        {
          bridgeUnitId: "019ed218-0000-7000-8000-000000000a03",
          citedSourceHash: "hash-cli-3",
          citeOrdinal: 1,
        },
      ],
    });
    await repository.saveRelationship(ACTOR, {
      characterRelationshipId: "rel-cli-2",
      projectId: "p-cli",
      localeBranchId: "lb-cli",
      sourceRevisionId: "rev-cli",
      fromCharacterId: "勇者",
      toCharacterId: "王様",
      kind: "Allegiance" as CharacterRelationshipKind,
      direction: "FromAToB" as CharacterRelationshipDirection,
      descriptor: "仕える",
      descriptorLocale: "ja-JP",
      modelProviderFamily: "fake",
      modelId: "itotori-fake-character-relationship-v0",
      modelContextWindowTokens: 16000,
      modelMaxOutputTokens: 1024,
      promptTemplateVersion: "itotori-character-relationship-v1",
      promptHash: "sha256:cli-snapshot-rel-2",
      generatedAt: FIXED_NOW,
      citations: [
        {
          bridgeUnitId: "019ed218-0000-7000-8000-000000000a01",
          citedSourceHash: "hash-cli-1",
          citeOrdinal: 1,
        },
      ],
    });

    // Drift the source hash on units cited by 2 of 3 bios + 1 of 2
    // relationships so the staleness scan surfaces non-zero counts in the
    // pinned snapshot. Keep the third unit's hash unchanged so the
    // bio + relationship citing it are NOT flagged (the scan treats a
    // missing sourceHash as drift too, so every cited unit needs an
    // entry — drifted or fresh — for the test to count cleanly).
    repository.sourceHashes.set("019ed218-0000-7000-8000-000000000a01", "hash-cli-1-mutated");
    repository.sourceHashes.set("019ed218-0000-7000-8000-000000000a02", "hash-cli-2-mutated");
    repository.sourceHashes.set("019ed218-0000-7000-8000-000000000a03", "hash-cli-3");

    // The check handler does NOT need a provider at all (no LLM call), but
    // the seam is required by `CharacterRelationshipCliDependencies`. The
    // FakeModelProvider is built but never invoked.
    const service = buildCharacterRelationshipService(repository, () => new FakeModelProvider());

    const writes = captureStdout();
    try {
      await runItotoriCliCommand(
        [
          "check-character-relationships",
          "--project",
          "p-cli",
          "--locale-branch",
          "lb-cli",
          "--source-revision",
          "rev-cli",
          "--provider",
          "fake",
        ],
        noOpDependencies(buildServices(service)),
      );
    } finally {
      writes.restore();
    }

    const expected = readSnapshot("character-relationship-cli-snapshot-check.txt");
    expect(writes.chunks.join("")).toBe(expected);

    // No mark-stale flag was passed → the persisted rows must still be
    // Fresh. The snapshot's marked_stale_* counters are zero, so this
    // is the byte-equal check's load-bearing precondition.
    expect(repository.bios.get("bio-cli-1")?.status).toBe("Fresh");
    expect(repository.bios.get("bio-cli-2")?.status).toBe("Fresh");
    expect(repository.bios.get("bio-cli-3")?.status).toBe("Fresh");
    expect(repository.relationships.get("rel-cli-1")?.status).toBe("Fresh");
    expect(repository.relationships.get("rel-cli-2")?.status).toBe("Fresh");

    // Sanity: the underlying runner is the same seam the CLI uses, so the
    // handler-shape and runner-shape stay in lock-step (otherwise the
    // committed snapshot could drift from the runner's contract).
    const directResult = await runCheckCharacterRelationshipsCli(
      { projectId: "p-cli", localeBranchId: "lb-cli", sourceRevisionId: "rev-cli" },
      {
        actor: ACTOR,
        repository,
        provider: new FakeModelProvider(),
        now: () => FIXED_NOW,
        loadInputContext: async () => ({
          units: unitsFixture(),
          curatedCharacters: curatedFixture(),
          glossaryExcerpt: glossaryFixture(),
        }),
      },
    );
    expect(directResult.scannedBioCount).toBe(3);
    expect(directResult.scannedRelationshipCount).toBe(2);
    expect(directResult.driftedBios).toHaveLength(2);
    expect(directResult.driftedRelationships).toHaveLength(1);
    expect(directResult.markedStaleBioCount).toBe(0);
    expect(directResult.markedStaleRelationshipCount).toBe(0);
  });

  it("generate-character-relationships pin helper reuses the canonical runner (locks the snapshot to the real CLI)", async () => {
    // This last gate asserts the in-memory seam is the SAME function the
    // CLI handler invokes. If `runGenerateCharacterRelationshipsCli` is
    // ever swapped out (e.g. for a future CLI-context shortcut), this
    // assertion fails loud — the snapshot pin would otherwise drift
    // silently against the runner's contract.
    const repository = new InMemoryCharacterRelationshipRepository();
    const direct = await runGenerateCharacterRelationshipsCli(
      {
        projectId: "p-cli",
        localeBranchId: "lb-cli",
        sourceLocale: "ja-JP",
        sourceRevisionId: "rev-cli",
        dryRun: true,
        modelProfile: {
          providerFamily: "fake",
          modelId: "itotori-fake-character-relationship-v0",
          providerId: "fake-fixture",
          contextWindowTokens: 16000,
          maxOutputTokens: 1024,
        },
      },
      {
        actor: ACTOR,
        repository,
        provider: new FakeModelProvider({
          providerName: "character-relationship-fake",
          modelId: "itotori-fake-character-relationship-v0",
          generate: () => SEALED_PACK_JSON,
        }),
        now: () => FIXED_NOW,
        loadInputContext: async () => ({
          units: unitsFixture(),
          curatedCharacters: curatedFixture(),
          glossaryExcerpt: glossaryFixture(),
        }),
      },
    );
    expect(direct.generatedBioCount).toBe(3);
    expect(direct.generatedRelationshipCount).toBe(2);
    expect(direct.bios).toHaveLength(3);
    expect(direct.relationships).toHaveLength(2);
    // dry-run → no persistence.
    expect(repository.bios.size).toBe(0);
    expect(repository.relationships.size).toBe(0);
  });
});
