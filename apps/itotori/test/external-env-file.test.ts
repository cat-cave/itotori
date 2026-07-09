import { describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_ENV_FILE_ALLOWLIST,
  ExternalEnvFileError,
  loadExternalEnvFile,
  parseAllowlistedEnvFile,
  resolveExternalEnvFilePath,
} from "../src/env/external-env-file.js";

// DUMMY values only — never a real secret.
const DUMMY_KEY = "sk-or-dummy-do-not-use-0000000000";
const DUMMY_FILE_PATH = "/nonexistent/dummy/itotori-openrouter.env";

function fileFixture(body: string): (path: string) => string {
  return vi.fn(() => body);
}

describe("resolveExternalEnvFilePath", () => {
  it("prefers the --env-file flag over ITOTORI_LOCAL_ENV_FILE", () => {
    const path = resolveExternalEnvFilePath(["--env-file", "/from/flag.env"], {
      ITOTORI_LOCAL_ENV_FILE: "/from/envvar.env",
    });
    expect(path).toBe("/from/flag.env");
  });

  it("falls back to ITOTORI_LOCAL_ENV_FILE when the flag is absent", () => {
    const path = resolveExternalEnvFilePath([], {
      ITOTORI_LOCAL_ENV_FILE: "/from/envvar.env",
    });
    expect(path).toBe("/from/envvar.env");
  });

  it("returns undefined when neither is supplied", () => {
    expect(resolveExternalEnvFilePath([], {})).toBeUndefined();
  });

  it("fails loud when --env-file has no path argument", () => {
    expect(() => resolveExternalEnvFilePath(["--env-file"], {})).toThrow(ExternalEnvFileError);
    expect(() => resolveExternalEnvFilePath(["--env-file", "--other"], {})).toThrow(
      ExternalEnvFileError,
    );
  });
});

describe("parseAllowlistedEnvFile", () => {
  it("parses KEY=value, export KEY=value, comments, and quotes", () => {
    const parsed = parseAllowlistedEnvFile(
      [
        "# a comment",
        "",
        `OPENROUTER_API_KEY=${DUMMY_KEY}`,
        "export OPENROUTER_ZDR_ACCOUNT_ASSERTED=1",
        `OPENROUTER_ZDR_DOWNGRADE="deepseek/deepseek-chat"`,
      ].join("\n"),
    );
    expect(parsed.get("OPENROUTER_API_KEY")).toBe(DUMMY_KEY);
    expect(parsed.get("OPENROUTER_ZDR_ACCOUNT_ASSERTED")).toBe("1");
    expect(parsed.get("OPENROUTER_ZDR_DOWNGRADE")).toBe("deepseek/deepseek-chat");
  });
});

describe("loadExternalEnvFile — allowlist", () => {
  it("loads ONLY allowlisted keys; a rogue var is ignored", () => {
    const env: Record<string, string | undefined> = {};
    const body = [
      `OPENROUTER_API_KEY=${DUMMY_KEY}`,
      "OPENROUTER_ZDR_ACCOUNT_ASSERTED=1",
      "EVIL_EXFIL=http://attacker.example",
      "AWS_SECRET_ACCESS_KEY=should-be-ignored",
      "PATH=/malicious/bin",
    ].join("\n");
    const result = loadExternalEnvFile({
      args: ["--env-file", DUMMY_FILE_PATH],
      env,
      readFile: fileFixture(body),
    });
    expect(env.OPENROUTER_API_KEY).toBe(DUMMY_KEY);
    expect(env.OPENROUTER_ZDR_ACCOUNT_ASSERTED).toBe("1");
    // Non-allowlisted keys must NEVER enter the environment.
    expect(env.EVIL_EXFIL).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBeUndefined();
    expect([...result.appliedKeys].sort()).toEqual(
      ["OPENROUTER_API_KEY", "OPENROUTER_ZDR_ACCOUNT_ASSERTED"].sort(),
    );
    // Every applied key is in the published allowlist.
    for (const key of result.appliedKeys) {
      expect(EXTERNAL_ENV_FILE_ALLOWLIST).toContain(key);
    }
  });
});

