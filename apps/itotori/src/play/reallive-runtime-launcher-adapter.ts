// RealLive runtime-launcher adapter.
//
// This is the only home for RealLive patch-play and validation details: its
// artifact layout, descriptor validation, native argv, and observed receipt.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifyLocalizationArtifactManifest } from "@itotori/db";
import { runNativeCli } from "../native-bin/cli-bin-resolver.js";
import {
  PatchRuntimeLaunchError,
  type PatchRuntimeLaunchReceipt,
  type RuntimeLaunchRequest,
  type RuntimeLauncherAdapterFactory,
} from "./runtime-launcher-registry.js";

const REPLAY_OBSERVED_MARKER = "utsushi.reallive.replay_observed_textlines_emitted";

type RealLiveLaunchDescriptor = {
  scene: number;
  gameexePath: string;
  g00Dir: string;
};

type RealLiveValidateDescriptor = RealLiveLaunchDescriptor & {
  seenPath: string;
  gameDir: string;
  replayLogPath: string;
  artifactRoot: string;
  renderOutputPath: string;
  redaction?: "on" | "off";
  sourceSeen?: string;
  bgAsset?: string;
  privateArtifactRoot?: string;
  runId?: string;
  expectTextContains?: string;
  width?: string;
  height?: string;
  printTextlines?: boolean;
};

/** Register this factory with the generic registry; no caller branches on engine id. */
export const realliveRuntimeLauncherAdapterFactory: RuntimeLauncherAdapterFactory = (deps) => ({
  manifest: {
    adapterId: "reallive",
    summary: "Replay and render validation for a RealLive patched artifact tree.",
    capabilities: ["replay-validate", "validate"],
  },

  async launch(input): Promise<PatchRuntimeLaunchReceipt> {
    const launch = launchInputs(input.patch, input.request);
    const temporaryReplayRoot =
      input.request.output === undefined
        ? mkdtempSync(join(deps.temporaryRoot ?? tmpdir(), "itotori-patch-play-"))
        : undefined;
    const replayLogPath =
      input.request.output ?? join(temporaryReplayRoot!, "observed-replay.json");

    try {
      const result = runNativeCli(
        "utsushi-cli",
        replayValidateArgs({
          artifactRoot: launch.artifactRoot,
          descriptor: launch.descriptor,
          replayLogPath,
        }),
        deps.nativeCli,
      );
      if (result.status !== 0) {
        throw new PatchRuntimeLaunchError(
          "runtime_failed",
          `patched runtime exited with status ${String(result.status)}`,
        );
      }
      const observedTextLineCount = observedTextLineCountFromRuntimeOutput(
        result.stdout,
        launch.descriptor.scene,
      );
      if (!existsSync(replayLogPath)) {
        throw new PatchRuntimeLaunchError(
          "runtime_observation_missing",
          "patched runtime completed without its observed replay receipt",
        );
      }
      return {
        adapterId: "reallive",
        operation: "replay-validate",
        adapterReceipt: {
          replay: "observed",
          scene: launch.descriptor.scene,
          observedTextLineCount,
        },
      };
    } finally {
      if (temporaryReplayRoot !== undefined) {
        rmSync(temporaryReplayRoot, { recursive: true, force: true });
      }
    }
  },

  validateCli(args): void {
    const descriptor = parseValidateDescriptor(args);
    const replayArgs = replayValidateArgs({
      artifactRoot: artifactRootForSeen(descriptor.seenPath),
      descriptor,
      replayLogPath: descriptor.replayLogPath,
      dispatchReportPath: `${descriptor.replayLogPath}.dispatch.json`,
      requireSemanticPath: true,
      ...(descriptor.printTextlines === true ? { printTextlines: true } : {}),
    });
    runNativeCommandOrThrow("validate replay", replayArgs, deps.nativeCli);

    const renderArgs = [
      "render-validate",
      "--engine",
      "reallive",
      "--seen",
      descriptor.seenPath,
      "--scene",
      String(descriptor.scene),
      "--gameexe",
      descriptor.gameexePath,
      "--game-dir",
      descriptor.gameDir,
      "--artifact-root",
      descriptor.artifactRoot,
      "--redaction",
      descriptor.redaction ?? "on",
      "--output",
      descriptor.renderOutputPath,
    ];
    appendOptional(renderArgs, "--source-seen", descriptor.sourceSeen);
    appendOptional(renderArgs, "--bg-asset", descriptor.bgAsset);
    appendOptional(renderArgs, "--private-artifact-root", descriptor.privateArtifactRoot);
    appendOptional(renderArgs, "--run-id", descriptor.runId);
    appendOptional(renderArgs, "--expect-text-contains", descriptor.expectTextContains);
    appendOptional(renderArgs, "--width", descriptor.width);
    appendOptional(renderArgs, "--height", descriptor.height);
    runNativeCommandOrThrow("validate render", renderArgs, deps.nativeCli);
  },
});

