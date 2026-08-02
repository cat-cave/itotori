import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand } from "../src/cli-handlers.js";
import { ExternalEnvFileError } from "../src/env/external-env-file.js";

// DUMMY value only — never a real secret.
const DUMMY_KEY = "sk-or-dummy-cli-wiring-2222222222";

const ALLOWLISTED_ENV_VARS = ["OPENROUTER_API_KEY", "OPENROUTER_ZDR_DOWNGRADE"] as const;

function noopDependencies() {
  return {
    io: { readJson: vi.fn(), writeJson: vi.fn(), writeText: vi.fn() },
    // `db-migrate` only calls migrateDatabase, so nothing else is exercised.
    migrateDatabase: vi.fn(async () => {}),
    resetDatabase: vi.fn(async () => {}),
    withServices: vi.fn(async () => {
      throw new Error("withServices should not be called by db-migrate");
    }),
  };
}

describe("runItotoriCliCommand — external env-file wiring", () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "itotori-envfile-test-"));
    for (const key of ALLOWLISTED_ENV_VARS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const key of ALLOWLISTED_ENV_VARS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("loads a reviewed var from --env-file before dispatch and never leaks the value", async () => {
    const path = join(tmp, "itotori-openrouter.env");
    writeFileSync(path, `OPENROUTER_API_KEY=${DUMMY_KEY}`, { mode: 0o600 });
    chmodSync(path, 0o600);

    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const deps = noopDependencies();
    await runItotoriCliCommand(["db-migrate", "--env-file", path], deps);

    // The provider credential is now in the process env for the command.
    expect(process.env.OPENROUTER_API_KEY).toBe(DUMMY_KEY);
    // The command still ran.
    expect(deps.migrateDatabase).toHaveBeenCalledOnce();

    // The stderr summary reports NAMES + PATH but never the secret VALUE.
    const stderr = stderrWrites.join("");
    expect(stderr).not.toContain(DUMMY_KEY);
    expect(stderr).toContain("OPENROUTER_API_KEY");
    expect(stderr).toContain(path);

    stderrSpy.mockRestore();
  });

  it("refuses an unknown setting before the command becomes ready", async () => {
    const path = join(tmp, "itotori-unknown.env");
    writeFileSync(path, [`OPENROUTER_API_KEY=${DUMMY_KEY}`, "EVIL_EXFIL=bad"].join("\n"), {
      mode: 0o600,
    });
    chmodSync(path, 0o600);
    const deps = noopDependencies();
    let failure: unknown;
    try {
      await runItotoriCliCommand(["db-migrate", "--env-file", path], deps);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ExternalEnvFileError);
    if (!(failure instanceof ExternalEnvFileError)) throw failure;
    expect(failure.code).toBe("unknown-setting");
    expect(String(failure.message)).not.toContain(DUMMY_KEY);
    expect(deps.migrateDatabase).not.toHaveBeenCalled();
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("does NOT overwrite an already-exported var (exported wins)", async () => {
    const exported = "sk-or-exported-cli-3333333333";
    process.env.OPENROUTER_API_KEY = exported;
    const path = join(tmp, "itotori-openrouter.env");
    writeFileSync(path, `OPENROUTER_API_KEY=${DUMMY_KEY}`, { mode: 0o600 });
    chmodSync(path, 0o600);

    const deps = noopDependencies();
    await runItotoriCliCommand(["db-migrate", "--env-file", path], deps);

    expect(process.env.OPENROUTER_API_KEY).toBe(exported);
  });

  it("fails loud when the specified --env-file path does not exist", async () => {
    const missing = join(tmp, "does-not-exist.env");
    const deps = noopDependencies();
    await expect(
      runItotoriCliCommand(["db-migrate", "--env-file", missing], deps),
    ).rejects.toBeInstanceOf(ExternalEnvFileError);
    // The command must NOT have run — the load failed before dispatch.
    expect(deps.migrateDatabase).not.toHaveBeenCalled();
  });

  it("fails loud on a missing --env-file EVEN on the --version early-return path", async () => {
    const missing = join(tmp, "does-not-exist.env");
    const deps = noopDependencies();
    const stdoutWrites: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    await expect(
      runItotoriCliCommand(["--version", "--env-file", missing], deps),
    ).rejects.toBeInstanceOf(ExternalEnvFileError);
    // The env-file validation runs BEFORE the --version print, so the version
    // banner was never emitted.
    expect(stdoutWrites.join("")).not.toContain("itotori ");
    stdoutSpy.mockRestore();
  });

  it("prints the version normally when --version has no --env-file", async () => {
    const deps = noopDependencies();
    const stdoutWrites: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    await runItotoriCliCommand(["--version"], deps);
    expect(stdoutWrites.join("")).toContain("itotori ");
    stdoutSpy.mockRestore();
  });

  it("prints the version after validating a supplied env file", async () => {
    const path = join(tmp, "itotori-openrouter.env");
    writeFileSync(path, `OPENROUTER_API_KEY=${DUMMY_KEY}`, { mode: 0o600 });
    chmodSync(path, 0o600);
    const stdoutWrites: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    await runItotoriCliCommand(["--version", "--env-file", path], noopDependencies());
    expect(stdoutWrites.join("")).toContain("itotori ");
    stdoutSpy.mockRestore();
  });
});
