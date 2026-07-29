import { lstat, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  catalogLocalScanSchemaVersion,
  catalogLocalScannerName,
  catalogLocalScannerVersion,
  type CatalogLocalArchiveState,
  type CatalogLocalEntryKind,
  type CatalogLocalInstallState,
  type CatalogLocalScanEntry,
  type CatalogLocalScanOptions,
  type CatalogLocalScanReport,
} from "./catalog-local-scan-contract.js";
import { buildEntries } from "./catalog-local-scan-entries.js";
import { profileDirectory } from "./catalog-local-scan-profile.js";
import {
  createPrivateHash,
  increment,
  mergeCounts,
  privateHashHex,
  sortedCounts,
} from "./catalog-local-scan-utils.js";

export async function scanCatalogLocalRoot(
  options: CatalogLocalScanOptions,
): Promise<CatalogLocalScanReport> {
  const startedAt = (options.now ?? (() => new Date()))();
  const rootPath = resolve(options.rootPath);
  const rootLinkStats = await lstat(rootPath);
  if (rootLinkStats.isSymbolicLink())
    throw new Error("catalog-local-corpus-scan --root must not be a symbolic link");
  const rootStats = await stat(rootPath);
  if (!rootStats.isDirectory())
    throw new Error("catalog-local-corpus-scan --root must be a directory");
  const maxDepth = options.maxDepth ?? 4;
  if (!Number.isInteger(maxDepth) || maxDepth < 0)
    throw new Error("catalog-local-corpus-scan --max-depth must be a non-negative integer");
  const hashKey = options.hashKey;
  if (hashKey === undefined || hashKey.length === 0)
    throw new Error("catalog-local-corpus-scan requires --hash-key for stable private hashes");
  const privateHash = createPrivateHash(hashKey);
  const root = await profileDirectory(rootPath, "", 0, maxDepth);
  const owned = options.owned ?? true;
  const rootPathHash = privateHash("root-path", rootPath);
  const entries = await buildEntries(root, rootPathHash, owned, privateHash);
  const completedAt = (options.now ?? (() => new Date()))();
  const reportFingerprintHash = privateHash(
    "report-fingerprint",
    JSON.stringify(entries.map((entry) => [entry.localId, entry.fingerprintHash])),
  );
  return {
    schemaVersion: catalogLocalScanSchemaVersion,
    localScanId: `catalog-local-corpus-scan:${privateHashHex(hashKey, "local-scan-id", rootPath)}`,
    scannerName: catalogLocalScannerName,
    scannerVersion: catalogLocalScannerVersion,
    tool: { name: catalogLocalScannerName, version: catalogLocalScannerVersion },
    scanRoot: {
      labelHash: privateHash("root-label", options.rootLabel ?? "local-root"),
      pathHash: rootPathHash,
      pathRedactionClass: "private_path_hash",
    },
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    owned,
    summary: summarize(entries, root),
    hashes: { rootPathHash, reportFingerprintHash },
    privacy: { hashMode: "hmac-sha256", hashKeyProvided: true, keyEmitted: false },
    entries,
  };
}
function summarize(
  entries: CatalogLocalScanEntry[],
  root: { fileCount: number; directoryCount: number; byteCount: number },
): CatalogLocalScanReport["summary"] {
  const byEntryKind = zeroEntryKindCounts();
  const byInstallState = zeroInstallStateCounts();
  const byArchiveState = zeroArchiveStateCounts();
  const byEngine: Record<string, number> = {};
  const extensionCounts: Record<string, number> = {};
  const fileKindCounts: Record<string, number> = {};
  for (const entry of entries) {
    byEntryKind[entry.entryKind] += 1;
    byInstallState[entry.installState] += 1;
    byArchiveState[entry.archiveState] += 1;
    if (entry.engineDetection !== null)
      for (const row of entry.engineDetection.archiveDetection.rows)
        if (row.detected) increment(byEngine, row.engineFamily, 1);
    mergeCounts(extensionCounts, entry.extensionCounts);
    mergeCounts(fileKindCounts, entry.fileKindCounts);
  }
  return {
    entryCount: entries.length,
    fileCount: root.fileCount,
    directoryCount: root.directoryCount,
    byteCount: root.byteCount,
    byEntryKind,
    byInstallState,
    byArchiveState,
    byEngine,
    extensionCounts: sortedCounts(extensionCounts),
    fileKindCounts: sortedCounts(fileKindCounts),
  };
}
function zeroEntryKindCounts(): Record<CatalogLocalEntryKind, number> {
  return {
    source_archive: 0,
    installed_game: 0,
    collection_member: 0,
    edition: 0,
    sidecar_metadata: 0,
    unknown_directory: 0,
  };
}
function zeroInstallStateCounts(): Record<CatalogLocalInstallState, number> {
  return {
    source_archive: 0,
    installed: 0,
    patch_target: 0,
    not_installed: 0,
    archived: 0,
    unknown: 0,
  };
}
function zeroArchiveStateCounts(): Record<CatalogLocalArchiveState, number> {
  return {
    archive_file: 0,
    expanded_directory: 0,
    mixed_archive_and_install: 0,
    none: 0,
    unknown: 0,
  };
}
