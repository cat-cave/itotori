// p0-core-iterative-patch-versioning-and-playtest-feedback — live feedback
// variants proof.  Each case starts from an independently seeded v1, drives
// the shipping HTTP/API + DB-services composition, and only stubs the external
// OpenRouter transport beneath the real registered context-correction runner.
//
// In particular, this is intentionally not a mock WikiBrain/iteration-port
// test and never supplies `targetBodiesByUnit`: COMMENT, ADDED_CONTEXT, and
// WIKI_EDIT must each cause the default production worker to persist a changed
// branch draft before a real-byte v2 refinement can complete.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asNonBlankTargetText,
  type BridgeBundleV02,
  type LocalizationUnitV02,
  type WrittenUnitOutcome,
} from "@itotori/localization-bridge-schema";
import {
  bootstrapLocalUser,
  hashLocalizationArtifact,
  ItotoriContextArtifactRepository,
  ItotoriEventQueueRepository,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationPassRunConfigRepository,
  ItotoriLocalizationRunFinalizerRepository,
  ItotoriProjectRepository,
  localUserId,
  type AuthorizationActor,
  type LocalizationJournalRunLeaseIdentity,
} from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import type {
  ApiPatchIterationFeedbackBatchResponse,
  ApiPatchIterationFeedbackResponse,
  ApiPatchIterationRefineResponse,
  ApiPatchIterationSurfaceResponse,
} from "../src/api-schema.js";
import { applyKaifuuRpgMakerPatch } from "../src/orchestrator/patch-apply-seam.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import { assertHttpContractOk, startPostgresHttpContractHarness } from "./http-contract-harness.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const targetLocale = "en-US";
const driverLease: LocalizationJournalRunLeaseIdentity = {
  ownerId: "patch-iteration-feedback-variants-live-driver",
  fenceToken: 1,
};
const rpgMakerAssetId = "019ed0cb-1000-7000-8000-00000000fc14";
const rpgMakerUnitId = "019ed0cb-1000-7000-8000-00000000fc21";
const rpgMakerSourceRevisionId = "019ed0cb-1000-7000-8000-00000000fc13";
const rpgMakerSourceRevisionHash = `sha256:${"c".repeat(64)}`;
const rpgMakerSourceProfileRevisionHash = `sha256:${"d".repeat(64)}`;
const rpgMakerMapAssetKey = "rpgmaker:Map001.json";

const feedbackVariants = [
  {
    eventKind: "comment",
    label: "COMMENT",
    feedbackBody: "COMMENT-LIVE-REDRAFT: retain the play-tested navy form of address.",
    expectedTarget: "Comment feedback redrafted this real v2 line.",
  },
  {
    eventKind: "added_context",
    label: "ADDED_CONTEXT",
    feedbackBody: "ADDED-CONTEXT-LIVE-REDRAFT: the captain speaks with formal naval delivery.",
    expectedTarget: "Added context redrafted this real v2 line.",
  },
  {
    eventKind: "wiki_edit",
    label: "WIKI_EDIT",
    feedbackBody: "WIKI-EDIT-LIVE-REDRAFT: the established title is Captain Wato.",
    expectedTarget: "Wiki edit redrafted this real v2 line.",
  },
] as const;

type FeedbackVariant = (typeof feedbackVariants)[number];

type ProductionFixture = {
  root: string;
  sourceRoot: string;
  bridgePath: string;
  bridge: BridgeBundleV02;
  parentPatchTarget: string;
  bridgeUnitId: string;
  initialTarget: string;
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup(): void;
};

type VariantScope = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
};

type ContextCorrectionReceipt = {
  correctionId?: unknown;
  redraftJobId?: unknown;
  contextArtifactId?: unknown;
  contextEntryVersionId?: unknown;
  rerun?: unknown;
};

