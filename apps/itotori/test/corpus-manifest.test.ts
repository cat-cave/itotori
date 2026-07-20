// Registered private-corpus manifest contract.
//
// Public CI validates only metadata. The real-byte oracle is opt-in through
// ITOTORI_REAL_CORPUS_ROOT and writes all transient native output to an OS
// temporary directory owned by the validator.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertCorpusEvidenceMatchesManifest,
  assertCorpusManifest,
  assertPinnedCorpusInputs,
  deriveCorpusEvidence,
  fingerprintFile,
  parseCorpusManifestJson,
  registerCorpusManifestJson,
  resolveCorpus,
} from "../src/corpus-manifest/validate.js";
import {
  registeredCorpusValidationEngines,
  resolveCorpusValidationAdapter,
} from "../src/corpus-manifest/corpus-validation-registry.js";
import {
  CorpusManifestRegistry,
  readdressCorpusManifest,
  sha256Bytes,
  stableJson,
  type CorpusManifest,
} from "../src/corpus-manifest/manifest.js";

const MANIFEST_PATH = fileURLToPath(
  new URL("./fixtures/corpus-manifest.private.json", import.meta.url),
);
const EXPECTED_MANIFEST_SHA256 =
  "sha256:61ed4f8abe1327073b39346d72ab6555efc05698c240c84762767740ad24506d";
const EXPECTED_SEEN_SHA256 =
  "sha256:903f538b821a9b1e6cb3d399582915c0bcf73b0a058ecc907caf6017a4fa209f";
const EXPECTED_GAMEEXE_SHA256 =
  "sha256:af0b30ff162e4d4998a1a0b9cce020156c1e9502c1831f52d4749b5f88c9739b";
const EXPECTED_FULL_BRIDGE_SHA256 =
  "sha256:2ae1a5100c371691706fd5726dcf8253810b045cdb84fcd49e2e710e6dfd43b3";
const EXPECTED_FULL_STRUCTURE_SHA256 =
  "sha256:c5f2bfaa88f2f17a8067baa60e83eb6f29c4f30c0f6c4e7ce669a0fdeba271d4";
const EXPECTED_SCOPED_BRIDGE_SHA256 =
  "sha256:5330f41c0ec2f17494ad1e87f654846ee32d6ad146d1c261defdbebbf82f9830";
const EXPECTED_UNITS_SHA256 =
  "sha256:302dc692db2a9c5d0fae1ddf61ce1b84b04161870c770a7d420090870113d031";

function readRegisteredManifest(): CorpusManifest {
  if (!existsSync(MANIFEST_PATH)) throw new Error("registered private corpus manifest is missing");
  const registry = new CorpusManifestRegistry();
  const manifest = registerCorpusManifestJson(registry, readFileSync(MANIFEST_PATH, "utf8"));
  expect(registry.get(manifest.corpus.gameId)).toBe(manifest);
  expect([...registry.values()]).toEqual([manifest]);
  return manifest;
}

const MANIFEST = readRegisteredManifest();
const CORPUS_RESOLUTION = resolveCorpus(MANIFEST);

if (CORPUS_RESOLUTION.kind === "skip") {
  process.stderr.write(`PRIVATE_CORPUS_SKIP: ${CORPUS_RESOLUTION.reason}\n`);
}

function assertReviewedAnchors(manifest: CorpusManifest): void {
  expect(manifest.contentAddress.manifestSha256).toBe(EXPECTED_MANIFEST_SHA256);
  expect(manifest.corpus.inputs.seenTxt.sha256).toBe(EXPECTED_SEEN_SHA256);
  expect(manifest.corpus.inputs.gameexeIni.sha256).toBe(EXPECTED_GAMEEXE_SHA256);
  expect(manifest.corpus.fullGame.kaifuuDecode.bridgeExport.sha256).toBe(
    EXPECTED_FULL_BRIDGE_SHA256,
  );
  expect(manifest.corpus.fullGame.utsushiStructure.structureExport.sha256).toBe(
    EXPECTED_FULL_STRUCTURE_SHA256,
  );
  expect(manifest.outputScope.bridge.bridgeExport.sha256).toBe(EXPECTED_SCOPED_BRIDGE_SHA256);
  expect(manifest.outputScope.bridge.unitsProjectionSha256).toBe(EXPECTED_UNITS_SHA256);
}

