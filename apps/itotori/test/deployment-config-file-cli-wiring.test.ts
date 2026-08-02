import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand } from "../src/cli-handlers.js";
import {
  assertDeploymentStartupContext,
  DEPLOYMENT_CONFIG_FILE_FLAG,
  DEPLOYMENT_CONFIG_SCHEMA,
  DeploymentConfigFileError,
} from "../src/config/deployment-config-file.js";

function completeConfiguration(lastValue = "must-not-be-printed"): string {
  return DEPLOYMENT_CONFIG_SCHEMA.map((setting, index) => {
    const value =
      index === DEPLOYMENT_CONFIG_SCHEMA.length - 1 ? lastValue : `value-${String(index)}`;
    return `${setting.name}=${value}`;
  }).join("\n");
}

function noopDependencies() {
  return {
    io: { readJson: vi.fn(), writeJson: vi.fn(), writeText: vi.fn() },
    migrateDatabase: vi.fn(async () => {}),
    resetDatabase: vi.fn(async () => {}),
    withServices: vi.fn(async () => {
      throw new Error("withServices should not be called by db-migrate");
    }),
  };
}

describe("runItotoriCliCommand — deployment configuration wiring", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates all documented settings before db-migrate and does not print values", async () => {
    const directory = mkdtempSync(join(tmpdir(), "itotori-deployment-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "deployment.conf");
    const privateValue = "must-not-be-printed";
    writeFileSync(path, completeConfiguration(privateValue), { mode: 0o600 });
    chmodSync(path, 0o600);
    const writes: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    const dependencies = noopDependencies();
    await runItotoriCliCommand(["db-migrate", DEPLOYMENT_CONFIG_FILE_FLAG, path], dependencies);

    expect(dependencies.migrateDatabase).toHaveBeenCalledOnce();
    const startup = dependencies.migrateDatabase.mock.calls[0]?.[0];
    expect(startup?.settings.get("application.profile")).toBe("value-0");
    expect(startup?.settings.size).toBe(DEPLOYMENT_CONFIG_SCHEMA.length);
    if (startup !== undefined) expect(() => assertDeploymentStartupContext(startup)).not.toThrow();
    expect(writes.join("")).toContain(`validated ${String(DEPLOYMENT_CONFIG_SCHEMA.length)}`);
    expect(writes.join("")).toContain(path);
    expect(writes.join("")).not.toContain(privateValue);
    stderr.mockRestore();
  });

  it("refuses unknown configuration before db-migrate becomes ready", async () => {
    const directory = mkdtempSync(join(tmpdir(), "itotori-deployment-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "deployment.conf");
    writeFileSync(path, `${completeConfiguration()}\nunknown.setting=untrusted`, { mode: 0o600 });
    chmodSync(path, 0o600);

    const dependencies = noopDependencies();
    let failure: unknown;
    try {
      await runItotoriCliCommand(["db-migrate", DEPLOYMENT_CONFIG_FILE_FLAG, path], dependencies);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeploymentConfigFileError);
    if (!(failure instanceof DeploymentConfigFileError)) throw failure;
    expect(failure.code).toBe("unknown-setting");
    expect(String(failure.message)).not.toContain("untrusted");
    expect(dependencies.migrateDatabase).not.toHaveBeenCalled();
  });

  it("prints --version after validating a supplied deployment configuration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "itotori-deployment-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "deployment.conf");
    writeFileSync(path, completeConfiguration(), { mode: 0o600 });
    chmodSync(path, 0o600);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    await runItotoriCliCommand(
      ["--version", DEPLOYMENT_CONFIG_FILE_FLAG, path],
      noopDependencies(),
    );
    expect(writes.join("")).toContain("itotori ");
    stdout.mockRestore();
  });
});
