import { foundationMigrationEntries } from "./migration-entries-foundation.js";
import { productMigrationEntries } from "./migration-entries-product.js";

export const migrations = [...foundationMigrationEntries, ...productMigrationEntries] as const;
