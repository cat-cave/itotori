import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertRuntimeEvidenceReportV02,
  evaluatePatchExportCompatibilityV02,
  type RuntimeEvidenceReportV02,
} from "@itotori/localization-bridge-schema";

import {
  hashLocalizationArtifact,
  verifyLocalizationArtifactManifest,
} from "../../../packages/itotori-db/src/localization-artifact-integrity.js";
import { bindScopedTargets } from "../../../apps/itotori/src/patchback/bind-scoped-targets.js";
import { buildPatchExportV02 } from "../../../apps/itotori/src/patchback/build-patch-export.js";
import { buildPatchScenarioInput } from "./evidence-product-fixture.js";

export interface ScenarioProjectionRequest {
  evidenceKind: string;
  contentCase: string;
  sourceRevision: string;
  currentRevision: string;
  anchorRevision: string;
  peerRevision: string;
  alternateRevision: string;
  unaffectedRevision: string;
  scanClasses: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function patchChain(revision: string) {
  const { bridge, input } = buildPatchScenarioInput(revision);
  const patchExport = buildPatchExportV02(input, bindScopedTargets(input));
  const compatibility = evaluatePatchExportCompatibilityV02(patchExport, bridge);
  return { bridge, patchExport, compatibility };
}

function verifiedArtifactSet(
  sourceBundleHash: string,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), "evidence-product-artifacts-"));
  try {
    const refs: Record<string, string> = {};
    const hashes: Record<string, string> = {};
    for (const [key, value] of Object.entries(values).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const path = resolve(root, `${key}.json`);
      writeFileSync(path, `${stableJson(value)}\n`);
      refs[key] = path;
      hashes[key] = hashLocalizationArtifact(path);
    }
    verifyLocalizationArtifactManifest(refs, hashes);
    return { sourceBundleHash, artifactHashes: hashes, artifactKeys: Object.keys(hashes).sort() };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function chainArtifacts(revision: string, unaffectedRevision: string) {
  const chain = patchChain(revision);
  const manifest = verifiedArtifactSet(chain.bridge.sourceBundleHash, {
    patchExport: chain.patchExport,
    compatibilityReport: chain.compatibility,
    unaffectedControl: { unaffectedRevision },
  });
  return { ...chain, manifest };
}

function runtimeStaleProjection(input: ScenarioProjectionRequest): Record<string, unknown> {
  const source = patchChain(input.sourceRevision);
  const current = patchChain(input.currentRevision);
  const unit = source.bridge.units[0];
  if (unit === undefined) throw new Error("scenario-runtime-unit-missing");
  const targetLocale = unit.policy?.targetLocale;
  if (targetLocale === undefined) throw new Error("scenario-runtime-target-locale-missing");
  const report: unknown = {
    schemaVersion: "0.2.0",
    runtimeReportId: "019ed800-0000-7000-8000-000000000001",
    sourceBridgeId: source.bridge.bridgeId,
    sourceBundleHash: source.bridge.sourceBundleHash,
    sourceLocale: source.bridge.sourceLocale,
    targetLocale,
    adapterName: "portable-evidence-local-runtime",
    adapterVersion: "0.2.0",
    fidelityTier: "trace_only",
    evidenceTier: "E1",
    status: "passed",
    createdAt: "2026-07-15T00:00:00.000Z",
    traceEvents: [
      {
        traceEventId: "019ed800-0000-7000-8000-000000000002",
        eventKind: "text_observed",
        bridgeUnitRef: { bridgeUnitId: unit.bridgeUnitId, sourceUnitKey: unit.sourceUnitKey },
        frame: 1,
        traceKey: "portable-evidence.trace.1",
        observedText: unit.sourceText,
      },
    ],
    branchEvents: [],
    captures: [],
    recordings: [],
    approximations: [
      {
        approximationId: "019ed800-0000-7000-8000-000000000003",
        approximationTier: "deterministic_fixture",
        scope: "local contract trace",
        description: "Local deterministic trace; no protected-runtime attestation.",
        affectedBridgeUnitRefs: [
          { bridgeUnitId: unit.bridgeUnitId, sourceUnitKey: unit.sourceUnitKey },
        ],
        evidenceTierCeiling: "E1",
      },
    ],
    validationFindings: [],
    limitations: ["Local contract trace only; protected-runtime verification is external."],
  };
  assertRuntimeEvidenceReportV02(report);
  const revisionsMatch = input.sourceRevision === input.currentRevision;
  const sourceBundleHashMatches = report.sourceBundleHash === current.bridge.sourceBundleHash;
  if (revisionsMatch !== sourceBundleHashMatches)
    throw new Error("scenario-runtime-revision-projection-contradiction");
  return {
    kind: "validated-runtime-source-comparison.v1",
    report,
    currentSourceBundleHash: current.bridge.sourceBundleHash,
    sourceBundleHashMatches,
  };
}

function changedKeys(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): { changed: string[]; stable: string[] } {
  const leftHashes = left.artifactHashes;
  const rightHashes = right.artifactHashes;
  if (!isRecord(leftHashes) || !isRecord(rightHashes))
    throw new Error("scenario-artifact-hashes-invalid");
  const keys = Object.keys(leftHashes).sort();
  if (keys.join("\0") !== Object.keys(rightHashes).sort().join("\0"))
    throw new Error("scenario-artifact-key-set-mismatch");
  return {
    changed: keys.filter((key) => leftHashes[key] !== rightHashes[key]),
    stable: keys.filter((key) => leftHashes[key] === rightHashes[key]),
  };
}

export function buildScenarioProjection(input: ScenarioProjectionRequest): Record<string, unknown> {
  if (input.evidenceKind === "runtime observation") return runtimeStaleProjection(input);
  if (input.evidenceKind === "mixed evidence set") {
    const revisions = [input.sourceRevision, input.peerRevision].sort();
    const first = chainArtifacts(revisions[0] ?? "", input.unaffectedRevision);
    const second = chainArtifacts(revisions[1] ?? "", input.unaffectedRevision);
    if (
      (input.sourceRevision !== input.peerRevision) !==
      (first.bridge.sourceBundleHash !== second.bridge.sourceBundleHash)
    )
      throw new Error("scenario-mixed-lineage-projection-contradiction");
    return {
      kind: "mixed-verified-artifact-set.v1",
      firstManifest: first.manifest,
      secondManifest: second.manifest,
      combinedSourceBundleHashes: [
        first.bridge.sourceBundleHash,
        second.bridge.sourceBundleHash,
      ].sort(),
    };
  }
  if (input.evidenceKind === "regenerated evidence set") {
    const before = chainArtifacts(input.alternateRevision, input.unaffectedRevision);
    const after = chainArtifacts(input.sourceRevision, input.unaffectedRevision);
    const changes = changedKeys(before.manifest, after.manifest);
    const revisionsDiffer = input.alternateRevision !== input.sourceRevision;
    const manifestsDiffer = before.bridge.sourceBundleHash !== after.bridge.sourceBundleHash;
    const exactChanges = changes.changed.join("\0") === "compatibilityReport\0patchExport";
    const exactStable = changes.stable.join("\0") === "unaffectedControl";
    if (
      revisionsDiffer !== manifestsDiffer ||
      (revisionsDiffer
        ? !exactChanges || !exactStable
        : changes.changed.length !== 0 || changes.stable.length !== 3)
    )
      throw new Error("scenario-regeneration-projection-contradiction");
    return {
      kind: "regenerated-verified-artifact-set.v1",
      beforeManifest: before.manifest,
      afterManifest: after.manifest,
      changeSet: changes,
    };
  }
  const chain = chainArtifacts(input.sourceRevision, input.unaffectedRevision);
  if (input.evidenceKind === "coherent evidence set" || input.evidenceKind === "patch receipt") {
    return { kind: "coherent-verified-artifact-set.v1", manifest: chain.manifest };
  }
  return {
    kind: "patch-compatibility-chain.v1",
    patchExport: chain.patchExport,
    compatibilityReport: chain.compatibility,
    admission: {
      scanClasses: [...input.scanClasses].sort(),
      publicationAccepted: input.scanClasses.length === 0,
    },
  };
}
