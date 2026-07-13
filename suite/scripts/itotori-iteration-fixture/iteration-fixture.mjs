/*
 * ITOTORI-028 — End-to-end draft iteration fixture command (cross-tool
 * composition + diagnostics engine).
 *
 * This module is the PURE, side-effect-light core of the
 * `pnpm exec vp run itotori:iteration-fixture` command. It COMPOSES three
 * engines over PUBLIC RECORDED inputs into ONE manifest-bound run — it does
 * NOT re-implement any stage:
 *
 *   1. Itotori iteration (ITOTORI-095) — the six-stage loop
 *        import -> draft -> qa -> export -> feedback -> rerun
 *      is produced by the ITOTORI-095 `composeIteration` / `validateIteration`
 *      engine, threaded VERBATIM (this module imports it; it never re-derives
 *      a draft/QA/export/feedback/rerun stage).
 *   2. Kaifuu patch result      — `patch-result` cross-tool stage, read from a
 *      recorded public Kaifuu patch_result artifact (hash-addressed).
 *   3. Utsushi runtime observation — `runtime-observation` cross-tool stage,
 *      read from a recorded public Utsushi runtime_report artifact
 *      (hash-addressed).
 *
 * The feedback import + targeted rerun are part of the ITOTORI-095 loop and
 * are surfaced (feedbackIds / rerunIds) at the manifest level.
 *
 * The emitted SHARED-025 manifest binds all eight stages to ONE fixture id and
 * ONE source revision and proves the Itotori, Kaifuu, and Utsushi artifacts
 * belong together (the ALPHA-007 cross-tool linkage pattern, extended over the
 * full Itotori loop). Every per-stage artifact is hash-addressed.
 *
 * Hard constraints (PROJECT LAW):
 *   - PUBLIC RECORDED fixtures ONLY. No private corpora, no live credentials,
 *     no raw prompts, no raw provider responses.
 *   - Cost / token usage / (model, provider) pair come VERBATIM from the
 *     ITOTORI-095 recorded provider-proof ledger; never coined.
 *   - Every diagnostic is a STRUCTURED FINDING (code + severity + stage id +
 *     artifact id + remediation code + message). A failed stage stays visible.
 *   - Source-revision identity (sourceBridgeId + sourceBundleHash) is the
 *     cross-tool anchor: a Kaifuu/Utsushi artifact that disagrees with the
 *     Itotori iteration's source revision is a blocking linkage finding.
 */
"use strict";

import {
  assertPublicInputPath,
  composeIteration,
  loadIterationInputs,
  loadJson,
  portableRelativePath,
  REPO_ROOT,
  SHA256_RE,
  sha256OfFile,
  sha256OfPayload,
  validateIteration,
} from "../itotori-fixture-iteration/iteration.mjs";
import { isAbsolute, resolve as resolvePath } from "node:path";

export { REPO_ROOT };

export const ITERATION_FIXTURE_RESULT_SCHEMA_VERSION = "itotori.iteration-fixture.result.v0";
export const CROSS_STAGE_SCHEMA_VERSION = "itotori.iteration-fixture.cross-stage.v0";

// The two cross-tool stages this command adds on top of the six-stage
// ITOTORI-095 Itotori loop. Project ownership is fixed.
export const CROSS_STAGE_ORDER = ["patch-result", "runtime-observation"];
const PROJECT_BY_CROSS_STAGE = { "patch-result": "kaifuu", "runtime-observation": "utsushi" };

// Itotori loop stages that may carry a provider proof (mirrors ITOTORI-095).
const PROVIDER_BACKED_LOOP_STAGES = new Set(["draft", "qa", "rerun"]);

const BLOCKING = "blocking";
const WARN = "warn";

function resolveRepoPath(repoRoot, p) {
  return isAbsolute(p) ? p : resolvePath(repoRoot, p);
}