describe("loadExternalEnvFile — precedence", () => {
  it("loads a file value (via ITOTORI_LOCAL_ENV_FILE) when the var is unset", () => {
    // Exercise the env-var path (no --env-file flag).
    const target: Record<string, string | undefined> = {
      ITOTORI_LOCAL_ENV_FILE: DUMMY_FILE_PATH,
    };
    const result = loadExternalEnvFile({
      args: [],
      env: target,
      readFile: fileFixture(`OPENROUTER_API_KEY=${DUMMY_KEY}`),
    });
    expect(target.OPENROUTER_API_KEY).toBe(DUMMY_KEY);
    expect(result.appliedKeys).toContain("OPENROUTER_API_KEY");
  });

  it("does NOT overwrite an already-exported var", () => {
    const alreadyExported = "sk-or-exported-wins-1111111111";
    const env: Record<string, string | undefined> = {
      OPENROUTER_API_KEY: alreadyExported,
    };
    const result = loadExternalEnvFile({
      args: ["--env-file", DUMMY_FILE_PATH],
      env,
      readFile: fileFixture(`OPENROUTER_API_KEY=${DUMMY_KEY}`),
    });
    // Exported value wins; file value is NOT applied.
    expect(env.OPENROUTER_API_KEY).toBe(alreadyExported);
    expect(result.appliedKeys).not.toContain("OPENROUTER_API_KEY");
    expect(result.skippedAlreadySetKeys).toContain("OPENROUTER_API_KEY");
  });
});

describe("loadExternalEnvFile — missing file fails loud", () => {
  it("throws a typed ExternalEnvFileError for a specified but unreadable path", () => {
    const env: Record<string, string | undefined> = {};
    expect(() =>
      loadExternalEnvFile({
        args: ["--env-file", DUMMY_FILE_PATH],
        env,
        readFile: () => {
          throw new Error("ENOENT: no such file or directory");
        },
      }),
    ).toThrow(ExternalEnvFileError);
  });

  it("is a silent no-op when no file is specified", () => {
    const env: Record<string, string | undefined> = {};
    const result = loadExternalEnvFile({ args: [], env });
    expect(result.path).toBeUndefined();
    expect(result.appliedKeys).toEqual([]);
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });
});

describe("loadExternalEnvFile — secret hygiene", () => {
  it("never puts the secret value in the result, error, or logs", () => {
    const env: Record<string, string | undefined> = {};
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });

    const result = loadExternalEnvFile({
      args: ["--env-file", DUMMY_FILE_PATH],
      env,
      readFile: fileFixture(`OPENROUTER_API_KEY=${DUMMY_KEY}`),
    });

    // The result reports NAMES only — no value field anywhere.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(DUMMY_KEY);
    expect(serialized).toContain("OPENROUTER_API_KEY");
    // The path (safe) is present.
    expect(result.path).toBe(DUMMY_FILE_PATH);
    // No log captured the secret.
    expect(logs.join("\n")).not.toContain(DUMMY_KEY);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("keeps the secret value out of the error message on a bad file", () => {
    // A readFile that (pathologically) throws an error carrying a secret must
    // still not surface that secret — but we assert the common case: the error
    // message is built from the path + terse cause, never file contents.
    let thrown: unknown;
    try {
      loadExternalEnvFile({
        args: ["--env-file", DUMMY_FILE_PATH],
        env: {},
        readFile: () => {
          throw new Error("ENOENT");
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExternalEnvFileError);
    const message = (thrown as ExternalEnvFileError).message;
    expect(message).toContain(DUMMY_FILE_PATH);
    expect(message).not.toContain(DUMMY_KEY);
  });
});
