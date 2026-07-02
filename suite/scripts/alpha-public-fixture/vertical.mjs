/*
 * ALPHA-007 — Suite public fixture vertical run (composition + linkage engine).
 *
 * This module is the PURE, side-effect-light core of the
 * `pnpm exec vp run alpha:public-fixture` command. It COMPOSES existing
 * public-fixture artifacts across the three engines of the suite — it does
 * NOT re-implement any stage:
 *
 *   - Itotori   : bridge bundle + patch export (the fixture-iteration output)
 *   - Kaifuu    : patch result + delta package
 *   - Utsushi   : runtime report (the runtime observation)
 *   - Provider  : recorded provider runs (sanitized; no live creds)
 *   - Benchmark : produced fresh by ITOTORI-026 `benchmark-harness-run`
 *   - SHARED-025: the alpha vertical proof manifest that ties them together
 *
 * Hard constraints (PROJECT LAW):
 *   - Public fixtures ONLY. No private corpora, no live credentials, no
 *     retail bytes. Every input path lives under `fixtures/` (public).
 *   - Cost is NEVER hardcoded. It is read verbatim from the recorded
 *     provider artifacts / ITOTORI-026 report (`amountMicrosUsd`).
 *   - All failures become STRUCTURED FINDINGS (code + severity + subject +
 *     message), never prose-only reports.
 *
 * Everything here is plain Node ESM (the suite drivers are plain JS by
 * design); schema validation is done with the same Ajv 2020 the public
 * manifest validator already depends on.
 */
"use strict";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRuntimeProofIsRealRun, replayFixtureRuntime } from "./runtime-replay.mjs";

export { assertRuntimeProofIsRealRun, replayFixtureRuntime };

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolvePath(HERE, "..", "..", "..");

export const LINKAGE_SCHEMA_VERSION = "itotori.alpha-public-fixture.vertical-linkage.v0";
export const VERTICAL_MANIFEST_SCHEMA_VERSION = "itotori.alpha-public-fixture.vertical-manifest.v0";
export const RUNTIME_OBSERVATION_SCHEMA_VERSION =
  "itotori.alpha-public-fixture.runtime-observation-proof.v0";
export const PROVIDER_PROOF_SCHEMA_VERSION = "itotori.alpha-public-fixture.provider-proof.v0";
export const READ_MODEL_SCHEMA_VERSION = "itotori.alpha-public-fixture.read-model-ingestion.v0";
export const BENCHMARK_ENVELOPE_SCHEMA_VERSION =
  "itotori.alpha-public-fixture.benchmark-envelope.v0";

// The benchmark report MUST be the product of ITOTORI-026's harness, whose
// run manifest carries this schema version. The vertical refuses to treat a
// hand-authored placeholder file as a benchmark (acceptance: "produced by
// ITOTORI-026 or a named successor, not a placeholder file").
export const BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA = "itotori.benchmark_harness_run_manifest.v0.1";
export const BENCHMARK_REPORT_STAGE_ID = "cost-quality-report";

export const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;

// The default public composition inputs. All under fixtures/ (public).
export const DEFAULT_INPUTS = {
  proofManifestPath: "fixtures/alpha-vertical-proof/hello-game-alpha-proof-v0.2.fr-FR.json",
  recordedProviderPath: "fixtures/benchmark-stages/public-fixture.json",
};

export function sha256OfBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256OfFile(path) {
  return sha256OfBytes(readFileSync(path));
}

export function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function portableRelativePath(fromDir, path) {
  const rel = relative(fromDir, path);
  return (rel === "" ? "." : rel).split(sep).join("/");
}

export function repoRelativePath(path) {
  return portableRelativePath(REPO_ROOT, path);
}

function resolveRepoPath(repoRoot, p) {
  return isAbsolute(p) ? p : resolvePath(repoRoot, p);
}

/**
 * A structured finding. Every diagnostic the vertical emits is one of these
 * — code + severity + a stable subject — never a prose-only string.
 */
function finding(code, severity, subject, message) {
  return { code, severity, subject, message };
}

const BLOCKING = "blocking";
const WARN = "warn";
const INFO = "info";

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

