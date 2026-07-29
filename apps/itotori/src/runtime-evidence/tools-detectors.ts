// Pure runtime-evidence finding detectors shared by tools and checks.

import { createHash } from "node:crypto";
import type {
  RuntimeBranchPointEventV02,
  RuntimeCaptureV02,
  RuntimeEvidenceReportV02,
} from "@itotori/localization-bridge-schema";
import type { RuntimeEvidenceArtifactStore } from "./artifact-store.js";
import type {
  ManagedArtifactRef,
  RuntimeBranchExpectation,
  RuntimeEvidenceBacking,
  RuntimeEvidenceCitation,
  RuntimeEvidenceFinding,
  RuntimeEvidenceFindingKind,
  RuntimeEvidenceSeverity,
  RuntimeUnitExpectation,
  ScreenshotOcrArtifact,
} from "./shapes.js";

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function findingId(kind: string, reportId: string, key: string): string {
  const suffix = createHash("sha256")
    .update(`${kind}:${reportId}:${key}`)
    .digest("hex")
    .slice(0, 12);
  return `019ed0aa-0000-7000-8000-${suffix}`;
}

/** The runtime report is itself a managed artifact; cite it as trace/branch. */
function reportCitation(
  reportRef: ManagedArtifactRef,
  citationKind: "report" | "trace" | "branch",
  observationEventId: string | null,
  detail: string,
): RuntimeEvidenceCitation {
  return { citationKind, artifactRef: reportRef, observationEventId, detail };
}

function screenshotCitation(capture: RuntimeCaptureV02, detail: string): RuntimeEvidenceCitation {
  return {
    citationKind: "screenshot",
    artifactRef: {
      artifactId: capture.artifactRef.artifactId,
      artifactKind: capture.artifactRef.artifactKind,
      uri: capture.artifactRef.uri,
      hash: capture.artifactRef.hash ?? null,
    },
    observationEventId: capture.captureId,
    detail,
  };
}

function ocrCitation(
  ocr: ScreenshotOcrArtifact,
  regionId: string,
  detail: string,
): RuntimeEvidenceCitation {
  return {
    citationKind: "ocr",
    artifactRef: {
      artifactId: ocr.artifactId,
      artifactKind: "capture_metadata",
      uri: `artifacts/utsushi/ocr/${ocr.artifactId}.json`,
      hash: null,
    },
    observationEventId: regionId,
    detail,
  };
}

/** Observed text (with the trace event id) for a unit, from trace + hook streams. */
function observedTextForUnit(
  report: RuntimeEvidenceReportV02,
  bridgeUnitId: string,
): { text: string; traceEventId: string } | null {
  for (const event of report.traceEvents) {
    if (
      event.eventKind === "text_observed" &&
      event.bridgeUnitRef.bridgeUnitId === bridgeUnitId &&
      typeof event.observedText === "string" &&
      event.observedText.length > 0
    ) {
      return { text: event.observedText, traceEventId: event.traceEventId };
    }
  }
  for (const hook of report.observationHookEvents ?? []) {
    if (hook.payload.payloadKind !== "text") {
      continue;
    }
    const cites = (hook.bridgeRefs ?? []).some((ref) => ref.bridgeUnitId === bridgeUnitId);
    if (cites && hook.payload.text.length > 0) {
      return { text: hook.payload.text, traceEventId: hook.eventId };
    }
  }
  return null;
}

function captureForUnit(
  report: RuntimeEvidenceReportV02,
  bridgeUnitId: string,
): RuntimeCaptureV02 | null {
  return (
    report.captures.find((capture) => capture.bridgeUnitRef.bridgeUnitId === bridgeUnitId) ?? null
  );
}

function branchSelectedRouteKey(branch: RuntimeBranchPointEventV02): string | null {
  if (branch.selectedOptionId === undefined) {
    return null;
  }
  const option = branch.options.find((opt) => opt.optionId === branch.selectedOptionId);
  return option?.targetRouteKey ?? null;
}

function severityToJson(severity: RuntimeEvidenceSeverity): RuntimeEvidenceSeverity {
  return severity;
}

