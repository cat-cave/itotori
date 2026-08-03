// Production Q1–Q6 composition, deferred until snapshot-scoped run facts and runtime exist.

import type {
  EncryptedPayloadRef,
  LocalizedRendering,
  ReviewVerdict,
  UnitFact,
} from "../../contracts/index.js";
import { canonicalJson, sha256 } from "../../llm/canonical-json.js";
import { resolveRoleModelProfile } from "../../llm/role-model-profiles.js";
import { runQ1Review } from "../../roles/q1/index.js";
import { runQ2Review } from "../../roles/q2/index.js";
import { runQ3Audit } from "../../roles/q3/index.js";
import { buildContinuityLedger, runQ4Review } from "../../roles/q4/index.js";
import type { OrderedUnitFact } from "../../prepass/index.js";
import type {
  DraftedScene,
  DraftedUnit,
  GateReport,
  LaneVerdict,
  ReviewLane,
} from "../../workflow/index.js";
import {
  createCertifiedDispatch,
  type DispatchRuntimeBase,
  type PayloadResolver,
} from "./dispatch-runtime.js";
import { ProductionRoleBindingError, voiceRulesFor } from "./production-role-support.js";
import {
  buildQ1ReviewInput,
  buildQ2ReviewInput,
  buildQ3ReviewInput,
  buildQ4ReviewInput,
  interpretLaneVerdict,
  knownSpeakerId,
  primaryRouteId,
  projectSceneUnitFact,
} from "./assemblers/index.js";
import {
  continuityOrigins,
  indexAcceptedTargets,
  voiceAcceptedHistory,
  type AcceptedTargetIndex,
} from "./production-role-history.js";
import type {
  BoundLiveWorkflowRoleSeams,
  LiveWorkflowRoleBindingInput,
  LiveWorkflowRoleSeams,
} from "./factory.js";

export { ProductionRoleBindingError };

type ProductionReviewLane = Extract<ReviewLane, "Q1" | "Q2" | "Q3" | "Q4">;
type EvidenceResolution = { readonly resolved: boolean; readonly visible: boolean };
type ReviewRefs = {
  readonly parentEventId: `sha256:${string}`;
  readonly contextSnapshotId: `sha256:${string}`;
  readonly localizationSnapshotId: `sha256:${string}`;
  readonly sealPayload: (plaintext: string) => EncryptedPayloadRef;
  readonly runMode: LiveWorkflowRoleBindingInput["scope"]["runMode"];
};

export function createProductionRoleBindings(): LiveWorkflowRoleSeams {
  return { bind: (input) => bindRunRoles(input) };
}

function bindRunRoles(input: LiveWorkflowRoleBindingInput): BoundLiveWorkflowRoleSeams {
  const payloads = new Map<string, string>();
  const evidence = new Map<string, string>();
  const bibleById = new Map<string, LocalizedRendering>();
  for (const rendering of input.bible.renderings()) {
    bibleById.set(rendering.renderingId, rendering);
  }
  registerRunEvidence(input, evidence);
  const acceptedTargets = indexAcceptedTargets({
    records: input.acceptedTargets,
    facts: input.facts,
  });
  for (const accepted of acceptedTargets.records) {
    registerEvidence(evidence, accepted.outputId, accepted.targetSkeleton);
  }

  const sealPayload = (plaintext: string): EncryptedPayloadRef => {
    const contentHash = sha256(plaintext);
    const storageRef = `localize-review:${contentHash}`;
    payloads.set(storageRef, plaintext);
    return { storageRef, contentHash, encryption: "operator-managed" };
  };
  const readPayload: PayloadResolver = async (reference) => {
    const plaintext = payloads.get(reference.storageRef);
    if (plaintext === undefined) {
      throw new ProductionRoleBindingError(`unknown review payload ${reference.storageRef}`);
    }
    if (sha256(plaintext) !== reference.contentHash) {
      throw new ProductionRoleBindingError(
        `review payload hash mismatch for ${reference.storageRef}`,
      );
    }
    return plaintext;
  };
  const reviewDispatch = createCertifiedDispatch(runtimeForRole(input.runtime, "Q1"), readPayload);
  const adjudicateDispatch = createCertifiedDispatch(
    runtimeForRole(input.runtime, "Q6"),
    readPayload,
  );
  const refsFor = (role: ReviewLane, reviewInput: unknown): ReviewRefs => ({
    parentEventId: sha256({
      stage: "localize-review",
      role,
      contextSnapshotId: input.scope.contextSnapshotId,
      localizationSnapshotId: input.scope.localizationSnapshotId,
      runMode: input.scope.runMode,
      reviewInput,
    }),
    contextSnapshotId: input.scope.contextSnapshotId,
    localizationSnapshotId: input.scope.localizationSnapshotId,
    sealPayload,
    runMode: input.scope.runMode,
  });
  const ledger = buildContinuityLedger(input.facts.snapshot);

  return {
    review: {
      async reviewLane(request): Promise<readonly LaneVerdict[]> {
        const reviewed = await Promise.all(
          request.unitIds.map(
            async (unitId) =>
              await reviewedUnit({
                input,
                bibleById,
                acceptedTargets,
                evidence,
                ledger,
                dispatch: reviewDispatch,
                refsFor,
                lane: request.lane,
                scene: request.scene,
                gateReport: request.gateReport,
                unitId,
              }),
          ),
        );
        return reviewed.flatMap((verdict) => (verdict === null ? [] : [verdict]));
      },
    },
    adjudicate: {
      buildRefs: (reviewInput) => refsFor("Q6", reviewInput),
      readPayload,
      resolveEvidence: (evidenceId) => evidence.get(evidenceId) ?? null,
      dispatch: adjudicateDispatch,
    },
  };
}

