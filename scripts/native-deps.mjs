#!/usr/bin/env node
// itotori native-deps provisioning + doctor (itotori-native-deps-provisioning).
//
// An INSTALLED (non-clone, no nix devshell) itotori must obtain and RUN its
// native dependencies, which today are provided only by `flake.nix`:
//
//   - the kaifuu/utsushi RUST BINARIES (decode/patch/render drivers),
//   - a NODE runtime (the itotori CLI + @itotori/db host),
//   - POSTGRES (the @itotori/db real-Postgres store),
//   - CHROMIUM (render / MV-MZ browser gates, wired via
//     PLAYWRIGHT_CHROMIUM_BIN / UTSUSHI_BROWSER_BIN).
//
// This module is the DETERMINISTIC provisioning seam:
//
//   node scripts/native-deps.mjs doctor      # verify each dep resolves + runs
//   node scripts/native-deps.mjs provision   # obtain the missing deps
//
// The RESOLUTION order below is the same seam the shipped artifact uses, and it
// deliberately reuses the env vars the existing pipeline already reads
// (DATABASE_URL, UTSUSHI_BROWSER_BIN / PLAYWRIGHT_CHROMIUM_BIN) so the doctor
// and the real runtime never disagree about which binary is authoritative.
//
// It is written against Node built-ins ONLY (no dependencies) so it can be
// shipped verbatim inside the installable artifact and run on a fresh machine
// before `pnpm install` has ever executed.
//
// The full design — the bundled-vs-required-vs-downloaded boundary and why the
// whole thing is privacy / ZDR / self-host safe — lives in
// docs/native-deps-provisioning.md.

import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// The live-provider secret env-var names that must NEVER reach a spawned
// native-CLI child. This doctor is Node-built-ins-only and runs BEFORE
// `pnpm install`, so it cannot import the compiled module — instead it reads
// the JSON array from the SINGLE source of truth
// (apps/itotori/src/env/live-provider-secret-vars.{ts,js}) at runtime, so the
// list can never drift from the app's env-file allowlist / spawn-scrub
// boundary.
//
// DURABILITY: an installed/packaged artifact ships the COMPILED `dist/` output
// and may NOT ship `src/`. Both the `.ts` source and the emitted `.js` carry
// the identical marker block, so the doctor prefers the shipped `dist/.js` and
// falls back to the `src/.ts` (dev / pre-build checkout). A drift test asserts
// the two blocks stay identical.
// Ordered candidate locations for the single-source marker block. `dist` first
// so an installed artifact (compiled, no src) resolves; `src` as the dev
// fallback. Relative to REPO_ROOT.
export const LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES = [
  "apps/itotori/dist/env/live-provider-secret-vars.js",
  "apps/itotori/src/env/live-provider-secret-vars.ts",
];

/**
 * Extract + validate the canonical array from a marker-block source body. The
 * `.ts` and emitted `.js` share the exact `LIVE_PROVIDER_SECRET_VARS_JSON = [ … ]`
 * literal, so the same parser handles both. Exported for the drift test.
 */
export function parseLiveProviderSecretVarsBlock(source) {
  const block = /LIVE_PROVIDER_SECRET_VARS_JSON\s*=\s*(\[[\s\S]*?\]);/.exec(source);
  if (block === null) {
    throw new Error("native-deps: could not find the LIVE_PROVIDER_SECRET_VARS_JSON marker block");
  }
  // Tolerate the trailing comma prettier keeps in the array literal.
  const jsonText = block[1].replace(/,(\s*\])/u, "$1");
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((v) => typeof v !== "string")) {
    throw new Error("native-deps: LIVE_PROVIDER_SECRET_VARS block is not a non-empty string array");
  }
  return parsed;
}

function readLiveProviderSecretVars() {
  const tried = [];
  for (const rel of LIVE_PROVIDER_SECRET_VARS_SOURCE_CANDIDATES) {
    tried.push(rel);
    let source;
    try {
      source = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    } catch {
      continue; // candidate absent (e.g. dist-only artifact has no src) — try next
    }
    return parseLiveProviderSecretVarsBlock(source);
  }
  throw new Error(
    `native-deps: could not read the live-provider secret allowlist from any of: ${tried.join(", ")}`,
  );
}

