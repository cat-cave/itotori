import type {
  CatalogLocalEntryKind,
  CatalogLocalScanEntry,
} from "./catalog-local-scan-contract.js";
import {
  archiveRowsForDirectory,
  kaifuuDetectionReport,
  kaifuuDetectionReportForArchiveFile,
  localEngineEvidenceForRows,
} from "./catalog-local-scan-detection.js";
import {
  flattenDirectories,
  flattenFiles,
  isDirectoryCandidate,
  redactedSidecarMetadata,
} from "./catalog-local-scan-profile.js";
import type { DirectoryProfile, FileProfile } from "./catalog-local-scan-model.js";
import {
  archiveExtensions,
  increment,
  normalizeRelativePath,
  privateHashHex,
  publicExtensionKey,
  sha256File,
  sortedCounts,
  type PrivateHash,
} from "./catalog-local-scan-utils.js";

export async function buildEntries(
  root: DirectoryProfile,
  rootPathHash: string,
  owned: boolean,
  privateHash: PrivateHash,
): Promise<CatalogLocalScanEntry[]> {
  const directories = flattenDirectories(root);
  const directoryCandidates = directories.filter(
    (directory) => directory !== root && isDirectoryCandidate(directory),
  );
  const candidateRelativePaths = directoryCandidates.map((directory) =>
    normalizeRelativePath(directory.relativePath),
  );
  const entries: CatalogLocalScanEntry[] = [];
  for (const file of flattenFiles(root).filter(
    (candidate) =>
      archiveExtensions.has(candidate.extension) &&
      !isUnderDirectoryCandidate(candidate.relativePath, candidateRelativePaths),
  ))
    entries.push(await archiveEntry(file, rootPathHash, owned, privateHash));
  for (const directory of directoryCandidates)
    entries.push(directoryEntry(directory, rootPathHash, owned, privateHash));
  return entries.sort((a, b) => a.localId.localeCompare(b.localId));
}
async function archiveEntry(
  file: FileProfile,
  rootPathHash: string,
  owned: boolean,
  privateHash: PrivateHash,
): Promise<CatalogLocalScanEntry> {
  const pathHash = privateHash(
    "entry-path",
    `${rootPathHash}:${normalizeRelativePath(file.relativePath)}`,
  );
  const contentHash = privateHash("archive-content", await sha256File(file.absolutePath));
  const fileKindCounts = increment({}, "archive", 1);
  const extensionCounts = increment({}, publicExtensionKey(file.extension), 1);
  const fingerprintHash = privateHash(
    "archive-fingerprint",
    JSON.stringify({ contentHash, extensionCounts, fileKindCounts, size: file.size }),
  );
  const kaifuuDetection = kaifuuDetectionReportForArchiveFile(file.extension);
  const localEngineEvidence = localEngineEvidenceForRows(kaifuuDetection.archiveDetection.rows, {
    markerKinds: [`source_archive_extension:${file.extension}`],
    extensionCounts,
    fileKindCounts,
  });
  const signals = {
    archiveDetection: {
      status: "detected",
      archiveKind: "source_archive",
      evidence: {
        archiveExtension: file.extension,
        archiveFileCount: 1,
        expandedArchiveMarkerCount: 0,
      },
    },
    contentHash,
    extensionCounts,
    fileKindCounts,
    kaifuuDetection,
    localEngineEvidence,
  };
  return {
    localId: `catalog-local-entry:${privateHashHex(privateHash.key, "entry-id", `${pathHash}:source_archive`)}`,
    entryKind: "source_archive",
    releaseKind: "unknown",
    packageKind: "archive",
    installState: "source_archive",
    archiveState: "archive_file",
    owned,
    pathHash,
    pathRedactionClass: "private_path_hash",
    fingerprintHash,
    byteCount: file.size,
    fileCount: 1,
    directoryCount: 0,
    extensionCounts,
    fileKindCounts,
    archiveDetection: {
      status: "detected",
      archiveKind: "source_archive",
      evidence: {
        archiveExtension: file.extension,
        archiveFileCount: 1,
        expandedArchiveMarkerCount: 0,
      },
    },
    engineDetection: kaifuuDetection,
    localEngineEvidence,
    relationshipEvidence: {
      collectionMember: false,
      edition: false,
      sidecarMetadata: false,
      editionSignalKinds: [],
    },
    catalogLocalScanEntryInput: {
      pathHash,
      pathRedactionClass: "private_path_hash",
      owned,
      ...(localEngineEvidence === null
        ? {}
        : {
            engineName: localEngineEvidence.engineName,
            engineSource: localEngineEvidence.engineSource,
            engineConfidence: localEngineEvidence.engineConfidence,
          }),
      signals,
      metadata: {
        entryKind: "source_archive",
        packageKind: "archive",
        installState: "source_archive",
        archiveState: "archive_file",
      },
    },
  };
}
function directoryEntry(
  directory: DirectoryProfile,
  rootPathHash: string,
  owned: boolean,
  privateHash: PrivateHash,
): CatalogLocalScanEntry {
  const metadata = directory.safeMetadata;
  const explicitEntryKind = metadata?.entryKind;
  const edition = explicitEntryKind === "edition" || metadata?.releaseKind === "edition";
  const collectionMember =
    explicitEntryKind === "collection_member" || metadata?.releaseKind === "collection_member";
  const archiveRows = archiveRowsForDirectory(directory);
  const engineDetection = archiveRows.length === 0 ? null : kaifuuDetectionReport(archiveRows);
  const localEngineEvidence = localEngineEvidenceForRows(archiveRows, {
    markerKinds: [...directory.markerKinds].sort(),
    extensionCounts: sortedCounts(directory.extensionCounts),
    fileKindCounts: sortedCounts(directory.fileKindCounts),
  });
  const archiveFileCount = directory.directArchiveCount;
  const expandedArchiveMarkerCount = directory.markerKinds.has("expanded_archive_layout") ? 1 : 0;
  const pathHash = privateHash(
    "entry-path",
    `${rootPathHash}:${normalizeRelativePath(directory.relativePath)}`,
  );
  const fingerprintHash = privateHash(
    "directory-fingerprint",
    JSON.stringify({
      byteCount: directory.byteCount,
      directoryCount: directory.directoryCount,
      extensionCounts: sortedCounts(directory.extensionCounts),
      fileCount: directory.fileCount,
      fileKindCounts: sortedCounts(directory.fileKindCounts),
      markerKinds: [...directory.markerKinds].sort(),
    }),
  );
  const entryKind: CatalogLocalEntryKind =
    explicitEntryKind ??
    (edition
      ? "edition"
      : collectionMember
        ? "collection_member"
        : engineDetection === null
          ? "sidecar_metadata"
          : "installed_game");
  const releaseKind =
    metadata?.releaseKind ??
    (edition ? "edition" : collectionMember ? "collection_member" : "original");
  const packageKind = metadata?.packageKind ?? "loose_files";
  const installState = metadata?.installState ?? "installed";
  const archiveState =
    archiveFileCount > 0
      ? "mixed_archive_and_install"
      : expandedArchiveMarkerCount > 0
        ? "expanded_directory"
        : "none";
  const archiveDetection = {
    status:
      archiveFileCount > 0 || expandedArchiveMarkerCount > 0
        ? ("detected" as const)
        : ("not_detected" as const),
    archiveKind:
      archiveFileCount > 0
        ? ("embedded_archive" as const)
        : expandedArchiveMarkerCount > 0
          ? ("expanded_archive" as const)
          : ("none" as const),
    evidence: { archiveFileCount, expandedArchiveMarkerCount },
  };
  const relationshipEvidence = {
    collectionMember,
    edition,
    sidecarMetadata: metadata !== null,
    editionSignalKinds: metadata === null ? [] : ["safe_sidecar_hint"],
  };
  const signals = {
    archiveDetection,
    engineDetection,
    localEngineEvidence,
    extensionCounts: sortedCounts(directory.extensionCounts),
    fileKindCounts: sortedCounts(directory.fileKindCounts),
    markerKinds: [...directory.markerKinds].sort(),
    relationshipEvidence,
    sidecarMetadata: redactedSidecarMetadata(metadata, privateHash),
  };
  return {
    localId: `catalog-local-entry:${privateHashHex(privateHash.key, "entry-id", `${pathHash}:${entryKind}`)}`,
    entryKind,
    releaseKind,
    packageKind,
    installState,
    archiveState,
    owned,
    pathHash,
    pathRedactionClass: "private_path_hash",
    fingerprintHash,
    byteCount: directory.byteCount,
    fileCount: directory.fileCount,
    directoryCount: directory.directoryCount,
    extensionCounts: sortedCounts(directory.extensionCounts),
    fileKindCounts: sortedCounts(directory.fileKindCounts),
    archiveDetection,
    engineDetection,
    localEngineEvidence,
    relationshipEvidence,
    catalogLocalScanEntryInput: {
      pathHash,
      pathRedactionClass: "private_path_hash",
      owned,
      ...(localEngineEvidence === null
        ? {}
        : {
            engineName: localEngineEvidence.engineName,
            engineSource: localEngineEvidence.engineSource,
            engineConfidence: localEngineEvidence.engineConfidence,
          }),
      signals,
      metadata: {
        entryKind,
        packageKind,
        installState,
        archiveState,
        releaseKind,
        ...(metadata?.collectionMemberOf === undefined
          ? {}
          : { collectionMemberOfHash: privateHash("collection-ref", metadata.collectionMemberOf) }),
        ...(metadata?.editionOf === undefined
          ? {}
          : { editionOfHash: privateHash("edition-ref", metadata.editionOf) }),
      },
    },
  };
}
function isUnderDirectoryCandidate(
  relativePath: string,
  candidateRelativePaths: string[],
): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return candidateRelativePaths.some(
    (candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`),
  );
}
