// The seven strict local read tools over the immutable snapshot.
//
// Each tool: parses its arguments strictly (extra args fail loud), enforces its
// role allowlist and — where locale-scoped — its target branch, computes the
// full deterministically-ordered result, then paginates with explicit row/byte
// bounds and returns a content-addressed envelope. All reads are pure functions
// of the read model: no model calls, no clock, no I/O.

import type { z } from "zod";

import { llmSha256, type LlmJsonValue } from "@itotori/db";

import {
  DECODE_GET_CHARACTER_OCCURRENCES_RESULT_SCHEMA_VERSION,
  DECODE_GET_NEIGHBORS_RESULT_SCHEMA_VERSION,
  DECODE_GET_ROUTE_GRAPH_RESULT_SCHEMA_VERSION,
  DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
  DecodeGetCharacterOccurrencesResultSchema,
  DecodeGetNeighborsResultSchema,
  DecodeGetRouteGraphResultSchema,
  DecodeGetUnitsResultSchema,
  FACT_SCHEMA_VERSION,
  GLOSSARY_LOOKUP_RESULT_SCHEMA_VERSION,
  GlossaryLookupResultSchema,
  OUTPUTS_GET_ACCEPTED_RESULT_SCHEMA_VERSION,
  OutputsGetAcceptedResultSchema,
  REFERENCES_SEARCH_RESULT_SCHEMA_VERSION,
  ReferencesSearchResultSchema,
  type DecodeGetCharacterOccurrencesResult,
  type DecodeGetNeighborsResult,
  type DecodeGetRouteGraphResult,
  type DecodeGetUnitsResult,
  type GlossaryLookupResult,
  type OutputsGetAcceptedResult,
  type ReferencesSearchResult,
  type AcceptedOutput,
  type ToolName,
  type UnitFact,
} from "../contracts/index.js";

import {
  ReadToolError,
  assertRoleAllowed,
  routeScopeVisible,
  type ReadToolCaller,
} from "./access.js";
import {
  DecodeGetCharacterOccurrencesArgsSchema,
  DecodeGetNeighborsArgsSchema,
  DecodeGetRouteGraphArgsSchema,
  DecodeGetUnitsArgsSchema,
  GlossaryLookupArgsSchema,
  OutputsGetAcceptedArgsSchema,
  ReferencesSearchArgsSchema,
} from "./args.js";
import {
  callerIdentity,
  finalizeResult,
  assertVisibleToCaller,
  isVisibleToCaller,
  parseArgs,
  requestHashOf,
  resolveExplicitUnit,
  routeScopeIntersection,
  routeScopeUnion,
  sceneVisibility,
  unitVisibility,
  visibleUnitFacts,
  type ReadFactVisibility,
} from "./engine.js";
import type { ReadModel, ReadModelLocalization } from "./model.js";
import { paginate } from "./pagination.js";
import {
  projectCharacterOccurrenceFact,
  projectRouteEdgeFact,
  projectRouteNodeFact,
} from "./projection.js";

interface EmitInput<TSchema extends z.ZodType> {
  model: ReadModel;
  caller: ReadToolCaller;
  tool: ToolName;
  schema: TSchema;
  schemaVersion: string;
  identityArgs: LlmJsonValue;
  cursor: string | null;
  maxRows: number;
  maxBytes: number;
  items: readonly LlmJsonValue[];
  key: string;
  extraStatic?: Record<string, LlmJsonValue>;
}

function emit<TSchema extends z.ZodType>(input: EmitInput<TSchema>): z.infer<TSchema> {
  const requestHash = requestHashOf(input.model.snapshotId, input.tool, {
    args: input.identityArgs,
    caller: callerIdentity(input.caller),
  });
  const { window, page } = paginate({
    items: input.items,
    cursor: input.cursor,
    maxRows: input.maxRows,
    maxBytes: input.maxBytes,
    requestHash,
  });
  return finalizeResult({
    schema: input.schema,
    schemaVersion: input.schemaVersion,
    tool: input.tool,
    snapshotId: input.model.snapshotId,
    requestHash,
    page,
    extra: { ...input.extraStatic, [input.key]: window },
  });
}

function jsonItems(facts: readonly unknown[]): readonly LlmJsonValue[] {
  return facts as readonly LlmJsonValue[];
}

function requireLocalization(model: ReadModel, caller: ReadToolCaller): ReadModelLocalization {
  const localization = model.localization;
  if (!localization) {
    throw new ReadToolError("locale-branch-mismatch", "no localization branch is bound");
  }
  if (caller.localeBranchId !== localization.localeBranchId) {
    throw new ReadToolError(
      "locale-branch-mismatch",
      `caller branch ${caller.localeBranchId ?? "none"} != ${localization.localeBranchId}`,
    );
  }
  return localization;
}

