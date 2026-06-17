export const helloFixturePath = "fixtures/hello-game/source.json";

export const helloFixturePublicManifestPath = "fixtures/public/hello-game.manifest.json";

export const helloFixtureExpectedArtifactPaths = {
  bridgeV01: "fixtures/hello-game/expected/bridge-v0.1.json",
  bridgeV02: "fixtures/hello-game/expected/bridge-v0.2.json",
  patchExportFrFrV02: "fixtures/hello-game/expected/patch-export-v0.2.fr-FR.json",
  patchResultFrFrV02: "fixtures/hello-game/expected/patch-result-v0.2.fr-FR.json",
  deltaPackageFrFrV02: "fixtures/hello-game/expected/delta-package-v0.2.fr-FR.json",
  runtimeReportFrFrV02: "fixtures/hello-game/expected/runtime-report-v0.2.fr-FR.json",
  benchmarkReportFrFrV02: "fixtures/hello-game/expected/benchmark-report-v0.2.fr-FR.json",
  findingFrFrV02: "fixtures/hello-game/expected/finding-v0.2.fr-FR.json",
  surfaceCoverageV02: "fixtures/hello-game/surface-coverage-v0.2.json",
} as const;
