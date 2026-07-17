import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createItotoriServer } from "../src/server.js";

const outsideRootContents = "outside-artifact-root-secret";

type RawHttpResponse = {
  statusCode: number;
  body: string;
};

function getRawPath(origin: string, path: string): Promise<RawHttpResponse> {
  const url = new URL(origin);
  return new Promise((resolveResponse, rejectResponse) => {
    // `http.request` sends `path` as supplied, unlike URL-based clients that
    // normalize dot segments before the request reaches the server.
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        method: "GET",
        path,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolveResponse({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", rejectResponse);
    request.end();
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

async function assertOutsideRootRequestIsRejected(path: string): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "itotori-artifact-dot-segment-"));
  // Two directory levels make `../../outside-secret.txt` resolve to this file
  // if either artifact URI validation or rooted-file confinement regresses.
  const managedArtifactRoot = join(tempRoot, "configured", "managed-artifacts");
  const publicFixtureArtifactRoot = join(tempRoot, "configured", "public-fixtures");
  const outsideRootPath = join(tempRoot, "outside-secret.txt");
  await Promise.all([
    mkdir(managedArtifactRoot, { recursive: true }),
    mkdir(publicFixtureArtifactRoot, { recursive: true }),
    writeFile(outsideRootPath, outsideRootContents),
  ]);

  const server = createItotoriServer({
    managedArtifactRoot: pathToFileURL(`${managedArtifactRoot}/`),
    publicFixtureArtifactRoot: pathToFileURL(`${publicFixtureArtifactRoot}/`),
  });

  try {
    await listenOnLoopback(server);
    const port = (server.address() as AddressInfo).port;
    const response = await getRawPath(`http://127.0.0.1:${port}`, path);

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(outsideRootContents);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      );
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

describe("artifact-store dot-segment requests", () => {
  it("returns 400 and never serves outside-root bytes for literal dot-dot segments", async () => {
    await assertOutsideRootRequestIsRejected(
      "/artifact-store/artifacts/utsushi/runtime/../../outside-secret.txt",
    );
  });

  it("returns 400 and never serves outside-root bytes for percent-encoded dot-dot segments", async () => {
    await assertOutsideRootRequestIsRejected(
      "/artifact-store/artifacts/utsushi/runtime/%2e%2e/%2e%2e/outside-secret.txt",
    );
  });

  it("returns 400 and never serves outside-root bytes for encoded slash dot-dot segments", async () => {
    await assertOutsideRootRequestIsRejected(
      "/artifact-store/artifacts/utsushi/runtime/%2e%2e%2f%2e%2e%2foutside-secret.txt",
    );
  });

  it("returns 400 and never serves outside-root bytes for mixed-case encoded dot and slash segments", async () => {
    await assertOutsideRootRequestIsRejected(
      "/artifact-store/artifacts/utsushi/runtime/%2E%2e%2F..%2Foutside-secret.txt",
    );
  });
});
