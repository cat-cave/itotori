import { optionalFlag, requiredFlag } from "./flags.js";
import { runLocalizeCommand, type LocalizeCommandDeps } from "./localize-command.js";
import {
  providerBudgetCohort,
  type LocalizationProviderBudgetCohort,
} from "../composition/provider-budget-cohort.js";

export type LocalizePortfolioRunSpec = {
  readonly structure: string;
  readonly bridge: string;
  readonly projectId: string;
  readonly runId: string;
  readonly localeBranchId: string;
  readonly targetLocale: string;
  readonly sourceRoot: string;
  readonly buildRoot: string;
  readonly runMode: string;
  readonly outputScope?: string;
  readonly output?: string;
  readonly wholeSceneMaxUnits?: number;
  /** Per-run mp-02 ceiling, represented exactly as whole micros-USD. */
  readonly costCapMicrosUsd: number | null;
};

export type LocalizePortfolioRunOutcome = {
  readonly projectId: string;
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly error?: string;
};

export type LocalizePortfolioResult = {
  readonly maxConcurrency: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly outcomes: readonly LocalizePortfolioRunOutcome[];
};

export class LocalizePortfolioExecutionError extends Error {
  constructor(readonly result: LocalizePortfolioResult) {
    super(`${String(result.failedCount)} localize portfolio run(s) failed`);
  }
}

export async function runLocalizePortfolioCommand(
  args: readonly string[],
  deps: LocalizeCommandDeps,
): Promise<LocalizePortfolioResult> {
  const parsed = parsePortfolio(deps.io.readJson(requiredFlag(args, "--portfolio")));
  const maxInFlight = optionalFlag(args, "--max-in-flight");
  const spec =
    maxInFlight === undefined
      ? parsed
      : { ...parsed, maxConcurrency: positiveIntegerText(maxInFlight, "--max-in-flight") };
  const maxConcurrency = Math.min(spec.maxConcurrency ?? spec.runs.length, spec.runs.length);
  const admissionCohort = providerBudgetCohort(
    spec.runs.map(({ projectId, runId }) => ({ projectId, runId })),
  );
  const providerBudgetCohorts = deps.providerBudgetCohorts;
  let providerBudgetCohortActive = false;
  let workFailed = false;
  const releasedMemberKeys = new Set<string>();
  const releaseMember = async (
    member: LocalizationProviderBudgetCohort["members"][number],
  ): Promise<void> => {
    if (!providerBudgetCohortActive || providerBudgetCohorts === undefined) return;
    const key = cohortMemberKey(member);
    if (releasedMemberKeys.has(key)) return;
    await providerBudgetCohorts.release(admissionCohort, member);
    releasedMemberKeys.add(key);
  };
  try {
    if (providerBudgetCohorts !== undefined) {
      await providerBudgetCohorts.activate(admissionCohort);
      providerBudgetCohortActive = true;
    }
    const limit = semaphore(maxConcurrency);
    const settled = await Promise.allSettled(
      spec.runs.map((run) => {
        const member = cohortMemberForRun(admissionCohort, run);
        return limit(async () => {
          let childFailed = false;
          try {
            await runLocalizeCommand(buildArgv(run), depsForRun(run, deps, admissionCohort));
          } catch (error: unknown) {
            childFailed = true;
            throw error;
          } finally {
            try {
              await releaseMember(member);
            } catch (releaseError: unknown) {
              if (!childFailed) throw releaseError;
              reportProviderBudgetReleaseFailure(deps.log, releaseError);
            }
          }
        });
      }),
    );

    const outcomes = settled.map((entry, index) => outcomeFor(spec.runs[index]!, entry));
    const completedCount = outcomes.filter((o) => o.status === "completed").length;
    const result: LocalizePortfolioResult = {
      maxConcurrency,
      completedCount,
      failedCount: outcomes.length - completedCount,
      outcomes,
    };

    const summary = {
      maxConcurrency: result.maxConcurrency,
      completedCount: result.completedCount,
      failedCount: result.failedCount,
      outcomes: result.outcomes.map(({ projectId, runId, status }) => ({
        projectId,
        runId,
        status,
      })),
    };
    const outputPath = optionalFlag(args, "--output");
    if (outputPath !== undefined) deps.io.writeJson(outputPath, summary);
    else {
      (deps.log ?? ((m: string) => process.stdout.write(`${m}\n`)))(
        JSON.stringify(summary, null, 2),
      );
    }

    if (result.failedCount > 0) throw new LocalizePortfolioExecutionError(result);
    return result;
  } catch (error: unknown) {
    workFailed = true;
    throw error;
  } finally {
    if (providerBudgetCohortActive && providerBudgetCohorts !== undefined) {
      const releases = await Promise.allSettled(
        admissionCohort.members.map(async (member) => await releaseMember(member)),
      );
      const rejected = releases.find((release) => release.status === "rejected");
      if (rejected !== undefined && rejected.status === "rejected") {
        if (!workFailed) throw rejected.reason;
        reportProviderBudgetReleaseFailure(deps.log, rejected.reason);
      }
    }
  }
}

function cohortMemberForRun(
  cohort: LocalizationProviderBudgetCohort,
  run: Pick<LocalizePortfolioRunSpec, "projectId" | "runId">,
): LocalizationProviderBudgetCohort["members"][number] {
  const member = cohort.members.find(
    (candidate) =>
      candidate.projectId === run.projectId.trim() && candidate.runId === run.runId.trim(),
  );
  if (member === undefined) throw new Error("provider budget cohort is missing a portfolio member");
  return member;
}