describe.skipIf(!process.env.DATABASE_URL)(
  "PatchIterationService feedback variants — production Postgres redrafts",
  () => {
    it.each(feedbackVariants)(
      "$label feedback turns an independent v1 into a real durable v2 without an explicit target",
      async (variant) => {
        const context = await isolatedMigratedContext();
        const fixture = createProductionFixture(variant);
        try {
          await bootstrapLocalUser(context.db);
          const scope = scopeFor(variant, fixture.bridge.sourceBundleRevision.revisionId);
          const projectRepository = new ItotoriProjectRepository(context.db);
          await projectRepository.importSourceBundle(actor, {
            projectId: scope.projectId,
            localeBranchId: scope.localeBranchId,
            targetLocale,
            bridge: fixture.bridge,
            // The worker verifier must observe an actual before value and then
            // prove its own production rerun changed it.
            drafts: { [fixture.bridgeUnitId]: fixture.initialTarget },
          });
          await registerProductionRedraftConfig({
            context,
            fixture,
            scope,
          });

          const preexistingWikiArtifactId =
            variant.eventKind === "wiki_edit"
              ? await seedExistingCanonicalWikiEntry({ context, fixture, scope })
              : undefined;
          const v1 = await seedPlayableProductionRun({ context, fixture, scope });

          const transport = await withProductionOpenRouterTransport(async (captured) => {
            const dashboard = await startPostgresHttpContractHarness({
              databaseUrl: context.databaseUrl,
            });
            try {
              const batchResponse = await dashboard.httpRequest("patchIteration.feedbackBatch", {
                params: { patchVersionId: v1.patchVersionId },
                body: { label: `${variant.label} must reach v2 through the production redrafter` },
              });
              assertHttpContractOk("patchIteration.feedbackBatch", batchResponse);
              const batch = (batchResponse.body as ApiPatchIterationFeedbackBatchResponse).batch;

              const feedbackResponse = await dashboard.httpRequest("patchIteration.feedback", {
                params: { patchVersionId: v1.patchVersionId },
                body: feedbackRequest({
                  variant,
                  feedbackBatchId: batch.feedbackBatchId,
                  bridgeUnitId: fixture.bridgeUnitId,
                  preexistingWikiArtifactId,
                }),
              });
              assertHttpContractOk("patchIteration.feedback", feedbackResponse);
              const feedback = (feedbackResponse.body as ApiPatchIterationFeedbackResponse)
                .feedback;
              expect(feedback).toMatchObject({
                observedPatchVersionId: v1.patchVersionId,
                playSessionId: null,
                eventKind: variant.eventKind,
                affectedBridgeUnitIds: [fixture.bridgeUnitId],
                contextArtifactId: expect.any(String),
                contextEntryVersionId: expect.any(String),
              });
              if (feedback.contextArtifactId === null || feedback.contextEntryVersionId === null) {
                throw new Error(
                  `${variant.label} feedback did not persist a canonical context receipt`,
                );
              }
              const receipt = feedback.metadata.contextCorrection as
                | ContextCorrectionReceipt
                | undefined;
              expect(receipt).toMatchObject({
                contextArtifactId: feedback.contextArtifactId,
                contextEntryVersionId: feedback.contextEntryVersionId,
                redraftJobId: expect.any(String),
                rerun: { state: "succeeded", jobStatus: "succeeded", error: null },
              });
              const redraftJobId = requiredString(
                receipt?.redraftJobId,
                "contextCorrection.redraftJobId",
              );

              // This observes the persisted output of the DEFAULT DB-services
              // correction worker. No test runner, target override, or mock
              // Wiki/iteration port supplies the text that v2 will use.
              const workerProof = await assertDurableProductionRedraft({
                context,
                fixture,
                scope,
                feedbackContextArtifactId: feedback.contextArtifactId,
                feedbackContextEntryVersionId: feedback.contextEntryVersionId,
                redraftJobId,
                expectedTarget: variant.expectedTarget,
              });
              expect(workerProof.journalRunId).toEqual(expect.any(String));

              const parentSurfaceResponse = await dashboard.httpRequest("patchIteration.surface", {
                params: { patchVersionId: v1.patchVersionId },
              });
              assertHttpContractOk("patchIteration.surface", parentSurfaceResponse);
              const parentSurface = parentSurfaceResponse.body as ApiPatchIterationSurfaceResponse;
              expect(parentSurface.feedback.batches).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    feedbackBatchId: batch.feedbackBatchId,
                    events: [
                      expect.objectContaining({ feedbackEventId: feedback.feedbackEventId }),
                    ],
                  }),
                ]),
              );

              // Deliberately send ONLY selection identity. In particular,
              // targetBodiesByUnit must remain absent: the changed v2 text can
              // only come from the durable production redraft above.
              const refineResponse = await dashboard.httpRequest("patchIteration.refine", {
                params: { patchVersionId: v1.patchVersionId },
                body: { feedbackBatchIds: [batch.feedbackBatchId] },
              });
              assertHttpContractOk("patchIteration.refine", refineResponse);
              const v2 = refineResponse.body as ApiPatchIterationRefineResponse;
              expect(v2.refinement).toMatchObject({
                basePatchVersionId: v1.patchVersionId,
                feedbackBatchIds: [batch.feedbackBatchId],
                wikiHeads: [
                  {
                    contextArtifactId: feedback.contextArtifactId,
                    contextEntryVersionId: feedback.contextEntryVersionId,
                  },
                ],
                members: [
                  expect.objectContaining({
                    bridgeUnitId: fixture.bridgeUnitId,
                    strategy: "redraft",
                  }),
                ],
              });
              expect(v2.patch).toMatchObject({
                parentPatchVersionId: v1.patchVersionId,
                origin: "refinement_run",
                status: "playable",
                units: [
                  expect.objectContaining({
                    bridgeUnitId: fixture.bridgeUnitId,
                    sourceRunId: v2.refinement.runId,
                    targetBody: variant.expectedTarget,
                    memberOrigin: "run_written_outcome",
                  }),
                ],
              });
              expect(v2.patch.patchVersionId).not.toBe(v1.patchVersionId);

              const v2SurfaceResponse = await dashboard.httpRequest("patchIteration.surface", {
                params: { patchVersionId: v2.patch.patchVersionId },
              });
              assertHttpContractOk("patchIteration.surface", v2SurfaceResponse);
              expect(
                (v2SurfaceResponse.body as ApiPatchIterationSurfaceResponse).patch.units,
              ).toEqual([
                expect.objectContaining({
                  bridgeUnitId: fixture.bridgeUnitId,
                  targetBody: variant.expectedTarget,
                }),
              ]);

              // The refinement materializer itself must have applied the
              // redraft into actual RPG Maker data, rather than merely
              // projecting a changed DB result row.
              const patchTarget = await patchTargetFor(context, v2.patch.patchVersionId);
              expect(rpgMakerPatchedText(patchTarget)).toBe(variant.expectedTarget);
              return captured;
            } finally {
              await dashboard.close();
            }
          });
          expect(
            transport.messageTexts.some((message) => message.includes(variant.feedbackBody)),
          ).toBe(true);
        } finally {
          try {
            await context.close();
          } finally {
            fixture.cleanup();
          }
        }
      },
      180_000,
    );
  },
);

