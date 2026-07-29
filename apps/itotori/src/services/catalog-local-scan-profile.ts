import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { catalogLocalMetadataFileName } from "./catalog-local-scan-contract.js";
import { detectEngine } from "./catalog-local-scan-detection.js";
import type {
  CatalogLocalSafeMetadata,
  DirectoryProfile,
  FileProfile,
} from "./catalog-local-scan-model.js";
import {
  archiveExtensions,
  classifyFileKind,
  increment,
  leafSegment,
  normalizedExtension,
  publicExtensionKey,
  safeEnum,
  safeReference,
} from "./catalog-local-scan-utils.js";

export async function profileDirectory(
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
    if (entry.isSymbolicLink()) continue;
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
        for (const markerKind of child.markerKinds)
          if (shouldPropagateMarkerFromChild(entry.name, markerKind))
            directory.markerKinds.add(markerKind);
      }
      if (entry.name.endsWith("_Data")) directory.markerKinds.add("unity_data_directory");
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStats = await stat(childAbsolutePath);
    const extension = normalizedExtension(entry.name);
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
    increment(directory.fileKindCounts, classifyFileKind(entry.name, extension), 1);
    if (archiveExtensions.has(extension)) directory.directArchiveCount += 1;
    for (const markerKind of markerKindsForFile(entry.name, extension))
      directory.markerKinds.add(markerKind);
    if (entry.name === catalogLocalMetadataFileName) {
      directory.safeMetadata = await readSafeMetadata(childAbsolutePath);
      directory.markerKinds.add("catalog_local_sidecar_metadata");
    }
  }
  if (directory.directArchiveCount > 0 && directory.fileCount > directory.directArchiveCount)
    directory.markerKinds.add("expanded_archive_layout");
  return directory;
}
export function flattenDirectories(directory: DirectoryProfile): DirectoryProfile[] {
  return [directory, ...directory.directDirectories.flatMap((child) => flattenDirectories(child))];
}
export function flattenFiles(directory: DirectoryProfile): FileProfile[] {
  return [
    ...directory.directFiles,
    ...directory.directDirectories.flatMap((child) => flattenFiles(child)),
  ];
}
export function isDirectoryCandidate(directory: DirectoryProfile): boolean {
  if (/^(?:www|data|game|renpy|contents|resources)$/iu.test(leafSegment(directory.relativePath)))
    return false;
  return detectEngine(directory) !== null || directory.safeMetadata !== null;
}
function markerKindsForFile(name: string, extension: string): string[] {
  const lowerName = name.toLowerCase();
  const markers: string[] = [];
  if (lowerName === "system.json") markers.push("rpgmaker_mv_metadata");
  if (lowerName === "game.rgss3a" || extension === ".rvdata2")
    markers.push("rpgmaker_vxace_archive");
  if (extension === ".rpy" || extension === ".rpa") markers.push("renpy_script");
  if (extension === ".xp3") markers.push("kirikiri_archive");
  return markers;
}
function shouldPropagateMarkerFromChild(childName: string, markerKind: string): boolean {
  if (markerKind === "expanded_archive_layout") return true;
  return /^(?:www|data|game|renpy|contents|resources)$/iu.test(childName);
}
async function readSafeMetadata(path: string): Promise<CatalogLocalSafeMetadata | null> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "catalog.local_corpus_hint.v0.1") return null;
  const metadata: CatalogLocalSafeMetadata = { schemaVersion: "catalog.local_corpus_hint.v0.1" };
  const entryKind = safeEnum(record.entryKind, ["installed_game", "collection_member", "edition"]);
  if (entryKind !== undefined) metadata.entryKind = entryKind;
  const releaseKind = safeEnum(record.releaseKind, [
    "original",
    "edition",
    "collection_member",
    "unknown",
  ]);
  if (releaseKind !== undefined) metadata.releaseKind = releaseKind;
  const packageKind = safeEnum(record.packageKind, [
    "archive",
    "loose_files",
    "installer",
    "unknown",
  ]);
  if (packageKind !== undefined) metadata.packageKind = packageKind;
  const installState = safeEnum(record.installState, [
    "source_archive",
    "installed",
    "patch_target",
    "not_installed",
    "archived",
    "unknown",
  ]);
  if (installState !== undefined) metadata.installState = installState;
  const collectionMemberOf =
    typeof record.collectionMemberOf === "string"
      ? safeReference(record.collectionMemberOf)
      : undefined;
  if (collectionMemberOf !== undefined) metadata.collectionMemberOf = collectionMemberOf;
  const editionOf =
    typeof record.editionOf === "string" ? safeReference(record.editionOf) : undefined;
  if (editionOf !== undefined) metadata.editionOf = editionOf;
  return metadata;
}
export function redactedSidecarMetadata(
  metadata: CatalogLocalSafeMetadata | null,
  privateHash: (scope: string, value: string | Buffer) => string,
): Record<string, unknown> | null {
  if (metadata === null) return null;
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
function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, count] of Object.entries(source)) increment(target, key, count);
}
