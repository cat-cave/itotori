// DB-backed context-correction redraft execution and durable verification.
//
// A context correction is not complete merely because a queue handler ran.
// This adapter derives an exact affected-unit pass from the registered live
// configuration, persists its drafts, and then independently proves the
// changed draft + ContextPacket selection from durable projections.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AuthorizationActor,
  ContextCorrectionRedraftPayload,
  ItotoriLocalizationJournalRepositoryPort,
  ItotoriProjectRepositoryPort,
} from "@itotori/db";
import { assertBridgeBundleV02, type BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import {
  type ContextCorrectionRedraftExecution,
  type ContextCorrectionRedrafter,
  type ContextCorrectionRedraftVerification,
  type ContextCorrectionRerunVerifier,
} from "../orchestrator/context-correction-worker.js";
import { runLocalizeFullProjectLive } from "../orchestrator/localize-fullproject-cli.js";
import {
  parseLocalizeFullProjectConfig,
  type LocalizeFullProjectIo,
} from "../orchestrator/localize-fullproject-command.js";
import {
  materializeRegisteredRunConfig,
  type DbBackedPassRunConfig,
} from "./db-live-workflow-ports.js";

export type ContextCorrectionRedraftRunnerInput = {
  payload: ContextCorrectionRedraftPayload & { jobId: string };
  /** The validated, exact affected-unit bridge passed to the live runner. */
  bridge: BridgeBundleV02;
  /** The corresponding JSON form, retained for runner seams and diagnostics. */
  rawBridge: unknown;
  configPath: string;
  runDir: string;
  targetLocale: string;
  io: LocalizeFullProjectIo;
  sourceRoot?: string;
  patchTargetRoot?: string;
  databaseUrl?: string;
};

export type ContextCorrectionRedraftRunnerResult = {
  journalRunId: string;
  targetLocale: string;
  unitOutcomes: readonly {
    bridgeUnitId: string;
    selectedBody: string;
  }[];
};

/**
 * The sole test seam in this adapter. Production leaves it unset and uses the
 * real full-project live runner below; tests can provide a deterministic
 * runner while still exercising the database-service worker composition.
 */
export type ContextCorrectionRedraftRunner = (
  input: ContextCorrectionRedraftRunnerInput,
) => Promise<ContextCorrectionRedraftRunnerResult>;

export type DbBackedContextCorrectionRedrafterDeps = {
  actor: AuthorizationActor;
  projectRepository: Pick<ItotoriProjectRepositoryPort, "saveDrafts">;
  resolveRunConfig(input: {
    projectId: string;
    localeBranchId: string;
  }): Promise<DbBackedPassRunConfig | null> | DbBackedPassRunConfig | null;
  /** Production's database target; passed through to the real live runner. */
  databaseUrl?: string;
  runLive?: ContextCorrectionRedraftRunner;
};

/**
 * Production redrafter for registered context-correction jobs. It never uses
 * the full registered bridge directly: a new job-owned configuration points
 * at an exact filtered copy, so a correction cannot accidentally redraft an
 * arbitrary prefix/full project via `maxUnits`.
 */
export class DbBackedContextCorrectionRedrafter implements ContextCorrectionRedrafter {
  private readonly io: LocalizeFullProjectIo = nodeJsonFileStore;
  private readonly runLive: ContextCorrectionRedraftRunner;

  constructor(private readonly deps: DbBackedContextCorrectionRedrafterDeps) {
    this.runLive = deps.runLive ?? runContextCorrectionLive;
  }

  async redraft(
    payload: ContextCorrectionRedraftPayload & { jobId: string },
  ): Promise<ContextCorrectionRedraftExecution> {
    const registered = await this.deps.resolveRunConfig({
      projectId: payload.projectId,
      localeBranchId: payload.localeBranchId,
    });
    if (registered === null) {
      throw new Error(
        `context-correction worker has no registered live pass configuration for ${payload.projectId}/${payload.localeBranchId}`,
      );
    }

    const runDir = join(registered.runDir, "context-corrections", payload.jobId);
    mkdirSync(runDir, { recursive: true });
    const prepared = materializeRegisteredRunConfig(
      { ...registered, runDir },
      {
        projectId: payload.projectId,
        localeBranchId: payload.localeBranchId,
        actor: this.deps.actor,
      },
      this.io,
    );
    const rawConfig = asRecord(this.io.readJson(prepared.configPath), "registered run config");
    const parsedConfig = parseLocalizeFullProjectConfig(rawConfig);
    assertRunConfigIdentity(parsedConfig, payload);

    const rawBridge = this.io.readJson(parsedConfig.bridgePath);
    assertBridgeBundleV02(rawBridge);
    const bridge = scopeBridge(rawBridge, payload.affectedUnitIds);
    const scopedBridgePath = join(runDir, "context-correction.bridge.json");
    const scopedRawBridge = { ...(rawBridge as Record<string, unknown>), units: bridge.units };
    this.io.writeJson(scopedBridgePath, scopedRawBridge);

    // A feedback/correction scope can contain any bridge-unit surface, even
    // when the original full pass was dialogue-only. The filtered bridge is
    // authoritative; `all` prevents a configured scope from silently skipping
    // one of the queued affected IDs.
    const { maxUnits: _ignoredMaxUnits, ...configWithoutPrefixCap } = rawConfig;
    const scopedConfigPath = join(runDir, "context-correction.config.json");
    this.io.writeJson(scopedConfigPath, {
      ...configWithoutPrefixCap,
      projectId: payload.projectId,
      localeBranchId: payload.localeBranchId,
      sourceRevisionId: payload.sourceRevisionId,
      bridgePath: scopedBridgePath,
      translationScope: "all",
    });

    const targetLocale = parsedConfig.targetLocale ?? "en-US";
    const result = await this.runLive({
      payload,
      bridge,
      rawBridge: scopedRawBridge,
      configPath: scopedConfigPath,
      runDir,
      targetLocale,
      io: this.io,
      ...(prepared.sourceRoot !== undefined ? { sourceRoot: prepared.sourceRoot } : {}),
      ...(prepared.patchTargetRoot !== undefined
        ? { patchTargetRoot: prepared.patchTargetRoot }
        : {}),
      ...(this.deps.databaseUrl !== undefined ? { databaseUrl: this.deps.databaseUrl } : {}),
    });
    assertExactRedraftOutcomes(payload, result.unitOutcomes);
    if (result.targetLocale !== targetLocale) {
      throw new Error(
        `context-correction runner returned target locale ${result.targetLocale}, expected ${targetLocale}`,
      );
    }

    await this.deps.projectRepository.saveDrafts(this.deps.actor, {
      projectId: payload.projectId,
      localeBranchId: payload.localeBranchId,
      targetLocale,
      bridge,
      drafts: Object.fromEntries(
        result.unitOutcomes.map((outcome) => [outcome.bridgeUnitId, outcome.selectedBody]),
      ),
    });
    return { journalRunId: result.journalRunId };
  }
}

/** Independently verify journal packets and persisted target text after a rerun. */
export class DbBackedContextCorrectionRerunVerifier implements ContextCorrectionRerunVerifier {
  constructor(
    private readonly deps: {
      actor: AuthorizationActor;
      projectRepository: Pick<ItotoriProjectRepositoryPort, "loadLocaleBranchDraftTexts">;
      journalRepository: Pick<ItotoriLocalizationJournalRepositoryPort, "loadRunOutcomes">;
    },
  ) {}

  async snapshotDrafts(
    payload: ContextCorrectionRedraftPayload,
  ): Promise<Readonly<Record<string, string | null>>> {
    return await this.loadDrafts(payload);
  }

  async verifyRedraft(input: {
    payload: ContextCorrectionRedraftPayload;
    journalRunId: string;
    draftsBefore: Readonly<Record<string, string | null>>;
  }): Promise<ContextCorrectionRedraftVerification> {
    const [draftsAfter, outcomes] = await Promise.all([
      this.loadDrafts(input.payload),
      this.deps.journalRepository.loadRunOutcomes(this.deps.actor, input.journalRunId),
    ]);
    const outcomesByUnit = new Map(outcomes.map((outcome) => [outcome.bridgeUnitId, outcome]));
    for (const unitId of input.payload.affectedUnitIds) {
      const outcome = outcomesByUnit.get(unitId);
      if (outcome === undefined) {
        throw new Error(
          `context-correction worker journal ${input.journalRunId} has no durable outcome for affected unit ${unitId}`,
        );
      }
      assertResolvedContextVersion(
        outcome.contextPacket,
        input.payload.contextArtifactId,
        input.payload.contextEntryVersionId,
        unitId,
      );
    }
    const changedDraftCount = input.payload.affectedUnitIds.filter(
      (unitId) => draftsAfter[unitId] !== input.draftsBefore[unitId],
    ).length;
    return {
      redraftedUnitIds: [...input.payload.affectedUnitIds],
      changedDraftCount,
    };
  }

  private async loadDrafts(
    payload: ContextCorrectionRedraftPayload,
  ): Promise<Readonly<Record<string, string | null>>> {
    const persisted = await this.deps.projectRepository.loadLocaleBranchDraftTexts(
      this.deps.actor,
      {
        projectId: payload.projectId,
        localeBranchId: payload.localeBranchId,
        bridgeUnitIds: payload.affectedUnitIds,
      },
    );
    return Object.fromEntries(
      payload.affectedUnitIds.map((unitId) => [unitId, persisted.get(unitId) ?? null]),
    );
  }
}

async function runContextCorrectionLive(
  input: ContextCorrectionRedraftRunnerInput,
): Promise<ContextCorrectionRedraftRunnerResult> {
  const live = await runLocalizeFullProjectLive({
    configPath: input.configPath,
    runDir: input.runDir,
    io: input.io,
    ...(input.sourceRoot !== undefined ? { sourceRoot: input.sourceRoot } : {}),
    ...(input.patchTargetRoot !== undefined ? { patchTargetRoot: input.patchTargetRoot } : {}),
    ...(input.databaseUrl !== undefined ? { databaseUrl: input.databaseUrl } : {}),
  });
  if (live.resumedFinalization === true) {
    throw new Error(
      `context-correction live rerun ${live.result.journalRunId} resumed a prior terminal finalization instead of running its exact scope`,
    );
  }
  if (live.result.runState !== "succeeded" || !live.result.patchReport.coverageComplete) {
    throw new Error(
      `context-correction live rerun ${live.result.journalRunId} did not complete its exact scope`,
    );
  }
  return {
    journalRunId: live.result.journalRunId,
    targetLocale: input.targetLocale,
    unitOutcomes: live.result.unitOutcomes.map((outcome) => ({
      bridgeUnitId: outcome.bridgeUnitId,
      selectedBody: outcome.selectedBody,
    })),
  };
}

function scopeBridge(bridge: BridgeBundleV02, affectedUnitIds: readonly string[]): BridgeBundleV02 {
  const requested = new Set(affectedUnitIds);
  const units = bridge.units.filter((unit) => requested.has(unit.bridgeUnitId));
  const found = new Set(units.map((unit) => unit.bridgeUnitId));
  const missing = affectedUnitIds.filter((unitId) => !found.has(unitId));
  if (missing.length > 0) {
    throw new Error(
      `context-correction registered bridge is missing affected unit(s): ${missing.join(", ")}`,
    );
  }
  return { ...bridge, units };
}

function assertRunConfigIdentity(
  config: {
    projectId: string;
    localeBranchId: string;
    sourceRevisionId: string;
  },
  payload: ContextCorrectionRedraftPayload,
): void {
  const mismatches = [
    ["projectId", config.projectId, payload.projectId],
    ["localeBranchId", config.localeBranchId, payload.localeBranchId],
    ["sourceRevisionId", config.sourceRevisionId, payload.sourceRevisionId],
  ].filter(([, actual, expected]) => actual !== expected);
  if (mismatches.length > 0) {
    throw new Error(
      `context-correction registered run config does not match queued correction (${mismatches
        .map(([field, actual, expected]) => `${field}=${actual} (expected ${expected})`)
        .join(", ")})`,
    );
  }
}

function assertExactRedraftOutcomes(
  payload: ContextCorrectionRedraftPayload,
  outcomes: readonly { bridgeUnitId: string; selectedBody: string }[],
): void {
  const requested = new Set(payload.affectedUnitIds);
  const observed = new Set<string>();
  for (const outcome of outcomes) {
    if (!requested.has(outcome.bridgeUnitId)) {
      throw new Error(
        `context-correction runner redrafted unexpected unit ${outcome.bridgeUnitId}`,
      );
    }
    if (outcome.selectedBody.trim().length === 0) {
      throw new Error(`context-correction runner wrote blank draft for ${outcome.bridgeUnitId}`);
    }
    observed.add(outcome.bridgeUnitId);
  }
  const missing = payload.affectedUnitIds.filter((unitId) => !observed.has(unitId));
  if (missing.length > 0) {
    throw new Error(
      `context-correction runner did not produce affected unit(s): ${missing.join(", ")}`,
    );
  }
}

function assertResolvedContextVersion(
  contextPacket: unknown,
  contextArtifactId: string,
  contextEntryVersionId: string,
  unitId: string,
): void {
  const packet = asOptionalRecord(contextPacket);
  const unitPacket = asOptionalRecord(packet?.["unitContextPacket"]);
  const resolved = asOptionalRecord(unitPacket?.["resolvedFromVersions"]);
  if (resolved?.[contextArtifactId] !== contextEntryVersionId) {
    throw new Error(
      `context-correction worker did not reload ${contextArtifactId}@${contextEntryVersionId} for unit ${unitId}`,
    );
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const nodeJsonFileStore: LocalizeFullProjectIo = {
  readJson: (path) => JSON.parse(readFileSync(path, "utf8")) as unknown,
  writeJson: (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  },
};
