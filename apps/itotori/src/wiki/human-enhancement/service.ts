// The human-in-the-loop edit / feedback / apply service.
//
// Direct edits and general feedback are NON-BLOCKING: each appends an immutable
// HumanInput and a durable human-authored WikiObject version, then returns —
// no inference is awaited. An intentional apply boundary coalesces the whole
// session and launches ONE bounded child enhancement from the prior object
// plus the human delta, preserving exact human text unless a decoded fact
// conflicts, preserving unaffected fields, and marking the result
// non-provisional.
//
// This module is self-contained: it composes the wiki persistence layer and
// the human-input table, and imports nothing from the old context-correction
// worker or from the retired execution surface.

import {
  ItotoriLlmHumanInputRepository,
  ItotoriLlmWikiRepository,
  type LlmWikiHead,
} from "@itotori/db";
import { HumanInputSchema, type HumanInput } from "../../contracts/index.js";
import { canonicalJson } from "../../llm/canonical-json.js";
import { persistWikiObject } from "../object-persistence.js";
import {
  detectDecodedFactConflicts,
  reconcileEnhancement,
  type DecodedFact,
  type EnhancementRunner,
} from "./enhancement.js";
import type { JsonValue } from "./field-path.js";
import { applyEdit, coalesceHumanDelta } from "./human-delta.js";

type WikiKind = "source-object" | "translation-object";

export class HumanEnhancementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanEnhancementError";
  }
}

export interface HumanEnhancementDeps {
  readonly humanInputs: ItotoriLlmHumanInputRepository;
  readonly wiki: ItotoriLlmWikiRepository;
}

/** A live edit/feedback session against one WikiObject. It holds the immutable
 * pre-session base and the head as it advances, so the apply boundary can build
 * the enhancement from `(base, delta)` while writing atop the true head. */
export interface EnhancementSession {
  readonly subjectRef: string;
  readonly wikiKind: WikiKind;
  readonly objectId: string;
  readonly baseJson: JsonValue;
  currentHead: LlmWikiHead;
  readonly inputs: HumanInput[];
  /** Once the explicit boundary commits, its receipt is durable and reusable.
   * A repeated click/retry must not start a second child enhancement for the
   * same coalesced session. */
  appliedReceipt?: ApplyReceipt;
  /** Concurrent apply callers share one bounded child rather than racing to
   * launch siblings from the same human delta. */
  applying?: Promise<ApplyReceipt>;
}

export interface AppendReceipt {
  readonly inputId: string;
  readonly head: LlmWikiHead;
}

export interface ApplyReceipt {
  readonly head: LlmWikiHead;
  readonly coalescedInputCount: number;
  readonly resolvedConflictCount: number;
  readonly enhancementLaunched: true;
}

export class HumanEnhancementService {
  constructor(private readonly deps: HumanEnhancementDeps) {}

  /** Begin a session against the current head of `objectId`. */
  async openSession(objectId: string, wikiKind: WikiKind): Promise<EnhancementSession> {
    const head = await this.deps.wiki.readHead({ wikiKind, objectId });
    if (!head) throw new HumanEnhancementError(`wiki object ${objectId} has no current head`);
    const baseJson = await this.readObject(wikiKind, objectId);
    return {
      subjectRef: `${wikiKind}:${objectId}`,
      wikiKind,
      objectId,
      baseJson,
      currentHead: head,
      inputs: [],
    };
  }

