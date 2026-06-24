export {
  computeRoster,
  generateCharacterRelationships,
  generateCharacterRelationshipsBatch,
  type GenerateCharacterRelationshipsOptions,
} from "./agent.js";
export {
  buildPrompt,
  canonicalizeUnits,
  PROMPT_TEMPLATE_VERSION_V1,
  promptHash,
  type RenderedPrompt,
} from "./prompt-template.js";
export {
  bioToSaveInput,
  persistCharacterBio,
  persistCharacterRelationship,
  recordToBio,
  recordToRelationship,
  relationshipToSaveInput,
} from "./persistence.js";
export {
  markStaleCharacterArtifactsForRevision,
  type CharacterBioDrift,
  type CharacterRelationshipDrift,
  type CharacterStalenessScanInput,
  type CharacterStalenessScanResult,
} from "./staleness.js";
export {
  resolveCharacterRelationshipProvider,
  runCheckCharacterRelationshipsCli,
  runGenerateCharacterRelationshipsCli,
  type CharacterRelationshipCliDependencies,
  type CheckCharacterRelationshipsCliInput,
  type GenerateCharacterRelationshipsCliInput,
  type GenerateCharacterRelationshipsCliResult,
} from "./cli.js";
export {
  CHARACTER_RELATIONSHIP_DIRECTIONS,
  CHARACTER_RELATIONSHIP_KINDS,
  CharacterRelationshipEmptyInputError,
  CharacterRelationshipInvalidKindError,
  CharacterRelationshipLocaleMismatchError,
  CharacterRelationshipParseError,
  CharacterRelationshipUncitedEdgeError,
  CharacterRelationshipUnknownCharacterError,
  CharacterRelationshipUnknownCitationError,
  type BridgeUnitForCharacter,
  type CharacterBio,
  type CharacterRelationship,
  type CharacterRelationshipDirection,
  type CharacterRelationshipInput,
  type CharacterRelationshipInvalidatedReason,
  type CharacterRelationshipKind,
  type CharacterRelationshipModelProfile,
  type CharacterRelationshipOutput,
  type CharacterRelationshipStatus,
  type CuratedCharacterRef,
  type PriorCharacterPackRef,
  type ProviderEmittedPack,
} from "./shapes.js";
