import type {
  CatalogLocalInstallState,
  CatalogLocalPackageKind,
} from "./catalog-local-scan-contract.js";

export type FileProfile = {
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
};
export type CatalogLocalSafeMetadata = {
  schemaVersion: "catalog.local_corpus_hint.v0.1";
  entryKind?: "installed_game" | "collection_member" | "edition";
  releaseKind?: "original" | "edition" | "collection_member" | "unknown";
  packageKind?: CatalogLocalPackageKind;
  installState?: CatalogLocalInstallState;
  collectionMemberOf?: string;
  editionOf?: string;
};
export type DirectoryProfile = {
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
