import { createUuid7 } from "@itotori/db";
import { estimateTokens } from "../../batch-planner/token-estimator.js";
import type {
  ModelInvocationRequest,
  ModelMessage,
  ModelProvider,
  ProviderRunRecord,
} from "../../providers/types.js";
import { buildPrompt, PROMPT_TEMPLATE_VERSION_V1, promptHash } from "./prompt-template.js";
import {
  CHARACTER_RELATIONSHIP_DIRECTIONS,
  CHARACTER_RELATIONSHIP_KINDS,
  CharacterRelationshipEmptyInputError,
  CharacterRelationshipInvalidKindError,
  CharacterRelationshipLocaleMismatchError,
  CharacterRelationshipParseError,
  CharacterRelationshipUncitedEdgeError,
  CharacterRelationshipUnknownCharacterError,
  CharacterRelationshipUnknownCitationError,
  type CharacterBio,
  type CharacterRelationship,
  type CharacterRelationshipDirection,
  type CharacterRelationshipInput,
  type CharacterRelationshipKind,
  type CharacterRelationshipOutput,
  type ProviderEmittedPack,
} from "./shapes.js";

export type GenerateCharacterRelationshipsOptions = {
  provider: ModelProvider;
};

/**
 * Headline entry point: produces a character bio + relationship pack for
 * one (project, locale branch, source revision) tuple. Pure of side
 * effects except for the provider invocation; persistence lives in
 * persistence.ts.
 */
