// Coalesce a session's human inputs into ONE delta and apply the deterministic
// part (edits) exactly.
//
// A session is a burst of direct edits and general feedback the human makes
// against one object before an intentional apply boundary. Edits are exact,
// mechanical operations (replace text / replace integer / remove field) that
// this module applies verbatim — the human's bytes land unchanged. Feedback is
// free text the later enhancement reasons over. Coalescing records which leaf
// paths the human touched and which the feedback implicates, so reconciliation
// can preserve everything else.

import { sha256 } from "../../llm/canonical-json.js";
import type { HumanInput } from "../../contracts/index.js";
import {
  getAtPath,
  isPathWithin,
  pathKey,
  withoutValueAtPath,
  withValueAtPath,
  type FieldPath,
  type JsonValue,
} from "./field-path.js";

type EditInput = Extract<HumanInput, { kind: "edit" }>;
type FeedbackInput = Extract<HumanInput, { kind: "feedback" }>;

export class HumanDeltaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanDeltaError";
  }
}

/** The coalesced result of a whole session, ready to feed one enhancement. */
export interface CoalescedHumanDelta {
  readonly inputs: readonly HumanInput[];
  readonly edits: readonly EditInput[];
  readonly feedbacks: readonly FeedbackInput[];
  /** Leaf paths whose value a human edit set. Preserve these verbatim. */
  readonly humanTouchedPaths: readonly FieldPath[];
  /** Path subtrees the feedback explicitly implicates. */
  readonly feedbackTargetPaths: readonly FieldPath[];
  /** A general (untargeted) feedback lets the enhancement adjust the body only. */
  readonly hasGeneralFeedback: boolean;
}

/** Partition the session inputs and record touched/implicated paths. */
export function coalesceHumanDelta(inputs: readonly HumanInput[]): CoalescedHumanDelta {
  const edits: EditInput[] = [];
  const feedbacks: FeedbackInput[] = [];
  const humanTouched = new Map<string, FieldPath>();
  const feedbackTargets = new Map<string, FieldPath>();
  let hasGeneralFeedback = false;

  for (const input of inputs) {
    if (input.kind === "edit") {
      edits.push(input);
      for (const operation of input.operations) {
        humanTouched.set(pathKey(operation.fieldPath), operation.fieldPath);
      }
      continue;
    }
    feedbacks.push(input);
    if (input.targetFieldPath) {
      feedbackTargets.set(pathKey(input.targetFieldPath), input.targetFieldPath);
    } else if (input.targetClaimId === undefined) {
      hasGeneralFeedback = true;
    }
  }

  return {
    inputs,
    edits,
    feedbacks,
    humanTouchedPaths: [...humanTouched.values()],
    feedbackTargetPaths: [...feedbackTargets.values()],
    hasGeneralFeedback,
  };
}

/** Apply one edit's operations to the object, in order, verifying each stated
 * `before`/`priorValueHash` against the CURRENT value. A stale or mismatched
 * edit is rejected — an edit never silently overwrites a value the human did
 * not actually see. Returns a new object; the input is not mutated. */
export function applyEdit(objectJson: JsonValue, edit: EditInput): JsonValue {
  let current = objectJson;
  for (const operation of edit.operations) {
    const existing = getAtPath(current, operation.fieldPath);
    if (operation.kind === "replace-text") {
      if (existing !== operation.before) {
        throw new HumanDeltaError(
          `edit ${edit.inputId} expected prior text at [${operation.fieldPath.join(", ")}] to match`,
        );
      }
      current = withValueAtPath(current, operation.fieldPath, operation.after);
      continue;
    }
    if (operation.kind === "replace-integer") {
      if (existing !== operation.before) {
        throw new HumanDeltaError(
          `edit ${edit.inputId} expected prior integer at [${operation.fieldPath.join(", ")}] to match`,
        );
      }
      current = withValueAtPath(current, operation.fieldPath, operation.after);
      continue;
    }
    // remove-field
    if (existing === undefined) {
      throw new HumanDeltaError(
        `edit ${edit.inputId} cannot remove absent field [${operation.fieldPath.join(", ")}]`,
      );
    }
    if (sha256(existing) !== operation.priorValueHash) {
      throw new HumanDeltaError(
        `edit ${edit.inputId} prior-value hash mismatch at [${operation.fieldPath.join(", ")}]`,
      );
    }
    current = withoutValueAtPath(current, operation.fieldPath);
  }
  return current;
}

/** Apply every edit in the delta, in order, to `objectJson`. */
export function applyDeltaEdits(objectJson: JsonValue, delta: CoalescedHumanDelta): JsonValue {
  let current = objectJson;
  for (const edit of delta.edits) current = applyEdit(current, edit);
  return current;
}

/** True when a leaf path was set by a human edit. */
export function isHumanTouched(path: FieldPath, delta: CoalescedHumanDelta): boolean {
  return delta.humanTouchedPaths.some((touched) => pathKey(touched) === pathKey(path));
}

/** True when the enhancement is allowed to change a non-human leaf at `path`:
 * inside a feedback-target subtree, or anywhere in the body when the session
 * carried general feedback. Everything else is preserved verbatim. */
export function isEnhancementAffected(path: FieldPath, delta: CoalescedHumanDelta): boolean {
  if (delta.feedbackTargetPaths.some((target) => isPathWithin(path, target))) return true;
  return delta.hasGeneralFeedback && isPathWithin(path, ["body"]);
}
