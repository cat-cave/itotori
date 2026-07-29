import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { readFirstExistingStaticFile, StaticFileReadError } from "../src/server.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("static-file probing", () => {
  it("does not turn an operational read failure into content from a later root", async () => {
    const failedRoot = await temporaryRoot();
    const fallbackRoot = await temporaryRoot();
    await mkdir(join(failedRoot, "app.js"));
    await writeFile(join(fallbackRoot, "app.js"), "fallback asset");

    await expect(
      readFirstExistingStaticFile("app.js", [
        pathToFileURL(`${failedRoot}/`),
        pathToFileURL(`${fallbackRoot}/`),
      ]),
    ).rejects.toMatchObject({
      name: StaticFileReadError.name,
      path: join(failedRoot, "app.js"),
      cause: expect.objectContaining({ code: "EISDIR" }),
    });
  });

  it("returns null only when every candidate is genuinely absent", async () => {
    const root = await temporaryRoot();

    await expect(
      readFirstExistingStaticFile("missing.js", [pathToFileURL(`${root}/`)]),
    ).resolves.toBeNull();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "itotori-static-file-"));
  temporaryRoots.push(root);
  return root;
}