const LIVE_PROVIDER_SECRET_VARS = readLiveProviderSecretVars();

// A live run may have loaded the OpenRouter credentials into this process's env
// (via the external env-file workflow) before the doctor runs, so — exactly
// like the app's `spawnNativeCliProcess` boundary — scrub the live-provider
// secrets from every child env: a decode/render/probe/build child never needs
// OpenRouter creds.
function scrubLiveProviderSecretsFromEnv(env) {
  const scrubbed = { ...env };
  for (const key of LIVE_PROVIDER_SECRET_VARS) {
    delete scrubbed[key];
  }
  return scrubbed;
}
const NATIVE_CHILD_ENV = scrubLiveProviderSecretsFromEnv(process.env);

// The kaifuu/utsushi CLI binaries the localize + render pipeline drive. Bin
// names are the crate names (default cargo bin target).
// `compatMarker` is a token that MUST appear in the binary's current `--help`
// output. A stale/prebuilt bin that still executes but no longer matches the
// current CLI surface will lack the marker and fail the doctor handshake.
export const RUST_BINS = [
  {
    name: "kaifuu-cli",
    envVar: "ITOTORI_KAIFUU_BIN",
    role: "decode / patch driver",
    compatMarker: "--whole-seen",
  },
  {
    name: "utsushi-cli",
    envVar: "ITOTORI_UTSUSHI_BIN",
    role: "render / conformance driver",
    compatMarker: "render-validate",
  },
];

// Chromium-family executables to look for on PATH, mirroring the Rust
// UTSUSHI_BROWSER_BIN PATH fallback (crates/utsushi-fixture/tests).
const CHROMIUM_PATH_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "chrome",
];

// Which deps each install profile requires. A headless localize run needs the
// core three; render / e2e additionally needs Chromium.
export const PROFILES = {
  core: ["node", "rust", "postgres"],
  render: ["node", "rust", "postgres", "chromium"],
  full: ["node", "rust", "postgres", "chromium"],
};

// ---------------------------------------------------------------------------
// Pure resolution logic (probe-injected so it is unit-testable without touching
// the real filesystem / network / child processes).
// ---------------------------------------------------------------------------

// Parse the pinned Node version from `.node-version` (e.g. "24.14.0\n").
export function parsePinnedNodeVersion(text) {
  const trimmed = String(text).trim();
  if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
    throw new Error(`.node-version is not a bare semver: ${JSON.stringify(trimmed)}`);
  }
  return trimmed;
}

// A running Node satisfies the pin when its MAJOR matches and it is >= the pin.
// (Toolchain policy: exact version locally, but a newer patch/minor of the same
// major is a safe superset for an installed runtime.)
export function nodeSatisfies(actualVersion, pinned) {
  const a = String(actualVersion).replace(/^v/, "").split(".").map(Number);
  const p = String(pinned).split(".").map(Number);
  if (a[0] !== p[0]) return false;
  if (a[1] !== p[1]) return a[1] > p[1];
  return a[2] >= p[2];
}

// Ordered candidate paths for a Rust CLI binary. The FIRST that exists wins.
// This is the authoritative resolution order for the installed artifact:
//   1. explicit env override        (artifact / operator pins an exact binary)
//   2. bundled libexec dir          (per-platform prebuilt bins shipped in the
//                                     artifact — the primary installed path)
//   3. CARGO_TARGET_DIR release/debug (dev shell + worktree builds)
//   4. repo target/ release/debug   (plain `cargo build` checkout)
//   5. bare name on PATH            (operator put it on PATH / `cargo install`)
export function rustBinCandidates(bin, env = {}, repoRoot = REPO_ROOT) {
  const out = [];
  const push = (p, source) => p && out.push({ path: p, source });

  push(env[bin.envVar], `env:${bin.envVar}`);
  if (env.ITOTORI_LIBEXEC_DIR) {
    push(path.join(env.ITOTORI_LIBEXEC_DIR, bin.name), "bundled:libexec");
    push(path.join(env.ITOTORI_LIBEXEC_DIR, `${bin.name}.exe`), "bundled:libexec");
  }
  const targets = [];
  if (env.CARGO_TARGET_DIR) targets.push(env.CARGO_TARGET_DIR);
  targets.push(path.join(repoRoot, "target"));
  for (const t of targets) {
    push(path.join(t, "release", bin.name), "build:release");
    push(path.join(t, "debug", bin.name), "build:debug");
  }
  push(bin.name, "path"); // resolved via PATH by the probe's `which`
  return out;
}

