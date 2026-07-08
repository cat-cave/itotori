import type { ReactNode } from "react";
import { cx } from "../../cx.js";

export interface ComparisonPaneProps {
  /** Left/source content (source-first, always). */
  source: ReactNode;
  /** Right/draft content. */
  draft: ReactNode;
  sourceLabel?: ReactNode;
  draftLabel?: ReactNode;
  /** Trailing slot on the draft header (e.g. a status Badge). */
  draftMeta?: ReactNode;
  /** Machine token identifying the compared unit (mono). */
  unit?: ReactNode;
  className?: string;
}

/**
 * ComparisonPane — the source ↔ draft side-by-side. Source is always first
 * (source-first is a design-language rule); the two panes read as one unit with
 * a divider gutter between them. The core surface of the review loop.
 */
export function ComparisonPane({
  source,
  draft,
  sourceLabel = "source",
  draftLabel = "draft",
  draftMeta,
  unit,
  className,
}: ComparisonPaneProps): ReactNode {
  return (
    <div className={cx("itotori-compare", className)}>
      {unit && <code className="itotori-compare__unit">{unit}</code>}
      <div className="itotori-compare__grid">
        <div className="itotori-compare__side itotori-compare__side--source">
          <div className="itotori-compare__label">{sourceLabel}</div>
          <div className="itotori-compare__body">{source}</div>
        </div>
        <div className="itotori-compare__side itotori-compare__side--draft">
          <div className="itotori-compare__label">
            {draftLabel}
            {draftMeta && <span className="itotori-compare__meta">{draftMeta}</span>}
          </div>
          <div className="itotori-compare__body">{draft}</div>
        </div>
      </div>
    </div>
  );
}
