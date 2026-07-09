import { describe, expect, it } from "vitest";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriCharacterRelationshipRepository,
  characterRelationshipDirectionValues,
  characterRelationshipKindValues,
} from "../src/repositories/character-relationship-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import { ItotoriTerminologyRepository } from "../src/repositories/terminology-repository.js";
import {
  ItotoriWikiReadmodelRepository,
  WIKI_ENTRIES_SCHEMA_VERSION,
  wikiEntryKindValues,
} from "../src/repositories/wiki-readmodel-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

const PROJECT_ID = "project-wiki-readmodel";
const LOCALE_BRANCH_ID = "locale-wiki-readmodel";
const SOURCE_REVISION_ID = "bridge-wiki-readmodel:bundle-revision";
const GENERATED_AT = new Date("2026-07-06T00:00:00.000Z");

describe("ItotoriWikiReadmodelRepository", () => {
  it("returns paged character and term entries with structure cross-references", async () => {
    const context = await isolatedMigratedContext();
    try {
      await new ItotoriProjectRepository(context.db).importSourceBundle(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        targetLocale: "en-US",
        drafts: {},
        bridge: bridgeFixture(),
      });

      const characters = new ItotoriCharacterRelationshipRepository(context.db);
      await characters.saveBio(actor, {
        characterBioId: "wiki-bio-hero",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        characterId: "勇者",
        bioLocale: "ja-JP",
        bioText: "村を守る主人公。",
        modelProviderFamily: "fake",
        modelId: "itotori-fake-character-v0",
        modelContextWindowTokens: 16000,
        modelMaxOutputTokens: 1024,
        promptTemplateVersion: "wiki-character-v1",
        promptHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        inputTokenEstimate: 100,
        completionTokens: 50,
        generatedAt: GENERATED_AT,
        citations: [
          { bridgeUnitId: "wiki-unit-1", citedSourceHash: "hash-unit-1", citeOrdinal: 1 },
        ],
      });
      await characters.saveBio(actor, {
        characterBioId: "wiki-bio-princess",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        characterId: "王女",
        bioLocale: "ja-JP",
        bioText: "城の継承者。",
        modelProviderFamily: "fake",
        modelId: "itotori-fake-character-v0",
        modelContextWindowTokens: 16000,
        modelMaxOutputTokens: 1024,
        promptTemplateVersion: "wiki-character-v1",
        promptHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        inputTokenEstimate: 100,
        completionTokens: 50,
        generatedAt: GENERATED_AT,
        citations: [
          { bridgeUnitId: "wiki-unit-2", citedSourceHash: "hash-unit-2", citeOrdinal: 1 },
        ],
      });
      await characters.saveRelationship(actor, {
        characterRelationshipId: "wiki-rel-hero-princess",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        fromCharacterId: "勇者",
        toCharacterId: "王女",
        kind: characterRelationshipKindValues.friendship,
        direction: characterRelationshipDirectionValues.symmetric,
        descriptor: "幼なじみ",
        descriptorLocale: "ja-JP",
        modelProviderFamily: "fake",
        modelId: "itotori-fake-character-v0",
        modelContextWindowTokens: 16000,
        modelMaxOutputTokens: 1024,
        promptTemplateVersion: "wiki-character-v1",
        promptHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        generatedAt: GENERATED_AT,
        citations: [
          { bridgeUnitId: "wiki-unit-2", citedSourceHash: "hash-unit-2", citeOrdinal: 1 },
        ],
      });

      const terminology = new ItotoriTerminologyRepository(context.db);
      await terminology.upsertTerm(actor, {
        termId: "term-hero",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceTerm: "勇者",
        preferredTranslation: "Hero",
        termKind: "character_name",
        aliases: [{ aliasId: "alias-hero", aliasText: "Hero", aliasKind: "target_alias" }],
        sourceReferences: [
          {
            sourceRefId: "term-ref-hero",
            sourceRevisionId: SOURCE_REVISION_ID,
            bridgeUnitId: "wiki-unit-1",
            referenceKind: "source_unit",
            citation: "scene.001.line.001",
          },
        ],
      });

      const repository = new ItotoriWikiReadmodelRepository(context.db);
      const page = await repository.loadEntries(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        limit: 2,
      });

      expect(page.schemaVersion).toBe(WIKI_ENTRIES_SCHEMA_VERSION);
      expect(page.pagination).toMatchObject({ total: 3, limit: 2, offset: 0, hasMore: true });
      expect(page.entries.map((entry) => entry.kind)).toEqual([
        wikiEntryKindValues.character,
        wikiEntryKindValues.character,
      ]);

      const hero = page.entries.find((entry) => entry.entryId === "character:勇者");
      expect(hero?.related).toContainEqual({
        refKind: "character",
        refId: "王女",
        label: "王女",
        relation: characterRelationshipKindValues.friendship,
      });
      expect(hero?.kind === "character" ? hero.appearances[0]?.sourceUnitKey : null).toBe(
        "scene.001.line.001",
      );

      const secondPage = await repository.loadEntries(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        limit: 2,
        offset: 2,
      });
      expect(secondPage.pagination).toMatchObject({ total: 3, hasMore: false, nextOffset: null });
      expect(secondPage.entries[0]).toMatchObject({
        kind: wikiEntryKindValues.term,
        termId: "term-hero",
        related: [
          {
            refKind: "character",
            refId: "勇者",
            label: "勇者",
            relation: "terminology_alias",
          },
        ],
      });
    } finally {
      await context.close();
    }
  });
});

function bridgeFixture(): BridgeBundle {
  return {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-wiki-readmodel",
    sourceBundleHash: "hash-wiki-readmodel",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "wiki-unit-1",
        sourceUnitKey: "scene.001.line.001",
        occurrenceId: "occurrence-1",
        sourceHash: "hash-unit-1",
        sourceLocale: "ja-JP",
        sourceText: "勇者は村を守った。",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "source.json",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.001",
        },
      },
      {
        bridgeUnitId: "wiki-unit-2",
        sourceUnitKey: "scene.001.line.002",
        occurrenceId: "occurrence-2",
        sourceHash: "hash-unit-2",
        sourceLocale: "ja-JP",
        sourceText: "王女は勇者を信じている。",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "source.json",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.002",
        },
      },
    ],
  };
}
