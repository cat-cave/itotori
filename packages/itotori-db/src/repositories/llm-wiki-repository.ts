import type { PoolClient } from "pg";
import type { DatabaseContext } from "../connection.js";
import { llmSha256, type LlmJsonValue } from "../llm-content-address.js";
import {
  insertDependencyEdges,
  queryDependents,
  type LlmDependencyQuery,
  type LlmDependentEdge,
  type LlmWikiDependency,
} from "./llm-wiki-dependency-edges.js";
import {
  listCurrentWikiObjects,
  readWikiObjectHistory,
  type LlmWikiListQuery,
  type LlmWikiObjectRecord,
} from "./llm-wiki-object-reads.js";
import {
  assertAuthorRole,
  assertCommon,
  assertContextScope,
  assertIdentifier,
  assertSubject,
} from "./llm-wiki-version-validation.js";
import type { LlmMemoCipher } from "./llm-call-memo-repository.js";

// Every context artifact and translation is one strict versioned object. Source
// objects are source-language and target-agnostic; a translation object and a
// per-target localized rendering carry the target on a localization snapshot.
export type LlmWikiKind = "source-object" | "translation-object" | "localized-rendering";

export type LlmWikiScope =
  | { kind: "global" }
  | { kind: "route"; routeId: string }
  | { kind: "route-set"; routeIds: readonly string[] };

export interface LlmWikiSubject {
  kind: string;
  id: string;
}

export type {
  LlmDependencyQuery,
  LlmDependentEdge,
  LlmWikiDependency,
} from "./llm-wiki-dependency-edges.js";

export type { LlmWikiListQuery, LlmWikiObjectRecord } from "./llm-wiki-object-reads.js";

export interface LlmWikiHead {
  wikiVersionId: string;
  objectId: string;
  version: number;
  contentHash: string;
}

export interface LlmWikiHeadSelector {
  wikiKind: LlmWikiKind;
  objectId: string;
}

export interface LlmWikiVersionCommon {
  objectId: string;
  objectVersion: number;
  supersedesVersion: number | null;
  snapshotId: string;
  objectKind: string;
  language: string;
  scope: LlmWikiScope;
  provisional: boolean;
  runMode: string;
  editedBy: string | null;
  /** The full canonical object JSON. Its hash addresses the version. */
  objectJson: string;
  /** The fine-grained upstream dependencies this version consumed. */
  dependencies: readonly LlmWikiDependency[];
  createdAt: string;
  expectedHead: LlmWikiHead | null;
}

export interface PutLlmWikiObjectInput extends LlmWikiVersionCommon {
  wikiKind: "source-object" | "translation-object";
  subject: LlmWikiSubject;
  contextScope: string;
  authorRole: string | null;
  /** Required for a translation object; forbidden for a source object. */
  localizationSnapshotId: string | null;
}

export interface PutLlmLocalizedRenderingInput extends LlmWikiVersionCommon {
  /** The source object this rendering localizes. */
  sourceObjectId: string;
  localizationSnapshotId: string;
}

export class LlmWikiCasError extends Error {
  constructor() {
    super("wiki object head compare-and-swap failed");
    this.name = "LlmWikiCasError";
  }
}

export class LlmWikiConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmWikiConflictError";
  }
}

/** A provisional automated pass may not silently advance a human-owned head.
 * The explicit human apply boundary is the only enhancement path that may build
 * on such a version; ordinary agent work must surface a conflict for review. */
export class LlmWikiProtectedHumanVersionError extends Error {
  constructor(readonly wikiVersionId: string) {
    super(`automated write cannot supersede protected human wiki version ${wikiVersionId}`);
    this.name = "LlmWikiProtectedHumanVersionError";
  }
}

interface WikiVersionRow {
  wikiKind: LlmWikiKind;
  snapshotKind: "context" | "localization";
  snapshotId: string;
  objectKind: string;
  language: string;
  subjectKind: string | null;
  subjectId: string | null;
  scope: LlmWikiScope;
  provisional: boolean;
  contextScope: string | null;
  runMode: string;
  editedBy: string | null;
  authorRole: string | null;
  localizationSnapshotId: string | null;
  sourceObjectId: string | null;
}

