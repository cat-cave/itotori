const LANE = /^[a-z0-9][a-z0-9-]*$/u;
const CASE_ID = /^case::[A-Za-z0-9._:-]+$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const RELATIVE_PATH = /^(?!\/)(?!.*\\)[A-Za-z0-9._/-]+$/u;

const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function integer(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label}-invalid`);
  return value;
}

function text(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label}-invalid`);
  return value;
}

export function laneFragmentKey({ lane, shard, shardCount }) {
  return `${lane}-${shard}of${shardCount}`;
}

export function rootLaneFragments(cases) {
  return [
    {
      lane: "public-ts",
      shard: 1,
      shardCount: 1,
      caseIds: cases.map(({ id }) => id).toSorted(lexical),
    },
  ];
}

export function normalizePlanLaneFragments(plan) {
  if (!Array.isArray(plan?.cases)) throw new Error("plan-cases-invalid");
  if (!Array.isArray(plan.laneFragments) || plan.laneFragments.length === 0) {
    throw new Error("plan-lane-fragments-missing");
  }
  const selected = new Map(plan.cases.map((item) => [item.id, item]));
  if (selected.size !== plan.cases.length) throw new Error("plan-case-identities-duplicate");
  const seenCases = new Set();
  const seenFragments = new Set();
  const laneGroups = new Map();
  const fragments = plan.laneFragments.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`plan-lane-fragment-${index}-invalid`);
    }
    const lane = text(raw.lane, `plan-lane-fragment-${index}-lane`, LANE);
    const shard = integer(raw.shard, `plan-lane-fragment-${index}-shard`);
    const shardCount = integer(raw.shardCount, `plan-lane-fragment-${index}-shard-count`);
    if (shard > shardCount) throw new Error(`plan-lane-fragment-${index}-shard-range-invalid`);
    const key = laneFragmentKey({ lane, shard, shardCount });
    if (seenFragments.has(key)) throw new Error(`plan-lane-fragment-duplicate:${key}`);
    seenFragments.add(key);
    if (!Array.isArray(raw.caseIds) || raw.caseIds.length === 0) {
      throw new Error(`plan-lane-fragment-${key}-cases-empty`);
    }
    const caseIds = raw.caseIds.map((caseId) => text(caseId, `${key}-case`, CASE_ID));
    if (caseIds.some((caseId, caseIndex) => caseIndex > 0 && caseIds[caseIndex - 1] >= caseId)) {
      throw new Error(`plan-lane-fragment-${key}-cases-not-sorted-unique`);
    }
    for (const caseId of caseIds) {
      const selectedCase = selected.get(caseId);
      if (selectedCase === undefined)
        throw new Error(`plan-lane-fragment-case-unselected:${caseId}`);
      if (seenCases.has(caseId)) throw new Error(`plan-lane-fragment-case-duplicate:${caseId}`);
      if (selectedCase.lane !== null && selectedCase.lane !== lane) {
        throw new Error(`plan-lane-fragment-case-lane-mismatch:${caseId}`);
      }
      seenCases.add(caseId);
    }
    const group = laneGroups.get(lane) ?? { shardCount, shards: new Set() };
    if (group.shardCount !== shardCount) throw new Error(`plan-lane-shard-count-mismatch:${lane}`);
    group.shards.add(shard);
    laneGroups.set(lane, group);
    return { lane, shard, shardCount, caseIds };
  });
  if (seenCases.size !== selected.size) {
    throw new Error(`plan-lane-fragment-case-set-mismatch:${seenCases.size}/${selected.size}`);
  }
  for (const [lane, group] of laneGroups) {
    if (
      group.shards.size !== group.shardCount ||
      Array.from({ length: group.shardCount }, (_, index) => index + 1).some(
        (shard) => !group.shards.has(shard),
      )
    ) {
      throw new Error(`plan-lane-shards-incomplete:${lane}`);
    }
  }
  return fragments.toSorted((left, right) =>
    lexical(laneFragmentKey(left), laneFragmentKey(right)),
  );
}

export function fragmentArtifactPaths(fragment, relativeRoot, kind = "normal") {
  const key = laneFragmentKey(fragment);
  const prefix = kind === "mutation" ? "mutation/fixed-success-" : "cucumber/";
  return {
    key,
    messagePath: `${relativeRoot}/${prefix}${key}.ndjson`,
    junitPath: `${relativeRoot}/${prefix}${key}.xml`,
  };
}

export function expectedFragmentFileNames(plan, kind = "normal") {
  return normalizePlanLaneFragments(plan)
    .flatMap((fragment) => {
      const key = laneFragmentKey(fragment);
      const base = kind === "mutation" ? `fixed-success-${key}` : key;
      return [`${base}.ndjson`, `${base}.xml`];
    })
    .toSorted(lexical);
}

export function observedFragmentKey(fragment) {
  const lane = text(fragment?.lane, "observed-fragment-lane", LANE);
  const shard = integer(fragment?.shard, "observed-fragment-shard");
  const shardCount = integer(fragment?.shardCount, "observed-fragment-shard-count");
  if (shard > shardCount) throw new Error("observed-fragment-shard-range-invalid");
  return laneFragmentKey({ lane, shard, shardCount });
}

export function normalizeReportLaneFragments(rawFragments, plannedFragments) {
  if (!Array.isArray(rawFragments)) throw new Error("laneFragments must be an array");
  const planned = new Set(plannedFragments.map(laneFragmentKey));
  const seen = new Set();
  const paths = new Set();
  const fragments = rawFragments.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`laneFragments[${index}] must be an object`);
    }
    const key = observedFragmentKey(raw);
    if (!planned.has(key)) throw new Error(`lane fragment ${key} is not selected`);
    if (seen.has(key)) throw new Error(`duplicate lane fragment ${key}`);
    seen.add(key);
    for (const name of ["messagePath", "junitPath"]) {
      text(raw[name], `${key}.${name}`, RELATIVE_PATH);
      if (raw[name].split("/").includes(".."))
        throw new Error(`${key}.${name} is not relative-safe`);
      if (paths.has(raw[name])) throw new Error(`duplicate lane artifact path ${raw[name]}`);
      paths.add(raw[name]);
    }
    return {
      lane: raw.lane,
      shard: raw.shard,
      shardCount: raw.shardCount,
      messagePath: raw.messagePath,
      messageDigest: text(raw.messageDigest, `${key}.messageDigest`, DIGEST),
      junitPath: raw.junitPath,
      junitDigest: text(raw.junitDigest, `${key}.junitDigest`, DIGEST),
    };
  });
  return fragments.toSorted((left, right) =>
    lexical(laneFragmentKey(left), laneFragmentKey(right)),
  );
}

export function receivedFragmentEvidence(cell, fragments, plannedFragments) {
  const actualByKey = new Map(fragments.map((fragment) => [laneFragmentKey(fragment), fragment]));
  const requiredByLane = new Map();
  for (const fragment of plannedFragments) {
    const keys = requiredByLane.get(fragment.lane) ?? [];
    keys.push(laneFragmentKey(fragment));
    requiredByLane.set(fragment.lane, keys);
  }
  const receivedLanes = cell.requiredLanes.filter((lane) => {
    const required = requiredByLane.get(lane) ?? [];
    return required.length > 0 && required.every((key) => actualByKey.has(key));
  });
  const messageFragmentDigests = receivedLanes
    .flatMap((lane) =>
      (requiredByLane.get(lane) ?? []).map((key) => actualByKey.get(key).messageDigest),
    )
    .toSorted(lexical);
  return { receivedLanes, messageFragmentDigests };
}
