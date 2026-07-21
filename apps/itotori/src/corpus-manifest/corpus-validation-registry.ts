// Engine-discriminated private-corpus validation registry.
//
// The common manifest validator resolves an adapter from the manifest's
// REQUIRED engine discriminant. There is no fallback: each adapter owns the
// source layout, input-map keys, pinned-input check, scoped extraction, and any
// runtime-structure evidence it can produce.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { runKaifuuExtract } from "../extract/kaifuu-extract-seam.js";
import { runUtsushiStructureExport } from "../structure-export/utsushi-structure-seam.js";
import {
  REAL_CORPUS_ROOT_ENV,
  sha256Bytes,
  type CorpusInputMap,
  type CorpusManifest,
  type FileFingerprint,
  type Sha256,
} from "./manifest.js";

type CorpusValidationSource = {
  gameRoot: string;
  inputPaths: Record<string, string>;
};

export type RealliveCorpusValidationSource = CorpusValidationSource & {
  inputPaths: { seenTxt: string; gameexeIni: string };
};

/** Typed forward declaration for the Softpal corpus-validation source. */
export type SoftpalCorpusValidationSource = CorpusValidationSource & {
  inputPaths: { scriptSrc: string; textDat: string };
};

/** Typed forward declaration for the RPG Maker corpus-validation source. */
export type RpgMakerCorpusValidationSource = CorpusValidationSource & {
  inputPaths: { dataJson: string };
};

/** The generic Siglus corpus pair; no title-specific input layout is assumed. */
export type SiglusCorpusValidationSource = CorpusValidationSource & {
  inputPaths: { scenePck: string; gameexeDat: string };
};

export type CorpusValidationSourceByEngine = {
  reallive: RealliveCorpusValidationSource;
  softpal: SoftpalCorpusValidationSource;
  "rpg-maker": RpgMakerCorpusValidationSource;
  siglus: SiglusCorpusValidationSource;
};

export type CorpusValidationEngineId = keyof CorpusValidationSourceByEngine;
export type ResolvedCorpus = CorpusValidationSource;

export type CorpusResolution =
  | { kind: "ready"; corpus: ResolvedCorpus }
  | { kind: "skip"; reason: string };

export type CorpusValidationArtifacts = {
  inputs: CorpusInputMap;
  fullBridgePath: string;
  fullReportPath: string;
  scopedBridgePath: string;
  scopedReportPath: string;
  structurePath: string;
};

/** Adapter-owned conventions for metadata derived from a scoped bridge. */
export type CorpusValidationEvidenceConventions = {
  sourceEncoding: string;
  protectedNames: readonly string[];
  outOfBandProtectedName: string;
  sourceUnitKey(sceneId: number, ordinal: string): string;
  occurrenceId(sceneId: number, ordinal: string): string;
  containerKey(sceneId: number): string;
  entryPath(sceneId: number, ordinal: string): string[];
  route(sceneId: number, ordinal: string): { sceneKey: string; position: string };
};

type CorpusValidationRun = {
  manifest: CorpusManifest;
  corpus: ResolvedCorpus;
  tempRoot: string;
  nativeEnv: NodeJS.ProcessEnv;
};

/**
 * A private-corpus adapter owns all engine-shaped inputs. The common layer
 * only supplies a manifest, a temporary output root, and a sanitized native
 * environment.
 */
export interface CorpusValidationAdapter<E extends CorpusValidationEngineId> {
  readonly engine: E;
  readonly inputNames: readonly (keyof CorpusValidationSourceByEngine[E]["inputPaths"] & string)[];
  readonly sourceInputName: keyof CorpusValidationSourceByEngine[E]["inputPaths"] & string;
  readonly runtimeStructureEvidence: boolean;
  readonly evidence: CorpusValidationEvidenceConventions;
  validateManifestInputs(inputs: unknown): CorpusInputMap;
  resolve(manifest: CorpusManifest, env: NodeJS.ProcessEnv): CorpusResolution;
  assertPinnedInputs(corpus: ResolvedCorpus, manifest: CorpusManifest): void;
  extract(run: CorpusValidationRun): CorpusValidationArtifacts;
}

