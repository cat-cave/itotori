import { describe, expect, it } from "vitest";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { ItotoriContextArtifactRepository } from "../src/repositories/context-artifact-repository.js";
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

      const artifacts = new ItotoriContextArtifactRepository(context.db);
      await saveCharacterBio(artifacts, {
        contextArtifactId: "wiki-bio-hero",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        characterId: "勇者",
        bioText: "村を守る主人公。",
        bridgeUnitId: "wiki-unit-1",
      });
      await saveCharacterBio(artifacts, {
        contextArtifactId: "wiki-bio-princess",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        characterId: "王女",
        bioText: "城の継承者。",
        bridgeUnitId: "wiki-unit-2",
      });
      await saveCharacterRelationship(artifacts, {
        contextArtifactId: "wiki-rel-hero-princess",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        fromCharacterId: "勇者",
        toCharacterId: "王女",
        descriptor: "幼なじみ",
        bridgeUnitId: "wiki-unit-2",
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
        relation: "Friendship",
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

      const artifacts = new ItotoriContextArtifactRepository(context.db);
      await saveCharacterBio(artifacts, {
        contextArtifactId: "wiki-brand-bio-rin",
        projectId: baseProjectId,
        localeBranchId: baseBranchId,
        sourceRevisionId: baseRevisionId,
        characterId: "凛",
        bioText: "本編で主人公を支える幼なじみ。",
        bridgeUnitId: "base-unit-1",
      });
      await saveCharacterRelationship(artifacts, {
        contextArtifactId: "wiki-brand-rel-rin-mei",
        projectId: baseProjectId,
        localeBranchId: baseBranchId,
        sourceRevisionId: baseRevisionId,
        fromCharacterId: "凛",
        toCharacterId: "芽衣",
        descriptor: "本編から続く親友",
        bridgeUnitId: "base-unit-2",
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

  it("projects character history from immutable central entry versions", async () => {
    const context = await isolatedMigratedContext();
    try {
      await new ItotoriProjectRepository(context.db).importSourceBundle(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        targetLocale: "en-US",
        drafts: {},
        bridge: bridgeFixture(),
      });

      const artifacts = new ItotoriContextArtifactRepository(context.db);
      await saveCharacterBio(artifacts, {
        contextArtifactId: "wiki-bio-versioned-hero",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        characterId: "勇者",
        bioText: "最初の人物像。",
        bridgeUnitId: "wiki-unit-1",
        generatedAt: new Date("2026-07-06T00:00:00.000Z"),
      });

      const revisedSourceRevisionId = "bridge-wiki-readmodel-v2:bundle-revision";
      await new ItotoriProjectRepository(context.db).importSourceBundle(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        targetLocale: "en-US",
        drafts: {},
        bridge: bridgeFixture({ bridgeId: "bridge-wiki-readmodel-v2", unitPrefix: "wiki-v2" }),
      });
      await saveCharacterBio(artifacts, {
        contextArtifactId: "wiki-bio-versioned-hero",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: revisedSourceRevisionId,
        characterId: "勇者",
        bioText: "更新された人物像。",
        bridgeUnitId: "wiki-v2-unit-2",
        generatedAt: new Date("2026-07-07T00:00:00.000Z"),
      });

      const entry = (
        await new ItotoriWikiReadmodelRepository(context.db).loadEntries(actor, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          kind: wikiEntryKindValues.character,
        })
      ).entries.find((candidate) => candidate.entryId === "character:勇者");

      expect(entry).toMatchObject({
        kind: wikiEntryKindValues.character,
        bio: {
          characterBioId: "wiki-bio-versioned-hero",
          text: "更新された人物像。",
        },
      });
      const character = entry?.kind === wikiEntryKindValues.character ? entry : undefined;
      expect(character?.appearances[0]?.bridgeUnitId).toBe("wiki-v2-unit-2");
      expect(character?.revisions).toHaveLength(2);
      expect(
        new Set(character?.revisions.map((revision) => revision.contextEntryVersionId)).size,
      ).toBe(2);

      const historicalEntry = (
        await new ItotoriWikiReadmodelRepository(context.db).loadEntries(actor, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          sourceRevisionId: SOURCE_REVISION_ID,
          kind: wikiEntryKindValues.character,
        })
      ).entries.find((candidate) => candidate.entryId === "character:勇者");
      const historical =
        historicalEntry?.kind === wikiEntryKindValues.character ? historicalEntry : undefined;
      expect(historical?.bio.text).toBe("最初の人物像。");
      expect(historical?.appearances[0]?.bridgeUnitId).toBe("wiki-unit-1");
      expect(historical?.revisions).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("keeps pre-semanticKind central character heads and history visible", async () => {
    const context = await isolatedMigratedContext();
    try {
      await new ItotoriProjectRepository(context.db).importSourceBundle(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        targetLocale: "en-US",
        drafts: {},
        bridge: bridgeFixture(),
      });
      const artifacts = new ItotoriContextArtifactRepository(context.db);
      await saveCharacterBio(artifacts, {
        contextArtifactId: "wiki-legacy-central-bio",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        characterId: "和人",
        bioText: "最初の中央人物像。",
        bridgeUnitId: "wiki-unit-1",
        generatedAt: new Date("2026-07-06T00:00:00.000Z"),
        semanticKind: false,
      });
      await saveCharacterRelationship(artifacts, {
        contextArtifactId: "wiki-legacy-central-relationship",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        fromCharacterId: "和人",
        toCharacterId: "ステラ",
        descriptor: "幼なじみ",
        bridgeUnitId: "wiki-unit-2",
        semanticKind: false,
      });
      await saveCharacterBio(artifacts, {
        contextArtifactId: "wiki-legacy-central-bio",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        characterId: "和人",
        bioText: "更新された中央人物像。",
        bridgeUnitId: "wiki-unit-1",
        generatedAt: new Date("2026-07-07T00:00:00.000Z"),
        semanticKind: false,
      });

      const entries = await new ItotoriWikiReadmodelRepository(context.db).loadEntries(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        kind: wikiEntryKindValues.character,
      });
      const character = entries.entries.find((entry) => entry.entryId === "character:和人");
      expect(character).toMatchObject({
        kind: wikiEntryKindValues.character,
        bio: { text: "更新された中央人物像。" },
        relationships: [
          expect.objectContaining({ toCharacterId: "ステラ", descriptor: "幼なじみ" }),
        ],
      });
      expect(character?.kind === "character" ? character.revisions : []).toHaveLength(2);
    } finally {
      await context.close();
    }
  });
});

