// m1-wholegame-replay-render-validate — post-patch whole-game runtime signal.
//
// The single-unit suite runner already replays and render-validates patched
// bytes, but the whole-game driver stopped at patch apply. This seam validates
// the PATCHED whole-game output for EVERY accepted unit (render-validate is
// one-message-per-invocation, so a silent one-per-scene de-dupe would leave
// later accepted lines in the same scene unproven). Optional unit caps must be
// honestly logged. Findings are project-agnostic and the pass ledger carries
// them into pass N+1.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NativeCliRunner } from "../native-bin/cli-bin-resolver.js";
import { runNativeCli } from "../native-bin/cli-bin-resolver.js";
import {
  buildPipelineFailureDiagnostic,
  type PipelineFailureDiagnostic,
} from "./pipeline-failure-diagnostic.js";
import type { DrivenPatchReport } from "./project-driven-executor.js";

export type WholeGameValidationPhase = "replay-validate" | "render-validate";

export type WholeGameRenderValidationFinding = {
  phase: WholeGameValidationPhase;
  bridgeUnitId: string;
  sourceUnitKey: string;
  sceneId: number;
  code: "native-cli-failed" | "render-target-ambiguous";
  message: string;
  diagnostic: PipelineFailureDiagnostic;
  artifactRefs: {
    replayLog?: string;
    renderEvidence?: string;
  };
};

export type WholeGameRenderValidationCoverage = {
  acceptedUnitCount: number;
  /** Accepted units that were candidates for validation (before any sample cap). */
  candidateUnitCount: number;
  /** Accepted units actually validated (after optional sample cap). */
  selectedUnitCount: number;
  /** Distinct scenes among candidate units. */
  candidateSceneCount: number;
  /** Distinct scenes among selected (validated) units. */
  validatedSceneCount: number;
  sampled: boolean;
  /** Optional honest unit-sample cap that produced `sampled: true`. */
  maxUnits?: number;
  sceneIds: number[];
  selectedUnitIds: string[];
  skippedUnitIds: string[];
};

export type WholeGameRenderValidationResult = {
  schemaVersion: "itotori.wholegame-render-validation.v0";
  redaction: "on" | "off";
  coverage: WholeGameRenderValidationCoverage;
  findings: WholeGameRenderValidationFinding[];
};

export type RunWholeGameReplayRenderValidateArgs = {
  rawBridge: unknown;
  patchReport: DrivenPatchReport;
  /** Read-only source game root used for Gameexe/assets/source Seen. */
  sourceRoot: string;
  /** Patched target root produced by kaifuu patch. */
  targetRoot: string;
  /** Directory where replay logs + render evidence are written. */
  artifactRoot: string;
  redaction?: "on" | "off";
  /**
   * Optional honest unit-sample cap for cost. Omit to validate every accepted
   * unit. When set, covered vs skipped unit ids are logged + recorded.
   */
  maxUnits?: number;
  /**
   * @deprecated Prefer `maxUnits`. Kept as a synonym so older callers still
   * apply an honest unit-level sample (not a silent per-scene de-dupe).
   */
  maxScenes?: number;
  nativeCli?: NativeCliRunner;
  log?: (message: string) => void;
};

type ValidationTarget = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sceneId: number;
  /** Zero-based play-order message index within the scene. */
  messageIndex: number;
  expectedTextContains: string;
};

type AmbiguousValidationTarget = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sceneId: number;
  expectedTextContains: string;
  reason: string;
};

type ValidationTargetSelection = {
  targets: ValidationTarget[];
  ambiguous: AmbiguousValidationTarget[];
};

type ProcessFailure = {
  phase: WholeGameValidationPhase;
  status: number | null;
  stdout: string;
  stderr: string;
};

