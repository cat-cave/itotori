import { describe, expect, it } from "vitest";

import {
  runLocalizationWorkflow,
  type LaneVerdict,
  type WorkflowPorts,
} from "../src/workflow/index.js";
import { buildPorts, FakeStore, newRecorder, PRODUCTION, scene } from "./workflow.support.js";

class InterruptAfterQ5MemoStore extends FakeStore {
  #interruptQ5Finalize = true;

  constructor(private readonly events: string[]) {
    super();
  }

  override async finalizeUnit(input: Parameters<FakeStore["finalizeUnit"]>[0]) {
    if (input.stage === "build-lqa") {
      this.events.push("finalize");
      if (this.#interruptQ5Finalize) {
        this.#interruptQ5Finalize = false;
        throw new Error("simulated interruption after Q5 memo persistence");
      }
    }
    return await super.finalizeUnit(input);
  }
}

describe("workflow Q5 memo recovery", () => {
  it("hydrates Q5 evidence from a memo hit before sealing the build-lqa head", async () => {
    const events: string[] = [];
    const store = new InterruptAfterQ5MemoStore(events);
    const recorder = newRecorder();
    const basePorts = buildPorts(store, recorder);
    const hydrateCalls: {
      patchId: string;
      unitIds: readonly string[];
      reviewIds: readonly string[];
    }[] = [];
    const ports: WorkflowPorts = {
      ...basePorts,
      patchback: {
        ...basePorts.patchback,
        async hydrateBuildLqaEvidence(input: {
          readonly patchId: string;
          readonly unitIds: readonly string[];
          readonly verdicts: readonly LaneVerdict[];
        }): Promise<void> {
          events.push("hydrate");
          hydrateCalls.push({
            patchId: input.patchId,
            unitIds: input.unitIds,
            reviewIds: input.verdicts.map((verdict) => verdict.verdict.reviewId),
          });
        },
      },
    };
    const scenes = [scene("s1", ["u1"])];

    await expect(runLocalizationWorkflow(PRODUCTION, scenes, ports)).rejects.toThrow(
      "simulated interruption after Q5 memo persistence",
    );
    expect(recorder.buildLqaCalls).toHaveLength(1);
    expect(store.completed.size).toBeGreaterThan(0);

    events.length = 0;
    hydrateCalls.length = 0;

    const report = await runLocalizationWorkflow(PRODUCTION, scenes, ports);

    expect(recorder.buildLqaCalls).toHaveLength(1);
    expect(events).toEqual(["hydrate", "finalize"]);
    expect(hydrateCalls).toEqual([
      {
        patchId: "patch.1",
        unitIds: ["u1"],
        reviewIds: ["review.Q5.u1"],
      },
    ]);
    expect(await store.readUnitHead("u1", "build-lqa")).not.toBeNull();
    expect(report.buildLqa).toHaveLength(1);
  });
});
