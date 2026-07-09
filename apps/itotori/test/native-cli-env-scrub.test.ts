import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The single sanitized spawn boundary + the scrub primitive under test. The
// native seams (extract / structure-export / patch-apply / runNativeCli) ALL
// route their real OS spawn through `spawnNativeCliProcess`, so mocking
// `node:child_process.spawnSync` lets us capture the env EVERY seam actually
// hands the child.
import {
  scrubLiveProviderSecrets,
  spawnNativeCliProcess,
} from "../src/native-bin/cli-bin-resolver.js";
import {
  classifyNativeSpawnSource,
  findUnsanitizedNativeSpawns,
  walkSourceFiles,
} from "./native-spawn-guard.js";

// DUMMY value only — never a real secret.
const DUMMY_KEY = "sk-or-dummy-native-scrub-4444444444";

const LIVE_PROVIDER_VARS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_ZDR_ACCOUNT_ASSERTED",
  "OPENROUTER_ZDR_DOWNGRADE",
] as const;

// Capture the env every mocked spawnSync receives.
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

function parentEnvWithSecrets(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENROUTER_API_KEY: DUMMY_KEY,
    OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
    OPENROUTER_ZDR_DOWNGRADE: "deepseek/deepseek-chat",
    PATH: "/usr/bin",
    ...extra,
  };
}

describe("single source of truth", () => {
  it("the env-file allowlist and the native-scrub list come from the one shared module", async () => {
    const { EXTERNAL_ENV_FILE_ALLOWLIST } = await import("../src/env/external-env-file.js");
    const { LIVE_PROVIDER_SECRET_VARS } = await import("../src/env/live-provider-secret-vars.js");
    expect([...EXTERNAL_ENV_FILE_ALLOWLIST]).toEqual([...LIVE_PROVIDER_SECRET_VARS]);
    expect([...LIVE_PROVIDER_SECRET_VARS].sort()).toEqual([...LIVE_PROVIDER_VARS].sort());
  });

  it("the native-deps doctor derives the SAME list from the src .ts (no drift)", async () => {
    const { LIVE_PROVIDER_SECRET_VARS } = await import("../src/env/live-provider-secret-vars.js");
    const { parseLiveProviderSecretVarsBlock } = await import("../../../scripts/native-deps.mjs");
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..");
    // Use the doctor's OWN exported parser (not a re-implementation) against the
    // src .ts, so the test cannot silently drift from the real derivation.
    const fromSrc = parseLiveProviderSecretVarsBlock(
      readFileSync(join(repoRoot, "apps/itotori/src/env/live-provider-secret-vars.ts"), "utf8"),
    );
    expect(fromSrc).toEqual([...LIVE_PROVIDER_SECRET_VARS]);
  });

  it("the doctor derives the SAME list from the COMPILED dist .js (dist-only artifact)", async () => {
    const { LIVE_PROVIDER_SECRET_VARS } = await import("../src/env/live-provider-secret-vars.js");
    const { parseLiveProviderSecretVarsBlock, LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES } =
      await import("../../../scripts/native-deps.mjs");
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..");
    const distRel = "apps/itotori/dist/env/live-provider-secret-vars.js";
    // dist is FIRST in the candidate order so an installed artifact (compiled,
    // no src) resolves it.
    expect(LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES[0]).toBe(distRel);
    const distPath = join(repoRoot, distRel);
    // The emitted .js carries the identical marker block; the doctor's parser
    // reads it byte-for-byte the same as the .ts.
    const fromDist = parseLiveProviderSecretVarsBlock(readFileSync(distPath, "utf8"));
    expect(fromDist).toEqual([...LIVE_PROVIDER_SECRET_VARS]);
  });

  it("simulates a dist-only (src-absent) artifact: doctor reads the list without src", async () => {
    // Copy ONLY the compiled dist file into a temp repo root laid out like a
    // packaged artifact (dist present, src ABSENT), and prove the doctor's
    // candidate resolution still derives the list.
    const { parseLiveProviderSecretVarsBlock, LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES } =
      await import("../../../scripts/native-deps.mjs");
    const { LIVE_PROVIDER_SECRET_VARS } = await import("../src/env/live-provider-secret-vars.js");
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..");
    const distRel = LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES[0];
    const srcRel = LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES[1];

    const fakeRoot = mkdtempSync(join(tmpdir(), "dist-only-artifact-"));
    try {
      const distDst = join(fakeRoot, distRel);
      mkdirSync(dirname(distDst), { recursive: true });
      writeFileSync(distDst, readFileSync(join(repoRoot, distRel), "utf8"));
      // Assert src is genuinely absent in this simulated artifact.
      expect(existsSync(join(fakeRoot, srcRel))).toBe(false);

      // Mirror the doctor's candidate walk against fakeRoot: first present
      // candidate wins.
      let derived: string[] | undefined;
      for (const rel of LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES) {
        const p = join(fakeRoot, rel);
        if (!existsSync(p)) continue;
        derived = parseLiveProviderSecretVarsBlock(readFileSync(p, "utf8"));
        break;
      }
      expect(derived).toEqual([...LIVE_PROVIDER_SECRET_VARS]);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});

describe("scrubLiveProviderSecrets", () => {
  it("removes every live-provider secret but keeps unrelated vars", () => {
    const scrubbed = scrubLiveProviderSecrets(
      parentEnvWithSecrets({ ITOTORI_KAIFUU_BIN: "/some/kaifuu-cli" }),
    );
    for (const key of LIVE_PROVIDER_VARS) {
      expect(scrubbed[key]).toBeUndefined();
    }
    // Resolution-relevant + unrelated vars are preserved for the child.
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.ITOTORI_KAIFUU_BIN).toBe("/some/kaifuu-cli");
  });

  it("does not mutate the source env", () => {
    const source = { OPENROUTER_API_KEY: DUMMY_KEY, PATH: "/usr/bin" };
    scrubLiveProviderSecrets(source);
    expect(source.OPENROUTER_API_KEY).toBe(DUMMY_KEY);
  });
});

describe("spawnNativeCliProcess — the one sanitized spawn boundary", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "",
      stderr: "",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scrubs the live-provider secrets from the child env the OS spawn receives", () => {
    const parentEnv = parentEnvWithSecrets();
    spawnNativeCliProcess("kaifuu-cli", ["extract", "--scene", "1"], parentEnv);

    expect(spawnSyncMock).toHaveBeenCalledOnce();
    const childEnv = spawnSyncMock.mock.calls[0][2].env as NodeJS.ProcessEnv;
    for (const key of LIVE_PROVIDER_VARS) {
      expect(childEnv[key]).toBeUndefined();
    }
    // Non-secret var still reaches the child.
    expect(childEnv.PATH).toBe("/usr/bin");
    // The secret never appears in the serialized child env.
    expect(JSON.stringify(childEnv)).not.toContain(DUMMY_KEY);
    // The parent env is not mutated by the scrub.
    expect(parentEnv.OPENROUTER_API_KEY).toBe(DUMMY_KEY);
  });
});

