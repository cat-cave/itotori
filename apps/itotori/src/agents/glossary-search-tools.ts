import {
  semanticGlossarySearchToolName,
  semanticGlossarySearchToolVersion,
  type GlossaryContextInput,
  type GlossaryContextReadModel,
  type SemanticGlossarySearchInput,
  type SemanticGlossarySearchReadModel,
} from "@itotori/db";
import type { JsonObject, JsonValue } from "../providers/types.js";
import type {
  DeterministicToolDefinition,
  RegistrySchemaDescriptor,
  StableJsonHash,
} from "./registry.js";

export type SemanticGlossarySearchToolInput = JsonObject & SemanticGlossarySearchInput;

export type SemanticGlossarySearchToolOutput = JsonObject & {
  outputKind: "semantic_glossary_search";
  status: "completed" | "failed";
  toolName: typeof semanticGlossarySearchToolName;
  toolVersion: typeof semanticGlossarySearchToolVersion;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string | null;
  query: string;
  normalizedQuery: string;
  readiness: JsonObject;
  matches: JsonObject[];
  diagnostics: JsonObject[];
};

export type GlossaryContextToolInput = JsonObject & GlossaryContextInput;

export type GlossaryContextToolOutput = JsonObject & {
  outputKind: "glossary_context_lookup";
  status: "completed";
  toolName: typeof glossaryContextRegistryToolName;
  toolVersion: typeof glossaryContextToolVersion;
  localeBranchId: string;
  sourceRevisionId: string;
  termId: string;
  found: boolean;
  context: JsonObject | null;
  provenance: JsonObject;
  diagnostics: JsonObject[];
};

export type SemanticGlossarySearchToolService = {
  searchGlossary(input: SemanticGlossarySearchInput): Promise<SemanticGlossarySearchReadModel>;
};

export type GlossaryContextToolService = {
  getGlossaryContext(input: GlossaryContextInput): Promise<GlossaryContextReadModel | null>;
};

export const semanticGlossarySearchRegistryToolName = semanticGlossarySearchToolName;
export const semanticGlossarySearchToolImplementationHash =
  "sha256:4c31cd6675554afac7ec21cbbbd1457f61055051260ad72bf4bb67d873f24f39" satisfies StableJsonHash;

export const glossaryContextRegistryToolName = "tool.glossary-context";
export const glossaryContextToolVersion = "1.0.0";
export const glossaryContextToolImplementationHash =
  "sha256:03c847d46fe81d2e9f7e738673c011f2d21c9c080da0252787722d35da00f8a7" satisfies StableJsonHash;

