import { testProjectEngineFamilyRegistry } from "./project-engine-family-registry.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { RuntimeEvidenceReportV02 } from "@itotori/localization-bridge-schema";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import {
  allPermissions,
  localUserId,
  permissionValues,
  type AuthorizationActor,
} from "../src/authorization.js";
import {
  ItotoriProjectRepository,
  RuntimeRunNotFoundError,
  type ItotoriProjectRecord,
} from "../src/repositories/project-repository.js";
import { createDatabaseContext } from "../src/connection.js";
import { ItotoriLocalizationResultRevisionRepository } from "../src/repositories/localization-result-revision-repository.js";
import { migrate, migrations } from "../src/migrations.js";
import {
  feedbackContextStatusValues,
  feedbackReportStatusValues,
  feedbackTriageLabelValues,
  feedbackTypeValues,
  ItotoriFeedbackRepository,
  parseManualFeedbackImportInput,
  type ManualFeedbackImportInput,
} from "../src/repositories/feedback-repository.js";
import {
  artifacts,
  events,
  feedbackReportEvidence,
  feedbackReports,
  feedbackSources,
  localeBranches,
  sourceBundles,
  userPermissionGrants,
} from "../src/schema.js";
import { isolatedMigratedContext } from "./db-test-context.js";

export const localActor: AuthorizationActor = { userId: localUserId };

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const invalidManagedRuntimeArtifactUriCases = [
  [
    "current-directory dot segment",
    "artifacts/utsushi/runtime/./runtime-report/screenshots/capture.png",
  ],
  [
    "parent-directory dot segment",
    "artifacts/utsushi/runtime/runtime-report/../screenshots/capture.png",
  ],
  ["empty path segment", "artifacts/utsushi/runtime/runtime-report//capture.png"],
  ["URI scheme", "https://example.invalid/capture.png"],
  ["absolute POSIX path", "/tmp/runtime/capture.png"],
  ["backslash path", "artifacts\\utsushi\\runtime\\capture.png"],
  ["missing managed runtime prefix", "artifacts/utsushi/schema-fixture/capture.png"],
] as const;

export const invalidLegacyRuntimeArtifactUriCases = invalidManagedRuntimeArtifactUriCases.filter(
  ([label]) => label !== "missing managed runtime prefix",
);

export function v02Sha256(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

/**
 * Mirrors the repository's internal `stableJsonStringify`-based
 * canonicalization so a test can independently re-derive the deterministic
 * fallback hash the repository records for an artifact whose adapter did not
 * supply a content hash. Any drift in key set or ordering breaks the
 * exact-value assertion.
 */
export function stableSerializeHashInput(value: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  const entries = Object.entries(sorted);
  const body = entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerializeValue(item)}`)
    .join(",");
  return `{${body}}`;
}

export function stableSerializeValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerializeValue).join(",")}]`;
  }
  return stableSerializeHashInput(value as Record<string, unknown>);
}

export function projectFixture(
  overrides: Partial<ItotoriProjectRecord> = {},
): ItotoriProjectRecord {
  const project: ItotoriProjectRecord = {
    projectId: "project-test",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
    localeBranchId: "locale-en-us",
    targetLocale: "en-US",
    drafts: { "bridge-unit-test": "Hello, {player}." },
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-test",
      sourceBundleHash: "hash-test",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "source-hash",
          sourceLocale: "ja-JP",
          sourceText: "こんにちは、{player}。",
          textSurface: "dialogue",
          protectedSpans: [
            { kind: "placeholder", raw: "{player}", start: 18, end: 26, preserveMode: "exact" },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        },
      ],
    },
  };
  return { ...project, ...overrides };
}

export function projectV02Fixture(bridge: BridgeBundleV02): ItotoriProjectRecord {
  return {
    projectId: "project-v02",
    engineFamily: "synthetic_fixture",
    sourceRoot: "/workspace/source",
    buildRoot: "/workspace/build",
    extractProfile: { adapter: "fixture" },
    localeBranchId: "locale-v02-fr-fr",
    targetLocale: "fr-FR",
    drafts: {},
    bridge,
  };
}

export function bridgeV02Fixture(): BridgeBundleV02 {
  return JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "localization-bridge-schema",
        "test",
        "examples",
        "bridge-v0.2.json",
      ),
      "utf8",
    ),
  ) as BridgeBundleV02;
}

export function patchExportV02Fixture(bridge: BridgeBundleV02): PatchExportV02 {
  const unit = bridge.units[0]!;
  const span = unit.spans[0]!;
  return {
    schemaVersion: "0.2.0",
    patchExportId: "019ed001-0000-7000-8000-000000000901",
    sourceBridgeId: bridge.bridgeId,
    sourceGame: bridge.sourceGame,
    sourceBundleHash: bridge.sourceBundleHash,
    sourceBundleRevision: bridge.sourceBundleRevision,
    sourceLocale: bridge.sourceLocale,
    targetLocale: "fr-FR",
    hashStrategy: bridge.hashStrategy,
    entries: [
      {
        entryId: "019ed001-0000-7000-8000-000000000910",
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        sourceHash: unit.sourceHash,
        sourceRevision: unit.sourceRevision,
        targetText: "Bonjour, {player}.",
        protectedSpanMappings: [
          {
            raw: span.raw,
            sourceSpanId: span.spanId,
            sourceStartByte: span.startByte,
            sourceEndByte: span.endByte,
            targetStart: 9,
            targetEnd: 17,
          },
        ],
      },
    ],
  };
}

