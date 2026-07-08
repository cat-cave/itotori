// itotori-cli-localize-game-vertical — tests for the M1 capstone.
//
//   1. ORCHESTRATION (mocked stages, no real bytes) — drives
//      `runLocalizeGameCommand` with fake stage seams and asserts:
//        * the four stages run in the exact dispatch order
//          extract -> structure -> localize -> validate;
//        * stage 1 extracts WHOLE-SEEN into the run dir;
//        * stage 2 writes structure into the run dir;
//        * the EFFECTIVE config the localize driver receives overrides
//          bridgePath + structureJsonPath with the fresh stage artifacts and is
//          passed source + target so the patch-apply seam runs;
//        * stage 4 replay-validates THEN render-validates the PATCHED target.
//   2. FAILURE SURFACING — a stage throw is re-tagged with the failing stage;
//      a PipelineFailureDiagnosticError from the localize driver is preserved.
//   3. CLI DISPATCH — `runItotoriCliCommand(["localize-game", ...])` routes to
//      the handler (not the unknown-command fallback) and required-flag
//      validation refuses a missing flag.
//
// No real game bytes, no live LLM: every stage is a fake. The env-gated real
// vertical proof lives in `localize-game-real.test.ts` (below).

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";
import {
  runLocalizeGameCommand,
  LocalizeGameStageError,
  type LocalizeGameStageSeams,
} from "../src/orchestrator/localize-game-command.js";
import {
  PipelineFailureDiagnosticError,
  buildPipelineFailureDiagnostic,
} from "../src/orchestrator/pipeline-failure-diagnostic.js";
import type { RunLocalizeFullProjectLiveResult } from "../src/orchestrator/localize-fullproject-cli.js";

const BASE_CONFIG = {
  schemaVersion: "itotori.localize-fullproject.config.v0",
  projectId: "sweetie",
  localeBranchId: "en-US",
  sourceRevisionId: "r1",
  engineProfile: "reallive",
  translationScope: "dialogue-only",
  bridgePath: "/stale/should-be-overridden.json",
  pairPolicyPath: "/x/pair-policy.json",
  structureJsonPath: "/stale/structure.json",
} as const;

const IDENTITY = {
  gameId: "sweetie",
  gameVersion: "1.0",
  sourceProfileId: "profile-1",
  sourceLocale: "ja-JP",
} as const;

/** A minimal localize result carrying only the fields the command reads. */
function fakeLocalizeResult(withPatch: boolean): RunLocalizeFullProjectLiveResult {
  const result = {
    unitsRun: 3,
    acceptedDraftCount: 3,
    deferredCount: 0,
    failures: [],
    reviewerQueueItemCount: 1,
    totalUsageCostUsd: 0.0042,
    zdrConfirmed: true,
    budgetStopped: false,
  };
  const record = { passNumber: 1, priorPassNumber: null, acceptedDeltas: [] };
  const base = { result, record, prior: undefined } as unknown as RunLocalizeFullProjectLiveResult;
  if (withPatch) {
    return {
      ...base,
      patchApply: { patchExportBundle: { drafts: [{}] } },
    } as unknown as RunLocalizeFullProjectLiveResult;
  }
  return base;
}

/** A fake in-memory JSON store recording writes. */
function memoryIo(seed: Record<string, unknown> = {}): {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
  writes: Map<string, unknown>;
} {
  const writes = new Map<string, unknown>();
  return {
    writes,
    readJson: (path) => {
      if (path in seed) return seed[path];
      if (writes.has(path)) return writes.get(path);
      throw new Error(`memoryIo: no json at ${path}`);
    },
    writeJson: (path, value) => {
      writes.set(path, value);
    },
  };
}

type CallLog = string[];
type Capture = { localize?: unknown; nativeCalls: string[][] };

