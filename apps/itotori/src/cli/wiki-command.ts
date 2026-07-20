// The kept `wiki` command's SOLE path into the new pipeline's Wiki object-API.
//
// `build` enters the composition-root source-Wiki assembly; the object API
// subcommands (list / show / history / edit) route through
// `runWikiObjectCommand`. This module never touches a role or the legacy wiki
// service directly.

import { runWikiObjectCommand, type WikiObjectRequest } from "../composition/wiki-entrypoint.js";
import type {
  WikiBuildInvocation,
  WikiBuildPortraitSources,
} from "../composition/wiki-build-entrypoint.js";
import type { SourceWikiRunReport } from "../source-wiki/index.js";
import { assertBridgeBundleV02, type BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type { RoleId, RunModeValue } from "../contracts/index.js";
import type {
  WikiObjectApiService,
  WikiObjectSelector,
  WikiWriteAssertion,
} from "../wiki/object-api/index.js";
import { optionalFlag, requiredFlag } from "./flags.js";

/** The minimal JSON store the wiki command writes its result to. */
export interface WikiCommandIo {
  readJson(path: string): unknown;
  writeJson(path: string, value: unknown): void;
}

/** The injected wiki substrate — the live object-API service is the ONLY seam the
 * substrate enters through. Production binds the DB-backed object-API service; a
 * proof binds a double. */
export interface WikiCommandDeps {
  readonly io: WikiCommandIo;
  resolveWikiService(): WikiObjectApiService | Promise<WikiObjectApiService>;
  runBuild?(input: WikiBuildInvocation): Promise<SourceWikiRunReport>;
  log?(message: string): void;
}

const RUN_MODE_VALUES: readonly RunModeValue[] = ["production", "pilot", "test-dev"];

function parseRunMode(value: string): RunModeValue {
  if ((RUN_MODE_VALUES as readonly string[]).includes(value)) return value as RunModeValue;
  throw new Error(`wiki build refused: --run-mode must be one of ${RUN_MODE_VALUES.join(", ")}`);
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`wiki build refused: ${flag} must be a positive integer`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Portrait producer facts live outside the bridge/snapshot in the render or
 * patch-report substrate. This parser carries only reference facts; the A7 media
 * contract validates the full shape again when it builds a bio. */
function parsePortraitSources(value: unknown): WikiBuildPortraitSources {
  if (!isRecord(value))
    throw new Error("wiki build: --portrait-sources must contain a JSON object");
  const entries: [
    string,
    WikiBuildPortraitSources extends ReadonlyMap<string, infer S> ? S : never,
  ][] = [];
  for (const [characterId, raw] of Object.entries(value)) {
    if (!isRecord(raw) || (raw.status !== "available" && raw.status !== "missing")) {
      throw new Error(
        `wiki build: portrait source for ${characterId} must declare available or missing status`,
      );
    }
    if (raw.status === "missing" && typeof raw.expectedContentHash !== "string") {
      throw new Error(
        `wiki build: missing portrait source for ${characterId} needs expectedContentHash`,
      );
    }
    if (raw.status === "available" && !isRecord(raw.facts)) {
      throw new Error(`wiki build: available portrait source for ${characterId} needs facts`);
    }
    entries.push([characterId, raw as (typeof entries)[number][1]]);
  }
  return new Map(entries);
}

function parseWikiBuildInvocation(args: readonly string[], io: WikiCommandIo): WikiBuildInvocation {
  const structureJson = io.readJson(requiredFlag(args, "--structure"));
  const bridgeJson = io.readJson(requiredFlag(args, "--bridge"));
  assertBridgeBundleV02(bridgeJson);
  const portraitPath = optionalFlag(args, "--portrait-sources");
  const rolesRaw = optionalFlag(args, "--roles");
  const roles =
    rolesRaw === undefined ? undefined : (rolesRaw.split(",").map((r) => r.trim()) as RoleId[]);
  return {
    structureJson,
    bridge: bridgeJson as BridgeBundleV02,
    sourceLanguage: requiredFlag(args, "--source-locale"),
    runMode: parseRunMode(requiredFlag(args, "--run-mode")),
    concurrency: parsePositiveInteger(optionalFlag(args, "--concurrency") ?? "4", "--concurrency"),
    ...(roles === undefined ? {} : { roles }),
    ...(portraitPath === undefined
      ? {}
      : { portraitSources: parsePortraitSources(io.readJson(portraitPath)) }),
  };
}

const WIKI_KINDS = ["source-object", "translation-object", "localized-rendering"] as const;
type WikiKind = (typeof WIKI_KINDS)[number];

function parseWikiKind(value: string): WikiKind {
  if ((WIKI_KINDS as readonly string[]).includes(value)) return value as WikiKind;
  throw new Error(`itotori wiki: --wiki-kind must be one of ${WIKI_KINDS.join(", ")}`);
}

function parseSelector(args: readonly string[]): WikiObjectSelector {
  return {
    wikiKind: parseWikiKind(requiredFlag(args, "--wiki-kind")),
    objectId: requiredFlag(args, "--object-id"),
  };
}

function parseWriteAssertion(args: readonly string[]): WikiWriteAssertion | undefined {
  const category = optionalFlag(args, "--assert-category");
  const contextSnapshotId = optionalFlag(args, "--assert-context-snapshot");
  if (category === undefined && contextSnapshotId === undefined) return undefined;
  return {
    ...(category === undefined ? {} : { category }),
    ...(contextSnapshotId === undefined ? {} : { contextSnapshotId }),
  };
}

/** Turn one kept `itotori wiki <subcommand>` invocation into a `WikiObjectRequest`.
 *
 *   wiki list    --snapshot <id>
 *   wiki show    --wiki-kind <kind> --object-id <id>
 *   wiki history --wiki-kind <kind> --object-id <id>
 *   wiki edit    --wiki-kind <kind> --object-id <id> --candidate-json <json>
 *                --created-at <iso> [--assert-category <c>] [--assert-context-snapshot <id>]
 */
export function parseWikiObjectRequest(args: readonly string[]): WikiObjectRequest {
  const subcommand = args[1];
  switch (subcommand) {
    case "list":
      return { action: "list", snapshotId: requiredFlag(args, "--snapshot") };
    case "show":
      return { action: "show", selector: parseSelector(args) };
    case "history":
      return { action: "history", selector: parseSelector(args) };
    case "edit": {
      const candidateRaw = requiredFlag(args, "--candidate-json");
      let candidate: unknown;
      try {
        candidate = JSON.parse(candidateRaw) as unknown;
      } catch {
        throw new Error("itotori wiki edit: --candidate-json must be valid JSON text");
      }
      const assertion = parseWriteAssertion(args);
      return {
        action: "edit",
        selector: parseSelector(args),
        candidate,
        createdAt: requiredFlag(args, "--created-at"),
        ...(assertion === undefined ? {} : { assertion }),
      };
    }
    default:
      throw new Error("itotori wiki requires one of: list, show, history, edit");
  }
}

/** Route an `itotori wiki` invocation through either the build composition or
 * the installed-object API. */
export async function runWikiCommand(
  args: readonly string[],
  deps: WikiCommandDeps,
): Promise<void> {
  if (args[1] === "build") {
    if (deps.runBuild === undefined) {
      throw new Error("wiki build is not configured in this CLI build (wikiBuild port missing)");
    }
    const report = await deps.runBuild(parseWikiBuildInvocation(args, deps.io));
    const summary = {
      runMode: requiredFlag(args, "--run-mode"),
      sourceLanguage: requiredFlag(args, "--source-locale"),
      phaseCount: report.phases.length,
      phases: report.phases.map((phase) => ({
        level: phase.level,
        roleCount: phase.roles.length,
        itemCount: phase.itemCount,
        producedStepCount: phase.producedStepCount,
        skippedStepCount: phase.skippedStepCount,
      })),
      producedKeyCount: report.producedKeys.length,
      skippedKeyCount: report.skippedKeys.length,
    };
    const outputPath = optionalFlag(args, "--output");
    if (outputPath !== undefined) {
      deps.io.writeJson(outputPath, summary);
      return;
    }
    (deps.log ?? ((message: string) => process.stdout.write(`${message}\n`)))(
      JSON.stringify(summary, null, 2),
    );
    return;
  }
  const request = parseWikiObjectRequest(args);
  const service = await deps.resolveWikiService();
  const response = await runWikiObjectCommand(service, request);

  const outputPath = optionalFlag(args, "--output");
  if (outputPath !== undefined) {
    deps.io.writeJson(outputPath, response);
    return;
  }
  (deps.log ?? ((message: string) => process.stdout.write(`${message}\n`)))(
    JSON.stringify(response, null, 2),
  );
}
