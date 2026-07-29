import { resolveCorpusValidationAdapter } from "./corpus-validation-registry.js";
import {
  CORPUS_MANIFEST_SCHEMA_VERSION,
  corpusManifestContentHash,
  stableJson,
  type CorpusEvidence,
  type CorpusManifest,
  type FileFingerprint,
} from "./manifest.js";
import { validateOutputScope } from "./validate-output-scope.js";
import { validateBaseline, validateFingerprint } from "./validate-units.js";
import {
  array,
  assertExactKeys,
  metadataString,
  nonNegativeInteger,
  nullableNonNegativeInteger,
  positiveInteger,
  record,
  sha256,
  sourceInputFingerprint,
  type JsonRecord,
} from "./validate-primitives.js";

const FORBIDDEN_PAYLOADS = [
  "sourceText",
  "speaker text",
  "protected-span raw payload",
  "full bridge export",
  "full structure export",
] as const;

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
  const adapter = resolveCorpusValidationAdapter(corpus.engine);
  const outputScope = validateOutputScope(
    record(manifest.outputScope, "manifest.outputScope"),
    corpus,
    adapter,
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
  const adapter = resolveCorpusValidationAdapter(engine);
  const inputs = adapter.validateManifestInputs(value.inputs);

  const fullGame = record(value.fullGame, "manifest.corpus.fullGame");
  assertExactKeys(fullGame, ["kaifuuDecode", "utsushiStructure"], "manifest.corpus.fullGame");
  const kaifuuDecode = validateKaifuuDecode(
    record(fullGame.kaifuuDecode, "manifest.corpus.fullGame.kaifuuDecode"),
    sourceInputFingerprint(inputs, adapter),
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
    inputs,
    fullGame: { kaifuuDecode, utsushiStructure },
  };
}

function validateKaifuuDecode(
  value: JsonRecord,
  sourceInput: FileFingerprint,
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
    decoded.decompile.sourceSeenSha256 !== sourceInput.sha256
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
