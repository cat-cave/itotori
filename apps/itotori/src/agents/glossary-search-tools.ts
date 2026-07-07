import {
  exactSearchToolName,
  exactSearchToolVersion,
  glossaryReviewItemStateValues,
  semanticGlossarySearchDiagnosticCodeValues,
  semanticGlossarySearchToolName,
  semanticGlossarySearchToolVersion,
  terminologyAliasKindValues,
  terminologySemanticIndexStatusValues,
  terminologySourceReferenceKindValues,
  terminologyTermKindValues,
  terminologyTermStatusValues,
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
import { deriveImplementationHash } from "./registry.js";

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

export const glossaryContextRegistryToolName = "tool.glossary-context";
export const glossaryContextToolVersion = "1.0.0";

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

// Shared nested-object schema fragments derived from the @itotori/db service result
// types (SemanticGlossarySearchReadModel / GlossaryContextReadModel). Enum members are
// pulled from the service's own value tuples so the tool boundary cannot drift from the
// shapes the service actually produces and validates.
const nullableStringSchema = { type: ["string", "null"] };
const jsonRecordSchema = { type: "object" };

const glossaryReferenceKindSchema = {
  enum: Object.values(terminologySourceReferenceKindValues),
};

// A single cited source reference. Semantic, exact-fallback, and glossary-context
// provenance all emit citations with exactly these six fields.
const glossaryCitationSchema = {
  type: "object",
  required: [
    "sourceRefId",
    "sourceRevisionId",
    "bridgeUnitId",
    "referenceKind",
    "citation",
    "context",
  ],
  additionalProperties: false,
  properties: {
    sourceRefId: { type: "string", minLength: 1 },
    sourceRevisionId: nullableStringSchema,
    bridgeUnitId: nullableStringSchema,
    referenceKind: glossaryReferenceKindSchema,
    citation: { type: "string", minLength: 1 },
    context: nullableStringSchema,
  },
};

// SemanticGlossarySearchReadiness.
const semanticGlossarySearchReadinessSchema = {
  type: "object",
  required: [
    "embeddingMode",
    "liveProviderRequired",
    "fixtureId",
    "embeddingProvider",
    "embeddingModel",
    "embeddingDimension",
    "queryEmbeddingHash",
    "pgvector",
    "exactFallback",
  ],
  additionalProperties: false,
  properties: {
    embeddingMode: { const: "recorded_fixture" },
    liveProviderRequired: { const: false },
    fixtureId: { type: "string", minLength: 1 },
    embeddingProvider: { type: "string", minLength: 1 },
    embeddingModel: { type: "string", minLength: 1 },
    embeddingDimension: { type: "integer", minimum: 0 },
    queryEmbeddingHash: nullableStringSchema,
    pgvector: {
      type: "object",
      required: ["required", "available", "reason"],
      additionalProperties: false,
      properties: {
        required: { const: false },
        available: { const: false },
        reason: { const: "public_ci_uses_recorded_json_vectors" },
      },
    },
    exactFallback: {
      type: "object",
      required: ["triggered", "reason", "toolName", "toolVersion"],
      additionalProperties: false,
      properties: {
        triggered: { type: "boolean" },
        reason: {
          enum: [
            "missing_recorded_embedding",
            "stale_semantic_index",
            "no_semantic_results",
            "semantic_exact_match",
            null,
          ],
        },
        toolName: { const: exactSearchToolName },
        toolVersion: { const: exactSearchToolVersion },
      },
    },
  },
};

// SemanticGlossarySearchTermSummary — the service loosely types termKind/status as
// strings on the summary, so mirror that (the full term record enums live on context).
const semanticGlossarySearchTermSchema = {
  type: "object",
  required: [
    "termId",
    "sourceTerm",
    "preferredTranslation",
    "termKind",
    "status",
    "sourceLocale",
    "targetLocale",
  ],
  additionalProperties: false,
  properties: {
    termId: { type: "string", minLength: 1 },
    sourceTerm: { type: "string", minLength: 1 },
    preferredTranslation: { type: "string" },
    termKind: { type: "string", minLength: 1 },
    status: { type: "string", minLength: 1 },
    sourceLocale: { type: "string", minLength: 1 },
    targetLocale: { type: "string", minLength: 1 },
  },
};

// Provenance for a match: the semantic and exact-fallback variants share a common core
// (provenanceKind / toolName / toolVersion / citations) and diverge on variant-specific
// fields, so the shared core is validated deeply while variant fields are allowed through.
const semanticGlossarySearchMatchProvenanceSchema = {
  type: "object",
  required: ["provenanceKind", "toolName", "toolVersion", "citations"],
  additionalProperties: true,
  properties: {
    provenanceKind: {
      enum: ["semantic_glossary_search_result", "semantic_glossary_exact_fallback_result"],
    },
    toolName: { const: semanticGlossarySearchToolName },
    toolVersion: { const: semanticGlossarySearchToolVersion },
    citations: { type: "array", items: glossaryCitationSchema },
  },
};

// SemanticGlossarySearchDiagnostic.
const semanticGlossarySearchDiagnosticSchema = {
  type: "object",
  required: ["code", "reasonCode", "severity", "message"],
  additionalProperties: false,
  properties: {
    code: { enum: Object.values(semanticGlossarySearchDiagnosticCodeValues) },
    reasonCode: { enum: Object.values(semanticGlossarySearchDiagnosticCodeValues) },
    severity: { enum: ["error", "warning", "info"] },
    message: { type: "string", minLength: 1 },
    field: { type: "string", minLength: 1 },
    metadata: jsonRecordSchema,
  },
};

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
      sourceRevisionId: nullableStringSchema,
      query: { type: "string" },
      normalizedQuery: { type: "string" },
      readiness: semanticGlossarySearchReadinessSchema,
      matches: {
        type: "array",
        items: {
          type: "object",
          required: ["term", "score", "matchKinds", "exactMatchKinds", "provenance"],
          additionalProperties: false,
          properties: {
            term: semanticGlossarySearchTermSchema,
            score: { type: "number" },
            matchKinds: {
              type: "array",
              items: { enum: ["semantic_vector", "exact_fallback"] },
            },
            exactMatchKinds: {
              type: "array",
              items: { enum: ["exact_source", "exact_translation", "alias", "lexical_hook"] },
            },
            provenance: semanticGlossarySearchMatchProvenanceSchema,
          },
        },
      },
      diagnostics: { type: "array", items: semanticGlossarySearchDiagnosticSchema },
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

// GlossaryTermProvenance (context.termProvenance) — eight fields, distinct from the
// six-field citation shape used by provenance blocks.
const glossaryTermProvenanceSchema = {
  type: "object",
  required: [
    "sourceRefId",
    "sourceRevisionId",
    "bridgeUnitId",
    "sourceProvenanceId",
    "referenceKind",
    "citation",
    "context",
    "metadata",
  ],
  additionalProperties: false,
  properties: {
    sourceRefId: { type: "string", minLength: 1 },
    sourceRevisionId: nullableStringSchema,
    bridgeUnitId: nullableStringSchema,
    sourceProvenanceId: nullableStringSchema,
    referenceKind: glossaryReferenceKindSchema,
    citation: { type: "string", minLength: 1 },
    context: nullableStringSchema,
    metadata: jsonRecordSchema,
  },
};

// TerminologyAliasRecord.
const glossaryTermAliasSchema = {
  type: "object",
  required: [
    "aliasId",
    "termId",
    "aliasText",
    "normalizedAliasText",
    "aliasKind",
    "locale",
    "metadata",
    "createdAt",
  ],
  additionalProperties: false,
  properties: {
    aliasId: { type: "string", minLength: 1 },
    termId: { type: "string", minLength: 1 },
    aliasText: { type: "string", minLength: 1 },
    normalizedAliasText: { type: "string" },
    aliasKind: { enum: Object.values(terminologyAliasKindValues) },
    locale: nullableStringSchema,
    metadata: jsonRecordSchema,
    createdAt: { type: "string", minLength: 1 },
  },
};

// TerminologySourceReferenceRecord (context.term.sourceReferences).
const glossaryTermSourceReferenceSchema = {
  type: "object",
  required: [
    "sourceRefId",
    "termId",
    "sourceRevisionId",
    "bridgeUnitId",
    "sourceProvenanceId",
    "referenceKind",
    "citation",
    "context",
    "metadata",
    "createdAt",
  ],
  additionalProperties: false,
  properties: {
    sourceRefId: { type: "string", minLength: 1 },
    termId: { type: "string", minLength: 1 },
    sourceRevisionId: nullableStringSchema,
    bridgeUnitId: nullableStringSchema,
    sourceProvenanceId: nullableStringSchema,
    referenceKind: glossaryReferenceKindSchema,
    citation: { type: "string", minLength: 1 },
    context: nullableStringSchema,
    metadata: jsonRecordSchema,
    createdAt: { type: "string", minLength: 1 },
  },
};

// TerminologySemanticIndexRecord (nullable) on the term record.
const glossaryTermSemanticIndexSchema = {
  type: ["object", "null"],
  required: [
    "semanticIndexId",
    "termId",
    "searchDocument",
    "searchTokens",
    "embeddingProvider",
    "embeddingModel",
    "embeddingDimension",
    "embeddingVector",
    "contentHash",
    "status",
    "metadata",
    "refreshedAt",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
  properties: {
    semanticIndexId: { type: "string", minLength: 1 },
    termId: { type: "string", minLength: 1 },
    searchDocument: { type: "string" },
    searchTokens: { type: "array", items: { type: "string" } },
    embeddingProvider: { type: "string", minLength: 1 },
    embeddingModel: { type: "string", minLength: 1 },
    embeddingDimension: { type: "integer", minimum: 0 },
    embeddingVector: { type: ["array", "null"], items: { type: "number" } },
    contentHash: { type: "string", minLength: 1 },
    status: { enum: Object.values(terminologySemanticIndexStatusValues) },
    metadata: jsonRecordSchema,
    refreshedAt: nullableStringSchema,
    createdAt: { type: "string", minLength: 1 },
    updatedAt: { type: "string", minLength: 1 },
  },
};

// TerminologyTermRecord (context.term).
const glossaryContextTermSchema = {
  type: "object",
  required: [
    "termId",
    "projectId",
    "localeBranchId",
    "sourceTerm",
    "normalizedSourceTerm",
    "sourceLocale",
    "targetLocale",
    "preferredTranslation",
    "normalizedPreferredTranslation",
    "termKind",
    "partOfSpeech",
    "status",
    "caseSensitive",
    "notes",
    "metadata",
    "createdByUserId",
    "createdAt",
    "updatedAt",
    "aliases",
    "sourceReferences",
    "semanticIndex",
  ],
  additionalProperties: false,
  properties: {
    termId: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
    localeBranchId: { type: "string", minLength: 1 },
    sourceTerm: { type: "string", minLength: 1 },
    normalizedSourceTerm: { type: "string" },
    sourceLocale: { type: "string", minLength: 1 },
    targetLocale: { type: "string", minLength: 1 },
    preferredTranslation: { type: "string" },
    normalizedPreferredTranslation: { type: "string" },
    termKind: { enum: Object.values(terminologyTermKindValues) },
    partOfSpeech: nullableStringSchema,
    status: { enum: Object.values(terminologyTermStatusValues) },
    caseSensitive: { type: "boolean" },
    notes: nullableStringSchema,
    metadata: jsonRecordSchema,
    createdByUserId: nullableStringSchema,
    createdAt: { type: "string", minLength: 1 },
    updatedAt: { type: "string", minLength: 1 },
    aliases: { type: "array", items: glossaryTermAliasSchema },
    sourceReferences: { type: "array", items: glossaryTermSourceReferenceSchema },
    semanticIndex: glossaryTermSemanticIndexSchema,
  },
};

// BranchPolicyGlossaryReferenceRecord (nullable) on the context read model.
const glossaryContextBranchReferenceSchema = {
  type: ["object", "null"],
  required: [
    "referenceId",
    "projectId",
    "localeBranchId",
    "versionSequence",
    "styleGuideVersionId",
    "glossaryContentHash",
    "glossaryTermRefs",
    "glossaryReviewItemRefs",
    "updateReason",
    "eventId",
    "supersedesReferenceId",
    "actorUserId",
    "metadata",
    "createdAt",
  ],
  additionalProperties: false,
  properties: {
    referenceId: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
    localeBranchId: { type: "string", minLength: 1 },
    versionSequence: { type: "integer" },
    styleGuideVersionId: nullableStringSchema,
    glossaryContentHash: { type: "string", minLength: 1 },
    glossaryTermRefs: { type: "array", items: jsonRecordSchema },
    glossaryReviewItemRefs: { type: "array", items: jsonRecordSchema },
    updateReason: { type: "string", minLength: 1 },
    eventId: nullableStringSchema,
    supersedesReferenceId: nullableStringSchema,
    actorUserId: nullableStringSchema,
    metadata: jsonRecordSchema,
    createdAt: { type: "string", minLength: 1 },
  },
};

// GlossaryReviewItemRecord (context.reviewItems).
const glossaryContextReviewItemSchema = {
  type: "object",
  required: [
    "reviewItemId",
    "projectId",
    "localeBranchId",
    "termId",
    "sourceRevisionId",
    "styleGuideVersionId",
    "glossaryReferenceId",
    "state",
    "sourceTerm",
    "normalizedSourceTerm",
    "proposedTranslation",
    "normalizedProposedTranslation",
    "protectedSpanRefs",
    "provenance",
    "semanticDiagnostics",
    "metadata",
    "createdByUserId",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
  properties: {
    reviewItemId: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1 },
    localeBranchId: { type: "string", minLength: 1 },
    termId: nullableStringSchema,
    sourceRevisionId: { type: "string", minLength: 1 },
    styleGuideVersionId: nullableStringSchema,
    glossaryReferenceId: nullableStringSchema,
    state: { enum: Object.values(glossaryReviewItemStateValues) },
    sourceTerm: { type: "string", minLength: 1 },
    normalizedSourceTerm: { type: "string" },
    proposedTranslation: { type: "string" },
    normalizedProposedTranslation: { type: "string" },
    protectedSpanRefs: { type: "array", items: jsonRecordSchema },
    provenance: jsonRecordSchema,
    semanticDiagnostics: { type: "array", items: jsonRecordSchema },
    metadata: jsonRecordSchema,
    createdByUserId: nullableStringSchema,
    createdAt: { type: "string", minLength: 1 },
    updatedAt: { type: "string", minLength: 1 },
  },
};

// GlossaryProtectedSpanReference — a TerminologyJsonRecord intersection, so known fields
// are validated while the arbitrary json-record spread is allowed through.
const glossaryContextProtectedSpanReferenceSchema = {
  type: "object",
  required: [
    "protectedSpanRefId",
    "sourceRefId",
    "bridgeUnitId",
    "sourceRevisionId",
    "sourceUnitKey",
    "spanId",
    "spanKind",
    "raw",
    "startByte",
    "endByte",
    "preserveMode",
  ],
  additionalProperties: true,
  properties: {
    protectedSpanRefId: { type: "string", minLength: 1 },
    sourceRefId: nullableStringSchema,
    bridgeUnitId: { type: "string", minLength: 1 },
    sourceRevisionId: { type: "string", minLength: 1 },
    sourceUnitKey: { type: "string", minLength: 1 },
    spanId: { type: "string", minLength: 1 },
    spanKind: { type: "string", minLength: 1 },
    raw: { type: "string" },
    startByte: { type: ["integer", "null"] },
    endByte: { type: ["integer", "null"] },
    preserveMode: nullableStringSchema,
  },
};

// GlossaryContextReadModel (nullable — null when the term/revision is not found).
const glossaryContextReadModelSchema = {
  type: ["object", "null"],
  required: [
    "localeBranchId",
    "sourceRevisionId",
    "styleGuideVersionId",
    "glossaryReferenceId",
    "branchReference",
    "term",
    "termProvenance",
    "protectedSpanReferences",
    "reviewItems",
  ],
  additionalProperties: false,
  properties: {
    localeBranchId: { type: "string", minLength: 1 },
    sourceRevisionId: { type: "string", minLength: 1 },
    styleGuideVersionId: nullableStringSchema,
    glossaryReferenceId: nullableStringSchema,
    branchReference: glossaryContextBranchReferenceSchema,
    term: glossaryContextTermSchema,
    termProvenance: { type: "array", items: glossaryTermProvenanceSchema },
    protectedSpanReferences: {
      type: "array",
      items: glossaryContextProtectedSpanReferenceSchema,
    },
    reviewItems: { type: "array", items: glossaryContextReviewItemSchema },
  },
};

// The glossary-context tool constructs its own provenance block with a fully known shape.
const glossaryContextProvenanceSchema = {
  type: "object",
  required: [
    "provenanceKind",
    "toolName",
    "toolVersion",
    "termId",
    "localeBranchId",
    "sourceRevisionId",
    "glossaryReferenceId",
    "citations",
  ],
  additionalProperties: false,
  properties: {
    provenanceKind: { const: "glossary_context_lookup" },
    toolName: { const: glossaryContextRegistryToolName },
    toolVersion: { const: glossaryContextToolVersion },
    termId: { type: "string", minLength: 1 },
    localeBranchId: { type: "string", minLength: 1 },
    sourceRevisionId: { type: "string", minLength: 1 },
    glossaryReferenceId: nullableStringSchema,
    citations: { type: "array", items: glossaryCitationSchema },
  },
};

// The glossary-context tool only ever emits the not-found diagnostic.
const glossaryContextDiagnosticSchema = {
  type: "object",
  required: ["code", "severity", "message"],
  additionalProperties: false,
  properties: {
    code: { enum: ["glossary_context.not_found"] },
    severity: { enum: ["error", "warning", "info"] },
    message: { type: "string", minLength: 1 },
  },
};

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
      context: glossaryContextReadModelSchema,
      provenance: glossaryContextProvenanceSchema,
      diagnostics: { type: "array", items: glossaryContextDiagnosticSchema },
    },
  },
} satisfies RegistrySchemaDescriptor;

export const semanticGlossarySearchToolImplementationHash = deriveImplementationHash({
  toolName: semanticGlossarySearchRegistryToolName,
  toolVersion: semanticGlossarySearchToolVersion,
  algorithmName: semanticGlossarySearchToolName,
  algorithmVersion: semanticGlossarySearchToolVersion,
  inputSchema: semanticGlossarySearchToolInputSchema,
  outputSchema: semanticGlossarySearchToolOutputSchema,
}) satisfies StableJsonHash;

export const glossaryContextToolImplementationHash = deriveImplementationHash({
  toolName: glossaryContextRegistryToolName,
  toolVersion: glossaryContextToolVersion,
  algorithmName: "glossary.context",
  algorithmVersion: glossaryContextToolVersion,
  inputSchema: glossaryContextToolInputSchema,
  outputSchema: glossaryContextToolOutputSchema,
}) satisfies StableJsonHash;

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
