// Validation and live derivation for private corpus manifests.
//
// Corpus identity belongs in manifest data. This module deliberately owns only
// the reusable RealLive adapter and never retains decoded dialogue outside the
// short-lived projection built during an opt-in validation run.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runKaifuuExtract } from "../extract/kaifuu-extract-seam.js";
import { runStructureProvider } from "../structure-export/structure-provider-registry.js";
import { parseStrictJson } from "./json.js";
import {
  CORPUS_MANIFEST_SCHEMA_VERSION,
  REAL_CORPUS_ROOT_ENV,
  corpusManifestContentHash,
  sha256Bytes,
  stableJson,
  type CorpusEvidence,
  type CorpusManifest,
  type CorpusManifestRegistry,
  type CorpusOutputScope,
  type CorpusUnit,
  type FileFingerprint,
  type OrdinalRange,
  type ProtectedSkeleton,
  type ProtectedSpanPart,
  type RedactedTextPart,
  type ScopedScene,
  type Sha256,
} from "./manifest.js";
import { buildSourceCliEnvironment, type SourceCliBuildInput } from "./trusted-cli.js";

type JsonRecord = Record<string, unknown>;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const UUID7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORBIDDEN_PAYLOADS = [
  "sourceText",
  "speaker text",
  "protected-span raw payload",
  "full bridge export",
  "full structure export",
] as const;
const PROTECTED_NAMES = new Set(["reallive.kidoku", "reallive.name_token"]);

export type ResolvedCorpus = {
  gameRoot: string;
  gameexePath: string;
  seenPath: string;
};

export type CorpusResolution =
  | { kind: "ready"; corpus: ResolvedCorpus }
  | { kind: "skip"; reason: string };

export type DeriveCorpusDependencies = {
  /** Test seam for proving cleanup around a source-build failure. */
  makeTempRoot?: () => string;
  /** Test seam; production uses the pinned Nix source-build boundary. */
  buildSourceCliEnvironment?: (input: SourceCliBuildInput) => NodeJS.ProcessEnv;
  /** Test seam for a failure that occurs after the temporary root is owned. */
  assertPinnedCorpusInputs?: (corpus: ResolvedCorpus, manifest: CorpusManifest) => void;
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
export function resolveRealCorpus(
  manifest: CorpusManifest,
  env: NodeJS.ProcessEnv = process.env,
): CorpusResolution {
  assertCorpusManifest(manifest);
  const configuredRoot = env[REAL_CORPUS_ROOT_ENV];
  if (configuredRoot === undefined || configuredRoot.length === 0) {
    return {
      kind: "skip",
      reason: `${REAL_CORPUS_ROOT_ENV} is unset; no private corpus bytes were read.`,
    };
  }
  if (manifest.corpus.engine !== "reallive") {
    throw new Error("private corpus validation has no adapter for the manifest engine");
  }

  const root = resolve(configuredRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`private corpus root ${REAL_CORPUS_ROOT_ENV} is not a directory`);
  }
  const candidates = [...new Set(candidateGameRoots(root, 4))];
  if (candidates.length !== 1) {
    throw new Error("private corpus root must contain exactly one RealLive game data directory");
  }

  const gameRoot = candidates[0]!;
  const dataRoot = join(gameRoot, "REALLIVEDATA");
  const corpus = {
    gameRoot,
    gameexePath: join(dataRoot, "Gameexe.ini"),
    seenPath: join(dataRoot, "Seen.txt"),
  };
  if (!isRegularFile(corpus.gameexePath) || !isRegularFile(corpus.seenPath)) {
    throw new Error("private corpus root is missing regular RealLive input files");
  }
  assertPinnedCorpusInputs(corpus, manifest);
  return { kind: "ready", corpus };
}

/** Build a SHA-256 fingerprint without retaining a content-bearing value. */
export function fingerprintFile(path: string): FileFingerprint {
  const bytes = readFileSync(path);
  return { sha256: sha256Bytes(bytes), byteLength: bytes.byteLength };
}

