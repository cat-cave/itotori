// UTSUSHI-228 — driver unit tests. These use `node --test` so they run
// without depending on vitest's TypeScript pipeline; the driver itself is
// plain JS by design (it shells out to cargo / node).
//
// Covers:
//   1. `--dry-run --project ...` exits 0, prints the per-phase
//      commands, makes ZERO LLM calls, writes ZERO files.
//   2. `--dry-run` without `--project` exits non-zero with a usage line.
//   3. `--help` exits 0 with the usage string.
//   4. Missing OPENROUTER_API_KEY without `--dry-run` exits non-zero.
//   5. OPENROUTER_LIVE=1 without OPENROUTER_API_KEY exits non-zero with
//      a specific "no-fallback" message.
//
// Linux-only (the driver is Linux-only by design).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = resolve(HERE, "run.mjs");
const REPO_ROOT = resolve(HERE, "../../..");
const DEFAULT_PAIR_POLICY_PATH = resolve(REPO_ROOT, "presets/localize-project.pair-policy.json");
const DEFAULT_ALPHA_TARGET_DATA_PATH = resolve(
  REPO_ROOT,
  "presets/localize-project.alpha-target-data.json",
);
const { verifyProviderRunArtifactsAfterStage } = await import(DRIVER_PATH);
const MODEL_ID = "deepseek/deepseek-v4-flash";
const PROVIDER_ID = "fireworks";

function runDriver(args, env = {}) {
  // The driver inherits PATH / NODE etc. from the caller. We
  // start from a CLEAN env so a stray OPENROUTER_API_KEY in the
  // dev shell doesn't pollute the negative-path tests; then layer
  // PATH back in so node can find itself.
  const cleanEnv = { PATH: process.env.PATH };
  return spawnSync(process.execPath, [DRIVER_PATH, ...args], {
    env: { ...cleanEnv, ...env },
    encoding: "utf8",
  });
}

function writeProjectMetadata(projectId, fields) {
  const dir = mkdtempSync(join(tmpdir(), "itotori-project-metadata-"));
  const path = join(dir, "project-metadata.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: "itotori.localize-project.project-metadata.v0",
        projectId,
        reallive: fields,
      },
      null,
      2,
    )}\n`,
  );
  return { dir, path };
}

function writePairPolicy(projectId) {
  const dir = mkdtempSync(join(tmpdir(), "itotori-pair-policy-"));
  const path = join(dir, "pair-policy.json");
  const policy = JSON.parse(readFileSync(DEFAULT_PAIR_POLICY_PATH, "utf8"));
  policy.policyId = projectId;
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`);
  return { dir, path };
}

function writeRealCorpusManifest(corpora) {
  const dir = mkdtempSync(join(tmpdir(), "itotori-real-corpus-manifest-"));
  const path = join(dir, "real-corpus-manifest.local.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: "itotori.real-corpus-manifest.v0",
        corpora,
      },
      null,
      2,
    )}\n`,
  );
  return { dir, path };
}

function writeAlphaTargetData(targets) {
  const dir = mkdtempSync(join(tmpdir(), "itotori-alpha-target-data-"));
  const path = join(dir, "alpha-target-data.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: "itotori.localize-project.alpha-target-data.v0",
        targets,
      },
      null,
      2,
    )}\n`,
  );
  return { dir, path };
}

