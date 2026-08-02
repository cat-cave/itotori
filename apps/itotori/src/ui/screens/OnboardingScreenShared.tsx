import type { ReactNode } from "react";
import type { CatalogOpportunityRow } from "@itotori/db";
import { Badge } from "@itotori/ds";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type { ApiCallSettledState, ApiClientError, ApiRouteResponse } from "../../api-client.js";
import type { ApiProjectDecodeExtractRequest, ApiProjectImportRequest } from "../../api-schema.js";
import {
  extractCapabilities,
  type ExtractCapability,
  type ExtractFormField,
  type ExtractModeCapability,
} from "../../extract/extract-adapter-registry.js";

export const onboardingRoutePathRegex = /^\/onboarding\/?$/u;

type StepPhase = "pending" | "loading" | "ready" | "error";
export type MutationStep =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; message: string }
  | { state: "error"; message: string };

export type ImportedProject = ApiRouteResponse<"imports.bridge">["project"];
// p3-in-studio-decode-extract-trigger — the bridge the real decode/extract
// pipeline produced, ready to feed the SAME importBridge ingestion path the
// manual upload used.
export type DecodedBridge = ApiRouteResponse<"projects.decodeExtract">["bridge"];
export type ReadyStatus = ApiRouteResponse<"branches.draft">["status"];

// The form reads this registry capability descriptor directly; it has no
// engine default or duplicate field/mode catalogue of its own.
export const STUDIO_EXTRACT_CAPABILITIES = extractCapabilities();

export function parseOnboardingRoute(pathname: string): Record<string, never> | null {
  return onboardingRoutePathRegex.test(pathname) ? {} : null;
}

export function readyBranchAndHref(readyStatus: ReadyStatus | null): {
  readyBranch: NonNullable<ReadyStatus>["localeBranches"][number] | null;
  readyHref: string | null;
} {
  const readyBranch =
    readyStatus?.localeBranches.find(
      (entry) => entry.localeBranchId === readyStatus.selectedLocaleBranchId,
    ) ?? null;
  const readyHref =
    readyStatus === null || readyStatus.selectedLocaleBranchId === null
      ? null
      : `/play?localeBranchId=${encodeURIComponent(readyStatus.selectedLocaleBranchId)}`;
  return { readyBranch, readyHref };
}

export function StepCard({
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

export function StepActions({
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

export function phaseFromIdentity(
  identityState: string,
  ssoState: MutationStep["state"],
): StepPhase {
  if (ssoState === "ready") {
    return "ready";
  }
  if (ssoState === "error" || identityState === "error") {
    return "error";
  }
  return identityState === "loading" || ssoState === "loading" ? "loading" : "pending";
}

export function phaseFromCatalog(
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

export function phaseFromDecode(
  decodeState: MutationStep["state"],
  bridgeReady: boolean,
): StepPhase {
  if (decodeState === "loading") {
    return "loading";
  }
  if (decodeState === "error") {
    return "error";
  }
  return bridgeReady ? "ready" : "pending";
}

export function stepFromResult<T>(
  result: ApiCallSettledState<T>,
  readyMessage: string,
): MutationStep {
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

export function formString(form: FormData, key: string): string {
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

export function extractInitialValues(
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

export function projectStateForBranch(
  project: ImportedProject,
  targetLocale: string,
): ImportedProject | null {
  return bridgeHasUnits(project.bridge) ? { ...project, targetLocale } : null;
}

function bridgeHasUnits(bridge: BridgeBundleV02): boolean {
  return bridge.units.length > 0;
}

export function isBranchReady(
  requestProject: ImportedProject,
  responseProject: ImportedProject,
): boolean {
  return Object.keys(responseProject.drafts).length > 0 || bridgeHasUnits(requestProject.bridge);
}

export function candidateLabel(row: CatalogOpportunityRow): string {
  return `${row.canonicalTitle} (${row.workId})`;
}

export function candidateSummary(row: CatalogOpportunityRow): string {
  const sourceId = row.sourceIds[0];
  const sourceLabel =
    sourceId === undefined ? "no source id" : `${sourceId.catalogSource}:${sourceId.sourceId}`;
  return `Selected ${row.canonicalTitle}; ${sourceLabel}; adapter ${row.adapterId ?? "unknown"}.`;
}

export function bootstrapSelectionFor(
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