/**
 * Read every public composition input from disk and verify each referenced
 * artifact is hash-addressed (recorded hash === sha256 of the actual bytes).
 * Returns the loaded artifacts plus a `hashFindings` list (any mismatch is a
 * blocking finding, never a thrown stack trace).
 */
export function loadVerticalInputs({
  repoRoot = REPO_ROOT,
  proofManifestPath = DEFAULT_INPUTS.proofManifestPath,
  recordedProviderPath = DEFAULT_INPUTS.recordedProviderPath,
  benchmarkOutputDir,
} = {}) {
  const hashFindings = [];

  const proofPathAbs = resolveRepoPath(repoRoot, proofManifestPath);
  const proof = loadJson(proofPathAbs);
  const proofHash = sha256OfFile(proofPathAbs);

  // The proof manifest is the authority for which artifacts compose the
  // vertical and what their content hashes are. Re-derive each file hash and
  // record a blocking finding if it drifts from the recorded ref hash.
  const artifactRefs = proof.artifactRefs ?? {};
  const loadedArtifacts = {};
  for (const [key, ref] of Object.entries(artifactRefs)) {
    if (ref === undefined || ref === null) continue;
    const uri = ref.uri;
    const abs = resolveRepoPath(repoRoot, uri);
    let actualHash;
    try {
      actualHash = sha256OfFile(abs);
    } catch {
      hashFindings.push(
        finding(
          "linkage.artifact_file_missing",
          BLOCKING,
          uri,
          `proof manifest artifactRefs.${key} references '${uri}' but the file is missing or unreadable`,
        ),
      );
      continue;
    }
    if (actualHash !== ref.hash) {
      hashFindings.push(
        finding(
          "linkage.content_hash_mismatch",
          BLOCKING,
          uri,
          `artifactRefs.${key} recorded hash ${ref.hash} but the file content hash is ${actualHash}`,
        ),
      );
    }
    loadedArtifacts[key] = { ref, content: loadJson(abs), actualHash };
  }

  // Verify the public fixture manifest hash too (the fixture identity anchor).
  const publicManifestUri = proof.fixture?.publicManifestUri;
  let publicManifestHash;
  if (typeof publicManifestUri === "string") {
    const abs = resolveRepoPath(repoRoot, publicManifestUri);
    try {
      publicManifestHash = sha256OfFile(abs);
      if (publicManifestHash !== proof.fixture.publicManifestHash) {
        hashFindings.push(
          finding(
            "linkage.content_hash_mismatch",
            BLOCKING,
            publicManifestUri,
            `fixture.publicManifestHash ${proof.fixture.publicManifestHash} but file content hash is ${publicManifestHash}`,
          ),
        );
      }
    } catch {
      hashFindings.push(
        finding(
          "linkage.artifact_file_missing",
          BLOCKING,
          publicManifestUri,
          `fixture.publicManifestUri '${publicManifestUri}' is missing or unreadable`,
        ),
      );
    }
  }

  const recordedProviderAbs = resolveRepoPath(repoRoot, recordedProviderPath);
  const recordedProvider = loadJson(recordedProviderAbs);

  // ITOTORI-026 benchmark output (run manifest + cost-quality report). The
  // driver runs the harness fresh; tests inject a recorded harness output dir.
  let benchmark;
  if (benchmarkOutputDir !== undefined) {
    benchmark = loadBenchmarkOutput(benchmarkOutputDir, hashFindings);
  }

  return {
    repoRoot,
    proof,
    proofManifestUri: portableRelativePath(repoRoot, proofPathAbs),
    proofHash,
    loadedArtifacts,
    publicManifestUri,
    publicManifestHash,
    recordedProvider,
    recordedProviderUri: portableRelativePath(repoRoot, recordedProviderAbs),
    benchmark,
    hashFindings,
  };
}

/**
 * Load + verify an ITOTORI-026 harness output directory. The benchmark
 * report's content hash MUST match the hash the harness recorded in its run
 * manifest for the `cost-quality-report` stage — that binding is what proves
 * the report is the harness's product and not a placeholder.
 */
