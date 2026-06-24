import type { ProviderFamily, ProviderRunRecord } from "../../providers/types.js";
import type { Bcp47Locale, Uuid7 } from "../../batch-planner/shapes.js";

/**
 * Closed-enum list of terminology candidate kinds the agent may emit.
 * Mirrors the DB CHECK constraint in 0033_terminology_candidates.sql;
 * adding a kind requires a prompt-template version bump + migration.
 */
export const TERMINOLOGY_CANDIDATE_KINDS = [
  "ProperNoun",
  "TitleOrHonorific",
  "TechnicalTerm",
  "Catchphrase",
  "SoundEffect",
  "WrittenSign",
  "Other",
] as const;

export type CandidateKind = (typeof TERMINOLOGY_CANDIDATE_KINDS)[number];

export type TerminologyCandidateStatus = "Fresh" | "Stale" | "Promoted" | "RejectedByReviewer";

export type TerminologyCandidateInvalidatedReason =
  | "source_hash_drift"
  | "template_version_bump"
  | "glossary_conflict_post_persist"
  | "manual";

export type TerminologyCandidateModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number | undefined;
};

export type BridgeUnitForTerminology = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string | undefined;
};

export type ExistingGlossaryEntry = {
  terminologyTermId: Uuid7;
  preferredSourceForm: string;
  aliases: ReadonlyArray<string>;
  kind?: string | undefined;
};

export type PriorCandidateRef = {
  candidateId: Uuid7;
  surfaceForm: string;
  kind: CandidateKind;
};

export type TerminologyCandidateInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  sourceLocale: Bcp47Locale;
  units: ReadonlyArray<BridgeUnitForTerminology>;
  existingGlossary: ReadonlyArray<ExistingGlossaryEntry>;
  priorCandidates?: ReadonlyArray<PriorCandidateRef> | undefined;
  modelProfile: TerminologyCandidateModelProfile;
  now?: (() => Date) | undefined;
  promptTemplateVersion?: string | undefined;
};

export type TerminologyCandidate = {
  id: Uuid7;
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  kind: CandidateKind;
  surfaceForm: string;
  surfaceLocale: Bcp47Locale;
  rationale: string;
  readingHint?: string | undefined;
  citedUnitIds: Uuid7[];
  citedUnitHashes: string[];
  conflictingTerminologyTermId?: Uuid7 | undefined;
  modelProfile: TerminologyCandidateModelProfile;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;
  generatedAt: string;
  status: TerminologyCandidateStatus;
  invalidatedAt?: string;
  invalidatedReason?: TerminologyCandidateInvalidatedReason;
};

export type TerminologyCandidateOutput = {
  candidates: TerminologyCandidate[];
  providerRun: ProviderRunRecord;
};

export type ProviderEmittedPack = {
  candidates: Array<{
    kind: CandidateKind;
    surfaceForm: string;
    rationale: string;
    readingHint?: string | undefined;
    citedUnitIds: string[];
  }>;
};

export class TerminologyCandidateLocaleMismatchError extends Error {
  constructor(
    public readonly expectedSourceLocale: Bcp47Locale,
    public readonly providedLocale: Bcp47Locale,
  ) {
    super(
      `terminology-candidate agent refused: expected sourceLocale ${expectedSourceLocale}, got ${providedLocale}`,
    );
    this.name = "TerminologyCandidateLocaleMismatchError";
  }
}

export class TerminologyCandidateEmptyInputError extends Error {
  constructor(public readonly projectId: string) {
    super(`terminology-candidate agent refused: project ${projectId} has no units`);
    this.name = "TerminologyCandidateEmptyInputError";
  }
}

export class TerminologyCandidateUncitedError extends Error {
  constructor(public readonly surfaceForm: string) {
    super(`terminology-candidate agent refused: candidate ${surfaceForm} cites no bridge units`);
    this.name = "TerminologyCandidateUncitedError";
  }
}

export class ExistingGlossaryConflictError extends Error {
  constructor(
    public readonly surfaceForm: string,
    public readonly terminologyTermId: string,
  ) {
    super(
      `terminology-candidate agent refused: surface form ${surfaceForm} already exists in glossary (term ${terminologyTermId})`,
    );
    this.name = "ExistingGlossaryConflictError";
  }
}

export class TerminologyCandidateNotInUnitsError extends Error {
  constructor(public readonly surfaceForm: string) {
    super(
      `terminology-candidate agent refused: surface form ${surfaceForm} does not appear verbatim in any cited unit`,
    );
    this.name = "TerminologyCandidateNotInUnitsError";
  }
}

export class TerminologyCandidateInvalidKindError extends Error {
  constructor(public readonly observed: string) {
    super(
      `terminology-candidate agent refused: kind ${observed} is not in the closed enum ${TERMINOLOGY_CANDIDATE_KINDS.join(",")}`,
    );
    this.name = "TerminologyCandidateInvalidKindError";
  }
}

export class TerminologyCandidateParseError extends Error {
  constructor(public readonly reason: string) {
    super(`terminology-candidate agent refused: provider output could not be parsed (${reason})`);
    this.name = "TerminologyCandidateParseError";
  }
}

export class TerminologyCandidateUnknownCitationError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly context: string,
  ) {
    super(
      `terminology-candidate agent refused: cited bridge unit ${bridgeUnitId} (${context}) is not in input.units`,
    );
    this.name = "TerminologyCandidateUnknownCitationError";
  }
}
