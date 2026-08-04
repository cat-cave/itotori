import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  assertCorpusEvidenceMatchesManifest,
  deriveCorpusEvidence,
  fingerprintFile,
  registerCorpusManifestJson,
  resolveCorpus,
} from "../../src/corpus-manifest/validate.js";
import { CorpusManifestRegistry } from "../../src/corpus-manifest/manifest.js";

const manifestPath = fileURLToPath(
  new URL("../fixtures/corpus-manifest.private.json", import.meta.url),
);
const expectedSeenSha256 =
  "sha256:903f538b821a9b1e6cb3d399582915c0bcf73b0a058ecc907caf6017a4fa209f";
const expectedGameexeSha256 =
  "sha256:af0b30ff162e4d4998a1a0b9cce020156c1e9502c1831f52d4749b5f88c9739b";

function registeredManifest() {
  if (!existsSync(manifestPath)) throw new Error("registered private corpus manifest is missing");
  const registry = new CorpusManifestRegistry();
  const manifest = registerCorpusManifestJson(registry, readFileSync(manifestPath, "utf8"));
  expect(registry.get(manifest.corpus.gameId)).toBe(manifest);
  expect([...registry.values()]).toEqual([manifest]);
  return manifest;
}

describe("registered private corpus manifest real-byte proof", () => {
  it("derives and exactly matches the complete registered 129-unit corpus scope", () => {
    const manifest = registeredManifest();
    const resolution = resolveCorpus(manifest);
    if (resolution.kind !== "ready") {
      throw new Error(
        `corpus-manifest real-byte proof requires the selected private corpus: ${resolution.reason}`,
      );
    }
    const corpus = resolution.corpus;
    expect(fingerprintFile(corpus.inputPaths.seenTxt!).sha256).toBe(expectedSeenSha256);
    expect(fingerprintFile(corpus.inputPaths.gameexeIni!).sha256).toBe(expectedGameexeSha256);
    const evidence = deriveCorpusEvidence(corpus, manifest);
    assertCorpusEvidenceMatchesManifest(evidence, manifest);
    process.stdout.write(
      `PRIVATE_CORPUS_MATCH: 129/129 units; manifest=${manifest.contentAddress.manifestSha256}; source-built native CLIs accepted.\n`,
    );
  }, 900_000);
});
