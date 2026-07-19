// Studio patchback trigger — drives the REAL `applyRealLivePatch` seam
// (the same kaifuu-cli `patch --engine reallive` path the CLI uses) from the
// SPA / HTTP boundary, then retains the patched game tree for authenticated
// download.
//
// This module NEVER invents a second patchback path: the only byte apply is
// `applyRealLivePatch` (patchback/apply.ts). Tests that must avoid a real
// subprocess inject a `runApply` double that still goes through that seam's
// argv construction; the env-gated real-bytes plan exercises the real spawn.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyRealLivePatch,
  realLivePatchArgs,
  type RealLiveApplyArgs,
  type RealLiveApplyResult,
  type RealLivePatchScope,
} from "./apply.js";
import type { NativeCliRunner } from "../native-bin/cli-bin-resolver.js";
import {
  archiveTrustedDirectory,
  type DeliveredPatchArchive,
} from "../patch-export/delivery-archive.js";

export type StudioPatchbackInput = {
  /** Read-only RealLive game root (contains REALLIVEDATA/Seen.txt). */
  gameRoot: string;
  /**
   * Server-local path to a translated v0.2 bridge JSON already on disk.
   * Exactly one of `translatedBundlePath` / `translatedBundle` must be set.
   */
  translatedBundlePath?: string;
  /** Inline translated v0.2 bridge; written to scratch before apply. */
  translatedBundle?: unknown;
  scope: RealLivePatchScope;
  force?: boolean;
};

export type StudioPatchbackOutcome = {
  patchBuildId: string;
  scope: RealLivePatchScope;
  command: string;
  /** Server-internal absolute path of the patched game tree. Never on the wire. */
  targetRoot: string;
  artifactHashes: Record<string, string>;
};

export type StudioPatchbackBuildRecord = {
  patchBuildId: string;
  scope: RealLivePatchScope;
  command: string;
  targetRoot: string;
  artifactHashes: Record<string, string>;
  createdAt: string;
};

/**
 * The apply-seam invocation, isolated so a test can prove the runner drives
 * the REAL `kaifuu-cli patch --engine reallive` argv WITHOUT spawning a
 * subprocess (the double captures the args and writes a fixture tree under
 * `targetRoot`). Defaults to the real {@link applyRealLivePatch}.
 */
export type StudioPatchbackRunnerOptions = {
  runApply?: (args: RealLiveApplyArgs) => RealLiveApplyResult;
  /** Root under which per-build trees are retained for download. */
  buildsRoot?: string;
  makeScratchDir?: () => string;
  now?: () => Date;
  log?: (message: string) => void;
  nativeCli?: NativeCliRunner;
};

export type StudioPatchbackPort = {
  runPatchback(input: StudioPatchbackInput): Promise<StudioPatchbackOutcome>;
  loadBuild(patchBuildId: string): Promise<StudioPatchbackBuildRecord | null>;
  loadArchive(patchBuildId: string): Promise<DeliveredPatchArchive | null>;
};

/** Process-scoped default builds root so mutation + download share one store
 * across per-request service factories. Tests inject an isolated `buildsRoot`. */
let defaultBuildsRoot: string | null = null;

function resolveDefaultBuildsRoot(): string {
  if (defaultBuildsRoot === null) {
    defaultBuildsRoot = mkdtempSync(join(tmpdir(), "itotori-studio-patchback-builds-"));
  }
  return defaultBuildsRoot;
}

/**
 * Build the production Studio patchback port. Each `runPatchback` call drives
 * one real `kaifuu-cli patch --engine reallive` (unless a test injects a double),
 * retains the patched tree under `buildsRoot`, and exposes it for tar download.
 */
