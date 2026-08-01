import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { World, type IWorldOptions } from "@cucumber/cucumber";

import {
  isExplicitNonSuccess,
  observeFailure,
  type FailureObservation,
} from "../drivers/explicit-failure.js";
import {
  artifactActionResult,
  artifactConditionResult,
  observeImmutableArtifactBehavior,
  type ImmutableArtifactObservation,
} from "../drivers/immutable-artifact.js";
import { observeEvidence, type EvidenceObservation } from "../drivers/portable-evidence.js";

interface WorldParameters {
  planPath: string;
  resultsPath: string;
  repositoryRoot: string;
}

interface SelectedCase {
  id: string;
  behavior: string;
  subject: string;
  cell: string;
  requiredAssertionCount: number;
  values: Readonly<Record<string, string>>;
}

interface LoadedPlan {
  candidateTreeDigest: string;
  mode: "normal" | "fixed-success";
  cases: ReadonlyMap<string, SelectedCase>;
}

interface CaseResult {
  caseId: string;
  behavior: string;
  subject: string;
  cell: string;
  status: "pass" | "fail";
  assertionCount: number;
  observationCount: number;
  reasonCodes: readonly string[];
}

const plans = new Map<string, LoadedPlan>();
const CASE_RESULT_MEDIA_TYPE = "application/vnd.itotori.behavior-case-result+json";
const CASE_NAME = /\[(case::[^\]]+)\]$/u;
const PROTECTED_STEP = /^the protected behavior case "([^"]+)" selects "([^"]+)"$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function parseCase(value: unknown): SelectedCase {
  if (!isRecord(value)) throw new Error("selection-plan-case-not-object");
  const { id, behavior, subject, cell, requiredAssertionCount, values } = value;
  if (
    typeof id !== "string" ||
    typeof behavior !== "string" ||
    typeof subject !== "string" ||
    typeof cell !== "string" ||
    typeof requiredAssertionCount !== "number" ||
    !Number.isInteger(requiredAssertionCount) ||
    requiredAssertionCount <= 0 ||
    !strings(values)
  ) {
    throw new Error("selection-plan-case-invalid");
  }
  return { id, behavior, subject, cell, requiredAssertionCount, values };
}

function loadPlan(path: string): LoadedPlan {
  const cached = plans.get(path);
  if (cached !== undefined) return cached;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.cases)) {
    throw new Error("selection-plan-invalid");
  }
  const candidateTreeDigest = parsed.candidateTreeDigest;
  const mode = parsed.mode;
  if (typeof candidateTreeDigest !== "string" || (mode !== "normal" && mode !== "fixed-success")) {
    throw new Error("selection-plan-binding-invalid");
  }
  const selected = parsed.cases.map(parseCase);
  const cases = new Map(selected.map((entry) => [entry.id, entry]));
  if (cases.size !== selected.length) throw new Error("selection-plan-duplicate-case");
  const plan: LoadedPlan = { candidateTreeDigest, mode, cases };
  plans.set(path, plan);
  return plan;
}

function requireValue(values: Readonly<Record<string, string>>, name: string): string {
  const value = values[name];
  if (value === undefined || value.length === 0) throw new Error(`missing-case-value:${name}`);
  return value;
}

function check(condition: boolean, code: string): void {
  if (!condition) throw new Error(code);
}

export class BehaviorWorld extends World<WorldParameters> {
  private readonly plan: LoadedPlan;
  private readonly resultsPath: string;
  private readonly repositoryRoot: string;
  private selected?: SelectedCase;
  private failure?: FailureObservation;
  private evidence?: EvidenceObservation;
  private artifact?: ImmutableArtifactObservation;
  private stepIndex = -1;
  private assertions = 0;
  private observations = 0;
  private readonly reasonCodes: string[] = [];
  private deferredFailure: string | undefined;

  constructor(options: IWorldOptions<WorldParameters>) {
    super(options);
    this.plan = loadPlan(resolve(options.parameters.planPath));
    this.resultsPath = resolve(options.parameters.resultsPath);
    this.repositoryRoot = resolve(options.parameters.repositoryRoot);
  }

  begin(pickleName: string): void {
    const caseId = CASE_NAME.exec(pickleName)?.[1];
    if (caseId === undefined) throw new Error("scenario-name-missing-case-id");
    const selected = this.plan.cases.get(caseId);
    if (selected === undefined) throw new Error(`unexpected-executed-case:${caseId}`);
    this.selected = selected;
  }

