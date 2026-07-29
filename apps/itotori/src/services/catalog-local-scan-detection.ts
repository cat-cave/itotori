import {
  catalogLocalArchiveDetectionSchemaVersion,
  catalogLocalDetectionSchemaVersion,
  catalogLocalEngineEvidenceSchemaVersion,
  catalogLocalScannerName,
  type CatalogLocalEngineEvidence,
  type CatalogLocalKaifuuArchiveDetectionRow,
  type CatalogLocalKaifuuArchiveEvidenceType,
  type CatalogLocalKaifuuDetectionReport,
} from "./catalog-local-scan-contract.js";
import type { DirectoryProfile } from "./catalog-local-scan-model.js";

const kaifuuArchiveDetectionEvidencePolicy =
  "aggregate-only; no raw keys, helper dumps, decrypted text, local paths, or private source filenames are serialized" as const;
const kaifuuRedactedDetectionGameDir = "[redacted-local-game-dir]" as const;
const kaifuuLocalArchiveSupportBoundary =
  "Itotori local scan reports aggregate archive and engine markers only; no registered Kaifuu adapter execution, extraction, decryption, inventory, or patch support is claimed." as const;

export function detectEngine(
  directory: DirectoryProfile,
): CatalogLocalKaifuuDetectionReport | null {
  const rows = archiveRowsForDirectory(directory);
  return rows.length === 0 ? null : kaifuuDetectionReport(rows);
}
export function kaifuuDetectionReportForArchiveFile(
  extension: string,
): CatalogLocalKaifuuDetectionReport {
  return kaifuuDetectionReport([archiveRowForExtension(extension, 1)]);
}
export function localEngineEvidenceForRows(
  rows: CatalogLocalKaifuuArchiveDetectionRow[],
  evidence: CatalogLocalEngineEvidence["evidence"],
): CatalogLocalEngineEvidence | null {
  const primaryRow = rows.find((row) => row.detected && row.engineFamily !== "unknown");
  if (primaryRow === undefined) return null;
  return {
    schemaVersion: catalogLocalEngineEvidenceSchemaVersion,
    producer: catalogLocalScannerName,
    localDetectionSchemaVersion: catalogLocalDetectionSchemaVersion,
    adapterId: `local-scan:${primaryRow.engineFamily}`,
    engineName: primaryRow.engineFamily,
    engineSource: "local_scan",
    engineConfidence: localEngineConfidence(primaryRow),
    readiness: { identify: "partial", inventory: "unknown", extract: "unknown", patch: "unknown" },
    evidence,
  };
}
export function archiveRowsForDirectory(
  directory: DirectoryProfile,
): CatalogLocalKaifuuArchiveDetectionRow[] {
  const rows: CatalogLocalKaifuuArchiveDetectionRow[] = [];
  if (directory.markerKinds.has("rpgmaker_mv_metadata"))
    rows.push(
      archiveRow({
        rowId: "rpg-maker-mv-mz-metadata",
        engineFamily: "rpg_maker_mv_mz",
        detectedVariant: "mv-mz-system-json-layout",
        signals: ["engine_metadata"],
        evidenceType: "metadata_field",
        pattern: "www/data/System.json",
        count: markerCount(directory, ".json"),
      }),
    );
  if (directory.markerKinds.has("rpgmaker_vxace_archive"))
    rows.push(
      archiveRow({
        rowId: "rpg-maker-vx-ace-archive",
        engineFamily: "rpg_maker_vx_ace",
        detectedVariant: "rgss3a-or-rvdata2-archive",
        signals: ["archive"],
        evidenceType: "file_extension",
        pattern: "*.rgss3a|*.rvdata2",
        count: countExtensions(directory, [".rgss3a", ".rvdata2"]),
      }),
    );
  if (directory.markerKinds.has("renpy_script"))
    rows.push(
      archiveRow({
        rowId: "renpy-script-or-archive",
        engineFamily: "renpy",
        detectedVariant: "renpy-script-or-rpa",
        signals: ["script_or_archive"],
        evidenceType: "file_extension",
        pattern: "*.rpy|*.rpa",
        count: countExtensions(directory, [".rpy", ".rpa"]),
      }),
    );
  if (directory.markerKinds.has("kirikiri_archive"))
    rows.push(
      archiveRow({
        rowId: "kirikiri-xp3",
        engineFamily: "kiri_kiri_xp3",
        detectedVariant: "xp3-archive",
        signals: ["archive"],
        evidenceType: "file_extension",
        pattern: "*.xp3",
        count: markerCount(directory, ".xp3"),
      }),
    );
  if (directory.markerKinds.has("unity_data_directory"))
    rows.push(
      archiveRow({
        rowId: "unity-data-directory",
        engineFamily: "unity",
        detectedVariant: "unity-data-directory",
        signals: ["data_directory"],
        evidenceType: "aggregate_count",
        pattern: "*_Data/",
        count: 1,
      }),
    );
  return rows;
}
export function kaifuuDetectionReport(
  rows: CatalogLocalKaifuuArchiveDetectionRow[],
): CatalogLocalKaifuuDetectionReport {
  const archiveMatched = rows.some((row) => row.detected);
  return {
    schemaVersion: catalogLocalDetectionSchemaVersion,
    schemaDialect: "itotori_local_corpus_detection",
    gameDir: kaifuuRedactedDetectionGameDir,
    status: "unknown",
    detections: [],
    warnings: archiveMatched
      ? [
          "no registered extraction adapter matched this directory; local archive detection reported aggregate markers only",
        ]
      : ["no registered adapter matched this directory"],
    archiveDetection: {
      schemaVersion: catalogLocalArchiveDetectionSchemaVersion,
      schemaDialect: "itotori_local_corpus_archive_detection",
      status: archiveMatched ? "matched" : "unknown",
      evidencePolicy: kaifuuArchiveDetectionEvidencePolicy,
      rows,
    },
  };
}
function localEngineConfidence(
  row: CatalogLocalKaifuuArchiveDetectionRow,
): CatalogLocalEngineEvidence["engineConfidence"] {
  if (row.signals.includes("engine_metadata") || row.signals.includes("data_directory"))
    return "high";
  if (row.signals.includes("archive") || row.signals.includes("script_or_archive")) return "medium";
  return "low";
}
function archiveRowForExtension(
  extension: string,
  count: number,
): CatalogLocalKaifuuArchiveDetectionRow {
  switch (extension) {
    case ".xp3":
      return archiveRow({
        rowId: "kirikiri-xp3",
        engineFamily: "kiri_kiri_xp3",
        detectedVariant: "xp3-archive",
        signals: ["archive"],
        evidenceType: "file_extension",
        pattern: "*.xp3",
        count,
      });
    case ".rpa":
      return archiveRow({
        rowId: "renpy-archive",
        engineFamily: "renpy",
        detectedVariant: "rpa-archive",
        signals: ["archive"],
        evidenceType: "file_extension",
        pattern: "*.rpa",
        count,
      });
    case ".rgss3a":
    case ".rvdata2":
      return archiveRow({
        rowId: "rpg-maker-vx-ace-archive",
        engineFamily: "rpg_maker_vx_ace",
        detectedVariant: "rgss3a-or-rvdata2-archive",
        signals: ["archive"],
        evidenceType: "file_extension",
        pattern: "*.rgss3a|*.rvdata2",
        count,
      });
    default:
      return archiveRow({
        rowId: "generic-source-archive",
        engineFamily: "unknown",
        detectedVariant: `${extension.slice(1) || "unknown"}-archive`,
        signals: ["archive"],
        evidenceType: "file_extension",
        pattern: `*${extension === "[none]" ? "" : extension}`,
        count,
      });
  }
}
function archiveRow(input: {
  rowId: string;
  engineFamily: string;
  detectedVariant: string;
  signals: string[];
  evidenceType: CatalogLocalKaifuuArchiveEvidenceType;
  pattern: string;
  count: number;
}): CatalogLocalKaifuuArchiveDetectionRow {
  return {
    rowId: input.rowId,
    engineFamily: input.engineFamily,
    detected: input.count > 0,
    detectedVariant: input.detectedVariant,
    signals: input.signals,
    evidence: [
      {
        evidenceType: input.evidenceType,
        pattern: input.pattern,
        status: input.count > 0 ? "matched" : "missing",
        count: input.count,
        detail: "aggregate marker count from redacted local corpus scan",
      },
    ],
    requirements: [],
    capabilities: [
      {
        capability: "detection",
        status: "limited",
        limitation:
          "local scan reports aggregate file markers only; no adapter execution was performed",
      },
    ],
    diagnostics: [],
    supportBoundary: kaifuuLocalArchiveSupportBoundary,
  };
}
function markerCount(directory: DirectoryProfile, extension: string): number {
  return directory.extensionCounts[extension] ?? 0;
}
function countExtensions(directory: DirectoryProfile, extensions: string[]): number {
  return extensions.reduce((total, extension) => total + markerCount(directory, extension), 0);
}
