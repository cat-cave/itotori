// Compatibility exports for consumers of the discovered per-test ownership
// declarations. This module deliberately stores no DB-test registry.

import {
  DB_OWNED_LANE,
  dbOwnedAppProofs,
  dbOwnedAppTestFiles,
  discoverTestOwnership,
} from "./test-ownership.mjs";

const ownership = discoverTestOwnership();

export { DB_OWNED_LANE };
export const DB_OWNED_APP_PROOFS = dbOwnedAppProofs(ownership);
export const DB_OWNED_APP_TEST_FILES = dbOwnedAppTestFiles(ownership);
