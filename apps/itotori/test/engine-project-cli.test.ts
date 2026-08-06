import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runItotoriCliCommand, type ItotoriCliDependencies } from "../src/cli-handlers.js";
import { EngineProjectConfigError } from "../src/engine-project/index.js";
import {
  EngineProjectCommandError,
  EngineProjectNativeCommandError,
  runEngineProjectCommand,
} from "../src/engine-project/command-runner.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

describe("engine-project primary CLI", () => {
  it("runs extract and structure-export with one command shape for every declared engine", async () => {
    const directory = temporaryDirectory();
    const calls: NativeCall[] = [];
    const dependencies = cliDependencies(calls);
    const engines = ["reallive", "siglus", "softpal", "rpg-maker"];

    for (const engine of engines) {
      const projectPath = writeProject(directory, engine, projectDocument(engine));
      const extractOutput = await captureStdout(() =>
        runItotoriCliCommand(["extract", "--project", projectPath], dependencies),
      );
      const structureOutput = await captureStdout(() =>
        runItotoriCliCommand(["structure-export", "--project", projectPath], dependencies),
      );

      expect(extractOutput).toContain(`"engine": "${engine}"`);
      expect(extractOutput).toContain('"command": "extract"');
      expect(structureOutput).toContain(`"engine": "${engine}"`);
      expect(structureOutput).toContain('"command": "structure-export"');
    }

    const extractCalls = calls.filter((call) => nativeTail(call.args, "extract") !== undefined);
    const structureCalls = calls.filter((call) => nativeTail(call.args, "structure") !== undefined);
    expect(extractCalls).toHaveLength(4);
    expect(structureCalls).toHaveLength(4);
    expect(extractCalls.map((call) => flags(nativeTail(call.args, "extract")!))).toEqual([
      [
        "--engine",
        "--game-root",
        "--game-id",
        "--game-version",
        "--source-profile-id",
        "--source-locale",
        "--scope",
        "--bundle-output",
      ],
      [
        "--engine",
        "--game-root",
        "--game-id",
        "--game-version",
        "--source-profile-id",
        "--source-locale",
        "--scope",
        "--bundle-output",
      ],
      [
        "--engine",
        "--game-root",
        "--game-id",
        "--game-version",
        "--source-profile-id",
        "--source-locale",
        "--scope",
        "--bundle-output",
      ],
      [
        "--engine",
        "--game-root",
        "--game-id",
        "--game-version",
        "--source-profile-id",
        "--source-locale",
        "--scope",
        "--bundle-output",
      ],
    ]);
    expect(structureCalls.map((call) => flags(nativeTail(call.args, "structure")!))).toEqual([
      ["--engine", "--game-root", "--bridge", "--output"],
      ["--engine", "--game-root", "--bridge", "--output"],
      ["--engine", "--game-root", "--bridge", "--output"],
      ["--engine", "--game-root", "--bridge", "--output"],
    ]);
  });

  it("forwards every shared extraction scope form unchanged for every declared engine", () => {
    const directory = temporaryDirectory();
    const cases: Array<{ scope: TestExtractionScope; expected: string[] }> = [
      { scope: { kind: "all" }, expected: ["--scope", "all"] },
      {
        scope: { kind: "unit-set", unitIds: ["unit-a", "unit-b"] },
        expected: ["--scope", "unit-set", "--unit-ids", "unit-a,unit-b"],
      },
      {
        scope: { kind: "unit-range", start: 2, endExclusive: 5 },
        expected: ["--scope", "unit-range", "--start", "2", "--end-exclusive", "5"],
      },
    ];

    for (const engine of ["reallive", "siglus", "softpal", "rpg-maker"]) {
      for (const { scope, expected } of cases) {
        const calls: NativeCall[] = [];
        const projectPath = writeProject(
          directory,
          `${engine}-${scope.kind}`,
          projectDocument(engine, scope),
        );
        runEngineProjectCommand("extract", ["extract", "--project", projectPath], {
          io: jsonFileStore(),
          nativeCli: recordingNativeCli(calls),
        });

        const nativeArgs = nativeTail(calls[0]!.args, "extract");
        const scopeStart = nativeArgs!.indexOf("--scope");
        expect(nativeArgs!.slice(scopeStart, scopeStart + expected.length)).toEqual(expected);
      }
    }
  });

  it("describes every declared adapter without launching a native process", async () => {
    const calls: NativeCall[] = [];
    const dependencies = cliDependencies(calls);

    for (const engine of ["reallive", "siglus", "softpal", "rpg-maker"]) {
      const output = await captureStdout(() =>
        runItotoriCliCommand(["extract", "--engine", engine, "--describe"], dependencies),
      );
      expect(output).toContain(`"engine": "${engine}"`);
      expect(output).toContain('"parameters": []');
      expect(output).toContain('"sharedParameters"');
      expect(output).toContain('"description"');
    }

    expect(calls).toEqual([]);
  });

  it("returns typed missing and unknown config errors that identify engine and key", async () => {
    const directory = temporaryDirectory();
    const missing = projectDocument("siglus");
    delete missing.identity.sourceLocale;
    const unknown = projectDocument("softpal");
    unknown.adapter.unrecognized = true;
    const dependencies = cliDependencies([]);

    await expectConfigError(
      () =>
        runItotoriCliCommand(
          ["extract", "--project", writeProject(directory, "missing", missing)],
          dependencies,
        ),
      "missing-required-key",
      "siglus",
      "identity.sourceLocale",
    );
    await expectConfigError(
      () =>
        runItotoriCliCommand(
          ["extract", "--project", writeProject(directory, "unknown", unknown)],
          dependencies,
        ),
      "unknown-key",
      "softpal",
      "adapter.unrecognized",
    );
  });

  it("does not retain raw engine-shaped flags as a compatibility path", async () => {
    const dependencies = cliDependencies([]);

    await expect(
      runItotoriCliCommand(
        ["extract", "--engine", "reallive", "--game-root", "/fixture/source"],
        dependencies,
      ),
    ).rejects.toBeInstanceOf(EngineProjectCommandError);
    await expect(
      runItotoriCliCommand(
        ["structure-export", "--engine", "siglus", "--output", "/fixture/structure.json"],
        dependencies,
      ),
    ).rejects.toBeInstanceOf(EngineProjectCommandError);
  });

  it("reports an unredacted native diagnostic after config validation succeeds", async () => {
    const directory = temporaryDirectory();
    const projectPath = writeProject(directory, "downstream", projectDocument("reallive"));
    const diagnostic = "kaifuu.reallive.archive_parse: neutral fixture malformed";
    const dependencies = cliDependencies([], { status: 23, stdout: "", stderr: diagnostic });

    try {
      await runItotoriCliCommand(["extract", "--project", projectPath], dependencies);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EngineProjectNativeCommandError);
      if (error instanceof EngineProjectNativeCommandError) {
        expect(error.engine).toBe("reallive");
        expect(error.status).toBe(23);
        expect(error.stderr).toBe(diagnostic);
        expect(error.message).toContain(diagnostic);
        return;
      }
    }
    throw new Error("Expected a typed downstream native failure.");
  });

  it("engine-project chokepoint keeps softpal diagnostics and span-redacts content only", async () => {
    const directory = temporaryDirectory();
    const projectPath = writeProject(directory, "softpal-diag", projectDocument("softpal"));
    const softpalDiagnostic =
      "kaifuu.softpal.extract.game_root_required: --game-root <PATH> required";
    const content = "PRIVATE-SOFTPAL-CONTENT-SENTINEL";
    const mixed =
      `kaifuu.softpal.decode.failed: source=${content}; ` + "offset=42 path=/synthetic/source";
    const secret = "operator-api-key-sentinel-softpal";

    const plain = cliDependencies([], {
      status: 1,
      stdout: "",
      stderr: softpalDiagnostic,
    });
    try {
      await runItotoriCliCommand(["extract", "--project", projectPath], plain);
      throw new Error("Expected softpal native failure.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EngineProjectNativeCommandError);
      if (error instanceof EngineProjectNativeCommandError) {
        expect(error.stderr).toBe(softpalDiagnostic);
        expect(error.message).toContain(softpalDiagnostic);
        expect(error.message).not.toMatch(/REDACTED_CONTENT kind=diagnostic/);
      }
    }

    const span = cliDependencies([], { status: 1, stdout: "", stderr: mixed });
    try {
      await runItotoriCliCommand(["extract", "--project", projectPath], span);
      throw new Error("Expected content-bearing native failure.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EngineProjectNativeCommandError);
      if (error instanceof EngineProjectNativeCommandError) {
        expect(error.stderr).toContain("offset=42");
        expect(error.stderr).toContain("path=/synthetic/source");
        expect(error.stderr).toContain("[REDACTED_CONTENT");
        expect(error.stderr).not.toContain(content);
      }
    }

    const secretCalls: NativeCall[] = [];
    const secretBearing: ItotoriCliDependencies = {
      ...cliDependencies(secretCalls, {
        status: 1,
        stdout: "",
        stderr: `kaifuu.auth.failed: api_key=${secret}; status=1`,
      }),
      nativeCli: {
        env: { OPENROUTER_API_KEY: secret },
        runProcess(_command, _args) {
          return {
            status: 1,
            stdout: "",
            stderr: `kaifuu.auth.failed: api_key=${secret}; status=1`,
          };
        },
      },
    };
    try {
      await runItotoriCliCommand(["extract", "--project", projectPath], secretBearing);
      throw new Error("Expected secret-bearing native failure.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EngineProjectNativeCommandError);
      if (error instanceof EngineProjectNativeCommandError) {
        expect(error.stderr).toContain("kaifuu.auth.failed");
        expect(error.stderr).toContain("status=1");
        expect(error.stderr).not.toContain(secret);
      }
    }
  });

  it("discovers a hypothetical adapter declaration with no new command flag or branch", () => {
    const directory = temporaryDirectory();
    const adapterDirectory = join(directory, "adapters");
    mkdirSync(adapterDirectory);
    writeFileSync(
      join(adapterDirectory, "hypothetical.json"),
      JSON.stringify({
        engine: "hypothetical",
        summary: "A format-declared test adapter.",
        parameters: [
          {
            name: "containerVersion",
            type: "string",
            required: true,
            description: "Container-version marker defined by the source format.",
            formatProperty: "Container header value defined by the source format.",
          },
        ],
      }),
    );
    const project = projectDocument("hypothetical");
    project.adapter.containerVersion = "neutral-v1";
    const projectPath = writeProject(directory, "hypothetical-project", project);
    const calls: NativeCall[] = [];
    const described = runEngineProjectCommand(
      "extract",
      ["extract", "--engine", "hypothetical", "--describe"],
      {
        io: jsonFileStore(),
        adapterCatalogDirectory: adapterDirectory,
        nativeCli: recordingNativeCli(calls),
      },
    );

    expect(described.kind).toBe("describe");
    if (described.kind === "describe") {
      expect(described.description.manifest.parameters).toEqual([
        {
          name: "containerVersion",
          type: "string",
          required: true,
          description: "Container-version marker defined by the source format.",
          formatProperty: "Container header value defined by the source format.",
        },
      ]);
    }
    expect(calls).toEqual([]);

    const result = runEngineProjectCommand("extract", ["extract", "--project", projectPath], {
      io: jsonFileStore(),
      adapterCatalogDirectory: adapterDirectory,
      nativeCli: recordingNativeCli(calls),
    });

    expect(result.kind).toBe("executed");
    expect(calls).toHaveLength(1);
    const nativeArgs = nativeTail(calls[0]!.args, "extract");
    expect(nativeArgs).toContain("--adapter-config");
    expect(nativeArgs?.[nativeArgs.indexOf("--adapter-config") + 1]).toBe(
      '{"containerVersion":"neutral-v1"}',
    );
  });
});

type NativeCall = {
  readonly command: string;
  readonly args: string[];
};

type NativeResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

type TestProjectDocument = {
  schemaVersion: number;
  engine: string;
  adapter: Record<string, boolean | number | string>;
  source: { root: string };
  identity: {
    id: string;
    version: string;
    sourceLocale?: string;
    sourceProfileId: string;
  };
  extract: { output: string; scope: TestExtractionScope };
  structure: { output: string };
};

type TestExtractionScope =
  | { kind: "all" }
  | { kind: "unit-set"; unitIds: string[] }
  | { kind: "unit-range"; start: number; endExclusive: number };

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "itotori-engine-project-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function projectDocument(
  engine: string,
  scope: TestExtractionScope = { kind: "all" },
): TestProjectDocument {
  return {
    schemaVersion: 1,
    engine,
    adapter: {},
    source: { root: `/fixture/${engine}/source` },
    identity: {
      id: "neutral-work",
      version: "1.0",
      sourceLocale: "ja-JP",
      sourceProfileId: "neutral-source-profile",
    },
    extract: { output: `/fixture/${engine}/bridge.json`, scope },
    structure: { output: `/fixture/${engine}/structure.json` },
  };
}

function writeProject(directory: string, name: string, document: TestProjectDocument): string {
  const path = join(directory, `${name}.json`);
  writeFileSync(path, JSON.stringify(document));
  return path;
}

function jsonFileStore() {
  return {
    readJson(path: string): unknown {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    },
    writeJson(): void {},
  };
}

function cliDependencies(calls: NativeCall[], result?: NativeResult): ItotoriCliDependencies {
  return {
    io: jsonFileStore(),
    migrateDatabase: async () => undefined,
    resetDatabase: async () => undefined,
    withServices: async () => {
      throw new Error("engine-project commands do not open services");
    },
    nativeCli: recordingNativeCli(calls, result),
  };
}

function recordingNativeCli(calls: NativeCall[], result?: NativeResult) {
  return {
    env: {},
    runProcess(command: string, args: string[]) {
      calls.push({ command, args });
      return result ?? { status: 0, stdout: "", stderr: "" };
    },
  };
}

async function captureStdout(action: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    await action();
  } finally {
    spy.mockRestore();
  }
  return writes.join("");
}

function nativeTail(args: readonly string[], verb: "extract" | "structure"): string[] | undefined {
  const index = args.indexOf(verb);
  return index === -1 ? undefined : args.slice(index);
}

function flags(args: readonly string[]): string[] {
  return args.filter((arg) => arg.startsWith("--"));
}

async function expectConfigError(
  action: () => Promise<void>,
  code: EngineProjectConfigError["code"],
  engine: string,
  key: string,
): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(EngineProjectConfigError);
    if (error instanceof EngineProjectConfigError) {
      expect(error.code).toBe(code);
      expect(error.engine).toBe(engine);
      expect(error.key).toBe(key);
      expect(error.message).toContain(`engine '${engine}'`);
      expect(error.message).toContain(`key '${key}'`);
      return;
    }
  }
  throw new Error("Expected an EngineProjectConfigError.");
}
