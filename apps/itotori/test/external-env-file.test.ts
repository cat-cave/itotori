import { describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_ENV_FILE_ALLOWLIST,
  ExternalEnvFileError,
  loadExternalEnvFile,
  parseAllowlistedEnvFile,
  resolveExternalEnvFilePath,
  type ExternalEnvFileErrorCode,
  type ExternalEnvFileSource,
} from "../src/env/external-env-file.js";

// Dummy value only — never a live credential.
const DUMMY_KEY = "sk-or-dummy-do-not-use-0000000000";
const DUMMY_FILE_PATH = "/nonexistent/dummy/itotori-openrouter.env";
const PRIVATE_REGULAR_SOURCE: ExternalEnvFileSource = { isRegularFile: true, mode: 0o100600 };

function fileFixture(body: string | Uint8Array): (path: string) => string | Uint8Array {
  return vi.fn(() => body);
}

function loadFixture(
  body: string | Uint8Array,
  env: Record<string, string | undefined> = {},
  args: readonly string[] = ["--env-file", DUMMY_FILE_PATH],
) {
  return loadExternalEnvFile({
    args,
    env,
    readFile: fileFixture(body),
    inspectSource: () => PRIVATE_REGULAR_SOURCE,
  });
}

function expectCode(action: () => unknown, code: ExternalEnvFileErrorCode): void {
  try {
    action();
    throw new Error("expected ExternalEnvFileError");
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalEnvFileError);
    if (!(error instanceof ExternalEnvFileError)) throw error;
    expect(error.code).toBe(code);
  }
}

describe("resolveExternalEnvFilePath", () => {
  it("prefers the --env-file flag over ITOTORI_LOCAL_ENV_FILE", () => {
    const path = resolveExternalEnvFilePath(["--env-file", "/from/flag.env"], {
      ITOTORI_LOCAL_ENV_FILE: "/from/envvar.env",
    });
    expect(path).toBe("/from/flag.env");
  });

  it("falls back to ITOTORI_LOCAL_ENV_FILE when the flag is absent", () => {
    expect(resolveExternalEnvFilePath([], { ITOTORI_LOCAL_ENV_FILE: "/from/envvar.env" })).toBe(
      "/from/envvar.env",
    );
  });

  it("fails loudly and typed when --env-file has no path argument", () => {
    expectCode(() => resolveExternalEnvFilePath(["--env-file"], {}), "flag-path-required");
    expectCode(
      () => resolveExternalEnvFilePath(["--env-file", "--other"], {}),
      "flag-path-required",
    );
  });
});

describe("parseAllowlistedEnvFile", () => {
  it("round-trips supported credential punctuation without shell expansion", () => {
    const expected = `dollar$ quote" space and \\ path`;
    const parsed = parseAllowlistedEnvFile(
      `OPENROUTER_API_KEY="dollar\\$ quote\\\" space and \\\\ path"`,
    );
    expect(parsed.get("OPENROUTER_API_KEY")).toBe(expected);
  });

  it("rejects unknown, malformed, duplicate, and unsupported trailing forms", () => {
    expectCode(
      () => parseAllowlistedEnvFile("OPENROUTER_API_KEY=first\nUNKNOWN_DEPLOYMENT_SETTING=second"),
      "unknown-setting",
    );
    expectCode(() => parseAllowlistedEnvFile("not-an-assignment"), "malformed-assignment");
    expectCode(
      () => parseAllowlistedEnvFile("OPENROUTER_API_KEY=first\nOPENROUTER_API_KEY=second"),
      "duplicate-setting",
    );
    expectCode(
      () => parseAllowlistedEnvFile("OPENROUTER_API_KEY=ends-with-backslash\\"),
      "unsupported-value-form",
    );
  });

  it("uses only the reviewed live-provider names", () => {
    expect(EXTERNAL_ENV_FILE_ALLOWLIST).toContain("OPENROUTER_API_KEY");
    expect(EXTERNAL_ENV_FILE_ALLOWLIST).toContain("OPENROUTER_ZDR_DOWNGRADE");
    expect(EXTERNAL_ENV_FILE_ALLOWLIST).not.toContain("ITOTORI_FIELD_CIPHER_KEY");
    expect(EXTERNAL_ENV_FILE_ALLOWLIST).not.toContain("UNKNOWN_DEPLOYMENT_SETTING");
  });
});