  /**
   * Re-open a durable HTTP session.  The browser does not keep an in-memory
   * `EnhancementSession` between edit/feedback and apply, so apply addresses
   * the immutable input ids returned by the earlier receipts.  Their stored
   * payloads and the version immediately preceding the first input reconstruct
   * the exact `(base, delta)` boundary; no client supplied object is trusted.
   */
  async resumeSession(
    objectId: string,
    wikiKind: WikiKind,
    inputIds: readonly string[],
  ): Promise<EnhancementSession> {
    if (inputIds.length === 0) {
      throw new HumanEnhancementError("apply requires at least one durable human input id");
    }
    if (new Set(inputIds).size !== inputIds.length) {
      throw new HumanEnhancementError("apply input ids must be unique");
    }
    const subjectRef = `${wikiKind}:${objectId}`;
    const persisted = await this.deps.humanInputs.list(subjectRef);
    const inputsById = new Map(
      persisted.map((record) => {
        if (record.inputJson === null) {
          throw new HumanEnhancementError(
            `durable human input ${record.inputId} has no readable body`,
          );
        }
        return [record.inputId, HumanInputSchema.parse(JSON.parse(record.inputJson))] as const;
      }),
    );
    const inputs = inputIds.map((inputId) => {
      const input = inputsById.get(inputId);
      if (input === undefined) {
        throw new HumanEnhancementError(
          `durable human input ${inputId} does not belong to wiki object ${objectId}`,
        );
      }
      return input;
    });
    const versions = await this.deps.wiki.readObjectHistory({ wikiKind, objectId });
    const firstInput = inputs[0];
    if (firstInput === undefined) {
      throw new HumanEnhancementError("apply requires at least one durable human input id");
    }
    const firstVersionIndex = versions.findIndex((record) => {
      const value: unknown = JSON.parse(record.objectJson);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const provenance = (value as Record<string, unknown>).provenance;
      if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) {
        return false;
      }
      const humanInput = (provenance as Record<string, unknown>).humanInput;
      return (
        typeof humanInput === "object" &&
        humanInput !== null &&
        !Array.isArray(humanInput) &&
        (humanInput as Record<string, unknown>).inputId === firstInput.inputId
      );
    });
    if (firstVersionIndex <= 0) {
      throw new HumanEnhancementError(
        `durable human input ${firstInput.inputId} has no reconstructable prior wiki version`,
      );
    }
    const base = versions[firstVersionIndex - 1];
    const head = await this.deps.wiki.readHead({ wikiKind, objectId });
    if (base === undefined || head === null) {
      throw new HumanEnhancementError(`wiki object ${objectId} has no current head`);
    }
    return {
      subjectRef,
      wikiKind,
      objectId,
      baseJson: JSON.parse(base.objectJson) as JsonValue,
      currentHead: head,
      inputs,
    };
  }

  /**
   * Append a direct edit: persist the immutable HumanInput, apply the exact
   * operations to the current head, and append a human-authored version. Returns
   * WITHOUT launching any enhancement.
   */
  async appendEdit(
    session: EnhancementSession,
    candidate: unknown,
    createdAt: string,
  ): Promise<AppendReceipt> {
    const input = HumanInputSchema.parse(candidate);
    if (input.kind !== "edit") {
      throw new HumanEnhancementError("appendEdit requires an edit HumanInput");
    }
    this.assertSessionIsOpen(session);
    const currentJson = await this.readObject(session.wikiKind, session.objectId);
    const editedJson = applyEdit(currentJson, input);
    // Validate the exact mechanical edit before appending its immutable receipt:
    // an invalid/stale edit must not leave a stranded HumanInput with no version.
    await this.persistHumanInput(session, input, createdAt);
    const stamped = stampProvenance(editedJson, {
      version: session.currentHead.version + 1,
      supersedesVersion: session.currentHead.version,
      editedBy: "human",
      humanInput: input,
      provisional: false,
    });
    const head = await this.commit(session, stamped, createdAt);
    session.inputs.push(input);
    return { inputId: input.inputId, head };
  }

  /**
   * Append general feedback: persist the immutable HumanInput and append a
   * human-authored version that carries the feedback in provenance (the body is
   * unchanged — feedback is resolved later by the enhancement). Non-blocking.
   */
  async appendFeedback(
    session: EnhancementSession,
    candidate: unknown,
    createdAt: string,
  ): Promise<AppendReceipt> {
    const input = HumanInputSchema.parse(candidate);
    if (input.kind !== "feedback") {
      throw new HumanEnhancementError("appendFeedback requires a feedback HumanInput");
    }
    this.assertSessionIsOpen(session);
    await this.persistHumanInput(session, input, createdAt);
    const currentJson = await this.readObject(session.wikiKind, session.objectId);
    const stamped = stampProvenance(currentJson, {
      version: session.currentHead.version + 1,
      supersedesVersion: session.currentHead.version,
      editedBy: "human",
      humanInput: input,
      provisional: false,
    });
    const head = await this.commit(session, stamped, createdAt);
    session.inputs.push(input);
    return { inputId: input.inputId, head };
  }

  /**
   * The apply boundary: coalesce the session and launch exactly ONE bounded
   * child enhancement from `(base, delta)`. Preserves human text unless a
   * decoded fact conflicts, preserves unaffected fields, and marks the version
   * non-provisional.
   */
  async apply(
    session: EnhancementSession,
    options: {
      readonly runner: EnhancementRunner;
      readonly decodedFacts: readonly DecodedFact[];
      readonly createdAt: string;
    },
  ): Promise<ApplyReceipt> {
    if (session.appliedReceipt) return session.appliedReceipt;
    if (session.applying) return session.applying;

    const applying = this.applyOnce(session, options);
    session.applying = applying;
    try {
      const receipt = await applying;
      session.appliedReceipt = receipt;
      return receipt;
    } finally {
      delete session.applying;
    }
  }

  private async applyOnce(
    session: EnhancementSession,
    options: {
      readonly runner: EnhancementRunner;
      readonly decodedFacts: readonly DecodedFact[];
      readonly createdAt: string;
    },
  ): Promise<ApplyReceipt> {
    if (session.inputs.length === 0) {
      throw new HumanEnhancementError("apply requires at least one session input to enhance");
    }
    const delta = coalesceHumanDelta(session.inputs);
    const humanAppliedJson = await this.readObject(session.wikiKind, session.objectId);
    const conflictResolutions = detectDecodedFactConflicts(
      humanAppliedJson,
      options.decodedFacts,
      delta,
    );

    // Exactly one bounded child enhancement, from prior object plus human delta.
    const proposal = await options.runner({
      priorObjectJson: session.baseJson,
      humanAppliedJson,
      delta,
      decodedFactConflicts: [...conflictResolutions.keys()].map(
        (key) => JSON.parse(key) as string[],
      ),
    });

    const reconciled = reconcileEnhancement({
      humanAppliedJson,
      proposal,
      delta,
      conflictResolutions,
    });
    const lastInput = session.inputs[session.inputs.length - 1];
    if (!lastInput) {
      throw new HumanEnhancementError("apply requires at least one session input to enhance");
    }
    const stamped = stampProvenance(reconciled, {
      version: session.currentHead.version + 1,
      supersedesVersion: session.currentHead.version,
      editedBy: "enhancement",
      humanInput: lastInput,
      basisVersion: session.currentHead.version,
      provisional: false,
      ...(proposal.authorMemoKey !== undefined ? { authorMemoKey: proposal.authorMemoKey } : {}),
    });
    const head = await this.commit(session, stamped, options.createdAt);
    return {
      head,
      coalescedInputCount: delta.inputs.length,
      resolvedConflictCount: conflictResolutions.size,
      enhancementLaunched: true,
    };
  }

  private assertSessionIsOpen(session: EnhancementSession): void {
    if (session.appliedReceipt || session.applying) {
      throw new HumanEnhancementError("append requires a new session after apply");
    }
  }

  private async persistHumanInput(
    session: EnhancementSession,
    input: HumanInput,
    createdAt: string,
  ): Promise<void> {
    await this.deps.humanInputs.append({
      inputId: input.inputId,
      inputKind: input.kind,
      subjectRef: session.subjectRef,
      inputJson: canonicalJson(input),
      createdAt,
    });
  }

  private async commit(
    session: EnhancementSession,
    candidate: JsonValue,
    createdAt: string,
  ): Promise<LlmWikiHead> {
    const head = await persistWikiObject(this.deps.wiki, candidate, {
      expectedHead: session.currentHead,
      createdAt,
    });
    session.currentHead = head;
    return head;
  }

  private async readObject(wikiKind: WikiKind, objectId: string): Promise<JsonValue> {
    const json = await this.deps.wiki.readProjectableObject({ wikiKind, objectId });
    if (json === null)
      throw new HumanEnhancementError(`wiki object ${objectId} is not projectable`);
    return JSON.parse(json) as JsonValue;
  }
}

