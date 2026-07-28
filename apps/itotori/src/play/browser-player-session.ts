// Server-held engine browser-player sessions.
//
// A session is one long-lived Utsushi child. The child owns the VM; this
// service only serialises browser requests and relays its redacted frame
// bytes. It never substitutes a cached image after an engine failure.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  resolveNativeCli,
  scrubLiveProviderSecrets,
  type NativeCliRunner,
} from "../native-bin/cli-bin-resolver.js";

/** A viewer that has been quiet for this long cannot retain an engine VM. */
export const BROWSER_PLAYER_SESSION_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Check often enough to reclaim an abandoned tab without keeping Node alive. */
export const BROWSER_PLAYER_SESSION_REAP_INTERVAL_MS = 30_000;
const BROWSER_PLAYER_CLOSE_GRACE_MS = 1_000;

/** Trusted RealLive launch data. This type is never decoded from HTTP. */
export type RealLiveBrowserPlayerLaunch = {
  engine?: "reallive";
  seenPath: string;
  gameexePath: string;
  g00Dir: string;
  artifactRoot: string;
  scene: number;
};

/** Trusted Softpal launch data. Only a title-authored POINT.DAT entry executes. */
export type SoftpalBrowserPlayerLaunch = {
  engine: "softpal";
  gameRoot: string;
  artifactRoot: string;
  pointId: number;
};

/** Trusted Siglus launch data. Full frames stay in the private sibling root. */
export type SiglusBrowserPlayerLaunch = {
  engine: "siglus";
  gameRoot: string;
  artifactRoot: string;
  scene: number;
};

export type BrowserPlayerLaunch =
  | RealLiveBrowserPlayerLaunch
  | SiglusBrowserPlayerLaunch
  | SoftpalBrowserPlayerLaunch;

export type BrowserPlayerInput =
  | { type: "advance" }
  | { type: "pointer" }
  | { type: "choice"; index: number };

export type BrowserPlayerFrame = {
  frameId: string;
  artifactId: string;
  width: number;
  height: number;
};

/** Decoder-to-static-oracle accounting emitted by engines that can provide it. */
export type BrowserPlayerOracleOverlap = {
  executed: number;
  ordered: number;
  static: number;
};

export type BrowserPlayerState = {
  sessionId: string;
  scene: number;
  instructionPointer: number;
  eventIndex: number;
  waitingFor:
    | { type: "advance" }
    | { type: "pointer" }
    // `options` are the REAL option labels the engine is offering. Without
    // them the browser can only number the buttons, and every option in a
    // prompt reads identically.
    | { type: "choice"; choiceCount: number; options: string[] }
    | null;
  ended: boolean;
  frame: BrowserPlayerFrame | null;
  /** Present only when the live engine has a static dialogue oracle. */
  oracleOverlap?: BrowserPlayerOracleOverlap;
};

type CliFrame = { path: string; artifactId: string; width: number; height: number };
type CliState = Omit<BrowserPlayerState, "sessionId" | "frame"> & { frame: CliFrame | null };

export type BrowserPlayerSessionOptions = {
  nativeCli?: NativeCliRunner;
  idleTimeoutMs?: number;
  reapIntervalMs?: number;
  now?: () => number;
};

export class BrowserPlayerSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserPlayerSessionError";
  }
}

export class BrowserPlayerSessionManager {
  private readonly sessions = new Map<string, BrowserPlayerSession>();
  private readonly nativeCli: NativeCliRunner;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly reaper: NodeJS.Timeout;

  constructor(options: BrowserPlayerSessionOptions = {}) {
    this.nativeCli = options.nativeCli ?? {};
    this.idleTimeoutMs = options.idleTimeoutMs ?? BROWSER_PLAYER_SESSION_IDLE_TIMEOUT_MS;
    const reapIntervalMs = options.reapIntervalMs ?? BROWSER_PLAYER_SESSION_REAP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    if (this.idleTimeoutMs <= 0 || reapIntervalMs <= 0)
      throw new Error("browser player session timeouts must be positive");
    this.reaper = setInterval(() => void this.reapIdleSessions(), reapIntervalMs);
    this.reaper.unref();
  }

