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
import { deriveImplementationHash } from "./registry.js";

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

const contextArtifactCategorySchema = {
  enum: ["scene_summary", "character_note", "route_map", "speaker_label", "terminology_candidate"],
};

const contextArtifactStatusSchema = {
  enum: ["active", "stale", "superseded", "rejected"],
};

const nullableStringSchema = {
  type: ["string", "null"],
};

const contextArtifactSourceUnitSchema = {
  type: "object",
  required: [
    "contextArtifactId",
    "bridgeUnitId",
    "sourceRevisionId",
    "sourceHash",
    "citation",
    "metadata",
    "createdAt",
  ],
  additionalProperties: false,
  properties: {
    contextArtifactId: { type: "string", minLength: 1 },
    bridgeUnitId: { type: "string", minLength: 1 },
    sourceRevisionId: { type: "string", minLength: 1 },
    sourceHash: { type: "string", minLength: 1 },
    citation: { type: "string", minLength: 1 },
    metadata: { type: "object" },
    createdAt: { type: "string", minLength: 1 },
  },
};

const contextArtifactProvenanceSchema = {
  type: "object",
  required: [
    "schemaVersion",
    "toolName",
    "toolVersion",
    "contextArtifactId",
    "category",
    "sourceRevisionId",
    "producerVersion",
  ],
  additionalProperties: true,
  properties: {
    schemaVersion: { const: "itotori.context-artifact.v1" },
    toolName: { const: contextArtifactToolName },
    toolVersion: { const: contextArtifactToolVersion },
    contextArtifactId: { type: "string", minLength: 1 },
    category: contextArtifactCategorySchema,
    sourceRevisionId: { type: "string", minLength: 1 },
    producedByAgent: nullableStringSchema,
    producedByTool: nullableStringSchema,
    producerVersion: { type: "string", minLength: 1 },
  },
};

const contextArtifactDiagnosticSchema = {
  type: "object",
  required: ["code", "reasonCode", "severity", "message"],
  additionalProperties: true,
  properties: {
    code: { type: "string", minLength: 1 },
    reasonCode: { type: "string", minLength: 1 },
    severity: { enum: ["error", "warning", "info"] },
    message: { type: "string", minLength: 1 },
    field: { type: "string", minLength: 1 },
    metadata: { type: "object" },
  },
};

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
      sourceRevisionId: nullableStringSchema,
      query: nullableStringSchema,
      normalizedQuery: nullableStringSchema,
      categories: { type: "array", items: contextArtifactCategorySchema },
      matches: {
        type: "array",
        items: {
          type: "object",
          required: [
            "contextArtifactId",
            "projectId",
            "localeBranchId",
            "sourceRevisionId",
            "category",
            "status",
            "title",
            "normalizedTitle",
            "body",
            "data",
            "contentHash",
            "producerVersion",
            "citations",
            "provenance",
            "sourceUnits",
            "retrievalScore",
            "retrievalReasons",
            "createdAt",
            "updatedAt",
          ],
          additionalProperties: false,
          properties: {
            contextArtifactId: { type: "string", minLength: 1 },
            projectId: { type: "string", minLength: 1 },
            localeBranchId: { type: "string", minLength: 1 },
            sourceRevisionId: { type: "string", minLength: 1 },
            category: contextArtifactCategorySchema,
            status: contextArtifactStatusSchema,
            title: { type: "string", minLength: 1 },
            normalizedTitle: { type: "string", minLength: 1 },
            body: { type: "string" },
            data: { type: "object" },
            contentHash: { type: "string", minLength: 1 },
            producedByAgent: nullableStringSchema,
            producedByTool: nullableStringSchema,
            producerVersion: { type: "string", minLength: 1 },
            provenance: contextArtifactProvenanceSchema,
            invalidatedReason: nullableStringSchema,
            invalidatedAt: nullableStringSchema,
            createdByUserId: nullableStringSchema,
            createdAt: { type: "string", minLength: 1 },
            updatedAt: { type: "string", minLength: 1 },
            sourceUnits: { type: "array", items: contextArtifactSourceUnitSchema },
            citations: { type: "array", minItems: 1, items: contextArtifactSourceUnitSchema },
            retrievalScore: { type: "number" },
            retrievalReasons: { type: "array", minItems: 1, items: { type: "string" } },
          },
        },
      },
      diagnostics: { type: "array", items: contextArtifactDiagnosticSchema },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const contextArtifactRetrievalToolImplementationHash = deriveImplementationHash({
  toolName: contextArtifactRetrievalRegistryToolName,
  toolVersion: contextArtifactToolVersion,
  algorithmName: contextArtifactToolName,
  algorithmVersion: contextArtifactToolVersion,
  inputSchema: contextArtifactRetrievalToolInputSchema,
  outputSchema: contextArtifactRetrievalToolOutputSchema,
}) satisfies StableJsonHash;

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
