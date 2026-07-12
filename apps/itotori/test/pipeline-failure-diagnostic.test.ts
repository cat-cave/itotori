// itotori-agent-facing-pipeline-failure-diagnostics — tests.
//
// Proves the structured pipeline-failure-diagnostic surface:
//   (a) the redaction helper scrubs every game-text surface key with
//       `[REDACTED]` — no raw game text leaks into the diagnostic, ever;
//   (b) `runPipelineStepWithDiagnostic` converts a thrown error into a
//       `PipelineFailureDiagnosticError` carrying a complete diagnostic (step,
//       code, message, inputs, repro, error class + scrubbed message);
//   (c) `buildPipelineUnitFailureDiagnostic` builds a per-unit diagnostic that
//       names the failing bridge unit + scene + pair + stage;
//   (d) the localize-fullproject command wraps every pipeline step in the
//       helper — a FORCED failure at each step yields the diagnostic (not a
//       bare `Error`);
//   (e) the driven executor turns unexpected per-unit defects into a resumable
//       operational pause whose operator detail/evidence remain redacted;
//   (f) the diagnostic renders cleanly to a one-line log summary.
//
// All tests run WITHOUT a DB / live provider. The forced-failure path uses the
// FakeModelProvider + in-memory sinks (mirrors project-driven-executor.test.ts).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type BridgeBundleV02,
  type LocalizationUnitV02,
} from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "@itotori/db";
import {
  DEV_POLICY,
  fakeSemanticContextContent,
  type AgenticLoopProviderFactory,
} from "../src/orchestrator/agentic-loop.js";
import { DEV_PAIR } from "../src/providers/dev-pair.js";
import { FakeModelProvider } from "../src/providers/fake.js";
import type { ModelInvocationRequest } from "../src/providers/types.js";
import {
  runProjectDrivenExecutor,
  type DrivenFailedUnitJournalRecord,
  type DrivenPatchExportRecord,
  type DrivenUnitJournalRecord,
  type DrivenUnitContext,
} from "../src/orchestrator/project-driven-executor.js";
import {
  runLocalizeFullProjectCommand,
  type LocalizeFullProjectIo,
} from "../src/orchestrator/localize-fullproject-command.js";
import {
  buildPipelineFailureDiagnostic,
  buildPipelineUnitFailureDiagnostic,
  GAME_TEXT_KEYS,
  PipelineFailureDiagnosticError,
  REDACTED_SENTINEL,
  redactDiagnosticInputs,
  redactDiagnosticError,
  renderPipelineFailureDiagnosticOneLine,
  runPipelineStepWithDiagnostic,
  scrubGameTextFromString,
} from "../src/orchestrator/pipeline-failure-diagnostic.js";

// ---------------------------------------------------------------------------
// Game-text sentinel used to assert redaction is complete
// ---------------------------------------------------------------------------

const SECRET_SENTENCE = "禁忌の巫女姫は禁書庫で呪文を詠唱した";
const SECRET_SENTENCE_2 = "禁書庫にはもう誰もいない";

function expectRedactionComplete(value: unknown, secret: string = SECRET_SENTENCE): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(secret);
}

// ---------------------------------------------------------------------------
// Redaction helper tests — closed-set scrub of every game-text surface
// ---------------------------------------------------------------------------

