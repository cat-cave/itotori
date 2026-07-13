// p0-core-iterative-patch-versioning-and-playtest-feedback — app-facing
// iteration coordinator.
//
// This is deliberately a thin composition layer. Durable identity/snapshots
// live in the DB iteration repository; unit results still use the journal,
// the existing terminal finalizer keeps the coverage barrier, and refinement
// bytes use the node-10 Kaifuu materializer. There is no parallel patch,
// feedback, or wiki implementation here.

import { randomUUID } from "node:crypto";
import { asNonBlankTargetText, type WrittenUnitOutcome } from "@itotori/localization-bridge-schema";
import {
  patchVersionIdFor,
  type AuthorizationActor,
  type CreatePlayTestFeedbackBatchInput,
  type ItotoriLocalizationIterationRepositoryPort,
  type ItotoriLocalizationJournalRepositoryPort,
  type ItotoriLocalizationRunFinalizerRepositoryPort,
  type LocalizationJournalRunLeaseIdentity,
  type LocalizationJournalRunRecord,
  type LocalizationRefinementRunRecord,
  type PatchPlaySurface,
  type PatchVersionIterationRecord,
  type PlaySessionRecord,
  type PlayTestFeedbackBatchRecord,
  type PlayTestFeedbackEventKind,
  type PlayTestFeedbackEventRecord,
  type PlayTestFeedbackInbox,
} from "@itotori/db";
import { ProductionRefinementPatchArtifactMaterializer } from "../play/production-patch-revision-materializer.js";
import type { BoundPlayTesterResultRevisionServicePort } from "../play/result-revision-service.js";
import type {
  AddWikiBrainEntryKind,
  WikiBrainEditResult,
  WikiBrainServicePort,
} from "../wiki/service.js";
import {
  UtsushiPatchRuntimeLauncher,
  type PatchRuntimeLauncherPort,
} from "../play/patch-runtime-launcher.js";

export type PatchIterationSurface = {
  patch: PatchPlaySurface;
  versions: PatchVersionIterationRecord[];
  feedback: PlayTestFeedbackInbox;
};

export type PatchIterationFeedbackInput = {
  observedPatchVersionId: string;
  feedbackBatchId?: string;
  playSessionId?: string;
  eventKind: PlayTestFeedbackEventKind;
  body?: string;
  metadata?: Record<string, unknown>;
  /** Target text is deliberately separate from arbitrary metadata. */
  targetBody?: string;
  resultRevisionId?: string;
  /**
   * A first-class context mutation. This does not duplicate the context
   * flywheel: it delegates to Node 9's WikiBrainService, which in turn owns
   * Node 8's canonical version + invalidation + registered rerun.
   */
  contextFeedback?: PatchIterationContextFeedbackInput;
  contextArtifactId?: string;
  contextEntryVersionId?: string;
  affectedBridgeUnitIds?: readonly string[];
};

/**
 * Context feedback can either add a new canonical note/glossary/style entry
 * or edit an existing wiki entry. Project/branch/source identity is never a
 * client input here: PatchIterationService derives it from the observed patch
 * run before it delegates to the existing WikiBrain service.
 */
export type PatchIterationContextFeedbackInput =
  | {
      operation: "add";
      kind: AddWikiBrainEntryKind;
      title: string;
      body: string;
      reason: string;
      affectedBridgeUnitIds: readonly string[];
    }
  | {
      operation: "edit";
      contextArtifactId: string;
      body: string;
      reason: string;
      title?: string;
      affectedBridgeUnitIds?: readonly string[];
    };

export type PatchIterationRefineInput = {
  basePatchVersionId: string;
  /** A batch means every immutable event in that batch is selected. */
  feedbackBatchIds?: readonly string[];
  /** Exact individual events; siblings in their batch remain unselected. */
  feedbackEventIds?: readonly string[];
  /** Complete-within-scope; omit to retain the base patch's exact scope. */
  scopeUnitIds?: readonly string[];
  /** Required target text for a newly broadened unit or an explicit override. */
  targetBodiesByUnit?: Readonly<Record<string, string>>;
  /** Explicit current wiki heads; omit to freeze all current branch heads. */
  wikiHeads?: readonly { contextArtifactId: string; contextEntryVersionId: string }[];
};

export type PatchIterationRefinementResult = {
  refinement: LocalizationRefinementRunRecord;
  patch: PatchPlaySurface;
};

export interface PatchIterationServicePort {
  list(input: { localeBranchId: string }): Promise<PatchVersionIterationRecord[]>;
  load(input: { patchVersionId: string }): Promise<PatchIterationSurface | null>;
  play(input: {
    patchVersionId: string;
    launchDescriptor?: Record<string, unknown>;
  }): Promise<PlaySessionRecord>;
  createFeedbackBatch(input: {
    observedPatchVersionId: string;
    feedbackBatchId?: string;
    label?: string;
  }): Promise<PlayTestFeedbackBatchRecord>;
  feedback(input: PatchIterationFeedbackInput): Promise<PlayTestFeedbackEventRecord>;
  refine(input: PatchIterationRefineInput): Promise<PatchIterationRefinementResult>;
}

export type PatchIterationServiceDeps = {
  actor: AuthorizationActor;
  iteration: ItotoriLocalizationIterationRepositoryPort;
  journal: ItotoriLocalizationJournalRepositoryPort;
  finalizer: ItotoriLocalizationRunFinalizerRepositoryPort;
  /**
   * Node 10: a result edit and its immutable feedback fact commit together.
   * Production must never select a child patch before feedback validation has
   * succeeded in that same database transaction.
   */
  resultRevisions?: Pick<BoundPlayTesterResultRevisionServicePort, "editTargetWithFeedback">;
  /**
   * Node 8 persists the result of its registered redraft to the canonical
   * locale-branch draft projection. Refinement reads that durable output
   * rather than copying a base target into a cosmetically new outcome.
   */
  draftTexts?: {
    load(input: {
      projectId: string;
      localeBranchId: string;
      bridgeUnitIds: readonly string[];
    }): Promise<ReadonlyMap<string, string | null>>;
  };
  /**
   * Nodes 9 + 8: canonical wiki/context writes and their registered rerun.
   * Iteration records the returned exact head/impact receipt; it never
   * reimplements a context store or correction worker.
   */
  wiki?: Pick<WikiBrainServicePort, "add" | "edit">;
  /** Node 8's installed flywheel is drained before its wiki heads are frozen. */
  contextCorrections?: { drain(): Promise<unknown> };
  /** Exact-version runtime launch; a play session follows a real Utsushi replay. */
  runtimeLauncher?: PatchRuntimeLauncherPort;
  materializer?: ProductionRefinementPatchArtifactMaterializer;
  now?: () => Date;
};