describe("loadExternalEnvFile — strict transactional startup boundary", () => {
  it("applies only a fully valid file and reports names rather than secret values", () => {
    const env: Record<string, string | undefined> = {};
    const result = loadFixture(`OPENROUTER_API_KEY=${DUMMY_KEY}`, env);
    expect(env.OPENROUTER_API_KEY).toBe(DUMMY_KEY);
    expect(result.appliedKeys).toEqual(["OPENROUTER_API_KEY"]);
    expect(JSON.stringify(result)).not.toContain(DUMMY_KEY);
  });

  it("does not mutate the environment when a late unknown or duplicate setting is refused", () => {
    const unknownEnv: Record<string, string | undefined> = {};
    expectCode(
      () =>
        loadFixture(`OPENROUTER_API_KEY=${DUMMY_KEY}\nUNKNOWN_DEPLOYMENT_SETTING=bad`, unknownEnv),
      "unknown-setting",
    );
    expect(unknownEnv).toEqual({});

    const duplicateEnv: Record<string, string | undefined> = {};
    const manySettings = Array.from({ length: 40 }, (_, index) =>
      index === 39
        ? `OPENROUTER_API_KEY=${DUMMY_KEY}`
        : `# documented capacity probe ${String(index)}`,
    ).join("\n");
    expectCode(
      () => loadFixture(`${manySettings}\nOPENROUTER_API_KEY=late`, duplicateEnv),
      "duplicate-setting",
    );
    expect(duplicateEnv).toEqual({});
  });

  it("does not overwrite an already-exported setting", () => {
    const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: "already-exported" };
    const result = loadFixture(`OPENROUTER_API_KEY=${DUMMY_KEY}`, env);
    expect(env.OPENROUTER_API_KEY).toBe("already-exported");
    expect(result.appliedKeys).toEqual([]);
    expect(result.skippedAlreadySetKeys).toEqual(["OPENROUTER_API_KEY"]);
  });

  it("recognizes the init-generated DATABASE_URL line without applying it", () => {
    const env: Record<string, string | undefined> = {};
    const result = loadFixture(
      "DATABASE_URL=postgres://operator:credential@localhost/itotori",
      env,
    );
    expect(env.DATABASE_URL).toBeUndefined();
    expect(result.appliedKeys).toEqual([]);
    expect(result.skippedAlreadySetKeys).toEqual([]);
  });

  it("refuses non-Unicode values and insecure/non-regular sources before startup", () => {
    expectCode(() => loadFixture(new Uint8Array([0xff])), "non-unicode");
    expectCode(
      () =>
        loadExternalEnvFile({
          args: ["--env-file", DUMMY_FILE_PATH],
          env: {},
          readFile: fileFixture(`OPENROUTER_API_KEY=${DUMMY_KEY}`),
          inspectSource: () => ({ isRegularFile: true, mode: 0o100644 }),
        }),
      "source-permissions-insecure",
    );
    expectCode(
      () =>
        loadExternalEnvFile({
          args: ["--env-file", DUMMY_FILE_PATH],
          env: {},
          readFile: fileFixture(`OPENROUTER_API_KEY=${DUMMY_KEY}`),
          inspectSource: () => ({ isRegularFile: false, mode: 0o100600 }),
        }),
      "source-not-regular-file",
    );
  });

  it("is a no-op only when no file was requested", () => {
    const env: Record<string, string | undefined> = {};
    const result = loadExternalEnvFile({ args: [], env });
    expect(result).toEqual({ path: undefined, appliedKeys: [], skippedAlreadySetKeys: [] });
  });
});
