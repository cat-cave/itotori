import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConfigFileContents,
  parseInitFlags,
  runInitCommand,
  shellQuote,
  type InitCommandDeps,
} from "../src/init-command.js";

// DUMMY value only — never a real secret.
const DUMMY_KEY = "sk-or-dummy-init-test-1111111111";
const DUMMY_DATABASE_URL = "postgres://user:pa$$@localhost:5432/itotori";

describe("itotori init", () => {
  let tmp: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "itotori-init-test-"));
    for (const key of ["OPENROUTER_API_KEY", "OPENROUTER_ZDR_ACCOUNT_ASSERTED", "DATABASE_URL"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("non-interactive mode", () => {
    it("writes a config file with the API key + ZDR + DATABASE_URL from env", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const deps = makeDeps({
        configPath,
        logs,
        prompts: new Map(),
        files: new Map(),
        env: {
          OPENROUTER_API_KEY: DUMMY_KEY,
          DATABASE_URL: DUMMY_DATABASE_URL,
        },
      });

      await runInitCommand(
        ["init", "--zdr-asserted", "--non-interactive", "--config", configPath],
        deps,
      );

      const written = deps.writeTextCalls[0];
      expect(written).toBeDefined();
      expect(written?.path).toBe(configPath);
      expect(written?.mode).toBe(0o600);

      const contents = written?.contents ?? "";
      expect(contents).toContain(`OPENROUTER_API_KEY=${shellQuote(DUMMY_KEY)}`);
      expect(contents).toContain("OPENROUTER_ZDR_ACCOUNT_ASSERTED=1");
      expect(contents).toContain(`DATABASE_URL=${shellQuote(DUMMY_DATABASE_URL)}`);

      expect(logs.join("\n")).toContain("Config file written");
      expect(logs.join("\n")).toContain(configPath);
      expect(logs.join("\n")).not.toContain(DUMMY_DATABASE_URL);
    });

    it("never logs the API key value", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const deps = makeDeps({
        configPath,
        logs,
        prompts: new Map(),
        files: new Map(),
      });

      await runInitCommand(
        ["init", "--zdr-asserted", "--non-interactive", "--config", configPath],
        deps,
      );

      expect(logs.join("\n")).not.toContain(DUMMY_KEY);
    });

    it("warns when ZDR is not confirmed", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const deps = makeDeps({
        configPath,
        logs,
        prompts: new Map(),
        files: new Map(),
      });

      await runInitCommand(["init", "--non-interactive", "--config", configPath], deps);

      const written = deps.writeTextCalls[0]?.contents ?? "";
      expect(written).not.toContain("OPENROUTER_ZDR_ACCOUNT_ASSERTED");
      expect(logs.join("\n")).toContain("ZDR not confirmed");
    });

    it("warns when API key is missing", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const deps = makeDeps({
        configPath,
        logs,
        prompts: new Map(),
        files: new Map(),
      });

      await runInitCommand(
        ["init", "--zdr-asserted", "--non-interactive", "--config", configPath],
        deps,
      );

      expect(logs.join("\n")).toContain("No OpenRouter API key");
    });

    it("warns when DATABASE_URL is missing", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const deps = makeDeps({
        configPath,
        logs,
        prompts: new Map(),
        files: new Map(),
        env: { OPENROUTER_API_KEY: DUMMY_KEY },
      });

      await runInitCommand(
        ["init", "--zdr-asserted", "--non-interactive", "--config", configPath],
        deps,
      );

      expect(logs.join("\n")).toContain("No DATABASE_URL");
    });

    it("reads API key from env", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const deps = makeDeps({
        configPath,
        logs,
        prompts: new Map(),
        files: new Map(),
        env: { OPENROUTER_API_KEY: DUMMY_KEY, OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      });

      await runInitCommand(["init", "--non-interactive", "--config", configPath], deps);

      const contents = deps.writeTextCalls[0]?.contents ?? "";
      expect(contents).toContain(`OPENROUTER_API_KEY=${shellQuote(DUMMY_KEY)}`);
      expect(contents).toContain("OPENROUTER_ZDR_ACCOUNT_ASSERTED=1");
    });

    it("overwrites an existing config file in non-interactive mode", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const deps = makeDeps({
        configPath,
        logs,
        prompts: new Map(),
        files: new Map(),
        existingPaths: new Set([configPath]),
        env: { OPENROUTER_API_KEY: DUMMY_KEY },
      });

      await runInitCommand(
        ["init", "--zdr-asserted", "--non-interactive", "--config", configPath],
        deps,
      );

      expect(deps.writeTextCalls).toHaveLength(1);
      expect(logs.join("\n")).toContain("Config file written");
    });
  });

  describe("interactive mode", () => {
    it("uses env for secrets and prompts for ZDR", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const prompts = new Map<string, string>([
        ["Confirm your OpenRouter account is configured ZDR-only", "yes"],
      ]);
      const deps = makeDeps({
        configPath,
        logs,
        prompts,
        files: new Map(),
        env: { OPENROUTER_API_KEY: DUMMY_KEY, DATABASE_URL: DUMMY_DATABASE_URL },
      });

      await runInitCommand(["init", "--config", configPath], deps);

      const contents = deps.writeTextCalls[0]?.contents ?? "";
      expect(contents).toContain(`OPENROUTER_API_KEY=${shellQuote(DUMMY_KEY)}`);
      expect(contents).toContain("OPENROUTER_ZDR_ACCOUNT_ASSERTED=1");
      expect(contents).toContain(`DATABASE_URL=${shellQuote(DUMMY_DATABASE_URL)}`);
      expect(logs.join("\n")).not.toContain(DUMMY_DATABASE_URL);
    });

    it("does not prompt for secret values when env is missing", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const prompts = new Map<string, string>([
        ["Confirm your OpenRouter account is configured ZDR-only", "yes"],
      ]);
      const deps = makeDeps({
        configPath,
        logs,
        prompts,
        files: new Map(),
      });

      await runInitCommand(["init", "--config", configPath], deps);

      const contents = deps.writeTextCalls[0]?.contents ?? "";
      expect(contents).not.toContain("OPENROUTER_API_KEY=");
      expect(contents).not.toContain("DATABASE_URL=");
      expect(logs.join("\n")).toContain("No OpenRouter API key");
      expect(logs.join("\n")).toContain("DATABASE_URL is not accepted in prompts");
    });

    it("refuses to overwrite existing config when user says no", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const prompts = new Map<string, string>([
        ["Confirm your OpenRouter account is configured ZDR-only", "yes"],
        ["Overwrite", "no"],
      ]);
      const deps = makeDeps({
        configPath,
        logs,
        prompts,
        files: new Map(),
        existingPaths: new Set([configPath]),
      });

      await runInitCommand(["init", "--config", configPath], deps);

      expect(deps.writeTextCalls).toHaveLength(0);
      expect(logs.join("\n")).toContain("not overwritten");
    });

    it("does not confirm ZDR when user answers no", async () => {
      const configPath = join(tmp, "config.env");
      const logs: string[] = [];
      const prompts = new Map<string, string>([
        ["Confirm your OpenRouter account is configured ZDR-only", "no"],
      ]);
      const deps = makeDeps({
        configPath,
        logs,
        prompts,
        files: new Map(),
      });

      await runInitCommand(["init", "--config", configPath], deps);

      const contents = deps.writeTextCalls[0]?.contents ?? "";
      expect(contents).not.toContain("OPENROUTER_ZDR_ACCOUNT_ASSERTED");
      expect(logs.join("\n")).toContain("ZDR not confirmed");
    });
  });

  describe("buildConfigFileContents", () => {
    it("writes all three vars when provided", () => {
      const contents = buildConfigFileContents({
        apiKey: "sk-test",
        zdrConfirmed: true,
        databaseUrl: "postgres://user:pa$$@localhost/db",
      });
      expect(contents).toContain("OPENROUTER_API_KEY='sk-test'");
      expect(contents).toContain("OPENROUTER_ZDR_ACCOUNT_ASSERTED=1");
      expect(contents).toContain("DATABASE_URL='postgres://user:pa$$@localhost/db'");
    });

    it("omits vars that are not set", () => {
      const contents = buildConfigFileContents({
        apiKey: undefined,
        zdrConfirmed: false,
        databaseUrl: undefined,
      });
      expect(contents).not.toContain("OPENROUTER_API_KEY=");
      expect(contents).not.toContain("OPENROUTER_ZDR_ACCOUNT_ASSERTED=");
      expect(contents).not.toContain("DATABASE_URL=");
    });
  });

  describe("parseInitFlags", () => {
    it("parses all flags", () => {
      const flags = parseInitFlags([
        "init",
        "--zdr-asserted",
        "--config",
        "/custom/path.env",
        "--non-interactive",
      ]);
      expect(flags.zdrAsserted).toBe(true);
      expect(flags.configPath).toBe("/custom/path.env");
      expect(flags.nonInteractive).toBe(true);
    });

    it("rejects removed secret-bearing flags without echoing values", () => {
      expect(() => parseInitFlags(["init", "--api-key", DUMMY_KEY])).toThrow(
        /no longer accepts --api-key/u,
      );
      expect(() => parseInitFlags(["init", "--database-url", DUMMY_DATABASE_URL])).toThrow(
        /no longer accepts --database-url/u,
      );
      try {
        parseInitFlags(["init", "--database-url", DUMMY_DATABASE_URL]);
      } catch (error) {
        expect(String(error)).not.toContain(DUMMY_DATABASE_URL);
      }
    });

    it("defaults configPath to the standard location", () => {
      const flags = parseInitFlags(["init"]);
      expect(flags.configPath).toContain(".config");
      expect(flags.configPath).toContain("itotori");
      expect(flags.configPath).toContain("config.env");
    });

    it("defaults to interactive mode without ZDR", () => {
      const flags = parseInitFlags(["init"]);
      expect(flags.nonInteractive).toBe(false);
      expect(flags.zdrAsserted).toBe(false);
    });
  });

  describe("file permissions (real fs)", () => {
    it("writes the config file with mode 0600 on real filesystem", async () => {
      const configPath = join(tmp, "subdir", "config.env");
      await runInitCommand(
        ["init", "--zdr-asserted", "--non-interactive", "--config", configPath],
        realDeps({ OPENROUTER_API_KEY: DUMMY_KEY }),
      );

      const stat = statSync(configPath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);

      const contents = readFileSync(configPath, "utf8");
      expect(contents).toContain(`OPENROUTER_API_KEY=${shellQuote(DUMMY_KEY)}`);
    });
  });
});