export function detectMissingText(
  report: RuntimeEvidenceReportV02,
  reportRef: ManagedArtifactRef,
  expectedUnits: ReadonlyArray<RuntimeUnitExpectation>,
): RuntimeEvidenceFinding[] {
  const findings: RuntimeEvidenceFinding[] = [];
  for (const unit of expectedUnits) {
    const observed = observedTextForUnit(report, unit.bridgeUnitId);
    if (observed !== null) {
      continue;
    }
    findings.push({
      findingId: findingId("missing_text", report.runtimeReportId, unit.bridgeUnitId),
      findingKind: "missing_text" satisfies RuntimeEvidenceFindingKind,
      severity: severityToJson("major"),
      detectorKind: "deterministic_check",
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      message: `Bridge unit ${unit.sourceUnitKey} was expected to render but produced no observed runtime text.`,
      expected: "observed runtime text for this unit",
      observed: null,
      evidenceBacking: "trace" satisfies RuntimeEvidenceBacking,
      citations: [
        reportCitation(
          reportRef,
          "trace",
          null,
          `no text_observed trace event or text observation hook references bridge unit ${unit.bridgeUnitId} in report ${report.runtimeReportId}`,
        ),
      ],
    });
  }
  return findings;
}

export function detectWrongBranch(
  report: RuntimeEvidenceReportV02,
  reportRef: ManagedArtifactRef,
  expectedBranches: ReadonlyArray<RuntimeBranchExpectation>,
): RuntimeEvidenceFinding[] {
  const byKey = new Map<string, RuntimeBranchExpectation>();
  for (const branch of expectedBranches) {
    byKey.set(branch.branchPointKey, branch);
  }
  const findings: RuntimeEvidenceFinding[] = [];
  for (const branch of report.branchEvents) {
    const key = branch.branchPointKey;
    if (key === undefined) {
      continue;
    }
    const expectation = byKey.get(key);
    if (expectation === undefined) {
      continue;
    }
    const selectedRoute = branchSelectedRouteKey(branch);
    if (selectedRoute === null || expectation.allowedRouteKeys.includes(selectedRoute)) {
      continue;
    }
    const capture = captureForUnit(report, branch.bridgeUnitRef.bridgeUnitId);
    const citations: RuntimeEvidenceCitation[] = [
      reportCitation(
        reportRef,
        "branch",
        branch.branchEventId,
        `branch ${key} selected option resolved to route '${selectedRoute}', not in allowed [${expectation.allowedRouteKeys.join(", ")}]`,
      ),
    ];
    let backing: RuntimeEvidenceBacking = "trace";
    if (capture !== null) {
      citations.push(
        screenshotCitation(capture, `frame ${capture.frame} captured at branch ${key}`),
      );
      backing = "both";
    }
    findings.push({
      findingId: findingId("wrong_branch", report.runtimeReportId, key),
      findingKind: "wrong_branch",
      severity: severityToJson("major"),
      detectorKind: "deterministic_check",
      bridgeUnitId: branch.bridgeUnitRef.bridgeUnitId,
      sourceUnitKey: branch.bridgeUnitRef.sourceUnitKey ?? null,
      message: `Branch ${key} took route '${selectedRoute}', which the expected route map forbids.`,
      expected: `one of [${expectation.allowedRouteKeys.join(", ")}]`,
      observed: selectedRoute,
      evidenceBacking: backing,
      citations,
    });
  }
  return findings;
}

export function detectMismatch(
  report: RuntimeEvidenceReportV02,
  reportRef: ManagedArtifactRef,
  expectedUnits: ReadonlyArray<RuntimeUnitExpectation>,
): RuntimeEvidenceFinding[] {
  const findings: RuntimeEvidenceFinding[] = [];
  for (const unit of expectedUnits) {
    if (unit.expectedText === undefined) {
      continue;
    }
    const observed = observedTextForUnit(report, unit.bridgeUnitId);
    if (observed === null) {
      // Absence is the missing-text tool's concern, not a mismatch.
      continue;
    }
    if (normalizeText(observed.text) === normalizeText(unit.expectedText)) {
      continue;
    }
    const capture = captureForUnit(report, unit.bridgeUnitId);
    const citations: RuntimeEvidenceCitation[] = [
      reportCitation(
        reportRef,
        "trace",
        observed.traceEventId,
        `observed runtime text for ${unit.sourceUnitKey} differs from the expected translation`,
      ),
    ];
    let backing: RuntimeEvidenceBacking = "trace";
    if (capture !== null) {
      citations.push(
        screenshotCitation(
          capture,
          `screenshot of ${unit.sourceUnitKey} at frame ${capture.frame}`,
        ),
      );
      backing = "both";
    }
    findings.push({
      findingId: findingId("mismatch", report.runtimeReportId, unit.bridgeUnitId),
      findingKind: "mismatch",
      severity: severityToJson("major"),
      detectorKind: "deterministic_check",
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      message: `Observed runtime text for ${unit.sourceUnitKey} does not match the expected translation.`,
      expected: unit.expectedText,
      observed: observed.text,
      evidenceBacking: backing,
      citations,
    });
  }
  return findings;
}

