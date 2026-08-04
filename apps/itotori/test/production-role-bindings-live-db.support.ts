import { ItotoriLlmWikiRepository } from "@itotori/db";
import { expect } from "vitest";
import { createFieldMemoCipher } from "../src/composition/live/index.js";
import { providerBudgetCohort } from "../src/composition/provider-budget-cohort.js";
import { LocalizedRenderingSchema, WikiObjectSchema } from "../src/contracts/index.js";
import { FULL_ROSTER, type RunPolicyRequest } from "../src/run-policy/index.js";
import type { ItotoriApplicationServices } from "../src/services/database-services.js";
import { persistLocalizedRendering, persistWikiObject } from "../src/wiki/object-persistence.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { loadBridgeBundle, wholeGameStructure } from "./support/gate-fixtures.js";
import {
  Q5_BACKGROUND_ASSET,
  Q5_FIXTURE_IDENTITIES,
  type RealLiveQ5Fixture,
} from "./production-role-bindings-reallive-fixture.support.js";
export const STYLE_SOURCE_ID = "style-contract:q5-fixture";
const STYLE_RENDERING_ID_PREFIX = "rendering:style-contract:q5-fixture";
const CHARACTER_ID = Q5_FIXTURE_IDENTITIES.characterId;
const SPEAKER_ID = Q5_FIXTURE_IDENTITIES.speakerId;
const ROUTE_ID = Q5_FIXTURE_IDENTITIES.routeId;
const NAME_SOURCE_ID = "term-ruling:q5-fixture:name";
const VOICE_SOURCE_ID = "voice-profile:q5-fixture:fixture";
const ARC_SOURCE_ID = "route-arc:q5-fixture";
export type RoleBindingRunMode = "production" | "test-dev";
export const launchEnvironment = {
  OPENROUTER_API_KEY: "fixture-transport-key",
  ITOTORI_TARGET_LOCALE: "en-US",
  ITOTORI_DRAFT_SCHEMA_HASH: hash("a"),
  ITOTORI_DECODE_REVISION_HASH: hash("b"),
  ITOTORI_GLOSSARY_REVISION_HASH: hash("c"),
  ITOTORI_STYLE_REVISION_HASH: hash("d"),
  ITOTORI_LOCALIZE_MAX_ATTEMPT_EXPOSURE_USD: "0.000010",
  ITOTORI_LOCALIZE_COST_CAP_USD: "1.000000",
  ITOTORI_FIELD_CIPHER_KEY: Buffer.alloc(32, 17).toString("base64"),
};
export function commandArgs(
  projectId: string,
  runId: string,
  localeBranchId: string,
  ablation: boolean,
  runtimeFixture?: RealLiveQ5Fixture,
  runMode: RoleBindingRunMode = "test-dev",
): readonly string[] {
  return [
    "localize",
    "--run-mode",
    runMode,
    "--project-id",
    projectId,
    "--run-id",
    runId,
    "--locale-branch-id",
    localeBranchId,
    "--target-locale",
    "en-US",
    "--source-root",
    runtimeFixture?.sourceRoot ?? "/fixture/q5/source",
    "--build-root",
    runtimeFixture?.buildRoot ?? "/fixture/q5/build",
    ...(runtimeFixture === undefined ? [] : ["--runtime-background-asset", Q5_BACKGROUND_ASSET]),
    "--structure",
    "structure.json",
    "--bridge",
    "bridge.json",
    ...(ablation ? ["--ablation"] : []),
    "--output",
    "summary.json",
  ];
}
export function commandDeps(
  services: ItotoriApplicationServices,
  outputs: Map<string, unknown>,
  runtimeFixture?: RealLiveQ5Fixture,
) {
  return {
    io: {
      readJson(path: string): unknown {
        if (path === "structure.json") return structureFor(runtimeFixture);
        if (path === "bridge.json") return bridgeFor(runtimeFixture);
        throw new Error(`unexpected Q5 fixture input ${path}`);
      },
      writeJson(path: string, value: unknown): void {
        outputs.set(path, value);
      },
    },
    projectWorkflow: services.projectWorkflow,
    providerBudgetCohorts: services.localizationSubstrate.providerBudgetCohorts,
    resolvePortSource: (
      request: RunPolicyRequest,
      perRun: Parameters<
        ItotoriApplicationServices["localizationSubstrate"]["resolvePortSource"]
      >[1],
    ) => services.localizationSubstrate.resolvePortSource(request, perRun),
  };
}
export async function seedStyleBible(input: {
  readonly services: ItotoriApplicationServices;
  readonly context: Awaited<ReturnType<typeof isolatedMigratedContext>>;
  readonly projectId: string;
  readonly runId: string;
  readonly localeBranchId: string;
  readonly sourceInstalled: boolean;
  readonly runtimeFixture?: RealLiveQ5Fixture;
  readonly runMode?: RoleBindingRunMode;
}) {
  const runMode = input.runMode ?? "test-dev";
  const perRun = {
    structureJson: structureFor(input.runtimeFixture),
    bridge: bridgeFor(input.runtimeFixture),
    projectRun: {
      projectId: input.projectId,
      runId: input.runId,
      localeBranchId: input.localeBranchId,
      leaseOwnerId: `localize:${input.runId}`,
    },
  };
  const before = await input.services.localizationSubstrate.resolvePortSource(
    qualifyingRequest(runMode),
    perRun,
  );
  if (before.runPlane === undefined) throw new Error("Q5 fixture source has no run plane");
  const wiki = new ItotoriLlmWikiRepository(input.context.pool, createFieldMemoCipher(process.env));
  if (!input.sourceInstalled) {
    await Promise.all(
      [
        styleSource(before.runPlane.contextSnapshotId, runMode),
        nameSource(before.runPlane.contextSnapshotId, runMode),
        voiceSource(before.runPlane.contextSnapshotId, runMode),
        arcSource(before.runPlane.contextSnapshotId, runMode),
      ].map(
        async (source) =>
          await persistWikiObject(wiki, source, {
            expectedHead: null,
            createdAt: "2026-08-02T00:00:00.000Z",
          }),
      ),
    );
  }
  const bibleRenderingId = styleRenderingId(before.runPlane.localizationSnapshotId);
  const voiceRenderingId = voiceRenderingIdFor(before.runPlane.localizationSnapshotId);
  await Promise.all(
    [
      styleRendering(before.runPlane.localizationSnapshotId, bibleRenderingId, runMode),
      nameRendering(before.runPlane.localizationSnapshotId, runMode),
      voiceRendering(before.runPlane.localizationSnapshotId, voiceRenderingId, runMode),
      arcRendering(before.runPlane.localizationSnapshotId, runMode),
    ].map(
      async (rendering) =>
        await persistLocalizedRendering(wiki, rendering, {
          expectedHead: null,
          createdAt: "2026-08-02T00:00:00.000Z",
        }),
    ),
  );
  const after = await input.services.localizationSubstrate.resolvePortSource(
    qualifyingRequest(runMode),
    perRun,
  );
  if (after.runPlane === undefined || after.deps === undefined) {
    throw new Error("Q5 fixture could not rebuild the live source after Bible install");
  }
  expect(after.runPlane.contextSnapshotId).toBe(before.runPlane.contextSnapshotId);
  expect(after.runPlane.localizationSnapshotId).toBe(before.runPlane.localizationSnapshotId);
  return {
    deps: after.deps,
    localizationSnapshotId: after.runPlane.localizationSnapshotId,
    bibleRenderingId,
    voiceRenderingId,
    activateProviderBudget: async () => {
      const cohorts = input.services.localizationSubstrate.providerBudgetCohorts;
      if (cohorts === undefined) throw new Error("Q5 fixture has no provider-budget lifecycle");
      await cohorts.activate(
        providerBudgetCohort([{ projectId: input.projectId, runId: input.runId }]),
      );
    },
  };
}
function qualifyingRequest(runMode: RoleBindingRunMode): RunPolicyRequest {
  return {
    runMode,
    contextScope: "whole-game",
    outputScope: "dialogue-only",
    roster: FULL_ROSTER,
    ablation: null,
  };
}
function styleSource(contextSnapshotId: string, runMode: RoleBindingRunMode) {
  return sourceObject({
    contextSnapshotId,
    objectId: STYLE_SOURCE_ID,
    kind: "style-contract",
    subject: { kind: "game", id: "q5-fixture" },
    scope: { kind: "global" },
    runMode,
    body: {
      registerPolicy: "Use a calm, direct register.",
      honorificPolicy: "Retain meaningful honorifics.",
      nameOrder: "source-order",
      profanityCeiling: "mild",
      punctuationRules: ["Use target-language punctuation."],
      audienceNote: "General audience.",
    },
  });
}
function styleRendering(
  localizationSnapshotId: string,
  renderingId: string,
  runMode: RoleBindingRunMode,
) {
  return localizedRendering({
    localizationSnapshotId,
    renderingId,
    sourceObjectId: STYLE_SOURCE_ID,
    sourceObjectKind: "style-contract",
    scope: { kind: "global" },
    runMode,
    body: {
      kind: "style-contract",
      registerGuidance: "Deterministic global style guidance.",
      honorificGuidance: "Retain meaningful honorifics.",
      nameOrder: "source-order",
      profanityCeiling: "mild",
      punctuationRules: ["Use English punctuation."],
    },
  });
}

