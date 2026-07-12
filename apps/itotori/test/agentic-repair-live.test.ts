// itotori-agentic-loop-live-llm (repair-live residue) — proves the
// REPAIR branch of the full agentic loop fires LIVE against a real ZDR
// OpenRouter route.
//
// alpha-006d already proved the loop live end-to-end (context ->
// speaker-label -> translation -> QA) on real Sweetie HD dialogue with
// zero repairs (QA passed). The ONE stage never exercised live was
// REPAIR. This harness closes that residue: it drives a scenario where
//
//   1. the FIRST translation draft is a deliberately-INCORRECT rendering
//      of a non-copyrighted Japanese source (a genuine bad translation,
//      NOT a faked verdict),
//   2. the four LIVE QA agents evaluate that draft and GENUINELY reject it
//      (a real `mistranslation`/`tone`/`context-mismatch` finding routed to
//      a repairable root cause), and
//   3. the REPAIR stage fires a LIVE ZDR translation call that regenerates
//      the draft, which becomes the selected written candidate after re-QA.
//
// Nothing here weakens QA or fakes the rejection: the QA verdict is the
// live model's own judgement of a genuinely-wrong draft. Only the primary
// draft is a fixture (a real mistranslation) — QA and repair are LIVE.
//
// Gated identically to alpha-006d's live path:
//   ITOTORI_LIVE_PROVIDER=1 + OPENROUTER_API_KEY (+ the OpenRouter
//   provider's own fail-closed OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 gate,
//   asserted in the OpenRouterModelProvider constructor). Without the
//   opt-in the test prints a visible skip (no silent pass).
//
// The configured (modelId, providerId) pair is read from the SAME preset
// alpha-006d used (`presets/localize-project.pair-policy.json`) — never
// hardcoded here. The SERVED pair, real `usage.cost`, and ZDR posture are
// captured per invocation from the live provider-run records and written
// to an evidence artifact.

import { mkdtempSync, writeFileSync } from "node:fs";
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
  process.env.OPENROUTER_API_KEY.length > 0;

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
    this.descriptor = inner.descriptorForPair(posture.pair);
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

