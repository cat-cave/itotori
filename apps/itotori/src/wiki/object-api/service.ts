// The wiki object read/write API.
//
// This is the typed list / show / history / edit / feedback / apply surface over
// the WikiObject substrate. It exposes SOURCE wiki objects and per-target bible
// renderings resolved straight from the persisted heads — source truth needs no
// locale branch — and its writes are the non-blocking human edit/feedback path:
// an edit or feedback appends an immutable human input and a durable version and
// returns an IMMEDIATE receipt, while the intentional apply boundary launches the
// bounded child enhancement. Every write is guarded at the boundary: a forged
// category / provenance / scope is rejected against the trusted substrate.
//
// Self-contained: it composes the wiki repository, the human input/enhancement
// path, and the scoped-invalidation planner. It imports nothing from the old
// context-correction worker or context-artifact repository, and nothing from
// agents/**.

import type {
  ItotoriLlmHumanInputRepository,
  ItotoriLlmWikiRepository,
  LlmDependentEdge,
  LlmWikiHeadSelector,
  LlmWikiObjectRecord,
} from "@itotori/db";

import type { WikiObject } from "../../contracts/index.js";
import {
  HumanEnhancementService,
  type DecodedFact,
  type EnhancementRunner,
  type EnhancementSession,
  type JsonValue,
} from "../human-enhancement/index.js";
import { ScopedInvalidationService, type ImpactSet } from "../scoped-invalidation/index.js";
import { guardWriteAssertion, type WikiWriteAssertion } from "./guards.js";
import {
  parseRecord,
  toHistory,
  toView,
  type WikiBadges,
  type WikiHistoryEntry,
  type WikiObjectView,
} from "./read-model.js";

export type { WikiWriteAssertion } from "./guards.js";
export { ForgedWikiAssertionError } from "./guards.js";

/** A wiki object selector: its kind and stable id. Source truth needs no locale
 * branch — a source object is target-agnostic. */
export type WikiObjectSelector = LlmWikiHeadSelector;

/** The list surface: source wiki objects and per-target bible renderings under a
 * snapshot, split by form. */
export interface WikiListResult {
  readonly sourceObjects: readonly WikiObjectView[];
  readonly renderings: readonly WikiObjectView[];
}

/** One downstream consumer of an object: what it consumed and whether it is a
 * protected human-authored target. */
export interface WikiDependentView {
  readonly downstreamObjectId: string;
  readonly downstreamWikiKind: string;
  readonly downstreamVersion: number;
  readonly claimId: string | null;
  readonly fieldPath: readonly string[];
  readonly renderingId: string | null;
  readonly protectedHuman: boolean;
}

/** The show surface: the object view, its immutable history, and its downstream
 * dependency impact (who consumes it). */
export interface WikiShowResult {
  readonly view: WikiObjectView;
  readonly history: readonly WikiHistoryEntry[];
  readonly dependents: readonly WikiDependentView[];
}

/** The immediate durable receipt an edit or feedback returns — non-blocking: the
 * version is already persisted, no inference was awaited. */
export interface WikiWriteReceipt {
  readonly durable: true;
  readonly inputId: string;
  readonly head: WikiHeadReceipt;
  readonly view: WikiObjectView;
  readonly badges: WikiBadges;
  readonly dependencyImpact: ImpactSet;
}

/** The apply receipt: the coalesced enhancement landed a new head. */
export interface WikiApplyReceipt {
  readonly enhancementLaunched: true;
  readonly head: WikiHeadReceipt;
  readonly view: WikiObjectView;
  readonly badges: WikiBadges;
  readonly coalescedInputCount: number;
  readonly resolvedConflictCount: number;
  readonly dependencyImpact: ImpactSet;
}

export interface WikiHeadReceipt {
  readonly objectId: string;
  readonly version: number;
  readonly contentHash: string;
}

