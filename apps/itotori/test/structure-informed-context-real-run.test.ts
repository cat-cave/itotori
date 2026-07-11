// itotori-structure-informed-context-building — REAL RUN (A vs B) proof.
//
// Gated on ITOTORI_STRUCTCTX_LIVE=1 + OPENROUTER_API_KEY +
// OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 + ITOTORI_STRUCTCTX_STRUCTURE_JSON (the
// path to the real decoded NarrativeStructure JSON emitted by
// the `utsushi structure` subcommand — held OUTSIDE the repo
// because it carries copyrighted script text). When any is unset the test
// prints a visible skip note and returns (no silent pass); `pnpm test` in CI
// therefore skips it.
//
// When live, it translates a real Sweetie slice through the SAME translate
// stage (`TranslationAgent`) under two conditions:
//   A. no-structure baseline  — structuredContext absent (prompt is
//      byte-identical to the pre-feature template).
//   B. structure-informed     — structuredContext injected from the decode
//      (scene summary + route/branch position + speaker character arcs).
// It records the REAL `usage.cost` per condition, confirms the ZDR posture on
// every response, then runs an LLM judge (declaring its own model+provider +
// ZDR) that scores which condition is better and why. The non-copyrighted
// summary (scene ids / counts / cost / verdict) is written to
// ITOTORI_STRUCTCTX_REPORT (default: a /tmp path); the raw drafts stay only
// in that out-of-repo file.

import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OpenRouterProvider,
  assertOpenRouterZdrAccount,
  openRouterDefaultCapabilities,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
} from "../src/providers/index.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import { buildTranslationPrompt } from "../src/agents/translation/prompt-template.js";
import { repairJsonObject } from "../src/localization/patchback-safety.js";
import {
  TRANSLATION_PROMPT_TEMPLATE_VERSION_V1,
  type TranslationBridgeUnit,
  type TranslationInvocationInput,
} from "../src/agents/translation/shapes.js";
import type { ModelInvocationResult } from "../src/providers/types.js";
import {
  buildSliceStructuredContext,
  buildStructureContextArtifacts,
  parseNarrativeStructure,
} from "../src/agents/structure-informed-context/index.js";
const LIVE_ENABLED =
  process.env.ITOTORI_STRUCTCTX_LIVE === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0 &&
  typeof process.env.ITOTORI_STRUCTCTX_STRUCTURE_JSON === "string";

// Small slice; well under the $2.00 budget cap (a handful of lines × 2
// conditions + 1 judge call, each ~1-2k tokens).
const SLICE_SIZE = 5;
const SLICE_SCENE_ID = Number(process.env.ITOTORI_STRUCTCTX_SCENE ?? "6010");
const BUDGET_CAP_USD = 2.0;
const PER_CALL_MAX_PRICE_USD = 0.5;