function launchInputs(
  patch: {
    status: string;
    artifactHashes: Record<string, string>;
    artifactRefs: Record<string, string>;
  },
  request: RuntimeLaunchRequest,
): { artifactRoot: string; descriptor: RealLiveLaunchDescriptor } {
  if (patch.status !== "playable") {
    throw new PatchRuntimeLaunchError(
      "patch_not_playable",
      "only a playable patch version can be opened in the runtime",
    );
  }
  try {
    verifyLocalizationArtifactManifest(patch.artifactRefs, patch.artifactHashes);
  } catch {
    throw new PatchRuntimeLaunchError(
      "artifact_integrity_failed",
      "the exact patch artifacts failed integrity verification before runtime launch",
    );
  }
  const patchTarget = requiredArtifact(patch, "patchTarget");
  const artifactRoot = resolve(request.artifactRoot ?? patchTarget);
  if (artifactRoot !== resolve(patchTarget)) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the selected runtime artifact root is not the patch's hash-verified target",
    );
  }
  const seenPath = join(artifactRoot, "REALLIVEDATA", "Seen.txt");
  if (!existsSync(seenPath)) {
    throw new PatchRuntimeLaunchError(
      "runtime_assets_missing",
      "the exact patch does not contain the runtime's script artifact",
    );
  }
  return { artifactRoot, descriptor: descriptorFromRequest(request.launchDescriptor) };
}

function descriptorFromRequest(value: Record<string, unknown>): RealLiveLaunchDescriptor {
  const namespaced = value.reallive;
  if (!isRecord(namespaced)) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      "launchDescriptor must contain the selected adapter's descriptor",
    );
  }
  return descriptorFromRecord(namespaced);
}

function descriptorFromRecord(value: Record<string, unknown>): RealLiveLaunchDescriptor {
  const scene = value.scene;
  if (typeof scene !== "number" || !Number.isInteger(scene) || scene < 1 || scene > 65_535) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      "the runtime descriptor's scene must be a number between 1 and 65535",
    );
  }
  return {
    scene,
    gameexePath: requiredDescriptorPath(value, "gameexePath"),
    g00Dir: requiredDescriptorPath(value, "g00Dir"),
  };
}

