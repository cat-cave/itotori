// p0-core-result-revision-hitl — durable child-patch receipt/provenance tests.
//
// These exercise the production materializer directly with Kaifuu's public
// RealLive fixture. In particular, a second child consumes the first child's
// nested receipt, rather than only accepting the original flat apply receipt.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashLocalizationArtifact } from "@itotori/db";
import { describe, expect, it } from "vitest";
import { runKaifuuRealliveExtract } from "../src/extract/kaifuu-extract-seam.js";
import { applyKaifuuRealLivePatch } from "../src/orchestrator/patch-apply-seam.js";
import { bracketWrapForRealLive } from "../src/orchestrator/localize-project-stage-command.js";
import { ProductionPlayTesterPatchArtifactMaterializer } from "../src/play/production-patch-revision-materializer.js";

const fixtureRoot = fileURLToPath(
  new URL("../../../crates/kaifuu-reallive/tests/fixtures/bridge-inventory-001/", import.meta.url),
);

describe("ProductionPlayTesterPatchArtifactMaterializer", () => {
  it("chains a child receipt and gives unsafe external ids distinct owned roots", async () => {
    const parent = createProductionParentArtifacts();
    const materializer = new ProductionPlayTesterPatchArtifactMaterializer();
    let first: Awaited<ReturnType<typeof materializer.materialize>> | undefined;
    let second: Awaited<ReturnType<typeof materializer.materialize>> | undefined;
    const firstPatchVersionId = "patch-version:parent:play-tester/a?first";
    const secondPatchVersionId = "patch-version:parent:play-tester:a/b?second";
    try {
      first = await materializer.materialize({
        childPatchVersionId: firstPatchVersionId,
        parentPatchVersionId: "patch-version:parent",
        runId: "run-materializer-chain",
        bridgeUnitId: parent.bridgeUnitId,
        targetBody: "First child target",
        parentArtifactRefs: parent.artifactRefs,
        parentArtifactHashes: parent.artifactHashes,
      });
      const firstReceipt = JSON.parse(readFileSync(first.artifactRefs.patchApply, "utf8")) as {
        childPatchVersionId: string;
        apply: { status: number };
      };
      expect(firstReceipt).toMatchObject({
        childPatchVersionId: firstPatchVersionId,
        apply: { status: 0 },
      });

      // This is the regression boundary: `first.patchApply` is the nested
      // production receipt written above, and must be accepted as the next
      // parent receipt with its bundle/output paths bound to first's manifest.
      second = await materializer.materialize({
        childPatchVersionId: secondPatchVersionId,
        parentPatchVersionId: firstPatchVersionId,
        runId: "run-materializer-chain",
        bridgeUnitId: parent.bridgeUnitId,
        targetBody: "Second child target",
        parentArtifactRefs: first.artifactRefs,
        parentArtifactHashes: first.artifactHashes,
      });

      expect(existsSync(join(second.artifactRefs.patchTarget, "REALLIVEDATA", "Seen.txt"))).toBe(
        true,
      );
      expect(dirname(first.artifactRefs.patchTarget)).not.toBe(
        dirname(second.artifactRefs.patchTarget),
      );
      expect(hashLocalizationArtifact(second.artifactRefs.patchTarget)).toBe(
        second.artifactHashes.patchTarget,
      );
    } finally {
      await second?.cleanup();
      await first?.cleanup();
      parent.cleanup();
    }
  }, 120_000);

  it("refuses parent apply receipts whose manifest-bound provenance does not match", async () => {
    await expectParentReceiptFailure(
      "--bundle",
      "--bundle does not bind to parent translatedBridge",
    );
    await expectParentReceiptFailure("--target", "--target does not bind to parent patchTarget");
    await expectParentReceiptFailure("status", "receipt with status 1");
  }, 120_000);
});

