// Test files run outside Vitest by the DB package runner. Keep this manifest
// importable so the collection guard can verify the runner-owned suites too.
export const databaseRunnerNodeTestFiles = [
  "scripts/verify-permission-constraints.test.mjs",
  "scripts/verify-event-queue-index-alignment.test.mjs",
];
