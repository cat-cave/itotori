import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chromiumCandidates,
  formatReport,
  nodeSatisfies,
  parsePinnedNodeVersion,
  postgresPlan,
  provisionPlan,
  rustBinCandidates,
  runDoctor,
  RUST_BINS,
} from "./native-deps.mjs";

// Default --help text that includes each RUST_BINS compatMarker so green-path
// tests pass the CLI-surface handshake without per-test boilerplate.
const DEFAULT_HELP_BY_BIN = Object.fromEntries(
  RUST_BINS.map((b) => [b.name, `usage: ${b.name}\n  ${b.compatMarker}\n`]),
);

// A fully in-memory probe: the doctor never touches the real filesystem,
// network, or child processes in these tests.
// `existing` / `runnable` entries match by path SUFFIX so tests need not know
// the absolute REPO_ROOT the doctor resolves against (e.g. "kaifuu-cli"
// matches "<repo>/target/release/kaifuu-cli").
// `helpText` maps bin-name suffix → --help body (default includes compatMarkers).
// `helpOk: false` forces helpOf to fail; `staleBins` omits the compatMarker.
function fakeProbe({
  nodeVersionFile = "24.14.0\n",
  nodeVersion = "v24.14.0",
  existing = [],
  onPath = new Set(),
  runnable = null, // suffixes of runnable bin paths; null => everything runs
  helpText = null, // optional map suffix -> help string; null => DEFAULT_HELP_BY_BIN
  staleBins = [], // suffixes whose --help LACKS the current compatMarker
  helpOk = true,
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
    helpOf: (p) => {
      if (!helpOk) return { ok: false, error: "no help", text: "" };
      const name = binNameOf(p);
      if (suffixMatch(staleBins, p)) {
        // Runnable but missing the current CLI surface marker.
        return { ok: true, text: `usage: ${name}\n  (stale surface)\n` };
      }
      if (helpText && (helpText[name] !== undefined || helpText[p] !== undefined)) {
        return { ok: true, text: helpText[name] ?? helpText[p] };
      }
      return { ok: true, text: DEFAULT_HELP_BY_BIN[name] || `usage: ${name}\n` };
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

test("doctor passes when bin --help contains the current CLI surface marker", () => {
  const kaifuu = "kaifuu-cli";
  const utsushi = "utsushi-cli";
  const report = runDoctor({
    env: { DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori" },
    profile: "core",
    probe: fakeProbe({
      existing: [kaifuu, utsushi],
      // Explicit help text that includes each RUST_BINS.compatMarker.
      helpText: {
        "kaifuu-cli": "kaifuu-cli extract --whole-seen ...\n",
        "utsushi-cli": "utsushi-cli render-validate --engine reallive ...\n",
      },
      tcpOpen: new Set(["127.0.0.1:56000"]),
    }),
  });
  assert.equal(report.ok, true, formatReport(report));
  const k = report.deps.find((d) => d.id === "rust:kaifuu-cli");
  const u = report.deps.find((d) => d.id === "rust:utsushi-cli");
  assert.equal(k.status, "ok");
  assert.equal(u.status, "ok");
});

test("doctor fails when a bin runs but --help LACKS the current CLI surface (stale)", () => {
  const kaifuu = "kaifuu-cli";
  const utsushi = "utsushi-cli";
  const report = runDoctor({
    env: { DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:56000/itotori" },
    profile: "core",
    probe: fakeProbe({
      existing: [kaifuu, utsushi],
      // kaifuu still executes but its --help is missing --whole-seen.
      staleBins: [kaifuu],
      tcpOpen: new Set(["127.0.0.1:56000"]),
    }),
  });
  assert.equal(report.ok, false);
  const rust = report.deps.find((d) => d.id === "rust:kaifuu-cli");
  assert.equal(rust.status, "fail");
  assert.match(rust.message, /STALE\/incompatible/);
  assert.match(rust.message, /--whole-seen/);
  assert.match(rust.fix, /cargo build --release -p kaifuu-cli/);
  // utsushi still has a current surface and must remain ok.
  const u = report.deps.find((d) => d.id === "rust:utsushi-cli");
  assert.equal(u.status, "ok");
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
