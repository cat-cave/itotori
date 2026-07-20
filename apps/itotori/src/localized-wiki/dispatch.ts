// Certified localizer-profile dispatch adapters for the per-target bible.
//
// L-Term / L-Name are decision postures, not additional roster roles. This
// module therefore uses the existing P1 localizer casting to author one
// LocalizedRendering at a time, and the Q3/Q2 reviewer castings to judge the
// decision renderings. Every production call crosses the sole `dispatch`
// boundary, which supplies durable physical-step memoization and the ZDR route.
// Offline proofs inject the same CallSpec -> CallResult seam.

import {
  CALL_SPEC_SCHEMA_VERSION,
  LOCALIZED_RENDERING_SCHEMA_VERSION,
  REVIEW_VERDICT_SCHEMA_VERSION,
  CallSpecSchema,
  LocalizedRenderingSchema,
  ReviewVerdictSchema,
  type CallResult,
  type CallSpec,
  type EncryptedPayloadRef,
  type ReviewVerdict,
} from "../contracts/index.js";
import { canonicalJson, sha256 } from "../llm/canonical-json.js";
import { dispatch, type DispatchRuntime } from "../llm/dispatch.js";
import { resolveRoleModelProfile } from "../llm/role-model-profiles.js";
import { specialistFor } from "../roster/index.js";
import type {
  DecisionReviewer,
  DecisionReviewerOutput,
  LocalizerRunner,
  RenderStepInput,
  ReviewDecisionInput,
} from "./types.js";

const LOCALIZER_ROLE = "P1" as const;
const REVIEWER_RUBRIC = { Q2: "voice", Q3: "terminology" } as const;
const PROMPT_VERSION = "itotori.localized-wiki.v2";

type DecisionReviewerRole = keyof typeof REVIEWER_RUBRIC;

/** The one dispatch seam the adapters use. Production supplies the certified ZDR
 * dispatcher; deterministic tests supply a recorded result. */
export type LocalizedWikiDispatch = (spec: CallSpec) => Promise<CallResult>;

/** References owned by the run/composition layer, not the model. */
export interface LocalizedWikiDispatchRefs {
  readonly contextSnapshotId: string;
  readonly sealPayload: (plaintext: string) => EncryptedPayloadRef;
}

/** A locally assembled pair of runners that both use the same certified dispatch
 * and payload resolver. */
export interface CertifiedLocalizedWikiActors {
  readonly runner: LocalizerRunner;
  readonly reviewer: DecisionReviewer;
}

/** A forged profile route must fail before it reaches the dispatch boundary in
 * every mode, including recorded test-dev proofs. */
export class LocalizedWikiRouteError extends Error {
  constructor(readonly role: "P1" | DecisionReviewerRole) {
    super(`localized Wiki ${role} route is not its certified deepseek-v4-flash profile`);
    this.name = "LocalizedWikiRouteError";
  }
}

