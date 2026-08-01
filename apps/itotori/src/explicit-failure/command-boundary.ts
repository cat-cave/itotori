import { MalformedOwnedInputError } from "@itotori/db";

/** Decode an owned command input without ever reflecting malformed bytes. */
export function parseOwnedJsonInput(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    throw new MalformedOwnedInputError();
  }
}
