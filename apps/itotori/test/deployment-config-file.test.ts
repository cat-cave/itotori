import { describe, expect, it, vi } from "vitest";
import {
  DEPLOYMENT_CONFIG_FILE_FLAG,
  DEPLOYMENT_CONFIG_SCHEMA,
  DeploymentConfigFileError,
  loadDeploymentConfigurationFile,
  parseDeploymentConfiguration,
  resolveDeploymentConfigurationPath,
  type DeploymentConfigFileErrorCode,
  type DeploymentConfigFileSource,
} from "../src/config/deployment-config-file.js";

const DUMMY_FILE_PATH = "/nonexistent/dummy/itotori-deployment.conf";
const PRIVATE_REGULAR_SOURCE: DeploymentConfigFileSource = { isRegularFile: true, mode: 0o100600 };

function completeConfiguration(): {
  readonly body: string;
  readonly entries: ReadonlyArray<[string, string]>;
} {
  const entries: Array<[string, string]> = DEPLOYMENT_CONFIG_SCHEMA.map((setting, index) => [
    setting.name,
    `documented-value-${String(index + 1).padStart(2, "0")}`,
  ]);
  return { body: entries.map(([name, value]) => `${name}=${value}`).join("\n"), entries };
}

function expectCode(action: () => unknown, code: DeploymentConfigFileErrorCode): void {
  try {
    action();
    throw new Error("expected DeploymentConfigFileError");
  } catch (error) {
    expect(error).toBeInstanceOf(DeploymentConfigFileError);
    if (!(error instanceof DeploymentConfigFileError)) throw error;
    expect(error.code).toBe(code);
  }
}

describe("deployment configuration path", () => {
  it("requires an explicit path after its CLI flag", () => {
    expect(resolveDeploymentConfigurationPath([])).toBeUndefined();
    expect(
      resolveDeploymentConfigurationPath([
        DEPLOYMENT_CONFIG_FILE_FLAG,
        "/operator/deployment.conf",
      ]),
    ).toBe("/operator/deployment.conf");
    expectCode(
      () => resolveDeploymentConfigurationPath([DEPLOYMENT_CONFIG_FILE_FLAG]),
      "flag-path-required",
    );
  });
});

describe("parseDeploymentConfiguration", () => {
  it("round-trips every documented application setting exactly", () => {
    const fixture = completeConfiguration();
    const names = DEPLOYMENT_CONFIG_SCHEMA.map((setting) => setting.name);
    expect(DEPLOYMENT_CONFIG_SCHEMA.length).toBeGreaterThanOrEqual(33);
    expect(new Set(names).size).toBe(DEPLOYMENT_CONFIG_SCHEMA.length);

    const values = parseDeploymentConfiguration(fixture.body);
    expect([...values.entries()]).toEqual(fixture.entries);
  });

  it("keeps quoted punctuation literal instead of expanding it", () => {
    const parsed = parseDeploymentConfiguration(
      'application.profile="dollar\\$ quote\\" space and \\\\ path"',
    );
    expect(parsed.get("application.profile")).toBe('dollar$ quote" space and \\ path');
  });

  it("refuses a late duplicate after more than thirty-two documented settings", () => {
    const fixture = completeConfiguration();
    expectCode(
      () => parseDeploymentConfiguration(`${fixture.body}\napplication.profile=late-duplicate`),
      "duplicate-setting",
    );
  });

  it("refuses unknown, malformed, missing, and unsupported inputs", () => {
    expectCode(() => parseDeploymentConfiguration("unknown.setting=value"), "unknown-setting");
    expectCode(() => parseDeploymentConfiguration("not-an-assignment"), "malformed-assignment");
    expectCode(
      () => parseDeploymentConfiguration("workspace.root=value"),
      "missing-required-setting",
    );
    expectCode(
      () => parseDeploymentConfiguration("application.profile=ends-with-backslash\\"),
      "unsupported-value-form",
    );
  });
});

describe("loadDeploymentConfigurationFile", () => {
  it("reads a private regular UTF-8 source only after the whole file validates", () => {
    const fixture = completeConfiguration();
    const readFile = vi.fn(() => fixture.body);
    const result = loadDeploymentConfigurationFile({
      args: [DEPLOYMENT_CONFIG_FILE_FLAG, DUMMY_FILE_PATH],
      readFile,
      inspectSource: () => PRIVATE_REGULAR_SOURCE,
    });
    expect(readFile).toHaveBeenCalledWith(DUMMY_FILE_PATH);
    expect([...result.values.entries()]).toEqual(fixture.entries);
  });

  it("rejects non-Unicode and insecure sources before returning a result", () => {
    expectCode(
      () =>
        loadDeploymentConfigurationFile({
          args: [DEPLOYMENT_CONFIG_FILE_FLAG, DUMMY_FILE_PATH],
          readFile: () => new Uint8Array([0xff]),
          inspectSource: () => PRIVATE_REGULAR_SOURCE,
        }),
      "non-unicode",
    );
    expectCode(
      () =>
        loadDeploymentConfigurationFile({
          args: [DEPLOYMENT_CONFIG_FILE_FLAG, DUMMY_FILE_PATH],
          readFile: () => completeConfiguration().body,
          inspectSource: () => ({ isRegularFile: true, mode: 0o100644 }),
        }),
      "source-permissions-insecure",
    );
  });
});