function assertCertifiedRoute(spec: CallSpec, role: "P1" | DecisionReviewerRole): void {
  const profile = resolveRoleModelProfile(role);
  const actual = {
    roleId: spec.roleId,
    modelProfile: spec.modelProfile,
    modelProfileVersion: spec.modelProfileVersion,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
  };
  const expected = {
    roleId: role,
    modelProfile: profile.modelProfile,
    modelProfileVersion: profile.version,
    requestedModel: profile.model,
    providerPolicy: profile.providerPolicy,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new LocalizedWikiRouteError(role);
}

function textMessage(
  role: "system" | "user",
  plaintext: string,
  refs: LocalizedWikiDispatchRefs,
): {
  readonly kind: "text";
  readonly eventId: `sha256:${string}`;
  readonly role: "system" | "user";
  readonly contentEncrypted: EncryptedPayloadRef;
} {
  return {
    kind: "text",
    eventId: sha256({ role, plaintext }),
    role,
    contentEncrypted: refs.sealPayload(plaintext),
  };
}

function renderingPrompt(input: RenderStepInput): {
  readonly system: string;
  readonly user: string;
} {
  const specialist = specialistFor(LOCALIZER_ROLE);
  return {
    system: `${specialist.instructions}\nReturn exactly one localized rendering for the assigned source object. The assigned identity, target language, source version, route scope, localization snapshot, and run mode are system constraints; do not author alternatives or a translation line.`,
    user: canonicalJson({
      task: "localize-source-wiki-object",
      tier: input.tier,
      decisionClass: input.decisionClass,
      sourceObject: input.sourceObject,
      target: input.target,
      stamp: input.stamp,
    }),
  };
}

/** Build the P1-profile call that authors one on-target bible rendering. */
export function buildLocalizedRenderingCall(
  input: RenderStepInput,
  refs: LocalizedWikiDispatchRefs,
): CallSpec {
  const specialist = specialistFor(LOCALIZER_ROLE);
  const profile = resolveRoleModelProfile(LOCALIZER_ROLE);
  const prompt = renderingPrompt(input);
  const spec = CallSpecSchema.parse({
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "draft",
    roleId: LOCALIZER_ROLE,
    modelProfile: profile.modelProfile,
    modelProfileVersion: profile.version,
    requestedModel: profile.model,
    providerPolicy: profile.providerPolicy,
    parentEventId: sha256({
      stage: "localized-wiki-render",
      target: input.target.key,
      stamp: input.stamp,
    }),
    contextSnapshotId: refs.contextSnapshotId,
    localizationSnapshotId: input.stamp.localizationSnapshotId,
    messages: [textMessage("system", prompt.system, refs), textMessage("user", prompt.user, refs)],
    tools: [],
    output: {
      name: "localized-rendering",
      schemaVersion: LOCALIZED_RENDERING_SCHEMA_VERSION,
      schemaHash: sha256(LOCALIZED_RENDERING_SCHEMA_VERSION),
    },
    promptVersion: PROMPT_VERSION,
    reasoning: specialist.reasoning,
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: specialist.limits,
    sampleId: null,
    runMode: input.stamp.runMode,
    contextScope: "whole-game",
  });
  assertCertifiedRoute(spec, LOCALIZER_ROLE);
  return spec;
}

function reviewerPrompt(input: ReviewDecisionInput): {
  readonly system: string;
  readonly user: string;
} {
  const specialist = specialistFor(input.reviewerRole);
  const rubric = REVIEWER_RUBRIC[input.reviewerRole];
  return {
    system: `${specialist.instructions}\nJudge this localized canonical decision only for the ${rubric} rubric. Return one strict review verdict. A PASS means the target form can install; a CANNOT_ASSESS must request evidence.`,
    user: canonicalJson({
      task: "review-localized-canonical-decision",
      decisionClass: input.decisionClass,
      sourceObject: input.sourceObject,
      rendering: input.rendering,
      stamp: input.stamp,
    }),
  };
}

/** Build one Q3/Q2-profile validation call for a canonical decision. */
export function buildLocalizedDecisionReviewCall(
  input: ReviewDecisionInput,
  refs: LocalizedWikiDispatchRefs,
): CallSpec {
  const role = input.reviewerRole;
  const specialist = specialistFor(role);
  const profile = resolveRoleModelProfile(role);
  const prompt = reviewerPrompt(input);
  const spec = CallSpecSchema.parse({
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "review",
    roleId: role,
    modelProfile: profile.modelProfile,
    modelProfileVersion: profile.version,
    requestedModel: profile.model,
    providerPolicy: profile.providerPolicy,
    parentEventId: sha256({
      stage: "localized-wiki-decision-review",
      role,
      renderingId: input.rendering.renderingId,
      stamp: input.stamp,
    }),
    contextSnapshotId: refs.contextSnapshotId,
    localizationSnapshotId: input.stamp.localizationSnapshotId,
    messages: [textMessage("system", prompt.system, refs), textMessage("user", prompt.user, refs)],
    tools: [],
    output: {
      name: "review-verdict",
      schemaVersion: REVIEW_VERDICT_SCHEMA_VERSION,
      schemaHash: sha256(REVIEW_VERDICT_SCHEMA_VERSION),
    },
    promptVersion: PROMPT_VERSION,
    reasoning: specialist.reasoning,
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: specialist.limits,
    sampleId: null,
    runMode: input.stamp.runMode,
    contextScope: "whole-game",
  });
  assertCertifiedRoute(spec, role);
  return spec;
}

/** Create the injected P1-profile runner used by the deterministic orchestrator. */
export function createDispatchLocalizerRunner(deps: {
  readonly dispatch: LocalizedWikiDispatch;
  readonly refs: LocalizedWikiDispatchRefs;
}): LocalizerRunner {
  return async (input) => {
    const result = await deps.dispatch(buildLocalizedRenderingCall(input, deps.refs));
    if (result.status !== "success") {
      throw new Error(`localized Wiki rendering dispatch failed: ${result.failureKind}`);
    }
    const parsed = LocalizedRenderingSchema.safeParse(result.value);
    if (!parsed.success)
      throw new Error("localized Wiki rendering dispatch returned the wrong terminal output");
    return [parsed.data];
  };
}

function invalidReviewerOutput(input: ReviewDecisionInput): DecisionReviewerOutput {
  // The existing reviewer gate treats a shapeless result as an unclean verdict,
  // so a failed/mismatched reviewer call can never install a canonical form.
  return { snapshotId: input.stamp.localizationSnapshotId, verdicts: [] };
}

function projectVerdict(
  verdict: ReviewVerdict,
  input: ReviewDecisionInput,
): DecisionReviewerOutput {
  if (
    verdict.roleId !== input.reviewerRole ||
    verdict.rubric !== REVIEWER_RUBRIC[input.reviewerRole] ||
    verdict.unitId !== input.rendering.renderingId ||
    verdict.localizationSnapshotId !== input.stamp.localizationSnapshotId
  ) {
    return invalidReviewerOutput(input);
  }
  return {
    snapshotId: verdict.localizationSnapshotId,
    verdicts: [
      {
        unitId: verdict.unitId,
        verdict: verdict.verdict,
        severity: verdict.severity,
        category: REVIEWER_RUBRIC[input.reviewerRole],
        span: verdict.verdict === "FAIL" ? { start: 0, end: 0 } : null,
        evidenceIds: verdict.evidenceIds,
        repairConstraint: verdict.repairConstraint,
        evidenceRequest:
          verdict.verdict === "CANNOT_ASSESS" ? (verdict.requestedEvidence.at(0) ?? null) : null,
      },
    ],
  };
}

/** Create the injected Q3/Q2 reviewer adapter. It accepts only a matching strict
 * terminal verdict and projects it into the shared reviewer-shape law used by
 * the existing deterministic gate. */
export function createDispatchDecisionReviewer(deps: {
  readonly dispatch: LocalizedWikiDispatch;
  readonly refs: LocalizedWikiDispatchRefs;
}): DecisionReviewer {
  return async (input) => {
    const result = await deps.dispatch(buildLocalizedDecisionReviewCall(input, deps.refs));
    if (result.status !== "success") return invalidReviewerOutput(input);
    const parsed = ReviewVerdictSchema.safeParse(result.value);
    return parsed.success ? projectVerdict(parsed.data, input) : invalidReviewerOutput(input);
  };
}

/** Bind both adapters to the sole production dispatch boundary. The underlying
 * runtime owns idempotent physical-step memoization; the local payload map only
 * resolves the sealed prompts this bible pass created. */
export function createCertifiedLocalizedWikiActors(deps: {
  readonly contextSnapshotId: string;
  readonly runtime: DispatchRuntime;
}): CertifiedLocalizedWikiActors {
  const payloads = new Map<string, string>();
  const refs: LocalizedWikiDispatchRefs = {
    contextSnapshotId: deps.contextSnapshotId,
    sealPayload(plaintext) {
      const contentHash = sha256(plaintext);
      const storageRef = `localized-wiki:${contentHash}`;
      payloads.set(storageRef, plaintext);
      return { storageRef, contentHash, encryption: "operator-managed" };
    },
  };
  const certifiedDispatch: LocalizedWikiDispatch = (spec) =>
    dispatch(spec, {
      ...deps.runtime,
      readPayload: async (reference) => {
        const payload = payloads.get(reference.storageRef);
        return payload === undefined ? deps.runtime.readPayload(reference) : payload;
      },
    });
  return {
    runner: createDispatchLocalizerRunner({ dispatch: certifiedDispatch, refs }),
    reviewer: createDispatchDecisionReviewer({ dispatch: certifiedDispatch, refs }),
  };
}
