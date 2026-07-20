// Proof: the ONE generic patch-back producer selects a per-engine adapter from
// the registry instead of always driving RealLive. The SAME
// `produceNativePatchbackBuild` produces a RealLive Seen.txt patch AND a Softpal
// loose-file patch — chosen by the engine discovered from the source artifacts —
// and the produced manifest is engine-discriminated (adapter id + typed receipt).
//
// The native `kaifuu patch` spawn is a test seam here (the real byte-correct
// apply is proven against real bytes in patchback-real-bytes / -produce-build);
// this suite proves the SELECTION + argv + manifest discrimination, which are
// the engine-generic seam. The mock runner materializes the engine's output tree
// so the producer's hash-bound manifest can address real bytes.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectPatchbackEngine,
  enginePatchbackAdapters,
  PatchbackEngineSelectionError,
} from "../src/patchback/index.js";
import { produceNativePatchbackBuild } from "../src/patchback/produce-build.js";
import type { NativePatchbackInput } from "../src/patchback/index.js";
import type { NativeCliRunProcess } from "../src/native-bin/cli-bin-resolver.js";
import { buildRb024Snapshot, loadBridgeBundle, makeAccepted } from "./support/gate-fixtures.js";

/** One scoped-unit patchback input over the committed RB-024 fixture bridge. */
function fixtureInput(): NativePatchbackInput {
  const snapshot = buildRb024Snapshot();
  const bridge = loadBridgeBundle();
  const fact = snapshot.orderedUnits[0]!;
  const unit = bridge.units.find((candidate) => candidate.bridgeUnitId === fact.bridgeUnitId)!;
  const target = `[EN]${unit.spans
    .filter((span) => span.outOfBand !== true)
    .map((span) => span.raw)
    .join("")}`;
  return {
    snapshot,
    accepted: [makeAccepted(fact, target)],
    rawBridge: bridge,
    workScope: { inScopeUnitFactIds: [fact.factId] },
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
  };
}

function makeRealLiveRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "itotori-eng-reallive-"));
  mkdirSync(join(root, "REALLIVEDATA"), { recursive: true });
  writeFileSync(join(root, "REALLIVEDATA", "Seen.txt"), "");
  writeFileSync(join(root, "REALLIVEDATA", "Gameexe.ini"), "");
  return root;
}

function makeSoftpalRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "itotori-eng-softpal-"));
  writeFileSync(join(root, "SCRIPT.SRC"), "");
  writeFileSync(join(root, "TEXT.DAT"), "");
  return root;
}

/** A mock kaifuu spawn that records the argv and materializes the engine's
 * output tree (RealLive `--target`, Softpal `--output`) so the producer can hash
 * the produced bytes exactly as it would for a real apply. */
function recordingRunner(calls: string[][]): NativeCliRunProcess {
  return (_command, args) => {
    calls.push(args);
    const outIndex =
      args.indexOf("--target") >= 0 ? args.indexOf("--target") : args.indexOf("--output");
    if (outIndex >= 0) {
      const outRoot = args[outIndex + 1]!;
      mkdirSync(outRoot, { recursive: true });
      writeFileSync(join(outRoot, "patched.bytes"), "patched");
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

describe("engine patch-back registry", () => {
  it("registers both the RealLive and Softpal adapters", () => {
    expect(enginePatchbackAdapters().map((adapter) => adapter.engineId)).toEqual([
      "reallive",
      "softpal",
    ]);
  });

  it("detects the engine from the source artifacts (never defaults)", () => {
    expect(detectPatchbackEngine(makeRealLiveRoot()).engineId).toBe("reallive");
    expect(detectPatchbackEngine(makeSoftpalRoot()).engineId).toBe("softpal");
    const empty = mkdtempSync(join(tmpdir(), "itotori-eng-empty-"));
    expect(() => detectPatchbackEngine(empty)).toThrow(PatchbackEngineSelectionError);
  });
});

describe("generic producer selects the engine adapter", () => {
  it("produces a RealLive Seen.txt patch through the generic producer", () => {
    const buildRoot = join(mkdtempSync(join(tmpdir(), "itotori-eng-build-")), "produced");
    const calls: string[][] = [];
    const produced = produceNativePatchbackBuild(fixtureInput(), {
      sourceRoot: makeRealLiveRoot(),
      buildRoot,
      scope: "dialogue+choices",
      nativeCli: { runProcess: recordingRunner(calls) },
    });

    expect(produced.patch.engineId).toBe("reallive");
    expect(produced.patch.patchReceipt.engineId).toBe("reallive");
    expect(produced.patch.patchReceipt.scope).toBe("dialogue+choices");
    expect(calls[0]).toContain("--engine");
    expect(calls[0]).toContain("reallive");
    expect(calls[0]).toContain("--bundle");
    produced.cleanup();
  });

  it("produces a Softpal loose-file patch through the SAME generic producer", () => {
    const buildRoot = join(mkdtempSync(join(tmpdir(), "itotori-eng-build-")), "produced");
    const calls: string[][] = [];
    const produced = produceNativePatchbackBuild(fixtureInput(), {
      sourceRoot: makeSoftpalRoot(),
      buildRoot,
      scope: "dialogue-only",
      nativeCli: { runProcess: recordingRunner(calls) },
    });

    // Same producer, different adapter: engine-discriminated manifest + receipt.
    expect(produced.patch.engineId).toBe("softpal");
    expect(produced.patch.patchReceipt.engineId).toBe("softpal");
    // Softpal consumes the strict PatchExportV02 via --patch and writes --output
    // (never RealLive's --bundle/--target/--scope).
    const argv = calls[0]!;
    const patchArgv = argv.slice(argv.indexOf("patch"));
    expect(patchArgv[0]).toBe("patch");
    expect(patchArgv[patchArgv.indexOf("--engine") + 1]).toBe("softpal");
    expect(patchArgv).toContain("--patch");
    expect(patchArgv).toContain("--output");
    expect(patchArgv).not.toContain("--bundle");
    expect(patchArgv).not.toContain("--scope");
    // The produced build still addresses its patched tree under patchTarget.
    expect(produced.patch.artifactRefs.patchTarget).toBeDefined();
    produced.cleanup();
  });

  it("verifies an explicit engine against the source (mismatch fails loud)", () => {
    const buildRoot = join(mkdtempSync(join(tmpdir(), "itotori-eng-build-")), "produced");
    expect(() =>
      produceNativePatchbackBuild(fixtureInput(), {
        sourceRoot: makeSoftpalRoot(),
        buildRoot,
        scope: "dialogue-only",
        engineId: "reallive",
        nativeCli: { runProcess: recordingRunner([]) },
      }),
    ).toThrow(PatchbackEngineSelectionError);
  });
});
