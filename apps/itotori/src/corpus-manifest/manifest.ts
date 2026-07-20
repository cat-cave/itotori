// Data model and canonical addressing for private corpus manifests.
//
// This file intentionally contains no corpus identity. Registered manifests
// carry their own game, engine, scope, input, and baseline metadata.

import { createHash } from "node:crypto";

export const CORPUS_MANIFEST_SCHEMA_VERSION = "itotori.private-corpus-manifest.v1";
export const REAL_CORPUS_ROOT_ENV = "ITOTORI_REAL_CORPUS_ROOT";

export type Sha256 = `sha256:${string}`;

export type FileFingerprint = {
  sha256: Sha256;
  byteLength: number;
};

/**
 * Adapter-defined source inputs pinned by a private corpus manifest.
 *
 * The common manifest contract deliberately does not name a particular
 * engine's files. A CorpusValidationAdapter declares the exact keys its
 * manifests carry and resolves those keys to on-disk inputs during a live run.
 */
export type CorpusInputMap = Record<string, FileFingerprint>;

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
  format: "itotori.redacted-sjis-protected-shell.v1";
  sourceEncoding: string;
  sourceTextUtf8ByteLength: number;
  decompressedSourceByteLength: number;
  shell: string;
  parts: Array<RedactedTextPart | ProtectedSpanPart>;
};

export type CorpusUnit = {
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
    range: { startByte: number; endByte: number };
  };
  protectedSkeleton: ProtectedSkeleton;
  route: { sceneKey: string; position: string };
  sceneMembership: { sceneId: number; structureDispatchIndex: number };
  replayTarget: { expectationKind: string; traceKey: string };
};

export type ScopedScene = {
  sceneId: number;
  messageCount: number;
  choiceCount: number;
  nextScene: number | null;
  selectionControl: string;
  dispatchFanoutScenes: number[];
  dispatchIndex: number;
};

/** The complete, zero-padded source-ordinal set expected for an output scope. */
export type OrdinalRange = {
  start: number;
  end: number;
  width: number;
};

export type CorpusEvidence = {
  corpusId: string;
  gameId: string;
  gameVersion: string;
  sourceProfileId: string;
  engine: string;
  sourceLocale: string;
  inputs: CorpusInputMap;
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
        scope: string;
        sceneCount: number;
        totalOpcodes: number;
        recognizedOpcodes: number;
        unknownOpcodes: number;
        sourceSeenSha256: Sha256;
      };
    };
    utsushiStructure: {
      schemaVersion: string;
      structureExport: FileFingerprint;
      entryScene: number;
      sceneCount: number;
      dispatchOrderCount: number;
      messageCount: number;
      choiceCount: number;
      speakerCount: number;
      scopedScene: ScopedScene;
    };
  };
};

export type CorpusOutputScope = {
  scopeId: string;
  sceneId: number;
  ordinalRange: OrdinalRange;
  bridge: {
    schemaVersion: string;
    bridgeExport: FileFingerprint;
    sourceBundleHash: Sha256;
    decompile: {
      schemaVersion: string;
      sceneId: number;
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
  units: CorpusUnit[];
};

export type CorpusManifest = {
  schemaVersion: typeof CORPUS_MANIFEST_SCHEMA_VERSION;
  manifestId: string;
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
  corpus: CorpusEvidence;
  outputScope: CorpusOutputScope;
  failedRunBaseline: {
    source: string;
    reportSha256: Sha256;
    runId: string;
    sceneId: number;
    scopedUnitCount: number;
    physicalAttempts: number;
    unitsWritten: number;
    finalizedPatchCount: number;
    acceptedOutputsDiscarded: number;
    retranslatedUnitCount: number;
    failureMode: string;
  };
};

export type DerivedCorpusEvidence = Pick<CorpusManifest, "corpus" | "outputScope">;

/** A small data-driven registry keyed only by each manifest's own game id. */
export class CorpusManifestRegistry {
  readonly #byGameId = new Map<string, CorpusManifest>();

  register(manifest: CorpusManifest): void {
    const key = manifest.corpus.gameId;
    if (this.#byGameId.has(key)) {
      throw new Error(`private corpus registry has a duplicate gameId: ${key}`);
    }
    this.#byGameId.set(key, manifest);
  }

  get(gameId: string): CorpusManifest | undefined {
    return this.#byGameId.get(gameId);
  }

  values(): IterableIterator<CorpusManifest> {
    return this.#byGameId.values();
  }
}

/** Canonical JSON used by content addressing and content-derived projections. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON refuses non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON refuses unsupported values");
}

export function sha256Bytes(value: Uint8Array | string): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function corpusManifestContentHash(manifest: CorpusManifest): Sha256 {
  const { manifestSha256: _ignored, ...contentAddress } = manifest.contentAddress;
  return sha256Bytes(stableJson({ ...manifest, contentAddress }));
}

/** Return a fresh content-addressed copy after an intentional metadata edit. */
export function readdressCorpusManifest<T extends CorpusManifest>(manifest: T): T {
  const readdressed = structuredClone(manifest);
  readdressed.contentAddress.manifestSha256 = corpusManifestContentHash(readdressed);
  return readdressed as T;
}
