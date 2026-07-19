// Translated-byte replay: observe the TARGET text from the patched artifact.
//
// Drives `utsushi-cli replay-validate` over a Seen.txt and captures the engine's
// OBSERVED TextLine bodies — what the VM actually decoded from those bytes. The
// caller replays the PATCHED artifact and asserts the accepted target text is
// observed; replaying the SOURCE artifact must NOT observe the target (it shows
// the untranslated source), which is what proves the observation came from the
// patched bytes rather than a planted sentinel. Uses the shared native-bin runner
// only — nothing from the old orchestrator replay home.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { assertPatchExportV02, type PatchExportV02 } from "@itotori/localization-bridge-schema";

import { runNativeCli, type NativeCliRunner } from "../native-bin/cli-bin-resolver.js";

export type ReplayObserveArgs = {
  /** Path to the Seen.txt whose bytes are replayed (patched OR source). */
  seenPath: string;
  sceneId: number;
  gameexePath: string;
  g00Dir: string;
  /** Where the deterministic ReplayLog JSON is written. */
  replayLogPath: string;
  nativeCli?: NativeCliRunner;
};

export type ObservedReplay = {
  status: number;
  /** Every observed TextLine body the engine decoded, in emission order. */
  observedBodies: string[];
  /** The `textline_count` from the OK diagnostic (null if replay failed). */
  textLineCount: number | null;
  stdout: string;
  stderr: string;
};

/** A complete translated-byte observation for one scene addressed by a strict
 * PatchExportV02. Both artifacts are replayed: the patched bytes must expose
 * every accepted target for the scene, while the source bytes must expose none
 * of them. */
export type AcceptedPatchReplayScene = {
  sceneId: number;
  entryIds: readonly string[];
  patched: ObservedReplay;
  source: ObservedReplay;
};

export type AcceptedPatchReplay = {
  scenes: readonly AcceptedPatchReplayScene[];
};

export type ReplayAcceptedPatchArgs = {
  /** Strict export whose target bodies must be observed from the patched bytes. */
  patchExport: PatchExportV02;
  /** The Seen.txt emitted by the native Kaifuu apply. */
  patchedSeenPath: string;
  /** The pre-apply source Seen.txt; replaying it rules out source-byte replay. */
  sourceSeenPath: string;
  gameexePath: string;
  g00Dir: string;
  /** Directory for deterministic per-scene source/patched replay logs. */
  replayLogDirectory: string;
  nativeCli?: NativeCliRunner;
};

export class ReplayObserveError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = "ReplayObserveError";
  }
}

export class AcceptedPatchReplayError extends Error {
  constructor(
    public readonly code:
      | "empty-patch-export"
      | "invalid-source-unit-key"
      | "target-not-observed"
      | "target-visible-in-source",
    public readonly entryIds: readonly string[],
    message: string,
  ) {
    super(
      `accepted patch replay refused (${code}): ${message}; entries: ${[...entryIds].sort().join(", ")}`,
    );
    this.name = "AcceptedPatchReplayError";
  }
}

/** The exact `utsushi-cli replay-validate` argv (without the resolver prefix). */
export function replayValidateArgs(args: ReplayObserveArgs): string[] {
  return [
    "replay-validate",
    "--engine",
    "reallive",
    "--seen",
    args.seenPath,
    "--scene",
    String(args.sceneId),
    "--gameexe",
    args.gameexePath,
    "--g00-dir",
    args.g00Dir,
    "--print-replay-log",
    args.replayLogPath,
    "--print-textlines",
  ];
}

/**
 * Parse the observed TextLine bodies from the `--print-textlines` stdout. Each
 * body is emitted as `textline[<i>] pc=0x<hex> body=<debug-quoted string>`; we
 * decode the trailing debug-quoted literal back to its text. A body that is not
 * a clean quoted literal is kept verbatim so an assertion never silently loses a
 * line.
 */
export function parseObservedBodies(stdout: string): string[] {
  const bodies: string[] = [];
  const marker = " body=";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("textline[")) continue;
    const at = line.indexOf(marker);
    if (at < 0) continue;
    bodies.push(decodeDebugQuoted(line.slice(at + marker.length)));
  }
  return bodies;
}

/** Best-effort decode of a Rust `{:?}` debug-quoted string (JSON-compatible for
 * the ASCII target markers we assert on). Falls back to the raw text. */
