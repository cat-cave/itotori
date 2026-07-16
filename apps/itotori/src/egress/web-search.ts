// The web_search egress tool — the ONLY seam that may leave the ZDR boundary.
//
// It is a normal DispatchTool so the tool loop can offer it, but it is
// constructed only for A7 and only when the operator has enabled egress. Its
// execute() calls the fail-closed gate FIRST — before it constructs a query or
// touches the injected provider — so a disabled boundary emits zero bytes.
//
// Every returned hit is sealed with auditable web provenance: the retrieved
// URL, the retrieval date, a content hash over the actual retrieved bytes, a
// `provenance: "web"` tag, and `confidence: "low"`. Web content is never a
// same-game fact: it enters at low confidence with no corroboration, and only
// the facts-dominate reconciliation (./reconcile.ts) may raise a claim to
// medium after a same-game fact corroborates it — never higher, and never
// enough to override decode.

import { z } from "zod";

import { type LlmJsonValue } from "@itotori/db";

import {
  WEB_SEARCH_RESULT_SCHEMA_VERSION,
  WebSearchResultSchema,
  type RoleId,
  type WebSearchResult,
} from "../contracts/index.js";
import type { DispatchTool } from "../llm/dispatch.js";
import { sha256 } from "../llm/canonical-json.js";
import { paginate, requestHashOf, resultHashOf } from "../read-tools/index.js";

import { WEB_SEARCH_EGRESS_ROLE, assertWebEgressAllowed, type EgressPolicy } from "./policy.js";

type WebSearchHit = WebSearchResult["hits"][number];

/** A raw hit from a web provider, before itotori seals its provenance. The
 * provider supplies only observed content; itotori — not the provider — assigns
 * the content hash, retrieval date, provenance tag, and confidence. */
export interface RawWebHit {
  readonly url: string;
  readonly title: string;
  readonly excerpt: string;
  /** The exact retrieved content whose bytes seal the content hash. */
  readonly retrievedContent: string;
}

/**
 * The network seam. The tool NEVER imports a concrete HTTP client; a provider is
 * injected so the boundary is interceptable. In disabled mode `search` is never
 * invoked, so an injected fetch/provider spy proves zero egress.
 */
export interface WebSearchProvider {
  search(query: string, signal: AbortSignal | undefined): Promise<readonly RawWebHit[]>;
}

export const WebSearchArgsSchema = z
  .object({
    query: z.string().min(1).max(1_024),
    maxRows: z.number().int().min(1).max(1_000),
    maxBytes: z.number().int().min(1).max(8_388_608),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict();

export type WebSearchArgs = z.infer<typeof WebSearchArgsSchema>;

export interface WebSearchToolConfig {
  /** The invoking role. Only the contract's egress role passes the gate. */
  readonly roleId: RoleId;
  /** The operator's egress switches. Default-off closes the boundary. */
  readonly policy: EgressPolicy;
  /** The interceptable network seam. */
  readonly provider: WebSearchProvider;
  /** The immutable snapshot the result envelope is content-addressed against. */
  readonly snapshotId: string;
  /** Injected retrieval clock — no ambient time, so results stay reproducible. */
  readonly now: () => Date;
}

/** The ISO date (YYYY-MM-DD) that stamps each hit's retrieval provenance. */
function isoRetrievalDate(now: () => Date): string {
  return now().toISOString().slice(0, 10);
}

/**
 * Seal a raw provider hit with auditable web provenance. The content hash is
 * computed over the actual retrieved bytes; the evidence id is derived from that
 * same hash so a hit cannot claim provenance it cannot reproduce. Confidence is
 * pinned to `low`: web content is never a same-game fact and never enters above
 * medium (which only ./reconcile.ts may grant, and only after corroboration).
 */
export function sealWebHit(hit: RawWebHit, retrievedOn: string): WebSearchHit {
  const contentHash = sha256(hit.retrievedContent);
  const digest = contentHash.slice("sha256:".length);
  return {
    evidenceId: `web:sha256:${digest}`,
    url: hit.url,
    retrievedOn,
    contentHash,
    title: hit.title,
    excerpt: hit.excerpt,
    provenance: "web",
    confidence: "low",
    corroboratingSameGameFactIds: [],
  };
}

/**
 * Build the web_search DispatchTool for one role and policy. The returned tool's
 * execute() gate FAILS CLOSED before any provider call, so constructing the tool
 * in a disabled posture is safe — it simply refuses every invocation with zero
 * egress. Only an allowlisted role under an operator-enabled, non-qualifying
 * policy reaches the provider.
 */
export function createWebSearchTool(config: WebSearchToolConfig): DispatchTool {
  return {
    name: "web_search",
    description:
      "Search the public web for character background. A7-only, operator-enabled egress; " +
      "results are low-confidence web provenance and never override decode or same-game facts.",
    inputSchema: WebSearchArgsSchema,
    execute: async (raw, signal): Promise<WebSearchResult> => {
      const args = WebSearchArgsSchema.parse(raw);
      // FAIL CLOSED FIRST. Nothing below runs — no query, no provider call, no
      // network byte — unless the boundary is open for this exact role/policy.
      assertWebEgressAllowed(config.roleId, config.policy);

      const rawHits = await config.provider.search(args.query, signal);
      const retrievedOn = isoRetrievalDate(config.now);
      const hits = rawHits.map((hit) => sealWebHit(hit, retrievedOn));

      const requestHash = requestHashOf(config.snapshotId, "web_search", {
        query: args.query,
        maxRows: args.maxRows,
        maxBytes: args.maxBytes,
      });
      const { window, page } = paginate({
        items: hits as unknown as readonly LlmJsonValue[],
        cursor: args.cursor ?? null,
        maxRows: args.maxRows,
        maxBytes: args.maxBytes,
        requestHash,
      });
      const extra: Record<string, LlmJsonValue> = {
        egressAuthorizedForRole: WEB_SEARCH_EGRESS_ROLE,
        hits: window,
      };
      const resultHash = resultHashOf({
        snapshotId: config.snapshotId,
        tool: "web_search",
        schemaVersion: WEB_SEARCH_RESULT_SCHEMA_VERSION,
        requestHash,
        payload: extra,
      });
      return WebSearchResultSchema.parse({
        schemaVersion: WEB_SEARCH_RESULT_SCHEMA_VERSION,
        tool: "web_search",
        snapshotId: config.snapshotId,
        requestHash,
        resultHash,
        page,
        ...extra,
      });
    },
  };
}