export function runWholeGameReplayRenderValidate(
  args: RunWholeGameReplayRenderValidateArgs,
): WholeGameRenderValidationResult {
  const log = args.log ?? (() => {});
  const redaction = args.redaction ?? "on";
  const targetSelection = validationTargetsForPatchReport(args.rawBridge, args.patchReport);
  const allTargets = targetSelection.targets;
  const maxUnits = args.maxUnits ?? args.maxScenes;
  const selectedTargets =
    maxUnits === undefined ? allTargets : allTargets.slice(0, Math.max(0, maxUnits));
  const sampled = selectedTargets.length < allTargets.length;
  const selectedIds = new Set(selectedTargets.map((target) => target.bridgeUnitId));
  const skippedTargets = allTargets.filter((target) => !selectedIds.has(target.bridgeUnitId));
  const selectedUnitIds = selectedTargets.map((target) => target.bridgeUnitId);
  const ambiguousUnitIds = targetSelection.ambiguous.map((target) => target.bridgeUnitId);
  const skippedUnitIds = [
    ...skippedTargets.map((target) => target.bridgeUnitId),
    ...ambiguousUnitIds,
  ];
  const candidateSceneIds = uniqueSceneIds(allTargets);
  const selectedSceneIds = uniqueSceneIds(selectedTargets);

  log(
    `wholegame-render-validate: validating ${selectedTargets.length}/${allTargets.length} accepted unit(s) ` +
      `across ${selectedSceneIds.length}/${candidateSceneIds.length} scene(s)` +
      (sampled
        ? ` (maxUnits=${String(maxUnits)}; sampled cap logged; covered=[${selectedUnitIds.join(",")}]; skipped=[${skippedUnitIds.join(",")}] reason=cost-cap)`
        : "") +
      (targetSelection.ambiguous.length > 0
        ? ` ambiguous-not-individually-render-validated=[${ambiguousUnitIds.join(",")}]`
        : ""),
  );

  const findings: WholeGameRenderValidationFinding[] = targetSelection.ambiguous.map((target) =>
    findingForAmbiguousTarget({
      target,
      sourceRoot: args.sourceRoot,
      targetRoot: args.targetRoot,
    }),
  );
  for (const target of selectedTargets) {
    const paths = artifactPaths(args.artifactRoot, target);
    mkdirSync(paths.sceneArtifactRoot, { recursive: true });
    const seenPath = join(args.targetRoot, "REALLIVEDATA", "Seen.txt");
    const sourceSeenPath = join(args.sourceRoot, "REALLIVEDATA", "Seen.txt");
    const gameDir = join(args.sourceRoot, "REALLIVEDATA");
    const gameexePath = join(gameDir, "Gameexe.ini");
    const scene = String(target.sceneId);

    const replay = runNativeCli(
      "utsushi-cli",
      [
        "replay-validate",
        "--engine",
        "reallive",
        "--seen",
        seenPath,
        "--scene",
        scene,
        "--print-replay-log",
        paths.replayLog,
      ],
      args.nativeCli,
    );
    if (replay.status !== 0) {
      findings.push(
        findingForFailure({
          target,
          paths,
          failure: { phase: "replay-validate", ...replay },
          sourceRoot: args.sourceRoot,
          targetRoot: args.targetRoot,
          expectedTextContains: target.expectedTextContains,
        }),
      );
      continue;
    }

    const render = runNativeCli(
      "utsushi-cli",
      [
        "render-validate",
        "--engine",
        "reallive",
        "--seen",
        seenPath,
        "--scene",
        scene,
        "--gameexe",
        gameexePath,
        "--game-dir",
        gameDir,
        "--artifact-root",
        paths.sceneArtifactRoot,
        "--redaction",
        redaction,
        "--output",
        paths.renderEvidence,
        "--source-seen",
        sourceSeenPath,
        "--expect-text-contains",
        target.expectedTextContains,
        "--message-index",
        String(target.messageIndex),
      ],
      args.nativeCli,
    );
    if (render.status !== 0) {
      findings.push(
        findingForFailure({
          target,
          paths,
          failure: { phase: "render-validate", ...render },
          sourceRoot: args.sourceRoot,
          targetRoot: args.targetRoot,
          expectedTextContains: target.expectedTextContains,
        }),
      );
    }
  }

  return {
    schemaVersion: "itotori.wholegame-render-validation.v0",
    redaction,
    coverage: {
      acceptedUnitCount: args.patchReport.acceptedUnits.length,
      candidateUnitCount: allTargets.length,
      selectedUnitCount: selectedTargets.length,
      candidateSceneCount: candidateSceneIds.length,
      validatedSceneCount: selectedSceneIds.length,
      sampled,
      ...(maxUnits !== undefined ? { maxUnits } : {}),
      sceneIds: selectedSceneIds,
      selectedUnitIds,
      skippedUnitIds,
    },
    findings,
  };
}

