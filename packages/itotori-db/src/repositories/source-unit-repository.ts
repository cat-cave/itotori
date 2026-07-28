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

/** A bridge unit resolved for a player-facing address.  The scene coordinate
 * is deliberately read only from the bridge producer's `context.route.sceneId`;
 * source-unit key syntax is opaque to this shared surface. */
export type AddressableBridgeUnit =
  | {
      bridgeUnitId: string;
      sourceUnitKey: string;
      state: "resolved";
      sceneId: string;
    }
  | {
      bridgeUnitId: string;
      state: "unresolvable";
      reason: "not_imported_in_branch" | "scene_coordinate_missing";
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
  resolveAddressableBridgeUnits(
    actor: AuthorizationActor,
    input: { projectId: string; localeBranchId: string; bridgeUnitIds: readonly string[] },
  ): Promise<AddressableBridgeUnit[]>;
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

  async resolveAddressableBridgeUnits(
    actor: AuthorizationActor,
    input: { projectId: string; localeBranchId: string; bridgeUnitIds: readonly string[] },
  ): Promise<AddressableBridgeUnit[]> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    const requested = [...new Set(input.bridgeUnitIds.map((id) => id.trim()).filter(Boolean))];
    if (requested.length === 0) return [];
    const rows = await this.db
      .select({
        bridgeUnitId: sourceUnits.bridgeUnitId,
        sourceUnitKey: sourceUnits.sourceUnitKey,
        context: sourceUnits.context,
      })
      .from(sourceUnits)
      .innerJoin(localeBranches, eq(localeBranches.sourceBundleId, sourceUnits.sourceBundleId))
      .where(
        and(
          eq(sourceUnits.projectId, input.projectId),
          eq(localeBranches.localeBranchId, input.localeBranchId),
          inArray(sourceUnits.bridgeUnitId, requested),
          isNull(sourceUnits.removedAt),
        ),
      );
    const imported = new Map(rows.map((row) => [row.bridgeUnitId, row]));
    return requested.map((bridgeUnitId): AddressableBridgeUnit => {
      const row = imported.get(bridgeUnitId);
      if (row === undefined)
        return { bridgeUnitId, state: "unresolvable", reason: "not_imported_in_branch" };
      const sceneId = routeSceneId(row.context);
      if (sceneId === null) {
        return { bridgeUnitId, state: "unresolvable", reason: "scene_coordinate_missing" };
      }
      return { bridgeUnitId, sourceUnitKey: row.sourceUnitKey, state: "resolved", sceneId };
    });
  }
}

function routeSceneId(context: unknown): string | null {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return null;
  const route = (context as Record<string, unknown>).route;
  if (typeof route !== "object" || route === null || Array.isArray(route)) return null;
  const sceneId = (route as Record<string, unknown>).sceneId;
  return typeof sceneId === "string" && sceneId.trim().length > 0 ? sceneId.trim() : null;
}
