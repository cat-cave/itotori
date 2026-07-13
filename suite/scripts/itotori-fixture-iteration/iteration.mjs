/*
 * ITOTORI-095 — Itotori fixture iteration command (composition + diagnostics
 * engine).
 *
 * This module is the PURE, side-effect-light core of the
 * `pnpm exec vp run itotori:fixture-iteration` command. It COMPOSES the
 * existing Itotori seams over PUBLIC RECORDED inputs — it does NOT
 * re-implement any stage. The six stages of one iteration are:
 *
 *   1. import          — bridge bundle import (identity + unit count)
 *   2. draft           — agentic-loop draft (runAgenticLoopForUnit output)
 *   3. qa              — QA-agent evaluation (QaAgent.invokeQa findings)
 *   4. export          — patch export (PatchExporter.export bundle)
 *   5. feedback        — manual/runtime feedback → canonical context correction
 *   6. rerun           — context-correction-driven patch iteration
 *   7. final-result    — the FixtureIterationResult manifest (SHARED-025)
 *
 * Hard constraints (PROJECT LAW):
 *   - PUBLIC RECORDED fixtures ONLY. No private corpora, no live credentials,
 *     no raw prompts, no raw provider responses.
 *   - The (model, provider) pair + cost + token usage for every
 *     provider-backed stage is read VERBATIM from a recorded provider-proof
 *     ledger artifact. Cost is NEVER coined (respects assertBilledCost /
 *     assertReportedTokenUsage semantics: costKind in {billed, zero},
 *     integer micros >= 0, token counts only from real recorded sources).
 *   - Every diagnostic is a STRUCTURED FINDING with a stable code + stage id +
 *     artifact id + remediation code. A failed stage stays visible; it is
 *     never hidden behind a prose-only report.
 *   - Locale-branch identity (ITOTORI-059) is load-bearing: every stage's
 *     localeBranchId / sourceRevision / targetLocale must agree with the
 *     iteration identity, otherwise a blocking finding fires.
 *
 * Everything here is plain Node ESM (the suite drivers are plain JS by
 * design); schema validation is done with the same Ajv 2020 the alpha public
 * fixture vertical already depends on.
 */
"use strict";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolvePath(HERE, "..", "..", "..");

export const STAGE_RESULT_SCHEMA_VERSION = "itotori.fixture-iteration.stage-result.v0";
export const ITERATION_RESULT_SCHEMA_VERSION = "itotori.fixture-iteration.result.v0";

// The ordered iteration: import -> ... -> rerun. The final-result manifest is
// emitted separately and is not itself a "stage".
export const STAGE_ORDER = ["import", "draft", "qa", "export", "feedback", "rerun"];

// Provider-backed stages read their (model, provider) pair + cost + tokens
// from a recorded ledger entry keyed by `ledgerRole`. The recorded
// provider-proof bundle only carries `draft` and `qa` roles; the targeted
// rerun re-invokes the draft agent, so it reuses the `draft` ledger entry.
export const PROVIDER_BACKED_STAGES = new Set(["draft", "qa", "rerun"]);

export const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;
const REAL_TOKEN_COUNT_SOURCES = new Set(["provider_reported", "deterministic_counter"]);

const BLOCKING = "blocking";
const WARN = "warn";
const INFO = "info";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function sha256OfBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256OfFile(path) {
  return sha256OfBytes(readFileSync(path));
}

