import { createHash, createHmac } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

export const catalogLocalScanSchemaVersion = "catalog.local_corpus_sidecar.v0.1" as const;
export const catalogLocalDetectionSchemaVersion = "catalog.local_corpus_detection.v0.1" as const;
export const catalogLocalArchiveDetectionSchemaVersion =
  "catalog.local_corpus_archive_detection.v0.1" as const;
export const catalogLocalEngineEvidenceSchemaVersion =
  "catalog.local_corpus_engine_evidence.v0.1" as const;
export const catalogLocalScannerName = "itotori-local-corpus-scanner" as const;
export const catalogLocalScannerVersion = "0.1.0" as const;
export const catalogLocalMetadataFileName = ".itotori-local-corpus.json" as const;
const kaifuuArchiveDetectionEvidencePolicy =
  "aggregate-only; no raw keys, helper dumps, decrypted text, local paths, or private source filenames are serialized" as const;
const kaifuuRedactedDetectionGameDir = "[redacted-local-game-dir]" as const;
const kaifuuLocalArchiveSupportBoundary =
  "Itotori local scan reports aggregate archive and engine markers only; no registered Kaifuu adapter execution, extraction, decryption, inventory, or patch support is claimed." as const;

export type CatalogLocalEntryKind =
  | "source_archive"
  | "installed_game"
  | "collection_member"
  | "edition"
  | "sidecar_metadata"
  | "unknown_directory";

export type CatalogLocalPackageKind = "archive" | "loose_files" | "installer" | "unknown";

export type CatalogLocalInstallState =
  | "source_archive"
  | "installed"
  | "patch_target"
  | "not_installed"
  | "archived"
  | "unknown";

export type CatalogLocalArchiveState =
  | "archive_file"
  | "expanded_directory"
  | "mixed_archive_and_install"
  | "none"
  | "unknown";

export type CatalogLocalEngineReadiness = {
  identify: "supported" | "partial" | "unsupported" | "unknown";
  inventory: "supported" | "partial" | "unsupported" | "unknown";
  extract: "supported" | "partial" | "unsupported" | "unknown";
  patch: "supported" | "partial" | "unsupported" | "unknown";
};

export type CatalogLocalKaifuuEvidenceStatus =
  | "matched"
  | "missing"
  | "invalid"
  | "informational"
  | "unknown";
export type CatalogLocalKaifuuArchiveEvidenceType =
  | "file_extension"
  | "file_name"
  | "file_magic"
  | "metadata_field"
  | "aggregate_count";
export type CatalogLocalKaifuuRequirementStatus =
  | "satisfied"
  | "missing"
  | "not_required"
  | "unsupported"
  | "unknown";
export type CatalogLocalKaifuuCapabilityStatus =
  | "supported"
  | "limited"
  | "unsupported"
  | "requires_user_input"
  | "unknown";

export type CatalogLocalKaifuuDetectionEvidence = {
  path: string;
  kind: string;
  status: CatalogLocalKaifuuEvidenceStatus;
  detail: string;
  count?: number;
};

export type CatalogLocalKaifuuRequirement = {
  category: string;
  key: string;
  status: CatalogLocalKaifuuRequirementStatus;
  description: string;
  placeholder: string | null;
  secret: boolean;
};

export type CatalogLocalKaifuuCapability = {
  capability: string;
  status: CatalogLocalKaifuuCapabilityStatus;
  limitation: string | null;
};

export type CatalogLocalKaifuuDetectionResult = {
  adapterId: string;
  detected: boolean;
  engineFamily?: string;
  engineVersion?: string;
  detectedVariant?: string;
  evidence: CatalogLocalKaifuuDetectionEvidence[];
  requirements: CatalogLocalKaifuuRequirement[];
  capabilities: CatalogLocalKaifuuCapability[];
};

export type CatalogLocalKaifuuArchiveDetectionRow = {
  rowId: string;
  engineFamily: string;
  detected: boolean;
  detectedVariant: string;
  signals: string[];
  evidence: Array<{
    evidenceType: CatalogLocalKaifuuArchiveEvidenceType;
    pattern: string;
    status: CatalogLocalKaifuuEvidenceStatus;
    count: number;
    detail: string;
  }>;
  requirements: CatalogLocalKaifuuRequirement[];
  capabilities: CatalogLocalKaifuuCapability[];
  diagnostics: Array<{
    code: string;
    signal: string;
    requiredCapability?: string;
    supportBoundary: string;
    remediation?: string;
  }>;
  supportBoundary: typeof kaifuuLocalArchiveSupportBoundary;
};