// Ordered candidate Chromium binaries. Reuses the two env vars the existing
// Playwright config + Rust adapters already read so the doctor and the runtime
// agree on the authoritative browser; then the Playwright download cache; then
// a chromium-family binary on PATH.
export function chromiumCandidates(env = {}, home = homedir()) {
  const out = [];
  const push = (p, source) => p && out.push({ path: p, source });
  push(env.ITOTORI_CHROMIUM_BIN, "env:ITOTORI_CHROMIUM_BIN");
  push(env.UTSUSHI_BROWSER_BIN, "env:UTSUSHI_BROWSER_BIN");
  push(env.PLAYWRIGHT_CHROMIUM_BIN, "env:PLAYWRIGHT_CHROMIUM_BIN");
  // Playwright's own pinned download (deterministic: pinned by the Playwright
  // version in pnpm-lock). Path shape: <cache>/chromium-<rev>/chrome-linux/chrome.
  const pwRoot = env.PLAYWRIGHT_BROWSERS_PATH || path.join(home, ".cache", "ms-playwright");
  push(
    { glob: [pwRoot, /^chromium(_headless_shell)?-\d+$/, "chrome-linux", "chrome"] },
    "download:playwright",
  );
  for (const name of CHROMIUM_PATH_NAMES) push(name, "path");
  return out;
}

