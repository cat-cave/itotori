// Rendering ledgers — the durable record the recovery query reads.
//
// The orchestrator is decoupled from persistence behind the BibleRenderingLedger
// port: `existingKeys` is the missing-rendering query and `record` writes the
// accepted renderings. Two adapters satisfy it. The in-memory ledger is the
// offline proof substrate (and a legitimate ephemeral run store). The repository
// ledger wires onto the REAL wiki substrate: it lists the persisted localized
// renderings for one snapshot + target language to answer the query, and
// persists accepted renderings through the strict LocalizedRendering write gate.

import type { ItotoriLlmWikiRepository } from "@itotori/db";
import type { LocalizedRendering } from "../contracts/index.js";
import { toView } from "../wiki/object-api/read-model.js";
import { persistLocalizedRendering } from "../wiki/object-persistence.js";
import { renderingKey, renderingKeyOf } from "./rendering.js";
import type { BibleRenderingLedger, RenderingKey } from "./types.js";

/** An ephemeral in-memory ledger: keys accumulate as renderings are recorded. */
export class InMemoryBibleRenderingLedger implements BibleRenderingLedger {
  private readonly keys = new Set<RenderingKey>();
  private readonly renderings: LocalizedRendering[] = [];

  constructor(seed: readonly LocalizedRendering[] = []) {
    for (const rendering of seed) this.add(rendering);
  }

  /** Seed a bare rendering key (a completed rendering whose body is not on hand)
   * so a recovery run can be proven without reconstructing content. */
  seedKey(
    sourceObjectKind: string,
    sourceObjectId: string,
    scope: LocalizedRendering["scope"],
    targetLanguage: string,
  ): void {
    this.keys.add(renderingKey(sourceObjectKind, sourceObjectId, scope, targetLanguage));
  }

  private add(rendering: LocalizedRendering): void {
    this.keys.add(renderingKeyOf(rendering));
    this.renderings.push(rendering);
  }

  async existingKeys(): Promise<ReadonlySet<RenderingKey>> {
    return new Set(this.keys);
  }

  async record(renderings: readonly LocalizedRendering[]): Promise<void> {
    for (const rendering of renderings) this.add(rendering);
  }

  /** The renderings recorded so far — for post-run inspection. */
  recorded(): readonly LocalizedRendering[] {
    return [...this.renderings];
  }
}

/** Wire a repository-backed ledger onto the real wiki substrate for one
 * localization snapshot + target language. `existingKeys` lists the persisted
 * renderings; `record` persists each accepted rendering through the strict write
 * gate. */
export function createRepositoryBibleRenderingLedger(deps: {
  readonly repository: ItotoriLlmWikiRepository;
  readonly localizationSnapshotId: string;
  readonly targetLanguage: string;
  readonly now?: () => Date;
}): BibleRenderingLedger {
  const now = deps.now ?? (() => new Date());
  return {
    async existingKeys(): Promise<ReadonlySet<RenderingKey>> {
      const records = await deps.repository.listObjects({
        snapshotId: deps.localizationSnapshotId,
      });
      const keys = new Set<RenderingKey>();
      for (const record of records) {
        const view = toView(record);
        if (view.kind !== "rendering") continue;
        if (view.targetLanguage !== deps.targetLanguage) continue;
        keys.add(
          renderingKey(view.category, view.sourceObjectId, view.routeScope, view.targetLanguage),
        );
      }
      return keys;
    },
    async record(renderings: readonly LocalizedRendering[]): Promise<void> {
      for (const rendering of renderings) {
        await persistLocalizedRendering(deps.repository, rendering, {
          expectedHead: null,
          createdAt: now().toISOString(),
        });
      }
    },
  };
}
