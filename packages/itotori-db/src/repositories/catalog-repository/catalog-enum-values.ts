import {
  catalogExternalIdKindValues,
  catalogLanguageStatusScopeValues,
  catalogLanguageStatusValues,
  catalogSourceValues,
  type CatalogExternalIdKind,
  type CatalogLanguageStatus,
  type CatalogLanguageStatusScope,
  type CatalogSource,
} from "../../schema.js";

/** Shared runtime projections of the catalog enums used for input validation. */
export const catalogSources = Object.values(catalogSourceValues) as CatalogSource[];
export const catalogExternalIdKinds = Object.values(
  catalogExternalIdKindValues,
) as CatalogExternalIdKind[];
export const catalogLanguageStatuses = Object.values(
  catalogLanguageStatusValues,
) as CatalogLanguageStatus[];
export const catalogLanguageStatusScopes = Object.values(
  catalogLanguageStatusScopeValues,
) as CatalogLanguageStatusScope[];