function runtimeForRole(runtime: DispatchRuntimeBase, role: "Q1" | "Q6"): DispatchRuntimeBase {
  const profile = resolveRoleModelProfile(role);
  return {
    ...runtime,
    memo: {
      ...runtime.memo,
      profile: { ...runtime.memo.profile, name: profile.modelProfile, version: profile.version },
    },
  };
}

type ReviewedUnitInput = {
  readonly input: LiveWorkflowRoleBindingInput;
  readonly bibleById: ReadonlyMap<string, LocalizedRendering>;
  readonly acceptedTargets: AcceptedTargetIndex;
  readonly evidence: ReadonlyMap<string, string>;
  readonly ledger: ReturnType<typeof buildContinuityLedger>;
  readonly dispatch: ReturnType<typeof createCertifiedDispatch>;
  readonly refsFor: (role: ReviewLane, reviewInput: unknown) => ReviewRefs;
  readonly lane: ReviewLane;
  readonly scene: DraftedScene;
  readonly gateReport: GateReport;
  readonly unitId: string;
};

async function reviewedUnit(input: ReviewedUnitInput): Promise<LaneVerdict | null> {
  const drafted = input.scene.units.find((unit) => unit.unitId === input.unitId);
  if (drafted === undefined) {
    throw new ProductionRoleBindingError(
      `reviewed unit ${input.unitId} is absent from its drafted scene`,
    );
  }
  const fact = projectSceneUnitFact(input.unitId, input.input.facts);
  const ordered = input.input.facts.orderedFact(input.unitId);

  switch (input.lane) {
    case "Q1":
      return reviewMeaning({ ...input, drafted, fact });
    case "Q2":
      return reviewVoice({ ...input, drafted, fact, ordered });
    case "Q3":
      return reviewTerminology({ ...input, drafted, fact, ordered });
    case "Q4":
      return reviewContinuity({ ...input, drafted, fact, ordered });
    case "Q5":
    case "Q6":
      throw new ProductionRoleBindingError(
        `${input.lane} is not a stratified production review lane`,
      );
  }
}

async function reviewMeaning(
  input: ReviewedUnitInput & {
    readonly drafted: DraftedUnit;
    readonly fact: UnitFact;
  },
): Promise<LaneVerdict> {
  const localizedBible = input.drafted.bibleRenderingIds.map((renderingId) => {
    const rendering = input.bibleById.get(renderingId);
    if (rendering === undefined) {
      throw new ProductionRoleBindingError(
        `Q1 unit ${input.unitId} cites missing bible ${renderingId}`,
      );
    }
    return { renderingId, text: canonicalJson(rendering.body) };
  });
  const neighbors = sourceNeighbors(input.unitId, input.input);
  const visible = new Set<string>([
    input.fact.factId,
    ...input.drafted.bibleRenderingIds,
    ...neighbors.map((neighbor) => neighbor.unitId),
  ]);
  const reviewInput = buildQ1ReviewInput({
    unit: input.drafted,
    fact: input.fact,
    localizationSnapshotId: input.input.scope.localizationSnapshotId,
    localizedBible,
    targetLanguage: input.input.targetLocale,
    neighbors,
  });
  const outcome = await runQ1Review(reviewInput, input.refsFor("Q1", reviewInput), {
    dispatch: input.dispatch,
    resolveEvidence: evidenceResolver(input.evidence, visible),
    deterministicDefects: input.gateReport.defects,
  });
  if (outcome.outcome !== "reviewed") {
    throw new ProductionRoleBindingError(`Q1 returned no verdict for ${input.unitId}`);
  }
  return checkedVerdict("Q1", input.unitId, outcome.interpretation, input.evidence, visible);
}

