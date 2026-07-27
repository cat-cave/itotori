import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AuthorizationError, permissionValues } from "@itotori/db";
import { afterEach, describe, expect, it } from "vitest";

import { createItotoriServer } from "../src/server.js";
import type { ItotoriReadOnlyServiceFactory } from "../src/services/database-services.js";

const fullFidelityBytes = Buffer.from("full-fidelity-frame-bytes-must-not-egress");
const fullFidelityUri = "artifacts/utsushi/private/session-7/full-frame.png";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("full-fidelity artifact egress boundary", () => {
  it("refuses full-fidelity bytes without reveal and returns the exact bytes with reveal", async () => {
    const root = await mkdtemp(join(tmpdir(), "itotori-artifact-reveal-"));
    temporaryDirectories.push(root);
    const managedRoot = join(root, "runtime");
    const privateRoot = join(root, "private");
    await Promise.all([
      mkdir(managedRoot, { recursive: true }),
      mkdir(join(privateRoot, "session-7"), { recursive: true }),
    ]);
    await writeFile(join(privateRoot, "session-7", "full-frame.png"), fullFidelityBytes);

    const denied = await requestArtifact({ managedRoot, privateRoot, reveal: false });
    expect(denied.status).toBe(403);
    expect(denied.bytes).not.toEqual(fullFidelityBytes);

    const allowed = await requestArtifact({ managedRoot, privateRoot, reveal: true });
    expect(allowed.status).toBe(200);
    expect(allowed.bytes).toEqual(fullFidelityBytes);
  });
});

async function requestArtifact(input: {
  managedRoot: string;
  privateRoot: string;
  reveal: boolean;
}): Promise<{ status: number; bytes: Buffer }> {
  const server = createItotoriServer({
    managedArtifactRoot: pathToFileURL(`${input.managedRoot}/`),
    privateArtifactRoot: pathToFileURL(`${input.privateRoot}/`),
    readOnlyServiceFactory: revealFactory(input.reveal),
  });
  try {
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(
      `http://127.0.0.1:${port}/artifact-store/${encodeURIComponent(fullFidelityUri)}`,
    );
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

function revealFactory(reveal: boolean): ItotoriReadOnlyServiceFactory {
  return (async (callback) =>
    await callback({
      authorization: {
        requirePermission: async (permission) => {
          expect(permission).toBe(permissionValues.catalogRead);
          if (!reveal) throw new AuthorizationError({ userId: "denied" }, permission);
        },
      },
    } as never)) as ItotoriReadOnlyServiceFactory;
}
