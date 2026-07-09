import { describe, expect, it } from "vitest";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriContextArtifactRepository } from "../src/repositories/context-artifact-repository.js";
import {
  ItotoriCharacterRelationshipRepository,
  characterRelationshipDirectionValues,
  characterRelationshipKindValues,
} from "../src/repositories/character-relationship-repository.js";
import {
  defaultWorkspaceId,
  ItotoriProjectRepository,
} from "../src/repositories/project-repository.js";
import { ItotoriTerminologyRepository } from "../src/repositories/terminology-repository.js";
import {
  ItotoriWikiReadmodelRepository,
  WIKI_ENTRIES_SCHEMA_VERSION,
  wikiEntryKindValues,
} from "../src/repositories/wiki-readmodel-repository.js";
import { wikiBrandContextMemberships, wikiBrandContexts } from "../src/schema.js";
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

  it("lets a fandisk project inherit base-game character arcs, glossary, and context through a brand tier", async () => {
    const context = await isolatedMigratedContext();
    try {
      const projects = new ItotoriProjectRepository(context.db);
      const baseProjectId = "project-wiki-brand-base";
      const baseBranchId = "locale-wiki-brand-base";
      const baseRevisionId = "bridge-wiki-brand-base:bundle-revision";
      const fandiskProjectId = "project-wiki-brand-fandisk";
      const fandiskBranchId = "locale-wiki-brand-fandisk";

      await projects.importSourceBundle(actor, {
        projectId: baseProjectId,
        localeBranchId: baseBranchId,
        targetLocale: "en-US",
        drafts: {},
        bridge: bridgeFixture({ bridgeId: "bridge-wiki-brand-base", unitPrefix: "base" }),
      });
      await projects.importSourceBundle(actor, {
        projectId: fandiskProjectId,
        localeBranchId: fandiskBranchId,
        targetLocale: "en-US",
        drafts: {},
        bridge: bridgeFixture({ bridgeId: "bridge-wiki-brand-fandisk", unitPrefix: "fandisk" }),
      });

      const characters = new ItotoriCharacterRelationshipRepository(context.db);
      await characters.saveBio(actor, {
        characterBioId: "wiki-brand-bio-rin",
        projectId: baseProjectId,
        localeBranchId: baseBranchId,
        sourceRevisionId: baseRevisionId,
        characterId: "凛",
        bioLocale: "ja-JP",
        bioText: "本編で主人公を支える幼なじみ。",
        modelProviderFamily: "fake",
        modelId: "itotori-fake-character-v0",
        modelContextWindowTokens: 16000,
        modelMaxOutputTokens: 1024,
        promptTemplateVersion: "wiki-character-v1",
        promptHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        inputTokenEstimate: 100,
        completionTokens: 50,
        generatedAt: GENERATED_AT,
        citations: [
          { bridgeUnitId: "base-unit-1", citedSourceHash: "hash-base-1", citeOrdinal: 1 },
        ],
      });
      await characters.saveRelationship(actor, {
        characterRelationshipId: "wiki-brand-rel-rin-mei",
        projectId: baseProjectId,
        localeBranchId: baseBranchId,
        sourceRevisionId: baseRevisionId,
        fromCharacterId: "凛",
        toCharacterId: "芽衣",
        kind: characterRelationshipKindValues.friendship,
        direction: characterRelationshipDirectionValues.symmetric,
        descriptor: "本編から続く親友",
        descriptorLocale: "ja-JP",
        modelProviderFamily: "fake",
        modelId: "itotori-fake-character-v0",
        modelContextWindowTokens: 16000,
        modelMaxOutputTokens: 1024,
        promptTemplateVersion: "wiki-character-v1",
        promptHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        generatedAt: GENERATED_AT,
        citations: [
          { bridgeUnitId: "base-unit-2", citedSourceHash: "hash-base-2", citeOrdinal: 1 },
        ],
      });

      const terminology = new ItotoriTerminologyRepository(context.db);
      await terminology.upsertTerm(actor, {
        termId: "term-hoshimi-academy",
        projectId: baseProjectId,
        localeBranchId: baseBranchId,
        sourceTerm: "星見学園",
        preferredTranslation: "Hoshimi Academy",
        termKind: "place_name",
        sourceReferences: [
          {
            sourceRefId: "term-ref-hoshimi-base",
            sourceRevisionId: baseRevisionId,
            bridgeUnitId: "base-unit-1",
            referenceKind: "source_unit",
            citation: "base.scene.001.line.001",
            context: "base game setting name",
          },
        ],
      });

      await new ItotoriContextArtifactRepository(context.db).upsertArtifact(actor, {
        contextArtifactId: "context-base-school-festival",
        projectId: baseProjectId,
        localeBranchId: baseBranchId,
        sourceRevisionId: baseRevisionId,
        category: "character_note",
        title: "Rin after-school promise",
        body: "The fandisk should preserve Rin's base-game promise to meet after school.",
        producedByTool: "wiki-brand-context-test",
        producerVersion: "1.0.0",
        sourceUnits: [{ bridgeUnitId: "base-unit-2", citation: "base.scene.001.line.002" }],
      });

      await context.db.insert(wikiBrandContexts).values({
        brandContextId: "brand-context-crystalia",
        workspaceId: defaultWorkspaceId,
        contextKey: "crystalia-softpal",
        name: "Crystalia / Softpal",
      });
      await context.db.insert(wikiBrandContextMemberships).values([
        {
          brandContextMembershipId: "brand-context-crystalia-base",
          brandContextId: "brand-context-crystalia",
          projectId: baseProjectId,
          localeBranchId: baseBranchId,
          contextRole: "base",
          inheritanceOrder: 0,
          providesCharacterArcs: true,
          providesGlossary: true,
          providesContext: true,
          inheritsCharacterArcs: false,
          inheritsGlossary: false,
          inheritsContext: false,
        },
        {
          brandContextMembershipId: "brand-context-crystalia-fandisk",
          brandContextId: "brand-context-crystalia",
          projectId: fandiskProjectId,
          localeBranchId: fandiskBranchId,
          contextRole: "fandisk",
          inheritanceOrder: 1,
          providesCharacterArcs: true,
          providesGlossary: true,
          providesContext: true,
          inheritsCharacterArcs: true,
          inheritsGlossary: true,
          inheritsContext: true,
        },
      ]);

      const page = await new ItotoriWikiReadmodelRepository(context.db).loadEntries(actor, {
        projectId: fandiskProjectId,
        localeBranchId: fandiskBranchId,
      });

      expect(page.brandContext.contexts).toHaveLength(1);
      expect(page.brandContext.contexts[0]).toMatchObject({
        brandContextId: "brand-context-crystalia",
        requestedRole: "fandisk",
        inheritedSources: [
          {
            sourceProjectId: baseProjectId,
            sourceLocaleBranchId: baseBranchId,
            inheritedCharacterArcs: true,
            inheritedGlossary: true,
            inheritedContext: true,
          },
        ],
      });
      const inheritedCharacter = page.entries.find((entry) => entry.entryId === "character:凛");
      expect(inheritedCharacter).toMatchObject({
        kind: wikiEntryKindValues.character,
        projectId: baseProjectId,
        localeBranchId: baseBranchId,
        scope: {
          inheritance: "brand_context",
          requestedProjectId: fandiskProjectId,
          requestedLocaleBranchId: fandiskBranchId,
          sourceProjectId: baseProjectId,
          sourceLocaleBranchId: baseBranchId,
          brandContextId: "brand-context-crystalia",
        },
      });
      expect(
        inheritedCharacter?.kind === "character" ? inheritedCharacter.relationships : [],
      ).toEqual([
        expect.objectContaining({
          toCharacterId: "芽衣",
          descriptor: "本編から続く親友",
        }),
      ]);

      expect(
        page.entries.find((entry) => entry.entryId === "term:term-hoshimi-academy"),
      ).toMatchObject({
        kind: wikiEntryKindValues.term,
        sourceTerm: "星見学園",
        preferredTranslation: "Hoshimi Academy",
        scope: {
          inheritance: "brand_context",
          requestedProjectId: fandiskProjectId,
          sourceProjectId: baseProjectId,
        },
      });
      expect(page.brandContext.inheritedContextArtifacts).toEqual([
        expect.objectContaining({
          contextArtifactId: "context-base-school-festival",
          projectId: baseProjectId,
          title: "Rin after-school promise",
          source: expect.objectContaining({
            inheritance: "brand_context",
            requestedProjectId: fandiskProjectId,
            sourceProjectId: baseProjectId,
          }),
        }),
      ]);
    } finally {
      await context.close();
    }
  });
});

function bridgeFixture({
  bridgeId = "bridge-wiki-readmodel",
  unitPrefix = "wiki",
}: {
  bridgeId?: string;
  unitPrefix?: string;
} = {}): BridgeBundle {
  return {
    schemaVersion: "0.1.0",
    bridgeId,
    sourceBundleHash: "hash-wiki-readmodel",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: `${unitPrefix}-unit-1`,
        sourceUnitKey: "scene.001.line.001",
        occurrenceId: "occurrence-1",
        sourceHash: `hash-${unitPrefix}-1`,
        sourceLocale: "ja-JP",
        sourceText: "勇者は村を守った。",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: `${unitPrefix}-source.json`,
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.001",
        },
      },
      {
        bridgeUnitId: `${unitPrefix}-unit-2`,
        sourceUnitKey: "scene.001.line.002",
        occurrenceId: "occurrence-2",
        sourceHash: `hash-${unitPrefix}-2`,
        sourceLocale: "ja-JP",
        sourceText: "王女は勇者を信じている。",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: `${unitPrefix}-source.json`,
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.002",
        },
      },
    ],
  };
}
