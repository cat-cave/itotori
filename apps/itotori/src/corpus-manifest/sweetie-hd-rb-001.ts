// RB-001 — private, content-addressed Sweetie HD corpus manifest helpers.
//
// This module intentionally projects real decoder output into metadata only.
// It must never serialize sourceText, speaker text, a protected span's raw
// payload, or a full bridge/structure export. The real outputs exist only in
// a temporary directory while the opt-in test is running.

import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runKaifuuRealliveExtract } from "../extract/kaifuu-extract-seam.js";
import { defaultRepoRoot, spawnNativeCliProcess } from "../native-bin/cli-bin-resolver.js";
import { runUtsushiStructureExport } from "../structure-export/utsushi-structure-seam.js";

export const SWEETIE_RB001_MANIFEST_SCHEMA_VERSION = "itotori.private-corpus-manifest.rb-001.v1";
export const SWEETIE_RB001_SCENE_ID = 1017;
export const SWEETIE_RB001_CORPUS_ENV = "ITOTORI_RB001_REAL_SWEETIE_ROOT";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const UUID7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SCENE1017_UNIT_KEY_PATTERN = /^reallive:scene-1017#(\d{4})$/u;
const SCENE1017_OCCURRENCE_PATTERN = /^scene-1017-occ-(\d{4})$/u;
const SCENE1017_ROUTE_POSITION_PATTERN = /^line-(\d{4})$/u;
const SCENE1017_VOICE_TRACE_PATTERN = /^scene-1017-occ-\d{4}#voice=z\d{4}:\d{5}$/u;
const PROTECTED_SPAN_NAMES = new Set(["reallive.kidoku", "reallive.name_token"]);
const KAIFUU_BRIDGE_SCHEMA_VERSION = "0.2.0";
const KAIFUU_DECOMPILE_SCHEMA_VERSION = "itotori.kaifuu.decompile-report.v0";
const UTSUSHI_STRUCTURE_SCHEMA_VERSION = "utsushi.narrative-structure.v1";
const RB001_DISPATCH_INDEX = 38;
const PRIVATE_FORBIDDEN_PAYLOADS = [
  "sourceText",
  "speaker text",
  "protected-span raw payload",
  "full bridge export",
  "full structure export",
] as const;
const PRIVATE_PAYLOAD_KEYS = new Set([
  "sourceText",
  "raw",
  "speaker",
  "rawSpeakerText",
  "displayName",
  "text",
  "messages",
  "branchMessages",
  "label",
]);

type JsonRecord = Record<string, unknown>;

export type Sha256 = `sha256:${string}`;

export type FileFingerprint = {
  sha256: Sha256;
  byteLength: number;
};

export type RedactedTextPart = {
  kind: "redacted_text";
  startByte: number;
  endByte: number;
  utf8ByteLength: number;
};

export type ProtectedSpanPart = {
  kind: "protected_span";
  spanIndex: number;
  spanKind: string;
  parsedName: string | null;
  startByte: number;
  endByte: number;
  utf8ByteLength: number;
  rawSha256: Sha256;
  preserveMode: string;
  outOfBand: boolean;
};

export type ProtectedSkeleton = {
  format: "rb001.redacted-sjis-protected-shell.v1";
  sourceEncoding: "shift-jis-with-reallive-control-spans";
  sourceTextUtf8ByteLength: number;
  /** Length of the source unit's range in the decompressed RealLive stream. */
  decompressedSourceByteLength: number;
  shell: string;
  parts: Array<RedactedTextPart | ProtectedSpanPart>;
};

export type SweetieRb001Unit = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  occurrenceId: string;
  surfaceKind: string;
  sourceHash: Sha256;
  sourceRevision: {
    revisionId: string;
    revisionKind: string;
    value: Sha256;
  };
  byteLocation: {
    containerKey: string;
    entryPath: string[];
    range: {
      startByte: number;
      endByte: number;
    };
  };
  protectedSkeleton: ProtectedSkeleton;
  route: {
    sceneKey: string;
    position: string;
  };
  sceneMembership: {
    sceneId: number;
    structureDispatchIndex: number;
  };
  replayTarget: {
    expectationKind: string;
    traceKey: string;
  };
};

export type SweetieRb001CorpusEvidence = {
  corpusId: "sweetie-hd-reallive";
  engine: "reallive";
  sourceLocale: "ja-JP";
  inputs: {
    seenTxt: FileFingerprint;
    gameexeIni: FileFingerprint;
  };
  fullGame: {
    kaifuuDecode: {
      schemaVersion: string;
      bridgeExport: FileFingerprint;
      sourceBundleHash: Sha256;
      assetCount: number;
      unitCount: number;
      routeSceneCount: number;
      decompile: {
        schemaVersion: string;
        scope: "whole-seen";
        sceneCount: number;
        totalOpcodes: number;
        recognizedOpcodes: number;
        unknownOpcodes: number;
        sourceSeenSha256: Sha256;
      };
    };
    utsushiStructure: {
      schemaVersion: "utsushi.narrative-structure.v1";
      structureExport: FileFingerprint;
      entryScene: number;
      sceneCount: number;
      dispatchOrderCount: number;
      messageCount: number;
      choiceCount: number;
      speakerCount: number;
      scene1017: {
        sceneId: number;
        messageCount: number;
        choiceCount: number;
        nextScene: number | null;
        selectionControl: string;
        dispatchFanoutScenes: number[];
      };
    };
  };
};

export type SweetieRb001OutputScope = {
  scopeId: "sweetie-hd-reallive:scene-1017";
  sceneId: 1017;
  bridge: {
    schemaVersion: string;
    bridgeExport: FileFingerprint;
    sourceBundleHash: Sha256;
    decompile: {
      schemaVersion: string;
      sceneId: 1017;
      totalOpcodes: number;
      recognizedOpcodes: number;
      unknownOpcodes: number;
      sourceSeenSha256: Sha256;
    };
    unitCount: number;
    uniqueBridgeUnitIdCount: number;
    uniqueSourceHashCount: number;
    unitsProjectionSha256: Sha256;
  };
  units: SweetieRb001Unit[];
};

export type SweetieRb001Manifest = {
  schemaVersion: typeof SWEETIE_RB001_MANIFEST_SCHEMA_VERSION;
  manifestId: "sweetie-hd-rb-001";
  contentAddress: {
    algorithm: "sha256";
    canonicalization: "json-key-sort-v1";
    manifestSha256: Sha256;
  };
  privacy: {
    classification: "private-corpus-metadata-only";
    containsCopyrightedBytes: false;
    forbiddenPayloads: string[];
  };
  corpus: SweetieRb001CorpusEvidence;
  outputScope: SweetieRb001OutputScope;
  failedRunBaseline: {
    source: "bridge-rerun-completion-report-2026-07-14";
    reportSha256: Sha256;
    runId: string;
    sceneId: 1017;
    scopedUnitCount: 129;
    physicalAttempts: 762;
    unitsWritten: 57;
    finalizedPatchCount: 0;
    acceptedOutputsDiscarded: 51;
    retranslatedUnitCount: 27;
    failureMode: "sys-1-unit-pipeline-restarts-discard-accepted-work";
  };
};

export type ResolvedSweetieRb001Corpus = {
  gameRoot: string;
  gameexePath: string;
  seenPath: string;
};

export type SweetieRb001CorpusResolution =
  | { kind: "ready"; corpus: ResolvedSweetieRb001Corpus }
  | { kind: "skip"; reason: string };

export type DerivedSweetieRb001Evidence = {
  corpus: SweetieRb001CorpusEvidence;
  outputScope: SweetieRb001OutputScope;
};

/**
 * Resolve the explicitly opt-in private corpus root. The normal source/test
 * lane does not inspect the default research directory: no environment value
 * means a loud clean skip, even on a developer workstation that happens to
 * hold a corpus elsewhere.
 */
