import type { SearchExactInput, SearchExactToolResult } from "@itotori/db";
import { exactSearchToolName, exactSearchToolVersion } from "@itotori/db";
import type { JsonObject } from "../providers/types.js";
import type {
  DeterministicToolDefinition,
  RegistrySchemaDescriptor,
  StableJsonHash,
} from "./registry.js";
import { deriveImplementationHash } from "./registry.js";

export type SearchExactToolInput = JsonObject & {
  projectId: string;
  localeBranchId: string;
  query: string;
  sourceRevisionId?: string;
  sourceArtifactTypes?: string[];
  limit?: number;
};

export type SearchExactToolMatchOutput = JsonObject & {
  searchDocumentId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  sourceArtifactType: string;
  sourceArtifactId: string;
  exactTerm: string;
  normalizedExactTerm: string;
  sourceLocale: string;
  targetLocale: string;
  provenance: JsonObject;
  refreshedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type SearchExactToolOutput = JsonObject & {
  outputKind: "search_exact";
  status: "completed" | "failed";
  toolName: typeof exactSearchToolName;
  toolVersion: typeof exactSearchToolVersion;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string | null;
  query: string;
  normalizedQuery: string;
  matches: SearchExactToolMatchOutput[];
  diagnostics: JsonObject[];
};

export type SearchExactToolService = {
  searchExact(input: SearchExactInput): Promise<SearchExactToolResult>;
};

export const searchExactRegistryToolName = exactSearchToolName;

export const searchExactToolInputSchema = {
  schemaId: "itotori.tool.search-exact.input",
  schemaVersion: "1.0.0",
  description: "Typed exact-search request with project, locale branch, query, and filters.",
  jsonSchema: {
    type: "object",
    required: ["projectId", "localeBranchId", "query"],
    additionalProperties: false,
    properties: {
      projectId: { type: "string", minLength: 1 },
      localeBranchId: { type: "string", minLength: 1 },
      query: { type: "string" },
      sourceRevisionId: { type: "string", minLength: 1 },
      sourceArtifactTypes: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const searchExactToolOutputSchema = {
  schemaId: "itotori.tool.search-exact.output",
  schemaVersion: "1.0.0",
  description: "Exact-only search results with document and match provenance.",
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
      "matches",
      "diagnostics",
    ],
    additionalProperties: false,
    properties: {
      outputKind: { const: "search_exact" },
      status: { enum: ["completed", "failed"] },
      toolName: { const: exactSearchToolName },
      toolVersion: { const: exactSearchToolVersion },
      projectId: { type: "string", minLength: 1 },
      localeBranchId: { type: "string", minLength: 1 },
      sourceRevisionId: {},
      query: { type: "string" },
      normalizedQuery: { type: "string" },
      matches: {
        type: "array",
        items: {
          type: "object",
          required: [
            "searchDocumentId",
            "projectId",
            "localeBranchId",
            "sourceRevisionId",
            "sourceArtifactType",
            "sourceArtifactId",
            "exactTerm",
            "normalizedExactTerm",
            "sourceLocale",
            "targetLocale",
            "provenance",
            "refreshedAt",
            "createdAt",
            "updatedAt",
          ],
          additionalProperties: false,
          properties: {
            searchDocumentId: { type: "string", minLength: 1 },
            projectId: { type: "string", minLength: 1 },
            localeBranchId: { type: "string", minLength: 1 },
            sourceRevisionId: { type: "string", minLength: 1 },
            sourceArtifactType: { type: "string", minLength: 1 },
            sourceArtifactId: { type: "string", minLength: 1 },
            exactTerm: { type: "string" },
            normalizedExactTerm: { type: "string" },
            sourceLocale: { type: "string", minLength: 1 },
            targetLocale: { type: "string", minLength: 1 },
            provenance: { type: "object" },
            refreshedAt: { type: "string", minLength: 1 },
            createdAt: { type: "string", minLength: 1 },
            updatedAt: { type: "string", minLength: 1 },
          },
        },
      },
      diagnostics: { type: "array", items: { type: "object" } },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const searchExactToolImplementationHash = deriveImplementationHash({
  toolName: searchExactRegistryToolName,
  toolVersion: exactSearchToolVersion,
  algorithmName: exactSearchToolName,
  algorithmVersion: exactSearchToolVersion,
  inputSchema: searchExactToolInputSchema,
  outputSchema: searchExactToolOutputSchema,
}) satisfies StableJsonHash;

export function searchExactTool(
  service: SearchExactToolService,
): DeterministicToolDefinition<SearchExactToolInput, SearchExactToolOutput> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: searchExactRegistryToolName,
    toolVersion: exactSearchToolVersion,
    description: "Executes the Itotori exact-only search service with typed filters.",
    taskKind: "extract",
    capabilityKey: exactSearchToolName,
    inputSchema: searchExactToolInputSchema,
    outputSchema: searchExactToolOutputSchema,
    reproducibility: {
      algorithmName: exactSearchToolName,
      algorithmVersion: exactSearchToolVersion,
      implementationHash: searchExactToolImplementationHash,
      inputHashAlgorithm: "sha256-stable-json-v1",
      outputHashAlgorithm: "sha256-stable-json-v1",
      sideEffectFree: true,
    },
    run: async (input) => searchExactToolOutput(await service.searchExact(input)),
  };
}

export function searchExactToolOutput(result: SearchExactToolResult): SearchExactToolOutput {
  return {
    outputKind: "search_exact",
    status: result.status,
    toolName: result.toolName,
    toolVersion: result.toolVersion,
    projectId: result.projectId,
    localeBranchId: result.localeBranchId,
    sourceRevisionId: result.sourceRevisionId,
    query: result.query,
    normalizedQuery: result.normalizedQuery,
    matches: result.matches.map((match) => ({
      searchDocumentId: match.searchDocumentId,
      projectId: match.projectId,
      localeBranchId: match.localeBranchId,
      sourceRevisionId: match.sourceRevisionId,
      sourceArtifactType: match.sourceArtifactType,
      sourceArtifactId: match.sourceArtifactId,
      exactTerm: match.exactTerm,
      normalizedExactTerm: match.normalizedExactTerm,
      sourceLocale: match.sourceLocale,
      targetLocale: match.targetLocale,
      provenance: match.provenance as JsonObject,
      refreshedAt: dateToIsoString(match.refreshedAt),
      createdAt: dateToIsoString(match.createdAt),
      updatedAt: dateToIsoString(match.updatedAt),
    })),
    diagnostics: result.diagnostics as JsonObject[],
  };
}

function dateToIsoString(value: Date): string {
  return value.toISOString();
}
