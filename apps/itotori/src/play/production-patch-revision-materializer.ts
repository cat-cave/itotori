// p0-core-result-revision-hitl — production child-patch materializer.
//
// A result revision is deliverable only when Kaifuu has produced a new game
// patch. This adapter deliberately consumes the parent patch's durable
// production provenance (`translatedBridge`, `patchApply`, and `patchTarget`),
// rewrites exactly one target in the complete inherited bridge, and invokes
// the same Kaifuu apply seam used by a whole-project delivery. It never writes
// a synthetic delivered-units tree.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  hashLocalizationArtifact,
  verifyLocalizationArtifactManifest,
  type MaterializedPlayTesterPatchArtifact,
  type PlayTesterPatchArtifactMaterializationInput,
  type PlayTesterPatchArtifactMaterializer,
} from "@itotori/db";
import {
  applyKaifuuRealLivePatch,
  applyKaifuuRpgMakerPatch,
  type KaifuuPatchApplyResult,
} from "../orchestrator/patch-apply-seam.js";
import { bracketWrapForRealLive } from "../orchestrator/localize-project-stage-command.js";
import type { TranslationScope } from "../orchestrator/project-driven-executor.js";

const PATCH_APPLY_RECEIPT_SCHEMA_VERSION = "itotori.play-tester-patch-apply.v0.1";
const REFINEMENT_PATCH_APPLY_RECEIPT_SCHEMA_VERSION = "itotori.refinement-patch-apply.v0.1";

type ParentPatchApplyReceipt = {
  command: string;
  args: string[];
  status: number;
  stdout: string;
  stderr: string;
};

type PatchEngine = "reallive" | "rpgmaker";

type ChildPatchApplyReceipt = {
  schemaVersion: typeof PATCH_APPLY_RECEIPT_SCHEMA_VERSION;
  parentPatchVersionId: string;
  childPatchVersionId: string;
  bridgeUnitId: string;
  engine: PatchEngine;
  apply: ParentPatchApplyReceipt;
};

/**
 * A refinement is one complete next PatchVersion, not a chain of one-off
 * play-tester edit patches.  It may rewrite several feedback-affected targets
 * while carrying the untouched targets forward from the observed version.
 */
export type RefinementPatchArtifactMaterializationInput = {
  patchVersionId: string;
  parentPatchVersionId: string;
  parentArtifactRefs: Readonly<Record<string, string>>;
  parentArtifactHashes: Readonly<Record<string, string>>;
  targetRevisions: ReadonlyArray<{ bridgeUnitId: string; targetBody: string }>;
};

export type MaterializedRefinementPatchArtifact = {
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup(): void;
};

type RefinementPatchApplyReceipt = {
  schemaVersion: typeof REFINEMENT_PATCH_APPLY_RECEIPT_SCHEMA_VERSION;
  parentPatchVersionId: string;
  patchVersionId: string;
  bridgeUnitIds: string[];
  engine: PatchEngine;
  apply: ParentPatchApplyReceipt;
};

/**
 * Produces a child delivery under the parent patch target's owned run directory.
 * The route never supplies a filesystem path; the child location is derived
 * solely from the hash-bound parent manifest.
 */
export class ProductionPlayTesterPatchArtifactMaterializer implements PlayTesterPatchArtifactMaterializer {
  async materialize(
    input: PlayTesterPatchArtifactMaterializationInput,
  ): Promise<MaterializedPlayTesterPatchArtifact> {
    const materialized = await materializeInheritedPatch({
      patchVersionId: input.childPatchVersionId,
      parentPatchVersionId: input.parentPatchVersionId,
      parentArtifactRefs: input.parentArtifactRefs,
      parentArtifactHashes: input.parentArtifactHashes,
      targetRevisions: [{ bridgeUnitId: input.bridgeUnitId, targetBody: input.targetBody }],
      revisionKind: "play-tester",
    });
    return materialized;
  }
}

/**
 * The refinement coordinator reuses this real-byte materializer after it has
 * assembled feedback-affected revisions with inherited unaffected membership.
 * This deliberately shares the node-10 Kaifuu path rather than producing a
 * synthetic patch tree for the iteration loop.
 */