export function resolveSweetieRb001Corpus(
  env: NodeJS.ProcessEnv = process.env,
): SweetieRb001CorpusResolution {
  const configuredRoot = env[SWEETIE_RB001_CORPUS_ENV];
  if (configuredRoot === undefined || configuredRoot.length === 0) {
    return {
      kind: "skip",
      reason:
        `${SWEETIE_RB001_CORPUS_ENV} is unset; no private Sweetie HD bytes were read. ` +
        `Set it to the owned title root (or its single-game parent) to run the RB-001 oracle.`,
    };
  }

  const root = resolve(configuredRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(
      `RB-001 corpus gate refused configured root: ${SWEETIE_RB001_CORPUS_ENV} is not a directory`,
    );
  }

  const candidates = candidateGameRoots(root, 4);
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length !== 1) {
    throw new Error(
      "RB-001 corpus gate refused configured root: expected exactly one owned game with " +
        "REALLIVEDATA/Gameexe.ini and REALLIVEDATA/Seen.txt",
    );
  }

  const gameRoot = uniqueCandidates[0]!;
  const dataRoot = join(gameRoot, "REALLIVEDATA");
  const gameexePath = join(dataRoot, "Gameexe.ini");
  const seenPath = join(dataRoot, "Seen.txt");
  if (!statSync(gameexePath).isFile() || !statSync(seenPath).isFile()) {
    throw new Error(
      "RB-001 corpus gate refused configured root: expected regular Gameexe.ini and Seen.txt files",
    );
  }
  return { kind: "ready", corpus: { gameRoot, gameexePath, seenPath } };
}

/** Build a SHA-256 fingerprint without retaining a content-bearing value. */
export function fingerprintFile(path: string): FileFingerprint {
  const bytes = readFileSync(path);
  return { sha256: sha256Bytes(bytes), byteLength: bytes.byteLength };
}

/**
 * Regenerate both authoritative full-game artifacts and the scene-1017 bridge.
 * Every output lands under a newly-created OS temporary directory and is
 * deleted before this function returns, including on a failed assertion.
 */
export function deriveSweetieRb001Evidence(
  corpus: ResolvedSweetieRb001Corpus,
  env: NodeJS.ProcessEnv = process.env,
): DerivedSweetieRb001Evidence {
  const tempRoot = mkdtempSync(join(tmpdir(), "itotori-rb001-sweetie-"));
  const fullBridgePath = join(tempRoot, "full.bridge.json");
  const fullReportPath = join(tempRoot, "full.decompile-report.json");
  const sceneBridgePath = join(tempRoot, "scene-1017.bridge.json");
  const sceneReportPath = join(tempRoot, "scene-1017.decompile-report.json");
  const structurePath = join(tempRoot, "full.structure.json");
  // Do not inherit an operator-supplied binary override or libexec bundle: the
  // proof pins the worktree's freshly source-built kaifuu/utsushi CLIs, never
  // an arbitrary fixture emitter selected by the normal binary resolver.
  const {
    ITOTORI_KAIFUU_BIN: _ignoredKaifuuOverride,
    ITOTORI_UTSUSHI_BIN: _ignoredUtsushiOverride,
    ITOTORI_LIBEXEC_DIR: _ignoredLibexecOverride,
    ...nativeEnvBase
  } = env;
  const nativeEnv = buildTrustedNativeCliEnv(nativeEnvBase, corpus.gameRoot);

  try {
    runKaifuuRealliveExtract({
      gameRoot: corpus.gameRoot,
      gameId: "sweetie-hd",
      gameVersion: "1.0.0",
      sourceProfileId: "kaifuu-reallive-sweetie-hd",
      sourceLocale: "ja-JP",
      wholeSeen: true,
      bundleOutputPath: fullBridgePath,
      decompileReportOutputPath: fullReportPath,
      env: nativeEnv,
    });
    runKaifuuRealliveExtract({
      gameRoot: corpus.gameRoot,
      gameId: "sweetie-hd",
      gameVersion: "1.0.0",
      sourceProfileId: "kaifuu-reallive-sweetie-hd",
      sourceLocale: "ja-JP",
      scene: SWEETIE_RB001_SCENE_ID,
      bundleOutputPath: sceneBridgePath,
      decompileReportOutputPath: sceneReportPath,
      env: nativeEnv,
    });
    runUtsushiStructureExport({
      gameexePath: corpus.gameexePath,
      seenPath: corpus.seenPath,
      outputPath: structurePath,
      // The Utsushi default is 256; pin an explicit ceiling above every
      // RealLive directory slot so a future archive cannot silently truncate.
      maxScenes: 10_000,
      env: nativeEnv,
    });

    return deriveEvidenceFromOutputs({
      seenFingerprint: fingerprintFile(corpus.seenPath),
      gameexeFingerprint: fingerprintFile(corpus.gameexePath),
      fullBridgeFingerprint: fingerprintFile(fullBridgePath),
      sceneBridgeFingerprint: fingerprintFile(sceneBridgePath),
      structureFingerprint: fingerprintFile(structurePath),
      fullBridge: readJson(fullBridgePath, "full bridge"),
      fullReport: readJson(fullReportPath, "full decompile report"),
      sceneBridge: readJson(sceneBridgePath, "scene-1017 bridge"),
      sceneReport: readJson(sceneReportPath, "scene-1017 decompile report"),
      structure: readJson(structurePath, "full structure"),
    });
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

/**
 * Build the two decoder CLIs from this worktree's locked Rust workspace, then
 * pin the seams to those exact executables. This intentionally bypasses every
 * operator-controlled resolver route (PATH, libexec, and binary overrides):
 * a private-byte proof must not be satisfied by a fixture-emitting lookalike.
 */
function buildTrustedNativeCliEnv(
  nativeEnvBase: NodeJS.ProcessEnv,
  gameRoot: string,
): NodeJS.ProcessEnv {
  const repoRoot = defaultRepoRoot();
  if (repoRoot === undefined) {
    throw new Error("RB-001 corpus gate requires a source checkout with Cargo.toml and flake.nix");
  }
  const build = spawnNativeCliProcess(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      join(repoRoot, "Cargo.toml"),
      "--package",
      "kaifuu-cli",
      "--package",
      "utsushi-cli",
    ],
    nativeEnvBase,
  );
  if (build.error !== undefined || build.status !== 0) {
    throw new Error("RB-001 corpus gate could not build the trusted kaifuu-cli and utsushi-cli");
  }

  const targetRoot =
    nativeEnvBase.CARGO_TARGET_DIR !== undefined && nativeEnvBase.CARGO_TARGET_DIR.length > 0
      ? nativeEnvBase.CARGO_TARGET_DIR
      : join(repoRoot, "target");
  const kaifuuBin = join(targetRoot, "debug", "kaifuu-cli");
  const utsushiBin = join(targetRoot, "debug", "utsushi-cli");
  assertExecutableFile(kaifuuBin, "kaifuu-cli");
  assertExecutableFile(utsushiBin, "utsushi-cli");

  return {
    ...nativeEnvBase,
    ITOTORI_KAIFUU_BIN: kaifuuBin,
    ITOTORI_UTSUSHI_BIN: utsushiBin,
    ITOTORI_REAL_GAME_ROOT: gameRoot,
  };
}

function assertExecutableFile(path: string, label: string): void {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`RB-001 corpus gate could not locate trusted built ${label}`);
  }
  if (!statSync(path).isFile()) {
    throw new Error(`RB-001 corpus gate trusted ${label} path is not a regular executable`);
  }
}

/**
 * Make the committed manifest body. Its content address is calculated over the
 * complete metadata projection with only the self-referential hash omitted.
 */
export function createSweetieRb001Manifest(
  evidence: DerivedSweetieRb001Evidence,
  baseline: SweetieRb001Manifest["failedRunBaseline"],
): SweetieRb001Manifest {
  const manifest: SweetieRb001Manifest = {
    schemaVersion: SWEETIE_RB001_MANIFEST_SCHEMA_VERSION,
    manifestId: "sweetie-hd-rb-001",
    contentAddress: {
      algorithm: "sha256",
      canonicalization: "json-key-sort-v1",
      // Filled from a canonical projection below; the empty value never
      // participates in the content hash.
      manifestSha256: "sha256:" as Sha256,
    },
    privacy: {
      classification: "private-corpus-metadata-only",
      containsCopyrightedBytes: false,
      forbiddenPayloads: [...PRIVATE_FORBIDDEN_PAYLOADS],
    },
    corpus: evidence.corpus,
    outputScope: evidence.outputScope,
    failedRunBaseline: baseline,
  };
  manifest.contentAddress.manifestSha256 = manifestContentHash(manifest);
  return manifest;
}

