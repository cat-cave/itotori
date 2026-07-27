import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserPlayerSessionManager } from "../src/play/browser-player-session.js";
import { createItotoriServer } from "../src/server.js";
import type { ItotoriReadOnlyServiceFactory } from "../src/services/database-services.js";

type HttpResponse = { statusCode: number; body: Buffer };

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true })));
});

describe("browser player session lifecycle", () => {
  it("reclaims the spawned child through DELETE and sends a compact current-frame response", async () => {
    const fixture = await childFixture();
    const manager = sessionManager(fixture);
    const server = createItotoriServer({
      browserPlayerSessions: manager,
      browserPlayerLaunches: { "review-session": startBody },
      readOnlyServiceFactory: allowReveal,
    });
    try {
      await listen(server);
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const started = await call(
        origin,
        "POST",
        "/api/player/sessions",
        JSON.stringify({ session: "review-session" }),
      );
      const state = JSON.parse(started.body.toString("utf8")) as {
        sessionId: string;
        frame: { frameId: string };
      };
      expect(started.statusCode).toBe(201);
      expect(state.frame.frameId).toEqual(expect.any(String));
      expect(started.body.byteLength).toBeLessThan(1_024);
      expect(started.body.toString("utf8")).not.toContain("/output");

      const closed = await call(origin, "DELETE", `/api/player/sessions/${state.sessionId}`);
      expect(closed.statusCode).toBe(204);
      const pid = Number(await readFile(fixture.pidPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await readFile(fixture.secretPath, "utf8")).toBe("absent");
    } finally {
      if (server.listening) await closeServer(server);
      await manager.closeAll();
    }
  });

  it("reaps an idle viewer before its child can become an orphan", async () => {
    const fixture = await childFixture();
    let now = 0;
    const manager = sessionManager(fixture, { idleTimeoutMs: 10, now: () => now });
    try {
      const state = await manager.start(startBody, false);
      now = 10;
      expect(await manager.reapIdleSessions()).toBe(1);
      const pid = Number(await readFile(fixture.pidPath, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(manager.send(state.sessionId, { type: "advance" })).rejects.toThrow("not found");
    } finally {
      await manager.closeAll();
    }
  });
});

const startBody = {
  seenPath: "/input/seen",
  gameexePath: "/input/gameexe",
  g00Dir: "/input/g00",
  artifactRoot: "/output/artifacts",
  scene: 1,
};

async function childFixture(): Promise<{ binPath: string; pidPath: string; secretPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "itotori-browser-player-"));
  temporaryRoots.push(root);
  const binPath = join(root, "player-child.mjs");
  const pidPath = join(root, "child.pid");
  const secretPath = join(root, "credential-state.txt");
  await writeFile(
    binPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PLAYER_PID_PATH, String(process.pid));
writeFileSync(process.env.PLAYER_SECRET_PATH, process.env.OPENROUTER_API_KEY === undefined ? "absent" : "present");
setTimeout(() => process.stdout.write(JSON.stringify({ scene: 1, instructionPointer: 1, eventIndex: 1, waitingFor: { type: "advance" }, ended: false, frame: { path: "/output/current.png", artifactId: "current", width: 1, height: 1 } }) + "\\n"), 0);
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; if (input.includes("\\"close\\"")) process.exit(0); });
`,
  );
  await chmod(binPath, 0o755);
  return { binPath, pidPath, secretPath };
}

function sessionManager(
  fixture: { binPath: string; pidPath: string; secretPath: string },
  options: Pick<
    ConstructorParameters<typeof BrowserPlayerSessionManager>[0],
    "idleTimeoutMs" | "now"
  > = {},
): BrowserPlayerSessionManager {
  return new BrowserPlayerSessionManager({
    ...options,
    reapIntervalMs: 60_000,
    nativeCli: {
      env: {
        PATH: process.env.PATH,
        ITOTORI_UTSUSHI_BIN: fixture.binPath,
        OPENROUTER_API_KEY: "must-not-reach-the-child",
        PLAYER_PID_PATH: fixture.pidPath,
        PLAYER_SECRET_PATH: fixture.secretPath,
      },
    },
  });
}

function call(origin: string, method: string, path: string, body?: string): Promise<HttpResponse> {
  const url = new URL(origin);
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method,
        path,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolveResponse({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on("error", rejectResponse);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function listen(server: ReturnType<typeof createItotoriServer>): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function closeServer(server: ReturnType<typeof createItotoriServer>): Promise<void> {
  return new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
}

const allowReveal = (async (callback) =>
  await callback({
    authorization: { requirePermission: async () => undefined },
  } as never)) as ItotoriReadOnlyServiceFactory;
