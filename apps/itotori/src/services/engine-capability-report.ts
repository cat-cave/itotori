import {
  type AdapterCapabilityMatrixRecord,
  type AuthorizationActor,
  type CapabilityLevel,
  EngineCapabilityReportRepository,
  capabilityLevelValues,
} from "@itotori/db";

// KAIFUU-053: itotori-side consumer for the capability-leveled engine
// detector registry. Wraps the repository with a typed API that the
// dashboard and CLI surfaces consume so they can distinguish "identified
// only" engines from engines that actually support extract/patch.
//
// The strict gate (acceptance criterion 2) lives at the
// `isUsable(adapterId, level)` boundary: Partial does NOT count as
// Supported.

export type AdapterUsabilityBadge =
  | "supported"
  | "partial"
  | "unsupported"
  | "identify_only"
  | "unknown";

export type AdapterCapabilitySummary = {
  adapterId: string;
  badge: AdapterUsabilityBadge;
  identify: AdapterCapabilityMatrixRecord["identify"];
  inventory: AdapterCapabilityMatrixRecord["inventory"];
  extract: AdapterCapabilityMatrixRecord["extract"];
  patch: AdapterCapabilityMatrixRecord["patch"];
};

export type EngineCapabilityReportPort = {
  /**
   * Strict gate: returns true iff the adapter is `Supported` at `level`.
   * Partial does NOT count.
   */
  isUsable(adapterId: string, level: CapabilityLevel): Promise<boolean>;

  /**
   * Returns the full per-adapter matrix and a `badge` summary suitable
   * for dashboard / CLI rendering.
   */
  listAdapterSummaries(): Promise<AdapterCapabilitySummary[]>;

  /**
   * Convenience: every adapter id whose status at `level` is strictly
   * `supported`, sorted ascending.
   */
  adaptersSupporting(level: CapabilityLevel): Promise<string[]>;

  /**
   * Record one adapter's typed 4-rung matrix. Mirrors the upstream
   * `EngineAdapter::capabilities().level_matrix`.
   */
  recordMatrix(matrix: AdapterCapabilityMatrixRecord): Promise<void>;
};

export class EngineCapabilityReportService implements EngineCapabilityReportPort {
  constructor(
    private readonly repository: EngineCapabilityReportRepository,
    private readonly actor: AuthorizationActor,
  ) {}

  async isUsable(adapterId: string, level: CapabilityLevel): Promise<boolean> {
    return this.repository.isAdapterUsable(adapterId, level);
  }

  async listAdapterSummaries(): Promise<AdapterCapabilitySummary[]> {
    const matrices = await this.repository.listMatrices();
    return matrices.map(toSummary);
  }

  async adaptersSupporting(level: CapabilityLevel): Promise<string[]> {
    return this.repository.adaptersSupporting(level);
  }

  async recordMatrix(matrix: AdapterCapabilityMatrixRecord): Promise<void> {
    await this.repository.writeMatrix(this.actor, matrix);
  }
}

/**
 * Pure transform used by the dashboard / CLI to compute the
 * "Identified only" badge per acceptance criterion 3.
 *
 * - `supported`     — every rung at or above Extract is Supported (a
 *   fully usable engine).
 * - `partial`       — Extract is Partial (engine extracts, but with
 *   caveats the consumer should surface).
 * - `identify_only` — Identify is Supported, but neither Extract nor
 *   Patch is.
 * - `unsupported`   — Identify is not Supported (effectively a no-op
 *   row, likely test data).
 * - `unknown`       — no rows recorded (matrix is null/missing).
 */
export function adapterBadge(matrix: AdapterCapabilityMatrixRecord): AdapterUsabilityBadge {
  if (matrix.identify.kind !== "supported") {
    return "unsupported";
  }
  if (matrix.extract.kind === "supported") {
    return "supported";
  }
  if (matrix.extract.kind === "partial") {
    return "partial";
  }
  return "identify_only";
}

export function toSummary(matrix: AdapterCapabilityMatrixRecord): AdapterCapabilitySummary {
  return {
    adapterId: matrix.adapterId,
    badge: adapterBadge(matrix),
    identify: matrix.identify,
    inventory: matrix.inventory,
    extract: matrix.extract,
    patch: matrix.patch,
  };
}

export const capabilityLevelOrder: ReadonlyArray<CapabilityLevel> = [
  capabilityLevelValues.identify,
  capabilityLevelValues.inventory,
  capabilityLevelValues.extract,
  capabilityLevelValues.patch,
];
