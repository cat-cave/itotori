// ITOTORI-149 successor coverage: character enrichment persists through the
// one central context-artifact repository. The original per-agent character
// tables were retired in migration 0084; this test deliberately proves both
// the real Postgres write/read path and that those parallel tables are gone.

import { describe, expect, it } from "vitest";
import {
  contextArtifactCategoryValues,
  ItotoriContextArtifactRepository,
  ItotoriProjectRepository,
  type AuthorizationActor,
} from "@itotori/db";
import type { BridgeBundle, ItotoriProjectRecord } from "@itotori/localization-bridge-schema";
import {
  characterNoteArtifactId,
  characterRelationshipArtifactId,
} from "../src/orchestrator/context-brain.js";
import {
  persistCharacterBioInContext,
  persistCharacterRelationshipInContext,
} from "../src/agents/semantic-context-store.js";
import type {
  CharacterBio,
  CharacterRelationship,
} from "../src/agents/character-relationship/shapes.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const actor: AuthorizationActor = { userId: "local-user" };
const dbBackedIt = process.env.DATABASE_URL ? it : it.skip;
const projectId = "project-character-context";
const localeBranchId = "locale-character-context";
const sourceRevisionId = "bridge-character-context:bundle-revision";

function projectFixture(): ItotoriProjectRecord {
  const bridge: BridgeBundle = {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-character-context",
    sourceBundleHash: "hash-character-context",
    sourceBundleRevisionId: sourceRevisionId,
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "unit-character-hero",
        sourceUnitKey: "scene.001.line.001",
        occurrenceId: "occurrence-character-hero",
        sourceRevisionId,
        sourceHash: "hash-character-hero",
        sourceLocale: "ja-JP",
        sourceText: "勇者は王女を守ると誓った。",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "scenario.ks",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.001",
        },
      },
      {
        bridgeUnitId: "unit-character-princess",
        sourceUnitKey: "scene.001.line.002",
        occurrenceId: "occurrence-character-princess",
        sourceRevisionId,
        sourceHash: "hash-character-princess",
        sourceLocale: "ja-JP",
        sourceText: "王女は勇者を幼馴染と呼んだ。",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "scenario.ks",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.002",
        },
      },
    ],
  };
  return {
    projectId,
    localeBranchId,
    targetLocale: "en-US",
    drafts: {},
    bridge,
  };
}

const modelProfile = {
  providerFamily: "fake" as const,
  modelId: "itotori-fake-character-relationship-v0",
  providerId: "itotori-fake-provider",
  contextWindowTokens: 16_000,
  maxOutputTokens: 1024,
};

function bioFixture(): CharacterBio {
  return {
    id: "transient-character-bio",
    projectId,
    localeBranchId,
    sourceRevisionId,
    characterId: "勇者",
    bioLocale: "ja-JP",
    bioText: "物語の主人公。王女を守ると誓っている。",
    citedUnitIds: ["unit-character-hero", "unit-character-princess"],
    citedUnitHashes: ["hash-character-hero", "hash-character-princess"],
    modelProfile,
    promptTemplateVersion: "itotori-character-relationship-v1",
    promptHash: "sha256:character-bio",
    inputTokenEstimate: 421,
    completionTokens: 384,
    generatedAt: "2026-06-23T12:00:00.000Z",
    status: "Fresh",
  };
}

function relationshipFixture(): CharacterRelationship {
  return {
    id: "transient-character-relationship",
    projectId,
    localeBranchId,
    sourceRevisionId,
    fromCharacterId: "勇者",
    toCharacterId: "王女",
    kind: "Friendship",
    direction: "Symmetric",
    descriptor: "幼馴染",
    descriptorLocale: "ja-JP",
    citedUnitIds: ["unit-character-princess"],
    citedUnitHashes: ["hash-character-princess"],
    modelProfile,
    promptTemplateVersion: "itotori-character-relationship-v1",
    promptHash: "sha256:character-relationship",
    generatedAt: "2026-06-23T12:00:00.000Z",
    status: "Fresh",
  };
}

describe("character relationship central persistence round-trip (ITOTORI-149)", () => {
  dbBackedIt(
    "round-trips bios and relationships through central context artifacts only",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        await new ItotoriProjectRepository(context.db).importSourceBundle(actor, projectFixture());
        const repository = new ItotoriContextArtifactRepository(context.db);

        const savedBio = await persistCharacterBioInContext({ actor, repository }, bioFixture());
        const savedRelationship = await persistCharacterRelationshipInContext(
          { actor, repository },
          relationshipFixture(),
        );

        const loaded = await repository.retrieveArtifacts(actor, {
          projectId,
          localeBranchId,
          sourceRevisionId,
          categories: [contextArtifactCategoryValues.characterNote],
        });
        expect(loaded).toMatchObject({ status: "completed", diagnostics: [] });
        expect(loaded.matches).toHaveLength(2);
        expect(loaded.matches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              contextArtifactId: characterNoteArtifactId(projectId, "勇者"),
              body: bioFixture().bioText,
              data: expect.objectContaining({ semanticKind: "character_bio", characterId: "勇者" }),
              sourceUnits: [
                expect.objectContaining({
                  bridgeUnitId: "unit-character-hero",
                  sourceHash: "hash-character-hero",
                }),
                expect.objectContaining({
                  bridgeUnitId: "unit-character-princess",
                  sourceHash: "hash-character-princess",
                }),
              ],
            }),
            expect.objectContaining({
              contextArtifactId: characterRelationshipArtifactId(
                projectId,
                "勇者->王女:Friendship",
              ),
              body: relationshipFixture().descriptor,
              data: expect.objectContaining({
                semanticKind: "character_relationship",
                fromCharacterId: "勇者",
                toCharacterId: "王女",
                kind: "Friendship",
              }),
              sourceUnits: [
                expect.objectContaining({
                  bridgeUnitId: "unit-character-princess",
                  sourceHash: "hash-character-princess",
                }),
              ],
            }),
          ]),
        );
        expect(savedBio.id).toBe(characterNoteArtifactId(projectId, "勇者"));
        expect(savedRelationship.id).toBe(
          characterRelationshipArtifactId(projectId, "勇者->王女:Friendship"),
        );

        const retiredTables = await context.pool.query<{ table_name: string }>(
          `select table_name from information_schema.tables
         where table_schema = current_schema()
           and table_name in ('itotori_character_bios', 'itotori_character_bio_evidence',
                              'itotori_character_relationships', 'itotori_character_relationship_evidence')`,
        );
        expect(retiredTables.rows).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});
