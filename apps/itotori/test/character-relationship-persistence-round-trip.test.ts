// ITOTORI-149 — Character-relationship agent end-to-end coverage: DB-backed
// persistence round-trip (end-to-end gap #2 deferred by ITOTORI-014).
//
// Spec contract (per qd node ITOTORI-149):
//   • DB round-trip applies migration 0031, persists a Fresh bio + Fresh
//     relationship with non-empty citations, loads it back, and asserts
//     citation arrays + source hashes are equal.
//
// Why this lives here and not in packages/itotori-db/test/:
//   The character-relationship repository round-trip coverage there is
//   gated on DATABASE_URL (no `skipIf` allowed by the db-failure-discipline
//   test). This file uses the same DATABASE_URL gate as
//   `apps/itotori/test/api-http-contract.test.ts` and
//   `apps/itotori/test/project-workflow.test.ts` — the
//   `itotori:db-integration` lane runs these against a freshly-migrated
//   `just db-up` Postgres; the fixture-only lane skips them cleanly.
//
// Why the `generateCharacterRelationships` path is NOT used here:
//   This test focuses on the persistence boundary alone (the third
//   ITOTORI-149 deliverable: round-trip the pack through the repo). Driving
//   the full agent here would couple it to LLM-shimmed provider construction
//   and would shadow the recorded-replay test's coverage. We hand-build a
//   `SaveCharacterBioInput` / `SaveCharacterRelationshipInput` directly so
//   the persistence surface is exercised end-to-end with no provider noise.

import type {
  AuthorizationActor,
  ItotoriCharacterRelationshipRepositoryPort,
  SaveCharacterBioInput,
  SaveCharacterRelationshipInput,
} from "@itotori/db";
import {
  ItotoriCharacterRelationshipRepository as Repository,
  ItotoriProjectRepository,
} from "@itotori/db";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { describe, expect, it } from "vitest";
import type { BridgeBundle, ItotoriProjectRecord } from "@itotori/localization-bridge-schema";

const FIXED_NOW = new Date("2026-06-23T12:00:00.000Z");

const actor: AuthorizationActor = { userId: "local-user" };
const dbBackedIt = process.env.DATABASE_URL ? it : it.skip;

function bridgeFixture(): BridgeBundle {
  return {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-character-relationship-roundtrip",
    sourceBundleHash: "hash-character-relationship-roundtrip",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "019ed118-0000-7000-8000-000000000a01",
        sourceUnitKey: "scene.001.line.001",
        occurrenceId: "occurrence-rel-1",
        sourceHash: "hash-rel-unit-1",
        sourceLocale: "ja-JP",
        sourceText: "勇者は王様に挨拶した。",
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "source.json",
          writeMode: "replace",
          sourceUnitKey: "scene.001.line.001",
        },
      },
      {
        bridgeUnitId: "019ed118-0000-7000-8000-000000000a02",
        sourceUnitKey: "scene.001.line.002",
        occurrenceId: "occurrence-rel-2",
        sourceHash: "hash-rel-unit-2",
        sourceLocale: "ja-JP",
        sourceText: "勇者と王女は古くからの友人だ。",
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

function projectFixture(): ItotoriProjectRecord {
  return {
    projectId: "019ed118-0000-7000-8000-0000000000p1",
    localeBranchId: "019ed118-0000-7000-8000-0000000000b1",
    targetLocale: "en-US",
    drafts: {},
    bridge: bridgeFixture(),
  };
}

const PROJECT_ID = "019ed118-0000-7000-8000-0000000000p1";
const LOCALE_BRANCH_ID = "019ed118-0000-7000-8000-0000000000b1";
const SOURCE_REVISION_ID = "019ed118-0000-7000-8000-0000000000r1";

async function seedSourceRevision(context: {
  pool: {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: T[] }>;
  };
}): Promise<void> {
  // FK from itotori_character_bios.source_revision_id and
  // itotori_character_relationships.source_revision_id → itotori_source_revisions.source_revision_id.
  // Seed it directly via SQL — no service-layer surface in the repo for this.
  await context.pool.query(
    `insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
     values ($1, $2, $3, $4)
     on conflict (source_revision_id) do nothing`,
    [SOURCE_REVISION_ID, PROJECT_ID, "content_hash", "hash-character-relationship-roundtrip-rev"],
  );
}

function saveBioFixture(): SaveCharacterBioInput {
  return {
    characterBioId: "019ed118-0000-7000-8000-0000000000b10",
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: SOURCE_REVISION_ID,
    characterId: "勇者",
    bioLocale: "ja-JP",
    bioText: "物語の主人公。王様と王女に深く関わる。",
    modelProviderFamily: "fake",
    modelId: "itotori-fake-character-relationship-v0",
    modelContextWindowTokens: 16000,
    modelMaxOutputTokens: 1024,
    promptTemplateVersion: "itotori-character-relationship-v1",
    promptHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    inputTokenEstimate: 421,
    completionTokens: 384,
    generatedAt: FIXED_NOW,
    citations: [
      {
        bridgeUnitId: "019ed118-0000-7000-8000-000000000a01",
        citedSourceHash: "hash-rel-unit-1",
        citeOrdinal: 1,
      },
      {
        bridgeUnitId: "019ed118-0000-7000-8000-000000000a02",
        citedSourceHash: "hash-rel-unit-2",
        citeOrdinal: 2,
      },
    ],
  };
}

