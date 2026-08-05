// Validation and live derivation for private corpus manifests.
//
// Corpus identity belongs in manifest data. Engine-shaped discovery and native
// extraction live behind the CorpusValidationAdapter registry; this module
// keeps the common privacy, content-addressing, and evidence checks.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPinnedCorpusInputs as assertAdapterPinnedCorpusInputs,
  extractCorpusValidationArtifacts,
  fingerprintCorpusInput,
  resolveCorpus as resolveAdapterCorpus,
  resolveCorpusValidationAdapter,
  type CorpusResolution,
  type ResolvedCorpus,
} from "./corpus-validation-registry.js";
import { redactNativeError } from "../native-bin/native-diagnostics.js";
import { parseStrictJson } from "./json.js";
import {
  stableJson,
  type CorpusManifest,
  type CorpusManifestRegistry,
  type FileFingerprint,
} from "./manifest.js";
import { buildSourceCliEnvironment, type SourceCliBuildInput } from "./trusted-cli.js";
import { deriveEvidenceFromOutputs } from "./validate-derive.js";
export { assertCorpusManifest } from "./validate-manifest.js";
import { assertCorpusManifest } from "./validate-manifest.js";
import { readJson } from "./validate-primitives.js";

export type DeriveCorpusDependencies = {
  /** Test seam for proving cleanup around a source-build failure. */
  makeTempRoot?: () => string;
  /** Test seam; production uses the pinned Nix source-build boundary. */
  buildSourceCliEnvironment?: (input: SourceCliBuildInput) => NodeJS.ProcessEnv;
  /** Test seam for a failure that occurs after the temporary root is owned. */
  assertPinnedCorpusInputs?: (corpus: ResolvedCorpus, manifest: CorpusManifest) => void;
  /** Test seam for a display-safe native extraction failure. */
  extractCorpusValidationArtifacts?: typeof extractCorpusValidationArtifacts;
};

/**
 * The only raw-manifest ingress. It rejects duplicate decoded JSON keys before
 * the manifest reaches either the privacy validation or content hash.
 */
export function parseCorpusManifestJson(raw: string): CorpusManifest {
  const parsed = parseStrictJson(raw);
  assertCorpusManifest(parsed);
  return parsed;
}

/** Parse, validate, and register a data instance keyed by its own game id. */
export function registerCorpusManifestJson(
  registry: CorpusManifestRegistry,
  raw: string,
): CorpusManifest {
  const manifest = parseCorpusManifestJson(raw);
  registry.register(manifest);
  return manifest;
}

/**
 * Resolve the one explicitly opted-in corpus and reject a wrong corpus using
 * the manifest's pinned input fingerprints before any decoder is invoked.
 */
export function resolveCorpus(
  manifest: CorpusManifest,
  env: NodeJS.ProcessEnv = process.env,
): CorpusResolution {
  assertCorpusManifest(manifest);
  return resolveAdapterCorpus(manifest, env);
}

/** Build a SHA-256 fingerprint without retaining a content-bearing value. */
export function fingerprintFile(path: string): FileFingerprint {
  return fingerprintCorpusInput(path);
}

/** Reject an input substitution before spending time on a live decode. */
export function assertPinnedCorpusInputs(corpus: ResolvedCorpus, manifest: CorpusManifest): void {
  assertCorpusManifest(manifest);
  assertAdapterPinnedCorpusInputs(corpus, manifest);
}

/**
 * Regenerate the full context and scoped bridge projection using source-built
 * native CLIs. Every artifact and the fresh native target live under one
 * temporary root that is removed even when the build itself fails.
 */
export function deriveCorpusEvidence(
  corpus: ResolvedCorpus,
  manifest: CorpusManifest,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: DeriveCorpusDependencies = {},
): Pick<CorpusManifest, "corpus" | "outputScope"> {
  assertCorpusManifest(manifest);
  const tempRoot = (
    dependencies.makeTempRoot ?? (() => mkdtempSync(join(tmpdir(), "itotori-corpus-")))
  )();
  try {
    (dependencies.assertPinnedCorpusInputs ?? assertPinnedCorpusInputs)(corpus, manifest);
    const {
      ITOTORI_KAIFUU_BIN: _ignoredKaifuuOverride,
      ITOTORI_UTSUSHI_BIN: _ignoredUtsushiOverride,
      ITOTORI_LIBEXEC_DIR: _ignoredLibexecOverride,
      ...nativeEnvBase
    } = env;
    const nativeEnv = (dependencies.buildSourceCliEnvironment ?? buildSourceCliEnvironment)({
      env: nativeEnvBase,
      targetRoot: join(tempRoot, "native-target"),
    });

    const extractArtifacts =
      dependencies.extractCorpusValidationArtifacts ?? extractCorpusValidationArtifacts;
    let artifacts;
    try {
      artifacts = extractArtifacts(manifest, corpus, tempRoot, nativeEnv);
    } catch (error) {
      const diagnostic = redactNativeError(error, nativeEnv);
      throw new Error(`private corpus native validation failed: ${diagnostic}`);
    }

    return deriveEvidenceFromOutputs({
      manifest,
      adapter: resolveCorpusValidationAdapter(manifest.corpus.engine),
      inputs: artifacts.inputs,
      fullBridgeFingerprint: fingerprintFile(artifacts.fullBridgePath),
      scopedBridgeFingerprint: fingerprintFile(artifacts.scopedBridgePath),
      structureFingerprint: fingerprintFile(artifacts.structurePath),
      fullBridge: readJson(artifacts.fullBridgePath, "full bridge"),
      fullReport: readJson(artifacts.fullReportPath, "full decompile report"),
      scopedBridge: readJson(artifacts.scopedBridgePath, "scoped bridge"),
      scopedReport: readJson(artifacts.scopedReportPath, "scoped decompile report"),
      structure: readJson(artifacts.structurePath, "full structure"),
    });
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

/** Compare a live metadata projection to its reviewed manifest data. */
export function assertCorpusEvidenceMatchesManifest(
  evidence: Pick<CorpusManifest, "corpus" | "outputScope">,
  manifest: CorpusManifest,
): void {
  assertCorpusManifest(manifest);
  if (stableJson(evidence.corpus) !== stableJson(manifest.corpus)) {
    throw new Error("private corpus full-game metadata drifted from its manifest");
  }
  if (stableJson(evidence.outputScope) !== stableJson(manifest.outputScope)) {
    throw new Error("private corpus scoped output drifted from its manifest");
  }
}