  async start(input: BrowserPlayerLaunch, reveal: boolean): Promise<BrowserPlayerState> {
    validateLaunch(input);
    const sessionId = randomUUID();
    const child = LivePlayerChild.start(input, sessionId, reveal, this.nativeCli);
    const session = {
      child,
      reveal,
      frames: new Map<string, { path: string; requiresReveal: boolean }>(),
      lastActivityMs: this.now(),
    };
    this.sessions.set(sessionId, session);
    try {
      return await this.withFrame(sessionId, session, await child.next());
    } catch (error) {
      this.sessions.delete(sessionId);
      await child.close();
      throw error;
    }
  }

  async send(sessionId: string, input: BrowserPlayerInput): Promise<BrowserPlayerState> {
    const session = this.require(sessionId);
    validateInput(input);
    try {
      const state = await this.withFrame(sessionId, session, await session.child.send(input));
      session.lastActivityMs = this.now();
      return state;
    } catch (error) {
      this.sessions.delete(sessionId);
      await session.child.close();
      throw error;
    }
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    await session?.child.close();
  }

  async closeAll(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.sessions.keys()].map(async (sessionId) => this.close(sessionId)));
  }

  async reapIdleSessions(): Promise<number> {
    const deadline = this.now() - this.idleTimeoutMs;
    const stale = [...this.sessions.entries()]
      .filter(([, session]) => session.lastActivityMs <= deadline)
      .map(([sessionId]) => sessionId);
    await Promise.all(stale.map(async (sessionId) => this.close(sessionId)));
    return stale.length;
  }

  async readFrame(sessionId: string, frameId: string, reveal: boolean): Promise<Buffer> {
    const frame = this.require(sessionId).frames.get(frameId);
    if (frame === undefined)
      throw new BrowserPlayerSessionError("browser player frame was not found");
    if (frame.requiresReveal && !reveal)
      throw new BrowserPlayerSessionError("reveal capability is required for this frame");
    return await readFile(frame.path);
  }

  private require(sessionId: string): BrowserPlayerSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined)
      throw new BrowserPlayerSessionError("browser player session was not found");
    return session;
  }

  private async withFrame(
    sessionId: string,
    session: BrowserPlayerSession,
    state: CliState,
  ): Promise<BrowserPlayerState> {
    const frame = state.frame === null ? null : registerFrame(session, state.frame);
    return { ...state, sessionId, frame };
  }
}

type BrowserPlayerSession = {
  child: LivePlayerChild;
  reveal: boolean;
  frames: Map<string, { path: string; requiresReveal: boolean }>;
  lastActivityMs: number;
};