/** A structured finding (code + severity + stage id + artifact id + remediation + message). */
function finding(code, severity, stageId, artifactId, remediation, message) {
  return { code, severity, stageId, artifactId, remediation, message };
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

/**
 * Load the cross-tool scenario, the referenced ITOTORI-095 iteration recording
 * (via the ITOTORI-095 loader, so the Itotori loop is genuinely composed), and
 * the recorded public Kaifuu patch_result + Utsushi runtime_report artifacts.
 * Every referenced artifact is hash-addressed: a recorded `expectedHash` that
 * drifts from the actual file bytes is a blocking finding, never a stack trace.
 */
export function loadIterationFixtureInputs({ repoRoot = REPO_ROOT, scenarioPath }) {
  const hashFindings = [];
  const scenarioAbs = resolveRepoPath(repoRoot, scenarioPath);
  const recording = loadJson(scenarioAbs);

  // Compose the Itotori loop through the ITOTORI-095 loader (verbatim reuse).
  const iterationScenarioUri = recording.iterationScenarioUri;
  assertPublicInputPath(iterationScenarioUri);
  const iterationInputs = loadIterationInputs({
    repoRoot,
    scenarioPath: resolveRepoPath(repoRoot, iterationScenarioUri),
  });

  const crossInputs = [];
  const loadCross = (key, project, ref) => {
    if (ref === undefined || ref === null) {
      hashFindings.push(
        finding(
          "linkage.cross_input_missing",
          BLOCKING,
          key,
          `${key}:<missing>`,
          "attach-recorded-cross-tool-artifact",
          `scenario is missing the required '${key}' cross-tool artifact reference`,
        ),
      );
      return undefined;
    }
    assertPublicInputPath(ref.uri);
    const abs = resolveRepoPath(repoRoot, ref.uri);
    let actualHash;
    try {
      actualHash = sha256OfFile(abs);
    } catch {
      hashFindings.push(
        finding(
          "linkage.artifact_file_missing",
          BLOCKING,
          key,
          ref.uri,
          "restore-recorded-cross-tool-artifact",
          `${key} references '${ref.uri}' but the file is missing or unreadable`,
        ),
      );
      return undefined;
    }
    if (typeof ref.expectedHash === "string" && actualHash !== ref.expectedHash) {
      hashFindings.push(
        finding(
          "linkage.content_hash_mismatch",
          BLOCKING,
          key,
          ref.uri,
          "recompute-content-hash",
          `${key} recorded hash ${ref.expectedHash} but the file content hash is ${actualHash}`,
        ),
      );
    }
    crossInputs.push({ role: key, project, uri: ref.uri, hash: actualHash });
    return { uri: ref.uri, hash: actualHash, content: loadJson(abs) };
  };

  const patchResult = loadCross("patch-result", "kaifuu", recording.patchResult);
  const runtimeReport = loadCross("runtime-observation", "utsushi", recording.runtimeReport);

  return {
    repoRoot,
    recording,
    scenarioUri: portableRelativePath(repoRoot, scenarioAbs),
    iterationScenarioUri,
    iterationInputs,
    patchResult,
    runtimeReport,
    crossInputs,
    hashFindings,
  };
}

/** Every public input file the command reads (for `--list-inputs`). */
export function listPublicInputs(inputs) {
  const out = [
    inputs.scenarioUri,
    inputs.iterationScenarioUri,
    inputs.iterationInputs.scenarioUri,
    inputs.iterationInputs.ledgerUri,
  ];
  for (const c of inputs.crossInputs) out.push(c.uri);
  return [...new Set(out.filter(Boolean))].sort();
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Compose one end-to-end iteration fixture from loaded inputs. Returns the
 * composed ITOTORI-095 loop, its validation result, the two cross-tool stage
 * bodies, the assembled (unvalidated) manifest, and the per-input hashes.
 * Pure: no disk writes.
 */
export function composeIterationFixture(inputs, { now = new Date() } = {}) {
  const generatedAt = typeof now === "string" ? now : now.toISOString();
  const { recording, iterationInputs, patchResult, runtimeReport } = inputs;

  // 1. The Itotori loop — produced VERBATIM by the ITOTORI-095 engine.
  const loop = composeIteration(iterationInputs, { now: generatedAt });
  const loopValidation = validateIteration(loop);

  const identity = loop.identity ?? {};
  const sourceRevision = {
    sourceBridgeId: identity.sourceBridgeId ?? null,
    sourceBundleHash: identity.sourceBundleHash ?? null,
    sourceRevisionId: identity.sourceRevisionId ?? null,
  };
  const targetLocale = identity.targetLocale ?? null;
  const fixtureId = recording.fixtureId ?? null;

  // 2. Kaifuu patch-result cross stage.
  const patchResultStage = composePatchResultStage({
    generatedAt,
    fixtureId,
    sourceRevisionId: sourceRevision.sourceRevisionId,
    targetLocale,
    patchResult,
  });

  // 3. Utsushi runtime-observation cross stage.
  const runtimeObservationStage = composeRuntimeObservationStage({
    generatedAt,
    fixtureId,
    sourceRevisionId: sourceRevision.sourceRevisionId,
    patchResult,
    runtimeReport,
  });

  // Manifest roll-ups derived from the composed loop.
  const providerProofIds = [
    ...new Set(
      loop.stageResults
        .filter((s) => s.providerProofId !== null && s.providerProofId !== undefined)
        .map((s) => s.providerProofId),
    ),
  ];
  const feedbackIds = loop.stageResults
    .filter((s) => s.stageId === "feedback")
    .map((s) => s.artifactId);
  const rerunIds = loop.stageResults.filter((s) => s.stageId === "rerun").map((s) => s.artifactId);

  const manifest = {
    schemaVersion: ITERATION_FIXTURE_RESULT_SCHEMA_VERSION,
    generatedAt,
    command: "vp run itotori:iteration-fixture",
    scenario: recording.scenario ?? null,
    expectedVerdict: recording.expectedVerdict ?? null,
    fixtureId,
    projectId: identity.projectId ?? null,
    localeBranchId: identity.localeBranchId ?? null,
    sourceRevision,
    sourceLocale: identity.sourceLocale ?? null,
    targetLocale,
    iteration: {
      scenarioUri: inputs.iterationScenarioUri,
      verdict: loopValidation.verdict,
      billedMicrosUsd: loopValidation.billedMicrosUsd,
      providerLedger: {
        uri: iterationInputs.ledgerUri,
        hash: iterationInputs.ledgerHash,
      },
    },
    crossToolInputs: inputs.crossInputs,
    patchResultId: patchResultStage.artifactId,
    runtimeReportId: runtimeObservationStage.artifactId,
    providerProofIds,
    feedbackIds,
    rerunIds,
    // verdict + findings + roll-ups are filled in by validateIterationFixture().
    billedMicrosUsd: loopValidation.billedMicrosUsd,
    stages: [],
    emittedArtifacts: [],
    verdict: "unvalidated",
    findingCount: 0,
    blockingFindingCount: 0,
    findings: [],
  };

  return {
    generatedAt,
    identity,
    sourceRevision,
    targetLocale,
    fixtureId,
    // Input-integrity findings (missing / unreadable / hash-drifted cross-tool
    // artifacts) are carried through so the verdict folds them in.
    hashFindings: inputs.hashFindings ?? [],
    loop,
    loopValidation,
    patchResultStage,
    runtimeObservationStage,
    manifest,
  };
}

function composePatchResultStage({
  generatedAt,
  fixtureId,
  sourceRevisionId,
  targetLocale,
  patchResult,
}) {
  const content = patchResult?.content ?? {};
  const compat = content.sourceCompatibility ?? {};
  const detail = {
    patchExportId: content.patchExportId ?? null,
    adapterId: content.adapterId ?? null,
    sourceBundleHashMatches: compat.sourceBundleHashMatches ?? null,
    compatibleUnitCount: Array.isArray(compat.compatibleUnits) ? compat.compatibleUnits.length : 0,
    incompatibleUnitCount: Array.isArray(compat.incompatibleUnits)
      ? compat.incompatibleUnits.length
      : 0,
    failureCount: Array.isArray(content.failures) ? content.failures.length : 0,
    touchedAssetCount: Array.isArray(content.touchedAssets) ? content.touchedAssets.length : 0,
  };
  const artifactId = content.patchResultId ?? "patch-result:<unknown>";
  return {
    schemaVersion: CROSS_STAGE_SCHEMA_VERSION,
    generatedAt,
    stageId: "patch-result",
    project: PROJECT_BY_CROSS_STAGE["patch-result"],
    artifactId,
    fixtureId,
    sourceRevision: {
      sourceBridgeId: compat.sourceBridgeId ?? null,
      sourceBundleHash: compat.expectedSourceBundleHash ?? null,
      sourceRevisionId: sourceRevisionId ?? null,
    },
    targetLocale,
    sourceUri: patchResult?.uri ?? "",
    sourceHash: patchResult?.hash ?? "",
    status: content.status ?? "unknown",
    contentHash: sha256OfPayload({ stageId: "patch-result", artifactId, detail }),
    detail,
    findings: [],
  };
}

function composeRuntimeObservationStage({
  generatedAt,
  fixtureId,
  sourceRevisionId,
  runtimeReport,
}) {
  const content = runtimeReport?.content ?? {};
  const traceEvents = Array.isArray(content.traceEvents) ? content.traceEvents : [];
  const branchEvents = Array.isArray(content.branchEvents) ? content.branchEvents : [];
  const detail = {
    adapterName: content.adapterName ?? null,
    adapterVersion: content.adapterVersion ?? null,
    evidenceTier: content.evidenceTier ?? null,
    fidelityTier: content.fidelityTier ?? null,
    traceEventCount: traceEvents.length,
    branchEventCount: branchEvents.length,
    observedTextLineCount: traceEvents.filter(
      (e) => typeof e.observedText === "string" && e.observedText.length > 0,
    ).length,
  };
  const artifactId = content.runtimeReportId ?? "runtime-observation:<unknown>";
  return {
    schemaVersion: CROSS_STAGE_SCHEMA_VERSION,
    generatedAt,
    stageId: "runtime-observation",
    project: PROJECT_BY_CROSS_STAGE["runtime-observation"],
    artifactId,
    fixtureId,
    sourceRevision: {
      sourceBridgeId: content.sourceBridgeId ?? null,
      sourceBundleHash: content.sourceBundleHash ?? null,
      sourceRevisionId: sourceRevisionId ?? null,
    },
    targetLocale: content.targetLocale ?? null,
    sourceUri: runtimeReport?.uri ?? "",
    sourceHash: runtimeReport?.hash ?? "",
    status: content.status ?? "unknown",
    contentHash: sha256OfPayload({ stageId: "runtime-observation", artifactId, detail }),
    detail,
    findings: [],
  };
}

// ---------------------------------------------------------------------------
// Cross-tool validation (the semantic diagnostics engine)
// ---------------------------------------------------------------------------

/**
 * Validate one composed iteration fixture. The Itotori loop verdict is taken
 * VERBATIM from ITOTORI-095's `validateIteration`; this layer adds the
 * cross-tool diagnostics (Kaifuu patch failure, Utsushi runtime regression,
 * source-revision linkage across the three engines, OpenRouter provider
 * fallback) and folds everything into one verdict. Every anomaly is a
 * structured finding; a failed stage stays visible.
 */
export function validateIterationFixture(composed) {
  const { sourceRevision, targetLocale, patchResultStage, runtimeObservationStage, loop } =
    composed;
  const crossFindings = [];

  const expectBridge = sourceRevision.sourceBridgeId;
  const expectBundleHash = sourceRevision.sourceBundleHash;

  // 1. Source-revision linkage: every cross-tool stage must share the Itotori
  //    iteration's sourceBridgeId + sourceBundleHash (the cross-tool anchor).
  for (const stage of [patchResultStage, runtimeObservationStage]) {
    const sr = stage.sourceRevision;
    if (sr.sourceBridgeId !== null && expectBridge !== null && sr.sourceBridgeId !== expectBridge) {
      crossFindings.push(
        finding(
          "linkage.source_revision_mismatch",
          BLOCKING,
          stage.stageId,
          stage.artifactId,
          "rebind-cross-tool-artifact-to-source-revision",
          `${stage.project} stage '${stage.stageId}' sourceBridgeId='${sr.sourceBridgeId}' disagrees with iteration sourceBridgeId='${expectBridge}'`,
        ),
      );
    }
    if (
      sr.sourceBundleHash !== null &&
      expectBundleHash !== null &&
      sr.sourceBundleHash !== expectBundleHash
    ) {
      crossFindings.push(
        finding(
          "linkage.source_revision_mismatch",
          BLOCKING,
          stage.stageId,
          stage.artifactId,
          "rebind-cross-tool-artifact-to-source-revision",
          `${stage.project} stage '${stage.stageId}' sourceBundleHash='${sr.sourceBundleHash}' disagrees with iteration sourceBundleHash='${expectBundleHash}'`,
        ),
      );
    }
    if (typeof stage.contentHash === "string" && !SHA256_RE.test(stage.contentHash)) {
      crossFindings.push(
        finding(
          "linkage.content_hash_malformed",
          BLOCKING,
          stage.stageId,
          stage.artifactId,
          "recompute-content-hash",
          `${stage.stageId} contentHash '${stage.contentHash}' is not a well-formed sha256:<hex> digest`,
        ),
      );
    }
  }

  // 2. Utsushi runtime observation targetLocale must agree with the iteration.
  if (
    runtimeObservationStage.targetLocale !== null &&
    targetLocale !== null &&
    runtimeObservationStage.targetLocale !== targetLocale
  ) {
    crossFindings.push(
      finding(
        "linkage.locale_branch_mismatch",
        BLOCKING,
        "runtime-observation",
        runtimeObservationStage.artifactId,
        "rebind-cross-tool-artifact-to-locale-branch",
        `utsushi runtime observation targetLocale='${runtimeObservationStage.targetLocale}' disagrees with iteration targetLocale='${targetLocale}'`,
      ),
    );
  }

  // 3. Kaifuu patch result: a non-passed status or a source-bundle mismatch is
  //    a blocking semantic diagnostic (patch-failure path).
  if (patchResultStage.status !== "passed") {
    crossFindings.push(
      finding(
        "patch.failed",
        BLOCKING,
        "patch-result",
        patchResultStage.artifactId,
        "resolve-failing-patch-apply",
        `Kaifuu patch result status='${patchResultStage.status}' (expected 'passed'); the patch did not apply cleanly`,
      ),
    );
  }
  if (patchResultStage.detail.sourceBundleHashMatches === false) {
    crossFindings.push(
      finding(
        "patch.source_bundle_mismatch",
        BLOCKING,
        "patch-result",
        patchResultStage.artifactId,
        "retarget-patch-to-source-revision",
        "Kaifuu patch result reports sourceBundleHashMatches=false; the patch targeted a different source revision",
      ),
    );
  }

  // 4. Utsushi runtime observation: unsupported / not-passed is a blocking
  //    semantic diagnostic.
  if (runtimeObservationStage.status === "unsupported") {
    crossFindings.push(
      finding(
        "runtime.unsupported",
        BLOCKING,
        "runtime-observation",
        runtimeObservationStage.artifactId,
        "extend-runtime-adapter-coverage",
        "Utsushi runtime observation reported status='unsupported'; the runtime cannot replay this fixture branch",
      ),
    );
  } else if (runtimeObservationStage.status !== "passed") {
    crossFindings.push(
      finding(
        "runtime.not_passed",
        BLOCKING,
        "runtime-observation",
        runtimeObservationStage.artifactId,
        "resolve-runtime-validation-findings",
        `Utsushi runtime observation status='${runtimeObservationStage.status}' (expected 'passed')`,
      ),
    );
  }

  // 5. OpenRouter provider fallback: a provider-backed loop stage whose served
  //    provider differs from the requested provider used the OR automatic
  //    fallback. Surfaced as a (non-blocking) diagnostic, never buried.
  for (const s of loop.stageResults) {
    if (!PROVIDER_BACKED_LOOP_STAGES.has(s.stageId)) continue;
    const pair = s.pair;
    if (
      pair &&
      pair.providerId !== null &&
      pair.servedProvider !== null &&
      pair.providerId !== pair.servedProvider
    ) {
      crossFindings.push(
        finding(
          "provider.fallback_used",
          WARN,
          s.stageId,
          s.artifactId,
          "review-provider-route-reliability",
          `stage '${s.stageId}' requested provider '${pair.providerId}' but was served by '${pair.servedProvider}' (OpenRouter automatic fallback)`,
        ),
      );
    }
  }

  // 6. Fold the cross-tool diagnostics (and any input-integrity findings from
  //    the loader) into the Itotori loop verdict. The loop verdict is verbatim
  //    from ITOTORI-095; a cross-tool / input-integrity blocking finding breaks
  //    the run regardless of the loop outcome.
  const hashFindings = composed.hashFindings ?? [];
  const blockingCross = [...crossFindings, ...hashFindings].filter((f) => f.severity === BLOCKING);
  const loopVerdict = composed.loopValidation.verdict;
  let verdict;
  if (loopVerdict === "broken" || blockingCross.length > 0) {
    verdict = "broken";
  } else if (loopVerdict === "blocked") {
    verdict = "blocked";
  } else if (loopVerdict === "repaired") {
    verdict = "repaired";
  } else {
    verdict = "complete";
  }

  return { verdict, crossFindings, billedMicrosUsd: composed.loopValidation.billedMicrosUsd };
}