export class ItotoriLlmWikiRepository {
  constructor(
    private readonly pool: DatabaseContext["pool"],
    private readonly cipher: LlmMemoCipher,
  ) {}

  async putWikiObject(input: PutLlmWikiObjectInput): Promise<LlmWikiHead> {
    assertCommon(input);
    assertSubject(input.subject);
    assertContextScope(input.contextScope);
    if (input.authorRole !== null) assertAuthorRole(input.authorRole);
    const snapshotKind = input.wikiKind === "source-object" ? "context" : "localization";
    if (snapshotKind === "context" && input.localizationSnapshotId !== null) {
      throw new LlmWikiConflictError("a source object must be target-agnostic");
    }
    if (snapshotKind === "localization" && input.localizationSnapshotId === null) {
      throw new LlmWikiConflictError("a translation object requires a localization snapshot");
    }
    return this.persistVersion({
      wikiKind: input.wikiKind,
      snapshotKind,
      snapshotId: input.snapshotId,
      objectKind: input.objectKind,
      language: input.language,
      subjectKind: input.subject.kind,
      subjectId: input.subject.id,
      scope: input.scope,
      provisional: input.provisional,
      contextScope: input.contextScope,
      runMode: input.runMode,
      editedBy: input.editedBy,
      authorRole: input.authorRole,
      localizationSnapshotId: input.localizationSnapshotId,
      sourceObjectId: null,
      ...common(input),
    });
  }

  async putLocalizedRendering(input: PutLlmLocalizedRenderingInput): Promise<LlmWikiHead> {
    assertCommon(input);
    assertIdentifier(input.sourceObjectId, "localized rendering source object ID");
    return this.persistVersion({
      wikiKind: "localized-rendering",
      snapshotKind: "localization",
      snapshotId: input.snapshotId,
      objectKind: input.objectKind,
      language: input.language,
      subjectKind: null,
      subjectId: null,
      scope: input.scope,
      provisional: input.provisional,
      contextScope: null,
      runMode: input.runMode,
      editedBy: input.editedBy,
      authorRole: null,
      localizationSnapshotId: input.localizationSnapshotId,
      sourceObjectId: input.sourceObjectId,
      ...common(input),
    });
  }

  async readHead(selector: LlmWikiHeadSelector): Promise<LlmWikiHead | null> {
    const result = await this.pool.query<{
      wiki_version_id: string;
      object_id: string;
      object_version: number;
      wiki_content_hash: string;
    }>(
      `
        select wiki.wiki_version_id, wiki.object_id, wiki.object_version, wiki.wiki_content_hash
        from itotori_llm_cas_heads head
        join itotori_llm_wiki_versions wiki on wiki.wiki_version_id = head.head_id
        where head.head_namespace = 'wiki-version'
          and head.subject_type = $1 and head.subject_id = $2 and head.head_stage = 'current'
          and wiki.deletion_state = 'active'
      `,
      [selector.wikiKind, selector.objectId],
    );
    const row = result.rows[0];
    return row
      ? {
          wikiVersionId: row.wiki_version_id,
          objectId: row.object_id,
          version: row.object_version,
          contentHash: row.wiki_content_hash,
        }
      : null;
  }

