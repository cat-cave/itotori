import type { EngineProjectAdapterCatalog } from "./adapter-catalog.js";
import type { EngineProjectAdapterManifest } from "./adapter-manifest.js";
import { EngineProjectConfigError } from "./errors.js";

export type EngineProjectExtractionScope =
  | { readonly kind: "all" }
  | { readonly kind: "unit-set"; readonly unitIds: readonly string[] }
  | { readonly kind: "unit-range"; readonly start: number; readonly endExclusive: number };

type EngineProjectScopeKind = EngineProjectExtractionScope["kind"];

export type EngineProjectAdapterValue = boolean | number | string;

export type EngineProjectSharedParameterType = "boolean" | "integer" | "object" | "string";

export type EngineProjectSharedParameter = {
  readonly name: string;
  readonly type: EngineProjectSharedParameterType;
  readonly required: boolean;
  readonly description: string;
};

export type EngineProjectAdapterDescription = {
  readonly manifest: EngineProjectAdapterManifest;
  readonly sharedParameters: readonly EngineProjectSharedParameter[];
};

export type EngineProjectConfig = {
  readonly schemaVersion: 1;
  readonly engine: string;
  readonly adapter: Readonly<Record<string, EngineProjectAdapterValue>>;
  readonly source: { readonly root: string };
  readonly identity: {
    readonly id: string;
    readonly version: string;
    readonly sourceLocale: string;
    readonly sourceProfileId: string;
  };
  readonly extract: {
    readonly output: string;
    readonly scope: EngineProjectExtractionScope;
  };
  readonly structure: { readonly output: string };
};

const PROJECT_KEYS = [
  "schemaVersion",
  "engine",
  "adapter",
  "source",
  "identity",
  "extract",
  "structure",
];
const SOURCE_KEYS = ["root"];
const IDENTITY_KEYS = ["id", "version", "sourceLocale", "sourceProfileId"];
const EXTRACT_KEYS = ["output", "scope"];
const STRUCTURE_KEYS = ["output"];
const ALL_SCOPE_KEYS = ["kind"];
const UNIT_SET_SCOPE_KEYS = ["kind", "unitIds"];
const UNIT_RANGE_SCOPE_KEYS = ["kind", "start", "endExclusive"];
const SHARED_PARAMETERS: readonly EngineProjectSharedParameter[] = [
  {
    name: "schemaVersion",
    type: "integer",
    required: true,
    description: "Project-config schema version. The current version is 1.",
  },
  {
    name: "source.root",
    type: "string",
    required: true,
    description: "Read-only root directory containing the source material.",
  },
  {
    name: "identity.id",
    type: "string",
    required: true,
    description: "Stable identity for the source work.",
  },
  {
    name: "identity.version",
    type: "string",
    required: true,
    description: "Version of the source work.",
  },
  {
    name: "identity.sourceLocale",
    type: "string",
    required: true,
    description: "Locale of the source material.",
  },
  {
    name: "identity.sourceProfileId",
    type: "string",
    required: true,
    description: "Source-profile identifier used for provenance.",
  },
  {
    name: "adapter",
    type: "object",
    required: true,
    description: "Object containing only parameters declared by the selected adapter.",
  },
  {
    name: "extract.output",
    type: "string",
    required: true,
    description: "Output path for the extraction artifact.",
  },
  {
    name: "extract.scope",
    type: "object",
    required: true,
    description: "Shared scope object: all, unit-set, or unit-range.",
  },
  {
    name: "structure.output",
    type: "string",
    required: true,
    description: "Output path for the structure artifact.",
  },
];

/** Parses and strictly validates the engine-neutral project config document. */
export function parseEngineProjectConfig(
  value: unknown,
  catalog: EngineProjectAdapterCatalog,
): EngineProjectConfig {
  const document = expectRecord(value, undefined, "$");
  const engine = readString(document, "engine", undefined, "engine");
  assertOnlyKeys(document, PROJECT_KEYS, engine, "$");
  const manifest = readManifest(engine, catalog);

  const schemaVersion = readSchemaVersion(document, engine);
  const adapter = readAdapter(document, engine, manifest);
  const source = readSource(document, engine);
  const identity = readIdentity(document, engine);
  const extract = readExtract(document, engine);
  const structure = readStructure(document, engine);

  return { schemaVersion, engine, adapter, source, identity, extract, structure };
}