/** Reject an input substitution before spending time on a live decode. */
export function assertPinnedCorpusInputs(corpus: ResolvedCorpus, manifest: CorpusManifest): void {
  assertSameFingerprint(
    fingerprintFile(corpus.seenPath),
    manifest.corpus.inputs.seenTxt,
    "Seen.txt",
  );
  assertSameFingerprint(
    fingerprintFile(corpus.gameexePath),
    manifest.corpus.inputs.gameexeIni,
    "Gameexe.ini",
  );
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
    const fullBridgePath = join(tempRoot, "full.bridge.json");
    const fullReportPath = join(tempRoot, "full.decompile-report.json");
    const scopedBridgePath = join(tempRoot, "scoped.bridge.json");
    const scopedReportPath = join(tempRoot, "scoped.decompile-report.json");
    const structurePath = join(tempRoot, "full.structure.json");
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

    try {
      const identity = manifest.corpus;
      runKaifuuExtract({
        engine: "reallive",
        gameRoot: corpus.gameRoot,
        gameId: identity.gameId,
        gameVersion: identity.gameVersion,
        sourceProfileId: identity.sourceProfileId,
        sourceLocale: identity.sourceLocale,
        wholeSeen: true,
        bundleOutputPath: fullBridgePath,
        decompileReportOutputPath: fullReportPath,
        env: nativeEnv,
      });
      runKaifuuExtract({
        engine: "reallive",
        gameRoot: corpus.gameRoot,
        gameId: identity.gameId,
        gameVersion: identity.gameVersion,
        sourceProfileId: identity.sourceProfileId,
        sourceLocale: identity.sourceLocale,
        scene: manifest.outputScope.sceneId,
        bundleOutputPath: scopedBridgePath,
        decompileReportOutputPath: scopedReportPath,
        env: nativeEnv,
      });
      runStructureProvider({
        engine: "reallive",
        gameexePath: corpus.gameexePath,
        seenPath: corpus.seenPath,
        outputPath: structurePath,
        maxScenes: 10_000,
        env: nativeEnv,
      });
    } catch {
      // Both native seams are intentionally content-free at this boundary.
      // In particular, do not rethrow a future producer diagnostic verbatim.
      throw new Error("private corpus native validation failed [native output redacted]");
    }

    return deriveEvidenceFromOutputs({
      manifest,
      seenFingerprint: fingerprintFile(corpus.seenPath),
      gameexeFingerprint: fingerprintFile(corpus.gameexePath),
      fullBridgeFingerprint: fingerprintFile(fullBridgePath),
      scopedBridgeFingerprint: fingerprintFile(scopedBridgePath),
      structureFingerprint: fingerprintFile(structurePath),
      fullBridge: readJson(fullBridgePath, "full bridge"),
      fullReport: readJson(fullReportPath, "full decompile report"),
      scopedBridge: readJson(scopedBridgePath, "scoped bridge"),
      scopedReport: readJson(scopedReportPath, "scoped decompile report"),
      structure: readJson(structurePath, "full structure"),
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

function deriveEvidenceFromOutputs(input: {
  manifest: CorpusManifest;
  seenFingerprint: FileFingerprint;
  gameexeFingerprint: FileFingerprint;
  fullBridgeFingerprint: FileFingerprint;
  scopedBridgeFingerprint: FileFingerprint;
  structureFingerprint: FileFingerprint;
  fullBridge: unknown;
  fullReport: unknown;
  scopedBridge: unknown;
  scopedReport: unknown;
  structure: unknown;
}): Pick<CorpusManifest, "corpus" | "outputScope"> {
  const fullBridge = record(input.fullBridge, "full bridge");
  const fullReport = record(input.fullReport, "full decompile report");
  const scopedBridge = record(input.scopedBridge, "scoped bridge");
  const scopedReport = record(input.scopedReport, "scoped decompile report");
  const structure = record(input.structure, "full structure");
  const fullUnits = array(fullBridge.units, "full bridge.units").map((unit, index) =>
    record(unit, `full bridge.units[${index}]`),
  );
  const routeSceneKeys = new Set(
    fullUnits.map((unit, index) =>
      nativeString(
        record(record(unit.context, `full bridge.units[${index}].context`).route, "route").sceneKey,
        `full bridge.units[${index}].context.route.sceneKey`,
      ),
    ),
  );
  const scopedScene = summarizeStructure(structure, input.manifest.outputScope.sceneId);
  const units = deriveScopedUnits(
    scopedBridge,
    input.manifest.outputScope.sceneId,
    scopedScene.dispatchIndex,
  );
  const unitIds = new Set(units.map((unit) => unit.bridgeUnitId));
  const sourceHashes = new Set(units.map((unit) => unit.sourceHash));

  const corpus: CorpusEvidence = {
    corpusId: input.manifest.corpus.corpusId,
    gameId: input.manifest.corpus.gameId,
    gameVersion: input.manifest.corpus.gameVersion,
    sourceProfileId: input.manifest.corpus.sourceProfileId,
    engine: input.manifest.corpus.engine,
    sourceLocale: input.manifest.corpus.sourceLocale,
    inputs: { seenTxt: input.seenFingerprint, gameexeIni: input.gameexeFingerprint },
    fullGame: {
      kaifuuDecode: {
        schemaVersion: nativeString(fullBridge.schemaVersion, "full bridge.schemaVersion"),
        bridgeExport: input.fullBridgeFingerprint,
        sourceBundleHash: sha256(fullBridge.sourceBundleHash, "full bridge.sourceBundleHash"),
        assetCount: array(fullBridge.assets, "full bridge.assets").length,
        unitCount: fullUnits.length,
        routeSceneCount: routeSceneKeys.size,
        decompile: {
          schemaVersion: nativeString(fullReport.schemaVersion, "full report.schemaVersion"),
          scope: nativeString(fullReport.scope, "full report.scope"),
          sceneCount: finiteNumber(fullReport.sceneCount, "full report.sceneCount"),
          totalOpcodes: finiteNumber(fullReport.totalOpcodes, "full report.totalOpcodes"),
          recognizedOpcodes: finiteNumber(
            fullReport.recognizedOpcodes,
            "full report.recognizedOpcodes",
          ),
          unknownOpcodes: finiteNumber(fullReport.unknownOpcodes, "full report.unknownOpcodes"),
          sourceSeenSha256: sha256(fullReport.sourceSeenSha256, "full report.sourceSeenSha256"),
        },
      },
      utsushiStructure: {
        schemaVersion: nativeString(structure.schemaVersion, "full structure.schemaVersion"),
        structureExport: input.structureFingerprint,
        entryScene: finiteNumber(structure.entryScene, "full structure.entryScene"),
        sceneCount: array(structure.scenes, "full structure.scenes").length,
        dispatchOrderCount: array(structure.sceneDispatchOrder, "full structure.sceneDispatchOrder")
          .length,
        messageCount: scopedScene.totalMessageCount,
        choiceCount: scopedScene.totalChoiceCount,
        speakerCount: scopedScene.speakerCount,
        scopedScene: scopedScene.value,
      },
    },
  };
  const outputScope: CorpusOutputScope = {
    scopeId: input.manifest.outputScope.scopeId,
    sceneId: input.manifest.outputScope.sceneId,
    ordinalRange: input.manifest.outputScope.ordinalRange,
    bridge: {
      schemaVersion: nativeString(scopedBridge.schemaVersion, "scoped bridge.schemaVersion"),
      bridgeExport: input.scopedBridgeFingerprint,
      sourceBundleHash: sha256(scopedBridge.sourceBundleHash, "scoped bridge.sourceBundleHash"),
      decompile: {
        schemaVersion: nativeString(scopedReport.schemaVersion, "scoped report.schemaVersion"),
        sceneId: finiteNumber(scopedReport.sceneId, "scoped report.sceneId"),
        totalOpcodes: finiteNumber(scopedReport.totalOpcodes, "scoped report.totalOpcodes"),
        recognizedOpcodes: finiteNumber(
          scopedReport.recognizedOpcodes,
          "scoped report.recognizedOpcodes",
        ),
        unknownOpcodes: finiteNumber(scopedReport.unknownOpcodes, "scoped report.unknownOpcodes"),
        sourceSeenSha256: sha256(scopedReport.sourceSeenSha256, "scoped report.sourceSeenSha256"),
      },
      unitCount: units.length,
      uniqueBridgeUnitIdCount: unitIds.size,
      uniqueSourceHashCount: sourceHashes.size,
      unitsProjectionSha256: sha256Bytes(stableJson(units)),
    },
    units,
  };

  if (
    corpus.fullGame.kaifuuDecode.decompile.unknownOpcodes !== 0 ||
    outputScope.bridge.decompile.unknownOpcodes !== 0 ||
    corpus.inputs.seenTxt.sha256 !== corpus.fullGame.kaifuuDecode.decompile.sourceSeenSha256 ||
    corpus.inputs.seenTxt.sha256 !== outputScope.bridge.decompile.sourceSeenSha256
  ) {
    throw new Error("private corpus decoder report rejected");
  }
  return { corpus, outputScope };
}

function summarizeStructure(
  structure: JsonRecord,
  scopedSceneId: number,
): {
  value: ScopedScene;
  totalMessageCount: number;
  totalChoiceCount: number;
  speakerCount: number;
  dispatchIndex: number;
} {
  const scenes = array(structure.scenes, "full structure.scenes").map((scene, index) =>
    record(scene, `full structure.scenes[${index}]`),
  );
  const dispatchOrder = array(
    structure.sceneDispatchOrder,
    "full structure.sceneDispatchOrder",
  ).map((scene, index) => integer(scene, `full structure.sceneDispatchOrder[${index}]`));
  const sceneIds = scenes.map((scene, index) =>
    integer(scene.sceneId, `full structure.scenes[${index}].sceneId`),
  );
  if (
    new Set(sceneIds).size !== sceneIds.length ||
    new Set(dispatchOrder).size !== dispatchOrder.length ||
    sceneIds.length !== dispatchOrder.length ||
    sceneIds.some((sceneId) => !dispatchOrder.includes(sceneId))
  ) {
    throw new Error("private corpus structure dispatch is inconsistent");
  }
  const dispatchIndex = dispatchOrder.indexOf(scopedSceneId);
  const scopedScene = scenes.find((scene) => scene.sceneId === scopedSceneId);
  if (scopedScene === undefined || dispatchIndex < 0) {
    throw new Error("private corpus structure is missing the manifest scoped scene");
  }

  let totalMessageCount = 0;
  let totalChoiceCount = 0;
  const speakers = new Set<string>();
  for (const [sceneIndex, scene] of scenes.entries()) {
    const messages = array(scene.messages, `full structure.scenes[${sceneIndex}].messages`);
    totalMessageCount += messages.length;
    totalChoiceCount += array(scene.choices, `full structure.scenes[${sceneIndex}].choices`).length;
    for (const [messageIndex, message] of messages.entries()) {
      const speaker = record(
        message,
        `full structure.scenes[${sceneIndex}].messages[${messageIndex}]`,
      ).speaker;
      if (speaker !== null) speakers.add(nativeString(speaker, "full structure message.speaker"));
    }
  }
  const scopedMessages = array(scopedScene.messages, "scoped structure.messages");
  const scopedChoices = array(scopedScene.choices, "scoped structure.choices");
  const value: ScopedScene = {
    sceneId: scopedSceneId,
    messageCount: scopedMessages.length,
    choiceCount: scopedChoices.length,
    nextScene: nullableInteger(scopedScene.nextScene, "scoped structure.nextScene"),
    selectionControl: nativeString(
      scopedScene.selectionControl,
      "scoped structure.selectionControl",
    ),
    dispatchFanoutScenes: array(
      scopedScene.dispatchFanoutScenes,
      "scoped structure.dispatchFanoutScenes",
    ).map((scene, index) => integer(scene, `scoped structure.dispatchFanoutScenes[${index}]`)),
    dispatchIndex,
  };
  return { value, totalMessageCount, totalChoiceCount, speakerCount: speakers.size, dispatchIndex };
}

function deriveScopedUnits(
  bridge: JsonRecord,
  sceneId: number,
  structureDispatchIndex: number,
): CorpusUnit[] {
  return array(bridge.units, "scoped bridge.units").map((rawUnit, index) => {
    const unit = record(rawUnit, `scoped bridge.units[${index}]`);
    const sourceLocation = record(
      unit.sourceLocation,
      `scoped bridge.units[${index}].sourceLocation`,
    );
    const range = record(
      sourceLocation.range,
      `scoped bridge.units[${index}].sourceLocation.range`,
    );
    const context = record(unit.context, `scoped bridge.units[${index}].context`);
    const route = record(context.route, `scoped bridge.units[${index}].context.route`);
    const expectation = record(
      unit.runtimeExpectation,
      `scoped bridge.units[${index}].runtimeExpectation`,
    );
    const sourceRevision = record(
      unit.sourceRevision,
      `scoped bridge.units[${index}].sourceRevision`,
    );
    const byteLocation = {
      containerKey: nativeString(sourceLocation.containerKey, "scoped bridge source container"),
      entryPath: array(sourceLocation.entryPath, "scoped bridge source entryPath").map(
        (entry, entryIndex) => nativeString(entry, `scoped bridge source entryPath[${entryIndex}]`),
      ),
      range: {
        startByte: integer(range.startByte, "scoped bridge source range start"),
        endByte: integer(range.endByte, "scoped bridge source range end"),
      },
    };
    if (byteLocation.range.endByte <= byteLocation.range.startByte) {
      throw new Error("private corpus unit has a non-positive source range");
    }
    const sourceText = nativeString(unit.sourceText, "scoped bridge source text");
    return {
      bridgeUnitId: nativeString(unit.bridgeUnitId, "scoped bridge unit id"),
      sourceUnitKey: nativeString(unit.sourceUnitKey, "scoped bridge source key"),
      occurrenceId: nativeString(unit.occurrenceId, "scoped bridge occurrence id"),
      surfaceKind: nativeString(unit.surfaceKind, "scoped bridge surface kind"),
      sourceHash: sha256(unit.sourceHash, "scoped bridge source hash"),
      sourceRevision: {
        revisionId: nativeString(sourceRevision.revisionId, "scoped bridge revision id"),
        revisionKind: nativeString(sourceRevision.revisionKind, "scoped bridge revision kind"),
        value: sha256(sourceRevision.value, "scoped bridge revision value"),
      },
      byteLocation,
      protectedSkeleton: buildProtectedSkeleton(sourceText, unit.spans, byteLocation.range),
      route: {
        sceneKey: nativeString(route.sceneKey, "scoped bridge route scene"),
        position: nativeString(route.position, "scoped bridge route position"),
      },
      sceneMembership: { sceneId, structureDispatchIndex },
      replayTarget: {
        expectationKind: nativeString(
          expectation.expectationKind,
          "scoped bridge expectation kind",
        ),
        traceKey: nativeString(expectation.traceKey, "scoped bridge trace key"),
      },
    } satisfies CorpusUnit;
  });
}

function buildProtectedSkeleton(
  sourceText: string,
  spansValue: unknown,
  sourceRange: { startByte: number; endByte: number },
): ProtectedSkeleton {
  const sourceLength = Buffer.byteLength(sourceText, "utf8");
  const spans = array(spansValue, "scoped bridge spans").map((rawSpan, index) => {
    const span = record(rawSpan, `scoped bridge spans[${index}]`);
    const startByte = integer(span.startByte, "scoped bridge span start");
    const endByte = integer(span.endByte, "scoped bridge span end");
    const raw = nativeString(span.raw, "scoped bridge span raw");
    if (
      startByte < 0 ||
      endByte <= startByte ||
      endByte > sourceLength ||
      Buffer.byteLength(raw, "utf8") !== endByte - startByte
    ) {
      throw new Error("private corpus protected-span range is invalid");
    }
    return {
      spanIndex: index,
      spanKind: nativeString(span.spanKind, "scoped bridge span kind"),
      parsedName: nullableNativeString(span.parsedName, "scoped bridge parsed span name"),
      startByte,
      endByte,
      rawSha256: sha256Bytes(raw),
      preserveMode: nativeString(span.preserveMode, "scoped bridge span preservation"),
      outOfBand: span.outOfBand === true,
    };
  });
  if (spans.some((span, index) => index > 0 && span.startByte < spans[index - 1]!.endByte)) {
    throw new Error("private corpus protected spans overlap or are out of order");
  }
  const parts: Array<RedactedTextPart | ProtectedSpanPart> = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.startByte > cursor) {
      parts.push({
        kind: "redacted_text",
        startByte: cursor,
        endByte: span.startByte,
        utf8ByteLength: span.startByte - cursor,
      });
    }
    parts.push({
      kind: "protected_span",
      spanIndex: span.spanIndex,
      spanKind: span.spanKind,
      parsedName: span.parsedName,
      startByte: span.startByte,
      endByte: span.endByte,
      utf8ByteLength: span.endByte - span.startByte,
      rawSha256: span.rawSha256,
      preserveMode: span.preserveMode,
      outOfBand: span.outOfBand,
    });
    cursor = span.endByte;
  }
  if (cursor < sourceLength) {
    parts.push({
      kind: "redacted_text",
      startByte: cursor,
      endByte: sourceLength,
      utf8ByteLength: sourceLength - cursor,
    });
  }
  return {
    format: "itotori.redacted-sjis-protected-shell.v1",
    sourceEncoding: "shift-jis-with-reallive-control-spans",
    sourceTextUtf8ByteLength: sourceLength,
    decompressedSourceByteLength: sourceRange.endByte - sourceRange.startByte,
    shell: parts
      .map((part) =>
        part.kind === "redacted_text"
          ? `<REDACTED_TEXT:utf8=${part.utf8ByteLength}>`
          : `<PROTECTED:${part.parsedName ?? part.spanKind}:utf8=${part.utf8ByteLength}>`,
      )
      .join(""),
    parts,
  };
}

/**
 * Validate the metadata-only schema. Exact-key checks are intentionally the
 * payload allow-list; there is no second recursive forbidden-key walk to drift
 * from this schema.
 */
export function assertCorpusManifest(value: unknown): asserts value is CorpusManifest {
  const manifest = record(value, "manifest");
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "manifestId",
      "contentAddress",
      "privacy",
      "corpus",
      "outputScope",
      "failedRunBaseline",
    ],
    "manifest",
  );
  if (
    metadataString(manifest.schemaVersion, "manifest.schemaVersion") !==
    CORPUS_MANIFEST_SCHEMA_VERSION
  ) {
    throw new Error("private corpus manifest schema version is unsupported");
  }
  metadataString(manifest.manifestId, "manifest.manifestId");
  validateContentAddress(record(manifest.contentAddress, "manifest.contentAddress"));
  validatePrivacy(record(manifest.privacy, "manifest.privacy"));
  const corpus = validateCorpus(record(manifest.corpus, "manifest.corpus"));
  const outputScope = validateOutputScope(
    record(manifest.outputScope, "manifest.outputScope"),
    corpus,
  );
  validateBaseline(record(manifest.failedRunBaseline, "manifest.failedRunBaseline"), outputScope);

  const typed = value as CorpusManifest;
  if (typed.contentAddress.manifestSha256 !== corpusManifestContentHash(typed)) {
    throw new Error("private corpus manifest content address does not match its metadata");
  }
}