function nameSource(contextSnapshotId: string, runMode: RoleBindingRunMode) {
  return sourceObject({
    contextSnapshotId,
    objectId: NAME_SOURCE_ID,
    kind: "term-ruling",
    subject: { kind: "character", id: SPEAKER_ID },
    scope: { kind: "global" },
    runMode,
    body: {
      termId: SPEAKER_ID,
      sourceForm: "Fixture",
      meaning: "The revealed speaker name.",
      register: "neutral",
      confidence: "high",
      sourceScope: { kind: "global" },
      aliases: [],
    },
  });
}

function voiceSource(contextSnapshotId: string, runMode: RoleBindingRunMode) {
  return sourceObject({
    contextSnapshotId,
    objectId: VOICE_SOURCE_ID,
    kind: "voice-profile",
    subject: { kind: "character", id: SPEAKER_ID },
    scope: { kind: "global" },
    runMode,
    body: {
      characterId: CHARACTER_ID,
      base: { pronoun: "I", register: "calm and direct", tics: [] },
      perCounterpart: [],
      perArcPosition: [],
    },
  });
}

function arcSource(contextSnapshotId: string, runMode: RoleBindingRunMode) {
  return sourceObject({
    contextSnapshotId,
    objectId: ARC_SOURCE_ID,
    kind: "route-arc",
    subject: { kind: "route", id: ROUTE_ID },
    scope: { kind: "route", routeId: ROUTE_ID },
    runMode,
    body: {
      routeId: ROUTE_ID,
      arcSummary: "A deterministic route for the review proof.",
      callbacks: [],
      foreshadows: [],
      relationshipDeltas: [],
      revealOrder: [],
      unresolvedEdges: [],
      revealHorizon: 0,
    },
  });
}