export function detectLayout(
  report: RuntimeEvidenceReportV02,
  store: RuntimeEvidenceArtifactStore,
): RuntimeEvidenceFinding[] {
  const findings: RuntimeEvidenceFinding[] = [];
  for (const capture of report.captures) {
    const captureRef = managedRefFromCapture(capture);
    // 1) Capture region overflow (element rendered past frame bounds).
    if (capture.region !== undefined) {
      const r = capture.region;
      if (r.x + r.width > capture.width || r.y + r.height > capture.height) {
        findings.push({
          findingId: findingId("layout_region", report.runtimeReportId, capture.captureId),
          findingKind: "layout",
          severity: severityToJson("major"),
          detectorKind: "deterministic_check",
          bridgeUnitId: capture.bridgeUnitRef.bridgeUnitId,
          sourceUnitKey: capture.bridgeUnitRef.sourceUnitKey ?? null,
          message: `Rendered region for ${capture.bridgeUnitRef.sourceUnitKey ?? capture.bridgeUnitRef.bridgeUnitId} overflows the ${capture.width}x${capture.height} frame.`,
          expected: `region within ${capture.width}x${capture.height}`,
          observed: `region ${r.x},${r.y} ${r.width}x${r.height}`,
          evidenceBacking: "screenshot",
          citations: [screenshotCitation(capture, `overflowing region on frame ${capture.frame}`)],
        });
      }
    }
    // 2) OCR region overflow (recognised text extends past the frame).
    const ocr = store.resolveScreenshotOcr(captureRef);
    if (ocr === null) {
      continue;
    }
    for (const region of ocr.regions) {
      if (
        region.x + region.width <= ocr.frameWidth &&
        region.y + region.height <= ocr.frameHeight
      ) {
        continue;
      }
      findings.push({
        findingId: findingId(
          "layout_ocr",
          report.runtimeReportId,
          `${capture.captureId}:${region.regionId}`,
        ),
        findingKind: "layout",
        severity: severityToJson("minor"),
        detectorKind: "deterministic_check",
        bridgeUnitId: region.bridgeUnitId,
        sourceUnitKey: capture.bridgeUnitRef.sourceUnitKey ?? null,
        message: `OCR text region "${region.recognizedText}" overflows the ${ocr.frameWidth}x${ocr.frameHeight} frame.`,
        expected: `text region within ${ocr.frameWidth}x${ocr.frameHeight}`,
        observed: `region ${region.x},${region.y} ${region.width}x${region.height}`,
        evidenceBacking: "screenshot",
        citations: [
          screenshotCitation(capture, `screenshot backing OCR region ${region.regionId}`),
          ocrCitation(ocr, region.regionId, `OCR region overflows frame`),
        ],
      });
    }
  }
  return findings;
}

export function collectOcrHints(
  report: RuntimeEvidenceReportV02,
  store: RuntimeEvidenceArtifactStore,
): RuntimeEvidenceFinding[] {
  const findings: RuntimeEvidenceFinding[] = [];
  for (const capture of report.captures) {
    const ocr = store.resolveScreenshotOcr(managedRefFromCapture(capture));
    if (ocr === null) {
      continue;
    }
    for (const region of ocr.regions) {
      findings.push({
        findingId: findingId(
          "ocr_hint",
          report.runtimeReportId,
          `${capture.captureId}:${region.regionId}`,
        ),
        findingKind: "ocr_hint",
        severity: severityToJson("info"),
        detectorKind: "deterministic_check",
        bridgeUnitId: region.bridgeUnitId,
        sourceUnitKey: capture.bridgeUnitRef.sourceUnitKey ?? null,
        message: `OCR recognised "${region.recognizedText}" in region ${region.x},${region.y} ${region.width}x${region.height}.`,
        expected: null,
        observed: region.recognizedText,
        evidenceBacking: "screenshot",
        citations: [
          screenshotCitation(capture, `screenshot the OCR hint was lifted from`),
          ocrCitation(ocr, region.regionId, `OCR text-region hint`),
        ],
      });
    }
  }
  return findings;
}

function managedRefFromCapture(capture: RuntimeCaptureV02): ManagedArtifactRef {
  return {
    artifactId: capture.artifactRef.artifactId,
    artifactKind: capture.artifactRef.artifactKind,
    uri: capture.artifactRef.uri,
    hash: capture.artifactRef.hash ?? null,
  };
}
