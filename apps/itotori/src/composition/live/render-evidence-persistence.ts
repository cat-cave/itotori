import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { AcceptedOutput } from "../../contracts/index.js";
import { sha256 } from "../../llm/canonical-json.js";
import {
  enginePatchbackAdapters,
  isPatchbackScope,
  type PatchbackEngineId,
  type PatchbackScope,
} from "../../patchback/index.js";
import {
  PRODUCED_PATCHBACK_ARTIFACT_KEYS,
  producedPatchVersionId,
  type ProducedPatchbackManifest,
} from "../../patchback/produce-build.js";

const SCHEMA_VERSION = "itotori.production-render-evidence-receipt.v1" as const;
const BUILD_LQA_SCHEMA_VERSION = "itotori.production-build-lqa-evidence-receipt.v1" as const;
const RECEIPT_DIRECTORY = ".itotori-q5-render-evidence";

export type RenderEvidenceAcceptedOutput = Extract<
  AcceptedOutput,
  { readonly subjectType: "unit" }
>;

/** Minimum hash-bound patch surface needed to replay bytes through a registered runtime. */
export type RenderEvidencePatchSurface = {
  readonly patchVersionId: string;
  readonly engineId: PatchbackEngineId;
  readonly artifactHashes: Record<string, string>;
  readonly artifactRefs: Record<string, string>;
  readonly runtimeAssets: {
    readonly root: string;
    readonly contentHash: string;
  };
};
type PersistedPatchSurface = RenderEvidencePatchSurface & {
  readonly patchExportId: string;
  readonly scope: PatchbackScope;
};
export type RecoveredRenderEvidencePatch = {
  readonly patch: RenderEvidencePatchSurface;
  readonly buildRoot: string;
  readonly accepted: readonly RenderEvidenceAcceptedOutput[];
};
export type BuildLqaReviewEvidence = {
  readonly unitId: string;
  readonly patchId: string;
  readonly renderResultHash: string;
  readonly patchedBytesHash: string;
  readonly frameId: string;
  readonly frameContentHash: string;
  readonly reviewId: string;
  readonly memoKey: string;
};
type PersistedAcceptedOutput = {
  readonly unitId: string;
  readonly bridgeUnitId: string;
  readonly outputId: string;
  readonly sourceHash: string;
  readonly targetHash: string;
};
type PersistedRenderEvidenceReceipt = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly runId: string;
  readonly buildRoot: string;
  readonly patch: PersistedPatchSurface;
  readonly accepted: readonly PersistedAcceptedOutput[];
};
type PersistedBuildLqaEvidenceReceipt = {
  readonly schemaVersion: typeof BUILD_LQA_SCHEMA_VERSION;
  readonly runId: string;
  readonly patchId: string;
  readonly evidence: readonly BuildLqaReviewEvidence[];
};
export class RenderEvidencePersistenceError extends Error {
  constructor(detail: string) {
    super(`render evidence recovery refused: ${detail}`);
    this.name = "RenderEvidencePersistenceError";
  }
}
export function persistRenderEvidencePatch(input: {
  readonly configuredBuildRoot: string;
  readonly runId: string;
  readonly buildRoot: string;
  readonly patch: ProducedPatchbackManifest;
  readonly accepted: readonly RenderEvidenceAcceptedOutput[];
}): RenderEvidencePatchSurface {
  const patch = patchSurface(input.patch);
  const receipt: PersistedRenderEvidenceReceipt = {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    buildRoot: resolve(input.buildRoot),
    patch,
    accepted: acceptedBindings(input.patch, input.accepted),
  };
  writeReceipt(receiptPath(input.configuredBuildRoot, input.runId, patch.patchVersionId), receipt);
  return patch;
}
export function recoverRenderEvidencePatch(input: {
  readonly configuredBuildRoot: string;
  readonly runtimeAssetRoot: string;
  readonly runId: string;
  readonly patchId: string;
  readonly accepted: readonly RenderEvidenceAcceptedOutput[];
}): RecoveredRenderEvidencePatch | undefined {
  const path = receiptPath(input.configuredBuildRoot, input.runId, input.patchId);
  if (!existsSync(path)) return undefined;
  const receipt = parseReceipt(readReceipt(path));
  if (receipt.runId !== input.runId || receipt.patch.patchVersionId !== input.patchId) {
    throw new RenderEvidencePersistenceError("receipt identity does not match the requested patch");
  }
  assertReceiptPaths(receipt, input.configuredBuildRoot);
  if (resolve(receipt.patch.runtimeAssets.root) !== resolve(input.runtimeAssetRoot)) {
    throw new RenderEvidencePersistenceError(
      "persisted runtime assets do not match this invocation",
    );
  }
  assertPatchIdentity(receipt);
  return {
    patch: receipt.patch,
    buildRoot: receipt.buildRoot,
    accepted: bindAccepted(receipt.accepted, input.accepted),
  };
}
export function persistBuildLqaEvidence(input: {
  readonly configuredBuildRoot: string;
  readonly runId: string;
  readonly patchId: string;
  readonly evidence: readonly BuildLqaReviewEvidence[];
}): void {
  const receipt: PersistedBuildLqaEvidenceReceipt = {
    schemaVersion: BUILD_LQA_SCHEMA_VERSION,
    runId: input.runId,
    patchId: input.patchId,
    evidence: validatedEvidence(input.evidence, input.patchId),
  };
  writeReceipt(buildLqaReceiptPath(input.configuredBuildRoot, input.runId, input.patchId), receipt);
}
export function recoverBuildLqaEvidence(input: {
  readonly configuredBuildRoot: string;
  readonly runId: string;
  readonly patchId: string;
  readonly reviews: readonly { readonly unitId: string; readonly reviewId: string }[];
}): readonly BuildLqaReviewEvidence[] {
  const path = buildLqaReceiptPath(input.configuredBuildRoot, input.runId, input.patchId);
  if (!existsSync(path)) {
    throw new RenderEvidencePersistenceError("persisted Q5 evidence receipt is absent");
  }
  const receipt = parseBuildLqaReceipt(readReceipt(path));
  if (receipt.runId !== input.runId || receipt.patchId !== input.patchId) {
    throw new RenderEvidencePersistenceError(
      "persisted Q5 evidence does not match the cached patch",
    );
  }
  const expected = new Map(input.reviews.map((review) => [review.unitId, review.reviewId]));
  if (expected.size !== input.reviews.length || receipt.evidence.length !== expected.size) {
    throw new RenderEvidencePersistenceError(
      "persisted Q5 evidence has incomplete review coverage",
    );
  }
  for (const evidence of receipt.evidence) {
    if (expected.get(evidence.unitId) !== evidence.reviewId) {
      throw new RenderEvidencePersistenceError(
        "persisted Q5 evidence does not match its review verdict",
      );
    }
  }
  return receipt.evidence;
}
function patchSurface(patch: ProducedPatchbackManifest): PersistedPatchSurface {
  return {
    patchVersionId: patch.patchVersionId,
    patchExportId: patch.patchExportId,
    engineId: patch.engineId,
    scope: patch.patchReceipt.scope,
    artifactHashes: { ...patch.artifactHashes },
    artifactRefs: { ...patch.artifactRefs },
    runtimeAssets: { ...patch.runtimeAssets },
  };
}
function acceptedBindings(
  patch: ProducedPatchbackManifest,
  accepted: readonly RenderEvidenceAcceptedOutput[],
): readonly PersistedAcceptedOutput[] {
  const byOutputId = new Map(accepted.map((output) => [output.outputId, output]));
  if (byOutputId.size !== accepted.length || patch.units.length !== accepted.length) {
    throw new RenderEvidencePersistenceError(
      "produced patch has incomplete accepted-output coverage",
    );
  }
  return patch.units.map((unit) => {
    const output = byOutputId.get(unit.acceptedOutputId);
    if (
      output === undefined ||
      output.subjectId !== unit.factId ||
      output.sourceHash !== unit.sourceHash ||
      output.value.targetHash !== unit.acceptedTargetHash
    ) {
      throw new RenderEvidencePersistenceError("produced patch does not bind its accepted output");
    }
    return {
      unitId: output.subjectId,
      bridgeUnitId: unit.bridgeUnitId,
      outputId: output.outputId,
      sourceHash: output.sourceHash,
      targetHash: output.value.targetHash,
    };
  });
}
function receiptPath(configuredBuildRoot: string, runId: string, patchId: string): string {
  const identity = sha256({ runId, patchId }).slice("sha256:".length);
  return join(resolve(configuredBuildRoot), RECEIPT_DIRECTORY, `${identity}.json`);
}
function buildLqaReceiptPath(configuredBuildRoot: string, runId: string, patchId: string): string {
  const identity = sha256({ kind: "build-lqa", runId, patchId }).slice("sha256:".length);
  return join(resolve(configuredBuildRoot), RECEIPT_DIRECTORY, `${identity}.json`);
}

