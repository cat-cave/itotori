import { randomBytes } from "node:crypto";

import { digest, type EvidenceRecord } from "./evidence-contract.js";
import { treeDigest } from "./evidence-portability.js";
import type { FieldPopulation } from "./evidence-audit-types.js";

export function publicPopulation(left: EvidenceRecord, right: EvidenceRecord): FieldPopulation[] {
  const complete = left.localFactsVerified && right.localFactsVerified ? 2 : 0;
  return ["producer", "sourceRevision", "inputHash", "outputHash", "privacyClass", "outcome"].map(
    (field) => ({ field, nonemptyCount: complete, totalCount: 2 }),
  );
}

export function randomizedFactCommitment(bundleRoot: string, hiddenFacts: string): string {
  return digest(
    Buffer.concat([randomBytes(32), Buffer.from(treeDigest(bundleRoot)), Buffer.from(hiddenFacts)]),
  );
}