function validateContentAddress(value: JsonRecord): void {
  assertExactKeys(
    value,
    ["algorithm", "canonicalization", "manifestSha256"],
    "manifest.contentAddress",
  );
  if (
    metadataString(value.algorithm, "manifest.contentAddress.algorithm") !== "sha256" ||
    metadataString(value.canonicalization, "manifest.contentAddress.canonicalization") !==
      "json-key-sort-v1"
  ) {
    throw new Error("private corpus manifest content address is unsupported");
  }
  sha256(value.manifestSha256, "manifest.contentAddress.manifestSha256");
}

function validatePrivacy(value: JsonRecord): void {
  assertExactKeys(
    value,
    ["classification", "containsCopyrightedBytes", "forbiddenPayloads"],
    "manifest.privacy",
  );
  if (
    metadataString(value.classification, "manifest.privacy.classification") !==
      "private-corpus-metadata-only" ||
    value.containsCopyrightedBytes !== false
  ) {
    throw new Error("private corpus manifest privacy declaration is invalid");
  }
  const forbidden = array(value.forbiddenPayloads, "manifest.privacy.forbiddenPayloads").map(
    (entry, index) => metadataString(entry, `manifest.privacy.forbiddenPayloads[${index}]`),
  );
  if (stableJson(forbidden) !== stableJson(FORBIDDEN_PAYLOADS)) {
    throw new Error("private corpus manifest privacy prohibition list drifted");
  }
}

