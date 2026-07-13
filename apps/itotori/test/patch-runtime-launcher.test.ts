import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashLocalizationArtifact,
  type AuthorizationActor,
  type PatchPlaySurface,
} from "@itotori/db";
import { describe, expect, it, vi } from "vitest";
import { PatchIterationService } from "../src/iteration/patch-iteration-service.js";
import {
  PatchRuntimeLaunchError,
  UtsushiPatchRuntimeLauncher,
  type PatchRuntimeLaunchReceipt,
} from "../src/play/patch-runtime-launcher.js";

const actor: AuthorizationActor = { userId: "runtime-launcher-test-user" };

describe("UtsushiPatchRuntimeLauncher", () => {
  it("drives the exact hash-bound patch through replay-validate and consumes descriptor.scene", async () => {
    const fixture = patchRuntimeFixture();
    const runProcess = vi.fn((_: string, args: string[]) => {
      const replayLog = args[args.indexOf("--print-replay-log") + 1];
      if (replayLog === undefined) throw new Error("test runner needs Utsushi replay receipt path");
      writeFileSync(replayLog, "{}\n", "utf8");
      return {
        status: 0,
        stdout: "utsushi.reallive.replay_observed_textlines_emitted: scene=7 textline_count=3\n",
        stderr: "",
      };
    });
    try {
      const launcher = new UtsushiPatchRuntimeLauncher({
        nativeCli: { runProcess },
        temporaryRoot: fixture.root,
      });

      await expect(
        launcher.launch({ patch: fixture.patch, launchDescriptor: { scene: 7 } }),
      ).resolves.toEqual({
        runtime: "utsushi-reallive",
        engine: "reallive",
        scene: 7,
        replay: "observed",
        observedTextLineCount: 3,
      });

      const args = runProcess.mock.calls[0]?.[1] ?? [];
      const replayArgs = args.slice(args.indexOf("replay-validate"));
      expect(replayArgs).toEqual([
        "replay-validate",
        "--engine",
        "reallive",
        "--seen",
        join(fixture.targetRoot, "REALLIVEDATA", "Seen.txt"),
        "--scene",
        "7",
        "--gameexe",
        join(fixture.sourceRoot, "Gameexe.ini"),
        "--g00-dir",
        join(fixture.sourceRoot, "REALLIVEDATA", "g00"),
        "--print-replay-log",
        expect.stringContaining("itotori-patch-play-"),
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses an invalid launch descriptor before it creates a native runtime process", async () => {
    const fixture = patchRuntimeFixture();
    const runProcess = vi.fn();
    try {
      const launcher = new UtsushiPatchRuntimeLauncher({ nativeCli: { runProcess } });
      await expect(
        launcher.launch({ patch: fixture.patch, launchDescriptor: { scene: "seven" } }),
      ).rejects.toMatchObject({ code: "invalid_launch_descriptor" });
      expect(runProcess).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });
});

describe("PatchIterationService.play", () => {
  it("persists a session only after the real-runtime seam returns a safe launch receipt", async () => {
    const fixture = patchRuntimeFixture();
    const launchReceipt: PatchRuntimeLaunchReceipt = {
      runtime: "utsushi-reallive",
      engine: "reallive",
      scene: 1,
      replay: "observed",
      observedTextLineCount: 2,
    };
    const launch = vi.fn(async () => launchReceipt);
    const startPlaySession = vi.fn(
      async (_: unknown, input: { launchDescriptor?: Record<string, unknown> }) => ({
        playSessionId: "play-session-runtime",
        observedPatchVersionId: fixture.patch.patchVersionId,
        actorUserId: actor.userId,
        status: "active" as const,
        launchDescriptor: input.launchDescriptor ?? {},
        startedAt: new Date("2026-07-13T00:00:00.000Z"),
        endedAt: null,
        createdAt: new Date("2026-07-13T00:00:00.000Z"),
        updatedAt: new Date("2026-07-13T00:00:00.000Z"),
        qaCallouts: [],
      }),
    );
    try {
      const service = new PatchIterationService({
        actor,
        iteration: {
          loadPatchPlaySurface: vi.fn(async () => fixture.patch),
          startPlaySession,
        } as never,
        journal: {} as never,
        finalizer: {} as never,
        runtimeLauncher: { launch },
      });

      await service.play({
        patchVersionId: fixture.patch.patchVersionId,
        launchDescriptor: { scene: 1, untrustedDisplayHint: "ignored" },
      });

      expect(launch).toHaveBeenCalledWith({
        patch: fixture.patch,
        launchDescriptor: { scene: 1, untrustedDisplayHint: "ignored" },
      });
      expect(startPlaySession).toHaveBeenCalledWith(actor, {
        observedPatchVersionId: fixture.patch.patchVersionId,
        launchDescriptor: launchReceipt,
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("does not record a session when runtime launch fails", async () => {
    const fixture = patchRuntimeFixture();
    const startPlaySession = vi.fn();
    try {
      const service = new PatchIterationService({
        actor,
        iteration: {
          loadPatchPlaySurface: vi.fn(async () => fixture.patch),
          startPlaySession,
        } as never,
        journal: {} as never,
        finalizer: {} as never,
        runtimeLauncher: {
          launch: async () => {
            throw new PatchRuntimeLaunchError("runtime_failed", "fixture runtime failed");
          },
        },
      });

      await expect(
        service.play({ patchVersionId: fixture.patch.patchVersionId }),
      ).rejects.toMatchObject({
        code: "runtime_failed",
      });
      expect(startPlaySession).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });
});

function patchRuntimeFixture(): {
  root: string;
  sourceRoot: string;
  targetRoot: string;
  patch: PatchPlaySurface;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "itotori-patch-runtime-test-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const translatedBridge = join(root, "translated-bridge.json");
  const patchApply = join(root, "patch-apply.json");
  mkdirSync(join(sourceRoot, "REALLIVEDATA", "g00"), { recursive: true });
  mkdirSync(join(targetRoot, "REALLIVEDATA"), { recursive: true });
  writeFileSync(join(sourceRoot, "Gameexe.ini"), "#SEEN_START=1\n", "utf8");
  writeFileSync(join(targetRoot, "REALLIVEDATA", "Seen.txt"), "patched-real-bytes", "utf8");
  writeFileSync(
    translatedBridge,
    JSON.stringify({ units: [{ sourceUnitKey: "reallive:scene-0001#0000" }] }),
    "utf8",
  );
  writeFileSync(
    patchApply,
    JSON.stringify({
      args: [
        "patch",
        "--engine",
        "reallive",
        "--source",
        sourceRoot,
        "--target",
        targetRoot,
        "--bundle",
        translatedBridge,
        "--scope",
        "dialogue-only",
      ],
      status: 0,
      stdout: "",
      stderr: "",
    }),
    "utf8",
  );
  const artifactRefs = { translatedBridge, patchApply, patchTarget: targetRoot };
  const artifactHashes = Object.fromEntries(
    Object.entries(artifactRefs).map(([key, path]) => [key, hashLocalizationArtifact(path)]),
  );
  return {
    root,
    sourceRoot,
    targetRoot,
    patch: {
      patchVersionId: "patch-runtime-fixture",
      runId: "run-runtime-fixture",
      parentPatchVersionId: null,
      origin: "run_finalizer",
      status: "playable",
      playableAt: new Date("2026-07-13T00:00:00.000Z"),
      selectedAt: new Date("2026-07-13T00:00:00.000Z"),
      artifactRefs,
      artifactHashes,
      units: [],
      qaCallouts: [],
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
