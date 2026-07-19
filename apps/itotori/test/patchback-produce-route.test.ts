// Route-wiring behavior for POST /api/patchback/produce.
//
// These drive the REAL HTTP boundary (`createItotoriServer`) with an injected
// service factory — no DB, no native op. They pin the produce route's contract:
//   - an ABSENT `patchbackProduce` port returns a loud, documented 501 even when
//     the services object is the cutover Proxy (whose `get` yields a throwing
//     fallback for absent surfaces) — the `Reflect.has` presence-check must win,
//     never a Proxy TypeError surfaced as 500 (PR #320);
//   - a configured port streams the produced tar (200);
//   - a null produce plan is a clean 404;
//   - a non-POST method is 405.
// The REAL byte-producing seam is proven separately in patchback-produce-build.

import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { createItotoriServer } from "../src/server.js";
import type { ItotoriServiceFactory } from "../src/services/database-services.js";
import type { DeliveredPatchArchive } from "../src/patch-export/delivery-archive.js";

type RawHttpResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

function httpCall(
  origin: string,
  method: string,
  path: string,
  body?: string,
): Promise<RawHttpResponse> {
  const url = new URL(origin);
  return new Promise((resolveResponse, rejectResponse) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method,
        path,
        agent: false,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolveResponse({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", rejectResponse);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function listenOnLoopback(server: ReturnType<typeof createItotoriServer>): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const rejectOnError = (error: Error) => rejectListen(error);
    server.once("error", rejectOnError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectOnError);
      resolveListen();
    });
  });
}

/** A services stand-in that mimics the cutover Proxy: an absent surface is
 * present as a THROWING fallback via `get`, but `has` reports it absent. A
 * truthiness check on `services.patchbackProduce` would sail past this and hit
 * the throwing fallback (500); only `Reflect.has` correctly sees it as absent. */
function cutoverProxyServices(present: Record<string, unknown>): unknown {
  return new Proxy(present, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      return () => {
        throw new Error(`service ${String(prop)} is not configured (cutover fallback)`);
      };
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
  });
}

function serverWithServices(
  present: Record<string, unknown>,
): ReturnType<typeof createItotoriServer> {
  const services = cutoverProxyServices(present);
  const serviceFactory = ((callback) =>
    Promise.resolve(callback(services as never))) as ItotoriServiceFactory;
  return createItotoriServer({ serviceFactory });
}

async function withServer(
  present: Record<string, unknown>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = serverWithServices(present);
  try {
    await listenOnLoopback(server);
    const port = (server.address() as AddressInfo).port;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      );
    }
  }
}

const cannedArchive: DeliveredPatchArchive = {
  contentType: "application/x-tar",
  fileName: "produced-build.tar",
  bytes: Buffer.from("REALLIVEDATA-tar-bytes"),
};

describe("POST /api/patchback/produce route wiring", () => {
  it("returns a loud 501 (not 500) when the produce port is absent on the cutover Proxy", async () => {
    await withServer({}, async (origin) => {
      const response = await httpCall(origin, "POST", "/api/patchback/produce", "{}");
      expect(response.statusCode).toBe(501);
      const payload = JSON.parse(response.body.toString("utf8")) as {
        code?: string;
        error?: string;
      };
      expect(payload.code).toBe("internal_error");
      expect(payload.error ?? "").toContain("not configured");
      // The Proxy TypeError ("service patchbackProduce is not configured (cutover
      // fallback)") must NOT be what surfaces — the presence-check caught it first.
      expect(payload.error ?? "").not.toContain("cutover fallback");
    });
  });

  it("streams the produced tar (200) when the produce port is configured", async () => {
    const present = {
      patchbackProduce: { produceArchive: async () => cannedArchive },
    };
    await withServer(present, async (origin) => {
      const response = await httpCall(origin, "POST", "/api/patchback/produce", "{}");
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/x-tar");
      expect(String(response.headers["content-disposition"])).toContain("produced-build.tar");
      expect(response.body.equals(cannedArchive.bytes)).toBe(true);
    });
  });

  it("returns 404 when the produce plan resolves to no eligible run", async () => {
    const present = { patchbackProduce: { produceArchive: async () => null } };
    await withServer(present, async (origin) => {
      const response = await httpCall(origin, "POST", "/api/patchback/produce", "{}");
      expect(response.statusCode).toBe(404);
    });
  });

  it("returns 405 for a non-POST method", async () => {
    const present = { patchbackProduce: { produceArchive: async () => cannedArchive } };
    await withServer(present, async (origin) => {
      const response = await httpCall(origin, "GET", "/api/patchback/produce");
      expect(response.statusCode).toBe(405);
    });
  });
});
