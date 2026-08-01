const repeat = (value, count) => Array.from({ length: count }, () => value);
const canonical = (sourceCapability) => `canonical:${sourceCapability}`;

const FULL_CANONICAL_BEHAVIORS = new Set([
  "support.qualify-profile",
  "content.extract-complete-scope",
  "patch.produce-safe-output",
  "play.launch-patched-content",
]);

const PARTIAL_SELECTOR_RULES = new Map([
  [
    "source.prepare-owned-content",
    [
      "production-trait:native",
      "production-trait:plain",
      "production-trait:native",
      ...repeat("production", 4),
      "production-trait:mixed",
    ],
  ],
  [
    "run.localize-complete-scope",
    ["production-trait:native", "production-trait:web", ...repeat("production", 9)],
  ],
  [
    "journey.localize-owned-release",
    ["production-trait:native", "production-trait:web", ...repeat("production", 3)],
  ],
  [
    "play.control-reproducible-session",
    [
      "production-trait:native",
      "production-trait:web",
      ...repeat("production", 5),
      canonical("decode.engine.softpal"),
      canonical("decode.engine.kirikiri-kag-xp3"),
    ],
  ],
  ["play.explore-routes", ["production-trait:native", "production-trait:web"]],
  [
    "play.observe-localized-surfaces",
    [
      "production-trait:native",
      "production-trait:web",
      "production",
      ...repeat("production-trait:native", 5),
      ...repeat("production", 3),
      canonical("decode.engine.softpal"),
      canonical("decode.engine.rpg-maker-mv-mz"),
      canonical("decode.engine.rpg-maker-vx-ace-rgss3"),
      canonical("decode.engine.kirikiri-kag-xp3"),
      canonical("decode.engine.renpy"),
      canonical("decode.engine.wolf-rpg-editor"),
      canonical("decode.engine.bgi-ethornell"),
      canonical("decode.engine.unity-i2"),
      canonical("decode.engine.unity-naninovel"),
    ],
  ],
  [
    "evidence.capture-runtime-observation",
    ["production-trait:native", "production-trait:web", ...repeat("production", 5)],
  ],
  ["evidence.publish-safe-runtime-proof", repeat("shared", 2)],
  ["quality.untrusted-inputs-fail-without-harm", repeat("production", 12)],
  ["quality.output-completeness-is-reported", repeat("production", 3)],
  [
    "quality.same-inputs-reproduce-equivalent-results",
    ["production-trait:native", "production-trait:web", ...repeat("production", 4)],
  ],
  ["review.play-exact-patch", repeat("production", 9)],
  [
    "export.download-played-patch",
    ["production-trait:native", "production-trait:web", "production"],
  ],
  ["evaluation.compare-contestants", repeat("shared", 13)],
]);

const SHARED_ENGINE_VALUES = new Map([
  ["evidence.publish-safe-runtime-proof", ["registered native family", "registered web family"]],
  [
    "evaluation.compare-contestants",
    ["MAGES benchmark reference", ...repeat("registered production family", 12)],
  ],
]);

const WEB = new Set([
  "decode.engine.rpg-maker-mv-mz",
  "decode.engine.renpy",
  "decode.engine.tyranoscript",
  "decode.engine.unity-i2",
  "decode.engine.unity-naninovel",
]);
const WEB_ONLY = new Set([
  "decode.engine.rpg-maker-mv-mz",
  "decode.engine.tyranoscript",
  "decode.engine.unity-i2",
  "decode.engine.unity-naninovel",
]);
const PLAIN = new Set([
  "decode.engine.softpal",
  "decode.engine.nexas",
  "decode.engine.rpg-maker-mv-mz",
  "decode.engine.kirikiri-kag-xp3",
  "decode.engine.renpy",
  "decode.engine.bgi-ethornell",
  "decode.engine.tyranoscript",
  "decode.engine.unity-i2",
  "decode.engine.unity-naninovel",
]);

