#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicFixturesDir = resolve(repoRoot, "fixtures/public");
const schemaPath = resolve(publicFixturesDir, "manifest.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const manifestPaths = findManifests(publicFixturesDir);
const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(schema);
const errors = [];

if (manifestPaths.length === 0) {
  errors.push("no public fixture manifests found under fixtures/public");
}

for (const manifestPath of manifestPaths) {
  const manifest = loadJson(manifestPath);
  if (!manifest) {
    continue;
  }

  if (!validate(manifest)) {
    for (const error of validate.errors ?? []) {
      errors.push(
        `${relative(repoRoot, manifestPath)} ${error.instancePath || "/"} ${error.message}`,
      );
    }
    continue;
  }

  for (const file of manifest.files) {
    validateFixtureFile(manifestPath, file);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(`validated ${manifestPaths.length} public fixture manifest(s)`);

function findManifests(root) {
  const results = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...findManifests(path));
    } else if (entry.isFile() && entry.name.endsWith(".manifest.json")) {
      results.push(path);
    }
  }
  return results.sort();
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${relative(repoRoot, path)} failed to parse: ${error.message}`);
    return undefined;
  }
}

function validateFixtureFile(manifestPath, file) {
  const displayPath = `${relative(repoRoot, manifestPath)} file ${file.path}`;
  const absolutePath = resolve(repoRoot, file.path);
  const relativePath = relative(repoRoot, absolutePath);

  if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes("..")) {
    errors.push(`${displayPath} must stay inside the repository`);
    return;
  }
  if (relativePath.startsWith("fixtures/private-local/")) {
    errors.push(`${displayPath} must not reference fixtures/private-local`);
    return;
  }
  if (basename(relativePath) === "") {
    errors.push(`${displayPath} must reference a file`);
    return;
  }

  let bytes;
  let sha256;
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      errors.push(`${displayPath} is not a file`);
      return;
    }
    const content = readFileSync(absolutePath);
    bytes = stat.size;
    sha256 = createHash("sha256").update(content).digest("hex");
  } catch (error) {
    errors.push(`${displayPath} cannot be read: ${error.message}`);
    return;
  }

  if (file.bytes !== bytes) {
    errors.push(`${displayPath} byte count ${file.bytes} does not match ${bytes}`);
  }
  if (file.sha256 !== sha256) {
    errors.push(`${displayPath} sha256 ${file.sha256} does not match ${sha256}`);
  }
}