export type CatalogLocalKaifuuDetectionReport = {
  schemaVersion: typeof catalogLocalDetectionSchemaVersion;
  schemaDialect: "itotori_local_corpus_detection";
  gameDir: typeof kaifuuRedactedDetectionGameDir;
  status: "matched" | "unknown";
  detections: CatalogLocalKaifuuDetectionResult[];
  warnings: string[];
  archiveDetection: {
    schemaVersion: typeof catalogLocalArchiveDetectionSchemaVersion;
    schemaDialect: "itotori_local_corpus_archive_detection";
    status: "matched" | "unknown";
    evidencePolicy: typeof kaifuuArchiveDetectionEvidencePolicy;
    rows: CatalogLocalKaifuuArchiveDetectionRow[];
  };
};

export type CatalogLocalEngineEvidence = {
  schemaVersion: typeof catalogLocalEngineEvidenceSchemaVersion;
  producer: typeof catalogLocalScannerName;
  localDetectionSchemaVersion: typeof catalogLocalDetectionSchemaVersion;
  adapterId: string;
  engineName: string;
  engineSource: "local_scan";
  engineConfidence: "high" | "medium" | "low" | "unknown";
  readiness: CatalogLocalEngineReadiness;
  evidence: {
    markerKinds: string[];
    extensionCounts: Record<string, number>;
    fileKindCounts: Record<string, number>;
  };
};

