// RealLive's render-evidence runtime operation.
//
// This adapter-owned module drives Utsushi over the hash-verified patched tree,
// then projects the emitted E2 PNG and its pixel-readback OCR receipt into the
// generic runtime-launcher shape. It deliberately never asks Utsushi to select
// a line by expected text: the real frame is selected by the decoded coordinate
// and comparison with the accepted target happens only after OCR readback.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { runNativeCli, type NativeCliRunner } from "../native-bin/cli-bin-resolver.js";
import { nativeFailureDiagnostic } from "../native-bin/native-diagnostics.js";
import {
  assertRenderInputsRemainBound,
  hashEvidenceFile,
  verifiedBackgroundAsset,
  verifiedPatchTarget,
  verifiedRuntimeAssetRoot,
} from "./reallive-runtime-render-evidence-integrity.js";
import {
  PatchRuntimeLaunchError,
  type PatchRuntimeLaunchReceipt,
  type RuntimeLaunchRequest,
  type RuntimePatchSurface,
} from "./runtime-launcher-registry.js";

const REPLAY_OBSERVED_MARKER = "utsushi.reallive.replay_observed_textlines_emitted";

type RealLiveRenderDescriptor = {
  readonly scene: number;
  readonly messageIndex: number;
  /** Immutable game assets paired with the patch. The script itself always
   * comes from the hash-verified patch target below. */
  readonly runtimeAssetRoot: string;
  readonly evidenceRoot: string;
  readonly runId: string;
  readonly replayLogPath: string;
  readonly backgroundAsset?: string;
};

/** Drive one real patched-byte frame and return only independently observed
 * raster facts. The caller may compare `ocrText` with an accepted target, but
 * this launcher never receives that target. */
