import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  characterBioEvidence,
  characterBioStatusValues,
  characterBios,
  characterRelationshipDirectionValues,
  characterRelationshipEvidence,
  characterRelationshipInvalidatedReasonValues,
  characterRelationshipKindValues,
  characterRelationshipStatusValues,
  characterRelationships,
  sourceUnits,
  type CharacterBioStatus,
  type CharacterRelationshipDirection,
  type CharacterRelationshipInvalidatedReason,
  type CharacterRelationshipKind,
  type CharacterRelationshipStatus,
} from "../schema.js";

/**
 * Closed-enum lists exposed for callers (CLI, agent) that want to enforce
 * the same set on their side without re-deriving it from the constant
 * objects.
 */
export const characterRelationshipKindList: ReadonlyArray<CharacterRelationshipKind> = [
  characterRelationshipKindValues.familyRelation,
  characterRelationshipKindValues.romantic,
  characterRelationshipKindValues.friendship,
  characterRelationshipKindValues.mentor,
  characterRelationshipKindValues.rivalry,
  characterRelationshipKindValues.allegiance,
  characterRelationshipKindValues.antagonism,
  characterRelationshipKindValues.other,
];

export const characterRelationshipDirectionList: ReadonlyArray<CharacterRelationshipDirection> = [
  characterRelationshipDirectionValues.symmetric,
  characterRelationshipDirectionValues.fromAToB,
];

export type CharacterCitationRecord = {
  bridgeUnitId: string;
  citedSourceHash: string;
  citeOrdinal: number;
};

export type CharacterBioRecord = {
  characterBioId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  characterId: string;
  bioLocale: string;
  bioText: string;
  modelProviderFamily: string;
  modelId: string;
  modelContextWindowTokens: number;
  modelMaxOutputTokens: number | null;
  promptTemplateVersion: string;
  promptHash: string;
  inputTokenEstimate: number;
  completionTokens: number;
  status: CharacterBioStatus;
  invalidatedAt: Date | null;
  invalidatedReason: CharacterRelationshipInvalidatedReason | null;
  generatedAt: Date;
  createdAt: Date;
  citations: CharacterCitationRecord[];
};

export type CharacterRelationshipRecord = {
  characterRelationshipId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  fromCharacterId: string;
  toCharacterId: string;
  kind: CharacterRelationshipKind;
  direction: CharacterRelationshipDirection;
  descriptor: string;
  descriptorLocale: string;
  modelProviderFamily: string;
  modelId: string;
  modelContextWindowTokens: number;
  modelMaxOutputTokens: number | null;
  promptTemplateVersion: string;
  promptHash: string;
  status: CharacterRelationshipStatus;
  invalidatedAt: Date | null;
  invalidatedReason: CharacterRelationshipInvalidatedReason | null;
  generatedAt: Date;
  createdAt: Date;
  citations: CharacterCitationRecord[];
};

export type SaveCharacterBioInput = Omit<
  CharacterBioRecord,
  "status" | "invalidatedAt" | "invalidatedReason" | "createdAt"
>;

export type SaveCharacterRelationshipInput = Omit<
  CharacterRelationshipRecord,
  "status" | "invalidatedAt" | "invalidatedReason" | "createdAt"
>;

export type LoadCharacterBiosQuery = {
  projectId: string;
  localeBranchId?: string;
  sourceRevisionId?: string;
  characterId?: string;
  status?: CharacterBioStatus;
  promptTemplateVersion?: string;
};

export type LoadCharacterRelationshipsQuery = {
  projectId: string;
  localeBranchId?: string;
  sourceRevisionId?: string;
  status?: CharacterRelationshipStatus;
  promptTemplateVersion?: string;
};

export type LoadCharacterBioByCharacter = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  characterId: string;
  promptTemplateVersion?: string;
};

export type MarkCharacterBioStaleInput = {
  characterBioId: string;
  reason: CharacterRelationshipInvalidatedReason;
  invalidatedAt?: Date;
};

export type MarkCharacterRelationshipStaleInput = {
  characterRelationshipId: string;
  reason: CharacterRelationshipInvalidatedReason;
  invalidatedAt?: Date;
};

export type LoadCurrentSourceHashesInput = {
  bridgeUnitIds: string[];
};

