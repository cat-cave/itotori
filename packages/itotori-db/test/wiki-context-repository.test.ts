import { describe, expect, it } from "vitest";
import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import { localUserId, permissionValues, type AuthorizationActor } from "../src/authorization.js";
import {
  contextArtifactCategoryValues,
  ItotoriContextArtifactRepository,
} from "../src/repositories/context-artifact-repository.js";
import {
  ItotoriWikiContextRepository,
  wikiContextEntryKindValues,
} from "../src/repositories/wiki-context-repository.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import type { ItotoriDatabase } from "../src/connection.js";
import { userPermissionGrants, users } from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const playTesterActor: AuthorizationActor = { userId: "wiki-context-play-tester" };
const deniedActor: AuthorizationActor = { userId: "user-without-required-permission" };
const PROJECT_ID = "project-wiki-context";
const LOCALE_BRANCH_ID = "locale-wiki-context";
const SOURCE_REVISION_ID = "bridge-wiki-context:bundle-revision";
const UNIT_ONE = "wiki-context-unit-1";
const UNIT_TWO = "wiki-context-unit-2";

// The package-level test launcher already refuses to invoke this suite without
// DATABASE_URL, so an in-suite conditional skip would conceal a missing live
// database from its failure-discipline guard.
describe("ItotoriWikiContextRepository", () => {
  it("lists every run-generated context kind with real content, provenance, citations, and impact", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const artifacts = new ItotoriContextArtifactRepository(context.db);
      await seedAllKinds(artifacts);
      const repository = new ItotoriWikiContextRepository(context.db);

      const firstPage = await repository.listEntries(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        limit: 3,
      });
      expect(firstPage.pagination).toEqual({
        total: 8,
        limit: 3,
        offset: 0,
        hasMore: true,
        nextOffset: 3,
      });

      const page = await repository.listEntries(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        limit: 100,
      });
      expect(new Set(page.entries.map((entry) => entry.kind))).toEqual(
        new Set(Object.values(wikiContextEntryKindValues)),
      );
      const scene = page.entries.find((entry) => entry.contextArtifactId === "wiki-context-scene");
      expect(scene).toMatchObject({
        category: contextArtifactCategoryValues.sceneSummary,
        kind: wikiContextEntryKindValues.scene,
        title: "Station arrival",
        body: "The hero arrives before the route split.",
        data: { sceneId: "scene.001", generatedBy: "run-enrichment" },
        provenance: {
          producedByAgent: "scene-summary",
          producedByTool: "tool.scene-summary",
          origin: "semantic_enrichment",
          providerRunId: "provider-run-scene",
          provenance: {
            kind: "semantic_enrichment",
            providerRunId: "provider-run-scene",
          },
        },
        citations: [
          {
            bridgeUnitId: UNIT_ONE,
            citation: "scene:scene.001",
          },
        ],
        impact: { affectedUnitIds: [UNIT_ONE], invalidatedReason: null, invalidatedAt: null },
      });

      const terms = await repository.listEntries(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        kind: wikiContextEntryKindValues.term,
      });
      expect(terms.pagination).toMatchObject({ total: 1, hasMore: false, nextOffset: null });
      expect(terms.entries[0]).toMatchObject({
        kind: wikiContextEntryKindValues.term,
        body: "Moon Sigil (system_term): a recurring route lock.",
      });
    } finally {
      await context.close();
    }
  });

  it("shows the canonical head and full immutable history with historical citations and affected units", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedProject(context.db);
      const artifacts = new ItotoriContextArtifactRepository(context.db);
      const first = await artifacts.upsertArtifact(
        actor,
        artifactInput({
          contextArtifactId: "wiki-context-character-history",
          category: contextArtifactCategoryValues.characterNote,
          title: "Character: Mira",
          body: "Mira is the station archivist.",
          data: { semanticKind: "character_bio", characterId: "Mira", revision: 1 },
          provenance: { kind: "semantic_enrichment", providerRunId: "provider-run-character-v1" },
          bridgeUnitId: UNIT_ONE,
          citation: "character:Mira:v1",
        }),
      );
      await context.db.insert(users).values({
        userId: playTesterActor.userId,
        displayName: "Wiki context play tester",
      });
      await context.db.insert(userPermissionGrants).values({
        userId: playTesterActor.userId,
        permission: permissionValues.projectImport,
      });
      const second = await artifacts.upsertArtifact(
        playTesterActor,
        artifactInput({
          contextArtifactId: "wiki-context-character-history",
          category: contextArtifactCategoryValues.characterNote,
          title: "Character: Mira",
          body: "Mira is the station archivist and route guide.",
          data: { semanticKind: "character_bio", characterId: "Mira", revision: 2 },
          provenance: { origin: "play_tester_edit", correctionId: "wiki-correction-mira" },
          bridgeUnitId: UNIT_TWO,
          citation: "play-tester correction:Mira",
          producedByAgent: "play-tester",
          producedByTool: "tool.play-tester-context-correction",
        }),
      );
      const repository = new ItotoriWikiContextRepository(context.db);

      const shown = await repository.showEntry(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        contextArtifactId: "wiki-context-character-history",
      });
      if (shown === null) {
        throw new Error("seeded character context entry was not found");
      }
      expect(shown.entry).toMatchObject({
        kind: wikiContextEntryKindValues.character,
        body: "Mira is the station archivist and route guide.",
        headVersionId: second.headVersionId,
        versionCount: 2,
        provenance: expect.objectContaining({ createdByUserId: "wiki-context-play-tester" }),
        citations: [{ bridgeUnitId: UNIT_TWO, citation: "play-tester correction:Mira" }],
        impact: { affectedUnitIds: [UNIT_TWO] },
      });
      expect(shown.entry.history).toEqual([
        expect.objectContaining({
          contextEntryVersionId: first.headVersionId,
          parentVersionId: null,
          body: "Mira is the station archivist.",
          citations: [expect.objectContaining({ bridgeUnitId: UNIT_ONE })],
          impact: expect.objectContaining({ affectedUnitIds: [UNIT_ONE] }),
          isHead: false,
        }),
        expect.objectContaining({
          contextEntryVersionId: second.headVersionId,
          parentVersionId: first.headVersionId,
          body: "Mira is the station archivist and route guide.",
          provenance: expect.objectContaining({ origin: "play_tester_edit" }),
          citations: [expect.objectContaining({ bridgeUnitId: UNIT_TWO })],
          impact: expect.objectContaining({ affectedUnitIds: [UNIT_TWO] }),
          isHead: true,
        }),
      ]);

      const history = await repository.listEntryHistory(actor, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        contextArtifactId: "wiki-context-character-history",
      });
      expect(history).toMatchObject({
        contextArtifactId: "wiki-context-character-history",
        headVersionId: second.headVersionId,
        versions: [
          expect.objectContaining({ contextEntryVersionId: first.headVersionId }),
          expect.objectContaining({ contextEntryVersionId: second.headVersionId }),
        ],
      });
    } finally {
      await context.close();
    }
  });

  it("requires catalog.read for browse, detail, and history", async () => {
    const context = await isolatedMigratedContext();
    try {
      const repository = new ItotoriWikiContextRepository(context.db);
      const lookup = {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        contextArtifactId: "wiki-context-denied",
      };
      await expect(repository.listEntries(deniedActor, lookup)).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "catalog.read",
      });
      await expect(repository.showEntry(deniedActor, lookup)).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "catalog.read",
      });
      await expect(repository.listEntryHistory(deniedActor, lookup)).rejects.toMatchObject({
        name: "AuthorizationError",
        permission: "catalog.read",
      });
    } finally {
      await context.close();
    }
  });
});

