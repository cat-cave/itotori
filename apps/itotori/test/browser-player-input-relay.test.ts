// The browser player's server half, driven against a protocol PEER.
//
// The engine child is replaced by a stub that speaks the same newline-JSON
// protocol and reports back exactly what it was given. That is not a mock of
// the subject: the subject is the relay, and the stub is the far end it has to
// reach. The point is to make "the reader's input arrived, and a NEW state
// came back" a hard assertion that runs on every CI run, without the archive
// bytes the real-bytes e2e needs.
//
// The failure this exists for: a player that answers every input with the state
// it already had. Frame assertions cannot see it — a picture comes back either
// way — so everything below asserts on instruction pointers and on the input
// the far end actually received.

import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserPlayerSessionError,
  BrowserPlayerSessionManager,
} from "../src/play/browser-player-session.js";

/**
 * A stub engine: emits an opening state, then one fresh state per input line.
 * The instruction pointer advances by a fixed stride, and each response
 * carries back the input it was handed plus the redaction flag it was
 * launched with, so the test can prove both survived the relay.
 */
const STUB_ENGINE = `#!/usr/bin/env node
const args = process.argv.slice(2);
const redaction = args[args.indexOf("--redaction") + 1] ?? "unset";
let pointer = 1000;
let received = null;
const emit = () => {
  process.stdout.write(
    JSON.stringify({
      scene: 7,
      instructionPointer: pointer,
      eventIndex: pointer / 100,
      waitingFor: { type: "advance" },
      ended: false,
      frame: null,
      received,
      redaction,
    }) + "\\n",
  );
};
emit();
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const cut = buffered.indexOf("\\n");
    if (cut < 0) return;
    const line = buffered.slice(0, cut);
    buffered = buffered.slice(cut + 1);
    if (line.length === 0) continue;
    received = JSON.parse(line);
    pointer += 137;
    emit();
  }
});
`;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function managerWithStubEngine(): Promise<BrowserPlayerSessionManager> {
  const dir = await mkdtemp(join(tmpdir(), "itotori-player-relay-"));
  temporaryDirectories.push(dir);
  const bin = join(dir, "stub-engine");
  await writeFile(bin, STUB_ENGINE, "utf8");
  await chmod(bin, 0o755);
  return new BrowserPlayerSessionManager({ env: { ...process.env, ITOTORI_UTSUSHI_BIN: bin } });
}

const START = {
  seenPath: "/descriptor/Seen.txt",
  gameexePath: "/descriptor/Gameexe.ini",
  g00Dir: "/descriptor/g00",
  artifactRoot: "/descriptor/artifacts",
  scene: 7,
};

type Relayed = { received: { type: string; index?: number } | null; redaction: string };

describe("browser player input relay", () => {
  it("returns a distinct VM address for every input, never the opening state again", async () => {
    const manager = await managerWithStubEngine();
    const opening = await manager.start(START);
    const pointers = [opening.instructionPointer];
    for (let step = 0; step < 4; step++) {
      const next = await manager.send(opening.sessionId, { type: "advance" });
      pointers.push(next.instructionPointer);
    }
    manager.close(opening.sessionId);

    expect(pointers).toHaveLength(5);
    expect(new Set(pointers).size).toBe(5);
  });

  it("hands the engine the exact option index the reader chose", async () => {
    const manager = await managerWithStubEngine();
    const opening = await manager.start(START);
    const state = (await manager.send(opening.sessionId, {
      type: "choice",
      index: 3,
    })) as unknown as Relayed;
    manager.close(opening.sessionId);

    expect(state.received).toEqual({ type: "choice", index: 3 });
  });

  it("launches the engine with the redaction posture the surface asked for", async () => {
    const manager = await managerWithStubEngine();
    const revealed = (await manager.start({
      ...START,
      redaction: "off",
    })) as unknown as Relayed;
    manager.close((revealed as unknown as { sessionId: string }).sessionId);
    expect(revealed.redaction).toBe("off");

    const guarded = (await manager.start(START)) as unknown as Relayed;
    manager.close((guarded as unknown as { sessionId: string }).sessionId);
    expect(guarded.redaction).toBe("on");
  });

  it("refuses an input for a session it is not holding", async () => {
    const manager = await managerWithStubEngine();
    await expect(manager.send("no-such-session", { type: "advance" })).rejects.toBeInstanceOf(
      BrowserPlayerSessionError,
    );
  });

  it("drops a session whose engine died rather than answering from a stale state", async () => {
    const manager = await managerWithStubEngine();
    const opening = await manager.start(START);
    manager.close(opening.sessionId);
    await expect(manager.send(opening.sessionId, { type: "advance" })).rejects.toBeInstanceOf(
      BrowserPlayerSessionError,
    );
  });
});
