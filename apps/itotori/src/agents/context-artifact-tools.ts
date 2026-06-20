import {
  contextArtifactToolName,
  contextArtifactToolVersion,
  type ContextArtifactRetrievalResult,
  type RetrieveContextArtifactsInput,
} from "@itotori/db";
import type { JsonObject } from "../providers/types.js";
import type {
  DeterministicToolDefinition,
  RegistrySchemaDescriptor,
  StableJsonHash,
} from "./registry.js";

export type ContextArtifactRetrievalToolInput = JsonObject & RetrieveContextArtifactsInput;

export type ContextArtifactRetrievalToolOutput = JsonObject & {
  outputKind: "context_artifact_retrieval";
  status: "completed" | "failed";
  toolName: typeof contextArtifactToolName;
  toolVersion: typeof contextArtifactToolVersion;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string | null;
  query: string | null;
  normalizedQuery: string | null;
  categories: string[];
  matches: JsonObject[];
  diagnostics: JsonObject[];
};

export type ContextArtifactRetrievalToolService = {
  retrieveArtifacts(input: RetrieveContextArtifactsInput): Promise<ContextArtifactRetrievalResult>;
};

export const contextArtifactRetrievalRegistryToolName = contextArtifactToolName;
export const contextArtifactRetrievalToolImplementationHash =
  "sha256:4a710ea50b3d91f2d4d995174fe0e4520924251473d988e2e8323330e3a14246" satisfies StableJsonHash;

export const contextArtifactRetrievalToolInputSchema = {
  schemaId: "itotori.tool.context-artifacts.input",
  schemaVersion: "1.0.0",
  description:
    "Typed context artifact retrieval request scoped by project, locale branch, category, source units, and optional query.",
  jsonSchema: {
    type: "object",
    required: ["projectId", "localeBranchId"],
    additionalProperties: false,
    properties: {
      projectId: { type: "string", minLength: 1 },
      localeBranchId: { type: "string", minLength: 1 },
      sourceRevisionId: { type: "string", minLength: 1 },
      categories: {
        type: "array",
        items: {
          enum: [
            "scene_summary",
            "character_note",
            "route_map",
            "speaker_label",
            "terminology_candidate",
          ],
        },
      },
      bridgeUnitIds: { type: "array", items: { type: "string", minLength: 1 } },
      query: { type: "string" },
      includeStale: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const contextArtifactRetrievalToolOutputSchema = {
  schemaId: "itotori.tool.context-artifacts.output",
  schemaVersion: "1.0.0",
  description: "Typed context artifact matches with citations, provenance, and stale diagnostics.",
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
      "categories",
      "matches",
      "diagnostics",
    ],
    additionalProperties: false,
    properties: {
      outputKind: { const: "context_artifact_retrieval" },
      status: { enum: ["completed", "failed"] },
      toolName: { const: contextArtifactToolName },
      toolVersion: { const: contextArtifactToolVersion },
      projectId: { type: "string", minLength: 1 },
      localeBranchId: { type: "string", minLength: 1 },
      sourceRevisionId: {},
      query: {},
      normalizedQuery: {},
      categories: { type: "array", items: { type: "string" } },
      matches: {
        type: "array",
        items: {
          type: "object",
          required: [
            "contextArtifactId",
            "category",
            "status",
            "title",
            "body",
            "citations",
            "provenance",
            "retrievalScore",
            "retrievalReasons",
          ],
          additionalProperties: true,
          properties: {
            contextArtifactId: { type: "string", minLength: 1 },
            category: { type: "string", minLength: 1 },
            status: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            body: { type: "string" },
            citations: { type: "array", items: { type: "object" } },
            provenance: { type: "object" },
            retrievalScore: { type: "number" },
            retrievalReasons: { type: "array", items: { type: "string" } },
          },
        },
      },
      diagnostics: { type: "array", items: { type: "object" } },
    },
  },
} satisfies RegistrySchemaDescriptor;

export function contextArtifactRetrievalTool(
  service: ContextArtifactRetrievalToolService,
): DeterministicToolDefinition<
  ContextArtifactRetrievalToolInput,
  ContextArtifactRetrievalToolOutput
> {
  return {
    registryKind: "deterministic_tool_definition",
    toolName: contextArtifactRetrievalRegistryToolName,
    toolVersion: contextArtifactToolVersion,
    description: "Retrieves cited Itotori context artifacts through typed deterministic filters.",
    taskKind: "extract",
    capabilityKey: contextArtifactToolName,
    inputSchema: contextArtifactRetrievalToolInputSchema,
    outputSchema: contextArtifactRetrievalToolOutputSchema,
    reproducibility: {
      algorithmName: contextArtifactToolName,
      algorithmVersion: contextArtifactToolVersion,
      implementationHash: contextArtifactRetrievalToolImplementationHash,
      inputHashAlgorithm: "sha256-stable-json-v1",
      outputHashAlgorithm: "sha256-stable-json-v1",
      sideEffectFree: true,
    },
    run: async (input) =>
      contextArtifactRetrievalToolOutput(await service.retrieveArtifacts(input)),
  };
}

export function contextArtifactRetrievalToolOutput(
  result: ContextArtifactRetrievalResult,
): ContextArtifactRetrievalToolOutput {
  return {
    outputKind: "context_artifact_retrieval",
    status: result.status,
    toolName: result.toolName,
    toolVersion: result.toolVersion,
    projectId: result.projectId,
    localeBranchId: result.localeBranchId,
    sourceRevisionId: result.sourceRevisionId,
    query: result.query,
    normalizedQuery: result.normalizedQuery,
    categories: result.categories,
    matches: result.matches.map((match) => ({
      ...match,
      createdAt: match.createdAt.toISOString(),
      updatedAt: match.updatedAt.toISOString(),
      invalidatedAt: match.invalidatedAt?.toISOString() ?? null,
      sourceUnits: match.sourceUnits.map(sourceUnitOutput),
      citations: match.citations.map(sourceUnitOutput),
    })) as JsonObject[],
    diagnostics: result.diagnostics as JsonObject[],
  };
}

function sourceUnitOutput(
  sourceUnit: ContextArtifactRetrievalResult["matches"][number]["sourceUnits"][number],
) {
  return {
    ...sourceUnit,
    createdAt: sourceUnit.createdAt.toISOString(),
  };
}
