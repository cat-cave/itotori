import { createHash } from "node:crypto";

import type {
  BridgeBundleV02,
  PreserveModeV02,
  SpanKindV02,
  SurfaceKindV02,
} from "@itotori/localization-bridge-schema";

import type { ItotoriProjectRecord } from "../src/repositories/project-repository.js";
import { stableJsonStringify } from "../src/stable-json.js";

export type CurrentBridgeUnitFixture = {
  sourceUnitKey: string;
  sourceText: string;
  occurrenceId?: string;
  surfaceKind?: SurfaceKindV02;
  targetText?: string;
  context?: BridgeBundleV02["units"][number]["context"];
  spans?: readonly {
    raw: string;
    spanKind?: SpanKindV02;
    preserveMode?: PreserveModeV02;
  }[];
};

export type CurrentBridgeFixtureInput = {
  seed: string;
  sourceLocale?: string;
  assetKey?: string;
  assetPath?: string;
  assetKind?: BridgeBundleV02["assets"][number]["assetKind"];
  units?: readonly CurrentBridgeUnitFixture[];
};

export type CurrentProjectFixtureInput = CurrentBridgeFixtureInput & {
  projectId: string;
  localeBranchId?: string;
  targetLocale?: string;
  engineFamily?: string;
  sourceRoot?: string;
  buildRoot?: string;
  extractProfile?: Record<string, unknown>;
};

type PreparedSpan = {
  raw: string;
  spanKind: SpanKindV02;
  preserveMode: PreserveModeV02;
  startByte: number;
  endByte: number;
};

type PreparedUnit = {
  input: CurrentBridgeUnitFixture;
  index: number;
  occurrenceId: string;
  surfaceKind: SurfaceKindV02;
  sourceHash: string;
  sourceStartByte: number;
  sourceEndByte: number;
  spans: PreparedSpan[];
};

const defaultUnit: CurrentBridgeUnitFixture = {
  sourceUnitKey: "fixture.scene.001.line.001",
  sourceText: "こんにちは、{player}。",
  targetText: "Hello, {player}.",
  spans: [{ raw: "{player}" }],
};

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalHash(value: unknown): string {
  return sha256(stableJsonStringify(value));
}