export type AnyCorpusValidationAdapter = {
  readonly engine: CorpusValidationEngineId;
  readonly inputNames: readonly string[];
  readonly sourceInputName: string;
  readonly runtimeStructureEvidence: boolean;
  readonly evidence: CorpusValidationEvidenceConventions;
  validateManifestInputs(inputs: unknown): CorpusInputMap;
  resolve(manifest: CorpusManifest, env: NodeJS.ProcessEnv): CorpusResolution;
  assertPinnedInputs(corpus: ResolvedCorpus, manifest: CorpusManifest): void;
  extract(run: CorpusValidationRun): CorpusValidationArtifacts;
};

function defineCorpusValidationAdapter<E extends CorpusValidationEngineId>(
  adapter: CorpusValidationAdapter<E>,
): AnyCorpusValidationAdapter {
  return adapter as unknown as AnyCorpusValidationAdapter;
}

/** Build a SHA-256 fingerprint without retaining a content-bearing value. */
export function fingerprintCorpusInput(path: string): FileFingerprint {
  const bytes = readFileSync(path);
  return { sha256: sha256Bytes(bytes), byteLength: bytes.byteLength };
}

const realliveCorpusValidationAdapter: CorpusValidationAdapter<"reallive"> = {
  engine: "reallive",
  inputNames: ["seenTxt", "gameexeIni"],
  sourceInputName: "seenTxt",
  runtimeStructureEvidence: true,
  evidence: scopedEvidence(
    "reallive",
    "shift-jis-with-reallive-control-spans",
    ["reallive.kidoku", "reallive.name_token"],
    "reallive.kidoku",
  ),
  validateManifestInputs(inputs) {
    return validateInputMap(inputs, this.inputNames);
  },
  resolve(manifest, env) {
    const configuredRoot = env[REAL_CORPUS_ROOT_ENV];
    if (configuredRoot === undefined || configuredRoot.length === 0) {
      return {
        kind: "skip",
        reason: `${REAL_CORPUS_ROOT_ENV} is unset; no private corpus bytes were read.`,
      };
    }
    const root = resolve(configuredRoot);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`private corpus root ${REAL_CORPUS_ROOT_ENV} is not a directory`);
    }
    const candidates = [...new Set(findRealliveGameRoots(root, 4))];
    if (candidates.length !== 1) {
      throw new Error("private corpus root must contain exactly one adapter-recognized game root");
    }
    const gameRoot = candidates[0]!;
    const dataRoot = join(gameRoot, "REALLIVEDATA");
    const corpus: RealliveCorpusValidationSource = {
      gameRoot,
      inputPaths: {
        seenTxt: join(dataRoot, "Seen.txt"),
        gameexeIni: join(dataRoot, "Gameexe.ini"),
      },
    };
    this.assertPinnedInputs(corpus, manifest);
    return { kind: "ready", corpus };
  },
  assertPinnedInputs(corpus, manifest) {
    assertPinnedInputMap(corpus, manifest, this.inputNames);
  },
  extract({ manifest, corpus, tempRoot, nativeEnv }) {
    const source = corpus as RealliveCorpusValidationSource;
    const fullBridgePath = join(tempRoot, "full.bridge.json");
    const fullReportPath = join(tempRoot, "full.decompile-report.json");
    const scopedBridgePath = join(tempRoot, "scoped.bridge.json");
    const scopedReportPath = join(tempRoot, "scoped.decompile-report.json");
    const structurePath = join(tempRoot, "full.structure.json");
    const identity = manifest.corpus;
    runKaifuuExtract({
      engine: "reallive",
      gameRoot: source.gameRoot,
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
      gameRoot: source.gameRoot,
      gameId: identity.gameId,
      gameVersion: identity.gameVersion,
      sourceProfileId: identity.sourceProfileId,
      sourceLocale: identity.sourceLocale,
      scene: manifest.outputScope.sceneId,
      bundleOutputPath: scopedBridgePath,
      decompileReportOutputPath: scopedReportPath,
      env: nativeEnv,
    });
    runUtsushiStructureExport({
      engine: "reallive",
      gameexePath: source.inputPaths.gameexeIni,
      seenPath: source.inputPaths.seenTxt,
      outputPath: structurePath,
      maxScenes: 10_000,
      env: nativeEnv,
    });
    return {
      inputs: {
        seenTxt: fingerprintCorpusInput(source.inputPaths.seenTxt),
        gameexeIni: fingerprintCorpusInput(source.inputPaths.gameexeIni),
      },
      fullBridgePath,
      fullReportPath,
      scopedBridgePath,
      scopedReportPath,
      structurePath,
    };
  },
};