type CharacterBioFixtureInput = {
  contextArtifactId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  characterId: string;
  bioText: string;
  bridgeUnitId: string;
  generatedAt?: Date;
  /** Simulates central entries written before semanticKind was standardized. */
  semanticKind?: boolean;
};

async function saveCharacterBio(
  repository: ItotoriContextArtifactRepository,
  input: CharacterBioFixtureInput,
): Promise<void> {
  await repository.upsertArtifact(actor, {
    contextArtifactId: input.contextArtifactId,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    category: "character_note",
    title: `Character: ${input.characterId}`,
    body: input.bioText,
    data: {
      ...(input.semanticKind === false ? {} : { semanticKind: "character_bio" }),
      characterId: input.characterId,
      bioLocale: "ja-JP",
      citedUnitIds: [input.bridgeUnitId],
      promptTemplateVersion: "wiki-character-v1",
      generatedAt: (input.generatedAt ?? GENERATED_AT).toISOString(),
    },
    producedByTool: "wiki-readmodel-test",
    producerVersion: "wiki-character-v1",
    sourceUnits: [{ bridgeUnitId: input.bridgeUnitId, citation: `character:${input.characterId}` }],
  });
}

type CharacterRelationshipFixtureInput = {
  contextArtifactId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  fromCharacterId: string;
  toCharacterId: string;
  descriptor: string;
  bridgeUnitId: string;
  generatedAt?: Date;
  /** Simulates central entries written before semanticKind was standardized. */
  semanticKind?: boolean;
};

async function saveCharacterRelationship(
  repository: ItotoriContextArtifactRepository,
  input: CharacterRelationshipFixtureInput,
): Promise<void> {
  await repository.upsertArtifact(actor, {
    contextArtifactId: input.contextArtifactId,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    category: "character_note",
    title: `Relationship: ${input.fromCharacterId}->${input.toCharacterId}:Friendship`,
    body: input.descriptor,
    data: {
      ...(input.semanticKind === false ? {} : { semanticKind: "character_relationship" }),
      fromCharacterId: input.fromCharacterId,
      toCharacterId: input.toCharacterId,
      kind: "Friendship",
      direction: "Symmetric",
      descriptorLocale: "ja-JP",
      citedUnitIds: [input.bridgeUnitId],
      promptTemplateVersion: "wiki-character-v1",
      generatedAt: (input.generatedAt ?? GENERATED_AT).toISOString(),
    },
    producedByTool: "wiki-readmodel-test",
    producerVersion: "wiki-character-v1",
    sourceUnits: [
      {
        bridgeUnitId: input.bridgeUnitId,
        citation: `character-relationship:${input.fromCharacterId}->${input.toCharacterId}`,
      },
    ],
  });
}

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