  /** Read the object JSON of the current projecting head, or null when none. */
  async readProjectableObject(selector: LlmWikiHeadSelector): Promise<string | null> {
    const result = await this.pool.query<{
      wiki_ciphertext: Uint8Array;
      wiki_key_ref: string;
    }>(
      `
        select wiki.wiki_ciphertext, wiki.wiki_key_ref
        from itotori_llm_cas_heads head
        join itotori_llm_wiki_versions wiki on wiki.wiki_version_id = head.head_id
        where head.head_namespace = 'wiki-version'
          and head.subject_type = $1 and head.subject_id = $2 and head.head_stage = 'current'
          and wiki.deletion_state = 'active'
      `,
      [selector.wikiKind, selector.objectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.cipher.open(row.wiki_ciphertext, row.wiki_key_ref);
  }

  private async persistVersion(row: WikiVersionRow & CommonPersist): Promise<LlmWikiHead> {
    const contentHash = llmSha256(row.objectJson);
    const wikiVersionId = versionId(row.wikiKind, row.objectId, row.objectVersion);
    const client = await this.pool.connect();
    let sealed: Awaited<ReturnType<LlmMemoCipher["seal"]>> | null = null;
    try {
      await client.query("begin");
      sealed = await this.cipher.seal(row.objectJson);
      const inserted = await client.query(
        `
          insert into itotori_llm_wiki_versions (
            wiki_version_id, wiki_kind, object_id, object_version, supersedes_version,
            snapshot_kind, snapshot_id, object_kind, wiki_ciphertext, wiki_key_ref,
            wiki_content_hash, created_at, retention_deadline,
            object_language, subject_kind, subject_id, scope_kind, scope_route_ids,
            provisional, context_scope, run_mode, provenance_edited_by, provenance_author_role,
            localization_snapshot_id, source_object_id
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz,
            $12::timestamptz + interval '365 days', $13, $14, $15, $16, $17,
            $18, $19, $20, $21, $22, $23, $24
          )
          on conflict (wiki_version_id) do nothing
        `,
        [
          wikiVersionId,
          row.wikiKind,
          row.objectId,
          row.objectVersion,
          row.supersedesVersion,
          row.snapshotKind,
          row.snapshotId,
          row.objectKind,
          sealed.ciphertext,
          sealed.keyRef,
          contentHash,
          row.createdAt,
          row.language,
          row.subjectKind,
          row.subjectId,
          row.scope.kind,
          scopeRouteIds(row.scope),
          row.provisional,
          row.contextScope,
          row.runMode,
          row.editedBy,
          row.authorRole,
          row.localizationSnapshotId,
          row.sourceObjectId,
        ],
      );
      if (inserted.rowCount === 0) {
        await this.assertIdempotent(client, wikiVersionId, contentHash);
        await client.query("commit");
        if (sealed) await this.cipher.destroyKey(sealed.keyRef);
        return {
          wikiVersionId,
          objectId: row.objectId,
          version: row.objectVersion,
          contentHash,
        };
      }
      await this.assertExpectedHeadIsNotHumanProtected(client, row);
      await insertDependencyEdges(client, wikiVersionId, row.dependencies, row.createdAt);
      await this.advanceHead(client, row, wikiVersionId, contentHash);
      await client.query("commit");
      return { wikiVersionId, objectId: row.objectId, version: row.objectVersion, contentHash };
    } catch (error: unknown) {
      await client.query("rollback");
      if (sealed) await this.cipher.destroyKey(sealed.keyRef);
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertIdempotent(
    client: PoolClient,
    wikiVersionId: string,
    contentHash: string,
  ): Promise<void> {
    const existing = await client.query<{ wiki_content_hash: string }>(
      "select wiki_content_hash from itotori_llm_wiki_versions where wiki_version_id = $1",
      [wikiVersionId],
    );
    if (existing.rows[0]?.wiki_content_hash !== contentHash) {
      throw new LlmWikiConflictError("wiki object version content differs from its committed row");
    }
  }

  /** Human edits and their explicit enhancement children are non-provisional
   * reviewable truth. Do not let a normal automated pass silently replace that
   * head; it must enter through the explicit enhancement boundary instead. */
  private async assertExpectedHeadIsNotHumanProtected(
    client: PoolClient,
    row: WikiVersionRow & CommonPersist,
  ): Promise<void> {
    if (row.editedBy !== "agent" || row.expectedHead === null) return;
    const protectedHead = await client.query<{ provenance_edited_by: string | null }>(
      `
        select provenance_edited_by
        from itotori_llm_wiki_versions
        where wiki_version_id = $1 and deletion_state = 'active'
      `,
      [row.expectedHead.wikiVersionId],
    );
    const editedBy = protectedHead.rows[0]?.provenance_edited_by;
    if (editedBy === "human" || editedBy === "enhancement") {
      throw new LlmWikiProtectedHumanVersionError(row.expectedHead.wikiVersionId);
    }
  }

  private async advanceHead(
    client: PoolClient,
    row: WikiVersionRow & CommonPersist,
    wikiVersionId: string,
    contentHash: string,
  ): Promise<void> {
    const advanced = row.expectedHead
      ? await client.query(
          `
            update itotori_llm_cas_heads
            set head_id = $1, head_version = $2, head_content_hash = $3, updated_at = $4::timestamptz
            where head_namespace = 'wiki-version' and snapshot_id = $5 and subject_type = $6
              and subject_id = $7 and head_stage = 'current'
              and head_id = $8 and head_version = $9 and head_content_hash = $10
          `,
          [
            wikiVersionId,
            row.objectVersion,
            contentHash,
            row.createdAt,
            row.snapshotId,
            row.wikiKind,
            row.objectId,
            row.expectedHead.wikiVersionId,
            row.expectedHead.version,
            row.expectedHead.contentHash,
          ],
        )
      : await client.query(
          `
            insert into itotori_llm_cas_heads (
              head_namespace, snapshot_id, subject_type, subject_id, head_stage,
              head_id, head_version, head_content_hash, updated_at
            ) values ('wiki-version', $1, $2, $3, 'current', $4, $5, $6, $7::timestamptz)
            on conflict (head_namespace, snapshot_id, subject_type, subject_id, head_stage)
            do nothing
          `,
          [
            row.snapshotId,
            row.wikiKind,
            row.objectId,
            wikiVersionId,
            row.objectVersion,
            contentHash,
            row.createdAt,
          ],
        );
    if (advanced.rowCount !== 1) throw new LlmWikiCasError();
  }

  /** Resolve the EXACT downstream consumers of an upstream claim/field/rendering.
   * A `claimId`/`fieldPath`/`renderingId` narrows to consumers of that content
   * only; a bare `upstreamObjectId` returns every consumer (the coarse query the
   * fine-grained edges replace). See {@link queryDependents}. */
  async queryDependents(query: LlmDependencyQuery): Promise<LlmDependentEdge[]> {
    return queryDependents(this.pool, query);
  }

  /** List the current head object of every active object under a snapshot. The
   * body of each is decrypted through the same cipher the head projection uses. */
  async listObjects(query: LlmWikiListQuery): Promise<LlmWikiObjectRecord[]> {
    return listCurrentWikiObjects(this.pool, this.cipher, query);
  }

  /** Read the full immutable version chain of one object, oldest version first. */
  async readObjectHistory(selector: LlmWikiHeadSelector): Promise<LlmWikiObjectRecord[]> {
    return readWikiObjectHistory(this.pool, this.cipher, selector);
  }
}

interface CommonPersist {
  objectId: string;
  objectVersion: number;
  supersedesVersion: number | null;
  objectJson: string;
  dependencies: readonly LlmWikiDependency[];
  createdAt: string;
  expectedHead: LlmWikiHead | null;
}

function common(input: LlmWikiVersionCommon): CommonPersist {
  return {
    objectId: input.objectId,
    objectVersion: input.objectVersion,
    supersedesVersion: input.supersedesVersion,
    objectJson: input.objectJson,
    dependencies: input.dependencies,
    createdAt: input.createdAt,
    expectedHead: input.expectedHead,
  };
}

function versionId(wikiKind: LlmWikiKind, objectId: string, version: number): `sha256:${string}` {
  return llmSha256({ objectId, objectVersion: version, wikiKind } as unknown as LlmJsonValue);
}

function scopeRouteIds(scope: LlmWikiScope): readonly string[] {
  if (scope.kind === "route") return [scope.routeId];
  if (scope.kind === "route-set") return scope.routeIds;
  return [];
}
