import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  chromiumCandidates,
  contractProbeHonored,
  defaultProbe,
  formatReport,
  nodeSatisfies,
  parsePinnedNodeVersion,
  postgresPlan,
  provisionPlan,
  rustBinCandidates,
  runDoctor,
  RUST_BINS,
} from "./native-deps.mjs";

// Synthetic contract-probe outputs for the LOGIC tests (they exercise the
// doctor's honored/not-honored decision, NOT the real binary — the real binary
// is spawned by the real-bin test below, which is the anti-drift guard). A
// CURRENT bin's probe output satisfies its `contractProbe.requireAll` and
// carries none of `rejectAny`; a STALE bin's output trips a reject / drops a
// required token. These are deliberately minimal, not copied banners.
const HONORED_PROBE_OUTPUT = {
  // whole-seen probe reaches the (redaction-safe) game-root error: no --scene/--output.
  "kaifuu-cli": "kaifuu.reallive.extract: game root not found under <redacted>\n",
  // render-validate --help carries every required contract token.
  "utsushi-cli":
    "utsushi render-validate\n  --engine reallive\n  --artifact-root <DIR>\n" +
    "  --require-semantic-reached-path\n",
};
const STALE_PROBE_OUTPUT = {
  // Stale kaifuu: no whole-seen support, so it demands --scene (a rejectAny token).
  "kaifuu-cli": "missing flag --scene\n",
  // Stale utsushi: an older render-validate help missing the gate flag.
  "utsushi-cli": "utsushi render-validate\n  --engine reallive\n  --artifact-root <DIR>\n",
};

// A fully in-memory probe: the doctor never touches the real filesystem,
// network, or child processes in these tests.
// `existing` / `runnable` entries match by path SUFFIX so tests need not know
// the absolute REPO_ROOT the doctor resolves against (e.g. "kaifuu-cli"
// matches "<repo>/target/release/kaifuu-cli").
// `staleBins` (suffixes) makes `probeOf` return the STALE output for that bin;
// `probeOk: false` forces `probeOf` to report a spawn failure.
function fakeProbe({
  nodeVersionFile = "24.14.0\n",
  nodeVersion = "v24.14.0",
  existing = [],
  onPath = new Set(),
  runnable = null, // suffixes of runnable bin paths; null => everything runs
  staleBins = [], // suffixes whose contract probe does NOT honor the current contract
  probeOk = true, // false => probeOf reports a spawn failure
  globHit = null,
  tcpOpen = new Set(),
  commands = {},
} = {}) {
  const suffixMatch = (list, p) =>
    list.some((s) => p === s || p.endsWith(`/${s}`) || p.endsWith(s));
  const canRun = (p) => runnable === null || suffixMatch(runnable, p);
  const binNameOf = (p) => {
    for (const b of RUST_BINS) {
      if (p === b.name || p.endsWith(`/${b.name}`) || p.endsWith(b.name)) return b.name;
    }
    return pathBasename(p);
  };
  return {
    readNodeVersion: () => nodeVersionFile,
    nodeVersion: () => nodeVersion,
    exists: (p) => suffixMatch(existing, p),
    which: (name) => (onPath.has(name) ? `/usr/bin/${name}` : null),
    glob: () => globHit,
    versionOf: (p) => (canRun(p) ? { ok: true, version: "x 1.0" } : { ok: false, error: "boom" }),
    probeOf: (p) => {
      if (!probeOk) return { ok: false, error: "spawn failed", text: "" };
      const name = binNameOf(p);
      const table = suffixMatch(staleBins, p) ? STALE_PROBE_OUTPUT : HONORED_PROBE_OUTPUT;
      return { ok: true, text: table[name] || `usage: ${name}\n` };
    },
    tcp: (host, port) => tcpOpen.has(`${host}:${port}`),
    commands: () => commands,
  };
}

