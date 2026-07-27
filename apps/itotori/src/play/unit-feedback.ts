// Unit-bound feedback ledger — extends the play-flag path so notes attached to a
// real unit/scene identity are persisted and retrievable by that same identity
// from the wiki surface and the review (play) surface.
//
// Write path: buildPlayFlagFeedbackInput → ManualFeedbackImportPort.importManualFeedback
// Read path:  ManualFeedbackImportPort.listUnitFeedback({ projectId, localeBranchId, bridgeUnitId })
//
// A memory ledger is the pure, mutation-falsifiable core used by behavior tests
// and as a local fallback; production wires the same port shape over feedback
// reports (bridge_unit_id is the durable key).

import { buildPlayFlagFeedbackInput, type PlayFlagAnnotationInput } from "./flag-annotation.js";

export const UNIT_FEEDBACK_SCHEMA_VERSION = "itotori.play.unit-feedback.v0" as const;

/** One durable note bound to a unit (and optional scene). */
export type UnitFeedbackNote = {
  readonly schemaVersion: typeof UNIT_FEEDBACK_SCHEMA_VERSION;
  readonly feedbackReportId: string;
  readonly feedbackEvidenceId: string;
  readonly projectId: string;
  readonly localeBranchId: string;
  readonly bridgeUnitId: string;
  readonly sceneId: string | null;
  readonly note: string;
  readonly severity: string;
  readonly category: string;
  readonly triageLabel: string;
  readonly contextStatus: string;
  readonly contextCorrectionId: string;
  readonly reportedAt: string;
  readonly duplicate: boolean;
};

export type ListUnitFeedbackQuery = {
  readonly projectId: string;
  readonly localeBranchId: string;
  readonly bridgeUnitId: string;
};

/** Result shape the play.flagAnnotation handler already expects. */
export type UnitFeedbackImportResult = {
  feedbackReportId: string;
  feedbackEvidenceId: string;
  triageLabel: string;
  contextStatus: string;
  duplicate: boolean;
  contextCorrection: { correctionId: string };
};

/**
 * Port the flag composer + unit-feedback list share. Import creates a note
 * bound to bridgeUnitId; list returns every note for that unit in the branch.
 */
export type UnitBoundFeedbackPort = {
  importManualFeedback(input: unknown): Promise<UnitFeedbackImportResult>;
  listUnitFeedback(query: ListUnitFeedbackQuery): Promise<UnitFeedbackNote[]>;
};

/** Pure key for unit-scoped retrieval within a project/branch. */
export function unitFeedbackKey(
  projectId: string,
  localeBranchId: string,
  bridgeUnitId: string,
): string {
  return `${projectId}\u0000${localeBranchId}\u0000${bridgeUnitId}`;
}

/**
 * In-memory ledger that implements UnitBoundFeedbackPort. Used by behavior
 * tests (and any surface that needs durable-in-process unit binding without a
 * live DB). Import records the note under the unit key; list returns it.
 */
export function createMemoryUnitFeedbackPort(
  options: { now?: () => string } = {},
): UnitBoundFeedbackPort {
  const now = options.now ?? (() => new Date().toISOString());
  const byKey = new Map<string, UnitFeedbackNote[]>();
  let seq = 0;

  return {
    async importManualFeedback(raw: unknown): Promise<UnitFeedbackImportResult> {
      const input = raw as {
        projectId: string;
        localeBranchId: string;
        reporterNote?: string;
        lineReference?: { bridgeUnitId?: string; sourceLocation?: { sceneId?: string } };
        metadata?: { severity?: string; category?: string | null; sceneId?: string | null };
      };
      const bridgeUnitId = input.lineReference?.bridgeUnitId?.trim() ?? "";
      if (bridgeUnitId.length === 0) {
        throw new Error("unit feedback requires lineReference.bridgeUnitId");
      }
      const noteText = (input.reporterNote ?? "").trim();
      if (noteText.length === 0) {
        throw new Error("unit feedback note must be non-empty");
      }
      seq += 1;
      const feedbackReportId = `feedback-report-${seq}`;
      const feedbackEvidenceId = `feedback-evidence-${seq}`;
      const contextCorrectionId = `context-correction:${feedbackReportId}`;
      const sceneId =
        nonEmpty(input.lineReference?.sourceLocation?.sceneId ?? null) ??
        nonEmpty(input.metadata?.sceneId ?? null);
      const record: UnitFeedbackNote = {
        schemaVersion: UNIT_FEEDBACK_SCHEMA_VERSION,
        feedbackReportId,
        feedbackEvidenceId,
        projectId: input.projectId,
        localeBranchId: input.localeBranchId,
        bridgeUnitId,
        sceneId,
        note: noteText,
        severity: String(input.metadata?.severity ?? "note"),
        category: String(input.metadata?.category ?? ""),
        triageLabel: "context_correction_candidate",
        contextStatus: "pending_context_enrichment",
        contextCorrectionId,
        reportedAt: now(),
        duplicate: false,
      };
      const key = unitFeedbackKey(record.projectId, record.localeBranchId, record.bridgeUnitId);
      const existing = byKey.get(key) ?? [];
      byKey.set(key, [...existing, record]);
      return {
        feedbackReportId,
        feedbackEvidenceId,
        triageLabel: record.triageLabel,
        contextStatus: record.contextStatus,
        duplicate: false,
        contextCorrection: { correctionId: contextCorrectionId },
      };
    },

    async listUnitFeedback(query: ListUnitFeedbackQuery): Promise<UnitFeedbackNote[]> {
      const key = unitFeedbackKey(query.projectId, query.localeBranchId, query.bridgeUnitId);
      return [...(byKey.get(key) ?? [])];
    },
  };
}

/**
 * Submit a play flag through the shared port and return the import result.
 * Pure orchestration: buildPlayFlagFeedbackInput then importManualFeedback.
 */
export async function submitUnitBoundFlag(
  port: UnitBoundFeedbackPort,
  input: PlayFlagAnnotationInput,
): Promise<UnitFeedbackImportResult> {
  const payload = buildPlayFlagFeedbackInput(input);
  return port.importManualFeedback(payload);
}

/**
 * Retrieve every note bound to a unit. Fails the gut-check if the store no
 * longer keys by bridgeUnitId.
 */
export async function listFeedbackForUnit(
  port: UnitBoundFeedbackPort,
  query: ListUnitFeedbackQuery,
): Promise<UnitFeedbackNote[]> {
  const unitId = query.bridgeUnitId.trim();
  if (unitId.length === 0) {
    throw new Error("listFeedbackForUnit requires a non-empty bridgeUnitId");
  }
  const notes = await port.listUnitFeedback({
    projectId: query.projectId,
    localeBranchId: query.localeBranchId,
    bridgeUnitId: unitId,
  });
  // Defense in depth: never return notes bound to a different unit.
  return notes.filter((note) => note.bridgeUnitId === unitId);
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}
