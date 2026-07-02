/*
 * ALPHA-007 (reopen: alpha-public-fixture-real-proof) — the public-fixture
 * Utsushi runtime REPLAY ENGINE.
 *
 * STRICT PROOF: the runtime-observation proof must be a REAL run's observed
 * output, never a checked-in JSON re-emitted. The previous composition copied
 * `status` + trace counts straight out of the committed `runtime_report`
 * fixture — recorded JSON masquerading as a runtime proof.
 *
 * This module instead EXECUTES the fixture. It renders the localized runtime
 * script from the ACTUAL patch bytes applied over the ACTUAL bridge source
 * bytes:
 *
 *   - the committed Utsushi `runtime_report` is used ONLY as the scene LOG
 *     (the deterministic runtime timeline: which unit renders at which frame,
 *     the branch structure, and the selected option) — none of its observed
 *     TEXT, status, or counts are trusted;
 *   - for every scene event the engine looks up the bridge source unit
 *     (source text + protected spans) and the patch-export entry (target text)
 *     and RENDERS the observed line = the patched target text, verifying that
 *     every protected span survives and that the source was actually localized
 *     (target != source);
 *   - status, trace/branch/observed-line counts, and a `renderHash` over the
 *     produced render are DERIVED FROM THAT EXECUTION.
 *
 * The scene log's recorded observed text is then compared against the freshly
 * rendered text as a fidelity ORACLE (a divergence is a structured finding),
 * so the committed report is checked, not re-emitted.
 *
 * The `assertRuntimeProofIsRealRun` guard re-executes the render and rejects
 * any runtime-observation proof whose `renderHash` (ARTIFACT BYTES) does not
 * reproduce a genuine, localized, span-preserving execution — a placeholder or
 * re-emitted record cannot pass.
 *
 * Plain Node ESM, self-contained (no import from vertical.mjs, so vertical.mjs
 * can import this without a cycle).
 */
"use strict";

import { createHash } from "node:crypto";

export const REPLAY_ADAPTER_NAME = "utsushi-public-fixture-replay";
export const REPLAY_ADAPTER_VERSION = "0.2.0";
// A deterministic text replay yields trace-level (E1 / trace_only) evidence:
// observed dialogue/UI text, not screenshot or reference-runtime pixels.
export const REPLAY_EVIDENCE_TIER = "E1";
export const REPLAY_FIDELITY_TIER = "trace_only";

const RENDERED_TEXT_EVENT_KIND = "text_observed";

const BLOCKING = "blocking";

function finding(code, severity, subject, message) {
  return { code, severity, subject, message };
}

function sha256OfBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// Deterministic, key-sorted JSON so the render hash is stable across runs.
function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

function indexBy(list, keyFn) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const key = keyFn(item);
    if (key !== undefined && key !== null) map.set(key, item);
  }
  return map;
}

/**
 * Render one runtime line by EXECUTING the patch over the source unit.
 * Returns the observed (localized) text plus the render diagnostics: whether
 * the patch was applied, whether the source was actually localized, and any
 * protected span that the render dropped.
 */
function renderUnit(sourceUnit, patchEntry) {
  const sourceText = typeof sourceUnit?.sourceText === "string" ? sourceUnit.sourceText : null;
  if (patchEntry === undefined || patchEntry === null) {
    // No patch -> the runtime shows the untranslated source (a leak).
    return {
      observedText: sourceText ?? "",
      localized: false,
      missingPatch: true,
      spanViolations: [],
    };
  }
  const observedText = typeof patchEntry.targetText === "string" ? patchEntry.targetText : "";
  const spans = Array.isArray(sourceUnit?.spans) ? sourceUnit.spans : [];
  const spanViolations = spans
    .map((s) => (typeof s?.raw === "string" ? s.raw : null))
    .filter((raw) => raw !== null && raw.length > 0 && !observedText.includes(raw));
  const localized = observedText.length > 0 && observedText !== sourceText;
  return { observedText, localized, missingPatch: false, spanViolations };
}

