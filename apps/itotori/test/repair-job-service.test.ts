// ITOTORI-038 — Repair-job service tests.
//
// Exercises every rule the spec's acceptance criteria + audit-focus
// items pin down:
//   - P0/P1 QA findings produce targeted repair jobs (narrow scope,
//     correct pipeline stage, pinned pair recorded verbatim).
//   - Protected-span violations enqueue translation reruns.
//   - Repair triggers are machine-verifiable QA or protected-span findings
//     and always remain narrowed to their named bridge unit.
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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REPAIR_JOB_OUTCOMES,
  REPAIR_JOB_SEVERITIES,
  REPAIR_JOB_TRIGGERS,
  REPAIR_PIPELINE_STAGES,
  RepairJobService,
  RepairJobServiceError,
  selectAffectedWork,
  type RepairAffectedWork,
  type RepairEvent,
  type RepairJob,
  type RepairJobOutcome,
  type RepairJobSeverity,
  type RepairJobTrigger,
  type RepairPipelineStage,
  type RepairProviderPair,
  type RepairTrigger,
} from "../src/orchestrator/repair/index.js";

function unitsOf(work: RepairAffectedWork): readonly string[] {
  return work.affectedBridgeUnitIds;
}

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

function makeService(opts: { minimumSeverity?: RepairJobSeverity } = {}): RepairJobService {
  return new RepairJobService({
    now: deterministicClock(),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// On-disk fixture for the end-to-end repair-loop replay (ITOTORI-038).
//
// The trigger set the end-to-end audit-trail test replays lives at
// fixtures/repair-loop/fixture.json — an on-disk deliverable, not an
// inline literal — so downstream nodes (e.g. ITOTORI-222's repair stage)
// can replay the exact QA and protected-span trigger set
// off disk without re-instantiating RepairJobService.
// ---------------------------------------------------------------------------

type RepairLoopFixtureEntry = {
  name: string;
  trigger: RepairTrigger;
  expectedUnits?: ReadonlyArray<string>;
  outcome: RepairJobOutcome;
};

type RepairLoopFixture = {
  pair: RepairProviderPair;
  triggers: ReadonlyArray<RepairLoopFixtureEntry>;
  expectedDrainOrder: ReadonlyArray<string>;
  expectedSeverityOrder: ReadonlyArray<RepairJobSeverity>;
};

function loadRepairLoopFixture(): RepairLoopFixture {
  const fixture = JSON.parse(
    readFileSync(new URL("../../../fixtures/repair-loop/fixture.json", import.meta.url), "utf8"),
  ) as RepairLoopFixture;
  return fixture;
}

// ---------------------------------------------------------------------------
// Closed-enum exhaustiveness
// ---------------------------------------------------------------------------

describe("ITOTORI-038 closed enums", () => {
  it("REPAIR_JOB_TRIGGERS covers every union variant", () => {
    const expected: ReadonlyArray<RepairJobTrigger> = ["qa_finding", "protected_span_violation"];
    expect([...REPAIR_JOB_TRIGGERS].sort()).toEqual([...expected].sort());
  });

  it("REPAIR_JOB_OUTCOMES enumerates every terminal outcome", () => {
    const expected: ReadonlyArray<RepairJobOutcome> = ["succeeded", "partial_failure", "no_change"];
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
    expect(unitsOf(selection)).toEqual([BRIDGE_UNIT_A]);
    expect(selection.pipelineStage).toBe("context");
  });

  it("protected-span violation always targets translation on one unit", () => {
    const selection = selectAffectedWork(spanTrigger({ bridgeUnitId: BRIDGE_UNIT_B }));
    expect(selection.pipelineStage).toBe("translation");
    expect(unitsOf(selection)).toEqual([BRIDGE_UNIT_B]);
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
    expect(unitsOf(job)).toEqual([BRIDGE_UNIT_A]);
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
    let caught: unknown;
    try {
      service.enqueue({ trigger: qaTrigger({ severity: "p2" }), pair: PAIR });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RepairJobServiceError);
    expect((caught as RepairJobServiceError).code).toBe("below_minimum_severity");
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

  it("repairHistory() and the enqueue() return value are defensive copies of internal history", () => {
    const service = makeService();
    const job = service.enqueue({ trigger: qaTrigger(), pair: PAIR });

    // Mutate the job object returned by enqueue(). The cast bypasses the
    // readonly types deliberately: the append-only guarantee must hold at
    // runtime, not merely via the type system.
    (job as { jobId: string }).jobId = "MUTATED-RETURN";
    (job as { severity: string }).severity = "p2";

    // Mutate an event (and its embedded job) handed back by repairHistory().
    const snapshot = service.repairHistory();
    const enq = snapshot[0];
    if (enq?.kind !== "job_enqueued") {
      throw new Error("expected job_enqueued event");
    }
    (enq as { jobId: string }).jobId = "MUTATED-SNAPSHOT";
    (enq.job as { jobId: string }).jobId = "MUTATED-SNAPSHOT-JOB";
    (enq.job as { severity: string }).severity = "p2";

    // Neither mutation reached the service's internal append-only history.
    const fresh = service.repairHistory();
    const freshEnq = fresh[0];
    if (freshEnq?.kind !== "job_enqueued") {
      throw new Error("expected job_enqueued event");
    }
    expect(freshEnq.jobId).not.toBe("MUTATED-RETURN");
    expect(freshEnq.jobId).not.toBe("MUTATED-SNAPSHOT");
    expect(freshEnq.job.jobId).not.toBe("MUTATED-RETURN");
    expect(freshEnq.job.jobId).not.toBe("MUTATED-SNAPSHOT-JOB");
    expect(freshEnq.job.severity).toBe("p1");
  });

  it("mints byte-equal job ids across a replay seeded with a fixed instanceId", () => {
    // Replay determinism: two services constructed with the SAME instanceId
    // mint identical jobIds for the same trigger at the same counter slot.
    const replayA = new RepairJobService({
      now: deterministicClock(),
      instanceId: "fixed-instance",
    });
    const replayB = new RepairJobService({
      now: deterministicClock(),
      instanceId: "fixed-instance",
    });
    const ja = replayA.enqueue({ trigger: qaTrigger(), pair: PAIR });
    const jb = replayB.enqueue({ trigger: qaTrigger(), pair: PAIR });
    expect(ja.jobId).toEqual(jb.jobId);
  });

  it("mints colliding-free job ids across distinct service instances", () => {
    // Two DISTINCT instances (each gets a fresh random instanceId by
    // default) must NOT mint the same jobId for the same trigger at the
    // same counter slot — otherwise a caller merging their histories sees
    // jobId collisions.
    const a = makeService();
    const b = makeService();
    const ja = a.enqueue({ trigger: qaTrigger(), pair: PAIR });
    const jb = b.enqueue({ trigger: qaTrigger(), pair: PAIR });
    expect(ja.jobId).not.toEqual(jb.jobId);
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
    service.drop(job.jobId, "finding superseded by a later QA pass");
    expect(service.pending()).toEqual([]);
    const last = service.repairHistory().at(-1);
    if (last?.kind !== "job_dropped") {
      throw new Error("expected job_dropped event");
    }
    expect(last.reason).toBe("finding superseded by a later QA pass");
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

  it("drop() on an unknown jobId throws a typed error and records no history", () => {
    const service = makeService();
    let caught: unknown;
    try {
      service.drop("repair-job-typo", "finding superseded by a later QA pass");
    } catch (err) {
      caught = err;
    }
    // A typo'd/stale jobId must produce an observable outcome — never a
    // silent return that swallows the operation with no audit record.
    expect(caught).toBeInstanceOf(RepairJobServiceError);
    expect((caught as RepairJobServiceError).code).toBe("unknown_job_id");
    // No spurious job_dropped event for a jobId that never existed.
    expect(service.repairHistory()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixture repair loop — end-to-end audit trail
// ---------------------------------------------------------------------------

describe("ITOTORI-038 fixture repair loop", () => {
  it("QA finding → repair job → completion preserves audit history end-to-end", () => {
    const fixture = loadRepairLoopFixture();
    const service = makeService();

    // Enqueue the on-disk trigger set in fixture order: a critical QA
    // finding on unit A and a protected-span violation on a different unit.
    const jobsByName = new Map<string, RepairJob>();
    for (const entry of fixture.triggers) {
      jobsByName.set(entry.name, service.enqueue({ trigger: entry.trigger, pair: fixture.pair }));
    }
    const jobFor = (name: string): RepairJob => {
      const job = jobsByName.get(name);
      if (job === undefined) {
        throw new Error(`fixture names unknown trigger ${name}`);
      }
      return job;
    };

    // The p0 job drains before the p1 job.
    const drained: RepairJob[] = [];
    while (true) {
      const next = service.claimNext();
      if (next === undefined) break;
      drained.push(next);
    }
    expect(drained.map((j) => j.jobId)).toEqual(
      fixture.expectedDrainOrder.map((name) => jobFor(name).jobId),
    );
    expect(drained.map((j) => j.severity)).toEqual([...fixture.expectedSeverityOrder]);

    // Every machine-verifiable trigger remains narrowed to its named unit.
    for (const entry of fixture.triggers) {
      const job = jobFor(entry.name);
      expect(job.affectedScope).toBe("bridge_units");
      if (entry.expectedUnits !== undefined) {
        expect(unitsOf(job)).toEqual([...entry.expectedUnits]);
      }
    }

    // Replay the orchestrator's repair-stage outcomes from the fixture:
    //   - QA job: succeeded (written body persisted).
    //   - Span job: succeeded (quality concern remains an annotation, not a hold).
    for (const entry of fixture.triggers) {
      service.recordOutcome(jobFor(entry.name).jobId, entry.outcome);
    }

    const history = service.repairHistory();
    const kinds = history.map((e) => e.kind);
    expect(kinds).toEqual([
      ...fixture.triggers.map(() => "job_enqueued" as const),
      ...fixture.triggers.map(() => "job_started" as const),
      ...fixture.triggers.map(() => "job_completed" as const),
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
    for (const entry of fixture.triggers) {
      expect(outcomeMap.get(jobFor(entry.name).jobId)).toBe(entry.outcome);
    }

    // Every job carries the pair verbatim — the audit can re-derive
    // (modelId, providerId) for every rerun without joining elsewhere.
    for (const job of drained) {
      expect(job.pair).toEqual(fixture.pair);
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

  it("rejects a parentJobId that references no job this service ever minted", () => {
    const service = makeService();
    let caught: unknown;
    try {
      service.enqueue({
        trigger: qaTrigger({ findingId: "round-2", severity: "p0" }),
        pair: PAIR,
        // A typo'd / stale parent id: nothing was enqueued before this
        // call, so the chain would dangle if accepted verbatim.
        parentJobId: "repair-job-typo",
      });
    } catch (err) {
      caught = err;
    }
    // The dangling parent must be observable — never silently copied
    // onto the job where it breaks repair-tree provenance.
    expect(caught).toBeInstanceOf(RepairJobServiceError);
    expect((caught as RepairJobServiceError).code).toBe("unknown_parent_job_id");
    // No job was queued and no history event was recorded for the
    // refused enqueue.
    expect(service.pending()).toEqual([]);
    expect(service.repairHistory()).toEqual([]);
  });
});