interface ProvenanceStamp {
  readonly version: number;
  readonly supersedesVersion: number;
  readonly editedBy: "human" | "enhancement";
  readonly humanInput: HumanInput;
  readonly basisVersion?: number;
  readonly authorMemoKey?: string;
  readonly provisional?: boolean;
}

/** Stamp version and provenance onto an object body without disturbing any
 * other field. `provisional` is only changed when explicitly given (the
 * enhancement marks the human-touched version non-provisional). */
function stampProvenance(objectJson: JsonValue, stamp: ProvenanceStamp): JsonValue {
  if (typeof objectJson !== "object" || objectJson === null || Array.isArray(objectJson)) {
    throw new HumanEnhancementError("wiki object must be a JSON object");
  }
  const provenance = objectJson.provenance;
  if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) {
    throw new HumanEnhancementError("wiki object is missing provenance");
  }
  const nextProvenance: { [key: string]: JsonValue } = {
    ...provenance,
    editedBy: stamp.editedBy,
    humanInput: stamp.humanInput as unknown as JsonValue,
  };
  if (stamp.basisVersion !== undefined) nextProvenance.basisVersion = stamp.basisVersion;
  if (stamp.authorMemoKey !== undefined) nextProvenance.authorMemoKey = stamp.authorMemoKey;
  const next: { [key: string]: JsonValue } = {
    ...objectJson,
    version: stamp.version,
    supersedesVersion: stamp.supersedesVersion,
    provenance: nextProvenance,
  };
  if (stamp.provisional !== undefined) next.provisional = stamp.provisional;
  return next;
}
