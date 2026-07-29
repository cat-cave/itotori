import { describe, expect, it } from "vitest";
import {
  CALL_RESULT_SCHEMA_VERSION,
  CallResultSchema,
  WIKI_OBJECT_SCHEMA_VERSION,
  type CallSpec,
  type Citation,
  type RunModeValue,
  type WikiObject,
} from "../src/contracts/index.js";
import {
  assertCallUsesCertifiedRoleModelProfile,
  deepSeekV4FlashProfile,
} from "../src/llm/role-model-profiles.js";
import type { PolicyRecordV02 } from "@itotori/localization-bridge-schema";
import { buildEvidenceIndex } from "../src/wiki/evidence-index.js";
import { CitationResolutionError } from "../src/wiki/citation-resolution.js";
import {
  ambiguousTermCandidates,
  assembleTermAnalystCallSpec,
  assertTermAnalystCertifiedRoute,
  composeTermAnalystPrompt,
  dispatchTermAnalyst,
  inlineTermPromptStore,
  isAmbiguousCandidate,
  recordedTermAnalystModel,
  readTermOccurrenceEvidence,
  runTermAnalyst,
  TermAnalystError,
  TermEnumerationError,
  TermAnalystRouteError,
  type AmbiguousTermCandidate,
  type TermAnalystRequest,
} from "../src/roles/a2/index.js";
import { ROSTER, specialistFor } from "../src/roster/index.js";
import { buildClaimFixture } from "./support/claim-fixture.js";

export const HASH = (c: string): `sha256:${string}` =>
  `sha256:${c.repeat(64)}` as `sha256:${string}`;

export const AI_KEY = "term:ai";

export const SOLO_KEY = "term:solo";

export function policyRecords(): PolicyRecordV02[] {
  const base = {
    policyRecordKind: "romanized_term" as const,
    policyReason: "fixture",
  };
  return [
    {
      ...base,
      policyRecordId: "00000000-0000-7000-8000-000000000001",
      termKey: AI_KEY,
      sourceText: "あ",
      policyAction: "localize",
    },
    {
      ...base,
      policyRecordId: "00000000-0000-7000-8000-000000000002",
      termKey: AI_KEY,
      sourceText: "あ",
      policyAction: "romanize",
    },
    {
      ...base,
      policyRecordId: "00000000-0000-7000-8000-000000000003",
      termKey: SOLO_KEY,
      sourceText: "い",
      policyAction: "localize",
    },
  ] as PolicyRecordV02[];
}

export function fixture() {
  return buildClaimFixture({
    snapshotBundle: (bundle) => ({ ...bundle, policyRecords: policyRecords() }),
  });
}

export function termIndex(model: ReturnType<typeof fixture>["model"]) {
  return model.factSnapshot;
}

export function termRuling(opts: {
  objectId: string;
  snapshotId: `sha256:${string}`;
  lang?: string;
  termId?: string;
  sourceForm?: string;
  aliases?: string[];
  citations: Citation[];
}): WikiObject {
  return {
    schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
    objectId: opts.objectId,
    version: 1,
    lang: opts.lang ?? "ja-JP",
    subject: { kind: "glossary-term", id: opts.termId ?? AI_KEY },
    scope: { kind: "global" },
    kind: "term-ruling",
    body: {
      termId: opts.termId ?? AI_KEY,
      sourceForm: opts.sourceForm ?? "あ",
      meaning: "An informal greeting interjection between peers.",
      register: "Casual; peer-to-peer.",
      confidence: "high",
      sourceScope: { kind: "global" },
      aliases: opts.aliases ?? ["あ"],
    },
    claims: [
      {
        claimId: `${opts.objectId}:term-1`,
        statement: "The term reads as a casual greeting in its occurrences.",
        scope: { kind: "global" },
        kind: "term",
        confidence: "high",
        citations: opts.citations,
      },
    ],
    media: [],
    dependencies: [],
    provisional: false,
    provenance: {
      contextSnapshotId: opts.snapshotId,
      contextScope: "whole-game",
      runMode: "production",
      snapshotKind: "context",
    },
  } as unknown as WikiObject;
}

export function recordedSuccess(object: WikiObject, servedModel = deepSeekV4FlashProfile.model) {
  return CallResultSchema.parse({
    schemaVersion: CALL_RESULT_SCHEMA_VERSION,
    status: "success",
    memoKey: HASH("b"),
    requested: { model: deepSeekV4FlashProfile.model },
    memoHit: true,
    value: object,
    responseEventId: HASH("c"),
    served: { status: "confirmed", model: servedModel, provider: "fireworks" },
    generationId: "generation:a2-rec",
    verification: "verified",
    usage: { promptTokens: 900, completionTokens: 300, reasoningTokens: 120, cachedTokens: 0 },
    billing: { status: "confirmed", costUsd: "0.0009" },
    events: [],
  });
}

export function citationForOccurrence(label: string): Citation {
  return {
    evidenceId: label,
    evidenceHash: HASH("0"),
    snapshotId: HASH("0"),
    subject: { kind: "unit", id: "model-invented-subject" },
    role: "establishes",
    playOrderIndex: 999,
  };
}

export function request(
  snapshotId: `sha256:${string}`,
  candidate: AmbiguousTermCandidate,
  runMode?: RunModeValue,
): TermAnalystRequest {
  return {
    contextSnapshotId: snapshotId,
    sourceLanguage: "ja-JP",
    candidate,
    ...(runMode === undefined ? {} : { runMode }),
    operatorBrief: "House glossary for a peer-to-peer romance VN.",
    parentEventId: HASH("d"),
  };
}

export function aiCandidate(model: ReturnType<typeof fixture>["model"]): AmbiguousTermCandidate {
  return ambiguousTermCandidates(termIndex(model)).find((c) => c.termKey === AI_KEY)!;
}