export function decodeGetUnits(
  model: ReadModel,
  caller: ReadToolCaller,
  raw: unknown,
): DecodeGetUnitsResult {
  const args = parseArgs(DecodeGetUnitsArgsSchema, raw);
  assertRoleAllowed("decode_get_units", caller.roleId);
  let facts: UnitFact[];
  if (args.selector.kind === "unit-ids") {
    const requested = [...new Set(args.selector.unitIds)];
    facts = requested.map((factId) => resolveExplicitUnit(model, caller, factId));
    facts.sort(byPlayOrder);
  } else {
    const visible = visibleUnitFacts(model, caller);
    if (args.selector.kind === "scene") {
      const sceneId = String(args.selector.sceneId);
      facts = visible.filter((fact) => fact.value.sceneId === sceneId);
    } else if (args.selector.kind === "play-order-range") {
      const { from, through } = args.selector;
      facts = visible.filter(
        (fact) => fact.value.playOrderIndex >= from && fact.value.playOrderIndex <= through,
      );
    } else {
      facts = visible;
    }
  }
  const { cursor, ...identityArgs } = args;
  return emit({
    model,
    caller,
    tool: "decode_get_units",
    schema: DecodeGetUnitsResultSchema,
    schemaVersion: DECODE_GET_UNITS_RESULT_SCHEMA_VERSION,
    identityArgs,
    cursor: cursor ?? null,
    maxRows: args.maxRows,
    maxBytes: args.maxBytes,
    items: jsonItems(facts),
    key: "facts",
  });
}

export function decodeGetNeighbors(
  model: ReadModel,
  caller: ReadToolCaller,
  raw: unknown,
): DecodeGetNeighborsResult {
  const args = parseArgs(DecodeGetNeighborsArgsSchema, raw);
  assertRoleAllowed("decode_get_neighbors", caller.roleId);
  const visible = visibleUnitFacts(model, caller);
  const positionByFactId = new Map(visible.map((fact, index) => [fact.factId, index]));
  const selected = new Set<number>();
  for (const anchorId of args.anchorUnitIds) {
    resolveExplicitUnit(model, caller, anchorId);
    const position = positionByFactId.get(anchorId)!;
    const first = Math.max(0, position - args.before);
    const last = Math.min(visible.length - 1, position + args.after);
    for (let index = first; index <= last; index += 1) selected.add(index);
  }
  const facts = [...selected].sort((a, b) => a - b).map((index) => visible[index]!);
  const { cursor, ...identityArgs } = args;
  return emit({
    model,
    caller,
    tool: "decode_get_neighbors",
    schema: DecodeGetNeighborsResultSchema,
    schemaVersion: DECODE_GET_NEIGHBORS_RESULT_SCHEMA_VERSION,
    identityArgs,
    cursor: cursor ?? null,
    maxRows: args.maxRows,
    maxBytes: args.maxBytes,
    items: jsonItems(facts),
    key: "facts",
    extraStatic: { anchorUnitIds: [...new Set(args.anchorUnitIds)].sort(byString) },
  });
}