describe("registered private corpus manifest", () => {
  it("is metadata-only, content-addressed, and pins the reviewed corpus baseline", () => {
    assertReviewedAnchors(MANIFEST);
    expect(MANIFEST.outputScope.ordinalRange).toEqual({ start: 0, end: 128, width: 4 });
    expect(
      MANIFEST.outputScope.ordinalRange.end - MANIFEST.outputScope.ordinalRange.start + 1,
    ).toBe(129);
    expect(MANIFEST.outputScope.units).toHaveLength(129);
    const scenePrefix = `reallive:scene-${MANIFEST.outputScope.sceneId}`;
    expect(MANIFEST.outputScope.units.map((unit) => unit.sourceUnitKey)).toEqual(
      Array.from(
        { length: 129 },
        (_, ordinal) => `${scenePrefix}#${String(ordinal).padStart(4, "0")}`,
      ),
    );
    expect(MANIFEST.failedRunBaseline).toMatchObject({
      sceneId: MANIFEST.outputScope.sceneId,
      scopedUnitCount: 129,
      physicalAttempts: 762,
      unitsWritten: 57,
      acceptedOutputsDiscarded: 51,
    });
    expect(JSON.stringify(MANIFEST)).not.toContain('"sourceText":');
    expect(JSON.stringify(MANIFEST)).not.toContain('"raw":');
  });

  it("rejects a duplicate JSON key before privacy validation or hashing", () => {
    const dialogue = "\u79d8\u5bc6\u306e\u53f0\u8a5e";
    const raw = `{"outputScope":{"shell":"${dialogue}","sh\\u0065ll":"<REDACTED_TEXT>"}}`;
    let caught: unknown;
    try {
      parseCorpusManifestJson(raw);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toMatch(/duplicate JSON object key/iu);
    expect(String(caught)).not.toContain(dialogue);
  });

  it("validates each registered adapter's owned input map without a RealLive fallback", () => {
    expect(registeredCorpusValidationEngines()).toEqual(["reallive", "softpal", "rpg-maker"]);
    expect(resolveCorpusValidationAdapter("softpal").inputNames).toEqual(["scriptSrc", "textDat"]);
    expect(resolveCorpusValidationAdapter("rpg-maker").inputNames).toEqual(["dataJson"]);

    const softpalManifest = structuredClone(MANIFEST);
    softpalManifest.corpus.engine = "softpal";
    softpalManifest.corpus.inputs = {
      scriptSrc: MANIFEST.corpus.inputs.seenTxt,
      textDat: MANIFEST.corpus.inputs.gameexeIni,
    };
    const conventions = resolveCorpusValidationAdapter("softpal").evidence;
    for (const unit of softpalManifest.outputScope.units) {
      const ordinal = unit.sourceUnitKey.slice(unit.sourceUnitKey.lastIndexOf("#") + 1);
      unit.sourceUnitKey = conventions.sourceUnitKey(unit.sceneMembership.sceneId, ordinal);
      unit.byteLocation.containerKey = conventions.containerKey(unit.sceneMembership.sceneId);
      unit.byteLocation.entryPath = conventions.entryPath(unit.sceneMembership.sceneId, ordinal);
      unit.route = conventions.route(unit.sceneMembership.sceneId, ordinal);
      unit.protectedSkeleton.sourceEncoding = conventions.sourceEncoding;
      for (const part of unit.protectedSkeleton.parts) {
        if (part.kind === "protected_span") {
          part.parsedName = "softpal.control";
          part.outOfBand = false;
        }
      }
      unit.protectedSkeleton.shell = unit.protectedSkeleton.parts
        .map((part) =>
          part.kind === "redacted_text"
            ? `<REDACTED_TEXT:utf8=${part.utf8ByteLength}>`
            : `<PROTECTED:${part.parsedName ?? part.spanKind}:utf8=${part.utf8ByteLength}>`,
        )
        .join("");
    }
    softpalManifest.outputScope.bridge.unitsProjectionSha256 = sha256Bytes(
      stableJson(softpalManifest.outputScope.units),
    );

    const readdressed = readdressCorpusManifest(softpalManifest);
    expect(() => assertCorpusManifest(readdressed)).not.toThrow();
    expect(resolveCorpus(readdressed, {})).toEqual({
      kind: "skip",
      reason: "ITOTORI_REAL_CORPUS_ROOT is unset; no private corpus bytes were read.",
    });
  });

  it("rejects duplicate, missing, payload-bearing, route-mutated, and incomplete ordinal substitutions", () => {
    const duplicate = structuredClone(MANIFEST);
    duplicate.outputScope.units[1]!.bridgeUnitId = duplicate.outputScope.units[0]!.bridgeUnitId;
    expect(() => assertCorpusManifest(readdressCorpusManifest(duplicate))).toThrow(/duplicate/iu);

    const missing = structuredClone(MANIFEST);
    missing.outputScope.units.pop();
    expect(() => assertCorpusManifest(readdressCorpusManifest(missing))).toThrow(
      /length|ordinal/iu,
    );

    const payload = structuredClone(MANIFEST);
    payload.outputScope.units[0]!.protectedSkeleton.shell = "copyright-bearing payload";
    expect(() => assertCorpusManifest(readdressCorpusManifest(payload))).toThrow(/shell/iu);

    const route = structuredClone(MANIFEST);
    route.outputScope.units[0]!.route.position = `line-${String(
      route.outputScope.ordinalRange.end + 1,
    ).padStart(route.outputScope.ordinalRange.width, "0")}`;
    expect(() => assertCorpusManifest(readdressCorpusManifest(route))).toThrow(/route/iu);

    const duplicatedOrdinal = structuredClone(MANIFEST);
    const copiedOrdinal = duplicatedOrdinal.outputScope.units[0]!.sourceUnitKey.slice(-4);
    const duplicateOrdinalUnit = duplicatedOrdinal.outputScope.units[1]!;
    const duplicateSceneId = duplicatedOrdinal.outputScope.sceneId;
    duplicateOrdinalUnit.sourceUnitKey = `reallive:scene-${duplicateSceneId}#${copiedOrdinal}`;
    duplicateOrdinalUnit.occurrenceId = `scene-${duplicateSceneId}-occ-${copiedOrdinal}`;
    duplicateOrdinalUnit.byteLocation.entryPath[1] = String(duplicateSceneId);
    duplicateOrdinalUnit.byteLocation.entryPath[3] = copiedOrdinal;
    duplicateOrdinalUnit.route.position = `line-${copiedOrdinal}`;
    duplicateOrdinalUnit.replayTarget.traceKey = `scene-${duplicateSceneId}-occ-${copiedOrdinal}`;
    expect(() => assertCorpusManifest(readdressCorpusManifest(duplicatedOrdinal))).toThrow(
      /exact complete manifest range/iu,
    );

    const gapped = structuredClone(MANIFEST);
    const unit = gapped.outputScope.units[1]!;
    const extraOrdinal = String(gapped.outputScope.ordinalRange.end + 1).padStart(
      gapped.outputScope.ordinalRange.width,
      "0",
    );
    const sceneId = gapped.outputScope.sceneId;
    unit.sourceUnitKey = `reallive:scene-${sceneId}#${extraOrdinal}`;
    unit.occurrenceId = `scene-${sceneId}-occ-${extraOrdinal}`;
    unit.byteLocation.entryPath[1] = String(sceneId);
    unit.byteLocation.entryPath[3] = extraOrdinal;
    unit.route.position = `line-${extraOrdinal}`;
    unit.replayTarget.traceKey = `scene-${sceneId}-occ-${extraOrdinal}`;
    expect(() => assertCorpusManifest(readdressCorpusManifest(gapped))).toThrow(/ordinal/iu);
  });

  it("rejects a synthetic on-disk corpus before decode without a superficial size floor", () => {
    const root = mkdtempSync(join(tmpdir(), "itotori-corpus-synthetic-"));
    const dataRoot = join(root, "REALLIVEDATA");
    mkdirSync(dataRoot);
    const seenPath = join(dataRoot, "Seen.txt");
    const gameexePath = join(dataRoot, "Gameexe.ini");
    try {
      writeFileSync(seenPath, "not the corpus");
      writeFileSync(gameexePath, "not the corpus");
      expect(() =>
        assertPinnedCorpusInputs(
          { gameRoot: root, inputPaths: { seenTxt: seenPath, gameexeIni: gameexePath } },
          MANIFEST,
        ),
      ).toThrow(/content address/iu);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("removes its temporary root when the source CLI build fails", () => {
    const parent = mkdtempSync(join(tmpdir(), "itotori-corpus-cleanup-"));
    const ownedTempRoot = join(parent, "owned-run");
    mkdirSync(ownedTempRoot);
    try {
      expect(() =>
        deriveCorpusEvidence(
          {
            gameRoot: "/unused",
            inputPaths: { seenTxt: "/unused/Seen.txt", gameexeIni: "/unused/Gameexe.ini" },
          },
          MANIFEST,
          {},
          {
            makeTempRoot: () => ownedTempRoot,
            assertPinnedCorpusInputs: () => {},
            buildSourceCliEnvironment: () => {
              throw new Error("forced source build failure");
            },
          },
        ),
      ).toThrow(/native validation failed|build/i);
      expect(existsSync(ownedTempRoot)).toBe(false);
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it.skipIf(CORPUS_RESOLUTION.kind === "skip")(
    "derives and exactly matches the complete registered 129-unit corpus scope",
    () => {
      if (CORPUS_RESOLUTION.kind !== "ready") throw new Error("private corpus was unavailable");
      const corpus = CORPUS_RESOLUTION.corpus;
      expect(fingerprintFile(corpus.inputPaths.seenTxt!).sha256).toBe(EXPECTED_SEEN_SHA256);
      expect(fingerprintFile(corpus.inputPaths.gameexeIni!).sha256).toBe(EXPECTED_GAMEEXE_SHA256);
      const evidence = deriveCorpusEvidence(corpus, MANIFEST);
      assertCorpusEvidenceMatchesManifest(evidence, MANIFEST);
      process.stdout.write(
        `PRIVATE_CORPUS_MATCH: 129/129 units; manifest=${MANIFEST.contentAddress.manifestSha256}; source-built native CLIs accepted.\n`,
      );
    },
    900_000,
  );
});
