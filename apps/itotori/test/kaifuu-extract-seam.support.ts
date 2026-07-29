import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePrivateCorpus } from "../src/private-inventory.js";
import {
  buildExtractArgs,
  extractCapabilities,
  KaifuuExtractError,
  KAIFUU_NATIVE_OUTPUT_REDACTED,
  REALLIVE_SCENE_ID_MAX,
  registeredExtractEngines,
  resolveExtractAdapter,
  runKaifuuExtract,
  type KaifuuExtractArgs,
  type KaifuuProcessResult,
} from "../src/extract/kaifuu-extract-seam.js";

export const IDENTITY = {
  engine: "reallive",
  gameId: "sample-game",
  gameVersion: "1.0",
  sourceProfileId: "profile-1",
  sourceLocale: "ja-JP",
} as const;

export const RPG_IDENTITY = {
  gameId: "sample-rpg",
  gameVersion: "1.0",
  sourceProfileId: "profile-1",
  sourceLocale: "ja-JP",
} as const;
