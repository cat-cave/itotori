import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { World, type IWorldOptions } from "@cucumber/cucumber";

import type {
  BehaviorCellStepExecutor,
  BehaviorCellStepResult,
  BehaviorProofMode,
  SelectedBehaviorCase,
} from "../drivers/behavior-cells/step-contract.js";

interface WorldParameters {
  planPath: string;
  resultsPath: string;
  repositoryRoot: string;
}

interface SelectedCase extends SelectedBehaviorCase {
  readonly driverModule: string | null;
}

interface LoadedPlan {
  readonly candidateTreeDigest: string;
  readonly mode: BehaviorProofMode;
  readonly cases: ReadonlyMap<string, SelectedCase>;
  readonly mutationArtifacts: ReadonlyMap<string, string>;
}

interface CaseResult {
  readonly caseId: string;
  readonly behavior: string;
  readonly subject: string;
  readonly cell: string;
  readonly status: "pass" | "fail";
  readonly assertionCount: number;
  readonly observationCount: number;
  readonly reasonCodes: readonly string[];
}

interface DriverModule {
  readonly executeCellStep: BehaviorCellStepExecutor;
}

const plans = new Map<string, LoadedPlan>();
const cellDriverExecutors = new Map<string, Promise<BehaviorCellStepExecutor>>();
const CASE_RESULT_MEDIA_TYPE = "application/vnd.itotori.behavior-case-result+json";
const CASE_NAME = /\[(case::[^\]]+)\]$/u;
const PROTECTED_STEP = /^the protected behavior case "([^"]+)" selects "([^"]+)"$/u;
const DRIVER_MODULE = /^drivers\/behavior-cells\/[a-z0-9-]+\.js$/u;
const MUTATION_MANIFEST_SCHEMA = "itotori.behavior-fixed-success-mutations.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function parseCase(value: unknown): SelectedCase {
  if (!isRecord(value)) throw new Error("selection-plan-case-not-object");
  const { id, behavior, subject, cell, driverModule, requiredAssertionCount, values } = value;
  if (
    typeof id !== "string" ||
    typeof behavior !== "string" ||
    typeof subject !== "string" ||
    typeof cell !== "string" ||
    (driverModule !== null &&
      (typeof driverModule !== "string" || !DRIVER_MODULE.test(driverModule))) ||
    typeof requiredAssertionCount !== "number" ||
    !Number.isInteger(requiredAssertionCount) ||
    requiredAssertionCount <= 0 ||
    !strings(values)
  ) {
    throw new Error("selection-plan-case-invalid");
  }
  return { id, behavior, subject, cell, driverModule, requiredAssertionCount, values };
}

function loadMutationArtifacts(
  planPath: string,
  mode: BehaviorProofMode,
): ReadonlyMap<string, string> {
  if (mode === "normal") return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(resolve(dirname(planPath), "fixed-success-mutations.json"), "utf8"),
    );
  } catch {
    throw new Error("fixed-success-mutation-manifest-unreadable");
  }
  if (
    !isRecord(parsed) ||
    parsed.schema !== MUTATION_MANIFEST_SCHEMA ||
    !Array.isArray(parsed.mutations)
  ) {
    throw new Error("fixed-success-mutation-manifest-invalid");
  }
  const artifacts = new Map<string, string>();
  for (const entry of parsed.mutations) {
    if (
      !isRecord(entry) ||
      typeof entry.cell !== "string" ||
      typeof entry.mutationArtifactPath !== "string" ||
      entry.mutationArtifactPath.length === 0 ||
      artifacts.has(entry.cell)
    ) {
      throw new Error("fixed-success-mutation-manifest-entry-invalid");
    }
    artifacts.set(entry.cell, entry.mutationArtifactPath);
  }
  return artifacts;
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
  const mutationArtifacts = loadMutationArtifacts(path, mode);
  if (
    mode === "fixed-success" &&
    selected.some(({ cell, driverModule }) => driverModule !== null && !mutationArtifacts.has(cell))
  ) {
    throw new Error("fixed-success-mutation-manifest-missing-registered-cell");
  }
  const plan: LoadedPlan = { candidateTreeDigest, mode, cases, mutationArtifacts };
  plans.set(path, plan);
  return plan;
}

function isDriverModule(value: unknown): value is DriverModule {
  return isRecord(value) && typeof value.executeCellStep === "function";
}

async function loadCellDriverExecutor(driverModule: string): Promise<BehaviorCellStepExecutor> {
  const cached = cellDriverExecutors.get(driverModule);
  if (cached !== undefined) return await cached;
  const pending = import(new URL(`../${driverModule}`, import.meta.url).href).then(
    (loaded: unknown) => {
      if (!isDriverModule(loaded)) throw new Error("registered-cell-driver-export-invalid");
      return loaded.executeCellStep;
    },
  );
  cellDriverExecutors.set(driverModule, pending);
  return await pending;
}

function isStepResult(value: unknown): value is BehaviorCellStepResult {
  if (!isRecord(value)) return false;
  const countIsValid = (count: unknown) =>
    count === undefined || (typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
  return (
    countIsValid(value.observationCount) &&
    countIsValid(value.assertionCount) &&
    (value.reasonCodes === undefined ||
      (Array.isArray(value.reasonCodes) &&
        value.reasonCodes.every((code) => typeof code === "string"))) &&
    (value.deferredFailure === undefined || typeof value.deferredFailure === "string")
  );
}

export class BehaviorWorld extends World<WorldParameters> {
  private readonly plan: LoadedPlan;
  private readonly resultsPath: string;
  private readonly repositoryRoot: string;
  private readonly workRoot: string;
  private selected?: SelectedCase;
  private stepIndex = -1;
  private assertions = 0;
  private observations = 0;
  private readonly reasonCodes: string[] = [];
  private deferredFailure: string | undefined;

  constructor(options: IWorldOptions<WorldParameters>) {
    super(options);
    const planPath = resolve(options.parameters.planPath);
    this.plan = loadPlan(planPath);
    this.resultsPath = resolve(options.parameters.resultsPath);
    this.repositoryRoot = resolve(options.parameters.repositoryRoot);
    this.workRoot = resolve(dirname(planPath), "work");
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
      if (protectedMatch[1] !== selected.id) throw new Error("protected-case-id-mismatch");
      if (protectedMatch[2] !== selected.subject) throw new Error("protected-subject-mismatch");
      this.stepIndex = 0;
      return;
    }
    if (this.stepIndex < 0) throw new Error("protected-selector-not-first");
    const index = this.stepIndex;
    this.stepIndex += 1;
    if (selected.driverModule === null) {
      this.reasonCodes.push("missing-execution");
      throw new Error(`missing-execution:${selected.cell}`);
    }
    const executeCellStep = await loadCellDriverExecutor(selected.driverModule);
    const result: unknown = await executeCellStep({
      execution: this,
      selected,
      index,
      text,
      repositoryRoot: this.repositoryRoot,
      workRoot: this.workRoot,
      candidateTreeDigest: this.plan.candidateTreeDigest,
      mutationArtifactPath: this.plan.mutationArtifacts.get(selected.cell) ?? null,
      mode: this.plan.mode,
    });
    if (!isStepResult(result)) throw new Error("registered-cell-driver-result-invalid");
    this.assertions += result.assertionCount ?? 0;
    this.observations += result.observationCount ?? 0;
    if (result.reasonCodes !== undefined) this.reasonCodes.push(...result.reasonCodes);
    if (result.deferredFailure !== undefined) this.deferredFailure = result.deferredFailure;
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