const GENERIC_SELECTORS = new Map([
  ["registered family", "production"],
  ["registered production family", "production"],
  ["registered native family", "production-trait:native"],
  ["registered web family", "production-trait:web"],
  ["registered plain family", "production-trait:plain"],
  ["mixed registered families", "production-trait:mixed"],
]);

function registryIndex(engines, errors) {
  const byName = new Map();
  const byCapability = new Map();
  for (const [index, engine] of engines.entries()) {
    const location = `engine registry row ${index + 1}`;
    if (byName.has(engine.engineFamily)) {
      errors.push(`${location}: duplicate engineFamily ${engine.engineFamily}`);
    }
    if (byCapability.has(engine.sourceCapability)) {
      errors.push(`${location}: duplicate sourceCapability ${engine.sourceCapability}`);
    }
    byName.set(engine.engineFamily, engine);
    byCapability.set(engine.sourceCapability, engine);
  }
  const production = engines
    .filter(({ supportRole }) => supportRole === "production-target")
    .toSorted((left, right) => left.sourceCapability.localeCompare(right.sourceCapability));
  const native = production.filter(({ sourceCapability }) => !WEB_ONLY.has(sourceCapability));
  const web = production.filter(({ sourceCapability }) => WEB.has(sourceCapability));
  const plain = production.filter(({ sourceCapability }) => PLAIN.has(sourceCapability));
  for (const [trait, members] of [
    ["web", WEB],
    ["plain", PLAIN],
  ]) {
    for (const capability of members) {
      const engine = byCapability.get(capability);
      if (!engine || engine.supportRole !== "production-target") {
        errors.push(`${trait} trait member ${capability} is not a production registry row`);
      }
    }
  }
  return { byName, byCapability, production, native, web, plain };
}

function indexedByBehavior(rows, label, errors) {
  const result = new Map();
  for (const row of rows) {
    const behavior = row.behavior ?? row.id;
    if (result.has(behavior)) errors.push(`${behavior}: duplicate ${label}`);
    result.set(behavior, row);
  }
  return result;
}

function resolveSelector(classification, row, registry, location, errors) {
  if (classification.applicability === "shared") return "shared";
  const value = row.engine_family;
  if (classification.applicability === "production-targets" && GENERIC_SELECTORS.has(value)) {
    return GENERIC_SELECTORS.get(value);
  }
  const engine = registry.byName.get(value);
  if (!engine) {
    errors.push(`${location}: unknown literal engine family ${JSON.stringify(value)}`);
    return "unknown";
  }
  if (
    classification.applicability === "production-targets" &&
    engine.supportRole !== "production-target"
  ) {
    errors.push(`${location}: literal ${value} is not a production target`);
  }
  return canonical(engine.sourceCapability);
}

function expandSelector(selector, registry, location, errors) {
  let selected;
  if (selector === "shared") selected = [{ subject: "all", comparisonSubject: null }];
  else if (selector === "production") selected = subjects(registry.production);
  else if (selector === "production-trait:native") selected = subjects(registry.native);
  else if (selector === "production-trait:web") selected = subjects(registry.web);
  else if (selector === "production-trait:plain") selected = subjects(registry.plain);
  else if (selector === "production-trait:mixed") {
    selected = registry.production.map((engine, index, rows) => ({
      subject: engine.sourceCapability,
      comparisonSubject: rows[(index + 1) % rows.length]?.sourceCapability ?? null,
    }));
  } else if (selector.startsWith("canonical:")) {
    const capability = selector.slice("canonical:".length);
    selected = registry.byCapability.has(capability)
      ? [{ subject: capability, comparisonSubject: null }]
      : [];
  } else selected = [];
  if (selected.length === 0) errors.push(`${location}: selector ${selector} matched zero subjects`);
  const unique = new Set(selected.map(({ subject }) => subject));
  if (unique.size !== selected.length) {
    errors.push(`${location}: selector ${selector} selected a subject more than once`);
  }
  return selected;
}

