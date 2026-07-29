import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");

export const MATRIX_SCHEMA_VERSION = "itotori.engine_capability_matrix.v0.1";
export const GENERATOR_PATH = "scripts/generate-engine-capability-matrix.mjs";

export const CAPABILITY_LEVELS = ["identify", "inventory", "extract", "patch", "helper", "runtime"];
export const LEVEL_STATUSES = ["supported", "partial", "unsupported", "not_applicable", "unknown"];
export const EVIDENCE_POSTURES = ["positive_adapter", "readiness_only"];

// Input categories the acceptance requires the matrix to consume. Matched only
// against evidence.category — never against evidence.kind (distinct namespaces).
export const REQUIRED_INPUT_CATEGORIES = [
  "fixture_output",
  "readiness_profile",
  "claimed_support_tuples",
  "validation_artifact",
];

// Input kinds the acceptance requires at least one row to consume. Matched only
// against evidence.kind — never against evidence.category.
export const REQUIRED_INPUT_KINDS = ["adapter_registry"];

export const OUTPUT_JSON_PATH =
  "apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json";
export const OUTPUT_MD_PATH = "apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.md";

// Input source registry. Each entry is a REAL artifact already in the repo (or
// a committed readiness fixture). `category` ties it to one of the acceptance
// input categories; `kind` drives mechanical posture classification.
export const INPUT_SOURCES = [
  {
    id: "reallive-detector-capabilities",
    path: "fixtures/public/reallive-detector/capabilities.json",
    category: "claimed_support_tuples",
    kind: "adapter_registry",
    role: "adapter registry mirror / per-capability claimed-support tuples",
  },
  {
    id: "xp3-plain-detector-profile",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/xp3-plain-detector-profile-v0.1.json",
    category: "fixture_output",
    kind: "detector_profile",
    role: "KiriKiri XP3 plain-container detector profile",
  },
  {
    id: "xp3-compressed-detector-profile",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/xp3-compressed-detector-profile-v0.1.json",
    category: "fixture_output",
    kind: "detector_profile",
    role: "KiriKiri XP3 compressed-container detector profile",
  },
  {
    id: "xp3-encrypted-detector-profile",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/xp3-encrypted-detector-profile-v0.1.json",
    category: "fixture_output",
    kind: "detector_profile",
    role: "KiriKiri XP3 encrypted-container (crypt smoke) detector profile",
  },
  {
    id: "siglus-detector-profile",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-detector-profile-v0.1.json",
    category: "fixture_output",
    kind: "detector_profile",
    role: "Siglus Scene.pck/Gameexe.dat detector profile",
  },
  {
    id: "siglus-known-key-parser-boundary-smoke",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/siglus-parser-boundary-smoke-v0.1.json",
    category: "validation_artifact",
    kind: "validation_artifact",
    role: "Siglus known-key Scene/Gameexe parser-boundary smoke run",
  },
  {
    id: "rpg-maker-mv-mz-key-validation",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/rpg-maker-mv-mz-key-validation-success-v0.1.json",
    category: "validation_artifact",
    kind: "validation_artifact",
    role: "RPG Maker MV/MZ encrypted-media key validation run",
  },
  {
    id: "rpg-maker-mv-mz-readiness-merge",
    path: "fixtures/public/catalog-capability-evidence-mv-mz-merge/expected/readiness-merge-v0.1.json",
    category: "readiness_profile",
    kind: "readiness_profile",
    role: "RPG Maker MV/MZ readiness merge matrix",
  },
  {
    id: "production-extract-patch-proofs",
    path: "fixtures/kaifuu/production-capabilities/extract-patch-proofs.v0.1.json",
    category: "claimed_support_tuples",
    kind: "production_capability_tuple",
    role: "production extract/patch tuples bound to strict real-byte proof lanes",
  },
  {
    id: "reallive-patchback-produce",
    path: "fixtures/public/itotori-patchback-produce/expected/reallive-patchback-produce-capability-v0.1.json",
    category: "validation_artifact",
    kind: "validation_artifact",
    role: "RealLive accepted-output-native patched-build production (Studio download + itotori patch produce)",
  },
  {
    id: "rpg-maker-mv-mz-encrypted-suffixes-detection",
    path: "fixtures/public/kaifuu-rpg-maker-encrypted-suffixes/expected/detection-report-v0.1.json",
    category: "fixture_output",
    kind: "detection_report",
    role: "RPG Maker MV/MZ full encrypted-suffix surface detection run",
  },
  {
    id: "encrypted-matrix-detection-summary",
    path: "fixtures/public/kaifuu-encrypted-matrix/expected/detection-summary-v0.1.json",
    category: "readiness_profile",
    kind: "detection_summary",
    role: "Packed/encrypted engine-family detection summary (Wolf, BGI, ...)",
  },
  {
    id: "tyranoscript-null-key-readiness",
    path: "fixtures/kaifuu/tyranoscript/null-key-readiness-profile.json",
    category: "readiness_profile",
    kind: "detector_profile",
    role: "TyranoScript plaintext null-key readiness profile",
  },
];

// Engine families that are deliberately NOT presented as alpha Japanese
// localization-opportunity drivers. Recorded as explicit, evidence-anchored
// exclusions so the matrix can never silently over-weight them.
export const NON_DRIVER_EXCLUSIONS = [
  {
    engineFamily: "renpy",
    reason:
      "Ren'Py is not an alpha Japanese-localization opportunity driver: it is over-represented in catalog data by Western/English doujin output and already has high existing translation coverage. Per docs/research/japanese-engine-opportunity-analysis.md it is the easy, already-done reference engine, not a greenfield Japanese driver. It surfaces only as a packed-input detector row and is excluded from the capability breadth.",
    evidenceSourceIds: ["rpg-maker-mv-mz-encrypted-suffixes-detection"],
  },
  {
    engineFamily: "unknown",
    reason:
      "The unknown-archive-variant row is a non-engine triage bucket, not an engine family, and carries no capability claim.",
    evidenceSourceIds: ["encrypted-matrix-detection-summary"],
  },
];

export class MatrixGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MatrixGenerationError";
  }
}

export function loadInputs(root = repoRoot) {
  const inputs = {};
  for (const source of INPUT_SOURCES) {
    const absolute = resolve(root, source.path);
    let raw;
    try {
      raw = readFileSync(absolute, "utf8");
    } catch (error) {
      throw new MatrixGenerationError(
        `missing input artifact "${source.id}" at ${source.path}: ${
          error?.code ?? error?.message ?? "unreadable"
        }`,
      );
    }
    try {
      inputs[source.id] = JSON.parse(raw);
    } catch (error) {
      throw new MatrixGenerationError(
        `input artifact "${source.id}" at ${source.path} is not valid JSON: ${error?.message}`,
      );
    }
  }
  return inputs;
}
