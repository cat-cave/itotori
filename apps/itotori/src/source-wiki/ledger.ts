// Artifact ledgers — the durable record the recovery query reads.
//
// The orchestrator is decoupled from persistence behind the ArtifactLedger port:
// `existingKeys` is the missing-artifact query and `record` writes the accepted
// objects. Two adapters satisfy it. The in-memory ledger is the offline proof
// substrate (and a legitimate ephemeral run store). The repository ledger wires
// onto the REAL wiki substrate: it lists the persisted source objects under a
// snapshot to answer the query, and persists accepted objects through the strict
// WikiObject write gate. Both key objects with the one shared `artifactKeyOf`.

import type { ItotoriLlmWikiRepository } from "@itotori/db";
import type { WikiObject } from "../contracts/index.js";
import { toView } from "../wiki/object-api/read-model.js";
import { persistWikiObject } from "../wiki/object-persistence.js";
import { artifactKey, artifactKeyOf } from "./accept.js";
import type { ArtifactKey, ArtifactLedger } from "./types.js";

/** An ephemeral in-memory ledger: keys accumulate as objects are recorded. */
export class InMemoryArtifactLedger implements ArtifactLedger {
  private readonly keys = new Set<ArtifactKey>();
  private readonly objects: WikiObject[] = [];

  constructor(seed: readonly WikiObject[] = []) {
    for (const object of seed) this.add(object);
  }

  /** Seed a bare artifact key (a completed artifact whose object body is not on
   * hand) so a recovery run can be proven without reconstructing content. */
  seedKey(kind: string, subject: WikiObject["subject"], scope: WikiObject["scope"]): void {
    this.keys.add(artifactKey(kind, subject, scope));
  }

  private add(object: WikiObject): void {
    this.keys.add(artifactKeyOf(object));
    this.objects.push(object);
  }

  async existingKeys(): Promise<ReadonlySet<ArtifactKey>> {
    return new Set(this.keys);
  }

  async record(objects: readonly WikiObject[]): Promise<void> {
    for (const object of objects) this.add(object);
  }

  /** The objects recorded so far — for post-run inspection. */
  recorded(): readonly WikiObject[] {
    return [...this.objects];
  }
}

/** Wire a repository-backed ledger onto the real wiki substrate under one
 * context snapshot. `existingKeys` lists the persisted source objects; `record`
 * persists each accepted object through the strict write gate. */
export function createRepositoryArtifactLedger(deps: {
  readonly repository: ItotoriLlmWikiRepository;
  readonly snapshotId: string;
  readonly now?: () => Date;
}): ArtifactLedger {
  const now = deps.now ?? (() => new Date());
  return {
    async existingKeys(): Promise<ReadonlySet<ArtifactKey>> {
      const records = await deps.repository.listObjects({ snapshotId: deps.snapshotId });
      const keys = new Set<ArtifactKey>();
      for (const record of records) {
        const view = toView(record);
        if (view.kind !== "source") continue;
        keys.add(artifactKey(view.category, view.subject, view.routeScope));
      }
      return keys;
    },
    async record(objects: readonly WikiObject[]): Promise<void> {
      for (const object of objects) {
        await persistWikiObject(deps.repository, object, {
          expectedHead: null,
          createdAt: now().toISOString(),
        });
      }
    },
  };
}
