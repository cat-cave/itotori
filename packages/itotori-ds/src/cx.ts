// Minimal className joiner. Components are styled by the shipped CSS bundle
// (`@itotori/ds/styles.css`) via `itotori-*` classes, NOT by CSS-in-JS or CSS
// modules — this keeps the library consumable, tsc clean, and the visual source
// of truth in one place. Downstream nodes follow the same className-based
// pattern; `cx` is the only styling helper they need.
export type ClassValue = string | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