function validateCorpus(value: JsonRecord): CorpusEvidence {
  assertExactKeys(
    value,
    [
      "corpusId",
      "gameId",
      "gameVersion",
      "sourceProfileId",
      "engine",
      "sourceLocale",
      "inputs",
      "fullGame",
    ],
    "manifest.corpus",
  );
  const corpusId = metadataString(value.corpusId, "manifest.corpus.corpusId");
  const gameId = metadataString(value.gameId, "manifest.corpus.gameId");
  const gameVersion = metadataString(value.gameVersion, "manifest.corpus.gameVersion");
  const sourceProfileId = metadataString(value.sourceProfileId, "manifest.corpus.sourceProfileId");
  const engine = metadataString(value.engine, "manifest.corpus.engine");
  const sourceLocale = metadataString(value.sourceLocale, "manifest.corpus.sourceLocale");
  if (engine !== "reallive") {
    throw new Error("private corpus manifest engine has no installed adapter");
  }
  const inputs = record(value.inputs, "manifest.corpus.inputs");
  assertExactKeys(inputs, ["seenTxt", "gameexeIni"], "manifest.corpus.inputs");
  const seenTxt = validateFingerprint(
    record(inputs.seenTxt, "manifest.corpus.inputs.seenTxt"),
    "manifest.corpus.inputs.seenTxt",
  );
  const gameexeIni = validateFingerprint(
    record(inputs.gameexeIni, "manifest.corpus.inputs.gameexeIni"),
    "manifest.corpus.inputs.gameexeIni",
  );

  const fullGame = record(value.fullGame, "manifest.corpus.fullGame");
  assertExactKeys(fullGame, ["kaifuuDecode", "utsushiStructure"], "manifest.corpus.fullGame");
  const kaifuuDecode = validateKaifuuDecode(
    record(fullGame.kaifuuDecode, "manifest.corpus.fullGame.kaifuuDecode"),
    seenTxt,
  );
  const utsushiStructure = validateStructure(
    record(fullGame.utsushiStructure, "manifest.corpus.fullGame.utsushiStructure"),
  );
  return {
    corpusId,
    gameId,
    gameVersion,
    sourceProfileId,
    engine,
    sourceLocale,
    inputs: { seenTxt, gameexeIni },
    fullGame: { kaifuuDecode, utsushiStructure },
  };
}

