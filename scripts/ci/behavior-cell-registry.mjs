import { globSync, lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const IDENTIFIER = "[a-z0-9]+(?:[.-][a-z0-9]+)*";
const CELL = new RegExp(`^cell::(${IDENTIFIER})::(${IDENTIFIER})$`, "u");
const BEHAVIOR = new RegExp(`^${IDENTIFIER}$`, "u");
const LANE = /^[a-z0-9][a-z0-9-]*$/u;
const CAPSULE_NAME = new RegExp(`^${IDENTIFIER}--${IDENTIFIER}$`, "u");
const DRIVER_MODULE = new RegExp(`^capsules/${IDENTIFIER}--${IDENTIFIER}/driver\\.js$`, "u");
const MUTATION_MODULE = new RegExp(
  `^suite/behavior/capsules/${IDENTIFIER}--${IDENTIFIER}/mutation\\.mjs$`,
  "u",
);
const CAPSULE_SCHEMA = "itotori.behavior-proof-capsule.v1";
const CAPSULE_MANIFEST = "capsule.json";
const CAPSULE_DRIVER = "driver.ts";
const CAPSULE_MUTATION = "mutation.mjs";
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export const BEHAVIOR_CELL_CAPSULE_ROOT = "suite/behavior/capsules";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "../..");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`behavior-cell-registry-${label}-invalid`);
  }
  return value;
}

function cellParts(cell) {
  const match = CELL.exec(cell);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`behavior-cell-registry-cell-invalid:${cell}`);
  }
  return { behavior: match[1], subject: match[2] };
}

export function capsuleDirectoryName(behavior, subject) {
  requiredText(behavior, "capsule-behavior", BEHAVIOR);
  requiredText(subject, "capsule-subject", BEHAVIOR);
  return `${behavior}--${subject}`;
}

function expectedModules(behavior, subject) {
  const directory = capsuleDirectoryName(behavior, subject);
  return {
    driverModule: `capsules/${directory}/driver.js`,
    mutationModule: `${BEHAVIOR_CELL_CAPSULE_ROOT}/${directory}/${CAPSULE_MUTATION}`,
  };
}

function validatePortableEvidence(value, cell) {
  if (!isRecord(value)) throw new Error(`behavior-cell-registry-portable-evidence-invalid:${cell}`);
  if (!Number.isInteger(value.expectedCaseCount) || value.expectedCaseCount < 1) {
    throw new Error(`behavior-cell-registry-portable-evidence-count-invalid:${cell}`);
  }
  return Object.freeze({ expectedCaseCount: value.expectedCaseCount });
}

export function validateBehaviorCells(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("behavior-cell-registry-empty-or-invalid");
  }
  const cells = new Set();
  const normalized = [];
  let portableEvidenceCount = 0;
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) throw new Error(`behavior-cell-registry-entry-invalid:${index}`);
    const cell = requiredText(entry.cell, `cell-${index}`, CELL);
    const behavior = requiredText(entry.behavior, `behavior-${index}`, BEHAVIOR);
    const lane = requiredText(entry.lane, `lane-${index}`, LANE);
    const driverModule = requiredText(entry.driverModule, `driver-module-${index}`, DRIVER_MODULE);
    const mutationModule = requiredText(
      entry.mutationModule,
      `mutation-module-${index}`,
      MUTATION_MODULE,
    );
    const { behavior: declaredBehavior, subject } = cellParts(cell);
    if (behavior !== declaredBehavior) {
      throw new Error(`behavior-cell-registry-identity-mismatch:${cell}`);
    }
    if (cells.has(cell)) throw new Error(`behavior-cell-registry-duplicate-cell:${cell}`);
    cells.add(cell);
    const expected = expectedModules(behavior, subject);
    if (driverModule !== expected.driverModule) {
      throw new Error(`behavior-cell-registry-driver-module-mismatch:${cell}`);
    }
    if (mutationModule !== expected.mutationModule) {
      throw new Error(`behavior-cell-registry-mutation-module-mismatch:${cell}`);
    }
    const portableEvidence =
      entry.portableEvidence === undefined
        ? undefined
        : validatePortableEvidence(entry.portableEvidence, cell);
    if (portableEvidence !== undefined) portableEvidenceCount += 1;
    normalized.push(
      Object.freeze({
        cell,
        behavior,
        lane,
        driverModule,
        mutationModule,
        ...(portableEvidence === undefined ? {} : { portableEvidence }),
      }),
    );
  }
  if (portableEvidenceCount > 1) {
    throw new Error("behavior-cell-registry-portable-evidence-duplicate");
  }
  return normalized.toSorted((left, right) => lexical(left.cell, right.cell));
}

function existingDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label}-missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label}-type-invalid`);
}

function existingFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label}-missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label}-type-invalid`);
}

