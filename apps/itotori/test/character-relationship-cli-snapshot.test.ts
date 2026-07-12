// ITOTORI-149 CLI shape pin. Character output is now owned by central context
// artifacts; the command must not regain a per-agent repository seam.

import { describe, expect, it, vi } from "vitest";
import { contextArtifactCategoryValues, type AuthorizationActor } from "@itotori/db";
import {
  runItotoriCliCommand,
  type ItotoriCliDependencies,
  type ItotoriCliServices,
} from "../src/cli-handlers.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import { InMemoryContextArtifactRepository } from "../src/orchestrator/context-brain.js";
import type { CharacterRelationshipCliDependencies } from "../src/agents/character-relationship/index.js";
import type { GlossaryRef } from "../src/batch-planner/shapes.js";

const actor: AuthorizationActor = { userId: "local-user" };
const fixedNow = new Date("2026-06-23T12:00:00.000Z");

const sealedPack = JSON.stringify({
  bios: [
    {
      characterId: "勇者",
      bioText: "物語の主人公。王様と王女に深く関わる。",
      citedUnitIds: ["unit-1", "unit-3"],
    },
    {
      characterId: "王様",
      bioText: "この国の統治者。勇者を信頼している。",
      citedUnitIds: ["unit-1", "unit-2"],
    },
    {
      characterId: "王女",
      bioText: "勇者の古くからの友人。",
      citedUnitIds: ["unit-3"],
    },
  ],
  relationships: [
    {
      fromCharacterId: "勇者",
      toCharacterId: "王様",
      kind: "Allegiance",
      direction: "FromAToB",
      descriptor: "勇者は王様に仕える",
      citedUnitIds: ["unit-1"],
    },
    {
      fromCharacterId: "勇者",
      toCharacterId: "王女",
      kind: "Friendship",
      direction: "Symmetric",
      descriptor: "幼馴染",
      citedUnitIds: ["unit-3"],
    },
  ],
});

function unitsFixture() {
  return [
    {
      bridgeUnitId: "unit-1",
      sourceUnitKey: "scene.001.line.001",
      sourceText: "勇者は王様に挨拶した。",
      sourceHash: "hash-cli-1",
      speaker: "勇者",
      addressees: ["王様"],
    },
    {
      bridgeUnitId: "unit-2",
      sourceUnitKey: "scene.001.line.002",
      sourceText: "王様はうなずいた。",
      sourceHash: "hash-cli-2",
      speaker: "王様",
    },
    {
      bridgeUnitId: "unit-3",
      sourceUnitKey: "scene.001.line.003",
      sourceText: "勇者と王女は古くからの友人だ。",
      sourceHash: "hash-cli-3",
      speaker: "narrator",
      addressees: ["勇者", "王女"],
    },
  ];
}

function glossaryFixture(): GlossaryRef[] {
  return [
    {
      termId: "term-yusha",
      termKey: "yusha",
      preferredSourceForm: "勇者",
      preferredTargetForm: "hero",
      hitBridgeUnitIds: ["unit-1"],
    },
  ];
}

function captureStdout(): { chunks: string[]; restore(): void } {
  const chunks: string[] = [];
  const stream = process.stdout;
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return { chunks, restore: () => void (stream.write = original) };
}

function characterService(
  store: InMemoryContextArtifactRepository,
): NonNullable<ItotoriCliServices["characterRelationship"]> {
  return {
    defaultModelId: "itotori-fake-character-relationship-v0",
    defaultProviderId: "fake-fixture",
    defaultProviderFamily: "fake",
    defaultContextWindowTokens: 16_000,
    cliDependencies: async () =>
      ({
        actor,
        contextArtifactRepository: store,
        provider: new FakeModelProvider({
          providerName: "character-relationship-fake",
          modelId: "itotori-fake-character-relationship-v0",
          generate: () => sealedPack,
        }),
        now: () => fixedNow,
        loadInputContext: async () => ({
          units: unitsFixture(),
          curatedCharacters: [
            { characterId: "勇者", displayName: "勇者ハル" },
            { characterId: "王様", displayName: "王" },
            { characterId: "王女", displayName: "王女ミラ" },
          ],
          glossaryExcerpt: glossaryFixture(),
        }),
      }) satisfies CharacterRelationshipCliDependencies,
  };
}

function dependencies(store: InMemoryContextArtifactRepository): ItotoriCliDependencies {
  const services = { characterRelationship: characterService(store) } as ItotoriCliServices;
  return {
    io: { readJson: vi.fn(), writeJson: vi.fn() },
    migrateDatabase: vi.fn(async () => {}),
    withServices: async (callback) => await callback(services),
  };
}

const cliArgs = [
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
];

describe("character-relationship CLI snapshot (ITOTORI-149)", () => {
  it("pins dry-run output while leaving the central store empty", async () => {
    const store = new InMemoryContextArtifactRepository();
    const writes = captureStdout();
    try {
      await runItotoriCliCommand(
        ["generate-character-relationships", ...cliArgs, "--dry-run"],
        dependencies(store),
      );
    } finally {
      writes.restore();
    }

    expect(writes.chunks.join("")).toBe(
      "bios_generated=3 relationships_generated=2 bios_skipped_fresh=0\n",
    );
    const stored = await store.retrieveArtifacts(actor, {
      projectId: "p-cli",
      localeBranchId: "lb-cli",
      sourceRevisionId: "rev-cli",
    });
    expect(stored.matches).toEqual([]);
  });

  it("pins generate/check output and proves all persisted records are central artifacts", async () => {
    const store = new InMemoryContextArtifactRepository();
    const generateWrites = captureStdout();
    try {
      await runItotoriCliCommand(
        ["generate-character-relationships", ...cliArgs],
        dependencies(store),
      );
    } finally {
      generateWrites.restore();
    }
    expect(generateWrites.chunks.join("")).toBe(
      "bios_generated=3 relationships_generated=2 bios_skipped_fresh=0\n",
    );

    const stored = await store.retrieveArtifacts(actor, {
      projectId: "p-cli",
      localeBranchId: "lb-cli",
      sourceRevisionId: "rev-cli",
      categories: [contextArtifactCategoryValues.characterNote],
    });
    expect(stored.matches).toHaveLength(5);
    expect(
      stored.matches.filter((artifact) => artifact.data.semanticKind === "character_bio"),
    ).toHaveLength(3);
    expect(
      stored.matches.filter((artifact) => artifact.data.semanticKind === "character_relationship"),
    ).toHaveLength(2);

    const checkWrites = captureStdout();
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
        dependencies(store),
      );
    } finally {
      checkWrites.restore();
    }
    expect(checkWrites.chunks.join("")).toBe(
      "scanned_bios=3 scanned_relationships=2 drifted_bios=0 drifted_relationships=0 marked_stale_bios=0 marked_stale_relationships=0\n",
    );
  });
});
