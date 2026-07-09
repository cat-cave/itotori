import { and, asc, eq } from "drizzle-orm";
import { type AuthorizationActor, permissionValues, requirePermission } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { modelProviders, modelRegistry, modelRoutingSettings, promptPresets } from "../schema.js";

export type ModelRoutingProviderRecord = {
  providerId: string;
  providerFamily: string;
  endpointFamily: string;
  providerName: string;
  metadata: Record<string, unknown>;
};

export type ModelRoutingModelRecord = {
  modelRegistryId: string;
  providerId: string;
  modelId: string;
  capabilities: Record<string, unknown>;
  pricing: Record<string, unknown>;
};

export type ModelRoutingPromptPresetRecord = {
  promptPresetId: string;
  promptTemplateVersion: string;
  presetSchemaVersion: string;
  promptHash: string;
  configSnapshot: Record<string, unknown>;
};

export type ModelRoutingRouteRecord = {
  projectId: string;
  taskKind: string;
  providerId: string;
  modelId: string;
  modelRegistryId: string;
  fallbackModelIds: string[];
  promptPresetId: string;
  promptTemplateVersion: string;
  updatedAt: Date;
};

export type ModelRoutingSettingsRecord = {
  projectId: string;
  generatedAt: Date;
  providers: ModelRoutingProviderRecord[];
  models: ModelRoutingModelRecord[];
  promptPresets: ModelRoutingPromptPresetRecord[];
  routes: ModelRoutingRouteRecord[];
};

export type SaveModelRoutingSettingsInput = {
  projectId: string;
  taskKind: string;
  providerId: string;
  modelId: string;
  fallbackModelIds: readonly string[];
  promptPresetId: string;
  promptTemplateVersion: string;
};

export interface ItotoriModelRoutingSettingsRepositoryPort {
  loadSettings(actor: AuthorizationActor, projectId: string): Promise<ModelRoutingSettingsRecord>;
  saveRoute(
    actor: AuthorizationActor,
    input: SaveModelRoutingSettingsInput,
  ): Promise<ModelRoutingSettingsRecord>;
}

export class ItotoriModelRoutingSettingsRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItotoriModelRoutingSettingsRepositoryError";
  }
}

export class ItotoriModelRoutingSettingsRepository implements ItotoriModelRoutingSettingsRepositoryPort {
  constructor(private readonly db: ItotoriDatabase) {}

  async loadSettings(
    actor: AuthorizationActor,
    projectId: string,
  ): Promise<ModelRoutingSettingsRecord> {
    await requirePermission(this.db, actor, permissionValues.catalogRead);
    return this.loadSettingsUnchecked(projectId);
  }

  async saveRoute(
    actor: AuthorizationActor,
    input: SaveModelRoutingSettingsInput,
  ): Promise<ModelRoutingSettingsRecord> {
    await requirePermission(this.db, actor, permissionValues.draftWrite);
    validateSaveInput(input);
    const model = await this.requireModelPair(input.providerId, input.modelId);
    await this.requireFallbackModels(input.providerId, input.fallbackModelIds);
    await this.requirePromptPreset(input.promptPresetId, input.promptTemplateVersion);
    const now = new Date();
    await this.db
      .insert(modelRoutingSettings)
      .values({
        projectId: input.projectId,
        taskKind: input.taskKind.trim(),
        providerId: input.providerId,
        modelRegistryId: model.modelRegistryId,
        modelId: input.modelId,
        fallbackModelIds: [...input.fallbackModelIds],
        promptPresetId: input.promptPresetId,
        promptTemplateVersion: input.promptTemplateVersion,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [modelRoutingSettings.projectId, modelRoutingSettings.taskKind],
        set: {
          providerId: input.providerId,
          modelRegistryId: model.modelRegistryId,
          modelId: input.modelId,
          fallbackModelIds: [...input.fallbackModelIds],
          promptPresetId: input.promptPresetId,
          promptTemplateVersion: input.promptTemplateVersion,
          updatedAt: now,
        },
      });
    return this.loadSettingsUnchecked(input.projectId);
  }