describe("redactDiagnosticInputs (itotori-agent-facing-pipeline-failure-diagnostics)", () => {
  it("scrubs every key in the GAME_TEXT_KEYS taxonomy with the sentinel", () => {
    const sample: Record<string, unknown> = {};
    for (const key of GAME_TEXT_KEYS) {
      sample[key] = SECRET_SENTENCE;
    }
    sample.kept = "structural-id";
    sample.bridgeUnitId = "019ed0aa-0000-7000-8000-000000000001";
    sample.sceneId = 6010;

    const redacted = redactDiagnosticInputs(sample) as Record<string, unknown>;
    for (const key of GAME_TEXT_KEYS) {
      expect(redacted[key]).toBe(REDACTED_SENTINEL);
    }
    expect(redacted.kept).toBe("structural-id");
    expect(redacted.bridgeUnitId).toBe("019ed0aa-0000-7000-8000-000000000001");
    expect(redacted.sceneId).toBe(6010);
    expectRedactionComplete(redacted);
  });

  it("recurses into nested objects + arrays + source/target wrappers", () => {
    const nested = {
      bridgeUnit: {
        bridgeUnitId: "019ed0aa-0000-7000-8000-000000000001",
        sourceText: SECRET_SENTENCE,
        spans: [
          { refId: "s1", sourceText: SECRET_SENTENCE, expectedTargetForm: SECRET_SENTENCE_2 },
          { refId: "s2", refLabel: "another" },
        ],
        source: { sourceText: SECRET_SENTENCE, locale: "ja-JP" },
        target: { text: SECRET_SENTENCE_2, locale: "en-US" },
        metadata: {
          rationale: SECRET_SENTENCE,
          recommendation: SECRET_SENTENCE_2,
          sceneSummary: { summary: SECRET_SENTENCE },
        },
      },
    };
    const redacted = redactDiagnosticInputs(nested) as {
      bridgeUnit: {
        spans: Array<{ sourceText: string; expectedTargetForm: string; refLabel?: string }>;
        source: { sourceText: string };
        target: { text: string };
        metadata: { rationale: string; recommendation: string; sceneSummary: { summary: string } };
      };
    };
    expect(redacted.bridgeUnit.sourceText).toBe(REDACTED_SENTINEL);
    expect(redacted.bridgeUnit.spans[0]!.sourceText).toBe(REDACTED_SENTINEL);
    expect(redacted.bridgeUnit.spans[0]!.expectedTargetForm).toBe(REDACTED_SENTINEL);
    expect(redacted.bridgeUnit.spans[1]!.refLabel).toBe("another");
    expect(redacted.bridgeUnit.source.sourceText).toBe(REDACTED_SENTINEL);
    expect(redacted.bridgeUnit.source.locale).toBe("ja-JP");
    expect(redacted.bridgeUnit.target.text).toBe(REDACTED_SENTINEL);
    expect(redacted.bridgeUnit.target.locale).toBe("en-US");
    expect(redacted.bridgeUnit.metadata.rationale).toBe(REDACTED_SENTINEL);
    expect(redacted.bridgeUnit.metadata.recommendation).toBe(REDACTED_SENTINEL);
    expect(redacted.bridgeUnit.metadata.sceneSummary.summary).toBe(REDACTED_SENTINEL);
    expectRedactionComplete(redacted);
    expectRedactionComplete(redacted, SECRET_SENTENCE_2);
  });

  it("is idempotent — running redaction twice produces the same shape", () => {
    const sample = { sourceText: SECRET_SENTENCE, meta: { rationale: SECRET_SENTENCE_2 } };
    const once = redactDiagnosticInputs(sample) as Record<string, unknown>;
    const twice = redactDiagnosticInputs(once) as Record<string, unknown>;
    expect(twice).toEqual(once);
    expectRedactionComplete(twice);
    expectRedactionComplete(twice, SECRET_SENTENCE_2);
  });
});

describe("scrubGameTextFromString (itotori-agent-facing-pipeline-failure-diagnostics)", () => {
  it("replaces every literal in the known-game-text set with the sentinel", () => {
    const msg = `provider echoed back: ${SECRET_SENTENCE} and ${SECRET_SENTENCE_2} verbatim`;
    const scrubbed = scrubGameTextFromString(msg, [SECRET_SENTENCE, SECRET_SENTENCE_2]);
    expect(scrubbed).not.toContain(SECRET_SENTENCE);
    expect(scrubbed).not.toContain(SECRET_SENTENCE_2);
    expect(scrubbed).toContain(REDACTED_SENTINEL);
    expect(scrubbed).toContain("provider echoed back:");
  });

  it("is a no-op when no literals are supplied", () => {
    const msg = `raw game text: ${SECRET_SENTENCE}`;
    expect(scrubGameTextFromString(msg)).toBe(msg);
  });
});