export function decodeGetRouteGraph(
  model: ReadModel,
  caller: ReadToolCaller,
  raw: unknown,
): DecodeGetRouteGraphResult {
  const args = parseArgs(DecodeGetRouteGraphArgsSchema, raw);
  assertRoleAllowed("decode_get_route_graph", caller.roleId);
  const topology = model.factSnapshot.routeTopology;
  const sceneVisibilityById = new Map(
    model.factSnapshot.scenes.map((scene) => [scene.sceneId, sceneVisibility(model, scene)]),
  );
  const visibleSceneIds = new Set(
    model.factSnapshot.scenes
      .filter((scene) => isVisibleToCaller(model, caller, sceneVisibilityById.get(scene.sceneId)!))
      .map((scene) => scene.sceneId),
  );
  // Node adjacency is projected from exactly the graph this caller may see. A
  // visible node must not reveal an out-of-route or beyond-horizon neighbor.
  const visibleEdges = topology.edges.filter(
    (edge) => visibleSceneIds.has(edge.fromSceneId) && visibleSceneIds.has(edge.toSceneId),
  );
  const visibleTopology = { ...topology, edges: visibleEdges };
  const nodes = [...model.factSnapshot.scenes]
    .filter((scene) => visibleSceneIds.has(scene.sceneId))
    .sort((a, b) => a.sceneId.localeCompare(b.sceneId))
    .map((scene) =>
      projectRouteNodeFact(
        scene,
        visibleTopology,
        model.snapshotId,
        sceneVisibilityById.get(scene.sceneId)!,
      ),
    );
  const edges = visibleEdges.map((edge) => {
    const fromVisibility = sceneVisibilityById.get(edge.fromSceneId)!;
    const toVisibility = sceneVisibilityById.get(edge.toSceneId)!;
    const sharedScope = routeScopeIntersection(fromVisibility.routeScope, toVisibility.routeScope);
    const visibility: ReadFactVisibility = {
      // A cross-route edge with no shared route is only present for a global
      // caller (both endpoint checks above fail for any route caller).
      routeScope: sharedScope ?? { kind: "global" },
      fromPlayOrder: Math.max(fromVisibility.fromPlayOrder, toVisibility.fromPlayOrder),
    };
    return projectRouteEdgeFact(edge, model.snapshotId, visibility);
  });
  const facts = [...nodes, ...edges];
  const { cursor, ...identityArgs } = args;
  return emit({
    model,
    caller,
    tool: "decode_get_route_graph",
    schema: DecodeGetRouteGraphResultSchema,
    schemaVersion: DECODE_GET_ROUTE_GRAPH_RESULT_SCHEMA_VERSION,
    identityArgs,
    cursor: cursor ?? null,
    maxRows: args.maxRows,
    maxBytes: args.maxBytes,
    items: jsonItems(facts),
    key: "facts",
    extraStatic: {
      coverage: {
        archiveSceneCount: nodes.length,
        emittedSceneCount: nodes.length,
        unresolvedEdgeCount: 0,
        truncated: false,
      },
    },
  });
}

export function decodeGetCharacterOccurrences(
  model: ReadModel,
  caller: ReadToolCaller,
  raw: unknown,
): DecodeGetCharacterOccurrencesResult {
  const args = parseArgs(DecodeGetCharacterOccurrencesArgsSchema, raw);
  assertRoleAllowed("decode_get_character_occurrences", caller.roleId);
  const fact = model.factSnapshot.characters.find(
    (candidate) => candidate.characterId === args.characterId,
  );
  if (!fact) throw new ReadToolError("unknown-subject", `no character ${args.characterId}`);
  const profile = model.characterProfiles.get(args.characterId);
  if (!profile) {
    throw new ReadToolError("unknown-subject", `no profile for character ${args.characterId}`);
  }
  if (profile.revealStatus === "reader-unknown") {
    throw new ReadToolError(
      "beyond-reveal-horizon",
      `character ${args.characterId} has not been revealed to the reader`,
    );
  }
  const visibility = characterVisibility(model, fact.sceneIds);
  assertVisibleToCaller(model, caller, visibility, `character ${args.characterId}`);
  // Profile evidence ids are also part of the emitted aggregate, so every one
  // must be readable; otherwise the aggregate could smuggle a hidden unit id.
  for (const unitId of profile.unitIds) resolveExplicitUnit(model, caller, unitId);
  const projected = projectCharacterOccurrenceFact(fact, profile, model.snapshotId, visibility);
  const { cursor, ...identityArgs } = args;
  return emit({
    model,
    caller,
    tool: "decode_get_character_occurrences",
    schema: DecodeGetCharacterOccurrencesResultSchema,
    schemaVersion: DECODE_GET_CHARACTER_OCCURRENCES_RESULT_SCHEMA_VERSION,
    identityArgs,
    cursor: cursor ?? null,
    maxRows: args.maxRows,
    maxBytes: args.maxBytes,
    items: jsonItems([projected]),
    key: "facts",
  });
}

export function glossaryLookup(
  model: ReadModel,
  caller: ReadToolCaller,
  raw: unknown,
): GlossaryLookupResult {
  const args = parseArgs(GlossaryLookupArgsSchema, raw);
  assertRoleAllowed("glossary_lookup", caller.roleId);
  const localization = requireLocalization(model, caller);
  let entries = [...localization.glossaryEntries];
  if (args.selector.kind === "term-ids") {
    const ids = new Set(args.selector.termIds);
    entries = entries.filter((entry) => ids.has(entry.termId));
  } else if (args.selector.kind === "source-forms") {
    const forms = new Set(args.selector.forms);
    entries = entries.filter(
      (entry) => forms.has(entry.sourceForm) || entry.aliases.some((alias) => forms.has(alias)),
    );
  }
  const explicitSelector = args.selector.kind !== "all";
  const facts = entries
    .sort((a, b) => byString(a.termId, b.termId))
    .flatMap((value) => {
      try {
        const visibility = glossaryVisibility(model, caller, value);
        return [
          sealFact(`glossary:${value.termId}`, "glossary", value, model.snapshotId, visibility),
        ];
      } catch (error) {
        if (
          explicitSelector ||
          !(error instanceof ReadToolError) ||
          (error.code !== "beyond-reveal-horizon" && error.code !== "out-of-route")
        ) {
          throw error;
        }
        return [];
      }
    });
  const { cursor, ...identityArgs } = args;
  return emit({
    model,
    caller,
    tool: "glossary_lookup",
    schema: GlossaryLookupResultSchema,
    schemaVersion: GLOSSARY_LOOKUP_RESULT_SCHEMA_VERSION,
    identityArgs,
    cursor: cursor ?? null,
    maxRows: args.maxRows,
    maxBytes: args.maxBytes,
    items: jsonItems(facts),
    key: "facts",
    extraStatic: { glossaryRevisionHash: localization.glossaryRevision.contentHash },
  });
}

