// Build the Semantic Repair CALL for one defect bundle.
//
// The repair is a FRESH BLINDED GROUNDED FORK, not a continuation of the
// candidate's author thread. So the call opens a brand-new conversation —
// exactly a system turn (the specialist instructions) and one user turn (the
// grounded seed) — with NO assistant author-thread turn and no reference to
// whoever produced the candidate. The seed grounds the fork in the pre-draft
// source skeletons plus the localized-bible rendering ids, and hands it the
// current candidate together with the EXACT failing spans, evidence, and repair
// constraints, plus the diagnostic tripwires the repair must not trip. The fork
// forks from a DISTINCT parent event keyed on the defect bundle — never on the
// candidate's transcript — so the repair cannot inherit the author's context.
//
// This module constructs the CallSpec and its plaintext payloads only; it opens
// no provider client and performs no network I/O. `dispatchRepairCall` hands the
// spec to the single ZDR boundary.

import {
  CALL_SPEC_SCHEMA_VERSION,
  DRAFT_BATCH_SCHEMA_VERSION,
  assertNoProviderPin,
} from "../../contracts/index.js";
import type { CallResult, CallSpec } from "../../contracts/index.js";
import { canonicalJson, sha256 } from "../../llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../../llm/role-model-profiles.js";
import { dispatch, type DispatchRuntime } from "../../llm/dispatch.js";
import { specialistFor, type Specialist } from "../../roster/index.js";
import type { NormalizedRepair } from "./normalize.js";

type ConversationMessage = CallSpec["messages"][number];

/** The repair mode this role always takes — a fresh grounded fork, never an
 * author continuation. Naming it here keeps the guarantee in one place. */
export const REPAIR_MODE = "fresh-grounded-fork" as const;

export interface BuildRepairCallInput {
  readonly specialist: Specialist;
  readonly normalized: NormalizedRepair;
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly runMode: CallSpec["runMode"];
  readonly contextScope: CallSpec["contextScope"];
  readonly schemaHash: `sha256:${string}`;
}

export interface RepairCall {
  readonly spec: CallSpec;
  /** Plaintext payloads keyed by storage ref, resolved by the dispatcher. */
  readonly payloads: ReadonlyMap<string, string>;
  readonly normalized: NormalizedRepair;
}

interface DraftableMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** The grounded, blinded seed. Each failing unit carries its source skeleton and
 * protected placeholders (the ground), its anonymous current candidate, and the
 * exact defects to repair. `preDraftContext` carries the source/wiki/bible facts
 * the original localizer had before drafting. There is deliberately no author
 * attribution and no previous repair rationale. */
function buildMessages(input: BuildRepairCallInput): readonly DraftableMessage[] {
  const { normalized } = input;
  const units = normalized.failedUnitIds.map((unitId) => {
    const candidate = normalized.candidatesById.get(unitId)!;
    const defects = (normalized.defectsByUnit.get(unitId) ?? []).map((defect) => ({
      defectId: defect.defectId,
      severity: defect.severity,
      span: defect.span,
      repairConstraint: defect.repairConstraint,
      evidenceIds: defect.evidenceIds,
    }));
    return {
      unitId,
      role: "failed" as const,
      sourceHash: candidate.sourceHash,
      sourceSkeleton: candidate.sourceSkeleton,
      protectedPlaceholders: candidate.protectedPlaceholders,
      surfaceKind: candidate.surfaceKind ?? null,
      choiceContext: candidate.choiceContext ?? null,
      candidate: candidate.currentTargetSkeleton,
      defects,
    };
  });
  const seed = {
    kind: "semantic-repair-seed",
    repairMode: REPAIR_MODE,
    parentDraftBatchId: normalized.candidateBatchId,
    defectBundleId: normalized.defectBundleId,
    failedUnitIds: normalized.failedUnitIds,
    bibleRenderingIds: normalized.bibleRenderingIds,
    preDraftContext: normalized.preDraftContext,
    localizationSnapshotId: normalized.localizationSnapshotId,
    tripwires: normalized.tripwires,
    units,
  };
  // System instructions, then the single grounded user seed — no author thread.
  return [
    { role: "system", content: input.specialist.instructions },
    { role: "user", content: JSON.stringify(seed) },
  ];
}

