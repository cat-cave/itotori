import { homedir } from "node:os";
import path from "node:path";

import { CHROMIUM_PATH_NAMES, REPO_ROOT } from "./native-deps-config.mjs";

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
//   container — docker/podman present -> `just dev db-up` (docker-compose.yml)
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
