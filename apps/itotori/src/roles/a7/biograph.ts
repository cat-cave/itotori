// The whole-roster character biography pass.
//
// A7 walks the deterministic character index and emits ONE cited, portrait-
// bearing source-language bio per entry — none skipped. The character SET is the
// index's exactly, so the emitted bios cover precisely the decoded characters.
// LOCAL-ONLY is the default: with no operator-opened egress the pass produces
// qualifying bios from same-game evidence alone and performs zero egress. When
// the operator opens the web channel, each bio additionally carries a facts-
// dominate reconciliation of the sealed web hits — a separate, dominated channel
// that never alters the grounded bio.

import type { ReadModel } from "../../read-tools/index.js";
import type { WebEvidenceReconciliation } from "../../egress/index.js";
import type { WikiObject } from "../../contracts/index.js";

import { assembleCharacterBio } from "./assemble.js";
import { characterIndex, readCharacterEvidence } from "./characters.js";
import { buildCharacterPortrait, type A7PortraitProvider } from "./portrait.js";
import { a7WebEnabled, reconcileCharacterWeb, type A7WebContext } from "./web.js";
import { A7RoleError, type A7Context, type A7ModelCaller } from "./types.js";

/** One character's result: the grounded bio, and — only when the operator opened
 * the web channel — the facts-dominate reconciliation of its web hits. */
export interface A7BioResult {
  readonly characterId: string;
  readonly bio: WikiObject;
  readonly web: WebEvidenceReconciliation | null;
}

/** The whole pass over the character index. */
export interface A7RosterResult {
  readonly bios: readonly A7BioResult[];
  /** Every character the pass covered, in index order (the full index). */
  readonly coveredCharacterIds: readonly string[];
}

/** Optional operator switches for one pass. Absent `web`, the pass is local-only. */
export interface A7BiographOptions {
  readonly web?: A7WebContext;
}

/**
 * Emit one cited, portrait-bearing bio for every character in the deterministic
 * index. Throws {@link A7RoleError} if the index is empty (a game with no decoded
 * characters cannot be biographed) or if coverage does not equal the index (a
 * defensive guard — the loop covers every entry). The web channel runs only when
 * the operator has opened egress for A7; otherwise the pass performs no egress.
 */
export async function biographRoster(
  model: ReadModel,
  context: A7Context,
  modelCaller: A7ModelCaller,
  portraits: A7PortraitProvider,
  options: A7BiographOptions = {},
): Promise<A7RosterResult> {
  const index = characterIndex(model);
  if (index.length === 0) {
    throw new A7RoleError("empty-character-index", "the snapshot carries no decoded characters");
  }
  const webContext = options.web;
  const webEnabled = webContext !== undefined && a7WebEnabled(webContext.policy);

  const bios: A7BioResult[] = [];
  for (const character of index) {
    const evidence = readCharacterEvidence(model, context, character);
    const draft = await modelCaller({
      character: evidence,
      sourceLanguage: model.sourceLanguage,
      webEnabled,
    });
    const portrait = buildCharacterPortrait(evidence.characterId, portraits(evidence.characterId));
    const bio = assembleCharacterBio(model, context, evidence, draft, portrait);
    const web =
      webEnabled && webContext
        ? await reconcileCharacterWeb(webContext, model.snapshotId, evidence)
        : null;
    bios.push({ characterId: evidence.characterId, bio, web });
  }

  const coveredCharacterIds = index.map((character) => character.characterId);
  if (bios.length !== index.length) {
    throw new A7RoleError(
      "coverage-gap",
      `emitted ${bios.length} bios for ${index.length} indexed characters`,
    );
  }
  return { bios, coveredCharacterIds };
}