describe("redactDiagnosticError (itotori-agent-facing-pipeline-failure-diagnostics)", () => {
  it("captures class + raw message verbatim when no literals supplied; stack only when requested", () => {
    const err = new Error(`malformed pack: ${SECRET_SENTENCE}`);
    err.name = "TranslationParseError";

    // No literals → no scrubbing (the builder widens the literal set from the
    // raw inputs; this helper is the LOW-LEVEL converter).
    const noStack = redactDiagnosticError(err);
    expect(noStack.class).toBe("TranslationParseError");
    expect(noStack.message).toContain(SECRET_SENTENCE);
    expect(noStack.stack).toBeUndefined();

    const withStack = redactDiagnosticError(err, true);
    expect(withStack.class).toBe("TranslationParseError");
    expect(withStack.message).toContain(SECRET_SENTENCE);
    expect(withStack.stack).toContain(SECRET_SENTENCE);
  });

  it("scoped literal scrub via scrubGameTextFromString erases game text", () => {
    const err = new Error(`malformed pack: ${SECRET_SENTENCE}`);
    err.name = "TranslationParseError";
    // The BUILDER wires `scrubGameTextFromString(err.message, literals)` after
    // `redactDiagnosticError` returns; verify that path here too so the test
    // pins the contract end-to-end.
    const raw = redactDiagnosticError(err);
    const scrubbedMessage = scrubGameTextFromString(raw.message, [SECRET_SENTENCE]);
    expect(scrubbedMessage).not.toContain(SECRET_SENTENCE);
    expect(scrubbedMessage).toContain(REDACTED_SENTINEL);
  });

  it("handles non-Error throws with the UnknownError sentinel", () => {
    const out = redactDiagnosticError("a string was thrown");
    expect(out.class).toBe("UnknownError");
    expect(out.message).toBe("a string was thrown");
  });
});

// ---------------------------------------------------------------------------
// Diagnostic builder + step helper — the structural contract
// ---------------------------------------------------------------------------

describe("buildPipelineFailureDiagnostic (itotori-agent-facing-pipeline-failure-diagnostics)", () => {
  it("produces a complete diagnostic: step + code + message + repro + redacted inputs", () => {
    const error = new Error(`provider echoed: ${SECRET_SENTENCE}`);
    error.name = "ProviderEchoError";

    const diag = buildPipelineFailureDiagnostic({
      step: "localize.read-bridge",
      code: "io-error",
      message: "localize.read-bridge failed",
      error,
      inputs: {
        bridgePath: "/scratch/bridge.json",
        sourceText: SECRET_SENTENCE, // scrubbed
      },
      repro: {
        configPath: "/scratch/config.json",
        bridgePath: "/scratch/bridge.json",
      },
      now: () => new Date("2026-07-07T00:00:00Z"),
    });

    expect(diag.step).toBe("localize.read-bridge");
    expect(diag.code).toBe("io-error");
    expect(diag.message).toBe("localize.read-bridge failed");
    expect(diag.repro.configPath).toBe("/scratch/config.json");
    expect(diag.repro.bridgePath).toBe("/scratch/bridge.json");
    expect(diag.error.class).toBe("ProviderEchoError");
    expect(diag.error.message).not.toContain(SECRET_SENTENCE);
    expect((diag.inputs as { bridgePath: string; sourceText: string }).sourceText).toBe(
      REDACTED_SENTINEL,
    );
    expect((diag.inputs as { bridgePath: string }).bridgePath).toBe("/scratch/bridge.json");
    expect(diag.occurredAt).toBe("2026-07-07T00:00:00.000Z");
    expect(diag.schemaVersion).toBe("itotori.pipeline-failure-diagnostic.v0");
    expectRedactionComplete(diag);
  });

  it("scrubs the error message when given known game-text literals", () => {
    const error = new Error(`provider echoed ${SECRET_SENTENCE} and ${SECRET_SENTENCE_2}`);
    const diag = buildPipelineFailureDiagnostic({
      step: "executor.drive-unit",
      code: "malformed-pack",
      message: "unit failed",
      error,
      knownGameTextLiterals: [SECRET_SENTENCE, SECRET_SENTENCE_2],
      repro: { bridgeUnitId: "u1" },
      failingUnitId: "u1",
      now: () => new Date("2026-07-07T00:00:00Z"),
    });
    expect(diag.error.message).not.toContain(SECRET_SENTENCE);
    expect(diag.error.message).not.toContain(SECRET_SENTENCE_2);
    expect(diag.error.message).toContain(REDACTED_SENTINEL);
    expect(diag.failingUnitId).toBe("u1");
    expect(diag.repro.bridgeUnitId).toBe("u1");
  });
});

