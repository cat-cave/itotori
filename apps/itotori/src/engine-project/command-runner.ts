import type { JsonFileStore } from "../cli-handler-contracts.js";
import {
  runNativeCli,
  type NativeCliName,
  type NativeCliRunner,
} from "../native-bin/cli-bin-resolver.js";
import { nativeFailureDiagnostic } from "../native-bin/native-diagnostics.js";
import {
  describeEngineProjectAdapter,
  loadEngineProjectAdapterCatalog,
  parseEngineProjectConfig,
  type EngineProjectAdapterDescription,
  type EngineProjectConfig,
  type EngineProjectExtractionScope,
} from "./index.js";

export type EngineProjectOperation = "extract" | "structure-export";

export type EngineProjectCommandDependencies = {
  readonly io: JsonFileStore;
  readonly nativeCli?: NativeCliRunner;
  /** Test seam for proving catalog discovery without editing command code. */
  readonly adapterCatalogDirectory?: string;
};

export type EngineProjectCommandReceipt = {
  readonly command: EngineProjectOperation;
  readonly engine: string;
  readonly outputPath: string;
  readonly projectPath: string;
  readonly scope: EngineProjectExtractionScope;
  readonly status: number;
};

export type EngineProjectCommandResult =
  | { readonly kind: "describe"; readonly description: EngineProjectAdapterDescription }
  | { readonly kind: "executed"; readonly receipt: EngineProjectCommandReceipt };

export class EngineProjectCommandError extends Error {
  readonly code = "invalid-command";
  readonly command: EngineProjectOperation;

  constructor(command: EngineProjectOperation, message: string) {
    super(message);
    this.name = "EngineProjectCommandError";
    this.command = command;
  }
}

/** A downstream native failure after the project document has validated. */
export class EngineProjectNativeCommandError extends Error {
  readonly code = "native-command-failed";
  readonly command: EngineProjectOperation;
  readonly engine: string;
  readonly status: number | null;
  readonly stderr: string;

  constructor(input: {
    readonly command: EngineProjectOperation;
    readonly engine: string;
    readonly status: number | null;
    readonly stderr: string;
  }) {
    const detail = input.stderr.length > 0 ? input.stderr : "native command returned no diagnostic";
    super(
      `${input.command} project for engine '${input.engine}' reached its native adapter ` +
        `and failed with status ${String(input.status)}: ${detail}`,
    );
    this.name = "EngineProjectNativeCommandError";
    this.command = input.command;
    this.engine = input.engine;
    this.status = input.status;
    this.stderr = input.stderr;
  }
}

/**
 * Executes an engine-neutral primary command. The only engine lookup is the
 * declarative catalog; this module has no engine-specific branch or registry.
 */
export function runEngineProjectCommand(
  command: EngineProjectOperation,
  args: readonly string[],
  dependencies: EngineProjectCommandDependencies,
): EngineProjectCommandResult {
  const invocation = parseInvocation(command, args);
  const catalog = loadEngineProjectAdapterCatalog(
    dependencies.adapterCatalogDirectory === undefined
      ? {}
      : { directory: dependencies.adapterCatalogDirectory },
  );
  if (invocation.kind === "describe") {
    return {
      kind: "describe",
      description: describeEngineProjectAdapter(catalog, invocation.engine),
    };
  }

  const project = parseEngineProjectConfig(
    dependencies.io.readJson(invocation.projectPath),
    catalog,
  );
  const native = invokeNative(command, project, dependencies.nativeCli);
  const outputPath = command === "extract" ? project.extract.output : project.structure.output;
  return {
    kind: "executed",
    receipt: {
      command,
      engine: project.engine,
      outputPath,
      projectPath: invocation.projectPath,
      scope: project.extract.scope,
      status: native.status,
    },
  };
}

type ProjectInvocation =
  | { readonly kind: "describe"; readonly engine: string }
  | { readonly kind: "project"; readonly projectPath: string };

const GLOBAL_FLAGS_WITH_VALUES = new Set(["--deployment-config", "--env-file"]);