function scopeFor(variant: FeedbackVariant, sourceRevisionId: string): VariantScope {
  const suffix = variant.eventKind.replace(/_/gu, "-");
  return {
    projectId: `project-patch-iteration-feedback-${suffix}`,
    localeBranchId: `branch-patch-iteration-feedback-${suffix}`,
    sourceRevisionId,
  };
}

function feedbackRequest(input: {
  variant: FeedbackVariant;
  feedbackBatchId: string;
  bridgeUnitId: string;
  preexistingWikiArtifactId: string | undefined;
}): Record<string, unknown> {
  const common = {
    eventKind: input.variant.eventKind,
    feedbackBatchId: input.feedbackBatchId,
  };
  switch (input.variant.eventKind) {
    case "comment":
      // This is the normal comment surface. The service must turn it into the
      // canonical Node 9/8 note receipt itself; callers cannot pre-bake a
      // target or a context head here.
      return {
        ...common,
        body: input.variant.feedbackBody,
        affectedBridgeUnitIds: [input.bridgeUnitId],
      };
    case "added_context":
      return {
        ...common,
        body: "The tester attached canonical delivery context.",
        contextFeedback: {
          operation: "add",
          kind: "note",
          title: "Live added context from the patch play test",
          body: input.variant.feedbackBody,
          reason: "Observed in the independently seeded v1 runtime play session.",
          affectedBridgeUnitIds: [input.bridgeUnitId],
        },
      };
    case "wiki_edit": {
      const contextArtifactId = input.preexistingWikiArtifactId;
      if (contextArtifactId === undefined) {
        throw new Error("WIKI_EDIT live proof needs its pre-existing canonical entry");
      }
      return {
        ...common,
        body: "The tester corrected the canonical wiki entry.",
        contextFeedback: {
          operation: "edit",
          contextArtifactId,
          body: input.variant.feedbackBody,
          reason: "Observed in the independently seeded v1 runtime play session.",
        },
      };
    }
  }
}

