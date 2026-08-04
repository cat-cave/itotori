// The real-bytes lane discovers package and target proofs beside the owned
// Cargo package/test. Adding a proof therefore changes no shared proof map.
import { globSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REAL_BYTES_PROOF_SCHEMA = "itotori.real-bytes-proof.v1";
export const REAL_BYTES_PACKAGE_MARKER = "@itotori-real-bytes-package";
export const REAL_BYTES_TARGET_MARKER = "@itotori-real-bytes-proof";

const declarationSuffix = ".real-bytes-proof.json";
const cratesRoot = "crates";
const packageMarker = new RegExp(`^\\s*#\\s*${REAL_BYTES_PACKAGE_MARKER}\\s*$`, "mu");
const targetMarker = new RegExp(`^\\s*//\\s*${REAL_BYTES_TARGET_MARKER}\\s*$`, "mu");
const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");
const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function portablePath(path) {
  return path.replaceAll("\\", "/");
}

function requiredFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`real-bytes proof ${label} is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`real-bytes proof ${label} is invalid: ${path}`);
  }
}

function requiredDirectory(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`real-bytes proof directory is missing: ${path}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`real-bytes proof directory is invalid: ${path}`);
  }
}

function readDeclaration(path, relativePath) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`real-bytes proof declaration is not valid JSON: ${relativePath}`);
  }
  const keys =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value).toSorted(lexical)
      : [];
  if (
    keys.length !== 3 ||
    keys[0] !== "engine" ||
    keys[1] !== "mode" ||
    keys[2] !== "schema" ||
    value.schema !== REAL_BYTES_PROOF_SCHEMA ||
    typeof value.engine !== "string" ||
    !identifier.test(value.engine) ||
    typeof value.mode !== "string"
  ) {
    throw new Error(`real-bytes proof declaration is invalid: ${relativePath}`);
  }
  return Object.freeze({ engine: value.engine, mode: value.mode });
}

function packageName(manifestPath) {
  const source = readFileSync(manifestPath, "utf8");
  const match = /^\s*name\s*=\s*"([a-z0-9]+(?:-[a-z0-9]+)*)"\s*$/mu.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`real-bytes proof package name is invalid: ${manifestPath}`);
  }
  return match[1];
}

function targetDetails(repositoryRoot, sourcePath, sourceRelative) {
  const cratesDirectory = resolve(repositoryRoot, cratesRoot);
  const pathFromCrates = portablePath(relative(cratesDirectory, sourcePath));
  const parts = pathFromCrates.split("/");
  if (
    parts.length !== 3 ||
    parts[1] !== "tests" ||
    !parts[2].endsWith(".rs") ||
    parts.some((part) => part === "" || part === "..")
  ) {
    throw new Error(
      `real-bytes proof declaration is not adjacent to an integration target: ${sourceRelative}`,
    );
  }
  const manifestPath = resolve(cratesDirectory, parts[0], "Cargo.toml");
  requiredFile(manifestPath, "package manifest");
  return Object.freeze({
    package: packageName(manifestPath),
    target: basename(sourcePath, ".rs"),
  });
}

function cargoArgs(proof) {
  const args = ["test", "-p", proof.package];
  if (proof.target !== undefined) args.push("--test", proof.target);
  if (proof.mode === "all-ignored" || proof.mode === "ignored") args.push("--", "--ignored");
  return Object.freeze(args);
}

function proofName({ package: packageName, target }) {
  return target === undefined ? packageName : `${packageName}-${target.replaceAll("_", "-")}`;
}

/**
 * Derive every real-byte command from a package/test marker and its adjacent
 * declaration. Markers make an accidentally removed declaration a hard error.
 */
export function discoverRealBytesProofs(root = defaultRoot) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("real-bytes proof repository root is invalid");
  }
  const repositoryRoot = resolve(root);
  const cratesDirectory = resolve(repositoryRoot, cratesRoot);
  requiredDirectory(cratesDirectory);

  const owners = new Map();
  for (const manifest of globSync("**/Cargo.toml", { cwd: cratesDirectory })
    .map(portablePath)
    .toSorted(lexical)) {
    const owner = `${cratesRoot}/${manifest}`;
    const ownerPath = resolve(repositoryRoot, owner);
    requiredFile(ownerPath, "package manifest");
    if (packageMarker.test(readFileSync(ownerPath, "utf8"))) owners.set(owner, "package");
  }
  for (const source of globSync("**/tests/*.rs", { cwd: cratesDirectory })
    .map(portablePath)
    .toSorted(lexical)) {
    const owner = `${cratesRoot}/${source}`;
    const ownerPath = resolve(repositoryRoot, owner);
    requiredFile(ownerPath, "test target");
    if (targetMarker.test(readFileSync(ownerPath, "utf8"))) owners.set(owner, "target");
  }

  const declarations = globSync(`${cratesRoot}/**/*${declarationSuffix}`, {
    cwd: repositoryRoot,
  })
    .map(portablePath)
    .toSorted(lexical);
  const proofs = [];
  const declaredOwners = new Set();
  for (const declaration of declarations) {
    const owner = declaration.slice(0, -declarationSuffix.length);
    const kind = owners.get(owner);
    if (kind === undefined) {
      throw new Error(`real-bytes proof declaration has no matching source marker: ${owner}`);
    }
    if (declaredOwners.has(owner)) {
      throw new Error(`real-bytes proof has duplicate declarations: ${owner}`);
    }
    const declarationPath = resolve(repositoryRoot, declaration);
    const ownerPath = resolve(repositoryRoot, owner);
    requiredFile(declarationPath, "declaration");
    requiredFile(ownerPath, kind === "package" ? "package manifest" : "test target");
    const declarationValue = readDeclaration(declarationPath, declaration);

    let packageValue;
    let target;
    if (kind === "package") {
      if (declarationValue.mode !== "all-ignored") {
        throw new Error(`real-bytes package declaration must use all-ignored mode: ${declaration}`);
      }
      packageValue = packageName(ownerPath);
    } else {
      if (declarationValue.mode !== "default" && declarationValue.mode !== "ignored") {
        throw new Error(`real-bytes target declaration has unknown mode: ${declaration}`);
      }
      ({ package: packageValue, target } = targetDetails(repositoryRoot, ownerPath, owner));
    }
    const proof = Object.freeze({
      engine: declarationValue.engine,
      mode: declarationValue.mode,
      package: packageValue,
      ...(target === undefined ? {} : { target }),
    });
    proofs.push(Object.freeze({ ...proof, name: proofName(proof), args: cargoArgs(proof) }));
    declaredOwners.add(owner);
  }

  for (const owner of owners.keys()) {
    if (!declaredOwners.has(owner)) {
      throw new Error(`real-bytes proof has no adjacent declaration: ${owner}`);
    }
  }
  if (proofs.length === 0) throw new Error("real-bytes proof declaration set is empty");
  return Object.freeze(
    proofs.toSorted((left, right) => {
      const engineDifference = lexical(left.engine, right.engine);
      return engineDifference === 0 ? lexical(left.name, right.name) : engineDifference;
    }),
  );
}
