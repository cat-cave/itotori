// RB-001 — Sweetie HD ground-truth corpus manifest.
//
// This is deliberately an opt-in private-byte oracle. Public CI still loads
// the manifest-shape tests below, but the native decode/structure comparison is
// skipped with a loud marker unless ITOTORI_RB001_REAL_SWEETIE_ROOT is set.
// The real bridge and structure JSON are written only to an OS temp directory
// by the helper and removed before this test returns.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertPinnedSweetieRb001Inputs,
  assertSweetieRb001EvidenceMatchesManifest,
  assertSweetieRb001Manifest,
  createSweetieRb001Manifest,
  deriveSweetieRb001Evidence,
  fingerprintFile,
  resolveSweetieRb001Corpus,
  type SweetieRb001Manifest,
} from "../src/corpus-manifest/sweetie-hd-rb-001.js";

const MANIFEST_PATH = fileURLToPath(
  new URL("./fixtures/sweetie-hd-rb-001.private-corpus-manifest.json", import.meta.url),
);
const CORPUS_RESOLUTION = resolveSweetieRb001Corpus();

// These anchors intentionally live outside the manifest's self-addressing
// envelope. A deliberate re-baseline of the owned corpus must change reviewed
// code as well as the metadata fixture; a synthetic stand-in cannot update its
// own manifest hash and call itself ground truth.
const EXPECTED_SEEN_SHA256 =
  "sha256:903f538b821a9b1e6cb3d399582915c0bcf73b0a058ecc907caf6017a4fa209f";
const EXPECTED_GAMEEXE_SHA256 =
  "sha256:af0b30ff162e4d4998a1a0b9cce020156c1e9502c1831f52d4749b5f88c9739b";
const EXPECTED_MANIFEST_SHA256 =
  "sha256:b2257ac1abbee13bfe99b7289d283d21a1371c2323663b426913f8472de1ef7d";
const EXPECTED_FULL_BRIDGE_SHA256 =
  "sha256:2ae1a5100c371691706fd5726dcf8253810b045cdb84fcd49e2e710e6dfd43b3";
const EXPECTED_FULL_STRUCTURE_SHA256 =
  "sha256:6ae7fb5df8f92fbc608120eaed589c07bb2e33900e131ceebe0e753b4098e75c";
const EXPECTED_SCENE1017_BRIDGE_SHA256 =
  "sha256:5330f41c0ec2f17494ad1e87f654846ee32d6ad146d1c261defdbebbf82f9830";
const EXPECTED_SCENE1017_UNITS_SHA256 =
  "sha256:b3bf43c360cbfd5e4c4a813658cfd71f0a42910530d0be7cf94e72d4a3b51218";

const BASELINE: SweetieRb001Manifest["failedRunBaseline"] = {
  source: "bridge-rerun-completion-report-2026-07-14",
  reportSha256: "sha256:6735ac9cea5c14edd95613fcc1e274f7c0338495c310c0482d1039250511690e",
  runId: "localization-journal-run-46ae0c28-3578-43f7-b51a-b4cffc340c51",
  sceneId: 1017,
  scopedUnitCount: 129,
  physicalAttempts: 762,
  unitsWritten: 57,
  finalizedPatchCount: 0,
  acceptedOutputsDiscarded: 51,
  retranslatedUnitCount: 27,
  failureMode: "sys-1-unit-pipeline-restarts-discard-accepted-work",
};

if (CORPUS_RESOLUTION.kind === "skip") {
  // Intentional public-CI signal: a green result here means the metadata
  // contract was checked, while the private-byte proof was not attempted.
  process.stderr.write(`RB001_PRIVATE_CORPUS_SKIP: ${CORPUS_RESOLUTION.reason}\n`);
}

function readManifest(): SweetieRb001Manifest {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      `RB-001 committed manifest missing at ${MANIFEST_PATH}; regenerate only from the owned corpus`,
    );
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
  assertSweetieRb001Manifest(manifest);
  assertReviewedManifestAnchors(manifest);
  return manifest;
}

/**
 * A fixture cannot bless itself by recomputing its own content address. These
 * independently reviewed anchors make a rebaseline an intentional code+data
 * review, including when the private corpus is unavailable in public CI.
 */
function assertReviewedManifestAnchors(manifest: SweetieRb001Manifest): void {
  const anchors: Array<[actual: string, expected: string, label: string]> = [
    [manifest.contentAddress.manifestSha256, EXPECTED_MANIFEST_SHA256, "manifest"],
    [manifest.corpus.inputs.seenTxt.sha256, EXPECTED_SEEN_SHA256, "Seen.txt"],
    [manifest.corpus.inputs.gameexeIni.sha256, EXPECTED_GAMEEXE_SHA256, "Gameexe.ini"],
    [
      manifest.corpus.fullGame.kaifuuDecode.bridgeExport.sha256,
      EXPECTED_FULL_BRIDGE_SHA256,
      "full-game kaifuu bridge",
    ],
    [
      manifest.corpus.fullGame.utsushiStructure.structureExport.sha256,
      EXPECTED_FULL_STRUCTURE_SHA256,
      "full-game utsushi structure",
    ],
    [
      manifest.outputScope.bridge.bridgeExport.sha256,
      EXPECTED_SCENE1017_BRIDGE_SHA256,
      "scene-1017 kaifuu bridge",
    ],
    [
      manifest.outputScope.bridge.unitsProjectionSha256,
      EXPECTED_SCENE1017_UNITS_SHA256,
      "scene-1017 129-unit projection",
    ],
  ];
  for (const [actual, expected, label] of anchors) {
    if (actual !== expected) {
      throw new Error(
        `RB-001 reviewed ${label} anchor drifted; rebaseline requires reviewed code and fixture updates`,
      );
    }
  }
}