function unavailableCorpusValidationAdapter<
  E extends Exclude<CorpusValidationEngineId, "reallive">,
>(
  engine: E,
  inputNames: CorpusValidationAdapter<E>["inputNames"],
  sourceInputName: CorpusValidationAdapter<E>["sourceInputName"],
  evidence: CorpusValidationEvidenceConventions,
): CorpusValidationAdapter<E> {
  return {
    engine,
    inputNames,
    sourceInputName,
    runtimeStructureEvidence: false,
    evidence,
    validateManifestInputs(inputs) {
      return validateInputMap(inputs, inputNames);
    },
    resolve(_manifest, env) {
      const configuredRoot = env[REAL_CORPUS_ROOT_ENV];
      if (configuredRoot === undefined || configuredRoot.length === 0) {
        return {
          kind: "skip",
          reason: `${REAL_CORPUS_ROOT_ENV} is unset; no private corpus bytes were read.`,
        };
      }
      return {
        kind: "skip",
        reason: `private corpus adapter '${engine}' does not implement source discovery yet.`,
      };
    },
    assertPinnedInputs(corpus, manifest) {
      assertPinnedInputMap(corpus, manifest, inputNames);
    },
    extract() {
      throw new Error(
        `private corpus adapter '${engine}' has typed inputs but does not implement scoped extraction yet`,
      );
    },
  };
}

const softpalCorpusValidationAdapter = unavailableCorpusValidationAdapter(
  "softpal",
  ["scriptSrc", "textDat"],
  "scriptSrc",
  scopedEvidence("softpal", "shift-jis-with-softpal-control-spans", ["softpal.control"], ""),
);

const rpgMakerCorpusValidationAdapter = unavailableCorpusValidationAdapter(
  "rpg-maker",
  ["dataJson"],
  "dataJson",
  scopedEvidence("rpg-maker", "utf8-with-rpg-maker-control-spans", ["rpg-maker.control"], ""),
);

const siglusCorpusValidationAdapter = unavailableCorpusValidationAdapter(
  "siglus",
  ["scenePck", "gameexeDat"],
  "scenePck",
  scopedEvidence("siglus", "utf16le-with-siglus-control-spans", ["siglus.control"], ""),
);

const CORPUS_VALIDATION_ADAPTERS: Readonly<
  Record<CorpusValidationEngineId, AnyCorpusValidationAdapter>
> = {
  reallive: defineCorpusValidationAdapter(realliveCorpusValidationAdapter),
  softpal: defineCorpusValidationAdapter(softpalCorpusValidationAdapter),
  "rpg-maker": defineCorpusValidationAdapter(rpgMakerCorpusValidationAdapter),
  siglus: defineCorpusValidationAdapter(siglusCorpusValidationAdapter),
};

export function registeredCorpusValidationEngines(): CorpusValidationEngineId[] {
  return Object.keys(CORPUS_VALIDATION_ADAPTERS) as CorpusValidationEngineId[];
}

export function isRegisteredCorpusValidationEngine(
  engine: string,
): engine is CorpusValidationEngineId {
  return Object.prototype.hasOwnProperty.call(CORPUS_VALIDATION_ADAPTERS, engine);
}

