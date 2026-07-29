import { execFileSync } from "node:child_process";
import path from "node:path";

import { NATIVE_CHILD_ENV, PROFILES, REPO_ROOT } from "./native-deps-config.mjs";
import { defaultProbe, runDoctor } from "./native-deps-doctor.mjs";
import { postgresPlan } from "./native-deps-resolution.mjs";

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
        : "pnpm not found — install deps first (`just dev install`) or set UTSUSHI_BROWSER_BIN to a system Chromium",
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
        note: "starts postgres:18 via docker-compose.yml; then `just dev db-wait`",
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
  if (!dryRun && !failed)
    process.stdout.write("\nRe-run `node scripts/native-deps.mjs doctor` to confirm.\n");
  return failed ? 1 : 0;
}

function parseArgs(argv) {
  const args = { command: "doctor", profile: "full", json: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
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

export function main(argv) {
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
  if (args.command === "provision")
    return runProvision({ dryRun: args.dryRun, profile: args.profile });
  const report = runDoctor({ profile: args.profile });
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatReport(report)}\n`);
  return report.ok ? 0 : 1;
}
