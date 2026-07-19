// Build and dispatch P2's single author-thread continuation call.
//
// The assistant turn carries the current authored text for the exact failing
// lines.  The user turn carries only the corresponding source facts, changed
// basis/defects, and localized-bible ids.  There is intentionally no whole
// scene seed and no review dispatch in this role.

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
import { AUTHOR_CONTINUATION_MODE, type EditScope } from "./scope.js";

type ConversationMessage = CallSpec["messages"][number];

export interface BuildEditCallInput {
  readonly specialist: Specialist;
  readonly scope: EditScope;
  /** The localized bible is handed in by the workflow and must equal the
   * current implicated draft's exact wiki-first basis. */
  readonly bibleRenderingIds: readonly string[];
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly runMode: CallSpec["runMode"];
  readonly contextScope: CallSpec["contextScope"];
  readonly schemaHash: `sha256:${string}`;
}

export interface EditCall {
  readonly spec: CallSpec;
  readonly payloads: ReadonlyMap<string, string>;
  readonly scope: EditScope;
}

interface DraftableMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

function idsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function buildMessages(input: BuildEditCallInput): readonly DraftableMessage[] {
  const { scope } = input;
  const currentThread = {
    kind: "author-thread-current-draft",
    parentDraftBatchId: scope.currentDraft.batchId,
    lines: scope.implicatedDrafts.map((draft) => ({
      unitId: draft.unitId,
      sourceHash: draft.sourceHash,
      targetSkeleton: draft.targetSkeleton,
    })),
  };
  const units = scope.implicatedUnits.map((unit) => {
    const defects = (scope.defectsByUnit.get(unit.value.unitId) ?? []).map((defect) => ({
      defectId: defect.defectId,
      origin: defect.origin,
      severity: defect.severity,
      category: defect.category,
      span: defect.span,
      evidenceIds: defect.evidenceIds,
      basisFactIds: defect.basisFactIds,
      repairConstraint: defect.repairConstraint,
      implicatedGates: defect.implicatedGates,
      implicatedReviewLanes: defect.implicatedReviewLanes,
    }));
    return {
      unitId: unit.value.unitId,
      sourceHash: unit.value.sourceHash,
      sourceSkeleton: unit.value.sourceSkeleton,
      surfaceKind: unit.value.surfaceKind,
      choiceContext: unit.value.choiceContext,
      protectedPlaceholders: unit.value.protectedPlaceholders,
      defects,
    };
  });
  const seed = {
    kind: "line-editor-seed",
    repairMode: AUTHOR_CONTINUATION_MODE,
    parentDraftBatchId: scope.currentDraft.batchId,
    defectBundleId: scope.defectBundle.bundleId,
    implicatedUnitIds: scope.implicatedUnitIds,
    localizationSnapshotId: input.localizationSnapshotId,
    bibleRenderingIds: input.bibleRenderingIds,
    units,
  };
  return [
    { role: "system", content: input.specialist.instructions },
    // This is the author-thread continuation. It has current targets for ONLY
    // the implicated lines, rather than a fresh grounding of the whole batch.
    { role: "assistant", content: JSON.stringify(currentThread) },
    { role: "user", content: JSON.stringify(seed) },
  ];
}

/** Build the bounded P2 repair CallSpec and its encrypted-payload plaintexts. */
export function buildEditCall(input: BuildEditCallInput): EditCall {
  if (input.specialist.roleId !== "P2") {
    throw new Error(`p2 call: specialist ${input.specialist.roleId} is not the Line Editor`);
  }
  if (!idsEqual(input.bibleRenderingIds, input.scope.bibleRenderingIds)) {
    throw new Error(
      "p2 call: supplied localized bible does not match the current implicated basis",
    );
  }
  if (input.localizationSnapshotId !== input.scope.currentDraft.localizationSnapshotId) {
    throw new Error("p2 call: supplied localization snapshot does not match the current draft");
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
    roleId: "P2",
    modelProfile: input.specialist.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
    // Continue this exact author-thread branch. Its identity includes only the
    // parent batch and implicated ids, never a broad scene request.
    parentEventId: sha256({
      continuation: "author-thread",
      contextSnapshotId: input.contextSnapshotId,
      localizationSnapshotId: input.localizationSnapshotId,
      parentDraftBatchId: input.scope.currentDraft.batchId,
      defectBundleId: input.scope.defectBundle.bundleId,
      implicatedUnitIds: input.scope.implicatedUnitIds,
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
  return { spec, payloads, scope: input.scope };
}

export type EditorRuntimeBase = Omit<DispatchRuntime, "readPayload">;

/** Bind P2 to RB-019's one certified model route and account-wide ZDR policy
 * in every run mode, including test-dev where shared dispatch is permissive. */
export function assertCertifiedP2Route(spec: CallSpec): void {
  const specialist = specialistFor("P2");
  const actual = {
    roleId: spec.roleId,
    modelProfile: spec.modelProfile,
    modelProfileVersion: spec.modelProfileVersion,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
  };
  const expected = {
    roleId: "P2",
    modelProfile: specialist.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("p2 dispatch: route is not the certified deepseek-v4-flash profile");
  }
  assertNoProviderPin(spec.providerPolicy);
}

/** Dispatch through the sole account-wide-ZDR boundary. */
export async function dispatchEditCall(
  call: EditCall,
  runtime: EditorRuntimeBase,
): Promise<CallResult> {
  assertCertifiedP2Route(call.spec);
  const readPayload: DispatchRuntime["readPayload"] = async (reference) => {
    const content = call.payloads.get(reference.storageRef);
    if (content === undefined) {
      throw new Error(`p2 dispatch: no plaintext for payload ${reference.storageRef}`);
    }
    return content;
  };
  return dispatch(call.spec, { ...runtime, readPayload });
}
