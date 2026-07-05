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
// KAIFUU-203: the hand-authored CC0 KAG `.ks` corpus manifest declares a
// distinct shape (verbatim `SPDX-License-Identifier`, per-file KAG tag
// inventory) and points its `$schema` at `kag-corpus.manifest.schema.json`.
// Each manifest is validated against the schema it declares.
const kagCorpusSchemaSuffix = "kag-corpus.manifest.schema.json";
const kagCorpusSchemaPath = resolve(publicFixturesDir, kagCorpusSchemaSuffix);
const kagCorpusSchema = JSON.parse(readFileSync(kagCorpusSchemaPath, "utf8"));
const helperResultDir = resolve(publicFixturesDir, "kaifuu-helper-results");
const helperResultSchemaPath = resolve(helperResultDir, "helper-result.schema.json");
const helperResultSchema = JSON.parse(readFileSync(helperResultSchemaPath, "utf8"));
const helperRegistrySchemaPath = resolve(helperResultDir, "helper-registry.schema.json");
const helperRegistrySchema = JSON.parse(readFileSync(helperRegistrySchemaPath, "utf8"));
const manifestPaths = findManifests(publicFixturesDir);
const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(schema);
const validateKagCorpus = ajv.compile(kagCorpusSchema);
const validateHelperResult = ajv.compile(helperResultSchema);
const validateHelperRegistry = ajv.compile(helperRegistrySchema);
const errors = [];

if (manifestPaths.length === 0) {
  errors.push("no public fixture manifests found under fixtures/public");
}

for (const manifestPath of manifestPaths) {
  const manifest = loadJson(manifestPath);
  if (!manifest) {
    continue;
  }

  const declaredSchema = typeof manifest.$schema === "string" ? manifest.$schema : "";
  const isKagCorpus = declaredSchema.endsWith(kagCorpusSchemaSuffix);
  const activeValidate = isKagCorpus ? validateKagCorpus : validate;

  if (!activeValidate(manifest)) {
    for (const error of activeValidate.errors ?? []) {
      errors.push(
        `${relative(repoRoot, manifestPath)} ${error.instancePath || "/"} ${error.message}`,
      );
    }
    continue;
  }

  for (const file of manifest.files) {
    validateFixtureFile(manifestPath, file);
    if (isKagCorpus) {
      continue;
    }
    if (file.role === "helper-result") {
      validateHelperResultFixture(resolve(repoRoot, file.path), true);
    } else if (file.role === "helper-registry") {
      validateHelperRegistryFixture(resolve(repoRoot, file.path), true);
    } else if (file.role === "helper-registry-invalid") {
      validateHelperRegistryFixture(resolve(repoRoot, file.path), false);
    }
  }
}

validateInvalidHelperResultFixtures();

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

function findJsonFiles(root) {
  const results = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
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

function validateInvalidHelperResultFixtures() {
  const invalidDir = resolve(helperResultDir, "invalid");
  for (const fixturePath of findJsonFiles(invalidDir)) {
    validateHelperResultFixture(fixturePath, false);
  }
}

function validateHelperResultFixture(fixturePath, expectedValid) {
  const fixture = loadJson(fixturePath);
  if (!fixture) {
    return;
  }

  const schemaValid = validateHelperResult(fixture);
  const policyFailures = helperResultSecretRefPolicyFailures(fixture);
  const valid = schemaValid && policyFailures.length === 0;
  const displayPath = relative(repoRoot, fixturePath);
  const fixtureId = redactDiagnosticText(
    typeof fixture.fixtureId === "string" ? fixture.fixtureId : "<missing-fixture-id>",
  );

  if (expectedValid && !valid) {
    for (const error of validateHelperResult.errors ?? []) {
      errors.push(helperResultDiagnostic(displayPath, fixtureId, errorField(error), error.message));
    }
    for (const failure of policyFailures) {
      errors.push(helperResultDiagnostic(displayPath, fixtureId, failure.field, failure.message));
    }
  } else if (!expectedValid && valid) {
    errors.push(`${displayPath} fixtureId=${fixtureId} expected helper-result validation failure`);
  }
}

function validateHelperRegistryFixture(fixturePath, expectedValid) {
  const fixture = loadJson(fixturePath);
  if (!fixture) {
    return;
  }

  const schemaValid = validateHelperRegistry(fixture);
  const displayPath = relative(repoRoot, fixturePath);
  const helperId = redactDiagnosticText(
    typeof fixture.helperId === "string" ? fixture.helperId : "<missing-helper-id>",
  );

  if (expectedValid && !schemaValid) {
    for (const error of validateHelperRegistry.errors ?? []) {
      errors.push(
        helperRegistryDiagnostic(displayPath, helperId, errorField(error), error.message),
      );
    }
  } else if (!expectedValid && schemaValid) {
    errors.push(
      `${displayPath} helperId=${helperId} expected helper-registry schema validation failure`,
    );
  }
}

function helperRegistryDiagnostic(path, helperId, field, message) {
  return `${path} helperId=${helperId} field=${field} ${redactDiagnosticText(message ?? "helper-registry validation failed")}`;
}

function helperResultSecretRefPolicyFailures(fixture) {
  const failures = [];
  if (!Array.isArray(fixture.secretRefs)) {
    return failures;
  }
  fixture.secretRefs.forEach((entry, index) => {
    const secretRef = entry?.secretRef;
    if (typeof secretRef !== "string") {
      return;
    }
    if (!isValidSecretRef(secretRef)) {
      failures.push({
        field: `secretRefs.${index}.secretRef`,
        message:
          "secretRef must use a local secret-ref scheme and must not contain raw key material, local paths, whitespace, parent traversal, or null bytes",
      });
    }
  });
  return failures;
}

function isValidSecretRef(value) {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    return false;
  }
  const scheme = value.slice(0, separator);
  const name = value.slice(separator + 1);
  if (!["local-secret", "os-keychain", "secret-manager", "prompt"].includes(scheme)) {
    return false;
  }
  if (
    name.length === 0 ||
    name.trim() !== name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.split("/").some((component) => component.length === 0 || component === "..") ||
    isLocalAbsolutePath(name) ||
    secretRefNameContainsRawKeyMaterial(name)
  ) {
    return false;
  }
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

function secretRefNameContainsRawKeyMaterial(name) {
  return looksLikeRawKeyMaterial(name) || name.split("/").some(looksLikeRawKeyMaterial);
}

function isLocalAbsolutePath(text) {
  return (
    text.startsWith("/") ||
    text.startsWith("\\") ||
    text.split(/[\\/]/).some((component) => /^[A-Za-z]:/.test(component)) ||
    pathStartsWithHomeOrLocalEnvVar(text)
  );
}

function pathStartsWithHomeOrLocalEnvVar(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return true;
  }
  return [
    "$HOME",
    "${HOME}",
    "$USERPROFILE",
    "${USERPROFILE}",
    "$HOMEPATH",
    "${HOMEPATH}",
    "$APPDATA",
    "${APPDATA}",
    "$LOCALAPPDATA",
    "${LOCALAPPDATA}",
    "%HOME%",
    "%USERPROFILE%",
    "%HOMEPATH%",
    "%APPDATA%",
    "%LOCALAPPDATA%",
    "%TEMP%",
    "%TMP%",
  ].some(
    (prefix) =>
      trimmed.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() &&
      ["\\", "/"].includes(trimmed[prefix.length]),
  );
}

