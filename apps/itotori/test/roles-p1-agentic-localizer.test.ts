// P1 Whole-Scene Localizer — grounded, provisional translation-object proofs.
//
// The responder below is a recorded offline model boundary. P1 still makes the
// authoritative reads through RB-025 and re-seals the responder's untrusted
// object, so the test covers the role's actual public agent entrypoint without a
// live model call.

import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";

import {
  AcceptedOutputSchema,
  LocalizedRenderingSchema,
  TranslationWikiObjectSchema,
  type DraftBatch,
  type WikiObject,
} from "../src/contracts/index.js";
import { specialistFor } from "../src/roster/index.js";
import {
  readP1Scene,
  runP1Scene,
  buildP1AgentCall,
  dispatchP1Agent,
  type P1Context,
  type P1ModelCaller,
  type P1SegmentRequest,
} from "../src/roles/p1/index.js";
import type { ReadModel } from "../src/read-tools/index.js";
import type { DispatchRuntime } from "../src/llm/dispatch.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import { buildEvidenceIndex } from "../src/wiki/evidence-index.js";
import { acceptedOutputExample, localizedRenderingExample } from "./contract-fixtures-core.js";
import { structuredProviderResponse } from "./llm-step-test-support.js";
import { buildClaimFixture } from "./support/claim-fixture.js";

const LOCALIZATION_ID = `sha256:${"b".repeat(64)}` as const;
const CONTEXT: P1Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: "locale:p1-test",
};
const BIBLE_SUBJECT = "style:p1-scene";
const SCENE_1 = "scene:0001";
const DRAFT_PROFILE: MeasuredModelProfile = {
  name: "draft",
  version: deepSeekV4FlashProfile.version,
  deadlines: { normalMs: 300_000, deepMs: 600_000 },
  maxAttemptExposureUsd: "1",
};

/** Minimal in-memory durable memo seam for the recorded provider transport. */
class MemoryMemoStore implements LlmCallMemoStore {
  readonly #memos = new Map<string, Extract<LlmMemoSingleflightResult, { kind: "completed" }>>();
  readonly #attempts = new Map<string, number>();

  async singleflight(input: LlmMemoSingleflightInput): Promise<LlmMemoSingleflightResult> {
    const existing = this.#memos.get(input.memoKey);
    if (existing) {
      if (existing.semanticHash !== input.semanticHash)
        throw new LlmMemoConflictError(input.memoKey);
      return { ...existing, memoHit: true };
    }
    const ordinal = (this.#attempts.get(input.memoKey) ?? 0) + 1;
    if (ordinal > 3) throw new LlmRetriesExhaustedError(input.memoKey);
    this.#attempts.set(input.memoKey, ordinal);
    const execution = await input.execute({ ordinal, startedAt: new Date().toISOString() });
    if (execution.kind === "incomplete") {
      return {
        kind: "incomplete",
        memoHit: false,
        memoKey: input.memoKey,
        semanticHash: input.semanticHash,
        responseJson: execution.responseJson,
        attemptOrdinal: ordinal,
        failure: execution.failure,
      };
    }
    const completed = {
      kind: "completed" as const,
      memoHit: false,
      memoKey: input.memoKey,
      semanticHash: input.semanticHash,
      responseJson: execution.responseJson,
      outcomeJson: execution.outcomeJson,
      responseEventId: execution.responseEvent.eventId,
    };
    this.#memos.set(input.memoKey, completed);
    return completed;
  }
}

function recordedRuntime(response: Response, fetched: () => void): DispatchRuntime {
  return {
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
      OPENROUTER_ZDR_GUARDRAIL_ASSERTED: "1",
    },
    tools: [],
    contentAccess: { requireContentRead: async () => undefined },
    memo: {
      store: new MemoryMemoStore(),
      profile: DRAFT_PROFILE,
      admission: { scope: "test:roles-p1", confirmedCostCapUsd: "10" },
      snapshots: {
        decodeRevisionHash: LOCALIZATION_ID,
        glossaryRevisionHash: LOCALIZATION_ID,
        styleRevisionHash: LOCALIZATION_ID,
        acceptedOutputHeadHash: LOCALIZATION_ID,
      },
    },
    readPayload: async () => {
      throw new Error("unexpected non-P1 payload");
    },
    fetcher: async () => {
      fetched();
      return response;
    },
  };
}

