// itotori-structure-export — tests.
//
// Proves the user-shaped `itotori structure-export` command wraps the
// UTSUSHI-side `utsushi structure` producer with the right flag surface.
//
//   1. FAST (no real bin, no real game) — the seam builds the exact args the
//      producer parses (`structure --gameexe <p> --seen <p> --output <p>`
//      plus the optional `--entry-scene` / `--max-scenes` trailing), invokes
//      the resolved utsushi-cli binary, and surfaces a non-zero exit through
//      a typed `UtsushiStructureExportError` carrying the producer's stderr.
//      A fake `runProcess` captures the invocation so CI touches NO real
//      bytes and spawns NO real bin.
//   2. CLI DISPATCH — `runItotoriCliCommand` routes `structure-export` to the
//      handler (not the `unknown itotori command` fallback); required-flag
//      validation surfaces a clear refusal.
//   3. ENV-GATED real Sweetie — when `ITOTORI_REAL_GAME_ROOT` is exported,
//      actually invoke the real utsushi-cli `structure` subcommand and assert
//      the produced JSON carries `schemaVersion: "utsushi.narrative-structure.v1"`
//      with a real dispatch order (no retail bytes committed; the structure
//      file lives outside the repo on the operator machine).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";
import {
  defaultRepoRoot,
  resolveNativeCliBin,
  rustBinCandidatePaths,
  type NativeCliBinSpec,
} from "../src/native-bin/cli-bin-resolver.js";
import { resolveKaifuuCli } from "../src/orchestrator/patch-apply-seam.js";
import {
  buildUtsushiStructureArgs,
  resolveUtsushiCli,
  runUtsushiStructureExport,
  UtsushiStructureExportError,
  type UtsushiProcessResult,
} from "../src/structure-export/utsushi-structure-seam.js";

// ---------------------------------------------------------------------------
// (1) FAST unit tests — no real bin, no real game
// ---------------------------------------------------------------------------

describe("buildUtsushiStructureArgs (flag surface the producer parses)", () => {
  it("emits the exact `utsushi structure` flag order with required flags only", () => {
    const args = buildUtsushiStructureArgs({
      gameexePath: "/game/REALLIVEDATA/Gameexe.ini",
      seenPath: "/game/REALLIVEDATA/Seen.txt",
      outputPath: "/run/structure.json",
    });
    expect(args).toEqual([
      "structure",
      "--gameexe",
      "/game/REALLIVEDATA/Gameexe.ini",
      "--seen",
      "/game/REALLIVEDATA/Seen.txt",
      "--output",
      "/run/structure.json",
    ]);
  });

  it("appends --entry-scene + --max-scenes when supplied", () => {
    const args = buildUtsushiStructureArgs({
      gameexePath: "/g/Gameexe.ini",
      seenPath: "/g/Seen.txt",
      outputPath: "/run/structure.json",
      entryScene: 6010,
      maxScenes: 4,
    });
    expect(args.slice(-4)).toEqual(["--entry-scene", "6010", "--max-scenes", "4"]);
  });
});

