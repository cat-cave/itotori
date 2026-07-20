// Env-gated real-Sweetie oracle: a real rendered frame resolves through the
// EXISTING sanitized artifact server + the DEFAULT-REDACTED frame surface.
//
// Runs only when `ITOTORI_REAL_GAME_ROOT` points at a real RealLive install
// (never committed). It drives the REAL image producer end to end:
//   1. utsushi structure           -> the entry scene id
//   2. utsushi render-validate      -> a real E2 screenshot (PUBLIC redacted PNG
//                                      under a managed artifact root; the full-
//                                      fidelity PNG stays in a private temp dir)
//   3. buildMediaRef                -> a content-addressed, reference-only ref
//   4. createItotoriServer          -> the real /artifact-store/ surface
//   5. resolveMediaRef              -> observed redaction + typed failures
// and proves the guarantees only real (copyrighted) bytes can prove:
//   - a real Sweetie ref resolves through the sanitized server and is REDACTED
//     by default (the committed proof never reveals a copyrighted frame);
//   - a reveal without the cap is an explicit unauthorized-reveal (the clear
//     copyrighted frame is never served);
//   - tampering the ref hash is an explicit hash-mismatch;
//   - a missing artifact is an explicit missing error.
// NO bytes are committed: every artifact lives in an OS temp dir. When the
// corpus is not staged the test prints a visible skip note.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { runNativeCli } from "../src/native-bin/cli-bin-resolver.js";
import { runUtsushiStructureExport } from "../src/structure-export/utsushi-structure-seam.js";
import { createItotoriServer } from "../src/server.js";
import {
  buildMediaIndex,
  buildMediaRef,
  mediaForSubject,
  resolveMediaRef,
  sanitizedArtifactFetcher,
  MediaResolutionError,
  type MediaRevealGrant,
} from "../src/wiki/media-index.js";

