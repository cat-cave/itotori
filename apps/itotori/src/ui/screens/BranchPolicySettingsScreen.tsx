import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Badge, DataTable, Panel } from "@itotori/ds";
import type {
  ApiBranchPolicyPolicy,
  ApiBranchPolicyRule,
  ApiBranchPolicySettingsResponse,
} from "../../api-schema.js";
import { apiClient } from "../client.js";
import { useApiQuery, useApiQueryWhen } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import {
  resolveEffectiveSelection,
  serverSelectionFromStatus,
} from "../project-branch-switcher.js";
import { NO_SHELL_SELECTION, useShellSelection } from "../shell-selection.js";
import "./BranchPolicySettingsScreen.css";

export const branchPolicySettingsRoutePathRegex = /^\/settings\/branch-policy\/?$/u;

export function parseBranchPolicySettingsRoute(pathname: string): Record<string, never> | null {
  return branchPolicySettingsRoutePathRegex.test(pathname) ? {} : null;
}

type BranchPolicyDraft = {
  tone: string;
  honorifics: string;
  protectedSpans: string;
  ruby: string;
  profanity: string;
  updateReason: string;
};

type BranchPolicyField = keyof Omit<BranchPolicyDraft, "updateReason">;

const POLICY_FIELDS: readonly {
  key: BranchPolicyField;
  label: string;
  section: keyof ApiBranchPolicyPolicy["sections"];
}[] = [
  { key: "tone", label: "Tone", section: "tone" },
  { key: "honorifics", label: "Honorifics", section: "honorifics" },
  { key: "protectedSpans", label: "Protected spans", section: "protectedSpans" },
  { key: "ruby", label: "Ruby", section: "formatting" },
  { key: "profanity", label: "Profanity", section: "terminology" },
];

export function BranchPolicySettingsScreen(): ReactNode {
  const [revision, setRevision] = useState(0);
  const [savedVersionId, setSavedVersionId] = useState<string | null>(null);
  const status = useApiQuery("projects.status", {}, "branch-policy:project-status");
  const shellSelection = useShellSelection();
  const effective = resolveEffectiveSelection(
    serverSelectionFromStatus(status.state === "ready" ? status.data : null),
    shellSelection?.override ?? NO_SHELL_SELECTION,
  );
  const projectId = effective.projectId;
  const localeBranchId = effective.localeBranchId;
  const selectionKey = `${projectId ?? "none"}:${localeBranchId ?? "none"}`;
  const settings = useApiQueryWhen(
    "settings.branchPolicy.get",
    {
      pathParams: {
        projectId: projectId ?? "",
        localeBranchId: localeBranchId ?? "",
      },
    },
    `branch-policy:${projectId ?? "none"}:${localeBranchId ?? "none"}:${revision}`,
    projectId !== null && localeBranchId !== null,
  );

  useEffect(() => {
    setSavedVersionId(null);
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
      className="itotori-shell branch-policy-settings"
      data-screen="settings-branch-policy"
      data-state={state}
      data-project-id={projectId ?? undefined}
      data-locale-branch-id={localeBranchId ?? undefined}
    >
      <ShellHeader eyebrow="Settings" title="Branch policy">
        {localeBranchId !== null && <Badge status="active">{localeBranchId}</Badge>}
      </ShellHeader>
      {state === "loading" && <LoadingState label="Loading branch policy..." />}
      {status.state === "error" && <ErrorState title="Project context" error={status.error} />}
      {settings.state === "error" && <ErrorState title="Branch policy" error={settings.error} />}
      {state === "empty" && (
        <EmptyState
          title="Branch policy"
          message="No branch policy is available for the selected locale branch."
        />
      )}
      {state === "ready" && settings.state === "ready" && (
        <BranchPolicyReady
          key={branchPolicySettingsIdentity(settings.data)}
          settings={settings.data}
          savedVersionId={savedVersionId}
          onSaved={(versionId) => {
            setSavedVersionId(versionId);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </main>
  );
}

function BranchPolicyReady({
  settings,
  savedVersionId,
  onSaved,
}: {
  settings: ApiBranchPolicySettingsResponse;
  savedVersionId: string | null;
  onSaved(versionId: string | null): void;
}): ReactNode {
  return (
    <section className="branch-policy-settings__body" aria-label="Branch policy settings">
      <section className="branch-policy-settings__grid">
        <BranchPolicyEditor settings={settings} savedVersionId={savedVersionId} onSaved={onSaved} />
        <BranchPolicyReferencePanel settings={settings} />
      </section>
    </section>
  );
}

function BranchPolicyEditor({
  settings,
  savedVersionId,
  onSaved,
}: {
  settings: ApiBranchPolicySettingsResponse;
  savedVersionId: string | null;
  onSaved(versionId: string | null): void;
}): ReactNode {
  const initial = useMemo(() => initialDraft(settings), [settings]);
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = !pending && draft.updateReason.trim().length > 0;

  useEffect(() => {
    setDraft(initial);
    setPending(false);
    setError(null);
  }, [initial]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canSave) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await apiClient.request("settings.branchPolicy.save", {
      pathParams: {
        projectId: settings.projectId,
        localeBranchId: settings.localeBranchId,
      },
      body: {
        projectId: settings.projectId,
        localeBranchId: settings.localeBranchId,
        expectedPreviousVersionId: settings.latestVersion?.styleGuideVersionId ?? null,
        updateReason: draft.updateReason.trim(),
        policy: draftToPolicy(draft, settings.policy),
      },
    });
    setPending(false);
    if (result.state === "ready") {
      onSaved(result.data.latestVersion?.styleGuideVersionId ?? null);
      return;
    }
    if (result.state === "error") {
      setError(
        result.error.message ??
          `Branch policy update failed with status ${String(result.error.status)}.`,
      );
      return;
    }
    setError("Branch policy update returned no settings payload.");
  };

  return (
    <Panel
      title="Locale branch policy"
      eyebrow={settings.targetLocale}
      lamps={
        <Badge status={savedVersionId === null ? "pending" : "saved"}>
          {savedVersionId ?? settings.latestVersion?.styleGuideVersionId ?? "draft"}
        </Badge>
      }
    >
      <form className="branch-policy-settings__form" onSubmit={(event) => void submit(event)}>
        {POLICY_FIELDS.map((field) => (
          <label key={field.key} className="branch-policy-settings__field">
            <span>{field.label}</span>
            <textarea
              value={draft[field.key]}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, [field.key]: value }));
              }}
              aria-label={field.label}
              rows={4}
            />
          </label>
        ))}
        <label className="branch-policy-settings__field">
          <span>Update reason</span>
          <input
            value={draft.updateReason}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, updateReason: value }));
            }}
            aria-label="Update reason"
          />
        </label>
        <div className="branch-policy-settings__actions">
          <button type="submit" disabled={!canSave}>
            {pending ? "Saving..." : "Save branch policy"}
          </button>
          {savedVersionId !== null && <span>{`Saved ${savedVersionId}`}</span>}
          {error !== null && <span role="alert">{error}</span>}
        </div>
      </form>
    </Panel>
  );
}

