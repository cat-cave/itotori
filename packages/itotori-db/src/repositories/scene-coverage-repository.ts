// play-mark-validated — per-scene localization coverage repository.
//
// Persists the human workflow state of each scene on a locale branch:
//   needs_check | flagged | validated
// The Play RouteMap reads this; "Mark validated" (and flag / reset) write it.
//
// Authorization:
//   - load*  → queue.read  (same read surface as workspace scenes / queue)
//   - setCoverage → queue.manage (human review/play mutation)
// Every method is requirePermission-gated; the authorization matrix registers
// each method with a denial fixture.

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { ItotoriDatabase } from "../connection.js";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import {
  sceneLocalizationCoverage,
  sceneLocalizationCoverageStateValues,
  type SceneLocalizationCoverageState,
} from "../schema.js";

export {
  sceneLocalizationCoverageStateValues,
  type SceneLocalizationCoverageState,
} from "../schema.js";

export const SCENE_LOCALIZATION_COVERAGE_STATES = [
  sceneLocalizationCoverageStateValues.needsCheck,
  sceneLocalizationCoverageStateValues.flagged,
  sceneLocalizationCoverageStateValues.validated,
] as const satisfies readonly SceneLocalizationCoverageState[];

export type SceneCoverageRecord = {
  coverageId: string;
  projectId: string;
  localeBranchId: string;
  sceneId: string;
  coverageState: SceneLocalizationCoverageState;
  updatedByUserId: string;
  updatedAt: Date;
  createdAt: Date;
};

export type SetSceneCoverageInput = {
  projectId: string;
  localeBranchId: string;
  sceneId: string;
  coverageState: SceneLocalizationCoverageState;
  /** Actor who is marking the state (stored for audit). */
  updatedByUserId: string;
  updatedAt?: Date;
};

export type LoadSceneCoverageForBranchQuery = {
  projectId: string;
  localeBranchId: string;
};

export type LoadSceneCoverageForSceneQuery = {
  projectId: string;
  localeBranchId: string;
  sceneId: string;
};

export interface ItotoriSceneCoverageRepositoryPort {
  setCoverage(
    actor: AuthorizationActor,
    input: SetSceneCoverageInput,
  ): Promise<SceneCoverageRecord>;
  loadCoverageForBranch(
    actor: AuthorizationActor,
    query: LoadSceneCoverageForBranchQuery,
  ): Promise<SceneCoverageRecord[]>;
  loadCoverageForScene(
    actor: AuthorizationActor,
    query: LoadSceneCoverageForSceneQuery,
  ): Promise<SceneCoverageRecord | null>;
}

export class SceneCoverageRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneCoverageRepositoryError";
  }
}

export class ItotoriSceneCoverageRepository implements ItotoriSceneCoverageRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async setCoverage(
    actor: AuthorizationActor,
    input: SetSceneCoverageInput,
  ): Promise<SceneCoverageRecord> {
    await requirePermission(this.db, actor, permissionValues.queueManage);
    const sceneId = input.sceneId.trim();
    if (sceneId.length === 0) {
      throw new SceneCoverageRepositoryError(
        "refusing to set scene coverage with an empty sceneId",
      );
    }
    if (input.projectId.trim().length === 0) {
      throw new SceneCoverageRepositoryError(
        "refusing to set scene coverage with an empty projectId",
      );
    }
    if (input.localeBranchId.trim().length === 0) {
      throw new SceneCoverageRepositoryError(
        "refusing to set scene coverage with an empty localeBranchId",
      );
    }
    if (input.updatedByUserId.trim().length === 0) {
      throw new SceneCoverageRepositoryError(
        "refusing to set scene coverage with an empty updatedByUserId",
      );
    }
    if (!(SCENE_LOCALIZATION_COVERAGE_STATES as readonly string[]).includes(input.coverageState)) {
      throw new SceneCoverageRepositoryError(
        `unknown coverage state '${input.coverageState}'; expected one of ${SCENE_LOCALIZATION_COVERAGE_STATES.join(", ")}`,
      );
    }

    const updatedAt = input.updatedAt ?? new Date();
    const coverageId = `slc-${randomUUID()}`;

    const upserted = await this.db
      .insert(sceneLocalizationCoverage)
      .values({
        coverageId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        sceneId,
        coverageState: input.coverageState,
        updatedByUserId: input.updatedByUserId,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          sceneLocalizationCoverage.projectId,
          sceneLocalizationCoverage.localeBranchId,
          sceneLocalizationCoverage.sceneId,
        ],
        set: {
          coverageState: input.coverageState,
          updatedByUserId: input.updatedByUserId,
          updatedAt,
        },
      })
      .returning();

    const row = upserted[0];
    if (row === undefined) {
      throw new SceneCoverageRepositoryError(
        `scene coverage row for scene ${sceneId} disappeared immediately after upsert`,
      );
    }
    return rowToRecord(row);
  }

  async loadCoverageForBranch(
    actor: AuthorizationActor,
    query: LoadSceneCoverageForBranchQuery,
  ): Promise<SceneCoverageRecord[]> {
    await requirePermission(this.db, actor, permissionValues.queueRead);
    const rows = await this.db
      .select()
      .from(sceneLocalizationCoverage)
      .where(
        and(
          eq(sceneLocalizationCoverage.projectId, query.projectId),
          eq(sceneLocalizationCoverage.localeBranchId, query.localeBranchId),
        ),
      )
      .orderBy(asc(sceneLocalizationCoverage.sceneId));
    return rows.map(rowToRecord);
  }

  async loadCoverageForScene(
    actor: AuthorizationActor,
    query: LoadSceneCoverageForSceneQuery,
  ): Promise<SceneCoverageRecord | null> {
    await requirePermission(this.db, actor, permissionValues.queueRead);
    const rows = await this.db
      .select()
      .from(sceneLocalizationCoverage)
      .where(
        and(
          eq(sceneLocalizationCoverage.projectId, query.projectId),
          eq(sceneLocalizationCoverage.localeBranchId, query.localeBranchId),
          eq(sceneLocalizationCoverage.sceneId, query.sceneId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : rowToRecord(row);
  }
}

function rowToRecord(row: typeof sceneLocalizationCoverage.$inferSelect): SceneCoverageRecord {
  return {
    coverageId: row.coverageId,
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    sceneId: row.sceneId,
    coverageState: row.coverageState as SceneLocalizationCoverageState,
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}
