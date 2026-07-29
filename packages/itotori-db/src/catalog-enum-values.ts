import {
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogSourceValues,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogSource,
} from "./schema.js";

/** Shared runtime projections of catalog enums used for input validation. */
export const catalogSources: CatalogSource[] = Object.values(catalogSourceValues);
export const catalogExternalIdKinds: CatalogExternalIdKind[] = Object.values(
  catalogExternalIdKindValues,
);
export const catalogLanguageStatuses: CatalogLanguageStatus[] = Object.values(
  catalogLanguageStatusValues,
);
export const catalogLanguageStatusScopes: CatalogLanguageStatusScope[] = Object.values(
  catalogLanguageStatusScopeValues,
);