function cohortMemberKey(member: LocalizationProviderBudgetCohort["members"][number]): string {
  return JSON.stringify([member.projectId, member.runId]);
}

function parsePortfolio(value: unknown): {
  maxConcurrency?: number;
  runs: readonly LocalizePortfolioRunSpec[];
} {
  const document = record(value, "portfolio spec");
  if (!Array.isArray(document.runs) || document.runs.length === 0) {
    throw new Error("localize portfolio requires a non-empty runs array");
  }
  const runs = document.runs.map((run, index) => parseRunSpec(run, index));
  const seen = new Set<string>();
  for (const run of runs) {
    const key = `${run.projectId}\0${run.runId}`;
    if (seen.has(key)) {
      throw new Error(
        `localize portfolio has duplicate (projectId, runId)=(${run.projectId}, ${run.runId})`,
      );
    }
    seen.add(key);
  }
  const maxConcurrency =
    document.maxConcurrency === undefined
      ? undefined
      : positiveInteger(document.maxConcurrency, "portfolio maxConcurrency");
  return maxConcurrency === undefined ? { runs } : { maxConcurrency, runs };
}

function parseRunSpec(value: unknown, index: number): LocalizePortfolioRunSpec {
  const input = record(value, `portfolio runs[${String(index)}]`);
  const f = (field: string) => `portfolio runs[${String(index)}].${field}`;
  return {
    structure: text(input.structure, f("structure")),
    bridge: text(input.bridge, f("bridge")),
    projectId: text(input.projectId, f("projectId")),
    runId: text(input.runId, f("runId")),
    localeBranchId: text(input.localeBranchId, f("localeBranchId")),
    targetLocale: text(input.targetLocale, f("targetLocale")),
    sourceRoot: text(input.sourceRoot, f("sourceRoot")),
    buildRoot: text(input.buildRoot, f("buildRoot")),
    runMode: text(input.runMode, f("runMode")),
    costCapMicrosUsd:
      input.costCapMicrosUsd === null
        ? null
        : micros(input.costCapMicrosUsd, f("costCapMicrosUsd")),
    ...(input.outputScope === undefined
      ? {}
      : { outputScope: text(input.outputScope, f("outputScope")) }),
    ...(input.output === undefined ? {} : { output: text(input.output, f("output")) }),
    ...(input.wholeSceneMaxUnits === undefined
      ? {}
      : { wholeSceneMaxUnits: positiveInteger(input.wholeSceneMaxUnits, f("wholeSceneMaxUnits")) }),
  };
}

function depsForRun(
  run: LocalizePortfolioRunSpec,
  deps: LocalizeCommandDeps,
  admissionCohort: LocalizationProviderBudgetCohort,
): LocalizeCommandDeps {
  return {
    io: deps.io,
    projectWorkflow: deps.projectWorkflow,
    admissionCohort,
    ...(deps.localizeRunTrackerTiming === undefined
      ? {}
      : { localizeRunTrackerTiming: deps.localizeRunTrackerTiming }),
    // The aggregate portfolio report is the only concurrent stdout document.
    log: () => undefined,
    resolvePortSource: async (request, perRun) => {
      const source = await deps.resolvePortSource(request, perRun);
      if (source.runPlane === undefined) return source;
      // The single-run driver still owns its own tracker, lease, progress writer,
      // and AsyncLocalStorage observer. This supplies only the run-local cap.
      return {
        ...source,
        runPlane: { ...source.runPlane, capMicrosUsd: run.costCapMicrosUsd },
      };
    },
  };
}

function buildArgv(run: LocalizePortfolioRunSpec): string[] {
  const argv = [
    "localize",
    "--structure",
    run.structure,
    "--bridge",
    run.bridge,
    "--project-id",
    run.projectId,
    "--run-id",
    run.runId,
    "--locale-branch-id",
    run.localeBranchId,
    "--target-locale",
    run.targetLocale,
    "--source-root",
    run.sourceRoot,
    "--build-root",
    run.buildRoot,
    "--run-mode",
    run.runMode,
  ];
  if (run.outputScope !== undefined) argv.push("--output-scope", run.outputScope);
  if (run.output !== undefined) argv.push("--output", run.output);
  if (run.wholeSceneMaxUnits !== undefined) {
    argv.push("--whole-scene-max-units", String(run.wholeSceneMaxUnits));
  }
  return argv;
}

function reportProviderBudgetReleaseFailure(
  log: ((message: string) => void) | undefined,
  error: unknown,
): void {
  try {
    (log ?? ((message: string) => process.stderr.write(`${message}\n`)))(
      `localize portfolio provider budget cohort release failed: ${errorMessage(error)}`,
    );
  } catch {
    // A diagnostic cannot replace the original portfolio failure.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outcomeFor(
  run: LocalizePortfolioRunSpec,
  settled: PromiseSettledResult<void>,
): LocalizePortfolioRunOutcome {
  if (settled.status === "fulfilled") {
    return { projectId: run.projectId, runId: run.runId, status: "completed" };
  }
  return {
    projectId: run.projectId,
    runId: run.runId,
    status: "failed",
    error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
  };
}

function semaphore(maxConcurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function micros(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer micros-USD value or null`);
  }
  return value as number;
}

function positiveIntegerText(value: string, label: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be a positive integer`);
  return positiveInteger(Number(value), label);
}