describe("runPipelineStepWithDiagnostic (itotori-agent-facing-pipeline-failure-diagnostics)", () => {
  it("passes through successful results untouched", async () => {
    const out = await runPipelineStepWithDiagnostic({
      step: "localize.parse-config",
      message: "should not throw",
      repro: { configPath: "/x" },
      run: async () => ({ ok: true }),
    });
    expect(out).toEqual({ ok: true });
  });

  it("converts a thrown error into a structured PipelineFailureDiagnosticError", async () => {
    let caught: unknown;
    try {
      await runPipelineStepWithDiagnostic({
        step: "localize.parse-config",
        code: "refused",
        message: "localize.parse-config refused",
        repro: { configPath: "/x" },
        inputs: { configPath: "/x", sourceText: SECRET_SENTENCE },
        run: () => {
          throw new Error(`cannot parse: ${SECRET_SENTENCE}`);
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PipelineFailureDiagnosticError);
    const diag = (caught as PipelineFailureDiagnosticError).diagnostic;
    expect(diag.step).toBe("localize.parse-config");
    expect(diag.code).toBe("refused");
    expect(diag.message).toBe("localize.parse-config refused");
    expect(diag.error.class).toBe("Error");
    expect(diag.error.message).not.toContain(SECRET_SENTENCE);
    expect(diag.repro.configPath).toBe("/x");
    expectRedactionComplete(diag);
  });

  it("propagates an already-structured diagnostic untouched (specificity wins)", async () => {
    const inner = buildPipelineFailureDiagnostic({
      step: "executor.drive-unit",
      code: "malformed-pack",
      message: "inner",
      error: new Error("inner err"),
      repro: { bridgeUnitId: "u1" },
    });
    let caught: unknown;
    try {
      await runPipelineStepWithDiagnostic({
        step: "localize.run-journal",
        message: "outer",
        run: () => {
          throw new PipelineFailureDiagnosticError(inner);
        },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PipelineFailureDiagnosticError);
    expect((caught as PipelineFailureDiagnosticError).diagnostic).toBe(inner);
  });
});

describe("buildPipelineUnitFailureDiagnostic (itotori-agent-facing-pipeline-failure-diagnostics)", () => {
  it("produces a per-unit diagnostic naming the failing unit + scene + pair + stage", () => {
    const error = new Error(`agent loop threw: ${SECRET_SENTENCE}`);
    error.name = "AgenticLoopParseError";

    const diag = buildPipelineUnitFailureDiagnostic({
      bridgeUnitId: "019ed0aa-0000-7000-8000-0000000000d4",
      sourceUnitKey: "scene-6010/line-004",
      sceneId: 6010,
      unitInputs: {
        unit: {
          bridgeUnitId: "019ed0aa-0000-7000-8000-0000000000d4",
          sourceText: SECRET_SENTENCE,
          spans: [{ refId: "s1", sourceText: SECRET_SENTENCE }],
        },
      },
      error,
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
      stage: "translation",
      agentLabel: "translation-primary",
      knownGameTextLiterals: [SECRET_SENTENCE],
      now: () => new Date("2026-07-07T00:00:00Z"),
    });

    expect(diag.bridgeUnitId).toBe("019ed0aa-0000-7000-8000-0000000000d4");
    expect(diag.sourceUnitKey).toBe("scene-6010/line-004");
    expect(diag.sceneId).toBe(6010);
    expect(diag.step).toBe("executor.drive-unit");
    expect(diag.errorClass).toBe("AgenticLoopParseError");
    expect(diag.errorMessage).not.toContain(SECRET_SENTENCE);
    expect(diag.repro.sceneId).toBe(6010);
    expect(diag.repro.stage).toBe("translation");
    expect(diag.repro.agentLabel).toBe("translation-primary");
    expect(diag.repro.pair?.modelId).toBe(DEV_PAIR.modelId);
    expect(diag.schemaVersion).toBe("itotori.pipeline-failure-diagnostic.v0");
    expectRedactionComplete(diag);
  });
});

describe("renderPipelineFailureDiagnosticOneLine (itotori-agent-facing-pipeline-failure-diagnostics)", () => {
  it("renders a one-line summary naming step + unit + scene + error class", () => {
    const diag = buildPipelineFailureDiagnostic({
      step: "executor.drive-unit",
      code: "malformed-pack",
      message: "unit failed",
      error: new Error("bad pack"),
      failingUnitId: "u1",
      sceneId: 6010,
      repro: { bridgeUnitId: "u1" },
    });
    const line = renderPipelineFailureDiagnosticOneLine(diag);
    expect(line).toContain("[executor.drive-unit]");
    expect(line).toContain("code=malformed-pack");
    expect(line).toContain("unit=u1");
    expect(line).toContain("scene=6010");
    expect(line).toContain("error=Error: bad pack");
  });

  it("truncates long messages to the cap", () => {
    const diag = buildPipelineFailureDiagnostic({
      step: "localize.run-journal",
      code: "unknown",
      message: "long",
      error: new Error("x".repeat(1000)),
      repro: {},
    });
    const line = renderPipelineFailureDiagnosticOneLine(diag, 60);
    expect(line.length).toBeLessThanOrEqual(60);
    expect(line.endsWith("...")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration — the localize-fullproject command wraps each step in the helper
// ---------------------------------------------------------------------------

const ACTOR: AuthorizationActor = { userId: localUserId };
const PROJECT_ID = "019ed0dd-0000-7000-8000-000000000099";
const LOCALE_BRANCH_ID = "019ed0dd-0000-7000-8000-000000000098";
const REVISION_ID = "019ed0dd-0000-7000-8000-000000000097";
const ASSET_ID = "019ed0dd-0000-7000-8000-000000000096";
const SPEAKER_ID = "019ed0dd-0000-7000-8000-000000000095";

const UNIT_OK = "019ed0aa-0000-7000-8000-0000000000a1";
const UNIT_POISON = "019ed0aa-0000-7000-8000-0000000000d4";

const SCENE_ID = 6010;
const POISON_MARKER = "POISON_DIAGNOSTIC";
const POISON_GAME_TEXT = "禁書庫の封印を解く呪文は失われた";
const POISON_SCHEMA_FAILURE_DETAIL =
  "TranslationDraftResponseValidationError: StructuredTranslationDraftOutput.schemaVersion failed rule 'const': expected itotori.structured-translation-draft-output.v1, got totally.wrong.v0";
const POISON_BLOCKER_DETAIL = `InvocationSupervisor hard retry ceiling 12 reached after schema_invalid: ${POISON_SCHEMA_FAILURE_DETAIL}`;
const POISON_BLOCKER_EVIDENCE = `schema_invalid:${POISON_SCHEMA_FAILURE_DETAIL}`;
const POISON_OPERATOR_ACTION = "fix the model/tool/schema configuration, then resume";

function makeUnit(
  bridgeUnitId: string,
  sourceText: string,
  surfaceKind: LocalizationUnitV02["surfaceKind"],
  lineNo: number,
): LocalizationUnitV02 {
  const key = `scene-${SCENE_ID}/line-${String(lineNo).padStart(3, "0")}`;
  return {
    bridgeUnitId,
    surfaceId: ASSET_ID,
    surfaceKind,
    sourceUnitKey: key,
    occurrenceId: `occ-${lineNo}`,
    sourceLocale: "ja-JP",
    sourceText,
    sourceHash: `src-hash-${bridgeUnitId}`,
    sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "asset" },
    sourceLocation: { containerKey: "asset" },
    speaker: { knowledgeState: "known", speakerId: SPEAKER_ID, displayName: "和人" },
    context: { route: { sceneId: String(SCENE_ID) } },
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: key,
      sourceRevision: { revisionId: REVISION_ID, revisionKind: "content_hash", value: "rev" },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function makeBridge(): BridgeBundleV02 {
  const units: LocalizationUnitV02[] = [
    makeUnit(UNIT_OK, "おはよう。", "dialogue", 1),
    makeUnit(UNIT_POISON, `${POISON_MARKER} ${POISON_GAME_TEXT}`, "dialogue", 4),
  ];
  return {
    schemaVersion: "0.2.0",
    bridgeId: "diag-fixture",
    sourceLocale: "ja-JP",
    units,
  } as unknown as BridgeBundleV02;
}

function bridgeUnitIdOf(request: ModelInvocationRequest): string {
  const blob = JSON.stringify(request);
  const match = blob.match(/019ed0aa-[0-9a-f]{4}-7000-8000-[0-9a-f]{12}/u);
  if (match === null) {
    throw new Error("fake provider could not locate a bridge unit id in the request");
  }
  return match[0];
}

function speakerLabelContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "fake-narration",
      },
    ],
  });
}

function translationContent(bridgeUnitId: string): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId,
        sourceLocale: "ja-JP",
        targetLocale: "en-US",
        draftText: "Good morning.",
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "fake-translation",
        confidenceFloor: "medium",
      },
    ],
  });
}

function cleanQaContent(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [],
  });
}