function parseValidateDescriptor(args: readonly string[]): RealLiveValidateDescriptor {
  const scene = requiredFlag(args, "--scene");
  const numericScene = Number(scene);
  const descriptor = descriptorFromRecord({
    scene: numericScene,
    gameexePath: requiredFlag(args, "--gameexe"),
    g00Dir: join(requiredFlag(args, "--game-dir"), "g00"),
  });
  const redaction = optionalFlag(args, "--redaction");
  if (redaction !== undefined && redaction !== "on" && redaction !== "off") {
    throw new Error(`itotori validate: --redaction must be 'on' or 'off', got '${redaction}'`);
  }
  return {
    ...descriptor,
    seenPath: requiredFlag(args, "--seen"),
    gameDir: requiredFlag(args, "--game-dir"),
    replayLogPath: requiredFlag(args, "--replay-log"),
    artifactRoot: requiredFlag(args, "--artifact-root"),
    renderOutputPath: requiredFlag(args, "--render-output"),
    ...(redaction === undefined ? {} : { redaction }),
    ...(optionalFlag(args, "--source-seen") === undefined
      ? {}
      : { sourceSeen: optionalFlag(args, "--source-seen")! }),
    ...(optionalFlag(args, "--bg-asset") === undefined
      ? {}
      : { bgAsset: optionalFlag(args, "--bg-asset")! }),
    ...(optionalFlag(args, "--private-artifact-root") === undefined
      ? {}
      : { privateArtifactRoot: optionalFlag(args, "--private-artifact-root")! }),
    ...(optionalFlag(args, "--run-id") === undefined
      ? {}
      : { runId: optionalFlag(args, "--run-id")! }),
    ...(optionalFlag(args, "--expect-text-contains") === undefined
      ? {}
      : { expectTextContains: optionalFlag(args, "--expect-text-contains")! }),
    ...(optionalFlag(args, "--width") === undefined
      ? {}
      : { width: optionalFlag(args, "--width")! }),
    ...(optionalFlag(args, "--height") === undefined
      ? {}
      : { height: optionalFlag(args, "--height")! }),
    ...(args.includes("--print-textlines") ? { printTextlines: true } : {}),
  };
}

function replayValidateArgs(input: {
  artifactRoot: string;
  descriptor: RealLiveLaunchDescriptor;
  replayLogPath: string;
  dispatchReportPath?: string;
  requireSemanticPath?: boolean;
  printTextlines?: boolean;
}): string[] {
  const out = [
    "replay-validate",
    "--engine",
    "reallive",
    "--artifact-root",
    input.artifactRoot,
    "--launch-descriptor",
    JSON.stringify({
      scene: input.descriptor.scene,
      gameexePath: input.descriptor.gameexePath,
      g00Dir: input.descriptor.g00Dir,
    }),
    "--print-replay-log",
    input.replayLogPath,
  ];
  if (input.printTextlines === true) out.push("--print-textlines");
  if (input.dispatchReportPath !== undefined)
    out.push("--dispatch-report", input.dispatchReportPath);
  if (input.requireSemanticPath === true) out.push("--require-semantic-reached-path");
  return out;
}

function artifactRootForSeen(seenPath: string): string {
  return dirname(dirname(resolve(seenPath)));
}

function requiredArtifact(patch: { artifactRefs: Record<string, string> }, key: string): string {
  const value = patch.artifactRefs[key];
  if (value === undefined || value.trim().length === 0) {
    throw new PatchRuntimeLaunchError(
      "patch_provenance_invalid",
      "the exact patch is missing runtime provenance",
    );
  }
  return resolve(value);
}

function requiredDescriptorPath(value: Record<string, unknown>, key: string): string {
  const path = value[key];
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      `the runtime descriptor requires '${key}'`,
    );
  }
  return path;
}

function observedTextLineCountFromRuntimeOutput(stdout: string, scene: number): number {
  const match = new RegExp(
    `${REPLAY_OBSERVED_MARKER}: scene=${String(scene)} textline_count=(\\d+)`,
    "u",
  ).exec(stdout);
  if (match === null) {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      "patched runtime completed without an observed-textline receipt",
    );
  }
  return Number(match[1]);
}

function runNativeCommandOrThrow(
  commandName: string,
  args: string[],
  nativeCli: Parameters<typeof runNativeCli>[2],
): void {
  const result = runNativeCli("utsushi-cli", args, nativeCli);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "<no output>";
    throw new Error(
      `itotori ${commandName}: utsushi-cli failed with status ${String(result.status)}: ${detail}`,
    );
  }
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
}

function requiredFlag(args: readonly string[], name: string): string {
  const value = optionalFlag(args, name);
  if (value === undefined || value.length === 0) {
    throw new Error(`itotori validate requires ${name}`);
  }
  return value;
}

function optionalFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function appendOptional(args: string[], name: string, value: string | undefined): void {
  if (value !== undefined) args.push(name, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