/**
 * Bound production service shared by HTTP, dashboard, and CLI. It accepts a
 * feedback target override as a play-tester fact, writes an immutable new run
 * result for only redrafted/new units, and lets the finalizer carry untouched
 * immutable revisions forward exactly.
 */
export class PatchIterationService implements PatchIterationServicePort {
  private readonly materializer: ProductionRefinementPatchArtifactMaterializer;
  private readonly runtimeLauncher: PatchRuntimeLauncherPort;
  private readonly now: () => Date;

  constructor(private readonly deps: PatchIterationServiceDeps) {
    this.materializer = deps.materializer ?? new ProductionRefinementPatchArtifactMaterializer();
    this.runtimeLauncher = deps.runtimeLauncher ?? new UtsushiPatchRuntimeLauncher();
    this.now = deps.now ?? (() => new Date());
  }

  async list(input: { localeBranchId: string }): Promise<PatchVersionIterationRecord[]> {
    return this.deps.iteration.listPatchVersions(this.deps.actor, input);
  }

  async load(input: { patchVersionId: string }): Promise<PatchIterationSurface | null> {
    const patch = await this.deps.iteration.loadPatchPlaySurface(
      this.deps.actor,
      input.patchVersionId,
    );
    if (patch === null) return null;
    const run = await this.deps.journal.loadRun(this.deps.actor, patch.runId);
    if (run === null) {
      throw new PatchIterationServiceError(
        "patch_run_not_found",
        `patch ${patch.patchVersionId} refers to missing run ${patch.runId}`,
      );
    }
    const [versions, feedback] = await Promise.all([
      this.deps.iteration.listPatchVersions(this.deps.actor, {
        localeBranchId: run.localeBranchId,
      }),
      this.deps.iteration.loadFeedbackInbox(this.deps.actor, patch.patchVersionId),
    ]);
    return { patch, versions, feedback };
  }

  async play(input: {
    patchVersionId: string;
    launchDescriptor?: Record<string, unknown>;
  }): Promise<PlaySessionRecord> {
    const patch = await this.deps.iteration.loadPatchPlaySurface(
      this.deps.actor,
      input.patchVersionId,
    );
    if (patch === null) {
      throw new PatchIterationServiceError(
        "patch_not_found",
        `patch ${input.patchVersionId} was not found`,
      );
    }
    // A play session is not an archive-download receipt. Drive the exact,
    // hash-bound patch through the runtime before recording an active session,
    // so a launch failure cannot leave a false successful play state behind.
    const launch = await this.runtimeLauncher.launch({
      patch,
      ...(input.launchDescriptor === undefined ? {} : { launchDescriptor: input.launchDescriptor }),
    });
    return this.deps.iteration.startPlaySession(this.deps.actor, {
      observedPatchVersionId: input.patchVersionId,
      launchDescriptor: {
        runtime: launch.runtime,
        engine: launch.engine,
        scene: launch.scene,
        replay: launch.replay,
        observedTextLineCount: launch.observedTextLineCount,
      },
    });
  }

  async createFeedbackBatch(input: {
    observedPatchVersionId: string;
    feedbackBatchId?: string;
    label?: string;
  }): Promise<PlayTestFeedbackBatchRecord> {
    const request: CreatePlayTestFeedbackBatchInput = {
      observedPatchVersionId: input.observedPatchVersionId,
      selectionKind: "batch",
      ...(input.feedbackBatchId === undefined ? {} : { feedbackBatchId: input.feedbackBatchId }),
      ...(input.label === undefined ? {} : { label: input.label }),
    };
    return this.deps.iteration.createFeedbackBatch(this.deps.actor, request);
  }

