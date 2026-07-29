import type { AuthorizationActor } from "../authorization.js";
import type {
  CatalogCandidateMatchRecord,
  CatalogCandidateTargetWorkRecord,
  ItotoriCatalogRepositoryPort,
} from "../repositories/catalog-repository.js";
import {
  catalogCandidateMatchStatusValues,
  catalogExternalIdKindValues,
  catalogSourceValues,
  type CatalogExternalIdKind,
  type CatalogSource,
} from "../schema.js";

import {
  type CatalogFuzzyCandidateDiagnostic,
  catalogFuzzyCandidateGeneratorVersion,
  type CatalogFuzzyCandidateResult,
  catalogFuzzyCandidateSchemaVersion,
  type CatalogFuzzyCandidateStatus,
} from "./catalog-fuzzy-candidate-generator-01.js";

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
