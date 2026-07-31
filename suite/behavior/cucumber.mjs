export default {
  paths: [".tmp/behavior-proof/features/selected.feature"],
  import: [
    ".tmp/behavior-proof/glue/support/world.js",
    ".tmp/behavior-proof/glue/steps/behavior.js",
  ],
  format: [
    "message:.tmp/behavior-proof/cucumber/public-ts-1of1.ndjson",
    "junit:.tmp/behavior-proof/cucumber/public-ts-1of1.xml",
  ],
  worldParameters: {
    planPath: ".tmp/behavior-proof/selection-plan.json",
    resultsPath: ".tmp/behavior-proof/case-results.jsonl",
    repositoryRoot: ".",
  },
  strict: true,
  retry: 0,
  failFast: false,
  publish: false,
  order: "defined",
  parallel: 0,
};