export interface ItotoriCharacterRelationshipRepositoryPort {
  saveBio(actor: AuthorizationActor, input: SaveCharacterBioInput): Promise<CharacterBioRecord>;
  saveRelationship(
    actor: AuthorizationActor,
    input: SaveCharacterRelationshipInput,
  ): Promise<CharacterRelationshipRecord>;
  loadBioByCharacter(
    actor: AuthorizationActor,
    query: LoadCharacterBioByCharacter,
  ): Promise<CharacterBioRecord | null>;
  loadBios(actor: AuthorizationActor, query: LoadCharacterBiosQuery): Promise<CharacterBioRecord[]>;
  loadRelationshipsByProject(
    actor: AuthorizationActor,
    query: LoadCharacterRelationshipsQuery,
  ): Promise<CharacterRelationshipRecord[]>;
  markBioStale(actor: AuthorizationActor, input: MarkCharacterBioStaleInput): Promise<void>;
  markRelationshipStale(
    actor: AuthorizationActor,
    input: MarkCharacterRelationshipStaleInput,
  ): Promise<void>;
  currentSourceHashesForBridgeUnits(
    actor: AuthorizationActor,
    input: LoadCurrentSourceHashesInput,
  ): Promise<Map<string, string>>;
}

export class ItotoriCharacterRelationshipRepository implements ItotoriCharacterRelationshipRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async saveBio(
    actor: AuthorizationActor,
    input: SaveCharacterBioInput,
  ): Promise<CharacterBioRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    if (input.citations.length === 0) {
      throw new Error(`character bio ${input.characterBioId} must cite at least one bridge unit`);
    }
    assertOrdinalsUnique(input.citations, `character bio ${input.characterBioId}`);

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ characterBioId: characterBios.characterBioId })
        .from(characterBios)
        .where(
          and(
            eq(characterBios.projectId, input.projectId),
            eq(characterBios.localeBranchId, input.localeBranchId),
            eq(characterBios.sourceRevisionId, input.sourceRevisionId),
            eq(characterBios.characterId, input.characterId),
            eq(characterBios.promptTemplateVersion, input.promptTemplateVersion),
          ),
        );
      if (existing.length > 0) {
        const ids = existing.map((row) => row.characterBioId);
        await tx
          .delete(characterBioEvidence)
          .where(inArray(characterBioEvidence.characterBioId, ids));
        await tx.delete(characterBios).where(inArray(characterBios.characterBioId, ids));
      }

      await tx.insert(characterBios).values({
        characterBioId: input.characterBioId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        characterId: input.characterId,
        bioLocale: input.bioLocale,
        bioText: input.bioText,
        modelProviderFamily: input.modelProviderFamily,
        modelId: input.modelId,
        modelContextWindowTokens: input.modelContextWindowTokens,
        modelMaxOutputTokens: input.modelMaxOutputTokens,
        promptTemplateVersion: input.promptTemplateVersion,
        promptHash: input.promptHash,
        inputTokenEstimate: input.inputTokenEstimate,
        completionTokens: input.completionTokens,
        status: characterBioStatusValues.fresh,
        invalidatedAt: null,
        invalidatedReason: null,
        generatedAt: input.generatedAt,
      });

      await tx.insert(characterBioEvidence).values(
        input.citations.map((citation) => ({
          characterBioId: input.characterBioId,
          bridgeUnitId: citation.bridgeUnitId,
          citedSourceHash: citation.citedSourceHash,
          citeOrdinal: citation.citeOrdinal,
        })),
      );
    });

    const saved = await this.fetchBioById(input.characterBioId);
    if (!saved) {
      throw new Error(`failed to load saved character bio ${input.characterBioId}`);
    }
    return saved;
  }

  async saveRelationship(
    actor: AuthorizationActor,
    input: SaveCharacterRelationshipInput,
  ): Promise<CharacterRelationshipRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    if (input.citations.length === 0) {
      throw new Error(
        `character relationship ${input.characterRelationshipId} must cite at least one bridge unit`,
      );
    }
    assertOrdinalsUnique(
      input.citations,
      `character relationship ${input.characterRelationshipId}`,
    );

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ characterRelationshipId: characterRelationships.characterRelationshipId })
        .from(characterRelationships)
        .where(
          and(
            eq(characterRelationships.projectId, input.projectId),
            eq(characterRelationships.localeBranchId, input.localeBranchId),
            eq(characterRelationships.sourceRevisionId, input.sourceRevisionId),
            eq(characterRelationships.fromCharacterId, input.fromCharacterId),
            eq(characterRelationships.toCharacterId, input.toCharacterId),
            eq(characterRelationships.kind, input.kind),
            eq(characterRelationships.promptTemplateVersion, input.promptTemplateVersion),
          ),
        );
      if (existing.length > 0) {
        const ids = existing.map((row) => row.characterRelationshipId);
        await tx
          .delete(characterRelationshipEvidence)
          .where(inArray(characterRelationshipEvidence.characterRelationshipId, ids));
        await tx
          .delete(characterRelationships)
          .where(inArray(characterRelationships.characterRelationshipId, ids));
      }

      await tx.insert(characterRelationships).values({
        characterRelationshipId: input.characterRelationshipId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sourceRevisionId: input.sourceRevisionId,
        fromCharacterId: input.fromCharacterId,
        toCharacterId: input.toCharacterId,
        kind: input.kind,
        direction: input.direction,
        descriptor: input.descriptor,
        descriptorLocale: input.descriptorLocale,
        modelProviderFamily: input.modelProviderFamily,
        modelId: input.modelId,
        modelContextWindowTokens: input.modelContextWindowTokens,
        modelMaxOutputTokens: input.modelMaxOutputTokens,
        promptTemplateVersion: input.promptTemplateVersion,
        promptHash: input.promptHash,
        status: characterRelationshipStatusValues.fresh,
        invalidatedAt: null,
        invalidatedReason: null,
        generatedAt: input.generatedAt,
      });

      await tx.insert(characterRelationshipEvidence).values(
        input.citations.map((citation) => ({
          characterRelationshipId: input.characterRelationshipId,
          bridgeUnitId: citation.bridgeUnitId,
          citedSourceHash: citation.citedSourceHash,
          citeOrdinal: citation.citeOrdinal,
        })),
      );
    });

    const saved = await this.fetchRelationshipById(input.characterRelationshipId);
    if (!saved) {
      throw new Error(
        `failed to load saved character relationship ${input.characterRelationshipId}`,
      );
    }
    return saved;
  }

  async loadBioByCharacter(
    actor: AuthorizationActor,
    query: LoadCharacterBioByCharacter,
  ): Promise<CharacterBioRecord | null> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [
      eq(characterBios.projectId, query.projectId),
      eq(characterBios.localeBranchId, query.localeBranchId),
      eq(characterBios.sourceRevisionId, query.sourceRevisionId),
      eq(characterBios.characterId, query.characterId),
    ];
    if (query.promptTemplateVersion !== undefined) {
      conditions.push(eq(characterBios.promptTemplateVersion, query.promptTemplateVersion));
    }

    const freshConditions = [
      ...conditions,
      eq(characterBios.status, characterBioStatusValues.fresh),
    ];
    const freshRows = await this.db
      .select()
      .from(characterBios)
      .where(and(...freshConditions))
      .orderBy(desc(characterBios.generatedAt))
      .limit(1);
    if (freshRows[0]) {
      return await this.hydrateBio(freshRows[0]);
    }
    const anyRows = await this.db
      .select()
      .from(characterBios)
      .where(and(...conditions))
      .orderBy(desc(characterBios.generatedAt))
      .limit(1);
    if (!anyRows[0]) {
      return null;
    }
    return await this.hydrateBio(anyRows[0]);
  }

  async loadBios(
    actor: AuthorizationActor,
    query: LoadCharacterBiosQuery,
  ): Promise<CharacterBioRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [eq(characterBios.projectId, query.projectId)];
    if (query.localeBranchId !== undefined) {
      conditions.push(eq(characterBios.localeBranchId, query.localeBranchId));
    }
    if (query.sourceRevisionId !== undefined) {
      conditions.push(eq(characterBios.sourceRevisionId, query.sourceRevisionId));
    }
    if (query.characterId !== undefined) {
      conditions.push(eq(characterBios.characterId, query.characterId));
    }
    if (query.status !== undefined) {
      conditions.push(eq(characterBios.status, query.status));
    }
    if (query.promptTemplateVersion !== undefined) {
      conditions.push(eq(characterBios.promptTemplateVersion, query.promptTemplateVersion));
    }

    const rows = await this.db
      .select()
      .from(characterBios)
      .where(and(...conditions))
      .orderBy(
        asc(characterBios.projectId),
        asc(characterBios.localeBranchId),
        asc(characterBios.sourceRevisionId),
        asc(characterBios.characterId),
        desc(characterBios.generatedAt),
      );
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.characterBioId);
    const evidenceRows = await this.db
      .select()
      .from(characterBioEvidence)
      .where(inArray(characterBioEvidence.characterBioId, ids))
      .orderBy(asc(characterBioEvidence.characterBioId), asc(characterBioEvidence.citeOrdinal));
    const evidenceByBio = new Map<string, CharacterCitationRecord[]>();
    for (const evidence of evidenceRows) {
      const bucket = evidenceByBio.get(evidence.characterBioId) ?? [];
      bucket.push({
        bridgeUnitId: evidence.bridgeUnitId,
        citedSourceHash: evidence.citedSourceHash,
        citeOrdinal: evidence.citeOrdinal,
      });
      evidenceByBio.set(evidence.characterBioId, bucket);
    }
    return rows.map((row) => bioRowToRecord(row, evidenceByBio.get(row.characterBioId) ?? []));
  }

  async loadRelationshipsByProject(
    actor: AuthorizationActor,
    query: LoadCharacterRelationshipsQuery,
  ): Promise<CharacterRelationshipRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const conditions = [eq(characterRelationships.projectId, query.projectId)];
    if (query.localeBranchId !== undefined) {
      conditions.push(eq(characterRelationships.localeBranchId, query.localeBranchId));
    }
    if (query.sourceRevisionId !== undefined) {
      conditions.push(eq(characterRelationships.sourceRevisionId, query.sourceRevisionId));
    }
    if (query.status !== undefined) {
      conditions.push(eq(characterRelationships.status, query.status));
    }
    if (query.promptTemplateVersion !== undefined) {
      conditions.push(
        eq(characterRelationships.promptTemplateVersion, query.promptTemplateVersion),
      );
    }

    const rows = await this.db
      .select()
      .from(characterRelationships)
      .where(and(...conditions))
      .orderBy(
        asc(characterRelationships.projectId),
        asc(characterRelationships.localeBranchId),
        asc(characterRelationships.sourceRevisionId),
        asc(characterRelationships.fromCharacterId),
        asc(characterRelationships.toCharacterId),
        desc(characterRelationships.generatedAt),
      );
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.characterRelationshipId);
    const evidenceRows = await this.db
      .select()
      .from(characterRelationshipEvidence)
      .where(inArray(characterRelationshipEvidence.characterRelationshipId, ids))
      .orderBy(
        asc(characterRelationshipEvidence.characterRelationshipId),
        asc(characterRelationshipEvidence.citeOrdinal),
      );
    const evidenceByRel = new Map<string, CharacterCitationRecord[]>();
    for (const evidence of evidenceRows) {
      const bucket = evidenceByRel.get(evidence.characterRelationshipId) ?? [];
      bucket.push({
        bridgeUnitId: evidence.bridgeUnitId,
        citedSourceHash: evidence.citedSourceHash,
        citeOrdinal: evidence.citeOrdinal,
      });
      evidenceByRel.set(evidence.characterRelationshipId, bucket);
    }
    return rows.map((row) =>
      relationshipRowToRecord(row, evidenceByRel.get(row.characterRelationshipId) ?? []),
    );
  }

  async markBioStale(actor: AuthorizationActor, input: MarkCharacterBioStaleInput): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    const invalidatedAt = input.invalidatedAt ?? new Date();
    await this.db
      .update(characterBios)
      .set({
        status: characterBioStatusValues.stale,
        invalidatedAt,
        invalidatedReason: input.reason,
      })
      .where(
        and(
          eq(characterBios.characterBioId, input.characterBioId),
          eq(characterBios.status, characterBioStatusValues.fresh),
        ),
      );
  }

  async markRelationshipStale(
    actor: AuthorizationActor,
    input: MarkCharacterRelationshipStaleInput,
  ): Promise<void> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);

    const invalidatedAt = input.invalidatedAt ?? new Date();
    await this.db
      .update(characterRelationships)
      .set({
        status: characterRelationshipStatusValues.stale,
        invalidatedAt,
        invalidatedReason: input.reason,
      })
      .where(
        and(
          eq(characterRelationships.characterRelationshipId, input.characterRelationshipId),
          eq(characterRelationships.status, characterRelationshipStatusValues.fresh),
        ),
      );
  }

  async currentSourceHashesForBridgeUnits(
    actor: AuthorizationActor,
    input: LoadCurrentSourceHashesInput,
  ): Promise<Map<string, string>> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);

    const result = new Map<string, string>();
    if (input.bridgeUnitIds.length === 0) {
      return result;
    }
    const rows = await this.db
      .select({
        bridgeUnitId: sourceUnits.bridgeUnitId,
        sourceHash: sourceUnits.sourceHash,
      })
      .from(sourceUnits)
      .where(inArray(sourceUnits.bridgeUnitId, input.bridgeUnitIds));
    for (const row of rows) {
      result.set(row.bridgeUnitId, row.sourceHash);
    }
    return result;
  }

  private async fetchBioById(characterBioId: string): Promise<CharacterBioRecord | null> {
    const rows = await this.db
      .select()
      .from(characterBios)
      .where(eq(characterBios.characterBioId, characterBioId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return await this.hydrateBio(row);
  }

  private async fetchRelationshipById(
    characterRelationshipId: string,
  ): Promise<CharacterRelationshipRecord | null> {
    const rows = await this.db
      .select()
      .from(characterRelationships)
      .where(eq(characterRelationships.characterRelationshipId, characterRelationshipId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return await this.hydrateRelationship(row);
  }

  private async hydrateBio(row: typeof characterBios.$inferSelect): Promise<CharacterBioRecord> {
    const evidenceRows = await this.db
      .select()
      .from(characterBioEvidence)
      .where(eq(characterBioEvidence.characterBioId, row.characterBioId))
      .orderBy(asc(characterBioEvidence.citeOrdinal));
    return bioRowToRecord(
      row,
      evidenceRows.map((evidence) => ({
        bridgeUnitId: evidence.bridgeUnitId,
        citedSourceHash: evidence.citedSourceHash,
        citeOrdinal: evidence.citeOrdinal,
      })),
    );
  }

  private async hydrateRelationship(
    row: typeof characterRelationships.$inferSelect,
  ): Promise<CharacterRelationshipRecord> {
    const evidenceRows = await this.db
      .select()
      .from(characterRelationshipEvidence)
      .where(eq(characterRelationshipEvidence.characterRelationshipId, row.characterRelationshipId))
      .orderBy(asc(characterRelationshipEvidence.citeOrdinal));
    return relationshipRowToRecord(
      row,
      evidenceRows.map((evidence) => ({
        bridgeUnitId: evidence.bridgeUnitId,
        citedSourceHash: evidence.citedSourceHash,
        citeOrdinal: evidence.citeOrdinal,
      })),
    );
  }
}

function assertOrdinalsUnique(citations: CharacterCitationRecord[], label: string): void {
  const seen = new Set<number>();
  for (const citation of citations) {
    if (seen.has(citation.citeOrdinal)) {
      throw new Error(`${label} has duplicate cite ordinal ${citation.citeOrdinal}`);
    }
    seen.add(citation.citeOrdinal);
  }
}

function bioRowToRecord(
  row: typeof characterBios.$inferSelect,
  citations: CharacterCitationRecord[],
): CharacterBioRecord {
  return {
    characterBioId: row.characterBioId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    characterId: row.characterId,
    bioLocale: row.bioLocale,
    bioText: row.bioText,
    modelProviderFamily: row.modelProviderFamily,
    modelId: row.modelId,
    modelContextWindowTokens: row.modelContextWindowTokens,
    modelMaxOutputTokens: row.modelMaxOutputTokens,
    promptTemplateVersion: row.promptTemplateVersion,
    promptHash: row.promptHash,
    inputTokenEstimate: row.inputTokenEstimate,
    completionTokens: row.completionTokens,
    status: row.status as CharacterBioStatus,
    invalidatedAt: row.invalidatedAt,
    invalidatedReason: row.invalidatedReason as CharacterRelationshipInvalidatedReason | null,
    generatedAt: row.generatedAt,
    createdAt: row.createdAt,
    citations,
  };
}

function relationshipRowToRecord(
  row: typeof characterRelationships.$inferSelect,
  citations: CharacterCitationRecord[],
): CharacterRelationshipRecord {
  return {
    characterRelationshipId: row.characterRelationshipId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sourceRevisionId: row.sourceRevisionId,
    fromCharacterId: row.fromCharacterId,
    toCharacterId: row.toCharacterId,
    kind: row.kind,
    direction: row.direction,
    descriptor: row.descriptor,
    descriptorLocale: row.descriptorLocale,
    modelProviderFamily: row.modelProviderFamily,
    modelId: row.modelId,
    modelContextWindowTokens: row.modelContextWindowTokens,
    modelMaxOutputTokens: row.modelMaxOutputTokens,
    promptTemplateVersion: row.promptTemplateVersion,
    promptHash: row.promptHash,
    status: row.status as CharacterRelationshipStatus,
    invalidatedAt: row.invalidatedAt,
    invalidatedReason: row.invalidatedReason as CharacterRelationshipInvalidatedReason | null,
    generatedAt: row.generatedAt,
    createdAt: row.createdAt,
    citations,
  };
}

export {
  characterBioStatusValues,
  characterRelationshipDirectionValues,
  characterRelationshipInvalidatedReasonValues,
  characterRelationshipKindValues,
  characterRelationshipStatusValues,
} from "../schema.js";