function sourceObject(input: {
  readonly contextSnapshotId: string;
  readonly objectId: string;
  readonly kind: "style-contract" | "term-ruling" | "voice-profile" | "route-arc";
  readonly subject: unknown;
  readonly scope: unknown;
  readonly body: unknown;
  readonly runMode: RoleBindingRunMode;
}) {
  return WikiObjectSchema.parse({
    schemaVersion: "itotori.wiki-object.v1",
    objectId: input.objectId,
    kind: input.kind,
    version: 1,
    lang: "ja-JP",
    subject: input.subject,
    scope: input.scope,
    body: input.body,
    claims: [],
    media: [],
    dependencies: [],
    provisional: false,
    provenance: {
      snapshotKind: "context",
      contextSnapshotId: input.contextSnapshotId,
      contextScope: "whole-game",
      runMode: input.runMode,
    },
  });
}

function nameRendering(localizationSnapshotId: string, runMode: RoleBindingRunMode) {
  return localizedRendering({
    localizationSnapshotId,
    renderingId: `rendering:name:q5-fixture:${snapshotSuffix(localizationSnapshotId)}`,
    sourceObjectId: NAME_SOURCE_ID,
    sourceObjectKind: "term-ruling",
    scope: { kind: "global" },
    runMode,
    body: {
      kind: "term-ruling",
      termId: SPEAKER_ID,
      canonicalForms: [{ form: "Fixture", status: "preferred", scope: { kind: "global" } }],
      registerGuidance: "Use the revealed name consistently.",
    },
  });
}