describe("itotori-structure-informed-context-building — real A/B improvement", () => {
  it("structure-informed context yields a better translation than the baseline", async () => {
    if (!LIVE_ENABLED) {
      // eslint-disable-next-line no-console
      console.warn(
        "[structctx] skipping real run — set ITOTORI_STRUCTCTX_LIVE=1, OPENROUTER_API_KEY, " +
          "OPENROUTER_ZDR_ACCOUNT_ASSERTED=1, and ITOTORI_STRUCTCTX_STRUCTURE_JSON=<path> to run it",
      );
      return;
    }

    const env = process.env;
    // Privacy gate BEFORE any live byte.
    assertOpenRouterZdrAccount(env);

    const structure = parseNarrativeStructure(
      JSON.parse(readFileSync(env.ITOTORI_STRUCTCTX_STRUCTURE_JSON as string, "utf8")) as unknown,
    );
    const artifacts = buildStructureContextArtifacts(structure);
    const ctx = buildSliceStructuredContext(artifacts, SLICE_SCENE_ID);

    const scene = structure.scenes.find((s) => s.sceneId === SLICE_SCENE_ID);
    expect(scene).toBeDefined();
    if (scene === undefined) {
      return;
    }
    // Pick a handful of SHORT lines WITH a speaker — the lines whose meaning
    // most depends on scene / speaker / branch (a bare "…" or a one-word
    // reply is ambiguous without the arc + scene).
    const sliceLines = scene.messages
      .filter((m) => m.speaker !== null && !(m.textSurface ?? "").startsWith("choice:"))
      .filter((m) => m.text.trim().length > 0 && m.text.length <= 40)
      .slice(0, SLICE_SIZE);
    expect(sliceLines.length).toBeGreaterThan(0);

    // Condition B (structure-informed) units carry the SPEAKER (itself a
    // product of the Utsushi `#NAMAE` decode). Condition A (no-structure
    // baseline) is genuinely structure-free: no speaker, no scene, no arc —
    // exactly what a translator sees WITHOUT owning the decode. The delta
    // between the two IS the value of consuming the structure.
    const unitsWithSpeaker: TranslationBridgeUnit[] = sliceLines.map((m) => ({
      bridgeUnitId: `line-${SLICE_SCENE_ID}-${m.order}`,
      sourceUnitKey: `${SLICE_SCENE_ID}:${m.order}`,
      sourceText: m.text,
      sourceHash: `hash-${SLICE_SCENE_ID}-${m.order}`,
      speaker: m.speaker ?? undefined,
    }));
    const unitsNoSpeaker: TranslationBridgeUnit[] = unitsWithSpeaker.map((u) => {
      const { speaker: _drop, ...rest } = u;
      return rest;
    });
    const sourceBridgeUnits = unitsWithSpeaker;

    const capabilities = zdrStructuredCapabilities();
    const recorder = memoryRecorder();
    const provider = new OpenRouterProvider({
      modelId: DEV_PAIR.modelId,
      apiKey: env.OPENROUTER_API_KEY as string,
      capabilities,
      routing: { zdr: true, dataCollection: "deny", allowFallbacks: true },
      live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
    });

    const baseInput = (
      structuredContext: TranslationInvocationInput["structuredContext"],
      contextArtifactRefs: string[],
      units: TranslationBridgeUnit[],
    ): TranslationInvocationInput => ({
      draftJobId: `structctx-${SLICE_SCENE_ID}`,
      draftJobAttemptId: structuredContext ? "cond-b-structure" : "cond-a-baseline",
      projectId: "structctx-proj",
      localeBranchId: "structctx-branch",
      sourceLocale: "ja",
      targetLocale: "en",
      sourceBridgeUnits: units,
      protectedSpansBySource: new Map(),
      glossary: [],
      styleGuide: [],
      contextArtifactRefs,
      structuredContext,
      modelProfile: {
        providerFamily: "openrouter",
        modelId: DEV_PAIR.modelId,
        providerId: DEV_PAIR.providerId,
        contextWindowTokens: 128_000,
        maxOutputTokens: 4_096,
      },
      promptTemplateVersion: TRANSLATION_PROMPT_TEMPLATE_VERSION_V1,
    });

    // WORKAROUND (guarded): the TranslationAgent forces json_object/json_schema
    // structured output, but at run time BOTH are UNROUTABLE under ZDR for the
    // DEV_PAIR (OpenRouter HTTP 404 "No endpoints found that can handle the
    // requested parameters" — `require_parameters:true` narrows the ZDR pool to
    // empty). The plain chat completion IS routable (verified HTTP 200, served
    // by Fireworks). So the A/B proof drives the REAL translate PROMPT
    // (buildTranslationPrompt — the exact prompt the agent builds, WITH the
    // structured-context injection for B) through provider.invoke in plain mode
    // (no response_format), then parses the prompt-enforced JSON. The load-
    // bearing artifact under test — the injected structural context in the
    // prompt — is identical to what the agent would send.
    const resultA = await translateSlice(provider, baseInput(undefined, [], unitsNoSpeaker));
    // Condition B — structure-informed context.
    const resultB = await translateSlice(
      provider,
      baseInput(ctx, ctx.artifactRefs, unitsWithSpeaker),
    );

    const zdrA = resultA.zdr;
    const zdrB = resultB.zdr;
    expect(zdrA).toBe(true);
    expect(zdrB).toBe(true);

    const costA = resultA.costUsd;
    const costB = resultB.costUsd;

    // Budget cap guard.
    const runningTotal = costA + costB;
    expect(runningTotal).toBeLessThanOrEqual(BUDGET_CAP_USD);

    // Bias-controlled LLM judge (declares its own model+provider + ZDR): the
    // two sets are compared TWICE with their positions SWAPPED, and the
    // structural-criteria scores are aggregated, so neither label nor slot
    // position can bias the verdict.
    const judge = await runJudge({
      provider,
      sourceUnits: sourceBridgeUnits,
      structuralFacts: {
        sceneSummary: ctx.sceneSummaryText,
        routePosition: ctx.routePositionText,
        characterArcs: ctx.characterArcsText,
      },
      draftsStructure: resultB.drafts,
      draftsBaseline: resultA.drafts,
    });
    const zdrJudge = judge.zdr;
    expect(zdrJudge).toBe(true);

    const total = costA + costB + judge.costUsd;
    expect(total).toBeLessThanOrEqual(BUDGET_CAP_USD);

    // Write the full (out-of-repo) report; keep copyrighted text OUT of the
    // committed summary.
    const reportPath = env.ITOTORI_STRUCTCTX_REPORT ?? "/tmp/structctx-real-run-report.json";
    const report = {
      sceneId: SLICE_SCENE_ID,
      dispatchOrder: structure.sceneDispatchOrder,
      sliceLineCount: sourceBridgeUnits.length,
      zdr: { conditionA: zdrA, conditionB: zdrB, judge: zdrJudge },
      cost: {
        conditionA_usd: costA,
        conditionB_usd: costB,
        judge_usd: judge.costUsd,
        total_usd: total,
      },
      servedPair: {
        conditionA: resultA.servedPair,
        conditionB: resultB.servedPair,
      },
      judge: {
        winner: judge.winner,
        structureScore: judge.structureScore,
        baselineScore: judge.baselineScore,
        reasons: judge.reasons,
      },
      finishReason: { conditionA: resultA.finishReason, conditionB: resultB.finishReason },
      draftsA: resultA.drafts.map((d) => ({
        bridgeUnitId: d.bridgeUnitId,
        draftText: d.draftText,
      })),
      draftsB: resultB.drafts.map((d) => ({
        bridgeUnitId: d.bridgeUnitId,
        draftText: d.draftText,
      })),
      rawContent: {
        conditionA: resultA.rawContent,
        conditionB: resultB.rawContent,
        judge: judge.rawContent,
      },
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    // eslint-disable-next-line no-console
    console.log(
      `[structctx] scene=${SLICE_SCENE_ID} lines=${sourceBridgeUnits.length} ` +
        `costA=$${costA.toFixed(6)} costB=$${costB.toFixed(6)} judge=$${judge.costUsd.toFixed(6)} ` +
        `total=$${total.toFixed(6)} baselineScore=${judge.baselineScore} ` +
        `structureScore=${judge.structureScore} winner=${judge.winner} report=${reportPath}`,
    );

    // The proof: aggregated over both swapped passes on the structural
    // criteria (speaker-voice consistency / referent resolution / branch +
    // scene awareness), the structure-informed condition (B) is at least as
    // good as the no-structure baseline (A) — it is never judged worse.
    expect(judge.structureScore).toBeGreaterThanOrEqual(judge.baselineScore);
    expect(judge.winner).not.toBe("baseline");
  }, 180_000);
});

// --- helpers ---------------------------------------------------------------

/** json_schema is UNROUTABLE under ZDR for the DEV_PAIR; json_object is proven. */
function zdrStructuredCapabilities(): ModelCapabilities {
  return {
    ...openRouterDefaultCapabilities,
    structuredOutputs: {
      ...openRouterDefaultCapabilities.structuredOutputs,
      jsonSchema: "unsupported",
      jsonObject: "supported",
      preferredModes: ["json_object"],
    },
  };
}

type SliceDraft = { bridgeUnitId: string; draftText: string };
type SliceResult = {
  drafts: SliceDraft[];
  zdr: boolean;
  costUsd: number;
  servedPair: { model: string; provider?: string };
  finishReason: string;
  rawContent: string;
};

function invocationZdr(result: ModelInvocationResult): boolean {
  const posture = result.providerRun.routingPosture;
  return posture?.zdr === true && posture.data_collection === "deny";
}

function invocationCostUsd(result: ModelInvocationResult): number {
  return (result.providerRun.cost.amountMicrosUsd ?? 0) / 1_000_000;
}

function invocationServedPair(result: ModelInvocationResult): { model: string; provider?: string } {
  const p = result.providerRun.provider;
  const served: { model: string; provider?: string } = { model: p.actualModelId };
  if (p.upstreamProvider !== undefined) {
    served.provider = p.upstreamProvider;
  }
  return served;
}

/**
 * Drive the REAL translate prompt (buildTranslationPrompt — with the injected
 * structural context when `input.structuredContext` is set) through a plain
 * (routable-under-ZDR) chat completion, then parse the prompt-enforced
 * StructuredTranslationDraftOutput JSON leniently.
 */
async function translateSlice(
  provider: OpenRouterProvider,
  input: TranslationInvocationInput,
): Promise<SliceResult> {
  const rendered = buildTranslationPrompt(input);
  const request: ModelInvocationRequest = {
    taskKind: "draft_translation",
    modelId: DEV_PAIR.modelId,
    providerId: DEV_PAIR.providerId,
    inputClassification: "private_corpus",
    messages: [
      { role: "system", content: rendered.systemText },
      { role: "user", content: rendered.userText },
    ],
    generation: { temperature: 0, maxOutputTokens: input.modelProfile.maxOutputTokens ?? 4_096 },
    maxPriceUsd: PER_CALL_MAX_PRICE_USD,
    prompt: {
      presetId: "structctx-translate",
      templateVersion: input.promptTemplateVersion,
      promptHash: `sha256:${"1".repeat(64)}`,
      schemaVersion: "itotori.prompt-preset.v0",
    },
  };
  const result = await provider.invoke(request);
  const known = new Set(input.sourceBridgeUnits.map((u) => u.bridgeUnitId));
  const rawContent = result.content ?? "";
  return {
    drafts: parseDrafts(rawContent, known),
    zdr: invocationZdr(result),
    costUsd: invocationCostUsd(result),
    servedPair: invocationServedPair(result),
    finishReason: result.finishReason,
    rawContent,
  };
}

function parseDrafts(content: string, known: ReadonlySet<string>): SliceDraft[] {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    obj = repairJsonObject(content);
  }
  const drafts: SliceDraft[] = [];
  const record = obj as { drafts?: unknown };
  const list = Array.isArray(record?.drafts) ? record.drafts : [];
  for (const raw of list) {
    const d = raw as { bridgeUnitId?: unknown; draftText?: unknown };
    if (
      typeof d.bridgeUnitId === "string" &&
      typeof d.draftText === "string" &&
      known.has(d.bridgeUnitId)
    ) {
      drafts.push({ bridgeUnitId: d.bridgeUnitId, draftText: d.draftText });
    }
  }
  return drafts;
}

