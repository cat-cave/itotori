// Explicit ownership for every app suite that needs a live Postgres database.
// Portable shards must not collect these files; ci-tier1-db runs these exact
// paths with DATABASE_URL and the native artifact supplied by its CI job.

export const DB_OWNED_LANE = "ci-tier1-db";

export const DB_OWNED_APP_PROOFS = Object.freeze([
  {
    proof: "catalog-context-project-scope",
    title: "catalog-context project scope",
    test: "apps/itotori/test/catalog-context-project-scope-live-db.test.ts",
    marker: "catalog-context project scope",
  },
  {
    proof: "workflow-artifact-store",
    title: "workflow artifact store",
    test: "apps/itotori/test/composition-live-store-db.test.ts",
    marker: "live workflow artifact store — real CAS round-trip",
  },
  {
    proof: "context-snapshot-persistence",
    title: "context snapshot persistence",
    test: "apps/itotori/test/context-snapshot-input.test.ts",
    marker: "context snapshot input persistence",
  },
  {
    proof: "database-services-bootstrap",
    title: "database services bootstrap",
    test: "apps/itotori/test/database-services-bootstrap.test.ts",
    marker: "database service bootstrap",
  },
  {
    proof: "human-enhancement",
    title: "human enhancement",
    test: "apps/itotori/test/human-enhancement-live-db.test.ts",
    marker: "policy non-blocking human edit + bounded feedback enhancement",
  },
  {
    proof: "jobs-run-table",
    title: "jobs run table",
    test: "apps/itotori/test/jobs-run-table-live-db.test.ts",
    marker: "jobs run table over persisted provider runs",
  },
  {
    proof: "launch-localization-pass",
    title: "launch localization pass",
    test: "apps/itotori/test/launch-localization-pass-live-db.test.ts",
    marker: "launch localization pass live database",
  },
  {
    proof: "llm-crash-recovery",
    title: "LLM crash recovery",
    test: "apps/itotori/test/llm-crash-recovery-boundaries.test.ts",
    marker: "substrate crash recovery at every physical call boundary",
  },
  {
    proof: "llm-generation-quarantine",
    title: "LLM generation quarantine",
    test: "apps/itotori/test/llm-generation-quarantine-live-db.test.ts",
    marker: "response quarantine and explicit-unknown persistence",
  },
  {
    proof: "llm-physical-attempt-policy",
    title: "LLM physical attempt policy",
    test: "apps/itotori/test/llm-physical-attempt-policy.test.ts",
    marker: "physical attempt policy",
  },
  {
    proof: "memo-fault",
    title: "physical model step durability",
    test: "apps/itotori/test/llm-physical-step-memo.test.ts",
    marker: "physical model step durability",
  },
  {
    proof: "provider-attribution",
    title: "provider attribution",
    test: "apps/itotori/test/llm-provider-attribution-live-db.test.ts",
    marker: "physical provider-attribution ledger",
  },
  {
    proof: "localize-cli-project-scope",
    title: "localize CLI project scope",
    test: "apps/itotori/test/localize-cli-project-scope-live-db.test.ts",
    marker: "localize CLI project-scope provisioning",
  },
  {
    proof: "localize-portfolio-concurrent",
    title: "localize portfolio concurrency",
    test: "apps/itotori/test/localize-portfolio-concurrent-live-db.test.ts",
    marker: "localize portfolio concurrent over Postgres",
  },
  {
    proof: "localize-run-progress",
    title: "localize run progress",
    test: "apps/itotori/test/localize-run-progress-live-db.test.ts",
    marker: "localize run progress over Postgres",
  },
  {
    proof: "production-role-bindings",
    title: "production role bindings",
    test: "apps/itotori/test/production-role-bindings-live-db.test.ts",
    marker: "production Q5 fixture over live Postgres",
  },
  {
    proof: "project-scoped-reads",
    title: "project-scoped reads",
    test: "apps/itotori/test/project-scoped-reads-live-db.test.ts",
    marker: "project-scoped read APIs",
  },
  {
    proof: "project-workflow",
    title: "project workflow",
    test: "apps/itotori/test/project-workflow-live-db.test.ts",
    marker: "database project workflow",
  },
  {
    proof: "retention-scheduler",
    title: "retention scheduler",
    test: "apps/itotori/test/retention-scheduler-live-db.test.ts",
    marker: "server retention scheduler",
  },
  {
    proof: "scoped-invalidation-live",
    title: "scoped invalidation",
    test: "apps/itotori/test/scoped-invalidation-live-db.test.ts",
    marker: "field/claim-scoped invalidation",
  },
  {
    proof: "unit-feedback",
    title: "unit feedback",
    test: "apps/itotori/test/unit-feedback-live-db.test.ts",
    marker: "unit-bound feedback over imported localization units",
  },
  {
    proof: "wiki-dependency-edges",
    title: "Wiki dependency edges",
    test: "apps/itotori/test/wiki-dependency-edges-live-db.test.ts",
    marker: "fine-grained dependency edges resolve exact consumers",
  },
  {
    proof: "wiki-object-api",
    title: "Wiki object API",
    test: "apps/itotori/test/wiki-object-api-live-db.test.ts",
    marker: "wiki object read/write API over the WikiObject substrate",
  },
  {
    proof: "wiki-object-persistence",
    title: "Wiki object persistence",
    test: "apps/itotori/test/wiki-object-persistence-live-db.test.ts",
    marker: "strict WikiObject persistence over real contracts",
  },
  {
    proof: "durable-restart",
    title: "durable restart",
    test: "apps/itotori/test/production-localize-restart-live-db.test.ts",
    marker: "SIGKILLs a production child after P1, then resumes from its durable checkpoint",
  },
  {
    proof: "workflow-memo-model-variant",
    title: "model-variant durable memo",
    test: "apps/itotori/test/workflow-memo-identity-live-db.test.ts",
    marker: "keeps a model-only variant in a distinct durable checkpoint",
  },
  {
    proof: "durable-pause-resume",
    title: "user pause/resume",
    test: "apps/itotori/test/production-localize-pause-live-db.test.ts",
    marker: "pauses live provider work, resumes the same run, and reuses its 0120 checkpoint",
  },
  {
    proof: "patchback-produce-engine-detection",
    title: "source-detected multi-engine patchback",
    test: "apps/itotori/test/patchback-produce-endpoint-engine-detection.test.ts",
    marker: "source-detected multi-engine dashboard patchback",
  },
  {
    proof: "provider-budget-fair-share",
    title: "provider budget fair share",
    test: "apps/itotori/test/production-provider-budget-live-db.test.ts",
    marker: "gives three concurrent runs stored fair shares under the profile cap",
  },
]);

export const DB_OWNED_APP_TEST_FILES = Object.freeze(
  DB_OWNED_APP_PROOFS.map((proof) => proof.test.slice("apps/itotori/".length)),
);

// A deleted entry is as dangerous as a missing invocation: the portable lanes
// would no longer collect it and DB ownership would silently disappear.
export const REQUIRED_DB_OWNED_PROOF_IDS = Object.freeze(
  DB_OWNED_APP_PROOFS.map((proof) => proof.proof),
);
