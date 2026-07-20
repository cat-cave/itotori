// Build the P1 localizer CALL for one plan segment.
//
// The localizer OWNS a continuing per-scene conversation thread: prior accepted
// target dialogue is carried forward as an assistant turn so voice continuity
// holds across the scene. Each call seeds the exact source skeletons for the
// segment's prompt window (core plus overlap context), the localized-bible
// rendering ids the drafts must cite, and — for every segment after the first,
// or a scene continuing from an earlier batch — the prior accepted target of the
// overlap/prior units.
//
// The role dispatches deepseek-v4-flash through the SOLE ZDR boundary only: this
// module constructs the CallSpec and its plaintext payloads; it constructs no
// provider client and performs no network I/O. `dispatchLocalizerCall` hands the
// spec to that one boundary.

import { CALL_SPEC_SCHEMA_VERSION, DRAFT_BATCH_SCHEMA_VERSION } from "../../contracts/index.js";
import type { CallResult, CallSpec, Draft } from "../../contracts/index.js";
import { canonicalJson, sha256 } from "../../llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../../llm/role-model-profiles.js";
import { dispatch, type DispatchRuntime } from "../../llm/dispatch.js";
import type { Specialist } from "../../roster/index.js";
import type { LocalizedRendering } from "../../contracts/index.js";
import type { LocalizationSegment, SkeletonUnit } from "./plan.js";

type ConversationMessage = CallSpec["messages"][number];

export interface AcceptedTargetLine {
  readonly unitId: string;
  readonly targetSkeleton: string;
}

export interface BuildLocalizerCallInput {
  readonly specialist: Specialist;
  readonly segment: LocalizationSegment;
  /** All source skeletons in the scene, keyed by unit id. */
  readonly unitsById: ReadonlyMap<string, SkeletonUnit>;
  /** Localized-bible rendering ids the drafts cite (wiki-first basis). */
  readonly bibleRenderingIds: readonly string[];
  /** The policy-derived draft basis. The direct control arm has no bible ids or
   * bodies but retains the same P1 profile and certified dispatch route. */
  readonly bibleBasis?: Draft["basis"]["kind"];
  /** Exact installed entries, keyed by unit, supplied by ground-truth readiness. */
  readonly unitBibleById?: ReadonlyMap<string, readonly LocalizedRendering[]>;
  /** Accepted target of prior units in the scene thread, keyed by unit id. */
  readonly priorAcceptedTarget: ReadonlyMap<string, string>;
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly runMode: CallSpec["runMode"];
  readonly contextScope: CallSpec["contextScope"];
  readonly schemaHash: `sha256:${string}`;
}

export interface LocalizerCall {
  readonly spec: CallSpec;
  /** Plaintext payloads keyed by storage ref, resolved by the dispatcher. */
  readonly payloads: ReadonlyMap<string, string>;
  readonly segment: LocalizationSegment;
}

/** The prompt-window unit ids of a segment, in play order. */
function promptUnitIds(segment: LocalizationSegment): readonly string[] {
  return segment.mode === "whole-scene" ? segment.unitIds : segment.promptUnitIds;
}

/** The prior-accepted-target lines that continue the thread INTO this segment:
 * every prompt unit that already has an accepted target (a whole-scene batch's
 * pre-scene history, or a chunk's leading-overlap cores finalized earlier). */
function threadContinuation(
  segment: LocalizationSegment,
  priorAcceptedTarget: ReadonlyMap<string, string>,
): readonly AcceptedTargetLine[] {
  const lines: AcceptedTargetLine[] = [];
  for (const unitId of promptUnitIds(segment)) {
    const target = priorAcceptedTarget.get(unitId);
    if (target !== undefined) lines.push({ unitId, targetSkeleton: target });
  }
  return lines;
}

interface DraftableMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