async function reviewVoice(
  input: ReviewedUnitInput & {
    readonly drafted: DraftedUnit;
    readonly fact: UnitFact;
    readonly ordered: OrderedUnitFact;
  },
): Promise<LaneVerdict | null> {
  const speakerId = knownSpeakerId(input.fact);
  // The router receives a light scene identity, so protect the live boundary
  // against a raw/decode speaker or global route accidentally reaching Q2.
  if (speakerId === null || primaryRouteId(input.ordered.routeScope) === null) return null;
  const bibleRules = voiceRulesFor(input.drafted, speakerId, input.input);
  const acceptedHistory = voiceAcceptedHistory({
    accepted: input.acceptedTargets,
    facts: input.input.facts,
    speakerId,
  });
  const visible = new Set<string>([
    ...bibleRules.map((rule) => rule.ruleId),
    ...acceptedHistory.map((line) => line.historyId),
  ]);
  const reviewInput = buildQ2ReviewInput({
    unit: input.drafted,
    fact: input.fact,
    ordered: input.ordered,
    localizationSnapshotId: input.input.scope.localizationSnapshotId,
    sampleKind: "stratified-sample",
    bibleRules,
    acceptedHistory,
  });
  const outcome = await runQ2Review(reviewInput, input.refsFor("Q2", reviewInput), {
    dispatch: input.dispatch,
    resolveEvidence: evidenceResolver(input.evidence, visible),
  });
  if (outcome.outcome !== "reviewed") {
    throw new ProductionRoleBindingError(`Q2 returned no verdict for ${input.unitId}`);
  }
  return checkedVerdict("Q2", input.unitId, outcome.interpretation, input.evidence, visible);
}

async function reviewTerminology(
  input: ReviewedUnitInput & {
    readonly drafted: DraftedUnit;
    readonly fact: UnitFact;
    readonly ordered: OrderedUnitFact;
  },
): Promise<LaneVerdict | null> {
  const approvedTerms = termsForUnit(input.ordered.sourceUnitKey, input.input);
  const termRulings = termRulingIds(approvedTerms, input.input);
  const neighbors = [
    { surface: "source" as const, unitId: input.fact.factId, text: input.fact.value.sourceSurface },
  ];
  const visible = new Set<string>([
    ...termRulings,
    ...neighbors.map((neighbor) => neighbor.unitId),
  ]);
  const reviewInput = buildQ3ReviewInput({
    unit: input.drafted,
    localizationSnapshotId: input.input.scope.localizationSnapshotId,
    exactGateStatus: glossaryExactStatus(input.unitId, input.gateReport),
    approvedTerms,
    termRulingIds: termRulings,
    neighbors,
  });
  const outcome = await runQ3Audit(reviewInput, input.refsFor("Q3", reviewInput), {
    dispatch: input.dispatch,
    resolveEvidence: evidenceResolver(input.evidence, visible),
  });
  if (outcome.outcome === "gate-defect") return null;
  if (outcome.outcome !== "reviewed") {
    throw new ProductionRoleBindingError(`Q3 returned no verdict for ${input.unitId}`);
  }
  return checkedVerdict("Q3", input.unitId, outcome.interpretation, input.evidence, visible);
}

async function reviewContinuity(
  input: ReviewedUnitInput & {
    readonly drafted: DraftedUnit;
    readonly fact: UnitFact;
    readonly ordered: OrderedUnitFact;
  },
): Promise<LaneVerdict> {
  const originTranslations = continuityOrigins({
    accepted: input.acceptedTargets,
    facts: input.input.facts,
    current: input.ordered,
  });
  const visible = new Set<string>([
    input.fact.factId,
    ...input.drafted.bibleRenderingIds,
    ...originTranslations.map((origin) => origin.unitId),
  ]);
  const reviewInput = buildQ4ReviewInput({
    unit: input.drafted,
    ordered: input.ordered,
    localizationSnapshotId: input.input.scope.localizationSnapshotId,
    originTranslations,
  });
  const outcome = await runQ4Review(reviewInput, input.refsFor("Q4", reviewInput), {
    dispatch: input.dispatch,
    ledger: input.ledger,
  });
  if (outcome.outcome !== "reviewed") {
    throw new ProductionRoleBindingError(`Q4 returned no verdict for ${input.unitId}`);
  }
  return checkedVerdict("Q4", input.unitId, outcome.interpretation, input.evidence, visible);
}