export async function generateCharacterRelationships(
  input: CharacterRelationshipInput,
  options: GenerateCharacterRelationshipsOptions,
): Promise<CharacterRelationshipOutput> {
  // 1. Source locale must be non-empty. We accept only the project's source
  //    locale here — a target locale would silently produce a target-language
  //    bio (defends the "target-language drift" audit-focus item).
  if (!input.sourceLocale || input.sourceLocale.trim().length === 0) {
    throw new CharacterRelationshipLocaleMismatchError(
      "<project sourceLocale>",
      input.sourceLocale ?? "",
    );
  }

  // 2. Non-empty input. Require at least one unit with a speaker or
  //    addressee so the agent has at least one character to anchor on.
  if (input.units.length === 0) {
    throw new CharacterRelationshipEmptyInputError(input.projectId);
  }
  const hasCharacterBearingUnit = input.units.some(
    (unit) =>
      (unit.speaker && unit.speaker.trim().length > 0) ||
      (unit.addressees && unit.addressees.length > 0),
  );
  if (!hasCharacterBearingUnit && input.curatedCharacters.length === 0) {
    throw new CharacterRelationshipEmptyInputError(input.projectId);
  }

  // 3. Compute roster: union of curated character ids + every observed
  //    speaker + every observed addressee. Sorted for determinism.
  const roster = computeRoster(input);

  // 4. Build prompt (canonicalisation happens inside buildPrompt).
  const templateVersion = input.promptTemplateVersion ?? PROMPT_TEMPLATE_VERSION_V1;
  const rendered = buildPrompt(input);
  const hash = promptHash(rendered);

  const messages: ModelMessage[] = [
    { role: "system", content: rendered.systemText },
    { role: "user", content: rendered.userText },
  ];
  const request: ModelInvocationRequest = {
    taskKind: "experiment",
    modelId: input.modelProfile.modelId,
    inputClassification: "private_corpus",
    messages,
    prompt: {
      presetId: "itotori-character-relationship",
      templateVersion,
      promptHash: `sha256:${hash}`,
    },
    generation:
      input.modelProfile.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.modelProfile.maxOutputTokens },
  };

  // 5. Invoke provider. The capability-guard runs inside the provider's
  //    invoke(); this method does NOT construct a provider on its own.
  const invocation = await options.provider.invoke(request);
  const providerRun: ProviderRunRecord = invocation.providerRun;

  // 6. Parse provider output as the structured pack.
  const pack = parseProviderPack(invocation.content ?? "");

  // 7. Validate the pack and project into the persisted record shape.
  const sourceHashByUnitId = new Map<string, string>();
  const validUnitIds = new Set<string>();
  for (const unit of input.units) {
    sourceHashByUnitId.set(unit.bridgeUnitId, unit.sourceHash);
    validUnitIds.add(unit.bridgeUnitId);
  }

  const now = (input.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();
  const inputTokenEstimate = estimateTokens(`${rendered.systemText}\n${rendered.userText}`);
  const completionTokens =
    providerRun.tokenUsage.completionTokens ?? estimateTokens(invocation.content ?? "");

  const bios: CharacterBio[] = [];
  for (const emitted of pack.bios) {
    if (!roster.has(emitted.characterId)) {
      throw new CharacterRelationshipUnknownCharacterError(emitted.characterId, "bio");
    }
    if (emitted.citedUnitIds.length === 0) {
      // An empty bio citation list is structurally indistinguishable from
      // a relationship's uncited-edge case; we surface the dedicated edge
      // error variant only for relationships, and reuse the same "no
      // citations" reject pathway for bios via the unknown-citation
      // surface (an empty list cannot identify any unit).
      throw new CharacterRelationshipUnknownCitationError(
        "<no citation>",
        `bio for ${emitted.characterId}`,
      );
    }
    const citedUnitIds: string[] = [];
    const citedUnitHashes: string[] = [];
    for (const id of emitted.citedUnitIds) {
      if (!validUnitIds.has(id)) {
        throw new CharacterRelationshipUnknownCitationError(id, `bio for ${emitted.characterId}`);
      }
      const hashValue = sourceHashByUnitId.get(id);
      if (!hashValue) {
        throw new CharacterRelationshipUnknownCitationError(
          id,
          `bio for ${emitted.characterId} (no source hash)`,
        );
      }
      citedUnitIds.push(id);
      citedUnitHashes.push(hashValue);
    }
    bios.push({
      id: createUuid7(),
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      characterId: emitted.characterId,
      bioLocale: input.sourceLocale,
      bioText: emitted.bioText,
      citedUnitIds,
      citedUnitHashes,
      modelProfile: input.modelProfile,
      promptTemplateVersion: templateVersion,
      promptHash: hash,
      inputTokenEstimate,
      completionTokens,
      generatedAt,
      status: "Fresh",
    });
  }

  const relationships: CharacterRelationship[] = [];
  for (const emitted of pack.relationships) {
    if (!roster.has(emitted.fromCharacterId)) {
      throw new CharacterRelationshipUnknownCharacterError(
        emitted.fromCharacterId,
        "relationship-from",
      );
    }
    if (!roster.has(emitted.toCharacterId)) {
      throw new CharacterRelationshipUnknownCharacterError(
        emitted.toCharacterId,
        "relationship-to",
      );
    }
    if (!isValidKind(emitted.kind)) {
      throw new CharacterRelationshipInvalidKindError(emitted.kind);
    }
    if (!isValidDirection(emitted.direction)) {
      throw new CharacterRelationshipInvalidKindError(emitted.direction);
    }
    if (emitted.citedUnitIds.length === 0) {
      throw new CharacterRelationshipUncitedEdgeError(
        emitted.fromCharacterId,
        emitted.toCharacterId,
        emitted.kind,
      );
    }
    const citedUnitIds: string[] = [];
    const citedUnitHashes: string[] = [];
    for (const id of emitted.citedUnitIds) {
      if (!validUnitIds.has(id)) {
        throw new CharacterRelationshipUnknownCitationError(
          id,
          `relationship ${emitted.fromCharacterId}->${emitted.toCharacterId}`,
        );
      }
      const hashValue = sourceHashByUnitId.get(id);
      if (!hashValue) {
        throw new CharacterRelationshipUnknownCitationError(
          id,
          `relationship ${emitted.fromCharacterId}->${emitted.toCharacterId} (no source hash)`,
        );
      }
      citedUnitIds.push(id);
      citedUnitHashes.push(hashValue);
    }
    relationships.push({
      id: createUuid7(),
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      fromCharacterId: emitted.fromCharacterId,
      toCharacterId: emitted.toCharacterId,
      kind: emitted.kind,
      direction: emitted.direction,
      descriptor: emitted.descriptor,
      descriptorLocale: input.sourceLocale,
      citedUnitIds,
      citedUnitHashes,
      modelProfile: input.modelProfile,
      promptTemplateVersion: templateVersion,
      promptHash: hash,
      generatedAt,
      status: "Fresh",
    });
  }

  return { bios, relationships, providerRun };
}

/**
 * Batch entry point used by the CLI. Sequences agent calls one at a time;
 * provider concurrency is the provider's concern.
 */