/** Build the Semantic Repair CallSpec + plaintext payloads. The route is the
 * certified deepseek-v4-flash profile with the no-provider-pin ZDR policy; the
 * terminal schema is a draft-batch (a repair-patch scope). */
export function buildRepairCall(input: BuildRepairCallInput): RepairCall {
  if (input.specialist.roleId !== "P3") {
    throw new Error(
      `p3 call: specialist ${input.specialist.roleId} is not the Semantic Repair role`,
    );
  }
  const drafted = buildMessages(input);
  const payloads = new Map<string, string>();
  const messages: ConversationMessage[] = drafted.map((message, index) => {
    const contentHash = sha256(message.content);
    const storageRef = `payload:${index}:${contentHash.slice("sha256:".length, "sha256:".length + 16)}`;
    payloads.set(storageRef, message.content);
    return {
      kind: "text",
      eventId: sha256({ role: message.role, index, contentHash }),
      role: message.role,
      contentEncrypted: { storageRef, contentHash, encryption: "operator-managed" },
    };
  });

  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "repair",
    roleId: "P3",
    modelProfile: input.specialist.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
    // A FRESH FORK: the parent event is keyed on the defect bundle and failed
    // set — never on the candidate's transcript — so the repair cannot inherit
    // the author's context. Deterministic in the bundle, so a re-run memoizes.
    parentEventId: sha256({
      fork: "fresh-grounded",
      contextSnapshotId: input.contextSnapshotId,
      localizationSnapshotId: input.localizationSnapshotId,
      defectBundleId: input.normalized.defectBundleId,
      failedUnitIds: input.normalized.failedUnitIds,
    }),
    contextSnapshotId: input.contextSnapshotId,
    localizationSnapshotId: input.localizationSnapshotId,
    messages,
    tools: [],
    output: {
      name: "draft-batch",
      schemaVersion: DRAFT_BATCH_SCHEMA_VERSION,
      schemaHash: input.schemaHash,
    },
    promptVersion: input.specialist.version,
    reasoning: input.specialist.reasoning,
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: {
      // The fresh fork gets exactly ONE response. A rejected repair does not
      // become a second prompt/response pair; `repairSemanticDefects` routes it
      // to adjudication with a human-review artifact instead.
      maxSteps: 1,
      maxToolCalls: 0,
      maxParallelTools: 1,
      maxOutputTokens: input.specialist.limits.maxOutputTokens,
      timeoutClass: input.specialist.limits.timeoutClass,
    },
    sampleId: null,
    runMode: input.runMode,
    contextScope: input.contextScope,
  };
  return { spec, payloads, normalized: input.normalized };
}

export type RepairRuntimeBase = Omit<DispatchRuntime, "readPayload">;

/** Bind P3 to its RB-019 profile and the account-wide ZDR fallback policy in
 * every run mode. The shared dispatcher deliberately relaxes its route check in
 * test-dev, so this guard is the role-level proof that a forged P3 call cannot
 * reach a provider in any mode. */
export function assertCertifiedP3Route(spec: CallSpec): void {
  const specialist = specialistFor("P3");
  const actual = {
    roleId: spec.roleId,
    modelProfile: spec.modelProfile,
    modelProfileVersion: spec.modelProfileVersion,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
  };
  const expected = {
    roleId: "P3",
    modelProfile: specialist.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("p3 dispatch: route is not the certified deepseek-v4-flash profile");
  }
  assertNoProviderPin(spec.providerPolicy);
}

/** Dispatch a built repair call through the SOLE ZDR boundary, resolving the
 * call's plaintext payloads. This is the only place the role reaches the model. */
export async function dispatchRepairCall(
  call: RepairCall,
  runtime: RepairRuntimeBase,
): Promise<CallResult> {
  assertCertifiedP3Route(call.spec);
  const readPayload: DispatchRuntime["readPayload"] = async (reference) => {
    const content = call.payloads.get(reference.storageRef);
    if (content === undefined) {
      throw new Error(`p3 dispatch: no plaintext for payload ${reference.storageRef}`);
    }
    return content;
  };
  return dispatch(call.spec, { ...runtime, readPayload });
}