export interface WikiObjectApiDeps {
  readonly wiki: ItotoriLlmWikiRepository;
  readonly humanInputs: ItotoriLlmHumanInputRepository;
}

export class WikiObjectApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiObjectApiError";
  }
}

export class WikiObjectApiService {
  private readonly enhancement: HumanEnhancementService;
  private readonly invalidation: ScopedInvalidationService;

  constructor(private readonly deps: WikiObjectApiDeps) {
    this.enhancement = new HumanEnhancementService({
      humanInputs: deps.humanInputs,
      wiki: deps.wiki,
    });
    this.invalidation = new ScopedInvalidationService({ wiki: deps.wiki });
  }

  /** List the current head of every object under a snapshot, split into source
   * objects and per-target renderings. */
  async list(query: { snapshotId: string }): Promise<WikiListResult> {
    const records = await this.deps.wiki.listObjects({ snapshotId: query.snapshotId });
    const sourceObjects: WikiObjectView[] = [];
    const renderings: WikiObjectView[] = [];
    for (const record of records) {
      const view = toView(record);
      if (view.kind === "rendering") renderings.push(view);
      else sourceObjects.push(view);
    }
    return { sourceObjects, renderings };
  }

  /** Show one object: its view, immutable history, and downstream dependents. */
  async show(selector: WikiObjectSelector): Promise<WikiShowResult | null> {
    const chain = await this.deps.wiki.readObjectHistory(selector);
    if (chain.length === 0) return null;
    const head = await this.resolveHead(selector, chain);
    const dependents = await this.deps.wiki.queryDependents({ upstreamObjectId: head.objectId });
    return {
      view: toView(head),
      history: toHistory(chain),
      dependents: dependents.map(toDependentView),
    };
  }

  /** The immutable version history of one object, oldest first. */
  async history(selector: WikiObjectSelector): Promise<readonly WikiHistoryEntry[] | null> {
    const chain = await this.deps.wiki.readObjectHistory(selector);
    if (chain.length === 0) return null;
    return toHistory(chain);
  }

  /**
   * Open a guarded edit session against an object head. The caller-declared
   * category / provenance / scope assertion (if any) is checked against the
   * authoritative head resolved from the substrate; a forged assertion is
   * rejected here before any human input is opened.
   */
  async openEditSession(
    selector: WikiObjectSelector,
    assertion?: WikiWriteAssertion,
  ): Promise<EnhancementSession> {
    if (selector.wikiKind === "localized-rendering") {
      throw new WikiObjectApiError(
        `wiki object ${selector.objectId} is a rendering, not an editable source object`,
      );
    }
    const authoritative = await this.resolveHeadObject(selector);
    guardWriteAssertion(authoritative, assertion);
    return this.enhancement.openSession(selector.objectId, selector.wikiKind);
  }

  /** Append a direct edit — non-blocking. Returns an immediate durable receipt. */
  async edit(
    session: EnhancementSession,
    candidate: unknown,
    createdAt: string,
  ): Promise<WikiWriteReceipt> {
    const priorJson = await this.projectHead(session);
    const receipt = await this.enhancement.appendEdit(session, candidate, createdAt);
    return this.writeReceipt(session, receipt.inputId, priorJson);
  }

  /** Append general feedback — non-blocking. Returns an immediate durable receipt. */
  async feedback(
    session: EnhancementSession,
    candidate: unknown,
    createdAt: string,
  ): Promise<WikiWriteReceipt> {
    const priorJson = await this.projectHead(session);
    const receipt = await this.enhancement.appendFeedback(session, candidate, createdAt);
    return this.writeReceipt(session, receipt.inputId, priorJson);
  }

