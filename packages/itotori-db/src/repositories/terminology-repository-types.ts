import type { AuthorizationActor } from "../authorization.js";
import type {
  TerminologyAliasKind,
  TerminologyConflictKind,
  TerminologyConflictStatus,
  TerminologySemanticIndexStatus,
  TerminologySourceReferenceKind,
  TerminologyTermKind,
  TerminologyTermStatus,
} from "../schema.js";
import type { BranchPolicyGlossaryReferenceRecord } from "./branch-reference-repository.js";

export type TerminologyJsonRecord = Record<string, unknown>;

export type TerminologyAliasInput = {
  aliasId?: string;
  aliasText: string;
  aliasKind: TerminologyAliasKind;
  locale?: string;
  metadata?: TerminologyJsonRecord;
};

export type TerminologySourceReferenceInput = {
  sourceRefId?: string;
  sourceRevisionId?: string;
  bridgeUnitId?: string;
  sourceProvenanceId?: string;
  referenceKind: TerminologySourceReferenceKind;
  citation: string;
  context?: string;
  metadata?: TerminologyJsonRecord;
};

export type TerminologySemanticIndexInput = {
  semanticIndexId?: string;
  searchDocument?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  embeddingVector?: number[] | null;
  status?: TerminologySemanticIndexStatus;
  metadata?: TerminologyJsonRecord;
};

export type UpsertTerminologyTermInput = {
  termId?: string;
  projectId: string;
  localeBranchId: string;
  sourceTerm: string;
  preferredTranslation: string;
  termKind?: TerminologyTermKind;
  partOfSpeech?: string;
  caseSensitive?: boolean;
  notes?: string;
  metadata?: TerminologyJsonRecord;
  aliases?: TerminologyAliasInput[];
  sourceReferences?: TerminologySourceReferenceInput[];
  semanticIndex?: TerminologySemanticIndexInput;
  conflictPolicy?: "record" | "reject";
};

export type TerminologySearchInput = {
  projectId?: string;
  localeBranchId: string;
  query: string;
  limit?: number;
  includeDeprecated?: boolean;
};

export type TerminologyConflictFilter = {
  projectId?: string;
  localeBranchId?: string;
  status?: TerminologyConflictStatus;
};

export type TerminologyTermRecord = {
  termId: string;
  projectId: string;
  localeBranchId: string;
  sourceTerm: string;
  normalizedSourceTerm: string;
  sourceLocale: string;
  targetLocale: string;
  preferredTranslation: string;
  normalizedPreferredTranslation: string;
  termKind: TerminologyTermKind;
  partOfSpeech: string | null;
  status: TerminologyTermStatus;
  caseSensitive: boolean;
  notes: string | null;
  metadata: TerminologyJsonRecord;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  aliases: TerminologyAliasRecord[];
  sourceReferences: TerminologySourceReferenceRecord[];
  semanticIndex: TerminologySemanticIndexRecord | null;
};

export type TerminologyAliasRecord = {
  aliasId: string;
  termId: string;
  aliasText: string;
  normalizedAliasText: string;
  aliasKind: TerminologyAliasKind;
  locale: string | null;
  metadata: TerminologyJsonRecord;
  createdAt: Date;
};

export type TerminologySourceReferenceRecord = {
  sourceRefId: string;
  termId: string;
  sourceRevisionId: string | null;
  bridgeUnitId: string | null;
  sourceProvenanceId: string | null;
  referenceKind: TerminologySourceReferenceKind;
  citation: string;
  context: string | null;
  metadata: TerminologyJsonRecord;
  createdAt: Date;
};

export type TerminologySemanticIndexRecord = {
  semanticIndexId: string;
  termId: string;
  searchDocument: string;
  searchTokens: string[];
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  embeddingVector: number[] | null;
  contentHash: string;
  status: TerminologySemanticIndexStatus;
  metadata: TerminologyJsonRecord;
  refreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TerminologyConflictRecord = {
  conflictId: string;
  projectId: string;
  localeBranchId: string;
  normalizedSourceTerm: string;
  conflictKind: TerminologyConflictKind;
  status: TerminologyConflictStatus;
  summary: string;
  findingId: string | null;
  metadata: TerminologyJsonRecord;
  detectedAt: Date;
  updatedAt: Date;
};

export type TerminologySearchMatchKind =
  | "exact_source"
  | "exact_translation"
  | "alias"
  | "lexical_hook";

export type TerminologySearchResult = {
  term: TerminologyTermRecord;
  matchKinds: TerminologySearchMatchKind[];
  score: number;
};

export type TerminologySearchReadModel = {
  query: string;
  normalizedQuery: string;
  localeBranchId: string;
  results: TerminologySearchResult[];
};

export type GlossaryProtectedSpanReference = TerminologyJsonRecord & {
  protectedSpanRefId: string;
  sourceRefId: string | null;
  bridgeUnitId: string;
  sourceRevisionId: string;
  sourceUnitKey: string;
  spanId: string;
  spanKind: string;
  raw: string;
  startByte: number | null;
  endByte: number | null;
  preserveMode: string | null;
};

export type GlossaryTermProvenance = {
  sourceRefId: string;
  sourceRevisionId: string | null;
  bridgeUnitId: string | null;
  sourceProvenanceId: string | null;
  referenceKind: TerminologySourceReferenceKind;
  citation: string;
  context: string | null;
  metadata: TerminologyJsonRecord;
};

export type GlossaryContextInput = {
  localeBranchId: string;
  termId: string;
  sourceRevisionId: string;
};

export type GlossaryContextReadModel = {
  localeBranchId: string;
  sourceRevisionId: string;
  styleGuideVersionId: string | null;
  glossaryReferenceId: string | null;
  branchReference: BranchPolicyGlossaryReferenceRecord | null;
  term: TerminologyTermRecord;
  termProvenance: GlossaryTermProvenance[];
  protectedSpanReferences: GlossaryProtectedSpanReference[];
};

export type UpsertTerminologyTermResult = {
  term: TerminologyTermRecord;
  conflict: TerminologyConflictRecord | null;
};

export class TerminologySourceReferenceError extends Error {
  constructor(
    readonly code:
      | "terminology.source_reference.source_revision_mismatch"
      | "terminology.source_reference.bridge_unit_mismatch"
      | "terminology.source_reference.source_provenance_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TerminologySourceReferenceError";
  }
}

export interface ItotoriTerminologyRepositoryPort {
  upsertTerm(
    actor: AuthorizationActor,
    input: UpsertTerminologyTermInput,
  ): Promise<UpsertTerminologyTermResult>;
  searchTerms(
    actor: AuthorizationActor,
    input: TerminologySearchInput,
  ): Promise<TerminologySearchReadModel>;
  listConflicts(
    actor: AuthorizationActor,
    filter?: TerminologyConflictFilter,
  ): Promise<TerminologyConflictRecord[]>;
  getGlossaryContext(
    actor: AuthorizationActor,
    input: GlossaryContextInput,
  ): Promise<GlossaryContextReadModel | null>;
}
