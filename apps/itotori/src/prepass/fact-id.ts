// Stable, collision-resistant fact-id segments for the namespaced
// fact-id builder. A decode key that already is a legal identifier segment
// (a uuid7 bridge id, a numeric scene id, a canonical `nam-17` character id) is
// used verbatim; any other key (an arbitrary glossary term form) is encoded as
// a content-addressed `h-<hex>` segment so distinct keys never collide and the
// mapping is deterministic. The raw key is always retained in the fact body, so
// this encoding loses no information.

import { createHash } from "node:crypto";

const LEGAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Map any string to a legal, deterministic fact-id segment (see file note). */
export function stableSegment(raw: string): string {
  if (raw.length <= 64 && LEGAL_SEGMENT.test(raw)) return raw;
  return `h-${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32)}`;
}
