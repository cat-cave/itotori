import { and, eq } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { localeBranches, localizationPassRunConfigs } from "../schema.js";

/** The operator-local inputs needed to drive one whole-project pass. */
export type LocalizationPassRunConfigRecord = {
  projectId: string;
  localeBranchId: string;
  /** Full-project config JSON path; it remains local to the operator. */
  configPath: string;
  /** Read-only extracted game/data root; never game bytes in the database. */
  dataRoot: string;
  /** Source pair-policy JSON path; the selected pair is pinned below. */
  pairPolicyPath: string;
  modelId: string;
  providerId: string;
  /** Per-pass output/artifact directory on the operator's filesystem. */
  runDir: string;
  updatedAt: Date;
};

export type SaveLocalizationPassRunConfigInput = Omit<LocalizationPassRunConfigRecord, "updatedAt">;

export interface ItotoriLocalizationPassRunConfigRepositoryPort {
  saveRunConfig(
    actor: AuthorizationActor,
    input: SaveLocalizationPassRunConfigInput,
  ): Promise<LocalizationPassRunConfigRecord>;
  /** Internal live-driver lookup; an absent row is the domain refusal path. */
  resolveRunConfig(
    projectId: string,
    localeBranchId: string,
  ): Promise<LocalizationPassRunConfigRecord | null>;
}

export class ItotoriLocalizationPassRunConfigRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItotoriLocalizationPassRunConfigRepositoryError";
  }
}

export class ItotoriLocalizationPassRunConfigRepository implements ItotoriLocalizationPassRunConfigRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async saveRunConfig(
    actor: AuthorizationActor,
    input: SaveLocalizationPassRunConfigInput,
  ): Promise<LocalizationPassRunConfigRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    const normalized = validateSaveInput(input);
    await this.requireLocaleBranch(normalized.projectId, normalized.localeBranchId);
    const now = new Date();
    await this.db
      .insert(localizationPassRunConfigs)
      .values({ ...normalized, updatedAt: now })
      .onConflictDoUpdate({
        target: [localizationPassRunConfigs.projectId, localizationPassRunConfigs.localeBranchId],
        set: {
          configPath: normalized.configPath,
          dataRoot: normalized.dataRoot,
          pairPolicyPath: normalized.pairPolicyPath,
          modelId: normalized.modelId,
          providerId: normalized.providerId,
          runDir: normalized.runDir,
          updatedAt: now,
        },
      });
    const saved = await this.resolveRunConfig(normalized.projectId, normalized.localeBranchId);
    if (saved === null) {
      throw new ItotoriLocalizationPassRunConfigRepositoryError(
        "run config disappeared immediately after it was saved",
      );
    }
    return saved;
  }

  async resolveRunConfig(
    projectId: string,
    localeBranchId: string,
  ): Promise<LocalizationPassRunConfigRecord | null> {
    const row = (
      await this.db
        .select()
        .from(localizationPassRunConfigs)
        .where(
          and(
            eq(localizationPassRunConfigs.projectId, projectId),
            eq(localizationPassRunConfigs.localeBranchId, localeBranchId),
          ),
        )
        .limit(1)
    )[0];
    return row === undefined ? null : toRecord(row);
  }

  private async requireLocaleBranch(projectId: string, localeBranchId: string): Promise<void> {
    const branch = (
      await this.db
        .select({ projectId: localeBranches.projectId })
        .from(localeBranches)
        .where(eq(localeBranches.localeBranchId, localeBranchId))
        .limit(1)
    )[0];
    if (branch === undefined || branch.projectId !== projectId) {
      throw new ItotoriLocalizationPassRunConfigRepositoryError(
        `unknown locale branch: ${localeBranchId} (project ${projectId})`,
      );
    }
  }
}

function validateSaveInput(
  input: SaveLocalizationPassRunConfigInput,
): SaveLocalizationPassRunConfigInput {
  const fields = [
    "projectId",
    "localeBranchId",
    "configPath",
    "dataRoot",
    "pairPolicyPath",
    "modelId",
    "providerId",
    "runDir",
  ] as const;
  const normalized = { ...input };
  for (const field of fields) {
    const value = input[field];
    if (value.trim().length === 0) {
      throw new ItotoriLocalizationPassRunConfigRepositoryError(`${field} is required`);
    }
    normalized[field] = value.trim();
  }
  return normalized;
}

function toRecord(
  row: typeof localizationPassRunConfigs.$inferSelect,
): LocalizationPassRunConfigRecord {
  return {
    projectId: row.projectId,
    localeBranchId: row.localeBranchId,
    configPath: row.configPath,
    dataRoot: row.dataRoot,
    pairPolicyPath: row.pairPolicyPath,
    modelId: row.modelId,
    providerId: row.providerId,
    runDir: row.runDir,
    updatedAt: row.updatedAt,
  };
}