export const semanticGlossarySearchToolInputSchema = {
  schemaId: "itotori.tool.semantic-glossary-search.input",
  schemaVersion: "1.0.0",
  description: "Provider-free semantic glossary search request with exact fallback options.",
  jsonSchema: {
    type: "object",
    required: ["projectId", "localeBranchId", "query"],
    additionalProperties: false,
    properties: {
      projectId: { type: "string", minLength: 1 },
      localeBranchId: { type: "string", minLength: 1 },
      query: { type: "string" },
      sourceRevisionId: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      minScore: { type: "number", minimum: -1, maximum: 1 },
      includeDeprecated: { type: "boolean" },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const semanticGlossarySearchToolOutputSchema = {
  schemaId: "itotori.tool.semantic-glossary-search.output",
  schemaVersion: "1.0.0",
  description: "Semantic glossary search results with readiness metadata and cited provenance.",
  jsonSchema: {
    type: "object",
    required: [
      "outputKind",
      "status",
      "toolName",
      "toolVersion",
      "projectId",
      "localeBranchId",
      "sourceRevisionId",
      "query",
      "normalizedQuery",
      "readiness",
      "matches",
      "diagnostics",
    ],
    additionalProperties: false,
    properties: {
      outputKind: { const: "semantic_glossary_search" },
      status: { enum: ["completed", "failed"] },
      toolName: { const: semanticGlossarySearchToolName },
      toolVersion: { const: semanticGlossarySearchToolVersion },
      projectId: { type: "string", minLength: 1 },
      localeBranchId: { type: "string", minLength: 1 },
      sourceRevisionId: {},
      query: { type: "string" },
      normalizedQuery: { type: "string" },
      readiness: { type: "object" },
      matches: {
        type: "array",
        items: {
          type: "object",
          required: ["term", "score", "matchKinds", "exactMatchKinds", "provenance"],
          additionalProperties: false,
          properties: {
            term: { type: "object" },
            score: { type: "number" },
            matchKinds: { type: "array", items: { type: "string" } },
            exactMatchKinds: { type: "array", items: { type: "string" } },
            provenance: { type: "object" },
          },
        },
      },
      diagnostics: { type: "array", items: { type: "object" } },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const glossaryContextToolInputSchema = {
  schemaId: "itotori.tool.glossary-context.input",
  schemaVersion: "1.0.0",
  description: "Glossary context lookup request scoped to a locale branch and source revision.",
  jsonSchema: {
    type: "object",
    required: ["localeBranchId", "termId", "sourceRevisionId"],
    additionalProperties: false,
    properties: {
      localeBranchId: { type: "string", minLength: 1 },
      termId: { type: "string", minLength: 1 },
      sourceRevisionId: { type: "string", minLength: 1 },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const glossaryContextToolOutputSchema = {
  schemaId: "itotori.tool.glossary-context.output",
  schemaVersion: "1.0.0",
  description: "Glossary context lookup result with explicit provenance.",
  jsonSchema: {
    type: "object",
    required: [
      "outputKind",
      "status",
      "toolName",
      "toolVersion",
      "localeBranchId",
      "sourceRevisionId",
      "termId",
      "found",
      "context",
      "provenance",
      "diagnostics",
    ],
    additionalProperties: false,
    properties: {
      outputKind: { const: "glossary_context_lookup" },
      status: { const: "completed" },
      toolName: { const: glossaryContextRegistryToolName },
      toolVersion: { const: glossaryContextToolVersion },
      localeBranchId: { type: "string", minLength: 1 },
      sourceRevisionId: { type: "string", minLength: 1 },
      termId: { type: "string", minLength: 1 },
      found: { type: "boolean" },
      context: {},
      provenance: { type: "object" },
      diagnostics: { type: "array", items: { type: "object" } },
    },
  },
} satisfies RegistrySchemaDescriptor;

export function semanticGlossarySearchTool(
  service: SemanticGlossarySearchToolService,
): DeterministicToolDefinition<SemanticGlossarySearchToolInput, SemanticGlossarySearchToolOutput> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: semanticGlossarySearchRegistryToolName,
    toolVersion: semanticGlossarySearchToolVersion,
    description: "Runs provider-free recorded semantic glossary search with exact fallback.",
    taskKind: "extract",
    capabilityKey: semanticGlossarySearchToolName,
    inputSchema: semanticGlossarySearchToolInputSchema,
    outputSchema: semanticGlossarySearchToolOutputSchema,
    reproducibility: {
      algorithmName: semanticGlossarySearchToolName,
      algorithmVersion: semanticGlossarySearchToolVersion,
      implementationHash: semanticGlossarySearchToolImplementationHash,
      inputHashAlgorithm: "sha256-stable-json-v1",
      outputHashAlgorithm: "sha256-stable-json-v1",
      sideEffectFree: true,
    },
    run: async (input) => semanticGlossarySearchToolOutput(await service.searchGlossary(input)),
  };
}

export function glossaryContextTool(
  service: GlossaryContextToolService,
): DeterministicToolDefinition<GlossaryContextToolInput, GlossaryContextToolOutput> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: glossaryContextRegistryToolName,
    toolVersion: glossaryContextToolVersion,
    description: "Looks up cited glossary context for a specific term and source revision.",
    taskKind: "extract",
    capabilityKey: "glossary.context",
    inputSchema: glossaryContextToolInputSchema,
    outputSchema: glossaryContextToolOutputSchema,
    reproducibility: {
      algorithmName: "glossary.context",
      algorithmVersion: glossaryContextToolVersion,
      implementationHash: glossaryContextToolImplementationHash,
      inputHashAlgorithm: "sha256-stable-json-v1",
      outputHashAlgorithm: "sha256-stable-json-v1",
      sideEffectFree: true,
    },
    run: async (input) => glossaryContextToolOutput(input, await service.getGlossaryContext(input)),
  };
}

export function semanticGlossarySearchToolOutput(
  result: SemanticGlossarySearchReadModel,
): SemanticGlossarySearchToolOutput {
  return jsonObject(result) as SemanticGlossarySearchToolOutput;
}

export function glossaryContextToolOutput(
  input: GlossaryContextInput,
  context: GlossaryContextReadModel | null,
): GlossaryContextToolOutput {
  return {
    outputKind: "glossary_context_lookup",
    status: "completed",
    toolName: glossaryContextRegistryToolName,
    toolVersion: glossaryContextToolVersion,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    termId: input.termId,
    found: context !== null,
    context: context === null ? null : jsonObject(context),
    provenance: {
      provenanceKind: "glossary_context_lookup",
      toolName: glossaryContextRegistryToolName,
      toolVersion: glossaryContextToolVersion,
      termId: input.termId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      glossaryReferenceId: context?.glossaryReferenceId ?? null,
      citations:
        context?.termProvenance.map((reference) => ({
          sourceRefId: reference.sourceRefId,
          sourceRevisionId: reference.sourceRevisionId,
          bridgeUnitId: reference.bridgeUnitId,
          referenceKind: reference.referenceKind,
          citation: reference.citation,
          context: reference.context,
        })) ?? [],
    },
    diagnostics:
      context === null
        ? [
            {
              code: "glossary_context.not_found",
              severity: "info",
              message: "glossary context was not found for the requested term and source revision",
            },
          ]
        : [],
  };
}

function jsonObject(value: unknown): JsonObject {
  const serialized = JSON.parse(JSON.stringify(value)) as JsonValue;
  if (typeof serialized !== "object" || serialized === null || Array.isArray(serialized)) {
    throw new Error("tool output must serialize to a JSON object");
  }
  return serialized;
}
