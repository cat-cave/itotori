import type { Pool, PoolClient } from "pg";

import { llmSha256, type LlmJsonValue } from "../llm-content-address.js";
import type { LlmWikiKind, LlmWikiScope } from "./llm-wiki-repository.js";

// Fine-grained dependency edges: the exact upstream claim/field/rendering a
// downstream Wiki version consumed. Every downstream version records these so a
// dependency query resolves the EXACT consumers of a given claim/field, never
// merely "some object depends on that object" — which is what makes field-scoped
// invalidation possible. An edge that identifies no consumed content is a
// fabricated edge and is rejected before any row is written.

/** A FINE-GRAINED dependency: the consumed upstream claim/field/rendering, plus
 * the route/play range it was consumed under. At least one of claimId /
 * fieldPath / renderingId must locate consumed content. */
export interface LlmWikiDependency {
  upstreamObjectId: string;
  upstreamVersion: number;
  claimId: string | null;
  fieldPath: readonly string[];
  renderingId: string | null;
  scope: LlmWikiScope;
  fromPlayOrder: number | null;
  throughPlayOrder: number | null;
}

/** Locate the exact consumers of an upstream claim/field/rendering. Omitting
 * `claimId`/`fieldPath`/`renderingId` widens the query; a bare `upstreamObjectId`
 * is the COARSE object-wide query the fine-grained edges exist to replace. */
export interface LlmDependencyQuery {
  upstreamObjectId: string;
  claimId?: string;
  fieldPath?: readonly string[];
  renderingId?: string;
}

/** One resolved downstream consumer of a queried upstream claim/field. */
export interface LlmDependentEdge {
  edgeId: string;
  downstreamWikiVersionId: string;
  downstreamWikiKind: LlmWikiKind;
  downstreamObjectId: string;
  downstreamVersion: number;
  upstreamObjectId: string;
  upstreamVersion: number;
  claimId: string | null;
  fieldPath: readonly string[];
  renderingId: string | null;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,255}$/u;

/** Write a downstream version's fine-grained dependency edges inside its commit.
 * Each edge is addressed by (downstream version, dependency locator) so the exact
 * consumers of a claim/field are queryable; a re-put of identical content is
 * idempotent. */
export async function insertDependencyEdges(
  client: PoolClient,
  downstreamWikiVersionId: string,
  dependencies: readonly LlmWikiDependency[],
  createdAt: string,
): Promise<void> {
  for (const dependency of dependencies) {
    assertDependency(dependency);
    const dependencyHash = dependencyHashOf(dependency);
    const edgeId = llmSha256({ downstreamWikiVersionId, dependencyHash });
    await client.query(
      `
        insert into itotori_llm_dependency_edges (
          edge_id, downstream_wiki_version_id, dependency_hash, upstream_object_id,
          upstream_version, claim_id, field_path, rendering_id, scope_ref,
          from_play_order, through_play_order, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::timestamptz)
        on conflict (downstream_wiki_version_id, dependency_hash) do nothing
      `,
      [
        edgeId,
        downstreamWikiVersionId,
        dependencyHash,
        dependency.upstreamObjectId,
        dependency.upstreamVersion,
        dependency.claimId,
        [...dependency.fieldPath],
        dependency.renderingId,
        JSON.stringify(scopeToJson(dependency.scope)),
        dependency.fromPlayOrder,
        dependency.throughPlayOrder,
        createdAt,
      ],
    );
  }
}

/** Resolve the EXACT downstream consumers of an upstream claim/field/rendering.
 * A `claimId`/`fieldPath`/`renderingId` narrows to consumers of that content
 * only; a bare `upstreamObjectId` returns every consumer of the object (the
 * coarse query the fine-grained edges replace). Results are deterministically
 * ordered by downstream object/version/edge. */