function parseInvocation(
  command: EngineProjectOperation,
  args: readonly string[],
): ProjectInvocation {
  const commandArgs = withoutGlobalFlags(command, args);
  const tail = commandArgs.slice(1);
  if (tail.length === 2 && tail[0] === "--project" && isFlagValue(tail[1])) {
    return { kind: "project", projectPath: tail[1] };
  }
  if (
    tail.length === 3 &&
    tail[0] === "--engine" &&
    isFlagValue(tail[1]) &&
    tail[2] === "--describe"
  ) {
    return { kind: "describe", engine: tail[1] };
  }
  throw new EngineProjectCommandError(
    command,
    `itotori ${command} accepts either --project <PROJECT.json> or ` +
      "--engine <ENGINE> --describe; engine-shaped flags belong in the project document",
  );
}

function withoutGlobalFlags(command: EngineProjectOperation, args: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!GLOBAL_FLAGS_WITH_VALUES.has(token)) {
      filtered.push(token);
      continue;
    }
    const value = args[index + 1];
    if (!isFlagValue(value)) {
      throw new EngineProjectCommandError(command, `global flag ${token} requires a value`);
    }
    index += 1;
  }
  return filtered;
}

function isFlagValue(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && !value.startsWith("--");
}

function invokeNative(
  command: EngineProjectOperation,
  project: EngineProjectConfig,
  nativeCli: NativeCliRunner | undefined,
): { readonly status: number } {
  const invocation = nativeInvocation(command, project);
  const process = runNativeCli(
    invocation.bin,
    invocation.args,
    nativeCli === undefined ? {} : nativeCli,
  );
  if (process.status !== 0) {
    // Chokepoint: every engine-project native failure inherits span-only
    // redaction and the whole-channel guard. Do not format stderr ad hoc.
    const diagnostic = nativeFailureDiagnostic(
      { error: undefined, stdout: process.stdout, stderr: process.stderr },
      nativeCli?.env,
    );
    throw new EngineProjectNativeCommandError({
      command,
      engine: project.engine,
      status: process.status,
      stderr: diagnostic,
    });
  }
  return { status: process.status };
}

function nativeInvocation(
  command: EngineProjectOperation,
  project: EngineProjectConfig,
): { readonly bin: NativeCliName; readonly args: string[] } {
  if (command === "extract") {
    return { bin: "kaifuu-cli", args: extractNativeArgs(project) };
  }
  return { bin: "utsushi-cli", args: structureNativeArgs(project) };
}

function extractNativeArgs(project: EngineProjectConfig): string[] {
  const args = [
    "extract",
    "--engine",
    project.engine,
    "--game-root",
    project.source.root,
    "--game-id",
    project.identity.id,
    "--game-version",
    project.identity.version,
    "--source-profile-id",
    project.identity.sourceProfileId,
    "--source-locale",
    project.identity.sourceLocale,
  ];
  appendScope(args, project.extract.scope);
  appendAdapterConfig(args, project);
  args.push("--bundle-output", project.extract.output);
  return args;
}

function structureNativeArgs(project: EngineProjectConfig): string[] {
  const args = [
    "structure",
    "--engine",
    project.engine,
    "--game-root",
    project.source.root,
    "--bridge",
    project.extract.output,
  ];
  appendAdapterConfig(args, project);
  args.push("--output", project.structure.output);
  return args;
}

function appendScope(args: string[], scope: EngineProjectExtractionScope): void {
  args.push("--scope", scope.kind);
  if (scope.kind === "unit-set") {
    args.push("--unit-ids", scope.unitIds.join(","));
  }
  if (scope.kind === "unit-range") {
    args.push("--start", String(scope.start), "--end-exclusive", String(scope.endExclusive));
  }
}

function appendAdapterConfig(args: string[], project: EngineProjectConfig): void {
  if (Object.keys(project.adapter).length > 0) {
    args.push("--adapter-config", JSON.stringify(project.adapter));
  }
}