function subjects(engines) {
  return engines.map(({ sourceCapability }) => ({
    subject: sourceCapability,
    comparisonSubject: null,
  }));
}

function validateComparisonInputs(behavior, row, location, errors) {
  if (behavior === "quality.same-inputs-reproduce-equivalent-results" && !row.comparison_source) {
    errors.push(`${location}: comparison_source must remain comparison evidence`);
  }
  if (behavior === "evidence.capture-runtime-observation" && !row.producer_class) {
    errors.push(`${location}: producer_class must remain producer/comparison evidence`);
  }
  if (behavior === "evaluation.compare-contestants" && !row.contestant_set) {
    errors.push(`${location}: contestant_set must remain comparison evidence`);
  }
}

function expectedMatrix(classifications, registry, errors) {
  const applicableCells = [];
  const nonApplicablePairs = [];
  const nonProduction = [...registry.byCapability.values()]
    .filter(({ supportRole }) => supportRole !== "production-target")
    .toSorted((left, right) => left.sourceCapability.localeCompare(right.sourceCapability));
  for (const classification of classifications) {
    const { behavior, applicability } = classification;
    if (applicability === "shared") applicableCells.push(`cell::${behavior}::all`);
    else if (applicability === "canonical-engines") {
      for (const engine of registry.byCapability.values()) {
        applicableCells.push(`cell::${behavior}::${engine.sourceCapability}`);
      }
    } else if (applicability === "production-targets") {
      for (const engine of registry.production) {
        applicableCells.push(`cell::${behavior}::${engine.sourceCapability}`);
      }
      for (const engine of nonProduction) {
        nonApplicablePairs.push({ behavior, subject: engine.sourceCapability });
      }
    } else errors.push(`${behavior}: unknown applicability ${JSON.stringify(applicability)}`);
  }
  const sortedCells = applicableCells.toSorted();
  if (new Set(sortedCells).size !== sortedCells.length) {
    errors.push("classified matrix contains duplicate applicable cells");
  }
  nonApplicablePairs.sort((left, right) =>
    `${left.behavior}\0${left.subject}`.localeCompare(`${right.behavior}\0${right.subject}`),
  );
  return { applicableCells: sortedCells, nonApplicablePairs };
}

