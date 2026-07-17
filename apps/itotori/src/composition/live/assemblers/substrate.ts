// The shared, deterministic substrate the live workflow-port assemblers project
// role inputs from. NONE of this dispatches a model: it is the decode fact
// snapshot, the installed bible, the bridge source units, and the run-scoped
// snapshot ids the driver's light work-item shapes do not carry. The role model
// call happens INSIDE each role — the assemblers only build the exact input the
// role consumes, as a pure `(facts, scene, defects/verdicts) → input` projection.
//
// The FACTORY that sources this substrate (the fact snapshot from the pre-pass /
// DB, the bridge units from decode, the localized bible from the wiki store, the
// ZDR dispatch runtimes) needs a live Postgres + ZDR run to strict-prove and is
// left for the live lane. These assembler builders take the substrate as an
// explicit, injected value so the projection stays deterministic and testable.

import type { LocalizationUnitV02 } from "@itotori/localization-bridge-schema";

import type { UnitFact } from "../../../contracts/index.js";
import type {
  InstalledBible,
  RequirementOptions,
} from "../../../localized-wiki/ground-truth/index.js";
import type { FactSnapshot, OrderedUnitFact } from "../../../prepass/index.js";
import { projectUnitFact } from "../../../read-tools/projection.js";

/** A `sha256:`-prefixed content hash — the id shape the role inputs demand. */
export type Sha256Hash = `sha256:${string}`;

/** The decode-derived fact source: the immutable snapshot plus the per-unit
 * accessors the projections read. `orderedFact` resolves a unit's ordered decode
 * fact (by fact id); `bridgeUnit` resolves its Bridge v0.2 source unit (the
 * verbatim source text + asset ref `projectUnitFact` masks into a skeleton). */
export interface DecodeFactSource {
  readonly snapshot: FactSnapshot;
  /** The ordered decode fact for a unit id, or throw if absent (a control-flow
   * bug — the driver only asks for units the snapshot carries). */
  orderedFact(unitId: string): OrderedUnitFact;
  /** The Bridge v0.2 source unit for a unit id (source surface + asset ref). */
  bridgeUnit(unitId: string): LocalizationUnitV02;
}

/** The run-scoped snapshot ids + realization policy the role inputs stamp. These
 * are constant for a run; the driver's work-item shapes do not carry them. */
export interface RunScopeConfig {
  readonly contextSnapshotId: Sha256Hash;
  readonly localizationSnapshotId: Sha256Hash;
  /** The output schema hash the P1/P2/P3 calls pin (draft-batch schema). */
  readonly schemaHash: Sha256Hash;
  readonly runMode: "production" | "pilot" | "test-dev";
  readonly contextScope: "whole-game" | "external-augmented" | `narrowed:${string}`;
}

/** Raised when an assembler cannot build a role's EXACT input from the threaded
 * state — a loud, typed refusal, never an approximated input. */
export class AssemblerError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`assembler ${code}: ${detail}`);
    this.name = "AssemblerError";
  }
}

/** Project the strict `UnitFact` for one unit from its ordered decode fact + its
 * bridge source unit. Delegates to the read-tools projection so the masking
 * skeleton + protected placeholders are byte-identical to what the gates and the
 * ground-truth resolver see — the placeholders/SJIS are preserved by that single
 * source of truth, never re-derived here. */
export function projectSceneUnitFact(unitId: string, facts: DecodeFactSource): UnitFact {
  const ordered = facts.orderedFact(unitId);
  const bridge = facts.bridgeUnit(unitId);
  return projectUnitFact(ordered, bridge, facts.snapshot.snapshotId);
}

/** Project the strict `UnitFact[]` for a set of units, in the given order. */
export function projectSceneUnitFacts(
  unitIds: readonly string[],
  facts: DecodeFactSource,
): readonly UnitFact[] {
  return unitIds.map((unitId) => projectSceneUnitFact(unitId, facts));
}

/** A `DecodeFactSource` backed by the snapshot's ordered units + a bridge-unit
 * map. The production factory binds the real bridge bundle; a proof binds a
 * fixture map. Fails loud on an unknown unit — never a silent skip. */
export function decodeFactSourceFrom(
  snapshot: FactSnapshot,
  bridgeUnits: ReadonlyMap<string, LocalizationUnitV02>,
): DecodeFactSource {
  const orderedById = new Map<string, OrderedUnitFact>(
    snapshot.orderedUnits.map((unit) => [unit.factId, unit]),
  );
  return {
    snapshot,
    orderedFact(unitId: string): OrderedUnitFact {
      const fact = orderedById.get(unitId);
      if (fact === undefined) {
        throw new AssemblerError("unknown-unit", `snapshot has no ordered fact for unit ${unitId}`);
      }
      return fact;
    },
    bridgeUnit(unitId: string): LocalizationUnitV02 {
      const bridge = bridgeUnits.get(unitId);
      if (bridge === undefined) {
        throw new AssemblerError("unknown-unit", `no bridge source unit for unit ${unitId}`);
      }
      return bridge;
    },
  };
}

/** Requirement options for the ground-truth resolution, defaulting to the full
 * style + arc requirement set the production resolver uses. */
export type { RequirementOptions };
export type { InstalledBible };