  async feedback(input: PatchIterationFeedbackInput): Promise<PlayTestFeedbackEventRecord> {
    const metadata = { ...input.metadata };
    let resultRevisionId = input.resultRevisionId;
    let contextArtifactId = input.contextArtifactId;
    let contextEntryVersionId = input.contextEntryVersionId;
    let affectedBridgeUnitIds = input.affectedBridgeUnitIds;
    // Scoped comments create their canonical note before the feedback event is
    // inserted. Reserve the immutable event identity here so the note title
    // cannot collide with a later comment on the same observed patch.
    let feedbackEventId: string | undefined;
    if (input.eventKind === "result_edit") {
      if (input.targetBody === undefined || input.targetBody.trim().length === 0) {
        throw new PatchIterationServiceError(
          "target_body_required",
          "result-edit feedback requires a non-blank targetBody",
        );
      }
      const surface = await this.deps.iteration.loadPatchPlaySurface(
        this.deps.actor,
        input.observedPatchVersionId,
      );
      if (surface === null) {
        throw new PatchIterationServiceError(
          "patch_not_found",
          `observed patch ${input.observedPatchVersionId} was not found`,
        );
      }
      const affected = input.affectedBridgeUnitIds ?? [];
      if (affected.length !== 1) {
        throw new PatchIterationServiceError(
          "result_edit_single_unit",
          "result-edit feedback must identify exactly one observed bridge unit",
        );
      }
      const observedUnit = surface.units.find((unit) => unit.bridgeUnitId === affected[0]);
      if (observedUnit === undefined) {
        throw new PatchIterationServiceError(
          "feedback_unit_not_observed",
          `result-edit unit ${affected[0]} does not belong to observed patch ${surface.patchVersionId}`,
        );
      }
      metadata.targetBody = input.targetBody;
      // The observed immutable result revision is the feedback anchor. The
      // refinement writes a new run-owned revision from this supplied target
      // body. When Node 10 is installed, its child selection and this exact
      // feedback event share one database transaction; an invalid session,
      // batch, or provenance reference cannot leave a selected orphan child.
      if (this.deps.resultRevisions !== undefined) {
        if (input.contextFeedback !== undefined) {
          throw new PatchIterationServiceError(
            "context_feedback_kind_mismatch",
            "a context feedback payload requires added_context or wiki_edit feedback",
          );
        }
        const revised = await this.deps.resultRevisions.editTargetWithFeedback({
          parentPatchVersionId: input.observedPatchVersionId,
          bridgeUnitId: observedUnit.bridgeUnitId,
          targetBody: input.targetBody,
          feedback: {
            ...(input.feedbackBatchId === undefined
              ? {}
              : { feedbackBatchId: input.feedbackBatchId }),
            ...(input.playSessionId === undefined ? {} : { playSessionId: input.playSessionId }),
            ...(input.body === undefined ? {} : { body: input.body }),
            metadata,
            ...(contextArtifactId === undefined ? {} : { contextArtifactId }),
            ...(contextEntryVersionId === undefined ? {} : { contextEntryVersionId }),
          },
        });
        return revised.result.feedback;
      } else {
        resultRevisionId ??= observedUnit.resultRevisionId;
      }
    }
    if (input.contextFeedback !== undefined) {
      if (input.eventKind !== "added_context" && input.eventKind !== "wiki_edit") {
        throw new PatchIterationServiceError(
          "context_feedback_kind_mismatch",
          "a context feedback payload requires added_context or wiki_edit feedback",
        );
      }
      // Canonical mutation owns the new head receipt.  The nested mutation
      // payload owns its requested unit scope, while the outer fields are
      // reserved for the reference-only route.  Rejecting those assertions up
      // front prevents a post-write receipt mismatch from orphaning a Node 9
      // entry or scheduling a duplicate Node 8 correction.
      if (
        contextArtifactId !== undefined ||
        contextEntryVersionId !== undefined ||
        affectedBridgeUnitIds !== undefined
      ) {
        throw new PatchIterationServiceError(
          "context_feedback_receipt_not_allowed",
          "canonical context mutation derives its context receipt and impact server-side",
        );
      }
      if (this.deps.wiki === undefined) {
        throw new PatchIterationServiceError(
          "wiki_not_configured",
          "context feedback requires the installed WikiBrain service",
        );
      }
      const observed = await this.loadObservedPatchRun(input.observedPatchVersionId);
      const receipt = await this.recordCanonicalContextFeedback({
        observed,
        eventKind: input.eventKind,
        contextFeedback: input.contextFeedback,
      });
      assertSuccessfulContextCorrectionReceipt(receipt);
      // Persist the exact Node 9/8 receipt, not client-supplied identity.
      // That receipt proves this feedback versioned canonical context, queued
      // the registered rerun, and names the immutable head/impact consumed by
      // the later refinement snapshot.
      contextArtifactId = receipt.contextArtifactId;
      contextEntryVersionId = receipt.contextEntryVersionId;
      affectedBridgeUnitIds = receipt.affectedUnitIds;
      metadata.contextCorrection = contextCorrectionReceiptMetadata(receipt);
    } else if (input.eventKind === "comment" && (input.affectedBridgeUnitIds?.length ?? 0) > 0) {
      // A scoped play-test comment is not a target-text shortcut. Persist it
      // as a real canonical Node 9 note, which queues the installed Node 8
      // correction worker. The immutable receipt then makes the COMMENT an
      // honest redraft input alongside added-context and wiki-edit feedback.
      if (input.body === undefined || input.body.trim().length === 0) {
        throw new PatchIterationServiceError(
          "scoped_comment_body_required",
          "scoped comment feedback requires a non-blank body for its canonical redraft",
        );
      }
      const scopedCommentUnitIds = uniqueNonBlank(
        input.affectedBridgeUnitIds ?? [],
        "affectedBridgeUnitIds",
      );
      // A scoped comment owns the exact Node 9 receipt.  A caller cannot
      // meaningfully predict a new immutable entry-version ID, so accepting a
      // supplied pair would defer a guaranteed mismatch until after the wiki
      // mutation had already committed.
      if (contextArtifactId !== undefined || contextEntryVersionId !== undefined) {
        throw new PatchIterationServiceError(
          "context_feedback_receipt_not_allowed",
          "scoped comment feedback derives its canonical context receipt server-side",
        );
      }
      const observed = await this.loadObservedPatchRun(input.observedPatchVersionId);
      assertObservedFeedbackUnits(observed.patch, scopedCommentUnitIds, "scoped comment");
      if (this.deps.wiki === undefined) {
        throw new PatchIterationServiceError(
          "wiki_not_configured",
          "scoped comment feedback requires the installed WikiBrain service",
        );
      }
      feedbackEventId = `feedback-event:${randomUUID()}`;
      const receipt = await this.deps.wiki.add({
        projectId: observed.run.projectId,
        localeBranchId: observed.run.localeBranchId,
        sourceRevisionId: observed.run.sourceRevisionId,
        kind: "note",
        title: `Play-test comment ${feedbackEventId}`,
        body: input.body.trim(),
        reason: "Scoped play-test comment requires a durable refinement redraft.",
        affectedUnitIds: scopedCommentUnitIds,
      });
      assertSuccessfulContextCorrectionReceipt(receipt);
      contextArtifactId = receipt.contextArtifactId;
      contextEntryVersionId = receipt.contextEntryVersionId;
      affectedBridgeUnitIds = receipt.affectedUnitIds;
      metadata.contextCorrection = contextCorrectionReceiptMetadata(receipt);
      metadata.commentRedraft = true;
    } else if (input.eventKind === "added_context" || input.eventKind === "wiki_edit") {
      // A user can also attach feedback about a correction already performed
      // through the standalone Node 9 surface. This deliberately remains a
      // reference-only path: do not replay or fabricate text. The immutable
      // artifact/version pair is enough for the refinement to freeze it.
      if (contextArtifactId === undefined || contextEntryVersionId === undefined) {
        throw new PatchIterationServiceError(
          "context_reference_required",
          "reference-only context feedback requires contextArtifactId and contextEntryVersionId",
        );
      }
    }
    return this.deps.iteration.recordFeedbackEvent(this.deps.actor, {
      ...(feedbackEventId === undefined ? {} : { feedbackEventId }),
      observedPatchVersionId: input.observedPatchVersionId,
      eventKind: input.eventKind,
      ...(input.feedbackBatchId === undefined ? {} : { feedbackBatchId: input.feedbackBatchId }),
      ...(input.playSessionId === undefined ? {} : { playSessionId: input.playSessionId }),
      ...(input.body === undefined ? {} : { body: input.body }),
      metadata,
      ...(resultRevisionId === undefined ? {} : { resultRevisionId }),
      ...(contextArtifactId === undefined ? {} : { contextArtifactId }),
      ...(contextEntryVersionId === undefined ? {} : { contextEntryVersionId }),
      ...(affectedBridgeUnitIds === undefined ? {} : { affectedBridgeUnitIds }),
    });
  }

  /** Load the patch run once so Node 9 never accepts caller-supplied scope. */
  private async loadObservedPatchRun(
    patchVersionId: string,
  ): Promise<{ patch: PatchPlaySurface; run: LocalizationJournalRunRecord }> {
    const patch = await this.deps.iteration.loadPatchPlaySurface(this.deps.actor, patchVersionId);
    if (patch === null) {
      throw new PatchIterationServiceError(
        "patch_not_found",
        `observed patch ${patchVersionId} was not found`,
      );
    }
    if (patch.status !== "playable") {
      throw new PatchIterationServiceError(
        "base_patch_not_playable",
        `observed patch ${patchVersionId} is not playable`,
      );
    }
    const run = await this.deps.journal.loadRun(this.deps.actor, patch.runId);
    if (run === null) {
      throw new PatchIterationServiceError(
        "patch_run_not_found",
        `patch ${patch.patchVersionId} refers to missing run ${patch.runId}`,
      );
    }
    return { patch, run };
  }

