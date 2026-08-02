import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

type FormatMismatchConstructor = ErrorConstructor;

interface FormatStability {
  readonly formatId: string;
  readonly schemaVersion: string;
  readonly stabilityTier: string;
  readonly knownLegacyVersions: readonly string[];
  readonly migrationPath: string;
}

interface FormatModule {
  readonly BRIDGE_SCHEMA_VERSION_V02: string;
  readonly BRIDGE_FORMAT_STABILITY: FormatStability;
  readonly FormatVersionMismatchError: FormatMismatchConstructor;
  readonly assertBridgeBundleV02: (value: unknown) => void;
  readonly assertContractFixtureV02: (kind: string, value: unknown) => void;
}

interface BoundaryRequest {
  readonly modulePath: string;
  readonly currentFixturePath: string;
  readonly legacyFixturePath: string;
}

interface TypedMismatch {
  readonly formatId: string;
  readonly observed: string;
  readonly supported: string;
  readonly stabilityTier: string;
  readonly knownLegacyVersions: readonly string[];
  readonly migrationPath: string;
}

interface VersionObservation {
  readonly schema: "itotori.public-format-observation.v1";
  readonly currentAccepted: boolean;
  readonly typedIncompatibility: boolean;
  readonly allBoundariesAgree: boolean;
  readonly versionAgreement: boolean;
  readonly observedVersion: string;
  readonly supportedVersion: string;
  readonly migrationPath: string;
  readonly observedFields: number;
}

interface BoundaryObservation extends VersionObservation {
  readonly fixturesUnchanged: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function path(value: unknown, label: string): string {
  const result = text(value, label);
  if (!isAbsolute(result)) throw new Error(`${label}-not-absolute`);
  return result;
}

function request(value: string | undefined): BoundaryRequest {
  if (value === undefined) throw new Error("public-format-request-missing");
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("public-format-request-invalid");
  return {
    modulePath: path(parsed.modulePath, "public-format-module-path"),
    currentFixturePath: path(parsed.currentFixturePath, "public-format-current-fixture-path"),
    legacyFixturePath: path(parsed.legacyFixturePath, "public-format-legacy-fixture-path"),
  };
}

function json(pathname: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    throw new Error(`${label}-invalid`);
  }
}

function digest(pathname: string): string {
  return createHash("sha256").update(readFileSync(pathname)).digest("hex");
}

function isFormatModule(value: unknown): value is FormatModule {
  if (!isRecord(value) || !isRecord(value.BRIDGE_FORMAT_STABILITY)) return false;
  const stability = value.BRIDGE_FORMAT_STABILITY;
  return (
    typeof value.BRIDGE_SCHEMA_VERSION_V02 === "string" &&
    typeof value.FormatVersionMismatchError === "function" &&
    typeof value.assertBridgeBundleV02 === "function" &&
    typeof value.assertContractFixtureV02 === "function" &&
    typeof stability.formatId === "string" &&
    typeof stability.schemaVersion === "string" &&
    typeof stability.stabilityTier === "string" &&
    Array.isArray(stability.knownLegacyVersions) &&
    stability.knownLegacyVersions.every((entry) => typeof entry === "string") &&
    typeof stability.migrationPath === "string"
  );
}

async function loadFormatModule(modulePath: string): Promise<FormatModule> {
  const candidate: unknown = await import(pathToFileURL(modulePath).href);
  if (!isFormatModule(candidate)) throw new Error("public-format-module-invalid");
  return candidate;
}

function capture(
  action: () => void,
): { readonly accepted: true } | { readonly accepted: false; error: unknown } {
  try {
    action();
    return { accepted: true };
  } catch (error) {
    return { accepted: false, error };
  }
}

function typedMismatch(error: unknown, format: FormatModule): TypedMismatch | undefined {
  if (!(error instanceof format.FormatVersionMismatchError) || !isRecord(error)) return undefined;
  const knownLegacyVersions = error.knownLegacyVersions;
  if (
    !Array.isArray(knownLegacyVersions) ||
    knownLegacyVersions.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }
  try {
    return {
      formatId: text(error.formatId, "public-format-error-format-id"),
      observed: text(error.observed, "public-format-error-observed"),
      supported: text(error.supported, "public-format-error-supported"),
      stabilityTier: text(error.stabilityTier, "public-format-error-tier"),
      knownLegacyVersions,
      migrationPath: text(error.migrationPath, "public-format-error-migration-path"),
    };
  } catch {
    return undefined;
  }
}

function schemaVersion(value: unknown): string {
  return isRecord(value) && typeof value.schemaVersion === "string" ? value.schemaVersion : "";
}

function observe(format: FormatModule, current: unknown, legacy: unknown): VersionObservation {
  const currentOutcomes = [
    capture(() => format.assertBridgeBundleV02(current)),
    capture(() => format.assertContractFixtureV02("bridge-v0.2", current)),
  ];
  const legacyOutcomes = [
    capture(() => format.assertBridgeBundleV02(legacy)),
    capture(() => format.assertContractFixtureV02("bridge-v0.2", legacy)),
  ];
  const mismatches = legacyOutcomes.flatMap((outcome) =>
    outcome.accepted ? [] : [typedMismatch(outcome.error, format)],
  );
  const typed = mismatches.filter((entry): entry is TypedMismatch => entry !== undefined);
  const stability = format.BRIDGE_FORMAT_STABILITY;
  const first = typed[0];
  const typedIncompatibility =
    typed.length === legacyOutcomes.length &&
    typed.every(
      (entry) =>
        entry.formatId === stability.formatId &&
        entry.observed === "0.1.0" &&
        entry.supported === stability.schemaVersion &&
        entry.stabilityTier === stability.stabilityTier &&
        entry.knownLegacyVersions.includes(entry.observed) &&
        entry.migrationPath === stability.migrationPath &&
        entry.migrationPath.length > 0,
    );
  const currentAccepted = currentOutcomes.every((outcome) => outcome.accepted);
  const allBoundariesAgree =
    currentAccepted &&
    typedIncompatibility &&
    first !== undefined &&
    typed.every(
      (entry) =>
        entry.observed === first.observed &&
        entry.supported === first.supported &&
        entry.migrationPath === first.migrationPath,
    );
  const versionAgreement =
    schemaVersion(current) === format.BRIDGE_SCHEMA_VERSION_V02 &&
    format.BRIDGE_SCHEMA_VERSION_V02 === stability.schemaVersion &&
    first !== undefined &&
    first.supported === format.BRIDGE_SCHEMA_VERSION_V02;
  return {
    schema: "itotori.public-format-observation.v1",
    currentAccepted,
    typedIncompatibility,
    allBoundariesAgree,
    versionAgreement,
    observedVersion: first?.observed ?? "",
    supportedVersion: first?.supported ?? "",
    migrationPath: first?.migrationPath ?? "",
    observedFields: [
      currentAccepted,
      typedIncompatibility,
      allBoundariesAgree,
      versionAgreement,
    ].filter(Boolean).length,
  };
}

async function main(): Promise<void> {
  const input = request(process.argv[2]);
  const currentBefore = digest(input.currentFixturePath);
  const legacyBefore = digest(input.legacyFixturePath);
  const format = await loadFormatModule(input.modulePath);
  const result = observe(
    format,
    json(input.currentFixturePath, "public-format-current-fixture"),
    json(input.legacyFixturePath, "public-format-legacy-fixture"),
  );
  process.stdout.write(
    `${JSON.stringify({
      ...result,
      fixturesUnchanged:
        currentBefore === digest(input.currentFixturePath) &&
        legacyBefore === digest(input.legacyFixturePath),
    })}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