export class ProductionRefinementPatchArtifactMaterializer {
  async materialize(
    input: RefinementPatchArtifactMaterializationInput,
  ): Promise<MaterializedRefinementPatchArtifact> {
    return await materializeInheritedPatch({ ...input, revisionKind: "refinement" });
  }
}

async function materializeInheritedPatch(input: {
  patchVersionId: string;
  parentPatchVersionId: string;
  parentArtifactRefs: Readonly<Record<string, string>>;
  parentArtifactHashes: Readonly<Record<string, string>>;
  targetRevisions: ReadonlyArray<{ bridgeUnitId: string; targetBody: string }>;
  revisionKind: "play-tester" | "refinement";
}): Promise<MaterializedRefinementPatchArtifact> {
  if (input.targetRevisions.length === 0) {
    throw new Error("refinement patch materialization requires at least one changed target");
  }
  const targetBodies = new Map<string, string>();
  for (const revision of input.targetRevisions) {
    if (revision.bridgeUnitId.trim().length === 0 || revision.targetBody.trim().length === 0) {
      throw new Error("refinement patch materialization requires non-blank unit ids and targets");
    }
    if (targetBodies.has(revision.bridgeUnitId)) {
      throw new Error(
        `refinement patch materialization received duplicate unit ${revision.bridgeUnitId}`,
      );
    }
    targetBodies.set(revision.bridgeUnitId, revision.targetBody);
  }
  verifyLocalizationArtifactManifest(input.parentArtifactRefs, input.parentArtifactHashes);

  const parentTranslatedBridge = requiredArtifactRef(input.parentArtifactRefs, "translatedBridge");
  const parentPatchApply = requiredArtifactRef(input.parentArtifactRefs, "patchApply");
  const parentPatchTarget = requiredArtifactRef(input.parentArtifactRefs, "patchTarget");
  const priorApply = readPatchApplyReceipt(parentPatchApply, input.parentPatchVersionId);
  const engine = patchEngineFromArgs(priorApply.args);
  assertParentPatchApplyProvenance({
    receipt: priorApply,
    engine,
    translatedBridgePath: parentTranslatedBridge,
    patchTargetPath: parentPatchTarget,
  });
  const sourceRoot = requiredOption(priorApply.args, "--source");

  // Retain the complete inherited translation set. The underlying patcher
  // requires the original (hash-matching) game source, so a version is
  // re-materialized from the parent delivery bridge rather than treating a
  // sparse patched overlay as a source game.
  const childRoot = childRevisionRoot(
    parentPatchTarget,
    input.patchVersionId,
    input.revisionKind === "refinement" ? "refinement-revisions" : "play-tester-revisions",
  );
  const childTarget = join(childRoot, "patch-target");
  const childTranslatedBridge = join(childRoot, "translated-bridge.json");
  const childPatchApply = join(childRoot, "patch-apply.json");
  const childDelta = join(childRoot, "patch.delta.kaifuu");

  rmSync(childRoot, { recursive: true, force: true });
  try {
    mkdirSync(childRoot, { recursive: true });
    const revisedBridge = rewriteInheritedTargets({
      translatedBridgePath: parentTranslatedBridge,
      targetBodies,
      engine,
    });
    writeFileSync(childTranslatedBridge, `${JSON.stringify(revisedBridge, null, 2)}\n`, "utf8");

    const apply =
      engine === "reallive"
        ? applyKaifuuRealLivePatch({
            sourceRoot,
            targetRoot: childTarget,
            translatedBundlePath: childTranslatedBridge,
            translationScope: translationScopeFromKaifuu(
              requiredOption(priorApply.args, "--scope"),
            ),
            force: false,
          })
        : applyKaifuuRpgMakerPatch({
            sourceRoot,
            patchedDataOutputPath: childTarget,
            deltaOutputPath: childDelta,
            translatedBundlePath: childTranslatedBridge,
          });

    assertMaterializedPatchOutput(engine, childTarget, childDelta);
    if (input.revisionKind === "play-tester") {
      const onlyRevision = input.targetRevisions[0]!;
      writePatchApplyReceipt(childPatchApply, {
        parentPatchVersionId: input.parentPatchVersionId,
        childPatchVersionId: input.patchVersionId,
        bridgeUnitId: onlyRevision.bridgeUnitId,
        engine,
        apply,
      });
    } else {
      writeRefinementPatchApplyReceipt(childPatchApply, {
        parentPatchVersionId: input.parentPatchVersionId,
        patchVersionId: input.patchVersionId,
        bridgeUnitIds: [...targetBodies.keys()].sort(),
        engine,
        apply,
      });
    }

    const artifactRefs: Record<string, string> = {
      translatedBridge: childTranslatedBridge,
      patchApply: childPatchApply,
      patchTarget: childTarget,
    };
    if (engine === "rpgmaker") artifactRefs.rpgMakerDelta = childDelta;
    const artifactHashes = Object.fromEntries(
      Object.entries(artifactRefs).map(([key, path]) => [key, hashLocalizationArtifact(path)]),
    );
    verifyLocalizationArtifactManifest(artifactRefs, artifactHashes);
    return {
      artifactRefs,
      artifactHashes,
      cleanup: () => rmSync(childRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(childRoot, { recursive: true, force: true });
    throw error;
  }
}

function requiredArtifactRef(refs: Readonly<Record<string, string>>, key: string): string {
  const value = refs[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`play-tester patch revision requires parent artifact '${key}'`);
  }
  return resolve(value);
}

function childRevisionRoot(
  parentPatchTarget: string,
  childPatchVersionId: string,
  directoryName: "play-tester-revisions" | "refinement-revisions",
): string {
  const root = join(dirname(resolve(parentPatchTarget)), directoryName);
  // The external id can contain arbitrary user/project identifiers. A lossy
  // replacement (for example, mapping both `a/b` and `a?b` to `a_b`) could
  // make one revision delete another's output on retry. Keep the filesystem
  // name wholly derived from a full cryptographic digest instead.
  return join(root, `revision-${sha256Hex(childPatchVersionId)}`);
}

function readPatchApplyReceipt(
  path: string,
  expectedPatchVersionId: string,
): ParentPatchApplyReceipt {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isRecord(value) && "apply" in value) {
      if (value.schemaVersion === REFINEMENT_PATCH_APPLY_RECEIPT_SCHEMA_VERSION) {
        return readRefinementPatchApplyReceipt(value, expectedPatchVersionId);
      }
      return readChildPatchApplyReceipt(value, expectedPatchVersionId);
    }
    return parseKaifuuPatchApplyResult(value);
  } catch (error) {
    throw new Error(
      `play-tester patch revision cannot read parent patch-apply provenance ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Child revision receipts intentionally retain their lineage metadata around
 * the native apply result. A later child may use one of those revisions as its
 * parent, so this wrapper is a durable production receipt format, not a
 * one-shot diagnostic file.
 */
function readChildPatchApplyReceipt(
  value: Record<string, unknown>,
  expectedPatchVersionId: string,
): ParentPatchApplyReceipt {
  if (value.schemaVersion !== PATCH_APPLY_RECEIPT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported child patch-apply receipt schema '${String(value.schemaVersion)}'`,
    );
  }
  const parentPatchVersionId = requiredReceiptString(value, "parentPatchVersionId");
  const childPatchVersionId = requiredReceiptString(value, "childPatchVersionId");
  const bridgeUnitId = requiredReceiptString(value, "bridgeUnitId");
  const engine = value.engine;
  if (engine !== "reallive" && engine !== "rpgmaker") {
    throw new Error("child patch-apply receipt has an unsupported engine");
  }
  if (childPatchVersionId !== expectedPatchVersionId) {
    throw new Error(
      `child patch-apply receipt identifies ${childPatchVersionId}, not expected parent ${expectedPatchVersionId}`,
    );
  }
  // Read all lineage fields even though the nested invocation is the source of
  // executable provenance. This rejects an incomplete wrapper before a later
  // revision can inherit it.
  void parentPatchVersionId;
  void bridgeUnitId;
  const apply = parseKaifuuPatchApplyResult(value.apply);
  if (patchEngineFromArgs(apply.args) !== engine) {
    throw new Error("child patch-apply receipt engine does not match nested apply arguments");
  }
  return apply;
}