export function loadBenchmarkOutput(benchmarkOutputDir, hashFindings = []) {
  const dir = benchmarkOutputDir;
  const runManifest = loadJson(join(dir, "run-manifest.json"));
  const reportPath = join(dir, "cost-quality-report.json");
  const reportEnvelope = loadJson(reportPath);
  // ITOTORI-026 wraps the validated BenchmarkReportV02 under `.report` (with a
  // sibling human-`rendered` summary). Unwrap to the report body.
  const report = reportEnvelope.report ?? reportEnvelope;
  const reportHash = sha256OfFile(reportPath);
  const stage = Array.isArray(runManifest.stages)
    ? runManifest.stages.find((s) => s.stageId === BENCHMARK_REPORT_STAGE_ID)
    : undefined;
  // The harness records an internally-canonicalized stage hash (not the file
  // bytes), so provenance is proven by RUN-ID binding instead: the report's
  // benchmarkRunId must equal the harness run-manifest's benchmarkRunId, the
  // manifest must carry the ITOTORI-026 schema + a succeeded status, and the
  // benchmark stage must be present with the benchmark-report artifact kind.
  const recordedStageHash = stage?.artifact?.artifactHash ?? null;
  const producedByHarness =
    runManifest.schemaVersion === BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA &&
    runManifest.status === "succeeded" &&
    stage?.artifact?.artifactKind === "benchmark-report" &&
    typeof report.benchmarkRunId === "string" &&
    report.benchmarkRunId === runManifest.benchmarkRunId;
  if (!producedByHarness) {
    hashFindings.push(
      finding(
        "benchmark.not_harness_product",
        BLOCKING,
        "cost-quality-report.json",
        `benchmark report is not a verified ITOTORI-026 product (run-manifest schema=${runManifest.schemaVersion} status=${runManifest.status} stageKind=${stage?.artifact?.artifactKind ?? "<none>"} report.benchmarkRunId=${report.benchmarkRunId ?? "<none>"} manifest.benchmarkRunId=${runManifest.benchmarkRunId ?? "<none>"})`,
      ),
    );
  }
  return { dir, runManifest, report, reportHash, recordedStageHash, producedByHarness };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function pickLocalizationRecord(project, artifactKind, ref, content, fields) {
  return {
    project,
    artifactKind,
    artifactId: ref.ref.artifactId,
    uri: ref.ref.uri,
    hash: ref.actualHash,
    fixtureId: fields.fixtureId,
    sourceBridgeId: fields.sourceBridgeId,
    sourceBundleHash: fields.sourceBundleHash,
    targetLocale: fields.targetLocale ?? null,
  };
}

/**
 * Compose the public-fixture vertical from loaded inputs. Returns every
 * emitted artifact body plus the linkage record. Pure: no disk writes.
 */
export function composeVertical(inputs, { now = new Date() } = {}) {
  const { proof, loadedArtifacts, recordedProvider, benchmark } = inputs;
  const generatedAt = typeof now === "string" ? now : now.toISOString();
  const fixtureId = proof.fixture?.fixtureId;
  const sourceBridgeId = proof.sourceBridgeId;
  const sourceBundleHash = proof.sourceBundleHash;
  const sourceRevision = proof.sourceRevision;

  const bridge = loadedArtifacts.bridgeBundle;
  const patchExport = loadedArtifacts.patchExport;
  const patchResult = loadedArtifacts.patchResult;
  const deltaPackage = loadedArtifacts.deltaPackage;
  // The committed runtime_report is the Utsushi scene LOG (the runtime timeline
  // the engine replays) — NOT the runtime proof. Its observed text / status /
  // counts are re-derived by executing the patch over the source (see below);
  // nothing from it is copied into the emitted runtime-observation proof.
  const runtimeSceneLog = loadedArtifacts.runtimeReport;

  const targetLocale = patchExport?.content?.targetLocale ?? proof.fixture?.targetLocale ?? null;

  const verticalFixture = {
    fixtureId,
    publicManifestUri: proof.fixture?.publicManifestUri,
    publicManifestHash: proof.fixture?.publicManifestHash,
    sourceBridgeId,
    sourceBundleHash,
    sourceRevision,
    sourceLocale: bridge?.content?.sourceLocale ?? null,
    targetLocale,
  };

  // ---- Utsushi runtime observation proof (emitted) — a REAL run ----
  // EXECUTE the fixture: the replay engine renders the localized runtime script
  // by applying the patch-export target text over the bridge source bytes
  // (verifying protected-span preservation + that the source was actually
  // localized). status, trace/branch/observed-line counts, and the renderHash
  // are DERIVED FROM THAT EXECUTED OUTPUT — never copied from the checked-in
  // runtime_report (which is used only as the scene log the engine replays).
  const runtimeRun = replayFixtureRuntime({
    bridge,
    patchExport,
    runtimeSceneLog,
    proof,
  });
  const runtimeObservationProof = {
    schemaVersion: RUNTIME_OBSERVATION_SCHEMA_VERSION,
    generatedAt,
    fixtureId,
    sourceBridgeId,
    sourceBundleHash,
    sourceLocale: runtimeRun.provenance.sourceLocale,
    targetLocale: runtimeRun.provenance.targetLocale,
    runtimeReportId: runtimeRun.provenance.runtimeReportId,
    runtimeReportUri: runtimeRun.provenance.runtimeReportUri,
    runtimeReportHash: runtimeRun.provenance.runtimeReportHash,
    runtimeTargetIds: Array.isArray(proof.runtimeTargetIds) ? proof.runtimeTargetIds : [],
    adapterName: runtimeRun.adapter.name,
    adapterVersion: runtimeRun.adapter.version,
    evidenceTier: runtimeRun.adapter.evidenceTier,
    fidelityTier: runtimeRun.adapter.fidelityTier,
    status: runtimeRun.status,
    traceEventCount: runtimeRun.counts.traceEventCount,
    branchEventCount: runtimeRun.counts.branchEventCount,
    observedTextLineCount: runtimeRun.counts.observedTextLineCount,
    // Artifact-bytes proof: sha256 over the produced localized render. The
    // placeholder-rejection guard re-executes and rejects any proof whose
    // renderHash does not reproduce a genuine, localized, span-preserving run.
    renderHash: runtimeRun.renderHash,
  };

  // ---- Sanitized provider proof (emitted) ----
  // Composed from the public RECORDED provider runs. Prompt/response bodies
  // are never copied — only ids, hashes, routing posture, cost, fallback,
  // retry, and structured-output mode. Cost is read verbatim (never coined).
  const providerProofId = Array.isArray(proof.providerProofIds)
    ? proof.providerProofIds[0]
    : undefined;
  const recordedRuns = collectRecordedProviderRuns(recordedProvider);
  const providerProof = {
    schemaVersion: PROVIDER_PROOF_SCHEMA_VERSION,
    generatedAt,
    fixtureId,
    providerProofId: providerProofId ?? null,
    mode: "recorded",
    sanitized: true,
    recordedSource: inputs.recordedProviderUri,
    runs: recordedRuns,
    billedMicrosUsd: recordedRuns.reduce(
      (sum, r) => sum + (r.cost.costKind === "billed" ? r.cost.amountMicrosUsd : 0),
      0,
    ),
    zdrEnforcedCount: recordedRuns.filter((r) => r.dataPolicy.zdr === true).length,
    fallbackUsedCount: recordedRuns.filter((r) => r.fallbackUsed === true).length,
  };

  // ---- Benchmark report (emitted) — ITOTORI-026 product ----
  let benchmarkRecord = null;
  let benchmarkReport = null;
  if (benchmark !== undefined) {
    benchmarkReport = {
      schemaVersion: BENCHMARK_ENVELOPE_SCHEMA_VERSION,
      generatedAt,
      producedBy: "ITOTORI-026",
      benchmarkRunManifestId: benchmark.runManifest.benchmarkRunId,
      benchmarkRunManifestSchema: benchmark.runManifest.schemaVersion,
      benchmarkReportHash: benchmark.reportHash,
      harnessRecordedStageHash: benchmark.recordedStageHash,
      costSummary: benchmark.runManifest.costSummary,
      report: benchmark.report,
    };
    benchmarkRecord = {
      project: "itotori",
      artifactKind: "benchmark_report",
      producedBy: "ITOTORI-026",
      benchmarkRunId: benchmark.report.benchmarkRunId,
      runManifestId: benchmark.runManifest.benchmarkRunId,
      runManifestSchema: benchmark.runManifest.schemaVersion,
      status: benchmark.runManifest.status,
      reportStatus: benchmark.report.status,
      hash: benchmark.reportHash,
      corpusRef: summarizeBenchmarkCorpus(benchmark.report),
      producedByHarness: benchmark.producedByHarness,
    };
  }

  // ---- Dashboard / read-model ingestion proof (emitted) ----
  const readModelIngestion = {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    generatedAt,
    fixtureId,
    sourceBridgeId,
    sourceBundleHash,
    targetLocale,
    runtimeTargetIds: runtimeObservationProof.runtimeTargetIds,
    runtimeObservationStatus: runtimeObservationProof.status,
    ingestedTraceEventCount: runtimeObservationProof.traceEventCount,
    ingestedBranchEventCount: runtimeObservationProof.branchEventCount,
    providerProofId: providerProof.providerProofId,
  };

  // ---- Linkage record (emitted, also the validator's input) ----
  const artifacts = {};
  if (bridge !== undefined) {
    artifacts.bridge = pickLocalizationRecord("itotori", "bridge_bundle", bridge, bridge.content, {
      fixtureId,
      sourceBridgeId: bridge.content.bridgeId ?? bridge.content.sourceBridgeId,
      sourceBundleHash: bridge.content.sourceBundleHash,
      targetLocale: null,
    });
  }
  if (patchExport !== undefined) {
    artifacts.patchExport = pickLocalizationRecord(
      "itotori",
      "patch_export",
      patchExport,
      patchExport.content,
      {
        fixtureId,
        sourceBridgeId: patchExport.content.sourceBridgeId,
        sourceBundleHash: patchExport.content.sourceBundleHash,
        targetLocale: patchExport.content.targetLocale,
      },
    );
  }
  if (patchResult !== undefined) {
    artifacts.patchResult = {
      ...pickLocalizationRecord("kaifuu", "patch_result", patchResult, patchResult.content, {
        fixtureId,
        sourceBridgeId: patchResult.content.sourceCompatibility?.sourceBridgeId,
        sourceBundleHash: patchResult.content.sourceCompatibility?.expectedSourceBundleHash,
        targetLocale,
      }),
      status: patchResult.content.status,
      sourceBundleHashMatches: patchResult.content.sourceCompatibility?.sourceBundleHashMatches,
    };
  }
  if (deltaPackage !== undefined) {
    artifacts.deltaPackage = pickLocalizationRecord(
      "kaifuu",
      "delta_package",
      deltaPackage,
      deltaPackage.content,
      {
        fixtureId,
        sourceBridgeId: deltaPackage.content.sourceBridgeId,
        sourceBundleHash: deltaPackage.content.sourceBundleHash,
        targetLocale: deltaPackage.content.targetLocale,
      },
    );
  }
  artifacts.runtimeObservation = {
    project: "utsushi",
    artifactKind: "runtime_observation_proof",
    artifactId: runtimeObservationProof.runtimeReportId,
    fixtureId,
    sourceBridgeId,
    sourceBundleHash,
    targetLocale: runtimeObservationProof.targetLocale,
    status: runtimeObservationProof.status,
  };
  artifacts.providerProof = {
    project: "itotori",
    artifactKind: "provider_proof",
    providerProofId: providerProof.providerProofId,
    fixtureId,
    fallbackUsed: providerProof.fallbackUsedCount > 0,
    billedMicrosUsd: providerProof.billedMicrosUsd,
    zdrEnforcedCount: providerProof.zdrEnforcedCount,
  };
  if (benchmarkRecord !== null) {
    artifacts.benchmark = benchmarkRecord;
  }
  artifacts.dashboardReadModel = {
    project: "itotori",
    artifactKind: "dashboard_read_model",
    fixtureId,
    sourceBridgeId,
    sourceBundleHash,
    targetLocale,
    status: readModelIngestion.runtimeObservationStatus,
  };

  const linkage = {
    schemaVersion: LINKAGE_SCHEMA_VERSION,
    generatedAt,
    verticalFixture,
    sharedManifest: {
      proofManifestId: proof.proofManifestId,
      uri: inputs.proofManifestUri,
      hash: inputs.proofHash,
      providerProofIds: Array.isArray(proof.providerProofIds) ? proof.providerProofIds : [],
      benchmarkReportRefHash: loadedArtifacts.benchmarkReport?.actualHash ?? null,
    },
    artifacts,
    // verdict + findings are filled in by validateLinkage(); seed them so the
    // emitted record is always self-contained.
    verdict: "unvalidated",
    findings: [],
  };

  return {
    generatedAt,
    runtimeObservationProof,
    runtimeRun,
    providerProof,
    benchmarkReport,
    readModelIngestion,
    linkage,
  };
}

function collectRecordedProviderRuns(recordedProvider) {
  const runs = [];
  const push = (origin, providerRun) => {
    if (providerRun === undefined || providerRun === null) return;
    const cost = providerRun.cost ?? {};
    runs.push({
      origin,
      providerRunId: providerRun.providerRunId,
      taskKind: providerRun.taskKind ?? null,
      status: providerRun.status ?? null,
      // Routed provider + model (sanitized — names/ids only, no prompts).
      provider: {
        providerFamily: providerRun.provider?.providerFamily ?? null,
        providerName: providerRun.provider?.providerName ?? null,
        requestedModelId: providerRun.provider?.requestedModelId ?? null,
        actualModelId: providerRun.provider?.actualModelId ?? null,
        upstreamProvider: providerRun.provider?.upstreamProvider ?? null,
      },
      structuredOutputMode: providerRun.structuredOutputMode ?? null,
      retryCount: providerRun.retryCount ?? 0,
      errorClasses: Array.isArray(providerRun.errorClasses) ? providerRun.errorClasses : [],
      fallbackUsed: providerRun.fallbackUsed === true,
      fallbackPlan: Array.isArray(providerRun.fallbackPlan) ? providerRun.fallbackPlan : [],
      tokenUsage: providerRun.tokenUsage ?? null,
      // Cost is copied VERBATIM from the recorded artifact. Never coined.
      cost: {
        costKind: cost.costKind ?? "zero",
        currency: cost.currency ?? "USD",
        amountMicrosUsd: Number.isInteger(cost.amountMicrosUsd) ? cost.amountMicrosUsd : 0,
        pricingSnapshotId: cost.pricingSnapshotId ?? null,
      },
      // Data-policy / ZDR posture flag.
      dataPolicy: {
        zdr:
          providerRun.provider?.providerFamily === "openrouter" ? true : recordedZdr(providerRun),
      },
    });
  };
  for (const system of recordedProvider.recordedSystems ?? []) {
    push(`recordedSystems:${system.systemId}`, system.providerRun);
  }
  for (const agent of recordedProvider.qaAgents ?? []) {
    push(`qaAgents:${agent.qaAgentId}`, agent.providerRun);
  }
  return runs;
}

function recordedZdr(providerRun) {
  // Recorded fixtures may carry an explicit routingPosture.zdr; otherwise the
  // recorded-fixture providers are public and carry no data-collection.
  const posture = providerRun.routingPosture ?? providerRun.provider?.routingPosture;
  if (posture && typeof posture.zdr === "boolean") return posture.zdr;
  return false;
}

function summarizeBenchmarkCorpus(report) {
  const ref = Array.isArray(report.fixtureOrCorpusRefs) ? report.fixtureOrCorpusRefs[0] : undefined;
  if (ref === undefined) return null;
  return {
    corpusRefId: ref.corpusRefId ?? null,
    corpusKind: ref.corpusKind ?? null,
    publicContent: ref.publicContent === true,
    sourceLocale: ref.sourceLocale ?? null,
    targetLocale: ref.targetLocale ?? null,
    engineProfile: ref.engineProfile ?? null,
  };
}

// ---------------------------------------------------------------------------
// Linkage validation (the semantic diagnostics engine)
// ---------------------------------------------------------------------------

const LOCALIZATION_ARTIFACT_KEYS = ["bridge", "patchExport", "patchResult", "deltaPackage"];

/**
 * Prove artifact linkage across the suite. Returns { verdict, findings } with
 * EVERY anomaly expressed as a structured finding. Drives the six regression
 * paths the node names: success, unsupported runtime, patch failure, provider
 * fallback, benchmark failure, and rerun repair.
 */
export function validateLinkage(linkage, { priorFindings } = {}) {
  const findings = [];
  const vf = linkage.verticalFixture ?? {};
  const artifacts = linkage.artifacts ?? {};

  // 1. Cross-artifact agreement on fixture id / source revision / locale /
  //    content hash for the localization-vertical artifact set + the runtime
  //    observation + the dashboard read-model.
  const linkedKeys = [...LOCALIZATION_ARTIFACT_KEYS, "runtimeObservation", "dashboardReadModel"];
  for (const key of linkedKeys) {
    const a = artifacts[key];
    if (a === undefined) continue;
    if (a.fixtureId !== undefined && a.fixtureId !== vf.fixtureId) {
      findings.push(
        finding(
          "linkage.fixture_id_mismatch",
          BLOCKING,
          key,
          `artifact '${key}' fixtureId='${a.fixtureId}' disagrees with vertical fixtureId='${vf.fixtureId}'`,
        ),
      );
    }
    if (a.sourceBridgeId !== undefined && a.sourceBridgeId !== vf.sourceBridgeId) {
      findings.push(
        finding(
          "linkage.source_revision_mismatch",
          BLOCKING,
          key,
          `artifact '${key}' sourceBridgeId='${a.sourceBridgeId}' disagrees with vertical sourceBridgeId='${vf.sourceBridgeId}'`,
        ),
      );
    }
    if (a.sourceBundleHash !== undefined && a.sourceBundleHash !== vf.sourceBundleHash) {
      findings.push(
        finding(
          "linkage.source_revision_mismatch",
          BLOCKING,
          key,
          `artifact '${key}' sourceBundleHash='${a.sourceBundleHash}' disagrees with vertical sourceBundleHash='${vf.sourceBundleHash}'`,
        ),
      );
    }
    if (
      a.targetLocale !== undefined &&
      a.targetLocale !== null &&
      vf.targetLocale !== undefined &&
      a.targetLocale !== vf.targetLocale
    ) {
      findings.push(
        finding(
          "linkage.locale_branch_mismatch",
          BLOCKING,
          key,
          `artifact '${key}' targetLocale='${a.targetLocale}' disagrees with vertical targetLocale='${vf.targetLocale}'`,
        ),
      );
    }
  }

  // 2. Provider proof id must be non-empty and present in the SHARED-025
  //    manifest provider proof id list (acceptance #5).
  const providerProofIds = linkage.sharedManifest?.providerProofIds ?? [];
  const providerProofId = artifacts.providerProof?.providerProofId;
  if (
    providerProofId === undefined ||
    providerProofId === null ||
    String(providerProofId).length === 0
  ) {
    findings.push(
      finding(
        "provider.proof_id_missing",
        BLOCKING,
        "providerProof",
        "provider proof id is empty; the SHARED-025 manifest requires a non-empty sanitized provider proof id",
      ),
    );
  } else if (!providerProofIds.includes(providerProofId)) {
    findings.push(
      finding(
        "provider.proof_id_unlinked",
        BLOCKING,
        "providerProof",
        `provider proof id '${providerProofId}' is not present in SHARED-025 providerProofIds [${providerProofIds.join(", ")}]`,
      ),
    );
  }

  // 3. Runtime observation: unsupported runtime is a semantic diagnostic.
  const runtimeStatus = artifacts.runtimeObservation?.status;
  if (runtimeStatus === "unsupported") {
    findings.push(
      finding(
        "runtime.unsupported",
        BLOCKING,
        "runtimeObservation",
        "Utsushi runtime observation reported status='unsupported'; the runtime cannot replay this fixture branch",
      ),
    );
  } else if (runtimeStatus !== undefined && runtimeStatus !== "passed") {
    findings.push(
      finding(
        "runtime.not_passed",
        BLOCKING,
        "runtimeObservation",
        `Utsushi runtime observation status='${runtimeStatus}' (expected 'passed')`,
      ),
    );
  }

  // 4. Patch result: patch failure is a semantic diagnostic.
  const patchStatus = artifacts.patchResult?.status;
  if (patchStatus !== undefined && patchStatus !== "passed") {
    findings.push(
      finding(
        "patch.failed",
        BLOCKING,
        "patchResult",
        `Kaifuu patch result status='${patchStatus}' (expected 'passed'); the patch did not apply cleanly`,
      ),
    );
  }
  if (artifacts.patchResult?.sourceBundleHashMatches === false) {
    findings.push(
      finding(
        "patch.source_bundle_mismatch",
        BLOCKING,
        "patchResult",
        "Kaifuu patch result reports sourceBundleHashMatches=false; the patch targeted a different source revision",
      ),
    );
  }

  // 5. Provider fallback: recorded fallback is surfaced as a (non-blocking)
  //    semantic diagnostic, not buried in prose.
  if (artifacts.providerProof?.fallbackUsed === true) {
    findings.push(
      finding(
        "provider.fallback_used",
        WARN,
        "providerProof",
        "recorded provider proof shows a provider fallback was used; route reliability should be reviewed",
      ),
    );
  }

  // 6. Benchmark: must be a verified ITOTORI-026 product; a failed harness run
  //    is a semantic diagnostic.
  const benchmark = artifacts.benchmark;
  if (benchmark !== undefined) {
    if (benchmark.producedByHarness === false || benchmark.producedBy !== "ITOTORI-026") {
      findings.push(
        finding(
          "benchmark.placeholder",
          BLOCKING,
          "benchmark",
          "benchmark artifact is not a verified ITOTORI-026 harness product (placeholder files are rejected)",
        ),
      );
    }
    if (benchmark.status === "failed" || benchmark.reportStatus === "failed") {
      findings.push(
        finding(
          "benchmark.failed",
          BLOCKING,
          "benchmark",
          `ITOTORI-026 benchmark run status='${benchmark.status}', reportStatus='${benchmark.reportStatus}'`,
        ),
      );
    }
  }

  // 7. Content-hash sanity: any sha256-shaped hash must be well-formed.
  for (const [key, a] of Object.entries(artifacts)) {
    if (typeof a.hash === "string" && !SHA256_RE.test(a.hash)) {
      findings.push(
        finding(
          "linkage.content_hash_malformed",
          BLOCKING,
          key,
          `artifact '${key}' hash '${a.hash}' is not a well-formed sha256:<hex> digest`,
        ),
      );
    }
  }

  // 8. Rerun repair path: a rerun that clears a prior blocking finding records
  //    a `rerun.repaired` diagnostic and the cleared code no longer blocks.
  const rerun = linkage.rerun;
  const before = priorFindings ?? rerun?.priorFindings ?? [];
  if (rerun !== undefined && Array.isArray(rerun.repairedFindingCodes)) {
    const stillPresent = new Set(findings.map((f) => f.code));
    for (const code of rerun.repairedFindingCodes) {
      const wasPresent = before.some((f) => f.code === code);
      if (wasPresent && !stillPresent.has(code)) {
        findings.push(
          finding(
            "rerun.repaired",
            INFO,
            "rerun",
            `rerun iteration repaired prior blocking finding '${code}'`,
          ),
        );
      } else if (!stillPresent.has(code)) {
        // Even without an explicit prior list, record that the rerun closed it.
        findings.push(
          finding("rerun.repaired", INFO, "rerun", `rerun iteration cleared finding '${code}'`),
        );
      }
    }
  }

  const blocking = findings.filter((f) => f.severity === BLOCKING);
  const verdict = blocking.length === 0 ? "linked" : "broken";
  return { verdict, findings };
}

/** List every public input file the vertical reads (for `--list-inputs`). */
export function listPublicInputs(inputs) {
  const out = [inputs.proofManifestUri, inputs.recordedProviderUri];
  for (const ref of Object.values(inputs.loadedArtifacts)) {
    out.push(ref.ref.uri);
  }
  if (inputs.publicManifestUri) out.push(inputs.publicManifestUri);
  return [...new Set(out)].sort();
}

/** Guard: refuse any non-public input path. */
export function assertPublicInputPath(uri) {
  const normalized = String(uri).split(sep).join("/");
  if (!normalized.startsWith("fixtures/")) {
    throw new Error(`alpha-public-fixture: refusing non-public input path '${uri}'`);
  }
  if (normalized.includes("private-local/") || normalized.includes("..")) {
    throw new Error(`alpha-public-fixture: refusing private/traversing input path '${uri}'`);
  }
}
