import { createUuid7 } from "@itotori/db";
import { estimateTokens } from "../../batch-planner/token-estimator.js";
import { assertReportedTokenCount } from "../../providers/token-accounting.js";
import type {
  ModelInvocationRequest,
  ModelMessage,
  ModelProvider,
  ProviderRunRecord,
} from "../../providers/types.js";
import { buildPrompt, PROMPT_TEMPLATE_VERSION_V1, promptHash } from "./prompt-template.js";
import {
  ExistingGlossaryConflictError,
  TERMINOLOGY_CANDIDATE_KINDS,
  TerminologyCandidateEmptyInputError,
  TerminologyCandidateInvalidKindError,
  TerminologyCandidateLocaleMismatchError,
  TerminologyCandidateNotInUnitsError,
  TerminologyCandidateParseError,
  TerminologyCandidateUncitedError,
  TerminologyCandidateUnknownCitationError,
  type CandidateKind,
  type ExistingGlossaryEntry,
  type ProviderEmittedPack,
  type TerminologyCandidate,
  type TerminologyCandidateInput,
  type TerminologyCandidateOutput,
} from "./shapes.js";

export type GenerateTerminologyCandidatesOptions = {
  provider: ModelProvider;
};

export async function generateTerminologyCandidates(
  input: TerminologyCandidateInput,
  options: GenerateTerminologyCandidatesOptions,
): Promise<TerminologyCandidateOutput> {
  // 1. Source locale must be non-empty.
  if (!input.sourceLocale || input.sourceLocale.trim().length === 0) {
    throw new TerminologyCandidateLocaleMismatchError(
      "<project sourceLocale>",
      input.sourceLocale ?? "",
    );
  }

  // 2. Non-empty input.
  if (input.units.length === 0) {
    throw new TerminologyCandidateEmptyInputError(input.projectId);
  }

  // 3. Build the conflict index (load-bearing pre-persist conflict
  //    check). Maps every alias + preferredSourceForm to the owning
  //    terminologyTermId.
  const conflictIndex = buildConflictIndex(input.existingGlossary);

  const templateVersion = input.promptTemplateVersion ?? PROMPT_TEMPLATE_VERSION_V1;
  const rendered = buildPrompt(input);
  const hash = promptHash(rendered);

  const messages: ModelMessage[] = [
    { role: "system", content: rendered.systemText },
    { role: "user", content: rendered.userText },
  ];
  const request: ModelInvocationRequest = {
    taskKind: "experiment",
    modelId: input.modelProfile.modelId,
    providerId: input.modelProfile.providerId,
    inputClassification: "private_corpus",
    messages,
    prompt: {
      presetId: "itotori-terminology-candidate",
      templateVersion,
      promptHash: `sha256:${hash}`,
    },
    generation:
      input.modelProfile.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.modelProfile.maxOutputTokens },
  };

  const invocation = await options.provider.invoke(request);
  const providerRun: ProviderRunRecord = invocation.providerRun;
  const pack = parseProviderPack(invocation.content ?? "");

  const sourceHashByUnitId = new Map<string, string>();
  const sourceTextByUnitId = new Map<string, string>();
  const validUnitIds = new Set<string>();
  for (const unit of input.units) {
    sourceHashByUnitId.set(unit.bridgeUnitId, unit.sourceHash);
    sourceTextByUnitId.set(unit.bridgeUnitId, unit.sourceText);
    validUnitIds.add(unit.bridgeUnitId);
  }

  const now = (input.now ?? (() => new Date()))();
  const generatedAt = now.toISOString();
  // `inputTokenEstimate` is an explicit pre-flight estimate stored in a
  // field that names itself as such — honest provenance, not a real count.
  const inputTokenEstimate = estimateTokens(`${rendered.systemText}\n${rendered.userText}`);
  // `completionTokens` is a REAL count: throw on absence rather than
  // substitute an estimate (PROJECT LAW, mirror of assertBilledCost).
  const completionTokens = assertReportedTokenCount(
    providerRun.tokenUsage,
    "completionTokens",
    providerRun.runId,
  );

  const candidates: TerminologyCandidate[] = [];
  for (const emitted of pack.candidates) {
    if (!isValidCandidateKind(emitted.kind)) {
      throw new TerminologyCandidateInvalidKindError(emitted.kind);
    }
    if (emitted.surfaceForm.trim().length === 0) {
      throw new TerminologyCandidateUncitedError(emitted.surfaceForm);
    }
    if (emitted.citedUnitIds.length === 0) {
      throw new TerminologyCandidateUncitedError(emitted.surfaceForm);
    }
    // Pre-persist conflict check against the supplied existingGlossary.
    const conflict = conflictIndex.get(emitted.surfaceForm);
    if (conflict !== undefined) {
      throw new ExistingGlossaryConflictError(emitted.surfaceForm, conflict);
    }
    const citedUnitIds: string[] = [];
    const citedUnitHashes: string[] = [];
    let surfaceFormAppearsInCitedUnit = false;
    for (const id of emitted.citedUnitIds) {
      if (!validUnitIds.has(id)) {
        throw new TerminologyCandidateUnknownCitationError(id, `candidate ${emitted.surfaceForm}`);
      }
      const hashValue = sourceHashByUnitId.get(id);
      if (!hashValue) {
        throw new TerminologyCandidateUnknownCitationError(
          id,
          `candidate ${emitted.surfaceForm} (no source hash)`,
        );
      }
      citedUnitIds.push(id);
      citedUnitHashes.push(hashValue);
      const sourceText = sourceTextByUnitId.get(id) ?? "";
      if (sourceText.includes(emitted.surfaceForm)) {
        surfaceFormAppearsInCitedUnit = true;
      }
    }
    if (!surfaceFormAppearsInCitedUnit) {
      throw new TerminologyCandidateNotInUnitsError(emitted.surfaceForm);
    }
    const candidate: TerminologyCandidate = {
      id: createUuid7(),
      projectId: input.projectId,
      localeBranchId: input.localeBranchId,
      sourceRevisionId: input.sourceRevisionId,
      kind: emitted.kind,
      surfaceForm: emitted.surfaceForm,
      surfaceLocale: input.sourceLocale,
      rationale: emitted.rationale,
      ...(emitted.readingHint !== undefined ? { readingHint: emitted.readingHint } : {}),
      citedUnitIds,
      citedUnitHashes,
      modelProfile: input.modelProfile,
      promptTemplateVersion: templateVersion,
      promptHash: hash,
      inputTokenEstimate,
      completionTokens,
      generatedAt,
      status: "Fresh",
    };
    candidates.push(candidate);
  }

  return { candidates, providerRun };
}