/**
 * Validate the static metadata manifest before comparing it to live output.
 * This is deliberately fail-closed: malformed content addressing, duplicate
 * identifiers, missing scene units, private payload keys, and a synthetic-size
 * stand-in are all rejected before any result can be called a corpus match.
 */
export function assertSweetieRb001Manifest(value: unknown): asserts value is SweetieRb001Manifest {
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
    string(manifest.schemaVersion, "manifest.schemaVersion") !==
    SWEETIE_RB001_MANIFEST_SCHEMA_VERSION
  ) {
    throw new Error("RB-001 manifest schemaVersion is not supported");
  }
  if (string(manifest.manifestId, "manifest.manifestId") !== "sweetie-hd-rb-001") {
    throw new Error("RB-001 manifestId must be sweetie-hd-rb-001");
  }

  const contentAddress = record(manifest.contentAddress, "manifest.contentAddress");
  assertExactKeys(
    contentAddress,
    ["algorithm", "canonicalization", "manifestSha256"],
    "manifest.contentAddress",
  );
  if (string(contentAddress.algorithm, "manifest.contentAddress.algorithm") !== "sha256") {
    throw new Error("RB-001 manifest must be content-addressed with sha256");
  }
  if (
    string(contentAddress.canonicalization, "manifest.contentAddress.canonicalization") !==
    "json-key-sort-v1"
  ) {
    throw new Error("RB-001 manifest uses an unsupported canonicalization");
  }
  assertSha256(contentAddress.manifestSha256, "manifest.contentAddress.manifestSha256");

  const privacy = record(manifest.privacy, "manifest.privacy");
  assertExactKeys(
    privacy,
    ["classification", "containsCopyrightedBytes", "forbiddenPayloads"],
    "manifest.privacy",
  );
  if (
    string(privacy.classification, "manifest.privacy.classification") !==
    "private-corpus-metadata-only"
  ) {
    throw new Error("RB-001 manifest privacy classification must be metadata-only");
  }
  if (privacy.containsCopyrightedBytes !== false) {
    throw new Error("RB-001 manifest must declare containsCopyrightedBytes=false");
  }
  const forbiddenPayloads = array(privacy.forbiddenPayloads, "manifest.privacy.forbiddenPayloads");
  if (stableJson(forbiddenPayloads) !== stableJson(PRIVATE_FORBIDDEN_PAYLOADS)) {
    throw new Error(
      "RB-001 manifest must retain the complete fixed private-payload prohibition list",
    );
  }

  validateCorpus(record(manifest.corpus, "manifest.corpus"));
  validateOutputScope(record(manifest.outputScope, "manifest.outputScope"));
  validateFailedRunBaseline(record(manifest.failedRunBaseline, "manifest.failedRunBaseline"));
  assertMetadataOnly(manifest, "manifest");

  const typed = value as SweetieRb001Manifest;
  const expectedHash = manifestContentHash(typed);
  if (typed.contentAddress.manifestSha256 !== expectedHash) {
    throw new Error(
      "RB-001 manifest content address mismatch: metadata changed without a matching canonical hash",
    );
  }
}

/** Reject a corpus replacement before spending time on a full decode. */
export function assertPinnedSweetieRb001Inputs(
  corpus: ResolvedSweetieRb001Corpus,
  manifest: SweetieRb001Manifest,
): void {
  const actualSeen = fingerprintFile(corpus.seenPath);
  const actualGameexe = fingerprintFile(corpus.gameexePath);
  assertSameFingerprint(
    actualSeen,
    manifest.corpus.inputs.seenTxt,
    "Seen.txt (synthetic or other-corpus substitution)",
  );
  assertSameFingerprint(
    actualGameexe,
    manifest.corpus.inputs.gameexeIni,
    "Gameexe.ini (synthetic or other-corpus substitution)",
  );
  if (actualSeen.byteLength < 1_000_000 || actualGameexe.byteLength < 10_000) {
    throw new Error("RB-001 corpus gate rejected synthetic-sized input files");
  }
}

/** Compare all live metadata projections to the committed content address. */
export function assertSweetieRb001EvidenceMatchesManifest(
  evidence: DerivedSweetieRb001Evidence,
  manifest: SweetieRb001Manifest,
): void {
  assertSweetieRb001Manifest(manifest);
  if (stableJson(evidence.corpus) !== stableJson(manifest.corpus)) {
    throw new Error(
      "RB-001 full-game decode/structure drift: regenerated corpus metadata does not match the pinned manifest",
    );
  }
  if (stableJson(evidence.outputScope) !== stableJson(manifest.outputScope)) {
    throw new Error(
      "RB-001 scene-1017 output drift: regenerated 129-unit projection does not exactly match the pinned manifest",
    );
  }
}

