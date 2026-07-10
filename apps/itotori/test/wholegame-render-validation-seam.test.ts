import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  admitWholeGameRuntimeValidation,
  runWholeGameReplayRenderValidate,
  type WholeGameRenderValidationResult,
} from "../src/orchestrator/wholegame-render-validation-seam.js";
import type { DrivenPatchReport } from "../src/orchestrator/project-driven-executor.js";
import type { NativeCliProcessResult } from "../src/native-bin/cli-bin-resolver.js";

const UNIT_A = "019ed0aa-0000-7000-8000-0000000000a1";
const UNIT_B = "019ed0aa-0000-7000-8000-0000000000b2";
const UNIT_C = "019ed0aa-0000-7000-8000-0000000000c3";
const DRAFT_A = "Good morning, Yui.";
const DRAFT_B = "We should meet after class.";
const DRAFT_C = "See you at the station.";
const DUPLICATE_DRAFT = "Same localized line.";

function rawBridgeTwoScenes(): unknown {
  return {
    schemaVersion: "0.2.0",
    sourceLocale: "ja-JP",
    units: [
      {
        bridgeUnitId: UNIT_A,
        sourceUnitKey: "scene-6010/line-001",
        sourceText: "おはよう。",
        context: { route: { sceneKey: "scene-6010" } },
      },
      {
        bridgeUnitId: UNIT_B,
        sourceUnitKey: "scene-6020/line-001",
        sourceText: "またね。",
        context: { route: { sceneKey: "scene-6020" } },
      },
    ],
  };
}

function rawBridgeSameSceneTwoUnits(): unknown {
  return {
    schemaVersion: "0.2.0",
    sourceLocale: "ja-JP",
    units: [
      {
        bridgeUnitId: UNIT_A,
        sourceUnitKey: "scene-6010/line-001",
        sourceText: "おはよう。",
        context: { route: { sceneKey: "scene-6010" } },
      },
      {
        bridgeUnitId: UNIT_B,
        sourceUnitKey: "scene-6010/line-002",
        sourceText: "授業のあとで。",
        context: { route: { sceneKey: "scene-6010" } },
      },
      {
        bridgeUnitId: UNIT_C,
        sourceUnitKey: "scene-6010/line-003",
        sourceText: "駅でね。",
        context: { route: { sceneKey: "scene-6010" } },
      },
    ],
  };
}

function rawBridgeFixtureSceneOneTwoUnits(): unknown {
  return {
    schemaVersion: "0.2.0",
    sourceLocale: "ja-JP",
    units: [
      {
        bridgeUnitId: UNIT_A,
        sourceUnitKey: "scene-0001/line-001",
        sourceText: "あ",
        context: { route: { sceneKey: "scene-0001" } },
      },
      {
        bridgeUnitId: UNIT_B,
        sourceUnitKey: "scene-0001/line-002",
        sourceText: "い",
        context: { route: { sceneKey: "scene-0001" } },
      },
    ],
  };
}

function patchReport(
  accepted: Array<{ bridgeUnitId: string; sourceUnitKey: string; finalDraftText: string }>,
): DrivenPatchReport {
  return {
    schemaVersion: "itotori.project-driven-executor.patch-report.v0",
    projectId: "project",
    localeBranchId: "branch",
    targetLocale: "en-US",
    pair: { modelId: "m", providerId: "p" },
    engineProfile: "reallive",
    translationScope: "dialogue-only",
    unitsEnumerated: accepted.length,
    unitsInScope: accepted.length,
    unitsRun: accepted.length,
    acceptedDraftCount: accepted.length,
    deferredCount: 0,
    failureCount: 0,
    reviewerQueueItemCount: 0,
    totalUsageCostUsd: 0,
    zdrConfirmed: true,
    budgetStopped: false,
    sourceBridgeHash: "sha256:test",
    acceptedUnits: accepted,
  };
}

