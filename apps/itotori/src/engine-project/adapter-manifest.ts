import { EngineProjectAdapterManifestError } from "./errors.js";

export type EngineProjectAdapterParameterType = "boolean" | "integer" | "string";

export type EngineProjectAdapterParameter = {
  readonly name: string;
  readonly type: EngineProjectAdapterParameterType;
  readonly required: boolean;
  readonly description: string;
  /** Source-format fact that makes this engine-specific setting legitimate. */
  readonly formatProperty: string;
};

export type EngineProjectAdapterManifest = {
  readonly engine: string;
  readonly summary: string;
  readonly parameters: readonly EngineProjectAdapterParameter[];
};

const MANIFEST_KEYS = ["engine", "summary", "parameters"];
const PARAMETER_KEYS = ["name", "type", "required", "description", "formatProperty"];

export function parseEngineProjectAdapterManifest(
  value: unknown,
  source: string,
): EngineProjectAdapterManifest {
  const manifest = expectRecord(value, source, "$");
  assertOnlyKeys(manifest, MANIFEST_KEYS, source, "$");

  const engine = readNonEmptyString(manifest, "engine", source, "engine");
  const summary = readNonEmptyString(manifest, "summary", source, "summary");
  const parameters = readParameters(manifest, source);

  return { engine, summary, parameters };
}

function readParameters(
  manifest: Record<string, unknown>,
  source: string,
): readonly EngineProjectAdapterParameter[] {
  const value = readRequired(manifest, "parameters", source, "parameters");
  if (!Array.isArray(value)) {
    throw invalidManifest(source, "parameters", "must be an array");
  }

  const parameterNames = new Set<string>();
  return value.map((parameter, index) => {
    const keyPrefix = `parameters.${index}`;
    const record = expectRecord(parameter, source, keyPrefix);
    assertOnlyKeys(record, PARAMETER_KEYS, source, keyPrefix);

    const name = readNonEmptyString(record, "name", source, `${keyPrefix}.name`);
    if (parameterNames.has(name)) {
      throw invalidManifest(source, `${keyPrefix}.name`, `duplicates parameter '${name}'`);
    }
    parameterNames.add(name);

    const type = readParameterType(record, source, keyPrefix);
    const required = readBoolean(record, "required", source, `${keyPrefix}.required`);
    const description = readNonEmptyString(
      record,
      "description",
      source,
      `${keyPrefix}.description`,
    );
    const formatProperty = readNonEmptyString(
      record,
      "formatProperty",
      source,
      `${keyPrefix}.formatProperty`,
    );
    return { name, type, required, description, formatProperty };
  });
}

function readParameterType(
  record: Record<string, unknown>,
  source: string,
  keyPrefix: string,
): EngineProjectAdapterParameterType {
  const key = `${keyPrefix}.type`;
  const value = readString(record, "type", source, key);
  if (value === "boolean" || value === "integer" || value === "string") {
    return value;
  }
  throw invalidManifest(source, key, "must be one of boolean, integer, or string");
}

function expectRecord(value: unknown, source: string, key: string): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  throw invalidManifest(source, key, "must be an object");
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  source: string,
  keyPrefix: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      const fullKey = keyPrefix === "$" ? key : `${keyPrefix}.${key}`;
      throw invalidManifest(source, fullKey, "is not a recognized key");
    }
  }
}

function readRequired(
  record: Record<string, unknown>,
  name: string,
  source: string,
  key: string,
): unknown {
  if (Object.hasOwn(record, name)) {
    return record[name];
  }
  throw invalidManifest(source, key, "is required");
}

function readString(
  record: Record<string, unknown>,
  name: string,
  source: string,
  key: string,
): string {
  const value = readRequired(record, name, source, key);
  if (typeof value === "string") {
    return value;
  }
  throw invalidManifest(source, key, "must be a string");
}

function readNonEmptyString(
  record: Record<string, unknown>,
  name: string,
  source: string,
  key: string,
): string {
  const value = readString(record, name, source, key);
  if (value.trim().length > 0) {
    return value;
  }
  throw invalidManifest(source, key, "must be a non-empty string");
}

function readBoolean(
  record: Record<string, unknown>,
  name: string,
  source: string,
  key: string,
): boolean {
  const value = readRequired(record, name, source, key);
  if (typeof value === "boolean") {
    return value;
  }
  throw invalidManifest(source, key, "must be a boolean");
}

function invalidManifest(
  source: string,
  key: string,
  description: string,
): EngineProjectAdapterManifestError {
  return new EngineProjectAdapterManifestError({
    code: "invalid-manifest",
    source,
    key,
    message: `Adapter manifest '${source}' key '${key}' ${description}.`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
