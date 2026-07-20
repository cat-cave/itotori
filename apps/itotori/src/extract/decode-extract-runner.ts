// p3-in-studio-decode-extract-trigger — the REAL decode/extract runner behind
// the Studio `projects.decodeExtract` mutation.
//
// The Studio's "decode from game path" trigger no longer requires an operator to
// hand-produce a bridge JSON on the CLI. This runner drives the SAME real decode
// path the CLI `itotori extract` command drives — `kaifuu-cli extract --engine
// <engine>` for the request's REQUIRED engine discriminant (resolved through the
// extract-adapter registry + spawned through the ONE sanitized native-CLI
// boundary) — writes the v0.2 BridgeBundle kaifuu produces to a scratch path,
// reads it back, validates it against the bridge-schema authority, and hands it
// to the workflow for ingestion.
//
// This module NEVER fabricates a bridge: the only bytes it returns are the ones
// kaifuu-cli wrote from real game bytes. Tests that must avoid a real subprocess
// inject a `runExtract` double (the same seam `kaifuu-extract-seam` exposes);
// the env-gated real-Sweetie proof exercises the real spawn.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBridgeBundleV02, type BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import {
  runKaifuuExtract,
  type ExtractSource,
  type KaifuuExtractArgs,
  type KaifuuExtractResult,
} from "./kaifuu-extract-seam.js";

/**
 * A Studio decode/extract REQUEST — the engine-discriminated source union the
 * extract-adapter registry accepts (identity + sourcing + mode), minus the
 * process-level fields (`bundleOutputPath` / `log`) the runner supplies. There
 * is NO default engine: the caller must name the adapter; an omitted or
 * unregistered engine is rejected at the seam boundary.
 */
export type DecodeExtractInput = ExtractSource;

export type DecodeExtractOutcome = {
  bridge: BridgeBundleV02;
  mode: KaifuuExtractResult["mode"];
  command: string;
};

export type DecodeExtractPort = {
  runDecodeExtract(input: DecodeExtractInput): Promise<DecodeExtractOutcome>;
};

/**
 * The extract-seam invocation, isolated as a seam so a test can prove the runner
 * drives the REAL `kaifuu-cli extract` argv WITHOUT spawning a subprocess (the
 * double captures the args and writes a fixture bridge to `bundleOutputPath`).
 * Defaults to the real {@link runKaifuuExtract}.
 */
export type DecodeExtractRunnerOptions = {
  runExtract?: (args: KaifuuExtractArgs) => KaifuuExtractResult;
  /** Injectable scratch-dir factory (defaults to a real os-tmp mkdtemp). */
  makeScratchDir?: () => string;
  /** Injectable file reader (defaults to a real utf8 readFileSync). */
  readBundle?: (path: string) => string;
  log?: (message: string) => void;
};

/**
 * Build the real `DecodeExtractPort` the production workflow injects. Each
 * `runDecodeExtract` call drives one real `kaifuu-cli extract --engine <engine>`
 * for the request's engine discriminant, reads the produced v0.2 bridge back, and
 * validates it before returning. The scratch bundle path is removed after the read.
 */
export function createDecodeExtractRunner(
  options: DecodeExtractRunnerOptions = {},
): DecodeExtractPort {
  const runExtract = options.runExtract ?? ((args) => runKaifuuExtract(args));
  const makeScratchDir =
    options.makeScratchDir ?? (() => mkdtempSync(join(tmpdir(), "itotori-decode-extract-")));
  const readBundle = options.readBundle ?? ((path) => readFileSync(path, "utf8"));

  return {
    async runDecodeExtract(input: DecodeExtractInput): Promise<DecodeExtractOutcome> {
      const scratchDir = makeScratchDir();
      const bundleOutputPath = join(scratchDir, "bridge.json");
      try {
        // The engine discriminant + its typed source fields flow through
        // verbatim; the runner only supplies the process-level output path (and
        // the optional log seam). The registry adapter for `input.engine` owns
        // validation/argv — an unregistered engine is rejected in runKaifuuExtract.
        const extractArgs: KaifuuExtractArgs = {
          ...input,
          bundleOutputPath,
          ...(options.log !== undefined ? { log: options.log } : {}),
        };
        // Drives the REAL kaifuu-cli extract (unless a test injects a double).
        const result = runExtract(extractArgs);
        // kaifuu wrote the bridge; read it back and validate against the schema
        // authority so a corrupt / mis-shaped decode fails LOUDLY here rather
        // than downstream in the importBridge / draft path.
        const raw: unknown = JSON.parse(readBundle(result.bundleOutputPath));
        assertBridgeBundleV02(raw);
        const bridge: BridgeBundleV02 = raw;
        return {
          bridge,
          mode: result.mode,
          command: `${result.command} ${result.args.join(" ")}`.trim(),
        };
      } finally {
        // Best-effort scratch cleanup — the returned bridge is fully in memory.
        try {
          rmSync(scratchDir, { recursive: true, force: true });
        } catch {
          // A failed cleanup must not mask the decode outcome/error.
        }
      }
    },
  };
}
