// p0-core-iterative-patch-versioning-and-playtest-feedback — black-box HTTP
// contract proof for the node-11 iteration topology. These tests deliberately
// exercise the real node:http server rather than handler functions directly.
import type { Permission } from "@itotori/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertHttpContractError,
  assertHttpContractOk,
  fixturePatchIteration,
  fixturePlayTesterResultRevision,
  fixtureRequirePermission,
  resetFixtureServiceFactoryMocks,
  startHttpContractHarness,
  type HttpContractHarness,
} from "./http-contract-harness.js";

let harness: HttpContractHarness;

beforeAll(async () => {
  harness = await startHttpContractHarness();
});

afterAll(async () => {
  await harness.close();
});

afterEach(() => {
  resetFixtureServiceFactoryMocks();
});

function expectNoPrivateArtifactReferences(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("artifactRefs");
  expect(serialized).not.toContain("artifact://private/");
}

describe("patch iteration /api routes over real loopback HTTP", () => {
  it("lists version lineage and loads the historical play surface without private artifact refs", async () => {
    const versions = await harness.httpRequest("patchIteration.versions", {
      params: { localeBranchId: "locale-branch-iteration" },
    });

    assertHttpContractOk("patchIteration.versions", versions);
    expect(fixturePatchIteration.list).toHaveBeenCalledWith({
      localeBranchId: "locale-branch-iteration",
    });
    expect(versions.body).toEqual(
      expect.objectContaining({
        schemaVersion: "itotori.patch-iteration.versions.v0",
        versions: expect.arrayContaining([
          expect.objectContaining({
            patchVersionId: "patch-iteration-v2",
            parentPatchVersionId: "patch-iteration-v1",
            basePatchVersionId: "patch-iteration-v1",
            origin: "refinement_run",
          }),
        ]),
      }),
    );
    expectNoPrivateArtifactReferences(versions.body);

    const surface = await harness.httpRequest("patchIteration.surface", {
      params: { patchVersionId: "patch-iteration-v1" },
    });

    assertHttpContractOk("patchIteration.surface", surface);
    expect(fixturePatchIteration.load).toHaveBeenCalledWith({
      patchVersionId: "patch-iteration-v1",
    });
    expect(surface.body).toMatchObject({
      schemaVersion: "itotori.patch-iteration.surface.v0",
      patch: {
        patchVersionId: "patch-iteration-v1",
        qaCallouts: [
          expect.objectContaining({
            informational: true,
            confidence: "0.42",
            contested: true,
          }),
        ],
      },
      feedback: {
        observedPatchVersionId: "patch-iteration-v1",
        batches: [
          expect.objectContaining({
            feedbackBatchId: "feedback-batch-iteration-batched",
            events: [
              expect.objectContaining({ feedbackEventId: "feedback-event-iteration-individual" }),
            ],
          }),
        ],
      },
    });
    expectNoPrivateArtifactReferences(surface.body);
  });

  it("delivers the exact historical version and its authenticated archive after selection moved", async () => {
    const delivery = await harness.httpRequest("patchIteration.delivery", {
      params: { patchVersionId: "patch-iteration-v1" },
    });

    assertHttpContractOk("patchIteration.delivery", delivery);
    expect(fixturePlayTesterResultRevision.loadExactPatchExport).toHaveBeenCalledWith({
      patchVersionId: "patch-iteration-v1",
    });
    expect(delivery.body).toMatchObject({
      schemaVersion: "itotori.patch-iteration.delivery.v0",
      patchVersionId: "patch-iteration-v1",
      playableAt: "2026-07-13T12:00:00.000Z",
      artifactHashes: { patchTarget: "sha256:iteration-v1-exact" },
      downloadUrl: "/api/play/patch-versions/patch-iteration-v1/delivery/archive",
      units: [{ targetBody: "The original playable line." }],
    });
    expectNoPrivateArtifactReferences(delivery.body);

    const archiveUrl = (delivery.body as { downloadUrl: string }).downloadUrl;
    const archive = await fetch(`${harness.origin}${archiveUrl}`);
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toContain("application/x-tar");
    expect(archive.headers.get("content-disposition")).toContain(
      'attachment; filename="patch-iteration-v1.tar"',
    );
    expect(Buffer.from(await archive.arrayBuffer())).toEqual(
      Buffer.from("fixture-exact-historical-patch-tar", "utf8"),
    );
    expect(fixturePlayTesterResultRevision.loadExactPatchArchive).toHaveBeenCalledWith({
      patchVersionId: "patch-iteration-v1",
    });
  });

  it("does not route an encoded traversal version id to exact archive delivery", async () => {
    const traversal = await harness.httpRequest(
      "/api/play/patch-versions/%2E%2E%2Foutside/delivery/archive",
    );

    assertHttpContractError(traversal, { status: 404, code: "not_found" });
    expect(fixturePlayTesterResultRevision.loadExactPatchArchive).not.toHaveBeenCalled();
  });

  it("routes play, batched and individual feedback, and refinement through draft.write", async () => {
    const play = await harness.httpRequest("patchIteration.play", {
      params: { patchVersionId: "patch-iteration-v1" },
      body: { launchDescriptor: { source: "dashboard" } },
    });
    assertHttpContractOk("patchIteration.play", play);
    expect(fixturePatchIteration.play).toHaveBeenCalledWith({
      patchVersionId: "patch-iteration-v1",
      launchDescriptor: { source: "dashboard" },
    });
    expect(play.body).toMatchObject({
      schemaVersion: "itotori.patch-iteration.play.v0",
      session: {
        playSessionId: "play-session-iteration-v1",
        observedPatchVersionId: "patch-iteration-v1",
        qaCallouts: [expect.objectContaining({ informational: true })],
      },
    });
    expectNoPrivateArtifactReferences(play.body);
    expect(JSON.stringify(play.body)).not.toContain("launchDescriptor");

    const batch = await harness.httpRequest("patchIteration.feedbackBatch", {
      params: { patchVersionId: "patch-iteration-v1" },
      body: {
        feedbackBatchId: "feedback-batch-iteration-batched",
        label: "Route playtest notes",
      },
    });
    assertHttpContractOk("patchIteration.feedbackBatch", batch);
    expect(fixturePatchIteration.createFeedbackBatch).toHaveBeenCalledWith({
      observedPatchVersionId: "patch-iteration-v1",
      feedbackBatchId: "feedback-batch-iteration-batched",
      label: "Route playtest notes",
    });
    expect(batch.body).toMatchObject({
      schemaVersion: "itotori.patch-iteration.feedback-batch.v0",
      batch: {
        feedbackBatchId: "feedback-batch-iteration-batched",
        events: [],
      },
    });

    const batchedFeedback = await harness.httpRequest("patchIteration.feedback", {
      params: { patchVersionId: "patch-iteration-v1" },
      body: {
        feedbackBatchId: "feedback-batch-iteration-batched",
        playSessionId: "play-session-iteration-v1",
        eventKind: "comment",
        body: "The scene reads too formal in play.",
        metadata: { route: "intro" },
        affectedBridgeUnitIds: ["bridge-unit-iteration-changed"],
      },
    });
    assertHttpContractOk("patchIteration.feedback", batchedFeedback);
    expect(fixturePatchIteration.feedback).toHaveBeenNthCalledWith(1, {
      observedPatchVersionId: "patch-iteration-v1",
      feedbackBatchId: "feedback-batch-iteration-batched",
      playSessionId: "play-session-iteration-v1",
      eventKind: "comment",
      body: "The scene reads too formal in play.",
      metadata: { route: "intro" },
      affectedBridgeUnitIds: ["bridge-unit-iteration-changed"],
    });
    expect(batchedFeedback.body).toMatchObject({
      feedback: {
        feedbackBatchId: "feedback-batch-iteration-batched",
        eventKind: "comment",
        metadata: { route: "intro" },
      },
    });

    const individualFeedback = await harness.httpRequest("patchIteration.feedback", {
      params: { patchVersionId: "patch-iteration-v1" },
      body: {
        playSessionId: "play-session-iteration-v1",
        eventKind: "result_edit",
        targetBody: "The refined playable line.",
        resultRevisionId: "result-revision-iteration-v1-changed",
        affectedBridgeUnitIds: ["bridge-unit-iteration-changed"],
      },
    });
    assertHttpContractOk("patchIteration.feedback", individualFeedback);
    expect(fixturePatchIteration.feedback).toHaveBeenNthCalledWith(2, {
      observedPatchVersionId: "patch-iteration-v1",
      playSessionId: "play-session-iteration-v1",
      eventKind: "result_edit",
      targetBody: "The refined playable line.",
      resultRevisionId: "result-revision-iteration-v1-changed",
      affectedBridgeUnitIds: ["bridge-unit-iteration-changed"],
    });
    expect(individualFeedback.body).toMatchObject({
      feedback: {
        feedbackBatchId: "feedback-batch-iteration-individual",
        eventKind: "result_edit",
        metadata: { targetBody: "The refined playable line." },
      },
    });

    const addedContextFeedback = await harness.httpRequest("patchIteration.feedback", {
      params: { patchVersionId: "patch-iteration-v1" },
      body: {
        playSessionId: "play-session-iteration-v1",
        eventKind: "added_context",
        contextFeedback: {
          operation: "add",
          kind: "note",
          title: "Opening-scene register",
          body: "Use the protagonist's familiar register in the opening scene.",
          reason: "Observed during the v1 play session.",
          affectedBridgeUnitIds: ["bridge-unit-iteration-changed"],
        },
      },
    });
    assertHttpContractOk("patchIteration.feedback", addedContextFeedback);
    expect(fixturePatchIteration.feedback).toHaveBeenNthCalledWith(3, {
      observedPatchVersionId: "patch-iteration-v1",
      playSessionId: "play-session-iteration-v1",
      eventKind: "added_context",
      contextFeedback: {
        operation: "add",
        kind: "note",
        title: "Opening-scene register",
        body: "Use the protagonist's familiar register in the opening scene.",
        reason: "Observed during the v1 play session.",
        affectedBridgeUnitIds: ["bridge-unit-iteration-changed"],
      },
    });

    const wikiEditFeedback = await harness.httpRequest("patchIteration.feedback", {
      params: { patchVersionId: "patch-iteration-v1" },
      body: {
        eventKind: "wiki_edit",
        contextFeedback: {
          operation: "edit",
          contextArtifactId: "context-artifact-iteration-route",
          title: "Opening-scene register (clarified)",
          body: "Use the protagonist's familiar register before the route split.",
          reason: "The playtest narrowed the affected scene range.",
          affectedBridgeUnitIds: ["bridge-unit-iteration-changed"],
        },
      },
    });
    assertHttpContractOk("patchIteration.feedback", wikiEditFeedback);
    expect(fixturePatchIteration.feedback).toHaveBeenNthCalledWith(4, {
      observedPatchVersionId: "patch-iteration-v1",
      eventKind: "wiki_edit",
      contextFeedback: {
        operation: "edit",
        contextArtifactId: "context-artifact-iteration-route",
        title: "Opening-scene register (clarified)",
        body: "Use the protagonist's familiar register before the route split.",
        reason: "The playtest narrowed the affected scene range.",
        affectedBridgeUnitIds: ["bridge-unit-iteration-changed"],
      },
    });

    const refinement = await harness.httpRequest("patchIteration.refine", {
      params: { patchVersionId: "patch-iteration-v1" },
      body: {
        feedbackBatchIds: ["feedback-batch-iteration-batched"],
        feedbackEventIds: ["feedback-event-iteration-individual"],
        scopeUnitIds: ["bridge-unit-iteration-changed", "bridge-unit-iteration-reused"],
        targetBodiesByUnit: {
          "bridge-unit-iteration-changed": "The refined playable line.",
        },
        wikiHeads: [
          {
            contextArtifactId: "context-artifact-iteration-route",
            contextEntryVersionId: "context-entry-version-iteration-route-v2",
          },
        ],
      },
    });
    assertHttpContractOk("patchIteration.refine", refinement);
    expect(fixturePatchIteration.refine).toHaveBeenCalledWith({
      basePatchVersionId: "patch-iteration-v1",
      feedbackBatchIds: ["feedback-batch-iteration-batched"],
      feedbackEventIds: ["feedback-event-iteration-individual"],
      scopeUnitIds: ["bridge-unit-iteration-changed", "bridge-unit-iteration-reused"],
      targetBodiesByUnit: {
        "bridge-unit-iteration-changed": "The refined playable line.",
      },
      wikiHeads: [
        {
          contextArtifactId: "context-artifact-iteration-route",
          contextEntryVersionId: "context-entry-version-iteration-route-v2",
        },
      ],
    });
    expect(refinement.body).toMatchObject({
      schemaVersion: "itotori.patch-iteration.refine.v0",
      refinement: {
        runId: "run-iteration-v2",
        basePatchVersionId: "patch-iteration-v1",
        members: [
          expect.objectContaining({
            bridgeUnitId: "bridge-unit-iteration-changed",
            strategy: "redraft",
          }),
          expect.objectContaining({
            bridgeUnitId: "bridge-unit-iteration-reused",
            strategy: "reuse",
          }),
        ],
      },
      patch: {
        patchVersionId: "patch-iteration-v2",
        parentPatchVersionId: "patch-iteration-v1",
        units: [
          expect.objectContaining({
            bridgeUnitId: "bridge-unit-iteration-changed",
            targetBody: "The refined playable line.",
            memberOrigin: "run_written_outcome",
          }),
          expect.objectContaining({
            bridgeUnitId: "bridge-unit-iteration-reused",
            memberOrigin: "reused_from_base",
            reusedFromPatchVersionId: "patch-iteration-v1",
          }),
        ],
      },
    });
    expectNoPrivateArtifactReferences(refinement.body);

    expect(fixtureRequirePermission).toHaveBeenCalledTimes(7);
    for (const [permission] of fixtureRequirePermission.mock.calls) {
      expect(permission).toBe("draft.write" as Permission);
    }
  });

  it("rejects caller-supplied patch scope inside direct context feedback", async () => {
    const malformed = await harness.httpRequest("patchIteration.feedback", {
      params: { patchVersionId: "patch-iteration-v1" },
      body: {
        eventKind: "added_context",
        contextFeedback: {
          operation: "add",
          kind: "note",
          title: "Opening-scene register",
          body: "Use the protagonist's familiar register in the opening scene.",
          reason: "Observed during the v1 play session.",
          affectedBridgeUnitIds: ["bridge-unit-iteration-changed"],
          sourceRevisionId: "caller-must-not-control-source-scope",
        },
      },
    });

    assertHttpContractError(malformed, { status: 400, code: "bad_request" });
    expect(fixturePatchIteration.feedback).not.toHaveBeenCalled();
  });
});