/** Build fake stage seams that record the call order + capture inputs. */
function fakeStages(
  order: CallLog,
  capture: Capture,
  opts: { withPatch?: boolean } = {},
): LocalizeGameStageSeams {
  return {
    extract: (args) => {
      order.push("extract");
      // whole-seen mode is what the vertical drives.
      expect(args.wholeSeen).toBe(true);
      return {
        command: "kaifuu-cli",
        args: [],
        status: 0,
        stdout: "",
        stderr: "",
        bundleOutputPath: args.bundleOutputPath,
        mode: "whole-seen",
      };
    },
    structure: () => {
      order.push("structure");
      return { command: "utsushi-cli", args: [], status: 0, stdout: "", stderr: "" };
    },
    localize: (args) => {
      order.push("localize");
      capture.localize = args;
      return Promise.resolve(fakeLocalizeResult(opts.withPatch ?? true));
    },
    runNative: (_bin, args) => {
      order.push(`native:${args[0]}`);
      capture.nativeCalls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

describe("runLocalizeGameCommand (orchestration, mocked stages)", () => {
  it("runs extract -> structure -> localize -> validate in order, wiring the effective config", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "lgame-orch-"));
    const configPath = join(runDir, "base.config.json");
    const io = memoryIo({ [configPath]: BASE_CONFIG });
    const order: CallLog = [];
    const capture: Capture = { nativeCalls: [] };

    const result = await runLocalizeGameCommand({
      configPath,
      sourceRoot: "/games/sweetie",
      targetRoot: "/out/patched",
      runDir,
      identity: IDENTITY,
      validateScene: "1",
      expectTextContains: "Hello",
      io,
      stages: fakeStages(order, capture),
    });

    // Exact stage sequence: extract, structure, localize, then validate's two
    // native calls (replay THEN render).
    expect(order).toEqual([
      "extract",
      "structure",
      "localize",
      "native:replay-validate",
      "native:render-validate",
    ]);

    // The effective config the localize driver received overrides bridge +
    // structure with THIS run's fresh artifacts (not the stale base paths).
    const localizeArgs = capture.localize as {
      configPath: string;
      sourceRoot: string;
      patchTargetRoot: string;
    };
    const effective = io.writes.get(localizeArgs.configPath) as Record<string, unknown>;
    expect(effective.bridgePath).toBe(join(runDir, "bridge-bundle.json"));
    expect(effective.structureJsonPath).toBe(join(runDir, "structure.json"));
    // The base config's other fields survive.
    expect(effective.projectId).toBe("sweetie");
    expect(effective.pairPolicyPath).toBe("/x/pair-policy.json");
    // Source + target are threaded so the patch-apply seam runs.
    expect(localizeArgs.sourceRoot).toBe("/games/sweetie");
    expect(localizeArgs.patchTargetRoot).toBe("/out/patched");

    // Validate stage hit the PATCHED target (target tree, not source).
    const replay = capture.nativeCalls[0];
    const render = capture.nativeCalls[1];
    expect(replay).toContain("replay-validate");
    expect(replay[replay.indexOf("--seen") + 1]).toBe(
      join("/out/patched", "REALLIVEDATA", "Seen.txt"),
    );
    expect(render).toContain("render-validate");
    expect(render[render.indexOf("--seen") + 1]).toBe(
      join("/out/patched", "REALLIVEDATA", "Seen.txt"),
    );
    // The localized expected text is forwarded to render-validate.
    expect(render[render.indexOf("--expect-text-contains") + 1]).toBe("Hello");
    // Render pulls the pristine source Seen for #NAMAE colour recovery.
    expect(render[render.indexOf("--source-seen") + 1]).toBe(
      join("/games/sweetie", "REALLIVEDATA", "Seen.txt"),
    );
    // Gameexe + assets (g00) come from the READ-ONLY SOURCE data dir — the
    // patch only materializes Seen.txt into the target, so validate points at
    // the source tree for Gameexe/assets (mirrors the patch/validate node).
    expect(render[render.indexOf("--gameexe") + 1]).toBe(
      join("/games/sweetie", "REALLIVEDATA", "Gameexe.ini"),
    );
    expect(render[render.indexOf("--game-dir") + 1]).toBe(join("/games/sweetie", "REALLIVEDATA"));

    expect(result.patchTargetRoot).toBe("/out/patched");
    expect(result.localize.patchApply).toBeDefined();
  });

  it("fails closed when the localize driver did not apply a patch", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "lgame-nopatch-"));
    const configPath = join(runDir, "base.config.json");
    const io = memoryIo({ [configPath]: BASE_CONFIG });
    const order: CallLog = [];
    const capture: Capture = { nativeCalls: [] };

    await expect(
      runLocalizeGameCommand({
        configPath,
        sourceRoot: "/games/sweetie",
        targetRoot: "/out/patched",
        runDir,
        identity: IDENTITY,
        validateScene: "1",
        io,
        stages: fakeStages(order, capture, { withPatch: false }),
      }),
    ).rejects.toThrow(/did not apply a patch/u);
    // Validate must NOT have run — the target was never patched.
    expect(order).not.toContain("native:replay-validate");
  });

  it("tags a stage throw with the failing stage", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "lgame-fail-"));
    const configPath = join(runDir, "base.config.json");
    const io = memoryIo({ [configPath]: BASE_CONFIG });
    const stages: LocalizeGameStageSeams = {
      extract: () => {
        throw new Error("kaifuu boom");
      },
      structure: () => {
        throw new Error("unreached");
      },
      localize: () => Promise.reject(new Error("unreached")),
      runNative: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const err = await runLocalizeGameCommand({
      configPath,
      sourceRoot: "/s",
      targetRoot: "/t",
      runDir,
      identity: IDENTITY,
      validateScene: "1",
      io,
      stages,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalizeGameStageError);
    expect((err as LocalizeGameStageError).stage).toBe("extract");
    expect((err as LocalizeGameStageError).message).toMatch(/kaifuu boom/u);
  });

  it("preserves a PipelineFailureDiagnosticError from the localize driver", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "lgame-diag-"));
    const configPath = join(runDir, "base.config.json");
    const io = memoryIo({ [configPath]: BASE_CONFIG });
    const diag = buildPipelineFailureDiagnostic({
      step: "localize.run-pass",
      code: "unknown",
      message: "run-pass aborted",
      error: new Error("driven executor exploded"),
      repro: { configPath },
      inputs: { configPath },
    });
    const stages: LocalizeGameStageSeams = {
      extract: (args) => ({
        command: "k",
        args: [],
        status: 0,
        stdout: "",
        stderr: "",
        bundleOutputPath: args.bundleOutputPath,
        mode: "whole-seen",
      }),
      structure: () => ({ command: "u", args: [], status: 0, stdout: "", stderr: "" }),
      localize: () => Promise.reject(new PipelineFailureDiagnosticError(diag)),
      runNative: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const err = await runLocalizeGameCommand({
      configPath,
      sourceRoot: "/s",
      targetRoot: "/t",
      runDir,
      identity: IDENTITY,
      validateScene: "1",
      io,
      stages,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalizeGameStageError);
    expect((err as LocalizeGameStageError).stage).toBe("localize");
    // The one-line pipeline diagnostic is surfaced inline.
    expect((err as LocalizeGameStageError).message).toMatch(/\[localize\.run-pass\] code=unknown/u);
    // The original diagnostic error survives as the cause.
    expect((err as LocalizeGameStageError).stageCause).toBeInstanceOf(
      PipelineFailureDiagnosticError,
    );
  });
});

