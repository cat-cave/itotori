import { useState, type FormEvent, type ReactNode } from "react";
import type { CatalogOpportunityRow } from "@itotori/db";
import { Badge, Panel } from "@itotori/ds";
import type { BridgeBundle, BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type { ApiCallSettledState, ApiClientError, ApiRouteResponse } from "../../api-client.js";
import type {
  ApiConfigureAuthSsoSettingsRequest,
  ApiProjectDecodeExtractRequest,
  ApiProjectImportRequest,
} from "../../api-schema.js";
import {
  extractCapabilities,
  type ExtractCapability,
  type ExtractEngineId,
  type ExtractFormField,
  type ExtractModeCapability,
} from "../../extract/extract-adapter-registry.js";
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
// p3-in-studio-decode-extract-trigger — the bridge the real decode/extract
// pipeline produced, ready to feed the SAME importBridge ingestion path the
// manual upload used.
type DecodedBridge = ApiRouteResponse<"projects.decodeExtract">["bridge"];

// The form reads this registry capability descriptor directly; it has no
// engine default or duplicate field/mode catalogue of its own.
const STUDIO_EXTRACT_CAPABILITIES = extractCapabilities();

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
  const [targetLocale, setTargetLocale] = useState("en-US");
  const [selectedWorkId, setSelectedWorkId] = useState("");
  const [wizardProject, setWizardProject] = useState<ImportedProject | null>(null);
  const [readyStatus, setReadyStatus] = useState<
    ApiRouteResponse<"branches.draft">["status"] | null
  >(null);

  // p3-in-studio-decode-extract-trigger — the in-studio decode/extract inputs.
  // These REPLACE the manual bridge-JSON upload: the operator points the Studio
  // at a game source + identity + mode, and the trigger runs the REAL
  // identify -> inventory -> extract pipeline server-side to produce the bridge.
  const [decode, setDecode] = useState<MutationStep>({ state: "idle" });
  const [decodedBridge, setDecodedBridge] = useState<DecodedBridge | null>(null);
  const [selectedExtractEngine, setSelectedExtractEngine] = useState<ExtractEngineId | "">("");
  const [selectedExtractMode, setSelectedExtractMode] = useState("");
  const [extractValues, setExtractValues] = useState<Record<string, string>>({});

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
  const bridgeReady = decodedBridge !== null;
  const selectedExtractCapability = STUDIO_EXTRACT_CAPABILITIES.find(
    (capability) => capability.engine === selectedExtractEngine,
  );
  const selectedExtractModeCapability = selectedExtractCapability?.modes.find(
    (mode) => mode.id === selectedExtractMode,
  );

  const decodeDisabledReason = decodeDisabledReasonFor(
    selectedExtractCapability,
    selectedExtractModeCapability,
    extractValues,
  );
  const bootstrapDisabledReason = !candidateReady
    ? "Pick a catalog candidate before bootstrapping."
    : !bridgeReady
      ? "Decode a game source into a bridge for the selected candidate."
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
      : `/play?localeBranchId=${encodeURIComponent(readyStatus.selectedLocaleBranchId)}`;

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

  // p3-in-studio-decode-extract-trigger — the "decode from game path" trigger.
  // Runs the REAL identify -> inventory -> extract pipeline (kaifuu-cli extract)
  // server-side and stores the produced bridge for the bootstrap step. This
  // replaces the manual bridge-JSON upload as the primary on-ramp.
  const runDecodeExtract = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const reason = decodeDisabledReason;
    if (reason !== null) {
      setDecode({ state: "error", message: reason });
      return;
    }
    if (selectedExtractCapability === undefined || selectedExtractModeCapability === undefined) {
      setDecode({ state: "error", message: "Choose an extract adapter and mode." });
      return;
    }
    const request = buildDecodeExtractRequest(
      selectedExtractCapability,
      selectedExtractModeCapability,
      extractValues,
    );
    setDecode({ state: "loading" });
    setDecodedBridge(null);
    const result = await apiClient.request("projects.decodeExtract", { body: request });
    if (result.state !== "ready") {
      setDecodedBridge(null);
      setDecode(stepFromResult(result, "Decode complete."));
      return;
    }
    setDecodedBridge(result.data.bridge);
    setDecode({
      state: "ready",
      message: `Decoded ${String(result.data.bridge.units.length)} unit(s) (${result.data.mode}).`,
    });
  };

  const bootstrapProject = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const candidate = selectedCandidate;
    const locale = targetLocale.trim();
    if (candidate === null) {
      setBootstrap({ state: "error", message: "Pick a catalog candidate before bootstrapping." });
      return;
    }
    if (decodedBridge === null) {
      setBootstrap({
        state: "error",
        message: "Decode a game source into a bridge for the selected candidate.",
      });
      return;
    }
    if (locale.length === 0) {
      setBootstrap({ state: "error", message: "Target locale is required." });
      return;
    }

    setBootstrap({ state: "loading" });
    try {
      const bootstrapSelection = bootstrapSelectionFor(candidate.workId, candidateRows);
      const importRequest: ApiProjectImportRequest = {
        bridge: decodedBridge,
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
          message: "Decoded bridge has no units to draft into a locale branch.",
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
      if (branchResult.data.outcome === "refused") {
        setBootstrap({ state: "error", message: branchResult.data.refusalMessage });
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
            phase={phaseFromDecode(decode.state, bridgeReady)}
            title="Decode & extract"
            body={
              decodedBridge === null
                ? "Point the Studio at a game source and run identify, inventory, and extract."
                : `${String(decodedBridge.units.length)} unit(s) decoded and ready to bootstrap.`
            }
          />
          <StepCard
            phase={readyStatus === null ? "pending" : "ready"}
            title="Locale branch"
            body={
              readyStatus === null
                ? `Create ${targetLocale.trim() || "the target locale"} and unlock patch iteration.`
                : "Patch iteration is ready for localization work."
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
                the branch policy attached to the selected project.
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

        <Panel title="Decode & extract" eyebrow="Game source to bridge">
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
            aria-label="Decode and extract"
            onSubmit={(event) => void runDecodeExtract(event)}
          >
            <p>
              Point the Studio at a decrypted game source. The decode trigger runs the real
              identify, inventory, and extract pipeline server-side and produces the bridge — no
              hand-produced bridge JSON required.
            </p>
            <label className="onboarding-screen__field">
              <span>Extract adapter</span>
              <select
                aria-label="Extract adapter"
                value={selectedExtractEngine}
                onChange={(event) => {
                  const capability = STUDIO_EXTRACT_CAPABILITIES.find(
                    (candidate) => candidate.engine === event.currentTarget.value,
                  );
                  if (capability === undefined) {
                    setSelectedExtractEngine("");
                    setSelectedExtractMode("");
                    setExtractValues({});
                    return;
                  }
                  const mode = capability.modes[0];
                  setSelectedExtractEngine(capability.engine);
                  setSelectedExtractMode(mode?.id ?? "");
                  setExtractValues(extractInitialValues(capability, mode));
                }}
              >
                <option value="">Choose an adapter</option>
                {STUDIO_EXTRACT_CAPABILITIES.map((capability) => (
                  <option key={capability.engine} value={capability.engine}>
                    {capability.label}
                  </option>
                ))}
              </select>
            </label>
            {selectedExtractCapability !== undefined &&
              selectedExtractModeCapability !== undefined && (
                <>
                  <p className="onboarding-screen__status">{selectedExtractCapability.summary}</p>
                  <label className="onboarding-screen__field">
                    <span>Extract mode</span>
                    <select
                      aria-label="Extract mode"
                      value={selectedExtractMode}
                      onChange={(event) => setSelectedExtractMode(event.currentTarget.value)}
                    >
                      {selectedExtractCapability.modes.map((mode) => (
                        <option key={mode.id} value={mode.id}>
                          {mode.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {extractFormFieldsFor(
                    selectedExtractCapability,
                    selectedExtractModeCapability,
                  ).map((field) => (
                    <label className="onboarding-screen__field" key={field.key}>
                      <span>{field.label}</span>
                      <input
                        aria-label={field.label}
                        inputMode={field.input === "number" ? "numeric" : undefined}
                        min={field.min}
                        max={field.max}
                        placeholder={field.placeholder}
                        value={extractValues[field.key] ?? ""}
                        onChange={(event) =>
                          setExtractValues((values) => ({
                            ...values,
                            [field.key]: event.currentTarget.value,
                          }))
                        }
                        required={field.required}
                      />
                    </label>
                  ))}
                </>
              )}
            <StepActions
              submitLabel="Decode & extract"
              loadingLabel="Decoding..."
              step={decode}
              disabled={decodeDisabledReason !== null}
              disabledReason={decodeDisabledReason}
            />
          </form>
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
            <p className="onboarding-screen__status" role="status">
              {decodedBridge === null
                ? "Decode a game source above to produce a bridge before bootstrapping."
                : `${String(decodedBridge.units.length)} decoded unit(s) ready to import.`}
            </p>
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
              <a href={readyHref}>Open patch iteration</a>
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
  loadingLabel = "Saving...",
  step,
  disabled = false,
  disabledReason = null,
}: {
  submitLabel: string;
  loadingLabel?: string;
  step: MutationStep;
  disabled?: boolean;
  disabledReason?: string | null;
}): ReactNode {
  return (
    <div className="onboarding-screen__actions">
      <button type="submit" disabled={disabled || step.state === "loading"}>
        {step.state === "loading" ? loadingLabel : submitLabel}
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

function phaseFromDecode(decodeState: MutationStep["state"], bridgeReady: boolean): StepPhase {
  if (decodeState === "loading") {
    return "loading";
  }
  if (decodeState === "error") {
    return "error";
  }
  return bridgeReady ? "ready" : "pending";
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

/** Fields the selected adapter + mode expose to Studio. */
export function extractFormFieldsFor(
  capability: ExtractCapability,
  mode: ExtractModeCapability,
): readonly ExtractFormField[] {
  return [...capability.fields, ...mode.fields];
}

function extractInitialValues(
  capability: ExtractCapability,
  mode: ExtractModeCapability | undefined,
): Record<string, string> {
  const fields = mode === undefined ? capability.fields : extractFormFieldsFor(capability, mode);
  return Object.fromEntries(fields.map((field) => [field.key, field.defaultValue ?? ""]));
}

/**
 * The disabled reason is evaluated entirely from the adapter-supplied form
 * descriptor. A non-null value is the accessible hint shown beside submit.
 */
export function decodeDisabledReasonFor(
  capability: ExtractCapability | undefined,
  mode: ExtractModeCapability | undefined,
  values: Readonly<Record<string, string>>,
): string | null {
  if (capability === undefined) {
    return "Choose an extract adapter.";
  }
  if (mode === undefined) {
    return "Choose an extract mode.";
  }
  for (const field of extractFormFieldsFor(capability, mode)) {
    const value = values[field.key]?.trim() ?? "";
    if (field.required && value.length === 0) {
      return `${field.label} is required.`;
    }
    if (field.input === "number" && value.length > 0) {
      const parsed = Number.parseInt(value, 10);
      if (
        !Number.isInteger(parsed) ||
        String(parsed) !== value ||
        (field.min !== undefined && parsed < field.min) ||
        (field.max !== undefined && parsed > field.max)
      ) {
        const range =
          field.min !== undefined && field.max !== undefined
            ? ` between ${String(field.min)} and ${String(field.max)}`
            : "";
        return `${field.label} must be a whole number${range}.`;
      }
    }
  }
  for (const constraint of capability.constraints) {
    const supplied = constraint.fields.filter((field) => (values[field]?.trim() ?? "").length > 0);
    if (constraint.kind === "exactly-one" && supplied.length !== 1) {
      return constraint.message;
    }
  }
  return null;
}

/** Build the engine-discriminated request from selected adapter capabilities. */
export function buildDecodeExtractRequest(
  capability: ExtractCapability,
  mode: ExtractModeCapability,
  values: Readonly<Record<string, string>>,
): ApiProjectDecodeExtractRequest {
  const request: Record<string, string | number | boolean> = {
    engine: capability.engine,
    ...mode.fixedValues,
  };
  for (const field of extractFormFieldsFor(capability, mode)) {
    const value = values[field.key]?.trim() ?? "";
    if (value.length > 0) {
      request[field.key] = field.input === "number" ? Number.parseInt(value, 10) : value;
    }
  }
  return request as ApiProjectDecodeExtractRequest;
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