  /**
   * Delegate context facts to the existing WikiBrain boundary. WikiBrain
   * derives existing-entry source/category/data itself and calls Node 8's
   * ContextCorrectionService, so this coordinator never copies that logic.
   */
  private async recordCanonicalContextFeedback(input: {
    observed: { patch: PatchPlaySurface; run: LocalizationJournalRunRecord };
    eventKind: "added_context" | "wiki_edit";
    contextFeedback: PatchIterationContextFeedbackInput;
  }): Promise<WikiBrainEditResult> {
    const wiki = this.deps.wiki;
    if (wiki === undefined) {
      throw new PatchIterationServiceError(
        "wiki_not_configured",
        "context feedback requires the installed WikiBrain service",
      );
    }
    const { run } = input.observed;
    if (input.contextFeedback.operation === "add") {
      if (input.eventKind !== "added_context") {
        throw new PatchIterationServiceError(
          "context_feedback_kind_mismatch",
          "a new canonical context entry must be recorded as added_context feedback",
        );
      }
      const affectedUnitIds = uniqueNonBlank(
        input.contextFeedback.affectedBridgeUnitIds,
        "contextFeedback.affectedBridgeUnitIds",
      );
      assertObservedFeedbackUnits(input.observed.patch, affectedUnitIds, "context feedback");
      return await wiki.add({
        projectId: run.projectId,
        localeBranchId: run.localeBranchId,
        sourceRevisionId: run.sourceRevisionId,
        kind: input.contextFeedback.kind,
        title: input.contextFeedback.title,
        body: input.contextFeedback.body,
        reason: input.contextFeedback.reason,
        affectedUnitIds,
      });
    }
    if (input.eventKind !== "wiki_edit") {
      throw new PatchIterationServiceError(
        "context_feedback_kind_mismatch",
        "an existing canonical context entry must be recorded as wiki_edit feedback",
      );
    }
    const affectedUnitIds =
      input.contextFeedback.affectedBridgeUnitIds === undefined
        ? undefined
        : uniqueNonBlank(
            input.contextFeedback.affectedBridgeUnitIds,
            "contextFeedback.affectedBridgeUnitIds",
          );
    if (affectedUnitIds !== undefined) {
      assertObservedFeedbackUnits(input.observed.patch, affectedUnitIds, "context feedback");
    }
    return await wiki.edit({
      projectId: run.projectId,
      localeBranchId: run.localeBranchId,
      contextArtifactId: input.contextFeedback.contextArtifactId,
      body: input.contextFeedback.body,
      reason: input.contextFeedback.reason,
      ...(input.contextFeedback.title === undefined ? {} : { title: input.contextFeedback.title }),
      ...(affectedUnitIds === undefined ? {} : { affectedUnitIds }),
    });
  }

