// Studio patchback trigger — proves the SPA mutation drives the REAL
// applyRealLivePatch seam (not a mock fork) and returns a retrievable build.
//
//   1. REAL-SEAM (no subprocess): the runner builds the canonical
//      `kaifuu-cli patch --engine reallive` argv via realLivePatchArgs /
//      applyRealLivePatch, with a FAKE spawn that writes a fixture tree under
//      the exact --target path the seam requested.
//   2. RETRIEVE: loadArchive returns a tar that contains the patched Seen.txt.
//   3. WIRE-CONTRACT: parseProjectPatchbackRequest enforces exclusive bundle
//      sourcing + scope tokens.
//   4. HANDLER: the HTTP mutation gates draft.write, invokes the port, and
//      returns a downloadUrl that points at the binary archive route.
//
// Real-bytes proof (true kaifuu against a game install) is documented in
// REAL-BYTES-PLAN.md — this suite does not claim retail bytes.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createStudioPatchbackRunner,
  StudioPatchbackError,
} from "../src/patchback/studio-patchback-runner.js";
import {
  applyRealLivePatch,
  realLivePatchArgs,
  type RealLiveApplyArgs,
} from "../src/patchback/apply.js";
import type { NativeCliRunProcess } from "../src/native-bin/cli-bin-resolver.js";
import { parseProjectPatchbackRequest, assertItotoriApiResponse } from "../src/api-schema.js";
import { handleItotoriApiRequest, type ItotoriApiServices } from "../src/api-handlers.js";
import { projectPatchbackArchivePath } from "../src/api-routes.js";
import { permissionValues } from "@itotori/db";

function realSeamWithFakeSpawn(capture: { args?: RealLiveApplyArgs; argv?: string[] }) {
  return (args: RealLiveApplyArgs) =>
    applyRealLivePatch({
      ...args,
      nativeCli: {
        runProcess: ((_command, argv): ReturnType<NativeCliRunProcess> => {
          capture.args = args;
          capture.argv = argv;
          // Materialize the patched tree the seam requested (kaifuu would).
          mkdirSync(join(args.targetRoot, "REALLIVEDATA"), { recursive: true });
          writeFileSync(
            join(args.targetRoot, "REALLIVEDATA", "Seen.txt"),
            Buffer.from("patched-seen-fixture"),
          );
          writeFileSync(join(args.targetRoot, "README.patched"), "studio-patchback\n");
          return { status: 0, stdout: "ok", stderr: "" };
        }) as NativeCliRunProcess,
      },
    });
}