function writeReceipt(
  path: string,
  receipt: PersistedRenderEvidenceReceipt | PersistedBuildLqaEvidenceReceipt,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function readReceipt(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new RenderEvidencePersistenceError("persisted patch receipt cannot be read");
  }
}

function parseReceipt(raw: string): PersistedRenderEvidenceReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RenderEvidencePersistenceError("persisted patch receipt is not valid JSON");
  }
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new RenderEvidencePersistenceError("persisted patch receipt has an unknown schema");
  }
  const patch = parsePatch(value.patch);
  const accepted = parseAccepted(value.accepted);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: requiredString(value.runId, "run id"),
    buildRoot: requiredString(value.buildRoot, "build root"),
    patch,
    accepted,
  };
}

function parseBuildLqaReceipt(raw: string): PersistedBuildLqaEvidenceReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RenderEvidencePersistenceError("persisted Q5 evidence receipt is not valid JSON");
  }
  if (!isRecord(value) || value.schemaVersion !== BUILD_LQA_SCHEMA_VERSION) {
    throw new RenderEvidencePersistenceError("persisted Q5 evidence receipt has an unknown schema");
  }
  const patchId = requiredString(value.patchId, "Q5 patch id");
  return {
    schemaVersion: BUILD_LQA_SCHEMA_VERSION,
    runId: requiredString(value.runId, "Q5 run id"),
    patchId,
    evidence: validatedEvidence(value.evidence, patchId),
  };
}