function saveRelationshipFixture(): SaveCharacterRelationshipInput {
  return {
    characterRelationshipId: "019ed118-0000-7000-8000-0000000000r10",
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: SOURCE_REVISION_ID,
    fromCharacterId: "勇者",
    toCharacterId: "王女",
    kind: "Friendship",
    direction: "Symmetric",
    descriptor: "幼馴染",
    descriptorLocale: "ja-JP",
    modelProviderFamily: "fake",
    modelId: "itotori-fake-character-relationship-v0",
    modelContextWindowTokens: 16000,
    modelMaxOutputTokens: 1024,
    promptTemplateVersion: "itotori-character-relationship-v1",
    promptHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    generatedAt: FIXED_NOW,
    citations: [
      {
        bridgeUnitId: "019ed118-0000-7000-8000-000000000a02",
        citedSourceHash: "hash-rel-unit-2",
        citeOrdinal: 1,
      },
    ],
  };
}

describe("character-relationship persistence round-trip (ITOTORI-149)", () => {
  dbBackedIt(
    "applies migration 0031, persists Fresh bios+relationships with non-empty citations, loads them back byte-equal",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        // Set up the FK dependency: character_bios / character_relationships
        // reference projects.project_id + itotori_source_revisions.source_revision_id,
        // so we import a project FIRST and seed a source revision BEFORE
        // attempting any bios/relationships insert (matches the live sequence
        // a real CLI invocation follows).
        const projectRepository = new ItotoriProjectRepository(context.db);
        await projectRepository.importSourceBundle(actor, projectFixture());
        await seedSourceRevision(context);

        // Sanity: migration 0031 must have applied (itotori_character_bios +
        // itotori_character_relationships + itotori_character_bio_evidence +
        // itotori_character_relationship_evidence). The migration drift tests
        // in packages/itotori-db/test/ catch the schema shape; here we
        // assert the tables are queryable end-to-end through the repo.
        const tables = await context.pool.query<{ table_name: string }>(
          `select table_name from information_schema.tables where table_schema = current_schema() and table_name like 'itotori_character_%' order by table_name`,
        );
        const tableNames = tables.rows.map((row) => row.table_name);
        expect(tableNames).toEqual([
          "itotori_character_bio_evidence",
          "itotori_character_bios",
          "itotori_character_relationship_evidence",
          "itotori_character_relationships",
        ]);

        const repository: ItotoriCharacterRelationshipRepositoryPort = new Repository(context.db);

        const savedBio = await repository.saveBio(actor, saveBioFixture());
        const savedRelationship = await repository.saveRelationship(
          actor,
          saveRelationshipFixture(),
        );

        // The records come back Fresh; citations are persisted in citeOrdinal
        // order so the load path's stable sort is already exercised.
        expect(savedBio.status).toBe("Fresh");
        expect(savedBio.invalidatedAt).toBeNull();
        expect(savedBio.invalidatedReason).toBeNull();
        expect(savedBio.citations).toHaveLength(2);
        expect(savedBio.citations.map((c) => c.citeOrdinal)).toEqual([1, 2]);

        expect(savedRelationship.status).toBe("Fresh");
        expect(savedRelationship.invalidatedAt).toBeNull();
        expect(savedRelationship.invalidatedReason).toBeNull();
        expect(savedRelationship.citations).toHaveLength(1);

        // loadBioByCharacter — round-trip the bio by its natural key.
        const loadedBio = await repository.loadBioByCharacter(actor, {
          projectId: saveBioFixture().projectId,
          localeBranchId: saveBioFixture().localeBranchId,
          sourceRevisionId: saveBioFixture().sourceRevisionId,
          characterId: saveBioFixture().characterId,
          promptTemplateVersion: "itotori-character-relationship-v1",
        });
        expect(loadedBio).not.toBeNull();
        expect(loadedBio?.characterBioId).toBe(savedBio.characterBioId);
        expect(loadedBio?.bioText).toBe(saveBioFixture().bioText);
        // Citation arrays + source hashes are equal (the load-bearing
        // acceptance contract).
        expect(loadedBio?.citations.map((c) => c.bridgeUnitId)).toEqual(
          saveBioFixture().citations.map((c) => c.bridgeUnitId),
        );
        expect(loadedBio?.citations.map((c) => c.citedSourceHash)).toEqual(
          saveBioFixture().citations.map((c) => c.citedSourceHash),
        );
        expect(loadedBio?.citations.map((c) => c.citeOrdinal)).toEqual(
          saveBioFixture().citations.map((c) => c.citeOrdinal),
        );

        // loadRelationshipsByProject — round-trip the relationship.
        const loadedRelationships = await repository.loadRelationshipsByProject(actor, {
          projectId: saveRelationshipFixture().projectId,
          localeBranchId: saveRelationshipFixture().localeBranchId,
          sourceRevisionId: saveRelationshipFixture().sourceRevisionId,
          promptTemplateVersion: "itotori-character-relationship-v1",
        });
        expect(loadedRelationships).toHaveLength(1);
        const loadedRelationship = loadedRelationships[0]!;
        expect(loadedRelationship.characterRelationshipId).toBe(
          savedRelationship.characterRelationshipId,
        );
        expect(loadedRelationship.fromCharacterId).toBe("勇者");
        expect(loadedRelationship.toCharacterId).toBe("王女");
        expect(loadedRelationship.kind).toBe("Friendship");
        expect(loadedRelationship.direction).toBe("Symmetric");
        expect(loadedRelationship.descriptor).toBe("幼馴染");
        // Citation arrays + source hashes are equal (load-bearing).
        expect(loadedRelationship.citations.map((c) => c.bridgeUnitId)).toEqual(
          saveRelationshipFixture().citations.map((c) => c.bridgeUnitId),
        );
        expect(loadedRelationship.citations.map((c) => c.citedSourceHash)).toEqual(
          saveRelationshipFixture().citations.map((c) => c.citedSourceHash),
        );
        expect(loadedRelationship.citations.map((c) => c.citeOrdinal)).toEqual(
          saveRelationshipFixture().citations.map((c) => c.citeOrdinal),
        );

        // loadBios — round-trip via the broader loader too, so we exercise
        // both query paths against the same persisted row.
        const loadedBiosByQuery = await repository.loadBios(actor, {
          projectId: saveBioFixture().projectId,
          localeBranchId: saveBioFixture().localeBranchId,
          sourceRevisionId: saveBioFixture().sourceRevisionId,
        });
        expect(loadedBiosByQuery).toHaveLength(1);
        expect(loadedBiosByQuery[0]?.characterBioId).toBe(savedBio.characterBioId);
        expect(loadedBiosByQuery[0]?.citations.map((c) => c.citedSourceHash)).toEqual(
          saveBioFixture().citations.map((c) => c.citedSourceHash),
        );
      } finally {
        await context.close();
      }
    },
  );

  dbBackedIt(
    "saveBio upserts the same Fresh bio (re-running for a (project, locale-branch, source-revision, character, templateVersion) tuple replaces the prior row's evidence)",
    async () => {
      const context = await isolatedMigratedContext();
      try {
        const projectRepository = new ItotoriProjectRepository(context.db);
        await projectRepository.importSourceBundle(actor, projectFixture());
        await seedSourceRevision(context);

        const repository = new Repository(context.db);

        const first = await repository.saveBio(actor, saveBioFixture());
        // Second save with the SAME composite key but a DIFFERENT bio id and
        // different citation set — the upsert contract from
        // character-relationship-repository.ts:saveBio deletes the prior row
        // + evidence before inserting the new one. We assert the row count
        // remains 1 and the citations reflect the LATEST save.
        const secondBio: SaveCharacterBioInput = {
          ...saveBioFixture(),
          characterBioId: "019ed118-0000-7000-8000-0000000000b11",
          bioText: "物語の主人公 (regenerated)。",
          citations: [
            {
              bridgeUnitId: "019ed118-0000-7000-8000-000000000a01",
              citedSourceHash: "hash-rel-unit-1-mutated",
              citeOrdinal: 1,
            },
          ],
        };
        const second = await repository.saveBio(actor, secondBio);

        expect(second.characterBioId).toBe(secondBio.characterBioId);
        expect(second.citations).toHaveLength(1);
        expect(second.citations[0]?.citedSourceHash).toBe("hash-rel-unit-1-mutated");

        const all = await repository.loadBios(actor, {
          projectId: secondBio.projectId,
          localeBranchId: secondBio.localeBranchId,
          sourceRevisionId: secondBio.sourceRevisionId,
        });
        expect(all).toHaveLength(1);
        expect(all[0]?.characterBioId).toBe(second.characterBioId);
        expect(all[0]?.bioText).toBe("物語の主人公 (regenerated)。");
        expect(all[0]?.citations[0]?.citedSourceHash).toBe("hash-rel-unit-1-mutated");

        // The first row's evidence is gone — no orphans.
        const firstBioId = first.characterBioId;
        const orphans = await context.pool.query<{ count: string }>(
          `select count(*)::text as count from itotori_character_bio_evidence where character_bio_id = $1`,
          [firstBioId],
        );
        expect(orphans.rows[0]?.count).toBe("0");
      } finally {
        await context.close();
      }
    },
  );
});
