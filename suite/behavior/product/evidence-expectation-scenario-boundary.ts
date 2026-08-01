import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertRuntimeEvidenceReportV02,
  evaluatePatchExportCompatibilityV02,
} from "@itotori/localization-bridge-schema";

import {
  hashLocalizationArtifact,
  verifyLocalizationArtifactManifest,
} from "../../../packages/itotori-db/src/localization-artifact-integrity.js";
import { bindScopedTargets } from "../../../apps/itotori/src/patchback/bind-scoped-targets.js";
import { buildPatchExportV02 } from "../../../apps/itotori/src/patchback/build-patch-export.js";
import { buildPatchScenarioInput } from "./evidence-product-fixture.js";

interface ExpectationRequest {
  evidenceKind: string;
  sourceRevision: string;
  currentRevision: string;
  peerRevision: string;
  alternateRevision: string;
  unaffectedRevision: string;
  scanClasses: readonly string[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label}-invalid`);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = entry;
  return output;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function request(value: string | undefined): ExpectationRequest {
  if (value === undefined) throw new Error("expectation-scenario-request-missing");
  const parsed = record(JSON.parse(value), "expectation-scenario-request");
  if (
    !Array.isArray(parsed.scanClasses) ||
    parsed.scanClasses.some((item) => typeof item !== "string")
  )
    throw new Error("expectation-scenario-scan-classes-invalid");
  return {
    evidenceKind: text(parsed.evidenceKind, "expectation-scenario-kind"),
    sourceRevision: text(parsed.sourceRevision, "expectation-scenario-source"),
    currentRevision: text(parsed.currentRevision, "expectation-scenario-current"),
    peerRevision: text(parsed.peerRevision, "expectation-scenario-peer"),
    alternateRevision: text(parsed.alternateRevision, "expectation-scenario-alternate"),
    unaffectedRevision: text(parsed.unaffectedRevision, "expectation-scenario-unaffected"),
    scanClasses: parsed.scanClasses.filter((item): item is string => typeof item === "string"),
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = record(value, "expectation-scenario-value");
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
    .join(",")}}`;
}

function evaluateRevision(revision: string) {
  const source = buildPatchScenarioInput(revision);
  const targets = bindScopedTargets(source.input);
  const patchExport = buildPatchExportV02(source.input, targets);
  const compatibility = evaluatePatchExportCompatibilityV02(patchExport, source.bridge);
  return { bridge: source.bridge, patchExport, compatibility };
}

function verifiedSet(
  sourceBundleHash: string,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), "expectation-product-artifacts-"));
  try {
    const refs: Record<string, string> = {};
    const hashes: Record<string, string> = {};
    for (const key of Object.keys(values).sort()) {
      const path = resolve(root, `${key}.json`);
      writeFileSync(path, `${canonical(values[key])}\n`);
      refs[key] = path;
      hashes[key] = hashLocalizationArtifact(path);
    }
    verifyLocalizationArtifactManifest(refs, hashes);
    return { sourceBundleHash, artifactHashes: hashes, artifactKeys: Object.keys(hashes).sort() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function artifactChain(revision: string, unaffectedRevision: string) {
  const result = evaluateRevision(revision);
  return {
    ...result,
    manifest: verifiedSet(result.bridge.sourceBundleHash, {
      patchExport: result.patchExport,
      compatibilityReport: result.compatibility,
      unaffectedControl: { unaffectedRevision },
    }),
  };
}

function runtimeProjection(input: ExpectationRequest): Record<string, unknown> {
  const source = evaluateRevision(input.sourceRevision);
  const current = evaluateRevision(input.currentRevision);
  const unit = source.bridge.units[0];
  if (unit === undefined) throw new Error("expectation-runtime-unit-missing");
  const targetLocale = unit.policy?.targetLocale;
  if (targetLocale === undefined) throw new Error("expectation-runtime-target-locale-missing");
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
    throw new Error("expectation-runtime-revision-projection-contradiction");
  return {
    kind: "validated-runtime-source-comparison.v1",
    report,
    currentSourceBundleHash: current.bridge.sourceBundleHash,
    sourceBundleHashMatches,
  };
}

function changeSet(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftHashes = record(left.artifactHashes, "expectation-left-hashes");
  const rightHashes = record(right.artifactHashes, "expectation-right-hashes");
  const keys = Object.keys(leftHashes).sort();
  if (keys.join("\0") !== Object.keys(rightHashes).sort().join("\0"))
    throw new Error("expectation-artifact-key-set-mismatch");
  return {
    changed: keys.filter((key) => leftHashes[key] !== rightHashes[key]),
    stable: keys.filter((key) => leftHashes[key] === rightHashes[key]),
  };
}

function project(input: ExpectationRequest): Record<string, unknown> {
  if (input.evidenceKind === "runtime observation") return runtimeProjection(input);
  if (input.evidenceKind === "mixed evidence set") {
    const revisions = [input.sourceRevision, input.peerRevision].sort();
    const first = artifactChain(revisions[0] ?? "", input.unaffectedRevision);
    const second = artifactChain(revisions[1] ?? "", input.unaffectedRevision);
    if (
      (input.sourceRevision !== input.peerRevision) !==
      (first.bridge.sourceBundleHash !== second.bridge.sourceBundleHash)
    )
      throw new Error("expectation-mixed-lineage-projection-contradiction");
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
    const before = artifactChain(input.alternateRevision, input.unaffectedRevision);
    const after = artifactChain(input.sourceRevision, input.unaffectedRevision);
    const changes = changeSet(before.manifest, after.manifest);
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
      throw new Error("expectation-regeneration-projection-contradiction");
    return {
      kind: "regenerated-verified-artifact-set.v1",
      beforeManifest: before.manifest,
      afterManifest: after.manifest,
      changeSet: changes,
    };
  }
  const chain = artifactChain(input.sourceRevision, input.unaffectedRevision);
  if (input.evidenceKind === "coherent evidence set" || input.evidenceKind === "patch receipt")
    return { kind: "coherent-verified-artifact-set.v1", manifest: chain.manifest };
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(project(request(process.argv[2])))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
