import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Raised when a PatchVersion names missing, mismatched, or unsafe bytes. */
export class LocalizationArtifactIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalizationArtifactIntegrityError";
  }
}

/**
 * Hash one file or directory using the terminal finalizer's stable tree
 * encoding. Symlinks and other special filesystem nodes are refused so a
 * stored ref cannot change which bytes it addresses after validation.
 */
export function hashLocalizationArtifact(path: string): string {
  const hash = createHash("sha256");
  try {
    hashLocalizationArtifactInto(hash, path, path);
  } catch (error) {
    if (error instanceof LocalizationArtifactIntegrityError) throw error;
    throw new LocalizationArtifactIntegrityError(
      `artifact is missing or unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Verify exact key correspondence, existence, and content hashes. */
export function verifyLocalizationArtifactManifest(
  artifactRefs: Readonly<Record<string, string>>,
  artifactHashes: Readonly<Record<string, string>>,
): void {
  const refKeys = Object.keys(artifactRefs).sort();
  const hashKeys = Object.keys(artifactHashes).sort();
  if (refKeys.length === 0 || hashKeys.length === 0) {
    throw new LocalizationArtifactIntegrityError("artifact refs and hashes must be non-empty");
  }
  if (refKeys.length !== hashKeys.length || refKeys.some((key, index) => key !== hashKeys[index])) {
    throw new LocalizationArtifactIntegrityError(
      `artifact ref/hash keys differ (refs=${refKeys.join(",")}; hashes=${hashKeys.join(",")})`,
    );
  }
  for (const key of refKeys) {
    const path = artifactRefs[key]!;
    const expectedHash = artifactHashes[key]!;
    if (path.trim().length === 0) {
      throw new LocalizationArtifactIntegrityError(`artifact ${key} has a blank ref`);
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(expectedHash)) {
      throw new LocalizationArtifactIntegrityError(
        `artifact ${key} has an invalid sha256 hash ${expectedHash}`,
      );
    }
    const actualHash = hashLocalizationArtifact(path);
    if (actualHash !== expectedHash) {
      throw new LocalizationArtifactIntegrityError(
        `artifact ${key} hash mismatch at ${path}: expected ${expectedHash}, got ${actualHash}`,
      );
    }
  }
}

function hashLocalizationArtifactInto(
  hash: ReturnType<typeof createHash>,
  root: string,
  path: string,
): void {
  const stat = lstatSync(path);
  const relativePath = relative(root, path) || ".";
  if (stat.isDirectory()) {
    hash.update(`directory:${relativePath}\n`);
    for (const child of readdirSync(path).sort()) {
      hashLocalizationArtifactInto(hash, root, join(path, child));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new LocalizationArtifactIntegrityError(
      `artifact path contains a non-file, non-directory node: ${path}`,
    );
  }
  hash.update(`file:${relativePath}\n`);
  hash.update(readFileSync(path));
}