export function buildBehaviorCaseSelection({ scenarios, engines, classifications }) {
  const errors = [];
  const registry = registryIndex(engines, errors);
  const scenarioByBehavior = indexedByBehavior(scenarios, "outline", errors);
  const classificationByBehavior = indexedByBehavior(classifications, "classification", errors);
  const cases = [];
  let authoredCases = 0;
  let partialCases = 0;
  let partialOutlines = 0;

  for (const scenario of scenarios) {
    authoredCases += scenario.exampleRows.length;
    const classification = classificationByBehavior.get(scenario.id);
    if (!classification) {
      errors.push(`${scenario.id}: missing classification`);
      continue;
    }
    const expectedSelectors = PARTIAL_SELECTOR_RULES.get(scenario.id);
    if (expectedSelectors) {
      partialOutlines += 1;
      if (scenario.exampleRows.length !== expectedSelectors.length) {
        errors.push(
          `${scenario.id}: has ${scenario.exampleRows.length} authored rows; expected ${expectedSelectors.length}`,
        );
      }
    }
    if (classification.applicability === "production-targets" && !expectedSelectors) {
      errors.push(`${scenario.id}: missing reviewed partial selector rule`);
    }
    if (
      classification.applicability === "canonical-engines" &&
      !FULL_CANONICAL_BEHAVIORS.has(scenario.id)
    ) {
      errors.push(`${scenario.id}: missing reviewed full-canonical selector rule`);
    }
    const behaviorCases = [];
    for (const [rowIndex, row] of scenario.exampleRows.entries()) {
      const location = `${scenario.id} Examples row ${rowIndex + 1}`;
      const selector = resolveSelector(classification, row, registry, location, errors);
      const expectedSelector = expectedSelectors?.[rowIndex];
      if (expectedSelector && selector !== expectedSelector) {
        errors.push(`${location}: selector is ${selector}; expected ${expectedSelector}`);
      }
      const expectedEngineValue = SHARED_ENGINE_VALUES.get(scenario.id)?.[rowIndex];
      if (expectedEngineValue && row.engine_family !== expectedEngineValue) {
        errors.push(
          `${location}: shared engine-shaped value is ${JSON.stringify(
            row.engine_family,
          )}; expected ${JSON.stringify(expectedEngineValue)}`,
        );
      }
      validateComparisonInputs(scenario.id, row, location, errors);
      const expanded = expandSelector(selector, registry, location, errors);
      if (expectedSelectors) partialCases += expanded.length;
      for (const { subject, comparisonSubject } of expanded) {
        const selectedCase = {
          id: `case::${scenario.id}::${String(rowIndex + 1).padStart(3, "0")}::${subject}`,
          behavior: scenario.id,
          cell: `cell::${scenario.id}::${subject}`,
          subject,
          selector,
          comparisonSubject,
          profileSelector: typeof row.profile === "string" ? row.profile : null,
          authoredRow: rowIndex + 1,
          sourcePath: scenario.path,
          arguments: { ...row },
          partial: Boolean(expectedSelectors),
        };
        cases.push(selectedCase);
        behaviorCases.push(selectedCase);
      }
    }
    if (classification.applicability === "canonical-engines") {
      const selected = behaviorCases.map(({ subject }) => subject);
      if (
        selected.length !== engines.length ||
        new Set(selected).size !== engines.length ||
        selected.some((subject) => !registry.byCapability.has(subject))
      ) {
        errors.push(`${scenario.id}: full-canonical rows must select every registry row once`);
      }
    }
  }
  for (const behavior of classificationByBehavior.keys()) {
    if (!scenarioByBehavior.has(behavior)) errors.push(`${behavior}: missing outline`);
  }
  for (const behavior of PARTIAL_SELECTOR_RULES.keys()) {
    if (!scenarioByBehavior.has(behavior)) errors.push(`${behavior}: missing partial outline`);
  }
  for (const behavior of FULL_CANONICAL_BEHAVIORS) {
    if (!scenarioByBehavior.has(behavior))
      errors.push(`${behavior}: missing full-canonical outline`);
  }

  const caseIds = new Set();
  for (const selectedCase of cases) {
    if (caseIds.has(selectedCase.id)) errors.push(`duplicate selected case ${selectedCase.id}`);
    caseIds.add(selectedCase.id);
  }
  const matrix = expectedMatrix(classifications, registry, errors);
  const selectedCells = new Set(cases.map(({ cell }) => cell));
  const applicableCellSet = new Set(matrix.applicableCells);
  const missingCells = matrix.applicableCells.filter((cell) => !selectedCells.has(cell));
  const unexpectedCells = [...selectedCells].filter((cell) => !applicableCellSet.has(cell));
  if (missingCells.length > 0) {
    errors.push(
      `${missingCells.length} applicable cells have no selected case: ${missingCells
        .slice(0, 4)
        .join(", ")}`,
    );
  }
  if (unexpectedCells.length > 0) {
    errors.push(
      `${unexpectedCells.length} selected cells are not applicable: ${unexpectedCells
        .slice(0, 4)
        .join(", ")}`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    cases,
    applicableCells: matrix.applicableCells,
    nonApplicablePairs: matrix.nonApplicablePairs,
    summary: {
      outlines: scenarios.length,
      authoredCases,
      selectedCases: cases.length,
      partialCases,
      partialOutlines,
      canonicalEngines: engines.length,
      productionEngines: registry.production.length,
      nativeEngines: registry.native.length,
      webEngines: registry.web.length,
      plainEngines: registry.plain.length,
      applicableCells: matrix.applicableCells.length,
      nonApplicablePairs: matrix.nonApplicablePairs.length,
    },
  };
}