function parsePatch(value: unknown): PersistedPatchSurface {
  if (!isRecord(value)) {
    throw new RenderEvidencePersistenceError("persisted patch receipt has no patch surface");
  }
  const engineId = requiredEngineId(value.engineId);
  const scope = requiredScope(value.scope);
  const artifactHashes = requiredStringRecord(value.artifactHashes, "artifact hashes");
  const artifactRefs = requiredStringRecord(value.artifactRefs, "artifact references");
  for (const key of PRODUCED_PATCHBACK_ARTIFACT_KEYS) {
    if (artifactHashes[key] === undefined || artifactRefs[key] === undefined) {
      throw new RenderEvidencePersistenceError("persisted patch receipt omits a required artifact");
    }
  }
  if (!isRecord(value.runtimeAssets)) {
    throw new RenderEvidencePersistenceError("persisted patch receipt has no runtime assets");
  }
  return {
    patchVersionId: requiredString(value.patchVersionId, "patch id"),
    patchExportId: requiredString(value.patchExportId, "patch export id"),
    engineId,
    scope,
    artifactHashes,
    artifactRefs,
    runtimeAssets: {
      root: requiredString(value.runtimeAssets.root, "runtime asset root"),
      contentHash: requiredHash(value.runtimeAssets.contentHash, "runtime asset hash"),
    },
  };
}

function parseAccepted(value: unknown): readonly PersistedAcceptedOutput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RenderEvidencePersistenceError(
      "persisted patch receipt has no accepted-output coverage",
    );
  }
  const unitIds = new Set<string>();
  const outputIds = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new RenderEvidencePersistenceError(
        "persisted patch receipt has an invalid accepted output",
      );
    }
    const parsed = {
      unitId: requiredString(candidate.unitId, "accepted unit id"),
      bridgeUnitId: requiredString(candidate.bridgeUnitId, "accepted bridge unit id"),
      outputId: requiredString(candidate.outputId, "accepted output id"),
      sourceHash: requiredHash(candidate.sourceHash, "accepted source hash"),
      targetHash: requiredHash(candidate.targetHash, "accepted target hash"),
    };
    if (unitIds.has(parsed.unitId) || outputIds.has(parsed.outputId)) {
      throw new RenderEvidencePersistenceError("persisted patch receipt repeats accepted coverage");
    }
    unitIds.add(parsed.unitId);
    outputIds.add(parsed.outputId);
    return parsed;
  });
}

