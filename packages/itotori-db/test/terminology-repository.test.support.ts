import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";

import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";

import {
  ItotoriProjectRepository,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { ItotoriStyleGuideRepository } from "../src/repositories/style-guide-repository.js";

import { styleGuideVersionStatusValues } from "../src/schema.js";
import { currentProjectFixture } from "./current-project-fixture.js";

const localActor: AuthorizationActor = { userId: localUserId };
const terminologyProject = currentProjectFixture({
  seed: "terminology-primary",
  projectId: "project-terminology",
  localeBranchId: "locale-en-us",
  units: [
    {
      sourceUnitKey: "terminology.scene.001.line.001",
      sourceText: "紅月{player}が昇る。",
      targetText: "The Crimson Moon rises.",
      spans: [{ raw: "{player}" }],
    },
  ],
});
const terminologyUnit = terminologyProject.bridge.units[0];
if (terminologyUnit === undefined) throw new Error("terminology fixture requires one unit");
const otherTerminologyProject = currentProjectFixture({
  seed: "terminology-other",
  projectId: "project-terminology-other",
  localeBranchId: "locale-en-us-other",
  units: [
    {
      sourceUnitKey: "other.scene.001.line.001",
      sourceText: "門が開く。",
      targetText: "The other gate opens.",
    },
  ],
});
const otherTerminologyUnit = otherTerminologyProject.bridge.units[0];
if (otherTerminologyUnit === undefined)
  throw new Error("other terminology fixture requires one unit");

export const terminologyFixture = {
  unitId: terminologyUnit.bridgeUnitId,
  sourceRevisionId: terminologyUnit.sourceRevision.revisionId,
  sourceBundleId: terminologyProject.bridge.bridgeId,
  bundleRevisionId: terminologyProject.bridge.sourceBundleRevision.revisionId,
};
export const otherTerminologyFixture = {
  unitId: otherTerminologyUnit.bridgeUnitId,
  sourceRevisionId: otherTerminologyUnit.sourceRevision.revisionId,
  sourceBundleId: otherTerminologyProject.bridge.bridgeId,
};

export function projectFixture(): ItotoriProjectRecord {
  return structuredClone(terminologyProject);
}

export function siblingLocaleProjectFixture(): ItotoriProjectRecord {
  return {
    ...projectFixture(),
    localeBranchId: "locale-fr-fr",
    targetLocale: "fr-FR",
    drafts: { [terminologyFixture.unitId]: "La lune cramoisie se leve." },
  };
}

export function otherProjectFixture(): ItotoriProjectRecord {
  return structuredClone(otherTerminologyProject);
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
              sourceRevisionId: terminologyFixture.sourceRevisionId,
              citation: "terminology.scene.001.line.001",
            },
          },
        ],
        protectedSpans: [
          {
            bridgeUnitId: terminologyFixture.unitId,
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
        sourceRevisionId: terminologyFixture.sourceRevisionId,
      },
    ],
  });
}
