// Build the P2 Line Editor CALL for one edit scope.
//
// The Line Editor CONTINUES the author thread: the current authored draft of the
// implicated units is carried forward as an assistant turn, then a user turn
// hands the author the exact changed basis — the scoped defects (failing span +
// repair constraint) and the localized bible — and asks ONLY for minor style,
// format, and voice repairs to those units. The seed carries exactly the
// implicated units' source skeletons; no unimplicated unit and no whole-scene
// context is ever placed in the prompt, so the editor structurally cannot launch
// a blind retranslation.
//
// The role dispatches deepseek-v4-flash through the SOLE ZDR boundary only: this
// module constructs the CallSpec and its plaintext payloads and constructs no
// provider client. `dispatchEditCall` hands the spec to that one boundary and
// binds the certified route in every run mode.

import { CALL_SPEC_SCHEMA_VERSION, DRAFT_BATCH_SCHEMA_VERSION } from "../../contracts/index.js";
import type { CallResult, CallSpec } from "../../contracts/index.js";
import { canonicalJson, sha256 } from "../../llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../../llm/role-model-profiles.js";
import { dispatch, type DispatchRuntime } from "../../llm/dispatch.js";
import type { Specialist } from "../../roster/index.js";
import type { EditScope } from "./scope.js";

type ConversationMessage = CallSpec["messages"][number];

export interface BuildEditCallInput {
  readonly specialist: Specialist;
  readonly scope: EditScope;
  /** Localized-bible rendering ids the repaired lines cite (wiki-first basis). */
  readonly bibleRenderingIds: readonly string[];
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly runMode: CallSpec["runMode"];
  readonly contextScope: CallSpec["contextScope"];
  readonly schemaHash: `sha256:${string}`;
}

export interface EditCall {
  readonly spec: CallSpec;
  /** Plaintext payloads keyed by storage ref, resolved by the dispatcher. */
  readonly payloads: ReadonlyMap<string, string>;
  readonly scope: EditScope;
}

interface DraftableMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

function buildMessages(input: BuildEditCallInput): readonly DraftableMessage[] {
  const { scope } = input;
  const messages: DraftableMessage[] = [{ role: "system", content: input.specialist.instructions }];

  // The AUTHOR THREAD: the current authored line for each implicated unit, folded
  // forward so the repair continues the same voice rather than starting fresh.
  const authoredLines = scope.implicatedUnitIds.map((unitId) => {
    const current = scope.currentByUnit.get(unitId)!;
    return { unitId, targetSkeleton: current.draft.targetSkeleton };
  });
  messages.push({
    role: "assistant",
    content: JSON.stringify({ kind: "authored-draft-thread", lines: authoredLines }),
  });

  // The changed basis: the scoped defects + localized bible + the implicated
  // source skeletons. This is the exact, minimal context the author needs.
  const defects = scope.implicatedUnitIds.flatMap(
    (unitId) => scope.defectsByUnit.get(unitId) ?? [],
  );
  const skeletons = scope.implicatedUnitIds.map((unitId) => {
    const source = scope.implicatedSource.get(unitId)!;
    return {
      unitId,
      sourceHash: source.sourceHash,
      sourceSkeleton: source.sourceSkeleton,
      protectedPlaceholders: source.protectedPlaceholders,
    };
  });
  messages.push({
    role: "user",
    content: JSON.stringify({
      kind: "line-edit-seed",
      parentDraftBatchId: scope.parentDraftBatchId,
      defectBundleId: scope.defectBundleId,
      localizationSnapshotId: input.localizationSnapshotId,
      implicatedUnitIds: scope.implicatedUnitIds,
      bibleRenderingIds: input.bibleRenderingIds,
      defects,
      skeletons,
    }),
  });
  return messages;
}

/** Build the P2 CallSpec + plaintext payloads for an edit scope. The route is the
 * certified deepseek-v4-flash profile with the no-provider-pin ZDR policy; the
 * terminal schema is a draft-batch (a repair patch). */
export function buildEditCall(input: BuildEditCallInput): EditCall {
  if (input.specialist.roleId !== "P2") {
    throw new Error(`p2 call: specialist ${input.specialist.roleId} is not the P2 line editor`);
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
    // The edit forks from a DISTINCT parent transcript event keyed on the exact
    // bundle + implicated set, so re-running the same edit memoizes and two
    // different bundles never collide.
    parentEventId: sha256({
      contextSnapshotId: input.contextSnapshotId,
      localizationSnapshotId: input.localizationSnapshotId,
      defectBundleId: input.scope.defectBundleId,
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
      maxSteps: 2,
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

/**
 * Bind a call to P2's certified deepseek-v4-flash route, in EVERY run mode. The
 * dispatcher's own certification is skipped in test-dev, and this entry accepts a
 * caller-made spec, so without this guard a forged `requestedModel` under
 * test-dev would reach the wire. The provider-free ZDR fallback policy is part of
 * the certified route and is asserted here unchanged. A legitimately built call
 * always passes; a re-routed call fails loud before any transport.
 */
function assertCertifiedEditRoute(spec: CallSpec): void {
  if (spec.roleId !== "P2") {
    throw new Error(`p2 dispatch: spec role ${spec.roleId} is not P2`);
  }
  if (spec.requestedModel !== deepSeekV4FlashProfile.model) {
    throw new Error(
      `p2 dispatch: requested model ${spec.requestedModel} is not the certified deepseek-v4-flash route`,
    );
  }
  if (
    spec.modelProfile !== "draft" ||
    spec.modelProfileVersion !== deepSeekV4FlashProfile.version
  ) {
    throw new Error("p2 dispatch: model profile is not the certified draft profile");
  }
  if (canonicalJson(spec.providerPolicy) !== canonicalJson(deepSeekV4FlashProfile.providerPolicy)) {
    throw new Error("p2 dispatch: provider policy is not the certified ZDR fallback policy");
  }
}

/** Dispatch a built edit call through the SOLE ZDR boundary, resolving the call's
 * plaintext payloads. This is the only place the role reaches the model, and it
 * binds the call to the certified deepseek-v4-flash + provider-free ZDR route in
 * every run mode — the hard privacy boundary. */
export async function dispatchEditCall(
  call: EditCall,
  runtime: EditorRuntimeBase,
): Promise<CallResult> {
  assertCertifiedEditRoute(call.spec);
  const readPayload: DispatchRuntime["readPayload"] = async (reference) => {
    const content = call.payloads.get(reference.storageRef);
    if (content === undefined) {
      throw new Error(`p2 dispatch: no plaintext for payload ${reference.storageRef}`);
    }
    return content;
  };
  return dispatch(call.spec, { ...runtime, readPayload });
}