function validateKaifuuDecode(
  value: JsonRecord,
  seenTxt: FileFingerprint,
): CorpusEvidence["fullGame"]["kaifuuDecode"] {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "bridgeExport",
      "sourceBundleHash",
      "assetCount",
      "unitCount",
      "routeSceneCount",
      "decompile",
    ],
    "manifest.corpus.fullGame.kaifuuDecode",
  );
  const decompile = record(value.decompile, "manifest.corpus.fullGame.kaifuuDecode.decompile");
  assertExactKeys(
    decompile,
    [
      "schemaVersion",
      "scope",
      "sceneCount",
      "totalOpcodes",
      "recognizedOpcodes",
      "unknownOpcodes",
      "sourceSeenSha256",
    ],
    "manifest.corpus.fullGame.kaifuuDecode.decompile",
  );
  const decoded = {
    schemaVersion: metadataString(
      value.schemaVersion,
      "manifest.corpus.fullGame.kaifuuDecode.schemaVersion",
    ),
    bridgeExport: validateFingerprint(
      record(value.bridgeExport, "manifest.corpus.fullGame.kaifuuDecode.bridgeExport"),
      "manifest.corpus.fullGame.kaifuuDecode.bridgeExport",
    ),
    sourceBundleHash: sha256(
      value.sourceBundleHash,
      "manifest.corpus.fullGame.kaifuuDecode.sourceBundleHash",
    ),
    assetCount: positiveInteger(
      value.assetCount,
      "manifest.corpus.fullGame.kaifuuDecode.assetCount",
    ),
    unitCount: positiveInteger(value.unitCount, "manifest.corpus.fullGame.kaifuuDecode.unitCount"),
    routeSceneCount: positiveInteger(
      value.routeSceneCount,
      "manifest.corpus.fullGame.kaifuuDecode.routeSceneCount",
    ),
    decompile: {
      schemaVersion: metadataString(
        decompile.schemaVersion,
        "manifest.corpus.fullGame.kaifuuDecode.decompile.schemaVersion",
      ),
      scope: metadataString(
        decompile.scope,
        "manifest.corpus.fullGame.kaifuuDecode.decompile.scope",
      ),
      sceneCount: positiveInteger(
        decompile.sceneCount,
        "manifest.corpus.fullGame.kaifuuDecode.decompile.sceneCount",
      ),
      totalOpcodes: positiveInteger(
        decompile.totalOpcodes,
        "manifest.corpus.fullGame.kaifuuDecode.decompile.totalOpcodes",
      ),
      recognizedOpcodes: positiveInteger(
        decompile.recognizedOpcodes,
        "manifest.corpus.fullGame.kaifuuDecode.decompile.recognizedOpcodes",
      ),
      unknownOpcodes: nonNegativeInteger(
        decompile.unknownOpcodes,
        "manifest.corpus.fullGame.kaifuuDecode.decompile.unknownOpcodes",
      ),
      sourceSeenSha256: sha256(
        decompile.sourceSeenSha256,
        "manifest.corpus.fullGame.kaifuuDecode.decompile.sourceSeenSha256",
      ),
    },
  };
  if (
    decoded.decompile.scope !== "whole-seen" ||
    decoded.decompile.unknownOpcodes !== 0 ||
    decoded.decompile.totalOpcodes !== decoded.decompile.recognizedOpcodes ||
    decoded.decompile.sourceSeenSha256 !== seenTxt.sha256
  ) {
    throw new Error("private corpus full-game decoder evidence is inconsistent");
  }
  return decoded;
}

function validateStructure(value: JsonRecord): CorpusEvidence["fullGame"]["utsushiStructure"] {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "structureExport",
      "entryScene",
      "sceneCount",
      "dispatchOrderCount",
      "messageCount",
      "choiceCount",
      "speakerCount",
      "scopedScene",
    ],
    "manifest.corpus.fullGame.utsushiStructure",
  );
  const scopedScene = record(
    value.scopedScene,
    "manifest.corpus.fullGame.utsushiStructure.scopedScene",
  );
  assertExactKeys(
    scopedScene,
    [
      "sceneId",
      "messageCount",
      "choiceCount",
      "nextScene",
      "selectionControl",
      "dispatchFanoutScenes",
      "dispatchIndex",
    ],
    "manifest.corpus.fullGame.utsushiStructure.scopedScene",
  );
  return {
    schemaVersion: metadataString(
      value.schemaVersion,
      "manifest.corpus.fullGame.utsushiStructure.schemaVersion",
    ),
    structureExport: validateFingerprint(
      record(value.structureExport, "manifest.corpus.fullGame.utsushiStructure.structureExport"),
      "manifest.corpus.fullGame.utsushiStructure.structureExport",
    ),
    entryScene: nonNegativeInteger(
      value.entryScene,
      "manifest.corpus.fullGame.utsushiStructure.entryScene",
    ),
    sceneCount: positiveInteger(
      value.sceneCount,
      "manifest.corpus.fullGame.utsushiStructure.sceneCount",
    ),
    dispatchOrderCount: positiveInteger(
      value.dispatchOrderCount,
      "manifest.corpus.fullGame.utsushiStructure.dispatchOrderCount",
    ),
    messageCount: nonNegativeInteger(
      value.messageCount,
      "manifest.corpus.fullGame.utsushiStructure.messageCount",
    ),
    choiceCount: nonNegativeInteger(
      value.choiceCount,
      "manifest.corpus.fullGame.utsushiStructure.choiceCount",
    ),
    speakerCount: nonNegativeInteger(
      value.speakerCount,
      "manifest.corpus.fullGame.utsushiStructure.speakerCount",
    ),
    scopedScene: {
      sceneId: nonNegativeInteger(
        scopedScene.sceneId,
        "manifest.corpus.fullGame.utsushiStructure.scopedScene.sceneId",
      ),
      messageCount: nonNegativeInteger(
        scopedScene.messageCount,
        "manifest.corpus.fullGame.utsushiStructure.scopedScene.messageCount",
      ),
      choiceCount: nonNegativeInteger(
        scopedScene.choiceCount,
        "manifest.corpus.fullGame.utsushiStructure.scopedScene.choiceCount",
      ),
      nextScene: nullableNonNegativeInteger(
        scopedScene.nextScene,
        "manifest.corpus.fullGame.utsushiStructure.scopedScene.nextScene",
      ),
      selectionControl: metadataString(
        scopedScene.selectionControl,
        "manifest.corpus.fullGame.utsushiStructure.scopedScene.selectionControl",
      ),
      dispatchFanoutScenes: array(
        scopedScene.dispatchFanoutScenes,
        "manifest.corpus.fullGame.utsushiStructure.scopedScene.dispatchFanoutScenes",
      ).map((scene, index) =>
        nonNegativeInteger(
          scene,
          `manifest.corpus.fullGame.utsushiStructure.scopedScene.dispatchFanoutScenes[${index}]`,
        ),
      ),
      dispatchIndex: nonNegativeInteger(
        scopedScene.dispatchIndex,
        "manifest.corpus.fullGame.utsushiStructure.scopedScene.dispatchIndex",
      ),
    },
  };
}

