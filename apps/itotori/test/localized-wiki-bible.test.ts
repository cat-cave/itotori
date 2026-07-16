// Per-target localized-Wiki (bible) orchestration — mutation-falsifiable proofs.
//
// The deterministic control flow that turns the source-language Wiki into the
// mandatory per-target bible BEFORE any production line. The localizer runner and
// the reviewer are best-effort recorded doubles; every proof targets a control-
// flow guarantee (clauses 1-5) and FAILS if that guarantee is removed.

import { describe, expect, it } from "vitest";

import { LocalizedRenderingSchema } from "../src/contracts/index.js";
import {
  BibleBypassError,
  BibleOrderingError,
  DECISION_RUBRICS,
  InMemoryBibleRenderingLedger,
  assertDecisionTierFirst,
  bypassBibleForAblation,
  decisionClassOf,
  installCanonicalForms,
  localizerProfileRoles,
  mustBuildFullBible,
  orchestrateLocalizedWiki,
  planLocalizedWiki,
  reviewDecision,
  tierOf,
  type DecisionReviewer,
  type LocalizedWikiObserver,
  type LocalizerRunner,
  type RenderingStamp,
} from "../src/localized-wiki/index.js";
import { glossaryExactGate } from "../src/gates/index.js";
import { makeAccepted, makeSnapshot, makeUnit } from "./support/gate-fixtures.js";
import {
  GLOBAL,
  LOC_SNAP,
  RUN_MODE,
  TARGET_LANG,
  baseDeps,
  makeRendering,
  sourceWiki,
  stepShim,
  verdictOutput,
  type Verdict,
} from "./support/localized-wiki-fixtures.js";

// ── clause 1 ───────────────────────────────────────────────────────────────────
describe("clause 1 — the L-Term / L-Name decisions run FIRST", () => {
  it("PROOF: the plan orders the decision tier strictly before the descriptive tier", () => {
    const plan = planLocalizedWiki(sourceWiki(), TARGET_LANG, "production");
    expect(plan.phases.map((p) => p.tier)).toEqual(["decision", "descriptive"]);
    expect(plan.phases[0]!.level).toBeLessThan(plan.phases[1]!.level);
    // the decision phase holds exactly the two term-rulings (a name + a term).
    const classes = plan.phases[0]!.steps.map((s) => s.decisionClass).sort();
    expect(classes).toEqual(["L-Name", "L-Term"]);
    // a reordered plan is rejected loud — the ordering is enforced, not incidental.
    expect(() =>
      assertDecisionTierFirst([
        { level: 0, tier: "descriptive", steps: [] },
        { level: 1, tier: "decision", steps: [] },
      ]),
    ).toThrow(BibleOrderingError);
  });

  it("PROOF: every decision renders + installs BEFORE any descriptive rendering runs", async () => {
    const order: string[] = [];
    let formsAtSeal = -1;
    const runner: LocalizerRunner = async (input) => {
      order.push(`run:${input.tier}`);
      return [makeRendering(stepShim(input), input.stamp)];
    };
    const observer: LocalizedWikiObserver = {
      onDescriptivePhaseStart(installedForms) {
        order.push("SEAL");
        formsAtSeal = installedForms.length;
      },
    };
    await orchestrateLocalizedWiki(baseDeps({ runner, observer }));

    const seal = order.indexOf("SEAL");
    const lastDecision = order.lastIndexOf("run:decision");
    const firstDescriptive = order.indexOf("run:descriptive");
    expect(lastDecision).toBeGreaterThanOrEqual(0);
    expect(firstDescriptive).toBeGreaterThan(seal); // no descriptive before the seal
    expect(lastDecision).toBeLessThan(seal); // all decisions before the seal
    expect(formsAtSeal).toBe(2); // the canonical forms are installed at the seal
  });

  it("PROOF: tier + decision-class derivation is mechanical", () => {
    const [term, name, style] = sourceWiki();
    expect(tierOf(term!)).toBe("decision");
    expect(decisionClassOf(term!)).toBe("L-Term");
    expect(decisionClassOf(name!)).toBe("L-Name");
    expect(tierOf(style!)).toBe("descriptive");
    expect(decisionClassOf(style!)).toBeNull();
  });
});

