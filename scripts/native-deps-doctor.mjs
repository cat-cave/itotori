import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";

import { NATIVE_CHILD_ENV, PROFILES, REPO_ROOT, RUST_BINS } from "./native-deps-config.mjs";
import {
  chromiumCandidates,
  nodeSatisfies,
  parsePinnedNodeVersion,
  postgresPlan,
  rustBinCandidates,
} from "./native-deps-resolution.mjs";

// The doctor: resolve each dep AND prove it is runnable, returning a structured
// report. `probe` is injectable for tests; `defaultProbe()` does the real IO.
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
    if (bin.contractProbe) {
      const honored = contractProbeHonored(
        bin.contractProbe,
        probe.probeOf(found.path, bin.contractProbe.args),
      );
      if (!honored) {
        return result(
          "rust:" + bin.name,
          "fail",
          `${bin.name} resolved at ${found.path} (${found.source}) but does NOT honor the ` +
            `current CLI contract (${bin.contractProbe.description}) — STALE/incompatible`,
          `Rebuild it: \`cargo build --release -p ${bin.name}\`.`,
        );
      }
    }
    return result("rust:" + bin.name, "ok", `${bin.name} <- ${found.path} (${found.source})`);
  });
}

// A contract probe is HONORED iff the subcommand actually RAN (spawn ok) and its
// combined output contains every `requireAll` token and none of the `rejectAny`
// tokens. A spawn failure (missing/wrong-arch bin) is NOT honored. Exported for
// the doctor unit tests.
export function contractProbeHonored(contractProbe, probeResult) {
  if (!probeResult || !probeResult.ok) return false;
  const text = probeResult.text || "";
  const hasAll = (contractProbe.requireAll || []).every((token) => text.includes(token));
  const hasNoneRejected = !(contractProbe.rejectAny || []).some((token) => text.includes(token));
  return hasAll && hasNoneRejected;
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
      "Start it (`just dev db-up && just dev db-wait`, or your system Postgres) then re-run the doctor.",
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
      "Provision it: `just dev db-up && just dev db-wait` (uses docker-compose.yml, postgres:18), " +
        "then use the derived DATABASE_URL (`node scripts/itotori-db-lifecycle.mjs require-database-url`).",
    );
  }
  return result(
    "postgres",
    "fail",
    "no Postgres available (no DATABASE_URL, no portable bin dir, no container runtime)",
    "Provide ONE of: a system Postgres 18 via DATABASE_URL; a container runtime (docker/podman) " +
      "for `just dev db-up`; or a pinned portable Postgres via ITOTORI_POSTGRES_BIN_DIR. See " +
      "docs/native-deps-provisioning.md.",
  );
}

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

// Real IO probe.
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
    versionOf: (bin) => versionOf(bin),
    probeOf: (bin, args) => probeOf(bin, args),
    tcp: (host, port) => tcpReachableSync(host, port),
    commands: () => ({
      docker: hasCommandSync("docker"),
      podman: hasCommandSync("podman"),
      cargo: hasCommandSync("cargo"),
      pnpm: hasCommandSync("pnpm"),
    }),
  };
}

function versionOf(bin) {
  for (const args of [["--version"], ["--help"], []]) {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 15_000, env: NATIVE_CHILD_ENV });
    if (r.error) {
      if (r.error.code === "ENOENT") return { ok: false, error: "not found (ENOENT)" };
      if (r.error.code === "ENOEXEC")
        return { ok: false, error: "exec format error (wrong arch?)" };
      continue;
    }
    const output = `${r.stdout || ""}${r.stderr || ""}`;
    if (r.status === 0 && args[0] === "--version")
      return { ok: true, version: output.split("\n")[0].trim() };
    if (output.trim().length > 0 || r.status !== null) return { ok: true, version: undefined };
  }
  return { ok: false, error: "binary did not execute on this platform" };
}

function probeOf(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 15_000, env: NATIVE_CHILD_ENV });
  if (r.error) {
    if (r.error.code === "ENOENT") return { ok: false, error: "not found (ENOENT)", text: "" };
    if (r.error.code === "ENOEXEC")
      return { ok: false, error: "exec format error (wrong arch?)", text: "" };
    return { ok: false, error: r.error.message || "spawn failed", text: "" };
  }
  const text = `${r.stdout || ""}${r.stderr || ""}`;
  if (text.trim().length > 0 || r.status !== null) return { ok: true, text };
  return { ok: false, error: "binary produced no probe output", text: "" };
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