  private async loadSettingsUnchecked(projectId: string): Promise<ModelRoutingSettingsRecord> {
    const [providers, models, presets, routes] = await Promise.all([
      this.db.select().from(modelProviders).orderBy(asc(modelProviders.providerId)),
      this.db
        .select()
        .from(modelRegistry)
        .orderBy(asc(modelRegistry.providerId), asc(modelRegistry.modelId)),
      this.db
        .select()
        .from(promptPresets)
        .orderBy(asc(promptPresets.promptPresetId), asc(promptPresets.promptTemplateVersion)),
      this.db
        .select()
        .from(modelRoutingSettings)
        .where(eq(modelRoutingSettings.projectId, projectId))
        .orderBy(asc(modelRoutingSettings.taskKind)),
    ]);
    return {
      projectId,
      generatedAt: new Date(),
      providers: providers.map((provider) => ({
        providerId: provider.providerId,
        providerFamily: provider.providerFamily,
        endpointFamily: provider.endpointFamily,
        providerName: provider.providerName,
        metadata: provider.metadata,
      })),
      models: models.map((model) => ({
        modelRegistryId: model.modelRegistryId,
        providerId: model.providerId,
        modelId: model.modelId,
        capabilities: model.capabilities,
        pricing: model.pricing,
      })),
      promptPresets: presets.map((preset) => ({
        promptPresetId: preset.promptPresetId,
        promptTemplateVersion: preset.promptTemplateVersion,
        presetSchemaVersion: preset.presetSchemaVersion,
        promptHash: preset.promptHash,
        configSnapshot: preset.configSnapshot,
      })),
      routes: routes.map((route) => ({
        projectId: route.projectId,
        taskKind: route.taskKind,
        providerId: route.providerId,
        modelId: route.modelId,
        modelRegistryId: route.modelRegistryId,
        fallbackModelIds: route.fallbackModelIds,
        promptPresetId: route.promptPresetId,
        promptTemplateVersion: route.promptTemplateVersion,
        updatedAt: route.updatedAt,
      })),
    };
  }

  private async requireModelPair(
    providerId: string,
    modelId: string,
  ): Promise<{ modelRegistryId: string }> {
    const model = (
      await this.db
        .select({ modelRegistryId: modelRegistry.modelRegistryId })
        .from(modelRegistry)
        .where(and(eq(modelRegistry.providerId, providerId), eq(modelRegistry.modelId, modelId)))
        .limit(1)
    )[0];
    if (model === undefined) {
      throw new ItotoriModelRoutingSettingsRepositoryError(
        `unknown model/provider pair: ${modelId} @ ${providerId}`,
      );
    }
    return model;
  }

  private async requireFallbackModels(
    providerId: string,
    fallbackModelIds: readonly string[],
  ): Promise<void> {
    for (const modelId of fallbackModelIds) {
      await this.requireModelPair(providerId, modelId);
    }
  }

  private async requirePromptPreset(
    promptPresetId: string,
    promptTemplateVersion: string,
  ): Promise<void> {
    const preset = (
      await this.db
        .select({ promptPresetId: promptPresets.promptPresetId })
        .from(promptPresets)
        .where(
          and(
            eq(promptPresets.promptPresetId, promptPresetId),
            eq(promptPresets.promptTemplateVersion, promptTemplateVersion),
          ),
        )
        .limit(1)
    )[0];
    if (preset === undefined) {
      throw new ItotoriModelRoutingSettingsRepositoryError(
        `unknown prompt preset: ${promptPresetId}@${promptTemplateVersion}`,
      );
    }
  }
}

function validateSaveInput(input: SaveModelRoutingSettingsInput): void {
  for (const [field, value] of [
    ["projectId", input.projectId],
    ["taskKind", input.taskKind],
    ["providerId", input.providerId],
    ["modelId", input.modelId],
    ["promptPresetId", input.promptPresetId],
    ["promptTemplateVersion", input.promptTemplateVersion],
  ] as const) {
    if (value.trim().length === 0) {
      throw new ItotoriModelRoutingSettingsRepositoryError(`${field} is required`);
    }
  }
  for (const [index, modelId] of input.fallbackModelIds.entries()) {
    if (modelId.trim().length === 0) {
      throw new ItotoriModelRoutingSettingsRepositoryError(
        `fallbackModelIds[${index}] is required`,
      );
    }
  }
}
