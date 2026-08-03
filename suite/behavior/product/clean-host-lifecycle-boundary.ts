/**
 * JSON-only adapter for the real installed-host lifecycle module.
 *
 * The optional modulePath is intentionally an absolute path so a behavior
 * mutation can execute an isolated compiled product clone rather than faking a
 * result in the driver.
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import * as builtInLifecycle from "../../../apps/itotori/src/install-lifecycle.js";

type Operation = "initialize" | "update" | "rollback" | "status";
type JsonRecord = Record<string, unknown>;

interface LifecycleModule {
  initializeHostLifecycle(input: JsonRecord): unknown;
  applySignedHostUpdate(input: JsonRecord): unknown;
  rollbackHostLifecycle(input: JsonRecord): unknown;
  readHostLifecycleState(stateRoot: string): unknown;
}

interface Request {
  readonly operation: Operation;
  readonly stateRoot: string;
  readonly modulePath: string | undefined;
  readonly releaseVersion: string | undefined;
  readonly releasePayloadPath: string | undefined;
  readonly updateDirectory: string | undefined;
  readonly publicKeyPath: string | undefined;
  readonly requiredFonts: readonly string[] | undefined;
  readonly requiredGlyphs: readonly string[] | undefined;
  readonly installedAt: string | undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}-invalid`);
  return value;
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredText(value, label);
}

function strings(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${label}-invalid`);
  }
  return value;
}

function request(value: string | undefined): Request {
  if (value === undefined) throw new Error("clean-host-lifecycle-request-missing");
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("clean-host-lifecycle-request-invalid");
  const operation = requiredText(parsed.operation, "clean-host-lifecycle-operation");
  if (!isOperation(operation)) {
    throw new Error("clean-host-lifecycle-operation-invalid");
  }
  const modulePath = optionalText(parsed.modulePath, "clean-host-lifecycle-module-path");
  if (modulePath !== undefined && !isAbsolute(modulePath)) {
    throw new Error("clean-host-lifecycle-module-path-not-absolute");
  }
  return {
    operation,
    stateRoot: requiredText(parsed.stateRoot, "clean-host-lifecycle-state-root"),
    modulePath,
    releaseVersion: optionalText(parsed.releaseVersion, "clean-host-lifecycle-release-version"),
    releasePayloadPath: optionalText(
      parsed.releasePayloadPath,
      "clean-host-lifecycle-release-payload",
    ),
    updateDirectory: optionalText(parsed.updateDirectory, "clean-host-lifecycle-update-directory"),
    publicKeyPath: optionalText(parsed.publicKeyPath, "clean-host-lifecycle-public-key"),
    requiredFonts: strings(parsed.requiredFonts, "clean-host-lifecycle-required-fonts"),
    requiredGlyphs: strings(parsed.requiredGlyphs, "clean-host-lifecycle-required-glyphs"),
    installedAt: optionalText(parsed.installedAt, "clean-host-lifecycle-installed-at"),
  };
}

function isOperation(value: string): value is Operation {
  return value === "initialize" || value === "update" || value === "rollback" || value === "status";
}

function isLifecycleModule(value: unknown): value is LifecycleModule {
  return (
    isRecord(value) &&
    typeof value.initializeHostLifecycle === "function" &&
    typeof value.applySignedHostUpdate === "function" &&
    typeof value.rollbackHostLifecycle === "function" &&
    typeof value.readHostLifecycleState === "function"
  );
}

function lifecycleModule(value: unknown): LifecycleModule {
  if (!isLifecycleModule(value)) throw new Error("clean-host-lifecycle-module-invalid");
  return value;
}

async function load(modulePath: string | undefined): Promise<LifecycleModule> {
  if (modulePath === undefined) return lifecycleModule(builtInLifecycle);
  return lifecycleModule(await import(pathToFileURL(modulePath).href));
}

function required(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`${label}-required`);
  return value;
}

async function run(input: Request): Promise<unknown> {
  const lifecycle = await load(input.modulePath);
  switch (input.operation) {
    case "initialize":
      return lifecycle.initializeHostLifecycle({
        stateRoot: input.stateRoot,
        releaseVersion: required(input.releaseVersion, "clean-host-lifecycle-release-version"),
        releasePayloadPath: required(
          input.releasePayloadPath,
          "clean-host-lifecycle-release-payload",
        ),
        requiredFonts: input.requiredFonts,
        requiredGlyphs: input.requiredGlyphs,
        installedAt: input.installedAt,
      });
    case "update":
      return lifecycle.applySignedHostUpdate({
        stateRoot: input.stateRoot,
        updateDirectory: required(input.updateDirectory, "clean-host-lifecycle-update-directory"),
        publicKeyPath: required(input.publicKeyPath, "clean-host-lifecycle-public-key"),
        installedAt: input.installedAt,
      });
    case "rollback":
      return lifecycle.rollbackHostLifecycle({
        stateRoot: input.stateRoot,
        version: required(input.releaseVersion, "clean-host-lifecycle-release-version"),
        installedAt: input.installedAt,
      });
    case "status":
      return { outcome: "status", state: lifecycle.readHostLifecycleState(input.stateRoot) };
  }
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await run(request(process.argv[2])))}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