/**
 * Execute the public fixture through the deterministic Utsushi replay engine.
 *
 * @param {object} args
 * @param {object} args.bridge          loaded bridge_bundle artifact ({ ref, content, actualHash })
 * @param {object} args.patchExport     loaded patch_export artifact
 * @param {object} args.runtimeSceneLog loaded runtime_report artifact — used as the scene log ONLY
 * @param {object} args.proof           the SHARED-025 proof manifest (for fixtureId / runtimeTargetIds)
 * @returns produced runtime observation (status, counts, render, hashes, findings, provenance)
 */
export function replayFixtureRuntime({ bridge, patchExport, runtimeSceneLog, proof }) {
  const bridgeUnits = Array.isArray(bridge?.content?.units) ? bridge.content.units : [];
  const patchEntries = Array.isArray(patchExport?.content?.entries)
    ? patchExport.content.entries
    : [];
  const scene = runtimeSceneLog?.content ?? {};

  const sourceByKey = indexBy(bridgeUnits, (u) => u.sourceUnitKey);
  const patchByKey = indexBy(patchEntries, (e) => e.sourceUnitKey);

  const findings = [];
  const producedTraceEvents = [];
  const renderLines = [];
  let untranslatedLeakCount = 0;
  let emptyLineCount = 0;
  let spanViolationCount = 0;
  let missingUnitCount = 0;
  let divergenceCount = 0;

  const traceEvents = Array.isArray(scene.traceEvents) ? scene.traceEvents : [];
  for (const ev of traceEvents) {
    const key = ev.bridgeUnitRef?.sourceUnitKey;
    const sourceUnit = sourceByKey.get(key);
    if (sourceUnit === undefined) {
      missingUnitCount += 1;
      producedTraceEvents.push({
        traceKey: ev.traceKey ?? null,
        sourceUnitKey: key ?? null,
        eventKind: ev.eventKind ?? null,
        frame: ev.frame ?? null,
        missingUnit: true,
      });
      findings.push(
        finding(
          "runtime.unsupported_unit",
          BLOCKING,
          "runtimeObservation",
          `scene event references sourceUnitKey='${key}' which is absent from the bridge source; the runtime cannot render it`,
        ),
      );
      continue;
    }
    if (ev.eventKind === RENDERED_TEXT_EVENT_KIND) {
      const r = renderUnit(sourceUnit, patchByKey.get(key));
      if (r.missingPatch || !r.localized) untranslatedLeakCount += 1;
      if (r.observedText.length === 0) emptyLineCount += 1;
      spanViolationCount += r.spanViolations.length;
      if (typeof ev.observedText === "string" && ev.observedText !== r.observedText) {
        divergenceCount += 1;
        findings.push(
          finding(
            "runtime.render_divergence",
            BLOCKING,
            "runtimeObservation",
            `rendered observed text for '${ev.traceKey}' ('${r.observedText}') diverges from the recorded scene-log oracle ('${ev.observedText}')`,
          ),
        );
      }
      producedTraceEvents.push({
        traceKey: ev.traceKey ?? null,
        sourceUnitKey: key,
        eventKind: ev.eventKind,
        frame: ev.frame ?? null,
        observedText: r.observedText,
      });
      renderLines.push({
        traceKey: ev.traceKey ?? null,
        sourceUnitKey: key,
        observedText: r.observedText,
      });
    } else {
      // Structural (e.g. branch_point_reached): no text is rendered here.
      producedTraceEvents.push({
        traceKey: ev.traceKey ?? null,
        sourceUnitKey: key,
        eventKind: ev.eventKind ?? null,
        frame: ev.frame ?? null,
      });
    }
  }

  const producedBranchEvents = [];
  const branchEvents = Array.isArray(scene.branchEvents) ? scene.branchEvents : [];
  for (const be of branchEvents) {
    const options = (Array.isArray(be.options) ? be.options : []).map((opt) => {
      const key = opt.labelBridgeUnitRef?.sourceUnitKey;
      const sourceUnit = sourceByKey.get(key);
      if (sourceUnit === undefined) {
        missingUnitCount += 1;
        findings.push(
          finding(
            "runtime.unsupported_unit",
            BLOCKING,
            "runtimeObservation",
            `branch option references sourceUnitKey='${key}' which is absent from the bridge source`,
          ),
        );
        return { optionId: opt.optionId ?? null, sourceUnitKey: key ?? null, label: "" };
      }
      const r = renderUnit(sourceUnit, patchByKey.get(key));
      if (r.missingPatch || !r.localized) untranslatedLeakCount += 1;
      spanViolationCount += r.spanViolations.length;
      if (typeof opt.label === "string" && opt.label !== r.observedText) {
        divergenceCount += 1;
        findings.push(
          finding(
            "runtime.render_divergence",
            BLOCKING,
            "runtimeObservation",
            `rendered branch option label for '${key}' ('${r.observedText}') diverges from the recorded scene-log oracle ('${opt.label}')`,
          ),
        );
      }
      return {
        optionId: opt.optionId ?? null,
        sourceUnitKey: key,
        label: r.observedText,
        targetRouteKey: opt.targetRouteKey ?? null,
      };
    });
    const selected = options.find((o) => o.optionId === be.selectedOptionId) ?? null;
    producedBranchEvents.push({
      branchPointKey: be.branchPointKey ?? null,
      selectedOptionId: be.selectedOptionId ?? null,
      selectedLabel: selected?.label ?? null,
      options,
    });
  }

  const observedTextLineCount = renderLines.filter(
    (l) => typeof l.observedText === "string" && l.observedText.length > 0,
  ).length;

  let status;
  if (missingUnitCount > 0) {
    status = "unsupported";
  } else if (
    untranslatedLeakCount > 0 ||
    emptyLineCount > 0 ||
    spanViolationCount > 0 ||
    divergenceCount > 0
  ) {
    status = "failed";
  } else {
    status = "passed";
  }

  // ---- Artifact bytes: the produced localized render ----
  const fixtureId = proof?.fixture?.fixtureId ?? null;
  const sourceLocale = bridge?.content?.sourceLocale ?? null;
  const targetLocale = patchExport?.content?.targetLocale ?? null;
  const renderContent = {
    fixtureId,
    sourceLocale,
    targetLocale,
    lines: renderLines.map((l) => ({
      traceKey: l.traceKey,
      sourceUnitKey: l.sourceUnitKey,
      observedText: l.observedText,
    })),
    branches: producedBranchEvents.map((b) => ({
      branchPointKey: b.branchPointKey,
      selectedLabel: b.selectedLabel,
      options: b.options.map((o) => ({ sourceUnitKey: o.sourceUnitKey, label: o.label })),
    })),
  };
  const renderHash = sha256OfBytes(Buffer.from(stableStringify(renderContent), "utf8"));

  // The render you'd get with NO localization applied (observed == source).
  // Used by the guard to REJECT an untranslated placeholder proof.
  const untranslatedRenderContent = {
    fixtureId,
    sourceLocale,
    targetLocale,
    lines: renderLines.map((l) => ({
      traceKey: l.traceKey,
      sourceUnitKey: l.sourceUnitKey,
      observedText: sourceByKey.get(l.sourceUnitKey)?.sourceText ?? "",
    })),
    branches: producedBranchEvents.map((b) => ({
      branchPointKey: b.branchPointKey,
      selectedLabel:
        sourceByKey.get(b.options.find((o) => o.optionId === b.selectedOptionId)?.sourceUnitKey)
          ?.sourceText ?? null,
      options: b.options.map((o) => ({
        sourceUnitKey: o.sourceUnitKey,
        label: sourceByKey.get(o.sourceUnitKey)?.sourceText ?? "",
      })),
    })),
  };
  const untranslatedRenderHash = sha256OfBytes(
    Buffer.from(stableStringify(untranslatedRenderContent), "utf8"),
  );

  return {
    status,
    producedTraceEvents,
    producedBranchEvents,
    renderLines,
    renderHash,
    untranslatedRenderHash,
    counts: {
      traceEventCount: producedTraceEvents.length,
      branchEventCount: producedBranchEvents.length,
      observedTextLineCount,
      untranslatedLeakCount,
      emptyLineCount,
      spanViolationCount,
      missingUnitCount,
      divergenceCount,
    },
    provenance: {
      // Scene-log identity: this is the runtime timeline the engine executed,
      // recorded as INPUT provenance (not the source of the proof values).
      runtimeReportId: runtimeSceneLog?.content?.runtimeReportId ?? null,
      runtimeReportUri: runtimeSceneLog?.ref?.uri ?? null,
      runtimeReportHash: runtimeSceneLog?.actualHash ?? null,
      sourceLocale,
      targetLocale,
    },
    adapter: {
      name: REPLAY_ADAPTER_NAME,
      version: REPLAY_ADAPTER_VERSION,
      evidenceTier: REPLAY_EVIDENCE_TIER,
      fidelityTier: REPLAY_FIDELITY_TIER,
    },
    findings,
  };
}