/** Rehash a deliberate in-memory mutation so shape/privacy checks are real. */
function readdress(manifest: SweetieRb001Manifest): SweetieRb001Manifest {
  return createSweetieRb001Manifest(
    {
      corpus: manifest.corpus,
      outputScope: manifest.outputScope,
    },
    manifest.failedRunBaseline,
  );
}

describe("RB-001 Sweetie HD private corpus manifest", () => {
  it("is metadata-only, content-addressed, complete, and pins the 762/57 failure baseline", () => {
    const manifest = readManifest();
    expect(manifest.outputScope.units).toHaveLength(129);
    expect(manifest.outputScope.bridge.uniqueBridgeUnitIdCount).toBe(129);
    expect(manifest.outputScope.bridge.uniqueSourceHashCount).toBe(129);
    expect(manifest.failedRunBaseline).toEqual(BASELINE);
    expect(manifest.contentAddress.manifestSha256).toBe(EXPECTED_MANIFEST_SHA256);
    expect(JSON.stringify(manifest)).not.toContain('sourceText":');
    expect(JSON.stringify(manifest)).not.toContain('"raw":');
  });

  it("rejects self-consistently rehashed duplicate, missing, and payload-bearing substitutions", () => {
    const duplicate = structuredClone(readManifest());
    duplicate.outputScope.units[1]!.bridgeUnitId = duplicate.outputScope.units[0]!.bridgeUnitId;
    expect(() => assertSweetieRb001Manifest(readdress(duplicate))).toThrow(/duplicate/iu);

    const missing = structuredClone(readManifest());
    missing.outputScope.units.pop();
    expect(() => assertSweetieRb001Manifest(readdress(missing))).toThrow(/129|missing/iu);

    const payloadBearing = structuredClone(readManifest());
    payloadBearing.outputScope.units[0]!.protectedSkeleton.shell =
      "copyright-bearing ASCII payload hidden in a shell field";
    expect(() => assertSweetieRb001Manifest(readdress(payloadBearing))).toThrow(/shell/iu);

    const syntheticRoute = structuredClone(readManifest());
    syntheticRoute.outputScope.units[0]!.route.position = "line-9999";
    expect(() => assertSweetieRb001Manifest(readdress(syntheticRoute))).toThrow(/route position/iu);
  });

  it("rejects a synthetic on-disk corpus stand-in before any decode", () => {
    const syntheticRoot = mkdtempSync(join(tmpdir(), "itotori-rb001-synthetic-"));
    const dataRoot = join(syntheticRoot, "REALLIVEDATA");
    mkdirSync(dataRoot);
    const seenPath = join(dataRoot, "Seen.txt");
    const gameexePath = join(dataRoot, "Gameexe.ini");
    try {
      // Deliberately meets the coarse byte-size floor: content pins, not a
      // superficial size check, must reject a fabricated corpus.
      writeFileSync(seenPath, Buffer.alloc(1_000_000, 0x53));
      writeFileSync(gameexePath, Buffer.alloc(10_000, 0x47));
      expect(() =>
        assertPinnedSweetieRb001Inputs(
          { gameRoot: syntheticRoot, seenPath, gameexePath },
          readManifest(),
        ),
      ).toThrow(/pinned content address|synthetic/iu);
    } finally {
      rmSync(syntheticRoot, { force: true, recursive: true });
    }
  });

  it.skipIf(CORPUS_RESOLUTION.kind === "skip")(
    "derives real decode/structure and exactly matches all 129 scene-1017 units",
    () => {
      if (CORPUS_RESOLUTION.kind !== "ready") {
        throw new Error("RB-001 gated test reached an unavailable private corpus branch");
      }
      const corpus = CORPUS_RESOLUTION.corpus;
      const seenFingerprint = fingerprintFile(corpus.seenPath);
      const gameexeFingerprint = fingerprintFile(corpus.gameexePath);
      expect(seenFingerprint.sha256).toBe(EXPECTED_SEEN_SHA256);
      expect(gameexeFingerprint.sha256).toBe(EXPECTED_GAMEEXE_SHA256);

      const manifest = readManifest();
      assertPinnedSweetieRb001Inputs(corpus, manifest);
      const evidence = deriveSweetieRb001Evidence(corpus);
      assertSweetieRb001EvidenceMatchesManifest(evidence, manifest);
      expect(manifest.outputScope.units).toHaveLength(129);
      expect(manifest.outputScope.units.map((unit) => unit.bridgeUnitId)).toHaveLength(129);
      expect(new Set(manifest.outputScope.units.map((unit) => unit.bridgeUnitId)).size).toBe(129);
      expect(new Set(manifest.outputScope.units.map((unit) => unit.sourceHash)).size).toBe(129);
      process.stdout.write(
        `RB001_PRIVATE_CORPUS_MATCH: 129/129 real scene-1017 units; manifest=${manifest.contentAddress.manifestSha256}; trusted source-built CLIs and pinned inputs accepted.\n`,
      );
    },
    900_000,
  );
});
