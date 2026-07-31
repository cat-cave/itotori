import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, readdirSync, readlinkSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { isRecord } from "./evidence-contract.js";

const REFERENCE_KINDS: Readonly<Record<string, string>> = {
  "patch receipt": "managed artifact handle",
  "compatibility proof": "relative public handle",
  "runtime observation": "changed artifact handle",
  "independent comparison": "proof graph",
  "coherent evidence set": "managed manifest handle",
  "mixed evidence set": "managed manifest handle",
  "regenerated evidence set": "managed manifest handle",
};

const REFERENCE_PREFIXES: Readonly<Record<string, string>> = {
  "managed artifact handle": "managed/",
  "relative public handle": "public/",
  "changed artifact handle": "changed/",
  "proof graph": "proof/",
  "managed manifest handle": "manifests/",
};

const FORBIDDEN_MARKERS: readonly (readonly [string, string])[] = [
  ["RAW_KEY::", "raw-key"],
  ["RETAIL_CONTENT::", "retail-content"],
  ["CAPTURED_IMAGE::", "captured-image"],
  ["PRIVATE_FILENAME::", "private-filename"],
  ["PRIVATE_PATH::", "private-path"],
];

export function scanForbiddenClasses(bytes: Uint8Array): readonly string[] {
  const content = Buffer.from(bytes).toString("utf8");
  return FORBIDDEN_MARKERS.filter(([marker]) => content.includes(marker)).map(([, name]) => name);
}

export function expectedReferenceKind(evidenceKind: string): string | null {
  return REFERENCE_KINDS[evidenceKind] ?? null;
}

export function referenceHasExpectedKind(reference: string, referenceKind: string): boolean {
  const prefix = REFERENCE_PREFIXES[referenceKind];
  return prefix !== undefined && reference.startsWith(prefix);
}

export function portableReferenceSyntax(reference: string): boolean {
  if (
    reference.length === 0 ||
    reference.includes("\\") ||
    reference.includes(":") ||
    reference.startsWith("/")
  )
    return false;
  return !reference
    .split("/")
    .some(
      (part) =>
        part.length === 0 || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/u.test(part),
    );
}

export function portableFile(root: string, reference: string): string | null {
  if (!portableReferenceSyntax(reference)) return null;
  const canonicalRoot = realpathSync(root);
  let current = canonicalRoot;
  for (const part of reference.split("/")) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }
  const canonical = realpathSync(current);
  const fromRoot = relative(canonicalRoot, canonical);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    resolve(canonicalRoot, fromRoot) !== canonical ||
    !lstatSync(canonical).isFile()
  )
    return null;
  return canonical;
}

export function treeDigest(root: string): string {
  const hash = createHash("sha256");
  function visit(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = resolve(directory, entry.name);
      const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      hash.update(name).update("\0");
      if (entry.isDirectory()) {
        hash.update("directory\0");
        visit(path, name);
      } else if (entry.isSymbolicLink()) hash.update("symlink\0").update(readlinkSync(path));
      else if (entry.isFile()) hash.update("file\0").update(readFileSync(path));
      else throw new Error(`unsupported-evidence-entry:${name}`);
      hash.update("\n");
    }
  }
  visit(root, "");
  return hash.digest("hex");
}

function containsLocalReference(value: unknown): boolean {
  if (typeof value === "string")
    return (
      value.includes("file://") ||
      value.includes("../") ||
      value.includes("\\") ||
      /[A-Za-z]:\//u.test(value) ||
      /\/(?:scratch|home|tmp|private|Users)\//u.test(value)
    );
  if (Array.isArray(value)) return value.some(containsLocalReference);
  return isRecord(value) && Object.values(value).some(containsLocalReference);
}

export function publishableTreeIsSafe(root: string): boolean {
  function visit(directory: string): boolean {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) return false;
      if (entry.isDirectory()) {
        if (!visit(path)) return false;
        continue;
      }
      const bytes = readFileSync(path);
      if (scanForbiddenClasses(bytes).length > 0) return false;
      try {
        if (containsLocalReference(JSON.parse(bytes.toString("utf8")))) return false;
      } catch {
        const content = bytes.toString("utf8");
        if (
          content.includes("file://") ||
          content.includes("../") ||
          /\/(?:scratch|home|tmp|private|Users)\//u.test(content) ||
          /[A-Za-z]:\//u.test(content)
        )
          return false;
      }
    }
    return true;
  }
  return visit(root);
}
