import { ItotoriLlmWikiRepository } from "@itotori/db";
import { expect } from "vitest";
import { createFieldMemoCipher } from "../src/composition/live/index.js";
import {
  LocalizedRenderingSchema,
  WikiObjectSchema,
  type ReviewVerdict,
} from "../src/contracts/index.js";
import { FULL_ROSTER, type RunPolicyRequest } from "../src/run-policy/index.js";
import type { ItotoriApplicationServices } from "../src/services/database-services.js";
import type { LaneVerdict } from "../src/workflow/index.js";
import { persistLocalizedRendering, persistWikiObject } from "../src/wiki/object-persistence.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { loadBridgeBundle, wholeGameStructure } from "./support/gate-fixtures.js";
export const STYLE_SOURCE_ID = "style-contract:role-binding-proof";
const STYLE_RENDERING_ID_PREFIX = "rendering:style-contract:role-binding-proof";
const CHARACTER_ID = "char.rin";
const SPEAKER_ID = "01920000-0000-7000-8000-000000000001";
const ROUTE_ID = "route.proof";
const NAME_SOURCE_ID = "term-ruling:role-binding-proof:name";
const VOICE_SOURCE_ID = "voice-profile:role-binding-proof:rin";
const ARC_SOURCE_ID = "route-arc:role-binding-proof";
export const launchEnvironment = {
  OPENROUTER_API_KEY: "role-binding-proof-key",
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
): readonly string[] {
  return [
    "localize",
    "--run-mode",
    "test-dev",
    "--project-id",
    projectId,
    "--run-id",
    runId,
    "--locale-branch-id",
    localeBranchId,
    "--target-locale",
    "en-US",
    "--source-root",
    "/fixture/role-binding/source",
    "--build-root",
    "/fixture/role-binding/build",
    "--structure",
    "structure.json",
    "--bridge",
    "bridge.json",
    ...(ablation ? ["--ablation"] : []),
    "--output",
    "summary.json",
  ];
}
export function commandDeps(services: ItotoriApplicationServices, outputs: Map<string, unknown>) {
  return {
    io: {
      readJson(path: string): unknown {
        if (path === "structure.json") return parseableStructure();
        if (path === "bridge.json") return proofBridge();
        throw new Error(`unexpected role-binding proof input ${path}`);
      },
      writeJson(path: string, value: unknown): void {
        outputs.set(path, value);
      },
    },
    projectWorkflow: services.projectWorkflow,
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
}) {
  const perRun = {
    structureJson: parseableStructure(),
    bridge: proofBridge(),
    projectRun: {
      projectId: input.projectId,
      runId: input.runId,
      localeBranchId: input.localeBranchId,
      leaseOwnerId: `localize:${input.runId}`,
    },
  };
  const before = await input.services.localizationSubstrate.resolvePortSource(
    qualifyingRequest(),
    perRun,
  );
  if (before.runPlane === undefined) throw new Error("role-binding proof source has no run plane");
  const wiki = new ItotoriLlmWikiRepository(input.context.pool, createFieldMemoCipher(process.env));
  if (!input.sourceInstalled) {
    await Promise.all(
      [
        styleSource(before.runPlane.contextSnapshotId),
        nameSource(before.runPlane.contextSnapshotId),
        voiceSource(before.runPlane.contextSnapshotId),
        arcSource(before.runPlane.contextSnapshotId),
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
      styleRendering(before.runPlane.localizationSnapshotId, bibleRenderingId),
      nameRendering(before.runPlane.localizationSnapshotId),
      voiceRendering(before.runPlane.localizationSnapshotId, voiceRenderingId),
      arcRendering(before.runPlane.localizationSnapshotId),
    ].map(
      async (rendering) =>
        await persistLocalizedRendering(wiki, rendering, {
          expectedHead: null,
          createdAt: "2026-08-02T00:00:00.000Z",
        }),
    ),
  );
  const after = await input.services.localizationSubstrate.resolvePortSource(
    qualifyingRequest(),
    perRun,
  );
  if (after.runPlane === undefined || after.deps === undefined) {
    throw new Error("role-binding proof could not rebuild the live source after Bible install");
  }
  expect(after.runPlane.contextSnapshotId).toBe(before.runPlane.contextSnapshotId);
  expect(after.runPlane.localizationSnapshotId).toBe(before.runPlane.localizationSnapshotId);
  return {
    deps: after.deps,
    localizationSnapshotId: after.runPlane.localizationSnapshotId,
    bibleRenderingId,
    voiceRenderingId,
  };
}
export function contestedVerdicts(
  unitId: string,
  localizationSnapshotId: string,
  bibleRenderingId: string,
  repairConstraint = "Preserve the grounded sense.",
): readonly LaneVerdict[] {
  const pass = reviewVerdict({
    roleId: "Q1",
    rubric: "meaning",
    unitId,
    localizationSnapshotId,
    evidenceId: bibleRenderingId,
    bibleRenderingId,
    verdict: "PASS",
  });
  const fail = reviewVerdict({
    roleId: "Q3",
    rubric: "terminology",
    unitId,
    localizationSnapshotId,
    evidenceId: unitId,
    bibleRenderingId,
    verdict: "FAIL",
    repairConstraint,
  });
  return [
    { lane: "Q1", verdict: pass },
    { lane: "Q3", verdict: fail },
  ];
}
function qualifyingRequest(): RunPolicyRequest {
  return {
    runMode: "test-dev",
    contextScope: "whole-game",
    outputScope: "dialogue-only",
    roster: FULL_ROSTER,
    ablation: null,
  };
}
function styleSource(contextSnapshotId: string) {
  return sourceObject({
    contextSnapshotId,
    objectId: STYLE_SOURCE_ID,
    kind: "style-contract",
    subject: { kind: "game", id: "role-binding-proof" },
    scope: { kind: "global" },
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
function styleRendering(localizationSnapshotId: string, renderingId: string) {
  return localizedRendering({
    localizationSnapshotId,
    renderingId,
    sourceObjectId: STYLE_SOURCE_ID,
    sourceObjectKind: "style-contract",
    scope: { kind: "global" },
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

function nameSource(contextSnapshotId: string) {
  return sourceObject({
    contextSnapshotId,
    objectId: NAME_SOURCE_ID,
    kind: "term-ruling",
    subject: { kind: "character", id: SPEAKER_ID },
    scope: { kind: "global" },
    body: {
      termId: SPEAKER_ID,
      sourceForm: "Rin",
      meaning: "The revealed speaker name.",
      register: "neutral",
      confidence: "high",
      sourceScope: { kind: "global" },
      aliases: [],
    },
  });
}

function voiceSource(contextSnapshotId: string) {
  return sourceObject({
    contextSnapshotId,
    objectId: VOICE_SOURCE_ID,
    kind: "voice-profile",
    subject: { kind: "character", id: SPEAKER_ID },
    scope: { kind: "global" },
    body: {
      characterId: CHARACTER_ID,
      base: { pronoun: "I", register: "calm and direct", tics: [] },
      perCounterpart: [],
      perArcPosition: [],
    },
  });
}

function arcSource(contextSnapshotId: string) {
  return sourceObject({
    contextSnapshotId,
    objectId: ARC_SOURCE_ID,
    kind: "route-arc",
    subject: { kind: "route", id: ROUTE_ID },
    scope: { kind: "route", routeId: ROUTE_ID },
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
      runMode: "test-dev",
    },
  });
}

function nameRendering(localizationSnapshotId: string) {
  return localizedRendering({
    localizationSnapshotId,
    renderingId: `rendering:name:role-binding-proof:${snapshotSuffix(localizationSnapshotId)}`,
    sourceObjectId: NAME_SOURCE_ID,
    sourceObjectKind: "term-ruling",
    scope: { kind: "global" },
    body: {
      kind: "term-ruling",
      termId: SPEAKER_ID,
      canonicalForms: [{ form: "Rin", status: "preferred", scope: { kind: "global" } }],
      registerGuidance: "Use the revealed name consistently.",
    },
  });
}

function voiceRendering(localizationSnapshotId: string, renderingId: string) {
  return localizedRendering({
    localizationSnapshotId,
    renderingId,
    sourceObjectId: VOICE_SOURCE_ID,
    sourceObjectKind: "voice-profile",
    scope: { kind: "global" },
    body: {
      kind: "voice-profile",
      characterId: CHARACTER_ID,
      baseRegisterGuidance: "Keep Rin calm and direct.",
      counterpartGuidance: [],
      arcGuidance: [],
    },
  });
}

function arcRendering(localizationSnapshotId: string) {
  return localizedRendering({
    localizationSnapshotId,
    renderingId: `rendering:arc:role-binding-proof:${snapshotSuffix(localizationSnapshotId)}`,
    sourceObjectId: ARC_SOURCE_ID,
    sourceObjectKind: "route-arc",
    scope: { kind: "route", routeId: ROUTE_ID },
    body: {
      kind: "route-arc",
      sections: [
        {
          sectionId: "route-proof",
          heading: "Proof route",
          text: "Keep the proof route continuous.",
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
      runMode: "test-dev",
    },
  });
}

function reviewVerdict(input: {
  readonly roleId: "Q1" | "Q3";
  readonly rubric: "meaning" | "terminology";
  readonly unitId: string;
  readonly localizationSnapshotId: string;
  readonly evidenceId: string;
  readonly bibleRenderingId: string;
  readonly verdict: "PASS" | "FAIL";
  readonly repairConstraint?: string;
}): ReviewVerdict {
  const base = {
    schemaVersion: "itotori.review-verdict.v1" as const,
    reviewId: `review:${input.roleId}:${input.unitId}`,
    localizationSnapshotId: input.localizationSnapshotId,
    roleId: input.roleId,
    rubric: input.rubric,
    unitId: input.unitId,
    basis: { kind: "wiki-first" as const, bibleRenderingIds: [input.bibleRenderingId] },
    evidenceIds: [input.evidenceId],
  };
  if (input.verdict === "PASS") {
    return {
      ...base,
      verdict: "PASS",
      severity: "none",
      span: null,
      category: null,
      repairConstraint: null,
    };
  }
  return {
    ...base,
    verdict: "FAIL",
    severity: "major",
    span: { spanId: "span:role-binding-proof", surface: "source", text: "proof source" },
    category: "term-sense",
    repairConstraint: input.repairConstraint ?? "Preserve the grounded sense.",
  };
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
        sourceText: "Rin",
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
        displayName: "Rin",
        canonicalNameRef: CHARACTER_ID,
      },
    })),
  };
}

function styleRenderingId(localizationSnapshotId: string): string {
  return `${STYLE_RENDERING_ID_PREFIX}:${snapshotSuffix(localizationSnapshotId)}`;
}

function voiceRenderingIdFor(localizationSnapshotId: string): string {
  return `rendering:voice:role-binding-proof:${snapshotSuffix(localizationSnapshotId)}`;
}

function snapshotSuffix(localizationSnapshotId: string): string {
  return localizationSnapshotId.slice("sha256:".length, 23);
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