/** Resolve a required adapter. There is intentionally no default engine. */
export function resolveCorpusValidationAdapter(engine: string): AnyCorpusValidationAdapter {
  if (!isRegisteredCorpusValidationEngine(engine)) {
    throw new Error(
      `private corpus manifest engine '${engine}' is not a registered validation adapter (registered: ${registeredCorpusValidationEngines().join(", ")})`,
    );
  }
  return CORPUS_VALIDATION_ADAPTERS[engine];
}

export function resolveCorpus(
  manifest: CorpusManifest,
  env: NodeJS.ProcessEnv = process.env,
): CorpusResolution {
  return resolveCorpusValidationAdapter(manifest.corpus.engine).resolve(manifest, env);
}

export function assertPinnedCorpusInputs(corpus: ResolvedCorpus, manifest: CorpusManifest): void {
  resolveCorpusValidationAdapter(manifest.corpus.engine).assertPinnedInputs(corpus, manifest);
}

export function extractCorpusValidationArtifacts(
  manifest: CorpusManifest,
  corpus: ResolvedCorpus,
  tempRoot: string,
  nativeEnv: NodeJS.ProcessEnv,
): CorpusValidationArtifacts {
  return resolveCorpusValidationAdapter(manifest.corpus.engine).extract({
    manifest,
    corpus,
    tempRoot,
    nativeEnv,
  });
}

function validateInputMap(inputs: unknown, names: readonly string[]): CorpusInputMap {
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    throw new Error("private corpus manifest inputs must be an object");
  }
  const record = inputs as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(
      "private corpus manifest input keys do not match the engine validation adapter",
    );
  }
  return Object.fromEntries(
    names.map((name) => [
      name,
      validateFingerprint(record[name], `manifest.corpus.inputs.${name}`),
    ]),
  );
}

function validateFingerprint(value: unknown, label: string): FileFingerprint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`private corpus expected an object at ${label}`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(record, "sha256") ||
    !Object.prototype.hasOwnProperty.call(record, "byteLength")
  ) {
    throw new Error(`private corpus manifest shape drift at ${label}`);
  }
  if (typeof record.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(record.sha256)) {
    throw new Error(`private corpus expected a SHA-256 fingerprint at ${label}.sha256`);
  }
  if (!Number.isInteger(record.byteLength) || (record.byteLength as number) <= 0) {
    throw new Error(`private corpus expected a positive byte length at ${label}.byteLength`);
  }
  return { sha256: record.sha256 as Sha256, byteLength: record.byteLength as number };
}

function assertPinnedInputMap(
  corpus: ResolvedCorpus,
  manifest: CorpusManifest,
  names: readonly string[],
): void {
  for (const name of names) {
    const path = corpus.inputPaths[name];
    const expected = manifest.corpus.inputs[name];
    if (path === undefined || expected === undefined || !isRegularFile(path)) {
      throw new Error(
        "private corpus source discovery did not provide its adapter-owned input files",
      );
    }
    const actual = fingerprintCorpusInput(path);
    if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) {
      throw new Error(`private corpus input ${name} does not match the manifest content address`);
    }
  }
}

function findRealliveGameRoots(root: string, maxDepth: number): string[] {
  const candidates: string[] = [];
  let frontier = [root];
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const next: string[] = [];
    for (const candidate of frontier) {
      if (hasRealliveInputLayout(candidate)) {
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

function hasRealliveInputLayout(root: string): boolean {
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

function scopedEvidence(
  engine: string,
  sourceEncoding: string,
  protectedNames: readonly string[],
  outOfBandProtectedName: string,
): CorpusValidationEvidenceConventions {
  return {
    sourceEncoding,
    protectedNames,
    outOfBandProtectedName,
    sourceUnitKey: (sceneId, ordinal) => `${engine}:scene-${sceneId}#${ordinal}`,
    occurrenceId: (sceneId, ordinal) => `scene-${sceneId}-occ-${ordinal}`,
    containerKey: (sceneId) => `${engine}:scene-${sceneId}`,
    entryPath: (sceneId, ordinal) => ["scene", String(sceneId), "units", ordinal],
    route: (sceneId, ordinal) => ({ sceneKey: `scene-${sceneId}`, position: `line-${ordinal}` }),
  };
}
