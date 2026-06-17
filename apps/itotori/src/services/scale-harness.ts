export type DraftPlanningUnit = {
  bridgeUnitId: string;
  sourceText: string;
};

export type DraftBatchPlanningOptions = {
  maxUnitsPerBatch: number;
  maxSourceCharactersPerBatch: number;
};

export type DraftBatch = {
  batchId: string;
  startIndex: number;
  endIndexExclusive: number;
  unitCount: number;
  sourceCharacterCount: number;
  firstBridgeUnitId: string;
  lastBridgeUnitId: string;
  oversized: boolean;
};

export type DraftBatchPlan = {
  totalUnits: number;
  totalSourceCharacters: number;
  maxUnitsPerBatch: number;
  maxSourceCharactersPerBatch: number;
  oversizedUnitCount: number;
  batches: DraftBatch[];
};

export type ScaleOperationMeasurement = {
  operation: string;
  elapsedMs: number;
};

export type ScaleOperationBudgetResult = ScaleOperationMeasurement & {
  budgetMs: number;
  passed: boolean;
};

export type ScaleBudgetEvaluation = {
  passed: boolean;
  results: ScaleOperationBudgetResult[];
  failures: ScaleOperationBudgetResult[];
};

export function planDraftBatches(
  units: readonly DraftPlanningUnit[],
  options: DraftBatchPlanningOptions,
): DraftBatchPlan {
  assertPositiveInteger(options.maxUnitsPerBatch, "maxUnitsPerBatch");
  assertPositiveInteger(options.maxSourceCharactersPerBatch, "maxSourceCharactersPerBatch");

  const batches: DraftBatch[] = [];
  let totalSourceCharacters = 0;
  let oversizedUnitCount = 0;
  let currentStartIndex = 0;
  let currentUnitCount = 0;
  let currentSourceCharacters = 0;

  const flushCurrent = (endIndexExclusive: number) => {
    if (currentUnitCount === 0) {
      return;
    }
    batches.push(
      batchFromRange(units, {
        startIndex: currentStartIndex,
        endIndexExclusive,
        sourceCharacterCount: currentSourceCharacters,
        oversized: false,
      }),
    );
    currentStartIndex = endIndexExclusive;
    currentUnitCount = 0;
    currentSourceCharacters = 0;
  };

  for (const [index, unit] of units.entries()) {
    const unitCharacters = Array.from(unit.sourceText).length;
    totalSourceCharacters += unitCharacters;

    if (unitCharacters > options.maxSourceCharactersPerBatch) {
      flushCurrent(index);
      oversizedUnitCount += 1;
      batches.push(
        batchFromRange(units, {
          startIndex: index,
          endIndexExclusive: index + 1,
          sourceCharacterCount: unitCharacters,
          oversized: true,
        }),
      );
      currentStartIndex = index + 1;
      continue;
    }

    const exceedsUnitLimit = currentUnitCount + 1 > options.maxUnitsPerBatch;
    const exceedsCharacterLimit =
      currentSourceCharacters + unitCharacters > options.maxSourceCharactersPerBatch;
    if (currentUnitCount > 0 && (exceedsUnitLimit || exceedsCharacterLimit)) {
      flushCurrent(index);
    }

    currentUnitCount += 1;
    currentSourceCharacters += unitCharacters;
  }

  flushCurrent(units.length);

  return {
    totalUnits: units.length,
    totalSourceCharacters,
    maxUnitsPerBatch: options.maxUnitsPerBatch,
    maxSourceCharactersPerBatch: options.maxSourceCharactersPerBatch,
    oversizedUnitCount,
    batches,
  };
}

export function evaluateScaleBudgets(
  measurements: readonly ScaleOperationMeasurement[],
  budgets: Readonly<Record<string, number>>,
): ScaleBudgetEvaluation {
  const measuredOperations = new Set<string>();
  for (const measurement of measurements) {
    measuredOperations.add(measurement.operation);
  }

  const missingMeasurements = Object.keys(budgets).filter(
    (operation) => !measuredOperations.has(operation),
  );
  if (missingMeasurements.length > 0) {
    throw new Error(
      `missing scale measurement for budgeted operation ${missingMeasurements.join(", ")}`,
    );
  }

  const results = measurements.map((measurement) => {
    const budgetMs = budgets[measurement.operation];
    if (budgetMs === undefined) {
      throw new Error(`missing scale budget for operation ${measurement.operation}`);
    }
    assertPositiveNumber(measurement.elapsedMs, `${measurement.operation}.elapsedMs`);
    assertPositiveNumber(budgetMs, `${measurement.operation}.budgetMs`);
    return {
      ...measurement,
      budgetMs,
      passed: measurement.elapsedMs <= budgetMs,
    };
  });
  const failures = results.filter((result) => !result.passed);
  return {
    passed: failures.length === 0,
    results,
    failures,
  };
}

export function assertScaleBudgets(evaluation: ScaleBudgetEvaluation): void {
  if (evaluation.passed) {
    return;
  }
  const failureSummary = evaluation.failures
    .map(
      (failure) => `${failure.operation} ${failure.elapsedMs.toFixed(1)}ms > ${failure.budgetMs}ms`,
    )
    .join(", ");
  throw new Error(`scale budget exceeded: ${failureSummary}`);
}

function batchFromRange(
  units: readonly DraftPlanningUnit[],
  input: {
    startIndex: number;
    endIndexExclusive: number;
    sourceCharacterCount: number;
    oversized: boolean;
  },
): DraftBatch {
  const first = units[input.startIndex];
  const last = units[input.endIndexExclusive - 1];
  if (first === undefined || last === undefined) {
    throw new Error("cannot create a draft batch from an empty range");
  }
  return {
    batchId: `draft-batch-${(input.startIndex + 1).toString().padStart(7, "0")}`,
    startIndex: input.startIndex,
    endIndexExclusive: input.endIndexExclusive,
    unitCount: input.endIndexExclusive - input.startIndex,
    sourceCharacterCount: input.sourceCharacterCount,
    firstBridgeUnitId: first.bridgeUnitId,
    lastBridgeUnitId: last.bridgeUnitId,
    oversized: input.oversized,
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertPositiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
}
