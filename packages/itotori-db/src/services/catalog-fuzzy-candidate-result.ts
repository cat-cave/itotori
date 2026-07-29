import type { CatalogCandidateMatchRecord } from "../repositories/catalog-repository.js";

import {
  type CatalogFuzzyCandidateDiagnostic,
  catalogFuzzyCandidateGeneratorVersion,
  type CatalogFuzzyCandidateResult,
  catalogFuzzyCandidateSchemaVersion,
  type CatalogFuzzyCandidateStatus,
} from "./catalog-fuzzy-candidate-types.js";

export function result(
  status: CatalogFuzzyCandidateStatus,
  candidates: CatalogCandidateMatchRecord[],
  diagnostics: CatalogFuzzyCandidateDiagnostic[],
): CatalogFuzzyCandidateResult {
  return {
    schemaVersion: catalogFuzzyCandidateSchemaVersion,
    generatorVersion: catalogFuzzyCandidateGeneratorVersion,
    status,
    candidates,
    diagnostics,
  };
}