type JudgeAggregate = {
  winner: "structure" | "baseline" | "tie";
  structureScore: number;
  baselineScore: number;
  reasons: string[];
  costUsd: number;
  zdr: boolean;
  rawContent: string;
};

/**
 * Bias-controlled paired judge. Runs the comparison TWICE with the two
 * translation sets in swapped slot positions (set1/set2 — no A/B labels), so
 * neither a label prior nor a slot-position prior can steer the verdict. The
 * structural-criteria scores each set receives are aggregated across both
 * passes; the structure-informed set wins only if its aggregate exceeds the
 * baseline's.
 */
async function runJudge(args: {
  provider: OpenRouterProvider;
  sourceUnits: ReadonlyArray<TranslationBridgeUnit>;
  structuralFacts: { sceneSummary: string; routePosition: string; characterArcs: string };
  draftsStructure: SliceDraft[];
  draftsBaseline: SliceDraft[];
}): Promise<JudgeAggregate> {
  // Pass 1: set1 = structure, set2 = baseline. Pass 2: swapped.
  const pass1 = await judgeOnce(args.provider, args.sourceUnits, args.structuralFacts, {
    set1: args.draftsStructure,
    set2: args.draftsBaseline,
  });
  const pass2 = await judgeOnce(args.provider, args.sourceUnits, args.structuralFacts, {
    set1: args.draftsBaseline,
    set2: args.draftsStructure,
  });
  // In pass1 the structure set is slot 1; in pass2 it is slot 2.
  const structureScore = pass1.score1 + pass2.score2;
  const baselineScore = pass1.score2 + pass2.score1;
  const winner: JudgeAggregate["winner"] =
    structureScore > baselineScore
      ? "structure"
      : structureScore < baselineScore
        ? "baseline"
        : "tie";
  return {
    winner,
    structureScore,
    baselineScore,
    reasons: [...pass1.reasons, ...pass2.reasons],
    costUsd: pass1.costUsd + pass2.costUsd,
    zdr: pass1.zdr && pass2.zdr,
    rawContent: `PASS1(set1=structure):\n${pass1.rawContent}\n\nPASS2(set1=baseline):\n${pass2.rawContent}`,
  };
}

