import type { PoolClient } from "pg";
import type { DatabaseContext } from "../connection.js";
import { llmSha256, type LlmJsonValue } from "../llm-content-address.js";
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

interface LlmWikiVersionCommon {
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
}

interface CommonPersist {
  objectId: string;
  objectVersion: number;
  supersedesVersion: number | null;
  objectJson: string;
  createdAt: string;
  expectedHead: LlmWikiHead | null;
}

function common(input: LlmWikiVersionCommon): CommonPersist {
  return {
    objectId: input.objectId,
    objectVersion: input.objectVersion,
    supersedesVersion: input.supersedesVersion,
    objectJson: input.objectJson,
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

function assertCommon(input: LlmWikiVersionCommon): void {
  assertIdentifier(input.objectId, "wiki object ID");
  assertLanguageTag(input.language, "wiki object language");
  assertObjectKind(input.objectKind);
  assertScope(input.scope);
  assertRunMode(input.runMode);
  if (input.editedBy !== null && !["human", "enhancement", "agent"].includes(input.editedBy)) {
    throw new Error("wiki provenance editedBy is invalid");
  }
  if (!Number.isSafeInteger(input.objectVersion) || input.objectVersion <= 0) {
    throw new Error("wiki object version must be a positive safe integer");
  }
  if (input.expectedHead === null && input.objectVersion !== 1) {
    throw new Error("the first wiki object version must be one");
  }
  if (
    input.expectedHead !== null &&
    (input.objectVersion !== input.expectedHead.version + 1 ||
      input.supersedesVersion !== input.expectedHead.version)
  ) {
    throw new Error("wiki object version does not advance its expected head");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("wiki object timestamp is invalid");
  }
}

const OBJECT_KINDS = new Set([
  "style-contract",
  "term-ruling",
  "scene-summary",
  "story-so-far",
  "route-arc",
  "voice-profile",
  "adaptation-note",
  "character-bio",
  "character-background",
  "character-route-arc",
  "speaker-hypothesis",
  "translation",
]);

const SUBJECT_KINDS = new Set([
  "game",
  "route",
  "scene",
  "unit",
  "character",
  "glossary-term",
  "choice",
  "organization",
  "user",
  "genre",
]);

function assertObjectKind(value: string): void {
  if (!OBJECT_KINDS.has(value)) throw new Error("wiki object kind is invalid");
}

function assertSubject(subject: LlmWikiSubject): void {
  if (!SUBJECT_KINDS.has(subject.kind)) throw new Error("wiki subject kind is invalid");
  assertIdentifier(subject.id, "wiki subject ID");
}

function assertScope(scope: LlmWikiScope): void {
  if (scope.kind === "global") return;
  if (scope.kind === "route") {
    assertIdentifier(scope.routeId, "wiki scope route ID");
    return;
  }
  if (scope.routeIds.length === 0) throw new Error("wiki route-set scope must not be empty");
  for (const routeId of scope.routeIds) assertIdentifier(routeId, "wiki scope route ID");
  if (new Set(scope.routeIds).size !== scope.routeIds.length) {
    throw new Error("wiki route-set scope routes must be unique");
  }
  const sorted = [...scope.routeIds].every(
    (routeId, index) => index === 0 || routeId > scope.routeIds[index - 1]!,
  );
  if (!sorted) throw new Error("wiki route-set scope routes must be sorted");
}

function assertContextScope(value: string): void {
  if (
    value !== "whole-game" &&
    value !== "external-augmented" &&
    !/^narrowed:[^\s].{0,127}$/u.test(value)
  ) {
    throw new Error("wiki context scope is invalid");
  }
}

function assertRunMode(value: string): void {
  if (!["production", "pilot", "test-dev"].includes(value)) {
    throw new Error("wiki run mode is invalid");
  }
}

function assertAuthorRole(value: string): void {
  if (!/^(A[1-9]|A10|P[1-3]|Q[1-6])$/u.test(value)) {
    throw new Error("wiki provenance author role is invalid");
  }
}

function assertLanguageTag(value: string, label: string): void {
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value)) {
    throw new Error(`${label} is not a language tag`);
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,255}$/u.test(value)) {
    throw new Error(`${label} is not a stable identifier`);
  }
}
