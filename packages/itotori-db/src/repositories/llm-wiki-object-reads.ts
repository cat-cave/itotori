import type { Pool } from "pg";

import type { LlmMemoCipher } from "./llm-call-memo-repository.js";
import type { LlmWikiHeadSelector, LlmWikiKind, LlmWikiScope } from "./llm-wiki-repository.js";

// Read-only projections over the strict wiki-version store: the current head of
// every object under a snapshot (the list surface) and the full immutable
// version chain of one object (the history surface). The body is encrypted at
// rest, so every record is decrypted through the same memo cipher the head
// projection uses — a raw row read cannot recover it. These reads never write a
// row and never widen an object's stored scope; they surface exactly what was
// persisted.

/** One decrypted wiki-version record: its identity, provenance/scope metadata,
 * and the canonical object JSON body. The body is the byte-identical value that
 * was persisted, so a caller re-parses it through the strict contract. */
export interface LlmWikiObjectRecord {
  wikiVersionId: string;
  wikiKind: LlmWikiKind;
  objectId: string;
  version: number;
  supersedesVersion: number | null;
  snapshotKind: "context" | "localization";
  snapshotId: string;
  objectKind: string;
  language: string;
  scope: LlmWikiScope;
  provisional: boolean;
  contextScope: string | null;
  runMode: string;
  editedBy: string | null;
  authorRole: string | null;
  localizationSnapshotId: string | null;
  sourceObjectId: string | null;
  createdAt: string;
  contentHash: string;
  /** The decrypted canonical object JSON persisted for this exact version. */
  objectJson: string;
}

/** List the current head object of every wiki object under a snapshot. Source
 * objects live under a context snapshot (no locale branch needed for source
 * truth); translation objects and per-target renderings live under a
 * localization snapshot. `wikiKind` narrows to one kind. */
export interface LlmWikiListQuery {
  snapshotId: string;
  wikiKind?: LlmWikiKind;
}

interface WikiRow {
  wiki_version_id: string;
  wiki_kind: LlmWikiKind;
  object_id: string;
  object_version: number;
  supersedes_version: number | null;
  snapshot_kind: "context" | "localization";
  snapshot_id: string;
  object_kind: string;
  object_language: string;
  scope_kind: string;
  scope_route_ids: string[];
  provisional: boolean;
  context_scope: string | null;
  run_mode: string;
  provenance_edited_by: string | null;
  provenance_author_role: string | null;
  localization_snapshot_id: string | null;
  source_object_id: string | null;
  created_at: string;
  wiki_content_hash: string;
  wiki_ciphertext: Uint8Array;
  wiki_key_ref: string;
}

const ROW_COLUMNS = `
  wiki.wiki_version_id, wiki.wiki_kind, wiki.object_id, wiki.object_version,
  wiki.supersedes_version, wiki.snapshot_kind, wiki.snapshot_id, wiki.object_kind,
  wiki.object_language, wiki.scope_kind, wiki.scope_route_ids, wiki.provisional,
  wiki.context_scope, wiki.run_mode, wiki.provenance_edited_by,
  wiki.provenance_author_role, wiki.localization_snapshot_id, wiki.source_object_id,
  wiki.created_at, wiki.wiki_content_hash, wiki.wiki_ciphertext, wiki.wiki_key_ref
`;

/** Resolve the current head object of every active wiki object under a snapshot.
 * Deterministically ordered by kind then object id. */
export async function listCurrentWikiObjects(
  pool: Pool,
  cipher: LlmMemoCipher,
  query: LlmWikiListQuery,
): Promise<LlmWikiObjectRecord[]> {
  const params: unknown[] = [query.snapshotId];
  let kindCondition = "";
  if (query.wikiKind !== undefined) {
    params.push(query.wikiKind);
    kindCondition = `and wiki.wiki_kind = $${params.length}`;
  }
  const result = await pool.query<WikiRow>(
    `
      select ${ROW_COLUMNS}
      from itotori_llm_cas_heads head
      join itotori_llm_wiki_versions wiki on wiki.wiki_version_id = head.head_id
      where head.head_namespace = 'wiki-version' and head.head_stage = 'current'
        and head.snapshot_id = $1 and wiki.deletion_state = 'active' ${kindCondition}
      order by wiki.wiki_kind, wiki.object_id
    `,
    params,
  );
  return decodeRows(cipher, result.rows);
}

/** Resolve the full immutable version chain of one object, oldest first. Every
 * persisted version is returned — superseded versions are history, never
 * mutated — so a caller sees the exact append-only lineage. */
export async function readWikiObjectHistory(
  pool: Pool,
  cipher: LlmMemoCipher,
  selector: LlmWikiHeadSelector,
): Promise<LlmWikiObjectRecord[]> {
  const result = await pool.query<WikiRow>(
    `
      select ${ROW_COLUMNS}
      from itotori_llm_wiki_versions wiki
      where wiki.wiki_kind = $1 and wiki.object_id = $2 and wiki.deletion_state = 'active'
      order by wiki.object_version asc
    `,
    [selector.wikiKind, selector.objectId],
  );
  return decodeRows(cipher, result.rows);
}

async function decodeRows(
  cipher: LlmMemoCipher,
  rows: readonly WikiRow[],
): Promise<LlmWikiObjectRecord[]> {
  const records: LlmWikiObjectRecord[] = [];
  for (const row of rows) {
    records.push({
      wikiVersionId: row.wiki_version_id,
      wikiKind: row.wiki_kind,
      objectId: row.object_id,
      version: row.object_version,
      supersedesVersion: row.supersedes_version,
      snapshotKind: row.snapshot_kind,
      snapshotId: row.snapshot_id,
      objectKind: row.object_kind,
      language: row.object_language,
      scope: scopeFromColumns(row.scope_kind, row.scope_route_ids),
      provisional: row.provisional,
      contextScope: row.context_scope,
      runMode: row.run_mode,
      editedBy: row.provenance_edited_by,
      authorRole: row.provenance_author_role,
      localizationSnapshotId: row.localization_snapshot_id,
      sourceObjectId: row.source_object_id,
      createdAt: toIsoString(row.created_at),
      contentHash: row.wiki_content_hash,
      objectJson: await cipher.open(row.wiki_ciphertext, row.wiki_key_ref),
    });
  }
  return records;
}

function scopeFromColumns(kind: string, routeIds: readonly string[]): LlmWikiScope {
  if (kind === "route") {
    const routeId = routeIds[0];
    if (routeId !== undefined) return { kind: "route", routeId };
  }
  if (kind === "route-set") return { kind: "route-set", routeIds: [...routeIds] };
  return { kind: "global" };
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