function diagProviderFactory(): AgenticLoopProviderFactory {
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `diag-fake-${stage}-${agentLabel}`,
      generate: (request: ModelInvocationRequest): string => {
        const blob = JSON.stringify(request);
        if (request.taskKind === "experiment" && agentLabel !== "speaker-label") {
          return fakeSemanticContextContent(agentLabel);
        }
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return speakerLabelContent(bridgeUnitIdOf(request));
        }
        if (request.taskKind === "draft_translation") {
          if (blob.includes(POISON_MARKER)) {
            // Malformed pack — wrong schemaVersion; throws on parse.
            return JSON.stringify({ schemaVersion: "totally.wrong.v0", drafts: [] });
          }
          return translationContent(bridgeUnitIdOf(request));
        }
        if (request.taskKind === "llm_qa") {
          return cleanQaContent();
        }
        return "";
      },
    });
}

class InMemorySinks {
  readonly journalUnits: DrivenUnitJournalRecord[] = [];
  readonly failedUnitAttempts: DrivenFailedUnitJournalRecord[] = [];
  readonly patchExports: DrivenPatchExportRecord[] = [];
  readonly journal = {
    // The executor fails closed without admission even for uncapped tests.
    // This fixture intentionally models an admitted durable account while the
    // test exercises unrelated diagnostic/error paths.
    createCostAdmission: () => ({ admit: async () => ({ admitted: true as const }) }),
    persistUnitJournal: async (record: DrivenUnitJournalRecord): Promise<void> => {
      this.journalUnits.push(record);
    },
    persistFailedUnitAttempts: async (record: DrivenFailedUnitJournalRecord): Promise<void> => {
      this.failedUnitAttempts.push(record);
    },
  };
  readonly patchExport = {
    exportPatch: async (record: DrivenPatchExportRecord): Promise<void> => {
      this.patchExports.push(record);
    },
  };
}

