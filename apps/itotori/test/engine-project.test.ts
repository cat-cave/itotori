import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  describeEngineProjectAdapter,
  EngineProjectAdapterManifestError,
  EngineProjectConfigError,
  loadEngineProjectAdapterCatalog,
  parseEngineProjectConfig,
} from "../src/engine-project/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("engine project config", () => {
  it("discovers the declared adapter schemas and exposes them for describe", () => {
    const catalog = loadEngineProjectAdapterCatalog();

    expect(catalog.manifests.map((manifest) => manifest.engine)).toEqual([
      "reallive",
      "rpg-maker",
      "siglus",
      "softpal",
    ]);
    expect(catalog.describe("reallive")).toEqual({
      engine: "reallive",
      summary: "Archive-backed engine project adapter.",
      parameters: [],
    });
  });

  it("describes one manifest together with the shared project contract", () => {
    const catalog = loadEngineProjectAdapterCatalog();
    const description = describeEngineProjectAdapter(catalog, "siglus");

    expect(description.manifest.engine).toBe("siglus");
    expect(description.manifest.parameters).toEqual([]);
    expect(description.sharedParameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "schemaVersion", type: "integer", required: true }),
        expect.objectContaining({ name: "source.root", type: "string", required: true }),
        expect.objectContaining({ name: "identity.id", type: "string", required: true }),
        expect.objectContaining({ name: "identity.version", type: "string", required: true }),
        expect.objectContaining({ name: "identity.sourceLocale", type: "string", required: true }),
        expect.objectContaining({
          name: "identity.sourceProfileId",
          type: "string",
          required: true,
        }),
        expect.objectContaining({ name: "adapter", type: "object", required: true }),
        expect.objectContaining({ name: "extract.output", type: "string", required: true }),
        expect.objectContaining({ name: "extract.scope", type: "object", required: true }),
        expect.objectContaining({ name: "structure.output", type: "string", required: true }),
      ]),
    );
  });

  it("reports an unknown described engine with the engine and key", () => {
    const catalog = loadEngineProjectAdapterCatalog();

    expectConfigError(
      () => describeEngineProjectAdapter(catalog, "unknown"),
      "unknown-engine",
      "unknown",
      "engine",
    );
  });

  it("uses every shared scope vocabulary item for every declared engine", () => {
    const catalog = loadEngineProjectAdapterCatalog();
    const scopes = [
      { kind: "all" },
      { kind: "unit-set", unitIds: ["4", "9"] },
      { kind: "unit-range", start: 3, endExclusive: 8 },
    ];

    for (const engine of ["reallive", "siglus", "softpal", "rpg-maker"]) {
      for (const scope of scopes) {
        expect(
          parseEngineProjectConfig(projectDocument(engine, scope), catalog).extract.scope,
        ).toEqual(scope);
      }
    }
  });

  it("identifies a missing required key with the selected engine", () => {
    const catalog = loadEngineProjectAdapterCatalog();
    const document = projectDocument("siglus", { kind: "all" });
    const identity = document.identity;
    delete identity.sourceLocale;

    expectConfigError(
      () => parseEngineProjectConfig(document, catalog),
      "missing-required-key",
      "siglus",
      "identity.sourceLocale",
    );
  });

  it("identifies an unknown key with the selected engine", () => {
    const catalog = loadEngineProjectAdapterCatalog();
    const document = projectDocument("softpal", { kind: "all" });
    document.extract.unrecognized = true;

    expectConfigError(
      () => parseEngineProjectConfig(document, catalog),
      "unknown-key",
      "softpal",
      "extract.unrecognized",
    );
  });

  it("rejects an empty shared path with the selected engine and key", () => {
    const catalog = loadEngineProjectAdapterCatalog();
    const document = projectDocument("reallive", { kind: "all" });
    document.source = { root: "" };

    expectConfigError(
      () => parseEngineProjectConfig(document, catalog),
      "invalid-value",
      "reallive",
      "source.root",
    );
  });

  it("rejects a non-shared scope vocabulary item for every engine", () => {
    const catalog = loadEngineProjectAdapterCatalog();

    for (const engine of ["reallive", "siglus", "softpal", "rpg-maker"]) {
      expectConfigError(
        () =>
          parseEngineProjectConfig(projectDocument(engine, { kind: "engine-specific" }), catalog),
        "invalid-value",
        engine,
        "extract.scope.kind",
      );
    }
  });

  it("makes an adapter and its declared string parameter available without shared registration", () => {
    const directory = mkdtempSync(join(tmpdir(), "itotori-engine-project-adapters-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, "hypothetical.json"),
      JSON.stringify({
        engine: "hypothetical",
        summary: "A declarative test adapter.",
        parameters: [
          {
            name: "format",
            type: "string",
            required: true,
            description: "A source-format label.",
            formatProperty: "Header field that identifies the source container format.",
          },
          {
            name: "revision",
            type: "integer",
            required: false,
            description: "An optional source-format revision.",
            formatProperty: "Revision word encoded in the source container header.",
          },
          {
            name: "usesExtendedRecords",
            type: "boolean",
            required: false,
            description: "Whether the source format uses extended records.",
            formatProperty: "Format bit controlling the record layout.",
          },
        ],
      }),
    );

    const catalog = loadEngineProjectAdapterCatalog({ directory });
    const document = projectDocument("hypothetical", { kind: "all" });
    document.adapter = {
      format: "neutral-format",
      revision: 3,
      usesExtendedRecords: true,
    };
    const config = parseEngineProjectConfig(document, catalog);

    expect(catalog.describe("hypothetical")?.summary).toBe("A declarative test adapter.");
    expect(config.engine).toBe("hypothetical");
    expect(config.adapter).toEqual({
      format: "neutral-format",
      revision: 3,
      usesExtendedRecords: true,
    });
  });

  it("reports missing and unknown declared adapter parameters with an engine and key", () => {
    const directory = mkdtempSync(join(tmpdir(), "itotori-engine-project-adapters-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, "hypothetical.json"),
      JSON.stringify({
        engine: "hypothetical",
        summary: "A declarative test adapter.",
        parameters: [
          {
            name: "format",
            type: "string",
            required: true,
            description: "A source-format label.",
            formatProperty: "Header field that identifies the source container format.",
          },
        ],
      }),
    );
    const catalog = loadEngineProjectAdapterCatalog({ directory });
    const missingParameter = projectDocument("hypothetical", { kind: "all" });
    const unknownParameter = projectDocument("hypothetical", { kind: "all" });
    const invalidParameter = projectDocument("hypothetical", { kind: "all" });
    unknownParameter.adapter = { format: "neutral-format", unrecognized: true };
    invalidParameter.adapter = { format: 7 };

    expectConfigError(
      () => parseEngineProjectConfig(missingParameter, catalog),
      "missing-required-key",
      "hypothetical",
      "adapter.format",
    );
    expectConfigError(
      () => parseEngineProjectConfig(unknownParameter, catalog),
      "unknown-key",
      "hypothetical",
      "adapter.unrecognized",
    );
    expectConfigError(
      () => parseEngineProjectConfig(invalidParameter, catalog),
      "invalid-value",
      "hypothetical",
      "adapter.format",
    );
  });

  it("requires every future adapter key to identify its source-format property", () => {
    const directory = mkdtempSync(join(tmpdir(), "itotori-engine-project-adapters-"));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, "hypothetical.json"),
      JSON.stringify({
        engine: "hypothetical",
        summary: "A declaration missing required format evidence.",
        parameters: [
          {
            name: "format",
            type: "string",
            required: true,
            description: "A source-format label.",
          },
        ],
      }),
    );

    try {
      loadEngineProjectAdapterCatalog({ directory });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EngineProjectAdapterManifestError);
      if (error instanceof EngineProjectAdapterManifestError) {
        expect(error.code).toBe("invalid-manifest");
        expect(error.key).toBe("parameters.0.formatProperty");
        expect(error.message).toContain("formatProperty");
        return;
      }
    }
    throw new Error("Expected a manifest error for a parameter without formatProperty.");
  });
});

function projectDocument(
  engine: string,
  scope: Record<string, unknown>,
): {
  identity: Record<string, unknown>;
  adapter: Record<string, unknown>;
  extract: Record<string, unknown>;
  [key: string]: unknown;
} {
  return {
    schemaVersion: 1,
    engine,
    adapter: {},
    source: { root: "/fixture/source" },
    identity: {
      id: "fixture-id",
      version: "1.0",
      sourceLocale: "ja-JP",
      sourceProfileId: "source-profile",
    },
    extract: { output: "/fixture/extract.json", scope },
    structure: { output: "/fixture/structure.json" },
  };
}

function expectConfigError(
  action: () => unknown,
  code: EngineProjectConfigError["code"],
  engine: string,
  key: string,
): void {
  try {
    action();
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
