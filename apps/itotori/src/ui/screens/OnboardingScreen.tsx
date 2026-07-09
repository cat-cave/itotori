import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { ProjectDashboardStatus } from "@itotori/db";
import { Badge, Panel } from "@itotori/ds";
import type { BridgeBundle, BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type { ApiCallSettledState, ApiClientError, ApiRouteResponse } from "../../api-client.js";
import { assertBridgeInput, type ApiConfigureAuthSsoSettingsRequest } from "../../api-schema.js";
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
type WizardProject = ImportedProject | ProjectDashboardStatus;

export function parseOnboardingRoute(pathname: string): Record<string, never> | null {
  return onboardingRoutePathRegex.test(pathname) ? {} : null;
}

export function OnboardingScreen(): ReactNode {
  const identity = useApiQuery("auth.identity", {}, "onboarding:identity");
  const projects = useApiQuery("projects.list", {}, "onboarding:projects");
  const [sso, setSso] = useState<MutationStep>({ state: "idle" });
  const [projectCreate, setProjectCreate] = useState<MutationStep>({ state: "idle" });
  const [advancedImport, setAdvancedImport] = useState<MutationStep>({ state: "idle" });
  const [branch, setBranch] = useState<MutationStep>({ state: "idle" });
  const [bridgeFile, setBridgeFile] = useState<File | null>(null);
  const [projectName, setProjectName] = useState("Untitled project");
  const [sourceLocale, setSourceLocale] = useState("ja-JP");
  const [targetLocale, setTargetLocale] = useState("en-US");
  const [wizardProject, setWizardProject] = useState<WizardProject | null>(null);
  const [readyStatus, setReadyStatus] = useState<
    ApiRouteResponse<"branches.draft">["status"] | null
  >(null);

  const accountId =
    identity.state === "ready" ? (identity.data.accounts[0]?.accountId ?? null) : null;
  const projectCount = projects.state === "ready" ? projects.data.projects.length : 0;
  const existingProject =
    projects.state === "ready" && projects.data.projects.length > 0
      ? (projects.data.projects[0] ?? null)
      : null;
  const branchProject = wizardProject ?? existingProject;
  const accountSetupReady = sso.state === "ready";
  const projectReady = branchProject !== null && hasBranchDraftInput(branchProject);
  const branchDisabledReason = !accountSetupReady
    ? "Save account setup before creating a locale branch."
    : branchProject === null
      ? "Create or import a project before setting a locale branch."
      : !hasBranchDraftInput(branchProject)
        ? "Create or import a project with bridge units before setting a locale branch."
        : projectBranchId(branchProject) === null
          ? "Choose a project with an available locale branch."
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

  const createProject = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const name = projectName.trim();
    const locale = sourceLocale.trim();
    if (name.length === 0) {
      setProjectCreate({ state: "error", message: "Project name is required." });
      return;
    }
    if (locale.length === 0) {
      setProjectCreate({ state: "error", message: "Source language is required." });
      return;
    }
    setProjectCreate({ state: "loading" });
    const result = await apiClient.request("imports.bridge", {
      body: { bridge: projectWizardBridge({ name, sourceLocale: locale }) },
    });
    if (result.state === "ready") {
      setWizardProject(result.data.project);
      setReadyStatus(null);
      setProjectCreate({ state: "ready", message: "Project created." });
      return;
    }
    setProjectCreate(stepFromResult(result, "Project created."));
  };

  const chooseExistingProject = (project: ProjectDashboardStatus): void => {
    setWizardProject(project);
    setReadyStatus(null);
    setProjectCreate({ state: "ready", message: `Using ${project.name}.` });
  };

  const importBridge = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (bridgeFile === null) {
      setAdvancedImport({ state: "error", message: "Choose a bridge export file first." });
      return;
    }
    setAdvancedImport({ state: "loading" });
    try {
      const parsed: unknown = JSON.parse(await readFileText(bridgeFile));
      assertBridgeInput(parsed);
      const result = await apiClient.request("imports.bridge", { body: { bridge: parsed } });
      if (result.state === "ready") {
        setWizardProject(result.data.project);
        setReadyStatus(null);
        setAdvancedImport({ state: "ready", message: "Bridge project imported." });
        return;
      }
      setAdvancedImport(stepFromResult(result, "Bridge project imported."));
    } catch (error) {
      setAdvancedImport({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const createBranch = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!accountSetupReady) {
      setBranch({ state: "error", message: "Save account setup before creating a locale branch." });
      return;
    }
    if (branchProject === null) {
      setBranch({
        state: "error",
        message: "Create or import a project before setting a locale branch.",
      });
      return;
    }
    const locale = targetLocale.trim();
    if (locale.length === 0) {
      setBranch({ state: "error", message: "Target locale is required." });
      return;
    }
    const branchReadyProject = projectStateForBranch(branchProject, locale);
    if (branchReadyProject === null) {
      setBranch({
        state: "error",
        message: "Create or import a project with bridge units before setting a locale branch.",
      });
      return;
    }
    setBranch({ state: "loading" });
    const result = await apiClient.request("branches.draft", {
      pathParams: { projectId: branchReadyProject.projectId },
      body: { project: branchReadyProject, targetLocale: locale },
    });
    if (result.state === "ready") {
      if (!isBranchReady(branchReadyProject, result.data.project)) {
        setBranch({
          state: "error",
          message: "Locale branch was not created because no units were drafted.",
        });
        return;
      }
      setReadyStatus(result.data.status);
      setBranch({ state: "ready", message: "Locale branch created." });
      return;
    }
    setBranch(stepFromResult(result, "Locale branch created."));
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
            phase={phaseFromProjects(projects.state, projectCreate.state, projectReady)}
            title="Project"
            body={
              branchProject !== null && hasBranchDraftInput(branchProject)
                ? `Project ${projectLabel(branchProject)} is ready for locale setup.`
                : existingProject === null
                  ? "Create a project with a name and source language."
                  : `${projectCount} project(s) are visible; create a project with bridge units or import bridge JSON.`
            }
          />
          <StepCard
            phase={phaseFromMutation(branch)}
            title="Set locale branch"
            body={
              branchDisabledReason !== null
                ? branchDisabledReason
                : `Ready to create ${targetLocale.trim() || "a target locale"} for ${
                    branchProject?.projectId ?? "the selected project"
                  }.`
            }
          />
          <StepCard
            phase={readyStatus === null ? "pending" : "ready"}
            title="Next steps"
            body={
              readyStatus === null
                ? "Set the branch to unlock the workspace handoff."
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

        <Panel title="New project" eyebrow="Wizard">
          {projects.state === "loading" && <LoadingState label="Loading projects..." />}
          {projects.state === "error" && <ErrorState title="Projects" error={projects.error} />}
          {projects.state === "empty" && (
            <p className="onboarding-screen__status">No projects are visible yet.</p>
          )}
          {projects.state === "ready" && (
            <p className="onboarding-screen__status">{`${projectCount} project(s) already visible.`}</p>
          )}
          <form className="onboarding-screen__form" onSubmit={(event) => void createProject(event)}>
            <label className="onboarding-screen__field">
              <span>Project name</span>
              <input
                aria-label="Project name"
                value={projectName}
                onChange={(event) => setProjectName(event.currentTarget.value)}
                required
              />
            </label>
            <label className="onboarding-screen__field">
              <span>Source language</span>
              <input
                aria-label="Source language"
                value={sourceLocale}
                onChange={(event) => setSourceLocale(event.currentTarget.value)}
                required
              />
            </label>
            <StepActions submitLabel="Create project" step={projectCreate} />
          </form>
          {projects.state === "ready" && projects.data.projects.length > 0 && (
            <div className="onboarding-screen__existing" aria-label="Existing projects">
              {projects.data.projects.map((project) => (
                <button
                  key={project.projectId}
                  type="button"
                  onClick={() => chooseExistingProject(project)}
                >
                  Use {project.name}
                </button>
              ))}
            </div>
          )}
          <details className="onboarding-screen__advanced">
            <summary>Advanced bridge JSON import</summary>
            <form
              className="onboarding-screen__form"
              onSubmit={(event) => void importBridge(event)}
            >
              <label className="onboarding-screen__field">
                <span>Bridge export</span>
                <input
                  aria-label="Bridge export"
                  type="file"
                  accept="application/json,.json"
                  onChange={handleBridgeFile(setBridgeFile)}
                />
              </label>
              <StepActions submitLabel="Import bridge JSON" step={advancedImport} />
            </form>
          </details>
        </Panel>

        <Panel title="Set locale branch" eyebrow="Ready to localize">
          <form className="onboarding-screen__form" onSubmit={(event) => void createBranch(event)}>
            <label className="onboarding-screen__field">
              <span>Target locale</span>
              <input
                aria-label="Target locale"
                value={targetLocale}
                onChange={(event) => setTargetLocale(event.currentTarget.value)}
                required
              />
            </label>
            <StepActions
              submitLabel="Create locale branch"
              step={branch}
              disabled={branchDisabledReason !== null}
              disabledReason={branchDisabledReason}
            />
          </form>
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

function phaseFromProjects(
  projectsState: string,
  importState: MutationStep["state"],
  hasImportedProject: boolean,
): StepPhase {
  if (importState === "ready" || hasImportedProject) {
    return "ready";
  }
  if (importState === "error" || projectsState === "error") {
    return "error";
  }
  return projectsState === "loading" || importState === "loading" ? "loading" : "pending";
}

function phaseFromMutation(step: MutationStep): StepPhase {
  if (step.state === "ready") {
    return "ready";
  }
  if (step.state === "error") {
    return "error";
  }
  return step.state === "loading" ? "loading" : "pending";
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

function projectWizardBridge({
  name,
  sourceLocale,
}: {
  name: string;
  sourceLocale: string;
}): BridgeBundle {
  const slug = slugify(name);
  return {
    schemaVersion: "0.1.0",
    bridgeId: `wizard-${slug}`,
    sourceBundleHash: `wizard:${slug}:${sourceLocale}`,
    sourceLocale,
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [
      {
        bridgeUnitId: `wizard-${slug}-unit-1`,
        sourceUnitKey: `wizard.${slug}.scene.001.line.001`,
        occurrenceId: `wizard-${slug}-occurrence-1`,
        sourceHash: `wizard:${slug}:unit-1`,
        sourceLocale,
        sourceText: "こんにちは、{player}。",
        textSurface: "dialogue",
        protectedSpans: [
          { kind: "placeholder", raw: "{player}", start: 18, end: 26, preserveMode: "exact" },
        ],
        patchRef: {
          assetId: `wizard-${slug}.json`,
          writeMode: "replace",
          sourceUnitKey: `wizard.${slug}.scene.001.line.001`,
        },
      },
    ],
  };
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug.length === 0 ? "project" : slug;
}

function projectLabel(project: WizardProject): string {
  return "name" in project ? project.name : project.projectId;
}

function projectBranchId(project: WizardProject): string | null {
  if ("bridge" in project) {
    return project.localeBranchId;
  }
  return project.selectedLocaleBranchId ?? project.localeBranches[0]?.localeBranchId ?? null;
}

function projectStateForBranch(
  project: WizardProject,
  targetLocale: string,
): ImportedProject | null {
  if ("bridge" in project) {
    return bridgeHasUnits(project.bridge) ? { ...project, targetLocale } : null;
  }
  return null;
}

function hasBranchDraftInput(project: WizardProject): boolean {
  return "bridge" in project && bridgeHasUnits(project.bridge) && projectBranchId(project) !== null;
}

function bridgeHasUnits(bridge: BridgeBundle | BridgeBundleV02): boolean {
  return bridge.units.length > 0;
}

function isBranchReady(requestProject: ImportedProject, responseProject: ImportedProject): boolean {
  return Object.keys(responseProject.drafts).length > 0 || bridgeHasUnits(requestProject.bridge);
}