describe("studio patchback runner drives the REAL applyRealLivePatch seam", () => {
  it("builds the real kaifuu patch argv and retains a downloadable patched tree", async () => {
    const work = mkdtempSync(join(tmpdir(), "itotori-studio-patchback-test-"));
    const gameRoot = join(work, "game");
    const buildsRoot = join(work, "builds");
    const bundlePath = join(work, "translated.json");
    mkdirSync(join(gameRoot, "REALLIVEDATA"), { recursive: true });
    writeFileSync(join(gameRoot, "REALLIVEDATA", "Seen.txt"), "source-seen");
    writeFileSync(bundlePath, `${JSON.stringify({ schemaVersion: "0.2.0", units: [] })}\n`);

    const capture: { args?: RealLiveApplyArgs; argv?: string[] } = {};
    const runner = createStudioPatchbackRunner({
      buildsRoot,
      runApply: realSeamWithFakeSpawn(capture),
    });

    const outcome = await runner.runPatchback({
      gameRoot,
      translatedBundlePath: bundlePath,
      scope: "dialogue+choices",
      force: true,
    });

    // Real seam argv — not a stub fork.
    expect(capture.argv!.slice(capture.argv!.indexOf("patch"))).toEqual(
      realLivePatchArgs({
        sourceRoot: gameRoot,
        targetRoot: capture.args!.targetRoot,
        translatedBundlePath: bundlePath,
        scope: "dialogue+choices",
        force: true,
      }),
    );
    expect(outcome.command).toContain("patch");
    expect(outcome.command).toContain("reallive");
    expect(outcome.scope).toBe("dialogue+choices");
    expect(outcome.patchBuildId.length).toBeGreaterThan(0);
    expect(outcome.artifactHashes.seenTxt).toMatch(/^sha256:/u);

    // Retrieve: tar contains the patched Seen.txt the seam wrote.
    const archive = await runner.loadArchive(outcome.patchBuildId);
    expect(archive).not.toBeNull();
    expect(archive!.contentType).toBe("application/x-tar");
    expect(archive!.fileName.endsWith(".tar")).toBe(true);
    // Tar body is raw USTAR; the fixture file name appears as an entry path.
    expect(archive!.bytes.includes(Buffer.from("REALLIVEDATA/Seen.txt"))).toBe(true);
    expect(archive!.bytes.includes(Buffer.from("patched-seen-fixture"))).toBe(true);

    const build = await runner.loadBuild(outcome.patchBuildId);
    expect(build?.targetRoot).toBe(outcome.targetRoot);
  });

  it("accepts an inline translated bundle and still drives the real apply argv", async () => {
    const work = mkdtempSync(join(tmpdir(), "itotori-studio-patchback-inline-"));
    const gameRoot = join(work, "game");
    mkdirSync(join(gameRoot, "REALLIVEDATA"), { recursive: true });
    writeFileSync(join(gameRoot, "REALLIVEDATA", "Seen.txt"), "source");

    const capture: { args?: RealLiveApplyArgs; argv?: string[]; bundleContents?: string } = {};
    const runner = createStudioPatchbackRunner({
      buildsRoot: join(work, "builds"),
      runApply: (args) => {
        capture.bundleContents = readFileSync(args.translatedBundlePath, "utf8");
        return realSeamWithFakeSpawn(capture)(args);
      },
    });

    const outcome = await runner.runPatchback({
      gameRoot,
      translatedBundle: { schemaVersion: "0.2.0", units: [] },
      scope: "dialogue-only",
    });

    expect(capture.argv).toContain("--bundle");
    expect(capture.argv).toContain("--scope");
    expect(capture.argv![capture.argv!.indexOf("--scope") + 1]).toBe("dialogue-only");
    expect(outcome.scope).toBe("dialogue-only");
    // Inline JSON was materialized to a real path before the seam ran.
    expect(capture.args!.translatedBundlePath.length).toBeGreaterThan(0);
    expect(capture.bundleContents).toContain("0.2.0");
  });

  it("propagates a non-zero kaifuu apply failure (no silent fallback)", async () => {
    const work = mkdtempSync(join(tmpdir(), "itotori-studio-patchback-fail-"));
    const gameRoot = join(work, "game");
    mkdirSync(join(gameRoot, "REALLIVEDATA"), { recursive: true });
    writeFileSync(join(gameRoot, "REALLIVEDATA", "Seen.txt"), "source");
    writeFileSync(join(work, "bundle.json"), "{}\n");

    const runner = createStudioPatchbackRunner({
      buildsRoot: join(work, "builds"),
      runApply: (args) =>
        applyRealLivePatch({
          ...args,
          nativeCli: {
            runProcess: () => ({
              status: 7,
              stdout: "",
              stderr: "kaifuu.reallive.patchback_target_encode_failure: boom",
            }),
          },
        }),
    });

    await expect(
      runner.runPatchback({
        gameRoot,
        translatedBundlePath: join(work, "bundle.json"),
        scope: "dialogue+choices",
      }),
    ).rejects.toThrow(/kaifuu patch \(reallive\) failed/u);
  });

  it("refuses missing game root with StudioPatchbackError", async () => {
    const runner = createStudioPatchbackRunner({
      buildsRoot: mkdtempSync(join(tmpdir(), "itotori-studio-patchback-missing-")),
    });
    await expect(
      runner.runPatchback({
        gameRoot: "/no/such/game/root",
        translatedBundle: {},
        scope: "dialogue+choices",
      }),
    ).rejects.toBeInstanceOf(StudioPatchbackError);
  });
});

