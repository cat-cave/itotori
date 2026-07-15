// itotori-agentic-loop-live-llm (repair-live residue) — standalone paid-route
// guard for the agentic loop's former live repair proof.
//
// The loop has no durable run cost-admission authority on this direct path.
// With the real OpenRouter provider configuration, its first paid invocation
// must therefore pause before a physical transport call. The capturing wrapper
// makes that no-dispatch assertion explicit without charging the provider.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePairPolicyV03,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";
import {
  LocalProviderRunArtifactRecorder,
  OpenRouterModelProvider,
} from "../src/providers/index.js";
import { DEFAULT_COST_CAP_USD } from "../src/providers/openrouter.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelProvider,
} from "../src/providers/types.js";
import {
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
  type PairChoice,
  type PairPolicy,
} from "../src/orchestrator/agentic-loop.js";
import type { AuthorizationActor } from "@itotori/db";

const HERE = dirname(fileURLToPath(import.meta.url));

const LIVE_ENABLED =
  process.env.ITOTORI_LIVE_PROVIDER === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0 &&
  process.env.OPENROUTER_ZDR_ACCOUNT_ASSERTED === "1";

const ACTOR: AuthorizationActor = { userId: "itotori-agentic-repair-live-actor" };

// Non-copyrighted, public Japanese source (a plain greeting + weather
// remark). Nothing derived from any real game corpus is committed here;
// the repair proof only needs an unambiguous source/draft mismatch.
const SOURCE_TEXT = "こんにちは。今日はいい天気ですね。";
// A deliberately-INCORRECT first draft: semantically unrelated to the
// source, so the live QA agents genuinely flag it as a mistranslation.
// It is grammatical + balanced so it PASSES the deterministic checks and
// reaches the (live) QA stage — the rejection has to come from QA, not a
// deterministic short-circuit.
const BAD_PRIMARY_DRAFT = "System error: the database connection was refused.";

const BRIDGE_UNIT_ID = "019ed079-0000-7000-8000-00000000ac01";
const PROJECT_ID = "019ed079-0000-7000-8000-000000000001";
const LOCALE_BRANCH_ID = "019ed079-0000-7000-8000-000000000002";
const REVISION_ID = "019ed079-0000-7000-8000-000000000003";
const ASSET_ID = "019ed079-0000-7000-8000-000000000004";

function makeUnit(): LocalizationUnitV02 {
  return {
    bridgeUnitId: BRIDGE_UNIT_ID,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey: "scene-001/line-001",
    occurrenceId: "occ-001",
    sourceLocale: "ja-JP",
    sourceText: SOURCE_TEXT,
    sourceHash: "src-hash-repair-live",
    sourceRevision: {
      revisionId: REVISION_ID,
      revisionKind: "content_hash",
      value: "repair-live-rev",
    },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "repair-live-asset" },
    sourceLocation: { containerKey: "repair-live-asset" },
    context: {},
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: "scene-001/line-001",
      sourceRevision: {
        revisionId: REVISION_ID,
        revisionKind: "content_hash",
        value: "repair-live-rev",
      },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makeInput(): AgenticLoopUnitInput {
  return {
    unit: makeUnit(),
    sourceRevisionId: REVISION_ID,
    sceneUnits: [],
    glossary: [],
    protectedSpans: [],
    knownCharacters: [],
    actor: ACTOR,
  };
}

function makePolicy(): AgenticLoopPolicy {
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    // Two attempts of headroom so a transient sub-par repair draft does
    // not flake the proof; the assertion still requires an ACCEPTED repair.
    maxRepairAttempts: 2,
  };
}

function badPrimaryDraftContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId: BRIDGE_UNIT_ID,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText: BAD_PRIMARY_DRAFT,
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale:
          "repair-live fixture: deliberately-incorrect first draft that reaches live QA",
        confidenceFloor: "medium",
      },
    ],
  });
}

function loadPresetPairPolicy(): PairPolicy {
  const presetPath = resolvePath(HERE, "../../../presets/localize-project.pair-policy.json");
  const raw = readFileSync(presetPath, "utf8");
  const parsed = parsePairPolicyV03(JSON.parse(raw), {
    defaultCostCapUsd: DEFAULT_COST_CAP_USD,
    zdrDowngradeEnv: process.env.OPENROUTER_ZDR_DOWNGRADE,
  });
  return parsed.stages;
}