function writeProviderProofFixture({ artifactRunId = "openrouter-proof-1" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "itotori-driver-provider-proof-"));
  const runDir = join(root, "run");
  const providerRunArtifactsDir = join(runDir, "provider-runs");
  const providerRunDir = join(providerRunArtifactsDir, artifactRunId);
  mkdirSync(providerRunDir, { recursive: true });

  const agenticLoopBundlePath = join(runDir, "agentic-loop-bundle.v0.json");
  const patchReportPath = join(runDir, "patch-report.json");
  writeJson(agenticLoopBundlePath, {
    schemaVersion: "itotori.agentic-loop-bundle.v2",
    stages: [
      {
        stageName: "translation",
        outcome: "accepted",
        invocations: [
          {
            invocationId: "translation:primary:openrouter-proof-1",
            pair: { modelId: MODEL_ID, providerId: PROVIDER_ID },
            providerProofId: "openrouter-proof-1",
            costUsd: "0.00000100",
            zdr: true,
          },
        ],
      },
    ],
  });
  writeJson(patchReportPath, {
    schemaVersion: "itotori.localize-project.patch-report.v0",
    pair: { modelId: MODEL_ID, providerId: PROVIDER_ID },
    finalDraftText: "[en-US] fixture translated draft",
    translatedTargetText: "「[en-US] fixture translated draft」",
  });
  writeJson(join(providerRunDir, "provider-run.json"), {
    schemaVersion: "itotori.provider-run.v0",
    run: {
      runId: artifactRunId,
      startedAt: "2026-06-27T12:00:00.000Z",
      completedAt: "2026-06-27T12:00:01.000Z",
      status: "succeeded",
      provider: {
        providerFamily: "openrouter",
        endpointFamily: "chat-completions",
        requestedModelId: MODEL_ID,
        requestedProviderId: PROVIDER_ID,
        actualModelId: MODEL_ID,
      },
      cost: {
        costKind: "billed",
        amountMicrosUsd: 1,
      },
      routingPosture: {
        order: [PROVIDER_ID],
        allow_fallbacks: true,
        data_collection: "deny",
        zdr: true,
      },
    },
    request: {
      requestedModelId: MODEL_ID,
    },
  });

  return {
    root,
    agenticLoopBundlePath,
    patchReportPath,
    providerRunArtifactsDir,
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertNoPrivateOrAbsolutePaths(value, forbiddenRoots) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /\/(?:home|scratch|Users)(?:\/|$)/u);
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/u);
  for (const root of forbiddenRoots) {
    assert.ok(!serialized.includes(root), `JSON leaked private root ${root}`);
  }
}