/** The stable canonical representation used for all RB-001 metadata hashes. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("RB-001 canonical JSON refuses non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as JsonRecord;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("RB-001 canonical JSON refuses unsupported values");
}

export function sha256Bytes(value: Uint8Array | string): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function manifestContentHash(manifest: SweetieRb001Manifest): Sha256 {
  const { manifestSha256: _ignored, ...hashableAddress } = manifest.contentAddress;
  return sha256Bytes(
    stableJson({
      ...manifest,
      contentAddress: hashableAddress,
    }),
  );
}

function deriveEvidenceFromOutputs(input: {
  seenFingerprint: FileFingerprint;
  gameexeFingerprint: FileFingerprint;
  fullBridgeFingerprint: FileFingerprint;
  sceneBridgeFingerprint: FileFingerprint;
  structureFingerprint: FileFingerprint;
  fullBridge: unknown;
  fullReport: unknown;
  sceneBridge: unknown;
  sceneReport: unknown;
  structure: unknown;
}): DerivedSweetieRb001Evidence {
  const fullBridge = record(input.fullBridge, "full bridge");
  const fullReport = record(input.fullReport, "full decompile report");
  const sceneBridge = record(input.sceneBridge, "scene-1017 bridge");
  const sceneReport = record(input.sceneReport, "scene-1017 decompile report");
  const structure = record(input.structure, "full structure");

  const fullUnits = array(fullBridge.units, "full bridge.units").map((unit, index) =>
    record(unit, `full bridge.units[${index}]`),
  );
  const fullAssets = array(fullBridge.assets, "full bridge.assets");
  const routeSceneKeys = new Set(
    fullUnits.map((unit, index) =>
      string(
        record(record(unit.context, `full bridge.units[${index}].context`).route, "route").sceneKey,
        `full bridge.units[${index}].context.route.sceneKey`,
      ),
    ),
  );

  const structureSummary = summarizeStructure(structure);
  const { dispatchIndex: scene1017DispatchIndex, ...scene1017Structure } =
    structureSummary.scene1017;
  const units = deriveSceneUnits(sceneBridge, scene1017DispatchIndex);
  const unitIds = new Set(units.map((unit) => unit.bridgeUnitId));
  const sourceHashes = new Set(units.map((unit) => unit.sourceHash));
  if (units.length !== 129 || unitIds.size !== 129 || sourceHashes.size !== 129) {
    throw new Error(
      "RB-001 scene-1017 extraction rejected: expected 129 unique bridge IDs and source hashes",
    );
  }

  const corpus: SweetieRb001CorpusEvidence = {
    corpusId: "sweetie-hd-reallive",
    engine: "reallive",
    sourceLocale: "ja-JP",
    inputs: {
      seenTxt: input.seenFingerprint,
      gameexeIni: input.gameexeFingerprint,
    },
    fullGame: {
      kaifuuDecode: {
        schemaVersion: string(fullBridge.schemaVersion, "full bridge.schemaVersion"),
        bridgeExport: input.fullBridgeFingerprint,
        sourceBundleHash: sha256(fullBridge.sourceBundleHash, "full bridge.sourceBundleHash"),
        assetCount: fullAssets.length,
        unitCount: fullUnits.length,
        routeSceneCount: routeSceneKeys.size,
        decompile: {
          schemaVersion: string(fullReport.schemaVersion, "full decompile report.schemaVersion"),
          scope: literal(
            fullReport.scope,
            "whole-seen",
            "full decompile report.scope",
          ) as "whole-seen",
          sceneCount: number(fullReport.sceneCount, "full decompile report.sceneCount"),
          totalOpcodes: number(fullReport.totalOpcodes, "full decompile report.totalOpcodes"),
          recognizedOpcodes: number(
            fullReport.recognizedOpcodes,
            "full decompile report.recognizedOpcodes",
          ),
          unknownOpcodes: number(fullReport.unknownOpcodes, "full decompile report.unknownOpcodes"),
          sourceSeenSha256: sha256(
            fullReport.sourceSeenSha256,
            "full decompile report.sourceSeenSha256",
          ),
        },
      },
      utsushiStructure: {
        schemaVersion: literal(
          structure.schemaVersion,
          "utsushi.narrative-structure.v1",
          "full structure.schemaVersion",
        ) as "utsushi.narrative-structure.v1",
        structureExport: input.structureFingerprint,
        entryScene: structureSummary.entryScene,
        sceneCount: structureSummary.sceneCount,
        dispatchOrderCount: structureSummary.dispatchOrderCount,
        messageCount: structureSummary.messageCount,
        choiceCount: structureSummary.choiceCount,
        speakerCount: structureSummary.speakerCount,
        scene1017: scene1017Structure,
      },
    },
  };

  const outputScope: SweetieRb001OutputScope = {
    scopeId: "sweetie-hd-reallive:scene-1017",
    sceneId: SWEETIE_RB001_SCENE_ID,
    bridge: {
      schemaVersion: string(sceneBridge.schemaVersion, "scene-1017 bridge.schemaVersion"),
      bridgeExport: input.sceneBridgeFingerprint,
      sourceBundleHash: sha256(sceneBridge.sourceBundleHash, "scene-1017 bridge.sourceBundleHash"),
      decompile: {
        schemaVersion: string(
          sceneReport.schemaVersion,
          "scene-1017 decompile report.schemaVersion",
        ),
        sceneId: literal(
          sceneReport.sceneId,
          SWEETIE_RB001_SCENE_ID,
          "scene-1017 decompile report.sceneId",
        ) as 1017,
        totalOpcodes: number(sceneReport.totalOpcodes, "scene-1017 decompile report.totalOpcodes"),
        recognizedOpcodes: number(
          sceneReport.recognizedOpcodes,
          "scene-1017 decompile report.recognizedOpcodes",
        ),
        unknownOpcodes: number(
          sceneReport.unknownOpcodes,
          "scene-1017 decompile report.unknownOpcodes",
        ),
        sourceSeenSha256: sha256(
          sceneReport.sourceSeenSha256,
          "scene-1017 decompile report.sourceSeenSha256",
        ),
      },
      unitCount: units.length,
      uniqueBridgeUnitIdCount: unitIds.size,
      uniqueSourceHashCount: sourceHashes.size,
      unitsProjectionSha256: sha256Bytes(stableJson(units)),
    },
    units,
  };

  if (corpus.fullGame.kaifuuDecode.decompile.unknownOpcodes !== 0) {
    throw new Error("RB-001 full-game decode rejected: unknown opcodes are not allowed");
  }
  if (outputScope.bridge.decompile.unknownOpcodes !== 0) {
    throw new Error("RB-001 scene-1017 decode rejected: unknown opcodes are not allowed");
  }
  if (corpus.inputs.seenTxt.sha256 !== corpus.fullGame.kaifuuDecode.decompile.sourceSeenSha256) {
    throw new Error("RB-001 full-game report does not identify the input Seen.txt");
  }
  if (corpus.inputs.seenTxt.sha256 !== outputScope.bridge.decompile.sourceSeenSha256) {
    throw new Error("RB-001 scene-1017 report does not identify the input Seen.txt");
  }
  return { corpus, outputScope };
}

function summarizeStructure(structure: JsonRecord): {
  entryScene: number;
  sceneCount: number;
  dispatchOrderCount: number;
  messageCount: number;
  choiceCount: number;
  speakerCount: number;
  scene1017: SweetieRb001CorpusEvidence["fullGame"]["utsushiStructure"]["scene1017"] & {
    dispatchIndex: number;
  };
} {
  const scenes = array(structure.scenes, "full structure.scenes").map((scene, index) =>
    record(scene, `full structure.scenes[${index}]`),
  );
  const dispatchOrder = array(
    structure.sceneDispatchOrder,
    "full structure.sceneDispatchOrder",
  ).map((scene, index) => number(scene, `full structure.sceneDispatchOrder[${index}]`));
  const sceneIds = scenes.map((scene, index) =>
    number(scene.sceneId, `full structure.scenes[${index}].sceneId`),
  );
  const uniqueSceneIds = new Set(sceneIds);
  const uniqueDispatch = new Set(dispatchOrder);
  if (uniqueSceneIds.size !== scenes.length || uniqueDispatch.size !== dispatchOrder.length) {
    throw new Error("RB-001 structure rejected: duplicate scene or dispatch IDs");
  }
  if (
    uniqueSceneIds.size !== uniqueDispatch.size ||
    [...uniqueSceneIds].some((sceneId) => !uniqueDispatch.has(sceneId))
  ) {
    throw new Error(
      "RB-001 structure rejected: dispatch order does not cover exactly the structured scenes",
    );
  }
  const scene1017Index = dispatchOrder.indexOf(SWEETIE_RB001_SCENE_ID);
  const scene1017 = scenes.find((scene) => scene.sceneId === SWEETIE_RB001_SCENE_ID);
  if (scene1017 === undefined || scene1017Index < 0) {
    throw new Error(
      "RB-001 structure rejected: scene 1017 is missing from the full-game replay structure",
    );
  }

  let messageCount = 0;
  let choiceCount = 0;
  const speakers = new Set<string>();
  for (const [index, scene] of scenes.entries()) {
    const messages = array(scene.messages, `full structure.scenes[${index}].messages`);
    const choices = array(scene.choices, `full structure.scenes[${index}].choices`);
    messageCount += messages.length;
    choiceCount += choices.length;
    for (const [messageIndex, message] of messages.entries()) {
      const messageRecord = record(
        message,
        `full structure.scenes[${index}].messages[${messageIndex}]`,
      );
      if (messageRecord.speaker !== null) {
        // Read only to count a distinct in-memory value; it is never copied
        // into a projection or error message.
        speakers.add(string(messageRecord.speaker, "full structure message.speaker"));
      }
    }
  }
  const scene1017Messages = array(scene1017.messages, "full structure.scene1017.messages");
  const scene1017Choices = array(scene1017.choices, "full structure.scene1017.choices");
  return {
    entryScene: number(structure.entryScene, "full structure.entryScene"),
    sceneCount: scenes.length,
    dispatchOrderCount: dispatchOrder.length,
    messageCount,
    choiceCount,
    speakerCount: speakers.size,
    scene1017: {
      sceneId: SWEETIE_RB001_SCENE_ID,
      messageCount: scene1017Messages.length,
      choiceCount: scene1017Choices.length,
      nextScene: nullableNumber(scene1017.nextScene, "full structure.scene1017.nextScene"),
      selectionControl: string(
        scene1017.selectionControl,
        "full structure.scene1017.selectionControl",
      ),
      dispatchFanoutScenes: array(
        scene1017.dispatchFanoutScenes,
        "full structure.scene1017.dispatchFanoutScenes",
      ).map((value, index) =>
        number(value, `full structure.scene1017.dispatchFanoutScenes[${index}]`),
      ),
      dispatchIndex: scene1017Index,
    },
  };
}

function deriveSceneUnits(
  sceneBridge: JsonRecord,
  structureDispatchIndex: number,
): SweetieRb001Unit[] {
  const rawUnits = array(sceneBridge.units, "scene-1017 bridge.units").map((unit, index) =>
    record(unit, `scene-1017 bridge.units[${index}]`),
  );
  const units = rawUnits.map((unit, index) => {
    const sourceLocation = record(
      unit.sourceLocation,
      `scene-1017 bridge.units[${index}].sourceLocation`,
    );
    const range = record(
      sourceLocation.range,
      `scene-1017 bridge.units[${index}].sourceLocation.range`,
    );
    const context = record(unit.context, `scene-1017 bridge.units[${index}].context`);
    const route = record(context.route, `scene-1017 bridge.units[${index}].context.route`);
    const expectation = record(
      unit.runtimeExpectation,
      `scene-1017 bridge.units[${index}].runtimeExpectation`,
    );
    const sourceRevision = record(
      unit.sourceRevision,
      `scene-1017 bridge.units[${index}].sourceRevision`,
    );
    const sourceText = string(unit.sourceText, `scene-1017 bridge.units[${index}].sourceText`);
    const byteLocation = {
      containerKey: string(sourceLocation.containerKey, "scene-1017 sourceLocation.containerKey"),
      entryPath: array(sourceLocation.entryPath, "scene-1017 sourceLocation.entryPath").map(
        (entry, entryIndex) => string(entry, `scene-1017 sourceLocation.entryPath[${entryIndex}]`),
      ),
      range: {
        startByte: number(range.startByte, "scene-1017 sourceLocation.range.startByte"),
        endByte: number(range.endByte, "scene-1017 sourceLocation.range.endByte"),
      },
    };
    if (byteLocation.range.endByte <= byteLocation.range.startByte) {
      throw new Error("RB-001 scene-1017 extraction rejected: non-positive source range");
    }
    const result: SweetieRb001Unit = {
      bridgeUnitId: string(unit.bridgeUnitId, "scene-1017 bridgeUnitId"),
      sourceUnitKey: string(unit.sourceUnitKey, "scene-1017 sourceUnitKey"),
      occurrenceId: string(unit.occurrenceId, "scene-1017 occurrenceId"),
      surfaceKind: string(unit.surfaceKind, "scene-1017 surfaceKind"),
      sourceHash: sha256(unit.sourceHash, "scene-1017 sourceHash"),
      sourceRevision: {
        revisionId: string(sourceRevision.revisionId, "scene-1017 sourceRevision.revisionId"),
        revisionKind: string(sourceRevision.revisionKind, "scene-1017 sourceRevision.revisionKind"),
        value: sha256(sourceRevision.value, "scene-1017 sourceRevision.value"),
      },
      byteLocation,
      protectedSkeleton: buildProtectedSkeleton(sourceText, unit.spans, byteLocation.range),
      route: {
        sceneKey: string(route.sceneKey, "scene-1017 route.sceneKey"),
        position: string(route.position, "scene-1017 route.position"),
      },
      sceneMembership: {
        sceneId: SWEETIE_RB001_SCENE_ID,
        structureDispatchIndex,
      },
      replayTarget: {
        expectationKind: string(expectation.expectationKind, "scene-1017 replay expectationKind"),
        traceKey: string(expectation.traceKey, "scene-1017 replay traceKey"),
      },
    };
    if (
      result.route.sceneKey !== "scene-1017" ||
      result.byteLocation.containerKey !== "reallive:scene-1017"
    ) {
      throw new Error("RB-001 scene-1017 extraction rejected: unit is not a scene-1017 member");
    }
    return result;
  });
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  for (const unit of units) {
    if (seenIds.has(unit.bridgeUnitId)) {
      throw new Error("RB-001 scene-1017 extraction rejected: duplicate BridgeUnit ID");
    }
    if (seenHashes.has(unit.sourceHash)) {
      throw new Error("RB-001 scene-1017 extraction rejected: duplicate source hash");
    }
    seenIds.add(unit.bridgeUnitId);
    seenHashes.add(unit.sourceHash);
  }
  return units;
}

function buildProtectedSkeleton(
  sourceText: string,
  spansValue: unknown,
  sourceRange: { startByte: number; endByte: number },
): ProtectedSkeleton {
  const spans = array(spansValue, "scene-1017 unit.spans").map((span, index) => {
    const value = record(span, `scene-1017 unit.spans[${index}]`);
    const startByte = number(value.startByte, `scene-1017 unit.spans[${index}].startByte`);
    const endByte = number(value.endByte, `scene-1017 unit.spans[${index}].endByte`);
    const raw = string(value.raw, `scene-1017 unit.spans[${index}].raw`);
    if (endByte <= startByte || endByte > Buffer.byteLength(sourceText, "utf8")) {
      throw new Error("RB-001 protected-span shell rejected an invalid UTF-8 span range");
    }
    if (Buffer.byteLength(raw, "utf8") !== endByte - startByte) {
      throw new Error(
        "RB-001 protected-span shell rejected a span whose raw length mismatches its range",
      );
    }
    return {
      spanIndex: index,
      spanKind: string(value.spanKind, `scene-1017 unit.spans[${index}].spanKind`),
      parsedName: nullableString(value.parsedName, `scene-1017 unit.spans[${index}].parsedName`),
      startByte,
      endByte,
      raw,
      rawSha256: sha256Bytes(raw),
      preserveMode: string(value.preserveMode, `scene-1017 unit.spans[${index}].preserveMode`),
      outOfBand: value.outOfBand === true,
    };
  });
  const sortedSpans = [...spans].sort((left, right) => left.startByte - right.startByte);
  if (
    stableJson(spans.map(({ raw: _raw, ...span }) => span)) !==
    stableJson(sortedSpans.map(({ raw: _raw, ...span }) => span))
  ) {
    throw new Error("RB-001 protected-span shell rejected non-monotonic span ordering");
  }

  const sourceTextUtf8ByteLength = Buffer.byteLength(sourceText, "utf8");
  const parts: Array<RedactedTextPart | ProtectedSpanPart> = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.startByte < cursor) {
      throw new Error("RB-001 protected-span shell rejected overlapping spans");
    }
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
  if (cursor < sourceTextUtf8ByteLength) {
    parts.push({
      kind: "redacted_text",
      startByte: cursor,
      endByte: sourceTextUtf8ByteLength,
      utf8ByteLength: sourceTextUtf8ByteLength - cursor,
    });
  }
  return {
    format: "rb001.redacted-sjis-protected-shell.v1",
    sourceEncoding: "shift-jis-with-reallive-control-spans",
    sourceTextUtf8ByteLength,
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

function validateCorpus(corpus: JsonRecord): void {
  assertExactKeys(
    corpus,
    ["corpusId", "engine", "sourceLocale", "inputs", "fullGame"],
    "manifest.corpus",
  );
  if (string(corpus.corpusId, "manifest.corpus.corpusId") !== "sweetie-hd-reallive") {
    throw new Error("RB-001 manifest corpusId is not Sweetie HD RealLive");
  }
  if (string(corpus.engine, "manifest.corpus.engine") !== "reallive") {
    throw new Error("RB-001 manifest corpus engine is not RealLive");
  }
  if (string(corpus.sourceLocale, "manifest.corpus.sourceLocale") !== "ja-JP") {
    throw new Error("RB-001 manifest source locale is not ja-JP");
  }
  const inputs = record(corpus.inputs, "manifest.corpus.inputs");
  assertExactKeys(inputs, ["seenTxt", "gameexeIni"], "manifest.corpus.inputs");
  validateFingerprint(
    record(inputs.seenTxt, "manifest.corpus.inputs.seenTxt"),
    "manifest.corpus.inputs.seenTxt",
  );
  validateFingerprint(
    record(inputs.gameexeIni, "manifest.corpus.inputs.gameexeIni"),
    "manifest.corpus.inputs.gameexeIni",
  );

  const fullGame = record(corpus.fullGame, "manifest.corpus.fullGame");
  assertExactKeys(fullGame, ["kaifuuDecode", "utsushiStructure"], "manifest.corpus.fullGame");
  const kaifuu = record(fullGame.kaifuuDecode, "manifest.corpus.fullGame.kaifuuDecode");
  assertExactKeys(
    kaifuu,
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
  if (
    string(kaifuu.schemaVersion, "manifest.corpus.fullGame.kaifuuDecode.schemaVersion") !==
    KAIFUU_BRIDGE_SCHEMA_VERSION
  ) {
    throw new Error("RB-001 full-game bridge schema must be the reviewed kaifuu v0.2 schema");
  }
  validateFingerprint(
    record(kaifuu.bridgeExport, "manifest.corpus.fullGame.kaifuuDecode.bridgeExport"),
    "manifest.corpus.fullGame.kaifuuDecode.bridgeExport",
  );
  assertSha256(kaifuu.sourceBundleHash, "manifest.corpus.fullGame.kaifuuDecode.sourceBundleHash");
  nonNegativeInteger(kaifuu.assetCount, "manifest.corpus.fullGame.kaifuuDecode.assetCount");
  nonNegativeInteger(kaifuu.unitCount, "manifest.corpus.fullGame.kaifuuDecode.unitCount");
  nonNegativeInteger(
    kaifuu.routeSceneCount,
    "manifest.corpus.fullGame.kaifuuDecode.routeSceneCount",
  );
  const decompile = record(kaifuu.decompile, "manifest.corpus.fullGame.kaifuuDecode.decompile");
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
  if (
    string(
      decompile.schemaVersion,
      "manifest.corpus.fullGame.kaifuuDecode.decompile.schemaVersion",
    ) !== KAIFUU_DECOMPILE_SCHEMA_VERSION
  ) {
    throw new Error("RB-001 full-game decompile report schema is not pinned");
  }
  if (
    string(decompile.scope, "manifest.corpus.fullGame.kaifuuDecode.decompile.scope") !==
    "whole-seen"
  ) {
    throw new Error("RB-001 full-game decompile scope must be whole-seen");
  }
  for (const key of [
    "sceneCount",
    "totalOpcodes",
    "recognizedOpcodes",
    "unknownOpcodes",
  ] as const) {
    nonNegativeInteger(decompile[key], `manifest.corpus.fullGame.kaifuuDecode.decompile.${key}`);
  }
  if (
    number(
      decompile.unknownOpcodes,
      "manifest.corpus.fullGame.kaifuuDecode.decompile.unknownOpcodes",
    ) !== 0 ||
    number(
      decompile.recognizedOpcodes,
      "manifest.corpus.fullGame.kaifuuDecode.decompile.recognizedOpcodes",
    ) !==
      number(decompile.totalOpcodes, "manifest.corpus.fullGame.kaifuuDecode.decompile.totalOpcodes")
  ) {
    throw new Error("RB-001 full-game decode must pin a zero-unknown complete opcode report");
  }
  assertSha256(
    decompile.sourceSeenSha256,
    "manifest.corpus.fullGame.kaifuuDecode.decompile.sourceSeenSha256",
  );

  const structure = record(fullGame.utsushiStructure, "manifest.corpus.fullGame.utsushiStructure");
  assertExactKeys(
    structure,
    [
      "schemaVersion",
      "structureExport",
      "entryScene",
      "sceneCount",
      "dispatchOrderCount",
      "messageCount",
      "choiceCount",
      "speakerCount",
      "scene1017",
    ],
    "manifest.corpus.fullGame.utsushiStructure",
  );
  if (
    string(structure.schemaVersion, "manifest.corpus.fullGame.utsushiStructure.schemaVersion") !==
    UTSUSHI_STRUCTURE_SCHEMA_VERSION
  ) {
    throw new Error("RB-001 full-game structure schema is not pinned");
  }
  validateFingerprint(
    record(structure.structureExport, "manifest.corpus.fullGame.utsushiStructure.structureExport"),
    "manifest.corpus.fullGame.utsushiStructure.structureExport",
  );
  for (const key of [
    "entryScene",
    "sceneCount",
    "dispatchOrderCount",
    "messageCount",
    "choiceCount",
    "speakerCount",
  ] as const) {
    nonNegativeInteger(structure[key], `manifest.corpus.fullGame.utsushiStructure.${key}`);
  }
  const scene1017 = record(
    structure.scene1017,
    "manifest.corpus.fullGame.utsushiStructure.scene1017",
  );
  assertExactKeys(
    scene1017,
    [
      "sceneId",
      "messageCount",
      "choiceCount",
      "nextScene",
      "selectionControl",
      "dispatchFanoutScenes",
    ],
    "manifest.corpus.fullGame.utsushiStructure.scene1017",
  );
  if (
    number(scene1017.sceneId, "manifest.corpus.fullGame.utsushiStructure.scene1017.sceneId") !==
    1017
  ) {
    throw new Error("RB-001 structure scope must contain scene 1017");
  }
  for (const key of ["messageCount", "choiceCount"] as const) {
    nonNegativeInteger(
      scene1017[key],
      `manifest.corpus.fullGame.utsushiStructure.scene1017.${key}`,
    );
  }
  nullableNumber(
    scene1017.nextScene,
    "manifest.corpus.fullGame.utsushiStructure.scene1017.nextScene",
  );
  if (
    string(
      scene1017.selectionControl,
      "manifest.corpus.fullGame.utsushiStructure.scene1017.selectionControl",
    ) !== "none"
  ) {
    throw new Error("RB-001 scene 1017 selection control must remain none");
  }
  array(
    scene1017.dispatchFanoutScenes,
    "manifest.corpus.fullGame.utsushiStructure.scene1017.dispatchFanoutScenes",
  ).forEach((item, index) =>
    nonNegativeInteger(
      item,
      `manifest.corpus.fullGame.utsushiStructure.scene1017.dispatchFanoutScenes[${index}]`,
    ),
  );
}

function validateOutputScope(scope: JsonRecord): void {
  assertExactKeys(scope, ["scopeId", "sceneId", "bridge", "units"], "manifest.outputScope");
  if (string(scope.scopeId, "manifest.outputScope.scopeId") !== "sweetie-hd-reallive:scene-1017") {
    throw new Error("RB-001 output scope is not Sweetie scene 1017");
  }
  if (number(scope.sceneId, "manifest.outputScope.sceneId") !== 1017) {
    throw new Error("RB-001 output scope sceneId must be 1017");
  }
  const bridge = record(scope.bridge, "manifest.outputScope.bridge");
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
  if (
    string(bridge.schemaVersion, "manifest.outputScope.bridge.schemaVersion") !==
    KAIFUU_BRIDGE_SCHEMA_VERSION
  ) {
    throw new Error("RB-001 scene bridge schema must be the reviewed kaifuu v0.2 schema");
  }
  validateFingerprint(
    record(bridge.bridgeExport, "manifest.outputScope.bridge.bridgeExport"),
    "manifest.outputScope.bridge.bridgeExport",
  );
  assertSha256(bridge.sourceBundleHash, "manifest.outputScope.bridge.sourceBundleHash");
  for (const key of ["unitCount", "uniqueBridgeUnitIdCount", "uniqueSourceHashCount"] as const) {
    if (number(bridge[key], `manifest.outputScope.bridge.${key}`) !== 129) {
      throw new Error(`RB-001 output scope ${key} must pin all 129 real units`);
    }
  }
  assertSha256(bridge.unitsProjectionSha256, "manifest.outputScope.bridge.unitsProjectionSha256");
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
  if (
    string(decompile.schemaVersion, "manifest.outputScope.bridge.decompile.schemaVersion") !==
    KAIFUU_DECOMPILE_SCHEMA_VERSION
  ) {
    throw new Error("RB-001 scene decompile report schema is not pinned");
  }
  if (number(decompile.sceneId, "manifest.outputScope.bridge.decompile.sceneId") !== 1017) {
    throw new Error("RB-001 scene decompile report must identify scene 1017");
  }
  for (const key of ["totalOpcodes", "recognizedOpcodes", "unknownOpcodes"] as const) {
    nonNegativeInteger(decompile[key], `manifest.outputScope.bridge.decompile.${key}`);
  }
  if (
    number(decompile.unknownOpcodes, "manifest.outputScope.bridge.decompile.unknownOpcodes") !==
      0 ||
    number(
      decompile.recognizedOpcodes,
      "manifest.outputScope.bridge.decompile.recognizedOpcodes",
    ) !== number(decompile.totalOpcodes, "manifest.outputScope.bridge.decompile.totalOpcodes")
  ) {
    throw new Error("RB-001 scene decode must pin a zero-unknown complete opcode report");
  }
  assertSha256(
    decompile.sourceSeenSha256,
    "manifest.outputScope.bridge.decompile.sourceSeenSha256",
  );

  const units = array(scope.units, "manifest.outputScope.units").map((unit, index) =>
    record(unit, `manifest.outputScope.units[${index}]`),
  );
  if (units.length !== 129) {
    throw new Error("RB-001 manifest must carry exactly 129 scene-1017 units");
  }
  const ids = new Set<string>();
  const hashes = new Set<string>();
  let kidokuSpanCount = 0;
  let nameTokenSpanCount = 0;
  for (const [index, unit] of units.entries()) {
    const protectedSpanInventory = validateUnit(unit, `manifest.outputScope.units[${index}]`);
    kidokuSpanCount += protectedSpanInventory.kidoku;
    nameTokenSpanCount += protectedSpanInventory.nameToken;
    const id = string(unit.bridgeUnitId, `manifest.outputScope.units[${index}].bridgeUnitId`);
    const hash = string(unit.sourceHash, `manifest.outputScope.units[${index}].sourceHash`);
    const sourceRevision = record(
      unit.sourceRevision,
      `manifest.outputScope.units[${index}].sourceRevision`,
    );
    if (sourceRevision.value !== bridge.sourceBundleHash) {
      throw new Error(
        "RB-001 unit source revision is not pinned to the scene bridge source bundle",
      );
    }
    if (ids.has(id)) {
      throw new Error("RB-001 manifest rejected: duplicate BridgeUnit ID");
    }
    if (hashes.has(hash)) {
      throw new Error("RB-001 manifest rejected: duplicate source hash");
    }
    ids.add(id);
    hashes.add(hash);
  }
  if (ids.size !== 129 || hashes.size !== 129) {
    throw new Error("RB-001 manifest rejected: missing or duplicate units");
  }
  if (kidokuSpanCount !== 129 || nameTokenSpanCount !== 68) {
    throw new Error(
      "RB-001 manifest rejected: protected-span inventory is not the pinned 129/68 shell",
    );
  }
  const typedUnits = units as unknown as SweetieRb001Unit[];
  if (sha256Bytes(stableJson(typedUnits)) !== bridge.unitsProjectionSha256) {
    throw new Error("RB-001 manifest rejected: scene-1017 unit projection content hash drift");
  }
}

type ProtectedSpanInventory = {
  kidoku: number;
  nameToken: number;
};

function validateUnit(unit: JsonRecord, label: string): ProtectedSpanInventory {
  assertExactKeys(
    unit,
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
  const bridgeUnitId = string(unit.bridgeUnitId, `${label}.bridgeUnitId`);
  if (!UUID7_PATTERN.test(bridgeUnitId)) {
    throw new Error("RB-001 unit bridgeUnitId must be a UUIDv7 metadata identifier");
  }
  const sourceUnitKey = string(unit.sourceUnitKey, `${label}.sourceUnitKey`);
  const sourceUnitMatch = SCENE1017_UNIT_KEY_PATTERN.exec(sourceUnitKey);
  if (sourceUnitMatch === null) {
    throw new Error("RB-001 unit sourceUnitKey must be a scene-1017 ordinal key");
  }
  const ordinal = sourceUnitMatch[1]!;
  const occurrenceId = string(unit.occurrenceId, `${label}.occurrenceId`);
  const occurrenceMatch = SCENE1017_OCCURRENCE_PATTERN.exec(occurrenceId);
  if (occurrenceMatch === null || occurrenceMatch[1] !== ordinal) {
    throw new Error("RB-001 unit occurrenceId must agree with its scene-1017 source ordinal");
  }
  if (string(unit.surfaceKind, `${label}.surfaceKind`) !== "dialogue") {
    throw new Error("RB-001 output scope must contain dialogue bridge units only");
  }
  assertSha256(unit.sourceHash, `${label}.sourceHash`);
  const revision = record(unit.sourceRevision, `${label}.sourceRevision`);
  assertExactKeys(revision, ["revisionId", "revisionKind", "value"], `${label}.sourceRevision`);
  if (!UUID7_PATTERN.test(string(revision.revisionId, `${label}.sourceRevision.revisionId`))) {
    throw new Error("RB-001 source revision ID must be a UUIDv7 metadata identifier");
  }
  if (string(revision.revisionKind, `${label}.sourceRevision.revisionKind`) !== "content_hash") {
    throw new Error("RB-001 source revision must retain the content_hash provenance kind");
  }
  assertSha256(revision.value, `${label}.sourceRevision.value`);
  const byteLocation = record(unit.byteLocation, `${label}.byteLocation`);
  assertExactKeys(byteLocation, ["containerKey", "entryPath", "range"], `${label}.byteLocation`);
  if (
    string(byteLocation.containerKey, `${label}.byteLocation.containerKey`) !==
    "reallive:scene-1017"
  ) {
    throw new Error("RB-001 unit location must stay in real scene 1017");
  }
  const entryPath = array(byteLocation.entryPath, `${label}.byteLocation.entryPath`).map(
    (entry, index) => string(entry, `${label}.byteLocation.entryPath[${index}]`),
  );
  if (
    entryPath.length !== 4 ||
    entryPath[0] !== "scene" ||
    entryPath[1] !== "1017" ||
    entryPath[2] !== "units" ||
    entryPath[3] !== ordinal
  ) {
    throw new Error("RB-001 unit entryPath must agree with its scene-1017 source ordinal");
  }
  const range = record(byteLocation.range, `${label}.byteLocation.range`);
  assertExactKeys(range, ["startByte", "endByte"], `${label}.byteLocation.range`);
  const start = nonNegativeInteger(range.startByte, `${label}.byteLocation.range.startByte`);
  const end = nonNegativeInteger(range.endByte, `${label}.byteLocation.range.endByte`);
  if (end <= start) {
    throw new Error("RB-001 unit byte location must have a positive decompressed range");
  }
  const protectedSkeleton = record(unit.protectedSkeleton, `${label}.protectedSkeleton`);
  const protectedSpanInventory = validateProtectedSkeleton(
    protectedSkeleton,
    `${label}.protectedSkeleton`,
  );
  if (
    number(
      protectedSkeleton.decompressedSourceByteLength,
      `${label}.protectedSkeleton.decompressedSourceByteLength`,
    ) !==
    end - start
  ) {
    throw new Error(
      "RB-001 protected skeleton decompressed length must agree with its byte location",
    );
  }
  const route = record(unit.route, `${label}.route`);
  assertExactKeys(route, ["sceneKey", "position"], `${label}.route`);
  if (string(route.sceneKey, `${label}.route.sceneKey`) !== "scene-1017") {
    throw new Error("RB-001 unit route must remain scene-1017");
  }
  const routePosition = string(route.position, `${label}.route.position`);
  const routeMatch = SCENE1017_ROUTE_POSITION_PATTERN.exec(routePosition);
  if (routeMatch === null || routeMatch[1] !== ordinal) {
    throw new Error("RB-001 unit route position must agree with its scene-1017 source ordinal");
  }
  const membership = record(unit.sceneMembership, `${label}.sceneMembership`);
  assertExactKeys(membership, ["sceneId", "structureDispatchIndex"], `${label}.sceneMembership`);
  if (number(membership.sceneId, `${label}.sceneMembership.sceneId`) !== 1017) {
    throw new Error("RB-001 unit scene membership must remain scene 1017");
  }
  if (
    nonNegativeInteger(
      membership.structureDispatchIndex,
      `${label}.sceneMembership.structureDispatchIndex`,
    ) !== RB001_DISPATCH_INDEX
  ) {
    throw new Error("RB-001 unit scene membership must retain the structure dispatch index");
  }
  const replayTarget = record(unit.replayTarget, `${label}.replayTarget`);
  assertExactKeys(replayTarget, ["expectationKind", "traceKey"], `${label}.replayTarget`);
  if (
    string(replayTarget.expectationKind, `${label}.replayTarget.expectationKind`) !== "trace_text"
  ) {
    throw new Error("RB-001 replay target must retain a trace_text expectation");
  }
  const traceKey = string(replayTarget.traceKey, `${label}.replayTarget.traceKey`);
  if (
    traceKey !== occurrenceId &&
    (!SCENE1017_VOICE_TRACE_PATTERN.test(traceKey) ||
      !traceKey.startsWith(`${occurrenceId}#voice=`))
  ) {
    throw new Error("RB-001 replay target traceKey must derive from its source occurrence");
  }
  return protectedSpanInventory;
}

function validateProtectedSkeleton(skeleton: JsonRecord, label: string): ProtectedSpanInventory {
  assertExactKeys(
    skeleton,
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
  if (string(skeleton.format, `${label}.format`) !== "rb001.redacted-sjis-protected-shell.v1") {
    throw new Error("RB-001 unit protected skeleton format is not supported");
  }
  if (
    string(skeleton.sourceEncoding, `${label}.sourceEncoding`) !==
    "shift-jis-with-reallive-control-spans"
  ) {
    throw new Error(
      "RB-001 unit protected skeleton must retain the Shift-JIS/control-span encoding shell",
    );
  }
  const sourceTextLength = nonNegativeInteger(
    skeleton.sourceTextUtf8ByteLength,
    `${label}.sourceTextUtf8ByteLength`,
  );
  if (sourceTextLength === 0) {
    throw new Error("RB-001 unit protected skeleton must retain a non-empty redacted source shell");
  }
  const decompressedLength = nonNegativeInteger(
    skeleton.decompressedSourceByteLength,
    `${label}.decompressedSourceByteLength`,
  );
  if (decompressedLength === 0) {
    throw new Error("RB-001 unit protected skeleton must retain a non-empty source location");
  }
  const shell = string(skeleton.shell, `${label}.shell`);
  const parts = array(skeleton.parts, `${label}.parts`).map((part, index) =>
    record(part, `${label}.parts[${index}]`),
  );
  let cursor = 0;
  let expectedSpanIndex = 0;
  let kidoku = 0;
  let nameToken = 0;
  const shellParts: string[] = [];
  for (const [index, part] of parts.entries()) {
    const kind = string(part.kind, `${label}.parts[${index}].kind`);
    if (kind === "redacted_text") {
      assertExactKeys(
        part,
        ["kind", "startByte", "endByte", "utf8ByteLength"],
        `${label}.parts[${index}]`,
      );
      shellParts.push(
        `<REDACTED_TEXT:utf8=${nonNegativeInteger(part.utf8ByteLength, `${label}.parts[${index}].utf8ByteLength`)}>`,
      );
    } else if (kind === "protected_span") {
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
        nonNegativeInteger(part.spanIndex, `${label}.parts[${index}].spanIndex`) !==
        expectedSpanIndex
      ) {
        throw new Error("RB-001 protected skeleton span indexes must be consecutive");
      }
      expectedSpanIndex += 1;
      if (string(part.spanKind, `${label}.parts[${index}].spanKind`) !== "control_markup") {
        throw new Error("RB-001 protected skeleton span kind must be control_markup");
      }
      const parsedName = string(part.parsedName, `${label}.parts[${index}].parsedName`);
      if (!PROTECTED_SPAN_NAMES.has(parsedName)) {
        throw new Error("RB-001 protected skeleton contains an unsupported protected span name");
      }
      if (
        (expectedSpanIndex === 1 && parsedName !== "reallive.kidoku") ||
        (expectedSpanIndex === 2 && parsedName !== "reallive.name_token") ||
        expectedSpanIndex > 2
      ) {
        throw new Error(
          "RB-001 protected skeleton must retain kidoku then optional name-token ordering",
        );
      }
      assertSha256(part.rawSha256, `${label}.parts[${index}].rawSha256`);
      if (string(part.preserveMode, `${label}.parts[${index}].preserveMode`) !== "exact") {
        throw new Error("RB-001 protected skeleton spans must use exact preservation");
      }
      if (part.outOfBand !== (parsedName === "reallive.kidoku")) {
        throw new Error(
          "RB-001 protected skeleton span out-of-band mode does not match its protected name",
        );
      }
      if (parsedName === "reallive.kidoku") kidoku += 1;
      else nameToken += 1;
      shellParts.push(
        `<PROTECTED:${parsedName}:utf8=${nonNegativeInteger(part.utf8ByteLength, `${label}.parts[${index}].utf8ByteLength`)}>`,
      );
    } else {
      throw new Error("RB-001 protected skeleton has an unredacted/unknown part kind");
    }
    const start = nonNegativeInteger(part.startByte, `${label}.parts[${index}].startByte`);
    const end = nonNegativeInteger(part.endByte, `${label}.parts[${index}].endByte`);
    const length = nonNegativeInteger(
      part.utf8ByteLength,
      `${label}.parts[${index}].utf8ByteLength`,
    );
    if (start !== cursor || end < start || length !== end - start) {
      throw new Error("RB-001 protected skeleton parts must form one contiguous redacted shell");
    }
    cursor = end;
  }
  if (cursor !== sourceTextLength) {
    throw new Error("RB-001 protected skeleton does not cover its complete source text shell");
  }
  if (parts[0]?.kind !== "protected_span" || kidoku !== 1 || nameToken > 1) {
    throw new Error("RB-001 protected skeleton must begin with exactly one kidoku span");
  }
  const expectedShell = shellParts.join("");
  if (shell !== expectedShell) {
    throw new Error(
      "RB-001 protected skeleton shell must be reconstructed from redacted structural parts",
    );
  }
  return { kidoku, nameToken };
}

function validateFailedRunBaseline(baseline: JsonRecord): void {
  assertExactKeys(
    baseline,
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
  if (
    string(baseline.source, "manifest.failedRunBaseline.source") !==
    "bridge-rerun-completion-report-2026-07-14"
  ) {
    throw new Error("RB-001 baseline must cite the bridge rerun completion report");
  }
  if (
    baseline.reportSha256 !==
    "sha256:6735ac9cea5c14edd95613fcc1e274f7c0338495c310c0482d1039250511690e"
  ) {
    throw new Error("RB-001 baseline must pin the reviewed bridge-rerun completion report hash");
  }
  if (
    string(baseline.runId, "manifest.failedRunBaseline.runId") !==
    "localization-journal-run-46ae0c28-3578-43f7-b51a-b4cffc340c51"
  ) {
    throw new Error("RB-001 baseline must pin the reviewed bridge-rerun run ID");
  }
  const exact = {
    sceneId: 1017,
    scopedUnitCount: 129,
    physicalAttempts: 762,
    unitsWritten: 57,
    finalizedPatchCount: 0,
    acceptedOutputsDiscarded: 51,
    retranslatedUnitCount: 27,
  } as const;
  for (const [key, expected] of Object.entries(exact)) {
    if (number(baseline[key], `manifest.failedRunBaseline.${key}`) !== expected) {
      throw new Error(`RB-001 baseline ${key} must pin its exact bridge-rerun value`);
    }
  }
  if (
    string(baseline.failureMode, "manifest.failedRunBaseline.failureMode") !==
    "sys-1-unit-pipeline-restarts-discard-accepted-work"
  ) {
    throw new Error("RB-001 baseline must pin the SYS-1 discarded-work failure mode");
  }
}

function validateFingerprint(fingerprint: JsonRecord, label: string): void {
  assertExactKeys(fingerprint, ["sha256", "byteLength"], label);
  assertSha256(fingerprint.sha256, `${label}.sha256`);
  if (nonNegativeInteger(fingerprint.byteLength, `${label}.byteLength`) === 0) {
    throw new Error(`RB-001 ${label}.byteLength must be non-zero`);
  }
}

function assertMetadataOnly(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (/[^\x20-\x7e]/u.test(value)) {
      throw new Error(
        `RB-001 manifest privacy violation: ${label} contains non-metadata text bytes`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertMetadataOnly(entry, `${label}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (PRIVATE_PAYLOAD_KEYS.has(key)) {
      throw new Error(
        `RB-001 manifest privacy violation: ${label}.${key} would retain private source payload`,
      );
    }
    assertMetadataOnly(entry, `${label}.${key}`);
  }
}

function assertSameFingerprint(
  actual: FileFingerprint,
  expected: FileFingerprint,
  label: string,
): void {
  if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) {
    throw new Error(`RB-001 corpus gate rejected ${label}: pinned content address does not match`);
  }
}

function childDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
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
        next.push(...childDirectories(candidate));
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
    existsSync(join(dataRoot, "Gameexe.ini")) &&
    existsSync(join(dataRoot, "Seen.txt"))
  );
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`RB-001 ${label} output is not readable JSON`);
  }
}

function assertExactKeys(value: JsonRecord, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`RB-001 manifest shape drift at ${label}`);
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`RB-001 expected object at ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`RB-001 expected array at ${label}`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`RB-001 expected non-empty string at ${label}`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return string(value, label);
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`RB-001 expected finite number at ${label}`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) {
    return null;
  }
  return number(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`RB-001 expected non-negative integer at ${label}`);
  }
  return parsed;
}

function literal(value: unknown, expected: string | number, label: string): string | number {
  if (value !== expected) {
    throw new Error(`RB-001 expected pinned value at ${label}`);
  }
  return expected;
}

function sha256(value: unknown, label: string): Sha256 {
  assertSha256(value, label);
  return value as Sha256;
}

function assertSha256(value: unknown, label: string): asserts value is Sha256 {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`RB-001 expected canonical sha256 at ${label}`);
  }
}
