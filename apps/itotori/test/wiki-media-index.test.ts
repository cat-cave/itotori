// Content-addressed Wiki media index — reference-only binding + resolution.
//
// Proves every RB-032 clause on NON-COPYRIGHTED bytes (a 1x1 generated PNG),
// resolving through the REAL sanitized artifact server (`createItotoriServer`'s
// `/artifact-store/` surface) and the REAL redaction rule (`shouldRedactFrame`
// via the resolver). The env-gated sibling suite re-runs the same resolution on
// a real rendered Sweetie frame; this suite proves the mechanism itself.
//
// No bytes are ever committed: the fixture PNG is generated in-process and
// written to a temp dir the OS reclaims.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createItotoriServer } from "../src/server.js";
import {
  buildMediaIndex,
  buildMediaRef,
  collectMediaRefs,
  httpArtifactFetcher,
  mediaForSubject,
  mediaSubject,
  MediaIndexError,
  MediaResolutionError,
  resolveMediaRef,
  sanitizedArtifactUrl,
  toUnavailableMediaRef,
  type MediaArtifactFacts,
  type MediaRevealGrant,
} from "../src/wiki/media-index.js";
import type { MediaRef, WikiObject } from "../src/contracts/index.js";

// A genuinely non-copyrighted 1x1 PNG (a single generated pixel).
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function sha256Ref(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const MANAGED_ROOT_PREFIX = "artifacts/utsushi/runtime";

const ADMIN_GRANT: MediaRevealGrant = {
  heldPermission: "restricted",
  revealSensitive: true,
  revealIntent: false,
  shareRedaction: false,
};

describe("content-addressed Wiki media index", () => {
  let serverBaseUrl: string;
  let server: ReturnType<typeof createItotoriServer>;
  let managedDir: string;
  let goodUri: string;
  let goodHash: string;

  beforeAll(async () => {
    managedDir = mkdtempSync(join(tmpdir(), "itotori-media-index-"));
    const relative = "run-a/screenshots/frame-0.png";
    mkdirSync(join(managedDir, "run-a", "screenshots"), { recursive: true });
    writeFileSync(join(managedDir, relative), ONE_PIXEL_PNG);
    goodHash = sha256Ref(ONE_PIXEL_PNG);

    server = createItotoriServer({
      managedArtifactRoot: pathToFileURL(`${managedDir}/`),
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const port = (server.address() as AddressInfo).port;
    serverBaseUrl = `http://127.0.0.1:${port}`;
    goodUri = sanitizedArtifactUrl(serverBaseUrl, `${MANAGED_ROOT_PREFIX}/${relative}`);
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  function facts(overrides: Partial<MediaArtifactFacts> = {}): MediaArtifactFacts {
    return {
      artifactUri: goodUri,
      contentHash: goodHash,
      mediaType: "image/png",
      dimensions: { width: 1, height: 1 },
      access: { redaction: "default-redacted", permission: "project-member" },
      ...overrides,
    };
  }

  const screenshotRef = () =>
    buildMediaRef({ kind: "screenshot", mediaId: "media-shot-1", sceneId: "1017" }, facts());

  // -- Clause 1: bind subject -> uri/hash/type/dims/policy, no inlined bytes ---

  it("PROOF: a MediaRef binds a stable subject to uri/hash/type/dims/policy with no bytes", () => {
    const portrait = buildMediaRef(
      { kind: "portrait", mediaId: "m-p", characterId: "char-rin" },
      facts(),
    );
    const shot = buildMediaRef(
      { kind: "screenshot", mediaId: "m-s", sceneId: "1017", unitId: "u-3" },
      facts(),
    );
    const cg = buildMediaRef({ kind: "cg", mediaId: "m-c", assetId: "cg-07" }, facts());

    expect(mediaSubject(portrait)).toEqual({ kind: "character", id: "char-rin" });
    expect(mediaSubject(shot)).toEqual({ kind: "scene", id: "1017", unitId: "u-3" });
    expect(mediaSubject(cg)).toEqual({ kind: "asset", id: "cg-07" });

    // available availability carries exactly URI + hash + type + dims + policy.
    expect(shot.availability).toEqual({
      status: "available",
      artifactUri: goodUri,
      contentHash: goodHash,
      mediaType: "image/png",
      dimensions: { width: 1, height: 1 },
      access: { redaction: "default-redacted", permission: "project-member" },
    });

    // Reference-only: the serialized ref carries no bytes / data: URI, and is
    // tiny (a URI + a hash + a policy — never a pixel blob).
    for (const ref of [portrait, shot, cg]) {
      const serialized = JSON.stringify(ref);
      expect(serialized).not.toContain("data:");
      expect(serialized).not.toContain("base64");
      expect(serialized.length).toBeLessThan(1_024);
    }
  });

  it("PROOF: the builder never fabricates a hash/URI/dimension (strict validation)", () => {
    expect(() =>
      buildMediaRef({ kind: "cg", mediaId: "m", assetId: "a" }, facts({ contentHash: "deadbeef" })),
    ).toThrow();
    expect(() =>
      buildMediaRef(
        { kind: "cg", mediaId: "m", assetId: "a" },
        facts({ artifactUri: "not a url" }),
      ),
    ).toThrow();
    expect(() =>
      buildMediaRef(
        { kind: "cg", mediaId: "m", assetId: "a" },
        facts({ dimensions: { width: 0, height: 1 } }),
      ),
    ).toThrow();
  });

  // -- Index: content-addressed, subject-keyed, conflict-explicit -------------

  it("PROOF: the index binds subjects + content hashes and rejects a divergent media id", () => {
    const wikiObjects: WikiObject[] = [
      { media: [screenshotRef()] } as unknown as WikiObject,
      {
        media: [
          buildMediaRef({ kind: "portrait", mediaId: "media-p", characterId: "char-rin" }, facts()),
        ],
      } as unknown as WikiObject,
    ];
    const refs = collectMediaRefs(wikiObjects);
    const index = buildMediaIndex(refs);

    expect(mediaForSubject(index, { kind: "scene", id: "1017" }).map((r) => r.mediaId)).toEqual([
      "media-shot-1",
    ]);
    expect(
      mediaForSubject(index, { kind: "character", id: "char-rin" }).map((r) => r.mediaId),
    ).toEqual(["media-p"]);
    expect(index.byContentHash.get(goodHash)?.length).toBe(2);

    // Idempotent collection (the exact same ref twice) is allowed.
    expect(() => buildMediaIndex([screenshotRef(), screenshotRef()])).not.toThrow();

    // Same media id, divergent hash -> explicit conflict (content-addressed).
    const divergent = buildMediaRef(
      { kind: "screenshot", mediaId: "media-shot-1", sceneId: "1017" },
      facts({ contentHash: sha256Ref(Buffer.from("other")) }),
    );
    expect(() => buildMediaIndex([screenshotRef(), divergent])).toThrow(MediaIndexError);
  });

  // -- Clause 3: resolve through the sanitized server + redacted surface ------

  it("PROOF: a ref resolves through the sanitized artifact server, redacted by default", async () => {
    const resolved = await resolveMediaRef(screenshotRef(), {
      fetchArtifactBytes: httpArtifactFetcher,
      grant: { ...ADMIN_GRANT, revealIntent: false },
    });
    expect(resolved.redacted).toBe(true);
    expect(resolved.artifactUri).toBe(goodUri);
    expect(resolved.dimensions).toEqual({ width: 1, height: 1 });
    // Reference-only handle: no bytes leaked into the resolved surface.
    expect(Object.keys(resolved).sort()).toEqual(
      ["artifactUri", "dimensions", "mediaId", "mediaType", "redacted", "subject"].sort(),
    );
  });

  it("PROOF: an authorized cap-holder reveal clears redaction; share/export forces it back", async () => {
    const revealed = await resolveMediaRef(screenshotRef(), {
      fetchArtifactBytes: httpArtifactFetcher,
      grant: {
        heldPermission: "restricted",
        revealSensitive: true,
        revealIntent: true,
        shareRedaction: false,
      },
    });
    expect(revealed.redacted).toBe(false);

    // Non-sensitive (clear-policy) media is never redacted.
    const clear = await resolveMediaRef(
      buildMediaRef(
        { kind: "screenshot", mediaId: "m-clear", sceneId: "1017" },
        facts({ access: { redaction: "clear", permission: "public" } }),
      ),
      {
        fetchArtifactBytes: httpArtifactFetcher,
        grant: {
          heldPermission: null,
          revealSensitive: false,
          revealIntent: false,
          shareRedaction: false,
        },
      },
    );
    expect(clear.redacted).toBe(false);
  });

  // -- Clause 2: explicit typed failures --------------------------------------

  it("PROOF: a missing artifact is an explicit missing error", async () => {
    const ref = buildMediaRef(
      { kind: "screenshot", mediaId: "m-missing", sceneId: "1017" },
      facts({
        artifactUri: sanitizedArtifactUrl(
          serverBaseUrl,
          `${MANAGED_ROOT_PREFIX}/run-a/screenshots/absent.png`,
        ),
      }),
    );
    await expect(
      resolveMediaRef(ref, { fetchArtifactBytes: httpArtifactFetcher, grant: ADMIN_GRANT }),
    ).rejects.toMatchObject({ name: "MediaResolutionError", code: "missing" });
  });

  it("PROOF: a served-byte hash mismatch is an explicit hash-mismatch error", async () => {
    const ref = buildMediaRef(
      { kind: "screenshot", mediaId: "m-tampered", sceneId: "1017" },
      facts({ contentHash: sha256Ref(Buffer.from("a different artifact")) }),
    );
    await expect(
      resolveMediaRef(ref, { fetchArtifactBytes: httpArtifactFetcher, grant: ADMIN_GRANT }),
    ).rejects.toMatchObject({ name: "MediaResolutionError", code: "hash-mismatch" });
  });

  it("PROOF: an unauthorized reveal is explicit and never serves a clear frame", async () => {
    const ref = screenshotRef();

    // (a) reveal intent without the revealSensitive cap.
    await expect(
      resolveMediaRef(ref, {
        fetchArtifactBytes: httpArtifactFetcher,
        grant: {
          heldPermission: "project-member",
          revealSensitive: false,
          revealIntent: true,
          shareRedaction: false,
        },
      }),
    ).rejects.toMatchObject({ code: "unauthorized-reveal" });

    // (b) reveal intent in share/export mode (redaction forced on).
    await expect(
      resolveMediaRef(ref, {
        fetchArtifactBytes: httpArtifactFetcher,
        grant: {
          heldPermission: "restricted",
          revealSensitive: true,
          revealIntent: true,
          shareRedaction: true,
        },
      }),
    ).rejects.toMatchObject({ code: "unauthorized-reveal" });

    // (c) insufficient permission tier — refused before any fetch happens.
    let fetched = false;
    const restricted = buildMediaRef(
      { kind: "cg", mediaId: "m-restricted", assetId: "cg-secret" },
      facts({ access: { redaction: "default-redacted", permission: "restricted" } }),
    );
    await expect(
      resolveMediaRef(restricted, {
        fetchArtifactBytes: async () => {
          fetched = true;
          return ONE_PIXEL_PNG;
        },
        grant: {
          heldPermission: "public",
          revealSensitive: false,
          revealIntent: false,
          shareRedaction: false,
        },
      }),
    ).rejects.toMatchObject({ code: "unauthorized-reveal" });
    expect(fetched).toBe(false);
  });

  it("PROOF: an already-unavailable ref surfaces its recorded reason", async () => {
    const unavailable = toUnavailableMediaRef(screenshotRef(), "hash-mismatch");
    expect(unavailable.availability).toEqual({
      status: "unavailable",
      expectedContentHash: goodHash,
      reason: "hash-mismatch",
    });
    await expect(
      resolveMediaRef(unavailable, { fetchArtifactBytes: httpArtifactFetcher, grant: ADMIN_GRANT }),
    ).rejects.toMatchObject({ code: "hash-mismatch" });
  });

  it("PROOF: resolution errors carry the media id for propagation", async () => {
    try {
      await resolveMediaRef(toUnavailableMediaRef(screenshotRef(), "missing"), {
        fetchArtifactBytes: httpArtifactFetcher,
        grant: ADMIN_GRANT,
      });
      expect.unreachable("resolution should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaResolutionError);
      expect((error as MediaResolutionError).mediaId).toBe("media-shot-1");
    }
  });
});

// A compile-time reminder that the resolved handle carries no byte field.
const _referenceOnly: keyof Awaited<ReturnType<typeof resolveMediaRef>> extends
  | "mediaId"
  | "subject"
  | "artifactUri"
  | "mediaType"
  | "dimensions"
  | "redacted"
  ? true
  : never = true;
void _referenceOnly;
void (null as unknown as MediaRef);