export type CatalogLocalScanEntry = {
  localId: string;
  entryKind: CatalogLocalEntryKind;
  releaseKind: "original" | "edition" | "collection_member" | "unknown";
  packageKind: CatalogLocalPackageKind;
  installState: CatalogLocalInstallState;
  archiveState: CatalogLocalArchiveState;
  owned: boolean;
  pathHash: string;
  pathRedactionClass: "private_path_hash";
  fingerprintHash: string;
  byteCount: number;
  fileCount: number;
  directoryCount: number;
  extensionCounts: Record<string, number>;
  fileKindCounts: Record<string, number>;
  archiveDetection: {
    status: "detected" | "not_detected" | "unknown";
    archiveKind: "source_archive" | "embedded_archive" | "expanded_archive" | "none" | "unknown";
    evidence: {
      archiveExtension?: string;
      archiveFileCount: number;
      expandedArchiveMarkerCount: number;
    };
  };
  engineDetection: CatalogLocalKaifuuDetectionReport | null;
  localEngineEvidence: CatalogLocalEngineEvidence | null;
  relationshipEvidence: {
    collectionMember: boolean;
    edition: boolean;
    sidecarMetadata: boolean;
    editionSignalKinds: string[];
  };
  catalogLocalScanEntryInput: {
    pathHash: string;
    pathRedactionClass: "private_path_hash";
    owned: boolean;
    engineName?: string;
    engineSource?: "local_scan";
    engineConfidence?: "high" | "medium" | "low" | "unknown";
    signals: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
};

export type CatalogLocalScanReport = {
  schemaVersion: typeof catalogLocalScanSchemaVersion;
  localScanId: string;
  scannerName: typeof catalogLocalScannerName;
  scannerVersion: typeof catalogLocalScannerVersion;
  tool: {
    name: typeof catalogLocalScannerName;
    version: typeof catalogLocalScannerVersion;
  };
  scanRoot: {
    labelHash: string;
    pathHash: string;
    pathRedactionClass: "private_path_hash";
  };
  startedAt: string;
  completedAt: string;
  owned: boolean;
  summary: {
    entryCount: number;
    fileCount: number;
    directoryCount: number;
    byteCount: number;
    byEntryKind: Record<CatalogLocalEntryKind, number>;
    byInstallState: Record<CatalogLocalInstallState, number>;
    byArchiveState: Record<CatalogLocalArchiveState, number>;
    byEngine: Record<string, number>;
    extensionCounts: Record<string, number>;
    fileKindCounts: Record<string, number>;
  };
  hashes: {
    rootPathHash: string;
    reportFingerprintHash: string;
  };
  privacy: {
    hashMode: "hmac-sha256";
    hashKeyProvided: true;
    keyEmitted: false;
  };
  entries: CatalogLocalScanEntry[];
};

export type CatalogLocalScanOptions = {
  rootPath: string;
  rootLabel?: string;
  owned?: boolean;
  maxDepth?: number;
  hashKey?: string;
  now?: () => Date;
};

type FileProfile = {
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
};

type DirectoryProfile = {
  absolutePath: string;
  relativePath: string;
  depth: number;
  fileCount: number;
  directoryCount: number;
  byteCount: number;
  extensionCounts: Record<string, number>;
  fileKindCounts: Record<string, number>;
  markerKinds: Set<string>;
  directArchiveCount: number;
  directDirectories: DirectoryProfile[];
  directFiles: FileProfile[];
  safeMetadata: CatalogLocalSafeMetadata | null;
};

type CatalogLocalSafeMetadata = {
  schemaVersion: "catalog.local_corpus_hint.v0.1";
  entryKind?: "installed_game" | "collection_member" | "edition";
  releaseKind?: "original" | "edition" | "collection_member" | "unknown";
  packageKind?: CatalogLocalPackageKind;
  installState?: CatalogLocalInstallState;
  collectionMemberOf?: string;
  editionOf?: string;
};

const archiveExtensions = new Set([
  ".zip",
  ".7z",
  ".rar",
  ".tar",
  ".tgz",
  ".gz",
  ".xz",
  ".bz2",
  ".iso",
  ".xp3",
  ".rpa",
  ".rgss3a",
  ".rvdata2",
]);

const installerExtensions = new Set([".exe", ".msi", ".dmg", ".pkg"]);

const scriptExtensions = new Set([".rpy", ".ks", ".txt", ".ini", ".json", ".rvdata2"]);

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

const audioExtensions = new Set([".ogg", ".wav", ".mp3", ".m4a"]);

const videoExtensions = new Set([".mp4", ".webm", ".avi", ".mpg", ".mpeg"]);

const publicExtensionKeys = new Set([
  "[none]",
  ...archiveExtensions,
  ...installerExtensions,
  ...scriptExtensions,
  ...imageExtensions,
  ...audioExtensions,
  ...videoExtensions,
]);

const unknownExtensionKey = "unknown_extension" as const;

export async function scanCatalogLocalRoot(
  options: CatalogLocalScanOptions,
): Promise<CatalogLocalScanReport> {
  const startedAt = (options.now ?? (() => new Date()))();
  const rootPath = resolve(options.rootPath);
  const rootLinkStats = await lstat(rootPath);
  if (rootLinkStats.isSymbolicLink()) {
    throw new Error("catalog-local-corpus-scan --root must not be a symbolic link");
  }
  const rootStats = await stat(rootPath);
  if (!rootStats.isDirectory()) {
    throw new Error("catalog-local-corpus-scan --root must be a directory");
  }

  const maxDepth = options.maxDepth ?? 4;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error("catalog-local-corpus-scan --max-depth must be a non-negative integer");
  }

  const hashKey = options.hashKey ?? process.env.ITOTORI_LOCAL_CORPUS_HASH_KEY;
  if (hashKey === undefined || hashKey.length === 0) {
    throw new Error(
      "catalog-local-corpus-scan requires --hash-key or ITOTORI_LOCAL_CORPUS_HASH_KEY for stable private hashes",
    );
  }
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
    tool: {
      name: catalogLocalScannerName,
      version: catalogLocalScannerVersion,
    },
    scanRoot: {
      labelHash: privateHash("root-label", options.rootLabel ?? "local-root"),
      pathHash: rootPathHash,
      pathRedactionClass: "private_path_hash",
    },
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    owned,
    summary: summarize(entries, root),
    hashes: {
      rootPathHash,
      reportFingerprintHash,
    },
    privacy: {
      hashMode: "hmac-sha256",
      hashKeyProvided: true,
      keyEmitted: false,
    },
    entries,
  };
}