function modelWithLocalizedBible(): ReadModel {
  const { model } = buildClaimFixture();
  const { sourceHash: _unitOnlySourceHash, ...acceptedBase } = acceptedOutputExample;
  const rendering = LocalizedRenderingSchema.parse({
    ...localizedRenderingExample,
    sourceObjectId: BIBLE_SUBJECT,
    provenance: {
      ...localizedRenderingExample.provenance,
      localizationSnapshotId: LOCALIZATION_ID,
      runMode: "test-dev",
    },
  });
  const acceptedRendering = AcceptedOutputSchema.parse({
    ...acceptedBase,
    outputId: "output:localized-bible:p1-scene",
    subjectType: "localized-rendering",
    subjectId: BIBLE_SUBJECT,
    localizationSnapshotId: LOCALIZATION_ID,
    stage: "localized-bible",
    value: rendering,
    releaseEligibility: {
      kind: "artifact-only",
      runMode: "test-dev",
      contextScope: "whole-game",
      reason: "test-dev",
    },
  });
  return {
    ...model,
    localization: {
      localizationSnapshotId: LOCALIZATION_ID,
      targetLocale: "en-US",
      localeBranchId: CONTEXT.localeBranchId,
      glossaryRevision: { revisionId: "revision:glossary:p1", contentHash: LOCALIZATION_ID },
      glossaryEntries: [],
      acceptedOutputs: [acceptedRendering],
    },
  };
}

function recordedTranslation(request: P1SegmentRequest, sourceHash = "source"): WikiObject {
  const coreIds =
    request.segment.mode === "whole-scene" ? request.segment.unitIds : request.segment.coreUnitIds;
  const batch: DraftBatch = {
    schemaVersion: "itotori.draft-batch.v1",
    localizationSnapshotId: LOCALIZATION_ID,
    batchId:
      request.segment.mode === "whole-scene"
        ? "draft:p1:whole"
        : `draft:p1:chunk:${request.segment.chunkIndex}`,
    scope:
      request.segment.mode === "whole-scene"
        ? {
            kind: "whole-scene",
            sceneId: request.segment.sceneId,
            expectedUnitIds: [...request.segment.unitIds],
          }
        : {
            kind: "overlapping-chunk",
            sceneId: request.segment.sceneId,
            chunkIndex: request.segment.chunkIndex,
            chunkCount: request.segment.chunkCount,
            coreUnitIds: [...request.segment.coreUnitIds],
            overlapUnitIds: [...request.segment.overlapUnitIds],
          },
    drafts: coreIds.map((unitId) => {
      const source = request.unitsById.get(unitId)!;
      return {
        unitId,
        sourceHash:
          sourceHash === "source" ? source.sourceHash : (`sha256:${"0".repeat(64)}` as const),
        targetSkeleton: `EN>${source.sourceSkeleton}`,
        evidenceIds: [unitId],
        basis: {
          kind: "wiki-first" as const,
          bibleRenderingIds: request.scene.bibleEntries.map((entry) => entry.renderingId),
        },
        uncertainty: ["none" as const],
      };
    }),
  };
  // Deliberately misleading metadata: this is the model's untrusted terminal
  // object. P1 must retain only the batch and stamp its own provenance, claims,
  // dependencies, and provisional state from deterministic context.
  return TranslationWikiObjectSchema.parse({
    schemaVersion: "itotori.wiki-object.v1",
    objectId: "translation:forged-model-object",
    version: 99,
    lang: "en-US",
    subject: { kind: "scene", id: request.scene.sceneId },
    scope: { kind: "global" },
    claims: [],
    media: [],
    dependencies: [],
    provisional: false,
    kind: "translation",
    body: { draftBatch: batch },
    provenance: {
      snapshotKind: "localization",
      contextSnapshotId: `sha256:${"f".repeat(64)}`,
      localizationSnapshotId: LOCALIZATION_ID,
      contextScope: "whole-game",
      runMode: "test-dev",
      authorRoleId: "A1",
    },
  });
}

