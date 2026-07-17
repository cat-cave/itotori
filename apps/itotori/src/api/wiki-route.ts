// The kept API wiki mutation's SOLE path into the new pipeline's Wiki object-API.
//
// It routes a kept wiki write through the composition-root `runWikiObjectCommand`,
// which delegates to the new `WikiObjectApiService`. It never touches the legacy
// `WikiBrainService` + context-correction service the old wiki handlers dragged in.
// The live object-API service is injected so this module's own import closure
// reaches only the wiki object-API.

import {
  runWikiObjectCommand,
  type WikiObjectRequest,
  type WikiObjectResponse,
} from "../composition/index.js";
import type { WikiObjectApiService } from "../wiki/object-api/index.js";

export type { WikiObjectRequest, WikiObjectResponse };

/** The injected wiki substrate — the live object-API service is the ONLY seam the
 * substrate enters through. Production binds the DB-backed object-API service; a
 * proof binds a double. */
export interface WikiRouteDeps {
  resolveWikiService(): WikiObjectApiService | Promise<WikiObjectApiService>;
}

/** Route one kept API wiki mutation through the new object-API. */
export async function runApiWiki(
  request: WikiObjectRequest,
  deps: WikiRouteDeps,
): Promise<WikiObjectResponse> {
  const service = await deps.resolveWikiService();
  return await runWikiObjectCommand(service, request);
}
