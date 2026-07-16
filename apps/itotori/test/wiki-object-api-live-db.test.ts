import { createHash } from "node:crypto";
import {
  ItotoriLlmHumanInputRepository,
  ItotoriLlmSnapshotRepository,
  ItotoriLlmWikiRepository,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { persistLocalizedRendering, persistWikiObject } from "../src/wiki/object-persistence.js";
import { ForgedWikiAssertionError, WikiObjectApiService } from "../src/wiki/object-api/index.js";
import type {
  EnhancementProposal,
  EnhancementRequest,
  EnhancementRunner,
} from "../src/wiki/human-enhancement/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { H2, localizedRenderingExample, wikiObjectExample } from "./contract-fixtures-core.js";
import { TestMemoCipher } from "./llm-step-test-support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

const CREATED_AT = "2026-07-16T12:00:00.000Z";
const SOURCE_ID = wikiObjectExample.objectId;
const SOURCE_SELECTOR = { wikiKind: "source-object" as const, objectId: SOURCE_ID };
const RENDERING_ID = "rendering:dependent:1";
const OTHER_SNAPSHOT = `sha256:${"9".repeat(64)}`;

const PORTRAIT_MEDIA = {
  kind: "portrait" as const,
  mediaId: "media:portrait:1",
  characterId: "character:1",
  availability: {
    status: "available" as const,
    artifactUri: "https://artifacts.example/portrait.png",
    contentHash: H2,
    mediaType: "image/png" as const,
    dimensions: { width: 128, height: 128 },
    access: { redaction: "default-redacted" as const, permission: "project-member" as const },
  },
};

postgresDescribe("wiki object read/write API over the WikiObject substrate", () => {
  it("PROOF (list): exposes SOURCE wiki objects without a locale branch, and per-target renderings", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { api, contextId, localizationId } = await setup(context, cipher);

      // Source truth needs ONLY the context snapshot — no locale branch anywhere.
      const sourceList = await api.list({ snapshotId: contextId });
      expect(sourceList.sourceObjects.map((view) => view.objectId)).toEqual([SOURCE_ID]);
      expect(sourceList.renderings).toHaveLength(0);
      const [sourceView] = sourceList.sourceObjects;
      expect(sourceView?.kind).toBe("source");
      expect(sourceView?.routeScope).toEqual({ kind: "global" });
      expect(sourceView?.badges.runMode).toBe("production");

      // Per-target bible renderings resolve under the localization snapshot.
      const targetList = await api.list({ snapshotId: localizationId });
      expect(targetList.sourceObjects).toHaveLength(0);
      expect(targetList.renderings.map((view) => view.kind)).toEqual(["rendering"]);
      const [renderingView] = targetList.renderings;
      expect(renderingView?.kind === "rendering" && renderingView.renderingId).toBe(RENDERING_ID);
    } finally {
      await context.close();
    }
  });

  it("PROOF (show): carries route scope, citations, media, badges, history, and dependency impact", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { api } = await setup(context, cipher);
      const shown = await api.show(SOURCE_SELECTOR);
      if (shown === null || shown.view.kind !== "source") throw new Error("expected a source view");

      expect(shown.view.routeScope).toEqual({ kind: "global" });
      // Citations (the claim substrate) are surfaced verbatim.
      expect(shown.view.citations.map((citation) => citation.claimId)).toEqual(["claim:style:1"]);
      // Media (reference-only) is surfaced.
      expect(shown.view.media.map((ref) => ref.mediaId)).toEqual(["media:portrait:1"]);
      // Provisional / context / run badges.
      expect(shown.view.badges).toMatchObject({
        provisional: true,
        contextScope: "whole-game",
        runMode: "production",
        editedBy: "agent",
      });
      // Immutable history: a single v1 so far.
      expect(shown.history.map((entry) => entry.version)).toEqual([1]);
      // Dependency impact: the downstream rendering consumes this object.
      expect(shown.dependents.map((dependent) => dependent.downstreamObjectId)).toContain(
        RENDERING_ID,
      );
    } finally {
      await context.close();
    }
  });

  it("PROOF (edit): returns an IMMEDIATE durable receipt (non-blocking), badges, and dependency impact", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { api, humanInputs } = await setup(context, cipher);
      const session = await api.openEditSession(SOURCE_SELECTOR);
      const receipt = await api.edit(session, editInput(), CREATED_AT);

      // The receipt is durable and immediate: the head advanced now (v1 -> v2).
      expect(receipt.durable).toBe(true);
      expect(receipt.head.version).toBe(2);
      expect(receipt.inputId).toBe("human:edit:1");
      // The receipt carries the badges of the new head.
      expect(receipt.badges.runMode).toBe("production");
      // Non-blocking + no old correction worker: the receipt carries NO redraft
      // job / correction id / rerun state — it is not a context-correction result.
      expect(receipt).not.toHaveProperty("redraftJobId");
      expect(receipt).not.toHaveProperty("correctionId");
      expect(receipt).not.toHaveProperty("rerun");
      // Dependency impact: the edited field reaches the downstream rendering.
      expect(receipt.dependencyImpact.upstreamObjectId).toBe(SOURCE_ID);
      expect(
        receipt.dependencyImpact.consumers.map((consumer) => consumer.downstreamObjectId),
      ).toContain(RENDERING_ID);

      // Durable proof: the immutable human input is persisted.
      const records = await humanInputs.list(`source-object:${SOURCE_ID}`);
      expect(records.map((record) => record.inputKind)).toEqual(["edit"]);
    } finally {
      await context.close();
    }
  });

  it("PROOF (feedback): returns an immediate durable receipt without awaiting inference", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { api } = await setup(context, cipher);
      const session = await api.openEditSession(SOURCE_SELECTOR);
      const receipt = await api.feedback(session, feedbackInput(), CREATED_AT);
      expect(receipt.durable).toBe(true);
      expect(receipt.head.version).toBe(2);
      expect(receipt.inputId).toBe("human:fb:1");
    } finally {
      await context.close();
    }
  });

  it("PROOF (history): the version chain is immutable and append-only", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { api } = await setup(context, cipher);
      const session = await api.openEditSession(SOURCE_SELECTOR);
      await api.edit(session, editInput(), CREATED_AT);

      const history = await api.history(SOURCE_SELECTOR);
      expect(history?.map((entry) => entry.version)).toEqual([1, 2]);
      // v1 is unchanged (still the agent-authored provisional original).
      const v1 = history?.find((entry) => entry.version === 1);
      expect(v1?.editedBy).toBe("agent");
      expect(v1?.provisional).toBe(true);
      // v2 is the human edit.
      expect(history?.find((entry) => entry.version === 2)?.editedBy).toBe("human");
    } finally {
      await context.close();
    }
  });

  it("PROOF (apply): the intentional boundary launches the bounded enhancement over the human delta", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { api } = await setup(context, cipher);
      const spy = { count: 0 };
      const session = await api.openEditSession(SOURCE_SELECTOR);
      await api.edit(session, editInput(), CREATED_AT);

      const receipt = await api.apply(session, {
        runner: recordingRunner(spy),
        decodedFacts: [],
        createdAt: CREATED_AT,
      });
      expect(spy.count).toBe(1);
      expect(receipt.enhancementLaunched).toBe(true);
      expect(receipt.coalescedInputCount).toBe(1);
      expect(receipt.head.version).toBe(3);
      // The enhancement marked the human-touched head non-provisional.
      expect(receipt.badges.provisional).toBe(false);
      expect(receipt.dependencyImpact.upstreamObjectId).toBe(SOURCE_ID);
    } finally {
      await context.close();
    }
  });

  it("PROOF (guard): a forged category is REJECTED at the API boundary against the substrate", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { api } = await setup(context, cipher);
      // The real category is style-contract; the caller forges term-ruling.
      await expect(
        api.openEditSession(SOURCE_SELECTOR, { category: "term-ruling" }),
      ).rejects.toBeInstanceOf(ForgedWikiAssertionError);
      // No version was appended — the write never began.
      const history = await api.history(SOURCE_SELECTOR);
      expect(history?.map((entry) => entry.version)).toEqual([1]);
    } finally {
      await context.close();
    }
  });

  it("PROOF (guard): a forged source provenance is REJECTED against the substrate", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { api } = await setup(context, cipher);
      let caught: unknown;
      try {
        await api.openEditSession(SOURCE_SELECTOR, { contextSnapshotId: OTHER_SNAPSHOT });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ForgedWikiAssertionError);
      expect((caught as ForgedWikiAssertionError).dimension).toBe("provenance");
    } finally {
      await context.close();
    }
  });
});

function editInput() {
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

function feedbackInput() {
  return {
    kind: "feedback",
    inputId: "human:fb:1",
    text: "Make the honorific guidance warmer and more explicit.",
  };
}

/** A recorded proposal runner: it preserves the human-applied body so the apply
 * boundary is exercised offline with no live inference. */
function recordingRunner(spy: { count: number }): EnhancementRunner {
  return async (request: EnhancementRequest): Promise<EnhancementProposal> => {
    spy.count += 1;
    return { objectJson: structuredClone(request.humanAppliedJson) };
  };
}

async function setup(
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

function sourceObject(contextId: string): typeof wikiObjectExample {
  return {
    ...wikiObjectExample,
    media: [PORTRAIT_MEDIA],
    provenance: { ...wikiObjectExample.provenance, contextSnapshotId: contextId },
  } as unknown as typeof wikiObjectExample;
}

function dependentRendering(localizationId: string): typeof localizedRenderingExample {
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

async function putSnapshots(
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

function revision(id: string): { revisionId: string; contentHash: `sha256:${string}` } {
  return { revisionId: id, contentHash: hashOf(id) };
}

function hashOf(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