/**
 * One validation target per accepted unit. `utsushi-cli render-validate` asserts
 * ONE message per invocation (`--expect-text-contains`), so de-duping by scene
 * would silently skip later accepted lines in the same scene.
 */
function validationTargetsForPatchReport(
  rawBridge: unknown,
  patchReport: DrivenPatchReport,
): ValidationTargetSelection {
  const unitById = bridgeUnitById(rawBridge);
  const targets: ValidationTarget[] = [];
  const ambiguous: AmbiguousValidationTarget[] = [];
  for (const accepted of patchReport.acceptedUnits) {
    const indexedUnit = unitById.get(accepted.bridgeUnitId);
    const expectedTextContains = expectTextExcerpt(accepted.finalDraftText);
    if (indexedUnit === undefined) {
      ambiguous.push({
        bridgeUnitId: accepted.bridgeUnitId,
        sourceUnitKey: accepted.sourceUnitKey,
        sceneId: 1,
        expectedTextContains,
        reason:
          "bridge unit was not present in the raw bridge, so its scene-local message position could not be recovered",
      });
      continue;
    }
    targets.push({
      bridgeUnitId: accepted.bridgeUnitId,
      sourceUnitKey: accepted.sourceUnitKey,
      sceneId: indexedUnit.sceneId,
      messageIndex: indexedUnit.messageIndex,
      expectedTextContains,
    });
  }
  // Stable order: scene then play-order position (deterministic for logs + sample caps).
  targets.sort((a, b) => {
    if (a.sceneId !== b.sceneId) return a.sceneId - b.sceneId;
    if (a.messageIndex !== b.messageIndex) return a.messageIndex - b.messageIndex;
    return a.sourceUnitKey.localeCompare(b.sourceUnitKey);
  });
  return { targets, ambiguous };
}

function uniqueSceneIds(targets: ReadonlyArray<ValidationTarget>): number[] {
  return [...new Set(targets.map((target) => target.sceneId))].sort((a, b) => a - b);
}

function bridgeUnitById(
  rawBridge: unknown,
): Map<string, { sceneId: number; messageIndex: number }> {
  const out = new Map<string, { sceneId: number; messageIndex: number }>();
  if (typeof rawBridge !== "object" || rawBridge === null || Array.isArray(rawBridge)) {
    return out;
  }
  const units = (rawBridge as Record<string, unknown>).units;
  if (!Array.isArray(units)) {
    return out;
  }
  const nextMessageIndexByScene = new Map<number, number>();
  for (const unit of units) {
    if (typeof unit !== "object" || unit === null || Array.isArray(unit)) continue;
    const record = unit as Record<string, unknown>;
    const sceneId = sceneIdForUnit(record);
    if (typeof record.bridgeUnitId === "string" && sceneId !== undefined) {
      const messageIndex = nextMessageIndexByScene.get(sceneId) ?? 0;
      nextMessageIndexByScene.set(sceneId, messageIndex + 1);
      out.set(record.bridgeUnitId, { sceneId, messageIndex });
    }
  }
  return out;
}

function sceneIdForUnit(unit: Record<string, unknown> | undefined): number | undefined {
  if (unit === undefined) return undefined;
  const context = unit.context;
  if (typeof context !== "object" || context === null || Array.isArray(context)) {
    return sceneNumberFromSourceUnitKey(unit.sourceUnitKey);
  }
  const route = (context as Record<string, unknown>).route;
  if (typeof route === "object" && route !== null && !Array.isArray(route)) {
    const routeRecord = route as Record<string, unknown>;
    return (
      toSceneNumber(routeRecord.sceneKey) ??
      toSceneNumber(routeRecord.sceneId) ??
      sceneNumberFromSourceUnitKey(unit.sourceUnitKey)
    );
  }
  return sceneNumberFromSourceUnitKey(unit.sourceUnitKey);
}

function toSceneNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string") {
    const digits = value.match(/^(?:scene-)?(\d+)$/u)?.[1];
    if (digits !== undefined) {
      return Number.parseInt(digits, 10);
    }
  }
  return undefined;
}

function sceneNumberFromSourceUnitKey(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  return toSceneNumber(value.match(/scene[-:](\d+)/u)?.[1]);
}

function expectTextExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= 80) {
    return collapsed;
  }
  return collapsed.slice(0, 80);
}

function artifactPaths(
  artifactRoot: string,
  target: ValidationTarget,
): {
  sceneArtifactRoot: string;
  replayLog: string;
  renderEvidence: string;
} {
  // Per-unit paths: multiple accepted lines in one scene must not overwrite.
  const sceneArtifactRoot = join(
    artifactRoot,
    `scene-${target.sceneId}`,
    `unit-${target.bridgeUnitId}`,
  );
  return {
    sceneArtifactRoot,
    replayLog: join(sceneArtifactRoot, "replay-log.json"),
    renderEvidence: join(sceneArtifactRoot, "render-evidence.json"),
  };
}

function findingForAmbiguousTarget(args: {
  target: AmbiguousValidationTarget;
  sourceRoot: string;
  targetRoot: string;
}): WholeGameRenderValidationFinding {
  const message = `whole-game render-validate could not uniquely select unit ${args.target.bridgeUnitId} (scene ${args.target.sceneId}); not individually render-validated`;
  const diagnostic = buildPipelineFailureDiagnostic({
    step: "localize.render-validate",
    code: "invariant-violation",
    message,
    error: new Error(`utsushi-cli render-validate target ambiguous: ${args.target.reason}`),
    failingUnitId: args.target.bridgeUnitId,
    sceneId: args.target.sceneId,
    inputs: {
      sourceRoot: args.sourceRoot,
      targetRoot: args.targetRoot,
      sceneId: args.target.sceneId,
      phase: "render-validate",
      expectedTextContains: args.target.expectedTextContains,
      redaction: "on",
    },
    repro: {
      bridgeUnitId: args.target.bridgeUnitId,
      sourceUnitKey: args.target.sourceUnitKey,
      sceneId: args.target.sceneId,
    },
    knownGameTextLiterals: [args.target.expectedTextContains],
  });
  return {
    phase: "render-validate",
    bridgeUnitId: args.target.bridgeUnitId,
    sourceUnitKey: args.target.sourceUnitKey,
    sceneId: args.target.sceneId,
    code: "render-target-ambiguous",
    message: diagnostic.message,
    diagnostic,
    artifactRefs: {},
  };
}

function findingForFailure(args: {
  target: ValidationTarget;
  paths: ReturnType<typeof artifactPaths>;
  failure: ProcessFailure;
  sourceRoot: string;
  targetRoot: string;
  expectedTextContains: string;
}): WholeGameRenderValidationFinding {
  const detail = args.failure.stderr.trim() || args.failure.stdout.trim() || "<no output>";
  const step =
    args.failure.phase === "replay-validate"
      ? "localize.replay-validate"
      : "localize.render-validate";
  const message = `whole-game ${args.failure.phase} failed for unit ${args.target.bridgeUnitId} (scene ${args.target.sceneId})`;
  const diagnostic = buildPipelineFailureDiagnostic({
    step,
    code: "unknown",
    message,
    error: new Error(
      `utsushi-cli ${args.failure.phase} exited with status ${String(args.failure.status)}: ${detail}`,
    ),
    failingUnitId: args.target.bridgeUnitId,
    sceneId: args.target.sceneId,
    inputs: {
      sourceRoot: args.sourceRoot,
      targetRoot: args.targetRoot,
      sceneId: args.target.sceneId,
      phase: args.failure.phase,
      expectedTextContains: args.expectedTextContains,
      redaction: "on",
    },
    repro: {
      bridgeUnitId: args.target.bridgeUnitId,
      sourceUnitKey: args.target.sourceUnitKey,
      sceneId: args.target.sceneId,
    },
    knownGameTextLiterals: [args.expectedTextContains],
  });
  return {
    phase: args.failure.phase,
    bridgeUnitId: args.target.bridgeUnitId,
    sourceUnitKey: args.target.sourceUnitKey,
    sceneId: args.target.sceneId,
    code: "native-cli-failed",
    message: diagnostic.message,
    diagnostic,
    artifactRefs: {
      replayLog: args.paths.replayLog,
      ...(args.failure.phase === "render-validate"
        ? { renderEvidence: args.paths.renderEvidence }
        : {}),
    },
  };
}
