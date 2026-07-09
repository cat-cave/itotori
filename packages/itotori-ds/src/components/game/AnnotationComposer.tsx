// AnnotationComposer — in-the-moment note → QA / review finding.
//
// The playtester composes a free-text note, picks a severity from the ordinal
// annotation-severity ramp (`--ito-severity-*`), and optionally a free-form
// category. Submit is owned by the product surface (canFlag gating, API call);
// this component only paints the form and reports the composed value.
//
// Game-agnostic: no title, scene, or unit is hardcoded. Context labels are
// props when the host wants to show "what line you're flagging".

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { cx } from "../../cx.js";

/** Closed ordinal severity scale (design system annotation-severity ramp). */
export const ANNOTATION_SEVERITIES = ["blocker", "critical", "warning", "note"] as const;
export type AnnotationSeverity = (typeof ANNOTATION_SEVERITIES)[number];

export type AnnotationComposerValue = {
  note: string;
  severity: AnnotationSeverity;
  /** Free-form category (tone / layout / glossary / …). Empty when omitted. */
  category: string;
};

export type AnnotationComposerProps = {
  /**
   * Called when the user submits a non-empty note. The host owns the network
   * call + capability gate; this component never hits the API.
   */
  onSubmit: (value: AnnotationComposerValue) => void | Promise<void>;
  /** Initial severity (default `warning` — the hi-fi store default). */
  defaultSeverity?: AnnotationSeverity;
  /** Initial note text. */
  defaultNote?: string;
  /** Initial category. */
  defaultCategory?: string;
  /**
   * When true the form is disabled (capability denied / in-flight submit).
   * The host should also pass `disabledReason` so the control is explained.
   */
  disabled?: boolean;
  /** Explains why the form is disabled (title + aria-description). */
  disabledReason?: string | null;
  /** Optional context line (scene / unit / speaker) shown above the form. */
  contextLabel?: string | null;
  /** Submit button label. */
  submitLabel?: string;
  className?: string;
};

/**
 * AnnotationComposer — note + severity chips + optional category.
 * Severity chips paint from `--ito-severity-*` tokens (ordinal ramp).
 */
export function AnnotationComposer({
  onSubmit,
  defaultSeverity = "warning",
  defaultNote = "",
  defaultCategory = "",
  disabled = false,
  disabledReason = null,
  contextLabel = null,
  submitLabel = "Send to review",
  className,
}: AnnotationComposerProps): ReactNode {
  const baseId = useId();
  const noteId = `${baseId}-note`;
  const categoryId = `${baseId}-category`;
  const [note, setNote] = useState(defaultNote);
  const [severity, setSeverity] = useState<AnnotationSeverity>(defaultSeverity);
  const [category, setCategory] = useState(defaultCategory);
  const [pending, setPending] = useState(false);

  const trimmed = note.trim();
  const canSubmit = !disabled && !pending && trimmed.length > 0;
  const explanation = disabled ? (disabledReason ?? "Annotation composer is disabled") : undefined;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setPending(true);
    try {
      await onSubmit({
        note: trimmed,
        severity,
        category: category.trim(),
      });
      // Clear the note on successful submit so the playtester can flag again.
      setNote("");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className={cx("itotori-annotation-composer", className)}
      data-component="annotation-composer"
      data-severity={severity}
      data-disabled={disabled ? "true" : "false"}
      data-pending={pending ? "true" : "false"}
      aria-disabled={disabled || undefined}
      title={explanation}
      aria-description={explanation}
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      {contextLabel !== null && contextLabel.length > 0 && (
        <p className="itotori-annotation-composer__context" data-role="context">
          {contextLabel}
        </p>
      )}

      <fieldset
        className="itotori-annotation-composer__severity"
        disabled={disabled || pending}
        data-role="severity"
      >
        <legend className="itotori-annotation-composer__legend">Severity</legend>
        <div
          className="itotori-annotation-composer__severity-chips"
          role="radiogroup"
          aria-label="Severity"
        >
          {ANNOTATION_SEVERITIES.map((level) => {
            const selected = severity === level;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={selected}
                data-severity={level}
                data-selected={selected ? "true" : "false"}
                className={cx(
                  "itotori-annotation-composer__severity-chip",
                  selected && "itotori-annotation-composer__severity-chip--selected",
                )}
                disabled={disabled || pending}
                onClick={() => {
                  setSeverity(level);
                }}
              >
                {level}
              </button>
            );
          })}
        </div>
      </fieldset>

      <label className="itotori-annotation-composer__field" htmlFor={noteId}>
        <span className="itotori-annotation-composer__legend">Note</span>
        <textarea
          id={noteId}
          className="itotori-annotation-composer__note"
          name="note"
          rows={3}
          value={note}
          disabled={disabled || pending}
          placeholder="What's wrong with this line?"
          data-role="note"
          required
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </label>

      <label className="itotori-annotation-composer__field" htmlFor={categoryId}>
        <span className="itotori-annotation-composer__legend">Category</span>
        <input
          id={categoryId}
          className="itotori-annotation-composer__category"
          name="category"
          type="text"
          value={category}
          disabled={disabled || pending}
          placeholder="tone · layout · glossary · …"
          data-role="category"
          onChange={(event) => {
            setCategory(event.target.value);
          }}
        />
      </label>

      <button
        type="submit"
        className="itotori-annotation-composer__submit"
        data-action="flag-submit"
        disabled={!canSubmit}
        aria-disabled={!canSubmit}
        title={explanation}
      >
        {pending ? "Sending…" : submitLabel}
      </button>
    </form>
  );
}