/** Mirrors kaifuu-core's NUL-framed, content-derived UUIDv7 identity helper. */
function deterministicUuid7(parts: readonly string[]): string {
  const hasher = createHash("sha256");
  for (const part of parts) {
    hasher.update(part);
    hasher.update("\0");
  }
  const hex = hasher.digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function contentRevision(
  kind: string,
  key: string,
  value: string,
): BridgeBundleV02["sourceBundleRevision"] {
  return {
    revisionId: deterministicUuid7(["adapter-revision-v02", kind, key, value]),
    revisionKind: "content_hash",
    value,
  };
}

function byteOffset(value: string, characterOffset: number): number {
  return Buffer.byteLength(value.slice(0, characterOffset), "utf8");
}

function prepareSpans(unit: CurrentBridgeUnitFixture): PreparedSpan[] {
  let characterCursor = 0;
  return (unit.spans ?? []).map((span) => {
    const start = unit.sourceText.indexOf(span.raw, characterCursor);
    if (span.raw.length === 0 || start < 0) {
      throw new Error(`fixture span is absent from ${unit.sourceUnitKey}`);
    }
    characterCursor = start + span.raw.length;
    return {
      raw: span.raw,
      spanKind: span.spanKind ?? "variable_placeholder",
      preserveMode: span.preserveMode ?? "exact",
      startByte: byteOffset(unit.sourceText, start),
      endByte: byteOffset(unit.sourceText, characterCursor),
    };
  });
}

function prepareUnits(
  seed: string,
  sourceLocale: string,
  units: readonly CurrentBridgeUnitFixture[],
): PreparedUnit[] {
  let sourceStartByte = 0;
  return units.map((unit, index) => {
    const spans = prepareSpans(unit);
    const sourceEndByte = sourceStartByte + Buffer.byteLength(unit.sourceText, "utf8");
    const prepared = {
      input: unit,
      index,
      occurrenceId: unit.occurrenceId ?? `${seed}-occurrence-${index + 1}`,
      surfaceKind: unit.surfaceKind ?? "dialogue",
      sourceHash: canonicalHash({
        sourceLocale,
        sourceUnitKey: unit.sourceUnitKey,
        sourceText: unit.sourceText,
        spans: spans.map(({ raw }) => ({ raw })),
      }),
      sourceStartByte,
      sourceEndByte,
      spans,
    } satisfies PreparedUnit;
    sourceStartByte = sourceEndByte + (index === units.length - 1 ? 0 : 1);
    return prepared;
  });
}

export function currentBridgeFixture(input: CurrentBridgeFixtureInput): BridgeBundleV02 {
  const sourceLocale = input.sourceLocale ?? "ja-JP";
  const unitInputs = input.units ?? [defaultUnit];
  if (unitInputs.length === 0) throw new Error("current bridge fixture requires at least one unit");

  const assetKey = input.assetKey ?? `${input.seed}/source`;
  const assetPath = input.assetPath ?? "source.txt";
  const assetHash = sha256(unitInputs.map(({ sourceText }) => sourceText).join("\n"));
  const assetId = deterministicUuid7(["adapter-asset-v02", input.seed, assetKey, assetHash]);
  const preparedUnits = prepareUnits(input.seed, sourceLocale, unitInputs);
  const sourceBundleHash = canonicalHash({
    assets: [{ assetKey, path: assetPath, sourceHash: assetHash }],
    units: preparedUnits.map((unit) => ({
      assetKey,
      occurrenceId: unit.occurrenceId,
      sourceLocale,
      sourceText: unit.input.sourceText,
      sourceUnitKey: unit.input.sourceUnitKey,
      speaker: "",
      spans: unit.spans,
      surfaceKind: unit.surfaceKind,
    })),
  });
  const sourceProfileId = `${input.seed}-profile`;
  const sourceProfileHash = canonicalHash({
    adapterId: input.seed,
    extractor: { name: "kaifuu-fixture", version: "0.2.0" },
    gameId: `${input.seed}-source`,
    sourceProfileId,
  });

  return {
    schemaVersion: "0.2.0",
    bridgeId: deterministicUuid7(["adapter-bridge-v02", input.seed, sourceBundleHash]),
    sourceGame: {
      gameId: `${input.seed}-source`,
      gameVersion: "fixture",
      sourceProfileId,
      sourceProfileRevision: contentRevision("source-profile", sourceProfileId, sourceProfileHash),
    },
    sourceBundleHash,
    sourceBundleRevision: contentRevision("source-bundle", sourceBundleHash, sourceBundleHash),
    sourceLocale,
    hashStrategy: {
      sourceProfile: {
        scope: "source_profile",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      sourceBundle: {
        scope: "source_bundle",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      sourceAsset: { scope: "source_asset", algorithm: "sha256", normalization: "bytes" },
      sourceUnit: {
        scope: "source_unit",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
        fields: ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
      },
      patchExport: {
        scope: "patch_export",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      deltaPackage: {
        scope: "delta_package",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
    },
    extractor: { name: "kaifuu-fixture", version: "0.2.0" },
    assets: [
      {
        assetId,
        assetKey,
        assetKind: input.assetKind ?? "script",
        sourceHash: assetHash,
        sourceRevision: contentRevision("source-asset", assetKey, assetHash),
        path: assetPath,
      },
    ],
    units: preparedUnits.map((unit): BridgeBundleV02["units"][number] => {
      const sourceRevision = contentRevision(
        "source-unit",
        unit.input.sourceUnitKey,
        unit.sourceHash,
      );
      const bridgeUnitId = deterministicUuid7([
        "adapter-bridge-unit-v02",
        unit.input.sourceUnitKey,
        unit.occurrenceId,
        unit.sourceHash,
      ]);
      return {
        bridgeUnitId,
        surfaceId: deterministicUuid7([
          "adapter-surface-v02",
          unit.surfaceKind,
          unit.input.sourceUnitKey,
        ]),
        surfaceKind: unit.surfaceKind,
        sourceUnitKey: unit.input.sourceUnitKey,
        occurrenceId: unit.occurrenceId,
        sourceHash: unit.sourceHash,
        sourceRevision,
        sourceLocale,
        sourceText: unit.input.sourceText,
        sourceAssetRef: { assetId, assetKey },
        sourceLocation: {
          containerKey: assetKey,
          entryPath: unit.input.sourceUnitKey.split(/[\/.#:]/u).filter(Boolean),
          range: { startByte: unit.sourceStartByte, endByte: unit.sourceEndByte },
        },
        speaker: { knowledgeState: "not_applicable" },
        context: unit.input.context ?? { route: { position: unit.input.sourceUnitKey } },
        spans: unit.spans.map((span, spanIndex) => ({
          spanId: deterministicUuid7([
            "adapter-span-v02",
            bridgeUnitId,
            String(spanIndex),
            span.raw,
          ]),
          ...span,
        })),
        patchRef: {
          assetId,
          writeMode: "replace",
          sourceUnitKey: unit.input.sourceUnitKey,
          sourceRevision,
        },
        runtimeExpectation: {
          expectationKind: "trace_text",
          traceKey: unit.input.sourceUnitKey,
        },
      };
    }),
    policyRecords: [],
  };
}

export function currentProjectFixture(input: CurrentProjectFixtureInput): ItotoriProjectRecord {
  const bridge = currentBridgeFixture(input);
  const unitInputs = input.units ?? [defaultUnit];
  const drafts = Object.fromEntries(
    bridge.units.flatMap((unit, index) => {
      const targetText = unitInputs[index]?.targetText;
      return targetText === undefined ? [] : [[unit.bridgeUnitId, targetText]];
    }),
  );
  return {
    projectId: input.projectId,
    engineFamily: input.engineFamily ?? "synthetic_fixture",
    sourceRoot: input.sourceRoot ?? "/workspace/source",
    buildRoot: input.buildRoot ?? "/workspace/build",
    extractProfile: input.extractProfile ?? { adapter: "fixture" },
    localeBranchId: input.localeBranchId ?? `${input.projectId}-branch`,
    targetLocale: input.targetLocale ?? "en-US",
    drafts,
    bridge,
  };
}