class InMemoryReviewerQueue {
  readonly items: Array<{ sourceItemRef: string }> = [];
  async createItem(): Promise<never> {
    throw new Error("not used");
  }
  async loadItemsByBranch(): Promise<Array<{ sourceItemRef: string }>> {
    return this.items;
  }
}

function fsIo(): LocalizeFullProjectIo {
  return {
    readJson: (path) => JSON.parse(require("node:fs").readFileSync(path, "utf8")) as unknown,
    writeJson: (path, value) =>
      require("node:fs").writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`),
  };
}

function materializeProject(dir: string): { configPath: string } {
  const bridgePath = join(dir, "bridge.json");
  const pairPolicyPath = join(dir, "pair-policy.json");
  const configPath = join(dir, "localize.config.json");
  writeFileSync(bridgePath, JSON.stringify(makeBridge()));
  const pairPolicyFixture = new URL(
    "./fixtures/agentic-loop-smoke-pair-policy.json",
    import.meta.url,
  );
  writeFileSync(pairPolicyPath, require("node:fs").readFileSync(pairPolicyFixture, "utf8"));
  const config = {
    schemaVersion: "itotori.localize-fullproject.config.v0",
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceRevisionId: REVISION_ID,
    engineProfile: "reallive",
    translationScope: "dialogue-only",
    targetLocale: "en-US",
    bridgePath,
    pairPolicyPath,
    maxRepairAttempts: 0,
  };
  writeFileSync(configPath, JSON.stringify(config));
  return { configPath };
}

describe("runLocalizeFullProjectCommand (itotori-agent-facing-pipeline-failure-diagnostics)", () => {
  it("localize.parse-config failure: throws a structured diagnostic naming step + repro", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "itotori-diag-parse-config-"));
    let caught: unknown;
    try {
      await runLocalizeFullProjectCommand({
        configPath: join(workDir, "missing.json"),
        runSummaryPath: join(workDir, "run-summary.json"),
        deps: makeDeps(),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PipelineFailureDiagnosticError);
    const diag = (caught as PipelineFailureDiagnosticError).diagnostic;
    expect(diag.step).toBe("localize.parse-config");
    expect(diag.code).toBe("refused");
    expect(diag.repro.configPath).toBe(join(workDir, "missing.json"));
    expect(diag.error.class).toBe("Error");
    expect(typeof diag.error.message).toBe("string");
    expect(diag.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expectRedactionComplete(diag);
  });

  it("localize.read-bridge failure: throws a structured diagnostic naming step + repro", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "itotori-diag-read-bridge-"));
    const configPath = join(workDir, "localize.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: "itotori.localize-fullproject.config.v0",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: REVISION_ID,
        engineProfile: "reallive",
        bridgePath: join(workDir, "missing-bridge.json"),
        pairPolicyPath: join(workDir, "pair-policy.json"),
      }),
    );
    // Pair policy path also missing — we expect the bridge step to fail first
    // since the config parses OK.
    let caught: unknown;
    try {
      await runLocalizeFullProjectCommand({
        configPath,
        runSummaryPath: join(workDir, "run-summary.json"),
        deps: makeDeps(),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PipelineFailureDiagnosticError);
    const diag = (caught as PipelineFailureDiagnosticError).diagnostic;
    expect(diag.step).toBe("localize.read-bridge");
    expect(diag.code).toBe("io-error");
    expect(diag.repro.bridgePath).toBe(join(workDir, "missing-bridge.json"));
    expectRedactionComplete(diag);
  });

  it("executor.drive-unit defect: pauses the run without creating a terminal unit failure", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "itotori-diag-poison-"));
    const { configPath } = materializeProject(workDir);
    const sinks = new InMemorySinks();
    const queue = new InMemoryReviewerQueue();
    const io = fsIo();

    const out = await runLocalizeFullProjectCommand({
      configPath,
      runSummaryPath: join(workDir, "run-summary.json"),
      deps: {
        io,
        actor: ACTOR,
        providerFactory: diagProviderFactory(),
        sinks: {
          journal: sinks.journal,
          patchExport: sinks.patchExport,
        },
        reviewerQueue: { repository: queue as never },
      },
    });

    expect(out.result.failures).toEqual([]);
    expect(out.result.runState).toBe("paused");
    expect(out.result.pausedBlocker).toMatchObject({
      kind: "itotori_bug",
      detail: POISON_BLOCKER_DETAIL,
      evidence: POISON_BLOCKER_EVIDENCE,
      operatorAction: POISON_OPERATOR_ACTION,
    });
    expect(out.result.pausedBlocker?.raisedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expectRedactionComplete(out.result.pausedBlocker, POISON_GAME_TEXT);
    expect(sinks.patchExports).toEqual([]);
  });

  it("operator pause detail and evidence stay one-line, exact, and free of game text", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "itotori-diag-render-"));
    const { configPath } = materializeProject(workDir);
    const sinks = new InMemorySinks();
    const queue = new InMemoryReviewerQueue();
    const io = fsIo();

    const out = await runLocalizeFullProjectCommand({
      configPath,
      runSummaryPath: join(workDir, "run-summary.json"),
      deps: {
        io,
        actor: ACTOR,
        providerFactory: diagProviderFactory(),
        sinks: {
          journal: sinks.journal,
          patchExport: sinks.patchExport,
        },
        reviewerQueue: { repository: queue as never },
      },
    });
    const blocker = out.result.pausedBlocker;
    expect(out.result.failures).toEqual([]);
    expect(out.result.runState).toBe("paused");
    expect(blocker?.kind).toBe("itotori_bug");
    expect(blocker?.detail).toBe(POISON_BLOCKER_DETAIL);
    expect(blocker?.evidence).toBe(POISON_BLOCKER_EVIDENCE);
    expect(blocker?.operatorAction).toBe(POISON_OPERATOR_ACTION);
    expect(blocker?.detail).not.toMatch(/[\r\n]/u);
    expect(blocker?.evidence).not.toMatch(/[\r\n]/u);
    expectRedactionComplete(blocker, POISON_GAME_TEXT);
    expect(sinks.patchExports).toEqual([]);
  });
});

function makeDeps() {
  const io = fsIo();
  const sinks = new InMemorySinks();
  return {
    io,
    actor: ACTOR,
    providerFactory: diagProviderFactory(),
    sinks: {
      journal: sinks.journal,
      patchExport: sinks.patchExport,
    },
  };
}

// ---------------------------------------------------------------------------
// Driven executor — unexpected per-unit defects pause instead of terminalizing
// ---------------------------------------------------------------------------

describe("runProjectDrivenExecutor (itotori-agent-facing-pipeline-failure-diagnostics)", () => {
  it("leaves a poison unit pending and returns an actionable operational pause", async () => {
    const sinks = new InMemorySinks();
    const bridge = makeBridge();
    const result = await runProjectDrivenExecutor({
      bridge,
      rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
      pairPolicy: DEV_POLICY,
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      sourceRevisionId: REVISION_ID,
      actor: ACTOR,
      providerFactory: diagProviderFactory(),
      maxRepairAttempts: 0,
      resolveUnitContext: (): DrivenUnitContext | undefined => undefined,
      translationScope: "dialogue-only",
      engineProfile: "reallive",
      sinks,
    });

    expect(result.failures).toEqual([]);
    expect(result.runState).toBe("paused");
    expect(result.pausedBlocker).toMatchObject({
      kind: "itotori_bug",
      detail: POISON_BLOCKER_DETAIL,
      evidence: POISON_BLOCKER_EVIDENCE,
      operatorAction: POISON_OPERATOR_ACTION,
    });
    expectRedactionComplete(result.pausedBlocker, POISON_GAME_TEXT);
    expect(sinks.journalUnits.map((record) => record.writtenOutcome.bridgeUnitId)).toEqual([
      UNIT_OK,
    ]);
    expect(sinks.patchExports).toEqual([]);
  });

  it("keeps exact redacted blocker detail while retaining non-terminal attempt evidence", async () => {
    const sinks = new InMemorySinks();
    const bridge = makeBridge();
    const result = await runProjectDrivenExecutor({
      bridge,
      rawBridge: JSON.parse(JSON.stringify(bridge)) as unknown,
      pairPolicy: DEV_POLICY,
      pair: { modelId: DEV_PAIR.modelId, providerId: DEV_PAIR.providerId },
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      sourceRevisionId: REVISION_ID,
      actor: ACTOR,
      providerFactory: diagProviderFactory(),
      maxRepairAttempts: 0,
      resolveUnitContext: (): DrivenUnitContext | undefined => undefined,
      translationScope: "dialogue-only",
      engineProfile: "reallive",
      sinks,
    });

    expect(result.failures).toEqual([]);
    expect(result.runState).toBe("paused");
    expect(result.pausedBlocker?.kind).toBe("itotori_bug");
    expect(result.pausedBlocker?.detail).toBe(POISON_BLOCKER_DETAIL);
    expect(result.pausedBlocker?.evidence).toBe(POISON_BLOCKER_EVIDENCE);
    expect(result.pausedBlocker?.operatorAction).toBe(POISON_OPERATOR_ACTION);
    expectRedactionComplete(result.pausedBlocker, POISON_GAME_TEXT);
    expect(sinks.failedUnitAttempts).toHaveLength(1);
    expect(sinks.failedUnitAttempts[0]?.bridgeUnitId).toBe(UNIT_POISON);
    expect(sinks.failedUnitAttempts[0]?.attempts.at(-1)).toMatchObject({
      failureClass: "schema_invalid",
      validationResult: "schema_invalid",
    });
    expect(sinks.patchExports).toEqual([]);
  });
});
