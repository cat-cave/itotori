// The Terminology Analyst's model call — composed once per ambiguous term and
// dispatched through the sole ZDR dispatch boundary. This module owns ONLY the
// request side: it composes the analyst prompt from the specialist's charter
// plus one ambiguous candidate's BYTE-DERIVED enumeration, and assembles a
// strict CallSpec that routes to the certified deepseek-v4-flash profile (the
// no-provider-pin routing profile). It builds no provider, encrypts no payload,
// opens no socket — the transport is the injected dispatch (see ./run.ts) and
// prompt storage is an injected port. The prompt HANDS the model the fixed
// alias/occurrence enumeration and forbids re-counting or a target form.

import {
  CALL_SPEC_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
  type CallSpec,
  type EncryptedPayloadRef,
  type RunModeValue,
} from "../../contracts/index.js";
import { sha256 } from "../../llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../../llm/role-model-profiles.js";
import { specialistFor } from "../../roster/index.js";

import type { AmbiguousTermCandidate } from "./candidates.js";
import type { TermOccurrenceEvidence } from "./evidence.js";

type Sha256 = `sha256:${string}`;

export interface TermAnalystRequest {
  /** The immutable context snapshot the ruling is proven against. */
  readonly contextSnapshotId: Sha256;
  readonly sourceLanguage: string;
  /** Run disposition carried to the certified call. Defaults to production for
   * existing direct callers; the source-Wiki runner supplies its run scope. */
  readonly runMode?: RunModeValue;
  /** The single ambiguous candidate, with its byte-derived enumeration. */
  readonly candidate: AmbiguousTermCandidate;
  /** Operator brief — house sensitivities, register hints. */
  readonly operatorBrief: string;
  /** A stable parent-event anchor for the call transcript. */
  readonly parentEventId: Sha256;
}

/** Render the byte-derived enumeration the model must treat as fixed fact. */
function candidateEvidence(
  candidate: AmbiguousTermCandidate,
  evidence: TermOccurrenceEvidence,
): string {
  const conflicts = candidate.conflicts.map((conflict) => `- ${conflict.detail}`).join("\n");
  const index = [
    `Term key: ${candidate.termKey}`,
    `Deterministic policy label: ${candidate.policyAction}`,
    `Byte-derived aliases (fixed; do not add, drop, or re-order): ${candidate.aliases.join(" · ")}`,
    `Byte-derived occurrence count (fixed; do not re-count): ${candidate.occurrenceCount}`,
    `Byte-derived occurrence unit keys (cite only these): ${candidate.occurrenceUnitKeys.join(", ")}`,
    "Why ambiguous:",
    conflicts,
  ];
  return [
    ...index,
    "Same-snapshot occurrence evidence (cite ONLY the bracketed label; do not invent an id):",
    ...evidence.occurrences.map(
      (occurrence) =>
        `- [${occurrence.label}] ${occurrence.sourceUnitKey}: ${occurrence.sourceText}`,
    ),
  ].join("\n");
}

/** Compose the analyst system + user prompt. The system prompt is the
 * specialist's versioned charter; the user prompt carries the operator brief and
 * the one candidate's byte-derived enumeration. Pure and stable. */
export function composeTermAnalystPrompt(
  request: TermAnalystRequest,
  evidence: TermOccurrenceEvidence,
): {
  readonly system: string;
  readonly user: string;
} {
  const analyst = specialistFor("A2");
  const user = [
    `Source language: ${request.sourceLanguage}.`,
    "Operator brief:",
    request.operatorBrief,
    "Rule on ONLY this ambiguous candidate. Author meaning, register, source scope,",
    "and confidence in the SOURCE language; never invent a target form and never",
    "restate a count. The enumeration below is byte-derived and authoritative:",
    candidateEvidence(request.candidate, evidence),
    "Return exactly one term-ruling WikiObject as valid JSON only. Every claim must",
    "cite at least one supplied bracketed occurrence label in evidenceId. Copy the",
    "label verbatim; the system resolves all citation coordinates from this snapshot.",
  ].join("\n\n");
  return { system: analyst.instructions, user };
}

/** Store a composed prompt and return its encrypted reference. Production binds
 * an operator-managed encrypting store; the offline proof binds an inline store
 * whose content hash still resolves. The analyst never stores anything itself. */
export type TermPromptStore = (
  text: string,
  role: "system" | "user",
) => Promise<EncryptedPayloadRef>;

/** The offline / recorded-path store: no ciphertext at rest, but a content hash
 * matching sha256(text) so the dispatch payload check still holds. */
export function inlineTermPromptStore(): TermPromptStore {
  return async (text, role) => ({
    storageRef: `inline:term-analyst:${role}`,
    contentHash: sha256(text),
    encryption: "operator-managed",
  });
}

/** The stable schema hash the analyst pins for its wiki-object terminal output. */
export function termAnalystTerminalSchemaHash(): Sha256 {
  return sha256(WIKI_OBJECT_SCHEMA_VERSION);
}

/**
 * Assemble the strict Terminology Analyst CallSpec. The route is DERIVED from the
 * certified deepseek-v4-flash profile — the exact model, the exact ZDR +
 * automatic-fallback provider policy, and the profile version — so this call can
 * name no provider and pin no route. Purpose is `analysis`, the role is the
 * analyst casting, and the terminal output is a `wiki-object` (a term ruling).
 */
export function assembleTermAnalystCallSpec(
  request: TermAnalystRequest,
  prompts: { readonly systemRef: EncryptedPayloadRef; readonly userRef: EncryptedPayloadRef },
): CallSpec {
  const analyst = specialistFor("A2");
  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: "A2",
    modelProfile: analyst.modelProfile,
    modelProfileVersion: deepSeekV4FlashProfile.version,
    requestedModel: deepSeekV4FlashProfile.model,
    providerPolicy: deepSeekV4FlashProfile.providerPolicy,
    parentEventId: request.parentEventId,
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
      schemaHash: termAnalystTerminalSchemaHash(),
    },
    promptVersion: analyst.version,
    reasoning: analyst.reasoning,
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: analyst.limits,
    sampleId: null,
    runMode: request.runMode ?? "production",
    contextScope: "whole-game",
  };
  return spec;
}
