import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  MalformedOwnedInputError,
  ProviderUnavailableError,
  UnsupportedSourceProfileError,
} from "@itotori/db";
import { describe, expect, it } from "vitest";

import { errorResponse } from "../src/api-handler-responses.js";
import { renderAssetDecisionsRoute } from "../src/asset-decisions/route.js";
import { readOwnedJsonFile } from "../src/cli-json-file-store.js";
import { explicitFailureApiResponse } from "../src/explicit-failure/api-response.js";
import { renderExplicitFailureHtml } from "../src/explicit-failure/render.js";
import { runPatchbackProduceCommand } from "../src/patchback/produce-cli.js";
import { PatchbackBindingError } from "../src/patchback/types.js";
import { makeAccepted, makeSnapshot, makeUnit } from "./support/gate-fixtures.js";

describe("explicit failure shipping boundary linkage", () => {
  it("uses the same dependency-light projection at the live API handler", () => {
    const error = new ProviderUnavailableError(503);
    expect(errorResponse(error)).toEqual(explicitFailureApiResponse(error));
  });

  it("uses the safe renderer from an actual rendered route", async () => {
    const error = new UnsupportedSourceProfileError("private-profile-name");
    const root = { innerHTML: "" };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(error);
    try {
      await renderAssetDecisionsRoute(root, {
        projectId: "project:one",
        localeBranchId: "locale<branch>",
        view: "policy",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(root.innerHTML).toBe(
      renderExplicitFailureHtml(error, {
        state: "asset-decisions-error",
        title: "Asset decisions unavailable",
        context: "Could not load asset decisions for locale<branch>.",
      }),
    );
    expect(root.innerHTML).toContain("locale&lt;branch&gt;");
    expect(root.innerHTML).not.toContain("private-profile-name");
  });

  it("routes production CLI JSON reads through the content-free malformed-input error", () => {
    const root = mkdtempSync(resolve(tmpdir(), "itotori-owned-json-"));
    const path = resolve(root, "input.json");
    try {
      writeFileSync(path, '{"private-source":[');
      expect(() => readOwnedJsonFile(path)).toThrowError(new MalformedOwnedInputError());
      expect(readFileSync(path, "utf8")).toContain("private-source");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("preflights stale command input before creating the owned build root", () => {
    const root = mkdtempSync(resolve(tmpdir(), "itotori-stale-command-"));
    const buildRoot = resolve(root, "build");
    const unit = makeUnit({ factId: "unit:stale-command" });
    const stale = makeAccepted(unit, "translated output", {
      sourceHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    let nativeCalls = 0;
    let outputWrites = 0;
    try {
      const error = capturePatchbackError(() =>
        runPatchbackProduceCommand({
          inputPath: "in-memory-command-input",
          outputPath: resolve(root, "receipt.json"),
          sourceRoot: resolve(root, "source"),
          buildRoot,
          scope: "dialogue-only",
          engineId: "siglus",
          nativeCli: {
            runProcess() {
              nativeCalls += 1;
              return { status: 0, stdout: "", stderr: "" };
            },
          },
          io: {
            readJson: () => ({
              snapshot: makeSnapshot({ units: [unit] }),
              accepted: [stale],
              rawBridge: readOwnedJsonFile(
                resolve(import.meta.dirname, "fixtures/whole-seen-bridge.json"),
              ),
              workScope: { inScopeUnitFactIds: [unit.factId] },
              sourceLocale: "ja-JP",
              targetLocale: "en-US",
            }),
            writeJson: () => {
              outputWrites += 1;
            },
          },
        }),
      );
      expect(error.code).toBe("source-hash-mismatch");
      expect(existsSync(buildRoot)).toBe(false);
      expect(nativeCalls).toBe(0);
      expect(outputWrites).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function capturePatchbackError(run: () => unknown): PatchbackBindingError {
  try {
    run();
  } catch (error) {
    if (error instanceof PatchbackBindingError) return error;
    throw error;
  }
  throw new Error("expected patchback binding refusal");
}