  async execute(text: string): Promise<void> {
    const selected = this.selected;
    if (selected === undefined) throw new Error("case-not-started");
    const protectedMatch = PROTECTED_STEP.exec(text);
    if (protectedMatch !== null) {
      check(protectedMatch[1] === selected.id, "protected-case-id-mismatch");
      check(protectedMatch[2] === selected.subject, "protected-subject-mismatch");
      this.stepIndex = 0;
      return;
    }
    if (this.stepIndex < 0) throw new Error("protected-selector-not-first");
    const originalStep = this.stepIndex;
    this.stepIndex += 1;
    if (selected.behavior === "quality.failures-stay-explicit") {
      this.executeFailureStep(selected, originalStep, text);
      return;
    }
    if (selected.behavior === "quality.evidence-is-traceable-and-portable") {
      this.executeEvidenceStep(selected, originalStep, text);
      return;
    }
    if (selected.behavior === "platform.artifacts-are-immutable-and-retained-by-policy") {
      await this.executeArtifactStep(selected, originalStep, text);
      return;
    }
    this.reasonCodes.push("missing-execution");
    throw new Error(`missing-execution:${selected.cell}`);
  }

  private executeFailureStep(selected: SelectedCase, index: number, text: string): void {
    if (index === 0) {
      const operation = requireValue(selected.values, "operation");
      const failureCase = requireValue(selected.values, "failure_case");
      const entrypoint = requireValue(selected.values, "entrypoint");
      check(
        text === `${operation} receives ${failureCase} through ${entrypoint}`,
        "failure-given-mismatch",
      );
      this.failure = observeFailure(
        {
          operation,
          failureCase,
          entrypoint,
          repositoryRoot: this.repositoryRoot,
          workRoot: resolve(".tmp", "behavior-proof", "work"),
        },
        this.plan.mode === "fixed-success",
      );
      this.observations = this.failure.observedFields;
      return;
    }
    if (index === 1) {
      check(text === "the request settles", "failure-when-mismatch");
      check(this.failure !== undefined, "failure-not-observed");
      return;
    }
    const failure = this.failure;
    if (failure === undefined) throw new Error("failure-not-observed");
    if (index === 2) {
      const expected = requireValue(selected.values, "failure_class");
      check(text === `the caller receives ${expected}`, "failure-class-step-mismatch");
      check(failure.failureClass === expected, "failure-class-mismatch");
    } else if (index === 3) {
      const expected = requireValue(selected.values, "diagnostic_outcome");
      check(text === `the outcome contains ${expected}`, "failure-diagnostic-step-mismatch");
      check(failure.diagnostic === expected, "failure-diagnostic-mismatch");
    } else if (index === 4) {
      check(
        text === "no successful, skipped, defaulted, or fixed-empty result is reported",
        "failure-final-step-mismatch",
      );
      check(isExplicitNonSuccess(failure), "empty-or-successful-failure-result");
    } else {
      throw new Error("unbound-explicit-failure-step");
    }
    this.assertions += 1;
  }

  private executeEvidenceStep(selected: SelectedCase, index: number, text: string): void {
    if (index === 0) {
      const evidenceKind = requireValue(selected.values, "evidence_kind");
      const sourceClass = requireValue(selected.values, "source_class");
      const privacyClass = requireValue(selected.values, "privacy_class");
      const contentCase = requireValue(selected.values, "content_case");
      check(
        text ===
          `${evidenceKind} from ${sourceClass} has ${privacyClass} visibility and ${contentCase}`,
        "evidence-given-mismatch",
      );
      this.evidence = observeEvidence(
        {
          caseId: selected.id,
          evidenceKind,
          sourceClass,
          privacyClass,
          contentCase,
          referenceKind: requireValue(selected.values, "reference_kind"),
          candidateRevision: this.plan.candidateTreeDigest,
          repositoryRoot: this.repositoryRoot,
          workRoot: resolve(".tmp", "behavior-proof", "work"),
        },
        this.plan.mode === "fixed-success",
      );
      this.observations = this.evidence.observedFields;
      return;
    }
    const evidence = this.evidence;
    if (evidence === undefined) throw new Error("evidence-not-observed");
    if (index === 1) {
      check(
        text ===
          `an independent auditor resolves its ${requireValue(selected.values, "reference_kind")} in a fresh environment`,
        "evidence-when-mismatch",
      );
      return;
    }
    const expected = requireValue(selected.values, "audit_outcome");
    const clauses = [
      "producer, source revision, input and output hashes, privacy class, and outcome are present",
      `resolution ends as ${expected}`,
      "reference expectations identify a producer independent from the output under evaluation",
      "copying evaluated output into expected data invalidates provenance",
      "every accepted artifact set belongs to one coherent source lineage and regenerates all dependents deterministically after a source change",
      "tampering, stale revision, or environment-local location makes the evidence invalid",
    ];
    check(text === clauses[index - 2], `portable-evidence-step-${index - 1}-mismatch`);
    const conditions = [
      evidence.metadataComplete && evidence.restrictedPublicationWithheld,
      evidence.auditOutcome === expected && evidence.freshResolution,
      evidence.independentProducer,
      evidence.copiedExpectationRejected,
      evidence.coherentLineage && evidence.deterministicDependents,
      evidence.tamperRejected && evidence.staleRevisionRejected && evidence.localLocationRejected,
    ];
    const condition = conditions[index - 2];
    if (condition === undefined) throw new Error("unbound-portable-evidence-step");
    check(condition, `portable-evidence-assertion-${index - 1}`);
    this.assertions += 1;
  }