// ---------------------------------------------------------------------------
// Enumerating guard: drive the REAL default spawn path of every native seam
// (extract / structure-export / patch-apply / runNativeCli) and assert the env
// the OS spawn receives has NO live-provider secret — even though the parent
// env has them all set. A new seam that spawns without routing through the
// sanitized boundary fails this test.
// ---------------------------------------------------------------------------

describe("every native-tool seam scrubs live-provider secrets from the child env", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: "",
      stderr: "",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function assertLastSpawnHadNoSecrets(): void {
    expect(spawnSyncMock).toHaveBeenCalled();
    const lastCall = spawnSyncMock.mock.calls.at(-1);
    const childEnv = (lastCall?.[2].env ?? {}) as NodeJS.ProcessEnv;
    for (const key of LIVE_PROVIDER_VARS) {
      expect(childEnv[key]).toBeUndefined();
    }
    expect(JSON.stringify(childEnv)).not.toContain(DUMMY_KEY);
  }

  it("runNativeCli (extract/patch/validate named-bin path)", async () => {
    const { runNativeCli } = await import("../src/native-bin/cli-bin-resolver.js");
    runNativeCli("kaifuu-cli", ["extract"], { env: parentEnvWithSecrets() });
    assertLastSpawnHadNoSecrets();
  });

  it("runKaifuuRealliveExtract (itotori extract)", async () => {
    const { runKaifuuRealliveExtract } = await import("../src/extract/kaifuu-extract-seam.js");
    runKaifuuRealliveExtract({
      gameRoot: "/games/example",
      gameId: "g",
      gameVersion: "1",
      sourceProfileId: "p",
      sourceLocale: "ja",
      scene: 1,
      bundleOutputPath: "/tmp/bundle.json",
      env: parentEnvWithSecrets(),
    });
    assertLastSpawnHadNoSecrets();
  });

  it("runUtsushiStructureExport (itotori structure-export)", async () => {
    const { runUtsushiStructureExport } =
      await import("../src/structure-export/utsushi-structure-seam.js");
    runUtsushiStructureExport({
      gameexePath: "/games/example/Gameexe.ini",
      seenPath: "/games/example/Seen.txt",
      outputPath: "/tmp/structure.json",
      env: parentEnvWithSecrets(),
    });
    assertLastSpawnHadNoSecrets();
  });

  it("applyKaifuuRealLivePatch (live whole-game patch-apply path)", async () => {
    const { applyKaifuuRealLivePatch } = await import("../src/orchestrator/patch-apply-seam.js");
    applyKaifuuRealLivePatch({
      sourceRoot: "/games/example",
      targetRoot: "/tmp/patched",
      translatedBundlePath: "/tmp/translated-bridge.json",
      translationScope: "dialogue-only",
      env: parentEnvWithSecrets(),
    });
    assertLastSpawnHadNoSecrets();
  });
});