describe("runUtsushiStructureExport (invocation shape mirrors the M1 real-bytes proof)", () => {
  it("invokes the resolved utsushi-cli with `structure --gameexe --seen --output`", () => {
    let captured: { command: string; args: string[] } | undefined;
    const runProcess = (command: string, args: string[]): UtsushiProcessResult => {
      captured = { command, args };
      return { status: 0, stdout: "ok", stderr: "" };
    };
    const res = runUtsushiStructureExport({
      gameexePath: "/game/REALLIVEDATA/Gameexe.ini",
      seenPath: "/game/REALLIVEDATA/Seen.txt",
      outputPath: "/run/structure.json",
      // ITOTORI_UTSUSHI_BIN unset here -> cargo fallback; runProcess is faked.
      env: {},
      runProcess,
    });
    expect(res.status).toBe(0);
    // The exact flag ordering the M1 real-bytes proof drives.
    const a = captured!.args;
    const structureIdx = a.indexOf("structure");
    expect(structureIdx).toBeGreaterThanOrEqual(0);
    expect(a.slice(structureIdx)).toEqual([
      "structure",
      "--gameexe",
      "/game/REALLIVEDATA/Gameexe.ini",
      "--seen",
      "/game/REALLIVEDATA/Seen.txt",
      "--output",
      "/run/structure.json",
    ]);
  });

  it("threads --entry-scene + --max-scenes through to the producer when supplied", () => {
    let captured: string[] | undefined;
    const runProcess = (_command: string, args: string[]): UtsushiProcessResult => {
      captured = args;
      return { status: 0, stdout: "", stderr: "" };
    };
    runUtsushiStructureExport({
      gameexePath: "/g/Gameexe.ini",
      seenPath: "/g/Seen.txt",
      outputPath: "/run/structure.json",
      entryScene: 6010,
      maxScenes: 8,
      env: {},
      runProcess,
    });
    expect(captured!.includes("--entry-scene")).toBe(true);
    expect(captured!.includes("6010")).toBe(true);
    expect(captured!.includes("--max-scenes")).toBe(true);
    expect(captured!.includes("8")).toBe(true);
  });

  it("throws a UtsushiStructureExportError on a non-zero exit (surfaces producer stderr)", () => {
    const runProcess = (): UtsushiProcessResult => ({
      status: 1,
      stdout: "",
      stderr: "utsushi.structure.parse_gameexe: invalid header",
    });
    expect(() =>
      runUtsushiStructureExport({
        gameexePath: "/g/Gameexe.ini",
        seenPath: "/g/Seen.txt",
        outputPath: "/run/structure.json",
        env: {},
        runProcess,
      }),
    ).toThrow(/status 1.*utsushi\.structure\.parse_gameexe: invalid header/su);
    expect(
      (() => {
        try {
          runUtsushiStructureExport({
            gameexePath: "/g/Gameexe.ini",
            seenPath: "/g/Seen.txt",
            outputPath: "/run/structure.json",
            env: {},
            runProcess,
          });
        } catch (error) {
          return error;
        }
        return undefined;
      })(),
    ).toBeInstanceOf(UtsushiStructureExportError);
  });

  it("logs the invocation through the injected logger", () => {
    const logged: string[] = [];
    const runProcess = (): UtsushiProcessResult => ({ status: 0, stdout: "", stderr: "" });
    runUtsushiStructureExport({
      gameexePath: "/g/Gameexe.ini",
      seenPath: "/g/Seen.txt",
      outputPath: "/run/structure.json",
      env: {},
      runProcess,
      log: (message) => {
        logged.push(message);
      },
    });
    expect(logged.some((line) => line.startsWith("structure-export:"))).toBe(true);
    expect(logged.some((line) => line.includes("structure"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (1c) Binary resolution — the shared resolver mirrors the native-deps
// doctor's `rustBinCandidates` order so `itotori structure-export` finds the
// SAME utsushi-cli the doctor + the kaifuu seam use (the codex-audit P1: the
// ad-hoc resolver previously MISSED the repo-target + PATH steps, so an
// installed / PATH scenario could resolve a different bin than the doctor).
// ---------------------------------------------------------------------------

const UTSUSHI_SPEC: NativeCliBinSpec = {
  binName: "utsushi-cli",
  envVar: "ITOTORI_UTSUSHI_BIN",
  cargoPackage: "utsushi-cli",
};

/** Write an executable stub named `name` into `dir`, matching the doctor's
 * `X_OK` probe. Returns the absolute path. */
function writeStubBin(dir: string, name: string): string {
  const binPath = join(dir, name);
  writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
  chmodSync(binPath, 0o755);
  return binPath;
}

/** `mkdir -p` helper for the nested target/release layout the resolver probes. */
function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("resolveNativeCliBin (shared order mirrors the native-deps doctor)", () => {
  // Step 1 — explicit env override wins over EVERY later source. This is the
  // operator / artifact pinning an exact binary.
  it("honors the explicit env override AHEAD of libexec / targets / PATH (step 1)", () => {
    const overrideBin = writeStubBin(mkdtempSync(join(tmpdir(), "utsushi-env-")), "utsushi-cli");
    const libexecDir = mkdtempSync(join(tmpdir(), "utsushi-libexec-"));
    writeStubBin(libexecDir, "utsushi-cli"); // would satisfy step 2
    const cargoDir = mkdtempSync(join(tmpdir(), "utsushi-cargo-"));
    writeStubBin(mkdirp(join(cargoDir, "release")), "utsushi-cli"); // step 3
    const pathDir = mkdtempSync(join(tmpdir(), "utsushi-path-"));
    writeStubBin(pathDir, "utsushi-cli"); // step 5
    const resolved = resolveNativeCliBin(UTSUSHI_SPEC, {
      ITOTORI_UTSUSHI_BIN: overrideBin,
      ITOTORI_LIBEXEC_DIR: libexecDir,
      CARGO_TARGET_DIR: cargoDir,
      PATH: pathDir,
    });
    expect(resolved).toEqual({ command: overrideBin, prefixArgs: [] });
  });

  // Step 2 — bundled libexec (the primary installed-artifact path) beats built
  // targets and PATH.
  it("prefers the bundled libexec bin over built targets and PATH (step 2)", () => {
    const libexecDir = mkdtempSync(join(tmpdir(), "utsushi-libexec-"));
    const libexecBin = writeStubBin(libexecDir, "utsushi-cli");
    const cargoDir = mkdtempSync(join(tmpdir(), "utsushi-cargo-"));
    writeStubBin(mkdirp(join(cargoDir, "release")), "utsushi-cli");
    const repoRoot = mkdtempSync(join(tmpdir(), "utsushi-repo-"));
    writeStubBin(mkdirp(join(repoRoot, "target", "release")), "utsushi-cli");
    const pathDir = mkdtempSync(join(tmpdir(), "utsushi-path-"));
    writeStubBin(pathDir, "utsushi-cli");
    const resolved = resolveNativeCliBin(
      UTSUSHI_SPEC,
      { ITOTORI_LIBEXEC_DIR: libexecDir, CARGO_TARGET_DIR: cargoDir, PATH: pathDir },
      { repoRoot },
    );
    expect(resolved).toEqual({ command: libexecBin, prefixArgs: [] });
  });

  // Step 3 — CARGO_TARGET_DIR (dev shell / worktree builds) beats the repo
  // target and PATH.
  it("prefers CARGO_TARGET_DIR over the repo target and PATH (step 3)", () => {
    const cargoDir = mkdtempSync(join(tmpdir(), "utsushi-cargo-"));
    const cargoBin = writeStubBin(mkdirp(join(cargoDir, "release")), "utsushi-cli");
    const repoRoot = mkdtempSync(join(tmpdir(), "utsushi-repo-"));
    writeStubBin(mkdirp(join(repoRoot, "target", "release")), "utsushi-cli");
    const pathDir = mkdtempSync(join(tmpdir(), "utsushi-path-"));
    writeStubBin(pathDir, "utsushi-cli");
    const resolved = resolveNativeCliBin(
      UTSUSHI_SPEC,
      { CARGO_TARGET_DIR: cargoDir, PATH: pathDir },
      { repoRoot },
    );
    expect(resolved).toEqual({ command: cargoBin, prefixArgs: [] });
  });

  it("checks release before debug within a target dir (doctor order)", () => {
    const cargoDir = mkdtempSync(join(tmpdir(), "utsushi-cargo-"));
    const releaseBin = writeStubBin(mkdirp(join(cargoDir, "release")), "utsushi-cli");
    writeStubBin(mkdirp(join(cargoDir, "debug")), "utsushi-cli");
    const resolved = resolveNativeCliBin(UTSUSHI_SPEC, { CARGO_TARGET_DIR: cargoDir });
    expect(resolved).toEqual({ command: releaseBin, prefixArgs: [] });
  });

  // Step 4 — repo target/ (plain `cargo build` checkout, no CARGO_TARGET_DIR)
  // beats PATH. The nix devshell usually short-circuits this via
  // CARGO_TARGET_DIR, but it must still match the doctor when that env is unset.
  it("prefers the repo target over PATH when CARGO_TARGET_DIR is unset (step 4)", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "utsushi-repo-"));
    const repoBin = writeStubBin(mkdirp(join(repoRoot, "target", "release")), "utsushi-cli");
    const pathDir = mkdtempSync(join(tmpdir(), "utsushi-path-"));
    writeStubBin(pathDir, "utsushi-cli");
    const resolved = resolveNativeCliBin(UTSUSHI_SPEC, { PATH: pathDir }, { repoRoot });
    expect(resolved).toEqual({ command: repoBin, prefixArgs: [] });
  });

  // Step 5 — THE P1 FIX: a bare bin on PATH (cargo install / operator PATH) is
  // resolved AHEAD of the cargo dev fallback. The ad-hoc resolver previously
  // missed this, so an installed / PATH scenario ran `cargo run` instead of the
  // installed bin — disagreeing with the doctor.
  it("resolves a bare bin on PATH ahead of the cargo dev fallback (step 5 — the P1 fix)", () => {
    const pathDir = mkdtempSync(join(tmpdir(), "utsushi-path-"));
    const pathBin = writeStubBin(pathDir, "utsushi-cli");
    const resolved = resolveNativeCliBin(UTSUSHI_SPEC, { PATH: pathDir });
    expect(resolved).toEqual({ command: pathBin, prefixArgs: [] });
  });

  it("walks a multi-entry PATH and resolves the first matching dir", () => {
    const missDir = mkdtempSync(join(tmpdir(), "utsushi-path-miss-"));
    const hitDir = mkdtempSync(join(tmpdir(), "utsushi-path-hit-"));
    const pathBin = writeStubBin(hitDir, "utsushi-cli");
    const resolved = resolveNativeCliBin(UTSUSHI_SPEC, {
      PATH: [missDir, hitDir].join(":"),
    });
    expect(resolved).toEqual({ command: pathBin, prefixArgs: [] });
  });

  it("skips a non-executable earlier candidate so resolution still matches the doctor", () => {
    const libexecDir = mkdtempSync(join(tmpdir(), "utsushi-libexec-not-x-"));
    writeFileSync(join(libexecDir, "utsushi-cli"), "#!/bin/sh\nexit 0\n");
    const pathDir = mkdtempSync(join(tmpdir(), "utsushi-path-x-"));
    const pathBin = writeStubBin(pathDir, "utsushi-cli");
    const resolved = resolveNativeCliBin(UTSUSHI_SPEC, {
      ITOTORI_LIBEXEC_DIR: libexecDir,
      PATH: pathDir,
    });
    expect(resolved).toEqual({ command: pathBin, prefixArgs: [] });
  });

  // Step 6 — dev-shell fallback the seams add over the doctor.
  it("falls back to `cargo run -p <pkg> --quiet --` when nothing resolves and no PATH (step 6)", () => {
    const resolved = resolveNativeCliBin(UTSUSHI_SPEC, {});
    expect(resolved).toEqual({
      command: "cargo",
      prefixArgs: ["run", "-p", "utsushi-cli", "--quiet", "--"],
    });
  });

  it("does NOT consult process.env.PATH — the PATH walk is driven by the passed env.PATH only", () => {
    // env has no PATH key -> no PATH walk, even though process.env.PATH exists,
    // keeping the resolver a pure function of `env` (deterministic in tests).
    const resolved = resolveNativeCliBin(UTSUSHI_SPEC, { CARGO_TARGET_DIR: "/nonexistent" });
    expect(resolved).toEqual({
      command: "cargo",
      prefixArgs: ["run", "-p", "utsushi-cli", "--quiet", "--"],
    });
  });

  it("emits candidate paths in the doctor order: libexec -> CARGO_TARGET_DIR -> repo target, release before debug", () => {
    const paths = rustBinCandidatePaths(
      "utsushi-cli",
      { ITOTORI_LIBEXEC_DIR: "/libexec", CARGO_TARGET_DIR: "/cargo" },
      "/repo",
    );
    expect(paths).toEqual([
      join("/libexec", "utsushi-cli"),
      join("/libexec", "utsushi-cli.exe"),
      join("/cargo", "release", "utsushi-cli"),
      join("/cargo", "debug", "utsushi-cli"),
      join("/repo", "target", "release", "utsushi-cli"),
      join("/repo", "target", "debug", "utsushi-cli"),
    ]);
  });
});

describe("resolveUtsushiCli (delegates through the shared resolver)", () => {
  it("honors an explicit ITOTORI_UTSUSHI_BIN when it points at an executable file", () => {
    const binPath = writeStubBin(mkdtempSync(join(tmpdir(), "utsushi-bin-")), "utsushi-cli-stub");
    const resolved = resolveUtsushiCli({ ITOTORI_UTSUSHI_BIN: binPath });
    expect(resolved).toEqual({ command: binPath, prefixArgs: [] });
  });

  // Cross-seam parity: the utsushi + kaifuu seams route through the SAME shared
  // resolver, so they can NEVER disagree about resolution order. Both honor
  // their respective env overrides through the identical code path.
  it("uses the SAME resolver as resolveKaifuuCli (env-override parity across seams)", () => {
    const uBin = writeStubBin(mkdtempSync(join(tmpdir(), "utsushi-ovr-")), "utsushi-cli");
    expect(resolveUtsushiCli({ ITOTORI_UTSUSHI_BIN: uBin })).toEqual({
      command: uBin,
      prefixArgs: [],
    });
    const kBin = writeStubBin(mkdtempSync(join(tmpdir(), "kaifuu-ovr-")), "kaifuu-cli");
    expect(resolveKaifuuCli({ ITOTORI_KAIFUU_BIN: kBin })).toEqual({
      command: kBin,
      prefixArgs: [],
    });
  });
});

describe("defaultRepoRoot (best-effort marker walk for step 4)", () => {
  it("resolves the real repo root from this module's location in a dev checkout", () => {
    // In the test environment this source file IS in the repo, so the marker
    // walk (flake.nix + Cargo.toml) reaches the repo root. The installed
    // artifact path returns undefined (no marker reachable) -> step 4 skipped.
    const root = defaultRepoRoot();
    expect(root).toBeDefined();
    expect(existsSync(join(root!, "flake.nix"))).toBe(true);
    expect(existsSync(join(root!, "Cargo.toml"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (2) CLI DISPATCH — runItotoriCliCommand routes `structure-export`
// ---------------------------------------------------------------------------

const noopDependencies: ItotoriCliDependencies = {
  io: {
    readJson: () => {
      throw new Error("structure-export should not read from the io store");
    },
    writeJson: () => {
      throw new Error("structure-export should not write to the io store");
    },
  },
  migrateDatabase: async () => {},
  withServices: async () => {
    throw new Error("structure-export should not open services");
  },
};

describe("runItotoriCliCommand — structure-export dispatch", () => {
  it("routes `structure-export` to the handler (NOT the unknown-command fallback)", async () => {
    // Missing required flags -> the handler refuses with a clear "missing
    // required flag" error. If dispatch were broken, the dispatcher would
    // throw "unknown itotori command: structure-export" instead.
    await expect(runItotoriCliCommand(["structure-export"], noopDependencies)).rejects.toThrow(
      /missing required flag --gameexe/u,
    );
  });

  it("validates --entry-scene as a non-negative integer", async () => {
    await expect(
      runItotoriCliCommand(
        [
          "structure-export",
          "--gameexe",
          "/g/Gameexe.ini",
          "--seen",
          "/g/Seen.txt",
          "--output",
          "/run/structure.json",
          "--entry-scene",
          "not-a-number",
        ],
        noopDependencies,
      ),
    ).rejects.toThrow(/--entry-scene 'not-a-number' must be a non-negative integer/u);
  });

  it("validates --max-scenes as a positive integer", async () => {
    await expect(
      runItotoriCliCommand(
        [
          "structure-export",
          "--gameexe",
          "/g/Gameexe.ini",
          "--seen",
          "/g/Seen.txt",
          "--output",
          "/run/structure.json",
          "--max-scenes",
          "0",
        ],
        noopDependencies,
      ),
    ).rejects.toThrow(/--max-scenes '0' must be a positive integer/u);
  });
});

// ---------------------------------------------------------------------------
// (3) ENV-GATED real-Sweetie proof — actually drive the real utsushi-cli
// ---------------------------------------------------------------------------

/**
 * Resolve `<ITOTORI_REAL_GAME_ROOT>/REALLIVEDATA/{Seen.txt,Gameexe.ini}`,
 * mirroring `crates/utsushi-cli/tests/support/real_corpus.rs`. Returns
 * `undefined` when the corpus is not staged so the test prints a visible
 * skip note and returns (no silent pass).
 */
function realCorpusPaths(): { gameexe: string; seen: string } | undefined {
  const root = process.env.ITOTORI_REAL_GAME_ROOT;
  if (root === undefined || root.length === 0) return undefined;
  const seen = join(root, "REALLIVEDATA", "Seen.txt");
  const gameexe = join(root, "REALLIVEDATA", "Gameexe.ini");
  if (!existsSync(seen) || !existsSync(gameexe)) return undefined;
  return { gameexe, seen };
}

describe("runUtsushiStructureExport (env-gated real-Sweetie byte proof)", () => {
  const corpus = realCorpusPaths();
  it.skipIf(!corpus)(
    "drives the real utsushi-cli `structure` subcommand and writes a utsushi.narrative-structure.v1 artifact",
    () => {
      // This path is only exercised on an operator machine with the real game
      // tree exported (never committed). It drives the REAL utsushi-cli
      // `structure` subcommand (no faked runProcess) and asserts the produced
      // JSON carries the real schemaVersion + a non-empty dispatch order.
      const workDir = mkdtempSync(join(tmpdir(), "itotori-structure-export-real-"));
      const structureOut = join(workDir, "structure.json");
      const res = runUtsushiStructureExport({
        gameexePath: corpus!.gameexe,
        seenPath: corpus!.seen,
        outputPath: structureOut,
      });
      expect(res.status).toBe(0);

      // The artifact landed on disk.
      const stat = statSync(structureOut);
      expect(stat.size).toBeGreaterThan(0);

      const structure = JSON.parse(readFileSync(structureOut, "utf8")) as Record<string, unknown>;
      expect(structure.schemaVersion).toBe("utsushi.narrative-structure.v1");
      // The real driven playthrough crosses at least one scene.
      const dispatchOrder = structure.sceneDispatchOrder;
      expect(Array.isArray(dispatchOrder)).toBe(true);
      expect((dispatchOrder as unknown[]).length).toBeGreaterThan(0);
      const entryScene = structure.entryScene;
      expect(typeof entryScene).toBe("number");
      // The dispatch order leads with the entry scene — the REAL dispatch
      // order from the replay walk, NOT archive slot order.
      expect((dispatchOrder as unknown[])[0]).toBe(entryScene);
      // eslint-disable-next-line no-console
      console.log(
        `[structure-export] real bytes: scenes=${(dispatchOrder as unknown[]).length} ` +
          `entryScene=${String(entryScene)} output=${structureOut}`,
      );
    },
    300_000,
  );
});
