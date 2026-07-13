// p0-real-patch-play-runtime — exact patch-version runtime launcher.
//
// A PatchVersion's archive is not a play surface by itself.  This adapter
// verifies the hash-bound Kaifuu provenance for the exact version and drives
// its patched RealLive Seen.txt through Utsushi's registered replay runtime.
// The full Sweetie render path remains a separate evidence bridge; this is
// the honest, lightweight "open/play this patch" runtime operation.

import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyLocalizationArtifactManifest, type PatchPlaySurface } from "@itotori/db";
import { runNativeCli, type NativeCliRunner } from "../native-bin/cli-bin-resolver.js";

const REPLAY_OBSERVED_MARKER = "utsushi.reallive.replay_observed_textlines_emitted";

/** Safe, durable receipt for a runtime launch. It intentionally contains no paths or script text. */
export type PatchRuntimeLaunchReceipt = {
  runtime: "utsushi-reallive";
  engine: "reallive";
  scene: number;
  replay: "observed";
  observedTextLineCount: number;
};

export type PatchRuntimeLauncherPort = {
  launch(input: {
    patch: PatchPlaySurface;
    launchDescriptor?: Record<string, unknown>;
  }): Promise<PatchRuntimeLaunchReceipt>;
};

export type PatchRuntimeLaunchErrorCode =
  | "patch_not_playable"
  | "artifact_integrity_failed"
  | "patch_provenance_invalid"
  | "unsupported_engine"
  | "runtime_assets_missing"
  | "scene_not_available"
  | "invalid_launch_descriptor"
  | "runtime_failed"
  | "runtime_observation_missing";

/**
 * A deliberately path-redacted operational failure. Native stderr can contain
 * retail text and local paths, so it remains at the process boundary instead
 * of becoming an API/CLI error payload.
 */
export class PatchRuntimeLaunchError extends Error {
  constructor(
    public readonly code: PatchRuntimeLaunchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PatchRuntimeLaunchError";
  }
}

export type UtsushiPatchRuntimeLauncherDeps = {
  /** Test seam; production defaults to the real sanitized native-CLI spawn. */
  nativeCli?: NativeCliRunner;
  /** Test/operations seam for owned temporary replay-log directories. */
  temporaryRoot?: string;
};

/**
 * Launches an exact hash-bound RealLive patch through Utsushi's actual runtime
 * registry (`replay-validate`). This is intentionally not `render-validate`:
 * rendering real Sweetie HD frames belongs to the separate bridge node while
 * replay is the runtime operation that can honestly back the play action here.
 */
export class UtsushiPatchRuntimeLauncher implements PatchRuntimeLauncherPort {
  constructor(private readonly deps: UtsushiPatchRuntimeLauncherDeps = {}) {}

  async launch(input: {
    patch: PatchPlaySurface;
    launchDescriptor?: Record<string, unknown>;
  }): Promise<PatchRuntimeLaunchReceipt> {
    const launch = realLiveLaunchInputs(input);
    const replayRoot = mkdtempSync(
      join(this.deps.temporaryRoot ?? tmpdir(), "itotori-patch-play-"),
    );
    try {
      const replayLogPath = join(replayRoot, "observed-replay.json");
      const result = runNativeCli(
        "utsushi-cli",
        [
          "replay-validate",
          "--engine",
          "reallive",
          "--seen",
          launch.seenPath,
          "--scene",
          String(launch.scene),
          "--gameexe",
          launch.gameexePath,
          "--g00-dir",
          launch.g00Dir,
          "--print-replay-log",
          replayLogPath,
        ],
        this.deps.nativeCli,
      );
      if (result.status !== 0) {
        throw new PatchRuntimeLaunchError(
          "runtime_failed",
          `patched RealLive runtime exited with status ${String(result.status)}`,
        );
      }
      const observedTextLineCount = observedTextLineCountFromRuntimeOutput(
        result.stdout,
        launch.scene,
      );
      if (!existsSync(replayLogPath)) {
        throw new PatchRuntimeLaunchError(
          "runtime_observation_missing",
          "patched RealLive runtime completed without its observed replay receipt",
        );
      }
      return {
        runtime: "utsushi-reallive",
        engine: "reallive",
        scene: launch.scene,
        replay: "observed",
        observedTextLineCount,
      };
    } finally {
      rmSync(replayRoot, { recursive: true, force: true });
    }
  }
}

type RealLiveLaunchInputs = {
  seenPath: string;
  gameexePath: string;
  g00Dir: string;
  scene: number;
};