export async function queryDependents(
  pool: Pool,
  query: LlmDependencyQuery,
): Promise<LlmDependentEdge[]> {
  const conditions = ["edge.upstream_object_id = $1"];
  const params: unknown[] = [query.upstreamObjectId];
  if (query.claimId !== undefined) {
    params.push(query.claimId);
    conditions.push(`edge.claim_id = $${params.length}`);
  }
  if (query.fieldPath !== undefined) {
    params.push([...query.fieldPath]);
    conditions.push(`edge.field_path = $${params.length}::text[]`);
  }
  if (query.renderingId !== undefined) {
    params.push(query.renderingId);
    conditions.push(`edge.rendering_id = $${params.length}`);
  }
  const result = await pool.query<{
    edge_id: string;
    downstream_wiki_version_id: string;
    wiki_kind: LlmWikiKind;
    downstream_object_id: string;
    downstream_version: number;
    upstream_object_id: string;
    upstream_version: number;
    claim_id: string | null;
    field_path: string[];
    rendering_id: string | null;
  }>(
    `
      select edge.edge_id, edge.downstream_wiki_version_id, wiki.wiki_kind,
        wiki.object_id as downstream_object_id, wiki.object_version as downstream_version,
        edge.upstream_object_id, edge.upstream_version, edge.claim_id,
        edge.field_path, edge.rendering_id
      from itotori_llm_dependency_edges edge
      join itotori_llm_wiki_versions wiki
        on wiki.wiki_version_id = edge.downstream_wiki_version_id
      where ${conditions.join(" and ")}
      order by wiki.object_id, wiki.object_version, edge.edge_id
    `,
    params,
  );
  return result.rows.map((row) => ({
    edgeId: row.edge_id,
    downstreamWikiVersionId: row.downstream_wiki_version_id,
    downstreamWikiKind: row.wiki_kind,
    downstreamObjectId: row.downstream_object_id,
    downstreamVersion: row.downstream_version,
    upstreamObjectId: row.upstream_object_id,
    upstreamVersion: row.upstream_version,
    claimId: row.claim_id,
    fieldPath: row.field_path,
    renderingId: row.rendering_id,
  }));
}

/** Content-address a dependency by its locator (upstream + claim/field/rendering
 * + scope + play range). Two identical locators on one downstream version share
 * an edge; a distinct locator is a distinct edge. */
function dependencyHashOf(dependency: LlmWikiDependency): `sha256:${string}` {
  return llmSha256({
    upstreamObjectId: dependency.upstreamObjectId,
    upstreamVersion: dependency.upstreamVersion,
    claimId: dependency.claimId,
    fieldPath: [...dependency.fieldPath],
    renderingId: dependency.renderingId,
    scope: scopeToJson(dependency.scope),
    fromPlayOrder: dependency.fromPlayOrder,
    throughPlayOrder: dependency.throughPlayOrder,
  });
}

function scopeToJson(scope: LlmWikiScope): LlmJsonValue {
  if (scope.kind === "route") return { kind: "route", routeId: scope.routeId };
  if (scope.kind === "route-set") return { kind: "route-set", routeIds: [...scope.routeIds] };
  return { kind: "global" };
}

function assertDependency(dependency: LlmWikiDependency): void {
  const locates =
    dependency.claimId !== null ||
    dependency.fieldPath.length > 0 ||
    dependency.renderingId !== null;
  if (!locates) {
    throw new Error("a dependency must identify a consumed claim, field, or rendering");
  }
  if (!Number.isSafeInteger(dependency.upstreamVersion) || dependency.upstreamVersion <= 0) {
    throw new Error("a dependency upstream version must be a positive integer");
  }
  assertIdentifier(dependency.upstreamObjectId, "dependency upstream object ID");
  if (dependency.claimId !== null) assertIdentifier(dependency.claimId, "dependency claim ID");
  if (dependency.renderingId !== null) {
    assertIdentifier(dependency.renderingId, "dependency rendering ID");
  }
  for (const segment of dependency.fieldPath) assertIdentifier(segment, "dependency field segment");
  assertPlayOrder(dependency.fromPlayOrder);
  assertPlayOrder(dependency.throughPlayOrder);
  const { fromPlayOrder: from, throughPlayOrder: through } = dependency;
  if (from !== null && through !== null && through < from) {
    throw new Error("a dependency play-order range must not be reversed");
  }
}

function assertPlayOrder(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error("a dependency play order must be a non-negative integer");
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} is not a stable identifier`);
}