async function seedProject(db: ItotoriDatabase): Promise<void> {
  await new ItotoriProjectRepository(db).importSourceBundle(actor, {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    targetLocale: "en-US",
    drafts: {},
    bridge: bridgeFixture(),
  });
}

async function seedAllKinds(repository: ItotoriContextArtifactRepository): Promise<void> {
  const entries: ContextArtifactFixtureInput[] = [
    {
      contextArtifactId: "wiki-context-scene",
      category: contextArtifactCategoryValues.sceneSummary,
      title: "Station arrival",
      body: "The hero arrives before the route split.",
      data: { sceneId: "scene.001", generatedBy: "run-enrichment" },
      provenance: { kind: "semantic_enrichment", providerRunId: "provider-run-scene" },
      bridgeUnitId: UNIT_ONE,
      citation: "scene:scene.001",
      producedByAgent: "scene-summary",
      producedByTool: "tool.scene-summary",
    },
    {
      contextArtifactId: "wiki-context-character",
      category: contextArtifactCategoryValues.characterNote,
      title: "Character: Mira",
      body: "Mira keeps the station archive.",
      data: { semanticKind: "character_bio", characterId: "Mira" },
      provenance: { kind: "semantic_enrichment", providerRunId: "provider-run-character" },
      bridgeUnitId: UNIT_ONE,
      citation: "character:Mira",
      producedByAgent: "character-relationship",
      producedByTool: "tool.character-relationship",
    },
    {
      contextArtifactId: "wiki-context-route",
      category: contextArtifactCategoryValues.routeMap,
      title: "Moon route",
      body: "The moon route opens after the archive choice.",
      data: { routeKey: "moon" },
      provenance: { kind: "semantic_enrichment", providerRunId: "provider-run-route" },
      bridgeUnitId: UNIT_TWO,
      citation: "route:moon",
      producedByAgent: "route-choice-map",
      producedByTool: "tool.route-choice-map",
    },
    {
      contextArtifactId: "wiki-context-term",
      category: contextArtifactCategoryValues.terminologyCandidate,
      title: "Moon Sigil",
      body: "Moon Sigil (system_term): a recurring route lock.",
      data: { surfaceForm: "月の印", kind: "system_term" },
      provenance: { kind: "semantic_enrichment", providerRunId: "provider-run-term" },
      bridgeUnitId: UNIT_ONE,
      citation: "term:moon-sigil",
      producedByAgent: "terminology-candidate",
      producedByTool: "tool.terminology-candidate",
    },
    {
      contextArtifactId: "wiki-context-speaker",
      category: contextArtifactCategoryValues.speakerLabel,
      title: "Speaker label: unit two",
      body: "Speaker: Mira (confidence=high)",
      data: { speakerLabel: { speaker: "Mira", confidence: "high" } },
      provenance: { kind: "speaker_label" },
      bridgeUnitId: UNIT_TWO,
      citation: "speaker:Mira",
      producedByAgent: "speaker-label",
      producedByTool: "tool.speaker-label",
    },
    {
      contextArtifactId: "wiki-context-glossary",
      category: contextArtifactCategoryValues.glossary,
      title: "Archive",
      body: "Use Archive as the canonical English term.",
      data: { sourceTerm: "資料室" },
      provenance: { origin: "play_tester_edit" },
      bridgeUnitId: UNIT_ONE,
      citation: "glossary:archive",
      producedByAgent: "play-tester",
      producedByTool: "tool.play-tester-context-correction",
    },
    {
      contextArtifactId: "wiki-context-style",
      category: contextArtifactCategoryValues.style,
      title: "Station tone",
      body: "Keep station announcements calm and formal.",
      data: { register: "formal" },
      provenance: { origin: "play_tester_edit" },
      bridgeUnitId: UNIT_TWO,
      citation: "style:station",
      producedByAgent: "play-tester",
      producedByTool: "tool.play-tester-context-correction",
    },
    {
      contextArtifactId: "wiki-context-note",
      category: contextArtifactCategoryValues.contextNote,
      title: "Route note",
      body: "The archive choice is only visible after the station scene.",
      data: { source: "playtest" },
      provenance: { origin: "play_tester_edit" },
      bridgeUnitId: UNIT_TWO,
      citation: "note:route",
      producedByAgent: "play-tester",
      producedByTool: "tool.play-tester-context-correction",
    },
  ];
  for (const entry of entries) {
    await repository.upsertArtifact(actor, artifactInput(entry));
  }
}