describe("itotori localize-game (public dispatch)", () => {
  function baseDeps(): ItotoriCliDependencies {
    return {
      io: {
        readJson: vi.fn(() => {
          throw new Error("readJson unexpected");
        }),
        writeJson: vi.fn(),
      },
      migrateDatabase: vi.fn(async () => {}),
      withServices: vi.fn(async () => {}),
    };
  }

  it("refuses a missing required flag (routes to the handler, not the fallback)", async () => {
    await expect(
      runItotoriCliCommand(
        [
          "localize-game",
          "--source",
          "/s",
          "--target",
          "/t",
          "--run-dir",
          "/run",
          // missing --config, --scene, identity flags
        ],
        baseDeps(),
      ),
    ).rejects.toThrow(/missing required flag/u);
  });

  it("refuses an invalid --redaction value", async () => {
    await expect(
      runItotoriCliCommand(
        [
          "localize-game",
          "--config",
          "/c.json",
          "--source",
          "/s",
          "--target",
          "/t",
          "--run-dir",
          "/run",
          "--scene",
          "1",
          "--game-id",
          "g",
          "--game-version",
          "1",
          "--source-profile-id",
          "p",
          "--source-locale",
          "ja",
          "--redaction",
          "sometimes",
        ],
        baseDeps(),
      ),
    ).rejects.toThrow(/--redaction must be 'on' or 'off'/u);
  });
});
