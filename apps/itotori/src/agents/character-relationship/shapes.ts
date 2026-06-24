import type { ProviderFamily, ProviderRunRecord } from "../../providers/types.js";
import type { Bcp47Locale, GlossaryRef, Uuid7 } from "../../batch-planner/shapes.js";

/**
 * Closed-enum list of relationship kinds the agent may emit. Mirrors the
 * DB CHECK constraint in 0031_character_relationships.sql; adding a kind
 * is a prompt-template version bump + migration.
 */
export const CHARACTER_RELATIONSHIP_KINDS = [
  "FamilyRelation",
  "Romantic",
  "Friendship",
  "Mentor",
  "Rivalry",
  "Allegiance",
  "Antagonism",
  "Other",
] as const;

export type CharacterRelationshipKind = (typeof CHARACTER_RELATIONSHIP_KINDS)[number];

export const CHARACTER_RELATIONSHIP_DIRECTIONS = ["Symmetric", "FromAToB"] as const;

export type CharacterRelationshipDirection = (typeof CHARACTER_RELATIONSHIP_DIRECTIONS)[number];

export type CharacterRelationshipStatus = "Fresh" | "Stale";

export type CharacterRelationshipInvalidatedReason =
  | "source_hash_drift"
  | "template_version_bump"
  | "manual";

export type CharacterRelationshipModelProfile = {
  providerFamily: ProviderFamily;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number | undefined;
};

export type BridgeUnitForCharacter = {
  bridgeUnitId: Uuid7;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker?: string | undefined;
  /**
   * Addressees the bridge layer recorded for this unit (e.g. observed
   * recipient targets). The agent does NOT invent addressees — it consumes
   * what the bridge layer supplied. Optional so units without addressee
   * tracking still flow through.
   */
  addressees?: ReadonlyArray<string> | undefined;
};

export type CuratedCharacterRef = {
  characterId: string;
  displayName?: string | undefined;
};

export type PriorCharacterPackRef = {
  bios: ReadonlyArray<{ characterId: string; bioText: string }>;
  relationships: ReadonlyArray<{
    fromCharacterId: string;
    toCharacterId: string;
    kind: CharacterRelationshipKind;
    descriptor: string;
  }>;
  promptTemplateVersion: string;
};

export type CharacterRelationshipInput = {
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  sourceLocale: Bcp47Locale;
  units: ReadonlyArray<BridgeUnitForCharacter>;
  curatedCharacters: ReadonlyArray<CuratedCharacterRef>;
  glossaryExcerpt: ReadonlyArray<GlossaryRef>;
  priorPack?: PriorCharacterPackRef | undefined;
  modelProfile: CharacterRelationshipModelProfile;
  /** Test seam — deterministic clock for generatedAt. */
  now?: (() => Date) | undefined;
  /** Override the prompt template version for tests. */
  promptTemplateVersion?: string | undefined;
};

export type CharacterBio = {
  id: Uuid7;
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  characterId: string;
  bioLocale: Bcp47Locale;
  bioText: string;
  citedUnitIds: Uuid7[];
  citedUnitHashes: string[];
  modelProfile: CharacterRelationshipModelProfile;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;
  generatedAt: string;
  status: CharacterRelationshipStatus;
  invalidatedAt?: string;
  invalidatedReason?: CharacterRelationshipInvalidatedReason;
};

export type CharacterRelationship = {
  id: Uuid7;
  projectId: Uuid7;
  localeBranchId: Uuid7;
  sourceRevisionId: Uuid7;
  fromCharacterId: string;
  toCharacterId: string;
  kind: CharacterRelationshipKind;
  direction: CharacterRelationshipDirection;
  descriptor: string;
  descriptorLocale: Bcp47Locale;
  citedUnitIds: Uuid7[];
  citedUnitHashes: string[];
  modelProfile: CharacterRelationshipModelProfile;
  promptTemplateVersion: string;
  promptHash: string;
  generatedAt: string;
  status: CharacterRelationshipStatus;
  invalidatedAt?: string;
  invalidatedReason?: CharacterRelationshipInvalidatedReason;
};

export type CharacterRelationshipOutput = {
  bios: CharacterBio[];
  relationships: CharacterRelationship[];
  providerRun: ProviderRunRecord;
};

/**
 * The structured pack the agent's prompt instructs the provider to emit.
 * Parsed from the provider's content; validated against the character
 * roster + kind enum before record construction.
 */
export type ProviderEmittedPack = {
  bios: Array<{
    characterId: string;
    bioText: string;
    citedUnitIds: string[];
  }>;
  relationships: Array<{
    fromCharacterId: string;
    toCharacterId: string;
    kind: CharacterRelationshipKind;
    direction: CharacterRelationshipDirection;
    descriptor: string;
    citedUnitIds: string[];
  }>;
};

export class CharacterRelationshipLocaleMismatchError extends Error {
  constructor(
    public readonly expectedSourceLocale: Bcp47Locale,
    public readonly providedLocale: Bcp47Locale,
  ) {
    super(
      `character-relationship agent refused: expected sourceLocale ${expectedSourceLocale}, got ${providedLocale}`,
    );
    this.name = "CharacterRelationshipLocaleMismatchError";
  }
}

export class CharacterRelationshipEmptyInputError extends Error {
  constructor(public readonly projectId: string) {
    super(
      `character-relationship agent refused: project ${projectId} has no character-bearing units`,
    );
    this.name = "CharacterRelationshipEmptyInputError";
  }
}

export class CharacterRelationshipUncitedEdgeError extends Error {
  constructor(
    public readonly fromCharacterId: string,
    public readonly toCharacterId: string,
    public readonly kind: CharacterRelationshipKind,
  ) {
    super(
      `character-relationship agent refused: edge ${fromCharacterId} -> ${toCharacterId} (${kind}) cites no bridge units`,
    );
    this.name = "CharacterRelationshipUncitedEdgeError";
  }
}

export class CharacterRelationshipUnknownCharacterError extends Error {
  constructor(
    public readonly characterId: string,
    public readonly context: "bio" | "relationship-from" | "relationship-to",
  ) {
    super(
      `character-relationship agent refused: character ${characterId} (${context}) is not in the roster`,
    );
    this.name = "CharacterRelationshipUnknownCharacterError";
  }
}

export class CharacterRelationshipUnknownCitationError extends Error {
  constructor(
    public readonly bridgeUnitId: string,
    public readonly context: string,
  ) {
    super(
      `character-relationship agent refused: cited bridge unit ${bridgeUnitId} (${context}) is not in input.units`,
    );
    this.name = "CharacterRelationshipUnknownCitationError";
  }
}

export class CharacterRelationshipInvalidKindError extends Error {
  constructor(public readonly observed: string) {
    super(
      `character-relationship agent refused: kind ${observed} is not in the closed enum ${CHARACTER_RELATIONSHIP_KINDS.join(",")}`,
    );
    this.name = "CharacterRelationshipInvalidKindError";
  }
}

export class CharacterRelationshipParseError extends Error {
  constructor(public readonly reason: string) {
    super(`character-relationship agent refused: provider output could not be parsed (${reason})`);
    this.name = "CharacterRelationshipParseError";
  }
}