// ── clause 2 ───────────────────────────────────────────────────────────────────
describe("clause 2 — renderings for names, terms, style, voice, arcs, cultural notes", () => {
  it("PROOF: a full run records a rendering for every bible category under the localizer posture", async () => {
    const ledger = new InMemoryBibleRenderingLedger();
    const report = await orchestrateLocalizedWiki(baseDeps({ ledger }));

    const kinds = new Set(ledger.recorded().map((r) => r.sourceObjectKind));
    for (const kind of [
      "term-ruling", // names + terms
      "style-contract", // style
      "voice-profile", // voice
      "scene-summary", // scene arc
      "route-arc", // route arc
      "character-route-arc", // character arc
      "adaptation-note", // cultural note
    ]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
    // both a NAME and a TERM decision were rendered + installed.
    const classes = report.decisions
      .filter((d) => d.validated)
      .map((d) => d.decisionClass)
      .sort();
    expect(classes).toEqual(["L-Name", "L-Term"]);
    // the pass runs under the localizer (write) profile.
    expect(report.localizerRoles.length).toBeGreaterThan(0);
    expect(localizerProfileRoles().every((s) => s.shape === "localizer")).toBe(true);
  });
});

// ── clause 3 ───────────────────────────────────────────────────────────────────
describe("clause 3 — a Q3/Q2-style reviewer gate validates the L-Term / L-Name decisions", () => {
  const stamp: RenderingStamp = {
    targetLanguage: TARGET_LANG,
    localizationSnapshotId: LOC_SNAP,
    runMode: RUN_MODE,
  };

  it("PROOF: each decision class is gated by the terminology (+voice) reviewers", () => {
    expect(DECISION_RUBRICS["L-Term"]).toEqual(["Q3"]);
    expect(DECISION_RUBRICS["L-Name"]).toEqual(["Q3", "Q2"]);
  });

  it("PROOF: only a clean PASS validates — a FAIL and a CANNOT_ASSESS never do", async () => {
    const term = sourceWiki()[0]!;
    const rendering = makeRendering(
      {
        stepId: "x",
        tier: "decision",
        decisionClass: "L-Term",
        sourceObject: term,
        target: {
          sourceObjectKind: "term-ruling",
          sourceObjectId: term.objectId,
          sourceObjectVersion: 1,
          scope: GLOBAL,
          targetLanguage: TARGET_LANG,
          key: "k",
        },
      },
      stamp,
    );
    const run =
      (v: Verdict, evidenceRequest?: string | null): DecisionReviewer =>
      async (i) =>
        verdictOutput(i.rendering.renderingId, v, evidenceRequest);
    const decide = (r: DecisionReviewer) =>
      reviewDecision({ decisionClass: "L-Term", sourceObject: term, rendering, stamp }, r);

    expect((await decide(run("PASS"))).validated).toBe(true);
    expect((await decide(run("FAIL"))).validated).toBe(false);
    // A CANNOT_ASSESS with an evidence request is schema-legal but is NOT a pass.
    expect((await decide(run("CANNOT_ASSESS"))).validated).toBe(false);
    // A CANNOT_ASSESS masquerading as a pass (no evidence request) trips the
    // shared reviewer law the gate consults read-only.
    const forged = await decide(run("CANNOT_ASSESS", null));
    expect(forged.validated).toBe(false);
    expect(forged.rubrics.some((r) => r.issues.length > 0)).toBe(true);
  });

  it("PROOF: a FAILED decision neither installs nor persists; a passed sibling does", async () => {
    const reviewer: DecisionReviewer = async (input) =>
      verdictOutput(
        input.rendering.renderingId,
        input.sourceObject.objectId === "term-ruling:T-mother" ? "FAIL" : "PASS",
      );
    const ledger = new InMemoryBibleRenderingLedger();
    const report = await orchestrateLocalizedWiki(baseDeps({ ledger, reviewer }));

    const installed = report.installedForms.map((f) => f.termId);
    expect(installed).not.toContain("T-mother"); // the failed decision did not install
    expect(installed).toContain("c1"); // the passed NAME decision did install
    expect(ledger.recorded().map((r) => r.sourceObjectId)).not.toContain("term-ruling:T-mother");
    expect(report.decisions.find((d) => d.targetKey.includes("T-mother"))?.validated).toBe(false);
  });

  it("PROOF: an L-Name needs BOTH terminology AND voice — a Q2 FAIL blocks it", async () => {
    const reviewer: DecisionReviewer = async (input) =>
      verdictOutput(
        input.rendering.renderingId,
        input.reviewerRole === "Q2" && input.decisionClass === "L-Name" ? "FAIL" : "PASS",
      );
    const report = await orchestrateLocalizedWiki(baseDeps({ reviewer }));
    expect(report.installedForms.map((f) => f.termId)).not.toContain("c1");
    expect(report.installedForms.map((f) => f.termId)).toContain("T-mother");
  });
});

// ── clause 4 ───────────────────────────────────────────────────────────────────
describe("clause 4 — canonical target forms install into the deterministic gates", () => {
  it("PROOF: the installed form is the authoritative value the glossary-exact gate enforces", async () => {
    const report = await orchestrateLocalizedWiki(baseDeps());
    const form = report.installedForms.find((f) => f.termId === "T-mother");
    expect(form).toBeDefined();
    expect(form!.requiredTargetForm).toBe("Mother");
    expect(form!.forbiddenTargetForms).toEqual(["Mom"]);
    expect(form!.sourceForm).toBe("母");

    // Feed the installed form into the deterministic gate: a conforming target
    // passes, a contradictory one is a defect — the bible's canonical form IS the
    // gate's authoritative value.
    const unit = makeUnit({ factId: "unit:gl", sourceUnitKey: "kgl" });
    const term = {
      factId: "glossary:mother",
      termKey: "T-mother",
      policyAction: "translate",
      aliases: [],
      occurrenceCount: 1,
      occurrenceUnitKeys: ["kgl"],
    };
    const snap = makeSnapshot({ units: [unit], terminology: [term] as never });

    expect(
      glossaryExactGate(snap, [makeAccepted(unit, "My Mother said so.")], [form!]),
    ).toHaveLength(0);
    const defects = glossaryExactGate(snap, [makeAccepted(unit, "My mom said so.")], [form!]);
    expect(defects.some((d) => d.category === "glossary-exact")).toBe(true);
  });

  it("PROOF: install rejects a decision with no single preferred canonical form", () => {
    const term = sourceWiki()[0]!;
    const rendering = LocalizedRenderingSchema.parse({
      schemaVersion: "itotori.localized-rendering.v1",
      renderingId: "rendering:bad",
      sourceObjectId: term.objectId,
      sourceObjectKind: "term-ruling",
      targetLanguage: TARGET_LANG,
      version: 1,
      scope: GLOBAL,
      body: {
        kind: "term-ruling",
        termId: "t-bad",
        canonicalForms: [{ form: "Only-Allowed", status: "allowed", scope: GLOBAL }],
        registerGuidance: "x",
      },
      claimRenderings: [],
      dependencies: [],
      provenance: { basisSourceVersion: 1, localizationSnapshotId: LOC_SNAP, runMode: RUN_MODE },
      provisional: false,
    });
    expect(() => installCanonicalForms([{ sourceObject: term, rendering }])).toThrow(
      /exactly one preferred/,
    );
  });
});

// ── clause 5 ───────────────────────────────────────────────────────────────────
describe("clause 5 — NO bible bypass in production or pilot (only ablation may bypass)", () => {
  it("PROOF: production and pilot must build the full bible; only ablation may bypass", () => {
    expect(mustBuildFullBible("production")).toBe(true);
    expect(mustBuildFullBible("pilot")).toBe(true);
    expect(mustBuildFullBible("ablation")).toBe(false);

    expect(() => bypassBibleForAblation("production")).toThrow(BibleBypassError);
    expect(() => bypassBibleForAblation("pilot")).toThrow(BibleBypassError);
    expect(bypassBibleForAblation("ablation")).toEqual({ bypassed: true, posture: "ablation" });
  });

  it("PROOF: a production run builds the WHOLE bible — every source object is rendered, none skipped", async () => {
    const objects = sourceWiki();
    const ledger = new InMemoryBibleRenderingLedger();
    const report = await orchestrateLocalizedWiki(baseDeps({ ledger, posture: "production" }));
    expect(report.posture).toBe("production");
    // every source identity produced exactly one rendering — no collapse, no skip.
    expect(report.renderedKeys.length).toBe(objects.length);
    expect(report.skippedKeys.length).toBe(0);
    expect(ledger.recorded().length).toBe(objects.length);
    expect(report.installedForms.length).toBe(2);
  });

  it("PROOF: recovery is by missing-rendering query — a restart fills only the gaps", async () => {
    const ledger = new InMemoryBibleRenderingLedger();
    await orchestrateLocalizedWiki(baseDeps({ ledger }));
    const afterFirst = ledger.recorded().length;

    let calls = 0;
    const countingRunner: LocalizerRunner = async (input) => {
      calls += 1;
      return [makeRendering(stepShim(input), input.stamp)];
    };
    const report = await orchestrateLocalizedWiki(baseDeps({ ledger, runner: countingRunner }));
    expect(calls).toBe(0);
    expect(report.renderedKeys.length).toBe(0);
    expect(report.skippedKeys.length).toBe(afterFirst);
  });
});