describe("itotori-agentic-loop-live-llm — repair branch fires LIVE (ZDR)", () => {
  it("genuine QA finding -> live ZDR repair call -> repaired candidate selected", async () => {
    if (!LIVE_ENABLED) {
      // eslint-disable-next-line no-console
      console.warn(
        "[agentic-repair-live] skipping — set ITOTORI_LIVE_PROVIDER=1 + OPENROUTER_API_KEY " +
          "(and OPENROUTER_ZDR_ACCOUNT_ASSERTED=1) to run the live repair proof",
      );
      return;
    }

    const artifactsDir = mkdtempSync(join(tmpdir(), "itotori-agentic-repair-live-runs-"));
    // Constructor is fail-closed on ZDR: throws AccountZdrAssertionError
    // unless OPENROUTER_ZDR_ACCOUNT_ASSERTED=1.
    const live = new OpenRouterModelProvider({
      costCapUsd: 0.25,
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

    const bundle = await runAgenticLoopForUnit(
      makeInput(),
      loadPresetPairPolicy(),
      makePolicy(),
      factory,
    );

    // --- The QA annotation -> repair -> selected-candidate transition ---
    const qaStage = bundle.stages.find((s) => s.stageName === "qa_findings");
    const repairStage = bundle.stages.find((s) => s.stageName === "repair");
    expect(qaStage?.invocations.length ?? 0).toBeGreaterThanOrEqual(1);
    // Repair fired a LIVE call and the repaired candidate was selected while
    // every QA concern remained a permanent annotation.
    expect(bundle.writtenOutcome.status).toBe("written");
    expect(bundle.writtenOutcome.findings.length).toBeGreaterThanOrEqual(1);
    expect(repairStage?.invocations.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(repairStage?.outcome ?? "").toMatch(/^selected_repair_candidate_at_attempt_/u);
    const selectedCandidate = bundle.writtenOutcome.candidates.find(
      (candidate) => candidate.id === bundle.writtenOutcome.selectedCandidateId,
    );
    expect(selectedCandidate?.kind).toBe("repair");
    expect(selectedCandidate?.body).toBeTruthy();

    // --- Live ZDR + served-pair + real-cost evidence --------------------
    const qaCaptured = captured.filter((c) => c.stage === "qa_findings");
    const repairCaptured = captured.filter((c) => c.stage === "repair");
    expect(qaCaptured.length).toBeGreaterThanOrEqual(1);
    expect(repairCaptured.length).toBeGreaterThanOrEqual(1);
    // Fail-closed: every live invocation must be ZDR-enforced and billed.
    for (const c of captured) {
      expect(c.zdr).toBe(true);
      expect(c.status).toBe("succeeded");
      expect(c.servedModelId.length).toBeGreaterThan(0);
    }
    const repairInvocation = repairCaptured[0];
    expect(repairInvocation).toBeDefined();
    // The repair call is genuinely billed (real usage.cost > 0).
    expect(Number.parseFloat(repairInvocation!.costAmountUsd)).toBeGreaterThan(0);

    // Parse the genuine QA findings (the rejection) out of the live QA
    // response content for the evidence artifact.
    const qaFindings: Array<{
      agentLabel: string;
      category: string;
      severity: string;
      recommendation: string;
    }> = [];
    for (const c of qaCaptured) {
      if (c.content === null) continue;
      try {
        const parsed = JSON.parse(c.content) as {
          findings?: Array<{ category?: string; severity?: string; recommendation?: string }>;
        };
        for (const f of parsed.findings ?? []) {
          qaFindings.push({
            agentLabel: c.agentLabel,
            category: String(f.category ?? "unknown"),
            severity: String(f.severity ?? "unknown"),
            recommendation: String(f.recommendation ?? ""),
          });
        }
      } catch {
        // A non-JSON QA body would already have failed the agent; ignore.
      }
    }
    expect(qaFindings.length).toBeGreaterThanOrEqual(1);

    const totalCostUsd = captured.reduce(
      (acc, c) => acc + Number.parseFloat(c.costAmountUsd || "0"),
      0,
    );
    // Sanity budget guard — the whole loop is ~10 cheap calls.
    expect(totalCostUsd).toBeLessThan(1);

    const evidence = {
      node: "itotori-agentic-loop-live-llm (repair-live residue)",
      complements: "alpha-006d (loop proven live with 0 repairs; repair branch was the residue)",
      pairFromPreset: "presets/localize-project.pair-policy.json",
      transition: {
        firstDraft: "fixture mistranslation (genuine bad translation, reached live QA)",
        qaVerdict: "annotated",
        findingCount: bundle.writtenOutcome.findings.length,
        qualityFlags: bundle.writtenOutcome.qualityFlags,
        repairOutcome: repairStage?.outcome,
        writtenStatus: bundle.writtenOutcome.status,
        selectedCandidateId: bundle.writtenOutcome.selectedCandidateId,
      },
      qaRejectionFindings: qaFindings,
      repairLiveCall: {
        servedModelId: repairInvocation!.servedModelId,
        servedProviderId: repairInvocation!.servedProviderId,
        requestedModelId: repairInvocation!.requestedModelId,
        requestedProviderId: repairInvocation!.requestedProviderId,
        costAmountUsd: repairInvocation!.costAmountUsd,
        costMicrosUsd: repairInvocation!.costMicrosUsd,
        zdr: repairInvocation!.zdr,
      },
      allLiveInvocations: captured.map((c) => ({
        stage: c.stage,
        agentLabel: c.agentLabel,
        taskKind: c.taskKind,
        servedModelId: c.servedModelId,
        servedProviderId: c.servedProviderId,
        costAmountUsd: c.costAmountUsd,
        zdr: c.zdr,
      })),
      totalCostUsd: totalCostUsd.toFixed(8),
      liveInvocationCount: captured.length,
      selectedRepairDraft: selectedCandidate?.body,
    };

    const evidencePath =
      process.env.ITOTORI_REPAIR_LIVE_EVIDENCE_PATH ??
      join(artifactsDir, "repair-live-evidence.json");
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    // eslint-disable-next-line no-console
    console.log(
      `[agentic-repair-live] QA annotation->repair->written selection proven LIVE. ` +
        `served repair pair=(${repairInvocation!.servedModelId}, ${repairInvocation!.servedProviderId}) ` +
        `repairCostUsd=${repairInvocation!.costAmountUsd} zdr=${repairInvocation!.zdr} ` +
        `outcome=${bundle.writtenOutcome.status} candidate=${bundle.writtenOutcome.selectedCandidateId} ` +
        `totalCostUsd=${totalCostUsd.toFixed(8)} calls=${captured.length}\n` +
        `[agentic-repair-live] evidence: ${evidencePath}`,
    );
  }, 120_000);
});
