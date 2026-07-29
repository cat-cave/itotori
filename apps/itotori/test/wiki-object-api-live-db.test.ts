import { createHash } from "node:crypto";
import {
  ItotoriLlmHumanInputRepository,
  ItotoriLlmSnapshotRepository,
  ItotoriLlmWikiRepository,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { WIKI_OBJECT_SCHEMA_VERSION } from "../src/contracts/index.js";
import { handleItotoriApiRequest, type ItotoriApiServices } from "../src/api-handlers.js";
import { canonicalJson, sha256 } from "../src/llm/canonical-json.js";
import { persistLocalizedRendering, persistWikiObject } from "../src/wiki/object-persistence.js";
import { ForgedWikiAssertionError, WikiObjectApiService } from "../src/wiki/object-api/index.js";
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

import {
  postgresDescribe,
  CREATED_AT,
  SOURCE_ID,
  SOURCE_SELECTOR,
  RENDERING_ID,
  OTHER_SNAPSHOT,
  PORTRAIT_MEDIA,
  request,
  editInput,
  feedbackInput,
  memoizedApiRunner,
  setup,
  sourceObject,
  dependentRendering,
  putSnapshots,
  revision,
  hashOf,
} from "./wiki-object-api-live-db.support.js";

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
      const { api, contextId } = await setup(context, cipher);
      const enhancement = memoizedApiRunner(context, cipher, sourceObject(contextId));
      const session = await api.openEditSession(SOURCE_SELECTOR);
      await api.edit(session, editInput(), CREATED_AT);

      const receipt = await api.apply(session, {
        runner: enhancement.runner,
        decodedFacts: [],
        createdAt: CREATED_AT,
      });
      expect(enhancement.transportCalls()).toBe(1);
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

  it("PROOF (HTTP): list/show/history/edit/feedback/apply use typed WikiObjects with no localeBranchId", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const { api, contextId } = await setup(context, cipher);
      const enhancement = memoizedApiRunner(context, cipher, sourceObject(contextId));
      const services = {
        authorization: { requirePermission: async () => undefined },
        wikiObjectApi: api,
        wikiApply: { runner: enhancement.runner, decodedFacts: [] },
      } as unknown as ItotoriApiServices;

      const list = await request(
        services,
        "GET",
        "/api/wiki",
        undefined,
        `?snapshotId=${contextId}`,
      );
      expect(list.statusCode).toBe(200);
      expect((list.body as { sourceObjects: unknown[] }).sourceObjects).toHaveLength(1);
      expect(
        (list.body as { sourceObjects: Array<{ badges: { contextScope: string | null } }> })
          .sourceObjects[0]?.badges.contextScope,
      ).toBe("whole-game");

      const path = `/api/wiki/source-object/${SOURCE_ID}`;
      const shown = await request(services, "GET", path);
      expect(shown.statusCode).toBe(200);
      expect((shown.body as { view: { kind: string }; history: unknown[] }).view.kind).toBe(
        "source",
      );
      expect((shown.body as { history: unknown[] }).history).toHaveLength(1);

      const history = await request(services, "GET", `${path}/history`);
      expect(history.statusCode).toBe(200);
      expect((history.body as { history: unknown[] }).history).toHaveLength(1);

      const forged = await request(services, "POST", `${path}/edit`, {
        input: editInput(),
        assertion: { category: "term-ruling", contextSnapshotId: contextId },
      });
      expect(forged).toMatchObject({ statusCode: 400, body: { code: "bad_request" } });

      const invalidCategory = await request(services, "POST", `${path}/edit`, {
        input: editInput(),
        assertion: { category: "not-a-wiki-category", contextSnapshotId: contextId },
      });
      expect(invalidCategory).toMatchObject({ statusCode: 400, body: { code: "bad_request" } });

      const forgedProvenance = await request(services, "POST", `${path}/edit`, {
        input: editInput(),
        assertion: { category: "style-contract", contextSnapshotId: OTHER_SNAPSHOT },
      });
      expect(forgedProvenance).toMatchObject({ statusCode: 400, body: { code: "bad_request" } });

      const wrongMethod = await request(services, "GET", `${path}/edit`);
      expect(wrongMethod).toMatchObject({ statusCode: 405, body: { code: "method_not_allowed" } });

      const edit = await request(services, "POST", `${path}/edit`, {
        input: editInput(),
        assertion: { category: "style-contract", contextSnapshotId: contextId },
      });
      expect(edit.statusCode).toBe(200);
      expect(
        (edit.body as { receipt: { durable: boolean }; history: unknown[] }).receipt.durable,
      ).toBe(true);
      expect((edit.body as { history: unknown[] }).history).toHaveLength(2);

      const feedback = await request(services, "POST", `${path}/feedback`, {
        input: feedbackInput(),
        assertion: { category: "style-contract", contextSnapshotId: contextId },
      });
      expect(feedback.statusCode).toBe(200);
      expect((feedback.body as { receipt: { inputId: string } }).receipt.inputId).toBe(
        "human:fb:1",
      );

      const applied = await request(services, "POST", `${path}/apply`, {
        inputIds: ["human:edit:1", "human:fb:1"],
        assertion: { category: "style-contract", contextSnapshotId: contextId },
      });
      expect(applied.statusCode).toBe(200);
      expect(
        (applied.body as { receipt: { enhancementLaunched: boolean }; history: unknown[] }).receipt
          .enhancementLaunched,
      ).toBe(true);
      expect((applied.body as { history: unknown[] }).history).toHaveLength(4);
      expect(enhancement.transportCalls()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