function branchPolicySettingsIdentity(settings: ApiBranchPolicySettingsResponse): string {
  return [
    settings.projectId,
    settings.localeBranchId,
    settings.latestVersion?.styleGuideVersionId ?? "no-latest",
    settings.approvedVersion?.styleGuideVersionId ?? "no-approved",
    settings.branchReference?.referenceId ?? "no-reference",
  ].join(":");
}

function BranchPolicyReferencePanel({
  settings,
}: {
  settings: ApiBranchPolicySettingsResponse;
}): ReactNode {
  const rows = [
    {
      key: "latest",
      label: "Latest policy",
      value: settings.latestVersion?.styleGuideVersionId ?? "none",
    },
    {
      key: "approved",
      label: "Approved policy",
      value: settings.approvedVersion?.styleGuideVersionId ?? "none",
    },
    {
      key: "reference",
      label: "Glossary reference",
      value: settings.branchReference?.referenceId ?? "none",
    },
    {
      key: "hash",
      label: "Glossary hash",
      value: settings.branchReference?.glossaryContentHash ?? "not captured",
    },
  ];
  return (
    <Panel
      title="Reference state"
      eyebrow="styleGuide + glossary"
      lamps={<Badge status={settings.branchReference === null ? "pending" : "ready"}>backed</Badge>}
    >
      <DataTable
        caption="Branch policy reference state"
        rows={rows}
        getRowKey={(row) => row.key}
        columns={[
          { key: "label", header: "Field", render: (row) => row.label },
          { key: "value", header: "Value", render: (row) => row.value },
        ]}
      />
      {settings.branchReference !== null && (
        <p className="branch-policy-settings__reference-note">
          {`${settings.branchReference.glossaryTermCount} terms`}
        </p>
      )}
    </Panel>
  );
}

function initialDraft(settings: ApiBranchPolicySettingsResponse): BranchPolicyDraft {
  return {
    tone: rulesToText(settings.policy.sections.tone),
    honorifics: rulesToText(settings.policy.sections.honorifics),
    protectedSpans: rulesToText(settings.policy.sections.protectedSpans),
    ruby: rulesToText(settings.policy.sections.formatting),
    profanity: rulesToText(settings.policy.sections.terminology),
    updateReason:
      settings.branchReference === null ? "Create branch policy" : "Update branch policy",
  };
}

function draftToPolicy(
  draft: BranchPolicyDraft,
  currentPolicy: ApiBranchPolicyPolicy,
): ApiBranchPolicyPolicy {
  return {
    schemaVersion: "style-guide-policy.v0",
    sections: {
      tone: textToRules(draft.tone, currentPolicy.sections.tone, "tone"),
      terminology: textToRules(draft.profanity, currentPolicy.sections.terminology, "profanity"),
      honorifics: textToRules(draft.honorifics, currentPolicy.sections.honorifics, "honorifics"),
      formatting: textToRules(draft.ruby, currentPolicy.sections.formatting, "ruby"),
      protectedSpans: textToRules(
        draft.protectedSpans,
        currentPolicy.sections.protectedSpans,
        "protected_spans",
      ),
    },
  };
}

function rulesToText(rules: readonly ApiBranchPolicyRule[]): string {
  return rules.map((rule) => rule.guidance).join("\n");
}

function textToRules(
  text: string,
  existing: readonly ApiBranchPolicyRule[],
  prefix: string,
): ApiBranchPolicyRule[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((guidance, index) => ({
      ruleId: existing[index]?.ruleId ?? `${prefix}.${index + 1}`,
      guidance,
    }));
}