test("--dry-run --project ... exits 0 and prints per-phase commands", () => {
  const result = runDriver(["--dry-run", "--project", "sweetie-hd-alpha-1"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  // The dry-run plan must reference all five phases by their CLI
  // surfaces (extract -> stage -> patch -> replay-validate -> render-validate).
  // We greet on substrings so a flag-shape refactor in a sibling step
  // doesn't break this test.
  assert.ok(
    result.stdout.includes("kaifuu-cli"),
    `dry-run plan must mention kaifuu-cli; got:\n${result.stdout}`,
  );
  assert.equal(
    (result.stdout.match(/\(planned\) \$ /gu) ?? []).length,
    5,
    `dry-run plan must preserve the five-phase command shape; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("--game-id sweetie-hd") &&
      result.stdout.includes("--game-version 1.0.0") &&
      result.stdout.includes("--source-profile-id kaifuu-reallive-sweetie-hd") &&
      result.stdout.includes("--source-locale ja-JP"),
    `dry-run extract command must pass RealLive identity metadata from the project preset; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("localize-project-stage"),
    `dry-run plan must mention the agentic-loop stage; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("--provider-run-artifacts-dir") &&
      result.stdout.includes("provider-runs"),
    `dry-run plan must persist provider-run artifacts under the run dir; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("patch --engine reallive"),
    `dry-run plan must mention the kaifuu patch step; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("replay-validate --engine reallive"),
    `dry-run plan must mention the replay-validate step; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("render-validate --engine reallive") &&
      result.stdout.includes("--expect-text-contains <real-translated-draft-from-patch-report>"),
    `dry-run plan must mention the real rendered-frame (render-validate) step; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("0 LLM calls"),
    `dry-run plan must declare zero LLM calls; got:\n${result.stdout}`,
  );
  // ITOTORI-227 — every dry-run plan must surface the ZDR posture so
  // the operator can confirm OPENROUTER_ZDR_ACCOUNT_ASSERTED=1 is set
  // and every non-public stage carries provider.zdr=true.
  assert.ok(
    result.stdout.includes("ZDR account asserted: OPENROUTER_ZDR_ACCOUNT_ASSERTED="),
    `dry-run plan must report the ZDR account-assertion env; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("Per-stage provider.zdr posture: true"),
    `dry-run plan must declare the per-stage provider.zdr posture; got:\n${result.stdout}`,
  );
  // ITOTORI-234 — every leaf must surface its zdr + seed posture so the
  // operator can confirm the v0.3 pair-policy resolved as expected
  // before the live run fires.
  assert.ok(
    result.stdout.includes("Per-stage posture (ITOTORI-234 v0.3"),
    `dry-run plan must declare the ITOTORI-234 per-stage posture block; got:\n${result.stdout}`,
  );
  assert.ok(
    /stage context\.sceneSummary: zdr=true seed=\d+/u.test(result.stdout),
    `dry-run plan must surface zdr+seed for context.sceneSummary; got:\n${result.stdout}`,
  );
  assert.ok(
    /stage translation\.primary: zdr=true seed=\d+/u.test(result.stdout),
    `dry-run plan must surface zdr+seed for translation.primary; got:\n${result.stdout}`,
  );
  assert.ok(
    /stage repair\.primary: zdr=true seed=\d+/u.test(result.stdout),
    `dry-run plan must surface zdr+seed for repair.primary; got:\n${result.stdout}`,
  );
});

test("--dry-run --project lust-memory-alpha-1 plans the RPG Maker MV/MZ full loop (inventory front + feedback/rerun back)", () => {
  const result = runDriver(["--dry-run", "--project", "lust-memory-alpha-1"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  // Full loop: detect(front) -> extract -> stage -> patch+delta ->
  // delta-apply -> runtime -> feedback -> rerun(stage -> patch -> apply ->
  // runtime) -> rerun feedback. 12 planned lines (10 external commands +
  // 2 in-driver feedback syntheses).
  assert.equal(
    (result.stdout.match(/\(planned\) \$ /gu) ?? []).length,
    12,
    `MV/MZ dry-run plan must preserve the full-loop command shape; got:\n${result.stdout}`,
  );
  // Inventory/readiness FRONT: detect must be the FIRST planned command,
  // ahead of the extract (bridge-import) command.
  const detectIndex = result.stdout.indexOf("kaifuu-cli -- detect");
  const extractIndex = result.stdout.indexOf("extract --engine rpgmaker");
  assert.ok(
    detectIndex >= 0 && extractIndex >= 0 && detectIndex < extractIndex,
    `MV/MZ dry-run must plan kaifuu detect (inventory/readiness front) BEFORE extract; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("inventory/readiness FRONT") &&
      result.stdout.includes("feedback -> rerun"),
    `MV/MZ dry-run must announce the inventory-front + feedback/rerun-back loop; got:\n${result.stdout}`,
  );
  // RPG Maker engine surfaces (NOT the RealLive Seen.txt path).
  assert.ok(
    result.stdout.includes("extract --engine rpgmaker") &&
      result.stdout.includes("--game-dir") &&
      result.stdout.includes("--game-id lust-memory") &&
      result.stdout.includes("--source-profile-id kaifuu-rpgmaker-lust-memory"),
    `MV/MZ dry-run extract must route through the rpgmaker engine with its identity metadata; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("--engine-profile rpg-maker-mv-mz"),
    `MV/MZ stage must pass the rpg-maker-mv-mz engine profile; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("patch --engine rpgmaker") &&
      result.stdout.includes("--delta-output") &&
      result.stdout.includes("--patched-data-output"),
    `MV/MZ dry-run must plan the rpgmaker patchback + delta producer; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("rpgmaker-mv-capture") &&
      result.stdout.includes("--assert-observed-text <real-translated-draft-from-patch-report>"),
    `MV/MZ dry-run must plan the text-trace runtime evidence step asserting the engine observes the real translated text; got:\n${result.stdout}`,
  );
  // Feedback + rerun BACK: a synthesize-feedback step and a rerun-suffixed
  // capture run must appear after the initial runtime evidence.
  assert.ok(
    result.stdout.includes("synthesize feedback") &&
      result.stdout.includes("--run-id rpgmaker-mv-mz-lust-memory-alpha-1-rerun") &&
      result.stdout.includes("synthesize rerun feedback"),
    `MV/MZ dry-run must plan feedback synthesis + a rerun iteration; got:\n${result.stdout}`,
  );
  assert.ok(
    !result.stdout.includes("--engine reallive") &&
      !result.stdout.includes("REALLIVEDATA/Seen.txt"),
    `MV/MZ dry-run must not reference the RealLive Seen.txt path; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("0 LLM calls"),
    `MV/MZ dry-run plan must declare zero LLM calls; got:\n${result.stdout}`,
  );
});

test("Sweetie metadata is loaded from explicit alpha target data, not a generic metadata preset", () => {
  const result = runDriver(["--dry-run", "--project", "sweetie-hd-alpha-1"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(
    result.stdout.includes(`--pair-policy ${DEFAULT_PAIR_POLICY_PATH}`),
    `dry-run plan must resolve Sweetie's allowlisted target pair-policy; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("--game-id sweetie-hd") &&
      result.stdout.includes("--source-profile-id kaifuu-reallive-sweetie-hd"),
    `dry-run plan must keep Sweetie metadata available through target data; got:\n${result.stdout}`,
  );
  assert.ok(
    !result.stdout.includes("localize-project.project-metadata.json"),
    `dry-run plan must not depend on the retired generic Sweetie metadata preset; got:\n${result.stdout}`,
  );
});

test("--dry-run can use caller-supplied non-Sweetie project configs", () => {
  const metadata = writeProjectMetadata("fixture-alpha", {
    game_id: "fixture-reallive-game",
    game_version: "2026.06.test",
    source_profile_id: "fixture-reallive-profile",
    source_locale: "ja-JP-x-test",
  });
  const policy = writePairPolicy("fixture-alpha");
  try {
    const result = runDriver([
      "--dry-run",
      "--project",
      "fixture-alpha",
      "--project-metadata",
      metadata.path,
      "--pair-policy",
      policy.path,
    ]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes("--game-id fixture-reallive-game") &&
        result.stdout.includes("--game-version 2026.06.test") &&
        result.stdout.includes("--source-profile-id fixture-reallive-profile") &&
        result.stdout.includes("--source-locale ja-JP-x-test"),
      `dry-run extract command must use caller-supplied project metadata; got:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes("--pair-policy ") && result.stdout.includes(policy.path),
      `dry-run plan must use caller-supplied pair-policy; got:\n${result.stdout}`,
    );
    assert.ok(
      !result.stdout.includes("--game-id sweetie-hd") &&
        !result.stdout.includes("kaifuu-reallive-sweetie-hd"),
      `custom dry-run plan must not relabel default Sweetie metadata; got:\n${result.stdout}`,
    );
  } finally {
    rmSync(metadata.dir, { recursive: true, force: true });
    rmSync(policy.dir, { recursive: true, force: true });
  }
});

test("--dry-run can use caller-supplied non-Sweetie alpha target data", () => {
  const policy = writePairPolicy("fixture-alpha");
  const targetData = writeAlphaTargetData([
    {
      projectId: "fixture-alpha",
      pairPolicyPath: policy.path,
      reallive: {
        game_id: "fixture-target-game",
        game_version: "2026.06.target",
        source_profile_id: "fixture-target-profile",
        source_locale: "ja-JP-x-target",
      },
    },
  ]);
  try {
    const result = runDriver([
      "--dry-run",
      "--project",
      "fixture-alpha",
      "--target-data",
      targetData.path,
    ]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes("--game-id fixture-target-game") &&
        result.stdout.includes("--game-version 2026.06.target") &&
        result.stdout.includes("--source-profile-id fixture-target-profile") &&
        result.stdout.includes("--source-locale ja-JP-x-target"),
      `dry-run extract command must use caller-supplied target metadata; got:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes(`--pair-policy ${policy.path}`),
      `dry-run plan must use the target's pair-policy path; got:\n${result.stdout}`,
    );
    assert.ok(
      !result.stdout.includes("--game-id sweetie-hd") &&
        !result.stdout.includes("kaifuu-reallive-sweetie-hd"),
      `non-Sweetie target data must not inherit Sweetie metadata; got:\n${result.stdout}`,
    );
  } finally {
    rmSync(policy.dir, { recursive: true, force: true });
    rmSync(targetData.dir, { recursive: true, force: true });
  }
});

test("--dry-run resolves ITOTORI_REAL_CORPUS_MANIFEST by project, corpus, and engine", () => {
  const metadata = writeProjectMetadata("fixture-alpha", {
    game_id: "fixture-reallive-game",
    game_version: "2026.06.test",
    source_profile_id: "fixture-reallive-profile",
    source_locale: "ja-JP-x-test",
  });
  const policy = writePairPolicy("fixture-alpha");
  const privateRoot = join(tmpdir(), `itotori-private-root-${process.pid}-manifest-selection`);
  const directSourceRoot = join(tmpdir(), `itotori-direct-source-root-${process.pid}`);
  // Three decoys, each differing from the target in EXACTLY ONE selection
  // dimension (project, corpus, or engine) while sharing the other two. This
  // makes every filter independently load-bearing: if the resolver dropped any
  // one of the three filters, the matching decoy would survive and produce a
  // multiple-match error instead of the unique target. That is what proves the
  // corpus is resolved "by project, corpus, and engine" rather than by --corpus
  // alone.
  const manifest = writeRealCorpusManifest([
    {
      // Differs only by projectId — excluded by the project filter.
      corpusId: "fixture-corpus",
      projectId: "other-project",
      engine: "reallive",
      root: join(privateRoot, "wrong-project"),
      sourceLocale: "ja-JP-x-test",
    },
    {
      // Differs only by engine — excluded by the engine filter.
      corpusId: "fixture-corpus",
      projectId: "fixture-alpha",
      engine: "not-reallive",
      root: join(privateRoot, "wrong-engine"),
      sourceLocale: "ja-JP-x-test",
    },
    {
      // Differs only by corpusId — excluded by the --corpus filter.
      corpusId: "wrong-corpus",
      projectId: "fixture-alpha",
      engine: "reallive",
      root: join(privateRoot, "wrong-corpus"),
      sourceLocale: "ja-JP-x-test",
    },
    {
      // The unique target: matches project AND corpus AND engine.
      corpusId: "fixture-corpus",
      projectId: "fixture-alpha",
      engine: "reallive",
      root: privateRoot,
      sourceLocale: "ja-JP-x-test",
    },
  ]);
  try {
    const result = runDriver(
      [
        "--dry-run",
        "--project",
        "fixture-alpha",
        "--corpus",
        "fixture-corpus",
        "--project-metadata",
        metadata.path,
        "--pair-policy",
        policy.path,
      ],
      {
        ITOTORI_REAL_CORPUS_MANIFEST: manifest.path,
        LOCALIZE_PROJECT_SOURCE_PATH: directSourceRoot,
      },
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes(
        "ITOTORI_REAL_CORPUS_MANIFEST corpusId=fixture-corpus projectId=fixture-alpha engine=reallive root=<ITOTORI_REAL_CORPUS_MANIFEST root>",
      ),
      `dry-run plan must report the selected corpus without printing its root; got:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes("--game-root <ITOTORI_REAL_CORPUS_MANIFEST root>"),
      `dry-run extract command must use the manifest root placeholder; got:\n${result.stdout}`,
    );
    assert.ok(
      result.stdout.includes("--source <ITOTORI_REAL_CORPUS_MANIFEST root>"),
      `dry-run patch command must use the manifest root placeholder; got:\n${result.stdout}`,
    );
    assert.ok(
      !result.stdout.includes("<LOCALIZE_PROJECT_SOURCE_PATH>") &&
        !result.stdout.includes(directSourceRoot),
      `manifest descriptor must take precedence over direct source env without leaking it; got:\n${result.stdout}`,
    );
  } finally {
    rmSync(metadata.dir, { recursive: true, force: true });
    rmSync(policy.dir, { recursive: true, force: true });
    rmSync(manifest.dir, { recursive: true, force: true });
  }
});

test("missing source root diagnostic names the generic descriptor/root shape", () => {
  const result = runDriver(["--project", "sweetie-hd-alpha-1"], {
    OPENROUTER_API_KEY: "test-key",
  });
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("real corpus source root is required unless --dry-run"),
    `stderr should describe the missing generic real-corpus source; got:\n${result.stderr}`,
  );
  assert.ok(
    result.stderr.includes("ITOTORI_REAL_CORPUS_MANIFEST") &&
      result.stderr.includes("corpora[].{corpusId,projectId,engine,root}") &&
      result.stderr.includes("ITOTORI_REAL_GAME_ROOT") &&
      result.stderr.includes("LOCALIZE_PROJECT_SOURCE_PATH"),
    `stderr should name the generic descriptor/root contract; got:\n${result.stderr}`,
  );
});

test("driver provider artifact proof rejects count-only runId mismatches", () => {
  const fixture = writeProviderProofFixture({
    artifactRunId: "openrouter-proof-stale",
  });
  try {
    assert.throws(
      () =>
        verifyProviderRunArtifactsAfterStage({
          agenticLoopBundlePath: fixture.agenticLoopBundlePath,
          patchReportPath: fixture.patchReportPath,
          providerRunArtifactsDir: fixture.providerRunArtifactsDir,
          expectedPair: { modelId: MODEL_ID, providerId: PROVIDER_ID },
        }),
      /missing provider-run artifact for providerProofId\/runId openrouter-proof-1/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dry-run manifest resolution does not leak private corpus roots", () => {
  const privateRoot = join(tmpdir(), `itotori-private-root-${process.pid}-do-not-leak`);
  const manifest = writeRealCorpusManifest([
    {
      corpusId: "sweetie-hd-alpha-1",
      projectId: "sweetie-hd-alpha-1",
      engine: "reallive",
      root: privateRoot,
      sourceLocale: "ja-JP",
    },
  ]);
  try {
    const result = runDriver(["--dry-run", "--project", "sweetie-hd-alpha-1"], {
      ITOTORI_REAL_CORPUS_MANIFEST: manifest.path,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(
      !result.stdout.includes(privateRoot) && !result.stderr.includes(privateRoot),
      `dry-run output must not leak the private root; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    rmSync(manifest.dir, { recursive: true, force: true });
  }
});

test("live run rejects target-root symlink before output mutation", () => {
  const metadata = writeProjectMetadata("fixture-alpha", {
    game_id: "fixture-reallive-game",
    game_version: "2026.06.test",
    source_profile_id: "fixture-reallive-profile",
    source_locale: "ja-JP-x-test",
  });
  const policy = writePairPolicy("fixture-alpha");
  const work = mkdtempSync(join(tmpdir(), "itotori-target-symlink-"));
  const sourceRoot = join(work, "private-source-root");
  const targetRoot = join(work, "private-target-link");
  const linkedTarget = join(work, "private-linked-target");
  const sourceSeen = join(sourceRoot, "REALLIVEDATA", "Seen.txt");
  mkdirSync(join(sourceRoot, "REALLIVEDATA"), { recursive: true });
  mkdirSync(linkedTarget);
  writeFileSync(sourceSeen, "synthetic source seen bytes\n");
  symlinkSync(linkedTarget, targetRoot);

  try {
    const result = runDriver(
      [
        "--project",
        "fixture-alpha",
        "--project-metadata",
        metadata.path,
        "--pair-policy",
        policy.path,
        "--provider-kind",
        "fake",
      ],
      {
        OPENROUTER_API_KEY: "test-key",
        ITOTORI_REAL_GAME_ROOT: sourceRoot,
        TARGET: targetRoot,
        ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER: "1",
      },
    );
    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes("TARGET (<TARGET>) must not be a symlink"),
      `stderr should reject the target symlink with placeholders; got:\n${result.stderr}`,
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    for (const forbidden of [sourceRoot, targetRoot, linkedTarget]) {
      assert.ok(!combined.includes(forbidden), `diagnostic leaked private path ${forbidden}`);
    }
    assert.equal(readFileSync(sourceSeen, "utf8"), "synthetic source seen bytes\n");
    assert.deepEqual(readdirSync(linkedTarget), []);
  } finally {
    rmSync(metadata.dir, { recursive: true, force: true });
    rmSync(policy.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("live run rejects nested target REALLIVEDATA symlink to source before output mutation", () => {
  const metadata = writeProjectMetadata("fixture-alpha", {
    game_id: "fixture-reallive-game",
    game_version: "2026.06.test",
    source_profile_id: "fixture-reallive-profile",
    source_locale: "ja-JP-x-test",
  });
  const policy = writePairPolicy("fixture-alpha");
  const work = mkdtempSync(join(tmpdir(), "itotori-target-data-symlink-source-"));
  const sourceRoot = join(work, "private-source-root");
  const targetRoot = join(work, "private-target-root");
  const sourceData = join(sourceRoot, "REALLIVEDATA");
  const sourceSeen = join(sourceData, "Seen.txt");
  const targetData = join(targetRoot, "REALLIVEDATA");
  mkdirSync(sourceData, { recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(sourceSeen, "synthetic source seen bytes\n");
  symlinkSync(sourceData, targetData);

  try {
    const result = runDriver(
      [
        "--project",
        "fixture-alpha",
        "--project-metadata",
        metadata.path,
        "--pair-policy",
        policy.path,
        "--provider-kind",
        "fake",
      ],
      {
        OPENROUTER_API_KEY: "test-key",
        ITOTORI_REAL_GAME_ROOT: sourceRoot,
        TARGET: targetRoot,
        ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER: "1",
      },
    );
    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes("TARGET (<TARGET>) tree must not contain symlinks"),
      `stderr should reject nested target symlink with placeholders; got:\n${result.stderr}`,
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    for (const forbidden of [sourceRoot, targetRoot, sourceData, targetData]) {
      assert.ok(!combined.includes(forbidden), `diagnostic leaked private path ${forbidden}`);
    }
    assert.equal(readFileSync(sourceSeen, "utf8"), "synthetic source seen bytes\n");
  } finally {
    rmSync(metadata.dir, { recursive: true, force: true });
    rmSync(policy.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("live run rejects nested target symlink to writable directory before output mutation", () => {
  const metadata = writeProjectMetadata("fixture-alpha", {
    game_id: "fixture-reallive-game",
    game_version: "2026.06.test",
    source_profile_id: "fixture-reallive-profile",
    source_locale: "ja-JP-x-test",
  });
  const policy = writePairPolicy("fixture-alpha");
  const work = mkdtempSync(join(tmpdir(), "itotori-target-data-symlink-writable-"));
  const sourceRoot = join(work, "private-source-root");
  const targetRoot = join(work, "private-target-root");
  const linkedWritable = join(work, "private-linked-writable");
  const sourceSeen = join(sourceRoot, "REALLIVEDATA", "Seen.txt");
  mkdirSync(join(sourceRoot, "REALLIVEDATA"), { recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  mkdirSync(linkedWritable, { recursive: true });
  writeFileSync(sourceSeen, "synthetic source seen bytes\n");
  symlinkSync(linkedWritable, join(targetRoot, "REALLIVEDATA"));

  try {
    const result = runDriver(
      [
        "--project",
        "fixture-alpha",
        "--project-metadata",
        metadata.path,
        "--pair-policy",
        policy.path,
        "--provider-kind",
        "fake",
      ],
      {
        OPENROUTER_API_KEY: "test-key",
        ITOTORI_REAL_GAME_ROOT: sourceRoot,
        TARGET: targetRoot,
        ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER: "1",
      },
    );
    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes("TARGET (<TARGET>) tree must not contain symlinks"),
      `stderr should reject nested target symlink with placeholders; got:\n${result.stderr}`,
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    for (const forbidden of [sourceRoot, targetRoot, linkedWritable]) {
      assert.ok(!combined.includes(forbidden), `diagnostic leaked private path ${forbidden}`);
    }
    assert.equal(readFileSync(sourceSeen, "utf8"), "synthetic source seen bytes\n");
    assert.deepEqual(readdirSync(linkedWritable), []);
  } finally {
    rmSync(metadata.dir, { recursive: true, force: true });
    rmSync(policy.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("live run rejects canonical source alias and nested target before output mutation", () => {
  const metadata = writeProjectMetadata("fixture-alpha", {
    game_id: "fixture-reallive-game",
    game_version: "2026.06.test",
    source_profile_id: "fixture-reallive-profile",
    source_locale: "ja-JP-x-test",
  });
  const policy = writePairPolicy("fixture-alpha");
  const work = mkdtempSync(join(tmpdir(), "itotori-target-canonical-"));
  const sourceRoot = join(work, "private-source-root");
  const sourceLink = join(work, "private-source-link");
  const sourceSeen = join(sourceRoot, "REALLIVEDATA", "Seen.txt");
  mkdirSync(join(sourceRoot, "REALLIVEDATA"), { recursive: true });
  writeFileSync(sourceSeen, "synthetic source seen bytes\n");
  symlinkSync(sourceRoot, sourceLink);

  try {
    const aliasResult = runDriver(
      [
        "--project",
        "fixture-alpha",
        "--project-metadata",
        metadata.path,
        "--pair-policy",
        policy.path,
        "--provider-kind",
        "fake",
      ],
      {
        OPENROUTER_API_KEY: "test-key",
        ITOTORI_REAL_GAME_ROOT: sourceLink,
        TARGET: sourceRoot,
        ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER: "1",
      },
    );
    assert.notEqual(aliasResult.status, 0);
    assert.ok(
      aliasResult.stderr.includes("TARGET (<TARGET>) must not alias resolved source root"),
      `stderr should reject canonical source aliasing; got:\n${aliasResult.stderr}`,
    );

    const nestedTarget = join(sourceRoot, "nested-target");
    const nestedResult = runDriver(
      [
        "--project",
        "fixture-alpha",
        "--project-metadata",
        metadata.path,
        "--pair-policy",
        policy.path,
        "--provider-kind",
        "fake",
      ],
      {
        OPENROUTER_API_KEY: "test-key",
        ITOTORI_REAL_GAME_ROOT: sourceLink,
        TARGET: nestedTarget,
        ITOTORI_ALLOW_FAKE_LOCALIZE_PROVIDER: "1",
      },
    );
    assert.notEqual(nestedResult.status, 0);
    assert.ok(
      nestedResult.stderr.includes("TARGET (<TARGET>) must not nest with resolved source root"),
      `stderr should reject canonical source/target nesting; got:\n${nestedResult.stderr}`,
    );

    const combined = `${aliasResult.stdout}\n${aliasResult.stderr}\n${nestedResult.stdout}\n${nestedResult.stderr}`;
    for (const forbidden of [sourceRoot, sourceLink, nestedTarget]) {
      assert.ok(!combined.includes(forbidden), `diagnostic leaked private path ${forbidden}`);
    }
    assert.equal(readFileSync(sourceSeen, "utf8"), "synthetic source seen bytes\n");
    assert.ok(!existsSync(nestedTarget), "nested target must not be created");
  } finally {
    rmSync(metadata.dir, { recursive: true, force: true });
    rmSync(policy.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("--dry-run --project rejects projects missing from alpha target data", () => {
  const result = runDriver(["--dry-run", "--project", "different-project"]);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes(`alpha target data at ${DEFAULT_ALPHA_TARGET_DATA_PATH}`) &&
      result.stderr.includes("has no target for --project 'different-project'") &&
      result.stderr.includes("pass --project-metadata and --pair-policy"),
    `stderr should identify the missing target-data record; got:\n${result.stderr}`,
  );
  assert.ok(
    !result.stdout.includes("--game-id sweetie-hd"),
    `unknown projects must not fall back to Sweetie metadata; got:\n${result.stdout}`,
  );
});

test("--dry-run --project-metadata rejects metadata projectId mismatch", () => {
  const metadata = writeProjectMetadata("other-fixture-alpha", {
    game_id: "fixture-reallive-game",
    game_version: "2026.06.test",
    source_profile_id: "fixture-reallive-profile",
    source_locale: "ja-JP-x-test",
  });
  const policy = writePairPolicy("fixture-alpha");
  try {
    const result = runDriver([
      "--dry-run",
      "--project",
      "fixture-alpha",
      "--project-metadata",
      metadata.path,
      "--pair-policy",
      policy.path,
    ]);
    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes("metadata projectId='other-fixture-alpha'"),
      `stderr should identify the metadata project mismatch; got:\n${result.stderr}`,
    );
  } finally {
    rmSync(metadata.dir, { recursive: true, force: true });
    rmSync(policy.dir, { recursive: true, force: true });
  }
});

test("--dry-run --pair-policy rejects pair-policy policyId mismatch", () => {
  const metadata = writeProjectMetadata("fixture-alpha", {
    game_id: "fixture-reallive-game",
    game_version: "2026.06.test",
    source_profile_id: "fixture-reallive-profile",
    source_locale: "ja-JP-x-test",
  });
  const policy = writePairPolicy("other-fixture-alpha");
  try {
    const result = runDriver([
      "--dry-run",
      "--project",
      "fixture-alpha",
      "--project-metadata",
      metadata.path,
      "--pair-policy",
      policy.path,
    ]);
    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes("pair-policy policyId='other-fixture-alpha'"),
      `stderr should identify the pair-policy project mismatch; got:\n${result.stderr}`,
    );
  } finally {
    rmSync(metadata.dir, { recursive: true, force: true });
    rmSync(policy.dir, { recursive: true, force: true });
  }
});

test("dry-run output does not mention stale ITOTORI-234 schema wording", () => {
  const result = runDriver(["--dry-run", "--project", "sweetie-hd-alpha-1"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(
    !result.stdout.includes(`ITOTORI-234 ${"v0.2"}`),
    `dry-run plan must not mention stale schema wording; got:\n${result.stdout}`,
  );
});

test("missing project metadata exits before extraction/env validation", () => {
  const missingPath = join(
    tmpdir(),
    `itotori-missing-project-metadata-${process.pid}-${Date.now()}.json`,
  );
  const result = runDriver([
    "--dry-run",
    "--project",
    "sweetie-hd-alpha-1",
    "--project-metadata",
    missingPath,
  ]);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("project metadata file missing"),
    `stderr should mention missing project metadata; got:\n${result.stderr}`,
  );
  assert.ok(
    !result.stderr.includes("OPENROUTER_API_KEY"),
    `metadata validation should happen before env validation; got:\n${result.stderr}`,
  );
});

test("--dry-run without --project exits non-zero with a usage line", () => {
  const result = runDriver(["--dry-run"]);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("--project is required"),
    `stderr should say --project is required; got:\n${result.stderr}`,
  );
});

test("--help exits 0 with the usage string", () => {
  const result = runDriver(["--help"]);
  assert.equal(result.status, 0);
  assert.ok(
    result.stdout.includes("just localize-project") ||
      result.stdout.includes("localize-project/run.mjs"),
    `--help must print the usage line; got:\n${result.stdout}`,
  );
});

test("missing OPENROUTER_API_KEY without --dry-run exits non-zero", () => {
  const result = runDriver(["--project", "sweetie-hd-alpha-1"], {
    // Deliberately omit OPENROUTER_API_KEY, LOCALIZE_PROJECT_SOURCE_PATH,
    // and TARGET so the driver hits its first env-validation rejection.
  });
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("OPENROUTER_API_KEY"),
    `stderr should mention OPENROUTER_API_KEY; got:\n${result.stderr}`,
  );
});

test("OPENROUTER_LIVE=1 without OPENROUTER_API_KEY emits the no-fallback message", () => {
  const result = runDriver(["--project", "sweetie-hd-alpha-1"], {
    OPENROUTER_LIVE: "1",
    // No OPENROUTER_API_KEY — the no-fallback rule kicks in.
  });
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("OPENROUTER_LIVE=1") && result.stderr.includes("OPENROUTER_API_KEY"),
    `stderr should reference both env vars; got:\n${result.stderr}`,
  );
  assert.ok(
    result.stderr.includes("no-fallback") || result.stderr.includes("recorded provider"),
    `stderr should call out the no-fallback rule; got:\n${result.stderr}`,
  );
});
