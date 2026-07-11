// itotori-translation-scope-configuration-ui — the config-driven translation
// scope screen (dialogue / +choices / +UI-text / +images) the whole-project
// localize command reads. The scope is a CUMULATIVE tier (dialogue-only ->
// dialogue-and-choices -> dialogue-choices-ui -> all): enabling a surface
// implies every surface below it stays in scope. Wired to the REAL
// `settings.translationScope.get`/`.save` typed-client routes — the same
// backend config `runLocalizeFullProjectCommand`
// (apps/itotori/src/orchestrator/localize-fullproject-command.ts) consumes
// when a run's config JSON omits `translationScope`.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Panel } from "@itotori/ds";
import type { ApiTranslationScope, ApiTranslationScopeSettingsResponse } from "../../api-schema.js";
import { apiClient } from "../client.js";
import { useApiQuery, useApiQueryWhen } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import {
  resolveEffectiveSelection,
  serverSelectionFromStatus,
} from "../project-branch-switcher.js";
import { NO_SHELL_SELECTION, useShellSelection } from "../shell-selection.js";
import "./TranslationScopeSettingsScreen.css";

export const translationScopeSettingsRoutePathRegex = /^\/settings\/translation-scope\/?$/u;

export function parseTranslationScopeSettingsRoute(pathname: string): Record<string, never> | null {
  return translationScopeSettingsRoutePathRegex.test(pathname) ? {} : null;
}

// Cumulative tier ladder — index N implies every tier <= N stays in scope.
// This mirrors `TranslationScope`/`unitSurfaceKindInScope`
// (apps/itotori/src/orchestrator/project-driven-executor.ts) and
// `crates/kaifuu-reallive/src/scope.rs`.
const TRANSLATION_SCOPE_TIERS: readonly {
  scope: ApiTranslationScope;
  label: string;
  description: string;
}[] = [
  {
    scope: "dialogue-only",
    label: "Dialogue",
    description: "Textout dialogue lines. Always in scope — the baseline surface.",
  },
  {
    scope: "dialogue-and-choices",
    label: "+ Choices",
    description: "Adds choice_label / module_sel select options (NextString-safe).",
  },
  {
    scope: "dialogue-choices-ui",
    label: "+ UI text",
    description: "Adds menu / system / UI label surfaces.",
  },
  {
    scope: "all",
    label: "+ Images (beta)",
    description: "Adds image surfaces. Beta — exercised on real bytes before general use.",
  },
];

function tierIndexForScope(scope: ApiTranslationScope): number {
  const index = TRANSLATION_SCOPE_TIERS.findIndex((tier) => tier.scope === scope);
  return index === -1 ? 0 : index;
}