function checkedVerdict(
  lane: ProductionReviewLane,
  unitId: string,
  interpretation: { readonly disposition: string; readonly verdict: ReviewVerdict },
  evidence: ReadonlyMap<string, string>,
  visible: ReadonlySet<string>,
): LaneVerdict {
  if (interpretation.disposition === "invalid") {
    throw new ProductionRoleBindingError(`${lane} returned an invalid verdict for ${unitId}`);
  }
  if (interpretation.verdict.verdict === "CANNOT_ASSESS") {
    throw new ProductionRoleBindingError(
      `${lane} cannot assess ${unitId}; human escalation is required`,
    );
  }
  for (const evidenceId of interpretation.verdict.evidenceIds) {
    if (!evidence.has(evidenceId)) {
      throw new ProductionRoleBindingError(`${lane} cited unresolved evidence ${evidenceId}`);
    }
    if (!visible.has(evidenceId)) {
      throw new ProductionRoleBindingError(
        `${lane} cited evidence outside its prompt ${evidenceId}`,
      );
    }
  }
  return interpretLaneVerdict(lane, unitId, interpretation.verdict);
}

function evidenceResolver(
  evidence: ReadonlyMap<string, string>,
  visible: ReadonlySet<string>,
): (evidenceId: string) => EvidenceResolution {
  return (evidenceId) => ({ resolved: evidence.has(evidenceId), visible: visible.has(evidenceId) });
}

function glossaryExactStatus(unitId: string, gateReport: GateReport): "cleared" | "defect" {
  if (!gateReport.evaluatedGates.includes("glossary-exact")) {
    throw new ProductionRoleBindingError(`Q3 unit ${unitId} has no glossary-exact gate result`);
  }
  return gateReport.defects.some(
    (defect) =>
      defect.origin === "deterministic" &&
      defect.unitId === unitId &&
      defect.gate === "glossary-exact",
  )
    ? "defect"
    : "cleared";
}

function termsForUnit(sourceUnitKey: string, input: LiveWorkflowRoleBindingInput) {
  const termsById = new Map(input.facts.snapshot.terminology.map((term) => [term.termKey, term]));
  return input.bible.canonicalForms.flatMap((form) => {
    const occurrence = termsById.get(form.termId);
    if (occurrence === undefined || !occurrence.occurrenceUnitKeys.includes(sourceUnitKey))
      return [];
    return [
      {
        termId: form.termId,
        sourceForm: form.sourceForm,
        approvedTargetForm: form.requiredTargetForm,
      },
    ];
  });
}

function termRulingIds(
  terms: readonly { readonly termId: string }[],
  input: LiveWorkflowRoleBindingInput,
): readonly string[] {
  const ids = new Set(terms.map((term) => term.termId));
  return input.bibleEntries.flatMap((entry) =>
    entry.sourceObject.kind === "term-ruling" && ids.has(entry.sourceObject.subject.id)
      ? [entry.rendering.renderingId]
      : [],
  );
}

function sourceNeighbors(unitId: string, input: LiveWorkflowRoleBindingInput) {
  const current = input.facts.orderedFact(unitId);
  const ordered = input.facts.snapshot.orderedUnits;
  const index = ordered.findIndex((fact) => fact.factId === current.factId);
  if (index < 0) {
    throw new ProductionRoleBindingError(`Q1 unit ${unitId} is absent from the fact snapshot`);
  }
  return ordered
    .slice(Math.max(0, index - 2), index + 3)
    .filter((neighbor) => neighbor.factId !== current.factId)
    .map((neighbor) => {
      const fact = projectSceneUnitFact(neighbor.factId, input.facts);
      return { surface: "source" as const, unitId: fact.factId, text: fact.value.sourceSurface };
    });
}

function registerRunEvidence(
  input: LiveWorkflowRoleBindingInput,
  evidence: Map<string, string>,
): void {
  for (const ordered of input.facts.snapshot.orderedUnits) {
    const fact = projectSceneUnitFact(ordered.factId, input.facts);
    registerEvidence(evidence, fact.factId, fact.value.sourceSurface);
    registerEvidence(evidence, ordered.bridgeUnitId, fact.value.sourceSurface);
  }
  for (const term of input.facts.snapshot.terminology) {
    registerEvidence(evidence, term.factId, term.termKey);
    registerEvidence(evidence, term.termKey, term.termKey);
  }
  for (const entry of input.bibleEntries) {
    registerEvidence(evidence, entry.rendering.renderingId, canonicalJson(entry.rendering.body));
    for (const claim of entry.rendering.claimRenderings) {
      registerEvidence(evidence, claim.claimId, claim.text);
    }
  }
}

function registerEvidence(evidence: Map<string, string>, evidenceId: string, text: string): void {
  const prior = evidence.get(evidenceId);
  if (prior !== undefined && prior !== text) {
    throw new ProductionRoleBindingError(`evidence ${evidenceId} resolves to conflicting text`);
  }
  evidence.set(evidenceId, text);
}