function findCorpus(
  dir: string,
  depth = 0,
): { gameexe: string; seen: string; gameRoot: string } | undefined {
  const seen = join(dir, "REALLIVEDATA", "Seen.txt");
  const gameexe = join(dir, "REALLIVEDATA", "Gameexe.ini");
  if (existsSync(seen) && existsSync(gameexe)) return { gameexe, seen, gameRoot: dir };
  if (depth >= 3) return undefined;
  for (const entry of readdirSync(dir)) {
    const child = join(dir, entry);
    try {
      if (statSync(child).isDirectory()) {
        const found = findCorpus(child, depth + 1);
        if (found) return found;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function realCorpus(): { gameexe: string; seen: string; gameRoot: string } | undefined {
  const root = process.env.ITOTORI_REAL_GAME_ROOT;
  if (root === undefined || root.trim() === "") return undefined;
  return findCorpus(root);
}

const ADMIN_VIEW: MediaRevealGrant = {
  heldPermission: "restricted",
  revealSensitive: true,
  revealIntent: false,
  shareRedaction: false,
};

describe("real-Sweetie media ref resolution through the sanitized server", () => {
  const corpus = realCorpus();
  const maybe = corpus ? it : it.skip;
  if (!corpus) {
    it("SKIP: real corpus not staged (set ITOTORI_REAL_GAME_ROOT)", () => {
      console.warn(
        "[wiki-media-index-real-bytes] ITOTORI_REAL_GAME_ROOT not set — skipping the real-frame resolution oracle.",
      );
      expect(true).toBe(true);
    });
  }

  maybe(
    "PROOF: a real rendered frame resolves redacted-by-default; reveal/tamper/missing fail loud",
    async () => {
      const c = corpus!;
      const workDir = mkdtempSync(join(tmpdir(), "itotori-media-real-"));
      const structurePath = join(workDir, "structure.json");
      const managedDir = join(workDir, "managed");
      const privateDir = join(workDir, "private");
      const reportPath = join(workDir, "render-report.json");
      mkdirSync(managedDir, { recursive: true });
      mkdirSync(privateDir, { recursive: true });

      // 1. Entry scene from the real structure export.
      runUtsushiStructureExport({
        engine: "reallive",
        gameexePath: c.gameexe,
        seenPath: c.seen,
        outputPath: structurePath,
      });
      const structure = JSON.parse(readFileSync(structurePath, "utf8")) as { entryScene?: number };
      const sceneId = structure.entryScene;
      expect(typeof sceneId).toBe("number");

      // 2. Render a real E2 screenshot into the managed artifact root.
      const runId = "media-index-real";
      const render = runNativeCli("utsushi-cli", [
        "render-validate",
        "--engine",
        "reallive",
        "--seen",
        c.seen,
        "--source-seen",
        c.seen,
        "--scene",
        String(sceneId),
        "--gameexe",
        c.gameexe,
        "--game-dir",
        c.gameRoot,
        "--artifact-root",
        managedDir,
        "--private-artifact-root",
        privateDir,
        "--redaction",
        "on",
        "--run-id",
        runId,
        "--output",
        reportPath,
      ]);
      expect(render.status, render.stderr || render.stdout).toBe(0);

      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        artifactUri: string;
        artifactPath: string;
        width: number;
        height: number;
      };

      // 3. Content-address the PUBLIC (redacted) frame the server will serve.
      const publicBytes = readFileSync(report.artifactPath);
      const contentHash = `sha256:${createHash("sha256").update(publicBytes).digest("hex")}`;

      // 4. Stand up the REAL sanitized artifact server over the managed root.
      const server = createItotoriServer({ managedArtifactRoot: pathToFileURL(`${managedDir}/`) });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}`;
      try {
        const facts = {
          artifactUri: report.artifactUri,
          contentHash,
          mediaType: "image/png" as const,
          dimensions: { width: report.width, height: report.height },
          access: { redaction: "default-redacted" as const, permission: "project-member" as const },
        };
        const ref = buildMediaRef(
          { kind: "screenshot", mediaId: "real-frame-1", sceneId: String(sceneId) },
          facts,
        );

        // Reference-only: the ref carries no bytes.
        expect(JSON.stringify(ref)).not.toContain("data:");
        const index = buildMediaIndex([ref]);
        expect(mediaForSubject(index, { kind: "scene", id: String(sceneId) })).toHaveLength(1);

        // (a) default: resolves through the server, REDACTED (copyrighted frame
        //     stays behind the default-on toggle).
        const resolved = await resolveMediaRef(ref, {
          fetchArtifactBytes: sanitizedArtifactFetcher(baseUrl),
          grant: ADMIN_VIEW,
        });
        expect(resolved.redacted).toBe(true);
        expect(resolved.dimensions).toEqual({ width: report.width, height: report.height });

        // (b) reveal without the cap -> explicit unauthorized-reveal (never serves clear).
        await expect(
          resolveMediaRef(ref, {
            fetchArtifactBytes: sanitizedArtifactFetcher(baseUrl),
            grant: {
              heldPermission: "project-member",
              revealSensitive: false,
              revealIntent: true,
              shareRedaction: false,
            },
          }),
        ).rejects.toMatchObject({ code: "unauthorized-reveal" });

        // (c) tampered hash -> explicit hash-mismatch.
        const tampered = buildMediaRef(
          { kind: "screenshot", mediaId: "real-frame-tampered", sceneId: String(sceneId) },
          {
            ...facts,
            contentHash: `sha256:${createHash("sha256").update("planted").digest("hex")}`,
          },
        );
        await expect(
          resolveMediaRef(tampered, {
            fetchArtifactBytes: sanitizedArtifactFetcher(baseUrl),
            grant: ADMIN_VIEW,
          }),
        ).rejects.toMatchObject({ name: "MediaResolutionError", code: "hash-mismatch" });

        // (d) missing artifact -> explicit missing.
        const missing = buildMediaRef(
          { kind: "screenshot", mediaId: "real-frame-missing", sceneId: String(sceneId) },
          {
            ...facts,
            artifactUri: `artifacts/utsushi/runtime/${runId}/screenshots/absent.png`,
          },
        );
        await expect(
          resolveMediaRef(missing, {
            fetchArtifactBytes: sanitizedArtifactFetcher(baseUrl),
            grant: ADMIN_VIEW,
          }),
        ).rejects.toBeInstanceOf(MediaResolutionError);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
    600_000,
  );
});
