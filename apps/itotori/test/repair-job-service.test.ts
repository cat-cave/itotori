// ITOTORI-038 — Repair-job service tests.
//
// Exercises every rule the spec's acceptance criteria + audit-focus
// items pin down:
//   - P0/P1 QA findings produce targeted repair jobs (narrow scope,
//     correct pipeline stage, pinned pair recorded verbatim).
//   - Protected-span violations enqueue translation reruns.
//   - Human decisions can rerun a narrow set of bridge units OR the
//     scene OR the whole project — the selector NEVER widens past
//     what the human declared.
//   - Repair history is auditable: every state transition (enqueue,
//     start, complete, drop) appears in `repairHistory()` with a
//     stable order.
//   - Below-minimum severity (e.g. p2 when minimum is p1) is rejected
//     so noisy findings cannot consume repair budget.
//   - Missing (modelId, providerId) pair is rejected at enqueue.
//   - Priority order: p0 drains before p1 before p2; ties broken by
//     enqueue order.
//   - Fixture repair loop: a synthetic finding → repair-job →
//     orchestrator-mode "succeeded" outcome round-trips through the
//     full event log.

import { describe, expect, it } from "vitest";
import {
  AffectedWorkSelectorError,
  REPAIR_AFFECTED_SCOPES,
  REPAIR_JOB_OUTCOMES,
  REPAIR_JOB_SEVERITIES,
  REPAIR_JOB_TRIGGERS,
  REPAIR_PIPELINE_STAGES,
  RepairJobService,
  RepairJobServiceError,
  selectAffectedWork,
  type RepairAffectedScope,
  type RepairEvent,
  type RepairJob,
  type RepairJobOutcome,
  type RepairJobSeverity,
  type RepairJobTrigger,
  type RepairPipelineStage,
  type RepairProviderPair,
  type RepairTrigger,
  type RepairSceneIndex,
} from "../src/orchestrator/repair/index.js";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const BRIDGE_UNIT_A = "019ed079-0000-7000-8000-00000000aa01";
const BRIDGE_UNIT_B = "019ed079-0000-7000-8000-00000000aa02";
const BRIDGE_UNIT_C = "019ed079-0000-7000-8000-00000000aa03";

const PAIR: RepairProviderPair = {
  modelId: "openai/gpt-5",
  providerId: "openrouter:openai",
};

function deterministicClock(): () => Date {
  let tick = 0;
  return () => {
    const date = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
    date.setUTCSeconds(tick);
    tick += 1;
    return date;
  };
}

function qaTrigger(
  overrides: Partial<{
    findingId: string;
    bridgeUnitId: string;
    severity: RepairJobSeverity;
    targetStage: RepairPipelineStage;
    rationale: string;
  }> = {},
): RepairTrigger {
  return {
    trigger: "qa_finding",
    findingId: overrides.findingId ?? "019ed079-0000-7000-8000-00000000ff01",
    bridgeUnitId: overrides.bridgeUnitId ?? BRIDGE_UNIT_A,
    severity: overrides.severity ?? "p1",
    targetStage: overrides.targetStage ?? "translation",
    rationale: overrides.rationale ?? "mistranslation: term diverged from glossary",
  };
}

function spanTrigger(
  overrides: Partial<{
    violationId: string;
    bridgeUnitId: string;
    severity: RepairJobSeverity;
    rationale: string;
  }> = {},
): RepairTrigger {
  return {
    trigger: "protected_span_violation",
    violationId: overrides.violationId ?? "span-violation-001",
    bridgeUnitId: overrides.bridgeUnitId ?? BRIDGE_UNIT_A,
    severity: overrides.severity ?? "p0",
    rationale: overrides.rationale ?? "span_deleted on glossary term",
  };
}

