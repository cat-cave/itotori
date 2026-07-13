// CLI adapter for the same WikiBrainService that backs the Studio/API. The
// commands return typed context read models rather than re-querying the DB or
// inventing a separate serialization path.

import type {
  WikiContextEntriesReadModel,
  WikiContextEntryHistoryReadModel,
  WikiContextEntryKind,
  WikiContextEntryReadModel,
} from "@itotori/db";
import {
  assertWikiEditResponse,
  assertWikiHistoryResponse,
  assertWikiListResponse,
  assertWikiShowResponse,
} from "../api-schema.js";
import type {
  AddWikiBrainEntryInput,
  EditWikiBrainEntryInput,
  WikiBrainEditResult,
  WikiBrainServicePort,
} from "./service.js";

/** Actor-bound in production by database-services; easy to substitute in CLI tests. */
export type WikiCliPort = WikiBrainServicePort;

export type WikiListCliArgs = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId?: string;
  kind?: WikiContextEntryKind;
  includeStale?: boolean;
  limit?: number;
  offset?: number;
};

export type WikiShowCliArgs = {
  projectId: string;
  localeBranchId: string;
  contextArtifactId: string;
};

export type WikiHistoryCliArgs = WikiShowCliArgs;

export type WikiEditCliArgs = EditWikiBrainEntryInput;

export type WikiAddCliArgs = AddWikiBrainEntryInput;

export async function runWikiListCli(
  args: WikiListCliArgs,
  port: WikiCliPort,
): Promise<WikiContextEntriesReadModel> {
  const model = await port.list({
    projectId: args.projectId,
    localeBranchId: args.localeBranchId,
    ...(args.sourceRevisionId === undefined ? {} : { sourceRevisionId: args.sourceRevisionId }),
    ...(args.kind === undefined ? {} : { kind: args.kind }),
    ...(args.includeStale === undefined ? {} : { includeStale: args.includeStale }),
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    ...(args.offset === undefined ? {} : { offset: args.offset }),
  });
  assertWikiListResponse(model);
  return model;
}

export async function runWikiShowCli(
  args: WikiShowCliArgs,
  port: WikiCliPort,
): Promise<WikiContextEntryReadModel | null> {
  const model = await port.show(args);
  if (model !== null) {
    assertWikiShowResponse(model);
  }
  return model;
}

export async function runWikiHistoryCli(
  args: WikiHistoryCliArgs,
  port: WikiCliPort,
): Promise<WikiContextEntryHistoryReadModel | null> {
  const model = await port.history(args);
  if (model !== null) {
    assertWikiHistoryResponse(model);
  }
  return model;
}

export async function runWikiEditCli(
  args: WikiEditCliArgs,
  port: WikiCliPort,
): Promise<WikiBrainEditResult> {
  const result = await port.edit(args);
  assertWikiEditResponse(result);
  return result;
}

/** New context uses the identical correction receipt as an existing-entry edit. */
export async function runWikiAddCli(
  args: WikiAddCliArgs,
  port: WikiCliPort,
): Promise<WikiBrainEditResult> {
  const result = await port.add(args);
  assertWikiEditResponse(result);
  return result;
}