export async function launchRealLiveRenderEvidence(input: {
  readonly patch: RuntimePatchSurface;
  readonly request: RuntimeLaunchRequest;
  readonly nativeCli?: NativeCliRunner;
}): Promise<PatchRuntimeLaunchReceipt> {
  const patchTarget = verifiedPatchTarget(input.patch, input.request);
  const descriptor = renderDescriptor(input.request.launchDescriptor);
  const runtimeAssetRoot = verifiedRuntimeAssetRoot(input.patch, descriptor.runtimeAssetRoot);
  const reportPath = requiredOutput(input.request.output);
  const seenPath = join(patchTarget, "REALLIVEDATA", "Seen.txt");
  const sourceSeenPath = join(runtimeAssetRoot, "REALLIVEDATA", "Seen.txt");
  const gameexePath = join(runtimeAssetRoot, "REALLIVEDATA", "Gameexe.ini");
  if (!existsSync(seenPath) || !existsSync(sourceSeenPath) || !existsSync(gameexePath)) {
    throw new PatchRuntimeLaunchError(
      "runtime_assets_missing",
      "the exact patch or its paired runtime assets are incomplete",
    );
  }
  const patchedBytesHash = hashEvidenceFile(seenPath);
  assertRenderInputsRemainBound({
    patch: input.patch,
    seenPath,
    expectedPatchedBytesHash: patchedBytesHash,
    runtimeAssetRoot,
  });
  const g00Dir = realliveG00Dir(runtimeAssetRoot);
  const backgroundAsset = verifiedBackgroundAsset(g00Dir, descriptor.backgroundAsset);
  const dispatchReportPath = `${descriptor.replayLogPath}.dispatch.json`;
  try {
    const replay = runNativeCli(
      "utsushi-cli",
      [
        "replay-validate",
        "--engine",
        "reallive",
        "--artifact-root",
        patchTarget,
        "--launch-descriptor",
        JSON.stringify({ scene: descriptor.scene, gameexePath, g00Dir }),
        "--print-replay-log",
        descriptor.replayLogPath,
        "--dispatch-report",
        dispatchReportPath,
        "--require-semantic-reached-path",
      ],
      input.nativeCli,
    );
    if (replay.status !== 0) {
      throw new PatchRuntimeLaunchError(
        "runtime_failed",
        `patched runtime replay exited with status ${String(replay.status)}: ${nativeFailureDiagnostic(replay, input.nativeCli?.env)}`,
      );
    }
    if (!existsSync(descriptor.replayLogPath)) {
      throw new PatchRuntimeLaunchError(
        "runtime_failed",
        "patched runtime replay did not produce its observed receipt before render capture",
      );
    }
    if (!replayObserved(replay.stdout, descriptor.scene)) {
      throw new PatchRuntimeLaunchError(
        "runtime_observation_missing",
        "patched runtime replay completed without observed text-line evidence",
      );
    }
    assertRenderInputsRemainBound({
      patch: input.patch,
      seenPath,
      expectedPatchedBytesHash: patchedBytesHash,
      runtimeAssetRoot,
    });

    // Utsushi's compositor necessarily creates a private full-fidelity frame
    // before deriving the redacted public PNG. It is not Q5 evidence: retain it
    // only in this owned child while the public PNG is read back, then remove it.
    const privateArtifactRoot = join(
      dirname(descriptor.evidenceRoot),
      `${basename(descriptor.evidenceRoot)}.private-uncommitted`,
    );
    try {
      const result = runNativeCli(
        "utsushi-cli",
        [
          "render-validate",
          "--engine",
          "reallive",
          "--seen",
          seenPath,
          "--scene",
          String(descriptor.scene),
          "--gameexe",
          gameexePath,
          "--game-dir",
          runtimeAssetRoot,
          "--source-seen",
          sourceSeenPath,
          "--artifact-root",
          descriptor.evidenceRoot,
          "--private-artifact-root",
          privateArtifactRoot,
          "--run-id",
          descriptor.runId,
          "--redaction",
          "on",
          "--message-index",
          String(descriptor.messageIndex),
          "--require-semantic-reached-path",
          "--output",
          reportPath,
          ...(backgroundAsset === undefined ? [] : ["--bg-asset", backgroundAsset]),
        ],
        input.nativeCli,
      );
      if (result.status !== 0) {
        throw new PatchRuntimeLaunchError(
          "runtime_failed",
          `patched runtime render exited with status ${String(result.status)}: ${nativeFailureDiagnostic(result, input.nativeCli?.env)}`,
        );
      }
      assertRenderInputsRemainBound({
        patch: input.patch,
        seenPath,
        expectedPatchedBytesHash: patchedBytesHash,
        runtimeAssetRoot,
      });
      if (!existsSync(reportPath)) {
        throw new PatchRuntimeLaunchError(
          "runtime_observation_missing",
          "patched runtime completed without a render/OCR receipt",
        );
      }
      const report = parseReport(readFileSync(reportPath, "utf8"));
      if (
        report.sceneId !== descriptor.scene ||
        report.renderedMessageIndex !== descriptor.messageIndex
      ) {
        throw new PatchRuntimeLaunchError(
          "runtime_observation_missing",
          "patched runtime receipt does not identify the requested scene and message index",
        );
      }
      if (
        report.pixelOcr.source !== "emitted-public-png" ||
        report.pixelOcr.frameSha256 !== report.artifactId
      ) {
        throw new PatchRuntimeLaunchError(
          "runtime_observation_missing",
          "patched runtime OCR receipt is not bound to its emitted public frame",
        );
      }
      const artifactPath = artifactPathFor(descriptor.evidenceRoot, report.artifactUri);
      if (!existsSync(artifactPath)) {
        throw new PatchRuntimeLaunchError(
          "runtime_observation_missing",
          "patched runtime reported a frame that is absent from its managed artifact root",
        );
      }
      const contentHash = hashEvidenceFile(artifactPath);
      if (contentHash !== `sha256:${report.artifactId}`) {
        throw new PatchRuntimeLaunchError(
          "artifact_integrity_failed",
          "patched runtime frame bytes do not match the announced artifact identity",
        );
      }
      assertRenderInputsRemainBound({
        patch: input.patch,
        seenPath,
        expectedPatchedBytesHash: patchedBytesHash,
        runtimeAssetRoot,
      });
      return {
        adapterId: "reallive",
        operation: "render-evidence",
        adapterReceipt: {
          scene: descriptor.scene,
          messageIndex: descriptor.messageIndex,
          frame: {
            artifactUri: report.artifactUri,
            artifactPath,
            contentHash,
            patchedBytesHash,
            replayObserved: true,
            width: report.width,
            height: report.height,
            ocrText: report.pixelOcr.text,
            ocrStatus:
              report.pixelOcr.status === "passed" && report.pixelOcr.unrecognizedGlyphCount === 0
                ? "PASS"
                : "FAIL",
            pixelGateStatus: report.pixelGateStatus === "passed" ? "PASS" : "FAIL",
          },
        },
      };
    } finally {
      rmSync(privateArtifactRoot, { recursive: true, force: true });
    }
  } finally {
    // Native reports carry diagnostic/OCR payloads needed only long enough to
    // verify the redacted frame. Keep no decoded or OCR text report beside the
    // retained public evidence image.
    rmSync(reportPath, { force: true });
    rmSync(descriptor.replayLogPath, { force: true });
    rmSync(dispatchReportPath, { force: true });
  }
}

function renderDescriptor(value: Record<string, unknown>): RealLiveRenderDescriptor {
  const namespaced = value.reallive;
  if (!isRecord(namespaced)) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      "launchDescriptor must contain the selected adapter's render descriptor",
    );
  }
  return {
    ...realLiveCoordinate(requiredString(namespaced.sourceUnitKey, "sourceUnitKey")),
    runtimeAssetRoot: requiredPath(namespaced.runtimeAssetRoot, "runtimeAssetRoot"),
    evidenceRoot: requiredString(namespaced.evidenceRoot, "evidenceRoot"),
    runId: requiredString(namespaced.runId, "runId"),
    replayLogPath: requiredString(namespaced.replayLogPath, "replayLogPath"),
    ...(namespaced.backgroundAsset === undefined
      ? {}
      : { backgroundAsset: requiredString(namespaced.backgroundAsset, "backgroundAsset") }),
  };
}

/** Source-unit coordinates are an engine-owned contract. Keeping the parser in
 * this adapter means the generic render producer never learns RealLive's
 * `scene#message` spelling; another runtime registers its own parser. */
