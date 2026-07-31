import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

export function requiredType(path, type, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label}-missing`);
  }
  if (stat.isSymbolicLink() || (type === "directory" ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`${label}-type-invalid`);
  }
}

export function namesBelow(path, label) {
  requiredType(path, "directory", label);
  return readdirSync(path).toSorted(lexical);
}

export function readJson(path, label) {
  requiredType(path, "file", label);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label}-invalid-json`);
  }
}

function relativeFile(root, reference, label) {
  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    reference.startsWith("/") ||
    reference.includes("\\") ||
    reference.includes(":") ||
    reference
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || !/^[\w.-]+$/u.test(part))
  ) {
    throw new Error(`${label}-path-invalid`);
  }
  const path = resolve(root, reference);
  if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error(`${label}-path-escapes`);
  requiredType(path, "file", label);
  return path;
}

export function portableEvidenceTreeDigest(root) {
  requiredType(root, "directory", "portable-evidence-tree-root");
  const hash = createHash("sha256");
  function visit(directory, prefix) {
    const entries = readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      hash.update(name);
      hash.update("\0");
      if (entry.isDirectory()) {
        hash.update("directory\0");
        visit(path, name);
      } else if (entry.isSymbolicLink()) {
        hash.update("symlink\0");
        hash.update(readlinkSync(path));
      } else if (entry.isFile()) {
        hash.update("file\0");
        hash.update(readFileSync(path));
      } else {
        throw new Error(`unsupported-evidence-entry:${name}`);
      }
      hash.update("\n");
    }
  }
  visit(root, "");
  return hash.digest("hex");
}

function bundleReferences(manifest, label) {
  const references = [];
  function pair(value, pairLabel) {
    const item = record(value, pairLabel);
    references.push(
      text(item.evaluated, `${pairLabel}-evaluated`),
      text(item.expectation, `${pairLabel}-expectation`),
    );
  }
  pair(manifest.main, `${label}-main`);
  const controls = record(manifest.controls, `${label}-controls`);
  for (const name of ["copied", "tampered", "stale"]) {
    pair(controls[name], `${label}-control-${name}`);
  }
  return references;
}

export function assertExactBundleLayout(bundleRoot, label) {
  requiredType(bundleRoot, "directory", label);
  const expectedFiles = new Set(["manifest.json"]);
  const manifest = record(readJson(resolve(bundleRoot, "manifest.json"), label), label);
  for (const reference of bundleReferences(manifest, label)) {
    const manifestPath = relativeFile(bundleRoot, reference, `${label}-record`);
    expectedFiles.add(reference);
    const item = record(readJson(manifestPath, `${label}-record`), `${label}-record`);
    if (item.published === true) {
      const artifact = text(item.reference, `${label}-artifact-reference`);
      relativeFile(bundleRoot, artifact, `${label}-artifact`);
      expectedFiles.add(artifact);
    } else if (item.recordClass === "restricted-local-receipt") {
      const artifact = text(item.reference, `${label}-private-artifact-reference`);
      const census = text(item.censusReference, `${label}-census-reference`);
      relativeFile(bundleRoot, artifact, `${label}-private-artifact`);
      relativeFile(bundleRoot, census, `${label}-census`);
      expectedFiles.add(artifact);
      expectedFiles.add(census);
    } else if (item.published !== false) {
      throw new Error(`${label}-publication-invalid`);
    }
  }
  const expectedDirectories = new Set();
  for (const file of expectedFiles) {
    for (let parent = dirname(file); parent !== "."; parent = dirname(parent)) {
      expectedDirectories.add(parent);
    }
  }
  const actualFiles = [];
  const actualDirectories = [];
  function visit(directory, prefix) {
    for (const name of namesBelow(directory, `${label}-directory`)) {
      const path = resolve(directory, name);
      const reference = prefix.length === 0 ? name : `${prefix}/${name}`;
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        throw new Error(`${label}-entry-missing:${reference}`);
      }
      if (stat.isSymbolicLink()) throw new Error(`${label}-symlink:${reference}`);
      if (stat.isDirectory()) {
        actualDirectories.push(reference);
        visit(path, reference);
      } else if (stat.isFile()) {
        actualFiles.push(reference);
      } else {
        throw new Error(`${label}-entry-type-invalid:${reference}`);
      }
    }
  }
  visit(bundleRoot, "");
  for (const [actual, expected, kind] of [
    [actualFiles, [...expectedFiles], "files"],
    [actualDirectories, [...expectedDirectories], "directories"],
  ]) {
    actual.sort(lexical);
    expected.sort(lexical);
    if (
      actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])
    ) {
      throw new Error(`${label}-${kind}-mismatch`);
    }
  }
}
