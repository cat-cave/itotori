import {
  canonicalLlmJson,
  type ItotoriLlmWikiRepository,
  type LlmWikiHead,
  type LlmWikiScope,
} from "@itotori/db";
import {
  LocalizedRenderingSchema,
  WikiObjectSchema,
  type LocalizedRendering,
  type WikiObject,
} from "../contracts/index.js";

// The strict WikiObject / LocalizedRendering contracts are the write gate: a
// forged category, scope, or provenance fails to parse here before any row is
// written. A parsed object's typed fields are then extracted into the strict
// persistence columns while its canonical JSON seeds the content-addressed
// version, so the stored columns and the stored body cannot diverge.

export interface PersistWikiOptions {
  expectedHead: LlmWikiHead | null;
  createdAt: string;
}

export async function persistWikiObject(
  repository: ItotoriLlmWikiRepository,
  candidate: unknown,
  options: PersistWikiOptions,
): Promise<LlmWikiHead> {
  const object: WikiObject = WikiObjectSchema.parse(candidate);
  const objectJson = canonicalLlmJson(object as never);
  if (object.kind === "translation") {
    return repository.putWikiObject({
      wikiKind: "translation-object",
      objectId: object.objectId,
      objectVersion: object.version,
      supersedesVersion: object.supersedesVersion ?? null,
      snapshotId: object.provenance.localizationSnapshotId,
      localizationSnapshotId: object.provenance.localizationSnapshotId,
      objectKind: object.kind,
      language: object.lang,
      subject: { kind: object.subject.kind, id: object.subject.id },
      scope: toWikiScope(object.scope),
      provisional: object.provisional,
      contextScope: object.provenance.contextScope,
      runMode: object.provenance.runMode,
      editedBy: object.provenance.editedBy ?? null,
      authorRole: object.provenance.authorRoleId ?? null,
      objectJson,
      createdAt: options.createdAt,
      expectedHead: options.expectedHead,
    });
  }
  return repository.putWikiObject({
    wikiKind: "source-object",
    objectId: object.objectId,
    objectVersion: object.version,
    supersedesVersion: object.supersedesVersion ?? null,
    snapshotId: object.provenance.contextSnapshotId,
    localizationSnapshotId: null,
    objectKind: object.kind,
    language: object.lang,
    subject: { kind: object.subject.kind, id: object.subject.id },
    scope: toWikiScope(object.scope),
    provisional: object.provisional,
    contextScope: object.provenance.contextScope,
    runMode: object.provenance.runMode,
    editedBy: object.provenance.editedBy ?? null,
    authorRole: object.provenance.authorRoleId ?? null,
    objectJson,
    createdAt: options.createdAt,
    expectedHead: options.expectedHead,
  });
}

export async function persistLocalizedRendering(
  repository: ItotoriLlmWikiRepository,
  candidate: unknown,
  options: PersistWikiOptions,
): Promise<LlmWikiHead> {
  const rendering: LocalizedRendering = LocalizedRenderingSchema.parse(candidate);
  const objectJson = canonicalLlmJson(rendering as never);
  return repository.putLocalizedRendering({
    objectId: rendering.renderingId,
    objectVersion: rendering.version,
    supersedesVersion: rendering.supersedesVersion ?? null,
    snapshotId: rendering.provenance.localizationSnapshotId,
    localizationSnapshotId: rendering.provenance.localizationSnapshotId,
    objectKind: rendering.sourceObjectKind,
    language: rendering.targetLanguage,
    scope: toWikiScope(rendering.scope),
    provisional: rendering.provisional,
    runMode: rendering.provenance.runMode,
    editedBy: rendering.provenance.editedBy ?? null,
    sourceObjectId: rendering.sourceObjectId,
    objectJson,
    createdAt: options.createdAt,
    expectedHead: options.expectedHead,
  });
}

function toWikiScope(scope: WikiObject["scope"]): LlmWikiScope {
  if (scope.kind === "route") return { kind: "route", routeId: scope.routeId };
  if (scope.kind === "route-set") return { kind: "route-set", routeIds: scope.routeIds };
  return { kind: "global" };
}