function validateOutputScope(value: JsonRecord, corpus: CorpusEvidence): CorpusOutputScope {
  assertExactKeys(
    value,
    ["scopeId", "sceneId", "ordinalRange", "bridge", "units"],
    "manifest.outputScope",
  );
  const sceneId = nonNegativeInteger(value.sceneId, "manifest.outputScope.sceneId");
  if (sceneId !== corpus.fullGame.utsushiStructure.scopedScene.sceneId) {
    throw new Error("private corpus scope and structure scene identities disagree");
  }
  const ordinalRange = validateOrdinalRange(
    record(value.ordinalRange, "manifest.outputScope.ordinalRange"),
  );
  const bridge = record(value.bridge, "manifest.outputScope.bridge");
  assertExactKeys(
    bridge,
    [
      "schemaVersion",
      "bridgeExport",
      "sourceBundleHash",
      "decompile",
      "unitCount",
      "uniqueBridgeUnitIdCount",
      "uniqueSourceHashCount",
      "unitsProjectionSha256",
    ],
    "manifest.outputScope.bridge",
  );
  const decompile = record(bridge.decompile, "manifest.outputScope.bridge.decompile");
  assertExactKeys(
    decompile,
    [
      "schemaVersion",
      "sceneId",
      "totalOpcodes",
      "recognizedOpcodes",
      "unknownOpcodes",
      "sourceSeenSha256",
    ],
    "manifest.outputScope.bridge.decompile",
  );
  const unitCount = positiveInteger(bridge.unitCount, "manifest.outputScope.bridge.unitCount");
  if (unitCount !== ordinalCount(ordinalRange)) {
    throw new Error("private corpus scoped unit count does not match its ordinal range");
  }
  const decodedBridge = {
    schemaVersion: metadataString(
      bridge.schemaVersion,
      "manifest.outputScope.bridge.schemaVersion",
    ),
    bridgeExport: validateFingerprint(
      record(bridge.bridgeExport, "manifest.outputScope.bridge.bridgeExport"),
      "manifest.outputScope.bridge.bridgeExport",
    ),
    sourceBundleHash: sha256(
      bridge.sourceBundleHash,
      "manifest.outputScope.bridge.sourceBundleHash",
    ),
    decompile: {
      schemaVersion: metadataString(
        decompile.schemaVersion,
        "manifest.outputScope.bridge.decompile.schemaVersion",
      ),
      sceneId: nonNegativeInteger(
        decompile.sceneId,
        "manifest.outputScope.bridge.decompile.sceneId",
      ),
      totalOpcodes: positiveInteger(
        decompile.totalOpcodes,
        "manifest.outputScope.bridge.decompile.totalOpcodes",
      ),
      recognizedOpcodes: positiveInteger(
        decompile.recognizedOpcodes,
        "manifest.outputScope.bridge.decompile.recognizedOpcodes",
      ),
      unknownOpcodes: nonNegativeInteger(
        decompile.unknownOpcodes,
        "manifest.outputScope.bridge.decompile.unknownOpcodes",
      ),
      sourceSeenSha256: sha256(
        decompile.sourceSeenSha256,
        "manifest.outputScope.bridge.decompile.sourceSeenSha256",
      ),
    },
    unitCount,
    uniqueBridgeUnitIdCount: positiveInteger(
      bridge.uniqueBridgeUnitIdCount,
      "manifest.outputScope.bridge.uniqueBridgeUnitIdCount",
    ),
    uniqueSourceHashCount: positiveInteger(
      bridge.uniqueSourceHashCount,
      "manifest.outputScope.bridge.uniqueSourceHashCount",
    ),
    unitsProjectionSha256: sha256(
      bridge.unitsProjectionSha256,
      "manifest.outputScope.bridge.unitsProjectionSha256",
    ),
  };
  if (
    decodedBridge.decompile.sceneId !== sceneId ||
    decodedBridge.decompile.unknownOpcodes !== 0 ||
    decodedBridge.decompile.totalOpcodes !== decodedBridge.decompile.recognizedOpcodes ||
    decodedBridge.decompile.sourceSeenSha256 !== corpus.inputs.seenTxt.sha256
  ) {
    throw new Error("private corpus scoped decoder evidence is inconsistent");
  }

  const units = array(value.units, "manifest.outputScope.units").map((unit, index) =>
    validateUnit(
      record(unit, `manifest.outputScope.units[${index}]`),
      `manifest.outputScope.units[${index}]`,
      sceneId,
      ordinalRange,
      corpus.fullGame.utsushiStructure.scopedScene.dispatchIndex,
    ),
  );
  if (units.length !== unitCount) {
    throw new Error("private corpus scoped unit list has the wrong length");
  }
  const ids = new Set(units.map((unit) => unit.bridgeUnitId));
  const hashes = new Set(units.map((unit) => unit.sourceHash));
  if (
    ids.size !== unitCount ||
    hashes.size !== unitCount ||
    decodedBridge.uniqueBridgeUnitIdCount !== unitCount ||
    decodedBridge.uniqueSourceHashCount !== unitCount
  ) {
    throw new Error("private corpus scoped units have duplicate identities");
  }
  assertExactOrdinals(units, ordinalRange);
  if (units.some((unit) => unit.sourceRevision.value !== decodedBridge.sourceBundleHash)) {
    throw new Error("private corpus unit source revisions are not pinned to the scoped bridge");
  }
  if (sha256Bytes(stableJson(units)) !== decodedBridge.unitsProjectionSha256) {
    throw new Error("private corpus scoped unit projection hash drifted");
  }
  return {
    scopeId: metadataString(value.scopeId, "manifest.outputScope.scopeId"),
    sceneId,
    ordinalRange,
    bridge: decodedBridge,
    units,
  };
}

function validateOrdinalRange(value: JsonRecord): OrdinalRange {
  assertExactKeys(value, ["start", "end", "width"], "manifest.outputScope.ordinalRange");
  const range = {
    start: nonNegativeInteger(value.start, "manifest.outputScope.ordinalRange.start"),
    end: nonNegativeInteger(value.end, "manifest.outputScope.ordinalRange.end"),
    width: positiveInteger(value.width, "manifest.outputScope.ordinalRange.width"),
  };
  if (range.end < range.start || range.width > 12) {
    throw new Error("private corpus source ordinal range is invalid");
  }
  return range;
}

function validateUnit(
  value: JsonRecord,
  label: string,
  sceneId: number,
  ordinalRange: OrdinalRange,
  dispatchIndex: number,
): CorpusUnit {
  assertExactKeys(
    value,
    [
      "bridgeUnitId",
      "sourceUnitKey",
      "occurrenceId",
      "surfaceKind",
      "sourceHash",
      "sourceRevision",
      "byteLocation",
      "protectedSkeleton",
      "route",
      "sceneMembership",
      "replayTarget",
    ],
    label,
  );
  const bridgeUnitId = metadataString(value.bridgeUnitId, `${label}.bridgeUnitId`);
  if (!UUID7_PATTERN.test(bridgeUnitId)) {
    throw new Error("private corpus unit id is not UUIDv7 metadata");
  }
  const ordinal = ordinalFromUnitKey(
    metadataString(value.sourceUnitKey, `${label}.sourceUnitKey`),
    sceneId,
    ordinalRange,
  );
  const occurrenceId = metadataString(value.occurrenceId, `${label}.occurrenceId`);
  if (occurrenceId !== `scene-${sceneId}-occ-${ordinal}`) {
    throw new Error("private corpus unit occurrence does not match its source ordinal");
  }
  if (metadataString(value.surfaceKind, `${label}.surfaceKind`) !== "dialogue") {
    throw new Error("private corpus scope contains a non-dialogue unit");
  }
  const sourceRevision = record(value.sourceRevision, `${label}.sourceRevision`);
  assertExactKeys(
    sourceRevision,
    ["revisionId", "revisionKind", "value"],
    `${label}.sourceRevision`,
  );
  const revisionId = metadataString(
    sourceRevision.revisionId,
    `${label}.sourceRevision.revisionId`,
  );
  if (
    !UUID7_PATTERN.test(revisionId) ||
    metadataString(sourceRevision.revisionKind, `${label}.sourceRevision.revisionKind`) !==
      "content_hash"
  ) {
    throw new Error("private corpus source revision metadata is invalid");
  }
  const byteLocation = validateByteLocation(
    record(value.byteLocation, `${label}.byteLocation`),
    label,
    sceneId,
    ordinal,
  );
  const protectedSkeleton = validateProtectedSkeleton(
    record(value.protectedSkeleton, `${label}.protectedSkeleton`),
    `${label}.protectedSkeleton`,
    byteLocation.range.endByte - byteLocation.range.startByte,
  );
  const route = record(value.route, `${label}.route`);
  assertExactKeys(route, ["sceneKey", "position"], `${label}.route`);
  if (
    metadataString(route.sceneKey, `${label}.route.sceneKey`) !== `scene-${sceneId}` ||
    metadataString(route.position, `${label}.route.position`) !== `line-${ordinal}`
  ) {
    throw new Error("private corpus unit route does not match its source ordinal");
  }
  const membership = record(value.sceneMembership, `${label}.sceneMembership`);
  assertExactKeys(membership, ["sceneId", "structureDispatchIndex"], `${label}.sceneMembership`);
  if (
    nonNegativeInteger(membership.sceneId, `${label}.sceneMembership.sceneId`) !== sceneId ||
    nonNegativeInteger(
      membership.structureDispatchIndex,
      `${label}.sceneMembership.structureDispatchIndex`,
    ) !== dispatchIndex
  ) {
    throw new Error("private corpus unit scene membership drifted");
  }
  const replayTarget = record(value.replayTarget, `${label}.replayTarget`);
  assertExactKeys(replayTarget, ["expectationKind", "traceKey"], `${label}.replayTarget`);
  const traceKey = metadataString(replayTarget.traceKey, `${label}.replayTarget.traceKey`);
  if (
    metadataString(replayTarget.expectationKind, `${label}.replayTarget.expectationKind`) !==
      "trace_text" ||
    (traceKey !== occurrenceId && !traceKey.startsWith(`${occurrenceId}#voice=`))
  ) {
    throw new Error("private corpus unit replay target drifted");
  }
  return {
    bridgeUnitId,
    sourceUnitKey: `reallive:scene-${sceneId}#${ordinal}`,
    occurrenceId,
    surfaceKind: "dialogue",
    sourceHash: sha256(value.sourceHash, `${label}.sourceHash`),
    sourceRevision: {
      revisionId,
      revisionKind: "content_hash",
      value: sha256(sourceRevision.value, `${label}.sourceRevision.value`),
    },
    byteLocation,
    protectedSkeleton,
    route: { sceneKey: `scene-${sceneId}`, position: `line-${ordinal}` },
    sceneMembership: { sceneId, structureDispatchIndex: dispatchIndex },
    replayTarget: { expectationKind: "trace_text", traceKey },
  };
}