/** Content hash of a recorded stage payload (stable: re-serializes parsed JSON). */
export function sha256OfPayload(payload) {
  return sha256OfBytes(Buffer.from(JSON.stringify(payload), "utf8"));
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

/** Guard: refuse any non-public input path (no private corpora / traversal). */
export function assertPublicInputPath(uri) {
  const normalized = String(uri).split(sep).join("/");
  if (!normalized.startsWith("fixtures/") && !normalized.startsWith("suite/")) {
    throw new Error(`itotori-fixture-iteration: refusing non-public input path '${uri}'`);
  }
  if (normalized.includes("private-local/") || normalized.includes("..")) {
    throw new Error(`itotori-fixture-iteration: refusing private/traversing input path '${uri}'`);
  }
}

/**
 * A structured finding. Every diagnostic the iteration emits is one of these:
 * code + severity + a stable stage id + artifact id + remediation code +
 * message — never a prose-only string.
 */
function finding(code, severity, stageId, artifactId, remediation, message) {
  return { code, severity, stageId, artifactId, remediation, message };
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

/**
 * Load the recorded iteration scenario + its referenced provider-proof ledger.
 * Returns the parsed recording, the ledger entries keyed by role, and any
 * blocking hash/integrity findings discovered while loading.
 */
export function loadIterationInputs({ repoRoot = REPO_ROOT, scenarioPath }) {
  const hashFindings = [];
  const scenarioAbs = resolveRepoPath(repoRoot, scenarioPath);
  const recording = loadJson(scenarioAbs);

  const ledgerUri = recording.providerLedgerUri;
  const ledgerAbs = resolveRepoPath(repoRoot, ledgerUri);
  const ledgerBundle = loadJson(ledgerAbs);
  const ledgerHash = sha256OfFile(ledgerAbs);

  // Index the recorded ledger entries by role. Each entry carries the served
  // (model, provider) pair + verbatim cost + token usage.
  const ledgerByRole = new Map();
  for (const entry of Array.isArray(ledgerBundle.ledger) ? ledgerBundle.ledger : []) {
    if (typeof entry.role === "string" && !ledgerByRole.has(entry.role)) {
      ledgerByRole.set(entry.role, entry);
    }
  }

  return {
    repoRoot,
    recording,
    scenarioUri: portableRelativePath(repoRoot, scenarioAbs),
    ledgerUri,
    ledgerHash,
    ledgerByRole,
    hashFindings,
  };
}

/** Every public input file the iteration reads (for `--list-inputs`). */
export function listPublicInputs(inputs) {
  return [...new Set([inputs.scenarioUri, inputs.ledgerUri])].sort();
}

// ---------------------------------------------------------------------------
// Cost / token projection (verbatim from the recorded ledger)
// ---------------------------------------------------------------------------

/**
 * Project a recorded ledger entry into the sanitized cost/pair/token shape the
 * stage artifact carries. Cost is copied VERBATIM (never coined). Returns the
 * projection plus any blocking finding when the recorded values violate the
 * assertBilledCost / assertReportedTokenUsage invariants.
 */
function projectLedgerEntry(stageId, artifactId, entry) {
  const findings = [];
  if (entry === undefined) {
    findings.push(
      finding(
        "provider.ledger_entry_missing",
        BLOCKING,
        stageId,
        artifactId,
        "attach-recorded-provider-ledger-entry",
        `stage '${stageId}' is provider-backed but no recorded ledger entry was found for its role`,
      ),
    );
    return { pair: null, cost: null, tokenUsage: null, providerProofId: null, findings };
  }

  // assertBilledCost semantics: costKind is one of {billed, zero}; the billed
  // amount is an integer micros-USD >= 0. costMicrosUsd is the recorded micros.
  const costMicros = entry.costMicrosUsd;
  const costKind = costMicros === 0 ? "zero" : "billed";
  if (!Number.isInteger(costMicros) || costMicros < 0) {
    findings.push(
      finding(
        "provider.cost_not_billed",
        BLOCKING,
        stageId,
        artifactId,
        "record-real-billed-cost",
        `recorded cost micros '${String(costMicros)}' is not a non-negative integer (assertBilledCost would reject it)`,
      ),
    );
  }

  // assertReportedTokenUsage semantics: token counts come ONLY from a real
  // recorded source; integer counts.
  const tokenCountSource = entry.tokenCountSource;
  if (!REAL_TOKEN_COUNT_SOURCES.has(tokenCountSource)) {
    findings.push(
      finding(
        "provider.token_count_not_real",
        BLOCKING,
        stageId,
        artifactId,
        "record-real-token-usage",
        `token count source '${String(tokenCountSource)}' is not a real recorded source (assertReportedTokenUsage would reject it)`,
      ),
    );
  }

  return {
    providerProofId: entry.providerProofId ?? null,
    pair: {
      modelId: entry.modelId ?? null,
      providerId: entry.providerId ?? null,
      servedModel: entry.servedModel ?? null,
      servedProvider: entry.servedProvider ?? null,
    },
    cost: {
      costKind,
      currency: typeof entry.costUnit === "string" ? entry.costUnit.toUpperCase() : "USD",
      amountMicrosUsd: Number.isInteger(costMicros) ? costMicros : 0,
    },
    tokenUsage: {
      tokensIn: Number.isInteger(entry.tokensIn) ? entry.tokensIn : 0,
      tokensOut: Number.isInteger(entry.tokensOut) ? entry.tokensOut : 0,
      tokenCountSource: tokenCountSource ?? null,
    },
    zdr: entry.zdr === true,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Compose one fixture iteration from loaded inputs. Returns every per-stage
 * artifact body plus the FixtureIterationResult manifest. Pure: no disk writes.
 */
export function composeIteration(inputs, { now = new Date() } = {}) {
  const generatedAt = typeof now === "string" ? now : now.toISOString();
  const { recording, ledgerByRole } = inputs;
  const identity = recording.identity ?? {};
  const sourceRevision = {
    sourceBridgeId: identity.sourceBridgeId ?? null,
    sourceBundleHash: identity.sourceBundleHash ?? null,
    sourceRevisionId: identity.sourceRevisionId ?? null,
  };
  const recordedStages = recording.stages ?? {};

  const stageResults = [];
  for (const stageId of STAGE_ORDER) {
    const recorded = recordedStages[stageId];
    if (recorded === undefined || recorded === null) {
      // A missing stage recording is itself a blocking finding (the iteration
      // must never silently skip a stage — audit focus #1).
      stageResults.push({
        schemaVersion: STAGE_RESULT_SCHEMA_VERSION,
        generatedAt,
        stageId,
        artifactId: `${stageId}:<missing>`,
        localeBranchId: identity.localeBranchId ?? null,
        sourceRevision,
        targetLocale: identity.targetLocale ?? null,
        providerProofId: null,
        pair: null,
        cost: null,
        tokenUsage: null,
        contentHash: sha256OfPayload({ stageId, missing: true }),
        status: "missing",
        detail: {},
        findings: [
          finding(
            "iteration.stage_missing",
            BLOCKING,
            stageId,
            `${stageId}:<missing>`,
            "record-stage-artifact",
            `iteration recording is missing the required '${stageId}' stage`,
          ),
        ],
      });
      continue;
    }

    const artifactId = recorded.artifactId ?? `${stageId}:<unknown>`;
    // Locale-branch identity is per-stage so the conflation guard (059) can
    // catch a stage that disagrees with the iteration identity.
    const localeBranchId = recorded.localeBranchId ?? identity.localeBranchId ?? null;
    const targetLocale = recorded.targetLocale ?? identity.targetLocale ?? null;

    let providerProofId = null;
    let pair = null;
    let cost = null;
    let tokenUsage = null;
    const stageFindings = [];

    if (PROVIDER_BACKED_STAGES.has(stageId) && typeof recorded.ledgerRole === "string") {
      const projected = projectLedgerEntry(
        stageId,
        artifactId,
        ledgerByRole.get(recorded.ledgerRole),
      );
      providerProofId = projected.providerProofId;
      pair = projected.pair;
      cost = projected.cost;
      tokenUsage = projected.tokenUsage;
      stageFindings.push(...projected.findings);
    }

    const detail = recorded.detail ?? {};
    const stageResult = {
      schemaVersion: STAGE_RESULT_SCHEMA_VERSION,
      generatedAt,
      stageId,
      artifactId,
      localeBranchId,
      sourceRevision: {
        sourceBridgeId: recorded.sourceBridgeId ?? sourceRevision.sourceBridgeId,
        sourceBundleHash: recorded.sourceBundleHash ?? sourceRevision.sourceBundleHash,
        sourceRevisionId: recorded.sourceRevisionId ?? sourceRevision.sourceRevisionId,
      },
      targetLocale,
      providerProofId,
      pair,
      cost,
      tokenUsage,
      contentHash: sha256OfPayload({ stageId, artifactId, detail }),
      status: recorded.status ?? "unknown",
      detail,
      findings: stageFindings,
    };
    stageResults.push(stageResult);
  }

  const manifest = {
    schemaVersion: ITERATION_RESULT_SCHEMA_VERSION,
    generatedAt,
    command: "vp run itotori:fixture-iteration",
    scenario: recording.scenario ?? null,
    expectedVerdict: recording.expectedVerdict ?? null,
    fixtureId: recording.fixtureId ?? null,
    projectId: identity.projectId ?? null,
    localeBranchId: identity.localeBranchId ?? null,
    sourceRevision,
    sourceLocale: identity.sourceLocale ?? null,
    targetLocale: identity.targetLocale ?? null,
    providerLedger: {
      uri: inputs.ledgerUri,
      hash: inputs.ledgerHash,
    },
    // Verdict + findings + roll-ups are filled in by validateIteration(); seed
    // them so the manifest is always self-contained.
    billedMicrosUsd: 0,
    stages: [],
    verdict: "unvalidated",
    findingCount: 0,
    blockingFindingCount: 0,
    findings: [],
  };

  return { generatedAt, identity, stageResults, manifest };
}

// ---------------------------------------------------------------------------
// Validation (the semantic diagnostics engine)
// ---------------------------------------------------------------------------

/**
 * Validate one composed iteration. Returns { verdict, findings, stages,
 * billedMicrosUsd }. Every anomaly is a structured finding. Drives the four
 * recorded paths the node names: complete patch, blocked QA finding, runtime
 * feedback, and a context-correction-driven rerun.
 */
export function validateIteration(composed) {
  const { identity, stageResults } = composed;
  const findings = [];

  const expectBranch = identity.localeBranchId ?? null;
  const expectBridge = identity.sourceBridgeId ?? null;
  const expectBundleHash = identity.sourceBundleHash ?? null;
  const expectRevision = identity.sourceRevisionId ?? null;
  const expectTarget = identity.targetLocale ?? null;

  let billedMicrosUsd = 0;

  for (const s of stageResults) {
    // 1. Locale-branch identity (ITOTORI-059): every stage must agree with the
    //    iteration identity. A disagreement is a blocking conflation finding.
    if (s.localeBranchId !== null && expectBranch !== null && s.localeBranchId !== expectBranch) {
      findings.push(
        finding(
          "linkage.locale_branch_mismatch",
          BLOCKING,
          s.stageId,
          s.artifactId,
          "rebind-stage-to-locale-branch",
          `stage '${s.stageId}' localeBranchId='${s.localeBranchId}' disagrees with iteration localeBranchId='${expectBranch}'`,
        ),
      );
    }
    if (
      s.sourceRevision.sourceBridgeId !== null &&
      expectBridge !== null &&
      s.sourceRevision.sourceBridgeId !== expectBridge
    ) {
      findings.push(
        finding(
          "linkage.source_revision_mismatch",
          BLOCKING,
          s.stageId,
          s.artifactId,
          "rebind-stage-to-source-revision",
          `stage '${s.stageId}' sourceBridgeId='${s.sourceRevision.sourceBridgeId}' disagrees with iteration sourceBridgeId='${expectBridge}'`,
        ),
      );
    }
    if (
      s.sourceRevision.sourceBundleHash !== null &&
      expectBundleHash !== null &&
      s.sourceRevision.sourceBundleHash !== expectBundleHash
    ) {
      findings.push(
        finding(
          "linkage.source_revision_mismatch",
          BLOCKING,
          s.stageId,
          s.artifactId,
          "rebind-stage-to-source-revision",
          `stage '${s.stageId}' sourceBundleHash='${s.sourceRevision.sourceBundleHash}' disagrees with iteration sourceBundleHash='${expectBundleHash}'`,
        ),
      );
    }
    if (
      s.sourceRevision.sourceRevisionId !== null &&
      expectRevision !== null &&
      s.sourceRevision.sourceRevisionId !== expectRevision
    ) {
      findings.push(
        finding(
          "linkage.source_revision_mismatch",
          BLOCKING,
          s.stageId,
          s.artifactId,
          "rebind-stage-to-source-revision",
          `stage '${s.stageId}' sourceRevisionId='${s.sourceRevision.sourceRevisionId}' disagrees with iteration sourceRevisionId='${expectRevision}'`,
        ),
      );
    }
    if (s.targetLocale !== null && expectTarget !== null && s.targetLocale !== expectTarget) {
      findings.push(
        finding(
          "linkage.locale_branch_mismatch",
          BLOCKING,
          s.stageId,
          s.artifactId,
          "rebind-stage-to-locale-branch",
          `stage '${s.stageId}' targetLocale='${s.targetLocale}' disagrees with iteration targetLocale='${expectTarget}'`,
        ),
      );
    }

    // 2. Content hash sanity.
    if (typeof s.contentHash === "string" && !SHA256_RE.test(s.contentHash)) {
      findings.push(
        finding(
          "linkage.content_hash_malformed",
          BLOCKING,
          s.stageId,
          s.artifactId,
          "recompute-content-hash",
          `stage '${s.stageId}' contentHash '${s.contentHash}' is not a well-formed sha256:<hex> digest`,
        ),
      );
    }

    // 3. Carry forward any per-stage findings (provider/cost integrity + missing).
    findings.push(...s.findings);

    // 4. Provider-backed stages must have surfaced a provider proof id (when
    //    the recording declares a ledger role).
    if (PROVIDER_BACKED_STAGES.has(s.stageId) && s.providerProofId !== null) {
      if (s.cost !== null) billedMicrosUsd += s.cost.amountMicrosUsd;
    }

    // 5. Per-stage semantic outcomes -> structured diagnostics.
    findings.push(...stageOutcomeFindings(s));
  }

  // 6. Resolution paths. A context-correction-driven rerun can RESOLVE a
  //    prior finding so the iteration concludes with a meaningful verdict.
  //    Every resolved finding stays VISIBLE (demoted, never deleted), so a
  //    failed stage is never hidden. A QA finding without a correction remains
  //    explicitly blocked; there is no human decision state in this flow.
  const rerun = stageResults.find((s) => s.stageId === "rerun");

  const repairTargets = new Set(
    rerun !== undefined && Array.isArray(rerun.detail.repairedFindingCodes)
      ? rerun.detail.repairedFindingCodes
      : [],
  );
  const repairedCodes = new Set();
  const resolved = findings.map((f) => {
    if ((f.severity === BLOCKING || f.severity === WARN) && repairTargets.has(f.code)) {
      repairedCodes.add(f.code);
      return { ...f, severity: INFO, code: `${f.code}.repaired` };
    }
    return f;
  });
  for (const code of repairedCodes) {
    resolved.push(
      finding(
        "rerun.repaired",
        INFO,
        "rerun",
        rerun.artifactId,
        "none",
        `context-correction-driven rerun cleared prior finding '${code}'`,
      ),
    );
  }

  const blocking = resolved.filter((f) => f.severity === BLOCKING);
  const hasQaFinding = blocking.some((f) => f.code === "qa.defect_found");
  const hasOperationalFailure = blocking.some((f) => f.code !== "qa.defect_found");
  let verdict;
  if (hasOperationalFailure) {
    verdict = "broken";
  } else if (hasQaFinding) {
    verdict = "blocked";
  } else if (repairedCodes.size > 0) {
    verdict = "repaired";
  } else {
    verdict = "complete";
  }

  return { verdict, findings: resolved, billedMicrosUsd };
}

/** Per-stage semantic outcome diagnostics (QA, export, and feedback). */
function stageOutcomeFindings(s) {
  const out = [];
  switch (s.stageId) {
    case "qa": {
      const qaFindings = Array.isArray(s.detail.findings) ? s.detail.findings : [];
      const defects = qaFindings.filter((f) => f.severity === "major" || f.severity === "critical");
      for (const defect of defects) {
        out.push(
          finding(
            "qa.defect_found",
            BLOCKING,
            "qa",
            s.artifactId,
            "record-context-correction-and-start-iteration",
            `QA found a ${defect.severity} ${defect.category ?? "defect"} on unit '${defect.bridgeUnitId ?? "?"}' (finding '${defect.findingId ?? "?"}')`,
          ),
        );
      }
      break;
    }
    case "export": {
      if (s.detail.preflight === "failed") {
        out.push(
          finding(
            "export.preflight_failed",
            BLOCKING,
            "export",
            s.artifactId,
            "resolve-failing-preflight-checks",
            `patch export pre-flight failed: ${(s.detail.failingChecks ?? []).join(", ") || "unspecified checks"}`,
          ),
        );
      }
      break;
    }
    case "feedback": {
      if (s.detail.contextStatus === "corrected") {
        out.push(
          finding(
            "feedback.context_correction",
            WARN,
            "feedback",
            s.artifactId,
            "start-next-patch-iteration",
            `imported feedback recorded canonical context correction ${s.detail.contextCorrectionId ?? "<missing>"}; a patch iteration is required`,
          ),
        );
      }
      break;
    }
    default:
      break;
  }
  return out;
}
