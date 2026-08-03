import { describe, expect, it } from "vitest";
import {
  RequiredDeploymentInputError,
  runInitCommand,
  type InitCommandDeps,
} from "../src/init-command.js";

function managedHostDependencies(writtenPaths: string[]): InitCommandDeps {
  return {
    env: {},
    existsPath: () => false,
    writeText: (path) => {
      writtenPaths.push(path);
    },
    prompt: async () => "",
    log: () => {},
    preflightHostLifecycle: () => {},
    initializeHostLifecycle: () => {
      throw new Error("initializeHostLifecycle must not run without DATABASE_URL");
    },
    currentReleasePayloadPath: () => "/installed/itotori",
    currentReleaseVersion: () => "test-release",
  };
}

describe("runInitCommand managed host readiness", () => {
  it("fails loudly and typed when DATABASE_URL is absent before any config write", async () => {
    const writtenPaths: string[] = [];
    let failure: unknown;
    try {
      await runInitCommand(
        ["--non-interactive", "--state-root", "/managed-host-state"],
        managedHostDependencies(writtenPaths),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RequiredDeploymentInputError);
    if (!(failure instanceof RequiredDeploymentInputError)) throw failure;
    expect(failure.code).toBe("missing-required-deployment-input");
    expect(failure.inputName).toBe("DATABASE_URL");
    expect(failure.message).toContain("DATABASE_URL");
    expect(writtenPaths).toEqual([]);
  });
});
