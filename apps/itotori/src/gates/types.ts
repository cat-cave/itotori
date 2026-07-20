// Inputs for the deterministic localization + evidence gates.
//
// Every gate is a PURE function of (immutable fact snapshot, accepted output)
// plus, where a gate needs it, an approved-glossary / box-limit / context-fact
// / render-fact side input that is itself content-addressed. No gate reads a
// model finding, a clock, the network, or mutable state: same inputs ⇒ same
// verdict. The snapshot facts DOMINATE — a gate verdict is grounded on a cited
// fact id and cannot be overridden by a reviewer (see ./join.ts).

import type { AcceptedOutput, Fact, RenderAndOcrResult } from "../contracts/index.js";
import type { SurfaceKindV02 } from "@itotori/localization-bridge-schema";
import type { FactSnapshot } from "../prepass/index.js";

import type { LocalizationTargetPolicy } from "./policy/types.js";

/** The unit-subject accepted output — the only accepted-output kind the
 * per-unit gates evaluate (a translated target for one ordered unit). */
export type AcceptedUnitOutput = Extract<AcceptedOutput, { subjectType: "unit" }>;

/** An approved glossary target form the exact-names gate enforces. `termId` is
 * a stable glossary fact id (used as the defect's grounding evidence). A source
 * form that occurs in a unit MUST render as `requiredTargetForm`; any listed
 * `forbiddenTargetForms` must be absent. */
export type GlossaryApprovedForm = {
  termId: string;
  sourceForm: string;
  requiredTargetForm: string;
  forbiddenTargetForms: readonly string[];
};

/** Per-surface byte / box budget. `maxBytes` bounds the whole target's Shift-JIS
 * byte length; `maxLineBytes` (optional) bounds each wrapped line. */
export type BoxLimit = {
  maxBytes: number;
  maxLineBytes?: number;
};

export type BoxLimitPolicy = Partial<Record<SurfaceKindV02, BoxLimit>>;

/** The set of unit fact ids that must be covered by an accepted output for the
 * scoped work to be complete (work-scope reachability + patch coverage). When
 * omitted, the snapshot's reachable unit set is used. */
export type WorkScope = {
  inScopeUnitFactIds: readonly string[];
};

/** Everything a full deterministic-gate pass may read. Only `snapshot` and
 * `accepted` are always required; a gate that needs a missing side input fails
 * loud rather than skipping (see GateEvaluationError). */
export type DeterministicGateInput = {
  snapshot: FactSnapshot;
  accepted: readonly AcceptedUnitOutput[];
  /** The localization target policy supplied by the extract/patch adapter. It
   * selects the encoding, layout (byte/box), and control-marker gates; the
   * universal semantic gates ignore it. */
  policy: LocalizationTargetPolicy;
  glossary?: readonly GlossaryApprovedForm[];
  /** Optional per-surface budget overrides that TIGHTEN the policy's budgets. */
  boxLimits?: BoxLimitPolicy;
  /** Context facts (each carrying its snapshotId + visibility) that accepted
   * outputs / reviewers cite as evidence — consumed by the evidence-scope gate. */
  contextFacts?: readonly Fact[];
  /** The context snapshot id evidence must belong to (same-snapshot check). */
  contextSnapshotId?: string;
  render?: RenderAndOcrResult | null;
  workScope?: WorkScope;
};