  private async executeArtifactStep(
    selected: SelectedCase,
    index: number,
    text: string,
  ): Promise<void> {
    if (index === 0) {
      check(
        text ===
          `${requireValue(selected.values, "actor")} handles ${requireValue(
            selected.values,
            "artifact_kind",
          )} with ${requireValue(selected.values, "privacy_class")} classification and ${requireValue(
            selected.values,
            "retention_policy",
          )}`,
        "artifact-given-mismatch",
      );
      this.artifact = await observeImmutableArtifactBehavior(this.repositoryRoot);
      this.observations = this.artifact.observedFields;
      return;
    }
    const artifact = this.artifact;
    if (artifact === undefined) throw new Error("artifact-not-observed");
    if (index === 1) {
      check(
        text === `the actor performs ${requireValue(selected.values, "artifact_action")}`,
        "artifact-when-mismatch",
      );
      return;
    }
    if (index === 2) {
      check(
        text ===
          `hash identity, immutability, and authorization end as ${requireValue(
            selected.values,
            "expected_outcome",
          )}`,
        "artifact-outcome-mismatch",
      );
      this.recordArtifactResult(
        artifactActionResult(artifact, requireValue(selected.values, "artifact_action")),
      );
      this.recordArtifactResult(artifactConditionResult(artifact, "authorized-retention"));
    } else if (index === 3) {
      check(
        text === "expiry removes only unreferenced eligible content",
        "artifact-expiry-mismatch",
      );
      this.recordArtifactResult(artifactConditionResult(artifact, "expiry"));
    } else if (index === 4) {
      check(
        text ===
          "any authorized prune records its exact scope and preserves required referential evidence",
        "artifact-prune-mismatch",
      );
      this.recordArtifactResult(artifactConditionResult(artifact, "prune"));
    } else if (index === 5) {
      check(
        text === "retained lineage never points to missing content as if it were available",
        "artifact-lineage-mismatch",
      );
      this.recordArtifactResult(artifactConditionResult(artifact, "lineage"));
    } else if (index === 6) {
      check(
        text ===
          "every retained audit event preserves its actor, target, outcome, and append order",
        "artifact-audit-mismatch",
      );
      this.recordArtifactResult(artifactConditionResult(artifact, "audit"));
      this.recordArtifactResult(artifactConditionResult(artifact, "incompatible-version"));
    } else {
      throw new Error("unbound-immutable-artifact-step");
    }
    this.assertions += 1;
    if (index === 6 && this.reasonCodes.length > 0) {
      this.deferredFailure = `immutable-artifact-conditions-failed:${this.reasonCodes.join(",")}`;
    }
  }

  private recordArtifactResult(result: { passed: boolean; reason: string }): void {
    if (!result.passed) this.reasonCodes.push(result.reason);
  }

  finish(cucumberPassed: boolean): void {
    const selected = this.selected;
    if (selected === undefined) throw new Error("finished-case-not-selected");
    const pass =
      cucumberPassed &&
      this.deferredFailure === undefined &&
      this.assertions === selected.requiredAssertionCount &&
      this.observations > 0;
    const reasonCodes = pass
      ? []
      : this.reasonCodes.length > 0
        ? [...new Set(this.reasonCodes)].sort()
        : [this.plan.mode === "fixed-success" ? "fixed-success-survived" : "failed-assertion"];
    const result: CaseResult = {
      caseId: selected.id,
      behavior: selected.behavior,
      subject: selected.subject,
      cell: selected.cell,
      status: pass ? "pass" : "fail",
      assertionCount: this.assertions,
      observationCount: this.observations,
      reasonCodes,
    };
    this.attach(
      JSON.stringify({ schema: "itotori.behavior-case-result.v1", result }),
      CASE_RESULT_MEDIA_TYPE,
    );
    appendFileSync(this.resultsPath, `${JSON.stringify(result)}\n`, "utf8");
    if (this.deferredFailure !== undefined) throw new Error(this.deferredFailure);
  }
}
