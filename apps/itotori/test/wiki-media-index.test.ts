// Content-addressed Wiki media references resolve only through the existing
// sanitized artifact server. This suite uses generated, non-copyrighted bytes
// and an actual HTTP server; no byte payload is placed in a WikiObject.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createItotoriServer } from "../src/server.js";
import {
  buildMediaIndex,
  buildMediaRef,
  mediaForSubject,
  mediaSubject,
  resolveMediaRef,
  sanitizedArtifactFetcher,
  sanitizedArtifactUrl,
  MediaIndexError,
  type MediaArtifactFacts,
  type MediaRevealGrant,
} from "../src/wiki/media-index.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const ARTIFACT_URI = "artifacts/utsushi/runtime/test-run/screenshots/frame.png";

const ADMIN_VIEW: MediaRevealGrant = {
  heldPermission: "restricted",
  revealSensitive: true,
  revealIntent: false,
  shareRedaction: false,
};

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("content-addressed Wiki media index", () => {
  let server: ReturnType<typeof createItotoriServer>;
  let serverBaseUrl: string;
  let facts: MediaArtifactFacts;

  beforeAll(async () => {
    const managedDir = mkdtempSync(join(tmpdir(), "itotori-media-index-"));
    mkdirSync(join(managedDir, "test-run", "screenshots"), { recursive: true });
    writeFileSync(join(managedDir, "test-run", "screenshots", "frame.png"), ONE_PIXEL_PNG);

    server = createItotoriServer({ managedArtifactRoot: pathToFileURL(`${managedDir}/`) });
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", () => resolveListen()),
    );
    serverBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    facts = {
      artifactUri: ARTIFACT_URI,
      contentHash: sha256(ONE_PIXEL_PNG),
      mediaType: "image/png",
      dimensions: { width: 1, height: 1 },
      access: { redaction: "default-redacted", permission: "project-member" },
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  function screenshot(overrides: Partial<MediaArtifactFacts> = {}) {
    return buildMediaRef(
      { kind: "screenshot", mediaId: "media-shot-1", sceneId: "scene-1017", unitId: "unit-3" },
      { ...facts, ...overrides },
    );
  }

  it("binds portrait, screenshot, and CG subjects to native metadata without bytes", () => {
    const portrait = buildMediaRef(
      { kind: "portrait", mediaId: "media-portrait", characterId: "character-rin" },
      facts,
    );
    const shot = screenshot();
    const cg = buildMediaRef({ kind: "cg", mediaId: "media-cg", assetId: "cg-7" }, facts);

    expect(mediaSubject(portrait)).toEqual({ kind: "character", id: "character-rin" });
    expect(mediaSubject(shot)).toEqual({ kind: "scene", id: "scene-1017", unitId: "unit-3" });
    expect(mediaSubject(cg)).toEqual({ kind: "asset", id: "cg-7" });
    expect(shot.availability).toEqual({ status: "available", ...facts });
    expect(sanitizedArtifactUrl(serverBaseUrl, ARTIFACT_URI)).toBe(
      `${serverBaseUrl}/artifact-store/${encodeURIComponent(ARTIFACT_URI)}`,
    );

    for (const ref of [portrait, shot, cg]) {
      const serialized = JSON.stringify(ref);
      expect(serialized).not.toContain("data:");
      expect(serialized).not.toContain("base64");
      expect(serialized).not.toContain("iVBOR");
    }
  });

  it("rejects HTTP, traversal, and malformed metadata instead of storing a non-Utsushi URI", () => {
    expect(() => screenshot({ artifactUri: "https://media.example/frame.png" })).toThrow();
    expect(() =>
      screenshot({ artifactUri: "artifacts/utsushi/runtime/test-run/../frame.png" }),
    ).toThrow();
    expect(() => screenshot({ contentHash: "not-a-hash" })).toThrow();
    expect(() => screenshot({ dimensions: { width: 0, height: 1 } })).toThrow();
  });

  it("indexes native refs by stable subject and content hash, rejecting divergent media IDs", () => {
    const initial = screenshot();
    const portrait = buildMediaRef(
      { kind: "portrait", mediaId: "media-portrait", characterId: "character-rin" },
      facts,
    );
    const index = buildMediaIndex([initial, portrait]);
    expect(mediaForSubject(index, { kind: "scene", id: "scene-1017" })).toEqual([initial]);
    expect(index.byContentHash.get(facts.contentHash)).toEqual([initial, portrait]);
    expect(() => buildMediaIndex([initial, initial])).not.toThrow();
    expect(() =>
      buildMediaIndex([initial, screenshot({ contentHash: sha256(Buffer.from("tampered")) })]),
    ).toThrow(MediaIndexError);
  });

  it("resolves a hash-verified native ref through the artifact server redacted by default", async () => {
    const resolved = await resolveMediaRef(screenshot(), {
      fetchArtifactBytes: sanitizedArtifactFetcher(serverBaseUrl),
      grant: ADMIN_VIEW,
    });

    expect(resolved).toEqual({
      mediaId: "media-shot-1",
      subject: { kind: "scene", id: "scene-1017", unitId: "unit-3" },
      artifactUri: ARTIFACT_URI,
      mediaType: "image/png",
      dimensions: { width: 1, height: 1 },
      redacted: true,
    });
    expect(JSON.stringify(resolved)).not.toContain("iVBOR");
  });

  it("fails loudly for missing media and a mismatched served hash through the artifact server", async () => {
    await expect(
      resolveMediaRef(
        screenshot({ artifactUri: "artifacts/utsushi/runtime/test-run/screenshots/missing.png" }),
        { fetchArtifactBytes: sanitizedArtifactFetcher(serverBaseUrl), grant: ADMIN_VIEW },
      ),
    ).rejects.toMatchObject({ code: "missing" });

    await expect(
      resolveMediaRef(screenshot({ contentHash: sha256(Buffer.from("not the served pixel")) }), {
        fetchArtifactBytes: sanitizedArtifactFetcher(serverBaseUrl),
        grant: ADMIN_VIEW,
      }),
    ).rejects.toMatchObject({ code: "hash-mismatch" });
  });

  it("denies an unauthorized clear reveal while the default frame remains redacted", async () => {
    await expect(
      resolveMediaRef(screenshot(), {
        fetchArtifactBytes: sanitizedArtifactFetcher(serverBaseUrl),
        grant: {
          heldPermission: "project-member",
          revealSensitive: false,
          revealIntent: true,
          shareRedaction: false,
        },
      }),
    ).rejects.toMatchObject({ code: "unauthorized-reveal" });
  });
});
