import { eq } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { localeBranches, translationScopeSettings } from "../schema.js";

// itotori-translation-scope-settings — config-driven translation scope
// persistence. The DEFAULT scope (when no row exists for a locale branch) is
// "dialogue-only", matching the localize command's `--output-scope` default
// (see `apps/itotori/src/cli/localize-command.ts`).
// The tiers are cumulative: dialogue-only -> dialogue-and-choices ->
// dialogue-choices-ui -> all.
export const translationScopeValues = [
  "dialogue-only",
  "dialogue-and-choices",
  "dialogue-choices-ui",
  "all",
] as const;

export type TranslationScopeSettingValue = (typeof translationScopeValues)[number];

export const DEFAULT_TRANSLATION_SCOPE: TranslationScopeSettingValue = "dialogue-only";

export type TranslationScopeSettingsRecord = {
  projectId: string;
  localeBranchId: string;
  scope: TranslationScopeSettingValue;
  updatedAt: Date;
};

export type SaveTranslationScopeSettingsInput = {
  projectId: string;
  localeBranchId: string;
  scope: TranslationScopeSettingValue;
};

export interface ItotoriTranslationScopeSettingsRepositoryPort {
  loadSettings(
    actor: AuthorizationActor,
    input: { projectId: string; localeBranchId: string },
  ): Promise<TranslationScopeSettingsRecord>;
  saveSettings(
    actor: AuthorizationActor,
    input: SaveTranslationScopeSettingsInput,
  ): Promise<TranslationScopeSettingsRecord>;
  /**
   * Narrow read used by the localize command / CLI to resolve the persisted
   * DEFAULT scope when a run's config JSON omits `translationScope`. Returns
   * `undefined` when no row has been saved for the branch (the caller falls
   * back to its own default), so this never fabricates a value.
   */
  resolveScope(
    projectId: string,
    localeBranchId: string,
  ): Promise<TranslationScopeSettingValue | undefined>;
}

export class ItotoriTranslationScopeSettingsRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItotoriTranslationScopeSettingsRepositoryError";
  }
}

export class ItotoriTranslationScopeSettingsRepository implements ItotoriTranslationScopeSettingsRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async loadSettings(
    actor: AuthorizationActor,
    input: { projectId: string; localeBranchId: string },
  ): Promise<TranslationScopeSettingsRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return this.loadSettingsUnchecked(input.projectId, input.localeBranchId);
  }

  async saveSettings(
    actor: AuthorizationActor,
    input: SaveTranslationScopeSettingsInput,
  ): Promise<TranslationScopeSettingsRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    validateSaveInput(input);
    await this.requireLocaleBranch(input.projectId, input.localeBranchId);
    const now = new Date();
    await this.db
      .insert(translationScopeSettings)
      .values({
        localeBranchId: input.localeBranchId,
        projectId: input.projectId,
        scope: input.scope,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: translationScopeSettings.localeBranchId,
        set: { scope: input.scope, projectId: input.projectId, updatedAt: now },
      });
    return this.loadSettingsUnchecked(input.projectId, input.localeBranchId);
  }

  async resolveScope(
    projectId: string,
    localeBranchId: string,
  ): Promise<TranslationScopeSettingValue | undefined> {
    const row = (
      await this.db
        .select({
          scope: translationScopeSettings.scope,
          projectId: translationScopeSettings.projectId,
        })
        .from(translationScopeSettings)
        .where(eq(translationScopeSettings.localeBranchId, localeBranchId))
        .limit(1)
    )[0];
    if (row === undefined || row.projectId !== projectId) {
      return undefined;
    }
    return asTranslationScope(row.scope);
  }

  private async loadSettingsUnchecked(
    projectId: string,
    localeBranchId: string,
  ): Promise<TranslationScopeSettingsRecord> {
    const row = (
      await this.db
        .select()
        .from(translationScopeSettings)
        .where(eq(translationScopeSettings.localeBranchId, localeBranchId))
        .limit(1)
    )[0];
    if (row === undefined || row.projectId !== projectId) {
      return {
        projectId,
        localeBranchId,
        scope: DEFAULT_TRANSLATION_SCOPE,
        updatedAt: new Date(0),
      };
    }
    return {
      projectId: row.projectId,
      localeBranchId: row.localeBranchId,
      scope: asTranslationScope(row.scope),
      updatedAt: row.updatedAt,
    };
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
      throw new ItotoriTranslationScopeSettingsRepositoryError(
        `unknown locale branch: ${localeBranchId} (project ${projectId})`,
      );
    }
  }
}

function validateSaveInput(input: SaveTranslationScopeSettingsInput): void {
  for (const [field, value] of [
    ["projectId", input.projectId],
    ["localeBranchId", input.localeBranchId],
  ] as const) {
    if (value.trim().length === 0) {
      throw new ItotoriTranslationScopeSettingsRepositoryError(`${field} is required`);
    }
  }
  if (!translationScopeValues.includes(input.scope)) {
    throw new ItotoriTranslationScopeSettingsRepositoryError(
      `scope must be one of ${translationScopeValues.join(", ")} (got ${String(input.scope)})`,
    );
  }
}

function asTranslationScope(value: string): TranslationScopeSettingValue {
  if ((translationScopeValues as readonly string[]).includes(value)) {
    return value as TranslationScopeSettingValue;
  }
  throw new ItotoriTranslationScopeSettingsRepositoryError(`persisted scope is invalid: ${value}`);
}
