// A1's model call — composed once per game and dispatched through the sole ZDR
// dispatch boundary. This module owns ONLY the request side: it composes the
// analyst prompt from the A1 specialist's instructions + the operator brief +
// a representative decode slice, and assembles a strict CallSpec that routes to
// the certified deepseek-v4-flash profile (the no-provider-pin routing profile). It builds no
// provider, encrypts no payload, opens no socket — the actual transport is the
// injected `dispatch` (see ./run.ts), and prompt storage is an injected port.

import {
  CALL_SPEC_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
  type CallSpec,
  type EncryptedPayloadRef,
  type RunModeValue,
  type WikiObject,
} from "../../contracts/index.js";
import { sha256 } from "../../llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../../llm/role-model-profiles.js";
import { specialistFor } from "../../roster/index.js";

type Sha256 = `sha256:${string}`;

/** A representative source-language sample the operator/pre-pass hands A1: a few
 * scenes across the dispatch order plus the cast shape. A1 reasons over it; it
 * never re-derives structure the decode already owns. */
export interface StyleLeadSlice {
  readonly sceneId: string;
  readonly excerpt: string;
}

export interface StyleLeadRequest {
  /** The immutable context snapshot A1 reasons against (the claim-validation evidence root). */
  readonly contextSnapshotId: Sha256;
  readonly sourceLanguage: string;
  /** Run disposition carried to the certified call. Defaults to production for
   * existing direct callers; the source-Wiki runner supplies its run scope. */
  readonly runMode?: RunModeValue;
  /** Operator brief — audience, house policy hints, sign-off intent. */
  readonly operatorBrief: string;
  readonly slice: readonly StyleLeadSlice[];
  /** A stable parent-event anchor for the call transcript. */
  readonly parentEventId: Sha256;
}

/** A complete, schema-valid style-contract for a fictional game. This is rendered
 * directly into A1's prompt, so keep it typed against the terminal schema. */
export const STYLE_LEAD_FEW_SHOT_EXAMPLE = {
  schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
  objectId: "style-contract:example-vn",
  version: 2,
  supersedesVersion: 1,
  lang: "ja-JP",
  subject: { kind: "game", id: "example-vn" },
  scope: { kind: "global" },
  kind: "style-contract",
  body: {
    registerPolicy: "Keep narration neutral-polite and let peers speak casually.",
    honorificPolicy: "Retain Japanese honorifics when they mark social distance.",
    nameOrder: "source-order",
    profanityCeiling: "mild",
    punctuationRules: ["Use three periods for an ellipsis.", "Preserve repeated question marks."],
    audienceNote: "Readers of a contemporary visual novel.",
  },
  claims: [
    {
      claimId: "claim:example-vn:style-register",
      statement: "ExampleVN uses neutral-polite narration and casual peer dialogue.",
      scope: { kind: "global" },
      kind: "style",
      confidence: "high",
      citations: [
        {
          evidenceId: "unit:example-vn:scene-0001:0001",
          evidenceHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          snapshotId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          subject: { kind: "unit", id: "example-vn:scene-0001:0001" },
          role: "establishes",
          playOrderIndex: 0,
        },
      ],
    },
  ],
  media: [],
  dependencies: [],
  provisional: false,
  provenance: {
    authorRoleId: "A1",
    contextSnapshotId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    contextScope: "whole-game",
    runMode: "production",
    snapshotKind: "context",
  },
} satisfies WikiObject;

const STYLE_LEAD_FEW_SHOT_JSON = JSON.stringify(STYLE_LEAD_FEW_SHOT_EXAMPLE, null, 2);

/** Compose the A1 system + user prompt. The system prompt is the specialist's
 * versioned instructions (the single source of A1's charter); the user prompt
 * carries the operator brief and the representative slice. Pure and stable. */
export function composeStyleLeadPrompt(request: StyleLeadRequest): {
  readonly system: string;
  readonly user: string;
} {
  const a1 = specialistFor("A1");
  const sliceText = request.slice
    .map((entry) => `## scene ${entry.sceneId}\n${entry.excerpt}`)
    .join("\n\n");
  const user = [
    `Source language: ${request.sourceLanguage}.`,
    "Operator brief:",
    request.operatorBrief,
    "Representative source slice (cite unit evidence ids you rely on):",
    sliceText,
    "Output requirements:",
    "Emit EXACTLY one JSON object of this shape. This is an illustrative example for a different game (ExampleVN); produce values for this game only.",
    "Return valid JSON only: no Markdown, prose, or extra fields. Every claim must cite real unit evidence ids from the provided slice; never reuse ExampleVN ids or hashes.",
    "Complete valid style-contract WikiObject example:",
    STYLE_LEAD_FEW_SHOT_JSON,
  ].join("\n\n");
  return { system: a1.instructions, user };
}

/** Store a composed prompt and return its encrypted reference. Production binds
 * an operator-managed encrypting store; the offline proof binds an inline store
 * whose content hash still resolves. A1 never performs the storage itself. */
export type StylePromptStore = (
  text: string,
  role: "system" | "user",
) => Promise<EncryptedPayloadRef>;

/** The offline / recorded-path store: no ciphertext at rest, but a content hash
 * that matches `sha256(text)` so the dispatch payload check still holds. */
export function inlineStylePromptStore(): StylePromptStore {
  return async (text, role) => ({
    storageRef: `inline:style-lead:${role}`,
    contentHash: sha256(text),
    encryption: "operator-managed",
  });
}

/** The stable schema hash A1 pins for its wiki-object terminal output. */
export function styleLeadTerminalSchemaHash(): Sha256 {
  return sha256(WIKI_OBJECT_SCHEMA_VERSION);
}

/**
 * Assemble the strict A1 CallSpec. The route is DERIVED from the certified
 * deepseek-v4-flash profile — the exact model, the exact ZDR + automatic-
 * fallback provider policy, and the profile version — so this call can name no
 * provider and pin no route. Purpose is `analysis`, role is `A1`, and the
 * terminal output is a `wiki-object` (the style-contract A1 authors).
 */
export function assembleStyleLeadCallSpec(
  request: StyleLeadRequest,
  prompts: { readonly systemRef: EncryptedPayloadRef; readonly userRef: EncryptedPayloadRef },
): CallSpec {
  const a1 = specialistFor("A1");
  const spec: CallSpec = {
    schemaVersion: CALL_SPEC_SCHEMA_VERSION,
    purpose: "analysis",
    roleId: "A1",
    modelProfile: a1.modelProfile,
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
      schemaHash: styleLeadTerminalSchemaHash(),
    },
    promptVersion: a1.version,
    reasoning: a1.reasoning,
    sampling: { temperature: 0, topP: 1, seed: null },
    limits: a1.limits,
    sampleId: null,
    runMode: request.runMode ?? "production",
    contextScope: "whole-game",
  };
  return spec;
}
