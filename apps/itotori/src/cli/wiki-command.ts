// The kept `wiki` command's SOLE path into the new pipeline's Wiki object-API.
//
// It parses one kept subcommand (list / show / history / edit) into a
// `WikiObjectRequest` and routes it through the composition-root
// `runWikiObjectCommand`, which delegates to the new `WikiObjectApiService`. It
// never touches the legacy `WikiBrainService` + context-correction service the old
// `wiki` handler dragged in. The live object-API service is injected so this
// module's own import closure reaches only the wiki object-API.

import { runWikiObjectCommand, type WikiObjectRequest } from "../composition/index.js";
import type {
  WikiObjectApiService,
  WikiObjectSelector,
  WikiWriteAssertion,
} from "../wiki/object-api/index.js";
import { optionalFlag, requiredFlag } from "./flags.js";

/** The minimal JSON store the wiki command writes its result to. */
export interface WikiCommandIo {
  writeJson(path: string, value: unknown): void;
}

/** The injected wiki substrate — the live object-API service is the ONLY seam the
 * substrate enters through. Production binds the DB-backed object-API service; a
 * proof binds a double. */
export interface WikiCommandDeps {
  readonly io: WikiCommandIo;
  resolveWikiService(): WikiObjectApiService | Promise<WikiObjectApiService>;
  log?(message: string): void;
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

/** Route one kept `itotori wiki` invocation through the new object-API. */
export async function runWikiCommand(
  args: readonly string[],
  deps: WikiCommandDeps,
): Promise<void> {
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