async function buildEntries(
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
  )) {
    entries.push(await archiveEntry(file, rootPathHash, owned, privateHash));
  }
  for (const directory of directoryCandidates) {
    entries.push(directoryEntry(directory, rootPathHash, owned, privateHash));
  }

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
    localId: `catalog-local-entry:${privateHashHex(
      privateHash.key,
      "entry-id",
      `${pathHash}:source_archive`,
    )}`,
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
    evidence: {
      archiveFileCount,
      expandedArchiveMarkerCount,
    },
  };
  const signals = {
    archiveDetection,
    engineDetection,
    localEngineEvidence,
    extensionCounts: sortedCounts(directory.extensionCounts),
    fileKindCounts: sortedCounts(directory.fileKindCounts),
    markerKinds: [...directory.markerKinds].sort(),
    relationshipEvidence: {
      collectionMember,
      edition,
      sidecarMetadata: metadata !== null,
      editionSignalKinds: metadata === null ? [] : ["safe_sidecar_hint"],
    },
    sidecarMetadata: redactedSidecarMetadata(metadata, privateHash),
  };
  return {
    localId: `catalog-local-entry:${privateHashHex(
      privateHash.key,
      "entry-id",
      `${pathHash}:${entryKind}`,
    )}`,
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
    relationshipEvidence: {
      collectionMember,
      edition,
      sidecarMetadata: metadata !== null,
      editionSignalKinds: metadata === null ? [] : ["safe_sidecar_hint"],
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

async function profileDirectory(
  absolutePath: string,
  relativePath: string,
  depth: number,
  maxDepth: number,
): Promise<DirectoryProfile> {
  const entries = await readdir(absolutePath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const directory: DirectoryProfile = {
    absolutePath,
    relativePath,
    depth,
    fileCount: 0,
    directoryCount: 0,
    byteCount: 0,
    extensionCounts: {},
    fileKindCounts: {},
    markerKinds: new Set(),
    directArchiveCount: 0,
    directDirectories: [],
    directFiles: [],
    safeMetadata: null,
  };

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const childAbsolutePath = join(absolutePath, entry.name);
    const childRelativePath = relativePath === "" ? entry.name : join(relativePath, entry.name);
    if (entry.isDirectory()) {
      directory.directoryCount += 1;
      if (depth < maxDepth) {
        const child = await profileDirectory(
          childAbsolutePath,
          childRelativePath,
          depth + 1,
          maxDepth,
        );
        directory.directDirectories.push(child);
        directory.directoryCount += child.directoryCount;
        directory.fileCount += child.fileCount;
        directory.byteCount += child.byteCount;
        mergeCounts(directory.extensionCounts, child.extensionCounts);
        mergeCounts(directory.fileKindCounts, child.fileKindCounts);
        for (const markerKind of child.markerKinds) {
          if (shouldPropagateMarkerFromChild(entry.name, markerKind)) {
            directory.markerKinds.add(markerKind);
          }
        }
      }
      if (entry.name.endsWith("_Data")) {
        directory.markerKinds.add("unity_data_directory");
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const fileStats = await stat(childAbsolutePath);
    const extension = normalizedExtension(entry.name);
    const fileKind = classifyFileKind(entry.name, extension);
    const file: FileProfile = {
      absolutePath: childAbsolutePath,
      relativePath: childRelativePath,
      extension,
      size: fileStats.size,
    };
    directory.directFiles.push(file);
    directory.fileCount += 1;
    directory.byteCount += fileStats.size;
    increment(directory.extensionCounts, publicExtensionKey(extension), 1);
    increment(directory.fileKindCounts, fileKind, 1);
    if (archiveExtensions.has(extension)) {
      directory.directArchiveCount += 1;
    }
    for (const markerKind of markerKindsForFile(entry.name, extension)) {
      directory.markerKinds.add(markerKind);
    }
    if (entry.name === catalogLocalMetadataFileName) {
      directory.safeMetadata = await readSafeMetadata(childAbsolutePath);
      directory.markerKinds.add("catalog_local_sidecar_metadata");
    }
  }

  if (directory.directArchiveCount > 0 && directory.fileCount > directory.directArchiveCount) {
    directory.markerKinds.add("expanded_archive_layout");
  }
  return directory;
}

async function readSafeMetadata(path: string): Promise<CatalogLocalSafeMetadata | null> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "catalog.local_corpus_hint.v0.1") {
    return null;
  }
  const metadata: CatalogLocalSafeMetadata = {
    schemaVersion: "catalog.local_corpus_hint.v0.1",
  };
  const entryKind = safeEnum(record.entryKind, ["installed_game", "collection_member", "edition"]);
  if (entryKind !== undefined) {
    metadata.entryKind = entryKind;
  }
  const releaseKind = safeEnum(record.releaseKind, [
    "original",
    "edition",
    "collection_member",
    "unknown",
  ]);
  if (releaseKind !== undefined) {
    metadata.releaseKind = releaseKind;
  }
  const packageKind = safeEnum(record.packageKind, [
    "archive",
    "loose_files",
    "installer",
    "unknown",
  ]);
  if (packageKind !== undefined) {
    metadata.packageKind = packageKind;
  }
  const installState = safeEnum(record.installState, [
    "source_archive",
    "installed",
    "patch_target",
    "not_installed",
    "archived",
    "unknown",
  ]);
  if (installState !== undefined) {
    metadata.installState = installState;
  }
  const collectionMemberOf =
    typeof record.collectionMemberOf === "string"
      ? safeReference(record.collectionMemberOf)
      : undefined;
  if (collectionMemberOf !== undefined) {
    metadata.collectionMemberOf = collectionMemberOf;
  }
  const editionOf =
    typeof record.editionOf === "string" ? safeReference(record.editionOf) : undefined;
  if (editionOf !== undefined) {
    metadata.editionOf = editionOf;
  }
  return metadata;
}

function redactedSidecarMetadata(
  metadata: CatalogLocalSafeMetadata | null,
  privateHash: PrivateHash,
): Record<string, unknown> | null {
  if (metadata === null) {
    return null;
  }
  return {
    schemaVersion: metadata.schemaVersion,
    ...(metadata.entryKind === undefined ? {} : { entryKind: metadata.entryKind }),
    ...(metadata.releaseKind === undefined ? {} : { releaseKind: metadata.releaseKind }),
    ...(metadata.packageKind === undefined ? {} : { packageKind: metadata.packageKind }),
    ...(metadata.installState === undefined ? {} : { installState: metadata.installState }),
    ...(metadata.collectionMemberOf === undefined
      ? {}
      : { collectionMemberOfHash: privateHash("collection-ref", metadata.collectionMemberOf) }),
    ...(metadata.editionOf === undefined
      ? {}
      : { editionOfHash: privateHash("edition-ref", metadata.editionOf) }),
  };
}

function detectEngine(directory: DirectoryProfile): CatalogLocalKaifuuDetectionReport | null {
  const rows = archiveRowsForDirectory(directory);
  return rows.length === 0 ? null : kaifuuDetectionReport(rows);
}

function kaifuuDetectionReportForArchiveFile(extension: string): CatalogLocalKaifuuDetectionReport {
  return kaifuuDetectionReport([archiveRowForExtension(extension, 1)]);
}

function kaifuuDetectionReport(
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

function localEngineEvidenceForRows(
  rows: CatalogLocalKaifuuArchiveDetectionRow[],
  evidence: CatalogLocalEngineEvidence["evidence"],
): CatalogLocalEngineEvidence | null {
  const primaryRow = rows.find((row) => row.detected && row.engineFamily !== "unknown");
  if (primaryRow === undefined) {
    return null;
  }
  return {
    schemaVersion: catalogLocalEngineEvidenceSchemaVersion,
    producer: catalogLocalScannerName,
    localDetectionSchemaVersion: catalogLocalDetectionSchemaVersion,
    adapterId: `local-scan:${primaryRow.engineFamily}`,
    engineName: primaryRow.engineFamily,
    engineSource: "local_scan",
    engineConfidence: localEngineConfidence(primaryRow),
    readiness: {
      identify: "partial",
      inventory: "unknown",
      extract: "unknown",
      patch: "unknown",
    },
    evidence,
  };
}

function localEngineConfidence(
  row: CatalogLocalKaifuuArchiveDetectionRow,
): CatalogLocalEngineEvidence["engineConfidence"] {
  if (row.signals.includes("engine_metadata") || row.signals.includes("data_directory")) {
    return "high";
  }
  if (row.signals.includes("archive") || row.signals.includes("script_or_archive")) {
    return "medium";
  }
  return "low";
}

function archiveRowsForDirectory(
  directory: DirectoryProfile,
): CatalogLocalKaifuuArchiveDetectionRow[] {
  const rows: CatalogLocalKaifuuArchiveDetectionRow[] = [];
  if (directory.markerKinds.has("rpgmaker_mv_metadata")) {
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
  }
  if (directory.markerKinds.has("rpgmaker_vxace_archive")) {
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
  }
  if (directory.markerKinds.has("renpy_script")) {
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
  }
  if (directory.markerKinds.has("kirikiri_archive")) {
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
  }
  if (directory.markerKinds.has("unity_data_directory")) {
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
  }
  return rows;
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

function isDirectoryCandidate(directory: DirectoryProfile): boolean {
  if (/^(?:www|data|game|renpy|contents|resources)$/iu.test(leafSegment(directory.relativePath))) {
    return false;
  }
  return detectEngine(directory) !== null || directory.safeMetadata !== null;
}

function markerKindsForFile(name: string, extension: string): string[] {
  const lowerName = name.toLowerCase();
  const markers: string[] = [];
  if (lowerName === "system.json") {
    markers.push("rpgmaker_mv_metadata");
  }
  if (lowerName === "game.rgss3a" || extension === ".rvdata2") {
    markers.push("rpgmaker_vxace_archive");
  }
  if (extension === ".rpy" || extension === ".rpa") {
    markers.push("renpy_script");
  }
  if (extension === ".xp3") {
    markers.push("kirikiri_archive");
  }
  return markers;
}

function shouldPropagateMarkerFromChild(childName: string, markerKind: string): boolean {
  if (markerKind === "expanded_archive_layout") {
    return true;
  }
  return /^(?:www|data|game|renpy|contents|resources)$/iu.test(childName);
}

function classifyFileKind(name: string, extension: string): string {
  if (archiveExtensions.has(extension)) {
    return "archive";
  }
  if (installerExtensions.has(extension)) {
    return "installer";
  }
  if (scriptExtensions.has(extension)) {
    return "engine_or_script_metadata";
  }
  if (imageExtensions.has(extension)) {
    return "image_asset";
  }
  if (audioExtensions.has(extension)) {
    return "audio_asset";
  }
  if (videoExtensions.has(extension)) {
    return "video_asset";
  }
  return "other";
}

function summarize(
  entries: CatalogLocalScanEntry[],
  root: DirectoryProfile,
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
    if (entry.engineDetection !== null) {
      for (const row of entry.engineDetection.archiveDetection.rows) {
        if (row.detected) {
          increment(byEngine, row.engineFamily, 1);
        }
      }
    }
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

function flattenDirectories(directory: DirectoryProfile): DirectoryProfile[] {
  return [directory, ...directory.directDirectories.flatMap((child) => flattenDirectories(child))];
}

function flattenFiles(directory: DirectoryProfile): FileProfile[] {
  return [
    ...directory.directFiles,
    ...directory.directDirectories.flatMap((child) => flattenFiles(child)),
  ];
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

function normalizedExtension(path: string): string {
  const extension = extname(path).toLowerCase();
  return extension === "" ? "[none]" : extension;
}

function publicExtensionKey(extension: string): string {
  return publicExtensionKeys.has(extension) ? extension : unknownExtensionKey;
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function leafSegment(path: string): string {
  const normalized = normalizeRelativePath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

function safeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function safeReference(value: string): string | undefined {
  return /^[a-z0-9_.:-]+$/u.test(value) ? value : undefined;
}

function increment(
  target: Record<string, number>,
  key: string,
  by: number,
): Record<string, number> {
  target[key] = (target[key] ?? 0) + by;
  return target;
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, count] of Object.entries(source)) {
    increment(target, key, count);
  }
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

type PrivateHash = ((scope: string, value: string | Buffer) => string) & { key: string };

function createPrivateHash(key: string): PrivateHash {
  const privateHash = ((scope: string, value: string | Buffer): string => {
    return `sha256:${privateHashHex(key, scope, value)}`;
  }) as PrivateHash;
  privateHash.key = key;
  return privateHash;
}

function privateHashHex(key: string, scope: string, value: string | Buffer): string {
  return createHmac("sha256", key).update(scope).update("\0").update(value).digest("hex");
}

function sha256(value: string | Buffer): string {
  return `sha256:${hashHex(value)}`;
}

function hashHex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
