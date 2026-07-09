// Shared human annotation vocabulary.
//
// Backend services and UI surfaces both carry this closed ordinal severity
// ramp. It is intentionally product-agnostic: callers provide project, unit,
// and scene identity as input rather than relying on any title-specific data.

export const ANNOTATION_SEVERITIES = ["blocker", "critical", "warning", "note"] as const;
export type AnnotationSeverity = (typeof ANNOTATION_SEVERITIES)[number];

export function isAnnotationSeverity(value: string): value is AnnotationSeverity {
  return (ANNOTATION_SEVERITIES as readonly string[]).includes(value);
}
