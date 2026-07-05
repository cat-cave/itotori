// UTSUSHI-011 — Synthetic runtime-evidence fixtures.
//
// A single deterministic runtime evidence report + its OCR artifacts + the
// expectation set, engineered so the tools + deterministic checks produce one
// of every finding kind:
//   - missing_text : unit B renders no text
//   - mismatch     : unit A observed "warrior" but expected "hero" (trace+screenshot → both)
//   - wrong_branch : choice-001 took 'prologue.leave', map allows only 'prologue.stay'
//   - layout       : capture D region overflows the frame; OCR region D overflows too
//   - ocr_hint     : OCR text-region hints on captures A and D
// Unit C is a clean control (observed via the observation-hook stream, matches
// expectation) so the checks prove they do NOT over-fire.
//
// Synthetic only — no copyrighted bytes. IDs are fixed so findings are stable.

import type {
  RuntimeBranchPointEventV02,
  RuntimeCaptureV02,
  RuntimeEvidenceReportV02,
  RuntimeTraceEventV02,
} from "@itotori/localization-bridge-schema";
import { InMemoryRuntimeEvidenceArtifactStore } from "./artifact-store.js";
import type {
  ManagedArtifactRef,
  RuntimeEvidenceExpectations,
  ScreenshotOcrArtifact,
} from "./shapes.js";

const REPORT_ID = "019ed0b0-0000-7000-8000-000000000001";
const REPORT_HASH = "sha256:0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b";

const UNIT_A = "019ed0b0-0000-7000-8000-0000000000a1";
const UNIT_B = "019ed0b0-0000-7000-8000-0000000000a2";
const UNIT_C = "019ed0b0-0000-7000-8000-0000000000a3";
const UNIT_D = "019ed0b0-0000-7000-8000-0000000000a4";
const CHOICE_UNIT = "019ed0b0-0000-7000-8000-0000000000b1";

const KEY_A = "script/prologue#line-001";
const KEY_B = "script/prologue#line-002";
const KEY_C = "script/prologue#line-003";
const KEY_D = "script/prologue#line-004";
const KEY_CHOICE = "script/prologue#choice-001";

const CAPTURE_A_ARTIFACT = "019ed0b0-0000-7000-8000-000000000401";
const CAPTURE_D_ARTIFACT = "019ed0b0-0000-7000-8000-000000000404";
const OCR_A_ARTIFACT = "019ed0b0-0000-7000-8000-0000000004a1";
const OCR_D_ARTIFACT = "019ed0b0-0000-7000-8000-0000000004a4";

/** Managed ref for the fixture runtime report (the tool's entry point). */
export function runtimeEvidenceFixtureReportRef(): ManagedArtifactRef {
  return {
    artifactId: REPORT_ID,
    artifactKind: "runtime_report",
    uri: `artifacts/utsushi/prologue/${REPORT_ID}.runtime.json`,
    hash: REPORT_HASH,
  };
}

const traceEvents: RuntimeTraceEventV02[] = [
  {
    traceEventId: "019ed0b0-0000-7000-8000-000000000101",
    eventKind: "text_observed",
    bridgeUnitRef: { bridgeUnitId: UNIT_A, sourceUnitKey: KEY_A },
    frame: 12,
    traceKey: "prologue.line.001",
    observedText: "Hello, warrior.",
  },
  {
    traceEventId: "019ed0b0-0000-7000-8000-000000000102",
    eventKind: "branch_point_reached",
    bridgeUnitRef: { bridgeUnitId: CHOICE_UNIT, sourceUnitKey: KEY_CHOICE },
    frame: 20,
    traceKey: "prologue.choice.001",
  },
];

const branchEvents: RuntimeBranchPointEventV02[] = [
  {
    branchEventId: "019ed0b0-0000-7000-8000-000000000201",
    bridgeUnitRef: { bridgeUnitId: CHOICE_UNIT, sourceUnitKey: KEY_CHOICE },
    frame: 20,
    branchPointKey: "prologue.choice.001",
    promptText: "Choose a route",
    options: [
      {
        optionId: "019ed0b0-0000-7000-8000-000000000211",
        label: "Stay",
        targetRouteKey: "prologue.stay",
      },
      {
        optionId: "019ed0b0-0000-7000-8000-000000000212",
        label: "Leave",
        targetRouteKey: "prologue.leave",
      },
    ],
    selectedOptionId: "019ed0b0-0000-7000-8000-000000000212",
  },
];