async function registerProductionRedraftConfig(input: {
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>;
  fixture: ProductionFixture;
  scope: VariantScope;
}): Promise<void> {
  const pairPolicyPath = join(input.fixture.root, "pair-policy.json");
  writeFileSync(
    pairPolicyPath,
    readFileSync(
      new URL("./fixtures/agentic-loop-smoke-pair-policy.json", import.meta.url),
      "utf8",
    ),
  );
  const configPath = join(input.fixture.root, "registered-localize.config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: "itotori.localize-fullproject.config.v0",
        projectId: input.scope.projectId,
        localeBranchId: input.scope.localeBranchId,
        sourceRevisionId: input.scope.sourceRevisionId,
        engineProfile: "rpg-maker-mv-mz",
        targetLocale,
        bridgePath: input.fixture.bridgePath,
        pairPolicyPath,
        translationScope: "all",
        concurrency: 1,
        maxRepairAttempts: 0,
      },
      null,
      2,
    )}\n`,
  );
  await new ItotoriLocalizationPassRunConfigRepository(input.context.db).saveRunConfig(actor, {
    projectId: input.scope.projectId,
    localeBranchId: input.scope.localeBranchId,
    configPath,
    dataRoot: input.fixture.sourceRoot,
    pairPolicyPath,
    modelId: DEV_PAIR.modelId,
    providerId: DEV_PAIR.providerId,
    runDir: join(input.fixture.root, "registered-live-pass"),
  });
}

async function seedExistingCanonicalWikiEntry(input: {
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>;
  fixture: ProductionFixture;
  scope: VariantScope;
}): Promise<string> {
  const entry = await new ItotoriContextArtifactRepository(input.context.db).upsertArtifact(actor, {
    projectId: input.scope.projectId,
    localeBranchId: input.scope.localeBranchId,
    sourceRevisionId: input.scope.sourceRevisionId,
    category: "glossary",
    title: "Captain Wato",
    body: "The initial wiki entry uses an older title before the v1 play test.",
    producedByAgent: "live-feedback-variant-fixture",
    producedByTool: "tool.context-artifacts",
    producerVersion: "1.0.0",
    sourceUnits: [
      {
        bridgeUnitId: input.fixture.bridgeUnitId,
        citation: `live-feedback-variant:${input.fixture.bridgeUnitId}`,
      },
    ],
  });
  if (entry.headVersionId === null) {
    throw new Error("pre-existing wiki entry did not select a canonical head");
  }
  return entry.contextArtifactId;
}

async function seedPlayableProductionRun(input: {
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>;
  fixture: ProductionFixture;
  scope: VariantScope;
}): Promise<{ patchVersionId: string }> {
  const runId = `${input.scope.projectId}:v1`;
  const journal = new ItotoriLocalizationJournalRepository(input.context.db);
  const finalizer = new ItotoriLocalizationRunFinalizerRepository(input.context.db);
  await journal.seedRun(actor, {
    runId,
    projectId: input.scope.projectId,
    localeBranchId: input.scope.localeBranchId,
    sourceRevisionId: input.scope.sourceRevisionId,
    targetLocale,
    frozenScope: { kind: "explicit_units", unitIds: [input.fixture.bridgeUnitId] },
    routingPolicy: { routes: ["model-feedback-variants/provider-feedback-variants"] },
    // itotori-225-audit-allow: deterministic fixture ceiling for initial v1 seed.
    costPolicy: { kind: "patch-iteration-feedback-variants-live", capUsd: "1.00" },
    units: [
      {
        bridgeUnitId: input.fixture.bridgeUnitId,
        sourceUnitKey:
          input.fixture.bridge.units.find(
            (unit) => unit.bridgeUnitId === input.fixture.bridgeUnitId,
          )?.sourceUnitKey ?? `feedback-variants:${input.fixture.bridgeUnitId}`,
        nextAction: { kind: "drive_unit", stage: "translation" },
      },
    ],
    lease: { ownerId: driverLease.ownerId },
    createdAt: "2026-07-13T01:00:00.000Z",
  });
  await writeSeedUnit({
    journal,
    runId,
    bridgeUnitId: input.fixture.bridgeUnitId,
    sourceUnitKey:
      input.fixture.bridge.units.find((unit) => unit.bridgeUnitId === input.fixture.bridgeUnitId)
        ?.sourceUnitKey ?? `feedback-variants:${input.fixture.bridgeUnitId}`,
    targetBody: input.fixture.initialTarget,
  });
  const patch = await finalizer.ensurePatchVersion(actor, {
    runId,
    artifactHashes: input.fixture.artifactHashes,
    artifactRefs: input.fixture.artifactRefs,
  });
  for (const stage of ["patch_build", "patch_apply", "validation"] as const) {
    await finalizer.upsertPatchStageEvidence(actor, {
      runId,
      stage,
      status: "succeeded",
      evidence: { fixture: "patch-iteration-feedback-variants-real-kaifuu" },
    });
  }
  await finalizer.enterFinalizing(actor, { runId, lease: driverLease });
  await finalizer.completeSucceededRun(actor, { runId, patchVersionId: patch.patchVersionId });
  return { patchVersionId: patch.patchVersionId };
}

async function writeSeedUnit(input: {
  journal: ItotoriLocalizationJournalRepository;
  runId: string;
  bridgeUnitId: string;
  sourceUnitKey: string;
  targetBody: string;
}): Promise<void> {
  const attemptId = `patch-iteration-feedback-variant-attempt:${input.runId}:${input.bridgeUnitId}`;
  await input.journal.beginAttempt(actor, {
    attemptId,
    runId: input.runId,
    bridgeUnitId: input.bridgeUnitId,
    stage: "translation",
    agentLabel: "patch-iteration-feedback-variant-seed",
    logicalCallId: `patch-iteration-feedback-variant:${input.runId}:${input.bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "model-feedback-variants",
    requestedProviderId: "provider-feedback-variants",
    zdr: true,
    artifactRef: `provider-run:${attemptId}`,
    startedAt: "2026-07-13T01:00:01.000Z",
    lease: driverLease,
  });
  await input.journal.completeAttempt(actor, {
    attemptId,
    runId: input.runId,
    bridgeUnitId: input.bridgeUnitId,
    modelId: "model-feedback-variants",
    providerId: "provider-feedback-variants",
    costUsd: "0",
    costKind: "zero",
    tokensIn: 1,
    tokensOut: 1,
    tokenCountSource: "fixture",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheDiscountMicrosUsd: 0,
    fallbackUsed: false,
    fallbackPlan: [],
    zdr: true,
    finishState: "stop",
    refusalState: null,
    validationResult: "accepted",
    failureClass: null,
    retryDecision: "write",
    retryDelayMs: null,
    artifactRef: `provider-run:${attemptId}`,
    errorClasses: [],
    completedAt: "2026-07-13T01:00:02.000Z",
    lease: driverLease,
  });
  const outcomeId = `patch-iteration-feedback-variant-outcome:${input.runId}:${input.bridgeUnitId}`;
  const candidateId = `patch-iteration-feedback-variant-candidate:${input.runId}:${input.bridgeUnitId}`;
  const outcome: WrittenUnitOutcome = {
    id: outcomeId,
    status: "written",
    unitId: input.bridgeUnitId,
    targetLocale,
    selectedCandidateId: candidateId,
    candidates: [
      {
        id: candidateId,
        outcomeId,
        body: asNonBlankTargetText(input.targetBody),
        producedBy: {
          modelId: "model-feedback-variants",
          providerId: "provider-feedback-variants",
        },
        attemptId,
        kind: "primary",
      },
    ],
    findings: [],
    qualityFlags: [],
    provenance: { origin: "patch-iteration-feedback-variants-live" },
    writtenAt: "2026-07-13T01:00:03.000Z",
  };
  await input.journal.persistUnit(actor, {
    runId: input.runId,
    bridgeUnitId: input.bridgeUnitId,
    sourceUnitKey: input.sourceUnitKey,
    outcome,
    attempts: [],
    contextPacket: { fixture: "patch-iteration-feedback-variants-live" },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: {},
    lease: driverLease,
  });
}

