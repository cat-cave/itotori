// Minimal, dependency-free CLI flag parsing shared by the new-pipeline command
// handlers (`localize` / `wiki` / `patch play`). It imports NOTHING — keeping the
// handler modules' transitive import closure clean of the legacy service graph, so
// the composition-reachability proof over those handlers stays green.

/** The value of a required `--flag <value>`; throws a clear error when absent. */
export function requiredFlag(args: readonly string[], name: string): string {
  const value = optionalFlag(args, name);
  if (value === undefined) {
    throw new Error(`flag ${name} is missing its value`);
  }
  return value;
}

/** The value of an optional `--flag <value>`, or `undefined` when the flag or its
 * value is absent. A value that itself looks like a flag (`--x`) is rejected so it
 * cannot be silently mistaken for the value. */
export function optionalFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.length === 0) return undefined;
  if (value.startsWith("--")) {
    throw new Error(`flag ${name} is missing its value`);
  }
  return value;
}

/** Every value of a repeated `--flag <value>` occurrence, in order. */
export function repeatedFlag(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`${name} requires a non-empty value`);
    }
    values.push(value);
  }
  return values;
}

/** Parse a `--flag <json>` value as a JSON object, or `undefined` when absent. */
export function optionalJsonObjectFlag(
  args: readonly string[],
  name: string,
): Record<string, unknown> | undefined {
  const value = optionalFlag(args, name);
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} must be valid JSON object text`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
