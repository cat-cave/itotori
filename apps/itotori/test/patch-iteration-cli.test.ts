import { describe, expect, it, vi } from "vitest";
import {
  runItotoriCliCommand,
  type ItotoriCliDependencies,
  type ItotoriCliServices,
} from "../src/cli-handlers.js";
import type { PatchIterationServicePort } from "../src/iteration/patch-iteration-service.js";

type PatchIterationFixture = {
  port: PatchIterationServicePort;
  list: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  createFeedbackBatch: ReturnType<typeof vi.fn>;
  feedback: ReturnType<typeof vi.fn>;
  refine: ReturnType<typeof vi.fn>;
};

function patchIterationFixture(): PatchIterationFixture {
  const list = vi.fn(async () => [patchVersionFixture()]);
  const load = vi.fn(async () => ({
    patch: patchSurfaceFixture(),
    versions: [patchVersionFixture()],
    feedback: {
      observedPatchVersionId: "patch-v1",
      batches: [],
    },
  }));
  const play = vi.fn(async () => ({
    playSessionId: "session-1",
    observedPatchVersionId: "patch-v1",
    status: "active",
    qaCallouts: [],
  }));
  const createFeedbackBatch = vi.fn(async () => ({
    feedbackBatchId: "batch-1",
    observedPatchVersionId: "patch-v1",
    selectionKind: "batch",
    label: "Route notes",
  }));
  const feedback = vi.fn(async () => ({
    feedbackEventId: "event-1",
    feedbackBatchId: "batch-1",
    observedPatchVersionId: "patch-v1",
    eventKind: "comment",
    affectedBridgeUnitIds: ["unit-1"],
  }));
  const refine = vi.fn(async () => ({
    refinement: { run: { runId: "refinement-run" } },
    patch: patchSurfaceFixture({ patchVersionId: "patch-v2", parentPatchVersionId: "patch-v1" }),
  }));
  return {
    port: {
      list,
      load,
      play,
      createFeedbackBatch,
      feedback,
      refine,
    } as unknown as PatchIterationServicePort,
    list,
    load,
    play,
    createFeedbackBatch,
    feedback,
    refine,
  };
}

function patchVersionFixture(overrides: Record<string, unknown> = {}) {
  return {
    patchVersionId: "patch-v1",
    runId: "run-v1",
    parentPatchVersionId: null,
    origin: "run_finalizer",
    status: "playable",
    playableAt: new Date("2026-07-13T00:00:00.000Z"),
    selectedAt: new Date("2026-07-13T00:00:00.000Z"),
    artifactHashes: { bundle: "sha256:fixture" },
    artifactRefs: { bundle: "/tmp/patch-v1" },
    basePatchVersionId: null,
    ...overrides,
  };
}

function patchSurfaceFixture(overrides: Record<string, unknown> = {}) {
  return {
    patchVersionId: "patch-v1",
    runId: "run-v1",
    parentPatchVersionId: null,
    origin: "run_finalizer",
    status: "playable",
    playableAt: new Date("2026-07-13T00:00:00.000Z"),
    selectedAt: new Date("2026-07-13T00:00:00.000Z"),
    artifactHashes: { bundle: "sha256:fixture" },
    artifactRefs: { bundle: "/tmp/patch-v1" },
    units: [],
    qaCallouts: [
      {
        journalFindingId: "finding-callout",
        bridgeUnitId: "unit-1",
        contested: true,
        confidence: "0.4",
        informational: true,
      },
    ],
    ...overrides,
  };
}