export function TranslationScopeSettingsScreen(): ReactNode {
  const [revision, setRevision] = useState(0);
  const [savedScope, setSavedScope] = useState<ApiTranslationScope | null>(null);
  const status = useApiQuery("projects.status", {}, "translation-scope:project-status");
  const shellSelection = useShellSelection();
  const effective = resolveEffectiveSelection(
    serverSelectionFromStatus(status.state === "ready" ? status.data : null),
    shellSelection?.override ?? NO_SHELL_SELECTION,
  );
  const projectId = effective.projectId;
  const localeBranchId = effective.localeBranchId;
  const selectionKey = `${projectId ?? "none"}:${localeBranchId ?? "none"}`;
  const settings = useApiQueryWhen(
    "settings.translationScope.get",
    {
      pathParams: {
        projectId: projectId ?? "",
        localeBranchId: localeBranchId ?? "",
      },
    },
    `translation-scope:${selectionKey}:${revision}`,
    projectId !== null && localeBranchId !== null,
  );

  useEffect(() => {
    setSavedScope(null);
  }, [selectionKey]);

  const state =
    status.state === "error" || settings.state === "error"
      ? "error"
      : status.state === "loading" ||
          settings.state === "loading" ||
          projectId === null ||
          localeBranchId === null
        ? "loading"
        : settings.state === "ready"
          ? "ready"
          : "empty";

  return (
    <main
      className="itotori-shell translation-scope-settings"
      data-screen="settings-translation-scope"
      data-state={state}
      data-project-id={projectId ?? undefined}
      data-locale-branch-id={localeBranchId ?? undefined}
    >
      <ShellHeader eyebrow="Settings" title="Translation scope">
        {localeBranchId !== null && <Badge status="active">{localeBranchId}</Badge>}
      </ShellHeader>
      {state === "loading" && <LoadingState label="Loading translation scope..." />}
      {status.state === "error" && <ErrorState title="Project context" error={status.error} />}
      {settings.state === "error" && (
        <ErrorState title="Translation scope" error={settings.error} />
      )}
      {state === "empty" && (
        <EmptyState
          title="Translation scope"
          message="No translation scope is available for the selected locale branch."
        />
      )}
      {state === "ready" && settings.state === "ready" && (
        <TranslationScopeReady
          key={`${settings.data.projectId}:${settings.data.localeBranchId}:${settings.data.updatedAt}`}
          settings={settings.data}
          savedScope={savedScope}
          onSaved={(scope) => {
            setSavedScope(scope);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </main>
  );
}

function TranslationScopeReady({
  settings,
  savedScope,
  onSaved,
}: {
  settings: ApiTranslationScopeSettingsResponse;
  savedScope: ApiTranslationScope | null;
  onSaved(scope: ApiTranslationScope): void;
}): ReactNode {
  const initialTierIndex = useMemo(() => tierIndexForScope(settings.scope), [settings.scope]);
  const [tierIndex, setTierIndex] = useState(initialTierIndex);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = tierIndex !== initialTierIndex;
  const canSave = !pending && dirty;
  const selectedTier = TRANSLATION_SCOPE_TIERS[tierIndex];

  const submit = async (): Promise<void> => {
    if (!canSave || selectedTier === undefined) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await apiClient.request("settings.translationScope.save", {
      pathParams: { projectId: settings.projectId, localeBranchId: settings.localeBranchId },
      body: {
        projectId: settings.projectId,
        localeBranchId: settings.localeBranchId,
        scope: selectedTier.scope,
      },
    });
    setPending(false);
    if (result.state === "ready") {
      onSaved(result.data.scope);
      return;
    }
    if (result.state === "error") {
      setError(
        result.error.message ??
          `Translation scope update failed with status ${String(result.error.status)}.`,
      );
      return;
    }
    setError("Translation scope update returned no settings payload.");
  };

  return (
    <section className="translation-scope-settings__body" aria-label="Translation scope settings">
      <Panel
        title="Config-driven translation scope"
        eyebrow={settings.localeBranchId}
        lamps={
          <Badge status={savedScope === null ? "pending" : "saved"}>
            {savedScope ?? settings.scope}
          </Badge>
        }
      >
        <p className="translation-scope-settings__intro">
          Each tier is <strong>cumulative</strong>: enabling a surface keeps every surface below it
          in scope. Everything outside the selected scope is carried byte-identical through the
          patchback pipeline.
        </p>
        <fieldset
          className="translation-scope-settings__tiers"
          role="group"
          aria-label="Translation scope tiers"
        >
          {TRANSLATION_SCOPE_TIERS.map((tier, index) => {
            const checked = tierIndex >= index;
            const isBaseline = index === 0;
            return (
              <label
                key={tier.scope}
                className="translation-scope-settings__tier"
                data-checked={checked}
                data-baseline={isBaseline}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isBaseline || pending}
                  aria-label={tier.label}
                  onChange={(event) => {
                    setTierIndex(event.currentTarget.checked ? index : index - 1);
                  }}
                />
                <span className="translation-scope-settings__tier-body">
                  <span className="translation-scope-settings__tier-label">
                    {tier.label}
                    {isBaseline && <Badge status="always on" tone="neutral" />}
                  </span>
                  <span className="translation-scope-settings__tier-description">
                    {tier.description}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <div className="translation-scope-settings__actions">
          <button type="button" disabled={!canSave} onClick={() => void submit()}>
            {pending ? "Saving..." : "Save translation scope"}
          </button>
          {savedScope !== null && <span>{`Saved ${savedScope}`}</span>}
          {error !== null && <span role="alert">{error}</span>}
        </div>
      </Panel>
    </section>
  );
}