async function expectParentReceiptFailure(
  field: "--bundle" | "--target" | "status",
  expectedMessage: string,
): Promise<void> {
  const parent = createProductionParentArtifacts();
  try {
    const receipt = JSON.parse(readFileSync(parent.artifactRefs.patchApply, "utf8")) as {
      args: string[];
      status: number;
    };
    if (field === "status") {
      receipt.status = 1;
    } else {
      const optionIndex = receipt.args.indexOf(field);
      expect(optionIndex).toBeGreaterThanOrEqual(0);
      receipt.args[optionIndex + 1] = join(parent.root, `wrong-${field.slice(2)}.json`);
    }
    writeFileSync(parent.artifactRefs.patchApply, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    parent.artifactHashes.patchApply = hashLocalizationArtifact(parent.artifactRefs.patchApply);

    const materializer = new ProductionPlayTesterPatchArtifactMaterializer();
    await expect(
      materializer.materialize({
        childPatchVersionId: `patch-version:bad-provenance:${field}`,
        parentPatchVersionId: "patch-version:parent",
        runId: "run-materializer-provenance",
        bridgeUnitId: parent.bridgeUnitId,
        targetBody: "No child may be written from mismatched provenance.",
        parentArtifactRefs: parent.artifactRefs,
        parentArtifactHashes: parent.artifactHashes,
      }),
    ).rejects.toThrow(expectedMessage);
  } finally {
    parent.cleanup();
  }
}

function createProductionParentArtifacts(): {
  root: string;
  bridgeUnitId: string;
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "itotori-play-tester-materializer-"));
  const sourceRoot = join(root, "source-game");
  const sourceData = join(sourceRoot, "REALLIVEDATA");
  mkdirSync(sourceData, { recursive: true });
  copyFileSync(join(fixtureRoot, "SEEN.TXT"), join(sourceData, "Seen.txt"));
  copyFileSync(join(fixtureRoot, "Gameexe.ini"), join(sourceRoot, "Gameexe.ini"));

  const extractedBridgePath = join(root, "extracted-bridge.json");
  runKaifuuRealliveExtract({
    gameRoot: sourceRoot,
    gameId: "fixture",
    gameVersion: "1",
    sourceProfileId: "fixture-profile",
    sourceLocale: "ja-JP",
    scene: 1,
    bundleOutputPath: extractedBridgePath,
  });
  const translatedBridge = JSON.parse(readFileSync(extractedBridgePath, "utf8")) as {
    units: Array<{
      bridgeUnitId: string;
      sourceText: string;
      surfaceKind: string;
      target?: { locale: string; text: string };
    }>;
  };
  const dialogue = translatedBridge.units.find((unit) => unit.surfaceKind === "dialogue");
  if (dialogue === undefined) {
    throw new Error("public RealLive fixture did not expose a dialogue unit");
  }
  for (const unit of translatedBridge.units) {
    unit.target = {
      locale: "en-US",
      text:
        unit.bridgeUnitId === dialogue.bridgeUnitId
          ? bracketWrapForRealLive("Parent target")
          : unit.sourceText,
    };
  }
  const translatedBridgePath = join(root, "translated-bridge.json");
  writeFileSync(translatedBridgePath, `${JSON.stringify(translatedBridge, null, 2)}\n`, "utf8");
  const patchTarget = join(root, "parent-patch-target");
  const apply = applyKaifuuRealLivePatch({
    sourceRoot,
    targetRoot: patchTarget,
    translatedBundlePath: translatedBridgePath,
    translationScope: "dialogue-only",
    force: false,
  });
  const patchApply = join(root, "patch-apply.json");
  writeFileSync(patchApply, `${JSON.stringify(apply, null, 2)}\n`, "utf8");
  const artifactRefs = {
    translatedBridge: translatedBridgePath,
    patchApply,
    patchTarget,
  };
  return {
    root,
    bridgeUnitId: dialogue.bridgeUnitId,
    artifactRefs,
    artifactHashes: Object.fromEntries(
      Object.entries(artifactRefs).map(([key, path]) => [key, hashLocalizationArtifact(path)]),
    ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
