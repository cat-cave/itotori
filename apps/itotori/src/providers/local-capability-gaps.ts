// ITOTORI-036 — explicit capability-gap reporting for the local
// OpenAI-compatible provider (LM Studio-style endpoints).
//
// A localhost endpoint is NOT a drop-in equivalent of the OpenRouter
// provider: it carries no OpenRouter-style ZDR attestation surface, no
// real billed cost (runs are recorded as costKind:"zero"), no provider
// routing / model fallbacks / presets, and — until an operator has
// actually measured it against their own model — no PROVEN structured
// output / tool / image support. The standing project law is that these
// gaps must be VISIBLE, never silently assumed-equivalent (audit focus:
// "Assuming local model quality", "Provider capability mismatch").
//
// This module produces a structured, greppable gap report by diffing a
// local provider descriptor's capability sheet against the OpenRouter
// baseline sheet, plus the two headline invariants a local endpoint can
// never satisfy (no ZDR attestation surface, no real billed cost). It is
// pure — no I/O, no provider call — so it can be surfaced in a smoke
// report, a dashboard line, or a log without side effects.

import { openRouterDefaultCapabilities } from "./openrouter.js";
import type {
  CapabilitySupport,
  ModelCapabilities,
  ModelProvider,
  ProviderDescriptor,
  ProviderFamily,
} from "./types.js";

export type CapabilityGapDimension =
  | "privacy"
  | "cost"
  | "routing"
  | "structured_output"
  | "tools"
  | "image";

/**
 * `hard_gap` — the local endpoint definitively lacks the capability
 * (`unsupported`, or a structural invariant like "never bills"). Callers
 * must not route work that requires it to a local provider.
 *
 * `unverified` — the capability is `untested`/`partial` on the local
 * sheet: it MIGHT work with a given local model, but it has not been
 * proven, so the pipeline must not assume equivalence. Surfacing it is
 * the whole point — a reviewer decides whether to measure it.
 */
export type CapabilityGapKind = "hard_gap" | "unverified";

export type LocalProviderCapabilityGap = {
  /** Dotted capability-sheet path, e.g. `routing.zeroDataRetentionRouting`. */
  readonly axis: string;
  readonly dimension: CapabilityGapDimension;
  /** The local provider's status on this axis. */
  readonly localStatus: string;
  /** The OpenRouter baseline's status on the same axis, for comparison. */
  readonly baselineStatus: string;
  readonly kind: CapabilityGapKind;
  readonly note: string;
};

export type LocalProviderCapabilityGapReport = {
  readonly providerName: string;
  readonly providerFamily: ProviderFamily;
  readonly baselineProviderName: string;
  /**
   * `false` for every local endpoint: there is no OpenRouter-style ZDR
   * attestation surface. (Data does not leave the host, so the privacy
   * outcome is trivially satisfied, but the ATTESTATION mechanism the
   * OpenRouter posture relies on is absent — the two are distinct.)
   */
  readonly hasZeroDataRetentionAttestation: boolean;
  /**
   * `false` for every local endpoint: localhost inference incurs no
   * upstream charge, so runs are recorded as `costKind:"zero"` and there
   * is no real billed cost to aggregate into the OpenRouter cost report.
   */
  readonly hasRealBilledCost: boolean;
  readonly gaps: readonly LocalProviderCapabilityGap[];
};

export type DescribeLocalCapabilityGapsOptions = {
  /** OpenRouter baseline sheet to diff against. Defaults to the canonical one. */
  readonly baseline?: ModelCapabilities;
  readonly baselineProviderName?: string;
};

/**
 * Compare `descriptor` (a local provider's sheet) against the OpenRouter
 * baseline and return the explicit set of capability gaps. Every axis on
 * which the local provider is not a verified `supported` is surfaced,
 * tagged with the baseline status so a reader can see whether OpenRouter
 * offers it. The two structural invariants (no ZDR attestation, no real
 * billed cost) are always reported as hard gaps for a local family.
 */
