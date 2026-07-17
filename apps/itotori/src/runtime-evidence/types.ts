import { createHash } from "node:crypto";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type StableJsonHash = `sha256:${string}`;

export type RegistrySchemaDescriptor = {
  schemaId: string;
  schemaVersion: string;
  description: string;
  jsonSchema: JsonObject;
};

export type DeterministicToolDefinition<
  Input extends JsonObject = JsonObject,
  Output extends JsonObject = JsonObject,
> = {
  registryKind: "deterministic_tool_definition";
  toolName: `tool.${string}` | `search.${string}`;
  toolVersion: string;
  description: string;
  taskKind: "deterministic_qa" | "extract" | "patch" | "runtime_verify";
  capabilityKey: string;
  inputSchema: RegistrySchemaDescriptor;
  outputSchema: RegistrySchemaDescriptor;
  reproducibility: {
    algorithmName: string;
    algorithmVersion: string;
    implementationHash: StableJsonHash;
    inputHashAlgorithm: "sha256-stable-json-v1";
    outputHashAlgorithm: "sha256-stable-json-v1";
    sideEffectFree: true;
  };
  run(input: Input): Output | Promise<Output>;
};

type ImplementationHashArtifacts = {
  toolName: string;
  toolVersion: string;
  algorithmName: string;
  algorithmVersion: string;
  inputSchema: RegistrySchemaDescriptor;
  outputSchema: RegistrySchemaDescriptor;
};

function normalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

export function deriveImplementationHash(artifacts: ImplementationHashArtifacts): StableJsonHash {
  const canonical: JsonObject = {
    algorithmName: artifacts.algorithmName,
    algorithmVersion: artifacts.algorithmVersion,
    inputSchema: artifacts.inputSchema,
    outputSchema: artifacts.outputSchema,
    toolName: artifacts.toolName,
    toolVersion: artifacts.toolVersion,
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalize(canonical)))
    .digest("hex")}`;
}