export function createStudioPatchbackRunner(
  options: StudioPatchbackRunnerOptions = {},
): StudioPatchbackPort {
  const runApply =
    options.runApply ??
    ((args: RealLiveApplyArgs) =>
      applyRealLivePatch({
        ...args,
        ...(options.nativeCli !== undefined ? { nativeCli: options.nativeCli } : {}),
        ...(options.log !== undefined ? { log: options.log } : {}),
      }));
  const buildsRoot = options.buildsRoot ?? resolveDefaultBuildsRoot();
  mkdirSync(buildsRoot, { recursive: true });
  const makeScratchDir =
    options.makeScratchDir ??
    (() => mkdtempSync(join(tmpdir(), "itotori-studio-patchback-scratch-")));
  const now = options.now ?? (() => new Date());
  // Registry is best-effort; durable truth is meta.json under buildsRoot so a
  // fresh runner instance (per-request factory) can still serve downloads.
  const registry = new Map<string, StudioPatchbackBuildRecord>();

  return {
    async runPatchback(input: StudioPatchbackInput): Promise<StudioPatchbackOutcome> {
      assertExclusiveBundleSource(input);
      if (!existsSync(input.gameRoot)) {
        throw new StudioPatchbackError(
          "source_missing",
          `game root does not exist: ${input.gameRoot}`,
        );
      }

      const patchBuildId = randomUUID();
      const buildDir = join(buildsRoot, safeId(patchBuildId));
      const targetRoot = join(buildDir, "patched");
      mkdirSync(buildDir, { recursive: true });

      let scratchDir: string | null = null;
      let translatedBundlePath: string;
      try {
        if (input.translatedBundlePath !== undefined) {
          if (!existsSync(input.translatedBundlePath)) {
            throw new StudioPatchbackError(
              "bundle_missing",
              `translated bundle path does not exist: ${input.translatedBundlePath}`,
            );
          }
          translatedBundlePath = input.translatedBundlePath;
        } else {
          scratchDir = makeScratchDir();
          translatedBundlePath = join(scratchDir, "translated-bundle.json");
          writeFileSync(
            translatedBundlePath,
            `${JSON.stringify(input.translatedBundle, null, 2)}\n`,
          );
        }

        const applyArgs: RealLiveApplyArgs = {
          sourceRoot: input.gameRoot,
          targetRoot,
          translatedBundlePath,
          scope: input.scope,
          force: input.force ?? true,
        };
        // Drives the REAL apply seam (unless a test injects a double).
        const apply = runApply(applyArgs);
        const command = `kaifuu-cli ${realLivePatchArgs(applyArgs).join(" ")}`;
        const artifactHashes = hashPatchedArtifacts(targetRoot);
        const record: StudioPatchbackBuildRecord = {
          patchBuildId,
          scope: input.scope,
          command:
            apply.command.length > 0 ? `${apply.command} ${apply.args.join(" ")}`.trim() : command,
          targetRoot,
          artifactHashes,
          createdAt: now().toISOString(),
        };
        writeFileSync(join(buildDir, "meta.json"), `${JSON.stringify(record, null, 2)}\n`);
        registry.set(patchBuildId, record);
        return {
          patchBuildId: record.patchBuildId,
          scope: record.scope,
          command: record.command,
          targetRoot: record.targetRoot,
          artifactHashes: record.artifactHashes,
        };
      } catch (error) {
        // A failed apply must not leave a downloadable half-build.
        try {
          rmSync(buildDir, { recursive: true, force: true });
        } catch {
          // Cleanup must not mask the apply error.
        }
        throw error;
      } finally {
        if (scratchDir !== null) {
          try {
            rmSync(scratchDir, { recursive: true, force: true });
          } catch {
            // Best-effort scratch cleanup.
          }
        }
      }
    },

    async loadBuild(patchBuildId: string): Promise<StudioPatchbackBuildRecord | null> {
      const cached = registry.get(patchBuildId);
      if (cached !== undefined) return cached;
      const metaPath = join(buildsRoot, safeId(patchBuildId), "meta.json");
      if (!existsSync(metaPath)) return null;
      try {
        const raw = JSON.parse(readFileSync(metaPath, "utf8")) as StudioPatchbackBuildRecord;
        if (raw.patchBuildId !== patchBuildId) return null;
        registry.set(patchBuildId, raw);
        return raw;
      } catch {
        return null;
      }
    },

    async loadArchive(patchBuildId: string): Promise<DeliveredPatchArchive | null> {
      const build = await this.loadBuild(patchBuildId);
      if (build === null) return null;
      if (!existsSync(build.targetRoot)) return null;
      return archiveTrustedDirectory({
        root: build.targetRoot,
        fileName: `${safeId(patchBuildId)}.tar`,
      });
    },
  };
}

export class StudioPatchbackError extends Error {
  constructor(
    public readonly code: "source_missing" | "bundle_missing" | "invalid_input" | "apply_failed",
    message: string,
  ) {
    super(message);
    this.name = "StudioPatchbackError";
  }
}

function assertExclusiveBundleSource(input: StudioPatchbackInput): void {
  const hasPath =
    typeof input.translatedBundlePath === "string" && input.translatedBundlePath.length > 0;
  const hasInline = input.translatedBundle !== undefined;
  if (hasPath === hasInline) {
    throw new StudioPatchbackError(
      "invalid_input",
      "Studio patchback requires EXACTLY ONE of translatedBundlePath or translatedBundle",
    );
  }
}

function hashPatchedArtifacts(targetRoot: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const seenPath = join(targetRoot, "REALLIVEDATA", "Seen.txt");
  if (existsSync(seenPath)) {
    hashes.seenTxt = sha256File(seenPath);
  }
  // Content-address the whole tree existence via the build id directory name
  // is not enough; pin at least the primary patched archive when present.
  hashes.patchTarget = sha256Utf8(targetRoot);
  return hashes;
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function sha256Utf8(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "patch-build";
}