function exactManifestKeys(value, directory) {
  const required = ["behavior", "cell", "driver", "lane", "mutation", "schema", "subject"];
  const expected = [
    ...required,
    ...(Object.hasOwn(value, "portableEvidence") ? ["portableEvidence"] : []),
  ].toSorted();
  const actual = Object.keys(value).toSorted();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`behavior-cell-capsule-manifest-keys-invalid:${directory}`);
  }
}

function readCapsuleManifest(capsuleRoot, directory) {
  const path = resolve(capsuleRoot, CAPSULE_MANIFEST);
  existingFile(path, `behavior-cell-capsule-manifest:${directory}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`behavior-cell-capsule-manifest-invalid:${directory}`);
  }
  if (!isRecord(parsed)) throw new Error(`behavior-cell-capsule-manifest-invalid:${directory}`);
  exactManifestKeys(parsed, directory);
  if (parsed.schema !== CAPSULE_SCHEMA) {
    throw new Error(`behavior-cell-capsule-schema-invalid:${directory}`);
  }
  const cell = requiredText(parsed.cell, `capsule-cell:${directory}`, CELL);
  const behavior = requiredText(parsed.behavior, `capsule-behavior:${directory}`, BEHAVIOR);
  const subject = requiredText(parsed.subject, `capsule-subject:${directory}`, BEHAVIOR);
  const lane = requiredText(parsed.lane, `capsule-lane:${directory}`, LANE);
  if (parsed.driver !== CAPSULE_DRIVER) {
    throw new Error(`behavior-cell-capsule-driver-invalid:${directory}`);
  }
  if (parsed.mutation !== CAPSULE_MUTATION) {
    throw new Error(`behavior-cell-capsule-mutation-invalid:${directory}`);
  }
  if (cell !== `cell::${behavior}::${subject}`) {
    throw new Error(`behavior-cell-capsule-identity-mismatch:${directory}`);
  }
  return {
    directory,
    cell,
    behavior,
    subject,
    lane,
    ...expectedModules(behavior, subject),
    ...(parsed.portableEvidence === undefined ? {} : { portableEvidence: parsed.portableEvidence }),
  };
}

function capsuleDirectories(root) {
  const capsuleRoot = resolve(root, BEHAVIOR_CELL_CAPSULE_ROOT);
  existingDirectory(capsuleRoot, "behavior-cell-capsule-root");
  const entries = globSync("{*,.*}", { cwd: capsuleRoot, withFileTypes: true }).toSorted(
    (left, right) => lexical(left.name, right.name),
  );
  if (entries.length === 0) throw new Error("behavior-cell-capsule-root-empty");
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`behavior-cell-capsule-root-entry-invalid:${entry.name}`);
    }
  }
  return { capsuleRoot, directories: entries.map(({ name }) => name) };
}

function validateCapsuleFiles(capsuleRoot, directory) {
  const root = resolve(capsuleRoot, directory);
  existingFile(resolve(root, CAPSULE_MANIFEST), `behavior-cell-capsule-manifest:${directory}`);
  existingFile(resolve(root, CAPSULE_DRIVER), `behavior-cell-capsule-driver:${directory}`);
  existingFile(resolve(root, CAPSULE_MUTATION), `behavior-cell-capsule-mutation:${directory}`);
}

async function validateMutationModule(root, entry) {
  let loaded;
  try {
    loaded = await import(pathToFileURL(resolve(root, entry.mutationModule)).href);
  } catch {
    throw new Error(`behavior-cell-capsule-mutation-module-unavailable:${entry.cell}`);
  }
  if (!isRecord(loaded) || loaded.cell !== entry.cell) {
    throw new Error(`behavior-cell-capsule-mutation-identity-mismatch:${entry.cell}`);
  }
  if (typeof loaded.prepareFixedSuccessMutation !== "function") {
    throw new Error(`behavior-cell-capsule-mutation-export-invalid:${entry.cell}`);
  }
}

export async function discoverBehaviorCells(root = defaultRoot) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("behavior-cell-capsule-root-invalid");
  }
  const repositoryRoot = resolve(root);
  const { capsuleRoot, directories } = capsuleDirectories(repositoryRoot);
  const descriptors = directories.map((directory) =>
    readCapsuleManifest(resolve(capsuleRoot, directory), directory),
  );
  const cells = validateBehaviorCells(descriptors);
  const descriptorsByCell = new Map(descriptors.map((descriptor) => [descriptor.cell, descriptor]));
  for (const entry of cells) {
    const descriptor = descriptorsByCell.get(entry.cell);
    if (descriptor === undefined) throw new Error(`behavior-cell-capsule-missing:${entry.cell}`);
    const expectedDirectory = capsuleDirectoryName(descriptor.behavior, descriptor.subject);
    if (descriptor.directory !== expectedDirectory || !CAPSULE_NAME.test(descriptor.directory)) {
      throw new Error(`behavior-cell-capsule-location-mismatch:${entry.cell}`);
    }
    validateCapsuleFiles(capsuleRoot, descriptor.directory);
    await validateMutationModule(repositoryRoot, entry);
  }
  return Object.freeze(cells);
}

export const behaviorCells = await discoverBehaviorCells();