function decodeDebugQuoted(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** The `textline_count=<n>` value from the OK diagnostic, or null. */
function parseTextLineCount(stdout: string): number | null {
  const match = stdout.match(/textline_count=(\d+)/u);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/**
 * Replay a Seen.txt and return the observed TextLine bodies. Throws
 * {@link ReplayObserveError} only when the driver itself fails (unreadable /
 * unparseable bytes); a scene that emits zero text lines is a successful replay
 * with an empty observation (the caller's target assertion surfaces the miss).
 */
export function replayObserve(args: ReplayObserveArgs): ObservedReplay {
  const res = runNativeCli("utsushi-cli", replayValidateArgs(args), args.nativeCli ?? {});
  if (res.status !== 0) {
    throw new ReplayObserveError(
      res.status,
      res.stderr,
      `utsushi replay-validate failed with status ${String(res.status)}: ${res.stderr.trim() || res.stdout.trim() || "<no output>"}`,
    );
  }
  return {
    status: res.status,
    observedBodies: parseObservedBodies(res.stdout),
    textLineCount: parseTextLineCount(res.stdout),
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

/** True when any observed TextLine body contains `needle`. */
export function observedTextContains(observed: ObservedReplay, needle: string): boolean {
  return observed.observedBodies.some((body) => body.includes(needle));
}

/**
 * Replay every scene addressed by a strict PatchExportV02 and bind the result
 * back to its accepted target bodies. This is the whole-scope replay boundary:
 * it cannot silently check only a caller-picked scene, and it proves the text
 * comes from the patched artifact by rejecting a target visible in the source
 * artifact too.
 */
export function replayAcceptedPatch(args: ReplayAcceptedPatchArgs): AcceptedPatchReplay {
  assertPatchExportV02(args.patchExport);
  if (args.patchExport.entries.length === 0) {
    throw new AcceptedPatchReplayError(
      "empty-patch-export",
      [],
      "PatchExportV02 contains no accepted targets to replay",
    );
  }

  const entriesByScene = new Map<number, PatchExportV02["entries"]>();
  for (const entry of args.patchExport.entries) {
    const sceneId = sceneIdFromSourceUnitKey(entry.sourceUnitKey);
    if (sceneId === undefined) {
      throw new AcceptedPatchReplayError(
        "invalid-source-unit-key",
        [entry.entryId],
        `entry sourceUnitKey ${entry.sourceUnitKey} is not a RealLive scene key`,
      );
    }
    const entries = entriesByScene.get(sceneId) ?? [];
    entries.push(entry);
    entriesByScene.set(sceneId, entries);
  }

  mkdirSync(args.replayLogDirectory, { recursive: true });
  const scenes: AcceptedPatchReplayScene[] = [];
  for (const [sceneId, entries] of [...entriesByScene.entries()].sort(([a], [b]) => a - b)) {
    const patched = replayObserve({
      seenPath: args.patchedSeenPath,
      sceneId,
      gameexePath: args.gameexePath,
      g00Dir: args.g00Dir,
      replayLogPath: join(
        args.replayLogDirectory,
        `patched-scene-${String(sceneId).padStart(4, "0")}.json`,
      ),
      ...(args.nativeCli !== undefined ? { nativeCli: args.nativeCli } : {}),
    });
    const source = replayObserve({
      seenPath: args.sourceSeenPath,
      sceneId,
      gameexePath: args.gameexePath,
      g00Dir: args.g00Dir,
      replayLogPath: join(
        args.replayLogDirectory,
        `source-scene-${String(sceneId).padStart(4, "0")}.json`,
      ),
      ...(args.nativeCli !== undefined ? { nativeCli: args.nativeCli } : {}),
    });

    for (const entry of entries) {
      const observedTarget = stripOutOfBandControlMarkup(entry.targetText);
      if (!observedTextContains(patched, observedTarget)) {
        throw new AcceptedPatchReplayError(
          "target-not-observed",
          [entry.entryId],
          `patched scene ${sceneId} did not emit accepted target ${JSON.stringify(observedTarget)}`,
        );
      }
      if (observedTextContains(source, observedTarget)) {
        throw new AcceptedPatchReplayError(
          "target-visible-in-source",
          [entry.entryId],
          `source scene ${sceneId} also emitted accepted target ${JSON.stringify(observedTarget)}`,
        );
      }
    }
    scenes.push({ sceneId, entryIds: entries.map((entry) => entry.entryId), patched, source });
  }
  return { scenes };
}

function sceneIdFromSourceUnitKey(sourceUnitKey: string): number | undefined {
  const match = /^reallive:scene-(\d{1,5})#\d+$/u.exec(sourceUnitKey);
  if (match === null) return undefined;
  const sceneId = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(sceneId) && sceneId >= 0 && sceneId <= 65_535 ? sceneId : undefined;
}

/** Mirrors Kaifuu's structural handling of the synthetic kidoku marker: it is
 * preserved in control bytes, not emitted as dialogue text by Utsushi. */
function stripOutOfBandControlMarkup(text: string): string {
  const marker = "<reallive.kidoku ";
  let output = "";
  let rest = text;
  while (true) {
    const start = rest.indexOf(marker);
    if (start < 0) return output + rest;
    output += rest.slice(0, start);
    const end = rest.indexOf(">", start + marker.length);
    if (end < 0) return output + rest.slice(start);
    rest = rest.slice(end + 1);
  }
}