class LivePlayerChild {
  private readonly pending: Array<{ resolve(value: CliState): void; reject(reason: Error): void }> =
    [];
  private stdout = "";
  private stderr = "";
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    child.on("error", (error) => this.fail(error));
    child.on("close", (code) => {
      if (!this.closed)
        this.fail(
          new BrowserPlayerSessionError(
            `player engine exited with status ${String(code)}: ${this.stderr.trim()}`,
          ),
        );
    });
  }

  static start(
    input: BrowserPlayerLaunch,
    runId: string,
    reveal: boolean,
    nativeCli: NativeCliRunner,
  ): LivePlayerChild {
    const env = nativeCli.env ?? process.env;
    const resolved = resolveNativeCli("utsushi-cli", env);
    const args =
      input.engine === "siglus"
        ? [
            ...resolved.prefixArgs,
            "siglus-live-player",
            "--game-root",
            input.gameRoot,
            "--scene",
            String(input.scene),
            "--artifact-root",
            input.artifactRoot,
            "--run-id",
            runId,
            "--redaction",
            "on",
          ]
        : input.engine === "softpal"
        ? [
            ...resolved.prefixArgs,
            "softpal-live-player",
            "--game-root",
            input.gameRoot,
            "--point",
            String(input.pointId),
            "--artifact-root",
            input.artifactRoot,
            "--run-id",
            runId,
            "--redaction",
            "on",
          ]
        : [
            ...resolved.prefixArgs,
            "live-player",
            "--seen",
            input.seenPath,
            "--scene",
            String(input.scene),
            "--gameexe",
            input.gameexePath,
            "--g00-dir",
            input.g00Dir,
            "--artifact-root",
            input.artifactRoot,
            "--run-id",
            runId,
            "--redaction",
            "on",
          ];
    if (reveal) args.push("--reveal");
    return new LivePlayerChild(
      spawn(resolved.command, args, { env: scrubLiveProviderSecrets(env), stdio: "pipe" }),
    );
  }

  next(): Promise<CliState> {
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  async send(input: BrowserPlayerInput): Promise<CliState> {
    if (this.closed) throw new BrowserPlayerSessionError("browser player session is closed");
    const response = this.next();
    this.child.stdin.write(`${JSON.stringify(input)}\n`);
    return await response;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    if (this.child.exitCode !== null) return Promise.resolve();
    this.closePromise = new Promise((resolve) => {
      const forceKill = setTimeout(() => this.child.kill(), BROWSER_PLAYER_CLOSE_GRACE_MS);
      forceKill.unref();
      this.child.once("close", () => {
        clearTimeout(forceKill);
        resolve();
      });
      this.child.stdin.end('{"type":"close"}\n');
    });
    return this.closePromise;
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    for (;;) {
      const index = this.stdout.indexOf("\n");
      if (index < 0) return;
      const line = this.stdout.slice(0, index);
      this.stdout = this.stdout.slice(index + 1);
      if (line.length === 0) continue;
      const pending = this.pending.shift();
      if (pending === undefined) continue;
      try {
        pending.resolve(parseCliState(JSON.parse(line) as unknown));
      } catch (error) {
        pending.reject(
          error instanceof Error ? error : new BrowserPlayerSessionError(String(error)),
        );
      }
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    while (this.pending.length > 0) this.pending.shift()!.reject(error);
  }
}

function validateLaunch(input: BrowserPlayerLaunch): void {
  const paths =
    input.engine === "siglus" || input.engine === "softpal"
      ? [input.gameRoot, input.artifactRoot]
      : [input.seenPath, input.gameexePath, input.g00Dir, input.artifactRoot];
  for (const value of paths) {
    if (typeof value !== "string" || value.trim().length === 0)
      throw new BrowserPlayerSessionError("player launch paths are required");
  }
  const entry = input.engine === "softpal" ? input.pointId : input.scene;
  if (!Number.isInteger(entry) || entry < 1 || entry > 65_535)
    throw new BrowserPlayerSessionError("player scene must be an integer between 1 and 65535");
}

function validateInput(input: BrowserPlayerInput): void {
  if (
    input.type === "choice" &&
    (!Number.isInteger(input.index) || input.index < 0 || input.index > 65_535)
  ) {
    throw new BrowserPlayerSessionError(
      "player choice index must be an integer between 0 and 65535",
    );
  }
}

function parseCliState(value: unknown): CliState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("scene" in value) ||
    !("instructionPointer" in value) ||
    !("eventIndex" in value)
  ) {
    throw new BrowserPlayerSessionError("player engine emitted an invalid session response");
  }
  if ("oracleOverlap" in value && !isOracleOverlap(value.oracleOverlap)) {
    throw new BrowserPlayerSessionError("player engine emitted an invalid oracle overlap");
  }
  return value as CliState;
}

function isOracleOverlap(value: unknown): value is BrowserPlayerOracleOverlap {
  if (typeof value !== "object" || value === null) return false;
  const overlap = value as Record<string, unknown>;
  return (
    isCount(overlap.executed) &&
    isCount(overlap.ordered) &&
    isCount(overlap.static) &&
    overlap.ordered <= overlap.executed &&
    overlap.executed <= overlap.static
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function registerFrame(session: BrowserPlayerSession, frame: CliFrame): BrowserPlayerFrame {
  const frameId = randomUUID();
  session.frames.clear();
  session.frames.set(frameId, { path: frame.path, requiresReveal: session.reveal });
  return {
    frameId,
    artifactId: frame.artifactId,
    width: frame.width,
    height: frame.height,
  };
}