export function describeLocalProviderCapabilityGaps(
  descriptor: ProviderDescriptor,
  options: DescribeLocalCapabilityGapsOptions = {},
): LocalProviderCapabilityGapReport {
  const baseline = options.baseline ?? openRouterDefaultCapabilities;
  const baselineProviderName = options.baselineProviderName ?? "openrouter";
  const local = descriptor.capabilities;
  const gaps: LocalProviderCapabilityGap[] = [];

  // --- Cost: local endpoints never bill (structural invariant). --------
  // This is not derived from the capability sheet — it is a property of
  // the local family: there is no upstream charge, so cost is recorded as
  // costKind:"zero" and stays OUT of the OpenRouter real-cost aggregate.
  gaps.push({
    axis: "cost.billed",
    dimension: "cost",
    localStatus: "zero",
    baselineStatus: "billed",
    kind: "hard_gap",
    note: "local inference incurs no upstream charge; runs record costKind:zero and never enter the OpenRouter billed-cost report",
  });

  // --- Privacy: no OpenRouter-style ZDR attestation surface. -----------
  const hasZeroDataRetentionAttestation = local.routing.zeroDataRetentionRouting === "supported";
  if (
    baseline.routing.zeroDataRetentionRouting === "supported" &&
    !hasZeroDataRetentionAttestation
  ) {
    gaps.push({
      axis: "routing.zeroDataRetentionRouting",
      dimension: "privacy",
      localStatus: local.routing.zeroDataRetentionRouting,
      baselineStatus: baseline.routing.zeroDataRetentionRouting,
      kind: "hard_gap",
      note: "no OpenRouter-style ZDR attestation surface; localhost keeps data on-host but the attestation mechanism the OR posture relies on is absent",
    });
  }

  // --- Routing axes (provider routing / fallbacks / presets / etc.). ---
  const routingAxes: Array<{
    key: keyof ModelCapabilities["routing"];
    note: string;
  }> = [
    { key: "providerRouting", note: "no upstream provider routing (single localhost endpoint)" },
    { key: "modelFallbacks", note: "no cross-model fallback chain (single local model)" },
    { key: "presets", note: "no provider presets" },
    { key: "requireParameters", note: "no strict provider-parameter routing" },
    { key: "dataCollectionControl", note: "no wire-level data-collection control" },
  ];
  for (const { key, note } of routingAxes) {
    const localStatus = local.routing[key];
    if (localStatus === "supported") continue;
    gaps.push({
      axis: `routing.${key}`,
      dimension: "routing",
      localStatus,
      baselineStatus: baseline.routing[key],
      kind: gapKindFor(localStatus),
      note,
    });
  }

  // --- Structured output modes. ----------------------------------------
  const structuredAxes: Array<{
    key: keyof ModelCapabilities["structuredOutputs"];
    note: string;
  }> = [
    { key: "jsonSchema", note: "response_format json_schema not verified for this local model" },
    { key: "jsonObject", note: "response_format json_object not verified for this local model" },
    { key: "toolCallArguments", note: "forced tool-call structured output not verified" },
    { key: "plainJsonExtraction", note: "prompt-enforced plain-JSON extraction not verified" },
  ];
  for (const { key, note } of structuredAxes) {
    const localStatus = local.structuredOutputs[key];
    if (typeof localStatus !== "string" || localStatus === "supported") continue;
    gaps.push({
      axis: `structuredOutputs.${key}`,
      dimension: "structured_output",
      localStatus,
      baselineStatus: String(baseline.structuredOutputs[key]),
      kind: gapKindFor(localStatus),
      note,
    });
  }

  // --- Tool calls. ------------------------------------------------------
  if (local.toolCalls.support !== "supported") {
    gaps.push({
      axis: "toolCalls.support",
      dimension: "tools",
      localStatus: local.toolCalls.support,
      baselineStatus: baseline.toolCalls.support,
      kind: gapKindFor(local.toolCalls.support),
      note: "tool-calling not verified for this local model",
    });
  }

  // --- Image input. -----------------------------------------------------
  if (local.imageInput.support !== "supported") {
    gaps.push({
      axis: "imageInput.support",
      dimension: "image",
      localStatus: local.imageInput.support,
      baselineStatus: baseline.imageInput.support,
      kind: gapKindFor(local.imageInput.support),
      note: "image input not verified for this local model",
    });
  }

  return {
    providerName: descriptor.providerName,
    providerFamily: descriptor.family,
    baselineProviderName,
    hasZeroDataRetentionAttestation,
    hasRealBilledCost: false,
    gaps,
  };
}

/** Convenience wrapper: report gaps for a live `ModelProvider` instance. */
export function localProviderCapabilityGapReport(
  provider: ModelProvider,
  options: DescribeLocalCapabilityGapsOptions = {},
): LocalProviderCapabilityGapReport {
  return describeLocalProviderCapabilityGaps(provider.descriptor, options);
}

/**
 * Render the gap report as stable, human-readable lines for surfacing in a
 * smoke report / dashboard / log. One line per gap plus a header, sorted by
 * axis so the output is deterministic.
 */
export function summarizeLocalProviderCapabilityGaps(
  report: LocalProviderCapabilityGapReport,
): string[] {
  const header =
    `local provider '${report.providerName}' (${report.providerFamily}) vs ${report.baselineProviderName}: ` +
    `${report.gaps.length} capability gap${report.gaps.length === 1 ? "" : "s"} ` +
    `(zdrAttestation=${report.hasZeroDataRetentionAttestation}, realBilledCost=${report.hasRealBilledCost})`;
  const lines = [...report.gaps]
    .sort((a, b) => a.axis.localeCompare(b.axis))
    .map(
      (gap) =>
        `[${gap.kind}] ${gap.dimension}: ${gap.axis} local=${gap.localStatus} baseline=${gap.baselineStatus} — ${gap.note}`,
    );
  return [header, ...lines];
}

function gapKindFor(status: CapabilitySupport): CapabilityGapKind {
  return status === "unsupported" ? "hard_gap" : "unverified";
}