function validateByteLocation(
  value: JsonRecord,
  label: string,
  sceneId: number,
  ordinal: string,
): CorpusUnit["byteLocation"] {
  assertExactKeys(value, ["containerKey", "entryPath", "range"], `${label}.byteLocation`);
  const entryPath = array(value.entryPath, `${label}.byteLocation.entryPath`).map((entry, index) =>
    metadataString(entry, `${label}.byteLocation.entryPath[${index}]`),
  );
  if (
    metadataString(value.containerKey, `${label}.byteLocation.containerKey`) !==
      `reallive:scene-${sceneId}` ||
    stableJson(entryPath) !== stableJson(["scene", String(sceneId), "units", ordinal])
  ) {
    throw new Error("private corpus unit byte location does not match its source ordinal");
  }
  const range = record(value.range, `${label}.byteLocation.range`);
  assertExactKeys(range, ["startByte", "endByte"], `${label}.byteLocation.range`);
  const startByte = nonNegativeInteger(range.startByte, `${label}.byteLocation.range.startByte`);
  const endByte = nonNegativeInteger(range.endByte, `${label}.byteLocation.range.endByte`);
  if (endByte <= startByte) throw new Error("private corpus unit byte range is invalid");
  return { containerKey: `reallive:scene-${sceneId}`, entryPath, range: { startByte, endByte } };
}

function validateProtectedSkeleton(
  value: JsonRecord,
  label: string,
  decompressedLength: number,
): ProtectedSkeleton {
  assertExactKeys(
    value,
    [
      "format",
      "sourceEncoding",
      "sourceTextUtf8ByteLength",
      "decompressedSourceByteLength",
      "shell",
      "parts",
    ],
    label,
  );
  if (
    metadataString(value.format, `${label}.format`) !==
      "itotori.redacted-sjis-protected-shell.v1" ||
    metadataString(value.sourceEncoding, `${label}.sourceEncoding`) !==
      "shift-jis-with-reallive-control-spans"
  ) {
    throw new Error("private corpus protected skeleton format is unsupported");
  }
  const sourceTextUtf8ByteLength = positiveInteger(
    value.sourceTextUtf8ByteLength,
    `${label}.sourceTextUtf8ByteLength`,
  );
  const decompressedSourceByteLength = positiveInteger(
    value.decompressedSourceByteLength,
    `${label}.decompressedSourceByteLength`,
  );
  if (decompressedSourceByteLength !== decompressedLength) {
    throw new Error("private corpus protected skeleton source length drifted");
  }
  const rawParts = array(value.parts, `${label}.parts`).map((part, index) =>
    record(part, `${label}.parts[${index}]`),
  );
  const parts: Array<RedactedTextPart | ProtectedSpanPart> = [];
  let cursor = 0;
  let expectedSpanIndex = 0;
  let protectedCount = 0;
  for (const [index, part] of rawParts.entries()) {
    const kind = metadataString(part.kind, `${label}.parts[${index}].kind`);
    const startByte = nonNegativeInteger(part.startByte, `${label}.parts[${index}].startByte`);
    const endByte = nonNegativeInteger(part.endByte, `${label}.parts[${index}].endByte`);
    const utf8ByteLength = nonNegativeInteger(
      part.utf8ByteLength,
      `${label}.parts[${index}].utf8ByteLength`,
    );
    if (startByte !== cursor || endByte < startByte || utf8ByteLength !== endByte - startByte) {
      throw new Error("private corpus protected skeleton parts are not contiguous");
    }
    cursor = endByte;
    if (kind === "redacted_text") {
      assertExactKeys(
        part,
        ["kind", "startByte", "endByte", "utf8ByteLength"],
        `${label}.parts[${index}]`,
      );
      parts.push({ kind: "redacted_text", startByte, endByte, utf8ByteLength });
      continue;
    }
    if (kind !== "protected_span") {
      throw new Error("private corpus protected skeleton has an unsupported part");
    }
    assertExactKeys(
      part,
      [
        "kind",
        "spanIndex",
        "spanKind",
        "parsedName",
        "startByte",
        "endByte",
        "utf8ByteLength",
        "rawSha256",
        "preserveMode",
        "outOfBand",
      ],
      `${label}.parts[${index}]`,
    );
    if (
      nonNegativeInteger(part.spanIndex, `${label}.parts[${index}].spanIndex`) !== expectedSpanIndex
    ) {
      throw new Error("private corpus protected skeleton span indexes are not consecutive");
    }
    expectedSpanIndex += 1;
    const parsedName = metadataString(part.parsedName, `${label}.parts[${index}].parsedName`);
    if (
      metadataString(part.spanKind, `${label}.parts[${index}].spanKind`) !== "control_markup" ||
      !PROTECTED_NAMES.has(parsedName) ||
      metadataString(part.preserveMode, `${label}.parts[${index}].preserveMode`) !== "exact" ||
      part.outOfBand !== (parsedName === "reallive.kidoku")
    ) {
      throw new Error("private corpus protected skeleton span metadata is invalid");
    }
    protectedCount += 1;
    parts.push({
      kind: "protected_span",
      spanIndex: expectedSpanIndex - 1,
      spanKind: "control_markup",
      parsedName,
      startByte,
      endByte,
      utf8ByteLength,
      rawSha256: sha256(part.rawSha256, `${label}.parts[${index}].rawSha256`),
      preserveMode: "exact",
      outOfBand: parsedName === "reallive.kidoku",
    });
  }
  if (cursor !== sourceTextUtf8ByteLength || protectedCount === 0) {
    throw new Error("private corpus protected skeleton does not cover its source");
  }
  const shell = parts
    .map((part) =>
      part.kind === "redacted_text"
        ? `<REDACTED_TEXT:utf8=${part.utf8ByteLength}>`
        : `<PROTECTED:${part.parsedName ?? part.spanKind}:utf8=${part.utf8ByteLength}>`,
    )
    .join("");
  if (metadataString(value.shell, `${label}.shell`) !== shell) {
    throw new Error("private corpus protected skeleton shell drifted");
  }
  return {
    format: "itotori.redacted-sjis-protected-shell.v1",
    sourceEncoding: "shift-jis-with-reallive-control-spans",
    sourceTextUtf8ByteLength,
    decompressedSourceByteLength,
    shell,
    parts,
  };
}