function createProductionFixture(variant: FeedbackVariant): ProductionFixture {
  const root = mkdtempSync(join(tmpdir(), `itotori-patch-feedback-${variant.eventKind}-`));
  const sourceRoot = join(root, "source-www");
  materializeRpgMakerSource(sourceRoot);
  const bridge = makeRpgMakerBridge();
  const bridgePath = join(root, "extracted-bridge.json");
  writeFileSync(bridgePath, `${JSON.stringify(bridge, null, 2)}\n`);
  const initialTarget = `Independent ${variant.eventKind} v1 target`;
  const translatedBridge = JSON.parse(JSON.stringify(bridge)) as {
    units: Array<{
      bridgeUnitId: string;
      sourceText: string;
      target?: { locale: string; text: string };
    }>;
  };
  for (const unit of translatedBridge.units) {
    unit.target = {
      locale: targetLocale,
      text: unit.bridgeUnitId === rpgMakerUnitId ? initialTarget : unit.sourceText,
    };
  }
  const translatedBridgePath = join(root, "v1-translated-bridge.json");
  writeFileSync(translatedBridgePath, `${JSON.stringify(translatedBridge, null, 2)}\n`, "utf8");
  const parentPatchTarget = join(root, "v1-patch-target");
  const rpgMakerDelta = join(root, "v1-rpgmaker-delta.kaifuu");
  const apply = applyKaifuuRpgMakerPatch({
    sourceRoot,
    patchedDataOutputPath: parentPatchTarget,
    deltaOutputPath: rpgMakerDelta,
    translatedBundlePath: translatedBridgePath,
  });
  const patchApply = join(root, "v1-patch-apply.json");
  writeFileSync(patchApply, `${JSON.stringify(apply, null, 2)}\n`, "utf8");
  const artifactRefs = {
    translatedBridge: translatedBridgePath,
    patchApply,
    patchTarget: parentPatchTarget,
    rpgMakerDelta,
  };
  return {
    root,
    sourceRoot,
    bridgePath,
    bridge,
    parentPatchTarget,
    bridgeUnitId: rpgMakerUnitId,
    initialTarget,
    artifactRefs,
    artifactHashes: Object.fromEntries(
      Object.entries(artifactRefs).map(([key, path]) => [key, hashLocalizationArtifact(path)]),
    ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function revision(revisionId: string, value: string) {
  return { revisionId, revisionKind: "content_hash" as const, value };
}

function makeRpgMakerBridge(): BridgeBundleV02 {
  const sourceBundleRevision = revision(rpgMakerSourceRevisionId, rpgMakerSourceRevisionHash);
  const sourceUnitKey = `${rpgMakerMapAssetKey}#/events/1/pages/0/list/0/parameters/0`;
  const unit: LocalizationUnitV02 = {
    bridgeUnitId: rpgMakerUnitId,
    surfaceId: rpgMakerAssetId,
    surfaceKind: "dialogue",
    sourceUnitKey,
    occurrenceId: "feedback-variant-occurrence-1",
    sourceLocale: "ja-JP",
    sourceText: "おはよう。",
    sourceHash: "sha256:0aec2f529887f276a2f89a9ca914df3d1b8e246bc408d4d55244de383a4dfca1",
    sourceRevision: sourceBundleRevision,
    sourceAssetRef: { assetId: rpgMakerAssetId, assetKey: rpgMakerMapAssetKey },
    sourceLocation: {
      containerKey: rpgMakerMapAssetKey,
      entryPath: ["events", "1", "pages", "0", "list", "0", "parameters", "0"],
    },
    speaker: {
      knowledgeState: "known",
      speakerId: "019ed0cb-1000-7000-8000-00000000fc15",
      displayName: "和人",
    },
    context: { route: { sceneKey: "1" } },
    spans: [],
    patchRef: {
      assetId: rpgMakerAssetId,
      writeMode: "replace",
      sourceUnitKey,
      sourceRevision: sourceBundleRevision,
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
  return {
    schemaVersion: "0.2.0",
    bridgeId: "019ed0cb-1000-7000-8000-00000000fc20",
    sourceGame: {
      gameId: "feedback-variants-rpgmaker-fixture",
      gameVersion: "1",
      sourceProfileId: "feedback-variants-profile",
      sourceProfileRevision: revision(
        "019ed0cb-1000-7000-8000-00000000fc16",
        rpgMakerSourceProfileRevisionHash,
      ),
    },
    sourceBundleHash: rpgMakerSourceRevisionHash,
    sourceBundleRevision,
    sourceLocale: "ja-JP",
    hashStrategy: {
      sourceProfile: {
        scope: "source_profile",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      sourceBundle: {
        scope: "source_bundle",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      sourceAsset: { scope: "source_asset", algorithm: "sha256", normalization: "bytes" },
      sourceUnit: {
        scope: "source_unit",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
        fields: ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
      },
      patchExport: {
        scope: "patch_export",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      deltaPackage: {
        scope: "delta_package",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
    },
    extractor: { name: "feedback-variants-rpgmaker-fixture", version: "1" },
    assets: [
      {
        assetId: rpgMakerAssetId,
        assetKey: rpgMakerMapAssetKey,
        assetKind: "text",
        sourceHash: rpgMakerSourceRevisionHash,
        sourceRevision: sourceBundleRevision,
      },
    ],
    units: [unit],
    policyRecords: [],
  };
}

function materializeRpgMakerSource(root: string): void {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "Map001.json"),
    `${JSON.stringify({
      events: [
        null,
        {
          id: 1,
          pages: [
            {
              list: [{ code: 401, indent: 0, parameters: ["おはよう。"] }],
            },
          ],
        },
      ],
    })}\n`,
  );
}

async function assertDurableProductionRedraft(input: {
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>;
  fixture: ProductionFixture;
  scope: VariantScope;
  feedbackContextArtifactId: string;
  feedbackContextEntryVersionId: string;
  redraftJobId: string;
  expectedTarget: string;
}): Promise<{ journalRunId: string }> {
  const queue = new ItotoriEventQueueRepository(input.context.db);
  const job = await queue.getJob(actor, input.redraftJobId);
  expect(job).toMatchObject({ status: "succeeded" });
  const journalRunId = requiredString(job?.result?.["journalRunId"], "redraft job journalRunId");
  const changedDraftCount = job?.result?.["changedDraftCount"];
  expect(changedDraftCount).toBeTypeOf("number");
  expect(changedDraftCount).toBeGreaterThan(0);

  const journal = new ItotoriLocalizationJournalRepository(input.context.db);
  const outcomes = await journal.loadRunOutcomes(actor, journalRunId);
  const outcome = outcomes.find(
    (candidate) => candidate.bridgeUnitId === input.fixture.bridgeUnitId,
  );
  if (outcome === undefined) {
    throw new Error(
      `production redraft ${journalRunId} did not journal the selected feedback unit`,
    );
  }
  expect(
    outcome.outcome.candidates.find(
      (candidate) => candidate.id === outcome.outcome.selectedCandidateId,
    )?.body,
  ).toBe(input.expectedTarget);
  expect(outcome.contextPacket).toMatchObject({
    unitContextPacket: {
      resolvedFromVersions: {
        [input.feedbackContextArtifactId]: input.feedbackContextEntryVersionId,
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          contextArtifactId: input.feedbackContextArtifactId,
          contextEntryVersionId: input.feedbackContextEntryVersionId,
        }),
      ]),
    },
  });
  const drafts = await new ItotoriProjectRepository(input.context.db).loadLocaleBranchDraftTexts(
    actor,
    {
      projectId: input.scope.projectId,
      localeBranchId: input.scope.localeBranchId,
      bridgeUnitIds: [input.fixture.bridgeUnitId],
    },
  );
  expect(drafts.get(input.fixture.bridgeUnitId)).toBe(input.expectedTarget);
  return { journalRunId };
}

async function patchTargetFor(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  patchVersionId: string,
): Promise<string> {
  const result = await context.pool.query<{ patch_target: string | null }>(
    `
      select artifact_refs ->> 'patchTarget' as patch_target
      from itotori_localization_patch_versions
      where patch_version_id = $1
    `,
    [patchVersionId],
  );
  return requiredString(result.rows[0]?.patch_target, "refinement patchTarget artifact ref");
}

function rpgMakerPatchedText(patchTarget: string): string {
  const map = JSON.parse(readFileSync(join(patchTarget, "Map001.json"), "utf8")) as {
    events?: Array<{
      pages?: Array<{
        list?: Array<{
          parameters?: unknown[];
        }>;
      }>;
    } | null>;
  };
  const text = map.events?.[1]?.pages?.[0]?.list?.[0]?.parameters?.[0];
  if (typeof text !== "string") {
    throw new Error("refinement patch did not write the expected RPG Maker dialogue text");
  }
  return text;
}

type ProductionOpenRouterTransport = { messageTexts: string[] };

// Keep the DB-services factory, WikiBrain, ContextCorrectionRerunWorker,
// DbBackedContextCorrectionRedrafter, and the full localize runner real. The
// only deterministic seam sits below that production stack at its external
// OpenRouter HTTP request.
async function withProductionOpenRouterTransport<T>(
  callback: (transport: ProductionOpenRouterTransport) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  const originalZdrAssertion = process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED;
  const transport: ProductionOpenRouterTransport = { messageTexts: [] };
  process.env.OPENROUTER_API_KEY = "test-feedback-variants-production-transport";
  process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED = "1";
  vi.stubGlobal("fetch", (async (request, init) => {
    if (fetchInputUrl(request) !== "https://openrouter.ai/api/v1/chat/completions") {
      return await originalFetch(request, init);
    }
    const messageText = openRouterMessageText(init);
    transport.messageTexts.push(messageText);
    return productionOpenRouterResponse(productionRedraftContent(messageText));
  }) as typeof fetch);
  try {
    return await callback(transport);
  } finally {
    vi.unstubAllGlobals();
    restoreEnvironment("OPENROUTER_API_KEY", originalApiKey);
    restoreEnvironment("OPENROUTER_ZDR_ACCOUNT_ASSERTED", originalZdrAssertion);
  }
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function openRouterMessageText(init: Parameters<typeof fetch>[1]): string {
  if (typeof init?.body !== "string") {
    throw new Error("production feedback redrafter transport received a non-string request body");
  }
  const parsed = JSON.parse(init.body) as { messages?: unknown };
  if (!Array.isArray(parsed.messages)) {
    throw new Error("production feedback redrafter request omitted chat messages");
  }
  return parsed.messages
    .map((message) => {
      if (message === null || typeof message !== "object") return "";
      const content = (message as { content?: unknown }).content;
      return typeof content === "string" ? content : JSON.stringify(content);
    })
    .join("\n");
}

function productionRedraftContent(messageText: string): string {
  if (messageText.includes("You are a localization translation agent.")) {
    const variant = feedbackVariants.find((candidate) =>
      messageText.includes(candidate.feedbackBody),
    );
    if (variant === undefined) {
      throw new Error(
        "production feedback redraft translation did not receive its canonical COMMENT/CONTEXT/WIKI content",
      );
    }
    return translationContent(currentBridgeUnitIdFromWire(messageText), variant.expectedTarget);
  }
  if (messageText.includes("You are a localization QA agent.")) {
    return emptyQaFindingsContent();
  }
  if (messageText.includes("You are a localization speaker-labeling agent.")) {
    return speakerLabelContent(currentBridgeUnitIdFromWire(messageText));
  }
  if (messageText.includes("Summarize the following scene")) {
    return "Live feedback fixture scene summary.";
  }
  if (messageText.includes("return a JSON object naming every character")) {
    return JSON.stringify({ bios: [], relationships: [] });
  }
  if (messageText.includes("surface forms that should become glossary entries")) {
    return JSON.stringify({ candidates: [] });
  }
  if (messageText.includes("return a JSON object naming the routes")) {
    return JSON.stringify({ routes: [], choices: [] });
  }
  throw new Error("production feedback redrafter made an unexpected OpenRouter request");
}

function translationContent(bridgeUnitId: string, draftText: string): string {
  return JSON.stringify({
    schemaVersion: "itotori.structured-translation-draft-output.v1",
    drafts: [
      {
        bridgeUnitId,
        sourceLocale: "ja-JP",
        targetLocale,
        draftText,
        confidenceFloor: "medium",
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "deterministic production transport fixture",
      },
    ],
  });
}

function emptyQaFindingsContent(): string {
  return JSON.stringify({
    schemaVersion: "itotori.structured-qa-finding-output.v1",
    findings: [],
  });
}

function speakerLabelContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: "itotori.speaker-label-output.v1",
    labels: [
      {
        bridgeUnitId,
        speakerId: { kind: "named", characterId: "feedback-captain", displayName: "Captain Wato" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "deterministic production transport fixture",
      },
    ],
  });
}

function currentBridgeUnitIdFromWire(messageText: string): string {
  const match = messageText.match(/unitId=([0-9a-f]{8}-[0-9a-f-]{27})/iu);
  if (match?.[1] === undefined) {
    throw new Error("production feedback redrafter transport could not identify the bridge unit");
  }
  return match[1];
}

function productionOpenRouterResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "gen-feedback-variants-production-transport",
      model: DEV_PAIR.modelId,
      provider: DEV_PAIR.providerId,
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
      // itotori-225-audit-allow: deterministic mock-wire cost only below the real external transport.
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.000001 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-blank string`);
  }
  return value;
}

function restoreEnvironment(name: string, priorValue: string | undefined): void {
  if (priorValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = priorValue;
  }
}
