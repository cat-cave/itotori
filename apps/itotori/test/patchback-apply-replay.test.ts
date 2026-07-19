// Proof: the native apply + translated-byte replay seams emit the correct native
// CLI invocations, fail loud on a non-zero exit, and — the observe-target proof
// in miniature — parse observed TextLine bodies so that a PATCHED observation
// containing the target passes while a SOURCE observation (no target) does not.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyRealLivePatch,
  observedTextContains,
  parseObservedBodies,
  realLivePatchArgs,
  RealLiveApplyError,
  replayAcceptedPatch,
  replayObserve,
  replayValidateArgs,
} from "../src/patchback/index.js";
import type { NativeCliRunProcess } from "../src/native-bin/cli-bin-resolver.js";
import { bindScopedTargets, buildPatchExportV02 } from "../src/patchback/index.js";
import type { NativePatchbackInput } from "../src/patchback/index.js";
import { buildRb024Snapshot, loadBridgeBundle, makeAccepted } from "./support/gate-fixtures.js";

function runnerReturning(status: number, stdout = "", stderr = ""): NativeCliRunProcess {
  return () => ({ status, stdout, stderr });
}

describe("applyRealLivePatch", () => {
  const base = {
    sourceRoot: "/src",
    targetRoot: "/out",
    translatedBundlePath: "/tmp/translated.json",
    scope: "dialogue+choices" as const,
  };

  it("builds the canonical kaifuu patch argv", () => {
    expect(realLivePatchArgs(base)).toEqual([
      "patch",
      "--engine",
      "reallive",
      "--source",
      "/src",
      "--target",
      "/out",
      "--bundle",
      "/tmp/translated.json",
      "--scope",
      "dialogue+choices",
      "--force",
    ]);
  });

  it("returns the apply result on a zero exit", () => {
    const result = applyRealLivePatch({
      ...base,
      nativeCli: { runProcess: runnerReturning(0, "ok") },
    });
    expect(result.status).toBe(0);
    expect(result.args).toContain("reallive");
  });

  it("throws RealLiveApplyError on a non-zero exit (no silent fallback)", () => {
    expect(() =>
      applyRealLivePatch({ ...base, nativeCli: { runProcess: runnerReturning(1, "", "boom") } }),
    ).toThrow(RealLiveApplyError);
  });
});

describe("translated-byte replay observation", () => {
  const replayArgsBase = {
    seenPath: "/out/REALLIVEDATA/Seen.txt",
    sceneId: 1017,
    gameexePath: "/src/REALLIVEDATA/Gameexe.ini",
    g00Dir: "/src/REALLIVEDATA/g00",
    replayLogPath: "/tmp/replay.json",
  };

  it("builds the canonical replay-validate argv", () => {
    expect(replayValidateArgs(replayArgsBase)).toEqual([
      "replay-validate",
      "--engine",
      "reallive",
      "--seen",
      "/out/REALLIVEDATA/Seen.txt",
      "--scene",
      "1017",
      "--gameexe",
      "/src/REALLIVEDATA/Gameexe.ini",
      "--g00-dir",
      "/src/REALLIVEDATA/g00",
      "--print-replay-log",
      "/tmp/replay.json",
      "--print-textlines",
    ]);
  });

  it("parses observed TextLine bodies from the --print-textlines stdout", () => {
    const stdout = [
      'textline[0] pc=0x0011 body="[EN 5] hello"',
      'textline[1] pc=0x0031 body="plain"',
      "textline_total=2",
      "utsushi.reallive.replay_observed_textlines_emitted: scene=1017 textline_count=2",
    ].join("\n");
    expect(parseObservedBodies(stdout)).toEqual(["[EN 5] hello", "plain"]);
  });

  it("observes the TARGET in a patched replay but NOT in a source replay", () => {
    const patchedStdout =
      'textline[0] pc=0x0011 body="[EN 5] the translated line"\ntextline_total=1\nutsushi.reallive.replay_observed_textlines_emitted: scene=1017 textline_count=1';
    const sourceStdout =
      'textline[0] pc=0x0011 body="あい"\ntextline_total=1\nutsushi.reallive.replay_observed_textlines_emitted: scene=1017 textline_count=1';

    const patched = replayObserve({
      ...replayArgsBase,
      nativeCli: { runProcess: runnerReturning(0, patchedStdout) },
    });
    const source = replayObserve({
      ...replayArgsBase,
      nativeCli: { runProcess: runnerReturning(0, sourceStdout) },
    });

    // Patched artifact yields the accepted target; source bytes do not.
    expect(observedTextContains(patched, "[EN 5]")).toBe(true);
    expect(observedTextContains(source, "[EN 5]")).toBe(false);
    // And the source observation is genuinely the untranslated source line.
    expect(observedTextContains(source, "あい")).toBe(true);
    expect(patched.textLineCount).toBe(1);
  });

  it("replays every PatchExportV02 scene and rejects a source-byte target replay", () => {
    const snapshot = buildRb024Snapshot();
    const bridge = loadBridgeBundle();
    const fact = snapshot.orderedUnits[0]!;
    const unit = bridge.units.find((candidate) => candidate.bridgeUnitId === fact.bridgeUnitId)!;
    const target = `[EN replay]${unit.spans
      .filter((span) => span.outOfBand !== true)
      .map((span) => span.raw)
      .join("")}`;
    const input: NativePatchbackInput = {
      snapshot,
      accepted: [makeAccepted(fact, target)],
      rawBridge: bridge,
      workScope: { inScopeUnitFactIds: [fact.factId] },
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
    };
    const patchExport = buildPatchExportV02(input, bindScopedTargets(input));
    const patchedStdout = [
      `textline[0] pc=0x0011 body=${JSON.stringify(target)}`,
      "utsushi.reallive.replay_observed_textlines_emitted: scene=1017 textline_count=1",
    ].join("\n");
    const sourceStdout = [
      'textline[0] pc=0x0011 body="あい"',
      "utsushi.reallive.replay_observed_textlines_emitted: scene=1017 textline_count=1",
    ].join("\n");
    const outputs = [patchedStdout, sourceStdout];
    const replay = replayAcceptedPatch({
      patchExport,
      patchedSeenPath: "/patched/REALLIVEDATA/Seen.txt",
      sourceSeenPath: "/source/REALLIVEDATA/Seen.txt",
      gameexePath: "/source/REALLIVEDATA/Gameexe.ini",
      g00Dir: "/source/REALLIVEDATA/g00",
      replayLogDirectory: mkdtempSync(join(tmpdir(), "itotori-patchback-replay-test-")),
      nativeCli: {
        runProcess: () => ({ status: 0, stdout: outputs.shift() ?? "", stderr: "" }),
      },
    });

    expect(replay.scenes).toHaveLength(1);
    expect(replay.scenes[0]!.patched.observedBodies).toContain(target);
    expect(replay.scenes[0]!.source.observedBodies).not.toContain(target);
  });
});