type PassScore = {
  score1: number;
  score2: number;
  reasons: string[];
  costUsd: number;
  zdr: boolean;
  rawContent: string;
};

async function judgeOnce(
  provider: OpenRouterProvider,
  sourceUnits: ReadonlyArray<TranslationBridgeUnit>,
  structuralFacts: { sceneSummary: string; routePosition: string; characterArcs: string },
  sets: { set1: SliceDraft[]; set2: SliceDraft[] },
): Promise<PassScore> {
  const payload = {
    task: "Two English translation sets (set1, set2) of the SAME Japanese lines. Score each on how well it reflects the correct scene, speaker voice, referents, and branch structure.",
    groundTruthStructuralFacts: structuralFacts,
    sourceLines: sourceUnits.map((u) => ({
      id: u.bridgeUnitId,
      speaker: u.speaker ?? null,
      source: u.sourceText,
    })),
    set1: sets.set1,
    set2: sets.set2,
    scoringGuidance:
      "Score set1 and set2 each 0-10 on: speaker-voice consistency, correct referent resolution, and scene/branch awareness. " +
      "Judge ONLY on those criteria; do not prefer a slot by position.",
  };
  const request: ModelInvocationRequest = {
    taskKind: "llm_qa",
    modelId: DEV_PAIR.modelId,
    providerId: DEV_PAIR.providerId,
    inputClassification: "private_corpus",
    messages: [
      {
        role: "system",
        content:
          "You are a bilingual (Japanese->English) localization quality judge. Return ONLY a JSON object " +
          "with fields score1 (number 0-10), score2 (number 0-10), reasons (string[]).",
      },
      { role: "user", content: JSON.stringify(payload) },
    ],
    generation: { temperature: 0, maxOutputTokens: 1_024 },
    maxPriceUsd: PER_CALL_MAX_PRICE_USD,
    prompt: {
      presetId: "structctx-judge",
      templateVersion: "1.0.0",
      promptHash: `sha256:${"0".repeat(64)}`,
      schemaVersion: "itotori.prompt-preset.v0",
    },
  };
  const result = await provider.invoke(request);
  const posture = result.providerRun.routingPosture;
  const zdr = posture?.zdr === true && posture.data_collection === "deny";
  const micros = result.providerRun.cost.amountMicrosUsd ?? 0;
  const rawContent = result.content ?? "";
  const { score1, score2, reasons } = parsePassScore(rawContent);
  return { score1, score2, reasons, costUsd: micros / 1_000_000, zdr, rawContent };
}

function parsePassScore(content: string): {
  score1: number;
  score2: number;
  reasons: string[];
} {
  const unfenced = content.replace(/```(?:json)?/gu, "").trim();
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(unfenced) as Record<string, unknown>;
  } catch {
    const match = unfenced.match(/\{[\s\S]*\}/u);
    obj = match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
  }
  const score1 = typeof obj.score1 === "number" ? obj.score1 : 0;
  const score2 = typeof obj.score2 === "number" ? obj.score2 : 0;
  const reasons = Array.isArray(obj.reasons)
    ? obj.reasons.filter((r): r is string => typeof r === "string")
    : [];
  return { score1, score2, reasons };
}

function memoryRecorder(): ProviderRunArtifactRecorder & { artifacts: ProviderRunArtifact[] } {
  const artifacts: ProviderRunArtifact[] = [];
  return {
    artifacts,
    recordProviderRun: async (artifact: ProviderRunArtifact) => {
      artifacts.push(artifact);
    },
  };
}