describe("P1 agentic whole-scene localizer", () => {
  it("uses the certified WikiObject route over a recorded ZDR transport", async () => {
    const model = modelWithLocalizedBible();
    const scene = readP1Scene(model, CONTEXT, {
      sceneId: SCENE_1,
      bibleSubjectIds: [BIBLE_SUBJECT],
      budgetBytes: 8_000,
      overlapUnits: 1,
    });
    const segment = {
      mode: "whole-scene" as const,
      sceneId: scene.sceneId,
      unitIds: scene.normalizedUnits.map((unit) => unit.unitId),
    };
    const request: P1SegmentRequest = {
      scene,
      segment,
      unitsById: new Map(scene.normalizedUnits.map((unit) => [unit.unitId, unit])),
      priorAcceptedTarget: new Map(),
    };
    const call = buildP1AgentCall(
      model.snapshotId,
      model.localization!.localizationSnapshotId,
      CONTEXT,
      request,
    );
    let fetches = 0;
    const result = await dispatchP1Agent(
      call,
      recordedRuntime(structuredProviderResponse(recordedTranslation(request)), () => {
        fetches += 1;
      }),
    );
    expect(result.status).toBe("success");
    expect(result.status === "success" ? (result.value as WikiObject).kind : null).toBe(
      "translation",
    );
    expect(fetches).toBe(1);
    expect(call.spec.output.name).toBe("wiki-object");
    expect(call.spec.providerPolicy).toMatchObject({ zdr: true, allowFallbacks: true });
    expect(call.spec.providerPolicy).not.toHaveProperty("only");
  });

  it("reads exact scene/bible context and emits cited, provisional translation WikiObjects", async () => {
    const model = modelWithLocalizedBible();
    const seen: P1SegmentRequest[] = [];
    const recordedCaller: P1ModelCaller = async (request) => {
      seen.push(request);
      return recordedTranslation(request);
    };
    const scene = model.factSnapshot.scenes.find((candidate) => candidate.sceneId === SCENE_1)!;
    const readScene = readP1Scene(model, CONTEXT, {
      sceneId: SCENE_1,
      bibleSubjectIds: [BIBLE_SUBJECT],
      budgetBytes: 8_000,
      overlapUnits: 1,
    });
    const largestUnit = Math.max(
      ...readScene.normalizedUnits.map((unit) => Buffer.byteLength(unit.sourceSkeleton, "utf8")),
    );
    const result = await runP1Scene(
      model,
      CONTEXT,
      {
        sceneId: SCENE_1,
        bibleSubjectIds: [BIBLE_SUBJECT],
        budgetBytes: largestUnit,
        overlapUnits: 1,
      },
      recordedCaller,
    );

    // RB-025 reads supplied the COMPLETE scene, not a pre-sliced prompt bundle.
    expect(seen[0]!.scene.units.map((unit) => unit.factId)).toEqual(
      model.factSnapshot.orderedUnits
        .filter((unit) => unit.sceneId === SCENE_1)
        .map((unit) => unit.factId),
    );
    expect(seen[0]!.scene.bibleEntries.map((entry) => entry.renderingId)).toEqual(["rendering:1"]);
    expect(result.finalizedDrafts).toHaveLength(scene.unitCount);
    expect(result.finalizedDrafts.map((draft) => draft.unitId)).toEqual(
      seen[0]!.scene.units.map((unit) => unit.factId),
    );

    // Overlap cores are the only finalized units, and a validated core continues
    // the next P1 author-thread request.
    expect(result.plan.mode).toBe("overlapping-chunks");
    expect(new Set(result.finalizedDrafts.map((draft) => draft.unitId)).size).toBe(
      result.finalizedDrafts.length,
    );
    expect(seen[1]!.priorAcceptedTarget.size).toBeGreaterThan(0);

    const index = buildEvidenceIndex(model);
    for (const object of result.translationObjects) {
      expect(object.kind).toBe("translation");
      expect(object.provisional).toBe(true);
      expect(object.provenance.authorRoleId).toBe("P1");
      expect(object.provenance.contextSnapshotId).toBe(model.snapshotId);
      expect(object.provenance.snapshotKind).toBe("localization");
      expect(object.dependencies.map((dependency) => dependency.renderingId)).toEqual([
        "rendering:1",
      ]);
      for (const claim of object.claims) {
        const citation = claim.citations[0]!;
        expect(citation.evidenceHash).toBe(index.get(citation.evidenceId)!.hash);
      }
    }
  });

  it("lets deterministic source facts reject a model-forged source hash", async () => {
    const model = modelWithLocalizedBible();
    const recordedCaller: P1ModelCaller = async (request) => recordedTranslation(request, "forged");
    await expect(
      runP1Scene(
        model,
        CONTEXT,
        {
          sceneId: SCENE_1,
          bibleSubjectIds: [BIBLE_SUBJECT],
          budgetBytes: 8_000,
          overlapUnits: 1,
        },
        recordedCaller,
      ),
    ).rejects.toThrow(/source-hash/u);
  });

  it("derives P1's immutable profile/tool configuration from the roster", () => {
    const p1 = specialistFor("P1");
    expect(Object.isFrozen(p1)).toBe(true);
    expect(p1.wikiObjectKind).toBe("translation");
    expect(p1.modelProfileKey).toBe("deepseek-v4-flash");
    expect(p1.tools).toEqual(
      expect.arrayContaining(["decode_get_units", "glossary_lookup", "outputs_get_accepted"]),
    );
  });
});
