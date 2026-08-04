// CI selector routing derived from discovered per-test ownership declarations.
// Fixed orchestration lanes are command capabilities; test-owned lanes are not
// a manually maintained selector registry.

import {
  APP_SUITE_SHARDS,
  DB_OWNED_LANE,
  PORTABLE_APP_LANE,
  discoverTestOwnership,
  laneOwnershipFailures,
} from "./test-ownership.mjs";

const FIXED_CI_LANES = Object.freeze([
  "public",
  "tier0",
  "tier0-meta",
  "tier0-ts",
  "tier0-rust",
  "tier0-manifest",
  "tier1-rust-1of3",
  "tier1-rust-2of3",
  "tier1-rust-3of3",
  "tier1-browser",
  "tier1-mutation",
  "tier1-behavior",
  "private-real-bytes",
]);

function expandedLanes(entry) {
  return entry.lanes[0] === PORTABLE_APP_LANE ? APP_SUITE_SHARDS : entry.lanes;
}

function selectorFor(lane) {
  return lane.startsWith("ci-") ? lane.slice(3) : lane;
}

function kindFor(entry) {
  return entry.lanes[0] === DB_OWNED_LANE ? "db-owned-app" : "public-test";
}

export function derivedCiRouting(root) {
  const ownerships = discoverTestOwnership(root);
  const failures = laneOwnershipFailures(ownerships);
  if (failures.length > 0) {
    throw new Error(`test ownership routing failed: ${failures.join("; ")}`);
  }
  const kinds = new Map();
  for (const entry of ownerships) {
    for (const declaredLane of expandedLanes(entry)) {
      const lane = selectorFor(declaredLane);
      const kind = kindFor(entry);
      const previous = kinds.get(lane);
      if (previous !== undefined && previous !== kind) {
        throw new Error(`test ownership routing has incompatible routes for ${lane}`);
      }
      kinds.set(lane, kind);
    }
  }
  return Object.freeze({
    lanes: Object.freeze([...new Set([...FIXED_CI_LANES, ...kinds.keys()])].toSorted()),
    kindForLane: (lane) => kinds.get(lane) ?? null,
  });
}
