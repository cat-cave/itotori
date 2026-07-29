import { createHash } from "node:crypto";

import type { DatabaseContext } from "../src/connection.js";

import {
  ItotoriLlmSnapshotRepository,
  namespacedFactId,
  type LlmContextSnapshotInput,
  type LlmLocalizationSnapshotInput,
} from "../src/repositories/llm-snapshot-repository.js";
import {
  type PutLlmLocalizedRenderingInput,
  type PutLlmWikiObjectInput,
} from "../src/repositories/llm-wiki-repository.js";

export const OBJECT_ID = "wiki:scene:current";

export function sourceObject(
  contextSnapshotId: string,
  overrides: Partial<PutLlmWikiObjectInput> = {},
): PutLlmWikiObjectInput {
  return {
    wikiKind: "source-object",
    objectId: OBJECT_ID,
    objectVersion: 1,
    supersedesVersion: null,
    snapshotId: contextSnapshotId,
    localizationSnapshotId: null,
    objectKind: "scene-summary",
    language: "ja-JP",
    subject: { kind: "scene", id: "scene:current" },
    scope: { kind: "route", routeId: "route:active" },
    provisional: false,
    contextScope: "whole-game",
    runMode: "test-dev",
    editedBy: null,
    authorRole: "A3",
    objectJson: JSON.stringify({ beat: "default" }),
    dependencies: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedHead: null,
    ...overrides,
  };
}

export function translationObject(
  localizationSnapshotId: string,
  overrides: Partial<PutLlmWikiObjectInput> = {},
): PutLlmWikiObjectInput {
  return {
    wikiKind: "translation-object",
    objectId: "wiki:translation:batch",
    objectVersion: 1,
    supersedesVersion: null,
    snapshotId: localizationSnapshotId,
    localizationSnapshotId,
    objectKind: "translation",
    language: "en-US",
    subject: { kind: "scene", id: "scene:current" },
    scope: { kind: "route", routeId: "route:active" },
    provisional: true,
    contextScope: "whole-game",
    runMode: "test-dev",
    editedBy: "agent",
    authorRole: "P1",
    objectJson: JSON.stringify({ draft: "hello" }),
    dependencies: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedHead: null,
    ...overrides,
  };
}

export function localizedRendering(
  localizationSnapshotId: string,
  overrides: Partial<PutLlmLocalizedRenderingInput> = {},
): PutLlmLocalizedRenderingInput {
  return {
    objectId: "rendering:scene:current",
    objectVersion: 1,
    supersedesVersion: null,
    snapshotId: localizationSnapshotId,
    localizationSnapshotId,
    objectKind: "scene-summary",
    language: "en-US",
    scope: { kind: "route", routeId: "route:active" },
    provisional: false,
    runMode: "test-dev",
    editedBy: "enhancement",
    sourceObjectId: OBJECT_ID,
    objectJson: JSON.stringify({ kind: "scene-summary", sections: [] }),
    dependencies: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    expectedHead: null,
    ...overrides,
  };
}

export async function rawInsert(
  context: DatabaseContext,
  overrides: Record<string, unknown>,
): Promise<void> {
  const columns: Record<string, unknown> = {
    wiki_version_id: hashOf(`raw:${JSON.stringify(overrides)}`),
    wiki_kind: "source-object",
    object_id: "wiki:raw",
    object_version: 1,
    snapshot_kind: "context",
    snapshot_id: overrides.snapshot_id,
    object_kind: "scene-summary",
    wiki_ciphertext: Buffer.from("x"),
    wiki_key_ref: "raw-key",
    wiki_content_hash: hashOf("raw-body"),
    created_at: "2026-01-01T00:00:00.000Z",
    retention_deadline: "2026-06-01T00:00:00.000Z",
    object_language: "ja-JP",
    subject_kind: "scene",
    subject_id: "scene:raw",
    scope_kind: "global",
    scope_route_ids: [],
    provisional: false,
    context_scope: "whole-game",
    run_mode: "test-dev",
    provenance_edited_by: null,
    provenance_author_role: null,
    localization_snapshot_id: null,
    source_object_id: null,
    ...overrides,
  };
  const keys = Object.keys(columns);
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");
  await context.pool.query(
    `insert into itotori_llm_wiki_versions (${keys.join(", ")}) values (${placeholders})`,
    keys.map((key) => columns[key]),
  );
}

export async function putSnapshots(context: DatabaseContext): Promise<{
  context: string;
  localization: string;
}> {
  const repository = new ItotoriLlmSnapshotRepository(context.pool);
  const contextSnapshot = await repository.putContext(contextInput());
  const localization = await repository.putLocalization(
    localizationInput(contextSnapshot.snapshotId),
  );
  return { context: contextSnapshot.snapshotId, localization: localization.snapshotId };
}

export function contextInput(): LlmContextSnapshotInput {
  return {
    sourceLanguage: "ja-JP",
    decode: revision("decode:current"),
    sourceUnits: [{ unitId: "unit:alpha", sourceHash: hashOf("source:alpha") }],
    facts: [
      {
        factId: namespacedFactId("scene", "current"),
        playOrderIndex: 2,
        routeScope: { kind: "route", routeId: "route:active" },
      },
    ],
    structure: revision("structure:current"),
    routeGraph: revision("route-graph:current"),
    glossary: revision("glossary:current"),
    style: revision("style:current"),
    revealHorizon: { kind: "complete" },
    humanCorrections: revision("corrections:current"),
    externalSources: null,
    contextScope: "whole-game",
  };
}

export function localizationInput(contextSnapshotId: string): LlmLocalizationSnapshotInput {
  return {
    contextSnapshotId,
    targetLocale: "en-US",
    localeBranchId: "branch:primary",
    acceptedBibleHead: null,
    acceptedTargetOutputHead: null,
  };
}

export function revision(id: string): { revisionId: string; contentHash: `sha256:${string}` } {
  return { revisionId: id, contentHash: hashOf(id) };
}

export function hashOf(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