function realLiveLaunchInputs(input: {
  patch: PatchPlaySurface;
  launchDescriptor?: Record<string, unknown>;
}): RealLiveLaunchInputs {
  if (input.patch.status !== "playable") {
    throw new PatchRuntimeLaunchError(
      "patch_not_playable",
      "only a playable patch version can be opened in the runtime",
    );
  }
  try {
    verifyLocalizationArtifactManifest(input.patch.artifactRefs, input.patch.artifactHashes);
  } catch {
    throw new PatchRuntimeLaunchError(
      "artifact_integrity_failed",
      "the exact patch artifacts failed integrity verification before runtime launch",
    );
  }

  const translatedBridgePath = requiredArtifact(input.patch, "translatedBridge");
  const patchApplyPath = requiredArtifact(input.patch, "patchApply");
  const patchTarget = requiredArtifact(input.patch, "patchTarget");
  const apply = parsePatchApplyReceipt(patchApplyPath);
  const engine = requiredOption(apply.args, "--engine");
  if (engine !== "reallive") {
    throw new PatchRuntimeLaunchError(
      "unsupported_engine",
      "this patch version cannot be opened by the installed RealLive runtime",
    );
  }
  if (apply.status !== 0) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the exact patch has no successful apply provenance for runtime launch",
    );
  }
  const sourceRoot = resolve(requiredOption(apply.args, "--source"));
  assertBoundArtifactPath(requiredOption(apply.args, "--target"), patchTarget);
  assertBoundArtifactPath(requiredOption(apply.args, "--bundle"), translatedBridgePath);

  const scene =
    sceneFromDescriptor(input.launchDescriptor) ?? sceneFromTranslatedBridge(translatedBridgePath);
  const seenPath = join(patchTarget, "REALLIVEDATA", "Seen.txt");
  if (!existsSync(seenPath)) {
    throw new PatchRuntimeLaunchError(
      "runtime_assets_missing",
      "the exact patch does not contain a RealLive Seen.txt runtime artifact",
    );
  }
  const gameexePath = gameexePathForSource(sourceRoot);
  // Utsushi accepts the conventional directory even for a scene that happens
  // not to touch a g00 asset. It will report a real runtime failure if the
  // selected scene needs an unavailable asset; do not fabricate an empty tree.
  const g00Dir = join(sourceRoot, "REALLIVEDATA", "g00");
  return { seenPath, gameexePath, g00Dir, scene };
}

type PatchApplyReceipt = {
  args: string[];
  status: number;
};

function parsePatchApplyReceipt(path: string): PatchApplyReceipt {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const apply = isRecord(raw) && isRecord(raw.apply) ? raw.apply : raw;
    if (!isRecord(apply) || !Array.isArray(apply.args) || !apply.args.every(isString)) {
      throw new Error("missing native argument receipt");
    }
    if (typeof apply.status !== "number" || !Number.isInteger(apply.status)) {
      throw new Error("missing native exit status");
    }
    return { args: [...apply.args], status: apply.status };
  } catch {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the exact patch has unreadable apply provenance for runtime launch",
    );
  }
}

function requiredArtifact(patch: PatchPlaySurface, key: string): string {
  const value = patch.artifactRefs[key];
  if (value === undefined || value.trim().length === 0) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the exact patch is missing runtime provenance",
    );
  }
  return resolve(value);
}

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the exact patch has incomplete apply provenance for runtime launch",
    );
  }
  return value;
}

function assertBoundArtifactPath(receiptPath: string, artifactPath: string): void {
  if (resolve(receiptPath) !== resolve(artifactPath)) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the exact patch apply provenance is not bound to its hash-verified artifacts",
    );
  }
}

function sceneFromDescriptor(descriptor: Record<string, unknown> | undefined): number | undefined {
  const scene = descriptor?.scene;
  if (scene === undefined) return undefined;
  if (typeof scene !== "number" || !Number.isInteger(scene) || scene < 1 || scene > 65_535) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      "launchDescriptor.scene must be a RealLive scene number between 1 and 65535",
    );
  }
  return scene;
}

function sceneFromTranslatedBridge(path: string): number {
  try {
    const bridge = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(bridge) || !Array.isArray(bridge.units)) throw new Error("missing units");
    for (const unit of bridge.units) {
      if (!isRecord(unit) || typeof unit.sourceUnitKey !== "string") continue;
      const match = /^reallive:scene-(\d{4,5})#\d+$/u.exec(unit.sourceUnitKey);
      if (match === null) continue;
      const scene = Number(match[1]);
      if (Number.isInteger(scene) && scene >= 1 && scene <= 65_535) return scene;
    }
  } catch (error) {
    if (error instanceof PatchRuntimeLaunchError) throw error;
  }
  throw new PatchRuntimeLaunchError(
    "scene_not_available",
    "the exact RealLive patch has no launchable scene; pass launchDescriptor.scene explicitly",
  );
}

function gameexePathForSource(sourceRoot: string): string {
  for (const candidate of [
    join(sourceRoot, "Gameexe.ini"),
    join(sourceRoot, "REALLIVEDATA", "Gameexe.ini"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new PatchRuntimeLaunchError(
    "runtime_assets_missing",
    "the source game configuration required by the RealLive runtime is unavailable",
  );
}

function observedTextLineCountFromRuntimeOutput(stdout: string, scene: number): number {
  const match = new RegExp(
    `${REPLAY_OBSERVED_MARKER}: scene=${String(scene)} textline_count=(\\d+)`,
    "u",
  ).exec(stdout);
  if (match === null) {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      "patched RealLive runtime completed without an observed-textline receipt",
    );
  }
  return Number(match[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