describe("parseProjectPatchbackRequest (wire contract)", () => {
  it("accepts a path-sourced request", () => {
    expect(
      parseProjectPatchbackRequest({
        gameRoot: "/games/sweetie",
        translatedBundlePath: "/tmp/translated.json",
        scope: "dialogue+choices",
        force: true,
      }),
    ).toEqual({
      gameRoot: "/games/sweetie",
      translatedBundlePath: "/tmp/translated.json",
      scope: "dialogue+choices",
      force: true,
    });
  });

  it("accepts an inline-bundle request", () => {
    const request = parseProjectPatchbackRequest({
      gameRoot: "/g",
      translatedBundle: { schemaVersion: "0.2.0" },
      scope: "dialogue-only",
    });
    expect(request.scope).toBe("dialogue-only");
    expect(request.translatedBundle).toEqual({ schemaVersion: "0.2.0" });
  });

  it("rejects providing both bundle sources", () => {
    expect(() =>
      parseProjectPatchbackRequest({
        gameRoot: "/g",
        translatedBundlePath: "/b",
        translatedBundle: {},
        scope: "dialogue-only",
      }),
    ).toThrow(/EXACTLY ONE of translatedBundlePath or translatedBundle/u);
  });

  it("rejects providing neither bundle source", () => {
    expect(() => parseProjectPatchbackRequest({ gameRoot: "/g", scope: "dialogue-only" })).toThrow(
      /EXACTLY ONE of translatedBundlePath or translatedBundle/u,
    );
  });

  it("rejects an invalid scope token", () => {
    expect(() =>
      parseProjectPatchbackRequest({
        gameRoot: "/g",
        translatedBundlePath: "/b",
        scope: "images",
      }),
    ).toThrow(/scope/u);
  });
});

describe("projects.patchback HTTP mutation", () => {
  it("gates draft.write, runs the port, and returns a downloadUrl", async () => {
    const work = mkdtempSync(join(tmpdir(), "itotori-studio-patchback-http-"));
    const gameRoot = join(work, "game");
    mkdirSync(join(gameRoot, "REALLIVEDATA"), { recursive: true });
    writeFileSync(join(gameRoot, "REALLIVEDATA", "Seen.txt"), "source");
    writeFileSync(join(work, "bundle.json"), "{}\n");

    const runner = createStudioPatchbackRunner({
      buildsRoot: join(work, "builds"),
      runApply: realSeamWithFakeSpawn({}),
    });
    const permissions: string[] = [];
    const services = {
      studioPatchback: runner,
      authorization: {
        async requirePermission(permission: string) {
          permissions.push(permission);
        },
      },
    } as unknown as ItotoriApiServices;

    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/projects/patchback",
        body: {
          gameRoot,
          translatedBundlePath: join(work, "bundle.json"),
          scope: "dialogue+choices",
        },
      },
      services,
    );

    expect(response.statusCode).toBe(200);
    expect(permissions).toContain(permissionValues.draftWrite);
    assertItotoriApiResponse("projects.patchback", response.body);
    const body = response.body as {
      patchBuildId: string;
      downloadUrl: string;
      command: string;
      scope: string;
    };
    expect(body.scope).toBe("dialogue+choices");
    expect(body.command).toContain("reallive");
    expect(body.downloadUrl).toBe(projectPatchbackArchivePath(body.patchBuildId));

    const archive = await runner.loadArchive(body.patchBuildId);
    expect(archive).not.toBeNull();
    expect(archive!.bytes.includes(Buffer.from("patched-seen-fixture"))).toBe(true);
  });
});
