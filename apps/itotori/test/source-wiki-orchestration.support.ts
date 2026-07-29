import { describe, expect, it } from "vitest";
import type { FactSnapshot } from "../src/prepass/index.js";
import type { EntityRef, RouteScope, RunModeValue, WikiObject } from "../src/contracts/index.js";
import {
  InMemoryArtifactLedger,
  ObjectRejectedError,
  SourceWikiSelectionError,
  acceptObject,
  artifactKey,
  buildSourceWikiPlan,
  deriveWorkSource,
  isRecoverablyUncitable,
  orchestrateSourceWiki,
  planSourceWiki,
  selectSourceWikiRoles,
  type AnalystRunner,
  type RunStepInput,
} from "../src/source-wiki/index.js";
import { ANALYST_RUNNER_ROLE_IDS, assertAnalystRunnerCoverage } from "../src/composition/index.js";

export const SNAP = `sha256:${"a".repeat(64)}` as const;

export const RUN_MODE: RunModeValue = "test-dev";

export const SOURCE_LANG = "ja-JP";

export function unit(factId: string, sceneId: number, routeId: string) {
  return {
    factId,
    sceneId,
    routeScope: { kind: "route", routeId } as const,
    playReveal: { playOrderIndex: sceneId, revealSceneOrder: null, revealItemOrder: null },
  };
}

export function syntheticSnapshot(): FactSnapshot {
  const partial = {
    source: {
      bridgeId: "game-alpha",
      sourceBundleHash: SNAP,
      entryScene: 10,
      structureSchemaVersion: "v2",
    },
    orderedUnits: [
      unit("u-10", 10, "r1"),
      unit("u-11", 11, "r1"),
      unit("u-12", 12, "r2"),
      unit("u-13", 13, "r2"),
    ],
    scenes: [],
    routeTopology: {
      entryScene: 10,
      sceneDispatchOrder: [10, 11, 12, 13],
      edges: [],
      reachableSceneIds: [],
      unreachableSceneIds: [],
      reachableUnitKeys: [],
    },
    characters: [
      {
        factId: "character:c1",
        characterId: "c1",
        totalLines: 1,
        firstSceneId: 10,
        lastSceneId: 10,
        sceneIds: [10],
        linesByScene: [{ sceneId: 10, lineCount: 1 }],
      },
      {
        factId: "character:c2",
        characterId: "c2",
        totalLines: 1,
        firstSceneId: 11,
        lastSceneId: 11,
        sceneIds: [11],
        linesByScene: [{ sceneId: 11, lineCount: 1 }],
      },
      {
        factId: "character:c3",
        characterId: "c3",
        totalLines: 1,
        firstSceneId: 12,
        lastSceneId: 12,
        sceneIds: [12],
        linesByScene: [{ sceneId: 12, lineCount: 1 }],
      },
    ],
    terminology: [
      {
        factId: "term:t-alpha",
        termKey: "t-alpha",
        policyAction: "preserve",
        aliases: ["alpha"],
        occurrenceCount: 1,
        occurrenceUnitKeys: ["u-10"],
      },
      {
        factId: "term:t-beta",
        termKey: "t-beta",
        policyAction: "preserve",
        aliases: ["beta"],
        occurrenceCount: 1,
        occurrenceUnitKeys: ["u-11"],
      },
    ],
    choiceLabels: { totalCount: 0, unitKeys: [] },
    glossaryConflicts: [
      {
        factId: "conflict:t-alpha",
        kind: "policy_action_conflict",
        termKey: "t-alpha",
        detail: "synthetic ambiguity",
      },
    ],
    snapshotId: SNAP,
    contentHash: SNAP,
    schemaVersion: "itotori.fact-snapshot.v1",
  };
  return partial as unknown as FactSnapshot;
}

export function claim() {
  return {
    claimId: "claim-0",
    statement: "この作品は一貫した語り口を保つ。",
    scope: { kind: "global" },
    kind: "beat",
    confidence: "high",
    citations: [
      {
        evidenceId: "u-10",
        evidenceHash: SNAP,
        snapshotId: SNAP,
        subject: { kind: "unit", id: "u-10" },
        role: "supports",
        playOrderIndex: 0,
      },
    ],
  };
}

export interface ObjectOverrides {
  lang?: string;
  contextScope?: string;
  runMode?: string;
  claims?: unknown[];
  subject?: EntityRef;
  scope?: RouteScope;
  kind?: string;
}

export function makeObject(
  kind: string,
  subject: EntityRef,
  scope: RouteScope,
  role: string,
  overrides: ObjectOverrides = {},
): WikiObject {
  return {
    schemaVersion: "itotori.wiki-object.v1",
    objectId: `${kind}:${subject.id}`,
    version: 1,
    lang: overrides.lang ?? SOURCE_LANG,
    subject: overrides.subject ?? subject,
    scope: overrides.scope ?? scope,
    claims: overrides.claims ?? [claim()],
    media: [],
    dependencies: [],
    provisional: false,
    kind: overrides.kind ?? kind,
    body: {},
    provenance: {
      snapshotKind: "context",
      contextSnapshotId: SNAP,
      contextScope: overrides.contextScope ?? "whole-game",
      runMode: overrides.runMode ?? RUN_MODE,
      authorRoleId: role,
    },
  } as unknown as WikiObject;
}

export function recordedRunner(): AnalystRunner {
  return async (input) =>
    input.step.targets.map((target) =>
      makeObject(target.kind, target.subject, target.scope, input.role),
    );
}

export function baseDeps(overrides: Partial<Parameters<typeof orchestrateSourceWiki>[0]> = {}) {
  return {
    snapshot: syntheticSnapshot(),
    sourceLanguage: SOURCE_LANG,
    runMode: RUN_MODE,
    concurrency: 2,
    runner: recordedRunner(),
    ledger: new InMemoryArtifactLedger(),
    ...overrides,
  };
}