type MockDeps = InitCommandDeps & {
  writeTextCalls: Array<{ path: string; contents: string; mode?: number }>;
};

function makeDeps(options: {
  configPath: string;
  logs: string[];
  prompts: Map<string, string>;
  files: Map<string, string>;
  env?: Record<string, string | undefined>;
  existingPaths?: Set<string>;
}): MockDeps {
  const writeTextCalls: MockDeps["writeTextCalls"] = [];
  const env = options.env ?? {};
  const existingPaths = options.existingPaths ?? new Set<string>();
  return {
    env,
    existsPath: (path) => existingPaths.has(path),
    writeText: (path, contents, mode) => {
      writeTextCalls.push({ path, contents, mode });
    },
    prompt: async (question) => {
      for (const [needle, answer] of options.prompts) {
        if (question.includes(needle)) {
          return answer;
        }
      }
      return "";
    },
    log: (message) => {
      options.logs.push(message);
    },
    writeTextCalls,
  };
}

function realDeps(env: Record<string, string | undefined> = process.env): InitCommandDeps {
  return {
    env,
    existsPath: (path) => existsSync(path),
    writeText: (path, contents, mode) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, { mode: mode ?? 0o600 });
      if (mode !== undefined) {
        chmodSync(path, mode);
      }
    },
    prompt: async () => "",
    log: (message) => {
      process.stdout.write(`${message}\n`);
    },
  };
}