function pathBasename(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

test("parsePinnedNodeVersion accepts a bare semver and rejects junk", () => {
  assert.equal(parsePinnedNodeVersion("24.14.0\n"), "24.14.0");
  assert.throws(() => parsePinnedNodeVersion("v24"), /bare semver/);
});

test("nodeSatisfies matches major and requires >= within it", () => {
  assert.equal(nodeSatisfies("v24.14.0", "24.14.0"), true);
  assert.equal(nodeSatisfies("v24.15.0", "24.14.0"), true); // newer patch/minor ok
  assert.equal(nodeSatisfies("v24.13.9", "24.14.0"), false); // older minor
  assert.equal(nodeSatisfies("v22.20.0", "24.14.0"), false); // wrong major
  assert.equal(nodeSatisfies("v25.0.0", "24.14.0"), false); // newer major is NOT accepted
});

test("rustBinCandidates orders env override before bundled, build, then PATH", () => {
  const bin = RUST_BINS[0];
  const cands = rustBinCandidates(
    bin,
    { [bin.envVar]: "/pin/kaifuu-cli", ITOTORI_LIBEXEC_DIR: "/lib", CARGO_TARGET_DIR: "/ct" },
    "/repo",
  );
  const sources = cands.map((c) => c.source);
  assert.equal(cands[0].path, "/pin/kaifuu-cli");
  assert.equal(sources[0], `env:${bin.envVar}`);
  assert.ok(sources.indexOf("bundled:libexec") < sources.indexOf("build:release"));
  assert.ok(sources.indexOf("build:release") < sources.lastIndexOf("path"));
  // repo target/ is always searched even without CARGO_TARGET_DIR
  assert.ok(cands.some((c) => c.path === "/repo/target/release/kaifuu-cli"));
});

test("chromiumCandidates reuses the existing pipeline env vars first", () => {
  const cands = chromiumCandidates(
    { UTSUSHI_BROWSER_BIN: "/nix/chromium", PLAYWRIGHT_CHROMIUM_BIN: "/pw/chromium" },
    "/home/u",
  );
  // ITOTORI_CHROMIUM_BIN is unset here, so the first candidate is the existing
  // UTSUSHI_BROWSER_BIN env var, then PLAYWRIGHT_CHROMIUM_BIN.
  assert.equal(cands[0].path, "/nix/chromium");
  assert.equal(cands[0].source, "env:UTSUSHI_BROWSER_BIN");
  assert.equal(cands[1].path, "/pw/chromium");
  assert.ok(cands.some((c) => c.source === "download:playwright"));
  assert.ok(cands.some((c) => c.path === "chromium" && c.source === "path"));
});

test("postgresPlan prefers DATABASE_URL, then portable, then container", () => {
  assert.equal(postgresPlan({ DATABASE_URL: "postgres://u:pw@db.local:6000/x" }).mode, "explicit");
  const explicit = postgresPlan({ DATABASE_URL: "postgres://u:pw@db.local:6000/x" });
  assert.equal(explicit.detail.host, "db.local");
  assert.equal(explicit.detail.port, 6000);
  assert.ok(!explicit.detail.url.includes("pw"), "password must be redacted");
  assert.equal(postgresPlan({ ITOTORI_POSTGRES_BIN_DIR: "/pg" }).mode, "portable");
  assert.equal(postgresPlan({}, { docker: true }).mode, "container");
  assert.equal(postgresPlan({}, {}).mode, "none");
});

test("doctor is green when every dep resolves and runs", () => {
  const kaifuu = "kaifuu-cli";
  const utsushi = "utsushi-cli";
  const report = runDoctor({
    env: { DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori" },
    profile: "full",
    probe: fakeProbe({
      existing: [kaifuu, utsushi],
      globHit: "/home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome",
      tcpOpen: new Set(["127.0.0.1:56000"]),
    }),
  });
  assert.equal(report.ok, true, formatReport(report));
  assert.ok(report.deps.every((d) => d.status === "ok"));
});

test("doctor fails LOUD with a fix-it when the Rust bins are missing", () => {
  const report = runDoctor({
    env: { DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori" },
    profile: "core",
    probe: fakeProbe({ tcpOpen: new Set(["127.0.0.1:56000"]) }),
  });
  assert.equal(report.ok, false);
  const rust = report.deps.find((d) => d.id === "rust:kaifuu-cli");
  assert.equal(rust.status, "fail");
  assert.match(rust.fix, /cargo build --release -p kaifuu-cli/);
});

test("doctor fails when a bin is present but NOT runnable (wrong platform)", () => {
  const kaifuu = "kaifuu-cli";
  const utsushi = "utsushi-cli";
  const report = runDoctor({
    env: { DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori" },
    profile: "core",
    probe: fakeProbe({
      existing: [kaifuu, utsushi],
      runnable: [utsushi], // kaifuu resolves but won't execute
      tcpOpen: new Set(["127.0.0.1:56000"]),
    }),
  });
  const rust = report.deps.find((d) => d.id === "rust:kaifuu-cli");
  assert.equal(rust.status, "fail");
  assert.match(rust.message, /not runnable/);
});

test("doctor passes when each bin's subcommand contract probe is honored", () => {
  const kaifuu = "kaifuu-cli";
  const utsushi = "utsushi-cli";
  const report = runDoctor({
    env: { DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori" },
    profile: "core",
    probe: fakeProbe({
      existing: [kaifuu, utsushi],
      tcpOpen: new Set(["127.0.0.1:56000"]),
    }),
  });
  assert.equal(report.ok, true, formatReport(report));
  const k = report.deps.find((d) => d.id === "rust:kaifuu-cli");
  const u = report.deps.find((d) => d.id === "rust:utsushi-cli");
  assert.equal(k.status, "ok");
  assert.equal(u.status, "ok");
});

test("doctor fails when a bin runs but does NOT honor the current subcommand contract (stale)", () => {
  const kaifuu = "kaifuu-cli";
  const utsushi = "utsushi-cli";
  const report = runDoctor({
    env: { DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori" },
    profile: "core",
    probe: fakeProbe({
      existing: [kaifuu, utsushi],
      // kaifuu still executes but its extract subcommand demands --scene under
      // --whole-seen (a stale contract that no longer matches the pipeline).
      staleBins: [kaifuu],
      tcpOpen: new Set(["127.0.0.1:56000"]),
    }),
  });
  assert.equal(report.ok, false);
  const rust = report.deps.find((d) => d.id === "rust:kaifuu-cli");
  assert.equal(rust.status, "fail");
  assert.match(rust.message, /STALE\/incompatible/);
  assert.match(rust.message, /does NOT honor the current CLI contract/);
  assert.match(rust.fix, /cargo build --release -p kaifuu-cli/);
  // utsushi still honors its contract and must remain ok.
  const u = report.deps.find((d) => d.id === "rust:utsushi-cli");
  assert.equal(u.status, "ok");
});

test("doctor fails a bin whose contract probe cannot even spawn", () => {
  const report = runDoctor({
    env: { DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori" },
    profile: "core",
    probe: fakeProbe({
      existing: ["kaifuu-cli", "utsushi-cli"],
      probeOk: false, // subcommand probe cannot run
      tcpOpen: new Set(["127.0.0.1:56000"]),
    }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.deps.find((d) => d.id === "rust:kaifuu-cli").status, "fail");
});

// contractProbeHonored: the pure decision logic behind the handshake.
test("contractProbeHonored requires all tokens and rejects any stale token", () => {
  const probe = { requireAll: ["--engine reallive"], rejectAny: ["--scene"] };
  assert.equal(contractProbeHonored(probe, { ok: true, text: "... --engine reallive ..." }), true);
  // missing a required token
  assert.equal(contractProbeHonored(probe, { ok: true, text: "no engine here" }), false);
  // carries a rejected token
  assert.equal(
    contractProbeHonored(probe, { ok: true, text: "--engine reallive missing flag --scene" }),
    false,
  );
  // spawn failure is never honored
  assert.equal(contractProbeHonored(probe, { ok: false, text: "" }), false);
});

// Guard the probe descriptors themselves: every bin declares a real contract
// probe with a subcommand invocation (not a bare `--help`) so the doctor can
// exercise the actual contract, and the rejectAny tokens can't be trivially
// satisfied by an empty output.
test("every RUST_BIN declares a subcommand contract probe", () => {
  for (const bin of RUST_BINS) {
    assert.ok(bin.contractProbe, `${bin.name} must declare a contractProbe`);
    assert.ok(Array.isArray(bin.contractProbe.args) && bin.contractProbe.args.length >= 1);
    assert.ok(
      Array.isArray(bin.contractProbe.requireAll) && Array.isArray(bin.contractProbe.rejectAny),
    );
    assert.ok(
      bin.contractProbe.requireAll.length + bin.contractProbe.rejectAny.length >= 1,
      `${bin.name} contractProbe must assert at least one token`,
    );
    assert.equal(typeof bin.contractProbe.description, "string");
  }
});

test("doctor fails when DATABASE_URL is set but unreachable", () => {
  const report = runDoctor({
    env: { DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori" },
    profile: "core",
    probe: fakeProbe({
      existing: ["kaifuu-cli", "utsushi-cli"],
      tcpOpen: new Set(),
    }),
  });
  const pg = report.deps.find((d) => d.id === "postgres");
  assert.equal(pg.status, "fail");
  assert.match(pg.fix, /just db-up/);
});

test("core profile does not require Chromium; render does", () => {
  const probe = fakeProbe({
    existing: ["kaifuu-cli", "utsushi-cli"],
    tcpOpen: new Set(["127.0.0.1:56000"]),
  });
  const env = { DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori" };
  assert.equal(runDoctor({ env, profile: "core", probe }).ok, true);
  const render = runDoctor({ env, profile: "render", probe });
  assert.equal(render.ok, false);
  assert.ok(render.deps.some((d) => d.id === "chromium" && d.status === "fail"));
});

test("provisionPlan proposes the deterministic commands for missing deps", () => {
  const actions = provisionPlan({
    env: {},
    profile: "full",
    probe: fakeProbe({ commands: { cargo: true, pnpm: true, docker: true } }),
  });
  const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
  assert.deepEqual(byId.rust.cmd, [
    "cargo",
    "build",
    "--release",
    "-p",
    "kaifuu-cli",
    "-p",
    "utsushi-cli",
  ]);
  assert.deepEqual(byId.chromium.cmd, ["pnpm", "exec", "playwright", "install", "chromium"]);
  assert.deepEqual(byId.postgres.cmd, ["just", "db-up"]);
});

test("provisionPlan degrades to a manual note when toolchains are absent", () => {
  const actions = provisionPlan({
    env: {},
    profile: "full",
    probe: fakeProbe({ commands: {} }),
  });
  const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
  assert.equal(byId.rust.cmd, null);
  assert.match(byId.rust.note, /cargo not found/);
  assert.equal(byId.postgres.cmd, null);
  assert.match(byId.postgres.note, /DATABASE_URL|portable/);
});

// ---------------------------------------------------------------------------
// REAL-BINARY contract probe (anti-drift): build the current source into a
// test-private target before probing it. Merely resolving an existing binary
// from CARGO_TARGET_DIR is racy: another worktree can replace that shared path
// between discovery and spawn, and existence says nothing about freshness.
// A private build both removes that race and makes a broken current contract
// fail loudly instead of green-skipping when no prebuilt binary happens to be
// present.
const realBinTarget = mkdtempSync(join(tmpdir(), "itotori-native-deps-contract-"));

function realBinPath(bin) {
  const executableName = process.platform === "win32" ? `${bin.name}.exe` : bin.name;
  return join(realBinTarget, "debug", executableName);
}

before(() => {
  const build = spawnSync(
    "cargo",
    ["build", "--quiet", ...RUST_BINS.flatMap((bin) => ["-p", bin.name])],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, CARGO_TARGET_DIR: realBinTarget },
    },
  );
  assert.equal(
    build.status,
    0,
    `could not build private native-deps contract fixtures:\n${build.stdout}${build.stderr}`,
  );
});

after(() => rmSync(realBinTarget, { recursive: true, force: true }));

for (const bin of RUST_BINS) {
  test(`REAL ${bin.name}: freshly-built bin HONORS its subcommand contract probe`, () => {
    const realPath = realBinPath(bin);
    const probe = defaultProbe();
    const probeResult = probe.probeOf(realPath, bin.contractProbe.args);
    assert.ok(
      probeResult.ok,
      `${bin.name} contract probe could not spawn ${realPath}: ${probeResult.error}`,
    );
    assert.ok(
      contractProbeHonored(bin.contractProbe, probeResult),
      `current ${bin.name} at ${realPath} must PASS the contract handshake ` +
        `(${bin.contractProbe.description}); real probe output was:\n${probeResult.text}`,
    );
    // And the full doctor rust-bin check reports OK for this real bin.
    const fixtureEnv = {
      ...process.env,
      CARGO_TARGET_DIR: realBinTarget,
      DATABASE_URL: "postgres://x@127.0.0.1:1/x",
    };
    for (const fixtureBin of RUST_BINS) {
      fixtureEnv[fixtureBin.envVar] = realBinPath(fixtureBin);
    }
    const report = runDoctor({
      env: fixtureEnv,
      profile: "core",
      probe,
    });
    const dep = report.deps.find((d) => d.id === `rust:${bin.name}`);
    assert.equal(dep.status, "ok", `real ${bin.name} doctor status: ${JSON.stringify(dep)}`);
  });
}
