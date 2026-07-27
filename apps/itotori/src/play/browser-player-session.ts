// Server-held RealLive browser-player sessions.
//
// A session is one long-lived `utsushi-cli live-player` child. The child owns
// the VM; this service only serialises browser requests and relays its
// redacted frame bytes. It never substitutes a cached image after an engine
// failure.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolveNativeCli, type NativeCliRunner } from "../native-bin/cli-bin-resolver.js";

/** Trusted server-side launch data. This type is never decoded from HTTP. */
export type BrowserPlayerLaunch = {
  seenPath: string;
  gameexePath: string;
  g00Dir: string;
  artifactRoot: string;
  scene: number;
};

export type BrowserPlayerInput = { type: "advance" } | { type: "choice"; index: number };

export type BrowserPlayerFrame = {
  frameId: string;
  artifactId: string;
  width: number;
  height: number;
};

export type BrowserPlayerState = {
  sessionId: string;
  scene: number;
  instructionPointer: number;
  eventIndex: number;
  waitingFor:
    | { type: "advance" }
    // `options` are the REAL option labels the engine is offering. Without
    // them the browser can only number the buttons, and every option in a
    // prompt reads identically.
    | { type: "choice"; choiceCount: number; options: string[] }
    | null;
  ended: boolean;
  frame: BrowserPlayerFrame | null;
};

type CliFrame = { path: string; artifactId: string; width: number; height: number };
type CliState = Omit<BrowserPlayerState, "sessionId" | "frame"> & { frame: CliFrame | null };

export class BrowserPlayerSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserPlayerSessionError";
  }
}

export class BrowserPlayerSessionManager {
  private readonly sessions = new Map<string, BrowserPlayerSession>();

  constructor(private readonly nativeCli: NativeCliRunner = {}) {}

  async start(input: BrowserPlayerLaunch, reveal: boolean): Promise<BrowserPlayerState> {
    validateLaunch(input);
    const sessionId = randomUUID();
    const child = LivePlayerChild.start(input, reveal, this.nativeCli);
    const session = {
      child,
      reveal,
      frames: new Map<string, { path: string; requiresReveal: boolean }>(),
    };
    this.sessions.set(sessionId, session);
    try {
      return await this.withFrame(sessionId, session, await child.next());
    } catch (error) {
      this.sessions.delete(sessionId);
      child.close();
      throw error;
    }
  }

  async send(sessionId: string, input: BrowserPlayerInput): Promise<BrowserPlayerState> {
    const session = this.require(sessionId);
    validateInput(input);
    try {
      return await this.withFrame(sessionId, session, await session.child.send(input));
    } catch (error) {
      this.sessions.delete(sessionId);
      session.child.close();
      throw error;
    }
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    session?.child.close();
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
};

class LivePlayerChild {
  private readonly pending: Array<{ resolve(value: CliState): void; reject(reason: Error): void }> =
    [];
  private stdout = "";
  private stderr = "";
  private closed = false;

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
    reveal: boolean,
    nativeCli: NativeCliRunner,
  ): LivePlayerChild {
    const env = nativeCli.env ?? process.env;
    const resolved = resolveNativeCli("utsushi-cli", env);
    const args = [
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
      "--redaction",
      reveal ? "off" : "on",
    ];
    return new LivePlayerChild(spawn(resolved.command, args, { env, stdio: "pipe" }));
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
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
  for (const value of [input.seenPath, input.gameexePath, input.g00Dir, input.artifactRoot]) {
    if (typeof value !== "string" || value.trim().length === 0)
      throw new BrowserPlayerSessionError("player launch paths are required");
  }
  if (!Number.isInteger(input.scene) || input.scene < 1 || input.scene > 65_535)
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
  return value as CliState;
}

function registerFrame(session: BrowserPlayerSession, frame: CliFrame): BrowserPlayerFrame {
  const frameId = randomUUID();
  session.frames.set(frameId, { path: frame.path, requiresReveal: session.reveal });
  return { ...frame, frameId };
}
