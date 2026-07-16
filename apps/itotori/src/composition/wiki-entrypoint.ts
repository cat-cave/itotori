// The thin wiki entrypoint — the kept `wiki` command/route's SOLE path into the
// new pipeline's Wiki object-API.
//
// It delegates the kept read/edit surface to the `WikiObjectApiService` (the new
// object-API), NOT the legacy `WikiBrainService` + context-correction service.
// The entrypoint owns no substrate — it routes a kept subcommand to the object
// API and returns its typed result. Its import closure reaches only the wiki
// object-API, whose closure is clean of the legacy service graph.

import type {
  WikiHistoryEntry,
  WikiListResult,
  WikiObjectApiService,
  WikiObjectSelector,
  WikiShowResult,
  WikiWriteAssertion,
  WikiWriteReceipt,
} from "../wiki/object-api/index.js";

/** The closed set of kept wiki subcommands the object-API serves. */
export type WikiObjectRequest =
  | { readonly action: "list"; readonly snapshotId: string }
  | { readonly action: "show"; readonly selector: WikiObjectSelector }
  | { readonly action: "history"; readonly selector: WikiObjectSelector }
  | {
      readonly action: "edit";
      readonly selector: WikiObjectSelector;
      readonly candidate: unknown;
      readonly createdAt: string;
      readonly assertion?: WikiWriteAssertion;
    };

/** The typed union of results a kept wiki subcommand returns. */
export type WikiObjectResponse =
  | { readonly action: "list"; readonly result: WikiListResult }
  | { readonly action: "show"; readonly result: WikiShowResult | null }
  | { readonly action: "history"; readonly result: readonly WikiHistoryEntry[] | null }
  | { readonly action: "edit"; readonly result: WikiWriteReceipt };

/**
 * Route one kept wiki subcommand to the new object-API. An `edit` opens a guarded
 * session (rejecting a forged category/provenance/scope assertion) and appends
 * the direct edit, returning a durable receipt.
 */
export async function runWikiObjectCommand(
  service: WikiObjectApiService,
  request: WikiObjectRequest,
): Promise<WikiObjectResponse> {
  switch (request.action) {
    case "list":
      return { action: "list", result: await service.list({ snapshotId: request.snapshotId }) };
    case "show":
      return { action: "show", result: await service.show(request.selector) };
    case "history":
      return { action: "history", result: await service.history(request.selector) };
    case "edit": {
      const session = await service.openEditSession(request.selector, request.assertion);
      const receipt = await service.edit(session, request.candidate, request.createdAt);
      return { action: "edit", result: receipt };
    }
  }
}