  /** The apply boundary: coalesce the session and launch one bounded enhancement. */
  async apply(
    session: EnhancementSession,
    options: {
      readonly runner: EnhancementRunner;
      readonly decodedFacts: readonly DecodedFact[];
      readonly createdAt: string;
    },
  ): Promise<WikiApplyReceipt> {
    const priorJson = await this.projectHead(session);
    const receipt = await this.enhancement.apply(session, options);
    const head = await this.resolveHead({
      wikiKind: session.wikiKind,
      objectId: session.objectId,
    });
    const impact = await this.planImpact(priorJson, head.objectJson);
    const view = toView(head);
    return {
      enhancementLaunched: true,
      head: headReceipt(head),
      view,
      badges: view.badges,
      coalescedInputCount: receipt.coalescedInputCount,
      resolvedConflictCount: receipt.resolvedConflictCount,
      dependencyImpact: impact,
    };
  }

  private async writeReceipt(
    session: EnhancementSession,
    inputId: string,
    priorJson: JsonValue,
  ): Promise<WikiWriteReceipt> {
    const head = await this.resolveHead({
      wikiKind: session.wikiKind,
      objectId: session.objectId,
    });
    const view = toView(head);
    const impact = await this.planImpact(priorJson, head.objectJson);
    return {
      durable: true,
      inputId,
      head: headReceipt(head),
      view,
      badges: view.badges,
      dependencyImpact: impact,
    };
  }

  private async planImpact(priorJson: JsonValue, nextJson: string): Promise<ImpactSet> {
    return this.invalidation.planInvalidation({
      priorObjectJson: priorJson,
      nextObjectJson: JSON.parse(nextJson) as JsonValue,
    });
  }

  private async projectHead(session: EnhancementSession): Promise<JsonValue> {
    const json = await this.deps.wiki.readProjectableObject({
      wikiKind: session.wikiKind,
      objectId: session.objectId,
    });
    if (json === null) {
      throw new WikiObjectApiError(`wiki object ${session.objectId} has no projectable head`);
    }
    return JSON.parse(json) as JsonValue;
  }

  private async resolveHeadObject(selector: WikiObjectSelector): Promise<WikiObject> {
    const head = await this.resolveHeadOrNull(selector);
    if (head === null) {
      throw new WikiObjectApiError(`wiki object ${selector.objectId} has no current head`);
    }
    const parsed = parseRecord(head);
    if (parsed.form !== "object") {
      throw new WikiObjectApiError(
        `wiki object ${selector.objectId} is a rendering, not an editable source object`,
      );
    }
    return parsed.object;
  }

  private async resolveHead(
    selector: WikiObjectSelector,
    chain?: readonly LlmWikiObjectRecord[],
  ): Promise<LlmWikiObjectRecord> {
    const head = await this.resolveHeadOrNull(selector, chain);
    if (head === null) {
      throw new WikiObjectApiError(`wiki object ${selector.objectId} has no current head`);
    }
    return head;
  }

  private async resolveHeadOrNull(
    selector: WikiObjectSelector,
    chain?: readonly LlmWikiObjectRecord[],
  ): Promise<LlmWikiObjectRecord | null> {
    const versions = chain ?? (await this.deps.wiki.readObjectHistory(selector));
    if (versions.length === 0) return null;
    const headMeta = await this.deps.wiki.readHead(selector);
    if (headMeta === null) return null;
    return versions.find((record) => record.version === headMeta.version) ?? null;
  }
}

function headReceipt(record: LlmWikiObjectRecord): WikiHeadReceipt {
  return { objectId: record.objectId, version: record.version, contentHash: record.contentHash };
}

function toDependentView(edge: LlmDependentEdge): WikiDependentView {
  return {
    downstreamObjectId: edge.downstreamObjectId,
    downstreamWikiKind: edge.downstreamWikiKind,
    downstreamVersion: edge.downstreamVersion,
    claimId: edge.claimId,
    fieldPath: edge.fieldPath,
    renderingId: edge.renderingId,
    protectedHuman:
      edge.downstreamEditedBy === "human" || edge.downstreamEditedBy === "enhancement",
  };
}
