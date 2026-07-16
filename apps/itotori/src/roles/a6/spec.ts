// The Cultural Adaptation Analyst's model call — composed once per flagged unit
// and dispatched through the sole ZDR dispatch boundary. This module owns ONLY
// the request side: it composes the analyst prompt from the specialist's charter
// plus one flagged unit's byte-derived evidence, and assembles a strict CallSpec
// that routes to the certified deepseek-v4-flash profile (the no-provider-pin
// routing profile). It builds no provider, encrypts no payload, opens no socket
// — the transport is the injected dispatch (see ./dispatch.ts) and prompt storage
// is an injected port. The prompt HANDS the model the fixed markers and the
// decoded line, forbids fanning out, and forbids a replacement translation.

import {
  CALL_SPEC_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
  type CallSpec,
  type ContextScopeValue,
  type EncryptedPayloadRef,
  type RunModeValue,
} from "../../contracts/index.js";
import { sha256 } from "../../llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../../llm/role-model-profiles.js";
import { specialistFor } from "../../roster/index.js";

import type { FlaggedAdaptationCandidate } from "./candidates.js";

type Sha256 = `sha256:${string}`;

/** The role this module configures. */
const ADAPTATION_ROLE_ID = "A6" as const;

export interface AdaptationRequest {
  /** The immutable context snapshot the note is proven against. */
  readonly contextSnapshotId: Sha256;
  readonly sourceLanguage: string;
  /** Operator brief — house sensitivities, register / localization posture. */
  readonly operatorBrief: string;
  /** How the run is dispositioned — stamped into every emitted call. */
  readonly runMode: RunModeValue;
  readonly contextScope: ContextScopeValue;
}

/** A stable per-candidate transcript anchor, derived from the snapshot and the
 * flagged unit, so a recorded/offline dispatch can key a result to its unit
 * without decrypting the prompt. */
export function candidateAnchor(request: AdaptationRequest, unitFactId: string): Sha256 {
  return sha256({
    contextSnapshotId: request.contextSnapshotId,
    role: ADAPTATION_ROLE_ID,
    unitFactId,
  });
}

/** Render the byte-derived evidence the model must treat as fixed fact. */
function candidateEvidence(candidate: FlaggedAdaptationCandidate): string {
  return [
    `Flagged unit: ${candidate.sourceUnitKey} (fact ${candidate.unitFactId}).`,
    `Flagged aspects (fixed; author for exactly these): ${candidate.categories.join(", ")}.`,
    `Byte-derived markers (fixed; cite only these, do not add or drop): ${
      candidate.markers.length > 0 ? candidate.markers.join(" · ") : "(none — ruby wordplay signal)"
    }`,
    `Ruby (furigana) wordplay span present: ${candidate.hasRubyWordplay ? "yes" : "no"}.`,
    `Decoded source line (authoritative): ${candidate.sourceText}`,
  ].join("\n");
}

/** Compose the analyst system + user prompt. The system prompt is the
 * specialist's versioned charter; the user prompt carries the operator brief and
 * the one flagged unit's byte-derived evidence. Pure and stable. */
export function composeAdaptationPrompt(
  request: AdaptationRequest,
  candidate: FlaggedAdaptationCandidate,
): { readonly system: string; readonly user: string } {
  const analyst = specialistFor(ADAPTATION_ROLE_ID);
  const user = [
    `Source language: ${request.sourceLanguage}.`,
    "Operator brief:",
    request.operatorBrief,
    "Author a note for ONLY this flagged unit; never fan out to other lines. State",
    "the communicative FUNCTION and BOUNDED OPTIONS with tradeoffs in the SOURCE",
    "language. Never write a single replacement translation. The evidence below is",
    "byte-derived and authoritative:",
    candidateEvidence(candidate),
  ].join("\n\n");
  return { system: analyst.instructions, user };
}

/** Store a composed prompt and return its encrypted reference. Production binds
 * an operator-managed encrypting store; the offline proof binds an inline store
 * whose content hash still resolves. The analyst never stores anything itself. */
export type AdaptationPromptStore = (
  text: string,
  role: "system" | "user",
) => Promise<EncryptedPayloadRef>;

/** The offline / recorded-path store: no ciphertext at rest, but a content hash
 * matching sha256(text) so the dispatch payload check still holds. */
export function inlineAdaptationPromptStore(): AdaptationPromptStore {
  return async (text, role) => ({
    storageRef: `inline:adaptation-analyst:${role}`,
    contentHash: sha256(text),
    encryption: "operator-managed",
  });
}

/** The stable schema hash the analyst pins for its wiki-object terminal output. */
export function adaptationTerminalSchemaHash(): Sha256 {
  return sha256(WIKI_OBJECT_SCHEMA_VERSION);
}

/**
 * Assemble the strict Cultural Adaptation Analyst CallSpec. The route is DERIVED
 * from the certified deepseek-v4-flash profile — the exact model, the exact ZDR +
 * automatic-fallback provider policy, and the profile version — so this call can
 * name no provider and pin no route. Purpose is `analysis`, the role is the
 * analyst casting, and the terminal output is a `wiki-object` (an adaptation
 * note). The run mode is carried from the request; the certified-route assertion
 * (see ./dispatch.ts) binds in EVERY mode, so no mode is a route escape hatch.
 */
export function assembleAdaptationCallSpec(
  request: AdaptationRequest,
  candidate: FlaggedAdaptationCandidate,
  prompts: { readonly systemRef: EncryptedPayloadRef; readonly userRef: EncryptedPayloadRef },
): CallSpec {
  const analyst = specialistFor(ADAPTATION_ROLE_ID);
  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: ADAPTATION_ROLE_ID,
    modelProfile: analyst.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
    parentEventId: candidateAnchor(request, candidate.unitFactId),
    contextSnapshotId: request.contextSnapshotId,
    localizationSnapshotId: null,
    messages: [
      {
        kind: "text",
        eventId: sha256(prompts.systemRef.storageRef),
        role: "system",
        contentEncrypted: prompts.systemRef,
      },
      {
        kind: "text",
        eventId: sha256(prompts.userRef.storageRef),
        role: "user",
        contentEncrypted: prompts.userRef,
      },
    ],
    tools: [],
    output: {
      name: "wiki-object",
      schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
      schemaHash: adaptationTerminalSchemaHash(),
    },
    promptVersion: analyst.version,
    reasoning: analyst.reasoning,
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: analyst.limits,
    sampleId: null,
    runMode: request.runMode,
    contextScope: request.contextScope,
  };
  return spec;
}
