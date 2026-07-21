// Delegation-only engine ports prove substrate conformance, not engine decode.
// Discover them from production Rust markers instead of a crate-name list, then
// keep them out of every real-game and engine-decode accounting surface.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import { crateOwnsRealBytes, parseLaneCrates } from "./audit-strictness.mjs";

const ENGINE_PORT_IMPL =
  /^\s*impl(?:\s*<[^>{}\n]+>)?\s+(?:[A-Za-z_][A-Za-z0-9_]*::)*EnginePort\s+for\b/mu;
const ZERO_OPCODE_HANDLERS =
  /^\s*(?:pub(?:\s*\([^\n)]+\))?\s+)?const\s+OPCODE_HANDLER_COUNT\s*:\s*usize\s*=\s*0\s*;/mu;
const NO_REFERENCE_COMPARISON = /^\s*capture_method\s*:\s*CaptureMethod::NoReferenceComparison\b/mu;
const PORT_ID = /^\s*pub\s+const\s+PORT_ID\s*:\s*&str\s*=\s*"([^"]+)"\s*;/mu;

function rustFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...rustFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      files.push(path);
    }
  }
  return files;
}

export function parseCargoPackageName(cargoToml) {
  const lines = cargoToml.split(/\r?\n/u);
  let inPackage = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[package]") {
      inPackage = true;
      continue;
    }
    if (inPackage && trimmed.startsWith("[")) return undefined;
    if (!inPackage || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^name\s*=\s*"([^"]+)"/u);
    if (match) return match[1];
  }
  return undefined;
}

export function delegationMarkerState(sourceText) {
  const implementsEnginePort = ENGINE_PORT_IMPL.test(sourceText);
  const zeroOpcodeHandlers = ZERO_OPCODE_HANDLERS.test(sourceText);
  const noReferenceComparison = NO_REFERENCE_COMPARISON.test(sourceText);
  return {
    implementsEnginePort,
    zeroOpcodeHandlers,
    noReferenceComparison,
    // Either marker independently disqualifies real-game/decode credit. Using
    // the union prevents removing just one marker from evading the exclusion.
    hasDelegationMarker: zeroOpcodeHandlers || noReferenceComparison,
    coverageIneligible: implementsEnginePort && (zeroOpcodeHandlers || noReferenceComparison),
  };
}

export function discoverCoverageIneligiblePorts(root) {
  const cratesRoot = join(root, "crates");
  const ports = [];
  for (const entry of readdirSync(cratesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const crateRoot = join(cratesRoot, entry.name);
    const sourceRoot = join(crateRoot, "src");
    const cargoTomlPath = join(crateRoot, "Cargo.toml");
    if (!existsSync(sourceRoot) || !existsSync(cargoTomlPath)) continue;
    const sourceText = rustFiles(sourceRoot)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const markers = delegationMarkerState(sourceText);
    if (!markers.hasDelegationMarker) continue;
    const packageName = parseCargoPackageName(readFileSync(cargoTomlPath, "utf8"));
    if (!packageName) throw new Error(`delegation marker crate has no package name: ${crateRoot}`);
    const ownsRealBytes = rustFiles(crateRoot).some((path) => {
      const repoPath = relative(root, path).split(sep).join("/");
      return crateOwnsRealBytes(repoPath, readFileSync(path, "utf8"));
    });
    ports.push({
      crate: packageName,
      root: relative(root, crateRoot).split(sep).join("/"),
      portId: sourceText.match(PORT_ID)?.[1] ?? null,
      ownsRealBytes,
      markers,
    });
  }
  return ports.sort((a, b) => a.crate.localeCompare(b.crate));
}

function sourcePath(value) {
  if (typeof value !== "string") return undefined;
  return posix.normalize(value.split("#", 1)[0].replaceAll("\\", "/"));
}

export function collectEngineDecodeCoveragePaths(manifest, instantiationMap, capabilityMatrix) {
  const paths = new Set();
  for (const source of manifest.sources ?? []) {
    if (sourcePath(source.path)) paths.add(sourcePath(source.path));
  }
  for (const family of Object.values(manifest.engineFamilies ?? {})) {
    for (const group of Object.values(family.componentGroups ?? {})) {
      if (sourcePath(group.source)) paths.add(sourcePath(group.source));
    }
  }
  for (const groups of Object.values(instantiationMap)) {
    for (const entry of Object.values(groups)) {
      if (sourcePath(entry.file)) paths.add(sourcePath(entry.file));
    }
  }
  for (const input of capabilityMatrix?.inputs ?? []) {
    if (sourcePath(input.path)) paths.add(sourcePath(input.path));
  }
  return paths;
}

export function collectCapabilityCoverageAdapterIds(capabilityMatrix) {
  const adapterIds = new Set();
  for (const row of capabilityMatrix?.rows ?? []) {
    const establishesEngineCapability = ["extract", "patch", "runtime"].some((level) =>
      ["supported", "partial"].includes(row.levels?.[level]?.status),
    );
    if (establishesEngineCapability && row.adapterId) adapterIds.add(row.adapterId);
  }
  return adapterIds;
}

export function evaluateDelegationCoverageExclusion(
  ports,
  engineDecodePaths,
  realGameLaneCrates,
  capabilityAdapterIds = new Set(),
) {
  const violations = [];
  for (const port of ports) {
    if (!port.markers.coverageIneligible) {
      violations.push({
        family: port.crate,
        group: "delegation-exclusion",
        rule: "delegation markers are present but the EnginePort implementation is not recognizable",
      });
    }
    const citedPaths = [...engineDecodePaths]
      .map(sourcePath)
      .filter(Boolean)
      .filter((path) => path === port.root || path.startsWith(`${port.root}/`))
      .sort();
    if (citedPaths.length > 0) {
      violations.push({
        family: port.crate,
        group: "delegation-exclusion",
        rule: `delegation-only engine port is cited as engine-decode coverage: ${citedPaths.join(", ")}`,
      });
    }
    if (realGameLaneCrates.has(port.crate)) {
      violations.push({
        family: port.crate,
        group: "delegation-exclusion",
        rule: "delegation-only engine port is selected as real-game coverage in ci-real-bytes",
      });
    }
    if (port.ownsRealBytes) {
      violations.push({
        family: port.crate,
        group: "delegation-exclusion",
        rule: "delegation-only engine port is classified as owning real-game coverage",
      });
    }
    const identifiers = new Set([port.crate, port.portId].filter(Boolean));
    const creditedIds = [...capabilityAdapterIds].filter((id) => identifiers.has(id)).sort();
    if (creditedIds.length > 0) {
      violations.push({
        family: port.crate,
        group: "delegation-exclusion",
        rule: `delegation-only engine port is credited by the engine capability matrix: ${creditedIds.join(", ")}`,
      });
    }
  }
  return violations;
}

export function evaluateWorkspaceDelegationExclusion({
  root,
  manifest,
  instantiationMap,
  capabilityMatrix,
  justfileText,
}) {
  const ports = discoverCoverageIneligiblePorts(root);
  const engineDecodePaths = collectEngineDecodeCoveragePaths(
    manifest,
    instantiationMap,
    capabilityMatrix,
  );
  const realGameLaneCrates = parseLaneCrates(justfileText);
  const capabilityAdapterIds = collectCapabilityCoverageAdapterIds(capabilityMatrix);
  return {
    ports,
    violations: evaluateDelegationCoverageExclusion(
      ports,
      engineDecodePaths,
      realGameLaneCrates,
      capabilityAdapterIds,
    ),
  };
}