/** Returns the complete config schema needed to operate one declared adapter. */
export function describeEngineProjectAdapter(
  catalog: EngineProjectAdapterCatalog,
  engine: string,
): EngineProjectAdapterDescription {
  return {
    manifest: readManifest(engine, catalog),
    sharedParameters: SHARED_PARAMETERS,
  };
}

/** Parses a JSON document before applying the same strict project validation. */
export function parseEngineProjectConfigJson(
  text: string,
  catalog: EngineProjectAdapterCatalog,
): EngineProjectConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "could not be parsed";
    throw new EngineProjectConfigError({
      code: "invalid-json",
      engine: undefined,
      key: "$",
      message: `Project config is not valid JSON: ${reason}`,
    });
  }
  return parseEngineProjectConfig(value, catalog);
}

function readManifest(
  engine: string,
  catalog: EngineProjectAdapterCatalog,
): EngineProjectAdapterManifest {
  const manifest = catalog.find(engine);
  if (manifest !== undefined) {
    return manifest;
  }
  throw error("unknown-engine", engine, "engine", `has no declared adapter`);
}

function readSchemaVersion(document: Record<string, unknown>, engine: string): 1 {
  const value = readRequired(document, "schemaVersion", engine, "schemaVersion");
  if (value === 1) {
    return value;
  }
  throw error("invalid-value", engine, "schemaVersion", "must be 1");
}

function readAdapter(
  document: Record<string, unknown>,
  engine: string,
  manifest: EngineProjectAdapterManifest,
): EngineProjectConfig["adapter"] {
  const adapter = readObject(document, "adapter", engine, "adapter");
  const parametersByName = new Map(
    manifest.parameters.map((parameter) => [parameter.name, parameter]),
  );
  for (const name of Object.keys(adapter)) {
    if (!parametersByName.has(name)) {
      throw error("unknown-key", engine, `adapter.${name}`, "is not a declared adapter parameter");
    }
  }

  const values: Record<string, EngineProjectAdapterValue> = {};
  for (const parameter of manifest.parameters) {
    const key = `adapter.${parameter.name}`;
    if (!Object.hasOwn(adapter, parameter.name)) {
      if (parameter.required) {
        throw error("missing-required-key", engine, key, "is required");
      }
      continue;
    }
    values[parameter.name] = readAdapterValue(adapter[parameter.name], parameter, engine, key);
  }
  return values;
}