export async function generateTerminologyCandidatesBatch(
  inputs: ReadonlyArray<TerminologyCandidateInput>,
  options: GenerateTerminologyCandidatesOptions,
): Promise<TerminologyCandidateOutput[]> {
  const results: TerminologyCandidateOutput[] = [];
  for (const input of inputs) {
    results.push(await generateTerminologyCandidates(input, options));
  }
  return results;
}

export function buildConflictIndex(
  existingGlossary: ReadonlyArray<ExistingGlossaryEntry>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of existingGlossary) {
    if (entry.preferredSourceForm.trim().length > 0) {
      index.set(entry.preferredSourceForm, entry.terminologyTermId);
    }
    for (const alias of entry.aliases) {
      if (alias.trim().length > 0) {
        index.set(alias, entry.terminologyTermId);
      }
    }
  }
  return index;
}

function parseProviderPack(content: string): ProviderEmittedPack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new TerminologyCandidateParseError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new TerminologyCandidateParseError("output is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const candidatesRaw = Array.isArray(record.candidates) ? record.candidates : null;
  if (candidatesRaw === null) {
    throw new TerminologyCandidateParseError("output.candidates is not an array");
  }
  const candidates: ProviderEmittedPack["candidates"] = [];
  for (const entry of candidatesRaw) {
    if (typeof entry !== "object" || entry === null) {
      throw new TerminologyCandidateParseError("output.candidates entry not an object");
    }
    const row = entry as Record<string, unknown>;
    const kindRaw = typeof row.kind === "string" ? row.kind : null;
    const surfaceForm = typeof row.surfaceForm === "string" ? row.surfaceForm : null;
    const rationale = typeof row.rationale === "string" ? row.rationale : null;
    const readingHint = typeof row.readingHint === "string" ? row.readingHint : undefined;
    const citedUnitIds = Array.isArray(row.citedUnitIds)
      ? row.citedUnitIds.filter((id): id is string => typeof id === "string")
      : null;
    if (kindRaw === null || surfaceForm === null || rationale === null || citedUnitIds === null) {
      throw new TerminologyCandidateParseError("output.candidates entry missing required field");
    }
    if (!isValidCandidateKind(kindRaw)) {
      throw new TerminologyCandidateInvalidKindError(kindRaw);
    }
    candidates.push({
      kind: kindRaw,
      surfaceForm,
      rationale,
      ...(readingHint !== undefined ? { readingHint } : {}),
      citedUnitIds,
    });
  }
  return { candidates };
}

function isValidCandidateKind(value: string): value is CandidateKind {
  return (TERMINOLOGY_CANDIDATE_KINDS as ReadonlyArray<string>).includes(value);
}
