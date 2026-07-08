// itotori-cli-extract-command (P1 follow-up — public-dispatch coverage).
//
// The seam-level suite (`kaifuu-extract-seam.test.ts`) proves
// `buildExtractArgs` / `runKaifuuRealliveExtract` shape the kaifuu invocation
// correctly, but a dispatch/parser regression in the USER-FACING command
// (`runItotoriCliCommand(["extract", ...])` -> `runExtract` in cli-handlers.ts)
// would pass those tests silently. This suite drives the REAL public command
// end-to-end:
//
//   * A faked `kaifuu-cli` binary (written to a tmp dir, pointed at by
//     ITOTORI_KAIFUU_BIN so `resolveKaifuuCli` returns it with NO cargo prefix)
//     captures its argv + writes a fake v0.2 bridge. The test then asserts the
//     public dispatch parsed the user flags and invoked kaifuu extract with the
//     exact Phase-1 shape — proving `itotori extract` works, not just the
//     internal helper.
//   * The parser-ambiguity fix is exercised through the SAME public command:
//     --whole-seen + --scene, --scene with no value, and a missing mode all
//     raise a clear CLI-level error BEFORE any subprocess is spawned.

import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";

const IDENTITY = [
  "--game-id",
  "sweetie",
  "--game-version",
  "1.0",
  "--source-profile-id",
  "profile-1",
  "--source-locale",
  "ja-JP",
] as const;

/**
 * Build a faked `kaifuu-cli` executable (a node script) that captures its argv
 * to `capturePath` and writes a minimal v0.2 bridge to the `--bundle-output`
 * path before exiting 0. Returned `binPath` is what ITOTORI_KAIFUU_BIN points
 * at so `resolveKaifuuCli` returns it directly (no `cargo run` prefix).
 */
function fakeKaifuuCli(binDir: string): { binPath: string; capturePath: string } {
  const binPath = join(binDir, "kaifuu-cli");
  const capturePath = join(binDir, "argv.json");
  const script = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(argv), "utf8");
