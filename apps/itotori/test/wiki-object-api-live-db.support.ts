import { createHash } from "node:crypto";
import {
  ItotoriLlmHumanInputRepository,
  ItotoriLlmSnapshotRepository,
  ItotoriLlmWikiRepository,
} from "@itotori/db";
import { describe } from "vitest";
import { WIKI_OBJECT_SCHEMA_VERSION } from "../src/contracts/index.js";
import { handleItotoriApiRequest, type ItotoriApiServices } from "../src/api-handlers.js";
import { canonicalJson, sha256 } from "../src/llm/canonical-json.js";
import { persistLocalizedRendering, persistWikiObject } from "../src/wiki/object-persistence.js";
import { WikiObjectApiService } from "../src/wiki/object-api/index.js";
import {
  createDispatchEnhancementRunner,
  type EnhancementRequest,
  type EnhancementRunner,
} from "../src/wiki/human-enhancement/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { H2, localizedRenderingExample, wikiObjectExample } from "./contract-fixtures-core.js";
import {
  TestMemoCipher,
  dispatchHarness,
  physicalCallSpec,
  structuredProviderResponse,
} from "./llm-step-test-support.js";

export const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

export const CREATED_AT = "2026-07-16T12:00:00.000Z";

export const SOURCE_ID = wikiObjectExample.objectId;

export const SOURCE_SELECTOR = { wikiKind: "source-object" as const, objectId: SOURCE_ID };

export const RENDERING_ID = "rendering:dependent:1";

export const OTHER_SNAPSHOT = `sha256:${"9".repeat(64)}`;

export const PORTRAIT_MEDIA = {
  kind: "portrait" as const,
  mediaId: "media:portrait:1",
  characterId: "character:1",
  availability: {
    status: "available" as const,
    artifactUri: "artifacts/utsushi/runtime/test-run/screenshots/portrait.png",
    contentHash: H2,
    mediaType: "image/png" as const,
    dimensions: { width: 128, height: 128 },
    access: { redaction: "default-redacted" as const, permission: "project-member" as const },
  },
};

export async function request(
  services: ItotoriApiServices,
  method: string,
  pathname: string,
  body?: unknown,
  search?: string,
) {
  return await handleItotoriApiRequest(
    {
      method,
      pathname,
      ...(body === undefined ? {} : { body }),
      ...(search === undefined ? {} : { search }),
    },
    services,
  );
}

export function editInput() {
  return {
    kind: "edit",
    inputId: "human:edit:1",
    operations: [
      {
        kind: "replace-text",
        fieldPath: ["body", "registerPolicy"],
        before: "Use a direct register.",
        after: "Use a warm, direct register.",
      },
    ],
    note: "Warmer tone requested by the play tester.",
  };
}

export function feedbackInput() {
  return {
    kind: "feedback",
    inputId: "human:fb:1",
    text: "Make the honorific guidance warmer and more explicit.",
  };
}

export function memoizedApiRunner(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: TestMemoCipher,
  proposal: unknown,
): { readonly runner: EnhancementRunner; readonly transportCalls: () => number } {
  const harness = dispatchHarness({
    pool: context.pool,
    cipher,
    prompt: "unused: API enhancement planner replaces this payload",
    responses: [structuredProviderResponse(proposal)],
  });
  const runner = createDispatchEnhancementRunner({
    plan: (request: EnhancementRequest) => {
      const payload = canonicalJson({
        priorObjectJson: request.priorObjectJson,
        humanDelta: request.delta,
      });
      return {
        spec: physicalCallSpec(payload, {
          output: {
            name: "wiki-object",
            schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
            schemaHash: sha256(WIKI_OBJECT_SCHEMA_VERSION),
          },
        }),
        runtime: {
          ...harness.runtime,
          readPayload: async () => payload,
        },
      };
    },
  });
  return { runner, transportCalls: harness.transportCalls };
}

export async function setup(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  cipher: TestMemoCipher,
): Promise<{
  api: WikiObjectApiService;
  humanInputs: ItotoriLlmHumanInputRepository;
  contextId: string;
  localizationId: string;
}> {
  const { contextId, localizationId } = await putSnapshots(context);
  const wiki = new ItotoriLlmWikiRepository(context.pool, cipher);
  const humanInputs = new ItotoriLlmHumanInputRepository(context.pool, cipher);

  await persistWikiObject(wiki, sourceObject(contextId), {
    expectedHead: null,
    createdAt: CREATED_AT,
  });
  await persistLocalizedRendering(wiki, dependentRendering(localizationId), {
    expectedHead: null,
    createdAt: CREATED_AT,
  });

  const api = new WikiObjectApiService({ wiki, humanInputs });
  return { api, humanInputs, contextId, localizationId };
}

export function sourceObject(contextId: string): typeof wikiObjectExample {
  return {
    ...wikiObjectExample,
    media: [PORTRAIT_MEDIA],
    provenance: { ...wikiObjectExample.provenance, contextSnapshotId: contextId },
  } as unknown as typeof wikiObjectExample;
}

export function dependentRendering(localizationId: string): typeof localizedRenderingExample {
  return {
    ...localizedRenderingExample,
    renderingId: RENDERING_ID,
    sourceObjectId: SOURCE_ID,
    dependencies: [
      {
        upstreamObjectId: SOURCE_ID,
        upstreamVersion: 1,
        claimId: null,
        fieldPath: ["body", "registerPolicy"],
        renderingId: null,
        scope: { kind: "global" },
        fromPlayOrder: null,
        throughPlayOrder: null,
      },
    ],
    provenance: {
      ...localizedRenderingExample.provenance,
      localizationSnapshotId: localizationId,
    },
  } as unknown as typeof localizedRenderingExample;
}

export async function putSnapshots(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<{ contextId: string; localizationId: string }> {
  const repository = new ItotoriLlmSnapshotRepository(context.pool);
  const contextSnapshot = await repository.putContext({
    sourceLanguage: "ja",
    decode: revision("decode:1"),
    sourceUnits: [{ unitId: "unit:1", sourceHash: hashOf("unit:1") }],
    facts: [{ factId: "scene:1", playOrderIndex: 0, routeScope: { kind: "global" } }],
    structure: revision("structure:1"),
    routeGraph: revision("route-graph:1"),
    glossary: revision("glossary:1"),
    style: revision("style:1"),
    revealHorizon: { kind: "complete" },
    humanCorrections: revision("human-corrections:1"),
    externalSources: null,
    contextScope: "whole-game",
  });
  const localization = await repository.putLocalization({
    contextSnapshotId: contextSnapshot.snapshotId,
    targetLocale: "en-US",
    localeBranchId: "branch:primary",
    acceptedBibleHead: null,
    acceptedTargetOutputHead: null,
  });
  return { contextId: contextSnapshot.snapshotId, localizationId: localization.snapshotId };
}

export function revision(id: string): { revisionId: string; contentHash: `sha256:${string}` } {
  return { revisionId: id, contentHash: hashOf(id) };
}

export function hashOf(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
