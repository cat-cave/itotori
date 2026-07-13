// The play-tester wiki is a thin application service over the central
// context brain. Reads come from node 6's generic context projection; writes
// intentionally go through node 8's ContextCorrectionService so a human edit
// appends a canonical version, invalidates dependent context, and schedules a
// registered redraft instead of creating a parallel mutable wiki path.

import type {
  WikiContextEntriesFilter,
  WikiContextEntriesReadModel,
  WikiContextEntryHistoryReadModel,
  WikiContextEntryLookup,
  WikiContextEntryReadModel,
} from "@itotori/db";
import type {
  ApplyContextCorrectionInput,
  ContextCorrectionRerunResult,
} from "../orchestrator/context-correction-service.js";

export const WIKI_CONTEXT_EDIT_SCHEMA_VERSION = "wiki.context.edit.v0.2" as const;

/**
 * The caller only supplies the human correction. Entry identity and scope are
 * path/service arguments; source revision, category, semantic data, and
 * citations are always loaded from the canonical entry server-side.
 */
export type EditWikiBrainEntryInput = {
  projectId: string;
  localeBranchId: string;
  contextArtifactId: string;
  body: string;
  reason: string;
  /** A title correction is valid (for example a corrected character name). */
  title?: string;
  /** Additional units the play tester knows this correction affects. */
  affectedUnitIds?: readonly string[];
};

/** Kinds that a play tester may create without fabricating agent-specific data. */
export type AddWikiBrainEntryKind = "note" | "glossary" | "style";

/**
 * New shared-brain context still takes the node-8 correction path. The source
 * revision and affected units are required because a canonical ContextPacket
 * entry without source scope cannot safely invalidate or redraft anything.
 */
export type AddWikiBrainEntryInput = {
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  kind: AddWikiBrainEntryKind;
  title: string;
  body: string;
  reason: string;
  affectedUnitIds: readonly string[];
};

/** Result shared by the HTTP and CLI edit surfaces. */
export type WikiBrainEditResult = {
  schemaVersion: typeof WIKI_CONTEXT_EDIT_SCHEMA_VERSION;
  generatedAt: Date;
  correctionId: string;
  contextArtifactId: string;
  /** The newly selected immutable canonical ContextEntryVersion. */
  contextEntryVersionId: string;
  affectedUnitIds: string[];
  invalidatedArtifactIds: string[];
  /** Registered node-8 redraft job that resolves a fresh ContextPacket. */
  redraftJobId: string;
  /**
   * The durable state of this exact redraft job after the request-time drain.
   * The canonical version is already persisted for every state; callers must
   * branch on this discriminant before describing the rerun as successful.
   */
  rerun: ContextCorrectionRerunResult["rerun"];
  /** Re-read after the correction so callers see the actual new head. */
  entry: WikiContextEntryReadModel["entry"];
};

/**
 * Actor-bound application read port. The DB repository itself takes
 * `(actor, input)`; composition binds the authenticated actor once so callers
 * cannot substitute an actor alongside a wiki request.
 */
export type WikiBrainReadPort = {
  listEntries(input: WikiContextEntriesFilter): Promise<WikiContextEntriesReadModel>;
  showEntry(input: WikiContextEntryLookup): Promise<WikiContextEntryReadModel | null>;
  listEntryHistory(input: WikiContextEntryLookup): Promise<WikiContextEntryHistoryReadModel | null>;
};

export type WikiBrainCorrectionPort = {
  apply(input: ApplyContextCorrectionInput): Promise<ContextCorrectionRerunResult>;
};

export type WikiBrainServiceDeps = {
  /** Actor-bound node-6 generic context projection. */
  readRepository: WikiBrainReadPort;
  /** Actor-bound node-8 canonical correction service. */
  contextCorrections: WikiBrainCorrectionPort;
  now?: () => Date;
};

export interface WikiBrainServicePort {
  list(input: WikiContextEntriesFilter): Promise<WikiContextEntriesReadModel>;
  show(input: WikiContextEntryLookup): Promise<WikiContextEntryReadModel | null>;
  history(input: WikiContextEntryLookup): Promise<WikiContextEntryHistoryReadModel | null>;
  edit(input: EditWikiBrainEntryInput): Promise<WikiBrainEditResult>;
  add(input: AddWikiBrainEntryInput): Promise<WikiBrainEditResult>;
}