export function manualFeedbackFixture(
  overrides: Partial<ManualFeedbackImportInput> = {},
): ManualFeedbackImportInput {
  return {
    projectId: "project-test",
    localeBranchId: "locale-en-us",
    sourceBundleId: "bridge-test",
    feedbackSource: {
      sourceKind: "manual_playtest",
      label: "Manual playtest fixture",
      sourceChannel: "fixture",
      privacyReviewState: "reviewed",
    },
    feedbackType: feedbackTypeValues.stylePreference,
    reporter: { role: "playtester", displayName: "Fixture reviewer" },
    reporterNote: "The protagonist sounds too formal in this line.",
    lineReference: {
      bridgeUnitId: "bridge-unit-test",
      sourceUnitKey: "hello.scene.001.line.001",
      path: "source.json",
      line: 1,
    },
    attachments: [
      {
        attachmentKind: "screenshot",
        artifactId: "feedback-screenshot-1",
        uri: "fixture://feedback/screenshot/formal-tone",
        hash: "sha256:feedback-screenshot-1",
        caption: "message window with formal protagonist line",
        capturePosition: "hello.scene.001:frame001",
        evidenceTier: "E2",
      },
      {
        attachmentKind: "save_context",
        contextToken: "fixture-save-before-line",
        routeRef: "hello-route",
        sceneRef: "hello.scene.001",
      },
    ],
    privacyClassification: "internal",
    redactionState: "reviewed",
    reportedAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

export function runtimeEvidenceReportFixture(
  overrides: Partial<RuntimeEvidenceReportV02> = {},
): RuntimeEvidenceReportV02 {
  return {
    schemaVersion: "0.2.0",
    runtimeReportId: "019ed003-0000-7000-8000-000000000901",
    adapterName: "utsushi-fixture",
    adapterVersion: "0.0.0",
    fidelityTier: "layout_probe",
    evidenceTier: "E2",
    runtimeCapabilities: {
      contractVersion: "0.2.0",
      capabilityClass: "launch_capture",
      fidelityTierCeiling: "layout_probe",
      evidenceTierCeiling: "E2",
      features: [
        {
          feature: "static_trace",
          status: "supported",
          evidenceTierCeiling: "E1",
          description: "Fixture static trace.",
          limitations: [],
        },
        {
          feature: "text_trace",
          status: "supported",
          evidenceTierCeiling: "E1",
          description: "Fixture text trace.",
          limitations: [],
        },
        {
          feature: "frame_capture",
          status: "partial",
          evidenceTierCeiling: "E2",
          description: "Fixture capture metadata.",
          limitations: ["No live engine screenshot API."],
        },
        {
          feature: "jump",
          status: "unsupported",
          description: "Jump is not required by the base contract.",
          limitations: [],
        },
        {
          feature: "snapshot",
          status: "unsupported",
          description: "Snapshot is not required by the base contract.",
          limitations: [],
        },
        {
          feature: "screenshot",
          status: "unsupported",
          description: "Screenshot API is not required by the base contract.",
          limitations: [],
        },
        {
          feature: "recording",
          status: "unsupported",
          description: "Recording is not required by the base contract.",
          limitations: [],
        },
      ],
      limitations: ["Fixture launch/capture boundary."],
    },
    controlledPlaybackSession: {
      sessionId: "019ed003-0000-7000-8000-000000000906",
      adapterName: "utsushi-fixture",
      adapterVersion: "0.0.0",
      capabilityClass: "launch_capture",
      requestedOperation: "capture",
      status: "passed",
      fidelityTier: "layout_probe",
      evidenceTier: "E2",
      featuresUsed: ["static_trace", "text_trace", "frame_capture"],
      limitations: ["No jump, snapshot, screenshot API, or recording API."],
    },
    status: "passed",
    createdAt: "2026-06-17T00:00:00.000Z",
    traceEvents: [
      {
        traceEventId: "019ed003-0000-7000-8000-000000000911",
        eventKind: "text_observed",
        bridgeUnitRef: {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
        },
        frame: 1,
        traceKey: "hello.line.001",
        observedText: "Hello, {player}.",
      },
    ],
    branchEvents: [],
    captures: [
      {
        captureId: "019ed003-0000-7000-8000-000000000921",
        bridgeUnitRef: {
          bridgeUnitId: "bridge-unit-test",
          sourceUnitKey: "hello.scene.001.line.001",
        },
        evidenceTier: "E2",
        frame: 1,
        width: 320,
        height: 180,
        nonZeroPixels: 57600,
        artifactRef: {
          artifactId: "019ed003-0000-7000-8000-000000000931",
          artifactKind: "screenshot",
          uri: "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000000000901/screenshots/019ed003-0000-7000-8000-000000000931.png",
          mediaType: "image/png",
        },
      },
    ],
    recordings: [],
    approximations: [
      {
        approximationId: "019ed003-0000-7000-8000-000000000941",
        approximationTier: "deterministic_fixture",
        scope: "fixture runtime",
        description: "Fixture evidence validates runtime plumbing, not engine fidelity.",
        affectedBridgeUnitRefs: [
          {
            bridgeUnitId: "bridge-unit-test",
            sourceUnitKey: "hello.scene.001.line.001",
          },
        ],
        evidenceTierCeiling: "E2",
      },
    ],
    validationFindings: [],
    limitations: ["No reference-runtime pixel comparison is performed."],
    ...overrides,
  };
}