export function outputsGetAccepted(
  model: ReadModel,
  caller: ReadToolCaller,
  raw: unknown,
): OutputsGetAcceptedResult {
  const args = parseArgs(OutputsGetAcceptedArgsSchema, raw);
  assertRoleAllowed("outputs_get_accepted", caller.roleId);
  const localization = requireLocalization(model, caller);
  for (const subjectId of args.subjectIds) {
    const unit = model.factSnapshot.orderedUnits.find(
      (candidate) => candidate.factId === subjectId,
    );
    if (unit) resolveExplicitUnit(model, caller, subjectId);
  }
  const subjects = new Set(args.subjectIds);
  const matchingOutputs = localization.acceptedOutputs
    .filter((output) => subjects.has(output.subjectId))
    .filter((output) => args.stage === undefined || output.stage === args.stage)
    .sort((a, b) => byString(a.outputId, b.outputId));
  const outputs = matchingOutputs.map((output) => {
    assertVisibleToCaller(
      model,
      caller,
      acceptedOutputVisibility(model, output),
      `output ${output.outputId}`,
    );
    return output;
  });
  const identityArgs: LlmJsonValue = {
    subjectIds: args.subjectIds,
    maxRows: args.maxRows,
    maxBytes: args.maxBytes,
    ...(args.stage === undefined ? {} : { stage: args.stage }),
  };
  return emit({
    model,
    caller,
    tool: "outputs_get_accepted",
    schema: OutputsGetAcceptedResultSchema,
    schemaVersion: OUTPUTS_GET_ACCEPTED_RESULT_SCHEMA_VERSION,
    identityArgs,
    cursor: args.cursor ?? null,
    maxRows: args.maxRows,
    maxBytes: args.maxBytes,
    items: jsonItems(outputs),
    key: "outputs",
  });
}

export function referencesSearch(
  model: ReadModel,
  caller: ReadToolCaller,
  raw: unknown,
): ReferencesSearchResult {
  const args = parseArgs(ReferencesSearchArgsSchema, raw);
  assertRoleAllowed("references_search", caller.roleId);
  const queryTokens = tokenize(args.query);
  const hits = model.references
    .filter((value) => routeScopeVisible(value.scope, caller.routeVisibility))
    .map((value) => ({
      value,
      score: lexicalScore(queryTokens, tokenize(value.excerpt)),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || byString(a.value.noteId, b.value.noteId))
    .map((entry) => ({
      fact: sealFact(
        `human-note:${entry.value.noteId}`,
        "human-note",
        entry.value,
        model.snapshotId,
        { routeScope: entry.value.scope, fromPlayOrder: 0 },
      ),
      lexicalScore: entry.score,
      vectorScore: null,
    }));
  const { cursor, ...identityArgs } = args;
  return emit({
    model,
    caller,
    tool: "references_search",
    schema: ReferencesSearchResultSchema,
    schemaVersion: REFERENCES_SEARCH_RESULT_SCHEMA_VERSION,
    identityArgs,
    cursor: cursor ?? null,
    maxRows: args.maxRows,
    maxBytes: args.maxBytes,
    items: jsonItems(hits),
    key: "hits",
  });
}

function sealFact(
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
function characterVisibility(model: ReadModel, sceneIds: readonly string[]): ReadFactVisibility {
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
function glossaryVisibility(
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
function acceptedOutputVisibility(model: ReadModel, output: AcceptedOutput): ReadFactVisibility {
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

function byPlayOrder(a: UnitFact, b: UnitFact): number {
  return a.value.playOrderIndex - b.value.playOrderIndex || byString(a.factId, b.factId);
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 0),
  );
}

function lexicalScore(query: Set<string>, target: Set<string>): number {
  if (query.size === 0) return 0;
  let overlap = 0;
  for (const token of query) if (target.has(token)) overlap += 1;
  return overlap / query.size;
}