function looksLikeRawKeyMaterial(text) {
  const hexCompact = text.replace(/[ \t\n\r:-]/g, "");
  if (hexCompact.length >= 32 && hexCompact.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(hexCompact)) {
    return true;
  }
  const encodedCompact = text.replace(/[ \t\n\r]/g, "");
  return (
    looksLikeBase64KeyMaterial(encodedCompact) || looksLikeBase64UrlKeyMaterial(encodedCompact)
  );
}

function looksLikeBase64KeyMaterial(text) {
  return (
    text.length >= 22 &&
    /^[A-Za-z0-9+/=]+$/.test(text) &&
    /[+/=]/.test(text) &&
    base64PaddingIsValid(text) &&
    encodedMaterialEntropy(text) >= 4.0
  );
}

function looksLikeBase64UrlKeyMaterial(text) {
  const unpadded = text.replace(/=+$/, "");
  if (unpadded.length < 22 || unpadded.length > 256) {
    return false;
  }
  if (!base64PaddingIsValid(text) || !/^[A-Za-z0-9_-]+$/.test(unpadded)) {
    return false;
  }
  const hasLowercase = /[a-z]/.test(unpadded);
  const hasUppercase = /[A-Z]/.test(unpadded);
  const hasDigit = /[0-9]/.test(unpadded);
  const hasUrlSymbol = /[-_]/.test(unpadded);
  const signalClasses = Number(hasLowercase) + Number(hasUppercase) + Number(hasDigit);
  const entropy = encodedMaterialEntropy(unpadded);
  return (
    (signalClasses >= 3 && entropy >= 4.0) ||
    (hasUrlSymbol && signalClasses >= 2 && entropy >= 3.8) ||
    (hasLowercase && hasUppercase && unpadded.length >= 24 && entropy >= 4.0)
  );
}

function base64PaddingIsValid(text) {
  if (text.length % 4 === 1) {
    return false;
  }
  const firstPadding = text.indexOf("=");
  return firstPadding === -1 || /^=+$/.test(text.slice(firstPadding));
}

function encodedMaterialEntropy(text) {
  const sample = text.replace(/=+$/, "");
  if (sample.length === 0) {
    return 0;
  }
  const frequencies = new Map();
  for (const character of sample) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / sample.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function errorField(error) {
  return error.instancePath
    ? error.instancePath
        .slice(1)
        .split("/")
        .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
        .join(".")
    : "$";
}

function helperResultDiagnostic(path, fixtureId, field, message) {
  return `${path} fixtureId=${fixtureId} field=${field} ${redactDiagnosticText(message ?? "helper-result validation failed")}`;
}

function redactDiagnosticText(message) {
  return String(message)
    .replace(/\/[^\s"'`]+/g, "[REDACTED:kaifuu.secret.redacted]")
    .replace(/[A-Fa-f0-9]{32,}/g, "[REDACTED:kaifuu.secret.redacted]")
    .replace(
      /(?=[A-Za-z0-9_-]{22,}={0,2})(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{22,}={0,2}/g,
      "[REDACTED:kaifuu.secret.redacted]",
    );
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
