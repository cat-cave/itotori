import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { readOwnedJsonFile } from "../../../apps/itotori/src/cli-json-file-store.js";
import type { AcceptedUnitOutput } from "../../../apps/itotori/src/patchback/types.js";
import { runPatchbackProduceCommand } from "../../../apps/itotori/src/patchback/produce-cli.js";
import { PatchbackBindingError } from "../../../apps/itotori/src/patchback/types.js";
import type { FactSnapshot, OrderedUnitFact } from "../../../apps/itotori/src/prepass/types.js";
import {
  errorName,
  projectFailureWithEffects as project,
  sourceErrorCode,
  type CandidateRequest,
  type CandidateResult,
} from "./explicit-failure-candidate-support.js";
import { OperationEffectBoundary } from "./explicit-failure-effects.js";

const PROOF_HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export async function malformedOwnedInput(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(
    input.operationOutputRoot,
    "malformed-extraction.json",
  );
  const ownedInput = resolve(input.scratchRoot, "owned-input.json");
  writeFileSync(ownedInput, '{"units":[');
  let inputReadCalls = 0;
  let outputWriteCalls = 0;
  let caught: unknown;
  try {
    runPatchbackProduceCommand({
      inputPath: ownedInput,
      outputPath: effects.outputPath,
      sourceRoot: resolve(input.scratchRoot, "source-root"),
      buildRoot: resolve(input.operationOutputRoot, "malformed-build"),
      scope: "dialogue-only",
      io: {
        readJson(path) {
          inputReadCalls += 1;
          return readOwnedJsonFile(path);
        },
        writeJson(path, value) {
          outputWriteCalls += 1;
          if (path !== effects.outputPath) throw new Error("unexpected command output path");
          effects.commit(`${JSON.stringify(value)}\n`);
        },
      },
    });
  } catch (error) {
    caught = error;
  }
  return await project(
    caught,
    {
      command: "itotori.patchback-produce",
      errorName: errorName(caught),
      inputReadCalls,
      outputWriteCalls,
    },
    false,
    effects,
  );
}

export async function changedSourceRevision(input: CandidateRequest): Promise<CandidateResult> {
  const effects = new OperationEffectBoundary(input.operationOutputRoot, "patched-source.bin");
  const planned = Buffer.from("source revision one", "utf8");
  const current = Buffer.from("source revision two", "utf8");
  const currentSource = resolve(input.scratchRoot, "current-source.bin");
  writeFileSync(currentSource, current);
  const plannedHash = digest(planned);
  const currentHash = digest(readFileSync(currentSource));
  const unit = sourceUnit(currentHash);
  const commandInput = {
    snapshot: sourceSnapshot(unit, currentHash),
    accepted: [acceptedTarget(unit.factId, plannedHash)],
    rawBridge: readOwnedJsonFile(
      resolve(input.repositoryRoot, "apps/itotori/test/fixtures/whole-seen-bridge.json"),
    ),
    workScope: { inScopeUnitFactIds: [unit.factId] },
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
  };
  const commandInputPath = resolve(input.scratchRoot, "stale-source-command.json");
  let inputReadCalls = 0;
  let nativeCalls = 0;
  let outputWriteCalls = 0;
  let caught: unknown;
  try {
    runPatchbackProduceCommand({
      inputPath: commandInputPath,
      outputPath: effects.outputPath,
      sourceRoot: resolve(input.scratchRoot, "source-root"),
      buildRoot: resolve(input.operationOutputRoot, "stale-source-build"),
      scope: "dialogue-only",
      engineId: "siglus",
      nativeCli: {
        runProcess() {
          nativeCalls += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      io: {
        readJson(path) {
          inputReadCalls += 1;
          if (path !== commandInputPath) throw new Error("unexpected command input path");
          return commandInput;
        },
        writeJson(path, value) {
          outputWriteCalls += 1;
          if (path !== effects.outputPath) throw new Error("unexpected command output path");
          effects.commit(`${JSON.stringify(value)}\n`);
        },
      },
    });
  } catch (error) {
    caught = error;
  }
  const mismatch =
    caught instanceof PatchbackBindingError && caught.code === "source-hash-mismatch";
  return await project(
    caught,
    {
      mismatch,
      errorName: errorName(caught),
      errorCode: sourceErrorCode(caught),
      plannedHash,
      currentHash,
      command: "itotori.patchback-produce",
      inputReadCalls,
      nativeCalls,
      outputWriteCalls,
    },
    false,
    effects,
  );
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sourceUnit(sourceHash: string): OrderedUnitFact {
  return {
    factId: "unit:failure-contract",
    bridgeUnitId: "bridge-unit:failure-contract",
    sourceUnitKey: "source:scene-0001#0000",
    sceneId: "scene:0001",
    linkKind: "line",
    surfaceKind: "dialogue",
    sourceHash,
    byteRange: null,
    routeScope: { kind: "global" },
    playReveal: { playOrderIndex: 0, revealSceneOrder: null, revealItemOrder: null },
    speaker: null,
    protectedSkeleton: { sourceHash, spans: [] },
    patchRef: {
      assetId: "asset:failure-contract",
      writeMode: "replace",
      sourceUnitKey: "source:scene-0001#0000",
      sourceRevision: {
        revisionId: "revision:current",
        revisionKind: "content_hash",
        value: sourceHash,
      },
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
}

function sourceSnapshot(unit: OrderedUnitFact, sourceHash: string): FactSnapshot {
  return {
    schemaVersion: "itotori.fact-snapshot.v1",
    source: {
      bridgeId: "bridge:failure-contract",
      sourceBundleHash: sourceHash,
      entryScene: unit.sceneId,
      structureSchemaVersion: "structure:failure-contract",
    },
    orderedUnits: [unit],
    scenes: [],
    routeTopology: {
      entryScene: unit.sceneId,
      sceneDispatchOrder: [unit.sceneId],
      edges: [],
      reachableSceneIds: [unit.sceneId],
      unreachableSceneIds: [],
      reachableUnitKeys: [unit.sourceUnitKey],
    },
    characters: [],
    terminology: [],
    choiceLabels: { totalCount: 0, unitKeys: [] },
    glossaryConflicts: [],
    contentHash: PROOF_HASH,
    snapshotId: PROOF_HASH,
  };
}

function acceptedTarget(subjectId: string, sourceHash: string): AcceptedUnitOutput {
  return {
    schemaVersion: "itotori.accepted-output.v1",
    outputId: "output:failure-contract",
    version: 1,
    parentOutputIds: [],
    memoKeys: [],
    evidenceIds: [subjectId],
    acceptedAt: "2026-07-31T00:00:00.000Z",
    releaseEligibility: {
      kind: "artifact-only",
      runMode: "test-dev",
      contextScope: "narrowed:failure-contract",
      reason: "test-dev",
    },
    subjectType: "unit",
    subjectId,
    localizationSnapshotId: PROOF_HASH,
    stage: "final",
    sourceHash,
    value: {
      targetSkeleton: "translated output",
      targetHash: PROOF_HASH,
      translationObjectId: "translation:failure-contract",
      translationObjectVersion: 1,
      parentDraftBatchId: "batch:failure-contract",
      basis: { kind: "wiki-first", bibleRenderingIds: ["rendering:failure-contract"] },
      gateReceipts: [{ gate: "protected-spans", evidenceHash: PROOF_HASH, status: "PASS" }],
      reviewVerdictIds: [],
    },
  };
}