function cliFixture(port: PatchIterationServicePort): {
  dependencies: ItotoriCliDependencies;
  writes: Map<string, unknown>;
  loadExactPatchExport: ReturnType<typeof vi.fn>;
} {
  const writes = new Map<string, unknown>();
  const loadExactPatchExport = vi.fn(async () => ({
    schemaVersion: "play.playable_patch_export.v0.1" as const,
    generatedAt: new Date("2026-07-13T00:00:00.000Z"),
    export: {
      patchVersionId: "patch-v1",
      runId: "run-v1",
      parentPatchVersionId: null,
      origin: "run_finalizer",
      actorUserId: null,
      status: "playable",
      playableAt: new Date("2026-07-13T00:00:00.000Z"),
      selectedAt: null,
      artifactHashes: { patch: "sha256:fixture" },
      artifactRefs: { patchTarget: "/private/fixture" },
      units: [],
    },
  }));
  const services = {
    patchIteration: port,
    playTesterResultRevision: { loadExactPatchExport },
  } as unknown as ItotoriCliServices;
  return {
    dependencies: {
      io: {
        readJson: vi.fn(),
        writeJson: vi.fn((path: string, value: unknown) => {
          writes.set(path, value);
        }),
      },
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    },
    writes,
    loadExactPatchExport,
  };
}

