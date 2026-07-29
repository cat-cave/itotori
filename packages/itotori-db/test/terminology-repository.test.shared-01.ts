import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import {
  ItotoriBranchReferenceRepository,
  branchPolicyGlossaryReferenceUpdatedEventKind,
} from "../src/repositories/branch-reference-repository.js";
import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { ItotoriStyleGuideRepository } from "../src/repositories/style-guide-repository.js";
import { ItotoriTerminologyRepository } from "../src/repositories/terminology-repository.js";
import {
  ItotoriSemanticGlossarySearchService,
  RecordedEmbeddingFixtureAdapter,
  semanticGlossarySearchDiagnosticCodeValues,
} from "../src/services/semantic-search.js";
import {
  catalogSourceProvenance,
  catalogSourceRecordKindValues,
  catalogSourceValues,
  branchPolicyGlossaryReferences,
  events,
  findings,
  localeBranchUnits,
  styleGuideVersionStatusValues,
  terminologyAliasKindValues,
  terminologyConflictEvidence,
  terminologyConflictKindValues,
  terminologyConflictStatusValues,
  terminologySemanticIndex,
  terminologySemanticIndexStatusValues,
  terminologySourceReferenceKindValues,
  terminologyTermKindValues,
  terminologyTerms,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

export function projectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-terminology",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: {
      "bridge-unit-term": "The Crimson Moon rises.",
    },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-terminology",
      sourceBundleHash: "hash-terminology",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-term",
          sourceUnitKey: "terminology.scene.001.line.001",
          occurrenceId: "occurrence-term-1",
          sourceHash: "source-hash-term",
          sourceLocale: "ja-JP",
          sourceText: "紅月{player}が昇る。",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 6, end: 14, preserveMode: "exact" },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "terminology.scene.001.line.001",
          },
        },
      ],
    },
  };
}

export function siblingLocaleProjectFixture(): ItotoriProjectRecord {
  return {
    ...projectFixture(),
    localeBranchId: "locale-fr-fr",
    targetLocale: "fr-FR",
    drafts: {
      "bridge-unit-term": "La lune cramoisie se leve.",
    },
  };
}

export function otherProjectFixture(): ItotoriProjectRecord {
  return {
    projectId: "project-terminology-other",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
    localeBranchId: "locale-en-us-other",
    targetLocale: "en-US",
    drafts: {
      "bridge-unit-other": "The other gate opens.",
    },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-terminology-other",
      sourceBundleHash: "hash-terminology-other",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-other",
          sourceUnitKey: "other.scene.001.line.001",
          occurrenceId: "occurrence-other-1",
          sourceHash: "source-hash-other",
          sourceLocale: "ja-JP",
          sourceText: "門が開く。",
          textSurface: "dialogue",
          protectedSpans: [],
          patchRef: {
            assetId: "other-source.json",
            writeMode: "replace",
            sourceUnitKey: "other.scene.001.line.001",
          },
        },
      ],
    },
  };
}

export async function seedProject(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriProjectRepository(db, testProjectEngineFamilyRegistry);
  await repo.reset(localActor);
  await repo.importSourceBundle(localActor, projectFixture());
}

export async function seedApprovedGlossaryPolicy(db: ItotoriDatabase): Promise<void> {
  const repo = new ItotoriStyleGuideRepository(db);
  await repo.createVersion(localActor, {
    projectId: "project-terminology",
    localeBranchId: "locale-en-us",
    styleGuideVersionId: "style-guide-version-glossary-policy",
    status: styleGuideVersionStatusValues.approved,
    policy: {
      schemaVersion: "itotori.style-guide.policy.v1",
      sections: {
        terminology: [
          {
            termId: "term-context-crimson-moon",
            sourceTerm: "紅月",
            preferredTranslation: "Crimson Moon",
            provenance: {
              sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
              citation: "terminology.scene.001.line.001",
            },
          },
        ],
        protectedSpans: [
          {
            bridgeUnitId: "bridge-unit-term",
            raw: "{player}",
            preserveMode: "exact",
          },
        ],
      },
    },
    semanticDiagnostics: [
      {
        code: "glossary_policy.fixture.ready",
        severity: "info",
        sourceRevisionId: "bridge-terminology:unit:bridge-unit-term",
      },
    ],
  });
}