function realLiveCoordinate(
  sourceUnitKey: string,
): Pick<RealLiveRenderDescriptor, "scene" | "messageIndex"> {
  const match = /^reallive:scene-(\d{1,5})#(\d+)$/u.exec(sourceUnitKey);
  if (match === null) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      "the runtime render descriptor has no RealLive source-unit coordinate",
    );
  }
  const scene = Number(match[1]);
  if (!Number.isInteger(scene) || scene < 1 || scene > 65_535) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      "the runtime render descriptor's source scene is out of range",
    );
  }
  const messageIndex = Number(match[2]);
  if (!Number.isSafeInteger(messageIndex) || messageIndex < 0) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      "the runtime render descriptor's message index is out of range",
    );
  }
  return { scene, messageIndex };
}

function requiredOutput(output: string | undefined): string {
  if (output === undefined || output.trim().length === 0) {
    throw new PatchRuntimeLaunchError(
      "invalid_launch_descriptor",
      "render-evidence requires an owned report output path",
    );
  }
  return output;
}

function parseReport(raw: string): {
  readonly sceneId: number;
  readonly renderedMessageIndex: number;
  readonly artifactUri: string;
  readonly artifactId: string;
  readonly width: number;
  readonly height: number;
  readonly pixelGateStatus: string;
  readonly pixelOcr: {
    readonly text: string;
    readonly status: string;
    readonly unrecognizedGlyphCount: number;
    readonly frameSha256: string;
    readonly source: string;
  };
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      "patched runtime emitted an unreadable render/OCR receipt",
    );
  }
  if (!isRecord(value) || !isRecord(value.pixelOcr) || !isRecord(value.pixelGate)) {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      "patched runtime receipt has no pixel OCR evidence",
    );
  }
  const artifactId = requiredString(value.artifactId, "artifactId");
  if (!/^[a-f0-9]{64}$/u.test(artifactId)) {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      "patched runtime receipt has an invalid frame identity",
    );
  }
  return {
    sceneId: positiveInteger(value.sceneId, "sceneId"),
    renderedMessageIndex: nonNegativeInteger(value.renderedMessageIndex, "renderedMessageIndex"),
    artifactUri: requiredString(value.artifactUri, "artifactUri"),
    artifactId,
    width: positiveInteger(value.width, "width"),
    height: positiveInteger(value.height, "height"),
    pixelGateStatus: requiredString(value.pixelGate.status, "pixelGate.status"),
    pixelOcr: {
      // An empty public-frame readback is itself an OCR failure that must be
      // projected into RenderAndOcrResult, not rejected before renderOcrGate
      // can record the deterministic defect.
      text: stringValue(value.pixelOcr.text, "pixelOcr.text"),
      status: requiredString(value.pixelOcr.status, "pixelOcr.status"),
      unrecognizedGlyphCount: nonNegativeInteger(
        value.pixelOcr.unrecognizedGlyphCount,
        "pixelOcr.unrecognizedGlyphCount",
      ),
      frameSha256: requiredString(value.pixelOcr.frameSha256, "pixelOcr.frameSha256"),
      source: requiredString(value.pixelOcr.source, "pixelOcr.source"),
    },
  };
}

function artifactPathFor(root: string, uri: string): string {
  const managedPrefix = "artifacts/utsushi/runtime/";
  if (!uri.startsWith(managedPrefix) || uri.includes("..")) {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      "patched runtime receipt has an unmanaged frame URI",
    );
  }
  const resolvedRoot = resolve(root);
  // RuntimeArtifactRoot treats the managed URI prefix as an identifier namespace,
  // not a directory under its owned root. Its public PNG is therefore rooted at
  // the URI's managed tail (`<run>/screenshots/<hash>.png`).
  const path = resolve(resolvedRoot, uri.slice(managedPrefix.length));
  const traversal = relative(resolvedRoot, path);
  if (traversal === "" || traversal.startsWith("..") || traversal.includes("../")) {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      "patched runtime receipt resolves its frame outside the managed artifact root",
    );
  }
  return path;
}

function replayObserved(stdout: string, scene: number): boolean {
  const match = new RegExp(
    `${REPLAY_OBSERVED_MARKER}: scene=${String(scene)} textline_count=(\\d+)`,
    "u",
  ).exec(stdout);
  return match !== null && Number(match[1]) > 0;
}

function realliveG00Dir(patchTarget: string): string {
  const fallback = join(patchTarget, "REALLIVEDATA", "g00");
  const candidates = [
    fallback,
    join(patchTarget, "REALLIVEDATA", "G00"),
    join(patchTarget, "g00"),
    join(patchTarget, "G00"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? fallback;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      `patched runtime receipt has an invalid ${label}`,
    );
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      `patched runtime receipt has an invalid ${label}`,
    );
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      `patched runtime receipt has no ${label}`,
    );
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new PatchRuntimeLaunchError(
      "runtime_observation_missing",
      `patched runtime receipt has no ${label}`,
    );
  }
  return value;
}

function requiredPath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  return resolve(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
