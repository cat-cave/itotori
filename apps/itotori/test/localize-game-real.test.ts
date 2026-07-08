// itotori-cli-localize-game-vertical — the ENV-GATED real-Sweetie proof.
//
// Runs the TRUE whole-game vertical as ONE command against real Sweetie bytes
// + live OpenRouter + real Postgres, producing a PATCHED + VALIDATED target.
// This is the acceptance's "real, not fixture" leg: it drives the REAL public
// `itotori localize-game` command (no mocked stages) end-to-end and asserts
// the run produced the patched target (a modified Seen.txt) + the validate
// artifacts (replay log + render evidence).
//
// Gated on the operator exporting the real inputs (skipped in CI, which touches
// no real bytes and makes no live call):
//   ITOTORI_CLI_REAL_LGAME_CONFIG        base localize-fullproject config (v0)
//   ITOTORI_CLI_REAL_LGAME_SOURCE        read-only source game root
//   ITOTORI_CLI_REAL_LGAME_GAME_ID       RealLive identity ...
//   ITOTORI_CLI_REAL_LGAME_GAME_VERSION
//   ITOTORI_CLI_REAL_LGAME_SOURCE_PROFILE_ID
//   ITOTORI_CLI_REAL_LGAME_SOURCE_LOCALE
//   ITOTORI_CLI_REAL_LGAME_SCENE         (optional, default "1")
// The OpenRouter key + account-ZDR posture come from the environment the live
// provider reads (the localize driver asserts ZDR before any live byte).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runItotoriCliCommand, type JsonFileStore } from "../src/cli-handlers.js";
import {
  migrateItotoriDatabase,
  withDatabaseItotoriServices,
} from "../src/services/database-services.js";

const config = process.env.ITOTORI_CLI_REAL_LGAME_CONFIG;
const source = process.env.ITOTORI_CLI_REAL_LGAME_SOURCE;
const gameId = process.env.ITOTORI_CLI_REAL_LGAME_GAME_ID;
const gameVersion = process.env.ITOTORI_CLI_REAL_LGAME_GAME_VERSION;
const sourceProfileId = process.env.ITOTORI_CLI_REAL_LGAME_SOURCE_PROFILE_ID;
const sourceLocale = process.env.ITOTORI_CLI_REAL_LGAME_SOURCE_LOCALE;
const scene = process.env.ITOTORI_CLI_REAL_LGAME_SCENE ?? "1";
const expectText = process.env.ITOTORI_CLI_REAL_LGAME_EXPECT_TEXT;

const gated = !config || !source || !gameId || !gameVersion || !sourceProfileId || !sourceLocale;

function nodeStore(): JsonFileStore {
  // Mirror apps/itotori/src/cli.ts's node store (read/write JSON on disk).
  return {
    readJson: (path) => JSON.parse(readFileSync(path, "utf8")),
    writeJson: (path, value) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    },
    writeText: (path, contents) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    },
  };
}

describe("itotori localize-game (env-gated real Sweetie vertical)", () => {
  it.skipIf(gated)(
    "runs the whole extract -> structure -> localize -> patch -> validate vertical to a patched + validated target",
    async () => {
      const runDir = mkdtempSync(join(tmpdir(), "itotori-lgame-real-"));
      const targetRoot = join(runDir, "patched");

      await runItotoriCliCommand(
        [
          "localize-game",
          "--config",
          config as string,
          "--source",
          source as string,
          "--target",
          targetRoot,
          "--run-dir",
          runDir,
          "--game-id",
          gameId as string,
          "--game-version",
          gameVersion as string,
          "--source-profile-id",
          sourceProfileId as string,
          "--source-locale",
          sourceLocale as string,
          "--scene",
          scene,
          ...(expectText ? ["--expect-text", expectText] : []),
        ],
        {
          io: nodeStore(),
          migrateDatabase: migrateItotoriDatabase,
          withServices: (callback) => withDatabaseItotoriServices({}, callback),
        },
      );

      // The vertical produced the stage artifacts.
      expect(existsSync(join(runDir, "bridge-bundle.json"))).toBe(true);
      expect(existsSync(join(runDir, "structure.json"))).toBe(true);
      expect(existsSync(join(runDir, "localize-game.config.json"))).toBe(true);
      // The patch landed a real patched Seen.txt under the target.
      const patchedSeen = findSeen(targetRoot);
      expect(patchedSeen).not.toBeNull();
      // ...and it is a REAL localization, not a no-op passthrough: the patched
      // target Seen.txt bytes MUST differ from the read-only source Seen.txt.
      const sourceSeen = findSeen(source as string);
      expect(sourceSeen).not.toBeNull();
      expect(readFileSync(patchedSeen as string).equals(readFileSync(sourceSeen as string))).toBe(
        false,
      );
      // The validate stage produced the replay + render artifacts.
      expect(existsSync(join(runDir, "replay-log.json"))).toBe(true);
      expect(existsSync(join(runDir, "render-evidence.json"))).toBe(true);
    },
    1_200_000,
  );
});

function findSeen(root: string): string | null {
  const direct = join(root, "REALLIVEDATA", "Seen.txt");
  if (existsSync(direct)) return direct;
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = join(root, entry.name, "REALLIVEDATA", "Seen.txt");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
