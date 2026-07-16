// Translated-byte replay: observe the TARGET text from the patched artifact.
//
// Drives `utsushi-cli replay-validate` over a Seen.txt and captures the engine's
// OBSERVED TextLine bodies — what the VM actually decoded from those bytes. The
// caller replays the PATCHED artifact and asserts the accepted target text is
// observed; replaying the SOURCE artifact must NOT observe the target (it shows
// the untranslated source), which is what proves the observation came from the
// patched bytes rather than a planted sentinel. Uses the shared native-bin runner
// only — nothing from the old orchestrator replay home.

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
