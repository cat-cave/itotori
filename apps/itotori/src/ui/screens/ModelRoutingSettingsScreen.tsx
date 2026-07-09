import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Badge, DataTable, Panel } from "@itotori/ds";
import type {
  ApiModelRoutingModel,
  ApiModelRoutingPromptPreset,
  ApiModelRoutingProvider,
  ApiModelRoutingRoute,
  ApiModelRoutingSettingsResponse,
} from "../../api-schema.js";
import { apiClient } from "../client.js";
import { useApiQuery, useApiQueryWhen } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import "./ModelRoutingSettingsScreen.css";

export const modelRoutingSettingsRoutePathRegex = /^\/settings\/model-routing\/?$/u;

export function parseModelRoutingSettingsRoute(pathname: string): Record<string, never> | null {
  return modelRoutingSettingsRoutePathRegex.test(pathname) ? {} : null;
}

export function ModelRoutingSettingsScreen(): ReactNode {
  const [revision, setRevision] = useState(0);
  const [savedRoute, setSavedRoute] = useState<string | null>(null);
  const status = useApiQuery("projects.status", {}, "model-routing:project-status");
  const projectId = status.state === "ready" ? status.data.projectId : null;
  const settings = useApiQueryWhen(
    "settings.modelRouting.get",
    { query: { projectId: projectId ?? "" } },
    `model-routing:${projectId ?? "pending"}:${revision}`,
    projectId !== null,
  );

  const state =
    status.state === "error" || settings.state === "error"
      ? "error"
      : status.state === "loading" || settings.state === "loading" || projectId === null
        ? "loading"
        : settings.state === "ready"
          ? "ready"
          : "empty";

  return (
    <main
      className="itotori-shell model-routing-settings"
      data-screen="settings-model-routing"
      data-state={state}
      data-project-id={projectId ?? undefined}
    >
      <ShellHeader eyebrow="Settings" title="Model routing">
        {projectId !== null && <Badge status="active">{projectId}</Badge>}
      </ShellHeader>
      {state === "loading" && <LoadingState label="Loading model routing settings..." />}
      {status.state === "error" && <ErrorState title="Project context" error={status.error} />}
      {settings.state === "error" && <ErrorState title="Model routing" error={settings.error} />}
      {state === "empty" && (
        <EmptyState
          title="Model routing"
          message="No model routing settings are available for the selected project."
        />
      )}
      {state === "ready" && settings.state === "ready" && (
        <ModelRoutingSettingsReady
          settings={settings.data}
          savedRoute={savedRoute}
          onSaved={(taskKind) => {
            setSavedRoute(taskKind);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </main>
  );
}

function ModelRoutingSettingsReady({
  settings,
  savedRoute,
  onSaved,
}: {
  settings: ApiModelRoutingSettingsResponse;
  savedRoute: string | null;
  onSaved(taskKind: string): void;
}): ReactNode {
  return (
    <section className="model-routing-settings__body" aria-label="Model routing settings">
      <section className="model-routing-settings__grid">
        <RouteEditor settings={settings} savedRoute={savedRoute} onSaved={onSaved} />
        <AvailablePairsPanel providers={settings.providers} models={settings.models} />
      </section>
      <SavedRoutesPanel routes={settings.routes} />
    </section>
  );
}

function RouteEditor({
  settings,
  savedRoute,
  onSaved,
}: {
  settings: ApiModelRoutingSettingsResponse;
  savedRoute: string | null;
  onSaved(taskKind: string): void;
}): ReactNode {
  const initial = useMemo(() => initialForm(settings), [settings]);
  const [taskKind, setTaskKind] = useState(initial.taskKind);
  const [providerId, setProviderId] = useState(initial.providerId);
  const [modelId, setModelId] = useState(initial.modelId);
  const [fallbackModels, setFallbackModels] = useState(initial.fallbackModels);
  const [promptKey, setPromptKey] = useState(initial.promptKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modelsForProvider = settings.models.filter((model) => model.providerId === providerId);
  const resolvedModelId = modelsForProvider.some((model) => model.modelId === modelId)
    ? modelId
    : (modelsForProvider[0]?.modelId ?? "");
  const prompt =
    promptPresetFromKey(settings.promptPresets, promptKey) ?? settings.promptPresets[0];
  const canSave =
    taskKind.trim().length > 0 &&
    providerId.length > 0 &&
    resolvedModelId.length > 0 &&
    prompt !== undefined &&
    !pending;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSave || prompt === undefined) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await apiClient.request("settings.modelRouting.save", {
      body: {
        projectId: settings.projectId,
        taskKind: taskKind.trim(),
        providerId,
        modelId: resolvedModelId,
        fallbackModelIds: parseFallbackModels(fallbackModels),
        promptPresetId: prompt.promptPresetId,
        promptTemplateVersion: prompt.promptTemplateVersion,
      },
    });
    setPending(false);
    if (result.state === "ready") {
      onSaved(taskKind.trim());
      return;
    }
    if (result.state === "error") {
      setError(
        result.error.message ??
          `Model routing update failed with status ${String(result.error.status)}.`,
      );
      return;
    }
    setError("Model routing update returned no settings payload.");
  };

  return (
    <Panel
      title="Task route"
      eyebrow="Model pair"
      lamps={
        <Badge status={savedRoute === null ? "pending" : "saved"}>{savedRoute ?? "pending"}</Badge>
      }
    >
      <form className="model-routing-settings__form" onSubmit={(event) => void submit(event)}>
        <label className="model-routing-settings__field">
          <span>Task</span>
          <input
            value={taskKind}
            onChange={(event) => setTaskKind(event.currentTarget.value)}
            aria-label="Task"
          />
        </label>
        <label className="model-routing-settings__field">
          <span>Provider</span>
          <select
            value={providerId}
            onChange={(event) => {
              const nextProviderId = event.currentTarget.value;
              setProviderId(nextProviderId);
              setModelId(
                settings.models.find((model) => model.providerId === nextProviderId)?.modelId ?? "",
              );
            }}
            aria-label="Provider"
          >
            {settings.providers.map((provider) => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.providerId}
              </option>
            ))}
          </select>
        </label>
        <label className="model-routing-settings__field">
          <span>Model</span>
          <select
            value={resolvedModelId}
            onChange={(event) => setModelId(event.currentTarget.value)}
            aria-label="Model"
          >
            {modelsForProvider.map((model) => (
              <option key={model.modelRegistryId} value={model.modelId}>
                {model.modelId}
              </option>
            ))}
          </select>
        </label>
        <label className="model-routing-settings__field">
          <span>Fallback</span>
          <input
            value={fallbackModels}
            onChange={(event) => setFallbackModels(event.currentTarget.value)}
            aria-label="Fallback models"
            placeholder="model-a, model-b"
          />
        </label>
        <label className="model-routing-settings__field">
          <span>Prompt preset</span>
          <select
            value={promptKey}
            onChange={(event) => setPromptKey(event.currentTarget.value)}
            aria-label="Prompt preset"
          >
            {settings.promptPresets.map((preset) => (
              <option key={promptPresetKey(preset)} value={promptPresetKey(preset)}>
                {preset.promptPresetId}@{preset.promptTemplateVersion}
              </option>
            ))}
          </select>
        </label>
        <div className="model-routing-settings__actions">
          <button type="submit" disabled={!canSave}>
            {pending ? "Saving..." : "Save route"}
          </button>
          {savedRoute !== null && <span>{`Saved ${savedRoute}`}</span>}
          {error !== null && <span role="alert">{error}</span>}
        </div>
      </form>
    </Panel>
  );
}

function AvailablePairsPanel({
  providers,
  models,
}: {
  providers: readonly ApiModelRoutingProvider[];
  models: readonly ApiModelRoutingModel[];
}): ReactNode {
  return (
    <Panel
      title="Available pairs"
      eyebrow="Registry"
      lamps={<Badge status="active">{`${models.length} models`}</Badge>}
    >
      <DataTable
        caption="Available model provider pairs"
        rows={models}
        getRowKey={(model) => model.modelRegistryId}
        columns={[
          {
            key: "model",
            header: "Model",
            render: (model) => (
              <code className="model-routing-settings__mono">{model.modelId}</code>
            ),
          },
          {
            key: "provider",
            header: "Provider",
            render: (model) => (
              <code className="model-routing-settings__mono">
                {providers.find((provider) => provider.providerId === model.providerId)
                  ?.providerName ?? model.providerId}
              </code>
            ),
          },
        ]}
      />
    </Panel>
  );
}

function SavedRoutesPanel({ routes }: { routes: readonly ApiModelRoutingRoute[] }): ReactNode {
  return (
    <Panel
      title="Saved routes"
      eyebrow="Project settings"
      lamps={<Badge status="active">{`${routes.length} routes`}</Badge>}
    >
      <DataTable
        caption="Saved model routing routes"
        rows={routes}
        getRowKey={(route) => `${route.projectId}:${route.taskKind}`}
        columns={[
          {
            key: "task",
            header: "Task",
            render: (route) => (
              <div className="model-routing-settings__route">
                <strong>{route.taskKind}</strong>
                <code>
                  {route.promptPresetId}@{route.promptTemplateVersion}
                </code>
              </div>
            ),
          },
          {
            key: "pair",
            header: "Pair",
            render: (route) => (
              <code className="model-routing-settings__mono">
                {route.modelId} @ {route.providerId}
              </code>
            ),
          },
          {
            key: "fallback",
            header: "Fallback",
            render: (route) => (
              <code className="model-routing-settings__mono">
                {route.fallbackModelIds.length === 0 ? "none" : route.fallbackModelIds.join(", ")}
              </code>
            ),
          },
        ]}
      />
    </Panel>
  );
}

function initialForm(settings: ApiModelRoutingSettingsResponse): {
  taskKind: string;
  providerId: string;
  modelId: string;
  fallbackModels: string;
  promptKey: string;
} {
  const route = settings.routes[0];
  const providerId = route?.providerId ?? settings.providers[0]?.providerId ?? "";
  const modelId =
    route?.modelId ??
    settings.models.find((model) => model.providerId === providerId)?.modelId ??
    "";
  const promptKey =
    route === undefined
      ? promptPresetKey(settings.promptPresets[0])
      : `${route.promptPresetId}@@${route.promptTemplateVersion}`;
  return {
    taskKind: route?.taskKind ?? "draft_translation",
    providerId,
    modelId,
    fallbackModels: route?.fallbackModelIds.join(", ") ?? "",
    promptKey,
  };
}

function promptPresetKey(preset: ApiModelRoutingPromptPreset | undefined): string {
  return preset === undefined ? "" : `${preset.promptPresetId}@@${preset.promptTemplateVersion}`;
}

function promptPresetFromKey(
  presets: readonly ApiModelRoutingPromptPreset[],
  key: string,
): ApiModelRoutingPromptPreset | undefined {
  return presets.find((preset) => promptPresetKey(preset) === key);
}

function parseFallbackModels(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