function readAdapterValue(
  value: unknown,
  parameter: EngineProjectAdapterManifest["parameters"][number],
  engine: string,
  key: string,
): EngineProjectAdapterValue {
  if (parameter.type === "boolean" && typeof value === "boolean") {
    return value;
  }
  if (parameter.type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (parameter.type === "string" && typeof value === "string") {
    return value;
  }
  const description = parameter.type === "integer" ? "a safe integer" : `a ${parameter.type}`;
  throw error("invalid-value", engine, key, `must be ${description}`);
}

function readSource(
  document: Record<string, unknown>,
  engine: string,
): EngineProjectConfig["source"] {
  const source = readObject(document, "source", engine, "source");
  assertOnlyKeys(source, SOURCE_KEYS, engine, "source");
  return { root: readString(source, "root", engine, "source.root") };
}

function readIdentity(
  document: Record<string, unknown>,
  engine: string,
): EngineProjectConfig["identity"] {
  const identity = readObject(document, "identity", engine, "identity");
  assertOnlyKeys(identity, IDENTITY_KEYS, engine, "identity");
  return {
    id: readString(identity, "id", engine, "identity.id"),
    version: readString(identity, "version", engine, "identity.version"),
    sourceLocale: readString(identity, "sourceLocale", engine, "identity.sourceLocale"),
    sourceProfileId: readString(identity, "sourceProfileId", engine, "identity.sourceProfileId"),
  };
}

function readExtract(
  document: Record<string, unknown>,
  engine: string,
): EngineProjectConfig["extract"] {
  const extract = readObject(document, "extract", engine, "extract");
  assertOnlyKeys(extract, EXTRACT_KEYS, engine, "extract");
  const scope = readScope(extract, engine);
  return {
    output: readString(extract, "output", engine, "extract.output"),
    scope,
  };
}

function readStructure(
  document: Record<string, unknown>,
  engine: string,
): EngineProjectConfig["structure"] {
  const structure = readObject(document, "structure", engine, "structure");
  assertOnlyKeys(structure, STRUCTURE_KEYS, engine, "structure");
  return { output: readString(structure, "output", engine, "structure.output") };
}

function readScope(extract: Record<string, unknown>, engine: string): EngineProjectExtractionScope {
  const scope = readObject(extract, "scope", engine, "extract.scope");
  const kind = readScopeKind(scope, engine);
  if (kind === "all") {
    assertOnlyKeys(scope, ALL_SCOPE_KEYS, engine, "extract.scope");
    return { kind };
  }
  if (kind === "unit-set") {
    assertOnlyKeys(scope, UNIT_SET_SCOPE_KEYS, engine, "extract.scope");
    return { kind, unitIds: readUnitIdArray(scope, "unitIds", engine, "extract.scope.unitIds") };
  }

  assertOnlyKeys(scope, UNIT_RANGE_SCOPE_KEYS, engine, "extract.scope");
  const start = readInteger(scope, "start", engine, "extract.scope.start");
  const endExclusive = readInteger(scope, "endExclusive", engine, "extract.scope.endExclusive");
  if (start >= endExclusive) {
    throw error(
      "invalid-value",
      engine,
      "extract.scope.endExclusive",
      "must be greater than extract.scope.start",
    );
  }
  return { kind, start, endExclusive };
}

function readScopeKind(scope: Record<string, unknown>, engine: string): EngineProjectScopeKind {
  const value = readString(scope, "kind", engine, "extract.scope.kind");
  if (value === "all" || value === "unit-range" || value === "unit-set") {
    return value;
  }
  throw error(
    "invalid-value",
    engine,
    "extract.scope.kind",
    "must be one of all, unit-range, or unit-set",
  );
}

function readUnitIdArray(
  record: Record<string, unknown>,
  name: string,
  engine: string,
  key: string,
): readonly string[] {
  const value = readRequired(record, name, engine, key);
  if (!Array.isArray(value)) {
    throw error("invalid-value", engine, key, "must be an array of non-empty unit identifiers");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (typeof item === "string" && item.trim().length > 0 && !seen.has(item)) {
      seen.add(item);
      return item;
    }
    throw error(
      "invalid-value",
      engine,
      `${key}.${index}`,
      "must be a distinct non-empty unit identifier",
    );
  });
}

function readInteger(
  record: Record<string, unknown>,
  name: string,
  engine: string,
  key: string,
): number {
  const value = readRequired(record, name, engine, key);
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  throw error("invalid-value", engine, key, "must be a safe integer");
}

function readObject(
  record: Record<string, unknown>,
  name: string,
  engine: string,
  key: string,
): Record<string, unknown> {
  return expectRecord(readRequired(record, name, engine, key), engine, key);
}

function readString(
  record: Record<string, unknown>,
  name: string,
  engine: string | undefined,
  key: string,
): string {
  const value = readRequired(record, name, engine, key);
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw error("invalid-value", engine, key, "must be a non-empty string");
}

function readRequired(
  record: Record<string, unknown>,
  name: string,
  engine: string | undefined,
  key: string,
): unknown {
  if (Object.hasOwn(record, name)) {
    return record[name];
  }
  throw error("missing-required-key", engine, key, "is required");
}

function expectRecord(
  value: unknown,
  engine: string | undefined,
  key: string,
): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  throw error("invalid-value", engine, key, "must be an object");
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  engine: string,
  keyPrefix: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      const fullKey = keyPrefix === "$" ? key : `${keyPrefix}.${key}`;
      throw error("unknown-key", engine, fullKey, "is not a recognized key");
    }
  }
}

function error(
  code: EngineProjectConfigError["code"],
  engine: string | undefined,
  key: string,
  description: string,
): EngineProjectConfigError {
  const prefix = engine === undefined ? "Project config" : `Project config for engine '${engine}'`;
  return new EngineProjectConfigError({
    code,
    engine,
    key,
    message: `${prefix} key '${key}' ${description}.`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