export class WikiBrainEntryNotFoundError extends Error {
  constructor(
    input: Pick<EditWikiBrainEntryInput, "projectId" | "localeBranchId" | "contextArtifactId">,
  ) {
    super(
      `wiki entry ${input.contextArtifactId} was not found in project ${input.projectId} locale branch ${input.localeBranchId}`,
    );
    this.name = "WikiBrainEntryNotFoundError";
  }
}

export class WikiBrainEditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiBrainEditInputError";
  }
}

/**
 * Shared application-level wiki surface for dashboard, API, CLI, and direct
 * live proof callers. It contains no direct persistence write: all mutation
 * effects remain owned by ContextCorrectionService.
 */
export class WikiBrainService implements WikiBrainServicePort {
  private readonly now: () => Date;

  constructor(private readonly deps: WikiBrainServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async list(input: WikiContextEntriesFilter): Promise<WikiContextEntriesReadModel> {
    return await this.deps.readRepository.listEntries(input);
  }

  async show(input: WikiContextEntryLookup): Promise<WikiContextEntryReadModel | null> {
    return await this.deps.readRepository.showEntry(input);
  }

  async history(input: WikiContextEntryLookup): Promise<WikiContextEntryHistoryReadModel | null> {
    return await this.deps.readRepository.listEntryHistory(input);
  }

  async edit(input: EditWikiBrainEntryInput): Promise<WikiBrainEditResult> {
    assertNonBlank(input.projectId, "projectId");
    assertNonBlank(input.localeBranchId, "localeBranchId");
    assertNonBlank(input.contextArtifactId, "contextArtifactId");
    assertNonBlank(input.body, "body");
    assertNonBlank(input.reason, "reason");
    if (input.title !== undefined) {
      assertNonBlank(input.title, "title");
    }

    const lookup = {
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      contextArtifactId: input.contextArtifactId,
    };
    // This load is intentionally before correction application. The browser
    // and CLI never get to choose the category, source revision, semantic
    // data, or base citations of an existing canonical entry.
    const existing = await this.deps.readRepository.showEntry(lookup);
    if (existing === null) {
      throw new WikiBrainEntryNotFoundError(input);
    }
    const entry = existing.entry;
    const affectedUnitIds = mergedAffectedUnitIds(entry, input.affectedUnitIds);
    if (affectedUnitIds.length === 0) {
      throw new WikiBrainEditInputError(
        `wiki entry ${entry.contextArtifactId} has no cited or affected units; a correction needs at least one affected unit`,
      );
    }

    const correction = await this.deps.contextCorrections.apply({
      projectId: entry.projectId,
      localeBranchId: entry.localeBranchId,
      // Derive the revision from the canonical entry rather than accepting a
      // stale or forged client value.
      sourceRevisionId: entry.sourceRevisionId,
      contextArtifactId: entry.contextArtifactId,
      // Preserve the exact central category; this is not a wiki-specific kind.
      kind: entry.category,
      title: input.title?.trim() ?? entry.title,
      body: input.body.trim(),
      reason: input.reason.trim(),
      // Preserve current citations/impact, plus any play-tester additions.
      affectedUnitIds,
      // Preserve opaque semantic data, but do not feed node-8's own prior
      // correction markers back into its deterministic correction-id hash.
      // That keeps an identical retry idempotent after a just-written head.
      data: semanticEntryData(entry.data),
    });
    const contextEntryVersionId = correction.contextArtifact.headVersionId;
    if (contextEntryVersionId === null) {
      throw new Error(
        `wiki correction ${correction.correctionId} did not select a canonical context entry version`,
      );
    }

    // Return the actual stored head, including the refreshed provenance,
    // citation snapshot, and impact data, not a client-side reconstruction.
    const canonical = await this.deps.readRepository.showEntry(lookup);
    if (canonical === null) {
      throw new Error(`wiki correction ${correction.correctionId} removed its canonical entry`);
    }
    return {
      schemaVersion: WIKI_CONTEXT_EDIT_SCHEMA_VERSION,
      generatedAt: this.now(),
      correctionId: correction.correctionId,
      contextArtifactId: correction.contextArtifact.contextArtifactId,
      contextEntryVersionId,
      affectedUnitIds: [...correction.affectedUnitIds],
      invalidatedArtifactIds: [...correction.invalidatedArtifactIds],
      redraftJobId: correction.redraftJob.jobId,
      rerun: correction.rerun,
      entry: canonical.entry,
    };
  }

  async add(input: AddWikiBrainEntryInput): Promise<WikiBrainEditResult> {
    assertNonBlank(input.projectId, "projectId");
    assertNonBlank(input.localeBranchId, "localeBranchId");
    assertNonBlank(input.sourceRevisionId, "sourceRevisionId");
    assertNonBlank(input.title, "title");
    assertNonBlank(input.body, "body");
    assertNonBlank(input.reason, "reason");
    const affectedUnitIds = normalizedAffectedUnitIds(input.affectedUnitIds);
    if (affectedUnitIds.length === 0) {
      throw new WikiBrainEditInputError(
        "a new wiki context entry needs at least one affected unit for packet resolution and rerun",
      );
    }

    const correction = await this.deps.contextCorrections.apply({
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      // `undefined` intentionally lets node 8 derive the stable entry id from
      // (project, branch, category, title), retaining correction idempotency.
      kind: categoryForNewWikiKind(input.kind),
      title: input.title.trim(),
      body: input.body.trim(),
      reason: input.reason.trim(),
      affectedUnitIds,
      // New human-authored context has no agent-specific semantic payload to
      // invent. Node 8 owns its correction markers.
      data: {},
    });
    const contextEntryVersionId = correction.contextArtifact.headVersionId;
    if (contextEntryVersionId === null) {
      throw new Error(
        `wiki correction ${correction.correctionId} did not select a canonical context entry version`,
      );
    }
    const canonical = await this.deps.readRepository.showEntry({
      projectId: correction.contextArtifact.projectId,
      localeBranchId: correction.contextArtifact.localeBranchId,
      contextArtifactId: correction.contextArtifact.contextArtifactId,
    });
    if (canonical === null) {
      throw new Error(`wiki correction ${correction.correctionId} did not persist its new entry`);
    }
    return {
      schemaVersion: WIKI_CONTEXT_EDIT_SCHEMA_VERSION,
      generatedAt: this.now(),
      correctionId: correction.correctionId,
      contextArtifactId: correction.contextArtifact.contextArtifactId,
      contextEntryVersionId,
      affectedUnitIds: [...correction.affectedUnitIds],
      invalidatedArtifactIds: [...correction.invalidatedArtifactIds],
      redraftJobId: correction.redraftJob.jobId,
      rerun: correction.rerun,
      entry: canonical.entry,
    };
  }
}

function mergedAffectedUnitIds(
  entry: WikiContextEntryReadModel["entry"],
  requested: readonly string[] | undefined,
): string[] {
  const values = [
    ...entry.citations.map((citation) => citation.bridgeUnitId),
    ...entry.impact.affectedUnitIds,
    ...(requested ?? []),
  ];
  return normalizedAffectedUnitIds(values);
}

function normalizedAffectedUnitIds(values: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    assertNonBlank(value, "affectedUnitIds");
    unique.add(value.trim());
  }
  return [...unique].sort((left, right) => left.localeCompare(right));
}

function categoryForNewWikiKind(
  kind: AddWikiBrainEntryKind,
): "context_note" | "glossary" | "style" {
  switch (kind) {
    case "note":
      return "context_note";
    case "glossary":
      return "glossary";
    case "style":
      return "style";
  }
}

/**
 * ContextCorrectionService adds these provenance-adjacent markers to the
 * durable data record. They are intentionally not semantic entry data, so a
 * retry must not include an old marker when deriving the exact same correction
 * identity. All other opaque agent data is retained byte-for-byte.
 */
function semanticEntryData(data: Record<string, unknown>): Record<string, unknown> {
  const { correctionId: _correctionId, correctionKind: _correctionKind, ...semantic } = data;
  return semantic;
}

function assertNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new WikiBrainEditInputError(`wiki ${label} must be non-empty`);
  }
}
