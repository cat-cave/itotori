// Shared source-unit read port.
//
// Semantic context artifacts cite canonical source units, but source-unit
// hydration is not a semantic-agent store. Keeping this narrow repository
// separate prevents scene-summary (or any other enrichment) from becoming a
// hidden parallel persistence dependency.

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import { localeBranches, sourceUnits } from "../schema.js";

export type SourceUnitTextRecord = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  sourceText: string;
  sourceHash: string;
  speaker: string | null;
  occurrenceId: string;
};

export type LoadSourceUnitsInput = {
  bridgeUnitIds: string[];
};

export type LoadCurrentSourceHashesInput = {
  bridgeUnitIds: string[];
};

export type LoadSourceUnitsForScopeInput = {
  projectId: string;
  localeBranchId: string;
};

export interface ItotoriSourceUnitRepositoryPort {
  loadSourceUnits(
    actor: AuthorizationActor,
    input: LoadSourceUnitsInput,
  ): Promise<Map<string, SourceUnitTextRecord>>;
  currentSourceHashes(
    actor: AuthorizationActor,
    input: LoadCurrentSourceHashesInput,
  ): Promise<Map<string, string>>;
  loadSourceUnitsForScope(
    actor: AuthorizationActor,
    input: LoadSourceUnitsForScopeInput,
  ): Promise<SourceUnitTextRecord[]>;
}

export class ItotoriSourceUnitRepository implements ItotoriSourceUnitRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async loadSourceUnits(
    actor: AuthorizationActor,
    input: LoadSourceUnitsInput,
  ): Promise<Map<string, SourceUnitTextRecord>> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const result = new Map<string, SourceUnitTextRecord>();
    if (input.bridgeUnitIds.length === 0) {
      return result;
    }
    const rows = await this.db
      .select({
        bridgeUnitId: sourceUnits.bridgeUnitId,
        sourceUnitKey: sourceUnits.sourceUnitKey,
        sourceText: sourceUnits.sourceText,
        sourceHash: sourceUnits.sourceHash,
        speaker: sourceUnits.speaker,
        occurrenceId: sourceUnits.occurrenceId,
      })
      .from(sourceUnits)
      .where(
        and(inArray(sourceUnits.bridgeUnitId, input.bridgeUnitIds), isNull(sourceUnits.removedAt)),
      );
    for (const row of rows) {
      result.set(row.bridgeUnitId, {
        bridgeUnitId: row.bridgeUnitId,
        sourceUnitKey: row.sourceUnitKey,
        sourceText: row.sourceText,
        sourceHash: row.sourceHash,
        speaker: typeof row.speaker === "string" ? row.speaker : null,
        occurrenceId: row.occurrenceId,
      });
    }
    return result;
  }

  async currentSourceHashes(
    actor: AuthorizationActor,
    input: LoadCurrentSourceHashesInput,
  ): Promise<Map<string, string>> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const result = new Map<string, string>();
    if (input.bridgeUnitIds.length === 0) {
      return result;
    }
    const rows = await this.db
      .select({ bridgeUnitId: sourceUnits.bridgeUnitId, sourceHash: sourceUnits.sourceHash })
      .from(sourceUnits)
      .where(
        and(inArray(sourceUnits.bridgeUnitId, input.bridgeUnitIds), isNull(sourceUnits.removedAt)),
      );
    for (const row of rows) {
      result.set(row.bridgeUnitId, row.sourceHash);
    }
    return result;
  }

  async loadSourceUnitsForScope(
    actor: AuthorizationActor,
    input: LoadSourceUnitsForScopeInput,
  ): Promise<SourceUnitTextRecord[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const rows = await this.db
      .select({
        bridgeUnitId: sourceUnits.bridgeUnitId,
        sourceUnitKey: sourceUnits.sourceUnitKey,
        sourceText: sourceUnits.sourceText,
        sourceHash: sourceUnits.sourceHash,
        speaker: sourceUnits.speaker,
        occurrenceId: sourceUnits.occurrenceId,
      })
      .from(sourceUnits)
      .innerJoin(localeBranches, eq(localeBranches.sourceBundleId, sourceUnits.sourceBundleId))
      .where(
        and(
          eq(sourceUnits.projectId, input.projectId),
          eq(localeBranches.localeBranchId, input.localeBranchId),
          isNull(sourceUnits.removedAt),
        ),
      )
      .orderBy(sourceUnits.sourceUnitKey);
    return rows.map((row) => ({
      bridgeUnitId: row.bridgeUnitId,
      sourceUnitKey: row.sourceUnitKey,
      sourceText: row.sourceText,
      sourceHash: row.sourceHash,
      speaker: typeof row.speaker === "string" ? row.speaker : null,
      occurrenceId: row.occurrenceId,
    }));
  }
}
