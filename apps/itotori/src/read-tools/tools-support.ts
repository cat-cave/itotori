import { llmSha256, type LlmJsonValue } from "@itotori/db";

import { FACT_SCHEMA_VERSION, type AcceptedOutput, type UnitFact } from "../contracts/index.js";

import { ReadToolError, type ReadToolCaller } from "./access.js";
import {
  assertVisibleToCaller,
  resolveExplicitUnit,
  routeScopeUnion,
  sceneVisibility,
  unitVisibility,
  type ReadFactVisibility,
} from "./engine.js";
import type { ReadModel, ReadModelLocalization } from "./model.js";

export function sealFact(
  factId: string,
  source: "glossary" | "human-note",
  value: LlmJsonValue,
  snapshotId: string,
  visibility: ReadFactVisibility,
) {
  return {
    schemaVersion: FACT_SCHEMA_VERSION,
    factId,
    snapshotId,
    hash: llmSha256(value),
    visibility: { ...visibility, throughPlayOrder: null },
    source,
    value,
  };
}

/** An occurrence aggregate is all-or-nothing: returning its total counts,
 * scene ids, and unit ids before every covered scene is visible would disclose
 * hidden-route or future content. */
export function characterVisibility(
  model: ReadModel,
  sceneIds: readonly string[],
): ReadFactVisibility {
  const sceneById = new Map(model.factSnapshot.scenes.map((scene) => [scene.sceneId, scene]));
  const boundaries = sceneIds.map((sceneId) => {
    const scene = sceneById.get(sceneId);
    if (!scene) {
      throw new ReadToolError("snapshot-integrity", `character occurrence cites scene ${sceneId}`);
    }
    return sceneVisibility(model, scene);
  });
  return {
    routeScope: routeScopeUnion(boundaries.map((boundary) => boundary.routeScope)),
    fromPlayOrder: Math.max(...boundaries.map((boundary) => boundary.fromPlayOrder)),
  };
}

/** A glossary fact exposes every occurrence id, so it is readable only when
 * the term scope and every cited occurrence are visible to the caller. */
export function glossaryVisibility(
  model: ReadModel,
  caller: ReadToolCaller,
  value: ReadModelLocalization["glossaryEntries"][number],
): ReadFactVisibility {
  const occurrencePositions: number[] = [];
  assertVisibleToCaller(
    model,
    caller,
    { routeScope: value.scope, fromPlayOrder: 0 },
    `glossary ${value.termId}`,
  );
  for (const unitId of value.occurrenceUnitIds) {
    const fact = resolveExplicitUnit(model, caller, unitId);
    occurrencePositions.push(fact.visibility.fromPlayOrder);
  }
  return {
    routeScope: value.scope,
    fromPlayOrder: occurrencePositions.length === 0 ? 0 : Math.min(...occurrencePositions),
  };
}

/** Every accepted artifact carries either its unit's exact snapshot boundary or
 * an artifact scope plus the latest evidence/dependency reveal point it
 * exposes.  Source-Wiki outputs are rejected while building the localization
 * read model, so no target-branch tool can cross that snapshot boundary. */
export function acceptedOutputVisibility(
  model: ReadModel,
  output: AcceptedOutput,
): ReadFactVisibility {
  if (output.subjectType === "unit") {
    const unit = model.factSnapshot.orderedUnits.find(
      (candidate) => candidate.factId === output.subjectId,
    );
    if (!unit) {
      throw new ReadToolError(
        "snapshot-integrity",
        `accepted output ${output.outputId} has no unit`,
      );
    }
    return unitVisibility(unit);
  }
  if (output.subjectType === "translation-object") {
    return {
      routeScope: output.value.scope,
      fromPlayOrder: Math.max(
        0,
        ...output.value.claims.flatMap((claim) =>
          claim.citations.map((citation) => citation.playOrderIndex),
        ),
        ...output.value.dependencies.flatMap((dependency) =>
          dependency.fromPlayOrder === null ? [] : [dependency.fromPlayOrder],
        ),
      ),
    };
  }
  if (output.subjectType === "localized-rendering") {
    return {
      routeScope: output.value.scope,
      fromPlayOrder: Math.max(
        0,
        ...output.value.dependencies.flatMap((dependency) =>
          dependency.fromPlayOrder === null ? [] : [dependency.fromPlayOrder],
        ),
      ),
    };
  }
  throw new ReadToolError(
    "snapshot-integrity",
    `source-Wiki output ${output.outputId} escaped localization binding`,
  );
}

export function byPlayOrder(a: UnitFact, b: UnitFact): number {
  return a.value.playOrderIndex - b.value.playOrderIndex || byString(a.factId, b.factId);
}

export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0),
  );
}

export function lexicalScore(query: Set<string>, target: Set<string>): number {
  if (query.size === 0) return 0;
  let overlap = 0;
  for (const token of query) if (target.has(token)) overlap += 1;
  return overlap / query.size;
}