  async refine(input: PatchIterationRefineInput): Promise<PatchIterationRefinementResult> {
    const base = await this.deps.iteration.loadPatchPlaySurface(
      this.deps.actor,
      input.basePatchVersionId,
    );
    if (base === null) {
      throw new PatchIterationServiceError(
        "patch_not_found",
        `base patch ${input.basePatchVersionId} was not found`,
      );
    }
    if (base.status !== "playable") {
      throw new PatchIterationServiceError(
        "base_patch_not_playable",
        `base patch ${input.basePatchVersionId} is not playable`,
      );
    }
    const baseRun = await this.deps.journal.loadRun(this.deps.actor, base.runId);
    if (baseRun === null) {
      throw new PatchIterationServiceError(
        "patch_run_not_found",
        `base patch ${base.patchVersionId} refers to missing run ${base.runId}`,
      );
    }
    const inbox = await this.deps.iteration.loadFeedbackInbox(this.deps.actor, base.patchVersionId);
    const selectedFeedback = selectFeedback(inbox, input);
    if (
      selectedFeedback.feedbackBatchIds.length === 0 &&
      selectedFeedback.feedbackEventIds.length === 0
    ) {
      throw new PatchIterationServiceError(
        "feedback_required",
        "a refinement run requires at least one persisted feedback batch or individual feedback event",
      );
    }
    const selectedEvents = selectedFeedback.events;
    assertSelectedContextCorrectionsSucceeded(selectedEvents);
    // Wiki/added-context feedback is created through the existing node-8/9
    // correction path. Drain its registered worker before snapshotting heads;
    // this keeps the flywheel's actual rerun in front of the new immutable
    // refinement identity instead of inventing a second context system.
    if (
      this.deps.contextCorrections !== undefined &&
      selectedEvents.some(
        (event) =>
          event.eventKind === "wiki_edit" ||
          event.eventKind === "added_context" ||
          event.contextArtifactId !== null,
      )
    ) {
      await this.deps.contextCorrections.drain();
    }
    const baseUnitById = new Map(base.units.map((unit) => [unit.bridgeUnitId, unit]));
    const hasChildBoundResultEdit = selectedEvents.some(
      (event) =>
        event.eventKind === "result_edit" &&
        typeof event.metadata.resultRevisionPatchVersionId === "string" &&
        event.metadata.resultRevisionPatchVersionId.trim().length > 0,
    );
    const baseLineagePatchVersionIds = hasChildBoundResultEdit
      ? await loadPatchVersionLineageIds(this.deps.iteration, this.deps.actor, base)
      : new Set([base.patchVersionId]);
    const provenanceOnlyResultEditEventIds = new Set(
      selectedEvents
        .filter((event) => {
          if (event.eventKind !== "result_edit") return false;
          const childPatchVersionId = event.metadata.resultRevisionPatchVersionId;
          return (
            typeof childPatchVersionId === "string" &&
            baseLineagePatchVersionIds.has(childPatchVersionId)
          );
        })
        .map((event) => event.feedbackEventId),
    );
    const activeSelectedEvents = selectedEvents.filter(
      (event) => !provenanceOnlyResultEditEventIds.has(event.feedbackEventId),
    );
    const canonicalRedraftUnitIds = successfulContextRedraftUnitIds(activeSelectedEvents);
    // Only caller-supplied targets are an explicit planning override. A
    // result-edit event supplies the target body after the journal has
    // classified whether that edit is still active for this base patch. In
    // particular, an edit whose selected child is already an ancestor of the
    // base is retained as audit provenance but must not force a second
    // redraft (or replay an older target over a newer child).
    const explicitTargetUnitIds = new Set(Object.keys(input.targetBodiesByUnit ?? {}));
    const targetBodies = new Map<string, string>();
    for (const [bridgeUnitId, targetBody] of Object.entries(input.targetBodiesByUnit ?? {})) {
      assertNonBlankTarget(targetBody, `targetBodiesByUnit.${bridgeUnitId}`);
      targetBodies.set(bridgeUnitId, targetBody);
    }
    for (const event of selectedEvents) {
      if (event.eventKind !== "result_edit") continue;
      if (provenanceOnlyResultEditEventIds.has(event.feedbackEventId)) continue;
      const targetBody = event.metadata.targetBody;
      if (typeof targetBody !== "string" || targetBody.trim().length === 0) {
        throw new PatchIterationServiceError(
          "result_edit_target_missing",
          `result-edit feedback ${event.feedbackEventId} has no persisted targetBody`,
        );
      }
      for (const bridgeUnitId of event.affectedBridgeUnitIds) {
        targetBodies.set(bridgeUnitId, targetBody);
      }
    }
    // A refinement freezes the wiki heads that its selected feedback actually
    // references. Passing an explicit empty list matters: the repository's
    // lower-level convenience default is all current branch heads, which
    // would make an unrelated historical wiki note silently redraft units in
    // an ordinary result-edit/comment refinement. Node 9/8 feedback carries
    // its exact immutable head, so selection rather than broad branch state
    // is the truthful iteration input.
    const feedbackWikiHeads = uniqueWikiHeads(
      selectedEvents.flatMap((event) =>
        event.contextArtifactId !== null && event.contextEntryVersionId !== null
          ? [
              {
                contextArtifactId: event.contextArtifactId,
                contextEntryVersionId: event.contextEntryVersionId,
              },
            ]
          : [],
      ),
    );

    const scopeUnitIds = uniqueNonBlank(
      input.scopeUnitIds === undefined
        ? base.units.map((unit) => unit.bridgeUnitId)
        : input.scopeUnitIds,
      "scopeUnitIds",
    );
    const scopeSet = new Set(scopeUnitIds);
    for (const event of activeSelectedEvents) {
      for (const bridgeUnitId of event.affectedBridgeUnitIds) {
        if (!scopeSet.has(bridgeUnitId)) {
          throw new PatchIterationServiceError(
            "feedback_outside_scope",
            `feedback ${event.feedbackEventId} affects ${bridgeUnitId}, outside the frozen refinement scope`,
          );
        }
      }
    }
    for (const bridgeUnitId of scopeUnitIds) {
      if (!baseUnitById.has(bridgeUnitId) && !targetBodies.has(bridgeUnitId)) {
        throw new PatchIterationServiceError(
          "new_scope_target_required",
          `broadened unit ${bridgeUnitId} requires an explicit target body`,
        );
      }
    }

    const leaseOwnerId = `patch-iteration-refinement:${randomUUID()}`;
    const runId = `patch-iteration-refinement:${randomUUID()}`;
    let refinement: LocalizationRefinementRunRecord;
    try {
      refinement = await this.deps.iteration.createRefinementRun(this.deps.actor, {
        runId,
        projectId: baseRun.projectId,
        localeBranchId: baseRun.localeBranchId,
        sourceRevisionId: baseRun.sourceRevisionId,
        targetLocale: baseRun.targetLocale,
        frozenScope: {
          kind: "patch_iteration_refinement",
          basePatchVersionId: base.patchVersionId,
          unitIds: scopeUnitIds,
        },
        routingPolicy: baseRun.routingPolicy ?? {},
        costPolicy: baseRun.costPolicy ?? {},
        units: scopeUnitIds.map((bridgeUnitId) => ({
          bridgeUnitId,
          sourceUnitKey: `patch-iteration:${bridgeUnitId}`,
          nextAction: {
            kind: "refine_from_play_feedback",
            basePatchVersionId: base.patchVersionId,
          },
        })),
        basePatchVersionId: base.patchVersionId,
        feedbackBatchIds: selectedFeedback.feedbackBatchIds,
        feedbackEventIds: selectedFeedback.feedbackEventIds,
        // An explicit caller list remains an operator override; otherwise this
        // is the exact set linked by selected feedback (including an explicit
        // empty list for result-only/comment iterations).
        wikiHeads: input.wikiHeads === undefined ? feedbackWikiHeads : input.wikiHeads,
        // The DB derives redrafts from selected feedback. Only caller-supplied
        // targets are an override; result-edit feedback is classified there by
        // its selected child lineage, so inherited edits remain provenance.
        redraftUnitIds: [...explicitTargetUnitIds],
        lease: { ownerId: leaseOwnerId },
        createdAt: this.now(),
      });
    } catch (error) {
      // `createRefinementRun` seeds its durable run before loading the full
      // refinement snapshot. If that post-commit read fails, the caller never
      // receives a refinement record but the just-created run still owns a
      // live lease. Recover it by its known id/owner before surfacing the
      // original error; a run another executor has already taken over is left
      // alone rather than terminalized with a stale fence.
      const cleanupFailures: unknown[] = [];
      try {
        const persistedRun = await this.deps.journal.loadRun(this.deps.actor, runId);
        if (persistedRun?.status === "running" && persistedRun.leaseOwnerId === leaseOwnerId) {
          await this.deps.finalizer.terminalize(this.deps.actor, {
            runId,
            terminalStatus: "failed",
            lease: { ownerId: leaseOwnerId, fenceToken: persistedRun.fenceToken },
            rootCause: {
              kind: "itotori_defect",
              stage: "persistence",
              code: error instanceof PatchIterationServiceError ? error.code : "refinement_failure",
              message:
                error instanceof Error && error.message.trim().length > 0
                  ? error.message
                  : "refinement creation failed without a usable error message",
            },
          });
        }
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (cleanupFailures.length > 0) {
        throw new PatchIterationServiceError(
          "refinement_cleanup_failed",
          `refinement ${runId} failed during creation and its cleanup could not complete: ${cleanupFailures
            .map((cleanupError) =>
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            )
            .join("; ")}`,
        );
      }
      throw error;
    }
    const lease: LocalizationJournalRunLeaseIdentity = {
      ownerId: leaseOwnerId,
      fenceToken: refinement.run.fenceToken,
    };
    let materialized:
      | Awaited<ReturnType<ProductionRefinementPatchArtifactMaterializer["materialize"]>>
      | undefined;
    try {
      const plannedByUnit = new Map(
        refinement.members.map((member) => [member.bridgeUnitId, member]),
      );
      const plannedRedraftUnitIds = scopeUnitIds.filter((bridgeUnitId) => {
        const plan = plannedByUnit.get(bridgeUnitId);
        return plan?.strategy === "redraft";
      });
      const unitsWithoutRedraftSource = plannedRedraftUnitIds.filter(
        (bridgeUnitId) =>
          !targetBodies.has(bridgeUnitId) && !canonicalRedraftUnitIds.has(bridgeUnitId),
      );
      if (unitsWithoutRedraftSource.length > 0) {
        throw new PatchIterationServiceError(
          "feedback_redraft_source_missing",
          `selected feedback has no target body or successful canonical redraft receipt for ${unitsWithoutRedraftSource.join(", ")}`,
        );
      }
      // A successful canonical correction is the source of truth for a
      // context/comment redraft. It deliberately replaces a simultaneous
      // result-edit body unless the caller supplied an explicit current
      // override. This also prevents an inherited result edit from masking
      // the durable v3 draft on a selected descendant.
      const canonicalDraftRedraftUnitIds = plannedRedraftUnitIds.filter(
        (bridgeUnitId) =>
          canonicalRedraftUnitIds.has(bridgeUnitId) && !explicitTargetUnitIds.has(bridgeUnitId),
      );
      if (canonicalDraftRedraftUnitIds.length > 0) {
        if (this.deps.draftTexts === undefined) {
          throw new PatchIterationServiceError(
            "redraft_source_not_configured",
            "feedback requires durable Node 8 redraft output, but the locale-branch draft reader is not configured",
          );
        }
        const durableDrafts = await this.deps.draftTexts.load({
          projectId: baseRun.projectId,
          localeBranchId: baseRun.localeBranchId,
          bridgeUnitIds: canonicalDraftRedraftUnitIds,
        });
        for (const bridgeUnitId of canonicalDraftRedraftUnitIds) {
          const targetBody = durableDrafts.get(bridgeUnitId);
          if (targetBody === undefined || targetBody === null || targetBody.trim().length === 0) {
            throw new PatchIterationServiceError(
              "redraft_target_unavailable",
              `registered redraft has no durable non-blank target for ${bridgeUnitId}`,
            );
          }
          const baseTarget = baseUnitById.get(bridgeUnitId)?.targetBody;
          if (baseTarget === targetBody) {
            throw new PatchIterationServiceError(
              "redraft_output_unchanged",
              `registered redraft for ${bridgeUnitId} did not change the observed patch target`,
            );
          }
          targetBodies.set(bridgeUnitId, targetBody);
        }
      }
      const revisedTargets: Array<{ bridgeUnitId: string; targetBody: string }> = [];
      for (const bridgeUnitId of scopeUnitIds) {
        const plan = plannedByUnit.get(bridgeUnitId);
        if (plan === undefined) {
          throw new PatchIterationServiceError(
            "refinement_plan_missing",
            `refinement run ${refinement.run.runId} did not freeze a member for ${bridgeUnitId}`,
          );
        }
        if (plan.strategy === "reuse") continue;
        const targetBody = targetBodies.get(bridgeUnitId);
        if (targetBody === undefined || targetBody.trim().length === 0) {
          throw new PatchIterationServiceError(
            "redraft_target_unavailable",
            `redraft unit ${bridgeUnitId} has no durable target body from feedback or the registered rerun`,
          );
        }
        const baseTarget = baseUnitById.get(bridgeUnitId)?.targetBody;
        if (plan.strategy === "redraft" && baseTarget === targetBody) {
          throw new PatchIterationServiceError(
            "redraft_output_unchanged",
            `redraft unit ${bridgeUnitId} must differ from the observed patch target`,
          );
        }
        await persistRefinementUnit({
          journal: this.deps.journal,
          actor: this.deps.actor,
          runId: refinement.run.runId,
          bridgeUnitId,
          targetLocale: baseRun.targetLocale,
          targetBody,
          lease,
          now: this.now,
        });
        revisedTargets.push({ bridgeUnitId, targetBody });
      }
      if (revisedTargets.length === 0) {
        throw new PatchIterationServiceError(
          "no_refinement_changes",
          "selected feedback did not require a redraft or newly scoped unit",
        );
      }
      const patchVersionId = patchVersionIdFor(refinement.run.runId);
      materialized = await this.materializer.materialize({
        patchVersionId,
        parentPatchVersionId: base.patchVersionId,
        parentArtifactRefs: base.artifactRefs,
        parentArtifactHashes: base.artifactHashes,
        targetRevisions: revisedTargets,
      });
      const patch = await this.deps.finalizer.ensurePatchVersion(this.deps.actor, {
        runId: refinement.run.runId,
        patchVersionId,
        artifactHashes: materialized.artifactHashes,
        artifactRefs: materialized.artifactRefs,
      });
      for (const stage of ["patch_build", "patch_apply", "validation"] as const) {
        await this.deps.finalizer.upsertPatchStageEvidence(this.deps.actor, {
          runId: refinement.run.runId,
          stage,
          status: "succeeded",
          evidence: {
            source: "patch-iteration-service",
            basePatchVersionId: base.patchVersionId,
            feedbackBatchIds: selectedFeedback.feedbackBatchIds,
            feedbackEventIds: selectedFeedback.feedbackEventIds,
          },
        });
      }
      await this.deps.finalizer.enterFinalizing(this.deps.actor, {
        runId: refinement.run.runId,
        lease,
      });
      await this.deps.finalizer.completeSucceededRun(this.deps.actor, {
        runId: refinement.run.runId,
        patchVersionId: patch.patchVersionId,
        lease,
      });
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (materialized !== undefined) {
        try {
          await materialized.cleanup();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      try {
        await this.deps.finalizer.terminalize(this.deps.actor, {
          runId: refinement.run.runId,
          terminalStatus: "failed",
          lease,
          rootCause: {
            kind: "itotori_defect",
            stage: "persistence",
            code: error instanceof PatchIterationServiceError ? error.code : "refinement_failure",
            message:
              error instanceof Error && error.message.trim().length > 0
                ? error.message
                : "refinement failed without a usable error message",
          },
        });
      } catch (terminalizationError) {
        cleanupFailures.push(terminalizationError);
      }
      if (cleanupFailures.length > 0) {
        throw new PatchIterationServiceError(
          "refinement_cleanup_failed",
          `refinement ${refinement.run.runId} failed and its cleanup could not complete: ${cleanupFailures
            .map((cleanupError) =>
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            )
            .join("; ")}`,
        );
      }
      throw error;
    }
    const refinedPatch = await this.deps.iteration.loadPatchPlaySurface(
      this.deps.actor,
      patchVersionIdFor(refinement.run.runId),
    );
    if (refinedPatch === null) {
      throw new PatchIterationServiceError(
        "refined_patch_missing",
        `finalized refinement run ${refinement.run.runId} has no patch version`,
      );
    }
    return { refinement, patch: refinedPatch };
  }
}

/**
 * The UI inbox intentionally inherits ancestor feedback. For result-edit
 * events the atomic child patch in metadata tells us whether the edit is
 * already embodied by this base. Walk the immutable parent chain instead of
 * trusting the event's older observed-patch ID: sibling children remain
 * actionable, while actual ancestors are provenance only.
 */
async function loadPatchVersionLineageIds(
  iteration: Pick<ItotoriLocalizationIterationRepositoryPort, "loadPatchPlaySurface">,
  actor: AuthorizationActor,
  base: PatchPlaySurface,
): Promise<ReadonlySet<string>> {
  const patchVersionIds = new Set<string>([base.patchVersionId]);
  let parentPatchVersionId = base.parentPatchVersionId;
  while (parentPatchVersionId !== null) {
    if (patchVersionIds.has(parentPatchVersionId)) {
      throw new PatchIterationServiceError(
        "patch_not_found",
        `patch version lineage for ${base.patchVersionId} contains a parent cycle`,
      );
    }
    const parent = await iteration.loadPatchPlaySurface(actor, parentPatchVersionId);
    if (parent === null) {
      throw new PatchIterationServiceError(
        "patch_not_found",
        `parent patch ${parentPatchVersionId} for ${base.patchVersionId} was not found`,
      );
    }
    if (parent.patchVersionId !== parentPatchVersionId) {
      throw new PatchIterationServiceError(
        "patch_not_found",
        `parent patch lookup for ${parentPatchVersionId} returned ${parent.patchVersionId}`,
      );
    }
    patchVersionIds.add(parent.patchVersionId);
    parentPatchVersionId = parent.parentPatchVersionId;
  }
  return patchVersionIds;
}

/** Server-authored provenance retained with the immutable feedback event. */
function contextCorrectionReceiptMetadata(receipt: WikiBrainEditResult): Record<string, unknown> {
  return {
    schemaVersion: "itotori.patch-iteration.context-correction.v0",
    correctionId: receipt.correctionId,
    contextArtifactId: receipt.contextArtifactId,
    contextEntryVersionId: receipt.contextEntryVersionId,
    affectedBridgeUnitIds: [...receipt.affectedUnitIds],
    invalidatedArtifactIds: [...receipt.invalidatedArtifactIds],
    redraftJobId: receipt.redraftJobId,
    rerun: { ...receipt.rerun },
    generatedAt: receipt.generatedAt.toISOString(),
  };
}

/**
 * Node 9 commits its canonical entry before Node 8 drains its exact redraft
 * job.  The entry alone is not enough to promise that a feedback selection is
 * refinable: accepting a pending or failed receipt would let a later refine
 * read an unrelated/stale branch draft.  Keep that durable distinction at the
 * service boundary rather than describing every canonical edit as success.
 */
function assertSuccessfulContextCorrectionReceipt(receipt: WikiBrainEditResult): void {
  if (receipt.rerun.state === "succeeded") return;
  throw new PatchIterationServiceError(
    "context_redraft_not_succeeded",
    `canonical context correction ${receipt.correctionId} has a ${receipt.rerun.state} redraft and cannot be used as refinement feedback`,
  );
}

/**
 * Feedback persisted before the receipt gate existed remains immutable.  Do
 * not let an old pending/failed receipt become refinable merely because some
 * other correction later changed the branch draft projection.
 */
function assertSelectedContextCorrectionsSucceeded(
  events: readonly PlayTestFeedbackEventRecord[],
): void {
  for (const event of events) {
    const rerunState = contextCorrectionRerunState(event);
    if (rerunState === null || rerunState === "succeeded") continue;
    throw new PatchIterationServiceError(
      "context_redraft_not_succeeded",
      `feedback ${event.feedbackEventId} has a ${rerunState} canonical context redraft and cannot be refined`,
    );
  }
}

/**
 * A validated immutable context head can supply the durable draft for a
 * context/comment redraft; when the event carries a Node 8 receipt, that
 * exact receipt must have succeeded. A legacy generic comment with affected
 * units is still visible, but cannot accidentally consume an unrelated branch
 * draft and revert the current patch.
 */
function successfulContextRedraftUnitIds(
  events: readonly PlayTestFeedbackEventRecord[],
): ReadonlySet<string> {
  const unitIds = new Set<string>();
  for (const event of events) {
    const rerunState = contextCorrectionRerunState(event);
    // A reference-only context event has no request-time job receipt, but its
    // artifact/version pair was validated against the observed branch by the
    // iteration repository. It remains a supported way to attach a completed
    // standalone Node 9 correction. A receipt that *does* name a pending,
    // failed, or malformed rerun has already been rejected above.
    if (
      event.contextArtifactId === null ||
      event.contextEntryVersionId === null ||
      (rerunState !== null && rerunState !== "succeeded")
    ) {
      continue;
    }
    for (const bridgeUnitId of event.affectedBridgeUnitIds) unitIds.add(bridgeUnitId);
  }
  return unitIds;
}

function contextCorrectionRerunState(event: PlayTestFeedbackEventRecord): string | null {
  // Reference-only feedback predates the service-owned correction receipt and
  // deliberately carries no job metadata. Its immutable head remains a valid
  // reference path; only a feedback event that actually carries correction
  // metadata is subject to this exact-rerun gate.
  if (event.contextArtifactId === null || event.contextEntryVersionId === null) return null;
  const correction = event.metadata.contextCorrection;
  if (!isRecord(correction)) return null;
  const rerun = correction.rerun;
  if (!isRecord(rerun)) return "unverified";
  const state = rerun.state;
  return typeof state === "string" ? state : "unverified";
}

function assertObservedFeedbackUnits(
  patch: PatchPlaySurface,
  bridgeUnitIds: readonly string[],
  label: string,
): void {
  const observedUnitIds = new Set(patch.units.map((unit) => unit.bridgeUnitId));
  for (const bridgeUnitId of bridgeUnitIds) {
    if (observedUnitIds.has(bridgeUnitId)) continue;
    throw new PatchIterationServiceError(
      "feedback_unit_not_observed",
      `${label} unit ${bridgeUnitId} does not belong to observed patch ${patch.patchVersionId}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function persistRefinementUnit(input: {
  journal: ItotoriLocalizationJournalRepositoryPort;
  actor: AuthorizationActor;
  runId: string;
  bridgeUnitId: string;
  targetLocale: string;
  targetBody: string;
  lease: LocalizationJournalRunLeaseIdentity;
  now: () => Date;
}): Promise<void> {
  const id = randomUUID();
  const attemptId = `patch-iteration-attempt:${input.runId}:${input.bridgeUnitId}:${id}`;
  const at = input.now();
  await input.journal.beginAttempt(input.actor, {
    attemptId,
    runId: input.runId,
    bridgeUnitId: input.bridgeUnitId,
    stage: "play_feedback_refinement",
    agentLabel: "patch-iteration-refinement",
    logicalCallId: `patch-iteration:${input.runId}:${input.bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "play-tester-feedback",
    requestedProviderId: "itotori",
    zdr: true,
    artifactRef: `feedback:${input.bridgeUnitId}`,
    startedAt: at,
    lease: input.lease,
  });
  await input.journal.completeAttempt(input.actor, {
    attemptId,
    runId: input.runId,
    bridgeUnitId: input.bridgeUnitId,
    modelId: "play-tester-feedback",
    providerId: "itotori",
    costUsd: "0",
    costKind: "zero",
    tokensIn: 0,
    tokensOut: 0,
    tokenCountSource: "play_feedback",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheDiscountMicrosUsd: 0,
    fallbackUsed: false,
    fallbackPlan: [],
    zdr: true,
    finishState: "feedback_applied",
    refusalState: null,
    validationResult: "accepted",
    failureClass: null,
    retryDecision: "write",
    retryDelayMs: null,
    artifactRef: `feedback:${input.bridgeUnitId}`,
    errorClasses: [],
    completedAt: at,
    lease: input.lease,
  });
  const outcomeId = `patch-iteration-outcome:${input.runId}:${input.bridgeUnitId}`;
  const candidateId = `patch-iteration-candidate:${input.runId}:${input.bridgeUnitId}`;
  const outcome: WrittenUnitOutcome = {
    id: outcomeId,
    status: "written",
    unitId: input.bridgeUnitId,
    targetLocale: input.targetLocale,
    selectedCandidateId: candidateId,
    candidates: [
      {
        id: candidateId,
        outcomeId,
        body: asNonBlankTargetText(input.targetBody),
        producedBy: { modelId: "play-tester-feedback", providerId: "itotori" },
        attemptId,
        kind: "primary",
      },
    ],
    findings: [],
    qualityFlags: [],
    provenance: { origin: "play-test-feedback-refinement" },
    writtenAt: at.toISOString(),
  };
  await input.journal.persistUnit(input.actor, {
    runId: input.runId,
    bridgeUnitId: input.bridgeUnitId,
    sourceUnitKey: `patch-iteration:${input.bridgeUnitId}`,
    outcome,
    attempts: [],
    contextPacket: { kind: "play_test_feedback_refinement" },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: {},
    lease: input.lease,
  });
}

function selectFeedback(
  inbox: PlayTestFeedbackInbox,
  input: PatchIterationRefineInput,
): {
  feedbackBatchIds: string[];
  feedbackEventIds: string[];
  events: PlayTestFeedbackEventRecord[];
} {
  const knownBatchIds = new Set(inbox.batches.map((batch) => batch.feedbackBatchId));
  const feedbackBatchIds = uniqueNonBlank(input.feedbackBatchIds ?? [], "feedbackBatchIds").sort();
  const feedbackEventIds = uniqueNonBlank(input.feedbackEventIds ?? [], "feedbackEventIds").sort();
  const eventById = new Map(
    inbox.batches.flatMap((batch) =>
      batch.events.map((event) => [event.feedbackEventId, event] as const),
    ),
  );
  for (const eventId of feedbackEventIds) {
    if (!eventById.has(eventId)) {
      throw new PatchIterationServiceError(
        "feedback_event_not_observed",
        `feedback event ${eventId} does not belong to observed base patch ${inbox.observedPatchVersionId}`,
      );
    }
  }
  for (const batchId of feedbackBatchIds) {
    if (!knownBatchIds.has(batchId)) {
      throw new PatchIterationServiceError(
        "feedback_batch_not_observed",
        `feedback batch ${batchId} does not belong to observed base patch ${inbox.observedPatchVersionId}`,
      );
    }
  }
  const selectedBatchIds = new Set(feedbackBatchIds);
  const selectedEventIds = new Set(feedbackEventIds);
  return {
    feedbackBatchIds,
    feedbackEventIds,
    // A selected batch expands to all of its immutable events. A selected
    // event outside a selected batch stays a one-event selection: batch
    // siblings are deliberately not pulled into the refinement.
    events: inbox.batches.flatMap((batch) =>
      batch.events.filter(
        (event) =>
          selectedBatchIds.has(batch.feedbackBatchId) ||
          selectedEventIds.has(event.feedbackEventId),
      ),
    ),
  };
}

function uniqueNonBlank(values: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (value.trim().length === 0) {
      throw new PatchIterationServiceError("invalid_input", `${label}[${index}] must be non-blank`);
    }
    if (seen.has(value)) {
      throw new PatchIterationServiceError("invalid_input", `${label} contains duplicate ${value}`);
    }
    seen.add(value);
  }
  return [...seen];
}

function uniqueWikiHeads(
  heads: readonly { contextArtifactId: string; contextEntryVersionId: string }[],
): Array<{ contextArtifactId: string; contextEntryVersionId: string }> {
  const seen = new Set<string>();
  const result: Array<{ contextArtifactId: string; contextEntryVersionId: string }> = [];
  for (const [index, head] of heads.entries()) {
    if (head.contextArtifactId.trim().length === 0) {
      throw new PatchIterationServiceError(
        "invalid_input",
        `feedback wiki head ${index} has a blank contextArtifactId`,
      );
    }
    if (head.contextEntryVersionId.trim().length === 0) {
      throw new PatchIterationServiceError(
        "invalid_input",
        `feedback wiki head ${index} has a blank contextEntryVersionId`,
      );
    }
    const key = `${head.contextArtifactId}\u0000${head.contextEntryVersionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(head);
  }
  return result;
}

function assertNonBlankTarget(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new PatchIterationServiceError("invalid_input", `${label} must be non-blank`);
  }
}

export class PatchIterationServiceError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "patch_not_found"
      | "patch_run_not_found"
      | "base_patch_not_playable"
      | "target_body_required"
      | "result_edit_single_unit"
      | "feedback_unit_not_observed"
      | "scoped_comment_body_required"
      | "context_feedback_kind_mismatch"
      | "wiki_not_configured"
      | "context_feedback_receipt_not_allowed"
      | "context_redraft_not_succeeded"
      | "context_reference_required"
      | "feedback_required"
      | "result_edit_target_missing"
      | "feedback_outside_scope"
      | "new_scope_target_required"
      | "refinement_plan_missing"
      | "redraft_source_not_configured"
      | "feedback_redraft_source_missing"
      | "redraft_target_unavailable"
      | "redraft_output_unchanged"
      | "no_refinement_changes"
      | "refinement_cleanup_failed"
      | "refined_patch_missing"
      | "feedback_event_not_observed"
      | "feedback_batch_not_observed",
    message: string,
  ) {
    super(message);
  }
}