type ContextArtifactFixtureInput = {
  contextArtifactId: string;
  category: (typeof contextArtifactCategoryValues)[keyof typeof contextArtifactCategoryValues];
  title: string;
  body: string;
  data: Record<string, unknown>;
  provenance: Record<string, unknown>;
  bridgeUnitId: string;
  citation: string;
  producedByAgent?: string;
  producedByTool?: string;
};

function artifactInput(input: ContextArtifactFixtureInput) {
  return {
    contextArtifactId: input.contextArtifactId,
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: SOURCE_REVISION_ID,
    category: input.category,
    title: input.title,
    body: input.body,
    data: input.data,
    provenance: input.provenance,
    producedByAgent: input.producedByAgent ?? "run-enrichment",
    producedByTool: input.producedByTool ?? "tool.run-enrichment",
    producerVersion: "wiki-context-test-v1",
    sourceUnits: [{ bridgeUnitId: input.bridgeUnitId, citation: input.citation }],
  };
}

function bridgeFixture(): BridgeBundle {
  return {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-wiki-context",
    sourceBundleHash: "hash-wiki-context",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: UNIT_ONE,
        sourceUnitKey: "scene.001.line.001",
        occurrenceId: "wiki-context-occurrence-1",
        sourceHash: "hash-wiki-context-1",
        sourceLocale: "ja-JP",
        sourceText: "駅に着いた。",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "wiki-context-source.json",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.001",
        },
      },
      {
        bridgeUnitId: UNIT_TWO,
        sourceUnitKey: "scene.001.line.002",
        occurrenceId: "wiki-context-occurrence-2",
        sourceHash: "hash-wiki-context-2",
        sourceLocale: "ja-JP",
        sourceText: "資料室へ向かう。",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "wiki-context-source.json",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.002",
        },
      },
    ],
  };
}