// ---------------------------------------------------------------------------
// Static regression guard (durable backstop): scan the ENTIRE repo — apps/,
// packages/, scripts/ — for any source file that BOTH (a) invokes a child-
// process spawn primitive AND (b) references a native decode/render bin
// (kaifuu-cli / utsushi-cli, or a `cargo run -p …-cli`). Every such file MUST
// route through the sanitized boundary (`spawnNativeCliProcess`) or scrub the
// child env (`scrubLiveProviderSecrets*`) — otherwise a native child could
// inherit the live-provider secrets. A future unsanitized native spawn (in a
// seam OR a script) fails this test, so this is the LAST round.
// ---------------------------------------------------------------------------

describe("static guard: no native-CLI spawn anywhere leaks live-provider secrets", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const scanRoots = ["apps", "packages", "scripts"];

  // The ONE file permitted to spawn a native bin without the shared helper —
  // it IS the sanitized boundary (scrubs inline).
  const allowedInlineScrub = new Set<string>(["apps/itotori/src/native-bin/cli-bin-resolver.ts"]);
  // Files that reference a native bin only as DATA (a `crates/<bin>/` path or
  // an allowlist entry) and spawn only benign tooling (git/pnpm). Documented so
  // the backstop stays strict: a NEW file that spawns a native bin without
  // sanitizing is NOT on this list and thus fails.
  const benignDataReferences = new Set<string>([
    // git-ls-files scanner; "kaifuu-cli"/"utsushi-cli" are `crates/…/` path
    // data in its game-reference allowlist, never a spawn target.
    "scripts/validate-no-specific-game-references.mjs",
  ]);

  it("no unsanitized native-CLI spawn exists across apps/, packages/, scripts/", () => {
    const offenders = findUnsanitizedNativeSpawns({
      repoRoot,
      scanRoots,
      allowedInlineScrub,
      benignDataReferences,
    });
    expect(offenders).toEqual([]);
  });

  it("GENUINELY fails on an injected rogue native spawn (real negative check)", () => {
    // Materialize a real rogue source file under a scanned root that spawns a
    // native bin WITHOUT routing through the sanitized boundary, then assert the
    // SAME classifier used by the guard flags it. If the classifier ever stops
    // detecting this, the guard is vacuous and this test fails.
    const tmp = mkdtempSync(join(tmpdir(), "native-spawn-rogue-"));
    try {
      const roguePath = join(tmp, "rogue-seam.ts");
      writeFileSync(
        roguePath,
        [
          'import { spawnSync } from "node:child_process";',
          "export function rogue(env: NodeJS.ProcessEnv) {",
          "  // spawns the real decode bin with the FULL env — a leak",
          '  return spawnSync("kaifuu-cli", ["extract"], { env });',
          "}",
        ].join("\n"),
      );
      const scanned = walkSourceFiles(tmp);
      expect(scanned).toContain(roguePath);
      const offenders = findUnsanitizedNativeSpawns({
        repoRoot: tmp,
        scanRoots: ["."],
        allowedInlineScrub: new Set(),
        benignDataReferences: new Set(),
      });
      // The rogue file MUST be flagged — proving the guard is a real backstop.
      expect(offenders).toContain("rogue-seam.ts");

      // And the classifier's disposition is precise: spawns-native + unsanitized.
      const cls = classifyNativeSpawnSource(readFileSync(roguePath, "utf8"));
      expect(cls.spawnsNativeBin).toBe(true);
      expect(cls.usesBoundaryCall).toBe(false);
      expect(cls.allSitesSanitized).toBe(false);
      expect(cls.sites).toHaveLength(1);
      expect(cls.sites[0]?.sanitized).toBe(false);
      expect(cls.sites[0]?.primitive).toBe("spawnSync");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flags a mixed file even when one call routes through the sanitized boundary", () => {
    // This is the codex re-audit fixture: a file-level mention/call of the
    // boundary is not enough. Each raw native spawn site has to be sanitized.
    const tmp = mkdtempSync(join(tmpdir(), "native-spawn-mixed-"));
    try {
      const mixedPath = join(tmp, "mixed-seam.ts");
      writeFileSync(
        mixedPath,
        [
          'import { spawnSync } from "node:child_process";',
          'import { scrubLiveProviderSecretsFromEnv } from "../env/live-provider-secret-vars.js";',
          'import { spawnNativeCliProcess } from "../native-bin/cli-bin-resolver.js";',
          "export function mixed(env: NodeJS.ProcessEnv) {",
          '  const viaBoundary = spawnNativeCliProcess("kaifuu-cli", ["extract"], env);',
          '  const scrubbedRaw = spawnSync("utsushi-cli", ["structure"], {',
          "    env: scrubLiveProviderSecretsFromEnv(env),",
          "  });",
          '  const rogueRaw = spawnSync("kaifuu-cli", ["extract"], { env });',
          "  return { viaBoundary, scrubbedRaw, rogueRaw };",
          "}",
        ].join("\n"),
      );

      const offenders = findUnsanitizedNativeSpawns({
        repoRoot: tmp,
        scanRoots: ["."],
        allowedInlineScrub: new Set(),
        benignDataReferences: new Set(),
      });
      expect(offenders).toContain("mixed-seam.ts");

      const cls = classifyNativeSpawnSource(readFileSync(mixedPath, "utf8"));
      expect(cls.usesBoundaryCall).toBe(true);
      expect(cls.spawnsNativeBin).toBe(true);
      expect(cls.allSitesSanitized).toBe(false);
      expect(cls.sites).toHaveLength(2);
      expect(cls.sites.map((site) => site.sanitized).sort()).toEqual([false, true]);
      expect(cls.sites.find((site) => !site.sanitized)?.args).toContain("{ env }");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does NOT flag a file that routes through the sanitized boundary", () => {
    // The complement of the negative check. Two ways a file is NOT an offender:
    // (1) it calls only the shared helper (no raw spawn primitive), OR (2) it
    // does spawn raw AND scrubs. Both must classify as sanitized-or-not-native.
    const helperOnly = classifyNativeSpawnSource(
      [
        'import { spawnNativeCliProcess } from "../native-bin/cli-bin-resolver.js";',
        "export function ok(env: NodeJS.ProcessEnv) {",
        '  return spawnNativeCliProcess("kaifuu-cli", ["extract"], env);',
        "}",
      ].join("\n"),
    );
    // No raw spawn primitive => not a native-spawn offender; and it references
    // the sanitized helper.
    expect(helperOnly.spawnsNativeBin).toBe(false);
    expect(helperOnly.usesBoundaryCall).toBe(true);
    expect(helperOnly.allSitesSanitized).toBe(true);
    expect(helperOnly.sites).toEqual([]);

    // A file that DOES spawn raw but scrubs the child env is sanitized (this is
    // the boundary's own shape).
    const rawButScrubbed = classifyNativeSpawnSource(
      [
        'import { spawnSync } from "node:child_process";',
        'import { scrubLiveProviderSecretsFromEnv } from "../env/live-provider-secret-vars.js";',
        "export function ok(env: NodeJS.ProcessEnv) {",
        '  return spawnSync("kaifuu-cli", ["extract"], { env: scrubLiveProviderSecretsFromEnv(env) });',
        "}",
      ].join("\n"),
    );
    expect(rawButScrubbed.spawnsNativeBin).toBe(true);
    expect(rawButScrubbed.usesBoundaryCall).toBe(false);
    expect(rawButScrubbed.allSitesSanitized).toBe(true);
    expect(rawButScrubbed.sites).toHaveLength(1);
    expect(rawButScrubbed.sites[0]?.sanitized).toBe(true);
  });

  it("ignores a native-bin name that appears only in a comment (no false positive)", () => {
    const commentOnly = classifyNativeSpawnSource(
      [
        'import { spawnSync } from "node:child_process";',
        "// This runs kaifuu-cli conceptually, but here we only spawn git.",
        "/* utsushi-cli is mentioned in this block comment only. */",
        'export const r = spawnSync("git", ["status"]);',
      ].join("\n"),
    );
    // git spawn + bin name only in comments => NOT a native spawn.
    expect(commentOnly.spawnsNativeBin).toBe(false);
  });

  it("the known native-CLI seams + doctor route through the sanitized path", () => {
    const mustRouteThroughHelper = [
      "apps/itotori/src/extract/kaifuu-extract-seam.ts",
      "apps/itotori/src/structure-export/utsushi-structure-seam.ts",
      "apps/itotori/src/orchestrator/patch-apply-seam.ts",
    ];
    for (const rel of mustRouteThroughHelper) {
      const cls = classifyNativeSpawnSource(readFileSync(join(repoRoot, rel), "utf8"));
      expect(cls.usesBoundaryCall).toBe(true);
      expect(cls.sites.filter((site) => !site.sanitized)).toEqual([]);
    }
    // The standalone doctor scrubs via the shared helper.
    const doctor = readFileSync(join(repoRoot, "scripts/native-deps.mjs"), "utf8");
    expect(doctor).toContain("scrubLiveProviderSecretsFromEnv");
  });
});
