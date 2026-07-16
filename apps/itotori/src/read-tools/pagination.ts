// Deterministic pagination, cursors, and content-address hashing.
//
// A tool computes the FULL ordered result once; a page is a contiguous slice of
// it. Cursors bind to (snapshotId, requestHash) so a cursor cannot cross into a
// different request, and are opaque. Byte accounting measures each item by its
// own canonical JSON length — independent of where a page boundary falls — so
// the sum of per-page returnedBytes equals the unpaged returnedBytes, and
// concatenating the pages' items reproduces the unpaged ordered list exactly.
// Nothing is ever truncated: a result that does not fit carries a cursor, and a
// single item larger than the byte budget FAILS LOUD rather than being clipped.

import { canonicalLlmJson, llmSha256, type LlmJsonValue } from "@itotori/db";

import { ReadToolError } from "./access.js";

/** The wire page-status block shared by every tool result envelope. */
export interface ToolResultPage {
  requestCursor: string | null;
  returnedRows: number;
  returnedBytes: number;
  maxRows: number;
  maxBytes: number;
  kind: "complete" | "more";
  nextCursor: string | null;
}

export interface PaginateInput<T> {
  items: readonly T[];
  cursor: string | null;
  maxRows: number;
  maxBytes: number;
  /** Binds the cursor to this exact request (snapshot + tool + normalized args). */
  requestHash: string;
}

export interface PaginateOutput<T> {
  window: T[];
  page: ToolResultPage;
}

/** UTF-8 byte length of an item's canonical JSON — the stable per-item measure. */
export function canonicalByteLength(item: LlmJsonValue): number {
  return Buffer.byteLength(canonicalLlmJson(item), "utf8");
}

function encodeCursor(requestHash: string, offset: number): string {
  const hex = requestHash.replace(/^sha256:/u, "");
  return Buffer.from(`${hex}.${offset}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string, requestHash: string, itemCount: number): number {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new ReadToolError("cursor-mismatch", "cursor is not a valid token");
  }
  const separator = decoded.lastIndexOf(".");
  const hex = decoded.slice(0, separator);
  const offset = Number(decoded.slice(separator + 1));
  if (separator < 0 || `sha256:${hex}` !== requestHash) {
    throw new ReadToolError("cursor-mismatch", "cursor does not belong to this request");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > itemCount) {
    throw new ReadToolError("cursor-mismatch", "cursor offset is out of range");
  }
  return offset;
}

/**
 * Slice a contiguous page from `items`, enforcing explicit row and byte bounds.
 * The returned page reports where it started (`requestCursor`), how much it
 * returned, and — when unexhausted — a `nextCursor` to resume from.
 */
export function paginate<T extends LlmJsonValue>(input: PaginateInput<T>): PaginateOutput<T> {
  const { items, cursor, maxRows, maxBytes, requestHash } = input;
  const start = cursor === null ? 0 : decodeCursor(cursor, requestHash, items.length);

  let rows = 0;
  let bytes = 0;
  let index = start;
  while (index < items.length) {
    const size = canonicalByteLength(items[index]!);
    if (rows === 0 && size > maxBytes) {
      throw new ReadToolError(
        "row-exceeds-byte-budget",
        `row at offset ${index} needs ${size} bytes, over the ${maxBytes}-byte budget`,
      );
    }
    if (rows + 1 > maxRows || bytes + size > maxBytes) break;
    bytes += size;
    rows += 1;
    index += 1;
  }

  const window = items.slice(start, index);
  const exhausted = index >= items.length;
  return {
    window,
    page: {
      requestCursor: cursor,
      returnedRows: rows,
      returnedBytes: bytes,
      maxRows,
      maxBytes,
      kind: exhausted ? "complete" : "more",
      nextCursor: exhausted ? null : encodeCursor(requestHash, index),
    },
  };
}

/** The request hash binds a page's cursor to the snapshot + tool + args. It
 * deliberately excludes the cursor itself so every page of one request shares
 * a stable request identity. */
export function requestHashOf(
  snapshotId: string,
  tool: string,
  normalizedArgs: LlmJsonValue,
): `sha256:${string}` {
  return llmSha256({ snapshotId, tool, args: normalizedArgs });
}

/** The result hash binds THIS page's payload to the snapshot and request. A
 * different snapshot (or different payload) yields a different hash. */
export function resultHashOf(input: {
  snapshotId: string;
  tool: string;
  schemaVersion: string;
  requestHash: string;
  payload: LlmJsonValue;
}): `sha256:${string}` {
  return llmSha256({
    snapshotId: input.snapshotId,
    tool: input.tool,
    schemaVersion: input.schemaVersion,
    requestHash: input.requestHash,
    payload: input.payload,
  });
}
