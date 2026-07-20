import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import {
  AcceptanceScorecardDefinitionSchema,
  HumanCalibrationLabelSetSchema,
  type AcceptanceScorecardDefinition,
  type HumanCalibrationLabelSet,
} from "../../src/contracts/index.js";
import { parseStrictJson } from "../../src/corpus-manifest/json.js";
import {
  corpusManifestContentHash,
  sha256Bytes,
  stableJson,
  type CorpusManifest,
  type Sha256,
} from "../../src/corpus-manifest/manifest.js";
import { parseCorpusManifestJson } from "../../src/corpus-manifest/validate.js";

export const PINNED_SCORECARD_SHA256 =
  "sha256:8cdb6ba2a728a32cf65607a2ffe39c590c1ef45cbf68a24bc414f05d352b9c3a";
export const PINNED_HUMAN_CALIBRATION_SHA256 =
  "sha256:fbdd6082be5046bb038de9dbf4b4161f786f12be2fe09d31e4ddec1d17b5bfeb";
export const PINNED_CORPUS_MANIFEST_SHA256 =
  "sha256:61ed4f8abe1327073b39346d72ab6555efc05698c240c84762767740ad24506d";

const SCORECARD_PATH = fileURLToPath(new URL("./acceptance-scorecard.v1.json", import.meta.url));
const LABELS_PATH = fileURLToPath(new URL("./human-calibration-labels.v1.json", import.meta.url));
const CORPUS_PATH = fileURLToPath(
  new URL("../fixtures/corpus-manifest.private.json", import.meta.url),
);

type AddressedArtifact = {
  contentAddress: {
    algorithm: "sha256";
    canonicalization: "json-key-sort-v1";
    sha256: string;
  };
};

export type PinnedAcceptanceArtifacts = {
  definition: AcceptanceScorecardDefinition;
  labels: HumanCalibrationLabelSet;
  corpus: CorpusManifest;
};

export function addressedArtifactHash(artifact: AddressedArtifact): Sha256 {
  const { sha256: _ignored, ...contentAddress } = artifact.contentAddress;
  return sha256Bytes(stableJson({ ...artifact, contentAddress }));
}

export function assertPinnedContentAddress(
  artifact: AddressedArtifact,
  expectedHash: Sha256,
): void {
  const actualHash = addressedArtifactHash(artifact);
  if (artifact.contentAddress.sha256 !== actualHash) {
    throw new Error("addressed scorecard artifact does not match its content hash");
  }
  if (actualHash !== expectedHash) {
    throw new Error("addressed scorecard artifact drifted from its reviewed pin");
  }
}

function readStrictArtifact<T>(path: string, schema: z.ZodType<T>): T {
  return schema.parse(parseStrictJson(readFileSync(path, "utf8")));
}

export function loadPinnedAcceptanceArtifacts(): PinnedAcceptanceArtifacts {
  const definition = readStrictArtifact(SCORECARD_PATH, AcceptanceScorecardDefinitionSchema);
  const labels = readStrictArtifact(LABELS_PATH, HumanCalibrationLabelSetSchema);
  const corpus = parseCorpusManifestJson(readFileSync(CORPUS_PATH, "utf8"));

  assertPinnedContentAddress(definition, PINNED_SCORECARD_SHA256);
  assertPinnedContentAddress(labels, PINNED_HUMAN_CALIBRATION_SHA256);
  if (
    corpus.contentAddress.manifestSha256 !== PINNED_CORPUS_MANIFEST_SHA256 ||
    corpusManifestContentHash(corpus) !== PINNED_CORPUS_MANIFEST_SHA256
  ) {
    throw new Error("scorecard corpus manifest drifted from its reviewed pin");
  }
  if (
    definition.corpus.manifestSha256 !== PINNED_CORPUS_MANIFEST_SHA256 ||
    definition.corpus.unitsProjectionSha256 !== corpus.outputScope.bridge.unitsProjectionSha256 ||
    definition.humanCalibration.labelsSha256 !== PINNED_HUMAN_CALIBRATION_SHA256 ||
    labels.corpusManifestSha256 !== PINNED_CORPUS_MANIFEST_SHA256
  ) {
    throw new Error("scorecard artifacts do not address the same frozen evidence set");
  }

  const units = new Map(
    corpus.outputScope.units.map((unit) => [unit.bridgeUnitId, unit.sourceHash]),
  );
  const labelIds = new Set<string>();
  const candidateHashes = new Set<string>();
  for (const label of labels.labels) {
    if (labelIds.has(label.labelId) || candidateHashes.has(label.candidate.hash)) {
      throw new Error("human calibration labels must be uniquely addressed");
    }
    labelIds.add(label.labelId);
    candidateHashes.add(label.candidate.hash);
    if (units.get(label.unit.id) !== label.unit.hash) {
      throw new Error("human calibration label is outside the frozen corpus scope");
    }
  }

  const requiredRubrics = new Set(definition.humanCalibration.requiredRubrics);
  for (const stratum of ["high-risk", "representative-clean"] as const) {
    const present = new Set(
      labels.labels.filter((label) => label.stratum === stratum).map((label) => label.rubric),
    );
    if ([...requiredRubrics].some((rubric) => !present.has(rubric))) {
      throw new Error("human calibration labels do not cover every required rubric and stratum");
    }
  }
  const highRiskCount = labels.labels.filter((label) => label.stratum === "high-risk").length;
  const cleanUnitCount = new Set(
    labels.labels
      .filter((label) => label.stratum === "representative-clean")
      .map((label) => label.unit.id),
  ).size;
  if (
    highRiskCount < definition.humanCalibration.minimumHighRiskLabels ||
    cleanUnitCount < definition.humanCalibration.minimumRepresentativeCleanUnits
  ) {
    throw new Error("human calibration label strata are below the pinned minimum");
  }

  return { definition, labels, corpus };
}