describe("patch iteration CLI", () => {
  it("maps patch versions and play to the shared version/play service before legacy patch parsing", async () => {
    const service = patchIterationFixture();
    const { dependencies, writes, loadExactPatchExport } = cliFixture(service.port);

    await runItotoriCliCommand(
      ["patch", "versions", "--locale-branch", "branch-fr", "--output", "versions.json"],
      dependencies,
    );
    await runItotoriCliCommand(
      ["patch", "play", "patch-v1", "--launch-json", '{"surface":"cli"}', "--output", "play.json"],
      dependencies,
    );

    expect(service.list).toHaveBeenCalledWith({ localeBranchId: "branch-fr" });
    expect(service.load).toHaveBeenCalledWith({ patchVersionId: "patch-v1" });
    expect(service.play).toHaveBeenCalledWith({
      patchVersionId: "patch-v1",
      launchDescriptor: { surface: "cli" },
    });
    expect(loadExactPatchExport).toHaveBeenCalledWith({ patchVersionId: "patch-v1" });
    expect(writes.get("versions.json")).toEqual([
      expect.objectContaining({ patchVersionId: "patch-v1" }),
    ]);
    expect(JSON.stringify(writes.get("versions.json"))).not.toContain("artifactRefs");
    expect(writes.get("play.json")).toEqual(
      expect.objectContaining({
        surface: expect.objectContaining({
          patch: expect.objectContaining({ patchVersionId: "patch-v1" }),
        }),
        session: expect.objectContaining({ playSessionId: "session-1" }),
        delivery: expect.objectContaining({
          patchVersionId: "patch-v1",
          artifactHashes: { patch: "sha256:fixture" },
        }),
      }),
    );
    expect(JSON.stringify(writes.get("play.json"))).not.toContain("artifactRefs");
  });

  it("persists batch and individual/comment feedback against the exact observed version", async () => {
    const service = patchIterationFixture();
    const { dependencies, writes } = cliFixture(service.port);

    await runItotoriCliCommand(
      [
        "feedback",
        "batch",
        "--patch-version",
        "patch-v1",
        "--batch-id",
        "batch-1",
        "--label",
        "Route notes",
        "--output",
        "batch.json",
      ],
      dependencies,
    );
    await runItotoriCliCommand(
      [
        "feedback",
        "add",
        "--patch-version",
        "patch-v1",
        "--batch",
        "batch-1",
        "--play-session",
        "session-1",
        "--kind",
        "comment",
        "--body",
        "This line reads too formal in the route.",
        "--metadata-json",
        '{"route":"a"}',
        "--affected-unit",
        "unit-1",
        "--affected-unit",
        "unit-2",
        "--output",
        "feedback.json",
      ],
      dependencies,
    );

    expect(service.createFeedbackBatch).toHaveBeenCalledWith({
      observedPatchVersionId: "patch-v1",
      feedbackBatchId: "batch-1",
      label: "Route notes",
    });
    expect(service.feedback).toHaveBeenCalledWith({
      observedPatchVersionId: "patch-v1",
      feedbackBatchId: "batch-1",
      playSessionId: "session-1",
      eventKind: "comment",
      body: "This line reads too formal in the route.",
      metadata: { route: "a" },
      affectedBridgeUnitIds: ["unit-1", "unit-2"],
    });
    expect(writes.get("batch.json")).toEqual(
      expect.objectContaining({ feedbackBatchId: "batch-1" }),
    );
    expect(writes.get("feedback.json")).toEqual(
      expect.objectContaining({ feedbackEventId: "event-1" }),
    );
  });

  it("routes target-first result-edit feedback and the feedback inbox to the same service", async () => {
    const service = patchIterationFixture();
    const { dependencies, writes } = cliFixture(service.port);

    await runItotoriCliCommand(
      [
        "feedback",
        "add",
        "--observed-patch-version",
        "patch-v1",
        "--kind",
        "result_edit",
        "--target-body",
        "A more natural target line.",
        "--affected-unit",
        "unit-1",
        "--output",
        "result-edit.json",
      ],
      dependencies,
    );
    await runItotoriCliCommand(
      ["feedback", "list", "--patch-version", "patch-v1", "--output", "inbox.json"],
      dependencies,
    );

    expect(service.feedback).toHaveBeenCalledWith({
      observedPatchVersionId: "patch-v1",
      eventKind: "result_edit",
      targetBody: "A more natural target line.",
      affectedBridgeUnitIds: ["unit-1"],
    });
    expect(service.load).toHaveBeenCalledWith({ patchVersionId: "patch-v1" });
    expect(writes.get("inbox.json")).toEqual({
      observedPatchVersionId: "patch-v1",
      batches: [],
    });
  });

  it("writes added-context and wiki-edit feedback through the canonical context mutation payload", async () => {
    const service = patchIterationFixture();
    const { dependencies } = cliFixture(service.port);

    await runItotoriCliCommand(
      [
        "feedback",
        "add",
        "--patch-version",
        "patch-v1",
        "--kind",
        "added_context",
        "--context-operation",
        "add",
        "--context-kind",
        "glossary",
        "--context-title",
        "Garden terminology",
        "--context-body",
        "Keep the route's botanical terms consistent.",
        "--context-reason",
        "The play tester noticed inconsistent terminology.",
        "--affected-unit",
        "unit-1",
      ],
      dependencies,
    );
    await runItotoriCliCommand(
      [
        "feedback",
        "add",
        "--patch-version",
        "patch-v1",
        "--kind",
        "wiki_edit",
        "--context-operation",
        "edit",
        "--context-artifact",
        "wiki-route-terms",
        "--context-title",
        "Route terminology",
        "--context-body",
        "Use the established route terminology.",
        "--context-reason",
        "The tester corrected the existing guidance.",
        "--affected-unit",
        "unit-2",
      ],
      dependencies,
    );

    expect(service.feedback).toHaveBeenNthCalledWith(1, {
      observedPatchVersionId: "patch-v1",
      eventKind: "added_context",
      contextFeedback: {
        operation: "add",
        kind: "glossary",
        title: "Garden terminology",
        body: "Keep the route's botanical terms consistent.",
        reason: "The play tester noticed inconsistent terminology.",
        affectedBridgeUnitIds: ["unit-1"],
      },
    });
    expect(service.feedback).toHaveBeenNthCalledWith(2, {
      observedPatchVersionId: "patch-v1",
      eventKind: "wiki_edit",
      contextFeedback: {
        operation: "edit",
        contextArtifactId: "wiki-route-terms",
        title: "Route terminology",
        body: "Use the established route terminology.",
        reason: "The tester corrected the existing guidance.",
        affectedBridgeUnitIds: ["unit-2"],
      },
    });
  });

  it("keeps artifact/version feedback reference-only when no context mutation is requested", async () => {
    const service = patchIterationFixture();
    const { dependencies } = cliFixture(service.port);

    await runItotoriCliCommand(
      [
        "feedback",
        "add",
        "--patch-version",
        "patch-v1",
        "--kind",
        "wiki_edit",
        "--context-artifact",
        "wiki-route-terms",
        "--context-entry-version",
        "wiki-route-terms-v4",
        "--affected-unit",
        "unit-2",
      ],
      dependencies,
    );

    expect(service.feedback).toHaveBeenCalledWith({
      observedPatchVersionId: "patch-v1",
      eventKind: "wiki_edit",
      contextArtifactId: "wiki-route-terms",
      contextEntryVersionId: "wiki-route-terms-v4",
      affectedBridgeUnitIds: ["unit-2"],
    });
  });

  it("rejects ambiguous direct context feedback before reaching the service", async () => {
    const service = patchIterationFixture();
    const { dependencies } = cliFixture(service.port);

    await expect(
      runItotoriCliCommand(
        [
          "feedback",
          "add",
          "--patch-version",
          "patch-v1",
          "--kind",
          "added_context",
          "--context-body",
          "Missing operation.",
        ],
        dependencies,
      ),
    ).rejects.toThrow(/requires --context-operation/u);
    await expect(
      runItotoriCliCommand(
        [
          "feedback",
          "add",
          "--patch-version",
          "patch-v1",
          "--kind",
          "added_context",
          "--context-operation",
          "edit",
          "--context-artifact",
          "wiki-route-terms",
          "--context-body",
          "Wrong operation.",
          "--context-reason",
          "Test.",
        ],
        dependencies,
      ),
    ).rejects.toThrow(/requires --kind wiki_edit/u);
    expect(service.feedback).not.toHaveBeenCalled();
  });

  it("freezes selected batches/events, scoped units, target overrides, and wiki heads for refine", async () => {
    const service = patchIterationFixture();
    const { dependencies, writes } = cliFixture(service.port);

    await runItotoriCliCommand(
      [
        "refine",
        "--base-patch-version",
        "patch-v1",
        "--batch",
        "batch-1",
        "--event",
        "individual-event-1",
        "--unit",
        "unit-1",
        "--unit",
        "unit-2",
        "--target-bodies-json",
        '{"unit-2":"Broadened route target."}',
        "--wiki-heads-json",
        '[{"contextArtifactId":"wiki-route","contextEntryVersionId":"wiki-version-2"}]',
        "--output",
        "refinement.json",
      ],
      dependencies,
    );

    expect(service.refine).toHaveBeenCalledWith({
      basePatchVersionId: "patch-v1",
      feedbackBatchIds: ["batch-1"],
      feedbackEventIds: ["individual-event-1"],
      scopeUnitIds: ["unit-1", "unit-2"],
      targetBodiesByUnit: { "unit-2": "Broadened route target." },
      wikiHeads: [
        {
          contextArtifactId: "wiki-route",
          contextEntryVersionId: "wiki-version-2",
        },
      ],
    });
    expect(writes.get("refinement.json")).toEqual(
      expect.objectContaining({ patch: expect.objectContaining({ patchVersionId: "patch-v2" }) }),
    );
    expect(JSON.stringify(writes.get("refinement.json"))).not.toContain("artifactRefs");
  });

  it("rejects unsupported feedback kinds and a missing iteration service", async () => {
    const service = patchIterationFixture();
    const { dependencies } = cliFixture(service.port);
    await expect(
      runItotoriCliCommand(
        ["feedback", "add", "--patch-version", "patch-v1", "--kind", "runtime_observation"],
        dependencies,
      ),
    ).rejects.toThrow(/--kind must be one of/u);

    const withoutIteration: ItotoriCliDependencies = {
      io: { readJson: vi.fn(), writeJson: vi.fn() },
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback({} as ItotoriCliServices),
    };
    await expect(
      runItotoriCliCommand(["patch", "versions", "--locale", "branch-fr"], withoutIteration),
    ).rejects.toThrow(/patch-iteration service is not configured/u);
  });
});