const outIdx = argv.indexOf("--bundle-output");
if (outIdx >= 0 && argv[outIdx + 1] !== undefined) {
  writeFileSync(argv[outIdx + 1], JSON.stringify({
    schemaVersion: "itotori.bridge.v0.2",
    units: [{ bridgeUnitId: "u1", sourceText: "こんにちは" }],
    assets: [],
  }), "utf8");
}
process.exit(0);
`;
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return { binPath, capturePath };
}

function minimalDependencies(): ItotoriCliDependencies {
  return {
    io: { readJson: vi.fn(), writeJson: vi.fn() },
    migrateDatabase: vi.fn(async () => {}),
    withServices: vi.fn(async () => {}),
  };
}

/** Collect `process.stdout.write` calls so the JSON summary can be parsed. */
function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  return {
    writes,
    restore: () => {
      spy.mockRestore();
      process.stdout.write = original;
    },
  };
}

/** Parse the JSON summary `runExtract` writes to stdout (skipping log lines).
 * The summary is pretty-printed (`JSON.stringify(..., null, 2)`), so it spans
 * several lines — walk from its opening brace to the matching close. */
function extractSummary(writes: string[]): { mode: string; status: number } {
  const all = writes.join("");
  const start = all.indexOf("{\n");
  if (start < 0) {
    throw new Error(`no extract summary found in stdout: ${all.slice(-400)}`);
  }
  let depth = 0;
  let end = -1;
  for (let i = start; i < all.length; i += 1) {
    const ch = all[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) {
    throw new Error(`unterminated extract summary JSON in stdout: ${all.slice(-400)}`);
  }
  return JSON.parse(all.slice(start, end)) as { mode: string; status: number };
}

describe("itotori extract (public dispatch via runItotoriCliCommand)", () => {
  const prevBin = process.env.ITOTORI_KAIFUU_BIN;
  let binDir: string;
  let binPath: string;
  let capturePath: string;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "itotori-extract-dispatch-"));
    const fake = fakeKaifuuCli(binDir);
    binPath = fake.binPath;
    capturePath = fake.capturePath;
    process.env.ITOTORI_KAIFUU_BIN = binPath;
  });

  afterEach(() => {
    if (prevBin === undefined) {
      delete process.env.ITOTORI_KAIFUU_BIN;
    } else {
      process.env.ITOTORI_KAIFUU_BIN = prevBin;
    }
  });

  it("per-scene: dispatches kaifuu-cli extract with the exact Phase-1 argv", async () => {
    const bundleOutput = join(binDir, "bridge.json");
    const stdout = captureStdout();
    try {
      await runItotoriCliCommand(
        [
          "extract",
          "--game-root",
          "/games/sweetie",
          ...IDENTITY,
          "--scene",
          "6010",
          "--bundle-output",
          bundleOutput,
        ],
        minimalDependencies(),
      );
    } finally {
      stdout.restore();
    }

    // The faked kaifuu-cli captured exactly what the public command spawned.
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as string[];
    expect(captured).toEqual([
      "extract",
      "--engine",
      "reallive",
      "--game-root",
      "/games/sweetie",
      "--game-id",
      "sweetie",
      "--game-version",
      "1.0",
      "--source-profile-id",
      "profile-1",
      "--source-locale",
      "ja-JP",
      "--scene",
      "6010",
      "--bundle-output",
      bundleOutput,
    ]);
    // The user-facing JSON summary reports per-scene + status 0.
    const summary = extractSummary(stdout.writes);
    expect(summary.mode).toBe("per-scene");
    expect(summary.status).toBe(0);
    // kaifuu wrote the bridge to the resolved bundle-output path.
    expect(existsSync(bundleOutput)).toBe(true);
  });

  it("whole-seen: dispatches with --whole-seen (no --scene) and reports whole-seen", async () => {
    const bundleOutput = join(binDir, "bridge.json");
    const stdout = captureStdout();
    try {
      await runItotoriCliCommand(
        [
          "extract",
          "--vault-canonical-id",
          "vault-id",
          ...IDENTITY,
          "--whole-seen",
          "--bundle-output",
          bundleOutput,
        ],
        minimalDependencies(),
      );
    } finally {
      stdout.restore();
    }

    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as string[];
    expect(captured).toContain("--whole-seen");
    expect(captured).not.toContain("--scene");
    expect(captured[captured.indexOf("--vault-canonical-id") + 1]).toBe("vault-id");
    const summary = extractSummary(stdout.writes);
    expect(summary.mode).toBe("whole-seen");
    expect(summary.status).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Parser-ambiguity fix — clear CLI-level errors BEFORE spawning kaifuu.
  // -------------------------------------------------------------------------

  it("refuses --whole-seen together with --scene through the public command", async () => {
    const bundleOutput = join(binDir, "bridge.json");
    await expect(
      runItotoriCliCommand(
        [
          "extract",
          "--game-root",
          "/games/sweetie",
          ...IDENTITY,
          "--whole-seen",
          "--scene",
          "6010",
          "--bundle-output",
          bundleOutput,
        ],
        minimalDependencies(),
      ),
    ).rejects.toThrow(/mutually exclusive/u);
    // The faked binary must NOT have been spawned.
    expect(existsSync(capturePath)).toBe(false);
    expect(existsSync(bundleOutput)).toBe(false);
  });

  it("refuses a --scene whose value was swallowed by --whole-seen (ambiguous parse)", async () => {
    // `--scene --whole-seen` previously let optionalFlag grab "--whole-seen" as
    // the scene value; the CLI now refuses with a clear mode/value error.
    await expect(
      runItotoriCliCommand(
        [
          "extract",
          "--game-root",
          "/games/sweetie",
          ...IDENTITY,
          "--scene",
          "--whole-seen",
          "--bundle-output",
          join(binDir, "bridge.json"),
        ],
        minimalDependencies(),
      ),
    ).rejects.toThrow(/mutually exclusive|requires a numeric value/u);
    expect(existsSync(capturePath)).toBe(false);
  });

  it("refuses --scene with no value (or a flag-like value)", async () => {
    await expect(
      runItotoriCliCommand(
        [
          "extract",
          "--game-root",
          "/games/sweetie",
          ...IDENTITY,
          "--scene",
          "--bundle-output",
          join(binDir, "bridge.json"),
        ],
        minimalDependencies(),
      ),
    ).rejects.toThrow(/requires a numeric value/u);
    expect(existsSync(capturePath)).toBe(false);
  });

  it("refuses when neither --scene nor --whole-seen is given", async () => {
    await expect(
      runItotoriCliCommand(
        [
          "extract",
          "--game-root",
          "/games/sweetie",
          ...IDENTITY,
          "--bundle-output",
          join(binDir, "bridge.json"),
        ],
        minimalDependencies(),
      ),
    ).rejects.toThrow(/provide --scene .* or --whole-seen/u);
    expect(existsSync(capturePath)).toBe(false);
  });
});
