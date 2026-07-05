// UTSUSHI-011 — Managed artifact store for runtime evidence.
//
// The tools NEVER touch raw files. They ask this store to resolve a managed
// artifact ref into the runtime evidence report or the OCR artifact derived
// from a screenshot capture. Production wires a store backed by the managed
// artifact repository (durable object store + hash index); tests wire the
// in-memory implementation below from synthetic fixtures. Both are pure
// resolvers — no side effects — so tools stay `sideEffectFree`.

import type { RuntimeEvidenceReportV02 } from "@itotori/localization-bridge-schema";
import type { ManagedArtifactRef, ScreenshotOcrArtifact } from "./shapes.js";

/**
 * The read surface the runtime-evidence tools depend on. Deliberately narrow:
 * a report resolver keyed by the runtime-report artifact ref, and an OCR
 * resolver keyed by a screenshot capture's artifact ref.
 */
export type RuntimeEvidenceArtifactStore = {
  /** Resolve a `runtime_report` managed ref into its report, or null. */
  resolveRuntimeReport(ref: ManagedArtifactRef): RuntimeEvidenceReportV02 | null;
  /** Resolve the OCR artifact derived from a `screenshot` managed ref, or null. */
  resolveScreenshotOcr(ref: ManagedArtifactRef): ScreenshotOcrArtifact | null;
};

export type InMemoryRuntimeEvidenceArtifactStoreSeed = {
  /** Runtime evidence reports keyed by their runtime-report artifact id. */
  reports: ReadonlyArray<{ artifactId: string; report: RuntimeEvidenceReportV02 }>;
  /** OCR artifacts. Each is keyed by its own artifact id AND its screenshot id. */
  ocrArtifacts?: ReadonlyArray<ScreenshotOcrArtifact>;
};

/**
 * Deterministic in-memory managed store. Resolution is by `artifactId` only
 * (the hash/uri on the ref are carried through into citations but are not the
 * lookup key), mirroring a content-addressed managed artifact repository.
 */
export class InMemoryRuntimeEvidenceArtifactStore implements RuntimeEvidenceArtifactStore {
  private readonly reports = new Map<string, RuntimeEvidenceReportV02>();
  private readonly ocrByArtifactId = new Map<string, ScreenshotOcrArtifact>();
  private readonly ocrByScreenshotId = new Map<string, ScreenshotOcrArtifact>();

  constructor(seed: InMemoryRuntimeEvidenceArtifactStoreSeed) {
    for (const entry of seed.reports) {
      this.reports.set(entry.artifactId, entry.report);
    }
    for (const ocr of seed.ocrArtifacts ?? []) {
      this.ocrByArtifactId.set(ocr.artifactId, ocr);
      this.ocrByScreenshotId.set(ocr.screenshotArtifactId, ocr);
    }
  }

  resolveRuntimeReport(ref: ManagedArtifactRef): RuntimeEvidenceReportV02 | null {
    return this.reports.get(ref.artifactId) ?? null;
  }

  resolveScreenshotOcr(ref: ManagedArtifactRef): ScreenshotOcrArtifact | null {
    // A screenshot capture's artifact ref is the OCR lookup key; fall back to
    // an OCR-artifact-id lookup so an OCR ref resolves too.
    return (
      this.ocrByScreenshotId.get(ref.artifactId) ?? this.ocrByArtifactId.get(ref.artifactId) ?? null
    );
  }
}