export async function generateCharacterRelationshipsBatch(
  inputs: ReadonlyArray<CharacterRelationshipInput>,
  options: GenerateCharacterRelationshipsOptions,
): Promise<CharacterRelationshipOutput[]> {
  const results: CharacterRelationshipOutput[] = [];
  for (const input of inputs) {
    const output = await generateCharacterRelationships(input, options);
    results.push(output);
  }
  return results;
}

/**
 * Compute the closed roster of character ids the agent may emit records
 * for. The union of curator-promoted ids + every observed speaker + every
 * observed addressee. Any character id outside this set is rejected.
 */
export function computeRoster(input: CharacterRelationshipInput): Set<string> {
  const roster = new Set<string>();
  for (const ref of input.curatedCharacters) {
    if (ref.characterId.trim().length > 0) {
      roster.add(ref.characterId);
    }
  }
  for (const unit of input.units) {
    if (unit.speaker && unit.speaker.trim().length > 0) {
      roster.add(unit.speaker);
    }
    if (unit.addressees) {
      for (const addressee of unit.addressees) {
        if (addressee.trim().length > 0) {
          roster.add(addressee);
        }
      }
    }
  }
  return roster;
}

function parseProviderPack(content: string): ProviderEmittedPack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new CharacterRelationshipParseError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CharacterRelationshipParseError("output is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const biosRaw = Array.isArray(record.bios) ? record.bios : null;
  const relationshipsRaw = Array.isArray(record.relationships) ? record.relationships : null;
  if (biosRaw === null) {
    throw new CharacterRelationshipParseError("output.bios is not an array");
  }
  if (relationshipsRaw === null) {
    throw new CharacterRelationshipParseError("output.relationships is not an array");
  }
  const bios: ProviderEmittedPack["bios"] = [];
  for (const entry of biosRaw) {
    if (typeof entry !== "object" || entry === null) {
      throw new CharacterRelationshipParseError("output.bios entry not an object");
    }
    const row = entry as Record<string, unknown>;
    const characterId = typeof row.characterId === "string" ? row.characterId : null;
    const bioText = typeof row.bioText === "string" ? row.bioText : null;
    const citedUnitIds = Array.isArray(row.citedUnitIds)
      ? row.citedUnitIds.filter((id): id is string => typeof id === "string")
      : null;
    if (characterId === null || bioText === null || citedUnitIds === null) {
      throw new CharacterRelationshipParseError("output.bios entry missing required field");
    }
    bios.push({ characterId, bioText, citedUnitIds });
  }
  const relationships: ProviderEmittedPack["relationships"] = [];
  for (const entry of relationshipsRaw) {
    if (typeof entry !== "object" || entry === null) {
      throw new CharacterRelationshipParseError("output.relationships entry not an object");
    }
    const row = entry as Record<string, unknown>;
    const fromCharacterId = typeof row.fromCharacterId === "string" ? row.fromCharacterId : null;
    const toCharacterId = typeof row.toCharacterId === "string" ? row.toCharacterId : null;
    const kindRaw = typeof row.kind === "string" ? row.kind : null;
    const directionRaw = typeof row.direction === "string" ? row.direction : null;
    const descriptor = typeof row.descriptor === "string" ? row.descriptor : null;
    const citedUnitIds = Array.isArray(row.citedUnitIds)
      ? row.citedUnitIds.filter((id): id is string => typeof id === "string")
      : null;
    if (
      fromCharacterId === null ||
      toCharacterId === null ||
      kindRaw === null ||
      directionRaw === null ||
      descriptor === null ||
      citedUnitIds === null
    ) {
      throw new CharacterRelationshipParseError(
        "output.relationships entry missing required field",
      );
    }
    if (!isValidKind(kindRaw)) {
      throw new CharacterRelationshipInvalidKindError(kindRaw);
    }
    if (!isValidDirection(directionRaw)) {
      throw new CharacterRelationshipInvalidKindError(directionRaw);
    }
    relationships.push({
      fromCharacterId,
      toCharacterId,
      kind: kindRaw,
      direction: directionRaw,
      descriptor,
      citedUnitIds,
    });
  }
  return { bios, relationships };
}

function isValidKind(value: string): value is CharacterRelationshipKind {
  return (CHARACTER_RELATIONSHIP_KINDS as ReadonlyArray<string>).includes(value);
}

function isValidDirection(value: string): value is CharacterRelationshipDirection {
  return (CHARACTER_RELATIONSHIP_DIRECTIONS as ReadonlyArray<string>).includes(value);
}