function assertExactOrdinals(units: CorpusUnit[], range: OrdinalRange): void {
  const actual = new Set(
    units.map((unit) =>
      ordinalFromUnitKey(unit.sourceUnitKey, unit.sceneMembership.sceneId, range),
    ),
  );
  // Each source key has already passed ordinalFromUnitKey, so it belongs to
  // this range. With the unit-count check above, a smaller set can only mean
  // a duplicate and a corresponding gap.
  if (actual.size !== ordinalCount(range)) {
    throw new Error("private corpus source ordinals must be the exact complete manifest range");
  }
}

function ordinalFromUnitKey(key: string, sceneId: number, range: OrdinalRange): string {
  const prefix = `reallive:scene-${sceneId}#`;
  const ordinal = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  if (!new RegExp(`^\\d{${range.width}}$`, "u").test(ordinal)) {
    throw new Error("private corpus source unit key does not carry a canonical ordinal");
  }
  const numeric = Number(ordinal);
  if (numeric < range.start || numeric > range.end || formatOrdinal(numeric, range) !== ordinal) {
    throw new Error("private corpus source unit ordinal is outside its manifest range");
  }
  return ordinal;
}

function formatOrdinal(ordinal: number, range: OrdinalRange): string {
  return String(ordinal).padStart(range.width, "0");
}

function ordinalCount(range: OrdinalRange): number {
  return range.end - range.start + 1;
}

function validateBaseline(value: JsonRecord, outputScope: CorpusOutputScope): void {
  assertExactKeys(
    value,
    [
      "source",
      "reportSha256",
      "runId",
      "sceneId",
      "scopedUnitCount",
      "physicalAttempts",
      "unitsWritten",
      "finalizedPatchCount",
      "acceptedOutputsDiscarded",
      "retranslatedUnitCount",
      "failureMode",
    ],
    "manifest.failedRunBaseline",
  );
  metadataString(value.source, "manifest.failedRunBaseline.source");
  sha256(value.reportSha256, "manifest.failedRunBaseline.reportSha256");
  metadataString(value.runId, "manifest.failedRunBaseline.runId");
  metadataString(value.failureMode, "manifest.failedRunBaseline.failureMode");
  if (
    nonNegativeInteger(value.sceneId, "manifest.failedRunBaseline.sceneId") !==
      outputScope.sceneId ||
    positiveInteger(value.scopedUnitCount, "manifest.failedRunBaseline.scopedUnitCount") !==
      outputScope.bridge.unitCount
  ) {
    throw new Error("private corpus failed-run baseline scope drifted");
  }
  const attempts = positiveInteger(
    value.physicalAttempts,
    "manifest.failedRunBaseline.physicalAttempts",
  );
  const written = nonNegativeInteger(value.unitsWritten, "manifest.failedRunBaseline.unitsWritten");
  const finalized = nonNegativeInteger(
    value.finalizedPatchCount,
    "manifest.failedRunBaseline.finalizedPatchCount",
  );
  const discarded = nonNegativeInteger(
    value.acceptedOutputsDiscarded,
    "manifest.failedRunBaseline.acceptedOutputsDiscarded",
  );
  nonNegativeInteger(
    value.retranslatedUnitCount,
    "manifest.failedRunBaseline.retranslatedUnitCount",
  );
  if (written > attempts || finalized > written || discarded > attempts) {
    throw new Error("private corpus failed-run baseline counts are inconsistent");
  }
}

function validateFingerprint(value: JsonRecord, label: string): FileFingerprint {
  assertExactKeys(value, ["sha256", "byteLength"], label);
  const byteLength = positiveInteger(value.byteLength, `${label}.byteLength`);
  return { sha256: sha256(value.sha256, `${label}.sha256`), byteLength };
}

function assertSameFingerprint(
  actual: FileFingerprint,
  expected: FileFingerprint,
  label: string,
): void {
  if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) {
    throw new Error(`private corpus input ${label} does not match the manifest content address`);
  }
}

function candidateGameRoots(root: string, maxDepth: number): string[] {
  const candidates: string[] = [];
  let frontier = [root];
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const next: string[] = [];
    for (const candidate of frontier) {
      if (hasRealLiveDataDirectory(candidate)) {
        candidates.push(candidate);
      } else if (depth < maxDepth) {
        next.push(
          ...readdirSync(candidate, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(candidate, entry.name)),
        );
      }
    }
    frontier = next;
  }
  return candidates;
}

function hasRealLiveDataDirectory(root: string): boolean {
  const dataRoot = join(root, "REALLIVEDATA");
  return (
    existsSync(dataRoot) &&
    statSync(dataRoot).isDirectory() &&
    isRegularFile(join(dataRoot, "Gameexe.ini")) &&
    isRegularFile(join(dataRoot, "Seen.txt"))
  );
}

function isRegularFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`private corpus ${label} output is not readable JSON`);
  }
}

function assertExactKeys(value: JsonRecord, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`private corpus manifest shape drift at ${label}`);
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`private corpus expected an object at ${label}`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`private corpus expected an array at ${label}`);
  return value;
}

/** Metadata strings are printable ASCII only; source text cannot enter a manifest field. */
function metadataString(value: unknown, label: string): string {
  const result = nativeString(value, label);
  if (/[^\x20-\x7e]/u.test(result)) {
    throw new Error(`private corpus manifest privacy violation at ${label}`);
  }
  return result;
}

/** Native decode values may be non-ASCII but are never inserted into errors. */
function nativeString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`private corpus expected a non-empty string at ${label}`);
  }
  return value;
}

function nullableNativeString(value: unknown, label: string): string | null {
  return value === null ? null : nativeString(value, label);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`private corpus expected a finite number at ${label}`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isInteger(result)) throw new Error(`private corpus expected an integer at ${label}`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 0) throw new Error(`private corpus expected a non-negative integer at ${label}`);
  return result;
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) throw new Error(`private corpus expected a positive integer at ${label}`);
  return result;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function sha256(value: unknown, label: string): Sha256 {
  const result = metadataString(value, label);
  if (!SHA256_PATTERN.test(result))
    throw new Error(`private corpus expected sha256 metadata at ${label}`);
  return result as Sha256;
}
