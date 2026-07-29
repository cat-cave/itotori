import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import type { TerminologySemanticIndexStatus } from "../schema.js";
import {
  terminologyAliases,
  terminologySemanticIndex,
  terminologySemanticIndexStatusValues,
  terminologySourceReferences,
} from "../schema.js";
import { createUuid7 } from "./event-queue-repository.js";
import { getTermBaseById } from "./terminology-repository-reads.js";
import type {
  TerminologyJsonRecord,
  TerminologySemanticIndexInput,
} from "./terminology-repository-types.js";
import { enumValue, jsonRecord, requiredString, tokenize } from "./terminology-repository-utils.js";

export async function upsertSemanticIndex(
  db: ItotoriDatabase,
  termId: string,
  input: TerminologySemanticIndexInput | undefined,
): Promise<void> {
  const baseTerm = await getTermBaseById(db, termId);
  if (baseTerm === null) {
    throw new Error(`terminology term ${termId} does not exist`);
  }
  const existingAliases = await db
    .select()
    .from(terminologyAliases)
    .where(eq(terminologyAliases.termId, termId));
  const existingReferences = await db
    .select()
    .from(terminologySourceReferences)
    .where(eq(terminologySourceReferences.termId, termId));
  const searchDocument =
    input?.searchDocument ??
    [
      baseTerm.sourceTerm,
      baseTerm.preferredTranslation,
      ...existingAliases.map((alias) => alias.aliasText),
      ...existingReferences.flatMap((reference) => [reference.citation, reference.context ?? ""]),
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  const searchTokens = tokenize(searchDocument);
  const contentHash = `sha256:${createHash("sha256").update(searchDocument).digest("hex")}`;
  const semanticIndex = normalizeSemanticIndexInput(input);
  await db
    .insert(terminologySemanticIndex)
    .values({
      semanticIndexId: input?.semanticIndexId ?? createUuid7(),
      termId,
      searchDocument,
      searchTokens,
      embeddingProvider: semanticIndex.embeddingProvider,
      embeddingModel: semanticIndex.embeddingModel,
      embeddingDimension: semanticIndex.embeddingDimension,
      embeddingVector: semanticIndex.embeddingVector,
      contentHash,
      status: semanticIndex.status,
      metadata: semanticIndex.metadata,
      refreshedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: terminologySemanticIndex.termId,
      set: {
        searchDocument,
        searchTokens,
        embeddingProvider: semanticIndex.embeddingProvider,
        embeddingModel: semanticIndex.embeddingModel,
        embeddingDimension: semanticIndex.embeddingDimension,
        embeddingVector: semanticIndex.embeddingVector,
        contentHash,
        status: semanticIndex.status,
        metadata: semanticIndex.metadata,
        refreshedAt: new Date(),
        updatedAt: sql`now()`,
      },
    });
}

type NormalizedTerminologySemanticIndexInput = {
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  embeddingVector: number[] | null;
  status: TerminologySemanticIndexStatus;
  metadata: TerminologyJsonRecord;
};

const lexicalEmbeddingProvider = "itotori-lexical";
const lexicalEmbeddingModel = "terminology-lexical-token-index-v1";

function normalizeSemanticIndexInput(
  input: TerminologySemanticIndexInput | undefined,
): NormalizedTerminologySemanticIndexInput {
  const embeddingProvider =
    input?.embeddingProvider === undefined
      ? lexicalEmbeddingProvider
      : requiredString(input.embeddingProvider, "semanticIndex.embeddingProvider");
  const embeddingModel =
    input?.embeddingModel === undefined
      ? lexicalEmbeddingModel
      : requiredString(input.embeddingModel, "semanticIndex.embeddingModel");
  const embeddingDimension = input?.embeddingDimension ?? 0;
  if (
    !Number.isInteger(embeddingDimension) ||
    embeddingDimension < 0 ||
    !Number.isSafeInteger(embeddingDimension)
  ) {
    throw new Error("semanticIndex.embeddingDimension must be a non-negative safe integer");
  }

  const embeddingVector = input?.embeddingVector ?? null;
  if (embeddingVector !== null) {
    if (
      !Array.isArray(embeddingVector) ||
      !embeddingVector.every((value) => Number.isFinite(value))
    ) {
      throw new Error("semanticIndex.embeddingVector must be an array of finite numbers");
    }
    if (embeddingVector.length !== embeddingDimension) {
      throw new Error("semanticIndex.embeddingDimension must match embeddingVector length");
    }
  }

  const status =
    input?.status === undefined
      ? terminologySemanticIndexStatusValues.indexedLexical
      : enumValue(
          input.status,
          Object.values(terminologySemanticIndexStatusValues),
          "semanticIndex.status",
        );
  const vectorReady = embeddingVector !== null && embeddingDimension > 0;
  const semanticReady =
    status === terminologySemanticIndexStatusValues.ready &&
    vectorReady &&
    embeddingProvider !== lexicalEmbeddingProvider &&
    embeddingModel !== lexicalEmbeddingModel;

  if (status === terminologySemanticIndexStatusValues.ready && !semanticReady) {
    throw new Error(
      "semanticIndex.status ready requires a non-lexical provider/model and a non-empty matching embedding vector",
    );
  }

  return {
    embeddingProvider,
    embeddingModel,
    embeddingDimension,
    embeddingVector,
    status,
    metadata: {
      ...jsonRecord(input?.metadata ?? {}, "semanticIndex.metadata"),
      hookKind: "lexical_token_index",
      indexKind: semanticReady ? "semantic_vector_index" : "lexical_token_index",
      semanticReady,
      vectorReady,
    },
  };
}