function buildMessages(input: BuildLocalizerCallInput): readonly DraftableMessage[] {
  const messages: DraftableMessage[] = [{ role: "system", content: input.specialist.instructions }];
  const thread = threadContinuation(input.segment, input.priorAcceptedTarget);
  if (thread.length > 0) {
    // The AUTHOR THREAD carries the prior accepted target forward for continuity.
    messages.push({
      role: "assistant",
      content: JSON.stringify({ kind: "accepted-target-thread", lines: thread }),
    });
  }
  const coreIds = new Set(
    input.segment.mode === "whole-scene" ? input.segment.unitIds : input.segment.coreUnitIds,
  );
  const skeletons = promptUnitIds(input.segment).map((unitId) => {
    const unit = input.unitsById.get(unitId);
    if (!unit) throw new Error(`p1 call: prompt unit ${unitId} has no source skeleton`);
    return {
      unitId,
      role: coreIds.has(unitId) ? "core" : "context",
      sourceHash: unit.sourceHash,
      sourceSkeleton: unit.sourceSkeleton,
      protectedPlaceholders: unit.protectedPlaceholders,
    };
  });
  messages.push({
    role: "user",
    content: JSON.stringify({
      kind: "localizer-seed",
      scope: input.segment,
      draftBasis: input.bibleBasis ?? "wiki-first",
      bibleRenderingIds: input.bibleRenderingIds,
      ...(input.unitBibleById === undefined
        ? {}
        : {
            unitBible: promptUnitIds(input.segment).map((unitId) => ({
              unitId,
              renderings: input.unitBibleById!.get(unitId)!.map((rendering) => ({
                renderingId: rendering.renderingId,
                version: rendering.version,
                body: rendering.body,
              })),
            })),
          }),
      localizationSnapshotId: input.localizationSnapshotId,
      skeletons,
    }),
  });
  return messages;
}

/** Build the P1 CallSpec + plaintext payloads for a plan segment. The route is
 * the certified deepseek-v4-flash profile with the no-provider-pin ZDR policy;
 * the terminal schema is a draft-batch. */
export function buildLocalizerCall(input: BuildLocalizerCallInput): LocalizerCall {
  if (input.specialist.roleId !== "P1") {
    throw new Error(`p1 call: specialist ${input.specialist.roleId} is not the P1 localizer`);
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
    purpose: "draft",
    roleId: "P1",
    modelProfile: input.specialist.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
    // Each segment forks from a DISTINCT parent transcript event: the memo key
    // is keyed on parentEventId, so a constant one would collide sibling chunks.
    // Deterministic in the segment, so re-running the same segment memoizes.
    parentEventId: sha256({
      contextSnapshotId: input.contextSnapshotId,
      localizationSnapshotId: input.localizationSnapshotId,
      segment: input.segment,
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
  return { spec, payloads, segment: input.segment };
}

export type LocalizerRuntimeBase = Omit<DispatchRuntime, "readPayload">;

/**
 * Bind a call to P1's certified deepseek-v4-flash route, in EVERY run mode. The
 * dispatcher's own certification is skipped in test-dev, and this entry accepts
 * a caller-made spec, so without this guard a forged `requestedModel` under
 * test-dev would reach the wire. The provider-free ZDR fallback policy is part
 * of the certified route and is asserted here unchanged. A legitimately built
 * call always passes; a re-routed call fails loud before any transport.
 */
function assertCertifiedP1Route(spec: CallSpec): void {
  if (spec.roleId !== "P1") {
    throw new Error(`p1 dispatch: spec role ${spec.roleId} is not P1`);
  }
  if (spec.requestedModel !== deepSeekV4FlashProfile.model) {
    throw new Error(
      `p1 dispatch: requested model ${spec.requestedModel} is not the certified deepseek-v4-flash route`,
    );
  }
  if (
    spec.modelProfile !== "draft" ||
    spec.modelProfileVersion !== deepSeekV4FlashProfile.version
  ) {
    throw new Error("p1 dispatch: model profile is not the certified draft profile");
  }
  if (canonicalJson(spec.providerPolicy) !== canonicalJson(deepSeekV4FlashProfile.providerPolicy)) {
    throw new Error("p1 dispatch: provider policy is not the certified ZDR fallback policy");
  }
}

/** Dispatch a built localizer call through the SOLE ZDR boundary, resolving the
 * call's plaintext payloads. This is the only place the role reaches the model,
 * and it binds the call to the certified deepseek-v4-flash + provider-free ZDR
 * route in every run mode — the hard privacy boundary. */
export async function dispatchLocalizerCall(
  call: LocalizerCall,
  runtime: LocalizerRuntimeBase,
): Promise<CallResult> {
  assertCertifiedP1Route(call.spec);
  const readPayload: DispatchRuntime["readPayload"] = async (reference) => {
    const content = call.payloads.get(reference.storageRef);
    if (content === undefined) {
      throw new Error(`p1 dispatch: no plaintext for payload ${reference.storageRef}`);
    }
    return content;
  };
  return dispatch(call.spec, { ...runtime, readPayload });
}