describe("runWholeGameReplayRenderValidate", () => {
  it("returns retry admission for persisted runtime findings", () => {
    const validation: WholeGameRenderValidationResult = {
      schemaVersion: "itotori.wholegame-render-validation.v0",
      redaction: "on",
      coverage: {
        acceptedUnitCount: 1,
        candidateUnitCount: 1,
        selectedUnitCount: 1,
        candidateSceneCount: 1,
        validatedSceneCount: 1,
        sampled: false,
        sceneIds: [6010],
        selectedUnitIds: [UNIT_A],
        skippedUnitIds: [],
      },
      findings: [
        {
          phase: "replay-validate",
          bridgeUnitId: UNIT_A,
          sourceUnitKey: "scene-6010/line-001",
          sceneId: 6010,
          code: "native-cli-failed",
          message: "replay failed",
          diagnostic: {} as never,
          artifactRefs: { replayLog: "replay.json", dispatchReport: "dispatch.json" },
        },
      ],
    };
    expect(admitWholeGameRuntimeValidation(validation)).toMatchObject({
      kind: "runtime-validation-incomplete",
      validation,
      retryUnitIds: [UNIT_A],
    });
  });

  it("runs replay then redacted render validation over the covered unit set and records failures", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];
    const artifactRoot = join(
      mkdtempSync(join(tmpdir(), "itotori-wholegame-render-mocked-")),
      "wholegame-render-validation",
    );
    const result: WholeGameRenderValidationResult = runWholeGameReplayRenderValidate({
      rawBridge: rawBridgeTwoScenes(),
      patchReport: patchReport([
        { bridgeUnitId: UNIT_A, sourceUnitKey: "scene-6010/line-001", finalDraftText: DRAFT_A },
        { bridgeUnitId: UNIT_B, sourceUnitKey: "scene-6020/line-001", finalDraftText: DRAFT_B },
      ]),
      sourceRoot: "/source-game",
      targetRoot: "/patched-game",
      artifactRoot,
      maxUnits: 1,
      nativeCli: {
        env: {},
        runProcess: (command, args): NativeCliProcessResult => {
          calls.push({ command, args });
          if (args.includes("render-validate")) {
            return {
              status: 1,
              stdout: "",
              stderr: `render text mismatch: expected ${DRAFT_A}`,
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      log: (message) => logs.push(message),
    });

    expect(result.coverage).toMatchObject({
      acceptedUnitCount: 2,
      candidateUnitCount: 2,
      selectedUnitCount: 1,
      candidateSceneCount: 2,
      validatedSceneCount: 1,
      sampled: true,
      maxUnits: 1,
      sceneIds: [6010],
      selectedUnitIds: [UNIT_A],
      skippedUnitIds: [UNIT_B],
    });
    expect(logs.join("\n")).toContain("1/2 accepted unit(s)");
    expect(logs.join("\n")).toContain("maxUnits=1");
    expect(logs.join("\n")).toContain(`skipped=[${UNIT_B}]`);
    expect(logs.join("\n")).toContain("reason=cost-cap");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args.slice(calls[0]!.args.indexOf("replay-validate"))).toEqual([
      "replay-validate",
      "--engine",
      "reallive",
      "--seen",
      join("/patched-game", "REALLIVEDATA", "Seen.txt"),
      "--scene",
      "6010",
      "--print-replay-log",
      join(artifactRoot, "scene-6010", `unit-${UNIT_A}`, "replay-log.json"),
      "--dispatch-report",
      join(artifactRoot, "scene-6010", `unit-${UNIT_A}`, "dispatch-report.json"),
      "--require-semantic-reached-path",
    ]);
    expect(calls[1]!.args).toContain("render-validate");
    expect(calls[1]!.args).toContain("--redaction");
    expect(calls[1]!.args).toContain("on");
    expect(calls[1]!.args).toContain("--expect-text-contains");
    expect(calls[1]!.args).toContain(DRAFT_A);

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.phase).toBe("render-validate");
    expect(finding.bridgeUnitId).toBe(UNIT_A);
    expect(finding.diagnostic.step).toBe("localize.render-validate");
    expect(JSON.stringify(finding.diagnostic)).not.toContain(DRAFT_A);
    expect(finding.diagnostic.inputs.expectedTextContains).toBe("[REDACTED]");
  });

  it("invokes render-validate once per accepted unit in the same scene (no silent per-scene cap)", () => {
    const expectTexts: string[] = [];
    const logs: string[] = [];
    const artifactRoot = join(
      mkdtempSync(join(tmpdir(), "itotori-wholegame-render-mocked-")),
      "wholegame-render-validation",
    );
    const result = runWholeGameReplayRenderValidate({
      rawBridge: rawBridgeSameSceneTwoUnits(),
      patchReport: patchReport([
        { bridgeUnitId: UNIT_A, sourceUnitKey: "scene-6010/line-001", finalDraftText: DRAFT_A },
        { bridgeUnitId: UNIT_B, sourceUnitKey: "scene-6010/line-002", finalDraftText: DRAFT_B },
        { bridgeUnitId: UNIT_C, sourceUnitKey: "scene-6010/line-003", finalDraftText: DRAFT_C },
      ]),
      sourceRoot: "/source-game",
      targetRoot: "/patched-game",
      artifactRoot,
      nativeCli: {
        env: {},
        runProcess: (_command, args): NativeCliProcessResult => {
          if (args.includes("render-validate")) {
            const idx = args.indexOf("--expect-text-contains");
            expectTexts.push(args[idx + 1]!);
            // Fail the later line so a silent one-per-scene skip would hide it.
            if (args.includes(DRAFT_C)) {
              return {
                status: 1,
                stdout: "",
                stderr: "utsushi.cli.render_validate.expect_text_missing: later line broken",
              };
            }
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      log: (message) => logs.push(message),
    });

    expect(result.coverage).toMatchObject({
      acceptedUnitCount: 3,
      candidateUnitCount: 3,
      selectedUnitCount: 3,
      candidateSceneCount: 1,
      validatedSceneCount: 1,
      sampled: false,
      sceneIds: [6010],
      selectedUnitIds: [UNIT_A, UNIT_B, UNIT_C],
      skippedUnitIds: [],
    });
    expect(logs.join("\n")).toContain("3/3 accepted unit(s)");
    expect(logs.join("\n")).toContain("1/1 scene(s)");
    expect(logs.join("\n")).not.toContain("sampled");

    // One render-validate invocation per accepted unit, each with its own text.
    expect(expectTexts).toEqual([DRAFT_A, DRAFT_B, DRAFT_C]);
    // The broken later line is caught — not silently dropped by scene de-dupe.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.bridgeUnitId).toBe(UNIT_C);
    expect(result.findings[0]!.phase).toBe("render-validate");
  });

  it("selects duplicate accepted drafts by scene-local message index, not first substring match", () => {
    const renderSelections: Array<{ expectText: string; messageIndex: string }> = [];
    const artifactRoot = join(
      mkdtempSync(join(tmpdir(), "itotori-wholegame-render-duplicate-")),
      "wholegame-render-validation",
    );
    const result = runWholeGameReplayRenderValidate({
      rawBridge: rawBridgeSameSceneTwoUnits(),
      patchReport: patchReport([
        {
          bridgeUnitId: UNIT_A,
          sourceUnitKey: "scene-6010/line-001",
          finalDraftText: DUPLICATE_DRAFT,
        },
        {
          bridgeUnitId: UNIT_B,
          sourceUnitKey: "scene-6010/line-002",
          finalDraftText: DUPLICATE_DRAFT,
        },
      ]),
      sourceRoot: "/source-game",
      targetRoot: "/patched-game",
      artifactRoot,
      nativeCli: {
        env: {},
        runProcess: (_command, args): NativeCliProcessResult => {
          if (args.includes("render-validate")) {
            const expectText = args[args.indexOf("--expect-text-contains") + 1]!;
            const messageIndex = args[args.indexOf("--message-index") + 1]!;
            renderSelections.push({ expectText, messageIndex });
            if (messageIndex === "1") {
              return {
                status: 1,
                stdout: "",
                stderr:
                  "utsushi.cli.render_validate.expect_text_missing_at_index: second duplicate line broken",
              };
            }
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    });

    expect(renderSelections).toEqual([
      { expectText: DUPLICATE_DRAFT, messageIndex: "0" },
      { expectText: DUPLICATE_DRAFT, messageIndex: "1" },
    ]);
    expect(result.coverage).toMatchObject({
      acceptedUnitCount: 2,
      candidateUnitCount: 2,
      selectedUnitCount: 2,
      sampled: false,
      selectedUnitIds: [UNIT_A, UNIT_B],
      skippedUnitIds: [],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.bridgeUnitId).toBe(UNIT_B);
    expect(result.findings[0]!.phase).toBe("render-validate");
  });

  it("drives real utsushi-cli through replay success into render-validation signal per unit", () => {
    // No nativeCli mock: the real binary runs. The committed Seen fixture is a
    // valid RealLive archive for scene 1, so replay-validate must pass before
    // render-validate can emit a typed render-validation signal asserted below.
    const workDir = mkdtempSync(join(tmpdir(), "itotori-wholegame-render-real-"));
    const sourceRoot = join(workDir, "source");
    const targetRoot = join(workDir, "target");
    const artifactRoot = join(workDir, "artifacts");
    const fixtureRoot = join(
      process.cwd(),
      "..",
      "..",
      "crates",
      "kaifuu-reallive",
      "tests",
      "fixtures",
      "bridge-inventory-001",
    );
    mkdirSync(join(sourceRoot, "REALLIVEDATA"), { recursive: true });
    mkdirSync(join(targetRoot, "REALLIVEDATA"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "REALLIVEDATA", "Gameexe.ini"),
      "#SCREENSIZE_MOD=1\r\n" +
        "#WINDOW_ATTR=100,100,160,200,0\r\n" +
        "#WINDOW.000.POS=0:0,345\r\n" +
        "#WINDOW.000.ATTR_MOD=0\r\n" +
        "#WINDOW.000.ATTR=080,112,160,255,0\r\n" +
        "#WINDOW.000.MOJI_SIZE=25\r\n" +
        "#WINDOW.000.MOJI_POS=19,0,53,0\r\n" +
        "#WINDOW.000.MOJI_CNT=22,3\r\n" +
        "#WINDOW.000.MOJI_REP=-1,3\r\n" +
        "#WINDOW.000.NAME_MOD=0\r\n" +
        "#WINDOW.000.MESSAGE_MOD=0\r\n",
    );
    copyFileSync(join(fixtureRoot, "SEEN.TXT"), join(sourceRoot, "REALLIVEDATA", "Seen.txt"));
    copyFileSync(join(fixtureRoot, "SEEN.TXT"), join(targetRoot, "REALLIVEDATA", "Seen.txt"));

    const result = runWholeGameReplayRenderValidate({
      rawBridge: rawBridgeFixtureSceneOneTwoUnits(),
      patchReport: patchReport([
        { bridgeUnitId: UNIT_A, sourceUnitKey: "scene-0001/line-001", finalDraftText: DRAFT_A },
        { bridgeUnitId: UNIT_B, sourceUnitKey: "scene-0001/line-002", finalDraftText: DRAFT_B },
      ]),
      sourceRoot,
      targetRoot,
      artifactRoot,
      // real utsushi-cli via default spawn — not a fabricated runtimeValidation,
      // not a fully-mocked nativeCli.
    });

    expect(result.coverage.selectedUnitCount).toBe(2);
    expect(result.coverage.candidateUnitCount).toBe(2);
    expect(result.coverage.sampled).toBe(false);
    expect(result.coverage.selectedUnitIds).toEqual([UNIT_A, UNIT_B]);
    expect(result.coverage.skippedUnitIds).toEqual([]);

    // Strict semantic replay is allowed to reject this fixture after writing
    // replay + dispatch evidence; that nonzero result must short-circuit render.
    expect(result.findings).toHaveLength(2);
    const unitIds = new Set(result.findings.map((finding) => finding.bridgeUnitId));
    expect(unitIds.has(UNIT_A)).toBe(true);
    expect(unitIds.has(UNIT_B)).toBe(true);
    for (const finding of result.findings) {
      expect(finding.phase).toBe("replay-validate");
      expect(finding.code).toBe("native-cli-failed");
      expect(finding.artifactRefs.renderEvidence).toBeUndefined();
      expect(existsSync(finding.artifactRefs.replayLog!)).toBe(true);
      expect(existsSync(finding.artifactRefs.dispatchReport!)).toBe(true);
      expect(finding.diagnostic.error.message).toContain("semantic_path_unavailable");
      expect(JSON.stringify(finding.diagnostic)).not.toContain(DRAFT_A);
      expect(JSON.stringify(finding.diagnostic)).not.toContain(DRAFT_B);
    }
  });
});
