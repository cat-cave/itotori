import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface BiTextProps {
  /** Source text (source-first). */
  source: string;
  /** Translated text. */
  translation: string;
  /** Locale identity tokens (rendered as mono code). */
  sourceLocale?: string;
  targetLocale?: string;
  /** Optional speaker/nameplate. */
  speaker?: ReactNode;
  /**
   * Copy handler. Defaults to the async clipboard; callers may inject one (e.g.
   * to record a copy event). Returning a promise is fine.
   */
  onCopy?: (text: string) => void | Promise<void>;
  className?: string;
}

/**
 * BiText — bilingual source ↔ translation with a copy control. Source-first,
 * comfortable reading measure, locale identity shown as machine tokens. The
 * reading surface stays comfortable even inside the dense instrument.
 */
export function BiText({
  source,
  translation,
  sourceLocale,
  targetLocale,
  speaker,
  onCopy,
  className,
}: BiTextProps): ReactNode {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      if (onCopy) {
        await onCopy(translation);
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(translation);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Copy is best-effort; never throw into the reading surface.
    }
  }, [onCopy, translation]);

  return (
    <div className={cx("itotori-bitext", className)}>
      {speaker && <div className="itotori-bitext__speaker">{speaker}</div>}
      <div className="itotori-bitext__pair">
        <div className="itotori-bitext__line itotori-bitext__line--source">
          {sourceLocale && <code className="itotori-bitext__locale">{sourceLocale}</code>}
          <p className="itotori-bitext__text">{source}</p>
        </div>
        <div className="itotori-bitext__line itotori-bitext__line--target">
          {targetLocale && <code className="itotori-bitext__locale">{targetLocale}</code>}
          <p className="itotori-bitext__text">{translation}</p>
        </div>
      </div>
      <button type="button" className="itotori-bitext__copy" onClick={handleCopy}>
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
