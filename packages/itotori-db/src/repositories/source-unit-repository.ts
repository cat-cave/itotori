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

/** A safe, addressable scene coordinate declared by an imported bridge unit.
 *
 * `sceneId` is copied from `context.route.sceneId` or `sceneKey`; it is never
 * parsed from a source-unit key or otherwise inferred.  A unit without either
 * coordinate is deliberately absent from this projection.
 */
export type ImportedSceneTarget = {
  bridgeUnitId: string;
  sceneId: string;
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

export type LoadImportedSceneTargetsInput = LoadSourceUnitsForScopeInput & {
  bridgeUnitIds: readonly string[];
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
  /** Resolve only imported units in this project/branch to their declared
   * scene coordinates. Missing / non-scene-addressable units return no row. */
  loadImportedSceneTargets(
    actor: AuthorizationActor,
    input: LoadImportedSceneTargetsInput,
  ): Promise<ImportedSceneTarget[]>;
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

  async loadImportedSceneTargets(
    actor: AuthorizationActor,
    input: LoadImportedSceneTargetsInput,
  ): Promise<ImportedSceneTarget[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    if (input.bridgeUnitIds.length === 0) return [];
    const rows = await this.db
      .select({
        bridgeUnitId: sourceUnits.bridgeUnitId,
        context: sourceUnits.context,
      })
      .from(sourceUnits)
      .innerJoin(localeBranches, eq(localeBranches.sourceBundleId, sourceUnits.sourceBundleId))
      .where(
        and(
          eq(sourceUnits.projectId, input.projectId),
          eq(localeBranches.localeBranchId, input.localeBranchId),
          inArray(sourceUnits.bridgeUnitId, [...input.bridgeUnitIds]),
          isNull(sourceUnits.removedAt),
        ),
      );
    return rows.flatMap((row) => {
      const sceneId = declaredSceneId(row.context);
      return sceneId === null ? [] : [{ bridgeUnitId: row.bridgeUnitId, sceneId }];
    });
  }
}

/** Read the producer-declared route coordinate without exposing the full bridge
 * context (which can contain source text-adjacent metadata) to the dashboard. */
function declaredSceneId(context: unknown): string | null {
  if (typeof context !== "object" || context === null) return null;
  const route = (context as { route?: unknown }).route;
  if (typeof route !== "object" || route === null) return null;
  const candidate =
    (route as { sceneId?: unknown; sceneKey?: unknown }).sceneId ??
    (route as { sceneKey?: unknown }).sceneKey;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}