function readRefinementPatchApplyReceipt(
  value: Record<string, unknown>,
  expectedPatchVersionId: string,
): ParentPatchApplyReceipt {
  if (value.schemaVersion !== REFINEMENT_PATCH_APPLY_RECEIPT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported refinement patch-apply receipt schema '${String(value.schemaVersion)}'`,
    );
  }
  if (requiredReceiptString(value, "patchVersionId") !== expectedPatchVersionId) {
    throw new Error(
      `refinement patch-apply receipt does not identify expected parent ${expectedPatchVersionId}`,
    );
  }
  requiredReceiptString(value, "parentPatchVersionId");
  if (!Array.isArray(value.bridgeUnitIds) || value.bridgeUnitIds.length === 0) {
    throw new Error("refinement patch-apply receipt has no rewritten bridge units");
  }
  if (
    value.bridgeUnitIds.some((unitId) => typeof unitId !== "string" || unitId.trim().length === 0)
  ) {
    throw new Error("refinement patch-apply receipt has invalid rewritten bridge units");
  }
  const engine = value.engine;
  if (engine !== "reallive" && engine !== "rpgmaker") {
    throw new Error("refinement patch-apply receipt has an unsupported engine");
  }
  const apply = parseKaifuuPatchApplyResult(value.apply);
  if (patchEngineFromArgs(apply.args) !== engine) {
    throw new Error("refinement patch-apply receipt engine does not match nested apply arguments");
  }
  return apply;
}

function parseKaifuuPatchApplyResult(value: unknown): ParentPatchApplyReceipt {
  if (
    !isRecord(value) ||
    typeof value.command !== "string" ||
    value.command.trim().length === 0 ||
    !Array.isArray(value.args) ||
    value.args.some((arg) => typeof arg !== "string") ||
    typeof value.status !== "number" ||
    !Number.isInteger(value.status) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string"
  ) {
    throw new Error("receipt does not match KaifuuPatchApplyResult");
  }
  return {
    command: value.command,
    args: [...value.args],
    status: value.status,
    stdout: value.stdout,
    stderr: value.stderr,
  };
}

function requiredReceiptString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new Error(`child patch-apply receipt is missing ${key}`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patchEngineFromArgs(args: readonly string[]): PatchEngine {
  const engine = requiredOption(args, "--engine");
  if (engine === "reallive") return "reallive";
  if (engine === "rpgmaker" || engine === "rpg-maker") return "rpgmaker";
  throw new Error(`play-tester patch revision cannot replay unsupported engine '${engine}'`);
}

function requiredOption(args: readonly string[], option: string): string {
  const indexes = args.flatMap((arg, index) => (arg === option ? [index] : []));
  if (indexes.length !== 1) {
    throw new Error(
      `play-tester patch revision parent apply receipt must contain exactly one ${option}`,
    );
  }
  const value = args[indexes[0]! + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`play-tester patch revision parent apply receipt is missing ${option}`);
  }
  return value;
}

function assertParentPatchApplyProvenance(input: {
  receipt: ParentPatchApplyReceipt;
  engine: PatchEngine;
  translatedBridgePath: string;
  patchTargetPath: string;
}): void {
  if (input.receipt.status !== 0) {
    throw new Error(
      `play-tester patch revision refuses parent patch-apply receipt with status ${input.receipt.status}`,
    );
  }
  const bundlePath = requiredOption(input.receipt.args, "--bundle");
  if (!sameResolvedPath(bundlePath, input.translatedBridgePath)) {
    throw new Error(
      "play-tester patch revision parent patch-apply receipt --bundle does not bind to parent translatedBridge",
    );
  }
  const outputOption = input.engine === "reallive" ? "--target" : "--patched-data-output";
  const outputPath = requiredOption(input.receipt.args, outputOption);
  if (!sameResolvedPath(outputPath, input.patchTargetPath)) {
    throw new Error(
      `play-tester patch revision parent patch-apply receipt ${outputOption} does not bind to parent patchTarget`,
    );
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function translationScopeFromKaifuu(scope: string): TranslationScope {
  if (scope === "dialogue-only") return "dialogue-only";
  if (scope === "dialogue+choices") return "dialogue-and-choices";
  throw new Error(`play-tester patch revision cannot replay unsupported Kaifuu scope '${scope}'`);
}

function rewriteInheritedTargets(input: {
  translatedBridgePath: string;
  targetBodies: ReadonlyMap<string, string>;
  engine: PatchEngine;
}): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(input.translatedBridgePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `play-tester patch revision cannot read parent translated bridge ${input.translatedBridgePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("play-tester patch revision parent translated bridge must be an object");
  }
  const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  if (!Array.isArray(clone.units)) {
    throw new Error("play-tester patch revision parent translated bridge has no units array");
  }

  const rewritten = new Set<string>();
  for (const unit of clone.units) {
    if (typeof unit !== "object" || unit === null || Array.isArray(unit)) continue;
    const record = unit as Record<string, unknown>;
    if (typeof record.bridgeUnitId !== "string") continue;
    const targetBody = input.targetBodies.get(record.bridgeUnitId);
    if (targetBody === undefined) continue;
    const priorTarget = record.target;
    if (typeof priorTarget !== "object" || priorTarget === null || Array.isArray(priorTarget)) {
      throw new Error(`patch revision parent unit ${record.bridgeUnitId} has no target provenance`);
    }
    const locale = (priorTarget as Record<string, unknown>).locale;
    if (typeof locale !== "string" || locale.trim().length === 0) {
      throw new Error(
        `patch revision parent unit ${record.bridgeUnitId} has no target locale provenance`,
      );
    }
    record.target = {
      locale,
      text: input.engine === "reallive" ? bracketWrapForRealLive(targetBody) : targetBody,
    };
    if (rewritten.has(record.bridgeUnitId)) {
      throw new Error(`patch revision expected one inherited bridge unit ${record.bridgeUnitId}`);
    }
    rewritten.add(record.bridgeUnitId);
  }
  const missing = [...input.targetBodies.keys()].filter((unitId) => !rewritten.has(unitId));
  if (missing.length > 0) {
    throw new Error(
      `patch revision expected inherited bridge unit(s) ${missing.join(", ")}, found ${rewritten.size}`,
    );
  }
  return clone;
}

function assertMaterializedPatchOutput(
  engine: PatchEngine,
  targetRoot: string,
  deltaPath: string,
): void {
  if (!existsSync(targetRoot)) {
    throw new Error("Kaifuu reported success without a child patch target");
  }
  if (engine === "rpgmaker" && !existsSync(deltaPath)) {
    throw new Error("Kaifuu reported success without a child RPG Maker delta package");
  }
}

function writePatchApplyReceipt(
  path: string,
  input: {
    parentPatchVersionId: string;
    childPatchVersionId: string;
    bridgeUnitId: string;
    engine: PatchEngine;
    apply: KaifuuPatchApplyResult;
  },
): void {
  const receipt: ChildPatchApplyReceipt = {
    schemaVersion: PATCH_APPLY_RECEIPT_SCHEMA_VERSION,
    parentPatchVersionId: input.parentPatchVersionId,
    childPatchVersionId: input.childPatchVersionId,
    bridgeUnitId: input.bridgeUnitId,
    engine: input.engine,
    apply: input.apply,
  };
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function writeRefinementPatchApplyReceipt(
  path: string,
  input: {
    parentPatchVersionId: string;
    patchVersionId: string;
    bridgeUnitIds: string[];
    engine: PatchEngine;
    apply: KaifuuPatchApplyResult;
  },
): void {
  const receipt: RefinementPatchApplyReceipt = {
    schemaVersion: REFINEMENT_PATCH_APPLY_RECEIPT_SCHEMA_VERSION,
    parentPatchVersionId: input.parentPatchVersionId,
    patchVersionId: input.patchVersionId,
    bridgeUnitIds: input.bridgeUnitIds,
    engine: input.engine,
    apply: input.apply,
  };
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}