type CapturedInvocation = {
  stage: string;
  agentLabel: string;
  taskKind: string;
  requestedModelId: string;
  requestedProviderId: string;
  servedModelId: string;
  servedProviderId: string | undefined;
  costAmountUsd: string;
  costMicrosUsd: number;
  costKind: string;
  zdr: boolean;
  status: string;
  content: string | null;
};

/**
 * Wraps the single shared live OpenRouter provider so every invocation
 * records the SERVED (model, providerId) pair, the real `usage.cost`, and
 * the on-the-wire ZDR posture straight off the provider-run record. It
 * also injects the per-stage `maxPriceUsd` posture (mirroring the
 * production StagePostureProviderWrapper) and surfaces the pair-aware
 * descriptor so the structured-output agents see the correct capability
 * sheet. It NEVER rewrites the prompt or the response.
 */
class CapturingLiveWrapper implements ModelProvider {
  readonly descriptor: ModelProvider["descriptor"];
  constructor(
    private readonly inner: OpenRouterModelProvider,
    private readonly stage: string,
    private readonly agentLabel: string,
    private readonly posture: PairChoice,
    private readonly sink: CapturedInvocation[],
  ) {
    this.descriptor = inner.descriptorForModel(posture.pair.modelId);
  }
  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const res = await this.inner.invoke({ ...request, maxPriceUsd: this.posture.maxPriceUsd });
    const run = res.providerRun;
    this.sink.push({
      stage: this.stage,
      agentLabel: this.agentLabel,
      taskKind: run.taskKind,
      requestedModelId: run.provider.requestedModelId,
      requestedProviderId: run.provider.requestedProviderId,
      servedModelId: run.provider.actualModelId,
      servedProviderId: run.provider.upstreamProvider,
      costAmountUsd: run.cost.amountUsd,
      costMicrosUsd: run.cost.amountMicrosUsd,
      costKind: run.cost.costKind,
      zdr: run.routingPosture.zdr,
      status: run.status,
      content: res.content,
    });
    return res;
  }
}

describe("itotori-agentic-loop-live-llm — standalone paid invocation boundary", () => {
  it("refuses the configured OpenRouter route before a repair-loop transport call", async () => {
    if (!LIVE_ENABLED) {
      // eslint-disable-next-line no-console
      console.warn(
        "[agentic-repair-live] skipping — set ITOTORI_LIVE_PROVIDER=1 + OPENROUTER_API_KEY " +
          "(and OPENROUTER_ZDR_ACCOUNT_ASSERTED=1) to exercise the paid-route guard",
      );
      return;
    }

    const artifactsDir = mkdtempSync(join(tmpdir(), "itotori-agentic-repair-live-runs-"));
    // Constructor is fail-closed on ZDR: throws AccountZdrAssertionError
    // unless OPENROUTER_ZDR_ACCOUNT_ASSERTED=1.
    const live = new OpenRouterModelProvider({
      artifactRecorder: new LocalProviderRunArtifactRecorder(artifactsDir),
    });

    const captured: CapturedInvocation[] = [];
    const factory: AgenticLoopProviderFactory = ({ stage, agentLabel, pair }) => {
      if (stage === "translation") {
        // Primary draft ONLY — a genuine (fixture) mistranslation so the
        // downstream LIVE QA agents have something real to reject. The
        // repair stage (stage === "repair") is NOT this branch, so it
        // routes to the live provider below.
        return new FakeModelProvider({
          providerName: "itotori-agentic-repair-live:bad-primary",
          generate: (request: ModelInvocationRequest) =>
            request.taskKind === "draft_translation" ? badPrimaryDraftContent() : "",
        });
      }
      return new CapturingLiveWrapper(live, stage, agentLabel, pair, captured);
    };

    await expect(
      runAgenticLoopForUnit(makeInput(), loadPresetPairPolicy(), makePolicy(), factory),
    ).rejects.toMatchObject({
      name: "InvocationOperationalPauseError",
      blocker: {
        kind: "budget_cap",
        detail: expect.stringContaining("durable cost-admission"),
      },
    });
    expect(captured).toEqual([]);
  }, 120_000);
});