/**
 * Placeholder-rejection GUARD — verifies ARTIFACT BYTES.
 *
 * Re-executes the fixture and rejects any runtime-observation proof whose
 * produced render (its `renderHash`) is not the genuine product of executing
 * the patch over the bridge source:
 *
 *   - `runtime.render_not_reproducible` — the proof's renderHash does not equal
 *     a fresh execution (a re-emitted record or hand-stubbed proof);
 *   - `runtime.render_placeholder` — the render equals the untranslated source
 *     render, or contains untranslated leaks / empty lines (no real
 *     localization);
 *   - `runtime.protected_span_violation` — the render dropped a protected span;
 *   - `runtime.counts_not_produced` — the proof's counts disagree with the
 *     executed run.
 *
 * Returns { run, findings }. An empty findings array means the proof is a
 * genuinely-produced runtime observation; any blocking finding REJECTS it.
 */
export function assertRuntimeProofIsRealRun(runtimeObservationProof, inputs) {
  const run = replayFixtureRuntime(inputs);
  const findings = [];

  const claimedHash = runtimeObservationProof?.renderHash ?? null;
  if (claimedHash !== run.renderHash) {
    findings.push(
      finding(
        "runtime.render_not_reproducible",
        BLOCKING,
        "runtimeObservation",
        `runtime observation renderHash '${claimedHash}' does not reproduce a fresh execution ('${run.renderHash}'); the proof is a re-emitted or placeholder record, not a real run`,
      ),
    );
    // A non-reproducible render can't be trusted for the deeper checks.
    return { run, findings };
  }

  if (run.renderHash === run.untranslatedRenderHash) {
    findings.push(
      finding(
        "runtime.render_placeholder",
        BLOCKING,
        "runtimeObservation",
        "runtime observation render equals the untranslated source render; no localization was applied (placeholder)",
      ),
    );
  }
  if (run.counts.untranslatedLeakCount > 0 || run.counts.emptyLineCount > 0) {
    findings.push(
      finding(
        "runtime.render_placeholder",
        BLOCKING,
        "runtimeObservation",
        `runtime observation render has ${run.counts.untranslatedLeakCount} untranslated leak(s) and ${run.counts.emptyLineCount} empty line(s); not a genuine localized render`,
      ),
    );
  }
  if (run.counts.spanViolationCount > 0) {
    findings.push(
      finding(
        "runtime.protected_span_violation",
        BLOCKING,
        "runtimeObservation",
        `runtime observation render dropped ${run.counts.spanViolationCount} protected span(s)`,
      ),
    );
  }
  if (
    runtimeObservationProof.traceEventCount !== run.counts.traceEventCount ||
    runtimeObservationProof.branchEventCount !== run.counts.branchEventCount ||
    runtimeObservationProof.observedTextLineCount !== run.counts.observedTextLineCount ||
    runtimeObservationProof.status !== run.status
  ) {
    findings.push(
      finding(
        "runtime.counts_not_produced",
        BLOCKING,
        "runtimeObservation",
        `runtime observation status/counts disagree with the executed run (proof status=${runtimeObservationProof.status} traces=${runtimeObservationProof.traceEventCount} branches=${runtimeObservationProof.branchEventCount} lines=${runtimeObservationProof.observedTextLineCount}; run status=${run.status} traces=${run.counts.traceEventCount} branches=${run.counts.branchEventCount} lines=${run.counts.observedTextLineCount})`,
      ),
    );
  }

  return { run, findings };
}
