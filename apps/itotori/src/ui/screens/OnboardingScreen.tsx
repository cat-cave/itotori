import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { CatalogOpportunityRow } from "@itotori/db";
import { Badge, Panel } from "@itotori/ds";
import type { BridgeBundle, BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type { ApiCallSettledState, ApiClientError, ApiRouteResponse } from "../../api-client.js";
import {
  assertBridgeInput,
  type ApiConfigureAuthSsoSettingsRequest,
  type ApiProjectImportRequest,
} from "../../api-schema.js";
import { apiClient } from "../client.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import "./OnboardingScreen.css";

export const onboardingRoutePathRegex = /^\/onboarding\/?$/u;

type StepPhase = "pending" | "loading" | "ready" | "error";
type MutationStep =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; message: string }
  | { state: "error"; message: string };

type ImportedProject = ApiRouteResponse<"imports.bridge">["project"];

export function parseOnboardingRoute(pathname: string): Record<string, never> | null {
  return onboardingRoutePathRegex.test(pathname) ? {} : null;
}

export function OnboardingScreen(): ReactNode {
  const identity = useApiQuery("auth.identity", {}, "onboarding:identity");
  const projects = useApiQuery("projects.list", {}, "onboarding:projects");
  const opportunities = useApiQuery(
    "catalog.opportunities",
    {},
    "onboarding:catalog-opportunities",
  );
  const [sso, setSso] = useState<MutationStep>({ state: "idle" });
  const [bootstrap, setBootstrap] = useState<MutationStep>({ state: "idle" });
  const [bridgeFile, setBridgeFile] = useState<File | null>(null);
  const [targetLocale, setTargetLocale] = useState("en-US");
  const [selectedWorkId, setSelectedWorkId] = useState("");
  const [wizardProject, setWizardProject] = useState<ImportedProject | null>(null);
  const [readyStatus, setReadyStatus] = useState<
    ApiRouteResponse<"branches.draft">["status"] | null
  >(null);

  const accountId =
    identity.state === "ready" ? (identity.data.accounts[0]?.accountId ?? null) : null;
  const projectCount = projects.state === "ready" ? projects.data.projects.length : 0;
  const candidateRows =
    opportunities.state === "ready"
      ? opportunities.data.rows.filter((row) => row.decision === "candidate")
      : [];
  const selectedCandidate =
    candidateRows.find((row) => row.workId === selectedWorkId) ?? candidateRows[0] ?? null;
  const candidateReady = selectedCandidate !== null;
  const bridgeReady = bridgeFile !== null;
  const bootstrapDisabledReason = !candidateReady
    ? "Pick a catalog candidate before bootstrapping."
    : !bridgeReady
      ? "Choose a bridge JSON export for the selected candidate."
      : targetLocale.trim().length === 0
        ? "Target locale is required."
        : null;
  const readyBranch =
    readyStatus?.localeBranches.find(
      (entry) => entry.localeBranchId === readyStatus.selectedLocaleBranchId,
    ) ?? null;
  const readyHref =
    readyStatus === null || readyStatus.selectedLocaleBranchId === null
      ? null
      : `/workspace/scenes?projectId=${encodeURIComponent(
          readyStatus.projectId,
        )}&localeBranchId=${encodeURIComponent(readyStatus.selectedLocaleBranchId)}`;

  const configureSso = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (accountId === null) {
      setSso({ state: "error", message: "Account identity has not loaded yet." });
      return;
    }
    const form = new FormData(event.currentTarget);
    const body: ApiConfigureAuthSsoSettingsRequest = {
      accountId,
      provider: {
        protocol: "oidc",
        providerId: formString(form, "providerId"),
        displayName: formString(form, "displayName"),
        enabled: true,
        issuer: formString(form, "issuer"),
        clientId: formString(form, "clientId"),
        scopes: ["openid", "profile", "email"],
      },
      security: { requireSso: false, requireMfa: true, allowPasswordLogin: true },
      sessionPolicy: { idleTimeoutMinutes: 60, absoluteTimeoutMinutes: 720 },
    };
    setSso({ state: "loading" });
    const result = await apiClient.request("auth.ssoSettings.configure", { body });
    setSso(stepFromResult(result, "Security setup saved."));
  };

  const bootstrapProject = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const candidate = selectedCandidate;
    const locale = targetLocale.trim();
    if (candidate === null) {
      setBootstrap({ state: "error", message: "Pick a catalog candidate before bootstrapping." });
      return;
    }
    if (bridgeFile === null) {
      setBootstrap({
        state: "error",
        message: "Choose a bridge JSON export for the selected candidate.",
      });
      return;
    }
    if (locale.length === 0) {
      setBootstrap({ state: "error", message: "Target locale is required." });
      return;
    }

    setBootstrap({ state: "loading" });
    try {
      const parsed: unknown = JSON.parse(await readFileText(bridgeFile));
      assertBridgeInput(parsed);
      const bootstrapSelection = bootstrapSelectionFor(candidate.workId, candidateRows);
      const importRequest: ApiProjectImportRequest = {
        bridge: parsed,
        ...(bootstrapSelection === undefined ? {} : { bootstrapSelection }),
      };
      const importResult = await apiClient.request("imports.bridge", { body: importRequest });
      if (importResult.state !== "ready") {
        setBootstrap(stepFromResult(importResult, "Project imported."));
        return;
      }

      const branchReadyProject = projectStateForBranch(importResult.data.project, locale);
      if (branchReadyProject === null) {
        setBootstrap({
          state: "error",
          message: "Imported bridge has no units to draft into a locale branch.",
        });
        return;
      }
      setWizardProject(branchReadyProject);
      setReadyStatus(null);

      const branchResult = await apiClient.request("branches.draft", {
        pathParams: { projectId: branchReadyProject.projectId },
        body: { project: branchReadyProject, targetLocale: locale },
      });
      if (branchResult.state !== "ready") {
        setBootstrap(stepFromResult(branchResult, "Project bootstrapped."));
        return;
      }
      if (!isBranchReady(branchReadyProject, branchResult.data.project)) {
        setBootstrap({
          state: "error",
          message: "Locale branch was not created because no units were drafted.",
        });
        return;
      }

      setWizardProject(branchResult.data.project);
      setReadyStatus(branchResult.data.status);
      setBootstrap({
        state: "ready",
        message: `Project bootstrapped from ${candidate.canonicalTitle}.`,
      });
    } catch (error) {
      setBootstrap({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <main className="itotori-shell onboarding-screen" data-screen="onboarding">
      <ShellHeader eyebrow="First run" title="Guided setup">
        <Badge status={readyStatus === null ? "pending" : "ready"}>
          {readyStatus === null ? "setup in progress" : "ready to localize"}
        </Badge>
      </ShellHeader>

      <Panel title="First-run path" eyebrow="Setup to first project">
        <div className="onboarding-screen__grid" aria-label="First-run steps">
          <StepCard
            phase={phaseFromIdentity(identity.state, sso.state)}
            title="Account setup"
            body={
              accountId === null
                ? "Loading account context."
                : `Using account ${accountId}; security setup stays in the dashboard.`
            }
          />
          <StepCard
            phase={phaseFromCatalog(opportunities.state, bootstrap.state, candidateReady)}
            title="Candidate"
            body={
              selectedCandidate === null
                ? "Pick a ranked catalog candidate."
                : `${selectedCandidate.canonicalTitle} is selected for bootstrap.`
            }
          />
          <StepCard
            phase={bootstrap.state === "ready" ? "ready" : bridgeReady ? "ready" : "pending"}
            title="Import bridge"
            body={
              bridgeFile === null
                ? "Choose the bridge JSON exported from the selected candidate."
                : `${bridgeFile.name} is ready to import.`
            }
          />
          <StepCard
            phase={readyStatus === null ? "pending" : "ready"}
            title="Locale branch"
            body={
              readyStatus === null
                ? `Create ${targetLocale.trim() || "the target locale"} and unlock the workspace handoff.`
                : "Workspace links are ready for localization work."
            }
          />
        </div>
      </Panel>

      <section className="onboarding-screen__forms" aria-label="Guided setup forms">
        <Panel title="Account security" eyebrow="Settings">
          {identity.state === "loading" && <LoadingState label="Loading account identity..." />}
          {identity.state === "error" && (
            <ErrorState title="Account identity" error={identity.error} />
          )}
          {identity.state === "empty" && (
            <EmptyState title="No account" message="No account membership was returned." />
          )}
          {identity.state === "ready" && (
            <form
              className="onboarding-screen__form"
              onSubmit={(event) => void configureSso(event)}
            >
              <p>
                Save account security defaults in the dashboard. Localization defaults continue from
                the workspace policy attached to the selected project.
              </p>
              <label className="onboarding-screen__field">
                <span>Provider id</span>
                <input name="providerId" defaultValue="itotori-first-run" required />
              </label>
              <label className="onboarding-screen__field">
                <span>Display name</span>
                <input name="displayName" defaultValue="First-run OIDC" required />
              </label>
              <label className="onboarding-screen__field">
                <span>Issuer URL</span>
                <input name="issuer" type="url" required />
              </label>
              <label className="onboarding-screen__field">
                <span>Client id</span>
                <input name="clientId" defaultValue="itotori-settings" required />
              </label>
              <StepActions submitLabel="Save account setup" step={sso} />
            </form>
          )}
        </Panel>

        <Panel title="Bootstrap project" eyebrow="New project">
          {projects.state === "loading" && <LoadingState label="Loading projects..." />}
          {projects.state === "error" && <ErrorState title="Projects" error={projects.error} />}
          {projects.state === "empty" && (
            <p className="onboarding-screen__status">No projects are visible yet.</p>
          )}
          {projects.state === "ready" && (
            <p className="onboarding-screen__status">{`${projectCount} project(s) already visible.`}</p>
          )}
          {opportunities.state === "loading" && (
            <LoadingState label="Loading catalog candidates..." />
          )}
          {opportunities.state === "error" && (
            <ErrorState title="Catalog candidates" error={opportunities.error} />
          )}
          {opportunities.state === "empty" && (
            <EmptyState
              title="Catalog candidates"
              message="No catalog candidates were returned by the API."
            />
          )}
          <form
            className="onboarding-screen__form"
            onSubmit={(event) => void bootstrapProject(event)}
          >
            <label className="onboarding-screen__field">
              <span>Candidate</span>
              <select
                aria-label="Candidate"
                value={selectedCandidate?.workId ?? ""}
                onChange={(event) => setSelectedWorkId(event.currentTarget.value)}
                required
              >
                {candidateRows.length === 0 && <option value="">No candidates</option>}
                {candidateRows.map((row) => (
                  <option key={row.workId} value={row.workId}>
                    {candidateLabel(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="onboarding-screen__field">
              <span>Target locale</span>
              <input
                aria-label="Target locale"
                value={targetLocale}
                onChange={(event) => setTargetLocale(event.currentTarget.value)}
                required
              />
            </label>
            <label className="onboarding-screen__field">
              <span>Bridge export</span>
              <input
                aria-label="Bridge export"
                type="file"
                accept="application/json,.json"
                onChange={handleBridgeFile(setBridgeFile)}
              />
            </label>
            <StepActions
              submitLabel="Bootstrap project"
              step={bootstrap}
              disabled={bootstrapDisabledReason !== null}
              disabledReason={bootstrapDisabledReason}
            />
          </form>
          {selectedCandidate !== null && (
            <p className="onboarding-screen__status">{candidateSummary(selectedCandidate)}</p>
          )}
          {wizardProject !== null && readyStatus === null && bootstrap.state === "loading" && (
            <p className="onboarding-screen__status">{`${wizardProject.projectId} imported; creating locale branch.`}</p>
          )}
          {readyStatus !== null && readyHref !== null && (
            <div className="onboarding-screen__handoff">
              <p>{`${readyStatus.name} is ready for localization in ${readyBranch?.targetLocale ?? "the selected locale"}.`}</p>
              <a href={readyHref}>Open workspace scenes</a>
            </div>
          )}
        </Panel>
      </section>
    </main>
  );
}

function StepCard({
  phase,
  title,
  body,
}: {
  phase: StepPhase;
  title: string;
  body: string;
}): ReactNode {
  const status = phase === "ready" ? "ready" : phase === "error" ? "failed" : "pending";
  return (
    <section className="onboarding-screen__step" aria-label={`${title} step`}>
      <Badge status={status}>{phase}</Badge>
      <div className="onboarding-screen__step-body">
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
    </section>
  );
}

function StepActions({
  submitLabel,
  step,
  disabled = false,
  disabledReason = null,
}: {
  submitLabel: string;
  step: MutationStep;
  disabled?: boolean;
  disabledReason?: string | null;
}): ReactNode {
  return (
    <div className="onboarding-screen__actions">
      <button type="submit" disabled={disabled || step.state === "loading"}>
        {step.state === "loading" ? "Saving..." : submitLabel}
      </button>
      {disabled && disabledReason !== null && step.state === "idle" && (
        <span className="onboarding-screen__hint">{disabledReason}</span>
      )}
      {step.state === "ready" && <span role="status">{step.message}</span>}
      {step.state === "error" && <span role="alert">{step.message}</span>}
    </div>
  );
}

function phaseFromIdentity(identityState: string, ssoState: MutationStep["state"]): StepPhase {
  if (ssoState === "ready") {
    return "ready";
  }
  if (ssoState === "error" || identityState === "error") {
    return "error";
  }
  return identityState === "loading" || ssoState === "loading" ? "loading" : "pending";
}

function phaseFromCatalog(
  catalogState: string,
  importState: MutationStep["state"],
  hasSelectedCandidate: boolean,
): StepPhase {
  if (importState === "ready" || hasSelectedCandidate) {
    return "ready";
  }
  if (importState === "error" || catalogState === "error") {
    return "error";
  }
  return catalogState === "loading" || importState === "loading" ? "loading" : "pending";
}

function stepFromResult<T>(result: ApiCallSettledState<T>, readyMessage: string): MutationStep {
  if (result.state === "ready") {
    return { state: "ready", message: readyMessage };
  }
  if (result.state === "empty") {
    return { state: "error", message: "The API returned an empty response." };
  }
  return { state: "error", message: apiErrorMessage(result.error) };
}

function apiErrorMessage(error: ApiClientError): string {
  return error.message ?? `Request failed with status ${String(error.status)}.`;
}

function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function handleBridgeFile(setBridgeFile: (file: File | null) => void) {
  return (event: ChangeEvent<HTMLInputElement>): void => {
    setBridgeFile(event.currentTarget.files?.[0] ?? null);
  };
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read selected file."));
    reader.readAsText(file);
  });
}

function projectStateForBranch(
  project: ImportedProject,
  targetLocale: string,
): ImportedProject | null {
  return bridgeHasUnits(project.bridge) ? { ...project, targetLocale } : null;
}

function bridgeHasUnits(bridge: BridgeBundle | BridgeBundleV02): boolean {
  return bridge.units.length > 0;
}

function isBranchReady(requestProject: ImportedProject, responseProject: ImportedProject): boolean {
  return Object.keys(responseProject.drafts).length > 0 || bridgeHasUnits(requestProject.bridge);
}

function candidateLabel(row: CatalogOpportunityRow): string {
  return `${row.canonicalTitle} (${row.workId})`;
}

function candidateSummary(row: CatalogOpportunityRow): string {
  const sourceId = row.sourceIds[0];
  const sourceLabel =
    sourceId === undefined ? "no source id" : `${sourceId.catalogSource}:${sourceId.sourceId}`;
  return `Selected ${row.canonicalTitle}; ${sourceLabel}; adapter ${row.adapterId ?? "unknown"}.`;
}

function bootstrapSelectionFor(
  selectedWorkId: string,
  candidates: CatalogOpportunityRow[],
): ApiProjectImportRequest["bootstrapSelection"] {
  return {
    selectedWorkId,
    candidates: candidates.map((candidate) => ({
      workId: candidate.workId,
      canonicalTitle: candidate.canonicalTitle,
      sourceIds: candidate.sourceIds,
      adapterId: candidate.adapterId,
    })),
  };
}