function validatedEvidence(value: unknown, patchId: string): readonly BuildLqaReviewEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RenderEvidencePersistenceError("persisted Q5 evidence has no unit coverage");
  }
  const unitIds = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new RenderEvidencePersistenceError("persisted Q5 evidence has an invalid unit receipt");
    }
    const evidence = {
      unitId: requiredString(candidate.unitId, "Q5 unit id"),
      patchId: requiredString(candidate.patchId, "Q5 evidence patch id"),
      renderResultHash: requiredHash(candidate.renderResultHash, "Q5 render result hash"),
      patchedBytesHash: requiredHash(candidate.patchedBytesHash, "Q5 patched bytes hash"),
      frameId: requiredString(candidate.frameId, "Q5 frame id"),
      frameContentHash: requiredHash(candidate.frameContentHash, "Q5 frame content hash"),
      reviewId: requiredString(candidate.reviewId, "Q5 review id"),
      memoKey: requiredString(candidate.memoKey, "Q5 memo key"),
    };
    if (evidence.patchId !== patchId || unitIds.has(evidence.unitId)) {
      throw new RenderEvidencePersistenceError("persisted Q5 evidence has invalid patch coverage");
    }
    unitIds.add(evidence.unitId);
    return evidence;
  });
}

function bindAccepted(
  persisted: readonly PersistedAcceptedOutput[],
  current: readonly RenderEvidenceAcceptedOutput[],
): readonly RenderEvidenceAcceptedOutput[] {
  const available = new Map<string, RenderEvidenceAcceptedOutput>();
  for (const output of current) {
    if (output.stage !== "final" || available.has(output.outputId)) {
      throw new RenderEvidencePersistenceError(
        "current accepted-output recovery coverage is invalid",
      );
    }
    available.set(output.outputId, output);
  }
  return persisted.map((expected) => {
    const output = available.get(expected.outputId);
    if (
      output === undefined ||
      output.subjectId !== expected.unitId ||
      output.sourceHash !== expected.sourceHash ||
      output.value.targetHash !== expected.targetHash
    ) {
      throw new RenderEvidencePersistenceError(
        "current accepted output does not match the patched build",
      );
    }
    return output;
  });
}

function assertReceiptPaths(
  receipt: PersistedRenderEvidenceReceipt,
  configuredBuildRoot: string,
): void {
  if (!inside(resolve(configuredBuildRoot), receipt.buildRoot)) {
    throw new RenderEvidencePersistenceError(
      "persisted build root is outside the owned evidence root",
    );
  }
  for (const key of PRODUCED_PATCHBACK_ARTIFACT_KEYS) {
    const artifact = receipt.patch.artifactRefs[key];
    if (artifact === undefined || !inside(receipt.buildRoot, artifact)) {
      throw new RenderEvidencePersistenceError(
        "persisted patch artifact is outside the owned build",
      );
    }
  }
}

function assertPatchIdentity(receipt: PersistedRenderEvidenceReceipt): void {
  const patchId = producedPatchVersionId({
    patchExportId: receipt.patch.patchExportId,
    engineId: receipt.patch.engineId,
    scope: receipt.patch.scope,
    artifactHashes: receipt.patch.artifactHashes,
    runtimeAssets: receipt.patch.runtimeAssets,
    units: receipt.accepted.map((output) => ({
      bridgeUnitId: output.bridgeUnitId,
      acceptedOutputId: output.outputId,
      acceptedTargetHash: output.targetHash,
      sourceHash: output.sourceHash,
    })),
  });
  if (patchId !== receipt.patch.patchVersionId) {
    throw new RenderEvidencePersistenceError(
      "persisted patch receipt does not reproduce its patch id",
    );
  }
}

function requiredStringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new RenderEvidencePersistenceError(`persisted patch receipt has no ${label}`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new RenderEvidencePersistenceError(`persisted patch receipt has invalid ${label}`);
  }
  const record: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (typeof item !== "string" || item === "") {
      throw new RenderEvidencePersistenceError(`persisted patch receipt has invalid ${label}`);
    }
    record[key] = item;
  }
  return record;
}

function requiredEngineId(value: unknown): PatchbackEngineId {
  if (typeof value !== "string") {
    throw new RenderEvidencePersistenceError("persisted patch receipt has no engine id");
  }
  const adapter = enginePatchbackAdapters().find((candidate) => candidate.engineId === value);
  if (adapter === undefined) {
    throw new RenderEvidencePersistenceError(
      "persisted patch receipt names an unregistered engine",
    );
  }
  return adapter.engineId;
}

function requiredScope(value: unknown): PatchbackScope {
  if (!isPatchbackScope(value)) {
    throw new RenderEvidencePersistenceError("persisted patch receipt has an invalid patch scope");
  }
  return value;
}

function requiredHash(value: unknown, label: string): string {
  const hash = requiredString(value, label);
  if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) {
    throw new RenderEvidencePersistenceError(`persisted patch receipt has an invalid ${label}`);
  }
  return hash;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RenderEvidencePersistenceError(`persisted patch receipt has no ${label}`);
  }
  return value;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
