// Explicit ownership for tests that require private corpora, a live provider,
// or a private browser runtime. Public configurations exclude these files only
// because a named evidence runner invokes their exact bodies and rejects skips.

const appRoot = "apps/itotori/";

function appVitest(file, runner) {
  return Object.freeze({
    file: `${appRoot}test/live-evidence/${file}`,
    framework: "vitest",
    runner,
  });
}

function appPlaywright(file) {
  return Object.freeze({
    file: `${appRoot}e2e/live-evidence/${file}`,
    framework: "playwright",
    runner: "browser-real-bytes",
  });
}

export const LIVE_EVIDENCE_RUNNERS = Object.freeze([
  "real-bytes",
  "model-profile",
  "browser-real-bytes",
]);

export const liveEvidenceSuites = Object.freeze([
  appVitest("corpus-manifest-real-bytes.test.ts", "real-bytes"),
  appVitest("fact-snapshot-real-bytes.test.ts", "real-bytes"),
  appVitest("rpgmaker-production-real-bytes.test.ts", "real-bytes"),
  appVitest("in-studio-decode-extract-real-bytes.test.ts", "real-bytes"),
  appVitest("kaifuu-extract-seam-real-bytes.test.ts", "real-bytes"),
  appVitest("patch-validate-cli-real-bytes.test.ts", "real-bytes"),
  appVitest("patchback-produce-endpoint-real-bytes.test.ts", "real-bytes"),
  appVitest("patchback-produce-build-real-bytes.test.ts", "real-bytes"),
  appVitest("patchback-real-bytes.test.ts", "real-bytes"),
  appVitest("wiki-media-index-real-bytes.test.ts", "real-bytes"),
  appVitest("llm-dispatch-live.test.ts", "model-profile"),
  appVitest("llm-model-profile-live.test.ts", "model-profile"),
  appPlaywright("browser-player-progress.e2e.ts"),
  appPlaywright("browser-player-softpal.e2e.ts"),
]);

export const appLiveEvidenceVitestFiles = Object.freeze(
  liveEvidenceSuites
    .filter((suite) => suite.framework === "vitest")
    .map((suite) => suite.file.slice(appRoot.length)),
);

export const appLiveEvidencePlaywrightFiles = Object.freeze(
  liveEvidenceSuites
    .filter((suite) => suite.framework === "playwright")
    .map((suite) => suite.file.slice(appRoot.length)),
);

export const appLiveEvidencePlaywrightTestPaths = Object.freeze(
  appLiveEvidencePlaywrightFiles.map((file) => file.slice("e2e/".length)),
);

export function publicAppVitestExclusionArguments() {
  return appLiveEvidenceVitestFiles.flatMap((file) => ["--exclude", file]);
}

export function suitesForLiveEvidenceRunner(runner) {
  if (!LIVE_EVIDENCE_RUNNERS.includes(runner)) {
    throw new Error(`unknown live evidence runner ${JSON.stringify(runner)}`);
  }
  return liveEvidenceSuites.filter((suite) => suite.runner === runner);
}

export function isManifestOwnedLiveEvidenceFile(file) {
  return liveEvidenceSuites.some((suite) => suite.file === file);
}