// Decide how Postgres will be provided, given the environment + which container
// runtimes exist. Returns { mode, detail } where mode is one of:
//   explicit  — DATABASE_URL points at an operator/system Postgres
//   portable  — ITOTORI_POSTGRES_BIN_DIR holds a pinned portable Postgres
//   container — docker/podman present -> `just db-up` (docker-compose.yml)
//   none      — nothing available; provisioning must obtain one
export function postgresPlan(env = {}, has = {}) {
  if (env.DATABASE_URL) {
    let host = "127.0.0.1";
    let port = 5432;
    try {
      const u = new URL(env.DATABASE_URL);
      host = u.hostname || host;
      port = Number(u.port) || port;
    } catch {
      // Leave defaults; the reachability probe will surface a bad URL.
    }
    return { mode: "explicit", detail: { host, port, url: redactUrl(env.DATABASE_URL) } };
  }
  if (env.ITOTORI_POSTGRES_BIN_DIR) {
    return { mode: "portable", detail: { binDir: env.ITOTORI_POSTGRES_BIN_DIR } };
  }
  if (has.docker || has.podman) {
    return { mode: "container", detail: { runtime: has.docker ? "docker" : "podman" } };
  }
  return { mode: "none", detail: {} };
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

// ---------------------------------------------------------------------------
// The doctor: resolve each dep AND prove it is runnable, returning a structured
// report. `probe` is injectable for tests; `defaultProbe()` does the real IO.
// ---------------------------------------------------------------------------

export function runDoctor({ env = process.env, profile = "full", probe = defaultProbe() } = {}) {
  const required = new Set(PROFILES[profile] || PROFILES.full);
  const deps = [];

  if (required.has("node")) deps.push(checkNode(env, probe));
  if (required.has("rust")) deps.push(...checkRustBins(env, probe));
  if (required.has("postgres")) deps.push(checkPostgres(env, probe));
  if (required.has("chromium")) deps.push(checkChromium(env, probe));

  const ok = deps.every((d) => d.status === "ok");
  return { ok, profile, deps };
}

function result(id, status, message, fix) {
  return fix ? { id, status, message, fix } : { id, status, message };
}

function checkNode(env, probe) {
  let pinned;
  try {
    pinned = parsePinnedNodeVersion(probe.readNodeVersion());
  } catch (err) {
    return result("node", "fail", `cannot read .node-version: ${err.message}`);
  }
  const actual = probe.nodeVersion();
  if (!nodeSatisfies(actual, pinned)) {
    return result(
      "node",
      "fail",
      `Node ${actual} does not satisfy the pinned major ${pinned}`,
      `Install Node ${pinned} (see .node-version); e.g. use fnm/nvm or the Node distribution index.`,
    );
  }
  return result("node", "ok", `Node ${actual} (pin ${pinned})`);
}

function checkRustBins(env, probe) {
  return RUST_BINS.map((bin) => {
    const found = firstResolvable(rustBinCandidates(bin, env), probe);
    if (!found) {
      return result(
        "rust:" + bin.name,
        "fail",
        `${bin.name} (${bin.role}) not found`,
        `Build it: \`cargo build --release -p ${bin.name}\` (or \`node scripts/native-deps.mjs provision\`), ` +
          `set ${bin.envVar}=/path/to/${bin.name}, or drop it in ITOTORI_LIBEXEC_DIR.`,
      );
    }
    const ran = probe.versionOf(found.path);
    if (!ran.ok) {
      return result(
        "rust:" + bin.name,
        "fail",
        `${bin.name} resolved at ${found.path} (${found.source}) but is not runnable: ${ran.error}`,
        `Rebuild it for this platform: \`cargo build --release -p ${bin.name}\`.`,
      );
    }
    // Stale bins often still execute (any --help/exit code) but no longer match
    // the current CLI contract. Require a surface marker in --help.
    if (bin.compatMarker) {
      const help = probe.helpOf(found.path);
      const text = help.ok ? help.text || "" : "";
      if (!help.ok || !text.includes(bin.compatMarker)) {
        return result(
          "rust:" + bin.name,
          "fail",
          `${bin.name} resolved at ${found.path} (${found.source}) but is STALE/incompatible ` +
            `(its --help is missing the current CLI surface \`${bin.compatMarker}\`)`,
          `Rebuild it: \`cargo build --release -p ${bin.name}\`.`,
        );
      }
    }
    return result("rust:" + bin.name, "ok", `${bin.name} <- ${found.path} (${found.source})`);
  });
}

function checkChromium(env, probe) {
  const found = firstResolvable(chromiumCandidates(env), probe);
  if (!found) {
    return result(
      "chromium",
      "fail",
      "no Chromium binary found",
      "Provision it: `node scripts/native-deps.mjs provision --profile render` " +
        "(runs `pnpm exec playwright install chromium`), or point UTSUSHI_BROWSER_BIN / " +
        "PLAYWRIGHT_CHROMIUM_BIN at a runnable Chromium >= 149 (matches Playwright 1.60).",
    );
  }
  const ran = probe.versionOf(found.path);
  if (!ran.ok) {
    return result(
      "chromium",
      "fail",
      `Chromium resolved at ${found.path} (${found.source}) but is not runnable: ${ran.error}`,
      "On NixOS a downloaded Chromium will not run (dynamic linking); use the nix devShell " +
        "Chromium or a system Chromium via UTSUSHI_BROWSER_BIN.",
    );
  }
  return result(
    "chromium",
    "ok",
    `Chromium <- ${found.path} (${found.source})${ran.version ? ` [${ran.version}]` : ""}`,
  );
}

function checkPostgres(env, probe) {
  const plan = postgresPlan(env, probe.commands());
  if (plan.mode === "explicit") {
    const { host, port } = plan.detail;
    if (probe.tcp(host, port)) {
      return result("postgres", "ok", `Postgres reachable at ${host}:${port} (DATABASE_URL, live)`);
    }
    return result(
      "postgres",
      "fail",
      `DATABASE_URL set (${plan.detail.url}) but ${host}:${port} is not accepting connections`,
      "Start it (`just db-up && just db-wait`, or your system Postgres) then re-run the doctor.",
    );
  }
  if (plan.mode === "portable") {
    const ctl = path.join(plan.detail.binDir, "pg_ctl");
    const server = path.join(plan.detail.binDir, "postgres");
    if (probe.exists(server) && probe.exists(ctl)) {
      return result(
        "postgres",
        "ok",
        `portable Postgres present in ${plan.detail.binDir} (start with pg_ctl; see docs)`,
      );
    }
    return result(
      "postgres",
      "fail",
      `ITOTORI_POSTGRES_BIN_DIR=${plan.detail.binDir} does not contain runnable postgres/pg_ctl`,
      "Point ITOTORI_POSTGRES_BIN_DIR at an unpacked pinned portable Postgres 18 bin dir.",
    );
  }
  if (plan.mode === "container") {
    return result(
      "postgres",
      "fail",
      `no DATABASE_URL; a ${plan.detail.runtime} container runtime is available`,
      "Provision it: `just db-up && just db-wait` (uses docker-compose.yml, postgres:18), " +
        "then export the derived DATABASE_URL (`node scripts/itotori-db-compose-env.mjs --print-database-url`).",
    );
  }
  return result(
    "postgres",
    "fail",
    "no Postgres available (no DATABASE_URL, no portable bin dir, no container runtime)",
    "Provide ONE of: a system Postgres 18 via DATABASE_URL; a container runtime (docker/podman) " +
      "for `just db-up`; or a pinned portable Postgres via ITOTORI_POSTGRES_BIN_DIR. See " +
      "docs/native-deps-provisioning.md.",
  );
}

// Resolve the first candidate that exists (env/absolute path via `exists`, bare
// name via `which`, glob spec via `glob`).
function firstResolvable(candidates, probe) {
  for (const c of candidates) {
    if (c.path && typeof c.path === "object" && c.path.glob) {
      const hit = probe.glob(c.path.glob);
      if (hit) return { path: hit, source: c.source };
      continue;
    }
    if (c.source === "path") {
      const abs = probe.which(c.path);
      if (abs) return { path: abs, source: c.source };
      continue;
    }
    if (probe.exists(c.path)) return { path: c.path, source: c.source };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Real IO probe.
// ---------------------------------------------------------------------------

export function defaultProbe() {
  return {
    readNodeVersion: () => readFileSync(path.join(REPO_ROOT, ".node-version"), "utf8"),
    nodeVersion: () => process.version,
    exists: (p) => {
      try {
        accessSync(p, constants.X_OK);
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    which: (name) => {
      const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
      for (const d of dirs) {
        const full = path.join(d, name);
        try {
          accessSync(full, constants.X_OK);
          if (statSync(full).isFile()) return full;
        } catch {
          // keep scanning
        }
      }
      return null;
    },
    glob: ([root, dirPattern, ...rest]) => {
      try {
        for (const entry of readdirSync(root)) {
          if (!dirPattern.test(entry)) continue;
          const full = path.join(root, entry, ...rest);
          if (existsSync(full)) return full;
        }
      } catch {
        // root missing
      }
      return null;
    },
    versionOf: (bin) => {
      // "Runnable" means the binary EXECUTED on this platform, not that it
      // returned 0: most of these CLIs print a usage banner to stderr and exit
      // non-zero on `--version`/`--help`/no-arg, which still proves the binary
      // loaded and ran. The real failure modes are a spawn error — ENOENT
      // (missing loader / wrong path) or ENOEXEC (wrong-arch / corrupt binary) —
      // which is exactly what a mis-provisioned or wrong-platform bin produces.
      for (const args of [["--version"], ["--help"], []]) {
        const r = spawnSync(bin, args, {
          encoding: "utf8",
          timeout: 15_000,
          env: NATIVE_CHILD_ENV,
        });
        if (r.error) {
          if (r.error.code === "ENOENT") return { ok: false, error: "not found (ENOENT)" };
          if (r.error.code === "ENOEXEC")
            return { ok: false, error: "exec format error (wrong arch?)" };
          continue; // e.g. timeout on this arg shape; try the next
        }
        const output = `${r.stdout || ""}${r.stderr || ""}`;
        if (r.status === 0 && args[0] === "--version") {
          return { ok: true, version: output.split("\n")[0].trim() };
        }
        if (output.trim().length > 0 || r.status !== null) {
          // Executed (produced output or returned an exit code) => runnable.
          return { ok: true, version: undefined };
        }
      }
      return { ok: false, error: "binary did not execute on this platform" };
    },
    helpOf: (bin) => {
      // Capture --help text for the CLI-surface compat handshake. Same
      // "executed = ok" semantics as versionOf: non-zero exit with usage
      // text is fine; only spawn failures mean we could not read help.
      const r = spawnSync(bin, ["--help"], {
        encoding: "utf8",
        timeout: 15_000,
        env: NATIVE_CHILD_ENV,
      });
      if (r.error) {
        if (r.error.code === "ENOENT") return { ok: false, error: "not found (ENOENT)", text: "" };
        if (r.error.code === "ENOEXEC")
          return { ok: false, error: "exec format error (wrong arch?)", text: "" };
        return { ok: false, error: r.error.message || "spawn failed", text: "" };
      }
      const text = `${r.stdout || ""}${r.stderr || ""}`;
      if (text.trim().length > 0 || r.status !== null) {
        return { ok: true, text };
      }
      return { ok: false, error: "binary produced no --help output", text: "" };
    },
    tcp: (host, port) => tcpReachableSync(host, port),
    commands: () => ({
      docker: hasCommandSync("docker"),
      podman: hasCommandSync("podman"),
      cargo: hasCommandSync("cargo"),
      pnpm: hasCommandSync("pnpm"),
    }),
  };
}

function hasCommandSync(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    try {
      accessSync(path.join(d, name), constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

// Synchronous TCP reachability via a tiny helper process would be heavy; use a
// short deasync-free poll on a connect with a deadline. Node has no sync socket,
// so we spawn a one-shot node that resolves the connect and prints the result.
function tcpReachableSync(host, port, timeoutMs = 1500) {
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      `const s=require("net").connect(${port},${JSON.stringify(host)});` +
        `s.setTimeout(${timeoutMs});` +
        `s.on("connect",()=>{s.destroy();process.exit(0)});` +
        `s.on("timeout",()=>{s.destroy();process.exit(1)});` +
        `s.on("error",()=>process.exit(1));`,
    ],
    { timeout: timeoutMs + 1000, env: NATIVE_CHILD_ENV },
  );
  return r.status === 0;
}

// Kept for callers that want an async check (not used by the sync doctor).
export function tcpReachable(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

// ---------------------------------------------------------------------------
// Reporting + CLI.
// ---------------------------------------------------------------------------

export function formatReport(report) {
  const mark = { ok: "OK  ", fail: "FAIL" };
  const lines = [`itotori native-deps doctor — profile: ${report.profile}`, ""];
  for (const d of report.deps) {
    lines.push(`  [${mark[d.status] || d.status}] ${d.id}: ${d.message}`);
    if (d.status !== "ok" && d.fix) lines.push(`         fix: ${d.fix}`);
  }
  lines.push("");
  lines.push(
    report.ok
      ? "All required native deps resolve and run."
      : "One or more required native deps are missing or not runnable (see fixes above).",
  );
  return lines.join("\n");
}

// The concrete, deterministic provisioning steps for the deps a fresh machine
// is missing. Returns an ordered list of { id, why, cmd, cwd } actions.
export function provisionPlan({
  env = process.env,
  profile = "full",
  probe = defaultProbe(),
} = {}) {
  const report = runDoctor({ env, profile, probe });
  const missing = new Set(report.deps.filter((d) => d.status !== "ok").map((d) => d.id));
  const cmds = probe.commands();
  const actions = [];

  if ([...missing].some((id) => id.startsWith("rust:"))) {
    actions.push({
      id: "rust",
      why: "kaifuu/utsushi CLI binaries missing",
      cmd: cmds.cargo
        ? ["cargo", "build", "--release", "-p", "kaifuu-cli", "-p", "utsushi-cli"]
        : null,
      note: cmds.cargo
        ? "builds pinned bins into target/release (rust-toolchain.toml pins the compiler)"
        : "cargo not found — install Rust (rustup, rust-toolchain.toml) or drop prebuilt bins in ITOTORI_LIBEXEC_DIR",
      cwd: REPO_ROOT,
    });
  }
  if (missing.has("chromium")) {
    actions.push({
      id: "chromium",
      why: "no runnable Chromium",
      cmd: cmds.pnpm ? ["pnpm", "exec", "playwright", "install", "chromium"] : null,
      note: cmds.pnpm
        ? "downloads the Playwright-pinned Chromium (deterministic; do NOT use on NixOS — use the nix devShell Chromium there)"
        : "pnpm not found — install deps first (`just install`) or set UTSUSHI_BROWSER_BIN to a system Chromium",
      cwd: path.join(REPO_ROOT, "apps", "runtime-web-review"),
    });
  }
  if (missing.has("postgres")) {
    const plan = postgresPlan(env, cmds);
    if (plan.mode === "container" || (plan.mode === "explicit" && (cmds.docker || cmds.podman))) {
      actions.push({
        id: "postgres",
        why: "Postgres not reachable; container runtime available",
        cmd: ["just", "db-up"],
        note: "starts postgres:18 via docker-compose.yml; then `just db-wait`",
        cwd: REPO_ROOT,
      });
    } else {
      actions.push({
        id: "postgres",
        why: "no reachable Postgres and no container runtime",
        cmd: null,
        note: "provide a system Postgres 18 via DATABASE_URL, or a pinned portable Postgres via ITOTORI_POSTGRES_BIN_DIR (see docs/native-deps-provisioning.md)",
        cwd: REPO_ROOT,
      });
    }
  }
  return actions;
}

function runProvision({ dryRun, profile }) {
  const actions = provisionPlan({ profile });
  if (actions.length === 0) {
    process.stdout.write("Nothing to provision — all required native deps already resolve.\n");
    return 0;
  }
  process.stdout.write(`native-deps provision (profile: ${profile})\n`);
  let failed = false;
  for (const a of actions) {
    process.stdout.write(`\n- ${a.id}: ${a.why}\n  ${a.note}\n`);
    if (!a.cmd) {
      process.stdout.write("  (manual step — no automatic command; see note)\n");
      failed = true;
      continue;
    }
    const printable = a.cmd.join(" ");
    process.stdout.write(`  ${dryRun ? "would run" : "running"}: ${printable}  (cwd: ${a.cwd})\n`);
    if (dryRun) continue;
    try {
      execFileSync(a.cmd[0], a.cmd.slice(1), {
        cwd: a.cwd,
        stdio: "inherit",
        env: NATIVE_CHILD_ENV,
      });
    } catch (err) {
      process.stderr.write(`  provision step "${a.id}" failed: ${err.message}\n`);
      failed = true;
    }
  }
  if (!dryRun && !failed) {
    process.stdout.write("\nRe-run `node scripts/native-deps.mjs doctor` to confirm.\n");
  }
  return failed ? 1 : 0;
}

function parseArgs(argv) {
  const args = { command: "doctor", profile: "full", json: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "doctor" || a === "provision") args.command = a;
    else if (a === "--json") args.json = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--profile") args.profile = argv[++i];
    else if (a.startsWith("--profile=")) args.profile = a.slice("--profile=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!PROFILES[args.profile]) {
    throw new Error(
      `unknown profile "${args.profile}" (expected one of ${Object.keys(PROFILES).join(", ")})`,
    );
  }
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.stderr.write(
      "usage: node scripts/native-deps.mjs [doctor|provision] [--profile core|render|full] [--json] [--dry-run]\n",
    );
    return 2;
  }
  if (args.command === "provision") {
    return runProvision({ dryRun: args.dryRun, profile: args.profile });
  }
  const report = runDoctor({ profile: args.profile });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = main(process.argv.slice(2));
}