function voiceRendering(
  localizationSnapshotId: string,
  renderingId: string,
  runMode: RoleBindingRunMode,
) {
  return localizedRendering({
    localizationSnapshotId,
    renderingId,
    sourceObjectId: VOICE_SOURCE_ID,
    sourceObjectKind: "voice-profile",
    scope: { kind: "global" },
    runMode,
    body: {
      kind: "voice-profile",
      characterId: CHARACTER_ID,
      baseRegisterGuidance: "Keep the fixture speaker calm and direct.",
      counterpartGuidance: [],
      arcGuidance: [],
    },
  });
}

function arcRendering(localizationSnapshotId: string, runMode: RoleBindingRunMode) {
  return localizedRendering({
    localizationSnapshotId,
    renderingId: `rendering:arc:q5-fixture:${snapshotSuffix(localizationSnapshotId)}`,
    sourceObjectId: ARC_SOURCE_ID,
    sourceObjectKind: "route-arc",
    scope: { kind: "route", routeId: ROUTE_ID },
    runMode,
    body: {
      kind: "route-arc",
      sections: [
        {
          sectionId: "fixture-route",
          heading: "Fixture route",
          text: "Keep the fixture route continuous.",
          scope: { kind: "route", routeId: ROUTE_ID },
        },
      ],
    },
  });
}

function localizedRendering(input: {
  readonly localizationSnapshotId: string;
  readonly renderingId: string;
  readonly sourceObjectId: string;
  readonly sourceObjectKind: "style-contract" | "term-ruling" | "voice-profile" | "route-arc";
  readonly scope: unknown;
  readonly body: unknown;
  readonly runMode: RoleBindingRunMode;
}) {
  return LocalizedRenderingSchema.parse({
    schemaVersion: "itotori.localized-rendering.v1",
    renderingId: input.renderingId,
    sourceObjectId: input.sourceObjectId,
    sourceObjectKind: input.sourceObjectKind,
    targetLanguage: "en-US",
    version: 1,
    scope: input.scope,
    body: input.body,
    claimRenderings: [],
    dependencies: [],
    provisional: false,
    provenance: {
      basisSourceVersion: 1,
      localizationSnapshotId: input.localizationSnapshotId,
      runMode: input.runMode,
    },
  });
}

function structureFor(runtimeFixture: RealLiveQ5Fixture | undefined) {
  if (runtimeFixture !== undefined) return runtimeFixture.structure;
  return parseableStructure();
}

function bridgeFor(runtimeFixture: RealLiveQ5Fixture | undefined) {
  if (runtimeFixture !== undefined) return runtimeFixture.bridge;
  return proofBridge();
}

function parseableStructure() {
  const structure = wholeGameStructure();
  return {
    ...structure,
    scenes: structure.scenes.map((scene) => ({
      ...scene,
      units: (scene.units ?? []).map((unit) => ({
        ...unit,
        characterId: CHARACTER_ID,
        routeMembership: [ROUTE_ID],
        sourceAsset: { ...unit.sourceAsset, assetKey: unit.sourceAsset.assetId },
      })),
    })),
  };
}

/** Valid no-control-span fixture keeps the proof focused on P1/Q1–Q6.
 * It still flows through production bridge validation and the DB path. */
function proofBridge() {
  const bridge = loadBridgeBundle();
  return {
    ...bridge,
    policyRecords: [
      ...bridge.policyRecords,
      {
        policyRecordId: "01920000-0000-7000-8000-000000000002",
        policyRecordKind: "non_translated_term",
        policyAction: "do_not_translate",
        termKey: SPEAKER_ID,
        sourceText: "Fixture",
        targetLocale: "en-US",
        policyReason: "Fixture name decision required by the live Bible resolver.",
      },
    ],
    units: bridge.units.map((unit) => ({
      ...unit,
      spans: [],
      speaker: {
        knowledgeState: "known" as const,
        speakerId: SPEAKER_ID,
        displayName: "Fixture",
        canonicalNameRef: CHARACTER_ID,
      },
    })),
  };
}

function styleRenderingId(localizationSnapshotId: string): string {
  return `${STYLE_RENDERING_ID_PREFIX}:${snapshotSuffix(localizationSnapshotId)}`;
}

function voiceRenderingIdFor(localizationSnapshotId: string): string {
  return `rendering:voice:q5-fixture:${snapshotSuffix(localizationSnapshotId)}`;
}

function snapshotSuffix(localizationSnapshotId: string): string {
  return localizationSnapshotId.slice("sha256:".length, 23);
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
