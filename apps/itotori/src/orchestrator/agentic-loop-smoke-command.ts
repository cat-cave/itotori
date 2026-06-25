// ITOTORI-222 — `itotori:agentic-loop-smoke` CLI handler.
//
// Wraps `runAgenticLoopForUnit` behind the CLI command the spec
// names:
//
//   pnpm exec vp run itotori:agentic-loop-smoke \
//       --bridge <in>.json \
//       --unit-index 0 \
//       --pair-policy <policy>.json \
//       --output <out>.json
//
// The command refuses to invoke a live provider — every smoke run
// uses a synthetic FakeModelProvider that emits structurally-correct
// content per stage. This keeps the smoke command useful in CI
// without a network dependency. Live runs are wired separately at
// the orchestrator entry point.

import type { AuthorizationActor } from "@itotori/db";
import {
  assertAgenticLoopBundle,
  assertDraftArtifactBundle,
  parsePairPolicyV02,
  DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  type AgenticLoopBundle,
  type BridgeBundleV02,
  type DraftArtifactBundle,
  type LocalizationUnitV02,
  STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
} from "@itotori/localization-bridge-schema";
import { DEFAULT_COST_CAP_USD } from "../providers/openrouter.js";
import { FakeModelProvider } from "../providers/fake.js";
import type { ModelInvocationRequest } from "../providers/types.js";
import {
  runAgenticLoopForUnit,
  type AgenticLoopPolicy,
  type AgenticLoopProviderFactory,
  type AgenticLoopUnitInput,
  type PairPolicy,
} from "./agentic-loop.js";

export type AgenticLoopSmokeIo = {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
};

export type AgenticLoopSmokeArgs = {
  bridgePath: string;
  unitIndex: number;
  pairPolicyPath: string;
  outputPath: string;
  io: AgenticLoopSmokeIo;
  actor: AuthorizationActor;
  log?: (message: string) => void;
  /**
   * Maximum repair attempts the loop is allowed. Defaults to 1.
   * The smoke command never exposes a runtime tunable beyond this —
   * production callers wire the orchestrator directly.
   */
  maxRepairAttempts?: number;
  /**
   * Optional second output path. When provided, the smoke command
   * also writes a `DraftArtifactBundle` derived from the loop's
   * final-draft stage so downstream consumers (e.g. `export-patch-v2`)
   * have a v1 draft-artifact wire shape on disk alongside the
   * AgenticLoopBundle. Useful for hello-patch which still consumes
   * a DraftArtifactBundle.
   */
  draftArtifactOutputPath?: string;
};

export class AgenticLoopSmokeLiveProviderRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgenticLoopSmokeLiveProviderRefusalError";
  }
}

export class AgenticLoopSmokeUnitIndexError extends Error {
  constructor(
    public readonly unitIndex: number,
    public readonly unitCount: number,
  ) {
    super(
      `agentic-loop-smoke refused: --unit-index ${unitIndex} out of range; bridge has ${unitCount} unit(s)`,
    );
    this.name = "AgenticLoopSmokeUnitIndexError";
  }
}

export async function runAgenticLoopSmokeCommand(
  args: AgenticLoopSmokeArgs,
): Promise<AgenticLoopBundle> {
  if (process.env.ITOTORI_LIVE_PROVIDER === "1") {
    throw new AgenticLoopSmokeLiveProviderRefusalError(
      "agentic-loop-smoke refused: ITOTORI_LIVE_PROVIDER=1; the smoke command never invokes a live provider",
    );
  }
  const log = args.log ?? (() => {});

  const rawBridge = args.io.readJson(args.bridgePath);
  const bridge = assertBridgeBundleV02(rawBridge);
  if (bridge.units.length === 0) {
    throw new AgenticLoopSmokeUnitIndexError(args.unitIndex, 0);
  }
  if (args.unitIndex < 0 || args.unitIndex >= bridge.units.length) {
    throw new AgenticLoopSmokeUnitIndexError(args.unitIndex, bridge.units.length);
  }
  const unit = bridge.units[args.unitIndex];
  if (unit === undefined) {
    throw new AgenticLoopSmokeUnitIndexError(args.unitIndex, bridge.units.length);
  }
  log(`agentic-loop-smoke: bridge=${args.bridgePath} unitIndex=${args.unitIndex}`);

  const rawPolicy = args.io.readJson(args.pairPolicyPath);
  const pairPolicy = assertPairPolicy(rawPolicy);
  log(`agentic-loop-smoke: pair-policy=${args.pairPolicyPath}`);

  const policy: AgenticLoopPolicy = {
    projectId: deriveProjectId(bridge),
    localeBranchId: deriveLocaleBranchId(bridge, unit),
    sourceLocale: bridge.sourceLocale,
    targetLocale: deriveTargetLocale(unit),
    maxRepairAttempts: args.maxRepairAttempts ?? 1,
    now: deterministicNow(),
  };

  const factory = smokeProviderFactory(unit, policy);
  const input: AgenticLoopUnitInput = {
    unit,
    sceneUnits: [],
    glossary: [],
    protectedSpans: [],
    knownCharacters: [],
    actor: args.actor,
  };
  const bundle = await runAgenticLoopForUnit(input, pairPolicy, policy, factory);
  assertAgenticLoopBundle(bundle);
  args.io.writeJson(args.outputPath, bundle);
  log(`agentic-loop-smoke: wrote ${args.outputPath}`);

  if (args.draftArtifactOutputPath !== undefined) {
    const draftArtifact = toDraftArtifactBundle(bundle, unit, policy);
    assertDraftArtifactBundle(draftArtifact);
    args.io.writeJson(args.draftArtifactOutputPath, draftArtifact);
    log(`agentic-loop-smoke: wrote draft-artifact ${args.draftArtifactOutputPath}`);
  }
  return bundle;
}