function humanTrigger(
  args:
    | {
        scope: RepairTrigger extends { trigger: "human_decision" } ? never : never;
      }
    | {
        scope:
          | { kind: "bridge_units"; bridgeUnitIds: ReadonlyArray<string> }
          | { kind: "scene"; sceneId: string; bridgeUnitIds: ReadonlyArray<string> }
          | { kind: "project" };
        severity?: RepairJobSeverity;
        targetStage?: RepairPipelineStage;
        decisionId?: string;
        rationale?: string;
      },
): RepairTrigger {
  if ("scope" in args) {
    return {
      trigger: "human_decision",
      decisionId: args.decisionId ?? "human-decision-001",
      decisionRecordedAt: new Date("2026-06-24T12:00:00Z"),
      scope: args.scope,
      severity: args.severity ?? "p1",
      targetStage: args.targetStage ?? "translation",
      rationale: args.rationale ?? "reviewer rejected primary draft",
    };
  }
  throw new Error("humanTrigger requires a scope");
}

function makeService(
  opts: {
    sceneIndex?: RepairSceneIndex;
    minimumSeverity?: RepairJobSeverity;
  } = {},
): RepairJobService {
  return new RepairJobService({
    now: deterministicClock(),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Closed-enum exhaustiveness
// ---------------------------------------------------------------------------

describe("ITOTORI-038 closed enums", () => {
  it("REPAIR_JOB_TRIGGERS covers every union variant", () => {
    const expected: ReadonlyArray<RepairJobTrigger> = [
      "qa_finding",
      "protected_span_violation",
      "human_decision",
    ];
    expect([...REPAIR_JOB_TRIGGERS].sort()).toEqual([...expected].sort());
  });

  it("REPAIR_AFFECTED_SCOPES enumerates every scope", () => {
    const expected: ReadonlyArray<RepairAffectedScope> = ["bridge_units", "scene", "project"];
    expect([...REPAIR_AFFECTED_SCOPES].sort()).toEqual([...expected].sort());
  });

  it("REPAIR_JOB_OUTCOMES enumerates every terminal outcome", () => {
    const expected: ReadonlyArray<RepairJobOutcome> = [
      "succeeded",
      "deferred_to_human",
      "cap_exhausted",
      "no_change",
    ];
    expect([...REPAIR_JOB_OUTCOMES].sort()).toEqual([...expected].sort());
  });

  it("REPAIR_JOB_SEVERITIES enumerates every severity", () => {
    const expected: ReadonlyArray<RepairJobSeverity> = ["p0", "p1", "p2"];
    expect([...REPAIR_JOB_SEVERITIES].sort()).toEqual([...expected].sort());
  });

  it("REPAIR_PIPELINE_STAGES names every reruneable stage", () => {
    const expected: ReadonlyArray<RepairPipelineStage> = [
      "context",
      "pre_translation",
      "translation",
      "qa_findings",
    ];
    expect([...REPAIR_PIPELINE_STAGES].sort()).toEqual([...expected].sort());
  });
});

// ---------------------------------------------------------------------------
// Affected-work selector
// ---------------------------------------------------------------------------

describe("selectAffectedWork", () => {
  it("QA finding narrows to the named bridge unit + target stage", () => {
    const selection = selectAffectedWork(
      qaTrigger({ bridgeUnitId: BRIDGE_UNIT_A, targetStage: "context" }),
    );
    expect(selection.affectedScope).toBe("bridge_units");
    expect(selection.affectedBridgeUnitIds).toEqual([BRIDGE_UNIT_A]);
    expect(selection.pipelineStage).toBe("context");
  });

  it("protected-span violation always targets translation on one unit", () => {
    const selection = selectAffectedWork(spanTrigger({ bridgeUnitId: BRIDGE_UNIT_B }));
    expect(selection.pipelineStage).toBe("translation");
    expect(selection.affectedBridgeUnitIds).toEqual([BRIDGE_UNIT_B]);
  });

  it("human decision: explicit bridge unit list is honored verbatim + deduped", () => {
    const selection = selectAffectedWork(
      humanTrigger({
        scope: {
          kind: "bridge_units",
          bridgeUnitIds: [BRIDGE_UNIT_A, BRIDGE_UNIT_B, BRIDGE_UNIT_A],
        },
      }),
    );
    expect(selection.affectedScope).toBe("bridge_units");
    expect(selection.affectedBridgeUnitIds).toEqual([BRIDGE_UNIT_A, BRIDGE_UNIT_B]);
  });

  it("human decision: project scope only reachable via explicit human opt-in", () => {
    const selection = selectAffectedWork(humanTrigger({ scope: { kind: "project" } }));
    expect(selection.affectedScope).toBe("project");
    expect(selection.affectedBridgeUnitIds).toEqual([]);
  });

  it("human decision: scene scope expands via the SceneIndex", () => {
    const sceneIndex: RepairSceneIndex = {
      bridgeUnitsInSceneOf: (seed) =>
        seed === BRIDGE_UNIT_A ? [BRIDGE_UNIT_A, BRIDGE_UNIT_B, BRIDGE_UNIT_C] : [],
    };
    const selection = selectAffectedWork(
      humanTrigger({
        scope: { kind: "scene", sceneId: "scene-001", bridgeUnitIds: [BRIDGE_UNIT_A] },
      }),
      sceneIndex,
    );
    expect(selection.affectedScope).toBe("scene");
    expect(selection.affectedBridgeUnitIds).toEqual([BRIDGE_UNIT_A, BRIDGE_UNIT_B, BRIDGE_UNIT_C]);
  });

  it("empty human bridge_units scope is rejected", () => {
    expect(() =>
      selectAffectedWork(humanTrigger({ scope: { kind: "bridge_units", bridgeUnitIds: [] } })),
    ).toThrowError(AffectedWorkSelectorError);
  });

  it("scene scope without a SceneIndex falls back to the declared seeds", () => {
    const selection = selectAffectedWork(
      humanTrigger({
        scope: { kind: "scene", sceneId: "scene-001", bridgeUnitIds: [BRIDGE_UNIT_A] },
      }),
    );
    expect(selection.affectedBridgeUnitIds).toEqual([BRIDGE_UNIT_A]);
  });
});

// ---------------------------------------------------------------------------
// Service: enqueue + history
// ---------------------------------------------------------------------------

describe("RepairJobService.enqueue", () => {
  it("emits a typed RepairJob with the pinned pair recorded verbatim", () => {
    const service = makeService();
    const job = service.enqueue({ trigger: qaTrigger({ severity: "p1" }), pair: PAIR });
    expect(job.pair).toEqual(PAIR);
    expect(job.affectedBridgeUnitIds).toEqual([BRIDGE_UNIT_A]);
    expect(job.affectedScope).toBe("bridge_units");
    expect(job.pipelineStage).toBe("translation");
    expect(job.severity).toBe("p1");
    expect(job.priority).toBe(1);
    expect(job.rationale).toContain("QA finding");
  });

  it("refuses an empty pair (no defaulting at the orchestrator boundary)", () => {
    const service = makeService();
    expect(() =>
      service.enqueue({ trigger: qaTrigger(), pair: { modelId: "", providerId: "x" } }),
    ).toThrowError(RepairJobServiceError);
    expect(() =>
      service.enqueue({ trigger: qaTrigger(), pair: { modelId: "x", providerId: "" } }),
    ).toThrowError(RepairJobServiceError);
  });

  it("refuses severities below the configured minimum (default = p1)", () => {
    const service = makeService();
    expect(() =>
      service.enqueue({ trigger: qaTrigger({ severity: "p2" }), pair: PAIR }),
    ).toThrowError(RepairJobServiceError);
  });

  it("accepts p2 when minimumSeverity is widened explicitly", () => {
    const service = makeService({ minimumSeverity: "p2" });
    const job = service.enqueue({
      trigger: qaTrigger({ severity: "p2" }),
      pair: PAIR,
    });
    expect(job.priority).toBe(2);
  });

  it("records a job_enqueued event on history with the full job snapshot", () => {
    const service = makeService();
    const job = service.enqueue({ trigger: qaTrigger(), pair: PAIR });
    const history = service.repairHistory();
    expect(history).toHaveLength(1);
    const first = history[0];
    if (first?.kind !== "job_enqueued") {
      throw new Error("expected job_enqueued event");
    }
    expect(first.jobId).toBe(job.jobId);
    expect(first.job).toEqual(job);
  });

  it("mints stable job ids deterministic in trigger + counter", () => {
    const a = makeService();
    const b = makeService();
    const ja = a.enqueue({ trigger: qaTrigger(), pair: PAIR });
    const jb = b.enqueue({ trigger: qaTrigger(), pair: PAIR });
    expect(ja.jobId).toEqual(jb.jobId);
  });

  it("scene-scoped human decision without a sceneIndex throws a typed error", () => {
    const service = makeService();
    expect(() =>
      service.enqueue({
        trigger: humanTrigger({
          scope: { kind: "scene", sceneId: "scene-001", bridgeUnitIds: [BRIDGE_UNIT_A] },
        }),
        pair: PAIR,
      }),
    ).toThrowError(RepairJobServiceError);
  });
});

// ---------------------------------------------------------------------------
// Service: priority queue
// ---------------------------------------------------------------------------

describe("RepairJobService priority ordering", () => {
  it("p0 drains before p1; ties broken by enqueue order", () => {
    const service = makeService();
    const p1A = service.enqueue({
      trigger: qaTrigger({ findingId: "p1-a", severity: "p1" }),
      pair: PAIR,
    });
    const p1B = service.enqueue({
      trigger: qaTrigger({ findingId: "p1-b", severity: "p1", bridgeUnitId: BRIDGE_UNIT_B }),
      pair: PAIR,
    });
    const p0 = service.enqueue({
      trigger: qaTrigger({ findingId: "p0", severity: "p0", bridgeUnitId: BRIDGE_UNIT_C }),
      pair: PAIR,
    });
    const claimedOrder: string[] = [];
    while (true) {
      const next = service.claimNext();
      if (next === undefined) break;
      claimedOrder.push(next.jobId);
    }
    expect(claimedOrder).toEqual([p0.jobId, p1A.jobId, p1B.jobId]);
  });
});

// ---------------------------------------------------------------------------
// Service: outcome + drop + audit history
// ---------------------------------------------------------------------------

describe("RepairJobService outcome flow", () => {
  it("records start + completion events with terminal outcomes", () => {
    const service = makeService();
    const job = service.enqueue({ trigger: qaTrigger(), pair: PAIR });
    const claimed = service.claimNext();
    expect(claimed?.jobId).toBe(job.jobId);
    service.recordOutcome(job.jobId, "succeeded");
    expect(service.outcomeOf(job.jobId)).toBe("succeeded");
    const kinds: ReadonlyArray<RepairEvent["kind"]> = service
      .repairHistory()
      .map((event) => event.kind);
    expect(kinds).toEqual(["job_enqueued", "job_started", "job_completed"]);
  });

  it("drop() removes a queued job and records the reason on history", () => {
    const service = makeService();
    const job = service.enqueue({ trigger: qaTrigger(), pair: PAIR });
    service.drop(job.jobId, "human decision rescinded");
    expect(service.pending()).toEqual([]);
    const last = service.repairHistory().at(-1);
    if (last?.kind !== "job_dropped") {
      throw new Error("expected job_dropped event");
    }
    expect(last.reason).toBe("human decision rescinded");
  });

  it("recordOutcome on an unclaimed jobId throws a typed error", () => {
    const service = makeService();
    let caught: unknown;
    try {
      service.recordOutcome("repair-job-unknown", "succeeded");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RepairJobServiceError);
    // The structured code must describe the actual problem (job not
    // in-flight), not be mis-tagged as 'missing_pair' — a caller
    // switching on err.code would otherwise mis-route the error.
    expect((caught as RepairJobServiceError).code).toBe("not_in_flight");
  });
});

// ---------------------------------------------------------------------------
// Fixture repair loop — end-to-end audit trail
// ---------------------------------------------------------------------------

describe("ITOTORI-038 fixture repair loop", () => {
  it("QA finding → repair job → completion preserves audit history end-to-end", () => {
    const sceneIndex: RepairSceneIndex = {
      bridgeUnitsInSceneOf: (seed) =>
        seed === BRIDGE_UNIT_A ? [BRIDGE_UNIT_A, BRIDGE_UNIT_B] : [],
    };
    const service = makeService({ sceneIndex });

    // Trigger 1: critical QA finding on bridge unit A.
    const qaJob = service.enqueue({
      trigger: qaTrigger({ severity: "p0", rationale: "glossary term swapped" }),
      pair: PAIR,
    });

    // Trigger 2: protected-span violation on a different unit.
    const spanJob = service.enqueue({
      trigger: spanTrigger({ bridgeUnitId: BRIDGE_UNIT_C, severity: "p0" }),
      pair: PAIR,
    });

    // Trigger 3: human reviewer requests scene-wide rerun seeded by unit A.
    const humanJob = service.enqueue({
      trigger: humanTrigger({
        scope: {
          kind: "scene",
          sceneId: "scene-001",
          bridgeUnitIds: [BRIDGE_UNIT_A],
        },
        severity: "p1",
        targetStage: "translation",
        rationale: "reviewer requested scene-wide refresh after style-guide update",
      }),
      pair: PAIR,
    });

    // Two p0 jobs go first in FIFO order; the human p1 lands last.
    const drained: RepairJob[] = [];
    while (true) {
      const next = service.claimNext();
      if (next === undefined) break;
      drained.push(next);
    }
    expect(drained.map((j) => j.jobId)).toEqual([qaJob.jobId, spanJob.jobId, humanJob.jobId]);
    expect(drained.map((j) => j.severity)).toEqual(["p0", "p0", "p1"]);

    // The human-scoped job expanded via the scene index without
    // widening past what the human declared.
    expect(humanJob.affectedScope).toBe("scene");
    expect(humanJob.affectedBridgeUnitIds).toEqual([BRIDGE_UNIT_A, BRIDGE_UNIT_B]);

    // The QA-trigger job stayed narrow at one bridge unit.
    expect(qaJob.affectedBridgeUnitIds).toEqual([BRIDGE_UNIT_A]);

    // Simulate the orchestrator's repair stage reporting outcomes:
    //   - QA job: repaired_then_accepted.
    //   - Span job: deferred_to_human (cap exhausted).
    //   - Human job: no_change (already-clean reruns are noop).
    service.recordOutcome(qaJob.jobId, "succeeded");
    service.recordOutcome(spanJob.jobId, "deferred_to_human");
    service.recordOutcome(humanJob.jobId, "no_change");

    const history = service.repairHistory();
    const kinds = history.map((e) => e.kind);
    expect(kinds).toEqual([
      "job_enqueued",
      "job_enqueued",
      "job_enqueued",
      "job_started",
      "job_started",
      "job_started",
      "job_completed",
      "job_completed",
      "job_completed",
    ]);
    const completions = history.flatMap<RepairEvent>((event) =>
      event.kind === "job_completed" ? [event] : [],
    );
    const outcomeMap = new Map<string, RepairJobOutcome>();
    for (const event of completions) {
      if (event.kind === "job_completed") {
        outcomeMap.set(event.jobId, event.outcome);
      }
    }
    expect(outcomeMap.get(qaJob.jobId)).toBe("succeeded");
    expect(outcomeMap.get(spanJob.jobId)).toBe("deferred_to_human");
    expect(outcomeMap.get(humanJob.jobId)).toBe("no_change");

    // Every job carries the pair verbatim — the audit can re-derive
    // (modelId, providerId) for every rerun without joining elsewhere.
    for (const job of drained) {
      expect(job.pair).toEqual(PAIR);
    }
  });

  it("parent/child chain: a rerun-spawning finding records parentJobId", () => {
    const service = makeService();
    const first = service.enqueue({
      trigger: qaTrigger({ findingId: "round-1", severity: "p1" }),
      pair: PAIR,
    });
    const claimed = service.claimNext();
    expect(claimed?.jobId).toBe(first.jobId);
    service.recordOutcome(first.jobId, "no_change");

    const followup = service.enqueue({
      trigger: qaTrigger({
        findingId: "round-2",
        severity: "p0",
        rationale: "post-repair finding",
      }),
      pair: PAIR,
      parentJobId: first.jobId,
    });
    expect(followup.parentJobId).toBe(first.jobId);
    expect(followup.severity).toBe("p0");
  });
});
