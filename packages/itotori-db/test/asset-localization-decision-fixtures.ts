import type { BridgeBundle } from "@itotori/localization-bridge-schema";
import type { AuthorizationActor } from "../src/authorization.js";
import type { ItotoriDatabase } from "../src/connection.js";
import { ItotoriProjectRepository } from "../src/repositories/project-repository.js";
import type { ItotoriProjectRecord } from "../src/repositories/project-repository.js";

export const assetDecisionFixtureProjectId = "project-asset-decision";
export const assetDecisionFixtureLocaleBranchId = "locale-asset-decision";

export function assetDecisionFixtureProject(): ItotoriProjectRecord {
  const bridge: BridgeBundle = {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-asset-decision",
    sourceBundleHash: "hash-asset-decision",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: "unit-asset-1",
        sourceUnitKey: "asset.001.line.001",
        occurrenceId: "occ-asset-1",
        sourceHash: "hash-asset-1",
        sourceLocale: "ja-JP",
        sourceText: "タイトル",
        textSurface: "ui",
        protectedSpans: [],
        patchRef: {
          assetId: "asset.json",
          writeMode: "replace",
          sourceUnitKey: "asset.001.line.001",
        },
      },
    ],
  };
  return {
    projectId: assetDecisionFixtureProjectId,
    localeBranchId: assetDecisionFixtureLocaleBranchId,
    targetLocale: "en-US",
    drafts: {},
    bridge,
  };
}

export async function provisionAssetDecisionFixtureProject(
  db: ItotoriDatabase,
  actor: AuthorizationActor,
): Promise<void> {
  const projects = new ItotoriProjectRepository(db);
  await projects.importSourceBundle(actor, assetDecisionFixtureProject());
}