/**
 * Project the AgenticLoopBundle's final-draft slice into the legacy
 * `DraftArtifactBundle.v1` wire shape so consumers that still expect
 * a DraftArtifactBundle (e.g. export-patch-v2) keep working.
 *
 * The projection commits to one entry per unit (the smoke command
 * runs on a single unit by design). Token / cost totals come from
 * the AgenticLoopBundle's stage roll-ups.
 */
function toDraftArtifactBundle(
  bundle: AgenticLoopBundle,
  unit: LocalizationUnitV02,
  _policy: AgenticLoopPolicy,
): DraftArtifactBundle {
  const ledgerProofIds: string[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostMicros = 0n;
  for (const stage of bundle.stages) {
    totalTokensIn += stage.tokensIn;
    totalTokensOut += stage.tokensOut;
    for (const invocation of stage.invocations) {
      ledgerProofIds.push(invocation.providerProofId);
      totalCostMicros += amountToMicros(invocation.costUsd);
    }
  }
  const proofId = ledgerProofIds[0] ?? `agentic-loop-smoke:${bundle.bridgeUnitId}:proof`;
  const ledgerEntryRef = `agentic-loop-smoke:${bundle.bridgeUnitId}:ledger`;
  const draftJobId = `agentic-loop-${bundle.bridgeUnitId}-job`;
  const deferred = bundle.finalDraft.draftText === undefined;
  return {
    schemaVersion: DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    draftJobId,
    projectId: bundle.projectId,
    localeBranchId: bundle.localeBranchId,
    drafts: [
      deferred
        ? {
            sourceUnitId: unit.bridgeUnitId,
            draftId: `draft-${ledgerEntryRef}-${unit.bridgeUnitId}`,
            providerProofId: proofId,
            protectedSpanValidationResult: { accepted: true },
            retryFallbackState: "terminal-rejection",
            costLedgerEntryRef: ledgerEntryRef,
            terminalReason: bundle.finalDraft.deferredReason ?? "agentic loop deferred to human",
          }
        : {
            sourceUnitId: unit.bridgeUnitId,
            draftId: `draft-${ledgerEntryRef}-${unit.bridgeUnitId}`,
            providerProofId: proofId,
            protectedSpanValidationResult: { accepted: true },
            retryFallbackState:
              bundle.routingSummary.outcome === "repaired_then_accepted"
                ? "retried-then-success"
                : "success",
            costLedgerEntryRef: ledgerEntryRef,
            draftText: bundle.finalDraft.draftText ?? "",
          },
    ],
    ledgerSummary: {
      totalCost: microsToDecimal(totalCostMicros),
      totalTokensIn,
      totalTokensOut,
      attemptCount: ledgerProofIds.length,
      providerProofIds: ledgerProofIds.length > 0 ? ledgerProofIds : [proofId],
    },
  };
}

function amountToMicros(amount: string): bigint {
  const [whole, fractional = "0"] = amount.split(".");
  const wholeBig = BigInt(whole ?? "0");
  const padded = (fractional + "000000").slice(0, 6);
  return wholeBig * 1_000_000n + BigInt(padded);
}

function microsToDecimal(micros: bigint): string {
  const sign = micros < 0n ? "-" : "";
  const abs = micros < 0n ? -micros : micros;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${sign}${whole.toString()}.${frac}00`;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertBridgeBundleV02(value: unknown): BridgeBundleV02 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("agentic-loop-smoke refused: bridge file must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "0.2.0") {
    throw new Error(
      `agentic-loop-smoke refused: bridge schemaVersion must be '0.2.0' (got ${String(record.schemaVersion)})`,
    );
  }
  // Trust the wider schema asserter chain to validate the rest; we only
  // need the unit + locale slice for the smoke command.
  return value as BridgeBundleV02;
}

function assertPairPolicy(value: unknown): PairPolicy {
  // ITOTORI-234 — smoke command parses the v0.2 pair-policy through the
  // shared parser so per-stage posture (zdr / fallback / seed) is
  // resolved deterministically. The smoke fixture is a v0.2 file; old
  // v0.1 fixtures are no longer accepted (PairPolicyVersionMismatchError).
  const parsed = parsePairPolicyV02(value, {
    defaultCostCapUsd: DEFAULT_COST_CAP_USD,
    zdrDowngradeEnv: process.env.OPENROUTER_ZDR_DOWNGRADE,
  });
  return parsed.stages;
}

// ---------------------------------------------------------------------------
// Helpers — derived project / locale / provider data
// ---------------------------------------------------------------------------

function deriveProjectId(bridge: BridgeBundleV02): string {
  return bridge.bridgeId;
}

function deriveLocaleBranchId(_bridge: BridgeBundleV02, unit: LocalizationUnitV02): string {
  // The bridge bundle ships no locale-branch id; we synthesize a
  // deterministic placeholder from the unit's sourceRevision.
  return `branch:${unit.sourceRevision.revisionId}`;
}

function deriveTargetLocale(unit: LocalizationUnitV02): string {
  // The bridge bundle is mono-locale at v0.2 (source-only). The smoke
  // command defaults the target locale to en-US — production callers
  // pass an explicit policy.
  if (unit.sourceLocale.startsWith("en")) {
    return "ja-JP";
  }
  return "en-US";
}

function deterministicNow(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

// ---------------------------------------------------------------------------
// Smoke provider — emits structurally-correct content for every stage.
// Mirrors what the test factory in agentic-loop.test.ts uses so the
// smoke command can run end-to-end without external dependencies.
// ---------------------------------------------------------------------------

function smokeProviderFactory(
  unit: LocalizationUnitV02,
  policy: AgenticLoopPolicy,
): AgenticLoopProviderFactory {
  const draftText = synthesizeDraftText(unit, policy.targetLocale);
  return ({ stage, agentLabel }) =>
    new FakeModelProvider({
      providerName: `agentic-loop-smoke:${stage}:${agentLabel}`,
      generate: (request: ModelInvocationRequest) => {
        if (request.taskKind === "experiment" && agentLabel === "speaker-label") {
          return makeSmokeSpeakerLabel(unit);
        }
        if (request.taskKind === "experiment") {
          return `agentic-loop-smoke:context:${agentLabel}`;
        }
        if (request.taskKind === "draft_translation") {
          return makeSmokeTranslation(unit, draftText, policy);
        }
        if (request.taskKind === "llm_qa") {
          return makeSmokeQa();
        }
        return "";
      },
    });
}

function synthesizeDraftText(unit: LocalizationUnitV02, targetLocale: string): string {
  return `[${targetLocale}] ${unit.sourceText}`;
}

function makeSmokeSpeakerLabel(unit: LocalizationUnitV02): string {
  return JSON.stringify({
    schemaVersion: SPEAKER_LABEL_OUTPUT_SCHEMA_VERSION,
    labels: [
      {
        bridgeUnitId: unit.bridgeUnitId,
        speakerId: { kind: "narration" },
        confidence: "high",
        evidenceRefs: [],
        agentRationale: "agentic-loop-smoke narration",
      },
    ],
  });
}

function makeSmokeTranslation(
  unit: LocalizationUnitV02,
  draftText: string,
  policy: AgenticLoopPolicy,
): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    drafts: [
      {
        bridgeUnitId: unit.bridgeUnitId,
        sourceLocale: unit.sourceLocale,
        targetLocale: policy.targetLocale,
        draftText,
        protectedSpanRefs: [],
        citationRefs: [],
        agentRationale: "agentic-loop-smoke translation",
        confidenceFloor: "medium",
      },
    ],
  });
}

function makeSmokeQa(): string {
  return JSON.stringify({
    schemaVersion: STRUCTURED_QA_FINDING_OUTPUT_SCHEMA_VERSION,
    findings: [],
  });
}
