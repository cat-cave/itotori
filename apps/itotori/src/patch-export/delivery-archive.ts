// p0-result-revision — safe, real-byte delivery archive for a selected patch.
//
// The delivery API never turns a client-supplied path into a filesystem read.
// It receives the selected PatchVersion only after the production exporter has
// checked its hash-bound manifest, then archives exactly the trusted
// `patchTarget` tree. Symlinks and special filesystem entries are rejected so
// an archive cannot escape the delivered patch root.

import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { verifyLocalizationArtifactManifest, type SelectedPatchExport } from "@itotori/db";

export type DeliveredPatchArchive = {
  contentType: "application/x-tar";
  fileName: string;
  bytes: Buffer;
};

type ArchiveEntry =
  | { path: string; kind: "directory" }
  | { path: string; kind: "file"; bytes: Buffer };

/**
 * Build a deterministic tar archive of the selected production patch target.
 * Manifest verification is repeated here as a defense-in-depth guard because
 * this is the final byte-serving boundary, not merely metadata inspection.
 */
export async function createDeliveredPatchArchive(
  selected: SelectedPatchExport,
): Promise<DeliveredPatchArchive> {
  verifyLocalizationArtifactManifest(selected.artifactRefs, selected.artifactHashes);
  const patchTarget = selected.artifactRefs.patchTarget;
  if (patchTarget === undefined || patchTarget.trim().length === 0) {
    throw new Error(`selected patch ${selected.patchVersionId} has no patchTarget artifact`);
  }

  const suppliedRoot = resolve(patchTarget);
  const suppliedStat = await lstat(suppliedRoot);
  if (suppliedStat.isSymbolicLink() || !suppliedStat.isDirectory()) {
    throw new Error(
      `selected patch ${selected.patchVersionId} patchTarget must be a real directory`,
    );
  }
  const root = await realpath(suppliedRoot);
  const entries = await collectArchiveEntries(root, root);

  return {
    contentType: "application/x-tar",
    fileName: `${safeDownloadName(selected.patchVersionId)}.tar`,
    bytes: encodeTar(entries),
  };
}

async function collectArchiveEntries(root: string, directory: string): Promise<ArchiveEntry[]> {
  assertWithinRoot(root, directory);
  const entries: ArchiveEntry[] = [];
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const path = resolve(directory, child.name);
    assertWithinRoot(root, path);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `refusing symbolic link in delivered patch archive: ${archivePath(root, path)}`,
      );
    }
    if (stat.isDirectory()) {
      const directoryPath = `${archivePath(root, path)}/`;
      entries.push({ path: directoryPath, kind: "directory" });
      entries.push(...(await collectArchiveEntries(root, path)));
      continue;
    }
    if (stat.isFile()) {
      entries.push({ path: archivePath(root, path), kind: "file", bytes: await readFile(path) });
      continue;
    }
    throw new Error(
      `refusing non-file entry in delivered patch archive: ${archivePath(root, path)}`,
    );
  }
  return entries;
}

function assertWithinRoot(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "") {
    return;
  }
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`..${sep}`)) {
    throw new Error("delivered patch archive path escapes its trusted patchTarget root");
  }
}

function archivePath(root: string, absolutePath: string): string {
  const path = relative(root, absolutePath).split(sep).join("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("delivered patch archive contains an unsafe entry path");
  }
  return path;
}

function encodeTar(entries: readonly ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.kind === "file" ? entry.bytes : Buffer.alloc(0);
    chunks.push(tarHeader(entry.path, entry.kind, body.length));
    if (body.length > 0) {
      chunks.push(body, Buffer.alloc(tarPadding(body.length)));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function tarHeader(path: string, kind: ArchiveEntry["kind"], size: number): Buffer {
  if (Buffer.byteLength(path, "utf8") > 100) {
    throw new Error(`delivered patch archive entry is too long for portable tar: ${path}`);
  }
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, path);
  writeTarOctal(header, 100, 8, kind === "directory" ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = kind === "directory" ? "5".charCodeAt(0) : "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = `${checksum.toString(8).padStart(6, "0")}\0 `;
  header.write(checksumText, 148, 8, "ascii");
  return header;
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error("delivered patch archive field exceeds tar header capacity");
  }
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const digits = value.toString(8);
  if (digits.length > length - 1) {
    throw new Error("delivered patch archive value exceeds tar header capacity");
  }
  buffer.write(`${digits.padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tarPadding(length: number): number {
  return (512 - (length % 512)) % 512;
}

function safeDownloadName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "patch";
}