const captures: RuntimeCaptureV02[] = [
  {
    captureId: "019ed0b0-0000-7000-8000-000000000301",
    bridgeUnitRef: { bridgeUnitId: UNIT_A, sourceUnitKey: KEY_A },
    evidenceTier: "E2",
    frame: 12,
    width: 1280,
    height: 720,
    nonZeroPixels: 812345,
    region: { x: 96, y: 520, width: 1088, height: 128 },
    artifactRef: {
      artifactId: CAPTURE_A_ARTIFACT,
      artifactKind: "screenshot",
      uri: "artifacts/utsushi/prologue/frame-a.png",
      hash: "sha256:aaaa000000000000000000000000000000000000000000000000000000000001",
      mediaType: "image/png",
      byteSize: 4096,
    },
  },
  {
    captureId: "019ed0b0-0000-7000-8000-000000000304",
    bridgeUnitRef: { bridgeUnitId: UNIT_D, sourceUnitKey: KEY_D },
    evidenceTier: "E2",
    frame: 40,
    width: 1280,
    height: 720,
    nonZeroPixels: 903211,
    // 660 + 120 = 780 > 720 → the rendered region overflows the frame bottom.
    region: { x: 96, y: 660, width: 1088, height: 120 },
    artifactRef: {
      artifactId: CAPTURE_D_ARTIFACT,
      artifactKind: "screenshot",
      uri: "artifacts/utsushi/prologue/frame-d.png",
      hash: "sha256:dddd000000000000000000000000000000000000000000000000000000000004",
      mediaType: "image/png",
      byteSize: 4096,
    },
  },
];

/** The fixture runtime evidence report. Unit C's text lives in the hook stream. */
export function runtimeEvidenceFixtureReport(): RuntimeEvidenceReportV02 {
  return {
    schemaVersion: "0.2.0",
    runtimeReportId: REPORT_ID,
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    adapterName: "utsushi-fixture-adapter",
    adapterVersion: "1.0.0",
    fidelityTier: "replay_review",
    evidenceTier: "E3",
    status: "passed",
    createdAt: "2026-07-05T00:00:00.000Z",
    traceEvents,
    branchEvents,
    observationHookEvents: [
      {
        schemaVersion: "0.1.0-alpha",
        eventId: "019ed0b0-0000-7000-8000-000000000c03",
        observedAt: "2026-07-05T00:00:01.000Z",
        eventKind: "text",
        runtimeTargetId: "fixture:runtime-target",
        adapterId: { name: "utsushi-fixture-adapter", version: "1.0.0" },
        evidenceTier: "E1",
        environment: {
          runtime: "browser",
          engine: "fixture-engine",
          platform: "linux",
          locale: "en-US",
        },
        bridgeRefs: [{ bridgeUnitId: UNIT_C, sourceUnitKey: KEY_C }],
        redaction: { status: "not_required" },
        payload: {
          payloadKind: "text",
          text: "Good morning.",
          speaker: "Narrator",
          textSurface: "dialogue",
        },
      },
    ],
    captures,
    recordings: [],
    approximations: [],
    validationFindings: [],
    limitations: [],
  };
}

/** OCR artifacts derived from captures A (in-bounds) and D (overflowing). */
export function runtimeEvidenceFixtureOcrArtifacts(): ScreenshotOcrArtifact[] {
  return [
    {
      artifactId: OCR_A_ARTIFACT,
      screenshotArtifactId: CAPTURE_A_ARTIFACT,
      frameWidth: 1280,
      frameHeight: 720,
      capturedAtFrame: 12,
      regions: [
        {
          regionId: "ocr-a-1",
          bridgeUnitId: UNIT_A,
          x: 96,
          y: 520,
          width: 400,
          height: 40,
          recognizedText: "Hello, warrior.",
        },
      ],
    },
    {
      artifactId: OCR_D_ARTIFACT,
      screenshotArtifactId: CAPTURE_D_ARTIFACT,
      frameWidth: 1280,
      frameHeight: 720,
      capturedAtFrame: 40,
      regions: [
        {
          regionId: "ocr-d-1",
          bridgeUnitId: UNIT_D,
          // 1200 + 200 = 1400 > 1280 → the OCR text region overflows the frame right edge.
          x: 1200,
          y: 80,
          width: 200,
          height: 40,
          recognizedText: "Menu",
        },
      ],
    },
  ];
}

/** The expectation set that drives the deterministic checks over the fixture. */
export function runtimeEvidenceFixtureExpectations(): RuntimeEvidenceExpectations {
  return {
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    units: [
      { bridgeUnitId: UNIT_A, sourceUnitKey: KEY_A, expectedText: "Hello, hero." },
      { bridgeUnitId: UNIT_B, sourceUnitKey: KEY_B },
      { bridgeUnitId: UNIT_C, sourceUnitKey: KEY_C, expectedText: "Good morning." },
    ],
    branches: [{ branchPointKey: "prologue.choice.001", allowedRouteKeys: ["prologue.stay"] }],
  };
}

/** A managed store seeded with the fixture report + OCR artifacts. */
export function makeRuntimeEvidenceFixtureStore(): InMemoryRuntimeEvidenceArtifactStore {
  return new InMemoryRuntimeEvidenceArtifactStore({
    reports: [{ artifactId: REPORT_ID, report: runtimeEvidenceFixtureReport() }],
    ocrArtifacts: runtimeEvidenceFixtureOcrArtifacts(),
  });
}

export const RUNTIME_EVIDENCE_FIXTURE_IDS = {
  reportId: REPORT_ID,
  unitA: UNIT_A,
  unitB: UNIT_B,
  unitC: UNIT_C,
  unitD: UNIT_D,
  choiceUnit: CHOICE_UNIT,
  captureAArtifact: CAPTURE_A_ARTIFACT,
  captureDArtifact: CAPTURE_D_ARTIFACT,
  ocrAArtifact: OCR_A_ARTIFACT,
  ocrDArtifact: OCR_D_ARTIFACT,
} as const;
